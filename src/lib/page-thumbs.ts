// page-thumbs.ts — the overview's page grids and their thumbnails, as 1.3's page has them
// (app/js/overview.js, "Page-grid thumbnails", "Warm-up" and "Thumbnail workers", and syncPageGrid),
// moved, not rewritten: 1.3's constants and rules, kept outside React, with a start and a stop (one
// engine a page shown, its state its own). The page hands it an element React leaves alone, and the
// engine makes that element's tiles itself (syncPageGrid), as 1.3 did: a long gallery has thousands.
//
// The overview can show every page as a grid tile (a standalone gallery inline, a series' chapters
// under an accordion). Tiles are listed from cheap page keys — no image blobs held — and each one
// only loads when it nears the viewport: the full page is read by url and a small WebP copy is made
// from it in a worker (thumb-worker.js). Making it on this thread was the slow part: a canvas encode
// here waits for idle time, which a loading or scrolling page rarely has — about a second a page.
// A copy is 1.5× the tile's on-screen pixels (browser zoom and pinch-zoom included), so it stays
// sharp when zoomed a little and is remade larger when zoomed further. Nothing is written anywhere:
// the copies live in a memory LRU bounded by count and bytes. As in the reader strip, mounting and
// unloading use different distance bands: a tile stays painted well after leaving the load band, so
// reversing direction cannot expose an unload/reload cycle. The LRU is trimmed only from unmounted
// tiles, which keeps memory bounded without ever blanking something on screen.
//
// stop(): the observers let go, the workers ended (a copy under way is dropped), every timer and
// listener gone, and every copy's object URL revoked: nothing of it outlives the page.
//
// Its world is handed in (the page passes the app's), so its rules can be held in Node with stand-ins
// (app/tests/page-thumbs.test.mjs) as well as in a browser.

export const PAGE_THUMB_SCALE  = 1.5;   // a copy's width ÷ its tile's on-screen pixel width
export const PAGE_THUMB_STEP   = 32;    // widths round up to this step, so one copy serves nearby sizes
export const PAGE_THUMB_MAX_W  = 768;
export const PAGE_THUMB_FORMAT = { format: 'image/webp', quality: 0.82 };
export const thumbWorkers = (cores: number | undefined) => Math.max(1, Math.min(4, Math.floor((cores || 4) / 4)));
export const PAGE_CACHE_MAX    = 4000;                // as the reader's thumbnails: a long gallery's set is a few tens of MB
export const PAGE_CACHE_BYTES  = 64 * 1024 * 1024;
export const PAGE_MOUNT_MARGIN  = 900;
export const PAGE_UNMOUNT_MARGIN = 5400;
export const PAGE_ZOOM_MS = 250;
export const PAGE_WARM_MS = 150;

// The width a tile's copy should have: its on-screen pixels × PAGE_THUMB_SCALE, stepped.
export function thumbWidth(tileW: number, devicePixelRatio = 1, viewportScale = 1) {
  const scale = (devicePixelRatio || 1) * (viewportScale || 1);
  return Math.min(PAGE_THUMB_MAX_W, Math.ceil((tileW || 120) * scale * PAGE_THUMB_SCALE / PAGE_THUMB_STEP) * PAGE_THUMB_STEP);
}

type Made = { src: string; width: number; bytes: number };
type PageRecord = { blob?: Blob; dataUrl?: string } | null;
type Img = HTMLImageElement;

export type PageThumbDeps = {
  pages: {
    list: (gid: string) => Promise<{ pageNum: number; url: string }[]>;
    get: (gid: string, n: number, key: string) => Promise<PageRecord>;
  };
  imageToBlob: (src: unknown) => Promise<Blob | null>;
  resizeToWidth: (blob: Blob, width: number, format: typeof PAGE_THUMB_FORMAT) => Promise<Blob>;
  // A worker of thumb-worker.js (module).
  worker: () => Worker;
  // A page's reader address, and the empty grid's words.
  readerHref: (gid: string, pageNum: number) => string;
  noPages: () => string;
  window?: Window & typeof globalThis;
};

export function createPageThumbs(deps: PageThumbDeps) {
  const win = deps.window ?? window;
  const doc = win.document;
  const THUMB_WORKERS     = thumbWorkers(win.navigator?.hardwareConcurrency);
  const PAGE_GEN_MAX      = THUMB_WORKERS * 2;   // in flight — each holds one decoded page for a moment
  const PAGE_WARM_MAX     = THUMB_WORKERS;       // of those, the warm-up's at most: the rest stay free for the view

  const _pageThumbCache = new Map<string, Made>();   // page url → { src: blob: URL, width, bytes } (Map order = LRU order)
  let   _pageCacheBytes = 0;
  const _pageThumbImg   = new Map<string, Img>();    // page url → current <img>
  const _pageGenQueue: Img[] = [];                   // <img> awaiting a copy
  const _pageThumbNear   = new Set<Img>();           // tiles inside the load band
  let   _pageGenActive   = 0;
  let   _pageWarmActive  = 0;                        // warm-up copies under way (counted in _pageGenActive too)
  let   _pageTileList: Img[] | null = null;          // every tile's <img> in grid order, built again after the grids change
  let   stopped = false;

  const _pageMountObserver = new win.IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        _pageThumbNear.add(e.target as Img);
        _enqueuePageThumb(e.target as Img);
      } else {
        _pageThumbNear.delete(e.target as Img);
      }
    }
  }, { rootMargin: `${PAGE_MOUNT_MARGIN}px 0px` });

  const _pageUnmountObserver = new win.IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) continue;
      const img = e.target as Img;
      img.removeAttribute('src');
      delete img.dataset.ready;
      delete img.dataset.width;
      _trimPageCache();
    }
  }, { rootMargin: `${PAGE_UNMOUNT_MARGIN}px 0px` });

  // The width a tile's copy should have now: its on-screen pixels × PAGE_THUMB_SCALE, stepped.
  function _pageThumbWidth(img: Img) {
    return thumbWidth(img.parentElement?.clientWidth || 120, win.devicePixelRatio || 1, win.visualViewport?.scale || 1);
  }

  // Zoomed in (browser zoom, pinch-zoom) or resized past what the loaded copies were made for: remake
  // the load band's copies at the new size. Each tile keeps showing its current copy meanwhile.
  let _pageZoomTimer: ReturnType<typeof setTimeout> | undefined;
  function _onPageScaleChange() {
    clearTimeout(_pageZoomTimer);
    _pageZoomTimer = setTimeout(() => {
      for (const img of _pageThumbNear) {
        if (img.dataset.ready && Number(img.dataset.width) < _pageThumbWidth(img)) {
          delete img.dataset.ready;
          _enqueuePageThumb(img);
        }
      }
    }, PAGE_ZOOM_MS);
  }
  win.addEventListener('resize', _onPageScaleChange);
  win.visualViewport?.addEventListener('resize', _onPageScaleChange);
  // A pixel-ratio change alone (another screen, some zoom paths) fires no resize event.
  let _ratioQuery: MediaQueryList | null = null;
  const _onRatio = () => { _onPageScaleChange(); watchPixelRatio(); };
  function watchPixelRatio() {
    if (stopped) return;
    _ratioQuery = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
    _ratioQuery.addEventListener('change', _onRatio, { once: true });
  }
  watchPixelRatio();

  function _pageCacheGet(url: string) {
    const entry = _pageThumbCache.get(url);
    if (!entry) return null;
    _pageThumbCache.delete(url); _pageThumbCache.set(url, entry);   // touch → most-recent
    return entry;
  }
  // Store a new copy of a page; a larger one already stored wins and the new one is dropped. Returns
  // the entry to show and the one it replaced (for the caller to release once nothing shows it).
  function _pageCacheStore(url: string, made: Made) {
    const existing = _pageThumbCache.get(url);
    if (existing && existing.width >= made.width) {
      try { URL.revokeObjectURL(made.src); } catch {}
      return { entry: _pageCacheGet(url)!, replaced: null };
    }
    if (existing) { _pageThumbCache.delete(url); _pageCacheBytes -= existing.bytes; }
    _pageThumbCache.set(url, made);
    _pageCacheBytes += made.bytes;
    return { entry: made, replaced: existing ?? null };
  }
  function _trimPageCache() {
    while (_pageThumbCache.size > PAGE_CACHE_MAX || _pageCacheBytes > PAGE_CACHE_BYTES) {
      const evictable = [..._pageThumbCache].find(([oldUrl, old]) => {
        const img = _pageThumbImg.get(oldUrl);
        return !img || (!img.dataset.queued && img.getAttribute('src') !== old.src);
      });
      // The live window may briefly exceed the cache target on an unusually dense/tall viewport.
      // Keep those images intact; leaving the wider unload band will make them evictable.
      if (!evictable) break;
      const [oldUrl, old] = evictable;
      _pageThumbCache.delete(oldUrl);
      _pageCacheBytes -= old.bytes;
      try { URL.revokeObjectURL(old.src); } catch {}
    }
  }
  // Stop tracking a subtree's page tiles before it is removed from the DOM (partial row refresh),
  // so the observer and img map don't retain detached nodes.
  function releasePageTiles(root: ParentNode) {
    _pageTileList = null;
    root.querySelectorAll<Img>('.ov-page img[data-page-url]').forEach((img) => {
      _pageMountObserver.unobserve(img);
      _pageUnmountObserver.unobserve(img);
      _pageThumbNear.delete(img);
      if (_pageThumbImg.get(img.dataset.pageUrl!) === img) _pageThumbImg.delete(img.dataset.pageUrl!);
    });
  }

  function _enqueuePageThumb(img: Img) {
    if (stopped || img.dataset.ready || img.dataset.queued) return;
    img.dataset.queued = '1';
    // A copy already made (by the warm-up, or before the tile scrolled away) shows at once, without a
    // turn in the queue behind copies still being made.
    const url = img.dataset.pageUrl!, made = _pageThumbCache.get(url);
    if (made && made.width >= _pageThumbWidth(img)) {
      _pageCacheGet(url);
      _attachPageThumb(img, made, url).then((shown) => {
        delete img.dataset.queued;
        if (shown) return;
        if (_pageThumbCache.get(url) === made) { _pageThumbCache.delete(url); _pageCacheBytes -= made.bytes; }
        try { URL.revokeObjectURL(made.src); } catch {}
        _enqueuePageThumb(img);
      });
      return;
    }
    _pageGenQueue.push(img);
    _drainPageQueue();
  }

  function _pageViewportDistance(img: Img) {
    const rect = img.parentElement?.getBoundingClientRect();
    if (!rect) return Infinity;
    if (rect.bottom < 0) return -rect.bottom;
    if (rect.top > win.innerHeight) return rect.top - win.innerHeight;
    return 0;
  }

  // Intersection callbacks can leave older, off-screen work in the queue after a fast scroll. Pick
  // the tile nearest the viewport each time a worker frees up, matching the reader's load ordering.
  function _takeNearestPageThumb() {
    let best = 0;
    for (let i = 1; i < _pageGenQueue.length; i++) {
      if (_pageViewportDistance(_pageGenQueue[i]) < _pageViewportDistance(_pageGenQueue[best])) best = i;
    }
    return _pageGenQueue.splice(best, 1)[0];
  }

  function _drainPageQueue(warmOn = false) {
    if (stopped) return;
    // Tiles that left the load band while they waited go (they're queued again if they come back): a
    // fast scroll queued hundreds, and picking the nearest measured every one of them each time.
    for (let i = _pageGenQueue.length - 1; i >= 0; i--) {
      const img = _pageGenQueue[i];
      if (img.isConnected && _pageThumbNear.has(img)) continue;
      _pageGenQueue.splice(i, 1);
      delete img.dataset.queued;
    }
    while (_pageGenActive < PAGE_GEN_MAX && _pageGenQueue.length) _processPageQueue();
    if (!_pageGenQueue.length) _schedulePageWarm(warmOn);
  }

  // ── Warm-up ──
  // As in the reader, every tile's copy is made ahead, so scrolling anywhere (or back) finds them made:
  // once no tile near the view is waiting, the next tile without a copy of the size the grid needs,
  // nearest to the view first, gets one, until the cache is full. A tile that comes near meanwhile
  // shows its copy as soon as it's made. Tiles of a collapsed chapter wait until it's opened.
  // It starts a moment after the view's own work, so tiles scrolled to meanwhile go first, and then
  // carries on from one copy to the next.
  let _pageWarmTimer: ReturnType<typeof setTimeout> | 0 = 0;
  function _schedulePageWarm(warmOn: boolean) {
    if (_pageWarmTimer || stopped) return;
    _pageWarmTimer = setTimeout(() => {
      _pageWarmTimer = 0;
      while (!_pageGenQueue.length && _pageWarmActive < PAGE_WARM_MAX && _pageGenActive < PAGE_GEN_MAX
             && _pageThumbCache.size < PAGE_CACHE_MAX && _pageCacheBytes < PAGE_CACHE_BYTES * 0.9) {
        const img = _nextPageToWarm();
        if (!img) return;
        _warmPageThumb(img);
      }
    }, warmOn ? 0 : PAGE_WARM_MS);
  }

  function _nextPageToWarm() {
    const tiles = _pageTileList ||= [...doc.querySelectorAll<Img>('.ov-page img[data-page-url]')];
    if (!tiles.length) return null;
    // From the middle of the tiles near the view, outward.
    const near: number[] = [];
    for (let i = 0; i < tiles.length; i++) if (_pageThumbNear.has(tiles[i])) near.push(i);
    const centre = near.length ? near[near.length >> 1] : 0;
    let width = 0;
    for (let d = 0; d < tiles.length; d++) {
      for (const i of d ? [centre + d, centre - d] : [centre]) {
        const img = tiles[i];
        if (!img || img.dataset.queued || !img.isConnected || !img.parentElement?.offsetWidth) continue;
        width ||= _pageThumbWidth(img);
        if ((_pageThumbCache.get(img.dataset.pageUrl!)?.width || 0) < width) return img;
      }
    }
    return null;
  }

  async function _warmPageThumb(img: Img) {
    img.dataset.queued = '1';
    _pageGenActive++;
    _pageWarmActive++;
    try {
      const url = img.dataset.pageUrl!;
      const made = await _makePageThumb(img, _pageThumbWidth(img));
      if (!made) return;
      if (stopped) { try { URL.revokeObjectURL(made.src); } catch {} return; }
      const { entry, replaced } = _pageCacheStore(url, made);
      if (_pageThumbNear.has(img) && !img.dataset.ready && img.isConnected) await _attachPageThumb(img, entry, url);
      if (replaced && img.getAttribute('src') !== replaced.src) { try { URL.revokeObjectURL(replaced.src); } catch {} }
    } catch {} finally {
      delete img.dataset.queued;
      _pageGenActive--;
      _pageWarmActive--;
      _drainPageQueue(true);
    }
  }

  // Decoded before it's swapped in, so a tile never flashes empty; a tile that left the load band
  // meanwhile just takes the new copy without the wait.
  async function _attachPageThumb(img: Img, entry: Made, url: string) {
    const pre = new win.Image();
    pre.src = entry.src;
    try { await pre.decode(); } catch { return false; }
    if (stopped || !img.isConnected || img.dataset.pageUrl !== url) return true;
    if (!_pageThumbNear.has(img) && !img.getAttribute('src')) return true;
    img.src = entry.src;
    img.dataset.ready = '1';
    img.dataset.width = String(entry.width);
    return true;
  }

  async function _processPageQueue() {
    if (_pageGenActive >= PAGE_GEN_MAX || !_pageGenQueue.length) return;
    _pageGenActive++;
    const img = _takeNearestPageThumb();
    let retry = false;
    try {
      if (!img.isConnected || !_pageThumbNear.has(img)) return;
      const url = img.dataset.pageUrl!;
      const width = _pageThumbWidth(img);
      let entry = _pageCacheGet(url), replaced: Made | null = null;
      if (!entry || entry.width < width) {
        const made = await _makePageThumb(img, width);
        if (!made) return;
        if (stopped) { try { URL.revokeObjectURL(made.src); } catch {} return; }
        ({ entry, replaced } = _pageCacheStore(url, made));
      }
      if (!await _attachPageThumb(img, entry, url)) {
        if (_pageThumbCache.get(url) === entry) { _pageThumbCache.delete(url); _pageCacheBytes -= entry.bytes; }
        try { URL.revokeObjectURL(entry.src); } catch {}
        retry = true;
      }
      if (replaced && img.getAttribute('src') !== replaced.src) { try { URL.revokeObjectURL(replaced.src); } catch {} }
      _trimPageCache();
    } catch {} finally {
      delete img.dataset.queued;
      _pageGenActive--;
      _drainPageQueue();
      if (retry && img.isConnected && _pageThumbNear.has(img)) setTimeout(() => _enqueuePageThumb(img));
    }
  }

  async function _makePageThumb(img: Img, width: number): Promise<Made | null> {
    // Read by the page's key, as the reader does: by number alone walks the gallery's index a key at a
    // time, one round trip each through a busy main thread.
    const rec = await deps.pages.get(img.dataset.gid!, Number(img.dataset.pageNum), img.dataset.pageUrl!).catch(() => null);
    const fullBlob = await deps.imageToBlob(rec?.blob ?? rec?.dataUrl);
    if (!fullBlob || stopped) return null;
    const blob = await _resizeInWorker(fullBlob, width);
    return blob ? { src: URL.createObjectURL(blob), width, bytes: blob.size } : null;
  }

  // ── Thumbnail workers ──
  // Started on first use. A worker that fails hands its pending requests to this thread and leaves
  // the pool; with none left, copies are made here (slower, same result).
  let _thumbWorkers: Worker[] | null = null;
  let _thumbTurn = 0, _thumbSeq = 0;
  const _thumbPending = new Map<number, { resolve: (blob: Blob | Promise<Blob | null> | null) => void; worker: Worker; blob: Blob; width: number }>();

  function _thumbWorker() {
    if (!_thumbWorkers) {
      _thumbWorkers = [];
      try {
        for (let i = 0; i < THUMB_WORKERS; i++) {
          const worker = deps.worker();
          worker.onmessage = ({ data }) => {
            const job = _thumbPending.get(data.id);
            if (!job) return;
            _thumbPending.delete(data.id);
            job.resolve(data.blob || null);
          };
          worker.onerror = () => _dropThumbWorker(worker);
          _thumbWorkers.push(worker);
        }
      } catch {}
    }
    return _thumbWorkers.length ? _thumbWorkers[_thumbTurn++ % _thumbWorkers.length] : null;
  }

  function _dropThumbWorker(worker: Worker) {
    _thumbWorkers = _thumbWorkers!.filter((w) => w !== worker);
    try { worker.terminate(); } catch {}
    for (const [id, job] of _thumbPending) {
      if (job.worker !== worker) continue;
      _thumbPending.delete(id);
      job.resolve(deps.resizeToWidth(job.blob, job.width, PAGE_THUMB_FORMAT).catch(() => null));
    }
  }

  function _resizeInWorker(blob: Blob, width: number): Promise<Blob | null> {
    const worker = _thumbWorker();
    if (!worker) return deps.resizeToWidth(blob, width, PAGE_THUMB_FORMAT).catch(() => null);
    return new Promise((resolve) => {
      const id = ++_thumbSeq;
      _thumbPending.set(id, { resolve, worker, blob, width });
      worker.postMessage({ id, blob, width, ...PAGE_THUMB_FORMAT });
    });
  }

  // One page's tile: a page url and a reader link; the image fills in lazily as it nears the view.
  function pageTile(gid: string, pageNum: number, url: string) {
    const a = doc.createElement('a');
    a.className = 'ov-page';
    a.href = deps.readerHref(gid, pageNum);
    a.draggable = false;
    const img = doc.createElement('img');
    img.alt = ''; img.decoding = 'async'; img.dataset.pageUrl = url;
    img.dataset.gid = gid; img.dataset.pageNum = String(pageNum);
    _pageThumbImg.set(url, img);
    _pageTileList = null;
    const num = doc.createElement('span');
    num.className = 'ov-page-num';
    num.textContent = String(pageNum);
    a.append(img, num);
    _pageMountObserver.observe(img);
    _pageUnmountObserver.observe(img);
    return a;
  }

  // Fill a container with one tile per cached page of a gallery, or bring it up to date: the tiles
  // it has stay as they are (thumbnails and all), new pages get tiles, and gone ones are dropped.
  const _gridSeq = new WeakMap<Element, number>();
  async function syncPageGrid(container: HTMLElement | null, gid: string) {
    if (!container || stopped) return;
    const seq = (_gridSeq.get(container) || 0) + 1;
    _gridSeq.set(container, seq);
    const keys = await deps.pages.list(gid);
    if (stopped || seq !== _gridSeq.get(container) || !container.isConnected) return;
    const keyOf = (pageNum: string | number, url: string) => `${pageNum}\n${url}`;
    const old = new Map([...container.querySelectorAll<HTMLElement>(':scope > .ov-page')].map((a) => {
      const img = a.querySelector('img')!;
      return [keyOf(img.dataset.pageNum!, img.dataset.pageUrl!), a];
    }));
    if (!keys.length) {
      if (!old.size && container.firstElementChild) return;
      releasePageTiles(container);
      const empty = doc.createElement('div');
      empty.className = 'ov-pages-empty';
      empty.textContent = deps.noPages();
      container.replaceChildren(empty);
      return;
    }
    container.querySelector(':scope > .ov-pages-empty')?.remove();
    const tiles = keys.map(({ pageNum, url }) => {
      const key = keyOf(pageNum, url);
      const tile = old.get(key);
      if (!tile) return pageTile(gid, pageNum, url);
      old.delete(key);
      return tile;
    });
    for (const tile of old.values()) { releasePageTiles(tile); tile.remove(); }
    tiles.forEach((tile, i) => { if (container.children[i] !== tile) container.insertBefore(tile, container.children[i] || null); });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    _pageMountObserver.disconnect();
    _pageUnmountObserver.disconnect();
    clearTimeout(_pageZoomTimer);
    if (_pageWarmTimer) clearTimeout(_pageWarmTimer);
    _pageWarmTimer = 0;
    win.removeEventListener('resize', _onPageScaleChange);
    win.visualViewport?.removeEventListener('resize', _onPageScaleChange);
    _ratioQuery?.removeEventListener('change', _onRatio);
    for (const worker of _thumbWorkers ?? []) { try { worker.terminate(); } catch {} }
    _thumbWorkers = [];
    for (const job of _thumbPending.values()) job.resolve(null);
    _thumbPending.clear();
    for (const img of _pageGenQueue) delete img.dataset.queued;
    _pageGenQueue.length = 0;
    _pageThumbNear.clear();
    _pageThumbImg.clear();
    _pageTileList = null;
    for (const made of _pageThumbCache.values()) { try { URL.revokeObjectURL(made.src); } catch {} }
    _pageThumbCache.clear();
    _pageCacheBytes = 0;
  }

  return {
    syncPageGrid,
    releasePageTiles,
    stop,
    // What it holds now (for tests and probes): copies kept, their bytes, tiles near the view, copies
    // under way, the workers started.
    stats: () => ({ cached: _pageThumbCache.size, bytes: _pageCacheBytes, near: _pageThumbNear.size, active: _pageGenActive, queued: _pageGenQueue.length, workers: _thumbWorkers?.length ?? 0 }),
  };
}

export type PageThumbs = ReturnType<typeof createPageThumbs>;

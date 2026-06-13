// reader.js — offline gallery reader

import './boot.js';
import { openDB, imageToBlob } from './db.js';
import { request as extRequest, available as extAvailable } from './ext-bridge.js';
import * as platform from './platform.js';
import { t } from './i18n.js';
import { initTooltips } from './tooltip.js';

// Site link templates are runtime knowledge handed over by the extension; the app itself is
// site-agnostic. A gallery's exact sourceUrl (stored with it) always wins.
let _siteMap = {};
(async () => {
  if (await extAvailable()) {
    const r = await extRequest({ type: 'EXT_SITES' });
    if (r && r.sites) _siteMap = r.sites;
  }
})();

const siteName = (source) => (_siteMap[source]?.name) || source || '';

function galleryLink(meta, displayId, page) {
  if (meta?.sourceUrl) return meta.sourceUrl;
  const t = meta?.source && _siteMap[meta.source]?.galleryUrl;
  return t ? t.replace('{id}', displayId).replace('{page}', page) : '';
}

const READER_PIN_SVG   = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17H19V15L17 13V8L18 7V5H6V7L7 8V13L5 15V17Z"/></svg>';
const READER_UNPIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 9v4l-2 2H19"/><path d="M7 7H6V5h8"/></svg>';

const SVG_STRIP  = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2h18"/><rect width="18" height="12" x="3" y="6" rx="2"/><path d="M3 22h18"/></svg>';
const SVG_PAGE   = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3v18"/><rect width="12" height="18" x="6" y="3" rx="2"/><path d="M22 3v18"/></svg>';
const SVG_DOUBLE = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/></svg>';

const params    = new URLSearchParams(location.search);
const galleryId = params.get('g');

let pages       = [];
let currentPage = 1;
let mode        = 'strip'; // 'single' | 'double' | 'strip'
let thumbsOpen    = false;
let scrubVisible  = true;
let translateView = false; // show stored translated variants when true
let lastPageMode  = 'single';
let _stripObservers = [];
let _pageZoom     = 1;     // +/- page scale factor

// Page images are served as blob: URLs. A blob URL references the IndexedDB-backed Blob — the
// bytes stay on disk until an <img> actually needs them, and the browser discards decoded
// bitmaps of off-screen images on its own. So URLs for EVERY page are kept for the whole
// session: nothing is ever evicted, scrolling back never re-fetches, and no base64 ever
// touches the JS heap.
const _pageUrlCache = new Map();   // page.url → blob: URL ('' when the record is missing)
function _revokeAllPageUrls() {
  for (const u of _pageUrlCache.values()) { if (u) URL.revokeObjectURL(u); }
  _pageUrlCache.clear();
}
let _readerDb = null;
let _stripGen  = 0; // bumped on every buildStrip call to cancel stale loads

// Reader reads page images from the shared cache DB through the one canonical opener
// (db.js), so its schema/version stay in lockstep with the service worker — no
// duplicate version constant and no destructive upgrade handler that could wipe data.
function _openReaderDb() {
  return openDB();
}

async function pageBlobUrl(page) {
  if (_pageUrlCache.has(page.url)) return _pageUrlCache.get(page.url);
  if (!_readerDb) return '';
  const record = await new Promise((resolve, reject) => {
    const tx  = _readerDb.transaction('images', 'readonly');
    const req = tx.objectStore('images').get(page.url);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  }).catch(() => null);
  const src = record ? ((translateView && record.translated) ? record.translated : (record.blob ?? record.dataUrl)) : null;
  const blob = await imageToBlob(src);
  const url = blob ? URL.createObjectURL(blob) : '';
  if (_pageUrlCache.has(page.url)) {           // a concurrent load won the race — reuse its URL
    if (url) URL.revokeObjectURL(url);
    return _pageUrlCache.get(page.url);
  }
  _pageUrlCache.set(page.url, url);
  return url;
}

// Pre-create blob URLs (and warm the decode cache) for pages around n, so page flips and
// double-page spreads never show a blank frame.
function _warmNeighbors(n) {
  for (let p = Math.max(1, n - 2); p <= Math.min(pages.length, n + 2); p++) {
    pageBlobUrl(pages[p - 1]).then(u => {
      if (!u) return;
      const img = new Image();
      img.src = u;
      img.decode().catch(() => {});
    });
  }
}

// ── Thumb generation: decode-at-target-size via createImageBitmap, then JPEG-encode small
// blob and return a blob: URL. Subsequent uses are instant; ~10 KB blob per thumb vs ~2 MB
// base64 + 22 MB decoded for full-res. Concurrency-limited so we don't thrash the decoder.
const _thumbBlobCache = new Map();   // page.url → blob: URL (small jpeg)
const _thumbGenQueue  = [];          // { page, resolve }
let   _thumbGenActive = 0;
const THUMB_GEN_MAX   = 4;           // parallel decoders — kept low so thumb generation never
                                     // starves the strip's own page loads of IDB/decoder time

function _generateThumbBlob(page) {
  return new Promise((resolve) => {
    _thumbGenQueue.push({ page, resolve });
    _processThumbQueue();
  });
}

async function _processThumbQueue() {
  if (_thumbGenActive >= THUMB_GEN_MAX) return;
  if (_thumbGenQueue.length === 0) return;
  _thumbGenActive++;
  const { page, resolve } = _thumbGenQueue.shift();
  try {
    if (_thumbBlobCache.has(page.url)) { resolve(_thumbBlobCache.get(page.url)); return; }
    if (!_readerDb) { resolve(''); return; }
    const record = await new Promise((res) => {
      const tx  = _readerDb.transaction('images', 'readonly');
      const req = tx.objectStore('images').get(page.url);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => res(null);
    });
    const src = record?.blob ?? record?.dataUrl;
    if (!src) { resolve(''); return; }
    const fullBlob = await imageToBlob(src);
    if (!fullBlob) { resolve(''); return; }
    // Target the max display width: strip at 50% viewport height, thumb aspect 52:74.
    const thumbW = Math.round((window.innerHeight * 0.5 - 14) * 52 / 74);
    // Decode at 2× target so the first canvas step is always a clean 2× reduction.
    // Then halve repeatedly until at target — each step is bilinear over a 2× range,
    // which avoids the aliasing that single-pass Lanczos produces on large→small ratios.
    const bitmap = await createImageBitmap(fullBlob, { resizeWidth: thumbW * 2, resizeQuality: 'high' });
    let w = bitmap.width, h = bitmap.height;
    let canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    while (w > thumbW) {
      w = Math.max(thumbW, Math.ceil(w / 2));
      h = Math.ceil(h / 2);
      const step = document.createElement('canvas');
      step.width = w; step.height = h;
      step.getContext('2d').drawImage(canvas, 0, 0, w, h);
      canvas = step;
    }
    const smallBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
    if (!smallBlob) { resolve(''); return; }
    const blobUrl = URL.createObjectURL(smallBlob);
    _thumbBlobCache.set(page.url, blobUrl);
    resolve(blobUrl);
  } catch {
    resolve('');
  } finally {
    _thumbGenActive--;
    _processThumbQueue();
  }
}


// ── Elements ──
const loadingScreen = document.getElementById('loadingScreen');
const loadingText   = document.getElementById('loadingText');
const emptyScreen   = document.getElementById('emptyScreen');
const topbar        = document.getElementById('topbar');
const bottombar     = document.getElementById('bottombar');
const viewport      = document.getElementById('viewport');
const singleView    = document.getElementById('singleView');
const doubleView    = document.getElementById('doubleView');
const stripView     = document.getElementById('stripView');
const thumbStrip    = document.getElementById('thumbStrip');
const mainImg       = document.getElementById('mainImg');
const imgLeft       = document.getElementById('imgLeft');
const imgRight      = document.getElementById('imgRight');
const scrubber      = document.getElementById('scrubber');
const scrubWrap     = document.getElementById('scrubWrap');
const scrubToggle   = document.getElementById('scrubToggle');
const scrubberLabel = document.getElementById('scrubberLabel');
const pageCounter   = document.getElementById('pageCounter');
const btnLayoutToggle  = document.getElementById('btnLayoutToggle');
const btnPageSubToggle = document.getElementById('btnPageSubToggle');
const thumbBtn      = document.getElementById('thumbBtn');
const translateToggle = document.getElementById('translateToggle');
const keybindBtn    = document.getElementById('keybindBtn');
const keybindModal  = document.getElementById('keybindModal');
const readerPinBtn  = document.getElementById('readerPinBtn');
const tbGallery     = document.getElementById('tbGallery');
const onlineBtn     = document.getElementById('onlineBtn');
const clickPrev     = document.getElementById('clickPrev');
const clickNext     = document.getElementById('clickNext');
const dClickPrev    = document.getElementById('dClickPrev');
const dClickNext    = document.getElementById('dClickNext');
const scrollTopBtn  = document.getElementById('scrollTopBtn');

// ── Init ──
async function init() {
  if (!galleryId) { showEmpty(); return; }

  tbGallery.textContent = `#${galleryId}`;
  onlineBtn.style.display = 'none';
  document.title        = `Shiori — #${galleryId}`;

  loadingText.textContent = t('rd.opening_db');
  try { _readerDb = await _openReaderDb(); }
  catch (e) { showEmpty(); return; }

  loadingText.textContent = t('rd.loading_pages');
  const gid = String(galleryId);

  // Page list (key-only cursor, no image bytes) and metadata, fetched in parallel.
  const metaPromise = new Promise((resolve) => {
    const tx  = _readerDb.transaction('metadata', 'readonly');
    const req = tx.objectStore('metadata').get(gid);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  }).catch(() => null);

  const rawUrls = await new Promise((resolve, reject) => {
    const urls = [];
    const tx  = _readerDb.transaction('images', 'readonly');
    const req = tx.objectStore('images').index('galleryId').openKeyCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { urls.push(cursor.primaryKey); cursor.continue(); } else resolve(urls);
    };
    req.onerror = () => reject(req.error);
  }).catch(() => []);

  if (rawUrls.length === 0) { showEmpty(); return; }

  pages = rawUrls
    .map(url => {
      const m = url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      return { pageNum: m ? parseInt(m[1]) : 9999, url };
    })
    .sort((a, b) => a.pageNum - b.pageNum);

  loadingScreen.style.display = 'none';

  const meta = await metaPromise;

  const displayId = meta?.sourceId || galleryId;
  tbGallery.textContent = `#${displayId}`;
  tbGallery.classList.toggle('local', !!meta?.isLocalImport);
  document.title        = `Shiori — #${displayId}`;

  const visitUrl = galleryLink(meta, displayId, 1);
  const sName    = siteName(meta?.source);

  if (visitUrl) {
    onlineBtn.href    = visitUrl;
    onlineBtn.dataset.tip = t('rd.open_on', { site: sName });
    onlineBtn.innerHTML = `<img src="https://www.google.com/s2/favicons?domain=${meta.source}&sz=16" style="width:14px;height:14px;vertical-align:middle;pointer-events:none;" onerror="this.outerHTML='↗'">`;
    onlineBtn.style.display = '';
    tbGallery.href   = visitUrl;
    tbGallery.target = '_blank';
    const emptyLink = document.getElementById('emptyLink');
    emptyLink.href        = visitUrl;
    emptyLink.textContent = t('rd.open_on_arrow', { site: sName });
    emptyLink.style.display = '';
  } else {
    document.getElementById('emptyLink').style.display = 'none';
  }

  if (meta && (meta.titlePretty || meta.titleEnglish)) {
    const titleEl = document.getElementById('tbTitle');
    if (titleEl) {
      titleEl.textContent = meta.titlePretty || meta.titleEnglish;
      if (visitUrl) { titleEl.href = visitUrl; titleEl.target = '_blank'; }
    }
  }

  if (pages.length === 0) { showEmpty(); return; }

  // Reveal the translation toggle (and default it on) when this gallery has translated pages.
  if (meta?.translated) {
    translateView = true;
    translateToggle.style.display = '';
    translateToggle.classList.add('active');
    translateToggle.dataset.tip = t('rd.tip_translate_on');
  }

  scrubber.max   = pages.length;
  scrubber.value = 1;

  buildThumbs();
  const saved = await platform.kv.get(['readerMode', 'readerLastPageMode', 'readerThumbsOpen', 'readerThumbHeight', 'readerPageZoom']);
  applyThumbHeight(saved.readerThumbHeight || _thumbHeight);
  if (saved.readerPageZoom) { _pageZoom = saved.readerPageZoom; document.documentElement.style.setProperty('--page-zoom', _pageZoom); }
  if (saved.readerLastPageMode) lastPageMode = saved.readerLastPageMode;
  setMode(saved.readerMode || 'strip', true);
  goTo(1);
  // Defer restoring thumbnail-open state — its eager IDB reads otherwise fight the strip's
  // own loader for IDB bandwidth, delaying the first visible page by several seconds.
  if (saved.readerThumbsOpen) setTimeout(() => setThumbsOpen(true), 1500);
  // Pre-generate the remaining thumbs in the background once the first pages are on screen,
  // so opening the strip later is instant. No-op for thumbs already generated.
  setTimeout(_enqueueAllThumbs, 3500);
}

function showEmpty() {
  loadingScreen.style.display = 'none';
  emptyScreen.classList.add('show');
}

// ── Navigation ──
async function goTo(n) {
  if (!pages.length) return;
  n = Math.max(1, Math.min(pages.length, n));
  currentPage = n;

  // Update navigation UI immediately; image loads asynchronously below
  scrubber.value = n;
  updateCounter();
  highlightThumb(n - 1);
  scrollThumbIntoView(n - 1);

  if (mode === 'single') {
    window.scrollTo(0, 0);
    const url = await pageBlobUrl(pages[n - 1]);
    if (currentPage !== n) return;
    mainImg.src = url;
    _warmNeighbors(n);
  } else if (mode === 'double') {
    window.scrollTo(0, 0);
    const lPage = pages[n - 1];
    const rPage = n < pages.length ? pages[n] : null;
    imgRight.style.display = rPage ? 'block' : 'none';
    const [lUrl, rUrl] = await Promise.all([
      pageBlobUrl(lPage),
      rPage ? pageBlobUrl(rPage) : Promise.resolve('')
    ]);
    if (currentPage !== n) return;
    imgLeft.src  = lUrl;
    imgRight.src = rUrl;
    _warmNeighbors(n);
  }
  // strip: images loaded in buildStrip(); scroll handled separately
}

function updateCounter() {
  const label = `${currentPage} / ${pages.length}`;
  pageCounter.textContent   = label;
  scrubberLabel.textContent = label;
}

function highlightThumb(idx) {
  document.querySelectorAll('.thumb-item').forEach((t, i) => t.classList.toggle('active', i === idx));
}

function scrollThumbIntoView(idx) {
  const t = thumbStrip.children[idx];
  if (t) t.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

// ── Thumbnails ──
// Build DOM upfront, observe each thumb. Only thumbs that intersect the strip's visible area
// (or its preload margin) get a src — keeps decoded bitmaps bounded to what's actually shown.
// When the strip is closed (height: 0), all imgs evict naturally because root has zero area.
const thumbResizeHandle = document.getElementById('thumbResizeHandle');
let _thumbHeight   = 88;
let _thumbViewport = null;  // overlay showing current viewport range in the reader

function buildThumbs() {
  thumbStrip.innerHTML = '';

  // Viewport indicator first — stays as first child, sized & positioned via JS.
  _thumbViewport = document.createElement('div');
  _thumbViewport.id = 'thumbViewport';
  thumbStrip.appendChild(_thumbViewport);
  _attachIndicatorListener();

  pages.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'thumb-item' + (i === 0 ? ' active' : '');
    div.dataset.idx = i;
    const img = document.createElement('img');
    img.dataset.idx = i;
    div.appendChild(img);
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = i + 1;
    div.appendChild(num);
    thumbStrip.appendChild(div);
  });

  // Generation is NOT started here: decoding every page up front fought the strip's own
  // loader for IDB/decoder bandwidth and delayed the first visible page by seconds. Thumbs
  // are enqueued when the strip opens (visible-first) or by init's idle timer, whichever
  // comes first.
}

function _enqueueAllThumbs() {
  const imgs = thumbStrip.querySelectorAll('.thumb-item img');
  imgs.forEach((img) => {
    if (img.dataset.queued) return;   // already queued by a previous call
    const idx = parseInt(img.dataset.idx);
    const page = pages[idx];
    if (!page) return;
    img.dataset.queued = '1';
    if (_thumbBlobCache.has(page.url)) {
      if (!img.getAttribute('src')) img.src = _thumbBlobCache.get(page.url);
      return;
    }
    _generateThumbBlob(page).then(url => {
      if (url && !img.getAttribute('src')) img.src = url;
    });
  });
}

// Move currently-visible thumbs to the front of the generation queue.
function _prioritizeVisibleThumbs() {
  const stripRect = thumbStrip.getBoundingClientRect();
  const imgs = thumbStrip.querySelectorAll('.thumb-item img');
  const visible = [];
  imgs.forEach((img) => {
    if (img.getAttribute('src')) return;
    const r = img.getBoundingClientRect();
    if (r.right >= stripRect.left && r.left <= stripRect.right) visible.push(img);
  });
  if (!visible.length) return;
  const visibleUrls = new Set(visible.map(img => pages[parseInt(img.dataset.idx)]?.url));
  const prioritized = _thumbGenQueue.filter(e => visibleUrls.has(e.page.url));
  const rest        = _thumbGenQueue.filter(e => !visibleUrls.has(e.page.url));
  _thumbGenQueue.length = 0;
  _thumbGenQueue.push(...prioritized, ...rest);
}

// When the strip auto-scrolls during reader scroll (so the active thumb's highlight stays
// visible), keep it gentle — only scroll if active thumb has actually left the visible area.
function _ensureActiveThumbVisible() {
  if (!thumbsOpen) return;
  const active = thumbStrip.querySelector('.thumb-item.active');
  if (!active) return;
  const stripRect = thumbStrip.getBoundingClientRect();
  const tRect = active.getBoundingClientRect();
  if (tRect.right < stripRect.left + 10 || tRect.left > stripRect.right - 10) {
    active.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
  }
}

function setThumbsOpen(open) {
  thumbsOpen = open;
  thumbStrip.classList.toggle('open', open);
  thumbBtn.classList.toggle('active', open);
  thumbResizeHandle.classList.toggle('show', open);
  document.body.classList.toggle('thumbs-open', open);   // lets the scroll-top button ride above it
  platform.kv.set({ readerThumbsOpen: open });
  if (open) {
    _enqueueAllThumbs();
    _prioritizeVisibleThumbs();
    if (mode === 'strip') {
      setTimeout(() => _setIndicator(_scrollYToProportion(window.scrollY)), 50);
    } else {
      setTimeout(_ensureActiveThumbVisible, 250);
    }
  }
}

function applyThumbHeight(h) {
  const dpr = window.devicePixelRatio || 1;
  const minH = Math.round(window.innerHeight * 0.15 * dpr);
  const maxH = Math.round(window.innerHeight * 0.50 * dpr);
  _thumbHeight = Math.max(minH, Math.min(maxH, Math.round(h)));

  // Preserve the proportional scroll position of the strip's CENTER content X. Since thumbs
  // scale uniformly with strip height, this keeps the same point in the gallery centered.
  // Window scroll position is NOT touched (main scrollbar stays put).
  let centerFraction = null;
  if (thumbsOpen && thumbStrip.scrollWidth > 0) {
    const centerContentX = thumbStrip.scrollLeft + thumbStrip.clientWidth / 2;
    centerFraction = centerContentX / thumbStrip.scrollWidth;
  }

  document.documentElement.style.setProperty('--thumb-h', _thumbHeight + 'px');

  if (centerFraction !== null) {
    const newCenterContent = centerFraction * thumbStrip.scrollWidth;
    const maxScroll = Math.max(0, thumbStrip.scrollWidth - thumbStrip.clientWidth);
    thumbStrip.scrollLeft = Math.max(0, Math.min(maxScroll, newCenterContent - thumbStrip.clientWidth / 2));
  }
}

// ── Thumb strip ↔ page scroll sync ──────────────────────────────────────────
//
// Single source of geometry: _stripAnchors() reads the two endpoints once per call.
// proportion (0–1) is the shared currency between page scroll and strip position.
//
// Interaction model:
//   drag  → _dragToCursor  → positions indicator + scrolls page instantly
//   click → _clickSnapToThumb → scrolls page smoothly; strip locked until indicator
//            crosses the center reference via natural scrolling (not click animation)
//   scroll → _onPageScroll → _setIndicator → positions indicator + pans strip

function _stripAnchors() {
  const rect = thumbStrip.getBoundingClientRect();
  const z    = rect.width / (thumbStrip.offsetWidth || rect.width);
  const iW   = _thumbViewport ? _thumbViewport.offsetWidth * z : 0; // indicator visual width
  const thumbs = thumbStrip.querySelectorAll('.thumb-item');
  const a = thumbs.length > 1 ? thumbs[0].offsetLeft : 0;
  const b = thumbs.length > 1 ? thumbs[thumbs.length - 1].offsetLeft
          : thumbs.length === 1 ? thumbs[0].offsetLeft
          : Math.max(0, thumbStrip.scrollWidth - thumbStrip.offsetWidth);
  return { z, iW, a, b };
}

function _proportionToContentLeft(p, a, b) {
  return a + p * (b - a);
}

// Map scrollY → proportion via page index, not linear interpolation.
// Finds which page top is at/above scrollY, then interpolates within that page gap.
// This keeps strip ↔ scroll in sync even when page heights vary.
function _scrollYToProportion(scrollY) {
  const imgs = stripView ? Array.from(stripView.querySelectorAll('.page-img')) : [];
  const n = imgs.length;
  if (n < 2) return Math.max(0, Math.min(1, scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)));
  // Binary search: find last img whose offsetTop <= scrollY
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (imgs[mid].offsetTop <= scrollY) lo = mid; else hi = mid - 1;
  }
  const i = lo;
  if (i >= n - 1) return 1;
  const pageT = imgs[i].offsetTop, nextT = imgs[i + 1].offsetTop;
  const withinPage = Math.max(0, Math.min(1, (scrollY - pageT) / Math.max(1, nextT - pageT)));
  return (i + withinPage) / (n - 1);
}

// Map proportion → scrollY via page index.
// Proportion p = i/(n-1) lands at imgs[i].offsetTop; fractional part interpolates between pages.
function _proportionToScrollY(p) {
  const imgs = stripView ? Array.from(stripView.querySelectorAll('.page-img')) : [];
  const n = imgs.length;
  if (n < 2) return Math.round(p * Math.max(1, document.documentElement.scrollHeight - window.innerHeight));
  const scaled = Math.max(0, Math.min(n - 1, p * (n - 1)));
  const i = Math.min(n - 2, Math.floor(scaled));
  const frac = scaled - i;
  return Math.round(imgs[i].offsetTop + frac * (imgs[i + 1].offsetTop - imgs[i].offsetTop));
}

// State for strip interaction
let _dragGrabOffset    = null;
let _thumbDragging     = false;  // true while dragging — suppresses scroll→strip sync
let _lockCenter        = null;   // strip visibleCenter (px) locked at click time; null = unlocked
let _lockDir           = 0;      // ±1: which side the indicator must cross to unlock
let _scrollSettled     = true;   // false during a smooth-scroll animation
let _settleTimer       = null;
let _lastIndicatorCenter = null; // previous indicatorCenter for delta-pan while locked

// Position the indicator at proportion p and pan the strip to keep it centered.
// When _lockCenter is set, pan by the indicator's delta instead of snapping to center,
// until the indicator naturally crosses _lockCenter (then resume center-tracking).
function _setIndicator(p) {
  const { z, iW, a, b } = _stripAnchors();
  const contentLeft     = _proportionToContentLeft(p, a, b);
  const indicatorCenter = contentLeft + iW / (2 * z);
  if (_thumbViewport) _thumbViewport.style.left = contentLeft + 'px';

  const maxScrollX = Math.max(0, thumbStrip.scrollWidth - thumbStrip.offsetWidth);

  if (_lockCenter !== null) {
    const crossed = _lockDir > 0 ? indicatorCenter >= _lockCenter
                                 : indicatorCenter <= _lockCenter;
    if (_scrollSettled && crossed) {
      _lockCenter = null;
      _lastIndicatorCenter = null;
    } else {
      // Pan by indicator delta only during natural scrolling, not the click animation
      if (_scrollSettled && _lastIndicatorCenter !== null) {
        const delta = indicatorCenter - _lastIndicatorCenter;
        thumbStrip.scrollLeft = Math.max(0, Math.min(maxScrollX, thumbStrip.scrollLeft + delta));
      }
      _lastIndicatorCenter = indicatorCenter;
      return;
    }
  }

  _lastIndicatorCenter = indicatorCenter;
  thumbStrip.scrollLeft = Math.max(0, Math.min(maxScrollX,
    contentLeft - thumbStrip.offsetWidth / 2 + iW / (2 * z)));
}

// Drag handler: maps cursor position to proportion, moves indicator + scrolls page.
function _dragToCursor(clientX) {
  const { z, iW, a, b } = _stripAnchors();
  const rect        = thumbStrip.getBoundingClientRect();
  const visualRange = Math.max(1, rect.width - iW);

  if (_dragGrabOffset === null) _dragGrabOffset = iW / 2;
  const visualLeft  = Math.max(0, Math.min(visualRange, clientX - rect.left - _dragGrabOffset));
  const p           = visualLeft / visualRange;
  const contentLeft = _proportionToContentLeft(p, a, b);

  if (_thumbViewport) _thumbViewport.style.left = contentLeft + 'px';
  // Strip pans so indicator stays under cursor
  const maxScrollX = Math.max(0, thumbStrip.scrollWidth - thumbStrip.offsetWidth);
  thumbStrip.scrollLeft = Math.max(0, Math.min(maxScrollX, contentLeft - visualLeft / z));

  if (mode === 'strip') {
    window.scrollTo({ top: _proportionToScrollY(p), behavior: 'instant' });
  } else {
    const idx = Math.min(pages.length - 1, Math.round(p * (pages.length - 1)));
    if (idx + 1 !== currentPage) goTo(idx + 1);
  }
}

// Click handler: navigate to the clicked thumb's page; lock strip until natural scroll
// brings the indicator back through the center reference point.
function _clickSnapToThumb(clientX) {
  const { z, iW, a, b } = _stripAnchors();
  const rect     = thumbStrip.getBoundingClientRect();
  const contentX = (clientX - rect.left) / z + thumbStrip.scrollLeft;
  const thumbs   = thumbStrip.querySelectorAll('.thumb-item');
  let idx = thumbs.length - 1;
  for (let i = 0; i < thumbs.length; i++) {
    if (contentX < thumbs[i].offsetLeft + thumbs[i].offsetWidth) { idx = i; break; }
  }

  if (mode === 'strip') {
    const stripImg = stripView.querySelector(`[data-page="${idx + 1}"]`);
    if (!stripImg) return;
    const targetY   = stripImg.getBoundingClientRect().top + window.scrollY;
    const destP     = _scrollYToProportion(targetY);
    const destCenter = _proportionToContentLeft(destP, a, b) + iW / (2 * z);
    _lockCenter          = thumbStrip.scrollLeft + thumbStrip.offsetWidth / 2;
    _lockDir             = destCenter < _lockCenter ? -1 : 1;
    _scrollSettled       = false;
    _lastIndicatorCenter = null;
    window.scrollTo({ top: targetY, behavior: 'smooth' });
  } else if (idx + 1 !== currentPage) {
    goTo(idx + 1);
  }
}

// Drag-vs-click distinction: pointerdown alone doesn't scroll — wait for either movement
// (drag, continuous scroll) or pointerup-without-movement (click, snap to thumb page).
// Momentum / inertia for swipe-pan mode.
let _swipeRaf = null;
function _launchSwipeMomentum(velocity) {
  cancelAnimationFrame(_swipeRaf);
  const FRICTION = 0.984; // velocity multiplied each frame — matches ~1000px coast from 16px/frame
  const MIN_V    = 0.3;   // px/frame below which we stop (~0.02 px/ms at 60fps)
  function step() {
    if (Math.abs(velocity) < MIN_V) return;
    const maxScrollX = Math.max(0, thumbStrip.scrollWidth - thumbStrip.offsetWidth);
    thumbStrip.scrollLeft = Math.max(0, Math.min(maxScrollX, thumbStrip.scrollLeft + velocity));
    velocity *= FRICTION;
    _swipeRaf = requestAnimationFrame(step);
  }
  _swipeRaf = requestAnimationFrame(step);
}

function _startThumbInteraction(initialEvent) {
  const pointerId  = initialEvent.pointerId;
  const startX     = initialEvent.clientX;
  const isScrubber = initialEvent.shiftKey; // shift = scrubber mode; plain = swipe mode
  let dragging     = false;

  // Swipe-pan state
  let lastX = startX, lastT = performance.now(), velocity = 0;

  function maybeStartDrag(ev) {
    if (dragging) return;
    if (Math.abs(ev.clientX - startX) < 4) return;
    dragging = true;
    cancelAnimationFrame(_swipeRaf);
    if (isScrubber) {
      _thumbDragging = true;
    }
    document.body.classList.add('thumb-dragging');
    thumbStrip.classList.add('dragging');
  }
  function move(ev) {
    if (ev.pointerId !== pointerId) return;
    maybeStartDrag(ev);
    if (!dragging) return;
    if (isScrubber) {
      _dragToCursor(ev.clientX);
    } else {
      // Swipe-pan: drag strip scrollLeft directly
      const dx  = lastX - ev.clientX;
      const dt  = Math.max(1, performance.now() - lastT);
      velocity  = dx / dt * 16; // px per frame at 60fps
      const maxScrollX = Math.max(0, thumbStrip.scrollWidth - thumbStrip.offsetWidth);
      thumbStrip.scrollLeft = Math.max(0, Math.min(maxScrollX, thumbStrip.scrollLeft + dx));
      lastX = ev.clientX;
      lastT = performance.now();
    }
  }
  function up(ev) {
    if (ev.pointerId !== pointerId) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    _dragGrabOffset = null;
    if (dragging) {
      if (isScrubber) {
        _thumbDragging = false;
      } else {
        _launchSwipeMomentum(velocity);
      }
      document.body.classList.remove('thumb-dragging');
      thumbStrip.classList.remove('dragging');
    } else {
      // No movement → treat as click. Snap to the clicked thumb's page.
      _clickSnapToThumb(ev.clientX);
      if (mode !== 'strip') setThumbsOpen(false);
    }
  }
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

thumbStrip.addEventListener('scroll', _prioritizeVisibleThumbs, { passive: true });

// Container listener — clicks/drags that don't start on the indicator itself.
thumbStrip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  _startThumbInteraction(e);
});

// Indicator listener — separated so we can stopPropagation and not double-handle.
function _attachIndicatorListener() {
  if (!_thumbViewport || _thumbViewport.dataset.wired) return;
  _thumbViewport.dataset.wired = '1';
  _thumbViewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    _startThumbInteraction(e);
  });
}

// Resize handle: drag the strip's top edge up/down to change its height.
thumbResizeHandle.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  thumbResizeHandle.setPointerCapture(e.pointerId);
  thumbResizeHandle.classList.add('active');
  thumbStrip.classList.add('resizing');
  const startY = e.clientY;
  const startH = _thumbHeight;

  function move(ev) {
    // Strip is anchored at bottom; dragging UP (decreasing Y) increases height.
    // clientY is in visual px; _thumbHeight is in internal (pre-zoom) px — scale by DPR.
    applyThumbHeight(startH + (startY - ev.clientY) * (window.devicePixelRatio || 1));
  }
  function up(ev) {
    thumbResizeHandle.releasePointerCapture(ev.pointerId);
    thumbResizeHandle.classList.remove('active');
    thumbStrip.classList.remove('resizing');
    thumbResizeHandle.removeEventListener('pointermove', move);
    thumbResizeHandle.removeEventListener('pointerup', up);
    platform.kv.set({ readerThumbHeight: _thumbHeight });
  }
  thumbResizeHandle.addEventListener('pointermove', move);
  thumbResizeHandle.addEventListener('pointerup', up);
});

function setKeybindOpen(open) {
  keybindModal.classList.toggle('show', open);
  keybindBtn.classList.toggle('active', open);
}

// ── Header pin ──
let readerPinned = localStorage.getItem('shiori-reader-pin') === '1'; // default: unpinned
let _resetTopbarFloat = () => {};   // assigned by the float IIFE below

function applyScrollLayout() {
  document.documentElement.classList.add('reader-scroll');
  document.body.classList.add('reader-scroll');
  document.body.classList.toggle('reader-unpinned', !readerPinned);
}

function applyReaderPin(p) {
  readerPinned = p;
  readerPinBtn.innerHTML = p ? READER_PIN_SVG : READER_UNPIN_SVG;
  readerPinBtn.dataset.tip = p ? t('rd.tip_unpin') : t('rd.tip_pin');
  localStorage.setItem('shiori-reader-pin', p ? '1' : '0');
  // When pinned, offset programmatic scrolls (page nav, scrubber, Home/End) by the header height
  // so a navigated page lands just below the sticky header instead of behind it.
  document.documentElement.style.scrollPaddingTop = p ? 'var(--topbar-h)' : '';
  applyScrollLayout();
  // Pinning while the topbar was floated would otherwise leave its inline position:fixed +
  // spacer in place (the scroll handler stops running once pinned, so floatOut never fires),
  // which drops the sticky header out of flow and lets the pages slide under it. Reset it.
  if (p) _resetTopbarFloat();
}
applyReaderPin(readerPinned);

// ── Float topbar back in on scroll-up (unpinned only) ──
(function () {
  const topbar = document.getElementById('topbar');
  let floating = false;
  let placeholder = null;
  let lastY = window.scrollY;

  function floatIn() {
    if (!floating) {
      floating = true;
      placeholder = document.createElement('div');
      placeholder.style.height = topbar.offsetHeight + 'px';
      placeholder.style.flexShrink = '0';
      topbar.before(placeholder);
      topbar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:200;transform:translateY(-100%)';
      topbar.offsetHeight; // reflow so transition fires
    }
    topbar.style.transition = 'transform 0.18s ease';
    topbar.style.transform  = 'translateY(0)';
  }

  function floatOut() {
    floating = false;
    topbar.style.cssText = '';
    if (placeholder) { placeholder.remove(); placeholder = null; }
  }
  _resetTopbarFloat = floatOut;   // let applyReaderPin clear a leftover floated header when pinning

  window.addEventListener('scroll', () => {
    if (readerPinned) return;
    const y     = window.scrollY;
    const delta = y - lastY;
    if (Math.abs(delta) < 2) return;
    lastY = y;

    if (y <= 0) {
      floatOut();
    } else if (delta < 0) {
      floatIn();
    } else if (floating) {
      topbar.style.transition = 'transform 0.18s ease';
      topbar.style.transform  = 'translateY(-100%)';
    }
  }, { passive: true });
}());


// ── Strip view ──
// Every page <img> gets a blob: URL — nearest-to-viewport first, then everything else — and
// keeps it for the whole session. Slots lock their aspect ratio the moment dimensions are
// known, so the scrollbar is stable; nothing is ever evicted (the browser discards off-screen
// decoded bitmaps on its own), so scrolling back never pops. A decode-ahead window keeps
// upcoming pages painted before they enter the viewport, however fast the user scrolls.
function buildStrip() {
  _stripObservers.forEach(o => o.disconnect());
  _stripObservers = [];
  stripView.innerHTML = '';
  const gen = ++_stripGen;

  // Build empty imgs upfront so DOM order is fixed before any async work.
  pages.forEach((p, i) => {
    const img = document.createElement('img');
    img.className    = 'page-img';
    img.dataset.page = i + 1;
    img.decoding     = 'async';
    img.addEventListener('load', () => {
      if (img.naturalWidth > 1 && img.naturalHeight > 1) {
        img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      }
    });
    stripView.appendChild(img);
  });
  const imgs = [...stripView.querySelectorAll('.page-img')];

  // Loader: a small worker pool; each worker takes the unloaded page nearest the current one,
  // so the visible region is always served first and re-prioritizes as the user scrolls.
  const unloaded = new Set(pages.map((_, i) => i));
  const DECODE_AHEAD = 8;
  const CONCURRENCY = 4;
  let active = 0;

  async function loadOne(idx) {
    const url = await pageBlobUrl(pages[idx]);
    if (_stripGen !== gen || !url) return;
    const img = imgs[idx];
    img.src = url;
    if (Math.abs(idx + 1 - currentPage) <= DECODE_AHEAD) {
      try { await img.decode(); } catch {}
    }
  }

  function next() {
    if (_stripGen !== gen) return;
    while (active < CONCURRENCY && unloaded.size) {
      let best = -1, bestDist = Infinity;
      for (const idx of unloaded) {
        const dist = Math.abs(idx + 1 - currentPage);
        if (dist < bestDist) { bestDist = dist; best = idx; }
      }
      if (best < 0) return;
      unloaded.delete(best);
      active++;
      loadOne(best).finally(() => { active--; next(); });
    }
  }

  next();

  // Keep the pages around the viewport decoded — the browser may have discarded far-away
  // bitmaps; decode() is a no-op when they're still resident.
  function decodeAround(center) {
    for (let i = Math.max(0, center - 1 - DECODE_AHEAD); i <= Math.min(imgs.length - 1, center - 1 + DECODE_AHEAD); i++) {
      if (imgs[i].src) imgs[i].decode().catch(() => {});
    }
  }

  // Page tracker observer: drives the currentPage UI when the viewport moves. Threshold 0 —
  // manga pages are often taller than the viewport, so a percent threshold could never fire.
  const pageObs = new IntersectionObserver(() => {
    let topPage = null, topY = Infinity;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight) {
        // Prefer the page whose top is at or above viewport top — that's the one being read.
        const score = r.top <= 0 ? -r.top : r.top + 10000;
        if (score < topY) { topY = score; topPage = parseInt(img.dataset.page); }
      }
    }
    if (topPage !== null && topPage !== currentPage) {
      currentPage    = topPage;
      scrubber.value = topPage;
      updateCounter();
      highlightThumb(topPage - 1);
      decodeAround(topPage);
    }
  }, { threshold: 0 });

  imgs.forEach(img => pageObs.observe(img));
  _stripObservers.push(pageObs);
}

// ── Mode switching ──
function setMode(m, skipAnim) {
  if (m !== 'strip' && _stripObservers.length) {
    _stripObservers.forEach(o => o.disconnect());
    _stripObservers = [];
  }
  if (m !== 'strip') scrollTopBtn.classList.remove('visible');

  mode = m;
  applyScrollLayout();

  // Show/hide views
  singleView.classList.toggle('active', m === 'single');
  doubleView.classList.toggle('active', m === 'double');
  stripView.classList.toggle('active',  m === 'strip');

  // Bottom bar: show in single/double, hide in strip
  const showBar = m !== 'strip';
  bottombar.classList.toggle('hidden', !showBar);
  document.body.classList.toggle('bar-hidden', !showBar);

  // Update layout toggle + single/double sub-toggle
  const isPage = m !== 'strip';
  if (isPage) lastPageMode = m;
  platform.kv.set({ readerMode: m, readerLastPageMode: lastPageMode });
  btnLayoutToggle.innerHTML = isPage ? SVG_PAGE : SVG_STRIP;
  btnLayoutToggle.classList.add('active');
  btnPageSubToggle.style.display = isPage ? '' : 'none';
  btnPageSubToggle.innerHTML = m === 'double' ? SVG_DOUBLE : SVG_PAGE;
  btnPageSubToggle.classList.toggle('active', m === 'double');

  if (m === 'strip') {
    buildStrip();
    // Scroll to current page
    if (!skipAnim) {
      setTimeout(() => {
        if (currentPage === 1) { window.scrollTo(0, 0); return; }
        const t = stripView.querySelector(`[data-page="${currentPage}"]`);
        if (t) t.scrollIntoView();
      }, 50);
    }
  } else {
    goTo(currentPage);
  }
}

// ── Scrubber toggle ──
function setScrubVisible(v) {
  scrubVisible = v;
  scrubWrap.classList.toggle('hidden', !v);
  scrubToggle.classList.toggle('active', !v);
}

// ── Events ──
// Single click zones
clickPrev.addEventListener('click', () => goTo(currentPage - 1));
clickNext.addEventListener('click', () => goTo(currentPage + 1));

// Double click zones
dClickPrev.addEventListener('click', () => goTo(currentPage - 2));
dClickNext.addEventListener('click', () => goTo(currentPage + 2));

// Scrubber
scrubber.addEventListener('input', () => {
  const n = parseInt(scrubber.value);
  if (mode === 'strip') {
    const t = stripView.querySelector(`[data-page="${n}"]`);
    if (t) t.scrollIntoView({ behavior: 'smooth' });
    currentPage = n;
    updateCounter();
    highlightThumb(n - 1);
  } else {
    goTo(n);
  }
});

// Scrubber toggle
scrubToggle.addEventListener('click', () => setScrubVisible(!scrubVisible));

// Mode buttons
btnLayoutToggle.addEventListener('click', () => setMode(mode === 'strip' ? lastPageMode : 'strip'));
btnPageSubToggle.addEventListener('click', () => setMode(mode === 'double' ? 'single' : 'double'));

// Scroll-to-top button
scrollTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
window.addEventListener('scroll', () => {
  scrollTopBtn.classList.toggle('visible', mode === 'strip' && window.scrollY > 400);
  if (mode === 'strip' && thumbsOpen && !_thumbDragging) {
    _setIndicator(_scrollYToProportion(window.scrollY));
  }
  // Debounce _scrollSettled: marks smooth-scroll as done 150ms after last scroll event.
  clearTimeout(_settleTimer);
  _settleTimer = setTimeout(() => { _scrollSettled = true; }, 150);
}, { passive: true });

// Thumbs
thumbBtn.addEventListener('click', () => setThumbsOpen(!thumbsOpen));

// Clicking anywhere in the page viewport closes an open thumbnail strip. Capture phase +
// stopPropagation so that first click only dismisses the strip and doesn't also page-flip.
viewport.addEventListener('click', (e) => {
  if (!thumbsOpen) return;
  e.stopPropagation();
  setThumbsOpen(false);
}, true);

// Translation view toggle — swaps between stored translated variants and originals.
translateToggle.addEventListener('click', () => {
  translateView = !translateView;
  translateToggle.classList.toggle('active', translateView);
  translateToggle.dataset.tip = translateView ? t('rd.tip_translate_on') : t('rd.tip_translate');
  _revokeAllPageUrls(); // cached blob URLs are keyed by url only, not by variant
  if (mode === 'strip') buildStrip();
  else goTo(currentPage);
});

// Keybind modal
keybindBtn.addEventListener('click', () => setKeybindOpen(!keybindModal.classList.contains('show')));
keybindModal.addEventListener('click', (e) => {
  if (!e.target.closest('#keybindBox')) setKeybindOpen(false);
});

readerPinBtn.addEventListener('click', () => applyReaderPin(!readerPinned));

// ── Page zoom (+/-) ──
const ZOOM_MIN = 0.4, ZOOM_MAX = 3, ZOOM_STEP = 0.1;
function setPageZoom(z) {
  _pageZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z * 100) / 100));
  document.documentElement.style.setProperty('--page-zoom', _pageZoom);
  platform.kv.set({ readerPageZoom: _pageZoom });
}

// ── Continuous W/S scroll (no key-repeat delay) ──
// A rAF loop drives the scroll the moment a key goes down, so there's none of the OS
// auto-repeat pause before the second step. Held keys are tracked so releasing one key
// while the other is still down keeps scrolling in the remaining direction.
const SCROLL_SPEED = 22; // px per frame (~1320px/s at 60fps)
const _scrollHeld = new Set();
let _scrollRaf = null;
function _scrollLoop() {
  let dir = 0;
  if (_scrollHeld.has('down')) dir += 1;
  if (_scrollHeld.has('up'))   dir -= 1;
  if (dir === 0) { _scrollRaf = null; return; }
  window.scrollBy(0, dir * SCROLL_SPEED);
  _scrollRaf = requestAnimationFrame(_scrollLoop);
}
function _pressScroll(dir) {
  if (_scrollHeld.has(dir)) return;
  _scrollHeld.add(dir);
  if (!_scrollRaf) _scrollRaf = requestAnimationFrame(_scrollLoop);
}
function _releaseScroll(dir) { _scrollHeld.delete(dir); }
function _stopScroll() { _scrollHeld.clear(); }

document.addEventListener('keyup', (e) => {
  if (e.key === 'w' || e.key === 'W') _releaseScroll('up');
  if (e.key === 's' || e.key === 'S') _releaseScroll('down');
});
window.addEventListener('blur', _stopScroll);
document.addEventListener('visibilitychange', () => { if (document.hidden) _stopScroll(); });

// Keyboard
document.addEventListener('keydown', (e) => {
  if (e.target === scrubber) return;

  // W / S → continuous scroll (Shift jumps to the ends, like Home/End).
  if (e.key === 'w' || e.key === 'W') {
    e.preventDefault();
    if (e.shiftKey) { _stopScroll(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else _pressScroll('up');
    return;
  }
  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    if (e.shiftKey) { _stopScroll(); window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }
    else _pressScroll('down');
    return;
  }

  // +/- zoom the in-view pages.
  if (e.key === '+' || e.key === '=') { e.preventDefault(); setPageZoom(_pageZoom + ZOOM_STEP); return; }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); setPageZoom(_pageZoom - ZOOM_STEP); return; }
  if (e.key === '0' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setPageZoom(1); return; }

  if (e.key === 'Escape' && keybindModal.classList.contains('show')) {
    setKeybindOpen(false);
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    setKeybindOpen(!keybindModal.classList.contains('show'));
    return;
  }

  const step = mode === 'double' ? 2 : 1;
  const fwd  = e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'd' || e.key === 'D';
  const bck  = e.key === 'ArrowLeft'  || e.key === 'ArrowUp'   || e.key === 'a' || e.key === 'A';

  if (mode === 'strip') {
    if (fwd || bck) {
      e.preventDefault();
      if (e.shiftKey) {
        if (fwd) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        else     window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        const next = Math.max(1, Math.min(pages.length, currentPage + (fwd ? 1 : -1)));
        const t = stripView.querySelector(`[data-page="${next}"]`);
        if (t) t.scrollIntoView({ behavior: 'smooth' });
      }
    }
    if (e.key === 'Home') { e.preventDefault(); window.scrollTo(0, 0); }
    if (e.key === 'End')  { e.preventDefault(); window.scrollTo(0, document.body.scrollHeight); }
  } else {
    if (fwd) { e.preventDefault(); e.shiftKey ? goTo(pages.length) : goTo(currentPage + step); }
    if (bck) { e.preventDefault(); e.shiftKey ? goTo(1) : goTo(currentPage - step); }
    if (e.key === 'Home') goTo(1);
    if (e.key === 'End')  goTo(pages.length);
  }
  if (e.key === 't' || e.key === 'T') setThumbsOpen(!thumbsOpen);
  if (e.key === '1') setMode('single');
  if (e.key === '2') setMode('double');
  if (e.key === '3') setMode('strip');
});

initTooltips();

// Keep the thumbnail strip, resize handle, and bottom bar at a fixed physical size
// regardless of browser zoom. window.devicePixelRatio encodes the zoom level (on a
// 1× display it equals the browser zoom exactly; on HiDPI it includes the DPR too,
// but zooming still changes it proportionally). We counter-scale via the CSS zoom
// property so the elements shrink back to their intended CSS-pixel dimensions.
let _lastDPR = window.devicePixelRatio;
function _applyZoomCompensation() {
  document.documentElement.style.setProperty('--zoom-inv', 1 / window.devicePixelRatio);
}
_applyZoomCompensation();
window.addEventListener('resize', () => {
  if (window.devicePixelRatio !== _lastDPR) {
    _lastDPR = window.devicePixelRatio;
    _applyZoomCompensation();
  }
});

init();

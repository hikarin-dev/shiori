// reader.js — offline gallery reader

import './boot.js';
import { openDB, imageToBlob } from './db.js';
import { resolveSeries } from './series.js';
import { request as extRequest, send as extSend, available as extAvailable } from './ext-bridge.js';
import * as platform from './platform.js';
import { t, getLang } from './i18n.js';
import { formatCount } from './format.js';
import { pickTitle } from './titles.js';
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

const params    = new URLSearchParams(location.search);
const galleryId = params.get('g');
const initialPageParam = params.get('page') || params.get('p') || '';

let pages       = [];      // every page slot, all chapters concatenated in series order
let _chapters   = [];      // chapters with known slots: { id, num, title, start, count, missing, meta }
let _seriesTotal = 1;      // total chapters in the series (incl. uncached ones) — the "of N" in labels
let _curChIdx   = -1;      // chapter the current page belongs to — drives the topbar/URL chrome
let _chapterDividersOn = true;   // Settings → Reader: chapter transitions (strip divider + page-mode transition page)
let _stripSeriesFlow   = true;   // Settings → Reader: strip runs the whole series (true) or one chapter (false)
const _pageIdxByUrl = new Map(); // page url → 0-based merged index (for URL-cache eviction distance)
let currentPage = 1;
let mode        = 'strip'; // 'single' | 'double' | 'strip'
let thumbsOpen    = false;
let translateView = false; // show stored translated variants when true
let lastPageMode  = 'single';
let _pageZoom     = 1;     // +/- page scale factor
let readerFitMode = 'off'; // 'off' | 'width' | 'height' for persistent page-mode fit classes
let readerFitMaxWidth = 1; // persistent fit cap, 0.1..1, adjusted by zoom keys while fit is active
let readerDirection = 'ltr';
let readerPageGap = 4;
let readerProgressPosition = 'bottom';
// Cached pages may learn their own true aspect ratio as they decode. Missing-page slots share one
// baseline measured before the first render, so changing reader modes cannot change their geometry.
const _pageRatios = new Map();   // page index (0-based) → "w / h"
const A4_PLACEHOLDER_RATIO = '210 / 297';
const A4_PLACEHOLDER_WIDTH_RATIO = 210 / 297;
let _placeholderRatio = A4_PLACEHOLDER_RATIO;
let _placeholderWidthRatio = A4_PLACEHOLDER_WIDTH_RATIO;

// Study mode: keep the clean original on screen with per-bubble overlays. Each page stores two
// full-page layers — bg (inpainted, text removed) and text (translated glyphs on transparent) —
// plus per-bubble boxes (the OCR detection regions, as page fractions). Two independent display
// settings (Settings → Reader): the ORIGINAL shows as the untouched page (click a bubble to
// reveal its translation) or as always-on selectable DOM text over the inpainted bg (optional
// furigana; a click cycles original ⇄ translation); the TRANSLATION shows as the exact typeset
// image layers (clipped bg below, glyph PNG above, so overlapping bubbles never occlude each
// other) or as selectable DOM text. While on, the displayed variant is forced to the clean
// original regardless of translateView.
let studyMode      = false;
let hasStudy       = false;            // any page has study layers → the study segment is enabled
let studyDisplay   = 'hardcoded_images'; // translation display: 'hardcoded_images' | 'text' (Settings → Reader)
let studyOriginal  = 'image';            // original display: 'image' (untouched page) | 'text' (DOM text)
let studySrcFont   = 'yasashisa';        // original text face: 'yasashisa' | 'kiwi' (Settings → Reader)
let furiganaOn     = false;              // Settings → Reader; applies only to Japanese-tagged galleries
let _translateAvailable = false;       // this gallery has a whole-page translation
const _pageStudy     = new Map();      // page url → { bg:Blob|null, bubbles:[{box,region,tr,src,rbox?,style?,furi?,text?:Blob}], page:{w,h}|null }
const _pageLayerUrls = new Map();      // page url → { bgUrl, textUrls:[] } object URLs, revoked on teardown

// Page images are served as blob: URLs. A blob URL references the IndexedDB-backed Blob — the
// bytes stay on disk until an <img> actually needs them, and the browser discards decoded
// bitmaps of off-screen images on its own. Nearby URLs stay warm while the virtualized strip
// revokes far-away ones, keeping very long series bounded without putting base64 on the JS heap.
// Keys include the variant (original vs translated), so an in-range view switch can swap in place.
const _pageUrlCache = new Map();   // variantKey → blob: URL ('' when the record is missing)
const _showTranslated = () => translateView && !studyMode;   // study mode forces the clean original
const _variantKey = (page) => page?.url ? (_showTranslated() ? 't:' : 'o:') + page.url : '';
let _readerDb = null;
let _stripGen  = 0; // bumped on every buildStrip call to cancel stale loads

// Reader reads page images from the shared cache DB through the one canonical opener
// (db.js), so its schema/version stay in lockstep with the service worker — no
// duplicate version constant and no destructive upgrade handler that could wipe data.
function _openReaderDb() {
  return openDB();
}

// Load every page's stored study layers into _pageStudy (keyed by page url) and note whether
// any exist (→ show the study button). One cursor pass per chapter's image records; the
// bg/text layers stay Blobs, turned into object URLs lazily when a bubble is first revealed.
async function _loadStudy() {
  if (!_readerDb) return;
  for (const ch of _chapters) {
    await new Promise((resolve) => {
      const tx  = _readerDb.transaction('images', 'readonly');
      const req = tx.objectStore('images').index('galleryId').openCursor(IDBKeyRange.only(String(ch.id)));
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(); return; }
        const v = cursor.value;
        if (Array.isArray(v.bubbles) && v.bubbles.length) {
          // bg is null for metadata-only (text-mode) study records — those render as DOM text.
          _pageStudy.set(v.url, { bg: v.studyBg || null, bubbles: v.bubbles, page: v.studyPage || null });
        }
        cursor.continue();
      };
      req.onerror = () => resolve();
    });
  }
  hasStudy = _pageStudy.size > 0;
}

async function pageBlobUrl(page) {
  if (!page?.cached || !page.url) return '';
  const key = _variantKey(page);
  if (_pageUrlCache.has(key)) return _pageUrlCache.get(key);
  if (!_readerDb) return '';
  const record = await new Promise((resolve, reject) => {
    const tx  = _readerDb.transaction('images', 'readonly');
    const req = tx.objectStore('images').get(page.url);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  }).catch(() => null);
  const src = record ? ((_showTranslated() && record.translated) ? record.translated : (record.blob ?? record.dataUrl)) : null;
  const blob = await imageToBlob(src);
  const url = blob ? URL.createObjectURL(blob) : '';
  if (_pageUrlCache.has(key)) {                // a concurrent load won the race — reuse its URL
    if (url) URL.revokeObjectURL(url);
    return _pageUrlCache.get(key);
  }
  _pageUrlCache.set(key, url);
  return url;
}

// Read intrinsic dimensions without creating a blob URL. Decodes are deliberately capped because
// createImageBitmap may materialize a full-size frame even though only its dimensions are needed.
const PLACEHOLDER_DIM_CONCURRENCY = 2;

async function _cachedPageHeightRatio(page) {
  let bitmap = null;
  try {
    const record = await new Promise((resolve) => {
      const tx  = _readerDb.transaction('images', 'readonly');
      const req = tx.objectStore('images').get(page.url);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => resolve(null);
    });
    const blob = await imageToBlob(record?.blob ?? record?.dataUrl);
    if (!blob) return 0;
    bitmap = await createImageBitmap(blob);
    return bitmap.width > 0 && bitmap.height > 0 ? bitmap.height / bitmap.width : 0;
  } catch {
    return 0;
  } finally {
    bitmap?.close();
  }
}

async function _measurePlaceholderRatio() {
  if (!pages.some(page => !page?.cached)) return;
  const cachedPages = pages.filter(page => page?.cached && page.url);
  if (!cachedPages.length) return;

  const heights = [];
  let next = 0;
  async function worker() {
    while (next < cachedPages.length) {
      const page = cachedPages[next++];
      const height = await _cachedPageHeightRatio(page);
      if (height > 0) heights.push(height);
    }
  }
  const workerCount = Math.min(PLACEHOLDER_DIM_CONCURRENCY, cachedPages.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // One landscape page is not representative of the missing portrait slots; keep the A4 fallback.
  if (cachedPages.length === 1 && heights[0] < 1) return;
  const medianHeight = _median(heights);
  if (medianHeight > 0) {
    _placeholderRatio = `1 / ${medianHeight}`;
    _placeholderWidthRatio = 1 / medianHeight;
  }
}

// Swap an <img> to the current-variant blob, decoding it first so the picture never blanks during
// a translation-view toggle. The element keeps its measured size, so nothing shifts.
async function _swapImg(imgEl, page) {
  if (!imgEl || !page) return;
  const url = await pageBlobUrl(page);
  if (!url) return;
  try { const pre = new Image(); pre.src = url; await pre.decode(); } catch {}
  imgEl.src = url;
}

function _setPlaceholderGeometry(img, wrap = img.parentElement) {
  img.style.aspectRatio = _placeholderRatio;
  img.style.setProperty('--page-ratio', _placeholderWidthRatio);
  if (wrap?.classList.contains('page-wrap')) {
    wrap.style.setProperty('--page-ratio', _placeholderWidthRatio);
  }
}

function _showPageImage(img, url) {
  const placeholder = !url;
  img.classList.toggle('page-placeholder', placeholder);
  if (placeholder) {
    img.removeAttribute('src');
    _setPlaceholderGeometry(img);
  } else {
    img.src = url;
  }
  return placeholder;
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
const THUMB_CACHE_MAX = 512;         // long series retain a bounded LRU of encoded thumbnails

function _cachedThumb(pageUrl) {
  const url = _thumbBlobCache.get(pageUrl);
  if (!url) return '';
  _thumbBlobCache.delete(pageUrl);
  _thumbBlobCache.set(pageUrl, url);  // Map insertion order is the LRU order
  return url;
}

function _cacheThumb(pageUrl, blobUrl) {
  _thumbBlobCache.delete(pageUrl);
  _thumbBlobCache.set(pageUrl, blobUrl);
  while (_thumbBlobCache.size > THUMB_CACHE_MAX) {
    const [oldPageUrl, oldBlobUrl] = _thumbBlobCache.entries().next().value;
    _thumbBlobCache.delete(oldPageUrl);
    const idx = _pageIdxByUrl.get(oldPageUrl);
    const img = idx == null ? null : thumbStrip.querySelector(`.thumb-item img[data-idx="${idx}"]`);
    if (img && img.getAttribute('src') === oldBlobUrl) {
      img.removeAttribute('src');
      delete img.dataset.queued;
    }
    try { URL.revokeObjectURL(oldBlobUrl); } catch {}
  }
}

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
    const cached = _cachedThumb(page.url);
    if (cached) { resolve(cached); return; }
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
    _cacheThumb(page.url, blobUrl);
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
const topbarReveal  = document.getElementById('topbarReveal');
const topbar        = document.getElementById('topbar');
const bottombar     = document.getElementById('bottombar');
const viewport      = document.getElementById('viewport');
const singleView    = document.getElementById('singleView');
const singleInner   = document.getElementById('singleInner');
const doubleView    = document.getElementById('doubleView');
const doubleInner   = document.getElementById('doubleInner');
const stripView     = document.getElementById('stripView');
const thumbStrip    = document.getElementById('thumbStrip');
const mainImg       = document.getElementById('mainImg');
const imgLeft       = document.getElementById('imgLeft');
const imgRight      = document.getElementById('imgRight');
// Real pages may refine their own geometry, but never the missing-page baseline.
function _setPageRatioVars(img) {
  if (!img || img.naturalWidth <= 1 || img.naturalHeight <= 1) return;
  const ratio = img.naturalWidth / img.naturalHeight;
  img.style.setProperty('--page-ratio', ratio);
  if (img.parentElement?.classList.contains('page-wrap')) img.parentElement.style.setProperty('--page-ratio', ratio);
}
const _seedRatio = (img) => {
  _setPageRatioVars(img);
  img.style.removeProperty('aspect-ratio');
};
[mainImg, imgLeft, imgRight].forEach(img => img.addEventListener('load', () => _seedRatio(img)));
const scrubber      = document.getElementById('scrubber');
const scrubSegments = document.getElementById('scrubSegments');
const pageCounter   = document.getElementById('pageCounter');
const modeToggle    = document.getElementById('modeToggle');
const modeSingle    = document.getElementById('modeSingle');
const modeDouble    = document.getElementById('modeDouble');
const modeStrip     = document.getElementById('modeStrip');
const thumbBtn      = document.getElementById('thumbBtn');
const viewToggle    = document.getElementById('viewToggle');   // translate ⇄ study segmented toggle
const translateSeg  = document.getElementById('translateSeg');
const studySeg      = document.getElementById('studySeg');
const keybindBtn    = document.getElementById('keybindBtn');
const keybindModal  = document.getElementById('keybindModal');
const readerSettingsBtn = document.getElementById('readerSettingsBtn');
const readerSettingsModal = document.getElementById('readerSettingsModal');
const readerSettingsBox = document.getElementById('readerSettingsBox');
const readerSettingsClose = document.getElementById('readerSettingsClose');
const readerDirectionGroup = document.getElementById('readerDirectionGroup');
const readerGap = document.getElementById('readerGap');
const readerGapValue = document.getElementById('readerGapValue');
const readerZoomOut = document.getElementById('readerZoomOut');
const readerZoomIn = document.getElementById('readerZoomIn');
const readerZoomValue = document.getElementById('readerZoomValue');
const readerPinBtn  = document.getElementById('readerPinBtn');
const tbGallery     = document.getElementById('tbGallery');
const tbMeta        = document.getElementById('tbMeta');
const clickPrev     = document.getElementById('clickPrev');
const clickNext     = document.getElementById('clickNext');
const dClickPrev    = document.getElementById('dClickPrev');
const dClickNext    = document.getElementById('dClickNext');
const scrollTopBtn  = document.getElementById('scrollTopBtn');
const dividerPage   = document.getElementById('dividerPage');

function _storedPageNum(url) {
  const match = String(url || '').match(/\/([1-9]\d*)\.[^/?#]+(?:[?#].*)?$/);
  const pageNum = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(pageNum) && pageNum > 0 ? pageNum : null;
}

// ── Init ──
async function init() {
  if (!galleryId) { showEmpty(); return; }

  tbGallery.textContent = `#${galleryId}`;
  document.title        = `Shiori — #${galleryId}`;

  loadingText.textContent = t('rd.opening_db');
  try { _readerDb = await _openReaderDb(); }
  catch (e) { showEmpty(); return; }

  loadingText.textContent = t('rd.loading_pages');
  const gid = String(galleryId);

  // Series membership FIRST: a series is read as ONE continuous page list — every cached
  // chapter's pages concatenated in series order — so a chapter transition is just the next
  // scroll row (or page flip), never a reload.
  try { _series = await resolveSeries(galleryId); } catch { _series = null; }
  const chapterRefs = _series
    ? _series.chapters.map((c, i) => ({ id: String(c.id), num: i + 1, title: c.title || '' }))
    : [{ id: gid, num: 1, title: '' }];
  _seriesTotal = chapterRefs.length;

  // Page list (key-only cursor, no image bytes) and metadata for every chapter, in parallel.
  const pageList = (id) => new Promise((resolve) => {
    const urls = [];
    const tx  = _readerDb.transaction('images', 'readonly');
    const req = tx.objectStore('images').index('galleryId').openKeyCursor(IDBKeyRange.only(id));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { urls.push(cursor.primaryKey); cursor.continue(); } else resolve(urls);
    };
    req.onerror = () => resolve([]);
  });
  const metaGet = (id) => new Promise((resolve) => {
    const tx  = _readerDb.transaction('metadata', 'readonly');
    const req = tx.objectStore('metadata').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  });
  const [lists, metas] = await Promise.all([
    Promise.all(chapterRefs.map(c => pageList(c.id))),
    Promise.all(chapterRefs.map(c => metaGet(c.id))),
  ]);

  // Merge into the flat list by chapter-local page number. Metadata supplies the true total;
  // cached keys fill their fixed slots and every gap remains a placeholder until its page arrives.
  // With no declared total, the highest cached page preserves the reader's previous behaviour.
  pages = [];
  _chapters = [];
  _pageIdxByUrl.clear();
  chapterRefs.forEach((c, i) => {
    const cachedByNum = new Map();
    let highestCached = 0;
    for (const url of lists[i]) {
      const pageNum = _storedPageNum(url);
      if (pageNum != null) {
        cachedByNum.set(pageNum, { pageNum, url, cached: true });
        highestCached = Math.max(highestCached, pageNum);
      }
    }
    const declaredTotal = Number(metas[i]?.numPages);
    const trueTotal = Number.isSafeInteger(declaredTotal) && declaredTotal > 0 ? declaredTotal : 0;
    const count = Math.max(highestCached, trueTotal);
    if (!count) return;
    const slots = Array.from({ length: count }, (_, pageIdx) =>
      cachedByNum.get(pageIdx + 1) || { pageNum: pageIdx + 1, url: null, cached: false }
    );
    _chapters.push({
      ...c,
      start: pages.length,
      count,
      missing: count - cachedByNum.size,
      meta: metas[i],
    });
    pages.push(...slots);
  });
  pages.forEach((p, i) => { if (p.url) _pageIdxByUrl.set(p.url, i); });
  _replayQueuedPageStores();
  const placeholderRatioReady = _measurePlaceholderRatio();

  if (pages.length === 0) {
    // Point the empty screen's source link at the gallery that was actually asked for.
    const meta = metas[chapterRefs.findIndex(c => c.id === gid)] || null;
    const visitUrl = galleryLink(meta, meta?.sourceId || gid, 1);
    const emptyLink = document.getElementById('emptyLink');
    if (visitUrl) {
      emptyLink.href        = visitUrl;
      emptyLink.textContent = t('rd.open_on_arrow', { site: siteName(meta?.source) });
      emptyLink.style.display = '';
    } else {
      emptyLink.style.display = 'none';
    }
    showEmpty();
    return;
  }

  // The translate ⇄ study toggle shows whenever ANY chapter has a translation (study layers,
  // loaded below, additionally enable the study side). hasStudy is set by _loadStudy.
  _translateAvailable = _chapters.some(ch => !!ch.meta?.translated);
  await _loadStudy();
  if (_translateAvailable || hasStudy) viewToggle.style.display = '';
  studySeg.classList.toggle('disabled', !hasStudy);

  const saved = await platform.kv.get(['readerMode', 'readerLastPageMode', 'readerThumbsOpen', 'readerThumbHeight', 'readerPageZoom', 'readerFitMode', 'readerFitMaxWidth', 'readerDirection', 'readerPageGap', 'readerProgressPosition', 'readerView', 'readerStudyDisplay', 'readerStudyOriginal', 'readerStudySrcFont', 'readerFurigana', 'readerChapterDivider', 'readerStripMode']);
  if (saved.readerStudyDisplay === 'text') studyDisplay = 'text';
  if (saved.readerStudyOriginal === 'text') studyOriginal = 'text';
  if (saved.readerStudySrcFont === 'kiwi') studySrcFont = 'kiwi';
  furiganaOn = saved.readerFurigana === 'on';
  _chapterDividersOn = saved.readerChapterDivider !== false;
  _stripSeriesFlow   = saved.readerStripMode !== 'chapter';
  applyThumbHeight(saved.readerThumbHeight || _thumbHeight);
  if (saved.readerPageZoom) { _pageZoom = saved.readerPageZoom; document.documentElement.style.setProperty('--page-zoom', _pageZoom); }
  _applyReaderFitMaxWidth(saved.readerFitMaxWidth || FIT_WIDTH_MAX, false);
  _applyReaderFitMode(saved.readerFitMode || 'off', false);
  _applyReaderDirection(saved.readerDirection || 'ltr', false);
  _applyReaderPageGap(saved.readerPageGap ?? 4, false);
  _applyReaderProgressPosition(saved.readerProgressPosition || 'bottom', false);
  if (saved.readerLastPageMode) lastPageMode = saved.readerLastPageMode;

  // Resolve the initial view, defaulting to the full translation when available. Set the flags
  // before the first paint so pages load in the right variant with no swap flash.
  let initView = saved.readerView;
  if (initView === 'study' && !hasStudy) initView = 'off';
  if (initView === 'translate' && !_translateAvailable) initView = 'off';
  if (!initView) initView = _translateAvailable ? 'translate' : 'off';
  studyMode     = initView === 'study';
  translateView = initView === 'translate';
  document.body.classList.toggle('study-mode', studyMode);

  // Resolve the initial position BEFORE the first render — a chapter-scoped strip and the
  // thumbnails both build around it. ?g targets a chapter; ?page / ?p is a page within THAT
  // chapter ('last' = its final page). A ?g whose chapter has no cached pages falls back to
  // the first cached chapter.
  const startCh = _chapters.find(c => c.id === gid) || _chapters[0];
  const within = String(initialPageParam).toLowerCase() === 'last'
    ? startCh.count
    : Math.max(1, Math.min(startCh.count, parseInt(initialPageParam, 10) || 1));
  await placeholderRatioReady;
  loadingScreen.style.display = 'none';
  currentPage = startCh.start + within;
  setMode(saved.readerMode || 'strip', true);
  goTo(currentPage, true);
  if (mode === 'strip') requestAnimationFrame(_scrollStripToCurrent);
  _updateViewToggle();
  if (studyMode) _refreshBubbleLayers();
  _recomputeFold();  // the title is set now — (re)measure the fold breakpoint for the new title
  // Defer restoring thumbnail-open state — its eager IDB reads otherwise fight the strip's
  // own loader for IDB bandwidth, delaying the first visible page by several seconds.
  if (saved.readerThumbsOpen) setTimeout(() => setThumbsOpen(true), 1500);
  // Pre-generate the remaining thumbs in the background once the first pages are on screen,
  // so opening the strip later is instant. No-op for thumbs already generated. Very long series
  // skip this — their thumbs generate on demand around the visible band instead.
  setTimeout(() => { if (_thumbCount <= THUMB_EAGER_MAX) _enqueueAllThumbs(); }, 3500);
}

// ── Chapter navigation (series) ──
// A series renders as ONE continuous reader: `pages` holds every cached chapter back to back and
// `_chapters` maps merged page ranges back to their chapters. The counter and scrubber speak in
// chapter-local pages while the thumbnails and strip geometry stay series-wide; crossing a
// boundary just scrolls (or flips) into the next chapter's range — never a reload. The topbar
// chrome and the ?g= in the URL follow the chapter under the reading line.
let _series = null;
const _escR = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Merged page number (1-based) → index into _chapters (binary search over chapter starts).
function _chapterAt(page) {
  let lo = 0, hi = _chapters.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (_chapters[mid].start < page) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function _announceCurrentPage() {
  if (!_chapters.length) return;
  const ch = _chapters[_chapterAt(currentPage)];
  if (!ch?.meta?.source) return;
  const gid = String(ch.id);
  extSend({
    type: 'EXT_READER_POSITION',
    galleryId: gid,
    source: ch.meta.source,
    sourceRef: ch.meta.sourceId || gid,
    page: currentPage - ch.start,
  });
}

function _handlePageStored(event) {
  const ch = _chapters.find(c => String(c.id) === String(event.galleryId));
  const pageNum = Number(event.pageNum);
  const url = typeof event.url === 'string' ? event.url : '';
  if (!ch || !url || !Number.isSafeInteger(pageNum) || pageNum < 1 || pageNum > ch.count) return;
  const pageIdx = ch.start + pageNum - 1;
  if (pages[pageIdx]?.cached) return;

  pages[pageIdx] = { pageNum, url, cached: true };
  ch.missing = Math.max(0, ch.missing - 1);
  _pageIdxByUrl.set(url, pageIdx);
  if (_chapters[_curChIdx] === ch) scrubSegments.children[pageNum - 1]?.classList.add('cached');
  for (const prefix of ['o:', 't:']) {
    const old = _pageUrlCache.get(prefix + url);
    if (old) { try { URL.revokeObjectURL(old); } catch {} }
    _pageUrlCache.delete(prefix + url);
  }

  const thumb = thumbStrip.querySelector(`.thumb-item img[data-idx="${pageIdx}"]`);
  if (thumb) {
    delete thumb.dataset.queued;
    if (thumbsOpen) _enqueueThumb(thumb);
  }

  if (mode === 'strip') {
    const localIdx = pageIdx - _viewBase;
    if (localIdx >= 0 && localIdx < _viewCount) {
      _stripWraps[localIdx]?.classList.remove('page-placeholder');
      const center = currentPage - _viewBase - 1;
      if (Math.abs(localIdx - center) <= MOUNT_AHEAD) {
        void _mountOne(localIdx, _stripGen, false);
      }
    }
  } else if (pageIdx === currentPage - 1 ||
             (mode === 'double' && pageIdx === currentPage && _rightPageForSpread(currentPage))) {
    void goTo(currentPage, true);
  }
}

const _queuedPageStores = new Map();
let _pageSkeletonReady = false;

function _dispatchPageStored(event) {
  const galleryId = event?.galleryId == null ? '' : String(event.galleryId);
  const pageNum = Number(event?.pageNum);
  const url = typeof event?.url === 'string' ? event.url : '';
  if (!galleryId || !url || !Number.isSafeInteger(pageNum) || pageNum < 1) return;
  const normalized = { galleryId, pageNum, url };
  if (!_pageSkeletonReady) {
    _queuedPageStores.set(`${galleryId}\0${pageNum}`, normalized);
    return;
  }
  _handlePageStored(normalized);
}

function _replayQueuedPageStores() {
  _pageSkeletonReady = true;
  const queued = [..._queuedPageStores.values()];
  _queuedPageStores.clear();
  queued.forEach(_handlePageStored);
}

platform.jobs.subscribe((event) => {
  if (event?.type === 'PAGE_STORED') _dispatchPageStored(event);
});

// Double-page spreads never straddle a chapter boundary; the transition card must appear before
// the next chapter's first page, not after that page has already been shown on the right.
function _rightPageForSpread(page) {
  return page < pages.length && _chapterAt(page) === _chapterAt(page + 1) ? pages[page] : null;
}
// Jump to a merged page number in whatever the current mode is: strip lands there instantly
// (re-scoping a chapter-only strip if needed), page modes flip straight there — no transition page.
function _jumpToPage(n) {
  if (mode === 'strip') _stripJumpTo(n); else goTo(n, true);
}
function _gotoAdjacentChapter(delta) {
  if (_chapters.length < 2) return false;
  const target = _chapters[_chapterAt(currentPage) + delta];
  if (!target) return false;
  _jumpToPage(target.start + 1);
  return true;
}

// ── Chapter transition card ──
// "End of Ch. N" + the ended chapter's title, previous/next chapter cards, Series/Home links.
// The strip renders it inline after a chapter's last page; single/double show it as a dedicated
// transition page between chapters.
const CHD_PREV_SVG   = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
const CHD_NEXT_SVG   = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
const CHD_SERIES_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>';
const CHD_HOME_SVG   = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/></svg>';

// `compact` renders just the "End of Ch. N" label + title — the series-continuous strip flows
// straight into the next chapter, so its dividers carry no navigation.
function _buildDividerCard(k, compact = false) {
  const ch   = _chapters[k];
  const prev = _chapters[k - 1];
  const next = _chapters[k + 1];
  const el = document.createElement('div');
  el.className = 'chd';
  const adj = (c, dir) => `
    <button class="chd-adj${dir > 0 ? ' next' : ''}" data-dir="${dir}" ${c ? '' : 'disabled'}>
      ${dir < 0 ? CHD_PREV_SVG : ''}
      <span class="chd-adj-txt">
        <span class="chd-lbl">${_escR(t(dir < 0 ? 'rd.divider_prev' : 'rd.divider_next'))}</span>
        <span class="chd-num">${c ? _escR(t('rd.ch_n', { n: c.num })) : '—'}</span>
      </span>
      ${dir > 0 ? CHD_NEXT_SVG : ''}
    </button>`;
  el.innerHTML = `
    <div class="chd-end">${_escR(t('rd.end_of_ch', { n: ch.num }))}</div>
    ${ch.title ? `<div class="chd-sub">(${_escR(ch.title)})</div>` : ''}
    ${compact ? '' : `
    <div class="chd-nav">${adj(prev, -1)}${adj(next, 1)}</div>
    <div class="chd-links">
      <button class="chd-pill" data-act="series">${CHD_SERIES_SVG}<span>${_escR(t('rd.divider_series'))}</span></button>
      <button class="chd-pill" data-act="home">${CHD_HOME_SVG}<span>${_escR(t('rd.divider_home'))}</span></button>
    </div>`}`;
  if (compact) return el;
  el.querySelectorAll('.chd-adj').forEach(btn => btn.addEventListener('click', () => {
    const target = _chapters[k + parseInt(btn.dataset.dir, 10)];
    if (!target) return;
    _hidePageDivider();
    _jumpToPage(target.start + 1);
  }));
  el.querySelector('[data-act="series"]').addEventListener('click', () => { if (_series) location.href = `../overview?g=${_series.ownerId}`; });
  el.querySelector('[data-act="home"]').addEventListener('click', () => { location.href = '../'; });
  return el;
}

// ── Page-mode transition page ──
// Flipping across a chapter boundary in single/double first lands on a dedicated transition page
// (the card above, full-view). Another flip in the same direction continues into the adjacent
// chapter; flipping back returns to the ended chapter's last page. Jumps (thumbs, scrubber,
// chapter keys) skip it. Disabled entirely when chapter transitions are turned off in Settings.
let _pageDivider = null;   // index of the chapter whose end-transition is showing, or null

function _showPageDivider(k) {
  _pageDivider = k;
  const ch = _chapters[k];
  currentPage = ch.start + ch.count;   // the transition "sits" on the ended chapter's last page
  updateCounter();
  highlightThumb(currentPage - 1);
  scrollThumbIntoView(currentPage - 1);
  dividerPage.innerHTML = '';
  dividerPage.appendChild(_buildDividerCard(k));
  dividerPage.style.display = 'flex';
  document.body.classList.add('page-divider');
  document.body.classList.remove('study-bubbles-active');
  window.scrollTo(0, 0);
}

function _hidePageDivider() {
  if (_pageDivider === null) return;
  _pageDivider = null;
  dividerPage.style.display = 'none';
  document.body.classList.remove('page-divider');
}

// Called by goTo with the RAW (unclamped) target. Returns true when the navigation was consumed
// by the transition page — either by showing it at a boundary flip, or by stepping off it.
function _interceptPageDivider(rawN) {
  if (mode === 'strip' || !_series || !_chapters.length) return false;
  if (_pageDivider !== null) {
    const d = _pageDivider;
    if (Math.abs(rawN - currentPage) > 2) { _hidePageDivider(); return false; }   // jump → normal nav
    if (rawN > currentPage) {
      const nx = _chapters[d + 1];
      if (nx) { _hidePageDivider(); goTo(nx.start + 1, true); }
      return true;                     // no next chapter → stay on the end-of-series screen
    }
    _hidePageDivider();
    goTo(_chapters[d].start + _chapters[d].count, true);
    return true;
  }
  if (!_chapterDividersOn) {
    // A two-page step across an odd-length chapter would otherwise skip the adjacent chapter's
    // first (or previous chapter's last) page when transition screens are disabled.
    if (mode === 'double') {
      const k = _chapterAt(currentPage);
      const ch = _chapters[k];
      if (rawN > ch.start + ch.count && _chapters[k + 1]) {
        goTo(_chapters[k + 1].start + 1, true);
        return true;
      }
      if (rawN < ch.start + 1 && k > 0) {
        const prev = _chapters[k - 1];
        goTo(prev.start + prev.count, true);
        return true;
      }
    }
    return false;
  }
  if (Math.abs(rawN - currentPage) > 2) return false;   // thumbs/scrubber jumps skip the transition
  const k = _chapterAt(currentPage);
  const ch = _chapters[k];
  if (rawN > ch.start + ch.count) { _showPageDivider(k); return true; }
  if (rawN < ch.start + 1 && k > 0) { _showPageDivider(k - 1); return true; }
  return false;
}

function showEmpty() {
  loadingScreen.style.display = 'none';
  emptyScreen.classList.add('show');
}

// ── Navigation ──
let _pageNavToken = 0;
let _pageNavReady = { token: 0, promise: Promise.resolve(), resolve: () => {} };

function _beginPageNav() {
  _pageNavReady.resolve(); // release waiters for any superseded navigation
  const token = ++_pageNavToken;
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  _pageNavReady = { token, promise, resolve };
  return _pageNavReady;
}

function _finishPageNav(nav) {
  nav.resolve();
}

const _nextLayoutFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function _waitForImgDecode(img) {
  if (!img || !img.src || (img.complete && img.naturalWidth > 0)) return Promise.resolve();
  if (img.decode) return img.decode().catch(() => {});
  return new Promise(resolve => {
    const done = () => {
      img.removeEventListener('load', done);
      img.removeEventListener('error', done);
      resolve();
    };
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  });
}

async function _waitForImgLayout(imgs) {
  await Promise.all(imgs.map(_waitForImgDecode));
  await _nextLayoutFrame();
}

function _scrollPageModeToStart() {
  if (!readerPinned) _hideReaderNav();
  const navH = topbar?.offsetHeight || parseInt(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'), 10) || 54;
  const inner = mode === 'double' ? doubleInner : mode === 'single' ? singleInner : null;
  if (!inner) { window.scrollTo(0, 0); return; }
  const innerTop = inner.getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, Math.max(0, Math.round(innerTop - (readerPinned ? navH : 0))));
}

function _scrollPageModeToStartSoon(nav) {
  requestAnimationFrame(() => {
    if (nav.token === _pageNavReady.token && mode !== 'strip') _scrollPageModeToStart();
  });
}

function _scrollPageModeWhenImgsLoad(imgs, nav) {
  imgs.forEach(img => img.addEventListener('load', () => _scrollPageModeToStartSoon(nav), { once: true }));
}

async function goTo(n, skipDivider = false) {
  if (!pages.length) return;
  if (!skipDivider && _interceptPageDivider(n)) return;   // boundary flips show the transition page
  if (_pageDivider !== null) _hidePageDivider();          // any other navigation dismisses it
  const nav = _beginPageNav();
  n = Math.max(1, Math.min(pages.length, n));   // chapters are continuous; only the series clamps
  currentPage = n;

  try {
    // Update navigation UI immediately; image loads asynchronously below
    updateCounter();
    _evictFarUrls(n - 1);
    highlightThumb(n - 1);
    scrollThumbIntoView(n - 1);
    if (mode !== 'strip') _scrollPageModeToStart();

    if (mode === 'single') {
      const url = await pageBlobUrl(pages[n - 1]);
      if (currentPage !== n || mode !== 'single') return;
      _scrollPageModeWhenImgsLoad([mainImg], nav);
      const placeholder = _showPageImage(mainImg, url);
      singleInner.classList.toggle('page-placeholder', placeholder);
      _warmNeighbors(n);
      await _waitForImgLayout([mainImg]);
      if (currentPage !== n || mode !== 'single') return;
      _scrollPageModeToStart();
      if (studyMode) _refreshBubbleLayers();
    } else if (mode === 'double') {
      const lPage = pages[n - 1];
      const rPage = _rightPageForSpread(n);
      doubleInner.classList.toggle('single-spread', !rPage);
      imgRight.style.display = rPage ? 'block' : 'none';
      const [lUrl, rUrl] = await Promise.all([
        pageBlobUrl(lPage),
        rPage ? pageBlobUrl(rPage) : Promise.resolve('')
      ]);
      if (currentPage !== n || mode !== 'double') return;
      const visibleImgs = rPage ? [imgLeft, imgRight] : [imgLeft];
      _scrollPageModeWhenImgsLoad(visibleImgs, nav);
      const leftPlaceholder  = _showPageImage(imgLeft, lUrl);
      const rightPlaceholder = rPage ? _showPageImage(imgRight, rUrl) : false;
      if (!rPage) {
        imgRight.removeAttribute('src');
        imgRight.classList.remove('page-placeholder');
      }
      doubleInner.classList.toggle('left-placeholder', leftPlaceholder);
      doubleInner.classList.toggle('right-placeholder', rightPlaceholder);
      _warmNeighbors(n);
      await _waitForImgLayout(visibleImgs);
      if (currentPage !== n || mode !== 'double') return;
      _scrollPageModeToStart();
      if (studyMode) _refreshBubbleLayers();
    }
  } finally {
    _finishPageNav(nav);
  }
  if (currentPage === n) _announceCurrentPage();
  // strip: images loaded in buildStrip(); scroll handled separately
}

// Counter and scrubber are CHAPTER-relative (page n of this chapter); the thumbnails and the
// strip indicator stay series-wide. Every currentPage change funnels through here, so this is
// also where the topbar chrome notices the reading line crossing into another chapter.
function _renderScrubSegments(ch) {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < ch.count; i++) {
    const segment = document.createElement('span');
    segment.className = pages[ch.start + i]?.cached ? 'scrub-segment cached' : 'scrub-segment';
    fragment.appendChild(segment);
  }
  scrubSegments.replaceChildren(fragment);
}

function _updateScrubSegments(ch) {
  const localPage = ch ? currentPage - ch.start : currentPage;
  for (let i = 0; i < scrubSegments.children.length; i++) {
    scrubSegments.children[i].classList.toggle('played', i < localPage);
  }
}

function updateCounter() {
  const chIdx = _chapterAt(currentPage);
  if (chIdx !== _curChIdx) _applyChapterChrome(chIdx);
  const ch = _chapters[chIdx];
  const label = ch
    ? `${formatCount(currentPage - ch.start)} / ${formatCount(ch.count)}`
    : `${formatCount(currentPage)} / ${formatCount(pages.length)}`;
  pageCounter.textContent = label;
  if (ch) scrubber.value = currentPage - ch.start;
  _updateScrubSegments(ch);
}

// Point the topbar (gallery #, title, source link), document title, scrubber range and the URL at
// the chapter the current page belongs to — so a merged series still reads as its own galleries.
function _applyChapterChrome(idx) {
  const ch = _chapters[idx];
  if (!ch) return;
  const wasApplied = _curChIdx !== -1;
  _curChIdx = idx;
  const meta = ch.meta;
  const displayId = meta?.sourceId || ch.id;
  tbGallery.textContent = `#${displayId}`;
  tbGallery.classList.toggle('local', !!meta?.isLocalImport);
  document.title = `Shiori — #${displayId}`;
  const visitUrl = galleryLink(meta, displayId, 1);
  tbMeta.onclick = visitUrl ? () => window.open(visitUrl, '_blank', 'noopener') : null;
  const titleEl = document.getElementById('tbTitle');
  if (titleEl) titleEl.textContent = (meta && pickTitle(meta, getLang())) || '';
  scrubber.max = ch.count;
  _renderScrubSegments(ch);
  // Refresh should land back in this chapter — but never rewrite the URL for the initial apply,
  // which would drop the ?page= the reader was opened with.
  if (_series && wasApplied) _syncUrlToChapter(ch);
  _syncThumbScope();   // chapter-scoped thumbnails follow the chapter under the reading line
  _recomputeFold();   // the title just changed width → re-measure the fold breakpoint
}

// Debounced ?g= rewrite (fast scrubbing can cross many chapters per second; Safari throttles
// rapid replaceState calls). Resolved against location.href, never the <base>.
let _urlSyncTimer = null;
function _syncUrlToChapter(ch) {
  clearTimeout(_urlSyncTimer);
  _urlSyncTimer = setTimeout(() => {
    try {
      const u = new URL(location.href);
      u.searchParams.set('g', String(ch.id));
      u.searchParams.delete('page');
      u.searchParams.delete('p');
      history.replaceState(null, '', u);
    } catch {}
  }, 300);
}

// Thumbnails cover a SCOPE of the merged list: the whole series when the strip flows the series
// continuously, the current chapter everywhere else (single/double, and the per-chapter strip).
// Items are indexed locally; callers keep passing GLOBAL 0-based page indices.
let _thumbItems = [];      // cached .thumb-item elements (local index within the thumb scope)
let _thumbBase  = 0;       // global page offset of _thumbItems[0]
let _thumbCount = 0;
let _activeThumbIdx = -1;  // local index
function highlightThumb(idx) {
  const local = idx - _thumbBase;
  if (local === _activeThumbIdx) return;
  if (_activeThumbIdx >= 0) _thumbItems[_activeThumbIdx]?.classList.remove('active');
  _activeThumbIdx = (local >= 0 && local < _thumbItems.length) ? local : -1;
  if (_activeThumbIdx >= 0) _thumbItems[_activeThumbIdx].classList.add('active');
}

function scrollThumbIntoView(idx) {
  const t = _thumbItems[idx - _thumbBase];
  if (t) t.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

// Single source of truth for the current page: the page at the scrubber position — the reading
// line (the navbar bottom when pinned) mapped through the SAME proportion that places the strip's
// fill indicator. Driving the counter and the active-thumb border from this (rather than a
// separate area metric) keeps the border tracking the fill, and makes it flip symmetrically when
// stepping between adjacent pages in either direction.
function _setCurrentPageFromProportion(p) {
  const n = _viewCount;   // proportion is over the strip's scoped range, not the whole series
  if (!n) return;
  const pg = _viewBase + Math.min(n, Math.max(1, Math.round(p * (n - 1)) + 1));
  if (pg === currentPage) return;
  currentPage = pg;
  updateCounter();
  highlightThumb(pg - 1);
}

// ── Thumbnails ──
// Build DOM upfront, observe each thumb. Only thumbs that intersect the strip's visible area
// (or its preload margin) get a src — keeps decoded bitmaps bounded to what's actually shown.
// When the strip is closed (height: 0), all imgs evict naturally because root has zero area.
const thumbResizeHandle = document.getElementById('thumbResizeHandle');
let _thumbHeight   = 88;
let _thumbViewport = null;  // overlay showing current viewport range in the reader

// The scope thumbnails should cover right now (see the note above highlightThumb).
function _thumbScope() {
  if (mode === 'strip') return { base: _viewBase, count: _viewCount };   // match the built strip
  if (!_series) return { base: 0, count: pages.length };
  const ch = _chapters[_chapterAt(currentPage)];
  return ch ? { base: ch.start, count: ch.count } : { base: 0, count: pages.length };
}

// Rebuild the thumbnails when their scope changed (mode switch, chapter crossing, strip re-scope)
// and restart generation for the fresh items. Cheap when the scope is unchanged.
function _syncThumbScope() {
  const s = _thumbScope();
  if (s.base === _thumbBase && s.count === _thumbCount && _thumbItems.length) return;
  buildThumbs();
  if (thumbsOpen) {
    if (_thumbCount <= THUMB_EAGER_MAX) _enqueueAllThumbs(); else _enqueueNearbyThumbs();
    _prioritizeVisibleThumbs();
    if (mode === 'strip') _setIndicator(_scrollYToProportion(window.scrollY + _pinOffset()));
    else setTimeout(_ensureActiveThumbVisible, 100);
  }
}

function buildThumbs() {
  const s = _thumbScope();
  _thumbBase = s.base;
  _thumbCount = s.count;
  thumbStrip.innerHTML = '';
  _thumbItems = [];
  _activeThumbIdx = -1;

  // Viewport indicator first — stays as first child, sized & positioned via JS.
  _thumbViewport = document.createElement('div');
  _thumbViewport.id = 'thumbViewport';
  thumbStrip.appendChild(_thumbViewport);
  _attachIndicatorListener();

  for (let i = 0; i < s.count; i++) {
    const gi = s.base + i;             // global page index — what the generator loads by
    const div = document.createElement('div');
    div.className = 'thumb-item';
    div.dataset.idx = gi;
    const img = document.createElement('img');
    img.dataset.idx = gi;
    div.appendChild(img);
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = i + 1;           // numbering is scope-local (chapter page or series page)
    div.appendChild(num);
    thumbStrip.appendChild(div);
    _thumbItems.push(div);
  }
  highlightThumb(Math.min(s.base + s.count, Math.max(s.base + 1, currentPage)) - 1);

  // Generation is NOT started here: decoding every page up front fought the strip's own
  // loader for IDB/decoder bandwidth and delayed the first visible page by seconds. Thumbs
  // are enqueued when the strip opens (visible-first) or by init's idle timer, whichever
  // comes first.
}

// Above this many pages, thumbs are never all pre-generated — only the band around the strip's
// visible range is, on demand, so opening the thumbnails on a huge series doesn't decode
// every page in the background.
const THUMB_EAGER_MAX = 400;

function _enqueueThumb(img) {
  const page = pages[parseInt(img.dataset.idx)];
  if (!page?.cached || !page.url) return;
  const cached = _cachedThumb(page.url);
  if (img.dataset.queued) {
    if (cached && !img.getAttribute('src')) img.src = cached;
    return;
  }
  img.dataset.queued = '1';
  if (cached) {
    if (!img.getAttribute('src')) img.src = cached;
    return;
  }
  _generateThumbBlob(page).then(url => {
    if (url && img.isConnected && img.dataset.queued && !img.getAttribute('src')) img.src = url;
  });
}

function _enqueueAllThumbs() {
  thumbStrip.querySelectorAll('.thumb-item img').forEach(_enqueueThumb);
}

// Long series: enqueue only thumbs within ± one strip-width of the visible band.
function _enqueueNearbyThumbs() {
  if (!thumbsOpen) return;
  const lo = thumbStrip.scrollLeft - thumbStrip.clientWidth;
  const hi = thumbStrip.scrollLeft + 2 * thumbStrip.clientWidth;
  for (const item of _thumbItems) {
    if (item.offsetLeft + item.offsetWidth < lo || item.offsetLeft > hi) continue;
    const img = item.querySelector('img');
    if (img) _enqueueThumb(img);
  }
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
    if (_thumbCount <= THUMB_EAGER_MAX) _enqueueAllThumbs(); else _enqueueNearbyThumbs();
    _prioritizeVisibleThumbs();
    if (mode === 'strip') {
      setTimeout(() => _setIndicator(_scrollYToProportion(window.scrollY + _pinOffset())), 50);
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

// A pinned header overlaps the top of the scroll content, so programmatic scrolls that target a
// page's true top must land it this many px lower — and the scroll→page reference line shifts down
// by the same amount — mirroring the CSS scroll-padding-top that scrollIntoView already honours.
// 0 when unpinned (the fixed overlay does not move the content's reading line).
const TOPBAR_H = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'), 10) || 54;
const _pinOffset = () => (readerPinned ? TOPBAR_H : 0);

// Map scrollY → proportion via page index, not linear interpolation.
// Finds which page top is at/above scrollY, then interpolates within that page gap.
// This keeps strip ↔ scroll in sync even when page heights vary.
function _scrollYToProportion(scrollY) {
  // Measure the .page-wrap rows (positioned flex children of stripView) — each page-img sits
  // inside its own relative wrap, so the wrap is the element whose offsetTop tracks scroll.
  // _stripWraps is cached at build time; re-querying 1000+ rows per scroll frame is too slow.
  const imgs = _stripWraps;
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
  const imgs = _stripWraps;
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
  const rect = thumbStrip.getBoundingClientRect();
  if (_dragGrabOffset === null) _dragGrabOffset = iW / 2;

  // When the thumbnails overflow the strip, it pans to keep the indicator under the cursor and the
  // proportion maps across the full strip width. When they DON'T fill the strip (few pages — e.g. a
  // short chapter), no panning is possible, so map the cursor directly onto the thumb span [a, b];
  // otherwise the indicator only creeps across a narrow band and stops tracking the cursor.
  const overflowing = thumbStrip.scrollWidth > thumbStrip.offsetWidth + 1;
  let p, contentLeft;
  if (overflowing) {
    const visualRange = Math.max(1, rect.width - iW);
    const visualLeft  = Math.max(0, Math.min(visualRange, clientX - rect.left - _dragGrabOffset));
    p           = visualLeft / visualRange;
    contentLeft = _proportionToContentLeft(p, a, b);
    const maxScrollX = Math.max(0, thumbStrip.scrollWidth - thumbStrip.offsetWidth);
    thumbStrip.scrollLeft = Math.max(0, Math.min(maxScrollX, contentLeft - visualLeft / z));
  } else {
    contentLeft = Math.max(a, Math.min(b, (clientX - rect.left - _dragGrabOffset) / z));
    p           = (b > a) ? (contentLeft - a) / (b - a) : 0;
  }

  if (_thumbViewport) _thumbViewport.style.left = contentLeft + 'px';

  if (mode === 'strip') {
    window.scrollTo({ top: _proportionToScrollY(p) - _pinOffset(), behavior: 'instant' });
    _setCurrentPageFromProportion(p);   // keep the counter in step while scrubbing (border is hidden)
    _scheduleStripSync();   // the scroll listener skips syncing while _thumbDragging — do it here
  } else {
    const idx = Math.min(_thumbCount - 1, Math.round(p * (_thumbCount - 1)));
    const n = _thumbBase + idx + 1;
    if (n !== currentPage) goTo(n, true);
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
    const stripImg = stripView.querySelector(`[data-page="${_thumbBase + idx + 1}"]`);
    if (!stripImg) return;
    const targetY   = stripImg.getBoundingClientRect().top + window.scrollY;
    const destP     = _scrollYToProportion(targetY);
    const destCenter = _proportionToContentLeft(destP, a, b) + iW / (2 * z);
    _lockCenter          = thumbStrip.scrollLeft + thumbStrip.offsetWidth / 2;
    _lockDir             = destCenter < _lockCenter ? -1 : 1;
    _scrollSettled       = false;
    _lastIndicatorCenter = null;
    window.scrollTo({ top: targetY - _pinOffset(), behavior: 'smooth' });
  } else if (_thumbBase + idx + 1 !== currentPage) {
    goTo(_thumbBase + idx + 1, true);
  }
}

// Drag-vs-click distinction: pointerdown alone doesn't scroll — wait for either movement
// (drag, continuous scroll) or pointerup-without-movement (click, snap to thumb page).
// Momentum / inertia for swipe-pan mode.
let _swipeRaf = null;
let _wheelTarget = null;   // eased wheel-scroll target (px); null when no wheel animation is running
let _wheelRaf    = null;
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
    cancelAnimationFrame(_wheelRaf); _wheelRaf = null; _wheelTarget = null;   // drag overrides wheel glide
    if (isScrubber) {
      _thumbDragging = true;
      thumbStrip.classList.add('scrubbing');   // only scrubbing hides the border + shows the fill
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
        // Land the virtualized window exactly where the scrub ended (throttling during the drag
        // may have left the last couple of pages unsynced).
        if (mode === 'strip') { _lastSyncCenter = Infinity; _scheduleStripSync(); }
      } else {
        _launchSwipeMomentum(velocity);
      }
      document.body.classList.remove('thumb-dragging');
      thumbStrip.classList.remove('dragging', 'scrubbing');
    } else {
      // No movement → treat as click. Snap to the clicked thumb's page; the strip stays open in
      // every mode (a click is a page jump, not a dismiss — the viewport click closes it instead).
      _clickSnapToThumb(ev.clientX);
    }
  }
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

let _thumbScrollRaf = null;
thumbStrip.addEventListener('scroll', () => {
  if (_thumbScrollRaf) return;
  _thumbScrollRaf = requestAnimationFrame(() => {
    _thumbScrollRaf = null;
    if (_thumbCount > THUMB_EAGER_MAX) _enqueueNearbyThumbs();   // on-demand band for long series
    _prioritizeVisibleThumbs();
  });
}, { passive: true });

// A plain mouse-wheel over the strip scrolls it horizontally (no Shift needed), eased toward an
// accumulated target so rapid ticks glide smoothly instead of stepping. Kept local — preventDefault
// so the page doesn't also scroll, stopPropagation so it doesn't feed the floating-nav reveal —
// while the pointer is over the strip. Over the main page the wheel still scrolls the page (and the
// strip's indicator follows). If the strip can't scroll (everything fits), the wheel falls through.
function _wheelGlide() {
  const max  = Math.max(0, thumbStrip.scrollWidth - thumbStrip.clientWidth);
  _wheelTarget = Math.max(0, Math.min(max, _wheelTarget));
  const diff = _wheelTarget - thumbStrip.scrollLeft;
  if (Math.abs(diff) < 0.5) { thumbStrip.scrollLeft = _wheelTarget; _wheelRaf = null; _wheelTarget = null; return; }
  thumbStrip.scrollLeft += diff * 0.2;   // ease ~20% of the remaining distance per frame
  _wheelRaf = requestAnimationFrame(_wheelGlide);
}
thumbStrip.addEventListener('wheel', (e) => {
  const max = thumbStrip.scrollWidth - thumbStrip.clientWidth;
  if (max <= 0) return;
  // A plain mouse reports deltaY; trackpads / Shift-wheel report deltaX — use whichever dominates.
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!delta) return;
  cancelAnimationFrame(_swipeRaf);                       // a fresh wheel takes over from any swipe coast
  if (_wheelTarget === null) _wheelTarget = thumbStrip.scrollLeft;
  _wheelTarget = Math.max(0, Math.min(max, _wheelTarget + delta));
  if (!_wheelRaf) _wheelRaf = requestAnimationFrame(_wheelGlide);
  e.preventDefault();
  e.stopPropagation();
}, { passive: false });

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

// ── Header: pinned vs unpinned ──
// Pinned: the bar is sticky and occupies its normal document space. Unpinned: it becomes a fixed
// overlay, so fitted pages can use the full viewport without creating a header-height scroll range.
// Ten consecutive upward wheel events reveal it with an animated transform. Reaching scrollY 0
// resets that count, so revealing from the top requires ten additional upward events there too.
// The top-edge hover target matches the header's full height.
let readerPinned = localStorage.getItem('shiori-reader-pin') === '1'; // default: unpinned
let readerNavWheelUps = 0;
let readerNavLastY = window.scrollY;
const READER_NAV_REVEAL_UNITS = 10;

function _hideReaderNav() {
  readerNavWheelUps = 0;
  document.body.classList.remove('reader-nav-auto');
}

function applyReaderPin(p) {
  readerPinned = p;
  readerPinBtn.innerHTML = p ? READER_PIN_SVG : READER_UNPIN_SVG;
  readerPinBtn.dataset.tip = p ? t('rd.tip_unpin') : t('rd.tip_pin');
  localStorage.setItem('shiori-reader-pin', p ? '1' : '0');
  // When pinned, offset programmatic scrolls (page nav, scrubber, Home/End) by the header height
  // so a navigated page lands just below the sticky header instead of behind it.
  document.documentElement.style.scrollPaddingTop = p ? 'var(--topbar-h)' : '';
  document.documentElement.classList.add('reader-scroll');
  document.body.classList.add('reader-scroll');
  document.body.classList.toggle('reader-unpinned', !p);
  document.body.classList.remove('reader-nav-hover');
  _hideReaderNav();
}
applyReaderPin(readerPinned);

window.addEventListener('wheel', (e) => {
  if (readerPinned) return;
  if (!e.deltaY) return;
  if (e.deltaY < 0) {
    if (!document.body.classList.contains('reader-nav-auto') && ++readerNavWheelUps >= READER_NAV_REVEAL_UNITS) {
      readerNavWheelUps = 0;
      document.body.classList.add('reader-nav-auto');
    }
    return;
  }
  _hideReaderNav();
}, { passive: true });

window.addEventListener('scroll', () => {
  const y = window.scrollY;
  if (!readerPinned) {
    if (y > readerNavLastY) _hideReaderNav();
    else if (y <= 0 && readerNavLastY > 0) readerNavWheelUps = 0;
  }
  readerNavLastY = y;
}, { passive: true });

topbarReveal.addEventListener('pointerenter', () => {
  if (!readerPinned) document.body.classList.add('reader-nav-hover');
});
topbarReveal.addEventListener('pointerleave', (e) => {
  if (!topbar.contains(e.relatedTarget)) document.body.classList.remove('reader-nav-hover');
});
topbar.addEventListener('pointerleave', (e) => {
  if (e.relatedTarget !== topbarReveal) document.body.classList.remove('reader-nav-hover');
});


// ── Strip view ──
// The strip is VIRTUALIZED. Every page gets a fixed-order .page-wrap whose aspect ratio reserves
// its height (so the scrollbar and the strip↔thumb sync geometry stay stable), but only a window
// of pages around the reading line holds a live <img src>. Outside a wider hysteresis band the
// src is dropped — the browser frees the decoded bitmap — and blob URLs cached far away are
// revoked, so a series of thousands of pages holds the same steady-state memory as a short
// gallery. Loads run nearest-to-viewport first, and every jump (scrubber, thumbs, fast wheel,
// click-wheel nav) re-aims the window at the new position, cancelling superseded loads.
const DECODE_AHEAD = 8;        // pages on each side of the current one kept eagerly decoded
const STRIP_CONCURRENCY = 4;   // parallel loaders — kept low so loads always win over thumb work
const MOUNT_AHEAD = 12;        // pages on each side of the current one that hold a live src
const UNMOUNT_BEYOND = 30;     // mounted pages farther than this lose their src (hysteresis)
const URL_EVICT_BEYOND = 80;   // cached blob URLs farther than this are revoked

// The strip renders a SCOPE of the merged list: the whole series when the series-continuous flow
// is on, the current chapter only otherwise. All row indices below are LOCAL to that scope;
// currentPage stays global and converts through _viewBase.
let _viewBase  = 0;            // global page offset of the strip's first row
let _viewCount = 0;            // rows in the strip
let _stripWraps = [];          // .page-wrap per row, fixed order (local index)
let _stripImgs  = [];          // the .page-img inside each wrap
const _mountedIdx = new Set(); // local indices whose img currently holds a src

function _stripScope() {
  if (!_series || _stripSeriesFlow) return { base: 0, count: pages.length };
  const ch = _chapters[_chapterAt(currentPage)];
  return ch ? { base: ch.start, count: ch.count } : { base: 0, count: pages.length };
}

// Revoke cached blob URLs for pages far from centerIdx (0-based). The radius is far wider than
// the unmount band and the page-mode warm window, so nothing on screen can lose its URL.
function _evictFarUrls(centerIdx) {
  for (const [key, url] of _pageUrlCache) {
    const idx = _pageIdxByUrl.get(key.slice(2));   // strip the 'o:'/'t:' variant prefix
    if (idx === undefined || Math.abs(idx - centerIdx) <= URL_EVICT_BEYOND) continue;
    if (url) { try { URL.revokeObjectURL(url); } catch {} }
    _pageUrlCache.delete(key);
  }
}

// Load one page into its strip slot. On a translation-view swap (swap=true) a visible page's
// replacement is decoded BEFORE its src changes, so it never blanks. Bails out silently when the
// pass was superseded or the window has already moved past this page.
async function _mountOne(idx, gen, swap) {
  const page = pages[_viewBase + idx];
  const url = await pageBlobUrl(page);
  if (_stripGen !== gen || !url) return;
  if (Math.abs(idx + 1 - (currentPage - _viewBase)) > MOUNT_AHEAD) return;   // window moved on mid-load
  const img = _stripImgs[idx];
  _stripWraps[idx]?.classList.remove('page-placeholder');
  const vk  = _variantKey(page);
  if (img.dataset.vk === vk && img.getAttribute('src') === url) {
    _mountedIdx.add(idx);
    const wrap = _stripWraps[idx];
    if (studyMode && wrap && !wrap.querySelector(':scope > .bubble-layer')) _renderBubbleLayer(wrap, _viewBase + idx + 1);
    return;
  }
  const near = Math.abs(idx + 1 - (currentPage - _viewBase)) <= DECODE_AHEAD;
  if (swap && near && img.getAttribute('src')) {
    const pre = new Image(); pre.src = url;   // decode the replacement before swapping in
    try { await pre.decode(); } catch {}
    if (_stripGen !== gen) return;
  }
  img.src = url;
  img.dataset.vk = vk;
  _mountedIdx.add(idx);
  const wrap = _stripWraps[idx];
  if (studyMode && wrap && !wrap.querySelector(':scope > .bubble-layer')) _renderBubbleLayer(wrap, _viewBase + idx + 1);
  if (near) { try { await img.decode(); } catch {} }
}

// Aim the mounted window at the current page: unmount what fell out of the hysteresis band (or
// holds a stale variant outside the live window), evict far URLs, then fill in whatever the
// window is missing — nearest to the viewport first. A bumped _stripGen cancels any prior pass.
function _syncStripWindow(swap = false) {
  if (mode !== 'strip' || !_stripImgs.length) return;
  const gen = ++_stripGen;
  const center = Math.max(1, Math.min(_viewCount, currentPage - _viewBase));   // local, 1-based
  const lo = Math.max(0, center - 1 - MOUNT_AHEAD);
  const hi = Math.min(_viewCount - 1, center - 1 + MOUNT_AHEAD);

  for (const idx of [..._mountedIdx]) {
    const img = _stripImgs[idx];
    if ((idx < lo || idx > hi) && _stripWraps[idx]?.querySelector(':scope > .bubble-layer')) {
      _removeWrapBubbleLayer(_stripWraps[idx]);
    }
    const far   = Math.abs(idx + 1 - center) > UNMOUNT_BEYOND;
    const stale = img.dataset.vk !== _variantKey(pages[_viewBase + idx]) && (idx < lo || idx > hi);
    if (!far && !stale) continue;
    _removeWrapBubbleLayer(_stripWraps[idx]);
    img.removeAttribute('src');
    delete img.dataset.vk;
    _mountedIdx.delete(idx);
  }
  _evictFarUrls(currentPage - 1);

  const pending = [];
  for (let i = lo; i <= hi; i++) {
    const img = _stripImgs[i];
    if (img.getAttribute('src') && img.dataset.vk === _variantKey(pages[_viewBase + i])) {
      // Already mounted: re-warm the decode cache near the viewport (no-op when still resident).
      if (Math.abs(i + 1 - center) <= DECODE_AHEAD) img.decode().catch(() => {});
      const wrap = _stripWraps[i];
      if (studyMode && wrap && !wrap.querySelector(':scope > .bubble-layer')) _renderBubbleLayer(wrap, _viewBase + i + 1);
      continue;
    }
    pending.push(i);
  }
  pending.sort((a, b) => Math.abs(a + 1 - center) - Math.abs(b + 1 - center));
  let active = 0, at = 0;
  function next() {
    if (_stripGen !== gen) return;
    while (active < STRIP_CONCURRENCY && at < pending.length) {
      const idx = pending[at++];
      active++;
      _mountOne(idx, gen, swap).finally(() => { active--; next(); });
    }
  }
  next();
}

// Scroll-driven re-aim, throttled to one frame AND to ≥2 pages of movement, so flinging the
// wheel, scrubbing, or the W/S scroll loop doesn't rebuild the load queue on every scroll event.
let _lastSyncCenter = Infinity;
let _stripSyncQueued = false;
let _stripPositionTimer = null;
function _scheduleStripSync() {
  if (mode !== 'strip') return;
  clearTimeout(_stripPositionTimer);
  _stripPositionTimer = setTimeout(() => {
    if (mode === 'strip') _announceCurrentPage();
  }, 150);
  if (Math.abs(currentPage - _lastSyncCenter) < 2) return;
  if (_stripSyncQueued) return;
  _stripSyncQueued = true;
  requestAnimationFrame(() => {
    _stripSyncQueued = false;
    _lastSyncCenter = currentPage;
    _syncStripWindow();
  });
}

function buildStrip() {
  ++_stripGen;               // cancel in-flight loads aimed at the previous strip DOM
  _mountedIdx.clear();
  stripView.innerHTML = '';
  const scope = _stripScope();
  _viewBase  = scope.base;
  _viewCount = scope.count;

  // Build the full row skeleton upfront so DOM order is fixed before any async work. Each
  // page-img sits in its own .page-wrap (relative) so study-mode bubble overlays can anchor to
  // the image box; the wrap carries data-page (GLOBAL page number) and is the row measured by
  // the scroll-sync geometry. Transition cards slot after a chapter's last page — the sync math
  // only measures .page-wrap rows, so their height is absorbed by the between-page interpolation.
  for (let i = 0; i < _viewCount; i++) {
    const gi = _viewBase + i;
    const wrap = document.createElement('div');
    wrap.className    = pages[gi]?.cached ? 'page-wrap' : 'page-wrap page-placeholder';
    wrap.dataset.page = gi + 1;
    const img = document.createElement('img');
    img.className    = 'page-img';
    img.decoding     = 'async';
    // Missing rows always use the immutable baseline. Cached rows may reuse a previously learned
    // page-specific ratio, then refine it from the real image after loading.
    if (pages[gi]?.cached) {
      img.style.aspectRatio = _pageRatios.get(gi) || _placeholderRatio;
    } else {
      _setPlaceholderGeometry(img, wrap);
    }
    img.addEventListener('load', () => {
      if (img.naturalWidth > 1 && img.naturalHeight > 1) {
        const r = `${img.naturalWidth} / ${img.naturalHeight}`;
        if (img.style.aspectRatio !== r) {
          // A page ABOVE the viewport learning its true ratio would shove the reading position
          // by its height delta — compensate the scroll so the visible content doesn't move.
          const above  = wrap.offsetTop + wrap.offsetHeight <= window.scrollY;
          const before = above ? wrap.offsetHeight : 0;
          img.style.aspectRatio = r;
          if (above) {
            const delta = wrap.offsetHeight - before;
            if (delta) window.scrollBy(0, delta);
          }
        }
        _pageRatios.set(gi, r);
        _setPageRatioVars(img);
      }
    });
    wrap.appendChild(img);
    stripView.appendChild(wrap);

    // End-of-chapter transition card. Always present in the per-chapter flow (it IS the next/
    // previous-chapter navigation there); in the continuous flow it's the optional divide.
    const chIdx = _chapterAt(gi + 1);
    const isChapterEnd = gi + 1 === _chapters[chIdx].start + _chapters[chIdx].count;
    if (_series && isChapterEnd && (_chapterDividersOn || !_stripSeriesFlow)) {
      const div = document.createElement('div');
      div.className = 'chapter-divider';
      div.appendChild(_buildDividerCard(chIdx, _stripSeriesFlow));   // continuous flow → label only
      stripView.appendChild(div);
    }
  }
  _stripWraps = [...stripView.querySelectorAll('.page-wrap')];
  _stripImgs  = _stripWraps.map(w => w.firstElementChild);

  _lastSyncCenter = Infinity;
  _syncStripWindow();
  if (studyMode) _refreshBubbleLayers();
}

// ── Mode switching ──
function _applyReaderDirection(next, persist = true) {
  readerDirection = next === 'rtl' ? 'rtl' : 'ltr';
  document.body.classList.toggle('reader-rtl', readerDirection === 'rtl');
  if (persist) platform.kv.set({ readerDirection });
  _syncReaderSettingsUI();
}

function _applyReaderPageGap(next, persist = true) {
  readerPageGap = Math.max(0, Math.min(40, Math.round(Number(next) || 0)));
  document.documentElement.style.setProperty('--reader-page-gap', `${readerPageGap}px`);
  if (persist) platform.kv.set({ readerPageGap });
  _syncReaderSettingsUI();
}

function _applyReaderProgressPosition(next, persist = true) {
  if (!['top', 'bottom', 'left', 'right', 'off'].includes(next)) next = 'bottom';
  readerProgressPosition = next;
  bottombar.dataset.position = next;
  bottombar.classList.toggle('hidden', next === 'off');
  document.body.classList.toggle('bar-hidden', next !== 'bottom');
  document.documentElement.style.setProperty(
    '--botbar-visual-h',
    next === 'bottom' ? 'calc(var(--botbar-h) * var(--zoom-inv, 1))' : '0px'
  );
  if (persist) platform.kv.set({ readerProgressPosition });
  _syncReaderSettingsUI();
}

let _modeApplied = false;
function setMode(m, skipAnim) {
  // Already in this mode (e.g. pressing 3 repeatedly) → no-op, so we don't rebuild the view
  // and make it jitter. The very first call always runs (the view isn't built yet).
  if (_modeApplied && m === mode) return;
  _modeApplied = true;
  _hidePageDivider();   // never carry a transition page across modes
  if (m !== 'strip') scrollTopBtn.classList.remove('visible');

  mode = m;
  document.documentElement.classList.add('reader-scroll');
  document.body.classList.add('reader-scroll');
  if (m === 'strip' && _pageZoom > 1) _applyPageZoom(1);

  // Show/hide views
  singleView.classList.toggle('active', m === 'single');
  doubleView.classList.toggle('active', m === 'double');
  stripView.classList.toggle('active',  m === 'strip');

  _applyReaderProgressPosition(readerProgressPosition, false);

  // Slide the reading-mode toggle to the active mode.
  if (m !== 'strip') lastPageMode = m;
  platform.kv.set({ readerMode: m, readerLastPageMode: lastPageMode });
  _updateModeToggle();

  if (m === 'strip') {
    buildStrip();
    if (!skipAnim) requestAnimationFrame(_scrollStripToCurrent);
  } else {
    goTo(currentPage, true);
  }
  _syncThumbScope();   // strip (possibly series-wide) ↔ page modes (chapter) change the thumb range
  _syncReaderSettingsUI();
}

// Scroll the strip to the current page. Rows already reserve the correct height (see buildStrip),
// so the target lands in place and stays — no post-load correction, which is what used to flash.
function _scrollStripToCurrent() {
  if (currentPage <= _viewBase + 1) { window.scrollTo(0, 0); return; }
  const target = stripView.querySelector(`[data-page="${currentPage}"]`);
  if (target) target.scrollIntoView();
}

// ── Events ──
const CLICK_WHEEL_NAV_THRESHOLD = 60;
let _clickWheelNavHeld = false;
let _clickWheelNavUsed = false;
let _clickWheelNavDelta = 0;
let _clickWheelNavPage = null;
let _clickWheelNavSteps = 0;   // navigations in this click-hold session — boundary rule below
let _clickWheelNavClearTimer = null;

function _endClickWheelNav() {
  _clickWheelNavHeld = false;
  _clickWheelNavDelta = 0;
  _clickWheelNavPage = null;
  if (_clickWheelNavUsed) {
    clearTimeout(_clickWheelNavClearTimer);
    _clickWheelNavClearTimer = setTimeout(() => { _clickWheelNavUsed = false; }, 0);
  }
}

function _eventDominantWheelDelta(e) {
  let delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
  else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= window.innerHeight || 800;
  return delta;
}

// Instant strip jump — chapter navigation and scope changes. Rebuilds a chapter-only strip when
// the target is outside it, then lands at the TOP of the target page synchronously: no smooth
// animation (which would crawl through every page in between) and no async gap in which a stray
// scroll event could re-derive currentPage from the stale scroll offset.
function _stripJumpTo(n) {
  if (!pages.length) return false;
  n = Math.max(1, Math.min(pages.length, n));
  currentPage = n;
  if (n <= _viewBase || n > _viewBase + _viewCount) buildStrip();
  updateCounter();        // applies the new chapter's chrome, which re-scopes the thumbnails
  highlightThumb(n - 1);
  scrollThumbIntoView(n - 1);
  _scrollStripToCurrent();
  _lastSyncCenter = Infinity;
  _scheduleStripSync();
  return true;
}

function _scrollStripToPage(n) {
  if (!pages.length) return false;
  n = Math.max(1, Math.min(pages.length, n));
  // Chapter-only strip: a target outside the scoped range re-scopes and lands instantly.
  if (n <= _viewBase || n > _viewBase + _viewCount) return _stripJumpTo(n);
  const t = stripView.querySelector(`[data-page="${n}"]`);
  if (!t) return false;
  t.scrollIntoView({ behavior: 'smooth' });
  currentPage = n;
  updateCounter();
  highlightThumb(n - 1);
  scrollThumbIntoView(n - 1);
  _scheduleStripSync();   // start loading the destination before the smooth scroll arrives
  return true;
}

// Like held keys, a continuous click-wheel run breaks at chapter boundaries: it parks on the
// transition page (or the chapter's edge when there is none) and only a session that STARTS
// there (release, then click-hold again) continues into the adjacent chapter.
function _clickWheelPageNav(dir) {
  if (!pages.length) return false;
  const step = mode === 'double' ? 2 : 1;
  if (mode === 'strip') {
    const base = _clickWheelNavPage ?? currentPage;
    const rawNext = base + dir;
    if (rawNext < 1 || rawNext > pages.length) return false;   // series edge — chapters are continuous
    if (_clickWheelNavSteps > 0 && _chapterAt(rawNext) !== _chapterAt(base)) return false;
    if (_scrollStripToPage(rawNext)) {
      _clickWheelNavPage = rawNext;
      _clickWheelNavSteps++;
      return true;
    }
    return false;
  }
  if (_clickWheelNavSteps > 0 && _pageDivider !== null) return false;   // parked on the transition page
  const chW = _chapters[_chapterAt(currentPage)];
  const rawN = currentPage + dir * step;
  const crossing = chW ? (rawN > chW.start + chW.count || rawN < chW.start + 1) : false;
  if (_clickWheelNavSteps > 0 && crossing && !(_chapterDividersOn && _series)) return false;
  if (Math.max(1, Math.min(pages.length, rawN)) === currentPage && !crossing) return false;
  goTo(rawN);   // raw target — the intercept can show the transition page at the boundary
  _clickWheelNavSteps++;
  return true;
}

function _isClickWheelNavTarget(target) {
  return !target.closest('button, a, input, textarea, select, [contenteditable]');
}

viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.isPrimary) return;
  if (!_isClickWheelNavTarget(e.target)) return;
  clearTimeout(_clickWheelNavClearTimer);
  _clickWheelNavHeld = true;
  _clickWheelNavUsed = false;
  _clickWheelNavDelta = 0;
  _clickWheelNavSteps = 0;
  _clickWheelNavPage = mode === 'strip' ? currentPage : null;
}, true);

viewport.addEventListener('click', (e) => {
  if (!_clickWheelNavUsed) return;
  _clickWheelNavUsed = false;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

window.addEventListener('wheel', (e) => {
  if (!_clickWheelNavHeld || (e.buttons !== 0 && !(e.buttons & 1))) return;
  const delta = _eventDominantWheelDelta(e);
  if (!delta) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  _clickWheelNavUsed = true;
  _clickWheelNavDelta += delta;
  if (Math.abs(_clickWheelNavDelta) < CLICK_WHEEL_NAV_THRESHOLD) return;
  const dir = _clickWheelNavDelta > 0 ? 1 : -1;
  _clickWheelNavDelta = 0;
  _clickWheelPageNav(dir);
}, { passive: false, capture: true });

document.addEventListener('pointerup', _endClickWheelNav);
document.addEventListener('pointercancel', _endClickWheelNav);
window.addEventListener('blur', _endClickWheelNav);
document.addEventListener('visibilitychange', () => { if (document.hidden) _endClickWheelNav(); });

function _physicalPageDelta(side, amount) {
  const forward = readerDirection === 'rtl' ? side === 'left' : side === 'right';
  return forward ? amount : -amount;
}

// Physical click zones follow the selected reading direction.
clickPrev.addEventListener('click', () => goTo(currentPage + _physicalPageDelta('left', 1)));
clickNext.addEventListener('click', () => goTo(currentPage + _physicalPageDelta('right', 1)));

// Double click zones
dClickPrev.addEventListener('click', () => goTo(currentPage + _physicalPageDelta('left', 2)));
dClickNext.addEventListener('click', () => goTo(currentPage + _physicalPageDelta('right', 2)));

// Scrubber — chapter-relative: its range is the current chapter, so the value maps onto the
// chapter's slice of the merged page list.
scrubber.addEventListener('input', () => {
  const ch = _chapters[_chapterAt(currentPage)];
  const n = (ch ? ch.start : 0) + parseInt(scrubber.value);
  if (mode === 'strip') _scrollStripToPage(n);
  else goTo(n, true);   // absolute jump — never show the transition page
});

// Release focus after scrubbing so the keydown guard (which ignores keys aimed at the scrubber)
// stops swallowing every navigation keybind once the slider has been touched.
scrubber.addEventListener('pointerup', () => scrubber.blur());
scrubber.addEventListener('change', () => scrubber.blur());

// Reading-mode segmented toggle: each square selects its mode; the indicator slides across.
function _updateModeToggle() {
  modeToggle.dataset.state = mode;
  modeSingle.classList.toggle('active', mode === 'single');
  modeDouble.classList.toggle('active', mode === 'double');
  modeStrip.classList.toggle('active', mode === 'strip');
}
modeSingle.addEventListener('click', () => setMode('single'));
modeDouble.addEventListener('click', () => setMode('double'));
modeStrip.addEventListener('click', () => setMode('strip'));

// Scroll-to-top button
scrollTopBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
window.addEventListener('scroll', () => {
  scrollTopBtn.classList.toggle('visible', mode === 'strip' && window.scrollY > 400);
  if (mode === 'strip' && !_thumbDragging) {
    // A page scroll makes the strip follow the page, so it owns scrollLeft now — kill any in-flight
    // wheel glide, or the two writers fight each other every frame and the follow jitters.
    if (_wheelRaf) { cancelAnimationFrame(_wheelRaf); _wheelRaf = null; _wheelTarget = null; }
    // One proportion drives everything: the current page (counter + active-thumb border) and the
    // fill indicator, so the border tracks the fill. This listener fires every frame (unlike the
    // page-crossing observer), so a programmatic jump settles on the right page on its own.
    const p = _scrollYToProportion(window.scrollY + _pinOffset());
    _setCurrentPageFromProportion(p);
    _scheduleStripSync();   // keep the virtualized window aimed at the reading line
    if (thumbsOpen) _setIndicator(p);
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

// Seamless variant switch: re-point the on-screen pages at the current variant in place —
// decoded first so nothing blanks, keeping each page's measured size and the scroll position.
// Both variants stay cached (keyed per variant), so toggling back is instant.
function _swapVisibleVariant() {
  if (mode === 'strip') {
    _syncStripWindow(true);
  } else if (mode === 'single') {
    _swapImg(mainImg, pages[currentPage - 1]);
  } else if (mode === 'double') {
    _swapImg(imgLeft, pages[currentPage - 1]);
    const rPage = _rightPageForSpread(currentPage);
    if (rPage) _swapImg(imgRight, rPage);
  }
}

// ── Translate ⇄ Study view (one segmented toggle, mutually exclusive or both off) ──
// 'translate' = full translated page · 'study' = clean original + revealable bubbles · 'off' =
// clean original. Exactly one of translateView/studyMode is true, or neither.
function setView(target) {
  if (target === 'study' && !hasStudy) target = 'off';
  if (target === 'translate' && !_translateAvailable) target = 'off';
  studyMode     = target === 'study';
  translateView = target === 'translate';
  document.body.classList.toggle('study-mode', studyMode);
  _swapVisibleVariant();      // re-point images to the right variant (study forces original)
  _refreshBubbleLayers();     // builds overlays when studyMode, tears them down otherwise
  _updateViewToggle();
  platform.kv.set({ readerView: target });
}

// Reflect the current view on the segmented toggle (slides the indicator + tooltips).
function _updateViewToggle() {
  const state = studyMode ? 'study' : (translateView ? 'translate' : 'off');
  // Appearing from off: jump the indicator to its side then fade in (no slide). data-pos holds
  // the transform position even while off, so turning off fades the indicator IN PLACE rather
  // than sliding it back to the first segment.
  viewToggle.classList.toggle('no-slide', viewToggle.dataset.state === 'off');
  if (state !== 'off') viewToggle.dataset.pos = state;
  viewToggle.dataset.state = state;
  translateSeg.classList.toggle('active', translateView);
  studySeg.classList.toggle('active', studyMode);
  translateSeg.dataset.tip = translateView ? t('rd.tip_translate_on') : t('rd.tip_translate');
  studySeg.dataset.tip     = studyMode ? t('rd.tip_study_on') : t('rd.tip_study');
}

// Click a side to turn it on (and the other off); click the active side again to turn it off.
translateSeg.addEventListener('click', () => setView(translateView ? 'off' : 'translate'));
studySeg.addEventListener('click', () => { if (hasStudy) setView(studyMode ? 'off' : 'study'); });

// ── Study mode: reveal translated bubbles one at a time over the clean original ──
function _ensureWrap(imgEl) {
  const parent = imgEl.parentElement;
  if (parent && parent.classList.contains('page-wrap')) return parent;
  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  const ratio = imgEl.style.getPropertyValue('--page-ratio');
  if (ratio) wrap.style.setProperty('--page-ratio', ratio);
  imgEl.replaceWith(wrap);
  wrap.appendChild(imgEl);
  return wrap;
}

// Drop every bubble layer and free the page layers' object URLs.
function _removeBubbleLayers() {
  document.querySelectorAll('.bubble-layer').forEach(l => { if (l._ro) l._ro.disconnect(); l.remove(); });
  for (const u of _pageLayerUrls.values()) {
    try { if (u.bgUrl) URL.revokeObjectURL(u.bgUrl); (u.textUrls || []).forEach(t => t && URL.revokeObjectURL(t)); } catch {}
  }
  _pageLayerUrls.clear();
  document.body.classList.remove('study-bubbles-active');
}

function _releaseLayerUrls(pageUrl) {
  const u = _pageLayerUrls.get(pageUrl);
  if (!u) return;
  try {
    if (u.bgUrl) URL.revokeObjectURL(u.bgUrl);
    (u.textUrls || []).forEach(t => t && URL.revokeObjectURL(t));
  } catch {}
  _pageLayerUrls.delete(pageUrl);
}

function _removeWrapBubbleLayer(wrap) {
  const layer = wrap && wrap.querySelector(':scope > .bubble-layer');
  if (layer) { if (layer._ro) layer._ro.disconnect(); layer.remove(); }
  const pageNum = parseInt(wrap?.dataset?.page, 10);
  const page = pages[pageNum - 1];
  if (page) _releaseLayerUrls(page.url);
}

// Object URLs for a page's study layers: one shared bg + one per bubble text, created once.
function _layerUrls(pageUrl) {
  let u = _pageLayerUrls.get(pageUrl);
  if (u) return u;
  const study = _pageStudy.get(pageUrl);
  if (!study) return null;
  u = {
    bgUrl:    study.bg ? URL.createObjectURL(study.bg) : '',
    textUrls: study.bubbles.map(b => (b.text ? URL.createObjectURL(b.text) : '')),
  };
  _pageLayerUrls.set(pageUrl, u);
  return u;
}

// CSS clip-path inset that exposes only region r of a full-page (100%) layer image.
function _clipInset(r) {
  const top = r.y * 100, left = r.x * 100;
  const right = (1 - (r.x + r.w)) * 100, bottom = (1 - (r.y + r.h)) * 100;
  return `inset(${top}% ${right}% ${bottom}% ${left}%)`;
}

// A DOM-text block for one bubble's translation, positioned at the rect the renderer actually
// drew its glyph canvas at (tbox; older records fall back to the layout box) and scaled with
// the page via the layer's --pgscale. Style comes from the stored renderer hints; anything
// missing falls back to a deterministic reader style (never inferred from the image).
function _buildStudyText(b, hasBg, pageW) {
  if (!b.tr) return null;
  const r = b.tbox || b.rbox || b.region || b.box;
  const el = document.createElement('div');
  el.className = 'study-text' + (hasBg ? '' : ' boxed');
  el.style.left   = (r.x * 100) + '%';
  el.style.top    = (r.y * 100) + '%';
  el.style.width  = (r.w * 100) + '%';
  el.style.height = (r.h * 100) + '%';
  const st = b.style || {};
  el.style.setProperty('--fs', (st.fontSize || Math.max(12, Math.round((pageW || 1000) * 0.022))) + 'px');
  if (Array.isArray(st.fg)) el.style.color = `rgb(${st.fg.join(',')})`;
  // Outline in the OCR bg colour, em-sized so it scales with the text like the renderer's
  // border does (8 directions ≈ a solid ring).
  if (Array.isArray(st.fg) && Array.isArray(st.bg)) {
    const o = `rgb(${st.bg.join(',')})`;
    el.style.textShadow =
      `-0.06em -0.06em 0 ${o}, 0.06em -0.06em 0 ${o}, -0.06em 0.06em 0 ${o}, 0.06em 0.06em 0 ${o}, ` +
      `-0.08em 0 0 ${o}, 0.08em 0 0 ${o}, 0 -0.08em 0 ${o}, 0 0.08em 0 ${o}`;
  }
  // manga2eng typesets in comic caps with a tight line advance — mirror both, then prefer the
  // exact pitch the renderer drew at when the pipeline recorded it.
  if (st.caps) { el.style.textTransform = 'uppercase'; el.style.lineHeight = '1.0'; }
  if (st.lineH) el.style.lineHeight = String(st.lineH);
  if (st.align === 'left' || st.align === 'right') el.style.textAlign = st.align;
  // Renderer-preserved line breaks live directly in `tr`; pre-wrap keeps them while still
  // allowing a safe additional wrap if browser font metrics need one.
  const body = document.createElement('span');
  body.className = 'study-text-content';
  body.textContent = b.tr;
  el.appendChild(body);
  return el;
}

// The bubble's ORIGINAL text as DOM text, typeset like the source. OCR line breaks live directly
// in `src`; native horizontal/vertical flow lays them out as rows or right-to-left columns.
// Optional <ruby> furigana comes from the pipeline's per-line segments.
function _buildStudySrc(b, hasBg, pg, srcOpts) {
  const srcText = String(b.src || '').trim();
  if (!srcText) return null;
  const st = b.style || {};
  const vertical = String(st.dir || '').startsWith('v');
  const lines = srcText.split(/\r?\n/);
  const furi = (srcOpts && srcOpts.furi && Array.isArray(b.furi) && b.furi.length === lines.length) ? b.furi : null;

  // In vertical CJK text, leave native scripts and punctuation to Unicode's mixed orientation.
  // Stand isolated letters upright, along with numbers and symbols such as a percent sign;
  // multi-letter horizontal-script words keep their normal sideways run.
  const appendText = (target, text) => {
    if (!vertical) { target.appendChild(document.createTextNode(text)); return; }
    const nativeVertical = /^(?:\p{Script_Extensions=Han}|\p{Script_Extensions=Hiragana}|\p{Script_Extensions=Katakana}|\p{Script_Extensions=Hangul}|\p{Script_Extensions=Bopomofo}|\p{Script_Extensions=Mongolian})$/u;
    const letter = /^\p{Letter}$/u;
    const mark = /^\p{Mark}$/u;
    const numberOrSymbol = /^(?:\p{Number}|\p{Symbol}|[%％])$/u;
    let run = '';
    let runType = null;
    let letterCount = 0;
    const flush = () => {
      if (!run) return;
      if (runType === 'upright' || (runType === 'letter' && letterCount === 1)) {
        const upright = document.createElement('span');
        upright.className = 'study-upright';
        upright.textContent = run;
        target.appendChild(upright);
      } else {
        target.appendChild(document.createTextNode(run));
      }
      run = '';
      runType = null;
      letterCount = 0;
    };
    for (const glyph of text) {
      let type = 'plain';
      if (mark.test(glyph) && runType) type = runType;
      else if (!nativeVertical.test(glyph) && letter.test(glyph)) type = 'letter';
      else if (numberOrSymbol.test(glyph)) type = 'upright';
      if (runType !== null && type !== runType) flush();
      runType = type;
      run += glyph;
      if (type === 'letter' && letter.test(glyph)) letterCount++;
    }
    flush();
  };

  // Fill one line's content (plain text or ruby-annotated segments) into `target`.
  const lineContent = (target, i) => {
    const segs = furi && Array.isArray(furi[i]) ? furi[i] : null;
    if (!segs) { appendText(target, lines[i]); return; }
    for (const seg of segs) {
      if (!seg || !seg[0]) continue;
      if (seg[1]) {
        const ruby = document.createElement('ruby');
        appendText(ruby, seg[0]);
        const rt = document.createElement('rt');
        rt.textContent = seg[1];
        ruby.appendChild(rt);
        target.appendChild(ruby);
      } else {
        appendText(target, seg[0]);
      }
    }
  };

  const r = b.box || b.region;
  const el = document.createElement('div');
  el.className = 'study-text src' + (hasBg ? '' : ' boxed') + (studySrcFont === 'kiwi' ? ' font-kiwi' : '');
  if (furi) el.classList.add('with-ruby');
  el.style.left   = (r.x * 100) + '%';
  el.style.top    = (r.y * 100) + '%';
  el.style.width  = (r.w * 100) + '%';
  el.style.height = (r.h * 100) + '%';
  if (Array.isArray(st.fg)) el.style.color = `rgb(${st.fg.join(',')})`;
  if (Array.isArray(st.fg) && Array.isArray(st.bg)) {
    const o = `rgb(${st.bg.join(',')})`;
    el.style.textShadow =
      `-0.06em -0.06em 0 ${o}, 0.06em -0.06em 0 ${o}, -0.06em 0.06em 0 ${o}, 0.06em 0.06em 0 ${o}, ` +
      `-0.08em 0 0 ${o}, 0.08em 0 0 ${o}, 0 -0.08em 0 ${o}, 0 0.08em 0 ${o}`;
  }
  // Language drives the appropriate Han glyph forms when source metadata identifies it.
  if (srcOpts && srcOpts.lang) el.lang = srcOpts.lang;
  if (vertical) el.classList.add('vert');
  el.style.setProperty('--fs', (st.srcFontSize || st.fontSize || Math.max(12, Math.round(((pg && pg.w) || 1000) * 0.022))) + 'px');
  const body = document.createElement('span');
  body.className = 'study-src-body study-text-content';
  lines.forEach((ln, i) => {
    const line = document.createElement('span');
    line.className = 'study-src-line';
    lineContent(line, i);
    body.appendChild(line);
    if (i < lines.length - 1) body.appendChild(document.createElement('br'));
  });
  el.appendChild(body);
  return el;
}

// Original-as-text display (Settings → Reader): a bubble opens ALREADY revealed — the
// inpainted bg with the ORIGINAL text on top as DOM text — and clicking cycles it between the
// original and the translation (DOM text or the typeset PNG, per the translation display
// setting). DOM text stays selectable; a plain click with no selection cycles it. Escape returns
// every bubble to its original text.
function _studySourceRect(b) {
  return b.box || b.region;
}

function _studyTranslationRect(b) {
  return b.tbox || b.rbox || b.region || b.box;
}

function _positionBubbleIndicator(box, r) {
  if (!box || !r) return;
  box.style.left   = (r.x * 100) + '%';
  box.style.top    = (r.y * 100) + '%';
  box.style.width  = (r.w * 100) + '%';
  box.style.height = (r.h * 100) + '%';
}

function _wireSelectableText(el, onPlainClick) {
  if (!el || !el.classList.contains('study-text')) return false;
  const content = el.querySelector('.study-text-content');
  if (!content) return false;
  content.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.shiftKey) return;
    if (!String(window.getSelection() || '')) onPlainClick();
  });
  return true;
}

function _setStudyTextSelectable(selectable) {
  document.body.classList.toggle('study-text-selecting', !!selectable);
}

function _mountTextBubble(box, b, idx, pageUrl, bgLayer, fgLayer, pg, srcOpts, hasPageBg) {
  const urls = _layerUrls(pageUrl);
  const hasBg = !!(urls && urls.bgUrl);
  if (hasBg && !hasPageBg) {
    const clip = _clipInset(b.region);
    const bg = document.createElement('img');
    bg.className = 'study-layer-img'; bg.src = urls.bgUrl;
    bg.decoding = 'async'; bg.loading = 'lazy';
    bg.style.clipPath = clip; bg.style.webkitClipPath = clip;
    bgLayer.appendChild(bg);
  }
  const srcEl = _buildStudySrc(b, hasBg, pg, srcOpts);
  let trEl;
  if (studyDisplay !== 'text' && urls && urls.textUrls[idx]) {
    trEl = document.createElement('img');
    trEl.className = 'study-layer-img'; trEl.src = urls.textUrls[idx];
    trEl.decoding = 'async'; trEl.loading = 'lazy';
  } else {
    trEl = _buildStudyText(b, hasBg, pg && pg.w);
  }
  if (!srcEl && !trEl) return;
  const srcIsText = !!srcEl && srcEl.classList.contains('study-text');
  const trIsText  = !!trEl && trEl.classList.contains('study-text');
  const setState = (showTr) => {
    const visibleIsText = showTr ? trIsText : srcIsText;
    const visibleRect = showTr ? _studyTranslationRect(b) : _studySourceRect(b);
    // DOM text owns its visible hover treatment. Keep the broader replacement region beneath it
    // as an invisible pointer/click target for the empty area surrounding the text itself.
    _positionBubbleIndicator(box, visibleIsText ? (b.region || visibleRect) : visibleRect);
    if (srcEl) srcEl.style.display = showTr ? 'none' : '';
    if (trEl)  trEl.style.display  = showTr ? '' : 'none';
    box.classList.toggle('revealed', showTr && !!srcEl);
    box.classList.toggle('text-revealed', showTr ? trIsText : srcIsText);
  };
  if (srcEl) fgLayer.appendChild(srcEl);
  if (trEl)  fgLayer.appendChild(trEl);

  // Incomplete OCR records can contain only one side. Keep that side visible and static instead
  // of cycling to a blank state or trapping Escape in a permanent "revealed" state.
  if (!srcEl || !trEl) {
    setState(!!trEl);
    box.classList.remove('revealed');
    if (!(srcIsText || trIsText)) box.style.pointerEvents = 'none';
    return;
  }

  _wireSelectableText(srcEl, () => setState(true));
  _wireSelectableText(trEl,  () => setState(false));
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    setState(!box.classList.contains('revealed'));
  });
  setState(false);
  box._reset = () => setState(false);
}

// Reveal/hide one bubble when the ORIGINAL displays as the untouched page (original-as-text
// mounts everything up front in _mountTextBubble instead). The shared bg is clipped to the
// bubble's region (covering the Japanese + the full English) into the bg sub-layer (below);
// the bubble's OWN full-page text PNG goes unclipped into the fg sub-layer (above). Both are
// the page at 100% of the wrap, so they stay pixel-aligned at any zoom, the text is never
// cropped, and overlapping bubbles never let one's background cover another's text. The
// translation shows as DOM text instead when set so (Settings → Reader) or when the bubble
// has no stored text PNG.
function _toggleBubble(e, box, b, idx, pageUrl, bgLayer, fgLayer) {
  e.stopPropagation();
  const on = box.classList.toggle('revealed');
  _positionBubbleIndicator(box, on ? _studyTranslationRect(b) : _studySourceRect(b));
  if (on) {
    if (!box._layers) {
      const study = _pageStudy.get(pageUrl);
      const urls = _layerUrls(pageUrl);
      const els = [];
      if (urls && urls.bgUrl) {
        const clip = _clipInset(b.region);
        const bg = document.createElement('img');
        bg.className = 'study-layer-img'; bg.src = urls.bgUrl;
        bg.style.clipPath = clip; bg.style.webkitClipPath = clip;
        bgLayer.appendChild(bg); els.push(bg);
      }
      const asText = studyDisplay === 'text' || !(urls && urls.textUrls[idx]);
      if (asText) {
        const wrap = fgLayer.closest('.page-wrap');
        const pageW = (study && study.page && study.page.w) ||
                      (wrap && wrap.querySelector('img')?.naturalWidth) || 0;
        const tx = _buildStudyText(b, !!(urls && urls.bgUrl), pageW);
        if (!tx) {
          els.forEach(el => el.remove());
          box.classList.remove('revealed');
          _positionBubbleIndicator(box, _studySourceRect(b));
          return;
        }
        _wireSelectableText(tx, () => box.click());
        fgLayer.appendChild(tx); els.push(tx);
      } else {
        const tx = document.createElement('img');
        tx.className = 'study-layer-img'; tx.src = urls.textUrls[idx];
        fgLayer.appendChild(tx); els.push(tx);
      }
      if (!els.length) {
        box.classList.remove('revealed');
        _positionBubbleIndicator(box, _studySourceRect(b));
        return;
      }
      box._layers = els;
      box._isText = asText;
    } else {
      box._layers.forEach(el => { el.style.display = ''; });
    }
    if (box._isText) {
      box.classList.add('text-revealed');
      _positionBubbleIndicator(box, b.region || _studyTranslationRect(b));
    }
  } else if (box._layers) {
    box._layers.forEach(el => { el.style.display = 'none'; });
    box.classList.remove('text-revealed');
  }
}

// Set the source language when metadata identifies Japanese or Chinese so the browser chooses
// the appropriate Han glyph forms. Furigana remains Japanese-only.
function _sourceTextLang(meta) {
  if (!meta) return '';
  const values = [];
  for (const tags of [meta.tags, meta.seriesTags]) {
    if (Array.isArray(tags)) {
      for (const tg of tags) if (tg && tg.type === 'language') values.push(String(tg.name || ''));
    }
  }
  values.push(String(meta.sourceMetadata?.language || ''));
  const language = values.join(' ');
  if (/(^|\W)(japanese|ja|jpn)(\W|$)/i.test(language)) return 'ja';
  if (/chinese\s*\(traditional\)|traditional\s+chinese|zh[-_](tw|hant)/i.test(language)) return 'zh-Hant';
  if (/chinese\s*\(simplified\)|simplified\s+chinese|zh[-_](cn|hans)/i.test(language)) return 'zh-Hans';
  if (/(^|\W)(chinese|zh|zho)(\W|$)/i.test(language)) return 'zh';
  return '';
}

// Build one page's overlay: a bg sub-layer, a text sub-layer, and the clickable boxes on top.
// Each hover/click indicator follows whichever source or translation region is currently visible
// and is positioned by page fraction (percent), so it tracks zoom/resize with no recompute.
function _renderBubbleLayer(wrap, pageNum) {
  const page = pages[pageNum - 1];
  if (!page) return;
  const study = _pageStudy.get(page.url);
  const hasBubbles = !!study && Array.isArray(study.bubbles) && study.bubbles.length > 0;
  if (!hasBubbles && mode === 'strip') return;
  const layer = document.createElement('div');
  layer.className = 'bubble-layer';
  const bgLayer = document.createElement('div'); bgLayer.className = 'bubble-bg';
  const fgLayer = document.createElement('div'); fgLayer.className = 'bubble-fg';
  layer.appendChild(bgLayer);
  layer.appendChild(fgLayer);
  // DOM-text bubbles size their font in page pixels × --pgscale (wrap width ÷ page width),
  // so they track zoom/resize exactly like the image layers do.
  const pageW = (study?.page && study.page.w) || wrap.querySelector('img')?.naturalWidth || 0;
  if (pageW) {
    const sync = () => layer.style.setProperty('--pgscale', String((wrap.clientWidth / pageW) || 1));
    sync();
    layer._ro = new ResizeObserver(sync);
    layer._ro.observe(wrap);
  }
  // Page-flip zones under the bubbles (page modes only): click a bubble to reveal it, click
  // anywhere else on the page to turn the page — restoring the side-click navigation that the
  // fixed click-zones provide outside study mode. Strip mode scrolls instead.
  if (mode !== 'strip') {
    const nav = document.createElement('div'); nav.className = 'bubble-nav';
    const zone = (handler) => { const z = document.createElement('div'); z.addEventListener('click', handler); return z; };
    if (mode === 'single') {
      nav.append(zone(() => goTo(currentPage - 1)), zone(() => goTo(currentPage + 1)));
    } else {              // double: this page turns the whole spread (left → back, right → forward)
      nav.append(zone(() => goTo(currentPage + (pageNum <= currentPage ? -2 : 2))));
    }
    layer.appendChild(nav);
  }
  if (!hasBubbles) { wrap.appendChild(layer); return; }
  // Original-as-text mounts every bubble open on its original text; original-as-image keeps
  // the untouched page and the click-to-reveal flow.
  const origText = studyOriginal === 'text';
  const srcLang = origText ? _sourceTextLang(_chapters[_chapterAt(pageNum)]?.meta) : '';
  const srcOpts = { lang: srcLang, furi: furiganaOn && srcLang === 'ja' };
  // When both sides are selectable text, the cleaned Study image is the page background. One
  // full-page layer is both cheaper and more accurate than stacking one clipped copy per bubble.
  const urls = origText && studyDisplay === 'text' ? _layerUrls(page.url) : null;
  const hasPageBg = !!(urls && urls.bgUrl);
  if (hasPageBg) {
    const bg = document.createElement('img');
    bg.className = 'study-layer-img study-page-bg';
    bg.src = urls.bgUrl;
    bg.alt = '';
    bg.decoding = 'async';
    bg.draggable = false;
    bgLayer.appendChild(bg);
  }
  study.bubbles.forEach((b, i) => {
    const box = document.createElement('div');
    box.className   = 'bubble-box';
    _positionBubbleIndicator(box, _studySourceRect(b));
    if (origText) {
      _mountTextBubble(box, b, i, page.url, bgLayer, fgLayer, (study.page || { w: pageW }), srcOpts, hasPageBg);
    } else {
      box.addEventListener('click', (e) => _toggleBubble(e, box, b, i, page.url, bgLayer, fgLayer));
      box._reset = () => {
        box.classList.remove('revealed', 'text-revealed');
        (box._layers || []).forEach(el => { el.style.display = 'none'; });
        _positionBubbleIndicator(box, _studySourceRect(b));
      };
    }
    layer.appendChild(box);
  });
  wrap.appendChild(layer);
}

// Rebuild the overlays for whichever page images are mounted in the current view.
function _refreshBubbleLayers() {
  _removeBubbleLayers();
  if (!studyMode) return;
  if (mode === 'strip') {
    const center = currentPage - _viewBase;   // local, 1-based
    for (const idx of _mountedIdx) {
      if (Math.abs(idx + 1 - center) > MOUNT_AHEAD) continue;
      const wrap = _stripWraps[idx];
      if (wrap) _renderBubbleLayer(wrap, parseInt(wrap.dataset.page));
    }
  } else if (mode === 'single') {
    _renderBubbleLayer(_ensureWrap(mainImg), currentPage);
  } else if (mode === 'double') {
    _renderBubbleLayer(_ensureWrap(imgLeft), currentPage);
    if (_rightPageForSpread(currentPage)) _renderBubbleLayer(_ensureWrap(imgRight), currentPage + 1);
  }
  document.body.classList.toggle('study-bubbles-active', mode !== 'strip' && !!document.querySelector('.bubble-box'));
}

// Keybind modal
keybindBtn.addEventListener('click', () => setKeybindOpen(!keybindModal.classList.contains('show')));
keybindModal.addEventListener('click', (e) => {
  if (!e.target.closest('#keybindBox')) setKeybindOpen(false);
});

function _readerZoomScale() {
  if (readerFitMode === 'off') return Math.min(mode === 'strip' ? 1 : ZOOM_MAX, _pageZoom);
  return readerFitMode === 'height' ? _currentFitWidthFraction() : readerFitMaxWidth;
}

function _syncReaderSettingsUI() {
  if (!readerSettingsBox) return;
  readerSettingsBox.querySelectorAll('[data-reader-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.readerMode === mode);
  });
  readerSettingsBox.querySelectorAll('[data-reader-direction]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.readerDirection === readerDirection);
  });
  readerSettingsBox.querySelectorAll('[data-progress-position]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.progressPosition === readerProgressPosition);
  });
  readerSettingsBox.querySelectorAll('[data-reader-fit]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.readerFit === readerFitMode);
  });
  readerDirectionGroup.hidden = mode === 'strip';
  readerGap.value = readerPageGap;
  readerGapValue.textContent = `${readerPageGap} px`;
  const scale = _readerZoomScale();
  readerZoomValue.textContent = `${Math.round(scale * 100)}%`;
  readerZoomOut.disabled = scale <= ZOOM_MIN + .001;
  readerZoomIn.disabled = scale >= (mode === 'strip' ? 1 : ZOOM_MAX) - .001;
}

function setReaderSettingsOpen(open) {
  readerSettingsModal.classList.toggle('show', open);
  readerSettingsBtn.classList.toggle('active', open);
  if (open) {
    setKeybindOpen(false);
    _syncReaderSettingsUI();
    readerSettingsClose.focus();
  } else if (document.activeElement && readerSettingsModal.contains(document.activeElement)) {
    readerSettingsBtn.focus();
  }
}

readerSettingsBtn.addEventListener('click', () => setReaderSettingsOpen(!readerSettingsModal.classList.contains('show')));
readerSettingsClose.addEventListener('click', () => setReaderSettingsOpen(false));
readerSettingsModal.addEventListener('click', (e) => {
  if (!e.target.closest('#readerSettingsBox')) setReaderSettingsOpen(false);
});
readerSettingsBox.addEventListener('click', (e) => {
  const modeBtn = e.target.closest('[data-reader-mode]');
  if (modeBtn) { setMode(modeBtn.dataset.readerMode); return; }
  const directionBtn = e.target.closest('[data-reader-direction]');
  if (directionBtn) { _applyReaderDirection(directionBtn.dataset.readerDirection); return; }
  const progressBtn = e.target.closest('[data-progress-position]');
  if (progressBtn) { _applyReaderProgressPosition(progressBtn.dataset.progressPosition); return; }
  const fitBtn = e.target.closest('[data-reader-fit]');
  if (fitBtn) {
    const next = fitBtn.dataset.readerFit;
    if (next === 'off') {
      _applyReaderFitMode('off');
      _applyPageZoom(1);
    } else {
      void (next === 'width' ? fitPageWidth() : fitPageHeight()).then(_syncReaderSettingsUI);
    }
  }
});
readerGap.addEventListener('input', () => _applyReaderPageGap(readerGap.value));
readerZoomOut.addEventListener('click', () => adjustPageZoom(-1));
readerZoomIn.addEventListener('click', () => adjustPageZoom(1));

readerPinBtn.addEventListener('click', () => applyReaderPin(!readerPinned));

// Measure the OS scrollbar width once and expose it as --sbw. The topbar reserves this much
// extra right padding and gives it back (via a 100vw − 100% calc) exactly when a page scrollbar
// is present, so the right-hand controls hold the same position whether or not one is showing.
(function measureScrollbar() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll';
  document.body.appendChild(probe);
  document.documentElement.style.setProperty('--sbw', (probe.offsetWidth - probe.clientWidth) + 'px');
  probe.remove();
})();

// Reflect whether a vertical page scrollbar is currently present (its width is what would shift
// the right-hand controls). Observing the document element catches both window resizes and the
// scrollbar appearing/disappearing as content height changes.
const _syncVScroll = () => topbar.classList.toggle('has-vscroll', window.innerWidth - document.documentElement.clientWidth > 1);
new ResizeObserver(_syncVScroll).observe(document.documentElement);
_syncVScroll();

// ── Responsive navbar: fold controls into a ⋯ menu, in stages, as the bar runs out of room ──
// Stage 1 folds the secondary buttons (.tb-extra) so the title can start to ellipsize; stage 2
// additionally folds the translate ⇄ study toggle, but only once the title is fully used up. The
// reading-mode toggle, page counter and gallery # never fold (the # only clips as a last resort).
const tbMenuBtn = document.getElementById('tbMenuBtn');
const tbExtra   = topbar.querySelector('.tb-extra');
const tbSpacer  = topbar.querySelector('.tb-spacer');
// The translate ⇄ study toggle normally sits in the bar; at stage 2 it folds into the ⋯ panel (as a
// .tb-extra child, so the existing menu styling carries it) and returns to the bar when there's room.
const _viewToBar  = () => { if (viewToggle.parentElement === tbExtra) topbar.insertBefore(viewToggle, tbExtra); };
const _viewToMenu = () => { if (viewToggle.parentElement !== tbExtra) tbExtra.insertBefore(viewToggle, tbExtra.firstChild); };

// Stage 1 is driven by a @container query, not a resize callback. _recomputeFold measures the bar's
// natural width — the container width at which the gap (spacer) closes — and bakes it into the query.
// The layout engine then evaluates the fold every frame, in the same pass as the resize, so the
// buttons fold the instant the gap hits zero even mid-drag: the title never flashes an ellipsis.
// It's content-, not width-, dependent, so it only needs to re-run when the title/toggle/font change.
const _foldStyle = document.head.appendChild(document.createElement('style'));
function _recomputeFold() {
  // Measure with the bar fully expanded and the gap collapsed, so the children pack to the left and
  // the rightmost one's edge marks the natural content width = the breakpoint (a @container width is
  // the content box, so this px maps straight onto it). Brief inline overrides, no paint in between.
  _viewToBar();
  const ov = { ex: tbExtra.style.display, mn: tbMenuBtn.style.display, ms: tbMeta.style.flexShrink, sp: tbSpacer.style.flex };
  tbExtra.style.display = 'flex'; tbMenuBtn.style.display = 'none';   // secondary buttons shown, ⋯ hidden
  tbMeta.style.flexShrink = '0';                                      // title at full width
  tbSpacer.style.flex = '0 0 0';                                      // gap closed → children packed
  void topbar.offsetWidth;
  const contentLeft = topbar.getBoundingClientRect().left + (parseFloat(getComputedStyle(topbar).paddingLeft) || 0);
  const w = Math.ceil(tbExtra.getBoundingClientRect().right - contentLeft);
  tbExtra.style.display = ov.ex; tbMenuBtn.style.display = ov.mn; tbMeta.style.flexShrink = ov.ms; tbSpacer.style.flex = ov.sp;
  _foldStyle.textContent = `@container rbar (max-width:${w}px){#topbar .tb-extra{display:none}#topbar .tb-menu-btn{display:inline-flex}}`;
  _layoutStage2();
}

let _tbBusy = false;
function _layoutStage2() {
  // Only stage 2 (and menu-open cleanup) lives in JS now; a frame of lag here can't flash the title,
  // because by the time the # is in play the title is already fully spent.
  if (_tbBusy) return;                                               // re-entrancy guard
  _tbBusy = true;
  const folded  = getComputedStyle(tbMenuBtn).display !== 'none';    // stage 1 active (set by the query)
  const idClips = () => tbGallery.getBoundingClientRect().right > tbMeta.getBoundingClientRect().right + 0.5;
  if (!folded) topbar.classList.remove('menu-open');                 // grew back past the fold → drop stale panel
  _viewToBar();                                                      // baseline: toggle in the bar
  if (folded && idClips()) _viewToMenu();                            // title spent & # would clip → fold the toggle
  _tbBusy = false;
}
tbMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); topbar.classList.toggle('menu-open'); });
document.addEventListener('click', () => topbar.classList.remove('menu-open'));
new ResizeObserver(_layoutStage2).observe(topbar);
window.addEventListener('resize', _layoutStage2);
// The breakpoint shifts only when the bar's natural width does: re-measure once the web font lands,
// and whenever the page counter changes width (a new digit) — it's flex-shrink:0, so this RO never
// fires on a plain window resize, keeping the recompute off the resize path.
document.fonts?.ready.then(_recomputeFold);
new ResizeObserver(_recomputeFold).observe(document.getElementById('pageCounter'));

// ── Page zoom (+/-) ──
const ZOOM_MIN = 0.4, ZOOM_MAX = 3, ZOOM_STEP = 0.1;
const FIT_WIDTH_MIN = 0.1, FIT_WIDTH_MAX = 1, FIT_WIDTH_STEP = 0.05;
function _applyReaderFitMaxWidth(next, persist = true) {
  readerFitMaxWidth = Math.round(Math.max(FIT_WIDTH_MIN, Math.min(FIT_WIDTH_MAX, next)) * 100) / 100;
  document.documentElement.style.setProperty('--reader-fit-max-width', `${Math.round(readerFitMaxWidth * 100)}%`);
  if (persist) platform.kv.set({ readerFitMaxWidth });
  _syncReaderSettingsUI();
}
function _applyReaderFitMode(next, persist = true, resetMaxWidth = false) {
  if (next !== 'width' && next !== 'height') next = 'off';
  readerFitMode = next;
  document.body.classList.toggle('reader-fit-width', next === 'width');
  document.body.classList.toggle('reader-fit-height', next === 'height');
  if (next !== 'off' && resetMaxWidth) _applyReaderFitMaxWidth(FIT_WIDTH_MAX, persist);
  if (persist) platform.kv.set({ readerFitMode: next });
  _syncReaderSettingsUI();
}
function _clearReaderFitMode() {
  if (readerFitMode !== 'off') _applyReaderFitMode('off');
}
function adjustFitMaxWidth(delta) {
  if (readerFitMode === 'off' || mode === 'strip') return false;
  _applyReaderFitMaxWidth(readerFitMaxWidth + delta);
  return true;
}

function _fitItemForImg(img) {
  return img?.parentElement?.classList.contains('page-wrap') ? img.parentElement : img;
}

function _currentFitWidthFraction() {
  const imgs = mode === 'strip'
    ? _fitPageImgs()
    : mode === 'single'
      ? (mainImg.naturalWidth ? [mainImg] : [])
      : [imgLeft, imgRight].filter(img => img.style.display !== 'none' && img.naturalWidth);
  const widths = imgs
    .map(img => _fitItemForImg(img)?.getBoundingClientRect().width || 0)
    .filter(w => w > 0);
  if (!widths.length) return readerFitMaxWidth;
  const basisEl = mode === 'double' ? doubleInner : mode === 'single' ? singleInner : document.documentElement;
  const basis = basisEl?.getBoundingClientRect().width || document.documentElement.clientWidth || window.innerWidth || 1;
  return Math.max(FIT_WIDTH_MIN, Math.min(FIT_WIDTH_MAX, Math.max(...widths) / Math.max(1, basis)));
}

function _zoomReaderFitMode(dir) {
  if (readerFitMode === 'off') return false;
  if (mode === 'strip') {
    const current = _currentFitWidthFraction();
    _applyReaderFitMode('off');
    _applyPageZoom(current + dir * ZOOM_STEP);
    return true;
  }
  if (readerFitMode === 'height') {
    _applyReaderFitMaxWidth(_currentFitWidthFraction(), false);
    _applyReaderFitMode('width');
  }
  return adjustFitMaxWidth(dir * FIT_WIDTH_STEP);
}
// Apply a final zoom (clamped, but NOT rounded — fit-to-viewport needs full precision so it lands
// flush). Keep whatever sits at the top bar's bottom edge fixed while zooming, wherever you are in
// the pages. Anchor on the page element under that edge and the fraction of it that's below it, then
// after the relayout nudge the scroll so that exact point lands back there — gap/mode-agnostic.
function _applyPageZoom(z) {
  const max = mode === 'strip' ? 1 : ZOOM_MAX;
  const next = Math.max(ZOOM_MIN, Math.min(max, z));
  if (next === _pageZoom) { _syncReaderSettingsUI(); return; }
  const anchorY = document.getElementById('topbar')?.getBoundingClientRect().height || 0;
  let anchorEl = null, frac = 0;
  for (const el of document.querySelectorAll('.page-img, #mainImg, .dImg')) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top <= anchorY && r.bottom >= anchorY) { anchorEl = el; frac = (anchorY - r.top) / r.height; break; }
  }
  _pageZoom = next;
  document.documentElement.style.setProperty('--page-zoom', _pageZoom);
  if (anchorEl) {
    void document.documentElement.scrollHeight;   // flush the new layout before measuring
    const r = anchorEl.getBoundingClientRect();
    const delta = (r.top + frac * r.height) - anchorY;
    if (delta) window.scrollBy(0, delta);
  }
  platform.kv.set({ readerPageZoom: _pageZoom });
  _syncReaderSettingsUI();
}
// +/- stepping snaps to a clean 0.01 grid; the fit helpers keep the exact value.
function setPageZoom(z) {
  if (readerFitMode !== 'off') {
    _zoomReaderFitMode(z > _pageZoom ? 1 : -1);
    return;
  }
  _clearReaderFitMode();
  _applyPageZoom(Math.round(z * 100) / 100);
}

function adjustPageZoom(dir) {
  if (readerFitMode !== 'off') {
    _zoomReaderFitMode(dir);
    return;
  }
  _clearReaderFitMode();
  _applyPageZoom(Math.round((_pageZoom + dir * ZOOM_STEP) * 100) / 100);
}

// ── Fit page to viewport (Shift+E → width, Shift+Q → height) ──
// Persistent CSS classes keep fitting responsive as page ratios and the viewport change.
function _fitPageImgs() {
  // Strip: measure only the mounted window around the reading line — pages outside it are
  // unmounted placeholders, and measuring thousands of rows for a median is pointless anyway.
  if (mode === 'strip')  return _stripImgs.filter((_, i) => Math.abs(i + 1 - (currentPage - _viewBase)) <= MOUNT_AHEAD);
  if (mode === 'single') return mainImg.naturalWidth ? [mainImg] : [];
  return [imgLeft, imgRight].filter(i => i.style.display !== 'none' && i.naturalWidth);
}
function _median(nums) {
  const a = nums.filter(n => n > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
async function fitPageWidth() {
  _applyReaderFitMode('width', true, true);
  if (mode === 'strip') _applyPageZoom(1);
  else _scrollPageModeToStartSoon(_pageNavReady);
}
async function fitPageHeight() {
  _applyReaderFitMode('height', true, true);
  if (mode === 'strip') _applyPageZoom(1);
  else _scrollPageModeToStartSoon(_pageNavReady);
}

// ── Continuous W/S (and ↑/↓) scroll (no key-repeat delay) ──
// A rAF loop drives the scroll the moment a key goes down, so there's none of the OS auto-repeat
// pause before the second step. Held directions are kept in press order, so holding both keys
// scrolls toward the LAST one pressed, and releasing it falls back to the other while still held.
const SCROLL_SPEED = 22; // px per frame at full speed; the base rate is half this — Shift doubles it
const _scrollStack = []; // held directions, oldest→newest; the last entry is the active one
let _scrollRaf = null;
let _scrollFast = false;  // Shift held → scroll at SCROLL_SPEED; otherwise at half (the default)
function _scrollLoop() {
  const dir = _scrollStack[_scrollStack.length - 1];
  if (!dir) { _scrollRaf = null; return; }
  const step = _scrollFast ? SCROLL_SPEED : SCROLL_SPEED / 2;
  window.scrollBy(0, dir === 'down' ? step : -step);
  _scrollRaf = requestAnimationFrame(_scrollLoop);
}
function _pressScroll(dir) {
  const i = _scrollStack.indexOf(dir);
  if (i !== -1) _scrollStack.splice(i, 1);   // re-press (or held + repeat) → move to the top
  _scrollStack.push(dir);
  if (!_scrollRaf) _scrollRaf = requestAnimationFrame(_scrollLoop);
}
function _releaseScroll(dir) {
  const i = _scrollStack.indexOf(dir);
  if (i !== -1) _scrollStack.splice(i, 1);
}
function _stopScroll() { _scrollStack.length = 0; }

document.addEventListener('keyup', (e) => {
  _setStudyTextSelectable(e.shiftKey);
  _scrollFast = e.shiftKey;   // releasing Shift drops back to the half-speed default, live
  if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp')   _releaseScroll('up');
  if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') _releaseScroll('down');
});
window.addEventListener('blur', () => { _stopScroll(); _scrollFast = false; _setStudyTextSelectable(false); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { _stopScroll(); _scrollFast = false; _setStudyTextSelectable(false); }
});

// Keyboard
document.addEventListener('keydown', (e) => {
  _setStudyTextSelectable(e.shiftKey);
  if (e.target === scrubber) return;
  if (readerSettingsModal.classList.contains('show')) {
    if (e.key === 'Escape') { e.preventDefault(); setReaderSettingsOpen(false); }
    return;
  }
  _scrollFast = e.shiftKey;   // Shift held → double the scroll speed, live (even mid-hold)

  // W / S / ↑ / ↓ → continuous scroll; Shift doubles the speed.
  if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') {
    e.preventDefault();
    _pressScroll('up');
    return;
  }
  if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') {
    e.preventDefault();
    _pressScroll('down');
    return;
  }

  // Zoom the in-view pages: + / E in, − / Q out. Shift+E fits width, Shift+Q fits height.
  if (e.key === 'e' || e.key === 'E') { e.preventDefault(); e.shiftKey ? fitPageWidth()  : adjustPageZoom(1); return; }
  if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); e.shiftKey ? fitPageHeight() : adjustPageZoom(-1); return; }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); adjustPageZoom(1); return; }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); adjustPageZoom(-1); return; }
  if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    if (readerFitMode !== 'off') {
      if (mode === 'strip') _applyReaderFitMode('width', true, true);
      else _applyReaderFitMaxWidth(FIT_WIDTH_MAX);
    }
    else setPageZoom(1);
    return;
  }

  if (e.key === 'Escape') {
    // First Escape dismisses any revealed study bubbles (text-display bubbles fall back to
    // their original text instead of closing); otherwise it toggles the shortcuts modal.
    if (studyMode && document.querySelector('.bubble-box.revealed')) {
      document.querySelectorAll('.bubble-box.revealed').forEach(box => {
        if (box._reset) { box._reset(); return; }
        box.classList.remove('revealed', 'text-revealed');
        (box._layers || []).forEach(el => { el.style.display = 'none'; });
      });
      return;
    }
    setKeybindOpen(!keybindModal.classList.contains('show'));
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    setKeybindOpen(!keybindModal.classList.contains('show'));
    return;
  }

  const step = mode === 'double' ? 2 : 1;
  // ↑/↓ are scroll (handled above); page-flip stays on ←/→, A/D and Space.
  const forwardArrow = mode !== 'strip' && readerDirection === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
  const backArrow = forwardArrow === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
  const fwd  = e.key === forwardArrow || e.key === ' ' || e.key === 'd' || e.key === 'D';
  const bck  = e.key === backArrow || e.key === 'a' || e.key === 'A';

  // First/last page (Shift+arrows, Home/End) are CHAPTER-relative, matching the counter/scrubber.
  const chK     = _chapters[_chapterAt(currentPage)];
  const chFirst = chK ? chK.start + 1 : 1;
  const chLast  = chK ? chK.start + chK.count : pages.length;
  // HELD navigation (key auto-repeat) breaks at chapter boundaries: it parks on the transition
  // page (or the chapter's edge when there is none) and only a fresh key press continues into
  // the adjacent chapter.
  const held = e.repeat;

  if (mode === 'strip') {
    if (fwd || bck) {
      e.preventDefault();
      if (e.shiftKey) {
        _scrollStripToPage(fwd ? chLast : chFirst);
      } else {
        const next = currentPage + (fwd ? 1 : -1);
        if (next < 1 || next > pages.length) return;   // series edge — chapters are continuous
        if (held && (next < chFirst || next > chLast)) return;   // held nav stops at the chapter edge
        _scrollStripToPage(next);                      // re-scopes a chapter-only strip at its edges
      }
    }
    if (e.key === 'Home') { e.preventDefault(); chFirst === _viewBase + 1 ? window.scrollTo(0, 0) : _scrollStripToPage(chFirst); }
    if (e.key === 'End')  { e.preventDefault(); chLast === _viewBase + _viewCount ? window.scrollTo(0, document.body.scrollHeight) : _scrollStripToPage(chLast); }
  } else {
    if (fwd || bck) {
      e.preventDefault();
      if (held && _pageDivider !== null) return;       // held nav parks on the transition page
      const rawN = currentPage + (fwd ? step : -step);
      // No transition page to park on (transitions off) → held nav stops at the chapter edge.
      if (held && (rawN > chLast || rawN < chFirst) && !(_chapterDividersOn && _series)) return;
      if (e.shiftKey) goTo(fwd ? chLast : chFirst);
      else goTo(rawN);
    }
    if (e.key === 'Home') goTo(chFirst);
    if (e.key === 'End')  goTo(chLast);
  }
  if (e.key === 'g' || e.key === 'G') setThumbsOpen(!thumbsOpen);
  if (e.key === 'n' || e.key === 'N') applyReaderPin(!readerPinned);   // toggle the pinned header
  if (e.key === 't' || e.key === 'T') setView(translateView ? 'off' : 'translate');
  if (e.key === 'b' || e.key === 'B') setView(studyMode ? 'off' : 'study');
  if (e.key === '1') setMode('single');
  if (e.key === '2') setMode('double');
  if (e.key === '3') setMode('strip');
  if (e.key === '[') _gotoAdjacentChapter(-1);   // previous chapter (series)
  if (e.key === ']') _gotoAdjacentChapter(1);     // next chapter (series)
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

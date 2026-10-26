// reader.js — offline gallery reader

import './boot.js';
import * as api from './api.js';
import { resolveSeries, chapterNumberLabel } from './series.js';
import { memberKind } from './gallery-model.js';
import { request as extRequest, send as extSend } from './ext-bridge.js';
import { siteName, galleryLink, updateSitesStatus, canDownload } from './sites.js';
import * as platform from './platform.js';
import { t, getLang } from './i18n.js';
import { formatCount } from './format.js';
import { pickTitle } from './titles.js';
import { initTooltips } from './tooltip.js';
import { initDropdowns } from './dropdown.js';
import { escHtml, safeExternalUrl } from './sanitize.js';
import {
  setStudyPrefs, studyPrefs, studyFor, loadStudyRecords, _ensureWrap, _removeBubbleLayers,
  _removeWrapBubbleLayer, _layerUrls, _clipInset, _buildStudyText, _buildStudySrc,
  _studySourceRect, _studyTranslationRect, _positionBubbleIndicator, _buildBubbleShape, _sharedShapes,
  _wireSelectableText, _setStudyTextSelectable, _sourceTextLang, _sniffSourceLang, _syncLayerScale, forgetStudy, hasAnyStudy,
} from './reader-study.js';
import { resizeToWidth, imageToBlob } from './image-util.js';
import { feedbackKey, editingTarget, feedbackTarget, tagFeedback } from './feedback.js';
import { openFeedback, feedbackOpen } from './reader-feedback.js';
import { openPageProperties, propertiesOpen, closePageProperties } from './reader-properties.js';
import { openPageMenu, pageStatus } from './reader-page-menu.js';
import { translationView } from './page-image.js';

// Site names/links come from sites.js (runtime data + the localStorage warm start, so source
// labels are correct on first paint instead of waiting for the bridge to answer).
updateSitesStatus();

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
let translateDisplay = 'image'; // translate view: 'image' (rendered page) | 'text' (Settings → Reader)
let lastPageMode  = 'single';
let _pageZoom     = 1;     // +/- page scale factor
let readerFitMode = 'off'; // 'off' | 'width' | 'height' for persistent page-mode fit classes
let readerFitMaxWidth = 1; // persistent fit cap, 0.1..1, adjusted by zoom keys while fit is active
let readerNavDirection  = 'ltr'; // 'rtl': the left side / ←, A turns forward
let readerPageDirection = 'ltr'; // 'rtl': a double spread reads right to left (2 1)
let readerCoverOffset   = false; // double spreads open on a blank page before each chapter's first
let readerDebugLoaded   = false; // debug: the bar shows which pages the reader holds (_paintLoaded)
let readerAutoScrollSpeed = 150; // px/s: how fast auto-play reads on (the play buttons, K; _speedLabel)
let readerDim = 0;               // 0–100: how far the pages are darkened (Reader settings → Dim pages)
let _autoRaf = 0;                // the auto-scroll's frame request; non-zero while it runs (_autoScrollFrame)
let readerPageGap = 4;
let readerProgressPosition = 'bottom';
let readerAutoBarPosition = 'bottom';   // the auto-play bar: across the window's top or bottom (_placeAutoBar)
let readerAutoPauseOnUp = true;         // going back up (a scroll, a page turned back) pauses auto-play
let readerSmoothScroll = true;          // the strip glides to another page (_glideStripTo), or is there at once
let _skipOverview = false;              // Settings → Reader: open a series straight to reading (the library reads it)
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
let _translateAvailable = false;       // this gallery has a whole-page translation

// Page images are served as blob: URLs. A blob URL references the IndexedDB-backed Blob — the
// bytes stay on disk until an <img> actually needs them, and the browser discards decoded
// bitmaps of off-screen images on its own. Nearby URLs stay warm while the virtualized strip
// revokes far-away ones, keeping very long series bounded without putting base64 on the JS heap.
// Keys include the variant (original vs translated), so an in-range view switch can swap in place.
const _pageUrlCache = new Map();   // variantKey → blob: URL ('' when the record is missing)
const _showTranslated = () => translateView && !studyMode;   // study mode forces the clean original
// Translate-as-text (Settings → Reader): instead of the server's typeset page, show the inpainted
// bg — the same text-removed layer study mode reveals per bubble — with the translations above it
// as DOM text. Each page shows what it has (page-image.js translationView): a page without that
// layer shows its translated image, and one kept only as study layers shows those as the image.
const _translateAsText = () => _showTranslated() && translateDisplay === 'text';
// Bubble overlays back two displays: study mode's revealable bubbles, and the translate view's
// text over the inpainted page (DOM text, or the balloons' text layers of a page kept as them).
const _bubbleLayersOn = () => studyMode || _showTranslated();
const _variantKey = (page) => page?.url ? (_translateAsText() ? 'b:' : _showTranslated() ? 't:' : 'o:') + page.url : '';
let _libraryOpen = false;   // the library has answered (init); page reads wait for it
let _stripGen  = 0; // bumped on every buildStrip call to cancel stale loads

// Load every page's stored study layers (reader-study.js owns the records) and note whether any
// exist (→ show the study button). Cache the in-flight/completed pass so startup, idle loading
// and later callers cannot rescan or overlap the same large library.
let _studyLoadPromise = null;
let _studyLoaded = false;
function _loadStudy() {
  if (_studyLoadPromise) return _studyLoadPromise;
  if (!_libraryOpen) return Promise.resolve(false);
  _studyLoadPromise = (async () => {
    // Study layers are optional: a gallery whose layers can't be read is read without them.
    try { hasStudy = await loadStudyRecords(_chapters.map(ch => ch.id)); }
    catch { hasStudy = false; }
    _studyLoaded = true;
    _syncStudyAvailability();
    return hasStudy;
  })();
  return _studyLoadPromise;
}

// The stored bytes the current variant asks for. A page without a translation of either kind
// falls back to its untouched original rather than showing nothing.
function _variantSrc(record) {
  const original = record.blob ?? record.dataUrl;
  if (!_showTranslated()) return original;
  const { source } = translationView({ translated: record.translated != null, bg: record.studyBg, bubbles: record.bubbles }, translateDisplay);
  return source === 'translated' ? record.translated : source === 'bg' ? record.studyBg : original;
}

async function pageBlobUrl(page) {
  if (!page?.cached || !page.url) return '';
  const key = _variantKey(page);
  if (_pageUrlCache.has(key)) return _pageUrlCache.get(key);
  if (!_libraryOpen) return '';
  _pageReadsInFlight++;   // the thumbnail warm-up waits for these
  let record;
  try { record = await api.pages.get(page.gid, page.pageNum, page.url).catch(() => null); }
  finally { _pageReadsInFlight--; }
  const src = record ? _variantSrc(record) : null;
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
    const record = await api.pages.get(page.gid, page.pageNum, page.url).catch(() => null);
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

// Estimate the missing-page aspect ratio from at most a handful of cached pages, spread evenly
// across the gallery — decoding every cached page here just to take a median needlessly delays the
// first paint. Even spacing avoids over-weighting front matter (covers/spreads) clustered up front.
const PLACEHOLDER_SAMPLE_MAX = 5;

async function _measurePlaceholderRatio() {
  if (!pages.some(page => !page?.cached)) return;
  const allCached = pages.filter(page => page?.cached && page.url);
  if (!allCached.length) return;
  const step = Math.max(1, Math.floor(allCached.length / PLACEHOLDER_SAMPLE_MAX));
  const cachedPages = [];
  for (let i = 0; i < allCached.length && cachedPages.length < PLACEHOLDER_SAMPLE_MAX; i += step) {
    cachedPages.push(allCached[i]);
  }

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

// "w / h" (an aspect-ratio value) → w / h.
function _ratioValue(r) {
  const [w, h] = String(r).split('/').map(Number);
  return w > 0 && h > 0 ? w / h : 0;
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
    // A sized <img> with no source draws the browser's broken-image glyph (even with alt=""):
    // a page still loading shows a transparent page of the placeholder's shape instead.
    img.src = _defaultBlankSrc();
    _setPlaceholderGeometry(img);
  } else {
    img.src = url;
    // A page decoded ahead already knows its shape: lay it out at that shape now rather than at the
    // previous page's until this <img> loads (its load event re-seeds the same values). Overlays
    // are placed as fractions of the page, so they'd jump with it.
    const pre = _decoded.get(url);
    if (pre?.naturalWidth) {
      img.style.aspectRatio = `${pre.naturalWidth} / ${pre.naturalHeight}`;
      _setPageRatioVars(img, pre);
    }
  }
  return placeholder;
}

// A blank half of a spread shows an empty SVG of a page's shape: it sizes like any page, and unlike
// an <img> with no source it never draws the browser's broken-image glyph.
const _blankPageSrc = (w, h) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`)}`;

// One half of a double spread: page `n`'s image, or with n = 0 a white blank page of the default
// page shape until _shapeBlankLike matches it to its partner. Returns placeholder-ness.
const _defaultBlankSrc = () => _blankPageSrc(1000, Math.round(1000 / _placeholderWidthRatio));
function _showSpreadHalf(img, n, url) {
  img.classList.toggle('page-blank', !n);
  if (n) return _showPageImage(img, url);
  img.classList.remove('page-placeholder');
  img.src = _defaultBlankSrc();
  return false;
}

// Decode images off-screen; once done, an <img> given the same URL paints complete in its first
// frame instead of popping in after it. _decoded holds on to the decoded images (the most recently
// asked for last, a flip or two's worth): an image nothing holds can drop out of the browser's cache
// before the flip, and it also tells a swap each page's true shape up front (see _showPageImage).
// Asking again for one already held keeps it, so the neighbours of the page being read outlast
// pages preloaded for a jump (_preloadOnRest).
const _decoded = new Map();   // image URL → its decoded Image
const DECODED_KEEP = 32;
function _decodeUrls(urls) {
  for (const u of urls) {
    const held = u && _decoded.get(u);
    if (held) { _decoded.delete(u); _decoded.set(u, held); }
  }
  return Promise.all(urls.filter(u => u && !_decoded.has(u)).map(u => {
    const img = new Image();
    img.src = u;
    return img.decode().then(() => {
      _decoded.set(u, img);
      while (_decoded.size > DECODED_KEEP) _decoded.delete(_decoded.keys().next().value);
      _noteLoaded();
    }, () => {});
  }));
}
// null when every image is already decoded (swap now), else the promise of decoding the rest.
const _whenDecoded = (urls) => urls.every(u => !u || _decoded.has(u)) ? null : _decodeUrls(urls);

// The images a page's overlay shows the moment it mounts: the inpainted background under
// original-as-text (study mode), or the balloons' text layers of a page kept as study layers
// (translate view). The rest only load when a bubble is revealed.
function _overlayImageUrls(pageNum) {
  const page = pages[pageNum - 1];
  const study = page?.url && _bubbleLayersOn() ? studyFor(page.url) : null;
  const urls = study && _layerUrls(page.url);
  if (!urls) return [];
  if (!studyMode) return translationView(study, translateDisplay).overlay === 'images' ? urls.textUrls : [];
  return studyPrefs().original === 'text' ? [urls.bgUrl] : [];
}

// Pages a flip or two away from n (a double spread's next trail included): kept decoded, overlays
// too, so turning the page has nothing left to wait for.
function _nearPages(n) {
  const near = [];
  for (let p = Math.max(1, n - 3); p <= Math.min(pages.length, n + 4); p++) near.push(p);
  return near;
}

// Pre-create blob URLs (and warm the decode cache) for pages around n and their overlays, so
// page flips and double-page spreads never show a blank frame.
function _warmNeighbors(n) {
  for (const p of _nearPages(n)) {
    pageBlobUrl(pages[p - 1]).then(u => _decodeUrls([u, ..._overlayImageUrls(p)]));
  }
}

// ── Preloading where the pointer rests ──
// A jump shows its page the frame it lands only if the page is read and decoded already; reading and
// decoding one takes some 60–120 ms, the blank moment after a jump to a page not loaded. So when the
// pointer comes to rest on the progress bar or on a thumbnail, the pages a press there would show are
// read and decoded ahead into _decoded, where the jump finds them warm (the strip's rows take the same
// URLs). On the bar, the thumbnails a scrub dragged out of it would show first are made ahead too.
// Only a resting pointer preloads: one sweeping across the bar would ask for every page it passes.
const HOVER_REST_MS = 40;
let _hoverTimer = 0;

function _preloadOnRest(n, thumbsToo) {
  clearTimeout(_hoverTimer);
  _hoverTimer = setTimeout(() => {
    for (const p of _pagesShownAt(n)) {
      pageBlobUrl(pages[p - 1]).then(u => _decodeUrls([u, ..._overlayImageUrls(p)]));
    }
    if (thumbsToo) _warmThumbsAround(n - 1);
  }, HOVER_REST_MS);
}
const _cancelPreloadOnRest = () => clearTimeout(_hoverTimer);

// The pages a jump to page n shows: its spread in double page, in the strip the rows filling the
// screen from its top.
function _pagesShownAt(n) {
  n = _landingPage(n);
  if (mode === 'double') { const { lead, trail } = _spreadAt(n); return [lead, trail].filter(Boolean); }
  if (mode !== 'strip') return [n];
  const shown = [];
  for (let i = n - 1 - _viewBase, h = 0; i >= 0 && i < _viewCount && h < window.innerHeight; i++) {
    shown.push(_viewBase + i + 1);
    h += _stripWraps[i].offsetHeight;
  }
  return shown.length ? shown : [n];
}

// ── Thumbnails: a small WebP copy of each page, made in a worker (thumb-worker.js) — a canvas encode
// on this thread waits for idle time, which a page being read rarely has: about a second a thumbnail.
// Copies are sized to the strip's thumbs (1.5× their device pixels, stepped, so one copy serves a
// range of strip heights) and remade larger when the strip is made taller — a few KB each. They live
// in a memory LRU bounded by count and bytes; nothing is written anywhere.
const _thumbBlobCache = new Map();   // page.url → { url: blob: URL, width, bytes } (Map order = LRU order)
let   _thumbCacheBytes = 0;
const _thumbGenQueue  = [];          // { page, resolve }
const _thumbInFlight  = new Map();   // page.url → promise of its blob: URL
let   _thumbGenActive = 0;
const THUMB_GEN_MAX   = 4;           // in flight — kept low so thumb generation never starves the
                                     // reader's own page loads of library reads and decoder time
// Thumbnails are what a scrub through a whole gallery looks at, so every page keeps one: a few KB
// each at the strip's usual height, so a long gallery's set is tens of MB at most.
const THUMB_CACHE_MAX   = 4000;
const THUMB_CACHE_BYTES = 64 * 1024 * 1024;
const THUMB_SCALE = 1.5, THUMB_STEP = 32, THUMB_MAX_W = 768;
const THUMB_FORMAT = { format: 'image/webp', quality: 0.82 };

// The width a copy needs for the strip as it is now, like the overview's tiles: its on-screen pixels
// × THUMB_SCALE, stepped. The strip is counter-zoomed to a fixed physical size, so its thumbs are
// (_thumbHeight - 7) device pixels tall at a 52:74 aspect — larger only when pinch-zoomed in.
function _thumbWidth() {
  const w = (_thumbHeight - 7) * 52 / 74 * (window.visualViewport?.scale || 1);
  return Math.min(THUMB_MAX_W, Math.ceil(w * THUMB_SCALE / THUMB_STEP) * THUMB_STEP);
}
// Pinch-zoomed further than the copies were made for: remake them larger once it settles.
let _thumbScaleTimer = 0;
window.visualViewport?.addEventListener('resize', () => {
  clearTimeout(_thumbScaleTimer);
  _thumbScaleTimer = setTimeout(() => _refreshThumbSizes(), 250);
});

function _cachedThumb(pageUrl) {
  const entry = _thumbBlobCache.get(pageUrl);
  if (!entry) return null;
  _thumbBlobCache.delete(pageUrl);
  _thumbBlobCache.set(pageUrl, entry);  // Map insertion order is the LRU order
  return entry;
}

function _thumbImgFor(pageUrl) {
  const idx = _pageIdxByUrl.get(pageUrl);
  return idx == null ? null : thumbStrip.querySelector(`.thumb-item img[data-idx="${idx}"]`);
}

function _cacheThumb(pageUrl, entry) {
  const old = _thumbBlobCache.get(pageUrl);
  if (old) { _thumbBlobCache.delete(pageUrl); _thumbCacheBytes -= old.bytes; }
  _thumbBlobCache.set(pageUrl, entry);
  _thumbCacheBytes += entry.bytes;
  if (old) _releaseThumb(pageUrl, old.url, entry.url);
  else {
    const img = _thumbImgFor(pageUrl);   // a thumb waiting in the open strip shows it at once
    if (img && !img.getAttribute('src')) img.src = entry.url;
  }
  while (_thumbBlobCache.size > THUMB_CACHE_MAX || _thumbCacheBytes > THUMB_CACHE_BYTES) {
    const [oldPageUrl, oldEntry] = _thumbBlobCache.entries().next().value;
    _thumbBlobCache.delete(oldPageUrl);
    _thumbCacheBytes -= oldEntry.bytes;
    _releaseThumb(oldPageUrl, oldEntry.url, '');
  }
}

// A copy leaves the cache: a thumb still showing it takes its replacement, or is cleared to be made
// again when next needed; then the copy is let go.
function _releaseThumb(pageUrl, oldUrl, newUrl) {
  const img = _thumbImgFor(pageUrl);
  if (img && img.getAttribute('src') === oldUrl) {
    if (newUrl) img.src = newUrl;
    else { img.removeAttribute('src'); delete img.dataset.queued; }
  }
  try { URL.revokeObjectURL(oldUrl); } catch {}
}

// The thumbnails a scrub dragged out of the bar at page index gi shows first, a strip's width of them
// each side, nearest first at the front of the queue (the warm-up may not have reached them yet).
function _warmThumbsAround(gi) {
  const { base, count } = _thumbScope();
  const width = _thumbWidth();
  const pitch = _thumbItems.length > 1 ? _thumbItems[1].offsetLeft - _thumbItems[0].offsetLeft : 0;
  const reach = pitch > 0 ? Math.ceil((thumbStrip.clientWidth || window.innerWidth) / pitch) : 24;
  const want = new Set();
  for (let g = Math.max(base, gi - reach); g <= Math.min(base + count - 1, gi + reach); g++) {
    const page = pages[g];
    if (!page?.cached || !page.url || _thumbWarmFailed.has(page.url)) continue;
    const entry = _thumbBlobCache.get(page.url);
    if (entry && entry.width >= width) continue;
    want.add(page.url);
    _generateThumbBlob(page);
  }
  if (!want.size) return;
  const dist = (e) => Math.abs((_pageIdxByUrl.get(e.page.url) ?? Infinity) - gi);
  const first = _thumbGenQueue.filter(e => want.has(e.page.url)).sort((a, b) => dist(a) - dist(b));
  const rest  = _thumbGenQueue.filter(e => !want.has(e.page.url));
  _thumbGenQueue.length = 0;
  _thumbGenQueue.push(...first, ...rest);
}

// One request per page at a time: the warm-up and the open strip asking for the same page share it.
function _generateThumbBlob(page) {
  let job = _thumbInFlight.get(page.url);
  if (!job) {
    job = new Promise((resolve) => {
      _thumbGenQueue.push({ page, resolve });
      _processThumbQueue();
    });
    _thumbInFlight.set(page.url, job);
    job.then(() => _thumbInFlight.delete(page.url));
  }
  return job;
}

// Thumbnails wait while the page modes turn pages in quick succession (_pagesTurning): making one reads
// and resizes a whole page, which held up the pages being turned. They fill in once the turning stops.
let _thumbGenDeferred = 0;
async function _processThumbQueue() {
  if (_thumbGenActive >= THUMB_GEN_MAX) return;
  if (_thumbGenQueue.length === 0) return;
  if (_pagesTurning()) {
    if (!_thumbGenDeferred) _thumbGenDeferred = setTimeout(() => {
      _thumbGenDeferred = 0;
      for (let i = 0; i < THUMB_GEN_MAX; i++) _processThumbQueue();
    }, WARM_QUIET_MS);
    return;
  }
  _thumbGenActive++;
  const { page, resolve } = _thumbGenQueue.shift();
  try {
    const width = _thumbWidth();
    const cached = _cachedThumb(page.url);
    if (cached && cached.width >= width) { resolve(cached.url); return; }
    const source = _libraryOpen ? await _thumbSource(page) : null;
    const small = source ? await _resizeInWorker(source, width) : null;
    if (!small) { resolve(cached?.url || ''); return; }
    const entry = { url: URL.createObjectURL(small), width, bytes: small.size };
    _cacheThumb(page.url, entry);
    resolve(entry.url);
  } catch {
    resolve('');
  } finally {
    _thumbGenActive--;
    _processThumbQueue();
  }
}

// The page's own image: the copy the reader already holds when it shows the original nearby, else a
// read from the library.
async function _thumbSource(page) {
  const held = _pageUrlCache.get('o:' + page.url);
  if (held) { try { return await (await fetch(held)).blob(); } catch {} }   // revoked meanwhile: read it
  const record = await api.pages.get(page.gid, page.pageNum, page.url).catch(() => null);
  return imageToBlob(record?.blob ?? record?.dataUrl);
}

// Workers start on first use. One that fails hands its requests to this thread and leaves the pool;
// with none left, copies are made here (slower, same result).
const THUMB_WORKERS = Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 4) / 4)));
let _thumbWorkers = null;
let _thumbTurn = 0, _thumbSeq = 0;
const _thumbPending = new Map();   // request id → { resolve, worker, blob, width }

function _thumbWorker() {
  if (!_thumbWorkers) {
    _thumbWorkers = [];
    try {
      for (let i = 0; i < THUMB_WORKERS; i++) {
        const worker = new Worker(new URL('./thumb-worker.js', import.meta.url), { type: 'module' });
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

function _dropThumbWorker(worker) {
  _thumbWorkers = _thumbWorkers.filter((w) => w !== worker);
  try { worker.terminate(); } catch {}
  for (const [id, job] of _thumbPending) {
    if (job.worker !== worker) continue;
    _thumbPending.delete(id);
    job.resolve(resizeToWidth(job.blob, job.width, THUMB_FORMAT).catch(() => null));
  }
}

function _resizeInWorker(blob, width) {
  const worker = _thumbWorker();
  if (!worker) return resizeToWidth(blob, width, THUMB_FORMAT).catch(() => null);
  return new Promise((resolve) => {
    const id = ++_thumbSeq;
    _thumbPending.set(id, { resolve, worker, blob, width });
    worker.postMessage({ id, blob, width, ...THUMB_FORMAT });
  });
}

// ── Thumbnail warm-up ──
// Opening the thumbnails, or dragging them out of the progress bar, should find them all made — a
// scrub from top to bottom can't wait for them. So from the moment the reader opens, every page of
// the thumbnail scope (up to THUMB_WARM_MAX) gets its thumbnail, nearest the reading position first,
// WARM_JOBS at a time alongside the reader's own loading, pausing while the reader is busy — the strip
// flying, or the page modes turning pages in quick succession (a held key, a click-wheel skim): those
// need every frame, and a page turned under a busy decoder shows late. The open strip's visible thumbs
// jump the queue (_prioritizeVisibleThumbs).
const THUMB_WARM_MAX = 4000;
const WARM_JOBS = 2;
const WARM_QUIET_MS = 250;   // a page mode turned no page for this long: no longer busy
let _lastTurnAt = 0;         // when a page mode last turned the page (goTo)
const _pagesTurning = () => mode !== 'strip' && performance.now() - _lastTurnAt < WARM_QUIET_MS;
const _readerBusy = () => _stripFlying() || _pagesTurning();
let _thumbWarmTimer = 0;
let _thumbWarming = 0;        // warm-up jobs under way
let _pageReadsInFlight = 0;   // pageBlobUrl library reads under way
const _thumbWarmPicked = new Set();   // page urls a warm-up job is making now
const _thumbWarmFailed = new Set();   // page urls whose thumbnail couldn't be made: not retried

function _scheduleThumbWarm(delay = 300) {
  if (_thumbWarmTimer || _thumbWarming >= WARM_JOBS || !pages.length) return;
  _thumbWarmTimer = setTimeout(() => {
    _thumbWarmTimer = 0;
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(_warmNextThumb, { timeout: 500 });
    else _warmNextThumb();
  }, delay);
}

function _warmNextThumb() {
  if (_readerBusy()) { _scheduleThumbWarm(300); return; }
  while (_thumbWarming < WARM_JOBS) {
    const page = _nextThumbToWarm();
    if (!page) return;   // all made: a new reading position, a new page or a taller strip starts it again
    _thumbWarming++;
    _thumbWarmPicked.add(page.url);
    _generateThumbBlob(page).then((url) => { if (!url) _thumbWarmFailed.add(page.url); }).finally(() => {
      _thumbWarming--;
      _thumbWarmPicked.delete(page.url);
      _scheduleThumbWarm(0);
    });
  }
}

function _nextThumbToWarm() {
  const { base, count } = _thumbScope();
  if (!count) return null;
  const width = _thumbWidth();
  const center = Math.max(base, Math.min(base + count - 1, currentPage - 1));
  const limit = Math.min(count, THUMB_WARM_MAX);
  for (let d = 0, seen = 0; seen < limit; d++) {
    for (const gi of d ? [center - d, center + d] : [center]) {
      if (gi < base || gi >= base + count) continue;
      seen++;
      const page = pages[gi];
      if (!page?.cached || !page.url || _thumbWarmPicked.has(page.url) || _thumbWarmFailed.has(page.url)) continue;
      const entry = _thumbBlobCache.get(page.url);
      if (!entry || entry.width < width) return page;
    }
  }
  return null;
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
function _setPageRatioVars(img, source = img) {
  if (!img || source.naturalWidth <= 1 || source.naturalHeight <= 1) return;
  const ratio = source.naturalWidth / source.naturalHeight;
  img.style.setProperty('--page-ratio', ratio);
  if (img.parentElement?.classList.contains('page-wrap')) img.parentElement.style.setProperty('--page-ratio', ratio);
}
const _seedRatio = (img) => {
  _setPageRatioVars(img);
  img.style.removeProperty('aspect-ratio');
};
// A spread's empty half takes its partner page's shape once that page has loaded, so the two
// halves stay level.
function _shapeBlankLike(blank, partner) {
  if (partner.naturalWidth <= 1 || partner.naturalHeight <= 1) return;
  blank.src = _blankPageSrc(partner.naturalWidth, partner.naturalHeight);   // its load re-seeds the geometry
}
[mainImg, imgLeft, imgRight].forEach(img => img.addEventListener('load', () => _seedRatio(img)));
const scrubSegments = document.getElementById('scrubSegments');
const scrubTrack    = document.getElementById('scrubTrack');
const scrubView     = document.getElementById('scrubView');
const scrubTip      = document.getElementById('scrubTip');
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
const readerCoverOffsetInput   = document.getElementById('readerCoverOffset');
const readerDebugLoadedInput   = document.getElementById('readerDebugLoaded');
const readerGap = document.getElementById('readerGap');
const readerGapValue = document.getElementById('readerGapValue');
const readerAutoScrollInput = document.getElementById('readerAutoScroll');
const readerAutoScrollValue = document.getElementById('readerAutoScrollValue');
const readerDimInput = document.getElementById('readerDim');
const readerDimValue = document.getElementById('readerDimValue');
const readerZoomOut = document.getElementById('readerZoomOut');
const readerZoomIn = document.getElementById('readerZoomIn');
const readerZoomValue = document.getElementById('readerZoomValue');
const readerOverviewInput    = document.getElementById('readerOverview');
const readerStripFlowInput   = document.getElementById('readerStripFlow');
const readerTransitionsInput = document.getElementById('readerTransitions');
const readerPauseOnUpInput   = document.getElementById('readerPauseOnUp');
const readerSmoothScrollInput = document.getElementById('readerSmoothScroll');
const readerFuriganaInput    = document.getElementById('readerFurigana');
const readerStudyFontSelect  = document.getElementById('readerStudyFont');
const readerStudyTextGroup   = document.getElementById('readerStudyTextGroup');
const readerNavPlaceGroup    = document.getElementById('readerNavPlaceGroup');
const rsPicker      = document.getElementById('rsPicker');
const readerPinBtn  = document.getElementById('readerPinBtn');
const tbGallery     = document.getElementById('tbGallery');
const tbMeta        = document.getElementById('tbMeta');
const scrollTopBtn  = document.getElementById('scrollTopBtn');
const dividerPage   = document.getElementById('dividerPage');
// Side controls (Reader settings → Navigation → Side)
const snChPrev      = document.getElementById('snChPrev');
const snChLabel     = document.getElementById('snChLabel');
const snChNum       = document.getElementById('snChNum');
const snChTotal     = document.getElementById('snChTotal');
const snChNext      = document.getElementById('snChNext');
const snOverview    = document.getElementById('snOverview');
const snMode        = document.getElementById('snMode');
const snTranslate   = document.getElementById('snTranslate');
const snStudy       = document.getElementById('snStudy');
const snThumbs      = document.getElementById('snThumbs');
const snAuto        = document.getElementById('snAuto');
const autoBtn       = document.getElementById('autoBtn');   // the top bar's play button
const snSettings    = document.getElementById('snSettings');
const snKeys        = document.getElementById('snKeys');
const snTop         = document.getElementById('snTop');      // the rail's go-to-top button
const snChapter     = document.getElementById('snChapter');  // the chapter pill
const snRail        = document.getElementById('snRail');
const sideZoom      = document.getElementById('sideZoom');
const snFit         = document.getElementById('snFit');
const snZoomOut     = document.getElementById('snZoomOut');
const snZoomIn      = document.getElementById('snZoomIn');
const snZoomValue   = document.getElementById('snZoomValue');
const snChList      = document.getElementById('snChList');
const snChaptersClose = document.getElementById('snChaptersClose');

function _syncStudyAvailability() {
  viewToggle.style.display = (_translateAvailable || hasStudy) ? '' : 'none';
  studySeg.classList.toggle('disabled', !hasStudy);
  _syncSideNav();
}

function _scheduleStudyLoad() {
  const load = () => {
    void _loadStudy().then(() => { if (hasStudy) _recomputeFold(); }).catch(() => {});
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(load, { timeout: 2000 });
  } else {
    setTimeout(load, 250);
  }
}

// ── Init ──
async function init() {
  if (!galleryId) { showEmpty(); return; }

  tbGallery.textContent = `#${galleryId}`;
  document.title        = `Shiori — #${galleryId}`;

  loadingText.textContent = t('rd.opening_db');
  try { await api.meta.get(galleryId); _libraryOpen = true; }
  catch (e) { showEmpty(); return; }

  loadingText.textContent = t('rd.loading_pages');
  const gid = String(galleryId);
  // A library kept as files says when this gallery's files can't be found in its folder.
  api.galleries.get(gid).then((g) => {
    if (g?.missing) import('./notice.js').then(({ showToast }) => showToast({ text: t('rd.files_missing'), closeLabel: t('common.close') }));
  }).catch(() => {});

  // Series membership FIRST: a series is read as ONE continuous page list — every cached
  // chapter's pages concatenated in series order — so a chapter transition is just the next
  // scroll row (or page flip), never a reload.
  try { _series = await resolveSeries(galleryId); } catch { _series = null; }
  // A series is read one kind of member at a time: the chapters, or the volumes — whichever the
  // opened gallery is.
  const readKind = _series ? memberKind(_series.chapters.find(c => String(c.id) === gid)) : 'chapter';
  const chapterRefs = _series
    ? _series.chapters.filter(c => memberKind(c) === readKind)
      .map((c, i) => ({ id: String(c.id), num: chapterNumberLabel(c) ?? i + 1, title: c.title || '', kind: readKind }))
    : [{ id: gid, num: 1, title: '' }];
  _seriesTotal = chapterRefs.length;

  // Page list (key-only cursor, no image bytes) and metadata for every chapter, in parallel.
  const [lists, metas] = await Promise.all([
    Promise.all(chapterRefs.map(c => api.pages.list(c.id).catch(() => []))),
    Promise.all(chapterRefs.map(c => api.meta.get(c.id).catch(() => null))),
  ]);

  // Merge into the flat list by chapter-local page number. Metadata supplies the true total;
  // cached keys fill their fixed slots and every gap remains a placeholder until its page arrives.
  // With no declared total, a chapter holds up to its highest cached page and grows as later pages
  // or its total arrive (_growChapters). With nothing cached either, a chapter that can still be
  // downloaded reads as one loading page — navigable, and announced like any page so it can fill
  // in; one that can't has nothing to show.
  pages = [];
  _chapters = [];
  _pageIdxByUrl.clear();
  chapterRefs.forEach((c, i) => {
    const cachedByNum = new Map();
    let highestCached = 0;
    for (const { pageNum, url } of lists[i]) {
      // Pages are read by this key (api.pages.get): the first of two keys for one page answers, as in the library.
      if (!cachedByNum.has(pageNum)) cachedByNum.set(pageNum, { gid: c.id, pageNum, url, cached: true });
      highestCached = Math.max(highestCached, pageNum);
    }
    const declaredTotal = Number(metas[i]?.numPages);
    const trueTotal = Number.isSafeInteger(declaredTotal) && declaredTotal > 0 ? declaredTotal : 0;
    const count = Math.max(highestCached, trueTotal) || (canDownload(metas[i]) ? 1 : 0);
    if (!count) return;
    const slots = Array.from({ length: count }, (_, pageIdx) =>
      cachedByNum.get(pageIdx + 1) || { gid: c.id, pageNum: pageIdx + 1, url: null, cached: false }
    );
    _chapters.push({
      ...c,
      // A chapter with no title of its own reads as the gallery's own title (what the overview
      // and the library chapter picker show), not as a blank divider subtitle.
      title: c.title || pickTitle(metas[i], getLang()) || '',
      start: pages.length,
      count,
      missing: count - cachedByNum.size,
      growing: !trueTotal,   // its length isn't known yet
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
    const visitUrl = galleryLink(meta, 1, meta?.sourceId || gid);
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

  const saved = await platform.kv.get(['readerMode', 'readerLastPageMode', 'readerThumbsOpen', 'readerThumbHeight', 'readerPageZoom', 'readerFitMode', 'readerFitMaxWidth', 'readerDirection', 'readerNavDirection', 'readerPageDirection', 'readerCoverOffset', 'readerDebugLoaded', 'readerAutoScrollSpeed', 'readerDim', 'readerPageGap', 'readerProgressPosition', 'readerView', 'readerTranslateDisplay', 'readerStudyDisplay', 'readerStudyOriginal', 'readerStudySrcFont', 'readerFurigana', 'readerChapterDivider', 'readerStripMode', 'readerAutoBarPosition', 'readerAutoPauseOnUp', 'readerSkipOverview', 'readerSmoothScroll']);

  // A saved study view needs its layers before the first paint, and so does a translate view that
  // draws its text from them — otherwise the inpainted page would paint with empty bubbles until
  // the scan lands. Every other view can render its first page before the full-library scan runs
  // during idle time.
  _translateAvailable = _chapters.some(ch => !!ch.meta?.translated);
  if (saved.readerTranslateDisplay === 'text') translateDisplay = 'text';
  const initTranslate = saved.readerView === 'translate' || (!saved.readerView && _translateAvailable);
  const studyFirst = saved.readerView === 'study' || initTranslate;
  if (studyFirst) await _loadStudy();
  _syncStudyAvailability();
  setStudyPrefs({
    display:  saved.readerStudyDisplay === 'text' ? 'text' : 'hardcoded_images',
    original: saved.readerStudyOriginal === 'text' ? 'text' : 'image',
    srcFont:  saved.readerStudySrcFont === 'kiwi' ? 'kiwi' : 'yasashisa',
    furigana: saved.readerFurigana === 'on',
  });
  _chapterDividersOn = saved.readerChapterDivider !== false;
  _stripSeriesFlow   = saved.readerStripMode !== 'chapter';
  _skipOverview      = !!saved.readerSkipOverview;
  readerAutoPauseOnUp = saved.readerAutoPauseOnUp !== false;
  readerSmoothScroll = saved.readerSmoothScroll !== false;
  readerAutoBarPosition = saved.readerAutoBarPosition === 'top' ? 'top' : 'bottom';
  applyThumbHeight(saved.readerThumbHeight || _thumbHeight);
  if (saved.readerPageZoom) { _pageZoom = saved.readerPageZoom; document.documentElement.style.setProperty('--page-zoom', _pageZoom); }
  _applyReaderFitMaxWidth(saved.readerFitMaxWidth || FIT_WIDTH_MAX, false);
  _applyReaderFitMode(saved.readerFitMode || 'off', false);
  // Both directions start from the single reading direction they were split from.
  _applyReaderNavDirection(saved.readerNavDirection || saved.readerDirection || 'ltr', false);
  _applyReaderPageDirection(saved.readerPageDirection || saved.readerDirection || 'ltr', false);
  _applyReaderCoverOffset(saved.readerCoverOffset === true, false);
  _applyReaderDebugLoaded(saved.readerDebugLoaded === true, false);
  _applyReaderPageGap(saved.readerPageGap ?? 4, false);
  _applyReaderAutoScrollSpeed(saved.readerAutoScrollSpeed ?? 150, false);
  _applyReaderDim(saved.readerDim ?? 0, false);
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
  // chapter ('last' = its final page). A ?g whose chapter has nothing to show (no pages, and no way
  // to download them) falls back to the first chapter.
  const startCh = _chapters.find(c => c.id === gid) || _chapters[0];
  const fromEnd = String(initialPageParam).toLowerCase() === 'last';
  if (fromEnd) startCh.entry = 'end';
  const within = fromEnd
    ? startCh.count
    : Math.max(1, Math.min(startCh.count, parseInt(initialPageParam, 10) || 1));
  await placeholderRatioReady;
  loadingScreen.style.display = 'none';
  currentPage = startCh.start + within;
  setMode(saved.readerMode || 'strip', true);
  goTo(currentPage, true);
  _urlLive = true;
  _syncUrl();
  if (mode === 'strip') requestAnimationFrame(_scrollStripToCurrent);
  _updateViewToggle();
  if (_bubbleLayersOn()) _refreshBubbleLayers();
  _recomputeFold();  // the title is set now — (re)measure the fold breakpoint for the new title
  if (!studyFirst) _scheduleStudyLoad();
  // Defer restoring thumbnail-open state — its eager IDB reads otherwise fight the strip's
  // own loader for IDB bandwidth, delaying the first visible page by several seconds.
  if (saved.readerThumbsOpen) setTimeout(() => setThumbsOpen(true), 1500);
}

// ── Chapter navigation (series) ──
// A series renders as ONE continuous reader: `pages` holds every cached chapter back to back and
// `_chapters` maps merged page ranges back to their chapters. The counter and scrubber speak in
// chapter-local pages while the thumbnails and strip geometry stay series-wide; crossing a
// boundary just scrolls (or flips) into the next chapter's range — never a reload. The topbar
// chrome and the ?g= in the URL follow the chapter under the reading line.
let _series = null;
const _escR = escHtml;

// Merged page number (1-based) → index into _chapters (binary search over chapter starts).
function _chapterAt(page) {
  let lo = 0, hi = _chapters.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (_chapters[mid].start < page) lo = mid; else hi = mid - 1;
  }
  return lo;
}

let _shownGallery = null;   // the chapter last told to the library as the one being read
function _announceCurrentPage() {
  if (!_chapters.length) return;
  const ch = _chapters[_chapterAt(currentPage)];
  if (ch && String(ch.id) !== _shownGallery) {
    _shownGallery = String(ch.id);
    api.galleries.reading(_shownGallery).catch(() => {});
  }
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
  if (!ch || !url || !Number.isSafeInteger(pageNum) || pageNum < 1) return;
  if (pageNum > ch.count) { if (ch.growing) _queueGrowth(ch, event); return; }
  if (ch.growing) _queueGrowth(ch, null);   // its total may have arrived with this page
  const pageIdx = ch.start + pageNum - 1;
  if (pages[pageIdx]?.cached) return;

  pages[pageIdx] = { gid: String(ch.id), pageNum, url, cached: true };
  ch.missing = Math.max(0, ch.missing - 1);
  _pageIdxByUrl.set(url, pageIdx);
  if (_chapters[_curChIdx] === ch) scrubSegments.children[pageNum - 1]?.classList.add('cached');
  for (const prefix of ['o:', 't:', 'b:']) {
    const old = _pageUrlCache.get(prefix + url);
    if (old) { try { URL.revokeObjectURL(old); } catch {} }
    _pageUrlCache.delete(prefix + url);
  }

  const thumb = thumbStrip.querySelector(`.thumb-item img[data-idx="${pageIdx}"]`);
  if (thumb) {
    delete thumb.dataset.queued;
    if (thumbsOpen) _enqueueThumb(thumb);
  }
  _scheduleThumbWarm();

  if (mode === 'strip') {
    const localIdx = pageIdx - _viewBase;
    if (localIdx >= 0 && localIdx < _viewCount) {
      _stripWraps[localIdx]?.classList.remove('page-placeholder');
      if (localIdx >= _winLo && localIdx <= _winHi) {
        void _mountOne(localIdx, _stripGen, false);
      }
    }
  } else {
    const shown = mode === 'double' ? _spreadAt(currentPage) : { lead: currentPage };
    if (shown.lead === pageIdx + 1 || shown.trail === pageIdx + 1) void goTo(currentPage, true);
  }
}

// ── Growing chapters ──
// A chapter whose length isn't known yet holds as many slots as its highest cached page (one
// loading slot when it has none). A later page, or a total arriving in its metadata, grows it. The
// merged list, every later chapter's start and the view change together in one debounced step —
// the reader stays on the page it was on — and the pages held for it fill in afterwards.
const _growth = new Map();   // chapter id → { upTo, events }
let _growthTimer = null;

function _queueGrowth(ch, event) {
  const id = String(ch.id);
  const g = _growth.get(id) || { upTo: 0, events: [] };
  if (event) { g.upTo = Math.max(g.upTo, event.pageNum); g.events.push(event); }
  _growth.set(id, g);
  if (!_growthTimer) _growthTimer = setTimeout(() => { _growthTimer = null; void _growChapters(); }, 250);
}

async function _growChapters() {
  const jobs = [..._growth];
  _growth.clear();
  const sizes = new Map();
  for (const [id, { upTo }] of jobs) {
    const ch = _chapters.find(c => String(c.id) === id);
    if (!ch?.growing) continue;
    const meta = await api.meta.get(id).catch(() => null);
    const total = Number(meta?.numPages);
    if (meta) ch.meta = meta;
    if (Number.isSafeInteger(total) && total > 0) ch.growing = false;
    const size = Math.max(ch.count, upTo, ch.growing ? 0 : total);
    if (size > ch.count) sizes.set(ch, size);
  }
  if (sizes.size) _resizeChapters(sizes);
  for (const [, { events }] of jobs) events.forEach(_handlePageStored);
}

// Give each chapter in `sizes` (chapter → new slot count) that many slots and keep the reader
// where it was: the same page of the same chapter — or, in a chapter entered backwards and still on
// its last page, its new last page — and in the strip the same scroll offset. Strip rows are
// inserted in place (no rebuild), so pages on screen never flash while totals arrive.
function _resizeChapters(sizes) {
  const at = _chapterAt(currentPage);
  const cur = _chapters[at];
  const atLocal = currentPage - cur.start;
  const atEnd = cur.entry === 'end' && atLocal === cur.count;
  const anchor = mode === 'strip' ? _stripWraps[currentPage - _viewBase - 1]?.getBoundingClientRect().top : null;
  const ratios = new Map(_pageRatios);
  _pageRatios.clear();
  const grown = [];
  const next = [];
  for (const ch of _chapters) {
    const slots = pages.slice(ch.start, ch.start + ch.count);
    for (let i = 0; i < slots.length; i++) {
      const r = ratios.get(ch.start + i);
      if (r) _pageRatios.set(next.length + i, r);
    }
    const size = sizes.get(ch) || ch.count;
    if (size > ch.count) grown.push({ ch, oldEnd: ch.start + ch.count, from: ch.count, to: size });
    for (let n = ch.count + 1; n <= size; n++) slots.push({ gid: String(ch.id), pageNum: n, url: null, cached: false });
    ch.missing += size - ch.count;
    ch.count = size;
    ch.start = next.length;
    next.push(...slots);
  }
  pages = next;
  _pageIdxByUrl.clear();
  pages.forEach((p, i) => { if (p.url) _pageIdxByUrl.set(p.url, i); });
  const before = currentPage;
  currentPage = cur.start + (atEnd ? cur.count : atLocal);
  _curChIdx = -1;   // re-apply the chapter chrome: the scrubber's range may have changed
  if (mode === 'strip') {
    _growStripRows(grown);
    const top = _stripWraps[currentPage - _viewBase - 1]?.getBoundingClientRect().top;
    if (anchor != null && top != null) window.scrollBy(0, top - anchor);
    else _scrollStripToCurrent();
  } else if (_pageDivider !== null) {
    _showPageDivider(_pageDivider);   // stay on the transition card, now at its chapter's new end
  } else if (atEnd) {
    goTo(currentPage, true);
  }
  updateCounter();
  _syncThumbScope();
  highlightThumb(currentPage - 1);
  if (atEnd && currentPage !== before) _announceCurrentPage();   // fetch from the end, where the reader is
}

// Insert the new rows of grown chapters (each { ch, oldEnd: its old last global page number, from,
// to }) after their old last rows — before any chapter divider — then renumber every row. Rows on
// screen keep their element and image. Chapters outside the strip's scope have no rows to grow.
function _growStripRows(grown) {
  ++_stripGen;               // in-flight loads were aimed at the old row indices
  _stripAnnouncedPage = -1;
  // Find every target row first: inserted rows carry new numbers that an old one may share.
  const targets = grown.map(g => ({ ...g, last: stripView.querySelector(`.page-wrap[data-page="${g.oldEnd}"]`) }));
  for (const { ch, from, to, last } of targets) {
    if (!last) continue;
    const rows = [];
    for (let n = from; n < to; n++) rows.push(_makeStripRow(ch.start + n));
    last.after(...rows);
  }
  const scope = _stripScope();
  _viewBase  = scope.base;
  _viewCount = scope.count;
  _stripWraps = [...stripView.querySelectorAll('.page-wrap')];
  _stripImgs  = _stripWraps.map(w => w.firstElementChild);
  _stripWraps.forEach((w, i) => { w.dataset.page = _viewBase + i + 1; });
  _mountedIdx.clear();
  _stripImgs.forEach((img, i) => { if (img.getAttribute('src')) _mountedIdx.add(i); });
  _lastSyncCenter = Infinity;
  _syncStripWindow();
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
  else if (event?.kind === 'translate') _onTranslateEvent(event);
});

// A chapter whose length isn't known yet often learns it from its metadata before any of its pages
// arrive — so every chapter can be laid out ahead of reading it.
api.events.watch((gid) => {
  for (const ch of _chapters) if (ch.growing && (gid === '*' || String(ch.id) === gid)) _queueGrowth(ch, null);
});

// ── A page on its own: properties, translation, settings (right-click, or I) ──
// Which page is under a point: strip rows carry their number; the single view shows the current
// page, and the double view the two halves of its spread (a blank half is no page).
function _pageAtPoint(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.matches?.('#stripView .page-wrap[data-page]')) return Number(el.dataset.page);
    const img = el.matches?.('.page-wrap') ? el.querySelector(':scope > img') : el;
    if (img === mainImg && mode === 'single') return currentPage;
    if (img === imgLeft && mode === 'double') return _spreadAt(currentPage).lead || null;
    if (img === imgRight && mode === 'double') return _spreadAt(currentPage).trail || null;
  }
  return null;
}

// A page's place for display: its chapter, its number within it, and the chapter's gallery.
// "Ch. 12" / "Vol. 3".
const _memberLabel = (ch) => t(ch.kind === 'volume' ? 'rd.vol_n' : 'rd.ch_n', { n: ch.num });

function _pagePlace(n) {
  const ch = _chapters[_chapterAt(n)];
  return { ch, gid: String(ch?.id ?? galleryId), number: ch ? n - ch.start : n, total: ch ? ch.count : pages.length,
    chapter: _series && ch ? [_memberLabel(ch), ch.title].filter(Boolean).join(' · ') : null };
}

function _openProperties(n) {
  const page = pages[n - 1];
  if (!page?.cached) return;
  _stopScroll();
  const { number, total, chapter } = _pagePlace(n);
  openPageProperties({ gid: page.gid, pageNum: page.pageNum, url: page.url, number, total, chapter });
}

const _pageJobs = new Map();   // gallery id → page number (in its chapter) being translated on its own

async function _translationRunning(gid) {
  if (await platform.translateResume.get(gid)) return true;
  return (await platform.jobsPending.all()).some(entry => entry.key === `${gid}:translate`);
}

async function _openPageMenu(n, x, y) {
  const page = pages[n - 1];
  const { gid, number } = _pagePlace(n);
  const [record, busy] = await Promise.all([api.pages.get(gid, number).catch(() => null), _translationRunning(gid)]);
  const own = !!record?.own;
  openPageMenu(x, y, [t('page.menu_title', { n: formatCount(number) }), own ? t('page.keeps_own') : ''].filter(Boolean).join(' · '), [
    { label: t('page.translate'), detail: t(busy ? 'page.translate_busy' : 'page.translate_detail'), disabled: busy,
      onPick: () => _translatePage(gid, page.url, number) },
    ...(own ? [{ label: t('page.follow'), detail: t('page.follow_detail'), onPick: async () => {
      await platform.rpc({ type: 'FOLLOW_GALLERY_SETTINGS', galleryId: gid, urls: [page.url] });
      pageStatus(t('page.now_follows', { n: formatCount(number) }));
    } }] : []),
    { label: t('page.properties'), detail: t('page.properties_detail'), kbd: 'I', onPick: () => _openProperties(n) },
  ]);
}

async function _translatePage(gid, url, number) {
  const resp = await platform.rpc({ type: 'TRANSLATE_PAGES', galleryId: gid, urls: [url] }).catch(() => null);
  if (resp?.busy) { pageStatus(t('page.busy'), { error: true }); return; }
  if (!resp?.started) { pageStatus(t('page.failed', { n: formatCount(number), error: t('page.not_started') }), { error: true }); return; }
  _pageJobs.set(gid, number);
  pageStatus(t('page.translating', { n: formatCount(number) }), { busy: true });
}

// A translation of a chapter on screen finished (on its own page or the whole gallery): show it.
function _onTranslateEvent(event) {
  const gid = String(event.gid);
  if (!_chapters.some(ch => String(ch.id) === gid)) return;
  const number = _pageJobs.get(gid);
  if (event.status === 'done') {
    void _refreshTranslations(gid);
    if (number != null) pageStatus(t('page.done', { n: formatCount(number) }));
  } else if (event.status === 'error' && number != null) {
    pageStatus(t('page.failed', { n: formatCount(number), error: event.errorKey ? t(event.errorKey) : event.error || '' }), { error: true });
  } else if (event.status === 'cancelled' && number != null) {
    pageStatus(t('page.cancelled', { n: formatCount(number) }));
  } else return;
  _pageJobs.delete(gid);
}

async function _refreshTranslations(gid) {
  const ch = _chapters.find(c => String(c.id) === gid);
  if (!ch) return;
  ch.meta = (await api.meta.get(gid).catch(() => null)) || ch.meta;
  _translateAvailable = _chapters.some(c => !!c.meta?.translated);
  const urls = new Set(pages.slice(ch.start, ch.start + ch.count).map(p => p?.url).filter(Boolean));
  const stale = [];
  for (const url of urls) {
    for (const prefix of ['t:', 'b:']) {
      const u = _pageUrlCache.get(prefix + url);
      if (u) stale.push(u);
      _pageUrlCache.delete(prefix + url);
    }
  }
  forgetStudy(urls);
  await loadStudyRecords([gid]);
  hasStudy = hasAnyStudy();
  _syncStudyAvailability();
  if (mode === 'strip') _stripImgs.forEach((img, i) => { if (urls.has(pages[_viewBase + i]?.url)) delete img.dataset.vk; });
  _swapVisibleVariant();
  _refreshBubbleLayers();
  setTimeout(() => stale.forEach(u => URL.revokeObjectURL(u)), 5000);   // after the swap has decoded
}

viewport.addEventListener('contextmenu', (e) => {
  if (e.shiftKey) return;   // Shift+right-click: the browser's own menu
  const n = _pageAtPoint(e.clientX, e.clientY);
  if (!n || !pages[n - 1]?.cached) return;
  e.preventDefault();
  _stopScroll();
  void _openPageMenu(n, e.clientX, e.clientY);
});

// Double-page spreads are paired from each chapter's first page and never straddle a chapter
// boundary (the transition card must appear before the next chapter's first page, not after it
// has already been shown). The cover offset pairs from a blank page before the first page instead.
// Returns the page number in each half of the spread holding page n — `lead` is read first — with
// 0 for a white blank half: the page before the first (lead, with the cover offset), or the one
// beside a chapter's lone last page (trail), which keeps that page on its own side instead of
// shifting the pairing.
function _spreadAt(n) {
  const ch = _chapters[_chapterAt(n)];
  const start = ch ? ch.start : 0;
  const end = ch ? ch.start + ch.count : pages.length;
  const off = readerCoverOffset ? 1 : 0;
  const lead = start + 1 - off + 2 * Math.floor((n - start - 1 + off) / 2);
  return { lead: lead > start ? lead : 0, trail: lead + 1 <= end ? lead + 1 : 0 };
}
// Where goTo(n) settles: clamped to the series and, in double mode, on the first page of n's spread.
function _landingPage(n) {
  n = Math.max(1, Math.min(pages.length, n));   // chapters are continuous; only the series clamps
  if (mode !== 'double') return n;
  const { lead, trail } = _spreadAt(n);
  return lead || trail;
}
// The raw target of one flip forward (dir 1) or back (−1): the adjacent page, or in double mode
// the page just past the current spread on that side — goTo lands on the spread holding it.
function _flipTarget(dir) {
  if (mode !== 'double') return currentPage + dir;
  const { lead, trail } = _spreadAt(currentPage);
  return dir > 0 ? (trail || lead) + 1 : (lead || trail) - 1;
}
// Jump to a merged page number in whatever the current mode is: strip lands there instantly
// (re-scoping a chapter-only strip if needed), page modes flip straight there — no transition page.
// A jump lands at a page chosen outright, so it enters a chapter at its start whichever way it
// moved (see _applyChapterChrome). Both paths apply the chapter chrome before their first await.
let _jumping = false;
function _jumpToPage(n) {
  _jumping = true;
  try { if (mode === 'strip') _stripJumpTo(n); else goTo(n, true); }
  finally { _jumping = false; }
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
        <span class="chd-num">${c ? _escR(_memberLabel(c)) : '—'}</span>
      </span>
      ${dir > 0 ? CHD_NEXT_SVG : ''}
    </button>`;
  el.innerHTML = `
    <div class="chd-end">${_escR(t(ch.kind === 'volume' ? 'rd.end_of_vol' : 'rd.end_of_ch', { n: ch.num }))}</div>
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
  _thumbsFollowPage(currentPage - 1);
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
  if (!_chapterDividersOn) return false;
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

// A page's view is as tall as the window (100vh), and on a phone that is the window without the
// browser's address bar: with the bar out, the page has the bar's height to spare, which the browser
// keeps for sliding the bar away. Scrolled into by script, Firefox on Android moves its layout without
// the screen, and then stops painting what's fixed along the bottom (the rail's icons, the progress
// bar) until something repaints it. So a turn never scrolls into that room. (100vh as the pages are
// sized; on a desktop it is the window, and this changes nothing.)
const _vhProbe = document.body.appendChild(document.createElement('div'));
_vhProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100vh;visibility:hidden;pointer-events:none';

function _scrollPageModeToStart() {
  if (!readerPinned) _hideReaderNav();
  const navH = topbar?.offsetHeight || parseInt(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'), 10) || 54;
  const inner = mode === 'double' ? doubleInner : mode === 'single' ? singleInner : null;
  if (!inner) { window.scrollTo(0, 0); return; }
  const innerTop = inner.getBoundingClientRect().top + window.scrollY;
  // (scrollHeight is a whole number, 100vh rarely is: down, so a fraction left over isn't scrolled into.)
  const end = Math.max(0, Math.floor(document.documentElement.scrollHeight - Math.max(window.innerHeight, _vhProbe.getBoundingClientRect().height)));
  window.scrollTo(0, Math.min(end, Math.max(0, Math.round(innerTop - (_pinOffset() ? navH : 0)))));
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
  // A flip past the series' first or last page lands where it already is: leave the page and its
  // overlays alone rather than rebuilding them in place.
  if (!skipDivider && _pageDivider === null && mode !== 'strip' && _landingPage(n) === currentPage) return;
  if (_pageDivider !== null) _hidePageDivider();          // any other navigation dismisses it
  const nav = _beginPageNav();
  n = _landingPage(n);
  currentPage = n;
  _lastTurnAt = performance.now();

  // Page modes swap page, overlays and scroll together. A warm page (a normal flip: its
  // neighbours are decoded ahead) has its overlay's images decoded already, so everything lands
  // in one frame — the old overlay never sits on the new page, and the new one never paints
  // before its images. A cold one (a fast click-wheel scrub past the warm pages, a first open)
  // shows at once instead; its overlay follows once its images are decoded, the old one dropped
  // right away. Waiting on a cold page would leave a quick scrub showing nothing at all.
  try {
    // Update navigation UI immediately; image loads asynchronously below
    updateCounter();
    _evictFarUrls(n - 1);
    highlightThumb(n - 1);
    _thumbsFollowPage(n - 1);

    if (mode === 'single') {
      const url = await pageBlobUrl(pages[n - 1]);
      if (currentPage !== n || mode !== 'single') return;
      const cold = _whenDecoded([url, ..._overlayImageUrls(n)]);
      _scrollPageModeWhenImgsLoad([mainImg], nav);
      const placeholder = _showPageImage(mainImg, url);
      singleInner.classList.toggle('page-placeholder', placeholder);
      _scrollPageModeToStart();
      _warmNeighbors(n);
      if (cold) {
        _clearBubbleLayers();
        await cold;
        if (currentPage !== n || mode !== 'single') return;
      }
      if (_bubbleLayersOn()) _refreshBubbleLayers();
      await _waitForImgLayout([mainImg]);
      if (currentPage !== n || mode !== 'single') return;
      _scrollPageModeToStart();
    } else if (mode === 'double') {
      const { lead, trail } = _spreadAt(n);
      const [lUrl, rUrl] = await Promise.all([lead, trail].map(p => p ? pageBlobUrl(pages[p - 1]) : ''));
      if (currentPage !== n || mode !== 'double') return;
      const cold = _whenDecoded([lUrl, rUrl, lead && trail ? '' : _defaultBlankSrc(),
        ...(lead ? _overlayImageUrls(lead) : []), ...(trail ? _overlayImageUrls(trail) : [])]);
      const pageImgs = [lead && imgLeft, trail && imgRight].filter(Boolean);
      _scrollPageModeWhenImgsLoad(pageImgs, nav);
      const leftPlaceholder  = _showSpreadHalf(imgLeft, lead, lUrl);
      const rightPlaceholder = _showSpreadHalf(imgRight, trail, rUrl);
      doubleInner.classList.toggle('left-placeholder', leftPlaceholder);
      doubleInner.classList.toggle('right-placeholder', rightPlaceholder);
      _scrollPageModeToStart();
      _warmNeighbors(n);
      if (cold) {
        _clearBubbleLayers();
        await cold;
        if (currentPage !== n || mode !== 'double') return;
      }
      if (_bubbleLayersOn()) _refreshBubbleLayers();
      await _waitForImgLayout(pageImgs);
      if (currentPage !== n || mode !== 'double') return;
      if (!lead) _shapeBlankLike(imgLeft, imgRight);
      if (!trail) _shapeBlankLike(imgRight, imgLeft);
      _scrollPageModeToStart();
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
    segment.dataset.n = formatCount(i + 1);   // the number the pill shows over it
    fragment.appendChild(segment);
  }
  scrubSegments.replaceChildren(fragment);
  _noteLoaded();
  bottombar.setAttribute('aria-valuemax', ch.count);
  _barTip = -1;
  scrubTip.classList.remove('show');
  _scrubShown = null;
  _syncBarDensity();
}

// The page being read is the active segment (both pages of a shown spread), the pages before it
// are visited; exactly what the screen shows is the band over them (_syncScrubView). Only the
// segments between the old and new position change, so only those are touched — a scrub through a
// long chapter moves the page every frame.
let _scrubShown = null;   // [first, last] local segments marked active
function _updateScrubSegments(ch) {
  const spread = mode === 'double' && _pageDivider === null ? _spreadAt(currentPage) : null;
  const shown = spread ? [spread.lead, spread.trail].filter(Boolean) : [currentPage];
  const base = ch ? ch.start + 1 : 1;
  const first = Math.min(...shown) - base, last = Math.max(...shown) - base;
  const segs = scrubSegments.children;
  const from = _scrubShown ? Math.max(0, Math.min(first, _scrubShown[0])) : 0;
  const to = _scrubShown ? Math.min(segs.length - 1, Math.max(last, _scrubShown[1])) : segs.length - 1;
  for (let i = from; i <= to; i++) {
    segs[i].classList.toggle('visited', i < first);
    segs[i].classList.toggle('active', i >= first && i <= last);
  }
  _scrubShown = [first, last];
  bottombar.setAttribute('aria-valuenow', first + 1);
  _scheduleScrubView();
}

function updateCounter() {
  const chIdx = _chapterAt(currentPage);
  if (chIdx !== _curChIdx) _applyChapterChrome(chIdx);
  const ch = _chapters[chIdx];
  const label = ch
    ? `${formatCount(currentPage - ch.start)} / ${formatCount(ch.count)}`
    : `${formatCount(currentPage)} / ${formatCount(pages.length)}`;
  pageCounter.textContent = label;
  _syncSideChapter();
  _updateScrubSegments(ch);
  _scheduleThumbWarm();   // the pages nearest the new one get their thumbnails next
  _syncUrl();
}

// Point the topbar (gallery #, title, source link), document title, scrubber range and the URL at
// the chapter the current page belongs to — so a merged series still reads as its own galleries.
function _applyChapterChrome(idx) {
  const ch = _chapters[idx];
  if (!ch) return;
  const wasApplied = _curChIdx !== -1;
  // Which way the reader came in: from a later chapter means at its end, so a chapter that grows
  // while it's read keeps the reader on its last page (_resizeChapters).
  if (wasApplied && idx !== _curChIdx) ch.entry = !_jumping && idx < _curChIdx ? 'end' : 'start';
  _curChIdx = idx;
  const meta = ch.meta;
  const displayId = meta?.sourceId || ch.id;
  tbGallery.textContent = `#${displayId}`;
  tbGallery.classList.toggle('local', !!meta?.isLocalImport);
  document.title = `Shiori — #${displayId}`;
  const visitUrl = safeExternalUrl(galleryLink(meta, 1, displayId));
  tbMeta.onclick = visitUrl ? () => window.open(visitUrl, '_blank', 'noopener') : null;
  const titleEl = document.getElementById('tbTitle');
  if (titleEl) titleEl.textContent = (meta && pickTitle(meta, getLang())) || '';
  _renderScrubSegments(ch);
  _syncThumbScope();   // chapter-scoped thumbnails follow the chapter under the reading line
  _recomputeFold();   // the title just changed width → re-measure the fold breakpoint
}

// The address follows the page being read — ?g= its chapter, ?page= the page within it — so a reload
// or a copied link lands there. It's replaced in place, never a history entry, and at most every
// URL_SYNC_MS: a scrub changes the page every frame, and browsers throttle rapid replaceState calls.
// The page it settles on always lands. Resolved against location.href, never the <base>. Live only
// once the reader has opened on the page it was asked for (_urlLive).
const URL_SYNC_MS = 100;
let _urlSyncTimer = null, _urlSyncedAt = 0, _urlLive = false;
function _syncUrl() {
  if (!_urlLive || _urlSyncTimer) return;
  _urlSyncTimer = setTimeout(() => {
    _urlSyncTimer = null;
    _urlSyncedAt = performance.now();
    const ch = _chapters[_chapterAt(currentPage)];
    if (!ch) return;
    try {
      const u = new URL(location.href);
      u.searchParams.set('g', String(ch.id));
      u.searchParams.set('page', String(currentPage - ch.start));
      u.searchParams.delete('p');
      if (u.href !== location.href) history.replaceState(history.state, '', u);
    } catch {}
  }, Math.max(0, _urlSyncedAt + URL_SYNC_MS - performance.now()));
}

// Thumbnails cover a SCOPE of the merged list: the whole series when the strip flows the series
// continuously, the current chapter everywhere else (single/double, and the per-chapter strip).
// Items are indexed locally; callers keep passing GLOBAL 0-based page indices.
let _thumbItems = [];      // materialized .thumb-item elements (local index within the scope)
let _thumbBase  = 0;       // global page offset of the tracked thumbnail scope
let _thumbCount = 0;       // page count of the tracked thumbnail scope
let _activeThumbIdx = -1;  // local index
function highlightThumb(idx) {
  const local = idx - _thumbBase;
  if (local === _activeThumbIdx) return;
  if (_activeThumbIdx >= 0) _thumbItems[_activeThumbIdx]?.classList.remove('active');
  _activeThumbIdx = (local >= 0 && local < _thumbItems.length) ? local : -1;
  if (_activeThumbIdx >= 0) _thumbItems[_activeThumbIdx].classList.add('active');
}

// ── Lazy follow ──
// Outside a scrub the thumbnails follow the reader lazily. Moving the strip yourself (a swipe, the
// wheel over it, a thumb clicked, a scrub) leaves it where you put it, and as the reader moves only
// the highlight moves along. Carried out toward an edge of the strip, the point the strip follows
// (the indicator in the strip, the active thumb in the page modes) pushes the strip ahead of it, so
// half of the next thumb always shows beyond it. Once the reader carries that point to or across the
// strip's centre, the strip keeps it centred from then on, as far as its ends allow. A jump that
// leaves the active thumb wholly out of view (or a move with it already out of view) puts it in the
// centre at once.
let _thumbFollow  = false;   // keeping the followed point centred
let _thumbFollowX = null;    // the followed point at the reader's last move (strip content px)
let _thumbPick    = null;    // the strip row a clicked thumb glides the pages to

function _stopThumbFollow() {
  _thumbFollow = false;
  _thumbFollowX = null;
}

// The reader moved; x is the middle of the followed point now, a thumb wide. The strip moves at once:
// page flips are instant, and in the strip the page's own scrolling moves it a little at a time.
function _followReader(x) {
  const w = thumbStrip.clientWidth, left = thumbStrip.scrollLeft, centre = left + w / 2;
  // On the way to a clicked thumb it's the click, not the reader, that carries the point across.
  const picking = _glideEl !== null && _glideEl === _thumbPick;
  const was = _thumbFollowX === null ? 0 : _thumbFollowX - centre, now = x - centre;
  const reached = !picking && Math.abs(was) >= 0.5 && (Math.abs(now) < 0.5 || Math.sign(now) !== Math.sign(was));
  const stepped = _thumbFollowX !== null && Math.abs(x - _thumbFollowX) <= w / 2;   // a step, not a jump
  _thumbFollowX = picking ? null : x;
  if (reached) _thumbFollow = true;
  let to = null;
  const active = _thumbItems[_activeThumbIdx];
  if (active && !_thumbFollow) {
    const aL = active.offsetLeft, aR = aL + active.offsetWidth;
    const half = active.offsetWidth / 2, lead = half + (parseFloat(getComputedStyle(thumbStrip).columnGap) || 0);
    if ((aR <= left || aL >= left + w) && !stepped) _thumbFollow = true;
    else if (x + half + lead > left + w) to = x + half + lead - w;   // pushing the strip on to the right
    else if (x - half - lead < left) to = x - half - lead;           // or to the left
  }
  if (_thumbFollow) to = x - w / 2;
  if (to === null) return;
  to = Math.max(0, Math.min(thumbStrip.scrollWidth - w, to));
  if (Math.abs(to - left) < 0.5) return;
  cancelAnimationFrame(_swipeRaf);
  cancelAnimationFrame(_wheelRaf); _wheelRaf = null; _wheelTarget = null;
  thumbStrip.scrollLeft = to;
}

// A page mode moved to page idx (global). The strip follows the page scroll instead (_setIndicator).
function _thumbsFollowPage(idx) {
  if (mode === 'strip' || _thumbDragging || !thumbsOpen) return;
  const t = _thumbItems[idx - _thumbBase];
  if (t) _followReader(t.offsetLeft + t.offsetWidth / 2);
}

// Opened, or rebuilt for another scope: the followed point goes to the centre, followed from there.
function _centreThumbsOnReader() {
  if (!thumbsOpen || _thumbDragging) return;
  _thumbFollow = true;
  _thumbFollowX = null;
  if (mode === 'strip') { _setIndicator(_scrollYToProportion(window.scrollY + _pinOffset())); return; }
  const t = _thumbItems[_activeThumbIdx];
  if (t) _followReader(t.offsetLeft + t.offsetWidth / 2);
}

// Single source of truth for the current page: the page at the scrubber position — the reading
// line (the navbar bottom when pinned) mapped through the SAME proportion that places the strip's
// fill indicator. Driving the counter and the active-thumb border from this (rather than a
// separate area metric) keeps the border tracking the fill, and makes it flip symmetrically when
// stepping between adjacent pages in either direction.
// Rounding moves on once the reading line is halfway down a page — but a page taller than the screen
// still fills it then, with the next one not even in view. So the next page takes over only once it
// shows at least as much of the screen as the page at the reading line: the current page is always
// one the screen shows (and the progress bar's band covers).
function _setCurrentPageFromProportion(p) {
  const n = _viewCount;   // proportion is over the strip's scoped range, not the whole series
  if (!n) return;
  const at = Math.min(n - 1, Math.max(0, p * (n - 1)));
  let row = Math.round(at);
  if (row > Math.floor(at) && _stripRowShows(row) < _stripRowShows(row - 1)) row--;
  const pg = _viewBase + row + 1;
  if (pg === currentPage) return;
  currentPage = pg;
  updateCounter();
  highlightThumb(pg - 1);
}

// ── Thumbnails ──
// Track the scope cheaply while closed, and materialize its DOM only when the strip opens. Only
// thumbs in the visible area (or its preload margin) get a src, keeping decoded bitmaps bounded.
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
  const changed = s.base !== _thumbBase || s.count !== _thumbCount;
  if (!changed && (!thumbsOpen || _thumbItems.length)) return false;
  _thumbBase = s.base;
  _thumbCount = s.count;
  if (!thumbsOpen) {
    if (changed && _thumbItems.length) {
      thumbStrip.replaceChildren();
      _thumbItems = [];
      _thumbViewport = null;
      _activeThumbIdx = -1;
    }
    return false;
  }
  buildThumbs();
  _enqueueAllThumbs();
  _prioritizeVisibleThumbs();
  if (mode === 'strip') _centreThumbsOnReader();
  else setTimeout(_centreThumbsOnReader, 100);
  return true;
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
    // A copy let go meanwhile can't load: show nothing rather than a broken image, and ask again.
    img.addEventListener('error', () => { img.removeAttribute('src'); delete img.dataset.queued; });
    div.appendChild(img);
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = i + 1;           // numbering is scope-local (chapter page or series page)
    div.appendChild(num);
    thumbStrip.appendChild(div);
    _thumbItems.push(div);
  }
  highlightThumb(Math.min(s.base + s.count, Math.max(s.base + 1, currentPage)) - 1);

  // Generation is NOT started here: thumbs are enqueued when the strip opens (visible-first), and
  // the warm-up has usually made them all by then (_scheduleThumbWarm).
}


// Show a thumb's copy when there is one; ask for one (or a larger one, after the strip grew) when not.
function _enqueueThumb(img) {
  const page = pages[parseInt(img.dataset.idx)];
  if (!page?.cached || !page.url) return;
  const cached = _cachedThumb(page.url);
  if (cached && !img.getAttribute('src')) img.src = cached.url;
  if (img.dataset.queued || (cached && cached.width >= _thumbWidth())) return;
  img.dataset.queued = '1';
  _generateThumbBlob(page).then(url => {
    if (url && img.isConnected && img.dataset.queued && img.getAttribute('src') !== url) img.src = url;
  });
}

// The strip was made taller than its copies were made for: remake the ones it shows (the warm-up
// remakes the rest). Each thumb keeps its current copy until the larger one lands.
function _refreshThumbSizes() {
  thumbStrip.querySelectorAll('.thumb-item img[data-queued]').forEach(img => { delete img.dataset.queued; });
  if (thumbsOpen) {
    _enqueueAllThumbs();
    _prioritizeVisibleThumbs();
  }
  _scheduleThumbWarm();
}

function _enqueueAllThumbs() {
  thumbStrip.querySelectorAll('.thumb-item img').forEach(_enqueueThumb);
}

// The thumbs (local indices, first to last) that reach into [lo, hi] of the strip's content. Every
// thumb is as wide as the first and the gaps are even, so it's arithmetic: measuring each thumb in
// turn ran a fresh layout per thumb whenever showing one (a src set) had changed the page in between,
// on every frame the strip scrolled.
function _thumbsWithin(lo, hi) {
  const n = _thumbItems.length;
  if (!n) return [0, -1];
  const a = _thumbItems[0].offsetLeft, w = _thumbItems[0].offsetWidth;
  const pitch = n > 1 ? _thumbItems[1].offsetLeft - a : w || 1;
  return [Math.max(0, Math.ceil((lo - w - a) / pitch)), Math.min(n - 1, Math.floor((hi - a) / pitch))];
}

// Long series: enqueue only thumbs within ± one strip-width of the visible band.
function _enqueueNearbyThumbs() {
  if (!thumbsOpen) return;
  const [first, last] = _thumbsWithin(thumbStrip.scrollLeft - thumbStrip.clientWidth, thumbStrip.scrollLeft + 2 * thumbStrip.clientWidth);
  for (let i = first; i <= last; i++) {
    const img = _thumbItems[i].querySelector('img');
    if (img) _enqueueThumb(img);
  }
}

// Move currently-visible thumbs to the front of the generation queue.
function _prioritizeVisibleThumbs() {
  const [first, last] = _thumbsWithin(thumbStrip.scrollLeft, thumbStrip.scrollLeft + thumbStrip.clientWidth);
  const visibleUrls = new Set();
  for (let i = first; i <= last; i++) {
    const img = _thumbItems[i].querySelector('img');
    if (img && !img.getAttribute('src')) visibleUrls.add(pages[parseInt(img.dataset.idx)]?.url);
  }
  if (!visibleUrls.size) return;
  const prioritized = _thumbGenQueue.filter(e => visibleUrls.has(e.page.url));
  const rest        = _thumbGenQueue.filter(e => !visibleUrls.has(e.page.url));
  _thumbGenQueue.length = 0;
  _thumbGenQueue.push(...prioritized, ...rest);
}

// `persist` false: a passing open (a scrub dragged out of the progress bar) leaves the saved state.
function setThumbsOpen(open, persist = true) {
  thumbsOpen = open;
  thumbStrip.classList.toggle('open', open);
  thumbBtn.classList.toggle('active', open);
  _syncSideNav();
  thumbResizeHandle.classList.toggle('show', open);
  document.body.classList.toggle('thumbs-open', open);   // lets the scroll-top button ride above it
  if (persist) platform.kv.set({ readerThumbsOpen: open });
  if (open) {
    const rebuilt = _syncThumbScope();
    if (!rebuilt) {
      _enqueueAllThumbs();
      _prioritizeVisibleThumbs();
    }
    // A scrub already under way places the strip itself.
    setTimeout(_centreThumbsOnReader, mode === 'strip' ? 50 : 250);
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
    _thumbFollowX = null;   // measured at the old size
  }
}

// ── Thumb strip ↔ page scroll sync ──────────────────────────────────────────
//
// Single source of geometry: _stripAnchors() reads the two endpoints once per call.
// proportion (0–1) is the shared currency between page scroll and strip position.
//
// Interaction model:
//   drag  → _dragToCursor  → positions indicator + scrolls page instantly
//   click → _clickSnapToThumb → scrolls page smoothly; the strip stays where it is (lazy follow)
//   scroll → _setIndicator → positions indicator; the strip follows lazily (_followReader)

function _stripAnchors() {
  const rect = thumbStrip.getBoundingClientRect();
  const z    = rect.width / (thumbStrip.offsetWidth || rect.width);
  // The indicator's full visual width: a thumb's (it may be cropped at the strip's end, see
  // _placeIndicator, so it isn't measured on the indicator itself).
  const iW   = (_thumbItems[0]?.offsetWidth ?? _thumbViewport?.offsetWidth ?? 0) * z;
  const thumbs = _thumbItems;   // cached .thumb-item array — same set as the DOM, no per-frame query
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
const _pinOffset = () => (readerPinned && readerNavLayout === 'top' ? TOPBAR_H : 0);

// The strip row (local index) whose top is at or above document y: the row y falls in, or the gap or
// chapter card after it. Measures the .page-wrap rows (positioned flex children of stripView) — each
// page-img sits inside its own relative wrap, so the wrap is the element whose offsetTop tracks
// scroll. _stripWraps is cached at build time; re-querying 1000+ rows per scroll frame is too slow.
function _stripRowAt(y) {
  let lo = 0, hi = _stripWraps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (_stripWraps[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// How much of the screen (below a pinned header) strip row idx fills, in px.
function _stripRowShows(idx) {
  const wrap = _stripWraps[idx];
  if (!wrap) return 0;
  const top = window.scrollY + _pinOffset(), bottom = window.scrollY + window.innerHeight;
  return Math.max(0, Math.min(bottom, wrap.offsetTop + wrap.offsetHeight) - Math.max(top, wrap.offsetTop));
}

// Map scrollY → proportion via page index, not linear interpolation.
// Finds which page top is at/above scrollY, then interpolates within that page gap.
// This keeps strip ↔ scroll in sync even when page heights vary. Past the last page's top it goes on
// through that page — beyond 1, up to _scrubEndP() — so the indicator follows it to its bottom.
function _scrollYToProportion(scrollY) {
  const imgs = _stripWraps;
  const n = imgs.length;
  if (n < 2) return Math.max(0, Math.min(1, scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)));
  const i = _stripRowAt(scrollY);
  if (i >= n - 1) {
    const last = imgs[n - 1];
    return (n - 1 + Math.max(0, Math.min(1, (scrollY - last.offsetTop) / Math.max(1, last.offsetHeight)))) / (n - 1);
  }
  const pageT = imgs[i].offsetTop, nextT = imgs[i + 1].offsetTop;
  const withinPage = Math.max(0, Math.min(1, (scrollY - pageT) / Math.max(1, nextT - pageT)));
  return (i + withinPage) / (n - 1);
}

// Map proportion → scrollY via page index.
// Proportion p = i/(n-1) lands at imgs[i].offsetTop; fractional part interpolates between pages.
// Beyond 1 it goes on down through the last page.
function _proportionToScrollY(p) {
  const imgs = _stripWraps;
  const n = imgs.length;
  if (n < 2) return Math.round(p * Math.max(1, document.documentElement.scrollHeight - window.innerHeight));
  const scaled = Math.max(0, Math.min(n, p * (n - 1)));
  if (scaled > n - 1) return Math.round(imgs[n - 1].offsetTop + (scaled - (n - 1)) * imgs[n - 1].offsetHeight);
  const i = Math.min(n - 2, Math.floor(scaled));
  const frac = scaled - i;
  return Math.round(imgs[i].offsetTop + frac * (imgs[i + 1].offsetTop - imgs[i].offsetTop));
}

// Where a scrub ends: the strip scrolled to its very end, which reaches down into the last page when
// that page is taller than what the screen shows of it (a proportion past 1); 1 otherwise.
function _scrubEndP() {
  if (mode !== 'strip' || _stripWraps.length < 2) return 1;
  const maxY = document.documentElement.scrollHeight - window.innerHeight;
  return Math.max(1, _scrollYToProportion(maxY + _pinOffset()));
}

// The proportion at which strip row idx's bottom meets the bottom of the screen — above the bottom
// bar, where the strip's own end puts its last page (#stripView's padding).
function _rowEndP(idx) {
  const row = _stripWraps[idx];
  const y = row.offsetTop + row.offsetHeight + parseFloat(getComputedStyle(stripView).paddingBottom) - window.innerHeight;
  return _scrollYToProportion(y + _pinOffset());
}

// Piecewise-linear map of x through control points [[x, y], …] (x ascending), clamped to the ends.
function _mapThrough(x, points) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    if (x <= x1) return x1 - x0 < 1e-6 ? y1 : y0 + (x - x0) * (y1 - y0) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

// Control points [[x, y], …] (an ascending path from the first to the last), bent to pass through
// `anchor` — the place a scrub picks up from after the page moved under it. Natural points that
// would make the path turn back are dropped; the ends always stay, so both stay reachable.
function _anchoredPath(points, anchor) {
  if (!anchor) return points;
  const [ax, ay] = anchor;
  const first = points[0], last = points[points.length - 1];
  const mid = points.slice(1, -1).filter(([x, y]) => (x < ax && y < ay) || (x > ax && y > ay));
  const path = [first, ...mid, [Math.max(first[0], Math.min(last[0], ax)), Math.max(first[1], Math.min(last[1], ay))], last];
  return path.sort((p, q) => p[0] - q[0]);
}

// The indicator's left edge is the top of the screen and its width a thumb's. Reading the last page
// down to its bottom takes it past the last thumb's left edge: what would stick out beyond the last
// thumb is cropped rather than widening the strip with empty space.
function _placeIndicator(contentLeft) {
  if (!_thumbViewport) return;
  _thumbViewport.style.left = contentLeft + 'px';
  const last = _thumbItems[_thumbItems.length - 1];
  const full = _thumbItems[0]?.offsetWidth || 0;
  const room = last ? last.offsetLeft + last.offsetWidth - contentLeft : full;
  _thumbViewport.style.width = full && room < full ? `${Math.max(0, room)}px` : '';
}

// State for strip interaction
let _dragGrabOffset    = null;
let _thumbDragging     = false;  // true while dragging — suppresses scroll→strip sync
let _scrubSetY         = null;   // where the scrub last put the page: any other scroll moved it
let _scrubCursorX      = null;   // the scrub's last pointer x
let _scrubAnchor       = null;   // [visual left, p] a strip scrub picks up from after the page moved

// Position the indicator at proportion p; the strip follows it lazily.
function _setIndicator(p) {
  const { z, iW, a, b } = _stripAnchors();
  const contentLeft = _proportionToContentLeft(p, a, b);
  _placeIndicator(contentLeft);
  _followReader(contentLeft + iW / (2 * z));
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
  _scrubCursorX = clientX;
  const pEnd = _scrubEndP();
  const overflowing = thumbStrip.scrollWidth > thumbStrip.offsetWidth + 1;
  let p, contentLeft;
  if (overflowing) {
    // The indicator travels between where the first thumb sits with the strip scrolled to its start
    // (lo) and where the last one sits scrolled to its end (hi), so either end of the drag reaches the
    // strip's true end, padding and all. Past hi the strip stays at its end and the indicator goes on
    // into the last thumb, down to the last page's bottom (pEnd): a thumb's travel per thumb's width,
    // squeezed into what's left of the strip when the pointer couldn't otherwise get there.
    const maxScrollX = Math.max(0, thumbStrip.scrollWidth - thumbStrip.offsetWidth);
    const lo = a * z, hi = Math.max(lo + 1, (b - maxScrollX) * z);
    const reach = Math.max(hi, rect.width - 1 - _dragGrabOffset);   // the pointer at the strip's last pixel
    const vEnd = hi + Math.min((pEnd - 1) * (b - a) * z, reach - hi);
    const visualLeft = Math.max(lo, Math.min(vEnd, clientX - rect.left - _dragGrabOffset));
    p = _mapThrough(visualLeft, _anchoredPath(vEnd > hi ? [[lo, 0], [hi, 1], [vEnd, pEnd]] : [[lo, 0], [hi, 1]], _scrubAnchor));
    contentLeft = _proportionToContentLeft(p, a, b);
    thumbStrip.scrollLeft = Math.max(0, Math.min(maxScrollX, contentLeft - visualLeft / z));
  } else {
    const end = b + (pEnd - 1) * (b - a);
    const left = Math.max(a, Math.min(end, (clientX - rect.left - _dragGrabOffset) / z));
    p = b > a ? _mapThrough(left, _anchoredPath([[a, 0], [end, pEnd]], _scrubAnchor && [_scrubAnchor[0] / z, _scrubAnchor[1]])) : 0;
    contentLeft = _proportionToContentLeft(p, a, b);
  }

  _placeIndicator(contentLeft);
  _scrubReaderTo(p);
}

// The page moved under a scrub (the wheel, the scrollbar): pick the scrub up from there instead of
// snatching the page back at the pointer's next move. The indicator goes to the page's place, kept
// under the pointer while the strip can pan, and the pointer's place becomes the point the scrub
// carries on from — both ends still within reach.
function _scrubFollowScroll() {
  _stopScrubEase();
  _scrubSetY = window.scrollY;
  const p = _scrollYToProportion(window.scrollY + _pinOffset());
  _setCurrentPageFromProportion(p);
  _scheduleStripSync();
  if (!_thumbItems.length) return;
  if (_barPress?.out) { _barFollowScroll(_barPress, p); return; }
  const { z, a, b } = _stripAnchors();
  const rect = thumbStrip.getBoundingClientRect();
  const contentLeft = _proportionToContentLeft(p, a, b);
  const visualLeft = (_scrubCursorX ?? rect.left + rect.width / 2) - rect.left - (_dragGrabOffset ?? 0);
  _scrubAnchor = [visualLeft, p];
  const maxScrollX = Math.max(0, thumbStrip.scrollWidth - thumbStrip.offsetWidth);
  thumbStrip.scrollLeft = Math.max(0, Math.min(maxScrollX, contentLeft - visualLeft / z));
  _placeIndicator(contentLeft);
}

// Scrubber mode driven from outside the strip (the progress bar): the indicator goes to thumb
// position t (local, fractional) — under clientX while the strip can pan, centred when there's no
// clientX — and the reader follows it. As in _dragToCursor, the indicator stays between the first
// thumb's place at the strip's start and the last one's at its end, so the screen's edges reach the
// strip's true ends.
function _scrubThumbsTo(t, clientX, moveReader = true) {
  const n = _thumbCount;
  if (!n || !_thumbItems.length) return;
  const pEnd = _scrubEndP();
  const p = n > 1 ? Math.max(0, Math.min(pEnd, t / (n - 1))) : 0;
  const { z, iW, a, b } = _stripAnchors();
  const rect = thumbStrip.getBoundingClientRect();
  const contentLeft = _proportionToContentLeft(p, a, b);
  _placeIndicator(contentLeft);
  const maxScrollX = Math.max(0, thumbStrip.scrollWidth - thumbStrip.offsetWidth);
  const lo = a * z, hi = Math.max(lo, (b - maxScrollX) * z) + (pEnd - 1) * (b - a) * z;
  const visualLeft = Math.max(lo, Math.min(hi, (clientX ?? rect.left + rect.width / 2) - rect.left - iW / 2));
  thumbStrip.scrollLeft = Math.max(0, Math.min(maxScrollX, contentLeft - visualLeft / z));
  if (moveReader) _scrubReaderTo(p);
}

// Move the reader to scrubber proportion p of the thumbnail scope.
function _scrubReaderTo(p) {
  if (mode === 'strip') {
    _easeScrubTo(p);
    _setCurrentPageFromProportion(p);   // keep the counter in step while scrubbing (border is hidden)
    _scheduleStripSync();   // the scroll listener skips syncing while _thumbDragging — do it here
  } else {
    const idx = Math.min(_thumbCount - 1, Math.round(p * (_thumbCount - 1)));
    const n = _thumbBase + idx + 1;
    if (n !== currentPage) goTo(n, true);
  }
}

// A scrub over tall pages moves them many pixels for each pixel the pointer moves. Jumping the page
// to every pointer step showed the steps, and easing out each step on its own still did on a slow
// drag (move, settle, move). So the page runs between the pointer's samples: from where it is to the
// newest target at a steady pace, arriving about when the next sample is due (the pointer's own pace,
// at most SCRUB_GAP_MAX), with a light ease on top to round off a fast sweep's jitter — so it never
// trails the pointer by more than about a tenth of a second. It aims at the scrub's proportion, not a
// scroll offset, so pages changing
// shape as they load on the way don't leave it short — at the strip's very end, at the live bottom.
// The counter and the indicator follow the pointer at once. Another scroll mid-scrub (the wheel) stops
// it (_scrubFollowScroll); a let-go scrub runs on to where it ended unless the wheel, a glide or a jump
// takes over first.
const SCRUB_EASE_MS = 30;                         // the light ease's time constant
const SCRUB_GAP_MIN = 1000 / 240, SCRUB_GAP_MAX = 100;   // the pointer's pace is read within these
let _scrubRaf = null, _scrubAt = 0, _scrubSampleAt = 0, _scrubGap = SCRUB_GAP_MAX;
let _scrubFromP = 0, _scrubToP = null, _scrubToEnd = false, _scrubRunAt = 0, _scrubRunMs = SCRUB_GAP_MAX;

// (A frame's timestamp can come before the moment the run began — clamped, never run backwards.)
const _scrubRunP = now => _scrubFromP + (_scrubToP - _scrubFromP) * Math.max(0, Math.min(1, (now - _scrubRunAt) / _scrubRunMs));

function _easeScrubTo(p) {
  const now = performance.now(), gap = now - _scrubSampleAt;
  _scrubSampleAt = now;
  const paced = Math.max(SCRUB_GAP_MIN, Math.min(SCRUB_GAP_MAX, gap));
  _scrubGap = gap > SCRUB_GAP_MAX ? paced : (_scrubGap + paced) / 2;   // after a pause, start afresh
  _scrubFromP = _scrubToP === null ? _scrollYToProportion(window.scrollY + _pinOffset()) : _scrubRunP(now);
  _scrubToP = p;
  _scrubToEnd = p >= _scrubEndP() - 1e-9;   // the strip's very end: wherever pages loading move it to
  _scrubRunAt = now;
  _scrubRunMs = _scrubGap;
  if (_scrubRaf) return;
  _scrubAt = now;
  _scrubRaf = requestAnimationFrame(_easeScrubFrame);
}
function _easeScrubFrame(now) {
  _scrubRaf = null;
  if (_scrubToP === null || mode !== 'strip') { _scrubToP = null; return; }
  if (_reshapePending.size) _reshapeRows();   // pages loaded since the last frame take their shapes before it aims
  const maxY = document.documentElement.scrollHeight - window.innerHeight;
  const yAt = p => Math.max(0, Math.min(maxY, _proportionToScrollY(p) - _pinOffset()));
  const ran = now - _scrubRunAt >= _scrubRunMs;
  const target = _scrubToEnd ? maxY : yAt(_scrubToP);              // where the pointer is
  const run = ran ? target : yAt(_scrubRunP(now));                  // where the run between samples is
  const y = run - (run - window.scrollY) * Math.exp(-Math.max(0, now - _scrubAt) / SCRUB_EASE_MS);
  _scrubAt = now;
  const from = window.scrollY;
  let done = ran && Math.abs(target - y) < 1;
  window.scrollTo({ top: done ? target : y, behavior: 'instant' });
  // The page scrolls in whole device pixels: once the run is over, a step finer than that doesn't
  // move it — settle instead.
  if (!done && ran && window.scrollY === from) { window.scrollTo({ top: target, behavior: 'instant' }); done = true; }
  if (_thumbDragging) _scrubSetY = window.scrollY;
  if (done) _scrubToP = null;
  else _scrubRaf = requestAnimationFrame(_easeScrubFrame);
}
function _stopScrubEase() {
  cancelAnimationFrame(_scrubRaf);
  _scrubRaf = _scrubToP = null;
}

// Click handler: navigate to the clicked thumb's page. The strip stays where it is, and follows
// lazily from there.
function _clickSnapToThumb(clientX) {
  const { z } = _stripAnchors();
  const rect     = thumbStrip.getBoundingClientRect();
  const contentX = (clientX - rect.left) / z + thumbStrip.scrollLeft;
  const thumbs   = _thumbItems;
  let idx = thumbs.length - 1;
  for (let i = 0; i < thumbs.length; i++) {
    if (contentX < thumbs[i].offsetLeft + thumbs[i].offsetWidth) { idx = i; break; }
  }

  _stopThumbFollow();
  if (mode === 'strip') {
    const stripImg = stripView.querySelector(`[data-page="${_thumbBase + idx + 1}"]`);
    if (!stripImg) return;
    // The glide follows the page as the rows on the way learn their heights; a smooth scrollTo
    // aims at where the page was at the click, and stops dead at the first scroll correction.
    _thumbPick = stripImg;
    _glideStripTo(stripImg);
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
    _stopThumbFollow();
    cancelAnimationFrame(_swipeRaf);
    cancelAnimationFrame(_wheelRaf); _wheelRaf = null; _wheelTarget = null;   // drag overrides wheel glide
    if (isScrubber) {
      _thumbDragging = true;
      _scrubSetY = null; _scrubAnchor = null;
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
        _scrubSetY = null; _scrubAnchor = null;
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
    _enqueueNearbyThumbs();   // shows copies made since, and asks again for any let go
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
  const from = thumbStrip.scrollLeft;
  if (Math.abs(diff) >= 0.5) thumbStrip.scrollLeft += diff * 0.2;   // ease ~20% of the remaining distance per frame
  // Close enough, or a step finer than the strip scrolls by (whole pixels): settle on the target.
  if (Math.abs(diff) < 0.5 || thumbStrip.scrollLeft === from) { thumbStrip.scrollLeft = _wheelTarget; _wheelRaf = null; _wheelTarget = null; return; }
  _wheelRaf = requestAnimationFrame(_wheelGlide);
}
// Mid-scrub the wheel scrolls the pages and the scrub picks up from wherever they go
// (_scrubFollowScroll). A Shift-scrub holds Shift, which turns the wheel sideways: such a turn is
// taken as the page scroll it means, and never pans the strip under the drag.
window.addEventListener('wheel', (e) => {
  if (!_thumbDragging) { _stopScrubEase(); return; }   // a let-go scrub still easing gives way to the wheel
  if (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  e.preventDefault();
  window.scrollBy(0, _eventDominantWheelDelta(e));
}, { capture: true, passive: false });

thumbStrip.addEventListener('wheel', (e) => {
  // Mid-drag the strip's place belongs to the drag: the wheel scrolls the pages instead.
  if (thumbStrip.classList.contains('dragging')) return;
  const max = thumbStrip.scrollWidth - thumbStrip.clientWidth;
  if (max <= 0) return;
  // A plain mouse reports deltaY; trackpads / Shift-wheel report deltaX — use whichever dominates.
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!delta) return;
  _stopThumbFollow();
  cancelAnimationFrame(_swipeRaf);                       // a fresh wheel takes over from any swipe coast
  if (_wheelTarget === null) _wheelTarget = thumbStrip.scrollLeft;
  _wheelTarget = Math.max(0, Math.min(max, _wheelTarget + delta));
  if (!_wheelRaf) _wheelRaf = requestAnimationFrame(_wheelGlide);
  e.preventDefault();
  e.stopPropagation();
}, { passive: false });

// Container listener — clicks/drags that don't start on the indicator itself.
// A thumbnail the pointer rests on: the page a click there shows is read and decoded ahead.
thumbStrip.addEventListener('pointermove', (e) => {
  if (_thumbDragging || e.buttons) return;
  const img = e.target.closest?.('.thumb-item')?.querySelector('img');
  if (img) _preloadOnRest(Number(img.dataset.idx) + 1, false);
});
thumbStrip.addEventListener('pointerleave', _cancelPreloadOnRest);

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
  document.body.classList.add('thumb-resizing');
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
    document.body.classList.remove('thumb-resizing');
    thumbResizeHandle.removeEventListener('pointermove', move);
    thumbResizeHandle.removeEventListener('pointerup', up);
    platform.kv.set({ readerThumbHeight: _thumbHeight });
    _refreshThumbSizes();   // copies made for a shorter strip would look soft now
  }
  thumbResizeHandle.addEventListener('pointermove', move);
  thumbResizeHandle.addEventListener('pointerup', up);
});

function setKeybindOpen(open) {
  if (open && readerSettingsModal.classList.contains('show')) setReaderSettingsOpen(false);   // one dialog at a time
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
// Navigation: the top bar, or the side controls (Reader settings → Navigation). Read before the
// page draws, like the pin. The side controls are shown, or hidden until the pointer comes to them.
let readerNavLayout = localStorage.getItem('shiori-reader-nav') === 'top' ? 'top' : 'side';   // decided by reader-init.js
let readerSidePinned = localStorage.getItem('shiori-reader-side-pin') !== '0';   // default: shown
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
  // Unpinned, fit and zoom hide too, and let go of the focus that would hold them up.
  if (!p && document.activeElement?.closest?.('#sideZoom')) document.activeElement.blur();
  _applyNavChrome();
}

// The header takes room only as a pinned top bar; the side controls float over the pages, which
// start at the top of the window as under an unpinned header.
function _applyNavChrome() {
  const side = readerNavLayout === 'side';
  const room = !side && readerPinned;
  // When pinned, offset programmatic scrolls (page nav, scrubber, Home/End) by the header height
  // so a navigated page lands just below the sticky header instead of behind it.
  document.documentElement.style.scrollPaddingTop = room ? 'var(--topbar-h)' : '';
  document.documentElement.classList.add('reader-scroll');
  document.body.classList.add('reader-scroll');
  document.body.classList.toggle('reader-unpinned', !room);
  document.body.classList.toggle('reader-side-nav', side);
  document.documentElement.classList.toggle('reader-side-nav', side);   // set early by reader-init.js
  document.body.classList.toggle('reader-side-hidden', side && !readerSidePinned);
  // Fit and zoom hide with either (set early by reader-init.js).
  document.documentElement.classList.toggle('reader-controls-hidden', side ? !readerSidePinned : !readerPinned);
  document.body.classList.remove('reader-nav-hover');
  _hideReaderNav();
  _syncSideNav();
}

function applyReaderSidePin(p) {
  readerSidePinned = p;
  localStorage.setItem('shiori-reader-side-pin', p ? '1' : '0');
  // Hidden, they let go of the focus: a button pressed a moment ago would otherwise hold them up.
  const focused = document.activeElement;
  if (!p && focused?.closest?.('#sideNav, #sideZoom')) focused.blur();
  _applyNavChrome();
}

// Switching between the top bar and the side controls keeps the point being read on the reading
// line (a pinned top bar's room comes or goes).
function applyReaderNavLayout(layout) {
  readerNavLayout = layout === 'side' ? 'side' : 'top';
  localStorage.setItem('shiori-reader-nav', readerNavLayout);
  _settleSideNav();
  _keepStripLine(_applyNavChrome, false);
  _syncReaderSettingsUI();
}

// Where the modern navigation stands (Reader settings → Display → Position): the rail's edge, and
// its start, centre or end along it; the chapter pill takes the top corner on its side. Read before
// the page draws (reader-init.js), like the navigation itself.
const NAV_POSITIONS = ['top', 'bottom', 'left', 'right'];
const NAV_ALIGNS = ['start', 'center', 'end'];
let readerNavPos = NAV_POSITIONS.includes(document.documentElement.dataset.snPos) ? document.documentElement.dataset.snPos : 'right';
let readerNavAlign = NAV_ALIGNS.includes(document.documentElement.dataset.snAlign) ? document.documentElement.dataset.snAlign : 'start';
document.documentElement.dataset.snPos = readerNavPos;
document.documentElement.dataset.snAlign = readerNavAlign;

function applyReaderNavPlace(pos, align) {
  readerNavPos = NAV_POSITIONS.includes(pos) ? pos : 'right';
  readerNavAlign = NAV_ALIGNS.includes(align) ? align : 'start';
  _settleSideNav();
  document.documentElement.dataset.snPos = readerNavPos;
  document.documentElement.dataset.snAlign = readerNavAlign;
  localStorage.setItem('shiori-reader-nav-place', `${readerNavPos}-${readerNavAlign}`);
  _syncReaderSettingsUI();
}

// The panels' sizes, for CSS to place them by (reader.css works out the rest, crowding included): kept
// on the root as they change (a chapter label's width, buttons that come and go, the rail turning).
// Only a change is written, so a window being resized never restyles the page for nothing.
const _sideNavSizes = new ResizeObserver(() => {
  const root = document.documentElement.style;
  for (const [key, el] of [['pill', snChapter], ['zoom', sideZoom], ['rail', snRail]]) {
    const { width, height } = el.getBoundingClientRect();   // exact: the rail's place and crowding are worked out from them
    for (const [name, px] of [[`--sn-${key}-w`, width], [`--sn-${key}-h`, height]]) {
      if (px && root.getPropertyValue(name) !== `${px}px`) root.setProperty(name, `${px}px`);
    }
  }
});
for (const el of [snChapter, sideZoom, snRail]) _sideNavSizes.observe(el);

// A change of place or navigation puts the panels where they go at once, a crowding included (only a
// crowding by the window, or the thumbnails opening, eases them: reader.css).
function _settleSideNav() {
  document.documentElement.classList.add('sn-settling');
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('sn-settling')));
}
_settleSideNav();   // the first paint

// X or N, or a double-click on the pages: hide the controls, or bring them back for good (the top
// bar: unpin or pin it).
function _toggleControls() {
  if (readerNavLayout === 'side') applyReaderSidePin(!readerSidePinned);
  else applyReaderPin(!readerPinned);
}

window.addEventListener('wheel', (e) => {
  if (readerPinned) return;
  if (!e.deltaY) return;
  // Scrolling inside a modal is not scrolling the pages.
  if (propertiesOpen() || feedbackOpen() || keybindModal.classList.contains('show')
      || readerSettingsModal.classList.contains('show')) return;
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

// ── Side controls ──
// Everything the top bar offers, as buttons down the right edge: home, the overview, the reading
// mode (one button stepping single → double → strip), translate and study (one at a time, or
// neither), thumbnails, auto-scroll, settings, shortcuts and the pin. The chapter pill sits above
// them; fit and zoom at the bottom right.
const _snSvg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const SN_MODES = {
  single: { next: 'double', tip: 'kb.single', svg: _snSvg('<path d="M2 3v18"/><rect width="12" height="18" x="6" y="3" rx="2"/><path d="M22 3v18"/>') },
  double: { next: 'strip',  tip: 'kb.double', svg: _snSvg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>') },
  strip:  { next: 'single', tip: 'kb.strip',  svg: _snSvg('<path d="M3 2h18"/><rect width="18" height="12" x="3" y="6" rx="2"/><path d="M3 22h18"/>') },
};
const SN_PLAY  = _snSvg('<polygon points="7 4 20 12 7 20" fill="currentColor" stroke="none"/>');
const SN_PAUSE = _snSvg('<rect x="6.5" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/>');
const TB_PLAY  = SN_PLAY.replace(/width="18" height="18"/, 'width="14" height="14"');
const TB_PAUSE = SN_PAUSE.replace(/width="18" height="18"/, 'width="14" height="14"');
const SN_FIT_WIDTH  = _snSvg('<path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/>');
const SN_FIT_HEIGHT = _snSvg('<path d="M12 2v20"/><path d="m8 18 4 4 4-4"/><path d="m8 6 4-4 4 4"/>');

function _snOn(btn, on) {
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', String(on));
}
function _snTip(btn, key) {
  btn.dataset.tip = t(key);
  btn.setAttribute('aria-label', t(key));
}

function _syncSideNav() {
  const m = SN_MODES[mode] || SN_MODES.strip;
  snMode.innerHTML = m.svg;
  _snTip(snMode, m.tip);
  snTranslate.hidden = snStudy.hidden = !(_translateAvailable || hasStudy);
  snTranslate.disabled = !_translateAvailable;
  snStudy.disabled = !hasStudy;
  _snOn(snTranslate, translateView);
  _snOn(snStudy, studyMode);
  _snTip(snTranslate, translateView ? 'rd.tip_translate_on' : 'rd.tip_translate');
  _snTip(snStudy, studyMode ? 'rd.tip_study_on' : 'rd.tip_study');
  _snOn(snThumbs, thumbsOpen);
  // Both play buttons: on while it scrolls, the speed and how to change it in the tip.
  const scrolling = !!_autoRaf;
  const label = t(scrolling ? 'rd.tip_autoscroll_stop' : 'rd.tip_autoscroll');
  const tip = `${label} · ${_speedLabel()}\n${t('rd.tip_autoscroll_drag')}`;
  for (const [btn, svg] of [[snAuto, scrolling ? SN_PAUSE : SN_PLAY], [autoBtn, scrolling ? TB_PAUSE : TB_PLAY]]) {
    btn.innerHTML = svg;
    if (_speedDragging) delete btn.dataset.tip;   // the speed readout speaks for it while it's dragged
    else btn.dataset.tip = tip;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(scrolling));
  }
  snAuto.classList.toggle('is-on', scrolling);
  autoBtn.classList.toggle('active', scrolling);
  _syncTopButtons();
}

// Back to top, in the strip once it's scrolled down: the classic button shows then, and the rail's
// last button, always there, can be pressed then.
function _syncTopButtons() {
  const usable = mode === 'strip' && window.scrollY > 400;
  scrollTopBtn.classList.toggle('visible', usable);
  if (snTop.disabled === usable) snTop.disabled = !usable;
}

// The chapter pill: a series' chapter, with the previous and next beside it and the list on a click;
// a single gallery's page. The overview button goes to the series, or the gallery.
function _syncSideChapter() {
  const ch = _chapters[_curChIdx];
  const series = !!_series && !!ch;
  if (series) {
    snChNum.textContent = t(ch.kind === 'volume' ? 'rd.vol_n' : 'rd.ch_n', { n: ch.num });
    snChTotal.textContent = ` / ${formatCount(_seriesTotal)}`;
    snChPrev.disabled = _curChIdx <= 0;
    snChNext.disabled = _curChIdx >= _chapters.length - 1;
  } else {
    snChNum.textContent = pageCounter.textContent;
    snChTotal.textContent = '';
  }
  snChPrev.hidden = snChNext.hidden = !series;
  snChLabel.disabled = !series;
  if (series) snChLabel.dataset.tip = t('rd.chapters');   // a single gallery has no list to offer
  else delete snChLabel.dataset.tip;
  const owner = _series ? _series.ownerId : galleryId;
  if (owner) snOverview.href = `../overview?g=${encodeURIComponent(owner)}`;
}

// Fit and zoom: one button switching fit width ⇄ fit height (lit while either fits); zooming turns
// the fit off, as the keys do.
function _syncSideZoom() {
  const scale = _readerZoomScale();
  snZoomValue.textContent = `${Math.round(scale * 100)}%`;
  snZoomOut.disabled = scale <= ZOOM_MIN + .001;
  snZoomIn.disabled = scale >= (mode === 'strip' ? 1 : ZOOM_MAX) - .001;
  snFit.innerHTML = readerFitMode === 'height' ? SN_FIT_HEIGHT : SN_FIT_WIDTH;
  _snOn(snFit, readerFitMode !== 'off');
  _snTip(snFit, readerFitMode === 'height' ? 'kb.fit_height' : 'kb.fit_width');
}

function _openChapterList() {
  if (!_series || !_chapters.length) return;
  snChList.replaceChildren(..._chapters.map((ch, k) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = k === _curChIdx ? 'sn-ch current' : 'sn-ch';
    const num = document.createElement('span');
    num.className = 'sn-ch-num';
    num.textContent = t(ch.kind === 'volume' ? 'rd.vol_n' : 'rd.ch_n', { n: ch.num });
    row.append(num);
    if (ch.title) {
      const title = document.createElement('span');
      title.className = 'sn-ch-title';
      title.textContent = ch.title;
      row.append(title);
    }
    row.addEventListener('click', () => { _closeChapterList(); _jumpToPage(ch.start + 1); });
    return row;
  }));
  document.body.classList.add('sn-pop-open');
  snChList.querySelector('.current')?.scrollIntoView({ block: 'center' });
}
const _chapterListOpen = () => document.body.classList.contains('sn-pop-open');
function _closeChapterList() { document.body.classList.remove('sn-pop-open'); }

snChPrev.addEventListener('click', () => _gotoAdjacentChapter(-1));
snChNext.addEventListener('click', () => _gotoAdjacentChapter(1));
snChLabel.addEventListener('click', () => (_chapterListOpen() ? _closeChapterList() : _openChapterList()));
snChaptersClose.addEventListener('click', _closeChapterList);
document.addEventListener('pointerdown', (e) => {
  if (_chapterListOpen() && !e.target.closest?.('#snChapters, #snChLabel')) _closeChapterList();
}, true);
snMode.addEventListener('click', () => setMode((SN_MODES[mode] || SN_MODES.strip).next));
snTranslate.addEventListener('click', () => setView(translateView ? 'off' : 'translate'));
snStudy.addEventListener('click', () => { if (hasStudy) setView(studyMode ? 'off' : 'study'); });
snThumbs.addEventListener('click', () => setThumbsOpen(!thumbsOpen));
_wireSpeedDrag(snAuto);
_wireSpeedDrag(autoBtn);
snSettings.addEventListener('click', () => setReaderSettingsOpen(!readerSettingsModal.classList.contains('show')));
snKeys.addEventListener('click', () => setKeybindOpen(!keybindModal.classList.contains('show')));
snTop.addEventListener('click', _backToTop);
snFit.addEventListener('click', () => (readerFitMode === 'width' ? fitPageHeight() : fitPageWidth()));
snZoomOut.addEventListener('click', () => adjustPageZoom(-1));
snZoomIn.addEventListener('click', () => adjustPageZoom(1));

// A play button plays or pauses on a press, and sets the speed when dragged, the way a number is
// scrubbed in an image editor: up or right faster, down or left slower, 2 px/s a pixel (10 with
// Shift), saved when the drag ends. While it's dragged, its tip gives way to a readout of its own
// (speedTip): a bar for where the speed sits in its range, the value beside it, staying where it
// opened as the drag began. A drag that reaches the screen's edge goes on by itself: while the cursor
// rests against the edge, the speed keeps moving the way that edge pushes it (right or top faster,
// left or bottom slower) until the cursor leaves it. A page can't move the cursor back, and locking the
// pointer to keep counting its movement makes the browser show a note on getting the cursor back.
const SPEED_DRAG_PX = 4;      // how far a press moves before it's a drag
const SPEED_EDGE_RATE = 300;  // px/s each second while held against the screen's edge (×3 with Shift)
let _speedDragging = false;
const speedTip = document.createElement('div');
speedTip.className = 'speed-tip';
speedTip.innerHTML = '<span class="speed-tip-bar"><span class="speed-tip-fill"></span></span><span class="speed-tip-value"></span>';
document.body.appendChild(speedTip);
const speedTipFill = speedTip.querySelector('.speed-tip-fill');
const speedTipValue = speedTip.querySelector('.speed-tip-value');

function _syncSpeedTip() {
  speedTipFill.style.width = `${(readerAutoScrollSpeed - 20) / 980 * 100}%`;
  speedTipValue.textContent = _speedLabel();
}

// Beside the cursor and inside the window, as the tooltip sits (tooltip.js).
function _placeSpeedTip(x, y) {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const w = speedTip.offsetWidth, h = speedTip.offsetHeight;
  const left = Math.max(10, Math.min(vw - w - 10, x + 14));
  let top = y + 16;
  if (top + h > vh - 10) top = y - h - 8;
  speedTip.style.left = `${left}px`;
  speedTip.style.top = `${Math.max(10, top)}px`;
}

// Which way the screen's edge under the cursor pushes the speed: 1 at the right or top edge, −1 at the
// left or bottom, 0 off them. Only on the edge itself: a cursor gone on to another screen keeps moving
// and needs no push.
function _edgePush(e) {
  const s = window.screen, left = s.availLeft ?? 0, top = s.availTop ?? 0;
  const on = (v, edge) => Math.abs(v - edge) <= 1;
  return (on(e.screenX, left + s.width - 1) ? 1 : 0) + (on(e.screenY, top) ? 1 : 0)
    - (on(e.screenX, left) ? 1 : 0) - (on(e.screenY, top + s.height - 1) ? 1 : 0);
}

function _wireSpeedDrag(btn) {
  let drag = null, dragged = false;
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || btn.disabled) return;
    drag = { id: e.pointerId, value: readerAutoScrollSpeed, travel: 0, moved: false, push: 0, shift: false, pushRaf: 0, pushAt: 0 };
    dragged = false;
    btn.setPointerCapture(e.pointerId);
  });
  // Held against the edge, no more moves arrive: the speed goes on a frame at a time.
  const pushFrame = (now) => {
    drag.pushRaf = 0;
    if (!drag.push) return;
    const dt = drag.pushAt ? Math.min(100, Math.max(0, now - drag.pushAt)) : 1000 / 60;
    drag.pushAt = now;
    drag.value = Math.max(20, Math.min(1000, drag.value + drag.push * SPEED_EDGE_RATE * (drag.shift ? 3 : 1) * dt / 1000));
    _applyReaderAutoScrollSpeed(drag.value, false);
    _syncSpeedTip();
    drag.pushRaf = requestAnimationFrame(pushFrame);
  };
  btn.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.value = Math.max(20, Math.min(1000, drag.value + (e.movementX - e.movementY) * (e.shiftKey ? 10 : 2)));
    drag.travel += Math.abs(e.movementX) + Math.abs(e.movementY);
    if (!drag.moved && drag.travel < SPEED_DRAG_PX) return;
    _applyReaderAutoScrollSpeed(drag.value, false);   // also takes the tip off the play buttons meanwhile
    _syncSpeedTip();
    if (!drag.moved) {   // the readout opens where the cursor is now, and stays there
      drag.moved = true;
      _speedDragging = true;
      btn.classList.add('speed-dragging');
      speedTip.classList.add('show');
      _placeSpeedTip(e.clientX, e.clientY);
    }
    drag.push = _edgePush(e);
    drag.shift = e.shiftKey;
    if (drag.push && !drag.pushRaf) { drag.pushAt = 0; drag.pushRaf = requestAnimationFrame(pushFrame); }
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    cancelAnimationFrame(drag.pushRaf);
    if (drag.moved) {
      dragged = true;
      _speedDragging = false;
      platform.kv.set({ readerAutoScrollSpeed });
      speedTip.classList.remove('show');
      btn.classList.remove('speed-dragging');
      _syncSideNav();   // the tips come back
    }
    drag = null;
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);
  btn.addEventListener('click', () => {
    if (dragged) { dragged = false; return; }   // that press set the speed
    setAutoScroll(!_autoRaf);
  });
}

// ── Auto-play ──
// The play buttons, or K, read on by themselves at the auto-play speed, until something stops them
// (below) or another press. The strip scrolls down at that speed. Single and double keep the pages on
// screen for that speed's seconds a page (_autoPageSeconds), then turn the page; a page taller than
// the screen scrolls down evenly over that time, reaching its bottom before it turns
// (_autoPagesFrame). A thin bar along the pages' bottom edge fills as their time runs out (autoBar).
// Scrolled on by hand, it carries on from wherever that leaves it; a glide, a scrub or a drag of the
// thumbnails has the page to itself while it runs. Scroll positions snap to whole device pixels, so
// it keeps its own fractional position and moves the page once that's a pixel away.
let _autoAt = 0, _autoY = 0, _autoSetY = null;
let _autoShown = 0, _autoShowing = null;   // single/double: how long the pages on screen have shown, and which
let _autoPage = 0, _autoPageAt = 0;        // the page it last saw, and since when
let _autoResumed = false;                   // just started: a tall page goes on from where it is
let _autoChapter = -1;                      // the chapter it started in: it never runs into another
const autoBar = document.createElement('div');
autoBar.className = 'auto-bar';
autoBar.innerHTML = '<span class="auto-bar-fill"></span>';
document.body.appendChild(autoBar);
const autoBarFill = autoBar.firstElementChild;

// The reader going back up stops auto-play (unless Reader settings says to read on from there): a
// wheel turned up (even with nothing to scroll), a touch swiped back down, a key scrolling up, the
// scrollbar or the progress bar dragged back, a page turned back. So do leaving its chapter (it never
// runs on into another; reaching the end stops it) and changing the reading mode. While a dialog is
// open over the pages (the shortcuts, the chapter list, page properties, feedback; not the reader
// settings) or the tab is hidden, it waits, and goes on once that's gone. Only what the reader does counts (a wheel or a
// moving key a moment ago, or a pointer held down); the page moving by itself (a page above learning
// its height, a turn putting the next page at its top, which waits for its image) doesn't. A press on
// a play button isn't a move.
const AUTO_INTENT_MS = 400;
const AUTO_TURN_SETTLE_MS = 600;   // single/double: how long after a turn its scroll to the page's top may come
const MOVING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'w', 'W', 's', 'S', 'a', 'A', 'd', 'D']);
let _readerInputAt = -Infinity, _readerPointerHeld = false;
const _noteReaderInput = () => { _readerInputAt = performance.now(); };
window.addEventListener('wheel', _noteReaderInput, { capture: true, passive: true });
window.addEventListener('keydown', (e) => { if (MOVING_KEYS.has(e.key)) _noteReaderInput(); }, true);
window.addEventListener('pointerdown', (e) => {
  _noteReaderInput();
  _readerPointerHeld = !e.target.closest?.('#snAuto, #autoBtn');
}, true);
for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, () => { _readerPointerHeld = false; }, true);
window.addEventListener('blur', () => { _readerPointerHeld = false; });
const _readerActing = () => _readerPointerHeld || performance.now() - _readerInputAt < AUTO_INTENT_MS;
// Turned up over the pages (not over the thumbnails or a dialog, which scroll on their own, nor a
// pinch-zoom), the wheel stops it at once; a touch dragged down by more than a little does too.
const AUTO_TOUCH_BACK_PX = 12;
const _ownScroller = (el) => !!el?.closest?.('#thumbStrip, #readerSettingsModal, #keybindModal, #snChapters');
window.addEventListener('wheel', (e) => {
  if (_autoRaf && readerAutoPauseOnUp && e.deltaY < 0 && !e.ctrlKey && !_ownScroller(e.target)) setAutoScroll(false);
}, { capture: true, passive: true });
let _touchY = 0;
window.addEventListener('touchstart', (e) => { _touchY = e.touches[0]?.clientY ?? 0; }, { capture: true, passive: true });
window.addEventListener('touchmove', (e) => {
  if (_autoRaf && readerAutoPauseOnUp && !_ownScroller(e.target) && (e.touches[0]?.clientY ?? 0) - _touchY > AUTO_TOUCH_BACK_PX) setAutoScroll(false);
}, { capture: true, passive: true });
// The reader settings don't hold it up: their speed is easiest set watching it.
const _autoWaits = () => document.hidden || keybindModal.classList.contains('show')
  || _chapterListOpen() || propertiesOpen() || feedbackOpen();

function setAutoScroll(on) {
  on = !!on;
  if (on === !!_autoRaf) return;
  cancelAnimationFrame(_autoRaf);
  _autoRaf = 0;
  if (on) {
    _autoAt = 0;
    _autoSetY = null;
    _autoShowing = null;
    _autoPage = currentPage;
    _autoPageAt = performance.now();
    _autoResumed = true;
    _autoChapter = _curChIdx;
    _autoRaf = requestAnimationFrame(_autoScrollFrame);
  } else {
    autoBar.classList.remove('show');
  }
  _syncSideNav();
}

function _autoScrollFrame(now) {
  _autoRaf = 0;
  const dt = _autoAt ? Math.min(100, Math.max(0, now - _autoAt)) : 1000 / 60;   // the first frame counts as 1/60 s
  _autoAt = now;
  const y = window.scrollY;
  if (_curChIdx !== _autoChapter) { _stopAutoFrame(); return; }   // another chapter: it stops
  if (_autoWaits()) {   // a dialog over the pages, or the tab hidden: it waits
    _autoSetY = y;
    _autoRaf = requestAnimationFrame(_autoScrollFrame);
    return;
  }
  if (currentPage !== _autoPage) _autoPageAt = now;
  // Back up, by the reader: it stops, unless Reader settings says to read on from there. (In
  // single/double, a later page put at its top isn't up.)
  const scrolledUp = _autoSetY !== null && y < _autoSetY - 1
    && (mode === 'strip' || (currentPage === _autoPage && now - _autoPageAt > AUTO_TURN_SETTLE_MS));
  if (readerAutoPauseOnUp && (currentPage < _autoPage || scrolledUp) && _readerActing()) { _stopAutoFrame(); return; }
  _autoPage = currentPage;
  const moved = _autoSetY === null || Math.abs(y - _autoSetY) > 1;   // by something else
  if (moved) _autoY = y;
  if (mode === 'strip') {
    autoBar.classList.remove('show');
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (_autoY >= max - 1) { _stopAutoFrame(); return; }   // the end: it stops
    if (!_glideEl && !_scrubRaf && !_barPress && !_thumbDragging) {
      _autoY = Math.min(max, _autoY + readerAutoScrollSpeed * dt / 1000);
      if (Math.abs(_autoY - window.scrollY) >= 1 / (window.devicePixelRatio || 1)) window.scrollTo(0, _autoY);
    }
  } else if (!_autoPagesFrame(dt)) {
    _stopAutoFrame();
    return;
  }
  _autoResumed = false;
  _autoSetY = window.scrollY;
  _autoRaf = requestAnimationFrame(_autoScrollFrame);
}
// Stopped from its own frame (no frame is pending then).
function _stopAutoFrame() {
  autoBar.classList.remove('show');
  _syncSideNav();
}

// Single/double: the pages on screen get their time, the bar shows how much has run, and they turn
// when it's up; false at the end, with no page to turn to. A page taller than the screen scrolls from
// its top to its bottom evenly, reaching it AUTO_HOLD_S before it turns (a page with less than twice
// that, in half its time), and holds its bottom until then. Scrolled on by hand, it keeps its time
// and goes on from there, what's left of it over the time it has left to get there (scrolled back up,
// auto-play stops). Started again partway down, it goes on from where it is, its time as far along as
// the page. A page that fits the screen has nothing to scroll: only its time moves it.
const AUTO_HOLD_S = 1;
function _autoPagesFrame(dt) {
  const showing = `${currentPage}:${_pageDivider}`;
  const fresh = showing !== _autoShowing;
  if (fresh) { _autoShowing = showing; _autoShown = 0; }
  else _autoShown += dt / 1000;
  const time = _autoPageSeconds();
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const inner = mode === 'double' ? doubleInner : singleInner;
  const top = _pageDivider !== null ? max
    : Math.max(0, Math.min(max, inner.getBoundingClientRect().top + window.scrollY - _pinOffset()));
  const range = max - top;   // how far a page taller than the screen scrolls
  const scrollFor = Math.max(time - AUTO_HOLD_S, time / 2);   // the time it has to get there
  if (fresh && range > 1) {
    if (_autoResumed) _autoShown = Math.max(0, Math.min(1, (window.scrollY - top) / range)) * scrollFor;
    else _autoY = top;   // a turn: from its top
  }
  if (_autoShown >= time) {
    const next = _landingPage(_flipTarget(1));
    if (_pageDivider !== null || next === _landingPage(currentPage) || _chapterAt(next) !== _curChIdx) return false;   // its chapter's end
    goTo(_flipTarget(1));
    return true;
  }
  _placeAutoBar(_autoShown / time);
  if (range > 1 && !_barPress && !_thumbDragging) {
    // What's left of the page over the time it has left to get to its bottom; then it holds there.
    const left = scrollFor - _autoShown;
    _autoY = left > 0 ? Math.min(max, _autoY + (max - _autoY) * Math.min(1, dt / 1000 / left)) : max;
    if (Math.abs(_autoY - window.scrollY) >= 1 / (window.devicePixelRatio || 1)) window.scrollTo(0, _autoY);
  }
  return true;
}

// Auto-play has one speed (readerAutoScrollSpeed, 20–1000 px/s). The strip scrolls at it; single and
// double take it as seconds a page, converted from its range to theirs, so it never falls outside
// them: 60 s to 1 s a page, 120 s to 2 s a spread (a spread has its two pages' time). The conversion
// is straight, so the slider moves the seconds evenly: the default 150 px/s is about 52 s a page.
const AUTO_PX = [20, 1000];
const AUTO_PAGE_SECONDS = { single: [60, 1], double: [120, 2] };   // slowest, fastest
function _autoPageSeconds() {
  const [slow, fast] = AUTO_PAGE_SECONDS[mode] || AUTO_PAGE_SECONDS.single;
  const at = (readerAutoScrollSpeed - AUTO_PX[0]) / (AUTO_PX[1] - AUTO_PX[0]);
  return slow + at * (fast - slow);
}

// The speed as the reader shows it: px/s in the strip, seconds a page in single/double.
const _speedLabel = () => (mode === 'strip' ? `${readerAutoScrollSpeed} px/s` : `${_autoPageSeconds().toFixed(1)} s/page`);

// Across the window at its top or bottom (Reader settings), filling the way the pages read; where it
// stands is reader.css's, from the page bar's and the thumbnails' state.
function _placeAutoBar(done) {
  autoBar.dataset.at = readerAutoBarPosition;
  autoBar.classList.toggle('rtl', readerNavDirection === 'rtl');
  autoBarFill.style.transform = `scaleX(${done})`;
  autoBar.classList.add('show');
}

applyReaderPin(readerPinned);   // the header's state, and with it the navigation's, before the first paint


// ── Strip view ──
// The strip is VIRTUALIZED. Every page gets a fixed-order .page-wrap whose aspect ratio reserves
// its height (so the scrollbar and the strip↔thumb sync geometry stay stable), but only a window
// of pages around the reading line holds a live <img src>. Outside a wider hysteresis band the
// src is dropped — the browser frees the decoded bitmap — and blob URLs cached far away are
// revoked, so a series of thousands of pages holds the same steady-state memory as a short
// gallery. Loads run nearest-to-viewport first, and every jump (scrubber, thumbs, fast wheel,
// click-wheel nav) re-aims the window at the new position, cancelling superseded loads.
//
// Nothing read a moment ago, or about to be, should ever be seen loading — that comes first, memory
// second. So the window reaches far ahead in the direction of travel and less far behind, measured in
// screens, not pages (pages twice the screen's height need half as many held for the same
// lookahead): pages within MOUNT_AHEAD_SCREENS ahead and MOUNT_BEHIND_SCREENS behind hold a live src,
// those within DECODE_SCREENS ahead (half that behind) are decoded ahead of time, and a mounted page
// keeps its src until it is a whole further mount reach outside the window. A page that isn't decoded
// holds only its encoded bytes (a few hundred KB); a decoded one costs width × height × 4 bytes
// (about 9 MB at 1280×1810), so the decode reach is where the memory goes.
const MOUNT_AHEAD_SCREENS = 20;
const MOUNT_BEHIND_SCREENS = 10;
const DECODE_SCREENS = 5;
const STRIP_CONCURRENCY = 4;   // full-page loads under way at once, across passes — superseded
                               // ones can't be called back, so they must not pile up
const URL_EVICT_BEYOND = 100;  // cached blob URLs farther than this are revoked (encoded bytes only)
let _mountAhead = 12, _mountBehind = 6, _decodeAhead = 4;   // in pages; re-measured each pass
let _winLo = 0, _winHi = -1, _winC = 0;   // the window's local rows and its centre, as last aimed

function _measureStripReach(row) {   // row: local index at the reading line
  const perScreen = window.innerHeight / Math.max(1, _stripWraps[row]?.offsetHeight || window.innerHeight);
  _mountAhead = Math.max(4, Math.min(50, Math.ceil(MOUNT_AHEAD_SCREENS * perScreen)));
  _mountBehind = Math.max(2, Math.min(25, Math.ceil(MOUNT_BEHIND_SCREENS * perScreen)));
  _decodeAhead = Math.max(2, Math.min(_mountAhead, Math.ceil(DECODE_SCREENS * perScreen)));
}

// How far row i is from the reading row c, rows behind counting double: loads and decodes go ahead
// in the direction of travel first.
const _stripCost = (i, c) => ((i - c) * _stripDir >= 0 ? Math.abs(i - c) : 2 * Math.abs(i - c));

// ── Flying ──
// Scrubbing (dragging the scrollbar, the progress bar or the thumbnails across hundreds of pages),
// the strip passes pages far faster than a full page loads and decodes and stays in view, so loading
// them buys nothing but reads, decodes and memory — and holds up the page it stops on. While the
// strip has covered FLY_SCREENS screens within FLY_WINDOW_MS (some 25 screens a second, well beyond
// any wheel), over several steps (one jump lands, it doesn't fly), full pages wait, and the window is
// aimed again as soon as it slows or stops.
const FLY_WINDOW_MS = 120;
const FLY_SCREENS = 3;
const FLY_STILL_MS = 70;   // no scroll for this long: it has stopped
// A wheel is read, however fast: a free-spinning one runs past 45 screens a second, and its pages must
// be there. The browser's smooth scroll carries on a while after the last wheel event.
const FLY_WHEEL_MS = 500;
const _scrollTrail = [];   // recent { t, y }
let _lastScrollAt = 0;
let _lastWheelAt = -Infinity;
let _stripDir = 1;         // 1 moving down, -1 up; kept while at rest
window.addEventListener('wheel', () => { _lastWheelAt = performance.now(); }, { capture: true, passive: true });

function _noteScroll() {
  const t = _lastScrollAt = performance.now();
  _scrollTrail.push({ t, y: window.scrollY });
  while (t - _scrollTrail[0].t > FLY_WINDOW_MS) _scrollTrail.shift();
  const moved = window.scrollY - _scrollTrail[0].y;
  if (Math.abs(moved) > 8 && Math.sign(moved) !== _stripDir) {
    _stripDir = Math.sign(moved);
    _lastSyncCenter = Infinity;   // turned around: aim the window the new way at once
  }
}

function _stripFlying() {
  const t = performance.now();
  if (t - _lastWheelAt < FLY_WHEEL_MS) return false;
  const recent = _scrollTrail.filter(s => t - s.t <= FLY_WINDOW_MS);
  if (recent.length < 3 || t - recent[recent.length - 1].t > FLY_STILL_MS) return false;
  return Math.abs(recent[recent.length - 1].y - recent[0].y) > window.innerHeight * FLY_SCREENS;
}

let _stripLandTimer = 0;
function _awaitStripLanding() {
  clearTimeout(_stripLandTimer);
  _stripLandTimer = setTimeout(() => {
    if (_stripFlying()) { _awaitStripLanding(); return; }
    _lastSyncCenter = Infinity;
    _scheduleStripSync();
  }, FLY_STILL_MS + 10);
}

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

// The reading position is a point in the pages, not a scroll offset: a row's height is only an
// estimate until its page loads, and every row resizes with the zoom, the fit mode and the window.
// After any of those, the scroll is put back so the same point sits on the reading line again.
// A point is a row plus how far into it the line falls: `frac` of its height (a rescaled page keeps
// the same spot of its picture on the line) and/or `px` from its top (a page learning its true shape
// keeps its top where it is). On the gap or chapter card before a row, it's a px offset above that
// row. The row is held by its element, so rows inserted or renumbered meanwhile don't matter. The
// browser's own scroll anchoring may correct first; putting the point back is absolute, so the two
// never add up.
let _stripLine = null;   // the point last seen on the reading line, for a resize to put back

function _stripLineAt(scaled) {
  const n = _stripWraps.length;
  if (mode !== 'strip' || !n || !stripView.classList.contains('active')) return null;
  const line = window.scrollY + _pinOffset();
  const lo = _stripRowAt(line);
  const wrap = _stripWraps[lo], off = line - wrap.offsetTop, h = wrap.offsetHeight;
  if (off >= h && lo < n - 1) {
    const next = _stripWraps[lo + 1];
    return { wrap: next, frac: 0, px: line - next.offsetTop };
  }
  return scaled && off >= 0 && off < h ? { wrap, frac: off / h, px: 0 } : { wrap, frac: 0, px: off };
}

function _scrollStripLineTo(at) {
  if (!at?.wrap.isConnected || mode !== 'strip' || _glideEl) return;
  const y = at.wrap.offsetTop + at.frac * at.wrap.offsetHeight + at.px - _pinOffset();
  if (Math.abs(y - window.scrollY) >= 1) window.scrollTo(0, y);
  if (_scrubSetY !== null) _scrubSetY = window.scrollY;   // keeping the point isn't moving the page under a scrub
}

// Run a change that resizes strip rows without moving the point on the reading line.
function _keepStripLine(change, scaled) {
  const at = _glideEl ? null : _stripLineAt(scaled);   // a glide follows the live geometry on its own
  change();
  if (!at) return;
  _scrollStripLineTo(at);
  _stripLine = _stripLineAt(true);
}

// Revoke cached blob URLs for pages far from centerIdx (0-based). The radius is far wider than
// the unmount band and the page-mode warm window, so nothing on screen can lose its URL.
function _evictFarUrls(centerIdx) {
  for (const [key, url] of _pageUrlCache) {
    const idx = _pageIdxByUrl.get(key.slice(2));   // strip the variant prefix
    if (idx === undefined || Math.abs(idx - centerIdx) <= URL_EVICT_BEYOND) continue;
    if (url) { try { URL.revokeObjectURL(url); } catch {} }
    _pageUrlCache.delete(key);
    _noteLoaded();
  }
}

// Release a strip row: its page leaves memory.
function _releaseStripRow(idx) {
  const img = _stripImgs[idx];
  _removeWrapBubbleLayer(_stripWraps[idx], pages[_viewBase + idx]?.url);
  img.removeAttribute('src');
  delete img.dataset.vk;
  _decodeWaits.get(img)?.();
  _mountedIdx.delete(idx);
  _noteLoaded();
}

// Load one page into its strip slot. On a translation-view swap (swap=true) a visible page's
// replacement is decoded BEFORE its src changes, so it never blanks. Bails out silently when the
// pass was superseded or the window has already moved past this page.
async function _mountOne(idx, gen, swap) {
  const page = pages[_viewBase + idx];
  const url = await pageBlobUrl(page);
  if (_stripGen !== gen || !url) return;
  if (idx < _winLo || idx > _winHi) return;   // the window moved on mid-load
  const img = _stripImgs[idx];
  _stripWraps[idx]?.classList.remove('page-placeholder');
  const vk  = _variantKey(page);
  if (img.dataset.vk === vk && img.getAttribute('src') === url) {
    _mountedIdx.add(idx);
    const wrap = _stripWraps[idx];
    if (_bubbleLayersOn() && wrap && !wrap.querySelector(':scope > .bubble-layer')) _renderBubbleLayer(wrap, _viewBase + idx + 1);
    return;
  }
  const near = _stripCost(idx, _winC) <= _decodeAhead;
  if (swap && near && img.getAttribute('src')) {
    const pre = new Image(); pre.src = url;   // decode the replacement before swapping in
    try { await pre.decode(); } catch {}
    if (_stripGen !== gen) return;
  }
  img.src = url;
  img.dataset.vk = vk;
  _mountedIdx.add(idx);
  const wrap = _stripWraps[idx];
  if (_bubbleLayersOn() && wrap && !wrap.querySelector(':scope > .bubble-layer')) _renderBubbleLayer(wrap, _viewBase + idx + 1);
  if (near) await _decodeRow(img);
}

// Wait for a strip image to decode. Chrome never settles a decode() whose src is removed within a
// millisecond or so of being set — a far jump straight back releases rows that quickly — and a load
// holds one of the shared slots until it ends, so a few of those would stop every page loading.
// Releasing a row (_syncStripWindow) ends the wait on it.
const _decodeWaits = new WeakMap();   // img → ends the wait on its decode
function _decodeRow(img) {
  _decodeWaits.get(img)?.();
  return new Promise(done => {
    const end = () => { if (_decodeWaits.get(img) === end) _decodeWaits.delete(img); done(); };
    _decodeWaits.set(img, end);
    img.decode().then(end, end);
  });
}

// Aim the mounted window at the current page (or `aim`, a jump's destination): unmount what fell out
// of the hysteresis band (or holds a stale variant outside the live window), evict far URLs, then
// fill in whatever the window is missing — nearest to the viewport first. A bumped _stripGen cancels
// any prior pass.
let _mountsActive = 0;   // full-page loads under way, across passes
let _stripPump = null;   // the current pass's next(): a load finishing frees a slot for it
let _nearRows = new Set();   // rows marked .near, whose missing page shows a spinner

function _syncStripWindow(swap = false, aim = currentPage) {
  if (mode !== 'strip' || !_stripImgs.length) return;
  const gen = ++_stripGen;
  const center = Math.max(1, Math.min(_viewCount, aim - _viewBase));   // local, 1-based
  const c = _winC = center - 1;
  _measureStripReach(c);
  const lo = _winLo = Math.max(0, c - (_stripDir > 0 ? _mountBehind : _mountAhead));
  const hi = _winHi = Math.min(_viewCount - 1, c + (_stripDir > 0 ? _mountAhead : _mountBehind));

  // Missing pages show their spinner only this near the screen (reader.css).
  const near = new Set();
  for (let i = lo; i <= hi; i++) if (_stripCost(i, c) <= _decodeAhead) near.add(_stripWraps[i]);
  for (const wrap of _nearRows) if (!near.has(wrap)) wrap.classList.remove('near');
  for (const wrap of near) wrap.classList.toggle('near', true);   // no write when it's already there
  _nearRows = near;

  for (const idx of [..._mountedIdx]) {
    const img = _stripImgs[idx];
    if ((idx < lo || idx > hi) && _stripWraps[idx]?.querySelector(':scope > .bubble-layer')) {
      _removeWrapBubbleLayer(_stripWraps[idx], pages[idx]?.url);
    }
    const far   = idx < lo - _mountAhead || idx > hi + _mountAhead;   // a whole reach outside the window
    const stale = img.dataset.vk !== _variantKey(pages[_viewBase + idx]) && (idx < lo || idx > hi);
    if (!far && !stale) continue;
    _releaseStripRow(idx);
  }
  _evictFarUrls(_viewBase + c);

  const pending = [];
  for (let i = lo; i <= hi; i++) {
    const img = _stripImgs[i];
    if (img.getAttribute('src') && img.dataset.vk === _variantKey(pages[_viewBase + i])) {
      // Already mounted: re-warm the decode cache near the viewport (no-op when still resident).
      if (_stripCost(i, c) <= _decodeAhead) img.decode().catch(() => {});
      const wrap = _stripWraps[i];
      if (_bubbleLayersOn() && wrap && !wrap.querySelector(':scope > .bubble-layer')) _renderBubbleLayer(wrap, _viewBase + i + 1);
      continue;
    }
    pending.push(i);
  }
  pending.sort((a, b) => _stripCost(a, c) - _stripCost(b, c));
  let at = 0;
  function next() {
    if (_stripGen !== gen) return;
    while (_mountsActive < STRIP_CONCURRENCY && at < pending.length) {
      const idx = pending[at++];
      _mountsActive++;
      _mountOne(idx, gen, swap).finally(() => { _mountsActive--; _stripPump?.(); });
    }
  }
  _stripPump = next;
  next();
}

// Scroll-driven re-aim, throttled to one frame AND to ≥2 pages of movement, so flinging the
// wheel, scrubbing, or the W/S scroll loop doesn't rebuild the load queue on every scroll event.
let _lastSyncCenter = Infinity;
let _stripSyncQueued = false;
let _stripAnnounceTimer = null;
let _stripAnnouncedPage = -1;   // last page actually broadcast — skip redundant re-emits

// Broadcast the reading position as a leading + trailing throttle (~150ms), NOT a trailing-only
// debounce: a continuous scroll (holding D, the W/S loop, a smooth scroll) calls this faster than
// 150ms, so a plain debounce would keep resetting and never fire until motion stopped — starving a
// listener that's waiting on EXT_READER_POSITION. This emits on the first move, keeps emitting on a
// steady cadence while scrolling, and lands a final broadcast on the page we settle on.
function _announceStripPage() {
  if (mode !== 'strip' || currentPage === _stripAnnouncedPage) return;
  _stripAnnouncedPage = currentPage;
  _announceCurrentPage();
}
function _scheduleStripAnnounce() {
  if (_stripAnnounceTimer) return;   // window open — the trailing fire will emit the latest page
  _announceStripPage();              // leading edge
  _stripAnnounceTimer = setTimeout(() => {
    _stripAnnounceTimer = null;
    _announceStripPage();            // trailing edge — catch the page we ended on
  }, 150);
}
// While a glide is on its way (a jump from the bar or the thumbnails, a page step), the window aims at
// where it's going, not at the pages it passes: the destination loads while the glide travels, and
// a fast glide flying past pages doesn't hold it back.
const _stripAim = () => (_glideEl?.isConnected ? Number(_glideEl.dataset.page) : currentPage);

function _scheduleStripSync() {
  if (mode !== 'strip') return;
  _scheduleStripAnnounce();
  if (Math.abs(_stripAim() - _lastSyncCenter) < 2) return;
  if (_stripSyncQueued) return;
  _stripSyncQueued = true;
  requestAnimationFrame(() => {
    _stripSyncQueued = false;
    const aim = _stripAim();
    if (aim === currentPage && _stripFlying()) { _awaitStripLanding(); return; }
    _lastSyncCenter = aim;
    _syncStripWindow(false, aim);
  });
}

// One strip row for global page index `gi`. Each page-img sits in its own .page-wrap (relative) so
// study-mode bubble overlays can anchor to the image box; the wrap carries data-page (GLOBAL page
// number) and is the row measured by the scroll-sync geometry. The row reads its page number from
// data-page when it needs it, so it stays right when rows are inserted before it (_growStripRows).
function _makeStripRow(gi) {
  const wrap = document.createElement('div');
  wrap.className    = pages[gi]?.cached ? 'page-wrap' : 'page-wrap page-placeholder';
  wrap.dataset.page = gi + 1;
  const img = document.createElement('img');
  img.className    = 'page-img';
  img.decoding     = 'async';
  // Missing rows always use the immutable baseline. Cached rows may reuse a previously learned
  // page-specific ratio, then refine it from the real image after loading. Either way the row's
  // ratio and its fit-height width ratio agree from the start.
  const known = pages[gi]?.cached && _pageRatios.get(gi);
  if (known) {
    img.style.aspectRatio = known;
    img.style.setProperty('--page-ratio', _ratioValue(known));
    wrap.style.setProperty('--page-ratio', _ratioValue(known));
  } else {
    _setPlaceholderGeometry(img, wrap);
  }
  img.addEventListener('load', () => {
    _noteLoaded();
    if (img.naturalWidth <= 1 || img.naturalHeight <= 1) return;
    const r = `${img.naturalWidth} / ${img.naturalHeight}`;
    _pageRatios.set(Number(wrap.dataset.page) - 1, r);
    // Most pages of a gallery share one shape, often the one the row already holds: within a hair of
    // it (object-fit absorbs well under a pixel), keep the reservation rather than restyle the row
    // and lay out every row of the strip again.
    if (Math.abs(img.naturalWidth / img.naturalHeight / _ratioValue(img.style.aspectRatio) - 1) < 2e-4) return;
    _reshapePending.add(img);
    if (!_reshapeRaf) _reshapeRaf = requestAnimationFrame(_reshapeRows);
  });
  wrap.appendChild(img);
  return wrap;
}

// Pages that loaded in a shape other than their row's take it (the ratio, and in fit-height their width
// too) without moving the page on the reading line, all of a frame's at once, before the frame that
// first paints them: a run of loads (a fast wheel) lays the strip out once, not twice for each page.
// A row off by less than a device pixel keeps its shape — object-fit absorbs it — so a gallery
// whose pages differ by a hair (4236×2880 among 2880×1959) never restyles its rows for them. A scrub's
// ease and a glide take them first in their own frames (their frame can come before this one), so they
// aim at the strip as it now is: an ease that settled on the end first missed the end moving.
const _reshapePending = new Set();
let _reshapeRaf = 0;
function _reshapeRows() {
  cancelAnimationFrame(_reshapeRaf);
  _reshapeRaf = 0;
  const imgs = [..._reshapePending].filter(img => img.isConnected && img.getAttribute('src') && img.naturalWidth > 1);
  _reshapePending.clear();
  if (!imgs.length) return;
  _keepStripLine(() => {
    const dpr = window.devicePixelRatio || 1;
    // Measured before any row changes: the layout _keepStripLine just did serves them all.
    const off = imgs.filter(img => {
      const w = img.offsetWidth, h = img.offsetHeight;
      return !w || !h || Math.abs(w / h / (img.naturalWidth / img.naturalHeight) - 1) * Math.max(w, h) * dpr >= 1;
    });
    for (const img of off) {
      img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      _setPageRatioVars(img);
    }
  }, false);
}

function buildStrip() {
  ++_stripGen;               // cancel in-flight loads aimed at the previous strip DOM
  _stripAnnouncedPage = -1;  // re-scope / re-enter re-arms the position broadcast
  _mountedIdx.clear();
  _noteLoaded();
  stripView.innerHTML = '';
  const scope = _stripScope();
  _viewBase  = scope.base;
  _viewCount = scope.count;
  const fragment = document.createDocumentFragment();

  // Build the full row skeleton upfront so DOM order is fixed before any async work (rows:
  // _makeStripRow). Transition cards slot after a chapter's last page — the sync math only
  // measures .page-wrap rows, so their height is absorbed by the between-page interpolation.
  for (let i = 0; i < _viewCount; i++) {
    const gi = _viewBase + i;
    fragment.appendChild(_makeStripRow(gi));

    // End-of-chapter transition card. Always present in the per-chapter flow (it IS the next/
    // previous-chapter navigation there); in the continuous flow it's the optional divide.
    const chIdx = _chapterAt(gi + 1);
    const isChapterEnd = gi + 1 === _chapters[chIdx].start + _chapters[chIdx].count;
    if (_series && isChapterEnd && (_chapterDividersOn || !_stripSeriesFlow)) {
      const div = document.createElement('div');
      div.className = 'chapter-divider';
      div.appendChild(_buildDividerCard(chIdx, _stripSeriesFlow));   // continuous flow → label only
      fragment.appendChild(div);
    }
  }
  stripView.appendChild(fragment);
  _stripWraps = [...stripView.querySelectorAll('.page-wrap')];
  _stripImgs  = _stripWraps.map(w => w.firstElementChild);

  _lastSyncCenter = Infinity;
  _syncStripWindow();
  if (_bubbleLayersOn()) _refreshBubbleLayers();
}

// ── Mode switching ──
function _applyReaderNavDirection(next, persist = true) {
  readerNavDirection = next === 'rtl' ? 'rtl' : 'ltr';
  if (persist) platform.kv.set({ readerNavDirection });
  _syncReaderSettingsUI();
}

function _applyReaderPageDirection(next, persist = true) {
  readerPageDirection = next === 'rtl' ? 'rtl' : 'ltr';
  document.body.classList.toggle('reader-page-rtl', readerPageDirection === 'rtl');
  if (persist) platform.kv.set({ readerPageDirection });
  _syncReaderSettingsUI();
}

// Re-pairs the spreads around one page that stays in view (a showing transition page keeps its
// place). That page is kept across toggles while it is still on screen: re-deriving it from each
// new spread would land on that spread's first page and walk back a page with every press.
let _coverAnchor = 0;
function _applyReaderCoverOffset(on, persist = true) {
  const shown = mode === 'double' && _pageDivider === null ? _spreadAt(currentPage) : null;   // old pairing
  readerCoverOffset = !!on;
  if (persist) platform.kv.set({ readerCoverOffset });
  _syncReaderSettingsUI();
  if (!shown) return;
  if (!_coverAnchor || (_coverAnchor !== shown.lead && _coverAnchor !== shown.trail)) _coverAnchor = currentPage;
  goTo(_coverAnchor, true);
}

// ── Debug: loaded pages on the bar (Reader settings → Debug) ──
// The pages whose image the reader holds, loaded and ready to show, turn blue on the bar: a strip
// row's, or one decoded ahead for a flip or a jump (_decoded). Off, it costs a flag check; on, one
// pass over the bar's segments in a frame where something loaded or was let go.
let _loadedRaf = 0;
function _applyReaderDebugLoaded(on, persist = true) {
  readerDebugLoaded = !!on;
  if (persist) platform.kv.set({ readerDebugLoaded });
  _syncReaderSettingsUI();
  _loadedRaf = 0;
  _paintLoaded();
}

function _noteLoaded() {
  if (readerDebugLoaded && !_loadedRaf) _loadedRaf = requestAnimationFrame(_paintLoaded);
}

function _paintLoaded() {
  _loadedRaf = 0;
  const ch = _chapters[_curChIdx];
  const held = new Set();
  if (readerDebugLoaded) {
    for (const idx of _mountedIdx) {
      const img = _stripImgs[idx];
      if (img?.complete && img.naturalWidth) held.add(_viewBase + idx);
    }
    for (const [key, url] of _pageUrlCache) if (url && _decoded.has(url)) held.add(_pageIdxByUrl.get(key.slice(2)));
  }
  const segs = scrubSegments.children;
  for (let i = 0; i < segs.length; i++) {
    const on = !!ch && held.has(ch.start + i);
    if (segs[i].classList.contains('debug-loaded') !== on) segs[i].classList.toggle('debug-loaded', on);
  }
}

function _applyReaderAutoScrollSpeed(next, persist = true) {
  readerAutoScrollSpeed = Math.max(20, Math.min(1000, Math.round((Number(next) || 150) / 10) * 10));
  if (persist) platform.kv.set({ readerAutoScrollSpeed });
  _syncReaderSettingsUI();
  _syncSideNav();
}
// Dim pages: the pages (and what's drawn over them) darkened by this much, 0–100 %.
function _applyReaderDim(next, persist = true) {
  readerDim = Math.max(0, Math.min(100, Math.round(Number(next) || 0)));
  document.documentElement.style.setProperty('--reader-dim', String(1 - readerDim / 100));
  document.body.classList.toggle('reader-dim', readerDim > 0);
  if (persist) platform.kv.set({ readerDim });
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
  document.body.dataset.bar = next;   // what the stylesheet places by (reader.css: never body:has())
  bottombar.classList.toggle('hidden', next === 'off');
  document.body.classList.toggle('bar-hidden', next !== 'bottom');
  _syncBarDensity();      // a side bar's length differs from a bottom one's
  _scheduleScrubView();   // and its band runs the other way
  document.documentElement.style.setProperty(
    '--botbar-visual-h',
    next === 'bottom' ? 'calc(var(--botbar-h) * var(--zoom-inv, 1))' : '0px'
  );
  if (persist) platform.kv.set({ readerProgressPosition });
  _syncReaderSettingsUI();
}

function _applyReaderAutoBarPosition(next) {
  readerAutoBarPosition = next === 'top' ? 'top' : 'bottom';
  platform.kv.set({ readerAutoBarPosition });
  _syncReaderSettingsUI();
}

function _applyReaderPauseOnUp(on) {
  readerAutoPauseOnUp = !!on;
  platform.kv.set({ readerAutoPauseOnUp });
  _syncReaderSettingsUI();
}

function _applyReaderSmoothScroll(on) {
  readerSmoothScroll = !!on;
  platform.kv.set({ readerSmoothScroll });
  _syncReaderSettingsUI();
}

// The settings Settings → Reader also has, changed here while reading: they apply at once.
function _applyStripFlow(on) {
  _stripSeriesFlow = !!on;
  platform.kv.set({ readerStripMode: _stripSeriesFlow ? 'series' : 'chapter' });
  _rebuildStripInPlace();
  _syncReaderSettingsUI();
}
function _applyChapterTransitions(on) {
  _chapterDividersOn = !!on;
  platform.kv.set({ readerChapterDivider: _chapterDividersOn });
  _rebuildStripInPlace();
  _syncReaderSettingsUI();
}
// A strip built again (another scope, chapter cards coming or going) keeps the point being read on the
// reading line. Page modes take the change at their next turn.
function _rebuildStripInPlace() {
  if (mode !== 'strip') return;
  const at = _stripLineAt(true);
  const n = at ? Number(at.wrap.dataset.page) : currentPage;
  buildStrip();
  _syncThumbScope();
  const wrap = stripView.querySelector(`.page-wrap[data-page="${n}"]`);
  if (wrap) _scrollStripLineTo({ wrap, frac: at?.frac ?? 0, px: at?.px ?? 0 });
  _stripLine = _stripLineAt(true);
}
function _applyTranslateDisplay(next) {
  translateDisplay = next === 'text' ? 'text' : 'image';
  platform.kv.set({ readerTranslateDisplay: translateDisplay });
  if (_showTranslated()) _redrawView();
  _syncReaderSettingsUI();
}
// Study mode's look: how the original and the translation show, and the original's font and furigana.
const STUDY_PREF_KEYS = {
  display:  (v) => ({ readerStudyDisplay: v }),
  original: (v) => ({ readerStudyOriginal: v }),
  srcFont:  (v) => ({ readerStudySrcFont: v }),
  furigana: (v) => ({ readerFurigana: v ? 'on' : 'off' }),
};
function _applyStudyPref(key, value) {
  setStudyPrefs({ [key]: value });
  platform.kv.set(STUDY_PREF_KEYS[key](value));
  if (_bubbleLayersOn()) _refreshBubbleLayers();
  _syncReaderSettingsUI();
}
function _applySkipOverview(skip) {
  _skipOverview = !!skip;
  platform.kv.set({ readerSkipOverview: _skipOverview });
  _syncReaderSettingsUI();
}

let _modeApplied = false;
function setMode(m, skipAnim) {
  // Already in this mode (e.g. pressing 3 repeatedly) → no-op, so we don't rebuild the view
  // and make it jitter. The very first call always runs (the view isn't built yet).
  if (_modeApplied && m === mode) return;
  _modeApplied = true;
  _hidePageDivider();   // never carry a transition page across modes

  mode = m;
  _syncTopButtons();
  setAutoScroll(false);   // a new reading mode stops auto-play
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
    updateCounter();   // a spread's two pages were the current page; now just the one
    if (!skipAnim) requestAnimationFrame(_scrollStripToCurrent);
  } else {
    // The strip, hidden now, stops loading and lets its pages go: it's built afresh on coming back.
    ++_stripGen;
    for (const idx of [..._mountedIdx]) _releaseStripRow(idx);
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
// Keep image drags from leaving the reader unless Ctrl is held when the drag starts.
document.addEventListener('dragstart', (e) => {
  if (e.target instanceof HTMLImageElement && !e.ctrlKey) e.preventDefault();
});

const CLICK_WHEEL_NAV_THRESHOLD = 60;   // fine-grained input: how far to travel for one page
const CLICK_WHEEL_NAV_NOTCH_MIN = 30;   // smallest event still read as one whole wheel detent
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

// How far the wheel has to travel for one page. Two things vary underfoot: a wheel reports its
// deltas in CSS pixels, so the same physical detent shrinks as the page is zoomed in, and how
// many pixels one detent is worth at all comes from the system's scroll settings. Measuring the
// bounds against the zoom factor keeps them describing a fixed physical distance, and letting a
// detent-sized event stand as a whole step keeps one detent worth exactly one page whatever it
// reports. Finer input — a trackpad streaming many small deltas — still has to cover the full
// travel. (The legacy wheelDelta is no help: browsers derive it from deltaY and rescale it the
// same way, so it carries nothing extra.)
function _clickWheelNavStep(delta) {
  const zoom = window.devicePixelRatio || 1;
  const threshold = CLICK_WHEEL_NAV_THRESHOLD / zoom;
  const notch = Math.abs(delta);
  return notch >= CLICK_WHEEL_NAV_NOTCH_MIN / zoom ? Math.min(notch, threshold) : threshold;
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
  _stopScrubEase();
  n = Math.max(1, Math.min(pages.length, n));
  currentPage = n;
  if (n <= _viewBase || n > _viewBase + _viewCount) buildStrip();
  updateCounter();        // applies the new chapter's chrome, which re-scopes the thumbnails
  highlightThumb(n - 1);
  _scrollStripToCurrent();
  _lastSyncCenter = Infinity;
  _scheduleStripSync();
  return true;
}

// A page step in the strip glides to the page's top with our own motion, not the browser's smooth
// scroll: Chrome's starts again from a standstill every time the target moves, so a quick run of
// steps (a spun wheel, a held key) crawled until the input stopped and only then caught up. The
// glide is a critically damped spring: it sets off gently, keeps its speed when the target moves on
// — so a run of steps gets going at once — and settles on the page without overshooting, the same
// in every browser. Anyone else scrolling the page (the reader, a jump) takes over: the glide stops
// as soon as the page isn't where it left it.
const STRIP_GLIDE_RATE = 22;   // spring rate (1/s): one step is 95 % done in about 0.2 s
let _glideEl = null, _glideRaf = null, _glideY = 0, _glideV = 0, _glideAt = null;

function _stopStripGlide() {
  cancelAnimationFrame(_glideRaf);
  _glideRaf = null;
  _glideEl = null;
  document.documentElement.classList.remove('reader-strip-gliding');
}

function _glideStripTo(el) {
  _stopScrubEase();   // a scrub that ended easing gives way to the new destination
  // Smooth page scrolling off (Reader settings), or less motion asked for: there at once.
  if (!readerSmoothScroll || matchMedia('(prefers-reduced-motion: reduce)').matches) { _stopStripGlide(); el.scrollIntoView(); return; }
  _glideEl = el;
  // The glide follows the target's live geometry. Automatic scroll anchoring as images load
  // would look like user scrolling to the cancellation check and strand a long jump midway.
  document.documentElement.classList.add('reader-strip-gliding');
  if (_glideRaf !== null) return;   // already under way: it heads for the new page from here
  _glideY = window.scrollY;
  _glideV = 0;
  _glideAt = null;
  _glideRaf = requestAnimationFrame(_stripGlideFrame);
}

function _stripGlideFrame(now) {
  if (_reshapePending.size) _reshapeRows();   // pages loaded since the last frame take their shapes before it aims
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  // A shorter loaded page can shrink the document and clamp the previous scroll offset.
  if (mode !== 'strip' || !_glideEl?.isConnected || Math.abs(window.scrollY - Math.min(_glideY, max)) > 2) { _stopStripGlide(); return; }
  const target = Math.max(0, Math.min(max, window.scrollY + _glideEl.getBoundingClientRect().top - _pinOffset()));
  const from = window.scrollY;
  // The first frame counts as one frame: no clock says how long ago the glide was asked for (the
  // next frame's timestamp can come before that moment in Chrome — the first step went backwards —
  // and in Firefox the last frame drawn can be long past — it covered the whole page at once).
  const dt = (_glideAt === null ? 1000 / 60 : Math.max(0, now - _glideAt)) / 1000;
  _glideAt = now;
  // The spring's exact motion over dt, however long the frame took: offset from the target, speed.
  const k = STRIP_GLIDE_RATE, offset = from - target, carry = _glideV + k * offset, decay = Math.exp(-k * dt);
  const next = (offset + carry * dt) * decay;
  _glideV = (_glideV - k * carry * dt) * decay;
  // Within a pixel: settle exactly on the page's top.
  if (Math.abs(next) < 1) { window.scrollTo(0, target); _stopStripGlide(); return; }
  window.scrollTo(0, target + next);
  _glideY = window.scrollY;
  // The last steps can be finer than the page scrolls by (a fraction of a pixel on a scaled display),
  // and then it doesn't move at all: that close, settle on the page's top too.
  if (_glideY === from && Math.abs(next) < 8) { window.scrollTo(0, target); _stopStripGlide(); return; }
  _glideRaf = requestAnimationFrame(_stripGlideFrame);
}

function _scrollStripToPage(n) {
  if (!pages.length) return false;
  n = Math.max(1, Math.min(pages.length, n));
  // Chapter-only strip: a target outside the scoped range re-scopes and lands instantly.
  if (n <= _viewBase || n > _viewBase + _viewCount) return _stripJumpTo(n);
  const t = stripView.querySelector(`[data-page="${n}"]`);
  if (!t) return false;
  _glideStripTo(t);
  currentPage = n;
  updateCounter();
  highlightThumb(n - 1);
  _scheduleStripSync();   // start loading the destination before the smooth scroll arrives
  return true;
}

// Like held keys, a continuous click-wheel run breaks at chapter boundaries: it parks on the
// transition page (or the chapter's edge when there is none) and only a session that STARTS
// there (release, then click-hold again) continues into the adjacent chapter.
function _clickWheelPageNav(dir) {
  if (!pages.length) return false;
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
  const rawN = _flipTarget(dir);
  const crossing = chW ? (rawN > chW.start + chW.count || rawN < chW.start + 1) : false;
  if (_clickWheelNavSteps > 0 && crossing && !(_chapterDividersOn && _series)) return false;
  if (_landingPage(rawN) === currentPage && !crossing) return false;
  goTo(rawN);   // raw target — the intercept can show the transition page at the boundary
  _clickWheelNavSteps++;
  return true;
}

function _isClickWheelNavTarget(target) {
  return !target.closest('button, a, input, textarea, select, [contenteditable]');
}

function _armClickWheelNav(e) {
  if (e.button !== 0 || !e.isPrimary) return;
  if (!_isClickWheelNavTarget(e.target)) return;
  clearTimeout(_clickWheelNavClearTimer);
  _clickWheelNavHeld = true;
  _clickWheelNavUsed = false;
  _clickWheelNavDelta = 0;
  _clickWheelNavSteps = 0;
  _clickWheelNavPage = mode === 'strip' ? currentPage : null;
}

viewport.addEventListener('pointerdown', _armClickWheelNav, true);
// The unpinned header's hover strip is an invisible overlay lying across the top of the page,
// not something the reader can act on — without it the gesture would silently do nothing
// whenever the press happened to land in that band.
topbarReveal.addEventListener('pointerdown', _armClickWheelNav, true);

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
  if (Math.abs(_clickWheelNavDelta) < _clickWheelNavStep(delta)) return;
  const dir = _clickWheelNavDelta > 0 ? 1 : -1;
  _clickWheelNavDelta = 0;
  _clickWheelPageNav(dir);
}, { passive: false, capture: true });

document.addEventListener('pointerup', _endClickWheelNav);
document.addEventListener('pointercancel', _endClickWheelNav);
window.addEventListener('blur', _endClickWheelNav);
document.addEventListener('visibilitychange', () => { if (document.hidden) _endClickWheelNav(); });

// Forward (1) or back (−1) for a flip toward one side of the screen, per the navigation direction.
function _sideDir(side) {
  return (readerNavDirection === 'rtl') === (side === 'left') ? 1 : -1;
}

// Single/double: a click on the page turns it, its left half toward the left and its right half
// toward the right (per the navigation direction). Only on the page: the screen beside it is left
// alone, so a double-click there can hide the controls. With study bubbles on the page, its clicks
// are theirs. A chapter's transition page fills the screen: a click anywhere but its card turns off it.
// A click on the card is the card's alone, even once its button has taken the transition page away
// (its next chapter button would otherwise land on that chapter's page 1, then turn on to page 2).
function _pageFlipSideAt(e) {
  if (mode === 'strip' || document.body.classList.contains('study-bubbles-active')) return null;
  if (e.target.closest?.('.chd')) return null;
  if (_pageDivider !== null) return e.clientX < window.innerWidth / 2 ? 'left' : 'right';
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const img of mode === 'single' ? [mainImg] : [imgLeft, imgRight]) {
    const r = _fitItemForImg(img).getBoundingClientRect();
    if (!r.width || !r.height) continue;
    left = Math.min(left, r.left); right = Math.max(right, r.right);
    top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
  }
  if (!(e.clientX >= left && e.clientX <= right && e.clientY >= top && e.clientY <= bottom)) return null;
  return e.clientX < (left + right) / 2 ? 'left' : 'right';
}

// A double-click on the pages hides the controls, or brings them back for good (like X). Not on the
// page in single/double, where those clicks were two page turns. Counted in pairs of quick clicks
// rather than by dblclick, which fires once per run of them: double-clicking again straight away,
// to toggle back, would otherwise do nothing until the pointer had rested.
let _clickPairOpen = false;   // the last click began a pair; a quick next one completes it
viewport.addEventListener('click', (e) => {
  const side = _pageFlipSideAt(e);
  if (side) goTo(_flipTarget(_sideDir(side)));
  const open = _clickPairOpen;
  _clickPairOpen = false;
  if (side || !e.detail || e.target.closest?.('button, a, input, .bubble-box, .chd')) return;
  if (e.detail === 1 || !open) { _clickPairOpen = true; return; }
  window.getSelection()?.removeAllRanges();
  _toggleControls();
});

// ── Page progress: pointing, pressing, dragging ──
// Chapter-relative, like the counter: one segment per page of the chapter being read. Pointing
// anywhere in the bar's zone grows it, and the page under the pointer (the .tip segment) shows its
// number in a pill that slides along the bar from page to page. Pressing goes to that page; dragging
// along the bar keeps going. Dragging away from the bar, into the pages, pulls the thumbnails out of
// it in scrubber mode, as far as the drag has gone — the way a video player brings up its frames when
// its seek bar is dragged up: the bar's position still picks the page, now with the pages to look at.
// Let go, or come back to the bar, before they are all out and they go back in; pulled all the way
// out, they stay open as if toggled. Thumbnails already open are scrubbed in place.
let _barHover = false;
let _barPress = null;   // { pointerId, ch, idx, out, opened } while the bar is pressed
let _barTip = -1;       // local index of the segment showing its number
let _tipAt = 0;         // where the pill is drawn, in pages along the bar (it glides toward _barTip)
let _tipRaf = 0, _tipTime = 0;
const TIP_GLIDE_MS = 40;   // the glide's time constant

const _barVertical = () => readerProgressPosition === 'left' || readerProgressPosition === 'right';

function _syncBarGrown() {
  const grown = _barPress ? !_barPress.out : _barHover;
  bottombar.classList.toggle('grown', grown);
  document.body.classList.toggle('bar-grown', grown);   // lifts open thumbnails clear of it
}

function _setBarTip(idx) {
  if (idx === _barTip) return;
  const from = _barTip;
  scrubSegments.children[from]?.classList.remove('tip');
  _barTip = idx;
  const segment = scrubSegments.children[idx];
  scrubTip.classList.toggle('show', !!segment);
  if (!segment) return;   // sinks back where it is
  segment.classList.add('tip');
  scrubTip.textContent = segment.dataset.n;
  if (from < 0) { _tipAt = idx; _placeTip(); }   // rises over this page; afterwards glides along
  else if (!_tipRaf) { _tipTime = performance.now(); _tipRaf = requestAnimationFrame(_glideTip); }
}

function _placeTip() {
  scrubTip.style.setProperty('--tip-at', `${(_tipAt + 0.5) / scrubSegments.children.length * 100}%`);
}

// Eases toward the page pointed at, but never trails it by more than a page: on a bar of wide pages
// it slides from one to the next, and however fast the pointer sweeps a crowded bar, it keeps up.
function _glideTip(now) {
  _tipRaf = 0;
  if (_barTip < 0) return;
  const left = (_barTip - _tipAt) * Math.exp(-Math.max(0, now - _tipTime) / TIP_GLIDE_MS);
  _tipTime = now;
  _tipAt = Math.abs(left) < 0.01 ? _barTip : _barTip - Math.max(-1, Math.min(1, left));
  _placeTip();
  if (_tipAt !== _barTip) _tipRaf = requestAnimationFrame(_glideTip);
}

// Where along the bar the pointer is, in pages of the chapter it shows: 0 at the first page's
// leading edge, the page count at the last one's trailing edge.
function _barPosAt(e) {
  const r = scrubSegments.getBoundingClientRect();
  const count = scrubSegments.children.length;
  const f = _barVertical() ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
  return Math.max(0, Math.min(count, f * count));
}
const _barIdxAt = (e) => Math.min(scrubSegments.children.length - 1, Math.floor(_barPosAt(e)));

// How far past the bar's zone the drag has gone, toward the pages (negative: still on the bar), and
// the zone's thickness.
function _barDragOut(e) {
  const r = bottombar.getBoundingClientRect();
  switch (readerProgressPosition) {
    case 'top':   return { past: e.clientY - r.bottom, zone: r.height };
    case 'left':  return { past: e.clientX - r.right, zone: r.width };
    case 'right': return { past: r.left - e.clientX, zone: r.width };
    default:      return { past: r.top - e.clientY, zone: r.height };
  }
}

function _barScrubAlong(press, e) {
  const idx = _barIdxAt(e);
  _setBarTip(idx);
  if (idx === press.idx) return;
  press.idx = idx;
  const n = press.ch.start + idx + 1;
  if (mode === 'strip') _scrollStripToPage(n);
  else goTo(n, true);   // absolute jump — never show the transition page
}

function _barStartThumbScrub(press) {
  press.out = true;
  _setBarTip(-1);
  _syncBarGrown();
  if (!thumbsOpen) {
    press.opened = true;
    document.body.classList.add('thumb-revealing');   // before it opens, so it never springs open
    setThumbsOpen(true, false);
  }
  _stopThumbFollow();
  cancelAnimationFrame(_swipeRaf);
  cancelAnimationFrame(_wheelRaf); _wheelRaf = null; _wheelTarget = null;
  _thumbDragging = true;
  _scrubSetY = null;
  thumbStrip.classList.add('dragging', 'scrubbing');
  bottombar.classList.add('out');   // the grabbing hand: the bar holds the pointer, so its cursor is the drag's
}

// The middle of a page's segment is that page's thumb (and, in the strip, its top), so the pick
// carries straight on from where the drag left the bar. It stays within the chapter the bar shows,
// even where the strip goes on into its neighbours: from its first page's top to, in the strip, its
// last page's bottom at the bottom of the screen. After the page moved under the scrub, the pick
// bends through the place it picked up from (press.anchor), so the next move carries on from there.
function _barScrubThumbs(press, e) {
  press.pos = _barPosAt(e);
  press.clientX = e.clientX;
  const from = press.ch.start - _thumbBase, count = scrubSegments.children.length, last = from + count - 1;
  const end = mode === 'strip' && _stripWraps.length > 1 ? Math.max(from, _rowEndP(last) * (_thumbCount - 1)) : last;
  const t = _mapThrough(press.pos, _anchoredPath([[0, from - 0.5], [count, Math.max(from + count - 0.5, end)]], press.anchor));
  _scrubThumbsTo(Math.max(from, Math.min(end, t)), _barVertical() ? null : e.clientX);
}

function _barFollowScroll(press, p) {
  const t = p * (_thumbCount - 1);
  if (press.pos != null) press.anchor = [press.pos, t];
  _scrubThumbsTo(t, _barVertical() ? null : press.clientX, false);
}

function _barEndThumbScrub(press) {
  _thumbDragging = false;
  _scrubSetY = null;
  thumbStrip.classList.remove('dragging', 'scrubbing');
  bottombar.classList.remove('out');
  // Land the virtualized window exactly where the scrub ended.
  if (mode === 'strip') { _lastSyncCenter = Infinity; _scheduleStripSync(); }
  if (!press.opened) return;
  _barEndReveal();
  if (press.revealed) platform.kv.set({ readerThumbsOpen: true });   // let go all the way out: it stays open
  else setThumbsOpen(false, false);                                 // slides back in from where it got to
}

// The strip comes out as far as the drag has gone past the bar, and goes back in as the drag comes
// back while it's held, the go-to-top button and the side controls' zoom riding on its edge. Let go
// with all of it out, it stays open, as if toggled; let go short of that, it goes back in
// (_barEndThumbScrub).
function _barReveal(press, past) {
  const shown = Math.min(_thumbHeight, Math.max(0, past) * (window.devicePixelRatio || 1));   // in the strip's own (counter-zoomed) px
  press.revealed = shown >= _thumbHeight;
  thumbStrip.style.height = `${shown}px`;
  document.documentElement.style.setProperty('--thumb-shown', `${shown}px`);   // the go-to-top button and zoom ride on it
}

function _barEndReveal() {
  document.body.classList.remove('thumb-revealing');
  thumbStrip.style.height = '';
  document.documentElement.style.removeProperty('--thumb-shown');
}

// Back on the bar before the strip was all out: it goes back in, and the bar picks the page again.
function _barReturnToBar(press) {
  _barEndThumbScrub(press);
  press.out = press.opened = false;
  press.idx = -1;
  press.pos = press.anchor = null;
  _syncBarGrown();
}

// Pressing the bar and dragging along or away from it never selects page text. (A class on <body>
// with a `*` rule did this, restyling every element of the page on each press and release — 13 ms
// with a long chapter's bar and thumbnails, before the first page of a scrub could even be read.)
document.addEventListener('selectstart', (e) => { if (_barPress) e.preventDefault(); });

bottombar.addEventListener('pointerenter', () => { _barHover = true; _syncBarGrown(); });
bottombar.addEventListener('pointerleave', () => {
  _barHover = false;
  _cancelPreloadOnRest();
  if (!_barPress) _setBarTip(-1);
  _syncBarGrown();
});
bottombar.addEventListener('pointermove', (e) => {
  const ch = _chapters[_curChIdx];
  if (_barPress || !ch || !scrubSegments.children.length) return;
  const idx = _barIdxAt(e);
  _setBarTip(idx);
  _preloadOnRest(ch.start + idx + 1, true);   // the page a press here shows, and the thumbnails around it
});
bottombar.addEventListener('pointerdown', (e) => {
  const ch = _chapters[_curChIdx];
  if (e.button !== 0 || !ch || !scrubSegments.children.length) return;
  e.preventDefault();
  // The bar holds the pointer until it's let go, so the cursor is the bar's wherever the drag goes: the
  // hand, then the grabbing hand once out in the thumbnails. Chrome picks a move's cursor before that
  // move's handlers run, so the pages under a drag just leaving the bar showed their arrow for a moment.
  try { bottombar.setPointerCapture(e.pointerId); } catch {}
  _cancelPreloadOnRest();
  const press = _barPress = { pointerId: e.pointerId, ch, idx: -1, out: false, opened: false, revealed: false };
  _syncBarGrown();
  _barScrubAlong(press, e);
  const move = (ev) => {
    if (ev.pointerId !== press.pointerId) return;
    const { past, zone } = _barDragOut(ev);
    // Open thumbnails take the scrub once the drag is clear of the bar; closed ones start coming out at once.
    if (!press.out && past > (thumbsOpen ? zone : 0)) _barStartThumbScrub(press);
    else if (press.opened && past <= 0) _barReturnToBar(press);
    if (press.opened) _barReveal(press, past);
    if (press.out) _barScrubThumbs(press, ev);
    else _barScrubAlong(press, ev);
  };
  const up = (ev) => {
    if (ev.pointerId !== press.pointerId) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    if (press.out) _barEndThumbScrub(press);
    _barPress = null;
    // Held, the bar heard no pointerleave while the drag was away: ask whether it's still over the bar.
    _barHover = bottombar.contains(document.elementFromPoint(ev.clientX, ev.clientY));
    _setBarTip(_barHover ? _barIdxAt(ev) : -1);
    _syncBarGrown();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
});

// Too many pages for the bar's length: below this many device pixels a page, the gaps between
// segments would outweigh the pages, so the bar drops them.
const BAR_DENSE_PX = 5;
function _syncBarDensity() {
  const count = scrubSegments.children.length;
  const r = scrubSegments.getBoundingClientRect();
  const length = (_barVertical() ? r.height : r.width) * (window.devicePixelRatio || 1);
  bottombar.classList.toggle('dense', count > 0 && length / count < BAR_DENSE_PX);
}

// The band over the segments: exactly the part of the pages the screen shows below a pinned header,
// fractions of a page included, as one range per shown page column (a double spread shows two).
let _scrubViewQueued = false;
function _scheduleScrubView() {
  if (_scrubViewQueued) return;
  _scrubViewQueued = true;
  requestAnimationFrame(() => { _scrubViewQueued = false; _syncScrubView(); });
}

function _syncScrubView() {
  const ch = _chapters[_curChIdx];
  const ranges = ch ? _shownRanges(ch) : [];
  while (scrubView.children.length < ranges.length) {
    const band = document.createElement('div');
    band.className = 'scrub-view';
    scrubView.appendChild(band);
  }
  const vertical = _barVertical();
  [...scrubView.children].forEach((band, i) => {
    const r = ranges[i];
    if (!r) { band.style.cssText = 'display:none'; return; }
    const from = r[0] / ch.count * 100, size = (r[1] - r[0]) / ch.count * 100;
    band.style.cssText = vertical ? `top:${from}%;height:${size}%` : `left:${from}%;width:${size}%`;
  });
}

// The page in the strip at document y, as a fractional global index: 12.25 is a quarter of the way
// down the 13th page.
function _stripPageAt(y) {
  const i = _stripRowAt(y), wrap = _stripWraps[i];
  return _viewBase + i + Math.max(0, Math.min(1, (y - wrap.offsetTop) / Math.max(1, wrap.offsetHeight)));
}

// What the screen shows, as [from, to] ranges in pages of `ch` (0 is its first page's top).
function _shownRanges(ch) {
  const top = _pinOffset(), bottom = window.innerHeight;
  const clip = (a, b) => {
    a = Math.max(0, a - ch.start);
    b = Math.min(ch.count, b - ch.start);
    return b > a ? [a, b] : null;
  };
  if (mode === 'strip') {
    if (!_stripWraps.length) return [];
    return [clip(_stripPageAt(window.scrollY + top), _stripPageAt(window.scrollY + bottom))].filter(Boolean);
  }
  if (_pageDivider !== null) return [];
  let shown = [[currentPage, mainImg]];
  if (mode === 'double') {
    const { lead, trail } = _spreadAt(currentPage);
    shown = [[lead, imgLeft], [trail, imgRight]].filter(([n]) => n);
  }
  return shown.map(([n, img]) => {
    const r = img.getBoundingClientRect();
    if (!r.height) return null;
    const at = (y) => Math.max(0, Math.min(1, (y - r.top) / r.height));
    return clip(n - 1 + at(top), n - 1 + at(bottom));
  }).filter(Boolean);
}

// Pages resizing (loading, zoom, fit, a resized window) move what the screen shows.
const _scrubViewResize = new ResizeObserver(_scheduleScrubView);
[stripView, singleInner, doubleInner].forEach(el => _scrubViewResize.observe(el));

// Reading-mode segmented toggle: each square selects its mode; the indicator slides across.
function _updateModeToggle() {
  modeToggle.dataset.state = mode;
  modeSingle.classList.toggle('active', mode === 'single');
  modeDouble.classList.toggle('active', mode === 'double');
  modeStrip.classList.toggle('active', mode === 'strip');
  _syncSideNav();
}
modeSingle.addEventListener('click', () => setMode('single'));
modeDouble.addEventListener('click', () => setMode('double'));
modeStrip.addEventListener('click', () => setMode('strip'));

// Back to top (the classic button, the rail's last one): the strip glides to its top, the way a jump
// does, and auto-play makes way for the glide (_autoScrollFrame). Going back up pauses auto-play,
// unless Reader settings says not to; then it reads on from the top.
function _backToTop() {
  if (mode !== 'strip') return;
  if (_autoRaf && readerAutoPauseOnUp) setAutoScroll(false);
  _glideStripTo(stripView);
}
scrollTopBtn.addEventListener('click', _backToTop);
window.addEventListener('scroll', () => {
  _noteScroll();   // how fast the strip moves decides whether full pages load (_stripFlying)
  _syncTopButtons();
  if (mode === 'strip' && !_thumbDragging) {
    // One proportion drives everything: the current page (counter + active-thumb border) and the
    // fill indicator, so the border tracks the fill. This listener fires every frame (unlike the
    // page-crossing observer), so a programmatic jump settles on the right page on its own.
    const p = _scrollYToProportion(window.scrollY + _pinOffset());
    _setCurrentPageFromProportion(p);
    _scheduleStripSync();   // keep the virtualized window aimed at the reading line
    if (thumbsOpen) _setIndicator(p);
  } else if (mode === 'strip' && _scrubSetY !== null && Math.abs(window.scrollY - _scrubSetY) > 2) {
    _scrubFollowScroll();   // something other than the scrub moved the page under it
  }
  _stripLine = _stripLineAt(true);   // where a resize puts the strip's reading line back
  _scheduleScrubView();               // the progress bar's band follows what the screen shows
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
    const { lead, trail } = _spreadAt(currentPage);
    if (lead) _swapImg(imgLeft, pages[lead - 1]);
    if (trail) _swapImg(imgRight, pages[trail - 1]);
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
  _redrawView();
  _updateViewToggle();
  platform.kv.set({ readerView: target });
}

// The pages on screen drawn again in the variant and with the overlays the view now asks for.
function _redrawView() {
  _swapVisibleVariant();      // re-point images to the right variant (study forces original)
  _refreshBubbleLayers();     // builds overlays when they're on, tears them down otherwise
  // Overlays come from the study layers; if they are still loading, build them once they land.
  if (_bubbleLayersOn() && !_studyLoaded) _loadStudy().then(() => { if (_bubbleLayersOn()) _refreshBubbleLayers(); });
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
  _syncSideNav();
}

// Click a side to turn it on (and the other off); click the active side again to turn it off.
translateSeg.addEventListener('click', () => setView(translateView ? 'off' : 'translate'));
studySeg.addEventListener('click', () => { if (hasStudy) setView(studyMode ? 'off' : 'study'); });

// ── Study mode: reveal translated bubbles one at a time over the clean original ──
function _mountTextBubble(box, b, idx, pageUrl, bgLayer, fgLayer, pg, srcOpts, hasPageBg) {
  const urls = _layerUrls(pageUrl);
  const hasBg = !!(urls && urls.bgUrl);
  if (hasBg && !hasPageBg) {
    const clip = _clipInset(b.region);
    const bg = document.createElement('img');
    bg.className = 'study-layer-img'; bg.src = urls.bgUrl;
    // Lazy loading would hold a page mode's patch back a frame even when already decoded.
    bg.decoding = 'async'; bg.loading = mode === 'strip' ? 'lazy' : 'eager';
    bg.style.clipPath = clip; bg.style.webkitClipPath = clip;
    bgLayer.appendChild(bg);
  }
  const srcEl = _buildStudySrc(b, hasBg, pg, srcOpts);
  let trEl;
  if (studyPrefs().display !== 'text' && urls && urls.textUrls[idx]) {
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
    tagFeedback(box, idx, true, showTr ? 'translation' : 'ocr');
    tagFeedback(trEl, idx, showTr);
    tagFeedback(srcEl, idx, !showTr, 'ocr');
    const visibleIsText = showTr ? trIsText : srcIsText;
    const visibleRect = showTr ? _studyTranslationRect(b) : _studySourceRect(b);
    // DOM text owns its visible hover treatment. Keep the broader replacement region beneath it
    // as an invisible pointer/click target for the empty area surrounding the text itself. (A
    // bubble with a shape hovers and clicks on the shape instead, text included.)
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
    if (!(srcIsText || trIsText)) { box.style.pointerEvents = 'none'; box.classList.remove('shape-hit'); }
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
  tagFeedback(box, idx, true, on ? 'translation' : 'original');
  _positionBubbleIndicator(box, on ? _studyTranslationRect(b) : _studySourceRect(b));
  if (on) {
    if (!box._layers) {
      const study = studyFor(pageUrl);
      const urls = _layerUrls(pageUrl);
      const els = [];
      if (urls && urls.bgUrl) {
        const clip = _clipInset(b.region);
        const bg = document.createElement('img');
        bg.className = 'study-layer-img'; bg.src = urls.bgUrl;
        bg.style.clipPath = clip; bg.style.webkitClipPath = clip;
        bgLayer.appendChild(bg); els.push(bg);
      }
      const asText = studyPrefs().display === 'text' || !(urls && urls.textUrls[idx]);
      if (asText) {
        const wrap = fgLayer.closest('.page-wrap');
        const pageW = (study && study.page && study.page.w) ||
                      (wrap && wrap.querySelector('img')?.naturalWidth) || 0;
        const tx = _buildStudyText(b, !!(urls && urls.bgUrl), pageW);
        if (!tx) {
          els.forEach(el => el.remove());
          box.classList.remove('revealed');
          tagFeedback(box, idx, true, 'original');
          _positionBubbleIndicator(box, _studySourceRect(b));
          return;
        }
        _wireSelectableText(tx, () => box.click());
        tagFeedback(tx, idx);
        fgLayer.appendChild(tx); els.push(tx);
      } else {
        const tx = document.createElement('img');
        tx.className = 'study-layer-img'; tx.src = urls.textUrls[idx];
        tagFeedback(tx, idx);
        fgLayer.appendChild(tx); els.push(tx);
      }
      if (!els.length) {
        box.classList.remove('revealed');
        tagFeedback(box, idx, true, 'original');
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

// Set the source language when metadata or the OCR'd text identifies Japanese or Chinese so the
// browser chooses the appropriate Han glyph forms. Furigana remains Japanese-only.
function _renderTranslateTextLayer(wrap, page) {
  const study = studyFor(page.url);
  if (!study) return;
  const { overlay } = translationView(study, translateDisplay);
  if (!overlay) return;
  const pageW = (study.page && study.page.w) || wrap.querySelector('img')?.naturalWidth || 0;
  let texts;
  if (overlay === 'images') {
    // The page kept as its study layers: every balloon's text layer over the background is the page.
    const urls = _layerUrls(page.url);
    texts = (urls?.textUrls || []).filter(Boolean).map(src => {
      const img = document.createElement('img');
      img.className = 'study-layer-img'; img.src = src; img.alt = ''; img.decoding = 'async'; img.draggable = false;
      return img;
    });
  } else {
    texts = study.bubbles.map(b => _buildStudyText(b, true, pageW)).filter(Boolean);
    texts.forEach(el => el.classList.add('plain'));
  }
  if (!texts.length) return;
  const layer = document.createElement('div');
  layer.className = 'bubble-layer';
  const fgLayer = document.createElement('div');
  fgLayer.className = 'bubble-fg';
  for (const el of texts) fgLayer.appendChild(el);
  layer.appendChild(fgLayer);
  _syncLayerScale(layer, wrap, pageW);
  wrap.appendChild(layer);
}

// Build one page's overlay: a bg sub-layer, a text sub-layer, and the clickable boxes on top.
// Each hover/click indicator follows whichever source or translation region is currently visible
// and is positioned by page fraction (percent), so it tracks zoom/resize with no recompute.
function _renderBubbleLayer(wrap, pageNum) {
  const page = pages[pageNum - 1];
  if (!page) return;
  wrap.dataset.feedbackPage = String(pageNum);
  if (!studyMode) { _renderTranslateTextLayer(wrap, page); return; }
  const study = studyFor(page.url);
  const hasBubbles = !!study && Array.isArray(study.bubbles) && study.bubbles.length > 0;
  if (!hasBubbles && mode === 'strip') return;
  const layer = document.createElement('div');
  layer.className = 'bubble-layer';
  const bgLayer = document.createElement('div'); bgLayer.className = 'bubble-bg';
  const fgLayer = document.createElement('div'); fgLayer.className = 'bubble-fg';
  layer.appendChild(bgLayer);
  layer.appendChild(fgLayer);
  const pageW = (study?.page && study.page.w) || wrap.querySelector('img')?.naturalWidth || 0;
  _syncLayerScale(layer, wrap, pageW);
  // Page-flip zones under the bubbles (page modes only): click a bubble to reveal it, click
  // anywhere else on the page to turn the page — restoring the side-click navigation that the
  // fixed click-zones provide outside study mode. Strip mode scrolls instead.
  if (mode !== 'strip') {
    const nav = document.createElement('div'); nav.className = 'bubble-nav';
    const zone = (handler) => { const z = document.createElement('div'); z.addEventListener('click', handler); return z; };
    if (mode === 'single') {
      nav.append(zone(() => goTo(_flipTarget(_sideDir('left')))), zone(() => goTo(_flipTarget(_sideDir('right')))));
    } else {              // double: this page turns the whole spread toward its side of the screen
      nav.append(zone(() => {
        const onLeft = (pageNum === _spreadAt(currentPage).lead) === (readerPageDirection === 'ltr');
        goTo(_flipTarget(_sideDir(onLeft ? 'left' : 'right')));
      }));
    }
    layer.appendChild(nav);
  }
  if (!hasBubbles) { wrap.appendChild(layer); return; }
  // Original-as-text mounts every bubble open on its original text; original-as-image keeps
  // the untouched page and the click-to-reveal flow.
  // Original-as-text sits on the page's clean background; a page without one shows its original.
  const origText = studyPrefs().original === 'text' && !!study.bg;
  const srcLang = origText ? (_sourceTextLang(_chapters[_chapterAt(pageNum)]?.meta) || _sniffSourceLang(study.bubbles)) : '';
  const srcOpts = { lang: srcLang, furi: studyPrefs().furigana && srcLang === 'ja' };
  // When both sides are selectable text, the cleaned Study image is the page background. One
  // full-page layer is both cheaper and more accurate than stacking one clipped copy per bubble.
  const urls = origText && studyPrefs().display === 'text' ? _layerUrls(page.url) : null;
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
  // A bubble with a renderer shape hovers as that outline and clicks inside it, whether it shows
  // its original or its translation; one given the very same area as another text keeps its
  // region as the click target.
  const sharedShapes = _sharedShapes(study.bubbles);
  study.bubbles.forEach((b, i) => {
    const box = document.createElement('div');
    box.className   = 'bubble-box';
    const shape = _buildBubbleShape(b);
    if (shape) {
      box.appendChild(shape);
      box.classList.add('shaped');
      if (!sharedShapes.has(b)) box.classList.add('shape-hit');
    }
    tagFeedback(box, i, true, 'original');
    _positionBubbleIndicator(box, _studySourceRect(b));
    if (origText) {
      _mountTextBubble(box, b, i, page.url, bgLayer, fgLayer, (study.page || { w: pageW }), srcOpts, hasPageBg);
    } else {
      box.addEventListener('click', (e) => _toggleBubble(e, box, b, i, page.url, bgLayer, fgLayer));
      box._reset = () => {
        box.classList.remove('revealed', 'text-revealed');
        tagFeedback(box, i, true, 'original');
        (box._layers || []).forEach(el => { el.style.display = 'none'; });
        _positionBubbleIndicator(box, _studySourceRect(b));
      };
    }
    layer.appendChild(box);
  });
  wrap.appendChild(layer);
}

// Strip rows near the reading line that carry overlays.
function _overlayStripRows() {
  const center = currentPage - _viewBase;   // local, 1-based
  return [..._mountedIdx].filter(idx => Math.abs(idx + 1 - center) <= _mountAhead);
}

// Drop every overlay. The layer images of the pages shown (and, in page modes, of the warm pages
// around them) keep their URLs, so the overlays rebuilt next paint from images already decoded.
function _clearBubbleLayers() {
  const keepPages = mode === 'strip' ? _overlayStripRows().map(idx => Number(_stripWraps[idx]?.dataset.page)) : _nearPages(currentPage);
  _removeBubbleLayers(new Set(keepPages.map(p => pages[p - 1]?.url).filter(Boolean)));
}

// Rebuild the overlays for whichever page images are mounted in the current view.
function _refreshBubbleLayers() {
  _clearBubbleLayers();
  if (!_bubbleLayersOn()) return;
  if (mode === 'strip') {
    for (const idx of _overlayStripRows()) {
      const wrap = _stripWraps[idx];
      if (wrap) _renderBubbleLayer(wrap, parseInt(wrap.dataset.page));
    }
  } else if (mode === 'single') {
    _renderBubbleLayer(_ensureWrap(mainImg), currentPage);
  } else if (mode === 'double') {
    const { lead, trail } = _spreadAt(currentPage);
    if (lead) _renderBubbleLayer(_ensureWrap(imgLeft), lead);
    if (trail) _renderBubbleLayer(_ensureWrap(imgRight), trail);
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
  readerSettingsBox.querySelectorAll('[data-nav-direction]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.navDirection === readerNavDirection);
  });
  readerSettingsBox.querySelectorAll('[data-page-direction]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pageDirection === readerPageDirection);
  });
  readerCoverOffsetInput.checked = readerCoverOffset;
  readerDebugLoadedInput.checked = readerDebugLoaded;
  readerOverviewInput.checked = !_skipOverview;
  readerStripFlowInput.checked = _stripSeriesFlow;
  readerTransitionsInput.checked = _chapterDividersOn;
  readerPauseOnUpInput.checked = readerAutoPauseOnUp;
  readerSmoothScrollInput.checked = readerSmoothScroll;
  const study = studyPrefs();
  readerFuriganaInput.checked = study.furigana;
  readerStudyFontSelect.value = study.srcFont;
  for (const [attr, value] of [['data-translate-display', translateDisplay], ['data-study-original', study.original],
    ['data-study-display', study.display]]) {
    readerSettingsBox.querySelectorAll(`[${attr}]`).forEach(btn => btn.classList.toggle('active', btn.getAttribute(attr) === value));
  }
  // The original's font and furigana are for the original shown as text.
  readerStudyTextGroup.disabled = study.original !== 'text';
  // The modern navigation's place; the classic one has none.
  readerNavPlaceGroup.disabled = readerNavLayout !== 'side';
  for (const picker of PICKERS) _syncPickButton(picker);
  readerSettingsBox.querySelectorAll('[data-reader-fit]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.readerFit === readerFitMode);
  });
  readerGap.value = readerPageGap;
  readerGap.style.setProperty('--fill', `${readerPageGap / Number(readerGap.max) * 100}%`);
  readerGapValue.textContent = `${readerPageGap} px`;
  readerSettingsBox.querySelectorAll('[data-reader-nav]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.readerNav === readerNavLayout);
  });
  readerAutoScrollInput.value = readerAutoScrollSpeed;
  readerAutoScrollInput.style.setProperty('--fill', `${(readerAutoScrollSpeed - 20) / 980 * 100}%`);
  readerAutoScrollValue.textContent = _speedLabel();
  readerDimInput.value = readerDim;
  readerDimInput.style.setProperty('--fill', `${readerDim}%`);
  readerDimValue.textContent = `${readerDim}%`;
  _syncSideZoom();
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
  } else {
    _closePicker();
    // The keyboard goes back to the button that opened them; a mouse leaves the focus nowhere.
    if (document.activeElement && readerSettingsModal.contains(document.activeElement)) {
      if (_focusByKeys) (readerNavLayout === 'side' ? snSettings : readerSettingsBtn).focus();
      else document.activeElement.blur();
    }
  }
}

// The settings are set in the UI font's semibold and bold, which the reader's own chrome hardly
// uses: asked for now, so the settings open at their size instead of growing once a face arrives.
for (const weight of [600, 700]) document.fonts?.load(`${weight} 1em "JetBrains Mono"`).catch(() => {});

// ── Reader settings: tabs ──
// The most used settings first; they open on the tab last shown. The box keeps its top from tab to
// tab, ending with the tab shown (reader.css).
const rsTabs = [...readerSettingsBox.querySelectorAll('[role="tab"]')];
const rsPanels = [...readerSettingsBox.querySelectorAll('[role="tabpanel"]')];
// Every tab is a stop for Tab (Enter or Space shows it); the arrows, Home and End go from tab to tab.
function _showSettingsTab(tab, focus) {
  for (const other of rsTabs) other.setAttribute('aria-selected', String(other === tab));
  for (const panel of rsPanels) panel.classList.toggle('active', panel.id === tab.getAttribute('aria-controls'));
  _closePicker();
  if (focus) tab.focus();
}
for (const tab of rsTabs) {
  tab.addEventListener('click', () => _showSettingsTab(tab));
  tab.addEventListener('keydown', (e) => {
    const i = rsTabs.indexOf(tab);
    const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: rsTabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    _showSettingsTab(rsTabs[(next + rsTabs.length) % rsTabs.length], true);
  });
}

// ── Reader settings: placement pickers ──
// A button drawn as where something stands. Pressed, its choices come up around it: a cross of the
// window's edges (the progress bar's Off in a corner) and, for the navigation, once an edge is
// picked, the places along it: its start and end in the corners beside that edge, its centre on the
// edge's own cell. A click opens them and a click picks; a press dragged onto a choice picks it where
// it lets go, an edge with places showing them as the drag comes onto it. The button stays in the
// middle: pressed again, it puts them away.
const EDGE_CELL = { top: [0, -1], left: [-1, 0], right: [1, 0], bottom: [0, 1] };
const ALONG_CELL = {
  top:    { start: [-1, -1], center: [0, -1], end: [1, -1] },
  bottom: { start: [-1, 1],  center: [0, 1],  end: [1, 1] },
  left:   { start: [-1, -1], center: [-1, 0], end: [-1, 1] },
  right:  { start: [1, -1],  center: [1, 0],  end: [1, 1] },
};
const _acrossEdge = (edge) => edge === 'top' || edge === 'bottom';
const _edgeLabel = (edge) => t(`rd.${edge}`);
// Along a top or bottom edge, its start is the left; along a side, the top.
const _alongLabel = (edge, along) => t(along === 'center' ? 'rd.center'
  : _acrossEdge(edge) ? (along === 'start' ? 'rd.left' : 'rd.right') : (along === 'start' ? 'rd.top' : 'rd.bottom'));
const _placeLabel = (edge, along) => (along ? `${_edgeLabel(edge)} · ${_alongLabel(edge, along)}` : _edgeLabel(edge));

// A window, with a bar along the whole of an edge or at a place along it; Off crosses it out.
function _pickIcon(edge, along) {
  const frame = '<rect width="18" height="18" x="3" y="3" rx="2"/>';
  if (edge === 'off') return `<svg class="rs-ico" viewBox="0 0 24 24" aria-hidden="true">${frame}<path d="m3.5 3.5 17 17"/></svg>`;
  const at = edge === 'top' || edge === 'left' ? 7.5 : 16.5;
  const [from, len] = along ? [{ start: 7, center: 9.5, end: 12 }[along], 5] : [7.5, 9];
  const d = _acrossEdge(edge) ? `M${from} ${at}h${len}` : `M${at} ${from}v${len}`;
  return `<svg class="rs-ico" viewBox="0 0 24 24" aria-hidden="true">${frame}<path class="rs-bar" d="${d}"/></svg>`;
}

const PICKERS = [
  { btn: document.getElementById('readerNavPlace'), value: document.getElementById('readerNavPlaceValue'),
    edges: ['top', 'left', 'right', 'bottom'], along: true,
    current: () => ({ edge: readerNavPos, along: readerNavAlign }), pick: (edge, along) => applyReaderNavPlace(edge, along) },
  { btn: document.getElementById('readerProgress'), value: document.getElementById('readerProgressValue'),
    edges: ['top', 'left', 'right', 'bottom'], off: [1, 1],
    current: () => ({ edge: readerProgressPosition }), pick: (edge) => _applyReaderProgressPosition(edge) },
  { btn: document.getElementById('readerAutoBar'), value: document.getElementById('readerAutoBarValue'),
    edges: ['top', 'bottom'],
    current: () => ({ edge: readerAutoBarPosition }), pick: (edge) => _applyReaderAutoBarPosition(edge) },
];

function _syncPickButton(p) {
  const { edge, along } = p.current();
  p.btn.innerHTML = _pickIcon(edge, along);
  p.value.textContent = _placeLabel(edge, along);
}

let _pick = null;          // the open picker: { picker, edge (whose places show), press }
let _pickOwnClick = false; // the click that ends a press on a picker's button is that press's

// Its choices, each in its cell of the 3×3 around the button (--col, --row); reader.css stands them
// around the button that opened them (anchored to it), as near it as the window allows.
function _renderPicker() {
  const p = _pick.picker, now = p.current();
  const cells = [];
  for (const edge of p.edges) {
    if (p.along && _pick.edge === edge) {
      for (const along of NAV_ALIGNS) cells.push({ edge, along, at: ALONG_CELL[edge][along], current: now.edge === edge && now.along === along });
    } else {
      cells.push({ edge, at: EDGE_CELL[edge], current: now.edge === edge, opens: !!p.along });
    }
  }
  if (p.off) cells.push({ edge: 'off', at: p.off, current: now.edge === 'off' });
  rsPicker.replaceChildren(...cells.map(c => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = `rs-pick-cell${c.current ? ' current' : ''}`;
    cell.setAttribute('role', 'menuitem');
    cell.dataset.edge = c.edge;
    if (c.along) cell.dataset.along = c.along;
    if (c.opens) cell.dataset.opens = '';
    cell.style.setProperty('--col', c.at[0]);
    cell.style.setProperty('--row', c.at[1]);
    cell.innerHTML = _pickIcon(c.edge, c.along);
    cell.dataset.tip = _placeLabel(c.edge, c.along);
    cell.setAttribute('aria-label', cell.dataset.tip);
    return cell;
  }));
}

function _openPicker(p) {
  _closePicker();
  _pick = { picker: p, edge: null, press: null };
  p.btn.setAttribute('aria-expanded', 'true');
  rsPicker.hidden = false;
  _renderPicker();
}
function _closePicker(refocus) {
  if (!_pick) return;
  const { btn } = _pick.picker;
  _pick = null;
  rsPicker.hidden = true;
  rsPicker.replaceChildren();
  btn.setAttribute('aria-expanded', 'false');
  if (refocus && _focusByKeys) btn.focus();   // for the keyboard, back to its button
}
const _pickerOpen = () => !!_pick;

// A choice taken: clicked, an edge with places shows them; anything else, or a drag let go on an edge
// (its centre), is picked.
function _takeCell(cell, dragged) {
  const p = _pick.picker, edge = cell.dataset.edge;
  if (cell.dataset.opens !== undefined && !dragged) {
    _pick.edge = edge;
    _renderPicker();
    rsPicker.querySelector('[data-along="center"]')?.focus();
    return;
  }
  _closePicker(true);
  p.pick(edge, cell.dataset.along || (cell.dataset.opens !== undefined ? 'center' : undefined));
}

function _cellUnder(e) {
  return document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.rs-pick-cell') || null;
}
const _onButton = (btn, e) => {
  const r = btn.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
};

for (const p of PICKERS) {
  p.btn.setAttribute('aria-expanded', 'false');
  p.btn.addEventListener('pointerdown', (e) => {
    _pickOwnClick = false;
    if (e.button !== 0 || p.btn.matches(':disabled')) return;   // its row may be what's disabled
    const opening = _pick?.picker !== p;
    if (opening) _openPicker(p);
    // Until the pointer leaves the button it's a click on it, even with a choice drawn over it (near
    // the window's top or bottom the choices shift to stay inside it).
    _pick.press = { id: e.pointerId, opening, left: false };
    p.btn.setPointerCapture(e.pointerId);
  });
  p.btn.addEventListener('pointermove', (e) => {
    const press = _pick?.press;
    if (!press || e.pointerId !== press.id) return;
    if (!press.left && _onButton(p.btn, e)) return;
    press.left = true;
    let cell = _cellUnder(e);
    if (cell?.dataset.opens !== undefined && _pick.edge !== cell.dataset.edge) {
      _pick.edge = cell.dataset.edge;   // dragged onto an edge: its places come up, the drag on its centre
      _renderPicker();
      cell = _cellUnder(e);
    }
    for (const other of rsPicker.children) other.classList.toggle('hot', other === cell);
  });
  p.btn.addEventListener('pointerup', (e) => {
    const press = _pick?.press;
    if (!press || e.pointerId !== press.id) return;
    _pick.press = null;
    _pickOwnClick = true;
    if (!press.left) {   // a click on the button: it opened them, or puts them away again
      if (!press.opening) _closePicker();
      return;
    }
    const cell = _cellUnder(e);
    if (cell) { _takeCell(cell, true); return; }
    if (!_onButton(p.btn, e)) _closePicker();   // let go anywhere else: nothing picked (back on the button, they stay)
  });
  p.btn.addEventListener('pointercancel', () => { if (_pick) _pick.press = null; });
  // From the keyboard (or a click the press didn't make): open on the choice it is now, or close.
  p.btn.addEventListener('click', () => {
    if (_pickOwnClick) { _pickOwnClick = false; return; }
    if (_pick?.picker === p) { _closePicker(); return; }
    _openPicker(p);
    (rsPicker.querySelector('.current') || rsPicker.firstElementChild)?.focus();
  });
}
rsPicker.addEventListener('click', (e) => {
  // Kept from the dialog's outside-click check: showing an edge's places takes the clicked cell out of
  // the page, and from there the click would look like one outside the box.
  e.stopPropagation();
  const cell = e.target.closest('.rs-pick-cell');
  if (cell && _pick) _takeCell(cell, false);
});
// A press anywhere else, the settings scrolling under it or the window resizing puts it away.
document.addEventListener('pointerdown', (e) => {
  if (_pick && !e.target.closest?.('#rsPicker') && !_pick.picker.btn.contains(e.target)) _closePicker();
}, true);
readerSettingsBox.addEventListener('scroll', () => _closePicker(), true);   // the tab shown is what scrolls
window.addEventListener('resize', () => _closePicker());

readerSettingsBtn.addEventListener('click', () => setReaderSettingsOpen(!readerSettingsModal.classList.contains('show')));
readerSettingsClose.addEventListener('click', () => setReaderSettingsOpen(false));
readerSettingsModal.addEventListener('click', (e) => {
  if (!e.target.closest('#readerSettingsBox')) setReaderSettingsOpen(false);
});
readerSettingsBox.addEventListener('click', (e) => {
  const modeBtn = e.target.closest('[data-reader-mode]');
  if (modeBtn) { setMode(modeBtn.dataset.readerMode); return; }
  const navDirectionBtn = e.target.closest('[data-nav-direction]');
  if (navDirectionBtn) { _applyReaderNavDirection(navDirectionBtn.dataset.navDirection); return; }
  const pageDirectionBtn = e.target.closest('[data-page-direction]');
  if (pageDirectionBtn) { _applyReaderPageDirection(pageDirectionBtn.dataset.pageDirection); return; }
  const translateBtn = e.target.closest('[data-translate-display]');
  if (translateBtn) { _applyTranslateDisplay(translateBtn.dataset.translateDisplay); return; }
  const originalBtn = e.target.closest('[data-study-original]');
  if (originalBtn) { _applyStudyPref('original', originalBtn.dataset.studyOriginal); return; }
  const studyDisplayBtn = e.target.closest('[data-study-display]');
  if (studyDisplayBtn) { _applyStudyPref('display', studyDisplayBtn.dataset.studyDisplay); return; }
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
readerAutoScrollInput.addEventListener('input', () => _applyReaderAutoScrollSpeed(readerAutoScrollInput.value));
readerDimInput.addEventListener('input', () => _applyReaderDim(readerDimInput.value));
readerSettingsBox.querySelectorAll('[data-reader-nav]').forEach(btn => {
  btn.addEventListener('click', () => applyReaderNavLayout(btn.dataset.readerNav));
});
readerCoverOffsetInput.addEventListener('change', () => _applyReaderCoverOffset(readerCoverOffsetInput.checked));
readerDebugLoadedInput.addEventListener('change', () => _applyReaderDebugLoaded(readerDebugLoadedInput.checked));
readerOverviewInput.addEventListener('change', () => _applySkipOverview(!readerOverviewInput.checked));
readerStripFlowInput.addEventListener('change', () => _applyStripFlow(readerStripFlowInput.checked));
readerTransitionsInput.addEventListener('change', () => _applyChapterTransitions(readerTransitionsInput.checked));
readerPauseOnUpInput.addEventListener('change', () => _applyReaderPauseOnUp(readerPauseOnUpInput.checked));
readerSmoothScrollInput.addEventListener('change', () => _applyReaderSmoothScroll(readerSmoothScrollInput.checked));
readerFuriganaInput.addEventListener('change', () => _applyStudyPref('furigana', readerFuriganaInput.checked));
readerStudyFontSelect.addEventListener('change', () => _applyStudyPref('srcFont', readerStudyFontSelect.value));
initDropdowns();
readerZoomOut.addEventListener('click', () => adjustPageZoom(-1));
readerZoomIn.addEventListener('click', () => adjustPageZoom(1));

readerPinBtn.addEventListener('click', () => applyReaderPin(!readerPinned));

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
const FIT_WIDTH_MIN = 0.1, FIT_WIDTH_MAX = 1;
function _applyReaderFitMaxWidth(next, persist = true) {
  readerFitMaxWidth = Math.round(Math.max(FIT_WIDTH_MIN, Math.min(FIT_WIDTH_MAX, next)) * 100) / 100;
  document.documentElement.style.setProperty('--reader-fit-max-width', `${Math.round(readerFitMaxWidth * 100)}%`);
  if (persist) platform.kv.set({ readerFitMaxWidth });
  _syncReaderSettingsUI();
}
function _applyReaderFitMode(next, persist = true, resetMaxWidth = false) {
  if (next !== 'width' && next !== 'height') next = 'off';
  readerFitMode = next;
  _keepStripLine(() => {
    document.body.classList.toggle('reader-fit-width', next === 'width');
    document.body.classList.toggle('reader-fit-height', next === 'height');
  }, true);
  if (next !== 'off' && resetMaxWidth) _applyReaderFitMaxWidth(FIT_WIDTH_MAX, persist);
  if (persist) platform.kv.set({ readerFitMode: next });
  _syncReaderSettingsUI();
}
function _clearReaderFitMode() {
  if (readerFitMode !== 'off') _applyReaderFitMode('off');
}

function _fitItemForImg(img) {
  return img?.parentElement?.classList.contains('page-wrap') ? img.parentElement : img;
}

function _currentFitWidthFraction() {
  const imgs = mode === 'strip'
    ? _fitPageImgs()
    : mode === 'single'
      ? (mainImg.naturalWidth ? [mainImg] : [])
      : [imgLeft, imgRight].filter(img => img.naturalWidth);
  const widths = imgs
    .map(img => _fitItemForImg(img)?.getBoundingClientRect().width || 0)
    .filter(w => w > 0);
  if (!widths.length) return readerFitMaxWidth;
  const basisEl = mode === 'double' ? doubleInner : mode === 'single' ? singleInner : document.documentElement;
  const basis = basisEl?.getBoundingClientRect().width || document.documentElement.clientWidth || window.innerWidth || 1;
  return Math.max(FIT_WIDTH_MIN, Math.min(FIT_WIDTH_MAX, Math.max(...widths) / Math.max(1, basis)));
}

// Zooming turns a fit off, in every mode, carrying on from the size the fit shows the pages at.
function _zoomReaderFitMode(dir) {
  if (readerFitMode === 'off') return false;
  const current = _fitAsZoom();
  _applyReaderFitMode('off');
  _applyPageZoom(current + dir * ZOOM_STEP);
  return true;
}

// The page zoom that shows the pages as wide as the fit does now. The strip's zoom is a share of the
// window's width; single page's scales a page of min(1280px, the window), double's half the row (at
// most 900px).
function _fitAsZoom() {
  if (mode === 'strip') return _currentFitWidthFraction();
  const img = mode === 'single' ? mainImg : (imgLeft.naturalWidth ? imgLeft : imgRight);
  const shown = _fitItemForImg(img)?.getBoundingClientRect().width || 0;
  const scrollbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-scrollbar-width')) || 0;
  const base = mode === 'single'
    ? Math.min(1280, window.innerWidth - scrollbar)
    : Math.min(doubleInner.getBoundingClientRect().width / 2, 900);
  return shown > 0 && base > 0 ? shown / base : 1;
}
// Apply a final zoom (clamped, but NOT rounded — fit-to-viewport needs full precision so it lands
// flush). Keep whatever sits at the top bar's bottom edge fixed while zooming, wherever you are in
// the pages. Anchor on the page element under that edge and the fraction of it that's below it, then
// after the relayout nudge the scroll so that exact point lands back there — gap/mode-agnostic.
// The strip keeps its reading line the same way, gaps and chapter cards included (_keepStripLine).
function _applyPageZoom(z) {
  const max = mode === 'strip' ? 1 : ZOOM_MAX;
  const next = Math.max(ZOOM_MIN, Math.min(max, z));
  if (next === _pageZoom) { _syncReaderSettingsUI(); return; }
  if (mode === 'strip' && stripView.classList.contains('active')) {
    _keepStripLine(() => {
      _pageZoom = next;
      document.documentElement.style.setProperty('--page-zoom', _pageZoom);
    }, true);
    platform.kv.set({ readerPageZoom: _pageZoom });
    _syncReaderSettingsUI();
    return;
  }
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
  if (mode === 'strip')  return _stripImgs.filter((_, i) => Math.abs(i + 1 - (currentPage - _viewBase)) <= _mountAhead);
  if (mode === 'single') return mainImg.naturalWidth ? [mainImg] : [];
  return [imgLeft, imgRight].filter(i => i.naturalWidth);
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
  _setStudyTextSelectable(e.ctrlKey);   // Ctrl held → study text is selectable
  _scrollFast = e.shiftKey;   // releasing Shift drops back to the half-speed default, live
  if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp')   _releaseScroll('up');
  if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') _releaseScroll('down');
});
window.addEventListener('blur', () => { _stopScroll(); _scrollFast = false; _setStudyTextSelectable(false); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { _stopScroll(); _scrollFast = false; _setStudyTextSelectable(false); }
});

let _feedbackPointer = null;
document.addEventListener('pointermove', e => { _feedbackPointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
document.addEventListener('pointerleave', () => { _feedbackPointer = null; });

function _openHoveredFeedback() {
  if (!studyMode || !_feedbackPointer) return;
  const hit = feedbackTarget(document.elementFromPoint(_feedbackPointer.x, _feedbackPointer.y));
  if (!hit) return;
  const pageNum = Number(hit.wrap.dataset.feedbackPage), page = pages[pageNum - 1];
  const study = page && studyFor(page.url);
  if (!study?.bubbles[hit.index]) return;
  _stopScroll(); _endClickWheelNav(); _setStudyTextSelectable(false);
  openFeedback({ pageUrl: page.url, page, study, index: hit.index, wrap: hit.wrap,
    context: { pageNumber: pageNum, pageWidth: study.page?.w || hit.wrap.querySelector('img')?.naturalWidth,
      readerMode: mode, view: 'study', study: studyPrefs(), surface: hit.surface, zoom: _pageZoom, fit: readerFitMode, direction: readerNavDirection } });
}

// The browser rings whatever has the focus once a key is pressed. A button the mouse pressed a moment
// ago (or one that took the focus for it, as the settings' close button does) isn't where the
// keyboard is: a key lets it go instead of ringing it, and hidden controls that focus held up hide
// again. Focus moved there by the keyboard (Tab) stays, ringed.
let _focusByKeys = false;
document.addEventListener('keydown', (e) => { if (e.key === 'Tab') _focusByKeys = true; }, true);
document.addEventListener('pointerdown', () => { _focusByKeys = false; }, true);
function _dropPointerFocus(e) {
  if (_focusByKeys || ['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
  const el = document.activeElement;
  if (el && el !== document.body) el.blur();
}

// The keys a focused control in the reader settings uses itself: a slider's arrows, Home, End and page
// keys; a dropdown's too, with Space and Enter; a tab's arrows, Home and End; Space and Enter on a
// button or a switch.
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
function _settingsControlKey(e) {
  const el = e.target;
  if (!readerSettingsBox.contains(el)) return false;
  if (el.matches('input[type="range"]')) return SLIDER_KEYS.has(e.key);
  if (el.matches('select')) return SLIDER_KEYS.has(e.key) || e.key === ' ' || e.key === 'Enter';
  if (el.matches('[role="tab"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return true;
  return (e.key === ' ' || e.key === 'Enter') && el.matches('button, input, [tabindex]');
}

// Keyboard
document.addEventListener('keydown', (e) => {
  if (propertiesOpen()) {
    if (e.key.toLowerCase() === 'i' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); closePageProperties(); }
    return;
  }
  if (feedbackOpen() || e.isComposing) return;
  _setStudyTextSelectable(e.ctrlKey);   // Ctrl held → study text is selectable
  // Open, the reader settings leave the reader's keys working, so a change can be tried at once,
  // except the keys their focused control uses itself; Escape puts a picker away, then closes them.
  if (readerSettingsModal.classList.contains('show')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (_pickerOpen()) _closePicker(true); else setReaderSettingsOpen(false);
      return;
    }
    if (_pickerOpen() || _settingsControlKey(e)) return;
  }
  const typing = editingTarget(e.target) && !readerSettingsBox.contains(e.target);   // the settings have no text to type
  if (!typing) _dropPointerFocus(e);
  if (_chapterListOpen() && e.key === 'Escape') {
    e.preventDefault();
    _closeChapterList();
    return;
  }
  if (keybindModal.classList.contains('show')) {
    if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); setKeybindOpen(false); }
    // Nothing in it takes focus, so scroll keys would otherwise move the pages behind it (Space on a
    // focused button still presses it).
    else if (e.key === ' ' ? !e.target.closest?.('button') : ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) e.preventDefault();
    return;
  }
  if (typing) return;
  if (e.key.toLowerCase() === 'f') {
    if (feedbackKey(e)) _openHoveredFeedback();
    return;   // Ctrl/Cmd+F remains the browser's Find command.
  }
  if (e.key.toLowerCase() === 'i' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    _openProperties(currentPage);
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
        tagFeedback(box, Number(box.dataset.feedbackIndex), true, 'original');
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

  // ↑/↓ are scroll (handled above); page-flip stays on ←/→, A/D and Space. ←/A and →/D turn
  // toward their side of the screen (the navigation direction); Space always reads on.
  const side = ['ArrowLeft', 'a', 'A'].includes(e.key) ? 'left' : ['ArrowRight', 'd', 'D'].includes(e.key) ? 'right' : null;
  const dir  = e.key === ' ' ? 1 : side ? _sideDir(side) : 0;
  const fwd  = dir > 0;
  const bck  = dir < 0;

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
      const rawN = _flipTarget(dir);
      // No transition page to park on (transitions off) → held nav stops at the chapter edge.
      if (held && (rawN > chLast || rawN < chFirst) && !(_chapterDividersOn && _series)) return;
      if (e.shiftKey) goTo(fwd ? chLast : chFirst);
      else goTo(rawN);
    }
    if (e.key === 'Home') goTo(chFirst);
    if (e.key === 'End')  goTo(chLast);
  }
  if (e.key === 'g' || e.key === 'G') setThumbsOpen(!thumbsOpen);
  if (e.key === 'n' || e.key === 'N') _toggleControls();
  if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey) _toggleControls();   // Ctrl/Cmd+X stays cut
  if ((e.key === 'k' || e.key === 'K') && !e.ctrlKey && !e.metaKey && !_chapterListOpen()) setAutoScroll(!_autoRaf);   // play / pause auto-play
  if (e.key === 't' || e.key === 'T') setView(translateView ? 'off' : 'translate');
  if (e.key === 'b' || e.key === 'B') setView(studyMode ? 'off' : 'study');
  if (e.key === '1') setMode('single');
  if (e.key === '2') setMode('double');
  if (e.key === '3') setMode('strip');
  if ((e.key === 'c' || e.key === 'C') && mode === 'double' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    _applyReaderCoverOffset(!readerCoverOffset);   // Ctrl/Cmd+C stays copy
  }
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
  // Strip rows follow the window width (and browser zoom): put the reading line back on its point.
  // Last, so the compensation above has already settled the rows' sizes.
  _scrollStripLineTo(_stripLine);
  _syncBarDensity();
  _scheduleScrubView();
});

init();

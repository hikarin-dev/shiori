import { zipCreate as _zipCreate } from './zip.js';
import { groupImports, importBytes, isImportable, droppedImports } from './import-files.js';
import { startImport } from './jobs-runner.js';
// library.js — the library UI: windowed grid over the database, live job progress, uploads,
// per-gallery actions. Imports boot.js first so services + the PWA worker are wired.

import './boot.js';
import * as api from './api.js';
import { LANG_NAME_TO_CODE, memberKind } from './gallery-model.js';
import { seriesManifest, exportFiles } from './gallery-files.js';
import { importBackup } from './backup.js';
import { mergeIntoSeries, removeChapter, chapterNumberLabel, chapterTally } from './series.js';
import { request as extRequest } from './ext-bridge.js';
import { siteMap, helperAvailable, siteName as _siteName, canDownload as _canDownload, galleryLink as _galleryLinkOf, updateSitesStatus, onSitesChanged } from './sites.js';
import * as store from './store.js';
import * as platform from './platform.js';
import { t, getLang } from './i18n.js';
import { pickTitle, pickSeriesTitle, migrateTitle } from './titles.js';
import { initTooltips, onModifiers } from './tooltip.js';
import { initDropdowns } from './dropdown.js';
import { formatBytes, formatCount, formatMegapixels } from './format.js';
import { TIERS, describePage } from './page-size.js';
import { escHtml, safeExternalUrl } from './sanitize.js';
import { openRerunMenu } from './rerun-menu.js';
import { confirmDialog, alertDialog, promptDialog, choiceDialog } from './notice.js';
import { openTagEditor, TAG_TYPE_LABEL, TAG_VALUES, LANG_TAG_NAME, langDisplayName, tagPatchFor } from './tag-editor.js';
import { initSearchField, searchQuery, setSearchQuery, appendSearchToken, SEARCH_TYPES } from './search-field.js';

// Whether a series card opens straight into the reader (chapter 1) instead of the overview page.
// Loaded from settings at boot; the card routing reads it synchronously.
let _bypassOverview = false;

// Library display (set in Settings): merge each series into one owner card (default) or show every
// gallery — each chapter included — as its own plain card. Display-only: it changes what the grid
// queries and how cards render, never the grouping metadata. kv is localStorage-backed, so this
// synchronous read gets the saved value before the first page load.
let _mergeSeries = localStorage.getItem('shiori:libMergeSeries') !== 'false';

// Whether the leading card flag matching the app's current language is hidden (default: on, the
// historical behaviour). Loaded from settings at boot; buildCardTags reads it while rendering.
let _hideAppLangFlag = true;

// Gallery card quick actions: download/replace, translate, export and delete.
const _QUICK_ACTION_MODES = new Set(['hover', 'always', 'hidden']);
const _DEFAULT_QUICK_ACTIONS_MODE = 'hover';
let _quickActionsMode = _DEFAULT_QUICK_ACTIONS_MODE;
const _normalizeQuickActionsMode = (mode) => _QUICK_ACTION_MODES.has(mode) ? mode : _DEFAULT_QUICK_ACTIONS_MODE;
function applyQuickActionsMode(mode) {
  const next = _normalizeQuickActionsMode(mode);
  _quickActionsMode = next;
  document.body.classList.toggle('quick-actions-hover', next === 'hover');
  document.body.classList.toggle('quick-actions-hidden', next === 'hidden');
}
try {
  const savedQuickActions = JSON.parse(localStorage.getItem('shiori:libQuickActionsMode') || 'null');
  applyQuickActionsMode(savedQuickActions);
} catch {
  applyQuickActionsMode(_quickActionsMode);
}

// Library details Settings can switch off (both shown by default): the top bar's storage stats and
// the cards' category tag. CSS hides them, so a change needs no re-render.
const _DETAIL_CLASS = { libShowNavStats: 'hide-nav-stats', libShowCategoryTag: 'hide-card-category' };
function applyDetailPrefs() {
  for (const [key, cls] of Object.entries(_DETAIL_CLASS)) {
    let shown = true;
    try { shown = JSON.parse(localStorage.getItem('shiori:' + key)) !== false; } catch {}
    document.body.classList.toggle(cls, !shown);
  }
}
applyDetailPrefs();

// ── Source sites ── shared state lives in sites.js (site map, availability, warm start).
const _sourceIconCache = new Map();
const _sourceIconPending = new Set();
const _sourceIconLoading = new Set();

async function hydrateSourceIcons() {
  try {
    for (const rec of await api.icons.all()) {
      if (rec?.source && /^data:image\//i.test(rec.dataUrl || '')) _sourceIconCache.set(String(rec.source), rec);
    }
  } catch {}
}

function _cachedSourceIcon(source) {
  const cached = _sourceIconCache.get(String(source || ''));
  return (cached && /^data:image\//i.test(cached.dataUrl || '')) ? cached.dataUrl : '';
}

function _replaceRenderedSourceIcons(source, dataUrl) {
  document.querySelectorAll('[data-fav]').forEach((el) => {
    if (el.dataset.fav !== source) return;
    if (el.tagName === 'IMG') {
      el.src = dataUrl;
      return;
    }
    el.outerHTML = `<img src="${escHtml(dataUrl)}" data-fav="${escHtml(source)}" alt="" decoding="async" style="width:12px;height:12px;pointer-events:none;">`;
  });
}

function _loadSourceIcon(source) {
  const key = String(source || '');
  if (!key || _sourceIconCache.has(key) || _sourceIconLoading.has(key)) return;
  _sourceIconLoading.add(key);
  api.icons.get(key)
    .then((rec) => {
      if (!rec || !/^data:image\//i.test(rec.dataUrl || '')) return;
      _sourceIconCache.set(key, rec);
      _replaceRenderedSourceIcons(key, rec.dataUrl);
    })
    .finally(() => { _sourceIconLoading.delete(key); });
}

// Ask for a source's icon. The app states the fact ("I have no icon for this source key", plus
// the opaque provenance token from whatever supplied the last one) and consumes whatever comes
// back — it never constructs an icon URL, picks a provider, or schedules retries. The in-flight
// set is plain RPC hygiene: don't ask the same question twice at once.
function _requestSourceIcon(source) {
  const key = String(source || '');
  if (!key || _sourceIconPending.has(key)) return;
  _sourceIconPending.add(key);
  const known = _sourceIconCache.get(key);
  extRequest({ type: 'EXT_FETCH_ICON', source: key, have: known?.url || null }, 15000)
    .then((r) => {
      if (!r || !r.ok || !/^data:image\//i.test(r.dataUrl || '')) return;
      const rec = { source: key, url: r.url || null, dataUrl: r.dataUrl, cachedAt: Date.now() };
      _sourceIconCache.set(key, rec);
      api.icons.put(key, rec).catch(() => {});
      _replaceRenderedSourceIcons(key, r.dataUrl);
    })
    .finally(() => { _sourceIconPending.delete(key); });
}

function _warmSourceIconCache() {
  for (const source of Object.keys(siteMap() || {})) _requestSourceIcon(source);
}

const _siteFavicon = (source) => {
  const cached = _cachedSourceIcon(source);
  if (!cached) { _loadSourceIcon(source); _requestSourceIcon(source); }
  return cached;
};
const _sourceIconsReady = hydrateSourceIcons();

const galleryLink = _galleryLinkOf;

// Parse user input (URL or hostname) into { source, sourceId, sourceUrl }. The helper parses
// it properly when present; otherwise fall back to generic URL parsing (host + verbatim URL).
async function parseSourceInput(input) {
  if (helperAvailable()) {
    const r = await extRequest({ type: 'EXT_PARSE_URL', input });
    if (r && r.ok) return { source: r.source || '', sourceId: r.sourceId || null, sourceUrl: r.sourceUrl || '' };
  }
  const s = String(input || '').trim();
  try {
    const u = new URL(s.includes('://') ? s : 'https://' + s);
    return { source: u.hostname.replace(/^www\./, ''), sourceId: null, sourceUrl: u.href };
  } catch {
    return { source: s.toLowerCase().replace(/^www\./, '').split('/')[0], sourceId: null, sourceUrl: '' };
  }
}

const _looksLikeUrl = (s) => /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(s);

// A translated gallery's translate button also offers "Re-run from…" on right-click.
const _translatedTip = () => `${t('card.tip_translate_new')} · ${t('card.tip_rerun')}`;

// The series view the overview remembers: 'chapters' or 'volumes'.
let _seriesView = 'chapters';
platform.kv.get(['seriesView']).then(({ seriesView }) => { if (seriesView === 'volumes') _seriesView = 'volumes'; });

function sendMsg(msg) {
  return platform.rpc(msg);
}

// ── Helper availability ── owned by sites.js; this page reacts to real changes.
document.body.classList.toggle('helper-offline', !helperAvailable());
onSitesChanged(({ available }) => {
  if (available) _warmSourceIconCache();
  applyFilters();   // re-render so download buttons appear/disappear
});
async function updateExtStatus() {
  const changed = await updateSitesStatus();
  if (!changed && helperAvailable()) _warmSourceIconCache();
}

let _pageItems = [];   // current page's gallery entities (windowed — only what is on screen)
let _total     = 0;    // total galleries matching the current search (for pagination)

// Debounced page reload (for membership/sort changes) and header-stats refresh, so a burst
// of feed events (e.g. caching every page of a download) collapses into one DB query.
let _reloadTimer = null;
const _scheduleReloadPage = () => { clearTimeout(_reloadTimer); _reloadTimer = setTimeout(applyFilters, 250); };
let _headerStatsTimer = null;
const _scheduleHeaderStats = () => { clearTimeout(_headerStatsTimer); _headerStatsTimer = setTimeout(updateHeaderStats, 800); };

function _bumpLoadCount() {
  const n = (parseInt(sessionStorage.getItem('_shiori_load') || '0') + 1);
  sessionStorage.setItem('_shiori_load', n);
  const el = document.getElementById('hLoadCount');
  if (el) el.textContent = n;
}
document.addEventListener('DOMContentLoaded', _bumpLoadCount);

function _getCoverThumbWidth() {
  const TIERS = [256, 384, 512, 768, 1024];
  const raw = Math.ceil((window.innerWidth / 5) * (window.devicePixelRatio || 1));
  return TIERS.find(t => t >= raw) ?? TIERS[TIERS.length - 1];
}
let _thumbWidth = _getCoverThumbWidth();
const _coverCache = new Map(); // galleryId + requested role → resized cover data URL

function coverCacheKey(galleryId, preferSeries) {
  return `${String(galleryId)}:${preferSeries ? 'series' : 'gallery'}`;
}
function coverCacheGalleryId(key) {
  return String(key).replace(/:(?:series|gallery)$/, '');
}
function coverRequestMatchesEntry(msg, entry, mergeSeries) {
  return !!msg.preferSeries === !!(mergeSeries && entry?.isSeries);
}

// Growing the window past the tier the covers were rendered at would leave them blurry —
// bump the tier and re-request. (Shrinking keeps the sharper covers; nothing to do.)
let _thumbResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_thumbResizeTimer);
  _thumbResizeTimer = setTimeout(() => {
    const w = _getCoverThumbWidth();
    if (w <= _thumbWidth) return;
    _thumbWidth = w;
    _coverCache.clear();
    try { sessionStorage.removeItem('shiori-covers'); } catch {}
    fetchPageCovers(_pageItems);
  }, 400);
});

// Restore covers from sessionStorage and warm the Blink image cache so
// renderGrid gets cache hits (0ms) instead of re-decoding each data: URL.
try {
  const raw = sessionStorage.getItem('shiori-covers');
  if (raw) {
    for (const [storedKey, dataUrl] of Object.entries(JSON.parse(raw))) {
      // Pre-role cache entries were gallery fallbacks. Keep them visible while the matching
      // role is refreshed, but never let them satisfy a series-cover request.
      const key = /:(?:series|gallery)$/.test(storedKey)
        ? storedKey
        : coverCacheKey(storedKey, false);
      _coverCache.set(key, dataUrl);
      const _img = new Image(); _img.src = dataUrl; // prime decode cache
    }
  }
} catch {}

let _coverCacheSaveTimer = null;
function _scheduleCoverCacheSave() {
  clearTimeout(_coverCacheSaveTimer);
  _coverCacheSaveTimer = setTimeout(() => {
    try {
      const pageIds = new Set(_pageItems.map(g => g.id));
      const toSave = Object.fromEntries([..._coverCache]
        .filter(([key]) => pageIds.has(coverCacheGalleryId(key))));
      sessionStorage.setItem('shiori-covers', JSON.stringify(toSave));
    } catch {}
  }, 800);
}

let currentPage  = 1;
const PAGE_SIZE  = 30;
const _pendingSourceChanges = new Map(); // galleryId → {source, sourceId} while SET_SOURCE is in-flight

// Per tag type, value → 'include' | 'exclude'; a value that's absent doesn't filter. Kept across
// visits (kv-backed → localStorage, read synchronously so the first paint is already filtered).
const _filter = { rating: new Map(), category: new Map() };
function _loadFilter(saved) {
  for (const [type, states] of Object.entries(_filter)) {
    states.clear();
    for (const [v, s] of Object.entries(saved?.[type] || {})) {
      if (TAG_VALUES[type].includes(v) && (s === 'include' || s === 'exclude')) states.set(v, s);
    }
  }
}
try { _loadFilter(JSON.parse(localStorage.getItem('shiori:libFilter') || 'null')); } catch {}
function _saveFilter() {
  platform.kv.set({ libFilter: Object.fromEntries(Object.entries(_filter).map(([type, m]) => [type, Object.fromEntries(m)])) });
}

function syncUrl() {
  const params = new URLSearchParams();
  if (currentPage > 1) params.set('page', currentPage);
  const q = searchQuery();
  if (q) params.set('q', q);
  const sort = document.getElementById('sortSelect').value;
  if (sort && sort !== 'id') params.set('sort', sort);
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
}

function initFromUrl() {
  const params = new URLSearchParams(location.search);
  const page = parseInt(params.get('page'));
  if (page > 1) currentPage = page;
  const q = params.get('q');
  if (q) { setSearchQuery(q); updateClearBtn(); }
  const sort = params.get('sort');
  if (sort) document.getElementById('sortSelect').value = sort;
}

// ── Card rendering ──

// Language code → country flag (SVG file saved under app/flags/), for the leading card flag
// chip. Covers every translator target language and common source languages.
const _LANG_FLAG = {
  en: 'GB', ja: 'JP', zh: 'CN', 'zh-CN': 'CN', 'zh-TW': 'TW', ko: 'KR', de: 'DE', fr: 'FR',
  es: 'ES', ru: 'RU', pt: 'PT', 'pt-BR': 'BR', it: 'IT', vi: 'VN', id: 'ID', th: 'TH',
  nl: 'NL', pl: 'PL', uk: 'UA',
};
// The app language as a base code (zh-CN → zh) — the flag for a gallery in this language is hidden.
const _langBase = (code) => String(code || '').split('-')[0];

function buildCardTags(tags, languages) {
  const list = Array.isArray(tags) ? tags : [];
  const category = list.filter(t => t.type === 'category');
  const artists = list.filter(t => t.type === 'artist');
  const regular = list.filter(t => t.type === 'tag');
  const female  = list.filter(t => t.type === 'tag:female');
  const male    = list.filter(t => t.type === 'tag:male');
  const chips = [];
  // Language flags — leading chips, one per gallery language; a flag matching the app's current
  // language is omitted. Clickable like a tag (adds a language filter); tooltip shows the
  // language name in the app's language.
  const appBase = _langBase(getLang());
  for (const code of (Array.isArray(languages) ? languages : [])) {
    if (!_LANG_FLAG[code] || (_hideAppLangFlag && _langBase(code) === appBase)) continue;
    chips.push(`<span class="card-tag-flag" data-lang-code="${escHtml(code)}" data-lang-name="${escHtml(LANG_TAG_NAME[code] || code)}" data-tip="${escHtml(langDisplayName(code))}"><img class="flag-img" src="flags/${_LANG_FLAG[code]}.svg" alt="${escHtml(code)}" loading="lazy"></span>`);
  }
  chips.push(
    ...category.map(t => `<span class="card-tag category" data-type="category" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...artists.map(t => `<span class="card-tag artist" data-type="artist" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...regular.map(t => `<span class="card-tag" data-type="tag" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...female.map(t => `<span class="card-tag" data-type="tag:female" data-original="${escHtml(t.name)}">${escHtml(t.name)} ♀</span>`),
    ...male.map(t => `<span class="card-tag" data-type="tag:male" data-original="${escHtml(t.name)}">${escHtml(t.name)} ♂</span>`),
  );
  // Trailing '+' chip — opens the add-metadata modal (shown only while the card is hovered).
  chips.push(`<span class="card-tag card-tag-add" data-tip="${t('card.tip_addtag')}">+</span>`);
  return `<div class="card-tags">${chips.join('')}</div>`;
}

function updateCardThumbFit(img) {
  if (!img?.naturalWidth || !img?.naturalHeight) return;
  img.classList.toggle('landscape', img.naturalWidth >= img.naturalHeight);
  paintCardGlow(img);
}

// A landscape cover sits letterboxed in the portrait thumb; its bars are filled with an ambient glow
// built the way ambient-light video players build theirs: copies of the cover stacked behind it,
// each a step taller than the last so its edge colours reach outward, then blurred. Tuned to the
// maximum spread (400%, in 12% edge steps) and a 100% blur (a radius of 25% of the cover's height).
// The copies grow only vertically — the bars are above and below — so each colour runs straight
// out of the edge it touches instead of fanning into radial rays.
const _GLOW_SPREAD = 4, _GLOW_EDGE = 0.12, _GLOW_BLUR = 0.25;
// The glow canvas overhangs the thumb by half its size on every side (CSS, same fraction), so the
// blur's soft rim falls outside the card instead of darkening its edges.
const _GLOW_BLEED = 0.5;
function paintCardGlow(img) {
  const wrap = img.closest('.card-thumb-wrap');
  let glow = wrap?.querySelector('.card-thumb-glow');
  if (!wrap || !img.classList.contains('landscape')) { glow?.remove(); return; }
  if (!glow) {
    glow = document.createElement('canvas');
    glow.className = 'card-thumb-glow';
    glow.setAttribute('aria-hidden', 'true');
    img.before(glow);
  }
  const aspect = img.naturalWidth / img.naturalHeight;
  // Small is enough: the result is blurred and scaled up by CSS. One downscaled copy of the cover
  // is drawn repeatedly, rather than the full image.
  const src = document.createElement('canvas');
  src.width = 48; src.height = Math.max(1, Math.round(48 / aspect));
  src.getContext('2d').drawImage(img, 0, 0, src.width, src.height);

  const W = 96, H = W * Math.SQRT2;                       // the thumb box (1:√2) in canvas px
  const padX = W * _GLOW_BLEED, padY = H * _GLOW_BLEED;
  glow.width = Math.round(W + 2 * padX);
  glow.height = Math.round(H + 2 * padY);
  const ctx = glow.getContext('2d');
  const coverW = W, coverH = W / aspect;                  // object-fit: contain, width-bound
  const cx = glow.width / 2, cy = glow.height / 2;
  // Tallest first, each shorter copy covering the middle of the one behind it; the step is scaled
  // by the aspect ratio, as the spread would be for a glow around all four sides. Each copy's outer
  // columns are stretched sideways across the overhang so the blur finds colour, not empty canvas,
  // at the card's sides.
  const x0 = cx - coverW / 2, x1 = cx + coverW / 2;
  for (let level = Math.round(_GLOW_SPREAD / _GLOW_EDGE); level >= 0; level--) {
    const h = coverH * (1 + _GLOW_EDGE * aspect * level), y0 = cy - h / 2;
    ctx.drawImage(src, 0, 0, 1, src.height, 0, y0, x0, h);
    ctx.drawImage(src, src.width - 1, 0, 1, src.height, x1, y0, glow.width - x1, h);
    ctx.drawImage(src, x0, y0, coverW, h);
  }
  // The radius in the thumb's width units (cqw), so it holds at any card size.
  glow.style.filter = `blur(${(_GLOW_BLUR * 100 / aspect).toFixed(2)}cqw)`;
}

function wireCardThumbFit(img) {
  if (!img) return;
  img.addEventListener('load', () => updateCardThumbFit(img));
  if (img.complete) updateCardThumbFit(img);
}

// How a dialog names what it acts on: the title, then "#id · N pages" / "N chapters".
function _galleryDetail(g) {
  const id = g.sourceId || g.id;
  return [pickTitle(g, getLang()) || `#${id}`, t('dlg.detail_pages', { id, n: formatCount(g.count || 0) })];
}
function _seriesDetail(g) {
  return [pickSeriesTitle(g.seriesTitle, g, getLang()) || `#${g.id}`, t('dlg.detail_chapters', { n: formatCount(g.chapterCount || g.chapters?.length || 0) })];
}
// The cover a card shows, for a dialog about it — none while Safe Mode blurs it.
function _cardCover(card) {
  if (!card || (document.body.classList.contains('safe-mode') && !card.classList.contains('card-sfw'))) return '';
  return card.querySelector('img.card-thumb')?.src || '';
}

function buildCard(g) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.galleryId = g.id;
  // Safe Mode blurs a cover unless the gallery is rated safe or suggestive — an unrated one blurs.
  if ((g.tags || []).some(tg => tg.type === 'rating' && (tg.name === 'safe' || tg.name === 'suggestive'))) card.classList.add('card-sfw');

  // A series owner renders (and acts) as a merged series card only while merging is on; unmerged,
  // it is shown as its own plain chapter-1 gallery. The real g.isSeries is kept for the delete path.
  const showAsSeries = _mergeSeries && g.isSeries;

  const thumbSrc = _coverCache.get(coverCacheKey(g.id, showAsSeries)) || null;
  const hasThumb = showAsSeries ? ((g.aggPages || g.count || 0) > 0 || !!thumbSrc) : (g.count > 0 || !!thumbSrc);
  // draggable="false" on the cover + link so grabbing the thumbnail starts the CARD's merge-drag
  // (below), not a native image/link drag — the native image drag exposes a 'Files' type that was
  // wrongly triggering the file-import overlay.
  const thumbInner = hasThumb
    ? `<img class="card-thumb" draggable="false"${thumbSrc ? ` src="${thumbSrc}"` : ''} alt="">`
    : `<div class="card-thumb-placeholder">📁</div>`;

  const displayTitle = showAsSeries ? pickSeriesTitle(g.seriesTitle, g, getLang()) : pickTitle(g, getLang());
  const titleHtml = displayTitle
    ? `<div class="card-title" data-original="${escHtml(displayTitle)}">${escHtml(displayTitle)}</div>`
    : '';

  const cachedCount = g.count;
  const totalCount = g.numPages ? ` / ${formatCount(g.numPages)}` : '';
  // A series card shows the whole-series aggregate (stored on the owner) and a chapter badge; a
  // standalone gallery shows its own page count. Series open the overview unless the user bypasses.
  // The size is what the gallery's export holds; hovering it splits off the original pages.
  const size = showAsSeries ? _sizeHtml(g.aggSize, g.aggOrig) : _sizeHtml(g.size, g.origSize);
  const metaLine = showAsSeries
    ? `${_pagesHtml(`${formatCount(g.aggPages)} ${t('card.pages')}`, g.aggMedianPage, g.aggOrig, g.aggPages)} · ${size}`
    : `${_pagesHtml(`${formatCount(cachedCount)}${totalCount} ${t('card.pages')}`, g.medianPage, g.origSize, cachedCount)} · ${size}`;
  // A library kept as files says when a gallery's files can't be found in its folder.
  const missingHtml = g.missing ? ` · <span class="card-missing">${escHtml(t('card.files_missing'))}</span>` : '';
  // A series card counts what the overview lists — its chapters or its volumes (the view chosen
  // there), or the other kind when it has none of that one.
  const tally = showAsSeries && g.chapters ? chapterTally(g.chapters) : { chapters: g.chapterCount, extras: 0 };
  const volumes = showAsSeries && g.chapters ? g.chapters.filter(c => memberKind(c) === 'volume').length : 0;
  const countVolumes = volumes > 0 && (_seriesView === 'volumes' || !tally.chapters);
  const seriesBadge = showAsSeries ? `<span class="card-series-badge">${countVolumes
    ? t('card.volumes_n', { n: formatCount(volumes) }) : t('card.chapters_n', { n: formatCount(tally.chapters) })}</span>` : '';
  // Record-derived id, escaped once for every attribute interpolation below (ids are validated
  // numeric at import boundaries; this is defense in depth for legacy records).
  const idA = escHtml(g.id);
  // Every gallery gets an overview landing page (a standalone one can gain chapters there); the
  // "skip overview" setting sends cards straight into the reader instead.
  const cardHref = _bypassOverview ? `../reader?g=${encodeURIComponent(g.id)}` : `../overview?g=${encodeURIComponent(g.id)}`;

  const tagHtml = buildCardTags(g.tags, g.languages);

  const canDownload  = _canDownload(g);
  const visitUrl     = galleryLink(g, 1);
  const siteName     = _siteName(g.source);
  const openTitle    = visitUrl ? `${siteName}: ${visitUrl}` : t('card.tip_setsource');
  const dlTitle      = g.numPages ? t('card.tip_dl', { n: formatCount(g.numPages) }) : t('card.tip_dl_meta');
  const idText       = escHtml(g.sourceId || g.id);
  const idClass      = `card-id${g.isLocalImport ? ' local' : ''}`;
  const sourceHref   = safeExternalUrl(g.sourceUrl);
  const idHtml       = sourceHref
    ? `<a class="${idClass}" href="${escHtml(sourceHref)}" target="_blank" rel="noopener noreferrer" data-original="${idText}">${idText}</a>`
    : `<div class="${idClass}" data-original="${idText}">${idText}</div>`;

  // Alt+click searches the library for the gallery's source — only when it has one.
  const sourceSearchTip = g.source ? ` data-tip-alt="${escHtml(t('card.tip_search_source', { site: siteName }))}"` : '';
  const openBtnHtml = `
      <button class="card-btn card-btn-open" data-id="${idA}" data-tip="${escHtml(openTitle)}"${visitUrl ? ` data-tip-shift="${t('card.tip_editsource')}"` : ''}${sourceSearchTip}><span class="open-inner">${_makeOpenBtnInner(g.source)}</span></button>`;
  // The favorite heart on the cover: always shown once favorited, otherwise while hovered.
  const favHtml = `<button class="card-fav${g.favorite ? ' on' : ''}" type="button" aria-pressed="${g.favorite ? 'true' : 'false'}" data-tip="${t(g.favorite ? 'card.tip_fav_remove' : 'card.tip_fav_add')}" data-tip-alt="${t(g.favorite ? 'card.tip_search_fav' : 'card.tip_search_unfav')}">${_HEART_SVG}</button>`;

  const actionsHtml = `
    <div class="card-actions">
      <button class="card-btn card-btn-dl" data-id="${idA}" data-tip="${canDownload ? dlTitle : t('card.tip_replace')}" ${canDownload ? `data-tip-shift="${t('card.tip_replace')}"` : ''}>${canDownload ? _DL_ICON : _UPLOAD_ICON}</button>
      <button class="card-btn card-btn-translate${g.translated ? ' done' : ''}" data-id="${idA}" data-tip="${g.translated ? _translatedTip() : t('card.tip_translate')}"${g.translated ? ` data-tip-shift="${t('card.tip_revert')}"` : ''} data-tip-alt="${t(g.translated ? 'card.tip_search_translated' : 'card.tip_search_untranslated')}">${_TRANSLATE_ICON}</button>
      <button class="card-btn card-btn-export" data-id="${idA}" data-tip="${t('card.tip_export')}" data-tip-shift="${t('card.tip_export_meta')}">${_EXPORT_ICON}</button>
      <button class="card-btn card-btn-del" data-id="${idA}" data-tip="${t('card.tip_delete')}" data-tip-shift="${t('card.tip_quickdelete')}">${_DELETE_ICON}</button>
    </div>`;

  card.innerHTML = `
    <div class="card-thumb-spacer"></div>
    <div class="card-body-spacer"></div>
    <div class="card-hover-overlay">
      <a class="card-thumb-wrap" href="${cardHref}" draggable="false">
        ${thumbInner}
        ${seriesBadge}
      </a>
      ${favHtml}
      <div class="card-body">
        <div class="card-id-row">
          ${openBtnHtml}
          ${idHtml}
          ${actionsHtml}
        </div>
        ${titleHtml}
        <div class="card-meta">${metaLine}${missingHtml}</div>
        <div class="card-progress" id="prog-${idA}">
          <div class="prog-track"><div class="prog-fill" id="progfill-${idA}"></div></div>
          <span class="card-prog-label" id="proglabel-${idA}"></span>
        </div>
        ${tagHtml}
      </div>
    </div>
  `;

  wireCardThumbFit(card.querySelector('img.card-thumb'));

  card.querySelector('.card-fav').addEventListener('click', (e) => {
    // Alt+click → search for galleries in the same state: favorited or not.
    if (e.altKey) { _addSearchToken(`favorite:"${g.favorite ? 'yes' : 'no'}"`); return; }
    store.mutate(g.id, { favorite: !g.favorite }, { touch: false });
  });

  card.querySelectorAll('.card-btn-del').forEach(b => {
    b.addEventListener('mouseenter', () => {
      _hoveredDelBtn = b;
      if (_shiftHeld) _delFlip.to(b, _DELETE_SHIFT_SVG);
    });
    b.addEventListener('mouseleave', () => {
      _hoveredDelBtn = null;
      if (_shiftHeld) _delFlip.to(b, _DELETE_SVG);
    });
    b.addEventListener('click', async (e) => {
      // A merged series card removes every chapter (its children never get their own card).
      if (showAsSeries) {
        const n = formatCount(g.chapterCount);
        if (!e.shiftKey && !(await confirmDialog({
          title: t('dlg.del_series_title'), body: t('dlg.del_series_body', { n }),
          detail: _seriesDetail(g), cover: _cardCover(card), ok: t('dlg.del_series_ok', { n }), danger: true,
        }))) return;
        await sendMsg({ type: 'DELETE_SERIES', galleryId: g.id });
        applyFilters();
        updateHeaderStats();
        return;
      }
      if (!e.shiftKey && !(await confirmDialog({
        title: t('dlg.del_gallery_title'), body: t('dlg.del_gallery_body'),
        detail: _galleryDetail(g), cover: _cardCover(card), ok: t('dlg.delete'), danger: true,
      }))) return;
      // In the unmerged view a card may still belong to a series (an owner shown plainly, or a
      // chapter). Go through the series-aware path so removing it re-owns/detaches instead of
      // orphaning its siblings; a true standalone falls through to a plain delete.
      if (g.isSeries || g.parentId) {
        await removeChapter(String(g.parentId || g.id), g.id, { deleteImages: true });
      } else {
        await sendMsg({ type: 'DELETE_GALLERY', galleryId: g.id });
      }
      applyFilters();
      updateHeaderStats();
    });
  });

  card.querySelectorAll('.card-btn-export').forEach(b => {
    b.addEventListener('mouseenter', () => {
      _hoveredExportBtn = b;
      if (_shiftHeld && !b.disabled) _exportFlip.to(b, _EXPORT_SHIFT_SVG);
    });
    b.addEventListener('mouseleave', () => {
      _hoveredExportBtn = null;
      if (!b.disabled && _shiftHeld) _exportFlip.to(b, _EXPORT_SVG);
    });
    b.addEventListener('click', async (e) => {
      const btns = card.querySelectorAll('.card-btn-export');
      if ([...btns].some(x => x.disabled)) return;
      btns.forEach(x => { x.disabled = true; const _i = x.querySelector('.export-inner'); if (_i) _i.textContent = '…'; });
      try {
        if (e.shiftKey) await exportMetadataBundleZip(g.id);
        else            await exportGallery(g.id);
      } catch (err) {
        alertDialog({ title: t('dlg.export_fail_title'), body: t('dlg.export_fail_body'), detail: err.message, tone: 'error' });
      } finally {
        card.querySelectorAll('.card-btn-export').forEach(x => { x.disabled = false; _exportFlip.snap(x, _EXPORT_SVG); });
      }
    });
  });

  card.querySelectorAll('.card-btn-dl').forEach(b => {
    b.addEventListener('mouseenter', () => {
      if (_canDownload(g)) {
        _hoveredDlBtn = b;
        if (_shiftHeld && !b.disabled) _dlFlip.to(b, _UPLOAD_ICON);
      }
    });
    b.addEventListener('mouseleave', () => {
      _hoveredDlBtn = null;
      if (_canDownload(g) && _shiftHeld) _dlFlip.to(b, _DL_SVG);
    });
    b.addEventListener('click', async (e) => {
      const curCanDl = _canDownload(g);
      if (e.shiftKey || !curCanDl) {
        _hoveredDlBtn = null;
        _operatingOnCard = card;
        if (curCanDl) card.querySelectorAll('.card-btn-dl').forEach(x => _dlFlip.snap(x, _DL_SVG));
        const inp = document.getElementById('replaceImgInput');
        inp.dataset.gid = g.id;
        inp.click();
        return;
      }

      // A merged series forwards ONE intent for the whole series; expanding it into per-chapter
      // work (which chapters are incomplete, what to overwrite, in what order) belongs to
      // whatever performs the acquisition, not here. The confirm stays app-side because it is
      // UI: nothing already-complete in the local library means the press can only mean
      // "fetch it all again".
      if (showAsSeries) {
        const entities = await api.galleries.byIds((g.chapters || []).map(c => c.id));
        const known = entities.filter(Boolean);
        if (!known.length || !known.some(x => _canDownload(x))) return;
        const nothingMissing = known.every(x => x.numPages > 0 && x.count >= x.numPages);
        if (nothingMissing && !(await confirmDialog({
          title: t('dlg.redl_series_title'), body: t('dlg.redl_series_body'),
          detail: _seriesDetail(g), cover: _cardCover(card), ok: t('dlg.redl_ok'),
        }))) return;
        await sendMsg({ type: 'CACHE_ALL_PAGES', galleryId: g.id, source: g.source, series: true, overwrite: nothingMissing });
        return;
      }

      const btns = card.querySelectorAll('.card-btn-dl');
      if ([...btns].some(x => x.disabled)) return;

      const alreadyComplete = g.numPages > 0 && g.count >= g.numPages;
      if (alreadyComplete && !(await confirmDialog({
        title: t('dlg.redl_title'), body: t('dlg.redl_body', { n: formatCount(g.numPages) }),
        detail: _galleryDetail(g), cover: _cardCover(card), ok: t('dlg.redl_ok'),
      }))) return;

      btns.forEach(x => { x.disabled = true; x.innerHTML = '…'; });

      const progEl  = document.getElementById(`prog-${g.id}`);
      const labelEl = document.getElementById(`proglabel-${g.id}`);

      if (progEl) progEl.closest('.card-body').classList.add('downloading');
      if (labelEl) labelEl.textContent = t('prog.fetching_meta');

      await sendMsg({ type: 'CACHE_ALL_PAGES', galleryId: g.id, source: g.source, overwrite: alreadyComplete });
    });
  });

  card.querySelectorAll('.card-btn-translate').forEach(b => {
    b.addEventListener('mouseenter', () => {
      _hoveredTrBtn = b;
      if (!b.classList.contains('cancelling') && _shiftHeld && b.dataset.tipShift && !b.disabled) _trFlip.to(b, _REVERT_SVG);
    });
    b.addEventListener('mouseleave', () => {
      _hoveredTrBtn = null;
      if (!b.classList.contains('cancelling') && _shiftHeld && b.dataset.tipShift) _trFlip.to(b, _TRANSLATE_SVG);
    });
    b.addEventListener('click', async (e) => {
      // Mid-translation the button is a Stop control → cancel this job and bail.
      if (b.classList.contains('cancelling')) { await sendMsg({ type: 'CANCEL_TRANSLATE', galleryId: g.id }); return; }

      // Alt+click → search for galleries in the same state: translated (even partly) or not.
      if (e.altKey) { _addSearchToken(`translated:"${g.translated ? 'yes' : 'no'}"`); return; }

      // A merged series translates one chapter per press → open the chapter picker (defaults to the
      // lowest untranslated chapter). Each chapter is its own gallery-scoped translate job.
      if (showAsSeries) { openSeriesTranslateModal(g); return; }

      const btns = card.querySelectorAll('.card-btn-translate');
      if ([...btns].some(x => x.disabled)) return;

      // Shift+click on an already-translated gallery → revert to the originals.
      if (e.shiftKey && g.translated) {
        if (!(await confirmDialog({
          title: t('dlg.revert_title'), body: t('dlg.revert_body'),
          detail: _galleryDetail(g), cover: _cardCover(card), ok: t('dlg.revert_ok'), danger: true,
        }))) return;
        btns.forEach(x => x.disabled = true);
        await sendMsg({ type: 'REVERT_GALLERY', galleryId: g.id });
        g.translated = false;
        const liveEntry = _pageItems.find(x => x.id === g.id);
        if (liveEntry) liveEntry.translated = false;
        const $card = document.querySelector(`.card[data-gallery-id="${g.id}"]`);
        if ($card) $card.replaceWith(buildCard(liveEntry || g));
        return;
      }

      if (g.count === 0) {
        alertDialog({ title: t('dlg.no_pages_title'), body: t('dlg.no_pages_body'), detail: _galleryDetail(g)[0], cover: _cardCover(card) });
        return;
      }

      if (!g.translated && !(await confirmDialog({
        title: t('dlg.tr_title'), body: t('dlg.tr_body', { n: formatCount(g.count) }),
        detail: _galleryDetail(g), cover: _cardCover(card), ok: t('dlg.tr_ok'),
      }))) return;

      btns.forEach(x => x.disabled = true);
      const progEl  = document.getElementById(`prog-${g.id}`);
      const labelEl = document.getElementById(`proglabel-${g.id}`);
      if (progEl) progEl.closest('.card-body').classList.add('downloading');
      if (labelEl) labelEl.textContent = t('prog.translating');

      await sendMsg({ type: 'TRANSLATE_GALLERY', galleryId: g.id });
    });
    // Right-click on a translated gallery → "Re-run from…": redo every page from one stage,
    // reusing everything before it.
    b.addEventListener('contextmenu', (e) => {
      if (!g.translated || showAsSeries || b.disabled || b.classList.contains('cancelling')) return;
      e.preventDefault();
      openRerunMenu(b, g.id, async (point, label) => {
        if (!(await confirmDialog({
          title: t('dlg.rerun_title', { stage: label }), body: t('dlg.rerun_body'),
          detail: _galleryDetail(g), cover: _cardCover(card), ok: t('dlg.rerun_ok'),
        }))) return;
        card.querySelectorAll('.card-btn-translate').forEach(x => x.disabled = true);
        const progEl  = document.getElementById(`prog-${g.id}`);
        const labelEl = document.getElementById(`proglabel-${g.id}`);
        if (progEl) progEl.closest('.card-body').classList.add('downloading');
        if (labelEl) labelEl.textContent = t('prog.translating');
        await sendMsg({ type: 'TRANSLATE_GALLERY', galleryId: g.id, forceFrom: point });
      });
    });
  });

  card.querySelectorAll('.card-btn-open').forEach(b => {
    // Remember the button's resting icon (the site favicon) once, up front. Flipping always
    // targets this stored base or the shift icon — never the live DOM — so spamming Shift can
    // never capture a half-flipped frame and lose the favicon.
    const _innerEl = b.querySelector('.open-inner');
    b._baseInner = _innerEl ? _innerEl.innerHTML : '';
    if (b.dataset.tipShift) {
      b.addEventListener('mouseenter', () => {
        _hoveredOpenBtn = b;
        if (_shiftHeld) _openFlip.to(b, _OPEN_SHIFT_ICON);
      });
      b.addEventListener('mouseleave', () => {
        if (_shiftHeld) _openFlip.to(b, b._baseInner);
        _hoveredOpenBtn = null;
      });
    }
    b.addEventListener('click', async (e) => {
    // Alt+click → search for galleries from the same source.
    if (e.altKey && g.source) { _addSearchToken(`source:"${g.source}"`); return; }
    const curVisitUrl = galleryLink(g, 1);
    if (!curVisitUrl || e.shiftKey) {
      let prefill = curVisitUrl || '';
      if (!prefill) {
        try {
          const clip = (await navigator.clipboard.readText()).trim();
          if (_looksLikeUrl(clip)) prefill = clip;
        } catch {}
      }
      // Skip the prompt if clipboard gave us a usable URL and we're not editing.
      const autoApply = !e.shiftKey && !curVisitUrl && prefill && _looksLikeUrl(prefill);
      const input = autoApply ? prefill : await promptDialog({
        title: t(curVisitUrl ? 'dlg.src_edit_title' : 'dlg.src_title'), body: t('dlg.src_body'),
        detail: showAsSeries ? _seriesDetail(g)[0] : _galleryDetail(g)[0], cover: _cardCover(card),
        value: prefill, placeholder: t('dlg.src_ph'), ok: t('common.save'),
      });
      if (input === null) return;

      const parsed = await parseSourceInput(input);

      // A series owner shown as a merged card: offer to stamp the source link + its fetched metadata
      // onto every chapter, not just chapter 1. Declining keeps the source on the owner alone. In
      // the unmerged view the owner is treated as a single gallery, so no series-wide prompt.
      const applyToChapters = showAsSeries
        && await confirmDialog({
          title: t('dlg.src_all_title'),
          body: t('dlg.src_all_body', { n: formatCount(g.chapters?.length || g.chapterCount || 0) }),
          ok: t('dlg.src_all_ok', { n: formatCount(g.chapters?.length || g.chapterCount || 0) }),
          cancel: t('dlg.src_all_one'),
        });

      // Register before the await so any reload that fires during the round-trip
      // knows this source change is in flight and uses this value, not stale DB.
      _pendingSourceChanges.set(g.id, parsed);

      const resp = await sendMsg({
        type: 'SET_SOURCE', galleryId: g.id, source: parsed.source,
        ...(parsed.sourceId ? { sourceId: parsed.sourceId } : {}),
        ...(parsed.sourceUrl ? { sourceUrl: parsed.sourceUrl } : {}),
        ...(applyToChapters ? { applyToChapters: true } : {}),
      });
      if (!resp?.ok) { _pendingSourceChanges.delete(g.id); return; }

      const $card = document.querySelector(`.card[data-gallery-id="${g.id}"]`);
      g.source = parsed.source;
      if (parsed.sourceId) g.sourceId = parsed.sourceId;
      if (parsed.sourceUrl) g.sourceUrl = parsed.sourceUrl;

      const liveEntry = _pageItems.find(x => x.id === g.id);
      if (liveEntry && liveEntry !== g) {
        liveEntry.source    = g.source;
        liveEntry.sourceId  = g.sourceId;
        liveEntry.sourceUrl = g.sourceUrl;
      }

      // Replace card so listeners reflect the new source state.
      _hoveredOpenBtn = null;
      if ($card) $card.replaceWith(buildCard(liveEntry || g));
    } else {
      const safeVisit = safeExternalUrl(curVisitUrl);
      if (safeVisit) window.open(safeVisit, '_blank', 'noopener');
    }
    });
  });

  // Drag one card onto another to merge into a series — a custom pointer drag with a floating
  // clone (below), so the whole card visibly follows the cursor and drops with an animation. Only
  // the cover thumbnail starts the drag; pointerdowns on the info/text area below are left alone so
  // the title, tags and metadata stay selectable for copying.
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;                        // left button only
    if (!e.target.closest('.card-thumb-wrap')) return; // only the cover initiates a merge-drag
    _beginCardDrag(e, card, g.id);
  });

  return card;
}

// Custom animated card drag. Starts once the pointer moves past a small threshold (so plain clicks
// still open the card). A fixed-position clone of the card follows the cursor; the card under it
// highlights as a merge target; releasing over one merges, otherwise the clone snaps back.
function _beginCardDrag(startEvent, card, gid) {
  const startX = startEvent.clientX, startY = startEvent.clientY;
  let dragging = false, clone = null, target = null, offX = 0, offY = 0;

  const startClone = () => {
    const rect = card.getBoundingClientRect();
    offX = startX - rect.left; offY = startY - rect.top;
    clone = card.cloneNode(true);
    // A cloned canvas comes back blank; carry the cover glow over.
    const glows = card.querySelectorAll('.card-thumb-glow');
    clone.querySelectorAll('.card-thumb-glow').forEach((c, i) => c.getContext('2d').drawImage(glows[i], 0, 0));
    clone.classList.add('card-drag-clone');
    clone.classList.remove('merge-target');
    clone.style.width = rect.width + 'px';
    clone.style.left  = rect.left + 'px';
    clone.style.top   = rect.top + 'px';
    document.body.appendChild(clone);
    card.classList.add('drag-source');
    document.body.classList.add('card-dragging');
    requestAnimationFrame(() => clone && clone.classList.add('lifted'));
  };
  const moveClone = (ev) => { if (clone) { clone.style.left = (ev.clientX - offX) + 'px'; clone.style.top = (ev.clientY - offY) + 'px'; } };
  const updateTarget = (ev) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const over = el && el.closest('.card');
    const valid = over && over !== card ? over : null;
    if (target && target !== valid) target.classList.remove('merge-target');
    if (valid) valid.classList.add('merge-target');
    target = valid;
  };
  const finish = (el, keep) => { if (el) setTimeout(() => el.remove(), 200); };

  const move = (ev) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      dragging = true;
      startClone();
    }
    ev.preventDefault();
    moveClone(ev);
    updateTarget(ev);
  };
  const cleanup = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    card.classList.remove('drag-source');
    document.body.classList.remove('card-dragging');
  };
  const up = async (ev) => {
    cleanup();
    if (!dragging) return;                              // was a click — let it open the card
    // Suppress the click that fires after this drag so the card's link doesn't also navigate.
    const suppress = (ce) => { ce.preventDefault(); ce.stopPropagation(); };
    document.addEventListener('click', suppress, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', suppress, true), 350);

    const dropTarget = target;
    if (target) target.classList.remove('merge-target');
    const dest = (dropTarget || card).getBoundingClientRect();
    if (clone) {
      clone.classList.add('dropping');
      clone.style.left = dest.left + 'px'; clone.style.top = dest.top + 'px';
      if (dropTarget) clone.style.opacity = '0'; else clone.classList.remove('lifted');
    }
    finish(clone);
    if (dropTarget) await handleMergeDrop(dropTarget.dataset.galleryId, gid);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}

// Merge the dragged gallery into the drop target as its next chapter (target keeps its id).
async function handleMergeDrop(targetId, sourceId) {
  const name = (id) => {
    const x = _pageItems.find(p => p.id === String(id));
    return (x && pickTitle(x, getLang())) || `#${id}`;
  };
  if (!(await confirmDialog({
    title: t('dlg.merge_title'), body: t('dlg.merge_body'),
    detail: [name(sourceId), t('dlg.merge_into', { title: name(targetId) })], ok: t('dlg.merge_ok'),
  }))) return;
  try {
    await mergeIntoSeries(targetId, sourceId);
  } catch (err) {
    alertDialog({ title: t('dlg.merge_fail_title'), body: t('dlg.merge_fail_body'), detail: err.message, tone: 'error' });
    return;
  }
  await applyFilters();
  updateHeaderStats();
}

// Series translate picker: one press translates one chapter. Defaults to the lowest-numbered
// untranslated chapter but any can be chosen; the job is the normal per-gallery translate keyed
// by the chosen chapter's id.
async function openSeriesTranslateModal(g) {
  const chapters = g.chapters || [];
  const entities = await api.galleries.byIds(chapters.map(c => c.id));
  let defaultIdx = entities.findIndex(e => e && !e.translated);
  if (defaultIdx < 0) defaultIdx = 0;

  const opts = chapters.map((c, i) => {
    const e = entities[i];
    const nm = c.title || pickTitle(e, getLang()) || '';
    const flag = e?.translated ? ` · ${t('ov.translated')}` : '';
    return `<option value="${escHtml(c.id)}" ${i === defaultIdx ? 'selected' : ''}>${escHtml(t(memberKind(c) === 'volume' ? 'ov.volume_n' : 'ov.chapter_n', { n: chapterNumberLabel(c) ?? i + 1 }))}${nm ? ' — ' + escHtml(nm) : ''}${flag}</option>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay show';
  overlay.innerHTML = `<div class="modal-box">
    <div class="modal-title">${escHtml(t('sertr.title'))}</div>
    <div class="modal-label" style="margin-bottom:10px">${escHtml(t('sertr.desc'))}</div>
    <select class="modal-select" id="_serTrSel">${opts}</select>
    <div class="modal-actions">
      <button class="btn" id="_serTrCancel">${escHtml(t('common.cancel'))}</button>
      <button class="btn primary" id="_serTrGo">${escHtml(t('sertr.go'))}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  // Focus inside the modal, so keyboard scrolling stays in it instead of moving the page behind.
  overlay.querySelector('#_serTrSel').focus();
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#_serTrCancel').addEventListener('click', close);
  overlay.querySelector('#_serTrGo').addEventListener('click', async () => {
    const gid = overlay.querySelector('#_serTrSel').value;
    close();
    await sendMsg({ type: 'TRANSLATE_GALLERY', galleryId: gid });
  });
}

function renderGrid(galleries) {
  const grid = document.getElementById('grid');

  // Release decoded bitmaps immediately so Chrome can evict them before the new page loads.
  grid.querySelectorAll('img.card-thumb').forEach(img => { img.src = ''; });

  if (galleries.length === 0) {
    grid.innerHTML = `<div class="empty">${escHtml(t('lib.empty_title'))}<br>${escHtml(t('lib.empty_sub'))}</div>`;
    return;
  }

  grid.innerHTML = '';
  for (const g of galleries) grid.appendChild(buildCard(g));
  if (safeMode) applyGibberishToGrid();
}

function fetchPageCovers(pageSlice) {
  for (const g of pageSlice) {
    // An empty gallery's cover comes from the source site — only possible via the extension.
    // A series may hold a stored cover even when its owner chapter has no pages of its own.
    const showAsSeries = _mergeSeries && g.isSeries;
    if (_coverCache.has(coverCacheKey(g.id, showAsSeries))) continue;
    if (g.count > 0 || (showAsSeries && (g.aggPages || 0) > 0) || (g.count === 0 && _canDownload(g))) {
      sendMsg({ type: 'GET_COVER', galleryId: g.id, source: g.source, thumbWidth: _thumbWidth, page: 'library', preferSeries: showAsSeries });
    }
  }
}

// ── Cover pushes from services (in-tab) and other contexts (BroadcastChannel) ──

platform.onControl((msg) => {
  if (msg.type === 'COVER_INVALIDATED') {
    _coverCache.delete(coverCacheKey(msg.galleryId, false));
    _coverCache.delete(coverCacheKey(msg.galleryId, true));
    _scheduleCoverCacheSave();
    const gEntry = _pageItems.find(g => g.id === msg.galleryId);
    if (gEntry) sendMsg({ type: 'GET_COVER', galleryId: msg.galleryId, source: gEntry.source, thumbWidth: _thumbWidth, page: 'library', preferSeries: _mergeSeries && !!gEntry.isSeries });
    return;
  }
  if (msg.type === 'COVER_READY') {
    if (msg.page !== 'library') return;
    const gEntry = _pageItems.find(g => g.id === msg.galleryId);
    if (!gEntry) return;
    // A chapter fallback requested before the metadata feed converted this card into a series
    // may finish late. It must not overwrite the newer series-cover request (or vice versa).
    if (!coverRequestMatchesEntry(msg, gEntry, _mergeSeries)) return;
    if (msg.coverDataUrl) {
      const preferSeries = !!msg.preferSeries;
      _coverCache.set(coverCacheKey(msg.galleryId, preferSeries), msg.coverDataUrl);
      _coverCache.delete(coverCacheKey(msg.galleryId, !preferSeries));
      _scheduleCoverCacheSave();
      document.querySelectorAll(`.card[data-gallery-id="${msg.galleryId}"] .card-thumb-wrap`).forEach(wrap => {
        let img = wrap.querySelector('.card-thumb');
        if (!img) {
          wrap.innerHTML = '';
          img = document.createElement('img');
          img.className = 'card-thumb';
          img.alt = '';
          wireCardThumbFit(img);
          wrap.appendChild(img);
        }
        img.classList.remove('landscape');
        img.src = msg.coverDataUrl;
      });
    }
    // For galleries that were empty before (count=0), refresh the entity from the DB.
    if (gEntry.count === 0) {
      store.load(msg.galleryId).then(entity => {
        if (entity) { gEntry.count = entity.count; gEntry.size = entity.size; gEntry.origSize = entity.origSize; }
        const $card = document.querySelector(`.card[data-gallery-id="${msg.galleryId}"]`);
        if ($card) $card.replaceWith(buildCard(gEntry));
        updateHeaderStats();
      }).catch(console.error);
    }
    return;
  }
});

// ── Live job status (upload / translate / download), live across every open tab ──
// Whoever runs a job — this tab, the PWA service worker, or the extension-hosted agent —
// publishes deltas via platform.jobs (BroadcastChannel + a durable registry). We paint progress
// on the matching card, hydrate in-flight jobs on load, and run one-shot completion effects.

const _liveJobs = new Map();        // gid → last job seen (drives re-paint after re-renders)
const _jobDoneHandled = new Set();  // gids whose 'done' side-effects already ran here
const _interrupted = new Set();     // gids showing the transient "Interrupted" hint (protected from rebuilds)

// While a translate job runs, the translate button doubles as a Stop control (stays enabled,
// shows a stop icon, click cancels). Toggling also parks the shift-revert and alt-search
// affordances so they don't fight the stop state.
function _setTrCancelMode(btn, on) {
  if (!btn) return;
  if (on) {
    if (btn.classList.contains('cancelling')) return;
    btn.classList.add('cancelling');
    btn.disabled = false;
    if (btn.dataset.tipShift != null) { btn._tipShiftStash = btn.dataset.tipShift; delete btn.dataset.tipShift; }
    if (btn.dataset.tipAlt != null) { btn._tipAltStash = btn.dataset.tipAlt; delete btn.dataset.tipAlt; }
    btn.dataset.tip = t('card.tip_cancel');
    _trFlip.snap(btn, _STOP_SVG);
  } else {
    if (!btn.classList.contains('cancelling')) return;
    btn.classList.remove('cancelling');
    if (btn._tipShiftStash != null) { btn.dataset.tipShift = btn._tipShiftStash; delete btn._tipShiftStash; }
    if (btn._tipAltStash != null) { btn.dataset.tipAlt = btn._tipAltStash; delete btn._tipAltStash; }
    btn.dataset.tip = btn.classList.contains('done') ? _translatedTip() : t('card.tip_translate');
    _trFlip.snap(btn, _TRANSLATE_SVG);
  }
}

// How long a terminal job message (done / error / cancelled / interrupted) lingers on the card
// before it returns to its normal resting state — long enough to read, short enough not to nag.
const JOB_MSG_LINGER_MS = 4000;

// Return a card from any job state to its normal resting look: no progress overlay, reset bar,
// buttons enabled, Stop control reverted. The standardized linger timers call this.
function _clearCardProgress(gid) {
  const card = document.querySelector(`.card[data-gallery-id="${gid}"]`);
  if (!card) return;
  const body = card.querySelector('.card-body');
  const fill = document.getElementById(`progfill-${gid}`);
  const label = document.getElementById(`proglabel-${gid}`);
  if (body) body.classList.remove('downloading');
  if (fill) { fill.classList.remove('indeterminate', 'done'); fill.style.width = ''; }
  if (label) label.textContent = '';
  card.querySelectorAll('.card-btn-translate, .card-btn-dl').forEach(b => {
    if (b.classList.contains('cancelling')) _setTrCancelMode(b, false);
    b.disabled = false;
  });
}

function applyJob(job) {
  if (!job || job.gid == null) return;
  const gid = String(job.gid);
  const { status, kind } = job;
  // The job layer publishes label/error keys (it can run in the SW, which has no i18n);
  // resolution to the user's language happens here. Legacy `label` strings still pass through.
  const jobLabel = job.labelKey ? t(job.labelKey, job.labelArgs) : job.label;
  const jobError = job.errorKey ? t(job.errorKey) : job.error;

  if (status === 'done' || status === 'error' || status === 'cancelled') _liveJobs.delete(gid);
  else _liveJobs.set(gid, job);
  if (status !== 'done') _jobDoneHandled.delete(gid);

  const card    = document.querySelector(`.card[data-gallery-id="${gid}"]`);
  if (!card) {
    // A brand-new gallery mid-job (a download/upload started elsewhere) has no card yet — reveal it.
    // Translate runs on an EXISTING gallery, so if its card isn't in the current view there's
    // nothing to reveal; reloading on every progress frame would thrash the visible cards'
    // hover animations. Only reload for kinds that can introduce a new card.
    if (kind !== 'translate' && kind !== 'sync' && status !== 'done' && status !== 'error') _scheduleReloadPage();
    return;
  }
  const fillEl  = document.getElementById(`progfill-${gid}`);
  const labelEl = document.getElementById(`proglabel-${gid}`);
  const body    = card.querySelector('.card-body');
  const isTranslate = kind === 'translate';
  // A sync job fills in a series' chapter info: it has its own bar and never touches the buttons.
  const isSync = kind === 'sync';
  const btns = isSync ? [] : [...card.querySelectorAll(isTranslate ? '.card-btn-translate' : '.card-btn-dl')];

  if (status === 'done' && _jobDoneHandled.has(gid)) return;

  if (status === 'error') {
    if (body) body.classList.add('downloading');
    if (fillEl) fillEl.classList.remove('done', 'indeterminate');
    if (labelEl) labelEl.textContent = `${t('prog.error')}: ${jobError || 'unknown'}`;
    btns.forEach(b => { if (isTranslate) _setTrCancelMode(b, false); b.disabled = false; });
    if (kind === 'upload') store.load(gid).then(g => { if (!g || g.count === 0) store.remove(gid); });
    setTimeout(() => _clearCardProgress(gid), JOB_MSG_LINGER_MS);
    return;
  }

  if (status === 'cancelled') {
    // User stopped a translation: soft reset the card — drop the Stop state, clear the bar,
    // briefly show "Cancelled", then return the card to normal.
    if (fillEl) { fillEl.classList.remove('indeterminate', 'done'); fillEl.style.width = '0%'; }
    if (labelEl) labelEl.textContent = t('prog.cancelled');
    btns.forEach(b => { _setTrCancelMode(b, false); b.disabled = false; });
    setTimeout(() => _clearCardProgress(gid), JOB_MSG_LINGER_MS);
    return;
  }

  if (body) body.classList.add('downloading');

  if (status === 'downloading') {
    // Byte phase of a download: map to the first 85% of the bar like v1.
    const { downloaded = 0, total: dlTotal = 0, pages = 0 } = job;
    if (fillEl) {
      if (dlTotal > 0) { fillEl.classList.remove('indeterminate'); fillEl.style.width = Math.min(85, Math.round((downloaded / dlTotal) * 85)) + '%'; }
      else { fillEl.classList.add('indeterminate'); fillEl.style.width = ''; }
    }
    if (labelEl) {
      labelEl.textContent = (pages > 0 && dlTotal > 0)
        ? `~${formatCount(Math.min(pages, Math.round(downloaded * pages / dlTotal)))} / ${formatCount(pages)} · ${formatBytes(downloaded)}`
        : `↓ ${formatBytes(downloaded)}`;
    }
    btns.forEach(b => { b.disabled = true; });
    return;
  }
  if (status === 'extracting') {
    if (fillEl) { fillEl.classList.remove('indeterminate'); fillEl.style.width = '85%'; }
    if (labelEl) labelEl.textContent = t('prog.extracting');
    btns.forEach(b => { b.disabled = true; });
    return;
  }
  if (status === 'started') {
    if (fillEl) { fillEl.classList.remove('indeterminate', 'done'); fillEl.style.width = '0%'; }
    if (labelEl) labelEl.textContent = jobLabel || (isSync ? t('prog.syncing') : job.total ? `0 / ${formatCount(job.total)}` : t('prog.starting'));
    if (isTranslate) btns.forEach(b => _setTrCancelMode(b, true));
    else btns.forEach(b => { b.disabled = true; });
    return;
  }

  if (status === 'progress' || status === 'done') {
    const done = job.done || 0, total = job.total || 0;
    let pct;
    if (isTranslate) pct = (typeof job.pct === 'number') ? job.pct : (total > 0 ? Math.round((done / total) * 100) : 0);  // weighted across the read/translate/render stages
    else if (kind === 'upload' || isSync) pct = total > 0 ? Math.round((done / total) * 100) : 0;
    else pct = total > 0 ? Math.round(85 + (done / total) * 15) : 85;  // download store loop: last 15%
    if (fillEl) {
      fillEl.classList.remove('indeterminate');
      fillEl.style.width = pct + '%';
      fillEl.classList.toggle('done', status === 'done');
    }
    const doneText = formatCount(done), totalText = formatCount(total);
    const skippedNote = job.skipped > 0 ? ` (${t('prog.already_cached', { n: formatCount(job.skipped) })})` : '';
    if (labelEl) {
      if (isTranslate) {
        // The translate label is self-contained (it carries the active stage's own count), so it
        // isn't suffixed with the rendered-page tally the way downloads/uploads are.
        labelEl.textContent = status === 'done'
          ? `${t('prog.translated')} ${doneText}/${totalText}${job.failed ? ` (${formatCount(job.failed)} failed)` : ''}${job.costNote ? ` · ${job.costNote}` : ''}`
          : jobLabel ? jobLabel : `${t('prog.translating')} ${doneText} / ${totalText}`;
      } else if (isSync) {
        labelEl.textContent = status === 'done' ? t('prog.synced') : `${t('prog.syncing')} · ${doneText}/${totalText}`;
      } else {
        labelEl.textContent = status === 'done'
          ? `${t('prog.done')} — ${doneText}/${totalText}${skippedNote}`
          : jobLabel ? `${jobLabel} · ${doneText}/${totalText}${skippedNote}` : `${doneText} / ${totalText}${skippedNote}`;
      }
    }
    if (status === 'done') {
      btns.forEach(b => { if (isTranslate) _setTrCancelMode(b, false); b.disabled = false; if (!isTranslate) { b.textContent = '✓'; } b.classList.add('done'); });
      if (!_jobDoneHandled.has(gid)) {
        _jobDoneHandled.add(gid);
        if (kind === 'upload') store.load(gid).then(g => { if (!g || g.count === 0) store.remove(gid); });
        setTimeout(() => { if (body) body.classList.remove('downloading'); loadAll(); }, JOB_MSG_LINGER_MS);
      }
    } else if (isTranslate) {
      btns.forEach(b => _setTrCancelMode(b, true));
    } else {
      btns.forEach(b => { b.disabled = true; });
    }
  }
}

platform.jobs.subscribe(applyJob);

// Hydrate in-flight jobs on load. A registry row whose runner is gone is dead — clear it (so it
// can never wedge a card) and show the resumable hint. Live runners publish at least every page;
// translate gets a wide staleness margin because a cloud batch call can sit quiet for minutes,
// so for translate we instead ask the SW whether it's actually still running the job.
const JOB_STALE_MS = { download: 2 * 60 * 1000, upload: 2 * 60 * 1000, translate: 10 * 60 * 1000 };

function _applyInterruptedUI(gid) {
  const labelEl = document.getElementById(`proglabel-${gid}`);
  const body = labelEl && labelEl.closest('.card-body');
  if (body) body.classList.add('downloading');
  if (labelEl) labelEl.textContent = t('prog.interrupted');
}

// An interrupted job: clear its registry row, show the resumable hint with buttons ENABLED, then
// return the card to normal after the standard linger. The gid is parked in _interrupted so a
// cover-load rebuild can't wipe the hint before the user reads it (same guard live jobs get).
function _markJobInterrupted(job) {
  const gid = String(job.gid);
  platform.jobs.clear(gid, job.kind);
  _liveJobs.delete(gid);
  _interrupted.add(gid);
  _applyInterruptedUI(gid);
  setTimeout(() => { _interrupted.delete(gid); _clearCardProgress(gid); }, JOB_MSG_LINGER_MS);
}

async function hydrateJobs() {
  const jobs = await platform.jobs.current();
  for (const job of jobs) {
    // Terminal rows are retained by the registry so a failure with no live listener survives to
    // the next open — paint once, then acknowledge (clear) so it doesn't replay on every load.
    if (job.status === 'error' || job.status === 'cancelled') {
      applyJob(job);
      platform.jobs.clear(String(job.gid), job.kind);
      continue;
    }
    // Translations are server-owned: boot.js's ensureTranslationsAlive() re-attaches to any that
    // are still running (after a navigation or a service-worker kill) and a live runner keeps
    // publishing over the top of this. So just paint whatever the registry currently has.
    if (job.kind === 'translate') { applyJob(job); continue; }

    // upload / download can't be re-attached the same way — keep the "interrupted" hint if stale.
    const staleAfter = JOB_STALE_MS[job.kind] || 2 * 60 * 1000;
    if ((Date.now() - (job.at || 0)) > staleAfter) { _markJobInterrupted(job); continue; }
    applyJob(job);
  }
}

// ── Filters / sort ──

function parseSearch(raw) {
  const typed = [];
  const plain = [];
  const re = /([a-z:]+):"([^"]+)"/gi;
  const aliases = { female: 'tag:female', male: 'tag:male' };
  const typeOf = (name) => aliases[name.toLowerCase()] ?? name.toLowerCase();
  let match;
  let rest = raw;
  while ((match = re.exec(raw)) !== null) {
    typed.push({ type: typeOf(match[1]), value: match[2].toLowerCase() });
    rest = rest.replace(match[0], '');
  }
  // A filter still being typed — without quotes (`artist:an`) or with its quote still open
  // (`tag:"big br`) — matches what starts with it; one with no value yet is left out.
  const open = (m, pre, name, value) => {
    const type = typeOf(name);
    if (!SEARCH_TYPES.has(type)) return m;
    if (value.trim()) typed.push({ type, value: value.trim().toLowerCase(), prefix: true });
    return pre;
  };
  rest = rest.replace(/(^|\s)([a-z]+(?::(?:fe)?male)?):"([^"]*)$/i, open)
    .replace(/(^|\s)([a-z]+(?::(?:fe)?male)?):([^\s"]*)(?=\s|$)/gi, open);
  rest.trim().split(/\s+/).filter(Boolean).forEach(t => plain.push(t.toLowerCase()));
  return { typed, plain };
}

// Loads the current page from the database (sorted + filtered server-side), so only the
// galleries on screen are ever materialized — memory is bounded by PAGE_SIZE, not library size.
let _loadSeq = 0;
async function applyFilters() {
  const seq = ++_loadSeq;
  const raw  = searchQuery();
  const sort = document.getElementById('sortSelect').value;
  const { typed, plain } = parseSearch(raw);
  const filtering = Object.values(_filter).some(set => set.size);
  const match = (typed.length || plain.length || filtering)
    ? (g) => _matchFilter(g) && _matchEntity(g, typed, plain) : null;

  const { items, total } = await store.getPage({ sort, page: currentPage, pageSize: PAGE_SIZE, match, merge: _mergeSeries });
  if (seq !== _loadSeq) return; // a newer search/sort/page load superseded this one
  _total = total;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) { currentPage = totalPages; return applyFilters(); }

  // Apply any in-flight optimistic source edits the DB hasn't committed yet.
  for (const g of items) {
    const pending = _pendingSourceChanges.get(g.id);
    if (pending) {
      g.source = pending.source;
      if (pending.sourceId != null) g.sourceId = pending.sourceId;
      if (pending.sourceUrl) g.sourceUrl = pending.sourceUrl;
    }
  }

  _pageItems = items;
  renderGrid(items);
  renderPagination(currentPage, totalPages);
  fetchPageCovers(items);
  syncUrl();

  // Re-paint any in-flight job status onto the freshly rendered cards.
  for (const job of _liveJobs.values()) applyJob(job);
  // Re-apply any transient "Interrupted" hint after a full re-render too.
  for (const gid of _interrupted) _applyInterruptedUI(gid);
}

// Filter predicate, per tag type: with any "show only" values the gallery needs one of them (so a
// gallery without that tag type drops out); it must carry none of the "hide" values.
function _matchFilter(g) {
  for (const [type, states] of Object.entries(_filter)) {
    if (!states.size) continue;
    const names = (g.tags || []).filter(t => t.type === type).map(t => String(t.name).toLowerCase());
    if (names.some(n => states.get(n) === 'exclude')) return false;
    if ([...states.values()].includes('include') && !names.some(n => states.get(n) === 'include')) return false;
  }
  return true;
}

// A typed search matches the whole tag name ("big" finds "big", not "big breasts"). A language
// also finds its regional variants, as its flag does: "chinese" finds "chinese (traditional)".
function _tagNameMatches(type, name, value) {
  const lower = String(name).toLowerCase();
  if (lower === value) return true;
  const want = type === 'language' && LANG_NAME_TO_CODE[value];
  const have = want && LANG_NAME_TO_CODE[lower];
  return !!have && (have === want || have.startsWith(`${want}-`));
}

// Search predicate; the store evaluates it against each gallery's metadata.
function _matchEntity(g, typed, plain) {
  for (const { type, value, prefix } of typed) {
    if (type === 'translated' || type === 'favorite') {   // translated:"yes" / favorite:"no"
      if (g[type] !== (prefix ? { y: true, n: false }[value[0]] : { yes: true, no: false }[value])) return false;
      continue;
    }
    if (type === 'source') {
      const source = g.source.toLowerCase();
      if (prefix ? !source.startsWith(value) : source !== value) return false;
      continue;
    }
    const matches = prefix ? (t) => String(t.name).toLowerCase().startsWith(value) : (t) => _tagNameMatches(type, t.name, value);
    if (!g.tags || !g.tags.some(t => t.type === type && matches(t))) return false;
  }
  for (const term of plain) {
    if (g.id.includes(term)) continue;
    if (g.title && g.title.toLowerCase().includes(term)) continue;
    if (g.tags && g.tags.some(t => t.name.toLowerCase().includes(term))) continue;
    return false;
  }
  return true;
}

function renderPagination(page, totalPages) {
  const el = document.getElementById('pagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const nums = _pageNumbers(page, totalPages);
  let html = `<button class="page-btn" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>←</button>`;
  for (const n of nums) {
    if (n === null) {
      html += `<span class="page-ellipsis">…</span>`;
    } else {
      html += `<button class="page-btn${n === page ? ' active' : ''}" data-page="${n}">${formatCount(n)}</button>`;
    }
  }
  html += `<button class="page-btn" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>→</button>`;

  el.innerHTML = html;
  el.querySelectorAll('.page-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPage = parseInt(btn.dataset.page);
      applyFilters();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

// Returns page numbers to show, with null for ellipsis gaps. A five-page window rides with
// the current page, plus the first and last page: 1 … 8 9 [10] 11 12 … 20. Near an edge the
// window extends to six pages from that edge instead: 1 2 3 [4] 5 6 … 20.
function _pageNumbers(current, total) {
  let lo = current - 2, hi = current + 2;
  if (lo <= 3) { lo = 1; hi = Math.max(hi, 6); }                       // window touches the start
  if (hi >= total - 2) { hi = total; lo = Math.min(lo, total - 5); }   // window touches the end
  lo = Math.max(1, lo);
  hi = Math.min(total, hi);
  const result = [];
  if (lo > 1) result.push(1, null);
  for (let p = lo; p <= hi; p++) result.push(p);
  if (hi < total) result.push(null, total);
  return result;
}

// "Original pages X" over "Other data Y" — a size not yet recomputed is all original.
function _sizeSplit(total, original) {
  const orig = original ?? total ?? 0;
  return t('lib.size_split', { orig: formatBytes(orig), rest: formatBytes(Math.max(0, (total || 0) - orig)) });
}
const _sizeHtml = (total, original) => `<span class="card-size" data-tip="${escHtml(_sizeSplit(total, original))}">${formatBytes(total)}</span>`;
// Hovering the page count shows the typical page — its tier, size and megapixels — over the
// average original page's bytes. The first line waits until the pages have been measured.
function _pagesHtml(text, page, original, count) {
  if (!count) return text;
  const avg = t('card.tip_page_avg', { size: formatBytes((original || 0) / count) });
  const tip = page ? `${page.w}×${page.h}, ${formatMegapixels(page.mp)}\n${avg}` : avg;
  return `<span class="card-pages" data-tip="${escHtml(tip)}"${page ? ` data-tip-badge="${page.tier}"` : ''}>${text}</span>`;
}

// The Images total's hover: its images tallied by resolution tier, every tier listed. A gallery's
// pages count in the tier of its typical (median) page; ones not sized yet are tallied apart.
function _tierTally(stats) {
  const byTier = new Map(TIERS.map(tier => [tier.id, 0]));
  let unsized = 0;
  for (const g of Object.values(stats.galleries)) {
    if (!g.count) continue;
    const tier = describePage(g.medianPage)?.tier;
    if (tier) byTier.set(tier, byTier.get(tier) + g.count); else unsized += g.count;
  }
  const mp = (n) => n.toLocaleString(getLang(), { maximumFractionDigits: 1 });
  const range = (i) => i === 0 ? `< ${mp(TIERS[0].max)} MP`
    : TIERS[i].max === Infinity ? `≥ ${mp(TIERS[i - 1].max)} MP` : `${mp(TIERS[i - 1].max)}–${mp(TIERS[i].max)} MP`;
  const rows = TIERS.map((tier, i) => [`${tier.id}\v${range(i)}`, byTier.get(tier.id)]);
  if (unsized) rows.push([t('lib.tier_unsized'), unsized]);
  const pct = (n) => {
    const p = stats.totalImages ? n / stats.totalImages * 100 : 0;
    return n && p < 1 ? '<1%' : `${Math.round(p)}%`;
  };
  // Percentages padded to one width with figure spaces (digit-wide, never collapsed), so the
  // right-aligned values keep their "·" in one column.
  const width = Math.max(...rows.map(([, n]) => pct(n).length));
  return [t('lib.images_by_tier'), ...rows.map(([label, n]) => `${label}\t${formatCount(n)} · ${pct(n).padStart(width, ' ')}`)].join('\n');
}

async function updateHeaderStats() {
  const [stats, topLevel] = await Promise.all([api.galleries.stats(), api.galleries.count({ merge: _mergeSeries })]);
  // Merged, a series counts as one gallery here; unmerged, every chapter is counted. Image/storage
  // totals always include every chapter's pages.
  document.getElementById('hTotalGalleries').textContent = formatCount(topLevel);
  document.getElementById('hTotalImages').textContent    = formatCount(stats.totalImages);
  document.getElementById('hImagesStat').dataset.tip     = _tierTally(stats);
  document.getElementById('hTotalSize').textContent      = formatBytes(stats.totalSize);
  const sizeStat = document.getElementById('hSizeStat');
  if (sizeStat) {
    sizeStat.dataset.tip = _sizeSplit(stats.totalSize, stats.totalOrig);
    const avg = stats.totalImages > 0 ? Math.round(stats.totalSize / stats.totalImages) : 0;
    sizeStat.dataset.tipShift = avg > 0 ? t('lib.avg_per_image', { size: formatBytes(avg) }) : '';
  }
}

// Full (re)load of the library view — the current page plus the aggregate header stats.
async function loadAll() {
  // Paint the bounded card window first. Aggregate totals scan the gallery stat records and can
  // otherwise compete with the visible-page cursor on a large library.
  await applyFilters();
  updateHeaderStats().catch(() => {});
  await hydrateJobs();
}

// Site favicon on the open-source button. Source icons render only from Shiori's durable cache;
// until one is cached the slot shows the chain icon, swapped for the fetched copy when it lands.
function _makeOpenBtnInner(source) {
  const CHAIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  if (!source) return CHAIN_SVG;
  const icon = _siteFavicon(source);
  if (!icon) return `<span class="source-icon-slot" data-fav="${escHtml(source)}" style="width:12px;height:12px;display:inline-block;pointer-events:none;">${CHAIN_SVG}</span>`;
  return `<img src="${escHtml(icon)}" data-fav="${escHtml(source)}" alt="" decoding="async" style="width:12px;height:12px;pointer-events:none;">`;
}

// ── Shift key state ──
// The held modifiers come from the tooltip module (onModifiers), which also shows each control's
// Shift / Alt label; this page flips the hovered control's icon to match.

let _shiftHeld         = false;
let _hoveredDlBtn      = null;
let _hoveredOpenBtn    = null;
let _hoveredExportBtn  = null;
let _hoveredDelBtn     = null;
let _hoveredTrBtn      = null;
let _operatingOnCard   = null;

// A button's icon flips over to another. Each icon keeps its own pending swap, so flipping one
// button can never cancel another's halfway and leave it hidden or on the wrong icon.
function _makeFlipBtn(innerClass) {
  const timers = new WeakMap();
  const reset = (inner) => {
    clearTimeout(timers.get(inner));
    timers.delete(inner);
    inner.style.transition = 'none';
    inner.style.transform  = '';
  };
  return {
    to(btn, html) {
      const inner = btn?.querySelector('.' + innerClass);
      if (!inner) return;
      reset(inner);
      void inner.offsetHeight;
      inner.style.transition = 'transform 0.1s ease-in';
      inner.style.transform  = 'scaleY(0)';
      timers.set(inner, setTimeout(() => {
        timers.delete(inner);
        inner.style.transition = 'none';
        inner.innerHTML = html;
        void inner.offsetHeight;
        inner.style.transition = 'transform 0.1s ease-out';
        inner.style.transform  = '';
      }, 100));
    },
    snap(btn, html) {
      const inner = btn?.querySelector('.' + innerClass);
      if (!inner) return;
      reset(inner);
      inner.innerHTML = html;
    }
  };
}

const _openFlip   = _makeFlipBtn('open-inner');
const _dlFlip     = _makeFlipBtn('dl-inner');
const _exportFlip = _makeFlipBtn('export-inner');
const _delFlip    = _makeFlipBtn('del-inner');
const _trFlip     = _makeFlipBtn('tr-inner');

const _OPEN_SHIFT_ICON  = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
const _DL_SVG           = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';
const _DL_ICON          = '<span class="dl-inner">' + _DL_SVG + '</span>';
const _UPLOAD_ICON      = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>';
const _EXPORT_SVG       = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12h11"/><path d="m17 16 4-4-4-4"/><path d="M21 6.344V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1.344"/></svg>';
const _EXPORT_SHIFT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';
const _EXPORT_ICON      = '<span class="export-inner">' + _EXPORT_SVG + '</span>';
const _DELETE_SVG       = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const _DELETE_SHIFT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M9 13l2 2 4-4"/></svg>';
const _DELETE_ICON      = '<span class="del-inner">' + _DELETE_SVG + '</span>';
const _TRANSLATE_SVG    = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>';
const _REVERT_SVG       = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
const _TRANSLATE_ICON   = '<span class="tr-inner">' + _TRANSLATE_SVG + '</span>';
const _HEART_SVG        = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>';
const _STOP_SVG         = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

// Shift pressed or released — including a release that happened outside the window, which the
// tooltip module notices on the next mouse event or when the window is left.
onModifiers(({ shift }) => {
  if (shift === _shiftHeld) return;
  _shiftHeld = shift;
  document.body.classList.toggle('shift-held', shift);
  if (shift) {
    if (_hoveredDlBtn && !_hoveredDlBtn.disabled) _dlFlip.to(_hoveredDlBtn, _UPLOAD_ICON);
    if (_hoveredOpenBtn && _hoveredOpenBtn.dataset.tipShift) _openFlip.to(_hoveredOpenBtn, _OPEN_SHIFT_ICON);
    if (_hoveredExportBtn && !_hoveredExportBtn.disabled) _exportFlip.to(_hoveredExportBtn, _EXPORT_SHIFT_SVG);
    if (_hoveredDelBtn) _delFlip.to(_hoveredDelBtn, _DELETE_SHIFT_SVG);
    if (_hoveredTrBtn && !_hoveredTrBtn.classList.contains('cancelling') && _hoveredTrBtn.dataset.tipShift && !_hoveredTrBtn.disabled) _trFlip.to(_hoveredTrBtn, _REVERT_SVG);
  } else {
    if (_hoveredDlBtn) _dlFlip.to(_hoveredDlBtn, _DL_SVG);
    if (_hoveredOpenBtn && _hoveredOpenBtn.dataset.tipShift) _openFlip.to(_hoveredOpenBtn, _hoveredOpenBtn._baseInner);
    if (_hoveredExportBtn) _exportFlip.to(_hoveredExportBtn, _EXPORT_SVG);
    if (_hoveredDelBtn) _delFlip.to(_hoveredDelBtn, _DELETE_SVG);
    if (_hoveredTrBtn && _hoveredTrBtn.dataset.tipShift) _trFlip.to(_hoveredTrBtn, _TRANSLATE_SVG);
  }
});
window.addEventListener('focus', () => {
  if (_operatingOnCard) {
    const c = _operatingOnCard;
    _operatingOnCard = null;
    c.style.pointerEvents = 'none';
    void c.offsetHeight;
    c.style.pointerEvents = '';
  }
});
initTooltips();
initDropdowns();

// ── Local CBZ import (jobs-runner.js startImport: staged in OPFS for the most durable runner
//    available, or imported at once into a library kept as files) ──

async function replaceGalleryImages(gid, group) {
  const card    = document.querySelector(`[data-gallery-id="${gid}"]`);
  const progEl  = document.getElementById(`prog-${gid}`);
  const labelEl = document.getElementById(`proglabel-${gid}`);
  const dlBtns  = card ? [...card.querySelectorAll('.card-btn-dl')] : [];

  const setLabel = (txt) => { if (labelEl) labelEl.textContent = txt; };

  dlBtns.forEach(b => { b.disabled = true; b.innerHTML = '…'; });
  if (progEl) progEl.closest('.card-body')?.classList.add('downloading');

  setLabel(t('prog.reading_file'));
  let buffer;
  try { buffer = await importBytes(group, (p) => setLabel(t('prog.rendering', p))); }
  catch { setLabel(t('prog.err_read')); dlBtns.forEach(b => { b.disabled = false; b.innerHTML = _DL_ICON; }); return; }

  setLabel(t('prog.importing_file'));
  if (!await startImport({ galleryId: gid, buffer, filename: group.name, skipExisting: false })) {
    setLabel(t('prog.err_stage'));
    dlBtns.forEach(b => { b.disabled = false; b.innerHTML = _DL_ICON; });
  }
}

document.getElementById('replaceImgInput').addEventListener('change', async (e) => {
  const [group] = groupImports(e.target.files);
  const gid  = e.target.dataset.gid;
  e.target.value = '';
  if (!group || !gid) return;
  await replaceGalleryImages(gid, group);
});

function triggerImport() {
  document.getElementById('cbzFileInput').click();
}

document.getElementById('uploadCbzBtn').addEventListener('click', triggerImport);

async function importSingleFile(group, gid) {
  // Placeholder card is reserved up front by _handleImportFiles, so just drive progress.
  const progEl  = document.getElementById(`prog-${gid}`);
  const labelEl = document.getElementById(`proglabel-${gid}`);
  const setLabel = (txt) => { if (labelEl) labelEl.textContent = txt; };
  if (progEl) progEl.closest('.card-body')?.classList.add('downloading');

  setLabel(t('prog.reading_file'));
  let buffer;
  try { buffer = await importBytes(group, (p) => setLabel(t('prog.rendering', p))); }
  catch (err) { setLabel(t('prog.err_read')); if (progEl) progEl.closest('.card-body')?.classList.remove('downloading'); return; }

  setLabel(t('prog.importing_file'));
  // It reports via platform.jobs (jobs-runner.js startImport); applyJob() updates the card and drops
  // the placeholder if it produced nothing.
  if (!await startImport({ galleryId: gid, buffer, filename: group.name, skipExisting: true })) {
    setLabel(t('prog.err_stage'));
    if (progEl) progEl.closest('.card-body')?.classList.remove('downloading');
  }
}

async function _handleImportFiles(files, folders = []) {
  const accepted = [...files].filter(f => /\.(shi|shioridb)$/i.test(f.name) || isImportable(f));
  if (!accepted.length && !folders.length) return;
  if (accepted.length && /\.(shi|shioridb)$/i.test(accepted[0].name)) {
    try {
      const { kind, counts } = await importBackup(accepted[0]);
      alertDialog({
        title: t('dlg.import_done_title'), tone: 'success',
        body: kind === 'metadata'
          ? t('dlg.import_meta_body', { n: formatCount(counts.galleries) })
          : t('dlg.import_full_body', { g: formatCount(counts.galleries), i: formatCount(counts.images) }),
      });
    } catch (err) {
      alertDialog({ title: t('dlg.import_fail_title'), body: t('dlg.import_fail_body'), detail: err.message, tone: 'error' });
    }
    await loadAll();
    return;
  }
  // Reserve a placeholder card for every gallery up front (drop 3 zips → 3 cards appear
  // immediately; loose images share one), then upload them one at a time into their reserved ids.
  const queued = groupImports(accepted, folders).map((group) => {
    const gid = api.newGalleryId();   // the shared mint — per-context monotonic, never a raw Date.now()
    return { group, gid, title: group.name.replace(/\.[^.]+$/, '') };
  });
  await Promise.all(queued.map(({ gid, title }) => api.galleries.create(gid, { title: { english: title, japanese: '', pretty: '' }, isLocalImport: true })));
  await applyFilters();
  for (const { group, gid } of queued) {
    await importSingleFile(group, gid);
  }
}

document.getElementById('cbzFileInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  _handleImportFiles(files);
});

let _dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  // Only OS-file drags reach here (card merges use pointer events, not HTML5 drag).
  if (!e.dataTransfer.types.includes('Files')) return;
  _dragDepth++;
  document.body.classList.add('drag-over');
});
document.addEventListener('dragleave', () => {
  if (--_dragDepth <= 0) { _dragDepth = 0; document.body.classList.remove('drag-over'); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  _dragDepth = 0;
  document.body.classList.remove('drag-over');
  const { files, folders } = await droppedImports(e.dataTransfer);
  _handleImportFiles(files, folders);
});

// ── Per-gallery ZIP export ──

function _saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportMetadataZip(galleryId) {
  const gid = String(galleryId);
  const meta = await api.meta.get(gid);

  // Strip image-specific fields — this is a metadata-only backup. migrateTitle gives the export
  // the canonical shape (galleryId + title leading) regardless of when the record was stored.
  const { pageExts, ...metaClean } = migrateTitle(meta || {});

  const enc      = new TextEncoder();
  const zipBytes = _zipCreate([{ name: 'metadata.json', data: enc.encode(JSON.stringify(metaClean, null, 2)) }]);
  _saveBlob(new Blob([zipBytes], { type: 'application/zip' }), `shiori-${gid}-metadata.zip`);
}

async function exportMetadataBundleZip(galleryId) {
  const gid = String(galleryId);
  const enc = new TextEncoder();
  const getMeta = (id) => api.meta.get(String(id));
  const cleanMeta = (raw, { stripSeriesFields = false } = {}) => {
    const { pageExts, ...base } = migrateTitle(raw || {});
    if (!stripSeriesFields) return base;
    const { chapters, parentId, seriesTitle, seriesTags, ...plain } = base;
    return plain;
  };

  const meta = await getMeta(gid);
  const chapters = (Array.isArray(meta?.chapters) && meta.chapters.length > 1) ? meta.chapters : null;
  if (!chapters) {
    const zipBytes = _zipCreate([{ name: 'metadata.json', data: enc.encode(JSON.stringify(cleanMeta(meta), null, 2)) }]);
    _saveBlob(new Blob([zipBytes], { type: 'application/zip' }), `shiori-${gid}-metadata.zip`);
    return;
  }

  const files = [];
  const manifest = seriesManifest(meta, { metadataOnly: true });
  for (const { id, folder } of manifest.chapters) {
    files.push({
      name: `${folder}/metadata.json`,
      data: enc.encode(JSON.stringify(cleanMeta(await getMeta(id), { stripSeriesFields: true }), null, 2)),
    });
  }
  files.push({ name: 'series.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });
  _saveBlob(new Blob([_zipCreate(files)], { type: 'application/zip' }), `shiori-series-${gid}-metadata.zip`);
}

// How to export (Settings → Library): { format: 'zip' | 'cbz', translations }, asked each time
// unless a format is set there — the question can set it ("remember my choice"). Null when
// cancelled. Either holds the translations (study layers among them) unless turned off.
async function _exportFormat(gid, meta) {
  const kv = await platform.kv.get(['libExportFormat', 'libExportTranslations', 'libExportCbzTranslations']);
  const translations = (kv.libExportTranslations ?? kv.libExportCbzTranslations) !== false;
  if (kv.libExportFormat === 'zip' || kv.libExportFormat === 'cbz') return { format: kv.libExportFormat, translations };
  const answer = await choiceDialog({
    title: t('dlg.export_title'),
    detail: [pickTitle(meta || {}, getLang()) || `#${gid}`],
    choices: [
      { value: 'zip', label: t('set.lib_export_zip'), detail: t('dlg.export_zip_desc') },
      { value: 'cbz', label: t('set.lib_export_cbz'), detail: t('dlg.export_cbz_desc') },
    ],
    checks: [
      { name: 'translations', label: t('set.lib_export_tr'), checked: translations },
      { name: 'remember', label: t('dlg.export_remember'), checked: false },
    ],
    ok: t('dlg.export_ok'),
  });
  if (!answer) return null;
  const choice = { format: answer.value, translations: answer.checks.translations };
  if (answer.checks.remember) platform.kv.set({ libExportFormat: choice.format, libExportTranslations: choice.translations });
  return choice;
}

// Export one gallery — or, when it is a series owner, its whole series — in the Shiori gallery
// format (gallery-files.js): a ZIP, or a CBZ (the same files plus ComicInfo.xml, so other comic
// readers open it too), named after its title.
async function exportGallery(galleryId) {
  const gid = String(galleryId);
  const meta = await api.meta.get(gid);
  const how = await _exportFormat(gid, meta);
  if (!how) return;
  const { format, translations } = how;
  const { name, files } = await exportFiles(gid, { read: api.transfer.read, metaGet: api.meta.get, translations, comicInfo: format === 'cbz' });
  _saveBlob(new Blob([_zipCreate(files)], { type: format === 'cbz' ? 'application/vnd.comicbook+zip' : 'application/zip' }), `${name}.${format}`);
}

if (new URLSearchParams(window.location.search).get('import') === '1') {
  window.addEventListener('load', () => triggerImport(), { once: true });
}

const searchBox   = document.getElementById('searchBox');
const searchClear = document.getElementById('searchClear');
initSearchField(searchBox);

function updateClearBtn() {
  searchClear.classList.toggle('visible', searchQuery().length > 0);
}

let _searchTimer = null;
searchBox.addEventListener('input', () => {
  updateClearBtn();
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => { currentPage = 1; applyFilters(); }, 180);
});
searchClear.addEventListener('click', () => {
  setSearchQuery('');
  currentPage = 1;
  applyFilters();
  updateClearBtn();
  searchBox.focus();
});
document.getElementById('sortSelect').addEventListener('change', () => { currentPage = 1; applyFilters(); });

// ── Filter (rating / category) ──
// Each option cycles any → show only → hide. Changes apply (and are saved) as they're clicked.
const _filterBtn = document.getElementById('filterBtn');
const _filterModal = document.getElementById('filterModal');
const _FILTER_NEXT = { off: 'include', include: 'exclude', exclude: 'off' };
const _FILTER_STATE_KEY = { off: 'filter.any', include: 'filter.include', exclude: 'filter.exclude' };

function _renderFilter() {
  for (const [type, id] of [['rating', 'filterRating'], ['category', 'filterCategory']]) {
    document.getElementById(id).innerHTML = TAG_VALUES[type].map((v) => {
      const state = _filter[type].get(v) || 'off';
      return `<button type="button" class="fopt" data-type="${type}" data-value="${escHtml(v)}" data-state="${state}" aria-label="${escHtml(`${v}: ${t(_FILTER_STATE_KEY[state])}`)}"><span class="fopt-mark" aria-hidden="true"></span><span class="fopt-name">${escHtml(v)}</span></button>`;
    }).join('');
  }
  _syncFilterBtn();
}
function _syncFilterBtn() {
  _filterBtn.classList.toggle('active', _filter.rating.size + _filter.category.size > 0);
}
function _filterChanged() {
  _saveFilter();
  _renderFilter();
  currentPage = 1;
  applyFilters();
}
function _setFilterOpen(open) {
  _filterModal.classList.toggle('show', open);
  if (open) setTimeout(() => _filterModal.querySelector('.fopt')?.focus(), 30);
  else _filterBtn.focus();
}

_filterBtn.addEventListener('click', () => { _renderFilter(); _setFilterOpen(true); });
_filterModal.addEventListener('click', (e) => {
  if (e.target === _filterModal) { _setFilterOpen(false); return; }
  const opt = e.target.closest('.fopt');
  if (!opt) return;
  const states = _filter[opt.dataset.type];
  const next = _FILTER_NEXT[states.get(opt.dataset.value) || 'off'];
  if (next === 'off') states.delete(opt.dataset.value); else states.set(opt.dataset.value, next);
  _filterChanged();
  _filterModal.querySelector(`.fopt[data-type="${opt.dataset.type}"][data-value="${CSS.escape(opt.dataset.value)}"]`)?.focus();
});
document.getElementById('filterClear').addEventListener('click', () => {
  for (const states of Object.values(_filter)) states.clear();
  _filterChanged();
});
document.getElementById('filterClose').addEventListener('click', () => _setFilterOpen(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _filterModal.classList.contains('show')) _setFilterOpen(false);
});
// Changed in another tab: follow it.
window.addEventListener('storage', (e) => {
  if (e.key !== 'shiori:libFilter') return;
  try { _loadFilter(JSON.parse(e.newValue || 'null')); } catch { return; }
  _renderFilter();
  currentPage = 1;
  applyFilters();
});

// The series merge/unmerge display preference lives in Settings (kv-backed → localStorage). React
// live when it changes in another tab (or the Settings page): re-query and re-render the grid.
// Display-only; it never touches grouping metadata.
window.addEventListener('storage', (e) => {
  if (e.key !== 'shiori:libMergeSeries') return;
  const next = e.newValue !== 'false';
  if (next === _mergeSeries) return;
  _mergeSeries = next;
  currentPage = 1;
  applyFilters();
  updateHeaderStats();
});

// Append a search token, re-filter, and only steal focus to the search box if it was already
// active (so a hovered card stays expanded). Shared by tag clicks and the flag chip.
function _addSearchToken(token) {
  const box = document.getElementById('searchBox');
  const wasSearchActive = document.activeElement === box;
  appendSearchToken(token);
  currentPage = 1;
  applyFilters();
  updateClearBtn();
  if (wasSearchActive) box.focus();
}

document.getElementById('grid').addEventListener('click', async (e) => {
  // Language flag → add a language filter to search (treated like a tag); Shift+click deletes the
  // gallery's matching language tag(s), like Shift+click on any other tag.
  const flagChip = e.target.closest('.card-tag-flag');
  if (flagChip) {
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) {
      const gid = flagChip.closest('.card')?.dataset.galleryId;
      const g = gid && _pageItems.find(x => x.id === gid);
      if (!g || !Array.isArray(g.tags)) return;
      const code = flagChip.dataset.langCode;
      const toRemove = g.tags.filter(tg => tg.type === 'language' && LANG_NAME_TO_CODE[String(tg.name).toLowerCase()] === code);
      if (!toRemove.length) return;   // flag came from source metadata / translated copy — no tag to delete
      const label = t('addtag.cat_language');
      const name  = flagChip.dataset.tip || flagChip.dataset.langName || code;
      if (!(await confirmDialog({
        title: t('dlg.tag_title'), body: t('dlg.tag_body'),
        detail: [`${label} · ${name}`, _galleryDetail(g)[0]], cover: _cardCover(flagChip.closest('.card')), ok: t('dlg.tag_ok'), danger: true,
      }))) return;
      store.mutate(gid, tagPatchFor(g, g.tags.filter(tg => !toRemove.includes(tg))));
      return;
    }
    if (flagChip.dataset.langName) _addSearchToken(`language:"${flagChip.dataset.langName}"`);
    return;
  }

  // '+' chip → open the tag editor to add a tag to this card's gallery.
  const addBtn = e.target.closest('.card-tag-add');
  if (addBtn) {
    e.preventDefault(); e.stopPropagation();
    const gid = addBtn.closest('.card')?.dataset.galleryId;
    if (gid) openTagEditor(gid);
    return;
  }

  const tag = e.target.closest('.card-tag');
  if (!tag) return;
  e.preventDefault();
  e.stopPropagation();
  const name  = (tag.dataset.original || tag.textContent).trim();
  const type  = tag.dataset.type;

  // Shift+click → delete this tag from the gallery (with confirmation).
  if (e.shiftKey) {
    const gid = tag.closest('.card')?.dataset.galleryId;
    if (!gid) return;
    const label = t(TAG_TYPE_LABEL[type] || 'addtag.cat_tag');
    const g = _pageItems.find(x => x.id === gid);
    if (!g || !Array.isArray(g.tags)) return;
    if (!(await confirmDialog({
      title: t('dlg.tag_title'), body: t('dlg.tag_body'),
      detail: [`${label} · ${name}`, _galleryDetail(g)[0]], cover: _cardCover(tag.closest('.card')), ok: t('dlg.tag_ok'), danger: true,
    }))) return;
    store.mutate(gid, tagPatchFor(g, g.tags.filter(t => !(t.type === type && t.name === name))));
    return;
  }

  _addSearchToken(type ? `${type}:"${name}"` : name);
});

document.getElementById('settingsBtn').addEventListener('click', () => {
  window.location.href = '../settings';
});

// ── Safe Mode ──

const GIBBERISH_POOL = [
  'xelorp','blathnar','quixum','frobzle','wumble','cranlop','dribnak',
  'snorvel','durple','grixon','zibble','wonkle','frumple','drabix',
  'squibble','grompf','twarble','blintz','clongle','frixum','snargle',
  'wobzle','plinkle','glorble','snortle','grumple','blixon','trixon',
  'yarvok','splumf','crelbix','quznak','throble','wibzor','drangle',
  'snorbel','glumfix','twonkle','brixum','florkel','plorbix','snurgal',
  'wramble','draxon','kribzle','glorpan','snuffwix','blavrok','quorple',
];

function randomGibberish(original) {
  const len = original.length;
  const close = GIBBERISH_POOL.filter(w => Math.abs(w.length - len) <= 2);
  const pool  = close.length > 0 ? close : GIBBERISH_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

let safeMode = localStorage.getItem('shiori-safe-mode') === '1';

function applyGibberishToGrid() {
  document.querySelectorAll('.card-tag[data-original]').forEach(tag => {
    tag.textContent = randomGibberish(tag.dataset.original);
  });
  document.querySelectorAll('.card-title[data-original]').forEach(el => {
    el.textContent = el.dataset.original.split(/\s+/).map(w => randomGibberish(w)).join(' ');
  });
  document.querySelectorAll('.card-id[data-original]').forEach(el => {
    el.textContent = el.dataset.original.replace(/\d/g, () => Math.floor(Math.random() * 10));
    // The id can be a link to the real source URL — park the href so hover/status-bar/devtools
    // don't reveal it while safe mode is on.
    if (el.hasAttribute('href')) { el.dataset.safeHref = el.getAttribute('href'); el.removeAttribute('href'); }
  });
}

function restoreTagsInGrid() {
  document.querySelectorAll('.card-tag[data-original]').forEach(tag => {
    tag.textContent = tag.dataset.original;
  });
  document.querySelectorAll('.card-title[data-original]').forEach(el => {
    el.textContent = el.dataset.original;
  });
  document.querySelectorAll('.card-id[data-original]').forEach(el => {
    el.textContent = el.dataset.original;
    if (el.dataset.safeHref) { el.setAttribute('href', el.dataset.safeHref); delete el.dataset.safeHref; }
  });
}

function setSafeMode(enabled) {
  safeMode = enabled;
  localStorage.setItem('shiori-safe-mode', enabled ? '1' : '0');
  document.body.classList.toggle('safe-mode', enabled);
  const btn = document.getElementById('safeBtn');
  if (enabled) {
    btn.classList.add('active');
    btn.dataset.tip = t('nav.safe_off');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    applyGibberishToGrid();
  } else {
    btn.classList.remove('active');
    btn.dataset.tip = t('nav.safe_on');
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    restoreTagsInGrid();
  }
}

document.getElementById('safeBtn').addEventListener('click', () => setSafeMode(!safeMode));

// ── Header pin toggle ──
const PIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';
const UNPIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h12"/><path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89"/></svg>';

(function () {
  const pinBtn = document.getElementById('pinBtn');
  const header = document.querySelector('header');
  let pinned = localStorage.getItem('shiori-header-pin') !== '0';

  function applyPin(p) {
    pinned = p;
    header.style.position = p ? 'sticky' : 'relative';
    pinBtn.dataset.tip = p ? t('nav.unpin') : t('nav.pin');
    pinBtn.innerHTML = p ? PIN_SVG : UNPIN_SVG;
    localStorage.setItem('shiori-header-pin', p ? '1' : '0');
  }

  applyPin(pinned);
  pinBtn.addEventListener('click', () => applyPin(!pinned));
}());

const burgerBtn = document.getElementById('burgerBtn');
const collapsibleGroup = document.getElementById('collapsibleGroup');
burgerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  collapsibleGroup.classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#collapsibleGroup') && !e.target.closest('#burgerBtn'))
    collapsibleGroup.classList.remove('open');
});

// ── Reactive gallery updates (single source of truth) ──
// Any durable change to a gallery — browse-capture (via the agent), download, translate, source
// edit, delete, import — is announced through the store change feed. We patch the current page
// in place (or reload it when membership/order changes), so the view stays live and in lockstep
// with the DB, across tabs and contexts, without ever loading the whole library.
store.subscribe('*', (gid) => {
  const entity = store.get(gid);
  _scheduleHeaderStats();
  const idx = _pageItems.findIndex(g => g.id === gid);

  if (!entity) {
    // Gallery removed — drop it from the page and reload to backfill the freed slot.
    if (idx >= 0) { _pageItems.splice(idx, 1); if (!_liveJobs.has(gid)) _scheduleReloadPage(); }
    return;
  }

  // Honour an in-flight optimistic source edit until the DB reflects it.
  const pending = _pendingSourceChanges.get(gid);
  if (pending) {
    if (entity.source === pending.source) _pendingSourceChanges.delete(gid);
    else {
      entity.source = pending.source;
      if (pending.sourceId != null) entity.sourceId = pending.sourceId;
      if (pending.sourceUrl) entity.sourceUrl = pending.sourceUrl;
    }
  }

  // Keep the on-screen page model current even while a job is in flight, so the card shows
  // the right data once the job clears.
  if (idx >= 0) _pageItems[idx] = entity;

  const card = document.querySelector(`.card[data-gallery-id="${gid}"]`);
  if (_liveJobs.has(gid) || _interrupted.has(gid)) {
    // A job owns an existing card's progress bar / interrupted hint — don't rebuild it (that
    // would reset the bar or wipe the hint). A brand-new gallery mid-job (e.g. an import) has
    // no card yet, so reload the page.
    if (!card) _scheduleReloadPage();
    return;
  }
  if (idx >= 0 && card) _rebuildCard(card, gid);
  // A new gallery may belong on this page — but a chapter never has a card of its own in the
  // merged view (its series card hears about its own changes).
  else if (idx < 0 && !(_mergeSeries && entity.parentId)) _scheduleReloadPage();
});

// Rebuilding a card the pointer is over restarts its expand-on-hover, so a hovered card is rebuilt
// once the pointer leaves — from the latest data, however many changes arrived meanwhile.
function _rebuildCard(card, gid) {
  if (card.matches(':hover')) {
    if (!card._rebuildPending) {
      card._rebuildPending = true;
      card.addEventListener('mouseleave', () => {
        card._rebuildPending = false;   // still hovered (a child's leave)? the next call re-arms
        const entity = _pageItems.find(g => g.id === gid);
        if (entity && card.isConnected && !_liveJobs.has(gid) && !_interrupted.has(gid)) _rebuildCard(card, gid);
      }, { once: true });
    }
    return;
  }
  const entity = _pageItems.find(g => g.id === gid);
  if (!entity) return;
  card.replaceWith(buildCard(entity));
  fetchPageCovers([entity]);
}

if (safeMode) setSafeMode(true);

// Collapsing card stays above resting cards; actively hovered card beats any collapsing card
// that is below it, but yields to a collapsing card that is above it (still retracting).
(function () {
  const grid = document.getElementById('grid');
  const cardOf = el => el?.closest('.card');

  grid.addEventListener('mouseout', (e) => {
    const from = cardOf(e.target), to = cardOf(e.relatedTarget);
    if (!from || from === to) return;
    const goingForward = to && !!(from.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING);
    from.style.zIndex = goingForward ? '20' : '10';
    clearTimeout(from._zt);
    from._zt = setTimeout(() => { from.style.zIndex = ''; }, 250);
  });

  grid.addEventListener('mouseover', (e) => {
    const from = cardOf(e.relatedTarget), to = cardOf(e.target);
    if (!to || from === to) return;
    clearTimeout(to._zt);
    to.style.zIndex = '';
  });
}());

// Intercept F5 / Ctrl+R and do an in-place data refresh instead of a full page
// reload — eliminates the GPU compositor black frame that appears during navigation.
document.addEventListener('keydown', (e) => {
  const isReload = e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r' && !e.shiftKey);
  if (isReload) { e.preventDefault(); _bumpLoadCount(); loadAll(); return; }
}, true);

// ── W/S continuous scroll (no key-repeat delay) ──
// A rAF loop scrolls the window the instant a key goes down, skipping the OS auto-repeat
// pause. A/D and arrows still flip library pages.
const SCROLL_SPEED = 22; // px per frame at full speed; the base rate is half this — Shift doubles it
const _scrollHeld = new Set();
let _scrollRaf = null;
let _scrollFast = false;  // Shift held → scroll at SCROLL_SPEED; otherwise at half (the default)
function _scrollLoop() {
  let dir = 0;
  if (_scrollHeld.has('down')) dir += 1;
  if (_scrollHeld.has('up'))   dir -= 1;
  if (dir === 0) { _scrollRaf = null; return; }
  window.scrollBy(0, dir * (_scrollFast ? SCROLL_SPEED : SCROLL_SPEED / 2));
  _scrollRaf = requestAnimationFrame(_scrollLoop);
}
function _pressScroll(dir) {
  if (_scrollHeld.has(dir)) return;
  _scrollHeld.add(dir);
  if (!_scrollRaf) _scrollRaf = requestAnimationFrame(_scrollLoop);
}
const _stopScroll = () => _scrollHeld.clear();
document.addEventListener('keyup', (e) => {
  _scrollFast = e.shiftKey;   // releasing Shift drops back to the half-speed default, live
  if (e.key === 'w' || e.key === 'W') _scrollHeld.delete('up');
  if (e.key === 's' || e.key === 'S') _scrollHeld.delete('down');
});
window.addEventListener('blur', () => { _stopScroll(); _scrollFast = false; });

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  _scrollFast = e.shiftKey;   // Shift held → double the scroll speed, live (even mid-hold)

  // W / S → continuous scroll; Shift doubles the speed.
  if (e.key === 'w' || e.key === 'W') {
    e.preventDefault();
    _pressScroll('up');
    return;
  }
  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    _pressScroll('down');
    return;
  }

  const fwd = e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D';
  const bck = e.key === 'ArrowLeft'  || e.key === 'a' || e.key === 'A';
  if (!fwd && !bck) return;
  e.preventDefault();
  const totalPages = Math.max(1, Math.ceil(_total / PAGE_SIZE));
  const next = e.shiftKey
    ? (fwd ? totalPages : 1)
    : Math.max(1, Math.min(totalPages, currentPage + (fwd ? 1 : -1)));
  if (next === currentPage) return;
  currentPage = next;
  applyFilters();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ── Translation server status ───────────────────────────────────────────────
// Hide the per-card Translate action when the local translator server is unreachable.
// Assume offline until a ping proves otherwise, so the button never flashes in then vanishes.
function updateTranslatorStatus() {
  sendMsg({ type: 'TRANSLATOR_PING' }).then(resp => {
    document.body.classList.toggle('translator-offline', !(resp && resp.online));
  });
}
document.body.classList.add('translator-offline');
updateTranslatorStatus();
setInterval(updateTranslatorStatus, 20000);
setInterval(updateExtStatus, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateTranslatorStatus(); updateExtStatus(); } });

// Downloads start hidden (safe default); the first successful bridge ping re-renders them in.
// The bridge content script injects at document_idle, so probe a few times quickly at startup
// instead of waiting for the slow poll.
updateExtStatus();
setTimeout(updateExtStatus, 800);
setTimeout(updateExtStatus, 2500);
setTimeout(updateExtStatus, 6500);   // first probe past the grace window — reconciles a stale cached "available"

// Language changed (in this or another tab) — re-render so the per-card language flags update.
window.addEventListener('shiori-lang-change', () => applyFilters());

initFromUrl();
_renderFilter();

// Read the "skip chapter overview" preference before the first paint so series cards route right.
platform.kv.get(['readerSkipOverview']).then(r => {
  const next = !!r.readerSkipOverview;
  if (next !== _bypassOverview) { _bypassOverview = next; applyFilters(); }
});

// Read the app-language-flag preference; re-render if it differs from the default so cards show the
// right set of flags.
platform.kv.get(['libHideAppLangFlag']).then(r => {
  const next = r.libHideAppLangFlag !== false;   // default: hide
  if (next !== _hideAppLangFlag) { _hideAppLangFlag = next; applyFilters(); }
});

// Read the gallery card quick-actions preference. The buttons stay in the DOM so active job UI
// keeps working; CSS owns whether the row is visible, hover-only or hidden.
platform.kv.get(['libQuickActionsMode']).then(r => applyQuickActionsMode(r.libQuickActionsMode));
window.addEventListener('storage', (e) => {
  if (e.key !== 'shiori:libQuickActionsMode') return;
  try { applyQuickActionsMode(JSON.parse(e.newValue || 'null')); }
  catch { applyQuickActionsMode(_DEFAULT_QUICK_ACTIONS_MODE); }
});
window.addEventListener('storage', (e) => {
  if (e.key?.startsWith('shiori:') && e.key.slice(7) in _DETAIL_CLASS) applyDetailPrefs();
});

// Windowed load: one page from the DB (covers come from the sessionStorage cache, so the
// grid still paints fast).
_sourceIconsReady.finally(() => loadAll());

// library.js — the library UI: windowed grid over the database, live job progress, uploads,
// per-gallery actions. Imports boot.js first so services + the PWA worker are wired.

import './boot.js';
import { openDB, metaPut, getStats, getGalleriesByIds, galleriesCount, coverGet, sourceIconGet, sourceIconPut, sourceIconsAll, _LANG_NAME_TO_CODE } from './db.js';
import { importBackup } from './backup.js';
import { mergeIntoSeries } from './series.js';
import { request as extRequest, available as extAvailable } from './ext-bridge.js';
import * as store from './store.js';
import * as platform from './platform.js';
import { t, getLang } from './i18n.js';
import { pickTitle, pickSeriesTitle, migrateTitle } from './titles.js';
import { initTooltips, refreshTooltip } from './tooltip.js';
import { formatBytes, formatCount } from './format.js';

// Whether a series card opens straight into the reader (chapter 1) instead of the overview page.
// Loaded from settings at boot; the card routing reads it synchronously.
let _bypassOverview = false;

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

// ── Source sites — learned at runtime, never hard-coded ─────────────────────────────────────
// The app is site-agnostic. What sites exist, whether they support downloads, and how their
// gallery links look is the extension's knowledge; it hands over a map at runtime (EXT_SITES).
// Without the extension the app still links to whatever exact sourceUrl a gallery carries.
let _siteMap = {};

const _siteName = (source) => (_siteMap[source]?.name) || source || '';

const _sourceIconCache = new Map();
const _sourceIconPending = new Set();
const _sourceIconLoading = new Set();
const _sourceIconAttempted = new Set();   // one extension fetch per source per session

async function hydrateSourceIcons() {
  try {
    for (const rec of await sourceIconsAll()) {
      if (rec?.source && /^data:image\//i.test(rec.dataUrl || '')) _sourceIconCache.set(String(rec.source), rec);
    }
  } catch {}
}

function _siteIconCandidate(source) {
  const site = _siteMap[source] || {};
  const direct = String(site.favicon || '');
  if (/^https?:\/\//i.test(direct)) return { url: direct, fromRegistry: true };
  const hintedDomain = String(site.faviconDomain || '').trim();
  if (hintedDomain) return { url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hintedDomain)}&sz=16`, fromRegistry: true };
  const domain = String(source || '').trim();
  if (!domain) return { url: '', fromRegistry: false };
  return { url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=16`, fromRegistry: false };
}

function _cachedSourceIcon(source, candidate) {
  const cached = _sourceIconCache.get(String(source || ''));
  if (!cached || !/^data:image\//i.test(cached.dataUrl || '')) return '';
  if (candidate?.fromRegistry && candidate.url && cached.url && cached.url !== candidate.url) return '';
  return cached.dataUrl;
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

function _loadSourceIcon(source, candidate) {
  const key = String(source || '');
  if (!key || _sourceIconCache.has(key) || _sourceIconLoading.has(key)) return;
  _sourceIconLoading.add(key);
  sourceIconGet(key)
    .then((rec) => {
      if (!rec || !/^data:image\//i.test(rec.dataUrl || '')) return;
      if (candidate?.fromRegistry && candidate.url && rec.url && rec.url !== candidate.url) return;
      _sourceIconCache.set(key, rec);
      _replaceRenderedSourceIcons(key, rec.dataUrl);
    })
    .finally(() => { _sourceIconLoading.delete(key); });
}

function _cacheSourceIcon(source, candidate) {
  const key = String(source || '');
  if (!_extAvailable || !key || !candidate || _sourceIconPending.has(key) || _sourceIconAttempted.has(key)) return;
  _sourceIconPending.add(key);
  _sourceIconAttempted.add(key);
  extRequest({ type: 'EXT_FETCH_ICON', source: key, url: candidate }, 15000)
    .then((r) => {
      if (r == null) { _sourceIconAttempted.delete(key); return; }   // unanswered → retry later
      if (!r.ok || !/^data:image\//i.test(r.dataUrl || '')) return;
      const rec = { source: key, url: candidate, dataUrl: r.dataUrl, cachedAt: Date.now() };
      _sourceIconCache.set(key, rec);
      sourceIconPut(key, rec).catch(() => {});
      _replaceRenderedSourceIcons(key, r.dataUrl);
    })
    .finally(() => { _sourceIconPending.delete(key); });
}

function _warmSourceIconCache() {
  for (const source of Object.keys(_siteMap || {})) {
    const candidate = _siteIconCandidate(source);
    if (candidate.url && !_cachedSourceIcon(source, candidate)) _cacheSourceIcon(source, candidate.url);
  }
}

const _siteFavicon = (source) => {
  const candidate = _siteIconCandidate(source);
  const cached = _cachedSourceIcon(source, candidate);
  if (!cached) _loadSourceIcon(source, candidate);
  if (candidate.url && !cached) _cacheSourceIcon(source, candidate.url);
  return cached;
};
const _sourceIconsReady = hydrateSourceIcons();

// The visit link for a gallery: the exact URL it was registered with, or the site's link
// template (runtime data from the extension) filled with its source id.
function galleryLink(g, page = 1) {
  if (g.sourceUrl) return g.sourceUrl;
  const t = _siteMap[g.source]?.galleryUrl;
  if (t && (g.sourceId || g.id)) return t.replace('{id}', g.sourceId || g.id).replace('{page}', page);
  return '';
}

// Parse user input (URL or hostname) into { source, sourceId, sourceUrl }. The extension parses
// it properly when present; otherwise fall back to generic URL parsing (host + verbatim URL).
async function parseSourceInput(input) {
  if (_extAvailable) {
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

function sendMsg(msg) {
  return platform.rpc(msg);
}

// ── Extension availability ──
// Downloading (and source-site metadata) needs the extension. When its bridge isn't answering
// on this page, the download action is not offered at all — the button falls back to its
// upload/replace role, exactly like a gallery from a non-downloadable source.
let _extAvailable = false;
const _canDownload = (g) => _siteMap[g.source]?.canDownload === true && _extAvailable;

// Seed from the last confirmed probe so the very first render already shows the right
// download/upload icons — without this every load flickered upload→download once the
// bridge (injected at document_idle, so always after first paint) finally answered.
try {
  const s = JSON.parse(localStorage.getItem('shiori-ext-status') || 'null');
  if (s) {
    _extAvailable = !!s.available;
    _siteMap = s.sites || {};
    document.body.classList.toggle('extension-offline', !_extAvailable);
  }
} catch {}

let _sitesRefreshed = false;   // EXT_SITES re-fetched once per page life
const _extLoadAt = Date.now();
async function updateExtStatus() {
  const ok = await extAvailable();
  // An early failed probe is inconclusive: the bridge injects at document_idle, so right
  // after load "no answer" usually means "not ready yet", not "not installed". Keep the
  // cached optimistic state until a probe past the grace window confirms it's really gone.
  if (!ok && _extAvailable && Date.now() - _extLoadAt < 6000) return;
  let sitesChanged = false;
  if (ok && !_sitesRefreshed) {
    const r = await extRequest({ type: 'EXT_SITES' });
    if (r && r.sites) {
      _sitesRefreshed = true;
      sitesChanged = JSON.stringify(r.sites) !== JSON.stringify(_siteMap);
      _siteMap = r.sites;
    }
  }
  if (ok === _extAvailable && !sitesChanged) {
    if (ok) _warmSourceIconCache();
    return;
  }
  _extAvailable = ok;
  try { localStorage.setItem('shiori-ext-status', JSON.stringify({ available: ok, sites: _siteMap })); } catch {}
  document.body.classList.toggle('extension-offline', !ok);
  if (ok) _warmSourceIconCache();
  applyFilters();   // re-render so download buttons appear/disappear
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
const _coverCache = new Map(); // galleryId → resized cover data URL

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
    for (const [id, dataUrl] of Object.entries(JSON.parse(raw))) {
      _coverCache.set(id, dataUrl);
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
      const toSave  = Object.fromEntries([..._coverCache].filter(([id]) => pageIds.has(id)));
      sessionStorage.setItem('shiori-covers', JSON.stringify(toSave));
    } catch {}
  }, 800);
}

let currentPage  = 1;
const PAGE_SIZE  = 30;
const _pendingSourceChanges = new Map(); // galleryId → {source, sourceId} while SET_SOURCE is in-flight

function syncUrl() {
  const params = new URLSearchParams();
  if (currentPage > 1) params.set('page', currentPage);
  const q = document.getElementById('searchBox').value.trim();
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
  if (q) document.getElementById('searchBox').value = q;
  const sort = params.get('sort');
  if (sort) document.getElementById('sortSelect').value = sort;
}

// ── Card rendering ──

// Language code → country flag (SVG file saved under app/flags/) + display name, for the
// leading card flag chip. Covers every translator target language and common source languages.
const _LANG_FLAG = {
  en: 'GB', ja: 'JP', zh: 'CN', 'zh-CN': 'CN', 'zh-TW': 'TW', ko: 'KR', de: 'DE', fr: 'FR',
  es: 'ES', ru: 'RU', pt: 'PT', 'pt-BR': 'BR', it: 'IT', vi: 'VN', id: 'ID', th: 'TH',
  nl: 'NL', pl: 'PL', uk: 'UA',
};
const _LANG_DISPLAY = {
  en: 'English', ja: '日本語', zh: '中文（简体）', 'zh-CN': '中文（简体）', 'zh-TW': '中文（繁體）',
  ko: '한국어', de: 'Deutsch', fr: 'Français', es: 'Español', ru: 'Русский', pt: 'Português',
  'pt-BR': 'Português (BR)', it: 'Italiano', vi: 'Tiếng Việt', id: 'Bahasa Indonesia',
  th: 'ไทย', nl: 'Nederlands', pl: 'Polski', uk: 'Українська',
};
// Language code → the lowercase English name galleries are tagged with, for the flag's search filter.
const _LANG_SEARCH = {
  en: 'english', ja: 'japanese', zh: 'chinese', 'zh-TW': 'chinese', ko: 'korean', de: 'german',
  fr: 'french', es: 'spanish', ru: 'russian', pt: 'portuguese', 'pt-BR': 'portuguese', it: 'italian',
  vi: 'vietnamese', id: 'indonesian', th: 'thai', nl: 'dutch', pl: 'polish', uk: 'ukrainian',
};
// The app language as a base code (zh-CN → zh) — the flag for a gallery in this language is hidden.
const _langBase = (code) => String(code || '').split('-')[0];
// Language name shown in the app's current language (e.g. JP flag → "Japanese" in English).
let _dnInst = null, _dnLang = null;
function _langDisplayName(code) {
  const lang = getLang();
  try {
    if (_dnLang !== lang) { _dnInst = new Intl.DisplayNames([lang], { type: 'language' }); _dnLang = lang; }
    return _dnInst.of(code) || _LANG_DISPLAY[code] || code;
  } catch { return _LANG_DISPLAY[code] || code; }
}

// Languages a gallery can be tagged with — the ones Shiori has a flag for. `value` is the
// lowercase English name stored on the tag (what the flag derivation understands); `code` drives
// the localized label. De-duplicated by name (zh / zh-TW both map to "chinese").
const _LANG_TAG_OPTIONS = (() => {
  const seen = new Set(); const out = [];
  for (const [code, name] of Object.entries(_LANG_SEARCH)) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ code, name });
  }
  return out;
})();

function buildCardTags(tags, languages) {
  const list = Array.isArray(tags) ? tags : [];
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
    chips.push(`<span class="card-tag-flag" data-lang-code="${escHtml(code)}" data-lang-name="${escHtml(_LANG_SEARCH[code] || code)}" data-tip="${escHtml(_langDisplayName(code))}"><img class="flag-img" src="flags/${_LANG_FLAG[code]}.svg" alt="${escHtml(code)}" loading="lazy"></span>`);
  }
  chips.push(
    ...artists.map(t => `<span class="card-tag artist" data-type="artist" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...regular.map(t => `<span class="card-tag" data-type="tag" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...female.map(t => `<span class="card-tag" data-type="tag:female" data-original="${escHtml(t.name)}">${escHtml(t.name)} ♀</span>`),
    ...male.map(t => `<span class="card-tag" data-type="tag:male" data-original="${escHtml(t.name)}">${escHtml(t.name)} ♂</span>`),
  );
  // Trailing '+' chip — opens the add-metadata modal (shown only while the card is hovered).
  chips.push(`<span class="card-tag card-tag-add" data-tip="${t('card.tip_addtag')}">+</span>`);
  return `<div class="card-tags">${chips.join('')}</div>`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateCardThumbFit(img) {
  if (!img?.naturalWidth || !img?.naturalHeight) return;
  img.classList.toggle('landscape', img.naturalWidth >= img.naturalHeight);
}

function wireCardThumbFit(img) {
  if (!img) return;
  img.addEventListener('load', () => updateCardThumbFit(img));
  if (img.complete) updateCardThumbFit(img);
}

// Tag-category → i18n key, for the add/remove-tag flows.
const _TAG_CAT_KEY = {
  'tag': 'addtag.cat_tag', 'tag:female': 'addtag.cat_tagf', 'tag:male': 'addtag.cat_tagm',
  'artist': 'addtag.cat_artist', 'group': 'addtag.cat_group', 'parody': 'addtag.cat_parody',
  'character': 'addtag.cat_character', 'language': 'addtag.cat_language',
};

const _tagPatchFor = (g, tags) => g?.isSeries ? { seriesTags: tags } : { tags };

function buildCard(g) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.galleryId = g.id;

  const thumbSrc = _coverCache.get(g.id) || null;
  const hasThumb = g.isSeries ? ((g.aggPages || g.count || 0) > 0 || !!thumbSrc) : (g.count > 0 || !!thumbSrc);
  // draggable="false" on the cover + link so grabbing the thumbnail starts the CARD's merge-drag
  // (below), not a native image/link drag — the native image drag exposes a 'Files' type that was
  // wrongly triggering the file-import overlay.
  const thumbInner = hasThumb
    ? `<img class="card-thumb" draggable="false"${thumbSrc ? ` src="${thumbSrc}"` : ''} alt="">`
    : `<div class="card-thumb-placeholder">📁</div>`;

  const displayTitle = g.isSeries ? pickSeriesTitle(g.seriesTitle, g, getLang()) : pickTitle(g, getLang());
  const titleHtml = displayTitle
    ? `<div class="card-title" data-original="${escHtml(displayTitle)}">${escHtml(displayTitle)}</div>`
    : '';

  const cachedCount = g.count;
  const totalCount = g.numPages ? ` / ${formatCount(g.numPages)}` : '';
  // A series card shows the whole-series aggregate (stored on the owner) and a chapter badge; a
  // standalone gallery shows its own page count. Series open the overview unless the user bypasses.
  const metaLine = g.isSeries
    ? `${formatCount(g.aggPages)} ${t('card.pages')} · ${formatBytes(g.aggSize)}`
    : `${formatCount(cachedCount)}${totalCount} ${t('card.pages')} · ${formatBytes(g.size)}`;
  const seriesBadge = g.isSeries ? `<span class="card-series-badge">${t('card.chapters_n', { n: formatCount(g.chapterCount) })}</span>` : '';
  // Every gallery gets an overview landing page (a standalone one can gain chapters there); the
  // "skip overview" setting sends cards straight into the reader instead.
  const cardHref = _bypassOverview ? `../reader?g=${g.id}` : `../overview?g=${g.id}`;

  const tagHtml = buildCardTags(g.tags, g.languages);

  const canDownload  = _canDownload(g);
  const visitUrl     = galleryLink(g, 1);
  const siteName     = _siteName(g.source);
  const openTitle    = visitUrl ? `${siteName}: ${visitUrl}` : t('card.tip_setsource');
  const dlTitle      = g.numPages ? t('card.tip_dl', { n: formatCount(g.numPages) }) : t('card.tip_dl_meta');
  const idText       = escHtml(g.sourceId || g.id);
  const idClass      = `card-id${g.isLocalImport ? ' local' : ''}`;
  const idHtml       = g.sourceUrl
    ? `<a class="${idClass}" href="${escHtml(g.sourceUrl)}" target="_blank" rel="noopener noreferrer" data-original="${idText}">${idText}</a>`
    : `<div class="${idClass}" data-original="${idText}">${idText}</div>`;

  const openBtnHtml = `
      <button class="card-btn card-btn-open" data-id="${g.id}" data-tip="${escHtml(openTitle)}"${visitUrl ? ` data-tip-shift="${t('card.tip_editsource')}"` : ''}><span class="open-inner">${_makeOpenBtnInner(g.source)}</span></button>`;

  const actionsHtml = `
    <div class="card-actions">
      <button class="card-btn card-btn-dl" data-id="${g.id}" data-tip="${canDownload ? dlTitle : t('card.tip_replace')}" ${canDownload ? `data-tip-shift="${t('card.tip_replace')}"` : ''}>${canDownload ? _DL_ICON : _UPLOAD_ICON}</button>
      <button class="card-btn card-btn-translate${g.translated ? ' done' : ''}" data-id="${g.id}" data-tip="${g.translated ? t('card.tip_translate_new') : t('card.tip_translate')}"${g.translated ? ` data-tip-shift="${t('card.tip_revert')}"` : ''}>${_TRANSLATE_ICON}</button>
      <button class="card-btn card-btn-export" data-id="${g.id}" data-tip="${t('card.tip_export')}" data-tip-shift="${t('card.tip_export_meta')}">${_EXPORT_ICON}</button>
      <button class="card-btn card-btn-del" data-id="${g.id}" data-tip="${t('card.tip_delete')}" data-tip-shift="${t('card.tip_quickdelete')}">${_DELETE_ICON}</button>
    </div>`;

  card.innerHTML = `
    <div class="card-thumb-spacer"></div>
    <div class="card-body-spacer"></div>
    <div class="card-hover-overlay">
      <a class="card-thumb-wrap" href="${cardHref}" draggable="false">
        ${thumbInner}
        ${seriesBadge}
      </a>
      <div class="card-body">
        <div class="card-id-row">
          ${openBtnHtml}
          ${idHtml}
          ${actionsHtml}
        </div>
        ${titleHtml}
        <div class="card-meta">${metaLine}</div>
        <div class="card-progress" id="prog-${g.id}">
          <div class="card-prog-track"><div class="card-prog-fill" id="progfill-${g.id}"></div></div>
          <span class="card-prog-label" id="proglabel-${g.id}"></span>
        </div>
        ${tagHtml}
      </div>
    </div>
  `;

  wireCardThumbFit(card.querySelector('img.card-thumb'));

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
      // Deleting a series removes every chapter (its child galleries never get their own card).
      if (g.isSeries) {
        if (!e.shiftKey && !confirm(t('confirm.delete_series', { n: formatCount(g.chapterCount) }))) return;
        const ids = (g.chapters || [{ id: g.id }]).map(c => c.id);
        for (const id of ids) await sendMsg({ type: 'DELETE_GALLERY', galleryId: id });
        applyFilters();
        updateHeaderStats();
        return;
      }
      if (!e.shiftKey && !confirm(t('confirm.delete_gallery', { id: g.id }))) return;
      await sendMsg({ type: 'DELETE_GALLERY', galleryId: g.id });
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
        else            await exportGalleryZip(g.id);
      } catch (err) {
        alert(t('alert.export_failed', { msg: err.message }));
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

      // A series downloads each of its chapters: fetch every chapter that isn't already complete
      // (n/n pages), skipping the finished ones. If they're ALL complete, offer to re-download the
      // whole series, overwriting every cached image. Each chapter is its own gallery-scoped job.
      if (g.isSeries) {
        const entities = await getGalleriesByIds((g.chapters || []).map(c => c.id));
        const dlable = entities.filter(x => x && _canDownload(x));
        if (!dlable.length) return;
        const isComplete = (x) => x.numPages > 0 && x.count >= x.numPages;
        let targets = dlable.filter(x => !isComplete(x));
        let overwrite = false;
        if (!targets.length) {
          if (!confirm(t('confirm.redownload_series'))) return;
          targets = dlable;
          overwrite = true;
        }
        for (const x of targets) await sendMsg({ type: 'CACHE_ALL_PAGES', galleryId: x.id, source: x.source, overwrite });
        return;
      }

      const btns = card.querySelectorAll('.card-btn-dl');
      if ([...btns].some(x => x.disabled)) return;

      const alreadyComplete = g.numPages > 0 && g.count >= g.numPages;
      if (alreadyComplete && !confirm(t('confirm.redownload', { n: formatCount(g.numPages) }))) return;

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

      // A series translates one chapter per press → open the chapter picker (defaults to the
      // lowest untranslated chapter). Each chapter is its own gallery-scoped translate job.
      if (g.isSeries) { openSeriesTranslateModal(g); return; }

      const btns = card.querySelectorAll('.card-btn-translate');
      if ([...btns].some(x => x.disabled)) return;

      // Shift+click on an already-translated gallery → revert to the originals.
      if (e.shiftKey && g.translated) {
        if (!confirm(t('confirm.revert', { id: g.sourceId || g.id }))) return;
        btns.forEach(x => x.disabled = true);
        await sendMsg({ type: 'REVERT_GALLERY', galleryId: g.id });
        g.translated = false;
        const liveEntry = _pageItems.find(x => x.id === g.id);
        if (liveEntry) liveEntry.translated = false;
        const $card = document.querySelector(`.card[data-gallery-id="${g.id}"]`);
        if ($card) $card.replaceWith(buildCard(liveEntry || g));
        return;
      }

      if (g.count === 0) { alert(t('alert.no_pages_translate')); return; }

      if (!g.translated && !confirm(t('confirm.translate', { n: formatCount(g.count), id: g.sourceId || g.id }))) return;

      btns.forEach(x => x.disabled = true);
      const progEl  = document.getElementById(`prog-${g.id}`);
      const labelEl = document.getElementById(`proglabel-${g.id}`);
      if (progEl) progEl.closest('.card-body').classList.add('downloading');
      if (labelEl) labelEl.textContent = t('prog.translating');

      await sendMsg({ type: 'TRANSLATE_GALLERY', galleryId: g.id });
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
      const input = autoApply ? prefill : prompt(t('prompt.source_url'), prefill);
      if (input === null) return;

      const parsed = await parseSourceInput(input);

      // Register before the await so any reload that fires during the round-trip
      // knows this source change is in flight and uses this value, not stale DB.
      _pendingSourceChanges.set(g.id, parsed);

      const resp = await sendMsg({
        type: 'SET_SOURCE', galleryId: g.id, source: parsed.source,
        ...(parsed.sourceId ? { sourceId: parsed.sourceId } : {}),
        ...(parsed.sourceUrl ? { sourceUrl: parsed.sourceUrl } : {}),
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
      window.open(curVisitUrl, '_blank');
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
  if (!confirm(t('confirm.merge', { source: sourceId, target: targetId }))) return;
  try {
    await mergeIntoSeries(targetId, sourceId);
  } catch (err) {
    alert(t('alert.merge_failed', { msg: err.message }));
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
  const entities = await getGalleriesByIds(chapters.map(c => c.id));
  let defaultIdx = entities.findIndex(e => e && !e.translated);
  if (defaultIdx < 0) defaultIdx = 0;

  const opts = chapters.map((c, i) => {
    const e = entities[i];
    const nm = c.title || pickTitle(e, getLang()) || '';
    const flag = e?.translated ? ` · ${t('ov.translated')}` : '';
    return `<option value="${escHtml(c.id)}" ${i === defaultIdx ? 'selected' : ''}>${escHtml(t('ov.chapter_n', { n: i + 1 }))}${nm ? ' — ' + escHtml(nm) : ''}${flag}</option>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `<div class="modal-box">
    <div class="modal-title">${escHtml(t('sertr.title'))}</div>
    <div class="modal-label" style="margin-bottom:10px">${escHtml(t('sertr.desc'))}</div>
    <select class="modal-select" id="_serTrSel">${opts}</select>
    <div class="modal-actions">
      <button class="modal-btn-cancel" id="_serTrCancel">${escHtml(t('common.cancel'))}</button>
      <button class="modal-btn-confirm" id="_serTrGo">${escHtml(t('sertr.go'))}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
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
    if (_coverCache.has(g.id)) continue;
    // An empty gallery's cover comes from the source site — only possible via the extension.
    // A series may hold a stored cover even when its owner chapter has no pages of its own.
    if (g.count > 0 || (g.isSeries && (g.aggPages || 0) > 0) || (g.count === 0 && _canDownload(g))) {
      sendMsg({ type: 'GET_COVER', galleryId: g.id, source: g.source, thumbWidth: _thumbWidth, page: 'library', preferSeries: !!g.isSeries });
    }
  }
}

// ── Cover pushes from services (in-tab) and other contexts (BroadcastChannel) ──

platform.onControl((msg) => {
  if (msg.type === 'COVER_INVALIDATED') {
    _coverCache.delete(msg.galleryId);
    const gEntry = _pageItems.find(g => g.id === msg.galleryId);
    if (gEntry) sendMsg({ type: 'GET_COVER', galleryId: msg.galleryId, source: gEntry.source, thumbWidth: _thumbWidth, page: 'library', preferSeries: !!gEntry.isSeries });
    return;
  }
  if (msg.type === 'COVER_READY') {
    if (msg.page !== 'library') return;
    const gEntry = _pageItems.find(g => g.id === msg.galleryId);
    if (!gEntry) return;
    if (msg.coverDataUrl) {
      _coverCache.set(msg.galleryId, msg.coverDataUrl);
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
        if (entity) { gEntry.count = entity.count; gEntry.size = entity.size; }
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
// shows a stop icon, click cancels). Toggling also parks the shift-revert affordance so it
// doesn't fight the stop state.
function _setTrCancelMode(btn, on) {
  if (!btn) return;
  if (on) {
    if (btn.classList.contains('cancelling')) return;
    btn.classList.add('cancelling');
    btn.disabled = false;
    if (btn.dataset.tipShift != null) { btn._tipShiftStash = btn.dataset.tipShift; delete btn.dataset.tipShift; }
    btn.dataset.tip = t('card.tip_cancel');
    _trFlip.snap(btn, _STOP_SVG);
  } else {
    if (!btn.classList.contains('cancelling')) return;
    btn.classList.remove('cancelling');
    if (btn._tipShiftStash != null) { btn.dataset.tipShift = btn._tipShiftStash; delete btn._tipShiftStash; }
    btn.dataset.tip = btn.classList.contains('done') ? t('card.tip_translate_new') : t('card.tip_translate');
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

  if (status === 'done' || status === 'error' || status === 'cancelled') _liveJobs.delete(gid);
  else _liveJobs.set(gid, job);
  if (status !== 'done') _jobDoneHandled.delete(gid);

  const card    = document.querySelector(`.card[data-gallery-id="${gid}"]`);
  if (!card) {
    // A brand-new gallery mid-job (a download/upload started elsewhere) has no card yet — reveal it.
    // Translate runs on an EXISTING gallery, so if its card isn't in the current view there's
    // nothing to reveal; reloading on every progress frame would thrash the visible cards'
    // hover animations. Only reload for kinds that can introduce a new card.
    if (kind !== 'translate' && status !== 'done' && status !== 'error') _scheduleReloadPage();
    return;
  }
  const fillEl  = document.getElementById(`progfill-${gid}`);
  const labelEl = document.getElementById(`proglabel-${gid}`);
  const body    = card.querySelector('.card-body');
  const isTranslate = kind === 'translate';
  const btns = [...card.querySelectorAll(isTranslate ? '.card-btn-translate' : '.card-btn-dl')];

  if (status === 'done' && _jobDoneHandled.has(gid)) return;

  if (status === 'error') {
    if (body) body.classList.add('downloading');
    if (fillEl) fillEl.classList.remove('done', 'indeterminate');
    if (labelEl) labelEl.textContent = `${t('prog.error')}: ${job.error || 'unknown'}`;
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
    if (labelEl) labelEl.textContent = job.label || (job.total ? `0 / ${formatCount(job.total)}` : t('prog.starting'));
    if (isTranslate) btns.forEach(b => _setTrCancelMode(b, true));
    else btns.forEach(b => { b.disabled = true; });
    return;
  }

  if (status === 'progress' || status === 'done') {
    const done = job.done || 0, total = job.total || 0;
    let pct;
    if (isTranslate) pct = (typeof job.pct === 'number') ? job.pct : (total > 0 ? Math.round((done / total) * 100) : 0);  // weighted across the read/translate/render stages
    else if (kind === 'upload') pct = total > 0 ? Math.round((done / total) * 100) : 0;
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
          : job.label ? job.label : `${t('prog.translating')} ${doneText} / ${totalText}`;
      } else {
        labelEl.textContent = status === 'done'
          ? `${t('prog.done')} — ${doneText}/${totalText}${skippedNote}`
          : job.label ? `${job.label} · ${doneText}/${totalText}${skippedNote}` : `${doneText} / ${totalText}${skippedNote}`;
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
  let match;
  let rest = raw;
  while ((match = re.exec(raw)) !== null) {
    const type = aliases[match[1].toLowerCase()] ?? match[1].toLowerCase();
    typed.push({ type, value: match[2].toLowerCase() });
    rest = rest.replace(match[0], '');
  }
  rest.trim().split(/\s+/).filter(Boolean).forEach(t => plain.push(t.toLowerCase()));
  return { typed, plain };
}

// Loads the current page from the database (sorted + filtered server-side), so only the
// galleries on screen are ever materialized — memory is bounded by PAGE_SIZE, not library size.
let _loadSeq = 0;
async function applyFilters() {
  const seq = ++_loadSeq;
  const raw  = document.getElementById('searchBox').value.trim();
  const sort = document.getElementById('sortSelect').value;
  const { typed, plain } = parseSearch(raw);
  const match = (typed.length || plain.length) ? (g) => _matchEntity(g, typed, plain) : null;

  const { items, total } = await store.getPage({ sort, page: currentPage, pageSize: PAGE_SIZE, match });
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

// Search predicate; the store evaluates it against each gallery's metadata.
function _matchEntity(g, typed, plain) {
  for (const { type, value } of typed) {
    if (!g.tags || !g.tags.some(t => t.type === type && t.name.toLowerCase().includes(value))) return false;
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

async function updateHeaderStats() {
  const [stats, topLevel] = await Promise.all([getStats(), galleriesCount()]);
  // A series counts as one gallery here; image/storage totals still include every chapter's pages.
  document.getElementById('hTotalGalleries').textContent = formatCount(topLevel);
  document.getElementById('hTotalImages').textContent    = formatCount(stats.totalImages);
  document.getElementById('hTotalSize').textContent      = formatBytes(stats.totalSize);
  const sizeStat = document.getElementById('hSizeStat');
  if (sizeStat) {
    const avg = stats.totalImages > 0 ? Math.round(stats.totalSize / stats.totalImages) : 0;
    sizeStat.dataset.tipShift = avg > 0 ? t('lib.avg_per_image', { size: formatBytes(avg) }) : '';
  }
}

// Full (re)load of the library view — the current page plus the aggregate header stats.
async function loadAll() {
  await Promise.all([applyFilters(), updateHeaderStats()]);
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

// ── Shift key tracking ──

let _shiftHeld         = false;
let _hoveredDlBtn      = null;
let _hoveredOpenBtn    = null;
let _hoveredExportBtn  = null;
let _hoveredDelBtn     = null;
let _hoveredTrBtn      = null;
let _hoveredShiftEl    = null;
let _operatingOnCard   = null;

function _makeFlipBtn(innerClass) {
  let timer = null;
  return {
    to(btn, html) {
      const inner = btn?.querySelector('.' + innerClass);
      if (!inner) return;
      if (timer) { clearTimeout(timer); timer = null; inner.style.transition = 'none'; inner.style.transform = ''; void inner.offsetHeight; }
      inner.style.transition = 'transform 0.1s ease-in';
      inner.style.transform  = 'scaleY(0)';
      timer = setTimeout(() => {
        timer = null;
        inner.style.transition = 'none';
        inner.innerHTML = html;
        void inner.offsetHeight;
        inner.style.transition = 'transform 0.1s ease-out';
        inner.style.transform  = '';
      }, 100);
    },
    snap(btn, html) {
      const inner = btn?.querySelector('.' + innerClass);
      if (!inner) return;
      if (timer) { clearTimeout(timer); timer = null; }
      inner.style.transition = 'none';
      inner.style.transform  = '';
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
const _STOP_SVG         = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

document.addEventListener('keydown', e => {
  // Ignore key auto-repeat (e.repeat): a held Shift fires keydown continuously, which would
  // otherwise restart the icon flip every tick and make it jitter forever.
  if (e.key !== 'Shift' || e.repeat) return;
  _shiftHeld = true;
  document.body.classList.add('shift-held');
  if (_hoveredShiftEl && !_hoveredShiftEl.disabled) {
    _hoveredShiftEl.dataset.tipOrig = _hoveredShiftEl.dataset.tip;
    _hoveredShiftEl.dataset.tip = _hoveredShiftEl.dataset.tipShift;
    refreshTooltip();
  }
  if (_hoveredDlBtn && !_hoveredDlBtn.disabled) _dlFlip.to(_hoveredDlBtn, _UPLOAD_ICON);
  if (_hoveredOpenBtn && _hoveredOpenBtn.dataset.tipShift) _openFlip.to(_hoveredOpenBtn, _OPEN_SHIFT_ICON);
  if (_hoveredExportBtn && !_hoveredExportBtn.disabled) _exportFlip.to(_hoveredExportBtn, _EXPORT_SHIFT_SVG);
  if (_hoveredDelBtn) _delFlip.to(_hoveredDelBtn, _DELETE_SHIFT_SVG);
  if (_hoveredTrBtn && !_hoveredTrBtn.classList.contains('cancelling') && _hoveredTrBtn.dataset.tipShift && !_hoveredTrBtn.disabled) _trFlip.to(_hoveredTrBtn, _REVERT_SVG);
});
document.addEventListener('keyup', e => {
  if (e.key !== 'Shift') return;
  _shiftHeld = false;
  document.body.classList.remove('shift-held');
  if (_hoveredShiftEl && 'tipOrig' in _hoveredShiftEl.dataset) {
    _hoveredShiftEl.dataset.tip = _hoveredShiftEl.dataset.tipOrig;
    delete _hoveredShiftEl.dataset.tipOrig;
    refreshTooltip();
  }
  if (_hoveredDlBtn) _dlFlip.to(_hoveredDlBtn, _DL_SVG);
  if (_hoveredOpenBtn && _hoveredOpenBtn.dataset.tipShift) _openFlip.to(_hoveredOpenBtn, _hoveredOpenBtn._baseInner);
  if (_hoveredExportBtn) _exportFlip.to(_hoveredExportBtn, _EXPORT_SVG);
  if (_hoveredDelBtn) _delFlip.to(_hoveredDelBtn, _DELETE_SVG);
  if (_hoveredTrBtn && _hoveredTrBtn.dataset.tipShift) _trFlip.to(_hoveredTrBtn, _TRANSLATE_SVG);
});
window.addEventListener('focus', () => {
  _shiftHeld = false;
  document.body.classList.remove('shift-held');
  if (_hoveredShiftEl && 'tipOrig' in _hoveredShiftEl.dataset) {
    _hoveredShiftEl.dataset.tip = _hoveredShiftEl.dataset.tipOrig;
    delete _hoveredShiftEl.dataset.tipOrig;
    refreshTooltip();
  }
  if (_hoveredDlBtn) _dlFlip.to(_hoveredDlBtn, _DL_SVG);
  if (_hoveredOpenBtn && _hoveredOpenBtn.dataset.tipShift) _openFlip.to(_hoveredOpenBtn, _hoveredOpenBtn._baseInner);
  if (_hoveredExportBtn) _exportFlip.to(_hoveredExportBtn, _EXPORT_SVG);
  if (_hoveredDelBtn) _delFlip.to(_hoveredDelBtn, _DELETE_SVG);
  if (_hoveredTrBtn && _hoveredTrBtn.dataset.tipShift) _trFlip.to(_hoveredTrBtn, _TRANSLATE_SVG);
  if (_operatingOnCard) {
    const c = _operatingOnCard;
    _operatingOnCard = null;
    c.style.pointerEvents = 'none';
    void c.offsetHeight;
    c.style.pointerEvents = '';
  }
});
// Swap a hovered element's data-tip to its Shift action label while Shift is held; the shared
// tooltip module reads data-tip and renders/positions it. This listener is registered before
// initTooltips() so the swap lands before the tooltip reads it on the same mousemove.
document.addEventListener('mousemove', e => {
  const el = e.target.closest('[data-tip]');
  const newShiftEl = (el && el.dataset.tipShift) ? el : null;
  if (newShiftEl === _hoveredShiftEl) return;
  if (_hoveredShiftEl && 'tipOrig' in _hoveredShiftEl.dataset) {
    _hoveredShiftEl.dataset.tip = _hoveredShiftEl.dataset.tipOrig;
    delete _hoveredShiftEl.dataset.tipOrig;
  }
  _hoveredShiftEl = newShiftEl;
  if (_hoveredShiftEl && _shiftHeld && !_hoveredShiftEl.disabled) {
    _hoveredShiftEl.dataset.tipOrig = _hoveredShiftEl.dataset.tip;
    _hoveredShiftEl.dataset.tip = _hoveredShiftEl.dataset.tipShift;
  }
});
initTooltips();

// ── Local CBZ import (staged in OPFS, run by the most durable runner available) ──

async function replaceGalleryImages(gid, file) {
  const card    = document.querySelector(`[data-gallery-id="${gid}"]`);
  const progEl  = document.getElementById(`prog-${gid}`);
  const labelEl = document.getElementById(`proglabel-${gid}`);
  const dlBtns  = card ? [...card.querySelectorAll('.card-btn-dl')] : [];

  const setLabel = (txt) => { if (labelEl) labelEl.textContent = txt; };

  dlBtns.forEach(b => { b.disabled = true; b.innerHTML = '…'; });
  if (progEl) progEl.closest('.card-body')?.classList.add('downloading');

  setLabel(t('prog.reading_file'));
  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch { setLabel(t('prog.err_read')); dlBtns.forEach(b => { b.disabled = false; b.innerHTML = _DL_ICON; }); return; }

  setLabel(t('prog.uploading'));
  const tempName = `cbz-${gid}-${Date.now()}.bin`;
  try {
    const root     = await navigator.storage.getDirectory();
    const fh       = await root.getFileHandle(tempName, { create: true });
    const writable = await fh.createWritable();
    await writable.write(buffer);
    await writable.close();
  } catch (e) {
    setLabel(t('prog.err_stage'));
    dlBtns.forEach(b => { b.disabled = false; b.innerHTML = _DL_ICON; });
    return;
  }
  sendMsg({ type: 'IMPORT_CBZ', galleryId: gid, tempFile: tempName, filename: file.name, skipExisting: false });
}

document.getElementById('replaceImgInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const gid  = e.target.dataset.gid;
  e.target.value = '';
  if (!file || !gid) return;
  await replaceGalleryImages(gid, file);
});

function triggerImport() {
  document.getElementById('cbzFileInput').click();
}

document.getElementById('uploadCbzBtn').addEventListener('click', triggerImport);

async function importSingleFile(file, gid) {
  // Placeholder card is reserved up front by _handleImportFiles, so just drive progress.
  const progEl  = document.getElementById(`prog-${gid}`);
  const labelEl = document.getElementById(`proglabel-${gid}`);
  const setLabel = (txt) => { if (labelEl) labelEl.textContent = txt; };
  if (progEl) progEl.closest('.card-body')?.classList.add('downloading');

  setLabel(t('prog.reading_file'));
  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch (err) { setLabel(t('prog.err_read')); if (progEl) progEl.closest('.card-body')?.classList.remove('downloading'); return; }

  setLabel(t('prog.uploading'));
  const tempName = `cbz-${gid}-${Date.now()}.bin`;
  try {
    const root     = await navigator.storage.getDirectory();
    const fh       = await root.getFileHandle(tempName, { create: true });
    const writable = await fh.createWritable();
    await writable.write(buffer);
    await writable.close();
  } catch (e) {
    setLabel(t('prog.err_stage'));
    if (progEl) progEl.closest('.card-body')?.classList.remove('downloading');
    return;
  }
  // The upload runs in the service worker when available (survives this tab) and reports via
  // platform.jobs; applyJob() updates the card and drops the placeholder if it produced nothing.
  sendMsg({ type: 'IMPORT_CBZ', galleryId: gid, tempFile: tempName, filename: file.name, skipExisting: true });
}

async function _handleImportFiles(files) {
  const accepted = [...files].filter(f => /\.(zip|cbz|shi|shioridb)$/i.test(f.name));
  if (!accepted.length) return;
  if (/\.(shi|shioridb)$/i.test(accepted[0].name)) {
    try {
      const { kind, counts } = await importBackup(accepted[0]);
      alert(kind === 'metadata'
        ? t('alert.import_meta', { n: formatCount(counts.galleries) })
        : t('alert.import_full', { g: formatCount(counts.galleries), i: formatCount(counts.images) }));
    } catch (err) { alert(t('alert.backup_import_failed', { msg: err.message })); }
    await loadAll();
    return;
  }
  // Reserve a placeholder card for every dropped file up front (drop 3 zips → 3 cards
  // appear immediately), then upload them one at a time into their reserved ids.
  const base = Date.now();
  const queued = accepted.map((file, i) => ({ file, gid: String(base + i), title: file.name.replace(/\.[^.]+$/, '') }));
  await Promise.all(queued.map(({ gid, title }) =>
    store.mutate(gid, { title, count: 0, size: 0, addedAt: base, latestAt: base, isLocalImport: true })));
  await applyFilters();
  for (const { file, gid } of queued) {
    await importSingleFile(file, gid);
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
document.addEventListener('drop', (e) => {
  e.preventDefault();
  _dragDepth = 0;
  document.body.classList.remove('drag-over');
  _handleImportFiles(e.dataTransfer.files);
});

// ── Per-gallery ZIP export ──

const _CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function _crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ _CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _zipCreate(files) {
  const enc = new TextEncoder();
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const crc = _crc32(file.data);
    const size = file.data.length;

    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);    // method: store
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lfh.set(nameBytes, 30);

    const cde = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cde.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);   // method: store
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cde.set(nameBytes, 46);

    parts.push(lfh, file.data);
    centralDir.push(cde);
    offset += 30 + nameBytes.length + size;
  }

  const cdSize = centralDir.reduce((s, e) => s + e.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = parts.reduce((s, p) => s + p.length, 0) + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of [...parts, ...centralDir, eocd]) { out.set(p, pos); pos += p.length; }
  return out;
}

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
  const db  = await openDB();
  const meta = await new Promise((resolve, reject) => {
    const req = db.transaction('metadata', 'readonly').objectStore('metadata').get(gid);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });

  // Strip image-specific fields — this is a metadata-only backup. migrateTitle gives the export
  // the canonical shape (galleryId + title leading) regardless of when the record was stored.
  const { pageExts, ...metaClean } = migrateTitle(meta || {});

  const enc      = new TextEncoder();
  const zipBytes = _zipCreate([{ name: 'metadata.json', data: enc.encode(JSON.stringify(metaClean, null, 2)) }]);
  _saveBlob(new Blob([zipBytes], { type: 'application/zip' }), `shiori-${gid}-metadata.zip`);
}

async function exportMetadataBundleZip(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  const enc = new TextEncoder();
  const getMeta = (id) => new Promise((resolve, reject) => {
    const req = db.transaction('metadata', 'readonly').objectStore('metadata').get(String(id));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
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
  const manifest = {
    format: 'shiori-series',
    version: 1,
    metadataOnly: true,
    seriesTitle: meta.seriesTitle || '',
    seriesTags: Array.isArray(meta.seriesTags) ? meta.seriesTags : (meta.tags || []),
    chapters: [],
  };
  for (let i = 0; i < chapters.length; i++) {
    const cid = String(chapters[i].id);
    const folder = `chapter-${String(i + 1).padStart(2, '0')}`;
    manifest.chapters.push({ id: cid, title: chapters[i].title || '', folder });
    files.push({
      name: `${folder}/metadata.json`,
      data: enc.encode(JSON.stringify(cleanMeta(await getMeta(cid), { stripSeriesFields: true }), null, 2)),
    });
  }
  files.push({ name: 'series.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });
  _saveBlob(new Blob([_zipCreate(files)], { type: 'application/zip' }), `shiori-series-${gid}-metadata.zip`);
}

// Build the export file list for one gallery, every name under `prefix` (e.g. "chapter-01/" for a
// series bundle, "" for a standalone gallery). Layout: metadata.json, image_records.json, images/,
// translated/, study/{bg,text,bubbles.json} — the shape _importShioriEntries restores losslessly.
async function _collectGalleryFiles(gid, prefix, db, opts = {}) {
  let meta = await new Promise((resolve, reject) => {
    const req = db.transaction('metadata', 'readonly').objectStore('metadata').get(gid);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  meta = migrateTitle(meta);
  if (opts.stripSeriesFields) {
    const { chapters, parentId, seriesTitle, seriesTags, ...plainMeta } = meta || {};
    meta = plainMeta;
  }

  const imageRecords = await new Promise((resolve, reject) => {
    const req = db.transaction('images', 'readonly').objectStore('images').index('galleryId').getAll(IDBKeyRange.only(gid));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  imageRecords.sort((a, b) => {
    const pa = parseInt(a.url.match(/\/(\d+)\.\w+$/)?.[1] || '9999');
    const pb = parseInt(b.url.match(/\/(\d+)\.\w+$/)?.[1] || '9999');
    return pa - pb;
  });

  const enc = new TextEncoder();
  const files = [];

  files.push({ name: `${prefix}metadata.json`, data: enc.encode(JSON.stringify(meta, null, 2)) });

  files.push({
    name: `${prefix}image_records.json`,
    data: enc.encode(JSON.stringify(imageRecords.map(r => ({
      url: r.url,
      mediaId: r.mediaId,
      galleryId: r.galleryId,
      cachedAt: r.cachedAt,
      cachedAtISO: r.cachedAt ? new Date(r.cachedAt).toISOString() : null,
      size: r.size,
      translated: r.translated !== undefined,
      hasStudy: !!(Array.isArray(r.bubbles) && r.bubbles.length),
      bubbleCount: Array.isArray(r.bubbles) ? r.bubbles.length : 0
    })), null, 2))
  });

  // Image bytes from either a stored Blob (current format) or a legacy base64 data-URL.
  const imageBytes = async (src) => {
    if (!src) return null;
    if (src instanceof Blob) return new Uint8Array(await src.arrayBuffer());
    const b64 = String(src).split(',')[1];
    if (!b64) return null;
    const binStr = atob(b64);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    return bytes;
  };
  const imgExt = (src) => (src instanceof Blob ? src.type?.split('/')[1] : (typeof src === 'string' ? src.match(/^data:image\/(\w+)/)?.[1] : null)) || 'png';

  const coverEntries = [];
  const addCoverFile = async (role, src) => {
    const bytes = await imageBytes(src);
    if (!bytes) return;
    const ext = imgExt(src).toLowerCase().replace(/^jpeg$/, 'jpg');
    const file = `covers/${role}.${ext}`;
    files.push({ name: `${prefix}${file}`, data: bytes });
    coverEntries.push({
      role,
      file,
      mime: src instanceof Blob ? (src.type || '') : (String(src).match(/^data:([^;,]+)/)?.[1] || ''),
      size: bytes.byteLength,
    });
  };
  await addCoverFile('gallery', await coverGet(gid).catch(() => null));
  await addCoverFile('series', await coverGet(gid, { seriesOnly: true }).catch(() => null));
  if (coverEntries.length) {
    files.push({
      name: `${prefix}covers/manifest.json`,
      data: enc.encode(JSON.stringify({ version: 1, covers: coverEntries }, null, 2)),
    });
  }

  for (const rec of imageRecords) {
    const m = rec.url.match(/\/(\d+)\.(\w+)$/);
    if (!m) continue;
    const bytes = await imageBytes(rec.blob ?? rec.dataUrl);
    if (!bytes) continue;
    files.push({ name: `${prefix}images/${m[1].padStart(4, '0')}.${m[2].toLowerCase()}`, data: bytes });
  }

  // Translated variants in a parallel folder (only pages that have one).
  for (const rec of imageRecords) {
    if (!rec.translated) continue;
    const m = rec.url.match(/\/(\d+)\.\w+$/);
    if (!m) continue;
    const bytes = await imageBytes(rec.translated);
    if (!bytes) continue;
    const ext = (typeof rec.translated === 'string' ? rec.translated.match(/^data:image\/(\w+)/)?.[1] : rec.translated.type?.split('/')[1]) || 'png';
    files.push({ name: `${prefix}translated/${m[1].padStart(4, '0')}.${ext.toLowerCase()}`, data: bytes });
  }

  // Study-mode layers: the shared inpaint bg (study/bg) + each bubble's transparent text PNG
  // (study/text), and bubbles.json mapping page → boxes/regions/text-file. Mirrors the DB shape
  // so the import can restore it losslessly.
  const studyIndex = {};
  for (const rec of imageRecords) {
    const m = rec.url.match(/\/(\d+)\.\w+$/);
    if (!m || !Array.isArray(rec.bubbles) || !rec.bubbles.length) continue;
    const num = m[1].padStart(4, '0');
    const bgBytes = rec.studyBg ? await imageBytes(rec.studyBg) : null;
    if (bgBytes) files.push({ name: `${prefix}study/bg/${num}.${imgExt(rec.studyBg)}`, data: bgBytes });
    const entries = [];
    for (let k = 0; k < rec.bubbles.length; k++) {
      const b = rec.bubbles[k];
      const txtBytes = await imageBytes(b.text);
      const textFile = `${num}-${k}.${imgExt(b.text)}`;
      if (txtBytes) files.push({ name: `${prefix}study/text/${textFile}`, data: txtBytes });
      const entry = { box: b.box, region: b.region, tr: b.tr || '', src: b.src || '', textFile: txtBytes ? textFile : null };
      // DOM-text layout metadata rides along verbatim (style hints, line breaks, furigana).
      for (const key of ['rbox', 'style', 'tbox', 'furi']) {
        if (b[key] != null) entry[key] = b[key];
      }
      entries.push(entry);
    }
    // Newer bundles wrap the entries with the page's source dimensions; import accepts both.
    studyIndex[num] = rec.studyPage ? { page: rec.studyPage, bubbles: entries } : entries;
  }
  if (Object.keys(studyIndex).length) {
    files.push({ name: `${prefix}study/bubbles.json`, data: enc.encode(JSON.stringify(studyIndex, null, 2)) });
  }

  return files;
}

// Export one gallery — or, when it is a series owner, the whole series as chapter-NN/ folders plus
// a top-level series.json describing chapter order + titles.
async function exportGalleryZip(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  const meta = await new Promise((resolve, reject) => {
    const req = db.transaction('metadata', 'readonly').objectStore('metadata').get(gid);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });

  const chapters = (Array.isArray(meta?.chapters) && meta.chapters.length > 1) ? meta.chapters : null;
  if (!chapters) {
    const files = await _collectGalleryFiles(gid, '', db);
    _saveBlob(new Blob([_zipCreate(files)], { type: 'application/zip' }), `shiori-${gid}.zip`);
    return;
  }

  const enc = new TextEncoder();
  const manifest = {
    format: 'shiori-series',
    version: 1,
    seriesTitle: meta.seriesTitle || '',
    seriesTags: Array.isArray(meta.seriesTags) ? meta.seriesTags : (meta.tags || []),
    chapters: [],
  };
  const files = [];
  for (let i = 0; i < chapters.length; i++) {
    const folder = `chapter-${String(i + 1).padStart(2, '0')}`;
    manifest.chapters.push({ id: String(chapters[i].id), title: chapters[i].title || '', folder });
    files.push(...await _collectGalleryFiles(String(chapters[i].id), `${folder}/`, db, { stripSeriesFields: true }));
  }
  files.push({ name: 'series.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });
  _saveBlob(new Blob([_zipCreate(files)], { type: 'application/zip' }), `shiori-series-${gid}.zip`);
}

if (new URLSearchParams(window.location.search).get('import') === '1') {
  window.addEventListener('load', () => triggerImport(), { once: true });
}

const searchBox   = document.getElementById('searchBox');
const searchClear = document.getElementById('searchClear');

function updateClearBtn() {
  searchClear.classList.toggle('visible', searchBox.value.length > 0);
}

let _searchTimer = null;
searchBox.addEventListener('input', () => {
  updateClearBtn();
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => { currentPage = 1; applyFilters(); }, 180);
});
searchClear.addEventListener('click', () => {
  searchBox.value = '';
  currentPage = 1;
  applyFilters();
  updateClearBtn();
  searchBox.focus();
});
document.getElementById('sortSelect').addEventListener('change', () => { currentPage = 1; applyFilters(); });

// Append a search token, re-filter, and only steal focus to the search box if it was already
// active (so a hovered card stays expanded). Shared by tag clicks and the flag chip.
function _addSearchToken(token) {
  const box = document.getElementById('searchBox');
  const wasSearchActive = document.activeElement === box;
  const cur = box.value.trim();
  box.value = cur ? `${cur} ${token}` : token;
  currentPage = 1;
  applyFilters();
  updateClearBtn();
  if (wasSearchActive) box.focus();
}

document.getElementById('grid').addEventListener('click', (e) => {
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
      const toRemove = g.tags.filter(tg => tg.type === 'language' && _LANG_NAME_TO_CODE[String(tg.name).toLowerCase()] === code);
      if (!toRemove.length) return;   // flag came from source metadata / translated copy — no tag to delete
      const label = t('addtag.cat_language');
      const name  = flagChip.dataset.tip || flagChip.dataset.langName || code;
      if (!confirm(t('confirm.remove_tag', { label, name }))) return;
      store.mutate(gid, _tagPatchFor(g, g.tags.filter(tg => !toRemove.includes(tg))));
      return;
    }
    if (flagChip.dataset.langName) _addSearchToken(`language:"${flagChip.dataset.langName}"`);
    return;
  }

  // '+' chip → open the add-metadata modal for this card's gallery.
  const addBtn = e.target.closest('.card-tag-add');
  if (addBtn) {
    e.preventDefault(); e.stopPropagation();
    const gid = addBtn.closest('.card')?.dataset.galleryId;
    if (gid) openAddTagModal(gid);
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
    const label = t(_TAG_CAT_KEY[type] || 'addtag.cat_tag');
    if (!confirm(t('confirm.remove_tag', { label, name }))) return;
    const g = _pageItems.find(x => x.id === gid);
    if (!g || !Array.isArray(g.tags)) return;
    store.mutate(gid, _tagPatchFor(g, g.tags.filter(t => !(t.type === type && t.name === name))));
    return;
  }

  _addSearchToken(type ? `${type}:"${name}"` : name);
});

// ── Add-metadata-tag modal ──
let _addTagGid = null;
const _addTagModal = document.getElementById('addTagModal');
const _addTagCategory = document.getElementById('addTagCategory');
const _addTagLangSelect = document.getElementById('addTagLangValue');

// A language tag's value must be one of the supported flags, so it is picked from a dropdown
// instead of typed; every other category keeps the free-text input.
const _isLangCategory = () => _addTagCategory.value === 'language';
function _syncAddTagInput() {
  const lang = _isLangCategory();
  _addTagLangSelect.style.display = lang ? '' : 'none';
  document.getElementById('addTagValue').style.display = lang ? 'none' : '';
}
// Fill (or refresh, so labels follow the app language) the language dropdown.
function _fillLangOptions() {
  _addTagLangSelect.innerHTML = _LANG_TAG_OPTIONS
    .map(o => `<option value="${escHtml(o.name)}">${escHtml(_langDisplayName(o.code))}</option>`)
    .join('');
}
_addTagCategory.addEventListener('change', _syncAddTagInput);

function openAddTagModal(gid) {
  _addTagGid = gid;
  document.getElementById('addTagValue').value = '';
  _fillLangOptions();
  _syncAddTagInput();
  _addTagModal.classList.add('show');
  setTimeout(() => { (_isLangCategory() ? _addTagLangSelect : document.getElementById('addTagValue')).focus(); }, 30);
}
function closeAddTagModal() {
  _addTagModal.classList.remove('show');
  _addTagGid = null;
}
async function confirmAddTag() {
  const gid = _addTagGid;
  if (!gid) return;
  const type = _addTagCategory.value;
  const name = _isLangCategory()
    ? _addTagLangSelect.value
    : document.getElementById('addTagValue').value.trim().toLowerCase();
  if (!name) { document.getElementById('addTagValue').focus(); return; }
  const g = _pageItems.find(x => x.id === gid);
  const tags = Array.isArray(g?.tags) ? [...g.tags] : [];
  if (!tags.some(t => t.type === type && t.name === name)) tags.push({ type, name, url: '' });
  await store.mutate(gid, _tagPatchFor(g, tags));
  closeAddTagModal();
}
document.getElementById('addTagConfirm').addEventListener('click', confirmAddTag);
document.getElementById('addTagCancel').addEventListener('click', closeAddTagModal);
_addTagModal.addEventListener('click', (e) => { if (e.target === _addTagModal) closeAddTagModal(); });
document.getElementById('addTagValue').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); confirmAddTag(); }
  if (e.key === 'Escape') closeAddTagModal();
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
  if (idx >= 0 && card) { card.replaceWith(buildCard(entity)); fetchPageCovers([entity]); }
  else if (idx < 0) _scheduleReloadPage(); // a new gallery may belong on this page
});

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

// Windowed load: one page from the DB (covers come from the sessionStorage cache, so the
// grid still paints fast).
_sourceIconsReady.finally(() => loadAll());

const _FONT_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap';
const _FONT_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

async function _ensureFont() {
  try {
    const c = JSON.parse(localStorage.getItem('shiori-font') || 'null');
    if (c?.css && Date.now() - (c.cachedAt || 0) < _FONT_TTL) return;
    const cssResp = await fetch(_FONT_URL);
    if (!cssResp.ok) return; // keep existing cache as permanent failsafe
    let css = await cssResp.text();
    for (const [, url] of [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)]) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const blob = await r.blob();
        const dataUrl = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
        css = css.replaceAll(url, dataUrl);
      } catch {}
    }
    localStorage.setItem('shiori-font', JSON.stringify({ css, cachedAt: Date.now() }));
    const el = document.getElementById('jb-mono-cache');
    if (el) el.textContent = css;
  } catch {}
}

_ensureFont();

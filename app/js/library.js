// library.js — the library UI: windowed grid over the database, live job progress, uploads,
// per-gallery actions. Imports boot.js first so services + the PWA worker are wired.

import './boot.js';
import { openDB, metaPut, getStats } from './db.js';
import { importBackup } from './backup.js';
import { request as extRequest, available as extAvailable } from './ext-bridge.js';
import * as store from './store.js';
import * as platform from './platform.js';

// ── Source sites — learned at runtime, never hard-coded ─────────────────────────────────────
// The app is site-agnostic. What sites exist, whether they support downloads, and how their
// gallery links look is the extension's knowledge; it hands over a map at runtime (EXT_SITES).
// Without the extension the app still links to whatever exact sourceUrl a gallery carries.
let _siteMap = {};

const _siteName = (source) => (_siteMap[source]?.name) || source || '';

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

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

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
  if (ok === _extAvailable && !sitesChanged) return;
  _extAvailable = ok;
  try { localStorage.setItem('shiori-ext-status', JSON.stringify({ available: ok, sites: _siteMap })); } catch {}
  document.body.classList.toggle('extension-offline', !ok);
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
  if (sort && sort !== 'added') params.set('sort', sort);
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

function buildCardTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const artists = list.filter(t => t.type === 'artist');
  const regular = list.filter(t => t.type === 'tag');
  const female  = list.filter(t => t.type === 'tag:female');
  const male    = list.filter(t => t.type === 'tag:male');
  const chips = [
    ...artists.map(t => `<span class="card-tag artist" data-type="artist" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...regular.map(t => `<span class="card-tag" data-type="tag" data-original="${escHtml(t.name)}">${escHtml(t.name)}</span>`),
    ...female.map(t => `<span class="card-tag" data-type="tag:female" data-original="${escHtml(t.name)}">${escHtml(t.name)} ♀</span>`),
    ...male.map(t => `<span class="card-tag" data-type="tag:male" data-original="${escHtml(t.name)}">${escHtml(t.name)} ♂</span>`),
  ];
  // Trailing '+' chip — opens the add-metadata modal (shown only while the card is hovered).
  chips.push(`<span class="card-tag card-tag-add" data-tip="Add metadata tag">+</span>`);
  return `<div class="card-tags">${chips.join('')}</div>`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


function buildCard(g) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.galleryId = g.id;

  const thumbSrc = _coverCache.get(g.id) || null;
  const thumbInner = g.count > 0
    ? `<img class="card-thumb"${thumbSrc ? ` src="${thumbSrc}"` : ''} alt="">`
    : `<div class="card-thumb-placeholder">📁</div>`;

  const titleHtml = g.title
    ? `<div class="card-title" data-original="${escHtml(g.title)}">${escHtml(g.title)}</div>`
    : '';

  const cachedCount = g.count;
  const totalCount = g.numPages ? ` / ${g.numPages}` : '';
  const metaLine = `${cachedCount}${totalCount} pages · ${formatSize(g.size)}`;

  const tagHtml = buildCardTags(g.tags);

  const canDownload  = _canDownload(g);
  const visitUrl     = galleryLink(g, 1);
  const siteName     = _siteName(g.source);
  const openTitle    = visitUrl ? `${siteName}: ${visitUrl}` : 'Set source site';
  const dlTitle      = g.numPages ? `Download all ${g.numPages} pages` : 'Fetch metadata & download all';

  const actionsHtml = `
    <div class="card-actions">
      <button class="card-btn card-btn-dl" data-id="${g.id}" data-tip="${canDownload ? dlTitle : 'Replace images from CBZ'}" ${canDownload ? 'data-tip-shift="Replace images from CBZ"' : ''}>${canDownload ? _DL_ICON : _UPLOAD_ICON}</button>
      <button class="card-btn card-btn-translate${g.translated ? ' done' : ''}" data-id="${g.id}" data-tip="${g.translated ? 'Translate any new pages' : 'Translate gallery'}"${g.translated ? ' data-tip-shift="Revert to original"' : ''}>${_TRANSLATE_ICON}</button>
      <button class="card-btn card-btn-open" data-id="${g.id}" data-tip="${openTitle}"${visitUrl ? ' data-tip-shift="Edit source link"' : ''}><span class="open-inner">${_makeOpenBtnInner(g.source)}</span></button>
      <button class="card-btn card-btn-export" data-id="${g.id}" data-tip="Export gallery" data-tip-shift="Export metadata">${_EXPORT_ICON}</button>
      <button class="card-btn card-btn-del" data-id="${g.id}" data-tip="Delete gallery" data-tip-shift="Quick delete">${_DELETE_ICON}</button>
    </div>`;

  card.innerHTML = `
    <div class="card-thumb-spacer"></div>
    <div class="card-body-spacer"></div>
    <div class="card-hover-overlay">
      <a class="card-thumb-wrap" href="reader?g=${g.id}">
        ${thumbInner}
      </a>
      <div class="card-body">
        <div class="card-id-row">
          <div class="card-id${g.isLocalImport ? ' local' : ''}" data-original="${g.sourceId || g.id}">#${g.sourceId || g.id}</div>
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
      if (!e.shiftKey && !confirm(`Delete all cached images for gallery #${g.id}?`)) return;
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
        if (e.shiftKey) await exportMetadataZip(g.id);
        else            await exportGalleryZip(g.id);
      } catch (err) {
        alert('Export failed: ' + err.message);
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
      const btns = card.querySelectorAll('.card-btn-dl');
      if ([...btns].some(x => x.disabled)) return;

      const alreadyComplete = g.numPages > 0 && g.count >= g.numPages;
      if (alreadyComplete && !confirm(`Re-download all ${g.numPages} pages and overwrite the existing cache?`)) return;

      btns.forEach(x => { x.disabled = true; x.innerHTML = '…'; });

      const progEl  = document.getElementById(`prog-${g.id}`);
      const labelEl = document.getElementById(`proglabel-${g.id}`);

      if (progEl) progEl.closest('.card-body').classList.add('downloading');
      if (labelEl) labelEl.textContent = 'Fetching metadata…';

      await sendMsg({ type: 'CACHE_ALL_PAGES', galleryId: g.id, source: g.source, overwrite: alreadyComplete });
    });
  });

  card.querySelectorAll('.card-btn-translate').forEach(b => {
    b.addEventListener('mouseenter', () => {
      _hoveredTrBtn = b;
      if (_shiftHeld && b.dataset.tipShift && !b.disabled) _trFlip.to(b, _REVERT_SVG);
    });
    b.addEventListener('mouseleave', () => {
      _hoveredTrBtn = null;
      if (_shiftHeld && b.dataset.tipShift) _trFlip.to(b, _TRANSLATE_SVG);
    });
    b.addEventListener('click', async (e) => {
      const btns = card.querySelectorAll('.card-btn-translate');
      if ([...btns].some(x => x.disabled)) return;

      // Shift+click on an already-translated gallery → revert to the originals.
      if (e.shiftKey && g.translated) {
        if (!confirm(`Remove translated copies for #${g.sourceId || g.id} and revert to the originals?`)) return;
        btns.forEach(x => x.disabled = true);
        await sendMsg({ type: 'REVERT_GALLERY', galleryId: g.id });
        g.translated = false;
        const liveEntry = _pageItems.find(x => x.id === g.id);
        if (liveEntry) liveEntry.translated = false;
        const $card = document.querySelector(`.card[data-gallery-id="${g.id}"]`);
        if ($card) $card.replaceWith(buildCard(liveEntry || g));
        return;
      }

      if (g.count === 0) { alert('No cached pages to translate — download the gallery first.'); return; }

      if (!g.translated && !confirm(
        `Translate all ${g.count} cached pages of #${g.sourceId || g.id}?\n\n` +
        `Each page is sent to your translation server and a translated copy is stored ` +
        `alongside the original (originals are kept). Shift+click later to revert.`
      )) return;

      btns.forEach(x => x.disabled = true);
      const progEl  = document.getElementById(`prog-${g.id}`);
      const labelEl = document.getElementById(`proglabel-${g.id}`);
      if (progEl) progEl.closest('.card-body').classList.add('downloading');
      if (labelEl) labelEl.textContent = 'Translating…';

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
      const input = autoApply ? prefill : prompt('Source URL (paste the gallery’s page address):', prefill);
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

  return card;
}

function renderGrid(galleries) {
  const grid = document.getElementById('grid');

  // Release decoded bitmaps immediately so Chrome can evict them before the new page loads.
  grid.querySelectorAll('img.card-thumb').forEach(img => { img.src = ''; });

  if (galleries.length === 0) {
    grid.innerHTML = '<div class="empty">No galleries found.<br>Capture from a supported site or upload a CBZ to get started.</div>';
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
    if (g.count > 0 || (g.count === 0 && _canDownload(g))) {
      sendMsg({ type: 'GET_COVER', galleryId: g.id, source: g.source, thumbWidth: _thumbWidth, page: 'library' });
    }
  }
}

// ── Cover pushes from services (in-tab) and other contexts (BroadcastChannel) ──

platform.onControl((msg) => {
  if (msg.type === 'COVER_INVALIDATED') {
    _coverCache.delete(msg.galleryId);
    const gEntry = _pageItems.find(g => g.id === msg.galleryId);
    if (gEntry) sendMsg({ type: 'GET_COVER', galleryId: msg.galleryId, source: gEntry.source, thumbWidth: _thumbWidth, page: 'library' });
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
          wrap.appendChild(img);
        }
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

function applyJob(job) {
  if (!job || job.gid == null) return;
  const gid = String(job.gid);
  const { status, kind } = job;

  if (status === 'done' || status === 'error') _liveJobs.delete(gid);
  else _liveJobs.set(gid, job);
  if (status !== 'done') _jobDoneHandled.delete(gid);

  const card    = document.querySelector(`.card[data-gallery-id="${gid}"]`);
  if (!card) {
    // A brand-new gallery mid-job (e.g. a download started elsewhere) has no card yet.
    if (status !== 'done' && status !== 'error') _scheduleReloadPage();
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
    if (labelEl) labelEl.textContent = `Error: ${job.error || 'unknown'}`;
    btns.forEach(b => { b.disabled = false; });
    if (kind === 'upload') store.load(gid).then(g => { if (!g || g.count === 0) store.remove(gid); });
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
      const mb = (downloaded / 1048576).toFixed(1);
      labelEl.textContent = (pages > 0 && dlTotal > 0)
        ? `~${Math.min(pages, Math.round(downloaded * pages / dlTotal))} / ${pages} · ${mb} MB`
        : `↓ ${mb} MB`;
    }
    btns.forEach(b => { b.disabled = true; });
    return;
  }
  if (status === 'extracting') {
    if (fillEl) { fillEl.classList.remove('indeterminate'); fillEl.style.width = '85%'; }
    if (labelEl) labelEl.textContent = 'Extracting…';
    btns.forEach(b => { b.disabled = true; });
    return;
  }
  if (status === 'started') {
    if (fillEl) { fillEl.classList.remove('indeterminate', 'done'); fillEl.style.width = '0%'; }
    if (labelEl) labelEl.textContent = job.label || (job.total ? `0 / ${job.total}` : 'Starting…');
    btns.forEach(b => { b.disabled = true; });
    return;
  }

  if (status === 'progress' || status === 'done') {
    const done = job.done || 0, total = job.total || 0;
    let pct;
    if (isTranslate || kind === 'upload') pct = total > 0 ? Math.round((done / total) * 100) : 0;
    else pct = total > 0 ? Math.round(85 + (done / total) * 15) : 85;  // download store loop: last 15%
    if (fillEl) {
      fillEl.classList.remove('indeterminate');
      fillEl.style.width = pct + '%';
      fillEl.classList.toggle('done', status === 'done');
    }
    const skippedNote = job.skipped > 0 ? ` (${job.skipped} already cached)` : '';
    if (labelEl) {
      if (isTranslate) {
        labelEl.textContent = status === 'done'
          ? `Translated ${done}/${total}${job.failed ? ` (${job.failed} failed)` : ''}${job.costNote ? ` · ${job.costNote}` : ''}`
          : job.label ? `${job.label} · ${done}/${total}` : `Translating ${done} / ${total}`;
      } else {
        labelEl.textContent = status === 'done'
          ? `Done — ${done}/${total}${skippedNote}`
          : job.label ? `${job.label} · ${done}/${total}${skippedNote}` : `${done} / ${total}${skippedNote}`;
      }
    }
    if (status === 'done') {
      btns.forEach(b => { b.disabled = false; if (!isTranslate) { b.textContent = '✓'; } b.classList.add('done'); });
      if (!_jobDoneHandled.has(gid)) {
        _jobDoneHandled.add(gid);
        if (kind === 'upload') store.load(gid).then(g => { if (!g || g.count === 0) store.remove(gid); });
        setTimeout(() => { if (body) body.classList.remove('downloading'); loadAll(); }, 1500);
      }
    } else {
      btns.forEach(b => { b.disabled = true; });
    }
  }
}

platform.jobs.subscribe(applyJob);

// Hydrate in-flight jobs on load. A registry row whose runner stopped publishing is dead —
// clear it from the registry (so it can never wedge a card again) and show a resumable state
// with the buttons ENABLED. Live runners publish at least every page; translate gets a wide
// margin because a cloud batch call can sit quiet for minutes.
const JOB_STALE_MS = { download: 2 * 60 * 1000, upload: 2 * 60 * 1000, translate: 10 * 60 * 1000 };
async function hydrateJobs() {
  for (const job of await platform.jobs.current()) {
    const staleAfter = JOB_STALE_MS[job.kind] || 2 * 60 * 1000;
    if ((Date.now() - (job.at || 0)) > staleAfter) {
      const gid = String(job.gid);
      platform.jobs.clear(gid, job.kind);
      _liveJobs.delete(gid);
      const labelEl = document.getElementById(`proglabel-${gid}`);
      const body = labelEl && labelEl.closest('.card-body');
      if (body) body.classList.add('downloading');
      if (labelEl) labelEl.textContent = 'Interrupted — run again to resume';
      continue;
    }
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
      html += `<button class="page-btn${n === page ? ' active' : ''}" data-page="${n}">${n}</button>`;
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
  const stats = await getStats();
  const totalGalleries = Object.keys(stats.galleries).length;
  document.getElementById('hTotalGalleries').textContent = totalGalleries;
  document.getElementById('hTotalImages').textContent    = stats.totalImages;
  document.getElementById('hTotalSize').textContent      = formatSize(stats.totalSize);
  const sizeStat = document.getElementById('hSizeStat');
  if (sizeStat) {
    const avg = stats.totalImages > 0 ? Math.round(stats.totalSize / stats.totalImages) : 0;
    sizeStat.dataset.tipShift = avg > 0 ? `avg ${formatSize(avg)} / image` : '';
  }
}

// Full (re)load of the library view — the current page plus the aggregate header stats.
async function loadAll() {
  await Promise.all([applyFilters(), updateHeaderStats()]);
  await hydrateJobs();
}

// Site favicon on the open-source button. Loaded directly by the <img> tag (no fetch — the
// favicon service has no CORS headers, so a fetch from a web origin always fails; the browser's
// HTTP cache makes repeat renders free). Falls back to the chain icon if it doesn't load.
function _makeOpenBtnInner(source) {
  const CHAIN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  if (!source) return CHAIN_SVG;
  return `<img src="https://www.google.com/s2/favicons?domain=${escHtml(source)}&sz=16" data-fav="${escHtml(source)}" style="width:12px;height:12px;pointer-events:none;" onerror="this.outerHTML='<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'11\\' height=\\'11\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'><path d=\\'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\\'/><path d=\\'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\\'/></svg>'">`;
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
const _dlTooltip = document.getElementById('dl-tooltip');

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

document.addEventListener('keydown', e => {
  if (e.key !== 'Shift') return;
  _shiftHeld = true;
  if (_hoveredShiftEl && !_hoveredShiftEl.disabled) {
    _hoveredShiftEl.dataset.tipOrig = _hoveredShiftEl.dataset.tip;
    _hoveredShiftEl.dataset.tip = _hoveredShiftEl.dataset.tipShift;
    _dlTooltip.textContent = _hoveredShiftEl.dataset.tipShift;
    _dlTooltip.style.display = 'block';
  }
  if (_hoveredDlBtn && !_hoveredDlBtn.disabled) _dlFlip.to(_hoveredDlBtn, _UPLOAD_ICON);
  if (_hoveredOpenBtn && _hoveredOpenBtn.dataset.tipShift) _openFlip.to(_hoveredOpenBtn, _OPEN_SHIFT_ICON);
  if (_hoveredExportBtn && !_hoveredExportBtn.disabled) _exportFlip.to(_hoveredExportBtn, _EXPORT_SHIFT_SVG);
  if (_hoveredDelBtn) _delFlip.to(_hoveredDelBtn, _DELETE_SHIFT_SVG);
  if (_hoveredTrBtn && _hoveredTrBtn.dataset.tipShift && !_hoveredTrBtn.disabled) _trFlip.to(_hoveredTrBtn, _REVERT_SVG);
});
document.addEventListener('keyup', e => {
  if (e.key !== 'Shift') return;
  _shiftHeld = false;
  if (_hoveredShiftEl && 'tipOrig' in _hoveredShiftEl.dataset) {
    _hoveredShiftEl.dataset.tip = _hoveredShiftEl.dataset.tipOrig;
    delete _hoveredShiftEl.dataset.tipOrig;
    _dlTooltip.textContent = _hoveredShiftEl.dataset.tip;
    if (!_hoveredShiftEl.dataset.tip) _dlTooltip.style.display = 'none';
  }
  if (_hoveredDlBtn) _dlFlip.to(_hoveredDlBtn, _DL_SVG);
  if (_hoveredOpenBtn && _hoveredOpenBtn.dataset.tipShift) _openFlip.to(_hoveredOpenBtn, _hoveredOpenBtn._baseInner);
  if (_hoveredExportBtn) _exportFlip.to(_hoveredExportBtn, _EXPORT_SVG);
  if (_hoveredDelBtn) _delFlip.to(_hoveredDelBtn, _DELETE_SVG);
  if (_hoveredTrBtn && _hoveredTrBtn.dataset.tipShift) _trFlip.to(_hoveredTrBtn, _TRANSLATE_SVG);
});
window.addEventListener('focus', () => {
  _shiftHeld = false;
  if (_hoveredShiftEl && 'tipOrig' in _hoveredShiftEl.dataset) {
    _hoveredShiftEl.dataset.tip = _hoveredShiftEl.dataset.tipOrig;
    delete _hoveredShiftEl.dataset.tipOrig;
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
document.addEventListener('mousemove', e => {
  const el = e.target.closest('[data-tip]');
  const newShiftEl = (el && el.dataset.tipShift) ? el : null;
  if (newShiftEl !== _hoveredShiftEl) {
    if (_hoveredShiftEl && 'tipOrig' in _hoveredShiftEl.dataset) {
      _hoveredShiftEl.dataset.tip = _hoveredShiftEl.dataset.tipOrig;
      delete _hoveredShiftEl.dataset.tipOrig;
    }
    _hoveredShiftEl = newShiftEl;
    if (_hoveredShiftEl && _shiftHeld && !_hoveredShiftEl.disabled) {
      _hoveredShiftEl.dataset.tipOrig = _hoveredShiftEl.dataset.tip;
      _hoveredShiftEl.dataset.tip = _hoveredShiftEl.dataset.tipShift;
    }
  }
  _dlTooltip.style.left = (e.clientX + 14) + 'px';
  _dlTooltip.style.top  = (e.clientY + 16) + 'px';
  if (el && el.dataset.tip) {
    _dlTooltip.textContent = el.dataset.tip;
    _dlTooltip.style.display = 'block';
  } else {
    _dlTooltip.style.display = 'none';
  }
});

// ── Local CBZ import (staged in OPFS, run by the most durable runner available) ──

async function replaceGalleryImages(gid, file) {
  const card    = document.querySelector(`[data-gallery-id="${gid}"]`);
  const progEl  = document.getElementById(`prog-${gid}`);
  const labelEl = document.getElementById(`proglabel-${gid}`);
  const dlBtns  = card ? [...card.querySelectorAll('.card-btn-dl')] : [];

  const setLabel = (txt) => { if (labelEl) labelEl.textContent = txt; };

  dlBtns.forEach(b => { b.disabled = true; b.innerHTML = '…'; });
  if (progEl) progEl.closest('.card-body')?.classList.add('downloading');

  setLabel('Reading file…');
  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch { setLabel('Error: could not read file.'); dlBtns.forEach(b => { b.disabled = false; b.innerHTML = _DL_ICON; }); return; }

  setLabel('Uploading…');
  const tempName = `cbz-${gid}-${Date.now()}.bin`;
  try {
    const root     = await navigator.storage.getDirectory();
    const fh       = await root.getFileHandle(tempName, { create: true });
    const writable = await fh.createWritable();
    await writable.write(buffer);
    await writable.close();
  } catch (e) {
    setLabel('Error: could not stage file.');
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

  setLabel('Reading file…');
  let buffer;
  try { buffer = await file.arrayBuffer(); }
  catch (err) { setLabel('Error: could not read file.'); if (progEl) progEl.closest('.card-body')?.classList.remove('downloading'); return; }

  setLabel('Uploading…');
  const tempName = `cbz-${gid}-${Date.now()}.bin`;
  try {
    const root     = await navigator.storage.getDirectory();
    const fh       = await root.getFileHandle(tempName, { create: true });
    const writable = await fh.createWritable();
    await writable.write(buffer);
    await writable.close();
  } catch (e) {
    setLabel('Error: could not stage file.');
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
        ? `Imported metadata for ${counts.galleries} galleries.`
        : `Imported ${counts.galleries} galleries / ${counts.images} images.`);
    } catch (err) { alert('Backup import failed: ' + err.message); }
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

  // Strip image-specific fields — this is a metadata-only backup.
  const { pageExts, ...metaClean } = meta || {};

  const enc      = new TextEncoder();
  const zipBytes = _zipCreate([{ name: 'metadata.json', data: enc.encode(JSON.stringify(metaClean, null, 2)) }]);
  _saveBlob(new Blob([zipBytes], { type: 'application/zip' }), `shiori-${gid}-metadata.zip`);
}

async function exportGalleryZip(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();

  const meta = await new Promise((resolve, reject) => {
    const req = db.transaction('metadata', 'readonly').objectStore('metadata').get(gid);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });

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

  files.push({
    name: 'metadata.json',
    data: enc.encode(JSON.stringify(meta, null, 2))
  });

  files.push({
    name: 'image_records.json',
    data: enc.encode(JSON.stringify(imageRecords.map(r => ({
      url: r.url,
      mediaId: r.mediaId,
      galleryId: r.galleryId,
      cachedAt: r.cachedAt,
      cachedAtISO: r.cachedAt ? new Date(r.cachedAt).toISOString() : null,
      size: r.size,
      translated: r.translated !== undefined
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

  for (const rec of imageRecords) {
    const m = rec.url.match(/\/(\d+)\.(\w+)$/);
    if (!m) continue;
    const bytes = await imageBytes(rec.blob ?? rec.dataUrl);
    if (!bytes) continue;
    files.push({ name: `images/${m[1].padStart(4, '0')}.${m[2].toLowerCase()}`, data: bytes });
  }

  // Translated variants in a parallel folder (only pages that have one).
  for (const rec of imageRecords) {
    if (!rec.translated) continue;
    const m = rec.url.match(/\/(\d+)\.\w+$/);
    if (!m) continue;
    const bytes = await imageBytes(rec.translated);
    if (!bytes) continue;
    const ext = (typeof rec.translated === 'string' ? rec.translated.match(/^data:image\/(\w+)/)?.[1] : rec.translated.type?.split('/')[1]) || 'png';
    files.push({ name: `translated/${m[1].padStart(4, '0')}.${ext.toLowerCase()}`, data: bytes });
  }

  const zipBytes = _zipCreate(files);
  _saveBlob(new Blob([zipBytes], { type: 'application/zip' }), `shiori-${gid}.zip`);
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

document.getElementById('grid').addEventListener('click', (e) => {
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
    const label = type === 'tag' ? 'tag'
      : type && type.startsWith('tag:') ? type.slice(4) + ' tag'
      : (type || 'tag');
    if (!confirm(`Remove the ${label} “${name}” from this gallery?`)) return;
    const g = _pageItems.find(x => x.id === gid);
    if (!g || !Array.isArray(g.tags)) return;
    store.mutate(gid, { tags: g.tags.filter(t => !(t.type === type && t.name === name)) });
    return;
  }

  const token = type ? `${type}:"${name}"` : name;
  const box   = document.getElementById('searchBox');
  // Don't steal focus to the search box unless it's already active — so a hovered card stays
  // expanded when its tags are clicked.
  const wasSearchActive = document.activeElement === box;
  const cur   = box.value.trim();
  box.value   = cur ? `${cur} ${token}` : token;
  currentPage = 1;
  applyFilters();
  updateClearBtn();
  if (wasSearchActive) box.focus();
});

// ── Add-metadata-tag modal ──
let _addTagGid = null;
const _addTagModal = document.getElementById('addTagModal');
function openAddTagModal(gid) {
  _addTagGid = gid;
  document.getElementById('addTagValue').value = '';
  _addTagModal.classList.add('show');
  setTimeout(() => document.getElementById('addTagValue').focus(), 30);
}
function closeAddTagModal() {
  _addTagModal.classList.remove('show');
  _addTagGid = null;
}
async function confirmAddTag() {
  const gid = _addTagGid;
  if (!gid) return;
  const type = document.getElementById('addTagCategory').value;
  const name = document.getElementById('addTagValue').value.trim().toLowerCase();
  if (!name) { document.getElementById('addTagValue').focus(); return; }
  const g = _pageItems.find(x => x.id === gid);
  const tags = Array.isArray(g?.tags) ? [...g.tags] : [];
  if (!tags.some(t => t.type === type && t.name === name)) tags.push({ type, name, url: '' });
  await store.mutate(gid, { tags });
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
  window.location.href = 'settings';
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
    el.textContent = '#' + el.dataset.original.replace(/\d/g, () => Math.floor(Math.random() * 10));
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
    el.textContent = '#' + el.dataset.original;
  });
}

function setSafeMode(enabled) {
  safeMode = enabled;
  localStorage.setItem('shiori-safe-mode', enabled ? '1' : '0');
  document.body.classList.toggle('safe-mode', enabled);
  const btn = document.getElementById('safeBtn');
  if (enabled) {
    btn.classList.add('active');
    btn.dataset.tip = 'Disable Safe Mode';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    applyGibberishToGrid();
  } else {
    btn.classList.remove('active');
    btn.dataset.tip = 'Enable Safe Mode (blur content for sharing)';
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
    pinBtn.dataset.tip = p ? 'Unpin header' : 'Pin header';
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
  if (_liveJobs.has(gid)) {
    // A job owns an existing card's progress bar — don't rebuild it (that would reset the
    // bar). A brand-new gallery mid-job (e.g. an import) has no card yet, so reload the page.
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
const SCROLL_SPEED = 22;
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
const _stopScroll = () => _scrollHeld.clear();
document.addEventListener('keyup', (e) => {
  if (e.key === 'w' || e.key === 'W') _scrollHeld.delete('up');
  if (e.key === 's' || e.key === 'S') _scrollHeld.delete('down');
});
window.addEventListener('blur', _stopScroll);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

  // W / S → continuous scroll (Shift jumps to the ends).
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

initFromUrl();

// Windowed load: one page from the DB (covers come from the sessionStorage cache, so the
// grid still paints fast).
loadAll();

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

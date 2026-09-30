// overview.js — the series overview page: the middle landing before the reader. Lists a series'
// chapters in order, lets the user rename the series and each chapter, reorder, remove, add a
// chapter from an existing gallery (autocomplete) or by dropping a file, and jump into any chapter.

import './boot.js';
import { getGallery, metaGet, dbGet, imageToBlob, listGalleryPageKeys, nextGalleryId, tagCounts } from './db.js';
import * as store from './store.js';
import * as platform from './platform.js';
import { request as extRequest } from './ext-bridge.js';
import { canDownload as _canDownload, updateSitesStatus as updateExtStatus, galleryLink, siteName } from './sites.js';
import { resolveSeries, getSeriesChapters, mergeIntoSeries, removeChapter, reorderChapters, setChapterTitle, setSeriesTitle, setGalleryTitle, canDetachChapter } from './series.js';
import { t, getLang, applyTranslations } from './i18n.js';
import { pickTitle, pickSeriesTitle, normalizeTitle, seriesTitleObject } from './titles.js';
import { initTooltips, refreshTooltip, onModifiers } from './tooltip.js';
import { initDropdowns } from './dropdown.js';
import { formatBytes, formatCount, formatCompact, formatMegapixels } from './format.js';
import { describePage } from './page-size.js';
import { escHtml } from './sanitize.js';
import { resizeToWidth } from './image-util.js';
import { IMPORT_ACCEPT, groupImports, importBytes, isImportable, droppedImports } from './import-files.js';
import { openRerunMenu } from './rerun-menu.js';
import { confirmDialog, alertDialog } from './notice.js';
import { openTagEditor, removeTag, tagKey, TAG_TYPE_LABEL } from './tag-editor.js';

// ── Header details ──
// The tags as a table: one labelled row per kind (the tag editor's names), each chip a link to the
// library searching for that tag, with how many library entries carry it. Female and male tags
// lead the general row, marked. In edit mode a chip opens the tag editor instead, and a trailing
// '+' adds a tag (the table shows for it even with no tags).
const TAG_ROWS = [
  ['addtag.cat_language', ['language']],
  ['addtag.cat_artist', ['artist']],
  ['addtag.cat_group', ['group']],
  ['addtag.cat_parody', ['parody']],
  ['addtag.cat_character', ['character']],
  ['addtag.cat_tag', ['tag:female', 'tag:male', 'tag']],
];
const TAG_MARK = { 'tag:female': ' ♀', 'tag:male': ' ♂' };
async function tagTableHtml(tags) {
  const list = (Array.isArray(tags) ? tags : []).filter((tg) => TAG_ROWS.some(([, types]) => types.includes(tg.type)));
  const counts = list.length ? await tagCounts({ keys: list.map((tg) => tagKey(tg.type, tg.name)) }) : new Map();
  const rows = TAG_ROWS.map(([labelKey, types]) => [labelKey, types.flatMap((type) => list.filter((tg) => tg.type === type).map((tg) => {
    const n = counts.get(tagKey(type, tg.name));
    return `<a class="ov-chip" href="../?q=${encodeURIComponent(`${type}:"${tg.name}"`)}" data-type="${esc(type)}" data-name="${esc(tg.name)}">${esc(tg.name)}${TAG_MARK[type] || ''}${n ? `<span class="ov-chip-n">${formatCompact(n)}</span>` : ''}</a>`;
  }))]).filter(([, chips]) => chips.length);
  const add = `<button type="button" class="ov-chip ov-chip-add" data-tip="${esc(t('card.tip_addtag'))}">+</button>`;
  if (!rows.length) return `<div class="ov-tag-table no-tags" id="ovTags"><div class="ov-tag-chips ov-tag-add-only">${add}</div></div>`;
  rows[rows.length - 1][1].push(add);
  return `<div class="ov-tag-table" id="ovTags">${rows.map(([labelKey, chips]) =>
    `<div class="ov-tag-row"><span class="ov-tag-label">${esc(t(labelKey))}</span><div class="ov-tag-chips">${chips.join('')}</div></div>`).join('')}</div>`;
}

const _svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const META_ICON = {
  category: _svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  rating: _svg('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'),
  chapters: _svg('<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>'),
  pages: _svg('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  size: _svg('<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01"/><path d="M10 16h.01"/>'),
  resolution: _svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  posted: _svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  added: _svg('<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M12 14v4"/><path d="M10 16h4"/>'),
};

// "2024/06/15 18:30" for a millisecond timestamp.
function stampOf(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// The owner (and its stored meta) of the last render, so the details line can be rebuilt in
// place when a chapter's job changes the totals.
let _hero = null;

// The details line under the actions: category and rating, then pages, size, typical page size,
// when it was posted and added, and whether it's translated. Each explains itself on hover; in
// edit mode the category and rating open the tag editor like a tag.
function heroMetaHtml(chapters) {
  const { isSeries, owner, ownerMeta } = _hero;
  const tags = owner?.tags || [];
  const names = (type) => tags.filter((tg) => tg.type === type).map((tg) => tg.name).join(', ');
  const items = [];
  const item = (icon, text, { tip = '', badge = '', cls = '', tag = '' } = {}) => items.push(
    `<span class="ov-meta-item${cls ? ' ' + cls : ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}${badge ? ` data-tip-badge="${esc(badge)}"` : ''}${tag ? ` data-tag-type="${tag}" data-tag-name="${esc(tags.find((tg) => tg.type === tag).name)}"` : ''}>${icon}<span>${esc(text)}</span></span>`);
  const category = names('category'), rating = names('rating');
  if (category) item(META_ICON.category, category, { tip: t('filter.category'), cls: 'cap', tag: 'category' });
  if (rating) item(META_ICON.rating, rating, { tip: t('filter.rating'), cls: 'cap', tag: 'rating' });
  if (isSeries) item(META_ICON.chapters, `${formatCount(chapters.length)} ${t('ov.chapters')}`);
  const count = chapters.reduce((s, c) => s + (c.entity?.count || 0), 0);
  const size = chapters.reduce((s, c) => s + (c.entity?.size || 0), 0);
  const orig = chapters.reduce((s, c) => s + (c.entity?.origSize || 0), 0);
  const total = !isSeries && owner?.numPages ? ` / ${formatCount(owner.numPages)}` : '';
  item(META_ICON.pages, `${formatCount(count)}${total} ${t('card.pages')}`,
    { tip: count ? t('card.tip_page_avg', { size: formatBytes(orig / count) }) : '' });
  item(META_ICON.size, formatBytes(size));
  const page = describePage(isSeries ? owner?.aggMedianPage : owner?.medianPage);
  if (page) item(META_ICON.resolution, `${page.w}×${page.h}`, { tip: formatMegapixels(page.mp), badge: page.tier });
  if (!isSeries && owner?.translated) item(ICON.translate, t('ov.translated'), { cls: 'done' });
  // The dates get a line of their own.
  const details = items.splice(0);
  const posted = Number(ownerMeta?.uploadDate) || Number(owner?.uploadDate) || 0;
  if (posted) item(META_ICON.posted, stampOf(posted * 1000), { tip: `${t('ov.posted')} · ${relTime(posted)}` });
  if (owner?.addedAt) item(META_ICON.added, stampOf(owner.addedAt), { tip: `${t('page.added')} · ${relTime(owner.addedAt / 1000)}` });
  return [details, items].filter((line) => line.length).map((line) => `<div class="ov-meta-line">${line.join('')}</div>`).join('');
}

// The title in the other script (the Japanese title under an English heading, and the reverse),
// when there is one and it differs from the heading.
function altTitle(titles, heading) {
  const tt = titles || {};
  const alt = getLang().startsWith('ja') ? (tt.english || tt.pretty) : tt.japanese;
  return alt && alt !== heading ? alt : '';
}

// "2 years ago" / "3 days ago" for a Unix-seconds timestamp, localized to the app language.
function relTime(secs) {
  const diffMs = secs * 1000 - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(getLang(), { numeric: 'auto' });
  const units = [['year', 31536e6], ['month', 2592e6], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
  for (const [unit, ms] of units)
    if (abs >= ms) return rtf.format(Math.round(diffMs / ms), unit);
  return rtf.format(Math.round(diffMs / 1000), 'second');
}

const params  = new URLSearchParams(location.search);
let ownerId   = null;
const _covers = new Map();   // role:gid:width → thumbnail data URL (invalidated on cover edits)
let editMode  = false;
let _suppressRenderUntil = 0;
const _liveChapterJobs = new Map();
const _chapterJobClearTimers = new Map();
const _chapterRowEntities = new WeakMap();

const $ = (id) => document.getElementById(id);
const esc = escHtml;
const readerHref = (gid) => `../reader?g=${encodeURIComponent(String(gid))}`;
const sendMsg = (msg) => platform.rpc(msg);
// A translated chapter's translate button also offers "Re-run from…" on right-click.
const _translatedTip = () => `${t('card.tip_translate_new')} · ${t('card.tip_rerun')}`;
const ICON = {
  open:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  up:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  down:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  read:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  edit:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
  done:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  heart:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
  download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>',
  translate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
  revert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  detach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7H7a5 5 0 0 0 0 10h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><path d="M8 12h8"/><path d="m4 4 16 16"/></svg>',
  removeShift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M9 13l2 2 4-4"/></svg>',
};

// ── Shift-hold affordance on the chapter-row download/delete buttons (mirrors the library card
// buttons): while Shift is held over one, its icon flips to the alternate action and its tooltip
// swaps to the Shift label. Download's alternate is Replace-from-CBZ; Delete's is a quick delete. ──
function _makeFlipBtn(innerClass) {
  const timers = new WeakMap();
  const reset = (inner) => {
    const timer = timers.get(inner);
    if (timer) clearTimeout(timer);
    timers.delete(inner);
    inner.style.transition = 'none';
    inner.style.transform = '';
  };
  return {
    to(btn, html) {
      const inner = btn?.querySelector('.' + innerClass);
      if (!inner) return;
      reset(inner);
      void inner.offsetHeight;
      inner.style.transition = 'transform 0.1s ease-in';
      inner.style.transform  = 'scaleY(0)';
      const timer = setTimeout(() => {
        timers.delete(inner);
        inner.style.transition = 'none';
        inner.innerHTML = html;
        void inner.offsetHeight;
        inner.style.transition = 'transform 0.1s ease-out';
        inner.style.transform  = '';
      }, 100);
      timers.set(inner, timer);
    },
    snap(btn, html) {
      const inner = btn?.querySelector('.' + innerClass);
      if (!inner) return;
      reset(inner);
      inner.innerHTML = html;
    },
  };
}
const _dlFlip  = _makeFlipBtn('ch-dl-inner');
const _trFlip  = _makeFlipBtn('ch-tr-inner');
const _delFlip = _makeFlipBtn('ch-del-inner');

// The held Shift comes from the tooltip module (onModifiers), which also shows each control's Shift
// label — including a release that happened outside the window, noticed on the next mouse event
// or when the window is left. This page flips the hovered control's icon to match.
let _shiftHeld = false;
let _hoveredDlBtn = null, _hoveredTrBtn = null, _hoveredDelBtn = null;
const _dlCanFlip = (btn) => btn && btn.dataset.tipShift != null && !btn.disabled;   // only when Replace is offered

onModifiers(({ shift }) => {
  if (shift === _shiftHeld) return;
  _shiftHeld = shift;
  document.body.classList.toggle('shift-held', shift);
  if (shift) {
    if (_dlCanFlip(_hoveredDlBtn)) _dlFlip.to(_hoveredDlBtn, ICON.upload);
    if (_hoveredTrBtn?.dataset.tipShift != null && !_hoveredTrBtn.disabled) _trFlip.to(_hoveredTrBtn, ICON.revert);
    if (_hoveredDelBtn && !_hoveredDelBtn.disabled) _delFlip.to(_hoveredDelBtn, ICON.removeShift);
  } else {
    if (_dlCanFlip(_hoveredDlBtn)) _dlFlip.to(_hoveredDlBtn, ICON.download);
    if (_hoveredTrBtn?.dataset.tipShift != null) _trFlip.to(_hoveredTrBtn, ICON.translate);
    if (_hoveredDelBtn) _delFlip.to(_hoveredDelBtn, ICON.remove);
  }
});
initTooltips();
initDropdowns();

// Covers go through the shared GET_COVER service — request coalescing, the resize-concurrency
// cap and the persistent thumbnail cache — instead of decoding a full-size cover blob per row.
// COVER_READY pushes are matched back to their awaiting request by requestId.
let _coverReqSeq = 0;
const _coverWaiters = new Map();
platform.onControl((msg) => {
  if (msg?.type === 'COVER_READY' && msg.requester === 'overview' && _coverWaiters.has(msg.requestId)) {
    _coverWaiters.get(msg.requestId)(msg.coverDataUrl || '');
    _coverWaiters.delete(msg.requestId);
  }
});

function coverKey(gid, preferSeries = false, width = 0) {
  return `${preferSeries ? 'series' : 'gallery'}:${String(gid)}:${width}`;
}

async function coverUrl(gid, opts = {}) {
  const width = Math.round(Number(opts.width)) || 160;
  const key = coverKey(gid, !!opts.preferSeries, width);
  if (_covers.has(key)) return _covers.get(key);
  const url = await new Promise((resolve) => {
    const requestId = `ov-${++_coverReqSeq}`;
    _coverWaiters.set(requestId, resolve);
    platform.rpc({ type: 'GET_COVER', galleryId: String(gid), thumbWidth: width, preferSeries: !!opts.preferSeries, requester: 'overview', requestId });
    setTimeout(() => { if (_coverWaiters.has(requestId)) { _coverWaiters.delete(requestId); resolve(''); } }, 10000);
  });
  if (url) _covers.set(key, url);
  return url;
}
function clearCovers() { _covers.clear(); }
function invalidateCover(gid) {
  const id = String(gid);
  for (const key of [..._covers.keys()]) {
    if (key.split(':')[1] === id) _covers.delete(key);
  }
}

// ── Page-grid thumbnails ──
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
const PAGE_THUMB_SCALE  = 1.5;   // a copy's width ÷ its tile's on-screen pixel width
const PAGE_THUMB_STEP   = 32;    // widths round up to this step, so one copy serves nearby sizes
const PAGE_THUMB_MAX_W  = 768;
const PAGE_THUMB_FORMAT = { format: 'image/webp', quality: 0.82 };
const THUMB_WORKERS     = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 4)));
const PAGE_GEN_MAX      = THUMB_WORKERS * 2;   // in flight — each holds one decoded page for a moment
const PAGE_CACHE_MAX    = 1024;
const PAGE_CACHE_BYTES  = 32 * 1024 * 1024;
const PAGE_MOUNT_MARGIN  = 900;
const PAGE_UNMOUNT_MARGIN = 5400;
const _pageThumbCache = new Map();   // page url → { src: blob: URL, width, bytes } (Map order = LRU order)
let   _pageCacheBytes = 0;
const _pageThumbImg   = new Map();   // page url → current <img>
const _pageGenQueue    = [];         // <img> awaiting a copy
const _pageThumbNear   = new Set();   // tiles inside the load band
let   _pageGenActive   = 0;

const _pageMountObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      _pageThumbNear.add(e.target);
      _enqueuePageThumb(e.target);
    } else {
      _pageThumbNear.delete(e.target);
    }
  }
}, { rootMargin: `${PAGE_MOUNT_MARGIN}px 0px` });

const _pageUnmountObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) continue;
    const img = e.target;
    img.removeAttribute('src');
    delete img.dataset.ready;
    delete img.dataset.width;
    _trimPageCache();
  }
}, { rootMargin: `${PAGE_UNMOUNT_MARGIN}px 0px` });

// The width a tile's copy should have now: its on-screen pixels × PAGE_THUMB_SCALE, stepped.
function _pageThumbWidth(img) {
  const tileW = img.parentElement?.clientWidth || 120;
  const scale = (window.devicePixelRatio || 1) * (window.visualViewport?.scale || 1);
  return Math.min(PAGE_THUMB_MAX_W, Math.ceil(tileW * scale * PAGE_THUMB_SCALE / PAGE_THUMB_STEP) * PAGE_THUMB_STEP);
}

// Zoomed in (browser zoom, pinch-zoom) or resized past what the loaded copies were made for: remake
// the load band's copies at the new size. Each tile keeps showing its current copy meanwhile.
let _pageZoomTimer = 0;
function _onPageScaleChange() {
  clearTimeout(_pageZoomTimer);
  _pageZoomTimer = setTimeout(() => {
    for (const img of _pageThumbNear) {
      if (img.dataset.ready && Number(img.dataset.width) < _pageThumbWidth(img)) {
        delete img.dataset.ready;
        _enqueuePageThumb(img);
      }
    }
  }, 250);
}
window.addEventListener('resize', _onPageScaleChange);
window.visualViewport?.addEventListener('resize', _onPageScaleChange);
// A pixel-ratio change alone (another screen, some zoom paths) fires no resize event.
(function watchPixelRatio() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    .addEventListener('change', () => { _onPageScaleChange(); watchPixelRatio(); }, { once: true });
})();

function _pageCacheGet(url) {
  const entry = _pageThumbCache.get(url);
  if (!entry) return null;
  _pageThumbCache.delete(url); _pageThumbCache.set(url, entry);   // touch → most-recent
  return entry;
}
// Store a new copy of a page; a larger one already stored wins and the new one is dropped. Returns
// the entry to show and the one it replaced (for the caller to release once nothing shows it).
function _pageCacheStore(url, made) {
  const existing = _pageThumbCache.get(url);
  if (existing && existing.width >= made.width) {
    try { URL.revokeObjectURL(made.src); } catch {}
    return { entry: _pageCacheGet(url), replaced: null };
  }
  if (existing) { _pageThumbCache.delete(url); _pageCacheBytes -= existing.bytes; }
  _pageThumbCache.set(url, made);
  _pageCacheBytes += made.bytes;
  return { entry: made, replaced: existing };
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
function releasePageTiles(root) {
  root.querySelectorAll('.ov-page img[data-page-url]').forEach(img => {
    _pageMountObserver.unobserve(img);
    _pageUnmountObserver.unobserve(img);
    _pageThumbNear.delete(img);
    if (_pageThumbImg.get(img.dataset.pageUrl) === img) _pageThumbImg.delete(img.dataset.pageUrl);
  });
}

function _enqueuePageThumb(img) {
  if (img.dataset.ready || img.dataset.queued) return;
  img.dataset.queued = '1';
  _pageGenQueue.push(img);
  _drainPageQueue();
}

function _pageViewportDistance(img) {
  const rect = img.parentElement?.getBoundingClientRect();
  if (!rect) return Infinity;
  if (rect.bottom < 0) return -rect.bottom;
  if (rect.top > innerHeight) return rect.top - innerHeight;
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

function _drainPageQueue() {
  while (_pageGenActive < PAGE_GEN_MAX && _pageGenQueue.length) _processPageQueue();
}

// Decoded before it's swapped in, so a tile never flashes empty; a tile that left the load band
// meanwhile just takes the new copy without the wait.
async function _attachPageThumb(img, entry, url) {
  const pre = new Image();
  pre.src = entry.src;
  try { await pre.decode(); } catch { return false; }
  if (!img.isConnected || img.dataset.pageUrl !== url) return true;
  if (!_pageThumbNear.has(img) && !img.getAttribute('src')) return true;
  img.src = entry.src;
  img.dataset.ready = '1';
  img.dataset.width = entry.width;
  return true;
}

async function _processPageQueue() {
  if (_pageGenActive >= PAGE_GEN_MAX || !_pageGenQueue.length) return;
  _pageGenActive++;
  const img = _takeNearestPageThumb();
  let retry = false;
  try {
    if (!img.isConnected || !_pageThumbNear.has(img)) return;
    const url = img.dataset.pageUrl;
    const width = _pageThumbWidth(img);
    let entry = _pageCacheGet(url), replaced = null;
    if (!entry || entry.width < width) {
      const made = await _makePageThumb(url, width);
      if (!made) return;
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

async function _makePageThumb(url, width) {
  const rec = await dbGet(url).catch(() => null);
  const fullBlob = await imageToBlob(rec?.blob ?? rec?.dataUrl);
  if (!fullBlob) return null;
  const blob = await _resizeInWorker(fullBlob, width);
  return blob ? { src: URL.createObjectURL(blob), width, bytes: blob.size } : null;
}

// ── Thumbnail workers ──
// Started on first use. A worker that fails hands its pending requests to this thread and leaves
// the pool; with none left, copies are made here (slower, same result).
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
    job.resolve(resizeToWidth(job.blob, job.width, PAGE_THUMB_FORMAT).catch(() => null));
  }
}

function _resizeInWorker(blob, width) {
  const worker = _thumbWorker();
  if (!worker) return resizeToWidth(blob, width, PAGE_THUMB_FORMAT).catch(() => null);
  return new Promise((resolve) => {
    const id = ++_thumbSeq;
    _thumbPending.set(id, { resolve, worker, blob, width });
    worker.postMessage({ id, blob, width, ...PAGE_THUMB_FORMAT });
  });
}

// Fill a container with one tile per cached page of a gallery. Tiles carry only a page url and a
// reader link; images fill in lazily as they scroll into view. Idempotent per container.
async function buildPageGrid(container, gid) {
  if (!container || container.dataset.built) return;
  container.dataset.built = '1';
  const keys = await listGalleryPageKeys(gid);
  if (!keys.length) { container.innerHTML = `<div class="ov-pages-empty">${esc(t('ov.no_pages'))}</div>`; return; }
  const frag = document.createDocumentFragment();
  for (const { pageNum, url } of keys) {
    const a = document.createElement('a');
    a.className = 'ov-page';
    a.href = `${readerHref(gid)}&page=${pageNum}`;
    a.draggable = false;
    const img = document.createElement('img');
    img.alt = ''; img.decoding = 'async'; img.dataset.pageUrl = url;
    _pageThumbImg.set(url, img);
    const num = document.createElement('span');
    num.className = 'ov-page-num';
    num.textContent = pageNum;
    a.append(img, num);
    frag.appendChild(a);
    _pageMountObserver.observe(img);
    _pageUnmountObserver.observe(img);
  }
  container.appendChild(frag);
}

// Drop a cover into an A4-ratio thumbnail box, matching the library card: a portrait image fills
// the box (cover), a landscape one is contained so it isn't cropped. `container` is the fixed-ratio
// wrapper; the .landscape class flips object-fit once the image's dimensions are known.
function setThumb(container, url) {
  if (!container || !url) return;
  container.innerHTML = `<img class="ov-thumb" src="${url}" alt="">`;
  const img = container.querySelector('img');
  const fit = () => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    const landscape = img.naturalWidth >= img.naturalHeight;
    img.classList.toggle('landscape', landscape);
    container.classList.toggle('landscape', landscape);
  };
  img.addEventListener('load', fit);
  if (img.complete) fit();
}

// The same cover, blurred and faint, behind the header.
function setBackdrop(url) {
  const el = $('ovBackdrop');
  if (el && url) el.style.backgroundImage = `url("${url}")`;
}

function resizeTitleArea(el) {
  if (!el || el.tagName !== 'TEXTAREA') return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

function resizeTitleAreas(root = document) {
  root.querySelectorAll('textarea.series-title-input').forEach(resizeTitleArea);
}

// ── Render ──
// Every gallery has an overview. A standalone gallery shows its own info plus the add-chapter bar
// (adding a chapter turns it into a series); a series shows its ordered chapter list. The series
// title is editable and multi-language — the app language decides which variant is shown/edited.
async function render() {
  const content = $('ovContent');
  const meta = await metaGet(ownerId);
  const series = await resolveSeries(ownerId);
  if (series) ownerId = series.ownerId;
  const ownerEntity = await getGallery(ownerId);
  if (!ownerEntity && !series) { content.innerHTML = `<div class="ov-empty">${esc(t('ov.not_found'))}</div>`; return; }
  const isSeries = !!series;
  clearCovers();

  const chapters = isSeries
    ? await getSeriesChapters(ownerId)
    : [{ id: ownerId, title: '', entity: ownerEntity }];
  const totalPages = chapters.reduce((s, c) => s + (c.entity?.count || 0), 0);

  const ownerMeta = isSeries ? await metaGet(ownerId) : meta;
  const heading = isSeries
    ? (pickSeriesTitle(ownerMeta?.seriesTitle, ownerEntity, getLang()) || `#${ownerId}`)
    : (pickTitle(ownerEntity, getLang()) || `#${ownerId}`);
  const seriesFallback = pickTitle(ownerEntity, getLang()) || `#${ownerId}`;
  const startHref = readerHref(chapters[0].id);

  // Both a series and a standalone gallery expose an editable owner title in edit mode: a series
  // edits its multi-language seriesTitle, a standalone gallery edits its own `title` object.
  const ownerTitleId = isSeries ? 'seriesTitle' : 'galleryTitle';
  const titlePlaceholder = isSeries ? t('ov.series_title_ph') : t('ov.gallery_title_ph');
  const titleControl = `<div class="series-title-wrap editable"><textarea class="series-title-input" id="${ownerTitleId}" rows="1" data-original="${esc(heading)}" data-fallback="${esc(seriesFallback)}" placeholder="${esc(titlePlaceholder)}">${esc(heading)}</textarea><a class="series-title-open" href="${startHref}" aria-label="${esc(heading)}"></a></div>`;
  const titles = isSeries ? (seriesTitleObject(ownerMeta?.seriesTitle) || normalizeTitle(ownerEntity)) : normalizeTitle(ownerEntity);
  const subtitle = altTitle(titles, heading);
  _hero = { isSeries, owner: ownerEntity, ownerMeta, heading };
  const source = galleryLink(ownerEntity, 1);
  const sourceLink = source
    ? `<a class="ov-btn" href="${esc(source)}" target="_blank" rel="noopener noreferrer" data-tip="${esc(`${siteName(ownerEntity?.source)}: ${source}`)}">${ICON.open}<span>${esc(t('page.source'))}</span></a>`
    : '';
  const editLabel = editMode ? t('ov.done_editing') : t('ov.edit');
  const addBar = `
    <div class="add-bar" id="addBar">
      <h3 data-i18n="ov.add_chapter">Add chapter</h3>
      <div class="add-search-wrap">
        <input class="add-search" id="addSearch" placeholder="${esc(t('ov.add_search_ph'))}" autocomplete="off" spellcheck="false">
        <div class="add-results" id="addResults"></div>
      </div>
      <div class="add-hint">${esc(t('ov.add_hint'))}</div>
    </div>`;

  _tagsSeq++;   // this render's tags supersede any refresh still reading its counts
  const tagsHtml = await tagTableHtml(ownerEntity?.tags);

  // Keep encoded thumbnails across a DOM rebuild, as the reader does when rebuilding its strip.
  // Detach the old tiles from visibility tracking, then let the new tiles reuse the warm LRU.
  releasePageTiles(content);
  content.innerHTML = `
    <section class="ov-hero">
      <div class="ov-backdrop" id="ovBackdrop" aria-hidden="true"></div>
      <a class="series-cover" id="seriesCover" href="${startHref}" draggable="false"><div class="ph">📚</div></a>
      <div class="series-info">
        ${titleControl}
        ${subtitle ? `<div class="ov-subtitle">${esc(subtitle)}</div>` : ''}
        <div class="series-actions">
          <a class="ov-btn primary" id="readStart" href="${startHref}">${ICON.read}<span>${esc(t('ov.read_start'))}</span></a>
          <button class="ov-btn fav" id="favToggle" type="button"></button>
          <button class="ov-btn${editMode ? ' active' : ''}" id="editToggle" aria-pressed="${editMode ? 'true' : 'false'}">${editMode ? ICON.done : ICON.edit}<span>${esc(editLabel)}</span></button>
          ${sourceLink}
        </div>
        <div class="ov-meta" id="ovMeta">${heroMetaHtml(chapters)}</div>
        ${tagsHtml}
      </div>
    </section>
    <h2 class="ov-section-title">${esc(isSeries ? t('ov.chapters') : t('card.pages'))}<span>${formatCount(isSeries ? chapters.length : totalPages)}</span></h2>
    ${isSeries ? '<div class="ch-list" id="chList"></div>' : '<div class="ov-pages" id="ovPages"></div>'}
    ${addBar}`;
  content.classList.toggle('ov-editing', editMode);

  const coverPromise = coverUrl(ownerId, { preferSeries: isSeries, width: 480 });
  if (isSeries) {
    const list = $('chList');
    for (let i = 0; i < chapters.length; i++) list.appendChild(await chapterRow(chapters[i], i, chapters.length));
  } else {
    await buildPageGrid($('ovPages'), ownerId);
  }
  // Resolve first, THEN look the container up: a re-render during the await replaces the head,
  // and an element captured beforehand would be detached — the thumbnail would land nowhere.
  // Paint the header cover as soon as it resolves instead of behind the chapter list: a long
  // series builds many rows, and the head must not wait for the last one. Looked up after the
  // await, since a re-render in between replaces the element this would otherwise have captured.
  coverPromise.then((url) => { setThumb($('seriesCover'), url); setBackdrop(url); }).catch(() => {});
  // Edit the owner title variant for the current app language; other languages are preserved. A
  // series saves its seriesTitle, a standalone gallery saves its own title.
  const ownerInput = $('seriesTitle') || $('galleryTitle');
  if (ownerInput) {
    ownerInput.addEventListener('input', (e) => resizeTitleArea(e.target));
    ownerInput.addEventListener('change', (e) => saveOwnerTitleInput(e.target));
  }
  $('editToggle').addEventListener('click', () => setEditMode(!editMode));
  syncFavButton();
  $('favToggle').addEventListener('click', toggleFavorite);
  wireAdd();
  applyEditMode();
  applyTranslations(content);   // fill any [data-i18n] nodes in the freshly-built content
}

async function saveVisibleTitles() {
  const ownerInput = $('seriesTitle') || $('galleryTitle');
  if (ownerInput) await saveOwnerTitleInput(ownerInput);
  const chapterInputs = [...document.querySelectorAll('.ch-title-input[data-chapter-id]')];
  for (const input of chapterInputs) await saveChapterTitleInput(input);
}

function applyEditMode(root = document) {
  const fullPage = root === document;
  const content = $('ovContent');
  if (fullPage && content) content.classList.toggle('ov-editing', editMode);
  // Edit mode hides the per-row expand toggle, so collapse any open page grids with it.
  if (editMode) root.querySelectorAll('.ch-row.expanded').forEach(r => {
    r.classList.remove('expanded');
    const b = r.querySelector('[data-expand]');
    if (b) { b.setAttribute('aria-expanded', 'false'); b.dataset.tip = t('ov.show_pages'); }
  });
  root.querySelectorAll('.series-title-input').forEach(input => {
    const isOwner = input.id === 'seriesTitle' || input.id === 'galleryTitle';
    const editable = editMode && isOwner;
    input.readOnly = !editable;
    input.tabIndex = editable ? 0 : -1;
    if (isOwner) {
      const custom = input.dataset.original || '';
      input.value = editMode ? custom : (custom.trim() || input.dataset.fallback || '');
    }
  });
  root.querySelectorAll('.ch-title-input').forEach(input => {
    input.readOnly = !editMode;
    input.tabIndex = editMode ? 0 : -1;
  });
  root.querySelectorAll('.ch-title-input').forEach(input => {
    const custom = input.dataset.editValue || '';
    input.value = editMode ? custom : (custom.trim() || input.dataset.fallback || '');
  });
  if (!fullPage) return;
  const btn = $('editToggle');
  if (!btn) return;
  btn.classList.toggle('active', editMode);
  btn.setAttribute('aria-pressed', editMode ? 'true' : 'false');
  btn.innerHTML = `${editMode ? ICON.done : ICON.edit}<span>${esc(t(editMode ? 'ov.done_editing' : 'ov.edit'))}</span>`;
  resizeTitleAreas();
}

function updateChapterLinkFromInput(input) {
  const link = input?.closest('.ch-main')?.querySelector('.ch-title-open');
  const label = input.value.trim() || input.dataset.fallback || '';
  if (link) link.setAttribute('aria-label', label);
  const sizer = input?.closest('.ch-title-wrap')?.querySelector('.ch-title-sizer');
  if (sizer) sizer.textContent = label;
}

// Save the owner title — a series' seriesTitle, or a standalone gallery's own title (id tells them
// apart). Both preserve the other app languages' variants.
async function saveOwnerTitleInput(input) {
  const next = input.value.trim();
  if (next === (input.dataset.original || '').trim()) return;
  _suppressRenderUntil = Date.now() + 500;
  if (input.id === 'galleryTitle') await setGalleryTitle(ownerId, getLang(), next);
  else                             await setSeriesTitle(ownerId, getLang(), next);
  _suppressRenderUntil = Date.now() + 500;
  input.dataset.original = next;
  const label = next || input.dataset.fallback || '';
  input.closest('.series-title-wrap')?.querySelector('.series-title-open')?.setAttribute('aria-label', label);
  resizeTitleArea(input);
}

async function saveChapterTitleInput(input) {
  const next = input.value.trim();
  if (next === (input.dataset.original || '').trim()) return;
  _suppressRenderUntil = Date.now() + 500;
  await setChapterTitle(ownerId, input.dataset.chapterId, next);
  _suppressRenderUntil = Date.now() + 500;
  input.dataset.original = next;
  input.dataset.editValue = next;
  updateChapterLinkFromInput(input);
}

async function setEditMode(next) {
  if (editMode === next) return;
  if (editMode && !next) await saveVisibleTitles();
  editMode = next;
  applyEditMode();
}

async function chapterRow(ch, idx, total) {
  const row = document.createElement('div');
  row.className = 'ch-row' + (ch.entity ? '' : ' missing');
  row.dataset.chapterId = String(ch.id);
  const e = ch.entity;
  if (e) _chapterRowEntities.set(row, e);
  const title = pickTitle(e, getLang()) || '';
  const href = readerHref(ch.id);
  const displayTitle = ch.title || title || t('ov.chapter_n', { n: idx + 1 });
  const pageStr = e ? `${formatCount(e.count)}${e.numPages ? ` / ${formatCount(e.numPages)}` : ''} ${t('card.pages')}` : t('ov.missing');
  const translated = e?.translated ? `<span class="done">${esc(t('ov.translated'))}</span>` : '';
  const fallbackTitle = title || t('ov.chapter_n', { n: idx + 1 });
  const titleControl = `
    <div class="ch-title-wrap">
      <span class="ch-title-sizer" aria-hidden="true">${esc(displayTitle)}</span>
      <input class="ch-title-input" size="1" data-chapter-id="${esc(ch.id)}" data-original="${esc(ch.title)}" value="${esc(displayTitle)}" data-edit-value="${esc(ch.title)}" data-fallback="${esc(fallbackTitle)}" placeholder="${esc(fallbackTitle)}">
      <a class="ch-title-open" href="${href}" data-fallback="${esc(fallbackTitle)}" aria-label="${esc(displayTitle)}"></a>
    </div>`;
  const thumbControl = e
    ? `<a class="ch-thumb link" href="${href}" draggable="false"><div class="ph">📄</div></a>`
    : `<div class="ch-thumb"><div class="ph">📄</div></div>`;
  const canDownload = e && _canDownload(e);
  const liveJob = _liveChapterJobs.get(String(ch.id));
  const activeJob = liveJob && !['done', 'error', 'cancelled', 'interrupted'].includes(liveJob.status);
  const busyDownload = activeJob && (liveJob.kind === 'download' || liveJob.kind === 'upload');
  const busyTranslate = activeJob && liveJob.kind === 'translate';
  const dlTitle = e?.numPages ? t('card.tip_dl', { n: formatCount(e.numPages) }) : t('card.tip_dl_meta');
  const dlInner = `<span class="ch-dl-inner">${canDownload ? ICON.download : ICON.upload}</span>`;
  const downloadAction = e ? `<button class="ch-ibtn download" data-download data-tip="${esc(canDownload ? dlTitle : t('card.tip_replace'))}"${canDownload ? ` data-tip-shift="${esc(t('card.tip_replace'))}"` : ''}${busyDownload ? ' disabled' : ''}>${dlInner}</button>` : '';
  const translateTip = busyTranslate ? t('card.tip_cancel') : (e?.translated ? _translatedTip() : t('card.tip_translate'));
  const translateAction = e ? `<button class="ch-ibtn translate${e.translated ? ' done' : ''}${busyTranslate ? ' cancelling' : ''}" data-translate data-tip="${esc(translateTip)}"${e.translated && !busyTranslate ? ` data-tip-shift="${esc(t('card.tip_revert'))}"` : ''}><span class="ch-tr-inner">${busyTranslate ? ICON.stop : ICON.translate}</span></button>` : '';
  const actions = `
    <div class="ch-actions">
      <button class="ch-ibtn" data-up ${idx === 0 ? 'disabled' : ''} data-tip="${esc(t('ov.move_up'))}">${ICON.up}</button>
      <button class="ch-ibtn" data-down ${idx === total - 1 ? 'disabled' : ''} data-tip="${esc(t('ov.move_down'))}">${ICON.down}</button>
      ${downloadAction}
      ${translateAction}
      ${canDetachChapter(e) ? `<button class="ch-ibtn detach" data-detach data-tip="${esc(t('ov.remove_detach'))}">${ICON.detach}</button>` : ''}
      <button class="ch-ibtn danger" data-remove data-tip="${esc(t('card.tip_delete'))}" data-tip-shift="${esc(t('card.tip_quickdelete'))}"><span class="ch-del-inner">${ICON.remove}</span></button>
    </div>`;

  // Expand/collapse toggle — reveals this chapter's pages as an accordion grid. Shown only outside
  // edit mode (CSS), after the hover-revealed action buttons.
  const expandBtn = e
    ? `<button class="ch-ibtn ch-expand" data-expand aria-expanded="false" data-tip="${esc(t('ov.show_pages'))}">${ICON.down}</button>`
    : '';
  row.innerHTML = `
    <div class="ch-head">
      <div class="ch-num">${idx + 1}</div>
      ${thumbControl}
      <div class="ch-main">
        ${titleControl}
        <div class="ch-meta"><span>#${esc(e?.sourceId || ch.id)}</span><span>${esc(pageStr)}</span>${translated}</div>
        <div class="ch-progress">
          <div class="prog-track"><div class="prog-fill"></div></div>
          <span class="ch-prog-label"></span>
        </div>
      </div>
      ${actions}
      ${expandBtn}
    </div>
    <div class="ch-pages"></div>`;

  // Thumbnails stream in per row rather than gating it: a long series would otherwise build its
  // list one cover round-trip at a time. `row` is this call's own element, so it stays valid.
  if (e) coverUrl(ch.id).then((url) => setThumb(row.querySelector('.ch-thumb'), url)).catch(() => {});

  const titleInput = row.querySelector('.ch-title-input');
  if (titleInput) {
    titleInput.addEventListener('input', (ev) => {
      ev.target.dataset.editValue = ev.target.value;
      updateChapterLinkFromInput(ev.target);
    });
    titleInput.addEventListener('change', (ev) => saveChapterTitleInput(ev.target));
  }
  const up = row.querySelector('[data-up]');
  const down = row.querySelector('[data-down]');
  const download = row.querySelector('[data-download]');
  const translate = row.querySelector('[data-translate]');
  const detach = row.querySelector('[data-detach]');
  const remove = row.querySelector('[data-remove]');
  if (up) up.addEventListener('click', () => move(idx, -1));
  if (down) down.addEventListener('click', () => move(idx, 1));
  if (download) {
    download.addEventListener('mouseenter', () => { _hoveredDlBtn = download; if (_dlCanFlip(download) && _shiftHeld) _dlFlip.to(download, ICON.upload); });
    download.addEventListener('mouseleave', () => { if (_dlCanFlip(download) && _shiftHeld) _dlFlip.to(download, ICON.download); _hoveredDlBtn = null; });
    download.addEventListener('click', (ev) => downloadOrReplaceChapter(ch, e, ev, displayTitle));
  }
  if (translate) {
    translate.addEventListener('mouseenter', () => { _hoveredTrBtn = translate; if (translate.dataset.tipShift != null && _shiftHeld && !translate.disabled) _trFlip.to(translate, ICON.revert); });
    translate.addEventListener('mouseleave', () => { if (translate.dataset.tipShift != null && _shiftHeld) _trFlip.to(translate, ICON.translate); _hoveredTrBtn = null; });
    translate.addEventListener('click', (ev) => translateChapter(ch, e, ev, displayTitle));
    translate.addEventListener('contextmenu', (ev) => rerunChapter(ch, e, ev, displayTitle));
  }
  if (detach) detach.addEventListener('click', () => detachChapter(ch));
  if (remove) {
    remove.addEventListener('mouseenter', () => { _hoveredDelBtn = remove; if (_shiftHeld) _delFlip.to(remove, ICON.removeShift); });
    remove.addEventListener('mouseleave', () => { if (_shiftHeld) _delFlip.to(remove, ICON.remove); _hoveredDelBtn = null; });
    remove.addEventListener('click', (ev) => deleteChapter(ch, { prompt: !ev.shiftKey, entity: e, label: displayTitle }));
  }
  const expand = row.querySelector('[data-expand]');
  if (expand) expand.addEventListener('click', () => toggleChapterPages(row, ch.id, expand));
  if (liveJob) paintChapterJob(row, liveJob);
  return row;
}

// Availability can resolve while a large chapter list is still being built. Reconcile only the
// affected controls after that first render so every row reflects the same result without paying
// for another round of metadata and cover reads.
function refreshDownloadControls() {
  for (const row of document.querySelectorAll('.ch-row[data-chapter-id]')) {
    const entity = _chapterRowEntities.get(row);
    const btn = row.querySelector('[data-download]');
    if (!entity || !btn) continue;

    const canDownload = _canDownload(entity);
    btn.dataset.tip = canDownload
      ? (entity.numPages ? t('card.tip_dl', { n: formatCount(entity.numPages) }) : t('card.tip_dl_meta'))
      : t('card.tip_replace');
    if (canDownload) btn.dataset.tipShift = t('card.tip_replace');
    else delete btn.dataset.tipShift;

    const shifted = canDownload && _shiftHeld && _hoveredDlBtn === btn && !btn.disabled;
    if (btn.querySelector('.ch-dl-inner')) _dlFlip.snap(btn, shifted || !canDownload ? ICON.upload : ICON.download);
  }
  refreshTooltip();
}

// Accordion: reveal/hide a chapter's page grid. Pages are built on first open (then kept, so
// re-opening is instant); thumbnails still fill in lazily as they scroll into view.
async function toggleChapterPages(row, gid, btn) {
  const open = row.classList.toggle('expanded');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.dataset.tip = t(open ? 'ov.hide_pages' : 'ov.show_pages');
  refreshTooltip();
  if (open) await buildPageGrid(row.querySelector('.ch-pages'), gid);
}

function setTranslateButtonBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    if (btn.classList.contains('cancelling')) return;
    btn.classList.add('cancelling');
    btn.disabled = false;
    if (btn.dataset.tipShift != null) { btn._tipShiftStash = btn.dataset.tipShift; delete btn.dataset.tipShift; }
    btn.dataset.tip = t('card.tip_cancel');
    _trFlip.snap(btn, ICON.stop);
  } else {
    if (!btn.classList.contains('cancelling')) return;
    btn.classList.remove('cancelling');
    btn.disabled = false;
    if (btn._tipShiftStash != null) { btn.dataset.tipShift = btn._tipShiftStash; delete btn._tipShiftStash; }
    btn.dataset.tip = btn.classList.contains('done') ? _translatedTip() : t('card.tip_translate');
    _trFlip.snap(btn, ICON.translate);
  }
  refreshTooltip();
}

// How a dialog names a chapter: its title, then "#id · N pages".
function chapterDetail(ch, entity, label) {
  const id = entity?.sourceId || ch.id;
  return [label || `#${id}`, t('dlg.detail_pages', { id, n: formatCount(entity?.count || 0) })];
}

async function translateChapter(ch, entity, ev, label) {
  if (!entity) return;
  const btn = ev.currentTarget;
  if (btn.classList.contains('cancelling')) {
    await sendMsg({ type: 'CANCEL_TRANSLATE', galleryId: ch.id });
    return;
  }
  if (btn.disabled) return;

  if (ev.shiftKey && entity.translated) {
    if (!(await confirmDialog({
      title: t('dlg.revert_title'), body: t('dlg.revert_body'),
      detail: chapterDetail(ch, entity, label), cover: coverUrl(ch.id), ok: t('dlg.revert_ok'), danger: true,
    }))) return;
    btn.disabled = true;
    const resp = await sendMsg({ type: 'REVERT_GALLERY', galleryId: ch.id });
    btn.disabled = false;
    if (!resp || resp.ok === false) return;
    await refreshChangedChapter(ch.id, { rowOnly: true });
    return;
  }

  if (entity.count === 0) {
    alertDialog({ title: t('dlg.no_pages_title'), body: t('dlg.no_pages_body'), detail: chapterDetail(ch, entity, label)[0], cover: coverUrl(ch.id) });
    return;
  }
  if (!entity.translated && !(await confirmDialog({
    title: t('dlg.tr_title'), body: t('dlg.tr_body', { n: formatCount(entity.count) }),
    detail: chapterDetail(ch, entity, label), cover: coverUrl(ch.id), ok: t('dlg.tr_ok'),
  }))) return;

  beginChapterJob(ch.id, 'translate', t('prog.translating'));
  const resp = await sendMsg({ type: 'TRANSLATE_GALLERY', galleryId: ch.id });
  if (!resp || resp.ok === false || resp.started === false) discardChapterJob(ch.id);
}

// "Re-run from…": redo every page of a translated chapter from one stage, reusing the rest.
function rerunChapter(ch, entity, ev, label) {
  const btn = ev.currentTarget;
  if (!entity?.translated || btn.disabled || btn.classList.contains('cancelling')) return;
  ev.preventDefault();
  openRerunMenu(btn, ch.id, async (point, stage) => {
    if (!(await confirmDialog({
      title: t('dlg.rerun_title', { stage }), body: t('dlg.rerun_body'),
      detail: chapterDetail(ch, entity, label), cover: coverUrl(ch.id), ok: t('dlg.rerun_ok'),
    }))) return;
    beginChapterJob(ch.id, 'translate', t('prog.translating'));
    const resp = await sendMsg({ type: 'TRANSLATE_GALLERY', galleryId: ch.id, forceFrom: point });
    if (!resp || resp.ok === false || resp.started === false) discardChapterJob(ch.id);
  });
}

function ensureReplaceInput() {
  let input = $('replaceChapterInput');
  if (input) return input;
  input = document.createElement('input');
  input.type = 'file';
  input.id = 'replaceChapterInput';
  input.accept = IMPORT_ACCEPT;
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    const gid = e.target.dataset.gid;
    e.target.value = '';
    if (!files.length || !gid) return;
    const [group] = groupImports(files);
    if (!group) { fileTypeAlert(files[0]); return; }
    beginChapterJob(gid, 'upload', t('prog.reading_file'));
    const ok = await stageImport(group, gid, { skipExisting: false });
    if (!ok) discardChapterJob(gid);
  });
  document.body.appendChild(input);
  return input;
}

async function downloadOrReplaceChapter(ch, entity, ev, label) {
  if (!entity) return;
  const btn = ev.currentTarget;
  if (btn.disabled) return;
  const curCanDl = _canDownload(entity);
  if (ev.shiftKey || !curCanDl) {
    const input = ensureReplaceInput();
    input.dataset.gid = ch.id;
    input.click();
    return;
  }

  const alreadyComplete = entity.numPages > 0 && entity.count >= entity.numPages;
  if (alreadyComplete && !(await confirmDialog({
    title: t('dlg.redl_title'), body: t('dlg.redl_body', { n: formatCount(entity.numPages) }),
    detail: chapterDetail(ch, entity, label), cover: coverUrl(ch.id), ok: t('dlg.redl_ok'),
  }))) return;

  beginChapterJob(ch.id, 'download', t('prog.fetching_meta'));
  const resp = await sendMsg({ type: 'CACHE_ALL_PAGES', galleryId: ch.id, source: entity.source, overwrite: alreadyComplete });
  if (!resp || resp.ok === false || resp.started === false) discardChapterJob(ch.id);
}

function visibleChapterIds() {
  return [...document.querySelectorAll('.ch-row[data-chapter-id]')].map(row => row.dataset.chapterId);
}

function sameOrder(a, b) {
  return a.length === b.length && a.every((id, i) => String(id) === String(b[i]));
}

function findChapterRow(gid) {
  const key = String(gid);
  return [...document.querySelectorAll('.ch-row[data-chapter-id]')].find(row => row.dataset.chapterId === key);
}

const JOB_MSG_LINGER_MS = 4000;
const JOB_STALE_MS = { download: 2 * 60 * 1000, upload: 2 * 60 * 1000 };
const isTerminalJob = (job) => ['done', 'error', 'cancelled', 'interrupted'].includes(job?.status);

function paintChapterJob(row, job) {
  if (!row || !job) return;
  const fill = row.querySelector('.prog-fill');
  const label = row.querySelector('.ch-prog-label');
  const download = row.querySelector('[data-download]');
  const translate = row.querySelector('[data-translate]');
  const isTranslate = job.kind === 'translate';
  const { status } = job;
  // The job layer publishes label/error keys — resolve them to the user's language here.
  const jobLabel = job.labelKey ? t(job.labelKey, job.labelArgs) : job.label;
  const jobError = job.errorKey ? t(job.errorKey) : job.error;

  row.classList.add('working');
  if (fill) { fill.classList.remove('done', 'indeterminate'); fill.style.width = '0%'; }

  if (status === 'error') {
    if (label) label.textContent = `${t('prog.error')}: ${jobError || 'unknown'}`;
    if (isTranslate) setTranslateButtonBusy(translate, false);
    else if (download) download.disabled = false;
    return;
  }
  if (status === 'cancelled') {
    if (label) label.textContent = t('prog.cancelled');
    if (isTranslate) setTranslateButtonBusy(translate, false);
    else if (download) download.disabled = false;
    return;
  }
  if (status === 'interrupted') {
    if (label) label.textContent = t('prog.interrupted');
    if (isTranslate) setTranslateButtonBusy(translate, false);
    else if (download) download.disabled = false;
    return;
  }

  if (status === 'downloading') {
    const { downloaded = 0, total: downloadTotal = 0, pages = 0 } = job;
    if (fill) {
      if (downloadTotal > 0) fill.style.width = Math.min(85, Math.round((downloaded / downloadTotal) * 85)) + '%';
      else { fill.classList.add('indeterminate'); fill.style.width = ''; }
    }
    if (label) {
      label.textContent = pages > 0 && downloadTotal > 0
        ? `~${formatCount(Math.min(pages, Math.round(downloaded * pages / downloadTotal)))} / ${formatCount(pages)} · ${formatBytes(downloaded)}`
        : `↓ ${formatBytes(downloaded)}`;
    }
    if (download) download.disabled = true;
    return;
  }
  if (status === 'extracting') {
    if (fill) fill.style.width = '85%';
    if (label) label.textContent = t('prog.extracting');
    if (download) download.disabled = true;
    return;
  }
  if (status === 'started') {
    if (label) label.textContent = jobLabel || (job.total ? `0 / ${formatCount(job.total)}` : t('prog.starting'));
    if (isTranslate) setTranslateButtonBusy(translate, true);
    else if (download) download.disabled = true;
    return;
  }
  if (status !== 'progress' && status !== 'done') return;

  const done = job.done || 0, total = job.total || 0;
  let pct;
  if (isTranslate) pct = typeof job.pct === 'number' ? job.pct : (total > 0 ? Math.round((done / total) * 100) : 0);
  else if (job.kind === 'upload') pct = total > 0 ? Math.round((done / total) * 100) : 0;
  else pct = total > 0 ? Math.round(85 + (done / total) * 15) : 85;
  if (fill) {
    fill.style.width = pct + '%';
    fill.classList.toggle('done', status === 'done');
  }
  const doneText = formatCount(done), totalText = formatCount(total);
  const skippedNote = job.skipped > 0 ? ` (${t('prog.already_cached', { n: formatCount(job.skipped) })})` : '';
  if (label) {
    if (isTranslate) {
      label.textContent = status === 'done'
        ? `${t('prog.translated')} ${doneText}/${totalText}${job.failed ? ` (${formatCount(job.failed)} failed)` : ''}${job.costNote ? ` · ${job.costNote}` : ''}`
        : jobLabel || `${t('prog.translating')} ${doneText} / ${totalText}`;
    } else {
      label.textContent = status === 'done'
        ? `${t('prog.done')} — ${doneText}/${totalText}${skippedNote}`
        : jobLabel ? `${jobLabel} · ${doneText}/${totalText}${skippedNote}` : `${doneText} / ${totalText}${skippedNote}`;
    }
  }
  if (status === 'done') {
    if (isTranslate) setTranslateButtonBusy(translate, false);
    else if (download) { download.disabled = false; download.textContent = '✓'; download.classList.add('done'); }
  } else if (isTranslate) setTranslateButtonBusy(translate, true);
  else if (download) download.disabled = true;
}

function beginChapterJob(gid, kind, label) {
  applyChapterJob({ gid: String(gid), kind, status: 'started', label });
}

function discardChapterJob(gid) {
  const key = String(gid);
  clearTimeout(_chapterJobClearTimers.get(key));
  _chapterJobClearTimers.delete(key);
  _liveChapterJobs.delete(key);
  refreshChangedChapter(key, { rowOnly: true }).catch(() => {});
}

function applyChapterJob(job) {
  if (!job || job.gid == null || !['download', 'upload', 'translate'].includes(job.kind)) return;
  const gid = String(job.gid);
  clearTimeout(_chapterJobClearTimers.get(gid));
  _chapterJobClearTimers.delete(gid);
  _liveChapterJobs.set(gid, job);
  paintChapterJob(findChapterRow(gid), job);

  if (!isTerminalJob(job)) return;
  refreshChangedChapter(gid, { rowOnly: true }).catch(() => {});
  const timer = setTimeout(() => {
    if (_liveChapterJobs.get(gid) !== job) return;
    _chapterJobClearTimers.delete(gid);
    _liveChapterJobs.delete(gid);
    refreshChangedChapter(gid, { rowOnly: true }).catch(() => {});
  }, JOB_MSG_LINGER_MS);
  _chapterJobClearTimers.set(gid, timer);
}

function updateHeaderSummary(chapters) {
  const el = $('ovMeta');
  if (!el || !_hero) return;
  const owner = chapters.find((c) => String(c.id) === String(ownerId))?.entity;
  if (owner) _hero.owner = owner;
  el.innerHTML = heroMetaHtml(chapters);
  syncFavButton();
  refreshTags();
}

// Rebuild the tag table in place from the owner's current tags (and the library's counts).
let _tagsSeq = 0;
async function refreshTags() {
  const seq = ++_tagsSeq;
  const html = await tagTableHtml(_hero?.owner?.tags);
  if (seq !== _tagsSeq) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  $('ovTags')?.replaceWith(tpl.content);
}

// Re-read the owner and rebuild the header's details, tags and favorite button in place — after
// an edit made here, whose change beacon is held back so the page isn't rebuilt around it.
async function refreshHero() {
  if (!_hero) return;
  const owner = await getGallery(ownerId);
  if (!owner) return;
  updateHeaderSummary(_hero.isSeries ? await getSeriesChapters(ownerId) : [{ id: ownerId, title: '', entity: owner }]);
}
const holdRender = () => { _suppressRenderUntil = Date.now() + 800; };

// ── Tags and favorite ──
function syncFavButton() {
  const btn = $('favToggle');
  if (!btn || !_hero) return;
  const on = !!_hero.owner?.favorite;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.innerHTML = `${ICON.heart}<span>${esc(t(on ? 'ov.favorited' : 'ov.fav_add'))}</span>`;
  if (on) btn.dataset.tip = t('card.tip_fav_remove');
  else delete btn.dataset.tip;
}

// Favoriting doesn't count as an update to the gallery.
async function toggleFavorite() {
  const favorite = !_hero?.owner?.favorite;
  holdRender();
  await store.mutate(ownerId, { favorite }, { touch: false });
  _hero.owner = { ..._hero.owner, favorite };
  syncFavButton();
  refreshTooltip();
}

async function editTag(tag = null) {
  if (await openTagEditor(ownerId, { tag, beforeWrite: holdRender })) await refreshHero();
}

// Shift+click: remove the tag after a confirm, as on a library card.
async function removeTagConfirmed(tag) {
  const label = t(TAG_TYPE_LABEL[tag.type] || 'addtag.cat_tag');
  if (!(await confirmDialog({
    title: t('dlg.tag_title'), body: t('dlg.tag_body'),
    detail: [`${label} · ${tag.name}`, _hero?.heading || ''], cover: $('seriesCover')?.querySelector('img')?.src || '',
    ok: t('dlg.tag_ok'), danger: true,
  }))) return;
  if (await removeTag(ownerId, tag, { beforeWrite: holdRender })) await refreshHero();
}

async function refreshChangedChapter(gid, { rowOnly = false } = {}) {
  const visibleIds = visibleChapterIds();
  if (!visibleIds.length) {
    if (!rowOnly && String(gid) === String(ownerId)) await render();
    return;
  }

  const meta = await metaGet(ownerId);
  const order = (meta?.chapters || []).map(c => String(c.id));
  if (!sameOrder(order, visibleIds)) { if (!rowOnly) await render(); return; }

  const idx = order.indexOf(String(gid));
  if (idx < 0) return;

  const chapters = await getSeriesChapters(ownerId);
  updateHeaderSummary(chapters);

  invalidateCover(gid);
  if (String(gid) === String(ownerId)) {
    invalidateCover(ownerId);
    const refreshedCover = await coverUrl(ownerId, { preferSeries: true, width: 480 });
    setThumb($('seriesCover'), refreshedCover);
    setBackdrop(refreshedCover);
  }

  const oldRow = findChapterRow(gid);
  if (!oldRow || !chapters[idx]) { if (!rowOnly) await render(); return; }
  releasePageTiles(oldRow);   // detach the outgoing row's tiles from the observer/img map
  const nextRow = await chapterRow(chapters[idx], idx, chapters.length);
  oldRow.replaceWith(nextRow);
  applyEditMode(nextRow);
}

async function currentOrder() {
  const meta = await metaGet(ownerId);
  return (meta?.chapters || []).map(c => String(c.id));
}
async function move(idx, delta) {
  const order = await currentOrder();
  const j = idx + delta;
  if (j < 0 || j >= order.length) return;
  [order[idx], order[j]] = [order[j], order[idx]];
  await reorderChapters(ownerId, order);
  ownerId = order[0];   // head may have changed → ownership moved
  await render();
}

// ── Remove modal ──
let _removeTarget = null;
function openRemove(ch, idx) {
  _removeTarget = ch;
  $('removeMsg').textContent = t('ov.remove_msg', { n: idx + 1 });
  $('removeModal').classList.add('open');
}
function closeRemove() { $('removeModal').classList.remove('open'); _removeTarget = null; }
// Chapter-row delete mirrors the library card quick action: plain click confirms, Shift-click skips
// the prompt. The series helper removes/re-owns/dissolves series metadata around the deleted gallery.
async function deleteChapter(ch, { prompt = true, entity = null, label = '' } = {}) {
  if (!ch) return;
  if (prompt && !(await confirmDialog({
    title: t('dlg.del_gallery_title'), body: t('dlg.del_gallery_body'),
    detail: chapterDetail(ch, entity, label), cover: coverUrl(ch.id), ok: t('dlg.delete'), danger: true,
  }))) return;
  _removeTarget = ch;
  await doRemove(true);
}
async function detachChapter(ch) {
  if (!ch) return;
  _removeTarget = ch;
  await doRemove(false);
}
async function doRemove(deleteImages) {
  if (!_removeTarget) return;
  const id = _removeTarget.id;
  const prevOwnerId = ownerId;
  const remaining = (await currentOrder()).filter(gid => gid !== String(id));
  closeRemove();
  const removed = await removeChapter(prevOwnerId, id, { deleteImages });
  if (removed === false) return;

  if (String(id) === String(prevOwnerId)) {
    ownerId = remaining[0] || prevOwnerId;
  } else {
    ownerId = prevOwnerId;
  }

  const series = await resolveSeries(ownerId);
  const ownerExists = series ? true : !!(await getGallery(ownerId));
  if (series) ownerId = series.ownerId;
  else if (!ownerExists) {
    location.replace('../');
    return;
  }
  await render();
}

// ── Add chapter (autocomplete) ──
let _searchSeq = 0;
function wireAdd() {
  const input = $('addSearch');
  const results = $('addResults');
  if (!input) return;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(input.value.trim()), 180);
  });
  input.addEventListener('focus', () => { if (input.value.trim()) runSearch(input.value.trim()); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.add-search-wrap')) results.classList.remove('open');
  });
  wireDrop();
}

async function runSearch(term) {
  const seq = ++_searchSeq;
  const results = $('addResults');
  if (!term) { results.classList.remove('open'); return; }
  const existing = new Set((await currentOrder()));
  existing.add(String(ownerId));
  const lower = term.toLowerCase();
  const match = (g) => (g.id.includes(term) || (g.title && g.title.toLowerCase().includes(lower)));
  const { items } = await store.getPage({ sort: 'updated', page: 1, pageSize: 40, match });
  if (seq !== _searchSeq) return;
  const candidates = items.filter(g => !existing.has(String(g.id))).slice(0, 8);
  if (!candidates.length) { results.innerHTML = `<div class="add-empty">${esc(t('ov.no_results'))}</div>`; results.classList.add('open'); return; }

  results.innerHTML = '';
  for (const g of candidates) {
    const row = document.createElement('div');
    row.className = 'add-res';
    const title = pickTitle(g, getLang()) || `#${g.sourceId || g.id}`;
    row.innerHTML = `<div class="add-res-thumb"><div class="ph"></div></div>
      <div class="add-res-title">${esc(title)}</div><div class="add-res-id">#${esc(g.sourceId || g.id)}</div>`;
    coverUrl(g.id).then(u => setThumb(row.querySelector('.add-res-thumb'), u));
    row.addEventListener('click', async () => {
      results.classList.remove('open');
      $('addSearch').value = '';
      try { await mergeIntoSeries(ownerId, g.id); } catch (err) { chapterFailAlert(err); }
      await render();
    });
    results.appendChild(row);
  }
  results.classList.add('open');
}

const fileTypeAlert = (file) =>
  alertDialog({ title: t('dlg.file_type_title'), body: t('dlg.file_type_body'), detail: file.name, tone: 'error' });
const chapterFailAlert = (err) =>
  alertDialog({ title: t('dlg.chapter_fail_title'), detail: err.message, tone: 'error' });

// ── Drop a file as the next chapter ──
function wireDrop() {
  const bar = $('addBar');
  if (!bar) return;
  let depth = 0;
  bar.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { depth++; bar.classList.add('drag'); } });
  bar.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  bar.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; bar.classList.remove('drag'); } });
  bar.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); depth = 0; bar.classList.remove('drag');
    const { files, folders } = await droppedImports(e.dataTransfer);
    await importChapters(files, folders);
  });
}

// Import files as the next chapters: each archive or PDF is one, loose images together are one
// more, and so are each dropped folder's images.
async function importChapters(files, folders = []) {
  const list = [...files];
  const rejected = list.find((f) => !isImportable(f));
  if (rejected) fileTypeAlert(rejected);
  for (const group of groupImports(list, folders)) await importAsChapter(group);
}

// Import one group as a brand-new gallery, immediately attach it as the next chapter (so it appears
// straight away and fills in as its pages import), then stage it for the durable runner.
async function importAsChapter(group) {
  const gid = nextGalleryId();   // the shared mint — per-context monotonic, never a raw Date.now()
  const at = Number(gid);
  const title = group.name.replace(/\.[^.]+$/, '');
  await store.mutate(gid, { title, count: 0, size: 0, addedAt: at, latestAt: at, isLocalImport: true });
  try { await mergeIntoSeries(ownerId, gid, { title }); } catch (err) { chapterFailAlert(err); return; }
  beginChapterJob(gid, 'upload', t('prog.reading_file'));
  await render();
  const ok = await stageImport(group, gid);
  if (!ok) discardChapterJob(gid);
}

// Minimal mirror of library.js's importSingleFile: stage into OPFS, hand to the SW/runner.
async function stageImport(group, gid, { skipExisting = true } = {}) {
  let buffer;
  try { buffer = await importBytes(group, (p) => beginChapterJob(gid, 'upload', t('prog.rendering', p))); }
  catch {
    alertDialog({ title: t('dlg.file_read_title'), body: t('dlg.file_read_body'), detail: group.name, tone: 'error' });
    return false;
  }
  const tempName = `cbz-${gid}-${Date.now()}.bin`;
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(tempName, { create: true });
    const w = await fh.createWritable();
    await w.write(buffer); await w.close();
  } catch {
    alertDialog({ title: t('dlg.file_stage_title'), body: t('dlg.file_stage_body'), detail: group.name, tone: 'error' });
    return false;
  }
  platform.rpc({ type: 'IMPORT_CBZ', galleryId: gid, tempFile: tempName, filename: group.name, skipExisting });
  return true;
}

// ── Boot ──
$('removeCancel').addEventListener('click', closeRemove);
$('removeDetach').addEventListener('click', () => doRemove(false));
$('removeDelete').addEventListener('click', () => doRemove(true));
$('removeModal').addEventListener('click', (e) => { if (e.target === $('removeModal')) closeRemove(); });
$('settingsBtn').addEventListener('click', () => { location.href = '../settings'; });
// Edit mode: a tag — or the category / rating in the details — opens the tag editor on it, Shift+click
// removes it, and '+' adds one. Outside edit mode a tag chip is a plain link to the library search.
$('ovContent').addEventListener('click', (e) => {
  if (!editMode) return;
  if (e.target.closest('.ov-chip-add')) { editTag(); return; }
  const el = e.target.closest('.ov-chip[data-type], .ov-meta-item[data-tag-type]');
  if (!el) return;
  e.preventDefault();
  const tag = el.dataset.type
    ? { type: el.dataset.type, name: el.dataset.name }
    : { type: el.dataset.tagType, name: el.dataset.tagName };
  if (e.shiftKey) removeTagConfirmed(tag);
  else editTag(tag);
});
$('ovFileInput').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; importChapters(files); });

// Re-render when a member gallery changes (e.g. a chapter import finishes filling pages).
// Row-debounced so download/import feed beacons update only the affected chapter row.
const _refreshTimers = new Map();
store.subscribe('*', (gid) => {
  if (Date.now() < _suppressRenderUntil) return;
  const key = String(gid);
  clearTimeout(_refreshTimers.get(key));
  _refreshTimers.set(key, setTimeout(() => {
    _refreshTimers.delete(key);
    refreshChangedChapter(key).catch(() => render().catch(() => {}));
  }, 150));
});

platform.jobs.subscribe(applyChapterJob);

(async () => {
  applyTranslations(document);
  const g = params.get('g');
  if (!g) { $('ovContent').innerHTML = `<div class="ov-empty">${esc(t('ov.not_found'))}</div>`; return; }
  // These round trips are independent of local content. Start them immediately, but do not hold
  // the first render behind their timeouts.
  const availabilityProbe = updateExtStatus().catch(() => false);
  updateTranslatorStatus();
  const series = await resolveSeries(g);
  ownerId = series ? series.ownerId : g;
  const jobs = await platform.jobs.current();
  const hydratedJobs = [];
  for (const job of jobs) {
    if (!['download', 'upload', 'translate'].includes(job.kind)) continue;
    if (job.kind !== 'translate' && (Date.now() - (job.at || 0)) > (JOB_STALE_MS[job.kind] || 2 * 60 * 1000)) {
      await platform.jobs.clear(job.gid, job.kind);
      hydratedJobs.push({ ...job, status: 'interrupted' });
    } else hydratedJobs.push(job);
  }
  for (const job of hydratedJobs) _liveChapterJobs.set(String(job.gid), job);
  await render();
  for (const job of hydratedJobs) applyChapterJob(job);
  availabilityProbe.then(changed => { if (changed) refreshDownloadControls(); });
})();

function updateTranslatorStatus() {
  return sendMsg({ type: 'TRANSLATOR_PING' }).then(resp => {
    document.body.classList.toggle('translator-offline', !(resp && resp.online));
  }, () => document.body.classList.add('translator-offline'));
}
document.body.classList.add('translator-offline');
setInterval(updateTranslatorStatus, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateTranslatorStatus(); });

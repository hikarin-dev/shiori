// overview.js — the series overview page: the middle landing before the reader. Lists a series'
// chapters in order, lets the user rename the series and each chapter, reorder, remove, add a
// chapter from an existing gallery (autocomplete) or by dropping a file, and jump into any chapter.

import './boot.js';
import * as api from './api.js';
import * as store from './store.js';
import * as platform from './platform.js';
import { request as extRequest } from './ext-bridge.js';
import { canDownload as _canDownload, updateSitesStatus as updateExtStatus, galleryLink, siteName } from './sites.js';
import { resolveSeries, getSeriesChapters, mergeIntoSeries, removeChapter, reorderChapters, setChapterTitle, setSeriesTitle, setGalleryTitle, canDetachChapter, chapterNumberLabel, chapterTally } from './series.js';
import { t, getLang, applyTranslations } from './i18n.js';
import { pickTitle, pickSeriesTitle, normalizeTitle, seriesTitleObject } from './titles.js';
import { initTooltips, refreshTooltip, onModifiers } from './tooltip.js';
import { initDropdowns } from './dropdown.js';
import { formatBytes, formatCount, formatCompact, formatMegapixels } from './format.js';
import { describePage } from './page-size.js';
import { memberKind } from './gallery-model.js';
import { escHtml } from './sanitize.js';
import { resizeToWidth, imageToBlob } from './image-util.js';
import { IMPORT_ACCEPT, groupImports, importBytes, isImportable, droppedImports } from './import-files.js';
import { startImport } from './jobs-runner.js';
import { handImport } from './submit-job.js';
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
  const counts = list.length ? await api.galleries.tagCounts({ keys: list.map((tg) => tagKey(tg.type, tg.name)) }) : new Map();
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
  const { isSeries, owner, ownerMeta, kind } = _hero;
  const tags = owner?.tags || [];
  const names = (type) => tags.filter((tg) => tg.type === type).map((tg) => tg.name).join(', ');
  const items = [];
  const item = (icon, text, { tip = '', badge = '', cls = '', tag = '' } = {}) => items.push(
    `<span class="ov-meta-item${cls ? ' ' + cls : ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}${badge ? ` data-tip-badge="${esc(badge)}"` : ''}${tag ? ` data-tag-type="${tag}" data-tag-name="${esc(tags.find((tg) => tg.type === tag).name)}"` : ''}>${icon}<span>${esc(text)}</span></span>`);
  const category = names('category'), rating = names('rating');
  if (category) item(META_ICON.category, category, { tip: t('filter.category'), cls: 'cap', tag: 'category' });
  if (rating) item(META_ICON.rating, rating, { tip: t('filter.rating'), cls: 'cap', tag: 'rating' });
  if (isSeries && kind === 'volume') {
    item(META_ICON.chapters, `${formatCount(chapters.filter(c => memberKind(c) === 'volume').length)} ${t('ov.volumes')}`);
  } else if (isSeries) {
    const tally = chapterTally(chapters);
    item(META_ICON.chapters, `${formatCount(tally.chapters)} ${t('ov.chapters')}${tally.extras ? ` · ${t('card.extras_n', { n: formatCount(tally.extras) })}` : ''}`);
  }
  const count = chapters.reduce((s, c) => s + (c.entity?.count || 0), 0);
  const size = chapters.reduce((s, c) => s + (c.entity?.size || 0), 0);
  const orig = chapters.reduce((s, c) => s + (c.entity?.origSize || 0), 0);
  const total = !isSeries && owner?.numPages ? ` / ${formatCount(owner.numPages)}` : '';
  item(META_ICON.pages, `${formatCount(count)}${total} ${t('card.pages')}`,
    { tip: count ? t('card.tip_page_avg', { size: formatBytes(orig / count) }) : '' });
  // Hovering the size splits it, as the library card does: the original pages, and the rest.
  item(META_ICON.size, formatBytes(size), { tip: t('lib.size_split', { orig: formatBytes(orig), rest: formatBytes(Math.max(0, size - orig)) }) });
  const page = describePage(isSeries ? owner?.aggMedianPage : owner?.medianPage);
  if (page) item(META_ICON.resolution, `${page.w}×${page.h}`, { tip: formatMegapixels(page.mp), badge: page.tier });
  if (!isSeries && owner?.translated) item(ICON.translate, t('ov.translated'), { cls: 'done' });
  // A library kept as files says when a gallery's (or any member's) files can't be found.
  if (chapters.some(c => c.entity?.missing)) item('', t('card.files_missing'), { cls: 'missing' });
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
// row → what it shows now ({ ch, e, idx, total, displayTitle, … }). A row is kept across renders
// and its handlers read this when they fire, so a row that moved or changed acts on what it shows.
const _rowState = new WeakMap();

const $ = (id) => document.getElementById(id);
const esc = escHtml;
// Change an element only where it differs, so a render that finds nothing new touches nothing.
const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
const setAttr = (el, name, value) => { if (el && el.getAttribute(name) !== value) el.setAttribute(name, value); };
const setHtml = (el, html) => { if (el && el._html !== html) { el._html = html; el.innerHTML = html; } };
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
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
  heart:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
  download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>',
  translate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
  revert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  detach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7H7a5 5 0 0 0 0 10h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/><path d="M8 12h8"/><path d="m4 4 16 16"/></svg>',
  removeShift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M9 13l2 2 4-4"/></svg>',
  grip:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg>',
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
      const made = await _makePageThumb(img, width);
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

async function _makePageThumb(img, width) {
  const rec = await api.pages.get(img.dataset.gid, Number(img.dataset.pageNum)).catch(() => null);
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

// One page's tile: a page url and a reader link; the image fills in lazily as it nears the view.
function pageTile(gid, pageNum, url) {
  const a = document.createElement('a');
  a.className = 'ov-page';
  a.href = `${readerHref(gid)}&page=${pageNum}`;
  a.draggable = false;
  const img = document.createElement('img');
  img.alt = ''; img.decoding = 'async'; img.dataset.pageUrl = url;
  img.dataset.gid = gid; img.dataset.pageNum = pageNum;
  _pageThumbImg.set(url, img);
  const num = document.createElement('span');
  num.className = 'ov-page-num';
  num.textContent = pageNum;
  a.append(img, num);
  _pageMountObserver.observe(img);
  _pageUnmountObserver.observe(img);
  return a;
}

// Fill a container with one tile per cached page of a gallery, or bring it up to date: the tiles
// it has stay as they are (thumbnails and all), new pages get tiles, and gone ones are dropped.
async function syncPageGrid(container, gid) {
  if (!container) return;
  const seq = container._gridSeq = (container._gridSeq || 0) + 1;
  const keys = await api.pages.list(gid);
  if (seq !== container._gridSeq || !container.isConnected) return;
  const keyOf = (pageNum, url) => `${pageNum}\n${url}`;
  const old = new Map([...container.querySelectorAll(':scope > .ov-page')].map((a) => {
    const img = a.querySelector('img');
    return [keyOf(img.dataset.pageNum, img.dataset.pageUrl), a];
  }));
  if (!keys.length) {
    if (!old.size && container.firstElementChild) return;
    releasePageTiles(container);
    container.innerHTML = `<div class="ov-pages-empty">${esc(t('ov.no_pages'))}</div>`;
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

// Drop a cover into an A4-ratio thumbnail box, matching the library card: a portrait image fills
// the box (cover), a landscape one is contained so it isn't cropped. `container` is the fixed-ratio
// wrapper; the .landscape class follows the image's dimensions. The image is decoded before it
// takes the box, so the box never shows empty in between, and the cover it already shows is kept.
const _thumbOf = new WeakMap();   // box → the cover url it shows (or is about to)
function setThumb(container, url) {
  if (!container || !url || _thumbOf.get(container) === url) return;
  _thumbOf.set(container, url);
  const img = new Image();
  img.className = 'ov-thumb';
  img.alt = '';
  img.src = url;
  img.decode().then(() => {
    if (_thumbOf.get(container) !== url) return;   // a newer cover took the box meanwhile
    const landscape = img.naturalWidth >= img.naturalHeight;
    img.classList.toggle('landscape', landscape);
    container.classList.toggle('landscape', landscape);
    container.replaceChildren(img);
  }, () => {});
}

// The same cover, blurred and faint, behind the header.
function setBackdrop(url) {
  const el = $('ovBackdrop');
  if (!el || !url || el._url === url) return;
  el._url = url;
  el.style.backgroundImage = `url("${url}")`;
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
// The page is built once. Each render after that reads the gallery again and changes only what
// differs: rows are kept and updated in place, a row that moved slides to its new place, and a
// cover already shown stays until a different one is ready — so nothing blanks or flickers.
let _shell = null;   // the built page ({ isSeries } of what its list shows), null before the first render
let _renderSeq = 0, _renderAfterDrag = false;
async function render() {
  if (_drag) { _renderAfterDrag = true; return; }   // the drop renders once it lands
  _renderAfterDrag = false;
  const seq = ++_renderSeq;
  await _orderSave;   // never read an order a pending save is about to replace
  const content = $('ovContent');
  const series = await resolveSeries(ownerId);
  if (series) ownerId = series.ownerId;
  const ownerEntity = await api.galleries.get(ownerId);
  if (!ownerEntity && !series) {
    if (seq !== _renderSeq) return;
    releasePageTiles(content);
    _shell = null;
    content.innerHTML = `<div class="ov-empty">${esc(t('ov.not_found'))}</div>`;
    return;
  }
  const isSeries = !!series;

  // A series lists one kind of member at a time — its chapters or its volumes — while its totals
  // count them all.
  const members = isSeries
    ? await getSeriesChapters(ownerId)
    : [{ id: ownerId, title: '', entity: ownerEntity }];
  const ownerMeta = await api.meta.get(ownerId);
  const tagsHtml = _shell ? '' : await tagTableHtml(ownerEntity?.tags);
  if (seq !== _renderSeq) return;
  if (_drag) { _renderAfterDrag = true; return; }

  const kind = isSeries ? shownKind(members) : 'chapter';
  _shownKind = kind;
  const chapters = isSeries ? members.filter(m => memberKind(m) === kind) : members;
  const totalPages = members.reduce((s, c) => s + (c.entity?.count || 0), 0);
  const heading = isSeries
    ? (pickSeriesTitle(ownerMeta?.seriesTitle, ownerEntity, getLang()) || `#${ownerId}`)
    : (pickTitle(ownerEntity, getLang()) || `#${ownerId}`);
  const seriesFallback = pickTitle(ownerEntity, getLang()) || `#${ownerId}`;
  const startHref = readerHref((chapters[0] || members[0]).id);
  const titles = isSeries ? (seriesTitleObject(ownerMeta?.seriesTitle) || normalizeTitle(ownerEntity)) : normalizeTitle(ownerEntity);
  const subtitle = altTitle(titles, heading);
  _hero = { isSeries, owner: ownerEntity, ownerMeta, heading, kind };

  const firstBuild = !_shell;
  if (firstBuild) buildShell(tagsHtml);
  else refreshTags();

  // Paint the header cover as soon as it resolves instead of behind the chapter list: a long
  // series builds many rows, and the head must not wait for the last one. A cover that resolves
  // after ownership has moved on is dropped.
  const coverOwner = String(ownerId);
  coverUrl(ownerId, { preferSeries: isSeries, width: 480 }).then((url) => {
    if (String(ownerId) !== coverOwner) return;
    setThumb($('seriesCover'), url);
    setBackdrop(url);
  }).catch(() => {});

  // Both a series and a standalone gallery expose an editable owner title in edit mode: a series
  // edits its multi-language seriesTitle, a standalone gallery edits its own `title` object. A
  // title being typed is left alone.
  const titleInput = content.querySelector('.series-title-input');
  titleInput.id = isSeries ? 'seriesTitle' : 'galleryTitle';
  titleInput.placeholder = isSeries ? t('ov.series_title_ph') : t('ov.gallery_title_ph');
  titleInput.dataset.fallback = seriesFallback;
  if (document.activeElement !== titleInput && titleInput.dataset.original !== heading) {
    titleInput.dataset.original = heading;
    titleInput.value = editMode ? heading : (heading.trim() || seriesFallback);
    resizeTitleArea(titleInput);
  }
  const titleOpen = content.querySelector('.series-title-open');
  setAttr(titleOpen, 'href', startHref);
  setAttr(titleOpen, 'aria-label', heading);
  setText($('ovSubtitle'), subtitle);
  $('ovSubtitle').hidden = !subtitle;
  setAttr($('seriesCover'), 'href', startHref);
  setAttr($('readStart'), 'href', startHref);
  syncFavButton();
  // A library that keeps galleries as files can pack this one — a series: every member — into an
  // archive now; once all of it is, the button says so.
  const archiveButton = $('archiveNow');
  if (archiveButton) {
    const archived = members.every(m => m.entity?.archived);
    archiveButton.disabled = archived;
    setHtml(archiveButton, `${ICON.archive}<span>${esc(t(archived ? 'ov.archived' : 'ov.archive'))}</span>`);
  }
  const source = galleryLink(ownerEntity, 1);
  const sourceLink = $('ovSource');
  sourceLink.style.display = source ? '' : 'none';
  if (source) {
    setAttr(sourceLink, 'href', source);
    setAttr(sourceLink, 'data-tip', `${siteName(ownerEntity?.source)}: ${source}`);
  }
  setHtml($('ovMeta'), heroMetaHtml(members));

  syncSection(isSeries, kind, isSeries ? chapters.length : totalPages);
  setText($('addHeading'), t(kind === 'volume' ? 'ov.add_volume' : 'ov.add_chapter'));
  if (isSeries) syncChapterList($('chList'), chapters);
  if (firstBuild) {
    applyEditMode();
    applyTranslations(content);   // fill any [data-i18n] nodes in the freshly-built content
  }
  if (!isSeries) await syncPageGrid($('ovPages'), ownerId);
}

// The page's frame, made by the first render; the renders after it only fill it in.
function buildShell(tagsHtml) {
  const content = $('ovContent');
  releasePageTiles(content);
  content.innerHTML = `
    <section class="ov-hero">
      <div class="ov-backdrop" id="ovBackdrop" aria-hidden="true"></div>
      <a class="series-cover" id="seriesCover" draggable="false"><div class="ph">📚</div></a>
      <div class="series-info">
        <div class="series-title-wrap editable"><textarea class="series-title-input" rows="1"></textarea><a class="series-title-open"></a></div>
        <div class="ov-subtitle" id="ovSubtitle" hidden></div>
        <div class="series-actions">
          <a class="ov-btn primary" id="readStart">${ICON.read}<span>${esc(t('ov.read_start'))}</span></a>
          <button class="ov-btn fav" id="favToggle" type="button"></button>
          <button class="ov-btn" id="editToggle"></button>
          ${api.capabilities.archive ? `<button class="ov-btn" id="archiveNow" type="button" data-tip="${esc(t('ov.archive_tip'))}"></button>` : ''}
          <a class="ov-btn" id="ovSource" target="_blank" rel="noopener noreferrer">${ICON.open}<span>${esc(t('page.source'))}</span></a>
        </div>
        <div class="ov-meta" id="ovMeta"></div>
        ${tagsHtml}
      </div>
    </section>
    <h2 class="ov-section-title" id="ovSection"></h2>
    <div id="ovBody"></div>
    <div class="add-bar" id="addBar">
      <h3 id="addHeading"></h3>
      <div class="add-search-wrap">
        <input class="add-search" id="addSearch" placeholder="${esc(t('ov.add_search_ph'))}" autocomplete="off" spellcheck="false">
        <div class="add-results" id="addResults"></div>
      </div>
      <div class="add-hint">${esc(t('ov.add_hint'))}</div>
    </div>`;
  _shell = { isSeries: null };
  _tagsSeq++;   // these tags supersede any refresh still reading its counts
  _tagsKey = JSON.stringify(_hero.owner?.tags || []);
  // Edit the owner title variant for the current app language; other languages are preserved. A
  // series saves its seriesTitle, a standalone gallery saves its own title.
  const ownerInput = content.querySelector('.series-title-input');
  ownerInput.addEventListener('input', (e) => resizeTitleArea(e.target));
  ownerInput.addEventListener('change', (e) => saveOwnerTitleInput(e.target));
  $('editToggle').addEventListener('click', () => setEditMode(!editMode));
  $('archiveNow')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const { kept } = await api.galleries.archive(ownerId);
      if (kept.length) alertDialog({ title: t('ov.archive_kept_title'), body: t('ov.archive_kept') });
    } catch (err) {
      alertDialog({ title: t('ov.archive_kept_title'), body: String(err?.message || err), tone: 'error' });
    }
    render().catch(() => {});
  });
  $('favToggle').addEventListener('click', toggleFavorite);
  wireAdd();
}

// The heading over the list — a series' chapters/volumes switch, or a gallery's pages — with its
// count, and the list under it, which is made again only when a gallery becomes a series or back.
function syncSection(isSeries, kind, count) {
  const head = $('ovSection');
  if (_shell.isSeries !== isSeries) {
    _shell.isSeries = isSeries;
    const body = $('ovBody');
    releasePageTiles(body);
    head.innerHTML = `${isSeries ? viewToggleHtml(kind) : esc(t('card.pages'))}<span class="ov-count"></span>`;
    body.innerHTML = isSeries ? '<div class="ch-list" id="chList"></div>' : '<div class="ov-pages" id="ovPages"></div>';
    for (const button of head.querySelectorAll('[data-view]')) {
      button.addEventListener('click', () => {
        if (button.classList.contains('active')) return;
        _view = _forcedView = button.dataset.view;
        platform.kv.set({ seriesView: _view });
        render().catch(() => {});
      });
    }
  }
  for (const button of head.querySelectorAll('[data-view]')) {
    const on = button.dataset.view === (kind === 'volume' ? 'volumes' : 'chapters');
    button.classList.toggle('active', on);
    setAttr(button, 'aria-selected', String(on));
  }
  setText(head.querySelector('.ov-count'), formatCount(count));
}

// Bring the list to `chapters`: a row is kept for each chapter it already shows and updated in
// place, new chapters get rows, gone ones lose theirs, and the rows that changed places slide.
function syncChapterList(list, chapters) {
  const old = new Map([...list.children].map(row => [row.dataset.chapterId, row]));
  const rows = chapters.map((ch, i) => {
    const id = String(ch.id);
    const row = old.get(id);
    // A chapter whose gallery went missing (or came back) is laid out differently: a new row.
    if (row && !!_rowState.get(row)?.e === !!ch.entity) {
      old.delete(id);
      updateChapterRow(row, ch, i, chapters.length);
      return row;
    }
    const fresh = chapterRow(ch, i, chapters.length);
    applyEditMode(fresh);
    return fresh;
  });
  // The number column fits the longest label (1084.5) so every row's thumbnail lines up.
  const numChars = String(Math.max(1, ...chapters.map((c, i) => String(chapterNumberLabel(c) ?? i + 1).length)));
  if (list.style.getPropertyValue('--ch-num-chars') !== numChars) list.style.setProperty('--ch-num-chars', numChars);
  if (!old.size && rows.length === list.children.length && rows.every((row, i) => list.children[i] === row)) return;
  flipRows(list, () => {
    for (const row of old.values()) { releasePageTiles(row); row.remove(); }
    rows.forEach((row, i) => { if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null); });
  });
}

// Rows change places with a FLIP animation: where each row shows is read before `mutate` changes
// the list and again after, and each row that moved slides from the old place to the new one. A
// slide still running is picked up from where it is; rows that stay off screen just move.
const FLIP_MS = 220;
const FLIP_EASING = 'cubic-bezier(.2, .8, .2, 1)';
const _reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function flipRows(list, mutate) {
  const before = new Map([...list.children].map(row => [row, row.getBoundingClientRect().top]));
  for (const row of before.keys()) for (const a of row.getAnimations()) a.cancel();
  const focused = document.activeElement;
  mutate();
  // Moving a row out of the DOM and back drops its focus; give it back.
  if (focused !== document.activeElement && focused?.isConnected) focused.focus({ preventScroll: true });
  if (_reducedMotion.matches) return;
  for (const row of list.children) {
    const was = before.get(row);
    if (was == null) continue;
    const now = row.getBoundingClientRect().top;
    const offScreen = Math.max(was, now) < -row.offsetHeight || Math.min(was, now) > innerHeight;
    if (Math.abs(was - now) < 0.5 || offScreen) continue;
    row.animate([{ transform: `translateY(${was - now}px)` }, { transform: 'none' }], { duration: FLIP_MS, easing: FLIP_EASING });
  }
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

// One chapter's row. updateChapterRow fills it in, and every later render calls that on the same
// row rather than making it again.
function chapterRow(ch, idx, total) {
  const row = document.createElement('div');
  const e = ch.entity;
  row.className = 'ch-row' + (e ? '' : ' missing');
  row.dataset.chapterId = String(ch.id);
  // The grip leads the row: dragging it moves the row through the list. The expand/collapse toggle
  // at the end reveals this chapter's pages as an accordion grid — shown only outside edit mode
  // (CSS), after the hover-revealed action buttons.
  row.innerHTML = `
    <div class="ch-head">
      <span class="ch-grip" data-tip="${esc(t('ov.drag_reorder'))}">${ICON.grip}</span>
      <div class="ch-num"></div>
      ${e ? '<a class="ch-thumb link" draggable="false"><div class="ph">📄</div></a>' : '<div class="ch-thumb"><div class="ph">📄</div></div>'}
      <div class="ch-main">
        <div class="ch-title-wrap">
          <span class="ch-title-sizer" aria-hidden="true"></span>
          <input class="ch-title-input" size="1" data-chapter-id="${esc(ch.id)}">
          <a class="ch-title-open"></a>
        </div>
        <div class="ch-meta"></div>
        <div class="ch-progress">
          <div class="prog-track"><div class="prog-fill"></div></div>
          <span class="ch-prog-label"></span>
        </div>
      </div>
      <div class="ch-actions"></div>
      ${e ? `<button class="ch-ibtn ch-expand" data-expand aria-expanded="false" data-tip="${esc(t('ov.show_pages'))}">${ICON.down}</button>` : ''}
    </div>
    <div class="ch-pages"></div>`;
  _rowState.set(row, { ch, e });

  const titleInput = row.querySelector('.ch-title-input');
  titleInput.addEventListener('input', (ev) => {
    ev.target.dataset.editValue = ev.target.value;
    updateChapterLinkFromInput(ev.target);
  });
  titleInput.addEventListener('change', (ev) => saveChapterTitleInput(ev.target));
  row.querySelector('.ch-grip').addEventListener('pointerdown', (ev) => startRowDrag(ev, row));
  const expand = row.querySelector('[data-expand]');
  if (expand) expand.addEventListener('click', () => toggleChapterPages(row, expand));
  updateChapterRow(row, ch, idx, total);

  // Thumbnails stream in per row rather than gating it: a long series would otherwise build its
  // list one cover round-trip at a time. `row` is this call's own element, so it stays valid.
  if (e) coverUrl(ch.id).then((url) => setThumb(row.querySelector('.ch-thumb'), url)).catch(() => {});
  return row;
}

// Bring a row up to date with `ch` at place `idx` of `total`, changing only what differs. A title
// being typed (or not saved yet) is left as it is.
function updateChapterRow(row, ch, idx, total) {
  const st = _rowState.get(row);
  const e = ch.entity;
  const countChanged = st.e?.count !== e?.count;
  const title = pickTitle(e, getLang()) || '';
  const href = readerHref(ch.id);
  const num = chapterNumberLabel(ch) ?? idx + 1;
  const nameKey = memberKind(ch) === 'volume' ? 'ov.volume_n' : 'ov.chapter_n';
  const custom = ch.title || '';
  const fallbackTitle = title || t(nameKey, { n: num });
  Object.assign(st, { ch, e, idx, total, displayTitle: custom || fallbackTitle });

  setText(row.querySelector('.ch-num'), String(num));
  setAttr(row.querySelector('.ch-thumb.link'), 'href', href);
  setAttr(row.querySelector('.ch-title-open'), 'href', href);
  const input = row.querySelector('.ch-title-input');
  const typing = document.activeElement === input
    || (input.dataset.editValue ?? '').trim() !== (input.dataset.original ?? '').trim();
  if (!typing) {
    input.dataset.original = custom;
    input.dataset.editValue = custom;
    input.dataset.fallback = fallbackTitle;
    input.placeholder = fallbackTitle;
    const value = editMode ? custom : (custom.trim() || fallbackTitle);
    if (input.value !== value) input.value = value;
    updateChapterLinkFromInput(input);
  }
  const pageStr = e ? `${formatCount(e.count)}${e.numPages ? ` / ${formatCount(e.numPages)}` : ''} ${t('card.pages')}` : t('ov.missing');
  const translated = e?.translated ? `<span class="done">${esc(t('ov.translated'))}</span>` : '';
  setHtml(row.querySelector('.ch-meta'), `<span>#${esc(e?.sourceId || ch.id)}</span><span>${esc(pageStr)}</span>${translated}${e?.missing ? `<span class="missing">${esc(t('card.files_missing'))}</span>` : ''}`);
  syncRowActions(row);
  // An open page grid takes in the pages that arrived.
  if (countChanged && row.classList.contains('expanded')) syncPageGrid(row.querySelector('.ch-pages'), ch.id);
}

// The row's buttons, made again only when what they offer changes (a job starting or ending, the
// chapter translated, a download possible now). A row that only moved just has its arrows set.
function syncRowActions(row) {
  const st = _rowState.get(row);
  const { ch, e, idx, total } = st;
  const liveJob = _liveChapterJobs.get(String(ch.id));
  const html = rowActionsHtml(e, liveJob);
  const key = `${html}\n${liveJob?.status || ''}`;
  const box = row.querySelector('.ch-actions');
  if (st.actionsKey !== key) {
    st.actionsKey = key;
    box.innerHTML = html;
    wireRowActions(row);
    if (liveJob) paintChapterJob(row, liveJob);
    else row.classList.remove('working');
  }
  box.querySelector('[data-up]').disabled = idx === 0;
  box.querySelector('[data-down]').disabled = idx === total - 1;
}

function rowActionsHtml(e, liveJob) {
  const canDownload = e && _canDownload(e);
  const activeJob = liveJob && !['done', 'error', 'cancelled', 'interrupted'].includes(liveJob.status);
  // A running download's button is its Stop control (as a translation's is); an import's is disabled.
  const stopDownload = activeJob && liveJob.kind === 'download';
  const busyImport = activeJob && liveJob.kind === 'upload';
  const busyTranslate = activeJob && liveJob.kind === 'translate';
  const dlTitle = e?.numPages ? t('card.tip_dl', { n: formatCount(e.numPages) }) : t('card.tip_dl_meta');
  const dlTip = stopDownload ? t('card.tip_stop_dl') : canDownload ? dlTitle : t('card.tip_replace');
  const dlInner = `<span class="ch-dl-inner">${stopDownload ? ICON.stop : canDownload ? ICON.download : ICON.upload}</span>`;
  const downloadAction = e ? `<button class="ch-ibtn download${stopDownload ? ' cancelling' : ''}" data-download data-tip="${esc(dlTip)}"${canDownload && !stopDownload ? ` data-tip-shift="${esc(t('card.tip_replace'))}"` : ''}${busyImport ? ' disabled' : ''}>${dlInner}</button>` : '';
  const translateTip = busyTranslate ? t('card.tip_cancel') : (e?.translated ? _translatedTip() : t('card.tip_translate'));
  const translateAction = e ? `<button class="ch-ibtn translate${e.translated ? ' done' : ''}${busyTranslate ? ' cancelling' : ''}" data-translate data-tip="${esc(translateTip)}"${e.translated && !busyTranslate ? ` data-tip-shift="${esc(t('card.tip_revert'))}"` : ''}><span class="ch-tr-inner">${busyTranslate ? ICON.stop : ICON.translate}</span></button>` : '';
  return `
      <button class="ch-ibtn" data-up data-tip="${esc(t('ov.move_up'))}">${ICON.up}</button>
      <button class="ch-ibtn" data-down data-tip="${esc(t('ov.move_down'))}">${ICON.down}</button>
      ${downloadAction}
      ${translateAction}
      ${canDetachChapter(e) ? `<button class="ch-ibtn detach" data-detach data-tip="${esc(t('ov.remove_detach'))}">${ICON.detach}</button>` : ''}
      <button class="ch-ibtn danger" data-remove data-tip="${esc(t('card.tip_delete'))}" data-tip-shift="${esc(t('card.tip_quickdelete'))}"><span class="ch-del-inner">${ICON.remove}</span></button>`;
}

function wireRowActions(row) {
  const st = () => _rowState.get(row);
  const box = row.querySelector('.ch-actions');
  const download = box.querySelector('[data-download]');
  const translate = box.querySelector('[data-translate]');
  const detach = box.querySelector('[data-detach]');
  const remove = box.querySelector('[data-remove]');
  box.querySelector('[data-up]').addEventListener('click', () => move(row, -1));
  box.querySelector('[data-down]').addEventListener('click', () => move(row, 1));
  if (download) {
    download.addEventListener('mouseenter', () => { _hoveredDlBtn = download; if (_dlCanFlip(download) && _shiftHeld) _dlFlip.to(download, ICON.upload); });
    download.addEventListener('mouseleave', () => { if (_dlCanFlip(download) && _shiftHeld) _dlFlip.to(download, ICON.download); _hoveredDlBtn = null; });
    download.addEventListener('click', (ev) => { const { ch, e, displayTitle } = st(); downloadOrReplaceChapter(ch, e, ev, displayTitle); });
  }
  if (translate) {
    translate.addEventListener('mouseenter', () => { _hoveredTrBtn = translate; if (translate.dataset.tipShift != null && _shiftHeld && !translate.disabled) _trFlip.to(translate, ICON.revert); });
    translate.addEventListener('mouseleave', () => { if (translate.dataset.tipShift != null && _shiftHeld) _trFlip.to(translate, ICON.translate); _hoveredTrBtn = null; });
    translate.addEventListener('click', (ev) => { const { ch, e, displayTitle } = st(); translateChapter(ch, e, ev, displayTitle); });
    translate.addEventListener('contextmenu', (ev) => { const { ch, e, displayTitle } = st(); rerunChapter(ch, e, ev, displayTitle); });
  }
  if (detach) detach.addEventListener('click', () => detachChapter(st().ch));
  remove.addEventListener('mouseenter', () => { _hoveredDelBtn = remove; if (_shiftHeld) _delFlip.to(remove, ICON.removeShift); });
  remove.addEventListener('mouseleave', () => { if (_shiftHeld) _delFlip.to(remove, ICON.remove); _hoveredDelBtn = null; });
  remove.addEventListener('click', (ev) => { const { ch, e, displayTitle } = st(); deleteChapter(ch, { prompt: !ev.shiftKey, entity: e, label: displayTitle }); });
}

// Availability can resolve while a large chapter list is still being built. Reconcile only the
// affected controls after that first render so every row reflects the same result without paying
// for another round of metadata and cover reads.
function refreshDownloadControls() {
  for (const row of document.querySelectorAll('.ch-row[data-chapter-id]')) {
    const entity = _rowState.get(row)?.e;
    const btn = row.querySelector('[data-download]');
    if (!entity || !btn || btn.classList.contains('cancelling')) continue;
    restDownloadButton(btn, entity);
  }
  refreshTooltip();
}

// A download button at rest, as its chapter has it now: Download (Replace under Shift), or Replace.
function restDownloadButton(btn, entity) {
  const canDownload = _canDownload(entity);
  btn.dataset.tip = canDownload
    ? (entity.numPages ? t('card.tip_dl', { n: formatCount(entity.numPages) }) : t('card.tip_dl_meta'))
    : t('card.tip_replace');
  if (canDownload) btn.dataset.tipShift = t('card.tip_replace');
  else delete btn.dataset.tipShift;

  const shifted = canDownload && _shiftHeld && _hoveredDlBtn === btn && !btn.disabled;
  if (btn.querySelector('.ch-dl-inner')) _dlFlip.snap(btn, shifted || !canDownload ? ICON.upload : ICON.download);
}

// Accordion: reveal/hide a chapter's page grid. Pages are built on first open (then kept, so
// re-opening is instant); thumbnails still fill in lazily as they scroll into view.
async function toggleChapterPages(row, btn) {
  const open = row.classList.toggle('expanded');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.dataset.tip = t(open ? 'ov.hide_pages' : 'ov.show_pages');
  refreshTooltip();
  if (open) await syncPageGrid(row.querySelector('.ch-pages'), _rowState.get(row).ch.id);
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

// The same for a running download's button; Replace (Shift) is off meanwhile.
function setDownloadButtonBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    if (btn.classList.contains('cancelling')) return;
    btn.classList.add('cancelling');
    btn.disabled = false;
    delete btn.dataset.tipShift;
    btn.dataset.tip = t('card.tip_stop_dl');
    _dlFlip.snap(btn, ICON.stop);
  } else {
    if (!btn.classList.contains('cancelling')) return;
    btn.classList.remove('cancelling');
    const entity = _rowState.get(btn.closest('.ch-row'))?.e;
    if (entity) restDownloadButton(btn, entity);
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
  if (btn.classList.contains('cancelling')) { await sendMsg({ type: 'STOP_JOB', galleryId: ch.id, kind: 'download' }); return; }
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

// Which members the series list shows: chapters or volumes, remembered for every series. A series
// with none of the chosen kind shows the other, unless the choice was just made on this page.
let _view = 'chapters', _forcedView = null, _shownKind = 'chapter';
function shownKind(members) {
  const want = (_forcedView || _view) === 'volumes' ? 'volume' : 'chapter';
  if (_forcedView || members.some(m => memberKind(m) === want)) return want;
  return members.some(m => memberKind(m) !== want) ? (want === 'volume' ? 'chapter' : 'volume') : want;
}
function viewToggleHtml(kind) {
  return `<span class="ov-view-toggle" role="tablist">${[['chapters', 'chapter', 'ov.chapters'], ['volumes', 'volume', 'ov.volumes']]
    .map(([view, k, key]) => `<button type="button" role="tab" class="ov-view${k === kind ? ' active' : ''}" data-view="${view}" aria-selected="${k === kind}">${esc(t(key))}</button>`).join('')}</span>`;
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
  // While it runs, a translation's or a download's button is its Stop control; an import's is disabled.
  const hold = () => {
    if (isTranslate) setTranslateButtonBusy(translate, true);
    else if (job.kind === 'download') setDownloadButtonBusy(download, true);
    else if (download) download.disabled = true;
  };
  const release = () => {
    if (isTranslate) { setTranslateButtonBusy(translate, false); return; }
    setDownloadButtonBusy(download, false);
    if (download) download.disabled = false;
  };
  // The job layer publishes label/error keys — resolve them to the user's language here.
  const jobLabel = job.labelKey ? t(job.labelKey, job.labelArgs) : job.label;
  const jobError = job.errorKey ? t(job.errorKey) : job.error;

  row.classList.add('working');
  if (fill) { fill.classList.remove('done', 'indeterminate'); fill.style.width = '0%'; }

  if (status === 'error') {
    if (label) label.textContent = `${t('prog.error')}: ${jobError || 'unknown'}`;
    release();
    return;
  }
  if (status === 'cancelled') {
    if (label) label.textContent = t('prog.cancelled');
    release();
    return;
  }
  if (status === 'interrupted') {
    if (label) label.textContent = t('prog.interrupted');
    release();
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
    hold();
    return;
  }
  if (status === 'extracting') {
    if (fill) fill.style.width = '85%';
    if (label) label.textContent = t('prog.extracting');
    hold();
    return;
  }
  if (status === 'started') {
    if (label) label.textContent = jobLabel || (job.total ? `0 / ${formatCount(job.total)}` : t('prog.starting'));
    hold();
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
    release();
    if (!isTranslate && download) { download.textContent = '✓'; download.classList.add('done'); }
  } else hold();
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
  setHtml(el, heroMetaHtml(chapters));
  syncFavButton();
  refreshTags();
}

// Rebuild the tag table in place from the owner's current tags (and the library's counts) — when
// they changed since it was last built.
let _tagsSeq = 0, _tagsKey = '';
async function refreshTags() {
  const tags = _hero?.owner?.tags;
  const key = JSON.stringify(tags || []);
  if (key === _tagsKey) return;
  const seq = ++_tagsSeq;
  const html = await tagTableHtml(tags);
  if (seq !== _tagsSeq) return;
  _tagsKey = key;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  $('ovTags')?.replaceWith(tpl.content);
}

// Re-read the owner and rebuild the header's details, tags and favorite button in place — after
// an edit made here, whose change beacon is held back so the page isn't rebuilt around it.
async function refreshHero() {
  if (!_hero) return;
  const owner = await api.galleries.get(ownerId);
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
  setHtml(btn, `${ICON.heart}<span>${esc(t(on ? 'ov.favorited' : 'ov.fav_add'))}</span>`);
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
  await _orderSave;
  const visibleIds = visibleChapterIds();
  if (!visibleIds.length) {
    if (!rowOnly && String(gid) === String(ownerId)) await render();
    return;
  }

  const meta = await api.meta.get(ownerId);
  const order = (meta?.chapters || []).filter(c => memberKind(c) === _shownKind).map(c => String(c.id));
  if (!sameOrder(order, visibleIds)) { if (!rowOnly) await render(); return; }

  const idx = order.indexOf(String(gid));
  if (idx < 0) return;

  const members = await getSeriesChapters(ownerId);
  updateHeaderSummary(members);
  const chapters = members.filter(c => memberKind(c) === _shownKind);

  // Covers are read again; one that is unchanged leaves its box as it is.
  invalidateCover(gid);
  if (String(gid) === String(ownerId)) {
    invalidateCover(ownerId);
    const refreshedCover = await coverUrl(ownerId, { preferSeries: true, width: 480 });
    setThumb($('seriesCover'), refreshedCover);
    setBackdrop(refreshedCover);
  }

  const row = findChapterRow(gid);
  const ch = chapters[idx];
  if (!row || !ch) { if (!rowOnly) await render(); return; }
  if (!!_rowState.get(row)?.e !== !!ch.entity) {   // its gallery went missing or came back
    releasePageTiles(row);   // detach the outgoing row's tiles from the observer/img map
    const next = chapterRow(ch, idx, chapters.length);
    row.replaceWith(next);
    applyEditMode(next);
    return;
  }
  updateChapterRow(row, ch, idx, chapters.length);
  if (ch.entity) coverUrl(gid).then((url) => setThumb(row.querySelector('.ch-thumb'), url)).catch(() => {});
}

async function currentOrder() {
  const meta = await api.meta.get(ownerId);
  return (meta?.chapters || []).map(c => String(c.id));
}
// Moves a row up or down a place. Its neighbour is the one moved in the DOM, so the pressed
// button keeps its focus.
function move(row, delta) {
  const list = row.parentElement;
  if (!list || _drag) return;
  const rows = [...list.children];
  const other = rows[rows.indexOf(row) + delta];
  if (!other) return;
  flipRows(list, () => list.insertBefore(other, delta < 0 ? row.nextSibling : row));
  commitRowOrder(list).catch(() => {});
}

// The list's rows are in a new order: renumber them at once, save, then render whatever the new
// order changes elsewhere (the head's cover and title when ownership moved, the start link).
async function commitRowOrder(list) {
  const rows = [...list.children];
  rows.forEach((row, i) => { const st = _rowState.get(row); if (st) updateChapterRow(row, st.ch, i, rows.length); });
  await saveShownOrder();
  await render();
}

// Saves the list's order: the places the shown kind holds in the series' order take its rows in
// turn, so the other kind keeps its places. Saves run one after another, each reading the list
// as it is by then, and renders wait for them.
let _orderSave = Promise.resolve();
function saveShownOrder() {
  _orderSave = _orderSave.then(async () => {
    const refs = (await api.meta.get(ownerId))?.chapters || [];
    const order = refs.map(c => String(c.id));
    const shown = visibleChapterIds();
    const slots = order.filter((id, i) => memberKind(refs[i]) === _shownKind);
    const shownSet = new Set(shown);
    if (shown.length !== slots.length || !slots.every(id => shownSet.has(id))) return;   // the list is stale; a render redoes it
    let k = 0;
    const next = refs.map((c, i) => (memberKind(c) === _shownKind ? shown[k++] : order[i]));
    if (sameOrder(next, order)) return;
    await reorderChapters(ownerId, next);
    ownerId = next[0];   // head may have changed → ownership moved
  }).catch(() => {});
  return _orderSave;
}

// ── Drag to reorder ──
// A row's grip drags it along the list. The rows it passes slide aside to open the place where it
// will land, and nothing in the DOM moves until the drop — the way dnd-kit's sortable lists work.
// On release the row settles into that place and the order is saved; Escape puts it back. Near
// the window's top or bottom edge the page scrolls, so a row can travel the whole of a long list.
const DRAG_START_PX = 3;   // a press becomes a drag once it has moved this far
const DRAG_EDGE_PX = 64;   // how near an edge the page starts scrolling
let _drag = null;

function startRowDrag(ev, row) {
  if (ev.button !== 0 || _drag) return;
  const list = row.parentElement;
  const rows = [...list.children];
  if (rows.length < 2) return;
  ev.preventDefault();
  for (const r of rows) for (const a of r.getAnimations()) a.finish();   // measure rows where they land
  const grip = ev.currentTarget;
  grip.setPointerCapture(ev.pointerId);
  const sy = window.scrollY;
  _drag = {
    row, list, rows, grip, pointerId: ev.pointerId,
    from: rows.indexOf(row), to: rows.indexOf(row),
    // Each row's place in page coordinates, so scrolling while dragging doesn't move them.
    slots: rows.map(r => { const b = r.getBoundingClientRect(); return { top: b.top + sy, h: b.height }; }),
    gap: parseFloat(getComputedStyle(list).rowGap) || 0,
    startY: ev.clientY + sy, y: ev.clientY,
    edgeTop: (document.querySelector('body > header')?.getBoundingClientRect().bottom || 0) + DRAG_EDGE_PX,
    active: false, raf: 0, tip: '',
  };
  grip.addEventListener('pointermove', onRowDragMove);
  grip.addEventListener('pointerup', onRowDragUp);
  grip.addEventListener('pointercancel', onRowDragCancel);
  grip.addEventListener('lostpointercapture', onRowDragCancel);
  window.addEventListener('keydown', onRowDragKey, true);
}

function onRowDragMove(ev) {
  if (ev.pointerId !== _drag?.pointerId) return;
  _drag.y = ev.clientY;
  layoutRowDrag();
}
function onRowDragUp(ev) { if (ev.pointerId === _drag?.pointerId) endRowDrag(true); }
function onRowDragCancel() { if (_drag) endRowDrag(false); }
function onRowDragKey(ev) {
  if (ev.key !== 'Escape' || !_drag) return;
  ev.preventDefault();
  ev.stopPropagation();
  endRowDrag(false);
}

// Place the dragged row under the pointer (kept within the list), pick the place it would land in
// — the one nearest where it is now — and slide the rows between there and its own place aside.
function layoutRowDrag() {
  const d = _drag;
  const own = d.slots[d.from];
  const first = d.slots[0], last = d.slots[d.slots.length - 1];
  const pointerDy = d.y + window.scrollY - d.startY;
  if (!d.active) {
    if (Math.abs(pointerDy) < DRAG_START_PX) return;
    d.active = true;
    d.list.classList.add('sorting');
    d.row.classList.add('dragging');
    document.body.classList.add('ch-dragging');
    d.tip = d.grip.dataset.tip || '';   // its tip would otherwise follow the pointer the whole way
    delete d.grip.dataset.tip;
    refreshTooltip();
    d.raf = requestAnimationFrame(rowDragScroll);
  }
  const dy = Math.max(first.top - own.top, Math.min(last.top + last.h - own.top - own.h, pointerDy));
  d.row.style.transform = `translateY(${dy}px)`;
  // Landing below its place, its bottom meets the bottom of the row it passed; above, the tops meet.
  const top = own.top + dy;
  let to = d.from, best = Math.abs(dy);
  d.slots.forEach((s, i) => {
    if (i === d.from) return;
    const distance = Math.abs(top - (i > d.from ? s.top + s.h - own.h : s.top));
    if (distance < best) { best = distance; to = i; }
  });
  if (to === d.to) return;
  d.to = to;
  const shift = own.h + d.gap;
  d.rows.forEach((r, i) => {
    if (i === d.from) return;
    const offset = i > d.from && i <= to ? -shift : i < d.from && i >= to ? shift : 0;
    r.style.transform = offset ? `translateY(${offset}px)` : '';
  });
}

function rowDragScroll() {
  const d = _drag;
  if (!d) return;
  const bottom = innerHeight - DRAG_EDGE_PX;
  const over = d.y < d.edgeTop ? d.y - d.edgeTop : d.y > bottom ? d.y - bottom : 0;
  if (over) {
    const before = window.scrollY;
    window.scrollBy(0, Math.sign(over) * Math.min(24, Math.ceil(Math.abs(over) / 3)));
    if (window.scrollY !== before) layoutRowDrag();
  }
  d.raf = requestAnimationFrame(rowDragScroll);
}

function endRowDrag(commit) {
  const d = _drag;
  _drag = null;
  cancelAnimationFrame(d.raf);
  d.grip.removeEventListener('pointermove', onRowDragMove);
  d.grip.removeEventListener('pointerup', onRowDragUp);
  d.grip.removeEventListener('pointercancel', onRowDragCancel);
  d.grip.removeEventListener('lostpointercapture', onRowDragCancel);
  window.removeEventListener('keydown', onRowDragKey, true);
  if (d.grip.hasPointerCapture(d.pointerId)) d.grip.releasePointerCapture(d.pointerId);
  const moved = commit && d.active && d.to !== d.from;
  if (d.active) {
    if (d.tip) d.grip.dataset.tip = d.tip;
    // The rows that slid aside already stand where the drop puts them, so only the dragged row
    // travels: from under the pointer into its place, above the others until it is there.
    flipRows(d.list, () => {
      d.list.classList.remove('sorting');
      document.body.classList.remove('ch-dragging');
      for (const r of d.rows) r.style.transform = '';
      if (moved) d.list.insertBefore(d.row, d.to > d.from ? d.rows[d.to].nextSibling : d.rows[d.to]);
    });
    const settle = d.row.getAnimations().find((a) => !(a instanceof CSSTransition));
    const settled = () => d.row.classList.remove('dragging');
    if (settle) settle.finished.then(settled, settled);
    else settled();
  }
  if (moved) commitRowOrder(d.list).catch(() => {});
  else if (_renderAfterDrag) render().catch(() => {});
}

// ── Remove modal ──
let _removeTarget = null;
function openRemove(ch, idx) {
  _removeTarget = ch;
  $('removeMsg').textContent = t(memberKind(ch) === 'volume' ? 'ov.remove_vol_msg' : 'ov.remove_msg', { n: chapterNumberLabel(ch) ?? idx + 1 });
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
  const ownerExists = series ? true : !!(await api.galleries.get(ownerId));
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
  const gid = api.newGalleryId();   // the shared mint — per-context monotonic, never a raw Date.now()
  const title = group.name.replace(/\.[^.]+$/, '');
  await api.galleries.create(gid, { title: { english: title, japanese: '', pretty: '' }, isLocalImport: true,
    ...(_shownKind === 'volume' ? { kind: 'volume' } : {}) });
  try { await mergeIntoSeries(ownerId, gid, { title }); } catch (err) { chapterFailAlert(err); return; }
  beginChapterJob(gid, 'upload', t('prog.reading_file'));
  await render();
  const ok = await stageImport(group, gid);
  if (!ok) discardChapterJob(gid);
}

// Minimal mirror of library.js's importSingleFile (jobs-runner.js startImport).
async function stageImport(group, gid, { skipExisting = true } = {}) {
  // The desktop app's runner takes it when there is one, so it goes on whatever this window does.
  if (await handImport({ galleryId: gid, group, skipExisting })) return true;
  let buffer;
  try { buffer = await importBytes(group, (p) => beginChapterJob(gid, 'upload', t('prog.rendering', p))); }
  catch {
    alertDialog({ title: t('dlg.file_read_title'), body: t('dlg.file_read_body'), detail: group.name, tone: 'error' });
    return false;
  }
  if (await startImport({ galleryId: gid, buffer, filename: group.name, skipExisting })) return true;
  alertDialog({ title: t('dlg.file_stage_title'), body: t('dlg.file_stage_body'), detail: group.name, tone: 'error' });
  return false;
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
// A row's buttons stay up while one of them has keyboard focus, but not the focus a click leaves
// behind: the clicked row may slide away from the pointer (an arrow press), and its buttons would
// stay up beside the hovered row's. :focus-visible can't tell them apart — holding Shift (the
// quick-delete key) turns a clicked button's focus visible too — so a key other than a modifier
// marks keyboard use, and a press of the pointer clears it.
let _keyboardFocus = false;
document.addEventListener('keydown', (e) => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) _keyboardFocus = true; }, true);
document.addEventListener('pointerdown', () => { _keyboardFocus = false; }, true);
$('ovContent').addEventListener('focusin', (e) => {
  for (const box of document.querySelectorAll('.ch-actions.key-focus')) box.classList.remove('key-focus');
  if (_keyboardFocus) e.target.closest('.ch-actions')?.classList.add('key-focus');
});

// Re-render when a member gallery changes (e.g. a chapter import finishes filling pages).
// Per row, at most once every 150 ms, so download/import feed beacons update only the affected
// chapter row — and a steady stream of them (an import stores pages faster than that) still paints
// as it goes rather than only once it stops.
const _refreshTimers = new Map();
store.subscribe('*', (gid) => {
  if (Date.now() < _suppressRenderUntil) return;
  const key = String(gid);
  if (_refreshTimers.has(key)) return;
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
  _view = (await platform.kv.get(['seriesView'])).seriesView === 'volumes' ? 'volumes' : 'chapters';
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

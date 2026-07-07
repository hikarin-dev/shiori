// overview.js — the series overview page: the middle landing before the reader. Lists a series'
// chapters in order, lets the user rename the series and each chapter, reorder, remove, add a
// chapter from an existing gallery (autocomplete) or by dropping a file, and jump into any chapter.

import './boot.js';
import { getGallery, coverGet, metaGet } from './db.js';
import * as store from './store.js';
import * as platform from './platform.js';
import { resolveSeries, getSeriesChapters, mergeIntoSeries, removeChapter, reorderChapters, setChapterTitle, setSeriesTitle } from './series.js';
import { t, getLang, applyTranslations } from './i18n.js';
import { pickTitle, pickSeriesTitle } from './titles.js';

// Tag chips styled exactly like the library card (library.css .card-tags / .card-tag), grouped
// artist → tag → female → male. Shown expanded (no collapse) under a chapter's page count.
function tagsHtml(tags) {
  const list = Array.isArray(tags) ? tags : [];
  const groups = [['artist', 'artist', ''], ['tag', '', ''], ['tag:female', '', ' ♀'], ['tag:male', '', ' ♂']];
  const chips = [];
  for (const [type, cls, suffix] of groups)
    for (const tg of list.filter(x => x.type === type))
      chips.push(`<span class="card-tag ${cls}" data-type="${esc(type)}">${esc(tg.name)}${suffix}</span>`);
  return chips.length ? `<div class="card-tags ov-tags">${chips.join('')}</div>` : '';
}

const params  = new URLSearchParams(location.search);
let ownerId   = null;
const _covers = new Map();   // gid → object URL (revoked on re-render)
let editMode  = false;
let _suppressRenderUntil = 0;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const readerHref = (gid) => `../reader?g=${encodeURIComponent(String(gid))}`;
function fmtSize(bytes) {
  if (!bytes) return '0B';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

const ICON = {
  open:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  up:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  down:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  remove: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  read:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  edit:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
  done:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

async function coverUrl(gid) {
  if (_covers.has(gid)) return _covers.get(gid);
  const blob = await coverGet(gid).catch(() => null);
  const url = blob ? URL.createObjectURL(blob) : '';
  _covers.set(gid, url);
  return url;
}
function clearCovers() { for (const u of _covers.values()) if (u) URL.revokeObjectURL(u); _covers.clear(); }

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
  const totalSize  = chapters.reduce((s, c) => s + (c.entity?.size || 0), 0);

  const ownerMeta = isSeries ? await metaGet(ownerId) : meta;
  const heading = isSeries
    ? (pickSeriesTitle(ownerMeta?.seriesTitle, ownerEntity, getLang()) || `#${ownerId}`)
    : (pickTitle(ownerEntity, getLang()) || `#${ownerId}`);
  const seriesFallback = pickTitle(ownerEntity, getLang()) || `#${ownerId}`;
  const startHref = readerHref(chapters[0].id);

  const titleControl = isSeries
    ? `<div class="series-title-wrap editable"><textarea class="series-title-input" id="seriesTitle" rows="1" data-original="${esc(heading)}" data-fallback="${esc(seriesFallback)}" placeholder="${esc(t('ov.series_title_ph'))}">${esc(heading)}</textarea><a class="series-title-open" href="${startHref}" aria-label="${esc(heading)}"></a></div>`
    : `<div class="series-title-wrap"><textarea class="series-title-input" rows="1" readonly tabindex="-1">${esc(heading)}</textarea><a class="series-title-open" href="${startHref}" aria-label="${esc(heading)}"></a></div>`;
  const sub = isSeries
    ? `<span><b>${chapters.length}</b> ${esc(t('ov.chapters'))}</span><span><b>${totalPages}</b> ${esc(t('card.pages'))}</span><span><b>${fmtSize(totalSize)}</b></span>`
    : `<span><b>${totalPages}</b> ${esc(t('card.pages'))}</span><span><b>${fmtSize(totalSize)}</b></span>`;
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

  content.innerHTML = `
    <div class="series-head">
      <a class="series-cover" id="seriesCover" href="${startHref}" draggable="false"><div class="ph">📚</div></a>
      <div class="series-info">
        ${titleControl}
        <div class="series-sub">${sub}</div>
        ${tagsHtml(ownerEntity?.tags)}
        <div class="series-actions">
          <a class="ov-btn primary" id="readStart" href="${startHref}">${ICON.read}<span>${esc(t('ov.read_start'))}</span></a>
          <button class="ov-btn${editMode ? ' active' : ''}" id="editToggle" aria-pressed="${editMode ? 'true' : 'false'}">${editMode ? ICON.done : ICON.edit}<span>${esc(editLabel)}</span></button>
        </div>
      </div>
    </div>
    ${isSeries ? '<div class="ch-list" id="chList"></div>' : ''}
    ${addBar}`;
  content.classList.toggle('ov-editing', editMode);

  setThumb($('seriesCover'), await coverUrl(ownerId));

  if (isSeries) {
    const list = $('chList');
    for (let i = 0; i < chapters.length; i++) list.appendChild(await chapterRow(chapters[i], i, chapters.length));
    // Edit the series title variant for the current app language; other languages are preserved.
    $('seriesTitle').addEventListener('input', (e) => resizeTitleArea(e.target));
    $('seriesTitle').addEventListener('change', (e) => saveSeriesTitleInput(e.target));
  }
  $('editToggle').addEventListener('click', () => setEditMode(!editMode));
  wireAdd();
  applyEditMode();
  applyTranslations(content);   // fill any [data-i18n] nodes in the freshly-built content
}

async function saveVisibleTitles() {
  const seriesInput = $('seriesTitle');
  if (seriesInput) await saveSeriesTitleInput(seriesInput);
  const chapterInputs = [...document.querySelectorAll('.ch-title-input[data-chapter-id]')];
  for (const input of chapterInputs) await saveChapterTitleInput(input);
}

function applyEditMode() {
  const content = $('ovContent');
  if (content) content.classList.toggle('ov-editing', editMode);
  document.querySelectorAll('.series-title-input').forEach(input => {
    const editable = editMode && input.id === 'seriesTitle';
    input.readOnly = !editable;
    input.tabIndex = editable ? 0 : -1;
    if (input.id === 'seriesTitle') {
      const custom = input.dataset.original || '';
      input.value = editMode ? custom : (custom.trim() || input.dataset.fallback || '');
    }
  });
  document.querySelectorAll('.ch-title-input').forEach(input => {
    input.readOnly = !editMode;
    input.tabIndex = editMode ? 0 : -1;
  });
  document.querySelectorAll('.ch-title-input').forEach(input => {
    const custom = input.dataset.editValue || '';
    input.value = editMode ? custom : (custom.trim() || input.dataset.fallback || '');
  });
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

async function saveSeriesTitleInput(input) {
  const next = input.value.trim();
  if (next === (input.dataset.original || '').trim()) return;
  _suppressRenderUntil = Date.now() + 500;
  await setSeriesTitle(ownerId, getLang(), next);
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
  const e = ch.entity;
  const title = pickTitle(e, getLang()) || '';
  const href = readerHref(ch.id);
  const displayTitle = ch.title || title || t('ov.chapter_n', { n: idx + 1 });
  const pageStr = e ? `${e.count}${e.numPages ? ` / ${e.numPages}` : ''} ${t('card.pages')}` : t('ov.missing');
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
  const actions = `
    <div class="ch-actions">
      <button class="ch-ibtn" data-up ${idx === 0 ? 'disabled' : ''} data-tip="${esc(t('ov.move_up'))}">${ICON.up}</button>
      <button class="ch-ibtn" data-down ${idx === total - 1 ? 'disabled' : ''} data-tip="${esc(t('ov.move_down'))}">${ICON.down}</button>
      <button class="ch-ibtn danger" data-remove data-tip="${esc(t('ov.remove'))}">${ICON.remove}</button>
    </div>`;

  row.innerHTML = `
    <div class="ch-num">${idx + 1}</div>
    ${thumbControl}
    <div class="ch-main">
      ${titleControl}
      <div class="ch-meta"><span>#${esc(e?.sourceId || ch.id)}</span><span>${esc(pageStr)}</span>${translated}</div>
    </div>
    ${actions}`;

  if (e) setThumb(row.querySelector('.ch-thumb'), await coverUrl(ch.id));

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
  const remove = row.querySelector('[data-remove]');
  if (up) up.addEventListener('click', () => move(idx, -1));
  if (down) down.addEventListener('click', () => move(idx, 1));
  if (remove) remove.addEventListener('click', () => openRemove(ch, idx));
  return row;
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
async function doRemove(deleteImages) {
  if (!_removeTarget) return;
  const id = _removeTarget.id;
  closeRemove();
  await removeChapter(ownerId, id, { deleteImages });
  // If the owner itself was removed, ownership moved — re-resolve from a surviving chapter.
  const meta = await metaGet(ownerId);
  if (!meta || !Array.isArray(meta.chapters)) {
    const s = await resolveSeries(id === ownerId ? id : ownerId);
    if (s) ownerId = s.ownerId; else { location.replace('../'); return; }
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
      try { await mergeIntoSeries(ownerId, g.id); } catch (err) { alert(err.message); }
      await render();
    });
    results.appendChild(row);
  }
  results.classList.add('open');
}

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
    for (const file of [...e.dataTransfer.files]) await importAsChapter(file);
  });
}

// Import one file as a brand-new gallery, immediately attach it as the next chapter (so it appears
// straight away and fills in as its pages import), then stage it for the durable runner.
async function importAsChapter(file) {
  if (!/\.(zip|cbz)$/i.test(file.name)) { alert(t('ov.only_cbz')); return; }
  const base = Date.now();
  const gid = String(base);
  const title = file.name.replace(/\.[^.]+$/, '');
  await store.mutate(gid, { title, count: 0, size: 0, addedAt: base, latestAt: base, isLocalImport: true });
  try { await mergeIntoSeries(ownerId, gid, { title }); } catch (err) { alert(err.message); return; }
  await stageImport(file, gid);
  await render();
}

// Minimal mirror of library.js's importSingleFile: stage into OPFS, hand to the SW/runner.
async function stageImport(file, gid) {
  const buffer = await file.arrayBuffer();
  const tempName = `cbz-${gid}-${Date.now()}.bin`;
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(tempName, { create: true });
    const w = await fh.createWritable();
    await w.write(buffer); await w.close();
  } catch { alert(t('prog.err_stage')); return; }
  platform.rpc({ type: 'IMPORT_CBZ', galleryId: gid, tempFile: tempName, filename: file.name, skipExisting: true });
}

// ── Boot ──
$('removeCancel').addEventListener('click', closeRemove);
$('removeDetach').addEventListener('click', () => doRemove(false));
$('removeDelete').addEventListener('click', () => doRemove(true));
$('removeModal').addEventListener('click', (e) => { if (e.target === $('removeModal')) closeRemove(); });
$('settingsBtn').addEventListener('click', () => { location.href = '../settings'; });
$('ovFileInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importAsChapter(f); });

// Re-render when a member gallery changes (e.g. a chapter import finishes filling pages).
// Debounced so a burst of feed beacons (or our own mutations) collapses into one repaint.
let _renderTimer = null;
store.subscribe('*', () => {
  if (Date.now() < _suppressRenderUntil) return;
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(() => render().catch(() => {}), 150);
});

(async () => {
  applyTranslations(document);
  const g = params.get('g');
  if (!g) { $('ovContent').innerHTML = `<div class="ov-empty">${esc(t('ov.not_found'))}</div>`; return; }
  const series = await resolveSeries(g);
  ownerId = series ? series.ownerId : g;
  await render();
})();

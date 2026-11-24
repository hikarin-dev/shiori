// import-tracker.js — a batch of imports (import-batch.js) as people follow it: one panel per batch on
// the library and tasks pages, wherever the batch runs. It shows how many titles and bytes are in,
// the title under way and its page, the pace and the time left, the titles found imported already
// and those that failed, and says so when nothing has moved for a while, or when the page running it
// is gone. Its titles open as a list. Also the question a drop of several titles asks first.

import * as platform from './platform.js';
import { t } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { confirmDialog, alertDialog, showToast } from './notice.js';
import { runImportBatch, runningHere } from './import-batch.js';
import { handImportBatch, handBatchToWorker, workerAvailable } from './submit-job.js';
import { paintRunnerTag } from './runner-tag.js';
import { FILTERS, PAINT_EVERY_MS, ROWS_STEP, TITLES_EVERY_MS, batchState, batchView, hasTitles, isLive, titlesSource, titlesView } from './import-batch-view.js';

const STOP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const CLOSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

// ── Starting a batch ──
// Import what a drop or pick holds (`groups`, import-files.js groupImports; `files` and `folders` as
// dropped, which name the batch; `leftOut` the files that are none of what imports): several titles
// ask first. The batch goes to the desktop app's runner when there is one; else to this browser's
// service worker, which carries on whatever this page does while any app page is open (not a batch
// with a PDF: pdf.js draws its pages in a page); else it runs in this page, which then asks before it
// is left. A single title says how it ended unless it simply imported. `attachTo` and `meta` as
// import-batch.js runImportBatch takes them.
export async function importDropped(groups, { files = [], folders = [], leftOut = 0, attachTo = null, meta = {} }) {
  if (!groups.length) return;
  const name = folders.length === 1 && !files.length ? folders[0].name
    : groups.length === 1 ? groups[0].name.replace(/\.[^.]+$/, '') : t('imp.name_items', { n: formatCount(files.length + folders.length) });
  const desktop = typeof globalThis.shioriDesktop?.shell === 'function';
  const pdf = groups.some((g) => !g.paths && /\.pdf$/i.test(g.files[0]?.name || ''));
  const runsIn = desktop ? 'app' : !pdf && workerAvailable() ? 'worker' : 'page';
  if (groups.length > 1 && !await confirmImport(groups, { name, leftOut, runsIn })) return;
  const batch = { id: `import-${Date.now()}`, name, groups, attachTo, meta };
  if (groups.length === 1) _followTitle(batch.id);
  if (await handImportBatch(batch)) return;
  if (!pdf && await handBatchToWorker(batch)) return;
  _guardLeaving();
  await runImportBatch(batch);
}

let _guarded = false;
function _guardLeaving() {
  if (_guarded) return;
  _guarded = true;
  window.addEventListener('beforeunload', (e) => { if (runningHere()) { e.preventDefault(); e.returnValue = ''; } });
}

function _followTitle(id) {
  const off = platform.jobs.subscribe((e) => {
    if (e?.type !== 'IMPORT_TITLE' || e.batch !== id) return;
    off();
    if (e.status === 'skipped') showToast({ text: t('imp.already', { name: e.name }), closeLabel: t('common.close') });
    else if (e.status === 'failed') alertDialog({ title: t('imp.fail_title'), body: e.error || '', detail: e.name, tone: 'error' });
  });
}

// ── The question before a drop of several titles ──
// `groups` (import-files.js groupImports), `name` the batch's, `leftOut` the files that are none of
// what imports, `runsIn` where it will run: 'page', 'worker' or 'app'). Resolves true to go ahead.
export function confirmImport(groups, { name, leftOut = 0, runsIn = 'page' }) {
  const bytes = groups.reduce((n, g) => n + g.files.reduce((m, f) => m + f.size, 0), 0);
  const unreadable = groups.filter((g) => g.unreadable?.length);
  const lines = [t('imp.ask_total', { n: formatCount(groups.length), size: formatBytes(bytes) })];
  if (unreadable.length) lines.push(t('imp.ask_unreadable', { n: formatCount(unreadable.length), path: unreadable[0].unreadable[0] }));
  if (leftOut) lines.push(t('imp.ask_left_out', { n: formatCount(leftOut) }));
  lines.push(t('imp.ask_skip'));
  if (runsIn === 'page') lines.push(t('imp.ask_keep_open'));
  else if (runsIn === 'worker') lines.push(t('imp.ask_keep_tab'));
  return confirmDialog({ title: t('imp.ask_title', { name }), body: lines.join('\n'), ok: t('imp.ask_ok', { n: formatCount(groups.length) }) });
}

// ── The panels ──
// Mounts the tracker in `host`, which it fills with a panel per batch (and hides while there is
// none). `onChange(running)` hears how many batches run or wait. Returns { listing(name, found), stopAll() }:
// listing() shows a drop being read (null when done).
export function mountImportTracker(host, { onChange = () => {} } = {}) {
  const panels = new Map();     // batch id → panel
  const dismissed = new Set();
  let listingPanel = null;
  const { titlesOf } = titlesSource();

  const sync = () => {
    host.hidden = !panels.size && !listingPanel;
    onChange([...panels.values()].filter((p) => p.live()).length);
  };

  function onJob(job) {
    if (job?.kind !== 'import' || job.gid == null || !job.status) return;
    const id = String(job.gid);
    if (dismissed.has(id)) return;
    let panel = panels.get(id);
    if (!panel) {
      panel = makePanel(id, { titlesOf, dismiss: () => {
        dismissed.add(id);
        panel.el.remove();
        panels.delete(id);
        platform.jobs.clear(id, 'import');
        sync();
      } });
      panels.set(id, panel);
      host.append(panel.el);
    }
    panel.update(job);
    sync();
  }
  platform.jobs.subscribe(onJob);
  platform.jobs.current().then((jobs) => { for (const j of jobs) if (j.kind === 'import') onJob(j); }).catch(() => {});
  setInterval(() => { for (const p of panels.values()) p.paint(); sync(); }, PAINT_EVERY_MS);
  sync();

  return {
    listing(name, found) {
      if (name == null) { listingPanel?.remove(); listingPanel = null; sync(); return; }
      if (!listingPanel) {
        listingPanel = _el('section', 'ib listing');
        listingPanel.innerHTML = `<div class="ib-head"><span class="ib-kind"></span><span class="ib-name"></span></div>
          <div class="prog-track"><div class="prog-fill indeterminate"></div></div><div class="ib-line ib-tally"></div>`;
        listingPanel.querySelector('.ib-kind').textContent = t('tasks.kind_upload');
        host.prepend(listingPanel);
      }
      _text(listingPanel.querySelector('.ib-name'), name);
      _text(listingPanel.querySelector('.ib-tally'), t('imp.reading', { n: formatCount(found) }));
      sync();
    },
    stopAll() { for (const p of panels.values()) if (p.live()) p.stop(); },
  };
}

const _el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
// Text changed only when it changed, so nothing under the pointer is rebuilt.
const _text = (el, text) => { if (el.textContent !== text) el.textContent = text; };

function makePanel(id, { titlesOf, dismiss }) {
  const el = _el('section', 'ib');
  el.dataset.batch = id;
  el.innerHTML = `
    <div class="ib-head">
      <span class="ib-kind"></span><span class="run-tag" hidden></span><span class="ib-name"></span><span class="ib-total"></span>
      <button class="ib-btn ib-list-btn" type="button" aria-expanded="false"></button>
      <button class="ib-btn ib-icon ib-stop" type="button">${STOP_SVG}</button>
      <button class="ib-btn ib-icon ib-dismiss" type="button" hidden>${CLOSE_SVG}</button>
    </div>
    <div class="prog-track"><div class="prog-fill"></div></div>
    <div class="ib-line ib-tally"></div>
    <div class="ib-line ib-now"></div>
    <div class="ib-line ib-issues"></div>
    <div class="ib-titles" hidden>
      <div class="ib-filters" role="group"></div>
      <ol class="ib-rows"></ol>
      <div class="ib-line ib-rows-note" hidden></div>
      <button class="ib-btn ib-more" type="button" hidden></button>
    </div>`;
  const $ = (sel) => el.querySelector(sel);
  $('.ib-kind').textContent = t('tasks.kind_upload');
  $('.ib-list-btn').textContent = t('imp.titles');
  $('.ib-more').textContent = t('imp.more');
  for (const [btn, key] of [[$('.ib-stop'), 'imp.stop'], [$('.ib-dismiss'), 'imp.dismiss']]) {
    btn.dataset.tip = t(key);
    btn.setAttribute('aria-label', t(key));
  }
  let job = null, stopping = false;
  const list = { open: false, filter: 'all', shown: ROWS_STEP, titles: null, timer: null };

  const state = () => batchState(job, id);
  const live = () => isLive(state());

  function paint() {
    if (!job) return;
    const s = state();
    el.dataset.state = s;
    const v = batchView(job, s);
    _text($('.ib-name'), v.name);
    paintRunnerTag($('.run-tag'), job.runner);
    _text($('.ib-total'), v.total);
    const fill = $('.prog-fill');
    fill.classList.toggle('done', s === 'done');
    fill.style.width = v.width;
    _text($('.ib-tally'), v.tally);
    $('.ib-now').classList.toggle('quiet', v.quiet);
    _text($('.ib-now'), v.now);
    _text($('.ib-issues'), v.issues);
    $('.ib-issues').classList.toggle('has-failed', v.failed);
    $('.ib-stop').hidden = !live();
    $('.ib-stop').disabled = stopping;
    $('.ib-dismiss').hidden = live();
    $('.ib-list-btn').hidden = !hasTitles(s);
    if (!hasTitles(s) && list.open) toggleList(false);
  }

  async function loadTitles() {
    const titles = await titlesOf(id);
    if (titles) list.titles = titles;
    paintList();
  }
  function paintList() {
    const titles = list.titles;
    const { counts, rows: shown, more } = titlesView(titles, list.filter, list.shown);
    const filters = $('.ib-filters');
    for (const f of FILTERS) {
      let btn = filters.querySelector(`[data-filter="${f}"]`);
      if (!btn) {
        btn = _el('button', 'ib-filter');
        btn.type = 'button';
        btn.dataset.filter = f;
        btn.addEventListener('click', () => { list.filter = f; list.shown = ROWS_STEP; paintList(); });
        filters.append(btn);
      }
      btn.hidden = f !== 'all' && !counts[f];
      btn.setAttribute('aria-pressed', String(list.filter === f));
      _text(btn, `${t(`imp.f_${f}`)} ${formatCount(counts[f])}`);
    }
    const rows = $('.ib-rows');
    for (const [i, ti] of shown.entries()) {
      let row = rows.children[i];
      if (!row) {
        row = _el('li', 'ib-row');
        row.innerHTML = '<span class="ib-row-status"></span><span class="ib-row-name"></span><span class="ib-row-error"></span>';
        rows.append(row);
      }
      if (row.dataset.status !== ti.status) row.dataset.status = ti.status;
      _text(row.children[0], t(`imp.f_${ti.status}`));
      _text(row.children[1], ti.name);
      _text(row.children[2], ti.status === 'failed' ? ti.error || '' : '');
    }
    while (rows.children.length > shown.length) rows.lastElementChild.remove();
    $('.ib-more').hidden = !more;
    const note = $('.ib-rows-note');
    note.hidden = !!titles;
    _text(note, titles ? '' : t('imp.no_titles'));
  }
  function toggleList(open = !list.open) {
    list.open = open;
    $('.ib-titles').hidden = !open;
    $('.ib-list-btn').setAttribute('aria-expanded', String(open));
    clearInterval(list.timer);
    if (!open) return;
    loadTitles();
    list.timer = setInterval(() => { if (state() === 'running') loadTitles(); }, TITLES_EVERY_MS);
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    paint();
    platform.rpc({ type: 'STOP_JOB', galleryId: id, kind: 'import' }).catch(() => {});
    setTimeout(() => { stopping = false; paint(); }, 3000);
  }
  $('.ib-list-btn').addEventListener('click', () => toggleList());
  $('.ib-more').addEventListener('click', () => { list.shown += ROWS_STEP; paintList(); });
  $('.ib-stop').addEventListener('click', stop);
  $('.ib-dismiss').addEventListener('click', () => { toggleList(false); dismiss(); });

  return {
    el, state, live, paint, stop,
    update(next) {
      const ended = next.status !== 'progress' && job?.status === 'progress';
      job = next;
      if (next.status !== 'progress') stopping = false;
      paint();
      if (ended && list.open) loadTitles();
    },
  };
}

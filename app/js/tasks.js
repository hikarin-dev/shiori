// tasks.js — the tasks page: every job under way in the library, wherever it runs and whether or not
// another page shows it (a chapter inside a series, a gallery filtered out or on another page of the
// library, a job that went quiet), each with its own Stop, and Stop all. Reached only by its address
// (/tasks). A gallery doing two jobs at once (downloading while translating) has a row for each.

import './boot.js';
import * as api from './api.js';
import * as platform from './platform.js';
import { t, getLang } from './i18n.js';
import { pickTitle, pickSeriesTitle } from './titles.js';
import { initTooltips } from './tooltip.js';
import { confirmDialog } from './notice.js';
import { formatBytes, formatCount } from './format.js';
import { escHtml } from './sanitize.js';

const LINGER_MS = 4000;            // a finished job's last word stays this long, as on a library card
const QUIET_MS = 2 * 60 * 1000;    // a running job silent this long says for how long
const TERMINAL = new Set(['done', 'error', 'cancelled']);
const isRunning = (job) => !TERMINAL.has(job.status);
const keyOf = (job) => `${job.gid}:${job.kind || 'job'}`;
const KIND_LABEL = { download: 'tasks.kind_download', translate: 'tasks.kind_translate', upload: 'tasks.kind_upload', sync: 'tasks.kind_sync' };
const STOP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

const $list = document.getElementById('tkList');
const $empty = document.getElementById('tkEmpty');
const $count = document.getElementById('tkCount');
const $stopAll = document.getElementById('stopAllBtn');

// key → { job, el, stopping, endedAt, hasCover, fillTimer }, in the order the jobs were first seen.
const _rows = new Map();

// ── What a row says about its job (the progress mapping is a library card's) ──
function view(job) {
  const label = job.labelKey ? t(job.labelKey, job.labelArgs) : job.label;
  const done = job.done || 0, total = job.total || 0;
  const tally = total ? `${formatCount(done)} / ${formatCount(total)}` : '';
  const skipped = job.skipped > 0 ? ` (${t('prog.already_cached', { n: formatCount(job.skipped) })})` : '';
  switch (job.status) {
    case 'error': return { pct: 0, label: `${t('prog.error')}: ${(job.errorKey ? t(job.errorKey) : job.error) || 'unknown'}` };
    case 'cancelled': return { pct: 0, label: t('prog.cancelled') };
    case 'downloading': {
      const { downloaded = 0, total: bytes = 0, pages = 0 } = job;
      if (!bytes) return { indeterminate: true, label: `↓ ${formatBytes(downloaded)}` };
      return { pct: Math.min(85, Math.round((downloaded / bytes) * 85)), label: pages > 0
        ? `~${formatCount(Math.min(pages, Math.round((downloaded * pages) / bytes)))} / ${formatCount(pages)} · ${formatBytes(downloaded)}`
        : `↓ ${formatBytes(downloaded)}` };
    }
    case 'extracting': return { pct: 85, label: t('prog.extracting') };
    case 'started': return { pct: 0, label: label || (job.kind === 'sync' ? t('prog.syncing') : total ? `0 / ${formatCount(total)}` : t('prog.starting')) };
  }
  // progress, done. A download's bytes fill the bar to 85%, its pages the rest.
  const pct = job.kind === 'translate' ? (typeof job.pct === 'number' ? job.pct : total ? Math.round((done / total) * 100) : 0)
    : job.kind === 'download' ? (total ? Math.round(85 + (done / total) * 15) : 85)
    : total ? Math.round((done / total) * 100) : 0;
  if (job.status === 'done') {
    return { pct: 100, label: job.kind === 'translate' ? `${t('prog.translated')} ${formatCount(done)}/${formatCount(total)}`
      : job.kind === 'sync' ? t('prog.synced') : `${t('prog.done')} — ${formatCount(done)}/${formatCount(total)}${skipped}` };
  }
  if (job.kind === 'translate') return { pct, label: label || `${t('prog.translating')} ${tally}` };
  if (job.kind === 'sync') return { pct, label: [t('prog.syncing'), tally].filter(Boolean).join(' · ') };
  return { pct, label: [label, tally].filter(Boolean).join(' · ') + skipped || t('prog.starting') };
}

function paint(row) {
  const { job, el } = row;
  const running = isRunning(job);
  for (const status of TERMINAL) el.classList.toggle(status, job.status === status);
  const v = view(job);
  const fill = el.querySelector('.prog-fill');
  fill.classList.toggle('indeterminate', !!v.indeterminate);
  fill.classList.toggle('done', job.status === 'done');
  fill.style.width = v.indeterminate ? '' : `${v.pct}%`;
  const label = el.querySelector('.tk-label');
  label.textContent = row.stopping && running ? t('tasks.stopping') : v.label;
  const silent = running && !row.stopping && job.at ? Date.now() - job.at : 0;
  if (silent > QUIET_MS) {
    const quiet = document.createElement('span');
    quiet.className = 'tk-quiet';
    quiet.textContent = ` · ${t('tasks.quiet', { n: formatCount(Math.floor(silent / 60000)) })}`;
    label.append(quiet);
  }
  el.querySelector('.tk-stop').disabled = row.stopping || !running;
}

function paintHeader() {
  const running = [..._rows.values()].filter((row) => isRunning(row.job));
  $count.textContent = formatCount(running.length);
  $stopAll.disabled = !running.some((row) => !row.stopping);
  $empty.hidden = _rows.size > 0;
}

// ── A row's gallery: its title, where it belongs, its cover ──
function makeRow(job) {
  const el = document.createElement('div');
  el.className = 'tk-row';
  el.dataset.key = keyOf(job);
  const href = escHtml(`../overview?g=${encodeURIComponent(job.gid)}`);
  const stopTip = escHtml(t('tasks.stop'));
  el.innerHTML = `
    <a class="tk-thumb" href="${href}" tabindex="-1" aria-hidden="true"><img alt=""></a>
    <div class="tk-body">
      <div class="tk-head"><span class="tk-kind"></span><a class="tk-title" href="${href}"></a></div>
      <div class="tk-sub"></div>
      <div class="tk-prog"><div class="prog-track"><div class="prog-fill"></div></div><span class="tk-label"></span></div>
    </div>
    <button class="tk-stop" type="button" data-tip="${stopTip}" aria-label="${stopTip}">${STOP_SVG}</button>`;
  const kind = el.querySelector('.tk-kind');
  kind.dataset.kind = job.kind || '';
  kind.textContent = KIND_LABEL[job.kind] ? t(KIND_LABEL[job.kind]) : (job.kind || '');
  el.querySelector('.tk-title').textContent = `#${job.gid}`;   // until its gallery is read
  const row = { job, el, stopping: false, endedAt: 0, hasCover: false, fillTimer: null };
  el.querySelector('.tk-stop').addEventListener('click', () => stop(row));
  return row;
}

async function fillGallery(row) {
  const gid = row.job.gid;
  const [g] = await api.galleries.byIds([gid]).catch(() => []);
  const owner = g?.parentId ? (await api.galleries.byIds([String(g.parentId)]).catch(() => []))[0] : null;
  const lang = getLang();
  row.el.querySelector('.tk-title').textContent = (g && pickTitle(g, lang)) || `#${gid}`;
  // (A gallery not in the library — yet, or any more — is named by its id alone, in the title.)
  row.el.querySelector('.tk-sub').textContent = g ? [`#${g.sourceId || gid}`,
    owner ? pickSeriesTitle(owner.seriesTitle, owner, lang) : ''].filter(Boolean).join(' · ') : '';
  if (!row.hasCover && g && g.count > 0) {
    platform.rpc({ type: 'GET_COVER', galleryId: gid, thumbWidth: 96, preferSeries: false, requester: 'tasks', requestId: gid });
  }
}
// A gallery being downloaded changes with every page: read it again once things settle.
function refill(row) {
  clearTimeout(row.fillTimer);
  row.fillTimer = setTimeout(() => fillGallery(row).catch(() => {}), 500);
}

platform.onControl((msg) => {
  if (msg?.type !== 'COVER_READY' || msg.requester !== 'tasks' || !msg.coverDataUrl) return;
  for (const row of _rows.values()) {
    if (row.job.gid !== String(msg.galleryId)) continue;
    row.el.querySelector('.tk-thumb img').src = msg.coverDataUrl;
    row.hasCover = true;
  }
});
api.events.watch((gid) => {
  for (const row of _rows.values()) if (gid === '*' || row.job.gid === gid) refill(row);
});

// ── Rows coming and going ──
// A new job's row goes at the end, so nothing already listed moves. A finished one lingers with its
// last word, and leaves only while the pointer is off the list, so the rows under it never shift.
function onJob(job) {
  if (!job || job.gid == null || !job.status) return;   // a signal on the jobs channel, not a job
  job = { ...job, gid: String(job.gid) };
  const key = keyOf(job);
  let row = _rows.get(key);
  if (row?.endedAt && isRunning(job)) return;           // late news of the job whose end shows
  if (!row) {
    if (!isRunning(job)) return;                         // the end of a job this page never saw
    row = makeRow(job);
    _rows.set(key, row);
    $list.append(row.el);
    fillGallery(row).catch(() => {});
  }
  row.job = job;
  if (!isRunning(job)) {
    row.stopping = false;
    row.endedAt = Date.now();
    setTimeout(sweep, LINGER_MS + 50);
  }
  paint(row);
  paintHeader();
}

let _pointerOnList = false;
$list.addEventListener('pointerenter', () => { _pointerOnList = true; });
$list.addEventListener('pointerleave', () => { _pointerOnList = false; sweep(); });
function sweep() {
  if (_pointerOnList) return;
  const now = Date.now();
  for (const [key, row] of _rows) {
    if (!row.endedAt || now - row.endedAt < LINGER_MS) continue;
    clearTimeout(row.fillTimer);
    row.el.remove();
    _rows.delete(key);
  }
  paintHeader();
}

// ── Stopping ──
// The stop reaches the job wherever it runs (services.js STOP_JOB); its row shows "Stopping…" until
// the job's own word that it stopped comes back. Should none come, Stop can be pressed again.
async function stop(row) {
  if (row.stopping || !isRunning(row.job)) return;
  row.stopping = true;
  paint(row);
  paintHeader();
  try { await platform.rpc({ type: 'STOP_JOB', galleryId: row.job.gid, kind: row.job.kind }); } catch {}
  setTimeout(() => {
    if (!row.stopping || !isRunning(row.job)) return;
    row.stopping = false;
    paint(row);
    paintHeader();
  }, 3000);
}

$stopAll.addEventListener('click', async () => {
  if (![..._rows.values()].some((row) => isRunning(row.job) && !row.stopping)) return;
  if (!(await confirmDialog({ title: t('tasks.stop_all_title'), body: t('tasks.stop_all_body'), ok: t('tasks.stop_all'), danger: true }))) return;
  await Promise.all([..._rows.values()].filter((row) => isRunning(row.job)).map(stop));
});

document.getElementById('settingsBtn').addEventListener('click', () => { location.href = '../settings'; });

// ── What is under way now ──
// The live jobs list, plus work it doesn't hold a row for: a translation still under way on the
// translation server, and a job waiting to be resumed. Later news of each arrives on the channel.
platform.jobs.subscribe(onJob);
async function hydrate() {
  const [current, translating, pending] = await Promise.all([
    platform.jobs.current(), platform.translateResume.all(), platform.jobsPending.all()]);
  const found = new Map();
  const add = (job) => { if (!found.has(keyOf(job))) found.set(keyOf(job), job); };
  for (const job of current.filter(isRunning).sort((a, b) => (a.at || 0) - (b.at || 0))) add({ ...job, gid: String(job.gid) });
  const now = Date.now();
  for (const rec of translating) add({ gid: String(rec.gid), kind: 'translate', status: 'progress', labelKey: 'prog.translating', at: now });
  for (const entry of pending) {
    const gid = String(entry.payload?.galleryId ?? String(entry.key || '').split(':')[0]);
    if (gid && entry.kind) add({ gid, kind: entry.kind, status: 'started', labelKey: 'prog.starting', at: now });
  }
  for (const [key, job] of found) if (!_rows.has(key)) onJob(job);
  paintHeader();
}
hydrate().catch(() => paintHeader());

// The "no news" notes keep counting while nothing else changes.
setInterval(() => { for (const row of _rows.values()) if (isRunning(row.job)) paint(row); }, 15000);

initTooltips();

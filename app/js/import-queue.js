// import-queue.js — the imports a background context runs: the desktop app's runner page (runner.js)
// and this browser's service worker (sw.js). One at a time, in the order given — except that a small
// one (a single title, a gallery's pages replaced) waiting behind a batch goes in between two of its
// titles. What waits says so, as a job of its own that can be stopped; each reports through
// platform.jobs as any import does, so every page shows it.
//   { type: 'batch', id, batch }  — a batch of titles (import-batch.js runImportBatch takes `batch`)
//   { type: 'import', id, galleryId, group, skipExisting }  — one group into one gallery

import * as platform from './platform.js';
import { importBytes } from './import-files.js';
import { startImport } from './jobs-runner.js';
import { runImportBatch, stopBatches } from './import-batch.js';

const WAITING_EVERY_MS = 5000;   // what waits says so this often, so no page takes it for lost
const queue = [];
const active = new Set();        // what runs now: a batch, and a small item gone in between
let running = false;             // the queue is being worked through
const _done = new WeakMap();     // item → resolve of the promise enqueue() returned

// Take an item; resolves once it has run (or was stopped while waiting).
export function enqueue(item) {
  const done = new Promise((resolve) => _done.set(item, resolve));
  queue.push(item);
  if (running) _wait(item);
  else run();
  return done;
}
// Whether anything runs or waits here.
export const busy = () => running || queue.length > 0;

const _small = (item) => item.type === 'import' || item.batch.groups.length === 1;
const _finish = (item) => { _done.get(item)?.(); _done.delete(item); };

// An item waiting, as the job it will be: an import its gallery's ('Waiting…'), a batch its own.
function _wait(item) {
  item.waiting = true;
  _waitingTimer ??= setInterval(_sayWaiting, WAITING_EVERY_MS);
  if (item.type === 'import') {
    platform.jobs.publish({ gid: String(item.galleryId), kind: 'upload', status: 'started', labelKey: 'prog.waiting' });
    return;
  }
  const { id, name, groups } = item.batch;
  item.batch.report = true;   // shown waiting, it goes on as a batch the tracker follows
  platform.jobs.publish({ gid: id, kind: 'import', status: 'progress', waiting: true, name, total: groups.length, done: 0,
    imported: 0, skipped: 0, failed: 0, bytes: groups.reduce((n, g) => n + g.files.reduce((m, f) => m + f.size, 0), 0), bytesDone: 0,
    current: null, startedAt: Date.now(), movedAt: Date.now() });
}
// Said again while anything waits (and only then).
let _waitingTimer = null;
function _sayWaiting() {
  const waiting = queue.filter((item) => item.waiting);
  if (!waiting.length) { clearInterval(_waitingTimer); _waitingTimer = null; return; }
  for (const item of waiting) _wait(item);
}

// A stop drops a waiting import or batch (saying so), and ends the import being read here once its
// file is read; from then on jobs-runner.js stops it like any other import, and a running batch
// stops itself (import-batch.js).
platform.jobs.subscribe((e) => {
  if (e?.type === 'STOP_IMPORT_BATCH') {
    for (let i = queue.length - 1; i >= 0; i--) {
      const item = queue[i];
      if (item.batch?.id !== String(e.batch)) continue;
      queue.splice(i, 1);
      if (item.waiting) platform.jobs.publish({ gid: item.batch.id, kind: 'import', status: 'cancelled', name: item.batch.name, total: item.batch.groups.length, done: 0, imported: 0, skipped: 0, failed: 0, bytes: 0, bytesDone: 0 });
      _finish(item);
    }
    return;
  }
  if (e?.type !== 'STOP_IMPORT') return;
  const gid = String(e.galleryId);
  for (let i = queue.length - 1; i >= 0; i--) if (String(queue[i].galleryId) === gid) _finish(queue.splice(i, 1)[0]);
  for (const item of active) if (String(item.galleryId) === gid) item.stopped = true;
});

async function run() {
  running = true;
  try { for (let item; (item = queue.shift());) await _run(item); } finally { running = false; }
}

// The small items waiting, in the order they came, run now (between two titles of a batch).
async function _runSmall() {
  for (let i; (i = queue.findIndex(_small)) !== -1;) await _run(queue.splice(i, 1)[0]);
}

async function _run(item) {
  active.add(item);
  try {
    if (item.batch) { await runImportBatch({ ...item.batch, between: _small(item) ? null : _runSmall }); return; }
    const { galleryId: gid, group, skipExisting } = item;
    let buffer;
    try {
      buffer = await importBytes(group, ({ done, total }) => item.stopped || platform.jobs.publish({
        gid, kind: 'upload', status: 'progress', done, total, labelKey: 'prog.rendering', labelArgs: { done, total },
      }));
    } catch (e) {
      if (!item.stopped) platform.jobs.publish({ gid, kind: 'upload', status: 'error', error: String(e?.message || e) });
      return;
    }
    if (item.stopped) { platform.jobs.publish({ gid, kind: 'upload', status: 'cancelled' }); return; }
    await startImport({ galleryId: gid, buffer, filename: group.name, skipExisting });
  } finally { active.delete(item); _finish(item); }
}

// What runs and waits here: { count, titles } (the desktop app asks before it quits).
export function activeJobs() {
  const jobs = [...active, ...queue];
  return { count: jobs.length, titles: jobs.map((j) => j.batch?.name ?? j.group.name.replace(/\.[^.]+$/, '')) };
}

// Stop: what waits is dropped; what runs stops (a batch, after its page).
export function cancelJobs() { for (const item of queue.splice(0)) _finish(item); stopBatches(); }

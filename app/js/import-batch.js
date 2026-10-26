// import-batch.js — what one drop or pick imports, as one job. Its titles go in one at a time, each
// title's gallery made only when its turn comes (its card shows as soon as it is under way, and none
// is left empty), and a title imported before — the same files, by its fingerprint
// (import-files.js importFingerprint) — is skipped when it was finished, or carries on in its gallery
// when it was cut short. A batch of several titles reports as one 'import' job on the jobs channel
// (the tracker on the library and tasks pages, import-tracker.js) and is stopped as one; its titles'
// own news says which batch it belongs to. It runs where imports run: the library page in a browser,
// the desktop app's runner (handed over whole, submit-job.js handImportBatch).

import * as platform from './platform.js';
import * as api from './api.js';
import { importBytes, importFingerprint, importTarget, unreadableError } from './import-files.js';
import { startImport } from './jobs-runner.js';
import { mergeIntoSeries } from './series.js';
import { batchLog } from './import-log.js';

export const BATCH_CHANNEL = 'shiori-import';
const PUBLISH_EVERY_MS = 250;      // the batch's news, at most this often while a title runs
const HEARTBEAT_MS = 5000;         // ...and at least this often, so a tracker can tell it is alive
const ENDED_KEPT = 3;              // ended batches whose titles are still told (a tracker lists them)

export const titleOf = (group) => group.name.replace(/\.[^.]+$/, '');
const _bytes = (group) => group.files.reduce((n, f) => n + f.size, 0);

// The batches of this context, by id: { titles, ended, stop() }. A tracker on another page asks for
// a batch's titles on BATCH_CHANNEL; one on this page reads them here.
const _batches = new Map();
export const localTitles = (id) => _batches.get(String(id))?.titles || null;
export const runningHere = () => [..._batches.values()].some((b) => !b.ended);
const _channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(BATCH_CHANNEL) : null;
if (_channel) _channel.onmessage = ({ data }) => {
  const titles = data?.type === 'titles?' ? localTitles(data.batch) : null;
  if (titles) _channel.postMessage({ type: 'titles', batch: data.batch, titles });
};
platform.jobs.subscribe((e) => { if (e?.type === 'STOP_IMPORT_BATCH') _batches.get(String(e.batch))?.stop(); });
export const stopBatches = () => { for (const b of _batches.values()) b.stop(); };

// The galleries imported before, by fingerprint: finished (skipped when dropped again) or cut short
// (carried on in the same gallery).
async function _imported() {
  const out = new Map();
  for (const m of await api.meta.all().catch(() => [])) {
    if (m?.importHash) out.set(m.importHash, { gid: String(m.galleryId), finished: true });
    else if (m?.importingHash && !out.has(m.importingHash)) out.set(m.importingHash, { gid: String(m.galleryId), finished: false });
  }
  return out;
}

// Import `groups` (import-files.js groupImports), in order. `name`: what the batch is called (the
// folder dropped, or how many files). `attachTo`: a series each new title joins as its next chapter;
// `meta`: what each new gallery starts with besides its title. `report`: tell of it as a batch even
// with one title (it was shown waiting); `between()`: run before each title after the first (the
// desktop runner's small imports, waiting meanwhile). Resolves with the tally:
// { imported, skipped, failed, stopped, titles: [{ name, status, gid, error }] }.
export async function runImportBatch({ id = `import-${Date.now()}`, name, groups, attachTo = null, meta = {}, report = false, between = null }) {
  id = String(id);
  const many = groups.length > 1 || report;
  const titles = groups.map((g) => ({ name: titleOf(g), status: 'waiting' }));
  const job = {
    gid: id, kind: 'import', status: 'progress', name, total: groups.length, done: 0,
    imported: 0, skipped: 0, failed: 0, bytes: groups.reduce((n, g) => n + _bytes(g), 0), bytesDone: 0,
    current: null, startedAt: Date.now(), movedAt: Date.now(),
  };
  let stopped = false, currentGid = null, publishedAt = 0;
  const batch = { titles, ended: false, stop() {
    if (stopped || batch.ended) return;
    stopped = true;
    if (currentGid) platform.jobs.signal({ type: 'STOP_IMPORT', galleryId: currentGid });
  } };
  _batches.set(id, batch);
  // One title is its own job (its card and tasks row show it), so a batch of one says nothing itself.
  const publish = (now) => {
    if (!many || (!now && Date.now() - publishedAt < PUBLISH_EVERY_MS)) return;
    publishedAt = Date.now();
    platform.jobs.publish({ ...job, current: job.current && { ...job.current } });
  };
  const heartbeat = many ? setInterval(() => publish(true), HEARTBEAT_MS) : null;
  const log = await batchLog({ id, name, titles: groups.length, files: groups.reduce((n, g) => n + g.files.length, 0), bytes: job.bytes });
  publish(true);
  const known = await _imported();
  try {
    for (const [i, group] of groups.entries()) {
      if (i && between && !stopped) {
        job.current = null;
        publish(true);
        await between();
      }
      if (stopped) break;
      const title = titles[i];
      title.status = 'importing';
      job.current = { name: title.name, done: 0, total: 0, bytes: _bytes(group) };
      job.movedAt = Date.now();
      publish(true);
      const outcome = await _importTitle(group, { known, attachTo, meta, batch: many ? id : null,
        onGallery: (gid) => { currentGid = gid; title.gid = gid; },
        onProgress: (p) => {
          if (p.total == null) return;
          job.current = { ...job.current, done: (p.done || 0) + (p.skipped || 0), total: p.total };
          job.movedAt = Date.now();
          publish();
        } });
      currentGid = null;
      title.status = outcome.status;
      if (outcome.gid) title.gid = outcome.gid;
      if (outcome.error) title.error = outcome.error;
      if (outcome.status === 'stopped') break;
      job[outcome.status === 'done' ? 'imported' : outcome.status]++;
      job.done++;
      job.bytesDone += job.current.bytes;
      job.movedAt = Date.now();
      // Each title's end, for a page that tells of it (a single title found imported already).
      platform.jobs.signal({ type: 'IMPORT_TITLE', batch: id, name: title.name, gid: title.gid ?? null, status: title.status, error: title.error ?? null });
      publish(true);
    }
  } finally {
    clearInterval(heartbeat);
    batch.ended = true;
    for (const old of [..._batches.keys()].filter((k) => _batches.get(k).ended).slice(0, -ENDED_KEPT)) _batches.delete(old);
    job.current = null;
    job.status = stopped ? 'cancelled' : 'done';
    publish(true);
  }
  const tally = { imported: job.imported, skipped: job.skipped, failed: job.failed, stopped,
    failures: titles.filter((t) => t.status === 'failed').map((t) => ({ name: t.name, error: t.error })) };
  await log.end(tally);
  return { ...tally, titles };
}

// One title: skipped when its files are in the library already; else into the gallery it says it
// is, the one it was cut short in, or a new one — made here, so its card shows now, and dropped
// again should the import fail before storing anything. Resolves { status: done|skipped|failed|
// stopped, gid, error }.
async function _importTitle(group, { known, attachTo, meta, batch, onGallery, onProgress }) {
  let gid = null, made = false;
  try {
    const unreadable = unreadableError(group);
    if (unreadable) throw unreadable;
    const hash = await importFingerprint(group);
    const before = hash ? known.get(hash) : null;
    if (before?.finished && await api.galleries.get(before.gid).catch(() => null)) return { status: 'skipped', gid: before.gid };
    gid = before?.gid || await importTarget(group) || api.newGalleryId();
    onGallery(gid);
    if (!await api.galleries.get(gid).catch(() => null)) {
      const title = titleOf(group);
      await api.galleries.create(gid, { title: { english: title, japanese: '', pretty: '' }, isLocalImport: true, ...meta });
      made = true;
      if (attachTo) await mergeIntoSeries(attachTo, gid, { title });
    }
    const buffer = await importBytes(group);
    const result = await startImport({ galleryId: gid, buffer, filename: group.name, skipExisting: true, inPlace: true, importHash: hash, batch, onProgress });
    if (result.status === 'done') {
      if (hash) known.set(hash, { gid, finished: true });
      return { status: 'done', gid };
    }
    if (made) await _dropIfEmpty(gid);
    return { status: result.status === 'cancelled' ? 'stopped' : 'failed', gid, error: result.error };
  } catch (e) {
    if (made) await _dropIfEmpty(gid);
    return { status: 'failed', gid, error: String(e?.message || e) };
  }
}

// A gallery this batch made that holds nothing: gone, so no empty card is left behind.
async function _dropIfEmpty(gid) {
  const g = await api.galleries.get(gid).catch(() => null);
  if (!g || !g.count) await api.galleries.delete(gid).catch(() => {});
}

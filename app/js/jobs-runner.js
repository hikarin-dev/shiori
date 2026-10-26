// jobs-runner.js — the actual app-DB work for resilient jobs (upload, translate). Pure: it runs
// the engine and publishes status via platform.jobs. Imported by BOTH the PWA service worker
// (where the work survives the originating tab closing) and the in-tab fallback (no SW available).
//
// Both engines are idempotent — importCbzBuffer(skipExisting) only stores missing pages and
// translateGallery only translates not-yet-translated pages — so re-running a job resumes it.

import * as platform from './platform.js';
import { capabilities, galleries } from './api.js';
import { importCbzBuffer } from './import-cbz.js';
import { galleryLog } from './import-log.js';
import { startTranslation, pollTranslation, cancelTranslate } from './translate.js';

// Import a CBZ the UI staged in OPFS. Resumable: re-running skips already-stored pages.
// The job layer publishes label/error KEYS (resolved via t() in the UI, which owns i18n) —
// this code also runs in the service worker, which has no localStorage-backed language.
export async function runImport({ galleryId, tempFile, filename, skipExisting = true, importHash = null }) {
  const gid = String(galleryId);
  platform.jobs.publish({ gid, kind: 'upload', status: 'started', labelKey: 'prog.reading' });
  let root = null;
  try {
    root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(tempFile);
    await _import(gid, await fh.getFile(), filename, skipExisting, { importHash });
    // Success only — a failed import (importCbzBuffer throws) retains the staged file so the
    // import can be retried; boot maintenance sweeps abandoned ones after a grace period.
    root.removeEntry(tempFile).catch(() => {});
    platform.jobs.publish({ gid, kind: 'upload', status: 'done' });
  } catch (e) {
    // A stopped import isn't coming back: its staged file goes too.
    if (e instanceof ImportStopped) root?.removeEntry(tempFile).catch(() => {});
    _importFailed(gid, e, platform.jobs.publish);
  }
}

// Import a zip (import-files.js importBytes: a file, bytes, or a folder's files as a zip's entries)
// from a page into gallery `galleryId`. This browser's library has a zip staged in OPFS first and
// handed to the durable runner (the service worker, which survives the page). A library kept as
// files has no service worker to hand it to, and what a dropped folder holds (`inPlace`, and a
// folder's files) is never copied first: those are imported here and now, straight from the files
// or memory — not written a second time on their way in; an import cut short by closing the page is
// started again, and finds the pages it stored (import-cbz.js). Resolves false when it couldn't be
// staged; one imported here resolves with how it ended, { status: done|error|cancelled, error }.
// `importHash`: the title's fingerprint (import-files.js importFingerprint), kept on its gallery —
// as begun, then as finished — so the same files dropped again are found. `batch`: the import job
// this title is one of (import-batch.js), which keeps the record: the title's own news goes on the
// live channel only. `onProgress` hears the engine's every step.
export async function startImport({ galleryId, buffer, filename, skipExisting = true, inPlace = false, importHash = null, batch = null, onProgress = null }) {
  const gid = String(galleryId);
  if (!capabilities.browserLibrary || inPlace || Array.isArray(buffer)) {
    const say = batch ? (job) => platform.jobs.signal({ ...job, batch, at: Date.now() }) : platform.jobs.publish;
    say({ gid, kind: 'upload', status: 'started', labelKey: 'prog.reading' });
    try {
      await _import(gid, buffer, filename, skipExisting, { importHash, say, onProgress });
      say({ gid, kind: 'upload', status: 'done' });
      return { status: 'done' };
    } catch (e) {
      _importFailed(gid, e, say);
      return { status: e instanceof ImportStopped ? 'cancelled' : 'error', error: String(e && e.message || e) };
    }
  }
  const tempFile = `cbz-${gid}-${Date.now()}.bin`;
  try {
    const root = await navigator.storage.getDirectory();
    const writable = await (await root.getFileHandle(tempFile, { create: true })).createWritable();
    await writable.write(buffer);
    await writable.close();
  } catch { return false; }
  platform.rpc({ type: 'IMPORT_CBZ', galleryId: gid, tempFile, filename, skipExisting, importHash });
  return true;
}

// ── Stopping an import ──
// Whichever context runs an import (the service worker, a tab, the desktop app's runner) hears a
// stop on the jobs channel (STOP_IMPORT, sent by services.js) and ends it between two pages. What
// was stored stays, as after any interrupted import; importing the file again resumes it.
class ImportStopped extends Error {}
const _importing = new Map();   // gid → { stopped } of the import running in this context
platform.jobs.subscribe((e) => {
  if (e?.type !== 'STOP_IMPORT') return;
  const run = _importing.get(String(e.galleryId));
  if (run) run.stopped = true;
});

async function _import(gid, buffer, filename, skipExisting, { importHash = null, say = platform.jobs.publish, onProgress = null } = {}) {
  const run = { stopped: false };
  _importing.set(gid, run);
  const log = galleryLog(gid, filename, buffer);
  // The fingerprint as begun: dropped again before it ends, the same files carry on in this gallery.
  const mark = (patch) => (importHash ? galleries.mutate(gid, patch, { touch: false, silent: true }).catch(() => {}) : null);
  try {
    await mark({ importingHash: importHash });
    // Every way through an import reports each page as it lands, so a stop takes effect there.
    // Pages found stored already (a resumed import) count as done.
    await importCbzBuffer(gid, buffer, filename, !!skipExisting, (p) => {
      if (run.stopped) throw new ImportStopped();
      log.progress(p);
      onProgress?.(p);
      if (p.status === 'progress' || p.status === 'started')
        say({ gid, kind: 'upload', status: 'progress', done: p.done + (p.skipped || 0), total: p.total, labelKey: 'prog.importing' });
    });
    await mark({ importHash, importingHash: null });
    await log.end('done');
  } catch (e) {
    await log.end(e instanceof ImportStopped ? 'stopped' : 'failed', e instanceof ImportStopped ? null : e);
    throw e;
  } finally {
    if (_importing.get(gid) === run) _importing.delete(gid);
  }
}
function _importFailed(gid, e, say) {
  // Stopped: the last word on the job channel, after any progress still on its way.
  if (e instanceof ImportStopped) { say({ gid, kind: 'upload', status: 'cancelled' }); return; }
  say({
    gid, kind: 'upload', status: 'error', error: String(e && e.message || e),
    ...(e && e.code ? { errorKey: `err.${e.code}` } : {}),
  });
}

// Start a gallery translation: upload the not-yet-translated pages and create the server-owned job.
// Returns once it's created; the poll ticks (runPoll) drive it. Resumable: re-running only uploads
// pages still missing. `pages` limits it to those pages; `after` continues a gallery translation
// with its next group of pages (see startTranslation).
export async function runTranslate({ galleryId, settings, forceFrom = null, pages = null, after = [] }) {
  const gid = String(galleryId);
  try {
    await startTranslation(gid, settings, (m) => platform.jobs.publish({ gid, kind: 'translate', ...m }), { forceFrom, pages, after });
  } catch (e) {
    platform.jobs.publish({ gid, kind: 'translate', status: 'error', error: String(e && e.message || e) });
  }
}

// Poll every in-flight translation once (each a short fetch) and broadcast progress. Driven by the
// page's poll tick — this is what keeps the service worker warm and the job advancing without any
// single long-lived event hitting Chrome's ~5-min cap.
export async function runPoll() {
  const records = await platform.translateResume.all();
  await Promise.all((records || []).map((rec) =>
    pollTranslation(rec.gid, (m) => platform.jobs.publish({ gid: rec.gid, kind: 'translate', ...m }))));
}

export const RUNNERS = { upload: runImport, translate: runTranslate };

// Cancel a running job in THIS context. submit-job routes it to the SW when the SW owns the job.
// Mirror of RUNNERS; only translate is cancellable. The payload carries { galleryId, token, serverUrl, settings }.
export const CANCELLERS = { translate: (payload) => cancelTranslate(payload) };

export function cancelJobRun(kind, payload) {
  const fn = CANCELLERS[kind];
  if (fn) fn(payload);
}

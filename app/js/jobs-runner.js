// jobs-runner.js — the actual app-DB work for resilient jobs (upload, translate). Pure: it runs
// the engine and publishes status via platform.jobs. Imported by BOTH the PWA service worker
// (where the work survives the originating tab closing) and the in-tab fallback (no SW available).
//
// Both engines are idempotent — importCbzBuffer(skipExisting) only stores missing pages and
// translateGallery only translates not-yet-translated pages — so re-running a job resumes it.

import * as platform from './platform.js';
import { capabilities } from './api.js';
import { importCbzBuffer } from './import-cbz.js';
import { startTranslation, pollTranslation, cancelTranslate } from './translate.js';

// Import a CBZ the UI staged in OPFS. Resumable: re-running skips already-stored pages.
// The job layer publishes label/error KEYS (resolved via t() in the UI, which owns i18n) —
// this code also runs in the service worker, which has no localStorage-backed language.
export async function runImport({ galleryId, tempFile, filename, skipExisting = true }) {
  const gid = String(galleryId);
  platform.jobs.publish({ gid, kind: 'upload', status: 'started', labelKey: 'prog.reading' });
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(tempFile);
    await _import(gid, await (await fh.getFile()).arrayBuffer(), filename, skipExisting);
    // Success only — a failed import (importCbzBuffer throws) retains the staged file so the
    // import can be retried; boot maintenance sweeps abandoned ones after a grace period.
    root.removeEntry(tempFile).catch(() => {});
    platform.jobs.publish({ gid, kind: 'upload', status: 'done' });
  } catch (e) { _importFailed(gid, e); }
}

// Import a zip (import-files.js importBytes) from a page into gallery `galleryId`. This browser's
// library has it staged in OPFS first and handed to the durable runner (the service worker, which
// survives the page). A library kept as files has no service worker to hand it to, so it is
// imported here and now, straight from memory — not written a second time on its way in; an import
// cut short by closing the page is started again. Resolves false when it couldn't be staged.
export async function startImport({ galleryId, buffer, filename, skipExisting = true }) {
  const gid = String(galleryId);
  if (!capabilities.browserLibrary) {
    platform.jobs.publish({ gid, kind: 'upload', status: 'started', labelKey: 'prog.reading' });
    try {
      await _import(gid, buffer, filename, skipExisting);
      platform.jobs.publish({ gid, kind: 'upload', status: 'done' });
    } catch (e) { _importFailed(gid, e); }
    return true;
  }
  const tempFile = `cbz-${gid}-${Date.now()}.bin`;
  try {
    const root = await navigator.storage.getDirectory();
    const writable = await (await root.getFileHandle(tempFile, { create: true })).createWritable();
    await writable.write(buffer);
    await writable.close();
  } catch { return false; }
  platform.rpc({ type: 'IMPORT_CBZ', galleryId: gid, tempFile, filename, skipExisting });
  return true;
}

const _import = (gid, buffer, filename, skipExisting) => importCbzBuffer(gid, buffer, filename, !!skipExisting, (p) => {
  if (p.status === 'progress' || p.status === 'started')
    platform.jobs.publish({ gid, kind: 'upload', status: 'progress', done: p.done, total: p.total, labelKey: 'prog.importing' });
});
function _importFailed(gid, e) {
  platform.jobs.publish({
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

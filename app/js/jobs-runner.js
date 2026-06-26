// jobs-runner.js — the actual app-DB work for resilient jobs (upload, translate). Pure: it runs
// the engine and publishes status via platform.jobs. Imported by BOTH the PWA service worker
// (where the work survives the originating tab closing) and the in-tab fallback (no SW available).
//
// Both engines are idempotent — importCbzBuffer(skipExisting) only stores missing pages and
// translateGallery only translates not-yet-translated pages — so re-running a job resumes it.

import * as platform from './platform.js';
import { importCbzBuffer } from './import-cbz.js';
import { startTranslation, pollTranslation, cancelTranslate } from './translate.js';

// Import a CBZ the UI staged in OPFS. Resumable: re-running skips already-stored pages.
export async function runImport({ galleryId, tempFile, filename, skipExisting = true }) {
  const gid = String(galleryId);
  platform.jobs.publish({ gid, kind: 'upload', status: 'started', label: 'Reading…' });
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(tempFile);
    const buffer = await (await fh.getFile()).arrayBuffer();
    await importCbzBuffer(gid, buffer, filename, !!skipExisting, (p) => {
      if (p.status === 'progress' || p.status === 'started')
        platform.jobs.publish({ gid, kind: 'upload', status: 'progress', done: p.done, total: p.total, label: 'Importing' });
    });
    root.removeEntry(tempFile).catch(() => {});
    platform.jobs.publish({ gid, kind: 'upload', status: 'done' });
  } catch (e) {
    platform.jobs.publish({ gid, kind: 'upload', status: 'error', error: String(e && e.message || e) });
  }
}

// Start a gallery translation: upload the not-yet-translated pages and create the server-owned job.
// Returns once it's created; the poll ticks (runPoll) drive it. Resumable: re-running only uploads
// pages still missing.
export async function runTranslate({ galleryId, settings }) {
  const gid = String(galleryId);
  await startTranslation(gid, settings, (m) => platform.jobs.publish({ gid, kind: 'translate', ...m }));
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
// Mirror of RUNNERS; only translate is cancellable. The payload carries { galleryId, token, serverUrl }.
export const CANCELLERS = { translate: (payload) => cancelTranslate(payload) };

export function cancelJobRun(kind, payload) {
  const fn = CANCELLERS[kind];
  if (fn) fn(payload);
}

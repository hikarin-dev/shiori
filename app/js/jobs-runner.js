// jobs-runner.js — the actual app-DB work for resilient jobs (upload, translate). Pure: it runs
// the engine and publishes status via platform.jobs. Imported by BOTH the PWA service worker
// (where the work survives the originating tab closing) and the in-tab fallback (no SW available).
//
// Both engines are idempotent — importCbzBuffer(skipExisting) only stores missing pages and
// translateGallery only translates not-yet-translated pages — so re-running a job resumes it.

import * as platform from './platform.js';
import { importCbzBuffer } from './import-cbz.js';
import { translateGallery } from './translate.js';

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

// Translate a gallery against the configured server. Resumable: re-running picks up untranslated pages.
export async function runTranslate({ galleryId, settings }) {
  const gid = String(galleryId);
  await translateGallery(gid, settings, (m) => platform.jobs.publish({ gid, kind: 'translate', ...m }));
}

export const RUNNERS = { upload: runImport, translate: runTranslate };

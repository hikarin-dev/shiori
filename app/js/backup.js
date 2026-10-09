// backup.js — library backups made and restored by this page, for moving Shiori between browsers,
// machines and the desktop app. Two kinds:
//
//   • Metadata only (.shi)  — a small JSON array of every gallery's metadata. Lightweight;
//     restoring recreates gallery entries without images.
//   • Full (.shioridb)      — the whole library, pictures included, as one file. Its format, its
//     checks and the making and restoring of it are backup-core.js's; this module is this page's
//     side of it: the library it reads and writes (api.js), and the file (a Blob the browser's
//     downloads save, a File the person picked or dropped).
//
// Making a full backup reads every picture once — to be sure it can be read, and for its checksum —
// and then hands the browser one Blob that refers to the pictures where they are stored (nothing is
// copied). Restoring one is two steps: openBackup reads what a file holds and checks it, writing
// nothing; restoreBackup then writes it, a gallery at a time, each whole or not at all.
// importBackup does both, for callers with no one to ask.

import * as api from './api.js';
import { isValidGalleryId } from './sanitize.js';
import { makeArchive, openArchive, inspectArchive, restoreArchive, probeBackup, snapshotSettings, restoreSettings,
  footer, mapLimit, sha256, localDate, BackupError } from './backup-core.js';

export { probeBackup, BackupError };

const progressFn = (arg) => typeof arg === 'function' ? arg : (arg?.onProgress || (() => {}));

// ── Metadata-only export (.shi) ─────────────────────────────────────────────────────────────
// Only galleries in the library: metadata that never became a gallery (a download that failed
// before its first page) would otherwise come back from the backup as an empty gallery.
export async function exportMetadata({ onProgress = () => {}, signal = null } = {}) {
  const payload = [];
  const ids = await api.transfer.ids();
  for (let i = 0; i < ids.length; i++) {
    if (signal?.aborted) throw new BackupError('cancelled');
    const { meta, stat } = await api.transfer.read(ids[i], { pages: false });
    if (meta && stat) { const { pageExts, ...rest } = meta; payload.push(rest); }
    if (i % 25 === 0 || i === ids.length - 1) onProgress({ done: i + 1, total: ids.length });
  }
  return {
    blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    suggestedName: `shiori-backup-${localDate()}.shi`,
    count: payload.length,
  };
}

// ── Full export (.shioridb) ─────────────────────────────────────────────────────────────────
// This library as the backup-core reads it.
const librarySource = {
  ids: () => api.transfer.ids(),
  read: (gid) => api.transfer.read(gid),
  icons: () => api.icons.all(),
  revision: () => api.events.revision(),
  since: (rev) => api.events.since(rev),
};

// The archive as one Blob: each picture once it has been read whole and its checksum taken (one
// that can't be read is left out — the browser's download would otherwise fail on it), referred to
// where the browser keeps it.
function blobArchive() {
  const parts = [];
  let offset = 0;
  return {
    async addPictures(blobs, onBytes) {
      const checked = await mapLimit(blobs, 4, async (blob) => {
        try {
          const bytes = await blob.arrayBuffer();
          if (bytes.byteLength !== blob.size) return null;
          onBytes(bytes.byteLength);
          return await sha256(bytes);
        } catch { return null; }
      });
      return blobs.map((blob, i) => {
        if (!checked[i]) return null;
        const spec = { off: offset, len: blob.size, type: blob.type || '', h: checked[i] };
        parts.push(blob);
        offset += blob.size;
        return spec;
      });
    },
    async hashPicture(blob) {
      try { return await sha256(await blob.arrayBuffer()); } catch { return null; }
    },
    async addBytes(bytes) {
      const at = { off: offset, len: bytes.length };
      parts.push(bytes);
      offset += bytes.length;
      return at;
    },
    async finish(index) {
      parts.push(index, footer(index.length));
      return new Blob(parts, { type: 'application/octet-stream' });
    },
  };
}

// { archive (a Blob), suggestedName, counts, missing: [{ gid, what }], changed: [gid] }.
// onProgress({ done, total, bytes, totalBytes }) per gallery.
export async function exportFull(opts = {}) {
  const onProgress = progressFn(opts);
  const totalBytes = (await api.galleries.stats().catch(() => null))?.totalSize || 0;
  const made = await makeArchive({ source: librarySource, out: blobArchive(), settings: snapshotSettings(localStorage),
    signal: opts.signal, onProgress: (p) => onProgress({ ...p, totalBytes }) });
  return { archive: made.result, suggestedName: `shiori-${localDate()}.shioridb`, counts: made.counts,
    missing: made.missing, changed: made.changed };
}

// ── Restore ─────────────────────────────────────────────────────────────────────────────────
// What a restore cut short got through, by backup: the galleries already written, so restoring the
// same file again can carry on rather than write them all again. This device's own (never in a
// backup's settings).
const JOURNAL_KEY = 'shiori:restoreJournal';
function readJournal(id) {
  try {
    const j = JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null');
    return j?.id === id && Array.isArray(j.done) ? new Set(j.done.map(String)) : new Set();
  } catch { return new Set(); }
}
function writeJournal(id, done) { try { localStorage.setItem(JOURNAL_KEY, JSON.stringify({ id, done: [...done] })); } catch {} }
function clearJournal() { try { localStorage.removeItem(JOURNAL_KEY); } catch {} }

// This library as the backup-core restores into it.
const libraryTarget = {
  write: (bundle) => api.transfer.write(bundle, { silent: true }),
  exists: async (gid) => { const r = await api.transfer.read(gid, { pages: false }); return !!(r.meta || r.stat); },
  recount: (gid) => api.galleries.recount(gid, { silent: true }),
  putIcon: (icon) => api.icons.put(icon.source, icon),
  refreshSeries: (ownerId) => api.series.refreshTotals(ownerId),
  announce: (gid) => api.events.announce(gid),
};

// A metadata backup read and checked: its entries, nothing written.
async function openMetadata(file) {
  let entries;
  try { entries = JSON.parse(await file.text()); }
  catch { throw new BackupError('corrupt', 'its JSON is not readable'); }
  if (!Array.isArray(entries)) throw new BackupError('not-backup');
  const seen = new Set();
  for (const meta of entries) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new BackupError('corrupt', 'an entry');
    if (meta.galleryId == null) continue;
    // Imported ids end up in DOM attributes and hrefs on every surface: a backup with markup ids is
    // a stored-XSS attempt, and the whole file is refused.
    if (!isValidGalleryId(meta.galleryId)) throw new BackupError('unsafe', 'a gallery id');
    if (meta.parentId != null && !isValidGalleryId(meta.parentId)) throw new BackupError('unsafe', 'a series id');
    if (meta.chapters != null && (!Array.isArray(meta.chapters) || meta.chapters.some(c => !isValidGalleryId(c?.id)))) throw new BackupError('unsafe', 'a chapter id');
    if (seen.has(String(meta.galleryId))) throw new BackupError('corrupt', 'a gallery listed twice');
    seen.add(String(meta.galleryId));
  }
  return { kind: 'metadata', entries: entries.filter(m => m.galleryId != null), file };
}

// What `file` holds, read and checked, nothing written: { kind: 'metadata', entries } or
// { kind: 'full', archive, inspection, done } — `done`: galleries a restore of this same backup
// cut short had already written (and that are still here). The kind is told from the content, so
// a backup under any name (a download left as "Unconfirmed … .crdownload") opens. Throws a
// BackupError when it can't be restored at all.
export async function openBackup(file, { onProgress = () => {}, signal = null } = {}) {
  if (await probeBackup(file) === 'metadata') return openMetadata(file);
  const archive = await openArchive(file);
  const inspection = await inspectArchive(archive, { onProgress, signal });
  const journal = readJournal(archive.id);
  const done = new Set();
  if (journal.size) {
    const byId = new Map(inspection.galleries.map(g => [g.gid, g]));
    await mapLimit([...journal], 8, async (gid) => {
      const g = byId.get(gid);
      if (!g || g.problem) return;
      const { stat } = await api.transfer.read(gid, { pages: false }).catch(() => ({}));
      if (stat && Number(stat.count) === g.pages) done.add(gid);
    });
  }
  return { kind: 'full', archive, inspection, done, file };
}

// Restore what openBackup opened. `resume`: leave out the galleries a cut-short restore of the same
// backup already wrote. onProgress({ done, total, bytes, totalBytes }). Resolves
// { kind, written, problems, cancelled, settings: { restored, failed }, missingPages, … }; throws a
// BackupError when it had to stop (no space, the library gone, the file unreadable) —
// `error.written` the galleries that are in.
export async function restoreBackup(opened, { resume = false, onProgress = () => {}, signal = null } = {}) {
  if (opened.kind === 'metadata') return restoreMetadata(opened, { onProgress, signal });
  const { archive, inspection } = opened;
  const done = new Set(resume ? opened.done : []);
  const journal = new Set(done);
  let unsaved = 0;
  try {
    const result = await restoreArchive(archive, inspection, libraryTarget, {
      skip: done, signal,
      onProgress,
      onGallery: (gid) => { journal.add(gid); if (++unsaved >= 10) { writeJournal(archive.id, journal); unsaved = 0; } },
    });
    const complete = !result.cancelled && !result.problems.length;
    if (complete) clearJournal(); else writeJournal(archive.id, journal);
    // Preferences land last, and only when the restore wasn't stopped: never over a library that
    // didn't arrive.
    const storage = globalThis.localStorage;
    const settings = result.cancelled || !storage ? { restored: 0, failed: [] } : restoreSettings(archive.settings, storage);
    return { kind: 'full', ...result, settings, missingPages: inspection.missingPages,
      counts: { galleries: result.written.length + result.skipped, images: _pagesOf(inspection, result.written, done) } };
  } catch (e) {
    writeJournal(archive.id, journal);
    throw e;
  }
}
const _pagesOf = (inspection, written, skipped) => {
  const ids = new Set([...written, ...skipped]);
  return inspection.galleries.reduce((n, g) => n + (ids.has(g.gid) ? g.pages : 0), 0);
};

async function restoreMetadata({ entries }, { onProgress = () => {}, signal = null } = {}) {
  const written = [];
  const owners = new Set();
  for (let i = 0; i < entries.length; i++) {
    if (signal?.aborted) break;
    const meta = entries[i];
    const gid = String(meta.galleryId);
    const nextMeta = { ...meta, galleryId: gid, fetchedAt: Date.now() };
    // Only an absent gallery starts from nothing: a gallery that can't be read now stops the restore,
    // rather than having its totals reset as if it had no pages.
    const existing = (await api.transfer.read(gid, { pages: false })).stat;
    await api.transfer.write({ galleryId: gid, meta: nextMeta, stat: {
      galleryId: gid,
      count:     existing?.count    || 0,
      size:      existing?.size     || 0,
      latestAt:  Date.now(),                                       // a metadata upload is a modification
      addedAt:   existing?.addedAt  || Date.now(),                 // restore-time marks "came from backup"
      coverPage: existing?.coverPage ?? 9999,
      uploadDate: Number(meta.uploadDate) || existing?.uploadDate || 0,
      // Keep the stat record's series link in step with the metadata, so a chapter restored from a
      // metadata-only backup stays hidden from the top-level grid (which filters on stat.parentId).
      ...(nextMeta.parentId ? { parentId: String(nextMeta.parentId) } : {}),
    } }, { silent: true });
    if (nextMeta.parentId) owners.add(String(nextMeta.parentId));
    if (Array.isArray(nextMeta.chapters) && nextMeta.chapters.length > 1) owners.add(gid);
    written.push(gid);
    if (i % 10 === 0 || i === entries.length - 1) onProgress({ done: i + 1, total: entries.length });
  }
  const seriesNotRefreshed = [];
  for (const ownerId of owners) await api.series.refreshTotals(ownerId).catch(() => seriesNotRefreshed.push(ownerId));
  for (const gid of written) api.events.announce(gid);
  return { kind: 'metadata', written, problems: [], cancelled: written.length < entries.length, seriesNotRefreshed,
    settings: { restored: 0, failed: [] }, counts: { galleries: written.length, images: 0 } };
}

// Open and restore `file` in one go, everything it holds that can be restored. { kind, counts, … }.
export async function importBackup(file, opts = {}) {
  const onProgress = progressFn(opts);
  const opened = await openBackup(file, { signal: opts.signal });
  return restoreBackup(opened, { signal: opts.signal, onProgress });
}

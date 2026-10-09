// backup.js — full backups (.shioridb) made and restored by the desktop app itself, for its window:
// the app's own format, checks and steps (backup-core.js, through shared.js), with the library read
// and written in this process and the backup file read and written directly — no WebSocket, nothing
// held in a window, a gallery's pictures read one after another. A backup is written into
// `<name>.partial` beside the file chosen, flushed and renamed into place once it is whole; one cut
// short leaves nothing behind. BackupJobs runs them one at a time for main.js, and the window follows
// one by asking how it is going (a page reloaded meanwhile finds it again).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupCore, BackendError } from './shared.js';

const { makeArchive, openArchive, inspectArchive, restoreArchive, portableSettings, footer, localDate, BackupError } = backupCore;

// Pictures read ahead of the one being written: a backup holds a few pictures at a time, whatever
// the library's size.
const READ_AHEAD = 4;
// Room wanted beyond the library's own size before a backup begins (its index, the file system's own).
const SPARE = 64 * 1024 * 1024;
// A restore's progress is kept every this many galleries (the journal).
const JOURNAL_EVERY = 10;

export const partialOf = (file) => `${file}.partial`;
// The name a backup is offered under: the person's own date.
export const backupName = () => `shiori-${localDate()}.shioridb`;

// A picture's checksum as a backup carries it: SHA-256, base64 without padding (backup-core sha256).
export const hashOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');

// What stopped a backup, as the window is told: { code, detail } — a BackupError's or the library's
// code, out of space as `quota`, anything else `aborted`.
export function errorOf(e) {
  if (e instanceof BackupError) return { code: e.code, detail: e.detail };
  const detail = String(e?.message || e);
  if (e instanceof BackendError) return { code: e.code, detail };
  return { code: e?.code === 'ENOSPC' || /SQLITE_FULL|disk is full/i.test(detail) ? 'quota' : 'aborted', detail };
}

// ── Making a backup ──
async function writeAt(handle, bytes, position) {
  for (let at = 0; at < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, at, bytes.length - at, position + at);
    if (!bytesWritten) throw new Error('nothing could be written');
    at += bytesWritten;
  }
}

// A picture read whole, or null when it can't be.
const readWhole = (blob) => blob.arrayBuffer().then(b => (b.byteLength === blob.size ? new Uint8Array(b) : null), () => null);

// The archive written to `handle` as backup-core makes it: each picture read whole (a few ahead of
// the one being written), its checksum taken, then written after what is there already — one that
// can't be read whole is left out (null). `written()`: the bytes written so far.
function fileArchive(handle) {
  let offset = 0;
  const append = async (bytes) => {
    const off = offset;
    await writeAt(handle, bytes, off);
    offset += bytes.length;
    return off;
  };
  return {
    written: () => offset,
    // A picture's checksum, nothing written (a gallery read again: one already written is kept).
    async hashPicture(blob) {
      const bytes = await readWhole(blob);
      return bytes ? hashOf(bytes) : null;
    },
    async addPictures(blobs, onBytes) {
      const reads = blobs.slice(0, READ_AHEAD).map(readWhole);
      const specs = [];
      for (let i = 0; i < blobs.length; i++) {
        const bytes = await reads[i];
        reads[i] = null;
        if (i + READ_AHEAD < blobs.length) reads.push(readWhole(blobs[i + READ_AHEAD]));
        if (!bytes) { specs.push(null); continue; }
        const h = hashOf(bytes);
        specs.push({ off: await append(bytes), len: bytes.length, type: blobs[i].type || '', h });
        onBytes(bytes.length);
      }
      return specs;
    },
    async addBytes(bytes) { return { off: await append(bytes), len: bytes.length }; },
    async finish(index) {
      await append(index);
      await append(footer(index.length));
      return offset;
    },
  };
}

// Whether the backup clearly can't fit where it is to go: it needs about the library's own size.
// Only a guess — where the free space can't be told, the backup begins.
async function checkSpace(dir, needed) {
  const disk = await fsp.statfs(dir).catch(() => null);
  if (!disk) return;
  const free = Number(disk.bavail) * Number(disk.bsize);
  if (free < needed + SPARE) throw new BackupError('quota', `${free} bytes free, about ${needed + SPARE} needed`);
}

// A file renamed into place, again for a moment when something (an antivirus scan of the file just
// written) holds it.
async function renameInto(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fsp.rename(from, to); } catch (e) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
    }
  }
}

// A full backup of `library` written to `file`: { path, bytes, counts, missing: [{ gid, what }],
// changed: [gid] } (backup-core makeArchive). Written to `<file>.partial` first; on any failure — or
// `signal` — that goes and the error is thrown, so `file` is only ever replaced by a whole backup.
// `settings`: the window's own ({ kv, dash }), reduced to what travels.
// onProgress({ done, total, bytes, totalBytes }) as it begins and per gallery.
export async function exportArchive(library, file, { settings = null, signal = null, onProgress = () => {} } = {}) {
  const target = path.resolve(file);
  const partial = partialOf(target);
  const totalBytes = (await library.getStats().catch(() => null))?.totalSize || 0;
  await checkSpace(path.dirname(target), totalBytes);
  const handle = await fsp.open(partial, 'w');
  const out = fileArchive(handle);
  let open = true;
  try {
    const source = {
      ids: async () => {
        const ids = await library.transferIds();
        onProgress({ done: 0, total: ids.length, bytes: 0, totalBytes });
        return ids;
      },
      read: (gid) => library.transferRead(gid, { lazy: true }),
      icons: () => library.sourceIconsAll(),
      revision: () => library.changeRevision(),
      since: (rev) => library.changesSince(rev),
    };
    const made = await makeArchive({ source, out, settings, signal, onProgress: (p) => onProgress({ ...p, totalBytes }) });
    await handle.datasync();
    open = false;
    await handle.close();
    await renameInto(partial, target);
    return { path: target, bytes: made.result, counts: made.counts, missing: made.missing, changed: made.changed };
  } catch (e) {
    if (open) await handle.close().catch(() => {});
    await fsp.rm(partial, { force: true }).catch(() => {});
    throw e;
  } finally {
    library.writes.add('exports', out.written());
  }
}

// ── Restoring one ──
// A part of a file on disk as a Blob, its bytes read only when asked for (positioned reads, good to
// 2^53 bytes). Not fs.openAsBlob: Node gets a file of 4 GiB or more wrong with it (its size wraps at
// 2^32 and reads past 2 GiB come back empty), and a full backup is often far larger. A file that
// changes meanwhile (a download still being written) can't be read any more, and says so.
export class FileSlice extends Blob {
  #file; #start; #end; #type; #stamp;
  constructor(file, start, end, type = '', stamp = null) {
    super([]);
    this.#file = file; this.#start = start; this.#end = end; this.#type = type; this.#stamp = stamp;
  }
  static async open(file) {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error(`not a file: ${file}`);
    return new FileSlice(file, 0, stat.size, '', { size: stat.size, mtimeMs: stat.mtimeMs });
  }
  get size() { return this.#end - this.#start; }
  get type() { return this.#type; }
  slice(start = 0, end = this.size, type = '') {
    const size = this.size;
    const at = (v) => (v < 0 ? Math.max(size + v, 0) : Math.min(v, size));
    const from = at(Number(start) || 0), to = Math.max(at(end === undefined ? size : Number(end) || 0), from);
    return new FileSlice(this.#file, this.#start + from, this.#start + to, String(type || ''), this.#stamp);
  }
  async bytes() {
    const handle = await fsp.open(this.#file, 'r');
    try {
      const now = await handle.stat();
      if (this.#stamp && (now.size !== this.#stamp.size || now.mtimeMs !== this.#stamp.mtimeMs)) {
        throw Object.assign(new Error('the file changed while it was being read'), { name: 'NotReadableError' });
      }
      const out = Buffer.allocUnsafe(this.size);
      for (let got = 0; got < out.length;) {
        const { bytesRead } = await handle.read(out, got, out.length - got, this.#start + got);
        if (!bytesRead) throw Object.assign(new Error('the file ended early'), { name: 'NotReadableError' });
        got += bytesRead;
      }
      return new Uint8Array(out.buffer, out.byteOffset, out.length);
    } finally { await handle.close(); }
  }
  async arrayBuffer() { const b = await this.bytes(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  async text() { return new TextDecoder().decode(await this.bytes()); }
}

// A backup file opened for reading (backup-core openArchive), nothing restored; its bytes are read
// as they are needed.
export async function openBackupFile(file) {
  let blob;
  try { blob = await FileSlice.open(file); } catch (e) { throw new BackupError('unreadable', String(e?.message || e)); }
  return openArchive(blob);
}

// What a restore cut short got through, by backup (its id): the galleries it had written, so the same
// backup restored again can carry on. One, kept beside the library's index.
const journalFile = (library) => path.join(library.dataDir, 'restore-journal.json');
async function readJournal(library, id) {
  try {
    const j = JSON.parse(await fsp.readFile(journalFile(library), 'utf8'));
    return j?.id === id && Array.isArray(j.done) ? new Set(j.done.map(String)) : new Set();
  } catch { return new Set(); }
}
// The journal for backup `id`, written one save after another (each whole: renamed into place).
function journalOf(library, id) {
  const file = journalFile(library);
  let last = Promise.resolve();
  const queue = (fn) => (last = last.then(fn).catch(() => {}));
  return {
    save: (done) => {
      const text = JSON.stringify({ id, done: [...done] });
      return queue(async () => { await fsp.writeFile(`${file}.tmp`, text); await fsp.rename(`${file}.tmp`, file); });
    },
    clear: () => queue(() => fsp.rm(file, { force: true })),
  };
}

// What an opened backup holds, every gallery checked, nothing written (backup-core inspectArchive):
// { galleries: [{ gid, title, pages, bytes, problem, missing }], ok, bad, pages, bytes, missingPages,
// done, version, exportedAt, hashed } — `done`: the galleries a restore of this same backup cut
// short had written that are still here, whole.
export async function inspectBackup(library, archive, { signal = null, onProgress = () => {} } = {}) {
  const inspection = await inspectArchive(archive, { signal, onProgress });
  const galleries = inspection.galleries.map(g => ({ ...g, missing: g.missing ?? 0 }));
  const byId = new Map(galleries.map(g => [g.gid, g]));
  const done = [];
  for (const gid of await readJournal(library, archive.id)) {
    const g = byId.get(gid);
    if (!g || g.problem) continue;
    const { stat } = await library.transferRead(gid, { pages: false }).catch(() => ({}));
    if (stat && Number(stat.count) === g.pages) done.push(gid);
  }
  return { ...inspection, galleries, done, version: archive.version, exportedAt: archive.exportedAt, hashed: archive.hashed };
}

// The library as backup-core restores into it, in this process: a gallery in one call, recorded
// whole or not at all. No space left stops the restore (rather than failing every gallery after).
function libraryTarget(library) {
  const full = (e) => {
    if (!(e instanceof BackendError) && errorOf(e).code === 'quota') throw new BackendError('quota', String(e?.message || e));
    throw e;
  };
  return {
    write: (bundle) => library.transferWrite(bundle, { silent: true }).catch(full),
    exists: async (gid) => { const r = await library.transferRead(gid, { pages: false }); return !!(r.meta || r.stat); },
    recount: (gid) => library.rebuildGalleryEntry(gid, { silent: true }).catch(full),
    putIcon: (icon) => library.sourceIconPut(icon.source, icon),
    refreshSeries: (ownerId) => library.refreshSeriesAggregate(ownerId),
    announce: (gid) => library.publishFeed(gid),
  };
}

const pagesOf = (inspection, ids) => inspection.galleries.reduce((n, g) => n + (ids.has(g.gid) ? g.pages : 0), 0);

// Restore into `library` what inspectBackup found restorable in `archive`; `resume`: leaving out its
// `done`. Resolves { written, problems, cancelled, seriesNotRefreshed, skipped, settings,
// missingPages, counts } — `settings`: the backup's portable settings, for the window to apply (they
// are its own), null when the restore was stopped. Throws a BackupError when it had to stop
// (`error.written`: the galleries that are in). What it got through is kept either way (the journal);
// a restore that ends with nothing left out clears it.
export async function restoreBackupFile(library, archive, inspection, { resume = false, signal = null, onProgress = () => {} } = {}) {
  const skip = new Set(resume ? inspection.done || [] : []);
  const done = new Set(skip);
  const journal = journalOf(library, archive.id);
  let unsaved = 0;
  try {
    const result = await restoreArchive(archive, inspection, libraryTarget(library), {
      skip, signal, onProgress,
      onGallery: (gid) => { done.add(gid); if (++unsaved >= JOURNAL_EVERY) { unsaved = 0; journal.save(done); } },
    });
    await (!result.cancelled && !result.problems.length ? journal.clear() : journal.save(done));
    const restored = new Set([...result.written, ...skip]);
    return { ...result, settings: result.cancelled ? null : portableSettings(archive.settings), missingPages: inspection.missingPages,
      counts: { galleries: restored.size, images: pagesOf(inspection, restored) } };
  } catch (e) {
    await journal.save(done);
    throw e;
  }
}

// ── Backups for the app's window (main.js) ──
// One at a time: made into a file the person chose, or opened from one — inspected, then waiting for
// the person to restore it or not. Each can be stopped between galleries. The window asks how it is
// going (state); a page reloaded meanwhile asks which one there is (job).
const RUNNING = new Set(['preparing', 'exporting', 'inspecting', 'restoring']);

export class BackupJobs {
  // `onPartial(path | null)`: the partial file a backup being made is written to, and null once it
  // is gone — main.js keeps it in its settings, so one a forced shutdown left is deleted next start.
  constructor(library, { onPartial = () => {} } = {}) {
    this.library = library;
    this.onPartial = onPartial;
    this.job = null;   // the one running, or the last one, until it is closed
  }

  // The job under way (its `owner`: the page that started it, or took it over), or null.
  running() { return this.job && RUNNING.has(this.job.phase) ? this.job : null; }
  _get(id) { return this.job && id != null && this.job.id === id ? this.job : null; }

  _new(kind, owner) {
    this.job = { id: crypto.randomUUID(), kind, phase: 'preparing', done: 0, total: 0, bytes: 0, totalBytes: 0,
      inspection: null, result: null, error: null, owner, controller: null, work: null, archive: null };
    return this.job;
  }

  // `work(signal)` run as `job`'s `phase`; it resolves the phase that follows. A cancelled one is
  // 'cancelled', a failed one 'failed' with its error.
  _run(job, phase, work) {
    job.phase = phase;
    job.controller = new AbortController();
    job.work = work(job.controller.signal).then((next) => { job.phase = next; }, (e) => {
      if (e instanceof BackupError && e.code === 'cancelled') { job.phase = 'cancelled'; return; }
      job.phase = 'failed';
      job.error = errorOf(e);
    });
  }

  // A backup made into `file`: { ok: true, id }, or { ok: false, code: 'busy' } while another runs.
  export(file, { settings = null, owner = null } = {}) {
    if (this.running()) return { ok: false, code: 'busy' };
    const job = this._new('export', owner);
    const partial = partialOf(path.resolve(file));
    this._run(job, 'preparing', async (signal) => {
      this.onPartial(partial);
      try {
        job.result = await exportArchive(this.library, file, { settings, signal,
          onProgress: (p) => Object.assign(job, p, { phase: 'exporting' }) });
      } finally {
        this.onPartial(null);
      }
      return 'done';
    });
    return { ok: true, id: job.id };
  }

  // The backup in `file` opened and inspected, to be restored once the person says so.
  open(file, { owner = null } = {}) {
    if (this.running()) return { ok: false, code: 'busy' };
    const job = this._new('import', owner);
    this._run(job, 'inspecting', async (signal) => {
      const archive = await openBackupFile(file);
      job.total = archive.galleries.length;
      job.totalBytes = archive.galleries.reduce((n, g) => n + g.bytes, 0);
      job.inspection = await inspectBackup(this.library, archive, { signal, onProgress: ({ done, total }) => Object.assign(job, { done, total }) });
      job.archive = archive;
      return 'inspected';
    });
    return { ok: true, id: job.id };
  }

  // The opened backup `id` restored; `resume`: without what a restore of it cut short had written.
  restore(id, { resume = false, owner = null } = {}) {
    const job = this._get(id);
    if (!job || job.kind !== 'import') return { ok: false, code: 'not-found' };
    if (RUNNING.has(job.phase)) return { ok: false, code: 'busy' };
    if (job.phase !== 'inspected' || !job.archive) return { ok: false, code: 'invalid' };
    const { archive, inspection } = job;
    Object.assign(job, { done: 0, total: 0, bytes: 0, totalBytes: 0, owner: owner ?? job.owner });
    this._run(job, 'restoring', async (signal) => {
      try {
        job.result = await restoreBackupFile(this.library, archive, inspection, { resume, signal, onProgress: (p) => Object.assign(job, p) });
      } catch (e) {
        // What is in, for an honest account of a restore that had to stop.
        const written = Array.isArray(e?.written) ? e.written : [];
        job.result = { written, problems: [], cancelled: false, seriesNotRefreshed: [], skipped: resume ? inspection.done.length : 0,
          settings: null, missingPages: inspection.missingPages };
        throw e;
      } finally {
        job.archive = null;
      }
      return job.result.cancelled ? 'cancelled' : 'done';
    });
    return { ok: true };
  }

  // { id, kind, phase, done, total, bytes, totalBytes, inspection?, result?, error? }, or null.
  state(id) {
    const job = this._get(id);
    if (!job) return null;
    const { kind, phase, done, total, bytes, totalBytes, inspection, result, error } = job;
    return { id: job.id, kind, phase, done, total, bytes, totalBytes,
      ...(inspection ? { inspection } : {}), ...(result ? { result } : {}), ...(error ? { error } : {}) };
  }

  // Stopped between galleries; an opened backup not restored after all.
  cancel(id) {
    const job = this._get(id);
    if (!job) return;
    if (RUNNING.has(job.phase)) job.controller.abort();
    else if (job.phase === 'inspected') { job.phase = 'cancelled'; job.archive = null; }
  }

  // A job no longer running forgotten.
  close(id) {
    const job = this._get(id);
    if (!job) return { ok: true };
    if (RUNNING.has(job.phase)) return { ok: false, code: 'busy' };
    this.job = null;
    return { ok: true };
  }

  // The job under way stopped, and done with (its partial file gone, its journal kept): before the
  // library closes.
  async stop() {
    const job = this.running();
    if (!job) return;
    job.controller.abort();
    await job.work;
  }
}

// files.js — where each gallery lives in the library folder: a folder in the Shiori gallery format
// (gallery-files.js — the same layout as its export, unzipped): images/0001.webp… for its original
// pages, translated/, study/, pipeline/ and covers/ for what was made from them (written there by
// library.js), and its descriptions (metadata.json, image_records.json, study/bubbles.json,
// covers/manifest.json). A series keeps its members' folders in a folder of its own, with
// series.json. Pages are staged as they arrive (.shiori/staging/<gid>/ in the library folder); once
// they stop changing for a moment (placeDelay) the gallery is settled: its staged pages are moved
// (renamed, never copied) into images/ and the files of pages it no longer has are deleted. The
// gallery's other pages are never written again.
//
// The index (library.db) is where everything about a gallery lives, updated as it happens. The
// descriptions are a copy of it on disk, written when a gallery is settled (`settle`): at once after
// a change made by hand (its metadata, tags, cover, series), and — for what arrives page by page
// (downloads, translations, study layers) — when the job doing it ends or the reader leaves the
// gallery. Pages that arrive with neither (fetched as someone reads) are described once the gallery
// has been left alone a while (describeDelay), and everything left over when the app closes. A
// gallery's folder in staging goes once nothing is staged in it.
//
// A gallery's place is chosen when it first needs one (its first settle, or a file of its own
// written before that): a folder named after it at the top of the library folder, or "<Series>
// Ch. 001" in its series' folder. A gallery that joins or leaves a series has its folder moved
// there (renamed: nothing in it is written); a changed title moves nothing. Renaming or moving
// folders by hand is left to the person (the full check, scan.js, finds them again by their id).
// A gallery's folder or archive that goes is deleted outright, not put in the recycle bin (where it
// would look like something important thrown away). Explorer isn't told about a folder deleted or
// moved that way, and finding the folder it shows gone can bring it down: an Explorer window
// showing one is moved out of it first (`vacate`).
//
// A gallery left alone a while — neither changed nor opened in the reader for `archiveAfter` (a day,
// a week or a month; never unless chosen: Settings → System) — or archived by hand (the overview), is
// archived: its folder's files written once into one ZIP
// or CBZ beside it (`archiveFormat`), stored uncompressed — its export, so other programs open it
// too — which takes the folder's place; the folder is deleted. An archived gallery is
// read in place, straight from the archive into memory. What changes is added to the archive at its
// end, with a new directory, without writing again what it holds: a description at once; a picture
// (a page, a translation, a cover of its own) staged first and added when the gallery settles. A
// change that would leave more than a quarter of the archive unused (pictures replaced or removed)
// writes it whole once instead — unpacked into a folder when pictures wait in staging (they then
// move in without being written again), else rewritten as a fresh archive. A gallery kept in an
// archive from before, or added by hand, is read alike, but unpacked on its first change: it is
// never added to. Nothing here walks the library folder: a gallery is reached by
// its known path, and one whose folder or archive is found gone when read is marked missing until
// it reads again.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readDirectory, readEntry, writeZip, appendZip } from './zip.js';
import { files as layout, BackendError } from './shared.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  gid TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL CHECK (format IN ('cbz', 'zip', 'folder')),
  state TEXT NOT NULL CHECK (state IN ('packed', 'missing')),
  packed_at REAL,
  pending INTEGER NOT NULL DEFAULT 0,
  unpack INTEGER NOT NULL DEFAULT 0,
  used_at REAL,
  tail REAL
);
CREATE TABLE IF NOT EXISTS leftovers (
  gid TEXT NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (gid, entry)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS retired (path TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS staged_own (
  gid TEXT NOT NULL,
  rel TEXT NOT NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (gid, rel)
) WITHOUT ROWID;
`;
// `files`: one row per gallery with a place in the library folder; `state` 'packed' when it is
// there, 'missing' when it was found gone; `pending` when its descriptions are out of date;
// `unpack` when pictures were removed from its archive (its next settle adds to or rewrites it);
// `used_at` when it was last changed or
// opened in the reader (kept to the hour); `tail` the length its archive had while descriptions
// are being added to it (cut back to it should the app stop half way). `leftovers`: files in a
// gallery's folder no page refers to any more, deleted when it is next settled. `retired`: a folder
// or archive no gallery has any more (an archived gallery's folder), to delete. `staged_own`: a
// picture of its own (`rel`) waiting in staging (`file`) to be added to its gallery's archive.
const UNUSED_AT_MOST = 0.25;   // the share of an archive left unused before it is written whole again
const COLUMNS = { unpack: 'INTEGER NOT NULL DEFAULT 0', used_at: 'REAL', tail: 'REAL' };
const HOUR = 60 * 60_000, DAY = 24 * HOUR;
// Files Windows puts in a folder on its own: not the gallery's, and not worth keeping it a folder for.
const WINDOWS_FILES = new Set(['desktop.ini', 'thumbs.db']);
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
// The descriptions a gallery's folder may hold (gallery-files.js writes them).
const DESCRIPTIONS = ['metadata.json', 'image_records.json', 'study/bubbles.json', 'covers/manifest.json'];
const parse = (s) => (s == null ? null : JSON.parse(s));
const extOfName = (name) => String(name ?? '').match(/\.(\w+)$/)?.[1]?.toLowerCase();
// The files of the gallery's own a value refers to ({ $own: 'translated/0001.png', size }): rel → size.
function ownFiles(value, into = new Map()) {
  if (value == null || typeof value !== 'object') return into;
  if (typeof value.$own === 'string') { into.set(value.$own, value.size ?? null); return into; }
  for (const v of Array.isArray(value) ? value : Object.values(value)) ownFiles(v, into);
  return into;
}
// Every file under `dir`, as paths relative to it.
async function filesIn(dir, rel = '') {
  const out = [];
  for (const e of await fsp.readdir(path.join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
    const name = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await filesIn(dir, name)); else out.push(name);
  }
  return out;
}

// The library folder's own id, kept in its .shiori/library.json and made the first time: this
// computer's data for the library (its index and thumbnails) is found by it, so the folder keeps
// them whatever drive letter or path it is reached by. A file that can't be read is an error, never
// a reason to start over under a new id.
export function libraryId(libraryDir) {
  const file = path.join(libraryDir, '.shiori', 'library.json');
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (text != null) {
    const id = JSON.parse(text)?.id;
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new Error(`${file} names no library id`);
    return id;
  }
  const id = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ format: 'shiori-library', version: 1, id }, null, 2));
  return id;
}

// Whether `file` is there, flushed to the disk first, so a page moved into its folder is never an
// empty file after a power cut.
async function flushed(file) {
  let handle;
  try { handle = await fsp.open(file, 'r+'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  try { await handle.sync(); } finally { await handle.close(); }
  return true;
}

// `data` written to `file` and flushed to the disk.
export async function writeFlushed(file, data) {
  const handle = await fsp.open(file, 'w');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

// A small file replaced whole: written beside it, then renamed over it.
async function replaceFile(file, data) {
  const temp = `${file}.shiori-tmp`;
  await writeFlushed(temp, data);
  await fsp.rename(temp, file);
}

// A file moved where it belongs, synchronously; across drives (a junction inside the library
// folder), copied and the original deleted. Returns whether it was copied (written again).
function moveSync(from, to) {
  try { fs.renameSync(from, to); return false; } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
    return true;
  }
}

export class FileLibrary {
  // `library` is the Library whose pages these are. `placeDelay`: how long a gallery's pages must
  // stay unchanged before they are moved into its folder; `describeDelay`: how long a gallery must
  // be left alone before its descriptions are brought up to date; `archiveAfter`: how long before
  // it is archived (0: never), in `archiveFormat` ('zip' or 'cbz').
  constructor(library, { placeDelay = 8000, describeDelay = 10 * 60_000, archiveAfter = 0, archiveFormat = 'zip' } = {}) {
    this.library = library;
    this.placeDelay = placeDelay;
    this.describeDelay = describeDelay;
    this.archiveAfter = archiveAfter;
    this.archiveFormat = archiveFormat;
    this._sweepTimer = null;
    this._sweeping = null;
    this._timers = new Map();
    this._placing = new Map();         // gid → the settle running for it
    this._again = new Set();           // settled again once the running settle ends
    this._describeTimers = new Map();
    this._describing = new Map();      // gid → the descriptions' write running for it
    this._touched = new Set();         // galleries changed since their descriptions' write began
    this._regroupWanted = new Set();   // galleries that joined or left a series, to move at their next settle
    this._reserved = new Set();        // folders chosen by unpacks still running
    this._dirs = new Map();            // archive path → { mtimeMs, size, entries }
    this._reading = new Map();         // archive path → reads in flight
    this._failures = new Map();        // gid → settles that failed in a row
    this._writing = new Map();         // gid → the write to its archive under way (_exclusive)
  }

  init() {
    const lib = this.library;
    lib._db.exec(SCHEMA);
    // An index made before archiving: its columns added, and every gallery counted as used now.
    const have = new Set(lib._db.prepare('PRAGMA table_info(files)').all().map(c => c.name));
    for (const [name, type] of Object.entries(COLUMNS)) if (!have.has(name)) lib._db.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}`);
    lib._s('UPDATE files SET used_at = ? WHERE used_at IS NULL').run(Date.now());
    lib._db.exec(`CREATE INDEX IF NOT EXISTS files_used ON files (used_at, gid) WHERE format = 'folder'`);
    this.resume();
    this._sweepLater(60_000);
  }

  // Galleries left with work to do (the app closed before settling them, or their files were away)
  // are settled now, and out-of-date descriptions written in due course. Folders in staging nothing
  // is staged in any more (the app closed before clearing them) go.
  resume() {
    const lib = this.library;
    // What was being added to an archive when the app stopped: cut off, to be added again.
    for (const r of lib._s('SELECT gid, path, tail FROM files WHERE tail IS NOT NULL').all()) {
      try { if (fs.statSync(this._abs(r.path)).size > r.tail) fs.truncateSync(this._abs(r.path), r.tail); } catch {}
      lib._s('UPDATE files SET tail = NULL, pending = 1 WHERE gid = ?').run(r.gid);
    }
    const ids = new Set();
    for (const r of lib._s(`SELECT DISTINCT gid FROM pages WHERE json_extract(orig, '$.at') = 's'`).all()) ids.add(r.gid);
    for (const r of lib._s('SELECT DISTINCT gid FROM leftovers').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT gid FROM files WHERE unpack = 1').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT DISTINCT gid FROM staged_own').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT gid FROM files WHERE pending = 1').all()) this.scheduleDescribe(r.gid);
    for (const id of ids) this.schedule(id);
    fsp.readdir(lib.stagingDir).then(async (names) => {
      for (const name of names) if (!ids.has(name)) await this._unstage(name);
    }).catch(() => {});
  }

  close() {
    for (const timers of [this._timers, this._describeTimers]) {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    }
    clearTimeout(this._sweepTimer);
  }

  _row(gid) { return this.library._s('SELECT * FROM files WHERE gid = ?').get(String(gid)); }
  _abs(rel) { return path.join(this.library.libraryDir, ...String(rel).split('/')); }

  // Gallery `gid`'s folder, or null when it has none (not placed yet, or kept in an archive).
  folderOf(gid) {
    const row = this._row(gid);
    return row?.format === 'folder' ? this._abs(row.path) : null;
  }

  // Gallery `gid`'s folder, for a file of its own about to be written there: claimed now if the
  // gallery has none yet (`meta` names it when its metadata isn't stored yet), unpacked first if it
  // is kept in an archive added by hand (an archive in the gallery format takes its pictures staged:
  // stageOwn). A gallery whose folder is gone has nowhere to write.
  async home(gid, meta) {
    const id = String(gid);
    for (let tries = 0; tries < 3; tries++) {
      const row = this._row(id) || this._claim(id, meta);
      if (row.format !== 'folder') {
        this.library._tx(() => this._toUnpack(id));
        await this.place(id);
        continue;
      }
      const dir = this._abs(row.path);
      if (fs.existsSync(dir)) return dir;
      await this._seen(row, false);
      throw new BackendError('aborted', `the folder of gallery ${id} is missing`);
    }
    throw new BackendError('aborted', `gallery ${id} couldn't be unpacked into a folder`);
  }

  // Gallery `gid`'s place chosen and recorded, and its folder made — in one synchronous step, so
  // two claims can't pick different places. Returns its row.
  _claim(gid, meta) {
    const rel = this._choosePath(gid, meta);
    fs.mkdirSync(this._abs(rel), { recursive: true });
    this.library._s(`INSERT INTO files (gid, path, format, state, packed_at, pending, used_at) VALUES (?, ?, 'folder', 'packed', ?, 1, ?)`)
      .run(gid, rel, Date.now(), Date.now());
    this._pendOwner(gid);
    return this._row(gid);
  }

  // ── Hooks the library calls ──
  pageStored(gid) { this.schedule(gid); }

  // Inside the library's transaction dropping a page whose original was `orig` (in the gallery's
  // folder or archive): a file in the folder is deleted when the gallery is next settled; an archive
  // loses it then (a new directory without it, or rewritten whole).
  pageRemoved(gid, orig) {
    const row = this._row(gid);
    if (!row) return;
    if (row.format !== 'folder') this._toUnpack(row.gid);
    else if (orig?.entry) this.library._s('INSERT OR IGNORE INTO leftovers (gid, entry) VALUES (?, ?)').run(row.gid, String(orig.entry));
    this._pend(row.gid);
    this._later(() => this.schedule(row.gid));
  }

  // Inside the library's transaction dropping a file of the gallery's own (`rel`) kept in its archive
  // or staged for it: a staged one goes once that commits; the archive loses it at the next settle.
  ownDropped(gid, rel) {
    const row = this._row(gid);
    if (!row || row.format === 'folder') return;
    const lib = this.library;
    const staged = lib._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(row.gid, rel);
    if (staged) {
      lib._s('DELETE FROM staged_own WHERE gid = ? AND rel = ?').run(row.gid, rel);
      lib._drop(path.join(lib.stagingDir, staged.file));
    }
    this._toUnpack(row.gid);
    this._later(() => this.schedule(row.gid));
  }

  // A picture of its own for gallery `gid` (`rel`: translated/0001.png…) written to staging when the
  // gallery is kept in an archive in the gallery format — added to the archive at its next settle,
  // read from staging until then: its staging file (`<gid>/own-<random>.<ext>`). Null for a gallery
  // whose pictures go in its folder (or an archive added by hand, unpacked first: home()).
  async stageOwn(gid, rel, blob) {
    const row = this._row(gid);
    if (!row || row.format === 'folder' || !await this._inFormat(row)) return null;
    const file = `${row.gid}/own-${crypto.randomBytes(5).toString('hex')}${path.posix.extname(rel)}`;
    await this.library._writeStaged(file, new Uint8Array(await blob.arrayBuffer()), 'pictures');
    return file;
  }

  // Inside the library's transaction recording a picture stageOwn staged: it takes the place of one
  // staged for the same file before (whose staging file goes), and the gallery settles in due course.
  ownStaged(gid, rel, file, size) {
    const lib = this.library;
    const old = lib._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(String(gid), rel);
    if (old && old.file !== file) lib._drop(path.join(lib.stagingDir, old.file));
    lib._s('INSERT OR REPLACE INTO staged_own (gid, rel, file, size) VALUES (?, ?, ?, ?)').run(String(gid), rel, file, size);
    this._pend(gid);
    this._later(() => this.schedule(gid));
  }

  _stagedOwn(gid) { return this.library._s('SELECT rel, file, size FROM staged_own WHERE gid = ?').all(String(gid)); }

  // Inside a transaction writing a gallery's metadata: its descriptions follow in due course, and —
  // when it joined or left a series (`grouping`) — its folder or archive moves at its next settle. A
  // folder placed by hand otherwise stays where it is.
  metaChanged(gid, { grouping = false } = {}) {
    const id = String(gid);
    const row = this._row(id);
    if (!row) return;
    this._pend(id);
    if (grouping) this._regroupWanted.add(id);
    this._later(() => { if (grouping) this.schedule(id); this.scheduleDescribe(id); });
  }

  // Inside a transaction changing what was made from a gallery's pages (a translation, study
  // layers) or its cover: its descriptions follow in due course.
  describeLater(gid) {
    const id = String(gid);
    if (!this._row(id)) return;
    this._pend(id);
    this._later(() => this.scheduleDescribe(id));
  }

  // Gallery `gid` has something to catch up on (inside the caller's transaction when there is one).
  _pend(gid) {
    this.library._s('UPDATE files SET pending = 1 WHERE gid = ? AND pending = 0').run(String(gid));
    this._touched.add(String(gid));
    this.used(gid);
  }
  // Pictures were removed from its archive: its next settle adds to it or rewrites it.
  _toUnpack(gid) { this.library._s('UPDATE files SET unpack = 1 WHERE gid = ? AND unpack = 0').run(String(gid)); }
  // Gallery `gid` was used just now — changed, or opened in the reader (library.js): its archiving
  // waits another archiveAfter. Written at most once an hour.
  used(gid) {
    const now = Date.now();
    this.library._s('UPDATE files SET used_at = ? WHERE gid = ? AND (used_at IS NULL OR used_at < ?)').run(now, String(gid), now - HOUR);
  }
  // Its series' series.json too (the series' first gallery keeps it).
  _pendOwner(gid) {
    const owner = this._ownerOf(gid);
    if (!owner || String(owner.galleryId) === String(gid)) return;
    this._pend(owner.galleryId);
    this._later(() => this.scheduleDescribe(owner.galleryId));
  }
  // `fn` once the caller's transaction commits (at once outside one).
  _later(fn) { if (this.library._inTx) this.library._afterCommit(fn); else fn(); }

  // Inside the library's transaction deleting `gid`: its files go once that commits.
  deleteIn(gid) {
    const row = this._row(gid);
    this.library._s('DELETE FROM leftovers WHERE gid = ?').run(String(gid));
    for (const s of this._stagedOwn(gid)) this.library._drop(path.join(this.library.stagingDir, s.file));
    this.library._s('DELETE FROM staged_own WHERE gid = ?').run(String(gid));
    if (!row) return;
    this.library._s('DELETE FROM files WHERE gid = ?').run(String(gid));
    this.library._afterCommit(() => { this._forget(row.path); this._remove(row.path); });
  }

  clearIn() {
    const rows = this.library._s('SELECT path FROM files').all();
    this.library._s('DELETE FROM files').run();
    this.library._s('DELETE FROM leftovers').run();
    this.library._s('DELETE FROM staged_own').run();
    this.library._afterCommit(() => { for (const r of rows) { this._forget(r.path); this._remove(r.path); } });
  }

  // A deleted gallery's folder or archive deleted, and its series' folder too once nothing but
  // series.json is left in it.
  async _remove(rel) {
    const file = this._abs(rel);
    await this._delete(file);
    await this._tidy(path.dirname(file));
  }

  // A folder or file deleted outright — a folder once any Explorer window showing it is moved to
  // its parent. Resolves whether it is gone.
  async _delete(file) {
    if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) await this.library.vacate(file, path.dirname(file)).catch(() => {});
    try { await this.library.remove(file); } catch {}
    return !fs.existsSync(file);
  }

  // A series' folder left with nothing but its series.json (its members moved out or deleted):
  // deleted too. The library folder itself never is.
  async _tidy(dir) {
    if (path.resolve(dir) === path.resolve(this.library.libraryDir)) return;
    const left = await fsp.readdir(dir).catch(() => null);
    const spare = (name) => ['series.json', 'desktop.ini', 'thumbs.db'].includes(name.toLowerCase()) || name.endsWith('.shiori-tmp');
    if (!left || !left.every(spare)) return;
    await this._delete(dir);
  }

  _forget(rel) { this._dirs.delete(this._abs(rel)); }

  // ── Reading originals ──
  async readOriginal(gid, orig) {
    const row = this._row(gid);
    if (!row || orig?.at !== 'p') return null;
    const bytes = await this._read(row, orig.entry).catch(() => null);
    await this._seen(row, !!bytes);
    return bytes ? new Blob([bytes], orig.type ? { type: orig.type } : {}) : null;
  }

  // A file of the gallery's own (`rel`: translated/0001.png…), from staging while it waits there,
  // else from its folder or archive; null when it can't be read.
  async readOwn(gid, rel) {
    const staged = this.library._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(String(gid), rel);
    const row = this._row(gid);
    const kept = () => (row ? this._read(row, rel).catch(() => null) : null);
    return staged ? fsp.readFile(path.join(this.library.stagingDir, staged.file)).catch(kept) : kept();
  }

  // The pictures of its own gallery `gid`'s folder or archive holds (translated/, study/, pipeline/,
  // covers/), as paths in it.
  async ownNames(gid) {
    const row = this._row(gid);
    if (!row) return [];
    const derived = /^(translated|study\/bg|study\/text|pipeline|covers)\/[^/]+$/;
    const names = row.format === 'folder'
      ? await filesIn(this._abs(row.path)).catch(() => [])
      : [...(await this._directory(this._abs(row.path)).catch(() => new Map())).keys()];
    return [...new Set([...names, ...this._stagedOwn(gid).map(s => s.rel)])].filter(n => derived.test(n) && !n.endsWith('.json'));
  }

  async hasOriginal(gid, orig) {
    const row = this._row(gid);
    if (!row || orig?.at !== 'p') return false;
    if (row.format === 'folder') return fsp.access(path.join(this._abs(row.path), orig.entry)).then(() => true, () => false);
    return !!(await this._directory(this._abs(row.path)).catch(() => null))?.has(orig.entry);
  }

  async _read(row, entry) {
    const file = this._abs(row.path);
    this._reading.set(file, (this._reading.get(file) || 0) + 1);
    try {
      if (row.format === 'folder') return await fsp.readFile(path.join(file, entry));
      const found = (await this._directory(file)).get(entry);
      return found ? await readEntry(file, found) : null;
    } finally {
      const left = this._reading.get(file) - 1;
      if (left) this._reading.set(file, left); else this._reading.delete(file);
    }
  }

  // What a read says about the gallery's files: one that read is there (no longer missing); one
  // that didn't is missing when its folder or archive is gone — not when only a page is. Only a
  // change is written.
  async _seen(row, readable) {
    if (readable ? row.state !== 'missing' : row.state === 'missing') return;
    if (!readable && await fsp.access(this._abs(row.path)).then(() => true, () => false)) return;
    const lib = this.library;
    const state = readable ? 'packed' : 'missing';
    const changed = lib._tx(() => {
      const now = this._row(row.gid);
      if (!now || now.path !== row.path || now.state === state) return false;   // moved or unpacked meanwhile
      lib._s('UPDATE files SET state = ? WHERE gid = ?').run(state, row.gid);
      lib._logIn(row.gid);
      return true;
    });
    if (changed) lib.publishFeed(row.gid);
  }

  // An archive's directory, read once per version of the file.
  async _directory(file) {
    const stat = await fsp.stat(file);
    const cached = this._dirs.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.entries;
    const entries = await readDirectory(file);
    this._dirs.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
    if (this._dirs.size > 64) this._dirs.delete(this._dirs.keys().next().value);
    return entries;
  }

  // ── Settling ──
  schedule(gid, delay = this.placeDelay) {
    const id = String(gid);
    clearTimeout(this._timers.get(id));
    const t = setTimeout(() => { this._timers.delete(id); this.place(id).catch(() => {}); }, delay);
    t.unref?.();
    this._timers.set(id, t);
  }

  // Settle everything waiting, and write every out-of-date description (the app is closing).
  async flush() {
    const ids = [...this._timers.keys()];
    for (const id of ids) { clearTimeout(this._timers.get(id)); this._timers.delete(id); }
    await Promise.all([...this._placing.values()]);
    for (const id of ids) await this.place(id).catch(() => {});
    for (const t of this._describeTimers.values()) clearTimeout(t);
    this._describeTimers.clear();
    await Promise.all([...this._describing.values()]);
    for (const { gid } of this.library._s('SELECT gid FROM files WHERE pending = 1').all()) {
      await this.describe(gid).catch(() => {});
    }
  }

  async place(gid) {
    const id = String(gid);
    if (this._placing.has(id)) { this._again.add(id); return this._placing.get(id); }
    const run = this._place(id).then((done) => {
      this._failures.delete(id);
      if (!done) this.schedule(id, 1000);   // changed meanwhile: once it settles again
    }, (e) => {
      const n = (this._failures.get(id) || 0) + 1;
      this._failures.set(id, n);
      console.warn(`[shiori] saving gallery ${id} to the library folder failed (${n}):`, String(e?.message || e));
      if (n < 6) this.schedule(id, Math.min(60000, 2000 * 2 ** n));
    }).finally(() => {
      this._placing.delete(id);
      if (this._again.delete(id)) this.schedule(id);
    });
    this._placing.set(id, run);
    return run;
  }

  _staged(gid) { return this.library._pageRows(gid).filter(r => parse(r.orig).at === 's').sort((a, b) => a.n - b.n); }
  _leftovers(gid) { return this.library._s('SELECT entry FROM leftovers WHERE gid = ?').all(gid).map(r => r.entry); }

  // Whether an archive is in the gallery format (one Shiori made — it describes itself), so it can be
  // added to; one added by hand isn't.
  async _inFormat(row) {
    const dir = await this._directory(this._abs(row.path)).catch(() => null);
    return !!dir && (dir.has('metadata.json') || dir.has('image_records.json'));
  }

  // One settle of gallery `gid`. Resolves true when done (or nothing was needed), false when its
  // archive's pages changed while it was being unpacked.
  async _place(gid) {
    const lib = this.library;
    let row = this._row(gid);
    if (row) {
      // A gallery whose folder or archive is gone (moved outside the app, or its drive away) waits,
      // its new pages staged, until it reads again or the full check finds it — rather than starting
      // a new folder in its old place.
      const there = await fsp.access(this._abs(row.path)).then(() => true, () => false);
      await this._seen(row, there);
      if (!there) return true;
      row = this._row(gid);
      if (!row) return true;   // deleted meanwhile
      if (row.format !== 'folder' && (row.unpack || this._staged(gid).length || this._stagedOwn(gid).length)) {
        const how = await this._inFormat(row) ? await this._settleArchive(gid, row) : 'unpack';
        if (how === 'unpack' && !await this._unpack(gid, row)) return false;
        row = this._row(gid);
        if (!row) return true;
      }
      if (this._regroupWanted.delete(gid)) await this._regroup(gid);
      row = this._row(gid);
      if (!row) return true;
      if (row.format !== 'folder' || (!this._staged(gid).length && !this._leftovers(gid).length && !this._stagedOwn(gid).length)) {
        if (row.pending) this.scheduleDescribe(gid);
        return true;
      }
    } else {
      if (!this._staged(gid).length) return true;
      row = this._claim(gid);   // its place, kept from now on, recorded before any file moves there
    }
    const dir = this._abs(row.path);
    await fsp.mkdir(path.join(dir, 'images'), { recursive: true });
    for (const r of this._staged(gid)) await this._moveIn(gid, dir, r);
    await this._moveOwnIn(gid, dir);

    // The files of pages the gallery no longer has.
    const live = new Set(lib._pageRows(gid).map(r => parse(r.orig)).filter(o => o.at === 'p').map(o => o.entry));
    for (const entry of this._leftovers(gid)) {
      if (!live.has(entry)) await fsp.rm(path.join(dir, ...entry.split('/')), { force: true });
      lib._s('DELETE FROM leftovers WHERE gid = ? AND entry = ?').run(gid, entry);
    }

    if (!this._row(gid)) return true;   // deleted meanwhile
    this._pend(gid);   // its pages changed: its descriptions follow, in due course
    this.scheduleDescribe(gid);
    return true;
  }

  // Staged page `r` moved into the gallery's folder `dir`: flushed, then — in one synchronous step,
  // so no other operation sees the file in one place and its row naming the other — renamed into
  // images/ and its row pointed at it. A page replaced or removed meanwhile is left alone (its
  // staged file goes with its row). One already renamed before an interruption only has its row
  // brought up to date.
  async _moveIn(gid, dir, r) {
    const lib = this.library;
    const orig = parse(r.orig);
    const from = path.join(lib.stagingDir, orig.file);
    const name = this._nameFor(gid, r, orig);
    const to = path.join(dir, ...name.split('/'));
    const there = await flushed(from);
    const now = lib._pageRow(gid, r.n);
    if (!now || now.orig !== r.orig) return;
    if (there && moveSync(from, to)) lib.writes.add('pages', orig.size);
    else if (fs.statSync(to, { throwIfNoEntry: false })?.size !== orig.size) {
      console.warn(`[shiori] page ${r.n} of gallery ${gid} is gone from staging`);
      return;
    }
    lib._tx(() => {
      lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify({ at: 'p', entry: name, size: orig.size, type: orig.type }), gid, r.n);
      lib._s('DELETE FROM leftovers WHERE gid = ? AND entry = ?').run(gid, name);
    });
  }

  // Pictures of its own staged while the gallery was kept in an archive (unpacked since): renamed into
  // its folder, each where it belongs; one staged again meanwhile waits for the next settle.
  async _moveOwnIn(gid, dir) {
    const lib = this.library;
    for (const s of this._stagedOwn(gid)) {
      const from = path.join(lib.stagingDir, s.file), to = path.join(dir, ...s.rel.split('/'));
      const there = await flushed(from);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (lib._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(gid, s.rel)?.file !== s.file) continue;
      if (there && moveSync(from, to)) lib.writes.add('pictures', s.size);
      lib._s('DELETE FROM staged_own WHERE gid = ? AND rel = ?').run(gid, s.rel);
    }
  }

  // Where page `r` goes in its folder: images/0012.webp for page 12 (gallery-files.js) — or, when
  // another page of the gallery already has that name (a folder named by hand), the number and the
  // staged file's random part, so a retried move picks the same name.
  _nameFor(gid, r, orig) {
    const ext = layout.originalExt(orig.type, r.key);
    const name = layout.layoutPath.original(r.n, ext);
    const taken = this.library._s(`SELECT 1 FROM pages WHERE gid = ? AND n != ? AND json_extract(orig, '$.at') = 'p'
      AND json_extract(orig, '$.entry') = ?`).get(gid, r.n, name);
    if (!taken) return name;
    return name.replace(/\.(\w+)$/, `-${String(orig.file).match(/-([0-9a-f]+)\.\w+$/)?.[1] || 'x'}.$1`);
  }

  // ── Series ──
  // The series gallery `gid` belongs to (its first gallery's metadata, which lists the members), or
  // null.
  _ownerOf(gid) {
    const lib = this.library;
    const meta = lib._metaGet(gid);
    if (!meta) return null;
    if (meta.parentId) return lib._metaGet(meta.parentId);
    return Array.isArray(meta.chapters) && meta.chapters.length > 1 ? meta : null;
  }

  // The folder a series' members are in (the first one placed in a folder of its own), or null.
  _seriesFolder(owner) {
    for (const id of [owner.galleryId, ...(owner.chapters || []).map(c => c.id)]) {
      const rel = this._row(id)?.path;
      if (rel && rel.includes('/')) return path.posix.dirname(rel);
    }
    return null;
  }

  // Member `gid`'s folder name in its series.
  _memberName(owner, gid) {
    const at = (owner.chapters || []).findIndex(c => String(c.id) === String(gid));
    return layout.memberName(owner, owner.chapters?.[at], Math.max(0, at));
  }

  // Gallery `gid`'s folder (or archive) where its series says: a member inside its series' folder,
  // any other gallery at the top of the library folder. One that joined or left a series is moved
  // there — renamed, so nothing in it is written.
  async _regroup(gid) {
    const lib = this.library;
    const row = this._row(gid);
    if (!row) return;
    const ext = row.format === 'folder' ? '' : `.${row.format}`;
    const parent = path.posix.dirname(row.path);
    const owner = this._ownerOf(gid);
    let rel;
    if (owner) {
      const folder = this._seriesFolder(owner);
      if (folder && folder === parent) return;
      rel = this._freePath(`${folder || this._freePath(layout.seriesName(owner))}/${this._memberName(owner, gid)}`, ext);
    } else {
      if (parent === '.') return;
      rel = this._freePath(layout.galleryName(lib._metaGet(gid) || { galleryId: gid }), ext);
    }
    const from = this._abs(row.path), to = this._abs(rel);
    if (row.format === 'folder') await lib.vacate(from, to).catch(() => {});
    // One synchronous step from here.
    if (this._row(gid)?.path !== row.path) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    lib._tx(() => {
      lib._s('UPDATE files SET path = ? WHERE gid = ?').run(rel, gid);
      this._pend(gid);
      this._pendOwner(gid);
      if (owner) this._pend(owner.galleryId);
    });
    this._forget(row.path);
    if (owner) this.scheduleDescribe(owner.galleryId);
    await this._tidy(path.dirname(from));
  }

  // ── Unpacking an archive ──
  // An archive gallery unpacked into a folder (one added by hand, on its first change; one in the
  // gallery format when adding to it would leave too much of it unused): the pages its rows still
  // refer to are copied out one at a time into images/, and the pictures of its own its records
  // name (translations, study layers, masks, a cover) where they were; the folder takes the
  // archive's place in one synchronous step, and the archive is deleted. Its
  // descriptions are written afresh. Resolves false when its pages changed meanwhile (tried again
  // once they settle).
  async _unpack(gid, row) {
    const lib = this.library;
    const archived = () => lib._pageRows(gid).filter(r => parse(r.orig).at === 'p').sort((a, b) => a.n - b.n);
    const before = archived();
    const signature = JSON.stringify(before.map(r => [r.n, r.orig]));
    const rel = this._freePath(String(row.path).replace(/\.(cbz|zip)$/i, ''));
    const target = this._abs(rel);
    const temp = `${target}.shiori-tmp`;
    this._reserved.add(rel);
    try {
      await fsp.rm(temp, { recursive: true, force: true });
      await fsp.mkdir(path.join(temp, 'images'), { recursive: true });
      const out = [];
      for (const r of before) {
        const orig = parse(r.orig);
        const data = await this._read(row, orig.entry);
        if (!data) throw new Error(`page ${r.n} can't be read from ${row.path}`);
        const ext = layout.originalExt(orig.type || TYPE_OF_EXT[extOfName(orig.entry)], orig.entry);
        const entry = layout.layoutPath.original(r.n, ext);
        await writeFlushed(path.join(temp, ...entry.split('/')), data);
        lib.writes.add('pages', data.length);
        out.push({ n: r.n, orig: { at: 'p', entry, size: data.length, type: orig.type || TYPE_OF_EXT[ext] || '' } });
      }
      const own = ownFiles(lib._coverGet(gid), ownFiles(before.map(r => parse(r.record))));
      const staged = new Set(this._stagedOwn(gid).map(s => s.rel));   // moved in after, as they are
      for (const rel of own.keys()) {
        if (staged.has(rel)) continue;
        const data = await this._read(row, rel).catch(() => null);
        if (!data) continue;
        await fsp.mkdir(path.dirname(path.join(temp, ...rel.split('/'))), { recursive: true });
        await writeFlushed(path.join(temp, ...rel.split('/')), data);
        lib.writes.add('pictures', data.length);
      }
      // One synchronous step from here.
      if (JSON.stringify(archived().map(r => [r.n, r.orig])) !== signature || this._row(gid)?.path !== row.path) {
        await fsp.rm(temp, { recursive: true, force: true });
        return false;
      }
      fs.renameSync(temp, target);
      lib._tx(() => {
        for (const p of out) lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify(p.orig), gid, p.n);
        lib._s(`UPDATE files SET path = ?, format = 'folder', pending = 1, unpack = 0, used_at = ? WHERE gid = ?`).run(rel, Date.now(), gid);
        lib._s('DELETE FROM leftovers WHERE gid = ?').run(gid);
        lib._logIn(gid);
      });
      lib.publishFeed(gid);
      this._forget(row.path);
      this._discard(this._abs(row.path));
      return true;
    } catch (e) {
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
      throw e;
    } finally {
      this._reserved.delete(rel);
    }
  }

  // An archive whose pages are now in a folder, deleted once nothing reads it (or after a few
  // seconds' wait for that), so a converted gallery doesn't take its space twice.
  async _discard(file) {
    for (let i = 0; i < 3 && this._reading.get(file); i++) await new Promise(r => setTimeout(r, 1000));
    await this._delete(file);
  }

  // ── Descriptions ──
  // Gallery `gid` brought up to date on disk now: its staged pages moved in, then its descriptions —
  // and its series' — written when out of date. After a change made by hand, when a job writing its
  // pages ends, and when the reader leaves it.
  async settle(gid) {
    const id = String(gid);
    clearTimeout(this._timers.get(id));
    this._timers.delete(id);
    await this.place(id);
    await this.describe(id);
    const owner = this._ownerOf(id);
    if (owner) await this.describe(owner.galleryId);
  }

  // In due course, when nothing settles the gallery sooner: once it has been left alone a while.
  scheduleDescribe(gid, delay = this.describeDelay) {
    const id = String(gid);
    clearTimeout(this._describeTimers.get(id));
    const t = setTimeout(() => { this._describeTimers.delete(id); this.describe(id).catch(() => {}); }, delay);
    t.unref?.();
    this._describeTimers.set(id, t);
  }

  // Gallery `gid`'s descriptions brought up to date — and, for a series' first gallery, its
  // series.json — when they are out of date and its folder is there.
  async describe(gid) {
    const id = String(gid);
    if (this._describing.has(id)) { await this._describing.get(id); return this.describe(id); }
    clearTimeout(this._describeTimers.get(id));
    this._describeTimers.delete(id);
    const run = (async () => {
      const row = this._row(id);
      if (!row?.pending || row.unpack) return;
      const dir = this._abs(row.path);
      if (!fs.existsSync(dir)) return;
      this._touched.delete(id);
      if (row.format === 'folder') await this._describe(id, dir); else await this._describeArchive(id, row);
      await this._describeSeries(id);
      if (!this._touched.has(id)) this.library._s('UPDATE files SET pending = 0, packed_at = ? WHERE gid = ?').run(Date.now(), id);
    })();
    this._describing.set(id, run);
    try {
      await run;
    } catch (e) {
      console.warn(`[shiori] describing gallery ${id} in the library folder failed:`, String(e?.message || e));
      this.scheduleDescribe(id);
    } finally {
      this._describing.delete(id);
    }
    await this._unstage(id);
  }

  // Gallery `gid`'s folder in staging (inside the library folder's hidden .shiori), once nothing is
  // staged in it: removed, an Explorer window showing it moved out first. (A page staged meanwhile
  // makes the folder again: library.js _stage.)
  async _unstage(gid) {
    const lib = this.library;
    const dir = path.join(lib.stagingDir, String(gid));
    const empty = async () => !this._staged(gid).length && !this._stagedOwn(gid).length && (await fsp.readdir(dir).catch(() => null))?.length === 0;
    try {
      if (!await empty()) return;
      await lib.vacate(dir, lib.stagingDir).catch(() => {});
      if (!await empty()) return;
      lib._dirs.delete(dir);
      await fsp.rmdir(dir);
    } catch {}
  }

  // Gallery `gid`'s descriptions as the index holds it (gallery-files.js; its pages in its folder or
  // archive, and those about to be: `placing`, page numbers): [{ name, data }] — and ComicInfo.xml,
  // for a CBZ, as its export has.
  _descriptions(gid, { comicInfo = false, placing = null } = {}) {
    const lib = this.library;
    const meta = lib._metaGet(gid);
    const records = lib._pageRows(gid).filter(r => parse(r.orig).at === 'p' || placing?.has(r.n)).map(r => lib._rowRecord(r));
    const cover = lib._coverGet(gid);
    const out = layout.galleryFiles({ meta, records, covers: { gallery: cover?.cover, series: cover?.seriesCover } })
      .filter(f => DESCRIPTIONS.includes(f.name)).map(f => ({ name: f.name, data: Buffer.from(f.source) }));
    if (comicInfo) {
      const owner = meta?.parentId ? lib._metaGet(meta.parentId) : null;
      out.push({ name: 'ComicInfo.xml', data: Buffer.from(layout.comicInfoXml(meta, { owner, pageCount: records.length })) });
    }
    return out;
  }

  // A folder's descriptions written; those the gallery no longer has, removed.
  async _describe(gid, dir) {
    const listed = this._descriptions(gid);
    for (const f of listed) {
      const file = path.join(dir, ...f.name.split('/'));
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await replaceFile(file, f.data);
      this.library.writes.add('descriptions', f.data.length);
    }
    for (const name of DESCRIPTIONS) if (!listed.some(f => f.name === name)) await fsp.rm(path.join(dir, ...name.split('/')), { force: true });
  }

  // An archive's descriptions brought up to date: those that changed added to it (zip.js appendZip —
  // nothing else in it is written again), the length it had kept first, so an addition the app
  // didn't finish is cut off again (resume). An archive not in the gallery format (added by hand)
  // is left as it is.
  async _describeArchive(gid, row) {
    return this._exclusive(gid, () => this._describeArchiveNow(gid, row));
  }
  async _describeArchiveNow(gid, row) {
    const lib = this.library;
    const file = this._abs(row.path);
    const dir = await this._directory(file);
    if (!dir.has('metadata.json') && !dir.has('image_records.json')) return;
    const listed = this._descriptions(gid, { comicInfo: row.format === 'cbz' });
    const changed = [];
    for (const f of listed) {
      const entry = dir.get(f.name);
      if (!entry || entry.size !== f.data.length || !(await readEntry(file, entry)).equals(f.data)) changed.push(f);
    }
    const drop = DESCRIPTIONS.filter(name => dir.has(name) && !listed.some(f => f.name === name));
    if (!changed.length && !drop.length) return;
    lib._s('UPDATE files SET tail = ? WHERE gid = ?').run((await fsp.stat(file)).size, gid);
    lib.writes.addArchive(await appendZip(file, changed, { drop }));
    lib._s('UPDATE files SET tail = NULL WHERE gid = ?').run(gid);
    this._dirs.delete(file);
  }

  // `fn` once nothing else writes to gallery `gid`'s archive, and nothing else does until it is done.
  _exclusive(gid, fn) {
    const id = String(gid);
    const run = (this._writing.get(id) || Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => {});
    this._writing.set(id, settled);
    settled.then(() => { if (this._writing.get(id) === settled) this._writing.delete(id); });
    return run;
  }

  // An archive in the gallery format settled: what waits in staging for it (pages, pictures of its
  // own) and its out-of-date descriptions added at its end with one new directory listing what it
  // holds now (and no longer what was removed) — nothing in it written again. Unless that would
  // leave more than UNUSED_AT_MOST of it unused: with pictures waiting, 'unpack' (into a folder, where
  // they move in by renaming, so it writes least); with none, it is rewritten as a fresh archive.
  // Resolves 'done' or 'unpack'.
  async _settleArchive(gid, row) {
    return this._exclusive(gid, async () => {
      const lib = this.library;
      const file = this._abs(row.path);
      const dir = await this._directory(file);
      const rows = lib._pageRows(gid);
      const live = new Map();       // name → { size, from? (staging), data? (a description) }
      const placing = new Map();    // page number → { name, row } staged pages to add
      for (const r of rows) {
        const orig = parse(r.orig);
        if (orig.at === 's') {
          const name = this._nameFor(gid, r, orig);
          placing.set(r.n, { name, row: r });
          live.set(name, { size: orig.size, from: path.join(lib.stagingDir, orig.file) });
        } else if (orig.at === 'p') live.set(orig.entry, { size: dir.get(orig.entry)?.size ?? orig.size });
      }
      const stagedOwn = this._stagedOwn(gid);
      const staged = new Map(stagedOwn.map(s => [s.rel, s]));
      for (const [rel, size] of ownFiles(lib._coverGet(gid), ownFiles(rows.map(r => parse(r.record))))) {
        const s = staged.get(rel);
        live.set(rel, s ? { size: s.size, from: path.join(lib.stagingDir, s.file) } : { size: dir.get(rel)?.size ?? size ?? 0 });
      }
      this._touched.delete(gid);
      for (const d of this._descriptions(gid, { comicInfo: row.format === 'cbz', placing: new Set(placing.keys()) })) {
        const e = dir.get(d.name);
        const same = e && e.size === d.data.length && (await readEntry(file, e)).equals(d.data);
        live.set(d.name, same ? { size: e.size } : { size: d.data.length, data: d.data });
      }
      const add = [...live].filter(([, v]) => v.from || v.data).map(([name, v]) => (v.from ? { name, from: v.from } : { name, data: v.data }));
      const drop = [...dir.keys()].filter(name => !live.has(name));
      // Its rows pointed at what it now holds; the staging files that held it deleted at once after
      // (so the gallery's folder in staging can go when it is next described).
      const finish = () => {
        const gone = [];
        lib._tx(() => {
          for (const [n, { name, row: r }] of placing) {
            const now = lib._pageRow(gid, n);
            if (now?.orig !== r.orig) continue;   // replaced meanwhile: its new page waits for the next settle
            const orig = parse(r.orig);
            lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify({ at: 'p', entry: name, size: orig.size, type: orig.type }), gid, n);
            gone.push(path.join(lib.stagingDir, orig.file));
          }
          for (const s of stagedOwn) {
            if (lib._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(gid, s.rel)?.file !== s.file) continue;
            lib._s('DELETE FROM staged_own WHERE gid = ? AND rel = ?').run(gid, s.rel);
            gone.push(path.join(lib.stagingDir, s.file));
          }
          lib._s('UPDATE files SET tail = NULL WHERE gid = ?').run(gid);
          if (!this._touched.has(gid)) lib._s('UPDATE files SET unpack = 0, pending = 0, packed_at = ? WHERE gid = ?').run(Date.now(), gid);
          lib._logIn(gid);
        });
        for (const f of gone) fs.rmSync(f, { force: true });
      };
      if (!add.length && !drop.length) { finish(); return 'done'; }
      // How much of it would be unused once added to: all it would hold, but what it then lists.
      const { size } = await fsp.stat(file);
      const head = (name) => 30 + Buffer.byteLength(name);
      const directory = [...live.keys()].reduce((sum, name) => sum + 46 + Buffer.byteLength(name), 22);
      const after = size + add.reduce((sum, e) => sum + head(e.name) + live.get(e.name).size, 0) + directory;
      const used = [...live].reduce((sum, [name, v]) => sum + head(name) + v.size, 0) + directory;
      if ((after - used) / after > UNUSED_AT_MOST) {
        if (placing.size || stagedOwn.length) return 'unpack';
        await this._compact(gid, row, live, dir);
        finish();
        return 'done';
      }
      lib._s('UPDATE files SET tail = ? WHERE gid = ?').run(size, gid);
      lib.writes.addArchive(await appendZip(file, add, { drop }));
      this._dirs.delete(file);
      finish();
      lib.publishFeed(gid);
      return 'done';
    });
  }

  // An archive with too much of it unused and nothing waiting in staging, written whole once as a
  // fresh archive of what it holds (`live`, as _settleArchive lists it), which takes its place.
  async _compact(gid, row, live, dir) {
    const lib = this.library;
    const file = this._abs(row.path), temp = `${file}.shiori-tmp`;
    const entries = [...live].map(([name, v]) => (v.data ? { name, data: v.data } : { name, read: () => readEntry(file, dir.get(name)) }));
    try {
      lib.writes.addArchive(await writeZip(temp, entries));
      if ((await readDirectory(temp)).size !== entries.length) throw new Error('the archive did not read back');
      for (let i = 0; i < 3 && this._reading.get(file); i++) await new Promise(r => setTimeout(r, 1000));
      // One synchronous step from here.
      if (this._row(gid)?.path !== row.path) throw new Error('moved meanwhile');
      fs.renameSync(temp, file);
      this._dirs.delete(file);
    } catch (e) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw e;
    }
  }

  // A series' series.json in its folder (written for the series' first gallery): the members in
  // order and the folders they are in.
  async _describeSeries(gid) {
    const owner = this._ownerOf(gid);
    if (!owner || String(owner.galleryId) !== String(gid)) return;
    const folder = this._seriesFolder(owner);
    if (!folder) return;
    const folders = owner.chapters.map(c => {
      const rel = this._row(c.id)?.path;
      return rel && path.posix.dirname(rel) === folder ? path.posix.basename(rel).replace(/\.(cbz|zip)$/i, '') : undefined;
    });
    const manifest = layout.seriesManifest(owner, { folders });
    const data = Buffer.from(JSON.stringify(manifest, null, 2));
    await replaceFile(path.join(this._abs(folder), 'series.json'), data);
    this.library.writes.add('descriptions', data.length);
  }

  // ── Places ──
  // A folder (or, with `ext`, an archive) no gallery has, nothing is being written to and nothing on
  // disk holds: `base`, or `base (2)`, `base (3)`…
  _freePath(base, ext = '') {
    const lib = this.library;
    for (let i = 1; ; i++) {
      const rel = `${base}${i > 1 ? ` (${i})` : ''}${ext}`;
      const taken = this._reserved.has(rel) || lib._s('SELECT 1 FROM files WHERE path = ?').get(rel)
        || lib._s('SELECT 1 FROM retired WHERE path = ?').get(rel)
        || fs.existsSync(this._abs(rel)) || fs.existsSync(`${this._abs(rel)}.shiori-tmp`);
      if (!taken) return rel;
    }
  }

  // Where a gallery is first placed: a folder named after it at the top of the library folder, or —
  // a series member — "<Series> Ch. 001" in its series' folder (where its other members are, or a
  // new one named after the series). `given`: its metadata when it isn't stored yet.
  _choosePath(gid, given) {
    const lib = this.library;
    const owner = this._ownerOf(gid) || (given?.parentId ? lib._metaGet(given.parentId) : null);
    if (!owner) return this._freePath(layout.galleryName(lib._metaGet(gid) || given || { galleryId: gid }));
    const folder = this._seriesFolder(owner) || this._freePath(layout.seriesName(owner));
    return this._freePath(`${folder}/${this._memberName(owner, gid)}`);
  }

  // ── Archiving ──
  // Galleries left alone for archiveAfter, archived one at a time: looked for a minute after the
  // app starts, then every hour, and soon after the setting changes.
  _sweepLater(delay = HOUR) {
    clearTimeout(this._sweepTimer);
    this._sweepTimer = setTimeout(() => { this.sweep().catch(() => {}).finally(() => this._sweepLater()); }, delay);
    this._sweepTimer.unref?.();
  }
  sweepSoon() { this._sweepLater(5000); }

  sweep() {
    if (this._sweeping) return this._sweeping;
    this._sweeping = (async () => {
      await this._retire();
      if (!(this.archiveAfter > 0)) return;
      const before = Date.now() - this.archiveAfter;
      let after = [-1, ''];   // the last gallery looked at: (used_at, gid), in the order they are due
      for (;;) {
        const due = this.library._s(`SELECT gid, used_at FROM files WHERE format = 'folder' AND used_at < ?
          AND (used_at > ? OR (used_at = ? AND gid > ?)) ORDER BY used_at, gid LIMIT 32`).all(before, after[0], after[0], after[1]);
        if (!due.length) return;
        for (const { gid, used_at } of due) {
          after = [used_at, gid];
          await this.archive(gid).catch((e) => console.warn(`[shiori] archiving gallery ${gid} failed:`, String(e?.message || e)));
        }
      }
    })().finally(() => { this._sweeping = null; });
    return this._sweeping;
  }

  // Whether gallery `gid` (its files row `row`) can be archived now: a folder that is there, its
  // descriptions written, nothing staged, left to delete, to move or under way, and not open in a
  // reader.
  _idle(gid, row) {
    return row?.format === 'folder' && row.state === 'packed' && !row.pending && !row.unpack
      && !this._staged(gid).length && !this._leftovers(gid).length && !this._stagedOwn(gid).length && !this._regroupWanted.has(gid)
      && !this.library.reading.has(gid) && !this._placing.has(gid) && !this._describing.has(gid);
  }

  // What gallery `gid`'s files are made from, to tell whether it changed while being archived.
  _signature(gid) {
    const lib = this.library;
    return JSON.stringify([lib._pageRows(gid).map(r => [r.n, r.orig, r.record]),
      lib._s('SELECT record FROM covers WHERE gid = ?').get(gid)?.record ?? null,
      lib._s('SELECT record FROM meta WHERE gid = ?').get(gid)?.record ?? null]);
  }

  // What archiving gallery `gid` writes — its folder's files, each under the name it has there: its
  // descriptions, pages and pictures of its own (ComicInfo.xml too, for a CBZ) — or null when the
  // folder holds anything else (put there by hand, or a write under way) or lacks one of them.
  async _archiveEntries(gid, dir, format) {
    const lib = this.library;
    const rows = lib._pageRows(gid).sort((a, b) => a.n - b.n);
    const pictures = new Map();   // name → size
    for (const r of rows) {
      const orig = parse(r.orig);
      if (orig.at !== 'p') return null;
      pictures.set(orig.entry, orig.size ?? null);
    }
    const own = ownFiles(lib._coverGet(gid), ownFiles(rows.map(r => parse(r.record))));
    for (const [rel, size] of [...own].sort(([a], [b]) => (a < b ? -1 : 1))) pictures.set(rel, size);
    const descriptions = this._descriptions(gid, { comicInfo: format === 'cbz' });
    const named = new Set([...pictures.keys(), ...DESCRIPTIONS]);
    for (const name of await filesIn(dir)) {
      if (!named.has(name) && !WINDOWS_FILES.has(name.toLowerCase())) return null;
    }
    for (const [name, size] of pictures) {
      const stat = fs.statSync(path.join(dir, ...name.split('/')), { throwIfNoEntry: false });
      if (!stat?.isFile() || (size != null && stat.size !== size)) return null;
    }
    return [
      ...descriptions.filter(d => d.name !== 'ComicInfo.xml'),
      ...[...pictures.keys()].map(name => ({ name, from: path.join(dir, ...name.split('/')) })),
      ...descriptions.filter(d => d.name === 'ComicInfo.xml'),
    ];
  }

  // Gallery `gid` archived: its folder's files written once into one archive beside it (stored, in
  // archiveFormat), read back, then — in one synchronous step, when the gallery hasn't changed
  // meanwhile — put in the folder's place; the folder is deleted (`retired` remembers it until it is
  // gone, and the archive until the gallery has it). Resolves whether it was archived.
  async archive(gid) {
    const id = String(gid);
    const lib = this.library;
    const row = this._row(id);
    if (!this._idle(id, row)) return false;
    const format = this.archiveFormat === 'cbz' ? 'cbz' : 'zip';
    const dir = this._abs(row.path);
    const signature = this._signature(id);
    const entries = await this._archiveEntries(id, dir, format).catch(() => null);
    if (!entries) {   // left as a folder: looked at again after another while
      lib._s('UPDATE files SET used_at = ? WHERE gid = ?').run(Date.now(), id);
      return false;
    }
    const rel = this._freePath(row.path, `.${format}`);
    const file = this._abs(rel), temp = `${file}.shiori-tmp`;
    this._reserved.add(rel);
    try {
      lib.writes.addArchive(await writeZip(temp, entries));
      const written = await readDirectory(temp);
      const sizeOf = (e) => e.data?.length ?? fs.statSync(e.from).size;
      if (written.size !== entries.length || entries.some(e => written.get(e.name)?.size !== sizeOf(e))) throw new Error('the archive did not read back');
      // One synchronous step from here.
      const now = this._row(id);
      if (now?.path !== row.path || !this._idle(id, now) || this._signature(id) !== signature) {
        await fsp.rm(temp, { force: true });
        return false;
      }
      lib._s('INSERT OR IGNORE INTO retired (path) VALUES (?)').run(rel);
      fs.renameSync(temp, file);
      lib._tx(() => {
        lib._s('UPDATE files SET path = ?, format = ? WHERE gid = ?').run(rel, format, id);
        lib._s('DELETE FROM retired WHERE path = ?').run(rel);
        lib._s('INSERT OR IGNORE INTO retired (path) VALUES (?)').run(row.path);
        lib._logIn(id);
      });
      lib.publishFeed(id);
    } catch (e) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw e;
    } finally {
      this._reserved.delete(rel);
    }
    this._forget(row.path);
    await this._retire();
    return true;
  }

  // Folders and archives no gallery has any more (an archived gallery's folder; an archive an
  // interrupted archiving left) deleted; forgotten once gone, or once a gallery has the path again.
  async _retire() {
    const lib = this.library;
    const held = (rel) => !!lib._s('SELECT 1 FROM files WHERE path = ?').get(rel);
    for (const { path: rel } of lib._s('SELECT path FROM retired').all()) {
      const file = this._abs(rel);
      if (!held(rel) && fs.existsSync(file) && !this._reading.get(file)) await this._delete(file);
      if (held(rel) || !fs.existsSync(file)) lib._s('DELETE FROM retired WHERE path = ?').run(rel);
    }
  }
}

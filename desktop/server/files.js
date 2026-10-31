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
// would look like something important thrown away) — in the desktop app the way Explorer deletes
// (remove.js), so an Explorer window showing it steps back out of it on its own. A folder Windows
// won't move (a window shows a folder inside it) moves once that is left: tried again a little later.
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
import { files as layout, linked as linkedSource, content, titles, BackendError } from './shared.js';

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
CREATE TABLE IF NOT EXISTS unplaced (
  gid TEXT NOT NULL,
  rel TEXT NOT NULL,
  temp TEXT NOT NULL,
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
// picture of its own (`rel`) waiting in staging (`file`) to be added to its gallery's archive — or
// moved into its folder, written while that couldn't be (folders.js writable). `unplaced`: a picture
// of its own written into its gallery's folder beside its place `rel` (`temp`, its name there, relative
// to the folder too), recorded by the transaction that commits it and cleared only once it is renamed
// into place (placeOwn): until then it is read from `temp`, and the gallery has something its folder
// lacks (F03). `source`: for a
// linked gallery (linked-source.js) — files Shiori didn't make, used as they are — where they are
// ({ kind, path in its library folder, inner?, fingerprint }): its row's `path` is then its overlay
// (.shiori/linked/<gid>), a folder in the gallery format for everything Shiori adds, and a page whose
// original is in the source is at 'x' ({ at: 'x', entry: its name there }). A linked gallery's
// source is read only: never written, moved, archived, unpacked or deleted.
//
// The library may be kept in several folders (folders.js): the first one (the one it started with)
// and any added. A gallery's `path` is relative to the first folder, or `@<id>/<path>` in another one
// (its id: libraryId) — the folder it is placed in (folders.js `places`). A gallery stays in its
// folder: only moving it (moveTo) takes it to another, and a series' members are kept together only
// within one folder. Nothing here changes a folder's files unless the folder may be written to now
// (folders.js writable: reachable, this library's, shown — or being removed, for the removal's own
// write-back, `work` 'removal'); what can't be written waits, staged in the library's own staging.
const ROOTED = /^@([0-9a-f]{16})\/(.*)$/;   // a path in another library folder than the first
const UNUSED_AT_MOST = 0.25;   // the share of an archive left unused before it is written whole again
const REGROUP_RETRY = 10_000;  // how soon a folder Windows wouldn't move is tried again
const COLUMNS = { unpack: 'INTEGER NOT NULL DEFAULT 0', used_at: 'REAL', tail: 'REAL', source: 'TEXT' };
const HOUR = 60 * 60_000, DAY = 24 * HOUR;
// Files Windows puts in a folder on its own: not the gallery's, and not worth keeping it a folder for.
const WINDOWS_FILES = new Set(['desktop.ini', 'thumbs.db']);
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
// The stamp (gallery-files.js descriptionStamp) of descriptions `listed` ([{ name, data }]).
export const descriptionStampOf = (listed) => layout.descriptionStamp(Object.fromEntries(DESCRIPTIONS.map(name =>
  [name, listed.find(f => f.name === name)?.data.toString('utf8') ?? null])));

// The descriptions a gallery's folder may hold (gallery-files.js writes them).
const DESCRIPTIONS = layout.DESCRIPTION_FILES;
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

// The bytes of a file, or of every file in a folder.
async function bytesIn(abs) {
  const stat = await fsp.stat(abs);
  if (!stat.isDirectory()) return stat.size;
  let n = 0;
  for (const rel of await filesIn(abs)) n += (await fsp.stat(path.join(abs, ...rel.split('/')))).size;
  return n;
}

// What a folder of a library folder is (folder-content.js classifyFolder), from the descriptions it
// holds (`items`: its entries).
export async function classifyAt(dir, items) {
  const texts = {};
  for (const name of content.OWN_FILES) {
    if (items.some(i => i.isFile() && i.name === name)) texts[name] = await fsp.readFile(path.join(dir, name), 'utf8').catch(() => null);
  }
  return content.classifyFolder(texts);
}
// Whether folder `dir` is gallery `gid`'s own by what it holds — the overlay naming it (source.json),
// for a linked gallery; else its description (folder-content.js) — so that a folder the index took for
// a gallery's on another rule is never tidied (R01) nor deleted with it (F01).
export async function ownedBy(dir, gid, linked) {
  if (linked) return linkedSource.parseSource(await fsp.readFile(path.join(dir, linkedSource.SOURCE_FILE), 'utf8').catch(() => null))?.galleryId === gid;
  const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const what = await classifyAt(dir, items);
  return what.kind === 'gallery' && what.id === gid;
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
// The id folder `dir`'s .shiori/library.json names now — null when it names none (no folder there, no
// such file, one that can't be read or names no id): which library folder a path holds at this moment.
// Read only, never written: a folder's id is made once, when it first joins a library (libraryId).
export function libraryIdAt(dir) {
  try {
    const id = JSON.parse(fs.readFileSync(path.join(dir, '.shiori', 'library.json'), 'utf8'))?.id;
    return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) ? id : null;
  } catch { return null; }
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

// A small file replaced whole: written beside it, then renamed over it — tried again a few times
// while Windows refuses because something holds the file for a moment (a reader of it, an antivirus
// scan of the one just written), rather than losing the change (R17).
export async function replaceFile(file, data) {
  const temp = `${file}.shiori-tmp`;
  await writeFlushed(temp, data);
  for (let attempt = 0; ; attempt++) {
    try { return await fsp.rename(temp, file); } catch (e) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) { await fsp.rm(temp, { force: true }).catch(() => {}); throw e; }
      await new Promise(r => setTimeout(r, 50 * 2 ** attempt));
    }
  }
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
    this._regroupRetries = new Map();  // gid → the settle trying again a folder Windows wouldn't move
    this._reserved = new Set();        // folders chosen by unpacks still running
    this._dirs = new Map();            // archive path → { mtimeMs, size, entries }
    this._reading = new Map();         // archive path → reads in flight
    this._failures = new Map();        // gid → settles that failed in a row
    this._writing = new Map();         // gid → the write to its archive under way (_exclusive)
    this.keep = new Set();             // galleries being forgotten: deleted from the index, their files kept
  }

  // The tables (the library's folders are read next: folders.js), then — start — what was left to do.
  init() {
    const lib = this.library;
    lib._db.exec(SCHEMA);
    // An index made before archiving: its columns added, and every gallery counted as used now.
    const have = new Set(lib._db.prepare('PRAGMA table_info(files)').all().map(c => c.name));
    for (const [name, type] of Object.entries(COLUMNS)) if (!have.has(name)) lib._db.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}`);
    lib._s('UPDATE files SET used_at = ? WHERE used_at IS NULL').run(Date.now());
    lib._db.exec(`CREATE INDEX IF NOT EXISTS files_used ON files (used_at, gid) WHERE format = 'folder'`);
  }
  start() {
    this.resume();
    this._sweepLater(60_000);
  }

  // Galleries left with work to do (the app closed before settling them, or their files were away)
  // are settled now, and out-of-date descriptions written in due course. Folders in staging nothing
  // is staged in any more (the app closed before clearing them) go. Again whenever a folder can be
  // written to again (shown, taken back) — what waited for it then goes there.
  resume() {
    const lib = this.library;
    // What was being added to an archive when the app stopped: cut off, to be added again (once its
    // folder may be written to).
    for (const r of lib._s('SELECT gid, path, tail FROM files WHERE tail IS NOT NULL').all()) {
      if (!lib.folders.writable(this._split(r.path).root)) continue;
      try { if (fs.statSync(this._abs(r.path)).size > r.tail) fs.truncateSync(this._abs(r.path), r.tail); } catch {}
      lib._s('UPDATE files SET tail = NULL, pending = 1 WHERE gid = ?').run(r.gid);
    }
    const ids = new Set();
    for (const r of lib._s(`SELECT DISTINCT gid FROM pages WHERE json_extract(orig, '$.at') = 's'`).all()) ids.add(r.gid);
    for (const r of lib._s('SELECT DISTINCT gid FROM leftovers').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT gid FROM files WHERE unpack = 1').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT DISTINCT gid FROM staged_own').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT DISTINCT gid FROM unplaced').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT gid FROM files WHERE pending = 1').all()) this.scheduleDescribe(r.gid);
    for (const id of ids) this.schedule(id);
    for (const dir of lib.stagingDirs()) {
      fsp.readdir(dir).then(async (names) => {
        for (const name of names) if (!ids.has(name)) await this._unstage(name);
      }).catch(() => {});
    }
  }

  close() {
    for (const timers of [this._timers, this._describeTimers, this._regroupRetries]) {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    }
    clearTimeout(this._sweepTimer);
  }

  _row(gid) { return this.library._s('SELECT * FROM files WHERE gid = ?').get(String(gid)); }
  _abs(rel) {
    const { root, rest } = this._split(rel);
    return path.join(this.library.rootDir(root), ...rest.split('/'));
  }
  // A path as { root (the folder's id), rest (the path in it) }, and back.
  _split(rel) {
    const m = ROOTED.exec(String(rel));
    return m ? { root: m[1], rest: m[2] } : { root: this.library.primaryId, rest: String(rel) };
  }
  _join(root, rest) { return !root || root === this.library.primaryId ? rest : `@${root}/${rest}`; }

  // The library folder gallery `gid` is kept in: its place (folders.js `places`, the folder its files
  // are in) — never wherever new galleries go now, so a gallery with no files yet (a series not
  // downloaded) stays in its folder when the default changes, and is hidden or removed with it. One
  // with files but no place yet (a record with metadata only that had a cover of its own) is where its
  // files are; one with neither goes where new galleries go.
  rootFor(gid) {
    const id = String(gid);
    const place = this.library._s('SELECT root FROM places WHERE gid = ?').get(id)?.root;
    if (place) return place;
    const row = this._row(id);
    return row ? this._split(row.path).root : this.library.defaultRoot();
  }

  // Gallery `gid`'s folder, or null when it has none (not placed yet, or kept in an archive).
  folderOf(gid) {
    const row = this._row(gid);
    return row?.format === 'folder' ? this._abs(row.path) : null;
  }

  // Gallery `gid`'s folder, for a file of its own about to be written there: claimed now if the
  // gallery has none yet (`meta` names it when its metadata isn't stored yet), unpacked first if it
  // is kept in an archive added by hand (an archive in the gallery format takes its pictures staged:
  // stageOwn). A gallery whose folder is gone, or can't be written to now, has nowhere to write.
  async home(gid, meta) {
    const id = String(gid);
    this.library.folders.assertWritable(this.rootFor(id));
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

  // Gallery `gid`'s folder chosen in the library folder it is placed in, made, and recorded — in one
  // synchronous step, so two claims can't pick different places — when that library folder may be
  // written to (`work` as folders.js writable). A folder that can't be made leaves the gallery as it
  // was: placed where it was, with no folder yet. The folder is bound to the gallery from its first
  // moment: its metadata.json (as much of it as is known) is written there at once, as the website's
  // reserveDir does — nothing is deleted for a gallery from a folder no description of it names
  // (_owns), and its full descriptions follow in due course. Returns its row.
  _claim(gid, meta, work = null) {
    this.library.folders.assertWritable(this.rootFor(gid), work);
    const rel = this._choosePath(gid, meta);
    const abs = this._abs(rel);
    fs.mkdirSync(abs, { recursive: true });
    const named = titles.migrateTitle({ ...(meta || this.library._metaGet(gid) || {}), galleryId: String(gid) });
    fs.writeFileSync(path.join(abs, 'metadata.json'), JSON.stringify(named, null, 2));
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
    if (orig?.at === 'x') { this._pend(row.gid); this._later(() => this.scheduleDescribe(row.gid)); return; }   // its source keeps it
    if (row.format !== 'folder') this._toUnpack(row.gid);
    else if (orig?.entry) this.library._s('INSERT OR IGNORE INTO leftovers (gid, entry) VALUES (?, ?)').run(row.gid, String(orig.entry));
    this._pend(row.gid);
    this._later(() => this.schedule(row.gid));
  }

  // Inside the library's transaction dropping a file of the gallery's own (`rel`, a picture's layout
  // name): one staged for it goes once that commits; one in its folder then too, when the folder may
  // be written to — else at its next settle (a leftover); its archive loses it at its next settle.
  ownDropped(gid, rel) {
    const lib = this.library;
    const id = String(gid);
    const staged = lib._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(id, rel);
    if (staged) {
      lib._s('DELETE FROM staged_own WHERE gid = ? AND rel = ?').run(id, rel);
      lib._dropStaged(staged.file);
    }
    const row = this._row(id);
    if (!row) return;
    if (row.format !== 'folder') {
      this._toUnpack(id);
      this._later(() => this.schedule(id));
    } else if (lib.folders.writable(this.rootFor(id))) {
      const file = path.join(this._abs(row.path), ...rel.split('/'));
      lib._afterCommit(() => fs.rmSync(file, { force: true }));
    } else lib._s('INSERT OR IGNORE INTO leftovers (gid, entry) VALUES (?, ?)').run(id, rel);
  }

  // A picture of its own for gallery `gid` (`rel`: translated/0001.png…) written to staging when the
  // gallery is kept in an archive in the gallery format, or its library folder can't be written to now
  // — added to the archive or moved into its folder at its next settle, read from staging until then:
  // its staging file (`<gid>/own-<random>.<ext>`). Null for a gallery whose pictures go in its folder
  // now (or an archive added by hand, unpacked first: home()).
  async stageOwn(gid, rel, blob) {
    const id = String(gid);
    const row = this._row(id);
    const archived = row && row.format !== 'folder' && await this._inFormat(row);
    if (!archived && this.library.folders.writable(this.rootFor(id))) return null;
    const file = this.library._stagedName(id, `own-${crypto.randomBytes(5).toString('hex')}${path.posix.extname(rel)}`);
    await this.library._writeStaged(file, new Uint8Array(await blob.arrayBuffer()), 'pictures');
    return file;
  }

  // Inside the library's transaction recording a picture stageOwn staged: it takes the place of one
  // staged for the same file before (whose staging file goes) — and of one waiting to be deleted from
  // its folder (ownDropped) — and the gallery settles in due course.
  ownStaged(gid, rel, file, size) {
    const lib = this.library;
    const old = lib._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(String(gid), rel);
    if (old && old.file !== file) lib._dropStaged(old.file);
    lib._s('INSERT OR REPLACE INTO staged_own (gid, rel, file, size) VALUES (?, ?, ?, ?)').run(String(gid), rel, file, size);
    lib._s('DELETE FROM leftovers WHERE gid = ? AND entry = ?').run(String(gid), rel);
    this._pend(gid);
    this._later(() => this.schedule(gid));
  }
  // Inside the library's transaction recording a picture written into the gallery's folder under
  // `temp` (its name there, beside `rel`): no longer one to delete there, and — part of what commits —
  // waiting to be renamed into place (`unplaced`, placeOwn). One that waited for the same place before
  // is passed over: left beside it, a temporary file the folder's sweep takes in time.
  ownPlaced(gid, rel, temp) {
    const lib = this.library;
    lib._s('DELETE FROM leftovers WHERE gid = ? AND entry = ?').run(String(gid), rel);
    lib._s('INSERT OR REPLACE INTO unplaced (gid, rel, temp) VALUES (?, ?, ?)').run(String(gid), rel, temp);
  }

  // Gallery `gid`'s pictures of its own waiting in its folder to take their place (ownPlaced) renamed
  // into it, while the folder may be written to (`work` as folders.js writable) — each one's row
  // cleared only once it is there (or its file is gone: renamed before its row could be cleared).
  // Returns how many still wait.
  placeOwn(gid, work = null) {
    const lib = this.library, id = String(gid);
    const waiting = this._unplaced(id);
    const row = this._row(id);
    if (!waiting.length || row?.format !== 'folder' || !lib.folders.writable(this.rootFor(id), work)) return waiting.length;
    const dir = this._abs(row.path);
    let left = 0;
    for (const { rel, temp } of waiting) {
      try { fs.renameSync(path.join(dir, ...temp.split('/')), path.join(dir, ...rel.split('/'))); } catch (e) {
        if (e?.code !== 'ENOENT') { left++; continue; }
      }
      lib._s('DELETE FROM unplaced WHERE gid = ? AND rel = ? AND temp = ?').run(id, rel, temp);
    }
    return left;
  }
  _unplaced(gid) { return this.library._s('SELECT rel, temp FROM unplaced WHERE gid = ?').all(String(gid)); }
  // The name gallery `gid`'s own file `rel` has in its folder now: the one it was written under while it
  // waits to take its place, else `rel`.
  _ownName(gid, rel) { return this.library._s('SELECT temp FROM unplaced WHERE gid = ? AND rel = ?').get(String(gid), rel)?.temp ?? rel; }

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
    const lib = this.library;
    const row = this._row(gid);
    lib._s('DELETE FROM stamps WHERE gid = ?').run(String(gid));
    lib._s('DELETE FROM leftovers WHERE gid = ?').run(String(gid));
    for (const s of this._stagedOwn(gid)) lib._dropStaged(s.file);
    lib._s('DELETE FROM staged_own WHERE gid = ?').run(String(gid));
    lib._s('DELETE FROM unplaced WHERE gid = ?').run(String(gid));
    if (!row) return;
    lib._s('DELETE FROM files WHERE gid = ?').run(String(gid));
    // A gallery forgotten (its library folder removed from the library) keeps its files.
    const keep = this.keep.has(String(gid));
    const linked = !keep && !!row.source;
    if (linked) lib.folders.removedIn(this._split(row.path).root, gid, row.path, this.sourceOf(row));
    lib._afterCommit(() => {
      this._forget(row.path);
      if (!keep) this._removeLeft(row.path, gid, linked).catch(() => {});
    });
  }

  // What gallery `gid`, deleted from the library or moved out of a library folder, left there (`rel`)
  // deleted, as far as it is the gallery's own by what it holds (_removeOwn). A linked gallery's source
  // is never deleted, and its overlay only once the note that its source was removed — recorded by the
  // transaction that let the gallery go (folders.js removedIn) — is in removed.json: publishing the
  // notes deletes the overlays they stand for (folders.js publishRemoved), and one that can't be
  // published now is tried again. `work` as folders.js writable.
  async _removeLeft(rel, gid, linked, work = null) {
    if (linked) await this.library.folders.publishRemoved(this._split(rel).root, { work });
    else await this._removeOwn(rel, gid, false, work);
  }
  // Folder or archive `rel` deleted for gallery `gid` (_remove) only when it is the gallery's own by
  // what it holds (_owns): never one another gallery's description names, or none does — a folder put
  // at the gallery's old place by hand, or another library's on a drive given the same letter (F01).
  async _removeOwn(rel, gid, linked, work = null) {
    if (await this._owns(rel, gid, linked)) await this._remove(rel, work);
  }
  // Whether `rel` is gallery `gid`'s own by what it holds: a folder as ownedBy says (its overlay's
  // source.json, `linked`, or its description), an archive by its descriptions (folder-content.js
  // classifyArchive).
  async _owns(rel, gid, linked) {
    const abs = this._abs(rel);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) return false;
    if (stat.isDirectory()) return ownedBy(abs, String(gid), linked);
    const dir = await this._directory(abs).catch(() => null);
    if (!dir) return false;
    const texts = {};
    for (const name of content.OWN_FILES) if (dir.has(name)) texts[name] = (await readEntry(abs, dir.get(name)).catch(() => null))?.toString('utf8') ?? null;
    const what = content.classifyArchive([...dir.keys()], texts);
    return what.kind === 'gallery' && what.id === String(gid);
  }

  clearIn() {
    const rows = this.library._s('SELECT gid, path, source FROM files').all();
    for (const table of ['files', 'leftovers', 'staged_own', 'unplaced']) this.library._s(`DELETE FROM ${table}`).run();
    this.library._afterCommit(() => { for (const r of rows) { this._forget(r.path); this._removeOwn(r.path, r.gid, r.source != null).catch(() => {}); } });
  }

  // A deleted gallery's folder or archive deleted, and its series' folder too once nothing but
  // series.json is left in it — when its library folder may be written to (`work` as folders.js
  // writable): one another app keeps, hidden or out of reach keeps its files.
  async _remove(rel, work = null) {
    if (!this.library.folders.writable(this._split(rel).root, work)) return;
    const file = this._abs(rel);
    await this._delete(file);
    await this._tidy(path.dirname(file));
  }

  // A folder or file deleted outright. Resolves whether it is gone.
  async _delete(file) {
    try { await this.library.remove(file); } catch {}
    return !fs.existsSync(file);
  }

  // A series' folder left with nothing but its series.json (its members moved out or deleted):
  // deleted too. The library folder itself never is.
  async _tidy(dir) {
    if (this.library.folders.paths().some(root => path.resolve(dir) === path.resolve(root))) return;
    const left = await fsp.readdir(dir).catch(() => null);
    const spare = (name) => ['series.json', 'desktop.ini', 'thumbs.db'].includes(name.toLowerCase()) || name.endsWith('.shiori-tmp');
    if (!left || !left.every(spare)) return;
    await this._delete(dir);
  }

  _forget(rel) { this._dirs.delete(this._abs(rel)); }

  // ── Reading originals ──
  async readOriginal(gid, orig) {
    const row = this._row(gid);
    if (row && orig?.at === 'x') {
      const bytes = await this._readSource(row, orig.entry).catch(() => null);
      await this._seen(row, !!bytes);
      return bytes ? new Blob([bytes], orig.type ? { type: orig.type } : {}) : null;
    }
    if (!row || orig?.at !== 'p') return null;
    const bytes = await this._read(row, orig.entry).catch(() => null);
    await this._seen(row, !!bytes);
    return bytes ? new Blob([bytes], orig.type ? { type: orig.type } : {}) : null;
  }

  // A file of the gallery's own (`rel`: translated/0001.png…), from staging while it waits there,
  // else from its folder (under the name it was written as, while it waits to take its place) or
  // archive; null when it can't be read.
  async readOwn(gid, rel) {
    const staged = this.library._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(String(gid), rel);
    const row = this._row(gid);
    const name = this._ownName(gid, rel);
    const placed = () => (row ? this._read(row, rel).catch(() => null) : null);
    const kept = () => (row && name !== rel ? this._read(row, name).catch(placed) : placed());   // renamed meanwhile
    return staged ? fsp.readFile(this.library._staged(staged.file)).catch(kept) : kept();
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
    if (row && orig?.at === 'x') {
      const src = this.sourceOf(row);
      if (src?.kind === 'dir') return fsp.access(path.join(this._sourceAbs(row), orig.entry)).then(() => true, () => false);
      return !!(await this._directory(this._sourceAbs(row)).catch(() => null))?.has(orig.entry);
    }
    if (!row || orig?.at !== 'p') return false;
    if (row.format === 'folder') return fsp.access(path.join(this._abs(row.path), orig.entry)).then(() => true, () => false);
    return !!(await this._directory(this._abs(row.path)).catch(() => null))?.has(orig.entry);
  }

  // A linked gallery's source ({ kind, path, inner?, fingerprint }), or null; where it is — in its
  // library folder (the pictures at its top: the folder itself), always: a path that would lead out of
  // it (R12) is a path that isn't there.
  sourceOf(row) { try { return row?.source ? JSON.parse(row.source) : null; } catch { return null; } }
  _sourceAbs(row) {
    const root = this.library.rootDir(this._split(row.path).root);
    const abs = path.resolve(root, ...String(this.sourceOf(row)?.path ?? '').split('/'));
    const rel = path.relative(root, abs);
    const out = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    return out ? path.join(this.library.dataDir, 'gone', 'outside') : abs;
  }
  // A page of a linked gallery's source (its name in the folder, or in the archive), as bytes.
  async _readSource(row, entry) {
    const src = this.sourceOf(row);
    if (!src) return null;
    const abs = this._sourceAbs(row);
    if (src.kind === 'dir') return fsp.readFile(path.join(abs, entry));
    const found = (await this._directory(abs)).get(entry);
    return found ? readEntry(abs, found) : null;
  }
  // The file a linked gallery's page is, when it is one on its own (a folder of pictures), for a
  // read that needn't load it.
  sourceFile(gid, orig) {
    const row = this._row(gid);
    const src = this.sourceOf(row);
    return src?.kind === 'dir' && orig?.at === 'x' ? path.join(this._sourceAbs(row), orig.entry) : null;
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
    if (!readable && await fsp.access(row.source ? this._sourceAbs(row) : this._abs(row.path)).then(() => true, () => false)) return;
    const lib = this.library;
    const state = readable ? 'packed' : 'missing';
    const changed = lib.asFolderWork(this.rootFor(row.gid), () => lib._tx(() => {
      const now = this._row(row.gid);
      if (!now || now.path !== row.path || now.state === state) return false;   // moved or unpacked meanwhile
      lib._s('UPDATE files SET state = ? WHERE gid = ?').run(state, row.gid);
      lib._logIn(row.gid);
      return true;
    }));
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

  // A folder Windows wouldn't move, settled again in a little while — on a timer of its own, as a
  // change to the gallery puts its settle off again.
  _retryRegroup(gid) {
    const id = String(gid);
    clearTimeout(this._regroupRetries.get(id));
    const t = setTimeout(() => { this._regroupRetries.delete(id); this.place(id).catch(() => {}); }, REGROUP_RETRY);
    t.unref?.();
    this._regroupRetries.set(id, t);
  }

  // Settle everything waiting, and write every out-of-date description (the app is closing).
  async flush() {
    const ids = [...new Set([...this._timers.keys(), ...this._regroupRetries.keys()])];
    for (const timers of [this._timers, this._regroupRetries]) {
      for (const id of ids) { clearTimeout(timers.get(id)); timers.delete(id); }
    }
    await Promise.all([...this._placing.values()]);
    for (const id of ids) await this.place(id).catch(() => {});
    for (const t of this._describeTimers.values()) clearTimeout(t);
    this._describeTimers.clear();
    await Promise.all([...this._describing.values()]);
    for (const { gid } of this.library._s('SELECT gid FROM files WHERE pending = 1').all()) {
      await this.describe(gid).catch(() => {});
    }
  }

  // Gallery `gid` settled: what waits in staging moved into its folder (_place) — when its library
  // folder may be written to (`work` as folders.js writable: 'removal', its removal's write-back,
  // which waits for a settle under way rather than joining it). Failures are tried again later.
  async place(gid, { work = null } = {}) {
    const id = String(gid);
    while (work && this._placing.has(id)) await this._placing.get(id);
    if (this._placing.has(id)) { this._again.add(id); return this._placing.get(id); }
    const run = this._place(id, work).then((done) => {
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

  // One settle of gallery `gid`. Resolves true when done (or nothing was needed, or its library folder
  // can't be written to now: what waits stays staged until it can), false when its archive's pages
  // changed while it was being unpacked.
  async _place(gid, work = null) {
    const lib = this.library;
    if (!lib.folders.writable(this.rootFor(gid), work)) return true;
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
      this.placeOwn(gid, work);   // pictures that couldn't take their place as they committed
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
      if (!this._staged(gid).length && !this._stagedOwn(gid).length) return true;
      row = this._claim(gid, null, work);   // its folder, kept from now on, recorded before any file moves there
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
    const from = lib._staged(orig.file);
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
      const from = lib._staged(s.file), to = path.join(dir, ...s.rel.split('/'));
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

  // The folder a series' members are in (the first one placed in a folder of its own) — in library
  // folder `root` when given — or null.
  _seriesFolder(owner, root = null) {
    for (const id of [owner.galleryId, ...(owner.chapters || []).map(c => c.id)]) {
      const rel = this._row(id)?.path;
      if (!rel) continue;
      const at = this._split(rel);
      if (at.rest.includes('/') && (root == null || at.root === root)) return this._join(at.root, path.posix.dirname(at.rest));
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
    if (!row || row.source) return;   // a linked gallery's overlay stays where it is
    const ext = row.format === 'folder' ? '' : `.${row.format}`;
    // Within the library folder it is in: a gallery is only ever moved to another one by moveTo.
    const { root, rest } = this._split(row.path);
    const parent = this._join(root, path.posix.dirname(rest));
    const top = path.posix.dirname(rest) === '.';
    const owner = this._ownerOf(gid);
    let rel;
    if (owner) {
      const folder = this._seriesFolder(owner, root);
      if (folder && folder === parent) return;
      rel = this._freePath(`${folder || this._freePath(this._join(root, layout.seriesName(owner)))}/${this._memberName(owner, gid)}`, ext);
    } else {
      if (top) return;
      rel = this._freePath(this._join(root, layout.galleryName(lib._metaGet(gid) || { galleryId: gid })), ext);
    }
    const from = this._abs(row.path), to = this._abs(rel);
    // One synchronous step from here.
    if (this._row(gid)?.path !== row.path) return;
    const made = fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); } catch (e) {
      // Windows won't move a folder while something shows or uses a folder inside it (an Explorer
      // window): it stays where it is until then, tried again a little later — and a series' folder
      // made for it goes again at once, so no other member takes it for one already there.
      if (made) try { fs.rmdirSync(made); } catch {}
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      this._regroupWanted.add(gid);
      this._retryRegroup(gid);
      return;
    }
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
      // Recorded as it now is on disk, whether or not the gallery is still in the library.
      lib.asFolderWork(this.rootFor(gid), () => lib._tx(() => {
        for (const p of out) lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify(p.orig), gid, p.n);
        lib._s(`UPDATE files SET path = ?, format = 'folder', pending = 1, unpack = 0, used_at = ? WHERE gid = ?`).run(rel, Date.now(), gid);
        lib._s('DELETE FROM leftovers WHERE gid = ?').run(gid);
        lib._logIn(gid);
      }));
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
  // series.json — when they are out of date, its folder is there and its library folder may be written
  // to (`work` as folders.js writable): one that can't be now waits, still pending (a hidden folder's
  // until it is shown, another app's until it is taken back). `all`: written even when nothing is
  // waiting to be (a folder being removed from the library: only the descriptions that differ from
  // the index's are written). Resolves { ok }: whether the folder now has them — false when they
  // couldn't be written (tried again later) or were waiting to be and weren't.
  async describe(gid, { all = false, work = null } = {}) {
    const id = String(gid);
    if (this._describing.has(id)) { await this._describing.get(id).catch(() => {}); return this.describe(id, { all, work }); }
    clearTimeout(this._describeTimers.get(id));
    this._describeTimers.delete(id);
    const run = (async () => {
      const row = this._row(id);
      if (!row || row.unpack) return false;
      if (!row.pending && !all) return true;
      if (!this.library.folders.writable(this.rootFor(id), work)) return false;
      const dir = this._abs(row.path);
      if (!fs.existsSync(dir)) return false;
      this._touched.delete(id);
      if (row.format === 'folder') await this._describe(id, dir, { onlyChanged: all });
      else if (!await this._describeArchive(id, row)) return false;
      await this._describeSeries(id);
      if (!this._touched.has(id)) this.library._s('UPDATE files SET pending = 0, packed_at = ? WHERE gid = ?').run(Date.now(), id);
      return true;
    })();
    this._describing.set(id, run);
    let ok = false;
    try {
      ok = await run;
    } catch (e) {
      console.warn(`[shiori] describing gallery ${id} in the library folder failed:`, String(e?.message || e));
      this.scheduleDescribe(id);
    } finally {
      this._describing.delete(id);
    }
    await this._unstage(id);
    return { ok };
  }

  // Gallery `gid`'s folder in staging (inside the library folder's hidden .shiori), once nothing is
  // staged in it: removed — only while empty, so a page staged meanwhile is never lost with it (it
  // makes the folder again: library.js _stage).
  async _unstage(gid) {
    const lib = this.library;
    for (const staging of lib.stagingDirs()) {
      const dir = path.join(staging, String(gid));
      const empty = async () => !this._staged(gid).length && !this._stagedOwn(gid).length && (await fsp.readdir(dir).catch(() => null))?.length === 0;
      try {
        // Looked at twice: a page whose file was on its way in when it was first looked at has landed
        // by the second.
        if (!await empty()) continue;
        if (!await empty()) continue;
        lib._dirs.delete(dir);
        await fsp.rmdir(dir);
      } catch {}
    }
  }

  // Gallery `gid`'s descriptions as the index holds it (gallery-files.js; its pages in its folder or
  // archive, and those about to be: `placing`, page numbers): [{ name, data }] — and ComicInfo.xml,
  // for a CBZ, as its export has. They name the file each picture is in where it isn't the layout name
  // (a page whose layout name another page has: _nameFor), and a linked gallery's page the source
  // picture it shows (galleryFiles `fileOf`, `sourceOf`): each record's original is its `orig` here.
  _descriptions(gid, { comicInfo = false, placing = null } = {}) {
    const lib = this.library;
    const meta = lib._metaGet(gid);
    const records = lib._pageRows(gid).map(r => ({ ...lib._rowRecord(r), blob: parse(r.orig) }))
      .filter(r => ['p', 'x'].includes(r.blob.at) || placing?.has(r.pageNum));
    const cover = lib._coverGet(gid);
    const fileOf = (src) => src?.$own ?? (src?.at === 'p' ? src.entry : null);
    const sourceOf = (rec) => (rec.blob.at === 'x' ? { name: rec.blob.entry, size: rec.blob.size } : null);
    const out = layout.galleryFiles({ meta, records, covers: { gallery: cover?.cover, series: cover?.seriesCover } }, '', { fileOf, sourceOf })
      .filter(f => DESCRIPTIONS.includes(f.name)).map(f => ({ name: f.name, data: Buffer.from(f.source) }));
    if (comicInfo) {
      const owner = meta?.parentId ? lib._metaGet(meta.parentId) : null;
      out.push({ name: 'ComicInfo.xml', data: Buffer.from(layout.comicInfoXml(meta, { owner, pageCount: records.length })) });
    }
    return out;
  }

  // A folder's descriptions written; those the gallery no longer has, removed.
  async _describe(gid, dir, { onlyChanged = false } = {}) {
    const listed = this._descriptions(gid);
    for (const f of listed) {
      const file = path.join(dir, ...f.name.split('/'));
      if (onlyChanged && Buffer.from(f.data).equals(await fsp.readFile(file).catch(() => Buffer.alloc(0)))) continue;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await replaceFile(file, f.data);
      this.library.writes.add('descriptions', f.data.length);
    }
    for (const name of DESCRIPTIONS) if (!listed.some(f => f.name === name)) await fsp.rm(path.join(dir, ...name.split('/')), { force: true });
    // What the folder describes it with now, stamped: a check tells by it whether another app changed it.
    this.library._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(String(gid), descriptionStampOf(listed));
  }

  // An archive's descriptions brought up to date: those that changed added to it (zip.js appendZip —
  // nothing else in it is written again), the length it had kept first, so an addition the app
  // didn't finish is cut off again (resume). An archive not in the gallery format (added by hand)
  // is left as it is: resolves false (its descriptions are only the index's), else true.
  async _describeArchive(gid, row) {
    return this._exclusive(gid, () => this._describeArchiveNow(gid, row));
  }
  async _describeArchiveNow(gid, row) {
    const lib = this.library;
    const file = this._abs(row.path);
    const dir = await this._directory(file);
    if (!dir.has('metadata.json') && !dir.has('image_records.json')) return false;
    const listed = this._descriptions(gid, { comicInfo: row.format === 'cbz' });
    const changed = [];
    for (const f of listed) {
      const entry = dir.get(f.name);
      if (!entry || entry.size !== f.data.length || !(await readEntry(file, entry)).equals(f.data)) changed.push(f);
    }
    const drop = DESCRIPTIONS.filter(name => dir.has(name) && !listed.some(f => f.name === name));
    // What the archive describes it with now, stamped, as a folder's are (_describe).
    const stamp = () => lib._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(String(gid), descriptionStampOf(listed));
    if (!changed.length && !drop.length) { stamp(); return true; }
    lib._s('UPDATE files SET tail = ? WHERE gid = ?').run((await fsp.stat(file)).size, gid);
    lib.writes.addArchive(await appendZip(file, changed, { drop }));
    lib._s('UPDATE files SET tail = NULL WHERE gid = ?').run(gid);
    this._dirs.delete(file);
    stamp();
    return true;
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
          live.set(name, { size: orig.size, from: lib._staged(orig.file) });
        } else if (orig.at === 'p') live.set(orig.entry, { size: dir.get(orig.entry)?.size ?? orig.size });
      }
      const stagedOwn = this._stagedOwn(gid);
      const staged = new Map(stagedOwn.map(s => [s.rel, s]));
      for (const [rel, size] of ownFiles(lib._coverGet(gid), ownFiles(rows.map(r => parse(r.record))))) {
        const s = staged.get(rel);
        live.set(rel, s ? { size: s.size, from: lib._staged(s.file) } : { size: dir.get(rel)?.size ?? size ?? 0 });
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
        lib.asFolderWork(this.rootFor(gid), () => lib._tx(() => {
          for (const [n, { name, row: r }] of placing) {
            const now = lib._pageRow(gid, n);
            if (now?.orig !== r.orig) continue;   // replaced meanwhile: its new page waits for the next settle
            const orig = parse(r.orig);
            lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify({ at: 'p', entry: name, size: orig.size, type: orig.type }), gid, n);
            gone.push(lib._staged(orig.file));
          }
          for (const s of stagedOwn) {
            if (lib._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(gid, s.rel)?.file !== s.file) continue;
            lib._s('DELETE FROM staged_own WHERE gid = ? AND rel = ?').run(gid, s.rel);
            gone.push(lib._staged(s.file));
          }
          lib._s('UPDATE files SET tail = NULL WHERE gid = ?').run(gid);
          if (!this._touched.has(gid)) lib._s('UPDATE files SET unpack = 0, pending = 0, packed_at = ? WHERE gid = ?').run(Date.now(), gid);
          lib._logIn(gid);
        }));
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

  // ── Moving a gallery to another library folder ──
  // Gallery `gid` moved to library folder `root`: what waits in staging is settled into its folder
  // first; its folder (or archive) is copied there under a free name — a series member into its
  // series' folder there, when it has one — then its row is switched over in one synchronous step,
  // and the old copy deleted. If the gallery changed while it was being copied, the copy goes and it
  // is copied again. A gallery with no files yet only changes where it goes; a record with metadata
  // only belongs to no folder (nothing moves). A linked gallery becomes the library's own in its new
  // place, its source noted as removed in the folder it left (A11). Both folders must take the change
  // (folders.js: `root` shown, held and reachable; the one it leaves writable — `work` 'removal' for
  // a folder's removal moving its galleries out). Resolves whether it moved.
  async moveTo(gid, root, { work = null } = {}) {
    const lib = this.library;
    const id = String(gid);
    lib.folders.dir(root);
    const leaving = this.rootFor(id);
    if (leaving === root) return false;
    lib.folders.assertMoveTo(root);
    lib.folders.assertWritable(leaving, work);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.place(id, { work });
      await this._describing.get(id)?.catch(() => {});   // descriptions being written land first
      const row = this._row(id);
      if (!row) {
        if (!lib._s('SELECT 1 FROM places WHERE gid = ?').get(id)) return false;
        lib._tx(() => { lib._logIn(id); lib._s('UPDATE places SET root = ? WHERE gid = ?').run(root, id); });
        return true;
      }
      const from = this._abs(row.path);
      if (row.state === 'missing' || !fs.existsSync(from)) throw new BackendError('unavailable', `the files of gallery ${id} can't be found`);
      const ext = row.format === 'folder' ? '' : `.${row.format}`;
      const owner = this._ownerOf(id);
      const rel = row.source ? this._freePath(this._join(root, layout.galleryName(lib._metaGet(id) || { galleryId: id }))) : owner
        ? this._freePath(`${this._seriesFolder(owner, root) || this._freePath(this._join(root, layout.seriesName(owner)))}/${this._memberName(owner, id)}`, ext)
        : this._freePath(this._join(root, path.posix.basename(this._split(row.path).rest).replace(/\.(cbz|zip)$/i, '')), ext);
      const to = this._abs(rel), temp = `${to}.shiori-tmp`;
      const linkedPlaced = new Map();   // page → where a linked gallery's page from its source is now
      const signature = () => JSON.stringify([this._row(id), lib._pageRows(id).map(r => [r.n, r.orig, r.record]),
        lib._s('SELECT record FROM covers WHERE gid = ?').get(id)?.record ?? null, this._stagedOwn(id)]);
      const before = signature();
      this._reserved.add(rel);
      try {
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.rm(temp, { recursive: true, force: true });
        // Not what a write under way holds aside (its descriptions are written again in its new place).
        if (row.format === 'folder') await fsp.cp(from, temp, { recursive: true, errorOnExist: true, force: false, filter: (src) => !src.endsWith('.shiori-tmp') && !src.endsWith(linkedSource.SOURCE_FILE) });
        else await fsp.copyFile(from, temp, fs.constants.COPYFILE_EXCL);
        // A linked gallery's pages in its source: written into it as the gallery format puts them.
        if (row.source) {
          for (const r of lib._pageRows(id)) {
            const orig = parse(r.orig);
            if (orig.at !== 'x') continue;
            const name = layout.layoutPath.original(r.n, layout.originalExt(orig.type, r.key));
            await fsp.mkdir(path.join(temp, 'images'), { recursive: true });
            await fsp.writeFile(path.join(temp, ...name.split('/')), await this._readSource(row, orig.entry));
            linkedPlaced.set(r.n, { at: 'p', entry: name, size: orig.size, type: orig.type });
          }
        }
        lib.writes.add(row.format === 'folder' ? 'pages' : 'archive', await bytesIn(temp));
        if (signature() !== before) { await fsp.rm(temp, { recursive: true, force: true }); continue; }
        await fsp.rename(temp, to);
      } catch (e) {
        await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
        throw e;
      } finally {
        this._reserved.delete(rel);
      }
      // One synchronous step from here: switched over only when nothing changed while it was copied,
      // and only into a folder that can still take it (shown, held and reachable — not one hidden,
      // removed or taken over while the copy was made: F02) — its place with it (library.js
      // _placesIn); the copy deleted again should that be refused, the gallery left where it was. A
      // linked gallery's source is noted as removed where it was, by the same step (folders.js
      // removedIn).
      if (signature() !== before) { await fsp.rm(to, { recursive: true, force: true }).catch(() => {}); continue; }
      try {
        lib._tx(() => {
          lib.folders.assertMoveTo(root);
          lib._logIn(id);
          lib._s('UPDATE files SET path = ?, source = NULL WHERE gid = ?').run(rel, id);
          for (const [n, orig] of linkedPlaced) lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify(orig), id, n);
          if (row.source) lib.folders.removedIn(leaving, id, row.path, this.sourceOf(row));
          this._pend(id);
          this._pendOwner(id);
        });
      } catch (e) {
        await fsp.rm(to, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      this._forget(row.path);
      await this._removeLeft(row.path, id, !!row.source, work).catch(() => {});
      this.scheduleDescribe(id, 0);
      return true;
    }
    throw new BackendError('conflict', `gallery ${id} kept changing while it was being moved`);
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
  _choosePath(gid, given, root = this.rootFor(gid)) {
    const lib = this.library;
    const owner = this._ownerOf(gid) || (given?.parentId ? lib._metaGet(given.parentId) : null);
    if (!owner) return this._freePath(this._join(root, layout.galleryName(lib._metaGet(gid) || given || { galleryId: gid })));
    const folder = this._seriesFolder(owner, root) || this._freePath(this._join(root, layout.seriesName(owner)));
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
    return row?.format === 'folder' && !row.source && row.state === 'packed' && !row.pending && !row.unpack
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
    if (!this._idle(id, row) || !lib.folders.writable(this.rootFor(id))) return false;
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
      if (!lib.folders.writable(this._split(rel).root)) continue;
      const file = this._abs(rel);
      if (!held(rel) && fs.existsSync(file) && !this._reading.get(file)) await this._delete(file);
      if (held(rel) || !fs.existsSync(file)) lib._s('DELETE FROM retired WHERE path = ?').run(rel);
    }
  }
}

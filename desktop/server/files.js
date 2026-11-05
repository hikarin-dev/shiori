// files.js — where each gallery lives in the library folder: a folder in the Shiori gallery format
// (gallery-files.js — the same layout as its export, unzipped): images/0001.webp… for its original
// pages, translated/, study/, pipeline/ and covers/ for what was made from them (written there by
// library.js), and its descriptions (metadata.json, image_records.json, study/bubbles.json,
// covers/manifest.json). A series keeps its members' folders in a folder of its own, with
// series.json. Pages are staged as they arrive (.shiori/staging/<gid>/ in the library folder); once
// they stop changing for a moment (placeDelay) the gallery is settled: its staged pages are moved
// (renamed, never copied) into images/. The gallery's other pages are never written again.
//
// The index (library.db) is where everything about a gallery lives, updated as it happens: a change
// is committed there. Its folder catches up by publications (describe): a publication commits a new
// generation of the gallery there, at once after a change made by hand (its metadata, tags, cover,
// series), when a job writing its pages ends or the reader leaves the gallery, and otherwise a moment
// after its last change (describeDelay) — every PUBLISH_EVERY pages during a download — and whatever
// is left when the app closes (D12). A gallery kept in an archive publishes only at those lifecycle
// points, never on the timer. A gallery's folder in staging goes once nothing is staged in it.
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
// it reads again. Every file call goes through the folder store adapter (folder-store.js `disk`).
//
// A folder is in format v2 (the app's js/storage/gallery-manifest.js): its saved state one generation,
// committed by one atomic write of its manifest (.shiori/gallery.json), which names every picture's
// file. A picture is written once, under a name no file has (folder-store.js writeNewIn) — a page
// moved in from staging likewise — never renamed into place over another, and never written again to
// save a description. The files a change lets go (a page replaced or removed, a translation made
// again) are deleted only once a publication no longer naming them has committed, and only while they
// are still as written (`retiring`, principle 4). An archive holds its manifest too, appended with the
// descriptions it names.

import { disk, physicallyIn, writeFlushed, replaceFile, writeNewIn, deleteNamedIn } from './folder-store.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { readDirectory, readEntry, writeZip, appendZip } from './zip.js';
import { files as layout, galleryExport, linked as linkedSource, content, titles, manifest as format, BackendError } from './shared.js';

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
CREATE TABLE IF NOT EXISTS staged_own (
  gid TEXT NOT NULL,
  rel TEXT NOT NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (gid, rel)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS retiring (
  dir TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER,
  mtime REAL,
  gid TEXT,
  PRIMARY KEY (dir, name)
);
`;
// `files`: one row per gallery with a place in the library folder; `state` 'packed' when it is
// there, 'missing' when it was found gone; `pending` when its folder lacks changes the index has (its
// next publication: describe); `unpack` when pictures were removed from its archive (its next settle
// adds to or rewrites it); `used_at` when it was last changed or opened in the reader (kept to the
// hour); `tail` the length its archive had while descriptions are being added to it (cut back to it
// should the app stop half way). `staged_own`: a picture of its own (`rel`) waiting in staging
// (`file`) to be added to its gallery's archive — or moved into its folder, written while that
// couldn't be (folders.js writable). `retiring`: a file to delete, as Shiori recorded writing it (its
// `size` and modification time, `mtime`: either null when it wasn't recorded) — `name` in gallery
// folder `dir` (a path as `files` has them), or `dir` itself, an archive, when `name` is '' — once gallery
// `gid` has published a generation that no longer names it (its rowid tells which publications began
// after it was recorded); `gid` null once nothing waits for that. Recorded by the transaction that let
// the file go (a page replaced or removed, a picture made again, an archived gallery's old folder),
// so the intent survives a restart. `source`: for a
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
const PUBLISH_EVERY = 20;      // pages stored before a gallery being downloaded is published (D12)
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
  for (const e of await disk.readdir(path.join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true })) {
    const name = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await filesIn(dir, name)); else out.push(name);
  }
  return out;
}

// The bytes of a file, or of every file in a folder.
async function bytesIn(abs) {
  const stat = await disk.stat(abs);
  if (!stat.isDirectory()) return stat.size;
  let n = 0;
  for (const rel of await filesIn(abs)) n += (await disk.stat(path.join(abs, ...rel.split('/')))).size;
  return n;
}

// A read of a gallery's files that finds nothing there resolves `value`; any other failure (the disk, or
// its permissions, wouldn't) is thrown: a file that can't be read is never taken for one that isn't
// there, so nothing is concluded from it (F06). `disk.readFile(…).catch(ifMissing(null))`.
export const ifMissing = (value) => (e) => {
  if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return value;
  throw e;
};

// What a folder of a library folder is (folder-content.js classifyFolder), from the descriptions it
// holds (`items`: its entries). Rejects when one can't be read.
export async function classifyAt(dir, items) {
  const texts = {};
  for (const name of content.OWN_FILES) {
    const [top] = name.split('/');
    if (items.some(i => i.name === top && (top === name ? i.isFile() : i.isDirectory()))) texts[name] = await disk.readFile(path.join(dir, ...name.split('/')), 'utf8').catch(ifMissing(null));
  }
  return content.classifyFolder(texts);
}
// Whether folder `dir` is gallery `gid`'s own by what it holds — the overlay naming it (source.json),
// for a linked gallery; else its description (folder-content.js) — so that a folder the index took for
// a gallery's on another rule is never tidied (R01) nor deleted with it (F01). One that can't be read
// isn't known to be.
export async function ownedBy(dir, gid, linked) {
  try {
    if (linked) return linkedSource.parseSource(await disk.readFile(path.join(dir, linkedSource.SOURCE_FILE), 'utf8'))?.galleryId === gid;
    const what = await classifyAt(dir, await disk.readdir(dir, { withFileTypes: true }));
    return what.kind === 'gallery' && what.id === gid;
  } catch { return false; }
}

// The library folder's own id, kept in its .shiori/library.json and made the first time: this
// computer's data for the library (its index and thumbnails) is found by it, so the folder keeps
// them whatever drive letter or path it is reached by. A file that can't be read is an error, never
// a reason to start over under a new id.
export function libraryId(libraryDir) {
  const file = path.join(libraryDir, '.shiori', 'library.json');
  let text = null;
  try { text = disk.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (text != null) {
    const id = JSON.parse(text)?.id;
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new Error(`${file} names no library id`);
    return id;
  }
  const id = crypto.randomBytes(8).toString('hex');
  disk.mkdirSync(path.dirname(file), { recursive: true });
  disk.writeFileSync(file, JSON.stringify({ format: 'shiori-library', version: 1, id }, null, 2));
  return id;
}
// The id folder `dir`'s .shiori/library.json names now — null when it names none (no folder there, no
// such file, one that can't be read or names no id): which library folder a path holds at this moment.
// Read only, never written: a folder's id is made once, when it first joins a library (libraryId).
export function libraryIdAt(dir) {
  try {
    const id = JSON.parse(disk.readFileSync(path.join(dir, '.shiori', 'library.json'), 'utf8'))?.id;
    return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) ? id : null;
  } catch { return null; }
}

// Whether `file` is there, flushed to the disk first, so a page moved into its folder is never an
// empty file after a power cut.
async function flushed(file) {
  let handle;
  try { handle = await disk.open(file, 'r+'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  try { await handle.sync(); } finally { await handle.close(); }
  return true;
}

// A file moved to `to` where nothing is, synchronously — never over a file (principle 3: the caller
// chose a name no file has, and a file put there since is left as it is: EEXIST) — across drives (a
// junction inside the library folder), copied and the original deleted. Returns whether it was copied
// (written again).
function moveSync(from, to) {
  if (disk.existsSync(to)) throw Object.assign(new Error(`${to} is taken`), { code: 'EEXIST' });
  try { disk.renameSync(from, to); return false; } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    disk.copyFileSync(from, to, disk.constants.COPYFILE_EXCL);
    disk.rmSync(from, { force: true });
    return true;
  }
}

export class FileLibrary {
  // `library` is the Library whose pages these are. `placeDelay`: how long a gallery's pages must
  // stay unchanged before they are moved into its folder; `describeDelay`: how long a gallery must
  // be left alone before its changes are published in its folder (D12: about 5 s, and at once every
  // PUBLISH_EVERY changes, when a job ends, the reader leaves it, the app closes, or before a removal
  // forgets its folder — an archived gallery only at those, so publications don't fill its archive
  // with dead space); `archiveAfter`: how long before it is archived (0: never), in `archiveFormat`
  // ('zip' or 'cbz').
  constructor(library, { placeDelay = 5000, describeDelay = 5000, archiveAfter = 0, archiveFormat = 'zip' } = {}) {
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
    this._changes = new Map();         // gid → changes since its last publication (D12)
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

  // What an earlier build's tables still hold, carried over to format v2 (D13) — each row once its
  // library folder may be written to (else it waits for the next start, or the folder shown or taken
  // back), each table dropped once empty:
  // - `leftovers` (files of pages a gallery no longer has) and `retired` (a folder or archive no gallery
  //   has: an archived gallery's old folder) become `retiring` rows, each file as it is now — the index
  //   kept only its name. A retired folder is taken only while its description still says it is a
  //   gallery's: one put at its path since is no one's to delete (T03);
  // - `unplaced` (a picture of its own written beside its place, to be renamed into it once committed:
  //   F03, T06) is settled as format v2 has it: the picture keeps the name it was written under, made a
  //   layout name's (translated/0001-<hex>.png, gallery-files.js layoutOf), its records point at it, and
  //   the file at its old place retires. One whose file is gone leaves its records as they are, and is
  //   reported.
  async _carryOver() {
    const lib = this.library;
    const has = (table) => !!lib._s(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table);
    const writable = (rel) => lib.folders.writable(this._split(rel).root);
    const statOf = (abs) => { const st = disk.statSync(abs, { throwIfNoEntry: false }); return st?.isFile() ? st : null; };
    if (has('leftovers')) {
      for (const { gid, entry } of lib._s('SELECT gid, entry FROM leftovers').all()) {
        const row = this._row(gid);
        if (row && !writable(row.path)) continue;
        const st = row?.format === 'folder' && statOf(path.join(this._abs(row.path), ...entry.split('/')));
        lib._tx(() => {
          if (st) { this._retireIn(row.path, entry, { size: st.size, mtime: st.mtimeMs }, gid); this._pend(gid); }
          lib._s('DELETE FROM leftovers WHERE gid = ? AND entry = ?').run(gid, entry);
        });
      }
    }
    if (has('retired')) {
      for (const { path: rel } of lib._s('SELECT path FROM retired').all()) {
        if (!writable(rel)) continue;
        const abs = this._abs(rel);
        const st = disk.statSync(abs, { throwIfNoEntry: false });
        const named = [];
        if (st?.isFile()) named.push({ name: '', size: st.size, mtime: st.mtimeMs });
        else if (st?.isDirectory() && (await classifyAt(abs, await disk.readdir(abs, { withFileTypes: true })).catch(() => null))?.kind === 'gallery') {
          for (const name of await filesIn(abs)) { const f = statOf(path.join(abs, ...name.split('/'))); if (f) named.push({ name, size: f.size, mtime: f.mtimeMs }); }
        }
        lib._tx(() => {
          for (const f of named) this._retireIn(rel, f.name, f, null);
          lib._s('DELETE FROM retired WHERE path = ?').run(rel);
        });
      }
    }
    if (has('unplaced')) {
      for (const { gid, rel, temp } of lib._s('SELECT gid, rel, temp FROM unplaced').all()) {
        const row = this._row(gid);
        if (row && !writable(row.path)) continue;
        const dir = row?.format === 'folder' ? this._abs(row.path) : null;
        const from = dir && path.join(dir, ...temp.split('/'));
        const st = from && statOf(from);
        if (st) {
          const hex = /\.([0-9a-f]{8,10})\.shiori-new$/.exec(temp)?.[1] || crypto.randomBytes(5).toString('hex');
          let name = rel.replace(/(\.[^./]*)$/, `-${hex}$1`);
          while (disk.existsSync(path.join(dir, ...name.split('/')))) name = rel.replace(/(\.[^./]*)$/, `-${crypto.randomBytes(5).toString('hex')}$1`);
          moveSync(from, path.join(dir, ...name.split('/')));
          const old = statOf(path.join(dir, ...rel.split('/')));
          lib._tx(() => {
            this._retarget(gid, rel, { $own: name, size: st.size, mtime: st.mtimeMs });
            if (old) this._retireIn(row.path, rel, { size: old.size, mtime: old.mtimeMs }, gid);
            this._pend(gid);
          });
        } else if (row) console.warn(`[shiori] the picture written for ${rel} of gallery ${gid} is gone: it keeps the one its folder has`);
        lib._s('DELETE FROM unplaced WHERE gid = ? AND rel = ?').run(gid, rel);
      }
    }
    for (const table of ['leftovers', 'retired', 'unplaced']) {
      if (has(table) && !lib._s(`SELECT 1 FROM ${table} LIMIT 1`).get()) lib._db.exec(`DROP TABLE ${table}`);
    }
  }

  // Inside the caller's transaction: file `name` of gallery folder `dir` (a path as `files` has them;
  // '' for `dir` itself, an archive) to delete as `recorded` ({ size, mtime }: as Shiori wrote it) —
  // once gallery `gid` has published a generation that no longer names it, or (`gid` null) at the
  // next retirement (_retire).
  _retireIn(dir, name, recorded, gid) {
    this.library._s('INSERT OR REPLACE INTO retiring (dir, name, size, mtime, gid) VALUES (?, ?, ?, ?, ?)')
      .run(dir, name, recorded?.size ?? null, recorded?.mtime ?? null, gid == null ? null : String(gid));
  }

  // Inside the caller's transaction: every reference gallery `gid`'s records hold to its own file
  // `from` pointed at `to` instead ({ $own, size, mtime }: the file it is now) — a picture that took
  // another name than the one it was staged or written for.
  _retarget(gid, from, to) {
    const lib = this.library;
    const swap = (v) => {
      if (v == null || typeof v !== 'object') return v;
      if (v.$own === from) return { ...v, ...to };
      if (Array.isArray(v)) return v.map(swap);
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    };
    for (const r of lib._pageRows(gid)) {
      const next = JSON.stringify(swap(parse(r.record)));
      if (next !== r.record) lib._s('UPDATE pages SET record = ? WHERE gid = ? AND n = ?').run(next, r.gid, r.n);
    }
    const cover = lib._coverGet(gid);
    if (cover && JSON.stringify(cover).includes(JSON.stringify(from))) lib._coverPut(swap(cover));
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
      try { if (disk.statSync(this._abs(r.path)).size > r.tail) disk.truncateSync(this._abs(r.path), r.tail); } catch {}
      lib._s('UPDATE files SET tail = NULL, pending = 1 WHERE gid = ?').run(r.gid);
    }
    const ids = new Set();
    for (const r of lib._s(`SELECT DISTINCT gid FROM pages WHERE json_extract(orig, '$.at') = 's'`).all()) ids.add(r.gid);
    for (const r of lib._s('SELECT gid FROM files WHERE unpack = 1').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT DISTINCT gid FROM staged_own').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT gid FROM files WHERE pending = 1').all()) this.scheduleDescribe(r.gid);
    for (const id of ids) this.schedule(id);
    this._carryOver().catch((e) => console.warn('[shiori] carrying the index over to format v2 failed:', String(e?.message || e)))
      .then(async () => {
        // Files a publication let go before the app stopped, or that couldn't be deleted then.
        for (const { gid } of lib._s('SELECT DISTINCT r.gid FROM retiring r JOIN files f ON f.gid = r.gid WHERE f.pending = 0').all()) await this._letGo(gid).catch(() => {});
        await this._retire();
      }).catch(() => {});
    for (const dir of lib.stagingDirs()) {
      disk.readdir(dir).then(async (names) => {
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
      if (!await this._writesIn(row)) throw Object.assign(new BackendError('invalid', `the overlay of gallery ${id} leads out of its library folder`), { reason: 'outside' });
      if (disk.existsSync(dir)) return dir;
      await this._seen(row, false);
      throw new BackendError('aborted', `the folder of gallery ${id} is missing`);
    }
    throw new BackendError('aborted', `gallery ${id} couldn't be unpacked into a folder`);
  }

  // Whether gallery `row`'s folder may be written to as it is on disk: a linked gallery's overlay only
  // while it is physically inside its library folder (physicallyIn, F09) — otherwise nothing is written
  // there, and what waits for it stays staged.
  async _writesIn(row) {
    if (!row?.source) return true;
    return physicallyIn(this.library.rootDir(this._split(row.path).root), this._abs(row.path)).then(() => true, () => false);
  }

  // Gallery `gid`'s folder chosen in the library folder it is placed in, made, and recorded — in one
  // synchronous step, so two claims can't pick different places — when that library folder may be
  // written to (`work` as folders.js writable). A folder that can't be made leaves the gallery as it
  // was: placed where it was, with no folder yet. The folder is bound to the gallery from its first
  // moment: its metadata.json (as much of it as is known) is written there at once, as the website's
  // reserveDir does — nothing is deleted for a gallery from a folder no description of it names
  // (_owns), and its full descriptions follow in due course. `root`: the library folder, when it is
  // given (a reservation through the folder store: folder-store.js). Returns its row.
  _claim(gid, meta, work = null, root = this.rootFor(gid)) {
    this.library.folders.assertWritable(root, work);
    const rel = this._choosePath(gid, meta, root);
    const abs = this._abs(rel);
    disk.mkdirSync(abs, { recursive: true });
    const named = titles.migrateTitle({ ...(meta || this.library._metaGet(gid) || {}), galleryId: String(gid) });
    disk.writeFileSync(path.join(abs, 'metadata.json'), JSON.stringify(named, null, 2));
    this.library._s(`INSERT INTO files (gid, path, format, state, packed_at, pending, used_at) VALUES (?, ?, 'folder', 'packed', ?, 1, ?)`)
      .run(gid, rel, Date.now(), Date.now());
    this._pendOwner(gid);
    return this._row(gid);
  }

  // ── Hooks the library calls ──
  // A page stored: settled once its pages stop changing for a moment — at once every PUBLISH_EVERY
  // pages, so a download in progress is published as it goes (D12). An archived gallery's wait in
  // staging for its lifecycle points (settle, flush): each addition to it is a new directory.
  pageStored(gid) {
    const n = this._changed(gid);
    if (!this._archived(gid)) this.schedule(gid, n % PUBLISH_EVERY === 0 ? 0 : this.placeDelay);
  }
  // Gallery `gid` changed once more since its last publication: how many times, now.
  _changed(gid) { const n = (this._changes.get(String(gid)) || 0) + 1; this._changes.set(String(gid), n); return n; }

  // Inside the library's transaction dropping a page whose original was `orig` (in the gallery's
  // folder or archive): a file in the folder retires (deleted once a publication no longer names it:
  // _retireIn); an archive loses it at its next settle (a new directory without it, or rewritten whole).
  pageRemoved(gid, orig) {
    const row = this._row(gid);
    if (!row) return;
    if (orig?.at === 'x') { this._pend(row.gid); this._later(() => this.scheduleDescribe(row.gid)); return; }   // its source keeps it
    if (row.format !== 'folder') this._toUnpack(row.gid);
    else if (orig?.entry) this._retireIn(row.path, String(orig.entry), orig, row.gid);
    this._pend(row.gid);
    this._later(() => this.schedule(row.gid));
  }

  // Inside the library's transaction dropping a file of the gallery's own (`rel`: its name in the
  // gallery's folder; `recorded` { size, mtime } as its reference had it): one staged for it goes once
  // that commits; one in its folder retires (deleted once a publication no longer names it); its archive
  // loses it at its next settle.
  ownDropped(gid, rel, recorded = null) {
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
    } else if (!staged) {
      this._retireIn(row.path, rel, recorded, id);
      this._pend(id);
    }
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

  // A name for a picture of gallery `gid`'s own at `rel` (translated/0001.png…) to be staged under: `rel`
  // itself unless one of its records, a file retiring, or one staged already has it (its folder can't
  // be checked now: the move into it chooses again should a file be there by then, _moveOwnIn); an
  // archive's entries are replaced by name, so there it is always `rel`.
  stagedName(gid, rel) {
    const lib = this.library, id = String(gid);
    const row = this._row(id);
    if (!row || row.format !== 'folder') return rel;
    const taken = (name) => lib._s('SELECT 1 FROM retiring WHERE dir = ? AND name = ?').get(row.path, name)
      || lib._s('SELECT 1 FROM staged_own WHERE gid = ? AND rel = ?').get(id, name)
      || lib._pageRows(id).some(r => r.record.includes(JSON.stringify(name))) || JSON.stringify(lib._coverGet(id) ?? null).includes(JSON.stringify(name));
    let name = rel;
    while (taken(name)) name = rel.replace(/(\.[^./]*)$/, `-${crypto.randomBytes(5).toString('hex')}$1`);
    return name;
  }

  // Inside the library's transaction recording a picture stageOwn staged: it takes the place of one
  // staged for the same file before (whose staging file goes), and the gallery settles in due course.
  ownStaged(gid, rel, file, size) {
    const lib = this.library;
    const old = lib._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(String(gid), rel);
    if (old && old.file !== file) lib._dropStaged(old.file);
    lib._s('INSERT OR REPLACE INTO staged_own (gid, rel, file, size) VALUES (?, ?, ?, ?)').run(String(gid), rel, file, size);
    this._pend(gid);
    if (!this._archived(gid)) this._later(() => this.schedule(gid));
  }

  _stagedOwn(gid) { return this.library._s('SELECT rel, file, size FROM staged_own WHERE gid = ?').all(String(gid)); }
  // Gallery `gid`'s files waiting to retire: [{ dir, name, size, mtime, seq }].
  _retiring(gid) { return this.library._s('SELECT rowid AS seq, dir, name, size, mtime FROM retiring WHERE gid = ?').all(String(gid)); }

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
    for (const s of this._stagedOwn(gid)) lib._dropStaged(s.file);
    lib._s('DELETE FROM staged_own WHERE gid = ?').run(String(gid));
    lib._s('DELETE FROM retiring WHERE gid = ?').run(String(gid));   // they go with its folder, or stay with it
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
    const stat = await disk.stat(abs).catch(() => null);
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
    for (const table of ['files', 'staged_own', 'retiring']) this.library._s(`DELETE FROM ${table}`).run();
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
    return !disk.existsSync(file);
  }

  // A series' folder left with nothing but its series.json (its members moved out or deleted):
  // deleted too. The library folder itself never is.
  async _tidy(dir) {
    if (this.library.folders.paths().some(root => path.resolve(dir) === path.resolve(root))) return;
    const left = await disk.readdir(dir).catch(() => null);
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

  // A file of the gallery's own (`rel`: its name in the gallery's folder, translated/0001.png…), from
  // staging while it waits there, else from its folder or archive; null when it can't be read.
  async readOwn(gid, rel) {
    const staged = this.library._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(String(gid), rel);
    const row = this._row(gid);
    const placed = () => (row ? this._read(row, rel).catch(() => null) : null);
    return staged ? disk.readFile(this.library._staged(staged.file)).catch(placed) : placed();
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
      if (src?.kind === 'dir') return disk.access(path.join(this._sourceAbs(row), orig.entry)).then(() => true, () => false);
      return !!(await this._directory(this._sourceAbs(row)).catch(() => null))?.has(orig.entry);
    }
    if (!row || orig?.at !== 'p') return false;
    if (row.format === 'folder') return disk.access(path.join(this._abs(row.path), orig.entry)).then(() => true, () => false);
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
  // The file linked gallery `row`'s source is (`entry`: a picture of a folder of pictures), as long as
  // it is physically inside its library folder (physicallyIn: F09).
  _sourceIn(row, entry = null) {
    const abs = this._sourceAbs(row);
    return physicallyIn(this.library.rootDir(this._split(row.path).root), entry == null ? abs : path.join(abs, entry));
  }
  // A page of a linked gallery's source (its name in the folder, or in the archive), as bytes.
  async _readSource(row, entry) {
    const src = this.sourceOf(row);
    if (!src) return null;
    if (src.kind === 'dir') return disk.readFile(await this._sourceIn(row, entry));
    const abs = await this._sourceIn(row);
    const found = (await this._directory(abs)).get(entry);
    return found ? readEntry(abs, found) : null;
  }
  // The file a linked gallery's page is, when it is one on its own (a folder of pictures), for a
  // read that needn't load it; null for one that leads out of its folder (its read is refused).
  async sourceFile(gid, orig) {
    const row = this._row(gid);
    return this.sourceOf(row)?.kind === 'dir' && orig?.at === 'x' ? this._sourceIn(row, orig.entry).catch(() => null) : null;
  }

  async _read(row, entry) {
    const file = this._abs(row.path);
    this._reading.set(file, (this._reading.get(file) || 0) + 1);
    try {
      if (row.format === 'folder') return await disk.readFile(path.join(file, entry));
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
    if (!readable && await disk.access(row.source ? this._sourceAbs(row) : this._abs(row.path)).then(() => true, () => false)) return;
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
    const stat = await disk.stat(file);
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

  // Settle everything waiting, and publish every gallery with changes its folder lacks (the app is
  // closing): an archived gallery's staged pictures too, which wait for this.
  async flush() {
    const lib = this.library;
    const waiting = [...lib._s(`SELECT DISTINCT gid FROM pages WHERE json_extract(orig, '$.at') = 's'`).all(), ...lib._s('SELECT DISTINCT gid FROM staged_own').all()].map(r => r.gid);
    const ids = [...new Set([...this._timers.keys(), ...this._regroupRetries.keys(), ...waiting])];
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
  // which waits for a settle under way rather than joining it; by default 'publish', what was
  // committed before its folder was hidden carrying on there). Failures are tried again later.
  async place(gid, { work = null } = {}) {
    const id = String(gid);
    while (work && this._placing.has(id)) await this._placing.get(id);
    if (this._placing.has(id)) { this._again.add(id); return this._placing.get(id); }
    const run = this._place(id, work ?? 'publish').then((done) => {
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
      const there = await disk.access(this._abs(row.path)).then(() => true, () => false);
      await this._seen(row, there);
      if (!there) return true;
      row = this._row(gid);
      if (!row) return true;   // deleted meanwhile
      if (!await this._writesIn(row)) return true;
      if (row.format !== 'folder' && (row.unpack || this._staged(gid).length || this._stagedOwn(gid).length)) {
        const how = await this._inFormat(row) ? await this._settleArchive(gid, row) : 'unpack';
        if (how === 'unpack' && !await this._unpack(gid, row)) return false;
        row = this._row(gid);
        if (!row) return true;
      }
      if (this._regroupWanted.delete(gid)) await this._regroup(gid);
      row = this._row(gid);
      if (!row) return true;
      if (row.format !== 'folder' || (!this._staged(gid).length && !this._stagedOwn(gid).length)) {
        if (row.pending) this.scheduleDescribe(gid);
        return true;
      }
    } else {
      if (!this._staged(gid).length && !this._stagedOwn(gid).length) return true;
      row = this._claim(gid, null, work);   // its folder, kept from now on, recorded before any file moves there
    }
    const dir = this._abs(row.path);
    await disk.mkdir(path.join(dir, 'images'), { recursive: true });
    for (const r of this._staged(gid)) await this._moveIn(gid, dir, r);
    await this._moveOwnIn(gid, dir);

    if (!this._row(gid)) return true;   // deleted meanwhile
    this._pend(gid);   // its pages changed: its descriptions follow, in due course
    this.scheduleDescribe(gid);
    return true;
  }

  // Whether gallery `gid` is kept in a folder of the desktop's oldest format: its pages' pictures at the
  // folder's top, beside a shiori.json.
  _legacy(gid) {
    return this._row(gid)?.format === 'folder' && !!this.library._s(`SELECT 1 FROM pages WHERE gid = ? AND json_extract(orig, '$.at') = 'p'
      AND instr(json_extract(orig, '$.entry'), '/') = 0 LIMIT 1`).get(String(gid));
  }
  // Gallery `gid`, kept in a folder of the desktop's oldest format, brought to the gallery format (D18),
  // so the website reads it too: each page's picture renamed into images/ (_nameFor; no picture written
  // again) and its row pointed at it, then the gallery published there. Its shiori.json is left as it
  // is: the manifest names the gallery now. Only while its library folder may be written to.
  async toFormat(gid) {
    const lib = this.library, id = String(gid);
    const row = this._row(id);
    if (!this._legacy(id) || !lib.folders.writable(this.rootFor(id))) return false;
    const dir = this._abs(row.path);
    await disk.mkdir(path.join(dir, 'images'), { recursive: true });
    for (const r of lib._pageRows(id)) {
      const orig = parse(r.orig);
      if (orig.at !== 'p' || orig.entry.includes('/')) continue;
      const name = this._nameFor(id, r, orig, dir);
      const to = path.join(dir, ...name.split('/'));
      moveSync(path.join(dir, orig.entry), to);
      const st = disk.statSync(to);
      lib._tx(() => {
        lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify({ ...orig, entry: name, size: st.size, mtime: st.mtimeMs }), id, r.n);
        this._pend(id);
      });
    }
    return (await this.describe(id)).ok;
  }

  // Staged page `r` moved into the gallery's folder `dir`: flushed, then — in one synchronous step,
  // so no other operation sees the file in one place and its row naming the other — renamed into
  // images/ under a name no file has (_nameFor) and its row pointed at it, with the size and
  // modification time it has there. A page replaced or removed meanwhile is left alone (its staged
  // file goes with its row). One already renamed before an interruption only has its row brought up to
  // date.
  async _moveIn(gid, dir, r) {
    const lib = this.library;
    const orig = parse(r.orig);
    const from = lib._staged(orig.file);
    const there = await flushed(from);
    const now = lib._pageRow(gid, r.n);
    if (!now || now.orig !== r.orig) return;
    const name = this._nameFor(gid, r, orig, dir, there);
    const to = path.join(dir, ...name.split('/'));
    if (there && moveSync(from, to)) lib.writes.add('pages', orig.size);
    const st = disk.statSync(to, { throwIfNoEntry: false });
    if (!there && st?.size !== orig.size) {
      console.warn(`[shiori] page ${r.n} of gallery ${gid} is gone from staging`);
      return;
    }
    lib._tx(() => {
      lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify({ at: 'p', entry: name, size: orig.size, type: orig.type, mtime: st?.mtimeMs }), gid, r.n);
    });
  }

  // Pictures of its own staged while the gallery was kept in an archive (unpacked since), or while its
  // folder couldn't be written to: renamed into its folder — under the name they were staged for, or,
  // when a file is there by now, another its records are pointed at (_retarget) — never over a file;
  // one staged again meanwhile waits for the next settle.
  async _moveOwnIn(gid, dir) {
    const lib = this.library;
    for (const s of this._stagedOwn(gid)) {
      const from = lib._staged(s.file);
      const there = await flushed(from);
      if (lib._s('SELECT file FROM staged_own WHERE gid = ? AND rel = ?').get(gid, s.rel)?.file !== s.file) continue;
      let name = s.rel;
      while (disk.existsSync(path.join(dir, ...name.split('/')))) name = s.rel.replace(/(\.[^./]*)$/, `-${crypto.randomBytes(5).toString('hex')}$1`);
      const to = path.join(dir, ...name.split('/'));
      disk.mkdirSync(path.dirname(to), { recursive: true });
      if (there && moveSync(from, to)) lib.writes.add('pictures', s.size);
      const st = disk.statSync(to, { throwIfNoEntry: false });
      lib._tx(() => {
        if (st) this._retarget(gid, s.rel, { $own: name, size: st.size, mtime: st.mtimeMs });
        lib._s('DELETE FROM staged_own WHERE gid = ? AND rel = ?').run(gid, s.rel);
      });
    }
  }

  // Where page `r` goes in its folder `dir`: images/0012.webp for page 12 (gallery-files.js) — or, when
  // a file is there already (the page it replaces, still to retire; a folder named by hand) or another
  // page of the gallery has that name, the number and the staged file's random part, so a retried move
  // picks the same name. `fresh`: the staged file is still there to move (else the move happened before
  // an interruption, and the name it would have taken is the one it has).
  _nameFor(gid, r, orig, dir, fresh = true) {
    const ext = layout.originalExt(orig.type, r.key);
    const name = layout.layoutPath.original(r.n, ext);
    const taken = (n) => !!this.library._s(`SELECT 1 FROM pages WHERE gid = ? AND n != ? AND json_extract(orig, '$.at') = 'p'
      AND json_extract(orig, '$.entry') = ?`).get(gid, r.n, n) || (fresh && dir != null && disk.existsSync(path.join(dir, ...n.split('/'))));
    const suffixed = name.replace(/\.(\w+)$/, `-${String(orig.file).match(/-([0-9a-f]+)\.\w+$/)?.[1] || 'x'}.$1`);
    if (!fresh) return dir != null && disk.existsSync(path.join(dir, ...suffixed.split('/'))) ? suffixed : name;
    if (!taken(name)) return name;
    let out = suffixed;
    while (taken(out)) out = name.replace(/\.(\w+)$/, `-${crypto.randomBytes(5).toString('hex')}.$1`);
    return out;
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
    const made = disk.mkdirSync(path.dirname(to), { recursive: true });
    try { disk.renameSync(from, to); } catch (e) {
      // Windows won't move a folder while something shows or uses a folder inside it (an Explorer
      // window): it stays where it is until then, tried again a little later — and a series' folder
      // made for it goes again at once, so no other member takes it for one already there.
      if (made) try { disk.rmdirSync(made); } catch {}
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      this._regroupWanted.add(gid);
      this._retryRegroup(gid);
      return;
    }
    lib._tx(() => {
      lib._s('UPDATE files SET path = ? WHERE gid = ?').run(rel, gid);
      lib._s('UPDATE retiring SET dir = ? WHERE dir = ?').run(rel, row.path);
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
      await disk.rm(temp, { recursive: true, force: true });
      await disk.mkdir(path.join(temp, 'images'), { recursive: true });
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
        await disk.mkdir(path.dirname(path.join(temp, ...rel.split('/'))), { recursive: true });
        await writeFlushed(path.join(temp, ...rel.split('/')), data);
        lib.writes.add('pictures', data.length);
      }
      // One synchronous step from here.
      if (JSON.stringify(archived().map(r => [r.n, r.orig])) !== signature || this._row(gid)?.path !== row.path) {
        await disk.rm(temp, { recursive: true, force: true });
        return false;
      }
      disk.renameSync(temp, target);
      // Recorded as it now is on disk, whether or not the gallery is still in the library.
      lib.asFolderWork(this.rootFor(gid), () => lib._tx(() => {
        for (const p of out) lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify(p.orig), gid, p.n);
        lib._s(`UPDATE files SET path = ?, format = 'folder', pending = 1, unpack = 0, used_at = ? WHERE gid = ?`).run(rel, Date.now(), gid);
        lib._logIn(gid);
      }));
      lib.publishFeed(gid);
      this._forget(row.path);
      this._discard(this._abs(row.path));
      return true;
    } catch (e) {
      await disk.rm(temp, { recursive: true, force: true }).catch(() => {});
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

  // In due course, when nothing settles the gallery sooner: once it has been left alone a while — at
  // once after PUBLISH_EVERY changes since its last publication (D12). An archived gallery waits for its
  // lifecycle points (settle, flush), so a later `delay` changes nothing for it.
  scheduleDescribe(gid, delay = this.describeDelay) {
    const id = String(gid);
    if ((this._changes.get(id) || 0) >= PUBLISH_EVERY) delay = 0;
    if (delay > 0 && this._archived(id)) return;
    clearTimeout(this._describeTimers.get(id));
    const t = setTimeout(() => { this._describeTimers.delete(id); this.describe(id).catch(() => {}); }, delay);
    t.unref?.();
    this._describeTimers.set(id, t);
  }
  // Whether gallery `gid` is kept in an archive.
  _archived(gid) { const f = this._row(gid)?.format; return !!f && f !== 'folder'; }

  // Gallery `gid`'s changes published in its folder (or archive) — and, for a series' first gallery,
  // its series.json written — when it has changes its folder lacks, its folder is there and its library
  // folder may be written to (`work` as folders.js writable; by default 'publish', which a hidden folder
  // takes too, plan §3.4): one that can't be now waits, still pending (another app's folder until it is
  // taken back, one out of reach until it is back). Once the publication has committed, the files
  // waiting for it retire (_retire). `all`: brought up to date even when nothing waits to be (a folder
  // being removed from the library: a folder that has the generation published or read here already
  // is left as it is). Resolves { ok }: whether the folder now has what the index has — false when it
  // couldn't be written (tried again later) or was waiting to be and wasn't.
  async describe(gid, { all = false, work = null } = {}) {
    const id = String(gid);
    if (this._describing.has(id)) { await this._describing.get(id).catch(() => {}); return this.describe(id, { all, work }); }
    clearTimeout(this._describeTimers.get(id));
    this._describeTimers.delete(id);
    const lib = this.library;
    const may = work ?? 'publish';
    const run = (async () => {
      const row = this._row(id);
      if (!row || row.unpack) return false;
      if (!row.pending && !all) return true;
      if (!lib.folders.writable(this.rootFor(id), may) || !await this._writesIn(row)) return false;
      if (!disk.existsSync(this._abs(row.path))) return false;
      this._touched.delete(id);
      const upTo = lib._s('SELECT max(rowid) AS n FROM retiring WHERE gid = ?').get(id)?.n ?? 0;
      const token = row.format === 'folder' ? await this._publish(id, row, may) : await this._describeArchive(id, row);
      if (!token) return false;
      await this._describeSeries(id);
      lib._tx(() => {
        lib._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(id, token);
        if (!this._touched.has(id)) lib._s('UPDATE files SET pending = 0, packed_at = ? WHERE gid = ?').run(Date.now(), id);
      });
      this._changes.delete(id);
      await this._letGo(id, upTo, may);
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
      const empty = async () => !this._staged(gid).length && !this._stagedOwn(gid).length && (await disk.readdir(dir).catch(() => null))?.length === 0;
      try {
        // Looked at twice: a page whose file was on its way in when it was first looked at has landed
        // by the second.
        if (!await empty()) continue;
        if (!await empty()) continue;
        lib._dirs.delete(dir);
        await disk.rmdir(dir);
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
      out.push({ name: 'ComicInfo.xml', data: Buffer.from(galleryExport.comicInfoXml(meta, { owner, pageCount: records.length })) });
    }
    return out;
  }

  // Gallery `gid`'s next generation as the index has it (gallery-manifest.js): { next — its manifest but
  // the descriptions: every slot's file, the size and time each was recorded written with, a linked
  // page's source picture, the generation after the one last published or read here, this app as its
  // writer — and texts, its descriptions by name (_descriptions) }. `placing`: staged pages about to be
  // added to its archive, page number → the name each takes there.
  _generation(gid, { placing = null } = {}) {
    const lib = this.library;
    const known = new Map();   // path → [size, mtime]: as the index recorded them
    const note = (v) => {
      if (v == null || typeof v !== 'object') return;
      if (typeof v.$own === 'string') { known.set(v.$own, [v.size ?? 0, v.mtime ?? 0]); return; }
      for (const x of Array.isArray(v) ? v : Object.values(v)) note(x);
    };
    const records = lib._pageRows(gid).map((r) => {
      const rec = lib._rowRecord(r), orig = parse(r.orig), name = placing?.get(r.n);
      note(rec);
      if (orig.at === 'p') known.set(orig.entry, [orig.size ?? 0, orig.mtime ?? 0]);
      return { ...rec, blob: name ? { at: 'p', entry: name, size: orig.size } : orig };
    });
    const cover = lib._coverGet(gid);
    note(cover);
    const files = format.slotFiles({ records, covers: { gallery: cover?.cover, series: cover?.seriesCover } },
      (src) => src.$own ?? (src.at === 'p' ? src.entry : null));
    const sources = Object.fromEntries(records.filter(r => r.blob.at === 'x').map(r => [String(r.pageNum), { name: r.blob.entry, size: r.blob.size ?? 0 }]));
    const texts = Object.fromEntries(this._descriptions(gid, { placing: placing && new Set(placing.keys()) }).map(f => [f.name, f.data.toString('utf8')]));
    const sizes = Object.fromEntries([...known].filter(([f]) => format.isPicturePath(f)));
    const generation = format.generationOf(lib._s('SELECT stamp FROM stamps WHERE gid = ?').get(String(gid))?.stamp) + 1;
    return { next: { format: 'shiori-gallery', version: 2, galleryId: String(gid), generation, writer: lib.folders._me(), files, sizes,
      ...(Object.keys(sources).length ? { sources } : {}) }, texts };
  }

  // Gallery `gid`'s generation published in its folder (`row`) through the folder store (folder-store.js:
  // the folder opened for `work` — a removal's write-back, else 'publish' — and the gallery's directory
  // there): resolves the token it is published at (gallery-manifest.js tokenOf), or null when the
  // folder can't take it now. A gallery with nothing waiting (a removal's write-back) writes nothing
  // where its folder has a generation already — the one last published or read here, or another app's
  // since, which a check reads (D4) — and is published only where the folder's manifest is lost or
  // damaged.
  async _publish(gid, row, work) {
    const lib = this.library;
    const { root, rest } = this._split(row.path);
    const opened = await lib.store.open({ id: root, location: lib.rootDir(root) }, { purpose: work === 'removal' ? 'removal' : 'publish' });
    if (opened.status !== 'ok') return null;
    const found = await opened.root.gallery(rest, gid);
    if (found.kind !== 'ok') return null;
    const had = lib._s('SELECT stamp FROM stamps WHERE gid = ?').get(String(gid))?.stamp;
    if (!row.pending && had && (await found.dir.manifest()).kind === 'ok') return had;
    const { next, texts } = this._generation(gid);
    const { manifest, bytes } = await found.dir.publish({ manifest: next, descriptions: texts });
    lib.writes.add('descriptions', bytes);
    return format.tokenOf(manifest);
  }

  // An archive's changes published: the descriptions that changed and its manifest (format v2, naming
  // the entries it is appended with) added at its end with one new directory (zip.js appendZip —
  // nothing else in it is written again), the length it had kept first, so an addition the app didn't
  // finish is cut off again (resume). An archive not in the gallery format (added by hand) is left as
  // it is: resolves null (its descriptions are only the index's), else the token it is published at.
  async _describeArchive(gid, row) {
    return this._exclusive(gid, () => this._describeArchiveNow(gid, row));
  }
  async _describeArchiveNow(gid, row) {
    const lib = this.library;
    const file = this._abs(row.path);
    const dir = await this._directory(file);
    if (!this._formatted(dir)) return null;
    const { add, drop, token } = await this._archiveChanges(gid, row, dir);
    if (!add.length && !drop.length) return token;
    lib._s('UPDATE files SET tail = ? WHERE gid = ?').run((await disk.stat(file)).size, gid);
    lib.writes.addArchive(await appendZip(file, add, { drop }));
    lib._s('UPDATE files SET tail = NULL WHERE gid = ?').run(gid);
    this._dirs.delete(file);
    return token;
  }
  // Whether an archive's directory (`dir`) is in the gallery format: it describes itself.
  _formatted(dir) { return dir.has(content.MANIFEST_FILE) || dir.has('metadata.json') || dir.has('image_records.json'); }

  // What publishing gallery `gid` adds to its archive (`row`, its directory `dir`): { add, drop, token }
  // — its descriptions that differ from the archive's (and ComicInfo.xml, for a CBZ, as its export has),
  // its manifest unless the archive's names the same files and descriptions already, and the
  // descriptions it no longer has. `placing` as for _generation.
  async _archiveChanges(gid, row, dir, { placing = null } = {}) {
    const file = this._abs(row.path);
    const differs = async (name, data) => { const e = dir.get(name); return !e || e.size !== data.length || !(await readEntry(file, e)).equals(data); };
    const listed = this._descriptions(gid, { comicInfo: row.format === 'cbz', placing: placing && new Set(placing.keys()) });
    const add = [];
    for (const f of listed) if (await differs(f.name, f.data)) add.push(f);
    const drop = DESCRIPTIONS.filter(name => dir.has(name) && !listed.some(f => f.name === name));
    const { next, texts } = this._generation(gid, { placing });
    const had = dir.get(content.MANIFEST_FILE) ? format.parseManifest(String(await readEntry(file, dir.get(content.MANIFEST_FILE))), { galleryId: gid, archive: true }) : null;
    const prev = had?.kind === 'ok' ? had.value : null;
    const fresh = format.archiveManifest({ ...next, generation: Math.max(next.generation, (prev?.generation ?? 0) + 1) }, texts);
    const same = prev && JSON.stringify([prev.files, prev.descriptions, prev.sources ?? null]) === JSON.stringify([fresh.files, fresh.descriptions, fresh.sources ?? null]);
    if (same && !add.length && !drop.length) return { add, drop, token: format.tokenOf(prev) };
    fresh.sizes = Object.fromEntries(format.namedPictures(fresh.files).map(f => [f, [dir.get(f)?.size ?? next.sizes[f]?.[0] ?? 0, 0]]));
    add.push({ name: content.MANIFEST_FILE, data: Buffer.from(format.manifestText(fresh)) });
    return { add, drop, token: format.tokenOf(fresh) };
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
          const name = this._nameFor(gid, r, orig, null);
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
      // Its descriptions, and its manifest last (_archiveChanges): each kept as the archive has it unless
      // it changed.
      const names = new Map([...placing].map(([n, p]) => [n, p.name]));
      const described = await this._archiveChanges(gid, row, dir, { placing: names });
      for (const d of this._descriptions(gid, { comicInfo: row.format === 'cbz', placing: new Set(placing.keys()) })) live.set(d.name, { size: d.data.length });
      if (dir.has(content.MANIFEST_FILE)) live.set(content.MANIFEST_FILE, { size: dir.get(content.MANIFEST_FILE).size });
      for (const d of described.add) { live.delete(d.name); live.set(d.name, { size: d.data.length, data: d.data }); }
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
          lib._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(gid, described.token);
          if (!this._touched.has(gid)) lib._s('UPDATE files SET unpack = 0, pending = 0, packed_at = ? WHERE gid = ?').run(Date.now(), gid);
          lib._logIn(gid);
        }));
        for (const f of gone) disk.rmSync(f, { force: true });
      };
      if (!add.length && !drop.length) { finish(); return 'done'; }
      // How much of it would be unused once added to: all it would hold, but what it then lists.
      const { size } = await disk.stat(file);
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
      disk.renameSync(temp, file);
      this._dirs.delete(file);
    } catch (e) {
      await disk.rm(temp, { force: true }).catch(() => {});
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
  // first; its folder (or archive) is renamed there under a free name — a series member into its
  // series' folder there, when it has one — and its row switched over in the same synchronous step
  // (D25). Where it can't be renamed (another drive), and for a linked gallery, it is copied there,
  // its row switched over in one synchronous step, and the old copy deleted. If the gallery changed
  // while it was being copied, the copy goes and it is copied again. A gallery with no files yet only
  // changes where it goes; a record with metadata
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
      if (row.state === 'missing' || !disk.existsSync(from)) throw new BackendError('unavailable', `the files of gallery ${id} can't be found`);
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
      // Its row switched over to `rel` in the library's transaction, and only into a folder that can
      // still take it (shown, held and reachable — not one hidden, removed or taken over meanwhile:
      // F02) — its place with it (library.js _placesIn). A linked gallery's source is noted as removed
      // where it was, by the same step (folders.js removedIn). Throws when it is refused.
      const switchOver = (renamed = false) => lib._tx(() => {
        lib.folders.assertMoveTo(root);
        lib._logIn(id);
        lib._s('UPDATE files SET path = ?, source = NULL WHERE gid = ?').run(rel, id);
        if (renamed) lib._s('UPDATE retiring SET dir = ? WHERE dir = ?').run(rel, row.path);   // its files to delete went with it
        for (const [n, orig] of linkedPlaced) lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify(orig), id, n);
        if (row.source) lib.folders.removedIn(leaving, id, row.path, this.sourceOf(row));
        this._pend(id);
        this._pendOwner(id);
      });
      this._reserved.add(rel);
      // The library's own gallery is moved by renaming its folder or archive there (D25): no picture
      // written again. Renamed and switched over in one synchronous step — while nothing else writes
      // to its archive (_exclusive), and only when nothing changed, is being settled or described
      // since it was looked at — then renamed back should the switch be refused. A rename the disk
      // won't do (another drive; Windows holding a file in it for a moment) leaves it to the copy.
      let renamed = 'copy';
      if (!row.source) {
        try {
          await disk.mkdir(path.dirname(to), { recursive: true });
          renamed = await this._exclusive(id, () => {
            if (signature() !== before || this._placing.has(id) || this._describing.has(id)) return 'changed';
            try { disk.renameSync(from, to); } catch (e) {
              if (['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) return 'copy';
              throw e;
            }
            try { switchOver(true); } catch (e) { disk.renameSync(to, from); throw e; }
            return 'moved';
          });
        } catch (e) { this._reserved.delete(rel); throw e; }
      }
      if (renamed !== 'copy') this._reserved.delete(rel);
      if (renamed === 'changed') continue;
      if (renamed === 'moved') {
        this._forget(row.path);
        if (lib.folders.writable(leaving, work)) await this._tidy(path.dirname(from)).catch(() => {});
        this.scheduleDescribe(id, 0);
        return true;
      }
      try {
        await disk.mkdir(path.dirname(to), { recursive: true });
        await disk.rm(temp, { recursive: true, force: true });
        // Not what a write under way holds aside, nor its files waiting to retire (its descriptions are
        // published again in its new place).
        const retiring = new Set(lib._s('SELECT name FROM retiring WHERE dir = ?').all(row.path).map(r => path.join(from, ...r.name.split('/'))));
        if (row.format === 'folder') await disk.cp(from, temp, { recursive: true, errorOnExist: true, force: false, filter: (src) => !src.endsWith('.shiori-tmp') && !src.endsWith(linkedSource.SOURCE_FILE) && !retiring.has(src) });
        else await disk.copyFile(from, temp, disk.constants.COPYFILE_EXCL);
        // A linked gallery's pages in its source: written into it as the gallery format puts them.
        if (row.source) {
          for (const r of lib._pageRows(id)) {
            const orig = parse(r.orig);
            if (orig.at !== 'x') continue;
            const name = layout.layoutPath.original(r.n, layout.originalExt(orig.type, r.key));
            await disk.mkdir(path.join(temp, 'images'), { recursive: true });
            await disk.writeFile(path.join(temp, ...name.split('/')), await this._readSource(row, orig.entry));
            linkedPlaced.set(r.n, { at: 'p', entry: name, size: orig.size, type: orig.type });
          }
        }
        lib.writes.add(row.format === 'folder' ? 'pages' : 'archive', await bytesIn(temp));
        if (signature() !== before) { await disk.rm(temp, { recursive: true, force: true }); continue; }
        await disk.rename(temp, to);
      } catch (e) {
        await disk.rm(temp, { recursive: true, force: true }).catch(() => {});
        throw e;
      } finally {
        this._reserved.delete(rel);
      }
      // One synchronous step from here: switched over only when nothing changed while it was copied;
      // the copy deleted again should that be refused, the gallery left where it was.
      if (signature() !== before) { await disk.rm(to, { recursive: true, force: true }).catch(() => {}); continue; }
      try {
        switchOver();
      } catch (e) {
        await disk.rm(to, { recursive: true, force: true }).catch(() => {});
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
        || lib._s('SELECT 1 FROM retiring WHERE dir = ?').get(rel)
        || disk.existsSync(this._abs(rel)) || disk.existsSync(`${this._abs(rel)}.shiori-tmp`);
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
      && !this._staged(gid).length && !this._retiring(gid).length && !this._stagedOwn(gid).length && !this._regroupWanted.has(gid)
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
  // descriptions, pages and pictures of its own (ComicInfo.xml too, for a CBZ), and its manifest last
  // (format v2, naming those entries) — as { entries, token: the token it is published at }, or null
  // when the folder holds anything else (put there by hand, or a write under way) or lacks one of them.
  // Its own .shiori/ (the folder's manifest and stored descriptions) is Shiori's, and not copied: the
  // archive's manifest takes its place.
  async _archiveEntries(gid, dir, archiveFormat) {
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
    const descriptions = this._descriptions(gid, { comicInfo: archiveFormat === 'cbz' });
    const named = new Set([...pictures.keys(), ...DESCRIPTIONS]);
    for (const name of await filesIn(dir)) {
      if (!named.has(name) && !name.startsWith('.shiori/') && !WINDOWS_FILES.has(name.toLowerCase())) return null;
    }
    const sizes = {};
    for (const [name, size] of pictures) {
      const stat = disk.statSync(path.join(dir, ...name.split('/')), { throwIfNoEntry: false });
      if (!stat?.isFile() || (size != null && stat.size !== size)) return null;
      sizes[name] = [stat.size, 0];
    }
    const { next, texts } = this._generation(gid);
    const manifest = format.archiveManifest({ ...next, sizes }, texts);
    return { token: format.tokenOf(manifest), entries: [
      ...descriptions.filter(d => d.name !== 'ComicInfo.xml'),
      ...[...pictures.keys()].map(name => ({ name, from: path.join(dir, ...name.split('/')) })),
      ...descriptions.filter(d => d.name === 'ComicInfo.xml'),
      { name: content.MANIFEST_FILE, data: Buffer.from(format.manifestText(manifest)) },
    ] };
  }

  // Gallery `gid` archived: its folder's files written once into one archive beside it (stored, in
  // archiveFormat), read back, then — in one synchronous step, when the gallery hasn't changed
  // meanwhile — put in the folder's place. The folder retires, each of its files named as it is now
  // (what an archiving let go is deleted by name, never whatever holds its path later: T03), and the
  // archive is named there too until the gallery has it (an archiving cut short leaves it to delete).
  // Resolves whether it was archived.
  async archive(gid) {
    const id = String(gid);
    const lib = this.library;
    const row = this._row(id);
    if (!this._idle(id, row) || !lib.folders.writable(this.rootFor(id))) return false;
    const archiveFormat = this.archiveFormat === 'cbz' ? 'cbz' : 'zip';
    const dir = this._abs(row.path);
    const signature = this._signature(id);
    const made = await this._archiveEntries(id, dir, archiveFormat).catch(() => null);
    if (!made) {   // left as a folder: looked at again after another while
      lib._s('UPDATE files SET used_at = ? WHERE gid = ?').run(Date.now(), id);
      return false;
    }
    const { entries, token } = made;
    const rel = this._freePath(row.path, `.${archiveFormat}`);
    const file = this._abs(rel), temp = `${file}.shiori-tmp`;
    this._reserved.add(rel);
    try {
      lib.writes.addArchive(await writeZip(temp, entries));
      const written = await readDirectory(temp);
      const sizeOf = (e) => e.data?.length ?? disk.statSync(e.from).size;
      if (written.size !== entries.length || entries.some(e => written.get(e.name)?.size !== sizeOf(e))) throw new Error('the archive did not read back');
      const leaving = [];
      for (const name of await filesIn(dir)) {
        const st = disk.statSync(path.join(dir, ...name.split('/')), { throwIfNoEntry: false });
        if (st?.isFile()) leaving.push({ name, size: st.size, mtime: st.mtimeMs });
      }
      // One synchronous step from here.
      const now = this._row(id);
      if (now?.path !== row.path || !this._idle(id, now) || this._signature(id) !== signature) {
        await disk.rm(temp, { force: true });
        return false;
      }
      const st = disk.statSync(temp);
      this._retireIn(rel, '', { size: st.size, mtime: st.mtimeMs }, null);
      disk.renameSync(temp, file);
      lib._tx(() => {
        lib._s('UPDATE files SET path = ?, format = ? WHERE gid = ?').run(rel, archiveFormat, id);
        lib._s(`DELETE FROM retiring WHERE dir = ? AND name = ''`).run(rel);
        for (const f of leaving) this._retireIn(row.path, f.name, f, null);
        lib._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(id, token);
        lib._logIn(id);
      });
      lib.publishFeed(id);
    } catch (e) {
      await disk.rm(temp, { force: true }).catch(() => {});
      throw e;
    } finally {
      this._reserved.delete(rel);
    }
    this._forget(row.path);
    await this._retire();
    return true;
  }

  // What waits to retire with nothing more to wait for (`gid` null: a folder or archive no gallery has
  // any more — an archived gallery's old folder, an archive an archiving cut short left), deleted by
  // name, each file only while it is still as Shiori recorded it (folder-store.js deleteNamedIn: one
  // changed since is left, and reported; a folder left empty goes too). A row is forgotten once its file
  // is gone or found changed, or once a gallery has its path again (found there by a check); one that
  // couldn't be deleted now is tried again at the next sweep. Only where its library folder may be
  // written to (`work` as folders.js writable).
  async _retire({ work = null } = {}) {
    const lib = this.library;
    const byDir = new Map();
    for (const r of lib._s('SELECT rowid AS seq, dir, name, size, mtime FROM retiring WHERE gid IS NULL').all()) {
      if (!byDir.has(r.dir)) byDir.set(r.dir, []);
      byDir.get(r.dir).push(r);
    }
    for (const [rel, rows] of byDir) {
      if (!lib.folders.writable(this._split(rel).root, work)) continue;
      const abs = this._abs(rel);
      if (lib._s('SELECT 1 FROM files WHERE path = ?').get(rel)) {
        lib._tx(() => { for (const r of rows) lib._s('DELETE FROM retiring WHERE rowid = ?').run(r.seq); });
        continue;
      }
      const whole = rows.find(r => r.name === '');
      if (whole && this._reading.get(abs)) continue;
      const list = whole ? [{ name: path.basename(abs), size: whole.size, mtime: whole.mtime }] : rows.map(r => ({ name: r.name, size: r.size, mtime: r.mtime }));
      const { kept } = await deleteNamedIn(whole ? path.dirname(abs) : abs, list, { emptied: false });
      if (whole) { this._forgetRetired(rel, [{ ...whole, name: path.basename(abs) }], kept); continue; }
      // A folder left with nothing but empty folders goes whole, as Explorer deletes (remove.js) — its
      // rows kept until it has; one still holding files Shiori didn't name keeps them, and is left.
      const empty = !(await filesIn(abs).catch(() => [null])).length;
      if (empty && !await this._delete(abs)) continue;
      this._forgetRetired(rel, rows, kept);
    }
  }
  // Gallery `gid`'s files that waited for its publication (recorded up to `retiring` row `upTo`; all of
  // them by default, one having committed since), deleted from its folder by name while each is still
  // as written — while the folder may be written to (`work`) — a row kept only for one that couldn't be
  // deleted now (tried again after its next publication, or at the next start). Rows of a folder it has
  // left (moved by a copy, whose old folder went) are forgotten.
  async _letGo(gid, upTo = Number.MAX_SAFE_INTEGER, work = null) {
    const lib = this.library;
    const row = this._row(gid);
    const rows = lib._s('SELECT rowid AS seq, dir, name, size, mtime FROM retiring WHERE gid = ? AND rowid <= ?').all(String(gid), upTo);
    if (!rows.length || !row || !lib.folders.writable(this._split(row.path).root, work)) return;
    const here = rows.filter(r => r.dir === row.path);
    const { kept } = await deleteNamedIn(this._abs(row.path), here.map(r => ({ name: r.name, size: r.size, mtime: r.mtime })));
    this._forgetRetired(row.path, here, kept);
    lib._tx(() => { for (const r of rows) if (r.dir !== row.path) lib._s('DELETE FROM retiring WHERE rowid = ?').run(r.seq); });
  }
  // The rows (`rows`: { seq, name }) of folder `rel` deleteNamedIn went through forgotten — all but those
  // of files it couldn't delete now (`kept` 'unreadable'); one changed outside Shiori is reported.
  _forgetRetired(rel, rows, kept) {
    const again = new Set(kept.filter(k => k.why === 'unreadable').map(k => k.name));
    for (const k of kept) if (k.why === 'changed') console.warn(`[shiori] ${rel}/${k.name} changed since Shiori wrote it: left as it is`);
    this.library._tx(() => { for (const r of rows) if (!again.has(r.name)) this.library._s('DELETE FROM retiring WHERE rowid = ?').run(r.seq); });
  }
}

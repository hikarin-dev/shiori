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

import { disk, physicallyIn, containedWhole, replaceFile, tempBeside, writeNewIn, deleteNamedIn, deleteGalleryIn, galleryIn, reserveIn, undescribedAt, bindIn, ioFailures, gone, holdsFile, filesIn, ownedIn, textsIn, statIn, statNow, entriesIn, textIn, ownDirIn } from './folder-store.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readDirectory, directoryEnd, readEntry, writeZip, appendZip } from './zip.js';
import { files as layout, galleryExport, linked as linkedSource, content, titles, contract, manifest as format, BackendError } from './shared.js';

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
CREATE TABLE IF NOT EXISTS deleting (
  dir TEXT PRIMARY KEY,
  gid TEXT NOT NULL,
  files TEXT
) WITHOUT ROWID;
`;
// `files`: one row per gallery with a place in the library folder; `state` 'packed' when it is
// there, 'missing' when it was found gone; `pending` when its folder lacks changes the index has (its
// next publication: describe); `unpack` when pictures were removed from its archive (its next settle
// adds to or rewrites it); `used_at` when it was last changed or opened in the reader (kept to the
// hour); `tail` the length its archive had while descriptions are being added to it (cut back to it
// should the app stop half way, while nothing of the archive lies past it: cutBack). `staged_own`: a picture of its own (`rel`) waiting in staging
// (`file`) to be added to its gallery's archive — or moved into its folder, written while that
// couldn't be (folders.js writable). `retiring`: a file to delete, as Shiori recorded writing it (its
// `size` and modification time, `mtime`: either null when it wasn't recorded) — `name` in gallery
// folder `dir` (a path as `files` has them), or `dir` itself, an archive, when `name` is '' — once gallery
// `gid` has published a generation that no longer names it (its rowid tells which publications began
// after it was recorded); `gid` null once nothing waits for that. Recorded by the transaction that let
// the file go (a page replaced or removed, a picture made again, an archived gallery's old folder),
// so the intent survives a restart. `deleting`: a gallery's own folder or archive (`dir`, a path as
// `files` has them) to delete for gallery `gid` — deleted, moved out of it by a copy, or unpacked out of
// its archive (F10) — with the files the index recorded writing there (`files`: [{ name, size, mtime }];
// for an archive, deleted whole, { size, mtime } as Shiori last wrote it, or null when it has no record
// of that; { size, mtime, unpacked: true, took } as an unpack read one not in the gallery format, with
// the entries it took), recorded by the transaction that let it go and deleted by name once that commits
// (applyDeletions), or at the next start; a check meanwhile leaves it alone (N2, N4). `unfound`: its
// folder or archive wasn't where it has it (renamed or moved by hand: F4) — kept until a check of its
// library folder has ended, which deletes the folder naming the gallery where it meets one, never
// adopting it. `zip_size`, `zip_mtime` (`files`): an archive's size and modification time as Shiori
// last wrote it (F6). `moving` (`files`): where its folder or archive is being renamed to (a move within
// a drive: moveTo, _regroup), set before the rename and cleared by the transaction that switches it
// over, so a rename the app stopped in is finished, or found not done, at the next start (finishMoves;
// review 4 F8). `source`: for a
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
const NAMED_TTL = 2000;        // how long a gallery's folder found to name it is taken to, for reads (_namesIt)
const COLUMNS = { files: { unpack: 'INTEGER NOT NULL DEFAULT 0', used_at: 'REAL', tail: 'REAL', source: 'TEXT', zip_size: 'INTEGER', zip_mtime: 'REAL', moving: 'TEXT',
  converting: 'INTEGER NOT NULL DEFAULT 0' }, deleting: { unfound: 'INTEGER NOT NULL DEFAULT 0' } };
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
// The source picture a linked gallery's page shows (`orig` at 'x'), as its descriptions record it:
// name, size and content signal (linked-source.js provenanceOf, principle 7).
const provenance = (orig) => linkedSource.provenanceOf({ name: orig.entry, size: orig.size ?? 0, crc: orig.crc, mtime: orig.mtime });
// A page's source token (linked-source.js pageToken) from where its original is (`orig`) and its record.
export const sourceToken = (orig, record) => linkedSource.pageToken(orig?.at === 'x' ? provenance(orig) : null, record);
const extOfName = (name) => String(name ?? '').match(/\.(\w+)$/)?.[1]?.toLowerCase();
// The files of a gallery's own that its records name in its folder, as the index recorded writing
// them: path → [size, mtime] (mtime 0 where none was recorded) — each page there (`orig` at 'p') and
// what was made from it, and its covers' (`rows`: its pages' rows; `cover`: its cover record). The
// owner's dry run reads an index's alike.
export function recordedFiles(rows, cover) {
  const known = new Map();
  const note = (v) => {
    if (v == null || typeof v !== 'object') return;
    if (typeof v.$own === 'string') { known.set(v.$own, [v.size ?? 0, v.mtime ?? 0]); return; }
    for (const x of Array.isArray(v) ? v : Object.values(v)) note(x);
  };
  for (const r of rows) {
    note(parse(r.record));
    const orig = parse(r.orig);
    if (orig?.at === 'p') known.set(orig.entry, [orig.size ?? 0, orig.mtime ?? 0]);
  }
  note(cover);
  return known;
}
// The files of the gallery's own a value refers to ({ $own: 'translated/0001.png', size }): rel → size.
function ownFiles(value, into = new Map()) {
  if (value == null || typeof value !== 'object') return into;
  if (typeof value.$own === 'string') { into.set(value.$own, value.size ?? null); return into; }
  for (const v of Array.isArray(value) ? value : Object.values(value)) ownFiles(v, into);
  return into;
}
// What `abs` holds as it is now, as `retiring` records it: a file as itself (name ''), a folder as each
// file under it (its path there), each with its size and modification time.
async function asWritten(abs) {
  const of = (name, st) => ({ name, size: st.size, mtime: st.mtimeMs });
  const st = await disk.stat(abs);
  if (!st.isDirectory()) return [of('', st)];
  return Promise.all((await filesIn(abs)).map(async (name) => of(name, await disk.stat(path.join(abs, ...name.split('/'))))));
}

// The bytes of a file, or of every file in a folder.
async function bytesIn(abs) {
  const stat = await disk.stat(abs);
  if (!stat.isDirectory()) return stat.size;
  let n = 0;
  for (const rel of await filesIn(abs)) n += (await disk.stat(path.join(abs, ...rel.split('/')))).size;
  return n;
}

// What a folder of a library folder is (folder-content.js classifyFolder), from the descriptions its
// listing (`items`: its entries) shows (folder-store.js textsIn). Rejects when one can't be read now.
export const classifyAt = async (dir, items) => content.classifyFolder(await textsIn(dir, items, content.OWN_FILES));
// Folder `dir`'s listing (its entries, with their types) when it is gallery `gid`'s own by what it holds
// (folder-store.js galleryIn: its manifest, else its description; a linked gallery's overlay, its
// source.json), else null — so that a folder the index took for a gallery's on another rule is never
// tidied (R01) nor deleted with it (F01), and what is looked for in it goes by the listing that told it
// so. One that can't be read isn't known to be.
export const ownedBy = async (dir, gid) => { const whose = await galleryIn(dir, String(gid)); return whose.kind === 'ok' ? whose.items : null; };

// The library folder's own id, kept in its .shiori/library.json and made the first time: this
// computer's data for the library (its index and thumbnails) is found by it, so the folder keeps
// them whatever drive letter or path it is reached by. A file that can't be read, or names no library,
// is an error, never a reason to start over under a new id.
export const libraryId = (libraryDir) => idIn(libraryDir) ?? writeId(libraryDir, freshId());
const freshId = () => crypto.randomBytes(8).toString('hex');
const idFile = (libraryDir) => path.join(libraryDir, ...content.LIBRARY_FILE.split('/'));
// Folder `libraryDir`'s library.json as it is; null when it has none.
function idText(libraryDir) {
  try { return disk.readFileSync(idFile(libraryDir), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
// The id folder `libraryDir`'s library.json names (folder-content.js libraryIdOf); null when it has none,
// or one holding nothing (holdsNothing: the website's first write of it cut short).
function idIn(libraryDir) {
  const text = idText(libraryDir);
  if (text == null || content.holdsNothing(text)) return null;
  const id = content.libraryIdOf(text);
  if (!id) throw new Error(`${idFile(libraryDir)} names no library id`);
  return id;
}
// `id` written as folder `libraryDir`'s library.json, whole: written beside it, then renamed into place,
// so a kill leaves none there, never an empty one that stops every start (review 5 F4). Never over one
// naming a library: one found there meanwhile (a read that answered "not found" for a moment) is the
// folder's id. One there naming none is written over only when it holds nothing, or when the caller has
// told the folder for the library's (`over`); else it is an error, and stays. Returns the folder's id.
function writeId(libraryDir, id, { over = false } = {}) {
  const file = idFile(libraryDir);
  ownDirIn(libraryDir);
  const temp = tempBeside(file);
  const drop = () => { try { disk.rmSync(temp, { force: true }); } catch {} };
  try {
    disk.writeFileSync(temp, JSON.stringify({ format: 'shiori-library', version: 1, id }, null, 2), { flush: true });
    const now = idText(libraryDir);
    const found = now == null ? null : content.libraryIdOf(now);
    if (found) { drop(); return found; }
    if (now != null && !content.holdsNothing(now) && !over) throw new Error(`${file} names no library id`);
    disk.renameSync(temp, file);
  } catch (e) { drop(); throw e; }
  return id;
}

// Which library the first library folder `libraryDir` holds, as the app's start opens it (main.js): its
// id, its index and thumbnails in `librariesDir/<id>` on this computer. A folder without a library.json
// is never started over as a new, empty library while it may hold one: that would leave the library's
// other folders and the person's marks out of reach (review 4 F5), or link whatever another drive at its
// letter holds (O1). So each library notes in its data folder the folder it was last opened from
// (FIRST_NOTE: its path, and the number the system gives that folder on its volume, which a folder keeps
// when renamed and no other folder shares). A library.json that names no library — empty (what a kill
// inside an earlier version's write of it left) or not a library's — is told as a missing one is:
// - the folder's library.json names a library: that one;
// - it has none, and one library's note names this very folder: that library, its library.json written
//   back (the person deleted it, or a kill emptied it), over one naming none;
// - it has none, and it was `chosen` by the person just now, or nothing on this computer may have been
//   kept there (no note names its path, no index is older than the notes; one v1.0.13 or v1.0.14 made
//   is not, see earlierIndex): a new library, its folder made if need be — unless a library.json naming
//   none and holding something is there: the person's, never written over;
// - otherwise refused, nothing written (BackendError 'unavailable'): reason 'missing' when no folder is
//   at the path (its drive not connected, or the folder gone), 'unknown' when a folder is there that
//   can't be told to be the library's (another drive at its letter, a copy of the folder, one an index
//   older than the notes may have been kept in, or one holding a library.json of the person's).
const FIRST_NOTE = 'first-folder.json';
export async function firstLibrary(librariesDir, libraryDir, { chosen = false } = {}) {
  const dir = path.resolve(libraryDir);
  const text = idText(dir);
  const named = text == null ? null : content.libraryIdOf(text);
  if (named) return noteFirst(librariesDir, named, dir);
  const notes = await notesIn(librariesDir);
  const st = await disk.stat(dir, { bigint: true }).catch((e) => { if (e?.code === 'ENOENT') return null; throw e; });
  const number = st?.isDirectory() ? folderNumber(st) : null;
  const same = notes.filter(n => n.path && samePath(n.path, dir) && number && n.folder === number);
  if (same.length === 1) return noteFirst(librariesDir, writeId(dir, same[0].id, { over: true }), dir);
  if ((!chosen && (same.length || notes.some(n => !n.path || samePath(n.path, dir)))) || text?.trim()) {
    throw Object.assign(new BackendError('unavailable', `${dir} can't be told to hold this computer's library`), { reason: st ? 'unknown' : 'missing' });
  }
  disk.mkdirSync(dir, { recursive: true });
  return noteFirst(librariesDir, writeId(dir, freshId()), dir);
}
// Folder `dir`'s number on its volume: null where the system gives none.
const folderNumber = (st) => (st.ino ? `${st.dev}:${st.ino}` : null);
// Every library's note on this computer: { id, path, folder }, or { id, path: null } for an index
// without a note that can be read (one older than the notes), unless v1.0.13 or v1.0.14 made it.
async function notesIn(librariesDir) {
  const ids = await disk.readdir(librariesDir).catch((e) => { if (e?.code === 'ENOENT') return []; throw e; });
  const out = [];
  for (const id of ids.filter(n => /^[0-9a-f]{16}$/.test(n))) {
    const note = await disk.readFile(path.join(librariesDir, id, FIRST_NOTE), 'utf8').then(JSON.parse).catch(() => null);
    const index = path.join(librariesDir, id, 'library.db');
    if (typeof note?.path === 'string') out.push({ id, path: note.path, folder: note.folder ?? null });
    else if (disk.existsSync(index) && !earlierIndex(index)) out.push({ id, path: null });
  }
  return out;
}
// Whether index `file` was made by v1.0.13 or v1.0.14. Those named an index by a hash of its folder's
// path and never wrote a library.json, and v1.1.0 started a new index for every folder rather than carry
// theirs over: no library can be opened from one, so a folder it was kept in starts a library, as it
// has since v1.1.0. Told by its change log, which only those versions had SQLite number (AUTOINCREMENT;
// library.js numbers it itself since v1.1.0, the version that brought library ids). Read as it is on
// disk (`immutable`: SQLite makes no -wal or -shm beside it), so one whose tables never left its -wal
// (those versions killed every time before their first checkpoint) isn't told; it counts, as does one
// that can't be read.
function earlierIndex(file) {
  const url = pathToFileURL(file);
  url.search = 'immutable=1';
  let db = null;
  try {
    db = new DatabaseSync(url, { readOnly: true });
    return /AUTOINCREMENT/i.test(db.prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'changes'`).get()?.sql ?? '');
  } catch { return false; } finally { db?.close(); }
}
// Library `id` noted as opened from folder `dir` (written only when that changed); resolves `id`.
async function noteFirst(librariesDir, id, dir) {
  const file = path.join(librariesDir, id, FIRST_NOTE);
  const text = JSON.stringify({ path: dir, folder: folderNumber(await disk.stat(dir, { bigint: true })) });
  if (await disk.readFile(file, 'utf8').catch(() => null) !== text) {
    await disk.mkdir(path.dirname(file), { recursive: true });
    await replaceFile(file, text);
  }
  return id;
}
// Whether paths `a` and `b` name one place (Windows' are told apart without case).
export const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
// Whether path `dir` holds library folder `id` at this moment (principle 1): 'ok' when its
// .shiori/library.json names it (folder-content.js libraryIdOf); 'other-library' when a folder is there
// whose library.json names another id, or none, or isn't there; 'unavailable' when no folder is there,
// or its library.json can't be read now (nothing can be told). Read only, never written: a folder's id
// is made once, when it first joins a library (libraryId).
export function identityAt(dir, id) {
  let text;
  try { text = disk.readFileSync(path.join(dir, ...content.LIBRARY_FILE.split('/')), 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR' && e?.reason !== 'outside') return 'unavailable';
    let st = null;
    try { st = disk.statSync(dir, { throwIfNoEntry: false }); } catch {}
    return st?.isDirectory() ? 'other-library' : 'unavailable';
  }
  return content.libraryIdOf(text) === id ? 'ok' : 'other-library';
}

// Whether staged `file` is there (not: as the shared rule takes it, folder-store.js statIn — an answer
// it doesn't take, the drive away, is thrown, the settle tried again: review 5 T-D). A picture is never
// flushed on its own (folder-store.js writeNewIn): power loss is outside the fault model, and only the
// small manifest and descriptions are flushed.
const present = async (file) => !!(await statIn(file))?.isFile();

// A file moved to `to` where nothing is, synchronously — never over a file (principle 3: the caller
// chose a name no file has, and a file put there since is left as it is: EEXIST) — across drives (a
// junction inside the library folder), copied and the original deleted. Nothing is at `to` only as the
// shared rule takes it (folder-store.js statNow): a look that fails, or answers "not found" while the
// drive is away for a moment, fails the move — Windows' rename replaces a file (found in S22). Returns
// whether it was copied (written again).
function moveSync(from, to) {
  if (statNow(to)) throw Object.assign(new Error(`${to} is taken`), { code: 'EEXIST' });
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
    this._named = new Map();           // `${path}\0${gid}` → { at, failures }: when its folder was found to name it (_namesIt)
    this._failures = new Map();        // gid → settles that failed in a row
    this._writing = new Map();         // gid → the write to its archive under way (_exclusive)
    this._changes = new Map();         // gid → changes since its last publication (D12)
    this.keep = new Set();             // galleries being forgotten: deleted from the index, their files kept
  }

  // The tables (the library's folders are read next: folders.js), then — start — what was left to do.
  init() {
    const lib = this.library;
    lib._db.exec(SCHEMA);
    // An index made before archiving (or before S10): its columns added, and every gallery counted as
    // used now.
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const have = new Set(lib._db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      for (const [name, type] of Object.entries(columns)) if (!have.has(name)) lib._db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    lib._s('UPDATE files SET used_at = ? WHERE used_at IS NULL').run(Date.now());
    lib._db.exec(`CREATE INDEX IF NOT EXISTS files_used ON files (used_at, gid) WHERE format = 'folder'`);
  }
  // The moves the app stopped in finished first, the additions to archives it stopped in cut off, and the
  // conversions from the oldest format it stopped in picked up where they stopped (toFormat `converting`:
  // killed just as a picture's rename returned, a page's row would name its old place until the next check —
  // S26a), before anything reads a gallery (finishMoves, cutBack).
  async start() {
    await this.finishMoves();
    await this.cutBack();
    for (const { gid } of this.library._s('SELECT gid FROM files WHERE converting = 1').all()) await this.toFormat(gid).catch(() => {});
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
  //   reported;
  // - a gallery's folder an earlier version never described is given its identity (_bindUndescribed).
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
    if (!lib._kvGet('undescribedBound')) {
      let all = true;
      for (const row of lib._s(`SELECT f.* FROM files f LEFT JOIN stamps s ON s.gid = f.gid WHERE f.format = 'folder' AND f.source IS NULL AND s.gid IS NULL`).all()) {
        if (!writable(row.path) || !await this._bindUndescribed(row).catch(() => false)) all = false;
      }
      if (all) lib._kvSet('undescribedBound', true);
    }
  }
  // A gallery's own folder that an earlier version made but never described (pictures only, which
  // principle 2 refuses every change to) given its identity — at the first start that can write to its
  // library folder, kv `undescribedBound` once every folder could be looked at: only a folder the index
  // made (its `files` row, its own, never published: no stamp), naming no gallery, holding no
  // description and exactly the pictures the index recorded writing there (folder-store.js
  // undescribedAt 'match'), its whole generation published there then (bindIn). Any other stays a
  // conflict, reported on its folder's Needs attention list by the check. Resolves false when it
  // couldn't be looked at now (tried again at the next start).
  async _bindUndescribed(row) {
    const lib = this.library;
    const abs = this._abs(row.path);
    const named = new Map([...recordedFiles(lib._pageRows(row.gid), lib._coverGet(row.gid))].map(([name, [size, mtime]]) => [name, { size, mtime }]));
    for (const r of this._retiring(row.gid)) if (r.dir === row.path && r.name) named.set(r.name, { size: r.size, mtime: r.mtime });
    const found = await undescribedAt(abs, row.gid, named);
    if (found === 'unreadable') return false;
    if (found !== 'match') return true;
    const { next, texts } = this._generation(row.gid);
    const token = await bindIn(abs, next, texts, { hide: (dir) => lib._hide(dir) });
    lib._tx(() => lib._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(row.gid, token));
    return true;
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
  // written to again (shown, taken back) — what waited for it then goes there, a move it was in
  // finished.
  resume() {
    const lib = this.library;
    this.finishMoves().catch(() => {});
    this.cutBack().catch(() => {});
    const ids = new Set();
    for (const r of lib._s(`SELECT DISTINCT gid FROM pages WHERE json_extract(orig, '$.at') = 's'`).all()) ids.add(r.gid);
    for (const r of lib._s('SELECT gid FROM files WHERE unpack = 1').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT DISTINCT gid FROM staged_own').all()) ids.add(r.gid);
    for (const r of lib._s('SELECT gid FROM files WHERE pending = 1').all()) this.scheduleDescribe(r.gid);
    for (const id of ids) this.schedule(id);
    this._carryOver().catch((e) => console.warn('[shiori] carrying the index over to format v2 failed:', String(e?.message || e)))
      .then(async () => {
        // Files a publication let go before the app stopped, or that couldn't be deleted then; galleries'
        // folders a deletion let go likewise (N2).
        for (const { gid } of lib._s('SELECT DISTINCT r.gid FROM retiring r JOIN files f ON f.gid = r.gid WHERE f.pending = 0').all()) await this._letGo(gid).catch(() => {});
        await this._retire();
        await this.applyDeletions();
      }).catch(() => {});
    for (const dir of lib.stagingDirs()) {
      disk.readdir(dir).then(async (names) => {
        for (const name of names) if (!ids.has(name)) await this._unstage(name);
      }).catch(() => {});
    }
  }
  // What was being added to an archive when the app stopped (`tail`: the length it had before), once its
  // folder may be written to: cut back to that length only while nothing of the archive lies past it —
  // its directory, as readers find it, ends there, so what follows is the addition cut short, which no
  // reader takes — then added again. An archive changed since (edited by the person, or the addition
  // finished) is left as it is (review 4 F6), as is one that can't be read now.
  cutBack() {
    const lib = this.library;
    return Promise.all(lib._s('SELECT gid FROM files WHERE tail IS NOT NULL').all().map(({ gid }) => this._exclusive(gid, async () => {
      const r = lib._s('SELECT path, tail FROM files WHERE gid = ? AND tail IS NOT NULL').get(gid);
      if (!r || !lib.folders.writable(this._split(r.path).root)) return;
      const file = this._abs(r.path);
      try { if ((await disk.stat(file)).size > r.tail && await directoryEnd(file) === r.tail) disk.truncateSync(file, r.tail); } catch {}
      lib._s('UPDATE files SET tail = NULL, pending = 1 WHERE gid = ?').run(gid);
      this.scheduleDescribe(gid);
    })));
  }

  close() {
    for (const timers of [this._timers, this._describeTimers, this._regroupRetries]) {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    }
    clearTimeout(this._sweepTimer);
  }

  // Each move within a drive the app stopped in (`moving`), told by what is on disk (_whose, principle
  // 2): one whose folder or archive is gone from where the index has it, its destination naming the
  // gallery, was renamed and is switched over as its move would have been (_renamedIn) — one still where
  // the index has it wasn't, and its record goes. One that can't be told now (a folder out of reach or
  // unreadable, or the switch refused: a folder hidden meanwhile) waits for the next start, its folder
  // shown or taken back, or a read of the gallery (_namesIt).
  async finishMoves() {
    const lib = this.library;
    for (const row of lib._s('SELECT * FROM files WHERE moving IS NOT NULL').all()) {
      try {
        const here = await this._whose(row.path, row.gid);
        const renamed = here.kind === 'missing' && (await this._whose(row.moving, row.gid)).kind === 'ok';
        if (here.kind !== 'ok' && !renamed) continue;
        lib._tx(() => {
          const now = this._row(row.gid);
          if (now?.path !== row.path || now.moving !== row.moving) return;   // changed meanwhile
          if (!renamed) lib._s('UPDATE files SET moving = NULL WHERE gid = ?').run(row.gid);
          else { lib._logIn(row.gid); this._renamedIn(row, row.moving); }
        });
        if (!renamed) continue;
        this._forget(row.path);
        this.scheduleDescribe(row.gid, 0);
        if (lib.folders.writable(this._split(row.path).root)) await this._tidy(path.dirname(this._abs(row.path)));
      } catch {}
    }
  }
  // Gallery `gid`'s folder or archive about to be renamed to `rel` within its drive, recorded before the
  // rename (`moving`); null once it wasn't.
  _moving(gid, rel) { this.library._s('UPDATE files SET moving = ? WHERE gid = ?').run(rel, String(gid)); }
  // Inside the caller's transaction: gallery `row`'s folder or archive renamed to `rel` — its row switched
  // over (and found there), its files waiting to retire with it, it and its series' series.json to publish.
  _renamedIn(row, rel) {
    this.library._s(`UPDATE files SET path = ?, moving = NULL, state = 'packed' WHERE gid = ?`).run(rel, row.gid);
    this.library._s('UPDATE retiring SET dir = ? WHERE dir = ?').run(rel, row.path);
    this._pend(row.gid);
    this._pendOwner(row.gid);
  }

  _row(gid) { return this.library._s('SELECT * FROM files WHERE gid = ?').get(String(gid)); }
  // Where path `rel` (a path in a library folder as the index keeps it: _split) is on disk, for I/O:
  // through its library folder's path while that holds it (library.js rootDir, principle 1) — refused
  // (BackendError 'unavailable', its `reason`) while another library folder is at that path, or it
  // can't be reached. `_at` is the same, null instead of refused; `_key`, where the index has it,
  // whatever is there now — for telling files apart (a cache's keys), never for I/O.
  _abs(rel) {
    const { root, rest } = this._split(rel);
    return path.join(this.library.rootDir(root), ...rest.split('/'));
  }
  _at(rel) { try { return this._abs(rel); } catch (e) { if (e?.code === 'unavailable') return null; throw e; } }
  _key(rel) {
    const { root, rest } = this._split(rel);
    return this.library.folders.has(root) ? path.join(this.library.folders.path(root), ...rest.split('/')) : null;
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

  // Gallery `gid`'s folder, or null when it has none (not placed yet, kept in an archive, or its library
  // folder can't be reached as itself: _at).
  folderOf(gid) {
    const row = this._row(gid);
    return row?.format === 'folder' ? this._at(row.path) : null;
  }
  // The same, for a read of its pictures that needn't load them (a backup's): only while the folder
  // names the gallery (_namesIt).
  async folderToRead(gid) {
    const row = this._row(gid);
    return row?.format === 'folder' && await this._namesIt(row) ? this._at(row.path) : null;
  }

  // Gallery `gid`'s folder, for a file of its own about to be written there: claimed now if the
  // gallery has none yet (`meta` names it when its metadata isn't stored yet), unpacked first if it
  // is kept in an archive added by hand (an archive in the gallery format takes its pictures staged:
  // stageOwn). A gallery whose folder is gone, or can't be written to now, has nowhere to write; nor
  // has one whose folder no longer names it (principle 2: a folder put at its place by hand —
  // refused, reason 'conflict', and reported).
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
      const whose = await this._whose(row.path, id);
      if (whose.kind === 'ok') return dir;
      if (whose.kind === 'conflict') throw this._conflict(row);
      if (whose.kind === 'missing') await this._seen(row, false);
      throw new BackendError('aborted', `the folder of gallery ${id} is ${whose.kind === 'missing' ? 'missing' : 'unreadable'}`);
    }
    throw new BackendError('aborted', `gallery ${id} couldn't be unpacked into a folder`);
  }

  // The refusal of a change to gallery `row`'s folder, which no longer names it (principle 2: a folder
  // put at its place by hand): noted on its library folder's Needs attention list (folders.js note)
  // until a check finds otherwise.
  _conflict(row) {
    const { root, rest } = this._split(row.path);
    this.library.folders.note(root, { reason: 'conflict', path: rest, gid: row.gid });
    return Object.assign(new BackendError('conflict', `the folder of gallery ${row.gid} doesn't name it any more`), { reason: 'conflict' });
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
  // moment (folder-store.js reserveIn, principle 2: the only way a folder becomes a gallery's): its
  // first generation is published there, naming it as reserved, with its metadata.json (as much of it
  // as is known) stored, as the website's reserveDir does — and the token it is published at recorded. Nothing is
  // written to, or deleted from, a folder that doesn't name its gallery (_whose), and its full
  // descriptions follow in due course. `root`: the library folder, when it is given (a reservation
  // through the folder store: folder-store.js). Returns its row.
  _claim(gid, meta, work = null, root = this.rootFor(gid)) {
    const lib = this.library;
    lib.folders.assertWritable(root, work);
    const rel = this._choosePath(gid, meta, root);
    const token = this._reserveAt(this._abs(rel), gid, meta);
    lib._s(`INSERT INTO files (gid, path, format, state, packed_at, pending, used_at) VALUES (?, ?, 'folder', 'packed', ?, 1, ?)`)
      .run(gid, rel, Date.now(), Date.now());
    lib._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(String(gid), token);
    this._pendOwner(gid);
    return this._row(gid);
  }
  // Folder `abs`, made now, reserved for gallery `gid` (folder-store.js reserveIn) with its metadata as
  // the index has it (or `meta`, when it isn't stored yet): the token its first generation is at.
  _reserveAt(abs, gid, meta = null) {
    const lib = this.library;
    const named = titles.migrateTitle({ ...(meta || lib._metaGet(gid) || {}), galleryId: String(gid) });
    return reserveIn(abs, String(gid), lib.folders._me(), JSON.stringify(named, null, 2), { hide: (dir) => lib._hide(dir) });
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
    const archived = row && row.format !== 'folder' && await this._inFormat(row) !== false;   // staged too when it can't be told
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

  // Inside the library's transaction deleting `gid` — before its pages and cover go: what it recorded
  // writing is read from them. Refused, with the transaction, while the library folder its files are in
  // can't be written to now (plan D3, principle 8: folders.js reach for 'write' — BackendError
  // 'unavailable', `reason` the folder store's refusal, 'unavailable', 'other-library' or 'not-owned';
  // `folder` its id), so a deletion is never left for a folder that comes back (T12). Its own folder or
  // archive is recorded for deletion by the same transaction (_deletingIn) and deleted by name once that
  // commits (applyDeletions). A linked gallery's source is never deleted: it is noted as removed
  // (folders.js removedIn), and its overlay deleted once that note is in removed.json (folders.js
  // publishRemoved). A gallery forgotten (`keep`: its library folder removed from the library) keeps
  // its files. `refuse` false: the library's own clean-up (a transfer that came to nothing), never
  // refused — its folder is deleted once it can be.
  deleteIn(gid, { refuse = true } = {}) {
    const lib = this.library;
    const id = String(gid);
    const row = this._row(id);
    const keep = this.keep.has(id);
    if (row && !keep && refuse) {
      const { root } = this._split(row.path);
      const opened = lib.folders.reach(root, 'write');
      if (opened.status !== 'ok') {
        throw Object.assign(new BackendError('unavailable', `the library folder of gallery ${id} can't be written to now`), { reason: opened.status, folder: root });
      }
    }
    lib._s('DELETE FROM stamps WHERE gid = ?').run(id);
    for (const s of this._stagedOwn(id)) lib._dropStaged(s.file);
    lib._s('DELETE FROM staged_own WHERE gid = ?').run(id);
    const linked = !keep && !!row?.source;
    if (row && !keep && !linked) this._deletingIn(row);
    lib._s('DELETE FROM retiring WHERE gid = ?').run(id);   // those of its folder go with it; the rest stay with what holds them
    if (!row) return;
    lib._s('DELETE FROM files WHERE gid = ?').run(id);
    const { root } = this._split(row.path);
    if (linked) lib.folders.removedIn(root, id, row.path, this.sourceOf(row));
    lib._afterCommit(() => {
      this._forget(row.path);
      if (linked) lib.folders.publishRemoved(root).catch(() => {});
      else if (!keep) this.applyDeletions({ root }).catch(() => {});
    });
  }

  // Inside the caller's transaction: gallery `row`'s own folder or archive (as `files` has it) recorded
  // for deletion (`deleting`) — a folder with the files the index recorded writing there (its records',
  // and those waiting to retire), an archive whole, with its size and modification time as Shiori last
  // wrote it (F6), or as an unpack read it (`unpacked`: { size, mtime, took }, one not in the gallery
  // format, with the entries the unpack took: _unpack) — so the intent outlives a close or a crash (N2).
  _deletingIn(row, unpacked = null) {
    const lib = this.library;
    let named = unpacked ? JSON.stringify({ size: unpacked.size, mtime: unpacked.mtime, unpacked: true, took: unpacked.took })
      : row.zip_size != null ? JSON.stringify({ size: row.zip_size, mtime: row.zip_mtime }) : null;
    if (row.format === 'folder') {
      const files = new Map(this._recorded(row.gid).map(f => [f.name, f]));
      for (const r of lib._s(`SELECT name, size, mtime FROM retiring WHERE dir = ? AND name <> ''`).all(row.path)) files.set(r.name, { name: r.name, size: r.size, mtime: r.mtime });
      named = JSON.stringify([...files.values()]);
    }
    lib._s('INSERT OR REPLACE INTO deleting (dir, gid, files, unfound) VALUES (?, ?, ?, 0)').run(row.path, String(row.gid), named);
  }
  // The files gallery `gid`'s records name in its folder (its pages, what was made from them, its
  // covers), as the index recorded writing them (recordedFiles): [{ name, size, mtime }].
  _recorded(gid) {
    const lib = this.library;
    return [...recordedFiles(lib._pageRows(gid), lib._coverGet(gid))].map(([name, [size, mtime]]) => ({ name, size, mtime: mtime || null }));
  }
  // The galleries' folders and archives waiting to be deleted (`deleting`), of library folder `root`
  // alone when it is given: [{ dir, gid }], `dir` a path as `files` has them — those `unfound` aside,
  // which are looked for where they are (F4), not at their place (a removal is owed them too: folders.js).
  deletingIn(root = null) { return this._deletingRows(root).filter(d => !d.unfound); }
  // The folders and archives of library folder `root` waiting to retire that no gallery has any more
  // (`retiring` rows without one: _retire), as [{ dir }].
  retiringIn(root) { return this.library._s('SELECT DISTINCT dir FROM retiring WHERE gid IS NULL').all().filter(r => this._split(r.dir).root === root); }
  _deletingRows(root = null) {
    return this.library._s('SELECT dir, gid, files, unfound FROM deleting').all().filter(d => root == null || this._split(d.dir).root === root);
  }
  // What waits to be deleted (`deleting`) deleted, one at a time — of library folder `root` alone, when
  // given — each while its library folder may be written to (`work` as folders.js writable): a folder by
  // name (folder-store.js deleteGalleryIn), then — once it holds no file — whole, with the library's own
  // delete (Windows', so an Explorer window showing it steps out); an archive whole while its
  // descriptions name the gallery (_whose: never one describing none, added by hand) and it is as Shiori
  // wrote it (_archiveUnchanged: one the person added to stays, theirs — F6); then its series' folder,
  // once nothing but series.json is left there (_tidy). A row goes once that is done, or once its
  // folder or archive is found another's or no one's (nothing deleted then); one found gone is kept
  // `unfound` until a check of its library folder, or its removal, has ended (F4: deletedFound,
  // forgetUnfound; scan.js finishUnfound); one that
  // can't be done now stays — tried again at the next start, when its folder is shown or taken back, at
  // its folder's next check, and by its removal, which doesn't forget a folder still owed one. Resolves
  // whether none of `root`'s waits.
  applyDeletions({ root = null, work = null } = {}) {
    const run = (this._deletions || Promise.resolve()).then(() => this._applyDeletions(root, work));
    this._deletions = run.catch(() => {});
    return run;
  }
  async _applyDeletions(root, work) {
    for (const d of this._deletingRows(root)) await this._deleteOne(d, d.dir, work);
    return !this.deletingIn(root).length;
  }
  // Deletion `d` (its `deleting` row) done at `rel` (a path as `files` has them: where the row has it, or
  // where a check met a folder or archive naming its gallery — `folder`: whether that is a folder), while
  // that library folder may be written to.
  async _deleteOne(d, rel, work, folder = null) {
    const lib = this.library;
    const at = this._split(rel).root;
    const abs = lib.folders.writable(at, work) && this._at(rel);
    if (!abs) return;
    // A publication or settle of the gallery begun before its deletion lands first: none starts for
    // a gallery that is gone, so its folder isn't written again once it is deleted (S8: a deleted
    // gallery came back from a manifest its publication under way wrote after the deletion).
    await this._describing.get(d.gid)?.catch(() => {});
    await this._placing.get(d.gid)?.catch(() => {});
    const recorded = d.files == null ? null : JSON.parse(d.files);
    // Met at the other kind of place than its row's — the other app unpacked the archive the gallery was
    // in into a folder beside it (D17), or archived its folder — whose files the row never recorded: done
    // there by that place's own manifest alone (gallery-manifest.js galleryDeletion, foreignEntries `met`).
    const met = folder != null && folder !== Array.isArray(recorded);
    const named = met ? null : recorded;
    let done;
    if (met ? !folder : !Array.isArray(named)) {
      // An archive: not there only as the shared rule takes it (_whose: not while its drive is away); one
      // that can't be read now, or told as Shiori left it, tried again (S21).
      const whose = await this._whose(rel, d.gid);
      if (whose.kind === 'missing' || (whose.kind === 'conflict' && whose.found != null)) done = 'missing';
      else if (whose.kind === 'unreadable') done = false;
      else if (whose.kind !== 'ok' || (whose.undescribed && !named?.unpacked)) done = true;
      else {
        const own = await this._archiveUnchanged(abs, named, met);
        done = own == null ? false : own ? await this._discard(abs) : await this._leftBehind(at, d, rel, work);
      }
    } else {
      done = await deleteGalleryIn(abs, d.gid, named).catch(() => false);
      // Left with nothing but empty folders, it goes whole, as Explorer deletes (remove.js); one still
      // holding files Shiori didn't name keeps them, and is left — theirs (_leftBehind). Whether it holds
      // any, and whether it is gone, are told as the shared rule takes "not found" (holdsFile, _delete):
      // with its drive away, nothing is concluded, and the deletion is tried again (review 5 F2).
      if (done === 'left') done = await this._leftBehind(at, d, rel, work);
      else if (done === true) done = await holdsFile(abs).then((held) => held || this._delete(abs), () => false);
    }
    if (done === 'missing') {
      if (!d.unfound) lib._s('UPDATE deleting SET unfound = 1 WHERE dir = ?').run(d.dir);
      return;
    }
    if (!done) return;
    lib._s('DELETE FROM deleting WHERE dir = ?').run(d.dir);
    await this._tidy(path.dirname(abs)).catch(() => {});
  }
  // Deletion `d`, its gallery's folder or archive not where its row has it, done at `rel`, where a check
  // met one naming the gallery (F4; `folder`: whether it is a folder): deleted as it would have been where
  // it was, never adopted.
  deletedFound(d, rel, work, folder) {
    const run = (this._deletions || Promise.resolve()).then(() => this._deleteOne(d, rel, work, folder));
    this._deletions = run.catch(() => {});
    return run;
  }
  // What waited `unfound` in library folder `root`, forgotten once a check that read all of it ended
  // without meeting it — but those it met (`met`: their `dir`s), not deleted yet where it met them.
  forgetUnfound(root, met = new Set()) {
    for (const d of this._deletingRows(root)) if (d.unfound && !met.has(d.dir)) this.library._s('DELETE FROM deleting WHERE dir = ?').run(d.dir);
  }
  // Whether archive `abs` may be deleted whole (F6): as Shiori last wrote it (`recorded`: its size and
  // modification time; none for an archive written before S10), and holding nothing of the person's
  // (_foreignIn) — a file they added stays theirs even once Shiori has added to the archive since; or,
  // one an unpack let go (`recorded.unpacked`), as the unpack read it and holding nothing but what it
  // took (`recorded.took`) — a file the person put in it stays theirs (review 5 F1); `met`, one a folder's
  // deletion met in its place, by its manifest alone (_foreignIn). Null when that can't be told now (a read
  // of it failed: principle 6 — never taken for the person's edit, S21).
  async _archiveUnchanged(abs, recorded, met = false) {
    try {
      if (recorded) {
        const st = await disk.stat(abs);
        if (!format.unchanged(recorded, { size: st.size, mtime: st.mtimeMs })) return false;
      }
      const dir = await this._directory(abs);
      if (recorded?.unpacked) {
        const took = new Set(recorded.took);
        return [...dir.keys()].every(name => took.has(name));
      }
      return !(await this._foreignIn(abs, dir, met)).length;
    } catch { return null; }
  }
  // The entries of archive `file` (its directory `dir`) that aren't Shiori's, by its own manifest
  // (gallery-manifest.js foreignEntries; `met`: one a folder's deletion met in its place): the person's.
  // One whose manifest is damaged holds nothing known to be Shiori's.
  async _foreignIn(file, dir, met = false) {
    const at = dir.get(content.MANIFEST_FILE);
    const read = at ? format.parseManifest(String(await readEntry(file, at)), { archive: true }) : null;
    return read?.kind === 'corrupt' ? [...dir.keys()] : format.foreignEntries(dir, read?.kind === 'ok' ? read.value : null, { met });
  }
  // Whether gallery `gid`'s archive `file` is as Shiori last wrote it, by the size and modification time
  // it noted then (_wroteArchive; one written before S10, with none noted, counts as such).
  _asRecorded(gid, file) {
    const r = this._row(gid);
    if (r?.zip_size == null) return true;
    const st = disk.statSync(file, { throwIfNoEntry: false });
    return !!st && format.unchanged({ size: r.zip_size, mtime: r.zip_mtime }, { size: st.size, mtime: st.mtimeMs });
  }
  // An archive's size and modification time noted as Shiori has just written it (F6; `st`: as read
  // before a rename that put it in place).
  _wroteArchive(gid, file, st = disk.statSync(file)) {
    this.library._s('UPDATE files SET zip_size = ?, zip_mtime = ? WHERE gid = ?').run(st.size, st.mtimeMs, String(gid));
  }
  // What a deletion left in its gallery's folder or archive (`d`, its `deleting` row, or `{ gid: null }`
  // for a folder a retirement left: _retire; `rel`, where it was done, in library folder `root`) — files
  // Shiori didn't make, or changed since it wrote them; an archive the person added to, whole — stays
  // the person's, never joining the library as a gallery of its own: every title a check would find
  // there (an archive: itself) is noted as removed in the folder's removed.json, as it is now (folders.js
  // noteRemovedIn), and the place is reported once on its Needs attention list ('left', an item kept
  // until dismissed). Resolves whether that is done (false: tried again with the deletion or retirement,
  // which a check meanwhile leaves alone).
  async _leftBehind(root, d, rel, work) {
    const lib = this.library;
    const { rest } = this._split(rel);
    try {
      await lib.folders.noteRemovedIn(root, rest, { work });
    } catch { return false; }
    lib.folders.note(root, { reason: 'left', path: rest, gid: d.gid }, { event: true });
    lib._push('control', { type: 'FOLDERS_CHANGED' });
    return true;
  }
  // Inside the transaction forgetting library folder `root`: what waited to be deleted there stays.
  forgetDeletionsIn(root) {
    for (const d of this._deletingRows(root)) this.library._s('DELETE FROM deleting WHERE dir = ?').run(d.dir);
  }

  // Folder or archive `rel` deleted for gallery `gid` (_remove) only when it is the gallery's own by
  // what it holds (_whose): never one another gallery's description names, or none does — a folder put
  // at the gallery's old place by hand, or another library's on a drive given the same letter (F01).
  // A linked gallery's overlay, and a linked gallery's left as the library is cleared.
  async _removeOwn(rel, gid, work = null) {
    const whose = await this._whose(rel, gid);
    if (whose.kind === 'ok' && !whose.undescribed) await this._remove(rel, work);
  }
  // Whose `rel` (a gallery's folder or archive, as the index keeps it) is now, by what it holds
  // (principle 2): a folder as galleryIn says (its manifest or description; an overlay's source.json),
  // an archive by its descriptions (folder-content.js classifyArchive) — one describing no gallery is
  // the one the index keeps there (an archive added by hand, which its first change unpacks; it can
  // only be read; `undescribed`, and never deleted for it), and one its folder's removed.json notes as
  // removed is no gallery's (folders.js noted: the person's, left whole for their files by a deletion or
  // by the other app's unpack — the gallery is where a folder naming it is, scan.js unpackedTo; review 6
  // F7). { kind: 'ok' } when it names gallery `gid`; 'missing' (nothing there, or no gallery's); 'conflict'
  // (`found`: what it names instead, or null); 'unreadable' (it, or its library folder as itself, can't
  // be read now: nothing is concluded). Nothing there is told as the shared rule takes it (statIn: a look
  // that answers "not found" while the drive is away for a moment never makes it so — review 6 F8).
  // Every change to an existing gallery folder or archive asks first. A place not named as an archive is
  // listed as a folder first (galleryIn: its listing tells all a look before it would — a folder there,
  // or nothing there as the same rule takes it); only one found naming no gallery (a file there, say) is
  // looked at as below.
  async _whose(rel, gid) {
    const abs = this._at(rel);
    if (!abs) return contract.unreadable('its library folder can\'t be reached as itself');
    if (!/\.(cbz|zip)$/i.test(rel)) {
      const whose = await galleryIn(abs, String(gid));
      if (whose.kind !== 'conflict' || whose.found != null) return whose;
    }
    let stat;
    try { stat = await statIn(abs); } catch (e) { return contract.unreadable(e); }
    if (!stat) return contract.MISSING;
    if (stat.isDirectory()) return galleryIn(abs, String(gid));
    try {
      const dir = await this._directory(abs);
      const texts = {};
      for (const name of content.OWN_FILES) if (dir.has(name)) texts[name] = (await readEntry(abs, dir.get(name))).toString('utf8');
      const what = content.classifyArchive([...dir.keys()], texts);
      if (what.kind !== 'gallery') return { kind: 'ok', undescribed: true };
      if (what.id !== String(gid)) return { kind: 'conflict', found: what.id };
      const { root, rest } = this._split(rel);
      return await this.library.folders.noted(root, rest) ? contract.MISSING : { kind: 'ok' };
    } catch (e) { return contract.unreadable(e); }
  }

  // Inside the transaction clearing the library (library.js clearAll), before its pages and covers go:
  // every gallery's own folder or archive recorded for deletion, as a deletion does (_deletingIn), and
  // deleted by name once that commits; a linked gallery's overlay deleted (its source joins again at
  // the folder's next check).
  clearIn() {
    const lib = this.library;
    const rows = lib._s('SELECT * FROM files').all();
    for (const r of rows) if (!r.source) this._deletingIn(r);
    for (const table of ['files', 'staged_own', 'retiring']) lib._s(`DELETE FROM ${table}`).run();
    lib._afterCommit(() => {
      for (const r of rows) {
        this._forget(r.path);
        if (r.source) this._removeOwn(r.path, r.gid).catch(() => {});
      }
      this.applyDeletions().catch(() => {});
    });
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

  // A folder or file deleted outright — never one reached through a link, or holding one (folder-store.js
  // containedWhole: the library's `remove` may be Windows' own file operation). Resolves whether it is
  // gone, as the shared rule takes it (folder-store.js gone: not while its drive is away).
  async _delete(file) {
    try { containedWhole(file); await this.library.remove(file); } catch {}
    return gone(file);
  }

  // A series' folder left with nothing but its series.json (its members moved out or deleted):
  // deleted too, while that series.json is Shiori's, told by its content as a gallery's descriptions
  // are (folder-content.js seriesOf; gallery-manifest.js isOwnDescription). One that isn't — the
  // person's — stays with the folder, which is reported once on its library folder's Needs attention
  // list ('left', review 4 F4's rule); one that can't be read just stays. So does a folder holding no
  // series.json — empty, or with Windows' own files alone: nothing proves it a series' (a folder the
  // person made, a gallery's moved into it by hand: review 6 F11) — and one holding a temporary a kill left
  // (a member's copy beside its place: nothing proves it Shiori's, review 5 O3). The library folder itself
  // never is deleted.
  async _tidy(dir) {
    const lib = this.library;
    const root = lib.folders.ids().find(id => { const r = path.relative(lib.folders.path(id), dir); return r && !r.startsWith('..') && !path.isAbsolute(r); });
    if (root == null) return;
    const spare = (name) => ['series.json', 'desktop.ini', 'thumbs.db'].includes(name.toLowerCase());
    let text;
    try {
      const left = (await entriesIn(dir))?.map(e => e.name);
      const series = left?.find(name => name.toLowerCase() === 'series.json');
      if (!series || !left.every(spare)) return;
      text = await textIn(path.join(dir, series));
    } catch { return; }
    if (text == null) return;
    if (!content.seriesOf(text)) {
      lib.folders.note(root, { reason: 'left', path: path.relative(lib.folders.path(root), dir).split(path.sep).join('/') }, { event: true });
      lib._push('control', { type: 'FOLDERS_CHANGED' });
      return;
    }
    await this._delete(dir);
  }

  _forget(rel) { this._dirs.delete(this._key(rel)); }

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
    const at = this._at(row.path);
    const names = !at ? []
      : row.format === 'folder' ? await filesIn(at).catch(() => [])
      : [...(await this._directory(at).catch(() => new Map())).keys()];
    return [...new Set([...names, ...this._stagedOwn(gid).map(s => s.rel)])].filter(n => derived.test(n) && !n.endsWith('.json'));
  }

  async hasOriginal(gid, orig) {
    const row = this._row(gid);
    if (row && !this._at(row.path)) return false;   // its library folder can't be reached as itself
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

  // Whether gallery `row`'s pictures may be read from its folder or archive now (_whose, principle 2):
  // not while it names another gallery — a folder swapped by hand for another gallery's never serves that
  // gallery's pictures as this one's, which the library folder's identity alone (folders.js reach) doesn't
  // tell — nor while what it holds can't be read. One naming no gallery (an earlier version's, not
  // described yet) is read as the index says. Found so, taken as it is for NAMED_TTL (a page read costs a
  // Map lookup; the first read after, one small file read) and until a disk call in a library folder
  // fails (folder-store.js ioFailures), as a library folder's identity is for reads.
  async _namesIt(row) {
    const key = `${row.path}\0${row.gid}`;
    const hit = this._named.get(key);
    if (hit && hit.failures === ioFailures() && Date.now() - hit.at < NAMED_TTL) return true;
    const whose = await this._whose(row.path, row.gid);
    if (whose.kind === 'unreadable' || (whose.kind === 'conflict' && whose.found != null)) { this._named.delete(key); return false; }
    // Not there: the read finds nothing there itself (files.js _seen) — unless a move within its drive
    // is recorded, which is finished first when it can be told (finishMoves), the read then going where
    // the gallery is: one whose rename back couldn't be made, its drive gone just after the rename (S18,
    // the sweeps' drive away), is so found as soon as the drive is back.
    if (whose.kind === 'missing') { if (row.moving) await this.finishMoves(); return true; }
    this._named.set(key, { at: Date.now(), failures: ioFailures() });
    if (this._named.size > 4096) this._named.delete(this._named.keys().next().value);
    return true;
  }

  // Entry `entry` of gallery `row`'s folder or archive, as bytes — only while it names the gallery
  // (_namesIt, asked once the read counts as under way: nothing deletes what it reads meanwhile): else
  // null, as for a file that isn't there. A gallery moved while its folder was asked (a rename takes
  // what the folder holds along) is read where it is now.
  async _read(row, entry) {
    const file = this._abs(row.path);
    this._reading.set(file, (this._reading.get(file) || 0) + 1);
    try {
      if (!(await this._namesIt(row))) return null;
      const now = this._row(row.gid);
      if (now && now.path !== row.path) return await this._read(now, entry);
      if (row.format === 'folder') return await disk.readFile(path.join(file, entry));
      const found = (await this._directory(file)).get(entry);
      return found ? await readEntry(file, found) : null;
    } finally {
      const left = this._reading.get(file) - 1;
      if (left) this._reading.set(file, left); else this._reading.delete(file);
    }
  }

  // What a read says about the gallery's files: one that read is there (no longer missing); one
  // that didn't is missing when its folder or archive is found not there, as the shared rule takes it
  // (folder-store.js gone) — not when only a page is,
  // nor when its library folder can't be reached as itself or the folder can't be looked at (principle
  // 6: only what is found not there changes what the index has). Only a change is written.
  async _seen(row, readable) {
    if (readable ? row.state !== 'missing' : row.state === 'missing') return;
    if (!readable) {
      if (!this._at(row.path) || !await gone(row.source ? this._sourceAbs(row) : this._abs(row.path))) return;
    }
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
    // What is under way ends first, a failure (tried again later) as well as a success.
    await Promise.all([...this._placing.values()].map(p => p.catch(() => {})));
    for (const id of ids) await this.place(id).catch(() => {});
    for (const t of this._describeTimers.values()) clearTimeout(t);
    this._describeTimers.clear();
    await Promise.all([...this._describing.values()].map(p => p.catch(() => {})));
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
  // added to; one added by hand isn't. Null when its directory can't be read now (principle 6: never
  // taken for one outside the format, whose unpack records only what it took — S21).
  async _inFormat(row) {
    const dir = await this._directory(this._abs(row.path)).catch(() => null);
    return dir ? dir.has('metadata.json') || dir.has('image_records.json') : null;
  }

  // One settle of gallery `gid`. Resolves true when done (or nothing was needed, or its library folder
  // can't be written to now: what waits stays staged until it can), false when its archive's pages
  // changed while it was being unpacked.
  async _place(gid, work = null) {
    const lib = this.library;
    if (!lib.folders.writable(this.rootFor(gid), work)) return true;
    let row = this._row(gid);
    if (row) {
      // A gallery whose folder or archive is gone (moved outside the app, or its drive away), or no
      // longer names it (principle 2: put there by hand — reported), waits, its new pages staged, until
      // it reads again or the full check finds it — rather than starting a new folder in its old place,
      // or writing into someone else's.
      const whose = await this._whose(row.path, gid);
      if (whose.kind === 'conflict') this._conflict(row);
      if (whose.kind === 'ok' || whose.kind === 'missing') await this._seen(row, whose.kind === 'ok');
      if (whose.kind !== 'ok') return true;
      row = this._row(gid);
      if (!row) return true;   // deleted meanwhile
      if (!await this._writesIn(row)) return true;
      if (row.format !== 'folder' && (row.unpack || this._staged(gid).length || this._stagedOwn(gid).length)) {
        const inFormat = await this._inFormat(row);
        if (inFormat == null) return true;   // its archive can't be read now: what waits stays staged, tried again
        const how = inFormat ? await this._settleArchive(gid, row) : 'unpack';
        if (how === 'unpack' && !await this._unpack(gid, row, !inFormat || !!whose.undescribed)) return false;
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
  // is: the manifest names the gallery now. Only while its library folder may be written to. A picture's
  // rename and its row's change are one synchronous step, no file call between them (the size and time
  // its row takes are the picture's before the rename, which keeps them): a failed call or a kill never
  // parts them. One parted all the same (a kill just as the rename returns) picks up where it stopped at
  // the next start — the conversion is noted under way (`converting`) before its first rename — or check:
  // a picture no longer at its old place (as the shared rule takes it) whose name in images/ holds a file
  // of the size its row records has only its row brought up to date, as _moveIn does (review 6 F12).
  async toFormat(gid) {
    const lib = this.library, id = String(gid);
    const row = this._row(id);
    if (!this._legacy(id) || !lib.folders.writable(this.rootFor(id))) return false;
    if ((await this._whose(row.path, id)).kind !== 'ok') return false;   // its folder doesn't name it now (principle 2)
    const dir = this._abs(row.path);
    lib._s('UPDATE files SET converting = 1 WHERE gid = ?').run(id);
    await disk.mkdir(path.join(dir, 'images'), { recursive: true });
    for (const r of lib._pageRows(id)) {
      const orig = parse(r.orig);
      if (orig.at !== 'p' || orig.entry.includes('/')) continue;
      const from = path.join(dir, orig.entry), was = await statIn(from), there = !!was?.isFile();
      const name = this._nameFor(id, r, orig, dir, there);
      const to = path.join(dir, ...name.split('/'));
      const st = !there ? disk.statSync(to) : moveSync(from, to) ? disk.statSync(to) : was;   // copied across drives: as it is now
      if (!there && st.size !== orig.size) throw Object.assign(new Error(`page ${r.n} of gallery ${id} is at neither of its places`), { reason: 'unreadable' });
      lib._tx(() => {
        lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify({ ...orig, entry: name, size: st.size, mtime: st.mtimeMs }), id, r.n);
        this._pend(id);
      });
    }
    lib._s('UPDATE files SET converting = 0 WHERE gid = ?').run(id);
    return (await this.describe(id)).ok;
  }

  // Staged page `r` moved into the gallery's folder `dir`: in one synchronous step,
  // so no other operation sees the file in one place and its row naming the other — renamed into
  // images/ under a name no file has (_nameFor) and its row pointed at it, with the size and
  // modification time it has there. A page replaced or removed meanwhile is left alone (its staged
  // file goes with its row). One already renamed before an interruption only has its row brought up to
  // date.
  async _moveIn(gid, dir, r) {
    const lib = this.library;
    const orig = parse(r.orig);
    const from = lib._staged(orig.file);
    const there = await present(from);
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
      const there = await present(from);
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
    this._moving(gid, rel);
    try { disk.renameSync(from, to); } catch (e) {
      // Windows won't move a folder while something shows or uses a folder inside it (an Explorer
      // window): it stays where it is until then, tried again a little later — and a series' folder
      // made for it goes again at once, so no other member takes it for one already there.
      this._moving(gid, null);
      if (made) try { disk.rmdirSync(made); } catch {}
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      this._regroupWanted.add(gid);
      this._retryRegroup(gid);
      return;
    }
    lib._tx(() => {
      this._renamedIn(row, rel);
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
  // archive's place in one synchronous step, which records the archive for deletion (deleted as a
  // deletion does once that commits, or at the next start: F10). One not in the gallery format, or
  // describing no gallery (`byHand`: added by hand, or an earlier version's shiori.json), whose entries a
  // deletion's rules wouldn't take for Shiori's, is recorded with its size and modification time as the
  // unpack began reading it and the entries it took — those it copied out, and what an earlier version
  // put there beside them (_earlierOwn) — and deleted whole while it is still so and holds nothing else
  // (S16); one holding anything else, a file the person put in it, is left and reported (review 5 F1).
  // Its descriptions are written afresh. Resolves false when its pages changed meanwhile (tried again once
  // they settle).
  async _unpack(gid, row, byHand = false) {
    const lib = this.library;
    const archived = () => lib._pageRows(gid).filter(r => parse(r.orig).at === 'p').sort((a, b) => a.n - b.n);
    const before = archived();
    const signature = JSON.stringify(before.map(r => [r.n, r.orig]));
    const read = byHand ? await disk.stat(this._abs(row.path)) : null;
    const rel = this._freePath(String(row.path).replace(/\.(cbz|zip)$/i, ''));
    const target = this._abs(rel);
    const temp = tempBeside(target);
    this._reserved.add(rel);
    try {
      const token = this._reserveAt(temp, gid);   // the gallery's from its first moment (principle 2)
      await disk.mkdir(path.join(temp, 'images'), { recursive: true });
      const out = [];
      const took = [];   // the archive's entries copied out
      for (const r of before) {
        const orig = parse(r.orig);
        const data = await this._read(row, orig.entry);
        if (!data) throw new Error(`page ${r.n} can't be read from ${row.path}`);
        const ext = layout.originalExt(orig.type || TYPE_OF_EXT[extOfName(orig.entry)], orig.entry);
        const entry = layout.layoutPath.original(r.n, ext);
        await disk.writeFile(path.join(temp, ...entry.split('/')), data);
        lib.writes.add('pages', data.length);
        out.push({ n: r.n, orig: { at: 'p', entry, size: data.length, type: orig.type || TYPE_OF_EXT[ext] || '' } });
        took.push(orig.entry);
      }
      const own = ownFiles(lib._coverGet(gid), ownFiles(before.map(r => parse(r.record))));
      const staged = new Set(this._stagedOwn(gid).map(s => s.rel));   // moved in after, as they are
      // A picture its records name that the archive doesn't hold is passed over; one it holds that can't
      // be read now fails the unpack, tried again — never left behind in an archive about to go (S21).
      const entries = await this._directory(this._abs(row.path));
      for (const rel of own.keys()) {
        if (staged.has(rel) || !entries.has(rel)) continue;
        const data = await this._read(row, rel);
        if (!data) throw new Error(`${rel} can't be read from ${row.path}`);
        await disk.mkdir(path.dirname(path.join(temp, ...rel.split('/'))), { recursive: true });
        await disk.writeFile(path.join(temp, ...rel.split('/')), data);
        lib.writes.add('pictures', data.length);
        took.push(rel);
      }
      if (byHand) took.push(...await this._earlierOwn(row, gid, entries));
      // One synchronous step from here.
      if (JSON.stringify(archived().map(r => [r.n, r.orig])) !== signature || this._row(gid)?.path !== row.path) {
        await disk.rm(temp, { recursive: true, force: true });
        return false;
      }
      disk.renameSync(temp, target);
      // Recorded as it now is on disk, whether or not the gallery is still in the library.
      lib.asFolderWork(this.rootFor(gid), () => lib._tx(() => {
        this._deletingIn(this._row(gid), read && { size: read.size, mtime: read.mtimeMs, took });
        for (const p of out) lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify(p.orig), gid, p.n);
        lib._s(`UPDATE files SET path = ?, format = 'folder', pending = 1, unpack = 0, used_at = ? WHERE gid = ?`).run(rel, Date.now(), gid);
        lib._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(String(gid), token);
        lib._logIn(gid);
      }));
      lib.publishFeed(gid);
      this._forget(row.path);
      this.applyDeletions({ root: this._split(row.path).root }).catch(() => {});
      return true;
    } catch (e) {
      await disk.rm(temp, { recursive: true, force: true }).catch(() => {});
      throw e;
    } finally {
      this._reserved.delete(rel);
    }
  }
  // What an earlier desktop version put in archive `row` beside the pages, while its shiori.json names
  // gallery `gid` (gallery-manifest.js isOwnDescription): that shiori.json, the pictures it lists and
  // ComicInfo.xml, written with them — Shiori's own, which may go with the archive once it is unpacked.
  // None for an archive (its entries `entries`) describing no gallery; one whose shiori.json can't be read
  // now fails the unpack, tried again (S21: taken for none, the archive was left beside the gallery's
  // folder for good).
  async _earlierOwn(row, gid, entries) {
    if (!entries.has('shiori.json')) return [];
    const data = await this._read(row, 'shiori.json');
    if (!data) throw new Error(`shiori.json can't be read from ${row.path}`);
    const text = String(data);
    if (!await format.isOwnDescription('shiori.json', text, String(gid), '')) return [];
    const { pages } = JSON.parse(text);
    return ['shiori.json', 'ComicInfo.xml', ...(Array.isArray(pages) ? pages.map(p => p?.file).filter(f => typeof f === 'string') : [])];
  }

  // An archive whose pages are now in a folder — or whose gallery is deleted — deleted once nothing
  // reads it (or after a few seconds' wait for that), so a converted gallery doesn't take its space
  // twice. Resolves whether it is gone.
  async _discard(file) {
    for (let i = 0; i < 3 && this._reading.get(file); i++) await new Promise(r => setTimeout(r, 1000));
    return this._delete(file);
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
    const sourceOf = (rec) => (rec.blob.at === 'x' ? provenance(rec.blob) : null);
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
    const rows = lib._pageRows(gid), cover = lib._coverGet(gid);
    const known = recordedFiles(rows, cover);   // path → [size, mtime]: as the index recorded them
    const records = rows.map((r) => {
      const rec = lib._rowRecord(r), orig = parse(r.orig), name = placing?.get(r.n);
      return { ...rec, blob: name ? { at: 'p', entry: name, size: orig.size } : orig };
    });
    const files = format.slotFiles({ records, covers: { gallery: cover?.cover, series: cover?.seriesCover } },
      (src) => src.$own ?? (src.at === 'p' ? src.entry : null));
    const sources = Object.fromEntries(records.filter(r => r.blob.at === 'x').map(r => [String(r.pageNum), provenance(r.blob)]));
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
    if (found.kind === 'conflict') this._conflict(row);
    if (found.kind !== 'ok') return null;
    const had = lib._s('SELECT stamp FROM stamps WHERE gid = ?').get(String(gid))?.stamp;
    if (!row.pending && had && (await found.dir.manifest()).kind === 'ok') return had;
    if (!this._row(gid)) return null;   // deleted meanwhile: its deletion, waiting for this, takes the folder
    const { next, texts } = this._generation(gid);
    const { manifest, bytes, changedBoth } = await found.dir.publish({ manifest: next, descriptions: texts, known: had ?? null });
    lib.writes.add('descriptions', bytes);
    // Another app published it since this library last did or read it: this app's change won (D4).
    if (changedBoth) lib.folders.note(root, { reason: 'changed-both', path: rest, gid }, { event: true });
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
    this._wroteArchive(gid, file);
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
  // they move in by renaming, so it writes least); with none, it is rewritten as a fresh archive — never
  // one holding the person's files (_foreignIn: F6), which keep their place in its directory, nor one
  // changed since Shiori last wrote it (_asRecorded: S14), which is added to as it is.
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
      const foreign = new Set(await this._foreignIn(file, dir).catch(() => [...dir.keys()]));
      const drop = [...dir.keys()].filter(name => !live.has(name) && !foreign.has(name));
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
      if (!foreign.size && (after - used) / after > UNUSED_AT_MOST) {
        if (placing.size || stagedOwn.length) return 'unpack';
        if (this._asRecorded(gid, file)) {
          await this._compact(gid, row, live, dir);
          finish();
          return 'done';
        }
      }
      lib._s('UPDATE files SET tail = ? WHERE gid = ?').run(size, gid);
      lib.writes.addArchive(await appendZip(file, add, { drop }));
      this._wroteArchive(gid, file);
      this._dirs.delete(file);
      finish();
      lib.publishFeed(gid);
      return 'done';
    });
  }

  // An archive with too much of it unused and nothing waiting in staging, written whole once as a
  // fresh archive of what it holds (`live`, as _settleArchive lists it), which takes its place — unless
  // it changed while that was written (the person's edit is never replaced: S14), when it rejects.
  async _compact(gid, row, live, dir) {
    const lib = this.library;
    const file = this._abs(row.path), temp = `${file}.shiori-tmp`;
    const entries = [...live].map(([name, v]) => (v.data ? { name, data: v.data } : { name, read: () => readEntry(file, dir.get(name)) }));
    try {
      lib.writes.addArchive(await writeZip(temp, entries));
      if ((await readDirectory(temp)).size !== entries.length) throw new Error('the archive did not read back');
      for (let i = 0; i < 3 && this._reading.get(file); i++) await new Promise(r => setTimeout(r, 1000));
      // One synchronous step from here: its size and time, which the rename keeps, recorded as soon as it
      // is in place, with no file call between that a kill could stop in.
      const st = disk.statSync(temp);
      if (this._row(gid)?.path !== row.path || !this._asRecorded(gid, file)) throw new Error('moved or changed meanwhile');
      disk.renameSync(temp, file);
      this._wroteArchive(gid, file, st);
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
      // The settle a settle that joined this one set going again isn't wanted: this one has just settled
      // the gallery, and the move would only find it busy again (each attempt the same).
      clearTimeout(this._timers.get(id));
      this._timers.delete(id);
      await this._describing.get(id)?.catch(() => {});   // descriptions being written land first
      const row = this._row(id);
      if (!row) {
        if (!lib._s('SELECT 1 FROM places WHERE gid = ?').get(id)) return false;
        lib._tx(() => { lib._logIn(id); lib._s('UPDATE places SET root = ? WHERE gid = ?').run(root, id); });
        return true;
      }
      const from = this._abs(row.path);
      const whose = row.state === 'missing' ? contract.MISSING : await this._whose(row.path, id);
      if (whose.kind === 'conflict') throw this._conflict(row);
      if (whose.kind !== 'ok') throw new BackendError('unavailable', `the files of gallery ${id} can't be found`);
      const ext = row.format === 'folder' ? '' : `.${row.format}`;
      const owner = this._ownerOf(id);
      const rel = row.source ? this._freePath(this._join(root, layout.galleryName(lib._metaGet(id) || { galleryId: id }))) : owner
        ? this._freePath(`${this._seriesFolder(owner, root) || this._freePath(this._join(root, layout.seriesName(owner)))}/${this._memberName(owner, id)}`, ext)
        : this._freePath(this._join(root, path.posix.basename(this._split(row.path).rest).replace(/\.(cbz|zip)$/i, '')), ext);
      const to = this._abs(rel), temp = tempBeside(to);
      const linkedPlaced = new Map();   // page → where a linked gallery's page from its source is now
      let token = null;                 // a linked gallery's copy: the generation its reservation published
      const signature = () => JSON.stringify([this._row(id), lib._pageRows(id).map(r => [r.n, r.orig, r.record]),
        lib._s('SELECT record FROM covers WHERE gid = ?').get(id)?.record ?? null, this._stagedOwn(id)]);
      const before = signature();
      // Its row switched over to `rel` in the library's transaction, and only into a folder that can
      // still take it (shown, held and reachable — not one hidden, removed or taken over meanwhile:
      // F02) — its place with it (library.js _placesIn). What it leaves is let go by the same step: a
      // copy's old folder or archive recorded for deletion (_deletingIn), a linked gallery's source
      // noted as removed where it was (folders.js removedIn). Throws when it is refused.
      const switchOver = (renamed = false) => lib._tx(() => {
        lib.folders.assertMoveTo(root);
        lib._logIn(id);
        if (renamed) return this._renamedIn(row, rel);
        if (!row.source) this._deletingIn(row);
        lib._s('UPDATE files SET path = ?, source = NULL WHERE gid = ?').run(rel, id);
        lib._s('DELETE FROM retiring WHERE dir = ? AND gid IS NULL').run(rel);   // the copy, recorded as it was renamed there
        if (token) lib._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(id, token);
        for (const [n, orig] of linkedPlaced) lib._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify(orig), id, n);
        if (row.source) lib.folders.removedIn(leaving, id, row.path, this.sourceOf(row));
        this._pend(id);
        this._pendOwner(id);
      });
      this._reserved.add(rel);
      // The library's own gallery is moved by renaming its folder or archive there (D25): no picture
      // written again. Renamed and switched over in one synchronous step — while nothing else writes
      // to its archive (_exclusive), and only when nothing changed, is being settled or described
      // since it was looked at — then renamed back should the switch be refused. The rename is
      // recorded first (`moving`): one the app stops in is finished at the next start (F8), as is one
      // whose rename back can't be made (its drive gone meanwhile), or as soon as a read of the gallery
      // can tell (finishMoves). A rename the disk won't do (another drive; Windows holding a file in it
      // for a moment) leaves it to the copy.
      let renamed = 'copy';
      if (!row.source) {
        try {
          await disk.mkdir(path.dirname(to), { recursive: true });
          renamed = await this._exclusive(id, () => {
            if (signature() !== before || this._placing.has(id) || this._describing.has(id)) return 'changed';
            this._moving(id, rel);
            try { disk.renameSync(from, to); } catch (e) {
              this._moving(id, null);
              if (['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) return 'copy';
              throw e;
            }
            try { switchOver(true); } catch (e) { disk.renameSync(to, from); this._moving(id, null); throw e; }
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
        // Not what a write under way holds aside, nor its files waiting to retire (its descriptions are
        // published again in its new place).
        const retiring = new Set(lib._s('SELECT name FROM retiring WHERE dir = ?').all(row.path).map(r => path.join(from, ...r.name.split('/'))));
        // A linked gallery's copy is a folder of the library's own: reserved — so it names the gallery
        // from its first moment (principle 2) — then given its overlay's pictures alone (its
        // descriptions are published afresh, from the index, in the copy's own .shiori/: D7).
        // Each file keeps its modification time (Windows' copy does so itself), so the size and time the
        // gallery's records keep of it still name it there (principle 4): a file let go later is deleted.
        const taken = (src) => !src.endsWith('.shiori-tmp') && !retiring.has(src);
        const copy = { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true };
        if (row.source) {
          token = this._reserveAt(temp, id);
          for (const d of format.PICTURE_DIRS) {
            const at = path.join(from, ...d.split('/')), into = path.join(temp, ...d.split('/'));
            if (!(await statIn(at))) continue;   // none there, as the shared rule takes it; a look that fails fails the move
            await disk.mkdir(path.dirname(into), { recursive: true });
            await disk.cp(at, into, { ...copy, filter: (src) => src === at || (taken(src) && format.isPictureName(src)) });
          }
        } else if (row.format === 'folder') await disk.cp(from, temp, { ...copy, filter: taken });
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
        const copied = await asWritten(temp);
        // One synchronous step from here: renamed into place and switched over only when nothing changed
        // while it was copied — the copy recorded first, each file as written, to retire (_retire) should
        // the app stop before the switch (F8) — and deleted again should the switch be refused, the
        // gallery left where it was.
        if (signature() !== before) { await disk.rm(temp, { recursive: true, force: true }); continue; }
        lib._tx(() => { for (const f of copied) this._retireIn(rel, f.name, f, null); });
        disk.renameSync(temp, to);
      } catch (e) {
        lib._s('DELETE FROM retiring WHERE dir = ? AND gid IS NULL').run(rel);   // it never took its place
        await disk.rm(temp, { recursive: true, force: true }).catch(() => {});
        throw e;
      } finally {
        this._reserved.delete(rel);
      }
      try {
        switchOver();
      } catch (e) {
        await disk.rm(to, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      this._forget(row.path);
      await (row.source ? lib.folders.publishRemoved(leaving, { work }) : this.applyDeletions({ root: leaving, work })).catch(() => {});
      this.scheduleDescribe(id, 0);
      return true;
    }
    throw new BackendError('conflict', `gallery ${id} kept changing while it was being moved`);
  }

  // ── Places ──
  // A folder (or, with `ext`, an archive) no gallery has, nothing is being written to (`_reserved`: a
  // write making it whole beside it, tempBeside) and nothing on disk holds: `base`, or `base (2)`,
  // `base (3)`… A temporary a kill left beside it takes no name (review 4 O2).
  _freePath(base, ext = '') {
    const lib = this.library;
    for (let i = 1; ; i++) {
      const rel = `${base}${i > 1 ? ` (${i})` : ''}${ext}`;
      const taken = this._reserved.has(rel) || lib._s('SELECT 1 FROM files WHERE path = ?').get(rel)
        || lib._s('SELECT 1 FROM retiring WHERE dir = ?').get(rel) || disk.existsSync(this._abs(rel));
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
  // meanwhile — put in the folder's place. The folder retires: each file of it Shiori wrote, named as
  // it is now (what an archiving let go is deleted by name, never whatever holds its path later: T03),
  // and the archive is named there too until the gallery has it (an archiving cut short leaves it to
  // delete).
  // Resolves whether it was archived.
  async archive(gid) {
    const id = String(gid);
    const lib = this.library;
    const row = this._row(id);
    if (!this._idle(id, row) || !lib.folders.writable(this.rootFor(id))) return false;
    if ((await this._whose(row.path, id)).kind !== 'ok') return false;   // its folder doesn't name it now (principle 2)
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
    const file = this._abs(rel), temp = tempBeside(file);
    this._reserved.add(rel);
    try {
      lib.writes.addArchive(await writeZip(temp, entries));
      const written = await readDirectory(temp);
      const sizeOf = (e) => e.data?.length ?? disk.statSync(e.from).size;
      if (written.size !== entries.length || entries.some(e => written.get(e.name)?.size !== sizeOf(e))) throw new Error('the archive did not read back');
      // What the folder lets go: what its deletion would take, each while it is as Shiori wrote it
      // (ownedIn), and Windows' own files at its top (O3) — never a file the person put there, before or
      // while the archive was written (review 4 F4), which stays, and is reported (_retire).
      const leaving = await ownedIn(dir, id, this._recorded(id));
      for (const name of (await disk.readdir(dir)).filter(n => WINDOWS_FILES.has(n.toLowerCase()))) {
        const st = disk.statSync(path.join(dir, name), { throwIfNoEntry: false });
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
        lib._s('UPDATE files SET path = ?, format = ?, zip_size = ?, zip_mtime = ? WHERE gid = ?').run(rel, archiveFormat, st.size, st.mtimeMs, id);
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
      // rows kept until it has; one still holding files Shiori didn't name, or changed since it wrote
      // them, keeps them, and is left: the person's, never joining the library as a gallery of its own,
      // and reported once on its Needs attention list ('left', review 4 F4), as a deletion leaves one
      // (_leftBehind: review 5 F3) — its rows kept until that is done.
      const held = await filesIn(abs).catch(() => [null]);
      if (!held.length && !await this._delete(abs)) continue;
      const left = held.length && held[0] !== null && !kept.some(k => k.why === 'unreadable');
      if (left && !await this._leftBehind(this._split(rel).root, { gid: null }, rel, work)) continue;
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
    if ((await this._whose(row.path, gid)).kind !== 'ok') return;   // its folder doesn't name it now: they wait
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

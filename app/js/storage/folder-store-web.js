// folder-store-web.js — the website's folder store adapter (the plan's §3.2; contract.js): the one door
// between the browser library and the folders the person picked for it (the File System Access API).
// Each gallery is a folder of its own inside one of them, in the gallery format (gallery-files.js).
// db.js and folder-library.js keep the records and decide what goes where; this module reads, writes
// and deletes files, given a folder's handle, and keeps writers in different tabs and the service
// worker apart (withLock; reserveDir, a gallery's own folder; writeNew, a name no file has). Nothing
// here asks the person anything unless asked to (`permission(handle, { ask: true })`, from a click).
// No module but this one calls a file or folder handle's methods on a library folder
// (architecture-fitness.test.mjs).
//
// A folder is reached through its handle; the folders inside it are looked up once and remembered
// (by the folder's id and their path), and forgotten when one turns out to be gone. Reads are typed
// (principle 6): a file that isn't there is told apart from one that can't be read, which is thrown
// (through the contract: 'unreadable') and never taken for one that isn't there. The bytes written
// are counted by what they hold (written(): the conformance suite checks them against the write
// budget, plan D23).
//
// Which folder a handle reaches is told by its library.json alone (identityOf, principle 1): the
// library asks before it reads, checks or writes one (db.js _access). A gallery's folder in format v2
// (gallery-manifest.js has the rules): galleryIn (whose it is: principle 2), reserveDir (the only way a
// folder becomes a gallery's), writeNew (a name no file has, never making the gallery's folder again),
// publishIn (a generation committed by one manifest written whole), deleteNamedIn (only files still as
// Shiori recorded writing them), deleteGalleryIn (a gallery's folder deleted by name), loadGallery (a
// folder read back by its manifest, or by v1's rules).
//
// folderStore(gate) is the contract over these: open(ref, { purpose }) weighs the folder as the
// library's gate has it (its handle, its state, this page's permission, whether the handle reaches it,
// whether this library holds its claim) and hands out a Root, whose galleries and reservations work as
// the library does.
import { refused, MISSING, unreadable, surelyMissing } from './contract.js';
import { MANIFEST_FILE, OWN_FILES, LIBRARY_FILE, SWAP_FILE, galleryAt, libraryIdOf } from './folder-content.js';
import { refusalFor } from './folder-lifecycle.js';
import { SOURCE_FILE, parseSource } from './linked-source.js';
import { PICTURE_DIRS, isPictureName, areaOf, manifestPath, storedHash, parseManifest, publication, firstGeneration, tokenOf, whoseVersion, sizesOf,
  matches, unchanged, readGallery, galleryDeletion, isOwnDescription } from './gallery-manifest.js';

/** @typedef {import('./contract.js').ReadResult<Uint8Array>} ReadBytes */
/** @typedef {import('./contract.js').ListResult} ListResult */
/** @typedef {import('./contract.js').GalleryDir} GalleryDir */
/** @typedef {import('./contract.js').WriteRoot} WriteRoot */
/** @typedef {import('./contract.js').Purpose} Purpose */
/** A folder the person picked, as File System Access hands it out, with the permission methods
 * Chromium adds to it.
 * @typedef {FileSystemDirectoryHandle & {
 *   queryPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>,
 *   requestPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>,
 * }} Folder */
/** An entry of a folder listed: `file()` resolves a file's File as it is now (NotFoundError once gone).
 * @typedef {{ name: string, kind: FileSystemHandleKind, file: () => Promise<File> }} Listed */

/** The name of a DOMException (or any error), for telling them apart.
 * @param {unknown} e @returns {string | undefined} */
const _nameOf = (e) => /** @type {{ name?: string } | null | undefined} */ (e)?.name;

/** @type {Map<string, Promise<FileSystemDirectoryHandle>>} `${folderId}\0${path}` → the folder there */
const _dirs = new Map();

/** Whether this browser can keep a library in a folder at all. @returns {boolean} */
export const supported = () => typeof (/** @type {any} */ (globalThis)).showDirectoryPicker === 'function';

/** What this page may do with the folder: 'granted', 'prompt' (one click lets it), 'denied', or
 * 'unavailable' (no such folder any more, or a handle this browser can't use). `ask` asks the person
 * when it would otherwise be 'prompt' — only from a click. `look` false: as the browser says it, nothing read — a
 * folder whose drive is away still says 'granted' (S42 B: told without a call on its drive).
 * @param {Folder | null | undefined} handle @param {{ ask?: boolean, look?: boolean }} [options]
 * @returns {Promise<PermissionState | 'unavailable'>} */
export async function permission(handle, { ask = false, look = true } = {}) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'unavailable';
  try {
    let state = await handle.queryPermission({ mode: 'readwrite' });
    if (state === 'prompt' && ask && typeof handle.requestPermission === 'function') state = await handle.requestPermission({ mode: 'readwrite' });
    if (state !== 'granted' || !look) return state;
    await handle.keys().next();   // still there (a drive taken away answers NotFoundError)
    return 'granted';
  } catch (e) {
    return _nameOf(e) === 'NotAllowedError' || _nameOf(e) === 'SecurityError' ? 'prompt' : 'unavailable';
  }
}

/** Whether two folder handles are one folder.
 * @param {FileSystemHandle} a @param {FileSystemHandle} b @returns {Promise<boolean>} */
export const sameFolder = (a, b) => a.isSameEntry(b).catch(() => false);

/** @param {string} path @returns {string[]} */
const _parts = (path) => String(path ?? '').split('/').filter(Boolean);

/** The folder at `path` inside folder `root` (made when `create` — but for its first `keep` folders,
 * which must be there already: a gallery's own folder, never made again by a write into it). Throws
 * NotFoundError when it isn't there. A folder remembered here that was deleted meanwhile (its handle
 * answers NotFoundError) is forgotten with every folder on the way to it, and looked up (and made)
 * once more — once: a folder that can't be reached even then is thrown, never tried for ever (N1).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @param {boolean} create
 * @param {boolean} [retried] @param {number} [keep] @returns {Promise<FileSystemDirectoryHandle>} */
async function _dir(id, root, path, create, retried = false, keep = 0) {
  const parts = _parts(path);
  if (!parts.length) return root;
  const key = `${id}\0${parts.join('/')}`;
  let hit = _dirs.get(key);
  if (!hit) {
    const made = (async () => {
      const parent = await _dir(id, root, parts.slice(0, -1).join('/'), create, false, keep);
      return parent.getDirectoryHandle(parts[parts.length - 1], { create: create && parts.length > keep });
    })();
    _dirs.set(key, made);
    made.catch(() => { if (_dirs.get(key) === made) _dirs.delete(key); });
    hit = made;
  }
  try { return await hit; } catch (e) {
    if (_nameOf(e) !== 'NotFoundError' || !create || retried) throw e;
    for (let i = 1; i < parts.length; i++) _dirs.delete(`${id}\0${parts.slice(0, i).join('/')}`);
    _forget(id, parts.join('/'));
    return _dir(id, root, path, create, true, keep);
  }
}

/** What is remembered about `path` and everything inside it (about the whole folder: no `path`).
 * @param {string} id @param {string} [path] */
function _forget(id, path = '') {
  const prefix = `${id}\0${path}`;
  for (const key of [..._dirs.keys()]) if (!path || key === prefix || key.startsWith(prefix + '/')) _dirs.delete(key);
  if (!path) for (const key of [..._dirs.keys()]) if (key.startsWith(`${id}\0`)) _dirs.delete(key);
}
/** @param {string} id */
export const forgetFolder = (id) => _forget(id);

/** @param {string} path @returns {[string, string]} its folder and its name */
const _split = (path) => { const parts = _parts(path); return [parts.slice(0, -1).join('/'), parts[parts.length - 1]]; };

// ── What is written, by kind ──
// A file's kind by its name: pages and the pictures made from them, descriptions, archives, the rest.
/** @typedef {'picture' | 'description' | 'archive' | 'other'} Kind */
/** @type {[Kind, RegExp][]} */
const KINDS = [['picture', /\.(png|jpe?g|webp|gif|avif|bmp|jxl)$/i], ['description', /\.(json|xml)$/i], ['archive', /\.(zip|cbz)$/i]];
/** @type {Record<Kind, number>} */
const _totals = { picture: 0, description: 0, archive: 0, other: 0 };
/** @param {string} name @param {number} bytes */
const _count = (name, bytes) => { _totals[KINDS.find(([, re]) => re.test(name))?.[0] ?? 'other'] += bytes; };
/** The bytes written to library folders since this context started, by kind. @returns {Record<Kind, number>} */
export const written = () => ({ ..._totals });

/** `data` written whole to `path` inside the folder — the file it replaces stays as it was until the
 * new one is complete. `within`: a folder on the way that must be there already (a gallery's own:
 * one gone meanwhile is never made again by a write into it — NotFoundError). `fresh`: a file made at a
 * name found free (writeNew) — kept only while it is empty as made: File System Access makes a file only
 * where none is by handing back the one there, so one another writer put at the name since the look is
 * theirs, left as it is, thrown `theirs` (S36). Resolves the file as written. A failure once the file was
 * put in place whole (its look after) is thrown with `whole` set.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @param {Blob | string} data
 * @param {{ within?: string, fresh?: boolean }} [options] @param {boolean} [retried] @returns {Promise<File>} */
export async function writeFile(id, root, path, data, { within = '', fresh = false } = {}, retried = false) {
  const [dir, name] = _split(path);
  let handle;
  try { handle = await (await _dir(id, root, dir, true, false, _parts(within).length)).getFileHandle(name, { create: true }); } catch (e) {
    // A folder remembered here was deleted meanwhile: looked up (and made, but for `within`) again.
    if (_nameOf(e) !== 'NotFoundError' || retried) throw e;
    _forget(id, dir);
    return writeFile(id, root, path, data, { within, fresh }, true);
  }
  if (fresh && (await handle.getFile()).size) throw Object.assign(new DOMException(`${path}: another writer's file is there`, 'InvalidModificationError'), { theirs: true });
  const stream = await handle.createWritable();
  /** @type {any} */ (stream).__shioriKind = 'folder';   // disk-writes.js counts it as the folder's
  try { await stream.write(data); await stream.close(); } catch (e) { try { await stream.abort(); } catch {} throw e; }
  let file;
  try { file = await handle.getFile(); } catch (e) { throw Object.assign(/** @type {object} */ (e), { whole: true }); }
  _count(name, file.size);
  return file;
}

// ── Reading what a folder holds (principle 6; review 6) ──
// Every read that tells what a library folder holds — which galleries, which pages and pictures, which
// descriptions, whether a gallery's folder is still there — answers "nothing there" only as the shared rule
// takes it (_gone, _notFound): an answer of "not found" for a file or folder that a second look finds, or
// while the library folder isn't there as itself (a drive away for a moment), is thrown like any other
// failure. So a gallery is never read in part: one that can't be read whole now is reported and left as the
// index has it, and read again at a later check. A description is looked for only where its folder's listing
// shows its first part (loadGallery), so what isn't there costs no look. The libraries read folders with
// these (and the typed results of galleryIn, manifestIn, loadGallery); none tells "not there" by an error's
// name of its own (architecture-fitness.test.mjs).

/** The file at `path` inside the folder, or null when nothing is there (as the shared rule takes it:
 * _gone) or a folder is. One that can't be read is thrown.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<File | null>} */
async function _fileAt(id, root, path) {
  const [dir, name] = _split(path);
  try {
    return await (await (await _dir(id, root, dir, false)).getFileHandle(name)).getFile();
  } catch (e) {
    if (_nameOf(e) === 'TypeMismatchError') return null;
    if (_nameOf(e) === 'NotFoundError') _forget(id, dir);
    await _gone(id, root, path, e);
    return null;
  }
}
/** The same, as `type` when it differs from what the browser gives it.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @param {string} [type]
 * @returns {Promise<Blob | null>} */
export async function readFile(id, root, path, type) {
  const file = await _fileAt(id, root, path);
  return file && type && file.type !== type ? file.slice(0, file.size, type) : file;
}

/** The text of the file at `path` inside the folder, or null when nothing is there, as the shared rule
 * takes it (_gone) — any other failure, and a "not found" the rule doesn't take, is thrown (never taken
 * for a file that isn't there).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<string | null>} */
export async function readText(id, root, path) {
  try { return await _text(id, root, path); } catch (e) { await _gone(id, root, path, e); return null; }
}
/** The text of the file at `path` inside the folder; null for any answer of "not found", for the reads
 * that decide nothing by it: the shared rule's own look at the folder's identity (identityOf: one not found
 * refuses the folder for now) and a publication's best-effort refresh of its stable-named copies.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<string | null>} */
async function _textNow(id, root, path) {
  try { return await _text(id, root, path); } catch (e) { if (_nameOf(e) === 'NotFoundError') return null; throw e; }
}
/** @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<string>} */
async function _text(id, root, path) {
  const [dir, name] = _split(path);
  return (await (await (await _dir(id, root, dir, false)).getFileHandle(name)).getFile()).text();
}

/** An answer of "not found" (`e`) for `path`, as the shared rule takes it (contract.js surelyMissing):
 * MISSING while the folder `root` reaches is still library folder `id` (identityOf, read afresh: not
 * while its drive is away) and a second look at `path` agrees; else unreadable.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @param {unknown} e */
const _notFound = (id, root, path, e) => surelyMissing({ home: async () => (await identityOf(id, root)) === 'ok', there: () => isThere(id, root, path) }, e);

/** An answer of "not found" (`e`) for `path` that is to be taken: thrown unless the shared rule takes
 * it (_notFound).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @param {unknown} e */
async function _gone(id, root, path, e) {
  if (_nameOf(e) !== 'NotFoundError') throw e;
  _forget(id, _parts(path).join('/'));
  if ((await _notFound(id, root, path, e)).kind !== 'missing') throw e;
}

/** The file at `path` deleted (nothing when it isn't there, as the shared rule takes it: _gone).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<void>} */
export async function removeFile(id, root, path) {
  const [dir, name] = _split(path);
  try { await (await _dir(id, root, dir, false)).removeEntry(name); } catch (e) { await _gone(id, root, path, e); }
}

/** The folder at `path` deleted once it holds nothing (nothing when it isn't there, as the shared rule
 * takes it: _gone). Never with what is in it: the browser refuses a folder that holds anything
 * (InvalidModificationError, thrown), so a listing that was wrong, or a file put there meanwhile,
 * deletes nothing (S11, review 4 F1). What is in a folder is deleted by name, each file Shiori's.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<void>} */
export async function removeDir(id, root, path) {
  const [dir, name] = _split(path);
  if (!name) return;
  _forget(id, _parts(path).join('/'));
  try { await (await _dir(id, root, dir, false)).removeEntry(name); } catch (e) { await _gone(id, root, path, e); }
}

/** What the folder at `path` holds (none when it isn't there, as the shared rule takes it: _gone — a
 * listing that can't be made says so, thrown, never taken for an empty folder).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} [path] @returns {Promise<Listed[]>} */
export async function list(id, root, path = '') {
  /** @type {Listed[]} */
  const out = [];
  try {
    for await (const [name, handle] of (await _dir(id, root, path, false)).entries()) {
      out.push({ name, kind: handle.kind, file: () => /** @type {FileSystemFileHandle} */ (handle).getFile() });
    }
  } catch (e) {
    if (!_split(path)[1]) throw e;   // the folder itself
    await _gone(id, root, path, e);
    return [];
  }
  return out;
}

/** Whether there is anything at `path` inside the folder (a name taken; a linked gallery's source still
 * where it was): an error looking is thrown, never taken for nothing there.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<boolean>} */
export async function isThere(id, root, path) {
  const [dir, name] = _split(path);
  try {
    const parent = await _dir(id, root, dir, false);
    try { await parent.getDirectoryHandle(name); return true; } catch (e) { if (_nameOf(e) === 'TypeMismatchError') return true; if (_nameOf(e) !== 'NotFoundError') throw e; }
    return false;
  } catch (e) { if (_nameOf(e) === 'NotFoundError') return false; throw e; }
}
/** Whether a name in the folder is taken, for picking a free one (reserveDir, writeNew: the website has no
 * exclusive create, so a write to a name this calls free replaces what is there): true when anything is at
 * `path`; false only where there surely is nothing — an answer of "not found" as the shared rule takes it
 * (_notFound). One it doesn't take (a look answering so for a moment, the drive away) is thrown, a
 * NotFoundError: the write waits (S24, found in S22).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<boolean>} */
async function _taken(id, root, path) {
  if (await isThere(id, root, path)) return true;
  const looked = new DOMException(`${path}: not found`, 'NotFoundError');
  if ((await _notFound(id, root, path, looked)).kind !== 'missing') throw looked;
  return false;
}

// ── Coordination between the site's tabs and its service worker ──

/** @type {Map<string, Promise<void>>} name → the end of its queue, for the in-context fallback */
const _queues = new Map();
/** `fn` run while lock `name` is held: across every tab and the service worker of the site (Web
 * Locks), or — where they are missing (Node) — within this context. Resolves what `fn` does. `ifFree`: only if
 * nobody holds or waits for the lock at that moment, never waited for — else it rejects, `name` 'LockBusy'.
 * @template T @param {string} name @param {() => T | Promise<T>} fn @param {{ ifFree?: boolean }} [options] @returns {Promise<T>} */
export function withLock(name, fn, { ifFree = false } = {}) {
  const locks = globalThis.navigator?.locks;
  const busy = () => Object.assign(new Error(`lock ${name} is held`), { name: 'LockBusy' });
  if (typeof locks?.request === 'function') {
    return ifFree ? locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => (lock ? fn() : Promise.reject(busy())))
      : locks.request(name, { mode: 'exclusive' }, () => fn());
  }
  if (ifFree && _queues.has(name)) return Promise.reject(busy());
  const run = (_queues.get(name) || Promise.resolve()).then(() => fn());
  const end = run.then(() => {}, () => {});
  _queues.set(name, end);
  end.then(() => { if (_queues.get(name) === end) _queues.delete(name); });
  return run;
}

/** Folder `path`, looked at and found free, made — and whether it is the one made: File System Access makes a folder
 * only where none is by handing back the one there, so one another writer put at the name since the look (the other
 * app's folder coming into place) is handed back as made. It is this context's only while it lists empty as made;
 * else it is someone else's, left as it is (S36).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<boolean>} */
async function _madeHere(id, root, path) {
  await _dir(id, root, path, true);
  return !(await list(id, root, path)).length;
}

/** A folder of its own for new gallery `gid` at `base` in the folder (a path: its top, or a series'
 * folder) — or "base (2)" and so on when that is taken — made and bound to the gallery at once, while
 * lock shiori:dirs:<folder> is held, so no two galleries, in any tab or the service worker, are given
 * one folder: its first generation published there (gallery-manifest.js firstGeneration, by `writer`)
 * — its metadata.json (`metadata`, the gallery's description) stored by its content, then the manifest,
 * so nothing names the gallery before it (review 4 F2); its stable-named copies come with its first
 * publication. A write that fails takes back what was written, as far as it can: a folder left so
 * names no gallery — and one it can't take back now (a look or a deletion failing: the drive away for a
 * moment) is thrown as `left` ({ dir: its name, files: [{ name, size, mtime }], what may be in it as the
 * failed writes left it }), for the caller to keep recorded as a deletion (review 6 F9 b). The only way
 * a folder becomes a gallery's (contract.js reserve; principle 2). `taken`: names passed over though
 * nothing may be there (a deletion still waits on them: a new folder there would be taken for the one it
 * deletes). A name found free whose folder, once made, isn't empty is another writer's (_madeHere): left as
 * it is, and the next name taken. Resolves its place, held from its first moment as placeIn holds one
 * (`dir` its name, `token` the reservation's publication).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} base @param {string} metadata
 * @param {{ gid: string, writer: string, taken?: Set<string> }} gallery @returns {Promise<Place>} */
export function reserveDir(id, root, base, metadata, { gid, writer, taken = new Set() }) {
  return withLock(`shiori:dirs:${id}`, async () => {
    let name = base;
    for (let i = 2; taken.has(name) || await _taken(id, root, name) || !(await _madeHere(id, root, name)); i++) name = `${base} (${i})`;
    const plan = await publication({ area: '.shiori/', prev: null, next: firstGeneration(gid, writer), texts: { 'metadata.json': metadata } });
    const writes = [...plan.writes, { path: manifestPath('.shiori/'), text: plan.text }];
    let at = 0;
    try {
      for (const [i, w] of writes.entries()) { at = i; await writeFile(id, root, _join(name, w.path), w.text, { within: i ? name : '' }); }
    } catch (e) {
      // Each file there that is what was written, or the empty one a failed write leaves, deleted; then
      // the folders left empty (the folder was free: nothing in it is anyone else's).
      /** @type {{ name: string, size: number, mtime: number | null }[]} */
      const files = [];
      for (const [i, w] of writes.slice(0, at + 1).entries()) {
        const size = new Blob([w.text]).size;
        const f = await _fileAt(id, root, _join(name, w.path)).catch(() => undefined);
        if (f === undefined) files.push({ name: w.path, size: i < at || /** @type {any} */ (e)?.whole ? size : 0, mtime: null });
        else if (f && (!f.size || f.size === size)) await removeFile(id, root, _join(name, w.path)).catch(() => files.push({ name: w.path, size: f.size, mtime: f.lastModified }));
      }
      if (!(await _prune(id, root, name))) throw Object.assign(/** @type {object} */ (e), { left: { dir: name, files } });
      throw e;
    }
    return { id, root, dir: name, gid: String(gid), token: tokenOf(plan.manifest), manifest: plan.manifest, archive: false };
  });
}

/** `data` written to `path` in folder `dir` of the folder under a name no file has: `path` itself when
 * nothing is there, else `path` with a random part added before its extension (images/0001.webp →
 * images/0001-3fa2c9e1.webp: gallery-files.js pageNumberOf reads both), so a file something refers to
 * is never written over — nor one another writer put at a name after it was found free (writeFile `fresh`:
 * left as it is, another name taken). `dir` (a gallery's own folder) must be there: one gone meanwhile is never
 * made again (NotFoundError). Resolves { path, file }: where it went (in `dir`), and the file as
 * written. Rejects with the write's error — with `left` ({ name, size, mtime }: in `dir`) when it may have
 * left a file that couldn't be deleted now (below), for the caller to keep recorded and delete later.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {string} path
 * @param {Blob | string} data @returns {Promise<{ path: string, file: File }>} */
export async function writeNew(id, root, dir, path, data) {
  const another = () => path.replace(/(\.[^./]*)?$/, (ext) => `-${_randomPart()}${ext}`);
  let at = path;
  for (;;) {
    while (await _taken(id, root, `${dir}/${at}`)) at = another();
    const written = await _writeNew(id, root, dir, at, data);
    if (written) return written;
    at = another();
  }
}
/** writeNew's write at name `at`, found free: { path, file }, or null where another writer's file is there now.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {string} at
 * @param {Blob | string} data @returns {Promise<{ path: string, file: File } | null>} */
async function _writeNew(id, root, dir, at, data) {
  try { return { path: at, file: await writeFile(id, root, `${dir}/${at}`, data, { within: dir, fresh: true }) }; } catch (e) {
    if (/** @type {any} */ (e)?.theirs) return null;
    // A write that failed can leave a file at that name, where nothing was: the empty one
    // getFileHandle({ create }) made, or the one written whole before a later call failed (`whole`).
    // Deleted too while it is one of those (empty, or as long as what was written), so nothing unrecorded
    // stays — a folder whose reservation is undone keeps no picture for a check to add as new. One that
    // can't be looked at or deleted now (the drive away for a moment: a "not found" the shared rule doesn't
    // take) is thrown as `left`, at the size that write left it (review 6 F9 b).
    const size = typeof data === 'string' ? new Blob([data]).size : data.size;
    const file = await _fileAt(id, root, `${dir}/${at}`).catch(() => undefined);
    /** @type {{ name: string, size: number, mtime: number | null } | null} */
    let left = file === undefined ? { name: at, size: /** @type {any} */ (e)?.whole ? size : 0, mtime: null } : null;
    if (file && (!file.size || file.size === size)) {
      await removeFile(id, root, `${dir}/${at}`).catch(() => { left = { name: at, size: file.size, mtime: file.lastModified }; });
    }
    throw left ? Object.assign(/** @type {object} */ (e), { left }) : e;
  }
}
const _randomPart = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');

// ── A gallery's folder (format v2: gallery-manifest.js) ──
/** @param {...string} parts @returns {string} */
const _join = (...parts) => parts.filter(Boolean).join('/');

/** The manifest of gallery folder `dir`, typed: missing (format v1), ok, corrupt (`gid`: the gallery
 * it must name), unreadable.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {string | null} [gid]
 * @returns {Promise<import('./contract.js').ParseResult<import('./contract.js').Manifest>>} */
export async function manifestIn(id, root, dir, gid = null) {
  try {
    const text = await readText(id, root, _join(dir, manifestPath(areaOf(dir))));
    return text == null ? MISSING : parseManifest(text, { galleryId: gid });
  } catch (e) { return unreadable(e); }
}

/** Whose gallery folder `dir` is now (principle 2: folder-content.js galleryAt — its manifest, else its
 * metadata.json, else an earlier version's shiori.json; a linked gallery's overlay, its source.json):
 * { kind: 'ok', manifest } when it names gallery `gid` (`manifest`: the text of the manifest that named it,
 * when one did — a linked gallery's overlay is named by its source.json: null); MISSING when
 * nothing is there; { kind: 'conflict', found } when something is that names another gallery (`found`), or
 * none (null); unreadable when what it holds can't be read (nothing is concluded from it). Nothing there,
 * and a description not there, are told as the shared rule takes them (_notFound, readText). What a change
 * to an existing gallery folder needs first: nothing else makes a folder a gallery's but its reservation
 * (reserveDir).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {string} gid
 * @returns {Promise<Whose>} */
export async function galleryIn(id, root, dir, gid) {
  const [parent, base] = _split(dir);
  try { await (await _dir(id, root, parent, false)).getDirectoryHandle(base); } catch (e) {
    if (_nameOf(e) === 'NotFoundError') { _forget(id, _parts(dir).join('/')); return _notFound(id, root, dir, e); }
    return _nameOf(e) === 'TypeMismatchError' ? { kind: 'conflict', found: null } : unreadable(e);
  }
  try {
    const own = await readText(id, root, _join(dir, MANIFEST_FILE));
    if (galleryAt({ [MANIFEST_FILE]: own }, gid).kind === 'ok') return { kind: 'ok', manifest: own };
    const shown = _shown(await list(id, root, dir));
    /** @param {string} name */
    const text = async (name) => (shown(name) ? readText(id, root, _join(dir, name)) : null);
    /** @type {Record<string, string | null>} */
    const texts = { [MANIFEST_FILE]: own };
    for (const name of OWN_FILES.slice(1)) texts[name] = await text(name);
    if (areaOf(dir) !== '') { const whose = galleryAt(texts, gid); return whose.kind === 'ok' ? { kind: 'ok', manifest: null } : whose; }
    const source = parseSource(await text(SOURCE_FILE) ?? '')?.galleryId ?? null;
    const whose = galleryAt(texts, gid, { source });
    return whose.kind === 'ok' ? { kind: 'ok', manifest: null } : whose;
  } catch (e) { return unreadable(e); }
}

/** Gallery `gid`'s place held for a change there, as it is now: the one place the website weighs whose
 * version a gallery's place holds, before anything is written into, moved out of, unpacked from or deleted at
 * it (S31; the rule itself: gallery-manifest.js whoseVersion). The library asks it through db.js _hold alone
 * (the contract's Root.gallery, below, for a publication through it). Its place: folder `dir` in the folder
 * (`id`, its handle `root`) — its identity first (galleryIn, principle 2), then the manifest that named it, as
 * that read it (a linked gallery's overlay's, `gallery.json`, read beside it) — or, `archive`, the archive at
 * `dir` the gallery is read from in place, through the library's reader of it (`read()`: the text of the
 * manifest entry of the gallery's folder in it, null for none; undefined: no archive there; rejects when it
 * can't be read now). That publication is weighed against `known` (the token this library last published or
 * read there; null for none) and `writer` (this app). { kind: 'ok', place } where the place holds this
 * library's view (the same publication, one of this app's own, or no manifest); { kind: 'theirs', token, place }
 * where another publication is there — the folder's version stands — but for the one `over` names (a version
 * the library read and found damaged: no version to stand, T08 — published over). `place`: { id, root, dir,
 * gid, token (the publication there; null for none — a manifest that doesn't parse is none), manifest
 * (parsed), archive }. Else what galleryIn answers ('missing', 'conflict', 'unreadable').
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {string} gid
 * @param {{ known?: string | null, over?: string | null, writer: string, archive?: { read(): Promise<string | null | undefined> } | null }} view
 * @returns {Promise<{ kind: 'ok', place: Place } | { kind: 'theirs', token: string, place: Place } | Exclude<Whose, { kind: 'ok' }>>} */
export async function placeIn(id, root, dir, gid, { known = null, over = null, writer, archive = null }) {
  let text;
  if (archive) {
    try { text = await archive.read(); } catch (e) { return unreadable(e); }
    if (text === undefined) return MISSING;
  } else {
    const whose = await galleryIn(id, root, dir, gid);
    if (whose.kind !== 'ok') return whose;
    try { text = areaOf(dir) === '' ? await readText(id, root, _join(dir, manifestPath(''))) : whose.manifest; } catch (e) { return unreadable(e); }
  }
  const read = text == null ? null : parseManifest(text, { galleryId: String(gid), archive: !!archive });
  const manifest = read?.kind === 'ok' ? read.value : null;
  const token = manifest ? tokenOf(manifest) : null;
  /** @type {Place} */
  const place = { id, root, dir, gid: String(gid), token, manifest, archive: !!archive };
  return token != null && token !== over && whoseVersion(token, known, writer) === 'theirs'
    ? { kind: 'theirs', token, place } : { kind: 'ok', place };
}
/** Whose a gallery's folder is (galleryIn).
 * @typedef {{ kind: 'ok', manifest: string | null } | import('./contract.js').Missing | { kind: 'conflict', found: string | null } | import('./contract.js').Unreadable} Whose */
/** A gallery's place held (placeIn, or the reservation that made it: reserveDir): where it is — folder `dir`
 * of library folder `id` (its handle `root`), or the archive there it is read from (`archive`) — and the
 * publication it held (`token`, `manifest`; null for none), which a publication there moves on.
 * @typedef {{ id: string, root: FileSystemDirectoryHandle, dir: string, gid: string, token: string | null,
 *   manifest: import('./contract.js').Manifest | null, archive: boolean }} Place */
/** Whether a folder's listing (`items`) shows path `rel` in it: its first part, a folder when there is more.
 * @param {Listed[]} items @returns {(rel: string) => boolean} */
const _shown = (items) => (rel) => {
  const [top, ...rest] = rel.split('/');
  return items.some(e => e.name === top && e.kind === (rest.length ? 'directory' : 'file'));
};

/** Generation `next` (a manifest without its descriptions) published at gallery place `place` — held
 * (placeIn, or the reservation that made it: reserveDir), `place.dir` its folder — with its descriptions
 * `texts`: the descriptions the current manifest doesn't store written as new files named by their content,
 * then the manifest written whole (createWritable replaces the file only once it is complete: the commit
 * point), then, as a best effort, the stable-named copies brought up to date and the stored descriptions
 * this generation supersedes collected (gallery-manifest.js publication). Whose version the place holds was
 * weighed as it was held: here it is published only while it still holds that publication (`place.token`) —
 * the manifest the folder's own look reads now (galleryIn) — and the place is held at the new one from then
 * on. Resolves { manifest: the one published }. Rejects, nothing written, when the folder no longer names
 * the gallery (galleryIn: `reason` 'conflict' or 'missing'), when it holds another publication than the one
 * held (`reason` 'changed': tried again, its place held afresh), when its manifest can't be read now, or a
 * write before the commit fails (the previous generation stays whole).
 * @param {Place} place
 * @param {Omit<import('./contract.js').Manifest, 'descriptions'>} next @param {Record<string, string | null | undefined>} texts
 * @returns {Promise<{ manifest: import('./contract.js').Manifest }>} */
export async function publishIn(place, next, texts) {
  const { id, root, dir } = place;
  const area = areaOf(dir);
  const whose = await galleryIn(id, root, dir, next.galleryId);
  if (whose.kind !== 'ok') throw Object.assign(new Error(`${dir} is not gallery ${next.galleryId}'s folder now`), { reason: whose.kind === 'missing' ? 'missing' : 'conflict' });
  const text = area === '' ? await readText(id, root, _join(dir, manifestPath(''))) : whose.manifest;
  const now = text == null ? null : parseManifest(text, { galleryId: next.galleryId });
  const prev = now?.kind === 'ok' ? now.value : null;
  if ((prev ? tokenOf(prev) : null) !== place.token) throw Object.assign(new Error(`${dir} holds another publication than the one held`), { reason: 'changed' });
  const sizes = await sizesOf(next.files, new Map(Object.entries(next.sizes || {})), prev, async (f) => {
    const file = await _fileAt(id, root, _join(dir, f)).catch(() => null);
    return file ? [file.size, file.lastModified] : null;
  });
  const plan = await publication({ area, prev, next: { ...next, sizes }, texts });
  const within = { within: dir };
  for (const w of plan.writes) await writeFile(id, root, _join(dir, w.path), w.text, within);
  await writeFile(id, root, _join(dir, manifestPath(area)), plan.text, within);
  for (const s of plan.stable) {
    try {
      const had = await _textNow(id, root, _join(dir, s.path));
      if (s.text != null && had !== s.text) await writeFile(id, root, _join(dir, s.path), s.text, within);
      else if (s.text == null && had != null && s.was && await matches(s.was, had)) await removeFile(id, root, _join(dir, s.path));
    } catch {}
  }
  try {
    for (const at of plan.superseded) {
      if (!storedHash(at)) continue;
      const had = await _textNow(id, root, _join(dir, at)).catch(() => null);
      if (had != null && await matches(at, had)) await removeFile(id, root, _join(dir, at));
    }
  } catch {}
  Object.assign(place, { token: tokenOf(plan.manifest), manifest: plan.manifest });
  return { manifest: plan.manifest };
}

/** The files `files` (paths in gallery folder `dir`, as Shiori recorded writing them: name, size,
 * modification time) deleted — each only while it is still as recorded (gallery-manifest.js
 * unchanged); one that differs was changed outside Shiori and is left, as is one that isn't there (as
 * the shared rule takes it: _notFound) or can't be checked, each reported in `kept` with why. A folder
 * the deletions left empty goes too, up to `dir` itself (principle 4).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir
 * @param {import('./contract.js').WrittenFile[]} files
 * @returns {Promise<{ deleted: string[], kept: { name: string, why: 'changed' | 'missing' | 'unreadable' }[] }>} */
export async function deleteNamedIn(id, root, dir, files) {
  /** @type {string[]} */
  const deleted = [];
  /** @type {{ name: string, why: 'changed' | 'missing' | 'unreadable' }[]} */
  const kept = [];
  /** @type {Set<string>} */
  const emptied = new Set();
  for (const f of files) {
    const at = _join(dir, f.name);
    let file;
    try { file = await _fileAt(id, root, at); } catch { kept.push({ name: f.name, why: 'unreadable' }); continue; }
    if (!file) { kept.push({ name: f.name, why: 'missing' }); continue; }
    if (!unchanged(f, { size: file.size, mtime: file.lastModified })) { kept.push({ name: f.name, why: 'changed' }); continue; }
    try { await removeFile(id, root, at); deleted.push(f.name); emptied.add(_split(at)[0]); } catch { kept.push({ name: f.name, why: 'unreadable' }); }
  }
  const top = _parts(dir).join('/');
  for (const d of [...emptied].sort((a, b) => b.length - a.length)) {
    for (let at = d; at === top || at.startsWith(`${top}/`); at = _split(at)[0]) {
      if (!(await _removeEmptied(id, root, at))) break;
      if (at === top) break;
    }
  }
  return { deleted, kept };
}

/** Gallery `gid`'s own folder `dir` deleted by name (gallery-manifest.js galleryDeletion, principle 4):
 * the pictures the library recorded writing there (`named`) and those its manifest records, each while
 * it is as recorded; then its descriptions, each while it is the gallery's; then what names it, its
 * manifest last; then the folders left empty, the gallery's own among them. A folder that names the
 * gallery (galleryIn) is deleted so; one that names no gallery — what named it gone already (a deletion
 * cut short), or put there by hand — loses only the files the library recorded writing, each while it
 * is as recorded; one gone, or another gallery's, is left as it is ('missing': the gallery's folder
 * isn't there — renamed or moved by hand, perhaps: F4). Nothing is concluded from an answer of "not
 * found" the shared rule doesn't take (_notFound: the drive away, say — review 5 F2). `dir` is a folder
 * (an archive is the caller's). `named` null: a folder the deletion met in place of the archive it
 * recorded, deleted by its manifest alone — left whole without one (galleryDeletion). Resolves whether the
 * deletion is done — true, or 'left' when what it emptied still holds files: a person's, or one changed
 * since Shiori wrote it — 'missing', or is to be tried again (false: something there couldn't be read or
 * deleted now, or the folder still names the gallery).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {string} gid
 * @param {{ name: string, size: number, mtime?: number | null }[] | null} named @returns {Promise<boolean | 'left' | 'missing'>} */
export async function deleteGalleryIn(id, root, dir, gid, named) {
  const whose = await galleryIn(id, root, dir, gid);
  if (whose.kind === 'unreadable') return false;
  if (whose.kind === 'missing' || (whose.kind === 'conflict' && whose.found != null)) return 'missing';
  const now = whose.kind === 'ok' ? await manifestIn(id, root, dir, gid) : MISSING;
  if (now.kind === 'unreadable') return false;
  const area = areaOf(dir);
  const plan = galleryDeletion({ area, manifest: now.kind === 'ok' ? now.value : null, named });
  if (!plan) return 'left';
  const { kept } = await deleteNamedIn(id, root, dir, /** @type {import('./contract.js').WrittenFile[]} */ (plan.pictures));
  if (kept.some(k => k.why === 'unreadable')) return false;
  if (whose.kind === 'ok') {
    try {
      /** @param {string} rel */
      const drop = async (rel) => {
        const at = _join(dir, rel), text = await readText(id, root, at);
        if (text != null && await isOwnDescription(rel, text, gid, area, now.kind === 'ok' ? now.value : null)) await removeFile(id, root, at);
      };
      for (const rel of plan.descriptions) await drop(rel);
      for (const e of await list(id, root, _join(dir, plan.stored))) if (e.kind === 'file') await drop(`${plan.stored}/${e.name}`);
      for (const rel of plan.identity) await drop(rel);
    } catch { return false; }
    // Done only once the folder no longer names the gallery: a description whose read answered "not
    // found", still there, names it yet — the deletion stays recorded, tried again (S11, review 4 F3).
    const after = await galleryIn(id, root, dir, gid);
    if (after.kind === 'ok' || after.kind === 'unreadable') return false;
  }
  if (await _prune(id, root, dir)) return true;
  // Not pruned: 'left' only for a file in it — the person's, or one changed since Shiori wrote it, as the
  // desktop's holdsFile tells. Folders of its own it couldn't remove now (the drive away for a moment), or
  // a listing that can't be made, leave the deletion recorded, tried again (review 6 F9 c).
  return _holdsFile(id, root, dir).then(held => (held ? 'left' : false), () => false);
}
/** Whether folder `dir` holds a file, in it or in a folder of it — the browser's swap files aside, which
 * are never the person's (SWAP_FILE) — none: it isn't there, as the shared rule takes it (list); one that
 * can't be listed is thrown.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @returns {Promise<boolean>} */
async function _holdsFile(id, root, dir) {
  for (const e of await list(id, root, dir)) {
    if (e.kind === 'directory' ? await _holdsFile(id, root, _join(dir, e.name)) : !SWAP_FILE.test(e.name)) return true;
  }
  return false;
}
/** The folders under `dir` left empty, then `dir` itself once it is, removed — as far as they can be.
 * Resolves whether `dir` is gone.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @returns {Promise<boolean>} */
async function _prune(id, root, dir) {
  let entries;
  try { entries = await list(id, root, dir); } catch { return false; }
  for (const e of entries) if (e.kind === 'directory') await _prune(id, root, _join(dir, e.name));
  return _removeEmptied(id, root, dir);
}
/** Folder `dir`, emptied by Shiori, removed while it holds nothing but the browser's swap files (removed
 * first: folder-content.js SWAP_FILE) — and with nothing else (S26a): the reservation it was undoes whole,
 * a deleted gallery's folder isn't reported as the person's. Resolves whether it went: one that holds
 * anything else, or can't be listed or removed now, stays.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @returns {Promise<boolean>} */
async function _removeEmptied(id, root, dir) {
  let entries;
  try { entries = await list(id, root, dir); } catch { return false; }
  if (entries.some(e => e.kind !== 'file' || !SWAP_FILE.test(e.name))) return false;
  try {
    for (const e of entries) await removeFile(id, root, _join(dir, e.name));
    await removeDir(id, root, dir);
    return true;
  } catch { return false; }
}

/** The picture files gallery folder `dir` holds where the gallery format puts them (PICTURE_DIRS):
 * path → { size, mtime }. One gone, as the shared rule takes it (_gone), is left out; one that can't be
 * read now is thrown — never a gallery with a page fewer. Only the folders its listings show are listed
 * (`items`: the gallery's own listing, when the caller has it): a gallery has few of them, and each answer
 * of "not found" costs the shared rule's looks.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {Listed[] | null} [items]
 * @returns {Promise<Map<string, { size: number, mtime: number }>>} */
export async function picturesIn(id, root, dir, items = null) {
  /** @type {Map<string, { size: number, mtime: number }>} */
  const out = new Map();
  /** @type {Map<string, Promise<Set<string>>>} folder → the names of the folders in it */
  const folders = new Map();
  /** @param {Listed[]} es */
  const named = (es) => new Set(es.filter(e => e.kind === 'directory').map(e => e.name));
  if (items) folders.set(dir, Promise.resolve(named(items)));
  /** @param {string} at */
  const foldersIn = (at) => folders.get(at) ?? folders.set(at, list(id, root, at).then(named)).get(at);
  /** @param {string} sub */
  const holds = async (sub) => {
    let at = dir;
    for (const part of sub.split('/')) { if (!(await /** @type {Promise<Set<string>>} */ (foldersIn(at))).has(part)) return false; at = _join(at, part); }
    return true;
  };
  for (const sub of PICTURE_DIRS) {
    if (!await holds(sub)) continue;
    for (const e of await list(id, root, _join(dir, sub))) {
      if (e.kind !== 'file' || !isPictureName(e.name)) continue;
      const at = _join(dir, sub, e.name);
      const file = await e.file().catch(async (err) => { await _gone(id, root, at, err); return null; });
      if (file) out.set(`${sub}/${e.name}`, { size: file.size, mtime: file.lastModified });
    }
  }
  return out;
}

/** Gallery folder `dir` read back (gallery-manifest.js readGallery): by its manifest when it has one,
 * else by format v1's rules, with the picture files it holds (`files`, picturesIn), each description
 * looked for where the folder's listing shows it, under the rule (readText). Rejects when something in it
 * can't be read now.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir */
export async function loadGallery(id, root, dir) {
  const items = await list(id, root, dir);
  const files = await picturesIn(id, root, dir, items);
  const shown = _shown(items);
  const read = await readGallery({ area: areaOf(dir), text: async (rel) => (shown(rel) ? readText(id, root, _join(dir, rel)) : null), files });
  return { read, files };
}

// ── The contract ──
/** A file read whole, typed (principle 6).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<ReadBytes>} */
async function _read(id, root, path) {
  try {
    const file = await _fileAt(id, root, path);
    return file ? { kind: 'ok', data: new Uint8Array(await file.arrayBuffer()), size: file.size, mtime: file.lastModified } : MISSING;
  } catch (e) { return unreadable(e); }
}
/** @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<ListResult>} */
async function _list(id, root, path) {
  try {
    /** @type {import('./contract.js').Entry[]} */
    const entries = [];
    for (const e of await list(id, root, path)) {
      const file = e.kind === 'file' ? await e.file() : null;
      entries.push({ name: e.name, kind: e.kind === 'file' ? 'file' : 'dir', size: file?.size ?? 0, mtime: file?.lastModified ?? 0 });
    }
    return { kind: 'ok', entries };
  } catch (e) { return unreadable(e); }
}
/** Library folder `id` (its handle `root`), opened for `purpose` by this library (`writer`, its id
 * among the apps: what its publications are signed with).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {Purpose} purpose @param {string} writer @returns {WriteRoot} */
function _root(id, root, purpose, writer) {
  // Gallery `gid`'s directory `name`, in format v2 (the functions above). Each change is made only while
  // the directory still names the gallery (galleryIn, principle 2) — one gone meanwhile, or put there
  // since by hand, is refused — and a publication only at its place as held (`place`: placeIn's, or its
  // reservation's; publishIn). The website writes no temporary files of its own (createWritable writes a
  // file whole), so there is nothing to sweep.
  /** @param {string} name @param {string} gid @param {Place | null} [place] @returns {GalleryDir} */
  const galleryDir = (name, gid, place = null) => {
    const ours = async () => {
      const found = await galleryIn(id, root, name, gid);
      if (found.kind !== 'ok') throw Object.assign(new Error(`${name} is not gallery ${gid}'s folder now`), { reason: found.kind === 'missing' ? 'missing' : 'conflict' });
    };
    return {
      name, gid,
      manifest: () => manifestIn(id, root, name, gid),
      read: (rel) => _read(id, root, _join(name, rel)),
      async writeNew(slot, ext, bytes) {
        await ours();
        const { path, file } = await writeNew(id, root, name, `${slot}.${ext}`, new Blob([/** @type {BlobPart} */ (bytes)]));
        return { name: path, size: file.size, mtime: file.lastModified };
      },
      async publish({ manifest, descriptions }) {
        if (!place) throw Object.assign(new Error(`gallery ${gid}'s place isn't held: open it with this library's view of it (gallery(dir, gid, { known }))`), { reason: 'conflict' });
        const { manifest: done } = await publishIn(place, manifest, descriptions);
        return { generation: done.generation, token: tokenOf(done) };
      },
      async deleteNamed(files) { await ours(); return deleteNamedIn(id, root, name, files); },
      sweep: async () => ({ removed: [] }),
    };
  };
  return {
    id, purpose,
    read: (rel) => _read(id, root, rel),
    list: (rel) => _list(id, root, rel),
    // The directory, while it names the gallery (galleryIn) — or, with the library's view of it (`view`:
    // { known: the token it last published or read there, or null; over: a damaged version it may publish
    // over }), its place held (placeIn: 'ok', or 'theirs' with the token of the publication there). With a view, what
    // the look found of a manifest there is said either way (`token`: the publication there, null for none — S41: the
    // hold asking through the contract knows what its first look saw).
    async gallery(name, gid, view = null) {
      if (!view) {
        const found = await galleryIn(id, root, name, String(gid));
        return found.kind === 'ok' ? { kind: 'ok', dir: galleryDir(name, String(gid)) } : found;
      }
      const at = await placeIn(id, root, name, String(gid), { ...view, writer });
      if (at.kind === 'ok') return { kind: 'ok', token: at.place.token ?? null, dir: galleryDir(name, String(gid), at.place) };
      if (at.kind === 'theirs') return { kind: 'theirs', token: at.token, dir: galleryDir(name, String(gid), at.place) };
      return at;
    },
    // A free directory named after the hint, bound to the gallery by its first generation (reserveDir),
    // held as its reservation made it.
    async reserve(hint, gid) {
      const metadata = JSON.stringify({ galleryId: String(gid), title: { english: hint, japanese: '', pretty: '' } });
      const place = await reserveDir(id, root, hint, metadata, { gid: String(gid), writer });
      return galleryDir(place.dir, String(gid), place);
    },
    // File System Access walks the folder one name at a time and never sees a link: a source is read
    // where it is named (the browser's own handling of links, plan §2).
    async source(at) {
      return { kind: 'ok', source: { path: at, read: (rel = '') => _read(id, root, _join(at, rel)), list: (rel = '') => _list(id, root, _join(at, rel)) } };
    },
    private: {
      async read(rel) {
        try {
          const file = await _fileAt(id, root, `.shiori/${rel}`);
          return file ? { kind: 'ok', data: await file.text(), size: file.size, mtime: file.lastModified } : MISSING;
        } catch (e) { return unreadable(e); }
      },
      list: (rel) => _list(id, root, _join('.shiori', rel)),
      async write(rel, text) { const file = await writeFile(id, root, `.shiori/${rel}`, text); return { name: rel, size: file.size, mtime: file.lastModified }; },
      remove: (rel) => removeFile(id, root, `.shiori/${rel}`),
    },
  };
}

/** Folder `id` as the library has it: its handle, its state (folder-lifecycle.js), whether this library
 * holds its claim (`owned`; `handover`: its claim, but the folder is still to be read after it came back,
 * folder-owner.js), this page's permission for it (permission()), whether the folder its handle reaches
 * is it (`here`: its library.json names `id`, principle 1), and the library's own id (`writer`) — null
 * for one it doesn't have.
 * @typedef {(id: string) => Promise<{ handle: FileSystemDirectoryHandle, state: string, owned: boolean, handover?: boolean,
 *   permission: string, here: boolean, writer: string } | null>} Gate */
/** The adapter over the library's gate.
 * @param {Gate} gate @returns {import('./contract.js').FolderStore<FileSystemDirectoryHandle>} */
export function folderStore(gate) {
  return {
    /** @param {import('./contract.js').FolderRef<FileSystemDirectoryHandle>} ref @param {{ purpose: Purpose }} options */
    async open(ref, { purpose }) {
      const f = await gate(ref.id);
      if (!f || f.permission === 'unavailable') return refused('unavailable');
      if (f.permission !== 'granted') return refused('no-permission');
      const why = refusalFor({ state: f.state, owned: f.owned, handover: !!f.handover, reachable: true, here: f.here }, purpose);
      return why ? refused(why) : { status: 'ok', root: _root(ref.id, f.handle, purpose, f.writer) };
    },
  };
}

/** Whether the folder `handle` reaches is library folder `id` now (principle 1): 'ok' when its
 * .shiori/library.json names it (folder-content.js libraryIdOf), 'other-library' when it names
 * another, or none, or isn't there; 'unavailable' when it can't be read now. Read only.
 * @param {string} id @param {FileSystemDirectoryHandle} handle @returns {Promise<'ok' | 'other-library' | 'unavailable'>} */
export async function identityOf(id, handle) {
  try { return libraryIdOf(await _textNow(id, handle, LIBRARY_FILE)) === id ? 'ok' : 'other-library'; } catch (e) {
    return _nameOf(e) === 'TypeMismatchError' ? 'other-library' : 'unavailable';
  }
}
/** The text of file `rel` in folder `handle`, one the person picked that is being added to the library —
 * it has no id the library knows yet, so the shared rule can't ask whether it is itself — or null where
 * there surely is nothing: an answer of "not found" taken as the shared rule takes it (contract.js
 * surelyMissing), the folder picked answering its listing in place of its library.json (its drive is
 * there), then a second look agreeing. Any other failure, and a "not found" the rule doesn't take, is
 * thrown. What the website has in place of an exclusive create: a folder's library.json is written only
 * where this answers null, and only once its add is allowed (folder-library.js folderAdd; review 6 F5).
 * @param {FileSystemDirectoryHandle} handle @param {string} rel @returns {Promise<string | null>} */
export async function pickedText(handle, rel) {
  const probe = `picked-${Date.now()}-${Math.random()}`;
  try {
    return await _text(probe, handle, rel);
  } catch (e) {
    if (_nameOf(e) !== 'NotFoundError') throw e;
    _forget(probe);
    const home = async () => { await handle.keys().next(); return true; };
    if ((await surelyMissing({ home, there: () => isThere(probe, handle, rel) }, e)).kind !== 'missing') throw e;
    return null;
  } finally { _forget(probe); }
}

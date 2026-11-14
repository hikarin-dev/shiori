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
import { MANIFEST_FILE, OWN_FILES, LIBRARY_FILE, galleryAt, libraryIdOf } from './folder-content.js';
import { refusalFor } from './folder-lifecycle.js';
import { SOURCE_FILE, parseSource } from './linked-source.js';
import { PICTURE_DIRS, isPictureName, areaOf, manifestPath, storedDir, storedHash, parseManifest, publication, firstGeneration, tokenOf, sizesOf,
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
 * when it would otherwise be 'prompt' — only from a click.
 * @param {Folder | null | undefined} handle @param {{ ask?: boolean }} [options]
 * @returns {Promise<PermissionState | 'unavailable'>} */
export async function permission(handle, { ask = false } = {}) {
  if (!handle || typeof handle.queryPermission !== 'function') return 'unavailable';
  try {
    let state = await handle.queryPermission({ mode: 'readwrite' });
    if (state === 'prompt' && ask && typeof handle.requestPermission === 'function') state = await handle.requestPermission({ mode: 'readwrite' });
    if (state !== 'granted') return state;
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
 * one gone meanwhile is never made again by a write into it — NotFoundError). Resolves the file as
 * written.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @param {Blob | string} data
 * @param {{ within?: string }} [options] @param {boolean} [retried] @returns {Promise<File>} */
export async function writeFile(id, root, path, data, { within = '' } = {}, retried = false) {
  const [dir, name] = _split(path);
  let handle;
  try { handle = await (await _dir(id, root, dir, true, false, _parts(within).length)).getFileHandle(name, { create: true }); } catch (e) {
    // A folder remembered here was deleted meanwhile: looked up (and made, but for `within`) again.
    if (_nameOf(e) !== 'NotFoundError' || retried) throw e;
    _forget(id, dir);
    return writeFile(id, root, path, data, { within }, true);
  }
  const stream = await handle.createWritable();
  /** @type {any} */ (stream).__shioriKind = 'folder';   // disk-writes.js counts it as the folder's
  try { await stream.write(data); await stream.close(); } catch (e) { try { await stream.abort(); } catch {} throw e; }
  const file = await handle.getFile();
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

// ── Coordination between the site's tabs and its service worker ──

/** @type {Map<string, Promise<void>>} name → the end of its queue, for the in-context fallback */
const _queues = new Map();
/** `fn` run while lock `name` is held: across every tab and the service worker of the site (Web
 * Locks), or — where they are missing (Node) — within this context. Resolves what `fn` does.
 * @template T @param {string} name @param {() => T | Promise<T>} fn @returns {Promise<T>} */
export function withLock(name, fn) {
  const locks = globalThis.navigator?.locks;
  if (typeof locks?.request === 'function') return locks.request(name, { mode: 'exclusive' }, () => fn());
  const run = (_queues.get(name) || Promise.resolve()).then(() => fn());
  const end = run.then(() => {}, () => {});
  _queues.set(name, end);
  end.then(() => { if (_queues.get(name) === end) _queues.delete(name); });
  return run;
}

/** A folder of its own for new gallery `gid` at `base` in the folder (a path: its top, or a series'
 * folder) — or "base (2)" and so on when that is taken — made and bound to the gallery at once, while
 * lock shiori:dirs:<folder> is held, so no two galleries, in any tab or the service worker, are given
 * one folder: its first generation published there (gallery-manifest.js firstGeneration, by `writer`)
 * — its metadata.json (`metadata`, the gallery's description) stored by its content, then the manifest,
 * so nothing names the gallery before it (review 4 F2); its stable-named copies come with its first
 * publication. A write that fails takes back what was written, as far as it can: a folder left so
 * names no gallery. The only way a folder becomes a gallery's (contract.js reserve; principle 2).
 * `taken`: names passed over though nothing may be there (a deletion still waits on them: a new folder
 * there would be taken for the one it deletes). Resolves its name.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} base @param {string} metadata
 * @param {{ gid: string, writer: string, taken?: Set<string> }} gallery @returns {Promise<string>} */
export function reserveDir(id, root, base, metadata, { gid, writer, taken = new Set() }) {
  return withLock(`shiori:dirs:${id}`, async () => {
    let name = base;
    for (let i = 2; taken.has(name) || await isThere(id, root, name); i++) name = `${base} (${i})`;
    const plan = await publication({ area: '.shiori/', prev: null, next: firstGeneration(gid, writer), texts: { 'metadata.json': metadata } });
    const writes = [...plan.writes, { path: manifestPath('.shiori/'), text: plan.text }];
    try {
      for (const [i, w] of writes.entries()) await writeFile(id, root, _join(name, w.path), w.text, { within: i ? name : '' });
    } catch (e) {
      // Each file there that is what was written, or the empty one a failed write leaves, deleted; then
      // the folders left empty (the folder was free: nothing in it is anyone else's).
      for (const w of writes) {
        await _fileAt(id, root, _join(name, w.path)).then(f => (f && (!f.size || f.size === new Blob([w.text]).size) ? removeFile(id, root, _join(name, w.path)) : undefined)).catch(() => {});
      }
      await _prune(id, root, name);
      throw e;
    }
    return name;
  });
}

/** `data` written to `path` in folder `dir` of the folder under a name no file has: `path` itself when
 * nothing is there, else `path` with a random part added before its extension (images/0001.webp →
 * images/0001-3fa2c9e1.webp: gallery-files.js pageNumberOf reads both), so a file something refers to
 * is never written over. `dir` (a gallery's own folder) must be there: one gone meanwhile is never
 * made again (NotFoundError). Resolves { path, file }: where it went (in `dir`), and the file as
 * written.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {string} path
 * @param {Blob | string} data @returns {Promise<{ path: string, file: File }>} */
export async function writeNew(id, root, dir, path, data) {
  let at = path;
  while (await isThere(id, root, `${dir}/${at}`)) at = path.replace(/(\.[^./]*)?$/, (ext) => `-${_randomPart()}${ext}`);
  try { return { path: at, file: await writeFile(id, root, `${dir}/${at}`, data, { within: dir }) }; } catch (e) {
    // A write that failed can leave a file at that name, where nothing was: the empty one
    // getFileHandle({ create }) made, or the one written whole before a later call failed. Deleted too
    // while it is one of those (empty, or as long as what was written), so nothing unrecorded stays —
    // a folder whose reservation is undone keeps no picture for a check to add as new.
    const size = typeof data === 'string' ? new Blob([data]).size : data.size;
    await _fileAt(id, root, `${dir}/${at}`).then(f => (f && (!f.size || f.size === size) ? removeFile(id, root, `${dir}/${at}`) : undefined)).catch(() => {});
    throw e;
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
 * { kind: 'ok' } when it names gallery `gid`; MISSING when nothing is there; { kind: 'conflict', found }
 * when something is that names another gallery (`found`), or none (null); unreadable when what it holds
 * can't be read (nothing is concluded from it). Nothing there, and a description not there, are told as
 * the shared rule takes them (_notFound, readText). What a change to an existing gallery folder needs
 * first: nothing else makes a folder a gallery's but its reservation (reserveDir).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {string} gid
 * @returns {Promise<import('./contract.js').GalleryResult<never> | { kind: 'ok' }>} */
export async function galleryIn(id, root, dir, gid) {
  const [parent, base] = _split(dir);
  try { await (await _dir(id, root, parent, false)).getDirectoryHandle(base); } catch (e) {
    if (_nameOf(e) === 'NotFoundError') { _forget(id, _parts(dir).join('/')); return _notFound(id, root, dir, e); }
    return _nameOf(e) === 'TypeMismatchError' ? { kind: 'conflict', found: null } : unreadable(e);
  }
  try {
    const own = await readText(id, root, _join(dir, MANIFEST_FILE));
    if (galleryAt({ [MANIFEST_FILE]: own }, gid).kind === 'ok') return { kind: 'ok' };
    const shown = _shown(await list(id, root, dir));
    /** @param {string} name */
    const text = async (name) => (shown(name) ? readText(id, root, _join(dir, name)) : null);
    /** @type {Record<string, string | null>} */
    const texts = { [MANIFEST_FILE]: own };
    for (const name of OWN_FILES.slice(1)) texts[name] = await text(name);
    if (areaOf(dir) !== '') return galleryAt(texts, gid);
    const source = parseSource(await text(SOURCE_FILE) ?? '')?.galleryId ?? null;
    return galleryAt(texts, gid, { source });
  } catch (e) { return unreadable(e); }
}
/** Whether a folder's listing (`items`) shows path `rel` in it: its first part, a folder when there is more.
 * @param {Listed[]} items @returns {(rel: string) => boolean} */
const _shown = (items) => (rel) => {
  const [top, ...rest] = rel.split('/');
  return items.some(e => e.name === top && e.kind === (rest.length ? 'directory' : 'file'));
};

/** Generation `next` (a manifest without its descriptions) published in gallery folder `dir` with its
 * descriptions `texts`: the descriptions the current manifest doesn't store written as new files named
 * by their content, then the manifest written whole (createWritable replaces the file only once it is
 * complete: the commit point), then, as a best effort, the stable-named copies brought up to date and
 * the stored descriptions neither generation names collected (gallery-manifest.js publication).
 * `known`: the token the library last published or read there (undefined: not weighed). Resolves {
 * manifest: the one published, changedBoth: whether it replaced a generation another app published
 * since `known` — this app's change wins; the case is the caller's to report (D4) }. Rejects when the
 * folder no longer names the gallery (galleryIn: nothing is written, `reason` 'conflict' or
 * 'missing'), when the current manifest can't be read, or a write before the commit fails (the
 * previous generation stays whole).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir
 * @param {Omit<import('./contract.js').Manifest, 'descriptions'>} next @param {Record<string, string | null | undefined>} texts
 * @param {{ known?: string | null }} [options]
 * @returns {Promise<{ manifest: import('./contract.js').Manifest, changedBoth: boolean }>} */
export async function publishIn(id, root, dir, next, texts, { known } = {}) {
  const area = areaOf(dir);
  const whose = await galleryIn(id, root, dir, next.galleryId);
  if (whose.kind !== 'ok') throw Object.assign(new Error(`${dir} is not gallery ${next.galleryId}'s folder now`), { reason: whose.kind === 'missing' ? 'missing' : 'conflict' });
  const now = await manifestIn(id, root, dir, next.galleryId);
  if (now.kind === 'unreadable') throw new Error(`the manifest in ${dir} can't be read: ${now.error}`);
  const prev = now.kind === 'ok' ? now.value : null;
  const changedBoth = known !== undefined && !!prev && tokenOf(prev) !== known && prev.writer !== next.writer;
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
    for (const e of await list(id, root, _join(dir, storedDir(area)))) {
      const at = `${storedDir(area)}/${e.name}`;
      if (e.kind !== 'file' || plan.keep.has(at) || !storedHash(at)) continue;
      const had = await _textNow(id, root, _join(dir, at)).catch(() => null);
      if (had != null && await matches(at, had)) await removeFile(id, root, _join(dir, at));
    }
  } catch {}
  return { manifest: plan.manifest, changedBoth };
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
      if ((await list(id, root, at).catch(() => [null])).length) break;
      try { await removeDir(id, root, at); } catch { break; }
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
 * (an archive is the caller's). Resolves whether the deletion is done — true, or 'left' when what it
 * emptied still holds files: a person's, or one changed since Shiori wrote it — 'missing', or is to be
 * tried again (false: something there couldn't be read or deleted now, or the folder still names the
 * gallery).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {string} gid
 * @param {{ name: string, size: number, mtime?: number | null }[]} named @returns {Promise<boolean | 'left' | 'missing'>} */
export async function deleteGalleryIn(id, root, dir, gid, named) {
  const whose = await galleryIn(id, root, dir, gid);
  if (whose.kind === 'unreadable') return false;
  if (whose.kind === 'missing' || (whose.kind === 'conflict' && whose.found != null)) return 'missing';
  const now = whose.kind === 'ok' ? await manifestIn(id, root, dir, gid) : MISSING;
  if (now.kind === 'unreadable') return false;
  const area = areaOf(dir);
  const plan = galleryDeletion({ area, manifest: now.kind === 'ok' ? now.value : null, named });
  const { kept } = await deleteNamedIn(id, root, dir, /** @type {import('./contract.js').WrittenFile[]} */ (plan.pictures));
  if (kept.some(k => k.why === 'unreadable')) return false;
  if (whose.kind === 'ok') {
    try {
      /** @param {string} rel */
      const drop = async (rel) => {
        const at = _join(dir, rel), text = await readText(id, root, at);
        if (text != null && await isOwnDescription(rel, text, gid, area)) await removeFile(id, root, at);
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
  // Not pruned: something is left in it (a listing that can't be made: tried again, the folder there).
  const left = await list(id, root, dir).catch(() => null);
  return !left ? false : left.length ? 'left' : true;
}
/** The folders under `dir` left empty, then `dir` itself once it is, removed — as far as they can be.
 * Resolves whether `dir` is gone.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @returns {Promise<boolean>} */
async function _prune(id, root, dir) {
  let entries;
  try { entries = await list(id, root, dir); } catch { return false; }
  for (const e of entries) if (e.kind === 'directory') await _prune(id, root, _join(dir, e.name));
  if ((await list(id, root, dir).catch(() => [null])).length) return false;
  return removeDir(id, root, dir).then(() => true, () => false);
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
  // since by hand, is refused. The website writes no temporary files of its own (createWritable
  // writes a file whole), so there is nothing to sweep.
  /** @param {string} name @param {string} gid @returns {GalleryDir} */
  const galleryDir = (name, gid) => {
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
      async publish({ manifest, descriptions, known }) {
        const done = await publishIn(id, root, name, manifest, descriptions, { known });
        return { generation: done.manifest.generation, changedBoth: done.changedBoth };
      },
      async deleteNamed(files) { await ours(); return deleteNamedIn(id, root, name, files); },
      sweep: async () => ({ removed: [] }),
    };
  };
  return {
    id, purpose,
    read: (rel) => _read(id, root, rel),
    list: (rel) => _list(id, root, rel),
    // The directory, while it names the gallery (galleryIn).
    async gallery(name, gid) {
      const found = await galleryIn(id, root, name, String(gid));
      return found.kind === 'ok' ? { kind: 'ok', dir: galleryDir(name, String(gid)) } : found;
    },
    // A free directory named after the hint, bound to the gallery by its first generation (reserveDir).
    async reserve(hint, gid) {
      const metadata = JSON.stringify({ galleryId: String(gid), title: { english: hint, japanese: '', pretty: '' } });
      return galleryDir(await reserveDir(id, root, hint, metadata, { gid: String(gid), writer }), String(gid));
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
 * holds its claim, this page's permission for it (permission()), whether the folder its handle reaches
 * is it (`here`: its library.json names `id`, principle 1), and the library's own id (`writer`) — null
 * for one it doesn't have.
 * @typedef {(id: string) => Promise<{ handle: FileSystemDirectoryHandle, state: string, owned: boolean,
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
      const why = refusalFor({ state: f.state, owned: f.owned, reachable: true, here: f.here }, purpose);
      return why ? refused(why) : { status: 'ok', root: _root(ref.id, f.handle, purpose, f.writer) };
    },
  };
}

/** Whether the folder `handle` reaches is library folder `id` now (principle 1): 'ok' when its
 * .shiori/library.json names it (folder-content.js libraryIdOf), 'other-library' when it names
 * another, or none, or isn't there; 'unavailable' when it can't be read now. Read only.
 * @param {string} id @param {FileSystemDirectoryHandle} handle @returns {Promise<'ok' | 'other-library' | 'unavailable'>} */
export async function identityOf(id, handle) {
  try { return libraryIdOf(await libraryText(id, handle)) === id ? 'ok' : 'other-library'; } catch (e) {
    return _nameOf(e) === 'TypeMismatchError' ? 'other-library' : 'unavailable';
  }
}
/** The text of the folder's .shiori/library.json, which tells which library folder it is (principle 1),
 * or null for an answer of "not found": there is no library folder to ask yet whether that is so (the
 * shared rule's own look — identityOf — and a folder being added). Any other failure is thrown.
 * @param {string} id @param {FileSystemDirectoryHandle} handle @returns {Promise<string | null>} */
export function libraryText(id, handle) {
  return _textNow(id, handle, LIBRARY_FILE);
}

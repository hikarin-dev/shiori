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
// folderStore(gate) is the contract over these: open(ref, { purpose }) weighs the folder as the
// library's gate has it (its handle, its state, this page's permission, whether this library holds
// its claim) and hands out a Root, whose galleries and reservations work as the library does today.
// Format v2's manifest and publish come with S4; identity-verified roots and positive gallery
// identity with S5.
import { refused, MISSING, unreadable } from './contract.js';
import { galleryIdOf } from './folder-content.js';
import { refusalFor } from './folder-lifecycle.js';

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

/** The folder at `path` inside folder `root` (made when `create`). Throws NotFoundError when it isn't
 * there. A folder remembered here that was deleted meanwhile (its handle answers NotFoundError) is
 * forgotten with every folder on the way to it, and looked up (and made) once more — once: a folder
 * that can't be reached even then is thrown, never tried for ever (N1).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @param {boolean} create
 * @param {boolean} [retried] @returns {Promise<FileSystemDirectoryHandle>} */
async function _dir(id, root, path, create, retried = false) {
  const parts = _parts(path);
  if (!parts.length) return root;
  const key = `${id}\0${parts.join('/')}`;
  let hit = _dirs.get(key);
  if (!hit) {
    const made = (async () => {
      const parent = await _dir(id, root, parts.slice(0, -1).join('/'), create);
      return parent.getDirectoryHandle(parts[parts.length - 1], { create });
    })();
    _dirs.set(key, made);
    made.catch(() => { if (_dirs.get(key) === made) _dirs.delete(key); });
    hit = made;
  }
  try { return await hit; } catch (e) {
    if (_nameOf(e) !== 'NotFoundError' || !create || retried) throw e;
    for (let i = 1; i < parts.length; i++) _dirs.delete(`${id}\0${parts.slice(0, i).join('/')}`);
    _forget(id, parts.join('/'));
    return _dir(id, root, path, create, true);
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
 * new one is complete. Resolves the file as written.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @param {Blob | string} data
 * @param {boolean} [retried] @returns {Promise<File>} */
export async function writeFile(id, root, path, data, retried = false) {
  const [dir, name] = _split(path);
  let handle;
  try { handle = await (await _dir(id, root, dir, true)).getFileHandle(name, { create: true }); } catch (e) {
    // A folder remembered here was deleted meanwhile: looked up (and made) again.
    if (_nameOf(e) !== 'NotFoundError' || retried) throw e;
    _forget(id, dir);
    return writeFile(id, root, path, data, true);
  }
  const stream = await handle.createWritable();
  /** @type {any} */ (stream).__shioriKind = 'folder';   // disk-writes.js counts it as the folder's
  try { await stream.write(data); await stream.close(); } catch (e) { try { await stream.abort(); } catch {} throw e; }
  const file = await handle.getFile();
  _count(name, file.size);
  return file;
}

/** The file at `path` inside the folder, or null when it isn't there (nor any file by that name: a
 * folder is). One that can't be read is thrown.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<File | null>} */
async function _fileAt(id, root, path) {
  const [dir, name] = _split(path);
  try {
    return await (await (await _dir(id, root, dir, false)).getFileHandle(name)).getFile();
  } catch (e) {
    if (_nameOf(e) === 'NotFoundError') _forget(id, dir);
    if (_nameOf(e) === 'NotFoundError' || _nameOf(e) === 'TypeMismatchError') return null;
    throw e;
  }
}
/** The same, as `type` when it differs from what the browser gives it.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @param {string} [type]
 * @returns {Promise<Blob | null>} */
export async function readFile(id, root, path, type) {
  const file = await _fileAt(id, root, path);
  return file && type && file.type !== type ? file.slice(0, file.size, type) : file;
}

/** The text of the file at `path` inside the folder, or null when it isn't there — an error reading
 * it is thrown (never taken for a file that isn't there).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<string | null>} */
export async function readText(id, root, path) {
  const [dir, name] = _split(path);
  try {
    const file = await (await (await _dir(id, root, dir, false)).getFileHandle(name)).getFile();
    return await file.text();
  } catch (e) {
    if (_nameOf(e) === 'NotFoundError') return null;
    throw e;
  }
}

/** The file at `path` deleted (nothing when it isn't there).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<void>} */
export async function removeFile(id, root, path) {
  const [dir, name] = _split(path);
  try { await (await _dir(id, root, dir, false)).removeEntry(name); } catch (e) {
    if (_nameOf(e) !== 'NotFoundError') throw e;
  }
}

/** The folder at `path` deleted with everything in it (nothing when it isn't there).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<void>} */
export async function removeDir(id, root, path) {
  const [dir, name] = _split(path);
  if (!name) return;
  _forget(id, _parts(path).join('/'));
  try { await (await _dir(id, root, dir, false)).removeEntry(name, { recursive: true }); } catch (e) {
    if (_nameOf(e) !== 'NotFoundError') throw e;
  }
}

/** What the folder at `path` holds (none when it isn't there).
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} [path] @returns {Promise<Listed[]>} */
export async function list(id, root, path = '') {
  /** @type {Listed[]} */
  const out = [];
  try {
    for await (const [name, handle] of (await _dir(id, root, path, false)).entries()) {
      out.push({ name, kind: handle.kind, file: () => /** @type {FileSystemFileHandle} */ (handle).getFile() });
    }
  } catch (e) { if (_nameOf(e) !== 'NotFoundError') throw e; }
  return out;
}

/** Whether there is anything at `path` inside the folder.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} path @returns {Promise<boolean>} */
async function _taken(id, root, path) {
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

/** A folder of its own for a new gallery at the top of the folder, named `base` — or "base (2)" and so
 * on when that is taken — made and bound to the gallery at once: its metadata.json (`metadata`, the
 * gallery's description, naming its id) is written while lock shiori:dirs:<folder> is held, so no two
 * galleries, in any tab or the service worker, are given one folder, and the folder says whose it is.
 * Resolves its name.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} base @param {string} metadata
 * @returns {Promise<string>} */
export function reserveDir(id, root, base, metadata) {
  return withLock(`shiori:dirs:${id}`, async () => {
    let name = base;
    for (let i = 2; await _taken(id, root, name); i++) name = `${base} (${i})`;
    await writeFile(id, root, `${name}/metadata.json`, metadata);
    return name;
  });
}

/** `data` written to `path` in folder `dir` of the folder under a name no file has: `path` itself when
 * nothing is there, else `path` with a random part added before its extension (images/0001.webp →
 * images/0001-3fa2c9e1.webp: gallery-files.js pageNumberOf reads both), so a file something refers to
 * is never written over. Resolves { path, file }: where it went (in `dir`), and the file as written.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {string} dir @param {string} path
 * @param {Blob | string} data @returns {Promise<{ path: string, file: File }>} */
export async function writeNew(id, root, dir, path, data) {
  let at = path;
  while (await _taken(id, root, `${dir}/${at}`)) at = path.replace(/(\.[^./]*)?$/, (ext) => `-${_randomPart()}${ext}`);
  return { path: at, file: await writeFile(id, root, `${dir}/${at}`, data) };
}
const _randomPart = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');

// ── The contract ──
/** @param {...string} parts @returns {string} */
const _join = (...parts) => parts.filter(Boolean).join('/');
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
/** @param {string} what @returns {() => Promise<never>} */
const _notYet = (what) => () => Promise.reject(new Error(`no ${what} before format v2 (S4)`));

/** Library folder `id` (its handle `root`), opened for `purpose`.
 * @param {string} id @param {FileSystemDirectoryHandle} root @param {Purpose} purpose @returns {WriteRoot} */
function _root(id, root, purpose) {
  // Gallery `gid`'s directory `name`: written by writeNew, its files deleted one by one by name (as
  // db.js lets go of them). The website writes no temporary files of its own (createWritable writes a
  // file whole), so there is nothing to sweep.
  /** @param {string} name @param {string} gid @returns {GalleryDir} */
  const galleryDir = (name, gid) => ({
    name, gid,
    manifest: _notYet('manifest'),
    read: (rel) => _read(id, root, _join(name, rel)),
    async writeNew(slot, ext, bytes) {
      const { path, file } = await writeNew(id, root, name, `${slot}.${ext}`, new Blob([/** @type {BlobPart} */ (bytes)]));
      return { name: path, size: file.size, mtime: file.lastModified };
    },
    publish: _notYet('publish'),
    async deleteNamed(files) {
      /** @type {string[]} */
      const deleted = [];
      /** @type {{ name: string, why: 'unreadable' }[]} */
      const kept = [];
      for (const f of files) {
        try { await removeFile(id, root, _join(name, f.name)); deleted.push(f.name); } catch { kept.push({ name: f.name, why: 'unreadable' }); }
      }
      return { deleted, kept };
    },
    sweep: async () => ({ removed: [] }),
  });
  return {
    id, purpose,
    read: (rel) => _read(id, root, rel),
    list: (rel) => _list(id, root, rel),
    // The directory is the gallery's unless its metadata.json names another (db.js _mayWriteDir).
    async gallery(name, gid) {
      const [parent, base] = _split(name);
      const there = (await list(id, root, parent).catch(() => [])).some(e => e.name === base && e.kind === 'directory');
      if (!there) return MISSING;
      const named = galleryIdOf(await readText(id, root, `${name}/metadata.json`).catch(() => null));
      return named != null && named !== String(gid) ? { kind: 'conflict', found: named } : { kind: 'ok', dir: galleryDir(name, String(gid)) };
    },
    // A free directory named after the hint, bound to the gallery by its metadata.json (reserveDir).
    async reserve(hint, gid) {
      const metadata = JSON.stringify({ galleryId: String(gid), title: { english: hint, japanese: '', pretty: '' } });
      return galleryDir(await reserveDir(id, root, hint, metadata), String(gid));
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
 * holds its claim, and this page's permission for it (permission()) — null for one it doesn't have.
 * @typedef {(id: string) => Promise<{ handle: FileSystemDirectoryHandle, state: string, owned: boolean,
 *   permission: string } | null>} Gate */
/** The adapter over the library's gate.
 * @param {Gate} gate @returns {import('./contract.js').FolderStore<FileSystemDirectoryHandle>} */
export function folderStore(gate) {
  return {
    /** @param {import('./contract.js').FolderRef<FileSystemDirectoryHandle>} ref @param {{ purpose: Purpose }} options */
    async open(ref, { purpose }) {
      const f = await gate(ref.id);
      if (!f || f.permission === 'unavailable') return refused('unavailable');
      if (f.permission !== 'granted') return refused('no-permission');
      const why = refusalFor({ state: f.state, owned: f.owned, reachable: true }, purpose);
      return why ? refused(why) : { status: 'ok', root: _root(ref.id, f.handle, purpose) };
    },
  };
}

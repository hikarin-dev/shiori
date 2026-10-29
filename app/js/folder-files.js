// folder-files.js — the files of galleries a browser library keeps in folders the person picked
// (the File System Access API): each gallery a folder of its own inside one of them, in the gallery
// format (gallery-files.js). db.js keeps the records and decides what goes where; this module only
// reads, writes and deletes files, given a folder's handle. Nothing here asks the person anything
// unless asked to (`permission(handle, { ask: true })`, from a click).
//
// A folder is reached through its handle; the folders inside it are looked up once and remembered
// (by the folder's id and their path), and forgotten when one turns out to be gone.

const _dirs = new Map();   // `${folderId}\0${path}` → Promise<FileSystemDirectoryHandle>

// Whether this browser can keep a library in a folder at all.
export const supported = () => typeof globalThis.showDirectoryPicker === 'function';

// What this page may do with the folder: 'granted', 'prompt' (one click lets it), 'denied', or
// 'unavailable' (no such folder any more, or a handle this browser can't use). `ask` asks the person
// when it would otherwise be 'prompt' — only from a click.
export async function permission(handle, { ask = false } = {}) {
  if (typeof handle?.queryPermission !== 'function') return 'unavailable';
  try {
    let state = await handle.queryPermission({ mode: 'readwrite' });
    if (state === 'prompt' && ask && typeof handle.requestPermission === 'function') state = await handle.requestPermission({ mode: 'readwrite' });
    if (state !== 'granted') return state;
    await handle.keys().next();   // still there (a drive taken away answers NotFoundError)
    return 'granted';
  } catch (e) {
    return e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'prompt' : 'unavailable';
  }
}

const _parts = (path) => String(path ?? '').split('/').filter(Boolean);

// The folder at `path` inside folder `root` (made when `create`). Throws NotFoundError when it isn't
// there.
async function _dir(id, root, path, create) {
  const parts = _parts(path);
  if (!parts.length) return root;
  const key = `${id}\0${parts.join('/')}`;
  let hit = _dirs.get(key);
  if (!hit) {
    hit = (async () => {
      const parent = await _dir(id, root, parts.slice(0, -1).join('/'), create);
      return parent.getDirectoryHandle(parts[parts.length - 1], { create });
    })();
    _dirs.set(key, hit);
    hit.catch(() => { if (_dirs.get(key) === hit) _dirs.delete(key); });
  }
  try { return await hit; } catch (e) {
    if (e?.name === 'NotFoundError' && create) { _forget(id, parts.join('/')); return _dir(id, root, path, create); }
    throw e;
  }
}

// What is remembered about `path` and everything inside it.
function _forget(id, path = '') {
  const prefix = `${id}\0${path}`;
  for (const key of [..._dirs.keys()]) if (!path || key === prefix || key.startsWith(prefix + '/')) _dirs.delete(key);
  if (!path) for (const key of [..._dirs.keys()]) if (key.startsWith(`${id}\0`)) _dirs.delete(key);
}
export const forgetFolder = (id) => _forget(id);

const _split = (path) => { const parts = _parts(path); return [parts.slice(0, -1).join('/'), parts[parts.length - 1]]; };

// `data` (a Blob or a string) written whole to `path` inside the folder — the file it replaces stays
// as it was until the new one is complete. Resolves the file as written.
export async function writeFile(id, root, path, data, retried = false) {
  const [dir, name] = _split(path);
  let handle;
  try { handle = await (await _dir(id, root, dir, true)).getFileHandle(name, { create: true }); } catch (e) {
    // A folder remembered here was deleted meanwhile: looked up (and made) again.
    if (e?.name !== 'NotFoundError' || retried) throw e;
    _forget(id, dir);
    return writeFile(id, root, path, data, true);
  }
  const stream = await handle.createWritable();
  stream.__shioriKind = 'folder';
  try { await stream.write(data); await stream.close(); } catch (e) { try { await stream.abort(); } catch {} throw e; }
  return handle.getFile();
}

// The file at `path` inside the folder (as `type`, when it differs from what the browser gives it),
// or null when it isn't there or can't be read.
export async function readFile(id, root, path, type) {
  const [dir, name] = _split(path);
  try {
    const file = await (await (await _dir(id, root, dir, false)).getFileHandle(name)).getFile();
    return type && file.type !== type ? file.slice(0, file.size, type) : file;
  } catch (e) {
    if (e?.name === 'NotFoundError') _forget(id, dir);
    return null;
  }
}

// The text of the file at `path` inside the folder, or null when it isn't there — an error reading
// it is thrown (never taken for a file that isn't there).
export async function readText(id, root, path) {
  const [dir, name] = _split(path);
  try {
    const file = await (await (await _dir(id, root, dir, false)).getFileHandle(name)).getFile();
    return await file.text();
  } catch (e) {
    if (e?.name === 'NotFoundError') return null;
    throw e;
  }
}

// The file at `path` deleted (nothing when it isn't there).
export async function removeFile(id, root, path) {
  const [dir, name] = _split(path);
  try { await (await _dir(id, root, dir, false)).removeEntry(name); } catch (e) {
    if (e?.name !== 'NotFoundError') throw e;
  }
}

// The folder at `path` deleted with everything in it (nothing when it isn't there).
export async function removeDir(id, root, path) {
  const [dir, name] = _split(path);
  if (!name) return;
  _forget(id, _parts(path).join('/'));
  try { await (await _dir(id, root, dir, false)).removeEntry(name, { recursive: true }); } catch (e) {
    if (e?.name !== 'NotFoundError') throw e;
  }
}

// What the folder at `path` holds: [{ name, kind: 'file'|'directory', handle }] (none when it isn't there).
export async function list(id, root, path = '') {
  const out = [];
  try {
    for await (const [name, handle] of (await _dir(id, root, path, false)).entries()) out.push({ name, kind: handle.kind, handle });
  } catch (e) { if (e?.name !== 'NotFoundError') throw e; }
  return out;
}

// Whether there is anything at `path` inside the folder.
async function _taken(id, root, path) {
  const [dir, name] = _split(path);
  try {
    const parent = await _dir(id, root, dir, false);
    try { await parent.getDirectoryHandle(name); return true; } catch (e) { if (e?.name === 'TypeMismatchError') return true; if (e?.name !== 'NotFoundError') throw e; }
    return false;
  } catch (e) { if (e?.name === 'NotFoundError') return false; throw e; }
}

// A folder made for a new gallery at the top of the folder, named `base` — or "base (2)" and so on
// when that is taken. Resolves its name.
export async function claimDir(id, root, base) {
  let name = base;
  for (let i = 2; await _taken(id, root, name); i++) name = `${base} (${i})`;
  await _dir(id, root, name, true);
  return name;
}

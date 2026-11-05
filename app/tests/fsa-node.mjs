// fsa-node.mjs — the File System Access API for Node over real folders (plan §6.4), so the website's
// library code runs in npm test on the same temporary folders the desktop's does. Written for these
// tests rather than taken from native-file-system-adapter, whose Node adapter writes a file in place
// (Chrome writes a swap file and puts it in place whole on close), always answers 'granted' and has no
// way to fail a call (plans/library-storage-plan.md §10, S2).
//
// What it does as Chrome does on a local disk:
// - a handle walks one name at a time; names with a separator, '.', '..' or none are a TypeError;
// - getFileHandle({ create }) makes an empty file at once; createWritable writes to `<name>.crswap`
//   beside the file (a copy of it with keepExistingData) and close() renames that over the file in one
//   step, so the file is the old one whole or the new one whole; abort() drops the swap file;
// - errors are DOMExceptions named as Chrome names them: NotFoundError (nothing there, or a folder
//   taken away), TypeMismatchError (a file where a folder was asked for, or the reverse),
//   InvalidModificationError (removeEntry of a folder that isn't empty, without `recursive`),
//   NotAllowedError (no permission);
// - a link (symbolic or a junction) is followed, as File System Access can't tell one from its target;
// - a handle put in IndexedDB (fake-indexeddb clones with structuredClone) comes back as a handle to
//   the same place (install()).
// What it does differently: getFile() reads the file whole at once (Chrome's File reads it later, and
// fails once the file changed) — the tests use kilobyte files.
//
// For the tests:
// - directory(path): a folder's handle, as the folder picker gives it;
// - failNext(when, name, { times }): the next `times` calls `when(call)` matches fail with a
//   DOMException `name` — `call` is { op, path }: `op` getDirectoryHandle, getFileHandle, removeEntry,
//   entries, getFile, createWritable, write or close, `path` the target's path relative to the folder
//   picked, '/'-separated (for removeEntry and the get…Handle calls, the entry's);
// - setPermission(path, state, { onRequest }): what queryPermission answers for the folder picked at
//   `path` and everything in it ('granted', 'prompt', 'denied'), and what requestPermission turns it
//   into; a call without permission fails with NotAllowedError;
// - onCall(fn): `fn(call)` told of every call, for counting what was read or written.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  json: 'application/json', txt: 'text/plain', zip: 'application/zip', cbz: 'application/vnd.comicbook+zip', pdf: 'application/pdf', xml: 'text/xml' };
const typeOf = (name) => TYPES[String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase()] || '';
const domError = (name, message) => new DOMException(message, name);
const SWAP = '.crswap';

// ── Faults, permissions and listeners ──
/** @type {{ when: (call: { op: string, path: string }) => boolean, name: string, times: number }[]} */
let faults = [];
const permissions = new Map();   // folder picked (its path) → { state, onRequest }
/** @type {Set<(call: { op: string, path: string }) => void>} */
const listeners = new Set();

/** The next `times` calls `when` matches fail with a DOMException `name`. Resolves a function that
 * takes the fault back (it is taken back by itself once used up). */
export function failNext(when, name = 'NotReadableError', { times = 1 } = {}) {
  const fault = { when, name, times };
  faults.push(fault);
  return () => { faults = faults.filter(f => f !== fault); };
}
/** No faults, every folder permitted, nobody listening. */
export function reset() { faults = []; permissions.clear(); listeners.clear(); }
/** @param {string} root @param {'granted' | 'prompt' | 'denied'} state
 * @param {{ onRequest?: () => 'granted' | 'prompt' | 'denied' }} [options] */
export function setPermission(root, state, { onRequest = () => 'granted' } = {}) { permissions.set(path.resolve(root), { state, onRequest }); }
/** @param {(call: { op: string, path: string }) => void} fn */
export function onCall(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const stateOf = (root) => permissions.get(root)?.state ?? 'granted';
// Call `op` on `abs` (under folder `root`) about to run: refused without permission, failed by a
// fault, heard by the listeners.
function call(root, abs, op) {
  const heard = { op, path: path.relative(root, abs).split(path.sep).filter(Boolean).join('/') };
  for (const fn of listeners) fn(heard);
  if (stateOf(root) !== 'granted') throw domError('NotAllowedError', `no permission for ${root}`);
  const fault = faults.find(f => f.when(heard));
  if (!fault) return;
  if (--fault.times <= 0) faults = faults.filter(f => f !== fault);
  throw domError(fault.name, `${fault.name}: injected, ${op} '${heard.path}'`);
}
function childName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new TypeError(`Name is not allowed: '${name}'`);
  return name;
}
// The node error `e` as File System Access reports it.
function asDom(e, what) {
  if (e instanceof DOMException) return e;
  if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return domError('NotFoundError', `${what}: ${e.code}`);
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return domError('NoModificationAllowedError', `${what}: ${e.code}`);
  if (e?.code === 'ENOTEMPTY') return domError('InvalidModificationError', `${what}: ${e.code}`);
  return domError('InvalidStateError', `${what}: ${e?.message || e}`);
}
const statOf = (abs) => fsp.stat(abs).catch((e) => { if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return null; throw e; });
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// ── Handles ──
class Handle {
  /** @param {string} root @param {string} abs @param {'file' | 'directory'} kind */
  constructor(root, abs, kind) {
    this.kind = kind;
    this.name = path.basename(abs);
    Object.defineProperty(this, '_at', { value: { root, abs }, enumerable: true });
  }
  /** @param {Handle} other */
  async isSameEntry(other) { return other instanceof Handle && other.kind === this.kind && same(other._at.abs, this._at.abs); }
  async queryPermission() { return stateOf(this._at.root); }
  async requestPermission() {
    const p = permissions.get(this._at.root);
    if (!p || p.state === 'granted') return 'granted';
    p.state = p.onRequest();
    return p.state;
  }
}

class DirectoryHandle extends Handle {
  /** @param {string} root @param {string} abs */
  constructor(root, abs) { super(root, abs, 'directory'); }
  async #child(name, op, kind, create) {
    const abs = path.join(this._at.abs, childName(name));
    call(this._at.root, abs, op);
    try {
      if (!(await statOf(this._at.abs))?.isDirectory()) throw domError('NotFoundError', `${this._at.abs} is gone`);
      const st = await statOf(abs);
      if (st && st.isDirectory() !== (kind === 'directory')) throw domError('TypeMismatchError', `${abs} is not a ${kind}`);
      if (!st) {
        if (!create) throw domError('NotFoundError', `${abs} is not there`);
        if (kind === 'directory') await fsp.mkdir(abs); else await fsp.writeFile(abs, '', { flag: 'wx' }).catch((e) => { if (e?.code !== 'EEXIST') throw e; });
      }
    } catch (e) { throw asDom(e, op); }
    return kind === 'directory' ? new DirectoryHandle(this._at.root, abs) : new FileHandle(this._at.root, abs);
  }
  /** @param {string} name @param {{ create?: boolean }} [options] */
  getDirectoryHandle(name, { create = false } = {}) { return this.#child(name, 'getDirectoryHandle', 'directory', create); }
  /** @param {string} name @param {{ create?: boolean }} [options] */
  getFileHandle(name, { create = false } = {}) { return this.#child(name, 'getFileHandle', 'file', create); }
  /** @param {string} name @param {{ recursive?: boolean }} [options] */
  async removeEntry(name, { recursive = false } = {}) {
    const abs = path.join(this._at.abs, childName(name));
    call(this._at.root, abs, 'removeEntry');
    try {
      const st = await fsp.lstat(abs);
      if (st.isDirectory() || (st.isSymbolicLink() && (await statOf(abs))?.isDirectory())) {
        if (!recursive && (await fsp.readdir(abs)).length) throw domError('InvalidModificationError', `${abs} is not empty`);
        await fsp.rm(abs, { recursive: true });
      } else await fsp.unlink(abs);
    } catch (e) { throw asDom(e, 'removeEntry'); }
  }
  async *entries() {
    call(this._at.root, this._at.abs, 'entries');
    let names;
    try { names = await fsp.readdir(this._at.abs); } catch (e) { throw asDom(e, 'entries'); }
    for (const name of names) {
      const abs = path.join(this._at.abs, name);
      const st = await statOf(abs);
      if (st) yield /** @type {[string, Handle]} */ ([name, st.isDirectory() ? new DirectoryHandle(this._at.root, abs) : new FileHandle(this._at.root, abs)]);
    }
  }
  async *keys() { for await (const [name] of this.entries()) yield name; }
  async *values() { for await (const [, handle] of this.entries()) yield handle; }
  [Symbol.asyncIterator]() { return this.entries(); }
  /** The names leading from this folder to `other`, or null when it isn't inside it.
   * @param {Handle} other */
  async resolve(other) {
    if (!(other instanceof Handle)) return null;
    const rel = path.relative(this._at.abs, other._at.abs);
    if (rel === '') return [];
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep);
  }
}

class FileHandle extends Handle {
  /** @param {string} root @param {string} abs */
  constructor(root, abs) { super(root, abs, 'file'); }
  async getFile() {
    call(this._at.root, this._at.abs, 'getFile');
    try {
      const [bytes, st] = await Promise.all([fsp.readFile(this._at.abs), fsp.stat(this._at.abs)]);
      return new File([bytes], this.name, { type: typeOf(this.name), lastModified: Math.floor(st.mtimeMs) });
    } catch (e) { throw asDom(e, 'getFile'); }
  }
  /** @param {{ keepExistingData?: boolean }} [options] */
  async createWritable({ keepExistingData = false } = {}) {
    const { root, abs } = this._at;
    call(root, abs, 'createWritable');
    const swap = abs + SWAP;
    try {
      if (!(await statOf(abs))) throw domError('NotFoundError', `${abs} is not there`);
      if (keepExistingData) await fsp.copyFile(abs, swap); else await fsp.writeFile(swap, '');
    } catch (e) { throw asDom(e, 'createWritable'); }
    return new WritableFileStream(root, abs, swap);
  }
}

class WritableFileStream {
  #root; #abs; #swap; #at = 0; #done = false;
  /** @param {string} root @param {string} abs @param {string} swap */
  constructor(root, abs, swap) { this.#root = root; this.#abs = abs; this.#swap = swap; }
  #open() { if (this.#done) throw new TypeError('the stream is closed'); }
  /** @param {any} data a Blob, BufferSource or string, or { type: 'write' | 'seek' | 'truncate', … } */
  async write(data) {
    this.#open();
    call(this.#root, this.#abs, 'write');
    try {
      if (data && typeof data === 'object' && 'type' in data && !(data instanceof Blob)) {
        if (data.type === 'seek') { this.#at = data.position; return; }
        if (data.type === 'truncate') { await fsp.truncate(this.#swap, data.size); this.#at = Math.min(this.#at, data.size); return; }
        if (Number.isInteger(data.position)) this.#at = data.position;
        data = data.data;
      }
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer())
        : typeof data === 'string' ? new TextEncoder().encode(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      const fh = await fsp.open(this.#swap, 'r+');
      try { await fh.write(bytes, 0, bytes.length, this.#at); } finally { await fh.close(); }
      this.#at += bytes.length;
    } catch (e) { throw asDom(e, 'write'); }
  }
  /** @param {number} position */
  seek(position) { return this.write({ type: 'seek', position }); }
  /** @param {number} size */
  truncate(size) { return this.write({ type: 'truncate', size }); }
  async close() {
    this.#open();
    call(this.#root, this.#abs, 'close');
    this.#done = true;
    try { await fsp.rename(this.#swap, this.#abs); } catch (e) { await fsp.rm(this.#swap, { force: true }).catch(() => {}); throw asDom(e, 'close'); }
  }
  async abort() {
    this.#done = true;
    await fsp.rm(this.#swap, { force: true }).catch(() => {});
  }
}

/** The folder at `dir` as the folder picker hands it over (made when it isn't there).
 * @param {string} dir @returns {DirectoryHandle} */
export function directory(dir) {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  return new DirectoryHandle(abs, abs);
}

// ── Into the global scope ──
// A handle through structuredClone (how fake-indexeddb stores a record) comes back as a handle: a
// clone holds its place as a plain { kind, name, _at }, turned back into a handle as it is read.
const isPlain = (v) => v !== null && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype);
function revive(v) {
  if (!isPlain(v)) return v;
  if (!Array.isArray(v) && (v.kind === 'file' || v.kind === 'directory') && isPlain(v._at) && typeof v._at.abs === 'string') {
    return v.kind === 'directory' ? new DirectoryHandle(v._at.root, v._at.abs) : new FileHandle(v._at.root, v._at.abs);
  }
  for (const k of Object.keys(v)) v[k] = revive(v[k]);
  return v;
}
let installed = false;
/** Puts File System Access where the website's code looks for it: showDirectoryPicker (folder-store-web.js
 * supported() asks for it; the tests hand folders over with directory()) and a structuredClone that
 * keeps handles. */
export function install() {
  if (installed) return;
  installed = true;
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = (value, options) => revive(clone(value, options));
  globalThis.showDirectoryPicker = async () => { throw domError('AbortError', 'no folder is picked in tests'); };
}

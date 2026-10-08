// disk-writes.js — counts every byte the app writes to this browser's storage: IndexedDB records in
// every database and store, localStorage, the offline app files in Cache Storage, and files written
// through the File System Access API (an import's staging copy in OPFS, a backup saved through a
// save dialog) — and the files the person saves (exports, backups), as they are saved. It hooks the
// storage APIs themselves, once per context (pages, the agent, the service worker), so no writer
// can slip past it — including a record put back to change one field, which the browser rewrites
// whole, images and all. It counts what the app asks the browser to store; the browser's own
// bookkeeping on top (indexes, logs, compaction) and deletions (small markers) aren't visible here.
//
// Counts are grouped by kind and handed in batches to the store registered with meterWrites().

const _pending = new Map();      // kind → bytes counted since the last hand-off
const _txBytes = new WeakMap();  // IndexedDB transaction → Map(kind → bytes), counted when it commits
const _ignored = new WeakSet();  // the counter's own transactions
let _store = null, _timer = null;

const _strBytes = (s) => (/[^\u0000-ÿ]/.test(s) ? s.length * 2 : s.length);

// Roughly what a value takes once stored: a Blob's bytes, strings at one or two bytes a character,
// numbers eight, and objects the sum of their keys and values.
export function valueBytes(value, seen = new Set()) {
  if (value == null) return 1;
  switch (typeof value) {
    case 'string': return _strBytes(value);
    case 'number': case 'bigint': return 8;
    case 'boolean': return 1;
    case 'object': break;
    default: return 0;
  }
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof Date) return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  let bytes = 2;
  if (value instanceof Map) { for (const [k, v] of value) bytes += valueBytes(k, seen) + valueBytes(v, seen); return bytes; }
  if (value instanceof Set || Array.isArray(value)) { for (const v of value) bytes += valueBytes(v, seen); return bytes; }
  for (const key of Object.keys(value)) bytes += _strBytes(key) + valueBytes(value[key], seen);
  return bytes;
}

function _add(kind, bytes) {
  if (!bytes) return;
  _pending.set(kind, (_pending.get(kind) || 0) + bytes);
  if (_store && !_timer) _timer = setTimeout(flushWrites, 2000);
}

// Hand the counted bytes to the store now (also when a page is hidden, so a closing tab keeps them).
export async function flushWrites() {
  clearTimeout(_timer);
  _timer = null;
  if (!_store || !_pending.size) return;
  const batch = Object.fromEntries(_pending);
  _pending.clear();
  try { await _store(batch); } catch { for (const [kind, bytes] of Object.entries(batch)) _add(kind, bytes); }
}

// `store(batch)` keeps the totals ({ kind: bytes }); its own writes must pass through ignoreWrites.
export function meterWrites(store) {
  _store = store;
  if (_pending.size && !_timer) _timer = setTimeout(flushWrites, 2000);
}
export const ignoreWrites = (transaction) => { _ignored.add(transaction); };

// ── IndexedDB ─────────────────────────────────────────────────────────────────────────────────
// Library records by store (a stored image by whose it is); the job queue's database is one kind.
const _LIBRARY = { images: 'pages', covers: 'covers' };
const _kind = (tx, store, value) => (tx.db.name !== 'shiori-cache' ? (tx.db.name === 'shiori-jobs' ? 'jobs' : 'other')
  : store === 'blobs' ? (String(value?.id).startsWith('cover|') ? 'covers' : 'pages')
  : _LIBRARY[store] || 'library');

function _count(request, store, bytes, value) {
  const tx = request?.transaction;
  if (!tx || _ignored.has(tx)) return;
  let kinds = _txBytes.get(tx);
  if (!kinds) {
    kinds = new Map();
    _txBytes.set(tx, kinds);
    tx.addEventListener('complete', () => { for (const [kind, n] of kinds) _add(kind, n); });
  }
  const kind = _kind(tx, store, value);
  kinds.set(kind, (kinds.get(kind) || 0) + bytes);
}

if (typeof IDBObjectStore !== 'undefined') {
  for (const method of ['put', 'add']) {
    const original = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function (value, key) {
      const request = original.apply(this, arguments);
      _count(request, this.name, valueBytes(value) + (key === undefined ? 0 : valueBytes(key)), value);
      return request;
    };
  }
  const update = IDBCursor.prototype.update;
  IDBCursor.prototype.update = function (value) {
    const request = update.apply(this, arguments);
    const store = this.source instanceof IDBIndex ? this.source.objectStore : this.source;
    _count(request, store.name, valueBytes(value), value);
    return request;
  };
}

// ── localStorage ──────────────────────────────────────────────────────────────────────────────
if (typeof Storage !== 'undefined') {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    setItem.call(this, key, value);
    if (this === globalThis.localStorage) _add('settings', _strBytes(String(key)) + _strBytes(String(value)));
  };
}

// ── Cache Storage (the offline app files) ─────────────────────────────────────────────────────
if (typeof Cache !== 'undefined') {
  const sizeOf = (response) => response.blob().then(b => b.size, () => 0);
  const stored = (cache, request) => cache.match(request).then(r => (r ? sizeOf(r) : 0), () => 0);
  const put = Cache.prototype.put;
  Cache.prototype.put = function (request, response) {
    let size = Promise.resolve(0);
    try { size = sizeOf(response.clone()); } catch {}
    return put.apply(this, arguments).then((result) => { size.then(n => _add('app', n)); return result; });
  };
  const add = Cache.prototype.add;
  Cache.prototype.add = function (request) {
    return add.apply(this, arguments).then((result) => { stored(this, request).then(n => _add('app', n)); return result; });
  };
  const addAll = Cache.prototype.addAll;
  Cache.prototype.addAll = function (requests) {
    return addAll.apply(this, arguments).then((result) => {
      for (const request of requests) stored(this, request).then(n => _add('app', n));
      return result;
    });
  };
}

// ── Files written through the File System Access API ──────────────────────────────────────────
// An import's staging copy in OPFS by default; a stream to a file the person chose to save (a
// backup) is marked an export (writesAs).
const _streamKind = new WeakMap();
export const writesAs = (stream, kind) => { _streamKind.set(stream, kind); return stream; };
if (typeof FileSystemWritableFileStream !== 'undefined') {
  const write = FileSystemWritableFileStream.prototype.write;
  FileSystemWritableFileStream.prototype.write = function (data) {
    const params = data && typeof data === 'object' && 'type' in data && !(data instanceof Blob);
    const bytes = params ? (data.type === 'write' ? valueBytes(data.data) : 0) : valueBytes(data);
    return write.apply(this, arguments).then((result) => { _add(_streamKind.get(this) || 'staging', bytes); return result; });
  };
}

// ── Files the person saves (exports, backups) ─────────────────────────────────────────────────
// A download is a link with a file name to a Blob of the app's, counted when it is clicked. (The
// desktop app's window leaves it to the desktop app, which counts a download once it is written
// whole — a save dialog cancelled there writes nothing.)
if (typeof HTMLAnchorElement !== 'undefined' && !globalThis.shioriDesktop?.shell) {
  const sizes = new Map();   // object URL → its Blob's size (not pictures: those aren't saved)
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = function (object) {
    const url = create.apply(this, arguments);
    if (object instanceof Blob && !object.type.startsWith('image/')) sizes.set(url, object.size);
    return url;
  };
  URL.revokeObjectURL = function (url) { sizes.delete(url); return revoke.apply(this, arguments); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && sizes.has(this.href)) _add('exports', sizes.get(this.href));
    return click.apply(this, arguments);
  };
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushWrites(); });
}

// disk-writes.test.mjs — every byte the app asks the browser to store is counted: IndexedDB records
// in full each time they are put (the browser rewrites a record whole, images included), committed
// transactions only, localStorage, and none of the counter's own bookkeeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
globalThis.Storage = class {
  #values = new Map();
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
};
globalThis.localStorage = new Storage();

const { meterWrites, flushWrites, ignoreWrites, valueBytes } = await import('../js/disk-writes.js');

const batches = [];
meterWrites(async (batch) => { batches.push(batch); });
const counted = async () => {
  await flushWrites();
  const out = {};
  for (const batch of batches.splice(0)) for (const [kind, bytes] of Object.entries(batch)) out[kind] = (out[kind] || 0) + bytes;
  return out;
};

const open = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('shiori-cache', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('images', { keyPath: 'url' }); req.result.createObjectStore('metadata', { keyPath: 'galleryId' }); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const write = (db, store, fn, { abort = false, ignore = false } = {}) => new Promise((resolve) => {
  const tx = db.transaction(store, 'readwrite');
  if (ignore) ignoreWrites(tx);
  fn(tx.objectStore(store));
  if (abort) tx.abort();
  tx.oncomplete = () => resolve(true);
  tx.onabort = () => resolve(false);
});

test('a page record counts every byte each time it is put, not only the first', async () => {
  const db = await open();
  const record = { url: 'u', blob: new Blob([new Uint8Array(10000)]), galleryId: '1' };
  await write(db, 'images', s => s.put(record));
  const first = (await counted()).pages;
  assert.ok(first >= 10000 && first < 10100, `the image and its few fields (${first})`);
  await write(db, 'images', s => s.put({ ...record, own: 'j1' }));
  assert.ok((await counted()).pages >= 10000, 'changing one field rewrites the image too');
  await write(db, 'metadata', s => s.put({ galleryId: '1', title: 'タイトル' }));
  assert.equal((await counted()).library, valueBytes({ galleryId: '1', title: 'タイトル' }));
});

test('an aborted transaction and the counter\'s own writes count nothing; localStorage does', async () => {
  const db = await open();
  assert.equal(await write(db, 'images', s => s.put({ url: 'a', blob: new Blob([new Uint8Array(500)]) }), { abort: true }), false);
  await write(db, 'images', s => s.put({ url: 'b', blob: new Blob([new Uint8Array(500)]) }), { ignore: true });
  localStorage.setItem('shiori:readerView', '"translate"');
  assert.deepEqual(await counted(), { settings: 'shiori:readerView'.length + '"translate"'.length });
});

test('the totals add up in one place, the old page counter folded in once', async () => {
  localStorage.setItem('shiori:totalWrittenBytes', '5000');
  const platform = await import('../js/platform.js');
  await platform.writes.add({ pages: 100, settings: 10 });
  await platform.writes.add({ pages: 1 });
  const totals = await platform.writes.get();
  assert.deepEqual([totals.total, totals.by.pages, totals.by.settings], [5111, 5101, 10]);
  assert.equal(localStorage.getItem('shiori:totalWrittenBytes'), null);
  await platform.writes.reset();
  assert.equal((await platform.writes.get()).total, 0);
});

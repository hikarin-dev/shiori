// change-feed.test.mjs — every change is logged under a revision of the library, so a window that
// slept through the announcements catches up when it comes back instead of showing stale galleries,
// and a slower, older read never overwrites a newer one.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };   // announcements go nowhere
const listeners = new Map();
globalThis.window = {
  addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
  removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn)),
};
const comeBack = () => { for (const fn of listeners.get('focus') || []) fn(); };

const api = await import('../js/api.js');
const db = await import('../js/db.js');
const webp = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const settle = () => new Promise(r => setTimeout(r, 20));

test('each change is logged once per write, and since() names what changed after a revision', async () => {
  const start = await api.events.revision();
  const a = api.newGalleryId(), b = api.newGalleryId();
  await api.galleries.create(a, { title: title('A') });
  await api.pages.put(a, 1, webp());
  await api.meta.put({ galleryId: b, title: title('B') });
  const mid = await api.events.revision();
  assert.ok(mid > start);
  const all = await api.events.since(start);
  assert.deepEqual(all.gids.sort(), [a, b].sort());
  assert.equal(all.rev, mid);
  await api.derived.putTranslatedImage(a, 1, webp());
  const later = await api.events.since(mid);
  assert.deepEqual(later.gids, [a], 'only what changed after `mid`');
  assert.deepEqual((await api.events.since(later.rev)).gids, [], 'nothing after the newest revision');
});

test('a series command logs every gallery it touches', async () => {
  const [o, c] = [api.newGalleryId(), api.newGalleryId()];
  for (const gid of [o, c]) { await api.meta.put({ galleryId: gid, title: title(gid) }); await api.pages.put(gid, 1, webp()); }
  const rev = await api.events.revision();
  await api.series.attach(o, c);
  assert.deepEqual((await api.events.since(rev)).gids.sort(), [o, c].sort());
});

test('clearing the library tells every window to read everything again', async () => {
  const rev = await api.events.revision();
  await api.maintenance.clearAll();
  assert.equal((await api.events.since(rev)).resync, true);
  assert.ok(await api.events.revision() > rev, 'the revision keeps counting');
});

// The log keeps its newest entries and marks how far back it was trimmed; a window that last saw a
// revision before that mark can't be told what it missed.
test('a window further behind than the log reaches resyncs', async () => {
  const gid = api.newGalleryId();
  await api.meta.put({ galleryId: gid, title: title('X') });
  const old = await api.events.revision();
  await api.galleries.mutate(gid, { favorite: true }, { silent: true });
  await api.galleries.mutate(gid, { favorite: false }, { silent: true });
  const recent = await api.events.revision();
  // What trimming the log leaves behind, in whichever library the test runs on.
  if (globalThis.__desktopLibrary) globalThis.__desktopLibrary._kvSet('compactedUpTo', recent - 1);
  else await new Promise((resolve, reject) => {
    const open = indexedDB.open('shiori-cache');
    open.onsuccess = () => {
      const tx = open.result.transaction('changes', 'readwrite');
      tx.objectStore('changes').put({ rev: 'compacted', upTo: recent - 1 });
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
  assert.equal((await api.events.since(old)).resync, true);
  await api.galleries.mutate(gid, { favorite: true }, { silent: true });
  assert.deepEqual(await api.events.since(recent), { rev: recent + 1, gids: [gid], resync: false });
});

test('a window that comes back hears what changed while it wasn\'t listening', async () => {
  const heard = [];
  const stop = api.events.watch((gid, beacon) => heard.push([gid, beacon ? 'live' : 'caught up']));
  await settle();   // the watcher notes where the library stands
  const gid = api.newGalleryId();
  await api.meta.put({ galleryId: gid, title: title('Silent') }, { silent: true });
  await api.galleries.mutate(gid, { favorite: true }, { silent: true });
  assert.deepEqual(heard, [], 'silent writes announce nothing');
  comeBack();
  await settle();
  assert.deepEqual(heard, [[gid, 'caught up']]);
  comeBack();
  await settle();
  assert.equal(heard.length, 1, 'nothing new the second time');
  stop();
});

test('of two reads of one gallery, only the newer one lands in the store', async () => {
  const store = await import('../js/store.js');
  const gid = api.newGalleryId();
  const real = api.galleries.get;
  const pending = [];
  api.galleries.get = (id) => new Promise(resolve => pending.push((entity) => resolve(entity)));
  const first = store.load(gid);
  const second = store.load(gid);
  pending[1]({ id: gid, title: title('new') });   // the newer read lands first
  await second;
  pending[0]({ id: gid, title: title('old') });
  await first;
  api.galleries.get = real;
  assert.equal(store.get(gid).title.english, 'new');
});

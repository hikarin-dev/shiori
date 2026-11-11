// library-storage.test.mjs — the browser library's folder records, as IndexedDB keeps them (no
// folder is reached here: Node has no File System Access, so every folder reads as out of reach).
// A library from before IndexedDB 19 comes over with each folder in one state and nothing it still
// owed a folder lost (A06); a write to a gallery whose folder is out of the library is refused where
// it commits, whatever the call names (R09, A02), and never hangs; a change to a gallery kept in a
// folder is marked as not written there in its own transaction (R04). (Folders themselves:
// library-storage.browser.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
// These are the browser library's own records: run against the desktop library (npm run test:desktop),
// there are none to test.
const browserOnly = !!globalThis.__desktopLibrary;

const title = (english) => ({ english, japanese: '', pretty: '' });
const webp = () => new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 1])], { type: 'image/webp' });
const G1 = '1700000000001', G2 = '1700000000002', G3 = '1700000000003';

// A library as IndexedDB 18 left it (the installed working-tree build): a folder shown, one hidden,
// one removed by rounds 2–9 (dormant, never written back), one whose removal was cut short, this
// browser hidden; a gallery marked undescribed on its stat record, one naming a folder no longer
// known, one waiting in the browser for the removed folder.
await new Promise((resolve, reject) => {
  const open = indexedDB.open('shiori-cache', 18);
  open.onupgradeneeded = () => {
    const db = open.result;
    const folders = db.createObjectStore('folders', { keyPath: 'id' });
    const stats = db.createObjectStore('galleries', { keyPath: 'galleryId' });
    const metas = db.createObjectStore('metadata', { keyPath: 'galleryId' });
    folders.put({ id: 'a000000000000001', name: 'A', handle: null, addedAt: 1, claimEpoch: 3 });
    folders.put({ id: 'b000000000000002', name: 'B', handle: null, addedAt: 2, claimEpoch: 4, hidden: true, hiddenAt: 5 });
    folders.put({ id: 'c000000000000003', name: 'C', handle: null, addedAt: 3, dormant: true, removedAt: 6 });
    folders.put({ id: 'd000000000000004', name: 'D', handle: null, addedAt: 4, dormant: true, settingAside: true, moveTo: 'a000000000000001', removedAt: 7 });
    folders.put({ id: 'browser', hidden: true });
    folders.put({ id: '$default', folder: 'a000000000000001' });
    stats.put({ galleryId: G1, count: 0, size: 0, addedAt: 1, latestAt: 1, folder: 'a000000000000001', dir: 'G1', undescribed: 1 });
    stats.put({ galleryId: G2, count: 0, size: 0, addedAt: 1, latestAt: 1, folder: 'f00000000000000f', dir: 'Ghost', spilled: 1 });
    stats.put({ galleryId: G3, count: 0, size: 0, addedAt: 1, latestAt: 1, folder: 'c000000000000003', spilled: 1 });
    for (const gid of [G1, G2, G3]) metas.put({ galleryId: gid, title: title(gid) });
  };
  open.onsuccess = () => { open.result.close(); resolve(); };
  open.onerror = () => reject(open.error);
});

const api = await import('../js/api.js');
const db = await import('../js/db.js');

// A store's records as IndexedDB holds them.
async function raw(store, key) {
  const idb = await db.openDB();
  return new Promise((resolve, reject) => {
    const req = key == null ? idb.transaction(store).objectStore(store).getAll() : idb.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}
async function put(store, ...records) {
  const idb = await db.openDB();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction(store, 'readwrite');
    for (const r of records) tx.objectStore(store).put(r);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
const hidden = (e) => e?.code === 'invalid' && e.reason === 'hidden';

test('A06: IndexedDB 19 gives each folder one state, and a folder removed before removals wrote back is being removed again', { skip: browserOnly }, async () => {
  const byId = Object.fromEntries((await raw('folders')).map(r => [r.id, r]));
  assert.deepEqual(byId.a000000000000001, { id: 'a000000000000001', name: 'A', handle: null, addedAt: 1, epoch: 3, state: 'shown' });
  assert.equal(byId.b000000000000002.state, 'hidden');
  assert.equal(byId.b000000000000002.epoch, 4);
  assert.deepEqual(byId.c000000000000003.removal, { moveTo: null, discard: false, before: 'shown' }, 'rounds 2–9: written back before it is forgotten');
  assert.equal(byId.c000000000000003.state, 'removing');
  assert.deepEqual(byId.d000000000000004.removal, { moveTo: 'a000000000000001', discard: false, before: 'shown' }, 'a removal cut short keeps its move');
  assert.deepEqual(byId.browser, { id: 'browser', state: 'hidden' });
  for (const r of Object.values(byId)) for (const flag of ['hidden', 'dormant', 'settingAside', 'removedAt', 'hiddenAt', 'claimEpoch', 'moveTo']) assert.ok(!(flag in r), `${r.id}: ${flag} dropped`);
  const pending = (await api.folders.pending()).setAside.map(f => f.id).sort();
  assert.deepEqual(pending, ['c000000000000003', 'd000000000000004'], 'both removals carry on');
});

test('IndexedDB 19 keeps the unwritten-changes mark in a store of its own, and a gallery naming a forgotten folder is this browser\'s', { skip: browserOnly }, async () => {
  assert.deepEqual(await raw('undescribed', G1), { gid: G1, rev: 0 });
  assert.ok(!('undescribed' in await raw('galleries', G1)));
  const ghost = await raw('galleries', G2);
  for (const field of ['folder', 'dir', 'spilled']) assert.ok(!(field in ghost), `${field} dropped`);
  assert.equal((await raw('galleries', G3)).folder, 'c000000000000003', 'one of a folder being removed stays its');
});

test('A06: a removal that can\'t write back what only the library has is kept, the folder back as it was, its galleries kept', { skip: browserOnly }, async () => {
  await assert.rejects(api.folders.setAside('c000000000000003'), (e) => e.errorKey === 'lf.task_kept' && e.unsaved === 1);
  const folder = await raw('folders', 'c000000000000003');
  assert.equal(folder.state, 'shown');
  assert.ok(!('removal' in folder));
  assert.ok(await raw('galleries', G3), 'its gallery\'s records stay');
  assert.ok(await raw('metadata', G3));
});

test('R04: a change to a gallery kept in a folder marks it in its own transaction', { skip: browserOnly }, async () => {
  const before = await api.events.revision();
  await api.galleries.mutate(G1, { title: title('Edited') });
  const mark = await raw('undescribed', G1);
  assert.ok(mark.rev > before, 'marked with the revision of this change, before the write resolved');
  await api.folders.show('browser');
  await api.folders.setDefault('browser');
  const kept = api.newGalleryId();
  await api.galleries.create(kept, { title: title('Kept here') });
  assert.equal((await raw('galleries', kept)).folder, undefined);
  assert.equal(await raw('undescribed', kept), null, 'a gallery kept in this browser owes no folder anything');
});

test('R09, A02: a write to a gallery whose folder is hidden, being removed or forgotten is refused as it commits — never hangs, changes nothing', { skip: browserOnly }, async () => {
  const inHidden = api.newGalleryId(), inRemoving = api.newGalleryId(), inForgotten = api.newGalleryId();
  await put('folders', { id: 'e000000000000005', name: 'E', handle: null, addedAt: 5, epoch: 1, state: 'removing', removal: { moveTo: null, discard: false, before: 'shown' } });
  // The last: what a write still under way when its folder was forgotten would leave (a ghost).
  await put('galleries', { galleryId: inHidden, count: 0, size: 0, addedAt: 1, latestAt: 1, folder: 'b000000000000002', dir: 'H' },
    { galleryId: inRemoving, count: 0, size: 0, addedAt: 1, latestAt: 1, folder: 'e000000000000005', dir: 'R' },
    { galleryId: inForgotten, count: 0, size: 0, addedAt: 1, latestAt: 1, folder: 'f00000000000000f', dir: 'Gone' });
  await put('metadata', { galleryId: inHidden, title: title('Hidden') }, { galleryId: inRemoving, title: title('Leaving') },
    { galleryId: inForgotten, title: title('Forgotten') });
  const rev = await api.events.revision();
  for (const gid of [inHidden, inRemoving, inForgotten]) {
    await assert.rejects(api.meta.put({ galleryId: gid, title: title('Changed') }), hidden);
    await assert.rejects(api.galleries.mutate(gid, { title: title('Changed') }), hidden);
    await assert.rejects(api.personal.favorite(gid, true), hidden);
    await assert.rejects(api.pages.put(gid, 1, webp()), hidden);
    await assert.rejects(api.covers.put(gid, webp()), hidden);
    await assert.rejects(api.galleries.delete(gid), hidden);
    assert.equal((await raw('metadata', gid)).title.english !== 'Changed', true);
    assert.deepEqual(await api.pages.list(gid), []);
  }
  assert.equal(await api.events.revision(), rev, 'nothing was logged: nothing committed');
});

test('R09: a series command that touches a chapter in a hidden folder is refused whole', { skip: browserOnly }, async () => {
  const owner = api.newGalleryId(), chapter = api.newGalleryId();
  await put('galleries', { galleryId: owner, count: 1, size: 1, addedAt: 1, latestAt: 1 },
    { galleryId: chapter, count: 1, size: 1, addedAt: 1, latestAt: 1, parentId: owner, folder: 'b000000000000002', dir: 'Ch' });
  await put('metadata', { galleryId: owner, title: title('Owner'), chapters: [{ id: owner, title: '1' }, { id: chapter, title: '2' }] },
    { galleryId: chapter, title: title('Chapter'), parentId: owner });
  await assert.rejects(api.series.delete(owner), hidden);
  assert.ok(await raw('metadata', owner), 'the owner stays');
  assert.ok(await raw('metadata', chapter), 'the hidden chapter stays');
  await assert.rejects(api.galleries.move(owner, 'browser'), hidden);
});

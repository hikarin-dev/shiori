// library-folders.test.mjs — where the library is kept, as either backend answers it: one place or
// more, exactly one of them where new galleries go, every gallery in one of them, and a move to
// where a gallery already is moving nothing. (Folders themselves are covered where they can be
// made: the browser test library-folders.browser.mjs, the desktop test folders.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const api = await import('../js/api.js');
const webp = () => new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 1])], { type: 'image/webp' });

test('the library is kept in one place or more, new galleries going to exactly one', async () => {
  const places = await api.folders.list();
  assert.ok(places.length >= 1);
  assert.equal(places.filter(p => p.isDefault).length, 1);
  for (const p of places) {
    assert.ok(['browser', 'folder'].includes(p.kind));
    assert.ok(['granted', 'prompt', 'unavailable'].includes(p.access));
    assert.equal(typeof p.galleries, 'number');
    assert.equal(typeof p.size, 'number');
  }
  assert.equal(places.filter(p => !p.removable).length, 1, 'the first place stays');
});

test('a gallery is in one of the places, and moving it where it already is moves nothing', async () => {
  const gid = api.newGalleryId();
  await api.meta.put({ galleryId: gid, title: { english: 'Here', japanese: '', pretty: '' } });
  await api.pages.put(gid, 1, webp());
  const places = await api.folders.list();
  const { folder } = await api.galleries.get(gid);
  assert.ok(places.some(p => p.id === folder), 'its place is one of them');
  assert.equal(places.find(p => p.id === folder).isDefault, true, 'a new gallery went to the default');
  assert.deepEqual(await api.galleries.move(gid, folder), { moved: [] });
  assert.equal((await api.folders.list()).find(p => p.id === folder).galleries >= 1, true);
});

test('the default is where it was set, and a place that isn\'t there is refused', async () => {
  const places = await api.folders.list();
  const first = places[0];
  await api.folders.setDefault(first.id);
  assert.equal((await api.folders.list()).find(p => p.isDefault).id, first.id);
  await assert.rejects(api.folders.setDefault('nowhere'), (e) => e.code === 'not-found');
  await assert.rejects(api.galleries.move(api.newGalleryId(), 'nowhere'), (e) => e.code === 'not-found');
});

test('the default place is never hidden, and showing a place already shown brings nothing back', async () => {
  const def = (await api.folders.list()).find(p => p.isDefault);
  await assert.rejects(api.folders.hide(def.id), (e) => e.code === 'invalid' && e.reason === 'default');
  assert.deepEqual(await api.folders.show(def.id), { id: def.id, restored: 0 });
  assert.equal((await api.folders.list()).some(p => p.hidden), false);
  await assert.rejects(api.folders.hide('nowhere'), (e) => e.code === 'not-found');
});

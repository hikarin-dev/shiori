// db-put.test.mjs — dbPut's stat arithmetic on fake-indexeddb: re-puts never double-count,
// overwrites adjust the size delta, and a URL re-put under another gallery is a move that
// leaves BOTH galleries' stats truthful (the historical corruption: the new gallery absorbed
// a negative delta for bytes it never owned while the old gallery kept its count).
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const { dbPut, galleryGet, mutateGallery, metaGet, deleteGallery, getGalleryImageRecords, resolveGalleryId,
  listGalleryPageKeys, dbGetByGalleryPage, existingPageNums, coverRecordGet, rebuildGalleryEntry } = await import('../js/db.js');

const blobOf = (n) => new Blob([new Uint8Array(n)], { type: 'image/jpeg' });

test('an AVIF page is a page like any other: listed, found by number, and page 1 is the cover', async () => {
  await dbPut('local://AV/1.avif', new Blob([new Uint8Array(20)], { type: 'image/avif' }), 'AV', 'AV');
  await dbPut('local://AV/2.jpg', blobOf(10), 'AV', 'AV');
  assert.deepEqual((await listGalleryPageKeys('AV')).map((p) => p.pageNum), [1, 2]);
  assert.equal((await dbGetByGalleryPage('AV', 1))?.url, 'local://AV/1.avif');
  assert.deepEqual([...await existingPageNums('AV')].sort(), [1, 2]);
  assert.equal((await galleryGet('AV')).coverPage, 1);
  assert.equal((await coverRecordGet('AV')).cover.type, 'image/avif');
  await rebuildGalleryEntry('AV');
  assert.equal((await galleryGet('AV')).coverPage, 1, 'a rebuilt stat record agrees');
});

test('same-gallery re-put adjusts size and never double-counts', async () => {
  await dbPut('site://a/1.jpg', blobOf(100), 'A', 'A');
  await dbPut('site://a/2.jpg', blobOf(50), 'A', 'A');
  let a = await galleryGet('A');
  assert.equal(a.count, 2);
  assert.equal(a.size, 150);

  await dbPut('site://a/1.jpg', blobOf(70), 'A', 'A');   // overwrite page 1
  a = await galleryGet('A');
  assert.equal(a.count, 2, 're-putting an existing key must not double-count');
  assert.equal(a.size, 120, 'overwrite adjusts the size delta');
});

test('cross-gallery URL re-put is a move that keeps both galleries truthful', async () => {
  await dbPut('site://shared/1.jpg', blobOf(200), 'OLD', 'OLD');
  await dbPut('site://shared/2.jpg', blobOf(100), 'OLD', 'OLD');
  await dbPut('site://new/1.jpg', blobOf(10), 'NEW', 'NEW');

  await dbPut('site://shared/2.jpg', blobOf(80), 'NEW', 'NEW');   // page moves OLD → NEW

  const oldG = await galleryGet('OLD');
  const newG = await galleryGet('NEW');
  assert.equal(oldG.count, 1, 'the old gallery loses the moved page');
  assert.equal(oldG.size, 200, 'the old gallery sheds exactly the moved bytes');
  assert.equal(newG.count, 2, 'the new gallery gains the page');
  assert.equal(newG.size, 90, 'the new gallery carries only its own bytes');
});

test('mutateGallery writes metadata and stats as one logical mutation', async () => {
  await dbPut('site://m/1.jpg', blobOf(40), 'M', 'M');
  await mutateGallery('M', { source: 'somewhere', parentId: null, coverPage: 3 });
  const meta = await metaGet('M');
  const stat = await galleryGet('M');
  assert.equal(meta.source, 'somewhere');
  assert.equal(stat.coverPage, 3);
  assert.equal(stat.parentId, null, 'parentId is denormalized onto the stat record');
  assert.equal(meta.parentId, null);
});

test('a library upgrade (touch: false) keeps the gallery in its "Last updated" place', async () => {
  await dbPut('site://u/1.jpg', blobOf(10), 'U', 'U');
  const before = (await galleryGet('U')).latestAt;
  await new Promise(r => setTimeout(r, 5));
  await mutateGallery('U', { tags: [{ type: 'rating', name: 'safe', url: '' }] }, { touch: false });
  assert.equal((await galleryGet('U')).latestAt, before);
  assert.deepEqual((await metaGet('U')).tags, [{ type: 'rating', name: 'safe', url: '' }]);
  await mutateGallery('U', { tags: [] });
  assert.ok((await galleryGet('U')).latestAt > before, 'an ordinary edit still marks it updated');
});

test('resolving one source id repeatedly converges on one internal gallery', async () => {
  const [a, b] = await Promise.all([resolveGalleryId('4242'), resolveGalleryId('4242')]);
  const c = await resolveGalleryId('4242');
  assert.equal(a, b, 'concurrent resolves must not mint two internal ids');
  assert.equal(a, c, 'a later resolve must find the stub, not create another');
  assert.match(a, /^\d{13,}$/, 'internal ids are timestamp-length');
});

test('deleteGallery removes images, metadata, stats and covers together', async () => {
  await dbPut('site://d/1.jpg', blobOf(10), 'D', 'D');
  await mutateGallery('D', { source: 'x' });
  await deleteGallery('D');
  assert.equal(await galleryGet('D'), null);
  assert.equal(await metaGet('D'), null);
  assert.deepEqual(await getGalleryImageRecords('D'), []);
});

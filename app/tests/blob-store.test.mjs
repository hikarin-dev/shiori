// blob-store.test.mjs — every image is written once. Page and cover records hold references to
// their images, which live in their own store, so changing a record (its settings, a revert,
// study data arriving) never rewrites its images; readers still get Blobs; records stored before
// keep their images inline until they next change.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

const db = await import('../js/db.js');

// Every image written: [store, id, bytes].
const writes = [];
const put = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (value) {
  if (this.name === 'blobs') writes.push(value.id);
  return put.apply(this, arguments);
};
const written = () => writes.splice(0);
const blobIds = async () => {
  const conn = await db.openDB();
  return new Promise((resolve) => {
    const req = conn.transaction('blobs').objectStore('blobs').getAllKeys();
    req.onsuccess = () => resolve(req.result.map(String).sort());
  });
};
const png = (n, fill) => new Blob([new Uint8Array(n).fill(fill)], { type: 'image/png' });
const text = async (blob) => [...new Uint8Array(await blob.arrayBuffer())].slice(0, 3).join(',');

test('each image is written once; changing the page never writes it again', async () => {
  const gid = '600', url = `local://${gid}/1.png`;
  await db.metaPut({ galleryId: gid, title: { english: 'B', japanese: '', pretty: 'B' }, tags: [], numPages: 1 });
  await db.dbPut(url, png(900, 1), gid, gid);
  assert.deepEqual(written(), [`${url}|page`], 'the page alone: the gallery cover points at it, no copy');
  assert.equal(await text(await db.coverGet(gid)), '1,1,1');

  await db.putTranslatedPage(url, png(500, 2), { job: 'j1', lines: [], read: [], regions: [], masks: { raw: png(40, 3), text: png(30, 4) } });
  assert.deepEqual(written().sort(), [`${url}|mask`, `${url}|raw`, `${url}|tr`], 'only the new images; the original stays put');
  await db.putPageStudy(url, { bg: png(300, 5), page: { w: 1, h: 1 }, bubbles: [{ box: {}, tr: 'Hi', text: png(20, 6) }, { box: {}, tr: 'Oh', text: png(20, 7) }] }, 'j1');
  assert.deepEqual(written().sort(), [`${url}|bg`, `${url}|t0`, `${url}|t1`]);
  await db.setPagesOwn([url], 'j1');
  assert.deepEqual(written(), [], 'a page\'s own settings write no image');

  const rec = await db.dbGet(url);
  assert.ok(rec.blob instanceof Blob && rec.translated instanceof Blob && rec.studyBg instanceof Blob);
  assert.deepEqual(await Promise.all([rec.blob, rec.translated, rec.pipeline.masks.raw, rec.bubbles[1].text].map(text)),
    ['1,1,1', '2,2,2', '3,3,3', '7,7,7'], 'readers get the images back');
  await db.imageRecordPut({ ...rec, own: 'j2' });
  assert.deepEqual(written(), [], 'a record read and put back stores no image again');

  await db.clearGalleryTranslations(gid);
  assert.deepEqual(written(), [], 'a revert writes no image');
  assert.deepEqual(await blobIds(), [`${url}|page`], 'and deletes the ones it no longer holds');
  const reverted = await db.dbGet(url);
  assert.equal(await text(reverted.blob), '1,1,1');
  assert.equal(reverted.translated, undefined);

  await db.deleteGallery(gid);
  assert.deepEqual(await blobIds(), [], 'deleting the gallery takes its images with it');
});

test('a record stored inline before reads as it is and moves its images out on its next change', async () => {
  const gid = '601', url = `local://${gid}/1.png`;
  await db.metaPut({ galleryId: gid, title: { english: 'L', japanese: '', pretty: 'L' }, tags: [], numPages: 1 });
  await db.dbPut(url, png(100, 1), gid, gid);
  written();
  const conn = await db.openDB();
  await new Promise((resolve) => {   // the layout before: images in the record itself
    const tx = conn.transaction('images', 'readwrite');
    tx.objectStore('images').put({ url, galleryId: gid, mediaId: gid, size: 100, cachedAt: 1, blob: png(100, 8), translated: png(50, 9) });
    tx.oncomplete = resolve;
  });
  written();
  assert.equal(await text((await db.dbGet(url)).translated), '9,9,9');
  await db.setPagesOwn([url], 'j1');
  assert.deepEqual(written().sort(), [`${url}|page`, `${url}|tr`], 'moved out once, on its next change');
  await db.setPagesOwn([url], null);
  assert.deepEqual(written(), [], 'then never again');
  assert.equal(await text((await db.dbGet(url)).blob), '8,8,8');
});

test('adding a cover thumbnail writes the thumbnail alone', async () => {
  const gid = '602';
  await db.metaPut({ galleryId: gid, title: { english: 'C', japanese: '', pretty: 'C' }, tags: [], numPages: 1 });
  await db.dbPut(`local://${gid}/1.png`, png(400, 1), gid, gid);
  written();
  const { revision } = await db.coverThumbnailGet(gid, 200);
  assert.equal(await db.coverThumbnailPut(gid, 'gallery', 200, png(10, 2), revision), true);
  assert.deepEqual(written(), [`cover|${gid}|gallery|200`]);
  const got = await db.coverThumbnailGet(gid, 200);
  assert.deepEqual([await text(got.source), await text(got.thumbnail)], ['1,1,1', '2,2,2']);
});

test('converting the library moves every inline image out once; a cover copying page 1 points at it', async () => {
  const conn = await db.openDB();
  const put = (store, rec) => new Promise((resolve) => {
    const tx = conn.transaction(store, 'readwrite');
    tx.objectStore(store).put(rec);
    tx.oncomplete = resolve;
  });
  // The layout before: pages and covers holding their images.
  const a = '603', b = '604';
  await put('images', { url: `local://${a}/1.png`, galleryId: a, mediaId: a, size: 300, cachedAt: 1, blob: png(300, 1) });
  await put('images', { url: `local://${a}/2.png`, galleryId: a, mediaId: a, size: 200, cachedAt: 1, blob: png(200, 2), translated: png(100, 3) });
  await put('covers', { galleryId: a, cover: png(300, 1), coverRevisions: { gallery: 'r' } });
  await put('images', { url: `local://${b}/1.png`, galleryId: b, mediaId: b, size: 300, cachedAt: 1, blob: png(300, 4) });
  await put('covers', { galleryId: b, cover: png(120, 5), coverRevisions: { gallery: 'r' } });   // a cover of its own
  written();
  assert.ok((await db.storageLayoutStatus()).remaining >= 3);

  assert.equal(await db.convertStorage({ stopped: () => true }), false, 'stopped before anything moved');
  assert.deepEqual(written(), []);

  const phases = new Set();
  assert.equal(await db.convertStorage({ onProgress: ({ phase }) => phases.add(phase) }), true);
  const moved = written();
  for (const id of [`local://${a}/1.png|page`, `local://${a}/2.png|page`, `local://${a}/2.png|tr`, `local://${b}/1.png|page`, `cover|${b}|gallery`]) {
    assert.ok(moved.includes(id), id);
  }
  assert.ok(!moved.includes(`cover|${a}|gallery`), 'the copy of page 1 became a pointer to it');
  assert.deepEqual([...phases], ['pages', 'covers']);
  assert.equal((await db.storageLayoutStatus()).remaining, 0);
  assert.deepEqual([await text(await db.coverGet(a)), await text(await db.coverGet(b))], ['1,1,1', '5,5,5']);
  assert.equal(await text((await db.dbGet(`local://${a}/2.png`)).translated), '3,3,3');

  assert.equal(await db.convertStorage(), true);
  assert.deepEqual(written(), [], 'converting again writes nothing');
  await db.deleteGallery(a);
  assert.equal((await blobIds()).filter(id => id.includes(`/${a}/`) || id.includes(`|${a}|`)).length, 0, 'the pointer never outlives the gallery');
});

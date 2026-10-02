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
  pageGet, coverRecordGet, rebuildGalleryEntry,
  metaPut, refreshSeriesAggregate, deleteStaleGalleryImages, galleriesCount, nextGalleryId,
  pagePut, pageHas, pageList, putTranslatedPage, putPageStudy, setPagesOwn, imageRecordPut } = await import('../js/db.js');

const blobOf = (n) => new Blob([new Uint8Array(n)], { type: 'image/jpeg' });

test('an AVIF page is a page like any other: listed, found by number, and page 1 is the cover', async () => {
  await dbPut('local://AV/1.avif', new Blob([new Uint8Array(20)], { type: 'image/avif' }), 'AV', 'AV');
  await dbPut('local://AV/2.jpg', blobOf(10), 'AV', 'AV');
  assert.deepEqual((await pageList('AV')).map((p) => p.pageNum), [1, 2]);
  assert.equal((await pageGet('AV', 1))?.url, 'local://AV/1.avif');
  assert.equal((await galleryGet('AV')).coverPage, 1);
  assert.equal((await coverRecordGet('AV')).cover.type, 'image/avif');
  await rebuildGalleryEntry('AV');
  assert.equal((await galleryGet('AV')).coverPage, 1, 'a rebuilt stat record agrees');
});

// Pages are addressed by (gallery, page number): a key is checked against the number it is stored
// as, and every page read back says which page it is — read from its key, never stored.
test('a page is stored and found by its number, under a key that agrees with it', async () => {
  await pagePut('PN', 2, new Blob([new Uint8Array(8)], { type: 'image/webp' }));
  await pagePut('PN', 1, blobOf(5), { key: 'site://pn/1.jpg' });
  assert.deepEqual(await pageList('PN'), [{ pageNum: 1, url: 'site://pn/1.jpg' }, { pageNum: 2, url: 'local://PN/2.webp' }],
    'a page without a key is stored under its own number');
  assert.equal((await pageGet('PN', 2)).pageNum, 2);
  assert.equal(await pageHas('PN', 2), true);
  assert.equal(await pageHas('PN', 3), false);
  await assert.rejects(pagePut('PN', 3, blobOf(5), { key: 'site://pn/4.jpg' }), { name: 'BackendError', code: 'invalid' });
  await assert.rejects(pagePut('PN', 0, blobOf(5)), { code: 'invalid' });
  await assert.rejects(pagePut('PN', 3, blobOf(5), { key: 'site://pn/page-three' }), { code: 'invalid' });
  assert.equal(await pageHas('PN', 3), false, 'a refused page leaves nothing behind');
});

test("a page's translation and study layers are written by its number; its number is never stored", async () => {
  await pagePut('PD', 1, blobOf(5));
  const webp = new Blob([new Uint8Array(3)], { type: 'image/webp' });
  await putTranslatedPage({ galleryId: 'PD', pageNum: 1 }, webp, { job: 'j1', lines: [] }, 'j1');
  await putPageStudy({ galleryId: 'PD', pageNum: 1 }, { bg: webp, bubbles: [{ box: {}, region: {}, tr: 'Hi', src: 'やあ' }], page: { w: 1, h: 1 } }, 'j1');
  await setPagesOwn([{ galleryId: 'PD', pageNum: 1 }], null);
  await putTranslatedPage({ galleryId: 'PD', pageNum: 9 }, webp, null);   // no such page: nothing happens
  const page = await pageGet('PD', 1);
  assert.equal(page.translated.size, 3);
  assert.equal(page.bubbles[0].tr, 'Hi');
  assert.equal(page.own, undefined);
  assert.equal(await pageHas('PD', 9), false);
  await imageRecordPut(page);   // a record read back and written whole (a restore)

  const raw = await new Promise((resolve, reject) => {
    const open = indexedDB.open('shiori-cache');
    open.onsuccess = () => {
      const req = open.result.transaction('images', 'readonly').objectStore('images').get('local://PD/1.jpg');
      req.onsuccess = () => { resolve(req.result); open.result.close(); };
      req.onerror = () => reject(req.error);
    };
  });
  assert.equal('pageNum' in raw, false, 'the page number lives in the key alone');
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

test("a gallery's first page and its metadata land together", async () => {
  const meta = { galleryId: 'F', title: { english: 'First', japanese: '', pretty: 'First' }, tags: [], uploadDate: 1234 };
  await dbPut('site://f/1.jpg', blobOf(10), 'F', 'F', { meta });
  assert.equal((await metaGet('F')).title.english, 'First');
  const stat = await galleryGet('F');
  assert.equal(stat.count, 1);
  assert.equal(stat.uploadDate, 1234, 'the published date comes from the metadata it arrived with');
});

test("replacing a chapter's pages in place keeps the series whole", async () => {
  for (const gid of ['S1', 'S2']) {
    await metaPut({ galleryId: gid, title: { english: gid, japanese: '', pretty: gid } });
    await dbPut(`site://${gid}/1.jpg`, blobOf(10), gid, gid);
    await dbPut(`site://${gid}/2.jpg`, blobOf(10), gid, gid);
  }
  await mutateGallery('S1', { chapters: [{ id: 'S1' }, { id: 'S2' }] });
  await mutateGallery('S2', { parentId: 'S1' });
  await refreshSeriesAggregate('S1');
  const before = await galleriesCount();

  // An overwrite: every page stored over its old copy (page 2 now in another format), then the
  // leftovers the new set didn't replace are dropped.
  await dbPut('site://S2/1.jpg', blobOf(20), 'S2', 'S2');
  await dbPut('site://S2/2.webp', blobOf(20), 'S2', 'S2');
  assert.equal(await deleteStaleGalleryImages('S2', ['site://S2/1.jpg', 'site://S2/2.webp']), 1);

  assert.deepEqual((await getGalleryImageRecords('S2')).map(r => r.url).sort(), ['site://S2/1.jpg', 'site://S2/2.webp']);
  const chapter = await galleryGet('S2');
  assert.equal(chapter.count, 2);
  assert.equal(chapter.parentId, 'S1', 'the chapter stays in its series');
  assert.equal((await galleryGet('S1')).chapterCount, 2, 'the series keeps its totals');
  assert.equal(await galleriesCount(), before, 'the library count does not move');
});

test('a source id held by several galleries resolves to the first one added', async () => {
  const sid = '777777';
  const title = (t) => ({ english: t, japanese: '', pretty: t });
  const placeholder = await resolveGalleryId(sid);              // browsed once, never saved
  const first = nextGalleryId();
  await metaPut({ galleryId: first, sourceId: sid, title: title('Downloaded') });
  const copy = nextGalleryId();
  await metaPut({ galleryId: copy, sourceId: sid, title: title('Edited copy') });
  await metaPut({ galleryId: copy, sourceId: sid, title: title('Edited copy, metadata fetched') });   // written last
  assert.ok(placeholder < first && first < copy);
  assert.equal(await resolveGalleryId(sid), first, 'the first real gallery, not the newest write or the placeholder');
  await deleteGallery(first);
  assert.equal(await resolveGalleryId(sid), copy, 'then the next one added');
});

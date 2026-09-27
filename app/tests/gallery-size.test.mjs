// gallery-size.test.mjs — a gallery's size in the library is its export archive's exact size:
// original pages, translations, study data, snapshots, covers and metadata, split into the
// original pages and the rest, and kept current as the gallery changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

const db = await import('../js/db.js');
const { galleryFiles, fileBytes } = await import('../js/gallery-files.js');
const { zipCreate } = await import('../js/zip.js');

const png = (n, fill = 1) => new Blob([new Uint8Array(n).fill(fill)], { type: 'image/png' });
const webp = (n) => new Blob([new Uint8Array(n).fill(7)], { type: 'image/webp' });

// The archive the gallery export writes, from what is stored.
async function archiveBytes(gid) {
  const [meta, records, covers] = await Promise.all([db.metaGet(gid), db.getGalleryImageRecords(gid), db.coverRecordGet(gid)]);
  const files = galleryFiles({ meta, records, covers: { gallery: covers?.cover, series: covers?.seriesCover } });
  return zipCreate(await Promise.all(files.map(async f => ({ name: f.name, data: await fileBytes(f.source) })))).length;
}

test('a gallery is as big as its export, and hovering splits off the original pages', async () => {
  const gid = '500';
  await db.metaPut({ galleryId: gid, title: { english: 'Size', japanese: '大きさ', pretty: 'Size' }, tags: [], numPages: 2,
    translations: { j1: { at: 1, config: { render: { renderer: 'shiori' } }, builds: { render: 'r' } } } });
  await db.dbPut(`local://${gid}/1.png`, png(3000), gid, gid);
  await db.dbPut(`local://${gid}/2.png`, png(2000, 2), gid, gid);
  await db.putTranslatedPage(`local://${gid}/1.png`, webp(1500), { job: 'j1', lines: [], read: [], regions: [{ lines: [], tr: 'こんにちは' }],
    masks: { raw: webp(400), text: webp(100) } });
  await db.putPageStudy(`local://${gid}/2.png`, { bg: webp(900), page: { w: 10, h: 10 },
    bubbles: [{ box: { x: 0, y: 0, w: 1, h: 1 }, region: { x: 0, y: 0, w: 1, h: 1 }, tr: 'Hi', src: 'やあ', text: webp(300) }] });
  await db.refreshGallerySize(gid);
  const stat = await db.galleryGet(gid);
  assert.equal(stat.size, await archiveBytes(gid), 'the exact size of the export');
  assert.equal(stat.origSize, 5000, 'the two original pages');
  assert.ok(stat.size > 5000 + 1500 + 400 + 100 + 900 + 300 + 3000, 'translations, snapshots, study data and the cover copy count too');

  await db.clearGalleryTranslations(gid);
  await db.refreshGallerySize(gid);
  const reverted = await db.galleryGet(gid);
  assert.equal(reverted.size, await archiveBytes(gid));
  assert.equal(reverted.origSize, 5000);
  assert.ok(reverted.size < stat.size - 1500 - 400 - 100 - 900 - 300, 'the translation, snapshots and study data are gone');
});

test('the library totals split the original pages from the rest; a size not yet recomputed is all original', async () => {
  const before = await db.getStats();
  await db.galleryPut({ galleryId: '501', count: 1, size: 700, latestAt: 1, addedAt: 1, uploadDate: 0 });
  const after = await db.getStats();
  assert.equal(after.totalSize - before.totalSize, 700);
  assert.equal(after.totalOrig - before.totalOrig, 700);
  const stat = await db.galleryGet('500');
  assert.equal(before.totalSize - before.totalOrig, stat.size - stat.origSize);
});

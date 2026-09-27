// page-size.test.mjs — a gallery's typical page: each page's size read from its image header, the
// median page by area (outlier pages don't move it), its tier, and the stat record that keeps it
// current without reading an image when nothing changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

const { headerSize, imageSize, medianPage, tierOf, describePage } = await import('../js/page-size.js');
const db = await import('../js/db.js');

const bytes = (n, fill = 0) => new Uint8Array(n).fill(fill);
const ascii = (d, at, s) => { for (let i = 0; i < s.length; i++) d[at + i] = s.charCodeAt(i); };
const be32 = (d, at, v) => new DataView(d.buffer).setUint32(at, v);

function png(w, h) {
  const d = bytes(33);
  d.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  be32(d, 8, 13); ascii(d, 12, 'IHDR'); be32(d, 16, w); be32(d, 20, h);
  return d;
}
function webp(kind, w, h) {
  const d = bytes(40), v = new DataView(d.buffer);
  ascii(d, 0, 'RIFF'); ascii(d, 8, 'WEBP'); ascii(d, 12, kind);
  if (kind === 'VP8 ') { v.setUint16(26, w, true); v.setUint16(28, h, true); }
  if (kind === 'VP8L') v.setUint32(21, (w - 1) | ((h - 1) << 14), true);
  if (kind === 'VP8X') { v.setUint16(24, (w - 1) & 0xffff, true); d[26] = (w - 1) >> 16; v.setUint16(27, (h - 1) & 0xffff, true); d[29] = (h - 1) >> 16; }
  return d;
}
// A JPEG whose frame header sits behind an APP1 segment of `pad` bytes.
function jpeg(w, h, pad = 16) {
  const d = bytes(4 + pad + 2 + 17), v = new DataView(d.buffer);
  d.set([0xff, 0xd8, 0xff, 0xe1]); v.setUint16(4, pad);
  const sof = 4 + pad;
  d.set([0xff, 0xc0], sof); v.setUint16(sof + 2, 17); d[sof + 4] = 8; v.setUint16(sof + 5, h); v.setUint16(sof + 7, w);
  return d;
}
function avif(...extents) {
  const d = bytes(24 + extents.length * 20);
  be32(d, 0, 24); ascii(d, 4, 'ftypavif');
  extents.forEach(([w, h], i) => { const at = 24 + i * 20; be32(d, at, 20); ascii(d, at + 4, 'ispe'); be32(d, at + 12, w); be32(d, at + 16, h); });
  return d;
}

test('page sizes come from the image header of every stored format', async () => {
  assert.deepEqual(headerSize(png(1280, 1807)), { w: 1280, h: 1807 });
  assert.deepEqual(headerSize(webp('VP8 ', 720, 1024)), { w: 720, h: 1024 });
  assert.deepEqual(headerSize(webp('VP8L', 1280, 1807)), { w: 1280, h: 1807 });
  assert.deepEqual(headerSize(webp('VP8X', 3508, 4961)), { w: 3508, h: 4961 });
  assert.deepEqual(headerSize(jpeg(2040, 2880)), { w: 2040, h: 2880 });
  assert.deepEqual(headerSize(avif([512, 512], [2039, 2880])), { w: 2039, h: 2880 }, 'a grid image is its largest extent');
  assert.equal(headerSize(bytes(64, 7)), null, 'not an image this reads');
  // A frame header further in than the first read is found by reading further.
  const deep = jpeg(1057, 1500, 20000);
  assert.equal(headerSize(deep.subarray(0, 4096)), undefined);
  assert.deepEqual(await imageSize(new Blob([deep])), { w: 1057, h: 1500 });
});

test('the typical page is the median by area, so covers and spreads do not move it', () => {
  const page = { w: 1280, h: 1807 }, spread = { w: 2560, h: 1807 }, cover = { w: 800, h: 1100 };
  assert.deepEqual(medianPage([cover, page, page, spread, page]), page);
  assert.deepEqual(medianPage([page, spread]), page, 'an even count takes the lower middle');
  assert.deepEqual(medianPage([{ ...cover, n: 3 }, { ...spread, n: 1 }]), cover, 'a weight counts as that many pages');
  assert.equal(medianPage([]), null);
});

test('tiers follow the typical page\'s megapixels', () => {
  assert.equal(tierOf(0.74).id, 'T1');
  assert.equal(tierOf(1.4).id, 'T2');
  assert.equal(tierOf(2.31).id, 'T3');
  assert.equal(tierOf(3.98).id, 'T4');
  assert.equal(tierOf(5.88).id, 'T5');
  assert.equal(tierOf(17.4).id, 'T6');
  assert.equal(tierOf(0), null);
  assert.deepEqual(describePage({ w: 1280, h: 1807 }), { w: 1280, h: 1807, mp: 1280 * 1807 / 1e6, tier: 'T3' });
  assert.equal(describePage({ w: 0, h: 0 }), null, 'unreadable pages have no typical page');
});

test('a gallery keeps its typical page on its stats, not among its tags', async () => {
  const gid = '700';
  await db.metaPut({ galleryId: gid, title: { english: 'Sizes', japanese: '', pretty: '' }, tags: [{ type: 'tag', name: 'x' }], numPages: 3 });
  await db.dbPut(`local://${gid}/1.png`, new Blob([png(800, 1100)]), gid, gid);
  await db.dbPut(`local://${gid}/2.webp`, new Blob([webp('VP8L', 1280, 1807)]), gid, gid);
  await db.dbPut(`local://${gid}/3.jpg`, new Blob([jpeg(2560, 1807)]), gid, gid);
  assert.equal(await db.refreshMedianPage(gid), true);
  const stat = await db.galleryGet(gid);
  assert.deepEqual(stat.medianPage, { w: 1280, h: 1807, n: 3, bytes: stat.medianPage.bytes });
  assert.equal(await db.refreshMedianPage(gid), false, 'the same pages measure the same');
  const entity = await db.getGallery(gid);
  assert.equal(entity.medianPage.tier, 'T3');
  assert.deepEqual(entity.tags, [{ type: 'tag', name: 'x' }]);
  assert.equal((await db.metaGet(gid)).medianPage, undefined);
});

test('new pages are measured once they stop arriving, not after each one', async (t) => {
  const gid = '720';
  for (let n = 1; n <= 2; n++) await db.dbPut(`local://${gid}/${n}.png`, new Blob([png(720, 1024)]), gid, gid);
  await db.refreshMedianPage(gid);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let n = 3; n <= 5; n++) {
    await db.dbPut(`local://${gid}/${n}.png`, new Blob([png(1280, 1807)]), gid, gid);
    await db.refreshGallerySize(gid);
    t.mock.timers.tick(1000);
  }
  assert.equal((await db.galleryGet(gid)).medianPage.w, 720, 'still arriving');
  t.mock.timers.tick(3000);
  for (let i = 0; i < 50 && (await db.galleryGet(gid)).medianPage.n !== 5; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual((await db.galleryGet(gid)).medianPage, { w: 1280, h: 1807, n: 5, bytes: 5 * 33 });
});

test('galleries stored before it was kept are measured once, and a series stands for its chapters\' pages', async () => {
  for (const [gid, size, pages] of [['710', [720, 1024], 3], ['711', [3508, 4961], 1]]) {
    for (let n = 1; n <= pages; n++) await db.dbPut(`local://${gid}/${n}.png`, new Blob([png(...size)]), gid, gid);
  }
  await db.mutateGallery('710', { title: { english: 'One', japanese: '', pretty: '' },
    chapters: [{ id: '710', title: 'One' }, { id: '711', title: 'Two' }] });
  assert.ok(await db.backfillMedianPages() >= 2);
  assert.deepEqual((await db.galleryGet('711')).medianPage.w, 3508);
  assert.equal(await db.backfillMedianPages(), 0, 'nothing is measured twice');
  await db.refreshSeriesAggregate('710');
  const series = await db.getGallery('710');
  assert.equal(series.aggMedianPage.tier, 'T1', 'three low pages outweigh one print page');
});

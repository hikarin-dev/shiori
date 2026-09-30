// backup-roundtrip.test.mjs — a library backed up and restored after it was lost comes back whole:
// a full backup (.shioridb) keeps each gallery's favorite, category, rating and title, its pages in
// their own formats (AVIF, WebP), its stat record (sort times, page size tier) and cover, and the
// user's settings — but never this browser's record of its own one-time repairs. A metadata-only
// backup (.shi) keeps the same metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

// localStorage with its keys enumerable, as the settings snapshot walks them.
const ls = {};
Object.defineProperties(ls, {
  getItem: { value: (k) => (Object.hasOwn(ls, k) ? ls[k] : null) },
  setItem: { value: (k, v) => { ls[k] = String(v); } },
  removeItem: { value: (k) => { delete ls[k]; } },
});
globalThis.localStorage = ls;

const db = await import('../js/db.js');
const { exportFull, exportMetadata, importBackup } = await import('../js/backup.js');

const TAGS = [{ type: 'category', name: 'manga', url: '' }, { type: 'rating', name: 'safe', url: '' }];
const TITLE = { english: 'Kept', japanese: '残す', pretty: 'Kept' };
const MEDIAN = { w: 1200, h: 1701, n: 2, bytes: 4 };
const img = (type, ...values) => new Blob([new Uint8Array(values)], { type });

async function seed(gid) {
  await db.metaPut({ galleryId: gid, title: TITLE, tags: TAGS, numPages: 2 });
  await db.dbPut(`local://${gid}/1.avif`, img('image/avif', 1, 1), gid, gid);
  await db.dbPut(`local://${gid}/2.webp`, img('image/webp', 2, 2), gid, gid);
  await db.mutateGallery(gid, { favorite: true, medianPage: MEDIAN }, { touch: false });
}

async function pagesOf(gid) {
  const recs = (await db.getGalleryImageRecords(gid)).sort((a, b) => a.url.localeCompare(b.url));
  return Promise.all(recs.map(async (r) => [r.url, r.blob.type, [...new Uint8Array(await r.blob.arrayBuffer())]]));
}

const statOf = ({ count, size, latestAt, addedAt, coverPage, medianPage }) => ({ count, size, latestAt, addedAt, coverPage, medianPage });

test('a full backup restores galleries, pages, stats, covers and settings — not repair records', async () => {
  await seed('901');
  const pages = await pagesOf('901');
  const stat = statOf(await db.galleryGet('901'));
  localStorage.setItem('shiori:libFilter', '{"rating":{"safe":1}}');
  localStorage.setItem('shiori:libShowCategoryTag', 'false');
  localStorage.setItem('shiori:schemaSteps', '["countsRepaired","exportSizes"]');
  localStorage.setItem('shiori:storageLayout', '"done"');

  const { archive } = await exportFull();
  await db.deleteGallery('901');
  for (const k of Object.keys(ls)) localStorage.removeItem(k);
  await importBackup(new File([archive], 'backup.shioridb'));

  const meta = await db.metaGet('901');
  assert.equal(meta.favorite, true);
  assert.deepEqual(meta.tags, TAGS);
  assert.deepEqual(meta.title, TITLE);
  assert.deepEqual(await pagesOf('901'), pages, 'every page in its own format, bytes untouched');
  assert.deepEqual(statOf(await db.galleryGet('901')), stat, 'sort times, cover page and size tier are kept');
  assert.equal((await db.coverRecordGet('901')).cover.type, 'image/avif');
  assert.equal(localStorage.getItem('shiori:libFilter'), '{"rating":{"safe":1}}');
  assert.equal(localStorage.getItem('shiori:libShowCategoryTag'), 'false');
  assert.equal(localStorage.getItem('shiori:schemaSteps'), null, 'the restored library re-runs its repairs');
  assert.equal(localStorage.getItem('shiori:storageLayout'), null, "another browser's storage state stays behind");
});

test('a metadata-only backup restores favorite, category, rating and title', async () => {
  await seed('902');
  const { blob } = await exportMetadata();
  await db.deleteGallery('902');
  await importBackup(new File([await blob.text()], 'backup.shi'));
  const meta = await db.metaGet('902');
  assert.equal(meta.favorite, true);
  assert.deepEqual(meta.tags, TAGS);
  assert.deepEqual(meta.title, TITLE);
});

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

const api = await import('../js/api.js');
const { exportFull, exportMetadata, importBackup } = await import('../js/backup.js');

const TAGS = [{ type: 'category', name: 'manga', url: '' }, { type: 'rating', name: 'safe', url: '' }];
const TITLE = { english: 'Kept', japanese: '残す', pretty: 'Kept' };
const MEDIAN = { w: 1200, h: 1701, n: 2, bytes: 4 };
const img = (type, ...values) => new Blob([new Uint8Array(values)], { type });

async function seed(gid) {
  await api.meta.put({ galleryId: gid, title: TITLE, tags: TAGS, numPages: 2 });
  await api.pages.put(gid, null, img('image/avif', 1, 1), { key: `local://${gid}/1.avif` });
  await api.pages.put(gid, null, img('image/webp', 2, 2), { key: `local://${gid}/2.webp` });
  await api.galleries.mutate(gid, { favorite: true }, { touch: false });
  // A measured page size, as the library would keep it (written as stored: the library measures it itself).
  const { stat } = await api.transfer.read(gid);
  await api.transfer.write({ galleryId: gid, stat: { ...stat, medianPage: MEDIAN } });
}

async function pagesOf(gid) {
  const recs = (await api.pages.all(gid)).sort((a, b) => a.url.localeCompare(b.url));
  return Promise.all(recs.map(async (r) => [r.url, r.blob.type, [...new Uint8Array(await r.blob.arrayBuffer())]]));
}

// A gallery's entry as the library keeps it.
const entryOf = async (gid) => (await api.transfer.read(gid)).stat;
const statOf = ({ count, size, latestAt, addedAt, coverPage, medianPage }) => ({ count, size, latestAt, addedAt, coverPage, medianPage });

test('a full backup restores galleries, pages, stats, covers and settings — not repair records', async () => {
  await seed('901');
  const pages = await pagesOf('901');
  const stat = statOf(await entryOf('901'));
  localStorage.setItem('shiori:libFilter', '{"rating":{"safe":1}}');
  localStorage.setItem('shiori:libShowCategoryTag', 'false');
  localStorage.setItem('shiori:schemaSteps', '["countsRepaired","exportSizes"]');
  localStorage.setItem('shiori:storageLayout', '"done"');

  const { archive } = await exportFull();
  await api.galleries.delete('901');
  for (const k of Object.keys(ls)) localStorage.removeItem(k);
  await importBackup(new File([archive], 'backup.shioridb'));

  const meta = await api.meta.get('901');
  assert.equal(meta.favorite, true);
  assert.deepEqual(meta.tags, TAGS);
  assert.deepEqual(meta.title, TITLE);
  assert.deepEqual(await pagesOf('901'), pages, 'every page in its own format, bytes untouched');
  assert.deepEqual(statOf(await entryOf('901')), stat, 'sort times, cover page and size tier are kept');
  assert.equal((await api.transfer.read('901')).cover.cover.type, 'image/avif');
  assert.equal(localStorage.getItem('shiori:libFilter'), '{"rating":{"safe":1}}');
  assert.equal(localStorage.getItem('shiori:libShowCategoryTag'), 'false');
  assert.equal(localStorage.getItem('shiori:schemaSteps'), null, 'the restored library re-runs its repairs');
  assert.equal(localStorage.getItem('shiori:storageLayout'), null, "another browser's storage state stays behind");
});

test('a metadata-only backup restores favorite, category, rating and title', async () => {
  await seed('902');
  const { blob } = await exportMetadata();
  await api.galleries.delete('902');
  await importBackup(new File([await blob.text()], 'backup.shi'));
  const meta = await api.meta.get('902');
  assert.equal(meta.favorite, true);
  assert.deepEqual(meta.tags, TAGS);
  assert.deepEqual(meta.title, TITLE);
});

// Every metadata field makes the trip — chapter numbers, source details and fields added after this
// test was written — so a new field never needs its own export or import code to survive.
async function seedSeriesWithExtras() {
  await seed('911');
  await seed('912');
  await api.galleries.mutate('911', { chapters: [{ id: '911', title: 'One', number: 1 }, { id: '912', title: 'One and a half', number: 1.5 }],
    seriesTitle: { english: 'Series', japanese: '', pretty: 'Series' } }, { touch: false });
  await api.galleries.mutate('912', { parentId: '911' }, { touch: false });
  await api.meta.put({ ...await api.meta.get('912'), futureField: { kept: [1, 'two'] }, sourceMetadata: { kind: 'chapter', chapter: { number: '1.5' } } });
}

// Restamped on every restore: when the record was written (nothing reads it back).
const restored = ({ fetchedAt, ...m }) => m;

test('a full backup brings back every metadata field, including ones the app does not know', async () => {
  await seedSeriesWithExtras();
  const before = [await api.meta.get('911'), await api.meta.get('912')];
  const { archive } = await exportFull();
  for (const gid of ['911', '912']) await api.galleries.delete(gid);
  await importBackup(new File([archive], 'backup.shioridb'));
  assert.deepEqual([await api.meta.get('911'), await api.meta.get('912')].map(restored), before.map(restored));
});

test('a metadata-only backup brings back every metadata field but the page formats', async () => {
  await seedSeriesWithExtras();
  const before = [await api.meta.get('911'), await api.meta.get('912')].map(({ pageExts, ...m }) => restored(m));
  const { blob } = await exportMetadata();
  for (const gid of ['911', '912']) await api.galleries.delete(gid);
  await importBackup(new File([await blob.text()], 'backup.shi'));
  const after = [await api.meta.get('911'), await api.meta.get('912')].map(({ pageExts, ...m }) => restored(m));
  assert.deepEqual(after, before);
});

test('a metadata-only backup carries only galleries in the library', async () => {
  await seed('903');
  await api.galleries.create('904', { title: TITLE });             // in the library, no pages yet
  await api.meta.put({ galleryId: '905', title: TITLE, numPages: 3 });  // metadata that never became a gallery
  const { blob, count } = await exportMetadata();
  const ids = JSON.parse(await blob.text()).map(m => m.galleryId);
  assert.ok(ids.includes('903') && ids.includes('904'));
  assert.ok(!ids.includes('905'), 'a restore would otherwise add it as an empty gallery');
  assert.equal(count, ids.length);
});

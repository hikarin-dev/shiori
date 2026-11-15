// storage-fixtures.test.mjs — the migration fixtures (plan D13) as the website library meets them:
// today's library opens each IndexedDB version an earlier one left (16, released in v1.2.6; 18 and
// 19 from the working tree), upgrades it and reads every gallery back whole — the favorite an earlier
// version kept in a gallery's metadata now the person's own mark (plan D6); and the folder fixtures
// (description format v1 with and without its files list, the desktop's oldest shiori.json) read as
// the shared rules say. Each IndexedDB version opens in a process of its own, since the library opens
// one database per process. The desktop's fixtures: desktop/tests/storage-fixtures.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INDEXEDDB_FIXTURES, FIXTURE_GIDS, indexedDBLibrary, v1Gallery, legacyGallery, pictureBytes } from './fixtures/storage-fixtures.mjs';
import { classifyFolder } from '../js/storage/folder-content.js';
import { folderPictures } from '../js/storage/gallery-files.js';

const bytesOf = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);

// In the child: the fixture loaded, today's library opened on it, and what it reads printed as JSON.
if (process.env.SHIORI_IDB_FIXTURE) {
  await import('fake-indexeddb/auto');
  globalThis.BroadcastChannel = class { postMessage() {} close() {} };
  await indexedDBLibrary(process.env.SHIORI_IDB_FIXTURE);
  // An earlier version kept the person's favorite in the metadata: gallery A's set so.
  await new Promise((resolve) => {
    const r = indexedDB.open('shiori-cache');
    r.onsuccess = () => {
      const tx = r.result.transaction('metadata', 'readwrite');
      const metas = tx.objectStore('metadata');
      metas.get(FIXTURE_GIDS.a).onsuccess = (e) => metas.put({ ...e.target.result, favorite: true });
      tx.oncomplete = () => { r.result.close(); resolve(); };
    };
  });
  const api = await import('../js/api.js');
  const galleries = {};
  for (const gid of [FIXTURE_GIDS.a, FIXTURE_GIDS.b]) {
    const list = await api.pages.list(gid);
    galleries[gid] = {
      title: (await api.meta.get(gid))?.title?.english ?? null,
      count: (await api.galleries.get(gid))?.count ?? null,
      pages: await Promise.all(list.map(p => api.pages.blob(gid, p.pageNum).then(bytesOf))),
      translated: await api.pages.get(gid, 1).then(r => bytesOf(r?.translated instanceof Blob ? r.translated : null)),
      cover: await api.covers.get(gid).then(bytesOf),
      favorite: [(await api.galleries.get(gid))?.favorite, (await api.meta.get(gid))?.favorite ?? null],
    };
  }
  const db = await new Promise((resolve) => { const r = indexedDB.open('shiori-cache'); r.onsuccess = () => resolve(r.result); });
  process.stdout.write(JSON.stringify({ version: db.version, stores: [...db.objectStoreNames], galleries }));
  process.exit(0);
}

const webp = (n) => [...pictureBytes('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', n)];
const png = (n) => [...pictureBytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', n)];

for (const name of INDEXEDDB_FIXTURES) {
  test(`${name}: today's library upgrades it and reads every gallery back whole`, () => {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, SHIORI_IDB_FIXTURE: name }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const got = JSON.parse(run.stdout);
    assert.equal(got.version, 20);
    for (const store of ['folders', 'dormant', 'undescribed', 'blobs', 'changes', 'personal']) assert.ok(got.stores.includes(store), store);
    assert.deepEqual(got.galleries[FIXTURE_GIDS.a], { title: 'Fixture A', count: 2, pages: [webp(1), webp(2)], translated: png(1), cover: png(9),
      favorite: [true, null] }, 'its favorite a mark of its own, no longer in its metadata');
    assert.deepEqual(got.galleries[FIXTURE_GIDS.b], { title: 'Fixture B', count: 1, pages: [webp(3)], translated: null, cover: webp(3),
      favorite: [false, null] }, 'its cover is its first page');
  });
}

const temp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-fixture-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const picturesIn = (dir) => fs.readdirSync(dir, { recursive: true }).map(f => f.replace(/\\/g, '/'))
  .filter(f => /^(images|translated|study|pipeline|covers)\//.test(f) && fs.statSync(path.join(dir, f)).isFile());
const json = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

test('a v1 folder whose descriptions name a replaced picture\'s file reads that file', async (t) => {
  const dir = temp(t);
  const made = await v1Gallery(dir, { files: true });
  assert.deepEqual(classifyFolder({ 'metadata.json': fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8') }), { kind: 'gallery', id: made.gid });
  assert.deepEqual(json(dir, 'image_records.json')[0].files, [made.current[1]]);
  const read = folderPictures(picturesIn(dir), { records: json(dir, 'image_records.json') });
  assert.deepEqual([...read.pages], [[1, made.current[1]], [2, made.current[2]]]);
  assert.equal(read.file('translated/0001'), 'translated/0001.png');
});

test('a v1 folder written before descriptions named files reads the layout name', async (t) => {
  // The replaced picture's file is beside the old one, and nothing says which is current: the rule
  // takes the layout name (the file it replaced). Format v2's manifest names every file (plan §4).
  const dir = temp(t);
  const made = await v1Gallery(dir, { files: false });
  assert.equal(json(dir, 'image_records.json')[0].files, undefined);
  const read = folderPictures(picturesIn(dir), { records: json(dir, 'image_records.json') });
  assert.deepEqual([...read.pages], [[1, made.stale[0]], [2, made.current[2]]]);
});

test('a folder in the desktop\'s oldest format is Shiori\'s, by its shiori.json', (t) => {
  const dir = temp(t);
  const made = legacyGallery(dir);
  assert.deepEqual(classifyFolder({ 'shiori.json': fs.readFileSync(path.join(dir, 'shiori.json'), 'utf8') }), { kind: 'gallery', id: made.gid, legacy: true });
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.webp')), made.pages);
});

// S28b (review 7 A2's rule, gallery-manifest.js readGallery): an earlier version's gallery whose records
// name pages its folder shows no picture of is 'missing-file'. Every gallery the released formats' fixtures
// hold — the folders and the archive v1.2.6 and the working tree's builds left (the desktop's fixtures), their
// linked galleries' overlays, v1 with and without its files list, a series export's chapters — reads as it was
// written on both apps' readers, none of them taken for one missing its pictures.
test('S28b: every gallery of the released formats\' fixtures reads whole on both apps\' readers', async (t) => {
  const { DESKTOP_FIXTURES, loadFixture, seriesExport } = await import('./fixtures/storage-fixtures.mjs');
  const { loadGallery: websiteLoad, forgetFolder } = await import('../js/storage/folder-store-web.js');
  const { loadGallery: desktopLoad } = await import('../../desktop/server/folder-store.js');
  const { readGallery, PICTURE_DIRS } = await import('../js/storage/gallery-manifest.js');
  const { zipEntries } = await import('../js/zip-read.js');
  const fsa = await import('./fsa-node.mjs');
  const base = temp(t);
  const folders = [], archives = [];
  for (const name of DESKTOP_FIXTURES) {
    for (const [rel, b64] of Object.entries(loadFixture(name).files)) {
      const at = path.join(base, name, ...rel.split('/'));
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, Buffer.from(b64, 'base64'));
      if (rel.endsWith('/metadata.json')) folders.push([path.join(base, name, rel.split('/')[0]), rel.split('/').slice(1, -1).join('/')]);
      if (/\.(zip|cbz)$/i.test(rel)) archives.push([at, '']);
    }
  }
  for (const files of [true, false]) { await v1Gallery(path.join(base, 'v1', `files ${files}`), { files }); folders.push([path.join(base, 'v1'), `files ${files}`]); }
  fs.mkdirSync(path.join(base, 'series'));
  seriesExport(path.join(base, 'series'), (n) => new Uint8Array(pictureBytes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', n)));
  for (const inner of ['One/', 'Two/', 'Three/']) archives.push([path.join(base, 'series', 'Series.zip'), inner]);
  const read = [];
  for (const [folder, rel] of folders) {
    const website = (await websiteLoad('fixture', fsa.directory(folder), rel)).read;
    forgetFolder('fixture');
    const desktop = (await desktopLoad(path.join(folder, ...rel.split('/')))).read;
    read.push([`${path.relative(base, folder)}/${rel}`, website.kind, desktop.kind, website.kind === 'ok' && website.pictures.pages.size]);
  }
  for (const [at, inner] of archives) {
    const entries = new Map((await zipEntries(new Uint8Array(fs.readFileSync(at)))).map(e => [e.filename, e]));
    const files = new Map([...entries].filter(([n]) => n.startsWith(inner) && PICTURE_DIRS.includes(n.slice(inner.length, n.lastIndexOf('/'))))
      .map(([n, e]) => [n.slice(inner.length), { size: e.size }]));
    const got = await readGallery({ area: '.shiori/', archive: true, files, text: async (rel) => { const e = entries.get(`${inner}${rel}`); return e ? new TextDecoder().decode(await e.read()) : null; } });
    read.push([`${path.relative(base, at)}/${inner}`, got.kind, got.kind, got.kind === 'ok' && got.pictures.pages.size]);
  }
  assert.ok(read.length >= 19, `every fixture's galleries read (${read.length})`);
  for (const [what, website, desktop, pages] of read) {
    assert.deepEqual([website, desktop], ['ok', 'ok'], what);
    if (!what.includes('.shiori/linked/')) assert.ok(pages > 0, `${what}: its pages`);
  }
});

// gallery-format.test.mjs — the Shiori gallery format (gallery-files.js) is one layout for an
// export, an import and the desktop library's folders: an export is named after its gallery or
// series, holds each picture once under its layout name (a cover that is the first page implied, a
// custom cover kept), a series' members sit in "<Series> Ch. 001" folders listed by series.json;
// exports from before the format (chapter-NN folders, a copy of the first page as cover) still
// import, without that copy; and a folder in the format, dropped as it is, imports like its archive
// (a series member kept in it as an archive going in as the folder it is the archive of).
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

const api = await import('../js/api.js');
const { exportFiles } = await import('../js/gallery-files.js');
const { importCbzBuffer } = await import('../js/import-cbz.js');
const { groupImports, importBytes } = await import('../js/import-files.js');
const { zipCreate } = await import('../js/zip.js');

const bytes = (...values) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...values]);
const png = (...values) => new Blob([bytes(...values)], { type: 'image/png' });
const blobBytes = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);
const title = (english) => ({ english, japanese: '', pretty: english });
const buffer = (files) => { const z = zipCreate(files); return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength); };
const exported = (gid, opts = {}) => exportFiles(gid, { read: api.transfer.read, metaGet: api.meta.get, ...opts });

async function gallery(gid, name, pages = [1, 2]) {
  await api.meta.put({ galleryId: gid, title: title(name), tags: [{ type: 'artist', name: 'someone' }], numPages: pages.length });
  for (const n of pages) await api.pages.put(gid, n, png(n), { key: `local://${gid}/${n}.png` });
}

test('a gallery exports as its folder: named after it, each picture once, its first page as cover implied', async () => {
  await gallery('1790500000001', 'My: Book?');
  await api.derived.putTranslation('1790500000001', 1, { image: new Blob([bytes(9)], { type: 'image/webp' }), pipeline: null });
  const { name, files } = await exported('1790500000001');
  assert.equal(name, 'My Book', 'named after its title, made safe for Windows');
  assert.deepEqual(files.map(f => f.name).sort(),
    ['image_records.json', 'images/0001.png', 'images/0002.png', 'metadata.json', 'translated/0001.webp'],
    'no covers/: its cover is its first page');
});

test('a custom cover is kept as a picture of its own', async () => {
  await gallery('1790500000002', 'Covered');
  await api.covers.put('1790500000002', new Blob([bytes(7, 7)], { type: 'image/webp' }), { role: 'gallery' });
  const { files } = await exported('1790500000002');
  const cover = files.find(f => f.name === 'covers/gallery.webp');
  assert.deepEqual(cover && [...cover.data], [...bytes(7, 7)]);
  assert.ok(files.some(f => f.name === 'covers/manifest.json'));
});

test('a series exports as its folder: members in "<Series> Ch. 001" folders, listed by series.json, and imports back', async () => {
  const [o, a, v] = ['1790500000010', '1790500000011', '1790500000012'];
  for (const [gid, name] of [[o, 'One'], [a, 'Two'], [v, 'Vol']]) await gallery(gid, name, [1]);
  await api.series.write(o, [{ id: o, title: 'One', number: 1 }, { id: a, title: 'Two', number: 2.5 }, { id: v, title: 'Vol', number: 3, kind: 'volume' }],
    { seriesTitle: title('The Series') });
  const { name, files } = await exported(o);
  assert.equal(name, 'The Series');
  const folders = [...new Set(files.map(f => f.name.split('/')[0]).filter(n => n !== 'series.json'))].sort();
  assert.deepEqual(folders, ['The Series Ch. 001', 'The Series Ch. 002.5', 'The Series Vol. 003']);
  const manifest = JSON.parse(new TextDecoder().decode(files.find(f => f.name === 'series.json').data));
  assert.deepEqual(manifest.chapters.map(c => c.folder), folders);

  for (const gid of [o, a, v]) await api.galleries.delete(gid);
  await importCbzBuffer(o, buffer(files), 'The Series.zip', true);
  assert.deepEqual((await api.meta.get(o)).chapters.map(c => [c.id, c.number]), [[o, 1], [a, 2.5], [v, 3]]);
  assert.deepEqual(await blobBytes((await api.pages.get(v, 1)).blob), [...bytes(1)]);
});

test('an export from before the format imports, without storing its copy of the first page as a cover', async () => {
  const gid = '1790500000020';
  const meta = { galleryId: gid, title: title('Old'), tags: [], numPages: 2 };
  const enc = new TextEncoder();
  const old = [
    { name: 'chapter-01/metadata.json', data: enc.encode(JSON.stringify(meta)) },
    { name: 'chapter-01/image_records.json', data: enc.encode(JSON.stringify([{ url: `local://${gid}/1.png` }, { url: `local://${gid}/2.png` }])) },
    { name: 'chapter-01/images/0001.png', data: bytes(1) },
    { name: 'chapter-01/images/0002.png', data: bytes(2) },
    { name: 'chapter-01/covers/gallery.png', data: bytes(1) },   // a copy of page 1
    { name: 'chapter-01/covers/manifest.json', data: enc.encode(JSON.stringify({ version: 1, covers: [{ role: 'gallery', file: 'covers/gallery.png' }] })) },
    { name: 'series.json', data: enc.encode(JSON.stringify({ format: 'shiori-series', version: 1, seriesTitle: 'Old',
      chapters: [{ id: gid, title: 'Old', folder: 'chapter-01' }] })) },
  ];
  const put = api.covers.put;
  const stored = [];
  api.covers.put = (...args) => { stored.push(args); return put(...args); };
  try { await importCbzBuffer(gid, buffer(old), 'old.zip', true); } finally { api.covers.put = put; }
  assert.deepEqual(stored, [], 'its first page is its cover already');
  assert.deepEqual(await blobBytes((await api.pages.get(gid, 2)).blob), [...bytes(2)]);
  const { files } = await exported(gid);
  assert.ok(!files.some(f => f.name.startsWith('covers/')));
});

test('a folder in the format, dropped as it is, imports like its archive — each gallery and series in a dropped library', async () => {
  await gallery('1790500000030', 'Dropped');
  await api.derived.putTranslation('1790500000030', 2, { image: png(8, 8), pipeline: null });
  const single = await exported('1790500000030');
  const [o, a] = ['1790500000031', '1790500000032'];
  for (const [gid, name] of [[o, 'S1'], [a, 'S2']]) await gallery(gid, name, [1]);
  await api.series.write(o, [{ id: o, title: 'S1', number: 1 }, { id: a, title: 'S2', number: 2 }], { seriesTitle: title('Saga') });
  const series = await exported(o);
  for (const gid of ['1790500000030', o, a]) await api.galleries.delete(gid);

  // The whole library folder dropped: a gallery folder, a series folder, and a loose image.
  const entries = [
    ...single.files.map(f => ({ file: new File([f.data], f.name.split('/').pop()), path: `${single.name}/${f.name}` })),
    ...series.files.map(f => ({ file: new File([f.data], f.name.split('/').pop()), path: `${series.name}/${f.name}` })),
    { file: new File([bytes(5)], 'stray.png'), path: 'stray.png' },
  ];
  const groups = groupImports([], [{ name: 'Library', entries }]);
  assert.deepEqual(groups.map(g => g.name), ['Dropped.zip', 'Saga.zip', 'Library.zip']);
  // (The page stages what importBytes gives into a file, which the import engine reads back whole.)
  const staged = async (group) => { const u = new Uint8Array(await importBytes(group)); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
  for (const [i, gid] of [[0, '1790500000030'], [1, o]]) await importCbzBuffer(gid, await staged(groups[i]), groups[i].name, true);

  assert.deepEqual(await blobBytes((await api.pages.get('1790500000030', 2)).translated), [...bytes(8, 8)], 'translations come back too');
  assert.equal((await api.meta.get('1790500000030')).title.english, 'Dropped');
  assert.deepEqual((await api.meta.get(o)).chapters.map(c => c.id), [o, a]);
  assert.deepEqual(await blobBytes((await api.pages.get(a, 1)).blob), [...bytes(1)]);
});

test('a dropped series folder whose member is kept as an archive imports that member as the folder it is the archive of', async () => {
  const [o, a] = ['1790500000041', '1790500000042'];
  for (const [gid, name] of [[o, 'A1'], [a, 'A2']]) await gallery(gid, name, [1]);
  await api.series.write(o, [{ id: o, title: 'A1', number: 1 }, { id: a, title: 'A2', number: 2 }], { seriesTitle: title('Shelf') });
  const series = await exported(o);
  for (const gid of [o, a]) await api.galleries.delete(gid);

  // The desktop library's series folder: the first member a folder, the second archived beside it.
  const member = 'Shelf Ch. 002';
  const archived = zipCreate(series.files.filter(f => f.name.startsWith(`${member}/`)).map(f => ({ name: f.name.slice(member.length + 1), data: f.data })));
  const entries = [
    ...series.files.filter(f => !f.name.startsWith(`${member}/`)).map(f => ({ file: new File([f.data], f.name.split('/').pop()), path: `Shelf/${f.name}` })),
    { file: new File([archived], `${member}.zip`), path: `Shelf/${member}.zip` },
  ];
  const [group] = groupImports([], [{ name: 'Library', entries }]);
  const u = new Uint8Array(await importBytes(group));
  await importCbzBuffer(o, u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength), group.name, true);
  assert.deepEqual((await api.meta.get(o)).chapters.map(c => c.id), [o, a]);
  assert.deepEqual(await blobBytes((await api.pages.get(a, 1)).blob), [...bytes(1)], 'the archived member\'s pages');
});

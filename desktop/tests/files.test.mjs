// files.test.mjs — a desktop library keeps each gallery as a folder in the Shiori gallery format,
// the same layout as its export unzipped: pages staged as they arrive are moved into images/,
// translations, study layers and masks are written under their layout names, a custom cover in
// covers/ (a cover that is the first page is no copy), and the descriptions (metadata.json,
// image_records.json, …) follow: at once after an edit, in due course after pages arrive. Adding a
// page or changing metadata never writes the gallery's other pages again; a replaced or removed
// page's file goes at the next settle, even across a restart. A series keeps its members in "<Series> Ch. 001" folders with series.json; a
// gallery that joins or leaves a series has its folder moved, not rewritten. Folders are deleted
// outright, a file browser showing them moved out first. A gallery kept in an
// archive is read in place and unpacked into a folder once it changes. The library folder carries
// its own id. A zip some other program wrote, with deflated entries, reads as well.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { libraryId } = await import('../server/files.js');
const { readDirectory, readEntry, writeZip } = await import('../server/zip.js');
const { checkInvariants } = await import('../../app/js/library-check.js');
const { exportFiles } = await import('../../app/js/gallery-files.js');

const pngBytes = (...bytes) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...bytes]);
const png = (...bytes) => new Blob([pngBytes(...bytes)], { type: 'image/png' });
const jpeg = (...bytes) => new Blob([new Uint8Array([0xff, 0xd8, 0xff, ...bytes])], { type: 'image/jpeg' });
const webp = (...bytes) => new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, ...bytes])], { type: 'image/webp' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytesOf = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);

function folders() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-files-'));
  return { dir, dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), placeDelay: 60_000, describeDelay: 600_000 };
}
async function open(t, opts = {}, where = folders()) {
  const library = await new Library({ ...where, ...opts }).open();
  t.after(() => { library.close(); fs.rmSync(where.dir, { recursive: true, force: true }); });
  return library;
}
const fileOf = (library, gid) => library._s('SELECT * FROM files WHERE gid = ?').get(gid);
const dirOf = (library, gid) => path.join(library.libraryDir, ...fileOf(library, gid).path.split('/'));
// Every file under `dir`, as relative paths.
function tree(dir) {
  const out = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r); } };
  walk(dir, '');
  return out.sort();
}
const pagesIn = (library, gid) => fs.readdirSync(path.join(dirOf(library, gid), 'images')).sort();
const staged = (library, gid) => (fs.existsSync(path.join(library.stagingDir, gid)) ? fs.readdirSync(path.join(library.stagingDir, gid)).length : 0);
const leftovers = (library) => library._s('SELECT gid, entry FROM leftovers').all();
const json = (library, gid, name) => JSON.parse(fs.readFileSync(path.join(dirOf(library, gid), ...name.split('/')), 'utf8'));
const derived = (dir) => tree(dir).filter(n => !n.startsWith('images/') && !n.endsWith('.json'));
// What identifies a file's bytes on disk: unchanged unless the file was written again.
const identity = (file) => { const s = fs.statSync(file, { bigint: true }); return [s.ino, s.mtimeNs, s.size]; };
const settle = () => new Promise(r => setTimeout(r, 60));   // files dropped by a commit go just after it
// `fn()` once it holds (what an edit writes follows it at once, in the background).
async function until(fn, what) {
  for (const end = Date.now() + 3000; !await Promise.resolve().then(fn).catch(() => false);) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}
async function whole(library) {
  const errors = checkInvariants(await library.integritySnapshot()).violations.filter(v => v.severity === 'error');
  assert.deepEqual(errors.map(v => `${v.id} ${v.detail}`), []);
}
// The export's file names for gallery `gid` (library.js exportGallery → exportFiles).
async function exportNames(library, gid) {
  const { files } = await exportFiles(gid, { read: (id) => library.transferRead(id), metaGet: (id) => library.metaGet(id) });
  return files.map(f => f.name).sort();
}

test('a gallery is settled into a folder of its own in the gallery format, and its pages are read back from it', async (t) => {
  const library = await open(t);
  const gid = '1790000000001';
  await library.metaPut({ galleryId: gid, title: title('My: Gallery?'), tags: [{ type: 'artist', name: 'someone' }], numPages: 3 });
  for (const n of [1, 2, 3]) await library.pagePut(gid, n, png(n));
  assert.equal(staged(library, gid), 3, 'staged until settled');
  await library.files.flush();

  const row = fileOf(library, gid);
  assert.deepEqual([row.path, row.format, row.state, row.pending], ['My Gallery', 'folder', 'packed', 0], 'one folder, named after it, safely');
  assert.deepEqual(tree(dirOf(library, gid)), ['image_records.json', 'images/0001.png', 'images/0002.png', 'images/0003.png', 'metadata.json']);
  assert.equal(json(library, gid, 'metadata.json').galleryId, gid, 'the folder carries its id');
  assert.deepEqual(json(library, gid, 'image_records.json').map(r => r.url), [1, 2, 3].map(n => `local://${gid}/${n}.png`));
  assert.equal(fs.existsSync(path.join(library.stagingDir, gid)), false, 'nothing is left staged, nor its folder in staging');
  assert.deepEqual(await bytesOf((await library.pageGet(gid, 2)).blob), [...pngBytes(2)]);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 3)), [...pngBytes(3)]);
  assert.deepEqual(tree(dirOf(library, gid)), await exportNames(library, gid), 'the folder is its export, unzipped');
  await whole(library);
});

test('adding a page or changing metadata never writes the other pages again; the descriptions follow pages in due course, edits at once', async (t) => {
  const library = await open(t);
  const gid = '1790000000005';
  await library.metaPut({ galleryId: gid, title: title('Growing'), numPages: 3 });
  for (const n of [1, 2]) await library.pagePut(gid, n, png(n));
  await library.files.place(gid);
  const dir = dirOf(library, gid);
  assert.deepEqual(tree(dir), ['images/0001.png', 'images/0002.png'], 'pages moved in at once; descriptions not yet');
  await library.files.flush();
  assert.ok(fs.existsSync(path.join(dir, 'metadata.json')), 'written when the app closes (or after a quiet while)');
  const before = ['0001.png', '0002.png'].map(f => identity(path.join(dir, 'images', f)));

  await library.pagePut(gid, 3, png(3));
  await library.files.flush();
  assert.deepEqual(pagesIn(library, gid), ['0001.png', '0002.png', '0003.png']);
  assert.deepEqual(['0001.png', '0002.png'].map(f => identity(path.join(dir, 'images', f))), before, 'pages 1 and 2 untouched');
  assert.equal(json(library, gid, 'image_records.json').length, 3);

  await library.mutateGallery(gid, { title: title('Grown') });
  await until(() => json(library, gid, 'metadata.json').title.english === 'Grown' && fileOf(library, gid).pending === 0,
    'the description follows its metadata at once');
  assert.deepEqual(['0001.png', '0002.png'].map(f => identity(path.join(dir, 'images', f))), before, 'still untouched');
  assert.equal(fileOf(library, gid).pending, 0);
  await whole(library);
});

test('a replaced or removed page’s file goes at the next settle', async (t) => {
  const library = await open(t);
  const gid = '1790000000002';
  await library.metaPut({ galleryId: gid, title: title('Replace'), numPages: 3 });
  for (const n of [1, 2, 3]) await library.pagePut(gid, n, png(n));
  await library.files.flush();
  const dir = dirOf(library, gid);

  await library.pagePut(gid, 2, png(22, 22));
  assert.deepEqual(await bytesOf((await library.pageGet(gid, 2)).blob), [...pngBytes(22, 22)], 'the new page reads at once');
  await library.files.flush();
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'images', '0002.png'))], [...pngBytes(22, 22)]);

  await library.pagePut(gid, 1, jpeg(1));   // another type: another name
  await library.files.flush();
  assert.deepEqual(pagesIn(library, gid), ['0001.jpg', '0002.png', '0003.png'], 'the old file of page 1 is gone');

  await library.deleteStaleGalleryImages(gid, [`local://${gid}/1.jpg`, `local://${gid}/2.png`]);
  assert.ok(fs.existsSync(path.join(dir, 'images', '0003.png')), 'kept until the gallery settles');
  await library.files.flush();
  assert.deepEqual(pagesIn(library, gid), ['0001.jpg', '0002.png']);
  assert.equal((await library.getGallery(gid)).count, 2);
  assert.deepEqual(leftovers(library), []);
  await whole(library);
});

test('a removed page’s file goes even when the app closed before settling', async (t) => {
  const where = folders();
  const first = await new Library(where).open();
  const gid = '1790000000006';
  await first.metaPut({ galleryId: gid, title: title('Restart'), numPages: 2 });
  for (const n of [1, 2]) await first.pagePut(gid, n, png(n));
  await first.files.flush();
  await first.deleteStaleGalleryImages(gid, [`local://${gid}/1.png`]);
  first.close();

  const library = await open(t, {}, where);
  await library.files.flush();
  assert.deepEqual(pagesIn(library, gid), ['0001.png']);
  assert.deepEqual(leftovers(library), []);
  assert.equal(json(library, gid, 'image_records.json').length, 1, 'its description caught up too');
  await whole(library);
});

test('a page moved into its folder just before an interruption is found there', async (t) => {
  const library = await open(t);
  const gid = '1790000000007';
  await library.metaPut({ galleryId: gid, title: title('Interrupted'), numPages: 2 });
  await library.pagePut(gid, 1, png(1));
  await library.files.flush();
  await library.pagePut(gid, 2, png(2));
  const orig = JSON.parse(library._pageRow(gid, 2).orig);
  fs.renameSync(path.join(library.stagingDir, orig.file), path.join(dirOf(library, gid), 'images', '0002.png'));   // moved; its row not yet
  await library.files.flush();
  assert.deepEqual(JSON.parse(library._pageRow(gid, 2).orig), { at: 'p', entry: 'images/0002.png', size: orig.size, type: 'image/png' });
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [...pngBytes(2)]);
  await whole(library);
});

test('a series keeps its members in "<Series> Ch. 001" folders with series.json; joining or leaving moves a folder, never rewrites it', async (t) => {
  const vacated = [];
  const library = await open(t, { vacate: async (from, to) => { vacated.push([from, to]); } });
  const [o, a, v] = ['1790000000010', '1790000000011', '1790000000012'];
  for (const [gid, name] of [[o, 'One'], [a, 'Two'], [v, 'Vol']]) {
    await library.metaPut({ galleryId: gid, title: title(name), numPages: 1, ...(gid === v ? { kind: 'volume' } : {}) });
    await library.pagePut(gid, 1, png(1));
  }
  await library.files.flush();
  assert.deepEqual([o, a, v].map(gid => fileOf(library, gid).path), ['One', 'Two', 'Vol'], 'each on its own at first');
  const page = identity(path.join(dirOf(library, a), 'images', '0001.png'));

  await library.seriesCommand('write', o, [{ id: o, title: 'One', number: 1 }, { id: a, title: 'Two', number: 2.5 }, { id: v, title: 'Vol', number: 3, kind: 'volume' }],
    { seriesTitle: title('The Series') });
  await library.files.flush();
  assert.deepEqual([o, a, v].map(gid => fileOf(library, gid).path),
    ['The Series/The Series Ch. 001', 'The Series/The Series Ch. 002.5', 'The Series/The Series Vol. 003'], 'moved into the series\' folder');
  assert.deepEqual(identity(path.join(dirOf(library, a), 'images', '0001.png')), page, 'moved, not written again');
  assert.ok(vacated.some(([from]) => from === path.join(library.libraryDir, 'Two')), 'a file browser showing it was moved out first');
  const series = JSON.parse(fs.readFileSync(path.join(library.libraryDir, 'The Series', 'series.json'), 'utf8'));
  assert.deepEqual(series.chapters.map(c => [c.id, c.folder]),
    [[o, 'The Series Ch. 001'], [a, 'The Series Ch. 002.5'], [v, 'The Series Vol. 003']]);
  assert.deepEqual(tree(path.join(library.libraryDir, 'The Series')), await exportNames(library, o), 'the series\' folder is its export, unzipped');

  await library.seriesCommand('remove', o, a);
  await library.files.flush();
  assert.equal(fileOf(library, a).path, 'Two', 'a gallery that left the series is on its own again');
  assert.deepEqual(identity(path.join(dirOf(library, a), 'images', '0001.png')), page);
  await whole(library);
});

test('deleting a gallery deletes its folder outright, a file browser showing it moved out first', async (t) => {
  const vacated = [];
  const library = await open(t, { vacate: async (from, to) => { vacated.push([from, to]); } });
  const gid = '1790000000030';
  await library.metaPut({ galleryId: gid, title: title('Gone'), numPages: 1 });
  await library.pagePut(gid, 1, png(1));
  await library.files.flush();
  const dir = dirOf(library, gid);
  vacated.length = 0;
  await library.deleteGallery(gid);
  await settle();
  assert.deepEqual(vacated, [[dir, library.libraryDir]]);
  assert.equal(fs.existsSync(dir), false, 'gone, not kept anywhere');
  assert.ok(fs.existsSync(library.libraryDir), 'the library folder itself stays');
  assert.equal(fileOf(library, gid), undefined);
});

test('a page stored while its gallery is being settled is settled next', async (t) => {
  const library = await open(t);
  const gid = '1790000000040';
  await library.metaPut({ galleryId: gid, title: title('Busy'), numPages: 2 });
  await library.pagePut(gid, 1, png(1));
  const placing = library.files.place(gid);
  await library.pagePut(gid, 2, png(2));   // lands while the first settle runs
  await placing;
  await library.files.flush();
  await library.files.place(gid);
  assert.deepEqual(pagesIn(library, gid), ['0001.png', '0002.png']);
  await whole(library);
});

// An archive gallery as an earlier version saved it: the scan adds it under the id it carries.
async function archived(library, gid, pages) {
  const rel = 'Old/Old Ch. 001.cbz';
  fs.mkdirSync(path.join(library.libraryDir, 'Old'), { recursive: true });
  await writeZip(path.join(library.libraryDir, rel), [
    ...pages.map(n => ({ name: `${String(n).padStart(4, '0')}.png`, data: pngBytes(n) })),
    { name: 'shiori.json', data: Buffer.from(JSON.stringify({ format: 'shiori-gallery', version: 1, id: gid,
      meta: { galleryId: gid, title: title('Old'), tags: [], numPages: pages.length },
      pages: pages.map(n => ({ n, file: `${String(n).padStart(4, '0')}.png`, key: `local://${gid}/${n}.png` })) })) },
  ]);
  assert.deepEqual((await library.rescan()).added, [gid]);
  assert.deepEqual([fileOf(library, gid).path, fileOf(library, gid).format], [rel, 'cbz']);
  return path.join(library.libraryDir, rel);
}

test('a gallery kept in an archive is read in place, and unpacked into a folder once its pages change', async (t) => {
  const removed = [];
  const library = await open(t, { remove: async (p) => { removed.push(p); fs.rmSync(p, { force: true }); } });
  const gid = '1790000000050';
  const archive = await archived(library, gid, [1, 2]);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [...pngBytes(2)], 'read from the archive');

  await library.mutateGallery(gid, { favorite: true }, { touch: false });
  await library.files.flush();
  assert.equal(fileOf(library, gid).format, 'cbz', 'a metadata change leaves the archive as it is');

  await library.pagePut(gid, 3, png(3));
  await library.files.flush();
  const row = fileOf(library, gid);
  assert.deepEqual([row.path, row.format, row.pending], ['Old/Old Ch. 001', 'folder', 0]);
  assert.deepEqual(tree(dirOf(library, gid)), ['image_records.json', 'images/0001.png', 'images/0002.png', 'images/0003.png', 'metadata.json']);
  assert.deepEqual(removed, [archive], 'the archive is deleted');
  for (const n of [1, 2, 3]) assert.deepEqual(await bytesOf(await library.getPageBlob(gid, n)), [...pngBytes(n)]);
  assert.equal(json(library, gid, 'metadata.json').favorite, true);
  await whole(library);
});

test('a page removed from an archive gallery unpacks it without that page', async (t) => {
  const library = await open(t);
  const gid = '1790000000051';
  await archived(library, gid, [1, 2, 3]);
  await library.deleteStaleGalleryImages(gid, [`local://${gid}/1.png`, `local://${gid}/3.png`]);
  await library.files.flush();
  assert.equal(fileOf(library, gid).format, 'folder');
  assert.deepEqual(pagesIn(library, gid), ['0001.png', '0003.png']);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 3)), [...pngBytes(3)]);
  await whole(library);
});

test('a gallery whose folder is gone reads as missing, waits, and reads again when it is back', async (t) => {
  const where = folders();
  const library = await open(t, {}, where);
  const gid = '1790000000060';
  await library.metaPut({ galleryId: gid, title: title('Away'), numPages: 2 });
  await library.pagePut(gid, 1, png(1));
  await library.files.flush();
  const dir = dirOf(library, gid);
  const away = path.join(where.dir, 'away');
  fs.renameSync(dir, away);

  assert.equal(await library.getPageBlob(gid, 1), null, 'its missing page shows as a placeholder');
  assert.equal((await library.getGallery(gid)).missing, true, 'marked missing once read');
  await library.pagePut(gid, 2, png(2));
  await library.files.flush();
  assert.equal(fs.existsSync(dir), false, 'no new folder is started in its old place');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [...pngBytes(2)], 'the new page reads from staging');

  fs.renameSync(away, dir);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1)), [...pngBytes(1)]);
  assert.equal((await library.getGallery(gid)).missing, undefined, 'readable again');
  await library.files.place(gid);
  assert.deepEqual(pagesIn(library, gid), ['0001.png', '0002.png'], 'what waited is settled');
  await whole(library);
});

test('translations, study layers and masks are written under their layout names, and go with the folder', async (t) => {
  const removed = [];
  const library = await open(t, { remove: async (p) => {
    await new Promise(r => setTimeout(r, 30));   // deleting a folder takes a moment; anything deleted meanwhile is gone
    removed.push([p, derived(p)]);
    fs.rmSync(p, { recursive: true, force: true });
  } });
  const gid = '1790000000070';
  await library.metaPut({ galleryId: gid, title: title('Translated'), numPages: 2 });
  for (const n of [1, 2]) await library.pagePut(gid, n, png(n));
  await library.files.flush();
  const at = { galleryId: gid, pageNum: 1 };
  const dir = dirOf(library, gid);

  await library.putTranslatedPage(at, png(9), { job: 'j1', lines: [], read: [], regions: [], masks: { raw: webp(4), text: webp(5) } });
  await library.putPageStudy(at, { bg: webp(7), page: { w: 10, h: 10 }, bubbles: [{ box: [0, 0, 1, 1], text: png(8) }] });
  const rec = JSON.parse(library._pageRow(gid, 1).record);
  assert.deepEqual([rec.translated.$own, rec.studyBg.$own, rec.bubbles[0].text.$own, rec.pipeline.masks.raw.$own],
    ['translated/0001.png', 'study/bg/0001.webp', 'study/text/0001-0.png', 'pipeline/0001-raw.webp']);
  assert.deepEqual(derived(dir),
    ['pipeline/0001-raw.webp', 'pipeline/0001-text.webp', 'study/bg/0001.webp', 'study/text/0001-0.png', 'translated/0001.png'], 'nothing temporary left');
  assert.ok(!fs.existsSync(path.join(library.cacheDir, gid)), 'nothing of it in this computer’s cache');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1, 'translated')), [...pngBytes(9)]);
  assert.deepEqual(await bytesOf((await library.pageGet(gid, 1)).studyBg), await bytesOf(webp(7)));
  await library.files.flush();
  assert.deepEqual(tree(dir), await exportNames(library, gid), 'the folder is its export, unzipped');
  await whole(library);

  await library.putTranslatedPage(at, png(10), null);   // translated again: the same name, its new picture; the study layers and masks go
  await settle();
  assert.deepEqual(derived(dir), ['translated/0001.png']);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1, 'translated')), [...pngBytes(10)]);
  await library.clearGalleryTranslations(gid);
  await settle();
  assert.deepEqual(derived(dir), []);

  await library.putTranslatedPage(at, png(11), null);
  await library.deleteGallery(gid);
  await settle(); await settle();
  assert.deepEqual(removed, [[dir, ['translated/0001.png']]], 'the folder is deleted with its translation in it');
});

test('a translation written before its gallery settles gives the gallery its folder', async (t) => {
  const library = await open(t);
  const gid = '1790000000071';
  await library.metaPut({ galleryId: gid, title: title('Early'), numPages: 2 });
  for (const n of [1, 2]) await library.pagePut(gid, n, png(n));
  assert.equal(fileOf(library, gid), undefined, 'not settled yet');
  await library.putTranslatedPage({ galleryId: gid, pageNum: 2 }, png(9), null);
  assert.equal(fileOf(library, gid).path, 'Early', 'its folder, named as a settle would');
  await library.files.flush();
  assert.deepEqual(tree(dirOf(library, gid)), ['image_records.json', 'images/0001.png', 'images/0002.png', 'metadata.json', 'translated/0002.png']);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2, 'translated')), [...pngBytes(9)]);
  await whole(library);
});

test('a translation of a gallery kept in an archive unpacks it first', async (t) => {
  const library = await open(t);
  const gid = '1790000000072';
  await archived(library, gid, [1, 2]);
  await library.putTranslatedPage({ galleryId: gid, pageNum: 1 }, png(9), null);
  assert.equal(fileOf(library, gid).format, 'folder');
  assert.deepEqual(tree(dirOf(library, gid)).filter(n => !n.endsWith('.json')), ['images/0001.png', 'images/0002.png', 'translated/0001.png']);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1, 'translated')), [...pngBytes(9)]);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [...pngBytes(2)]);
  await whole(library);
});

test('a cover that is the first page is no copy; one of its own is kept in covers/', async (t) => {
  const library = await open(t);
  const gid = '1790000000080';
  await library.metaPut({ galleryId: gid, title: title('Covers'), numPages: 2 });
  for (const n of [1, 2]) await library.pagePut(gid, n, png(n));
  await library.files.flush();
  await library.coverPut(gid, png(1), { role: 'gallery' });   // the first page, handed over again
  assert.deepEqual(library._coverGet(gid).cover, { $page: 1, size: png(1).size, type: 'image/png' });
  await library.files.flush();
  assert.ok(!fs.existsSync(path.join(dirOf(library, gid), 'covers')), 'no copy');

  await library.coverPut(gid, webp(3, 3), { role: 'gallery' });
  await library.files.flush();
  assert.deepEqual(library._coverGet(gid).cover.$own, 'covers/gallery.webp');
  assert.deepEqual(tree(dirOf(library, gid)).filter(n => n.startsWith('covers/')), ['covers/gallery.webp', 'covers/manifest.json']);
  assert.deepEqual(await bytesOf(await library.coverGet(gid)), await bytesOf(webp(3, 3)));
  assert.deepEqual(tree(dirOf(library, gid)), await exportNames(library, gid), 'the folder is its export, unzipped');
  await whole(library);
});

test('the library folder carries its own id, made once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-id-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = libraryId(dir);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(libraryId(dir), id, 'the same id every time');
  const moved = path.join(dir, '..', `${path.basename(dir)}-moved`);
  fs.renameSync(dir, moved);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  assert.equal(libraryId(moved), id, 'wherever the folder goes');
  fs.writeFileSync(path.join(moved, '.shiori', 'library.json'), '{ broken');
  assert.throws(() => libraryId(moved), 'an unreadable file is an error, not a new library');
  fs.writeFileSync(path.join(moved, '.shiori', 'library.json'), JSON.stringify({ id: '../x' }));
  assert.throws(() => libraryId(moved));
});

test('a zip another program wrote, with deflated entries, is read', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-zip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'other.zip');
  await writeZip(file, [{ name: 'a.txt', data: Buffer.from('stored') }]);
  // Rewrite the one entry deflated, as most zip tools write text.
  const data = Buffer.from('hello hello hello hello');
  const packed = zlib.deflateRawSync(data);
  const name = Buffer.from('b.txt');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(zlib.crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(zlib.crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const body = Buffer.concat([local, name, packed]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(body.length, 16);
  fs.writeFileSync(path.join(dir, 'deflated.zip'), Buffer.concat([body, central, name, end]));
  const entries = await readDirectory(path.join(dir, 'deflated.zip'));
  assert.equal(String(await readEntry(path.join(dir, 'deflated.zip'), entries.get('b.txt'))), 'hello hello hello hello');
  assert.equal(String(await readEntry(file, (await readDirectory(file)).get('a.txt'))), 'stored');
});

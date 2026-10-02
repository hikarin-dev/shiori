// files.test.mjs — a desktop library keeps each gallery as files: pages staged as they arrive are
// packed into the gallery's archive (or folder) with shiori.json and ComicInfo.xml, read back from
// there, repacked when a page is replaced or pruned, and put away when the gallery is deleted. A
// zip some other program wrote, with deflated entries, reads as well.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { readDirectory, readEntry, writeZip } = await import('../server/zip.js');
const { checkInvariants } = await import('../../app/js/library-check.js');

const png = (...bytes) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...bytes])], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytesOf = async (blob) => [...new Uint8Array(await blob.arrayBuffer())];

async function open(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-files-'));
  const library = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), packDelay: 60_000, ...opts }).open();
  t.after(() => { library.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return library;
}
const fileOf = (library, gid) => library._s('SELECT * FROM files WHERE gid = ?').get(gid);
const staged = (library, gid) => fs.readdirSync(path.join(library.stagingDir, gid), { withFileTypes: true }).length;
async function whole(library) {
  const errors = checkInvariants(await library.integritySnapshot()).violations.filter(v => v.severity === 'error');
  assert.deepEqual(errors.map(v => `${v.id} ${v.detail}`), []);
}

test('a gallery is packed into its own archive, and its pages are read back from it', async (t) => {
  const library = await open(t);
  const gid = '1790000000001';
  await library.metaPut({ galleryId: gid, title: title('My: Gallery?'), tags: [{ type: 'artist', name: 'someone' }, { type: 'rating', name: 'safe' }], numPages: 3 });
  for (const n of [1, 2, 3]) await library.pagePut(gid, n, png(n));
  assert.equal(staged(library, gid), 3, 'staged until packed');
  await library.files.flush();

  const row = fileOf(library, gid);
  assert.deepEqual([row.path, row.format, row.state], ['My Gallery/My Gallery.cbz', 'cbz', 'packed'], 'named after it, safely');
  const archive = path.join(library.libraryDir, 'My Gallery', 'My Gallery.cbz');
  const entries = await readDirectory(archive);
  assert.deepEqual([...entries.keys()], ['0001.png', '0002.png', '0003.png', 'shiori.json', 'ComicInfo.xml']);
  const described = JSON.parse(await readEntry(archive, entries.get('shiori.json')));
  assert.equal(described.id, gid, 'the archive carries its id');
  assert.deepEqual(described.pages.map(p => [p.n, p.file]), [[1, '0001.png'], [2, '0002.png'], [3, '0003.png']]);
  const comicInfo = String(await readEntry(archive, entries.get('ComicInfo.xml')));
  assert.match(comicInfo, /<Writer>someone<\/Writer>/);
  assert.match(comicInfo, /<AgeRating>Everyone<\/AgeRating>/);
  assert.match(comicInfo, /<PageCount>3<\/PageCount>/);
  assert.equal(staged(library, gid), 0, 'nothing is left staged');

  assert.deepEqual(await bytesOf((await library.pageGet(gid, 2)).blob), await bytesOf(png(2)));
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 3)), await bytesOf(png(3)));
  await whole(library);
});

test('a page replaced or pruned after packing is packed again', async (t) => {
  const library = await open(t);
  const gid = '1790000000002';
  await library.metaPut({ galleryId: gid, title: title('Repack'), numPages: 3 });
  for (const n of [1, 2, 3]) await library.pagePut(gid, n, png(n));
  await library.files.flush();
  const archive = path.join(library.libraryDir, fileOf(library, gid).path);

  await library.pagePut(gid, 2, png(22, 22));
  assert.deepEqual(await bytesOf((await library.pageGet(gid, 2)).blob), await bytesOf(png(22, 22)), 'the new page reads at once');
  await library.files.flush();
  assert.deepEqual([...await readEntry(archive, (await readDirectory(archive)).get('0002.png'))], await bytesOf(png(22, 22)));

  await library.deleteStaleGalleryImages(gid, [`local://${gid}/1.png`, `local://${gid}/2.png`]);
  await library.files.flush();
  assert.deepEqual([...(await readDirectory(archive)).keys()].filter(n => /^\d/.test(n)), ['0001.png', '0002.png']);
  assert.equal((await library.getGallery(gid)).count, 2);
  await whole(library);
});

test('a series keeps its members in one folder, named by their numbers', async (t) => {
  const library = await open(t);
  const [o, a, v] = ['1790000000010', '1790000000011', '1790000000012'];
  for (const [gid, name] of [[o, 'One'], [a, 'Two'], [v, 'Vol']]) {
    await library.metaPut({ galleryId: gid, title: title(name), numPages: 1, ...(gid === v ? { kind: 'volume' } : {}) });
    await library.pagePut(gid, 1, png(1));
  }
  await library.seriesCommand('write', o, [{ id: o, title: 'One', number: 1 }, { id: a, title: 'Two', number: 2.5 }, { id: v, title: 'Vol', number: 3, kind: 'volume' }],
    { seriesTitle: title('The Series') });
  await library.files.flush();
  assert.deepEqual([o, a, v].map(gid => fileOf(library, gid).path),
    ['The Series/The Series Ch. 001.cbz', 'The Series/The Series Ch. 002.5.cbz', 'The Series/The Series Vol. 003.cbz']);
  const info = String(await readEntry(path.join(library.libraryDir, 'The Series/The Series Vol. 003.cbz'),
    (await readDirectory(path.join(library.libraryDir, 'The Series/The Series Vol. 003.cbz'))).get('ComicInfo.xml')));
  assert.match(info, /<Series>The Series<\/Series>/);
  assert.match(info, /<Volume>3<\/Volume>/);
  await whole(library);
});

test('a gallery written as a folder of images reads the same', async (t) => {
  const library = await open(t);
  library._kvSet('writeFormat', 'folder');
  const gid = '1790000000020';
  await library.metaPut({ galleryId: gid, title: title('Folder'), numPages: 2 });
  for (const n of [1, 2]) await library.pagePut(gid, n, png(n));
  await library.files.flush();
  const dir = path.join(library.libraryDir, 'Folder', 'Folder');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['0001.png', '0002.png', 'ComicInfo.xml', 'shiori.json']);
  await library.pagePut(gid, 1, png(9));
  await library.files.flush();
  assert.deepEqual([...fs.readFileSync(path.join(dir, '0001.png'))], await bytesOf(png(9)), 'replaced in place, whole');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1)), await bytesOf(png(9)));
  await whole(library);
});

test('deleting a gallery puts its files away', async (t) => {
  const trashed = [];
  const library = await open(t, { trash: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); } });
  const gid = '1790000000030';
  await library.metaPut({ galleryId: gid, title: title('Gone'), numPages: 1 });
  await library.pagePut(gid, 1, png(1));
  await library.files.flush();
  const archive = path.join(library.libraryDir, fileOf(library, gid).path);
  assert.ok(fs.existsSync(archive));
  await library.deleteGallery(gid);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(trashed, [archive]);
  assert.equal(fs.existsSync(path.dirname(archive)), false, 'its emptied folder goes too');
  assert.equal(fileOf(library, gid), undefined);
});

test('a page changed while its gallery is being packed waits for the next pack', async (t) => {
  const library = await open(t);
  const gid = '1790000000040';
  await library.metaPut({ galleryId: gid, title: title('Busy'), numPages: 2 });
  await library.pagePut(gid, 1, png(1));
  const packing = library.files.pack(gid);
  await library.pagePut(gid, 2, png(2));   // lands while the first pack writes
  await packing;
  await library.files.flush();
  await library.files.pack(gid);
  const archive = path.join(library.libraryDir, fileOf(library, gid).path);
  assert.deepEqual([...(await readDirectory(archive)).keys()].filter(n => /^\d/.test(n)), ['0001.png', '0002.png']);
  await whole(library);
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

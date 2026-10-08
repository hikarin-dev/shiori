// scan.test.mjs — the full check: the library folder may change while the app isn't looking (and the
// app doesn't look on its own): a gallery moved or renamed is found again by its id, one whose files
// are gone is marked missing (and found again when they come back), archives and image folders added
// by hand join the library, the index can be rebuilt from the files alone (a folder in the gallery
// format with its translations, where they lie), and leftovers of interrupted writes are cleared.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { writeZip } = await import('../server/zip.js');
const { checkInvariants } = await import('../../app/js/library-check.js');

const pngBytes = (...b) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...b]);
const png = (...b) => new Blob([pngBytes(...b)], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytesOf = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);

function folders() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-scan-'));
  return { dir, dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), placeDelay: 60_000 };
}
// Closed, then its folders removed, when the test ends.
async function open(t, where) {
  const library = await new Library(where).open();
  t.after(() => { library.close(); fs.rmSync(where.dir, { recursive: true, force: true }); });
  return library;
}
const pathOf = (library, gid) => library._s('SELECT path FROM files WHERE gid = ?').get(gid)?.path;
async function settled(library, gid, name, pages = [1, 2]) {
  await library.metaPut({ galleryId: gid, title: title(name), tags: [], numPages: pages.length });
  for (const n of pages) await library.pagePut(gid, n, png(n));
  await library.files.flush();
  return path.join(library.libraryDir, pathOf(library, gid));
}
async function whole(library) {
  const errors = checkInvariants(await library.integritySnapshot()).violations.filter(v => v.severity === 'error');
  assert.deepEqual(errors.map(v => `${v.id} ${v.detail}`), []);
}

test('a gallery moved or renamed outside the app is found again by its id', async (t) => {
  const library = await open(t, folders());
  const gid = '1790000000101';
  const folder = await settled(library, gid, 'Wanderer');
  fs.mkdirSync(path.join(library.libraryDir, 'Elsewhere'));
  fs.renameSync(folder, path.join(library.libraryDir, 'Elsewhere', 'renamed'));
  const result = await library.rescan();
  assert.deepEqual(result.moved, [gid]);
  assert.equal(pathOf(library, gid), 'Elsewhere/renamed');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [...pngBytes(2)]);
  await whole(library);
});

test('a gallery whose files are gone is missing, not deleted, and comes back with them', async (t) => {
  const where = folders();
  const library = await open(t, where);
  const gid = '1790000000102';
  const folder = await settled(library, gid, 'Away');
  const away = path.join(where.dir, 'away');   // out of the library folder
  fs.renameSync(folder, away);
  assert.deepEqual((await library.rescan()).missing, [gid]);
  const entity = await library.getGallery(gid);
  assert.equal(entity.missing, true);
  assert.equal(entity.count, 2, 'still in the library, with what it had');
  assert.equal(await library.getPageBlob(gid, 1), null);
  fs.renameSync(away, folder);
  assert.deepEqual((await library.rescan()).found, [gid]);
  assert.equal((await library.getGallery(gid)).missing, undefined);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1)), [...pngBytes(1)]);
});

test('archives and image folders added by hand join the library', async (t) => {
  const where = folders();
  fs.mkdirSync(path.join(where.libraryDir, 'Added', 'Loose pages'), { recursive: true });
  await writeZip(path.join(where.libraryDir, 'Added', 'By Hand.cbz'), [
    { name: 'p10.png', data: pngBytes(10) }, { name: 'p2.png', data: pngBytes(2) }, { name: 'notes.txt', data: Buffer.from('x') }]);
  fs.writeFileSync(path.join(where.libraryDir, 'Added', 'Loose pages', '1.png'), pngBytes(7));
  const library = await open(t, where);
  const { added } = await library.rescan();
  assert.equal(added.length, 2);
  const entities = await library.getGalleriesByIds(added);
  const byTitle = Object.fromEntries(entities.map(e => [e.title.english, e]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['By Hand', 'Loose pages']);
  const hand = byTitle['By Hand'];
  assert.equal(hand.count, 2, 'its images, nothing else');
  assert.deepEqual(await bytesOf(await library.getPageBlob(hand.id, 1)), [...pngBytes(2)], 'in reading order: p2 before p10');
  assert.deepEqual(await bytesOf(await library.getPageBlob(byTitle['Loose pages'].id, 1)), [...pngBytes(7)]);
  assert.deepEqual((await library.rescan()).added, [], 'found once');
  await whole(library);
});

test('the index can be rebuilt from the files alone', async (t) => {
  const where = folders();
  const first = await new Library(where).open();
  const gid = '1790000000103';
  await settled(first, gid, 'Kept');
  await first.galleriesPage();
  first.close();
  fs.rmSync(where.dataDir, { recursive: true, force: true });   // the index is lost

  const library = await open(t, where);
  assert.equal(library.indexEmpty(), true, 'an empty index: the app checks the folder once at start');
  assert.deepEqual((await library.rescan()).added, [gid], 'under the id its files carry');
  assert.equal(library.indexEmpty(), false);
  const meta = await library.metaGet(gid);
  assert.equal(meta.title.english, 'Kept');
  assert.deepEqual((await library.pageList(gid)).map(p => p.url), [`local://${gid}/1.png`, `local://${gid}/2.png`], 'with its page keys');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [...pngBytes(2)]);
  await whole(library);
});

test('leftovers of an interrupted write are cleared', async (t) => {
  const library = await open(t, folders());
  const gid = '1790000000104';
  const folder = await settled(library, gid, 'Tidy');
  fs.mkdirSync(`${folder}.shiori-tmp`);
  fs.writeFileSync(path.join(`${folder}.shiori-tmp`, '0001.png'), pngBytes(1));   // half an unpacked archive
  fs.writeFileSync(path.join(folder, 'shiori.json.shiori-tmp'), 'half a description');
  const stray = path.join(library.stagingDir, gid, '9-stray.png');
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.writeFileSync(stray, pngBytes(9));
  const fresh = path.join(library.stagingDir, gid, '8-writing.png');
  fs.writeFileSync(fresh, pngBytes(8));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(stray, old, old);
  await library.rescan();
  assert.equal(fs.existsSync(`${folder}.shiori-tmp`), false);
  assert.equal(fs.existsSync(path.join(folder, 'shiori.json.shiori-tmp')), false);
  assert.equal(fs.existsSync(stray), false, 'a staged page nothing refers to');
  assert.equal(fs.existsSync(fresh), true, 'one just written may still be on its way');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1)), [...pngBytes(1)]);
});

test('a translation file no page refers to is cleared from the gallery’s folder', async (t) => {
  const library = await open(t, folders());
  const gid = '1790000000105';
  const folder = await settled(library, gid, 'Layers');
  await library.putTranslatedPage({ galleryId: gid, pageNum: 1 }, png(9), null);
  const kept = JSON.parse(library._pageRow(gid, 1).record).translated.$own;
  assert.equal(kept, 'translated/0001.png');
  const stray = path.join(folder, 'translated', '0002.png');
  fs.writeFileSync(stray, pngBytes(5));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(stray, old, old);
  fs.utimesSync(path.join(folder, 'translated', '0001.png'), old, old);
  await library.rescan();
  assert.deepEqual(fs.readdirSync(path.join(folder, 'translated')), ['0001.png']);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1, 'translated')), [...pngBytes(9)]);
});

test('the index rebuilt from a folder in the gallery format has its translations and study layers, where they lie', async (t) => {
  const where = folders();
  const first = await new Library(where).open();
  const gid = '1790000000106';
  await settled(first, gid, 'Kept Translated');
  await first.putTranslatedPage({ galleryId: gid, pageNum: 1 }, png(9), { job: 'j1', lines: [], read: [], regions: [], masks: { raw: png(4) } }, 'j1');
  await first.putPageStudy({ galleryId: gid, pageNum: 2 }, { bg: png(7), page: { w: 10, h: 10 },
    bubbles: [{ box: [0, 0, 1, 1], region: [0, 0, 1, 1], tr: 'Hi', src: 'やあ', text: png(8) }] });
  await first.files.flush();
  first.close();
  fs.rmSync(where.dataDir, { recursive: true, force: true });   // the index is lost

  const library = await open(t, where);
  assert.deepEqual((await library.rescan()).added, [gid]);
  const one = await library.pageGet(gid, 1);
  assert.deepEqual(await bytesOf(one.translated), [...pngBytes(9)], 'its translation');
  assert.equal(one.pipeline.job, 'j1');
  assert.deepEqual(await bytesOf(one.pipeline.masks.raw), [...pngBytes(4)], 'its masks');
  assert.equal(one.own, 'j1');
  const two = await library.pageGet(gid, 2);
  assert.deepEqual([two.bubbles.length, two.bubbles[0].tr], [1, 'Hi'], 'its study layers');
  assert.deepEqual(await bytesOf(two.bubbles[0].text), [...pngBytes(8)]);
  assert.deepEqual(await bytesOf(two.studyBg), [...pngBytes(7)]);
  await whole(library);
});

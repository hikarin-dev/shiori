// scan.test.mjs — the library folder may change while the app isn't looking: a gallery moved or
// renamed is found again by its id, one whose files are gone is marked missing (and found again
// when they come back), archives and image folders added by hand join the library, the index can be
// rebuilt from the files alone, and leftovers of interrupted writes are cleared.
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
  return { dir, dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), packDelay: 60_000 };
}
// Closed, then its folders removed, when the test ends.
async function open(t, where) {
  const library = await new Library(where).open();
  t.after(() => { library.close(); fs.rmSync(where.dir, { recursive: true, force: true }); });
  return library;
}
const pathOf = (library, gid) => library._s('SELECT path FROM files WHERE gid = ?').get(gid)?.path;
async function packed(library, gid, name, pages = [1, 2]) {
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
  const archive = await packed(library, gid, 'Wanderer');
  fs.mkdirSync(path.join(library.libraryDir, 'Elsewhere'));
  fs.renameSync(archive, path.join(library.libraryDir, 'Elsewhere', 'renamed.cbz'));
  const result = await library.rescan();
  assert.deepEqual(result.moved, [gid]);
  assert.equal(pathOf(library, gid), 'Elsewhere/renamed.cbz');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [...pngBytes(2)]);
  await whole(library);
});

test('a gallery whose files are gone is missing, not deleted, and comes back with them', async (t) => {
  const library = await open(t, folders());
  const gid = '1790000000102';
  const archive = await packed(library, gid, 'Away');
  fs.renameSync(archive, `${archive}.away`);
  assert.deepEqual((await library.rescan()).missing, [gid]);
  const entity = await library.getGallery(gid);
  assert.equal(entity.missing, true);
  assert.equal(entity.count, 2, 'still in the library, with what it had');
  assert.equal(await library.getPageBlob(gid, 1), null);
  fs.renameSync(`${archive}.away`, archive);
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
  await packed(first, gid, 'Kept');
  await first.galleriesPage();
  first.close();
  fs.rmSync(where.dataDir, { recursive: true, force: true });   // the index is lost

  const library = await open(t, where);
  assert.deepEqual((await library.rescan()).added, [gid], 'under the id its files carry');
  const meta = await library.metaGet(gid);
  assert.equal(meta.title.english, 'Kept');
  assert.deepEqual((await library.pageList(gid)).map(p => p.url), [`local://${gid}/1.png`, `local://${gid}/2.png`], 'with its page keys');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [...pngBytes(2)]);
  await whole(library);
});

test('leftovers of an interrupted write are cleared', async (t) => {
  const library = await open(t, folders());
  const gid = '1790000000104';
  const archive = await packed(library, gid, 'Tidy');
  fs.writeFileSync(`${archive}.shiori-tmp`, 'half an archive');
  const stray = path.join(library.stagingDir, gid, '9-stray.png');
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.writeFileSync(stray, pngBytes(9));
  const fresh = path.join(library.stagingDir, gid, '8-writing.png');
  fs.writeFileSync(fresh, pngBytes(8));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(stray, old, old);
  await library.rescan();
  assert.equal(fs.existsSync(`${archive}.shiori-tmp`), false);
  assert.equal(fs.existsSync(stray), false, 'a staged page nothing refers to');
  assert.equal(fs.existsSync(fresh), true, 'one just written may still be on its way');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1)), [...pngBytes(1)]);
});

// archive.test.mjs — a gallery left alone (neither changed nor opened in a reader for archiveAfter)
// is archived — or by hand, a series member by member — its folder's files written once into one ZIP
// or CBZ beside it, stored uncompressed — exactly its export — which takes the folder's place; the
// folder is deleted outright, a file browser showing it moved out first. Its pages
// and pictures of its own are read straight from the archive. What changes is added to the archive
// without writing again what it holds — descriptions at once, pictures from staging when it settles —
// unless that would leave more than a quarter of it unused: then it is unpacked when pictures wait
// to move in, else rewritten fresh. A gallery in use, with work under way, or whose folder holds a
// file put there by hand stays a folder. An archiving or an addition the app didn't finish leaves nothing behind, and
// a full check rebuilds an archived gallery with everything it holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { readDirectory, readEntry } = await import('../server/zip.js');
const { checkInvariants } = await import('../../app/js/library-check.js');
const { exportFiles } = await import('../../app/js/gallery-files.js');

const pngBytes = (...b) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...b]);
const png = (...b) => new Blob([pngBytes(...b)], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytesOf = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);
const DAY = 24 * 60 * 60_000;

function folders() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-archive-'));
  return { dir, dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), placeDelay: 60_000, describeDelay: 600_000, archiveAfter: 30 * DAY };
}
// With a list of what was deleted, and of the folders a file browser was moved out of.
async function open(t, opts = {}, where = folders()) {
  const removed = [], vacated = [];
  const library = await new Library({ ...where, remove: async (p) => { removed.push(p); fs.rmSync(p, { recursive: true, force: true }); },
    vacate: async (from) => { vacated.push(from); }, ...opts }).open();
  Object.assign(library, { removed, vacated });
  t.after(() => { library.close(); fs.rmSync(where.dir, { recursive: true, force: true }); });
  return library;
}
const rowOf = (library, gid) => library._s('SELECT * FROM files WHERE gid = ?').get(gid);
const absOf = (library, gid) => path.join(library.libraryDir, ...rowOf(library, gid).path.split('/'));
// A gallery stored and settled, with a translation of page 1 and study layers on page 2.
async function gallery(library, gid, name, { translated = true } = {}) {
  await library.metaPut({ galleryId: gid, title: title(name), tags: [{ type: 'tag', name: 'kept' }], numPages: 2 });
  for (const n of [1, 2]) await library.pagePut(gid, n, png(n));
  if (translated) {
    await library.putTranslatedPage({ galleryId: gid, pageNum: 1 }, png(9), { job: 'j1', lines: [], read: [], regions: [], masks: { raw: png(4) } }, 'j1');
    await library.putPageStudy({ galleryId: gid, pageNum: 2 }, { bg: png(7), page: { w: 10, h: 10 },
      bubbles: [{ box: [0, 0, 1, 1], region: [0, 0, 1, 1], tr: 'Hi', src: 'やあ', text: png(8) }] });
  }
  await library.files.flush();
  return absOf(library, gid);
}
// As if it hadn't been used for `days`.
const leftAlone = (library, gid, days = 31) => library._s('UPDATE files SET used_at = ? WHERE gid = ?').run(Date.now() - days * DAY, gid);
async function exportNames(library, gid, comicInfo = false) {
  const { files } = await exportFiles(gid, { read: (id) => library.transferRead(id), metaGet: (id) => library.metaGet(id), comicInfo });
  return files.map(f => f.name).sort();
}
async function whole(library) {
  const errors = checkInvariants(await library.integritySnapshot()).violations.filter(v => v.severity === 'error');
  assert.deepEqual(errors.map(v => `${v.id} ${v.detail}`), []);
}

test('a gallery left alone is archived into one uncompressed ZIP — its export — and read straight from it', async (t) => {
  const library = await open(t);
  const gid = '1790700000001', other = '1790700000002';
  const folder = await gallery(library, gid, 'Quiet Book');
  await gallery(library, other, 'Busy Book', { translated: false });
  leftAlone(library, gid);
  const exported = await exportNames(library, gid);
  await library.files.sweep();

  const row = rowOf(library, gid);
  assert.deepEqual([row.path, row.format], ['Quiet Book.zip', 'zip'], 'beside where its folder was');
  assert.deepEqual(library.removed, [folder], 'its folder deleted');
  assert.ok(library.vacated.includes(folder), 'a file browser showing it moved out first');
  assert.equal(fs.existsSync(folder), false);
  assert.equal(rowOf(library, other).format, 'folder', 'one used lately stays a folder');
  const file = absOf(library, gid);
  const dir = await readDirectory(file);
  assert.deepEqual([...dir.keys()].sort(), exported, 'the archive is its export');
  assert.ok([...dir.values()].every(e => e.method === 0), 'stored, not compressed');

  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [...pngBytes(2)], 'a page, from the archive');
  const one = await library.pageGet(gid, 1);
  assert.deepEqual(await bytesOf(one.translated), [...pngBytes(9)], 'its translation');
  assert.deepEqual(await bytesOf(one.pipeline.masks.raw), [...pngBytes(4)], 'its mask');
  const two = await library.pageGet(gid, 2);
  assert.deepEqual(await bytesOf(two.bubbles[0].text), [...pngBytes(8)], 'its study layers');
  assert.deepEqual((await exportNames(library, gid)), exported, 'exported from the archive alike');
  await whole(library);
});

test('a CBZ holds the same plus ComicInfo.xml', async (t) => {
  const library = await open(t, { archiveFormat: 'cbz' });
  const gid = '1790700000011';
  await gallery(library, gid, 'Comic Book');
  leftAlone(library, gid);
  await library.files.sweep();
  assert.equal(rowOf(library, gid).path, 'Comic Book.cbz');
  const dir = await readDirectory(absOf(library, gid));
  assert.deepEqual([...dir.keys()].sort(), await exportNames(library, gid, true));
  assert.match(String(await readEntry(absOf(library, gid), dir.get('ComicInfo.xml'))), /<Title>Comic Book<\/Title>/);
});

test('a change to its descriptions is added to the archive, nothing it holds written again', async (t) => {
  const library = await open(t, { archiveFormat: 'cbz' });
  const gid = '1790700000021';
  await gallery(library, gid, 'Tagged');
  leftAlone(library, gid);
  await library.files.sweep();
  const file = absOf(library, gid);
  const before = fs.readFileSync(file);
  const pages = new Map([...await readDirectory(file)].filter(([n]) => n.startsWith('images/')).map(([n, e]) => [n, e.headerOffset]));

  await library.mutateGallery(gid, { tags: [{ type: 'tag', name: 'kept' }, { type: 'tag', name: 'added' }] });
  await library.files.settle(gid);
  const after = fs.readFileSync(file);
  assert.equal(rowOf(library, gid).format, 'cbz', 'still archived');
  assert.ok(after.length > before.length && after.subarray(0, before.length).equals(before), 'only added to');
  const dir = await readDirectory(file);
  const meta = JSON.parse(String(await readEntry(file, dir.get('metadata.json'))));
  assert.deepEqual(meta.tags.map(tag => tag.name), ['kept', 'added']);
  assert.match(String(await readEntry(file, dir.get('ComicInfo.xml'))), /added/, 'its ComicInfo.xml too');
  for (const [name, at] of pages) assert.equal(dir.get(name).headerOffset, at, `${name} where it was`);
  assert.equal(rowOf(library, gid).pending, 0);

  await library.mutateGallery(gid, { tags: [{ type: 'tag', name: 'kept' }, { type: 'tag', name: 'added' }] });
  await library.files.settle(gid);
  assert.equal(fs.statSync(file).size, after.length, 'nothing added when nothing changed');
});

// Pictures the size of real ones (64 KB here), so the share of an archive a change leaves unused is
// what it would be: each made once, to compare with what is read back.
const big = (seed, kb = 64) => new Blob([pngBytes(seed % 250), crypto.randomBytes(kb * 1024)], { type: 'image/png' });
async function archivedGallery(library, gid, name, { pages = 10, translated = false } = {}) {
  await library.metaPut({ galleryId: gid, title: title(name), tags: [], numPages: pages });
  for (let n = 1; n <= pages; n++) await library.pagePut(gid, n, big(n));
  if (translated) for (let n = 1; n <= pages; n++) await library.putTranslatedPage({ galleryId: gid, pageNum: n }, big(100 + n), null);
  await library.files.flush();
  assert.deepEqual((await library.archiveGallery(gid)).archived, [gid]);
  return absOf(library, gid);
}
function treeOf(dir) {
  const out = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r); } };
  walk(dir, '');
  return out.sort();
}

test('a page and a translation added are added to the archive — nothing it held written again — read from staging until then', async (t) => {
  const library = await open(t);
  const gid = '1790700000031';
  const file = await archivedGallery(library, gid, 'Growing');
  const before = fs.readFileSync(file);
  const pages = new Map([...await readDirectory(file)].filter(([n]) => n.startsWith('images/')).map(([n, e]) => [n, e.headerOffset]));
  const page = big(11), translation = big(201);
  await library.pagePut(gid, 11, page);
  await library.putTranslatedPage({ galleryId: gid, pageNum: 1 }, translation, null);
  assert.equal(fs.statSync(file).size, before.length, 'nothing added yet: they wait in staging');
  assert.deepEqual(await bytesOf((await library.pageGet(gid, 1)).translated), await bytesOf(translation), 'read from staging meanwhile');

  await library.files.settle(gid);
  const after = fs.readFileSync(file);
  assert.equal(rowOf(library, gid).format, 'zip', 'still archived');
  assert.ok(after.length > before.length && after.subarray(0, before.length).equals(before), 'only added to');
  const dir = await readDirectory(file);
  for (const [name, at] of pages) assert.equal(dir.get(name).headerOffset, at, `${name} where it was`);
  assert.deepEqual([...dir.keys()].sort(), await exportNames(library, gid), 'still its export');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 11)), await bytesOf(page), 'the new page, from the archive');
  assert.deepEqual(await bytesOf((await library.pageGet(gid, 1)).translated), await bytesOf(translation), 'the translation, from the archive');
  assert.deepEqual(library._s('SELECT * FROM staged_own').all(), []);
  assert.equal(fs.existsSync(path.join(library.stagingDir, gid)), false, 'nothing left in staging');
  await whole(library);
});

test('a page removed leaves its bytes unused while that stays under a quarter of the archive', async (t) => {
  const library = await open(t);
  const gid = '1790700000032';
  const file = await archivedGallery(library, gid, 'Thinned');
  const keep = (await library.pageList(gid)).map(p => p.url).slice(0, 9);
  await library.deleteStaleGalleryImages(gid, keep);
  await library.files.settle(gid);
  assert.equal(rowOf(library, gid).format, 'zip');
  const dir = await readDirectory(file);
  assert.equal(dir.has('images/0010.png'), false, 'no longer listed');
  assert.deepEqual([...dir.keys()].sort(), await exportNames(library, gid));
  await whole(library);
});

test('replacing most of its pages unpacks it instead: the new pages move in without being written again', async (t) => {
  const library = await open(t);
  const gid = '1790700000033';
  const file = await archivedGallery(library, gid, 'Replaced');
  const fresh = Array.from({ length: 10 }, (_, i) => big(300 + i));
  const written = library.writes.snapshot().by.pages || 0;
  for (let n = 1; n <= 10; n++) await library.pagePut(gid, n, fresh[n - 1]);
  await library.files.settle(gid);
  assert.equal(rowOf(library, gid).format, 'folder');
  assert.ok(library.removed.includes(file), 'the archive deleted');
  assert.equal((library.writes.snapshot().by.pages || 0) - written, fresh.reduce((sum, b) => sum + b.size, 0), 'each new page written once: to staging, then moved in');
  assert.deepEqual(treeOf(absOf(library, gid)), await exportNames(library, gid), 'the folder is its export');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 4)), await bytesOf(fresh[3]));
  await whole(library);
});

test('clearing its translations rewrites it as a fresh archive — nothing waits to move in — smaller, still archived', async (t) => {
  const library = await open(t);
  const gid = '1790700000041';
  const file = await archivedGallery(library, gid, 'Cleared', { translated: true });
  const size = fs.statSync(file).size;
  await library.clearGalleryTranslations(gid);
  await library.files.settle(gid);
  assert.equal(rowOf(library, gid).format, 'zip');
  const dir = await readDirectory(file);
  assert.equal([...dir.keys()].some(n => n.startsWith('translated/')), false);
  assert.deepEqual([...dir.keys()].sort(), await exportNames(library, gid));
  assert.ok(fs.statSync(file).size < size * 0.6, 'what the translations took is given back');
  await whole(library);
});

test('pictures staged for an archive survive a restart, are kept by the full check, and are added then', async (t) => {
  const where = folders();
  const first = await new Library(where).open();
  const gid = '1790700000042';
  const file = await archivedGallery(first, gid, 'Waiting');
  const translation = big(401);
  await first.putTranslatedPage({ galleryId: gid, pageNum: 2 }, translation, null);
  const [staged] = first._s('SELECT file FROM staged_own').all();
  first.close();
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(path.join(first.stagingDir, staged.file), old, old);

  const library = await open(t, {}, where);
  await library.rescan();
  assert.ok(fs.existsSync(path.join(library.stagingDir, staged.file)), 'no orphan: it waits for its archive');
  await library.files.settle(gid);
  assert.equal(rowOf(library, gid).format, 'zip');
  assert.ok((await readDirectory(file)).has('translated/0002.png'));
  assert.deepEqual(await bytesOf((await library.pageGet(gid, 2)).translated), await bytesOf(translation));
  await whole(library);
});

test('a gallery open in a reader, with pages on their way, or holding a file put there by hand stays a folder', async (t) => {
  const library = await open(t);
  const [read, staged, handmade] = ['1790700000051', '1790700000052', '1790700000053'];
  for (const gid of [read, staged, handmade]) { await gallery(library, gid, `Kept ${gid}`, { translated: false }); leftAlone(library, gid); }
  library.openedInReader(read);
  await library.pagePut(staged, 3, png(3));
  fs.writeFileSync(path.join(absOf(library, handmade), 'notes.txt'), 'mine');
  leftAlone(library, read);
  leftAlone(library, staged);
  await library.files.sweep();
  for (const gid of [read, staged, handmade]) assert.equal(rowOf(library, gid).format, 'folder', gid);
  assert.ok(Date.now() - rowOf(library, handmade).used_at < 60_000, 'looked at again after another while');
  assert.ok(fs.existsSync(path.join(absOf(library, handmade), 'notes.txt')));

  library.leftReader(read);
  await library.files.settle(read);   // what leaving it starts, finished
  leftAlone(library, read);
  await library.files.sweep();
  assert.equal(rowOf(library, read).format, 'zip', 'once the reader left it');
});

test('a series member is archived in its series\' folder, and moves as an archive', async (t) => {
  const library = await open(t);
  const [o, a] = ['1790700000061', '1790700000062'];
  for (const [gid, name] of [[o, 'One'], [a, 'Two']]) {
    await library.metaPut({ galleryId: gid, title: title(name), numPages: 1 });
    await library.pagePut(gid, 1, png(1));
  }
  await library.seriesCommand('write', o, [{ id: o, title: 'One', number: 1 }, { id: a, title: 'Two', number: 2 }], { seriesTitle: title('Saga') });
  await library.files.flush();
  leftAlone(library, a);
  await library.files.sweep();
  assert.equal(rowOf(library, a).path, 'Saga/Saga Ch. 002.zip');
  await library.files.settle(o);
  const series = JSON.parse(fs.readFileSync(path.join(library.libraryDir, 'Saga', 'series.json'), 'utf8'));
  assert.deepEqual(series.chapters.map(c => c.folder), ['Saga Ch. 001', 'Saga Ch. 002'], 'named as the folder it would unpack to');

  await library.seriesCommand('remove', o, a);
  await library.files.flush();
  assert.deepEqual([rowOf(library, a).path, rowOf(library, a).format], ['Two.zip', 'zip'], 'moved out as it is');
  assert.deepEqual(await bytesOf(await library.getPageBlob(a, 1)), [...pngBytes(1)]);
});

test('an addition to an archive the app didn\'t finish is cut off, and made again', async (t) => {
  const where = folders();
  const first = await new Library(where).open();
  const gid = '1790700000071';
  await gallery(first, gid, 'Interrupted', { translated: false });
  leftAlone(first, gid);
  await first.files.sweep();
  const file = absOf(first, gid);
  const length = fs.statSync(file).size;
  first._s('UPDATE files SET tail = ?, pending = 1 WHERE gid = ?').run(length, gid);
  fs.appendFileSync(file, Buffer.alloc(70_000, 7));   // half an addition, no directory after it
  first.close();

  const library = await open(t, {}, where);
  assert.equal(fs.statSync(file).size, length, 'cut back to what it was');
  assert.equal(rowOf(library, gid).tail, null);
  await library.files.settle(gid);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1)), [...pngBytes(1)]);
});

test('an archiving the app didn\'t finish leaves nothing behind', async (t) => {
  const where = folders();
  const first = await new Library(where).open();
  const [halfway, done] = ['1790700000081', '1790700000082'];
  const kept = await gallery(first, halfway, 'Halfway', { translated: false });
  const old = await gallery(first, done, 'Done', { translated: false });
  // Stopped after its archive took its name, before the index knew: the archive is left over.
  first._s('INSERT INTO retired (path) VALUES (?)').run('Halfway.zip');
  fs.writeFileSync(path.join(first.libraryDir, 'Halfway.zip'), 'an archive no gallery has');
  // Stopped after the index switched to the archive, before the folder went.
  leftAlone(first, done);
  const remove = first.remove;
  first.remove = async () => { throw new Error('the app stopped'); };
  await first.files.sweep();
  first.remove = remove;
  assert.equal(rowOf(first, done).format, 'zip');
  assert.ok(fs.existsSync(old), 'its folder still there');
  first.close();

  const library = await open(t, {}, where);
  await library.files.sweep();
  assert.equal(fs.existsSync(path.join(library.libraryDir, 'Halfway.zip')), false, 'the archive no gallery has, gone');
  assert.ok(fs.existsSync(kept), 'the gallery still in its folder');
  assert.equal(fs.existsSync(old), false, 'the archived gallery\'s folder, gone');
  assert.deepEqual(library._s('SELECT path FROM retired').all(), []);
  await whole(library);
});

test('a full check rebuilds an archived gallery with everything it holds', async (t) => {
  const where = folders();
  const first = await new Library(where).open();
  const gid = '1790700000091';
  await gallery(first, gid, 'Rebuilt');
  await first.coverPut(gid, png(5, 5));
  await first.files.flush();
  leftAlone(first, gid);
  await first.files.sweep();
  first.close();
  fs.rmSync(where.dataDir, { recursive: true, force: true });   // the index is lost

  const library = await open(t, {}, where);
  assert.deepEqual((await library.rescan()).added, [gid]);
  assert.equal(rowOf(library, gid).format, 'zip');
  const one = await library.pageGet(gid, 1);
  assert.deepEqual(await bytesOf(one.translated), [...pngBytes(9)], 'its translation');
  assert.equal(one.pipeline.job, 'j1');
  const two = await library.pageGet(gid, 2);
  assert.deepEqual([two.bubbles.length, two.bubbles[0].tr], [1, 'Hi'], 'its study layers');
  assert.deepEqual(await bytesOf(await library.coverGet(gid)), [...pngBytes(5, 5)], 'its cover of its own');
  await whole(library);
});

test('archiving by hand packs a gallery now — a series member by member, one open in a reader kept a folder', async (t) => {
  const library = await open(t, { archiveAfter: 0 });
  const [o, a, solo] = ['1790700000101', '1790700000102', '1790700000103'];
  for (const [gid, name] of [[o, 'Hand One'], [a, 'Hand Two']]) await gallery(library, gid, name, { translated: false });
  await library.seriesCommand('write', o, [{ id: o, title: 'One', number: 1 }, { id: a, title: 'Two', number: 2 }], { seriesTitle: title('By Hand') });
  await gallery(library, solo, 'Solo', { translated: false });
  await library.files.flush();
  assert.equal((await library.getGallery(solo)).archived, undefined);

  assert.deepEqual(await library.archiveGallery(solo), { archived: [solo], kept: [] }, 'at once, never mind how recently used');
  assert.equal((await library.getGallery(solo)).archived, true, 'the gallery says so');
  library.openedInReader(a);
  assert.deepEqual(await library.archiveGallery(o), { archived: [o], kept: [a] }, 'the series member by member');
  assert.equal(rowOf(library, o).path, 'By Hand/By Hand Ch. 001.zip');
  assert.equal(rowOf(library, a).format, 'folder', 'the one open in a reader');
  library.leftReader(a);
  await library.files.settle(a);
  assert.deepEqual(await library.archiveGallery(o), { archived: [a], kept: [] }, 'what is archived already is left as it is');
  await whole(library);
});

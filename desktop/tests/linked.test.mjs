// linked.test.mjs — a library folder holding what Shiori didn't make (a downloaded pack: archives,
// folders of pictures, PDFs) used as it is: each folder of pictures a gallery, each archive a gallery
// (a series when its pictures sit in folders), each PDF a gallery once a window draws its pages —
// read where they are, never written, moved, archived or deleted; what Shiori adds kept in each one's
// overlay (.shiori/linked/<gid>/). Removed from the library, a gallery leaves its files and isn't added
// again; renamed outside the app, it joins as a new gallery and the one that was there shows as
// missing (plan D5); moved to another folder, it becomes a gallery of its own there.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { writeZip } = await import('../server/zip.js');
const { checkInvariants } = await import('../../app/js/library-check.js');

const pngBytes = (...b) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...b]);
const bytesOf = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);
const hashOf = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function whole(library) {
  const errors = checkInvariants(await library.integritySnapshot()).violations.filter(v => v.severity === 'error');
  assert.deepEqual(errors.map(v => `${v.id} ${v.detail}`), []);
}

test('a folder of what Shiori didn\'t make is used as it is: galleries read in place, Shiori\'s additions in their overlays', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-linked-'));
  const pack = path.join(dir, 'pack');
  const mk = (rel, data) => { fs.mkdirSync(path.dirname(path.join(pack, rel)), { recursive: true }); fs.writeFileSync(path.join(pack, rel), data); };
  fs.mkdirSync(path.join(pack, 'Pack'), { recursive: true });
  const zipFile = path.join(pack, 'Pack', '[Circle (Artist A)] Title One (Mag 2020).zip');
  await writeZip(zipFile, [{ name: '01.png', data: pngBytes(1) }, { name: '02.png', data: pngBytes(2) }]);
  await writeZip(path.join(pack, 'Pack', 'Series Zip.zip'), [{ name: 'Ch 1/1.png', data: pngBytes(11) }, { name: 'Ch 1/2.png', data: pngBytes(12) }, { name: 'Ch 2/1.png', data: pngBytes(21) }]);
  mk('Loose Title/2.png', pngBytes(32)); mk('Loose Title/1.png', pngBytes(31));
  mk('Pack/Nested/Inner Title/1.png', pngBytes(41));
  mk('Pack/readme.txt', 'hello');
  mk('Book.pdf', '%PDF-1.4 a book');
  const before = Object.fromEntries(['Pack/[Circle (Artist A)] Title One (Mag 2020).zip', 'Pack/Series Zip.zip', 'Loose Title/1.png', 'Book.pdf']
    .map(rel => [rel, hashOf(path.join(pack, rel))]));
  const library = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'first'), placeDelay: 0, describeDelay: 600_000 }).open();
  t.after(() => { library.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { id } = await library.folderAdd(pack);
  assert.equal((await library.folderScan(id)).added, 5, 'two folders of pictures, an archive, an archive\'s two chapters (the PDF waits)');
  const all = await library.getGalleriesByIds(library._s('SELECT gid FROM stats').all().map(r => r.gid));
  const by = Object.fromEntries(all.map(e => [e.title.english, e]));
  const one = by['[Circle (Artist A)] Title One (Mag 2020)'];
  assert.deepEqual([one.count, one.linked.kind, one.title.pretty], [2, 'zip', 'Title One']);
  assert.deepEqual(one.tags.map(t => `${t.type}:${t.name}`), ['group:circle', 'artist:artist a', 'tag:pack']);
  assert.deepEqual(await bytesOf(await library.getPageBlob(one.id, 2)), [...pngBytes(2)], 'its pages read from the archive');
  assert.deepEqual([by['Loose Title'].count, by['Loose Title'].linked.kind], [2, 'dir']);
  assert.deepEqual(await bytesOf(await library.getPageBlob(by['Loose Title'].id, 1)), [...pngBytes(31)], 'in reading order');
  assert.equal(by['Inner Title'].count, 1);
  // The archive of folders: a series named after it, its folders the chapters.
  const series = await library.seriesResolve(by['Ch 1'].id);
  assert.deepEqual(series.chapters.map(c => c.title), ['Ch 1', 'Ch 2']);
  assert.deepEqual(await bytesOf(await library.getPageBlob(by['Ch 2'].id, 1)), [...pngBytes(21)]);
  // What Shiori adds goes to the overlay; the archive stays as it was.
  await library.putTranslatedImage({ galleryId: one.id, pageNum: 1 }, new Blob([pngBytes(99)], { type: 'image/png' }));
  await library.files.settle(one.id);
  await library.files.describe(one.id, { all: true });
  const overlay = path.join(pack, '.shiori', 'linked', one.id);
  assert.ok(fs.readdirSync(path.join(overlay, 'translated')).length === 1, 'its translation in its overlay');
  assert.equal(JSON.parse(fs.readFileSync(path.join(overlay, 'metadata.json'), 'utf8')).galleryId, one.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(overlay, 'image_records.json'), 'utf8')).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(overlay, 'source.json'), 'utf8')).source.path, 'Pack/[Circle (Artist A)] Title One (Mag 2020).zip');
  assert.deepEqual((await library.archiveGallery(by['Loose Title'].id)).archived, [], 'never archived');
  // A PDF waits for a window to draw its pages, then joins the library with them.
  const pdfs = await library.pdfsWaiting();
  assert.deepEqual(pdfs.map(p => p.name), ['Book.pdf']);
  const source = await library.pdfSource(id, pdfs[0].gid);
  assert.equal(source.file.size, fs.statSync(path.join(pack, 'Book.pdf')).size);
  const book = await library.addRendered(id, pdfs[0].gid, [new Blob([pngBytes(51)], { type: 'image/webp' }), new Blob([pngBytes(52)], { type: 'image/webp' })], source.token);
  const bookEntity = await library.getGallery(book);
  assert.deepEqual([bookEntity.title.english, bookEntity.count, bookEntity.linked.kind], ['Book', 2, 'pdf']);
  assert.deepEqual(await bytesOf(await library.getPageBlob(book, 2)), [...pngBytes(52)]);
  assert.deepEqual(await library.pdfsWaiting(), []);
  // Removed from the library: its overlay goes, its files stay, and a check doesn't add it again.
  await library.deleteGallery(one.id);
  await library.folders.publishRemoved(id);   // after the one its deletion set going: noted in removed.json, then its overlay deleted
  assert.ok(fs.existsSync(zipFile), 'its archive stays');
  assert.ok(!fs.existsSync(overlay), 'its overlay goes');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pack, '.shiori', 'linked', 'removed.json'), 'utf8')).removed.map(r => r.path), ['Pack/[Circle (Artist A)] Title One (Mag 2020).zip']);
  assert.equal((await library.folderScan(id)).added, 0);
  // Renamed outside the app (D5): another source — it joins as a new gallery, and the one that was
  // there shows as missing, its overlay (what the library added to it) kept until it is deleted.
  const loose = by['Loose Title'].id;
  await library.files.describe(loose, { all: true });
  const looseOverlay = path.join(pack, '.shiori', 'linked', loose);
  fs.renameSync(path.join(pack, 'Loose Title'), path.join(pack, 'Loose Renamed'));
  assert.deepEqual(await library.folderScan(id), { added: 1, updated: 0, problems: [], stopped: false });
  const old = await library.getGallery(loose);
  assert.deepEqual([old.linked.path, old.missing], ['Loose Title', true], 'the gallery that was there is missing');
  assert.ok(fs.existsSync(path.join(looseOverlay, 'source.json')), 'its overlay kept');
  const renamed = (await library.getGalleriesByIds(library._s('SELECT gid FROM stats').all().map(r => r.gid))).find(e => e.linked?.path === 'Loose Renamed');
  assert.deepEqual([renamed.count, renamed.id === loose, renamed.missing], [2, false, undefined]);
  assert.deepEqual(await bytesOf(await library.getPageBlob(renamed.id, 2)), [...pngBytes(32)]);
  // Deleted, the missing gallery takes its overlay along; the renamed files stay, the new gallery's.
  await library.deleteGallery(loose);
  await library.folders.publishRemoved(id);   // as above
  assert.ok(!fs.existsSync(looseOverlay), 'its overlay goes with it');
  assert.equal((await library.getGallery(renamed.id)).count, 2);
  // Moved to another library folder: a gallery of its own there; its files stay where they were.
  const inner = by['Inner Title'].id;
  await library.moveGallery(inner, library.primaryId);
  const moved = await library.getGallery(inner);
  assert.deepEqual([moved.folder, moved.linked], [library.primaryId, null]);
  assert.deepEqual(await bytesOf(await library.getPageBlob(inner, 1)), [...pngBytes(41)]);
  assert.ok(fs.existsSync(path.join(pack, 'Pack', 'Nested', 'Inner Title', '1.png')), 'its files stay');
  assert.ok(!fs.existsSync(path.join(pack, '.shiori', 'linked', inner)), 'its overlay goes');
  // Nothing Shiori didn't make was changed.
  for (const [rel, hash] of Object.entries(before)) {
    const now = rel.startsWith('Loose Title/') ? path.join(pack, rel.replace('Loose Title', 'Loose Renamed')) : path.join(pack, rel);
    assert.equal(hashOf(now), hash, `${rel} unchanged`);
  }
  await whole(library);
});

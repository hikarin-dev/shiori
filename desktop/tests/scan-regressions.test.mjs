// scan-regressions.test.mjs — the findings of the 2026-10-30 audit in checking a library folder
// (plans/library-storage-spec.md, "Audit results"): what a folder holds (classification), linked
// galleries' identity, reading a folder back, PDFs, sweeps and the problems a check reports — each
// reproduced as the audit did and held: a test per finding, named after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { writeZip, readDirectory, readEntry } = await import('../server/zip.js');
const { checkInvariants } = await import('../../app/js/library-check.js');

const pngBytes = (...b) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...b]);
const png = (...b) => new Blob([pngBytes(...b)], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytesOf = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const HOURS_AGO = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

// A library in a temporary folder, two more folders beside it to add.
async function open(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-scan-findings-'));
  const library = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'first'), placeDelay: 0, describeDelay: 600_000, ...opts }).open();
  const other = path.join(dir, 'second'), third = path.join(dir, 'third');
  fs.mkdirSync(other);
  fs.mkdirSync(third);
  t.after(() => { try { library.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, library, other, third };
}
const mk = (root, rel, data) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
const aged = (file, hours = 2) => { fs.utimesSync(file, HOURS_AGO(hours), HOURS_AGO(hours)); return file; };
const linkedRows = (library) => library._s('SELECT gid, path, state, source FROM files WHERE source IS NOT NULL ORDER BY gid').all()
  .map(r => ({ gid: r.gid, state: r.state, src: JSON.parse(r.source) }));
const rowOf = (library, gid) => library._s('SELECT * FROM files WHERE gid = ?').get(gid);
const placeOf = (library, gid) => library._s('SELECT root FROM places WHERE gid = ?').get(gid)?.root ?? null;
const overlayOf = (root, gid) => path.join(root, '.shiori', 'linked', gid);
// Gallery `gid`'s descriptions written now. A gallery that just joined or was read again has them
// waiting (its cover was set), and a check reads it again only once they are written: until then, its
// own changes win.
const described = (library, gid) => library.files.describe(gid, { all: true });
// Folder `dir` taken out of the library (its removal run to its end) and added back.
async function removeAndAddBack(library, id, dir) {
  await library.folderRemove(id);
  await library.folders.job(id)?.catch(() => {});
  return (await library.folderAdd(dir)).id;
}
async function whole(library) {
  const errors = checkInvariants(await library.integritySnapshot()).violations.filter(v => v.severity === 'error');
  assert.deepEqual(errors.map(v => `${v.id} ${v.detail}`), []);
}
// A description Shiori writes (folder-content.js galleryIdOf), as text.
const metaText = (gid, name, extra = {}) => JSON.stringify({ galleryId: gid, title: title(name), tags: [], ...extra });
// An archive whose entry names are UTF-8 (or any bytes) without the UTF-8 flag, as macOS and many
// tools write them: [{ name: Buffer, data }].
function rawZip(file, entries) {
  const locals = [], central = [];
  let off = 0;
  for (const { name, data } of entries) {
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, data);
    central.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, cd, end]));
}

test('R01: a folder with images/ alone, or another tool\'s metadata.json, is linked: never written, tidied or deleted', async (t) => {
  const { library, other } = await open(t);
  mk(other, 'Ordinary/images/1.png', pngBytes(1));
  mk(other, 'Ordinary/notes.txt', 'my private notes');
  aged(mk(other, 'Ordinary/covers/front.png', pngBytes(7)));          // the person's own picture in a folder named covers/
  aged(mk(other, 'Ordinary/translated/0001.png', pngBytes(8)));       // and one whose name looks like Shiori's
  const foreign = JSON.stringify({ title: 'Some tool wrote this', url: 'x' });
  mk(other, 'Downloaded/metadata.json', foreign);
  mk(other, 'Downloaded/01.png', pngBytes(11));
  mk(other, 'Downloaded/02.png', pngBytes(12));
  await writeZip(path.join(other, 'Theirs.zip'), [{ name: 'metadata.json', data: Buffer.from(foreign) }, { name: 'images/001.png', data: pngBytes(3) }]);
  const tree = () => fs.readdirSync(other, { recursive: true }).map(String).filter(p => !p.startsWith('.shiori')).sort();
  const before = tree();
  const { id } = await library.folderAdd(other);
  await library.folderScan(id);
  const rows = library._s('SELECT gid, path, source FROM files').all();
  assert.ok(rows.length >= 3 && rows.every(r => r.source), 'every one of them linked');
  const downloaded = linkedRows(library).find(r => r.src.path === 'Downloaded');
  assert.equal((await library.getGallery(downloaded.gid)).count, 2, 'its pictures, beside the foreign metadata.json');
  assert.notEqual((await library.metaGet(downloaded.gid)).url, 'x', 'the foreign metadata.json is no description of it');
  await library.files.describe(downloaded.gid, { all: true });
  assert.equal(fs.readFileSync(path.join(other, 'Downloaded', 'metadata.json'), 'utf8'), foreign, 'never written');
  for (const r of rows) await library.deleteGallery(r.gid);
  await sleep(200);
  assert.deepEqual(tree(), before, 'nothing of theirs deleted: not by the check\'s sweep, not by deleting the galleries');
});

test('R11: a PDF joins only once every page is drawn (its marker written last): a draw cut short or under way is never adopted', async (t) => {
  const { library, other } = await open(t);
  fs.writeFileSync(path.join(other, 'Book.pdf'), '%PDF-1.4 three pages');
  const { id } = await library.folderAdd(other);
  await library.folderScan(id);
  const [w] = await library.pdfsWaiting();
  const pages = (gid) => library._s('SELECT COUNT(*) AS n FROM pages WHERE gid = ?').get(gid).n;
  // Cut short at page 2.
  const bad = { type: 'image/webp', arrayBuffer: async () => { throw new Error('injected'); } };
  await assert.rejects(library.addRendered(id, w.gid, [new Blob([pngBytes(1)], { type: 'image/webp' }), bad, new Blob([pngBytes(3)], { type: 'image/webp' })]));
  assert.equal((await library.folderScan(id)).added, 0, 'a check doesn\'t take the pages drawn so far');
  assert.equal(pages(w.gid), 0);
  assert.deepEqual((await library.pdfsWaiting()).map(p => p.gid), [w.gid], 'still waiting');
  // Under way while a check runs.
  let release;
  const gate = new Promise(r => { release = r; });
  const slow = { type: 'image/webp', arrayBuffer: async () => { await gate; return pngBytes(2).buffer; } };
  const drawing = library.addRendered(id, w.gid, [new Blob([pngBytes(1)], { type: 'image/webp' }), slow, new Blob([pngBytes(3)], { type: 'image/webp' })]);
  await sleep(50);
  assert.equal((await library.folderScan(id)).added, 0, 'nor the pages of a draw under way');
  release();
  assert.equal(await drawing, w.gid);
  assert.equal(pages(w.gid), 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(overlayOf(other, w.gid), 'source.json'), 'utf8')).source.rendered, 3);
  assert.deepEqual(await bytesOf(await library.getPageBlob(w.gid, 3)), [...pngBytes(3)]);
});

test('R12: a source.json path that leads out of its folder is never listed, read or adopted', async (t) => {
  const { dir, library, other } = await open(t);
  fs.writeFileSync(path.join(dir, 'outside.pdf'), 'BYTES OUTSIDE THE FOLDER');
  const { id } = await library.folderAdd(other);
  const forms = ['../outside.pdf', 'x\\..\\..\\outside.pdf', 'x/../../outside.pdf', 'C:/outside.pdf', '//host/share/outside.pdf'];
  const gids = forms.map((p, i) => {
    const gid = String(1700000000001 + i);
    mk(other, `.shiori/linked/${gid}/source.json`, JSON.stringify({ format: 'shiori-linked', version: 1, galleryId: gid, source: { kind: 'pdf', path: p } }));
    return gid;
  });
  assert.deepEqual(await library.pdfsWaiting(), []);
  for (const gid of gids) {
    await assert.rejects(library.pdfSource(id, gid));
    await assert.rejects(library.addRendered(id, gid, [png(1)]));
  }
  await library.folderScan(id);
  assert.deepEqual(linkedRows(library), [], 'nothing adopted');
});

test('R13: a page replaced in a linked gallery\'s overlay stays replaced: through remove and add back, a rename of its source, a catch-up', async (t) => {
  const { library, other } = await open(t);
  mk(other, 'Loose/1.png', pngBytes(0x31));
  mk(other, 'Loose/2.png', pngBytes(0x32));
  let id = (await library.folderAdd(other)).id;
  await library.folderScan(id);
  const gid = linkedRows(library)[0].gid;
  await library.pagePut(gid, 1, png(0x52));                                         // page 1 replaced
  await library.pagePut(gid, 3, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x33])], { type: 'image/jpeg' }));   // a page past the source
  await library.files.settle(gid);
  await library.files.describe(gid, { all: true });
  const pagesNow = async () => [await bytesOf(await library.getPageBlob(gid, 1)), await bytesOf(await library.getPageBlob(gid, 2)), await bytesOf(await library.getPageBlob(gid, 3))];
  const want = await pagesNow();
  assert.deepEqual(want[0], [...pngBytes(0x52)]);
  // (a) Removed with its folder, added back.
  id = await removeAndAddBack(library, id, other);
  await library.folderScan(id);
  assert.deepEqual(await pagesNow(), want, 'remove and add back');
  // (b) Its source renamed.
  fs.renameSync(path.join(other, 'Loose'), path.join(other, 'Loose Renamed'));
  assert.equal((await library.folderScan(id)).updated, 1);
  assert.deepEqual(await pagesNow(), want, 'a rename');
  // (c) Another app changes its overlay's descriptions: read again.
  await described(library, gid);
  const metaFile = path.join(overlayOf(other, gid), 'metadata.json');
  fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaFile, 'utf8')), title: title('Changed elsewhere') }));
  assert.equal((await library.folderScan(id)).updated, 1);
  assert.equal((await library.metaGet(gid)).title.english, 'Changed elsewhere');
  assert.deepEqual(await pagesNow(), want, 'a catch-up');
  await whole(library);
});

test('R14: a native archive is one gallery of its own (pages, sparse numbers, keys, cover, translation), and a series export joins as its series', async (t) => {
  const { library, other } = await open(t);
  const gid = '1790000000501';
  await writeZip(path.join(other, 'Native.zip'), [
    { name: 'metadata.json', data: Buffer.from(metaText(gid, 'Native')) },
    { name: 'image_records.json', data: Buffer.from(JSON.stringify([{ url: 'https://example.invalid/g/1.png' }, { url: 'https://example.invalid/g/3.png' }])) },
    { name: 'images/0001.png', data: pngBytes(1) }, { name: 'images/0003.png', data: pngBytes(3) },
    { name: 'translated/0001.png', data: pngBytes(91) },
    { name: 'covers/gallery.png', data: pngBytes(70) },
    { name: 'covers/manifest.json', data: Buffer.from(JSON.stringify({ version: 1, covers: [{ role: 'gallery', file: 'covers/gallery.png' }] })) }]);
  const [a, b] = ['1790000000511', '1790000000512'];
  await writeZip(path.join(other, 'Saga.zip'), [
    { name: 'series.json', data: Buffer.from(JSON.stringify({ format: 'shiori-series', chapters: [{ id: a, folder: 'A' }, { id: b, folder: 'B' }] })) },
    { name: 'A/metadata.json', data: Buffer.from(metaText(a, 'Saga 1', { chapters: [{ id: a, title: 'Saga 1' }, { id: b, title: 'Saga 2' }] })) },
    { name: 'A/images/0001.png', data: pngBytes(11) }, { name: 'A/translated/0001.png', data: pngBytes(19) },
    { name: 'B/metadata.json', data: Buffer.from(metaText(b, 'Saga 2', { parentId: a })) },
    { name: 'B/images/0001.png', data: pngBytes(21) }]);
  const { id } = await library.folderAdd(other);
  const scan = await library.folderScan(id);
  assert.deepEqual(linkedRows(library), [], 'none of them linked');
  assert.deepEqual([rowOf(library, gid).format, rowOf(library, gid).path.endsWith('Native.zip')], ['zip', true], 'kept as it is, its own');
  assert.deepEqual((await library.pageList(gid)).map(p => p.url), ['https://example.invalid/g/1.png', 'https://example.invalid/g/3.png'], 'its keys');
  assert.deepEqual(library._pageRows(gid).map(r => r.n), [1, 3], 'its page numbers');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1, 'translated')), [...pngBytes(91)]);
  assert.ok(library._coverGet(gid)?.cover, 'its cover');
  // The series export: its chapters, the library's own, in a folder of its own; the archive goes.
  assert.ok(!fs.existsSync(path.join(other, 'Saga.zip')));
  assert.deepEqual([rowOf(library, a).format, rowOf(library, b).format], ['folder', 'folder']);
  assert.deepEqual((await library.seriesResolve(b)).chapters.map(c => String(c.id)), [a, b]);
  assert.deepEqual(await bytesOf(await library.getPageBlob(a, 1, 'translated')), [...pngBytes(19)]);
  assert.deepEqual(await bytesOf(await library.getPageBlob(b, 1)), [...pngBytes(21)]);
  assert.deepEqual(scan.problems, []);
  assert.deepEqual((await library.folderScan(id)).added, 0, 'found once');
  await whole(library);
});

test('R15: a series spanning two folders keeps its links while one half is away, through a catch-up, and is whole once both are back', async (t) => {
  const { library, other, third } = await open(t);
  const [owner, chapter] = ['1790000000601', '1790000000602'];
  mk(other, 'Owner/metadata.json', metaText(owner, 'Owner', { chapters: [{ id: owner, title: 'One' }, { id: chapter, title: 'Two' }] }));
  mk(other, 'Owner/images/0001.png', pngBytes(1));
  mk(third, 'Chapter/metadata.json', metaText(chapter, 'Chapter', { parentId: owner }));
  mk(third, 'Chapter/images/0001.png', pngBytes(2));
  const first = (await library.folderAdd(other)).id;
  await library.folderScan(first);
  await described(library, owner);
  // Another app edits the owner meanwhile: it is read again, its chapter still away.
  const file = path.join(other, 'Owner', 'metadata.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), title: title('Owner (edited)') }));
  assert.equal((await library.folderScan(first)).updated, 1);
  assert.deepEqual((await library.metaGet(owner)).chapters.map(c => String(c.id)), [owner, chapter], 'the link to the chapter away is kept');
  const second = (await library.folderAdd(third)).id;
  await library.folderScan(second);
  assert.deepEqual((await library.seriesResolve(chapter)).chapters.map(c => String(c.id)), [owner, chapter]);
});

test('R16: both cover roles survive a catch-up and remove and add back', async (t) => {
  const { library, other } = await open(t);
  let id = (await library.folderAdd(other)).id;
  await library.folderSetDefault(id);
  const gid = library.nextGalleryId();
  await library.metaPut({ galleryId: gid, title: title('Covered') });
  for (const n of [1, 2]) await library.pagePut(gid, n, png(n));
  await library.files.place(gid);
  await library.coverPut(gid, png(70), { role: 'gallery' });
  await library.coverPut(gid, png(80), 'series');
  await library.files.settle(gid);
  await library.files.describe(gid, { all: true });
  const roles = () => { const c = library._coverGet(gid); return [!!c?.cover, !!c?.seriesCover]; };
  assert.deepEqual(roles(), [true, true]);
  const dir = library.files.folderOf(gid);
  const metaFile = path.join(dir, 'metadata.json');
  fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaFile, 'utf8')), title: title('Covered (edited)') }));
  assert.equal((await library.folderScan(id)).updated, 1);
  assert.deepEqual(roles(), [true, true], 'a catch-up');
  await library.files.describe(gid, { all: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'covers', 'manifest.json'), 'utf8')).covers.map(c => c.role).sort(), ['gallery', 'series']);
  await library.folderSetDefault(library.primaryId);
  id = await removeAndAddBack(library, id, other);
  await library.folderScan(id);
  assert.deepEqual(roles(), [true, true], 'remove and add back');
});

test('R18: a multi-chapter archive renamed keeps its galleries — while kept, and while its folder was out of the library', async (t) => {
  const { library, other } = await open(t);
  await writeZip(path.join(other, 'Before.zip'), [{ name: 'Ch 1/1.png', data: pngBytes(11) }, { name: 'Ch 2/1.png', data: pngBytes(21) }]);
  let id = (await library.folderAdd(other)).id;
  await library.folderScan(id);
  const before = linkedRows(library);
  const ch1 = before.find(r => r.src.inner === 'Ch 1/').gid;
  await library.putTranslatedImage({ galleryId: ch1, pageNum: 1 }, png(99));
  await library.files.settle(ch1);
  await library.files.describe(ch1, { all: true });
  fs.renameSync(path.join(other, 'Before.zip'), path.join(other, 'After.zip'));
  assert.deepEqual(await library.folderScan(id), { added: 0, updated: 2, problems: [], stopped: false });
  assert.deepEqual(linkedRows(library).map(r => [r.gid, r.state, r.src.path, r.src.inner]), before.map(r => [r.gid, 'packed', 'After.zip', r.src.inner]));
  assert.deepEqual((await library.seriesResolve(ch1)).chapters.map(c => String(c.id)).sort(), before.map(r => r.gid).sort(), 'its series');
  // Removed, renamed again while away, added back: the same galleries, from their overlays.
  for (const r of before) await library.files.describe(r.gid, { all: true });
  id = await removeAndAddBack(library, id, other);
  fs.renameSync(path.join(other, 'After.zip'), path.join(other, 'Again.zip'));
  await library.folderScan(id);
  assert.deepEqual(linkedRows(library).map(r => [r.gid, r.src.path]), before.map(r => [r.gid, 'Again.zip']));
  assert.deepEqual(await bytesOf(await library.getPageBlob(ch1, 1, 'translated')), [...pngBytes(99)]);
  assert.deepEqual(fs.readdirSync(path.join(other, '.shiori', 'linked')).filter(n => /^\d+$/.test(n)).sort(), before.map(r => r.gid).sort(), 'no second overlays');
});

test('R19: a linked source is read as it is at every check, and what was made from a page never moves to another picture', async (t) => {
  const { library, other } = await open(t);
  mk(other, 'Loose/1.png', pngBytes(1));
  const id = (await library.folderAdd(other)).id;
  await library.folderScan(id);
  const [g] = linkedRows(library);
  await described(library, g.gid);
  // (a) A picture added: read again, its fingerprint kept current, so a later rename still finds it.
  mk(other, 'Loose/2.png', pngBytes(2));
  assert.equal((await library.folderScan(id)).updated, 1);
  assert.equal((await library.getGallery(g.gid)).count, 2);
  assert.notEqual(linkedRows(library)[0].src.fingerprint, g.src.fingerprint);
  fs.renameSync(path.join(other, 'Loose'), path.join(other, 'Renamed'));
  assert.deepEqual(await library.folderScan(id), { added: 0, updated: 1, problems: [], stopped: false });
  // (b) A picture renamed: its pages follow, none left unreadable.
  await described(library, g.gid);
  fs.renameSync(path.join(other, 'Renamed', '1.png'), path.join(other, 'Renamed', '01.png'));
  await library.folderScan(id);
  assert.deepEqual(await bytesOf(await library.getPageBlob(g.gid, 1)), [...pngBytes(1)]);
  // (c) A picture inserted before a translated one: the translation is never shown over another.
  await library.putTranslatedImage({ galleryId: g.gid, pageNum: 1 }, png(0x71));
  await library.files.settle(g.gid);
  await library.files.describe(g.gid, { all: true });
  mk(other, 'Renamed/00.png', pngBytes(0));
  await library.folderScan(id);
  assert.deepEqual(await bytesOf(await library.getPageBlob(g.gid, 1)), [...pngBytes(0)]);
  const translatedOf = async (n) => (library._pageRow(g.gid, n) && JSON.parse(library._pageRow(g.gid, n).record).translated) ? bytesOf(await library.getPageBlob(g.gid, n, 'translated')) : null;
  assert.equal(await translatedOf(1), null, 'not over the picture inserted');
  await library.files.describe(g.gid, { all: true });
  const back = await removeAndAddBack(library, id, other);
  await library.folderScan(back);
  assert.equal(await translatedOf(1), null, 'not after a remove and add back either');
  // (d) Removed from the library, then other files at the same paths: new, so they join.
  await writeZip(path.join(other, 'Pack.zip'), [{ name: '1.png', data: pngBytes(5) }]);
  await library.folderScan(back);
  for (const r of linkedRows(library)) await library.deleteGallery(r.gid);
  await sleep(200);
  fs.rmSync(path.join(other, 'Renamed'), { recursive: true });
  mk(other, 'Renamed/a.png', pngBytes(7, 7, 7));
  fs.rmSync(path.join(other, 'Pack.zip'));
  await writeZip(path.join(other, 'Pack.zip'), [{ name: 'x.png', data: pngBytes(9) }, { name: 'y.png', data: pngBytes(10) }]);
  assert.equal((await library.folderScan(back)).added, 2);
});

test('R23: an archived gallery another app changed is read again', async (t) => {
  const { library, other } = await open(t);
  const id = (await library.folderAdd(other)).id;
  await library.folderSetDefault(id);
  const gid = library.nextGalleryId();
  await library.metaPut({ galleryId: gid, title: title('INDEX OLD') });
  await library.pagePut(gid, 1, png(1));
  await library.files.place(gid);
  await library.files.describe(gid, { all: true });
  await library.archiveGallery(gid);
  assert.equal(rowOf(library, gid).format, 'zip');
  assert.equal((await library.folderScan(id)).updated, 0, 'its own descriptions: nothing to read');
  const zip = library.files._abs(rowOf(library, gid).path);
  const entries = [];
  for (const [name, e] of await readDirectory(zip)) {
    let data = await readEntry(zip, e);
    if (name === 'metadata.json') data = Buffer.from(JSON.stringify({ ...JSON.parse(String(data)), title: title('EXTERNAL NEW') }));
    entries.push({ name, data });
  }
  await writeZip(zip, entries);
  assert.equal((await library.folderScan(id)).updated, 1);
  assert.equal((await library.metaGet(gid)).title.english, 'EXTERNAL NEW');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1)), [...pngBytes(1)]);
});

test('A08: archive names without the UTF-8 flag are read by the rule both apps share', async (t) => {
  const { library, other } = await open(t);
  const data = Buffer.from(pngBytes(1));
  rawZip(path.join(other, 'A.zip'), [
    { name: Buffer.from('第1話/001.png', 'utf8'), data }, { name: Buffer.from('第2話/001.png', 'utf8'), data },
    { name: Buffer.from([0x81, 0x2e, 0x70, 0x6e, 0x67]), data }]);   // "ü.png" in code page 437
  assert.deepEqual([...(await readDirectory(path.join(other, 'A.zip'))).keys()], ['第1話/001.png', '第2話/001.png', 'ü.png']);
  const { id } = await library.folderAdd(other);
  await library.folderScan(id);
  assert.deepEqual(linkedRows(library).map(r => r.src.inner).sort(), ['第1話/', '第2話/']);
});

test('A14: a linked source renamed, or changed, never overwrites the library\'s edits not yet written to its overlay', async (t) => {
  const { library, other } = await open(t);
  mk(other, 'Loose/1.png', pngBytes(1));
  const id = (await library.folderAdd(other)).id;
  await library.folderScan(id);
  const gid = linkedRows(library)[0].gid;
  await described(library, gid);
  // An edit in the index its overlay doesn't have yet (one by hand is written at once; this one waits).
  const meta = await library.metaGet(gid);
  library._tx(() => { library._metaPutRaw({ ...meta, title: title('Edited in library') }); library._logIn(gid); });
  assert.equal(rowOf(library, gid).pending, 1);
  fs.renameSync(path.join(other, 'Loose'), path.join(other, 'Renamed'));
  assert.equal((await library.folderScan(id)).updated, 1, 'found where it is now');
  assert.equal((await library.metaGet(gid)).title.english, 'Edited in library', 'a rename');
  mk(other, 'Renamed/2.png', pngBytes(2));
  assert.equal(rowOf(library, gid).pending, 1);
  assert.equal((await library.folderScan(id)).updated, 0, 'changed, but its edits wait to be written: not read again');
  assert.equal((await library.metaGet(gid)).title.english, 'Edited in library', 'a change');
  await library.files.describe(gid, { all: true });
  assert.equal((await library.folderScan(id)).updated, 1, 'read once they are written');
  assert.deepEqual([(await library.metaGet(gid)).title.english, (await library.getGallery(gid)).count], ['Edited in library', 2]);
});

test('A19: a check sweeps temporary files only once no write can be making them; staging under the data folder too', async (t) => {
  const { library, other } = await open(t);
  const id = (await library.folderAdd(other)).id;
  const fresh = mk(other, 'Moving.shiori-tmp/0001.png', pngBytes(1));                 // a move copying now
  const old = aged(mk(other, 'Gone.shiori-tmp', 'half a write'));
  const reserved = aged(mk(other, 'Big.shiori-tmp', 'a long copy still under way'));
  library.files._reserved.add(library.files._join(id, 'Big'));
  const stray = aged(mk(library.dataStagingDir, '1790000000999/1-stray.png', pngBytes(9)));   // its gallery never committed
  await library.folderScan(id);
  assert.ok(fs.existsSync(fresh), 'one just written');
  assert.ok(fs.existsSync(reserved), 'one a running move reserved');
  assert.ok(!fs.existsSync(old), 'an old one');
  assert.ok(!fs.existsSync(stray), 'a staged file nothing refers to, in the library\'s own staging');
  library.files._reserved.clear();
});

test('A20: another tool\'s archive with a metadata.json beside its pictures is linked, not dropped', async (t) => {
  const { library, other } = await open(t);
  const file = path.join(other, 'RootPictures.zip');
  await writeZip(file, [{ name: 'metadata.json', data: Buffer.from(JSON.stringify({ tool: 'other', title: 'Theirs' })) }, { name: '01.png', data: pngBytes(2) }]);
  const bytes = fs.readFileSync(file);
  const { id } = await library.folderAdd(other);
  assert.equal((await library.folderScan(id)).added, 1);
  const [g] = linkedRows(library);
  assert.deepEqual([g.src.path, (await library.getGallery(g.gid)).count], ['RootPictures.zip', 1]);
  assert.deepEqual(await bytesOf(await library.getPageBlob(g.gid, 1)), [...pngBytes(2)]);
  assert.ok(fs.readFileSync(file).equals(bytes), 'never written');
});

test('A23: a PDF that can\'t be drawn isn\'t offered again until its file changes', async (t) => {
  const { library, other } = await open(t);
  const pdf = path.join(other, 'Broken.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 damaged');
  const { id } = await library.folderAdd(other);
  await library.folderScan(id);
  const [w] = await library.pdfsWaiting();
  await library.pdfFailed(id, w.gid);
  assert.deepEqual(await library.pdfsWaiting(), [], 'not offered again');
  assert.ok(JSON.parse(fs.readFileSync(path.join(overlayOf(other, w.gid), 'source.json'), 'utf8')).source.failed);
  await library.folderScan(id);
  assert.deepEqual(await library.pdfsWaiting(), [], 'a check doesn\'t forget it');
  fs.writeFileSync(pdf, '%PDF-1.4 replaced with a good copy');
  assert.deepEqual((await library.pdfsWaiting()).map(p => p.gid), [w.gid], 'offered again once the file changed');
  assert.equal(await library.addRendered(id, w.gid, [png(1)]), w.gid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(overlayOf(other, w.gid), 'source.json'), 'utf8')).source.failed, undefined);
});

test('a gallery folder moved by hand into another library folder is followed there, not taken for a copy', async (t) => {
  const { library, other, third } = await open(t);
  const a = (await library.folderAdd(other)).id;
  const b = (await library.folderAdd(third)).id;
  await library.folderSetDefault(a);
  const gid = library.nextGalleryId();
  await library.metaPut({ galleryId: gid, title: title('Wanderer') });
  for (const n of [1, 2]) await library.pagePut(gid, n, png(n));
  await library.files.place(gid);
  await library.files.describe(gid, { all: true });
  const from = library.files.folderOf(gid);
  // A copy elsewhere, its original still where it was: left out.
  fs.cpSync(from, path.join(third, 'Copy'), { recursive: true });
  const copy = await library.folderScan(b);
  assert.deepEqual([copy.added, placeOf(library, gid)], [0, a]);
  fs.rmSync(path.join(third, 'Copy'), { recursive: true });
  // Moved: followed.
  fs.renameSync(from, path.join(third, 'Wanderer'));
  const result = await library.rescan();
  assert.deepEqual(result.moved, [gid]);
  assert.deepEqual(result.missing, []);
  assert.deepEqual([placeOf(library, gid), library.files._split(rowOf(library, gid).path).rest, rowOf(library, gid).state], [b, 'Wanderer', 'packed']);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [...pngBytes(2)]);
  await whole(library);
});

test('a check reports what it couldn\'t read, and its task says how many', async (t) => {
  const { library, other } = await open(t);
  fs.writeFileSync(path.join(other, 'Broken.zip'), 'not an archive at all');
  mk(other, 'Fine/1.png', pngBytes(1));
  const heard = [];
  library.onPush((channel, msg) => { if (channel === 'jobs' && msg.kind === 'folder') heard.push(msg); });
  const { id } = await library.folderAdd(other);
  const result = await library.folderScan(id);
  assert.deepEqual([result.added, result.problems], [1, [{ path: 'Broken.zip', reason: 'corrupt' }]]);
  const last = heard.filter(m => m.gid === `folder-${id}` && m.status === 'done').at(-1);
  assert.deepEqual([last.found, last.problems], [1, 1]);
});

// ── Findings of the second external review (plans/library-storage-refactor-review-2.md) ──

test('F04: a gallery folder the website wrote reads whole on the desktop: every picture from the file its descriptions name, both custom covers', async (t) => {
  const { library, other } = await open(t);
  const { galleryFiles, DESCRIPTION_FILES } = await import('../../app/js/gallery-files.js');
  const gid = '1700000000042', dir = 'Written by the website';
  // Its pictures as the website keeps them: each replaced while its layout name was in use, so under
  // that name with a random part — and the old file beside it, its delete refused (F05).
  const pictures = {
    'images/0001.png': pngBytes(1), 'translated/0001-af21d3f4.png': pngBytes(2), 'study/bg/0001-0b1c2d3e.png': pngBytes(3),
    'study/text/0001-0-1a2b3c4d.png': pngBytes(4), 'pipeline/0001-raw-2b3c4d5e.png': pngBytes(5), 'pipeline/0001-text-3c4d5e6f.png': pngBytes(6),
    'covers/gallery-4d5e6f70.png': pngBytes(7), 'covers/series-5e6f7081.png': pngBytes(8),
  };
  const left = ['translated/0001.png', 'study/bg/0001.png', 'study/text/0001-0.png', 'pipeline/0001-raw.png', 'pipeline/0001-text.png', 'covers/gallery.png', 'covers/series.png'];
  const ref = (p) => ({ $path: p, folder: 'web', dir, size: pictures[p].length, type: 'image/png' });
  const records = [{ pageNum: 1, url: `local://${gid}/1.png`, mediaId: gid, galleryId: gid, cachedAt: 1, size: 5, blob: ref('images/0001.png'),
    translated: ref('translated/0001-af21d3f4.png'), studyBg: ref('study/bg/0001-0b1c2d3e.png'), studyPage: { w: 10, h: 10 },
    bubbles: [{ box: [0, 0, 5, 5], region: [0, 0, 5, 5], tr: 'Hello', src: 'こんにちは', text: ref('study/text/0001-0-1a2b3c4d.png') }],
    pipeline: { job: 'j1', masks: { raw: ref('pipeline/0001-raw-2b3c4d5e.png'), text: ref('pipeline/0001-text-3c4d5e6f.png') } } }];
  const covers = { gallery: ref('covers/gallery-4d5e6f70.png'), series: ref('covers/series-5e6f7081.png') };
  // Its descriptions as the website writes them (db.js _wantedDescriptions: the file each picture is in).
  for (const f of galleryFiles({ meta: { galleryId: gid, title: title('From the website') }, records, covers }, '', { fileOf: (src) => src.$path })) {
    if (DESCRIPTION_FILES.includes(f.name)) mk(other, `${dir}/${f.name}`, f.source);
  }
  for (const [p, data] of Object.entries(pictures)) mk(other, `${dir}/${p}`, data);
  for (const p of left) mk(other, `${dir}/${p}`, pngBytes(0xee));
  const id = (await library.folderAdd(other)).id;
  assert.deepEqual(await library.folderScan(id), { added: 1, updated: 0, problems: [], stopped: false });
  const rec = JSON.parse(library._pageRow(gid, 1).record);
  const read = async (r) => (r ? bytesOf(await library._readFile(gid, r)) : null);
  const cover = library._coverGet(gid);
  assert.deepEqual(await Promise.all([rec.translated, rec.studyBg, rec.bubbles?.[0]?.text, rec.pipeline?.masks?.raw, rec.pipeline?.masks?.text,
    cover?.cover, cover?.seriesCover].map(read)), [2, 3, 4, 5, 6, 7, 8].map(b => [...pngBytes(b)]));
  assert.equal(rec.bubbles[0].tr, 'Hello');
});

test('F07: what was made from a linked page is dropped once the page shows another picture: its bytes replaced, or one inserted before it', async (t) => {
  const { library, other } = await open(t);
  mk(other, 'Loose/001.png', pngBytes(1));
  mk(other, 'Loose/002.png', pngBytes(2));
  const id = (await library.folderAdd(other)).id;
  await library.folderScan(id);
  const [{ gid }] = linkedRows(library);
  const translatedOf = async (n) => (library._pageRow(gid, n) && JSON.parse(library._pageRow(gid, n).record).translated ? bytesOf(await library.getPageBlob(gid, n, 'translated')) : null);
  for (const n of [1, 2]) await library.putTranslatedImage({ galleryId: gid, pageNum: n }, png(0x70 + n));
  await library.files.settle(gid);
  await described(library, gid);
  // (a) Page 1's picture replaced by other bytes of another size, under the same name.
  mk(other, 'Loose/001.png', pngBytes(9, 9, 9));
  assert.equal((await library.folderScan(id)).updated, 1);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1)), [...pngBytes(9, 9, 9)]);
  assert.equal(await translatedOf(1), null, 'not over the picture that replaced it');
  assert.deepEqual(await translatedOf(2), [...pngBytes(0x72)], 'the page whose picture stayed keeps it');
  await described(library, gid);
  const back = await removeAndAddBack(library, id, other);
  await library.folderScan(back);
  assert.deepEqual([await translatedOf(1), await translatedOf(2)], [null, [...pngBytes(0x72)]], 'read back from its overlay');
  // (b) A picture inserted before the translated one: it moves to page 3, its translation doesn't follow.
  await described(library, gid);
  mk(other, 'Loose/000.png', pngBytes(0));
  await library.folderScan(back);
  assert.deepEqual(await Promise.all([1, 2, 3].map(translatedOf)), [null, null, null]);
});

// made-again.test.mjs — S34 (review 11): a gallery deleted and made again under its id (an export imported again, a
// download asked again) while work begun for the deleted one is under way. That work acts on nothing of the gallery
// made again, which holds exactly what it was given — its title, its pages, a translation of its own — at once,
// after a flush and after a restart, in a folder of its own, and never waits for the deleted one's work; the deleted
// one's folder or archive goes; nothing is reported; no folder or row is left for a gallery the library hasn't. Each
// test holds the work at the file call where a reviewer's probe held it (plans/review-11-probes; fs-faults.mjs
// holdIn) and fails on the code before S34.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as faults from './fs-faults.mjs';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');

// Pictures large next to an archive's descriptions (an archive's settle adds them to it rather than unpacking it).
const big = (n) => { const b = new Uint8Array(2048); b.set([0x89, 0x50, 0x4e, 0x47, n]); return b; };
const blob = (bytes) => new Blob([bytes], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const same = (a, b) => !!a && Buffer.from(a).equals(Buffer.from(b));
const read = async (library, gid, n, variant) => {
  const b = await library.getPageBlob(gid, n, variant).catch(() => null);
  return b ? new Uint8Array(await b.arrayBuffer()) : null;
};

// A desktop library over a temporary folder — pages settled as they arrive, descriptions published when flushed — and
// its folder `B` added (`withB`).
async function open(t, { withB = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-again-'));
  const where = { dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), placeDelay: 0, describeDelay: 600_000 };
  const s = { dir, library: await new Library(where).open(), B: null };
  s.restart = async () => { s.library.close(); s.library = await new Library(where).open(); };
  if (withB) { fs.mkdirSync(path.join(dir, 'B')); s.B = (await s.library.folderAdd(path.join(dir, 'B'))).id; }
  t.after(() => { faults.reset(); try { s.library.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return s;
}
// Gallery `gid` (`name`) with pages `pages`, published in its folder.
async function made(library, gid, name, pages) {
  await library.metaPut({ galleryId: gid, title: title(name) });
  for (const [i, b] of pages.entries()) await library.pagePut(gid, i + 1, blob(b));
  await library.files.flush();
}
// Where gallery `gid`'s folder or archive is now (null: none).
const placeOf = (library, gid) => { const row = library.files._row(gid); return row ? library.files._abs(row.path) : null; };
// The first file call `when(call)` matches, held until `release()`: `reached` resolves as it is held.
function holdAt(when) {
  let reached, go;
  const at = new Promise((resolve) => { reached = resolve; }), released = new Promise((resolve) => { go = resolve; });
  const undo = faults.holdIn((call) => { if (!when(call)) return null; undo(); reached(call); return released; });
  return { reached: at, release: () => go() };
}
// Gallery `gid` deleted and made again — "Again", two pages, a translation of its second — while `hold` holds the
// deleted one's work, then let go. Resolves whether the making again waited for that work (`ms` and more).
async function remake(library, gid, hold, ms = 2000) {
  const work = (async () => {
    await library.deleteGallery(gid);
    await library.metaPut({ galleryId: gid, title: title('Again') });
    await library.pagePut(gid, 1, blob(big(91)));
    await library.pagePut(gid, 2, blob(big(92)));
    await library.putTranslatedPage({ galleryId: gid, pageNum: 2 }, blob(big(93)));
  })();
  const waited = await Promise.race([work.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), ms))]);
  hold.release();
  await work;
  return waited;
}
const noWait = (waited) => assert.equal(waited, false, 'the gallery made again waited for nothing of the deleted one\'s work');
// The gallery made again as it was given, at once, after a flush and the deletions, and after a restart: its title,
// pages and translation, in a folder of its own (in library folder `root`'s path when given) naming it; the deleted
// one's place (`old`) gone; nothing on any folder's Needs attention list.
async function isAgain(s, gid, old, { root = null } = {}) {
  for (const stage of ['at once', 'flushed', 'after a restart']) {
    if (stage === 'flushed') { await s.library.files.flush(); await s.library.files.applyDeletions(); }
    if (stage === 'after a restart') await s.restart();
    const lib = s.library;
    assert.equal((await lib.metaGet(gid))?.title?.english, 'Again', `${stage}: its title`);
    assert.ok(same(await read(lib, gid, 1), big(91)) && same(await read(lib, gid, 2), big(92)), `${stage}: its pages`);
    assert.ok(same(await read(lib, gid, 2, 'translated'), big(93)), `${stage}: its translation`);
    if (stage === 'at once') continue;
    const dir = placeOf(lib, gid);
    assert.ok(dir && fs.statSync(dir).isDirectory(), `${stage}: a folder of its own`);
    if (root) assert.ok(dir.startsWith(root), `${stage}: where it was made`);
    assert.notEqual(path.resolve(dir), path.resolve(old), `${stage}: not the deleted one's`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.shiori', 'gallery.json'), 'utf8')).galleryId, gid, `${stage}: which names it`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')).title.english, 'Again', `${stage}: its metadata there`);
    assert.equal(fs.existsSync(old), false, `${stage}: the deleted one's ${path.basename(old)} is gone`);
    assert.deepEqual((await lib.foldersList()).flatMap(f => f.attention ?? []).map(a => `${a.reason} ${a.path}`), [], `${stage}: nothing reported`);
  }
}

// 11A1 = 11B1: the deleted gallery's settle, its folder's images/ being made (one call per part): the gallery made again,
// its pages staged meanwhile, had them moved into the deleted one's folder — unreadable, the folder left and reported.
test('a settle of a gallery deleted while its folder is made moves none of the gallery made again\'s pages there (11A1)', async (t) => {
  const s = await open(t);
  const gid = '1790000003401';
  await made(s.library, gid, 'Old', [big(1), big(2)]);
  const old = placeOf(s.library, gid);
  const hold = holdAt((c) => c.op === 'mkdir' && c.path.endsWith('/Old/images'));
  await s.library.pagePut(gid, 3, blob(big(3)));   // its settle begins at once (placeDelay 0)
  await hold.reached;
  const waited = await remake(s.library, gid, hold);
  await isAgain(s, gid, old);
  noWait(waited);
});

// 11B2: the same settle, between its page moves, while the gallery made again has a picture of its own staged (its
// folder another app's for a moment): the picture was moved into the deleted one's folder and lost.
test('a settle of a gallery deleted between its page moves moves none of the gallery made again\'s staged pictures (11B2)', async (t) => {
  const s = await open(t);
  const gid = '1790000003402';
  await made(s.library, gid, 'Old', [big(1), big(2)]);
  const old = placeOf(s.library, gid);
  const hold = holdAt((c) => c.op === 'stat' && /\/staging\/.*\/3-[0-9a-f]+\.png$/.test(c.path));   // looking at its staged page 3
  await s.library.pagePut(gid, 3, blob(big(3)));
  await hold.reached;
  await s.library.deleteGallery(gid);
  await s.library.metaPut({ galleryId: gid, title: title('Again') });
  await s.library.pagePut(gid, 1, blob(big(91)));
  await s.library.pagePut(gid, 2, blob(big(92)));
  // Its folder can't be written to for a moment (another app's): its translation waits staged.
  const writable = s.library.folders.writable;
  s.library.folders.writable = () => false;
  try { await s.library.putTranslatedPage({ galleryId: gid, pageNum: 2 }, blob(big(93))); } finally { s.library.folders.writable = writable; }
  assert.equal(s.library.files._stagedOwn(gid).length, 1, 'its translation staged');
  hold.release();
  await isAgain(s, gid, old);
});

// 11B3: an archived gallery's settle, as it reads its archive: the pages of the gallery made again were added to the
// deleted one's archive — unreadable, the archive left and reported.
test('an archived gallery\'s settle, its gallery deleted as it reads the archive, adds nothing of the gallery made again to it (11B3)', async (t) => {
  const s = await open(t);
  const gid = '1790000003403';
  await made(s.library, gid, 'Old', [big(1), big(2)]);
  assert.ok(await s.library.archiveGallery(gid));
  const old = placeOf(s.library, gid);
  await s.library.pagePut(gid, 3, blob(big(3)));   // staged until its next settle
  const hold = holdAt((c) => c.op === 'stat' && c.path.endsWith('/Old.zip'));
  const settled = s.library.files.settle(gid).catch(() => {});
  await hold.reached;
  const waited = await remake(s.library, gid, hold);
  await settled;
  await isAgain(s, gid, old);
  noWait(waited);
});

// 11B4: an archived gallery's publication, as it reads its archive: the descriptions of the gallery made again were
// added to the deleted one's archive, which was then left and reported.
test('an archived gallery\'s publication, its gallery deleted as it reads the archive, adds nothing to it (11B4)', async (t) => {
  const s = await open(t);
  const gid = '1790000003404';
  await made(s.library, gid, 'Old', [big(1), big(2)]);
  assert.ok(await s.library.archiveGallery(gid));
  const old = placeOf(s.library, gid);
  await s.library.metaPut({ ...(await s.library.metaGet(gid)), title: title('Old, renamed') });
  const hold = holdAt((c) => c.op === 'stat' && c.path.endsWith('/Old.zip'));
  const published = s.library.files.describe(gid);
  await hold.reached;
  const waited = await remake(s.library, gid, hold);
  await published;
  await isAgain(s, gid, old);
  noWait(waited);
});

// 11A3: a check of the folder, begun before the deletion, comparing the rows it read at its start: it read the gallery
// made again from the deleted one's folder, which its deletion then took.
test('a check begun before a gallery was deleted and made again reads the new one from nowhere but its own folder (11A3)', async (t) => {
  const s = await open(t);
  const gid = '1790000003405';
  await made(s.library, gid, 'Old', [big(1), big(2)]);
  const old = placeOf(s.library, gid), oldRel = s.library.files._row(gid).path;
  const files = s.library.files, root = s.library.primaryId;
  // The deletion's hold of the old folder answered late, standing in for a busy deletion queue (review 11's stale.mjs).
  let opened;
  const deletion = new Promise((resolve) => { opened = resolve; });
  const hold = files.hold.bind(files);
  files.hold = async (id, o = {}) => { if (o.deletion && o.rel === oldRel) await deletion; return hold(id, o); };
  // A check of the folder under way, past its deletions owed, its walk held.
  let past;
  const passed = new Promise((resolve) => { past = resolve; });
  const apply = files.applyDeletions.bind(files);
  files.applyDeletions = (o = {}) => { const p = apply(o); if (o.root === root) { files.applyDeletions = apply; p.finally(past); } return p; };
  const checked = s.library.folderScan(root);
  await passed;
  const walk = holdAt((c) => c.op === 'readdir' && path.resolve(c.path) === path.resolve(s.library.libraryDir));
  await walk.reached;
  noWait(await remake(s.library, gid, { release: () => {} }));
  await files.flush();
  walk.release();
  await checked;
  opened();
  files.hold = hold;
  await isAgain(s, gid, old);
});

// S35 (the sweeps' 'made again' met it under load: a linked ZIP read again, its overlay mid-removal): a check's look at
// the places of the galleries it read at its start, one of them deleted and made again as it looks there, its old
// place found holding a folder that names no gallery — as the deleted one's folder or overlay does while it is being
// deleted (a file of it still there, its description gone; made so here once the deletion is over). Before S35 the
// check reported that place ('conflict') for the gallery made again, which has its own folder elsewhere.
test('a check\'s look at a place read at its start reports nothing for a gallery deleted and made again meanwhile', async (t) => {
  const s = await open(t);
  const gid = '1790000003408';
  await made(s.library, gid, 'Old', [big(1), big(2)]);
  const old = placeOf(s.library, gid), oldRel = s.library.files._row(gid).path;
  const files = s.library.files, root = s.library.primaryId;
  // The check's look at the old place held, once it is past its deletions owed (as 11A3's).
  let past, reached, go;
  const passed = new Promise((resolve) => { past = resolve; }), held = new Promise((resolve) => { reached = resolve; }), released = new Promise((resolve) => { go = resolve; });
  const apply = files.applyDeletions.bind(files), whose = files._whose.bind(files);
  files.applyDeletions = (o = {}) => { const p = apply(o); if (o.root === root) { files.applyDeletions = apply; p.finally(past); } return p; };
  let armed = false;
  files._whose = async (rel, id) => { if (armed && rel === oldRel) { armed = false; reached(); await released; } return whose(rel, id); };
  const checked = s.library.folderScan(root);
  await passed;
  armed = true;
  await held;
  noWait(await remake(s.library, gid, { release: () => {} }));
  await files.flush();
  await files.applyDeletions();
  assert.equal(fs.existsSync(old), false, 'the deleted one\'s folder deleted');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'notes.txt'), 'left there');
  go();
  const found = await checked;
  fs.rmSync(old, { recursive: true, force: true });   // the deletion over
  files._whose = whose;
  assert.deepEqual(found.problems.filter(p => p.gid === gid || p.path === path.basename(old)), [], 'the check reports nothing of the old place');
  await isAgain(s, gid, old);
});

// 11B7: a move asked for the deleted gallery, trying again once it saw it changed: it moved the gallery made again.
test('a move asked for a gallery deleted meanwhile moves none made again under its id (11B7)', async (t) => {
  const s = await open(t, { withB: true });
  const gid = '1790000003406';
  await made(s.library, gid, 'Old', [big(1), big(2)]);
  const old = placeOf(s.library, gid);
  const B = path.resolve(s.dir, 'B');
  const hold = holdAt((c) => path.resolve(c.path) === B && c.op === 'stat');   // its new folder's place being made
  const moved = s.library.moveGallery(gid, s.B).then(() => 'moved', () => 'refused');
  await hold.reached;
  const waited = await remake(s.library, gid, hold);
  await moved;
  await isAgain(s, gid, old, { root: s.library.libraryDir });
  noWait(waited);
});

// What v1.3.0 left that way (11A5): a row and a folder "Gallery <id>" claimed for a gallery already gone, holding its
// descriptions only — let go by a check as a deletion lets a folder go; one holding anything else stays, reported.
test('a folder v1.3.0 claimed for a gallery already gone is let go by a check, never one holding anything else (11A5)', async (t) => {
  const s = await open(t);
  const files = s.library.files;
  const [bare, kept] = ['1790000003408', '1790000003409'];
  for (const gid of [bare, kept]) { files._claim(gid); await files.describe(gid, { all: true }); }
  const [gone, stays] = [placeOf(s.library, bare), placeOf(s.library, kept)];
  assert.equal(path.basename(gone), `Gallery ${bare}`, 'as v1.3.0 named it');
  fs.writeFileSync(path.join(stays, 'mine.txt'), 'the person\'s');
  await s.library.folderScan(s.library.primaryId);
  await files.applyDeletions();
  for (const gid of [bare, kept]) assert.equal(files._row(gid), undefined, `no row for ${gid}`);
  assert.equal(fs.existsSync(gone), false, 'the folder of descriptions only is gone');
  assert.equal(fs.readFileSync(path.join(stays, 'mine.txt'), 'utf8'), 'the person\'s', 'the one holding a file of the person\'s stays');
  assert.deepEqual((await s.library.foldersList()).flatMap(f => f.attention ?? []).map(a => `${a.reason} ${a.path}`), [`left Gallery ${kept}`], 'reported');
});

// 11A5 = 11B5: a picture of its own written for a gallery deleted meanwhile claimed a folder for a gallery that is gone
// — a folder "Gallery <id>" and a row no one lists or deletes. The shape review 11 met it in: the gallery made again
// (its predecessor's publication held as it opens the folder), a translation of it on its way, then it deleted too.
test('a translation of a gallery deleted as it is stored leaves no folder or row for it (11A5)', async (t) => {
  const s = await open(t);
  const gid = '1790000003407';
  await made(s.library, gid, 'First', [big(1)]);
  await s.library.metaPut({ ...(await s.library.metaGet(gid)), title: title('First, renamed') });
  const opens = s.library.store.open;
  let reached, release;
  const under = new Promise((resolve) => { reached = resolve; }), go = new Promise((resolve) => { release = resolve; });
  s.library.store.open = async (...args) => { s.library.store.open = opens; reached(); await go; return opens(...args); };
  const published = s.library.files.describe(gid);
  await under;
  await s.library.deleteGallery(gid);
  await s.library.metaPut({ galleryId: gid, title: title('Second') });
  await s.library.pagePut(gid, 1, blob(big(2)));
  const stored = s.library.putTranslatedPage({ galleryId: gid, pageNum: 1 }, blob(big(3))).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));   // on its way (before S34: waiting to be given a folder)
  await s.library.deleteGallery(gid);
  release();
  await published;
  await stored;
  await s.library.files.flush();
  await s.library.files.applyDeletions();
  assert.equal(s.library.files._row(gid), undefined, 'no row for it');
  assert.deepEqual(fs.readdirSync(s.library.libraryDir).filter(n => !n.startsWith('.')), [], 'no folder for it');
  assert.deepEqual((await s.library.foldersList()).flatMap(f => f.attention ?? []), [], 'nothing reported');
});

// folders.test.mjs — a desktop library kept in several folders, like a game launcher's library
// folders: new galleries go to the default one and stay where they are kept when they change; a
// gallery moves to another folder whole (its folder copied there, then the old one deleted);
// removing a folder writes everything the library has of its galleries there, then forgets it and
// them (their files stay), so adding it again checks it from scratch; checking a folder is a task the
// windows hear of, and can stop; a folder inside another can't be added; a folder that can't be
// reached is shown so; each folder stages its own pages, so a page lands in its gallery's folder by a
// rename on the same drive. (The audit's findings each have a test of their own:
// folders-regressions.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { checkInvariants } = await import('../../app/js/library-check.js');

const png = (...bytes) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...bytes])], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytesOf = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);

// A library in a temporary folder, with a second folder beside it to add; `reopen()` closes it and
// opens it again from the same folders.
async function open(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-folders-'));
  const where = { dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'first'), placeDelay: 0, describeDelay: 600_000 };
  const ctx = { dir, where, other: path.join(dir, 'second'), library: await new Library(where).open() };
  ctx.reopen = async () => { ctx.library.close(); ctx.library = await new Library(where).open(); return ctx.library; };
  fs.mkdirSync(ctx.other);
  t.after(() => { try { ctx.library.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return ctx;
}
const row = (library, gid) => library._s('SELECT * FROM files WHERE gid = ?').get(gid);
async function gallery(library, name, pages = 2) {
  const gid = library.nextGalleryId();
  await library.metaPut({ galleryId: gid, title: title(name) });
  for (let n = 1; n <= pages; n++) await library.pagePut(gid, n, png(n, 7));
  await library.files.place(gid);
  return gid;
}
async function whole(library) {
  const errors = checkInvariants(await library.integritySnapshot()).violations.filter(v => v.severity === 'error');
  assert.deepEqual(errors.map(v => `${v.id} ${v.detail}`), []);
}
// The work running on folder `id` (its check, its removal), once it has ended.
const settled = (library, id) => library.folders.job(id)?.catch(() => {});
const reason = (p) => p.then(() => 'resolved', (e) => e.reason || e.code);
const heardJobs = (library) => {
  const heard = [];
  library.onPush((channel, msg) => { if (channel === 'jobs' && msg.kind === 'folder') heard.push(msg); });
  return heard;
};

// Every record the library keeps of gallery `gid`, table by table (none: forgotten).
const GALLERY_TABLES = ['meta', 'meta_tags', 'stats', 'pages', 'covers', 'files', 'places', 'stamps', 'staged_own', 'leftovers'];
const recordsOf = (library, gid) => GALLERY_TABLES.filter(table => library._s(`SELECT 1 FROM ${table} WHERE gid = ?`).get(gid));
const rootRow = (library, id) => library._s('SELECT * FROM roots WHERE id = ?').get(id);

test('a new gallery goes to the default folder, staged there and settled into it', async (t) => {
  const { library, other } = await open(t);
  const { id, restored } = await library.folderAdd(other);
  assert.equal(restored, 0);
  await library.folderSetDefault(id);
  const gid = library.nextGalleryId();
  await library.metaPut({ galleryId: gid, title: title('Second Home') });
  await library.pagePut(gid, 1, png(1));
  const staged = JSON.parse(library._pageRow(gid, 1).orig);
  assert.match(staged.file, new RegExp(`^@${id}/${gid}/`), 'its page waits in the second folder\'s own staging');
  assert.ok(fs.existsSync(path.join(other, '.shiori', 'staging', gid)));
  await library.files.place(gid);
  assert.equal(row(library, gid).path, `@${id}/Second Home`);
  assert.ok(fs.existsSync(path.join(other, 'Second Home', 'images', '0001.png')));
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1)), [0x89, 0x50, 0x4e, 0x47, 1]);
  assert.equal((await library.getGallery(gid)).folder, id);
  const places = await library.foldersList();
  assert.deepEqual(places.map(p => [p.path, p.isDefault, p.galleries, p.removable, p.access]),
    [[library.libraryDir, false, 0, false, 'granted'], [other, true, 1, true, 'granted']]);
  // A change stays where the gallery is, whatever the default is now.
  await library.folderSetDefault(library.primaryId);
  await library.pagePut(gid, 2, png(2));
  await library.files.place(gid);
  assert.ok(fs.existsSync(path.join(other, 'Second Home', 'images', '0002.png')));
  await whole(library);
});

test('a gallery moves to another folder whole, and back', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  const gid = await gallery(library, 'Travelling');
  await library.putTranslatedImage({ galleryId: gid, pageNum: 1 }, png(9));
  await library.files.place(gid);
  const { moved } = await library.moveGallery(gid, id);
  assert.deepEqual(moved, [gid]);
  assert.equal(row(library, gid).path, `@${id}/Travelling`);
  assert.equal(library._s('SELECT root FROM places WHERE gid = ?').get(gid).root, id, 'its place moved with it');
  assert.ok(fs.existsSync(path.join(other, 'Travelling', 'images', '0002.png')));
  assert.ok(fs.existsSync(path.join(other, 'Travelling', 'translated', '0001.png')));
  assert.ok(!fs.existsSync(path.join(library.libraryDir, 'Travelling')), 'the old folder is gone');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [0x89, 0x50, 0x4e, 0x47, 2, 7]);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1, 'translated')), [0x89, 0x50, 0x4e, 0x47, 9]);
  await library.moveGallery(gid, library.primaryId);
  assert.equal(row(library, gid).path, 'Travelling');
  assert.ok(!fs.existsSync(path.join(other, 'Travelling')));
  assert.equal((await library.moveGallery(gid, library.primaryId)).moved.length, 0, 'already there: nothing moves');
  await whole(library);
});

test('removing a folder writes everything the library has of its galleries there, then forgets the folder and every record of them; added again, it is checked from scratch', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Kept Apart', 3);
  await library.files.describe(gid);
  // A series whose second chapter isn't downloaded yet: what the library has of it (its source, its
  // tags) is nowhere but here.
  const owner = await gallery(library, 'Saga', 1);
  const later = library.nextGalleryId();
  await library.galleryCreate(later, { title: title('Saga 2'), sourceUrl: 'https://example.test/saga/2', tags: [{ type: 'tag', name: 'saga' }], numPages: 25 });
  await library.seriesCommand('write', owner, [{ id: owner, title: 'Ch 1' }, { id: later, title: 'Ch 2' }], { seriesTitle: title('Saga') });
  // A change not written to the folder yet.
  await library.metaPut({ ...(await library.metaGet(gid)), title: title('Kept Apart, Renamed') });
  await assert.rejects(library.folderRemove(library.primaryId), /first library folder stays/);
  const heard = heardJobs(library);
  const { galleries } = await library.folderRemove(id);
  assert.equal(galleries, 3);
  assert.equal((await library.foldersList()).length, 1, 'off the list at once');
  assert.equal(await library.getGallery(gid), null, 'out of the library at once');
  await settled(library, id);   // what it owes the folder, as a task
  assert.equal(heard.at(-1).status, 'done');
  assert.equal(heard.at(-1).found, 3);
  assert.equal(heard.at(-1).labelKey, 'lf.task_removing');
  // The folder has everything: the change, and a folder of its own for the chapter with no pages.
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'Kept Apart', 'metadata.json'), 'utf8')).title.english, 'Kept Apart, Renamed');
  assert.ok(fs.existsSync(path.join(other, 'Kept Apart', 'images', '0003.png')), 'its files stayed');
  const described = fs.readdirSync(other, { recursive: true }).filter(p => p.endsWith('metadata.json'))
    .map(p => JSON.parse(fs.readFileSync(path.join(other, p), 'utf8'))).find(m => String(m.galleryId) === later);
  assert.equal(described?.sourceUrl, 'https://example.test/saga/2', 'the chapter not downloaded is described there');
  // And the library has nothing of it any more.
  for (const g of [gid, owner, later]) assert.deepEqual(recordsOf(library, g), [], `nothing kept of ${g}`);
  assert.equal(rootRow(library, id), undefined, 'the folder is forgotten');
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, '.shiori', 'owner.json'), 'utf8')).owner, null, 'let go');
  assert.equal(library.defaultRoot(), library.primaryId, 'new galleries go to the first folder again');
  // Added again: a folder never seen, read from scratch.
  const again = await library.folderAdd(other);
  assert.equal(again.id, id, 'the folder keeps its own id');
  assert.equal(again.restored, 0, 'nothing kept to bring back');
  assert.equal((await library.folderScan(id)).added, 3, 'its galleries are found by checking it');
  const back = await library.getGallery(gid);
  assert.equal(back?.count, 3);
  assert.equal(back.title.english, 'Kept Apart, Renamed');
  assert.equal(back.folder, id);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 3)), [0x89, 0x50, 0x4e, 0x47, 3, 7]);
  const chapter = await library.getGallery(later);
  assert.equal(chapter?.count, 0, 'the chapter not downloaded is back, still without pages');
  assert.equal((await library.metaGet(later)).sourceUrl, 'https://example.test/saga/2');
  assert.deepEqual((await library.seriesResolve(later)).chapters.map(c => String(c.id)), [owner, later], 'in its series as before');
  await whole(library);
});

test('a folder that can\'t be written to is removed only once the person agrees to lose what only the library has; one whose removal couldn\'t write it all goes back as it was', async (t) => {
  const { library, other, dir } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Unsaved', 1);
  await library.files.describe(gid);
  await library.folderSetDefault(library.primaryId);
  const unsaved = (p) => p.then(() => 'resolved', (e) => [e.reason, e.galleries]);
  const away = path.join(dir, 'away');
  // Out of reach with a change not written there: asked first.
  await library.metaPut({ ...(await library.metaGet(gid)), title: title('Unsaved, Renamed') });
  fs.renameSync(other, away);
  assert.deepEqual(await unsaved(library.folderRemove(id)), ['unsaved', 1]);
  assert.ok((await library.foldersList()).some(p => p.id === id), 'still the library\'s');
  fs.renameSync(away, other);
  // Its own folder gone (deleted outside the app) with a page staged for it: the removal can't write
  // that, so the folder stays — the task says why — and is as it was before (hidden, here).
  fs.rmSync(path.join(other, 'Unsaved'), { recursive: true, force: true });
  await library.pagePut(gid, 2, png(2, 7));
  await library.files.place(gid);
  await library.folderHide(id);
  const heard = heardJobs(library);
  await library.folderRemove(id);
  await settled(library, id);
  assert.equal(heard.at(-1).status, 'error');
  assert.equal(heard.at(-1).errorKey, 'lf.task_kept');
  assert.equal(heard.at(-1).unsaved, 1);
  assert.equal((await library.foldersList()).find(p => p.id === id)?.hidden, true, 'back on the list, hidden as before');
  await library.folderShow(id);
  assert.ok(await library.getGallery(gid), 'and in the library once shown');
  // Removed anyway: lost, as chosen.
  await library.folderRemove(id, { discard: true });
  await settled(library, id);
  assert.equal(heard.at(-1).status, 'done');
  assert.deepEqual(recordsOf(library, gid), []);
  assert.equal(rootRow(library, id), undefined);
  await whole(library);
});

test('a folder inside another of the library\'s, or holding one, is refused; one already there is named', async (t) => {
  const { library, other, dir } = await open(t);
  await assert.rejects(library.folderAdd(path.join(library.libraryDir, 'inner')), (e) => e.code === 'invalid');
  fs.mkdirSync(path.join(library.libraryDir, 'inner'));
  await assert.rejects(library.folderAdd(path.join(library.libraryDir, 'inner')), (e) => e.reason === 'nested');
  await assert.rejects(library.folderAdd(dir), (e) => e.reason === 'nested');
  const { id } = await library.folderAdd(other);
  assert.deepEqual(await library.folderAdd(other), { id, restored: 0, existed: true });
});

test('a folder that can\'t be reached is shown so, and checking the folders leaves its galleries alone; nothing is made where it was', async (t) => {
  const { library, other, dir } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Far Away');
  const away = path.join(dir, 'away');
  fs.renameSync(other, away);   // the drive taken away
  assert.equal((await library.foldersList()).find(p => p.id === id).access, 'unavailable');
  const found = await library.rescan();
  assert.deepEqual(found.missing, [], 'a folder out of reach isn\'t checked');
  // A page arriving meanwhile waits in the library's own staging.
  await library.pagePut(gid, 3, png(3, 7));
  assert.match(JSON.parse(library._pageRow(gid, 3).orig).file, /^~data\//);
  await library.files.place(gid);
  assert.ok(!fs.existsSync(other), 'the folder isn\'t made again where it was');
  fs.renameSync(away, other);
  assert.equal((await library.foldersList()).find(p => p.id === id).access, 'granted');
  await library.files.place(gid);
  assert.ok(fs.existsSync(path.join(other, 'Far Away', 'images', '0003.png')), 'what waited goes there once it is back');
  assert.equal((await library.getGallery(gid)).count, 3);
  await whole(library);
});

test('the library\'s folders are remembered when it opens again', async (t) => {
  const ctx = await open(t);
  const { id } = await ctx.library.folderAdd(ctx.other);
  await ctx.library.folderSetDefault(id);
  const gid = await gallery(ctx.library, 'Remembered');
  const library = await ctx.reopen();
  assert.equal(library.defaultRoot(), id);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1)), [0x89, 0x50, 0x4e, 0x47, 1, 7]);
});

test('checking a folder is a task the windows hear of: it finds what was put there by hand, and stops when asked', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  for (const name of ['By Hand', 'Also By Hand']) {
    fs.mkdirSync(path.join(other, name));
    fs.writeFileSync(path.join(other, name, '01.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4]));
  }
  const heard = heardJobs(library);
  const stopping = library.folderScan(id);
  library.stopFolderScan(id);
  assert.deepEqual(await stopping, { added: 0, updated: 0, stopped: true });
  assert.equal(heard.at(-1).status, 'cancelled');
  heard.length = 0;
  assert.deepEqual(await library.folderScan(id), { added: 2, updated: 0, stopped: false });
  assert.deepEqual([heard[0].status, heard.at(-1).status], ['started', 'done']);
  assert.equal(heard.at(-1).gid, `folder-${id}`);
  assert.equal(heard.at(-1).title, 'second');
  assert.equal(heard.at(-1).found, 2);
  assert.deepEqual(heard.at(-1).runner, { kind: 'desktop-background' });
  // Its steps, each counted on its own: the folders at its top, then the galleries joining.
  const steps = Object.fromEntries(heard.filter(h => h.labelKey && h.total).map(h => [h.labelKey, h.total]));
  assert.equal(steps['lf.task_checking'], 2, 'its first step counts the folders at its top');
  assert.equal(steps['lf.task_adding'], 2, 'the next the galleries joining');
  assert.equal((await library.folderScan(id)).added, 0, 'galleries it keeps are not found again');
});

test('a removal the app was closed in the middle of goes on at its next start; adding the folder back before its last step ends it, everything back as it was', async (t) => {
  const ctx = await open(t);
  const { id } = await ctx.library.folderAdd(ctx.other);
  await ctx.library.folderSetDefault(id);
  const gids = [];
  for (let i = 0; i < 3; i++) gids.push(await gallery(ctx.library, `Part ${i}`, 1));
  await ctx.library.folderSetDefault(ctx.library.primaryId);
  // Closed as the removal began: the folder is marked, nothing written yet.
  ctx.library._s(`UPDATE roots SET state = 'removing', removal = ? WHERE id = ?`).run(JSON.stringify({ moveTo: null, discard: false, before: 'shown' }), id);
  let library = await ctx.reopen();
  assert.equal((await library.foldersList()).length, 1, 'still off the list');
  await settled(library, id);
  for (const gid of gids) assert.deepEqual(recordsOf(library, gid), [], 'forgotten once it is done');
  assert.equal(rootRow(library, id), undefined);
  for (const i of [0, 1, 2]) assert.ok(fs.existsSync(path.join(ctx.other, `Part ${i}`, 'metadata.json')), 'described there first');
  // Added again: found by checking it.
  assert.equal((await library.folderAdd(ctx.other)).restored, 0);
  assert.equal((await library.folderScan(id)).added, 3);
  // Added back while its removal is writing back (held until then): the removal ends, and everything
  // is back as it was.
  const writeBack = library.folders._writeBack.bind(library.folders);
  library.folders._writeBack = async (gid) => {
    while (!library.folders._jobs.get(id)?.cancel) await new Promise(r => setTimeout(r, 5));
    return writeBack(gid);
  };
  await library.folderRemove(id);
  const back = await library.folderAdd(ctx.other);
  assert.equal(back.id, id);
  assert.equal(back.restored, 3);
  await settled(library, id);
  assert.equal(rootRow(library, id).state, 'shown');
  assert.equal((await Promise.all(gids.map(g => library.getGallery(g)))).filter(Boolean).length, 3, 'all of them are in the library');
  assert.equal(library._s('SELECT count(*) AS n FROM unmounted').get().n, 0);
  await whole(library);
});

test('hiding a folder keeps it listed while its galleries leave the library; showing it brings them back, and it stays hidden across a restart', async (t) => {
  const ctx = await open(t);
  let library = ctx.library;
  const { id } = await library.folderAdd(ctx.other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Out Of Sight', 2);
  const first = await gallery(library, 'At Home', 1);
  await library.moveGallery(first, library.primaryId);
  assert.equal(await reason(library.folderHide(id)), 'default', 'the default is never hidden');
  await library.folderSetDefault(library.primaryId);
  assert.deepEqual(await library.folderHide(id), { id, galleries: 1 }, 'at once: nothing is moved');
  const listed = (await library.foldersList()).find(p => p.id === id);
  assert.deepEqual([listed.hidden, listed.galleries], [true, 1], 'listed still, hidden, counting what it hid');
  assert.equal(await library.getGallery(gid), null, 'its gallery left the library');
  assert.ok(fs.existsSync(path.join(ctx.other, 'Out Of Sight', 'images', '0002.png')), 'its files stayed');
  assert.deepEqual([await reason(library.folderSetDefault(id)), await reason(library.folderScan(id)), await reason(library.moveGallery(first, id))],
    ['hidden', 'hidden', 'hidden'], 'a hidden folder is never the default, checked or moved to');
  assert.equal((await library.rescan()).added.length, 0, 'checking every folder leaves a hidden one alone');
  // The first folder hidden too (another is the default), then that default removed: there is no
  // other folder shown, so it stays.
  await library.folderShow(id);
  await library.folderSetDefault(id);
  await library.folderHide(library.primaryId);
  assert.equal(await library.getGallery(first), null);
  assert.equal(await reason(library.folderRemove(id)), 'default', 'new galleries keep somewhere shown to go');
  assert.deepEqual(await library.folderShow(library.primaryId), { id: library.primaryId, restored: 1 });
  assert.equal((await library.getGallery(first))?.count, 1);
  // Hidden, then the app closed: still hidden at its next start.
  await library.folderSetDefault(library.primaryId);
  await library.folderHide(id);
  library = await ctx.reopen();
  assert.equal(await library.getGallery(gid), null);
  assert.equal((await library.foldersList()).find(p => p.id === id).hidden, true);
  // Shown again: back at once, without checking the folder.
  assert.deepEqual(await library.folderShow(id), { id, restored: 1 });
  assert.equal((await library.foldersList()).find(p => p.id === id).hidden, undefined);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 2)), [0x89, 0x50, 0x4e, 0x47, 2, 7]);
  await whole(library);
});

test('a folder is claimed by the app that adds it: another app asks first, the app it was taken from stops writing there, and removing it writes back what differs and lets it go', async (t) => {
  const { library, other } = await open(t);
  const claimFile = path.join(other, '.shiori', 'owner.json');
  const claimOf = () => JSON.parse(fs.readFileSync(claimFile, 'utf8'));
  const elsewhere = (epoch, owner = 'a1b2c3d4e5f60708') => {
    fs.mkdirSync(path.dirname(claimFile), { recursive: true });
    fs.writeFileSync(claimFile, JSON.stringify({ format: 'shiori-owner', version: 1, owner, by: { app: 'web', browser: 'Chrome', site: 'shiori.cc' }, at: 1, epoch }));
    library.folders._probes.clear();
  };
  // Another app holds it: refused, naming that app, unless forced.
  elsewhere(1);
  const refused = await library.folderAdd(other).then(() => null, (e) => e);
  assert.equal(refused?.reason, 'claimed');
  assert.deepEqual(refused.owner, { app: 'web', browser: 'Chrome', site: 'shiori.cc', active: true, at: 1 });
  const { id } = await library.folderAdd(other, { force: true });
  assert.equal(claimOf().owner, library.folders._me());
  assert.equal(claimOf().epoch, 2);
  assert.equal(library.folders.probe(library.primaryId).access, 'mine', 'the first folder is claimed as the library opens');
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Shared', 2);
  await library.files.describe(gid);
  // Taken over by the other app: listed so, and nothing more is written there.
  elsewhere(3);
  const listed = (await library.foldersList()).find(p => p.id === id);
  assert.equal(listed.access, 'taken');
  assert.equal(listed.owner.site, 'shiori.cc');
  assert.equal(library.defaultRoot(), id);
  await library.pagePut(gid, 3, png(3, 7));
  await library.files.place(gid);
  assert.ok(!fs.existsSync(path.join(other, 'Shared', 'images', '0003.png')), 'a new page waits, staged');
  assert.ok(!fs.existsSync(path.join(other, '.shiori', 'staging', gid)), 'in the library\'s own staging, not the folder\'s');
  assert.deepEqual([await reason(library.folderScan(id)), await reason(library.moveGallery(gid, library.primaryId)), await reason(library.folderSetDefault(id))],
    ['taken', 'taken', 'taken']);
  assert.equal((await library.rescan()).added.length, 0);
  // Taken back: what waited is settled into it.
  await library.folderClaim(id);
  assert.equal(claimOf().owner, library.folders._me());
  assert.equal(claimOf().epoch, 4, 'past every claim known');
  await library.files.place(gid);
  assert.ok(fs.existsSync(path.join(other, 'Shared', 'images', '0003.png')));
  // Removing it: a description out of date in the folder is written again, then the folder is let go.
  const metaFile = path.join(other, 'Shared', 'metadata.json');
  await library.files.describe(gid);
  const current = fs.readFileSync(metaFile, 'utf8');
  fs.writeFileSync(metaFile, '{}');
  await library.folderSetDefault(library.primaryId);
  await library.folderRemove(id);
  await settled(library, id);
  assert.equal(fs.readFileSync(metaFile, 'utf8'), current, 'the folder has the library\'s description again');
  assert.equal(claimOf().owner, null, 'let go');
  // Added back, by this app or another: checking the folder finds the gallery as it is there.
  const epoch = claimOf().epoch;
  fs.writeFileSync(claimFile, JSON.stringify({ format: 'shiori-owner', version: 1, owner: null, by: { app: 'web' }, at: 2, epoch: epoch + 1 }));
  assert.equal((await library.folderAdd(other)).restored, 0);
  assert.equal((await library.folderScan(id)).added, 1);
  assert.equal((await library.getGallery(gid))?.count, 3);
  await whole(library);
});

test('a check of a folder reads again the galleries another app changed there, unless this app has changes of its own waiting', async (t) => {
  const { library, other, dir } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Shared', 2);
  // Described, nothing waiting (its size, worked out a moment after, may mark it again: described then).
  for (let i = 0; i < 40 && (await library.files.describe(gid), library.files._row(gid).pending); i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(await library.folderScan(id), { added: 0, updated: 0, stopped: false }, 'nothing changed: nothing read again');
  // Another app (its own index, its own id) takes the folder over and changes the gallery there.
  const second = new Library({ dataDir: path.join(dir, 'data2'), libraryDir: path.join(dir, 'first2'), placeDelay: 0, describeDelay: 600_000 });
  second.folders._instance = 'b0b0b0b0b0b0b0b0';
  await second.open();
  try {
    const { id: same } = await second.folderAdd(other, { force: true });
    assert.equal(same, id);
    assert.equal((await second.folderScan(id)).added, 1);
    await second.metaPut({ ...(await second.metaGet(gid)), title: title('Shared, Renamed') });
    await second.pagePut(gid, 3, png(3, 9));
    await second.files.settle(gid);
    await second.files.describe(gid, { all: true });
    // Taken back here: a check reads it again as the folder has it now.
    await library.folderClaim(id);
    assert.deepEqual(await library.folderScan(id), { added: 0, updated: 1, stopped: false });
    const back = await library.getGallery(gid);
    assert.equal(back.title.english, 'Shared, Renamed');
    assert.equal(back.count, 3);
    assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 3)), [0x89, 0x50, 0x4e, 0x47, 3, 9]);
    assert.equal((await library.folderScan(id)).updated, 0, 'read once: the next check finds nothing new');
    // Changed there again, but changed here too, not yet written: this app's change wins.
    second.folders._probes.clear();
    await second.folderClaim(id);
    await second.metaPut({ ...(await second.metaGet(gid)), title: title('Their Title') });
    await second.files.describe(gid, { all: true });
    await library.folderClaim(id);
    await library.metaPut({ ...(await library.metaGet(gid)), title: title('My Title') });
    assert.equal((await library.folderScan(id)).updated, 0);
    assert.equal((await library.getGallery(gid)).title.english, 'My Title');
    await library.files.describe(gid);
    assert.equal(JSON.parse(fs.readFileSync(path.join(other, 'Shared', 'metadata.json'), 'utf8')).title.english, 'My Title');
    await whole(library);
  } finally { second.close(); }
});

test('a gallery with no files yet stays in the folder it was made in: changing the default moves nothing, and hiding that folder takes it along, its series intact', async (t) => {
  const { library, other } = await open(t);
  // A series not downloaded yet (its record and chapters have no pages), and a gallery with pages,
  // both made while the first folder is where new galleries go.
  const ids = [library.nextGalleryId(), library.nextGalleryId(), library.nextGalleryId()];
  for (const [i, gid] of ids.entries()) await library.galleryCreate(gid, { title: title(`Not Downloaded ${i}`) });
  await library.seriesCommand('write', ids[0], ids.map((id, i) => ({ id, title: `Ch ${i + 1}` })), { seriesTitle: title('Not Downloaded') });
  const kept = await gallery(library, 'Has Pages', 1);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  for (const gid of [...ids, kept]) assert.equal((await library.getGallery(gid)).folder, library.primaryId, 'still in the first folder');
  const newOne = library.nextGalleryId();
  await library.galleryCreate(newOne, { title: title('Made Now') });
  assert.equal((await library.getGallery(newOne)).folder, id, 'a new one goes where new galleries go');
  await library.folderSetDefault(library.primaryId);
  assert.equal((await library.getGallery(newOne)).folder, id, 'and stays there');
  // Hidden: every gallery of the first folder leaves, those with no files too; nothing goes elsewhere.
  await library.folderSetDefault(id);
  await library.folderHide(library.primaryId);
  for (const gid of [...ids, kept]) assert.equal(await library.getGallery(gid), null);
  assert.equal(library._s('SELECT count(*) AS n FROM unmounted WHERE root = ?').get(library.primaryId).n, 4);
  assert.deepEqual(fs.readdirSync(other).filter(n => !n.startsWith('.')), [], 'nothing was written to the other folder');
  // Shown again: all back where they were, the series as it was.
  assert.equal((await library.folderShow(library.primaryId)).restored, 4);
  const series = await library.seriesResolve(ids[2]);
  assert.deepEqual(series.chapters.map(c => String(c.id)), ids);
  for (const gid of [...ids, kept]) assert.equal((await library.getGallery(gid)).folder, library.primaryId);
  await whole(library);
});

test('hiding a folder never edits a series reaching out of it: shown again, its galleries are in their series as before', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  const owner = await gallery(library, 'Spread', 1);
  const there = await gallery(library, 'Spread 2', 1);
  await library.seriesCommand('write', owner, [{ id: owner, title: 'Ch 1' }, { id: there, title: 'Ch 2' }], { seriesTitle: title('Spread') });
  await library.moveGallery(there, id, { series: false });
  await library.folderSetDefault(id);
  await library.folderHide(library.primaryId);
  assert.equal(await library.getGallery(owner), null);
  assert.ok(await library.getGallery(there), 'the chapter in the other folder stays');
  await library.folderShow(library.primaryId);
  assert.deepEqual((await library.seriesResolve(there)).chapters.map(c => String(c.id)), [owner, there], 'the series as it was');
  await whole(library);
});

test('hiding a folder is a switch: at once, its galleries out of every listing yet still the library\'s, refused every write, and back as they were', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gids = [];
  for (let i = 0; i < 300; i++) {
    const gid = library.nextGalleryId();
    await library.metaPut({ galleryId: gid, title: title(`Many ${i}`), tags: [{ type: 'tag', name: 'many' }], ...(i === 0 ? { sourceId: 'src-1', source: 'here' } : {}) });
    await library.pagePut(gid, 1, png(i % 250, 7));
    gids.push(gid);
  }
  for (const gid of gids) await library.files.place(gid);
  await library.folderSetDefault(library.primaryId);
  const before = await library.galleriesCount();
  const t0 = performance.now();
  assert.equal((await library.folderHide(id)).galleries, 300);
  const took = performance.now() - t0;
  assert.ok(took < 1000, `hidden at once (${took.toFixed(0)} ms)`);
  assert.equal(await library.galleriesCount(), before - 300);
  assert.equal((await library.galleriesPage({ limit: 1000 })).filter(g => gids.includes(g.id)).length, 0, 'out of the pages');
  assert.equal((await library.galleryIdsSorted()).filter(g => gids.includes(g)).length, 0);
  assert.equal([...(await library.metaGetAllMap()).keys()].filter(g => gids.includes(g)).length, 0, 'out of search');
  assert.equal((await library.tagCounts({ keys: ['tag:many'] })).get('tag:many'), 0, 'out of the tag counts');
  assert.equal(Object.keys((await library.getStats()).galleries).filter(g => gids.includes(g)).length, 0);
  assert.equal(await library.getGallery(gids[0]), null);
  assert.ok(library.unmounted(gids[0]));
  assert.equal(await reason(library.metaPut({ ...(await library.metaGet(gids[0])), title: title('Edited') })), 'hidden', 'written to by nothing');
  assert.equal(await reason(library.pagePut(gids[0], 2, png(2))), 'hidden');
  assert.equal(await library.resolveGalleryId('src-1', 'here'), gids[0], 'still the library\'s: its source finds it');
  assert.ok((await library.transferIds()).includes(gids[0]));
  assert.equal((await library.foldersList()).find(f => f.id === id).galleries, 300, 'its row counts them');
  const t1 = performance.now();
  assert.equal((await library.folderShow(id)).restored, 300);
  assert.ok(performance.now() - t1 < 1000, 'shown at once');
  assert.equal(await library.galleriesCount(), before);
  assert.equal((await library.getGallery(gids[299])).count, 1);
  await whole(library);
});

test('an index from before folders had a lifecycle is taken over: its folders, hidden and removed ones, claims and places; galleries an earlier version set aside come back', async (t) => {
  const ctx = await open(t);
  let library = ctx.library;
  const third = path.join(ctx.dir, 'third');
  fs.mkdirSync(third);
  const { id } = await library.folderAdd(ctx.other);
  const { id: gone } = await library.folderAdd(third);
  await library.folderSetDefault(id);
  const kept = await gallery(library, 'Kept', 1);
  const hidden = library.nextGalleryId();
  await library.galleryCreate(hidden, { title: title('No Files Yet') });   // placed in `id`, no folder of its own
  await library.folderSetDefault(gone);
  const removed = await gallery(library, 'Removed Before', 1);
  await library.files.describe(removed);
  await library.folderSetDefault(library.primaryId);
  const setAside = await gallery(library, 'Set Aside', 1);
  await library.moveGallery(setAside, id);
  const epochOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.shiori', 'owner.json'), 'utf8')).epoch;
  // As the working-tree version left its index: folders in kv, `homes` and `unmounted` tables, the
  // `dormant` table with a set-aside gallery, folder `id` hidden and `gone` removed (dormant).
  const bundle = { stat: library._s('SELECT record FROM stats WHERE gid = ?').get(setAside).record, meta: library._s('SELECT record FROM meta WHERE gid = ?').get(setAside).record,
    pages: library._pageRows(setAside).map(r => ({ n: r.n, key: r.key, w: r.w, h: r.h, orig: r.orig, record: r.record })), cover: null, files: row(library, setAside), home: null };
  library._tx(() => {
    library.files.keep.add(setAside);
    try { library._deleteIn(setAside); } finally { library.files.keep.delete(setAside); }
  });
  const homeOf = library._s('SELECT root FROM places WHERE gid = ?').get(hidden).root;
  library._db.exec(`DROP VIEW unmounted; DELETE FROM places; DELETE FROM roots WHERE first = 0;
    CREATE TABLE homes (gid TEXT PRIMARY KEY, root TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE unmounted (gid TEXT PRIMARY KEY, root TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE dormant (gid TEXT PRIMARY KEY, root TEXT NOT NULL, bundle TEXT NOT NULL);`);
  library._stmts.clear();
  library._s('INSERT INTO homes (gid, root) VALUES (?, ?)').run(hidden, homeOf);
  library._s('INSERT INTO unmounted (gid, root) VALUES (?, ?)').run(kept, id);
  library._s('INSERT INTO dormant (gid, root, bundle) VALUES (?, ?, ?)').run(setAside, id, JSON.stringify(bundle));
  library._kvSet('roots', [{ id, path: ctx.other }, { id: gone, path: third, dormant: true }]);
  library._kvSet('hiddenRoots', [{ id }]);
  library._kvSet('claimEpochs', { [id]: epochOf(ctx.other), [gone]: epochOf(third) });
  library = await ctx.reopen();
  assert.equal(library._kvGet('roots'), null, 'the settings are rows now');
  assert.equal(rootRow(library, id).state, 'hidden');
  assert.equal(rootRow(library, id).epoch, epochOf(ctx.other));
  assert.equal(library._s(`SELECT type FROM sqlite_schema WHERE name = 'unmounted'`).get().type, 'view');
  for (const name of ['homes', 'dormant']) assert.equal(library._s(`SELECT 1 FROM sqlite_schema WHERE name = ?`).get(name), undefined, `${name} is gone`);
  for (const gid of [kept, hidden, setAside]) assert.equal(library._s('SELECT root FROM places WHERE gid = ?').get(gid)?.root, id, 'placed where it was');
  assert.equal(await library.getGallery(setAside), null, 'set aside: back, out of the library while its folder is hidden');
  // The folder removed before: its removal writes back, then forgets it.
  await settled(library, gone);
  assert.equal(rootRow(library, gone), undefined);
  assert.deepEqual(recordsOf(library, removed), []);
  assert.ok(fs.existsSync(path.join(third, 'Removed Before', 'metadata.json')), 'its files stayed');
  await library.folderShow(id);
  for (const gid of [kept, hidden, setAside]) assert.ok(await library.getGallery(gid));
  assert.deepEqual(await bytesOf(await library.getPageBlob(setAside, 1)), [0x89, 0x50, 0x4e, 0x47, 1, 7]);
  await whole(library);
});

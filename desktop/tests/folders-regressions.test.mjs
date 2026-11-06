// folders-regressions.test.mjs — the library-folder findings of the 2026-10-30 audit that the desktop
// library had (plans/library-storage-spec.md, "Audit results"), each reproduced as the audit did —
// failures injected where it took one — and held: a test per finding, named after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { checkInvariants } = await import('../../app/js/library-check.js');
const { failNext } = await import('./fs-faults.mjs');

const pngBytes = (...b) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...b]);
const png = (...b) => new Blob([pngBytes(...b)], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytesOf = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);
const tick = () => new Promise(r => setImmediate(r));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A library in a temporary folder, two more folders beside it to add; `reopen()` opens it again.
async function open(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-findings-'));
  const where = { dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'first'), placeDelay: 0, describeDelay: 600_000 };
  const ctx = { dir, where, other: path.join(dir, 'second'), third: path.join(dir, 'third'), library: await new Library(where).open() };
  ctx.reopen = async () => { ctx.library.close(); ctx.library = await new Library(where).open(); return ctx.library; };
  fs.mkdirSync(ctx.other);
  fs.mkdirSync(ctx.third);
  t.after(() => { try { ctx.library.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return ctx;
}
async function gallery(library, name, pages = 1) {
  const gid = library.nextGalleryId();
  await library.metaPut({ galleryId: gid, title: title(name) });
  for (let n = 1; n <= pages; n++) await library.pagePut(gid, n, png(n, 7));
  await library.files.place(gid);
  await library.files.describe(gid);
  return gid;
}
async function whole(library) {
  const errors = checkInvariants(await library.integritySnapshot()).violations.filter(v => v.severity === 'error');
  assert.deepEqual(errors.map(v => `${v.id} ${v.detail}`), []);
}
const settled = (library, id) => library.folders.job(id)?.catch(() => {});
const reason = (p) => p.then(() => 'resolved', (e) => e.reason || e.code);
const heardJobs = (library) => {
  const heard = [];
  library.onPush((channel, msg) => { if (channel === 'jobs' && msg.kind === 'folder') heard.push(msg); });
  return heard;
};
const placeOf = (library, gid) => library._s('SELECT root FROM places WHERE gid = ?').get(gid)?.root ?? null;
const rootRow = (library, id) => library._s('SELECT * FROM roots WHERE id = ?').get(id);
const folderOf = (library, gid) => library.files.folderOf(gid);
// Another app's claim on folder `dir` (folder-owner.js), as it would write it.
function claimedElsewhere(library, dir, epoch, owner = 'a1b2c3d4e5f60708') {
  fs.mkdirSync(path.join(dir, '.shiori'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.shiori', 'owner.json'), JSON.stringify({ format: 'shiori-owner', version: 1, owner,
    by: { app: 'web', browser: 'Chrome', site: 'shiori.cc' }, at: Date.now(), epoch }));
  library.folders._probes.clear();
}
const claimOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.shiori', 'owner.json'), 'utf8'));
// `fs[name]` (or fs.promises[name], `promises`) failing with `code` while `when(...args)` holds.
function inject(t, name, when, code, { promises = false } = {}) {
  const host = promises ? fs.promises : fs;
  const real = host[name];
  host[name] = function (...args) {
    if (when(...args.map(String))) {
      const e = Object.assign(new Error(`${code}: injected, ${name} '${args[0]}'`), { code });
      if (promises) return Promise.reject(e);
      throw e;
    }
    return real.apply(this, args);
  };
  const restore = () => { host[name] = real; };
  t.after(restore);
  return restore;
}
// Picture folders put in folder `dir` by hand: { name: [bytes…] }.
function pictures(dir, sets) {
  for (const [name, list] of Object.entries(sets)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    list.forEach((b, i) => fs.writeFileSync(path.join(dir, name, `${String(i + 1).padStart(3, '0')}.png`), pngBytes(b)));
  }
}

test('R05: a gallery whose folder can\'t be made stays placed in its library folder, and a removal waiting on it is kept', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  // A new download: its folder can't be made the first time (no space), then can.
  const fresh = library.nextGalleryId();
  await library.metaPut({ galleryId: fresh, title: title('New Download') });
  await library.pagePut(fresh, 1, png(1));
  let restore = inject(t, 'mkdirSync', (p) => p.startsWith(other) && p.includes('New Download'), 'ENOSPC');
  await library.files.place(fresh);
  restore();
  assert.equal(placeOf(library, fresh), id, 'still placed where it was made');
  assert.equal(library.files.rootFor(fresh), id);
  await library.files.place(fresh);
  assert.ok(fs.existsSync(path.join(other, 'New Download', 'images', '0001.png')), 'its folder made there once it can be');
  // A gallery with no files yet (only its record): the removal can't give it a folder, so it is kept.
  const fileless = library.nextGalleryId();
  await library.galleryCreate(fileless, { title: title('Fileless One'), sourceUrl: 'https://example.test/x/1' });
  await library.folderSetDefault(library.primaryId);
  restore = inject(t, 'mkdirSync', (p) => p.startsWith(other) && p.includes('Fileless One'), 'ENOSPC');
  const heard = heardJobs(library);
  await library.folderRemove(id);
  await settled(library, id);
  restore();
  assert.equal(heard.at(-1).errorKey, 'lf.task_kept');
  assert.equal(heard.at(-1).unsaved, 1);
  assert.equal(rootRow(library, id).state, 'shown', 'the folder is the library\'s, as before');
  assert.equal(placeOf(library, fileless), id, 'the gallery is still placed in it');
  assert.equal((await library.getGallery(fileless))?.folder, id);
  await whole(library);
});

test('R06: a removal counts a gallery saved only once its descriptions were written: a failed rewrite keeps the folder', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Saved Already');
  await library.metaPut({ ...(await library.metaGet(gid)), title: title('Index Title') });
  await library.files.describe(gid);
  assert.equal(library.files._row(gid).pending, 0, 'nothing waiting by its flags');
  // The folder lost what it was published with (its manifest, format v2), and publishing it again fails.
  const meta = path.join(folderOf(library, gid), 'metadata.json');
  fs.rmSync(path.join(folderOf(library, gid), '.shiori', 'gallery.json'));
  fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, 'utf8')), title: title('OUTDATED ON DISK') }));
  // A series whose series.json can't be written.
  const a = await gallery(library, 'Saga One'), b = await gallery(library, 'Saga Two');
  await library.seriesCommand('write', a, [{ id: a, title: 'Ch 1' }, { id: b, title: 'Ch 2' }], { seriesTitle: title('Saga') });
  for (const g of [a, b]) await library.files.settle(g);
  await library.folderSetDefault(library.primaryId);
  const restore = inject(t, 'rename', (from, to) => to.endsWith('gallery.json') && to.includes('Saved Already') || to.endsWith('series.json'), 'EBUSY', { promises: true });
  const heard = heardJobs(library);
  await library.folderRemove(id);
  await settled(library, id);
  restore();
  assert.equal(heard.at(-1).errorKey, 'lf.task_kept', 'not done: two galleries couldn\'t be written');
  assert.equal(heard.at(-1).unsaved, 2);
  assert.ok(rootRow(library, id), 'the folder is kept');
  assert.equal((await library.getGallery(gid)).title.english, 'Index Title', 'and what only the library had');
  // Once it can be written: removed, the folder holding everything.
  await library.folderRemove(id);
  await settled(library, id);
  assert.equal(rootRow(library, id), undefined);
  assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).title.english, 'Index Title');
});

test('R07: nothing is written to a folder another app took over — pictures, a new gallery, staging, the orphan sweep, an archive\'s cut-off tail, clearing the library — and it isn\'t made the default', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Theirs Now', 2);
  const kept = await gallery(library, 'Archived', 1);
  await library.files.flush();
  assert.deepEqual((await library.archiveGallery(kept)).archived, [kept]);
  const archive = path.join(other, 'Archived.zip');
  const size = fs.statSync(archive).size;
  const old = path.join(folderOf(library, gid), 'translated', '9999.png');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, pngBytes(1));
  fs.utimesSync(old, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  const marker = path.join(other, '.shiori', 'staging', 'theirs', 'kept.png');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, pngBytes(2));
  const before = fs.readdirSync(other).sort();
  claimedElsewhere(library, other, 99);
  // Pictures made from its pages, a cover, a new gallery's pages: kept in the library's own staging.
  await library.putTranslatedImage({ galleryId: gid, pageNum: 1 }, png(9));
  await library.coverPut(gid, png(5));
  const fresh = library.nextGalleryId();
  await library.metaPut({ galleryId: fresh, title: title('Fresh') });
  await library.pagePut(fresh, 1, png(3));
  await library.files.settle(fresh);
  await library.files.settle(gid);
  assert.ok(!fs.existsSync(path.join(folderOf(library, gid), 'translated', '0001.png')));
  assert.ok(!fs.existsSync(path.join(folderOf(library, gid), 'covers')));
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1, 'translated')), [...pngBytes(9)], 'read from staging meanwhile');
  assert.match(JSON.parse(library._pageRow(fresh, 1).orig).file, /^~data\//);
  // Not made the default; the orphan sweep and an archive's tail leave it alone.
  await library.folderSetDefault(library.primaryId);
  assert.equal(await reason(library.folderSetDefault(id)), 'taken');
  await library.folderScan(library.primaryId);
  assert.ok(fs.existsSync(old), 'an old picture no record names stays: not this library\'s to sweep');
  library._s('UPDATE files SET tail = 100 WHERE gid = ?').run(kept);
  library.files.resume();
  assert.equal(fs.statSync(archive).size, size, 'an archive\'s tail isn\'t cut off');
  library._s('UPDATE files SET tail = NULL WHERE gid = ?').run(kept);
  // Clearing the library leaves its files as they are.
  await library.clearAll();
  await sleep(100);
  assert.deepEqual(fs.readdirSync(other).sort(), before);
  assert.ok(fs.existsSync(marker) && fs.existsSync(old) && fs.existsSync(archive));
});

test('R08: a claim that can\'t be read, or isn\'t one, leaves the folder read-only until it is taken back, and a takeover never lowers its epoch', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  const held = claimOf(other).epoch;
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Guarded');
  const meta = path.join(folderOf(library, gid), 'metadata.json');
  const damaged = '{"format":"shiori-owner","owner":"elsewhere","epo';
  fs.writeFileSync(path.join(other, '.shiori', 'owner.json'), damaged);
  library.folders._probes.clear();
  assert.equal(library.folders.probe(id).access, 'unknown');
  assert.equal(library.folders.writable(id), false);
  await library.metaPut({ ...(await library.metaGet(gid)), title: title('Written While Unknown') });
  assert.deepEqual(await library.files.describe(gid), { ok: false });
  assert.notEqual(JSON.parse(fs.readFileSync(meta, 'utf8')).title.english, 'Written While Unknown');
  assert.equal(fs.readFileSync(path.join(other, '.shiori', 'owner.json'), 'utf8'), damaged, 'never overwritten unasked');
  const listed = (await library.foldersList()).find(p => p.id === id);
  assert.deepEqual([listed.access, listed.owner], ['taken', null]);
  // One that can't be read at all (permission denied): the same.
  claimedElsewhere(library, other, 7);
  const restore = inject(t, 'readFileSync', (p) => p.endsWith('owner.json'), 'EPERM');
  assert.equal(library.folders.probe(id, { fresh: true }).access, 'unknown');
  restore();
  // Taken back by hand: past every epoch known (this library's and the one it read), and past every
  // one after a damaged claim.
  await library.folderClaim(id);
  assert.equal(claimOf(other).epoch, Math.max(held, 7) + 1);
  fs.writeFileSync(path.join(other, '.shiori', 'owner.json'), damaged);
  await library.folderClaim(id);
  assert.ok(claimOf(other).epoch > Math.max(held, 7) + 1);
  await library.files.describe(gid);
  assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).title.english, 'Written While Unknown', 'written once it is held again');
});

test('R09: a series command or a series move reaching a gallery in a hidden folder is refused whole', async (t) => {
  const { library, other, third } = await open(t);
  const { id } = await library.folderAdd(other);
  const { id: id3 } = await library.folderAdd(third);
  const owner = await gallery(library, 'Owner'), child = await gallery(library, 'Child'), child2 = await gallery(library, 'Child2');
  await library.seriesCommand('attach', owner, child);
  await library.seriesCommand('attach', owner, child2);
  await library.moveGallery(child, id, { series: false });
  const childDir = folderOf(library, child);
  assert.ok(childDir.startsWith(other));
  await library.folderHide(id);
  assert.equal(await reason(library.seriesCommand('deleteSeries', owner)), 'hidden');
  assert.ok(library._metaGet(child) && library._metaGet(owner) && library._metaGet(child2), 'nothing deleted');
  assert.ok(fs.existsSync(childDir), 'the hidden chapter\'s files are untouched');
  assert.equal(await reason(library.moveGallery(owner, id3)), 'hidden');
  assert.equal(library.files.rootFor(owner), library.primaryId, 'nothing moved');
  assert.equal(placeOf(library, child), id);
  await library.folderShow(id);
  assert.deepEqual((await library.seriesResolve(child)).chapters.map(c => String(c.id)).sort(), [owner, child, child2].sort());
  await whole(library);
});

test('R12: a linked source whose path leads out of its folder reads nothing outside it', async (t) => {
  const { library, other, dir } = await open(t);
  const { id } = await library.folderAdd(other);
  fs.mkdirSync(path.join(dir, 'outside'));
  fs.writeFileSync(path.join(dir, 'outside', 'secret.png'), pngBytes(66));
  for (const [i, bad] of ['../outside', 'x\\..\\..\\outside'].entries()) {
    const gid = library.nextGalleryId();
    library._tx(() => {
      library._metaPutRaw({ galleryId: gid, title: title(`Escape ${i}`) });
      library._statPut({ galleryId: gid, count: 1, size: 6, latestAt: 1, addedAt: 1 });
      library._pagePutRow({ gid, n: 1, key: `local://${gid}/1.png`, orig: { at: 'x', entry: 'secret.png', size: 6, type: 'image/png' },
        record: { url: `local://${gid}/1.png`, blob: { $orig: 1, size: 6, type: 'image/png' }, galleryId: gid, size: 6 } });
      library._s(`INSERT INTO files (gid, path, format, state, used_at, source) VALUES (?, ?, 'folder', 'packed', 0, ?)`)
        .run(gid, `@${id}/.shiori/linked/${gid}`, JSON.stringify({ kind: 'dir', path: bad, fingerprint: null }));
      library._logIn(gid);
    });
    assert.equal(await library.getPageBlob(gid, 1), null, `${bad}: nothing read outside the folder`);
    assert.ok(!String(await library.files.sourceFile(gid, { at: 'x', entry: 'secret.png' })).startsWith(path.join(dir, 'outside')));
  }
});

test('R17: deleting several linked galleries at once notes every source as removed, so none comes back', async (t) => {
  const { library, other } = await open(t);
  pictures(other, { One: [1, 2], Two: [3], Three: [4, 5] });
  const { id } = await library.folderAdd(other);
  assert.equal((await library.folderScan(id)).added, 3);
  const gids = library._s('SELECT gid FROM files WHERE source IS NOT NULL').all().map(r => r.gid);
  await Promise.all(gids.map(g => library.deleteGallery(g)));
  const file = path.join(other, '.shiori', 'linked', 'removed.json');
  const noted = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).removed.map(r => r.path).sort() : []);
  await library.folders.publishRemoved(id);   // once the folder's notes written before it are
  assert.deepEqual(noted(), ['One', 'Three', 'Two']);
  assert.equal((await library.folderScan(id)).added, 0, 'none is added again');
  assert.ok(fs.existsSync(path.join(other, 'One', '001.png')), 'their pictures stay');
});

test('R20: a removal asked for while the folder is being checked stops the check, then runs; asked again after a stop, it starts again', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Keep Me');
  await library.folderSetDefault(library.primaryId);
  const bulk = library._bulkRun.bind(library);
  let release, first = true;
  const gate = new Promise(r => { release = r; });
  library._bulkRun = async (fn) => { if (first) { first = false; await gate; } return bulk(fn); };
  const heard = heardJobs(library);
  const scan = library.folderScan(id);
  await tick();
  await library.folderRemove(id);
  release();
  assert.equal((await scan).stopped, true, 'the check stopped');
  await settled(library, id);
  assert.deepEqual(heard.filter(h => h.status === 'done').map(h => h.labelKey), ['lf.task_removing']);
  assert.equal(rootRow(library, id), undefined, 'removed');
  assert.equal(library._metaGet(gid), null);
  // Stopped, then asked again: it starts again.
  await library.folderAdd(other);
  const removing = library.folderRemove(id);   // stopped before its job starts
  library.stopFolderScan(id);
  await removing;
  await settled(library, id);
  assert.equal(rootRow(library, id).state, 'removing', 'stopped: it waits');
  await library.folderRemove(id);
  await settled(library, id);
  assert.equal(rootRow(library, id), undefined);
});

test('R21: a folder added back during a stopped removal after another app claimed it is refused, and taken over only when asked — checked from scratch', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Stale');
  await library.folderSetDefault(library.primaryId);
  const removing = library.folderRemove(id);   // stopped before its job starts
  library.stopFolderScan(id);
  await removing;
  await settled(library, id);
  const epoch = claimOf(other).epoch;
  claimedElsewhere(library, other, epoch + 1, 'someone-else');
  assert.equal(await reason(library.folderAdd(other)), 'claimed');
  assert.equal(await library.getGallery(gid), null, 'its galleries stay out of the library');
  // Asked to take it over: the removal ends first (nothing waits for its gallery), then it is added as
  // a folder never seen.
  const back = await library.folderAdd(other, { force: true });
  assert.deepEqual(back, { id, restored: 0 });
  assert.equal(claimOf(other).owner, library.folders._me());
  assert.ok(claimOf(other).epoch > epoch + 1);
  assert.equal(library._metaGet(gid), null, 'the old records went with the removal');
  assert.equal((await library.folderScan(id)).added, 1, 'read as the folder has it now');
  await whole(library);
});

test('R22: records with metadata only belong to no folder: a removal leaves them in the library', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const m = library.nextGalleryId();
  await library.metaPut({ galleryId: m, title: title('Meta Only') });
  const p = await library.resolveGalleryId('abc123', 'somesource');
  for (const g of [m, p]) assert.equal(placeOf(library, g), null);
  await library.folderSetDefault(library.primaryId);
  await library.folderRemove(id);
  await settled(library, id);
  assert.equal(rootRow(library, id), undefined);
  assert.equal(library._metaGet(m)?.title.english, 'Meta Only');
  assert.equal(await library.resolveGalleryId('abc123', 'somesource'), p, 'the same placeholder');
});

// An index the working-tree version left: folder `id` listed in kv `roots` (`dormant`: removed by
// it), its row gone, and a `dormant` table holding `bundles` ({ gid: bundle }) set aside under it.
function earlierIndex(library, id, dir, { dormant = false, hidden = false, bundles = {} }) {
  library._s('DELETE FROM roots WHERE id = ?').run(id);
  library._db.exec('CREATE TABLE IF NOT EXISTS dormant (gid TEXT PRIMARY KEY, root TEXT NOT NULL, bundle TEXT NOT NULL)');
  for (const [gid, bundle] of Object.entries(bundles)) library._db.prepare('INSERT INTO dormant (gid, root, bundle) VALUES (?, ?, ?)').run(gid, id, JSON.stringify(bundle));
  library._kvSet('roots', [{ id, path: dir, ...(dormant ? { dormant: true } : {}) }]);
  if (hidden) library._kvSet('hiddenRoots', [{ id }]);
}

test('A05: taking over an earlier version\'s set-aside galleries never deletes a live gallery of the same id', async (t) => {
  const ctx = await open(t);
  const { id } = await ctx.library.folderAdd(ctx.other);
  const live = await gallery(ctx.library, 'Live');   // in the first folder
  earlierIndex(ctx.library, id, ctx.other, { dormant: true, bundles: { [live]: {
    meta: JSON.stringify({ galleryId: live, title: title('Old') }), stat: JSON.stringify({ galleryId: live }), pages: [], cover: null, files: null, home: id } } });
  const library = await ctx.reopen();
  await settled(library, id);
  assert.equal(rootRow(library, id), undefined, 'the folder removed before is forgotten');
  assert.equal(library._metaGet(live)?.title.english, 'Live', 'the live gallery is untouched');
  assert.equal(library._pageRows(live).length, 1);
  assert.equal(placeOf(library, live), library.primaryId);
});

test('A07: galleries an earlier version set aside wait while their folder\'s drive is away, and come back once it is there', async (t) => {
  const ctx = await open(t);
  const { id } = await ctx.library.folderAdd(ctx.other);
  const H = ctx.library.nextGalleryId();
  fs.mkdirSync(path.join(ctx.other, 'Hid', 'images'), { recursive: true });
  fs.writeFileSync(path.join(ctx.other, 'Hid', 'images', '0001.png'), pngBytes(9));
  earlierIndex(ctx.library, id, ctx.other, { hidden: true, bundles: { [H]: {
    meta: JSON.stringify({ galleryId: H, title: title('Hid'), tags: [{ type: 'artist', name: 'only-in-index' }] }), stat: JSON.stringify({ galleryId: H, count: 1 }),
    pages: [{ n: 1, key: `local://${H}/1.png`, w: null, h: null, orig: JSON.stringify({ at: 'p', entry: 'images/0001.png', size: 5, type: 'image/png' }),
      record: JSON.stringify({ url: `local://${H}/1.png`, blob: { $orig: 1, size: 5, type: 'image/png' }, galleryId: H, size: 5 }) }],
    cover: null, files: { path: `@${id}/Hid`, format: 'folder', state: 'packed' }, home: null } } });
  ctx.library.close();
  fs.renameSync(ctx.other, `${ctx.other}-away`);   // unplugged as the new version first starts
  let library = await ctx.reopen();
  assert.equal(library._s('SELECT count(*) AS n FROM dormant').get().n, 1, 'kept, not dropped');
  assert.equal(library._metaGet(H), null);
  fs.renameSync(`${ctx.other}-away`, ctx.other);
  library = await ctx.reopen();
  assert.deepEqual(library._metaGet(H)?.tags, [{ type: 'artist', name: 'only-in-index' }], 'back once the drive is');
  assert.equal(await library.getGallery(H), null, 'out of the library while its folder is hidden');
  await library.folderShow(id);
  assert.deepEqual(await bytesOf(await library.getPageBlob(H, 1)), [...pngBytes(9)]);
});

test('A09: a folder\'s own check and the check of every folder at once add each title once', async (t) => {
  const { library, other } = await open(t);
  pictures(other, { Alpha: [1], Beta: [2], Gamma: [3] });
  const { id } = await library.folderAdd(other);
  const [one, all] = await Promise.all([library.folderScan(id), library.rescan()]);
  assert.equal(one.added, 3);
  assert.equal(all.added.length, 3, 'the check of every folder joined it');
  const titles = (await library.galleriesPage({ limit: 50 })).map(g => g.title.english).sort();
  assert.deepEqual(titles, ['Alpha', 'Beta', 'Gamma']);
});

test('A11: a linked gallery moved to another folder isn\'t added again by the next check of the folder it left', async (t) => {
  const { library, other } = await open(t);
  pictures(other, { 'Inner Title': [41] });
  const { id } = await library.folderAdd(other);
  assert.equal((await library.folderScan(id)).added, 1);
  const [inner] = library._s('SELECT gid FROM stats').all().map(r => r.gid);
  assert.deepEqual((await library.moveGallery(inner, library.primaryId)).moved, [inner]);
  assert.equal(library.files.sourceOf(library.files._row(inner)), null, 'the library\'s own in its new place');
  assert.equal((await library.folderScan(id)).added, 0);
  assert.equal(library._s('SELECT count(*) AS n FROM stats').get().n, 1);
  assert.ok(fs.existsSync(path.join(other, 'Inner Title', '001.png')), 'its source stays where it was');
  assert.deepEqual(await bytesOf(await library.getPageBlob(inner, 1)), [...pngBytes(41)]);
});

test('A12: a record with metadata only takes the default\'s place once it becomes a gallery, never a hidden folder\'s', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const m = library.nextGalleryId();
  await library.metaPut({ galleryId: m, title: title('Meta First') });   // a download: metadata before pages
  await library.folderSetDefault(library.primaryId);
  assert.deepEqual(await library.folderHide(id), { id, galleries: 0 });
  await library.pagePut(m, 1, png(1));
  await library.files.place(m);
  assert.equal(placeOf(library, m), library.primaryId);
  assert.ok(folderOf(library, m).startsWith(library.libraryDir));
  assert.ok(await library.getGallery(m));
  assert.deepEqual(fs.readdirSync(other).filter(n => !n.startsWith('.')), [], 'nothing written to the hidden folder');
});

test('A13: a PDF drawn for a folder hidden meanwhile is refused, and nothing is written there', async (t) => {
  const { library, other } = await open(t);
  fs.writeFileSync(path.join(other, 'Book.pdf'), '%PDF-1.4\n%%EOF\n');
  const { id } = await library.folderAdd(other);
  await library.folderScan(id);
  const waiting = await library.pdfsWaiting();
  assert.equal(waiting.length, 1);
  await library.folderHide(id);
  assert.equal(await reason(library.addRendered(waiting[0].folder, waiting[0].gid, [png(1), png(2)])), 'hidden');
  assert.ok(!fs.existsSync(path.join(other, '.shiori', 'linked', waiting[0].gid, 'images')));
  assert.equal(library._s('SELECT count(*) AS n FROM stats').get().n, 0);
});

test('A17: the check of every folder leaves a folder being removed alone', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  await gallery(library, 'Old One');
  await library.folderSetDefault(library.primaryId);
  pictures(other, { 'Loose Pictures': [1, 2] });
  const bulk = library._bulkRun.bind(library);
  let release, first = true;
  const gate = new Promise(r => { release = r; });
  library._bulkRun = async (fn) => { if (first) { first = false; await gate; } return bulk(fn); };
  await library.folderRemove(id);   // its removal waits at the gate (a long write-back)
  const found = await library.rescan();
  assert.deepEqual(found.added, []);
  assert.equal(await reason(library.folderScan(id)), 'not-found');
  release();
  await settled(library, id);
  assert.equal(library._s('SELECT count(*) AS n FROM stats').get().n, 0);
});

test('A21: opening the library never makes a folder again where one was', async (t) => {
  const ctx = await open(t);
  const { id } = await ctx.library.folderAdd(ctx.other);
  await ctx.library.folderSetDefault(id);
  await gallery(ctx.library, 'Away');
  await ctx.library.folderSetDefault(ctx.library.primaryId);
  ctx.library.close();
  fs.renameSync(ctx.other, `${ctx.other}-moved`);
  const library = await ctx.reopen();
  assert.ok(!fs.existsSync(ctx.other), 'not made again');
  assert.equal((await library.foldersList()).find(p => p.id === id).access, 'unavailable');
});

test('A25: checking every folder is each folder\'s own task, under its own id', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  const heard = heardJobs(library);
  await library.rescan();
  assert.deepEqual([...new Set(heard.map(h => h.gid))].sort(), [`folder-${library.primaryId}`, `folder-${id}`].sort());
});

test('A26: hiding, showing and removing a folder leave a trace in the change log, so a window catching up reads everything again', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  for (const step of [() => library.folderHide(id), () => library.folderShow(id), async () => { await library.folderRemove(id); await settled(library, id); }]) {
    const rev = await library.changeRevision();
    await step();
    assert.equal((await library.changesSince(rev)).resync, true);
  }
});

test('P7: a folder added back during its removal\'s last step waits for it, then is checked from scratch', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Comes Back');
  await library.folderSetDefault(library.primaryId);
  const forget = library.folders._forget.bind(library.folders);
  let release;
  const gate = new Promise(r => { release = r; });
  library.folders._forget = async (rid) => { await gate; return forget(rid); };
  await library.folderRemove(id);
  while (library.folders._jobs.get(id)?.phase !== 'forget') await sleep(5);
  const adding = library.folderAdd(other);
  await sleep(20);
  release();
  assert.deepEqual(await adding, { id, restored: 0 });
  assert.equal(rootRow(library, id).state, 'shown');
  assert.equal((await library.folderScan(id)).added, 1);
  assert.equal((await library.getGallery(gid))?.title.english, 'Comes Back');
});

test('P7: a removal that moves its galleries elsewhere reports each one moved or left, and writes back those left', async (t) => {
  const { library, other, third } = await open(t);
  const { id } = await library.folderAdd(other);
  const { id: to } = await library.folderAdd(third);
  await library.folderSetDefault(id);
  const gids = [];
  for (let i = 0; i < 4; i++) gids.push(await gallery(library, `Mv ${i}`));
  await library.folderSetDefault(library.primaryId);
  const moveTo = library.files.moveTo.bind(library.files);
  library.files.moveTo = async (g, dest, o) => { if (g === gids[0] || g === gids[1]) throw new Error('ENOSPC: no space left on device'); return moveTo(g, dest, o); };
  const heard = heardJobs(library);
  await library.folderRemove(id, { moveTo: to });
  await settled(library, id);
  const last = heard.at(-1);
  assert.deepEqual([last.status, last.doneKey, last.found, last.left], ['done', 'lf.task_moved', 2, 2]);
  for (const g of gids.slice(2)) assert.equal(placeOf(library, g), to);
  for (const g of gids.slice(0, 2)) assert.equal(library._metaGet(g), null, 'left with the folder, forgotten');
  assert.ok(fs.existsSync(path.join(other, 'Mv 0', 'metadata.json')));
});

// ── The second review's findings (plans/library-storage-refactor-review-2.md), reproduced as it did ──

test('R17: a note whose file something holds for a moment as it is replaced (a reader, an antivirus scan) is written all the same', async (t) => {
  const { library, other } = await open(t);
  pictures(other, { One: [1], Two: [2] });
  const { id } = await library.folderAdd(other);
  assert.equal((await library.folderScan(id)).added, 2);
  let held = 2;
  inject(t, 'rename', (from, to) => to.endsWith('removed.json') && held-- > 0, 'EPERM', { promises: true });
  for (const { gid } of library._s('SELECT gid FROM files WHERE source IS NOT NULL').all()) await library.deleteGallery(gid);
  await library.folders.publishRemoved(id);
  const file = path.join(other, '.shiori', 'linked', 'removed.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).removed.map(r => r.path).sort(), ['One', 'Two']);
});

test('F01: another folder at a library folder\'s path is not it, and a gallery\'s old place holding another folder is not the gallery\'s: nothing there is claimed, written or deleted', async (t) => {
  const { library, dir, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const [kept, gone] = [await gallery(library, 'Same Name'), await gallery(library, 'Replaced')];
  await library.folderSetDefault(library.primaryId);
  // A folder put by hand where a gallery's was (that one moved aside): the gallery's delete leaves it.
  fs.renameSync(path.join(other, 'Replaced'), path.join(dir, 'Replaced aside'));
  fs.mkdirSync(path.join(other, 'Replaced'));
  fs.writeFileSync(path.join(other, 'Replaced', 'notes.txt'), 'mine');
  await library.deleteGallery(gone);
  await sleep(100);   // what it left deleted, once that commits
  // The library folder's drive away, another disk given its letter: another library's folder there.
  fs.renameSync(other, path.join(dir, 'away'));
  fs.mkdirSync(path.join(other, '.shiori'), { recursive: true });
  fs.writeFileSync(path.join(other, '.shiori', 'library.json'), JSON.stringify({ format: 'shiori-library', version: 1, id: 'f0f0f0f0f0f0f0f0' }));
  fs.mkdirSync(path.join(other, 'Same Name'));
  fs.writeFileSync(path.join(other, 'Same Name', 'personal-notes.txt'), 'mine');
  library.folders._probes.clear();   // its claim as last read, gone stale
  const listed = (await library.foldersList()).find(f => f.id === id);
  // S7 (D3): a deletion its folder can't take now is refused, and the gallery stays.
  assert.equal(await reason(library.deleteGallery(kept)), 'other-library');
  assert.ok(library._metaGet(kept), 'the gallery stays');
  await sleep(100);
  assert.equal(listed.access, 'other-library');   // S5: told apart from a folder out of reach (principle 1)
  assert.ok(fs.existsSync(path.join(dir, 'away', 'Replaced', 'notes.txt')), 'the folder put in the gallery\'s place stays');
  assert.ok(fs.existsSync(path.join(other, 'Same Name', 'personal-notes.txt')), 'the other library\'s folder stays');
  assert.ok(!fs.existsSync(path.join(other, '.shiori', 'owner.json')), 'and is never claimed');
  assert.equal(await reason(library.folderClaim(id)), 'other-library');
});

test('F02: a removal\'s move into a folder hidden or removed while it is copied is refused — the gallery stays where it was, left — and the copy goes', async (t) => {
  for (const how of ['remove', 'hide']) {
    const { library, other, third } = await open(t);
    const { id } = await library.folderAdd(other);
    const { id: to } = await library.folderAdd(third);
    await library.folderSetDefault(id);
    const gid = await gallery(library, `Moving ${how}`);
    await library.folderSetDefault(library.primaryId);
    const cp = fs.promises.cp;
    let release, reached;
    const held = new Promise(r => { release = r; });
    const copying = new Promise(r => { reached = r; });
    fs.promises.cp = async (...args) => { reached(); await held; return cp.apply(fs.promises, args); };
    t.after(() => { fs.promises.cp = cp; });
    // On another drive (the rename into it refused as EXDEV): copied, so there is a copy to hold.
    const into = third.split(path.sep).join('/');
    t.after(failNext((c) => c.op === 'rename' && !c.path.endsWith('.shiori-tmp') && c.to.startsWith(into), 'EXDEV', { times: Infinity }));
    const heard = heardJobs(library);
    await library.folderRemove(id, { moveTo: to });
    await copying;
    if (how === 'remove') { await library.folderRemove(to); await settled(library, to); } else await library.folderHide(to);
    release();
    await settled(library, id);
    fs.promises.cp = cp;
    const last = heard.filter(m => m.gid === `folder-${id}`).at(-1);
    assert.deepEqual([how, last.status, last.found, last.left], [how, 'done', 0, 1]);
    assert.equal(placeOf(library, gid), null, 'forgotten with its folder — not kept as the other one\'s');
    assert.ok(fs.existsSync(path.join(other, `Moving ${how}`, 'images', '0001.png')), 'its files stay where they were');
    assert.deepEqual(fs.readdirSync(third).filter(n => n !== '.shiori'), [], 'no copy left there');
  }
});

// F03 and T06, format v2: a picture of the gallery's own is written under the name it keeps (a new one
// beside the file the folder's generation names), and no rename into place follows its commit — so
// nothing can fail or be lost there, and nothing records a picture still owed to its place. With every
// rename in its folder refused, the new translation is in the folder, the removal finds the folder
// holding everything, and the folder read back gives the new translation.
test('F03, T06: a picture is written under the name it keeps, with no rename after its commit: a removal finds it in its folder', async (t) => {
  const { library, other } = await open(t);
  const { id } = await library.folderAdd(other);
  await library.folderSetDefault(id);
  const gid = await gallery(library, 'Translated');
  const at = { galleryId: gid, pageNum: 1 };
  await library.putTranslatedPage(at, png(9), null);
  await library.files.flush();
  await library.folderSetDefault(library.primaryId);
  const restore = inject(t, 'renameSync', (from, to) => to.includes(path.join(other, 'Translated', 'translated')), 'EACCES');
  await library.putTranslatedPage(at, png(10), null);
  const name = JSON.parse(library._pageRow(gid, 1).record).translated.$own;
  assert.match(name, /^translated\/0001-[0-9a-f]{10}\.png$/, 'beside the one its folder\'s generation names');
  assert.deepEqual([...fs.readFileSync(path.join(other, 'Translated', ...name.split('/')))], [...pngBytes(10)], 'in its folder at once');
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1, 'translated')), [...pngBytes(10)]);
  await library.folderRemove(id);
  await settled(library, id);
  restore();
  assert.equal(rootRow(library, id), undefined, 'forgotten: its folder has everything');
  const back = (await library.folderAdd(other)).id;
  await library.folderScan(back);
  assert.deepEqual(await bytesOf(await library.getPageBlob(gid, 1, 'translated')), [...pngBytes(10)], 'read back: the new translation');
});

test('F12: a linked gallery deleted while its note can\'t be written stays removed: no check adds its source again, and the note is written later', async (t) => {
  const { library, other } = await open(t);
  pictures(other, { Linked: [1, 2] });
  const { id } = await library.folderAdd(other);
  assert.equal((await library.folderScan(id)).added, 1);
  const { gid } = library._s('SELECT gid FROM files WHERE source IS NOT NULL').get();
  const file = path.join(other, '.shiori', 'linked', 'removed.json');
  const overlay = path.join(other, '.shiori', 'linked', gid);
  const restore = inject(t, 'rename', (from, to) => to.endsWith('removed.json'), 'ENOSPC', { promises: true });
  await library.deleteGallery(gid);
  await library.folders.publishRemoved(id);
  assert.deepEqual([fs.existsSync(file), fs.existsSync(overlay)], [false, true], 'not written yet: its overlay stays till it is');
  assert.equal((await library.folderScan(id)).added, 0, 'not added again meanwhile');
  restore();
  assert.equal((await library.folderScan(id)).added, 0, 'nor once the note is written, at the next check');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).removed.map(r => r.path), ['Linked']);
  assert.ok(!fs.existsSync(overlay), 'its overlay goes then');
  assert.ok(fs.existsSync(path.join(other, 'Linked', '001.png')), 'its source stays');
});

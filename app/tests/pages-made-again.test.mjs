// pages-made-again.test.mjs — S36: a gallery deleted and made again under its id in one page of the website while a
// write of its pictures is under way in another. The website's pages — its tabs, and the service worker, which runs the
// browser's imports with the same code — share one IndexedDB, the library's folders and Web Locks, each running its own
// copy of the site's code: here two copies of every app module (library-drivers.mjs otherPage) over one IndexedDB
// (fake-indexeddb), the same folders (fsa-node.mjs) and Node's own Web Locks, shared by the process as a browser's are by
// its pages — the path a second tab or the service worker takes, but for the thread each runs on. The write begun for
// the deleted gallery lands nowhere: the gallery made again holds what it was given alone, in the browser's own storage
// or in a library folder — there, nothing of it points into the deleted one's folder, which goes — as when the deletion
// is made in the write's own page (S34). And a gallery as v1.3.0 made it (its stat record without the mark this code
// makes a gallery with) takes writes from both pages as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webLibrary, otherPage } from './library-drivers.mjs';
import * as fsa from './fsa-node.mjs';

const skip = !!globalThis.__desktopLibrary && 'the website\'s pages alone';
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255, 1, 2, 3]);
const picture = (n) => new Blob([png(n)], { type: 'image/png' });
const same = (a, b) => !!a && Buffer.from(a).equals(Buffer.from(b));
const title = (english) => ({ english, japanese: '', pretty: '' });
const gate = () => { let open; const at = new Promise((resolve) => { open = resolve; }); return { at, open }; };
const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (/** @type {() => boolean | Promise<boolean>} */ ok, ms = 5000) => { for (let i = 0; i < ms / 20 && !(await ok()); i++) await sleep(20); };
// The gallery's lock (db.js _galleryLocked) held from here — as another write of the gallery holds it — until let go;
// resolves once it is held.
async function holdLock(gid) {
  const go = gate(), held = gate();
  navigator.locks.request(`shiori:gallery:${gid}`, () => { held.open(); return go.at; });
  await held.at;
  return go.open;
}
// Whether a request for the gallery's lock waits (a write of it begun, waiting its turn).
const waiting = async (gid) => (await navigator.locks.query()).pending.some(l => l.name === `shiori:gallery:${gid}`);
// The gallery's stat record as v1.3.0 made it: without the mark (whatever this code calls it) — every field this
// code's records carry that v1.3.0's records have, kept.
const V130_FIELDS = new Set(['galleryId', 'count', 'size', 'origSize', 'latestAt', 'addedAt', 'coverPage', 'uploadDate', 'medianPage', 'pageSizes',
  'folder', 'dir', 'spilled', 'stamp', 'linked', 'packed', 'missing', 'parentId', 'chapterCount', 'aggPages', 'aggSize', 'aggOrig', 'aggMedianPage']);
async function asV130(db, gid) {
  const idb = await db.openDB();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction('galleries', 'readwrite');
    const store = tx.objectStore('galleries');
    const req = store.get(String(gid));
    req.onsuccess = () => store.put(Object.fromEntries(Object.entries(req.result).filter(([k]) => V130_FIELDS.has(k))));
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

test('a page stored in one page as another deletes its gallery and makes it again: nothing of it in the gallery made again, nor in the deleted one\'s folder (a library folder)', { skip }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-pages-'));
  const L = await webLibrary();
  const other = await otherPage();
  t.after(async () => { fsa.reset(); other.close(); await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const A = path.join(base, 'A');
  const a = await L.add(A);
  await L.setDefault(a);
  const gid = '1790000003611';
  await L.newGallery('Old', gid);
  await L.putPage(gid, 1, png(1));
  await L.flush();
  const old = /** @type {string} */ (await L.dirOf(gid));
  const rel = path.relative(A, old).split(path.sep).join('/');
  // This page's write of page 2 held as it writes the picture into the gallery's folder.
  const reached = gate(), go = gate();
  const undo = fsa.hold((call) => {
    if (call.op !== 'createWritable' || !call.path.startsWith(`${rel}/images/0002`)) return null;
    reached.open();
    return go.at;
  });
  t.after(undo);
  const stored = L.raw.pagePut(gid, 2, picture(2)).then(() => 'stored', (e) => e?.reason ?? String(e));
  await reached.at;
  undo();
  // The other page: the gallery deleted, made again under its id — with a page of its own, whose write waits for the
  // one under way here (the gallery's lock).
  await other.db.deleteGallery(gid);
  await other.db.metaPut({ galleryId: gid, title: title('Again') });
  const remade = other.db.pagePut(gid, 1, picture(9));
  go.open();
  await stored;
  await remade;
  await until(() => !fs.existsSync(old));   // the deleted one's folder deleted, by the other page
  for (const stage of ['checked', 'after a restart']) {
    if (stage === 'checked') { await L.scan(a); await L.flush(); } else await /** @type {() => Promise<void>} */ (L.restart)();
    assert.equal(await L.titleOf(gid), 'Again', `${stage}: the gallery made again`);
    assert.deepEqual((await L.raw.pageList(gid)).map((/** @type {any} */ p) => p.pageNum), [1], `${stage}: its own page alone`);
    assert.ok(same(await L.read(gid, 1), png(9)), `${stage}: its page`);
    const dir = await L.dirOf(gid);
    assert.ok(dir && path.resolve(dir) !== path.resolve(old) && fs.existsSync(dir), `${stage}: in a folder of its own, ${dir}`);
    assert.equal(fs.existsSync(old), false, `${stage}: the deleted one's folder is gone`);
    assert.deepEqual((await L.list()).flatMap(f => f.attention ?? []).map(x => `${x.reason} ${x.path}`), [], `${stage}: nothing reported`);
  }
});

for (const made of ['by this code', 'by v1.3.0']) {
  test(`a page stored in one page as another deletes its gallery and makes it again: nothing of it in the gallery made again (the browser's own storage; the gallery made ${made})`, { skip }, async (t) => {
    const L = await webLibrary();
    const other = await otherPage();
    t.after(async () => { other.close(); await L.close(); });
    const gid = made === 'by this code' ? '1790000003612' : '1790000003613';
    await L.newGallery('Old', gid);
    await L.putPage(gid, 1, png(1));
    if (made === 'by v1.3.0') await asV130(L.raw, gid);
    // This page's write of page 2 begun while another write of the gallery holds its lock.
    const letGo = await holdLock(gid);
    const stored = L.raw.pagePut(gid, 2, picture(2)).then(() => 'stored', (e) => e?.reason ?? String(e));
    await until(() => waiting(gid));
    // The other page: the gallery deleted, made again under its id with a page of its own.
    await other.db.deleteGallery(gid);
    await other.db.metaPut({ galleryId: gid, title: title('Again') });
    const remade = other.db.pagePut(gid, 1, picture(9));
    letGo();
    await stored;
    await remade;
    for (const stage of ['stored', 'after a restart']) {
      if (stage === 'after a restart') await /** @type {() => Promise<void>} */ (L.restart)();
      assert.equal(await L.titleOf(gid), 'Again', `${stage}: the gallery made again`);
      assert.deepEqual((await L.raw.pageList(gid)).map((/** @type {any} */ p) => p.pageNum), [1], `${stage}: its own page alone`);
      assert.ok(same(await L.read(gid, 1), png(9)), `${stage}: its page`);
      assert.equal((await L.raw.galleryGet(gid))?.count, 1, `${stage}: counted once`);
    }
  });
}

// The mark is this browser's own (db.js _born): what its folder's files say of the gallery, and what a backup or a library
// moved carries (transferRead, transferWrite), never has it; what writes the gallery again — its size measured, a
// publication, a move to another folder, a restore over it — keeps it; a gallery made again (restored after its
// deletion, joined from a copy by a check) is made with another.
test('the mark a gallery is made with is this browser\'s own: never in its folder\'s files or a bundle, kept by what writes it again, another for a gallery made again', { skip }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-pages-'));
  const L = await webLibrary();
  t.after(async () => { await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const [A, B, C] = ['A', 'B', 'C'].map((d) => path.join(base, d));
  const a = await L.add(A), b = await L.add(B);
  await L.setDefault(a);
  const gid = '1790000003630';
  await L.newGallery('Own', gid);
  await L.putPage(gid, 1, png(1));
  await L.flush();
  const mark = async () => (await L.raw.galleryGet(gid))?.born;
  const born = await mark();
  assert.match(String(born), /^[0-9a-f]{16}$/, 'made with a mark');
  const files = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.join(e.parentPath, e.name));
  const carrying = () => [A, B].filter(d => fs.existsSync(d)).flatMap(files).filter(f => fs.readFileSync(f).includes(String(born)));
  assert.deepEqual(carrying(), [], 'no file of its folder has it');
  assert.equal('born' in (await L.raw.transferRead(gid, { pages: false })).stat, false, 'a bundle has it not');
  await L.raw.refreshGallerySize(gid);
  assert.equal(await mark(), born, 'its size measured');
  await L.setTitle(gid, 'Own, renamed');
  await L.flush();
  assert.equal(await mark(), born, 'published');
  await L.move(gid, b);
  await L.flush();
  assert.equal(await mark(), born, 'moved to another folder');
  assert.deepEqual(carrying(), [], 'no file of its folder has it, moved');
  await L.raw.transferWrite(await L.raw.transferRead(gid), { silent: true });
  assert.equal(await mark(), born, 'restored over itself');
  const copy = path.join(C, 'Own (copy)');
  fs.cpSync(/** @type {string} */ (await L.dirOf(gid)), copy, { recursive: true });
  const whole = await L.raw.transferRead(gid);
  await L.deleteGallery(gid);
  await L.raw.transferWrite(whole, { silent: true });
  const restored = await mark();
  assert.ok(restored && restored !== born, 'restored once deleted: made again, with another mark');
  await L.deleteGallery(gid);
  await L.scan(await L.add(C));
  const joined = await mark();
  assert.ok(joined && joined !== born && joined !== restored, 'joined from a copy by a check: another');
});

// Nothing deleted: a write in each page, one waiting for the other — every page lands, the gallery made by this code or
// as v1.3.0 made it (its record without the mark), in a library folder or the browser's own storage.
for (const made of ['by this code', 'by v1.3.0']) {
  for (const where of ['a library folder', 'the browser\'s own storage']) {
    test(`a write in each page of a gallery nobody deletes: both land (${where}; the gallery made ${made})`, { skip }, async (t) => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-pages-'));
      const L = await webLibrary();
      const other = await otherPage();
      t.after(async () => { other.close(); await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
      if (where === 'a library folder') await L.setDefault(await L.add(path.join(base, 'A')));
      const gid = String(1790000003620 + (made === 'by this code' ? 0 : 2) + (where === 'a library folder' ? 0 : 1));
      await L.newGallery('Kept', gid);
      await L.putPage(gid, 1, png(1));
      await L.flush();
      if (made === 'by v1.3.0') await asV130(L.raw, gid);
      const letGo = await holdLock(gid);
      const here = L.raw.pagePut(gid, 2, picture(2));
      await until(() => waiting(gid));
      const there = other.db.pagePut(gid, 3, picture(3));
      letGo();
      await here;
      await there;
      await L.flush();
      assert.deepEqual((await L.raw.pageList(gid)).map((/** @type {any} */ p) => p.pageNum), [1, 2, 3], 'every page');
      for (const n of [1, 2, 3]) assert.ok(same(await L.read(gid, n), png(n)), `page ${n}`);
      assert.equal((await L.raw.galleryGet(gid))?.count, 3, 'counted');
    });
  }
}

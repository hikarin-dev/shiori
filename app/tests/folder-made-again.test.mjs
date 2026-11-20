// folder-made-again.test.mjs — S34 (review 11 A2), on both apps: a gallery deleted while its publication is under
// way, and a copy of it in another library folder joined under its id by a check meanwhile, then changed. The
// publication begun for the deleted gallery publishes nothing of the joined one — not into the deleted one's folder,
// nor its token as the joined one's — so the joined gallery keeps its change, in its own folder, after a flush and a
// restart; the deleted one's folder goes; nothing is reported. And a linked gallery read again by a check as it is
// deleted and made again (what the review didn't get to: S34 (6)). (The desktop's, and the review's other findings with a
// gallery made again: desktop/tests/made-again.test.mjs; every operation at every call: the sweeps' 'made again'.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopLibrary, webLibrary } from './library-drivers.mjs';
import { tokenOf } from '../js/storage/gallery-manifest.js';
import { zipCreate } from '../js/zip.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';

const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255, 1, 2, 3]);
const same = (a, b) => !!a && Buffer.from(a).equals(Buffer.from(b));
const skip = !!globalThis.__desktopLibrary && 'run by npm test';
const gate = () => { let open; const at = new Promise((resolve) => { open = resolve; }); return { at, open }; };
const manifestOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.shiori', 'gallery.json'), 'utf8'));

for (const app of /** @type {const} */ (['desktop', 'website'])) {
  test(`${app}: a copy joined under a deleted gallery's id while that one's publication is under way keeps its own change (11A2)`, { skip }, async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-again-'));
    const L = app === 'desktop' ? await desktopLibrary(path.join(base, 'desktop')) : await webLibrary();
    t.after(async () => { faults.reset(); await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
    const A = path.join(base, 'A'), C = path.join(base, 'C'), copy = path.join(C, 'Kept (copy)');
    const a = await L.add(A);
    await L.setDefault(a);
    const gid = '1790000003410';
    await L.newGallery('Kept', gid);
    await L.putPage(gid, 1, png(1));
    await L.flush();
    const old = /** @type {string} */ (await L.dirOf(gid));
    fs.cpSync(old, copy, { recursive: true });   // the person's copy, in a folder not the library's yet
    const c = await L.add(C);
    await L.setTitle(gid, 'Kept, renamed');
    // The desktop's check of C begun first, held past its deletions owed (a check begun after the deletion waits for
    // the deleted gallery's publication there: one deletion at a time), its walk held.
    let checked = null, walk = null;
    if (app === 'desktop') {
      const files = L.raw.files, past = gate();
      walk = gate();
      const apply = files.applyDeletions.bind(files);
      files.applyDeletions = (o = {}) => { const p = apply(o); if (o.root === c) { files.applyDeletions = apply; p.finally(past.open); } return p; };
      const held = faults.holdIn((call) => { if (call.op !== 'readdir' || path.resolve(call.path) !== path.resolve(C)) return null; held(); return walk.at; });
      checked = L.scan(c);
      await past.at;
    }
    // Its publication held as it opens its folder.
    const reached = gate(), go = gate();
    const store = app === 'desktop' ? L.raw.store : L.raw.folderStore;
    const opens = store.open;
    store.open = async (/** @type {any[]} */ ...args) => {
      if (app === 'website' && args[1]?.purpose !== 'publish') return opens.apply(store, args);
      store.open = opens;
      reached.open();
      await go.at;
      return opens.apply(store, args);
    };
    const published = app === 'desktop' ? L.raw.files.describe(gid) : L.raw.settleFolders();
    await reached.at;
    await L.deleteGallery(gid);
    if (app === 'desktop') { walk?.open(); await checked; } else await L.scan(c);
    assert.equal(await L.titleOf(gid), 'Kept', 'the copy joined under its id');
    await L.setTitle(gid, 'Joined, renamed');
    go.open();
    await published;
    for (const stage of ['flushed', 'after a restart']) {
      if (stage === 'flushed') { await L.flush(); if (app === 'desktop') await L.raw.files.applyDeletions(); }
      else await /** @type {() => Promise<void>} */ (L.restart)();
      assert.equal(await L.titleOf(gid), 'Joined, renamed', `${stage}: its change kept`);
      assert.ok(same(await L.read(gid, 1), png(1)), `${stage}: its page`);
      assert.equal(path.resolve(/** @type {string} */ (await L.dirOf(gid))), path.resolve(copy), `${stage}: kept in its own folder`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(copy, 'metadata.json'), 'utf8')).title.english, 'Joined, renamed', `${stage}: published there`);
      const stamp = app === 'desktop' ? L.raw.files._stamp(gid) : (await L.raw.galleryGet(gid))?.stamp;
      assert.equal(stamp, tokenOf(manifestOf(copy)), `${stage}: the token it keeps is its own folder's`);
      assert.equal(fs.existsSync(old), false, `${stage}: the deleted one's folder is gone`);
      assert.deepEqual((await L.list()).flatMap(f => f.attention ?? []).map(x => `${x.reason} ${x.path}`), [], `${stage}: nothing reported`);
    }
  });

  // S34 (6): a check reading again a linked ZIP changed in place (desktop linked.js linkRoot, the website's _relink), its
  // gallery deleted and made again under its id as the check reads the folder's overlays — past reading the galleries
  // it keeps there. It reads nothing for the gallery made again: neither the ZIP over it nor the deleted one's overlay
  // written again; nothing is reported.
  test(`${app}: a check reading again a linked ZIP changed in place reads nothing over a gallery made again under its id meanwhile`, { skip }, async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-again-'));
    const L = app === 'desktop' ? await desktopLibrary(path.join(base, 'desktop')) : await webLibrary();
    t.after(async () => { faults.reset(); fsa.reset(); await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
    const A = path.join(base, 'A'), zip = path.join(A, 'Pack.zip');
    fs.mkdirSync(A, { recursive: true });
    fs.writeFileSync(zip, zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }]));
    const a = await L.add(A);
    await L.setDefault(a);
    await L.scan(a);
    const gid = String((await L.galleries())[0]);
    const overlay = path.join(A, '.shiori', 'linked', gid);
    await L.putTranslation(gid, 1, png(3));
    await L.flush();
    assert.ok(fs.existsSync(overlay), 'its overlay');
    fs.writeFileSync(zip, zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(4) }, { name: '003.png', data: png(5) }]));
    // The check held as it lists the overlays it weighs the titles against (on the desktop, once it notes what was
    // removed there: a check's tidy-up lists them before it reads the galleries it keeps).
    const reached = gate(), go = gate();
    let armed = app === 'website';
    const overlays = (/** @type {{ op: string, path: string }} */ call) => {
      if (!armed || !['readdir', 'entries'].includes(call.op) || !/(^|\/)\.shiori\/linked$/.test(call.path)) return null;
      armed = false;
      reached.open();
      return go.at;
    };
    const undo = app === 'desktop' ? faults.holdIn(overlays) : fsa.hold(overlays);
    const folders = app === 'desktop' ? L.raw.folders : null, notes = folders?.publishRemoved;
    if (folders) folders.publishRemoved = (/** @type {any[]} */ ...args) => { folders.publishRemoved = notes; armed = true; return notes.apply(folders, args); };
    const checked = L.scan(a);
    await reached.at;
    undo();
    await L.deleteGallery(gid);
    await L.newGallery('Again', gid);
    await L.putPage(gid, 1, png(9));
    await Promise.race([L.flush(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    for (let i = 0; i < 60 && fs.existsSync(overlay); i++) await new Promise((resolve) => setTimeout(resolve, 50));   // the deleted one's overlay deleted
    go.open();
    await checked;
    for (const stage of ['flushed', 'after a restart']) {
      if (stage === 'flushed') { await L.flush(); if (app === 'desktop') await L.raw.files.applyDeletions(); }
      else await /** @type {() => Promise<void>} */ (L.restart)();
      assert.equal(await L.titleOf(gid), 'Again', `${stage}: the gallery made again`);
      assert.ok(same(await L.read(gid, 1), png(9)), `${stage}: its page`);
      const dir = path.resolve(/** @type {string} */ (await L.dirOf(gid)));
      assert.ok(dir.startsWith(A) && !dir.includes('.shiori'), `${stage}: in a folder of its own, ${dir}`);
      assert.equal(fs.existsSync(overlay), false, `${stage}: no overlay of it`);
      assert.deepEqual((await L.list()).flatMap(f => f.attention ?? []).map(x => `${x.reason} ${x.path}`), [], `${stage}: nothing reported`);
    }
  });
}

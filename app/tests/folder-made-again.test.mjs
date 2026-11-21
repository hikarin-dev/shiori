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

  // S35: the same check, its gallery deleted and made again while it writes the overlay's source.json again (the
  // sweeps' 'made again' met it under load alone, website, call 18). The deleted one's overlay is deleted once that
  // write is over, and takes what it wrote with it. Held here in the order that left it: the write in its midst (the
  // website's past its look at the file, as it writes; the desktop's as it makes the overlay's folder), the deletion's
  // removal of the overlay let run as far as it goes meanwhile — on the website to its last file, once it has deleted
  // the source.json the write replaces — then the write let go, then the deletion. Before S35 the website's write put
  // its source.json back after the deletion had deleted it, and the deletion, finding the overlay named, left it (its
  // note in removed.json, nothing to take it up again); the desktop's made the overlay's folder again over the deletion.
  test(`${app}: a deleted linked gallery's overlay goes once a check's write of it under way is over, with what it wrote`, { skip }, async (t) => {
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
    const overlay = path.join(A, '.shiori', 'linked', gid), source = path.join(overlay, 'source.json');
    await L.putTranslation(gid, 1, png(3));
    await L.flush();
    fs.writeFileSync(zip, zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(4) }]));
    const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const until = async (/** @type {() => boolean} */ ok, ms = 3000) => { for (let i = 0; i < ms / 20 && !ok(); i++) await sleep(20); };
    const written = gate(), write = gate(), reached = gate(), last = gate();
    let armed = true;
    const holds = (/** @type {{ op: string, path: string }} */ call) => {
      const at = call.path.split('\\').join('/');
      if (armed && (app === 'website' ? call.op === 'write' && at === `.shiori/linked/${gid}/source.json` : call.op === 'mkdir' && at.endsWith(`/.shiori/linked/${gid}`))) {
        armed = false;
        written.open();
        return write.at;
      }
      if (app === 'website' && call.op === 'removeEntry' && at === `.shiori/linked/${gid}/gallery.json`) { reached.open(); return last.at; }
      return null;
    };
    const undo = app === 'desktop' ? faults.holdIn(holds) : fsa.hold(holds);
    t.after(undo);
    const checked = L.scan(a);
    await written.at;
    await L.deleteGallery(gid);
    const remade = (async () => { await L.newGallery('Again', gid); await L.putPage(gid, 1, png(9)); })();
    // The deletion's removal as far as it goes while the write is held — or, as it waits for the write, a moment.
    await Promise.race([app === 'website' ? reached.at : until(() => !fs.existsSync(overlay)), sleep(1500)]);
    write.open();
    if (app === 'website') { await until(() => !fs.existsSync(`${source}.crswap`)); last.open(); }   // the write over, its file in place
    await remade;
    await checked;
    for (const stage of ['flushed', 'after a restart']) {
      if (stage === 'flushed') { await L.flush(); if (app === 'desktop') await L.raw.files.applyDeletions(); }
      else await /** @type {() => Promise<void>} */ (L.restart)();
      await until(() => !fs.existsSync(overlay));
      assert.equal(fs.existsSync(overlay), false, `${stage}: the deleted one's overlay is gone, ${fs.existsSync(overlay) ? fs.readdirSync(overlay, { recursive: true }).join(', ') : ''}`);
      assert.equal(await L.titleOf(gid), 'Again', `${stage}: the gallery made again`);
      assert.ok(same(await L.read(gid, 1), png(9)), `${stage}: its page`);
      const dir = path.resolve(/** @type {string} */ (await L.dirOf(gid)));
      assert.ok(dir.startsWith(A) && !dir.includes('.shiori'), `${stage}: in a folder of its own, ${dir}`);
      assert.deepEqual((await L.list()).flatMap(f => f.attention ?? []).map(x => `${x.reason} ${x.path}`), [], `${stage}: nothing reported`);
    }
  });
}

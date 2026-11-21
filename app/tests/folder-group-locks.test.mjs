// folder-group-locks.test.mjs — S37 (review 12): a series command over a linked gallery whose source then changed in
// place and a gallery another app published since. The publication of one of them weighs the command as one
// (db.js _weighGroup): the other's place holds another writer's publication, so the folder's version stands for the
// whole command (folder-library.js folderStands and its others) — and the re-read of the linked gallery writes its
// overlay's source.json under that gallery's lock (S35). On the website that publication held the linked gallery's
// lock already: it waited for itself, for good (F1) — by the command's own publication a few seconds later, by
// settleFolders, by a check (_relink → describe), whose folder then took no check again either; with two linked
// galleries each publication held its own lock and waited for the other's (F2). And a gallery of the command whose
// re-read couldn't be made then (its overlay unreadable for a moment, its lock busy) was passed over and published its
// part of the command alone later (S37: the drop of a command is all or nothing). Both apps through the drivers where
// the scenario can be said for both (the desktop has no locks; its group's drop is the same rule).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopLibrary, webLibrary } from './library-drivers.mjs';
import { zipCreate } from '../js/zip.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { netWatched } from './lock-net.mjs';

const skip = !!globalThis.__desktopLibrary && 'run by npm test';
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255, 1, 2, 3]);
const same = (a, b) => !!a && Buffer.from(a).equals(Buffer.from(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([Promise.resolve(p).then(() => 'ended', (e) => `failed: ${e?.message || e}`), sleep(ms).then(() => `still waiting after ${ms} ms`)]);
const gate = () => { let open; const at = new Promise((resolve) => { open = resolve; }); return { at, open }; };
const zipOf = (n) => zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(n) }]);
// Another writer's later generation over this app's manifest at gallery place `dir` (an overlay's at its top, a
// folder's in its .shiori/), as a publication of the other app's lands.
const theirs = (dir) => {
  const file = [path.join(dir, 'gallery.json'), path.join(dir, '.shiori', 'gallery.json')].find((f) => fs.existsSync(f)) ?? '';
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...m, generation: m.generation + 1, publication: 'f0e1d2c3b4a59687', writer: 'b1b2c3d4e5f60708' }, null, 2));
};
const overlay = (A, gid) => path.join(A, '.shiori', 'linked', gid);
const placeOf = async (L, A, gid, linked) => (linked ? overlay(A, gid) : /** @type {string} */ (await L.dirOf(gid)));
const metaThere = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));

/** Folder A with Pack.zip (`x`, linked, a page translated) and the other gallery `m` — one of the library's own
 * (`other: 'own'`) or a second linked ZIP — published; then the series command over both (`x` its owner, `m` its
 * chapter), Pack.zip changed in place, and `m`'s place given another writer's generation — unless the controls say
 * otherwise (`grouped` false: each retitled alone; `changed` false: the ZIP as it was; `both`: both linked, both
 * changed, both places another writer's). */
async function made(t, app, { other = 'own', grouped = true, changed = true, both = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s37-'));
  const L = app === 'desktop' ? await desktopLibrary(path.join(base, 'desktop')) : await webLibrary();
  t.after(async () => { faults.reset(); fsa.reset(); await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
  // What the lock net sees collected and failed on as the test ends: a chain waiting for itself never ends, and the
  // other chain's wait would land after a throw cut the test short (lock-net.mjs watch).
  netWatched(t, assert);
  const A = path.join(base, 'A');
  fs.mkdirSync(A, { recursive: true });
  fs.writeFileSync(path.join(A, 'Pack.zip'), zipOf(2));
  const a = await L.add(A);
  await L.setDefault(a);
  await L.scan(a);
  const x = String((await L.galleries())[0]);
  let m;
  if (other === 'own' && !both) {
    m = await L.newGallery('Own');
    await L.putPage(m, 1, png(7));
  } else {
    fs.writeFileSync(path.join(A, 'Second.zip'), zipOf(12));
    await L.scan(a);
    m = String((await L.galleries()).map(String).find(g => g !== x));
  }
  const mLinked = other !== 'own' || both;
  await L.putTranslation(x, 1, png(3));
  if (mLinked) await L.putTranslation(m, 1, png(13));   // (an overlay of its own, published)
  await L.flush();
  if (grouped) await L.raw.seriesCommand('attach', x, m);
  else { await L.setTitle(x, 'Pack, retitled'); await L.setTitle(m, 'Other, retitled'); }
  if (changed) fs.writeFileSync(path.join(A, 'Pack.zip'), zipOf(4));
  if (changed && both) fs.writeFileSync(path.join(A, 'Second.zip'), zipOf(14));
  theirs(await placeOf(L, A, m, mLinked));
  if (both) theirs(overlay(A, x));
  return { L, a, A, x, m, mLinked };
}
// The command dropped whole: neither gallery is in a series, here or in its folder.
async function droppedWhole(c, { x = c.x, m = c.m } = {}) {
  assert.ok(!(await c.L.meta(x))?.chapters?.length, 'the owner\'s part of the command dropped here');
  assert.ok(!(await c.L.meta(m))?.parentId, 'the chapter\'s part of the command dropped here');
  assert.ok(!metaThere(await placeOf(c.L, c.A, m, c.mLinked)).parentId, 'and not published there');
}
// What the website has due for the galleries (their sizes, their publications) over.
async function nothingDue(L, gids) {
  for (let i = 0; i < 400 && gids.some((g) => L.raw.galleryBusy(g)); i++) await sleep(25);
}

const WAYS = {
  // The command's own publication, a few seconds later (the website's: its changes published once they rest).
  'the command\'s own publication': { apps: ['website'], run: () => sleep(7000) },
  'what waits settled': { apps: ['desktop', 'website'], run: (c) => (c.L.app === 'website' ? c.L.raw.settleFolders() : c.L.flush()) },
  'a check': { apps: ['desktop', 'website'], run: (c) => c.L.scan(c.a) },
};
for (const [way, { apps, run }] of Object.entries(WAYS)) {
  for (const app of apps) {
    test(`S37 F1: ${app}: ${way}, a series command over a linked gallery changed in place and a gallery another app published since, ends — and the gallery takes a write again`, { skip, todo: app === 'website' ? 'S37' : undefined }, async (t) => {
      const c = await made(t, app);
      assert.equal(await within(run(c), 12000), 'ended', `${way}: ended`);
      assert.equal(await within(c.L.putTranslation(c.x, 2, png(9)), 10000), 'ended', 'a later write of the linked gallery ends');
      if (way === 'a check') assert.equal(await within(c.L.scan(c.a), 10000), 'ended', 'the folder\'s next check ends');
      assert.equal(await within(c.L.flush(), 12000), 'ended', 'what waits settled');
      await droppedWhole(c);
      assert.ok(same(await c.L.read(c.x, 1), png(1)) && same(await c.L.read(c.x, 2), png(4)), 'the linked gallery reads its ZIP as it is now');
    });
    for (const control of ['the source not changed', 'no series command']) {
      test(`S37 F1, control: ${app}: ${way}, ${control}: ends`, { skip }, async (t) => {
        const c = await made(t, app, control === 'no series command' ? { grouped: false } : { changed: false });
        assert.equal(await within(run(c), 12000), 'ended', `${way}: ended`);
        assert.equal(await within(c.L.putTranslation(c.x, 2, png(9)), 10000), 'ended', 'a later write of the linked gallery ends');
      });
    }
  }
}

// F2: two linked galleries of one command, each changed in place, each place another writer's; their two
// publications under way at once — each held where it holds its own gallery's lock and is about to ask for the
// other's (its read of the other's overlay), let go once both are there.
for (const app of ['desktop', 'website']) {
  test(`S37 F2: ${app}: the two publications of one series command, each meeting the other's place another writer's, both end — and each gallery takes a write again`, { skip, todo: app === 'website' ? 'S37' : undefined }, async (t) => {
    const c = await made(t, app, { both: true });
    const there = gate(), go = gate();
    const reached = new Set();
    // Each publication's first look at the other's overlay (the website: weighing the command, its own lock held).
    const at = (gid) => path.relative(c.A, overlay(c.A, gid)).split(path.sep).join('/');
    const held = (gid, p) => {
      if (reached.has(gid) || !p.startsWith(`${at(gid)}/`)) return null;
      reached.add(gid);
      if (reached.size === 2) there.open();
      return go.at;
    };
    if (app === 'website') fsa.hold((call) => (call.op === 'getFile' ? held(call.path.includes(c.x) ? c.x : c.m, call.path) : null));
    else faults.holdIn((call) => (call.op === 'readFile' ? held(call.path.includes(c.x) ? c.x : c.m, path.relative(c.A, call.path).split(path.sep).join('/')) : null));
    const both = app === 'website' ? sleep(0) : Promise.all([c.L.raw.files.describe(c.x), c.L.raw.files.describe(c.m)]);
    assert.equal(await within(there.at, 20000), 'ended', 'both publications under way at once');
    go.open();
    assert.equal(await within(both, 12000), 'ended', 'both publications ended');
    if (app === 'website') await nothingDue(c.L, [c.x, c.m]);
    for (const g of [c.x, c.m]) assert.equal(await within(c.L.putTranslation(g, 2, png(20)), 10000), 'ended', `a later write of ${g} ends`);
    assert.equal(await within(c.L.flush(), 12000), 'ended', 'what waits settled');
    await droppedWhole(c);
  });
}

// The drop is whole: the gallery whose own work meets another writer's publication stands by the folder's version,
// the command's other gallery with it — also where that one can't be read again at that moment (its overlay's read
// failing once; on the website, its lock held by a write of its own under way). Its part of the command is never
// published alone: it stands by the folder's version under its own lock before anything of it is.
for (const app of ['desktop', 'website']) {
  for (const why of ['its overlay unreadable for a moment', ...(app === 'website' ? ['its lock held by a write of its own'] : [])]) {
    test(`S37: ${app}: a series command's drop is whole — the other gallery, ${why} as the first stands, isn't published alone`, { skip, todo: 'S37' }, async (t) => {
      // The own gallery another writer published (its work meets that); the linked one, changed in place, the other.
      const c = await made(t, app);
      const own = c.m, linked = c.x;
      let release = async () => {};
      let failed = 0, readable = () => {};
      if (why.startsWith('its overlay')) {
        // Every read of the linked gallery's overlay fails while the own gallery's work runs.
        const p = `${path.relative(c.A, overlay(c.A, linked)).split(path.sep).join('/')}/`;
        const count = (yes) => { if (yes) failed++; return yes; };
        readable = app === 'website' ? fsa.failNext((call) => count(call.op === 'getFile' && call.path.startsWith(p)), 'NotReadableError', { times: Infinity })
          : faults.failNext((call) => count(call.op === 'readFile' && path.relative(c.A, call.path).split(path.sep).join('/').startsWith(p)), 'EIO', { times: Infinity });
      } else {
        // A translation of the linked gallery being stored, held at its picture's write: its lock held.
        const p = `${path.relative(c.A, overlay(c.A, linked)).split(path.sep).join('/')}/translated/`;
        const go = gate(), reached = gate();
        const undo = fsa.hold((call) => (call.op === 'createWritable' && call.path.startsWith(p) ? (undo(), reached.open(), go.at) : null));
        const writing = c.L.putTranslation(linked, 1, png(30));
        await within(reached.at, 10000);
        release = async () => { go.open(); await writing; };
      }
      // The own gallery's own work meets the other writer's publication: a translation of it stored.
      assert.equal(await within(c.L.putTranslation(own, 1, png(31)), 10000), 'ended', 'its own work ends');
      readable();
      if (why.startsWith('its overlay')) assert.ok(failed >= 1, 'the other\'s overlay failed to read as the first stood');
      await release();
      assert.equal(await within(c.L.flush(), 12000), 'ended', 'what waits settled');
      await droppedWhole(c);
      assert.ok(!metaThere(overlay(c.A, linked)).chapters?.length, 'the linked gallery\'s part not published alone');
    });
  }
}

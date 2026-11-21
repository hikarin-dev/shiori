// folder-group-seen.test.mjs — S39 (the coordinator's reading of S38, review 14): a gallery left to stand by its series
// command's drop is never worse off than one that isn't. What the place shows decides: a manifest seen by the look that
// asked a moment ago and not found by its re-read concludes nothing (the one guard left — whatever this library's stamp
// says); a linked gallery left to stand with nothing to read its pages from is settled, as one not left to stand in
// that state is published; the tidy a stand or a settlement does for other galleries can't fail it (a gallery of the
// series in a folder hidden or another app's); and on the desktop one gallery stands once at a time. Both apps through
// the drivers, where the scenario can be said for both.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopLibrary, webLibrary } from './library-drivers.mjs';
import { v1Gallery } from './fixtures/storage-fixtures.mjs';
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
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const manifestAt = (dir) => [path.join(dir, 'gallery.json'), path.join(dir, '.shiori', 'gallery.json')].find((f) => fs.existsSync(f)) ?? null;
// Another writer's later generation over the manifest at gallery place `dir` (as a publication of theirs lands).
const theirs = (dir) => {
  const file = /** @type {string} */ (manifestAt(dir));
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...m, generation: m.generation + 1, publication: 'f0e1d2c3b4a59687', writer: 'b1b2c3d4e5f60708' }, null, 2));
};
const metaThere = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));

async function records(L) {
  if (L.app === 'desktop') {
    const rows = L.raw._s('SELECT gid, grp, dropped FROM together').all();
    return { grouped: rows.map(r => String(r.gid)), flagged: rows.filter(r => r.dropped).map(r => String(r.gid)), waiting: L.raw._s('SELECT gid FROM files WHERE pending = 1').all().map(r => String(r.gid)) };
  }
  const idb = await L.raw.openDB();
  return new Promise((resolve) => {
    const tx = idb.transaction(['folders', 'undescribed'], 'readonly');
    const g = tx.objectStore('folders').getAll(IDBKeyRange.bound('$group:', '$group:￿'));
    const u = tx.objectStore('undescribed').getAllKeys();
    tx.oncomplete = () => resolve({ grouped: g.result.map(r => String(r.gid)), flagged: g.result.filter(r => r.drop).map(r => String(r.gid)), waiting: u.result.map(String) });
  });
}
async function contradicted(L, gids) {
  const out = [];
  for (const g of gids) {
    const m = await L.meta(g);
    for (const c of m?.chapters ?? []) {
      if (String(c.id) === g) continue;
      const cm = await L.meta(String(c.id));
      if (cm && String(cm.parentId ?? '') !== g) out.push(`${g} lists ${c.id}, which names ${cm.parentId ?? 'no series'}`);
    }
    if (m?.parentId) {
      const om = await L.meta(String(m.parentId));
      if (om && !om.chapters?.some(c => String(c.id) === g)) out.push(`${g} names ${m.parentId}, which doesn't list it`);
    }
  }
  return out;
}
// This library's stamp of gallery `gid`, read or set.
async function stampOf(L, gid, set) {
  if (L.app === 'desktop') {
    if (set !== undefined) L.raw._s('UPDATE stamps SET stamp = ? WHERE gid = ?').run(set, String(gid));
    return L.raw.files._stamp(gid);
  }
  const idb = await L.raw.openDB();
  return new Promise((resolve) => {
    const tx = idb.transaction('galleries', 'readwrite');
    const s = tx.objectStore('galleries');
    const q = s.get(String(gid));
    q.onsuccess = () => { if (set !== undefined) s.put({ ...q.result, stamp: set }); };
    tx.oncomplete = () => resolve(set ?? q.result?.stamp ?? null);
  });
}
// The re-read of gallery place `dir` (a stand's, or a check's: its first listing of the folder, from the function that
// reads a gallery's folder — the website's folder-library.js _readDir, the desktop's folder-store.js readGallery —
// told by the call's stack), held: resolves { reached, go } — `reached` once it is held, `go()` to let it on.
function holdReread(L, A, dir) {
  const d = rel(A, dir), by = L.app === 'website' ? '_readDir' : 'readGallery';
  const reached = gate(), go = gate();
  let done = false;
  const look = (op, p) => {
    if (done || !['entries', 'readdir'].includes(op) || p !== d || !new Error().stack.includes(by)) return null;
    done = true;
    reached.open();
    return go.at;
  };
  if (L.app === 'website') fsa.hold((call) => look(call.op, call.path));
  else faults.holdIn((call) => look(call.op, rel(A, call.path)));
  return { reached: reached.at, go: go.open };
}

async function library(t, app) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s39-'));
  const L = app === 'desktop' ? await desktopLibrary(path.join(base, 'desktop')) : await webLibrary();
  t.after(async () => { faults.reset(); fsa.reset(); await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
  netWatched(t, assert);
  return { L, base };
}

// 1. The guard left: a manifest the hold's first look saw (another writer's), not found by its re-read a moment later,
// concludes nothing — whatever this library's stamp says; the manifest back, it stands and its command drops whole.
for (const app of ['desktop', 'website']) {
  for (const stamp of ['a manifest\'s', 'an earlier version\'s']) {
    test(`S39 1: ${app}: a hold that saw another writer's publication, its re-read finding no manifest a moment later, concludes nothing — this library's stamp ${stamp}`, { skip }, async (t) => {
      const { L, base } = await library(t, app);
      const A = path.join(base, 'A');
      fs.mkdirSync(A, { recursive: true });
      const o = String((await v1Gallery(path.join(A, 'Old'), { files: true })).gid);
      const a = await L.add(A);
      await L.setDefault(a);
      await L.scan(a);
      const earlier = await stampOf(L, o);
      await L.setTitle(o, 'Old, published');   // published by this library: a manifest of its own there
      const m = await L.newGallery('Own');
      await L.putPage(m, 1, png(7));
      await L.flush();
      const dir = /** @type {string} */ (await L.dirOf(o));
      theirs(dir);   // the other writer's publication of it since
      if (stamp === 'an earlier version\'s') await stampOf(L, o, earlier);   // known to this library only as the earlier version had it
      await L.setTitle(o, 'Old, changed here');
      await L.raw.seriesCommand('attach', o, m);
      const file = /** @type {string} */ (manifestAt(dir)), away = `${file}.away`;
      const held = holdReread(L, A, dir);
      const work = L.putTranslation(o, 1, png(30));   // its own work holds its place: another writer's
      assert.equal(await within(held.reached, 15000), 'ended', 'its re-read under way');
      fs.renameSync(file, away);   // not found by the re-read
      held.go();
      await within(work, 15000);
      const r = await records(L);
      assert.ok(r.grouped.includes(o) && r.grouped.includes(m), 'its group as it was');
      assert.ok(r.waiting.includes(o), 'nothing of it dropped');
      assert.equal(await L.titleOf(o), 'Old, changed here');
      assert.ok(!fs.existsSync(file), 'nothing published over its place');
      fs.renameSync(away, file);
      assert.equal(await within(L.scan(a), 15000), 'ended', 'a check, the manifest back');
      assert.equal(await within(L.flush(), 15000), 'ended');
      if (app === 'website') await sleep(6500);
      assert.equal(await within(L.flush(), 15000), 'ended');
      const after = await records(L);
      assert.deepEqual(after.flagged, [], 'nothing left to stand');
      assert.ok(!after.grouped.includes(o) && !after.grouped.includes(m), 'its command weighed and dropped');
      assert.equal(await L.titleOf(o), 'Old, published', 'whole: the folder\'s version stands');
      assert.ok(!(await L.meta(m))?.parentId, 'and the other gallery\'s part with it');
    });
  }
}

// 1, the desktop's check: its re-read of a gallery whose token read named a manifest, finding none, answers 'unreadable'
// — never 'unversioned'.
test('S39 1: desktop: a check\'s re-read finding no manifest where its token read named one answers \'unreadable\', never \'unversioned\'', { skip }, async (t) => {
  const { L, base } = await library(t, 'desktop');
  const A = path.join(base, 'A');
  fs.mkdirSync(A, { recursive: true });
  const o = String((await v1Gallery(path.join(A, 'Old'), { files: true })).gid);
  const a = await L.add(A);
  await L.setDefault(a);
  await L.scan(a);
  const earlier = await stampOf(L, o);
  await L.setTitle(o, 'Old, published');
  await L.flush();
  const dir = /** @type {string} */ (await L.dirOf(o));
  theirs(dir);
  await stampOf(L, o, earlier);
  const file = /** @type {string} */ (manifestAt(dir)), away = `${file}.away`;
  const held = holdReread(L, A, dir);
  const check = L.scan(a);
  assert.equal(await within(held.reached, 15000), 'ended', 'its re-read under way');
  fs.renameSync(file, away);
  held.go();
  const found = await check;
  fs.renameSync(away, file);
  assert.deepEqual(found.problems.filter(p => p.reason !== 'unreadable').map(p => `${p.path}: ${p.reason}`), [], 'only \'unreadable\'');
});

// 2. A linked gallery left to stand with nothing to read its pages from (its ZIP gone as the drop lands) is settled, as
// one not left to stand in that state is published: never held for good, nor a later command over it with it.
for (const app of ['desktop', 'website']) {
  test(`S39 2: ${app}: a linked gallery left to stand whose ZIP is gone isn't held for good — a later series command over it and a healthy gallery is published`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const A = path.join(base, 'A'), zip = path.join(A, 'Pack.zip');
    fs.mkdirSync(A, { recursive: true });
    fs.writeFileSync(zip, zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }]));
    const a = await L.add(A);
    await L.setDefault(a);
    await L.scan(a);
    const x = String((await L.galleries())[0]);
    await L.putTranslation(x, 1, png(3));   // its overlay published: a version of this library's own
    const m = await L.newGallery('Own');
    await L.putPage(m, 1, png(7));
    const h = await L.newGallery('Healthy');
    await L.putPage(h, 1, png(8));
    await L.flush();
    await L.raw.seriesCommand('attach', x, m);
    theirs(/** @type {string} */ (await L.dirOf(m)));
    fs.rmSync(zip);   // the source gone as the drop lands
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (app === 'website') await sleep(6500);
    assert.equal(await within(L.flush(), 15000), 'ended');
    assert.ok(!(await records(L)).flagged.includes(x), 'not left to stand for good');
    await L.raw.seriesCommand('attach', x, h);
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (app === 'website') await sleep(6500);
    assert.equal(await within(L.flush(), 15000), 'ended');
    assert.equal(String(metaThere(/** @type {string} */ (await L.dirOf(h))).parentId ?? ''), x, 'the healthy gallery\'s part published');
    assert.deepEqual((await records(L)).flagged, []);
  });
}

// 3. The tidy after a stand can't fail it: a series across two folders (owner in A, chapter in B), the chapter's place
// another writer's, A hidden or another app's as the chapter stands — its hold, its publication and B's check end as
// with A there; once A is back and checked, nothing left to stand, nothing waiting, no link contradicted.
for (const app of ['desktop', 'website']) {
  for (const away of ['hidden', 'another app\'s']) {
    test(`S39 3: ${app}: a chapter standing while its series' owner's folder is ${away} — the tidy can't fail its stand, and the end is the same once the folder is back`, { skip }, async (t) => {
      const { L, base } = await library(t, app);
      const A = path.join(base, 'A'), B = path.join(base, 'B');
      fs.mkdirSync(A, { recursive: true });
      fs.mkdirSync(B, { recursive: true });
      const a = await L.add(A), b = await L.add(B);
      await L.setDefault(a);
      const o = await L.newGallery('Owner');
      await L.putPage(o, 1, png(1));
      await L.setDefault(b);
      const c = await L.newGallery('Chapter');
      await L.putPage(c, 1, png(2));
      await L.flush();
      // (The desktop: every hold of the chapter from here on recorded — its own publication's, the check's.)
      const answers = [];
      if (app === 'desktop') {
        const files = L.raw.files, hold = files.hold.bind(files);
        files.hold = async (gid, ...rest) => { const r = await hold(gid, ...rest); if (String(gid) === c) answers.push(r.kind); return r; };
        t.after(() => { delete files.hold; });
      }
      await L.raw.seriesCommand('attach', o, c);
      theirs(/** @type {string} */ (await L.dirOf(c)));
      if (away === 'hidden') await L.hide(a);
      else {
        await L.takeOver(a);
        if (app === 'desktop') {
          await L.raw.folders.probe(a, { fresh: true });
          for (let i = 0; i < 100 && !L.raw.folders.heldElsewhere(a, { read: true }); i++) await sleep(20);
        }
      }
      if (app === 'desktop') {
        // The chapter stands — at its own publication or B's check, whichever holds it first: never 'unreadable' for the
        // tidy's sake.
        assert.equal(await within(L.scan(b), 15000), 'ended', 'B\'s check ends');
        assert.equal(await within(L.flush(), 15000), 'ended', 'what waits of it settled');
        assert.ok(answers.length && !answers.includes('unreadable'), `the chapter's holds: ${answers.join(', ')}`);
        const r = await records(L);
        assert.ok(!(await L.meta(c))?.parentId, 'the chapter stood by its folder\'s version');
        assert.ok(!r.waiting.includes(c) && !r.grouped.includes(c), 'nothing of it left waiting or grouped');
      } else {
        // (The website's publication of the owner goes on in a hidden folder — what was committed before is published
        // there — and stands the chapter; with A another app's the command waits for it: the gates' own difference.)
        assert.equal(await within(L.raw.settleFolders(), 15000), 'ended', 'what waits settled');
      }
      // A back.
      if (away === 'hidden') await L.show(a);
      else assert.equal(await L.raw.folderClaim(a), 'granted');
      assert.equal(await within(L.flush(), 20000), 'ended');
      assert.equal(await within(L.scan(a), 15000), 'ended');
      assert.equal(await within(L.flush(), 15000), 'ended');
      if (app === 'website') await sleep(6500);
      assert.equal(await within(L.flush(), 15000), 'ended');
      const end = await records(L);
      assert.deepEqual(end.flagged, [], 'nothing left to stand');
      assert.deepEqual(end.waiting.filter(g => [o, c].includes(g)), [], 'nothing waiting');
      assert.deepEqual(await contradicted(L, [o, c]), [], 'no link the galleries contradict');
    });
  }
}

// 5. The desktop stands one gallery once at a time: two holds of one gallery whose place is another writer's at once (a
// check's, and another gallery's weighing of its command) — one stand; a change the person makes once it stood stays.
test('S39 5: desktop: two holds of one gallery another writer published, at once, stand it once — a change made once it stood isn\'t dropped', { skip }, async (t) => {
  const { L, base } = await library(t, 'desktop');
  const A = path.join(base, 'A');
  fs.mkdirSync(A, { recursive: true });
  const a = await L.add(A);
  await L.setDefault(a);
  const x = await L.newGallery('First');
  await L.putPage(x, 1, png(1));
  const y = await L.newGallery('Second');
  await L.putPage(y, 1, png(2));
  await L.flush();
  await L.raw.seriesCommand('attach', x, y);
  theirs(/** @type {string} */ (await L.dirOf(y)));
  // Every stand of y counted; the first held until a second is under way too (or a moment has passed), the second
  // until the test lets it on.
  const files = L.raw.files, lib = L.raw;
  const stands = lib._folderStands.bind(lib);
  let n = 0;
  const second = gate(), firstDone = gate(), go = gate();
  lib._folderStands = async (gid, ...rest) => {
    if (String(gid) !== y) return stands(gid, ...rest);
    const k = ++n;
    if (k === 1) { await Promise.race([second.at, sleep(3000)]); try { return await stands(gid, ...rest); } finally { firstDone.open(); } }
    second.open();
    await go.at;
    return stands(gid, ...rest);
  };
  const both = Promise.all([L.scan(a), files.describe(x)]);
  assert.equal(await within(firstDone.at, 15000), 'ended', 'it stood');
  await L.setTitle(y, 'Second, changed since');   // the person's change, once it stood
  go.open();
  assert.equal(await within(both, 15000), 'ended');
  assert.equal(n, 1, 'stood once');
  assert.equal(await L.titleOf(y), 'Second, changed since', 'the change made since stays');
});

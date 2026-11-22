// folder-s42.test.mjs — S42 (review 17 of S41): a settle acts only for the command it weighed, a check never waits on
// another folder's drive, a folder's removal gives no deletion up, and a publication dropped as it landed is published
// again. Both apps through the drivers.
//   A. a settle acts only for the command it weighed: a command made between a settle's weighing and its own hold is
//      none of that settle's (nothing of it placed, moved or published by it); the "weighed whole" window is opened
//      only by a real weighing, never carried forward from member to member (and S38 (c),
//      folder-group-settle.test.mjs: the dropped series' folder never made);
//   B. a check reads only the drive of the folder it checks: folder B's drive not answering, folder A's checks and a
//      publication in A end, with no call on B — with and without a deletion waiting `unfound`; on the website a folder
//      whose permission waits to be asked again still counts for such a deletion;
//   C. a folder's removal gives no deletion up: it rules its own folder out, as its whole look does, and no more;
//   D. a publication dropped as it landed is published again: the folder says what the library says.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopLibrary, webLibrary, clockAhead } from './library-drivers.mjs';
import { tokenOf } from '../js/storage/gallery-manifest.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { netWatched } from './lock-net.mjs';

const skip = !!globalThis.__desktopLibrary && 'run by npm test';
const APPS = ['desktop', 'website'];
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255, 1, 2, 3]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([Promise.resolve(p).then(() => 'ended', (e) => `failed: ${e?.message || e}`), sleep(ms).then(() => `still waiting after ${ms} ms`)]);
const gate = () => { let open; const at = new Promise((resolve) => { open = resolve; }); return { at, open }; };
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const inside = (root, abs) => { const r = path.relative(path.resolve(root), path.resolve(abs)); return !r.startsWith('..') && !path.isAbsolute(r); };
const NEVER = new Promise(() => {});
const manifestAt = (dir) => [path.join(dir, 'gallery.json'), path.join(dir, '.shiori', 'gallery.json')].find((f) => fs.existsSync(f)) ?? null;
const manifestOf = (dir) => { const f = manifestAt(dir); return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const genAt = (dir) => manifestOf(dir)?.generation ?? null;
const metaThere = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
const theirs = (dir) => {
  const file = /** @type {string} */ (manifestAt(dir));
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...m, generation: m.generation + 1, publication: 'f0e1d2c3b4a59687', writer: 'b1b2c3d4e5f60708' }, null, 2));
};
// A series link of record `meta`: its owner, or the chapters it lists (but itself).
const linksOf = (meta) => [...(meta?.parentId ? [`owner ${meta.parentId}`] : []), ...(meta?.chapters ?? []).filter(c => String(c.id) !== String(meta.galleryId)).map(c => `chapter ${c.id}`)];

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
// The deletions this library still owes: [{ gid, unfound }].
async function owed(L) {
  if (L.app === 'desktop') return L.raw._s('SELECT gid, unfound FROM deleting').all().map(d => ({ gid: String(d.gid), unfound: !!d.unfound }));
  const idb = await L.raw.openDB();
  return new Promise((resolve) => {
    const tx = idb.transaction(['folders'], 'readonly');
    const q = tx.objectStore('folders').getAll(IDBKeyRange.bound('$deleting:', '$deleting:￿'));
    tx.oncomplete = () => resolve(q.result.map(d => ({ gid: String(d.gid), unfound: !!d.unfound })));
  });
}
const stampOf = async (L, gid) => (L.app === 'desktop' ? L.raw.files._stamp(gid) : (await L.raw.galleryGet(gid))?.stamp) ?? null;
const listed = async (L, gid) => (await L.galleries()).map(String).includes(String(gid));
async function library(t, app) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s42-'));
  const L = app === 'desktop' ? await desktopLibrary(path.join(base, 'desktop')) : await webLibrary();
  t.after(async () => { faults.reset(); fsa.reset(); await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
  netWatched(t, assert);
  return { L, base };
}
async function folders(L, base, ...names) {
  const out = {};
  for (const n of names) { out[n] = path.join(base, n); fs.mkdirSync(out[n], { recursive: true }); out[n.toLowerCase()] = await L.add(out[n]); }
  return out;
}
async function until(cond, ms = 10000) { for (let i = 0; i < ms / 50 && !(await cond()); i++) await sleep(50); return cond(); }
// What waits written, then the library quiet a moment (the change revision unchanged over three looks a second apart).
async function quiet(L) {
  let last = -1, same = 0;
  for (let i = 0; i < 60 && same < 3; i++) {
    assert.equal(await within(L.flush(), 15000), 'ended');
    const now = Number(await L.raw.changeRevision());
    same = now === last ? same + 1 : 0;
    last = now;
    await sleep(1000);
  }
}
async function rounds(L, ids, n = 2) {
  for (let i = 0; i < n; i++) {
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (L.app === 'website') await sleep(6500);
    for (const id of ids) assert.equal(await within(L.scan(id), 20000), 'ended');
    assert.equal(await within(L.flush(), 15000), 'ended');
  }
}
// Every file call on library folder `dir` seen from now on (`calls`), and — `hang` — never answered, as a drive that
// stopped answering: the website's every call there, the desktop's every promised one (a synchronous call can't wait;
// it is seen all the same).
function drive(L, dir, { hang = false } = {}) {
  const calls = [];
  if (L.app === 'website') {
    fsa.onCall((call, root) => { if (path.resolve(root) === path.resolve(dir)) calls.push(`${call.op} ${call.path}`); });
    if (hang) fsa.hang((call, root) => path.resolve(root) === path.resolve(dir));
  } else {
    faults.failNext((call) => { if (inside(dir, call.path)) calls.push(`${call.op} ${rel(dir, call.path)}`); return false; }, 'EIO', { times: Infinity });
    if (hang) faults.holdIn((call) => (inside(dir, call.path) ? NEVER : null));
  }
  return calls;
}
// The top-level folders made in library folder `dir` from now on (a series' folder, say).
function madeAtTop(L, dir) {
  const made = new Set();
  const seen = (abs) => { const r = rel(dir, abs); if (r && !r.startsWith('..')) { const top = r.split('/')[0]; if (!fs.existsSync(path.join(dir, top))) made.add(top); } };
  if (L.app === 'website') fsa.onCall((call, root) => { if (path.resolve(root) === path.resolve(dir) && call.op === 'getDirectoryHandle') seen(path.join(dir, ...call.path.split('/'))); });
  else faults.failNext((call) => { if (call.op === 'mkdir') seen(call.path); if (call.op === 'rename' && call.to) seen(call.to); return false; }, 'EIO', { times: Infinity });
  return made;
}
// The galleries' ids in the order the website's settle publishes them (its marks' keys) — the desktop's alike.
const inOrder = (ids) => [...ids].map(String).sort();
// Series command `args` made with the settles the desktop asks for at once put off (library.js seriesCommand settles every
// gallery it wrote, publishing them): the test publishes the galleries itself, one at a time, as those settles would. Its
// members' moves into the series' folder (files.js _regroup, at the settle each change of a series asks for) are let
// end, and the window their weighing opened passed by the drivers' clock: what follows weighs afresh. (The website
// publishes a moment later, as its settle does, and keeps a series' members where they are.)
async function command(L, ...args) {
  if (L.app !== 'desktop') return L.raw.seriesCommand(...args);
  const settle = L.raw.settle;
  L.raw.settle = () => {};
  try { await L.raw.seriesCommand(...args); } finally { L.raw.settle = settle; }
  const files = L.raw.files;
  assert.ok(await until(async () => !files._placing.size && !files._timers.size, 15000), 'its members\' moves over');
  clockAhead(2500);
}

// ── A ──
// A series command made while a settle of one of its galleries (Chapter's, a change of its own waiting) is between its
// weighing — no group to weigh then — and its own hold; Owner's place holds another writer's publication. Nothing of the
// command is placed, moved or published by that settle, at any moment (the folder's names and manifests read as the gate
// opens and at the end): asked again, it weighs, Owner stands, the command drops whole — both in no series at the end.
for (const app of APPS) {
  test(`S42 A: ${app}: a command made between a settle's weighing and its own hold is none of that settle's — nothing of it placed, moved or published`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A');
    await L.setDefault(f.a);
    const o = await L.newGallery('Own');
    await L.putPage(o, 1, png(1));
    const c = await L.newGallery('Kept');
    await L.putPage(c, 1, png(2));
    await quiet(L);
    const odir = /** @type {string} */ (await L.dirOf(o)), cdir = /** @type {string} */ (await L.dirOf(c));
    const top = fs.readdirSync(f.A).sort(), gens = [genAt(odir), genAt(cdir)];
    const made = madeAtTop(L, f.A);
    await L.setTitle(c, 'Kept, retitled');   // a change of its own: its settle due
    // Its own hold's first look at its place held (the website's publication, the desktop's settle: each weighs first).
    const reached = gate(), go = gate();
    let done = false;
    const look = (p) => { if (done || !(p === rel(f.A, cdir) || p.startsWith(`${rel(f.A, cdir)}/`))) return null; done = true; reached.open(); return go.at; };
    if (app === 'website') fsa.hold((call) => look(call.path));
    else faults.holdIn((call) => look(rel(f.A, call.path)));
    const settling = app === 'website' ? L.raw.settleFolders() : L.raw.files.settle(c);
    assert.equal(await within(reached.at, 15000), 'ended', 'its own hold reached');
    await L.raw.seriesCommand('attach', o, c);
    theirs(odir);
    const then = { top: fs.readdirSync(f.A).sort(), gens: [genAt(odir), genAt(cdir)] };
    go.open();
    assert.equal(await within(settling, 15000), 'ended', 'the settle ends');
    const after = { top: fs.readdirSync(f.A).sort(), gen: genAt(cdir), meta: fs.existsSync(path.join(cdir, 'metadata.json')) ? metaThere(cdir) : null };
    faults.reset(); fsa.reset();
    await rounds(L, [f.a]);
    assert.deepEqual(then.top, top, 'as the gate opens: the folder\'s names as before');
    assert.deepEqual(then.gens, [gens[0] + 1, gens[1]], 'and its manifests: Owner\'s the other writer\'s, Chapter\'s as before');
    assert.deepEqual(after.top, top, 'as the settle ends: nothing moved');
    assert.equal(after.gen, gens[1], 'nothing of Chapter\'s published by it');
    assert.ok(after.meta && !after.meta.parentId, 'its part of the command never in its folder');
    assert.deepEqual([...made], [], 'no series\' folder ever made');
    assert.deepEqual(fs.readdirSync(f.A).sort(), top, 'at the end: nothing moved');
    assert.ok(!metaThere(cdir).parentId && !(metaThere(odir).chapters ?? []).some(ch => String(ch.id) === c), 'nor published');
    assert.deepEqual([linksOf(await L.meta(o)), linksOf(await L.meta(c))], [[], []], 'both in no series');
    assert.deepEqual((await records(L)).flagged, [], 'nothing left to stand');
  });
}

// The window is opened only by a weighing that weighed the group whole: member 1 weighs it (every other member held 'ok')
// and publishes; member 4's place then given another writer's publication; member 2 passes through the window and
// publishes (the limit §8 states); the 2 seconds gone by the drivers' clock since member 1's weighing — not since
// member 2 passed — member 3's publication weighs again: member 4 stands, the command drops, member 3's part never
// published.
for (const app of APPS) {
  test(`S42 A: ${app}: the weighed-whole window is never carried forward from member to member`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A');
    await L.setDefault(f.a);
    const ids = [];
    for (const name of ['Saga', 'One', 'Two', 'Three']) { const g = await L.newGallery(name); await L.putPage(g, 1, png(ids.length + 1)); ids.push(g); }
    await quiet(L);
    const [owner] = ids;
    await command(L, 'write', owner, ids.map((id, i) => ({ id, title: `Part ${i}` })), { seriesTitle: { english: 'Saga', japanese: '', pretty: '' } });
    const [m1, m2, m3, m4] = inOrder(ids);
    const dirs = Object.fromEntries(await Promise.all(ids.map(async (g) => [g, /** @type {string} */ (await L.dirOf(g))])));
    const before = genAt(dirs[m3]);
    // As member 1's manifest is written: member 4's place another writer's, and 1.5 s on; as member 2's is: 1 s more.
    const manifest = (g) => `${rel(f.A, dirs[g])}/.shiori/gallery.json`;
    const steps = new Map([[m1, () => { theirs(dirs[m4]); clockAhead(1500); }], [m2, () => clockAhead(1000)]]);
    const at = (p, final) => { for (const [g, step] of steps) if (p === manifest(g) && final) { steps.delete(g); step(); } };
    if (app === 'website') fsa.onCall((call) => at(call.path, call.op === 'close'));
    else faults.failNext((call) => { at(rel(f.A, call.op === 'rename' ? /** @type {string} */ (call.to) : call.path), call.op === 'rename'); return false; }, 'EIO', { times: Infinity });
    if (app === 'website') assert.equal(await within(L.raw.settleFolders(), 20000), 'ended');
    else for (const g of [m1, m2, m3, m4]) assert.equal(await within(L.raw.files.describe(g), 15000), 'ended');
    assert.equal(steps.size, 0, 'members 1 and 2 published, in that order');
    assert.equal(genAt(dirs[m3]), before, 'member 3\'s part never published: its weighing met member 4\'s place');
    assert.deepEqual(linksOf(metaThere(dirs[m3])), [], 'nor its links');
    faults.reset(); fsa.reset();
    await rounds(L, [f.a]);
    assert.deepEqual((await records(L)).flagged, [], 'nothing left to stand');
  });
}

// ── B ──
// Folder B's drive stops answering (every call under B held, never answered): folder A's check ends, as do its next
// check and a publication in A, with no call on B — with nothing waiting `unfound`, and with a deletion waiting so.
for (const app of APPS) {
  for (const waiting of [false, true]) {
    test(`S42 B: ${app}: folder B's drive not answering — A's checks and a publication in A end with no call on B${waiting ? ', a deletion waiting unfound' : ''}`, { skip, todo: 'S42' }, async (t) => {
      const { L, base } = await library(t, app);
      const f = await folders(L, base, 'A', 'B');
      await L.setDefault(f.a);
      const g = await L.newGallery('Kept');
      await L.putPage(g, 1, png(5));
      await L.flush();
      if (waiting) {
        const x = await L.newGallery('Gone');
        await L.putPage(x, 1, png(6));
        await L.flush();
        fs.renameSync(/** @type {string} */ (await L.dirOf(x)), path.join(base, 'aside'));
        await L.deleteGallery(x);
        assert.ok(await until(async () => (await owed(L)).some(d => d.unfound)), 'its deletion waits unfound');
      }
      assert.equal(await within(L.scan(f.a), 15000), 'ended', 'A checked once, B answering');
      const calls = drive(L, f.B, { hang: true });
      assert.equal(await within(L.scan(f.a), 15000), 'ended', 'A\'s check ends');
      assert.equal(await within(L.scan(f.a), 15000), 'ended', 'and its next');
      const h = await L.newGallery('After');
      await L.putPage(h, 1, png(7));
      assert.equal(await within(L.flush(), 15000), 'ended', 'a publication in A ends');
      assert.ok(manifestAt(/** @type {string} */ (await L.dirOf(h))), 'published');
      assert.deepEqual(calls, [], 'no call on B\'s drive');
    });
  }
}
// The cost held: an idle check of A, B answering, makes no call on B's drive — counted, with and without a deletion
// waiting unfound.
for (const app of APPS) {
  test(`S42 B: ${app}: an idle check of A makes no call on B's drive, with and without a deletion waiting`, { skip, todo: 'S42' }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A', 'B');
    await L.setDefault(f.a);
    const g = await L.newGallery('Kept');
    await L.putPage(g, 1, png(5));
    await quiet(L);
    assert.equal(await within(L.scan(f.a), 15000), 'ended');
    const idle = drive(L, f.B);
    assert.equal(await within(L.scan(f.a), 15000), 'ended');
    assert.deepEqual(idle, [], 'nothing waiting: no call on B');
    faults.reset(); fsa.reset();
    const x = await L.newGallery('Gone');
    await L.putPage(x, 1, png(6));
    await L.flush();
    fs.renameSync(/** @type {string} */ (await L.dirOf(x)), path.join(base, 'aside'));
    await L.deleteGallery(x);
    assert.ok(await until(async () => (await owed(L)).some(d => d.unfound)));
    const counted = drive(L, f.B);
    assert.equal(await within(L.scan(f.a), 15000), 'ended');
    assert.deepEqual(counted, [], 'a deletion waiting unfound: no call on B');
  });
}
// Website: a gallery moved by hand from A into B and deleted (its deletion waiting unfound) as A is checked with B's
// permission waiting to be asked again (after a reload, say): B still counts — kept — and B's check deletes it where it
// meets it, once granted.
test('S42 B: website: a deletion waiting unfound as A is checked, B\'s permission waiting to be asked — kept, then deleted where B\'s check meets it', { skip, todo: 'S42' }, async (t) => {
  const { L, base } = await library(t, 'website');
  const f = await folders(L, base, 'A', 'B');
  await L.setDefault(f.a);
  const g = await L.newGallery('Kept');
  await L.putPage(g, 1, png(5));
  await L.flush();
  const to = path.join(f.B, 'moved');
  fs.renameSync(/** @type {string} */ (await L.dirOf(g)), to);
  await L.deleteGallery(g);
  assert.ok(await until(async () => (await owed(L)).some(d => d.unfound)));
  fsa.setPermission(f.B, 'prompt');
  assert.equal(await within(L.scan(f.a), 15000), 'ended');
  assert.ok((await owed(L)).some(d => d.gid === String(g) && d.unfound), 'kept: B may hold it');
  fsa.setPermission(f.B, 'granted');
  assert.equal(await within(L.scan(f.b), 15000), 'ended');
  assert.equal(await listed(L, g), false, 'never listed again');
  assert.ok(!fs.existsSync(to), 'deleted where B\'s check met it');
  assert.deepEqual(await owed(L), [], 'nothing owed');
});

// ── C ──
// A gallery's folder moved by hand from A into B, the gallery deleted (its deletion waiting unfound), folder A removed
// from the library before B is checked: the removal goes through, the deletion stays recorded, and B's check deletes the
// folder where it meets it — the gallery never listed again.
for (const app of APPS) {
  test(`S42 C: ${app}: moved by hand into B, deleted, A removed before B is checked — never listed again, the folder in B deleted at B's check`, { skip, todo: 'S42' }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A', 'B');
    await L.setDefault(f.a);
    const g = await L.newGallery('Kept');
    await L.putPage(g, 1, png(5));
    await L.flush();
    const to = path.join(f.B, 'moved');
    fs.renameSync(/** @type {string} */ (await L.dirOf(g)), to);
    await L.deleteGallery(g);
    assert.ok(await until(async () => (await owed(L)).some(d => d.unfound)), 'marked unfound');
    await L.setDefault(L.home);
    assert.equal(await within(L.remove(f.a), 20000), 'ended', 'A\'s removal goes through');
    assert.ok(!(await L.list()).some(x => x.id === f.a), 'A gone from the library');
    assert.equal(await within(L.scan(f.b), 20000), 'ended');
    assert.equal(await listed(L, g), false, 'not listed after B\'s check');
    assert.ok(!fs.existsSync(to), 'the folder in B deleted where met');
    await rounds(L, [f.b]);
    assert.equal(await listed(L, g), false, 'never listed again');
    assert.deepEqual(await owed(L), [], 'nothing owed');
  });
  // A removed with no other folder (the desktop's own first folder checked whole first): nothing left recorded.
  test(`S42 C: ${app}: A removed with no other folder to rule it out — nothing left recorded`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A');
    await L.setDefault(f.a);
    const g = await L.newGallery('Kept');
    await L.putPage(g, 1, png(5));
    await L.flush();
    fs.renameSync(/** @type {string} */ (await L.dirOf(g)), path.join(base, 'aside'));
    await L.deleteGallery(g);
    assert.ok(await until(async () => (await owed(L)).some(d => d.unfound)), 'marked unfound');
    await L.setDefault(L.home);
    if (app === 'desktop') assert.equal(await within(L.scan(L.home), 15000), 'ended', 'the first folder checked whole');
    assert.equal(await within(L.remove(f.a), 20000), 'ended', 'A\'s removal goes through');
    assert.deepEqual(await owed(L), [], 'nothing left recorded');
  });
}

// ── D ──
// Owner's publication let through by a good weighing and held at its manifest's write; meanwhile Chapter's place given
// another writer's publication and a write of Chapter asked for: Chapter stands, the command drops whole, Owner is stood
// from the generation before; the write let go. Everything settled: Owner's record and its folder's metadata.json say
// the same of its links, the stamp kept is the token of the manifest there, nothing left waiting — and after a check
// neither is in a series.
for (const app of APPS) {
  test(`S42 D: ${app}: a publication dropped as it landed is published again — the folder says what the library says`, { skip, todo: 'S42' }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A');
    await L.setDefault(f.a);
    // Owner's publication first of the two (the website's settle publishes its marks in their keys' order).
    const [o, c] = inOrder([await L.newGallery('Owner'), await L.newGallery('Chapter')]);
    await L.putPage(o, 1, png(1));
    await L.putPage(c, 1, png(2));
    await quiet(L);
    const odir = /** @type {string} */ (await L.dirOf(o)), cdir = /** @type {string} */ (await L.dirOf(c));
    // (The desktop would move the two into the series' folder — and back out once they stand, Owner's from under its
    // publication: kept where they are here, as Windows keeps a folder an Explorer window shows, the move tried later.)
    if (app === 'desktop') faults.failNext((call) => call.op === 'rename' && [odir, cdir].includes(path.resolve(call.path)), 'EBUSY', { times: Infinity });
    await command(L, 'attach', o, c);
    const reached = gate(), go = gate();
    let done = false;
    const target = `${rel(f.A, odir)}/.shiori/gallery.json`;
    if (app === 'website') fsa.hold((call) => (!done && call.op === 'close' && call.path === target ? (done = true, reached.open(), go.at) : null));
    else faults.holdIn((call) => (!done && call.op === 'rename' && rel(f.A, call.path) === `${target}.shiori-tmp` ? (done = true, reached.open(), go.at) : null));
    const publishing = app === 'website' ? L.raw.settleFolders() : L.raw.files.describe(o);
    assert.equal(await within(reached.at, 15000), 'ended', 'Owner\'s manifest on its way');
    theirs(cdir);
    assert.equal(await within(L.putTranslation(c, 1, png(30)), 15000), 'ended', 'Chapter\'s write: it stands');
    go.open();
    assert.equal(await within(publishing, 15000), 'ended');
    faults.reset(); fsa.reset();
    await rounds(L, [], 1);
    assert.deepEqual(linksOf(metaThere(odir)), linksOf(await L.meta(o)), 'Owner\'s folder says what the library says of its links');
    assert.equal(await stampOf(L, o), tokenOf(manifestOf(odir)), 'the stamp kept is the token of the manifest there');
    assert.deepEqual((await records(L)).waiting, [], 'nothing left waiting');
    await rounds(L, [f.a], 1);
    assert.deepEqual([linksOf(await L.meta(o)), linksOf(await L.meta(c))], [[], []], 'after a check neither is in a series');
    assert.deepEqual([linksOf(metaThere(odir)), linksOf(metaThere(cdir))], [[], []], 'nor in their folders');
  });
}

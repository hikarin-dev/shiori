// folder-s40.test.mjs — S40 (the coordinator's reading of S39, review 15): an idle check costs nothing new, a deleted
// gallery never comes back from another folder, a stand overtaken drops nothing, and only a read that succeeded settles
// a gallery left to stand. Both apps through the drivers, where the scenario can be said for both.
//   A. A check of a folder that changed nothing writes nothing — no change revision, no record, no file — and its cost
//      grows with the galleries kept in series no faster than before S39; a hidden folder shown again is tidied.
//   B. A check never adopts a place naming a gallery whose deletion this library still owes.
//   C. A stand drops what waits only while its reason still holds as its own transaction reads it (the website's two
//      stands of one gallery at once, in one page or two).
//   D. A linked gallery's source that can't be read now isn't a source not there; a manifest seen by the first look and
//      not found by the re-read concludes nothing, whoever's it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopLibrary, webLibrary, otherPage } from './library-drivers.mjs';
import { zipCreate } from '../js/zip.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { netWatched } from './lock-net.mjs';

const skip = !!globalThis.__desktopLibrary && 'run by npm test';
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255, 1, 2, 3]);
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
const metaThere = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')); } catch { return null; } };

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
const changedBoth = async (L, gid) => (await L.list()).flatMap(f => f.attention ?? []).filter(a => a.reason === 'changed-both' && String(a.gid) === String(gid)).length;
// Every file under `dirs` as it is now: path → size and time.
function filesOf(...dirs) {
  const out = {};
  const walk = (root, at) => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const p = path.join(at, e.name);
      if (e.isDirectory()) walk(root, p);
      else { const st = fs.statSync(p); out[`${path.basename(root)}/${rel(root, p)}`] = `${st.size}:${st.mtimeMs}`; }
    }
  };
  for (const d of dirs) walk(d, d);
  return out;
}
// Every gallery's records as the library keeps them now.
async function recordsOf(L, gids) {
  const out = {};
  for (const g of gids) {
    out[g] = L.app === 'desktop' ? JSON.stringify([L.raw._statGet(g), L.raw._metaGet(g)]) : JSON.stringify([await L.raw.galleryGet(g), await L.raw.metaGet(g)]);
  }
  return out;
}
const revision = async (L) => Number(await L.raw.changeRevision());
// What waits written, and then nothing more written for a while: the totals' and sizes' timers ended (the change
// revision unchanged over three looks a second apart, each after a flush).
async function quiet(L) {
  let last = -1, same = 0;
  for (let i = 0; i < 60 && same < 3; i++) {
    assert.equal(await within(L.flush(), 15000), 'ended');
    const now = await revision(L);
    same = now === last ? same + 1 : 0;
    last = now;
    await sleep(1000);
  }
  assert.equal(same, 3, 'the library ends writing');
}
// The first listing of gallery place `dir` by the function that reads a gallery's folder (the website's
// folder-library.js _readDir, the desktop's scan.js readGallery), held: { reached, go }.
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s40-'));
  const L = app === 'desktop' ? await desktopLibrary(path.join(base, 'desktop')) : await webLibrary();
  t.after(async () => { faults.reset(); fsa.reset(); await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
  netWatched(t, assert);
  return { L, base };
}
// Folders A and B added, A the default.
async function twoFolders(L, base) {
  const A = path.join(base, 'A'), B = path.join(base, 'B');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  const a = await L.add(A), b = await L.add(B);
  await L.setDefault(a);
  return { A, B, a, b };
}
// `n` series of `chapters` galleries made in the default folder (the owner and its chapters): their ids.
async function series(L, n, chapters, tag = 0) {
  const all = [];
  for (let s = 0; s < n; s++) {
    const o = await L.newGallery(`Series ${tag}.${s}`);
    await L.putPage(o, 1, png(1000 + tag * 100 + s));
    all.push(o);
    for (let c = 1; c < chapters; c++) {
      const m = await L.newGallery(`Series ${tag}.${s} chapter ${c}`);
      await L.putPage(m, 1, png(2000 + tag * 1000 + s * 10 + c));
      await L.flush();
      await L.raw.seriesCommand('attach', o, m);
      all.push(m);
    }
  }
  return all;
}

// ── A ──
// 1, 2. Two checks in a row of folders keeping a series within A and one across A and B, nothing changed: the library's
// change revision is the same, every record byte for byte, the folders' files as they were.
for (const app of ['desktop', 'website']) {
  test(`S40 A: ${app}: two idle checks of folders keeping series write nothing — no revision, no record, no file`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const { A, B, a, b } = await twoFolders(L, base);
    const within1 = await series(L, 1, 3);
    const o = await L.newGallery('Across');
    await L.putPage(o, 1, png(9));
    await L.setDefault(b);
    const c = await L.newGallery('Across, chapter');
    await L.putPage(c, 1, png(10));
    await L.setDefault(a);
    await L.flush();
    await L.raw.seriesCommand('attach', o, c);
    const all = [...within1, o, c];
    await quiet(L);
    await L.scan(a);
    await L.scan(b);
    await quiet(L);
    const rev = await revision(L), recs = await recordsOf(L, all), files = filesOf(A, B);
    for (let i = 0; i < 2; i++) {
      assert.equal(await within(L.scan(a), 15000), 'ended');
      assert.equal(await within(L.scan(b), 15000), 'ended');
    }
    await quiet(L);
    assert.equal(await revision(L), rev, 'no change revision');
    assert.deepEqual(await recordsOf(L, all), recs, 'every record as it was');
    assert.deepEqual(filesOf(A, B), files, 'the folders\' files as they were');
  });
}

// 2. What an idle check costs (IndexedDB transactions on the website, SQL statements on the desktop) grows with the
// galleries kept in series no faster than on the code before S39: 4 series of 3 against 2 of 3 — 6 galleries more —
// the difference no more than that code's (09c180d, v39/check-writes, 6 and 12 series of 5: website 109 → 199
// transactions, 3 a gallery; desktop 716 → 1,346 statements, 21 a gallery; S39's head 7.8 and 27.6: s40-notes).
const IDLE_PER_GALLERY = { website: 3, desktop: 21 };
async function idleCost(app, n) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s40-'));
  const L = app === 'desktop' ? await desktopLibrary(path.join(base, 'desktop')) : await webLibrary();
  try {
    const A = path.join(base, 'A');
    fs.mkdirSync(A, { recursive: true });
    const a = await L.add(A);
    await L.setDefault(a);
    await series(L, n, 3);
    await quiet(L);
    await L.scan(a);
    await quiet(L);
    let calls = 0, undo;
    if (app === 'website') {
      const proto = Object.getPrototypeOf(await L.raw.openDB());
      const real = proto.transaction;
      proto.transaction = function (...args) { calls++; return real.apply(this, args); };
      undo = () => { proto.transaction = real; };
    } else {
      const real = L.raw._s;
      L.raw._s = (sql) => { const st = real.call(L.raw, sql); return new Proxy(st, { get: (o, k) => (['get', 'all', 'run'].includes(k) ? (...args) => { calls++; return o[k](...args); } : typeof o[k] === 'function' ? o[k].bind(o) : o[k]) }); };
      undo = () => { L.raw._s = real; };
    }
    try { await L.scan(a); } finally { undo(); }
    return calls;
  } finally { await L.close(); fs.rmSync(base, { recursive: true, force: true }); }
}
for (const app of ['desktop', 'website']) {
  test(`S40 A: ${app}: an idle check's cost grows with the galleries in series no faster than before S39`, { skip }, async (t) => {
    netWatched(t, assert);
    const two = await idleCost(app, 2), four = await idleCost(app, 4);
    assert.ok(four - two <= IDLE_PER_GALLERY[app] * 6 + 6, `${app === 'website' ? 'transactions' : 'statements'}: 2 series ${two}, 4 series ${four}`);
  });
}

// 3. A hidden folder shown again is tidied — no check after it: the chapter standing while A is hidden, A shown and
// what waits settled, nothing left contradicted. (Green before S40 on both apps — review 15 found no case the person
// sees either; held so it stays so with the tidy a shown folder now gets.)
for (const app of ['desktop', 'website']) {
  test(`S40 A3: ${app}: a series across two folders, its owner's folder hidden as its chapter stands, shown and settled without a check — no link contradicted`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const { a, b } = await twoFolders(L, base);
    const o = await L.newGallery('Owner');
    await L.putPage(o, 1, png(1));
    await L.setDefault(b);
    const c = await L.newGallery('Chapter');
    await L.putPage(c, 1, png(2));
    await L.flush();
    await L.raw.seriesCommand('attach', o, c);
    theirs(/** @type {string} */ (await L.dirOf(c)));
    await L.hide(a);
    if (app === 'desktop') assert.equal(await within(L.scan(b), 15000), 'ended');
    else assert.equal(await within(L.raw.settleFolders(), 15000), 'ended');
    assert.equal(await within(L.flush(), 15000), 'ended');
    await L.show(a);
    await quiet(L);
    if (app === 'website') { await sleep(6500); await quiet(L); }
    assert.deepEqual((await records(L)).flagged, [], 'nothing left to stand');
    assert.deepEqual(await contradicted(L, [o, c]), [], 'no link the galleries contradict');
  });
}

// ── B ──
// The model's counterexample of seed 1112213852 is in folder-model.test.mjs's REGRESSIONS. Here: a gallery of A whose
// folder the person moved by hand into B, deleted, its deletion's first file call held open, so B's check meets the
// folder with the deletion not yet tried — the gallery is never listed again, its folder in B goes, nothing is owed.
for (const app of ['desktop', 'website']) {
  test(`S40 B: ${app}: a gallery moved by hand into another folder and deleted, that folder checked before the deletion is tried — never listed again`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const { A, B, a, b } = await twoFolders(L, base);
    const g = await L.newGallery('Kept');
    await L.putPage(g, 1, png(5));
    await L.flush();
    const to = path.join(B, 'moved');
    fs.renameSync(/** @type {string} */ (await L.dirOf(g)), to);
    const reached = gate(), go = gate();
    let held = false;
    const hold = () => { if (held || !new Error().stack.includes('_deleteOne')) return null; held = true; reached.open(); return go.at; };
    if (app === 'website') fsa.hold(hold); else faults.holdIn(hold);
    await L.deleteGallery(g);
    assert.equal(await within(reached.at, 15000), 'ended', 'the deletion under way');
    assert.equal(await within(L.scan(b), 15000), 'ended', 'B\'s check ends');
    const listed = async () => (await L.galleries()).map(String).includes(String(g));
    assert.equal(await listed(), false, 'not listed after B\'s check');
    go.open();
    // (B first: a whole check of A that doesn't meet the gallery's folder gives its deletion up once it is marked
    // `unfound` — F4's own rule, plan §8 — and a folder naming it met after that is taken for the person's copy.)
    for (let i = 0; i < 2; i++) {
      assert.equal(await within(L.flush(), 15000), 'ended');
      if (app === 'website') await sleep(6500);
      assert.equal(await within(L.scan(b), 15000), 'ended');
      assert.equal(await within(L.scan(a), 15000), 'ended');
      assert.equal(await within(L.flush(), 15000), 'ended');
      assert.equal(await listed(), false, `not listed after round ${i + 1}`);
    }
    assert.ok(!fs.existsSync(to), 'its folder in B gone');
    assert.deepEqual(await owed(L), [], 'no deletion owed');
    assert.equal(fs.readdirSync(A).filter(n => !n.startsWith('.')).length, 0, 'nothing of it in A');
  });
  // The neighbour that stays: a copy made by hand in B, the gallery then deleted at its own folder, B checked — once
  // the deletion is done, as today; and at once, the deletion still owed: tried first at its own folder (or, under way
  // there, passed over by that check and the copy joining at the next). Both green before S40 and after.
  for (const when of ['once the deletion is done', 'at once']) test(`S40 B: ${app}: a copy made by hand in another folder joins at that folder's check, the gallery deleted — B checked ${when}`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const { B, b } = await twoFolders(L, base);
    const g = await L.newGallery('Copied');
    await L.putPage(g, 1, png(6));
    await L.flush();
    const at = /** @type {string} */ (await L.dirOf(g));
    fs.cpSync(at, path.join(B, 'copy'), { recursive: true });
    await L.deleteGallery(g);
    if (when !== 'at once') for (let i = 0; i < 200 && (await owed(L)).length; i++) await sleep(50);
    if (when !== 'at once') assert.deepEqual(await owed(L), [], 'the deletion done');
    assert.equal(await within(L.scan(b), 15000), 'ended');
    assert.equal(await within(L.flush(), 15000), 'ended');
    for (let i = 0; i < 200 && (await owed(L)).length; i++) await sleep(50);
    assert.deepEqual(await owed(L), [], 'the deletion done');
    if (!(await L.galleries()).map(String).includes(String(g))) assert.equal(await within(L.scan(b), 15000), 'ended', 'B checked again');
    assert.ok(!fs.existsSync(at), 'its own folder deleted');
    assert.ok((await L.galleries()).map(String).includes(String(g)), 'the copy joined');
    assert.equal(await L.dirOf(g), path.join(B, 'copy'));
  });
}

// ── C ──
// Website: two stands of one gallery whose place another writer published, at once — a check's and a publication's
// weighing of its series command, in one page or two — the first's re-read held until the second has begun; the
// person's change made once the first stood: the second drops nothing, the change stays and is published, one
// 'changed-both'.
for (const where of ['one page', 'two pages']) {
  test(`S40 C: website: two stands of one gallery at once (${where}) — a change made once the first stood stays`, { skip, todo: 'S40' }, async (t) => {
    const { L, base } = await library(t, 'website');
    const A = path.join(base, 'A');
    fs.mkdirSync(A, { recursive: true });
    const a = await L.add(A);
    await L.setDefault(a);
    const x = await L.newGallery('First');
    await L.putPage(x, 1, png(1));
    const y = await L.newGallery('Second');
    await L.putPage(y, 1, png(2));
    await quiet(L);
    await L.raw.seriesCommand('attach', x, y);
    const ydir = /** @type {string} */ (await L.dirOf(y)), yrel = rel(A, ydir);
    theirs(ydir);
    let n = 0;
    const second = gate(), go = gate();
    fsa.hold((call) => {
      if (call.path !== yrel || call.op !== 'entries' || !new Error().stack.includes('_readFormat')) return null;
      const k = ++n;
      if (k === 1) return Promise.race([second.at, sleep(12000)]);
      if (k === 2) { second.open(); return go.at; }
      return null;
    });
    const other = where === 'two pages' ? await otherPage() : null;
    t.after(() => other?.close());
    const both = Promise.all([L.scan(a), other ? other.db.settleFolders() : L.raw.settleFolders()]);
    for (let i = 0; i < 400 && (await records(L)).waiting.includes(y); i++) await sleep(50);
    assert.equal(n, 2, 'two stands begun');
    await L.setTitle(y, 'Second, changed since');
    go.open();
    assert.equal(await within(both, 20000), 'ended');
    assert.equal(await L.titleOf(y), 'Second, changed since', 'the change made since stays');
    await quiet(L);
    await sleep(6500);
    await quiet(L);
    assert.equal(metaThere(ydir)?.title?.english, 'Second, changed since', 'and is published');
    assert.equal(await changedBoth(L, y), 1, 'one \'changed-both\'');
  });
}

// ── D ──
// A linked gallery left to stand whose ZIP can't be read for a moment (its reads failing, the ZIP there): held while
// that lasts — flagged, of its group still — and stood once readable, its command dropped whole.
for (const app of ['desktop', 'website']) {
  test(`S40 D: ${app}: a linked gallery left to stand whose ZIP can't be read for a moment is held, then stands`, { skip, todo: 'S40' }, async (t) => {
    const { L, base } = await library(t, app);
    const A = path.join(base, 'A'), zip = path.join(A, 'Pack.zip');
    fs.mkdirSync(A, { recursive: true });
    fs.writeFileSync(zip, zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }]));
    const a = await L.add(A);
    await L.setDefault(a);
    await L.scan(a);
    const x = String((await L.galleries())[0]);
    await L.putTranslation(x, 1, png(3));
    const m = await L.newGallery('Own');
    await L.putPage(m, 1, png(7));
    await quiet(L);
    await L.raw.seriesCommand('attach', x, m);
    theirs(/** @type {string} */ (await L.dirOf(m)));
    if (app === 'desktop') faults.failNext((c) => c.op === 'open' && c.path.endsWith('Pack.zip'), 'EBUSY', { times: 100000 });
    else fsa.failNext((c) => c.op === 'getFile' && c.path === 'Pack.zip', 'NotReadableError', { times: 100000 });
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (app === 'website') await sleep(6500);
    assert.equal(await within(L.flush(), 15000), 'ended');
    const r = await records(L);
    assert.ok(r.flagged.includes(x) && r.grouped.includes(x), `held while its ZIP can't be read: ${JSON.stringify(r)}`);
    faults.reset();
    fsa.reset();
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (app === 'website') await sleep(6500);
    assert.equal(await within(L.flush(), 15000), 'ended');
    assert.equal(await within(L.scan(a), 15000), 'ended');
    assert.equal(await within(L.flush(), 15000), 'ended');
    const end = await records(L);
    assert.deepEqual(end.flagged, [], 'it stood');
    assert.ok(!(await L.meta(m))?.parentId && !(await L.meta(x))?.chapters, 'the command dropped whole');
  });
}

// A gallery left to stand whose own manifest its hold's first look saw, renamed away before the re-read: nothing
// concluded — still left to stand, of its group, nothing written over its place; the manifest back, it stands.
async function flag(L, gid) {
  if (L.app === 'desktop') { L.raw._s('UPDATE together SET dropped = 1 WHERE gid = ?').run(String(gid)); return; }
  const idb = await L.raw.openDB();
  await new Promise((resolve) => {
    const tx = idb.transaction('folders', 'readwrite');
    const s = tx.objectStore('folders'), q = s.get(`$group:${gid}`);
    q.onsuccess = () => s.put({ ...q.result, drop: true });
    tx.oncomplete = resolve;
  });
}
for (const app of ['desktop', 'website']) {
  test(`S40 D: ${app}: a gallery left to stand whose own manifest the first look saw, not found by the re-read, concludes nothing`, { skip, todo: 'S40' }, async (t) => {
    const { L, base } = await library(t, app);
    const A = path.join(base, 'A');
    fs.mkdirSync(A, { recursive: true });
    const a = await L.add(A);
    await L.setDefault(a);
    const o = await L.newGallery('Old');
    await L.putPage(o, 1, png(1));
    const m = await L.newGallery('Own');
    await L.putPage(m, 1, png(7));
    await quiet(L);
    await L.setTitle(o, 'Old, changed here');
    await L.raw.seriesCommand('attach', o, m);
    await flag(L, o);
    const dir = /** @type {string} */ (await L.dirOf(o));
    const file = /** @type {string} */ (manifestAt(dir)), away = `${file}.away`;
    const held = holdReread(L, A, dir);
    const work = L.putTranslation(o, 1, png(30));
    assert.equal(await within(held.reached, 15000), 'ended', 'its re-read under way');
    fs.renameSync(file, away);
    held.go();
    await within(work, 15000);
    const r = await records(L);
    assert.ok(r.flagged.includes(o) && r.grouped.includes(o), `still left to stand: ${JSON.stringify(r)}`);
    assert.ok(!manifestAt(dir), 'nothing written over its place');
    fs.renameSync(away, file);
    assert.equal(await within(L.scan(a), 15000), 'ended');
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (app === 'website') await sleep(6500);
    assert.equal(await within(L.flush(), 15000), 'ended');
    assert.deepEqual((await records(L)).flagged, [], 'it stood once the manifest was back');
    assert.equal(await L.titleOf(o), 'Old', 'by the folder\'s version');
    assert.ok(!(await L.meta(m))?.parentId, 'the command dropped whole');
  });
}

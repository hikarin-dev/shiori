// folder-s41.test.mjs — S41 (the coordinator's reading of S40, review 16): a deleted gallery never comes back — by
// another folder, by its overlay, by an older record — a command's part is never published while another's drop is
// being found, every hold knows what its first look saw. Both apps through the drivers.
//   A. a series command's part is never published while another part's drop is being found;
//   C. a deleted linked gallery's id never comes back by its overlay;
//   D. a place naming a deleted gallery: every record of it weighed, nothing adopted while one is owed, one folder's
//      check never waits on another's;
//   E. a deletion not found is given up only once every folder it could be in was looked in;
//   F. a hold through the folder store contract knows what its first look saw;
//   H. a linked source read and found damaged settles; only a read that failed holds.
// (B is in lock-net.test.mjs; G is held by the fitness rule 'S41'.)
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
const APPS = ['desktop', 'website'];
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255, 1, 2, 3]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([Promise.resolve(p).then(() => 'ended', (e) => `failed: ${e?.message || e}`), sleep(ms).then(() => `still waiting after ${ms} ms`)]);
const gate = () => { let open; const at = new Promise((resolve) => { open = resolve; }); return { at, open }; };
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const manifestAt = (dir) => [path.join(dir, 'gallery.json'), path.join(dir, '.shiori', 'gallery.json')].find((f) => fs.existsSync(f)) ?? null;
const theirs = (dir) => {
  const file = /** @type {string} */ (manifestAt(dir));
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...m, generation: m.generation + 1, publication: 'f0e1d2c3b4a59687', writer: 'b1b2c3d4e5f60708' }, null, 2));
};
const genAt = (dir) => { const f = manifestAt(dir); return f ? JSON.parse(fs.readFileSync(f, 'utf8')).generation : null; };

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
const listed = async (L, gid) => (await L.galleries()).map(String).includes(String(gid));
async function library(t, app) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s41-'));
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
// Every library folder this app can check now but `except` (the desktop's own first folder too).
const checkable = async (L, ...except) => (await L.list()).filter(f => !['hidden', 'removing'].includes(f.state) && !f.hidden && !(L.app === 'website' && f.id === L.home) && !except.includes(f.id)).map(f => f.id);
async function until(cond, ms = 10000) { for (let i = 0; i < ms / 50 && !(await cond()); i++) await sleep(50); return cond(); }
async function rounds(L, ids, n = 2) {
  for (let i = 0; i < n; i++) {
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (L.app === 'website') await sleep(6500);
    for (const id of ids) assert.equal(await within(L.scan(id), 20000), 'ended');
    assert.equal(await within(L.flush(), 15000), 'ended');
  }
}

// ── D ──
// Two records naming one gallery: a move to another folder left one for its old place (refusing its removal: still
// owed), and the gallery, its folder then moved by hand, deleted — a second record, marked `unfound`. Whichever record
// the check meets first, the place met is deleted, the gallery never listed again.
for (const app of APPS) {
  for (const order of ['the move\'s first', 'the deletion\'s first']) {
    for (const form of ['moved into another folder', 'renamed beside itself']) {
      test(`S41 D: ${app}: two records of one deleted gallery (${order}, ${form}) — never listed again, the folder met deleted`, { skip }, async (t) => {
        const { L, base } = await library(t, app);
        const f = await folders(L, base, 'P', 'Q', 'C');
        // A sorts first among the folders' ids (its records are met first); `order` puts the move's old place there or not.
        const [lo, hi] = String(f.p) < String(f.q) ? [['P', f.p], ['Q', f.q]] : [['Q', f.q], ['P', f.p]];
        const [[An, a], [Bn, b]] = order === 'the move\'s first' ? [lo, hi] : [hi, lo];
        const A = f[An], B = f[Bn];
        await L.setDefault(a);
        const x = await L.newGallery('Moved twice');
        await L.putPage(x, 1, png(5));
        await L.flush();
        const old = /** @type {string} */ (await L.dirOf(x)), oldRel = rel(A, old);
        if (app === 'website') fsa.failNext((call) => call.op === 'removeEntry' && (call.path === oldRel || call.path.startsWith(`${oldRel}/`)), 'NoModificationAllowedError', { times: 1e6 });
        else {
          faults.failNext((call) => call.op === 'rename' && path.resolve(call.path) === path.resolve(old), 'EXDEV', { times: 1 });
          faults.failNext((call) => ['rm', 'unlink', 'rmdir'].includes(call.op) && path.resolve(call.path).startsWith(path.resolve(old)), 'EBUSY', { times: 1e6 });
        }
        assert.equal(await within(L.move(x, b), 20000), 'ended');
        await L.flush();
        const to = form === 'renamed beside itself' ? path.join(B, 'renamed') : path.join(f.C, 'moved');
        fs.renameSync(/** @type {string} */ (await L.dirOf(x)), to);
        await L.deleteGallery(x);
        await until(async () => (await owed(L)).some(o => o.unfound));
        assert.equal(await within(L.scan(form === 'renamed beside itself' ? b : f.c), 20000), 'ended');
        assert.equal(await listed(L, x), false, 'not listed after the check that met it');
        faults.reset(); fsa.reset();
        await rounds(L, [f.c, a, b]);
        assert.equal(await listed(L, x), false, 'never listed again');
        // (The desktop deletes a folder emptied of what it named with Windows' own delete, which may end a moment later. Its
        // move by copy — the EXDEV here — can leave a picture whose time isn't the one the deletion recorded: kept as the
        // person's, the folder with it, but nothing naming the gallery: s41-notes.md.)
        if (app === 'desktop') assert.ok(await until(async () => !fs.existsSync(to) || (!manifestAt(to) && !fs.existsSync(path.join(to, 'metadata.json')))), 'nothing there names the gallery');
        else assert.ok(await until(async () => !fs.existsSync(to)), 'the folder met deleted');
      });
    }
  }
  // Folder A's drive not answering as folder B's check meets a place naming a gallery whose deletion A owes: B's check
  // ends, the place passed over; once A answers, the deletion is done and the place met deleted.
  test(`S41 D: ${app}: folder A's drive not answering as B's check meets a gallery A's deletion owes — B's check ends, the place passed over`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A', 'B');
    await L.setDefault(f.a);
    const g = await L.newGallery('Kept');
    await L.putPage(g, 1, png(5));
    await L.flush();
    const to = path.join(f.B, 'moved');
    fs.renameSync(/** @type {string} */ (await L.dirOf(g)), to);
    const go = gate();
    // (The gallery's own place in A, 'Kept', is what A's deletion looks at and B's check never needs: held on both apps —
    // the website's calls name a path in the folder picked. Not all of A: the desktop's check of any folder looks at the
    // library's staging folder, which lives in the default folder, A here.)
    if (app === 'website') fsa.hold((call) => (call.path === 'Kept' || call.path.startsWith('Kept/') ? go.at : null));
    else faults.holdIn((call) => (path.resolve(call.path).startsWith(path.resolve(f.A, 'Kept')) ? go.at : null));
    const deleting = L.deleteGallery(g);
    assert.equal(await within(L.scan(f.b), 15000), 'ended', 'B\'s check ends');
    assert.equal(await listed(L, g), false, 'passed over');
    assert.ok(fs.existsSync(to), 'nothing deleted at B yet');
    go.open();
    await within(deleting, 15000);
    faults.reset(); fsa.reset();
    await rounds(L, [f.b, f.a]);
    assert.equal(await listed(L, g), false, 'never listed');
    assert.ok(!fs.existsSync(to), 'the place met deleted');
  });
}

// ── E ──
// A gallery moved by hand into folder B and deleted, folder A (its own) checked first: never listed again, the folder in
// B deleted at B's check.
for (const app of APPS) {
  test(`S41 E: ${app}: moved by hand into B, deleted, A checked first — never listed again, the folder in B deleted at B's check`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A', 'B');
    await L.setDefault(f.a);
    const g = await L.newGallery('Kept');
    await L.putPage(g, 1, png(5));
    await L.flush();
    const to = path.join(f.B, 'moved');
    fs.renameSync(/** @type {string} */ (await L.dirOf(g)), to);
    await L.deleteGallery(g);
    await until(async () => (await owed(L)).some(o => o.unfound));
    assert.equal(await within(L.scan(f.a), 15000), 'ended');
    assert.equal(await within(L.scan(f.b), 15000), 'ended');
    assert.equal(await listed(L, g), false, 'not listed after B\'s check');
    assert.ok(!fs.existsSync(to), 'the folder in B deleted');
    await rounds(L, [f.a, f.b]);
    assert.equal(await listed(L, g), false, 'never listed again');
    assert.deepEqual(await owed(L), [], 'nothing owed');
  });
  // A restart between A's check and B's: what the deletion needs remembered survives it.
  test(`S41 E: ${app}: the same with the app started again between A's check and B's`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    if (!L.restart) { t.skip('no restart left in this process'); return; }
    const f = await folders(L, base, 'A', 'B');
    await L.setDefault(f.a);
    const g = await L.newGallery('Kept');
    await L.putPage(g, 1, png(5));
    await L.flush();
    const to = path.join(f.B, 'moved');
    fs.renameSync(/** @type {string} */ (await L.dirOf(g)), to);
    await L.deleteGallery(g);
    await until(async () => (await owed(L)).some(o => o.unfound));
    assert.equal(await within(L.scan(f.a), 15000), 'ended');
    await L.restart();
    assert.equal(await within(L.scan(f.b), 15000), 'ended');
    assert.equal(await listed(L, g), false, 'not listed');
    assert.ok(!fs.existsSync(to), 'the folder in B deleted');
  });
  // B hidden while A is checked: given up without it, as §8 states — the moved folder joins when B is shown and checked.
  test(`S41 E: ${app}: B hidden as A is checked — the deletion is given up without it, the moved folder joins at B's check (§8)`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A', 'B');
    await L.setDefault(f.a);
    const g = await L.newGallery('Kept');
    await L.putPage(g, 1, png(5));
    await L.flush();
    fs.renameSync(/** @type {string} */ (await L.dirOf(g)), path.join(f.B, 'moved'));
    await L.deleteGallery(g);
    await until(async () => (await owed(L)).some(o => o.unfound));
    await L.hide(f.b);
    for (const id of await checkable(L)) assert.equal(await within(L.scan(id), 15000), 'ended');
    assert.deepEqual(await owed(L), [], 'given up');
    await L.show(f.b);
    assert.equal(await within(L.scan(f.b), 15000), 'ended');
    assert.equal(await listed(L, g), true, 'joined (the case §8 states)');
  });
  // Once every folder ruled it out, a copy the person puts back joins.
  test(`S41 E: ${app}: once every folder ruled the deletion out, a copy put back joins`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A', 'B');
    await L.setDefault(f.a);
    const g = await L.newGallery('Kept');
    await L.putPage(g, 1, png(5));
    await L.flush();
    const aside = path.join(base, 'aside');
    fs.renameSync(/** @type {string} */ (await L.dirOf(g)), aside);
    await L.deleteGallery(g);
    await until(async () => (await owed(L)).some(o => o.unfound));
    for (const id of await checkable(L)) assert.equal(await within(L.scan(id), 15000), 'ended');
    assert.deepEqual(await owed(L), [], 'ruled out everywhere, given up');
    fs.renameSync(aside, path.join(f.B, 'put back'));
    assert.equal(await within(L.scan(f.b), 15000), 'ended');
    assert.equal(await listed(L, g), true, 'the copy joined');
  });
}

// ── C ──
// A linked gallery deleted (a PDF drawn, a ZIP), its source then replaced by another of the same name: a new title under
// a new id; the deleted one never listed again, its overlay gone at the end — with a settle between and without.
for (const app of APPS) {
  for (const kind of ['a PDF', 'a ZIP']) {
    for (const wait of [false, true]) {
      test(`S41 C: ${app}: ${kind}'s gallery deleted, its file replaced — a new gallery under a new id${wait ? ', after a settle' : ''}`, { skip }, async (t) => {
        const { L, base } = await library(t, app);
        const f = await folders(L, base, 'A');
        await L.setDefault(f.a);
        const name = kind === 'a PDF' ? 'Book.pdf' : 'Pack.zip';
        const file = path.join(f.A, name);
        const write = (n) => fs.writeFileSync(file, kind === 'a PDF' ? `%PDF-1.4 ${n === 1 ? 'one' : 'two, another file altogether'}`
          : zipCreate(n === 1 ? [{ name: '001.png', data: png(1) }] : [{ name: 'a.png', data: png(9) }, { name: 'b.png', data: png(10) }]));
        const draw = async () => {
          const w = (await L.pdfsWaiting()).find(x => x.name === name);
          if (!w) return null;
          const { token } = await L.pdfSource(w.folder, w.gid);
          await L.addRendered(w.folder, w.gid, [png(Math.floor(Math.random() * 60000)), png(7)], token);
          return String(w.gid);
        };
        await L.scan(f.a);
        write(1);
        await L.scan(f.a);
        const g = kind === 'a PDF' ? await draw() : String((await L.galleries())[0]);
        assert.ok(g, 'the first gallery');
        await L.flush();
        await L.deleteGallery(g);
        if (wait) await quiet(L);
        await L.scan(f.a);
        await within(L.flush(), 15000);
        write(2);
        await L.scan(f.a);
        if (kind === 'a PDF') await draw();
        await rounds(L, [f.a]);
        const now = (await L.galleries()).map(String);
        assert.equal(now.includes(g), false, 'the deleted gallery never listed again');
        assert.equal(now.length, 1, 'the new file a gallery of its own');
        assert.ok(!fs.existsSync(path.join(f.A, '.shiori', 'linked', g)), 'the deleted gallery\'s overlay gone');
      });
    }
  }
}

// ── F ──
// A gallery left to stand whose own manifest the hold's first look saw, renamed away before the re-read — the hold asked
// by a write or by a publication: nothing concluded (still left to stand, of its group, waiting, nothing written over
// its place); the manifest back, it stands.
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
for (const app of APPS) {
  for (const mode of ['a write', 'a publication']) {
    test(`S41 F: ${app}: its own manifest seen by the first look of ${mode}'s hold, gone at the re-read — nothing concluded`, { skip }, async (t) => {
      const { L, base } = await library(t, app);
      const f = await folders(L, base, 'A');
      await L.setDefault(f.a);
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
      const held = holdReread(L, f.A, dir);
      const work = mode === 'a write' ? L.putTranslation(o, 1, png(30)) : (app === 'desktop' ? L.raw.files.describe(o) : L.raw.settleFolders());
      assert.equal(await within(held.reached, 15000), 'ended', 'its re-read under way');
      fs.renameSync(file, away);
      held.go();
      await within(work, 15000);
      const r = await records(L);
      // (The website's publication comes from a settle, which publishes the command's other gallery too: its weighing
      // holds this one again, a later look that truly finds no manifest — and settles it, as D1 says. So there only
      // what this hold must not do is asked: nothing published over the place, its change still waiting.)
      if (app === 'website' && mode === 'a publication') assert.ok(r.waiting.includes(o), `its change still waiting: ${JSON.stringify(r)}`);
      else assert.ok(r.flagged.includes(o) && r.grouped.includes(o) && r.waiting.includes(o), `still left to stand: ${JSON.stringify(r)}`);
      assert.ok(!manifestAt(dir), 'nothing written over its place');
      fs.renameSync(away, file);
      await rounds(L, [f.a], 1);
      assert.deepEqual((await records(L)).flagged, [], 'it stood once the manifest was back');
      if (!(app === 'website' && mode === 'a publication')) assert.equal(await L.titleOf(o), 'Old', 'by the folder\'s version');
    });
  }
}

// ── H ──
// A linked gallery left to stand whose ZIP is replaced by bytes that are no ZIP (read, and damaged): settled; a later
// series command over it and a healthy gallery is published.
for (const app of APPS) {
  test(`S41 H: ${app}: a linked gallery left to stand whose ZIP is replaced by bytes that are no ZIP — settled, a later command's healthy gallery published`, { skip, todo: 'S41' }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A');
    await L.setDefault(f.a);
    const zip = path.join(f.A, 'Pack.zip');
    fs.writeFileSync(zip, zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }]));
    await L.scan(f.a);
    const x = String((await L.galleries())[0]);
    await L.putTranslation(x, 1, png(3));
    const m = await L.newGallery('Own');
    await L.putPage(m, 1, png(7));
    const h = await L.newGallery('Healthy');
    await L.putPage(h, 1, png(8));
    await quiet(L);
    await L.raw.seriesCommand('attach', x, m);
    theirs(/** @type {string} */ (await L.dirOf(m)));
    fs.writeFileSync(zip, 'not a zip at all, just bytes');
    await rounds(L, [], 1);
    assert.ok(!(await records(L)).flagged.includes(x), 'not left to stand for good');
    await L.raw.seriesCommand('attach', x, h);
    await rounds(L, [], 1);
    const meta = JSON.parse(fs.readFileSync(path.join(/** @type {string} */ (await L.dirOf(h)), 'metadata.json'), 'utf8'));
    assert.equal(String(meta.parentId ?? ''), x, 'the healthy gallery\'s part published');
  });
}

// ── A ──
// A series command over Owner (A) and Chapter (B); Chapter's place another writer's publication. Chapter's publication
// weighs the group (Owner's place 'ok'); its own look then held; Owner's publication asked for; the look let go: Owner's
// part never reaches its folder (generation 1 kept), and neither is in a series — with no check. (The desktop's: its
// two publications can be asked for one by one, `files.describe`. The website publishes what waits one gallery after
// another from a settle — `_describe` is the kernel's, not the module's — so two at once can't be asked for from here
// without a second page racing the first for the same galleries' locks: its half is held by v40/pt2.sh's count over
// 96 replays, s41-notes.md.)
for (const app of ['desktop']) {
  test(`S41 A: ${app}: one part of a command never published while another's drop is being found`, { skip }, async (t) => {
    const { L, base } = await library(t, app);
    const f = await folders(L, base, 'A', 'B');
    await L.setDefault(f.a);
    const o = await L.newGallery('Owner');
    await L.putPage(o, 1, png(1));
    await L.setDefault(f.b);
    const c = await L.newGallery('Chapter');
    await L.putPage(c, 1, png(2));
    await quiet(L);
    const odir = /** @type {string} */ (await L.dirOf(o)), cdir = /** @type {string} */ (await L.dirOf(c));
    const gen0 = genAt(odir);
    await L.raw.seriesCommand('attach', o, c);
    theirs(cdir);
    // Chapter's own look — the first at its place once Owner's has been looked at by the weighing — held.
    const reached = gate(), go = gate();
    let ownerSeen = false, done = false;
    const look = (where, p) => {
      if (where === 'A' && p === rel(f.A, odir)) ownerSeen = true;
      if (done || !ownerSeen || where !== 'B' || p !== rel(f.B, cdir)) return null;
      done = true; reached.open(); return go.at;
    };
    const inA = (p) => path.resolve(p).startsWith(path.resolve(f.A));
    faults.holdIn((call) => look(inA(call.path) ? 'A' : 'B', rel(inA(call.path) ? f.A : f.B, call.path)));
    const chapter = L.raw.files.describe(c);
    assert.equal(await within(reached.at, 15000), 'ended', 'Chapter\'s own look reached');
    const owner = L.raw.files.describe(o);
    await sleep(300);
    go.open();
    await within(Promise.all([chapter, owner]), 20000);
    faults.reset();
    await within(L.flush(), 15000);
    assert.equal(genAt(odir) === gen0 || !(JSON.parse(fs.readFileSync(path.join(odir, 'metadata.json'), 'utf8')).chapters), true, 'Owner\'s part never in its folder');
    assert.ok(!(await L.meta(o))?.chapters && !(await L.meta(c))?.parentId, 'neither is in a series');
  });
}

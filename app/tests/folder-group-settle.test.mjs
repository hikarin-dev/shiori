// folder-group-settle.test.mjs — S38 (review 13): a gallery left to stand by its series command's drop (S37: the
// group's record `drop` on the website, `together.dropped` on the desktop) is never held for good. One whose place holds
// no version to stand by — no manifest there, and none this library ever read or wrote there (an earlier version's
// folder, a linked gallery whose overlay was never described) — is settled: its flag and group go,
// its series links are tidied against the galleries as they stand, and what waits of it is published — so too where its
// manifest is lost, whatever this library's stamp says (S39: what the place shows decides, as for any gallery; the one
// guard left, a manifest the same look saw a moment ago and doesn't find now, is folder-group-seen.test.mjs's).
// A gallery that stands by a drop has the galleries its dropped change linked tidied, so none
// keeps a link the standing versions contradict. A flag is its own command's. And a later command over a gallery still
// left to stand is dropped with it until that gallery's folder is back (§8). Both apps through the drivers.
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
// Another writer's later generation over this app's manifest at gallery place `dir` (as a publication of theirs lands).
const theirs = (dir) => {
  const file = [path.join(dir, 'gallery.json'), path.join(dir, '.shiori', 'gallery.json')].find((f) => fs.existsSync(f)) ?? '';
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...m, generation: m.generation + 1, publication: 'f0e1d2c3b4a59687', writer: 'b1b2c3d4e5f60708' }, null, 2));
};
const manifestAt = (dir) => [path.join(dir, 'gallery.json'), path.join(dir, '.shiori', 'gallery.json')].find((f) => fs.existsSync(f)) ?? null;
const metaThere = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));

// What the library keeps of its series commands: the galleries grouped, those left to stand, those with a change waiting.
async function records(L) {
  if (L.app === 'desktop') {
    const rows = L.raw._s('SELECT gid, grp, dropped FROM together').all();
    return { grouped: rows.map(r => String(r.gid)), flagged: rows.filter(r => r.dropped).map(r => String(r.gid)), groups: Object.fromEntries(rows.map(r => [String(r.gid), r.grp])),
      waiting: L.raw._s('SELECT gid FROM files WHERE pending = 1').all().map(r => String(r.gid)) };
  }
  const idb = await L.raw.openDB();
  return new Promise((resolve) => {
    const tx = idb.transaction(['folders', 'undescribed'], 'readonly');
    const g = tx.objectStore('folders').getAll(IDBKeyRange.bound('$group:', '$group:￿'));
    const u = tx.objectStore('undescribed').getAllKeys();
    tx.oncomplete = () => resolve({ grouped: g.result.map(r => String(r.gid)), flagged: g.result.filter(r => r.drop).map(r => String(r.gid)),
      groups: Object.fromEntries(g.result.map(r => [String(r.gid), r.grp])), waiting: u.result.map(String) });
  });
}
// The series links among `gids` that the galleries as the library has them contradict.
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
// Every read under gallery place `dir` failing while `on` (a folder out of reach for a while), on either app.
function unreadable(L, A, dir) {
  const p = `${rel(A, dir)}/`;
  return L.app === 'website' ? fsa.failNext((call) => call.path.startsWith(p) || `${call.path}/` === p, 'NotReadableError', { times: Infinity })
    : faults.failNext((call) => { const r = `${rel(A, call.path)}/`; return r.startsWith(p) && !r.startsWith('..'); }, 'EIO', { times: Infinity });
}

/** Folder A, the default, with gallery `o` of kind `kind` (no version: 'an earlier version\'s folder', 'a linked
 * gallery never described'; or 'of this version', published), and an own gallery `m`. */
async function made(t, app, kind) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s38-'));
  const L = app === 'desktop' ? await desktopLibrary(path.join(base, 'desktop')) : await webLibrary();
  t.after(async () => { faults.reset(); fsa.reset(); await L.close(); fs.rmSync(base, { recursive: true, force: true }); });
  netWatched(t, assert);
  const A = path.join(base, 'A');
  fs.mkdirSync(A, { recursive: true });
  let o = null, linked = false;
  if (kind === 'an earlier version\'s folder') o = String((await v1Gallery(path.join(A, 'Old'), { files: true })).gid);
  if (kind === 'a linked gallery never described') { fs.writeFileSync(path.join(A, 'Pack.zip'), zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }])); linked = true; }
  const a = await L.add(A);
  await L.setDefault(a);
  await L.scan(a);
  if (linked) o = String((await L.galleries())[0]);
  if (kind === 'of this version') { o = await L.newGallery('Kept'); await L.putPage(o, 1, png(5)); }
  const m = await L.newGallery('Own');
  await L.putPage(m, 1, png(7));
  await L.flush();
  const place = async (gid) => (linked && gid === o ? path.join(A, '.shiori', 'linked', gid) : /** @type {string} */ (await L.dirOf(gid)));
  return { L, a, A, o, m, linked, place, base };
}

// (The oldest format isn't one: the desktop's check converts it to format v2 as it joins — stamped — and the website
// doesn't read it.)
const NO_VERSION = ['an earlier version\'s folder', 'a linked gallery never described'];

// (a) The reviewer's case.
for (const app of ['desktop', 'website']) {
  for (const kind of NO_VERSION) {
    test(`S38 (a): ${app}: a series command over ${kind} and a gallery another writer published since — the one with no version to stand by is settled, never held for good`, { skip }, async (t) => {
      const c = await made(t, app, kind);
      const { L, a, o, m } = c;
      // A change of its own made just before the command (a page translated), not published yet: settled, it stays.
      await L.putTranslation(o, 1, png(3));
      await L.raw.seriesCommand('attach', o, m);
      theirs(await c.place(m));
      assert.equal(await within(L.flush(), 15000), 'ended', 'settled');
      if (app === 'website') await sleep(6500);   // what is due a moment later
      assert.equal(await within(L.scan(a), 15000), 'ended', 'a check');
      assert.equal(await within(L.flush(), 15000), 'ended', 'settled again');
      const r = await records(L);
      assert.deepEqual(r.flagged, [], 'nothing left to stand');
      assert.ok(!r.waiting.includes(o), 'nothing of it waits for good');
      assert.deepEqual(await contradicted(L, [o, m]), [], 'no series link the galleries contradict');
      assert.ok(!(await L.meta(m))?.parentId, 'the other writer\'s gallery stands as its folder has it');
      assert.ok(manifestAt(await c.place(o)), 'its place is published (a manifest there)');
      assert.ok(!metaThere(await c.place(o)).chapters?.some(ch => String(ch.id) === m), 'published without the link its group\'s drop contradicts');
      assert.ok(same(await L.read(o, 1, 'translated'), png(3)), 'its own change kept: nothing to drop it for');
      assert.equal(await within(L.putTranslation(o, 2, png(9)), 10000), 'ended', 'a later write of it');
      assert.ok(same(await L.read(o, 2, 'translated'), png(9)), 'lands');
      // A later series command over it and a healthy gallery is published.
      const h = await L.newGallery('Healthy');
      await L.putPage(h, 1, png(8));
      await L.flush();
      await L.raw.seriesCommand('attach', o, h);
      assert.equal(await within(L.flush(), 15000), 'ended', 'the later command settled');
      assert.equal(String(metaThere(/** @type {string} */ (await L.dirOf(h))).parentId ?? ''), o, 'the later command published: its chapter');
      assert.ok(metaThere(await c.place(o)).chapters?.some(ch => String(ch.id) === h), 'and its owner');
      assert.deepEqual((await records(L)).flagged, []);
    });
  }
}

// (b) Three galleries: one another writer's, one with no version, one unreadable for a while and then back.
for (const app of ['desktop', 'website']) {
  test(`S38 (b): ${app}: a command over three — another writer's, one with no version, one unreadable a while — the settled one takes a write meanwhile, and once the third stands no link is left contradicted`, { skip }, async (t) => {
    const c = await made(t, app, 'an earlier version\'s folder');
    const { L, A, o, m } = c;
    const u = await L.newGallery('Away');
    await L.putPage(u, 1, png(6));
    await L.flush();
    await L.raw.seriesCommand('write', o, [{ id: o, title: 'Old' }, { id: m, title: 'Own' }, { id: u, title: 'Away' }], { seriesTitle: { english: 'Saga', japanese: '', pretty: '' } });
    theirs(await c.place(m));
    const back = unreadable(L, A, await c.place(u));
    assert.equal(await within(L.flush(), 15000), 'ended', 'settled while the third is away');
    if (app === 'website') await sleep(6500);
    assert.equal(await within(L.flush(), 15000), 'ended');
    assert.ok(!(await records(L)).flagged.includes(o), 'the one with no version settled');
    assert.ok(manifestAt(await c.place(o)), 'and published');
    assert.equal(await within(L.putTranslation(o, 2, png(19)), 10000), 'ended', 'it takes a write meanwhile');
    assert.ok(same(await L.read(o, 2, 'translated'), png(19)));
    back();
    assert.equal(await within(L.scan(c.a), 15000), 'ended', 'the folder\'s check, the third back');
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (app === 'website') await sleep(6500);
    assert.equal(await within(L.flush(), 15000), 'ended');
    const r = await records(L);
    assert.deepEqual(r.flagged, [], 'nothing left to stand');
    assert.ok(!(await L.meta(u))?.parentId, 'the third stood as its folder has it');
    assert.deepEqual(await contradicted(L, [o, m, u]), [], 'no series link left contradicted');
    assert.ok(!metaThere(await c.place(o)).chapters?.some(ch => [m, u].includes(String(ch.id))), 'nor published');
  });
}

// (c) Restated (S39): a gallery left to stand whose manifest this library knows is lost — its place shows none — is
// settled, as a gallery not left to stand in that state is published over (since S31): what the place shows decides,
// not this library's stamp. (The guard that remains — a manifest the same look saw a moment ago, not found by its
// re-read — is held by folder-group-seen.test.mjs.)
for (const app of ['desktop', 'website']) {
  test(`S38 (c), S39: ${app}: a gallery left to stand whose manifest is lost is settled — its change stands, its links tidied, its place published again, a later write lands`, { skip, todo: 'S39' }, async (t) => {
    const c = await made(t, app, 'of this version');
    const { L, o, m } = c;
    await L.setTitle(o, 'Kept, retitled');   // a change of its own, waiting with the command
    await L.raw.seriesCommand('attach', m, o);
    theirs(await c.place(m));
    const dir = await c.place(o), file = /** @type {string} */ (manifestAt(dir));
    fs.rmSync(file);   // lost, for good
    for (let round = 0; round < 2; round++) {
      assert.equal(await within(L.flush(), 15000), 'ended');
      if (app === 'website') await sleep(6500);
      assert.equal(await within(L.scan(c.a), 15000), 'ended', 'a check');
      assert.equal(await within(L.flush(), 15000), 'ended');
    }
    const r = await records(L);
    assert.deepEqual(r.flagged, [], 'nothing left to stand');
    assert.ok(!r.waiting.includes(o), 'nothing of it waits');
    assert.equal(await L.titleOf(o), 'Kept, retitled', 'its own change stands');
    assert.ok(fs.existsSync(file), 'a manifest written again');
    assert.deepEqual(await contradicted(L, [o, m]), [], 'its links tidied against the galleries as they stand');
    assert.equal(await within(L.putTranslation(o, 1, png(21)), 10000), 'ended', 'a later write of it');
    assert.equal(await within(L.flush(), 15000), 'ended');
    assert.ok(same(await L.read(o, 1, 'translated'), png(21)), 'lands');
  });
}

// (d) A flag is its own command's: a gallery listed for a drop, published and grouped again by a new command before the
// drop's transaction, isn't left to stand for the old command.
for (const app of ['desktop', 'website']) {
  test(`S38 (d): ${app}: a gallery published and grouped again by a new command as its old command's drop lands isn't left to stand by it`, { skip }, async (t) => {
    const c = await made(t, app, 'of this version');
    const { L, A, o: y, m: first } = c;
    const z = await L.newGallery('New');
    await L.putPage(z, 1, png(4));
    await L.flush();
    await L.raw.seriesCommand('attach', y, first);
    theirs(await c.place(first));
    // The first one's re-read held at its descriptions (its others listed already); meanwhile y is published — its
    // change waiting and its group's record gone, as its publication's transaction leaves them — and grouped again.
    // (The re-read's first call: the website's listing of the folder, the desktop's look at its page's picture.)
    const reached = gate(), go = gate();
    const dir = rel(A, await c.place(first));
    let once = false;
    const hold = (yes) => (!once && yes ? (once = true, reached.open(), go.at) : null);
    if (app === 'website') fsa.hold((call) => hold(call.op === 'entries' && call.path === dir));
    else faults.holdIn((call) => hold(call.op === 'stat' && rel(A, call.path) === `${dir}/images/0001.png`));
    const standing = L.putTranslation(first, 1, png(30));   // its own work meets the other writer's publication: it stands
    assert.equal(await within(reached.at, 15000), 'ended', 'the first one\'s re-read under way');
    if (app === 'desktop') L.raw._tx(() => { L.raw._s('UPDATE files SET pending = 0 WHERE gid = ?').run(y); L.raw._s('DELETE FROM together WHERE gid = ?').run(y); });
    else {
      const idb = await L.raw.openDB();
      await new Promise((resolve) => {
        const tx = idb.transaction(['folders', 'undescribed'], 'readwrite');
        tx.objectStore('undescribed').delete(y);
        tx.objectStore('folders').delete(`$group:${y}`);
        tx.oncomplete = () => resolve();
      });
    }
    await L.raw.seriesCommand('attach', y, z);
    const grp = (await records(L)).groups[y];
    go.open();
    assert.equal(await within(standing, 15000), 'ended', 'the first one stood');
    const r = await records(L);
    assert.ok(!r.flagged.includes(y), 'not left to stand for the old command');
    assert.equal(r.groups[y], grp, 'still of its new command');
  });
}

// (e) A later series command over a gallery still left to stand (its folder away) drops with it, its other gallery too,
// until that gallery's folder is back (§8).
for (const app of ['desktop', 'website']) {
  test(`S38 (e): ${app}: a later series command over a gallery still left to stand, its folder away, is dropped with it once it is back — never its part alone`, { skip }, async (t) => {
    const c = await made(t, app, 'of this version');
    const { L, A, o, m } = c;
    const h = await L.newGallery('Later');
    await L.putPage(h, 1, png(8));
    await L.flush();
    await L.raw.seriesCommand('attach', o, m);
    theirs(await c.place(m));
    const back = unreadable(L, A, await c.place(o));
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (app === 'website') await sleep(6500);
    assert.ok((await records(L)).flagged.includes(o), 'left to stand, its folder away');
    await L.raw.seriesCommand('attach', o, h);
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (app === 'website') await sleep(6500);
    assert.equal(await within(L.flush(), 15000), 'ended');
    assert.ok(!metaThere(/** @type {string} */ (await L.dirOf(h))).parentId, 'the later command\'s part isn\'t published alone');
    back();
    assert.equal(await within(L.scan(c.a), 15000), 'ended', 'the folder back, checked');
    assert.equal(await within(L.flush(), 15000), 'ended');
    if (app === 'website') await sleep(6500);
    assert.equal(await within(L.flush(), 15000), 'ended');
    const r = await records(L);
    assert.deepEqual(r.flagged, [], 'nothing left to stand');
    assert.ok(!(await L.meta(o))?.chapters?.length && !(await L.meta(h))?.parentId, 'the later command dropped with it');
    assert.deepEqual(await contradicted(L, [o, m, h]), []);
    assert.ok(!metaThere(/** @type {string} */ (await L.dirOf(h))).parentId, 'and never published');
  });
}

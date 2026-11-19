// folder-handover-s33.test.mjs — S33 (review 10): the hand-over's own edges, and what is left of an in-flight write of the
// other app at a take-over. Both apps, over temporary folders (library-drivers.mjs):
// - 10A1: a hand-over's check that ended without reading the folder comes back by itself once that changes — the folder
//   reached again, its claim's read failing once, a hide and show; a second "Take back" while the first check was past
//   its read gets a check of its own; a check the person stopped stays stopped until they act, and "Check all" reads it;
//   a hand-over's read waiting on a busy gallery ends at a stop;
// - 10A2: the wait lasts at most its window of the app's own running time, whatever the clock says;
// - 10B5: where the last claim read names another app, a change is refused 'not-owned', as the folder's row says;
// - 10B7: a move into a folder being handed over says why ('handover');
// - 10B3: a series command spanning two folders is published only when every member's folder can be written;
// - 10B1: a publication deletes no stored description it doesn't supersede; this app's own publication found replaced
//   by another writer's at the same or an earlier generation is reported once;
// - the claim file's rename tried again while Windows refuses it for a moment.
// The drivers' scan and flush pass a hand-over's wait at once (its mark aged); these tests drive the library itself
// (`raw`) and the clock (clockAhead), and look at the mark without asking the folder's answer where that matters.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { desktopLibrary, webLibrary, clockAhead } from './library-drivers.mjs';
import { CLAIM_TTL_MS, HANDOVER_MARGIN_MS } from '../js/storage/folder-owner.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';

const WINDOW = CLAIM_TTL_MS + HANDOVER_MARGIN_MS;
const png = (...tag) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...tag]);
const said = (fn) => Promise.resolve().then(fn).then(() => 'resolved', (e) => e?.reason || e?.code || String(e));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rowOf = async (lib, id) => (await lib.list()).find(f => f.id === id);
const changedBoth = async (lib) => (await lib.list()).flatMap(f => f.attention ?? []).filter(a => a.reason === 'changed-both').map(a => String(a.gid));
// Folder `id`'s hand-over mark as the library keeps it — read without asking the folder (no claim read, so no check
// started by that).
async function markOf(lib, id) {
  if (lib.app === 'desktop') return lib.raw.folders.handover(id);
  const idb = await lib.raw.openDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('folders', 'readonly');
    const q = tx.objectStore('folders').get(id);
    tx.oncomplete = () => resolve(q.result?.handover ?? null);
    tx.onerror = () => reject(tx.error);
  });
}
async function setMark(lib, id, handover) {
  if (lib.app === 'desktop') return lib.raw.folders._setHandover(id, handover);
  const idb = await lib.raw.openDB();
  await new Promise((resolve, reject) => {
    const tx = idb.transaction('folders', 'readwrite');
    const s = tx.objectStore('folders');
    const q = s.get(id);
    q.onsuccess = () => s.put({ ...q.result, handover });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
// Whether `ended()` comes true within `ms` of real time (looked at every 50 ms).
async function within(ms, ended) {
  for (const end = performance.now() + ms; performance.now() < end;) { if (await ended()) return true; await sleep(50); }
  return !!(await ended());
}

const skip = !!globalThis.__desktopLibrary && 'run by npm test';
const pair = async (t, taker) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s33-'));
  const desktop = await desktopLibrary(path.join(dir, 'desktop'));
  const website = await webLibrary();
  t.after(async () => { faults.reset(); fsa.reset(); await desktop.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const [A, B] = taker === 'desktop' ? [desktop, website] : [website, desktop];
  return { dir, A, B, F: path.join(dir, 'F') };
};
// App A's folder F with gallery Alpha (a page); app B uses it anyway, retitles Alpha and keeps it; A has learned of it.
// Resolves { a, b, g }.
async function usedByB({ A, B, F }) {
  const a = await A.add(F);
  await A.setDefault(a);
  const g = await A.newGallery('Alpha');
  await A.putPage(g, 1, png(0, 1));
  await A.flush();
  const b = await B.add(F, { force: true });
  await B.scan(b);
  await B.setTitle(g, 'By B');
  await B.flush();
  clockAhead(CLAIM_TTL_MS + 1000);
  await A.list();
  assert.equal(await said(() => A.setTitle(g, 'Refused')), 'not-owned', 'A has learned that B holds F');
  return { a, b, g };
}
// Folder `a`'s check under way ended — waited for without asking for one (a "Check now" would start one that reads).
async function checked(A, a) {
  if (A.app === 'desktop') await A.raw.folders.job(a)?.catch(() => {});
  else await sleep(400);   // (the website's check polls its wait every 50 ms)
}

describe('S33: review 10 A1 — a hand-over\'s check always comes back', () => {
  for (const taker of ['desktop', 'website']) {
    test(`one that couldn't read the folder (out of reach) is started again by itself once the folder answers again (${taker} takes back)`, { skip }, async (t) => {
      const c = await pair(t, taker);
      const { A, F } = c;
      const { a, g } = await usedByB(c);
      assert.equal(await A.raw.folderClaim(a), 'granted');
      fs.renameSync(F, `${F}.away`);
      clockAhead(WINDOW);   // its check comes to read: the folder isn't there
      await checked(A, a);
      fs.renameSync(`${F}.away`, F);
      assert.ok(await markOf(A, a), 'not read: still to be');
      // The folder answers again (the person's Settings, any write's gate): its check comes back by itself.
      assert.equal(await within(6000, async () => !(await rowOf(A, a)).handover), true, 'read by itself once it is there again');
      assert.equal(await A.titleOf(g), 'By B', 'what B did reads here');
      assert.equal(await said(() => A.setTitle(g, 'Mine')), 'resolved', 'then a change is made');
    });

    test(`one whose claim couldn't be read once as it came to read is started again by itself a moment later (${taker} takes back)`, { skip }, async (t) => {
      const c = await pair(t, taker);
      const { A } = c;
      const { a, g } = await usedByB(c);
      assert.equal(await A.raw.folderClaim(a), 'granted');
      if (A.app === 'desktop') faults.failNext((call) => call.op === 'readFile' && /\.shiori\/owner\.json$/.test(call.path), 'EIO', { times: 1 });
      else fsa.failNext((call) => /\.shiori[\\/]owner\.json$/.test(call.path) && /getFile/.test(call.op), 'NotReadableError', { times: 1 });
      clockAhead(WINDOW);
      await checked(A, a);
      // Nothing asks the folder meanwhile: the read failing is enough for it to come back.
      assert.equal(await within(6000, async () => !(await markOf(A, a))), true, 'read by itself a moment later');
      assert.equal(await A.titleOf(g), 'By B');
    });

    test(`the clock: the wait lasts at most its window of the app's own running time, whatever the mark's time says (${taker} takes back)`, { skip }, async (t) => {
      const c = await pair(t, taker);
      const { A } = c;
      const { a, g } = await usedByB(c);
      assert.equal(await A.raw.folderClaim(a), 'granted');
      // The clock set back an hour (or ahead as a hand-over a kill cut short began): the mark's time an hour from now.
      await setMark(A, a, { at: Date.now() + 3_600_000, wait: true });
      const real = performance.now.bind(performance);
      let ahead = 0;
      performance.now = () => real() + ahead;
      t.after(() => { performance.now = real; });
      await sleep(200);   // its check has begun waiting on that mark
      ahead = WINDOW + 100;   // the window passes in the app's own running time
      assert.equal(await within(3000, async () => !(await markOf(A, a))), true, 'read once its window has passed, not an hour on');
      assert.equal(await A.titleOf(g), 'By B');
    });

    test(`the reason follows the claim: the other app taking the folder back within this app's wait has a change refused as "in use by another app", as its row says (${taker} takes back)`, { skip }, async (t) => {
      const c = await pair(t, taker);
      const { A, B } = c;
      const { a, b, g } = await usedByB(c);
      assert.equal(await A.raw.folderClaim(a), 'granted');
      assert.equal(await B.raw.folderClaim(b), 'granted', 'B takes it back within A\'s wait');
      assert.equal((await rowOf(A, a)).access, 'taken', 'A\'s row: used elsewhere');
      assert.equal(await said(() => A.setTitle(g, 'Mine')), 'not-owned', 'and a change says so');
    });

    test(`a move into a folder being handed over says why (${taker} takes back)`, { skip }, async (t) => {
      const c = await pair(t, taker);
      const { A } = c;
      const { a } = await usedByB(c);
      await A.setDefault(A.home);
      const h = await A.newGallery('Home');
      await A.putPage(h, 1, png(0, 7));
      await A.flush();
      assert.equal(await A.raw.folderClaim(a), 'granted');
      assert.equal(await said(() => A.move(h, a)), 'handover', '"This folder is still being scanned."');
    });
  }

  test('a second "Take back" while the first one\'s check is past its read is read by a check of its own (desktop takes back)', { skip }, async (t) => {
    const c = await pair(t, 'desktop');
    const { A, B } = c;
    const { a, b } = await usedByB(c);
    const f = A.raw.folders, settle = f._settleIn.bind(f);
    let open;
    const gate = new Promise((r) => { open = r; });
    f._settleIn = async (id) => { await gate; return settle(id); };   // the first check's settle held open (a big folder's would take a while)
    t.after(() => { open(); f._settleIn = settle; });
    assert.equal(await A.raw.folderClaim(a), 'granted');
    clockAhead(WINDOW);
    assert.equal(await within(3000, async () => !(await markOf(A, a))), true, 'the first hand-over read');
    assert.equal(await B.raw.folderClaim(b), 'granted', 'the other app uses it anyway at that moment');
    f._probes.clear();
    assert.equal(await A.raw.folderClaim(a), 'granted', 'and this app takes it back once more');
    assert.ok(await markOf(A, a), 'a second hand-over');
    f._settleIn = settle;
    open();
    clockAhead(WINDOW);
    assert.equal(await within(3000, async () => !(await markOf(A, a))), true, 'read by a check of its own after the first');
  });

  test('a folder hidden and shown at once while its hand-over waits is read once shown — the show never joins the stopped check (desktop takes back)', { skip }, async (t) => {
    const c = await pair(t, 'desktop');
    const { A } = c;
    const { a, g } = await usedByB(c);
    await A.setDefault(A.home);
    assert.equal(await A.raw.folderClaim(a), 'granted');
    await A.hide(a);
    await A.show(a);
    clockAhead(WINDOW);
    assert.equal(await within(3000, async () => !(await markOf(A, a))), true, 'read');
    assert.equal(await A.titleOf(g), 'By B');
  });

  test('a hand-over\'s check the person stopped stays stopped until they act on the folder; "Check all" reads it (desktop takes back)', { skip }, async (t) => {
    const c = await pair(t, 'desktop');
    const { A } = c;
    const { a, g } = await usedByB(c);
    assert.equal(await A.raw.folderClaim(a), 'granted');
    const job = A.raw.folders.job(a);
    A.raw.folders.stop(a);   // the person stops "Checking F" from the tasks page
    await job.catch(() => {});
    clockAhead(WINDOW);
    await A.list();
    await sleep(300);
    assert.ok(await markOf(A, a), 'not started again by itself while the person keeps it stopped');
    await A.raw.rescan();   // "Check all"
    assert.equal(await markOf(A, a), null, '"Check all" reads it');
    assert.equal(await A.titleOf(g), 'By B');
  });

  test('a hand-over\'s read waiting on a gallery busy a moment ends at once when its check is stopped (desktop takes back)', { skip }, async (t) => {
    const c = await pair(t, 'desktop');
    const { A } = c;
    const { a, g } = await usedByB(c);
    await A.setDefault(A.home);
    const files = A.raw.files;
    files._writing.set(String(g), new Promise(() => {}));   // a write of it under way, for longer than this test
    t.after(() => files._writing.delete(String(g)));
    assert.equal(await A.raw.folderClaim(a), 'granted');
    const job = A.raw.folders.job(a);
    clockAhead(WINDOW);
    await sleep(400);   // its read has come to the busy gallery
    const stopped = performance.now();
    await A.hide(a);   // stops the check
    await job.catch(() => {});
    assert.ok(performance.now() - stopped < 3000, `ended at the stop (${Math.round(performance.now() - stopped)} ms), not after its wait for the gallery`);
  });
});

// Review 10 B3: the website keeps a series' members where they are, so one series command can span two folders; the
// group was weighed by what could be read, so the part in a folder the other app took between the command and its
// publication was dropped while the rest was published — a member listed twice.
test('S33, review 10 B3: a series command spanning two folders is published only when every member\'s folder can be written — one another app took keeps all of it waiting (website)', { skip }, async (t) => {
  const { dir, A, B } = await pair(t, 'website');
  const F = path.join(dir, 'F'), F2 = path.join(dir, 'F2');
  const a = await A.add(F), a2 = await A.add(F2);
  await A.setDefault(a);
  const one = await A.newGallery('One');
  await A.putPage(one, 1, png(0, 1));
  await A.setDefault(a2);
  const two = await A.newGallery('Two');
  await A.putPage(two, 1, png(0, 2));
  await A.flush();
  const meta = async (gid) => JSON.parse(fs.readFileSync(path.join(await A.dirOf(gid), 'metadata.json'), 'utf8'));
  await A.raw.seriesCommand('attach', one, two);
  const b2 = await B.add(F2, { force: true });   // the other app takes Two's folder before the command is published
  await B.scan(b2);
  clockAhead(CLAIM_TTL_MS + 1000);   // what this app knew of F2 past its time to live: read again at its next write
  await A.flush();
  assert.deepEqual(((await meta(one)).chapters ?? []).map(ch => String(ch.id)), [], 'nothing of the command published while Two\'s folder is another app\'s');
  assert.equal((await meta(two)).parentId ?? null, null);
  assert.equal(await A.raw.folderClaim(a2), 'granted');
  await A.scan(a2);
  await A.flush();
  assert.deepEqual([((await meta(one)).chapters ?? []).map(ch => String(ch.id)), String((await meta(two)).parentId)], [[one, two], one],
    'taken back with nothing changed there: the command published whole');
});

describe('S33: review 10 B1 — an in-flight write of the other app', () => {
  for (const app of ['desktop', 'website']) {
    test(`a publication deletes only the stored descriptions it supersedes, never one no manifest names (another app's publication under way) (${app})`, { skip }, async (t) => {
      const { A, F } = await pair(t, app);
      const a = await A.add(F);
      await A.setDefault(a);
      const g = await A.newGallery('Alpha');
      await A.putPage(g, 1, png(0, 1));
      await A.flush();
      const area = path.join(await A.dirOf(g), '.shiori');
      const named = () => Object.values(JSON.parse(fs.readFileSync(path.join(area, 'gallery.json'), 'utf8')).descriptions);
      const before = named();
      // Another app's publication under way: its description written, its manifest not yet.
      const text = JSON.stringify({ galleryId: g, title: { english: 'In flight', japanese: '', pretty: '' } });
      const theirs = path.join(area, 'd', `${crypto.createHash('sha256').update(text).digest('hex')}.json`);
      fs.writeFileSync(theirs, text);
      await A.setTitle(g, 'Mine');
      await A.flush();
      assert.equal(fs.existsSync(theirs), true, 'the other app\'s description stays');
      const gone = before.filter(d => !named().includes(d));
      assert.ok(gone.length > 0, 'this publication superseded one');
      for (const d of gone) assert.equal(fs.existsSync(path.join(await A.dirOf(g), ...d.split('/'))), false, `what it superseded is collected (${d})`);
    });

    test(`this app's own publication found replaced by another writer's at the same or an earlier generation is reported once; one built on it is not (${app})`, { skip }, async (t) => {
      const { A, F } = await pair(t, app);
      const a = await A.add(F);
      await A.setDefault(a);
      const ids = {};
      for (const [k, n] of [['Same', 1], ['Later', 2]]) { ids[k] = await A.newGallery(k); await A.putPage(ids[k], 1, png(0, n)); }
      await A.flush();
      for (const k of Object.keys(ids)) await A.setTitle(ids[k], `${k} 2`);
      await A.flush();
      // The other app's stalled write landing after this app's publication: its manifest over this one's, at the same
      // generation ('Same'); and, the normal case, the other app's later publication on top ('Later').
      for (const [k, step] of [['Same', 0], ['Later', 1]]) {
        const file = path.join(await A.dirOf(ids[k]), '.shiori', 'gallery.json');
        const m = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...m, generation: m.generation + step, publication: 'f0e1d2c3b4a59687', writer: 'b1b2c3d4e5f60708' }, null, 2));
      }
      await sleep(1200);   // (the website's size timer of the last change gone: a gallery with work due is read at a later check)
      await A.scan(a);
      assert.deepEqual(await changedBoth(A), [ids.Same], 'replaced, not built on: reported; a later one on top: not');
      assert.equal(await A.titleOf(ids.Same), 'Same 2', 'the folder\'s version stands');
      await A.scan(a);
      assert.deepEqual(await changedBoth(A), [ids.Same], 'once');
    });
  }
});

test('S33: the claim file\'s rename is tried again while Windows refuses it for a moment (desktop takes back)', { skip }, async (t) => {
  const c = await pair(t, 'desktop');
  const { A } = c;
  const { a } = await usedByB(c);
  faults.failNext((call) => call.op === 'rename' && /\.shiori\/owner\.json\.[0-9a-f]+\.shiori-tmp$/.test(call.path), 'EPERM', { times: 2 });
  assert.equal(await said(() => A.raw.folderClaim(a)), 'resolved', 'taken back');
  assert.ok(await markOf(A, a), 'its hand-over begun');
});

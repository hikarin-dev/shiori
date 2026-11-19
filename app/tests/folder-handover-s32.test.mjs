// folder-handover-s32.test.mjs — S32 (review 9): a folder that comes (back) to an app is read before it is that
// app's (storage/folder-owner.js, the hand-over). Both apps, over one temporary folder (library-drivers.mjs):
// - a change asked at once after "Take back" or "Use anyway" is refused for now ('handover'), the folder listed as
//   this app's with its check running; once the check has read the folder the change is made on its version;
// - the taker waits out the other app's window: what that app accepted in it has landed before the read;
// - a kill between any two steps of a hand-over leaves the folder to be read: the next start finishes it;
// - review 9's findings: 9B1 (a series command from an older view half applied), 9A3 (a retirement deleting what
//   another app's publication names), 9B2 (a gallery passed over as busy at the take-back's check), 9B3 (a gallery
//   kept outside a series that no longer lists it), 9A1 (a write making a gallery's folder again);
// - one app alone never meets any of it.
// The drivers' scan and flush pass a hand-over's wait at once (its mark aged); a test about that window calls the
// library itself (`raw`) and moves the clock (clockAhead). Two tests run the real constants end to end.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopLibrary, webLibrary, desktopKilled, pageNow, pageCalling, clockAhead } from './library-drivers.mjs';
import { CLAIM_TTL_MS, HANDOVER_MARGIN_MS } from '../js/storage/folder-owner.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';

const png = (...tag) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...tag]);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const said = (fn) => Promise.resolve().then(fn).then(() => 'resolved', (e) => e?.reason || e?.code || String(e));
const named = (english) => ({ english, japanese: '', pretty: '' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rowOf = async (lib, id) => (await lib.list()).find(f => f.id === id);
const changedBoth = async (lib) => (await lib.list()).flatMap(f => f.attention ?? []).filter(a => a.reason === 'changed-both').map(a => String(a.gid));
// `work` done on app `lib` while folder `dir`'s drive is away: what it changes waits.
async function whileAway(lib, dir, work) {
  fs.renameSync(dir, `${dir}.away`);
  try { await work(); await lib.flush(); } finally { fs.renameSync(`${dir}.away`, dir); }
}
// The galleries `lib` lists with series merged (a chapter shown in its series), by name.
async function listed(lib, names) {
  const ids = (await lib.raw.galleriesPage({ sort: 'id', limit: 100 })).map(e => String(e.galleryId ?? e.id));
  return Object.keys(names).filter(k => ids.includes(names[k])).sort();
}
// Every gallery's metadata.json in folder `F` naming a series (parentId) is listed in that series' first gallery's
// chapters there: no gallery names a series whose first gallery doesn't list it (review 9 B1).
function seriesWhole(F) {
  const metas = new Map();
  for (const p of fs.readdirSync(F, { recursive: true }).map(String).filter(p => /(^|[\\/])metadata\.json$/.test(p) && !p.startsWith('.shiori'))) {
    const m = JSON.parse(fs.readFileSync(path.join(F, p), 'utf8'));
    metas.set(String(m.galleryId), m);
  }
  const wrong = [];
  for (const [gid, m] of metas) {
    if (!m.parentId) continue;
    const owner = metas.get(String(m.parentId));
    if (!owner?.chapters?.some(c => String(c.id) === gid)) wrong.push(`${m.title?.english ?? gid} names a series that doesn't list it`);
  }
  return wrong;
}

const skip = !!globalThis.__desktopLibrary && 'run by npm test';
const pair = async (t, taker) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s32-'));
  const desktop = await desktopLibrary(path.join(dir, 'desktop'));
  const website = await webLibrary();
  t.after(async () => { faults.reset(); fsa.reset(); await desktop.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const [A, B] = taker === 'desktop' ? [desktop, website] : [website, desktop];
  return { dir, A, B, F: path.join(dir, 'F') };
};
// App A's folder F with gallery Alpha (two pages); app B uses it anyway, retitles Alpha and translates page 1, and
// keeps it; app A has learned of it (a change refused). Resolves { a, b, g }.
async function usedByB({ A, B, F }) {
  const a = await A.add(F);
  await A.setDefault(a);
  const g = await A.newGallery('Alpha');
  for (let n = 1; n <= 2; n++) await A.putPage(g, n, png(0, n));
  await A.flush();
  const b = await B.add(F, { force: true });   // "Use anyway"
  await B.scan(b);
  await B.setTitle(g, 'By B');
  await B.putTranslation(g, 1, png(0, 71));
  await B.flush();
  clockAhead(CLAIM_TTL_MS + 1000);
  await A.list();
  assert.equal(await said(() => A.setTitle(g, 'Refused')), 'not-owned', 'A has learned that B holds F');
  return { a, b, g };
}

describe('S32: the hand-over', () => {
  for (const taker of ['desktop', 'website']) {
    test(`a folder taken back is read before it is this app's — a change at once refused for now, the folder listed as this app's, its check running; once read, the change made on its version (${taker} takes back)`, { skip }, async (t) => {
      const c = await pair(t, taker);
      const { A, B, F } = c;
      const { a, b, g } = await usedByB(c);
      assert.equal(await A.raw.folderClaim(a), 'granted', 'taken back');
      const row = await rowOf(A, a);
      assert.deepEqual([row.access, !!row.handover], ['granted', true], 'listed as this app\'s, its check reading it');
      for (const [what, fn] of [['a title', () => A.setTitle(g, 'Mine')], ['a translation', () => A.putTranslation(g, 2, png(0, 82))], ['a page', () => A.putPage(g, 3, png(0, 3))],
        ['a deletion', () => A.deleteGallery(g)], ['a series', () => A.raw.seriesCommand('write', g, [{ id: g, title: 'Alpha' }], { seriesTitle: named('Saga') })]]) {
        assert.equal(await said(fn), 'handover', `${what} at once: refused for now`);
      }
      assert.equal(await said(() => A.remove(a)), 'handover', 'the folder\'s removal too');
      await A.scan(a);
      assert.equal((await rowOf(A, a)).handover, undefined, 'read: the folder is this app\'s');
      assert.deepEqual([await A.titleOf(g), same(await A.read(g, 1, 'translated'), png(0, 71))], ['By B', true], 'what B did reads here');
      assert.equal(await said(() => A.setTitle(g, 'Mine')), 'resolved', 'then accepted');
      await A.putTranslation(g, 2, png(0, 82));
      await A.flush();
      assert.deepEqual(await changedBoth(A), [], 'nothing dropped');
      await A.setDefault(A.home);
      await A.remove(a);
      await B.raw.folderClaim(b);
      await B.scan(b);
      assert.deepEqual([await B.titleOf(g), same(await B.read(g, 1, 'translated'), png(0, 71)), same(await B.read(g, 2, 'translated'), png(0, 82))], ['Mine', true, true],
        'B reads this app\'s change on its own work');
      void F;
    });

    // B, which hasn't read A's claim yet, translates the gallery in its window: on the desktop it keeps the gallery in
    // an archive, and its settle writes that change into the folder at once (an unpack: its publication lands); on the
    // website its picture lands and its publication waits (the store reads the claim afresh as it opens). Either way
    // A's check reads nothing before the window has passed, then reads what landed; A's change after the read is made
    // on it, and B's waiting part is weighed at its own take-back.
    test(`the taker waits out the other app's window: what that app wrote in it has landed before the read, and this app's change after the read is made on it (${taker} takes back)`, { skip }, async (t) => {
      const c = await pair(t, taker);
      const { A, B } = c;
      const { a, b, g } = await usedByB(c);
      if (B.app === 'desktop') {
        assert.deepEqual((await B.raw.archiveGallery(g)).archived, [g], 'B keeps it in an archive');
        await B.flush();
        await A.scan(a).catch(() => {});   // (refused: A holds no claim — nothing read)
      }
      await B.list();   // B has just read its claim: its writes take the folder for its own for a while yet
      assert.equal(await A.raw.folderClaim(a), 'granted');
      const reading = A.raw.folderScan(a);   // its check, started by itself too: joined — it waits out B's window
      reading.catch(() => {});
      await sleep(150);
      assert.equal((await rowOf(A, a)).handover, true, 'not read yet: B\'s window is still open');
      await B.putTranslation(g, 2, png(0, 72));   // B hasn't read A's claim yet: accepted
      await B.flush();
      clockAhead(CLAIM_TTL_MS + HANDOVER_MARGIN_MS);
      await reading;
      // (On the desktop B's settle unpacked its archive into a folder at once — a publication — and A's read follows
      // the gallery there; the translation's own publication waits at B, the store reading the claim as it opens.)
      if (B.app === 'desktop') assert.equal(await A.dirOf(g), path.join(c.F, 'Alpha'), 'read after B\'s window: what landed in it is where A reads the gallery');
      assert.equal(same(await A.read(g, 2, 'translated'), png(0, 72)), false, 'B\'s translation not published: waiting at B');
      assert.equal(await said(() => A.setTitle(g, 'Mine')), 'resolved');
      await A.flush();
      assert.deepEqual([await A.titleOf(g), await changedBoth(A)], ['Mine', []], 'made on the folder\'s version, nothing dropped');
      await A.setDefault(A.home);
      await A.remove(a);
      await B.raw.folderClaim(b);
      await B.scan(b);
      assert.equal(await B.titleOf(g), 'Mine', 'B reads the folder\'s version');
      assert.deepEqual(await changedBoth(B), [g], 'B\'s change that waited, dropped there (A changed the gallery since), is reported there');
    });

    test(`"Use anyway": a folder another app holds is read before it is this app's — a gallery made meanwhile waits and goes there after (${taker} uses it anyway)`, { skip }, async (t) => {
      const { A, B, F } = await pair(t, taker);
      const b = await B.add(F);
      await B.setDefault(b);
      const g = await B.newGallery('Theirs');
      await B.putPage(g, 1, png(0, 1));
      await B.flush();
      const a = await A.add(F, { force: true });
      assert.equal((await rowOf(A, a)).handover, true, 'a hand-over: the folder read first');
      await A.setDefault(a);   // allowed meanwhile: what is made there waits
      const mine = await A.newGallery('Mine');
      await A.putPage(mine, 1, png(0, 9));
      await A.scan(a);
      await A.flush();
      assert.deepEqual((await A.galleries()).map(String).sort(), [g, mine].sort(), 'both');
      assert.ok(fs.readdirSync(F).includes('Mine'), 'the gallery made meanwhile went to the folder once it was read');
    });
  }
});

// Review 9 B1: a series command changing several galleries, weighed gallery by gallery, was half applied when made
// from a view of the series' first gallery older than the folder's — that gallery's part dropped and reported, the
// chapter's part published, the chapter then naming a series that doesn't list it (listed nowhere with series
// merged). A command is weighed as one: asked at once after "Take back" it waits for the read (then made on the
// folder's version); one made while the drive was away is dropped whole where any gallery of it meets another
// publication, every part reported.
describe('S32: review 9 B1 — a series command is weighed as one', () => {
  for (const taker of ['desktop', 'website']) {
    for (const cmd of ['attach', 'write']) {
      test(`asked at once after "Take back" it waits for the read, then is made on the folder's version — never half applied (${taker} takes back, ${cmd})`, { skip }, async (t) => {
        const { A, B, F } = await pair(t, taker);
        const a = await A.add(F);
        await A.setDefault(a);
        const ids = {};
        for (const [k, n] of [['One', 1], ['Two', 2], ['Three', 3]]) { ids[k] = await A.newGallery(k); await A.putPage(ids[k], 1, png(0, n)); }
        await A.flush();
        const b = await B.add(F, { force: true });
        await B.scan(b);
        await B.raw.seriesCommand('write', ids.One, [{ id: ids.One, title: 'One' }, { id: ids.Two, title: 'Two' }], { seriesTitle: named('Saga') });
        await B.flush();
        clockAhead(CLAIM_TTL_MS + 1000);
        assert.equal(await A.raw.folderClaim(a), 'granted');
        const command = () => (cmd === 'attach' ? A.raw.seriesCommand('attach', ids.One, ids.Three)
          : A.raw.seriesCommand('write', ids.One, [{ id: ids.One, title: 'One' }, { id: ids.Two, title: 'Two' }, { id: ids.Three, title: 'Three' }], { seriesTitle: named('Saga') }));
        assert.equal(await said(command), 'handover', 'at once: refused for now');
        await A.scan(a);
        assert.equal(await said(command), 'resolved', 'once read: made');
        await A.flush();
        assert.deepEqual(seriesWhole(F), [], 'no gallery names a series that doesn\'t list it');
        await A.setDefault(A.home);
        await A.remove(a);
        await B.raw.folderClaim(b);
        await B.scan(b);
        assert.deepEqual((await B.raw.seriesChapters(ids.One)).map(c => c.id).sort(), [ids.One, ids.Two, ids.Three].sort(), 'the other app reads the series holding all three');
      });
    }
    test(`one made while the drive was away, its first gallery changed by the other app meanwhile, is dropped whole at the take-back and reported — the chapter's part never published (${taker} takes back)`, { skip }, async (t) => {
      const { A, B, F } = await pair(t, taker);
      const a = await A.add(F);
      await A.setDefault(a);
      const ids = {};
      for (const [k, n] of [['One', 1], ['Three', 3]]) { ids[k] = await A.newGallery(k); await A.putPage(ids[k], 1, png(0, n)); }
      await A.flush();
      await whileAway(A, F, () => A.raw.seriesCommand('write', ids.One, [{ id: ids.One, title: 'One' }, { id: ids.Three, title: 'Three' }], { seriesTitle: named('Other') }));
      const b = await B.add(F, { force: true });
      await B.scan(b);
      await B.setTitle(ids.One, 'One by B');   // a change of the series' first gallery there
      await B.flush();
      clockAhead(CLAIM_TTL_MS + 1000);
      assert.equal(await A.raw.folderClaim(a), 'granted');
      await A.scan(a);
      await A.flush();
      assert.deepEqual(seriesWhole(F), [], 'no gallery names a series that doesn\'t list it');
      assert.equal(String((await A.meta(ids.Three))?.parentId ?? ''), '', 'the chapter\'s part dropped with the first gallery\'s');
      assert.deepEqual(await listed(A, ids), ['One', 'Three'], 'both listed');
      assert.deepEqual((await changedBoth(A)).sort(), [ids.One, ids.Three].sort(), 'the whole command reported dropped');
      assert.equal(await A.titleOf(ids.One), 'One by B', 'the folder\'s version stands');
      await A.setDefault(A.home);
      await A.remove(a);
      await B.raw.folderClaim(b);
      await B.scan(b);
      assert.deepEqual(await listed(B, ids), ['One', 'Three'], 'the other app lists both too');
    });
  }
});

// Review 9 B2: the take-back's check passed over a gallery the website was busy with (a timer of its pending: a
// favorite pressed), leaving the older view shown — the old title, a page that won't read — until "Check now". A
// hand-over's read passes over none.
test('S32: review 9 B2 — the take-back\'s check reads a gallery the website is busy with', { skip }, async (t) => {
  const { A: W, B: D, F } = await pair(t, 'website');
  const w = await W.add(F);
  await W.setDefault(w);
  const g = await W.newGallery('Gee');
  for (let n = 1; n <= 2; n++) await W.putPage(g, n, png(0, n));
  await W.flush();
  const d = await D.add(F, { force: true });
  await D.scan(d);
  await D.putPage(g, 1, png(0, 99));
  await D.setTitle(g, 'Gee by D');
  await D.flush();
  clockAhead(CLAIM_TTL_MS + 1000);
  assert.equal(await W.raw.folderClaim(w), 'granted');
  await W.favorite(g, true);   // busy with it as its check runs
  assert.equal(W.raw.galleryBusy(g), true, 'busy');
  await W.scan(w);
  assert.deepEqual([await W.titleOf(g), same(await W.read(g, 1), png(0, 99))], ['Gee by D', true], 'read all the same');
});

// Review 9 B3: a series' chapter the other app deleted (the series dissolved) stayed here as a chapter of a series
// that no longer lists it — listed nowhere, so it couldn't be deleted. Kept, it is kept outside the series.
describe('S32: review 9 B3 — a gallery kept whose series no longer lists it is kept outside it', () => {
  for (const taker of ['desktop', 'website']) {
    test(`listed, and deletable (${taker} keeps it)`, { skip }, async (t) => {
      const { A, B, F } = await pair(t, taker);
      const a = await A.add(F);
      await A.setDefault(a);
      const ids = {};
      for (const [k, n] of [['G2', 2], ['G3', 3]]) { ids[k] = await A.newGallery(k); await A.putPage(ids[k], 1, png(0, n)); }
      await A.raw.seriesCommand('write', ids.G2, [{ id: ids.G2, title: 'G2' }, { id: ids.G3, title: 'G3' }], { seriesTitle: named('Saga') });
      await A.flush();
      const b = await B.add(F, { force: true });
      await B.scan(b);
      await B.deleteGallery(ids.G3);   // the series dissolves
      await B.flush();
      clockAhead(CLAIM_TTL_MS + 1000);
      assert.equal(await A.raw.folderClaim(a), 'granted');
      await A.scan(a);
      assert.deepEqual(await listed(A, ids), ['G2', 'G3'], 'the chapter whose folder is gone is listed on its own');
      assert.equal(await said(() => A.deleteGallery(ids.G3)), 'resolved', 'and the person can delete it');
    });
  }
});

// A kill between any two steps of a hand-over (S32 point 2): the mark is written before the claim file, cleared once
// the check has read the folder, so the next start finds it and finishes the hand-over (its check starts by itself) —
// or, killed before the claim file, finds the folder still the other app's: "Take back" again. Meanwhile nothing of
// this app's older view is written: the gallery's place holds the other app's publication until this app's check has
// read it, and this app's change that waited from the drive's absence is dropped and reported there (the other app
// changed the gallery). npm test kills at a spread of the file calls from "Take back" to the check's end;
// SHIORI_S32_KILLS=all at every one.
const KILLS_ALL = process.env.SHIORI_S32_KILLS === 'all';
const spread = (n) => (KILLS_ALL ? Array.from({ length: n }, (_, i) => i + 1) : [...new Set([1, 2, 3, Math.ceil(n / 4), Math.ceil(n / 2), Math.ceil((3 * n) / 4), n - 1, n].filter(k => k >= 1 && k <= n))]);
describe('S32: a kill between any two steps of a hand-over', () => {
  // The desktop killed (desktopKilled: a child process that exits at the k-th file call from "Take back" on).
  test('the desktop killed at a file call from "Take back" to its check\'s end: the next start finishes the hand-over, nothing written from its older view', { skip }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s32k-'));
    t.after(async () => { faults.reset(); fsa.reset(); fs.rmSync(root, { recursive: true, force: true }); });
    // One run: the desktop's F with Alpha, its title made while the drive was away (waiting); the website uses F
    // anyway, retitles Alpha and translates page 1, keeping it. Resolves what the run needs.
    const setUp = async (n) => {
      const base = path.join(root, `run ${n}`), F = path.join(base, 'F');
      const D = await desktopLibrary(base);
      const id = await D.add(F);
      await D.setDefault(id);
      const g = await D.newGallery('Alpha');
      for (let p = 1; p <= 2; p++) await D.putPage(g, p, png(0, p));
      await D.flush();
      await whileAway(D, F, () => D.setTitle(g, 'Mine, waiting'));
      await D.close();
      const W = await webLibrary();
      const w = await W.add(F, { force: true });
      await W.scan(w);
      await W.setTitle(g, 'By W');
      await W.putTranslation(g, 1, png(0, 71));
      await W.flush();
      clockAhead(CLAIM_TTL_MS + 1000);
      return { base, F, id, g, W, w };
    };
    const manifest = (F) => JSON.parse(fs.readFileSync(path.join(F, 'Alpha', '.shiori', 'gallery.json'), 'utf8'));
    const work = async ({ lib, kill, id, out, at }) => {
      const fs = await import('node:fs');
      let n = 0;
      kill(() => ++n === at);
      try { await lib.raw.folderClaim(id); await lib.scan(id); await lib.flush(); } finally { fs.writeFileSync(out, String(n)); }
    };
    const dry = await setUp(0);
    const counted = path.join(root, 'calls');
    assert.equal(desktopKilled(dry.base, work, { id: dry.id, out: counted, at: Infinity }), 0);
    const calls = Number(fs.readFileSync(counted, 'utf8'));
    assert.ok(calls > 10, `calls from "Take back" to the check's end: ${calls}`);
    for (const k of spread(calls)) {
      const r = await setUp(k);
      const before = manifest(r.F);
      assert.ok([0, 42].includes(desktopKilled(r.base, work, { id: r.id, out: counted, at: k })), `killed at call ${k} of ${calls} (or done first)`);
      assert.deepEqual([manifest(r.F).writer, manifest(r.F).generation], [before.writer, before.generation], `${k}: nothing published from the older view`);
      const D = await desktopLibrary(r.base);
      try {
        if ((await rowOf(D, r.id)).access !== 'granted') await D.raw.folderClaim(r.id);   // killed before its claim was written: "Take back" again
        await D.flush();
        assert.equal((await rowOf(D, r.id)).handover, undefined, `${k}: the hand-over finished`);
        assert.deepEqual([await D.titleOf(r.g), same(await D.read(r.g, 1, 'translated'), png(0, 71))], ['By W', true], `${k}: the folder's version stands`);
        assert.deepEqual(await changedBoth(D), [r.g], `${k}: the change that waited, dropped, reported`);
        assert.equal(manifest(r.F).files.pages[1].translated, before.files.pages[1].translated, `${k}: the other app's translation named still`);
      } finally { await D.close(); }
      await r.W.setDefault(r.W.home);
      await r.W.remove(r.w, { discard: true }).catch(() => {});
    }
  });

  // The website's page dying (its file calls never return from the k-th on: the page closed), then loaded again.
  test('the website\'s page dying at a file call from "Take back" to its check\'s end: the page loaded again finishes the hand-over, nothing written from its older view', { skip }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s32k-'));
    const D = await desktopLibrary(path.join(root, 'desktop'));
    // A page's Web Locks go with it: the in-context ones, each page's own (folder-store-web.js withLock).
    Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
    t.after(async () => { faults.reset(); fsa.reset(); await D.close(); fs.rmSync(root, { recursive: true, force: true }); delete /** @type {any} */ (globalThis.navigator).locks; });
    const W = await webLibrary();
    const setUp = async (n) => {
      const F = path.join(root, `F ${n}`);
      const w = await W.add(F);
      await W.setDefault(w);
      const g = await W.newGallery('Alpha');
      for (let p = 1; p <= 2; p++) await W.putPage(g, p, png(0, p));
      await W.flush();
      await whileAway(W, F, () => W.setTitle(g, 'Mine, waiting'));
      const d = await D.add(F, { force: true });
      await D.scan(d);
      await D.setTitle(g, 'By D');
      await D.putTranslation(g, 1, png(0, 71));
      await D.flush();
      clockAhead(CLAIM_TTL_MS + 1000);
      await W.list();
      return { F, w, g, d };
    };
    const manifest = (F) => JSON.parse(fs.readFileSync(path.join(F, 'Alpha', '.shiori', 'gallery.json'), 'utf8'));
    const takeBack = async (w) => { await W.raw.folderClaim(w); await W.scan(w); await W.flush(); };
    // The calls from "Take back" to the check's end, counted on a run of its own.
    const dry = await setUp(0);
    let calls = 0;
    const undoCount = fsa.failNext(() => { calls++; return false; }, 'NotReadableError', { times: Infinity });
    try { await takeBack(dry.w); } finally { undoCount(); }
    assert.ok(calls > 10, `calls from "Take back" to the check's end: ${calls}`);
    for (const k of spread(calls)) {
      if (!W.restart) break;   // (the harness's page loads spent)
      const r = await setUp(k);
      const before = manifest(r.F);
      let n = 0, dead = null, died = () => {};
      const death = new Promise((res) => { died = res; });
      const undo = fsa.hang((c) => {
        const page = pageCalling();
        if (page != null && page === dead) return true;
        if (dead != null || page !== pageNow() || ++n !== k) return false;
        dead = page;
        died();
        return true;
      });
      const run = takeBack(r.w).catch(() => {});
      await Promise.race([death, run]);
      undo();
      assert.deepEqual([manifest(r.F).writer, manifest(r.F).generation], [before.writer, before.generation], `${k}: nothing published from the older view`);
      await W.restart();
      if ((await rowOf(W, r.w)).access !== 'granted') await W.raw.folderClaim(r.w);   // died before its claim was written
      await W.flush();
      assert.equal((await rowOf(W, r.w)).handover, undefined, `${k}: the hand-over finished`);
      assert.deepEqual([await W.titleOf(r.g), same(await W.read(r.g, 1, 'translated'), png(0, 71))], ['By D', true], `${k}: the folder's version stands`);
      assert.ok((await changedBoth(W)).includes(r.g), `${k}: the change that waited, dropped, reported`);
      await W.setDefault(W.home);
      await W.remove(r.w, { discard: true }).catch(() => {});
      await D.setDefault(D.home);
      await D.remove(r.d, { discard: true }).catch(() => {});
    }
  });
});

// One app alone never meets a hand-over (S32 point 9): a first run, a folder made or added that no other app had, one
// removed and added back untouched (its removal ended, or called off), a restart — no mark, no wait, nothing refused.
describe('S32: one app alone never meets a hand-over', () => {
  for (const app of ['desktop', 'website']) {
    test(`a folder added fresh, removed and added back, called off, a restart — no hand-over, every change at once (${app})`, { skip }, async (t) => {
      const { A, F, dir } = await pair(t, app);
      const quiet = async (id, g, label) => {
        assert.equal((await rowOf(A, id))?.handover, undefined, `${label}: no hand-over`);
        assert.equal(await said(() => A.setTitle(g, label)), 'resolved', `${label}: a change at once`);
        await A.flush();
      };
      const a = await A.add(F);
      await A.setDefault(a);
      const g = await A.newGallery('Alpha');
      await A.putPage(g, 1, png(0, 1));
      await A.flush();
      await quiet(a, g, 'added fresh');
      if (A.restart) { await A.restart(); await quiet(a, g, 'after a restart'); }
      await A.setDefault(A.home);
      await A.remove(a);   // forgotten: its claim let go by this library
      const back = await A.add(F);
      await A.scan(back);
      await quiet(back, g, 'removed and added back untouched');
      const F2 = path.join(dir, 'F2');
      const two = await A.add(F2);
      assert.equal((await rowOf(A, two))?.handover, undefined, 'a folder no app had: no hand-over');
    });
  }
});

// The real constants, end to end (no clock moved, no mark aged): "Take back" over a claim the other app holds; a
// change is refused until the window and the margin have passed and the check has read the folder, then accepted.
describe('S32: the real wait', () => {
  for (const taker of ['desktop', 'website']) {
    test(`a change refused for about ${(CLAIM_TTL_MS + HANDOVER_MARGIN_MS) / 1000} s after "Take back", then accepted (${taker})`, { skip }, async (t) => {
      const c = await pair(t, taker);
      const { A } = c;
      const { a, g } = await usedByB(c);
      const at = Date.now();
      assert.equal(await A.raw.folderClaim(a), 'granted');
      assert.equal(await said(() => A.setTitle(g, 'Mine')), 'handover', 'at once: refused for now');
      while ((await rowOf(A, a)).handover && Date.now() - at < 20_000) await sleep(200);
      const took = Date.now() - at;
      assert.ok(took >= CLAIM_TTL_MS + HANDOVER_MARGIN_MS - 50, `the check read the folder after ${took} ms, not before the window and the margin`);
      assert.equal(await said(() => A.setTitle(g, 'Mine')), 'resolved', 'then accepted');
    });
  }
});

// Review 9 A3: the desktop killed while an archiving deletes the gallery's old folder; the website, which knew the
// gallery at that folder, uses the folder anyway and changes the gallery there; the desktop starts, takes it back —
// and the leftover of its archiving deleted the pages the website's version names. A retirement holds the place it
// deletes from: the folder now holds another publication, so nothing is deleted there; the check follows the gallery
// to it (the later publication stands), the archive retired only where it holds nothing that version lacks — else
// kept beside it, with what the killed run had already deleted reported missing.
test('S32: review 9 A3 — an archiving cut short never deletes what the other app published into the old folder since', { skip }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s32r-'));
  t.after(async () => { faults.reset(); fsa.reset(); fs.rmSync(root, { recursive: true, force: true }); });
  const named = (F) => { const m = JSON.parse(fs.readFileSync(path.join(F, 'Alpha', '.shiori', 'gallery.json'), 'utf8')); return Object.values(m.files.pages).flatMap(p => Object.values(p)); };
  for (const k of [1, 2, 3, 4]) {
    const base = path.join(root, `run ${k}`), F = path.join(base, 'F');
    let D = await desktopLibrary(base);
    const id = await D.add(F);
    await D.setDefault(id);
    const g = await D.newGallery('Alpha');
    for (let p = 1; p <= 2; p++) await D.putPage(g, p, png(0, p));
    await D.flush();
    const W = await webLibrary();
    const w = await W.add(F, { force: true });   // the website reads Alpha at its folder once
    await W.scan(w);
    clockAhead(CLAIM_TTL_MS + 1000);
    assert.equal(await D.raw.folderClaim(id), 'granted');
    await D.scan(id);
    await D.close();
    // The desktop archives Alpha and is killed at the k-th look or deletion inside its old folder.
    desktopKilled(base, async ({ lib, kill, g, k }) => {
      const fs = await import('node:fs');
      let n = 0;
      kill((c) => ['stat', 'rm', 'unlink'].includes(c.op) && /\/F\/Alpha\//.test(c.path) && fs.existsSync(c.path.replace(/\/F\/Alpha\/.*$/, '/F/Alpha.zip')) && ++n === k);
      await lib.raw.files.archive(g);
    }, { g, k });
    const left = new Set(fs.readdirSync(path.join(F, 'Alpha'), { recursive: true }).map(p => `${p}`.replaceAll('\\', '/')));
    // The website uses the folder anyway again, and changes Alpha there.
    clockAhead(CLAIM_TTL_MS + 1000);
    assert.equal(await W.raw.folderClaim(w), 'granted');
    await W.scan(w);
    await W.putTranslation(g, 1, png(0, 71));
    await W.setTitle(g, 'Alpha by the website');
    await W.flush();
    // The desktop starts again and takes the folder back.
    D = await desktopLibrary(base);
    try {
      clockAhead(CLAIM_TTL_MS + 1000);
      assert.equal(await D.raw.folderClaim(id), 'granted');
      for (let i = 0; i < 2; i++) { await D.scan(id); await D.flush(); }
      const missing = named(F).filter(f => !fs.existsSync(path.join(F, 'Alpha', ...f.split('/'))));
      assert.deepEqual(missing.filter(f => left.has(f)), [], `${k}: nothing a shown publication names deleted after "Take back"`);
      assert.deepEqual([await D.titleOf(g), same(await D.read(g, 1, 'translated'), png(0, 71))], ['Alpha by the website', true], `${k}: the later publication stands on the desktop`);
      if (missing.length) {
        assert.ok(fs.existsSync(path.join(F, 'Alpha.zip')), `${k}: what is missing (deleted before "Take back") is in the archive, kept beside it`);
        assert.ok((await D.list()).find(f => f.id === id).attention.some(a => a.reason === 'missing-file'), `${k}: and reported`);
      }
      await D.setDefault(D.home);
      await D.remove(id, { discard: true });
    } finally { await D.close(); }
    await W.raw.folderClaim(w);
    await W.scan(w);
    assert.deepEqual([await W.titleOf(g), same(await W.read(g, 1, 'translated'), png(0, 71))], ['Alpha by the website', true], `${k}: the same version on the website`);
    await W.setDefault(W.home);
    await W.remove(w, { discard: true });
  }
});

// Review 9 A1: a write into a gallery's folder racing its regroup (the folder renamed into its series' folder between
// the write's look and its mkdir) made the gallery's folder again at its old name, holding the picture.
test('S32: review 9 A1 — a write into a gallery\'s folder never makes that folder again', { skip }, async (t) => {
  const { writeNewIn } = await import('../../desktop/server/folder-store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-s32-'));
  t.after(() => { faults.reset(); fs.rmSync(dir, { recursive: true, force: true }); });
  const G = path.join(dir, 'Two');
  fs.mkdirSync(G);
  let moved = false;
  faults.failNext((c) => {
    if (!moved && c.op === 'mkdir') { moved = true; fs.mkdirSync(path.join(dir, 'Saga')); fs.renameSync(G, path.join(dir, 'Saga', 'Saga Ch. 002')); }
    return false;
  }, 'EIO', { times: Infinity });
  await assert.rejects(writeNewIn(G, 'translated/0001', 'png', png(0, 1)), (e) => e?.code === 'ENOENT', 'the write fails');
  assert.equal(fs.existsSync(G), false, 'the gallery\'s folder not made again at its old name');
});

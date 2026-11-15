// folder-handover.test.mjs — one library folder used by both apps in turn (plan §6.2): what one app
// wrote, the other reads whole, in both directions. Both libraries work on the same temporary folder
// in one test: the desktop's as it is, the website's under Node over real folders (library-drivers.mjs,
// fsa-node.mjs).
//
// The cases: a gallery written by one app, then each slot replaced (the same format: a suffixed name;
// a format change) with the old files left behind — every delete refused — read by the other with every
// slot's bytes matching; a linked ZIP's overlay, its translation on the page it was made for; claims
// moving between the apps; and a gallery the desktop archived, read in place by the website, changed
// there (unpacked) and read back by the desktop; and a gallery in the desktop's oldest format, converted
// by the desktop's check (D18), read by the website; a series whose chapters one app kept in two
// library folders, whole again once the other app has both; and the person's own marks (favorite,
// reading progress: D6), which stay with the library that set them — an earlier version's favorite in
// a folder taken in once as its gallery joins.
//
// A case that fails on today's code because of a finding a later step fixes is marked todo with that
// step (plans/library-storage-plan.md §5).
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { desktopLibrary, webLibrary, desktopKilled, pageNow, pageCalling, clockAhead } from './library-drivers.mjs';
import { CLAIM_TTL_MS } from '../js/storage/folder-owner.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { zipCreate } from '../js/zip.js';
import { legacyGallery, v1Gallery, seriesExport } from './fixtures/storage-fixtures.mjs';

const png = (...tag) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...tag]);
const webp = (...tag) => new Uint8Array([0x52, 0x49, 0x46, 0x46, ...tag]);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const reason = (p) => p.then(() => 'resolved', (e) => e.reason || e.code || String(e));

// The slots of one gallery, then each replaced: a page's original and translation in the same format
// (the new file takes a suffixed name beside the old one) and in another (a second layout name).
const FIRST = [[1, 'original', png(1, 1)], [2, 'original', png(2, 1)], [1, 'translated', png(1, 2)], [2, 'translated', png(2, 2)]];
const SECOND = [[1, 'original', png(1, 3), 'image/png'], [2, 'original', webp(2, 3), 'image/webp'],
  [1, 'translated', webp(1, 4), 'image/webp'], [2, 'translated', png(2, 4), 'image/png']];
async function write(lib, gid, slots) {
  for (const [n, slot, bytes, type] of slots) {
    if (slot === 'original') await lib.putPage(gid, n, bytes, type); else await lib.putTranslation(gid, n, bytes, type);
  }
}
// The slots `lib` reads that differ from what was written last: [] when every one matches.
async function mismatches(lib, gid, slots) {
  const out = [];
  for (const [n, slot, bytes] of slots) {
    const got = await lib.read(gid, n, slot === 'translated' ? 'translated' : undefined);
    if (!same(got, bytes)) out.push(`page ${n} ${slot}: ${got ? `[${[...got]}]` : 'nothing'}, wrote [${[...bytes]}]`);
  }
  return out;
}

// `work` done on app `app` while library folder `dir`'s drive is away — what it changes waits — and every
// attempt to save it there that it set going (a publication made at once, a settle) ended before the drive
// is back (`app.flush`), so it still waits.
async function whileAway(app, dir, work) {
  fs.renameSync(dir, `${dir}.away`);
  try { await work(); await app.flush(); } finally { fs.renameSync(`${dir}.away`, dir); }
}

// Every delete in the folder refused while `fn` runs, on the app that writes.
async function deletesRefused(app, dir, fn) {
  const inside = (p) => p.toLowerCase().startsWith(dir.split(path.sep).join('/').toLowerCase());
  const undo = app === 'website'
    ? fsa.failNext((c) => c.op === 'removeEntry', 'NoModificationAllowedError', { times: 1e6 })
    : faults.failNext((c) => ['rm', 'unlink', 'rmdir'].includes(c.op) && inside(c.path), 'EBUSY', { times: 1e6 });
  try { await fn(); } finally { undo(); }
}

/** @typedef {{ name: string, todo?: string, run(ctx: { dir: string, from: import('./library-drivers.mjs').Driver, to: import('./library-drivers.mjs').Driver }): Promise<void> }} Handover */
/** @type {Handover[]} */
const CASES = [
  {
    // T05: a replacement in another format left two layout names, and the other app read the old one;
    // the manifest names every slot's file (format v2).
    name: 'a gallery whose every slot was replaced, old files left behind, reads whole',
    async run({ dir, from, to }) {
      const shared = path.join(dir, 'shared');
      const id = await from.add(shared);
      await from.setDefault(id);
      const gid = await from.newGallery('Handed over');
      await write(from, gid, FIRST);
      await from.flush();
      await deletesRefused(from.app, shared, async () => { await write(from, gid, SECOND); await from.flush(); });
      assert.deepEqual(await mismatches(from, gid, SECOND), [], 'the writer reads what it wrote');
      await from.remove(id);
      const back = await to.add(shared);
      const found = await to.scan(back);
      assert.deepEqual(found.problems, []);
      assert.deepEqual(await to.galleries(), [gid]);
      assert.equal(await to.titleOf(gid), 'Handed over');
      assert.deepEqual(await mismatches(to, gid, SECOND), []);
    },
  },
  {
    name: 'a gallery whose slots were replaced in the same format, old files left behind, reads whole',
    async run({ dir, from, to }) {
      const shared = path.join(dir, 'shared');
      const id = await from.add(shared);
      await from.setDefault(id);
      const gid = await from.newGallery('Suffixed');
      await write(from, gid, FIRST);
      await from.flush();
      const again = [[1, 'original', png(1, 5)], [2, 'original', png(2, 5)], [1, 'translated', png(1, 6)], [2, 'translated', png(2, 6)]];
      await deletesRefused(from.app, shared, async () => { await write(from, gid, again); await from.flush(); });
      await from.remove(id);
      const back = await to.add(shared);
      assert.deepEqual((await to.scan(back)).problems, []);
      assert.deepEqual(await mismatches(to, gid, again), []);
    },
  },
  {
    name: 'a linked ZIP\'s translation stays on the page it was made for',
    async run({ dir, from, to }) {
      const shared = path.join(dir, 'shared');
      fs.mkdirSync(shared, { recursive: true });
      fs.writeFileSync(path.join(shared, 'Pack.zip'), zipCreate([{ name: '001.png', data: png(1, 1) }, { name: '002.png', data: png(2, 1) }]));
      const id = await from.add(shared);
      await from.scan(id);
      const [gid] = await from.galleries();
      assert.ok(gid, 'the ZIP joined');
      await from.putTranslation(gid, 2, webp(2, 2), 'image/webp');
      await from.flush();
      await from.remove(id);
      const back = await to.add(shared);
      assert.deepEqual((await to.scan(back)).problems, []);
      assert.deepEqual(await to.galleries(), [gid], 'the same gallery');
      assert.deepEqual(await mismatches(to, gid, [[1, 'original', png(1, 1)], [2, 'original', png(2, 1)], [1, 'translated', png(1, 1)], [2, 'translated', webp(2, 2)]]), []);
    },
  },
  {
    name: 'a folder one app holds is the other\'s once let go, and taken over only when asked',
    async run({ dir, from, to }) {
      const shared = path.join(dir, 'shared');
      const id = await from.add(shared);
      assert.equal(await reason(to.add(shared)), 'claimed', 'held by the other app');
      await from.remove(id);
      const back = await to.add(shared);
      assert.equal(back, id, 'the folder keeps its id');
      assert.equal(await reason(from.add(shared)), 'claimed');
      assert.equal(await from.add(shared, { force: true }), id);
      const seen = (await to.list()).find(f => f.id === id);
      assert.equal(seen?.access, 'taken', 'the other app sees it taken over');
    },
  },
  {
    // A series whose chapters one app keeps in two library folders: each folder handed over says what
    // its chapters are of, and the other app puts the series together again from both.
    name: 'a series kept in two library folders is whole again once the other app has both',
    async run({ dir, from, to }) {
      const [A, B] = [path.join(dir, 'A'), path.join(dir, 'B')];
      const a = await from.add(A), b = await from.add(B);
      await from.setDefault(a);
      const owner = await from.newGallery('Saga'), second = await from.newGallery('Saga 2');
      await from.putPage(owner, 1, png(1, 1));
      await from.putPage(second, 1, png(2, 1));
      await from.raw.seriesCommand('write', owner, [{ id: owner, title: 'Ch 1' }, { id: second, title: 'Ch 2' }],
        { seriesTitle: { english: 'Saga', japanese: '', pretty: '' } });
      await from.raw.moveGallery(second, b, { series: false });
      await from.flush();
      const chapters = async (lib) => (await lib.raw.seriesChapters(owner)).map(c => [c.id, c.title, !!c.entity]);
      const before = await chapters(from);
      assert.deepEqual(before, [[owner, 'Ch 1', true], [second, 'Ch 2', true]]);
      assert.equal(await from.dirOf(second).then(d => d && d.startsWith(B)), true, 'its second chapter in the other folder');
      await from.remove(a);
      await from.remove(b);
      for (const folder of [B, A]) assert.deepEqual((await to.scan(await to.add(folder))).problems, []);
      assert.deepEqual((await to.galleries()).sort(), [owner, second].sort());
      assert.deepEqual(await chapters(to), before, 'its chapters, in order, with their titles');
      assert.deepEqual(await to.read(owner, 1), png(1, 1));
      assert.deepEqual(await to.read(second, 1), png(2, 1));
    },
  },
  {
    // D6: favorite and reading progress are the person's marks in the library they set them in.
    name: 'D6: a folder handed over carries no personal marks — setting them writes nothing to it',
    async run({ dir, from, to }) {
      const shared = path.join(dir, 'shared');
      const id = await from.add(shared);
      await from.setDefault(id);
      const gid = await from.newGallery('Marked');
      await from.putPage(gid, 1, png(1, 1));
      await from.putPage(gid, 2, png(2, 1));
      await from.flush();
      const before = { ...from.written() };
      await from.favorite(gid, true);
      await from.readTo(gid, 2, 2);
      await from.flush();
      assert.deepEqual(from.written(), before, 'nothing written to the folder');
      const marks = await from.marks(gid);
      assert.deepEqual([marks.favorite, marks.page, marks.pages, marks.finished], [true, 2, 2, true]);
      assert.equal((await from.meta(gid)).favorite, undefined, 'never in the metadata');
      const texts = fs.readdirSync(shared, { recursive: true }).map(f => path.join(shared, f)).filter(f => f.endsWith('.json'))
        .map(f => fs.readFileSync(f, 'utf8'));
      assert.ok(texts.length && !texts.some(t => /"(favorite|readAt|finished)"/.test(t)), 'no description carries them');
      await from.remove(id);
      assert.deepEqual((await to.scan(await to.add(shared))).problems, []);
      assert.deepEqual(await to.galleries(), [gid]);
      assert.equal(await to.marks(gid), null, 'none came with the folder');
      assert.equal((await to.meta(gid)).favorite, undefined);
    },
  },
  {
    // D6: an earlier version kept the favorite in the gallery's metadata.json.
    name: 'D6: an earlier version\'s favorite in a folder is taken in once as its gallery joins, and the folder published again without it',
    async run({ dir, to }) {
      const shared = path.join(dir, 'shared');
      const made = await v1Gallery(path.join(shared, 'Old'));
      const file = path.join(shared, 'Old', 'metadata.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), favorite: true }));
      const id = await to.add(shared);
      assert.deepEqual((await to.scan(id)).problems, []);
      assert.deepEqual(await to.marks(made.gid), { favorite: true }, 'taken in as it joins');
      assert.equal((await to.meta(made.gid)).favorite, undefined, 'never in the metadata');
      await to.flush();
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).favorite, undefined, 'its folder published again without it');
      // Unset by the person, it stays unset: removed and added again, the folder holds none.
      await to.favorite(made.gid, false);
      await to.remove(id);
      await to.scan(await to.add(shared));
      assert.deepEqual(await to.marks(made.gid), { favorite: false });
    },
  },
  {
    // A5 (review 7): a chapter of a series export deleted on the website, which reads the export in place,
    // came back on the desktop: nothing noted the chapter removed, so the desktop's first check unpacked it
    // with the rest, and it joined again. Both apps' checks honour the note for that chapter; on the desktop
    // a series export's chapters are folders (it unpacks it), each deleted as any.
    name: 'review 7 A5: a chapter of a series export deleted on one app never comes back on the other',
    async run({ dir, from, to }) {
      const shared = path.join(dir, 'shared');
      const [one, two, three] = seriesExport(shared, (n) => png(0, n));
      const id = await from.add(shared);
      await from.setDefault(id);
      await from.scan(id);
      await from.deleteGallery(two);
      await from.flush();
      await new Promise(r => setTimeout(r, 400));
      await from.setDefault(from.home);
      await from.remove(id);
      const back = await to.add(shared);
      for (let k = 1; k <= 2; k++) {
        const r = await to.scan(back);
        await to.flush();
        assert.deepEqual([r.problems, (await to.galleries()).sort()], [[], [one, three]], `check ${k}: the chapter deleted doesn't come back`);
      }
      assert.deepEqual([await to.read(one, 1), await to.read(two, 1), await to.read(three, 1)], [png(0, 1), null, png(0, 3)], 'the others read');
    },
  },
  {
    // B2 (review 7, both apps): the other app used the folder anyway and replaced page 1 (or re-translated
    // it, retiring the file it replaced); this app changed the gallery meanwhile — a translation of page 2,
    // or just its title — and took the folder back. Its publication over the other app's newer generation
    // named the file that app had deleted: that page read on neither app, and the folder added again
    // reported the gallery 'missing-file' for good. One app changes a folder's galleries at a time (the
    // owner's rule, 2026-11-15): the change tried meanwhile is refused, and after the take-back every page
    // reads on both apps, the folder holds every file it names, and added again it reports nothing.
    name: 'review 7 B2: a gallery the other app changed while it used the folder anyway reads whole on both apps after the take-back, the change tried here meanwhile refused',
    async run({ dir, from, to }) {
      for (const form of ['a page replaced there, a translation here', 'a translation replaced there, a title here']) {
        const F = path.join(dir, form.replaceAll(' ', '-').replaceAll(',', ''));
        const id = await from.add(F);
        await from.setDefault(id);
        const gid = await from.newGallery('Alpha');
        for (let n = 1; n <= 2; n++) await from.putPage(gid, n, png(0, n));
        await from.putTranslation(gid, 1, png(0, 71));
        await from.flush();
        const theirs = await to.add(F, { force: true });   // "Use anyway"
        await to.scan(theirs);
        const titled = form.endsWith('a title here');
        if (titled) await to.putTranslation(gid, 1, png(0, 81)); else await to.putPage(gid, 1, png(0, 11));
        await to.flush();
        assert.equal((await from.list()).find(f => f.id === id)?.access, 'taken', `${form}: shown as used elsewhere`);
        assert.equal(await reason(titled ? from.setTitle(gid, 'Alpha, retitled') : from.putTranslation(gid, 2, png(0, 72))), 'not-owned', `${form}: refused here`);
        await to.setDefault(to.home);
        await to.remove(theirs);   // the other app lets go
        assert.equal(await from.raw.folderClaim(id), 'granted', `${form}: taken back`);
        await from.flush();
        await new Promise(r => setTimeout(r, 1200));   // the website reads another app's work once it isn't busy with the gallery (§8)
        for (let i = 0; i < 2; i++) assert.deepEqual((await from.scan(id)).problems, [], `${form}: check ${i + 1}, nothing reported`);
        await from.flush();
        // (A page replaced keeps no translation of the picture it replaced: principle 7.)
        const want = titled ? [png(0, 1), png(0, 2), png(0, 81), 'Alpha'] : [png(0, 11), png(0, 2), false, 'Alpha'];
        const reads = async (lib) => [await lib.read(gid, 1), await lib.read(gid, 2), titled ? await lib.read(gid, 1, 'translated') : same(await lib.read(gid, 1, 'translated'), png(0, 71)), await lib.titleOf(gid)];
        assert.deepEqual(await reads(from), want, `${form}: the other app's change reads`);
        assert.deepEqual(namedMissing(F), [], `${form}: the folder holds every file it names`);
        await from.setDefault(from.home);
        await from.remove(id);
        const again = await to.add(F);
        assert.deepEqual((await to.scan(again)).problems, [], `${form}: added again, nothing reported`);
        assert.deepEqual(await reads(to), want, `${form}: read alike there`);
        await to.setDefault(to.home);
        await to.remove(again);
      }
    },
  },
  {
    // The owner's rule (2026-11-15), its first part: while another app holds a folder, a gallery the folder
    // holds is read-only here — every kind of change that would reach the folder is refused as it is
    // committed (reason 'not-owned'), never kept to be saved later — while it still reads and the person's
    // own marks (never written to the folder) work as ever; a gallery only this app has (made meanwhile,
    // never published there) keeps working and waits, as when the drive is away, and is published at the
    // take-back. After the take-back every change is allowed again.
    name: 'S29a: while the other app holds the folder, a gallery it holds is read-only here — every change refused, the person\'s marks kept — and one made meanwhile waits and is published at the take-back',
    async run({ dir, from, to }) {
      const F = path.join(dir, 'F'), G = path.join(dir, 'G');
      const id = await from.add(F);
      const other = await from.add(G);
      await from.setDefault(id);
      const gid = await from.newGallery('Alpha');
      for (let n = 1; n <= 2; n++) await from.putPage(gid, n, png(0, n));
      await from.putTranslation(gid, 1, png(0, 71));
      await from.flush();
      const theirs = await to.add(F, { force: true });   // "Use anyway"
      await to.scan(theirs);
      assert.equal((await from.list()).find(f => f.id === id)?.access, 'taken', 'shown as used elsewhere');
      const tries = {
        'a page added': () => from.putPage(gid, 3, png(0, 3)),
        'a page replaced': () => from.putPage(gid, 1, png(0, 11)),
        'a translation': () => from.putTranslation(gid, 2, png(0, 72)),
        'its title': () => from.setTitle(gid, 'Alpha, retitled'),
        'a deletion': () => from.deleteGallery(gid),
      };
      for (const [what, tried] of Object.entries(tries)) assert.equal(await reason(tried()), 'not-owned', `${what}: refused`);
      // A move asks the folder it leaves before anything is copied: refused as a folder another app keeps.
      assert.equal(await reason(from.move(gid, other)), 'taken', 'a move to another folder: refused');
      if (from.app === 'desktop') assert.deepEqual((await from.raw.archiveGallery(gid)).archived, [], 'archiving: not done');
      await from.favorite(gid, true);
      await from.readTo(gid, 2, 2);
      const marks = await from.marks(gid);
      assert.deepEqual([marks?.favorite, marks?.page, marks?.finished], [true, 2, true], 'the person\'s marks work');
      assert.deepEqual([await from.read(gid, 1), await from.read(gid, 2), await from.read(gid, 1, 'translated'), await from.titleOf(gid)],
        [png(0, 1), png(0, 2), png(0, 71), 'Alpha'], 'it reads as it was');
      const made = await from.newGallery('Made meanwhile');   // goes where new galleries go: F
      await from.putPage(made, 1, png(0, 31));
      await from.flush();
      assert.deepEqual(await from.read(made, 1), png(0, 31), 'one made meanwhile works');
      assert.ok(!fs.readdirSync(F).includes('Made meanwhile') || !fs.existsSync(path.join(F, 'Made meanwhile', 'metadata.json')), 'nothing of it published in the folder another app holds');
      await to.setDefault(to.home);
      await to.remove(theirs);
      assert.equal(await from.raw.folderClaim(id), 'granted');
      await from.flush();
      await new Promise(r => setTimeout(r, 300));
      await from.flush();
      await from.setTitle(gid, 'Alpha, retitled');   // allowed again
      await from.putTranslation(gid, 2, png(0, 72));
      await from.flush();
      assert.deepEqual((await from.scan(id)).problems, [], 'nothing reported');
      await from.setDefault(from.home);
      await from.remove(id);
      const again = await to.add(F);
      assert.deepEqual((await to.scan(again)).problems, [], 'added again, nothing reported');
      assert.deepEqual([await to.titleOf(gid), await to.read(gid, 2, 'translated'), await to.read(made, 1)], ['Alpha, retitled', png(0, 72), png(0, 31)],
        'the changes after the take-back, and the gallery made meanwhile, are in the folder');
      assert.ok(!(await to.marks(gid))?.favorite, 'the person\'s marks stayed with the app that set them');
    },
  },
  {
    // The owner's rule (2026-11-15), its second and third parts: changes waiting here from before the other
    // app took the folder over (made while the drive was away) stay waiting; at the take-back a gallery the
    // other app didn't change has them published, and one it did change keeps the folder's version — what
    // waited here for it dropped whole (its pictures with it), the gallery read again, the case reported
    // once ('changed-both').
    name: 'S29a: changes waiting from before the other app used the folder anyway are published where it changed nothing, and dropped, reported once, where it changed the gallery',
    async run({ dir, from, to }) {
      for (const form of ['a page', 'a translation', 'a title', 'a deletion']) {
        const F = path.join(dir, form.replaceAll(' ', '-'));
        const id = await from.add(F);
        await from.setDefault(id);
        const touched = await from.newGallery('Touched'), untouched = await from.newGallery('Untouched');
        for (const g of [touched, untouched]) for (let n = 1; n <= 2; n++) await from.putPage(g, n, png(0, n));
        await from.flush();
        const change = (g) => (form === 'a page' ? from.putPage(g, 3, png(0, 3)) : form === 'a translation' ? from.putTranslation(g, 1, png(0, 8)) : from.setTitle(g, 'Mine'));
        // What is changed now waits: the drive away — or, a deletion (refused while its folder can't be
        // written: D3), every delete of its files refused for now, so the deletion of its folder waits.
        if (form === 'a deletion') {
          await deletesRefused(from.app, F, async () => {
            for (const g of [touched, untouched]) await from.deleteGallery(g);
            await new Promise(r => setTimeout(r, 500));
          });
        } else await whileAway(from, F, async () => { for (const g of [touched, untouched]) await change(g); });
        const theirs = await to.add(F, { force: true });   // "Use anyway"
        await to.scan(theirs);
        await to.putTranslation(touched, 2, png(0, 7));   // the other app changes one of them
        await to.flush();
        await to.setDefault(to.home);
        await to.remove(theirs);
        assert.equal(await from.raw.folderClaim(id), 'granted', `${form}: taken back`);
        await from.flush();
        await new Promise(r => setTimeout(r, 1200));   // the website reads another app's work once it isn't busy with the gallery (§8)
        for (let i = 0; i < 2; i++) { assert.deepEqual((await from.scan(id)).problems, [], `${form}: check ${i + 1}, nothing reported`); await from.flush(); }
        const mine = async (lib, g) => (form === 'a page' ? same(await lib.read(g, 3), png(0, 3)) : form === 'a translation' ? same(await lib.read(g, 1, 'translated'), png(0, 8))
          : form === 'a title' ? await lib.titleOf(g) === 'Mine' : !(await lib.galleries()).includes(g));
        assert.deepEqual([await mine(from, untouched), await mine(from, touched)], [true, false], `${form}: published where the other app changed nothing, dropped where it changed the gallery`);
        assert.deepEqual(await from.read(touched, 2, 'translated'), png(0, 7), `${form}: the other app's change reads`);
        assert.deepEqual((await from.list()).find(f => f.id === id).attention.filter(a => a.reason === 'changed-both').map(a => a.path), ['Touched'], `${form}: reported once`);
        assert.deepEqual(namedMissing(F), [], `${form}: the folder holds every file it names`);
        await from.setDefault(from.home);
        await from.remove(id);
        const again = await to.add(F);
        assert.deepEqual((await to.scan(again)).problems, [], `${form}: added again, nothing reported`);
        assert.deepEqual([await mine(to, untouched), await mine(to, touched), await to.read(touched, 2, 'translated')], [true, false, png(0, 7)], `${form}: read alike there`);
        await to.setDefault(to.home);
        await to.remove(again);
      }
    },
  },
  {
    // C2 (the coordinator after S29b, s29b-quiet2 and s29b-forget): the other app uses the folder anyway and
    // retitles Alpha there; this app, once it has learned of it (a change refused), went on accepting changes
    // after S29b — on the website a title a quiet moment later with no fault at all, on both apps every title
    // while the claim couldn't be read or the drive was away — shown here while the other app held the
    // folder, then dropped at the take-back ('changed-both'). The gate knows the last claim it read: each
    // change below comes a quiet moment past the claim's time to live after the one before, and all are
    // refused, the claim unreadable or the drive away meanwhile and after; at the take-back nothing waits
    // here, nothing is dropped, and the other app's title reads.
    name: 'S29c C2: once this app has learned the other app uses its folder anyway, a title, a page, a translation and a deletion stay refused past the claim\'s time to live — the claim unreadable or the drive away meanwhile and after — and nothing is dropped at the take-back',
    async run({ dir, from, to }) {
      const named = (english) => ({ english, japanese: '', pretty: '' });
      for (const [i, form] of ['quiet', 'the claim unreadable', 'the drive away'].entries()) {
        const F = path.join(dir, `F${i}`);
        const id = await from.add(F);
        await from.setDefault(id);
        const gid = await from.newGallery('Alpha'), doomed = await from.newGallery('Beta');
        for (let n = 1; n <= 2; n++) await from.putPage(gid, n, png(i, n));
        await from.putPage(doomed, 1, png(i, 9));
        await from.flush();
        const theirs = await to.add(F, { force: true });   // "Use anyway"
        await to.scan(theirs);
        await to.setTitle(gid, 'Alpha there');
        await to.flush();
        const meta = await from.meta(gid);   // what an edit dialog read as it opened: each title is that record saved, nothing read first
        let n = 0;
        const tries = [
          ['a title', () => from.raw.metaPut({ ...meta, title: named(`Alpha ${++n}`) })],
          ['a page', () => from.putPage(gid, 3, png(i, 3))],
          ['a translation', () => from.putTranslation(gid, 1, png(i, 71))],
          ['a deletion', () => from.deleteGallery(doomed)],
        ];
        assert.equal((await from.list()).find(f => f.id === id)?.access, 'taken', `${form}: shown as used elsewhere`);
        assert.equal(await reason(tries[0][1]()), 'not-owned', `${form}: learned — a change refused`);
        const round = async (what) => {
          for (const [change, tried] of tries) {
            clockAhead(CLAIM_TTL_MS);   // a quiet moment past the claim's time to live, nothing else reading it
            const want = form === 'the drive away' && what === 'meanwhile' && change === 'a deletion' ? 'unavailable' : 'not-owned';   // out of reach: D3
            assert.equal(await reason(tried()), want, `${form}, ${what}: ${change} refused`);
          }
        };
        if (form === 'quiet') { await round('meanwhile'); await round('again'); }
        else if (form === 'the drive away') {
          fs.renameSync(F, `${F}.away`);
          try { await round('meanwhile'); } finally { fs.renameSync(`${F}.away`, F); }
          await round('back');
        } else {
          const read = from.app === 'desktop' ? (c) => c.op === 'readFile' && c.path.endsWith(`/F${i}/.shiori/owner.json`) : (c) => c.op === 'getFile' && c.path === '.shiori/owner.json';
          const undo = (from.app === 'desktop' ? faults : fsa).failNext(read, from.app === 'desktop' ? 'EIO' : 'NotReadableError', { times: Infinity });
          try { await round('meanwhile'); } finally { undo(); }
          await round('readable again');
        }
        assert.deepEqual([await from.titleOf(gid), await from.read(gid, 3), (await from.galleries()).includes(doomed)], ['Alpha', null, true], `${form}: nothing of it here`);
        await to.setDefault(to.home);
        await to.remove(theirs);   // it lets go
        assert.equal(await from.raw.folderClaim(id), 'granted', `${form}: taken back`);
        await from.flush();
        // (The website reads another app's work once it isn't busy with the gallery: §8.)
        await until(async () => { await from.scan(id); return await from.titleOf(gid) === 'Alpha there'; }, 10_000);
        assert.deepEqual((await from.scan(id)).problems, [], `${form}: nothing reported`);
        assert.deepEqual([await from.titleOf(gid), (await from.list()).find(f => f.id === id).attention.map(a => a.reason)], ['Alpha there', []], `${form}: the other app's title, nothing dropped`);
        assert.deepEqual(namedMissing(F), [], `${form}: the folder holds every file it names`);
        await from.setDefault(from.home);
        await from.remove(id);
      }
    },
  },
];

// The files the manifests of folder `F`'s galleries name that aren't there: [] when every one is (a
// publication never names a file the folder doesn't hold).
function namedMissing(F) {
  const out = [];
  for (const name of fs.readdirSync(F)) {
    const at = path.join(F, name, '.shiori', 'gallery.json');
    if (!fs.existsSync(at)) continue;
    const { files } = JSON.parse(fs.readFileSync(at, 'utf8'));
    const named = [...Object.values(files.pages).flatMap(p => [p.original, p.translated, p.studyBg, ...(p.studyText || []), p.masks?.raw, p.masks?.text]), ...Object.values(files.covers)];
    for (const f of named) if (f && !fs.existsSync(path.join(F, name, ...f.split('/')))) out.push(`${name}/${f}`);
  }
  return out;
}
// The desktop's alone: a gallery it archived, read in place by the website, then changed there (its
// first change unpacks it) and read back whole by the desktop.
const ARCHIVED = {
  name: 'a gallery the desktop archived is read in place, and changed, by the website',
  async run({ dir, desktop, website }) {
    const shared = path.join(dir, 'shared');
    const id = await desktop.add(shared);
    await desktop.setDefault(id);
    const gid = await desktop.newGallery('Archived');
    await write(desktop, gid, FIRST);
    await desktop.flush();
    assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid]);
    await desktop.remove(id);
    const back = await website.add(shared);
    assert.deepEqual((await website.scan(back)).problems, []);
    assert.deepEqual(await mismatches(website, gid, FIRST), [], 'read in place');
    const changed = [[1, 'translated', webp(1, 7), 'image/webp']];
    await write(website, gid, changed);
    await website.flush();
    await website.remove(back);
    const again = await desktop.add(shared);
    assert.deepEqual((await desktop.scan(again)).problems, []);
    assert.deepEqual(await mismatches(desktop, gid, [...FIRST.filter(([n, slot]) => !(n === 1 && slot === 'translated')), ...changed]), []);
  },
};

// F5 (S10 review): a gallery the desktop archived, changed (so unpacked: D17) by the website while it
// had the folder taken over, was left missing by the desktop's check once it had the folder back — a
// gallery was followed by its id only to a place of the same format.
const UNPACKED = {
  name: 'F5: a gallery the desktop archived, unpacked by the website that took the folder over, is followed to its folder by the desktop',
  async run({ dir, desktop, website }) {
    const shared = path.join(dir, 'shared');
    const id = await desktop.add(shared);
    await desktop.setDefault(id);
    const gid = await desktop.newGallery('Archived');
    await write(desktop, gid, FIRST);
    await desktop.flush();
    assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid]);
    const back = await website.add(shared, { force: true });   // "Use anyway": the desktop still has it
    assert.deepEqual((await website.scan(back)).problems, []);
    const changed = [[1, 'translated', webp(1, 7), 'image/webp']];
    await write(website, gid, changed);
    await website.flush();
    assert.ok(!fs.readdirSync(shared).some(n => /\.(zip|cbz)$/i.test(n)), 'unpacked: the archive gone');
    await website.remove(back);
    await desktop.raw.folderClaim(id);
    assert.deepEqual((await desktop.scan(id)).problems, []);
    assert.deepEqual(await desktop.galleries(), [gid]);
    assert.deepEqual({ ...desktop.raw._s('SELECT format, state FROM files WHERE gid = ?').get(gid) }, { format: 'folder', state: 'packed' }, 'there, not missing');
    assert.deepEqual(await mismatches(desktop, gid, [...FIRST.filter(([n, slot]) => !(n === 1 && slot === 'translated')), ...changed]), []);
  },
};

// S21 (found by reading, the desktop's _archiveUnchanged rule on the website): deleting a gallery the
// desktop archived, a read of its archive failing once was taken for "not the gallery's" — the deletion
// recorded done with the archive left whole, which the next check adopted again — or for "holds the
// person's file" ('left'). Now nothing is concluded: the deletion stays recorded and is done later.
const ARCHIVE_DELETED = {
  name: 'S21: a gallery the desktop archived, deleted on the website while a read of its archive fails once, never comes back',
  async run({ dir, desktop, website }) {
    const shared = path.join(dir, 'shared');
    const id = await desktop.add(shared);
    await desktop.setDefault(id);
    const gids = [];
    for (const title of ['First', 'Second']) {
      const gid = await desktop.newGallery(title);
      await write(desktop, gid, FIRST);
      await desktop.flush();
      assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid]);
      gids.push(gid);
    }
    await desktop.remove(id);
    const back = await website.add(shared);
    assert.deepEqual((await website.scan(back)).problems, []);
    const archives = fs.readdirSync(shared).filter(n => /\.(zip|cbz)$/i.test(n)).sort();
    assert.deepEqual(archives.length, 2);
    // Each deletion's k-th read of its archive fails once: the third (whose galleries it names), the fourth
    // (whether it holds anything else).
    for (const [gid, k] of [[gids[0], 3], [gids[1], 4]]) {
      const name = /** @type {string} */ (await website.raw.galleryGet(gid)).dir;
      let reads = 0;
      const undo = fsa.failNext((c) => c.op === 'getFile' && c.path === name && ++reads === k, 'NotReadableError', { times: 1 });
      try {
        await website.deleteGallery(gid);
        await website.flush();
        await new Promise(r => setTimeout(r, 300));
      } finally { undo(); }
      assert.equal(reads >= k, true, `the deletion read ${name} ${reads} times`);
    }
    for (let i = 0; i < 2; i++) {
      const found = await website.scan(back);
      assert.deepEqual([found.added, await website.galleries()], [0, []], 'the deleted galleries never come back');
    }
    assert.deepEqual(fs.readdirSync(shared).filter(n => /\.(zip|cbz)$/i.test(n)), [], 'their archives deleted');
    assert.deepEqual((await website.list()).find(f => f.id === back).attention, []);
  },
};

// F3 (S10 review): the desktop cut short adding to an archive (more than 64 KiB of entries written, not
// its directory) and never cut it back — the website took the folder over first: both apps read the
// archive as it was before the addition.
const CUT_SHORT = {
  name: 'F3: an archive the desktop was adding to when it stopped, taken over by the website, reads whole as it was to both apps',
  async run({ dir, desktop, website }) {
    const shared = path.join(dir, 'shared');
    const id = await desktop.add(shared);
    await desktop.setDefault(id);
    const gid = await desktop.newGallery('Archived');
    await write(desktop, gid, FIRST);
    await desktop.flush();
    assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid]);
    const archive = path.join(shared, fs.readdirSync(shared).find(n => /\.(zip|cbz)$/i.test(n)));
    fs.appendFileSync(archive, Buffer.alloc(70_000, 7));   // the entries of an addition, and no directory after them
    const back = await website.add(shared, { force: true });
    assert.deepEqual((await website.scan(back)).problems, []);
    assert.deepEqual(await mismatches(website, gid, FIRST), [], 'the website reads it whole');
    await website.remove(back);
    await desktop.raw.folderClaim(id);
    desktop.raw.files._dirs.clear();
    assert.deepEqual(await mismatches(desktop, gid, FIRST), [], 'and so does the desktop');
  },
};

// F6 (S10 review): an archive the desktop wrote, the person's file added to it, was deleted whole by the
// website's deletion of its gallery. It stays, and neither app adopts it again (removed.json says so).
const EDITED = {
  name: 'F6: an archive the person added a file to is left whole by the website\'s deletion of its gallery, and adopted again by neither app',
  async run({ dir, desktop, website }) {
    const shared = path.join(dir, 'shared');
    const id = await desktop.add(shared);
    await desktop.setDefault(id);
    const gid = await desktop.newGallery('Archived');
    await write(desktop, gid, FIRST);
    await desktop.flush();
    assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid]);
    const archive = path.join(shared, fs.readdirSync(shared).find(n => /\.(zip|cbz)$/i.test(n)));
    const { zipEntries } = await import('../js/zip-read.js');
    const entries = [];
    for (const e of await zipEntries(new Uint8Array(fs.readFileSync(archive)))) entries.push({ name: e.filename, data: await e.read() });
    fs.writeFileSync(archive, zipCreate([...entries, { name: 'notes.txt', data: new TextEncoder().encode('mine') }]));
    const edited = fs.readFileSync(archive);
    await desktop.remove(id);
    const back = await website.add(shared);
    assert.deepEqual((await website.scan(back)).problems, []);
    await website.deleteGallery(gid);
    for (let i = 0; i < 50 && !(await website.list()).find(f => f.id === back).attention.some(a => a.reason === 'left'); i++) await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(fs.readFileSync(archive), edited, 'the archive stays as the person left it');
    await website.scan(back);
    assert.deepEqual(await website.galleries(), [], 'never adopted again');
    await website.remove(back);
    const again = await desktop.add(shared);
    await desktop.scan(again);
    assert.deepEqual(await desktop.galleries(), [], 'nor by the other app');
  },
};

// F4 (review 6, both apps): a check that couldn't read removed.json took it for "nothing removed", so an
// archive a deletion left whole (the person's file in it: F6 above), noted there, could be adopted again —
// the deleted gallery back. A check that can't read it ("not found" or any failure) adopts no archive it
// might note, on either app.
const NOTES_UNREAD = {
  name: 'review 6 F4: a check that can\'t read removed.json adopts no archive a deletion left, on either app',
  async run({ dir, desktop, website }) {
    const shared = path.join(dir, 'shared');
    const id = await desktop.add(shared);
    await desktop.setDefault(id);
    const gid = await desktop.newGallery('Archived');
    await write(desktop, gid, FIRST);
    await desktop.flush();
    assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid]);
    const archive = path.join(shared, fs.readdirSync(shared).find(n => /\.(zip|cbz)$/i.test(n)));
    const { zipEntries } = await import('../js/zip-read.js');
    const entries = [];
    for (const e of await zipEntries(new Uint8Array(fs.readFileSync(archive)))) entries.push({ name: e.filename, data: await e.read() });
    fs.writeFileSync(archive, zipCreate([...entries, { name: 'notes.txt', data: new TextEncoder().encode('mine') }]));
    await desktop.remove(id);
    const back = await website.add(shared);
    assert.deepEqual((await website.scan(back)).problems, []);
    await website.deleteGallery(gid);
    for (let i = 0; i < 50 && !(await website.list()).find(f => f.id === back).attention.some(a => a.reason === 'left'); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(fs.existsSync(archive), 'left whole, noted in removed.json');
    const notes = /(^|\/)\.shiori\/linked\/removed\.json$/;
    for (const code of ['NotReadableError', 'NotFoundError']) {
      const undo = fsa.failNext((c) => c.op === 'getFileHandle' && notes.test(c.path), code, { times: 1 });
      const found = await website.scan(back);
      undo();
      assert.deepEqual([found.added, await website.galleries()], [0, []], `the website adopts nothing (${code})`);
    }
    await website.remove(back);
    const again = await desktop.add(shared);
    for (const code of ['EIO', 'ENOENT']) {
      const undo = faults.failNext((c) => c.op === 'readFile' && notes.test(c.path), code, { times: 1 });
      const found = await desktop.scan(again);
      undo();
      assert.deepEqual([found.added, await desktop.galleries()], [0, []], `nor does the desktop (${code})`);
    }
    await desktop.scan(again);
    assert.deepEqual(await desktop.galleries(), [], 'nor at a check that reads it');
  },
};

// F5 (review 6, the website): adding the desktop's first library folder, one "not found" in the read of its
// .shiori/library.json (the .shiori folder's lookup, the file's, its read) and the website wrote a new id
// over it, before it weighed the claim — so in an add it refused ('claimed'). The desktop then read none of
// that folder's galleries, and its next start opened another, empty library. The website writes a
// library.json only where there surely is none, once the add is allowed.
const FIRST_FOLDER = {
  name: 'review 6 F5: the website adding the desktop\'s first folder while its library.json answers "not found" for a moment writes nothing there',
  async run({ dir, desktop, website }) {
    const first = path.join(dir, 'desktop', 'own');
    const gid = await desktop.newGallery('Alpha');
    await desktop.putPage(gid, 1, png(1));
    await desktop.flush();
    const idFile = path.join(first, '.shiori', 'library.json');
    const was = fs.readFileSync(idFile, 'utf8');
    for (const [op, at] of [['getDirectoryHandle', '.shiori'], ['getFileHandle', '.shiori/library.json'], ['getFile', '.shiori/library.json']]) {
      const undo = fsa.failNext((c) => c.op === op && c.path === at, 'NotFoundError', { times: 1 });
      const got = await reason(website.add(first));
      undo();
      assert.notEqual(got, 'resolved', `refused (${op} answered "not found")`);
      assert.equal(fs.readFileSync(idFile, 'utf8'), was, `library.json as it was (${op})`);
    }
    assert.equal(await reason(website.add(first)), 'claimed', 'the desktop\'s folder');
    assert.equal(fs.readFileSync(idFile, 'utf8'), was);
    await new Promise(r => setTimeout(r, 2200));   // past the desktop's read window
    assert.deepEqual(await desktop.read(gid, 1), png(1), 'the desktop reads it as its own');
  },
};

// F7 (review 6, the desktop): a gallery it archived, the person's file added to the archive; the website
// changed it (unpacked beside the archive, D17, which stays for the person's file: noted in removed.json,
// S10's F6). The desktop kept reading the archive — the website's translation never showed, and the folder
// it was unpacked into was reported a copy at every check — when it had the folder back from "Use anyway".
// An archive noted as removed is not the gallery's place: the desktop follows the gallery to the folder
// naming it, in both forms of the hand-over ("Use anyway" and back; removed and added again), with no copy
// reported; and a change the desktop made while the website had the folder is kept (local changes win, D4).
const NOTED_ARCHIVE = {
  name: 'review 6 F7: a gallery the website unpacked beside an archive kept for the person\'s file is read from its folder by the desktop, with no copy reported',
  async run({ dir, desktop, website }) {
    const { zipEntries } = await import('../js/zip-read.js');
    for (const form of ['use anyway and back', 'removed and added again', 'use anyway and back, changed meanwhile']) {
      const shared = path.join(dir, form.replaceAll(' ', '-').replaceAll(',', ''));
      let id = await desktop.add(shared);
      await desktop.setDefault(id);
      const gid = await desktop.newGallery('Archived');
      await write(desktop, gid, FIRST);
      await desktop.flush();
      assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid]);
      const archive = path.join(shared, fs.readdirSync(shared).find(n => /\.(zip|cbz)$/i.test(n)));
      const entries = [];
      for (const e of await zipEntries(new Uint8Array(fs.readFileSync(archive)))) entries.push({ name: e.filename, data: await e.read() });
      fs.writeFileSync(archive, zipCreate([...entries, { name: 'notes.txt', data: new TextEncoder().encode('mine') }]));
      const edited = fs.readFileSync(archive);
      const meanwhile = form.endsWith('changed meanwhile');
      if (meanwhile) {
        // The desktop's page 3, put while the drive was away (it waits), before the website used the folder.
        await whileAway(desktop, shared, () => desktop.putPage(gid, 3, png(3, 1)));
      }
      if (form === 'removed and added again') await desktop.remove(id);
      const back = await website.add(shared, { force: form !== 'removed and added again' });
      assert.deepEqual((await website.scan(back)).problems, []);
      const changed = [[1, 'translated', webp(1, 7), 'image/webp']];
      if (meanwhile) {
        assert.equal((await desktop.list()).find(f => f.id === id)?.access, 'taken', 'the desktop sees the take-over');
        assert.equal(await reason(desktop.putPage(gid, 4, png(4, 1))), 'not-owned', 'a page put now is refused');
      }
      await write(website, gid, changed);
      await website.flush();
      await new Promise(r => setTimeout(r, 400));
      assert.deepEqual(await mismatches(website, gid, changed), [], 'the website reads its translation');
      assert.deepEqual(fs.readFileSync(archive), edited, 'the archive stays, the person\'s file in it');
      await website.remove(back);
      if (form === 'removed and added again') id = await desktop.add(shared);
      else await desktop.raw.folderClaim(id);
      for (let i = 0; i < 2; i++) {
        const found = await desktop.scan(id);
        assert.deepEqual(found.problems.filter(p => p.reason !== 'changed-both'), [], `${form}: check ${i + 1} reports no copy`);
      }
      assert.deepEqual(await desktop.galleries(), [gid], form);
      assert.deepEqual({ ...desktop.raw._s('SELECT format, state FROM files WHERE gid = ?').get(gid) }, { format: 'folder', state: 'packed' }, `${form}: read from its folder`);
      assert.deepEqual(await mismatches(desktop, gid, [...FIRST.filter(([n, slot]) => !(n === 1 && slot === 'translated')), ...changed]), [], `${form}: the website's work reads`);
      if (meanwhile) {
        // One app changes a folder's galleries at a time: the website's version stands, the desktop's page
        // that waited is dropped, and that is said once.
        assert.equal(await desktop.read(gid, 3), null, 'the desktop\'s page that waited is dropped');
        assert.deepEqual((await desktop.list()).find(f => f.id === id).attention.filter(a => a.reason === 'changed-both').map(a => a.path), ['Archived'], 'reported once');
      }
      assert.deepEqual(fs.readFileSync(archive), edited, `${form}: the archive is left as the person's`);
      await desktop.setDefault(desktop.home);
      await desktop.remove(id);
    }
  },
};

// Found in S24 (the desktop): a gallery it archived, unpacked by the website that took the folder over (D17:
// the archive deleted, or kept for the person's file), deleted on the desktop right after it took the folder
// back, before any check. The deletion of its archive found no place ('unfound'); the next check met the
// folder the website unpacked it into, but finished an archive's deletion only at an archive: it passed the
// folder over, forgot the deletion, and the check after joined it — the deleted gallery back. A deletion met
// at the other kind of place is done there by that place's own manifest (principle 4). The mirror, the
// website deleting right after it took a folder back from the desktop, which archived the gallery meanwhile,
// came back alike: the website's folder deletion met the desktop's archive.
const DELETED_ON_TAKE_BACK = {
  name: 'S25b: a gallery deleted right after its folder was taken back from the other app, which unpacked or archived it, never comes back',
  async run({ dir, desktop, website }) {
    const { zipEntries } = await import('../js/zip-read.js');
    const mine = async (archive) => {
      const entries = [];
      for (const e of await zipEntries(new Uint8Array(fs.readFileSync(archive)))) entries.push({ name: e.filename, data: await e.read() });
      fs.writeFileSync(archive, zipCreate([...entries, { name: 'notes.txt', data: new TextEncoder().encode('mine') }]));
      return fs.readFileSync(archive);
    };
    const archiveIn = (shared) => fs.readdirSync(shared).find(n => /\.(zip|cbz)$/i.test(n));
    for (const form of ['the archive gone', 'the archive kept for the person\'s file']) {
      const shared = path.join(dir, `desktop ${form.replaceAll(' ', '-').replaceAll('\'', '')}`);
      const id = await desktop.add(shared);
      await desktop.setDefault(id);
      const gid = await desktop.newGallery('Archived');
      await write(desktop, gid, FIRST);
      await desktop.flush();
      assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid]);
      const archive = path.join(shared, archiveIn(shared));
      const edited = form.endsWith('file') ? await mine(archive) : null;
      const back = await website.add(shared, { force: true });
      assert.deepEqual((await website.scan(back)).problems, []);
      await write(website, gid, [[1, 'translated', webp(1, 7), 'image/webp']]);
      await website.flush();
      await new Promise(r => setTimeout(r, 400));
      assert.ok(fs.existsSync(path.join(shared, 'Archived', '.shiori', 'gallery.json')), `${form}: unpacked beside the archive`);
      await website.remove(back);
      await desktop.raw.folderClaim(id);
      await desktop.deleteGallery(gid);
      await desktop.flush();
      await new Promise(r => setTimeout(r, 300));
      for (let i = 0; i < 2; i++) {
        const found = await desktop.scan(id);
        assert.deepEqual([found.added, found.problems, await desktop.galleries()], [0, [], []], `${form}: check ${i + 1} adds nothing`);
      }
      assert.equal(fs.existsSync(path.join(shared, 'Archived')), false, `${form}: the folder it was unpacked into is deleted`);
      if (edited) assert.deepEqual(fs.readFileSync(archive), edited, `${form}: the archive stays as the person's`);
      else assert.equal(archiveIn(shared), undefined, form);
      await desktop.setDefault(desktop.home);
      await desktop.remove(id);
    }
    for (const form of ['an archive of its own', 'an archive with the person\'s file']) {
      const shared = path.join(dir, `website ${form.replaceAll(' ', '-').replaceAll('\'', '')}`);
      const back = await website.add(shared);
      await website.setDefault(back);
      const gid = await website.newGallery('Folder');
      await write(website, gid, FIRST);
      await website.flush();
      await new Promise(r => setTimeout(r, 300));
      const id = await desktop.add(shared, { force: true });   // "Use anyway" on the desktop
      assert.deepEqual((await desktop.scan(id)).problems, []);
      assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid]);
      const archive = path.join(shared, archiveIn(shared));
      const edited = form.endsWith('file') ? await mine(archive) : null;
      await desktop.setDefault(desktop.home);
      await desktop.remove(id);
      assert.equal(await website.raw.folderClaim(back), 'granted');
      await website.deleteGallery(gid);
      await website.flush();
      await new Promise(r => setTimeout(r, 400));
      for (let i = 0; i < 2; i++) {
        const found = await website.scan(back);
        assert.deepEqual([found.added, await website.galleries()], [0, []], `${form}: check ${i + 1} adds nothing`);
      }
      if (edited) {
        assert.deepEqual(fs.readFileSync(archive), edited, `${form}: the archive stays as the person's`);
        assert.deepEqual((await website.list()).find(f => f.id === back).attention.map(a => a.reason), ['left'], form);
      } else assert.equal(archiveIn(shared), undefined, `${form}: the archive the desktop made is deleted`);
      await website.setDefault(website.home);
      await website.remove(back);
    }
    // And the desktop's own mirror: another desktop app took the folder over and archived the gallery.
    const other = await desktopLibrary(path.join(dir, 'other desktop'));
    try {
      const shared = path.join(dir, 'desktop and another');
      const id = await desktop.add(shared);
      await desktop.setDefault(id);
      const gid = await desktop.newGallery('Folder');
      await write(desktop, gid, FIRST);
      await desktop.flush();
      const theirs = await other.add(shared, { force: true });
      assert.deepEqual((await other.scan(theirs)).problems, []);
      assert.deepEqual((await other.raw.archiveGallery(gid)).archived, [gid]);
      await other.setDefault(other.home);
      await other.remove(theirs);
      await desktop.raw.folderClaim(id);
      await desktop.deleteGallery(gid);
      await desktop.flush();
      await new Promise(r => setTimeout(r, 300));
      for (let i = 0; i < 2; i++) {
        const found = await desktop.scan(id);
        assert.deepEqual([found.added, found.problems, await desktop.galleries()], [0, [], []], `another desktop's archive: check ${i + 1} adds nothing`);
      }
      assert.equal(archiveIn(shared), undefined, 'the archive the other desktop made is deleted');
    } finally { await other.close(); }
  },
};

// F7 (review 4): the desktop killed as it put a gallery it unpacked in place left the temporary folder
// it was unpacked into, `Alpha.shiori-tmp`, beside the archive; the website, taking the folder over,
// took that folder for the gallery and showed it empty, the archive that holds it whole passed over.
const KILLED_UNPACK = {
  name: 'F7 (review 4): the folder the desktop was killed unpacking a gallery into is never taken for the gallery by the website',
  async run({ dir, desktop, website }) {
    const shared = path.join(dir, 'shared');
    await desktop.close();
    assert.equal(desktopKilled(path.join(dir, 'desktop'), async ({ lib, kill, folder }) => {
      const fs = await import('node:fs'), path = await import('node:path');
      const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
      const id = await lib.add(folder);
      await lib.setDefault(id);
      const gid = await lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await lib.putPage(gid, n, png(n));
      await lib.flush();
      await lib.raw.archiveGallery(gid);
      while (fs.existsSync(path.join(folder, 'Alpha'))) await new Promise(r => setTimeout(r, 25));
      kill((c) => c.op === 'rename' && /\/shared\/Alpha(\.[0-9a-f]+)?\.shiori-tmp$/.test(c.path));
      await lib.putTranslation(gid, 2, png(9));
      await lib.flush();
    }, { folder: shared }), 42);
    assert.equal(fs.readdirSync(shared).filter(n => n.endsWith('.shiori-tmp')).length, 1, 'the kill left the unpack\'s temporary folder');
    const back = await website.add(shared, { force: true });
    const found = await website.scan(back);
    const [gid] = await website.galleries();
    assert.deepEqual([found.added, found.problems], [1, []]);
    assert.deepEqual([await website.read(gid, 1), await website.read(gid, 2), await website.read(gid, 3)], [png(1), png(2), png(3)], 'read whole from the archive');
  },
};

// D18, the desktop's alone: a gallery in its oldest format (shiori.json beside its pictures, which the
// website doesn't read) converted to the gallery format at the desktop's check — its pictures renamed
// into images/, its generation published — and read whole by the website then.
const OLDEST = {
  name: 'a gallery in the desktop\'s oldest format is converted by its check, and read whole by the website then (D18)',
  async run({ dir, desktop, website }) {
    const shared = path.join(dir, 'shared');
    const made = legacyGallery(path.join(shared, 'Oldest'));
    const id = await desktop.add(shared);
    assert.deepEqual((await desktop.scan(id)).problems, []);
    assert.deepEqual(await desktop.galleries(), [made.gid]);
    assert.ok(fs.existsSync(path.join(shared, 'Oldest', '.shiori', 'gallery.json')), 'published in format v2');
    assert.deepEqual(fs.readdirSync(path.join(shared, 'Oldest', 'images')).sort(), ['0001.webp', '0002.webp'], 'its pictures in images/, renamed');
    const pages = [await desktop.read(made.gid, 1), await desktop.read(made.gid, 2)];
    await desktop.remove(id);
    const back = await website.add(shared);
    assert.deepEqual((await website.scan(back)).problems, []);
    assert.deepEqual(await website.galleries(), [made.gid]);
    assert.deepEqual([await website.read(made.gid, 1), await website.read(made.gid, 2)], pages);
    assert.equal(await website.titleOf(made.gid), 'The oldest format');
  },
};

// A4 (review 7, the desktop) under the owner's rule of 2026-11-15 (one app changes a folder's galleries at
// a time): the desktop translated page 1 while folder A's drive was away (its picture waiting in its own
// staging); then the website used the folder anyway and translated page 1 there. While the website holds
// the folder a translation tried on the desktop is refused. At the take-back the folder's version stands:
// the desktop reads the website's translation, its own is dropped — nothing of it goes into the folder —
// and that is reported once; a kill before the drop, or as it deletes what waited, ends the same after a
// start. (Before the rule the desktop's picture went into translated/ beside the website's and won, D4.)
// And the website's mirror (its picture waiting in the browser), with no fault: the folder sweep's "…, a
// page both apps translated" faults it at every call.
const BOTH_TRANSLATED = {
  name: 'review 7 A4: a page both apps translated — this app while the drive was away, the other while it used the folder anyway — shows the folder\'s translation after the take-back, this app\'s dropped and reported once; one tried meanwhile is refused',
  async run({ dir, desktop, website }) {
    const base = path.join(dir, 'desktop');
    let lib = desktop;
    const pngOf = (n) => png(0, n);
    const bytesAt = (A) => Object.fromEntries(fs.readdirSync(path.join(A, 'Alpha', 'translated')).map(n => [n, [...fs.readFileSync(path.join(A, 'Alpha', 'translated', n))].at(-1)]));
    const changedBoth = async (app, id) => (await app.list()).find(f => f.id === id).attention.filter(a => a.reason === 'changed-both').map(a => a.path);
    // `who` puts a translation of page 1 while folder A's drive is away: it waits (the desktop's in its own
    // staging, the website's in this browser).
    const awayTranslated = (who, A, gid, bytes) => whileAway(who, A, () => who.putTranslation(gid, 1, bytes));
    try {
      // The kill forms stop the desktop at the take-back's first file call after its claim is written (before
      // the drop), and as the drop deletes what waited in its staging (after it committed).
      for (const form of ['no fault', 'a kill as the take-back begins', 'a kill as what waited is deleted']) {
        const A = path.join(dir, form);
        const id = await lib.add(A);
        await lib.setDefault(id);
        const gid = await lib.newGallery('Alpha');
        for (let n = 1; n <= 2; n++) await lib.putPage(gid, n, pngOf(n));
        await lib.flush();
        await awayTranslated(lib, A, gid, pngOf(8));
        const w = await website.add(A, { force: true });   // the website: "Use anyway"
        await website.scan(w);
        await website.putTranslation(gid, 1, pngOf(7));
        await website.flush();
        await until(() => fs.existsSync(path.join(A, 'Alpha', 'translated', '0001.png')));
        assert.equal((await lib.list()).find(f => f.id === id)?.access, 'taken', `${form}: the desktop sees the folder used elsewhere`);
        assert.equal(await reason(lib.putTranslation(gid, 2, pngOf(9))), 'not-owned', `${form}: a translation tried meanwhile is refused`);
        await website.setDefault(website.home);
        await website.remove(w);   // the website lets go
        if (form.startsWith('a kill')) {
          await lib.close();
          assert.equal(desktopKilled(base, async ({ lib, kill, id, form }) => {
            let claimed = false;
            kill((c) => {
              if (form.endsWith('begins')) { if (claimed) return true; claimed = c.op === 'rename' && /\/\.shiori\/owner\.json$/.test(c.to ?? ''); return false; }
              return c.op === 'rm' && /\/data\/staging\//.test(c.path);
            });
            await lib.raw.folderClaim(id);   // taken back
            await lib.flush();
            await new Promise(r => setTimeout(r, 500));
          }, { id, form }), 42, `${form}: killed`);
          lib = await desktopLibrary(base);
        } else {
          assert.equal(await lib.raw.folderClaim(id), 'granted');
        }
        await lib.flush();
        for (let i = 0; i < 2; i++) assert.deepEqual((await lib.scan(id)).problems, [], `${form}: check ${i + 1}, nothing reported`);
        await lib.restart();
        await lib.flush();
        assert.ok((await lib.galleries()).includes(gid), `${form}: the gallery is listed`);
        assert.deepEqual(await lib.read(gid, 1, 'translated'), pngOf(7), `${form}: the desktop reads the folder's translation`);
        assert.deepEqual(bytesAt(A), { '0001.png': 7 }, `${form}: nothing of the desktop's went into the folder`);
        assert.deepEqual(await changedBoth(lib, id), ['Alpha'], `${form}: reported once`);
        await lib.remove(id);
        const again = await lib.add(A);
        assert.deepEqual((await lib.scan(again)).problems, [], `${form}: added again, nothing reported`);
        assert.deepEqual(await lib.read(gid, 1, 'translated'), pngOf(7), `${form}: the folder added again reads it too`);
        await lib.setDefault(lib.home);
        await lib.remove(again);
      }
      // The website's mirror: the desktop used its folder anyway and translated page 1 there.
      const A = path.join(dir, 'mirror');
      const id = await website.add(A);
      await website.setDefault(id);
      const gid = await website.newGallery('Alpha');
      for (let n = 1; n <= 2; n++) await website.putPage(gid, n, pngOf(n));
      await website.flush();
      await awayTranslated(website, A, gid, pngOf(8));
      const d = await lib.add(A, { force: true });
      await lib.scan(d);
      await lib.putTranslation(gid, 1, pngOf(7));
      await lib.flush();
      await until(() => fs.existsSync(path.join(A, 'Alpha', 'translated', '0001.png')));
      assert.equal((await website.list()).find(f => f.id === id)?.access, 'taken', 'the website sees the folder used elsewhere');
      assert.equal(await reason(website.putTranslation(gid, 2, pngOf(9))), 'not-owned', 'a translation tried meanwhile is refused');
      await lib.setDefault(lib.home);
      await lib.remove(d);
      assert.equal(await website.raw.folderClaim(id), 'granted');
      await website.flush();
      for (let i = 0; i < 2; i++) assert.deepEqual((await website.scan(id)).problems, [], `check ${i + 1}, nothing reported`);
      await website.flush();
      assert.deepEqual(await website.read(gid, 1, 'translated'), pngOf(7), 'the website reads the folder\'s translation');
      assert.deepEqual(bytesAt(A), { '0001.png': 7 }, 'nothing of the website\'s went into the folder');
      assert.equal((await website.raw.galleryGet(gid)).spilled, undefined, 'nothing waits in the browser');
      assert.deepEqual(await changedBoth(website, id), ['Alpha'], 'reported once');
      await website.setDefault(website.home);
      await website.remove(id);
      assert.deepEqual((await website.scan(await website.add(A))).problems, [], 'added again, nothing reported');
      assert.deepEqual(await website.read(gid, 1, 'translated'), pngOf(7), 'the folder added again reads it too');
    } finally { await lib.close(); }
  },
};

// B5 (review 7, the website): while the desktop used the website's folder anyway it archived the website's
// gallery, or moved it into another folder of the website's, or the person renamed its folder then; the
// website had translated page 1 while the drive was away just before, its picture waiting in this browser.
// At the take-back its check followed the gallery only by reading it again there — refused while something
// of it waits — so it stayed bound to a place that is gone: its pages unreadable, its translation never
// reaching the folder, nothing reported. Followed apart from being read again, it takes the place it is in
// now. Under the owner's rule of 2026-11-15 (one app changes a folder's galleries at a time) what waited
// goes there where the desktop published nothing of the gallery (the rename), and is dropped, reported
// once, where it did (archiving and a move publish it there: the folder's version stands); the desktop,
// adding the folder again, reads the same. And the desktop's mirror (scan.js moveTo, unpackedTo): its
// translation waiting while the website unpacked its archived gallery (a change of it there: dropped), or
// the person renamed its folder (it goes there), at its take-back.
const FOLLOWED = {
  name: 'review 7 B5: a gallery the other app archived, moved or unpacked while it used the folder anyway, or the person renamed then, is followed at the take-back — what waited going there, or dropped where that app published the gallery',
  async run({ dir, desktop, website }) {
    const pngOf = (n) => png(0, n);
    // `who` translates page `n` while folder `F`'s drive is away: it waits there (before the other app's "Use anyway").
    const awayTranslated = (who, F, gid, n, bytes) => whileAway(who, F, () => who.putTranslation(gid, n, bytes));
    const changedBoth = async (app, id) => (await app.list()).find(f => f.id === id).attention.filter(a => a.reason === 'changed-both').length;
    // Archiving and a move publish the gallery on the desktop (its own actions, the person changing nothing):
    // the folder's version stands, and the website's translation that waited is dropped. A rename by hand
    // publishes nothing: it goes there.
    for (const form of ['archived', 'moved to another of its folders', 'renamed by hand']) {
      const F = path.join(dir, `website ${form}`), G = path.join(dir, `website ${form} G`);
      const id = await website.add(F);
      const two = form.startsWith('moved') ? await website.add(G) : null;
      await website.setDefault(id);
      const gid = await website.newGallery('Alpha');
      for (let n = 1; n <= 2; n++) await website.putPage(gid, n, pngOf(n));
      await website.flush();
      await awayTranslated(website, F, gid, 1, pngOf(7));   // waits in this browser
      const theirs = [await desktop.add(F, { force: true }), ...(two ? [await desktop.add(G, { force: true })] : [])];   // "Use anyway"
      await desktop.scan(theirs[0]);
      if (form === 'archived') assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid], form);
      if (two) await desktop.move(gid, theirs[1]);
      if (form.startsWith('renamed')) { fs.renameSync(path.join(F, 'Alpha'), path.join(F, 'Alpha by hand')); await desktop.scan(theirs[0]); }
      await desktop.flush();
      await desktop.setDefault(desktop.home);
      for (const f of theirs) await desktop.remove(f);   // the desktop lets go
      for (const f of [id, two].filter(Boolean)) assert.equal(await website.raw.folderClaim(f), 'granted', `${form}: taken back`);
      const now = two ?? id, kept = form.startsWith('renamed');
      const at = kept ? path.join(F, 'Alpha by hand') : form === 'archived' ? null : path.join(G, 'Alpha');
      await website.scan(now);
      await website.flush();
      await new Promise(r => setTimeout(r, 300));
      for (let i = 0; i < 2; i++) assert.deepEqual((await website.scan(now)).problems, [], `${form}: check ${i + 1}, nothing reported`);
      assert.deepEqual([await website.dirOf(gid), await website.read(gid, 1), await website.read(gid, 2)], [at, pngOf(1), pngOf(2)], `${form}: followed`);
      assert.equal(same(await website.read(gid, 1, 'translated'), pngOf(7)), kept, `${form}: its translation ${kept ? 'read' : 'dropped'}`);
      assert.equal((await website.raw.galleryGet(gid)).spilled, undefined, `${form}: nothing waits in the browser`);
      assert.equal(await changedBoth(website, now), kept ? 0 : 1, `${form}: ${kept ? 'nothing' : 'the drop'} reported`);
      if (kept) assert.ok(JSON.parse(fs.readFileSync(path.join(at, '.shiori', 'gallery.json'), 'utf8')).files.pages[1].translated, `${form}: its translation in the folder`);
      if (form === 'archived') assert.ok(fs.readdirSync(F).some(n => /\.(zip|cbz)$/i.test(n)), `${form}: read from the archive, nothing unpacked for what was dropped`);
      for (const f of [id, two].filter(Boolean)) { await website.setDefault(website.home); await website.remove(f); }
      const back = await desktop.add(two ? G : F);
      assert.deepEqual((await desktop.scan(back)).problems, [], `${form}: the folder added again, nothing reported`);
      assert.equal(same(await desktop.read(gid, 1, 'translated'), pngOf(7)), kept, `${form}: read alike by the desktop`);
      await desktop.setDefault(desktop.home);
      await desktop.remove(back);
    }
    // The website's unpack is a change of the gallery there: the desktop's translation that waited is dropped.
    for (const form of ['unpacked', 'renamed by hand']) {
      const F = path.join(dir, `desktop ${form}`);
      const id = await desktop.add(F);
      await desktop.setDefault(id);
      const gid = await desktop.newGallery('Alpha');
      for (let n = 1; n <= 2; n++) await desktop.putPage(gid, n, pngOf(n));
      await desktop.flush();
      if (form === 'unpacked') assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid], form);
      await desktop.setDefault(desktop.home);
      await awayTranslated(desktop, F, gid, 2, pngOf(8));   // waits in its own staging
      const w = await website.add(F, { force: true });   // "Use anyway" on the website
      await website.scan(w);
      if (form === 'unpacked') {
        await website.putTranslation(gid, 1, pngOf(7));   // its first change there: unpacked beside the archive, the archive deleted
        await website.flush();
        await until(() => !fs.readdirSync(F).some(n => /\.(zip|cbz)$/i.test(n)));
      } else {
        fs.renameSync(path.join(F, 'Alpha'), path.join(F, 'Alpha by hand'));
        await website.scan(w);   // followed there too (its removal writes back where it now is)
      }
      await website.setDefault(website.home);
      await website.remove(w);
      await desktop.raw.folderClaim(id);   // taken back
      await desktop.flush();
      await new Promise(r => setTimeout(r, 300));
      for (let i = 0; i < 2; i++) assert.ok(!(await desktop.scan(id)).problems.some(p => p.reason === 'duplicate'), `${form}: check ${i + 1}, no copy`);
      await desktop.flush();
      const kept = form.startsWith('renamed');
      const at = path.join(F, kept ? 'Alpha by hand' : 'Alpha');
      assert.deepEqual([await desktop.dirOf(gid), await desktop.read(gid, 1), await desktop.read(gid, 2)], [at, pngOf(1), pngOf(2)], `${form}: followed`);
      assert.equal(same(await desktop.read(gid, 2, 'translated'), pngOf(8)), kept, `${form}: its translation ${kept ? 'read' : 'dropped'}`);
      assert.equal(!!JSON.parse(fs.readFileSync(path.join(at, '.shiori', 'gallery.json'), 'utf8')).files.pages[2].translated, kept, `${form}: in the folder ${kept ? 'too' : 'neither'}`);
      assert.equal(await changedBoth(desktop, id), kept ? 0 : 1, `${form}: ${kept ? 'nothing' : 'the drop'} reported`);
      if (!kept) assert.deepEqual(await desktop.read(gid, 1, 'translated'), pngOf(7), `${form}: the website's translation reads`);
      await desktop.setDefault(desktop.home);
      await desktop.remove(id);
    }
  },
};

// A3 (review 7, the desktop; S26a fixed the website alone): a website write the drive cut short leaves the
// browser's swap file (`<name>.crswap`) beside its file, which only the website's own writes make. The
// desktop, deleting that gallery, took the swap file for the person's: the folder stayed, two empty folders
// and the swap file, reported 'left' on Needs attention for good; archiving it kept it a folder. A folder
// Shiori empties goes with the browser's swap files left in it, on both apps (folder-content.js SWAP_FILE).
const SWAP_LEFT = {
  name: 'review 7 A3: the browser\'s swap file a website write left is never the person\'s for the desktop: a deletion and archiving take the folder with it',
  async run({ dir, desktop, website }) {
    for (const then of ['deleted', 'archived']) {
      const A = path.join(dir, then);
      const wid = await website.add(A);
      await website.setDefault(wid);
      const gid = await website.newGallery('Alpha');
      for (let n = 1; n <= 2; n++) await website.putPage(gid, n, png(0, n));
      await website.flush();
      // The drive away at the write of a translation, back two calls later: the browser's swap file stays.
      let step = 0, k = 0;
      const undo = fsa.failNext((c) => {
        if (!step && c.op === 'write' && /^Alpha\/translated\//.test(c.path)) { step = 1; fs.renameSync(A, `${A}.away`); } else if (step === 1 && ++k === 2) { step = 2; fs.renameSync(`${A}.away`, A); }
        return false;
      }, 'NotFoundError', { times: Infinity });
      await website.putTranslation(gid, 1, png(0, 7)).catch(() => {});
      await website.flush();
      undo();
      if (fs.existsSync(`${A}.away`)) fs.renameSync(`${A}.away`, A);
      await website.flush();
      const swaps = () => fs.readdirSync(A, { recursive: true }).map(String).filter(p => p.endsWith('.crswap'));
      assert.equal(swaps().length, 1, `${then}: the browser's swap file is left`);
      await website.setDefault(website.home);
      await website.remove(wid);   // the website lets the folder go
      const id = await desktop.add(A);
      await desktop.setDefault(id);
      await desktop.scan(id);
      if (then === 'deleted') await desktop.deleteGallery(gid);
      else assert.deepEqual((await desktop.raw.archiveGallery(gid)).archived, [gid], 'archived');
      await desktop.flush();
      await until(() => !fs.existsSync(path.join(A, 'Alpha')));
      for (let i = 0; i < 2; i++) assert.deepEqual((await desktop.scan(id)).problems, [], `${then}: nothing reported`);
      assert.deepEqual((await desktop.list()).find(f => f.id === id).attention, [], `${then}: nothing on Needs attention`);
      assert.deepEqual(swaps(), [], `${then}: the swap file went with the folder`);
      if (then === 'archived') assert.deepEqual([await desktop.read(gid, 1), await desktop.read(gid, 2)], [png(0, 1), png(0, 2)], 'read from its archive');
      await desktop.setDefault(desktop.home);
      await desktop.remove(id);
    }
  },
};

// B1 (review 7, desktop × desktop): a picture one desktop library committed and staged in a library folder's
// own staging (an archived gallery's translation waits there for its lifecycle point) was deleted by another
// desktop library's check once that one used the folder anyway — staging names didn't say whose — and back on
// the first it never read again, nothing reported. A folder's staging is the library's that wrote it
// (`.shiori/staging/<its id>/…`): no other library's check deletes it, nor the website's, and at the take-back
// what waited is published where the other changed nothing of that gallery, dropped and reported once where it
// changed it (one app changes a folder's galleries at a time). Files staged in the layout before S29b
// (`.shiori/staging/<gid>/…`, the index naming them so: as `4211111` and earlier wrote them, toOldLayout) are
// still read and placed by the library whose index names them, and never deleted by another's.
const STAGED = {
  name: 'review 7 B1: what one desktop library staged in a folder is its own — another library\'s or the website\'s check never deletes it, and at the take-back it is published where the other changed nothing, dropped and reported where it changed the gallery; the layout before S29b too',
  async run({ dir, desktop, website }) {
    const other = await desktopLibrary(path.join(dir, 'other desktop'), { me: 'c0ffee00c0ffee00' });   // the desktop app on another computer
    try {
      for (const form of ['another desktop', 'the website', 'another desktop, the layout before S29b', 'the layout before S29b, alone']) {
        const F = path.join(dir, form);
        const id = await desktop.add(F);
        await desktop.setDefault(id);
        const touched = await desktop.newGallery('Touched'), untouched = await desktop.newGallery('Untouched');
        for (const g of [touched, untouched]) for (let n = 1; n <= 2; n++) await desktop.putPage(g, n, png(0, n));
        await desktop.flush();
        for (const g of [touched, untouched]) assert.deepEqual((await desktop.raw.archiveGallery(g)).archived, [g], form);
        for (const g of [touched, untouched]) await desktop.putTranslation(g, 1, png(0, 71));   // waits in the folder's staging for the archive's lifecycle point
        const old = form.includes('before S29b');
        if (old) toOldLayout(desktop, F);
        const mine = stagedIn(F);
        assert.equal(mine.length, 2, `${form}: staged in the folder`);
        const by = form === 'the website' ? website : form.endsWith('alone') ? null : other;
        const changes = by && !old;
        if (by) {
          const theirs = await by.add(F, { force: true });   // "Use anyway"
          agedStaging(F);   // its check an hour later
          assert.deepEqual((await by.scan(theirs)).problems, [], `${form}: its check reports nothing`);
          assert.deepEqual(stagedIn(F), mine, `${form}: its check deleted nothing staged here`);
          if (changes) await by.setTitle(touched, 'Touched there');   // it changes one of them
          await by.flush();
          await by.setDefault(by.home);
          await by.remove(theirs);   // it lets go
          assert.equal(await desktop.raw.folderClaim(id), 'granted', `${form}: taken back`);
        } else await desktop.restart();   // an index and a folder written by 4211111, opened by this code
        await desktop.flush();
        await new Promise(r => setTimeout(r, 300));
        for (let i = 0; i < 2; i++) { assert.deepEqual((await desktop.scan(id)).problems, [], `${form}: check ${i + 1}, nothing reported`); await desktop.flush(); }
        assert.deepEqual([same(await desktop.read(untouched, 1, 'translated'), png(0, 71)), same(await desktop.read(touched, 1, 'translated'), png(0, 71))], [true, !changes],
          `${form}: published where the other changed nothing${changes ? ', dropped where it changed the gallery' : ''}`);
        const notes = (await desktop.list()).find(f => f.id === id).attention.filter(a => a.reason === 'changed-both');
        assert.equal(notes.length, changes ? 1 : 0, `${form}: ${changes ? 'the drop reported once' : 'nothing reported'}`);
        if (changes) assert.equal(await desktop.titleOf(touched), 'Touched there', `${form}: the other's change stands`);
        assert.deepEqual(stagedIn(F), [], `${form}: nothing left staged`);
        await desktop.setDefault(desktop.home);
        await desktop.remove(id);
        const again = await other.add(F);
        assert.deepEqual((await other.scan(again)).problems, [], `${form}: added again elsewhere, nothing reported`);
        assert.deepEqual([same(await other.read(untouched, 1, 'translated'), png(0, 71)), same(await other.read(touched, 1, 'translated'), png(0, 71))], [true, !changes], `${form}: read alike there`);
        await other.setDefault(other.home);
        await other.remove(again);
      }
    } finally { await other.close(); }
  },
};
// The same with a kill (review 7's b1-kill): the desktop killed as a page it staged in the folder was being
// placed in its gallery's folder; another desktop library used the folder anyway and checked it an hour later;
// back on the first, the page reads and is in the folder. And a staged picture not found as it is placed
// (deleted by hand, or by an earlier version's check): reported once ('missing-file'), never dropped unsaid —
// it still waits, named by no publication, and the folder's removal asks before it goes without it.
const STAGED_KILLED = {
  name: 'review 7 B1: a page staged in the folder by a desktop killed as it placed it survives another library\'s check, and reads after the take-back; one deleted from staging is reported, and named by nothing',
  async run({ dir, desktop }) {
    await desktop.close();
    const base = path.join(dir, 'desktop');
    const other = await desktopLibrary(path.join(dir, 'other desktop'), { me: 'c0ffee00c0ffee00' });
    let lib = null;
    try {
      for (const form of ['killed', 'killed, then deleted from staging by hand', 'a translation deleted from staging by hand']) {
        const F = path.join(dir, form);
        const page = form.startsWith('killed'), gone = form.includes('deleted');
        const gid = page ? '1790000000100' : '1790000000110';
        let id = null;
        if (page) {
          await lib?.close();
          lib = null;
          assert.equal(desktopKilled(base, async ({ lib, kill, F, gid }) => {
            const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, n]);
            const id = await lib.add(F);
            await lib.setDefault(id);
            await lib.newGallery('Alpha', gid);
            for (let n = 1; n <= 2; n++) await lib.putPage(gid, n, png(n));
            await lib.flush();
            kill((c) => c.op === 'rename' && /\/staging\//.test(c.path));   // the page staged, killed as it is placed
            await lib.putPage(gid, 3, png(3));
            await new Promise(r => setTimeout(r, 2000));
          }, { F, gid }), 42, form);
        } else {
          lib ??= await desktopLibrary(base);
          id = await lib.add(F);
          await lib.setDefault(id);
          await lib.newGallery('Alpha', gid);
          for (let n = 1; n <= 2; n++) await lib.putPage(gid, n, png(0, n));
          await lib.flush();
          assert.deepEqual((await lib.raw.archiveGallery(gid)).archived, [gid], form);
          await lib.putTranslation(gid, 1, png(0, 71));   // waits in the folder's staging
        }
        assert.equal(stagedIn(F).length, 1, `${form}: staged in the folder`);
        if (gone) fs.rmSync(path.join(F, '.shiori', 'staging', ...stagedIn(F)[0].split('/')));
        else {
          const theirs = await other.add(F, { force: true });   // "Use anyway", on another computer
          agedStaging(F);
          assert.deepEqual((await other.scan(theirs)).problems, [], `${form}: its check reports nothing`);
          assert.equal(stagedIn(F).length, 1, `${form}: its check deleted nothing staged here`);
          await other.setDefault(other.home);
          await other.remove(theirs);
        }
        lib ??= await desktopLibrary(base);   // the desktop starts again
        id ??= /** @type {any} */ ((await lib.list()).find(f => f.id !== lib?.home)).id;
        if (!gone) assert.equal(await lib.raw.folderClaim(id), 'granted', `${form}: taken back`);
        await lib.flush();
        await new Promise(r => setTimeout(r, 300));
        await lib.flush();
        const attention = (await lib.list()).find(f => f.id === id).attention.map(a => a.reason);
        if (gone) {
          assert.deepEqual(attention, ['missing-file'], `${form}: reported`);
          assert.ok(!same(page ? await lib.read(gid, 3) : await lib.read(gid, 1, 'translated'), page ? png(0, 3) : png(0, 71)), `${form}: it doesn't read`);
          assert.deepEqual([await lib.read(gid, 1), await lib.read(gid, 2)], [png(0, 1), png(0, 2)], `${form}: the rest reads`);
        } else {
          assert.deepEqual(await lib.read(gid, 3), png(0, 3), `${form}: page 3 reads after the take-back`);
          assert.ok(JSON.parse(fs.readFileSync(path.join(F, 'Alpha', '.shiori', 'gallery.json'), 'utf8')).files.pages[3], `${form}: in the folder`);
          assert.deepEqual(attention, [], `${form}: nothing reported`);
        }
        assert.deepEqual([stagedIn(F), (await lib.scan(id)).problems], [[], []], `${form}: nothing left staged in the folder, a check reports nothing`);
        assert.deepEqual(namedMissing(F), [], `${form}: the folder holds every file it names (one still waiting named by none)`);
        await lib.setDefault(lib.home);
        // What can't be found still waits (a "not found" may have been one of a moment): the folder's removal
        // asks, and goes with "Remove anyway".
        if (gone) assert.notEqual(await lib.remove(id).then(() => 'removed', (e) => e.reason ?? e.code), 'removed', `${form}: the removal is refused first`);
        await lib.remove(id, { discard: gone });
      }
    } finally { await lib?.close(); await other.close(); }
  },
};
// B6 (review 7): the desktop killed just after it unpacked an archived gallery left the folder it unpacked
// into at generation 0 — a reservation, which no other app takes for a gallery — beside the archive; the
// website, using the folder anyway, read the gallery from the archive and its first change unpacked a second
// copy beside them ('Alpha (2)'): each app kept its own, reported the other's 'duplicate' for good, and the
// website's work read on neither. An unpack's folder is published (a generation naming what it holds) before
// it takes its place — the desktop's in the folder it is made in before that is renamed into place, the
// website's before its records take it — so what a kill leaves at any point is a whole gallery to any reader,
// or no gallery; a first check takes a folder over an archive naming the same gallery; and an app keeping a
// gallery in an archive that finds a folder beside it naming the gallery at a later generation takes the
// folder (at a check, or at the unpack it was about to make), never unpacks a second copy, and deletes the
// archive as its own unpack would.
const UNPACK_MET = {
  name: 'review 7 B6: an unpack cut short — the desktop killed, the website\'s page dying — is met whole by the other app: one gallery, never a second copy, both apps\' work read on both, no copy reported',
  async run({ dir, desktop, website }) {
    await desktop.close();
    const base = path.join(dir, 'desktop');
    let lib = null;
    // A page's Web Locks go with it: the in-context ones, each page's own (folder-store-web.js withLock).
    Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const copies = (problems) => problems.filter(p => p.reason === 'duplicate').map(p => p.path);
    const held = (F) => fs.readdirSync(F).filter(n => !n.startsWith('.')).sort();
    const reads = async (app, g, want) => { for (const [n, b] of want) assert.deepEqual(await app.read(g, n, 'translated'), b, `${app.app} reads translation ${n}`); };
    // The website's page dies at the first file call `at` matches: it and every later one of that page never return.
    const dies = (at) => {
      let died = () => {};
      const death = new Promise((r) => { died = r; });
      let dead = null;
      const undo = fsa.hang((c) => {
        const page = pageCalling();
        if (page != null && page === dead) return true;
        if (dead != null || page !== pageNow() || !at(c)) return false;
        dead = page;
        died();
        return true;
      });
      return { death, undo };
    };
    try {
      // 1. The desktop killed as it deletes the archive its unpack let go (review 7's b6-unpack).
      {
        const F = path.join(dir, 'the desktop killed'), g = '1790000000200';
        assert.equal(desktopKilled(base, async ({ lib, kill, F, g }) => {
          const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, n]);
          const id = await lib.add(F);
          await lib.setDefault(id);
          await lib.newGallery('Alpha', g);
          for (let n = 1; n <= 3; n++) await lib.putPage(g, n, png(n));
          await lib.putTranslation(g, 1, png(5));
          await lib.flush();
          await lib.raw.archiveGallery(g);
          kill((c) => ['rm', 'unlink'].includes(c.op) && /Alpha\.(zip|cbz)$/.test(c.path));   // the archive's deletion after the unpack
          await lib.putTranslation(g, 2, png(4));   // its first change: unpacked to take it
          await lib.flush();
        }, { F, g }), 42, 'killed');
        const w = await website.add(F, { force: true });   // "Use anyway"
        assert.deepEqual(copies((await website.scan(w)).problems), [], 'the desktop killed: the website\'s check finds no copy');
        await website.putTranslation(g, 3, png(0, 6));
        await website.flush();
        await sleep(500);
        assert.deepEqual(held(F), ['Alpha', 'Alpha.zip'], 'the desktop killed: no second copy');
        await website.setDefault(website.home);
        await website.remove(w);
        lib = await desktopLibrary(base);   // the desktop starts again, and takes the folder back
        const id = /** @type {any} */ ((await lib.list()).find(f => f.id !== lib?.home)).id;
        assert.equal(await lib.raw.folderClaim(id), 'granted');
        await lib.flush();
        await sleep(400);
        for (let i = 0; i < 2; i++) { assert.deepEqual(copies((await lib.scan(id)).problems), [], `the desktop killed: its check ${i + 1}, no copy`); await lib.flush(); }
        await reads(lib, g, [[1, png(0, 5)], [2, png(0, 4)], [3, png(0, 6)]]);
        assert.deepEqual(held(F), ['Alpha'], 'the desktop killed: the archive deleted, one gallery');
        await lib.setDefault(lib.home);
        await lib.remove(id);
        const again = await website.add(F);
        for (let i = 0; i < 2; i++) { assert.deepEqual((await website.scan(again)).problems, [], `the desktop killed: the website's check ${i + 1} again, nothing reported`); await website.flush(); }
        await reads(website, g, [[1, png(0, 5)], [2, png(0, 4)], [3, png(0, 6)]]);
        await website.setDefault(website.home);
        await website.remove(again);
      }
      // 2. The website's page dying as it deletes the archive its unpack let go (its records took the folder):
      //    the desktop uses the folder anyway before the page is loaded again.
      // 3. The same dying before its records took it (as its publication's stable-named copies are written):
      //    the website, loaded again, keeps the gallery in the archive and finds the folder beside it — at a
      //    check, or at its next change's unpack.
      for (const form of ['its records took the folder', 'before its records took the folder, at a check', 'before its records took the folder, at its unpack']) {
        const F = path.join(dir, `the website's page dying, ${form}`);
        lib ??= await desktopLibrary(base);
        const id = await lib.add(F);
        await lib.setDefault(id);
        const g = await lib.newGallery('Alpha');
        for (let n = 1; n <= 3; n++) await lib.putPage(g, n, png(0, n));
        await lib.putTranslation(g, 1, png(0, 5));
        await lib.flush();
        assert.deepEqual((await lib.raw.archiveGallery(g)).archived, [g]);
        await lib.setDefault(lib.home);
        await lib.remove(id);   // the desktop lets go
        const w = await website.add(F);
        assert.deepEqual((await website.scan(w)).problems, [], form);
        const before = form.startsWith('before');
        const { death, undo } = dies((c) => (before ? c.path === 'Alpha/image_records.json' : c.op === 'removeEntry' && /Alpha\.(zip|cbz)$/.test(c.path)));
        website.putTranslation(g, 2, png(0, 7)).catch(() => {});   // its first change unpacks it; the page dies on the way
        await death;
        if (before) {
          await website.restart();   // the page loaded again
          undo();
          if (form.endsWith('a check')) assert.deepEqual(copies((await website.scan(w)).problems), [], `${form}: no copy`);
          await website.putTranslation(g, 2, png(0, 7));
          await website.flush();
          await sleep(300);
          assert.deepEqual(held(F), ['Alpha'], `${form}: the website took the folder, the archive deleted — never a second copy`);
        }
        // The desktop meets what the website left: "Use anyway", a check, a change.
        const d = await lib.add(F, { force: true });
        assert.deepEqual(copies((await lib.scan(d)).problems), [], `${form}: the desktop's check finds no copy`);
        await lib.putTranslation(g, 3, png(0, 6));
        await lib.flush();
        assert.ok(!held(F).includes('Alpha (2)'), `${form}: no second copy`);
        await lib.setDefault(lib.home);
        await lib.remove(d);
        if (!before) { await website.restart(); undo(); }
        assert.equal(await website.raw.folderClaim(w), 'granted', `${form}: taken back`);
        await website.flush();
        await sleep(1200);   // the website reads another app's work once it isn't busy with the gallery (§8)
        for (let i = 0; i < 2; i++) { assert.deepEqual(copies((await website.scan(w)).problems), [], `${form}: the website's check ${i + 1}, no copy`); await website.flush(); }
        const want = [[1, png(0, 5)], [2, before ? png(0, 7) : png(0, 2)], [3, png(0, 6)]];   // (the change the dying page made never committed)
        await reads(website, g, want);
        assert.deepEqual(held(F), ['Alpha'], `${form}: one gallery, the archive deleted`);
        assert.deepEqual(namedMissing(F), [], `${form}: the folder holds every file it names`);
        await website.setDefault(website.home);
        await website.remove(w);
        const back = await lib.add(F);
        assert.deepEqual((await lib.scan(back)).problems, [], `${form}: the desktop's check again, nothing reported`);
        await reads(lib, g, want);
        await lib.setDefault(lib.home);
        await lib.remove(back);
      }
      // 4. The desktop keeping the gallery in its archive meets the folder the website's dying page published
      //    beside it before its records took it — at the check of its take-back, and at its own unpack.
      for (const form of ['at a check', 'at its unpack']) {
        const F = path.join(dir, `the desktop keeping the archive, ${form}`);
        lib ??= await desktopLibrary(base);
        const id = await lib.add(F);
        await lib.setDefault(id);
        const g = await lib.newGallery('Alpha');
        for (let n = 1; n <= 3; n++) await lib.putPage(g, n, png(0, n));
        await lib.putTranslation(g, 1, png(0, 5));
        await lib.flush();
        assert.deepEqual((await lib.raw.archiveGallery(g)).archived, [g]);
        const w = await website.add(F, { force: true });   // the website: "Use anyway"
        await website.scan(w);
        const { death, undo } = dies((c) => c.path === 'Alpha/image_records.json');
        website.putTranslation(g, 2, png(0, 7)).catch(() => {});
        await death;
        undo();
        await website.restart();   // the page closed: its claim stays
        assert.equal(await lib.raw.folderClaim(id), 'granted', `${form}: the desktop takes it back`);
        if (form === 'at a check') assert.deepEqual(copies((await lib.scan(id)).problems), [], `${form}: no copy`);
        await lib.putTranslation(g, 3, png(0, 6));
        await lib.flush();
        await sleep(300);
        for (let i = 0; i < 2; i++) { assert.deepEqual(copies((await lib.scan(id)).problems), [], `${form}: its check ${i + 1}, no copy`); await lib.flush(); }
        assert.deepEqual(held(F), ['Alpha'], `${form}: it took the folder, the archive deleted — never a second copy`);
        assert.deepEqual(namedMissing(F), [], `${form}: the folder holds every file it names`);
        // A change made before any check finds the website's generation there: the folder's version stands
        // (one app changes a folder's galleries at a time), that change dropped and reported once.
        const dropped = form === 'at its unpack';
        assert.equal(same(await lib.read(g, 3, 'translated'), png(0, 6)), !dropped, `${form}: its translation ${dropped ? 'dropped' : 'read'}`);
        assert.equal((await lib.list()).find(f => f.id === id).attention.filter(a => a.reason === 'changed-both').length, dropped ? 1 : 0, `${form}: reported ${dropped ? 'once' : 'never'}`);
        await lib.setDefault(lib.home);
        await lib.remove(id);
      }
    } finally { await lib?.close(); delete /** @type {any} */ (globalThis.navigator).locks; }
  },
};
// The files staged in folder `F`'s staging, as paths there (sorted).
function stagedIn(F) {
  const at = path.join(F, '.shiori', 'staging');
  return fs.existsSync(at) ? fs.readdirSync(at, { recursive: true }).map(p => String(p).replaceAll('\\', '/')).filter(p => fs.statSync(path.join(at, p)).isFile()).sort() : [];
}
// Everything in folder `F`'s staging aged an hour (the other app's check comes that much later: scan.js ORPHAN_AGE_MS).
function agedStaging(F) {
  const at = path.join(F, '.shiori', 'staging'), t = (Date.now() - 3600_000) / 1000;
  for (const p of fs.readdirSync(at, { recursive: true })) fs.utimesSync(path.join(at, String(p)), t, t);
}
// What the desktop library `lib` staged in folder `F` put as `4211111` and earlier wrote it: each file at
// `.shiori/staging/<gid>/<name>`, its index naming it so (`@<folder>/<gid>/<name>`), not under the library's own id.
function toOldLayout(lib, F) {
  const raw = lib.raw, files = raw.files;
  const moved = (file) => {
    const { root, rest } = files._split(file);
    const old = rest.replace(new RegExp(`^${raw.primaryId}/`), '');
    const [from, to] = [rest, old].map(r => path.join(F, '.shiori', 'staging', ...r.split('/')));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (from !== to) fs.renameSync(from, to);
    return files._join(root, old);
  };
  for (const r of raw._s('SELECT gid, rel, file FROM staged_own').all()) raw._s('UPDATE staged_own SET file = ? WHERE gid = ? AND rel = ?').run(moved(r.file), r.gid, r.rel);
  for (const r of raw._s(`SELECT gid, n, orig FROM pages WHERE json_extract(orig, '$.at') = 's'`).all()) {
    const orig = JSON.parse(r.orig);
    raw._s('UPDATE pages SET orig = ? WHERE gid = ? AND n = ?').run(JSON.stringify({ ...orig, file: moved(orig.file) }), r.gid, r.n);
  }
}

// Resolves once `ready()` holds, failed after `ms`.
async function until(ready, ms = 5000) {
  for (const end = Date.now() + ms; !(await ready()); await new Promise(r => setTimeout(r, 25))) {
    if (Date.now() > end) throw new Error('it never happened');
  }
}

// These drive both libraries themselves: run against the desktop library (npm run test:desktop),
// there is nothing more to run.
const skip = !!globalThis.__desktopLibrary && 'run by npm test';
for (const [direction, apps] of [['website to desktop', ['website', 'desktop']], ['desktop to website', ['desktop', 'website']]]) {
  describe(`hand-over, ${direction}`, () => {
    for (const h of CASES) {
      test(h.name, { skip, todo: h.todo }, async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-handover-'));
        const desktop = await desktopLibrary(path.join(dir, 'desktop'));
        const website = await webLibrary();
        t.after(async () => { faults.reset(); fsa.reset(); await desktop.close(); fs.rmSync(dir, { recursive: true, force: true }); });
        const [from, to] = apps.map(app => (app === 'website' ? website : desktop));
        await h.run({ dir, from, to });
      });
    }
    if (apps[0] === 'desktop') {
      for (const h of [ARCHIVED, OLDEST, UNPACKED, CUT_SHORT, EDITED, NOTES_UNREAD, FIRST_FOLDER, NOTED_ARCHIVE, DELETED_ON_TAKE_BACK, KILLED_UNPACK, ARCHIVE_DELETED, BOTH_TRANSLATED, SWAP_LEFT, FOLLOWED,
        STAGED, STAGED_KILLED, UNPACK_MET]) {
        test(h.name, { skip }, async (t) => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-handover-'));
          const desktop = await desktopLibrary(path.join(dir, 'desktop'));
          const website = await webLibrary();
          t.after(async () => { fsa.reset(); await desktop.close(); fs.rmSync(dir, { recursive: true, force: true }); });
          await h.run({ dir, desktop, website });
        });
      }
    }
  });
}

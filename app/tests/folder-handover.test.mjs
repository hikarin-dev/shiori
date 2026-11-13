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
import { desktopLibrary, webLibrary, desktopKilled } from './library-drivers.mjs';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { zipCreate } from '../js/zip.js';
import { legacyGallery, v1Gallery } from './fixtures/storage-fixtures.mjs';

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
];
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
      for (const h of [ARCHIVED, OLDEST, UNPACKED, CUT_SHORT, EDITED, KILLED_UNPACK, ARCHIVE_DELETED]) {
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

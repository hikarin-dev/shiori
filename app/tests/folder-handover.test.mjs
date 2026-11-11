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
import { desktopLibrary, webLibrary } from './library-drivers.mjs';
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
      for (const h of [ARCHIVED, OLDEST]) {
        test(h.name, { skip }, async (t) => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-handover-'));
          const desktop = await desktopLibrary(path.join(dir, 'desktop'));
          const website = await webLibrary();
          t.after(async () => { await desktop.close(); fs.rmSync(dir, { recursive: true, force: true }); });
          await h.run({ dir, desktop, website });
        });
      }
    }
  });
}

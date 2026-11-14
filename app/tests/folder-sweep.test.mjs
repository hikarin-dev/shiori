// folder-sweep.test.mjs — the fault sweeps of review 4 (plans/library-storage-refactor-review-4.md, "How
// it was tested"), kept as a test (plan §7, S11). A scenario's setup is committed and published; then
// one fault is placed at the k-th file call of its step, for every k. Afterwards the library is
// flushed, checked, restarted, and its folder removed and added again; at each of those stages every
// gallery, title, page and translation must be as it was before the operation in flight or after it
// (every operation that resolved before the fault stays done), nothing deleted comes back, nothing joins
// that nobody put there, and the person's own files are unchanged (§6.3's invariants 1 and 2).
//
// The faults, one per run:
// - desktop: a kill (the step runs in a child process that exits inside the k-th file call; the
//   library is then opened again over the same folders), and EIO, EPERM, ENOENT, EXDEV (the move only);
// - website: the page dying (that call and every later one of the page never return; the page is
//   loaded again: library-drivers.mjs restart), and NoModificationAllowedError, NotFoundError,
//   NotAllowedError;
// - both: the drive away (folder A renamed away inside the k-th file call, so that call and every later
//   one in it answer "not found" as they do while a drive is away, and put back once the step has ended:
//   review 5), and the drive blip (away from the k-th call, back at the m-th call after it, inside the
//   step: m = 1, 2, 3 or 5; review 6).
// "Not found" (ENOENT, NotFoundError) is among them: a drive away answers so for what is there, for a
// moment (S11) or for as long as it is away (S18).
//
// A step may be a check (review 6: "a check as the step", "a folder's first check as the step"): the
// galleries a folder holds read back with one fault in the check, everything then reading as it does with
// no fault. A first check may leave a gallery it couldn't read whole to a later check (`joinsLater`): until
// the next check either state may show, from it on only the gallery joined whole.
//
// npm test runs a sample: a few fault points of each scenario, for every kind (of the blips, m = 2) — the
// desktop's in this file, the website's in folder-sweep-website.test.mjs. The whole sweep runs by hand, a
// process per app, kind and shard (folder-sweep-long.mjs); one process alone:
//   SHIORI_SWEEP_EVERY=1 SHIORI_SWEEP_APP=<desktop|website> SHIORI_SWEEP_KIND=<kind> node --test app/tests/folder-sweep.test.mjs
// (SHIORI_SWEEP_SCENARIO=<name>: one scenario; SHIORI_SWEEP_SHARD=<i>/<n>: every n-th point from the i-th;
// SHIORI_SWEEP_POINTS=<k>,…: those points alone, to replay a finding).
// A scenario a later step's finding fails on is marked todo with that step (TODO).
import test, { describe } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { desktopLibrary, webLibrary, pageNow, pageCalling } from './library-drivers.mjs';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { zipCreate } from '../js/zip.js';
import { v1Gallery, legacyGallery } from './fixtures/storage-fixtures.mjs';

/** @typedef {import('./library-drivers.mjs').Driver} Driver */
/** A gallery as a stage must show it: where it is (folder A or B), its title, its pages ([original,
 * translation or the original], each as hex), and the library's folders: whether A is one of them.
 * @typedef {{ place: 'A' | 'B', title: string, pages: [string, string][] }} G
 * @typedef {{ aIn: boolean, galleries: Record<string, G> }} State */
/** A run's library and what its scenario made: folder ids and paths, gallery ids (`g`), every gallery
 * id it made (`known`), those whose deletion resolved (`deleted`), the person's files (`plants`),
 * whether folder A's removal may need the person's Discard (`discard`: a limit of §8, set by a scenario),
 * whether folder A is to be shown again before the stages (`showFirst`: a kill may leave it hidden), and
 * the galleries a first check is to join (`want`, by `g`'s key, as a stage shows them).
 * @typedef {{ lib: Driver, base: string, A: string, B: string, ids: Record<string, string>, g: Record<string, string>,
 *   titles: Record<string, string>, known: Set<string>, deleted: Set<string>, plants: Map<string, string>, discard?: boolean,
 *   showFirst?: boolean, want?: Record<string, G> }} Ctx */

const THIS_FILE = fileURLToPath(import.meta.url);
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255, 1, 2, 3]);
const webp = (n) => new Uint8Array([0x52, 0x49, 0x46, 0x46, n >> 8, n & 255, 9, 8, 7]);
const hex = (b) => (b ? Buffer.from(b).toString('hex') : null);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MAX_PAGES = 4;
// A file call's path, from its run's folder (the website's are so already).
const short = (/** @type {string} */ p) => p.replace(/^.*?\/shiori-sweep-[^/]+\//, '');
const STEP_MS = 15_000;

// ── Expected states ──
const clone = (/** @type {State} */ s) => /** @type {State} */ (structuredClone(s));
/** @param {State} s @param {string} gid @param {number} n @param {Uint8Array} bytes */
const withPage = (s, gid, n, bytes) => { const t = clone(s); t.galleries[gid].pages[n - 1] = [hex(bytes), hex(bytes)]; return t; };
/** @param {State} s @param {string} gid @param {number} n @param {Uint8Array} bytes */
const withTranslation = (s, gid, n, bytes) => { const t = clone(s); t.galleries[gid].pages[n - 1][1] = hex(bytes); return t; };
/** @param {State} s @param {string} gid */
const without = (s, gid) => { const t = clone(s); delete t.galleries[gid]; return t; };
/** A gallery `title` in `place` with pages `pages` (their pictures, untranslated). @returns {G} */
const G = (place, title, pages) => ({ place, title, pages: pages.map(b => [hex(b), hex(b)]) });

/** An operation of a scenario's step: done to the library by `run`, to the expected state by `apply`.
 * `deletes`: the gallery its success deletes; `joinsLater`: a check that may leave what it couldn't read
 * whole to the next one (the step's only operation). */
const op = (name, run, apply = (/** @type {State} */ s) => s, deletes = null, joinsLater = false) => ({ name, run, apply, deletes, joinsLater });
const FLUSH = op('flush', (c) => c.lib.flush());
const SETTLE = op('settle', () => sleep(150));   // what a write leaves to do once it commits (a deletion)
const CHECK = op('check', (c) => c.lib.scan(c.ids.A));   // a check of what the library has: nothing changes
// A folder's first check of what it holds: gallery `key` of `want` joins.
const FIRST_CHECK = (/** @type {string} */ key) => op('first check', (c) => c.lib.scan(c.ids.A),
  (s, c) => ({ ...clone(s), galleries: { ...s.galleries, [c.g[key]]: /** @type {Record<string, G>} */ (c.want)[key] } }), null, true);
// The person's file at `at` (a source of theirs), to stay as it is now (wrongAt reads it back so).
const theirs = (/** @type {Ctx} */ c, /** @type {string} */ at) => c.plants.set(at, fs.readFileSync(at, at.endsWith('.zip') ? 'latin1' : 'utf8'));
// A gallery `title` of folder A as a stage shows it, from its files in `dir` as they are now (`pages`:
// each page's [original, translation or null], paths in `dir`).
const shownAs = (/** @type {string} */ dir, /** @type {string} */ title, /** @type {[string, string | null][]} */ pages) => /** @type {G} */ ({ place: 'A', title,
  pages: pages.map(([o, t]) => { const b = (/** @type {string} */ rel) => hex(fs.readFileSync(path.join(dir, ...rel.split('/')))); return [b(o), b(t ?? o)]; }) });
// Shiori's own galleries' deletes refused while `work` runs (a picture replaced leaves the old one beside
// the new: what a refused delete leaves).
async function deletesRefused(/** @type {Ctx} */ c, /** @type {() => Promise<void>} */ work) {
  const undo = c.lib.app === 'website' ? fsa.failNext((call) => call.op === 'removeEntry', 'NoModificationAllowedError', { times: Infinity })
    : faults.failNext((call) => ['rm', 'unlink', 'rmdir'].includes(call.op), 'EBUSY', { times: Infinity });
  try { await work(); } finally { undo(); }
}
// Folder A removed from the library and added again (its galleries forgotten, to be read back), the default.
async function addedAgain(/** @type {Ctx} */ c) {
  await c.lib.setDefault(c.lib.home);
  await c.lib.remove(c.ids.A);
  c.ids.A = await c.lib.add(c.A);
  await c.lib.setDefault(c.ids.A);
}

/** A gallery `title` with pages `pages`, in the default folder. @param {Ctx} c */
async function made(c, title, pages) {
  const gid = await c.lib.newGallery(title);
  for (const [i, b] of pages.entries()) await c.lib.putPage(gid, i + 1, b);
  c.known.add(gid);
  return gid;
}
/** A file of the person's at `rel` (in the run's folder). @param {Ctx} c */
function plant(c, rel, text) {
  const at = path.join(c.base, rel);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, text);
  c.plants.set(at, text);
}
const dirOf = async (/** @type {Ctx} */ c, gid) => /** @type {string} */ (await c.lib.dirOf(gid));

/** The scenarios: `setup` (then flushed: committed and published), the expected state after it
 * (`state`), and the step's operations. `apps`: where it runs (both by default); `kinds`: the fault
 * kinds it is swept with, where not all; `sample`: 1 for one fault point in npm test's sample, not three.
 * @type {{ name: string, apps?: string[], kinds?: string[], sample?: number,
 *   setup(c: Ctx): Promise<void>, state(c: Ctx): State, ops: ReturnType<typeof op>[] }[]} */
const SCENARIOS = [
  {
    name: 'a gallery\'s first writes',
    async setup(c) {
      c.g.beta = await made(c, 'Beta', [png(1)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      c.g.alpha = await c.lib.newGallery('Alpha'); c.known.add(c.g.alpha);
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.beta]: G('A', 'Beta', [png(1)]), [c.g.alpha]: G('A', 'Alpha', []) } }),
    ops: [
      op('page 1', (c) => c.lib.putPage(c.g.alpha, 1, png(2)), (s, c) => withPage(s, c.g.alpha, 1, png(2))),
      op('page 2', (c) => c.lib.putPage(c.g.alpha, 2, png(3)), (s, c) => withPage(s, c.g.alpha, 2, png(3))),
      FLUSH,
    ],
  },
  {
    name: 'a page replaced and translations written',
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2), png(3)]);
      await c.lib.flush();
      plant(c, path.relative(c.base, path.join(await dirOf(c, c.g.alpha), 'mine.txt')), 'the person\'s own file');
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2), png(3)]) } }),
    ops: [
      op('page 1 again, as WebP', (c) => c.lib.putPage(c.g.alpha, 1, webp(4), 'image/webp'), (s, c) => withPage(s, c.g.alpha, 1, webp(4))),
      op('translation 2', (c) => c.lib.putTranslation(c.g.alpha, 2, png(5)), (s, c) => withTranslation(s, c.g.alpha, 2, png(5))),
      op('translation 3, as WebP', (c) => c.lib.putTranslation(c.g.alpha, 3, webp(6), 'image/webp'), (s, c) => withTranslation(s, c.g.alpha, 3, webp(6))),
      FLUSH,
    ],
  },
  {
    name: 'a deletion',
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2), png(3)]);
      c.g.beta = await made(c, 'Beta', [png(4)]);
      await c.lib.putTranslation(c.g.alpha, 2, png(5));
      await c.lib.flush();
      plant(c, path.relative(c.base, path.join(await dirOf(c, c.g.alpha), 'mine.txt')), 'the person\'s own file');
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2), png(3)]), [c.g.beta]: G('A', 'Beta', [png(4)]) } },
      c.g.alpha, 2, png(5)),
    ops: [
      op('delete', (c) => c.lib.deleteGallery(c.g.alpha), (s, c) => without(s, c.g.alpha), 'alpha'),
      FLUSH, SETTLE,
    ],
  },
  {
    name: 'a move to another folder and back',
    async setup(c) {
      c.ids.B = await c.lib.add(c.B);
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      await c.lib.putTranslation(c.g.alpha, 1, png(3));
      plant(c, 'A/mine.txt', 'the person\'s own file');
      plant(c, 'B/mine.txt', 'another of the person\'s files');
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]) } }, c.g.alpha, 1, png(3)),
    ops: [
      op('to B', (c) => c.lib.move(c.g.alpha, c.ids.B), (s, c) => { const t = clone(s); t.galleries[c.g.alpha].place = 'B'; return t; }),
      op('back to A', (c) => c.lib.move(c.g.alpha, c.ids.A), (s, c) => { const t = clone(s); t.galleries[c.g.alpha].place = 'A'; return t; }),
      FLUSH, SETTLE,
    ],
  },
  {
    name: 'a folder\'s removal with changes not published',
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      await c.lib.putPage(c.g.alpha, 3, png(3));    // committed, not yet published
      await c.lib.setTitle(c.g.alpha, 'Alpha 2');
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha 2', [png(1), png(2), png(3)]) } }),
    ops: [
      op('remove A', async (c) => { await c.lib.setDefault(c.lib.home); await c.lib.remove(c.ids.A); }, (s) => ({ ...clone(s), aIn: false })),
    ],
    noSetupFlush: true,
  },
  {
    name: 'a linked ZIP translated, then deleted',
    kinds: ['kill', 'EIO', 'ENOENT', 'drive away', 'page death', 'NoModificationAllowedError', 'NotFoundError'],
    async setup(c) {
      const zip = zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }]);
      fs.writeFileSync(path.join(c.A, 'Pack.zip'), zip);
      c.plants.set(path.join(c.A, 'Pack.zip'), Buffer.from(zip).toString('latin1'));
      await c.lib.scan(c.ids.A);
      c.g.pack = (await c.lib.galleries()).map(String)[0];
      c.known.add(c.g.pack);
      c.titles.pack = /** @type {string} */ (await c.lib.titleOf(c.g.pack));
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.pack]: G('A', c.titles.pack, [png(1), png(2)]) } }),
    ops: [
      op('translation 1', (c) => c.lib.putTranslation(c.g.pack, 1, png(3)), (s, c) => withTranslation(s, c.g.pack, 1, png(3))),
      FLUSH,
      op('delete', (c) => c.lib.deleteGallery(c.g.pack), (s, c) => without(s, c.g.pack), 'pack'),
      FLUSH, SETTLE,
    ],
  },
  {
    name: 'archiving',
    apps: ['desktop'],
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2), png(3)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      // One in the gallery's .shiori/, which archiving lets through, and once retired with the folder (S14,
      // review 4 F4).
      plant(c, path.relative(c.base, path.join(await dirOf(c, c.g.alpha), '.shiori', 'mine.txt')), 'another of the person\'s files');
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2), png(3)]) } }),
    ops: [op('archive', (c) => c.lib.raw.archiveGallery(c.g.alpha)), SETTLE],
  },
  {
    name: 'an addition to an archive',
    apps: ['desktop'],
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2), png(3)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      await c.lib.raw.archiveGallery(c.g.alpha);
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2), png(3)]) } }),
    ops: [
      op('retitle', (c) => c.lib.setTitle(c.g.alpha, 'Alpha 2'), (s, c) => { const t = clone(s); t.galleries[c.g.alpha].title = 'Alpha 2'; return t; }),
      FLUSH, SETTLE,
    ],
  },
  {
    name: 'an unpack',
    apps: ['desktop'],
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2), png(3)]);
      await c.lib.putTranslation(c.g.alpha, 1, png(5));   // archived with it: a picture of its own the unpack copies out (S21)
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      await c.lib.raw.archiveGallery(c.g.alpha);
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2), png(3)]) } }, c.g.alpha, 1, png(5)),
    ops: [
      op('translation 2', (c) => c.lib.putTranslation(c.g.alpha, 2, png(4)), (s, c) => withTranslation(s, c.g.alpha, 2, png(4))),
      FLUSH, SETTLE,
    ],
  },
  {
    // An earlier version's archive (its shiori.json, as v1.0.x archived a gallery), adopted, then unpacked by
    // its first change: what the unpack took is recorded, and the archive deleted only while it holds nothing
    // else (S19, review 5 F1).
    name: 'an earlier version\'s archive unpacked',
    apps: ['desktop'],
    async setup(c) {
      const gid = '1790000000077', file = (/** @type {number} */ n) => `000${n}.png`;
      fs.writeFileSync(path.join(c.A, 'Old.cbz'), zipCreate([...[1, 2, 3].map(n => ({ name: file(n), data: png(n) })),
        { name: 'shiori.json', data: new TextEncoder().encode(JSON.stringify({ format: 'shiori-gallery', version: 1, id: gid,
          meta: { galleryId: gid, title: { english: 'Old', japanese: '', pretty: '' }, tags: [], numPages: 3 },
          pages: [1, 2, 3].map(n => ({ n, file: file(n), key: `local://${gid}/${n}.png` })) })) },
        { name: 'ComicInfo.xml', data: new TextEncoder().encode('<?xml version="1.0"?><ComicInfo></ComicInfo>') }]));
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.scan(c.ids.A);
      c.g.old = gid;
      c.known.add(gid);
      // Until its first change unpacks it, nothing can be published in such an archive (§8, S21): the cover
      // its adoption chose stays unsaved there, and the folder's removal asks for Discard.
      c.discard = true;
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.old]: G('A', 'Old', [png(1), png(2), png(3)]) } }),
    ops: [
      op('translation 2', (c) => c.lib.putTranslation(c.g.old, 2, png(4)), (s, c) => withTranslation(s, c.g.old, 2, png(4))),
      FLUSH, SETTLE,
    ],
  },
  // Review 6's three, swept under every kind.
  {
    name: 'an archived gallery deleted',
    apps: ['desktop'],
    sample: 1,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      c.g.beta = await made(c, 'Beta', [png(4)]);
      await c.lib.putTranslation(c.g.alpha, 1, png(5));
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      await c.lib.raw.archiveGallery(c.g.alpha);
      await sleep(300);
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]), [c.g.beta]: G('A', 'Beta', [png(4)]) } }, c.g.alpha, 1, png(5)),
    ops: [op('delete', (c) => c.lib.deleteGallery(c.g.alpha), (s, c) => without(s, c.g.alpha), 'alpha'), FLUSH, SETTLE],
  },
  {
    name: 'a folder hidden and shown with changes not published',
    sample: 1,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      await c.lib.putTranslation(c.g.alpha, 1, png(7));   // committed, not yet published
      await c.lib.setTitle(c.g.alpha, 'Alpha 2');
      c.showFirst = true;
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha 2', [png(1), png(2)]) } }, c.g.alpha, 1, png(7)),
    ops: [
      op('hide A', async (c) => { await c.lib.setDefault(c.lib.home); await c.lib.hide(c.ids.A); }),
      SETTLE,
      op('show A', (c) => c.lib.show(c.ids.A)),
      FLUSH, SETTLE,
    ],
    noSetupFlush: true,
  },
  {
    name: 'a translation replaced, then the gallery deleted',
    sample: 1,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2), png(3)]);
      await c.lib.putTranslation(c.g.alpha, 2, png(5));
      await c.lib.flush();
      await c.lib.putTranslation(c.g.alpha, 2, png(6));   // the first translation retires
      await c.lib.flush();
      plant(c, path.relative(c.base, path.join(await dirOf(c, c.g.alpha), 'translated', 'mine.txt')), 'the person\'s own file');
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2), png(3)]) } }, c.g.alpha, 2, png(6)),
    ops: [
      op('translation 2 again', (c) => c.lib.putTranslation(c.g.alpha, 2, png(8)), (s, c) => withTranslation(s, c.g.alpha, 2, png(8))),
      op('delete', (c) => c.lib.deleteGallery(c.g.alpha), (s, c) => without(s, c.g.alpha), 'alpha'),
      FLUSH, SETTLE,
    ],
  },
  // ── A check as the step (review 6): galleries the library has, read back ──
  {
    name: 'a check of Shiori\'s own galleries',
    sample: 1,
    async setup(c) {
      c.g.own = await made(c, 'Own', [png(21), png(22)]);
      await c.lib.putTranslation(c.g.own, 1, png(29));
      plant(c, 'A/mine.txt', 'the person\'s own file');
      if (c.lib.app !== 'desktop') return;
      c.g.arch = await made(c, 'Arch', [png(31), png(32)]);   // and an archived one, where the desktop keeps them
      await c.lib.putTranslation(c.g.arch, 2, png(39));
      await c.lib.flush();
      await c.lib.raw.archiveGallery(c.g.arch);
      await sleep(250);
    },
    state(c) {
      const s = withTranslation({ aIn: true, galleries: { [c.g.own]: G('A', 'Own', [png(21), png(22)]) } }, c.g.own, 1, png(29));
      return c.g.arch ? withTranslation({ ...s, galleries: { ...s.galleries, [c.g.arch]: G('A', 'Arch', [png(31), png(32)]) } }, c.g.arch, 2, png(39)) : s;
    },
    ops: [CHECK],
  },
  {
    name: 'a check of linked titles',
    sample: 1,
    async setup(c) {
      fs.writeFileSync(path.join(c.A, 'Pack.zip'), zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }]));
      fs.mkdirSync(path.join(c.A, 'Pics'));
      for (const n of [1, 2]) fs.writeFileSync(path.join(c.A, 'Pics', `00${n}.png`), png(10 + n));
      fs.writeFileSync(path.join(c.A, 'Doc.pdf'), '%PDF-1.4 a document');
      for (const at of ['Pack.zip', 'Pics/001.png', 'Pics/002.png', 'Doc.pdf']) theirs(c, path.join(c.A, at));
      await c.lib.scan(c.ids.A);
      for (const w of await c.lib.pdfsWaiting()) await c.lib.addRendered(w.folder, w.gid, [png(61), png(62)], (await c.lib.pdfSource(w.folder, w.gid)).token);
      for (const gid of (await c.lib.galleries()).map(String)) {
        const title = /** @type {string} */ (await c.lib.titleOf(gid));
        c.g[title] = gid;
        c.known.add(gid);
        await c.lib.putTranslation(gid, 1, png(49));
      }
    },
    state: (c) => [['Pack', [png(1), png(2)]], ['Pics', [png(11), png(12)]], ['Doc', [png(61), png(62)]]]
      .reduce((s, [title, pages]) => withTranslation({ ...s, galleries: { ...s.galleries, [c.g[title]]: G('A', title, pages) } }, c.g[title], 1, png(49)),
        /** @type {State} */ ({ aIn: true, galleries: {} })),
    ops: [CHECK],
  },
  // ── A folder's first check as the step (review 6): galleries it holds, read back ──
  {
    name: 'a first check of an earlier version\'s gallery, with its files list',
    sample: 1,
    async setup(c) {
      const at = path.join(c.A, 'Old one'), old = await v1Gallery(at, { files: true });
      c.g.old = old.gid;
      c.known.add(old.gid);
      c.want = { old: shownAs(at, 'Version one', [[old.current[1], 'translated/0001.png'], ['images/0002.webp', null]]) };
      plant(c, 'A/mine.txt', 'the person\'s own file');
    },
    state: () => ({ aIn: true, galleries: {} }),
    ops: [FIRST_CHECK('old')],
  },
  {
    name: 'a first check of an earlier version\'s gallery, without its files list',
    sample: 1,
    async setup(c) {
      const at = path.join(c.A, 'Old one'), old = await v1Gallery(at, { files: false });
      c.g.old = old.gid;
      c.known.add(old.gid);
      c.want = { old: shownAs(at, 'Version one', [['images/0001.webp', 'translated/0001.png'], ['images/0002.webp', null]]) };
    },
    state: () => ({ aIn: true, galleries: {} }),
    ops: [FIRST_CHECK('old')],
  },
  {
    name: 'a first check of a gallery in the oldest format',
    apps: ['desktop'],
    sample: 1,
    async setup(c) {
      const at = path.join(c.A, 'Old one'), old = legacyGallery(at);
      c.g.old = old.gid;
      c.known.add(old.gid);
      c.want = { old: shownAs(at, 'The oldest format', [['0001.webp', null], ['0002.webp', null]]) };
    },
    state: () => ({ aIn: true, galleries: {} }),
    ops: [FIRST_CHECK('old')],
  },
  {
    name: 'a first check of a gallery with a page replaced, its folder added again',
    sample: 1,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      await c.lib.putTranslation(c.g.alpha, 1, png(31));
      await c.lib.putTranslation(c.g.alpha, 2, png(32));
      await c.lib.flush();
      await deletesRefused(c, async () => {
        await c.lib.putPage(c.g.alpha, 1, webp(9), 'image/webp');   // the picture it replaces stays beside it
        await c.lib.putTranslation(c.g.alpha, 1, png(33));
        await c.lib.flush();
      });
      await addedAgain(c);
      c.want = { alpha: { place: 'A', title: 'Alpha', pages: [[hex(webp(9)), hex(png(33))], [hex(png(2)), hex(png(32))]] } };
    },
    state: () => ({ aIn: true, galleries: {} }),
    ops: [FIRST_CHECK('alpha')],
  },
  {
    name: 'a first check of a linked ZIP translated, its folder added again',
    sample: 1,
    async setup(c) {
      fs.writeFileSync(path.join(c.A, 'Pack.zip'), zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }]));
      theirs(c, path.join(c.A, 'Pack.zip'));
      await c.lib.scan(c.ids.A);
      c.g.pack = (await c.lib.galleries()).map(String)[0];
      c.known.add(c.g.pack);
      await c.lib.putTranslation(c.g.pack, 1, png(7));
      await c.lib.flush();
      await sleep(150);
      await addedAgain(c);
      c.want = { pack: { place: 'A', title: 'Pack', pages: [[hex(png(1)), hex(png(7))], [hex(png(2)), hex(png(2))]] } };
    },
    state: () => ({ aIn: true, galleries: {} }),
    ops: [FIRST_CHECK('pack')],
  },
];

const BLIPS = ['drive blip 1', 'drive blip 2', 'drive blip 3', 'drive blip 5'];
const KINDS = {
  desktop: ['kill', 'EIO', 'EPERM', 'ENOENT', 'EXDEV', 'drive away', ...BLIPS],
  website: ['page death', 'NoModificationAllowedError', 'NotFoundError', 'NotAllowedError', 'drive away', ...BLIPS],
};
// Where each kind runs: EXDEV on the move alone; EPERM and NotAllowedError without the linked ZIP (as
// the review swept them); a blip wherever the drive away does.
const sweeps = (/** @type {string} */ app, /** @type {string} */ kind) => SCENARIOS.filter(s => (!s.apps || s.apps.includes(app))
  && (kind === 'EXDEV' ? s.name.startsWith('a move') : !s.kinds || s.kinds.includes(BLIPS.includes(kind) ? 'drive away' : kind)));

// Scenarios a later step's finding fails on (plan §7), by app, kind and scenario.
/** @type {Record<string, string>} */
const TODO = {};
const later = (/** @type {string} */ step, /** @type {'desktop' | 'website'} */ app, /** @type {string[]} */ kinds, /** @type {string} */ scenario) => {
  for (const kind of kinds) TODO[`${app} ${kind}: ${scenario}`] = step;
};
// Review 6 F2: a linked gallery joins again without its overlay's work (the overlays read with every
// failure taken for none).
for (const app of /** @type {const} */ (['desktop', 'website'])) later('S23 (review 6 F2)', app, KINDS[app], 'a first check of a linked ZIP translated, its folder added again');
// Review 6 F1: a check drops a linked folder's page whose look answers "not found".
later('S23 (review 6 F1)', 'desktop', ['ENOENT', ...BLIPS], 'a check of linked titles');
// Review 6 F12: a conversion from the oldest format cut short (a failed look just after a picture's rename,
// or a kill) leaves a page unreadable.
later('S25 (review 6 F12)', 'desktop', KINDS.desktop, 'a first check of a gallery in the oldest format');
// Review 6 F9 (b): a write cut by a blip leaves its empty picture, which joins as a gallery "images".
later('S25 (review 6 F9 b)', 'website', ['drive blip 2', 'drive blip 3'], 'a move to another folder and back');

// ── A run ──
/** A fresh library over a new folder, with folder A added and the default, `sc` set up and published.
 * @returns {Promise<Ctx>} */
async function setUp(/** @type {string} */ app, sc, base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-sweep-'))) {
  const lib = app === 'desktop' ? await desktopLibrary(base) : await webLibrary();
  if (app === 'website') stillDead();
  /** @type {Ctx} */
  const c = { lib, base, A: path.join(base, 'A'), B: path.join(base, 'B'), ids: {}, g: {}, titles: {}, known: new Set(), deleted: new Set(), plants: new Map() };
  c.ids.A = await lib.add(c.A);
  await lib.setDefault(c.ids.A);
  await sc.setup(c);
  if (!sc.noSetupFlush) await lib.flush();
  return c;
}
// The states a stage may show: each operation's, in order (states[0]: after the setup).
const statesOf = (sc, /** @type {Ctx} */ c) => sc.ops.reduce((all, o) => [...all, o.apply(all.at(-1), c)], [sc.state(c)]);

/** `work`, failed when it hasn't ended after `ms`. */
async function within(/** @type {string} */ what, /** @type {Promise<unknown>} */ work, ms = STEP_MS) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} never ended`)), ms); timer.unref?.(); })]); } finally { clearTimeout(timer); }
}

/** The step's operations run, stopping at the first that rejects (or never ends: `stop`, a page that
 * died). Resolves how many resolved. @param {Ctx} c */
async function runOps(sc, c, stop = new Promise(() => {}), done = (/** @type {number} */ n) => {}) {
  let n = 0;
  for (const o of sc.ops) {
    const ended = await Promise.race([within(o.name, o.run(c)).then(() => true, () => false), stop.then(() => null)]);
    if (!ended) break;
    if (o.deletes) c.deleted.add(c.g[o.deletes]);
    done(++n);
  }
  return n;
}

/** What the library shows now. @param {Ctx} c */
async function shown(c) {
  const listed = (await c.lib.galleries()).map(String);
  /** @type {Record<string, { title: string | null, pages: ([string | null, string | null] | null)[] }>} */
  const galleries = {};
  for (const gid of listed) {
    const pages = [];
    for (let n = 1; n <= MAX_PAGES; n++) {
      const original = await c.lib.read(gid, n);
      pages.push(original ? /** @type {[string | null, string | null]} */ ([hex(original), hex(await c.lib.read(gid, n, 'translated'))]) : null);
    }
    while (pages.length && pages.at(-1) == null) pages.pop();
    galleries[gid] = { title: await c.lib.titleOf(gid), pages };
  }
  const aIn = (await c.lib.list()).some(f => f.id === c.ids.A);
  return { listed, galleries, aIn };
}
// A state as the library shows it: the galleries in folders it has (a gallery with no pages counts
// as none: one never written to its folder doesn't outlive the folder's removal; one that comes back
// after its deletion is caught by `deleted`).
const visible = (/** @type {State} */ s, aIn = s.aIn) => ({ aIn, galleries: Object.fromEntries(Object.entries(s.galleries)
  .filter(([, g]) => g.pages.length && (g.place === 'B' || aIn)).map(([gid, g]) => [gid, { title: g.title, pages: g.pages }])) });

/** What is wrong at `stage`, given the states it may show (`valid`). @param {Ctx} c */
async function wrongAt(stage, c, valid, { aInAlways = false } = {}) {
  const problems = [];
  for (const [at, text] of c.plants) {
    const now = fs.existsSync(at) ? fs.readFileSync(at, at.endsWith('.zip') ? 'latin1' : 'utf8') : null;
    if (now !== text) problems.push(`${path.relative(c.base, at)}, the person's, is ${now == null ? 'gone' : 'changed'}`);
  }
  const now = await shown(c);
  for (const gid of now.listed) {
    if (c.deleted.has(gid)) problems.push(`gallery ${gid} came back after its deletion`);
    else if (!c.known.has(gid)) problems.push(`gallery ${gid} ("${now.galleries[gid].title}") joined, put there by nobody`);
  }
  const seen = visible({ aIn: now.aIn, galleries: Object.fromEntries(Object.entries(now.galleries).filter(([gid]) => c.known.has(gid) && !c.deleted.has(gid))
    .map(([gid, g]) => [gid, /** @type {G} */ ({ place: 'B', title: /** @type {string} */ (g.title), pages: /** @type {any} */ (g.pages) })])) });
  const wanted = valid.map(s => visible(s, aInAlways ? true : s.aIn));
  if (!wanted.some(w => isDeepStrictEqual(w, seen))) problems.push(`it shows ${JSON.stringify(seen)}, neither ${wanted.map(w => JSON.stringify(w)).join(' nor ')}`);
  // SHIORI_SWEEP_TREE=1: what the folders hold then, with each finding.
  if (problems.length && process.env.SHIORI_SWEEP_TREE) problems.push(`the folders hold: ${fs.readdirSync(c.base, { recursive: true }).filter(f => /^[AB][\\/]/.test(String(f))).join(', ')}`);
  return problems.map(p => `${stage}: ${p}`);
}

/** The stages after a step (`valid`: the states they may show), each checked; the first that finds
 * something ends it — as does a check that reports a copy of a gallery ('duplicate': one the step left
 * behind for good, as review 5's F3 left a retired folder). `joinsLater`: the step is a first check, and
 * from the stages' own check on only its last state may show. Resolves what was wrong. @param {Ctx} c */
async function stages(c, valid, joinsLater = false) {
  /** @type {{ path: string, reason: string }[]} */
  const reported = [];
  const scanAll = async () => {
    if ((await c.lib.list()).some(f => f.id === c.ids.A)) reported.push(...(await c.lib.scan(c.ids.A)).problems);
    if (c.ids.B) reported.push(...(await c.lib.scan(c.ids.B)).problems);
  };
  /** @type {[string, () => Promise<unknown>][]} */
  const steps = [
    ['flush', () => c.lib.flush()],
    ['check', scanAll],
    ['restart', async () => { if (!c.lib.restart) throw new Error('no restart left in this process: run fewer points per process (SHIORI_SWEEP_SHARD)'); await c.lib.restart(); }],
    ['re-add', async () => {
      await c.lib.setDefault(c.lib.home);
      if ((await c.lib.list()).some(f => f.id === c.ids.A)) {
        await c.lib.remove(c.ids.A).catch((e) => { if (!c.discard) throw e; return c.lib.remove(c.ids.A, { discard: true }); });
      }
      c.ids.A = await c.lib.add(c.A);
      await c.lib.setDefault(c.ids.A);
      await scanAll();
    }],
  ];
  if (c.showFirst) await c.lib.show(c.ids.A).catch(() => {});
  for (const [stage, work] of steps) {
    try { await within(stage, work()); } catch (e) { return [`${stage}: ${/** @type {Error} */ (e).message}`]; }
    const wrong = [...await wrongAt(stage, c, joinsLater && stage !== 'flush' ? valid.slice(-1) : valid, { aInAlways: stage === 're-add' }),
      ...reported.splice(0).filter(p => p.reason === 'duplicate').map(p => `${stage}: a copy of a gallery stays at ${p.path}`)];
    if (wrong.length) return wrong;
  }
  return [];
}

// ── Each kind of fault ──
const DESKTOP_CODE = { EIO: 'EIO', EPERM: 'EPERM', ENOENT: 'ENOENT', EXDEV: 'EXDEV' };
// The drive folder A is on leaving: A renamed away beside itself, so every call in it answers "not
// found" as while a drive is away. Windows refuses to rename a folder while a file in it is open: such
// a point can't be made, and is passed over (counted: `stuck`). Resolves whether it left.
let stuck = 0;
function leave(/** @type {Ctx} */ c) {
  try { fs.renameSync(c.A, `${c.A}.away`); return true; } catch { stuck++; return false; }
}
// The drive back; a finding when it can't be (something made folder A again while it was away).
function comeBack(/** @type {Ctx} */ c) {
  if (!fs.existsSync(`${c.A}.away`)) return [];
  try { fs.renameSync(`${c.A}.away`, c.A); return []; } catch (e) { return [`step: the drive can't come back (${/** @type {Error} */ (e).code}): folder A was made again while it was away`]; }
}
// A website page that died: its calls, from the one the fault met on, never return (fsa hang), and the
// page is loaded again. Its Web Locks go with it: this process takes the in-context locks
// (folder-store-web.js withLock without navigator.locks), each page's its own.
const deadPages = new Set();
// Every call of a page that died never returns, from now on (fsa.reset, as a library is made, forgets it).
const stillDead = () => fsa.hang(() => deadPages.has(pageCalling()));
let locksShadowed = false;
function shadowLocks() {
  if (locksShadowed) return;
  locksShadowed = true;
  Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
}

/** How many file calls the step makes, with no fault. */
async function callsOf(app, sc) {
  const c = await setUp(app, sc);
  let n = 0;
  const undo = app === 'desktop' ? faults.failNext(() => { n++; return false; }, 'EIO', { times: Infinity }) : fsa.failNext(() => { n++; return false; }, 'EIO', { times: Infinity });
  try { await runOps(sc, c); } finally { undo(); await finish(c); }
  return n;
}
async function finish(/** @type {Ctx} */ c) {
  await within('the last flush', c.lib.flush()).catch(() => {});
  faults.reset(); fsa.reset();
  if (c.lib.app === 'website') stillDead();
  await c.lib.close();
  fs.rmSync(c.base, { recursive: true, force: true });
}

/** One run: scenario `sc` with fault `kind` at the k-th file call of its step. Resolves what was wrong. */
async function once(app, kind, sc, k) {
  if (kind === 'kill') return killed(sc, k);
  const c = await setUp(app, sc);
  const states = statesOf(sc, c);
  try {
    let n = 0, done = 0, met = '';
    const at = (/** @type {{ op: string, path: string }} */ call) => { if (++n !== k) return false; met = `${call.op} ${short(call.path)}`; return true; };
    if (kind === 'page death') {
      const page = pageNow();
      let died = () => {};
      const death = new Promise((resolve) => { died = resolve; });
      fsa.hang((call) => {
        if (pageCalling() !== page) return false;
        if (deadPages.has(page)) return true;
        if (!at(call)) return false;
        deadPages.add(page);
        died();
        return true;
      });
      done = await runOps(sc, c, /** @type {Promise<void>} */ (death));
      if (deadPages.has(page)) await within('the page loaded again', /** @type {any} */ (c.lib.restart)());
    } else if (BLIPS.includes(kind)) {
      // Away from the k-th call (that call answers "not found" too), back at the m-th call after it.
      const m = Number(kind.split(' ').pop());
      const back = [];
      const watch = (/** @type {{ op: string, path: string }} */ call) => {
        if (at(call)) { if (!leave(c)) met = ''; } else if (n === k + m) back.push(...comeBack(c));
        return false;
      };
      if (app === 'desktop') faults.failNext(watch, 'EIO', { times: Infinity }); else fsa.failNext(watch, 'EIO', { times: Infinity });
      done = await runOps(sc, c);
      faults.reset(); fsa.reset();
      back.push(...comeBack(c));
      if (back.length) return back.map(p => `(${met}) ${p}`);
    } else if (kind === 'drive away') {
      // Away from the k-th call on (that call answers "not found" too), back once the step has ended.
      const watch = (/** @type {{ op: string, path: string }} */ call) => { if (at(call) && !leave(c)) met = ''; return false; };
      if (app === 'desktop') faults.failNext(watch, 'EIO', { times: Infinity }); else fsa.failNext(watch, 'EIO', { times: Infinity });
      done = await runOps(sc, c);
      faults.reset(); fsa.reset();
      const back = comeBack(c);
      if (back.length) return back.map(p => `(${met}) ${p}`);
    } else if (app === 'desktop') {
      faults.failNext(at, /** @type {any} */ (DESKTOP_CODE)[kind]);
      done = await runOps(sc, c);
    } else {
      fsa.failNext(at, kind);
      done = await runOps(sc, c);
    }
    faults.reset(); fsa.reset();
    if (app === 'website') stillDead();
    return (await stages(c, ...validAfter(sc, states, done))).map(p => `(${met || 'no call'}) ${p}`);
  } finally { await finish(c); }
}
// The states the stages after a step may show, with `done` of its operations resolved: those after the
// last that resolved and the next's — or, for a first check (joinsLater), every state of the step.
const validAfter = (sc, /** @type {State[]} */ states, /** @type {number} */ done) => (sc.ops.some(o => o.joinsLater)
  ? /** @type {const} */ ([states, true]) : /** @type {const} */ ([states.slice(done, done + 2), false]));

// A kill: the scenario set up and its step run in a child process (this file, SHIORI_SWEEP_CHILD) that
// exits inside the k-th file call of the step; then the library opened again over the same folders.
async function killed(sc, k) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-sweep-'));
  const child = spawnSync(process.execPath, [THIS_FILE], { env: { ...process.env, SHIORI_SWEEP_CHILD: JSON.stringify({ scenario: sc.name, base, k }) },
    encoding: 'utf8', timeout: 60_000 });
  const saved = path.join(base, 'ctx.json');
  if (!fs.existsSync(saved) || (child.status !== 0 && child.status !== 42)) {
    fs.rmSync(base, { recursive: true, force: true });
    return [`step: the child ended with ${child.status} (${child.error?.message ?? ''}): ${child.stderr.slice(-400)}`];
  }
  const was = JSON.parse(fs.readFileSync(saved, 'utf8'));
  const done = Number(fs.readFileSync(path.join(base, 'done'), 'utf8'));
  const lib = await desktopLibrary(base);
  /** @type {Ctx} */
  const c = { ...was, lib, known: new Set(was.known), deleted: new Set(was.deleted), plants: new Map(was.plants) };
  const met = fs.existsSync(path.join(base, 'met')) ? fs.readFileSync(path.join(base, 'met'), 'utf8') : 'no call';
  try { return (await stages(c, ...validAfter(sc, statesOf(sc, c), done))).map(p => `(${met}) ${p}`); } finally { await finish(c); }
}
// The child's part: set up, saved for the parent, then the step with an exit in its k-th file call.
async function child({ scenario, base, k }) {
  const sc = /** @type {any} */ (SCENARIOS.find(s => s.name === scenario));
  const c = await setUp('desktop', sc, base);
  const save = () => fs.writeFileSync(path.join(base, 'ctx.json'), JSON.stringify({ ...c, lib: null, known: [...c.known], deleted: [...c.deleted], plants: [...c.plants] }));
  save();
  fs.writeFileSync(path.join(base, 'done'), '0');
  let n = 0;
  faults.failNext((call) => { if (++n === k) { fs.writeFileSync(path.join(base, 'met'), `${call.op} ${short(call.path)}`); process.exit(42); } return false; }, 'EIO', { times: Infinity });
  await runOps(sc, c, undefined, (done) => { save(); fs.writeFileSync(path.join(base, 'done'), String(done)); });
  process.exit(0);
}
if (process.env.SHIORI_SWEEP_CHILD) await child(JSON.parse(process.env.SHIORI_SWEEP_CHILD));

// ── The tests ──
const EVERY = Number(process.env.SHIORI_SWEEP_EVERY) || 0;   // 0: the sample
const [SHARD, SHARDS] = (process.env.SHIORI_SWEEP_SHARD || '0/1').split('/').map(Number);
const only = (/** @type {string} */ name, /** @type {string} */ v) => !process.env[name] || process.env[name] === v;
// The fault points swept out of `count` for scenario `sc`: every EVERY-th (the shard's), or the sample —
// three spread over the step, or the middle one for a scenario that says so (`sample: 1`).
const pointsOf = (/** @type {number} */ count, /** @type {{ sample?: number }} */ sc) => {
  const all = Array.from({ length: count }, (_, i) => i + 1);
  if (process.env.SHIORI_SWEEP_POINTS) return process.env.SHIORI_SWEEP_POINTS.split(',').map(Number);
  if (EVERY) return all.filter((k, i) => i % EVERY === 0 && Math.floor(i / EVERY) % SHARDS === SHARD);
  return [...new Set((sc.sample === 1 ? [0.5] : [0.2, 0.5, 0.8]).map(f => all[Math.floor(f * (count - 1))]))].filter(Boolean);
};
const skip = !!globalThis.__desktopLibrary && 'run by npm test';
// npm test runs this file for the desktop's sample, and folder-sweep-website.test.mjs (this file again,
// SHIORI_SWEEP_APP=website) for the website's, so the two run at once.
for (const app of /** @type {('desktop' | 'website')[]} */ (['desktop', 'website'])) {
  if (process.env.SHIORI_SWEEP_APP ? process.env.SHIORI_SWEEP_APP !== app : app !== 'desktop') continue;
  describe(`fault sweeps, ${app}`, () => {
    for (const kind of KINDS[app]) {
      if (!only('SHIORI_SWEEP_KIND', kind) || (!EVERY && !process.env.SHIORI_SWEEP_KIND && BLIPS.includes(kind) && kind !== 'drive blip 2')) continue;
      for (const sc of sweeps(app, kind)) {
        if (!only('SHIORI_SWEEP_SCENARIO', sc.name)) continue;
        test(`${kind}: ${sc.name}`, { skip, todo: TODO[`${app} ${kind}: ${sc.name}`] }, async (t) => {
          if (app === 'website') shadowLocks();
          const count = await callsOf(app, sc);
          const found = [];
          stuck = 0;
          for (const k of pointsOf(count, sc)) for (const p of await once(app, kind, sc, k)) found.push(`call ${k}/${count}: ${p}`);
          t.diagnostic(`${pointsOf(count, sc).length} of ${count} fault points${stuck ? `, ${stuck} where the drive couldn't leave (a file in it open)` : ''}`);
          if (found.length) throw new Error(`${found.length} found:\n  ${found.join('\n  ')}`);
        });
      }
    }
  });
}

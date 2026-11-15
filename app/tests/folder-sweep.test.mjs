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
// the next check either state may show, from it on only the gallery joined whole (or, while folder A isn't
// the library's, none of it).
//
// Every operation the drivers offer is the step of a scenario here (S26a; the map is in the plan's §10):
// the library's own, and the hand-overs, where the other app (the website for the desktop's runs, the
// desktop for the website's: `otherApp`) wrote folder A in the setup.
//
// npm test runs a sample: one fault point of each scenario (but those marked `sample: 0`, the whole
// sweep's alone) for every kind (of the blips, m = 2), a fifth of the way into its step, midway or four
// fifths, turning with the kind — the
// desktop's in this file, the website's in folder-sweep-website.test.mjs. The whole sweep runs by hand, a
// process per app, kind and shard (folder-sweep-long.mjs); one process alone:
//   SHIORI_SWEEP_EVERY=1 SHIORI_SWEEP_APP=<desktop|website> SHIORI_SWEEP_KIND=<kind> node --test app/tests/folder-sweep.test.mjs
// (SHIORI_SWEEP_SCENARIO=<name>[|<name>…]: those scenarios; SHIORI_SWEEP_SHARD=<i>/<n>: every n-th point from the i-th;
// SHIORI_SWEEP_POINTS=<k>,…: those points alone, to replay a finding).
// A scenario a later step's finding fails on is marked todo with that step (TODO).
import test, { describe } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { desktopLibrary, webLibrary, pageNow, pageCalling, clockAhead } from './library-drivers.mjs';
import { CLAIM_TTL_MS } from '../js/storage/folder-owner.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { zipCreate } from '../js/zip.js';
import { v1Gallery, legacyGallery, seriesExport } from './fixtures/storage-fixtures.mjs';

/** @typedef {import('./library-drivers.mjs').Driver} Driver */
/** A gallery as a stage must show it: where it is (folder A or B), its title, its pages ([original,
 * translation or the original], each as hex), a series owner's chapters (the ids of those the library
 * has, in order; for the owners a scenario names in `series`), and the library's folders: whether A is
 * one of them.
 * @typedef {{ place: 'A' | 'B', title: string, pages: [string, string][], chapters?: string[] }} G
 * @typedef {{ aIn: boolean, galleries: Record<string, G> }} State */
/** A run's library and what its scenario made: folder ids and paths, gallery ids (`g`), every gallery
 * id it made (`known`), those whose deletion resolved (`deleted`), the person's files (`plants`),
 * whether folder A's removal may need the person's Discard (`discard`: a limit of §8, set by a scenario),
 * whether folder A is to be shown again before the stages (`showFirst`: a kill may leave it hidden),
 * whether it is to be taken back from another app then, and added again with "Use anyway" (`takeBack`),
 * the galleries a first check is to join (`want`, by `g`'s key, as a stage shows them), the series
 * owners whose chapters a stage shows (`series`), the other app (`other`, made in the setup alone), and
 * what the step itself found wrong (`wrong`: refusedFor), and whether the other app met the folder already
 * (`met`).
 * @typedef {{ lib: Driver, base: string, A: string, B: string, ids: Record<string, string>, g: Record<string, string>,
 *   titles: Record<string, string>, known: Set<string>, deleted: Set<string>, plants: Map<string, string>, discard?: boolean,
 *   showFirst?: boolean, takeBack?: boolean, want?: Record<string, G>, series?: string[], other?: Driver | null, wrong?: string[], met?: boolean }} Ctx */

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
// A folder's first check of what it holds: galleries `keys` of `want` join.
const FIRST_CHECK = (/** @type {string[]} */ ...keys) => op('first check', (c) => c.lib.scan(c.ids.A),
  (s, c) => ({ ...clone(s), galleries: { ...s.galleries, ...Object.fromEntries(keys.map(key => [c.g[key], /** @type {Record<string, G>} */ (c.want)[key]])) } }), null, true);
// Folder A added (`options`: { force } for "Use anyway").
const ADD = (options = {}) => op('add A', async (c) => { c.ids.A = await c.lib.add(c.A, options); }, (s) => ({ ...clone(s), aIn: true }));
// A check of folder A that reads what the other app published there since (D4): every check from it on
// shows it, so it counts as a check that joins.
const CATCH_UP = (/** @type {(s: State, c: Ctx) => State} */ apply) => op('check', (c) => c.lib.scan(c.ids.A), apply, null, true);
/** @param {State} s @param {string} gid @param {string[]} ids */
const withChapters = (s, gid, ids) => { const t = clone(s); t.galleries[gid].chapters = ids; return t; };
/** @param {State} s @param {string} to */
const allIn = (s, to) => { const t = clone(s); for (const g of Object.values(t.galleries)) g.place = /** @type {'A' | 'B'} */ (to); return t; };
// The other app, over the same folders: the website for the desktop's runs, the desktop for the website's
// (its data and first folder in the run's folder). It works in the setup alone, and is closed after it.
async function otherApp(/** @type {Ctx} */ c) {
  c.other = c.lib.app === 'desktop' ? await webLibrary() : await desktopLibrary(path.join(c.base, 'other'));
  return c.other;
}
// Until the other app's work on gallery `gid` is in its folder: the manifest there names `file` — or the
// gallery's description `at` holds `file` (flushed again meanwhile — the desktop's close doesn't wait for a
// picture still being put in place, §8).
async function publishedThere(/** @type {Driver} */ other, /** @type {string} */ gid, /** @type {string} */ file, at = '.shiori/gallery.json') {
  for (let i = 0; i < 100; i++) {
    await other.flush();
    const there = path.join(/** @type {string} */ (await other.dirOf(gid)), ...at.split('/'));
    if (fs.existsSync(there) && fs.readFileSync(there, 'utf8').includes(file)) return;
    await sleep(50);
  }
  throw new Error(`the other app's ${file} never reached gallery ${gid}'s folder`);
}
// This app told at once that the other app took folder A over (the claim it read is no longer taken as
// fresh: the desktop's probes, the website's grants, which a change to the library's folders forgets).
async function sawTaken(/** @type {Ctx} */ c) {
  await c.lib.setDefault(c.lib.home);
  if (c.lib.app === 'desktop') c.lib.raw.folders._probes.clear();
}
// Change `p`, which the commit gate may refuse: refused as for another app's claim ('not-owned', "This
// folder is in use by another app.") with nobody else on folder A, it is a finding of the run (`c.wrong`,
// reported by the stages); the step stops there, as for any failure.
async function refusedFor(/** @type {Ctx} */ c, /** @type {string} */ what, /** @type {Promise<unknown>} */ p) {
  try { return await p; } catch (e) {
    if (/** @type {any} */ (e)?.reason === 'not-owned') (c.wrong ||= []).push(`${what} refused "in use by another app" with nobody else on the folder`);
    throw e;
  }
}
// Change `change`, tried a quiet moment past the claim's time to live (nothing else reading it) while the
// other app holds folder A and this app has learned of it: the gate refuses it ('not-owned'; a deletion
// while the drive is away, as D3 refuses it: 'unavailable'), and the step goes on. One accepted is a
// finding of the run (`c.wrong`); one that fails otherwise (the fault itself) stops the step there.
async function refusedHere(/** @type {Ctx} */ c, /** @type {string} */ what, /** @type {() => Promise<unknown>} */ change) {
  clockAhead(CLAIM_TTL_MS);
  try { await change(); } catch (e) {
    if (['not-owned', 'unavailable'].includes(/** @type {any} */ (e)?.reason)) return;
    throw e;
  }
  (c.wrong ||= []).push(`${what} accepted while the other app holds the folder`);
}
// `work` done while folder A's drive is away — what it changes waits — and every attempt to save it there
// that it set going (a publication made at once, a settle) ended before the drive is back.
async function awayFor(/** @type {Ctx} */ c, /** @type {() => Promise<unknown>} */ work) {
  fs.renameSync(c.A, `${c.A}.away`);
  try { await work(); await c.lib.flush(); } finally { fs.renameSync(`${c.A}.away`, c.A); }
}
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
// Gallery alpha as it shows while its folder isn't where the library has it and no check has followed it
// yet: page 3 alone, which waits, reads (its pages 1 and 2 none).
const unfollowed = (/** @type {Ctx} */ c, /** @type {'A' | 'B'} */ place) => /** @type {State} */ ({ aIn: true,
  galleries: { [c.g.alpha]: /** @type {G} */ (/** @type {any} */ ({ place, title: 'Alpha', pages: [null, null, [hex(png(3)), hex(png(3))]] })) } });

/** The scenarios: `setup` (then flushed: committed and published), the expected state after it
 * (`state`), and the step's operations. `apps`: where it runs (both by default); `kinds`: the fault
 * kinds it is swept with, where not all; `moves`: a gallery moves in it (swept with EXDEV too);
 * `sample`: 0 for none of its fault points in npm test's sample (the long sweep's alone);
 * `noA`: folder A is made, not added (the step adds it); `also`: states stage `stage` may show besides
 * the step's (what the operation may end in by design, or what a later stage brings about); `startsAgain`:
 * the step is a start, and one that failed is made again before the stages (the person opening the app
 * again); `met`: what the other app does once the step has ended, wherever the fault stopped it, before
 * the stages (with no fault: it uses folder A anyway, works there and lets it go) — `metFirst`: after a kill
 * or the page's death, before this app is opened again.
 * @type {{ name: string, apps?: string[], kinds?: string[], moves?: boolean, sample?: number, noA?: boolean, noSetupFlush?: boolean, startsAgain?: boolean,
 *   also?(c: Ctx, stage: string): State[], setup(c: Ctx): Promise<void>, state(c: Ctx): State, ops: ReturnType<typeof op>[], met?(c: Ctx): Promise<void>,
 *   metFirst?: boolean }[]} */
const SCENARIOS = [
  {
    name: 'a gallery\'s first writes',
    async setup(c) {
      c.g.beta = await made(c, 'Beta', [png(1)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      c.g.alpha = String(c.lib.raw.nextGalleryId()); c.known.add(c.g.alpha);   // made in the step
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.beta]: G('A', 'Beta', [png(1)]), [c.g.alpha]: G('A', 'Alpha', []) } }),
    ops: [
      op('made', (c) => c.lib.newGallery('Alpha', c.g.alpha)),
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
    moves: true,
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
    apps: ['desktop'],    async setup(c) {
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
    name: 'a folder hidden and shown with changes not published',    async setup(c) {
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
    name: 'a translation replaced, then the gallery deleted',    async setup(c) {
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
    name: 'a check of Shiori\'s own galleries',    async setup(c) {
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
    name: 'a check of linked titles',    async setup(c) {
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
    name: 'a first check of an earlier version\'s gallery, with its files list',    async setup(c) {
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
    name: 'a first check of an earlier version\'s gallery, without its files list',    async setup(c) {
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
    apps: ['desktop'],    async setup(c) {
      const at = path.join(c.A, 'Old one'), old = legacyGallery(at);
      c.g.old = old.gid;
      c.known.add(old.gid);
      c.want = { old: shownAs(at, 'The oldest format', [['0001.webp', null], ['0002.webp', null]]) };
    },
    state: () => ({ aIn: true, galleries: {} }),
    ops: [FIRST_CHECK('old')],
  },
  {
    name: 'a first check of a gallery with a page replaced, its folder added again',    async setup(c) {
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
    name: 'a first check of a linked ZIP translated, its folder added again',    async setup(c) {
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
  {
    name: 'a first check of a linked folder of pictures translated, its folder added again',    async setup(c) {
      fs.mkdirSync(path.join(c.A, 'Pics'));
      for (const n of [1, 2]) fs.writeFileSync(path.join(c.A, 'Pics', `00${n}.png`), png(10 + n));
      for (const n of [1, 2]) theirs(c, path.join(c.A, 'Pics', `00${n}.png`));
      await c.lib.scan(c.ids.A);
      c.g.pics = (await c.lib.galleries()).map(String)[0];
      c.known.add(c.g.pics);
      await c.lib.putTranslation(c.g.pics, 2, png(17));
      await c.lib.flush();
      await sleep(150);
      await addedAgain(c);
      c.want = { pics: { place: 'A', title: 'Pics', pages: [[hex(png(11)), hex(png(11))], [hex(png(12)), hex(png(17))]] } };
    },
    state: () => ({ aIn: true, galleries: {} }),
    ops: [FIRST_CHECK('pics')],
  },
  {
    name: 'a first check of a drawn PDF translated, its folder added again',    async setup(c) {
      fs.writeFileSync(path.join(c.A, 'Doc.pdf'), '%PDF-1.4 a document');
      theirs(c, path.join(c.A, 'Doc.pdf'));
      await c.lib.scan(c.ids.A);
      const [w] = await c.lib.pdfsWaiting();
      c.g.doc = await c.lib.addRendered(w.folder, w.gid, [png(61), png(62)], (await c.lib.pdfSource(w.folder, w.gid)).token);
      c.known.add(c.g.doc);
      await c.lib.putTranslation(c.g.doc, 1, png(69));
      await c.lib.flush();
      await sleep(150);
      await addedAgain(c);
      c.want = { doc: { place: 'A', title: 'Doc', pages: [[hex(png(61)), hex(png(69))], [hex(png(62)), hex(png(62))]] } };
    },
    state: () => ({ aIn: true, galleries: {} }),
    ops: [FIRST_CHECK('doc')],
  },
  // ── S26a: the operations no scenario had as its step (the map: plan §10) ──
  {
    name: 'a title changed',
    sample: 0,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]) } }),
    ops: [op('retitle', (c) => c.lib.setTitle(c.g.alpha, 'Alpha 2'), (s, c) => { const t = clone(s); t.galleries[c.g.alpha].title = 'Alpha 2'; return t; }), FLUSH],
  },
  {
    // What the windows read (Settings → Storage, the reader, a page drawing PDFs) changes nothing.
    name: 'the library read',
    sample: 0,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      await c.lib.putTranslation(c.g.alpha, 1, png(3));
      fs.writeFileSync(path.join(c.A, 'Pack.zip'), zipCreate([{ name: '001.png', data: png(11) }]));
      fs.writeFileSync(path.join(c.A, 'Doc.pdf'), '%PDF-1.4 a document');   // waiting to be drawn
      for (const at of ['Pack.zip', 'Doc.pdf']) theirs(c, path.join(c.A, at));
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.scan(c.ids.A);
      c.g.pack = /** @type {string} */ ((await c.lib.galleries()).map(String).find(gid => gid !== c.g.alpha));
      c.known.add(c.g.pack);
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]), [c.g.pack]: G('A', 'Pack', [png(11)]) } }, c.g.alpha, 1, png(3)),
    ops: [op('read', async (c) => {
      await c.lib.list();
      for (const gid of [c.g.alpha, c.g.pack]) {
        await c.lib.sources(gid);
        for (const n of [1, 2]) { await c.lib.read(gid, n); await c.lib.read(gid, n, 'translated'); }
      }
      for (const w of await c.lib.pdfsWaiting()) await c.lib.pdfSource(w.folder, w.gid);
    })],
  },
  {
    name: 'a PDF drawn, and one that can\'t be',
    sample: 0,
    async setup(c) {
      for (const name of ['Doc', 'Bad']) {
        fs.writeFileSync(path.join(c.A, `${name}.pdf`), `%PDF-1.4 ${name}`);
        theirs(c, path.join(c.A, `${name}.pdf`));
      }
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.scan(c.ids.A);
      for (const w of await c.lib.pdfsWaiting()) { c.g[w.path.replace(/\.pdf$/, '')] = w.gid; c.known.add(w.gid); }
    },
    state: () => ({ aIn: true, galleries: {} }),
    ops: [
      op('Doc drawn', async (c) => {
        const w = (await c.lib.pdfsWaiting()).find(p => p.gid === c.g.Doc);
        if (!w) throw new Error('Doc isn\'t waiting');
        await c.lib.addRendered(w.folder, w.gid, [png(61), png(62)], (await c.lib.pdfSource(w.folder, w.gid)).token);
      }, (s, c) => ({ ...clone(s), galleries: { ...s.galleries, [c.g.Doc]: G('A', 'Doc', [png(61), png(62)]) } })),
      op('Bad can\'t be drawn', async (c) => {
        const w = (await c.lib.pdfsWaiting()).find(p => p.gid === c.g.Bad);
        if (!w) throw new Error('Bad isn\'t waiting');
        await c.lib.pdfFailed(w.folder, w.gid, (await c.lib.pdfSource(w.folder, w.gid)).token);
      }),
      FLUSH, SETTLE,
    ],
  },
  {
    // What a page or the app left to do: a change not published, a deletion its folder refused.
    name: 'a start with work left over',
    sample: 0,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      c.g.beta = await made(c, 'Beta', [png(4)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      await deletesRefused(c, async () => { await c.lib.deleteGallery(c.g.beta); await sleep(150); });
      c.deleted.add(c.g.beta);
      await c.lib.putTranslation(c.g.alpha, 1, png(5));   // committed, not yet published
      await c.lib.setTitle(c.g.alpha, 'Alpha 2');
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha 2', [png(1), png(2)]) } }, c.g.alpha, 1, png(5)),
    ops: [op('start', (c) => /** @type {() => Promise<void>} */ (c.lib.restart)()), FLUSH, SETTLE],
    noSetupFlush: true,
    startsAgain: true,
  },
  {
    name: 'a folder\'s removal that moves its galleries to another folder',
    moves: true,
    sample: 0,
    async setup(c) {
      c.ids.B = await c.lib.add(c.B);
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      await c.lib.putTranslation(c.g.alpha, 1, png(3));
      plant(c, 'A/mine.txt', 'the person\'s own file');
      plant(c, 'B/mine.txt', 'another of the person\'s files');
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]) } }, c.g.alpha, 1, png(3)),
    // A gallery whose move can't be made stays in the folder, which goes all the same (`left`); a removal
    // that can't save what it owes is kept, the galleries moved already staying moved.
    also: (c) => { const s = withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]) } }, c.g.alpha, 1, png(3)); return [{ ...s, aIn: false }, allIn(s, 'B')]; },
    ops: [
      op('remove A, its galleries to B', async (c) => { await c.lib.setDefault(c.lib.home); await c.lib.remove(c.ids.A, { moveTo: c.ids.B }); },
        (s) => ({ ...allIn(s, 'B'), aIn: false })),
      FLUSH, SETTLE,
    ],
  },
  {
    name: 'a folder\'s removal refused while another app holds it, then removed anyway',
    sample: 0,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      await c.lib.setTitle(c.g.alpha, 'Alpha 2');   // committed, not yet published
      await c.lib.takeOver(c.ids.A);
      await sawTaken(c);
      c.takeBack = true;
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha 2', [png(1), png(2)]) } }),
    ops: [
      op('remove A: refused', async (c) => {
        const e = await c.lib.remove(c.ids.A).then(() => null, (/** @type {any} */ e) => e);
        if (e?.reason !== 'unsaved') throw e ?? new Error('the removal went on');
      }),
      op('remove A anyway', (c) => c.lib.remove(c.ids.A, { discard: true }),
        (s, c) => { const t = clone(s); t.aIn = false; t.galleries[c.g.alpha].title = 'Alpha'; return t; }),   // the folder's title: the change is lost, as asked
    ],
    noSetupFlush: true,
  },
  {
    name: 'a new folder added',
    noA: true,
    sample: 0,
    async setup(c) {
      const at = path.join(c.A, 'Old one'), old = await v1Gallery(at, { files: true });
      c.g.old = old.gid;
      c.known.add(old.gid);
      c.want = { old: shownAs(at, 'Version one', [[old.current[1], 'translated/0001.png'], ['images/0002.webp', null]]) };
      plant(c, 'A/mine.txt', 'the person\'s own file');
    },
    state: () => ({ aIn: false, galleries: {} }),
    ops: [ADD(), FIRST_CHECK('old')],
  },
  // The hand-overs: the other app wrote folder A in the setup (in npm test's sample: the family's).
  {
    name: 'a folder the other app let go, added',
    noA: true,
    async setup(c) {
      const other = await otherApp(c);
      const theirs = await other.add(c.A);
      await other.setDefault(theirs);
      c.g.gamma = await other.newGallery('Gamma');
      c.known.add(c.g.gamma);
      for (const n of [1, 2]) await other.putPage(c.g.gamma, n, png(40 + n));
      await other.putTranslation(c.g.gamma, 1, png(43));
      await other.flush();
      if (other.app === 'desktop') { await other.raw.archiveGallery(c.g.gamma); await sleep(250); }   // the desktop keeps it so
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await other.setDefault(other.home);
      await other.remove(theirs);
      await other.close();
      c.want = { gamma: { place: 'A', title: 'Gamma', pages: [[hex(png(41)), hex(png(43))], [hex(png(42)), hex(png(42))]] } };
    },
    state: () => ({ aIn: false, galleries: {} }),
    ops: [ADD(), FIRST_CHECK('gamma')],
  },
  {
    name: 'a folder the other app holds, used anyway',
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      await c.lib.setDefault(c.lib.home);
      await c.lib.remove(c.ids.A);
      const other = await otherApp(c);
      await other.scan(await other.add(c.A));
      await other.putTranslation(c.g.alpha, 1, png(7));
      await publishedThere(other, c.g.alpha, 'translated/');
      await other.close();
      c.takeBack = true;   // added again with "Use anyway", should the step's add not be made
      c.want = { alpha: { place: 'A', title: 'Alpha', pages: [[hex(png(1)), hex(png(7))], [hex(png(2)), hex(png(2))]] } };
    },
    state: () => ({ aIn: false, galleries: {} }),
    ops: [ADD({ force: true }), FIRST_CHECK('alpha')],
  },
  {
    // This app put a page of Beta while folder A's drive was away (it waits: the desktop's in its own
    // staging, the website's in this browser); then the other app used the folder anyway and translated a
    // page of Alpha there. This app, told, makes Gamma meanwhile — a gallery only it has, which keeps
    // working and waits (one the folder holds is read-only here: the owner's rule of 2026-11-15) — and takes
    // the folder back: what waited goes to the folder (the other app changed neither Beta nor Gamma), and
    // its check reads the other app's work.
    name: 'a folder the other app used anyway, taken back',
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      c.g.beta = await made(c, 'Beta', [png(4)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      await awayFor(c, () => c.lib.putPage(c.g.beta, 2, png(5)));
      const other = await otherApp(c);
      await other.scan(await other.add(c.A, { force: true }));
      await other.putTranslation(c.g.alpha, 1, png(7));
      await publishedThere(other, c.g.alpha, 'translated/');
      await other.close();
      await c.lib.list();   // the person sees the folder used elsewhere: it is known taken
      c.g.gamma = await made(c, 'Gamma', [png(6)]);
      c.takeBack = true;
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]), [c.g.beta]: G('A', 'Beta', [png(4), png(5)]),
      [c.g.gamma]: G('A', 'Gamma', [png(6)]) } }),
    // The website reads the other app's generation later while it is busy with the gallery itself (a
    // change of a moment ago announced, its size refreshed: folder-library.js _catchUp) — under load, at
    // every check of the stages: until the folder is read afresh (added again), the state before it may show.
    also: (c, stage) => (c.lib.app !== 'website' || stage === 're-add' ? []
      : [{ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]), [c.g.beta]: G('A', 'Beta', [png(4), png(5)]), [c.g.gamma]: G('A', 'Gamma', [png(6)]) } }]),
    ops: [op('take A back', (c) => c.lib.raw.folderClaim(c.ids.A)), CATCH_UP((s, c) => withTranslation(s, c.g.alpha, 1, png(7))), FLUSH, SETTLE],
    noSetupFlush: true,
  },
  {
    // The same, both apps translating one page (review 7 A4, under the owner's rule of 2026-11-15): this
    // app translated page 1 while the drive was away (it waits), the other app translated it while it used
    // the folder anyway. At the take-back the folder's version stands — this app's translation is dropped,
    // nothing of it goes into the folder — through every point of the take-back and the drop: from the
    // stages' check on, the other app's translation shows (until then this app's may: it waited).
    name: 'a folder the other app used anyway, taken back, a page both apps translated',
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      await awayFor(c, () => c.lib.putTranslation(c.g.alpha, 1, png(8)));
      const other = await otherApp(c);
      await other.scan(await other.add(c.A, { force: true }));
      await other.putTranslation(c.g.alpha, 1, png(7));
      await publishedThere(other, c.g.alpha, 'translated/');
      await other.close();
      await sawTaken(c);
      c.takeBack = true;
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]) } }, c.g.alpha, 1, png(8)),
    ops: [op('take A back', (c) => c.lib.raw.folderClaim(c.ids.A), (s, c) => withTranslation(s, c.g.alpha, 1, png(7)), null, true), CHECK, FLUSH, SETTLE],
    noSetupFlush: true,
  },
  // A series: made, a chapter added, the chapters reordered, then moved to another folder whole; and a
  // series export joining a folder at its first check.
  {
    name: 'a series made, regrouped, and moved to another folder',
    moves: true,
    sample: 0,
    async setup(c) {
      c.ids.B = await c.lib.add(c.B);
      for (const [key, title, n] of [['one', 'One', 1], ['two', 'Two', 2], ['three', 'Three', 3]]) c.g[/** @type {string} */ (key)] = await made(c, /** @type {string} */ (title), [png(/** @type {number} */ (n))]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      plant(c, 'B/mine.txt', 'another of the person\'s files');
      c.series = [c.g.one];
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.one]: G('A', 'One', [png(1)]), [c.g.two]: G('A', 'Two', [png(2)]), [c.g.three]: G('A', 'Three', [png(3)]) } }),
    ops: [
      op('made', (c) => c.lib.raw.seriesCommand('write', c.g.one, [{ id: c.g.one, title: 'One' }, { id: c.g.two, title: 'Two' }],
        { seriesTitle: { english: 'Saga', japanese: '', pretty: '' } }), (s, c) => withChapters(s, c.g.one, [c.g.one, c.g.two])),
      op('a chapter added', (c) => c.lib.raw.seriesCommand('attach', c.g.one, c.g.three), (s, c) => withChapters(s, c.g.one, [c.g.one, c.g.two, c.g.three])),
      op('reordered', (c) => c.lib.raw.seriesCommand('reorder', c.g.one, [c.g.one, c.g.three, c.g.two]), (s, c) => withChapters(s, c.g.one, [c.g.one, c.g.three, c.g.two])),
      FLUSH,
      op('moved to B', (c) => c.lib.move(c.g.one, c.ids.B), (s) => allIn(s, 'B')),
      FLUSH, SETTLE,
    ],
  },
  {
    name: 'a first check of a series export',
    sample: 0,
    async setup(c) {
      const [one, two] = ['1790000000101', '1790000000102'];
      const json = (/** @type {unknown} */ v) => new TextEncoder().encode(JSON.stringify(v));
      const T = (/** @type {string} */ english) => ({ english, japanese: '', pretty: '' });
      const chapters = [{ id: one, title: 'One', folder: 'One' }, { id: two, title: 'Two', folder: 'Two' }];
      fs.writeFileSync(path.join(c.A, 'Series.zip'), zipCreate([
        { name: 'series.json', data: json({ format: 'shiori-series', version: 1, seriesTitle: 'Series', chapters }) },
        { name: 'One/metadata.json', data: json({ galleryId: one, title: T('One'), chapters: chapters.map(({ id, title }) => ({ id, title })), seriesTitle: 'Series' }) },
        { name: 'One/images/0001.png', data: png(71) },
        { name: 'Two/metadata.json', data: json({ galleryId: two, title: T('Two'), parentId: one }) },
        { name: 'Two/images/0001.png', data: png(72) },
      ]));
      plant(c, 'A/mine.txt', 'the person\'s own file');
      Object.assign(c.g, { one, two });
      c.known.add(one).add(two);
      c.series = [one];
      c.want = { one: { ...G('A', 'One', [png(71)]), chapters: [one, two] }, two: G('A', 'Two', [png(72)]) };
    },
    // A chapter that couldn't be read joins at the next check, the other now.
    also: (c, stage) => (stage !== 'flush' ? [] : [{ aIn: true, galleries: { [c.g.one]: { ...G('A', 'One', [png(71)]), chapters: [c.g.one] } } },
      { aIn: true, galleries: { [c.g.two]: G('A', 'Two', [png(72)]) } }]),
    state: () => ({ aIn: true, galleries: {} }),
    ops: [FIRST_CHECK('one', 'two')],
  },
  {
    // A chapter of a series export deleted (review 7 A5): on the website a chapter of an archive read in
    // place — the archive, the person's file, never changed for it, its removal noted for the chapter — on
    // the desktop a folder of the series' it unpacked the export into at its first check.
    name: 'a chapter of a series export deleted',
    sample: 0,
    async setup(c) {
      const [one, two, three] = seriesExport(c.A, (n) => png(80 + n));
      plant(c, 'A/mine.txt', 'the person\'s own file');
      Object.assign(c.g, { one, two, three });
      for (const gid of [one, two, three]) c.known.add(gid);
      c.series = [one];
      await c.lib.scan(c.ids.A);
      if (c.lib.app === 'website') theirs(c, path.join(c.A, 'Series.zip'));
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.one]: { ...G('A', 'One', [png(81)]), chapters: [c.g.one, c.g.two, c.g.three] },
      [c.g.two]: G('A', 'Two', [png(82)]), [c.g.three]: G('A', 'Three', [png(83)]) } }),
    ops: [
      op('delete Two', (c) => c.lib.deleteGallery(c.g.two), (s, c) => withChapters(without(s, c.g.two), c.g.one, [c.g.one, c.g.three]), 'two'),
      FLUSH, SETTLE,
    ],
  },
  // A gallery followed (review 7 B5, B3): its folder renamed, or moved into folder B, by hand, then a page put
  // before any check (it waits: the desktop's in its staging, the website's in this browser). The step is the
  // check that follows it, and what waited going there. Until a check follows it, it reads only what waited
  // (`also`: before the stages' own check); from then on, whole and where it now is.
  {
    name: 'a gallery renamed by hand, followed with a page waiting',
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      await c.lib.putTranslation(c.g.alpha, 1, png(5));
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      fs.renameSync(path.join(c.A, 'Alpha'), path.join(c.A, 'Alpha by hand'));
      await c.lib.putPage(c.g.alpha, 3, png(3));
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2), png(3)]) } }, c.g.alpha, 1, png(5)),
    also: (c, stage) => (stage === 'flush' ? [unfollowed(c, 'A')] : []),
    ops: [CHECK, FLUSH, SETTLE],
  },
  {
    name: 'a gallery moved by hand into another folder, followed with a page waiting',
    sample: 0,
    async setup(c) {
      c.ids.B = await c.lib.add(c.B);
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      await c.lib.putTranslation(c.g.alpha, 1, png(5));
      plant(c, 'A/mine.txt', 'the person\'s own file');
      plant(c, 'B/mine.txt', 'another of the person\'s files');
      await c.lib.flush();
      fs.renameSync(path.join(c.A, 'Alpha'), path.join(c.B, 'Alpha'));
      await c.lib.putPage(c.g.alpha, 3, png(3));
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('B', 'Alpha', [png(1), png(2), png(3)]) } }, c.g.alpha, 1, png(5)),
    also: (c, stage) => (stage === 'flush' ? [unfollowed(c, 'B')] : []),
    ops: [op('check B', (c) => c.lib.scan(c.ids.B)), FLUSH, SETTLE],
  },
  // Work in flight at a take-over (S29b).
  {
    // C1: the folder's claim as last read forgotten, so the step's first change reads it again — every point
    // of that read and of the changes after it faulted. A claim that couldn't be read is no knowledge that
    // another app holds the folder: a change that writes no file is never refused for it (`refusedFor`), and
    // whatever was accepted reaches the folder.
    name: 'changes made as the folder\'s claim is read again',
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      c.g.beta = await made(c, 'Beta', [png(4)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]), [c.g.beta]: G('A', 'Beta', [png(4)]) } }),
    ops: [
      op('the claim as read forgotten', async (c) => { if (c.lib.app === 'desktop') c.lib.raw.folders._probes.clear(); else await c.lib.setDefault(c.ids.A); }),
      op('page 3', (c) => refusedFor(c, 'page 3', c.lib.putPage(c.g.alpha, 3, png(3))), (s, c) => withPage(s, c.g.alpha, 3, png(3))),
      op('translation 1', (c) => refusedFor(c, 'translation 1', c.lib.putTranslation(c.g.alpha, 1, png(5))), (s, c) => withTranslation(s, c.g.alpha, 1, png(5))),
      op('retitled', (c) => refusedFor(c, 'its title', c.lib.setTitle(c.g.alpha, 'Alpha 2')), (s, c) => { const t = clone(s); t.galleries[c.g.alpha].title = 'Alpha 2'; return t; }),
      op('delete Beta', (c) => c.lib.deleteGallery(c.g.beta), (s, c) => without(s, c.g.beta), 'beta'),
      FLUSH, SETTLE,
    ],
  },
  {
    // C2 (S29c): the other app uses folder A anyway, and this app has learned of it (the person saw the folder
    // used elsewhere, a change refused). The step: a title, a page, a translation and Beta's deletion, each a
    // quiet moment past the claim's time to live after the one before, every point of their reads of the claim
    // and of the changes themselves faulted. The gate knows the last claim it read — a read that fails, or
    // the drive away, changes nothing of it — so each is refused: one accepted is a finding (`refusedHere`),
    // and nothing of them reaches the folder, nor waits here for the take-back.
    name: 'changes refused while the other app holds the folder, its claim read again',
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      c.g.beta = await made(c, 'Beta', [png(4)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      const other = await otherApp(c);
      await other.scan(await other.add(c.A, { force: true }));   // "Use anyway"
      await other.close();
      await c.lib.list();   // the person sees the folder used elsewhere
      if (await c.lib.setTitle(c.g.alpha, 'Alpha 1').then(() => true, () => false)) throw new Error('a title accepted once the folder was seen used elsewhere');
      c.takeBack = true;
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]), [c.g.beta]: G('A', 'Beta', [png(4)]) } }),
    ops: [
      op('its title, a while later', (c) => refusedHere(c, 'its title', () => c.lib.setTitle(c.g.alpha, 'Alpha 2'))),
      op('page 3, a while later', (c) => refusedHere(c, 'page 3', () => c.lib.putPage(c.g.alpha, 3, png(3)))),
      op('translation 1, a while later', (c) => refusedHere(c, 'translation 1', () => c.lib.putTranslation(c.g.alpha, 1, png(5)))),
      op('delete Beta, a while later', (c) => refusedHere(c, 'Beta\'s deletion', () => c.lib.deleteGallery(c.g.beta))),
      FLUSH, SETTLE,
    ],
    noSetupFlush: true,
  },
  {
    // B1: what this desktop library staged in folder A for its archived galleries (a translation of each,
    // waiting for the archive's lifecycle point) when another desktop library — the app on another computer —
    // used the folder anyway, checked it an hour later and changed Beta, then let it go. The step is the
    // take-back: Alpha's translation is published, Beta's dropped for the other library's version (one app
    // changes a folder's galleries at a time) — never deleted by the other's check, never lost.
    name: 'staged work taken back after another desktop library\'s check',
    apps: ['desktop'],
    sample: 0,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      c.g.beta = await made(c, 'Beta', [png(4)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      for (const g of [c.g.alpha, c.g.beta]) await c.lib.raw.archiveGallery(g);
      await c.lib.putTranslation(c.g.alpha, 1, png(8));
      await c.lib.putTranslation(c.g.beta, 1, png(9));
      const other = await desktopLibrary(path.join(c.base, 'other'), { me: 'c0ffee00c0ffee00' });
      try {
        const theirs = await other.add(c.A, { force: true });   // "Use anyway"
        const staging = path.join(c.A, '.shiori', 'staging'), t = (Date.now() - 3600_000) / 1000;
        for (const p of fs.readdirSync(staging, { recursive: true })) fs.utimesSync(path.join(staging, String(p)), t, t);
        await other.scan(theirs);   // an hour later
        await other.setTitle(c.g.beta, 'Beta there');
        await other.flush();
        await other.setDefault(other.home);
        await other.remove(theirs);
      } finally { await other.close(); }
      c.takeBack = true;
    },
    state: (c) => withTranslation(withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]), [c.g.beta]: G('A', 'Beta', [png(4)]) } },
      c.g.alpha, 1, png(8)), c.g.beta, 1, png(9)),
    ops: [op('take A back', (c) => c.lib.raw.folderClaim(c.ids.A), (s, c) => { const t = clone(s); t.galleries[c.g.beta] = G('A', 'Beta there', [png(4)]); return t; }, null, true),
      CHECK, FLUSH, SETTLE],
    noSetupFlush: true,
  },
  {
    // B6: an unpack of an archived gallery (its first change, a translation of page 2) faulted at every point
    // — a kill, a failed call, the page dying, the drive away — then met by the other app, which uses the
    // folder anyway, translates page 3 and lets it go (`met`), and taken back. One gallery whatever the point:
    // never a second copy beside the first (a check reporting 'duplicate' is a finding), both apps' work read
    // — this app's translation 2 unless it still waited when the other app changed the gallery (then dropped:
    // one app changes a folder's galleries at a time).
    name: 'an unpack cut short, met by the other app using the folder anyway',
    sample: 0,
    async setup(c) {
      plant(c, 'A/mine.txt', 'the person\'s own file');
      const by = c.lib.app === 'desktop' ? c.lib : await otherApp(c);   // the desktop archives it
      if (by !== c.lib) { await c.lib.setDefault(c.lib.home); await c.lib.remove(c.ids.A); }
      const at = by === c.lib ? c.ids.A : await by.add(c.A, { force: true });
      await by.setDefault(at);
      c.g.alpha = await by.newGallery('Alpha');
      c.known.add(c.g.alpha);
      for (const n of [1, 2, 3]) await by.putPage(c.g.alpha, n, png(n));
      await by.putTranslation(c.g.alpha, 1, png(5));
      await by.flush();
      await by.raw.archiveGallery(c.g.alpha);
      await sleep(250);
      if (by !== c.lib) {
        await by.setDefault(by.home);
        await by.remove(at);
        await by.close();
        c.ids.A = await c.lib.add(c.A);   // the website reads it in place
        await c.lib.setDefault(c.ids.A);
        await c.lib.scan(c.ids.A);
      }
      c.takeBack = true;
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2), png(3)]) } }, c.g.alpha, 1, png(5)),
    // Once the other app met it: its translation 3 read, this app's translation 2 — or not, dropped where it
    // still waited when the other app changed the gallery. Before the stages' check, where the other app
    // unpacked it (its archive gone), not shown until that check follows it to its folder (S10's F5).
    also: (c, stage) => { const s = withTranslation(withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2), png(3)]) } }, c.g.alpha, 1, png(5)), c.g.alpha, 3, png(9));
      return [s, withTranslation(s, c.g.alpha, 2, png(4)), ...(stage === 'flush' ? [{ aIn: true, galleries: {} }] : [])]; },
    ops: [op('translation 2', (c) => c.lib.putTranslation(c.g.alpha, 2, png(4)), (s, c) => withTranslation(s, c.g.alpha, 2, png(4))), FLUSH, SETTLE],
    async met(c) {
      const other = await otherApp(c);
      try {
        const theirs = await other.add(c.A, { force: true });   // "Use anyway"
        const found = await other.scan(theirs);
        if (found.problems.some(p => p.reason === 'duplicate')) (c.wrong ||= []).push(`the other app's check found a copy: ${JSON.stringify(found.problems)}`);
        await other.putTranslation(c.g.alpha, 3, png(9));
        await other.flush();
        await other.setDefault(other.home);
        await other.remove(theirs);   // it lets go
      } finally { await other.close(); c.other = null; }
    },
    noSetupFlush: true,
  },
  // Two apps on one folder, the shapes S30 listed with no scenario of their own (plan §10).
  {
    // A change made in the moment before this app learned that the other app uses folder A anyway (the window:
    // accepted, or refused had it read the claim already), the other app having changed that gallery there.
    // The step is the take-back: the folder's version stands — this app's change dropped, nothing of it
    // published — from the stages' check on.
    name: 'a change made before this app learned the other app used the folder anyway, taken back',
    sample: 0,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      const other = await otherApp(c);
      await other.scan(await other.add(c.A, { force: true }));   // "Use anyway"
      await other.setTitle(c.g.alpha, 'Alpha there');
      await publishedThere(other, c.g.alpha, 'Alpha there', 'metadata.json');
      await other.close();
      c.titles.window = await c.lib.putTranslation(c.g.alpha, 2, png(8)).then(() => 'accepted', () => 'refused');
      await c.lib.flush().catch(() => {});
      c.takeBack = true;
    },
    state: (c) => { const s = { aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]) } }; return c.titles.window === 'accepted' ? withTranslation(s, c.g.alpha, 2, png(8)) : s; },
    also: (c, stage) => (c.lib.app !== 'website' || stage === 're-add' ? [] : [{ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]) } }]),
    ops: [op('take A back', (c) => c.lib.raw.folderClaim(c.ids.A), (s, c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha there', [png(1), png(2)]) } }), null, true),
      CHECK, FLUSH, SETTLE],
    noSetupFlush: true,
  },
  {
    // A gallery the other app deleted while it used folder A anyway: the step is the take-back. Here it reads
    // nothing from then on (its folder is gone: kept listed until the person deletes it), nothing of it is
    // published again, and the folder's removal goes on (S30) — added again, it never comes back.
    name: 'a gallery the other app deleted while it used the folder anyway, taken back',
    sample: 0,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1), png(2)]);
      c.g.beta = await made(c, 'Beta', [png(4)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      const beta = await dirOf(c, c.g.beta);
      const other = await otherApp(c);
      await other.scan(await other.add(c.A, { force: true }));   // "Use anyway"
      await other.deleteGallery(c.g.beta);
      for (let i = 0; i < 100 && fs.existsSync(beta); i++) { await other.flush(); await sleep(50); }
      if (fs.existsSync(beta)) throw new Error('the other app\'s deletion never ended');
      await other.close();
      c.takeBack = true;
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]) } }),
    ops: [op('take A back', (c) => c.lib.raw.folderClaim(c.ids.A)), CHECK, FLUSH, SETTLE],
    noSetupFlush: true,
  },
  {
    // A linked ZIP of the person's, retitled here while the drive was away (it waits), retitled by the other app
    // while it used folder A anyway (S30's finding: the website took such a gallery for its own alone). The
    // step is the take-back: the folder's version stands, this app's title dropped — the ZIP as it was.
    name: 'a linked ZIP both apps retitled across the other app\'s use of the folder, taken back',
    sample: 0,
    async setup(c) {
      const zip = path.join(c.A, 'Pack.zip');
      fs.writeFileSync(zip, zipCreate([{ name: '001.png', data: png(61) }, { name: '002.png', data: png(62) }]));
      theirs(c, zip);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.scan(c.ids.A);
      c.g.pack = (await c.lib.galleries())[0];
      c.known.add(c.g.pack);
      await c.lib.flush();
      await awayFor(c, () => c.lib.setTitle(c.g.pack, 'Pack here'));
      const other = await otherApp(c);
      await other.scan(await other.add(c.A, { force: true }));   // "Use anyway"
      await other.setTitle(c.g.pack, 'Pack there');
      await other.flush();
      await other.close();
      c.takeBack = true;
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.pack]: G('A', 'Pack here', [png(61), png(62)]) } }),
    also: (c, stage) => (c.lib.app !== 'website' || stage === 're-add' ? [] : [{ aIn: true, galleries: { [c.g.pack]: G('A', 'Pack here', [png(61), png(62)]) } }]),
    ops: [op('take A back', (c) => c.lib.raw.folderClaim(c.ids.A), (s, c) => ({ aIn: true, galleries: { [c.g.pack]: G('A', 'Pack there', [png(61), png(62)]) } }), null, true),
      CHECK, FLUSH, SETTLE],
    noSetupFlush: true,
  },
  {
    // A page and a translation written, faulted at every point — a kill, a failed call, the page dying, the drive
    // away — then met by the other app before this app starts again (`metFirst`: after a kill or the page's
    // death, before it is opened again): it uses folder A anyway, retitles Beta there and lets the folder go.
    // At the take-back what this app wrote of Alpha is published (the other app changed nothing of it), and
    // Beta has the other app's title.
    name: 'a page and a translation written as the app stops, met by the other app before it starts again',
    sample: 0,
    metFirst: true,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1)]);
      c.g.beta = await made(c, 'Beta', [png(4)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      c.takeBack = true;
    },
    state: (c) => ({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1)]), [c.g.beta]: G('A', 'Beta there', [png(4)]) } }),
    // Before the stages' check reads what the other app published (D4), Beta's own title shows — with any of
    // the step's states of Alpha.
    also: (c, stage) => (stage !== 'flush' ? [] : [[png(1)], [png(1), png(2)]].flatMap((pages) => {
      const s = { aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', pages), [c.g.beta]: G('A', 'Beta', [png(4)]) } };
      return [s, withTranslation(s, c.g.alpha, 1, png(5))];
    })),
    ops: [
      op('page 2', (c) => c.lib.putPage(c.g.alpha, 2, png(2)), (s, c) => { const t = clone(s); t.galleries[c.g.alpha].pages.push([hex(png(2)), hex(png(2))]); return t; }),
      op('translation 1', (c) => c.lib.putTranslation(c.g.alpha, 1, png(5)), (s, c) => withTranslation(s, c.g.alpha, 1, png(5))),
      FLUSH, SETTLE,
    ],
    async met(c) {
      const other = await otherApp(c);
      try {
        const theirs = await other.add(c.A, { force: true });   // "Use anyway"
        await other.scan(theirs);
        await other.setTitle(c.g.beta, 'Beta there');
        await other.flush();
        await other.setDefault(other.home);
        await other.remove(theirs);   // it lets go
      } finally { await other.close(); c.other = null; }
    },
  },
  {
    // The website without leave to use folder A: pictures wait in this browser, then go to the folder once
    // the person allows it (plan D23's second case).
    name: 'pictures waiting in the browser go to their folder',
    apps: ['website'],
    sample: 0,
    async setup(c) {
      c.g.alpha = await made(c, 'Alpha', [png(1)]);
      plant(c, 'A/mine.txt', 'the person\'s own file');
      await c.lib.flush();
      fsa.setPermission(c.A, 'prompt');
      await c.lib.setDefault(c.lib.home);   // the folder's leave asked afresh
      await c.lib.putPage(c.g.alpha, 2, png(2));
      await c.lib.putTranslation(c.g.alpha, 1, png(3));
    },
    state: (c) => withTranslation({ aIn: true, galleries: { [c.g.alpha]: G('A', 'Alpha', [png(1), png(2)]) } }, c.g.alpha, 1, png(3)),
    ops: [op('allowed', (c) => c.lib.raw.folderAllow(c.ids.A)), FLUSH, SETTLE],
    noSetupFlush: true,
  },
];

const BLIPS = ['drive blip 1', 'drive blip 2', 'drive blip 3', 'drive blip 5'];
const KINDS = {
  desktop: ['kill', 'EIO', 'EPERM', 'ENOENT', 'EXDEV', 'drive away', ...BLIPS],
  website: ['page death', 'NoModificationAllowedError', 'NotFoundError', 'NotAllowedError', 'drive away', ...BLIPS],
};
// Where each kind runs: EXDEV on the moves alone; EPERM and NotAllowedError without the linked ZIP (as
// the review swept them); a blip wherever the drive away does.
const sweeps = (/** @type {string} */ app, /** @type {string} */ kind) => SCENARIOS.filter(s => (!s.apps || s.apps.includes(app))
  && (kind === 'EXDEV' ? s.moves : !s.kinds || s.kinds.includes(BLIPS.includes(kind) ? 'drive away' : kind)));

// Scenarios a later step's finding fails on (plan §7), by app, kind and scenario.
/** @type {Record<string, string>} */
const TODO = {};

// ── A run ──
/** A fresh library over a new folder, with folder A added and the default (made only, for `noA`), `sc`
 * set up and published. @returns {Promise<Ctx>} */
async function setUp(/** @type {string} */ app, sc, base = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-sweep-'))) {
  const lib = app === 'desktop' ? await desktopLibrary(base) : await webLibrary();
  if (app === 'website') stillDead();
  /** @type {Ctx} */
  const c = { lib, base, A: path.join(base, 'A'), B: path.join(base, 'B'), ids: {}, g: {}, titles: {}, known: new Set(), deleted: new Set(), plants: new Map() };
  if (sc.noA) fs.mkdirSync(c.A);
  else {
    c.ids.A = await lib.add(c.A);
    await lib.setDefault(c.ids.A);
  }
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
  /** @type {Record<string, { title: string | null, pages: ([string | null, string | null] | null)[], chapters?: string[] }>} */
  const galleries = {};
  for (const gid of listed) {
    const pages = [];
    for (let n = 1; n <= MAX_PAGES; n++) {
      const original = await c.lib.read(gid, n);
      pages.push(original ? /** @type {[string | null, string | null]} */ ([hex(original), hex(await c.lib.read(gid, n, 'translated'))]) : null);
    }
    while (pages.length && pages.at(-1) == null) pages.pop();
    galleries[gid] = { title: await c.lib.titleOf(gid), pages };
    const chapters = c.series?.includes(gid) ? (await c.lib.raw.seriesChapters(gid)).filter((/** @type {any} */ ch) => ch.entity).map((/** @type {any} */ ch) => ch.id) : [];
    if (chapters.length) galleries[gid].chapters = chapters;
  }
  const aIn = (await c.lib.list()).some(f => f.id === c.ids.A);
  return { listed, galleries, aIn };
}
// A state as the library shows it: the galleries in folders it has (a gallery with no pages counts
// as none: one never written to its folder doesn't outlive the folder's removal; one that comes back
// after its deletion is caught by `deleted`).
const visible = (/** @type {State} */ s, aIn = s.aIn) => ({ aIn, galleries: Object.fromEntries(Object.entries(s.galleries)
  .filter(([, g]) => g.pages.length && (g.place === 'B' || aIn)).map(([gid, g]) => [gid, { title: g.title, pages: g.pages, ...(g.chapters ? { chapters: g.chapters } : {}) }])) });

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
    .map(([gid, g]) => [gid, /** @type {G} */ ({ place: 'B', title: /** @type {string} */ (g.title), pages: /** @type {any} */ (g.pages), ...(g.chapters ? { chapters: g.chapters } : {}) })])) });
  const wanted = valid.map(s => visible(s, aInAlways ? true : s.aIn));
  if (!wanted.some(w => isDeepStrictEqual(w, seen))) problems.push(`it shows ${JSON.stringify(seen)}, neither ${wanted.map(w => JSON.stringify(w)).join(' nor ')}`);
  // SHIORI_SWEEP_TREE=1: what the folders hold then, with each finding.
  if (problems.length && process.env.SHIORI_SWEEP_TREE) problems.push(`the folders hold: ${fs.readdirSync(c.base, { recursive: true }).filter(f => /^[AB][\\/]/.test(String(f))).join(', ')}`);
  return problems.map(p => `${stage}: ${p}`);
}

// What the other app does once the step has ended (the scenario's `met`), once: resolves what went wrong.
async function meet(sc, /** @type {Ctx} */ c) {
  c.met = true;
  try { await within('the other app', sc.met(c)); return []; } catch (e) { return [`the other app: ${/** @type {Error} */ (e).message}`]; }
}

/** The stages after scenario `sc`'s step, with `done` of its operations resolved, each checked; the first
 * that finds something ends it — as does a check that reports a copy of a gallery ('duplicate': one the
 * step left behind for good, as review 5's F3 left a retired folder). A stage may show the state after
 * the last operation that resolved or the next's — or, for a step with a check that joins (`joinsLater`),
 * any of the step's before the stages' own check, and from it on only its last (or one without folder A,
 * until the folder is added again) — or one of the scenario's `also`. Resolves what was wrong.
 * @param {Ctx} c @param {State[]} states @param {number} done */
async function stages(c, sc, states, done) {
  const joinsLater = sc.ops.some(o => o.joinsLater);
  const validAt = (/** @type {string} */ stage) => [...(!joinsLater ? states.slice(done, done + 2) : stage === 'flush' ? states
    : states.filter((s, i) => i === states.length - 1 || (!s.aIn && stage !== 're-add'))), ...(sc.also?.(c, stage) ?? [])];
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
      c.ids.A = await c.lib.add(c.A, { force: !!c.takeBack });
      await c.lib.setDefault(c.ids.A);
      await scanAll();
    }],
  ];
  if (sc.startsAgain && !done) await /** @type {() => Promise<void>} */ (c.lib.restart)();
  if (c.showFirst) await c.lib.show(c.ids.A).catch(() => {});
  if (sc.met && !c.met) { const p = await meet(sc, c); if (p.length) return p; }
  if (c.wrong?.length) return c.wrong.map(w => `step: ${w}`);
  if (c.takeBack && (await c.lib.list()).some(f => f.id === c.ids.A)) await c.lib.raw.folderClaim(c.ids.A).catch(() => {});
  for (const [stage, work] of steps) {
    try { await within(stage, work()); } catch (e) { return [`${stage}: ${/** @type {Error} */ (e).message}`]; }
    const wrong = [...await wrongAt(stage, c, validAt(stage), { aInAlways: stage === 're-add' }),
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
// page is loaded again. Web Locks are the site's, as in a browser (folder-store-web.js withLock, through
// this navigator.locks): one holder of a name at a time across the pages loaded in this process — a page
// loaded again waits for what the one before it still has under way (library-drivers.mjs: it ends) —
// but a page that died holds none: its locks go with it, and what it asks for is never granted.
const deadPages = new Set();
// Every call of a page that died never returns, from now on (fsa.reset, as a library is made, forgets it).
const stillDead = () => fsa.hang(() => deadPages.has(pageCalling()));
/** @type {Map<string, { page: number | null, start: () => void }[]>} lock name → its holder, then who waits */
const lockQueues = new Map();
function grantNext(/** @type {string} */ name) {
  const q = lockQueues.get(name) ?? [];
  while (q.length && deadPages.has(q[0].page)) q.shift();
  if (q.length) q[0].start(); else lockQueues.delete(name);
}
function pageDied(/** @type {number | null} */ page) {
  deadPages.add(page);
  for (const [name, q] of lockQueues) {
    const holder = q[0];
    const left = q.filter(e => e.page !== page);
    lockQueues.set(name, left);
    if (left[0] !== holder) grantNext(name);
  }
}
let locksShadowed = false;
function shadowLocks() {
  if (locksShadowed) return;
  locksShadowed = true;
  const request = (/** @type {string} */ name, /** @type {any} */ options, /** @type {() => unknown} */ fn = options) => new Promise((resolve, reject) => {
    const entry = { page: pageCalling(), start: () => {
      Promise.resolve().then(() => fn()).then(resolve, reject).finally(() => {
        const q = lockQueues.get(name);
        if (q?.[0] !== entry) return;   // let go when its page died
        q.shift();
        grantNext(name);
      });
    } };
    const q = lockQueues.get(name) ?? [];
    lockQueues.set(name, q);
    q.push(entry);
    if (q.length === 1) grantNext(name);
  });
  Object.defineProperty(globalThis.navigator, 'locks', { value: { request }, configurable: true });
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
  await c.other?.close();
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
      // The calls of the page loaded now count (a step may load the page again: a start).
      let died = () => {};
      const death = new Promise((resolve) => { died = resolve; });
      fsa.hang((call) => {
        const page = pageCalling();
        if (page !== pageNow()) return false;
        if (deadPages.has(page)) return true;
        if (!at(call)) return false;
        pageDied(page);
        died();
        return true;
      });
      done = await runOps(sc, c, /** @type {Promise<void>} */ (death));
      if (deadPages.has(pageNow())) {
        // The other app meets the folder before the page is loaded again (`metFirst`).
        const first = sc.met && sc.metFirst ? await meet(sc, c) : [];
        await within('the page loaded again', /** @type {any} */ (c.lib.restart)());
        if (first.length) return first;
      }
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
    return (await stages(c, sc, states, done)).map(p => `(${met || 'no call'}) ${p}`);
  } finally { await finish(c); }
}

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
  /** @type {Ctx} */
  const c = { ...was, lib: /** @type {any} */ ({ app: 'desktop' }), known: new Set(was.known), deleted: new Set(was.deleted), plants: new Map(was.plants) };
  // The other app meets the folder before the desktop starts again (`metFirst`).
  const first = sc.met && sc.metFirst ? await meet(sc, c) : [];
  c.lib = await desktopLibrary(base);
  const met = fs.existsSync(path.join(base, 'met')) ? fs.readFileSync(path.join(base, 'met'), 'utf8') : 'no call';
  try { return (first.length ? first : await stages(c, sc, statesOf(sc, c), done)).map(p => `(${met}) ${p}`); } finally { await finish(c); }
}
// The child's part: set up, saved for the parent, then the step with an exit in its k-th file call.
async function child({ scenario, base, k }) {
  const sc = /** @type {any} */ (SCENARIOS.find(s => s.name === scenario));
  const c = await setUp('desktop', sc, base);
  const save = () => fs.writeFileSync(path.join(base, 'ctx.json'), JSON.stringify({ ...c, lib: null, other: null, known: [...c.known], deleted: [...c.deleted], plants: [...c.plants] }));
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
const only = (/** @type {string} */ name, /** @type {string} */ v) => !process.env[name] || process.env[name].split('|').includes(v);
// The fault points swept out of `count` for a scenario under the kind at `turn` in KINDS: every EVERY-th
// (the shard's), or the sample — one, a fifth of the way into the step, midway or four fifths as the kinds
// turn, so each scenario is faulted early, midway and late across them.
const pointsOf = (/** @type {number} */ count, /** @type {number} */ turn) => {
  const all = Array.from({ length: count }, (_, i) => i + 1);
  if (process.env.SHIORI_SWEEP_POINTS) return process.env.SHIORI_SWEEP_POINTS.split(',').map(Number);
  if (EVERY) return all.filter((k, i) => i % EVERY === 0 && Math.floor(i / EVERY) % SHARDS === SHARD);
  return [all[Math.floor([0.2, 0.5, 0.8][turn % 3] * (count - 1))]].filter(Boolean);
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
        if (!only('SHIORI_SWEEP_SCENARIO', sc.name) || (sc.sample === 0 && !EVERY && !process.env.SHIORI_SWEEP_SCENARIO)) continue;
        test(`${kind}: ${sc.name}`, { skip, todo: TODO[`${app} ${kind}: ${sc.name}`] }, async (t) => {
          if (app === 'website') shadowLocks();
          const count = await callsOf(app, sc);
          const points = pointsOf(count, KINDS[app].indexOf(kind));
          const found = [];
          stuck = 0;
          for (const k of points) for (const p of await once(app, kind, sc, k)) found.push(`call ${k}/${count}: ${p}`);
          t.diagnostic(`${points.length} of ${count} fault points${stuck ? `, ${stuck} where the drive couldn't leave (a file in it open)` : ''}`);
          if (found.length) throw new Error(`${found.length} found:\n  ${found.join('\n  ')}`);
        });
      }
    }
  });
}

// folder-model.test.mjs — model-based fault-injection tests (plan §6.3): fast-check command sequences
// run against each app's library (library-drivers.mjs) over a real library folder, beside a model of
// what it should hold — its galleries, their titles and pages, each slot's bytes, in plain objects —
// with the invariants checked after every command:
// 1. no file Shiori didn't make was changed or deleted (the files planted in the folder compared);
// 2. every committed edit reads back — after a restart, and after the folder is removed and added
//    again — and nothing deleted comes back;
// 3. no page serves another gallery's bytes, and no derived picture sits on a page whose source
//    changed (once the library has checked the folder);
// 4. every refusal or problem is reported, none swallowed: a command refused rejects, and the model
//    stays as it was; one the model has no reason to refuse must not be.
// npm test runs the fixed seeds below, and each long run's findings replayed (REGRESSIONS); a long
// randomized session runs at the end of S8 and before the external review (SHIORI_MODEL_RUNS=<runs>
// SHIORI_MODEL_SEED=<seed>; folder-model-long.mjs runs one, a process per seed).
//
// The commands: add a gallery, write a page or a translation (in either format), retitle, delete; link
// a ZIP put in the folder; flush, check the folder, remove it and add it again, hide and show it; and
// restart (the desktop's; the website's: a page loaded again, library-drivers.mjs), and the person's or
// the disk's doing — a description damaged, a gallery's folder moved away and another put at its path, a
// ZIP's picture changed in place (same name and size), the drive taken away and brought back, a
// translation written while every delete is refused, a PDF put in the folder and drawn — its file
// changed while it is drawn, or the drawing empty — a translation handed back after its page's picture
// changed, a picture of the person's own put in a gallery's folder (and left by its deletion); and
// (S10) the folder's drive given to another library, or a gallery's folder swapped for another's, a
// moment after a write; a gallery's folder renamed, then the gallery deleted; and the desktop's
// archives — an addition cut short and the folder taken over by the website before it was cut back,
// one unpacked by the website while it had the folder taken over, one the person added a file to; and
// (S11) one file call answering "not found" during a write, a retitle or a deletion; and (S30, the shapes of
// the plan's §10) folder A used anyway by the other app or a second desktop library and taken back — a change
// of this app's waiting from the drive's absence, from the moment before it learned, or from the desktop killed
// before the other's take-over; changes on either side, deletions and new galleries there; changes tried here
// meanwhile, refused after a quiet moment, the claim unreadable or the drive away; the drive away throughout,
// back with the folder changed — a gallery's folder moved by hand (within A, or into a second library folder B)
// then changed before a check, the app's own moves between A and B, and a gallery's folder, picture folder or
// .shiori linked elsewhere, a change tried, the link undone.
//
// The base commands find nothing on today's code. The others (OPEN) each run beside them in a run of
// their own, marked todo on an app where they find something today's code gets wrong — with the step
// that fixes it and the finding (plan §5, or N1–N3: found by this harness, plan §10 S2) — until that
// step moves them into the base run.
import test, { describe } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { desktopLibrary, webLibrary, desktopKilled, clockAhead } from './library-drivers.mjs';
import { CLAIM_TTL_MS } from '../js/storage/folder-owner.js';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { zipCreate } from '../js/zip.js';
import { zipEntries } from '../js/zip-read.js';
import { REMOVED_FILE, overlayDir } from '../js/storage/linked-source.js';

// A long run's seed (SHIORI_MODEL_SEED) in place of the fixed ones, and its app alone (SHIORI_MODEL_APP).
export const SEEDS = process.env.SHIORI_MODEL_SEED ? [Number(process.env.SHIORI_MODEL_SEED)] : [1, 2, 3];
const APPS = /** @type {('desktop' | 'website')[]} */ (process.env.SHIORI_MODEL_APP ? [process.env.SHIORI_MODEL_APP] : ['desktop', 'website']);
// Runs per seed of the base commands, and of each finding's (stopped at the first failure: what it
// finds is shown, not shrunk).
const NUM_RUNS = Number(process.env.SHIORI_MODEL_RUNS) || 10;
const FINDING_RUNS = Number(process.env.SHIORI_MODEL_RUNS) || 80;
const MAX_COMMANDS = 14;

/** @typedef {import('./library-drivers.mjs').Driver} Driver */
/** A page as the model has it: its picture's bytes and its translation's (null: none). `changed`: its
 * source changed since it was translated, and the library hasn't checked the folder since: the next
 * check drops the translation. `unchecked`: its source picture changed in place and the library hasn't
 * checked since — a translation put on it meanwhile is bound to the picture the library last read (the
 * page's recorded provenance), so the next check drops it too.
 * @typedef {{ original: Uint8Array, translated: Uint8Array | null, changed?: boolean, unchecked?: boolean }} Page */
/** `app`: the library it was made in (one kept at `home`, or in folder B, is that library's alone). `archived`:
 * the desktop archived it; `edited`: the person then added a file to its archive (it takes no change from the
 * model after: only its deletion). `unfollowed`: its folder moved by hand, within A or into B, and that
 * folder's check hasn't followed it yet (its pages aren't read where the library had them: not compared).
 * `waits`: a change of it waits here (made while its folder isn't where the library has it, or for the
 * take-back).
 * @typedef {{ gid: string, place: 'A' | 'B' | 'home', app: string, title: string, pages: Page[], zip?: string, pdf?: string, displaced?: boolean,
 *   archived?: boolean, edited?: boolean, unfollowed?: 'A' | 'B', waits?: boolean }} Gallery */
/** `app`: the app working on folder A now (the hand-over gives it to the other: `other`).
 * `leaving`: what the deletions in folder A since the last swap leave to do there once they commit (a
 * gallery's folder, a linked gallery's source and gid), for a swap to wait for (settledDeletions).
 * `gone`: galleries the other app deleted while it used folder A anyway — still listed here (a gallery
 * whose folder is gone stays until the person deletes it), none of them compared. `bApp`: the app whose
 * library has folder B (S30: a second library folder), once one added it.
 * @typedef {{ state: 'shown' | 'hidden' | 'away', galleries: Gallery[], deleted: Set<string>, notes: Map<string, Uint8Array>,
 *   restartable: boolean, tag: number, pdfs: string[], app: string, both: boolean,
 *   leaving: { gid: string, dir: string | null, zip?: string }[], gone: Map<string, Gallery>, bApp?: string,
 *   copy?: { at: string, app: string, galleries: Gallery[], notes: string } }} Model */
/** `second`: a second desktop library over the same folders (the desktop app on another computer), made
 * when one first takes folder A over; `B`: folder B's id in the library that has it.
 * @typedef {{ lib: Driver, other: Driver | null, dir: string, A: string, drive: string, id: string, second?: Driver, B?: string }} Real */

// Bytes no other write has: a picture's type, then the write's number (two bytes).
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255]);
const webp = (n) => new Uint8Array([0x52, 0x49, 0x46, 0x46, n >> 8, n & 255]);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const show = (b) => (b ? `[${[...b]}]` : 'nothing');

/** @param {Model} m @param {number} i */
// (A gallery whose archive the person edited only when `edited`: a deletion.)
const galleryAt = (m, i, ok = (/** @type {Gallery} */ g) => true, edited = false) => {
  const list = m.galleries.filter(g => here(m, g) && ok(g) && (edited || !g.edited));
  return list.length ? list[i % list.length] : null;
};
// Whether gallery `g` is in the library of the app working now: in folder A, or kept at its home or in B.
const here = (/** @type {Model} */ m, /** @type {Gallery} */ g) => g.place === 'A' || g.app === m.app;
// Whether gallery `g` can be written to now (its folder shown and there), so a refusal is a fault.
const writable = (/** @type {Model} */ m, /** @type {Gallery} */ g) => !g.displaced && !g.unfollowed && (g.place !== 'A' || m.state === 'shown');
// Folder A removed from the library (the person's Remove): resolves whether it was. A gallery whose
// folder was replaced by hand, with something of it still to be written there — or moved by hand, not
// followed yet, with something waiting, or deleted by the other app with something of it waiting here —
// keeps the removal from ending (the folder stays, and the removal's failure says so), so it may be
// refused then; refused, nothing changes (A is the default again). (A gallery the other app deleted with a file
// of this app's left in its folder — dropped in the window, retiring at its next publication, which never comes —
// keeps the folder at its place, reported as a conflict, and the removal refused until the person deletes it
// here: §8.) Removed, what the other app deleted is forgotten with it, never to come back.
async function removed(/** @type {Model} */ m, /** @type {Real} */ r) {
  const unsaved = m.galleries.some(g => (g.displaced || (g.unfollowed && g.waits)) && here(m, g)) || m.gone.size > 0;
  if (await attempt(unsaved, () => r.lib.remove(r.id))) {
    for (const gid of m.gone.keys()) m.deleted.add(gid);
    m.gone.clear();
    return true;
  }
  await r.lib.setDefault(r.id);
  return false;
}
// Folder `from` renamed to `to`, as the person does: Windows refuses it (EPERM, EBUSY) while a file in it
// is open, and the person tries again a moment later. Resolves whether it was moved.
async function moveAside(/** @type {string} */ from, /** @type {string} */ to) {
  for (let i = 0; i < 20; i++) {
    try { fs.renameSync(from, to); return true; } catch (e) {
      if (!['EPERM', 'EBUSY'].includes(/** @type {any} */ (e)?.code)) throw e;
      await new Promise(done => setTimeout(done, 50));
    }
  }
  return false;
}
// The library has checked folder A (or B: `folder`): what was made from a source picture that changed is
// gone, and a gallery moved by hand into it is followed there.
function checked(/** @type {Model} */ m, folder = 'A') {
  if (folder === 'A') for (const g of m.galleries) for (const p of g.pages) { if (p.changed) p.translated = null; delete p.changed; delete p.unchecked; }
  for (const g of m.galleries) if (g.unfollowed === folder) { delete g.unfollowed; delete g.waits; Object.assign(g, { place: folder, app: m.app }); }
}
// Page `p` translated as `bytes`; page `p` whose source picture changed in place to `bytes`.
/** @param {Page} p @param {Uint8Array} bytes @returns {Page} */
const translatedAs = (p, bytes) => ({ original: p.original, translated: bytes, ...(p.unchecked ? { changed: true, unchecked: true } : {}) });
/** @param {Page} p @param {Uint8Array} bytes @returns {Page} */
const sourceChanged = (p, bytes) => ({ original: bytes, translated: p.translated, changed: p.translated != null || !!p.changed, unchecked: true });
// What the deletions in folder A so far leave to do there ended — a deleted gallery's folder gone; a
// deleted linked gallery's source noted in removed.json and its overlay gone — before a swap: a write
// racing the swap is outside §2, and a deletion's work goes on after it resolves (it commits first). At
// most a few seconds each (a folder holding the person's file stays). S21: one website run of the swaps
// met a removed.json written into the swapped-in copy.
async function settledDeletions(/** @type {Model} */ m, /** @type {Real} */ r) {
  const removed = path.join(r.A, ...REMOVED_FILE.split('/'));
  for (const s of m.leaving.splice(0)) {
    const done = () => (s.zip ? fs.existsSync(removed) && fs.readFileSync(removed, 'utf8').includes(s.zip) && !fs.existsSync(path.join(r.A, ...overlayDir(s.gid).split('/')))
      : !s.dir || !fs.existsSync(s.dir));
    for (const end = Date.now() + 3000; Date.now() < end && !done();) await new Promise(res => setTimeout(res, 25));
  }
}
// `fn()`, rejected only where the model allows a refusal: resolves whether it was done.
async function attempt(/** @type {boolean} */ mayRefuse, /** @type {() => Promise<unknown>} */ fn) {
  try { await fn(); return true; } catch (e) { if (!mayRefuse) throw e; return false; }
}

// ── The invariants ──
/** @param {Model} m @param {Real} r */
async function verify(m, r) {
  const problems = [];
  for (const [file, bytes] of m.notes) {
    const now = fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null;
    if (!same(now, bytes)) problems.push(`1: ${path.relative(r.dir, file)}, a file Shiori didn't make, is ${now ? 'changed' : 'gone'}`);
  }
  const listed = new Set(await r.lib.galleries());
  for (const gid of m.deleted) if (listed.has(gid)) problems.push(`2: gallery ${gid} came back after it was deleted`);
  const expected = m.galleries.filter(g => here(m, g) && !g.displaced && (g.place !== 'A' || m.state !== 'hidden'));
  for (const g of expected) if (!listed.has(g.gid)) problems.push(`2: gallery ${g.gid} is missing`);
  const known = new Set([...m.galleries.map(g => g.gid), ...m.gone.keys()]);
  for (const gid of listed) if (!known.has(gid) && !m.deleted.has(gid)) problems.push(`2: gallery ${gid} joined, put there by nobody`);
  for (const g of expected) {
    if (g.place === 'A' && m.state === 'away') continue;   // its pictures can't be read now
    if (await r.lib.titleOf(g.gid) !== g.title) problems.push(`2: gallery ${g.gid}'s title is ${await r.lib.titleOf(g.gid)}, not ${g.title}`);
    if (g.unfollowed) continue;   // its pictures aren't where the library has them until a check follows it
    for (const [i, p] of g.pages.entries()) {
      const original = await r.lib.read(g.gid, i + 1);
      if (!same(original, p.original)) problems.push(`2/3: gallery ${g.gid} page ${i + 1} shows ${show(original)}, not ${show(p.original)}`);
      if (p.changed) continue;
      const translated = await r.lib.read(g.gid, i + 1, 'translated');
      const want = p.translated ?? p.original;
      if (!same(translated, want)) problems.push(`2/3: gallery ${g.gid} page ${i + 1}'s translation is ${show(translated)}, not ${show(want)}`);
    }
  }
  if (problems.length) throw new Error(`after the commands so far:\n  ${problems.join('\n  ')}`);
}

// ── The commands ──
/** @typedef {{ check(m: Model): boolean, run(m: Model, r: Real): Promise<void>, toString(): string }} Command */
/** A command `name` with arguments drawn from `args`: done to the library and the model alike by
 * `run`, the invariants checked after it (`ms`: how long it may take, where longer than COMMAND_MS).
 * @template A @param {string} name @param {fc.Arbitrary<A>} args
 * @param {{ check?: (m: Model, a: A) => boolean, run: (m: Model, r: Real, a: A) => Promise<void>, ms?: number }} spec
 * @returns {fc.Arbitrary<Command>} */
const command = (name, args, spec) => {
  SPECS.set(name, spec);
  return args.map((a) => step(name, a));
};
/** Command `name` with arguments `a`, as `command` makes it (a regression replays them: REGRESSIONS).
 * @returns {Command} */
function step(/** @type {string} */ name, /** @type {any} */ a) {
  const { check = () => true, run, ms = COMMAND_MS } = /** @type {any} */ (SPECS.get(name));
  return {
    check: (m) => check(m, a),
    async run(m, r) { await within(ms, `${name} never ended`, run(m, r, a)); await verify(m, r); },
    toString: () => `${name}(${JSON.stringify(a)})`,
  };
}
/** @type {Map<string, { check?: (m: Model, a: any) => boolean, run: (m: Model, r: Real, a: any) => Promise<void>, ms?: number }>} */
const SPECS = new Map();
// `work`, failed when it hasn't ended after `ms`. A library left looping on its folder is stopped
// there: every File System Access call fails for a moment (the website's), so the next run starts on
// a library that isn't spinning.
const COMMAND_MS = 10_000;
async function within(/** @type {number} */ ms, /** @type {string} */ what, /** @type {Promise<void>} */ work) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms); });
  try { await Promise.race([work, late]); } catch (e) {
    if (e instanceof Error && e.message === what) { fsa.failNext(() => true, 'InvalidStateError', { times: Infinity }); await new Promise(r => setTimeout(r, 200)); }
    throw e;
  } finally { clearTimeout(timer); }
}
const anyGallery = fc.nat(9);

/** Folder A, Shiori's place for new galleries while it is shown; `home` meanwhile. */
const BASE = {
  newGallery: command('newGallery', fc.integer({ min: 1, max: 2 }), {
    async run(m, r, pages) {
      const place = m.state === 'hidden' ? 'home' : 'A';
      const name = `G${++m.tag}`;
      const gid = await r.lib.newGallery(name);
      /** @type {Gallery} */
      const g = { gid, place, app: m.app, title: name, pages: [] };
      m.galleries.push(g);
      for (let n = 1; n <= pages; n++) {
        const bytes = png(++m.tag);
        if (await attempt(m.state === 'away', () => r.lib.putPage(gid, n, bytes))) g.pages.push({ original: bytes, translated: null });
      }
    },
  }),
  putPage: command('putPage', fc.tuple(anyGallery, fc.nat(1)), {
    check: (m, [i]) => !!galleryAt(m, i, g => !g.zip && !g.pdf && g.pages.length > 0),
    async run(m, r, [i, k]) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => !g.zip && !g.pdf && g.pages.length > 0));
      const n = (k % g.pages.length) + 1, bytes = png(++m.tag);
      // A page stored again is a new picture: its translation goes with the old one (both libraries).
      if (await attempt(!writable(m, g), () => r.lib.putPage(g.gid, n, bytes))) g.pages[n - 1] = { original: bytes, translated: null };
    },
  }),
  putTranslation: command('putTranslation', fc.tuple(anyGallery, fc.nat(1), fc.boolean()), {
    check: (m, [i]) => !!galleryAt(m, i, g => g.pages.length > 0),
    async run(m, r, [i, k, inWebp]) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => g.pages.length > 0));
      const n = (k % g.pages.length) + 1, bytes = (inWebp ? webp : png)(++m.tag);
      if (await attempt(!writable(m, g), () => r.lib.putTranslation(g.gid, n, bytes, inWebp ? 'image/webp' : 'image/png'))) {
        g.pages[n - 1] = translatedAs(g.pages[n - 1], bytes);
      }
    },
  }),
  setTitle: command('setTitle', anyGallery, {
    check: (m, i) => !!galleryAt(m, i),
    async run(m, r, i) {
      const g = /** @type {Gallery} */ (galleryAt(m, i));
      const name = `T${++m.tag}`;
      if (await attempt(!writable(m, g), () => r.lib.setTitle(g.gid, name))) g.title = name;
    },
  }),
  deleteGallery: command('deleteGallery', anyGallery, {
    check: (m, i) => !!galleryAt(m, i, undefined, true),
    async run(m, r, i) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, undefined, true));
      const dir = g.place === 'A' ? await r.lib.dirOf(g.gid) : null;
      if (!(await attempt(!writable(m, g), () => r.lib.deleteGallery(g.gid)))) return;
      m.galleries = m.galleries.filter(x => x !== g);
      m.deleted.add(g.gid);
      if (g.place === 'A') m.leaving.push({ gid: g.gid, dir, zip: g.zip });
    },
  }),
  link: command('link', fc.constant(null), {
    check: (m) => m.state === 'shown',
    async run(m, r) {
      const name = `Pack ${++m.tag}.zip`, pages = [png(++m.tag), png(++m.tag)];
      fs.writeFileSync(path.join(r.A, name), zipCreate(pages.map((data, i) => ({ name: `00${i + 1}.png`, data }))));
      const before = new Set(await r.lib.galleries());
      await r.lib.scan(r.id);
      checked(m);   // a check of the whole folder: every source read again (S30: the model forgot it)
      const gid = (await r.lib.galleries()).find(x => !before.has(x));
      if (!gid) throw new Error(`${name} didn't join the library`);
      m.galleries.push({ gid, place: 'A', app: m.app, title: await r.lib.titleOf(gid) ?? '', zip: name, pages: pages.map(original => ({ original, translated: null })) });
    },
  }),
  flush: command('flush', fc.constant(null), { async run(m, r) { await r.lib.flush(); } }),
  scan: command('scan', fc.constant(null), {
    check: (m) => m.state === 'shown',
    async run(m, r) {
      await r.lib.scan(r.id);
      checked(m);
    },
  }),
  readd: command('readd', fc.constant(null), {
    check: (m) => m.state === 'shown',
    async run(m, r) {
      await r.lib.setDefault(r.lib.home);
      if (!(await removed(m, r))) return;
      r.id = await r.lib.add(r.A);
      await r.lib.setDefault(r.id);
      await r.lib.scan(r.id);
      m.galleries = m.galleries.filter(g => !g.displaced);
      checked(m);
    },
  }),
  hide: command('hide', fc.constant(null), {
    check: (m) => m.state === 'shown',
    async run(m, r) { await r.lib.setDefault(r.lib.home); await r.lib.hide(r.id); m.state = 'hidden'; },
  }),
  show: command('show', fc.constant(null), {
    check: (m) => m.state === 'hidden',
    async run(m, r) { await r.lib.show(r.id); await r.lib.setDefault(r.id); m.state = 'shown'; },
  }),
};

// The folder handed to the other app (plan §6.3): this one removes it — first writing there what only
// it has (§3.4's write-back) — and the other adds it and checks it. Every gallery there reads whole in
// the other app, whose library the commands after work on (a gallery kept at an app's home stays in
// that app's alone); handed back, likewise.
const handOver = command('handOver', fc.constant(null), {
  check: (m) => m.both && m.state === 'shown',
  async run(m, r) {
    const from = r.lib, to = /** @type {Driver} */ (r.other);
    await from.setDefault(from.home);
    if (!(await removed(m, r))) return;
    r.id = await to.add(r.A);
    await to.setDefault(r.id);
    await to.scan(r.id);
    r.lib = to; r.other = from; m.app = to.app;
    m.galleries = m.galleries.filter(g => !g.displaced);
    checked(m);
  },
});
// A gallery of the library's own in folder A, with pages, in a folder of its own there.
const inFolder = (/** @type {Gallery} */ g) => g.place === 'A' && !g.zip && !g.pdf && !g.displaced && !g.archived && !g.unfollowed && g.pages.length > 0;
// Every file in folder `dir` and its folders (their paths).
function filesIn(/** @type {string} */ dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesIn(p)); else out.push(p);
  }
  return out;
}
// Gallery `g` archived by the desktop now: its archive's path, or null when it wasn't (one in use stays a
// folder).
async function archived(/** @type {Real} */ r, /** @type {Gallery} */ g) {
  await r.lib.flush();
  if (!(await r.lib.raw.archiveGallery(g.gid)).archived.includes(g.gid)) return null;
  g.archived = true;
  return r.lib.raw.files._abs(r.lib.raw._s('SELECT path FROM files WHERE gid = ?').get(g.gid).path);
}
// Folder A taken over by the website ("Use anyway") while the desktop holds it, `work(web)` done there,
// then given back: the website removes it (its write-back), and the desktop holds it again.
async function takenOverBriefly(/** @type {Real} */ r, /** @type {(web: Driver) => Promise<void>} */ work) {
  const web = /** @type {Driver} */ (r.other);
  const id = await web.add(r.A, { force: true });
  await web.scan(id);
  try { await work(web); } finally {
    await web.setDefault(web.home);
    await web.remove(id);
    await r.lib.raw.folderClaim(r.id);
  }
}

// ── The shapes (S30, plan §10's list): two apps on one folder, a second library, the person's edit then work ──
// The quiet moments (a claim's time to live passing: clockAhead) one process moves its clock on by, at most:
// a leftover sweep tells a file's age by the clock, and the youngest it takes is ten minutes old.
const QUIET_AT_MOST = 120_000;
let quiet = 0;
const quietly = () => { if (quiet + CLAIM_TTL_MS > QUIET_AT_MOST) return; quiet += CLAIM_TTL_MS; clockAhead(CLAIM_TTL_MS); };
const pause = (/** @type {number} */ ms) => new Promise(done => setTimeout(done, ms));
/** The first of `list` that `ok` takes, counted from `i`. @template T @param {T[]} list @param {number} i @param {(x: T) => boolean} ok */
const pick = (list, i, ok) => { const l = list.filter(ok); return l.length ? l[i % l.length] : null; };
// Change `what` (a title, page `n` replaced, page `n` translated) of gallery `g` made through library `lib`,
// and the same in `g` (the model's, or a copy of it): resolves whether `lib` took it — a refusal thrown unless
// `mayRefuse`.
async function change(/** @type {Model} */ m, /** @type {Driver} */ lib, /** @type {Gallery} */ g, /** @type {string} */ what, /** @type {number} */ n, mayRefuse = false) {
  const bytes = png(++m.tag), name = `T${m.tag}`, k = n % g.pages.length;
  const work = { title: () => lib.setTitle(g.gid, name), page: () => lib.putPage(g.gid, k + 1, bytes), translation: () => lib.putTranslation(g.gid, k + 1, bytes) }[what];
  if (!(await attempt(mayRefuse, /** @type {() => Promise<void>} */ (work)))) return false;
  if (what === 'title') g.title = name;
  else if (what === 'page') g.pages[k] = { original: bytes, translated: null };
  else g.pages[k] = translatedAs(g.pages[k], bytes);
  return true;
}
// What library `lib` shows of gallery `g` now: its title and pages (as many as `g` has), as the model holds them.
async function viewOf(/** @type {Driver} */ lib, /** @type {Gallery} */ g) {
  const pages = [];
  for (let k = 1; k <= g.pages.length; k++) {
    const original = await lib.read(g.gid, k), translated = await lib.read(g.gid, k, 'translated');
    pages.push({ original: /** @type {Uint8Array} */ (original), translated: same(translated, original) ? null : translated });
  }
  return { title: /** @type {string} */ (await lib.titleOf(g.gid)), pages };
}
// Whether two galleries' titles and pages are alike, byte for byte.
const sameView = (/** @type {{ title: string, pages: Page[] }} */ a, /** @type {{ title: string, pages: Page[] }} */ b) => a.title === b.title && a.pages.length === b.pages.length
  && a.pages.every((p, i) => same(p.original, b.pages[i].original) && (p.translated ? same(p.translated, b.pages[i].translated) : !b.pages[i].translated));
// The app that uses folder A anyway: the other (the website for the desktop, the desktop for the website), or
// for the desktop a second desktop library — the desktop app on another computer — made the first time.
async function taker(/** @type {Real} */ r, /** @type {string} */ by) {
  if (by !== 'second desktop' || r.lib.app !== 'desktop') return /** @type {Driver} */ (r.other);
  r.second ??= await desktopLibrary(path.join(r.dir, 'desktop 2'), { me: 'c0ffee00c0ffee00' });
  return r.second;
}
// Folder A used anyway by another app (`by`) while this one holds it, then taken back — the owner's rule of
// 2026-11-15 (plan §3.4): while the other app holds the folder, a gallery it holds is read-only here once this
// app has learned of it; at the take-back a change of this app's still waiting from before is published where
// the other app changed nothing of that gallery, and dropped where it did (the folder's version stands);
// what the other app made joins, and a gallery it deleted is gone here (listed while it is, until the person
// deletes it: `gone`). `mine`: a change of this app's waiting as the take-over comes — made while the drive is
// away, in the moment before this app learns of the take-over (the window: accepted, or refused had it read
// the claim), or as the desktop is killed (its change made, or not: read back) and started again only after
// the other app let go — or a deletion of a gallery whose folder's deletes are refused, so it is still owed
// (done at the take-back where the other app changed nothing of it, dropped where it did: the gallery back as
// the folder has it). `unseen`: the drive away here the whole time, the folder back changed (a newer copy).
// `theirs`: what the other app does there; `tries`: changes tried here after learning of it — each refused,
// a quiet moment, the claim unreadable or the drive away before it; `made`: a gallery made here meanwhile
// (only this app has it: it works, and waits).
const usedAnyway = command('usedAnyway', fc.record({
  by: fc.constantFrom('other', 'second desktop'),
  mine: fc.option(fc.tuple(anyGallery, fc.constantFrom('title', 'page', 'translation', 'delete'), fc.nat(1), fc.constantFrom('away', 'window', 'killed'), fc.integer({ min: 1, max: 40 }))),
  unseen: fc.boolean(),
  theirs: fc.array(fc.tuple(anyGallery, fc.constantFrom('title', 'page', 'translation', 'delete', 'new'), fc.nat(1)), { maxLength: 3 }),
  tries: fc.array(fc.tuple(anyGallery, fc.constantFrom('title', 'page', 'translation', 'delete'), fc.nat(1), fc.constantFrom('at once', 'a quiet moment', 'the claim unreadable', 'the drive away')), { maxLength: 2 }),
  made: fc.boolean(),
  // S32: changes and series commands asked at once after "Take back", before its hand-over's check has read the
  // folder — each refused for now ('handover').
  atOnce: fc.array(fc.tuple(anyGallery, fc.constantFrom('title', 'page', 'translation', 'delete', 'series'), fc.nat(1)), { maxLength: 2 }),
}), {
  check: (m) => m.both && m.state === 'shown',
  ms: 60_000,
  async run(m, r, a) {
    let mode = a.mine?.[1] === 'delete' ? 'deletes refused' : a.mine?.[3];
    // (Its folder's deletes refused for this app alone: the other kind of app takes the folder.)
    const by = await taker(r, mode === 'deletes refused' ? 'other' : a.by);
    await r.lib.flush();   // what this app had waiting is in the folder: the take-back weighs only what follows
    await settledDeletions(m, r);
    const inA = m.galleries.filter(g => g.place === 'A' && here(m, g) && !g.displaced && !g.unfollowed && !g.pdf && !g.edited && g.pages.length > 0);
    const base = new Map(inA.map(g => [g.gid, structuredClone(g)]));   // each as the folder has it
    if (mode === 'killed' && r.lib.app !== 'desktop') mode = 'away';
    if (a.unseen && mode === 'window') mode = 'away';
    const mineOn = a.mine && pick(inA, a.mine[0], g => !(g.zip && (a.mine?.[1] === 'page' || a.mine?.[1] === 'delete')));
    let killed = null;   // the change the killed desktop made, or not: read back at the end
    // A deletion owed: its folder's deletes refused until the take-back — a deletion retried as the other app
    // takes the folder over, before this app has learned of it, is §8's advisory claim (S30: it raced the other
    // app's check), not this shape.
    let deletesBack = () => {};
    if (mineOn && mode === 'deletes refused') {
      const inside = r.A.split(path.sep).join('/').toLowerCase();
      deletesBack = r.lib.app === 'website' ? fsa.failNext((c) => c.op === 'removeEntry', 'NoModificationAllowedError', { times: Infinity })
        : faults.failNext((c) => ['rm', 'unlink', 'rmdir'].includes(c.op) && c.path.toLowerCase().startsWith(inside), 'EBUSY', { times: Infinity });
      await r.lib.deleteGallery(mineOn.gid);
      await r.lib.flush().catch(() => {});
      m.galleries = m.galleries.filter(x => x !== mineOn);   // gone from the library at once: its folder's deletion owed
    }
    if (a.unseen || (mineOn && mode === 'away')) fs.rmdirSync(r.A);   // the drive away
    if (mineOn && mode === 'away') {
      if (await change(m, r.lib, mineOn, a.mine[1], a.mine[2], true)) mineOn.waits = true;
      await r.lib.flush().catch(() => {});   // what it can't write waits
      if (!a.unseen) faults.junction(r.drive, r.A);
    }
    if (mineOn && mode === 'killed') {
      const [what, n, k] = [a.mine[1], a.mine[2] % mineOn.pages.length, a.mine[4]], bytes = png(++m.tag), title = `T${++m.tag}`;
      await r.lib.close();
      desktopKilled(path.join(r.dir, 'desktop'), async ({ lib, kill, gid, what, n, bytes, title, k }) => {
        let calls = 0;
        kill(() => ++calls === k);
        if (what === 'title') await lib.setTitle(gid, title);
        else if (what === 'page') await lib.putPage(gid, n + 1, new Uint8Array(bytes));
        else await lib.putTranslation(gid, n + 1, new Uint8Array(bytes));
        await lib.flush();
      }, { gid: mineOn.gid, what, n, bytes: [...bytes], title, k });
      killed = { what, n, bytes, title };
    }
    // What a library shows of the killed change: resolves whether it shows it.
    const showsKilled = async (/** @type {Driver} */ lib) => (!killed || !mineOn ? false : killed.what === 'title' ? (await lib.titleOf(mineOn.gid)) === killed.title
      : same(await lib.read(mineOn.gid, killed.n + 1, killed.what === 'translation' ? 'translated' : undefined), killed.bytes));
    const theirsAt = await by.add(a.unseen ? r.drive : r.A, { force: true });   // "Use anyway"
    await by.setDefault(theirsAt);
    await by.scan(theirsAt);
    // The killed change in the folder already (published before the kill): the folder's version has it.
    const applyKilled = (/** @type {Gallery} */ g) => {
      if (!killed) return;
      if (killed.what === 'title') g.title = killed.title;
      else if (killed.what === 'page') g.pages[killed.n] = { original: killed.bytes, translated: null };
      else g.pages[killed.n] = translatedAs(g.pages[killed.n], killed.bytes);
    };
    if (killed && mineOn && await showsKilled(by)) { applyKilled(/** @type {Gallery} */ (base.get(mineOn.gid))); applyKilled(mineOn); }
    /** @type {{ what: string, k: number, title: string, page: Page } | null} */
    let inWindow = null;   // the change accepted here in the window, as made
    if (mineOn && mode === 'window') {
      if (await change(m, r.lib, mineOn, a.mine[1], a.mine[2], true)) {
        mineOn.waits = true;
        const k = a.mine[2] % mineOn.pages.length;
        inWindow = { what: a.mine[1], k, title: mineOn.title, page: structuredClone(mineOn.pages[k]) };
      }
      await r.lib.flush().catch(() => {});
    }
    /** @type {Map<string, Gallery | null>} */
    const touched = new Map();   // gid → the folder's version as the other app changes it (deleted: null)
    /** @type {Gallery[]} */
    const news = [];
    for (const [i, what, n] of a.theirs) {
      if (what === 'new') {
        const title = `G${++m.tag}`, bytes = png(++m.tag);
        const gid = await by.newGallery(title);
        await by.putPage(gid, 1, bytes);
        news.push({ gid, place: 'A', app: m.app, title, pages: [{ original: bytes, translated: null }] });
        continue;
      }
      const g = pick(inA, i, g => touched.get(g.gid) !== null && !(g.zip && (what === 'page' || what === 'delete')));
      if (!g) continue;
      if (what === 'delete') { await by.deleteGallery(g.gid); touched.set(g.gid, null); continue; }
      const t = touched.get(g.gid) ?? structuredClone(/** @type {Gallery} */ (base.get(g.gid)));
      await change(m, by, t, what, n);
      touched.set(g.gid, t);
    }
    await by.flush();
    // This app's change in the window may have reached the folder before the other app changed that gallery
    // (a write isn't stopped the instant the folder is taken: §8's advisory claim) — then the other app's change
    // met a newer generation and was dropped there (one app changes a folder's galleries at a time), and the
    // folder's newest generation is this app's, whose waiting rest is published at the take-back; else the other
    // app's change stands. Either way both apps end showing the same: what the other app shows of it now, or this
    // app's change (the take-back below tells which, by what this app shows).
    const raced = mineOn && mode === 'window' && mineOn.waits && touched.get(mineOn.gid) ? /** @type {Gallery} */ (touched.get(mineOn.gid)) : null;
    if (raced) Object.assign(raced, await viewOf(by, raced));
    if (!a.unseen && !killed) {
      await r.lib.list();   // the person sees the folder used elsewhere: this app has learned of it
      for (const [i, what, n, how] of a.tries) {
        const g = pick(inA, i, g => m.galleries.includes(g) && !(g.zip && (what === 'page' || what === 'delete')));
        if (!g) continue;
        let undo = () => {};
        if (how !== 'at once') quietly();
        if (how === 'the claim unreadable') {
          undo = r.lib.app === 'desktop' ? faults.failNext((c) => /\/owner\.json$/.test(c.path) && c.op === 'readFile', 'EIO', { times: Infinity })
            : fsa.failNext((c) => /owner\.json$/.test(c.path) && c.op === 'getFile', 'NotReadableError', { times: Infinity });
        }
        if (how === 'the drive away') { fs.rmdirSync(r.A); undo = () => faults.junction(r.drive, r.A); }
        try {
          const e = await (what === 'delete' ? r.lib.deleteGallery(g.gid) : change(m, r.lib, structuredClone(g), what, n)).then(() => null, (e) => e);
          if (!e) throw new Error(`${what} of gallery ${g.gid} accepted while the other app holds folder A (${how})`);
          if (!['not-owned', 'unavailable'].includes(e?.reason)) throw e;
        } finally { undo(); }
      }
    }
    if (a.made && !killed) {
      const title = `G${++m.tag}`, bytes = png(++m.tag);
      const gid = await r.lib.newGallery(title);
      await r.lib.putPage(gid, 1, bytes);
      m.galleries.push({ gid, place: 'A', app: m.app, title, pages: [{ original: bytes, translated: null }] });
    }
    await by.setDefault(by.home);
    // It lets go, what it changed written there first — refused while a change of a gallery it holds waits for a
    // place gone meanwhile (this app's unpack of it in the window: §8, a removal with a moved gallery's change
    // waiting): a check follows it there, then the removal goes on.
    await by.remove(theirsAt).catch(async (e) => {
      if (e?.errorKey !== 'lf.task_kept') throw e;
      await by.scan(theirsAt);
      await by.flush();
      await by.remove(theirsAt);
    });
    if (a.unseen) faults.junction(r.drive, r.A);   // the drive back
    if (killed) await /** @type {() => Promise<void>} */ (r.lib.restart)();   // the desktop starts again
    const back = await r.lib.raw.folderClaim(r.id);   // "Take back"
    deletesBack();
    if (back !== 'granted') throw new Error(`folder A taken back: ${back}`);
    // S32: asked at once, before the hand-over's check has read the folder — refused for now, nothing of it made.
    for (const [i, what, n] of a.atOnce ?? []) {
      const g = pick(inA, i, g => m.galleries.includes(g) && !(g.zip && (what === 'page' || what === 'delete')));
      const with2 = inA.find(x => x !== g && m.galleries.includes(x));
      if (!g || (what === 'series' && !with2)) continue;
      const asked = what === 'delete' ? r.lib.deleteGallery(g.gid)
        : what === 'series' ? r.lib.raw.seriesCommand('write', g.gid, [{ id: g.gid, title: 'One' }, { id: with2?.gid, title: 'Two' }], { seriesTitle: { english: `S${++m.tag}`, japanese: '', pretty: '' } })
          : change(m, r.lib, structuredClone(g), what, n);
      const e = await asked.then(() => null, (x) => x);
      if (e?.reason !== 'handover') throw new Error(`${what} of gallery ${g.gid} asked at once after "Take back": ${e ? e.reason || e.message : 'accepted'}, not refused for now`);
    }
    await r.lib.flush();
    await r.lib.scan(r.id);
    await r.lib.flush();
    await r.lib.scan(r.id);   // the next check: a deletion dropped where a check met the gallery joins it again then
    checked(m);
    // S31: a change of this app's accepted here — waiting from the drive's absence, or a deletion owed — that the
    // folder's version replaced (the other app changed that gallery) is reported dropped, never lost unsaid.
    const reported = new Set((await r.lib.list()).find(f => f.id === r.id)?.attention?.filter((/** @type {any} */ x) => x.reason === 'changed-both').map((/** @type {any} */ x) => String(x.gid)) ?? []);
    for (const g of inA) {
      const t = touched.get(g.gid);
      if (g === mineOn && t && (mode === 'deletes refused' || (mode === 'away' && g.waits)) && !reported.has(g.gid)) {
        throw new Error(`gallery ${g.gid}'s ${a.mine?.[1]} here, replaced by the folder's version at the take-back, isn't reported dropped`);
      }
    }
    for (const g of inA) {
      const t = touched.get(g.gid), waited = !!g.waits || (!!killed && g === mineOn);
      delete g.waits;
      if (mode === 'deletes refused' && g === mineOn) {
        // The deletion still owed: done where the other app changed nothing of it (or deleted it too); dropped
        // where it changed it — the gallery back as the folder has it (S29a's rule 3).
        if (t) { Object.assign(g, { title: t.title, pages: t.pages }); if (by.app === 'website') delete g.archived; m.galleries.push(g); }
        else m.deleted.add(g.gid);
      } else if (t === undefined || (!!raced && t === raced && sameView(await viewOf(r.lib, g), g) && !sameView(g, raced))) {
        // The other app changed nothing of it — or its change was dropped there for this app's, which reached the
        // folder first (the window: `raced`): what waited here is in the folder (a killed change, if made).
        if (killed && g === mineOn && await showsKilled(r.lib)) applyKilled(g);
      } else if (t === null) {
        // Deleted there: gone here, what waited for it waiting still (the removal may be refused for it).
        m.galleries = m.galleries.filter(x => x !== g);
        m.gone.set(g.gid, { ...g, waits: waited });
      } else {
        Object.assign(g, { title: t.title, pages: t.pages });   // the folder's version stands
        if (by.app === 'website') delete g.archived;   // the website's change of an archived gallery unpacked it
      }
    }
    m.galleries.push(...news);
    // The website reads another app's generation of a gallery it is busy with (a change of a moment ago, a
    // publication of it due) at a later check (plan §8, S26a): checked again until it does, for at most 10 s.
    for (const end = Date.now() + 10_000; r.lib.app === 'website' && Date.now() < end;) {
      if (await verify(m, r).then(() => true, () => false)) break;
      await pause(250);
      await r.lib.scan(r.id);
    }
    // S31 (review 8, R8-3): a change accepted here in the window — published at once, or waiting — is at the end in
    // the folder's version, or reported dropped here; never lost unsaid (the other app's change made from a view
    // older than the folder's, over it: R8-3, where both apps agreed on losing it).
    if (inWindow && mineOn && touched.get(mineOn.gid) !== null && m.galleries.includes(mineOn)) {
      const now = await viewOf(r.lib, mineOn), p = now.pages[inWindow.k];
      const kept = inWindow.what === 'title' ? now.title === inWindow.title
        : inWindow.what === 'page' ? same(p?.original, inWindow.page.original) : same(p?.translated, inWindow.page.translated);
      const dropped = (await r.lib.list()).find(f => f.id === r.id)?.attention?.some((/** @type {any} */ x) => x.reason === 'changed-both' && String(x.gid) === mineOn.gid);
      if (!kept && !dropped) throw new Error(`gallery ${mineOn.gid}'s ${inWindow.what} accepted here before this app learned of the take-over is neither in the folder's version nor reported dropped`);
    }
  },
});
// A gallery the other app deleted while it used folder A anyway, deleted here too (the person deletes it).
const forgetGone = command('forgetGone', anyGallery, {
  check: (m) => m.gone.size > 0 && m.state === 'shown',
  async run(m, r, i) {
    const g = [...m.gone.values()][i % m.gone.size];
    await r.lib.deleteGallery(g.gid);
    m.gone.delete(g.gid);
    m.deleted.add(g.gid);
  },
});
// ── S31: an index an earlier version left, and a folder put back from an older copy ──
// This app's stamp of gallery `gid` (the token of the publication it last read or made there), or null; `put`
// writes it (null: takes it away), as the index keeps it.
async function stampOf(/** @type {Driver} */ lib, /** @type {string} */ gid) {
  if (lib.app === 'desktop') return lib.raw._s('SELECT stamp FROM stamps WHERE gid = ?').get(gid)?.stamp ?? null;
  return (await galleriesStore((store) => store.get(gid)))?.stamp ?? null;
}
async function putStamp(/** @type {Driver} */ lib, /** @type {string} */ gid, /** @type {string | null} */ stamp) {
  if (lib.app === 'desktop') {
    if (stamp == null) lib.raw._s('DELETE FROM stamps WHERE gid = ?').run(gid);
    else lib.raw._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(gid, stamp);
    return;
  }
  await galleriesStore((store) => {
    const got = store.get(gid);
    got.onsuccess = () => { if (!got.result) return; const { stamp: _, ...rest } = got.result; store.put(stamp == null ? rest : { ...rest, stamp }); };
    return got;
  }, 'readwrite');
}
// `fn(store)` on the website's galleries store (its stat records), in a transaction of its own: resolves the
// result of the request it returns.
async function galleriesStore(/** @type {(store: any) => any} */ fn, mode = 'readonly') {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('shiori-cache'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  try {
    return await new Promise((res, rej) => {
      const tx = /** @type {any} */ (db).transaction('galleries', mode);
      const req = fn(tx.objectStore('galleries'));
      tx.oncomplete = () => res(req?.result);
      tx.onerror = () => rej(tx.error);
    });
  } finally { /** @type {any} */ (db).close(); }
}
// The manifests folder A holds as files (a gallery's folder's, a linked gallery's overlay's): their paths.
const manifestsIn = (/** @type {string} */ dir) => filesIn(dir).filter(f => /[\\/]\.shiori[\\/](linked[\\/][^\\/]+[\\/])?gallery\.json$/.test(f) && !/[\\/]staging[\\/]/.test(f));
// The index this app keeps of folder A's galleries as an earlier version left it, the app started from it, and
// the folder checked: 'S30' (146199d: manifests naming no publication, stamps of their generation and writer alone
// — a publication's id came with S31, and a manifest without one keeps its token, rule 1) or 'no stamps' (an index
// from before stamps, with the manifests as they are). Nothing it shows changes, nothing is reported, and the
// commands after (a take-over among them) go on from there.
const earlierIndex = command('earlierIndex', fc.constantFrom('S30', 'no stamps'), {
  check: (m) => m.state === 'shown' && !m.galleries.some(g => g.waits || g.displaced || g.unfollowed) && m.gone.size === 0,
  async run(m, r, form) {
    await r.lib.flush();
    await settledDeletions(m, r);
    const dropped = async () => (await r.lib.list()).find(f => f.id === r.id)?.attention?.filter((/** @type {any} */ x) => x.reason === 'changed-both') ?? [];
    const before = (await dropped()).length;
    const { parseManifest, manifestText, tokenOf } = await import('../js/storage/gallery-manifest.js');
    for (const file of manifestsIn(r.A)) {
      const read = parseManifest(fs.readFileSync(file, 'utf8'));
      if (read.kind !== 'ok') continue;
      const gid = read.value.galleryId, stamp = await stampOf(r.lib, gid);
      if (form === 'no stamps') { await putStamp(r.lib, gid, null); continue; }
      if (stamp !== tokenOf(read.value) || read.value.publication == null) continue;
      const old = { ...read.value, publication: undefined };
      fs.writeFileSync(file, manifestText(old));
      await putStamp(r.lib, gid, tokenOf(old));
    }
    if (r.lib.restart) await r.lib.restart();
    await r.lib.scan(r.id);
    await r.lib.flush();
    const reported = await dropped();
    if (reported.length > before) throw new Error(`the earlier index (${form}) dropped a change: ${JSON.stringify(reported)}`);
    checked(m);
  },
});
// Folder A copied by the person (`copyA`) and the copy put back in its place later (`putBack`), as one restores
// a folder from a backup, while this app holds it: what the copy holds is the folder's version — each gallery
// reads as the copy has it once a check reads it (rule 1: a publication the copy names is never taken for the
// one this app read since, though its number may come again) — and a change after goes on from there. (Only where
// the galleries of A are the same ones, as they were — none archived since, no file of the person's added, no
// PDF — so the copy differs in what galleries say alone.)
const copyA = command('copyA', fc.constant(null), {
  check: (m) => m.state === 'shown' && !m.copy && m.pdfs.length === 0,
  async run(m, r) {
    await r.lib.flush();
    await settledDeletions(m, r);
    const copy = `${r.drive} copy ${++m.tag}`;
    fs.cpSync(r.drive, copy, { recursive: true, preserveTimestamps: true });
    m.copy = { at: copy, app: m.app, galleries: structuredClone(m.galleries.filter(g => g.place === 'A')), notes: [...m.notes.keys()].sort().join('\n') };
  },
});
const putBack = command('putBack', fc.constant(null), {
  check: (m) => {
    if (m.state !== 'shown' || !m.copy || m.copy.app !== m.app || m.pdfs.length > 0 || m.gone.size > 0) return false;
    const now = m.galleries.filter(g => g.place === 'A');
    const then = new Map(m.copy.galleries.map(g => [g.gid, g]));
    return now.length === then.size && now.every(g => then.has(g.gid) && !!then.get(g.gid)?.archived === !!g.archived && !g.edited && !g.waits && !g.displaced && !g.unfollowed)
      && [...m.notes.keys()].sort().join('\n') === m.copy.notes;
  },
  ms: 30_000,
  async run(m, r) {
    const copy = /** @type {NonNullable<Model['copy']>} */ (m.copy);
    m.copy = undefined;
    await r.lib.flush();
    await settledDeletions(m, r);
    const aside = `${r.drive} newer ${++m.tag}`;
    if (!(await moveAside(r.drive, aside))) { fs.rmSync(copy.at, { recursive: true, force: true }); return; }
    fs.renameSync(copy.at, r.drive);
    fs.rmSync(aside, { recursive: true, force: true });
    const then = new Map(copy.galleries.map(g => [g.gid, g]));
    for (const g of m.galleries) {
      const was = then.get(g.gid);
      if (g.place === 'A' && was) Object.assign(g, { title: was.title, pages: was.pages });
    }
    await r.lib.scan(r.id);
    await r.lib.flush();
    checked(m);
    // The website reads the folder's version of a gallery it is busy with (a change of a moment ago) at a later
    // check (plan §8, S26a): checked again until it has read every one there — its stamp the copy's publication —
    // for at most 10 s. (A change of one made before it has is dropped, reported: the folder's version stands.)
    const { parseManifest, tokenOf } = await import('../js/storage/gallery-manifest.js');
    const unread = async () => {
      for (const file of manifestsIn(r.A)) {
        const read = parseManifest(fs.readFileSync(file, 'utf8'));
        if (read.kind === 'ok' && m.galleries.some(g => g.gid === read.value.galleryId) && await stampOf(r.lib, read.value.galleryId) !== tokenOf(read.value)) return true;
      }
      return false;
    };
    for (const end = Date.now() + 10_000; await unread() && Date.now() < end;) {
      await pause(250);
      await r.lib.scan(r.id);
      await r.lib.flush();
    }
  },
});

// A gallery of folder A archived by the desktop (then read in place by the website when it uses the folder).
const archiveIt = command('archiveIt', anyGallery, {
  check: (m, i) => m.app === 'desktop' && m.state === 'shown' && !!galleryAt(m, i, inFolder),
  async run(m, r, i) { await archived(r, /** @type {Gallery} */ (galleryAt(m, i, inFolder))); },
});
// Folder B, another of the library's folders, added once (by the app working now).
async function folderB(/** @type {Model} */ m, /** @type {Real} */ r) {
  if (r.B) return;
  r.B = await r.lib.add(path.join(r.dir, 'B'));
  m.bApp = m.app;
}
// The person moves a gallery's folder by hand — renamed beside itself in A, or into folder B — then, before
// any check, a change of it is made (it waits: its folder isn't where the library has it; always, into B: A's
// removal before B's check would otherwise forget it), or none. Followed by the next check of the folder it is
// in, what waited going there (review 7 B5, B3).
const movedByHand = command('movedByHand', fc.tuple(anyGallery, fc.constantFrom('A', 'B'), fc.constantFrom('none', 'title', 'page', 'translation'), fc.nat(1)), {
  check: (m, [i, into]) => m.state === 'shown' && !!galleryAt(m, i, inFolder) && (into === 'A' || !m.bApp || m.bApp === m.app),
  async run(m, r, [i, into, what, n]) {
    const g = /** @type {Gallery} */ (galleryAt(m, i, inFolder));
    await r.lib.flush();   // its folder made, what it has published
    await settledDeletions(m, r);
    const at = await r.lib.dirOf(g.gid);
    if (!at || !fs.existsSync(at)) return;
    if (into === 'B') await folderB(m, r);
    if (!(await moveAside(at, into === 'A' ? `${at} by hand ${++m.tag}` : path.join(r.dir, 'B', `moved ${++m.tag}`)))) return;
    g.unfollowed = into;
    const now = what === 'none' && into === 'B' ? 'title' : what;
    if (now !== 'none' && await change(m, r.lib, g, now, n, true)) g.waits = true;
  },
});
// Folder B checked: a gallery moved into it by hand is followed there (while folder A, which it left, is
// shown: else it is reported as a copy until A is back, plan §8).
const checkB = command('checkB', fc.constant(null), {
  check: (m) => m.bApp === m.app,
  async run(m, r) {
    await r.lib.scan(/** @type {string} */ (r.B));
    if (m.state === 'shown') checked(m, 'B');
  },
});
// A gallery moved by the app to the other library folder (A to B, or back).
const moveTo = command('moveTo', anyGallery, {
  check: (m, i) => m.state === 'shown' && (!m.bApp || m.bApp === m.app) && !!galleryAt(m, i, g => inFolder(g) || (g.place === 'B' && !g.unfollowed && !g.waits && g.pages.length > 0)),
  async run(m, r, i) {
    const g = /** @type {Gallery} */ (galleryAt(m, i, g => inFolder(g) || (g.place === 'B' && !g.unfollowed && !g.waits && g.pages.length > 0)));
    await folderB(m, r);
    await r.lib.move(g.gid, g.place === 'A' ? /** @type {string} */ (r.B) : r.id);
    Object.assign(g, { place: g.place === 'A' ? 'B' : 'A', app: m.app });
  },
});
// The person links part of a gallery's folder — its picture folder or its .shiori moved elsewhere and
// junctioned back, or the whole folder — then the folder is checked and a change of the gallery tried
// (the desktop never goes through a link in a library folder: it refuses, or the change waits; the website
// can't tell a link), then the link undone and the folder checked again: once undone, the gallery reads whole
// with whatever was accepted (review 7 A2, S28a).
const linkPart = command('linkPart', fc.tuple(anyGallery, fc.constantFrom('images', '.shiori', 'whole'), fc.constantFrom('none', 'title', 'page', 'translation'), fc.nat(1)), {
  check: (m, [i]) => m.state === 'shown' && !!galleryAt(m, i, inFolder),
  async run(m, r, [i, part, what, n]) {
    const g = /** @type {Gallery} */ (galleryAt(m, i, inFolder));
    await r.lib.flush();
    await settledDeletions(m, r);
    const dir = await r.lib.dirOf(g.gid);
    const at = dir && (part === 'whole' ? dir : path.join(dir, part));
    if (!at || !fs.existsSync(at)) return;
    const aside = path.join(r.dir, `linked ${++m.tag}`);
    if (!(await moveAside(at, aside))) return;
    faults.junction(aside, at);
    try {
      await r.lib.scan(r.id);
      if (what !== 'none') await change(m, r.lib, g, what, n, true);
      await r.lib.flush().catch(() => {});   // what can't be written through it waits
    } finally {
      fs.rmdirSync(at);   // the junction, not what it leads to
      if (!(await moveAside(aside, at))) throw new Error(`${aside} couldn't be put back`);
    }
    await r.lib.scan(r.id);
    await r.lib.flush();
    checked(m);
  },
});

/** The commands that aren't in the base run yet: the person's or the disk's doing, and the desktop's
 * restart. `todo`, per app, where the fixed seeds find something today's code gets wrong: the step
 * that fixes it and the finding (plan §5; N1–N3: found by this harness, §10 S2). An app not named
 * finds nothing with them on the fixed seeds; the long runs (S8) look further. */
const OPEN = {
  // The desktop's restart, and the website's (a page loaded again: library-drivers.mjs). N2 (fixed in
  // S7: a deletion's durable record): a gallery deleted just before the app closes came back, its
  // folder never deleted.
  restart: { todo: {}, commands: [command('restart', fc.constant(null), {
    check: (m) => m.restartable,
    async run(m, r) { await r.lib.restart?.(); },
  })] },
  // Aimed at T08 (a description that doesn't parse taken for one with nothing in it), which the fixed
  // seeds don't reach yet: a gallery written, flushed, damaged, then read again.
  damage: { todo: {}, commands: [command('damage', fc.tuple(anyGallery, fc.constantFrom('metadata.json', 'image_records.json')), {
    check: (m, [i]) => m.state === 'shown' && !!galleryAt(m, i, g => g.place === 'A' && !g.zip && !g.displaced),
    async run(m, r, [i, file]) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => g.place === 'A' && !g.zip && !g.displaced));
      const dir = await r.lib.dirOf(g.gid);
      if (dir && fs.existsSync(path.join(dir, file))) fs.writeFileSync(path.join(dir, file), '{');
    },
  })] },
  // Aimed at T02 (an unrelated folder put at a gallery's path written to as the gallery's, then deleted
  // with it), which the fixed seeds don't reach yet: it takes a description written there, then a
  // delete. The conformance suite finds it.
  replace: { todo: {}, commands: [command('replaceDir', anyGallery, {
    check: (m, i) => m.state === 'shown' && !!galleryAt(m, i, g => g.place === 'A' && !g.zip && !g.displaced),
    async run(m, r, i) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => g.place === 'A' && !g.zip && !g.displaced));
      // Nothing under way as it is replaced: a write racing the replacement, between its look at the folder
      // and the write, is outside §2 (S21: one desktop run met a page moved into the person's folder).
      await r.lib.flush();
      const dir = await r.lib.dirOf(g.gid);
      if (!dir) return;
      fs.mkdirSync(path.join(r.dir, 'aside'), { recursive: true });
      if (!(await moveAside(dir, path.join(r.dir, 'aside', `${++m.tag}`)))) return;
      fs.mkdirSync(dir);
      const notes = new TextEncoder().encode(`personal notes ${m.tag}`);
      fs.writeFileSync(path.join(dir, 'personal-notes.txt'), notes);
      m.notes.set(path.join(dir, 'personal-notes.txt'), notes);
      g.displaced = true;
    },
  })] },
  // Aimed at T07 (a ZIP's picture changed in place, same name and size, keeps its old translation),
  // which the fixed seeds don't reach yet. N3 (the website, fixed in S8): a linked ZIP deleted after it
  // changed in place, before the library checked it, joined again at the next check.
  zipEntry: { todo: {}, commands: [command('changeEntry', fc.tuple(anyGallery, fc.nat(1)), {
    check: (m, [i]) => m.state === 'shown' && !!galleryAt(m, i, g => !!g.zip),
    async run(m, r, [i, k]) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => !!g.zip));
      const n = k % g.pages.length;
      const bytes = png(++m.tag);
      g.pages[n] = sourceChanged(g.pages[n], bytes);
      fs.writeFileSync(path.join(r.A, /** @type {string} */ (g.zip)), zipCreate(g.pages.map((p, j) => ({ name: `00${j + 1}.png`, data: p.original }))));
    },
  })] },
  // The drive taken away and brought back (the junction the folder is reached through removed and
  // made again: setup). Aimed at T12 (a gallery deleted while its drive is away came back with it; since
  // S7 the deletion is refused, which the model allows while it is away). It found N1 on the website (a write meeting
  // a folder that went away looped for ever; seed 2 reaches it), fixed in S3.
  away: { todo: {}, commands: [
    command('unplug', fc.constant(null), {
      check: (m) => m.state === 'shown',
      async run(m, r) { fs.rmdirSync(r.A); m.state = 'away'; },
    }),
    command('replug', fc.constant(null), {
      check: (m) => m.state === 'away',
      async run(m, r) { faults.junction(r.drive, r.A); m.state = 'shown'; },
    }),
  ] },
  // A translation written, and flushed, while the disk refuses every delete in the folder. Aimed at T05
  // (one replaced in another format is read from the old file once the folder is read back), which
  // the fixed seeds don't reach yet; the hand-over tests find it.
  // One file call answering "not found" (S11, review 4: NotFoundError, ENOENT — a drive away for a
  // moment), the k-th of a page stored again, a translation, a retitle or a deletion and the flush after
  // it. The change may be refused (then nothing changes); nothing is deleted or forgotten for it.
  notFound: { todo: {}, commands: [command('notFoundOnce', fc.tuple(fc.integer({ min: 1, max: 40 }), anyGallery, fc.constantFrom('putPage', 'putTranslation', 'setTitle', 'deleteGallery')), {
    check: (m, [, i]) => m.state === 'shown' && !!galleryAt(m, i, g => g.place === 'A' && !g.zip && !g.pdf && !g.displaced && g.pages.length > 0),
    async run(m, r, [k, i, what]) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => g.place === 'A' && !g.zip && !g.pdf && !g.displaced && g.pages.length > 0));
      const bytes = png(++m.tag), name = `T${m.tag}`;
      let n = 0;
      const undo = r.lib.app === 'website' ? fsa.failNext(() => ++n === k, 'NotFoundError') : faults.failNext(() => ++n === k, 'ENOENT');
      try {
        const work = { putPage: () => r.lib.putPage(g.gid, 1, bytes), putTranslation: () => r.lib.putTranslation(g.gid, 1, bytes),
          setTitle: () => r.lib.setTitle(g.gid, name), deleteGallery: () => r.lib.deleteGallery(g.gid) }[what];
        if (await attempt(true, work)) {
          if (what === 'putPage') g.pages[0] = { original: bytes, translated: null };
          else if (what === 'putTranslation') g.pages[0] = translatedAs(g.pages[0], bytes);
          else if (what === 'setTitle') g.title = name;
          else { m.galleries = m.galleries.filter(x => x !== g); m.deleted.add(g.gid); }
        }
        await r.lib.flush().catch(() => {});   // what couldn't be written is tried again later
      } finally { undo(); }
    },
  })] },
  deletes: { todo: {}, commands: [command('writeDeletesRefused', fc.tuple(anyGallery, fc.nat(1), fc.boolean()), {
    check: (m, [i]) => m.state === 'shown' && !!galleryAt(m, i, g => g.place === 'A' && !g.displaced && g.pages.length > 0),
    async run(m, r, [i, k, inWebp]) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => g.place === 'A' && !g.displaced && g.pages.length > 0));
      const n = (k % g.pages.length) + 1, bytes = (inWebp ? webp : png)(++m.tag);
      const inside = r.A.split(path.sep).join('/').toLowerCase();
      const undo = r.lib.app === 'website' ? fsa.failNext((c) => c.op === 'removeEntry', 'NoModificationAllowedError', { times: Infinity })
        : faults.failNext((c) => ['rm', 'unlink', 'rmdir'].includes(c.op) && c.path.toLowerCase().startsWith(inside), 'EBUSY', { times: Infinity });
      try {
        await r.lib.putTranslation(g.gid, n, bytes, inWebp ? 'image/webp' : 'image/png');
        g.pages[n - 1] = translatedAs(g.pages[n - 1], bytes);
        await r.lib.flush().catch(() => {});   // a description it couldn't replace is tried again later
      } finally { undo(); }
    },
  })] },
  // A source changing while work made from it is under way (T10, T11): a PDF put in the folder, or one
  // there changed (so a gallery drawn from it waits to be drawn again), the folder checked, then a PDF
  // waiting drawn as a window draws it — its file changed while it is drawn, or not; the drawing empty,
  // or not. A drawing of another version than the file's now, or with no pages, is refused and changes
  // nothing: the gallery keeps the pages it has (none, before it joins) until a drawing of the file as
  // it is. Longer runs (30) found N4 here on the desktop, outside the drawing: a gallery deleted just
  // before a check was taken, its folder half deleted, for a folder of pictures (fixed in S7, with N2).
  drawing: { todo: {}, commands: [
    command('drawPdf', fc.tuple(fc.nat(3).map(k => k === 0), fc.nat(9), fc.constantFrom('drawn', 'changed while drawn', 'drawn empty')), {
      check: (m) => m.state === 'shown',
      async run(m, r, [anew, i, how]) {
        if (anew || !m.pdfs.length) m.pdfs.push(`Book ${++m.tag}.pdf`);
        const name = m.pdfs[anew ? m.pdfs.length - 1 : i % m.pdfs.length];
        await r.lib.flush();   // what the library has of it published, so a gallery drawn from it is read again
        fs.writeFileSync(path.join(r.A, name), `%PDF-1.4 ${++m.tag}`);
        await r.lib.scan(r.id);
        checked(m);
        const w = (await r.lib.pdfsWaiting()).find(x => x.name === name);
        // Not waiting: removed from the library, or a gallery drawn from it with changes not published
        // yet (it isn't read again until they are: local changes win).
        if (!w) return;
        const { token } = await r.lib.pdfSource(w.folder, w.gid);
        if (how === 'changed while drawn') fs.writeFileSync(path.join(r.A, name), `%PDF-1.4 ${++m.tag}, changed while drawn`);
        const pages = how === 'drawn empty' ? [] : [png(++m.tag), png(++m.tag)];
        const kept = await r.lib.addRendered(w.folder, w.gid, pages, token).then(() => true, (e) => { if (how === 'drawn') throw e; return false; });
        if (kept !== (how === 'drawn')) throw new Error(`a drawing ${how} was ${kept ? 'kept' : 'refused'}`);        if (!kept) return;
        const g = m.galleries.find(x => x.gid === w.gid);
        if (g) g.pages = pages.map(original => ({ original, translated: null }));   // drawn again: what was made from the old pages goes
        else m.galleries.push({ gid: w.gid, place: 'A', app: m.app, title: await r.lib.titleOf(w.gid) ?? '', pdf: name, pages: pages.map(original => ({ original, translated: null })) });
      },
    }),
  ] },
  // A translation in flight (S8, plan §2): the page's source token read as its picture is, then — a
  // linked ZIP's page — its picture changed in place (same name and size) while it is translated, and the
  // folder checked or not, then the translation handed back with the token. One made from a picture a
  // check has since read anew is refused and changes nothing; otherwise it is kept (a source changed and
  // not checked yet: its page `changed`, its translation dropped by the next check).
  inFlight: { todo: {}, commands: [command('translateInFlight', fc.tuple(anyGallery, fc.nat(1), fc.constantFrom('unchanged', 'changed', 'changed, checked')), {
    check: (m, [i]) => m.state === 'shown' && !!galleryAt(m, i, g => g.pages.length > 0 && !g.pdf && !g.displaced),
    async run(m, r, [i, k, how]) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => g.pages.length > 0 && !g.pdf && !g.displaced));
      const n = (k % g.pages.length) + 1, changes = !!g.zip && how !== 'unchanged';
      if (changes) await r.lib.flush();   // nothing of the library's own waits, so a check reads the source again
      const token = (await r.lib.sources(g.gid))[n];
      if (changes) {
        g.pages[n - 1] = sourceChanged(g.pages[n - 1], png(++m.tag));
        fs.writeFileSync(path.join(r.A, /** @type {string} */ (g.zip)), zipCreate(g.pages.map((q, j) => ({ name: `00${j + 1}.png`, data: q.original }))));
        if (how === 'changed, checked') {
          await r.lib.scan(r.id);
          checked(m);
        }
      }
      const bytes = png(++m.tag);
      if (!(await attempt(!writable(m, g), () => r.lib.putTranslation(g.gid, n, bytes, 'image/png', token)))) return;
      if (how === 'changed, checked' && changes) return;   // refused: made from the picture the page showed before
      g.pages[n - 1] = translatedAs(g.pages[n - 1], bytes);
    },
  })] },
  // What a deletion leaves (S8, the orchestrator after S7): a picture of the person's own put in a
  // gallery's folder (a subfolder of their own, or beside its pages) stays when the gallery is deleted
  // (invariant 1), and never joins the library as a gallery of its own (invariant 2), even after the
  // folder is removed and added again.
  leftBehind: { todo: {}, commands: [command('plantInGallery', fc.tuple(anyGallery, fc.boolean()), {
    check: (m, [i]) => m.state === 'shown' && !!galleryAt(m, i, g => g.place === 'A' && !g.zip && !g.pdf && !g.displaced && g.pages.length > 0),
    async run(m, r, [i, beside]) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => g.place === 'A' && !g.zip && !g.pdf && !g.displaced && g.pages.length > 0));
      await r.lib.flush();   // its folder made
      const dir = await r.lib.dirOf(g.gid);
      if (!dir || !fs.existsSync(dir)) return;
      const file = path.join(dir, beside ? 'images' : 'extras', `mine-${++m.tag}.png`);
      const bytes = png(m.tag);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      m.notes.set(file, bytes);
    },
  })] },
  // The folder handed to the other app (handOver, above).
  handover: { both: true, todo: {}, commands: [handOver] },
  // S10: the person's doing within the windows a library takes what it found as it was (F1, F2): folder
  // A's drive given to another library (a copy of A, its galleries' folders naming them — every file of
  // it never to change), then, at once, a page written to a gallery in A and a check (refused: another
  // library's); or a gallery's folder swapped for a copy of another gallery's a moment after a page was
  // written to it, then another page written to it (nothing of it goes into that copy). Both put back
  // after: what was written meanwhile reads back.
  swaps: { todo: {}, commands: [
    command('swapRoot', fc.tuple(anyGallery, fc.nat(1)), {
      check: (m) => m.state === 'shown',
      async run(m, r, [i, k]) {
        await r.lib.flush();   // nothing under way as it is swapped (a write racing the swap is outside §2)
        await settledDeletions(m, r);
        const other = path.join(r.dir, `other library ${++m.tag}`);
        fs.cpSync(r.drive, other, { recursive: true });
        fs.writeFileSync(path.join(other, '.shiori', 'library.json'), JSON.stringify({ format: 'shiori-library', version: 1, id: `0f${String(m.tag).padStart(14, '0')}` }));
        for (const f of filesIn(other)) m.notes.set(f, new Uint8Array(fs.readFileSync(f)));
        fs.rmdirSync(r.A);
        faults.junction(other, r.A);
        try {
          const g = galleryAt(m, i, g => g.place === 'A' && !g.zip && !g.pdf && !g.displaced && !g.archived && g.pages.length > 0);
          if (g) {
            const n = (k % g.pages.length) + 1, bytes = png(++m.tag);
            if (await attempt(true, () => r.lib.putPage(g.gid, n, bytes))) g.pages[n - 1] = { original: bytes, translated: null };
          }
          const checked = await r.lib.scan(r.id).then(() => true, () => false);
          if (checked) throw new Error('another library at folder A\'s path was checked as it');
          await r.lib.flush().catch(() => {});   // what the write left to do, tried while the other library is there
        } finally {
          fs.rmdirSync(r.A);
          faults.junction(r.drive, r.A);
        }
      },
    }),
    command('swapGallery', fc.tuple(anyGallery, anyGallery, fc.nat(1)), {
      check: (m, [i, j]) => m.state === 'shown' && !!galleryAt(m, i, inFolder) && !!galleryAt(m, j, inFolder) && galleryAt(m, i, inFolder) !== galleryAt(m, j, inFolder),
      async run(m, r, [i, j, k]) {
        const g = /** @type {Gallery} */ (galleryAt(m, i, inFolder)), h = /** @type {Gallery} */ (galleryAt(m, j, inFolder));
        await r.lib.flush();   // both folders made
        const n = (k % g.pages.length) + 1, first = png(++m.tag);
        await r.lib.putPage(g.gid, n, first);
        g.pages[n - 1] = { original: first, translated: null };
        await r.lib.flush();   // nothing under way as it is swapped (a write racing the swap is outside §2)
        await settledDeletions(m, r);
        const at = await r.lib.dirOf(g.gid), theirs = await r.lib.dirOf(h.gid);
        if (!at || !theirs || !fs.existsSync(at) || !fs.existsSync(theirs)) return;
        const aside = path.join(r.dir, `aside ${++m.tag}`);
        if (!(await moveAside(at, aside))) return;
        try {
          fs.cpSync(theirs, at, { recursive: true });
          const before = filesIn(at).sort();
          const bytes = png(++m.tag);
          if (await attempt(true, () => r.lib.putPage(g.gid, n, bytes))) g.pages[n - 1] = { original: bytes, translated: null };
          await r.lib.flush().catch(() => {});   // what the write left to do, tried while the swapped folder is there
          const after = filesIn(at).sort();
          if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`gallery ${g.gid}'s picture went into another gallery's folder put at its path`);
        } finally {
          fs.rmSync(at, { recursive: true, force: true });
          await moveAside(aside, at);
        }
      },
    }),
  ] },
  // S10 (F4): a gallery's folder renamed by hand, then the gallery deleted: it never comes back (a check
  // meeting the renamed folder deletes it, never adopts it).
  renamed: { todo: {}, commands: [command('renameThenDelete', anyGallery, {
    check: (m, i) => m.state === 'shown' && !!galleryAt(m, i, inFolder),
    async run(m, r, i) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, inFolder));
      await r.lib.flush();
      const at = await r.lib.dirOf(g.gid);
      if (!at || !fs.existsSync(at) || !(await moveAside(at, `${at} renamed ${++m.tag}`))) return;
      await r.lib.deleteGallery(g.gid);
      m.galleries = m.galleries.filter(x => x !== g);
      m.deleted.add(g.gid);
    },
  })] },
  // S10, the desktop's archives handed between the apps (F3, F5, F6): a gallery archived by the desktop,
  // then an addition to it cut short (more than 64 KiB of entries, no directory: the desktop stopped) and
  // the folder taken over by the website ("Use anyway") before the desktop cut it back — the website
  // reads it whole, gives the folder back, and the desktop reads it whole; or the folder taken over by the
  // website, which changes the gallery (its first change unpacks it), then gives it back — the desktop
  // follows the gallery to its folder; or the person adding a file of their own to the archive — which
  // nothing changes, nor deletes with the gallery (the model then only deletes it).
  archives: { both: true, todo: {}, commands: [
    command('cutAppend', anyGallery, {
      check: (m, i) => m.both && m.app === 'desktop' && m.state === 'shown' && !!galleryAt(m, i, inFolder),
      async run(m, r, i) {
        const g = /** @type {Gallery} */ (galleryAt(m, i, inFolder));
        const file = await archived(r, g);
        if (!file) return;
        fs.appendFileSync(file, Buffer.alloc(70_000, 7));
        await takenOverBriefly(r, async (web) => {
          for (const [n, p] of g.pages.entries()) {
            const got = await web.read(g.gid, n + 1);
            if (!same(got, p.original)) throw new Error(`the website reads gallery ${g.gid} page ${n + 1} as ${show(got)}, not ${show(p.original)}`);
          }
        });
      },
    }),
    command('takeoverUnpack', anyGallery, {
      check: (m, i) => m.both && m.app === 'desktop' && m.state === 'shown' && !!galleryAt(m, i, inFolder),
      async run(m, r, i) {
        const g = /** @type {Gallery} */ (galleryAt(m, i, inFolder));
        if (!(await archived(r, g))) return;
        const bytes = png(++m.tag);
        await takenOverBriefly(r, async (web) => {
          await web.putPage(g.gid, 1, bytes);
          await web.flush();
        });
        g.pages[0] = { original: bytes, translated: null };
        delete g.archived;
        await r.lib.scan(r.id);
        checked(m);
      },
    }),
    command('editArchive', anyGallery, {
      check: (m, i) => m.app === 'desktop' && m.state === 'shown' && !!galleryAt(m, i, inFolder),
      async run(m, r, i) {
        const g = /** @type {Gallery} */ (galleryAt(m, i, inFolder));
        const file = await archived(r, g);
        if (!file) return;
        const entries = [];
        for (const e of await zipEntries(new Uint8Array(fs.readFileSync(file)))) entries.push({ name: e.filename, data: await e.read() });
        fs.writeFileSync(file, zipCreate([...entries, { name: 'notes.txt', data: new TextEncoder().encode(`mine ${++m.tag}`) }]));
        m.notes.set(file, new Uint8Array(fs.readFileSync(file)));
        g.edited = true;
      },
    }),
    handOver,
  ] },
  // S30's shapes (plan §10): two apps on one folder across "Use anyway" and the take-back — a second desktop
  // library among them, a kill on the desktop before the website's take-over, the drive back with a newer
  // copy — and the folder handed over between them; the person's edit then work before a check, in folder A
  // or into a second library folder B, and the app's own moves between the two; a link at each place a
  // gallery's folder has.
  takeovers: { both: true, todo: {}, commands: [usedAnyway, usedAnyway, forgetGone, archiveIt, handOver] },
  // S31's: the index an earlier version left (S30's, or one from before stamps) under the take-over shapes, and
  // folder A put back from an older copy.
  earlier: { both: true, todo: {}, commands: [earlierIndex, usedAnyway, usedAnyway, forgetGone, archiveIt, copyA, putBack, handOver] },
  edits: { todo: {}, commands: [movedByHand, checkB, moveTo] },
  links: { todo: {}, commands: [linkPart] },
};

// What each long run found and S8 fixed, replayed as it was found (fast-check's counterexample, its
// commands and their arguments) on the app it was found on.
const REGRESSIONS = [
  // A linked ZIP read nothing for two seconds after its drive came back: the folder's identity, found
  // out of reach, was taken as it was for IDENTITY_TTL (desktop folders.js _identity). Seed 3, 60 runs.
  { app: 'desktop', name: 'a linked ZIP reads at once when its drive is back',
    steps: [['link', null], ['unplug', null], ['newGallery', 1], ['replug', null]] },
  // A write begun just before the drive went made the library folder's path again (a recursive mkdir),
  // and the flush then failed on the place under way (desktop folder-store.js mkdir, files.js flush).
  // Seed 3, 60 runs.
  { app: 'desktop', name: 'a write under way as the drive goes never makes its folder again',
    steps: [['newGallery', 1], ['setTitle', 0], ['unplug', null], ['flush', null], ['replug', null]] },
  // The website's alike: what a folder out of reach allowed was taken as it was for GRANT_TTL_MS (db.js
  // _access), so a folder whose drive came back couldn't be checked, nor its pictures read, for five
  // seconds. Seeds 2039563338 and 172199433.
  { app: 'website', name: 'a folder whose drive is back is checked at once',
    steps: [['unplug', null], ['newGallery', 1], ['replug', null], ['scan', null]] },
  { app: 'website', name: 'a folder whose drive is back is read at once after a flush while it was away',
    steps: [['newGallery', 2], ['unplug', null], ['flush', null], ['replug', null]] },
  // A linked ZIP's picture changed in place while a change of the library's own (a translation) waited
  // to be published: the check didn't read the source again (local changes win), so the translation of
  // the old picture stayed over the new one. Now the change is published first, then the source read
  // again (both apps' check). Seed 1577452400, website.
  ...['website', 'desktop'].map(app => ({ app, name: 'a source changed in place while a change waits is read again by the check, its old picture\'s translation dropped',
    steps: [['link', null], ['translateInFlight', [0, 0, 'changed']], ['scan', null]] })),
  // A gallery deleted while its publication was under way came back at the next check: the publication
  // wrote its manifest after the deletion (desktop files.js: the deletion waits for it, and a
  // publication finding its gallery gone writes nothing; the website's deletes under the gallery's
  // lock). Seed 1985028742, desktop; the conformance case holds the publication open deterministically.
  ...['desktop', 'website'].map(app => ({ app, name: 'a gallery deleted while its publication is under way stays deleted',
    steps: [['newGallery', 2], ['link', null], ['setTitle', 0], ['deleteGallery', 0], ['link', null]] })),
  // N3: a linked ZIP changed in place, then deleted before a check noticed, joined again at the next
  // check — its removal note carried the fingerprint the index last had (db.js publishRemoved now
  // writes it as the files are, as the desktop does). Seed 1104992432, and the zipEntry set's seed 1.
  { app: 'website', name: 'a linked ZIP changed in place and deleted before a check stays removed (N3)',
    steps: [['link', null], ['translateInFlight', [0, 0, 'changed']], ['deleteGallery', 0], ['link', null]] },
  { app: 'website', name: 'a linked ZIP changed in place, deleted, then its folder added again stays removed (N3)',
    steps: [['scan', null], ['link', null], ['changeEntry', [8, 1]], ['deleteGallery', 4], ['readd', null]] },
  // Seed 740776427 (S29b's short run, both apps alike): a ZIP linked after another's picture changed in place.
  // The link's check read the changed picture, so a translation put on it afterwards is the new picture's and
  // stays at the next check. The model's own mistake (its link didn't count as a check), fixed in S30.
  // S30's take-over shapes with an archived gallery (desktop seeds 42 and 43): a deletion owed of it while the website,
  // using the folder anyway, changes it — so unpacks it — is dropped where a check meets the folder, the gallery
  // joining again at the next; a title of it made in the window reaches its archive before the website's change, so
  // the folder's version is the first to reach it (the model held the other app's: its own mistake, S30).
  // S30's second long run (desktop seed 1201853647): a second desktop library replacing the translation of a gallery this
  // one archived, while this one's title waited from the drive's absence — the archive took the picture with no new
  // generation, so the title was published over it; now the replacement is a generation, and the title is dropped.
  { app: 'desktop', both: true, name: 'a translation replaced in an archive by a second desktop library is a generation: the title waiting here is dropped at the take-back',
    steps: [['newGallery', 1], ['putTranslation', [0, 0, false]], ['archiveIt', 0],
      ['usedAnyway', { by: 'second desktop', mine: [0, 'title', 0, 'away', 1], unseen: false, theirs: [[0, 'translation', 0]], tries: [], made: false }]] },
  // S30's long run (desktop seed 778611996): the desktop killed as it translates an archived gallery, started again
  // with the drive away — its translation was refused "out of reach" (files.js _inFormat); now it waits.
  { app: 'desktop', both: true, name: 'an archived gallery translated by a desktop started with its folder\'s drive away waits for the drive',
    steps: [['handOver', null], ['usedAnyway', { by: 'other', mine: null, unseen: false, theirs: [], tries: [], made: true }], ['handOver', null], ['archiveIt', 0],
      ['usedAnyway', { by: 'other', mine: [0, 'translation', 0, 'killed', 3], unseen: true, theirs: [], tries: [], made: false }]] },
  { app: 'desktop', both: true, name: 'a second desktop library\'s change of an archived gallery this one unpacked in the window is dropped by a check, and its removal goes on',
    steps: [['newGallery', 1], ['archiveIt', 0], ['usedAnyway', { by: 'second desktop', mine: [0, 'translation', 0, 'window', 1], unseen: false, theirs: [[0, 'title', 0]], tries: [], made: false }]] },
  { app: 'desktop', both: true, name: 'a translation of an archived gallery made in the window: the unpack it set going reached the folder first, so it is published at the take-back',
    steps: [['newGallery', 1], ['archiveIt', 0], ['usedAnyway', { by: 'other', mine: [0, 'translation', 0, 'window', 1], unseen: false, theirs: [[0, 'title', 0]], tries: [], made: false }]] },
  { app: 'desktop', both: true, name: 'a deletion owed of an archived gallery the website unpacked while it used the folder anyway is dropped, the gallery back from its folder',
    steps: [['newGallery', 1], ['archiveIt', 0], ['usedAnyway', { by: 'other', mine: [0, 'delete', 0, 'away', 1], unseen: false, theirs: [[0, 'title', 0]], tries: [], made: false }]] },
  { app: 'desktop', both: true, name: 'a title of an archived gallery made in the window before learning of the take-over: the folder keeps the first change that reached it',
    steps: [['newGallery', 1], ['archiveIt', 0], ['usedAnyway', { by: 'other', mine: [0, 'title', 0, 'window', 1], unseen: false, theirs: [[0, 'title', 0]], tries: [], made: false }]] },
  // S30's take-over shapes (seed 42, both apps): a deletion owed (its folder's deletes refused) as the other app
  // uses the folder anyway and retitles the gallery — dropped at the take-back, the gallery back as the folder has
  // it (S29a's rule 3).
  ...['desktop', 'website'].map(app => ({ app, both: true, name: 'a deletion owed as the other app changes the gallery while it uses the folder anyway is dropped at the take-back',
    steps: [['newGallery', 1], ['usedAnyway', { by: 'other', mine: [0, 'delete', 0, 'away', 1], unseen: false, theirs: [[0, 'title', 0]], tries: [], made: false }]] })),
  // S31's shapes, each run as written on both apps: the index S30 left (manifests and stamps naming no publication)
  // or one from before stamps, then the folder used anyway — a title waiting here from the drive's absence is
  // published where the other app changed nothing of the gallery, dropped and reported where it did; and folder A
  // put back from an older copy, changed after on both apps.
  ...['desktop', 'website'].flatMap(app => ['S30', 'no stamps'].flatMap(form => [
    { app, both: true, name: `S31: from the index ${form === 'S30' ? 'S30 left' : 'of before stamps'}, a title waiting from the drive's absence is published at the take-back where the other app changed nothing of the gallery`,
      steps: [['newGallery', 1], ['newGallery', 2], ['earlierIndex', form],
        ['usedAnyway', { by: 'other', mine: [0, 'title', 0, 'away', 1], unseen: false, theirs: [[1, 'title', 0]], tries: [], made: false }]] },
    { app, both: true, name: `S31: from the index ${form === 'S30' ? 'S30 left' : 'of before stamps'}, a title waiting from the drive's absence is dropped and reported where the other app changed the gallery`,
      steps: [['newGallery', 1], ['earlierIndex', form],
        ['usedAnyway', { by: 'other', mine: [0, 'title', 0, 'away', 1], unseen: false, theirs: [[0, 'translation', 0]], tries: [], made: false }]] },
  ])),
  // S32's shape: a take-over followed at once by changes and a series command — each refused for now, the folder read
  // first; then what waited here weighed as the read finds it.
  ...['desktop', 'website'].map(app => ({ app, both: true, name: 'S32: changes and a series command asked at once after "Take back" are refused for now, and the folder read first',
    steps: [['newGallery', 1], ['newGallery', 2], ['usedAnyway', { by: 'other', mine: [0, 'title', 0, 'away', 1], unseen: false, theirs: [[0, 'title', 0], [1, 'translation', 0]], tries: [], made: true,
      atOnce: [[0, 'title', 0], [1, 'series', 0]] }]] })),
  // R8-3's shape: the desktop's title of an archived gallery, made in the window, reaches the archive; the website,
  // which read the folder before it, translates the gallery there (its first change: an unpack). The title is in
  // the folder's version at the end (or reported dropped on the desktop): never lost on both apps unsaid.
  { app: 'desktop', both: true, name: 'S31: a title of an archived gallery made in the window, then the other app\'s unpack from its older view: the title is kept or reported',
    steps: [['newGallery', 1], ['archiveIt', 0], ['usedAnyway', { by: 'other', mine: [0, 'title', 0, 'window', 1], unseen: false, theirs: [[0, 'translation', 0]], tries: [], made: false }]] },
  ...['desktop', 'website'].map(app => ({ app, both: true, name: 'S31: folder A put back from an older copy reads as the copy has it, and a change after reaches both apps',
    steps: [['newGallery', 1], ['newGallery', 2], ['copyA', null], ['setTitle', 0], ['putTranslation', [1, 0, false]], ['flush', null], ['putBack', null], ['setTitle', 1], ['flush', null], ['handOver', null], ['setTitle', 0], ['handOver', null]] })),
  ...['desktop', 'website'].map(app => ({ app, name: 'a translation put after a check read a changed source stays: the check made as a ZIP is linked counts',
    steps: [['link', null], ['changeEntry', [0, 1]], ['link', null], ['putTranslation', [0, 1, false]], ['scan', null]] })),
  // S10's situations (the review's F1–F6), each replayed as the commands reach it, on every app it
  // concerns (`both`: the other app's library there too, for the hand-over).
  ...['desktop', 'website'].flatMap(app => [
    { app, name: 'F1: another library put at the folder\'s path a moment after a write takes no write, and isn\'t checked',
      steps: [['newGallery', 2], ['swapRoot', [0, 1]], ['flush', null], ['scan', null]] },
    { app, name: 'F2: a gallery\'s folder swapped for another gallery\'s a moment after a write takes none of its pictures',
      steps: [['newGallery', 1], ['newGallery', 1], ['swapGallery', [0, 1, 0]], ['flush', null], ['scan', null]] },
    { app, name: 'F4: a gallery deleted after its folder was renamed by hand stays deleted',
      steps: [['newGallery', 1], ['renameThenDelete', 0], ['scan', null], ['readd', null]] },
    // Found by S10's long run (website seeds 144953778, 1903532451): the folder removed and added again
    // before any check — the removal forgot the deletion, and the re-add adopted the renamed folder. A
    // removal now looks for it first (folder-library.js _finishUnfound, scan.js finishUnfound).
    { app, name: 'F4: a gallery deleted after its folder was renamed stays deleted when the folder is removed and added again before a check',
      steps: [['newGallery', 1], ['renameThenDelete', 0], ['readd', null]] },
  ]),
  { app: 'desktop', both: true, name: 'F3: an addition cut short, the folder taken over before it was cut back, reads whole to both apps',
    steps: [['newGallery', 2], ['cutAppend', 0], ['putPage', [0, 1]], ['flush', null], ['handOver', null], ['scan', null]] },
  { app: 'desktop', both: true, name: 'F5: a gallery the website unpacked while it had the folder taken over is followed to its folder',
    steps: [['newGallery', 2], ['takeoverUnpack', 0], ['putTranslation', [0, 1, false]], ['flush', null], ['scan', null]] },
  { app: 'desktop', both: true, name: 'F6: an archive the person added a file to is left whole by its gallery\'s deletion, in either app',
    steps: [['newGallery', 1], ['newGallery', 1], ['editArchive', 0], ['editArchive', 1], ['deleteGallery', 0], ['scan', null],
      ['handOver', null], ['deleteGallery', 0], ['scan', null], ['handOver', null], ['scan', null]] },
];

/** `both`: the other app's library there too, for the hand-over.
 * @param {'website' | 'desktop'} app @param {{ both?: boolean }} [options]
 * @returns {Promise<{ model: Model, real: Real, done(): Promise<void> }>} */
async function setup(app, { both = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-model-'));
  const open = (/** @type {string} */ which) => (which === 'desktop' ? desktopLibrary(path.join(dir, 'desktop')) : webLibrary());
  const lib = await open(app);
  const other = both ? await open(app === 'desktop' ? 'website' : 'desktop') : null;
  // Folder A is on a "drive" of its own: reached through a junction, taken away by removing it.
  const A = path.join(dir, 'A'), drive = path.join(dir, 'drive', 'A');
  fs.mkdirSync(drive, { recursive: true });
  faults.junction(drive, A);
  const id = await lib.add(A);
  await lib.setDefault(id);
  /** @type {Real} */
  const real = { lib, other, dir, A, drive, id };
  return {
    model: { state: 'shown', galleries: [], deleted: new Set(), notes: new Map(), restartable: !!lib.restart, tag: 0, pdfs: [], app, both, leaving: [], gone: new Map() },
    real,
    async done() {
      // What the library does after its last command doesn't outlive the run.
      await within(COMMAND_MS, 'the last flush never ended', real.lib.flush()).catch(() => {});
      faults.reset(); fsa.reset(); await lib.close(); await other?.close(); await real.second?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** @param {'website' | 'desktop'} app @param {fc.Arbitrary<Command>[]} commands @param {number} seed
 * @param {{ endOnFailure?: boolean, numRuns?: number, both?: boolean }} [options] */
async function modelRun(app, commands, seed, { endOnFailure = false, numRuns = NUM_RUNS, both = false } = {}) {
  await fc.assert(fc.asyncProperty(fc.commands(commands, { maxCommands: MAX_COMMANDS }), async (cmds) => {
    const s = await setup(app, { both });
    try { await fc.asyncModelRun(() => s, cmds); } finally { await s.done(); }
  }), { seed, numRuns, endOnFailure });
}

// These drive both libraries themselves: run against the desktop library (npm run test:desktop),
// there is nothing more to run.
const skip = !!globalThis.__desktopLibrary && 'run by npm test';
for (const app of APPS) {
  describe(`model, ${app}`, () => {
    for (const seed of SEEDS) test(`base commands, seed ${seed}`, { skip }, () => modelRun(app, Object.values(BASE), seed));
    for (const [name, open] of Object.entries(OPEN)) {
      const todo = /** @type {Record<string, string>} */ (open.todo)[app];
      test(`with ${name}`, { skip, todo }, () => modelRun(app, [...Object.values(BASE), ...open.commands, ...open.commands], SEEDS[0],
        { endOnFailure: !!todo, numRuns: todo ? FINDING_RUNS : NUM_RUNS, both: !!(/** @type {{ both?: boolean }} */ (open).both) }));
    }
    for (const reg of REGRESSIONS.filter(x => x.app === app)) {
      test(`regression: ${reg.name}`, { skip }, async () => {
        const s = await setup(app, { both: !!reg.both });
        try {
          for (const [name, a] of reg.steps) {
            const c = step(name, a);
            if (!c.check(s.model)) throw new Error(`${c} can't be run after the steps before it`);
            await c.run(s.model, s.real);
          }
        } finally { await s.done(); }
      });
    }
  });
}

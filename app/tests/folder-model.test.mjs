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
// npm test runs the fixed seeds below; a long randomized session runs at the end of S8 and before the
// external review (SHIORI_MODEL_RUNS=<runs> SHIORI_MODEL_SEED=<seed>).
//
// The commands: add a gallery, write a page or a translation (in either format), retitle, delete; link
// a ZIP put in the folder; flush, check the folder, remove it and add it again, hide and show it; and
// restart (the desktop's; the website's reload is left for later: library-drivers.mjs), and the
// person's or the disk's doing — a description damaged, a gallery's folder moved away and another put
// at its path, a ZIP's picture changed in place (same name and size), the drive taken away and brought
// back, a translation written while every delete is refused.
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
import { desktopLibrary, webLibrary } from './library-drivers.mjs';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { zipCreate } from '../js/zip.js';

export const SEEDS = [1, 2, 3];
// Runs per seed of the base commands, and of each finding's (stopped at the first failure: what it
// finds is shown, not shrunk).
const NUM_RUNS = Number(process.env.SHIORI_MODEL_RUNS) || 10;
const FINDING_RUNS = Number(process.env.SHIORI_MODEL_RUNS) || 80;
const MAX_COMMANDS = 14;

/** @typedef {import('./library-drivers.mjs').Driver} Driver */
/** A page as the model has it: its picture's bytes and its translation's (null: none). `changed`: its
 * source changed since it was translated, and the library hasn't checked the folder since.
 * @typedef {{ original: Uint8Array, translated: Uint8Array | null, changed?: boolean }} Page */
/** @typedef {{ gid: string, place: 'A' | 'home', title: string, pages: Page[], zip?: string, displaced?: boolean }} Gallery */
/** @typedef {{ state: 'shown' | 'hidden' | 'away', galleries: Gallery[], deleted: Set<string>, notes: Map<string, Uint8Array>,
 *   restartable: boolean, tag: number }} Model */
/** @typedef {{ lib: Driver, dir: string, A: string, drive: string, id: string }} Real */

// Bytes no other write has: a picture's type, then the write's number (two bytes).
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255]);
const webp = (n) => new Uint8Array([0x52, 0x49, 0x46, 0x46, n >> 8, n & 255]);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const show = (b) => (b ? `[${[...b]}]` : 'nothing');

/** @param {Model} m @param {number} i */
const galleryAt = (m, i, ok = (/** @type {Gallery} */ g) => true) => { const list = m.galleries.filter(ok); return list.length ? list[i % list.length] : null; };
// Whether gallery `g` can be written to now (its folder shown and there), so a refusal is a fault.
const writable = (/** @type {Model} */ m, /** @type {Gallery} */ g) => !g.displaced && (g.place === 'home' || m.state === 'shown');
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
  const expected = m.galleries.filter(g => !g.displaced && (g.place === 'home' || m.state !== 'hidden'));
  for (const g of expected) if (!listed.has(g.gid)) problems.push(`2: gallery ${g.gid} is missing`);
  const known = new Set([...m.galleries.map(g => g.gid)]);
  for (const gid of listed) if (!known.has(gid) && !m.deleted.has(gid)) problems.push(`2: gallery ${gid} joined, put there by nobody`);
  for (const g of expected) {
    if (g.place === 'A' && m.state === 'away') continue;   // its pictures can't be read now
    if (await r.lib.titleOf(g.gid) !== g.title) problems.push(`2: gallery ${g.gid}'s title is ${await r.lib.titleOf(g.gid)}, not ${g.title}`);
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
 * `run`, the invariants checked after it.
 * @template A @param {string} name @param {fc.Arbitrary<A>} args
 * @param {{ check?: (m: Model, a: A) => boolean, run: (m: Model, r: Real, a: A) => Promise<void> }} spec
 * @returns {fc.Arbitrary<Command>} */
const command = (name, args, { check = () => true, run }) => args.map((a) => ({
  check: (m) => check(m, a),
  async run(m, r) { await within(COMMAND_MS, `${name} never ended`, run(m, r, a)); await verify(m, r); },
  toString: () => `${name}(${JSON.stringify(a)})`,
}));
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
      const g = { gid, place, title: name, pages: [] };
      m.galleries.push(g);
      for (let n = 1; n <= pages; n++) {
        const bytes = png(++m.tag);
        if (await attempt(m.state === 'away', () => r.lib.putPage(gid, n, bytes))) g.pages.push({ original: bytes, translated: null });
      }
    },
  }),
  putPage: command('putPage', fc.tuple(anyGallery, fc.nat(1)), {
    check: (m, [i]) => !!galleryAt(m, i, g => !g.zip && g.pages.length > 0),
    async run(m, r, [i, k]) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => !g.zip && g.pages.length > 0));
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
        g.pages[n - 1] = { original: g.pages[n - 1].original, translated: bytes };
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
    check: (m, i) => !!galleryAt(m, i),
    async run(m, r, i) {
      const g = /** @type {Gallery} */ (galleryAt(m, i));
      if (!(await attempt(!writable(m, g), () => r.lib.deleteGallery(g.gid)))) return;
      m.galleries = m.galleries.filter(x => x !== g);
      m.deleted.add(g.gid);
    },
  }),
  link: command('link', fc.constant(null), {
    check: (m) => m.state === 'shown',
    async run(m, r) {
      const name = `Pack ${++m.tag}.zip`, pages = [png(++m.tag), png(++m.tag)];
      fs.writeFileSync(path.join(r.A, name), zipCreate(pages.map((data, i) => ({ name: `00${i + 1}.png`, data }))));
      const before = new Set(await r.lib.galleries());
      await r.lib.scan(r.id);
      const gid = (await r.lib.galleries()).find(x => !before.has(x));
      if (!gid) throw new Error(`${name} didn't join the library`);
      m.galleries.push({ gid, place: 'A', title: await r.lib.titleOf(gid) ?? '', zip: name, pages: pages.map(original => ({ original, translated: null })) });
    },
  }),
  flush: command('flush', fc.constant(null), { async run(m, r) { await r.lib.flush(); } }),
  scan: command('scan', fc.constant(null), {
    check: (m) => m.state === 'shown',
    async run(m, r) {
      await r.lib.scan(r.id);
      for (const g of m.galleries) for (const p of g.pages) if (p.changed) { p.translated = null; delete p.changed; }
    },
  }),
  readd: command('readd', fc.constant(null), {
    check: (m) => m.state === 'shown',
    async run(m, r) {
      await r.lib.setDefault(r.lib.home);
      await r.lib.remove(r.id);
      r.id = await r.lib.add(r.A);
      await r.lib.setDefault(r.id);
      await r.lib.scan(r.id);
      m.galleries = m.galleries.filter(g => !g.displaced);
      for (const g of m.galleries) for (const p of g.pages) if (p.changed) { p.translated = null; delete p.changed; }
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

/** The commands that aren't in the base run yet: the person's or the disk's doing, and the desktop's
 * restart. `todo`, per app, where the fixed seeds find something today's code gets wrong: the step
 * that fixes it and the finding (plan §5; N1–N3: found by this harness, §10 S2). An app not named
 * finds nothing with them on the fixed seeds; the long runs (S8) look further. */
const OPEN = {
  // N2: a gallery deleted just before the app closes comes back, its folder never deleted.
  restart: { todo: { desktop: 'S7: N2' }, commands: [command('restart', fc.constant(null), {
    check: (m) => m.restartable,
    async run(m, r) { await /** @type {() => Promise<void>} */ (r.lib.restart)(); },
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
      const dir = await r.lib.dirOf(g.gid);
      if (!dir) return;
      fs.mkdirSync(path.join(r.dir, 'aside'), { recursive: true });
      fs.renameSync(dir, path.join(r.dir, 'aside', `${++m.tag}`));
      fs.mkdirSync(dir);
      const notes = new TextEncoder().encode(`personal notes ${m.tag}`);
      fs.writeFileSync(path.join(dir, 'personal-notes.txt'), notes);
      m.notes.set(path.join(dir, 'personal-notes.txt'), notes);
      g.displaced = true;
    },
  })] },
  // Aimed at T07 (a ZIP's picture changed in place, same name and size, keeps its old translation),
  // which the fixed seeds don't reach yet. N3 (the website): a linked ZIP deleted after it changed in
  // place, before the library checked it, joins again at the next check.
  zipEntry: { todo: { website: 'S9: N3' }, commands: [command('changeEntry', fc.tuple(anyGallery, fc.nat(1)), {
    check: (m, [i]) => m.state === 'shown' && !!galleryAt(m, i, g => !!g.zip),
    async run(m, r, [i, k]) {
      const g = /** @type {Gallery} */ (galleryAt(m, i, g => !!g.zip));
      const n = k % g.pages.length;
      const bytes = png(++m.tag);
      g.pages[n] = { original: bytes, translated: g.pages[n].translated, changed: g.pages[n].translated != null || g.pages[n].changed };
      fs.writeFileSync(path.join(r.A, /** @type {string} */ (g.zip)), zipCreate(g.pages.map((p, j) => ({ name: `00${j + 1}.png`, data: p.original }))));
    },
  })] },
  // The drive taken away and brought back (the junction the folder is reached through removed and
  // made again: setup). Aimed at T12 (a gallery deleted while its drive is away comes back with it),
  // which the fixed seeds don't reach yet on the desktop. N1 (the website): a write meeting a folder
  // that went away loops for ever.
  away: { todo: { website: 'S3: N1' }, commands: [
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
        g.pages[n - 1] = { original: g.pages[n - 1].original, translated: bytes };
        await r.lib.flush().catch(() => {});   // a description it couldn't replace is tried again later
      } finally { undo(); }
    },
  })] },
};

/** @param {'website' | 'desktop'} app @returns {Promise<{ model: Model, real: Real, done(): Promise<void> }>} */
async function setup(app) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-model-'));
  const lib = app === 'desktop' ? await desktopLibrary(path.join(dir, 'desktop')) : await webLibrary();
  // Folder A is on a "drive" of its own: reached through a junction, taken away by removing it.
  const A = path.join(dir, 'A'), drive = path.join(dir, 'drive', 'A');
  fs.mkdirSync(drive, { recursive: true });
  faults.junction(drive, A);
  const id = await lib.add(A);
  await lib.setDefault(id);
  return {
    model: { state: 'shown', galleries: [], deleted: new Set(), notes: new Map(), restartable: !!lib.restart, tag: 0 },
    real: { lib, dir, A, drive, id },
    async done() {
      // What the library does after its last command doesn't outlive the run.
      await within(COMMAND_MS, 'the last flush never ended', lib.flush()).catch(() => {});
      faults.reset(); fsa.reset(); await lib.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** @param {'website' | 'desktop'} app @param {fc.Arbitrary<Command>[]} commands @param {number} seed
 * @param {{ endOnFailure?: boolean }} [options] */
async function modelRun(app, commands, seed, { endOnFailure = false, numRuns = NUM_RUNS } = {}) {
  await fc.assert(fc.asyncProperty(fc.commands(commands, { maxCommands: MAX_COMMANDS }), async (cmds) => {
    const s = await setup(app);
    try { await fc.asyncModelRun(() => s, cmds); } finally { await s.done(); }
  }), { seed: Number(process.env.SHIORI_MODEL_SEED) || seed, numRuns, endOnFailure });
}

// These drive both libraries themselves: run against the desktop library (npm run test:desktop),
// there is nothing more to run.
const skip = !!globalThis.__desktopLibrary && 'run by npm test';
for (const app of /** @type {const} */ (['desktop', 'website'])) {
  describe(`model, ${app}`, () => {
    for (const seed of SEEDS) test(`base commands, seed ${seed}`, { skip }, () => modelRun(app, Object.values(BASE), seed));
    for (const [name, open] of Object.entries(OPEN)) {
      const todo = /** @type {Record<string, string>} */ (open.todo)[app];
      test(`with ${name}`, { skip, todo }, () => modelRun(app, [...Object.values(BASE), ...open.commands, ...open.commands], SEEDS[0],
        { endOnFailure: !!todo, numRuns: todo ? FINDING_RUNS : NUM_RUNS }));
    }
  });
}

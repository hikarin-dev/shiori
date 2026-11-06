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
// changed, a picture of the person's own put in a gallery's folder (and left by its deletion).
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
/** `app`: the library it was made in (one kept at `home` is that library's alone).
 * @typedef {{ gid: string, place: 'A' | 'home', app: string, title: string, pages: Page[], zip?: string, pdf?: string, displaced?: boolean }} Gallery */
/** `app`: the app working on folder A now (the hand-over gives it to the other: `other`).
 * @typedef {{ state: 'shown' | 'hidden' | 'away', galleries: Gallery[], deleted: Set<string>, notes: Map<string, Uint8Array>,
 *   restartable: boolean, tag: number, pdfs: string[], app: string, both: boolean }} Model */
/** @typedef {{ lib: Driver, other: Driver | null, dir: string, A: string, drive: string, id: string }} Real */

// Bytes no other write has: a picture's type, then the write's number (two bytes).
const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n >> 8, n & 255]);
const webp = (n) => new Uint8Array([0x52, 0x49, 0x46, 0x46, n >> 8, n & 255]);
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const show = (b) => (b ? `[${[...b]}]` : 'nothing');

/** @param {Model} m @param {number} i */
const galleryAt = (m, i, ok = (/** @type {Gallery} */ g) => true) => { const list = m.galleries.filter(g => here(m, g) && ok(g)); return list.length ? list[i % list.length] : null; };
// Whether gallery `g` is in the library of the app working now: in folder A, or kept at its home.
const here = (/** @type {Model} */ m, /** @type {Gallery} */ g) => g.place === 'A' || g.app === m.app;
// Whether gallery `g` can be written to now (its folder shown and there), so a refusal is a fault.
const writable = (/** @type {Model} */ m, /** @type {Gallery} */ g) => !g.displaced && (g.place === 'home' || m.state === 'shown');
// Folder A removed from the library (the person's Remove): resolves whether it was. A gallery whose
// folder was replaced by hand, with something of it still to be written there, keeps the removal from
// ending — the folder stays, and the removal's failure says so — so it may be refused then; refused,
// nothing changes (A is the default again).
async function removed(/** @type {Model} */ m, /** @type {Real} */ r) {
  if (await attempt(m.galleries.some(g => g.displaced && here(m, g)), () => r.lib.remove(r.id))) return true;
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
// The library has checked folder A: what was made from a source picture that changed is gone.
function checked(/** @type {Model} */ m) {
  for (const g of m.galleries) for (const p of g.pages) { if (p.changed) p.translated = null; delete p.changed; delete p.unchecked; }
}
// Page `p` translated as `bytes`; page `p` whose source picture changed in place to `bytes`.
/** @param {Page} p @param {Uint8Array} bytes @returns {Page} */
const translatedAs = (p, bytes) => ({ original: p.original, translated: bytes, ...(p.unchecked ? { changed: true, unchecked: true } : {}) });
/** @param {Page} p @param {Uint8Array} bytes @returns {Page} */
const sourceChanged = (p, bytes) => ({ original: bytes, translated: p.translated, changed: p.translated != null || !!p.changed, unchecked: true });
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
  const expected = m.galleries.filter(g => here(m, g) && !g.displaced && (g.place === 'home' || m.state !== 'hidden'));
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
const command = (name, args, spec) => {
  SPECS.set(name, spec);
  return args.map((a) => step(name, a));
};
/** Command `name` with arguments `a`, as `command` makes it (a regression replays them: REGRESSIONS).
 * @returns {Command} */
function step(/** @type {string} */ name, /** @type {any} */ a) {
  const { check = () => true, run } = /** @type {any} */ (SPECS.get(name));
  return {
    check: (m) => check(m, a),
    async run(m, r) { await within(COMMAND_MS, `${name} never ended`, run(m, r, a)); await verify(m, r); },
    toString: () => `${name}(${JSON.stringify(a)})`,
  };
}
/** @type {Map<string, { check?: (m: Model, a: any) => boolean, run: (m: Model, r: Real, a: any) => Promise<void> }>} */
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
  // The folder handed to the other app (plan §6.3): this one removes it — first writing there what only
  // it has (§3.4's write-back) — and the other adds it and checks it. Every gallery there reads whole in
  // the other app, whose library the commands after work on (a gallery kept at an app's home stays in
  // that app's alone); handed back, likewise.
  handover: { both: true, todo: {}, commands: [command('handOver', fc.constant(null), {
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
  })] },
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
    model: { state: 'shown', galleries: [], deleted: new Set(), notes: new Map(), restartable: !!lib.restart, tag: 0, pdfs: [], app, both },
    real,
    async done() {
      // What the library does after its last command doesn't outlive the run.
      await within(COMMAND_MS, 'the last flush never ended', real.lib.flush()).catch(() => {});
      faults.reset(); fsa.reset(); await lib.close(); await other?.close();
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
        const s = await setup(app);
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

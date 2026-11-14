// folder-store.conformance.mjs — the folder store contract (storage/contract.js) checked on one
// adapter (plan §6.1). One suite, run by an entry file per app — folder-store-web.test.mjs for the
// website's adapter (under Node, over real temporary folders: fsa-node.mjs), desktop/tests/
// folder-store.test.mjs for the desktop's — so both answer every operation alike. Each case gets a
// temporary folder of its own and a fixture made over it (websiteFixture, desktopFixture): the
// adapter (`store`) and the library it belongs to, to set the case up with and, for the write budget
// (plan D23), to work through.
//
// A case the adapters fail today is marked todo with the step that fixes it, and the finding (plan
// §5) it rediscovers where it is one. A gallery's folder in format v2 (gallery-manifest.js) is read
// back by both apps' readers (readBoth: each adapter's loadGallery), whichever adapter wrote it.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';
import { desktopLibrary, webLibrary, desktopKilled, pageNow, pageCalling } from './library-drivers.mjs';
import { v1Gallery, legacyGallery } from './fixtures/storage-fixtures.mjs';
import { loadGallery as desktopLoad } from '../../desktop/server/folder-store.js';
import { loadGallery as websiteLoad, forgetFolder } from '../js/storage/folder-store-web.js';
import { zipCreate } from '../js/zip.js';

/** @typedef {import('../js/storage/contract.js').FolderStore<any>} FolderStore */
/** @typedef {import('../js/storage/contract.js').FolderRef<any>} FolderRef */
/** A fixture: one app's library over folders in a test's temporary folder — `store`, its folder store
 * adapter; `lib`, the library (library-drivers.mjs) — and what a case sets up through it:
 * register(name) (a library folder at <dir>/<name>, added and made the default), hide(ref),
 * takeOver(ref) (another app's claim written on it) and, on the website, deny(ref) (the person's
 * permission withdrawn).
 * @typedef {{ store: FolderStore, lib: import('./library-drivers.mjs').Driver, register(name: string): Promise<FolderRef>,
 *   hide(ref: FolderRef): Promise<void>, takeOver(ref: FolderRef): Promise<void>, deny?(ref: FolderRef): void,
 *   close(): Promise<void> }} Fixture */

/** The website's library (db.js under Node, its folders through fsa-node.mjs) and its adapter.
 * @param {string} dir @returns {Promise<Fixture>} */
export async function websiteFixture(dir) {
  const lib = await webLibrary();
  const paths = new Map();   // folder id → its path
  return {
    store: lib.raw.folderStore, lib,
    async register(name) {
      const at = path.join(dir, name);
      const id = await lib.add(at);
      await lib.setDefault(id);
      paths.set(id, at);
      return { id, location: fsa.directory(at) };
    },
    async hide(ref) { await lib.setDefault(lib.home); await lib.hide(ref.id); },
    takeOver: (ref) => lib.takeOver(ref.id),
    deny(ref) { fsa.setPermission(paths.get(ref.id), 'prompt'); },
    async close() { fsa.reset(); },
  };
}
/** The desktop's library (its data and first folder in <dir>/desktop) and its adapter.
 * @param {string} dir @returns {Promise<Fixture>} */
export async function desktopFixture(dir) {
  const lib = await desktopLibrary(path.join(dir, 'desktop'));
  return {
    get store() { return lib.raw.store; }, lib,
    async register(name) {
      const at = path.join(dir, name);
      const id = await lib.add(at);
      await lib.setDefault(id);
      return { id, location: path.resolve(at) };
    },
    async hide(ref) { await lib.setDefault(lib.home); await lib.hide(ref.id); },
    takeOver: (ref) => lib.takeOver(ref.id),
    close: () => lib.close(),
  };
}
/** A case: what it checks, the platforms it applies to (both when not said), what today's code gets
 * wrong (per platform: the step that fixes it and the finding), and the check itself.
 * @typedef {{ name: string, platforms?: ('website' | 'desktop')[], todo?: Partial<Record<'website' | 'desktop', string>>,
 *   run(ctx: { dir: string, store: Fixture['store'], fx: Fixture, platform: 'website' | 'desktop' }): Promise<void> }} Case */

const PURPOSES = /** @type {const} */ (['read', 'write', 'removal', 'claim']);
const png = (...tag) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...tag]);
const webp = (...tag) => new Uint8Array([0x52, 0x49, 0x46, 0x46, ...tag]);
const otherId = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
// What open() answers for each purpose: { read: 'ok' | refusal, … }.
async function answers(/** @type {Fixture['store']} */ store, /** @type {any} */ ref) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const purpose of PURPOSES) out[purpose] = (await store.open(ref, /** @type {any} */ ({ purpose }))).status;
  return out;
}
const every = (/** @type {string} */ status) => Object.fromEntries(PURPOSES.map(p => [p, status]));
async function opened(/** @type {Fixture['store']} */ store, /** @type {any} */ ref, purpose = 'write') {
  const r = await store.open(ref, /** @type {any} */ ({ purpose }));
  assert.equal(r.status, 'ok', `opened to ${purpose}`);
  return /** @type {any} */ (r).root;
}
// `work`, failed when it doesn't settle in `ms` (a call that loops for ever), its loop stopped there.
async function settles(/** @type {Promise<unknown>} */ work, ms = 3000) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('never settled'), ms); });
  const got = await Promise.race([work.then(() => 'resolved', (e) => e?.name || 'rejected'), late]);
  clearTimeout(timer);
  if (got === 'never settled') { fsa.failNext(() => true, 'InvalidStateError', { times: Infinity }); await new Promise(r => setTimeout(r, 200)); }
  return got;
}
// What folder `at` holds: every file's path in it → its bytes (hex).
function snapshot(/** @type {string} */ at) {
  /** @type {Record<string, string>} */
  const out = {};
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(at, p)] = fs.readFileSync(p).toString('hex');
    }
  };
  walk(at);
  return out;
}
// A file `name` added to the archive at `file`, as the person does with an archive tool: written again
// whole with it.
async function addToArchive(/** @type {string} */ file, /** @type {string} */ name, /** @type {Uint8Array} */ data) {
  const { zipEntries } = await import('../js/zip-read.js');
  const entries = [];
  for (const e of await zipEntries(new Uint8Array(fs.readFileSync(file)))) entries.push({ name: e.filename, data: await e.read() });
  fs.writeFileSync(file, zipCreate([...entries, { name, data }]));
}
// Resolves once `ready()` holds — what a library does after its write commits — failed after `ms`.
async function until(/** @type {() => boolean | Promise<boolean>} */ ready, ms = 5000) {
  for (const end = Date.now() + ms; !(await ready()); await new Promise(r => setTimeout(r, 25))) {
    if (Date.now() > end) throw new Error('it never happened');
  }
}
// The drive library folder `at` is on taken away inside the first file call `when(call)` matches (the
// app's: fs-faults.mjs on the desktop, fsa-node.mjs on the website): the folder renamed away there, so
// that call and every later one in it answer "not found", as they do while a drive is away (review 5).
// It comes back at the `backAfter`-th file call after that one, or else when the function returned is
// called (which also takes the fault back).
function driveAway(/** @type {'website' | 'desktop'} */ platform, /** @type {string} */ at, /** @type {(call: { op: string, path: string }) => boolean} */ when, { backAfter = Infinity } = {}) {
  let left = false, calls = 0;
  const away = `${at}.away`, home = () => { if (fs.existsSync(away)) fs.renameSync(away, at); };
  const watch = (/** @type {{ op: string, path: string }} */ c) => {
    if (!left && when(c)) { left = true; fs.renameSync(at, away); } else if (left && ++calls === backAfter) home();
    return false;
  };
  const undo = platform === 'desktop' ? faults.failNext(watch, 'EIO', { times: Infinity }) : fsa.failNext(watch, 'EIO', { times: Infinity });
  return () => { undo(); assert.ok(left, 'the drive left'); home(); };
}

/** @type {Case[]} */
export const CASES = [
  // ── Identity: open() ──
  {
    name: 'a folder put where a library folder was, with another library\'s id, is refused for every purpose (other-library)',
    async run({ dir, store, fx }) {
      const ref = await fx.register('A');
      fs.renameSync(path.join(dir, 'A'), path.join(dir, 'A moved'));
      fs.mkdirSync(path.join(dir, 'A', '.shiori'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'A', '.shiori', 'library.json'), JSON.stringify({ format: 'shiori-library', version: 1, id: otherId() }));
      assert.deepEqual(await answers(store, ref), every('other-library'));
    },
  },
  {
    name: 'a library folder whose library.json is gone is refused for every purpose (other-library)',
    async run({ dir, store, fx }) {
      const ref = await fx.register('A');
      fs.rmSync(path.join(dir, 'A', '.shiori', 'library.json'));
      assert.deepEqual(await answers(store, ref), every('other-library'));
    },
  },
  {
    name: 'a hidden folder is read, and refused for every change (hidden)',
    async run({ store, fx }) {
      const ref = await fx.register('A');
      await fx.hide(ref);
      assert.deepEqual(await answers(store, ref), { read: 'ok', write: 'hidden', removal: 'hidden', claim: 'hidden' });
    },
  },
  {
    name: 'a folder another app holds is read, and refused for writing (not-owned)',
    async run({ store, fx }) {
      const ref = await fx.register('A');
      await fx.takeOver(ref);
      const got = await answers(store, ref);
      assert.equal(got.read, 'ok');
      assert.equal(got.write, 'not-owned');
    },
  },
  {
    name: 'a folder this page may not use now is refused for every purpose (no-permission)',
    platforms: ['website'],
    async run({ store, fx }) {
      const ref = await fx.register('A');
      /** @type {NonNullable<Fixture['deny']>} */ (fx.deny)(ref);
      assert.deepEqual(await answers(store, ref), every('no-permission'));
    },
  },
  {
    name: 'a folder that isn\'t there is refused for every purpose (unavailable)',
    async run({ dir, store, fx }) {
      const ref = await fx.register('A');
      fs.renameSync(path.join(dir, 'A'), path.join(dir, 'A away'));
      assert.deepEqual(await answers(store, ref), every('unavailable'));
    },
  },
  // ── A gallery's directory: reserve() and gallery() ──
  {
    name: 'two galleries reserving one name at once get directories of their own, each naming its gallery',
    async run({ store, fx }) {
      const root = await opened(store, await fx.register('A'));
      const [a, b] = await Promise.all([root.reserve('Same', '1700000000001', null), root.reserve('Same', '1700000000002', null)]);
      assert.notEqual(a.name, b.name);
      assert.equal((await root.gallery(a.name, '1700000000001')).kind, 'ok');
      assert.equal((await root.gallery(b.name, '1700000000002')).kind, 'ok');
    },
  },
  {
    name: 'a directory that is another gallery\'s is never this one\'s',
    async run({ store, fx }) {
      const root = await opened(store, await fx.register('A'));
      const a = await root.reserve('First', '1700000000001', null);
      assert.notEqual((await root.gallery(a.name, '1700000000002')).kind, 'ok');
    },
  },
  {
    name: 'a directory put in place of a gallery\'s, naming no gallery, is a conflict, and never written to',
    async run({ dir, store, fx }) {
      const root = await opened(store, await fx.register('A'));
      const g = await root.reserve('Replaced', '1700000000001', null);
      const at = path.join(dir, 'A', ...g.name.split('/'));
      fs.renameSync(at, path.join(dir, 'moved away'));
      fs.mkdirSync(at);
      fs.writeFileSync(path.join(at, 'personal-notes.txt'), 'mine');
      assert.deepEqual(await root.gallery(g.name, '1700000000001'), { kind: 'conflict', found: null });
    },
  },
  // ── Files: writeNew, typed reads, deleteNamed ──
  {
    name: 'writeNew never writes over a file',
    async run({ store, fx }) {
      const root = await opened(store, await fx.register('A'));
      const g = await root.reserve('Pictures', '1700000000001', null);
      const first = await g.writeNew('translated/0001', 'png', png(1));
      const second = await g.writeNew('translated/0001', 'png', png(2));
      assert.notEqual(second.name, first.name);
      assert.deepEqual((await g.read(first.name)).data, png(1));
      assert.deepEqual((await g.read(second.name)).data, png(2));
    },
  },
  {
    name: 'a file that isn\'t there reads as missing, one that can\'t be read as unreadable',
    async run({ store, fx, platform }) {
      const ref = await fx.register('A');
      const g = await (await opened(store, ref)).reserve('Unreadable', '1700000000001', null);
      const { name } = await g.writeNew('images/0001', 'png', png(1));
      const root = await opened(store, ref, 'read');
      assert.equal((await root.read('nothing.png')).kind, 'missing');
      const undo = platform === 'website' ? fsa.failNext((c) => c.op === 'getFile', 'NotReadableError')
        : faults.failNext((c) => c.op === 'readFile' && c.path.endsWith(`/${name}`), 'EACCES');
      try { assert.equal((await root.read(`${g.name}/${name}`)).kind, 'unreadable'); } finally { undo(); }
    },
  },
  {
    name: 'deleteNamed deletes only the files named, and leaves and reports one changed since it was written',
    async run({ dir, store, fx }) {
      const root = await opened(store, await fx.register('A'));
      const g = await root.reserve('Named', '1700000000001', null);
      const a = await g.writeNew('images/0001', 'png', png(1));
      const b = await g.writeNew('images/0002', 'png', png(2));
      const file = path.join(dir, 'A', ...g.name.split('/'), ...b.name.split('/'));
      fs.writeFileSync(file, png(9));   // the same size, other bytes
      fs.utimesSync(file, new Date(), new Date(b.mtime + 5000));
      const done = await g.deleteNamed([a, b]);
      assert.deepEqual(done.deleted, [a.name]);
      assert.deepEqual(done.kept, [{ name: b.name, why: 'changed' }]);
      assert.ok(fs.existsSync(file), 'the changed file is left');
    },
  },
  // ── Publication (format v2: gallery-manifest.js) ──
  {
    name: 'a publication cut short after any of its writes leaves, to both apps, the whole previous generation or the whole new one',
    async run({ dir, store, fx, platform }) {
      const root = await opened(store, await fx.register('A'));
      // How many writes one publication of the second generation makes, counted on a run of its own.
      const count = await twoGenerations(root, '1700000000100', { platform });
      assert.ok(count.writes >= 4, `its stored descriptions, its manifest and its copies (${count.writes})`);
      for (let k = 1; k <= count.writes; k++) {
        const gid = String(1700000000100 + k);
        const got = await twoGenerations(root, gid, { platform, failAt: k });
        for (const [app, read] of Object.entries(await readBoth(path.join(dir, 'A'), got.name))) {
          assert.equal(read.kind, 'ok', `cut at write ${k}, read by the ${app}`);
          const title = read.meta.title.english;
          assert.ok(['First', 'Second'].includes(title), `a whole generation (${title})`);
          const want = title === 'First' ? got.first : got.second;
          assert.equal(read.pictures.file('translated/0001'), want, `cut at write ${k}, read by the ${app}: the translation its generation names`);
          assert.equal(read.records.length, title === 'First' ? 1 : 2, 'its records of the same generation');
        }
      }
    },
  },
  {
    name: 'a stored description whose content doesn\'t match its name, or a damaged manifest, reads as corrupt',
    async run({ dir, store, fx, platform }) {
      const root = await opened(store, await fx.register('A'));
      const got = await twoGenerations(root, '1700000000200', { platform });
      const at = path.join(dir, 'A', ...got.name.split('/'));
      const manifest = JSON.parse(fs.readFileSync(path.join(at, '.shiori', 'gallery.json'), 'utf8'));
      const stored = path.join(at, ...manifest.descriptions['metadata.json'].split('/'));
      fs.writeFileSync(stored, fs.readFileSync(stored, 'utf8').replace('Second', 'Forged'));
      for (const read of Object.values(await readBoth(path.join(dir, 'A'), got.name))) assert.equal(read.kind, 'corrupt');
      fs.writeFileSync(path.join(at, '.shiori', 'gallery.json'), '{');
      for (const read of Object.values(await readBoth(path.join(dir, 'A'), got.name))) assert.equal(read.kind, 'corrupt');
    },
  },
  {
    // T09: a file a description named that wasn't there gave way to an older one.
    name: 'a file the manifest names that isn\'t there reads as missing, never as another file of its slot',
    async run({ dir, store, fx, platform }) {
      const root = await opened(store, await fx.register('A'));
      const got = await twoGenerations(root, '1700000000300', { platform });
      const at = path.join(dir, 'A', ...got.name.split('/'));
      assert.ok(fs.existsSync(path.join(at, ...got.first.split('/'))), 'the older translation is still there');
      fs.rmSync(path.join(at, ...got.second.split('/')));
      for (const read of Object.values(await readBoth(path.join(dir, 'A'), got.name))) assert.deepEqual(read, { kind: 'missing-file', files: [got.second] });
    },
  },
  {
    // T08: a damaged description was taken for an empty one, and the loss was saved.
    name: 'T08: a gallery whose folder was damaged keeps what the library has of it, is reported, and a later change publishes it whole',
    async run({ fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Damaged');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.putTranslation(gid, 1, png(2));
      await fx.lib.flush();
      const at = await fx.lib.dirOf(gid);
      const file = path.join(at, '.shiori', 'gallery.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Another app's generation, arrived damaged: a stored description that isn't what it is named.
      fs.writeFileSync(path.join(at, ...manifest.descriptions['image_records.json'].split('/')), '{');
      fs.writeFileSync(file, JSON.stringify({ ...manifest, generation: manifest.generation + 1, writer: 'a1b2c3d4e5f60708' }));
      await new Promise(r => setTimeout(r, 1200));   // its announcements made (a check leaves a gallery alone while they wait)
      const found = await fx.lib.scan(ref.id);
      assert.deepEqual(found.problems.map(p => p.reason), ['corrupt']);
      assert.deepEqual(await fx.lib.read(gid, 1, 'translated'), png(2), 'its translation kept');
      await fx.lib.setTitle(gid, 'Damaged, renamed');
      await fx.lib.flush();
      assert.deepEqual((await fx.lib.scan(ref.id)).problems, [], 'published whole again');
      assert.deepEqual(await fx.lib.read(gid, 1, 'translated'), png(2));
    },
  },
  {
    name: 'T09: a folder whose descriptions name a file that isn\'t there is reported, never read with the older file in its place',
    async run({ dir, fx }) {
      const gid = '1700000000400';
      const at = path.join(dir, 'A', 'Incomplete');
      const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(at, rel)), { recursive: true }); fs.writeFileSync(path.join(at, rel), data); };
      put('metadata.json', JSON.stringify({ galleryId: gid, title: { english: 'Incomplete', japanese: '', pretty: '' } }));
      put('image_records.json', JSON.stringify([{ url: `local://${gid}/1.png`, translated: true, files: ['translated/0001-1234abcd.png'] }]));
      put('images/0001.png', png(1));
      put('translated/0001.png', png(66));   // obsolete: its description names another
      const ref = await fx.register('A');
      const found = await fx.lib.scan(ref.id);
      assert.deepEqual(found.problems.map(p => p.reason), ['missing-file']);
      assert.notDeepEqual(await fx.lib.read(gid, 1, 'translated'), png(66), 'never the obsolete translation');
    },
  },
  {
    name: 'a folder hidden before its changes were published has them published there in the background, and hiding waits for none',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Hidden soon');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      await fx.lib.setTitle(gid, 'Hidden, retitled');
      const at = await fx.lib.dirOf(gid);
      await fx.hide(ref);
      const title = () => { try { return JSON.parse(fs.readFileSync(path.join(at, 'metadata.json'), 'utf8')).title.english; } catch { return null; } };
      for (let i = 0; i < 100 && title() !== 'Hidden, retitled'; i++) await new Promise(r => setTimeout(r, 100));
      assert.equal(title(), 'Hidden, retitled', 'published while hidden');
      for (const read of Object.values(await readBoth(path.join(dir, 'A'), path.relative(path.join(dir, 'A'), at).split(path.sep).join('/')))) {
        assert.equal(read.meta.title.english, 'Hidden, retitled');
      }
    },
  },
  {
    // N1: the website retried a folder it remembered, gone meanwhile, for ever. Principle 2: a write
    // made the folder again where the gallery's was.
    name: 'a write to a gallery whose directory was taken away settles, refused, and never makes the directory again',
    async run({ dir, store, fx }) {
      const root = await opened(store, await fx.register('A'));
      const g = await root.reserve('Taken away', '1700000000001', null);
      await g.writeNew('images/0001', 'png', png(1));
      const at = path.join(dir, 'A', ...g.name.split('/'));
      fs.rmSync(at, { recursive: true });
      const refusedAs = (got) => got !== 'resolved' && got !== 'never settled';
      assert.ok(refusedAs(await settles(g.writeNew('translated/0001', 'png', png(2)))), 'refused (its directory is not there)');
      assert.ok(!fs.existsSync(at), 'not made again');
      assert.ok(refusedAs(await settles(g.publish({ manifest: { format: 'shiori-gallery', version: 2, galleryId: '1700000000001', generation: 2,
        writer: 'conformance', files: { pages: {}, covers: {} }, sizes: {} }, descriptions: {} }))), 'nor published there');
      assert.ok(!fs.existsSync(at), 'still not made again');
    },
  },
  {
    // Principle 2: only a reservation makes a directory a gallery's — with its first generation, its
    // manifest written last (generation 0: reserved, never taken for the gallery by a check until a
    // publication makes it whole — S12, review 4 F2). Its stable-named copies come with that publication.
    name: 'a reservation publishes the gallery\'s first generation, reserved: its directory names it from its manifest on, and is whole from its first publication',
    async run({ dir, store, fx }) {
      const root = await opened(store, await fx.register('A'));
      const g = await root.reserve('Reserved', '1700000000001', null);
      const m = await g.manifest();
      assert.equal(m.kind, 'ok');
      assert.deepEqual([m.value.galleryId, m.value.generation, Object.keys(m.value.files.pages)], ['1700000000001', 0, []]);
      const meta = path.join(dir, 'A', ...g.name.split('/'), 'metadata.json');
      assert.ok(!fs.existsSync(meta), 'nothing names it but its manifest');
      for (const read of Object.values(await readBoth(path.join(dir, 'A'), g.name))) assert.equal(read.kind, 'ok');
      const text = JSON.stringify({ galleryId: '1700000000001', title: { english: 'Reserved', japanese: '', pretty: '' } });
      const done = await g.publish({ manifest: { format: 'shiori-gallery', version: 2, galleryId: '1700000000001', generation: 1, writer: 'conformance',
        files: { pages: {}, covers: {} }, sizes: {} }, descriptions: { 'metadata.json': text } });
      assert.equal(done.generation, 1);
      assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).galleryId, '1700000000001', 'its metadata.json names it, for older readers');
    },
  },
  // ── Identity through the libraries (plan §5: T01, T02; D15, D16) ──
  {
    // T01: a library folder whose path came to hold another library's was read, scanned and adopted as
    // it, and what it adopted was written back into the original later.
    name: 'T01: another library folder at a library folder\'s path is never read, checked or adopted as it, and the original is found as it was',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Original');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      const rel = path.relative(path.join(dir, 'A'), await fx.lib.dirOf(gid));
      fs.renameSync(path.join(dir, 'A'), path.join(dir, 'A aside'));
      // Another library's folder at its path, holding a copy of the gallery (its id kept) with other
      // bytes and another title, in format v1.
      fs.cpSync(path.join(dir, 'A aside'), path.join(dir, 'A'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'A', '.shiori', 'library.json'), JSON.stringify({ format: 'shiori-library', version: 1, id: otherId() }));
      const copy = path.join(dir, 'A', rel);
      fs.rmSync(path.join(copy, '.shiori'), { recursive: true });
      fs.writeFileSync(path.join(copy, 'metadata.json'), JSON.stringify({ galleryId: gid, title: { english: 'OTHER LIBRARY TITLE', japanese: '', pretty: '' } }));
      fs.writeFileSync(path.join(copy, 'images', '0001.png'), png(66));
      assert.equal((await fx.lib.list()).find(f => f.id === ref.id).access, 'other-library', 'listed so');
      assert.notDeepEqual(await fx.lib.read(gid, 1), png(66), 'its page is never read from there');
      await assert.rejects(fx.lib.scan(ref.id), (e) => e.reason === 'other-library', 'nor the folder checked');
      assert.equal(await fx.lib.titleOf(gid), 'Original', 'nor anything adopted');
      // The original back: an ordinary change is published there, from what the library had.
      fs.rmSync(path.join(dir, 'A'), { recursive: true });
      fs.renameSync(path.join(dir, 'A aside'), path.join(dir, 'A'));
      assert.equal((await fx.lib.list()).find(f => f.id === ref.id).access, 'granted');
      await fx.lib.setTitle(gid, 'Original, edited');
      await fx.lib.flush();
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'A', rel, 'metadata.json'), 'utf8')).title.english, 'Original, edited');
      assert.deepEqual(await fx.lib.read(gid, 1), png(1));
    },
  },
  {
    // T02: a description written into a folder put where a gallery's was made it the gallery's, and
    // the gallery's deletion then deleted it.
    name: 'T02: a folder put where a gallery\'s was is never written to as the gallery\'s, is reported, and is never deleted with it',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Replaced');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      const at = /** @type {string} */ (await fx.lib.dirOf(gid));
      fs.renameSync(at, path.join(dir, 'moved aside'));
      fs.mkdirSync(at);
      fs.writeFileSync(path.join(at, 'personal-notes.txt'), 'mine');
      await fx.lib.setTitle(gid, 'Replaced, retitled');
      await fx.lib.flush();
      assert.deepEqual(fs.readdirSync(at), ['personal-notes.txt'], 'no description written there');
      const found = await fx.lib.scan(ref.id);
      assert.ok(found.problems.some(p => p.reason === 'conflict'), 'reported by the check');
      const listed = (await fx.lib.list()).find(f => f.id === ref.id);
      assert.ok(listed.attention.some(i => i.reason === 'conflict' && i.gid === gid), 'on its folder\'s Needs attention list');
      await fx.lib.deleteGallery(gid);
      await new Promise(r => setTimeout(r, 300));   // what a deletion leaves to do, once it commits
      assert.deepEqual(fs.readdirSync(at), ['personal-notes.txt'], 'nor deleted with the gallery');
      assert.ok(fs.existsSync(path.join(dir, 'moved aside', 'images', '0001.png')), 'and the gallery\'s own folder, moved aside, is left');
    },
  },
  // ── Deleting (plan §5: T12; principles 4 and 8, D3; N2, N4: §10 S2, S6) ──
  {
    // T12: a gallery deleted while its folder's drive was away was forgotten by the index, and came back
    // with the drive.
    name: 'T12: deleting a gallery whose library folder can\'t be reached is refused (unavailable) and changes nothing; with the folder back, deleted, it is gone for good',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Away');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      const at = /** @type {string} */ (await fx.lib.dirOf(gid));
      fs.renameSync(path.join(dir, 'A'), path.join(dir, 'A away'));
      await fx.lib.list();
      await assert.rejects(fx.lib.deleteGallery(gid), (e) => e.code === 'unavailable' && e.reason === 'unavailable');
      assert.ok((await fx.lib.galleries()).includes(gid), 'the gallery stays');
      fs.renameSync(path.join(dir, 'A away'), path.join(dir, 'A'));
      await fx.lib.list();
      await fx.lib.scan(ref.id);
      assert.deepEqual(await fx.lib.read(gid, 1), png(1), 'and reads as it was once its folder is back');
      await fx.lib.deleteGallery(gid);
      await until(() => !fs.existsSync(at));
      await fx.lib.scan(ref.id);
      assert.deepEqual(await fx.lib.galleries(), [], 'gone for good');
    },
  },
  {
    name: 'a library folder that can\'t be reached is removed when nothing waits to be saved there, and refused (unsaved) while something does',
    async run({ dir, fx }) {
      const [a, b] = [await fx.register('A'), await fx.register('B')];
      const made = [];
      for (const [ref, name] of [[a, 'In A'], [b, 'In B']]) {
        await fx.lib.setDefault(ref.id);
        made.push(await fx.lib.newGallery(name));
        await fx.lib.putPage(made[made.length - 1], 1, png(1));
      }
      const [inA] = made;
      await fx.lib.setDefault(fx.lib.home);
      await fx.lib.flush();
      fs.renameSync(path.join(dir, 'A'), path.join(dir, 'A away'));
      fs.renameSync(path.join(dir, 'B'), path.join(dir, 'B away'));
      await fx.lib.list();
      await fx.lib.setTitle(inA, 'Changed while away');   // committed here, not saved to its folder
      await assert.rejects(fx.lib.remove(a.id), (e) => e.reason === 'unsaved');
      assert.ok((await fx.lib.list()).some(f => f.id === a.id), 'kept');
      await fx.lib.remove(b.id);
      assert.ok(!(await fx.lib.list()).some(f => f.id === b.id), 'removed');
    },
  },
  {
    // N2: a gallery deleted just before the app closed came back, its folder deleted after the commit
    // and never; N4: one deleted just before a check was adopted again from its half-deleted folder.
    name: 'N2, N4: a deletion cut short is finished from its record — a check meanwhile never adopts what is left of the folder — and the rest goes by name at the next start',
    async run({ dir, fx, platform }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Cut short');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.putPage(gid, 2, png(2));
      await fx.lib.flush();
      const at = /** @type {string} */ (await fx.lib.dirOf(gid));
      const second = `${path.relative(path.join(dir, 'A'), at).split(path.sep).join('/')}/images/0002.png`;
      const undo = platform === 'website'
        ? fsa.failNext((c) => c.op === 'removeEntry' && c.path === second, 'NoModificationAllowedError', { times: Infinity })
        : faults.failNext((c) => c.op === 'rm' && c.path.toLowerCase().endsWith(`/${second.toLowerCase()}`), 'EBUSY', { times: Infinity });
      try {
        await fx.lib.deleteGallery(gid);
        await until(() => !fs.existsSync(path.join(at, 'images', '0001.png')));
        // What named it gone too, as a deletion cut short by a crash could leave it: a folder of pictures.
        for (const f of ['.shiori', 'metadata.json', 'image_records.json']) fs.rmSync(path.join(at, f), { recursive: true, force: true });
        assert.equal((await fx.lib.scan(ref.id)).added, 0, 'nothing of it joins');
        assert.deepEqual(await fx.lib.galleries(), []);
      } finally { undo(); }
      if (fx.lib.restart) await fx.lib.restart(); else await fx.lib.raw.foldersPending();   // the next start
      await until(() => !fs.existsSync(at));
      assert.equal((await fx.lib.scan(ref.id)).added, 0);
      assert.deepEqual(await fx.lib.galleries(), []);
    },
  },
  {
    // S8 (the long runs, desktop seed 1985028742): a gallery deleted while its publication was under way
    // came back at the next check, from the manifest that publication wrote after the deletion.
    name: 'a gallery deleted while its publication is under way stays deleted: its folder goes, and a check adopts nothing',
    async run({ fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Busy');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      const at = /** @type {string} */ (await fx.lib.dirOf(gid));
      // The next publication held as it opens the folder, until the gallery is deleted.
      /** @type {() => void} */ let release = () => {}, reached = () => {};
      const held = new Promise((r) => { reached = r; }), gate = new Promise((r) => { release = r; });
      const store = /** @type {any} */ (fx.store), open = store.open;
      store.open = async (/** @type {any} */ folder, /** @type {any} */ options) => {
        if (options?.purpose === 'publish') { reached(); await gate; }
        return open.call(store, folder, options);
      };
      try {
        await fx.lib.setTitle(gid, 'Busy, renamed');
        const publishing = fx.lib.flush();
        await held;
        await fx.lib.deleteGallery(gid);
        release();
        await publishing;
      } finally { store.open = open; }
      await until(() => !fs.existsSync(at));
      await fx.lib.scan(ref.id);
      assert.deepEqual(await fx.lib.galleries(), [], 'it doesn\'t come back');
    },
  },
  {
    // S8 (the orchestrator after S7): what the deletion left joined the library again at the next check,
    // as a new gallery of linked pictures.
    name: 'a gallery\'s deletion takes only what Shiori recorded writing: a person\'s own file in its folder, and a picture changed since, stay, and the folder with them — reported once, and never joining the library',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Mine too');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.putPage(gid, 2, png(2));
      await fx.lib.flush();
      const at = /** @type {string} */ (await fx.lib.dirOf(gid));
      fs.writeFileSync(path.join(at, 'notes.txt'), 'mine');
      fs.writeFileSync(path.join(at, 'images', '0002.png'), png(2, 2));   // changed outside Shiori
      fs.mkdirSync(path.join(at, 'extras'));
      fs.writeFileSync(path.join(at, 'extras', 'sketch.png'), png(30));   // a person's own picture
      await fx.lib.deleteGallery(gid);
      await until(() => !fs.existsSync(path.join(at, '.shiori', 'gallery.json')));
      assert.ok(!fs.existsSync(path.join(at, 'images', '0001.png')) && !fs.existsSync(path.join(at, 'metadata.json')), 'its own files go');
      assert.equal(fs.readFileSync(path.join(at, 'notes.txt'), 'utf8'), 'mine');
      assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(at, 'images', '0002.png'))), png(2, 2));
      const rel = path.relative(path.join(dir, 'A'), at).split(path.sep).join('/');
      const left = async () => (await fx.lib.list()).find(f => f.id === ref.id).attention.filter(a => a.reason === 'left');
      await until(async () => (await left()).length > 0);
      for (let i = 0; i < 2; i++) {
        await fx.lib.scan(ref.id);
        assert.deepEqual(await fx.lib.galleries(), [], 'what is left never joins the library');
        assert.deepEqual((await left()).map(a => a.path), [rel], 'reported once, the folder named');
      }
      // Forgotten and added again, the folder says so itself (removed.json).
      await fx.lib.remove(ref.id);
      const again = await fx.lib.add(path.join(dir, 'A'));
      await fx.lib.scan(again);
      assert.deepEqual(await fx.lib.galleries(), []);
      // A picture added there later is new: it joins.
      fs.writeFileSync(path.join(at, 'extras', 'more.png'), png(31));
      await fx.lib.scan(again);
      assert.equal((await fx.lib.galleries()).length, 1);
    },
  },
  {
    // D4 at publication: another app published a newer generation while this app had a change waiting.
    name: 'a publication over another app\'s newer generation keeps this app\'s change and is reported on the folder\'s Needs attention list (changed-both)',
    async run({ fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Both');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      const at = /** @type {string} */ (await fx.lib.dirOf(gid));
      const file = path.join(at, '.shiori', 'gallery.json');
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...m, generation: m.generation + 1, writer: 'a1b2c3d4e5f60708' }));   // the other app's
      await fx.lib.setTitle(gid, 'Kept here');
      await fx.lib.flush();
      const items = () => fx.lib.list().then(l => l.find(f => f.id === ref.id).attention.filter(i => i.reason === 'changed-both'));
      assert.deepEqual((await items()).map(i => i.gid), [gid]);
      assert.equal(JSON.parse(fs.readFileSync(path.join(at, 'metadata.json'), 'utf8')).title.english, 'Kept here');
      await fx.lib.scan(ref.id);
      assert.equal((await items()).length, 1, 'a check keeps what happened once');
      const [item] = await items();
      await fx.lib.dismiss(ref.id, item);
      assert.deepEqual(await items(), [], 'until it is dismissed');
    },
  },
  {
    // D16: leftovers nothing refers to are reported, never deleted (Shiori deletes only what it recorded).
    name: 'D16: a picture in a gallery\'s folder that nothing refers to is reported on its folder\'s Needs attention list, and left',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Leftover');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      const at = /** @type {string} */ (await fx.lib.dirOf(gid));
      const stray = path.join(at, 'translated', '0007.png');
      fs.mkdirSync(path.dirname(stray), { recursive: true });
      fs.writeFileSync(stray, png(9));
      const old = new Date(Date.now() - 3600_000);
      fs.utimesSync(stray, old, old);
      await fx.lib.scan(ref.id);
      const where = `${path.relative(path.join(dir, 'A'), at).split(path.sep).join('/')}/translated/0007.png`;
      const items = () => fx.lib.list().then(l => l.find(f => f.id === ref.id).attention.filter(i => i.reason === 'unreferenced'));
      assert.deepEqual((await items()).map(i => [i.path, i.gid]), [[where, gid]]);
      assert.ok(fs.existsSync(stray), 'left as it is');
      fs.rmSync(stray);
      await fx.lib.scan(ref.id);
      assert.deepEqual(await items(), [], 'a check that no longer finds it takes it off');
    },
  },
  // ── Containment (the desktop: links are visible to it) ──
  {
    // T04: a check's tidy-up and a linked gallery's deletion reached outside the folder through junctions.
    name: 'T04: a check never tidies through a junction in a gallery\'s folder, and a deletion never writes or deletes through a junction at .shiori/linked',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const A = path.join(dir, 'A');
      const outside = path.join(dir, 'outside');
      // (a) An unrelated picture outside, two hours old, reached through a junction at a gallery's translated/.
      const gid = await fx.lib.newGallery('Native');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'unrelated.png'), png(7));
      const old = new Date(Date.now() - 2 * 3600_000);
      fs.utimesSync(path.join(outside, 'unrelated.png'), old, old);
      faults.junction(outside, path.join(/** @type {string} */ (await fx.lib.dirOf(gid)), 'translated'));
      // (b) A linked gallery, its overlay copied outside with notes in it, and .shiori/linked a junction there.
      fs.mkdirSync(path.join(A, 'Pics'));
      fs.writeFileSync(path.join(A, 'Pics', '001.png'), png(2));
      await fx.lib.scan(ref.id);
      const linkedGid = (await fx.lib.galleries()).find(g => g !== gid);
      assert.ok(linkedGid, 'the folder of pictures joined');
      const linked = path.join(outside, 'linked');
      fs.cpSync(path.join(A, '.shiori', 'linked'), linked, { recursive: true });
      fs.writeFileSync(path.join(linked, String(linkedGid), 'notes.txt'), 'mine');
      fs.renameSync(path.join(A, '.shiori', 'linked'), path.join(dir, 'linked aside'));
      faults.junction(linked, path.join(A, '.shiori', 'linked'));
      await fx.lib.scan(ref.id);
      assert.ok(fs.existsSync(path.join(outside, 'unrelated.png')), '(a) nothing outside is tidied');
      await fx.lib.deleteGallery(String(linkedGid));
      await new Promise(r => setTimeout(r, 300));
      assert.ok(!fs.existsSync(path.join(linked, 'removed.json')), '(b) no note written outside');
      assert.ok(fs.existsSync(path.join(linked, String(linkedGid), 'notes.txt')), '(b) nothing deleted outside');
    },
  },
  {
    name: 'a junction in a gallery\'s own subfolder is never followed: nothing outside is written or swept',
    platforms: ['desktop'],
    async run({ dir, store, fx }) {
      const root = await opened(store, await fx.register('A'));
      const g = await root.reserve('Linked out', '1700000000001', null);
      const outside = path.join(dir, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'unrelated.png'), png(7));
      const hourAgo = new Date(Date.now() - 2 * 3600_000);
      fs.utimesSync(path.join(outside, 'unrelated.png'), hourAgo, hourAgo);
      faults.junction(outside, path.join(dir, 'A', ...g.name.split('/'), 'translated'));
      await g.sweep({ olderThan: 0, reserved: [] });
      assert.ok(fs.existsSync(path.join(outside, 'unrelated.png')), 'swept nothing outside');
      await assert.rejects(g.writeNew('translated/0001', 'png', png(1)));
      assert.deepEqual(fs.readdirSync(outside), ['unrelated.png'], 'wrote nothing outside');
    },
  },
  {
    name: 'a source reached through a junction leading out of the folder is outside',
    platforms: ['desktop'],
    async run({ dir, store, fx }) {
      const root = await opened(store, await fx.register('A'), 'read');
      fs.mkdirSync(path.join(dir, 'elsewhere'));
      fs.writeFileSync(path.join(dir, 'elsewhere', '001.png'), png(1));
      faults.junction(path.join(dir, 'elsewhere'), path.join(dir, 'A', 'Pictures'));
      assert.deepEqual(await root.source('Pictures'), { kind: 'outside' });
    },
  },
  // ── Reading a gallery's pictures ──
  {
    // S5 checked a read against the library folder's identity only: a gallery's folder swapped by hand,
    // inside a library folder still its own, served whatever the folder put there held.
    name: 'a gallery\'s folder swapped by hand for another gallery\'s stops serving pictures within a few seconds, and never serves that gallery\'s as its own after',
    async run({ dir, fx }) {
      await fx.register('A');
      const one = await fx.lib.newGallery('One'), two = await fx.lib.newGallery('Two');
      await fx.lib.putPage(one, 1, png(1));
      await fx.lib.putPage(two, 1, png(2));
      await fx.lib.flush();
      const at = /** @type {string} */ (await fx.lib.dirOf(one));
      fs.renameSync(at, path.join(dir, 'One aside'));
      fs.cpSync(/** @type {string} */ (await fx.lib.dirOf(two)), at, { recursive: true });
      const swapped = Date.now();
      // A gallery's folder found to name it is taken to for reads for two seconds (both apps; plan §8).
      while (await fx.lib.read(one, 1) != null) {
        assert.ok(Date.now() - swapped < 8000, 'still read after 8 s');
        await new Promise(r => setTimeout(r, 200));
      }
      assert.equal(await fx.lib.read(one, 1, 'translated'), null);
      assert.deepEqual(await fx.lib.read(two, 1), png(2), 'the other gallery reads its own');
      fs.rmSync(at, { recursive: true });
      fs.renameSync(path.join(dir, 'One aside'), at);
      assert.deepEqual(await fx.lib.read(one, 1), png(1), 'its own folder back: read at once');
    },
  },
  {
    // F4 (S10 review): a gallery's folder renamed by hand, then the gallery deleted — the deletion's
    // record named the old path, found nothing there and was dropped, and the next check adopted the
    // renamed folder by its id.
    name: 'F4: a gallery deleted after its folder was renamed by hand stays deleted: a check deletes the renamed folder by name, never adopting it',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Renamed');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      const at = /** @type {string} */ (await fx.lib.dirOf(gid));
      const renamed = path.join(dir, 'A', 'Renamed by hand');
      fs.renameSync(at, renamed);
      fs.writeFileSync(path.join(renamed, 'notes.txt'), 'mine');
      await fx.lib.deleteGallery(gid);
      await new Promise(r => setTimeout(r, 300));   // what a deletion leaves to do, once it commits
      await fx.lib.scan(ref.id);
      assert.deepEqual(await fx.lib.galleries(), [], 'not adopted');
      assert.ok(!fs.existsSync(path.join(renamed, 'images', '0001.png')) && !fs.existsSync(path.join(renamed, 'metadata.json')), 'its files deleted by name');
      assert.equal(fs.readFileSync(path.join(renamed, 'notes.txt'), 'utf8'), 'mine', 'a person\'s file stays');
      await fx.lib.scan(ref.id);
      assert.deepEqual(await fx.lib.galleries(), []);
    },
  },
  {
    // O3 (S10 review): a gallery's folder copied by hand inside its library folder was left out of the
    // library without a word.
    name: 'O3: a copy of a gallery\'s folder made by hand is reported on its folder\'s Needs attention list, and left',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Copied');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      fs.cpSync(/** @type {string} */ (await fx.lib.dirOf(gid)), path.join(dir, 'A', 'Copied (copy)'), { recursive: true });
      const found = await fx.lib.scan(ref.id);
      assert.deepEqual(found.problems.map(p => [p.reason, p.path]), [['duplicate', 'Copied (copy)']]);
      assert.deepEqual(await fx.lib.galleries(), [gid]);
      const listed = (await fx.lib.list()).find(f => f.id === ref.id);
      assert.ok(listed.attention.some(i => i.reason === 'duplicate' && i.path === 'Copied (copy)'), 'on its Needs attention list');
      assert.ok(fs.existsSync(path.join(dir, 'A', 'Copied (copy)', 'images', '0001.png')), 'left as it is');
    },
  },
  {
    // F6 (S10 review): an archived gallery's deletion took its archive whole while its descriptions
    // named the gallery — with the files the person had added to it.
    name: 'F6: an archived gallery\'s archive the person added a file to is left whole by its deletion, reported, and never adopted again',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Archived');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]);
      const file = fx.lib.raw.files._abs(fx.lib.raw._s('SELECT path FROM files WHERE gid = ?').get(gid).path);
      await addToArchive(file, 'notes.txt', new TextEncoder().encode('mine'));
      const edited = fs.readFileSync(file);
      await fx.lib.deleteGallery(gid);
      await until(async () => (await fx.lib.list()).find(f => f.id === ref.id).attention.some(a => a.reason === 'left'));
      assert.deepEqual(fs.readFileSync(file), edited, 'the archive stays as the person left it');
      for (let i = 0; i < 2; i++) {
        await fx.lib.scan(ref.id);
        assert.deepEqual(await fx.lib.galleries(), [], 'never adopted again');
      }
      // Its own archive, unchanged, goes whole.
      const other = await fx.lib.newGallery('Untouched');
      await fx.lib.putPage(other, 1, png(2));
      await fx.lib.flush();
      await fx.lib.raw.archiveGallery(other);
      const kept = fx.lib.raw.files._abs(fx.lib.raw._s('SELECT path FROM files WHERE gid = ?').get(other).path);
      await fx.lib.deleteGallery(other);
      await until(() => !fs.existsSync(kept));
      assert.ok(fs.existsSync(path.join(dir, 'A')));
    },
  },
  {
    // F1 (S10 review, the website): which folder a library folder's path holds, found granted, was
    // taken as it was for five seconds for writes and checks too — so another library put at the path a
    // moment after a write took the next one, and a check adopted its galleries.
    name: 'F1: another library put at a library folder\'s path a moment after a write takes no write, and a check then adopts none of its galleries',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Original');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      const A = path.join(dir, 'A');
      fs.renameSync(A, path.join(dir, 'A aside'));
      // Another library's folder at its path at once: a copy (the gallery's folder in it naming the
      // gallery), with a folder of pictures a check would add.
      fs.cpSync(path.join(dir, 'A aside'), A, { recursive: true });
      fs.writeFileSync(path.join(A, '.shiori', 'library.json'), JSON.stringify({ format: 'shiori-library', version: 1, id: otherId() }));
      fs.mkdirSync(path.join(A, 'Theirs'));
      fs.writeFileSync(path.join(A, 'Theirs', '001.png'), png(50));
      const before = snapshot(A);
      await fx.lib.putPage(gid, 2, png(2));
      await assert.rejects(fx.lib.scan(ref.id), (e) => e.reason === 'other-library', 'nor the folder checked');
      await fx.lib.flush().catch(() => {});
      assert.deepEqual(snapshot(A), before, 'nothing written to the other library');
      assert.deepEqual(await fx.lib.galleries(), [gid], 'nothing of it adopted');
      // The original back: the page written meanwhile goes there.
      fs.rmSync(A, { recursive: true });
      fs.renameSync(path.join(dir, 'A aside'), A);
      await fx.lib.flush();
      assert.deepEqual(await fx.lib.read(gid, 2), png(2));
      assert.ok(fs.readdirSync(path.join(/** @type {string} */ (await fx.lib.dirOf(gid)), 'images')).length === 2, 'both pages in its folder');
    },
  },
  {
    // F2 (S10 review, the website): a gallery's folder found to name it was taken to for five seconds for
    // writes too — so a folder swapped by hand for another gallery's a moment after a write took the next
    // picture as this gallery's.
    name: 'F2: a gallery\'s folder swapped by hand for another gallery\'s a moment after a write takes none of this gallery\'s pictures',
    async run({ dir, fx }) {
      await fx.register('A');
      const one = await fx.lib.newGallery('One'), two = await fx.lib.newGallery('Two');
      await fx.lib.putPage(one, 1, png(1));
      await fx.lib.putPage(two, 1, png(2));
      await fx.lib.flush();
      await fx.lib.putPage(one, 2, png(3));
      const at = /** @type {string} */ (await fx.lib.dirOf(one));
      fs.renameSync(at, path.join(dir, 'One aside'));
      fs.cpSync(/** @type {string} */ (await fx.lib.dirOf(two)), at, { recursive: true });
      const before = snapshot(at);
      await fx.lib.putPage(one, 3, png(4));
      assert.deepEqual(snapshot(at), before, 'the other gallery\'s folder takes nothing');
      assert.deepEqual(await fx.lib.read(two, 1), png(2));
      fs.rmSync(at, { recursive: true });
      fs.renameSync(path.join(dir, 'One aside'), at);
      await fx.lib.flush();
      assert.deepEqual([await fx.lib.read(one, 1), await fx.lib.read(one, 2), await fx.lib.read(one, 3)], [png(1), png(3), png(4)]);
    },
  },
  // ── "Not found" is not proof (review 4: F1, F3, F9) ──
  // A drive away for a moment answers "not found" for what is there: such an answer, with the next call
  // working again, must never delete anything or change what the library records.
  {
    // F1 (review 4, the website): a listing of the pictures' folder that answered "not found" was taken
    // for an empty folder, which the tidy-up after a picture retired deleted with everything in it.
    name: 'review 4 F1: a listing of a gallery\'s pictures that answers "not found" once deletes none of them',
    platforms: ['website'],
    async run({ dir, fx }) {
      await fx.register('A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      await fx.lib.putPage(gid, 1, webp(9), 'image/webp');   // downloaded again in another format: its old picture retires
      fsa.failNext((c) => c.op === 'entries' && c.path === 'Alpha/images', 'NotFoundError', { times: 1 });
      await fx.lib.flush();
      assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 2), await fx.lib.read(gid, 3)], [webp(9), png(2), png(3)]);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'A', 'Alpha', 'images')).sort(), ['0001.webp', '0002.png', '0003.png']);
    },
  },
  {
    // F1 (review 4, the website): the same at the end of a gallery's deletion took the person's file in
    // its folder with it.
    name: 'review 4 F1: a listing of a deleted gallery\'s folder that answers "not found" once leaves the person\'s file in it, reported',
    platforms: ['website'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      const mine = path.join(dir, 'A', 'Alpha', 'my-notes.txt');
      fs.writeFileSync(mine, 'the person\'s own file');
      fsa.failNext((c) => c.op === 'entries' && c.path === 'Alpha', 'NotFoundError', { times: 1 });
      await fx.lib.deleteGallery(gid);
      await fx.lib.flush();
      await until(async () => (await fx.lib.list()).find(f => f.id === ref.id).attention.some(a => a.reason === 'left'));
      assert.equal(fs.readFileSync(mine, 'utf8'), 'the person\'s own file');
      assert.deepEqual(await fx.lib.galleries(), []);
    },
  },
  {
    // F3 (review 4): one description's read answering "not found" during a deletion left it there,
    // naming the gallery, while the deletion was recorded done; the next check brought the gallery back.
    name: 'review 4 F3: a deletion in which a description\'s read answers "not found" once stays recorded until the folder no longer names the gallery, which never comes back',
    async run({ dir, fx, platform }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      if (platform === 'desktop') faults.failNext((c) => c.op === 'readFile' && c.path.endsWith('/A/Alpha/metadata.json'), 'ENOENT', { times: 1 });
      else fsa.failNext((c) => c.op === 'getFile' && c.path === 'Alpha/metadata.json', 'NotFoundError', { times: 1 });
      await fx.lib.deleteGallery(gid);
      await fx.lib.flush();
      await new Promise(r => setTimeout(r, 300));   // what a deletion leaves to do, once it commits
      assert.deepEqual(await fx.lib.galleries(), []);
      for (let i = 0; i < 2; i++) {
        const found = await fx.lib.scan(ref.id);
        assert.deepEqual([found.added, await fx.lib.galleries()], [0, []], 'the deleted gallery never comes back');
      }
      assert.ok(!fs.existsSync(path.join(dir, 'A', 'Alpha')), 'its folder deleted once its files read again');
    },
  },
  {
    // F9 (review 4, the desktop): a retiring picture whose deletion answered "not found" was forgotten,
    // left behind archiving, and the next check added its folder as a new gallery.
    name: 'review 4 F9: a picture an archiving retires whose deletion answers "not found" once is kept on record and deleted later, never joining as a gallery',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      faults.failNext((c) => c.op === 'rm' && c.path.endsWith('/A/Alpha/images/0002.png'), 'ENOENT', { times: 1 });
      assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]);
      await new Promise(r => setTimeout(r, 300));
      const found = await fx.lib.scan(ref.id);
      assert.deepEqual([found.added, await fx.lib.galleries()], [0, [gid]], 'nothing joins from what was left');
      await until(() => !fs.existsSync(path.join(dir, 'A', 'Alpha')));
      assert.deepEqual(await fx.lib.read(gid, 2), png(2));
    },
  },
  // ── The second look asks the library folder, not the file (review 5: F2, F3, T-D) ──
  // A drive that leaves answers "not found" for everything on it for as long as it is away, a second
  // look at the same file included: such an answer counts only while the library folder is there, as
  // itself (contract.js surelyMissing).
  {
    // F2 (review 5): the drive away for the length of a deletion: every picture, the descriptions and
    // the folder itself answered "not found" twice, and the deletion was recorded done; with the drive
    // back, the folder still held the gallery whole, and the next check added it again with every page.
    name: 'review 5 F2: a deletion the drive is away for stays recorded: with the drive back the folder goes, and the deleted gallery never comes back',
    async run({ dir, fx, platform }) {
      const ref = await fx.register('A');
      const A = path.join(dir, 'A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      const back = driveAway(platform, A, (c) => (platform === 'desktop' ? c.op === 'stat' && c.path.endsWith('/A/Alpha/images/0001.png')
        : c.op === 'getFile' && c.path === 'Alpha/images/0001.png'));
      await fx.lib.deleteGallery(gid);
      await fx.lib.flush();
      await new Promise(r => setTimeout(r, 300));   // what a deletion leaves to do, once it commits
      back();
      assert.deepEqual(await fx.lib.galleries(), []);
      for (let i = 0; i < 2; i++) {
        const found = await fx.lib.scan(ref.id);
        assert.deepEqual([found.added, await fx.lib.galleries()], [0, []], 'the deleted gallery never comes back');
      }
      await until(() => !fs.existsSync(path.join(A, 'Alpha')));
      assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 3)], [null, null]);
    },
  },
  {
    // F3 (a) (review 5, the desktop): the drive away while archiving retired the gallery's old folder:
    // every file answered "not found" twice, its rows were forgotten, and with the drive back the old
    // folder stayed for good beside the archive, reported as a copy at every check.
    name: 'review 5 F3: a retirement the drive is away for stays recorded: with the drive back the old folder goes, never reported as a copy',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const A = path.join(dir, 'A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      const back = driveAway('desktop', A, (c) => c.op === 'stat' && c.path.endsWith('/A/Alpha/images/0001.png') && fs.existsSync(path.join(A, 'Alpha.zip')));
      assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]);
      await new Promise(r => setTimeout(r, 300));
      back();
      assert.ok(fx.lib.raw._s('SELECT 1 FROM retiring').get(), 'what waits to retire is still recorded');
      for (let i = 0; i < 2; i++) assert.deepEqual((await fx.lib.scan(ref.id)).problems, [], 'nothing reported');
      await until(() => !fs.existsSync(path.join(A, 'Alpha')));
      assert.deepEqual([await fx.lib.galleries(), await fx.lib.read(gid, 1), await fx.lib.read(gid, 3)], [[gid], png(1), png(3)]);
    },
  },
  {
    // F3 (b) (review 5, the desktop): a retiring picture whose stat and second look both answered "not
    // found" (the library folder there) was forgotten and left in the old folder, reported 'left' — and
    // the next check added that folder's pictures as a gallery "images", as F9 did. What a retirement
    // leaves is now noted as removed, as a deletion's is.
    name: 'review 5 F3: a picture a retirement leaves after two "not found" answers is reported and never joins as a gallery',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      let seen = 0;   // the archiving's own three stats of it, then the retirement's and its second look
      faults.failNext((c) => c.op === 'stat' && c.path.endsWith('/A/Alpha/images/0002.png') && ++seen > 3, 'ENOENT', { times: 2 });
      assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]);
      await new Promise(r => setTimeout(r, 300));
      faults.reset();
      await until(async () => (await fx.lib.list()).find(f => f.id === ref.id).attention.some(a => a.reason === 'left' && a.path === 'Alpha'));
      for (let i = 0; i < 2; i++) {
        const found = await fx.lib.scan(ref.id);
        assert.deepEqual([found.added, await fx.lib.galleries()], [0, [gid]], 'nothing joins from what was left');
      }
      assert.ok(fs.existsSync(path.join(dir, 'A', 'Alpha', 'images', '0002.png')), 'left as it is');
      assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 2)], [png(1), png(2)]);
    },
  },
  {
    // T-D (review 5, "Not reproduced", the desktop): a translation staged while its gallery was archived,
    // moved in by the unpack: the drive away for both looks at the staged picture (back a moment later)
    // dropped its record, the picture still in staging — the translation lost. The review's run with the
    // drive away for longer was saved by the next call failing; this one isn't.
    name: 'review 5 T-D: a staged translation the drive is away for a moment at is kept and moved in later',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      await fx.register('A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]);
      await new Promise(r => setTimeout(r, 300));
      const back = driveAway('desktop', path.join(dir, 'A'), (c) => c.op === 'stat' && /\/A\/\.shiori\/staging\/.+\.png$/.test(c.path), { backAfter: 2 });
      await fx.lib.putTranslation(gid, 2, png(9));
      await fx.lib.flush();
      await new Promise(r => setTimeout(r, 300));
      back();
      await fx.lib.flush();
      assert.deepEqual([await fx.lib.read(gid, 2, 'translated'), await fx.lib.read(gid, 1)], [png(9), png(1)]);
      await fx.lib.restart();
      assert.deepEqual([await fx.lib.read(gid, 2, 'translated'), await fx.lib.read(gid, 3)], [png(9), png(3)]);
    },
  },
  {
    // Found by the sweeps' drive away (S18, the desktop): a gallery's folder reserved at the library
    // folder's top while its drive was away made the library folder itself again, empty but for that
    // gallery's — so the drive's own folder could never come back to its path.
    name: 'S18: a gallery\'s first write while its library folder\'s drive is away never makes the library folder again',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      await fx.register('A');
      const A = path.join(dir, 'A');
      const gid = await fx.lib.newGallery('Alpha');
      // Away at the reservation's look at the library folder itself (it made it, with `recursive`).
      const back = driveAway('desktop', A, (c) => (c.op === 'mkdir' || c.op === 'stat') && c.path.endsWith('/A'));
      await fx.lib.putPage(gid, 1, png(1)).catch(() => {});
      await fx.lib.flush();
      back();   // it can come back: nothing was made at its path
      await fx.lib.putPage(gid, 2, png(2));
      await fx.lib.flush();
      assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 2)], [png(1), png(2)]);
      assert.ok(fs.existsSync(path.join(A, 'Alpha', 'images')));
    },
  },
  {
    // Found by the sweeps' drive away (S18, the desktop): a move within a drive whose destination's drive
    // left just after the rename — the switch refused, the rename back impossible — read nothing once the
    // drive was back, until the next start finished the move it had recorded.
    name: 'S18: a move whose destination\'s drive leaves just after the rename is finished once the drive is back',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      const a = await fx.register('A');
      await fx.register('B');
      const A = path.join(dir, 'A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 2; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      const back = driveAway('desktop', A, (c) => c.op === 'readFile' && c.path.endsWith('/A/.shiori/library.json') && fs.existsSync(path.join(A, 'Alpha')));
      await fx.lib.move(gid, a.id).catch(() => {});
      back();
      assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 2)], [png(1), png(2)]);
      assert.equal(await fx.lib.dirOf(gid), path.join(A, 'Alpha'));
    },
  },
  {
    // Found by S18's check for copies in the sweeps (S21, the desktop): deleting the archive an unpack let go,
    // one read of it failing for a moment was taken for the person's edit — the archive stayed beside the
    // gallery's folder for good, reported 'left' and as a copy at every check. Both kinds: an archived
    // gallery's archive (checked against its manifest) and an earlier version's (against what the unpack took).
    name: 'S21: an archive an unpack let go whose read fails for a moment is deleted later, never left as the person\'s',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const A = path.join(dir, 'A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]);
      const { writeZip } = await import('../../desktop/server/zip.js');
      const old = '1790000000077', file = (/** @type {number} */ n) => `000${n}.png`;
      await writeZip(path.join(A, 'Old.cbz'), [...[1, 2, 3].map(n => ({ name: file(n), data: png(n) })),
        { name: 'shiori.json', data: new TextEncoder().encode(JSON.stringify({ format: 'shiori-gallery', version: 1, id: old,
          meta: { galleryId: old, title: { english: 'Old', japanese: '', pretty: '' }, tags: [], numPages: 3 },
          pages: [1, 2, 3].map(n => ({ n, file: file(n), key: `local://${old}/${n}.png` })) })) }]);
      assert.equal((await fx.lib.scan(ref.id)).added, 1);
      // Each archive's first look at itself in its deletion fails once (EIO), then reads again.
      const failed = new Set();
      const undo = faults.failNext((c) => {
        const name = c.op === 'stat' && /\/A\/(Alpha\.zip|Old\.cbz)$/.test(c.path) && /_archiveUnchanged/.test(String(new Error().stack)) && path.basename(c.path);
        if (!name || failed.has(name)) return false;
        failed.add(name);
        return true;
      }, 'EIO', { times: Infinity });
      try {
        for (const g of [gid, old]) await fx.lib.putTranslation(g, 2, png(9));
        await fx.lib.flush();
        await new Promise(r => setTimeout(r, 300));
      } finally { undo(); }
      assert.deepEqual([...failed].sort(), ['Alpha.zip', 'Old.cbz'], 'each failed once');
      for (let i = 0; i < 2; i++) assert.deepEqual((await fx.lib.scan(ref.id)).problems, [], 'nothing left as the person\'s, no copy');
      await until(() => !fs.existsSync(path.join(A, 'Alpha.zip')) && !fs.existsSync(path.join(A, 'Old.cbz')));
      assert.deepEqual((await fx.lib.list()).find(f => f.id === ref.id).attention, []);
      for (const g of [gid, old]) assert.deepEqual([await fx.lib.read(g, 1), await fx.lib.read(g, 2, 'translated')], [png(1), png(9)]);
    },
  },
  {
    // Found while looking into the above (S21, the desktop): an unpack passed over a picture of the
    // gallery's own (a translation archived with it) whose read from the archive failed once, as one the
    // archive didn't hold; the archive then went, and the translation with it.
    name: 'S21: a translation kept in an archive whose read fails for a moment while the archive is unpacked is kept',
    platforms: ['desktop'],
    async run({ fx }) {
      await fx.register('A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.putTranslation(gid, 1, png(5));
      await fx.lib.flush();
      assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]);
      // The unpack's sixth open of the archive (its directory and descriptions, the three pages, then the
      // translation) fails once.
      let opens = 0;
      const undo = faults.failNext((c) => c.op === 'open' && c.path.endsWith('/A/Alpha.zip') && /_unpack/.test(String(new Error().stack)) && ++opens === 6, 'EIO', { times: 1 });
      try {
        await fx.lib.putTranslation(gid, 2, png(9));
        await fx.lib.flush();
      } finally { undo(); }
      assert.equal(opens, 6, 'the translation\'s read failed');
      await fx.lib.flush();
      assert.deepEqual([await fx.lib.read(gid, 1, 'translated'), await fx.lib.read(gid, 2, 'translated')], [png(5), png(9)]);
      await fx.lib.restart();
      assert.deepEqual([await fx.lib.read(gid, 1, 'translated'), await fx.lib.read(gid, 3)], [png(5), png(3)]);
    },
  },
  {
    // Found by the sweeps (S21, the desktop): a read failing once as an archive's first change unpacked it
    // decided what the unpack took — the archive's directory, read to tell whether it is in the gallery
    // format, taken for one outside it (so its descriptions weren't counted as taken), or an earlier
    // version's shiori.json taken for none — and the archive was then left beside the gallery's folder for
    // good, reported 'left' and as a copy at every check.
    name: 'S21: a read failing for a moment as an archive is unpacked never leaves the archive behind as the person\'s',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const A = path.join(dir, 'A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]);
      const { writeZip } = await import('../../desktop/server/zip.js');
      const old = '1790000000077', file = (/** @type {number} */ n) => `000${n}.png`;
      await writeZip(path.join(A, 'Old.cbz'), [...[1, 2, 3].map(n => ({ name: file(n), data: png(n) })),
        { name: 'shiori.json', data: new TextEncoder().encode(JSON.stringify({ format: 'shiori-gallery', version: 1, id: old,
          meta: { galleryId: old, title: { english: 'Old', japanese: '', pretty: '' }, tags: [], numPages: 3 },
          pages: [1, 2, 3].map(n => ({ n, file: file(n), key: `local://${old}/${n}.png` })) })) }]);
      assert.equal((await fx.lib.scan(ref.id)).added, 1);
      // Once each: the look at Alpha.zip's format as its settle begins, and the read of Old.cbz's shiori.json.
      const failed = new Set();
      const undo = faults.failNext((c) => {
        const stack = String(new Error().stack);
        const which = c.path.endsWith('/A/Alpha.zip') && c.op === 'stat' && /_inFormat/.test(stack) ? 'format'
          : c.path.endsWith('/A/Old.cbz') && /_earlierOwn/.test(stack) ? 'shiori.json' : null;
        if (!which || failed.has(which)) return false;
        failed.add(which);
        return true;
      }, 'EIO', { times: Infinity });
      try {
        for (const g of [gid, old]) await fx.lib.putTranslation(g, 2, png(9)).catch(() => {});
        await fx.lib.flush();
      } finally { undo(); }
      assert.deepEqual([...failed].sort(), ['format', 'shiori.json']);
      await fx.lib.flush();
      for (let i = 0; i < 2; i++) assert.deepEqual((await fx.lib.scan(ref.id)).problems, [], 'nothing left as the person\'s, no copy');
      await until(() => !fs.existsSync(path.join(A, 'Alpha.zip')) && !fs.existsSync(path.join(A, 'Old.cbz')));
      assert.deepEqual((await fx.lib.list()).find(f => f.id === ref.id).attention, []);
      for (const g of [gid, old]) assert.deepEqual([await fx.lib.read(g, 1), await fx.lib.read(g, 2, 'translated')], [png(1), png(9)]);
    },
  },
  // ── A read that fails decides nothing (review 6: F3, F8, F9 a) ──
  // Where a folder is read to tell what the library records — which galleries it holds, which pages one
  // has, whether a gallery's folder is still there — an answer of "not found" for something the folder's
  // listing showed, or the library recorded, is 'missing' only as the shared rule takes it (contract.js
  // surelyMissing); anything else is 'unreadable': the gallery or folder is reported and left as the index
  // has it, never adopted in part (it joins at a later check).
  ...earlierVersionCases(),
  {
    // F3 (review 6, the website): a gallery in the current format, page 1 replaced (its old picture left
    // beside the new one, as a refused delete leaves it), its folder removed and added again; its manifest
    // answering "not found" once at the first check read it by v1's rules: page 1 showed the picture it
    // had replaced, and its next publication wrote that.
    name: 'review 6 F3: a gallery\'s manifest answering "not found" at its folder\'s first check never reads it by an older rule',
    async run({ dir, fx, platform }) {
      const manifest = (/** @type {{ op: string, path: string }} */ c) => /(^|\/)A\d+\/Alpha\/\.shiori\/gallery\.json$|^Alpha\/\.shiori\/gallery\.json$/.test(c.path);
      const at = async (/** @type {number} */ k) => {
        const ref = await fx.register(`A${k}`);
        const gid = await fx.lib.newGallery('Alpha');
        for (let n = 1; n <= 2; n++) await fx.lib.putPage(gid, n, png(n));
        await fx.lib.putTranslation(gid, 1, png(31));
        await fx.lib.flush();
        const kept = platform === 'website' ? fsa.failNext((c) => c.op === 'removeEntry', 'NoModificationAllowedError', { times: Infinity })
          : faults.failNext((c) => ['rm', 'unlink', 'rmdir'].includes(c.op), 'EBUSY', { times: Infinity });
        await fx.lib.putPage(gid, 1, webp(9), 'image/webp');
        await fx.lib.putTranslation(gid, 1, png(33));
        await fx.lib.flush();
        kept();
        await fx.lib.setDefault(fx.lib.home);
        await fx.lib.remove(ref.id);
        return { id: await fx.lib.add(path.join(dir, `A${k}`)), gid };
      };
      // How many calls of the first check read the manifest, with no fault.
      let count = 0;
      const { id: first } = await at(0);
      const undo = (platform === 'desktop' ? faults : fsa).failNext((c) => { if (manifest(c)) count++; return false; }, 'EIO', { times: Infinity });
      await fx.lib.scan(first);
      undo();
      assert.ok(count > 0, 'the first check reads the manifest');
      for (let k = 1; k <= count; k++) {
        const { id, gid } = await at(k);
        let n = 0;
        const once = (platform === 'desktop' ? faults : fsa).failNext((c) => manifest(c) && ++n === k, platform === 'desktop' ? 'ENOENT' : 'NotFoundError', { times: Infinity });
        await fx.lib.scan(id);
        once();
        await fx.lib.flush();
        await fx.lib.scan(id);
        await fx.lib.flush();
        assert.deepEqual((await fx.lib.scan(id)).problems, [], `nothing left to report (the ${k}-th read)`);
        assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 1, 'translated'), await fx.lib.read(gid, 2)], [webp(9), png(33), png(2)],
          `the gallery reads as it was published (the ${k}-th read)`);
      }
    },
  },
  {
    // F8 (review 6, the desktop): the person's copy of a gallery's folder in another library folder; a
    // check of that one, its look at the gallery's own folder failing once (any failure: EIO, EPERM, or
    // "not found"), took the gallery for moved there by hand: the library followed the copy, and the work
    // done since the copy stopped showing, for good.
    name: 'review 6 F8: a copy in another library folder never takes a gallery over when a look at its own folder fails during a check',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      for (const [i, code] of ['EIO', 'EPERM', 'ENOENT'].entries()) {
        const a = await fx.register(`A${i}`), b = await fx.register(`B${i}`);
        const gid = await fx.lib.newGallery('Beta');
        for (let n = 1; n <= 2; n++) await fx.lib.putPage(gid, n, png(n));
        await fx.lib.flush();
        const own = /** @type {string} */ (await fx.lib.dirOf(gid));
        fs.cpSync(own, path.join(dir, `A${i}`, 'Beta'), { recursive: true });   // the person's copy
        await fx.lib.scan(a.id);
        await fx.lib.putTranslation(gid, 1, png(7));   // work done after the copy
        await fx.lib.flush();
        let met = false;
        const undo = faults.failNext((c) => !met && c.path.endsWith(`/B${i}/Beta`) && (met = true), code, { times: Infinity });
        await fx.lib.scan(a.id);
        undo();
        assert.ok(met, `a look at the gallery's own folder was made (${code})`);
        for (const ref of [a, b, a]) await fx.lib.scan(ref.id);
        assert.deepEqual([await fx.lib.dirOf(gid), await fx.lib.read(gid, 1, 'translated')], [own, png(7)], `the gallery stays its own (${code})`);
      }
    },
  },
  {
    // F8 (review 6, both apps): the person's copy of a gallery's folder in the same library folder (a
    // 'duplicate' at every check); one "not found" for the gallery's own folder during a check, and the
    // library followed the copy: the work done since stopped showing, and later checks reported the
    // gallery's own folder as the copy.
    name: 'review 6 F8: a copy in the same library folder never takes a gallery over when a look at its own folder answers "not found"',
    async run({ dir, fx, platform }) {
      const at = (/** @type {number} */ k) => (/** @type {{ op: string, path: string }} */ c) => (platform === 'desktop'
        ? ['stat', 'access', 'readdir', 'readFile'].includes(c.op) && new RegExp(`/A${k}/Beta(/|$)`).test(c.path)
        : /^Beta(\/|$)/.test(c.path));
      const setUp = async (/** @type {number} */ k) => {
        const ref = await fx.register(`A${k}`);
        const gid = await fx.lib.newGallery('Beta');
        for (let n = 1; n <= 2; n++) await fx.lib.putPage(gid, n, png(n));
        await fx.lib.flush();
        fs.cpSync(/** @type {string} */ (await fx.lib.dirOf(gid)), path.join(dir, `A${k}`, 'Alpha copy'), { recursive: true });   // the person's copy
        await fx.lib.scan(ref.id);
        await fx.lib.putTranslation(gid, 1, png(7));   // work done after the copy
        await fx.lib.flush();
        return { id: ref.id, gid };
      };
      // How many calls of a check look at the gallery's own folder, with no fault.
      let count = 0;
      const { id: first } = await setUp(0);
      const look = at(0);
      const undo = (platform === 'desktop' ? faults : fsa).failNext((c) => { if (look(c)) count++; return false; }, 'EIO', { times: Infinity });
      await fx.lib.scan(first);
      undo();
      assert.ok(count > 0, 'a check looks at the gallery\'s own folder');
      for (let k = 1; k <= count; k++) {
        const { id, gid } = await setUp(k);
        const own = await fx.lib.dirOf(gid), match = at(k);
        let n = 0;
        const once = (platform === 'desktop' ? faults : fsa).failNext((c) => match(c) && ++n === k, platform === 'desktop' ? 'ENOENT' : 'NotFoundError', { times: Infinity });
        await fx.lib.scan(id);
        once();
        await fx.lib.flush();
        const problems = (await fx.lib.scan(id)).problems.map(p => `${p.reason} ${p.path}`);
        assert.deepEqual([await fx.lib.dirOf(gid), await fx.lib.read(gid, 1, 'translated'), problems], [own, png(7), ['duplicate Alpha copy']],
          `the gallery stays its own (the ${k}-th look)`);
      }
    },
  },
  {
    // F9 (a) (review 6, both apps): the drive away from a deletion's first read of the gallery's manifest
    // and back two calls later: the manifest and metadata.json both answered "not found", so the folder
    // was taken for one naming no gallery — its pictures deleted, its descriptions left, reported as the
    // person's ('left') and as a missing file at every check, for good.
    name: 'review 6 F9 a: a deletion the drive leaves for a moment as it reads the gallery\'s descriptions finishes once it is back, leaving nothing behind',
    async run({ dir, fx, platform }) {
      const ref = await fx.register('A');
      const A = path.join(dir, 'A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      const back = driveAway(platform, A, (c) => /(^|\/)Alpha\/\.shiori\/gallery\.json$/.test(c.path), { backAfter: 2 });
      await fx.lib.deleteGallery(gid);
      await fx.lib.flush();
      await new Promise(r => setTimeout(r, 300));   // what a deletion leaves to do, once it commits
      back();
      await /** @type {NonNullable<typeof fx.lib.restart>} */ (fx.lib.restart)();
      await fx.lib.flush();
      for (let i = 0; i < 2; i++) assert.deepEqual((await fx.lib.scan(ref.id)).problems, [], 'nothing reported');
      await until(() => !fs.existsSync(path.join(A, 'Alpha')));
      assert.deepEqual([await fx.lib.galleries(), (await fx.lib.list()).find(f => f.id === ref.id).attention], [[], []]);
    },
  },
  // ── Linked galleries, removal notes and claims, under the same rule (review 6: F1, F2, F4, F10; O4) ──
  // What a check reads of a linked title (its pictures), of the overlays a folder holds for its linked
  // galleries (their source.json, their pages of their own), of removed.json, and what an app reads of
  // owner.json, decides what the library records: an answer of "not found" there is 'missing' only as the
  // shared rule takes it, and what can't be read now decides nothing.
  {
    // F1 (review 6, the desktop): a linked folder of pictures, two pages translated; a check during which
    // one picture's look answered "not found" — once (a), or the drive away from that look and back at the
    // m-th call after it, or once the check ended (b) — read the title without that picture: the page was
    // dropped, and the translation made from it deleted from the overlay (every one, the drive away).
    name: 'review 6 F1: a linked folder\'s picture whose look fails during a check never drops its page, nor deletes a translation\'s file',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      for (const [i, back] of [0, 1, 2, 3, 5, Infinity].entries()) {
        const name = `A${i}`, A = path.join(dir, name);
        fs.mkdirSync(path.join(A, 'Pics'), { recursive: true });
        for (let n = 1; n <= 3; n++) fs.writeFileSync(path.join(A, 'Pics', `00${n}.png`), png(10 + n));
        const ref = await fx.register(name);
        await fx.lib.scan(ref.id);
        const [gid] = await fx.lib.galleries();
        await fx.lib.putTranslation(gid, 1, png(71));
        await fx.lib.putTranslation(gid, 2, png(72));
        await fx.lib.flush();
        await fx.lib.scan(ref.id);
        // The overlay's translations, as files.
        const kept = () => fs.readdirSync(path.join(A, '.shiori', 'linked'), { recursive: true }).map(p => String(p).replaceAll('\\', '/'))
          .filter(p => /^\d+\/translated\/[^/]+$/.test(p)).map(p => p.replace(/^\d+\//, '')).sort();
        assert.deepEqual(kept(), ['translated/0001.png', 'translated/0002.png']);
        const look = (/** @type {{ op: string, path: string }} */ c) => c.op === 'stat' && c.path.endsWith(`/${name}/Pics/002.png`);
        const undo = back ? driveAway('desktop', A, look, { backAfter: back }) : faults.failNext(look, 'ENOENT');
        const faulted = await fx.lib.scan(ref.id);
        undo();
        if (!back) assert.ok(faulted.problems.some(p => p.path === 'Pics'), 'the title is reported, not read without the picture');
        for (let k = 0; k < 2; k++) { await fx.lib.flush(); await new Promise(r => setTimeout(r, 200)); await fx.lib.scan(ref.id); }
        await fx.lib.flush();
        await new Promise(r => setTimeout(r, 200));
        assert.deepEqual([await fx.lib.read(gid, 1, 'translated'), await fx.lib.read(gid, 2, 'translated'), await fx.lib.read(gid, 3)], [png(71), png(72), png(13)],
          `every page and translation reads (${back ? `the drive back ${back === Infinity ? 'after the check' : `at the ${back}-th call after`}` : 'one "not found"'})`);
        assert.deepEqual(kept(), ['translated/0001.png', 'translated/0002.png'], 'the overlay keeps both translations\' files');
        await fx.lib.setDefault(fx.lib.home);
        await fx.lib.remove(ref.id);
      }
    },
  },
  {
    // F1 (review 6, the desktop: its overlay's pages, the same rule): a linked ZIP whose page 1 was
    // replaced in the app — its own picture in the overlay — and translated, its folder removed and added
    // again; the look at that picture answering "not found" at the first check read page 1 as the source's
    // picture, the translation made from the replaced one dropped.
    name: 'review 6 F1: a linked gallery\'s page of its own whose look answers "not found" as it is read back never shows the source\'s picture',
    async run({ dir, fx, platform }) {
      // Each look at the replaced picture in the first check, failed in turn (none: the 0-th).
      const look = (/** @type {{ op: string, path: string }} */ c) => /(^|\/)\.shiori\/linked\/\d+\/images\/0001\.png$/.test(c.path) && (platform === 'desktop' ? c.op === 'stat' : c.op === 'getFile');
      let count = 0;
      for (let k = 0; k <= count; k++) {
        const name = `A${k}`, A = path.join(dir, name);
        fs.mkdirSync(A, { recursive: true });
        fs.writeFileSync(path.join(A, 'Pack.zip'), zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }]));
        let ref = await fx.register(name);
        await fx.lib.scan(ref.id);
        const [gid] = await fx.lib.galleries();
        await fx.lib.putPage(gid, 1, png(9));
        await fx.lib.putTranslation(gid, 1, png(7));
        await fx.lib.flush();
        await fx.lib.setDefault(fx.lib.home);
        await fx.lib.remove(ref.id);
        ref = await fx.register(name);
        let n = 0;
        const undo = (platform === 'desktop' ? faults : fsa).failNext((c) => look(c) && ++n === k, platform === 'desktop' ? 'ENOENT' : 'NotFoundError', { times: Infinity });
        await fx.lib.scan(ref.id);
        undo();
        if (!k) { count = n; assert.ok(count > 0, 'the first check looks at the replaced picture'); }
        for (let i = 0; i < 2; i++) { await fx.lib.flush(); await fx.lib.scan(ref.id); }
        assert.deepEqual([await fx.lib.galleries(), await fx.lib.read(gid, 1), await fx.lib.read(gid, 1, 'translated'), await fx.lib.read(gid, 2)],
          [[gid], png(9), png(7), png(2)], `the gallery reads as it was published (the ${k}-th look failed)`);
        await fx.lib.setDefault(fx.lib.home);
        await fx.lib.remove(ref.id);
      }
    },
  },
  {
    // F2 (review 6, both apps): a linked ZIP translated, its folder removed and added again; one failed
    // read of the folder's overlays at the first check — the listing of .shiori/linked, an overlay's
    // folder, its source.json (any failure, "not found" or not) — and the gallery joined under a new id
    // without its translation, which stayed on disk in the old overlay, read by nothing again.
    name: 'review 6 F2: an overlay that can\'t be read at a folder\'s first check never makes its linked gallery join again under a new id',
    async run({ dir, fx, platform }) {
      const overlays = (/** @type {string} */ name) => (/** @type {{ op: string, path: string }} */ c) => (platform === 'desktop'
        ? (c.op === 'readdir' && c.path.endsWith(`/${name}/.shiori/linked`)) || new RegExp(`/${name}/\\.shiori/linked/\\d+/source\\.json$`).test(c.path)
        : c.path === '.shiori/linked' || /^\.shiori\/linked\/\d+(\/source\.json)?$/.test(c.path));
      let round = 0;
      const setUp = async () => {
        const name = `A${round++}`, A = path.join(dir, name);
        fs.mkdirSync(A, { recursive: true });
        fs.writeFileSync(path.join(A, 'Pack.zip'), zipCreate([{ name: '001.png', data: png(1) }, { name: '002.png', data: png(2) }]));
        let ref = await fx.register(name);
        await fx.lib.scan(ref.id);
        const [gid] = await fx.lib.galleries();
        await fx.lib.putTranslation(gid, 1, png(7));
        await fx.lib.flush();
        await new Promise(r => setTimeout(r, 150));
        await fx.lib.setDefault(fx.lib.home);
        await fx.lib.remove(ref.id);
        ref = await fx.register(name);
        return { name, A, ref, gid };
      };
      // How many such calls the first check makes, with no fault.
      let count = 0;
      const first = await setUp();
      const counting = overlays(first.name);
      const undo = (platform === 'desktop' ? faults : fsa).failNext((c) => { if (counting(c)) count++; return false; }, 'EIO', { times: Infinity });
      await fx.lib.scan(first.ref.id);
      undo();
      assert.ok(count >= 2, 'the first check lists the overlays and reads their source.json');
      await fx.lib.setDefault(fx.lib.home);
      await fx.lib.remove(first.ref.id);
      for (const code of platform === 'desktop' ? ['EIO', 'ENOENT'] : ['NotReadableError', 'NotFoundError']) {
        for (let k = 1; k <= count; k++) {
          const { name, A, ref, gid } = await setUp();
          const match = overlays(name);
          let n = 0;
          const once = (platform === 'desktop' ? faults : fsa).failNext((c) => match(c) && ++n === k, code, { times: Infinity });
          await fx.lib.scan(ref.id);
          once();
          await fx.lib.flush();
          await fx.lib.scan(ref.id);
          await fx.lib.flush();
          assert.deepEqual([await fx.lib.galleries(), await fx.lib.read(gid, 1, 'translated'), fs.readdirSync(path.join(A, '.shiori', 'linked')).filter(f => /^\d+$/.test(f))],
            [[gid], png(7), [gid]], `the gallery joins again as itself, with its translation (${code}, the ${k}-th call)`);
          await fx.lib.setDefault(fx.lib.home);
          await fx.lib.remove(ref.id);
        }
      }
    },
  },
  {
    // O4 (review 6, the desktop; F2's shape on both apps): a PDF drawn, its folder removed and added again;
    // its overlay's source.json answering "not found" at the first check was written again without what it
    // said of the drawing (`rendered`), so the PDF was offered to be drawn again — or, read as no overlay at
    // all, joined under a new id.
    name: 'review 6 O4: a drawn PDF\'s source.json answering "not found" at its folder\'s first check is never written again without its drawing',
    async run({ dir, fx, platform }) {
      const sourceJson = (/** @type {{ op: string, path: string }} */ c) => /(^|\/)\.shiori\/linked\/\d+\/source\.json$/.test(c.path) && (platform === 'desktop' ? c.op === 'readFile' : c.op === 'getFileHandle');
      let count = 0;
      for (let k = 0; k <= count; k++) {
        const name = `A${k}`, A = path.join(dir, name);
        fs.mkdirSync(A, { recursive: true });
        fs.writeFileSync(path.join(A, 'Doc.pdf'), '%PDF-1.4 a document');
        let ref = await fx.register(name);
        await fx.lib.scan(ref.id);
        const [w] = await fx.lib.pdfsWaiting();
        const gid = await fx.lib.addRendered(w.folder, w.gid, [png(61), png(62)], (await fx.lib.pdfSource(w.folder, w.gid)).token);
        await fx.lib.flush();
        const file = path.join(A, '.shiori', 'linked', gid, 'source.json');
        const drawn = JSON.parse(fs.readFileSync(file, 'utf8')).source.rendered;
        assert.equal(drawn?.pages, 2);
        await fx.lib.setDefault(fx.lib.home);
        await fx.lib.remove(ref.id);
        ref = await fx.register(name);
        let n = 0;
        const once = (platform === 'desktop' ? faults : fsa).failNext((c) => sourceJson(c) && ++n === k, platform === 'desktop' ? 'ENOENT' : 'NotFoundError', { times: Infinity });
        await fx.lib.scan(ref.id);
        once();
        if (!k) { count = n; assert.ok(count > 0, 'the first check reads source.json'); }
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).source.rendered, drawn, `source.json still says it is drawn (the ${k}-th read failed)`);
        for (let i = 0; i < 2; i++) { await fx.lib.flush(); await fx.lib.scan(ref.id); }
        assert.deepEqual([await fx.lib.galleries(), await fx.lib.read(gid, 2), (await fx.lib.pdfsWaiting()).length],
          [[gid], png(62), 0], `the PDF joins again as itself, drawn (the ${k}-th read failed)`);
        await fx.lib.setDefault(fx.lib.home);
        await fx.lib.remove(ref.id);
      }
    },
  },
  {
    // F4 (review 6, both apps): two linked ZIPs, one deleted (removed.json notes it). (i) A check that
    // couldn't read removed.json — any failure, "not found" or not — added the deleted one again. (ii) A note
    // added while removed.json answered "not found" wrote the file anew with that note alone: the earlier
    // note gone for good, and the next check added that gallery again.
    name: 'review 6 F4: a check that can\'t read removed.json adds no gallery deleted before, and a note added while it answers "not found" waits',
    async run({ dir, fx, platform }) {
      const [failure, notFound] = platform === 'desktop' ? ['EIO', 'ENOENT'] : ['NotReadableError', 'NotFoundError'];
      const notes = (/** @type {{ op: string, path: string }} */ c) => /(^|\/)\.shiori\/linked\/removed\.json$/.test(c.path) && (c.op === 'readFile' || c.op === 'getFileHandle');
      const titles = async () => (await Promise.all((await fx.lib.galleries()).map(g => fx.lib.titleOf(g)))).sort();
      const of = async (/** @type {string} */ t) => { for (const g of await fx.lib.galleries()) if (await fx.lib.titleOf(g) === t) return g; return ''; };
      for (const [i, part] of [['i', failure], ['i', notFound], ['ii', notFound]].entries()) {
        const name = `A${i}`, A = path.join(dir, name);
        fs.mkdirSync(A, { recursive: true });
        for (const [file, k] of /** @type {[string, number][]} */ ([['Pack1.zip', 1], ['Pack2.zip', 5]])) {
          fs.writeFileSync(path.join(A, file), zipCreate([{ name: '001.png', data: png(k) }, { name: '002.png', data: png(k + 1) }]));
        }
        const ref = await fx.register(name);
        await fx.lib.scan(ref.id);
        await fx.lib.deleteGallery(await of('Pack1'));
        await fx.lib.flush();
        await new Promise(r => setTimeout(r, 300));
        await fx.lib.scan(ref.id);
        assert.deepEqual(await titles(), ['Pack2'], 'the note keeps Pack1 out');
        let n = 0;
        const once = (platform === 'desktop' ? faults : fsa).failNext((c) => notes(c) && ++n === 1, part[1], { times: Infinity });
        const listed = () => JSON.parse(fs.readFileSync(path.join(A, '.shiori', 'linked', 'removed.json'), 'utf8')).removed.map((/** @type {{ path: string }} */ r) => r.path).sort();
        if (part[0] === 'i') {
          const faulted = await fx.lib.scan(ref.id);
          once();
          assert.deepEqual(await titles(), ['Pack2'], `a check that can't read removed.json (${part[1]}) adds nothing removed`);
          assert.ok(faulted.problems.some(p => p.path === '.shiori/linked/removed.json' && p.reason === 'unreadable'), 'and says so');
          await fx.lib.scan(ref.id);
          assert.deepEqual([await titles(), listed()], [['Pack2'], ['Pack1.zip']]);
        } else {
          await fx.lib.deleteGallery(await of('Pack2'));
          await fx.lib.flush();
          await new Promise(r => setTimeout(r, 300));
          once();
          assert.ok(n >= 1, 'removed.json was read to add the note');
          assert.deepEqual(listed(), ['Pack1.zip'], 'the earlier note is kept, the new one waits');
          for (let k = 0; k < 2; k++) await fx.lib.scan(ref.id);
          assert.deepEqual([await titles(), listed()], [[], ['Pack1.zip', 'Pack2.zip']], 'written at the next check, adding neither');
        }
        await fx.lib.setDefault(fx.lib.home);
        await fx.lib.remove(ref.id);
      }
    },
  },
  {
    // F10 (review 6, both apps): a folder another app took over; one "not found" for its owner.json and
    // this app took the claim back by itself and wrote into the folder. Claims fail closed: a claim that
    // can't be read is one that can't be checked.
    name: 'review 6 F10: a folder another app took over is never claimed back by itself when its owner.json answers "not found"',
    async run({ dir, fx, platform }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Alpha');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      const at = /** @type {string} */ (await fx.lib.dirOf(gid));
      const owner = () => JSON.parse(fs.readFileSync(path.join(dir, 'A', '.shiori', 'owner.json'), 'utf8'));
      await fx.takeOver(ref);
      const theirs = owner();
      const read = (/** @type {{ op: string, path: string }} */ c) => (platform === 'desktop' ? c.op === 'readFile' && c.path.endsWith('/A/.shiori/owner.json')
        : c.path === '.shiori/owner.json' && (c.op === 'getFileHandle' || c.op === 'getFile'));
      for (let k = 1; k <= 3; k++) {
        let n = 0;
        const once = (platform === 'desktop' ? faults : fsa).failNext((c) => read(c) && ++n === k, platform === 'desktop' ? 'ENOENT' : 'NotFoundError', { times: Infinity });
        for (let i = 0; i < 3; i++) assert.notEqual((await fx.store.open(ref, { purpose: 'write' })).status, 'ok', 'not written to');
        await fx.lib.putTranslation(gid, 1, png(3)).catch(() => {});
        await fx.lib.flush().catch(() => {});
        once();
        assert.ok(n >= k, `owner.json was read ${k} times`);
        assert.deepEqual(owner(), theirs, `the other app keeps its claim (the ${k}-th read)`);
        assert.equal(fs.existsSync(path.join(at, 'translated')), false, 'nothing is written into the folder');
      }
    },
  },
  // ── Rules that stopped one case short (review 6: F5, F6; S22's names picked free) ──
  {
    // F6 (review 6, both apps): a gallery deleted after its folder was renamed by hand waits `unfound` for a
    // check to meet that folder (S10's F4). A check that couldn't list the folder — a listing failing once,
    // answering "not found" for a moment, or the drive away from there to the check's end — forgot the
    // deletion all the same, and the check after added the deleted gallery back, every page readable. Found
    // beside it (S24): a check that met the folder but couldn't finish deleting it (one deletion there
    // failing) forgot it too, leaving the folder naming the deleted gallery for good.
    name: 'review 6 F6: a check that can\'t read a folder it walks never forgets a deletion still owed, and the deleted gallery stays deleted',
    async run({ dir, fx, platform }) {
      const [failure, notFound] = platform === 'desktop' ? ['EIO', 'ENOENT'] : ['NotReadableError', 'NotFoundError'];
      const unfinished = 'a deletion there failing once';
      for (const [i, kind] of [failure, notFound, 'the drive away', unfinished].entries()) {
        const name = `A${i}`, A = path.join(dir, name);
        const ref = await fx.register(name);
        const gid = await fx.lib.newGallery('Alpha');
        for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
        await fx.lib.flush();
        const renamed = path.join(A, 'Alpha by hand');
        fs.renameSync(/** @type {string} */ (await fx.lib.dirOf(gid)), renamed);
        await fx.lib.deleteGallery(gid);
        await fx.lib.flush();
        await new Promise(r => setTimeout(r, 300));
        const listing = (/** @type {{ op: string, path: string }} */ c) => (platform === 'desktop' ? c.op === 'readdir' && c.path.endsWith(`/${name}/Alpha by hand`)
          : c.op === 'entries' && c.path === 'Alpha by hand');
        const deletion = (/** @type {{ op: string, path: string }} */ c) => (platform === 'desktop' ? ['rm', 'unlink'].includes(c.op) && c.path.includes(`/${name}/Alpha by hand/`)
          : c.op === 'removeEntry' && c.path.startsWith('Alpha by hand/'));
        let n = 0;
        const undo = kind === 'the drive away' ? driveAway(platform, A, listing)
          : kind === unfinished ? (platform === 'desktop' ? faults.failNext(deletion, 'EBUSY') : fsa.failNext(deletion, 'NoModificationAllowedError'))
            : (platform === 'desktop' ? faults : fsa).failNext((c) => listing(c) && ++n === 1, kind, { times: Infinity });
        const faulted = await fx.lib.scan(ref.id);
        undo();
        if (kind !== unfinished) assert.ok(faulted.problems.some(p => p.reason === 'unreadable'), `the check says what it couldn't read (${kind})`);
        for (let k = 0; k < 2; k++) {
          const r = await fx.lib.scan(ref.id);
          assert.deepEqual([r.added, (await fx.lib.galleries()).includes(gid)], [0, false], `the deleted gallery never comes back (${kind})`);
        }
        assert.equal(fs.existsSync(renamed), false, `its folder is deleted where a check met it (${kind})`);
        await fx.lib.setDefault(fx.lib.home);
        await fx.lib.remove(ref.id);
      }
    },
  },
  {
    // F5 (review 6, the website): adding a folder read its .shiori/library.json and, at one answer of "not
    // found" (the .shiori folder's lookup, the file's, its read), wrote a new id over it — before it weighed
    // the claim, so even for an add it then refused. Here a folder of the library's own, picked again: refused
    // 'nested', and from then on 'other-library', its galleries unread. The website has no exclusive create: a
    // library.json is written only where there surely is none, and only once the add is allowed — a folder
    // inside one of the library's, refused, is given none.
    name: 'review 6 F5: adding a folder writes a library.json only where there surely is none, and only once the add is allowed',
    platforms: ['website'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const A = path.join(dir, 'A');
      const gid = await fx.lib.newGallery('Alpha');
      await fx.lib.putPage(gid, 1, png(1));
      await fx.lib.flush();
      const idIn = (/** @type {string} */ at) => JSON.parse(fs.readFileSync(path.join(at, '.shiori', 'library.json'), 'utf8')).id;
      for (const [op, at] of [['getDirectoryHandle', '.shiori'], ['getFileHandle', '.shiori/library.json'], ['getFile', '.shiori/library.json']]) {
        const undo = fsa.failNext((c) => c.op === op && c.path === at, 'NotFoundError', { times: 1 });
        await fx.lib.add(A).catch(() => {});
        undo();
        assert.equal(idIn(A), ref.id, `its library.json is as it was (${op} answered "not found")`);
      }
      assert.equal((await fx.lib.list()).find(f => f.id === ref.id)?.access, 'granted', 'still the library\'s folder');
      assert.deepEqual(await fx.lib.read(gid, 1), png(1));
      const inner = path.join(A, 'Inner');
      fs.mkdirSync(inner);
      await assert.rejects(fx.lib.add(inner), (e) => /** @type {any} */ (e).reason === 'nested');
      assert.equal(fs.existsSync(path.join(inner, '.shiori')), false, 'a refused add writes nothing');
      const B = path.join(dir, 'B');
      const added = await fx.lib.add(B);
      assert.equal(idIn(B), added, 'a folder with none is given its library.json as it joins');
    },
  },
  {
    // Found in S22 (the website): writeNew and reserve picked a free name by a look that answered false for
    // "not found", then wrote with `create`: one look answering "not found" for a moment, and a file a
    // manifest names was written over, or another gallery's folder taken (its manifest replaced). A name is
    // free only where there surely is nothing (the desktop creates exclusively).
    name: 'S24: a look at a name answering "not found" for a moment never lets writeNew or reserve write over what is there',
    async run({ store, fx, platform }) {
      const root = await opened(store, await fx.register('A'));
      const notFound = (/** @type {(path: string) => boolean} */ at) => (platform === 'desktop'
        ? faults.failNext((c) => (c.op === 'exists' || c.op === 'stat' || c.op === 'access') && at(c.path), 'ENOENT', { times: 1 })
        : fsa.failNext((c) => c.op === 'getDirectoryHandle' && at(c.path), 'NotFoundError', { times: 1 }));
      const g = await root.reserve('Pictures', '1700000000001', null);
      const first = await g.writeNew('translated/0001', 'png', png(1));
      let undo = notFound((p) => p.endsWith(`Pictures/${first.name}`));
      const second = await g.writeNew('translated/0001', 'png', png(2)).catch(() => null);
      undo();
      assert.notEqual(second?.name, first.name, 'never the name taken');
      assert.deepEqual((await g.read(first.name)).data, png(1), 'the file there is as it was');
      undo = notFound((p) => p === 'Pictures' || p.endsWith('/A/Pictures'));
      const other = await root.reserve('Pictures', '1700000000002', null).catch(() => null);
      undo();
      assert.notEqual(other?.name, g.name, 'never the folder taken');
      assert.equal((await root.gallery(g.name, '1700000000001')).kind, 'ok', 'which still names its gallery');
      assert.deepEqual((await g.read(first.name)).data, png(1));
    },
  },
  // ── A folder names a gallery only once it is whole (review 4: F2, O2) ──
  // A folder reserved for a gallery whose work never committed — the reservation's own writes, or the
  // pictures a first write or a move put in it, cut short by a failed write, a kill or the page closing —
  // is never taken for the gallery: not by a re-add, nor by a check once the gallery is deleted.
  {
    // F2 (review 4, the website): a reservation's failed write left its metadata.json naming the
    // gallery; the gallery went to "Alpha (2)", and the folder added again took the stub for it.
    name: 'review 4 F2: a reservation whose write fails leaves no folder a re-add takes for the gallery',
    platforms: ['website'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Alpha');
      fsa.failNext((c) => c.op === 'close' && c.path.startsWith('Alpha/.shiori/d/'), 'NoModificationAllowedError', { times: 1 });
      await fx.lib.putPage(gid, 1, png(1));   // resolves: the page waits in the browser
      await fx.lib.putPage(gid, 2, png(2));
      await fx.lib.flush();
      await fx.lib.setDefault(fx.lib.home);
      await fx.lib.remove(ref.id);
      await fx.lib.scan(await fx.lib.add(path.join(dir, 'A')));
      assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 2)], [png(1), png(2)]);
    },
  },
  {
    // F2 (review 4, the desktop): killed inside a reservation (at its manifest's rename), the folder kept
    // a metadata.json naming the gallery; the folder added again took it for the gallery.
    name: 'review 4 F2: a reservation the app is killed in leaves no folder a re-add takes for the gallery',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      await fx.close();
      const base = path.join(dir, 'desktop'), idFile = path.join(dir, 'A-id');
      assert.equal(desktopKilled(base, async ({ lib, kill, folder, idFile }) => {
        const id = await lib.add(folder);
        (await import('node:fs')).writeFileSync(idFile, id);
        await lib.setDefault(id);
        const gid = await lib.newGallery('Alpha');
        kill((c) => c.op === 'rename' && c.path.endsWith('/A/Alpha/.shiori/gallery.json.shiori-tmp'));
        await lib.putPage(gid, 1, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]));
        await lib.flush();
      }, { folder: path.join(dir, 'A'), idFile }), 42);
      const lib = await desktopLibrary(base);
      try {
        const [gid] = await lib.galleries();
        await lib.putPage(gid, 1, png(1));
        await lib.putPage(gid, 2, png(2));
        await lib.flush();
        await lib.setDefault(lib.home);
        await lib.remove(fs.readFileSync(idFile, 'utf8'));
        await lib.scan(await lib.add(path.join(dir, 'A')));
        assert.deepEqual([await lib.read(gid, 1), await lib.read(gid, 2)], [png(1), png(2)]);
      } finally { await lib.close(); }
    },
  },
  {
    // F2 (review 4, the website): the page closed while a move copied the gallery's pictures into
    // another folder; once the gallery was deleted, a check of that folder brought it back, empty.
    name: 'review 4 F2: a move cut short by the page closing leaves no folder a check brings the deleted gallery back from',
    platforms: ['website'],
    async run({ dir, fx }) {
      await fx.register('A');
      const B = await fx.lib.add(path.join(dir, 'B'));
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      // The page's Web Locks go with it: the in-context ones, each page's own (folder-store-web.js withLock).
      Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
      try {
        const page = pageNow();
        let died = () => {}, dead = false;
        const death = new Promise((resolve) => { died = resolve; });
        fsa.hang((c) => {
          if (pageCalling() !== page) return false;
          if (!dead && c.op === 'createWritable' && c.path === 'Alpha/images/0002.png') { dead = true; died(); }
          return dead;
        });
        await Promise.race([fx.lib.move(gid, B), death]);
        await /** @type {() => Promise<void>} */ (fx.lib.restart)();
        assert.ok(fs.existsSync(path.join(dir, 'B', 'Alpha', 'images', '0001.png')), 'the move was cut short in B');
        assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 2), await fx.lib.read(gid, 3)], [png(1), png(2), png(3)]);
        await fx.lib.deleteGallery(gid);
        await fx.lib.flush();
        await new Promise(r => setTimeout(r, 300));   // what a deletion leaves to do, once it commits
        const found = await fx.lib.scan(B);
        assert.deepEqual([found.added, await fx.lib.galleries()], [0, []], 'the deleted gallery never comes back');
      } finally { delete /** @type {any} */ (globalThis.navigator).locks; }
    },
  },
  {
    // O2 (review 4, the desktop): a temporary folder a kill left counted as taking the name it was for,
    // so the next unpack went to "Alpha (2)". It takes no name now, and stays as it is: nothing proves a
    // folder beside a gallery's place Shiori's (F08).
    name: 'review 4 O2: a temporary folder a kill left takes no name: the next unpack goes where it was meant to',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      await fx.close();
      const base = path.join(dir, 'desktop'), A = path.join(dir, 'A'), idFile = path.join(dir, 'A-id');
      assert.equal(desktopKilled(base, async ({ lib, kill, folder, idFile }) => {
        const fs = await import('node:fs'), path = await import('node:path');
        const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
        const id = await lib.add(folder);
        fs.writeFileSync(idFile, id);
        await lib.setDefault(id);
        const gid = await lib.newGallery('Alpha');
        for (let n = 1; n <= 3; n++) await lib.putPage(gid, n, png(n));
        await lib.flush();
        await lib.raw.archiveGallery(gid);
        while (fs.existsSync(path.join(folder, 'Alpha'))) await new Promise(r => setTimeout(r, 25));
        kill((c) => c.op === 'rename' && /\/A\/Alpha(\.[0-9a-f]+)?\.shiori-tmp$/.test(c.path));
        await lib.putTranslation(gid, 2, png(9));
        await lib.flush();
      }, { folder: A, idFile }), 42);
      const leftover = fs.readdirSync(A).filter(n => n.endsWith('.shiori-tmp'));
      assert.equal(leftover.length, 1, 'the kill left the unpack\'s temporary folder');
      const before = snapshot(path.join(A, leftover[0]));
      const lib = await desktopLibrary(base);
      try {
        const [gid] = await lib.galleries();
        await lib.putTranslation(gid, 2, png(9));
        await lib.flush();
        assert.equal(path.basename(/** @type {string} */ (await lib.dirOf(gid))), 'Alpha');
        assert.deepEqual(snapshot(path.join(A, leftover[0])), before, 'the leftover as it was');
        await lib.scan(fs.readFileSync(idFile, 'utf8'));
        assert.deepEqual(await lib.galleries(), [gid], 'nothing joins from it');
        assert.deepEqual([await lib.read(gid, 1), await lib.read(gid, 2, 'translated'), await lib.read(gid, 3)], [png(1), png(9), png(3)]);
      } finally { await lib.close(); }
    },
  },
  // ── Every deletion and move the desktop begins is recorded first (review 4: F8, F10) ──
  // A move, or the deletion an unpack leaves to do, that the app was killed in is finished or undone at
  // the next start.
  {
    // F8 (review 4, the desktop): killed between a same-drive move's rename and the index's change, the
    // gallery read nothing until the folder it went to was checked by hand.
    name: 'review 4 F8: a move the app is killed in between its folder\'s rename and the index\'s change is finished at the next start',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      await fx.close();
      const base = path.join(dir, 'desktop'), ids = path.join(dir, 'ids');
      assert.equal(desktopKilled(base, async ({ lib, kill, A, B, ids }) => {
        const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
        const a = await lib.add(A), b = await lib.add(B);
        (await import('node:fs')).writeFileSync(ids, JSON.stringify([a, b]));
        await lib.setDefault(a);
        const gid = await lib.newGallery('Alpha');
        for (let n = 1; n <= 3; n++) await lib.putPage(gid, n, png(n));
        await lib.flush();
        let renamed = false;   // killed at the first file call after the folder's rename into B
        kill((c) => { if (renamed) return true; renamed = c.op === 'rename' && String(c.to).endsWith('/B/Alpha'); return false; });
        await lib.move(gid, b);
      }, { A: path.join(dir, 'A'), B: path.join(dir, 'B'), ids }), 42);
      assert.ok(fs.existsSync(path.join(dir, 'B', 'Alpha')) && !fs.existsSync(path.join(dir, 'A', 'Alpha')), 'killed once renamed');
      const lib = await desktopLibrary(base);
      try {
        const [gid] = await lib.galleries();
        const pages = async () => [await lib.read(gid, 1), await lib.read(gid, 2), await lib.read(gid, 3)];
        assert.deepEqual(await pages(), [png(1), png(2), png(3)]);
        assert.equal(path.dirname(/** @type {string} */ (await lib.dirOf(gid))), path.join(dir, 'B'));
        for (const id of JSON.parse(fs.readFileSync(ids, 'utf8'))) await lib.scan(id);
        await lib.restart?.();
        assert.deepEqual([await lib.galleries(), await pages()], [[gid], [png(1), png(2), png(3)]]);
      } finally { await lib.close(); }
    },
  },
  {
    // The same for a move by copy (another drive): killed once the copy was renamed into place, before the
    // index's change, the copy stayed for good, and the gallery came back from it once deleted.
    name: 'review 4 F8: a move by copy the app is killed in before the index\'s change leaves no copy the deleted gallery comes back from',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      await fx.close();
      const base = path.join(dir, 'desktop'), ids = path.join(dir, 'ids');
      assert.equal(desktopKilled(base, async ({ lib, kill, A, B, ids, faultsAt }) => {
        const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
        const a = await lib.add(A), b = await lib.add(B);
        (await import('node:fs')).writeFileSync(ids, JSON.stringify([a, b]));
        await lib.setDefault(a);
        const gid = await lib.newGallery('Alpha');
        for (let n = 1; n <= 3; n++) await lib.putPage(gid, n, png(n));
        await lib.flush();
        // As across drives: the folder's rename refused, so it is copied.
        (await import(faultsAt)).failNext((c) => c.op === 'rename' && String(c.path).endsWith('/A/Alpha'), 'EXDEV', { times: 1 });
        let renamed = false;   // killed at the first file call after the copy's rename into place
        kill((c) => { if (renamed) return true; renamed = c.op === 'rename' && String(c.to).endsWith('/B/Alpha') && c.path.endsWith('.shiori-tmp'); return false; });
        await lib.move(gid, b);
      }, { A: path.join(dir, 'A'), B: path.join(dir, 'B'), ids, faultsAt: new URL('../../desktop/tests/fs-faults.mjs', import.meta.url).href }), 42);
      assert.ok(fs.existsSync(path.join(dir, 'B', 'Alpha')) && fs.existsSync(path.join(dir, 'A', 'Alpha')), 'killed once copied');
      const lib = await desktopLibrary(base);
      try {
        const [gid] = await lib.galleries();
        assert.deepEqual([await lib.read(gid, 1), await lib.read(gid, 2), await lib.read(gid, 3)], [png(1), png(2), png(3)]);
        assert.equal(path.dirname(/** @type {string} */ (await lib.dirOf(gid))), path.join(dir, 'A'), 'the move undone');
        await until(() => !fs.existsSync(path.join(dir, 'B', 'Alpha')));
        await lib.deleteGallery(gid);
        await lib.flush();
        await new Promise(r => setTimeout(r, 300));   // what a deletion leaves to do, once it commits
        for (const id of JSON.parse(fs.readFileSync(ids, 'utf8'))) await lib.scan(id);
        assert.deepEqual(await lib.galleries(), [], 'the deleted gallery never comes back');
      } finally { await lib.close(); }
    },
  },
  {
    // F10 (review 4, the desktop): killed as an unpack deleted the archive it was made from, the archive
    // stayed for good, a copy every check reported.
    name: 'review 4 F10: an archive an unpack let go, the app killed in its deletion, is deleted at the next start, never reported as a copy',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      await fx.close();
      const base = path.join(dir, 'desktop'), A = path.join(dir, 'A'), idFile = path.join(dir, 'A-id');
      assert.equal(desktopKilled(base, async ({ lib, kill, folder, idFile }) => {
        const fs = await import('node:fs'), path = await import('node:path');
        const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
        const id = await lib.add(folder);
        fs.writeFileSync(idFile, id);
        await lib.setDefault(id);
        const gid = await lib.newGallery('Alpha');
        for (let n = 1; n <= 3; n++) await lib.putPage(gid, n, png(n));
        await lib.flush();
        await lib.raw.archiveGallery(gid);
        while (fs.existsSync(path.join(folder, 'Alpha'))) await new Promise(r => setTimeout(r, 25));
        kill((c) => c.op === 'rm' && c.path.endsWith('/A/Alpha.zip'));
        await lib.putTranslation(gid, 2, png(9));
        await lib.flush();   // unpacked: the archive is deleted once that has committed
        for (let i = 0; i < 400 && fs.existsSync(path.join(folder, 'Alpha.zip')); i++) await new Promise(r => setTimeout(r, 25));
      }, { folder: A, idFile }), 42);
      assert.ok(fs.existsSync(path.join(A, 'Alpha.zip')), 'killed as the archive was deleted');
      const lib = await desktopLibrary(base);
      try {
        const [gid] = await lib.galleries();
        await until(() => !fs.existsSync(path.join(A, 'Alpha.zip')));
        for (let i = 0; i < 2; i++) assert.deepEqual((await lib.scan(fs.readFileSync(idFile, 'utf8'))).problems, [], 'nothing reported');
        assert.deepEqual([await lib.galleries(), await lib.read(gid, 1), await lib.read(gid, 2, 'translated'), await lib.read(gid, 3)], [[gid], png(1), png(9), png(3)]);
      } finally { await lib.close(); }
    },
  },
  {
    // S13's deviation 2 (S16): the same for an archive not in the gallery format — here an earlier version's,
    // described by its shiori.json — which an unpack deleted at once, unrecorded: killed there, it stayed for good.
    name: 'S16: an earlier version\'s archive an unpack let go, the app killed in its deletion, is deleted at the next start',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      await fx.close();
      const base = path.join(dir, 'desktop'), A = path.join(dir, 'A'), idFile = path.join(dir, 'A-id'), gid = '1790000000077';
      const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
      assert.equal(desktopKilled(base, async ({ lib, kill, folder, idFile, gid, zipAt }) => {
        const fs = await import('node:fs'), path = await import('node:path');
        const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
        const id = await lib.add(folder);
        fs.writeFileSync(idFile, id);
        const file = (n) => `000${n}.png`;
        await (await import(zipAt)).writeZip(path.join(folder, 'Old.cbz'), [...[1, 2, 3].map(n => ({ name: file(n), data: png(n) })),
          { name: 'shiori.json', data: Buffer.from(JSON.stringify({ format: 'shiori-gallery', version: 1, id: gid,
            meta: { galleryId: gid, title: { english: 'Old', japanese: '', pretty: '' }, tags: [], numPages: 3 },
            pages: [1, 2, 3].map(n => ({ n, file: file(n), key: `local://${gid}/${n}.png` })) })) }]);
        kill((c) => c.op === 'rm' && c.path.endsWith('/A/Old.cbz'));
        await lib.scan(id);
        await lib.putTranslation(gid, 2, png(9));
        await lib.flush();   // unpacked (if the check hasn't): the archive is deleted once that has committed
        for (let i = 0; i < 400 && fs.existsSync(path.join(folder, 'Old.cbz')); i++) await new Promise(r => setTimeout(r, 25));
      }, { folder: A, idFile, gid, zipAt: new URL('../../desktop/server/zip.js', import.meta.url).href }), 42);
      assert.ok(fs.existsSync(path.join(A, 'Old.cbz')) && fs.existsSync(path.join(A, 'Old')), 'killed as the archive was deleted');
      const lib = await desktopLibrary(base);
      try {
        await until(() => !fs.existsSync(path.join(A, 'Old.cbz')));
        for (let i = 0; i < 2; i++) assert.deepEqual((await lib.scan(fs.readFileSync(idFile, 'utf8'))).problems, [], 'nothing reported');
        assert.deepEqual([await lib.galleries(), await lib.read(gid, 1), await lib.read(gid, 3)], [[gid], png(1), png(3)]);
      } finally { await lib.close(); }
    },
  },
  {
    // F1 (review 5, the desktop): an earlier version's archive went whole once its gallery's first change
    // unpacked it, as if the unpack had taken all of it — with a file the person had put in it, unreported.
    name: 'review 5 F1: an earlier version\'s archive the person put a file in is left whole by the unpack, and reported; one holding only what Shiori put there goes',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const { writeZip, readDirectory, readEntry } = await import('../../desktop/server/zip.js');
      const file = (/** @type {number} */ n) => `000${n}.png`;
      // As v1.0.x archived a gallery: its pictures, its shiori.json and ComicInfo.xml.
      const earlier = (/** @type {string} */ name, /** @type {string} */ gid, /** @type {{ name: string, data: Uint8Array }[]} */ more) => writeZip(path.join(dir, 'A', name), [
        ...[1, 2, 3].map(n => ({ name: file(n), data: png(n) })),
        { name: 'shiori.json', data: new TextEncoder().encode(JSON.stringify({ format: 'shiori-gallery', version: 1, id: gid,
          meta: { galleryId: gid, title: { english: name, japanese: '', pretty: '' }, tags: [], numPages: 3 },
          pages: [1, 2, 3].map(n => ({ n, file: file(n), key: `local://${gid}/${n}.png` })) })) },
        { name: 'ComicInfo.xml', data: new TextEncoder().encode('<?xml version="1.0"?><ComicInfo></ComicInfo>') },
        ...more]);
      const mine = new TextEncoder().encode('the person\'s own notes, inside the archive');
      await earlier('Old.cbz', '1790000000077', [{ name: 'my-notes.txt', data: mine }]);
      await earlier('Plain.cbz', '1790000000078', []);
      const kept = fs.readFileSync(path.join(dir, 'A', 'Old.cbz'));
      assert.deepEqual((await fx.lib.scan(ref.id)).added, 2);
      // Each one's first change unpacks it: a translation.
      for (const gid of ['1790000000077', '1790000000078']) await fx.lib.putTranslation(gid, 2, png(9));
      await fx.lib.flush();
      await until(async () => (await fx.lib.list()).find(f => f.id === ref.id).attention.some(a => a.reason === 'left' && a.path === 'Old.cbz'));
      await until(() => !fs.existsSync(path.join(dir, 'A', 'Plain.cbz')));
      assert.deepEqual(fs.readFileSync(path.join(dir, 'A', 'Old.cbz')), kept, 'the archive holding the person\'s file stays as it was');
      const old = path.join(dir, 'A', 'Old.cbz');
      assert.deepEqual(new Uint8Array(await readEntry(old, (await readDirectory(old)).get('my-notes.txt'))), mine);
      for (let i = 0; i < 2; i++) await fx.lib.scan(ref.id);
      assert.deepEqual((await fx.lib.galleries()).sort(), ['1790000000077', '1790000000078'], 'nothing joins from it');
      for (const gid of ['1790000000077', '1790000000078']) {
        assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 2, 'translated'), await fx.lib.read(gid, 3)], [png(1), png(9), png(3)]);
      }
      // An archive of the gallery format the person put a file in keeps it too (S10's F6): added to, never unpacked.
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]);
      const zip = path.join(dir, 'A', 'Alpha.zip');
      await addToArchive(zip, 'my-notes.txt', mine);
      await fx.lib.putTranslation(gid, 2, png(9));
      await fx.lib.flush();
      assert.deepEqual(new Uint8Array(await readEntry(zip, (await readDirectory(zip)).get('my-notes.txt'))), mine);
      assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 2, 'translated'), await fx.lib.read(gid, 3)], [png(1), png(9), png(3)]);
    },
  },
  // ── The desktop deletes and cuts back only what is still as it recorded (review 4: F4, F6) ──
  {
    // F4 (review 4, the desktop): archiving retired its folder's files as they were once the archive was
    // written, so a file the person put there — in its .shiori/ before, or anywhere in it while the
    // archive was written — was deleted with them, unreported.
    name: 'review 4 F4: archiving leaves a file the person put in the gallery\'s folder, before or while the archive is written, reported',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const at = (/** @type {string[]} */ ...p) => path.join(dir, 'A', 'Alpha', ...p);
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) await fx.lib.putPage(gid, n, png(n));
      await fx.lib.flush();
      fs.writeFileSync(at('.shiori', 'my-notes.txt'), 'before');
      let planted = false;
      const back = faults.failNext((c) => {
        if (!planted && c.op === 'open' && /\/A\/Alpha\.zip\.[0-9a-f]+\.shiori-tmp$/.test(c.path)) { planted = true; fs.writeFileSync(at('my-notes.txt'), 'while'); }
        return false;
      }, 'EIO', { times: Infinity });
      try { assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]); } finally { back(); }
      assert.ok(planted, 'planted while the archive was written');
      await until(async () => (await fx.lib.list()).find(f => f.id === ref.id).attention.some(a => a.reason === 'left' && a.path === 'Alpha'));
      const files = (/** @type {string} */ d) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
        .map(e => path.relative(d, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();
      assert.deepEqual(files(at()), ['.shiori/my-notes.txt', 'my-notes.txt'], 'the person\'s files stay; Shiori\'s went');
      assert.deepEqual([fs.readFileSync(at('.shiori', 'my-notes.txt'), 'utf8'), fs.readFileSync(at('my-notes.txt'), 'utf8')], ['before', 'while']);
      const found = await fx.lib.scan(ref.id);
      assert.deepEqual([found.added, await fx.lib.galleries()], [0, [gid]], 'nothing joins from what was left');
      assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 3)], [png(1), png(3)]);
    },
  },
  {
    // F6 (review 4, the desktop): killed in an addition to an archive, then the archive edited by the
    // person with the app closed, the next start cut it back to its length before the addition: no
    // longer a ZIP, the gallery's pictures and the person's file unreadable.
    name: 'review 4 F6: an archive the person edited after an addition to it was cut short is never cut back',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      await fx.close();
      const base = path.join(dir, 'desktop'), A = path.join(dir, 'A');
      assert.equal(desktopKilled(base, async ({ lib, kill, folder }) => {
        const png = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
        await lib.setDefault(await lib.add(folder));
        const gid = await lib.newGallery('Alpha');
        for (let n = 1; n <= 3; n++) await lib.putPage(gid, n, png(n));
        await lib.flush();
        await lib.raw.archiveGallery(gid);
        await lib.setTitle(gid, 'Beta');
        kill((c) => c.op === 'open' && c.path.endsWith('/A/Alpha.zip') && lib.raw.files._row(gid)?.tail != null);
        await lib.flush();
      }, { folder: A }), 42);
      // The person's edit, the app closed: the archive written anew, every entry as it is, and a file of theirs.
      const file = path.join(A, 'Alpha.zip');
      const { readDirectory, readEntry } = await import('../../desktop/server/zip.js');
      const entries = [];
      for (const [name, e] of await readDirectory(file)) entries.push({ name, data: new Uint8Array(await readEntry(file, e)) });
      const edited = zipCreate([...entries, { name: 'my-notes.txt', data: new TextEncoder().encode('the person\'s own file') }]);
      fs.writeFileSync(file, edited);
      const lib = await desktopLibrary(base);
      try {
        const [gid] = await lib.galleries();
        await lib.flush();
        assert.deepEqual(fs.readFileSync(file).subarray(0, edited.length), Buffer.from(edited), 'the person\'s edit stays whole');
        const now = await readDirectory(file);
        assert.equal(String(await readEntry(file, now.get('my-notes.txt'))), 'the person\'s own file');
        assert.deepEqual([await lib.titleOf(gid), await lib.read(gid, 1), await lib.read(gid, 3)], ['Beta', png(1), png(3)]);
      } finally { await lib.close(); }
    },
  },
  {
    // The same rule (S14): an archive rewritten whole to give back its unused space took the place of the
    // archive as it was when the rewrite began, so a file the person added to it meanwhile was lost.
    name: 'S14: an archive the person edits while it is rewritten whole keeps their edit',
    platforms: ['desktop'],
    async run({ dir, fx }) {
      await fx.register('A');
      const gid = await fx.lib.newGallery('Alpha');
      for (let n = 1; n <= 3; n++) { await fx.lib.putPage(gid, n, png(n)); await fx.lib.putTranslation(gid, n, png(10 + n)); }
      await fx.lib.flush();
      assert.deepEqual((await fx.lib.raw.archiveGallery(gid)).archived, [gid]);
      const file = path.join(dir, 'A', 'Alpha.zip');
      const { readDirectory, readEntry } = await import('../../desktop/server/zip.js');
      // The person's edit: the archive written anew, every entry as it is, and a file of theirs — once the
      // rewrite is written and read back (the second open of its temporary file).
      const entries = [];
      for (const [name, e] of await readDirectory(file)) entries.push({ name, data: new Uint8Array(await readEntry(file, e)) });
      const edited = zipCreate([...entries, { name: 'my-notes.txt', data: new TextEncoder().encode('the person\'s own file') }]);
      let opens = 0;
      const back = faults.failNext((c) => {
        if (c.op === 'open' && c.path.endsWith('/A/Alpha.zip.shiori-tmp') && ++opens === 2) fs.writeFileSync(file, edited);
        return false;
      }, 'EIO', { times: Infinity });
      try {
        await fx.lib.raw.clearGalleryTranslations(gid);
        await fx.lib.raw.files.settle(gid).catch(() => {});
        assert.ok(opens >= 2, 'rewritten whole');
        await fx.lib.raw.files.settle(gid);
      } finally { back(); }
      const now = await readDirectory(file);
      assert.equal(String(await readEntry(file, now.get('my-notes.txt'))), 'the person\'s own file');
      assert.ok(![...now.keys()].some(n => n.startsWith('translated/')), 'its translations cleared');
      assert.deepEqual([await fx.lib.read(gid, 1), await fx.lib.read(gid, 3), await fx.lib.read(gid, 3, 'translated')], [png(1), png(3), png(3)]);
    },
  },
  // ── Generations travel with the work (principle 7) ──
  {
    // T07: a ZIP's picture changed in place (same name and size, another CRC-32) kept the translation of
    // the picture it replaced.
    name: 'T07: a linked ZIP\'s picture changed in place (same name and size) loses what was made from the old one; the others keep theirs',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const pack = (first) => fs.writeFileSync(path.join(dir, 'A', 'Pack.zip'), zipCreate([{ name: '001.png', data: first }, { name: '002.png', data: png(2) }]));
      pack(png(1));
      await fx.lib.scan(ref.id);
      const [gid] = await fx.lib.galleries();
      await fx.lib.putTranslation(gid, 1, png(11));
      await fx.lib.putTranslation(gid, 2, png(12));
      await fx.lib.flush();
      pack(png(9));
      await fx.lib.scan(ref.id);
      assert.deepEqual(await fx.lib.read(gid, 1), png(9), 'the new picture is read');
      assert.deepEqual(await fx.lib.read(gid, 1, 'translated'), png(9), 'with no translation over it');
      assert.deepEqual(await fx.lib.read(gid, 2, 'translated'), png(12), 'the page unchanged keeps its own');
      await fx.lib.flush();
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'A', '.shiori', 'linked', gid, 'gallery.json'), 'utf8'));
      assert.match(manifest.sources['1'].crc, /^[0-9a-f]{8}$/, 'a page records its picture\'s CRC-32');
      assert.equal(manifest.files.pages['1']?.translated, undefined);
      assert.ok(manifest.files.pages['2'].translated);
    },
  },
  {
    name: 'T07: a linked folder\'s picture replaced in place by one of the same size loses what was made from the old one; the others keep theirs',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const pics = path.join(dir, 'A', 'Pics');
      fs.mkdirSync(pics);
      const hourAgo = new Date(Date.now() - 3600_000);
      for (const [n, bytes] of [['001.png', png(1)], ['002.png', png(2)]]) {
        fs.writeFileSync(path.join(pics, n), bytes);
        fs.utimesSync(path.join(pics, n), hourAgo, hourAgo);
      }
      await fx.lib.scan(ref.id);
      const [gid] = await fx.lib.galleries();
      await fx.lib.putTranslation(gid, 1, png(11));
      await fx.lib.putTranslation(gid, 2, png(12));
      await fx.lib.flush();
      fs.writeFileSync(path.join(pics, '001.png'), png(9));   // the same size, written now
      await fx.lib.scan(ref.id);
      assert.deepEqual(await fx.lib.read(gid, 1), png(9));
      assert.deepEqual(await fx.lib.read(gid, 1, 'translated'), png(9), 'no translation over it');
      assert.deepEqual(await fx.lib.read(gid, 2, 'translated'), png(12), 'the page unchanged keeps its own');
      await fx.lib.flush();
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'A', '.shiori', 'linked', gid, 'gallery.json'), 'utf8'));
      assert.equal(manifest.sources['2'].mtime, hourAgo.getTime(), 'a page records its picture\'s modification time');
    },
  },
  {
    // A translation in flight while its linked page's picture changed (plan §2, S8): one made from the
    // old picture, coming back after a check read the new one, was kept on it.
    name: 'a translation made from a linked page\'s picture that changed in place before it came back is refused; one made from the picture as it is, kept',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const pack = (first) => fs.writeFileSync(path.join(dir, 'A', 'Pack.zip'), zipCreate([{ name: '001.png', data: first }, { name: '002.png', data: png(2) }]));
      pack(png(1));
      await fx.lib.scan(ref.id);
      const [gid] = await fx.lib.galleries();
      await fx.lib.flush();                     // published: nothing of the library's own waits (local changes win)
      const sent = await fx.lib.sources(gid);   // handed out with the pictures, as a translation reads them
      assert.notEqual(sent[1], '', 'a linked page has a token');
      pack(png(9));                             // changed while the translation is under way
      await fx.lib.scan(ref.id);
      await fx.lib.putTranslation(gid, 1, png(11), 'image/png', sent[1]);
      await fx.lib.putTranslation(gid, 2, png(12), 'image/png', sent[2]);
      assert.deepEqual(await fx.lib.read(gid, 1, 'translated'), png(9), 'the old picture\'s translation is refused');
      assert.deepEqual(await fx.lib.read(gid, 2, 'translated'), png(12), 'the page unchanged takes its own');
      await fx.lib.putTranslation(gid, 1, png(13), 'image/png', (await fx.lib.sources(gid))[1]);
      assert.deepEqual(await fx.lib.read(gid, 1, 'translated'), png(13), 'a translation of the picture as it is, kept');
      await fx.lib.flush();
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'A', '.shiori', 'linked', gid, 'gallery.json'), 'utf8'));
      assert.ok(manifest.files.pages['1'].translated && manifest.files.pages['2'].translated, 'both published');
    },
  },
  {
    // O1 (S10 review): a page of the library's own carried no token, so a translation of the picture it
    // had before it was stored again (downloaded again) was kept on the new picture.
    name: 'O1: a translation made from the picture a page of the library\'s own had before it was stored again is refused; one made from the picture as it is, kept',
    async run({ fx }) {
      await fx.register('A');
      const gid = await fx.lib.newGallery('Own');
      await fx.lib.putPage(gid, 1, png(20));
      await fx.lib.putPage(gid, 2, png(22));
      const sent = await fx.lib.sources(gid);
      assert.ok(sent[1] && sent[1] !== sent[2], 'each page has a token of its own');
      await new Promise(r => setTimeout(r, 10));
      await fx.lib.putPage(gid, 1, png(30));   // stored again, the same size, while the translation is under way
      await fx.lib.putTranslation(gid, 1, png(21), 'image/png', sent[1]);
      await fx.lib.putTranslation(gid, 2, png(23), 'image/png', sent[2]);
      assert.deepEqual(await fx.lib.read(gid, 1, 'translated'), png(30), 'the old picture\'s translation is refused');
      assert.deepEqual(await fx.lib.read(gid, 2, 'translated'), png(23), 'the page unchanged takes its own');
      await fx.lib.flush();
      assert.equal((await fx.lib.sources(gid))[2], sent[2], 'a publication keeps the token');
      await fx.lib.putTranslation(gid, 1, png(31), 'image/png', (await fx.lib.sources(gid))[1]);
      assert.deepEqual(await fx.lib.read(gid, 1, 'translated'), png(31), 'a translation of the picture as it is, kept');
    },
  },
  {
    // T10: a drawing of a PDF's earlier version was kept, stamped as of the file as it is now.
    name: 'T10: a PDF\'s drawing, or its failure, is kept only for the version of the file it read',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const pdf = path.join(dir, 'A', 'Book.pdf');
      fs.writeFileSync(pdf, '%PDF-1.4 version A');
      await fx.lib.scan(ref.id);
      const [w] = await fx.lib.pdfsWaiting();
      const marker = () => JSON.parse(fs.readFileSync(path.join(dir, 'A', '.shiori', 'linked', w.gid, 'source.json'), 'utf8')).source;
      const a = await fx.lib.pdfSource(w.folder, w.gid);
      fs.writeFileSync(pdf, '%PDF-1.4 version B, longer');
      await fx.lib.scan(ref.id);
      const stale = (/** @type {any} */ e) => e.code === 'conflict' && e.reason === 'stale';
      await assert.rejects(fx.lib.addRendered(w.folder, w.gid, [png(1)], a.token), stale, 'a drawing of A refused');
      await assert.rejects(fx.lib.pdfFailed(w.folder, w.gid, a.token), stale, 'and A\'s failure');
      await assert.rejects(fx.lib.addRendered(w.folder, w.gid, [png(1)], undefined), stale, 'and a drawing naming no version');
      assert.deepEqual(await fx.lib.galleries(), [], 'nothing joined');
      assert.deepEqual([marker().rendered, marker().failed], [undefined, undefined], 'nothing noted');
      assert.deepEqual((await fx.lib.pdfsWaiting()).map(x => x.gid), [w.gid], 'it still waits');
      const b = await fx.lib.pdfSource(w.folder, w.gid);
      assert.equal(await fx.lib.addRendered(w.folder, w.gid, [png(2)], b.token), w.gid);
      assert.equal(marker().rendered.fingerprint, b.token, 'kept as drawn from B');
      // Drawn again once it changed, and changed again while that drawing was under way.
      await fx.lib.flush();   // (a gallery with changes not published yet isn't read again: they win)
      fs.writeFileSync(pdf, '%PDF-1.4 version C, longer still');
      await fx.lib.scan(ref.id);
      const c = await fx.lib.pdfSource(w.folder, w.gid);
      fs.writeFileSync(pdf, '%PDF-1.4 version D');
      await assert.rejects(fx.lib.addRendered(w.folder, w.gid, [png(3), png(4)], c.token), stale);
      assert.deepEqual([await fx.lib.read(w.gid, 1), await fx.lib.read(w.gid, 2)], [png(2), null], 'its pages as they were');
      await fx.lib.scan(ref.id);
      const d = await fx.lib.pdfSource(w.folder, w.gid);
      assert.equal(await fx.lib.addRendered(w.folder, w.gid, [png(3), png(4)], d.token), w.gid);
      assert.deepEqual([await fx.lib.read(w.gid, 1), await fx.lib.read(w.gid, 2)], [png(3), png(4)]);
      assert.deepEqual(await fx.lib.pdfsWaiting(), [], 'drawn from the file as it is');
    },
  },
  {
    // T11: an empty drawing of a PDF the library had replaced its pages with none (the website).
    name: 'T11: an empty or broken drawing of a PDF is refused before anything is written, and the pages a gallery has stay',
    async run({ dir, fx }) {
      const ref = await fx.register('A');
      const pdf = path.join(dir, 'A', 'Book.pdf');
      fs.writeFileSync(pdf, '%PDF-1.4 first');
      await fx.lib.scan(ref.id);
      const [w] = await fx.lib.pdfsWaiting();
      const images = path.join(dir, 'A', '.shiori', 'linked', w.gid, 'images');
      const invalid = (/** @type {any} */ e) => e.code === 'invalid';
      const first = await fx.lib.pdfSource(w.folder, w.gid);
      await assert.rejects(fx.lib.addRendered(w.folder, w.gid, [], first.token), invalid, 'no pages');
      assert.ok(!fs.existsSync(images) || fs.readdirSync(images).length === 0, 'nothing written');
      assert.equal(await fx.lib.addRendered(w.folder, w.gid, [png(1), png(2)], first.token), w.gid);
      await fx.lib.flush();
      fs.writeFileSync(pdf, '%PDF-1.4 second, longer');
      await fx.lib.scan(ref.id);
      const second = await fx.lib.pdfSource(w.folder, w.gid);
      await assert.rejects(fx.lib.addRendered(w.folder, w.gid, [], second.token), invalid, 'no pages');
      await assert.rejects(fx.lib.addRendered(w.folder, w.gid, [png(3), new Uint8Array(0)], second.token), invalid, 'a page with no bytes');
      assert.deepEqual([await fx.lib.read(w.gid, 1), await fx.lib.read(w.gid, 2)], [png(1), png(2)], 'its pages stay');
      assert.deepEqual((await fx.lib.pdfsWaiting()).map(x => x.gid), [w.gid], 'it still waits to be drawn');
    },
  },
  // ── The write budget (plan D23): what each operation writes, as the adapter counts it ──
  {
    name: 'a page stored writes its picture once, and a page replaced its new picture once',
    async run({ fx }) {
      await fx.register('A');
      const gid = await fx.lib.newGallery('Budget');
      const page = await stored(fx, () => fx.lib.putPage(gid, 1, png(1, 2, 3)));
      assert.equal(page.picture, 7, 'the page, once');
      const again = await stored(fx, () => fx.lib.putPage(gid, 1, png(4, 5, 6, 7)));
      assert.equal(again.picture, 8, 'the new page, once');
      assert.deepEqual(await fx.lib.read(gid, 1), png(4, 5, 6, 7));
    },
  },
  {
    name: 'a change to a gallery\'s description writes no picture',
    async run({ fx }) {
      await fx.register('A');
      const gid = await fx.lib.newGallery('Budget');
      await stored(fx, () => fx.lib.putPage(gid, 1, png(1, 2, 3)));
      const retitled = await stored(fx, () => fx.lib.setTitle(gid, 'Budget, retitled'));
      assert.equal(retitled.picture, 0);
      assert.ok(retitled.description > 0, 'its descriptions written');
      const at = await fx.lib.dirOf(gid);
      const size = (rel) => fs.statSync(path.join(at, ...rel.split('/'))).size;
      assert.equal(retitled.description, size('.shiori/gallery.json') + 2 * size('metadata.json'),
        'its manifest and its metadata (stored by its content, and its copy): no other description written');
    },
  },
  {
    name: 'hiding and showing a library folder write no picture',
    async run({ fx }) {
      const ref = await fx.register('A');
      const gid = await fx.lib.newGallery('Budget');
      await stored(fx, () => fx.lib.putPage(gid, 1, png(1, 2, 3)));
      const both = await stored(fx, async () => { await fx.hide(ref); await fx.lib.show(ref.id); });
      assert.equal(both.picture, 0);
      assert.deepEqual(await fx.lib.read(gid, 1), png(1, 2, 3));
    },
  },
  {
    name: 'a gallery moved to another library folder on the same drive writes no picture (D25)',
    platforms: ['desktop'],
    async run({ fx }) {
      await fx.register('A');
      const gid = await fx.lib.newGallery('Moving');
      await stored(fx, () => fx.lib.putPage(gid, 1, png(1, 2, 3)));
      const to = await fx.register('B');
      const moved = await stored(fx, () => fx.lib.move(gid, to.id));
      assert.equal(moved.picture, 0);
      assert.ok((await fx.lib.dirOf(gid))?.startsWith(to.location), 'it is in the folder it moved to');
      assert.deepEqual(await fx.lib.read(gid, 1), png(1, 2, 3));
    },
  },
  {
    name: 'a gallery moved to another library folder has each picture copied once',
    platforms: ['website'],
    async run({ fx }) {
      await fx.register('A');
      const gid = await fx.lib.newGallery('Moving');
      await stored(fx, () => fx.lib.putPage(gid, 1, png(1, 2, 3)));
      const to = await fx.register('B');
      const moved = await stored(fx, () => fx.lib.move(gid, to.id));
      assert.equal(moved.picture, 7);
      assert.deepEqual(await fx.lib.read(gid, 1), png(1, 2, 3));
    },
  },
];

// Gallery `gid` reserved in `root` and published twice through the adapter: the first generation
// (titled First, one page, its translation `first`), then the second (titled Second, a second page and
// a new translation `second` beside the first) — the second's `failAt`-th write failed, when given (the
// publication cut short there: every write after it not made). Resolves { name: its directory, first,
// second, writes: how many writes the second publication made }.
async function twoGenerations(root, gid, { platform, failAt = 0 }) {
  const g = await root.reserve(`G ${gid}`, gid, null);
  const meta = (english) => JSON.stringify({ galleryId: gid, title: { english, japanese: '', pretty: '' } });
  const records = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ url: `local://${gid}/${i + 1}.png`, translated: i === 0 })));
  const sized = (...files) => Object.fromEntries(files.map(f => [f.name, [f.size, f.mtime]]));
  const manifest = (pages, sizes) => ({ format: 'shiori-gallery', version: 2, galleryId: gid, generation: 1, writer: 'conformance', files: { pages, covers: {} }, sizes });
  const o = await g.writeNew('images/0001', 'png', png(1));
  const t1 = await g.writeNew('translated/0001', 'png', png(2));
  await g.publish({ manifest: manifest({ 1: { original: o.name, translated: t1.name } }, sized(o, t1)), descriptions: { 'metadata.json': meta('First'), 'image_records.json': records(1) } });
  const o2 = await g.writeNew('images/0002', 'png', png(3));
  const t2 = await g.writeNew('translated/0001', 'png', png(4));
  let writes = 0;
  const nth = () => ++writes === failAt;
  const undo = platform === 'website'
    ? fsa.failNext((c) => c.op === 'close' && c.path.startsWith(`${g.name}/`) && nth(), 'InvalidStateError', { times: 1e6 })
    : faults.failNext((c) => c.op === 'rename' && String(c.to).toLowerCase().includes(`/${g.name.toLowerCase()}/`) && nth(), 'EIO', { times: 1e6 });
  try {
    await g.publish({ manifest: manifest({ 1: { original: o.name, translated: t2.name }, 2: { original: o2.name } }, sized(o, t2, o2)),
      descriptions: { 'metadata.json': meta('Second'), 'image_records.json': records(2) } }).catch(() => {});
  } finally { undo(); }
  return { name: g.name, first: t1.name, second: t2.name, writes };
}
// F3 (review 6): a gallery an earlier version wrote, read back at its folder's first check while one call
// of that check answers "not found" — each row of the review's table, on the apps it names (the website's
// listings answered so already: S18). A row: what it is, the gallery's folder ('v1' with its files list,
// 'v1 bare' without, 'oldest': the desktop's shiori.json beside its pictures), and per app the call (its
// op, the file in the gallery's folder, which such call). On v1.2.6 each row left the gallery read in
// part for good: a page or its translation gone, the picture a page had replaced shown, an empty gallery,
// or its images/ and translated/ joined as galleries of their own; and nothing was reported.
function earlierVersionCases() {
  /** @type {[string, 'v1' | 'v1 bare' | 'oldest', Partial<Record<'desktop' | 'website', [string, string, number?]>>][]} */
  const rows = [
    ['the read of metadata.json as the folder is told', 'v1', { desktop: ['readFile', 'metadata.json'], website: ['getFile', 'metadata.json'] }],
    ['the listing of images/', 'v1 bare', { desktop: ['readdir', 'images'] }],
    ['a page\'s picture', 'v1', { desktop: ['stat', 'images/0002.webp'], website: ['getFile', 'images/0002.webp'] }],
    ['the listing of translated/', 'v1', { desktop: ['readdir', 'translated'] }],
    ['the translation\'s picture', 'v1', { desktop: ['stat', 'translated/0001.png'], website: ['getFile', 'translated/0001.png'] }],
    ['the read of image_records.json', 'v1', { desktop: ['readFile', 'image_records.json'], website: ['getFile', 'image_records.json'] }],
    ['the second read of metadata.json', 'v1', { desktop: ['readFile', 'metadata.json', 2] }],
    ['the first read of shiori.json', 'oldest', { desktop: ['readFile', 'shiori.json'] }],
    ['the second read of shiori.json', 'oldest', { desktop: ['readFile', 'shiori.json', 2] }],
  ];
  return rows.map(([row, kind, calls]) => /** @type {Case} */ ({
    name: `review 6 F3: an earlier version's gallery (${kind}) read back while ${row} answers "not found" joins whole at a later check`,
    platforms: /** @type {('website' | 'desktop')[]} */ (Object.keys(calls)),
    async run({ dir, fx, platform }) {
      const at = path.join(dir, 'A', 'Old one');
      const old = kind === 'oldest' ? legacyGallery(at) : await v1Gallery(at, { files: kind === 'v1' });
      const bytes = (/** @type {string} */ rel) => new Uint8Array(fs.readFileSync(path.join(at, ...rel.split('/'))));
      // What it reads with no fault: its pages (v1 without its files list shows the layout name's picture),
      // and page 1's translation (the oldest format has none: the original).
      const want = kind === 'oldest' ? [bytes('0001.webp'), bytes('0002.webp'), bytes('0001.webp')]
        : [bytes(kind === 'v1' ? /** @type {any} */ (old).current[1] : 'images/0001.webp'), bytes('images/0002.webp'), bytes('translated/0001.png')];
      const ref = await fx.register('A');
      const [op, file, nth = 1] = /** @type {[string, string, number?]} */ (calls[platform]);
      let n = 0;
      const once = (platform === 'desktop' ? faults : fsa).failNext((c) => c.op === op && (platform === 'desktop' ? c.path.endsWith(`/A/Old one/${file}`)
        : c.path === `Old one/${file}`) && ++n === nth, platform === 'desktop' ? 'ENOENT' : 'NotFoundError', { times: Infinity });
      const first = await fx.lib.scan(ref.id);
      once();
      assert.ok(n >= nth, 'the call was made');
      assert.ok(first.problems.some(p => p.path.startsWith('Old one')), 'the gallery is reported, not read in part');
      await fx.lib.flush();
      await fx.lib.scan(ref.id);
      await fx.lib.flush();
      assert.deepEqual((await fx.lib.scan(ref.id)).problems, [], 'nothing left to report');
      assert.deepEqual(await fx.lib.galleries(), [old.gid], 'the gallery alone joined');
      assert.deepEqual([await fx.lib.read(old.gid, 1), await fx.lib.read(old.gid, 2), await fx.lib.read(old.gid, 1, 'translated')], want, 'whole');
    },
  }));
}

// Gallery folder `name` of the library folder at `folder` read back by both apps' readers (each
// adapter's loadGallery, over gallery-manifest.js readGallery): { desktop, website }. The website's is
// handed the folder's own id: an answer of "not found" counts there only while the folder is it
// (contract.js surelyMissing).
async function readBoth(folder, name) {
  const id = JSON.parse(fs.readFileSync(path.join(folder, '.shiori', 'library.json'), 'utf8')).id;
  const website = (await websiteLoad(id, fsa.directory(folder), name)).read;
  forgetFolder(id);
  return { desktop: (await desktopLoad(path.join(folder, ...name.split('/')))).read, website };
}

// What `work` wrote, by kind, once the library has settled it into its folders.
async function stored(/** @type {Fixture} */ fx, /** @type {() => Promise<unknown>} */ work) {
  await fx.lib.flush();
  const before = fx.lib.written();
  await work();
  await fx.lib.flush();
  const after = fx.lib.written();
  return Object.fromEntries(Object.keys(after).map(k => [k, after[k] - before[k]]));
}

/**
 * Registers the suite for one platform's adapter.
 * @param {'website' | 'desktop'} platform
 * @param {((dir: string) => Promise<Fixture>) | null} makeFixture the adapter and its library over
 *   folder `dir`; null while the platform has none (its cases are then skipped)
 */
export function conformance(platform, makeFixture) {
  describe(`folder store conformance (${platform})`, () => {
    for (const c of CASES.filter((c) => !c.platforms || c.platforms.includes(platform))) {
      test(c.name, { skip: !makeFixture && 'no adapter yet', todo: c.todo?.[platform] }, async (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-conformance-'));
        const fx = await /** @type {NonNullable<typeof makeFixture>} */ (makeFixture)(dir);
        t.after(async () => { faults.reset(); fsa.reset(); await fx.close(); fs.rmSync(dir, { recursive: true, force: true }); });
        await c.run({ dir, store: fx.store, fx, platform });
      });
    }
  });
}

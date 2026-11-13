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
import { desktopLibrary, webLibrary } from './library-drivers.mjs';
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
    // Principle 2: only a reservation makes a directory a gallery's — with its first generation.
    name: 'a reservation publishes the gallery\'s first generation: its directory names it from its first moment',
    async run({ dir, store, fx }) {
      const root = await opened(store, await fx.register('A'));
      const g = await root.reserve('Reserved', '1700000000001', null);
      const m = await g.manifest();
      assert.equal(m.kind, 'ok');
      assert.deepEqual([m.value.galleryId, m.value.generation, Object.keys(m.value.files.pages)], ['1700000000001', 1, []]);
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'A', ...g.name.split('/'), 'metadata.json'), 'utf8'));
      assert.equal(meta.galleryId, '1700000000001', 'and its metadata.json names it, for older readers');
      for (const read of Object.values(await readBoth(path.join(dir, 'A'), g.name))) assert.equal(read.kind, 'ok');
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
// Gallery folder `name` of the library folder at `folder` read back by both apps' readers (each
// adapter's loadGallery, over gallery-manifest.js readGallery): { desktop, website }.
let reads = 0;
async function readBoth(folder, name) {
  const id = `conformance-read-${++reads}`;
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

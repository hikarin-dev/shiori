// folder-store.conformance.mjs — the folder store contract (storage/contract.js) checked on one
// adapter (plan §6.1). One suite, run by an entry file per app — folder-store-web.test.mjs for the
// website's adapter (under Node, over real temporary folders: fsa-node.mjs), desktop/tests/
// folder-store.test.mjs for the desktop's — so both answer every operation alike. Each case gets a
// temporary folder of its own and a fixture made over it: the adapter (`store`) and the library it
// belongs to, to set the case up with (folder-store-today.mjs says what a fixture offers).
//
// Until S3 the adapters are today's code behind the contract (folder-store-today.mjs), and a case
// that today's code fails is marked todo with the step that fixes it, and the finding (plan §5) it
// rediscovers where it is one. Still to come with S4's format: publish interrupted after each of its
// writes, then reopened and read by both apps' adapters (the whole previous generation or the whole
// new one, never a mix, never neither), and description files whose content doesn't match their name
// read as corrupt.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fsa from './fsa-node.mjs';
import * as faults from '../../desktop/tests/fs-faults.mjs';

/** @typedef {import('./folder-store-today.mjs').Fixture} Fixture */
/** A case: what it checks, the platforms it applies to (both when not said), what today's code gets
 * wrong (per platform: the step that fixes it and the finding), and the check itself.
 * @typedef {{ name: string, platforms?: ('website' | 'desktop')[], todo?: Partial<Record<'website' | 'desktop', string>>,
 *   run(ctx: { dir: string, store: Fixture['store'], fx: Fixture, platform: 'website' | 'desktop' }): Promise<void> }} Case */

const PURPOSES = /** @type {const} */ (['read', 'write', 'removal', 'claim']);
const png = (...tag) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...tag]);
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

/** @type {Case[]} */
export const CASES = [
  // ── Identity: open() ──
  {
    name: 'a folder put where a library folder was, with another library\'s id, is refused for every purpose (other-library)',
    todo: { desktop: 'S5: T01', website: 'S5: T01' },
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
    todo: { desktop: 'S5: T01', website: 'S5: T01' },
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
    todo: { desktop: 'S5: T02', website: 'S5: T02' },
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
    todo: { desktop: 'S4: principle 3, the rename into place behind T06' },
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
    todo: { website: 'S3: principle 6' },
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
    todo: { desktop: 'S4: principle 4', website: 'S4: principle 4' },
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
  {
    name: 'a write to a gallery whose directory was taken away settles, refused',
    todo: { website: 'S3: N1' },
    async run({ dir, store, fx }) {
      const root = await opened(store, await fx.register('A'));
      const g = await root.reserve('Taken away', '1700000000001', null);
      await g.writeNew('images/0001', 'png', png(1));
      fs.rmSync(path.join(dir, 'A', ...g.name.split('/')), { recursive: true });
      assert.notEqual(await settles(g.writeNew('translated/0001', 'png', png(2))), 'never settled');
    },
  },
  // ── Containment (the desktop: links are visible to it) ──
  {
    name: 'a junction in a gallery\'s own subfolder is never followed: nothing outside is written or swept',
    platforms: ['desktop'],
    todo: { desktop: 'S5: T04' },
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
];

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

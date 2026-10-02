// move.test.mjs — a browser library moves into the desktop library whole: every gallery with its
// pages (bytes untouched), translations, cover and series links, the desktop library passing its
// checks afterwards; a move cut short carries on where it stopped; only what was added since a
// moment can be moved (what was saved while the desktop app couldn't be reached).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const _ls = new Map();
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };

const { Library } = await import('../server/library.js');
const { startServer } = await import('../server/server.js');
const api = await import('../../app/js/api.js');
const { browserGalleries, moveToDesktop } = await import('../../app/js/library-move.js');
const { checkInvariants } = await import('../../app/js/library-check.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-move-'));
const desktop = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), packDelay: 0 }).open();
const TOKEN = 'move-test-token-0123456789';
const server = await startServer({ library: desktop, token: TOKEN });
const config = { url: server.url, token: TOKEN };
test.after(async () => { await server.close(); desktop.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const png = (...b) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...b])], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytes = async (blob) => [...new Uint8Array(await blob.arrayBuffer())];

let next = 1790100000000;
async function gallery(name, pages = 2) {
  const gid = String(next++);
  await api.meta.put({ galleryId: gid, title: title(name), tags: [{ type: 'tag', name: 'moved' }], numPages: pages });
  for (let n = 1; n <= pages; n++) await api.pages.put(gid, n, png(n, gid.length));
  return gid;
}

test('a browser library moves whole', async () => {
  assert.equal(api.capabilities.browserLibrary, true, 'the test page uses this browser\'s library');
  const plain = await gallery('Plain', 3);
  const translated = await gallery('Translated', 1);
  await api.derived.putTranslation(translated, 1, { image: png(9, 9), pipeline: { job: 'j1' }, own: 'j1' });
  const [owner, chapter] = [await gallery('Owner'), await gallery('Chapter')];
  await api.series.attach(owner, chapter);

  const ids = await browserGalleries();
  assert.deepEqual(ids.sort(), [plain, translated, owner, chapter].sort());
  const seen = [];
  const result = await moveToDesktop(config, ids, { onProgress: (done, total) => seen.push(`${done}/${total}`) });
  assert.deepEqual(result, { moved: 4, failed: [], errors: [] });
  assert.equal(seen.at(-1), '4/4');

  for (const gid of ids) {
    const before = await api.transfer.read(gid);
    const after = await desktop.transferRead(gid);
    assert.deepEqual(after.meta.title, before.meta.title, gid);
    assert.deepEqual(await Promise.all(after.pages.map(p => bytes(p.blob))), await Promise.all(before.pages.map(p => bytes(p.blob))), `${gid}: every page, bytes untouched`);
  }
  assert.deepEqual(await bytes((await desktop.pageGet(translated, 1)).translated), await bytes(png(9, 9)), 'its translation too');
  assert.equal((await desktop.metaGet(chapter)).parentId, owner, 'the series together');
  assert.deepEqual(checkInvariants(await desktop.integritySnapshot()).violations.filter(v => v.severity === 'error'), []);
  assert.equal(await api.meta.get(plain).then(m => m.title.english), 'Plain', 'the browser keeps its copy');
});

test('a move cut short carries on where it stopped', async () => {
  const ids = [await gallery('A'), await gallery('B'), await gallery('C'), await gallery('D')];
  const stop = new AbortController();
  const first = await moveToDesktop(config, ids, { signal: stop.signal, onProgress: (done) => { if (done === 2) stop.abort(); } });
  assert.equal(first.moved, 2);
  assert.equal(await desktop.metaGet(ids[3]), null, 'not yet moved');
  const written = [];
  const original = desktop.transferWrite.bind(desktop);
  desktop.transferWrite = (bundle, opts) => { written.push(bundle.galleryId); return original(bundle, opts); };
  const rest = await moveToDesktop(config, ids);
  desktop.transferWrite = original;
  assert.deepEqual(written, ids.slice(2), 'only what was left');
  assert.equal(rest.errors.length, 0);
  assert.equal((await desktop.metaGet(ids[3])).title.english, 'D');
});

test('only what was added since a moment is picked to move', async () => {
  const since = Date.now() + 1;
  await new Promise(r => setTimeout(r, 5));
  next = Date.now();
  const late = await gallery('Saved meanwhile');
  assert.deepEqual(await browserGalleries({ since }), [late]);
});

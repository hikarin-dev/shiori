// move.test.mjs — a browser library moves into the desktop library whole: every gallery with its
// pages (bytes untouched), translations, cover and series links, the desktop library passing its
// checks afterwards; a move cut short carries on where it stopped; only what was added since a
// moment can be moved (what was saved while the desktop app couldn't be reached). A gallery too big
// for one message goes in parts, recorded whole or not at all (what a part wrote goes when a later
// one fails or its connection does), and a message the app won't take ends that connection, not the
// app.
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
const { createClient } = await import('../../app/js/desktop-backend.js');
const { WebSocket } = await import('ws');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-move-'));
const desktop = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), placeDelay: 0 }).open();
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

test('a gallery too big for one message goes in parts and arrives whole', async () => {
  const gid = await gallery('Large', 3);
  await api.derived.putTranslation(gid, 2, { image: png(7, 7, 7), pipeline: { job: 'j2' }, own: 'j2' });
  const bundle = await api.transfer.read(gid);
  const client = createClient(config, { partBytes: 12 });   // each page's pictures fill a part
  const written = [];
  const original = desktop.transferWrite.bind(desktop);
  desktop.transferWrite = (part, opts) => { written.push([part.pages.map(p => p.url), !!part.meta, opts.transfer?.id, !!opts.transfer?.last]); return original(part, opts); };
  let result;
  try {
    result = await client.transferWrite({ galleryId: gid, ...bundle }, { silent: false });
  } finally {
    desktop.transferWrite = original;
    client.close();
  }
  const id = written[0][2];
  assert.ok(id, 'the parts are one transfer');
  assert.deepEqual(written, bundle.pages.map((p, i) => [[p.url], i === 0, id, i === 2]), 'one part a page; the details with the first; recorded with the last');
  assert.deepEqual(result, { pages: 3 });
  const after = await desktop.transferRead(gid);
  assert.equal(after.meta.title.english, 'Large');
  assert.deepEqual(await Promise.all(after.pages.map(p => bytes(p.blob))), await Promise.all(bundle.pages.map(p => bytes(p.blob))));
  assert.deepEqual(await bytes((await desktop.pageGet(gid, 2)).translated), await bytes(png(7, 7, 7)));
});

// Every file under the desktop library's folder (its galleries' folders and staging).
const filesUnder = (root) => fs.readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(d => d.isFile()).map(d => path.join(d.parentPath ?? d.path, d.name));
const pictures = () => filesUnder(path.join(dir, 'library')).filter(f => /\.(png|webp|jpg)$/i.test(f));

test('a gallery in parts is recorded whole or not at all: a part that fails takes the others with it', async () => {
  const gid = await gallery('Parts fail', 3);
  const bundle = await api.transfer.read(gid);
  const before = pictures().length;
  const client = createClient(config, { partBytes: 12 });
  const original = desktop.transferWrite.bind(desktop);
  desktop.transferWrite = (part, opts) => (opts.transfer?.last ? Promise.reject(new Error('disk gone')) : original(part, opts));
  try {
    await assert.rejects(client.transferWrite({ galleryId: gid, ...bundle }, { silent: true }));
  } finally {
    desktop.transferWrite = original;
  }
  await new Promise(r => setTimeout(r, 100));   // the abort it sends
  client.close();
  assert.equal(await desktop.metaGet(gid), null, 'nothing recorded');
  assert.deepEqual(await desktop.pageList(gid), []);
  assert.equal(pictures().length, before, 'and no picture the first parts wrote is left');
});

test('a gallery in parts whose connection goes before the last part leaves nothing behind', async () => {
  const gid = await gallery('Parts cut', 2);
  const bundle = await api.transfer.read(gid);
  const before = pictures().length;
  const client = createClient(config);
  // The first part only, as a transfer that never finishes.
  await client.transferWrite({ galleryId: gid, meta: bundle.meta, stat: bundle.stat, pages: bundle.pages.slice(0, 1) }, { silent: true, transfer: { id: 't1', last: false } });
  assert.equal(pictures().length, before + 1, 'its page was written');
  client.close();
  for (let i = 0; i < 50 && pictures().length !== before; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(pictures().length, before, 'and went with the connection');
  assert.equal(await desktop.metaGet(gid), null);
});

test('a gallery whose connection goes while its last part is written records nothing', async () => {
  const gid = await gallery('Last part cut', 12);
  const bundle = await api.transfer.read(gid);
  const before = pictures().length;
  const client = createClient(config, { partBytes: 40 });   // a few pages a part
  const page = desktop._transferPage.bind(desktop);
  desktop._transferPage = async (...a) => { await new Promise(r => setTimeout(r, 15)); return page(...a); };   // a slow disk
  const original = desktop.transferWrite.bind(desktop);
  desktop.transferWrite = (part, opts) => { if (opts?.transfer?.last) setTimeout(() => client.close(), 5); return original(part, opts); };
  try {
    await assert.rejects(client.transferWrite({ galleryId: gid, ...bundle }, { silent: true }));
    for (let i = 0; i < 100 && (desktop._transfers.size || pictures().length !== before); i++) await new Promise(r => setTimeout(r, 20));
  } finally {
    desktop._transferPage = page;
    desktop.transferWrite = original;
  }
  assert.equal(await desktop.metaGet(gid), null, 'nothing recorded');
  assert.deepEqual(await desktop.pageList(gid), []);
  assert.equal(pictures().length, before, 'and none of its files are left');
  assert.equal(desktop.files._row(gid), undefined, 'nor the folder claimed for it');
});

test('a page that fails while the others are written leaves nothing of its gallery', async () => {
  const gid = '1790999999990';
  const before = pictures().length;
  class Unreadable extends Blob { arrayBuffer() { return new Promise((_, reject) => setTimeout(() => reject(new Error('read failed')), 5)); } }
  const pages = Array.from({ length: 30 }, (_, i) => ({ url: `local://${gid}/${i + 1}.png`, galleryId: gid, blob: png(i + 1, 3) }));
  pages[1] = { ...pages[1], blob: new Unreadable([png(2)], { type: 'image/png' }) };
  await assert.rejects(desktop.transferWrite({ galleryId: gid, meta: { galleryId: gid, title: title('Fails part way') }, pages }));
  assert.equal(pictures().length, before, 'nothing written stays');
  assert.equal(desktop.files._row(gid), undefined);
  assert.equal(await desktop.metaGet(gid), null);
});

test('a page another gallery holds is refused, not taken from it', async () => {
  const owner = await gallery('Owner of key', 1);
  const bundle = await api.transfer.read(owner);
  const moved = await moveToDesktop(config, [owner]);
  assert.equal(moved.moved, 1);
  const thief = '1790999999999';
  const client = createClient(config);
  try {
    await assert.rejects(client.transferWrite({ galleryId: thief, meta: { ...bundle.meta, galleryId: thief }, stat: null,
      pages: bundle.pages.map(p => ({ ...p, galleryId: thief })) }), (e) => e.code === 'conflict');
  } finally { client.close(); }
  assert.equal((await desktop.pageList(owner)).length, 1, 'the owner keeps its page');
  assert.equal(await desktop.metaGet(thief), null);
  assert.equal(desktop.files._row(thief), undefined, 'and no folder was claimed for it');
});

test('a page with no number or no picture is refused, not left out', async () => {
  const client = createClient(config);
  try {
    await assert.rejects(client.transferWrite({ galleryId: '1790999999998', meta: { galleryId: '1790999999998', title: title('x') },
      pages: [{ url: 'local://1790999999998/cover.png', blob: png(1) }] }), (e) => e.code === 'invalid');
    await assert.rejects(client.transferWrite({ galleryId: '1790999999998', meta: { galleryId: '1790999999998', title: title('x') },
      pages: [{ url: 'local://1790999999998/1.png' }] }), (e) => e.code === 'invalid');
  } finally { client.close(); }
  assert.equal(await desktop.metaGet('1790999999998'), null);
});

test('a frame whose pictures are shorter than it says is refused', async () => {
  const { encode, decode } = await import('../../app/js/desktop-wire.js');
  const frame = await encode({ id: 1, op: 'x', args: [png(1, 2, 3)] });
  assert.throws(() => decode(frame.subarray(0, frame.length - 1)));
  assert.equal((await decode(frame).args[0].arrayBuffer()).byteLength, 7);
});

test('a message the app will not take ends that connection, and the app carries on', async () => {
  const bad = new WebSocket(`${server.url.replace(/^http/, 'ws')}/api/ws?k=${TOKEN}`);
  await new Promise((resolve, reject) => { bad.once('open', resolve); bad.once('error', reject); });
  const closed = new Promise((resolve) => bad.once('close', (code) => resolve(code)));
  bad.on('error', () => {});
  // A masked frame with a reserved bit set: no frame the app can read.
  bad._socket.write(Buffer.from([0xc2, 0x80, 0, 0, 0, 0]));
  assert.equal(await closed, 1002, 'closed as a protocol error');
  const client = createClient(config);
  try {
    assert.ok(Array.isArray(await client.transferIds()), 'the app still answers');
  } finally { client.close(); }
});

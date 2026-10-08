// settle.test.mjs — when a gallery's files on disk are brought up to date. An edit made by hand (its
// metadata, tags, cover, series) is written at once. Pages that arrive page by page are not: their
// descriptions wait until the job writing them is no longer running (done, failed or cancelled), the
// reader leaves the gallery (for another, or by closing), or — with neither — until the gallery has
// been left alone a while. A job's progress settles nothing, nor does a save that changes nothing.
// A gallery's folder in staging goes once nothing is staged in it, and a page staged just as it goes
// is still stored; folders in staging left empty when the app closed go at its next start.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { startServer } = await import('../server/server.js');
const { wire } = await import('../server/shared.js');

const pngBytes = (...bytes) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...bytes]);
const png = (...bytes) => new Blob([pngBytes(...bytes)], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, what) {
  for (const end = Date.now() + 3000; !await Promise.resolve().then(fn).catch(() => false);) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await sleep(20);
  }
}

// A library (its pages never settled on their own while a test runs, unless asked) and its server.
async function open(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-settle-'));
  const where = { dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library') };
  const library = await new Library({ ...where, placeDelay: 60_000, describeDelay: 600_000, ...opts }).open();
  const server = await startServer({ library, token: 'window-token-0123456789abcdef', origins: [],
    clients: { tokenFor: () => null, siteOf: () => null, approve: async () => null } });
  t.after(async () => {
    await until(() => !library.files._placing.size && !library.files._describing.size
      && !library._s(`SELECT 1 FROM files WHERE pending = 1 AND format = 'folder'`).get(), 'nothing left to write');
    await server.close(); library.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  return { library, server };
}
// A page the server served, connected to the library.
async function page(server) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?s=a-browser`, { origin: `http://127.0.0.1:${server.port}` });
  ws.replies = new Map();
  ws.on('message', (data) => { const msg = wire.decode(data); if (!msg.push) ws.replies.get(msg.id)?.(msg); });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return ws;
}
let seq = 0;
async function call(ws, op, ...args) {
  const id = ++seq;
  const reply = new Promise((resolve) => ws.replies.set(id, resolve));
  ws.send(await wire.encode({ id, op, args }));
  const msg = await reply;
  assert.equal(msg.ok, true, msg.error?.message);
  return msg.result;
}

const folderOf = (library, gid) => library.files.folderOf(gid);
const described = (library, gid, name = 'metadata.json') => !!folderOf(library, gid) && fs.existsSync(path.join(folderOf(library, gid), name));
const metadata = (library, gid) => JSON.parse(fs.readFileSync(path.join(folderOf(library, gid), 'metadata.json'), 'utf8'));
const stagingOf = (library, gid) => path.join(library.stagingDir, gid);
async function arrived(library, gid, name, pages = [1, 2]) {
  await library.metaPut({ galleryId: gid, title: title(name), tags: [], numPages: pages.length });
  for (const n of pages) await library.pagePut(gid, n, png(n));
}

test('a job writing a gallery\'s pages settles it when it is no longer running, not while it runs', async (t) => {
  const { library, server } = await open(t);
  const runner = await page(server);
  t.after(() => runner.close());
  const gid = '1790500000001';
  await arrived(library, gid, 'Downloaded');
  await call(runner, 'relay', 'jobs', { gid, kind: 'download', status: 'progress', done: 2, total: 2 });
  await sleep(150);
  assert.equal(folderOf(library, gid), null, 'still staged while the job runs');
  await call(runner, 'relay', 'jobs', { gid, kind: 'download', status: 'done', done: 2, total: 2 });
  await until(() => described(library, gid) && described(library, gid, 'image_records.json'), 'settled when it ended');
  assert.deepEqual(fs.readdirSync(path.join(folderOf(library, gid), 'images')), ['0001.png', '0002.png']);
  await until(() => !fs.existsSync(stagingOf(library, gid)), 'its folder in staging gone');

  for (const [i, status] of ['error', 'cancelled'].entries()) {
    const other = `179050000001${i}`;
    await arrived(library, other, `Stopped ${i}`);
    await call(runner, 'relay', 'jobs', { gid: other, kind: 'translate', status });
    await until(() => described(library, other), `settled when it ${status === 'error' ? 'failed' : 'was cancelled'}`);
  }
});

test('the reader leaving a gallery — for another, or by closing — settles it', async (t) => {
  const { library, server } = await open(t);
  const reader = await page(server);
  const [a, b] = ['1790500000021', '1790500000022'];
  await call(reader, 'reading', a);
  await arrived(library, a, 'First');
  await sleep(100);
  assert.equal(folderOf(library, a), null, 'nothing written while it is read');
  await call(reader, 'reading', b);
  await until(() => described(library, a), 'settled when the reader went on to another');
  await arrived(library, b, 'Second');
  reader.close();
  await until(() => described(library, b), 'settled when the reader closed');
});

test('pages that arrive with no job and no reader are described once the gallery is left alone a while', async (t) => {
  const { library } = await open(t, { placeDelay: 20, describeDelay: 400 });
  const gid = '1790500000031';
  await arrived(library, gid, 'Quiet');
  await until(() => folderOf(library, gid) && fs.existsSync(path.join(folderOf(library, gid), 'images', '0002.png')), 'pages moved in');
  assert.equal(described(library, gid), false, 'not described yet');
  await until(() => described(library, gid), 'described after a quiet while');
});

test('an edit made by hand is written at once: metadata and tags, a cover, a series', async (t) => {
  const { library } = await open(t);
  const [gid, other] = ['1790500000041', '1790500000042'];
  await arrived(library, gid, 'Edited');
  await arrived(library, other, 'Joined');
  await library.files.flush();
  await library.mutateGallery(gid, { tags: [{ type: 'tag', name: 'added' }] });
  await until(() => metadata(library, gid).tags?.some(tag => tag.name === 'added'), 'its tags');
  await library.coverPut(gid, png(9, 9));
  await until(() => described(library, gid, 'covers/manifest.json'), 'its cover');
  await library.seriesCommand('write', gid, [{ id: gid, title: 'Edited', number: 1 }, { id: other, title: 'Joined', number: 2 }],
    { seriesTitle: title('Made') });
  await until(() => fs.existsSync(path.join(library.libraryDir, 'Made', 'series.json')), 'its series, in the series\' folder');
  assert.equal(path.basename(path.dirname(folderOf(library, other))), 'Made');
});

test('a save that changes nothing writes nothing', async (t) => {
  const { library } = await open(t);
  const gid = '1790500000045';
  await arrived(library, gid, 'Unchanged');
  await library.files.flush();
  const file = path.join(folderOf(library, gid), 'metadata.json');
  const before = fs.statSync(file, { bigint: true }).mtimeNs;
  const meta = await library.metaGet(gid);
  await library.metaPut(meta);
  await library.mutateGallery(gid, { title: meta.title, tags: meta.tags });
  await sleep(150);
  assert.equal(library._s('SELECT pending FROM files WHERE gid = ?').get(gid).pending, 0, 'not out of date');
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, before, 'metadata.json untouched');
  await library.mutateGallery(gid, { tags: [{ type: 'tag', name: 'changed' }] });
  await until(() => fs.statSync(file, { bigint: true }).mtimeNs !== before, 'a real change is written');
});

test('a gallery\'s folder in staging goes once nothing is staged in it', async (t) => {
  const { library } = await open(t);
  const gid = '1790500000051';
  await arrived(library, gid, 'Staged');
  const staging = stagingOf(library, gid);
  assert.equal(fs.readdirSync(staging).length, 2);
  await library.files.settle(gid);
  assert.equal(fs.existsSync(staging), false);

  library._dirs.add(staging);   // as if a page were being staged just as its folder went
  await library.pagePut(gid, 3, png(3));
  assert.equal(fs.readdirSync(staging).length, 1, 'staged all the same');
});

test('folders in staging left empty when the app closed go at its next start; one with pages stays', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-settle-'));
  const where = { dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), placeDelay: 60_000, describeDelay: 600_000 };
  const first = await new Library(where).open();
  const gid = '1790500000061';
  await arrived(first, gid, 'Waiting', [1]);
  first.close();
  const empty = path.join(first.stagingDir, '1790500000099');
  fs.mkdirSync(empty);
  const library = await new Library(where).open();
  t.after(() => { library.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await until(() => !fs.existsSync(empty), 'the empty folder gone');
  assert.equal(fs.readdirSync(stagingOf(library, gid)).length, 1, 'the one with a page waiting stays');
});

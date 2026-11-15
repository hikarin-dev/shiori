// fsa-node.test.mjs — the File System Access shim the website's storage is tested with under Node
// (fsa-node.mjs) behaves as Chrome does where the library relies on it: a file written is the old one
// whole until close() puts the new one in its place, and stays so when the write is aborted or fails;
// errors are named as Chrome names them; a link is followed, or hidden as a browser may show one
// (hideLinks); a handle comes back from IndexedDB as a handle; and its hooks fail the calls asked for,
// and answer permission queries as told.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fsa from './fsa-node.mjs';

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-fsa-'));
  t.after(() => { fsa.reset(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, root: fsa.directory(dir) };
}
const errName = (p) => p.then(() => 'resolved', (e) => e?.name);

test('a file written is replaced whole on close, and left as it was by abort or a failed write', async (t) => {
  const { dir, root } = folder(t);
  const file = await root.getFileHandle('a.json', { create: true });
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), '', 'made empty at once');
  let w = await file.createWritable();
  await w.write('old');
  await w.close();
  w = await file.createWritable();
  await w.write('new text');
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'old', 'the old file whole until close');
  assert.ok(fs.existsSync(path.join(dir, 'a.json.crswap')), 'written beside it');
  await w.abort();
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'old');
  assert.ok(!fs.existsSync(path.join(dir, 'a.json.crswap')));
  fsa.failNext((c) => c.op === 'close' && c.path === 'a.json', 'QuotaExceededError');
  w = await file.createWritable();
  await w.write(new Blob(['newer']));
  assert.equal(await errName(w.close()), 'QuotaExceededError');
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'old', 'a close that failed changed nothing');
  w = await file.createWritable({ keepExistingData: true });
  await w.write({ type: 'write', position: 3, data: new Uint8Array([33]) });
  await w.close();
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'old!');
  const read = await file.getFile();
  assert.equal(await read.text(), 'old!');
  assert.equal(read.type, 'application/json');
  assert.equal(read.lastModified, Math.floor(fs.statSync(path.join(dir, 'a.json')).mtimeMs));
});

test('errors are named as Chrome names them', async (t) => {
  const { dir, root } = folder(t);
  const sub = await root.getDirectoryHandle('sub', { create: true });
  await (await sub.getFileHandle('f.png', { create: true })).createWritable().then(w => w.close());
  assert.equal(await errName(root.getFileHandle('nothing')), 'NotFoundError');
  assert.equal(await errName(root.getFileHandle('sub')), 'TypeMismatchError');
  assert.equal(await errName(sub.getDirectoryHandle('f.png')), 'TypeMismatchError');
  assert.equal(await errName(root.removeEntry('sub')), 'InvalidModificationError', 'not empty, not recursive');
  assert.equal(await errName(root.removeEntry('nothing')), 'NotFoundError');
  await assert.rejects(root.getFileHandle('a/b', { create: true }), TypeError);
  await assert.rejects(root.getDirectoryHandle('..'), TypeError);
  fs.rmSync(path.join(dir, 'sub'), { recursive: true });
  assert.equal(await errName(sub.getFileHandle('f.png')), 'NotFoundError', 'a folder taken away');
  assert.equal(await errName(sub.keys().next()), 'NotFoundError');
  await root.getDirectoryHandle('sub', { create: true });
  await root.removeEntry('sub');
  assert.ok(!fs.existsSync(path.join(dir, 'sub')), 'an empty folder goes without recursive');
});

test('a folder lists what it holds, follows links, and tells what is inside it', async (t) => {
  const { dir, root } = folder(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-fsa-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'x.png'), 'x');
  fs.symlinkSync(outside, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const listed = [];
  for await (const [name, h] of root.entries()) listed.push(`${name}:${h.kind}`);
  assert.deepEqual(listed.sort(), ['b.txt:file', 'linked:directory']);
  const linked = await root.getDirectoryHandle('linked');
  assert.deepEqual([...(await (async () => { const n = []; for await (const k of linked.keys()) n.push(k); return n; })())], ['x.png']);
  assert.deepEqual(await root.resolve(await linked.getFileHandle('x.png')), ['linked', 'x.png']);
  assert.equal(await linked.resolve(root), null);
  assert.ok(await root.isSameEntry(fsa.directory(dir)));
  // A browser that shows a link as nothing (hideLinks): left out of the listing, not found by its name —
  // made or removed — and the target untouched; followed again once it is off (and after reset).
  fsa.hideLinks();
  const hidden = [];
  for await (const [name] of root.entries()) hidden.push(name);
  assert.deepEqual(hidden, ['b.txt']);
  for (const call of [() => root.getDirectoryHandle('linked'), () => root.getDirectoryHandle('linked', { create: true }),
    () => root.getFileHandle('linked', { create: true }), () => root.removeEntry('linked', { recursive: true })]) {
    assert.equal(await errName(call()), 'NotFoundError');
  }
  assert.deepEqual(fs.readdirSync(outside), ['x.png']);
  fsa.reset();
  assert.equal((await root.getDirectoryHandle('linked')).kind, 'directory');
});

// S30 (S29a's "a 'not found' judged after the drive is back"): Chrome reads a folder's entries, with their
// kinds, whole before it hands any of them out. The stand-in looked at each entry as it handed it out, so
// a drive leaving meanwhile — a call of other work under way taking it away for a moment — cut the listing
// short with no error: a gallery's folder listed without its .shiori read by an earlier version's rules,
// with no pages. A listing is whole, or fails.
test('a folder\'s listing is read whole before any entry is handed out: a drive leaving as they are takes none away', async (t) => {
  const { dir } = folder(t);
  const at = path.join(dir, 'drive');
  for (const name of ['.shiori', 'images']) fs.mkdirSync(path.join(at, 'Alpha', name), { recursive: true });
  for (const name of ['a.json', 'b.json', 'c.json']) fs.writeFileSync(path.join(at, 'Alpha', name), '{}');
  const gallery = await fsa.directory(at).getDirectoryHandle('Alpha');
  const listed = [];
  for await (const [name, h] of gallery.entries()) {
    if (!listed.length) fs.renameSync(at, `${at}.away`);   // the drive away as the first entry is handed out
    listed.push(`${name}:${h.kind}`);
  }
  fs.renameSync(`${at}.away`, at);   // and back
  assert.deepEqual(listed.sort(), ['.shiori:directory', 'a.json:file', 'b.json:file', 'c.json:file', 'images:directory']);
});

test('the hooks fail the calls asked for, and answer permission as told', async (t) => {
  const { dir, root } = folder(t);
  const heard = [];
  fsa.onCall((c) => heard.push(`${c.op} ${c.path}`));
  fsa.failNext((c) => c.op === 'getFileHandle' && c.path === 'a', 'NotReadableError', { times: 2 });
  assert.equal(await errName(root.getFileHandle('a', { create: true })), 'NotReadableError');
  assert.equal(await errName(root.getFileHandle('a', { create: true })), 'NotReadableError');
  assert.equal(await errName(root.getFileHandle('a', { create: true })), 'resolved', 'used up');
  assert.deepEqual(heard, ['getFileHandle a', 'getFileHandle a', 'getFileHandle a']);
  fsa.setPermission(dir, 'prompt', { onRequest: () => 'granted' });
  assert.equal(await root.queryPermission({ mode: 'readwrite' }), 'prompt');
  assert.equal(await errName(root.getFileHandle('a')), 'NotAllowedError');
  assert.equal(await root.requestPermission({ mode: 'readwrite' }), 'granted');
  assert.equal(await errName(root.getFileHandle('a')), 'resolved');
});

test('a handle kept in IndexedDB comes back as a handle to the same place', async (t) => {
  const { dir, root } = folder(t);
  fsa.install();
  await import('fake-indexeddb/auto');
  const db = await new Promise((resolve) => {
    const open = indexedDB.open(`fsa-${Date.now()}`, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('folders', { keyPath: 'id' });
    open.onsuccess = () => resolve(open.result);
  });
  await new Promise((resolve) => { const tx = db.transaction('folders', 'readwrite'); tx.objectStore('folders').put({ id: 'a', handle: root }); tx.oncomplete = resolve; });
  const back = await new Promise((resolve) => { const q = db.transaction('folders').objectStore('folders').get('a'); q.onsuccess = () => resolve(q.result); });
  db.close();
  assert.equal(back.handle.kind, 'directory');
  assert.equal(back.handle.name, path.basename(dir));
  assert.ok(await back.handle.isSameEntry(root));
  await back.handle.getFileHandle('made', { create: true });
  assert.ok(fs.existsSync(path.join(dir, 'made')));
});

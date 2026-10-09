// backup.test.mjs — full backups made and restored by the desktop app itself (server/backup.js): a
// library made into a backup file and restored into another comes back whole — every page's bytes,
// translations, study layers, masks, covers, metadata and series links; a picture missing on disk is
// reported and the rest still restores; a backup stopped part-way leaves nothing behind (and the file
// it would have replaced as it was); a restore stopped part-way carries on where it stopped; a gallery
// whose pages another gallery here has is refused, that one kept; a version 8 backup still restores;
// only portable settings come back. Checksums are the ones the app's own checks expect, and backups
// run one at a time, followed by their state.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { Library } = await import('../server/library.js');
const { exportArchive, openBackupFile, inspectBackup, restoreBackupFile, BackupJobs, hashOf, partialOf } = await import('../server/backup.js');
const { sha256, BackupError } = await import('../../app/js/backup-core.js');

const png = (...b) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...b])], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const hex = async (blob) => Buffer.from(await blob.arrayBuffer()).toString('hex');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-backup-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let opened = 0;
async function library(t, opts = {}) {
  const dir = path.join(root, `lib-${++opened}`);
  const lib = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library'), placeDelay: 0, ...opts }).open();
  t.after(async () => { await lib.files.flush().catch(() => {}); lib.close(); });
  return lib;
}
const fileIn = (name) => path.join(root, name);

let next = 1791000000000;
async function gallery(lib, name, pages = 2, { key } = {}) {
  const gid = String(next++);
  await lib.metaPut({ galleryId: gid, title: title(name), tags: [{ type: 'tag', name: 'kept' }], numPages: pages });
  for (let n = 1; n <= pages; n++) await lib.pagePut(gid, n, png(n, Number(gid.slice(-2))), key ? { key: key(n) } : {});
  return gid;
}

// A library with something of everything: plain pages, a translation with its masks, study layers,
// a cover of its own, a series, a gallery kept in an archive, one still staged, a source's icon.
async function everything(t) {
  const lib = await library(t, { placeDelay: 60_000 });
  const plain = await gallery(lib, 'Plain', 3);
  const studied = await gallery(lib, 'Studied', 2);
  await lib.putTranslatedPage({ galleryId: studied, pageNum: 1 }, png(9), { job: 'j1', lines: [], read: [], regions: [], masks: { raw: png(4), text: png(5) } }, 'j1');
  await lib.putPageStudy({ galleryId: studied, pageNum: 2 }, { bg: png(7), page: { w: 10, h: 10 },
    bubbles: [{ box: [0, 0, 1, 1], region: [0, 0, 1, 1], tr: 'Hi', src: 'やあ', text: png(8) }] });
  const owner = await gallery(lib, 'Owner', 1);
  const chapter = await gallery(lib, 'Chapter', 2);
  await lib.seriesCommand('attach', owner, chapter);
  await lib.coverPut(owner, png(6, 6), 'series');
  const archived = await gallery(lib, 'Archived', 2);
  await lib.files.flush();
  assert.deepEqual((await lib.archiveGallery(archived)).archived, [archived]);
  const staged = await gallery(lib, 'Staged', 2);   // settles only in a minute
  assert.equal(JSON.parse(lib._pageRow(staged, 1).orig).at, 's');
  await lib.sourceIconPut('somewhere', { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  return { lib, ids: { plain, studied, owner, chapter, archived, staged } };
}

// Everything a library holds, pictures as their bytes.
async function plainly(v) {
  if (v instanceof Blob) return `bytes:${await hex(v)}`;
  if (Array.isArray(v)) return Promise.all(v.map(plainly));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = await plainly(x);
    return out;
  }
  return v;
}
async function contents(lib) {
  const out = {};
  for (const gid of (await lib.transferIds()).sort()) {
    const { meta, stat, pages, cover } = await lib.transferRead(gid);
    out[gid] = { meta, count: stat?.count, parentId: stat?.parentId ?? null, pages: await plainly(pages),
      cover: await plainly({ cover: cover?.cover ?? null, seriesCover: cover?.seriesCover ?? null }) };
  }
  out.icons = await lib.sourceIconsAll();
  return out;
}

async function restoreFile(lib, file, opts = {}) {
  const archive = await openBackupFile(file);
  const inspection = await inspectBackup(lib, archive);
  return { archive, inspection, result: await restoreBackupFile(lib, archive, inspection, opts) };
}

test('a checksum is the one the app\'s own checks take', async () => {
  for (const size of [0, 1, 31, 32, 33, 1000, 65537]) {
    const bytes = crypto.randomBytes(size);
    assert.equal(hashOf(bytes), await sha256(bytes), `${size} bytes`);
    assert.match(hashOf(bytes), /^[A-Za-z0-9+/]{43}$/);
  }
});

test('a backup made here restores whole into another library', async (t) => {
  const { lib, ids } = await everything(t);
  const file = fileIn('whole.shioridb');
  const progress = [];
  const made = await exportArchive(lib, file, { onProgress: (p) => progress.push(p),
    settings: { kv: { readerView: '"study"', libraryLocation: '{"kind":"desktop"}', relayScope: '"s"',
      translateSettings: JSON.stringify({ schema: 3, params: { a: 1 }, serverUrl: 'http://127.0.0.1:5003', serverToken: 't' }) },
    dash: { 'shiori-lang': 'ja', 'shiori-other': '1' } } });
  assert.equal(made.path, path.resolve(file));
  assert.equal(made.bytes, fs.statSync(file).size);
  assert.deepEqual(made.missing, []);
  assert.equal(made.counts.galleries, 6);
  assert.equal(made.counts.images, 3 + 2 + 1 + 2 + 2 + 2);
  assert.ok(!fs.existsSync(partialOf(file)), 'no partial file left');
  assert.deepEqual(progress[0], { done: 0, total: 6, bytes: 0, totalBytes: progress[0].totalBytes });
  assert.equal(progress.at(-1).done, 6);
  assert.ok((await lib.diskWrites()).by.exports >= made.bytes, 'counted with the library\'s writes');

  const other = await library(t);
  const { inspection, result } = await restoreFile(other, file);
  assert.equal(inspection.ok, 6);
  assert.equal(inspection.bad, 0);
  assert.equal(inspection.hashed, true);
  assert.equal(inspection.version, 9);
  assert.deepEqual(inspection.done, []);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.written.sort(), Object.values(ids).sort());
  assert.equal(result.cancelled, false);
  assert.deepEqual(result.settings, { kv: { readerView: '"study"', translateSettings: JSON.stringify({ schema: 3, params: { a: 1 } }) },
    dash: { 'shiori-lang': 'ja' } }, 'only the settings that travel');
  await other.files.flush();
  assert.deepEqual(await contents(other), await contents(lib));
  assert.equal((await other.metaGet(ids.chapter)).parentId, ids.owner, 'the series together');
  assert.ok(!fs.existsSync(path.join(other.dataDir, 'restore-journal.json')), 'a restore that completed keeps no journal');
});

test('a picture missing on disk is reported, and the rest restores', async (t) => {
  const lib = await library(t);
  const gid = await gallery(lib, 'Torn', 3);
  const kept = await gallery(lib, 'Kept', 1);
  await lib.files.flush();
  const orig = JSON.parse(lib._pageRow(gid, 2).orig);
  fs.rmSync(path.join(lib.files.folderOf(gid), ...orig.entry.split('/')));

  const file = fileIn('torn.shioridb');
  const made = await exportArchive(lib, file);
  assert.deepEqual(made.missing, [{ gid, what: { n: 2, part: 'page' } }]);
  const other = await library(t);
  const { inspection, result } = await restoreFile(other, file);
  assert.equal(inspection.ok, 2);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.written.sort(), [gid, kept].sort());
  assert.deepEqual((await other.pageList(gid)).map(p => p.pageNum), [1, 3]);
  assert.equal(await hex((await other.pageGet(gid, 3)).blob), await hex((await lib.pageGet(gid, 3)).blob));
});

test('a gallery changed while the backup is made is saved as it now is, its pictures not written twice', async (t) => {
  const lib = await library(t);
  const big = (n) => png(n, ...new Array(20000).fill(n));
  const ids = [String(next++), String(next++)];
  for (const gid of ids) {
    await lib.metaPut({ galleryId: gid, title: title(`Book ${gid}`), tags: [], numPages: 2 });
    for (const n of [1, 2]) await lib.pagePut(gid, n, big(n));
  }
  await lib.files.flush();
  const plainBytes = (await exportArchive(lib, fileIn('unchanged.shioridb'))).bytes;
  const made = await exportArchive(lib, fileIn('changed.shioridb'), { onProgress: ({ done }) => {
    if (done === 1) lib.metaPut({ galleryId: ids[0], title: title('Renamed meanwhile'), tags: [], numPages: 2 });
  } });
  assert.deepEqual(made.changed, [], 'read again, it is saved as it now is');
  assert.ok(made.bytes - plainBytes < 20000, `only its details again (${made.bytes - plainBytes} bytes more)`);
  const other = await library(t);
  const { result } = await restoreFile(other, fileIn('changed.shioridb'));
  assert.deepEqual(result.problems, []);
  assert.equal((await other.metaGet(ids[0])).title.english, 'Renamed meanwhile');
  assert.equal(await hex((await other.pageGet(ids[0], 2)).blob), await hex(big(2)));
});

test('a backup stopped part-way leaves nothing behind, and the file it would replace as it was', async (t) => {
  const lib = await library(t);
  for (const name of ['A', 'B', 'C']) await gallery(lib, name, 2);
  const file = fileIn('stopped.shioridb');
  fs.writeFileSync(file, 'an older backup');
  const stop = new AbortController();
  await assert.rejects(exportArchive(lib, file, { signal: stop.signal, onProgress: ({ done }) => { if (done === 1) stop.abort(); } }),
    (e) => e instanceof BackupError && e.code === 'cancelled');
  assert.equal(fs.readFileSync(file, 'utf8'), 'an older backup');
  assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('stopped')), ['stopped.shioridb'], 'no partial file');
});

test('a restore stopped part-way carries on where it stopped', async (t) => {
  const lib = await library(t);
  const ids = [];
  for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) ids.push(await gallery(lib, name, 2));
  const file = fileIn('resume.shioridb');
  await exportArchive(lib, file);

  const other = await library(t);
  const writes = [];
  const write = other.transferWrite.bind(other);
  other.transferWrite = (bundle, opts) => { writes.push(bundle.galleryId); return write(bundle, opts); };
  const stop = new AbortController();
  const first = await restoreFile(other, file, { signal: stop.signal, onProgress: ({ done }) => { if (done === 2) stop.abort(); } });
  assert.equal(first.result.cancelled, true);
  assert.equal(first.result.written.length, 2);
  assert.equal(first.result.settings, null, 'no settings over a library that didn\'t arrive');
  assert.ok(fs.existsSync(path.join(other.dataDir, 'restore-journal.json')));

  writes.length = 0;
  const archive = await openBackupFile(file);
  const inspection = await inspectBackup(other, archive);
  assert.deepEqual(inspection.done.sort(), first.result.written.sort(), 'what was restored is offered to be skipped');
  const second = await restoreBackupFile(other, archive, inspection, { resume: true });
  assert.equal(second.skipped, 2);
  assert.deepEqual(writes.sort(), ids.filter(gid => !first.result.written.includes(gid)).sort(), 'only the rest written');
  assert.deepEqual(second.counts, { galleries: 5, images: 10 });
  assert.ok(!fs.existsSync(path.join(other.dataDir, 'restore-journal.json')), 'done: no journal left');
  for (const gid of ids) assert.equal((await other.transferRead(gid, { pages: false })).stat.count, 2, gid);
});

test('a gallery whose pages another gallery here has is refused, and that one kept', async (t) => {
  const lib = await library(t);
  const theirs = await gallery(lib, 'Theirs', 1, { key: (n) => `shared/${n}.png` });
  const fine = await gallery(lib, 'Fine', 1);
  const file = fileIn('conflict.shioridb');
  await exportArchive(lib, file);

  const other = await library(t);
  const mine = await gallery(other, 'Mine', 1, { key: (n) => `shared/${n}.png` });
  const before = await hex((await other.pageGet(mine, 1)).blob);
  const { result } = await restoreFile(other, file);
  assert.deepEqual(result.written, [fine]);
  assert.deepEqual(result.problems.map(p => [p.gid, p.reason]), [[theirs, 'conflict']]);
  assert.equal(await hex((await other.pageGet(mine, 1)).blob), before, 'its owner\'s page untouched');
  assert.equal((await other.transferRead(theirs, { pages: false })).meta, null, 'nothing of it written');
});

test('a version 8 backup still restores here, with only the settings that travel', async (t) => {
  const page = new Uint8Array(await png(1, 2, 3).arrayBuffer());
  const gid = '1791000099999';
  const manifest = new TextEncoder().encode(JSON.stringify({
    format: 'shiori-db', version: 8, exportedAt: 1, counts: { images: 1, galleries: 1, covers: 0 },
    images: [{ url: `${gid}/1.png`, galleryId: gid, cachedAt: 1, size: page.length, body: { off: 0, len: page.length, type: 'image/png' } }],
    metadata: [{ galleryId: gid, title: title('Old one'), tags: [] }],
    galleries: [{ galleryId: gid, count: 1, size: page.length, latestAt: 1, addedAt: 1, coverPage: 1 }],
    covers: [], sourceIcons: [],
    settings: { kv: { libraryLocation: '{"kind":"desktop","token":"t"}', relayScope: '"s"', readerMode: '"strip"',
      translateSettings: JSON.stringify({ schema: 3, serverUrl: 'http://evil', serverToken: 'x' }) }, dash: { 'shiori-safe-mode': '1' } },
  }));
  const footer = Buffer.alloc(4);
  footer.writeUInt32LE(manifest.length);
  const file = fileIn('old.shioridb');
  fs.writeFileSync(file, Buffer.concat([page, manifest, footer]));

  const other = await library(t);
  const { inspection, result } = await restoreFile(other, file);
  assert.equal(inspection.version, 8);
  assert.equal(inspection.hashed, false);
  assert.deepEqual(result.written, [gid]);
  assert.deepEqual(result.settings, { kv: { readerMode: '"strip"', translateSettings: JSON.stringify({ schema: 3 }) }, dash: { 'shiori-safe-mode': '1' } });
  assert.deepEqual([...new Uint8Array(await (await other.pageGet(gid, 1)).blob.arrayBuffer())], [...page]);
  assert.equal((await other.metaGet(gid)).title.english, 'Old one');
});

test('backups run one at a time, followed by their state', async (t) => {
  const lib = await library(t);
  for (const name of ['P', 'Q']) await gallery(lib, name, 2);
  const partials = [];
  const jobs = new BackupJobs(lib, { onPartial: (p) => partials.push(p) });
  const settled = async (id) => { while (['preparing', 'exporting', 'inspecting', 'restoring'].includes(jobs.state(id).phase)) await new Promise(r => setTimeout(r, 5)); return jobs.state(id); };
  const file = fileIn('jobs.shioridb');

  const made = jobs.export(file, { owner: 'page' });
  assert.equal(made.ok, true);
  assert.equal(jobs.running()?.owner, 'page');
  assert.deepEqual(jobs.open(file), { ok: false, code: 'busy' });
  assert.deepEqual(jobs.close(made.id), { ok: false, code: 'busy' });
  const done = await settled(made.id);
  assert.equal(done.phase, 'done');
  assert.equal(done.kind, 'export');
  assert.deepEqual([done.done, done.total], [2, 2]);
  assert.equal(done.result.path, path.resolve(file));
  assert.deepEqual(partials, [partialOf(path.resolve(file)), null]);
  assert.equal(jobs.running(), null);

  const other = await library(t);
  const restoring = new BackupJobs(other);
  const { id } = restoring.open(file);
  const inspected = await (async () => { while (restoring.state(id).phase === 'inspecting') await new Promise(r => setTimeout(r, 5)); return restoring.state(id); })();
  assert.equal(inspected.phase, 'inspected');
  assert.equal(inspected.inspection.ok, 2);
  assert.deepEqual(inspected.inspection.galleries.map(g => g.missing), [0, 0]);
  assert.deepEqual(restoring.restore('nope'), { ok: false, code: 'not-found' });
  assert.deepEqual(restoring.restore(id, { resume: true }), { ok: true });
  const restored = await (async () => { while (restoring.state(id).phase === 'restoring') await new Promise(r => setTimeout(r, 5)); return restoring.state(id); })();
  assert.equal(restored.phase, 'done');
  assert.equal(restored.result.written.length, 2);
  assert.deepEqual(restored.result.settings, { kv: {}, dash: {} });
  assert.deepEqual(restoring.restore(id), { ok: false, code: 'invalid' }, 'restored once');
  assert.deepEqual(restoring.close(id), { ok: true });
  assert.equal(restoring.state(id), null);

  const missing = jobs.open(fileIn('not-there.shioridb'));
  const failed = await settled(missing.id);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.error.code, 'unreadable');

  const stopped = jobs.export(fileIn('jobs-stopped.shioridb'));
  await jobs.stop();
  assert.equal(jobs.state(stopped.id).phase, 'cancelled');
  assert.ok(!fs.existsSync(fileIn('jobs-stopped.shioridb')) && !fs.existsSync(partialOf(fileIn('jobs-stopped.shioridb'))));
});

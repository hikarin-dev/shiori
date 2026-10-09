// backup-core.test.mjs — a full backup can be trusted: it is checked whole before anything is
// written (its layout, its records, its counts, its page keys), every picture is the one that was
// saved, a gallery is restored whole or not at all, a damaged or conflicting gallery is left out and
// said so while the rest is restored, a restore that stops says exactly what it wrote and the same
// file carries on from there, and a gallery that changes while a backup is made is saved as it now
// is. Older backups still restore. A file is told by its content, not its name.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const _ls = new Map();
globalThis.localStorage = { getItem: (k) => (_ls.has(k) ? _ls.get(k) : null), setItem: (k, v) => _ls.set(k, String(v)), removeItem: (k) => _ls.delete(k) };

const api = await import('../js/api.js');
const { exportFull, exportMetadata, importBackup, openBackup, restoreBackup, probeBackup } = await import('../js/backup.js');
const core = await import('../js/backup-core.js');

const PNG = (...b) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...b]);
const png = (...b) => new Blob([PNG(...b)], { type: 'image/png' });
const title = (english) => ({ english, japanese: '', pretty: '' });
const bytes = async (blob) => [...new Uint8Array(await blob.arrayBuffer())];
let nextId = 1790200000000;

// A gallery of `n` pages, the second one translated.
async function gallery(name, n = 2) {
  const gid = String(nextId++);
  await api.meta.put({ galleryId: gid, title: title(name), tags: [], numPages: n });
  for (let i = 1; i <= n; i++) await api.pages.put(gid, i, png(i, gid.length % 7));
  if (n > 1) await api.derived.putTranslation(gid, 2, { image: png(9, 9, 9), pipeline: { job: 'j' }, own: 'j' });
  return gid;
}
const fresh = async () => { await api.maintenance.clearAll(); _ls.clear(); };
// Page `n`'s stored picture lost behind the library's back: its file (the desktop library) or its
// stored image (this browser's).
async function losePicture(gid, n) {
  const desktop = globalThis.__desktopLibrary;
  if (desktop) {
    const [fs, path] = [await import('node:fs'), await import('node:path')];
    await desktop.files.flush();
    const orig = JSON.parse(desktop._pageRow(gid, n).orig);
    fs.rmSync(orig.at === 's' ? path.join(desktop.stagingDir, orig.file) : path.join(desktop.files.folderOf(gid), ...orig.entry.split('/')));
    return;
  }
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('shiori-cache');
    open.onsuccess = () => {
      const tx = open.result.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').delete(`local://${gid}/${n}.png|page`);
      tx.oncomplete = () => { open.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}
const asFile = (blob, name = 'backup.shioridb') => new File([blob], name);
async function archiveBytes() { const { archive } = await exportFull(); return new Uint8Array(await archive.arrayBuffer()); }
function indexOf(buf) {
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(buf.length - 4, true);
  return { index: JSON.parse(new TextDecoder().decode(buf.subarray(buf.length - 4 - len, buf.length - 4))), start: buf.length - 4 - len };
}
// A version 8 (or older) archive: `region` then the manifest.
function legacy(manifest, region = new Uint8Array(0)) {
  const body = new TextEncoder().encode(JSON.stringify(manifest));
  const footer = new Uint8Array(4);
  new DataView(footer.buffer).setUint32(0, body.length, true);
  return new File([region, body, footer], 'old.shioridb');
}
const v8 = (extra) => ({ format: 'shiori-db', version: 8, counts: {}, images: [], covers: [], sourceIcons: [], metadata: [], galleries: [], ...extra });

test('a backup is one file an app that knows only the old layout reads, and refuses as newer', async () => {
  await fresh();
  const a = await gallery('A');
  const buf = await archiveBytes();
  const { index } = indexOf(buf);
  assert.equal(index.format, 'shiori-db');
  assert.equal(index.version, 9);
  assert.ok(Number(index.version) > 8, 'version 8 code refuses it as made by a newer app');
  assert.match(index.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(index.counts, { galleries: 1, images: 2, sourceIcons: 0, bytes: index.galleries[0].bytes });
  assert.equal(index.galleries[0].id, a);
  assert.equal(await probeBackup(asFile(new Blob([buf]), 'Unconfirmed 123.crdownload')), 'full', 'told by its content');
});

test('a changed byte fails only the gallery it belongs to', async () => {
  await fresh();
  const a = await gallery('A'), b = await gallery('B');
  const buf = await archiveBytes();
  buf[2] ^= 0xff;   // inside A's first picture (A's section comes first)
  await fresh();
  const result = await importBackup(asFile(new Blob([buf])));
  assert.deepEqual(result.written, [b]);
  assert.deepEqual(result.problems.map(p => [p.gid, p.reason]), [[a, 'checksum']]);
  assert.equal(await api.meta.get(a), null, 'nothing of the damaged gallery is written');
});

test("a damaged gallery's details fail only that gallery", async () => {
  await fresh();
  const a = await gallery('A'), b = await gallery('B');
  const buf = await archiveBytes();
  const g = indexOf(buf).index.galleries.find(x => x.id === b);
  buf[g.off + 5] ^= 0x01;
  await fresh();
  const result = await importBackup(asFile(new Blob([buf])));
  assert.deepEqual(result.written, [a]);
  assert.deepEqual(result.problems.map(p => [p.gid, p.reason]), [[b, 'checksum']]);
});

test('a backup cut short is told as incomplete; a file that is no backup is told so', async () => {
  await fresh();
  await gallery('A');
  const buf = await archiveBytes();
  await assert.rejects(openBackup(asFile(new Blob([buf.subarray(0, buf.length - 10)]))), { code: 'truncated' });
  await assert.rejects(openBackup(asFile(png(1, 2, 3, 4, 5), 'x.png')), (e) => ['not-backup', 'truncated'].includes(e.code));
  await assert.rejects(openBackup(asFile(new Blob(['hello world, not a backup at all']), 'x.txt')), { code: 'not-backup' });
  assert.equal(await probeBackup(asFile(png(1, 2, 3), 'x.png')), null);
});

test('counts, versions and ids that are not what the records say are refused before any write', async () => {
  await fresh();
  await assert.rejects(importBackup(legacy(v8({ counts: { images: 99, galleries: 99 } }))), { code: 'corrupt' });
  for (const version of [undefined, -1, 1.5, 'garbage']) {
    await assert.rejects(importBackup(legacy(v8({ version }))), { code: 'corrupt' }, `version ${version}`);
  }
  await assert.rejects(importBackup(legacy(v8({ version: 10 }))), { code: 'newer' });
  await assert.rejects(importBackup(legacy(v8({ metadata: [{ galleryId: '1' }, { galleryId: '1' }] }))), { code: 'corrupt' }, 'a gallery twice');
  await assert.rejects(importBackup(legacy(v8({ metadata: [{ galleryId: '1' }], images: [null] }))), { code: 'corrupt' });
  await assert.rejects(importBackup(legacy(v8({ metadata: [{ galleryId: '1', parentId: '<x>' }] }))), { code: 'unsafe' });
  // A tampered version 9 index.
  await gallery('A');
  const buf = await archiveBytes();
  const { index, start } = indexOf(buf);
  index.counts.images = 7;
  const text = new TextEncoder().encode(JSON.stringify(index));
  const footer = new Uint8Array(4); new DataView(footer.buffer).setUint32(0, text.length, true);
  await assert.rejects(openBackup(asFile(new Blob([buf.subarray(0, start), text, footer]))), { code: 'corrupt' });
  assert.deepEqual((await api.transfer.ids()).length, 1, 'only what was there before');
});

test('malformed galleries are listed and left out; the others restore', async () => {
  await fresh();
  const region = PNG(1, 1, 1);
  const page = (gid, n, extra = {}) => ({ url: `local://${gid}/${n}.png`, galleryId: gid, body: { off: 0, len: region.length, type: 'image/png' }, ...extra });
  const meta = (gid) => ({ galleryId: gid, title: title(gid) });
  const stat = (gid, count) => ({ galleryId: gid, count, size: 1, latestAt: 1, addedAt: 1, coverPage: 1 });
  const manifest = v8({
    images: [page('11', 1), page('12', 1, { bubbles: [null] }), page('13', 1, { pipeline: 'x' }),
      { url: 'local://14/cover.png', galleryId: '14', body: { off: 0, len: 3 } }, page('15', 1), page('15', 1),
      page('16', 1), { ...page('16', 2), url: 'local://11/1.png' }, { url: 'local://17/1.png', galleryId: '17', body: { off: 0, len: 999 } }],
    metadata: ['11', '12', '13', '14', '15', '16', '17'].map(meta),
    galleries: [stat('11', 1)],
  });
  manifest.counts = { images: manifest.images.length, galleries: 1 };
  const opened = await openBackup(legacy(manifest, region));
  const problems = Object.fromEntries(opened.inspection.galleries.filter(g => g.problem).map(g => [g.gid, g.problem.reason]));
  assert.deepEqual(problems, { 12: 'invalid', 13: 'invalid', 14: 'invalid', 15: 'invalid', 16: 'invalid', 17: 'invalid' });
  const result = await restoreBackup(opened);
  assert.deepEqual(result.written, ['11']);
  for (const gid of ['12', '13', '14', '15', '16', '17']) assert.equal(await api.meta.get(gid), null, gid);
});

test('a metadata backup with a broken entry writes nothing; an empty one restores nothing, without error', async () => {
  await fresh();
  const shi = (list) => new File([JSON.stringify(list)], 'm.shi', { type: 'application/json' });
  await assert.rejects(importBackup(shi([{ galleryId: '21', title: title('x') }, null])), { code: 'corrupt' });
  assert.equal(await api.meta.get('21'), null);
  const empty = await importBackup(shi([]));
  assert.equal(empty.written.length, 0);
});

test("a metadata restore that can't read a gallery stops, rather than resetting its totals", async () => {
  await fresh();
  const gid = await gallery('Read fails', 3);
  const read = api.transfer.read;
  api.transfer.read = async (id, opts) => { if (String(id) === gid) throw new Error('unreadable'); return read(id, opts); };
  try {
    await assert.rejects(importBackup(new File([JSON.stringify([{ galleryId: gid, title: title('new') }])], 'm.shi', { type: 'application/json' })));
  } finally { api.transfer.read = read; }
  assert.equal((await api.transfer.read(gid, { pages: false })).stat.count, 3);
});

test('a page another gallery holds is refused, and that gallery keeps it', async () => {
  await fresh();
  const owner = await gallery('Owner', 1);
  const buf = await archiveBytes();
  // Restore the backup as if it were a different gallery holding the same page key.
  const { index } = indexOf(buf);
  const g = index.galleries[0];
  const rec = JSON.parse(new TextDecoder().decode(buf.subarray(g.off, g.off + g.len)));
  const other = '1790299999999';
  rec.galleryId = other; rec.meta.galleryId = other; if (rec.stat) rec.stat.galleryId = other;
  const blob = await api.transfer.write({ galleryId: other, meta: rec.meta, stat: rec.stat,
    pages: [{ url: rec.pages[0].url, blob: png(5), galleryId: other }] }).then(() => 'written', (e) => e.code);
  assert.equal(blob, 'conflict');
  assert.equal(await api.meta.get(other), null, 'nothing of it written');
  assert.equal((await api.pages.list(owner)).length, 1);
});

test('a write the library refuses part-way leaves nothing of that gallery', async () => {
  await fresh();
  const gid = String(nextId++);
  await assert.rejects(api.transfer.write({ galleryId: gid, meta: { galleryId: gid, title: title('x') },
    pages: [{ url: `local://${gid}/1.png`, blob: png(1) }, { url: `local://${gid}/cover.png`, blob: png(2) }] }), { code: 'invalid' });
  await assert.rejects(api.transfer.write({ galleryId: gid, meta: { galleryId: gid, title: title('x') },
    pages: [{ url: `local://${gid}/1.png` }] }), { code: 'invalid' });
  assert.equal(await api.meta.get(gid), null);
});

test("pictures that can't be read when a backup is made are left out and reported, and the restore says so", async () => {
  await fresh();
  const gid = await gallery('Holes', 3);
  await losePicture(gid, 3);
  const made = await exportFull();
  assert.deepEqual(made.missing.map(m => [m.gid, m.what.n, m.what.part]), [[gid, 3, 'page']]);
  await fresh();
  const opened = await openBackup(asFile(made.archive));
  assert.equal(opened.inspection.missingPages, 1);
  const result = await restoreBackup(opened);
  assert.deepEqual(result.written, [gid]);
  assert.equal(result.missingPages, 1);
  const { stat } = await api.transfer.read(gid, { pages: false });
  assert.equal(stat.count, 2, 'its totals count the pages it has');
});

test('a gallery that already had more pages is counted truly after a restore', async () => {
  await fresh();
  const gid = await gallery('Grown', 1);
  const buf = await archiveBytes();
  await api.pages.put(gid, 2, png(2, 2));
  await importBackup(asFile(new Blob([buf])));
  assert.equal((await api.transfer.read(gid, { pages: false })).stat.count, 2, 'both pages are there, and counted');
});

test('a restore that runs out of space stops, says what it wrote, and the same file carries on', async () => {
  await fresh();
  const ids = [await gallery('1'), await gallery('2'), await gallery('3')];
  const buf = await archiveBytes();
  await fresh();
  const write = api.transfer.write;
  let n = 0;
  api.transfer.write = async (...a) => { if (++n === 2) { const e = new Error('full'); e.code = 'quota'; throw e; } return write(...a); };
  try {
    await assert.rejects(importBackup(asFile(new Blob([buf]))), (e) => e.code === 'quota' && e.written.length === 1);
  } finally { api.transfer.write = write; }
  const opened = await openBackup(asFile(new Blob([buf])));
  assert.deepEqual([...opened.done], [ids[0]], 'what was written is known');
  const written = [];
  const spy = api.transfer.write;
  api.transfer.write = async (b, o) => { written.push(b.galleryId); return spy(b, o); };
  let result;
  try { result = await restoreBackup(opened, { resume: true }); } finally { api.transfer.write = spy; }
  assert.deepEqual(written, ids.slice(1), 'only what was left is written');
  assert.equal(result.skipped, 1);
  assert.deepEqual((await api.transfer.ids()).sort(), [...ids].sort());
  assert.equal(localStorage.getItem('shiori:restoreJournal'), null, 'finished: nothing left to carry on');
});

test('a restore stopped between galleries reports exactly what it restored', async () => {
  await fresh();
  const ids = [await gallery('1'), await gallery('2'), await gallery('3')];
  const buf = await archiveBytes();
  await fresh();
  const stop = new AbortController();
  const opened = await openBackup(asFile(new Blob([buf])));
  const result = await restoreBackup(opened, { signal: stop.signal, onProgress: ({ done }) => { if (done === 1) stop.abort(); } });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.written, [ids[0]]);
  assert.deepEqual(await api.transfer.ids(), [ids[0]]);
  assert.deepEqual([...(await openBackup(asFile(new Blob([buf])))).done], [ids[0]]);
});

test('a gallery that changes while the backup is made is saved as it now is', async () => {
  await fresh();
  const a = await gallery('Before'), b = await gallery('Other');
  const read = api.transfer.read;
  let changed = false;
  api.transfer.read = async (gid, opts) => {
    if (String(gid) === b && !changed) { changed = true; await api.galleries.mutate(a, { title: title('After') }); }
    return read(gid, opts);
  };
  let made;
  try { made = await exportFull(); } finally { api.transfer.read = read; }
  assert.deepEqual(made.changed, [], 'read again, it no longer changed: nothing to warn about');
  const again = await exportFull();
  assert.ok(Math.abs(made.archive.size - again.archive.size) < 2048, 'its pictures, unchanged, were not written twice');
  await fresh();
  await importBackup(asFile(made.archive));
  assert.equal((await api.meta.get(a)).title.english, 'After');
});

test('an older backup (version 2 layout) still restores, its pages checked to be pictures', async () => {
  await fresh();
  const region = new Uint8Array([...PNG(1), ...PNG(2), 1, 2, 3]);
  const manifest = { format: 'shiori-db', version: 2, exportedAt: 1, counts: { images: 3, galleries: 1, covers: 0 },
    images: [
      { url: 'local://31/1.png', galleryId: '31', body: { off: 0, len: 9, type: 'image/png' } },
      { url: 'local://31/2.png', galleryId: '31', body: { off: 9, len: 9, type: 'image/png' } },
      { url: 'local://32/1.png', galleryId: '32', body: { off: 18, len: 3, type: 'image/png' } }],
    covers: [], metadata: [{ galleryId: '31', titleEnglish: 'Old flat title' }, { galleryId: '32', titleEnglish: 'Not a picture' }],
    galleries: [{ galleryId: '31', count: 2, size: 18, latestAt: 1, addedAt: 1, coverPage: 1 }] };
  const result = await importBackup(legacy(manifest, region));
  assert.deepEqual(result.written, ['31']);
  assert.deepEqual(result.problems.map(p => [p.gid, p.reason]), [['32', 'checksum']]);
  assert.deepEqual(await bytes((await api.pages.get('31', 2)).blob), [...PNG(2)]);
  assert.equal((await api.meta.get('31')).title.english, 'Old flat title', 'its title brought to the current shape');
});

test("a backup's source icons restore as icons, nothing more", async () => {
  await fresh();
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  await importBackup(legacy(v8({ sourceIcons: [
    { source: 'one', url: 'https://example.com/i.png', dataUrl, cachedAt: 5, galleryUrl: 'javascript:alert(1)' },
    { source: 'two', dataUrl: 'javascript:alert(1)' },
  ] })));
  assert.deepEqual(await api.icons.get('one'), { source: 'one', url: 'https://example.com/i.png', dataUrl, cachedAt: 5 });
  assert.equal(await api.icons.get('two') ?? null, null);
});

test('checking a backup reads it through and writes nothing', async () => {
  await fresh();
  await gallery('A'); await gallery('B');
  const buf = await archiveBytes();
  await fresh();
  const archive = await core.openArchive(asFile(new Blob([buf])));
  const inspection = await core.inspectArchive(archive);
  const good = await core.verifyArchive(archive, inspection);
  assert.deepEqual([good.checked, good.problems.length, good.hashed], [2, 0, true]);
  buf[3] ^= 0x10;
  const bad = await core.verifyArchive(await core.openArchive(asFile(new Blob([buf]))), inspection);
  assert.equal(bad.problems[0].reason, 'checksum');
  assert.deepEqual(await api.transfer.ids(), []);
});

test('a metadata export reads no pictures', async () => {
  await fresh();
  await gallery('A');
  const read = api.transfer.read;
  const asked = [];
  api.transfer.read = (gid, opts) => { asked.push(opts?.pages); return read(gid, opts); };
  try { await exportMetadata(); } finally { api.transfer.read = read; }
  assert.deepEqual(asked, [false]);
});

test('local dates name the files; checksums are SHA-256 in base64', async () => {
  assert.equal(core.localDate(new Date(2026, 9, 9, 0, 30)), '2026-10-09');
  assert.equal(await core.sha256(new TextEncoder().encode('abc')), 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0');
});

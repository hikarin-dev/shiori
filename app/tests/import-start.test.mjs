// import-start.test.mjs — what a page imports (import-files.js importBytes, jobs-runner.js
// startImport) reaches the library whichever keeps it: this browser's stages it in OPFS for the
// durable runner, which reads it back; a library kept as files imports it straight from memory.
// test:desktop runs this file against the desktop library, so each run covers one of the two ways.
// Pictures in more than one folder (a dropped folder or a zip) make a series: a chapter per folder
// holding pictures, named after it, the dropped folder or zip naming the series.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

// A stand-in OPFS: a written file reads back as a Blob of what was written.
const opfs = new Map();
Object.defineProperty(navigator, 'storage', { configurable: true, value: { getDirectory: async () => ({
  getFileHandle: async (name) => ({
    createWritable: async () => {
      const parts = [];
      return { write: async (data) => { parts.push(data); }, close: async () => { opfs.set(name, new Blob(parts)); } };
    },
    getFile: async () => opfs.get(name),
  }),
  removeEntry: async (name) => { opfs.delete(name); },
}) } });

const api = await import('../js/api.js');
const platform = await import('../js/platform.js');
const { startImport, runImport } = await import('../js/jobs-runner.js');
const { groupImports, importBytes, droppedImports } = await import('../js/import-files.js');
const { zipCreate } = await import('../js/zip.js');

// The durable runner a staged import is handed to (the service worker's job, here in this context).
platform.registerServices({ handle: (msg) => { if (msg.type === 'IMPORT_CBZ') runImport(msg); } });

// The import job's outcome, as the page hears it.
const outcome = (gid) => new Promise((resolve) => {
  const stop = platform.jobs.subscribe((job) => {
    if (job.gid === gid && (job.status === 'done' || job.status === 'error')) { stop(); resolve({ status: job.status, error: job.error }); }
  });
});

const title = (english) => ({ english, japanese: '', pretty: '' });
// A picture whose last byte says which it is.
const png = (n, name = `p ${n}.png`) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])], name);
const zip = (name, entries) => new File([zipCreate(entries.map(([path, n]) => ({ name: path, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]) })))], name);

// A fake drop of Files and folders ({ name, children }).
function fakeEntry(node) {
  if (node instanceof File) return { name: node.name, isDirectory: false, file: (ok) => ok(node) };
  return { name: node.name, isDirectory: true, createReader() {
    const rest = node.children.map(fakeEntry);
    return { readEntries: (ok) => setTimeout(() => ok(rest.splice(0, 2))) };
  } };
}
const drop = (...nodes) => droppedImports({ items: nodes.map((n) => ({ kind: 'file', webkitGetAsEntry: () => fakeEntry(n), getAsFile: () => (n instanceof File ? n : null) })) });

// Import one group into `gid`, as the library page does: its card reserved, then the import started.
async function importInto(gid, group, reserve = true) {
  if (reserve) await api.galleries.create(gid, { title: title(group.name.replace(/\.[^.]+$/, '')), isLocalImport: true });
  const done = outcome(gid);
  assert.equal(await startImport({ galleryId: gid, buffer: await importBytes(group), filename: group.name }), true);
  assert.deepEqual(await done, { status: 'done', error: undefined });
}
// A gallery's pages, as the pictures they are.
async function pictures(gid) {
  const out = [];
  for (const { pageNum } of await api.pages.list(gid)) out.push((await new Response(await api.pages.blob(gid, pageNum)).bytes()).at(-1));
  return out;
}
// A series as [series title, [chapter title, its pictures]…].
async function seriesOf(gid) {
  const s = await api.series.resolve(gid);
  if (!s) return null;
  const chapters = [];
  for (const c of s.chapters) chapters.push([c.title, await pictures(String(c.id))]);
  return [s.seriesTitle?.english ?? s.seriesTitle, chapters];
}

test('loose images a page imports become a gallery of their pages, in order', async () => {
  const gid = '1790600000001';
  await importInto(gid, groupImports([png(10), png(2), png(1)])[0]);
  assert.deepEqual(await pictures(gid), [1, 2, 10]);
  assert.equal(await api.series.resolve(gid), null);
});

test('a dropped folder of chapter folders is a series named after it, a chapter per folder holding pictures', async () => {
  const gid = '1790600000010';
  const { files, folders } = await drop({ name: 'Series', children: [
    png(9, 'cover.png'),
    { name: 'Vol 2', children: [{ name: 'Ch 3', children: [png(31, '1.png')] }] },
    { name: 'Vol 1', children: [
      { name: 'Ch 2', children: [png(22, '2.png'), png(21, '1.png')] },
      { name: 'Ch 1', children: [png(11, '1.png')] },
    ] },
  ] });
  const groups = groupImports(files, folders);
  assert.equal(groups.length, 1);
  await importInto(gid, groups[0]);
  // The folders holding only folders (Vol 1, Vol 2) don't count; the cover opens the first chapter.
  assert.deepEqual(await seriesOf(gid), ['Series', [['Ch 1', [9, 11]], ['Ch 2', [21, 22]], ['Ch 3', [31]]]]);
  assert.equal((await api.meta.get(gid)).title.english, 'Ch 1');
});

test('a zip of chapter folders is a series the same way; pictures in one folder, however deep, are one gallery', async () => {
  const [series, deep] = ['1790600000020', '1790600000021'];
  await importInto(series, groupImports([zip('Series.zip', [['Ch 10/1.png', 101], ['Ch 2/1.png', 21], ['Ch 2/2.png', 22]])])[0]);
  assert.deepEqual(await seriesOf(series), ['Series', [['Ch 2', [21, 22]], ['Ch 10', [101]]]]);
  await importInto(deep, groupImports([zip('Deep.zip', [['A/B/C/2.png', 2], ['A/B/C/1.png', 1]])])[0]);
  assert.equal(await api.series.resolve(deep), null);
  assert.deepEqual(await pictures(deep), [1, 2]);
  assert.equal((await api.meta.get(deep)).title.english, 'Deep');
});

test('importing a series again (a resumed import) adds no chapters', async () => {
  const gid = '1790600000030';
  const group = groupImports([zip('Again.zip', [['Ch 1/1.png', 11], ['Ch 2/1.png', 21]])])[0];
  await importInto(gid, group);
  const first = await api.series.resolve(gid);
  await importInto(gid, group, false);
  assert.deepEqual((await api.series.resolve(gid)).chapters.map((c) => String(c.id)), first.chapters.map((c) => String(c.id)));
  assert.deepEqual(await seriesOf(gid), ['Again', [['Ch 1', [11]], ['Ch 2', [21]]]]);
});

test('on a series\' page, an imported chapter keeps its series, and a folder of chapters joins it right after it', async () => {
  const [owner, batch, next] = ['1790600000040', '1790600000041', '1790600000042'];
  await importInto(owner, groupImports([png(1)])[0]);
  // The series page reserves each new chapter and attaches it before its pages are imported; the
  // drop's next item is attached while the first is still importing.
  for (const [gid, name] of [[batch, 'Batch'], [next, 'Next']]) {
    await api.galleries.create(gid, { title: title(name), isLocalImport: true });
    await api.series.attach(owner, gid, { title: name });
  }
  await importInto(batch, groupImports([zip('Batch.zip', [['Ch 5/1.png', 51], ['Ch 6/1.png', 61]])])[0], false);
  await importInto(next, groupImports([png(7)])[0], false);
  assert.equal((await api.series.resolve(next))?.ownerId, owner, 'a chapter imported on its page stays in its series');
  const [, chapters] = await seriesOf(owner);
  assert.deepEqual(chapters.map(([t]) => t), ['p 1', 'Ch 5', 'Ch 6', 'Next']);
  assert.deepEqual(chapters.map(([, p]) => p), [[1], [51], [61], [7]]);
});

// import-batch.test.mjs — a drop or pick of several titles imports as one job (import-batch.js):
// each title in turn into a gallery made when its turn comes, one 'import' job telling of the whole,
// a title imported before skipped by its fingerprint (the same files; a changed picture is a new
// title), one cut short carried on in its own gallery, a failed one leaving no gallery behind, a
// folder in the gallery format going into the gallery it names, and Stop ending the batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { constructor() { this.onmessage = null; } postMessage() {} close() {} };

const api = await import('../js/api.js');
const platform = await import('../js/platform.js');
const { runImportBatch } = await import('../js/import-batch.js');
const { groupImports, droppedImports } = await import('../js/import-files.js');
const { zipCreate } = await import('../js/zip.js');
const { exportFiles } = await import('../js/gallery-files.js');

const picture = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
const zip = (name, pages) => new File([zipCreate(pages.map((n, i) => ({ name: `${i + 1}.png`, data: picture(n) })))], name);
// A fake drop of Files and folders ({ name, children }).
function fakeEntry(node) {
  if (node instanceof File) return { name: node.name, isDirectory: false, file: (ok) => ok(node) };
  return { name: node.name, isDirectory: true, createReader() {
    const rest = node.children.map(fakeEntry);
    return { readEntries: (ok) => setTimeout(() => ok(rest.splice(0, 2))) };
  } };
}
const drop = async (...nodes) => {
  const { files, folders } = await droppedImports({ items: nodes.map((n) => ({ kind: 'file', webkitGetAsEntry: () => fakeEntry(n), getAsFile: () => (n instanceof File ? n : null) })) });
  return groupImports(files, folders);
};
async function library() {
  const ids = (await api.galleries.idsSorted({})).map(String);
  const out = [];
  for (const id of ids) {
    const g = await api.galleries.get(id);
    const pics = [];
    for (const { pageNum } of await api.pages.list(id)) pics.push((await new Response(await api.pages.blob(id, pageNum)).bytes()).at(-1));
    out.push({ id, title: g?.title?.english, pictures: pics });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title) || a.pictures.join().localeCompare(b.pictures.join()));
}
async function clear() { for (const id of await api.galleries.idsSorted({})) await api.galleries.delete(String(id)); }
// The batch's own job, as the tracker hears it.
function batchNews() {
  const seen = [];
  const stop = platform.jobs.subscribe((j) => { if (j?.kind === 'import') seen.push(j); });
  return { seen, stop };
}

test('a drop of several titles imports each into a gallery of its own, as one job', async () => {
  await clear();
  const groups = await drop({ name: 'Shelf', children: [zip('B.cbz', [21, 22]), zip('A.cbz', [11]), zip('C.zip', [31, 32, 33])] });
  const news = batchNews();
  const tally = await runImportBatch({ name: 'Shelf', groups });
  news.stop();
  assert.deepEqual([tally.imported, tally.skipped, tally.failed, tally.stopped], [3, 0, 0, false]);
  assert.deepEqual((await library()).map((g) => [g.title, g.pictures]), [['A', [11]], ['B', [21, 22]], ['C', [31, 32, 33]]]);
  const last = news.seen.at(-1);
  assert.deepEqual([last.status, last.name, last.done, last.total, last.imported], ['done', 'Shelf', 3, 3, 3]);
  assert.ok(news.seen.some((j) => j.status === 'progress' && j.current?.name === 'B'), 'it said which title it was on');
});

test('the same drop again skips every title, storing nothing; a changed picture is a new title', async () => {
  await clear();
  const make = () => drop({ name: 'Shelf', children: [zip('A.cbz', [11]), zip('B.cbz', [21, 22])] });
  await runImportBatch({ name: 'Shelf', groups: await make() });
  const before = await library();
  const storedAt = await Promise.all(before.map(async (g) => (await api.pages.get(g.id, 1)).cachedAt));
  const again = await runImportBatch({ name: 'Shelf', groups: await make() });
  assert.deepEqual([again.imported, again.skipped], [0, 2]);
  const after = await library();
  assert.deepEqual(after, before, 'no gallery added');
  assert.deepEqual(await Promise.all(after.map(async (g) => (await api.pages.get(g.id, 1)).cachedAt)), storedAt, 'nothing stored again');
  const changed = await runImportBatch({ name: 'Shelf', groups: await drop({ name: 'Shelf', children: [zip('A.cbz', [12]), zip('B.cbz', [21, 22])] }) });
  assert.deepEqual([changed.imported, changed.skipped], [1, 1]);
  assert.deepEqual((await library()).map((g) => [g.title, g.pictures]), [['A', [11]], ['A', [12]], ['B', [21, 22]]]);
});

test('a title cut short carries on in its own gallery when dropped again', async () => {
  await clear();
  const make = () => drop({ name: 'Shelf', children: [zip('A.cbz', [11]), zip('B.cbz', Array.from({ length: 12 }, (_, i) => 40 + i)), zip('C.cbz', [31])] });
  // Stop the batch once B has stored its second page, as the tracker's Stop does (services.js STOP_JOB).
  const off = platform.jobs.subscribe((j) => {
    if (j?.kind === 'upload' && j.status === 'progress' && j.done === 2) {
      off();
      platform.jobs.signal({ type: 'STOP_IMPORT_BATCH', batch: j.batch });
    }
  });
  const first = await runImportBatch({ name: 'Shelf', groups: await make() });
  assert.equal(first.stopped, true);
  assert.deepEqual(first.titles.map((t) => t.status), ['done', 'stopped', 'waiting']);
  const cut = (await library()).find((g) => g.title === 'B');
  assert.ok(cut.pictures.length >= 2 && cut.pictures.length < 12, `B stopped part-way (${cut.pictures.length} pages)`);
  const second = await runImportBatch({ name: 'Shelf', groups: await make() });
  assert.deepEqual([second.imported, second.skipped], [2, 1]);
  const all = await library();
  assert.deepEqual(all.map((g) => g.title), ['A', 'B', 'C'], 'no second B');
  assert.equal(all[1].id, cut.id);
  assert.deepEqual(all[1].pictures, Array.from({ length: 12 }, (_, i) => 40 + i));
});

test('a title that fails leaves no gallery, and the rest import', async () => {
  await clear();
  const groups = await drop({ name: 'Shelf', children: [zip('A.cbz', [11]), new File([new Uint8Array(300)], 'broken.cbz'), zip('C.cbz', [31])] });
  const tally = await runImportBatch({ name: 'Shelf', groups });
  assert.deepEqual([tally.imported, tally.failed], [2, 1]);
  assert.equal(tally.failures[0].name, 'broken');
  assert.match(tally.failures[0].error, /not a valid zip/i);
  assert.deepEqual((await library()).map((g) => g.title), ['A', 'C']);
});

test('a folder in the gallery format goes into the gallery it names, with no other gallery made', async () => {
  await clear();
  const gid = '1790700000001';
  await api.meta.put({ galleryId: gid, title: { english: 'Named', japanese: '', pretty: 'Named' }, tags: [], numPages: 2 });
  for (const n of [1, 2]) await api.pages.put(gid, n, new Blob([picture(n)], { type: 'image/png' }), { key: `local://${gid}/${n}.png` });
  const { name, files } = await exportFiles(gid, { read: api.transfer.read, metaGet: api.meta.get });
  await api.galleries.delete(gid);
  const folder = { name: 'Library', children: [{ name, children: [] }] };
  const dirOf = (path) => {
    let node = folder.children[0];
    for (const part of path.split('/').slice(0, -1)) {
      let next = node.children.find((c) => c.name === part && !(c instanceof File));
      if (!next) { next = { name: part, children: [] }; node.children.push(next); }
      node = next;
    }
    return node;
  };
  for (const f of files) dirOf(f.name).children.push(new File([f.data], f.name.split('/').pop()));
  const groups = await drop(folder, zip('Other.cbz', [7]));
  const tally = await runImportBatch({ name: 'Library', groups });
  assert.equal(tally.imported, 2);
  const all = await library();
  assert.deepEqual(all.map((g) => [g.title, g.pictures]), [['Named', [1, 2]], ['Other', [7]]]);
  assert.equal(all[0].id, gid);
});

test('a single title is its own job: no batch job is told of', async () => {
  await clear();
  const news = batchNews();
  const tally = await runImportBatch({ name: 'A', groups: await drop(zip('A.cbz', [11])) });
  news.stop();
  assert.equal(tally.imported, 1);
  assert.deepEqual(news.seen, []);
});

// series-commands.test.mjs — every change to a series is one command that leaves every series whole
// (invariants I7, I8): deleting a member directly, a whole series at once, and a generic change to a
// gallery's series links (what a source's own series sync writes). A refused command changes nothing.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

const api = await import('../js/api.js');
const { mergeIntoSeries } = await import('../js/series.js');
const { checkInvariants } = await import('../js/library-check.js');

const page = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
let next = 1790000000000;
async function gallery(title) {
  const gid = String(next++);
  await api.meta.put({ galleryId: gid, title: { english: title, japanese: '', pretty: '' }, tags: [], numPages: 1 });
  await api.pages.put(gid, 1, page());
  return gid;
}
async function series(...titles) {
  const ids = [];
  for (const t of titles) ids.push(await gallery(t));
  for (const id of ids.slice(1)) await mergeIntoSeries(ids[0], id);
  return ids;
}
const chaptersOf = async (gid) => (await api.meta.get(gid))?.chapters?.map(c => c.id) ?? null;
const parentOf = async (gid) => (await api.meta.get(gid))?.parentId ?? null;
// A gallery's entry as the library keeps it (its stored totals), or null when it has none.
const entryOf = async (gid) => (await api.maintenance.integritySnapshot()).galleries.find(g => g.gid === gid) ?? null;
beforeEach(() => api.maintenance.clearAll());   // each test checks the whole library: start each from empty

async function whole() {
  const errors = checkInvariants(await api.maintenance.integritySnapshot()).violations.filter(v => v.severity === 'error');
  assert.deepEqual(errors.map(v => `${v.id} ${v.detail}`), []);
}

test('deleting a chapter directly takes it out of its series', async () => {
  const [o, a, b] = await series('O', 'A', 'B');
  await api.galleries.delete(a);
  assert.deepEqual(await chaptersOf(o), [o, b]);
  assert.equal((await entryOf(o)).chapterCount, 2, 'the totals follow in the same step');
  await whole();
});

test('deleting the owner directly hands the series to its next chapter', async () => {
  const [o, a, b] = await series('O', 'A', 'B');
  await api.galleries.delete(o);
  assert.deepEqual(await chaptersOf(a), [a, b]);
  assert.equal(await parentOf(b), a);
  assert.equal(await api.meta.get(o), null);
  await whole();
});

test('deleting one of two chapters leaves a plain gallery', async () => {
  const [o, a] = await series('O', 'A');
  await api.galleries.delete(a);
  assert.equal(await chaptersOf(o), null);
  assert.equal((await entryOf(o)).chapterCount, undefined);
  await whole();
});

test('a whole series is deleted at once, a chapter it no longer lists included', async () => {
  const [o, a, b] = await series('O', 'A', 'B');
  const hidden = await gallery('H');
  // A leftover pointing at it, written as stored (a gallery entry alone, exactly as given).
  const { stat } = await api.transfer.read(hidden);
  await api.transfer.write({ galleryId: hidden, stat: { ...stat, parentId: o } });
  await api.series.delete(o);
  for (const gid of [o, a, b, hidden]) assert.equal(await entryOf(gid), null, gid);
  await whole();
});

test('a change that moves a chapter out of its series takes it off that series\' list', async () => {
  const [o, a, b] = await series('O', 'A', 'B');
  await api.galleries.mutate(a, { parentId: null }, { silent: true });
  assert.deepEqual(await chaptersOf(o), [o, b]);
  await whole();
  await api.galleries.mutate(b, { parentId: null });
  assert.equal(await chaptersOf(o), null, 'one chapter left: the series dissolves');
  await whole();
});

test('a new chapter list for an owner lets go of the chapters it drops', async () => {
  const [o, a, b] = await series('O', 'A', 'B');
  await api.galleries.mutate(o, { chapters: [{ id: o, title: 'O' }, { id: b, title: 'B' }] });
  assert.equal(await parentOf(a), null);
  assert.equal(await parentOf(b), o);
  assert.equal((await entryOf(o)).chapterCount, 2);
  await whole();
});

test('importing a series replaces it: chapters it no longer has are deleted', async () => {
  const [o, a, b] = await series('O', 'A', 'B');
  await api.series.write(o, [{ id: o, title: 'O' }, { id: b, title: 'B', number: 2 }], { seriesTitle: 'S' });
  assert.equal(await entryOf(a), null);
  assert.deepEqual((await api.meta.get(o)).chapters, [{ id: o, title: 'O' }, { id: b, title: 'B', number: 2 }]);
  await whole();
});

test('a refused command changes nothing', async () => {
  const [o, a] = await series('O', 'A');
  const lone = await gallery('L');
  const before = [await api.meta.get(o), await api.meta.get(a), await api.meta.get(lone)];
  await assert.rejects(mergeIntoSeries(o, o), { name: 'BackendError', code: 'invalid' });
  await assert.rejects(mergeIntoSeries(lone, a), { code: 'invalid' }, 'a chapter of another series');
  await assert.rejects(mergeIntoSeries('1790999999999', lone), { code: 'not-found' });
  assert.deepEqual([await api.meta.get(o), await api.meta.get(a), await api.meta.get(lone)], before);
  await whole();
});

// A series has two kinds of member — chapters and volumes — and a gallery joins the one its own
// `kind` says, keeping it through detaching and joining again.
test('a volume joins a series as a volume, and stays one when it leaves and comes back', async () => {
  const [o, a] = await series('O', 'A');
  const v = await gallery('V');
  await api.galleries.mutate(v, { kind: 'volume' });
  await mergeIntoSeries(o, v);
  assert.deepEqual((await api.meta.get(o)).chapters.map(c => [c.id, c.kind ?? 'chapter']), [[o, 'chapter'], [a, 'chapter'], [v, 'volume']]);
  const { removeChapter } = await import('../js/series.js');
  await removeChapter(o, v, { deleteImages: false });
  assert.equal((await api.meta.get(v)).kind, 'volume', 'the gallery keeps its kind');
  await mergeIntoSeries(o, v);
  assert.equal((await api.meta.get(o)).chapters.at(-1).kind, 'volume');
  await whole();
});

test('a series merged into another keeps each member\'s kind', async () => {
  const [o, a] = await series('O', 'A');
  const [p, v] = [await gallery('P'), await gallery('V')];
  await api.galleries.mutate(v, { kind: 'volume' });
  await mergeIntoSeries(p, v);
  await mergeIntoSeries(o, p);
  assert.deepEqual((await api.meta.get(o)).chapters.map(c => c.kind ?? 'chapter'), ['chapter', 'chapter', 'chapter', 'volume']);
  await whole();
});

test('volumes are not chapters when a series counts its chapters', async () => {
  const { chapterTally } = await import('../js/series.js');
  assert.deepEqual(chapterTally([{ number: 1 }, { number: 2 }, { number: 1, kind: 'volume' }]), { chapters: 2, extras: 0 });
});

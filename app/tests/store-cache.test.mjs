// store-cache.test.mjs — the windowed store must actually stay windowed: paging through a large
// library plateaus instead of retaining every gallery ever visited, and an entity something is
// currently subscribed to (i.e. on screen) is never evicted out from under it.
import test from 'node:test';
import assert from 'node:assert/strict';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const { galleries } = await import('../js/api.js');
const store = await import('../js/store.js');

const PAGE = 60;
galleries.page = async ({ offset, limit }) =>
  Array.from({ length: limit }, (_, i) => ({ id: String(offset + i), count: 1, size: 1, title: `g${offset + i}`, tags: [] }));
galleries.count = async () => 100000;
galleries.get = async (id) => ({ id: String(id), count: 1, size: 1, title: `g${id}`, tags: [] });

test('paging a large library plateaus instead of growing without bound', async () => {
  for (let page = 1; page <= 40; page++) await store.getPage({ page, pageSize: PAGE });
  // 40 pages x 60 = 2400 entities visited; the retain window is far smaller.
  let resident = 0;
  for (let i = 0; i < 2400; i++) if (store.get(String(i)) !== undefined) resident++;
  assert.ok(resident <= 400, `cache should plateau, held ${resident} entities`);
  assert.ok(resident >= PAGE, `the most recent page must stay resident, held ${resident}`);
});

test('the most recently visited page is the part that survives', async () => {
  await store.getPage({ page: 100, pageSize: PAGE });   // ids 5940..5999
  for (let i = 5940; i < 6000; i++) {
    assert.notEqual(store.get(String(i)), undefined, `id ${i} from the current page must be cached`);
  }
});

test('a subscribed gallery is never evicted while something is watching it', async () => {
  const watched = '999999';
  await store.load(watched);
  const off = store.subscribe(watched, () => {});
  for (let page = 200; page < 240; page++) await store.getPage({ page, pageSize: PAGE });
  assert.notEqual(store.get(watched), undefined, 'an on-screen entity must survive eviction');
  off();
});

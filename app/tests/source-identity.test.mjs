import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const api = await import('../js/api.js');
const title = { english: 'Shared title', japanese: '', pretty: '' };
const image = (value) => new Blob([new Uint8Array([value])], { type: 'image/jpeg' });

test('matching source IDs from different sources keep separate metadata and pages', async () => {
  const sid = '4234981';
  const [a, b, again] = await Promise.all([
    api.galleries.resolveSource(sid, 'source-a'),
    api.galleries.resolveSource(sid, 'source-b'),
    api.galleries.resolveSource(sid, 'source-a'),
  ]);
  assert.notEqual(a, b);
  assert.equal(a, again, 'concurrent lookups for one source converge');
  assert.equal((await api.meta.get(a)).source, 'source-a');
  assert.equal((await api.meta.get(b)).source, 'source-b');
  await api.meta.put({ galleryId: a, sourceId: sid, source: 'source-a', title });
  await api.pages.put(a, 1, image(1));
  await api.meta.put({ galleryId: b, sourceId: sid, source: 'source-b', title });
  await api.pages.put(b, 1, image(2));
  await api.pages.put(b, 2, image(3));
  assert.equal(await api.galleries.resolveSource(sid, 'source-a'), a);
  assert.equal(await api.galleries.resolveSource(sid, 'source-b'), b);
  assert.deepEqual((await api.pages.list(a)).map(p => p.pageNum), [1]);
  assert.deepEqual((await api.pages.list(b)).map(p => p.pageNum), [1, 2]);
  assert.deepEqual([...new Uint8Array(await (await api.pages.get(a, 1)).blob.arrayBuffer())], [1]);
  assert.deepEqual([...new Uint8Array(await (await api.pages.get(b, 1)).blob.arrayBuffer())], [2]);
  assert.equal((await api.meta.get(a)).source, 'source-a');
  assert.equal(await api.galleries.resolveSource(a), a, 'internal IDs still work directly');
});

test('existing galleries and deliberate copies resolve within their own source', async () => {
  const sid = '4234982';
  const legacy = await api.galleries.resolveSource(sid);
  const first = await api.galleries.resolveSource(sid, 'source-a');
  const other = await api.galleries.resolveSource(sid, 'source-b');
  assert.notEqual(first, legacy, 'an unscoped placeholder cannot claim a known source');
  assert.notEqual(first, other);
  await api.meta.put({ galleryId: first, sourceId: sid, source: 'source-a', title });
  await api.meta.put({ galleryId: other, sourceId: sid, source: 'source-b', title });
  const copy = await api.galleries.resolveSource('4234983', 'source-a');
  await api.meta.put({ galleryId: copy, sourceId: sid, source: 'source-a', title });
  assert.equal(await api.galleries.resolveSource(sid, 'source-a'), first);
  assert.equal(await api.galleries.resolveSource(sid, 'source-b'), other);
  await api.galleries.delete(first);
  assert.equal(await api.galleries.resolveSource(sid, 'source-a'), copy);
  assert.equal(await api.galleries.resolveSource(sid, 'source-b'), other);
  await api.galleries.mutate(copy, { source: 'source-c' });
  assert.equal(await api.galleries.resolveSource(sid, 'source-c'), copy);
  assert.notEqual(await api.galleries.resolveSource(sid, 'source-a'), copy);
  assert.equal(await api.galleries.resolveSource(sid, 'source-b'), other);
});

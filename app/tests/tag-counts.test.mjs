// tag-counts.test.mjs — a tag's count is how many library entries carry it: a series counts once
// (through its combined tags), its chapters not on their own, and metadata that never became a
// gallery not at all. Names count whole and case-insensitively.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const { mutateGallery, metaPut, tagCounts } = await import('../js/db.js');
const { mergeIntoSeries } = await import('../js/series.js');

const tag = (type, name) => ({ type, name, url: '' });

await mutateGallery('10', { tags: [tag('tag', 'Big'), tag('artist', 'ann')], count: 1 });
await mutateGallery('11', { tags: [tag('tag', 'big breasts'), tag('tag:female', 'big')], count: 1 });
await mutateGallery('12', { tags: [tag('tag', 'big')], count: 1 });
await mutateGallery('13', { tags: [tag('tag', 'big'), tag('artist', 'bob')], count: 1 });
await mergeIntoSeries('12', '13');
await metaPut({ galleryId: '14', tags: [tag('tag', 'big')] });

test('a series counts once and metadata that never became a gallery not at all', async () => {
  const counts = await tagCounts({ keys: ['tag:big', 'artist:bob', 'artist:nobody'] });
  assert.deepEqual(Object.fromEntries(counts), { 'tag:big': 2, 'artist:bob': 1, 'artist:nobody': 0 });
});

test('a type prefix lists every tag of that type with its count', async () => {
  assert.deepEqual(Object.fromEntries(await tagCounts({ prefix: 'artist:' })), { 'artist:ann': 1, 'artist:bob': 1 });
  assert.deepEqual(Object.fromEntries(await tagCounts({ prefix: 'tag:' })),
    { 'tag:big': 2, 'tag:big breasts': 1, 'tag:female:big': 1 });
});

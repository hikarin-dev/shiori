import test from 'node:test';
import assert from 'node:assert/strict';

class SilentBroadcastChannel {
  static instances = [];
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.onmessage = null;
    SilentBroadcastChannel.instances.push(this);
  }
  postMessage(message) { this.messages.push(message); }
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const platform = await import('../js/platform.js');
const { galleries } = await import('../js/api.js');
const store = await import('../js/store.js');

galleries.get = async id => ({ id: String(id), count: 1, size: 1, title: String(id), tags: [] });

const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));

test('feed counters from different contexts are both delivered', async () => {
  const seen = [];
  const unsubscribe = store.subscribe('*', gid => seen.push(gid));

  platform.feed.publish({ gid: 'first', context: 'context-a', n: 1, at: 1 });
  await nextTurn();
  platform.feed.publish({ gid: 'second', context: 'context-b', n: 1, at: 2 });
  await nextTurn();

  unsubscribe();
  assert.deepEqual(seen, ['first', 'second']);
});

test('the exact same feed beacon is still deduplicated', async () => {
  const seen = [];
  const unsubscribe = store.subscribe('*', gid => seen.push(gid));
  const beacon = { gid: 'duplicate', context: 'context-c', n: 1, at: 3 };

  platform.feed.publish(beacon);
  platform.feed.publish(beacon);
  await nextTurn();

  unsubscribe();
  assert.deepEqual(seen, ['duplicate']);
});

test('an interleaved replay of the same beacon is deduplicated', async () => {
  const seen = [];
  const unsubscribe = store.subscribe('*', gid => seen.push(gid));
  const first = { gid: 'replayed', context: 'context-d', n: 1, at: 4 };

  platform.feed.publish(first);
  await nextTurn();
  platform.feed.publish({ gid: 'between', context: 'context-e', n: 1, at: 5 });
  await nextTurn();
  platform.feed.publish(first);
  await nextTurn();

  unsubscribe();
  assert.deepEqual(seen, ['replayed', 'between']);
});

test('jobs.signal broadcasts without opening the durable registry', () => {
  const signal = { type: 'PAGE_STORED', galleryId: 'gallery-1', pageNum: 4, url: 'page://gallery-1/4.webp' };
  const seen = [];
  const unsubscribe = platform.jobs.subscribe(message => seen.push(message));

  platform.jobs.signal(signal);
  unsubscribe();

  const channel = SilentBroadcastChannel.instances.find(candidate => candidate.name === 'shiori-jobs');
  assert.deepEqual(channel?.messages, [signal]);
  assert.deepEqual(seen, [signal]);
  assert.equal(globalThis.indexedDB, undefined);
});

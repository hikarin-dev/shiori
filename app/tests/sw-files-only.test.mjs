// sw-files-only.test.mjs — a site whose library the desktop app keeps registers the worker as
// sw.js?library=desktop (boot.js). That worker keeps the app's files and runs no jobs: a worker
// can't tell which library its site uses, and would run them against this browser's. Registered
// plainly, the same worker still takes jobs and replays the ones left pending.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;
Object.defineProperty(globalThis, 'navigator', {
  value: { storage: { getDirectory: () => new Promise(() => {}) } },
  configurable: true,
});
globalThis.caches = { keys: async () => [], delete: async () => true, open: async () => ({}) };

const platform = await import('../js/platform.js');

// sw.js evaluated in a worker scope registered at `href`: the listeners it adds.
async function worker(href, instance) {
  const listeners = {};
  globalThis.self = {
    location: { href },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    clients: { claim: async () => {} },
    skipWaiting() {},
  };
  await import(`../../sw.js?${instance}`);
  return listeners;
}

// Dispatches an event to `listener`; resolves what it handed to waitUntil (null: nothing).
async function dispatch(listener, event = {}) {
  const waited = [];
  listener({ ...event, waitUntil: (p) => waited.push(p) });
  await Promise.all(waited);
  return waited.length ? waited : null;
}

const pendingKeys = async () => (await platform.jobsPending.all()).map((e) => e.key);
// A job of a kind no runner has: replaying it drops its row, so the row shows whether it was.
const LEFT_OVER = { key: '5:retired', kind: 'retired', payload: { galleryId: '5' } };

test('the worker of a site using the desktop library runs no jobs', async () => {
  const sw = await worker('https://example.test/sw.js?library=desktop', 'files-only');
  await platform.jobsPending.add(LEFT_OVER);

  await dispatch(sw.activate);
  assert.ok((await pendingKeys()).includes(LEFT_OVER.key), 'activating must not replay pending jobs');

  for (const data of [{ __shioriJob: true, kind: 'upload', payload: { galleryId: '6' } },
    { __shioriPoll: true }, { __shioriJobCancel: true, kind: 'upload', payload: { galleryId: '6' } }]) {
    assert.equal(await dispatch(sw.message, { data }), null, `${Object.keys(data)[0]} must be ignored`);
  }
  assert.ok((await pendingKeys()).includes(LEFT_OVER.key), 'a poll must not replay pending jobs');
  assert.equal(typeof sw.fetch, 'function', 'it still serves the app\'s files');
});

test('the worker of a site keeping its library in this browser still runs them', async () => {
  const sw = await worker('https://example.test/sw.js', 'full');
  await platform.jobsPending.add(LEFT_OVER);

  await dispatch(sw.activate);
  assert.ok(!(await pendingKeys()).includes(LEFT_OVER.key), 'activating replays the pending jobs');
  assert.ok(await dispatch(sw.message, { data: { __shioriJob: true, kind: 'nonsense', payload: { galleryId: '7' } } }),
    'a job handed over is taken');
});

// translation-store.test.mjs — Settings' Translation panel as a store (src/lib/translation-store.ts): its
// rules app/js/translate-settings.js's, the server and the store stand-ins. Nothing is asked of a server
// the page wasn't pointed at; the badge through checking, online, offline; the benchmark offered for a
// local server that answers; an older schema stored once; saving, refusing, checking again on a change
// of address or token; capabilities from the kept copy and then the server, an answer for an address
// left meanwhile dropped; nothing landing after stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const rules = await import('../js/translate-settings.js');
const { hasConfiguredServer, serverUrlFromSettings } = await import('../js/translate.js');
const { createTranslationStore } = await import('../../src/lib/translation-store.ts');

const CAPS = JSON.parse(readFileSync(new URL('./fixtures/capabilities.json', import.meta.url), 'utf8'));
const flush = () => new Promise((r) => setTimeout(r, 0));
const later = () => { let done; const p = new Promise((r) => { done = r; }); return { p, done }; };

function world(stored, { online = true, cached = null } = {}) {
  const calls = [];
  const kept = new Map(Object.entries(stored === undefined ? {} : { translateSettings: stored }));
  const writes = [];
  const store = createTranslationStore({
    rules: { ...rules, hasConfiguredServer, serverUrlFromSettings },
    kv: { get: async (keys) => Object.fromEntries(keys.filter((k) => kept.has(k)).map((k) => [k, structuredClone(kept.get(k))])),
      set: (values) => { for (const [k, v] of Object.entries(values)) { kept.set(k, structuredClone(v)); writes.push(JSON.stringify(v)); } } },
    ping: async (url) => { calls.push(['ping', url]); return online; },
    getCapabilities: async (url) => { calls.push(['caps', url]); return online ? { doc: CAPS, offline: false } : { doc: cached, offline: true }; },
    cachedCapabilities: async (url) => { calls.push(['cached', url]); return cached ? { doc: cached } : null; },
    saved: () => 'Saved.',
  });
  return { store, calls, writes, kept };
}

test('nothing configured: nothing is asked of any server, the badge says offline, nothing is stored', async () => {
  const { store, calls, writes } = world(undefined);
  store.start();
  await flush(); await flush();
  assert.equal(store.get().badge, 'offline');
  assert.deepEqual(calls.filter(([what]) => what !== 'cached'), [], 'no ping, no capabilities');
  assert.deepEqual(writes, []);
  assert.equal(store.get().loaded, true);
  assert.equal(store.get().caps, null);
  assert.equal(store.get().benchmark, false);
  // Check is a request: it asks the default server.
  store.check();
  await flush(); await flush();
  assert.deepEqual(calls.filter(([what]) => what !== 'cached').map(([what, url]) => `${what} ${url}`), ['ping http://127.0.0.1:5003', 'caps http://127.0.0.1:5003']);
});

test('a configured local server: checking, then online and the benchmark offered; the capabilities drawn', async () => {
  const { store, calls } = world({ schema: 3, params: {}, serverUrl: 'http://127.0.0.1:7000' });
  const badges = [];
  store.subscribe(() => { if (badges.at(-1) !== store.get().badge) badges.push(store.get().badge); });
  store.start();
  await flush(); await flush(); await flush();
  assert.deepEqual(badges, ['checking', 'online']);
  assert.equal(store.get().badge, 'online');
  assert.equal(store.get().benchmark, true);
  assert.equal(store.get().caps, CAPS);
  assert.equal(store.get().capsOffline, false);
  assert.ok(calls.some(([w, u]) => w === 'ping' && u === 'http://127.0.0.1:7000'));
  const remote = world({ schema: 3, params: {}, serverUrl: 'https://mt.example.test' });
  remote.store.start();
  await flush(); await flush(); await flush();
  assert.equal(remote.store.get().badge, 'online');
  assert.equal(remote.store.get().benchmark, false, 'a remote server: no benchmark');
  const down = world({ schema: 3, params: {}, serverUrl: 'http://127.0.0.1:7000' }, { online: false, cached: CAPS });
  down.store.start();
  await flush(); await flush(); await flush();
  assert.equal(down.store.get().badge, 'offline');
  assert.equal(down.store.get().caps, CAPS, 'the kept copy');
  assert.equal(down.store.get().capsOffline, true);
});

test('an older schema is migrated and stored once', async () => {
  const { store, writes } = world({ schema: 2, params: { 'ocr.ocr': '48px' }, serverUrl: 'http://127.0.0.1:7000' });
  store.start();
  await flush(); await flush();
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0]).schema, 3);
});

test('saving: the panel\'s fields over the settings; a bad address refused; the address or token checked again', async () => {
  const { store, writes, calls } = world({ schema: 3, params: {}, serverUrl: 'http://127.0.0.1:7000' });
  store.start();
  await flush(); await flush(); await flush();
  const before = calls.length;
  store.setField('studyModeGeneration', 'text_and_image');
  assert.deepEqual(store.commit('studyModeGeneration'), { text: 'Saved.', tone: 'ok' });
  assert.equal(JSON.parse(writes.at(-1)).studyModeGeneration, 'text_and_image');
  await flush();
  assert.equal(calls.length, before, 'no check for a field that is not the connection');
  store.setField('serverUrl', 'ftp://x');
  assert.deepEqual(store.commit('serverUrl'), { text: rules.SERVER_URL_ERROR, tone: 'err' });
  assert.equal(writes.length, 1, 'nothing stored');
  store.setField('serverUrl', 'http://127.0.0.1:7001/');
  store.commit('serverUrl');
  assert.equal(JSON.parse(writes.at(-1)).serverUrl, 'http://127.0.0.1:7001');
  await flush(); await flush();
  assert.ok(calls.slice(before).some(([w, u]) => w === 'ping' && u === 'http://127.0.0.1:7001'));
  assert.ok(calls.slice(before).some(([w, u]) => w === 'caps' && u === 'http://127.0.0.1:7001'));
  // An edit of the advanced window, a preset (drawn again whole), a reset.
  const drawn = store.get().drawn;
  store.apply({ param: 'kernel_size', type: 'number', value: '9', integer: true });
  assert.equal(store.get().drawn, drawn);
  store.apply({ preset: 'fast' });
  assert.equal(store.get().drawn, drawn + 1);
  assert.equal(JSON.parse(writes.at(-1)).params.kernel_size, 3);
  store.reset();
  assert.deepEqual(JSON.parse(writes.at(-1)).params, {});
});

test('an answer for an address left meanwhile, or after the page was left, lands nowhere', async () => {
  const slow = later();
  const kept = new Map([['translateSettings', { schema: 3, params: {}, serverUrl: 'http://127.0.0.1:7000' }]]);
  const store = createTranslationStore({
    rules: { ...rules, hasConfiguredServer, serverUrlFromSettings },
    kv: { get: async (keys) => Object.fromEntries(keys.filter((k) => kept.has(k)).map((k) => [k, kept.get(k)])), set: () => {} },
    ping: async () => { await slow.p; return true; },
    getCapabilities: async (url) => { await slow.p; return { doc: { ...CAPS, url }, offline: false }; },
    cachedCapabilities: async () => null,
    saved: () => 'Saved.',
  });
  store.start();
  await flush(); await flush();
  store.setField('serverUrl', 'http://127.0.0.1:7999');
  store.check();
  await flush();
  slow.done();
  await flush(); await flush(); await flush();
  assert.equal(store.get().caps?.url, 'http://127.0.0.1:7999', 'the answer for the address now in the field, not the one before');
  // Stopped while a check is under way: nothing changes after.
  const again = later();
  const s2 = createTranslationStore({
    rules: { ...rules, hasConfiguredServer, serverUrlFromSettings },
    kv: { get: async (keys) => Object.fromEntries(keys.filter((k) => kept.has(k)).map((k) => [k, kept.get(k)])), set: () => {} },
    ping: async () => { await again.p; return true; }, getCapabilities: async () => { await again.p; return { doc: CAPS, offline: false }; },
    cachedCapabilities: async () => null, saved: () => 'Saved.',
  });
  s2.start();
  await flush(); await flush();
  assert.equal(s2.get().badge, 'checking');
  s2.stop();
  again.done();
  await flush(); await flush();
  assert.equal(s2.get().badge, 'checking', 'nothing landed after stop');
  assert.equal(s2.get().caps, null);
});

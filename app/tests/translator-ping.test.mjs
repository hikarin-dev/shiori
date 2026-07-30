// translator-ping.test.mjs — a first-time visitor must not trigger a local-network permission
// prompt. The translation server defaults to http://127.0.0.1:5003, so any *automatic* status
// poll against that default (library/overview do it on load and every 20s) makes the browser ask
// the user to "access other apps and services on this device" before they have set anything up.
// Background polling therefore has to stay silent until a server is actually configured.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
};

// services.js pulls in the page-side bridge, which expects a window to listen on.
globalThis.window = { addEventListener() {}, removeEventListener() {}, postMessage() {} };
globalThis.location = new URL('https://example.test/library');
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });

const fetched = [];
globalThis.fetch = async (url) => {
  fetched.push(String(url));
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const { services } = await import('../js/services.js');
const { hasConfiguredServer } = await import('../js/translate.js');

test('hasConfiguredServer only counts a real, non-empty server URL', () => {
  assert.equal(hasConfiguredServer(undefined), false);
  assert.equal(hasConfiguredServer({}), false);
  assert.equal(hasConfiguredServer({ serverUrl: '' }), false);
  assert.equal(hasConfiguredServer({ serverUrl: '   ' }), false);
  assert.equal(hasConfiguredServer({ serverUrl: 'http://127.0.0.1:5003' }), true);
});

test('an unconfigured install never contacts the default local address', async () => {
  _store.clear();
  fetched.length = 0;
  const resp = await services.handle({ type: 'TRANSLATOR_PING' });
  assert.deepEqual(fetched, [], 'no network request may be made before the user configures a server');
  assert.equal(resp.online, false);
  assert.equal(resp.configured, false);
  assert.equal(resp.serverUrl, '', 'the default address is not even disclosed to the caller');
});

test('once a server is configured the status poll pings it', async () => {
  _store.clear();
  fetched.length = 0;
  localStorage.setItem('shiori:translateSettings', JSON.stringify({ serverUrl: 'http://127.0.0.1:5003' }));
  const resp = await services.handle({ type: 'TRANSLATOR_PING' });
  assert.equal(fetched.length, 1, 'a configured server is polled');
  assert.match(fetched[0], /^http:\/\/127\.0\.0\.1:5003\/stats/);
  assert.equal(resp.configured, true);
  assert.equal(resp.online, true);
});

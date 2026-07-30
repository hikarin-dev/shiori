// agent-bridge.test.mjs — the privileged bridge serves only a paired session: an unpaired or
// wrong-origin caller gets no reply at all, ops travel only on the dedicated MessagePort, and
// the kv surface never exposes credentials or the pairing capability itself.
import test from 'node:test';
import assert from 'node:assert/strict';

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

const _listeners = [];
globalThis.window = { addEventListener: (type, fn) => { if (type === 'message') _listeners.push(fn); } };
globalThis.window.parent = globalThis.window;
globalThis.location = new URL('http://localhost:5500/app/agent.html');

await import('../js/agent.js');

const dispatch = (event) => { for (const fn of _listeners) fn(event); };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

const SECRET = 'test-pairing-secret-0123456789abcdef';
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop';
_store.set('shiori:agentPairSecret', JSON.stringify(SECRET));

const _openPorts = [];
test.after(() => { for (const p of _openPorts) { try { p.close(); } catch {} } });

function hello(origin, secret) {
  const replies = [];
  dispatch({
    data: { __shioriAgentHello: true, secret },
    origin,
    source: { postMessage: (msg, tgt, transfer) => replies.push({ msg, tgt, port: transfer?.[0] }) },
  });
  return replies;
}

function callOverPort(port, op, data) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (ev) => {
      if (ev.data?.id !== id) return;
      port.removeEventListener('message', onMsg);
      resolve(ev.data);
    };
    port.addEventListener('message', onMsg);
    port.start?.();
    port.postMessage({ id, op, data });
    setTimeout(() => reject(new Error('no reply')), 2000);
  });
}

test('a wrong-origin caller gets no session even with the right secret', async () => {
  const replies = hello('https://evil.example.com', SECRET);
  await tick();
  assert.equal(replies.length, 0);
});

test('a wrong secret gets silence', async () => {
  const replies = hello(EXT_ORIGIN, 'not-the-secret-aaaaaaaaaaaaaaaa');
  await tick();
  assert.equal(replies.length, 0);
});

test('legacy ambient op messages are never answered', async () => {
  const replies = [];
  dispatch({
    data: { __shioriAgent: true, id: 1, op: 'kv_get', data: { keys: ['apiKey'] } },
    origin: EXT_ORIGIN,
    source: { postMessage: (msg) => replies.push(msg) },
  });
  await tick();
  assert.equal(replies.length, 0);
});

test('the paired session works over its port, and kv is allowlisted', async () => {
  _store.set('shiori:apiKey', JSON.stringify('k-123'));
  _store.set('shiori:translateSettings', JSON.stringify({ serverUrl: 'http://x', token: 'hush' }));

  const replies = hello(EXT_ORIGIN, SECRET);
  await tick();
  assert.equal(replies.length, 1);
  assert.ok(replies[0].msg.__shioriAgentPaired);
  assert.equal(replies[0].tgt, EXT_ORIGIN);
  const port = replies[0].port;
  assert.ok(port, 'a MessagePort must be transferred');
  _openPorts.push(port);

  const kv = await callOverPort(port, 'kv_get', { keys: ['apiKey', 'translateSettings', 'agentPairSecret', 'cacheEnabled'] });
  assert.equal(kv.ok, true);
  assert.equal(kv.data.apiKey, 'k-123');
  assert.equal(kv.data.translateSettings, undefined, 'credentials must not be readable');
  assert.equal(kv.data.agentPairSecret, undefined, 'the pairing capability must not be readable');

  const has = await callOverPort(port, 'kv_has', { keys: ['translateSettings', 'agentPairSecret'] });
  assert.deepEqual(has.data, { translateSettings: true }, 'presence only, and never for the pairing secret');

  await callOverPort(port, 'kv_set', { values: { cacheEnabled: true, countsRepaired: 'evil', agentPairSecret: 'stolen' } });
  assert.equal(_store.get('shiori:cacheEnabled'), 'true');
  assert.equal(_store.has('shiori:countsRepaired'), false, 'non-allowlisted keys are dropped');
  assert.equal(JSON.parse(_store.get('shiori:agentPairSecret')), SECRET, 'the secret cannot be overwritten');

  const bad = await callOverPort(port, 'delete_gallery', { galleryId: '"><svg onload=alert(1)>' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid gallery id/);
});

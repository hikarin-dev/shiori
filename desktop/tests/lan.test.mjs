// lan.test.mjs — the desktop app open to the person's network: it listens on this computer's every
// address, its addresses and name there are its own (a page served at one opens the library without
// a token, as one at 127.0.0.1 does), and a domain rebound to it still gets nowhere. Closed (the
// default), it answers on 127.0.0.1 only and names nothing else as its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { startServer, networkAddresses } = await import('../server/server.js');

async function serve(t, lan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-lan-'));
  const library = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library') }).open();
  const server = await startServer({ library, token: 'window-token-0123456789abcdef', lan });
  t.after(async () => { await server.close(); library.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return server;
}

// Whether a token-less library connection opens at `address` for a page at `origin`, naming `host`.
function opens(address, port, { origin, host }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${address}:${port}/api/ws?s=a-browser`, { origin, headers: host ? { host } : {} });
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
}
// The status of a page asked for at 127.0.0.1, naming `host`.
const statusFor = (port, host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/library', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

const ip = networkAddresses()[0];
const name = os.hostname().toLowerCase();

test('open to the network, its addresses and name there are its own; a rebound domain is not', async (t) => {
  const server = await serve(t, true);
  const { port } = server;
  assert.equal(server.lan, true);
  assert.equal(await statusFor(port, `${name}:${port}`), 200, 'its name');
  assert.equal(await statusFor(port, `${name}.local:${port}`), 200, 'its name on the local network');
  assert.equal(await statusFor(port, `evil.example:${port}`), 421, 'a domain rebound to it');
  assert.equal(await opens('127.0.0.1', port, { origin: `http://${name}:${port}`, host: `${name}:${port}` }), true, 'a page at its name');
  assert.equal(await opens('127.0.0.1', port, { origin: `http://evil.example:${port}`, host: `evil.example:${port}` }), false, 'a page at a rebound domain');
  assert.equal(await opens('127.0.0.1', port, { origin: 'https://elsewhere.example' }), false, 'another site');
  assert.equal(await opens('127.0.0.1', port, { origin: `http://127.0.0.1:${port}` }), true, 'a page on this computer still');
});

test('open to the network, a device there reaches it at this computer\'s address', { skip: !ip && 'this computer is on no network' }, async (t) => {
  const { port } = await serve(t, true);
  const res = await fetch(`http://${ip}:${port}/library`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/i);
  assert.equal(await opens(ip, port, { origin: `http://${ip}:${port}` }), true, 'a page served at that address, without a token');
});

test('closed to the network (the default), it answers on 127.0.0.1 only', async (t) => {
  const server = await serve(t, false);
  const { port } = server;
  assert.equal(server.lan, false);
  assert.equal(await statusFor(port, `${name}:${port}`), 421, 'its name is not its own');
  assert.equal(await opens('127.0.0.1', port, { origin: `http://${name}:${port}`, host: `${name}:${port}` }), false);
  if (ip) {
    assert.equal(await statusFor(port, `${ip}:${port}`), 421, 'nor its network address');
    await assert.rejects(fetch(`http://${ip}:${port}/library`), 'nothing listens there');
  }
});

// pairing.test.mjs — a site uses the desktop library only once the person allowed it: any page can
// find the desktop app (/api/ping), a site asks (/api/pair) and is given its own token, which opens
// library connections from that site only (and from the pages the desktop app serves, which the
// site's helper embeds with its token); the desktop app's own token opens them from its windows
// only. Browsers' checks before reaching a local app are answered.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { startServer } = await import('../server/server.js');

const SITE = 'https://shiori.example', OTHER = 'https://elsewhere.example', APP = 'shiori-app://shiori';
const WINDOW_TOKEN = 'window-token-0123456789abcdef';

async function serve(t, { approve = async () => null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-pair-'));
  const library = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library') }).open();
  const tokens = new Map();
  const asked = [];
  const clients = {
    tokenFor: (origin) => tokens.get(origin) || null,
    siteOf: (token) => [...tokens].find(([, given]) => given === token)?.[0] || null,
    approve: async (origin) => { asked.push(origin); const token = await approve(origin); if (token) tokens.set(origin, token); return token; },
  };
  const server = await startServer({ library, token: WINDOW_TOKEN, origins: [APP], clients });
  t.after(async () => { await server.close(); library.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { server, asked, tokens };
}

// Whether a library connection opens, for `origin` presenting `key`.
function opens(server, key, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?k=${encodeURIComponent(key)}`, origin ? { origin } : {});
    ws.on('open', () => { ws.close(); resolve(true); });
    ws.on('error', () => resolve(false));
  });
}

test('any page can find the desktop app, and a browser\'s check before reaching it is answered', async (t) => {
  const { server } = await serve(t);
  const ping = await fetch(`${server.url}/api/ping`, { headers: { Origin: OTHER } });
  assert.equal((await ping.json()).app, 'shiori-desktop');
  assert.equal(ping.headers.get('access-control-allow-origin'), OTHER);
  const preflight = await fetch(`${server.url}/api/pair`, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
});

test('a site is given its own token once the person allows it, and only then', async (t) => {
  let answer = null;
  const { server, asked } = await serve(t, { approve: async () => answer });
  const pair = (origin) => fetch(`${server.url}/api/pair`, { method: 'POST', headers: { Origin: origin } });
  assert.equal((await pair(SITE)).status, 403, 'not allowed');
  answer = 'site-token-0123456789abcdef';
  const res = await pair(SITE);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  assert.equal((await res.json()).token, answer);
  answer = 'a-different-token-0123456789';
  assert.equal((await (await pair(SITE)).json()).token, 'site-token-0123456789abcdef', 'asked again, it keeps its token');
  assert.deepEqual(asked, [SITE, SITE], 'the person was asked twice, not a third time');
  assert.equal((await fetch(`${server.url}/api/pair`, { method: 'POST' })).status, 403, 'a request no browser sent says no site');
  assert.equal((await pair(APP)).status, 403, 'the app\'s own windows need no pairing');
});

test('a token opens library connections from its own site only', async (t) => {
  const siteToken = 'site-token-0123456789abcdef';
  const { server } = await serve(t, { approve: async () => siteToken });
  await fetch(`${server.url}/api/pair`, { method: 'POST', headers: { Origin: SITE } });
  assert.equal(await opens(server, siteToken, SITE), true, 'the site, with its token');
  assert.equal(await opens(server, siteToken, OTHER), false, 'another site, with that token');
  assert.equal(await opens(server, WINDOW_TOKEN, SITE), false, 'the site, with the window\'s token');
  assert.equal(await opens(server, '', OTHER), false, 'no token');
  assert.equal(await opens(server, WINDOW_TOKEN, APP), true, 'the app\'s window');
  assert.equal(await opens(server, WINDOW_TOKEN, null), true, 'a client with no page');
});

test('a site disconnected in the desktop app is cut off at once, still finds the app, and must be allowed again', async (t) => {
  let answer = 'site-token-0123456789abcdef';
  const { server, asked, tokens } = await serve(t, { approve: async () => answer });
  await fetch(`${server.url}/api/pair`, { method: 'POST', headers: { Origin: SITE } });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?k=${encodeURIComponent(answer)}`, { origin: SITE });
  await new Promise((resolve) => ws.on('open', resolve));
  const closed = new Promise((resolve) => ws.on('close', resolve));
  tokens.delete(SITE);   // what the desktop app's "Disconnect" forgets
  server.dropSite(SITE);
  await closed;
  assert.equal((await (await fetch(`${server.url}/api/ping`, { headers: { Origin: SITE } })).json()).app, 'shiori-desktop', 'the app still answers');
  assert.equal(await opens(server, 'site-token-0123456789abcdef', SITE), false, 'its old token no longer opens the library');
  answer = 'new-site-token-0123456789abcd';
  assert.equal((await (await fetch(`${server.url}/api/pair`, { method: 'POST', headers: { Origin: SITE } })).json()).token, answer);
  assert.deepEqual(asked, [SITE, SITE], 'the person was asked again');
  assert.equal(await opens(server, answer, SITE), true);
});

test('a page served by the desktop app opens the library with a site\'s token, and goes when the site is disconnected', async (t) => {
  const siteToken = 'site-token-0123456789abcdef';
  const { server, tokens } = await serve(t, { approve: async () => siteToken });
  const served = `http://127.0.0.1:${server.port}`;
  assert.equal(await opens(server, siteToken, served), false, 'not before the site was allowed');
  await fetch(`${server.url}/api/pair`, { method: 'POST', headers: { Origin: SITE } });
  assert.equal(await opens(server, siteToken, served), true, 'a page served here, with the site\'s token');
  assert.equal(await opens(server, siteToken, `http://localhost:${server.port}`), true, 'at its other name too');
  assert.equal(await opens(server, 'not-a-token-0123456789abcdef', served), false, 'with no token given to any site');
  assert.equal(await opens(server, siteToken, 'http://127.0.0.1:1'), false, 'a page on another local port');
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?k=${encodeURIComponent(siteToken)}`, { origin: served });
  await new Promise((resolve) => ws.on('open', resolve));
  const closed = new Promise((resolve) => ws.on('close', resolve));
  tokens.delete(SITE);
  server.dropSite(SITE);
  await closed;
  assert.equal(await opens(server, siteToken, served), false, 'and not after');
});

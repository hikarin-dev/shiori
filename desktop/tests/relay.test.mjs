// relay.test.mjs — the windows of one desktop library reach each other through it whatever their
// origin and browser (the desktop app's window, a site's tabs, a page the desktop app serves, a
// browser tab at its address): what one relays (job status, control signals) reaches the pages of
// other scopes, not those of its own (the same origin in the same browser has it from the sender
// already), and nothing but those two kinds is relayed. Who may connect: a page served here without
// a token; every other page with the token it was given; nothing naming another host.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { startServer } = await import('../server/server.js');
const { wire } = await import('../server/shared.js');

const SITE = 'https://shiori.example', APP = 'shiori-app://shiori';
const WINDOW_TOKEN = 'window-token-0123456789abcdef', SITE_TOKEN = 'site-token-0123456789abcdef';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-relay-'));
const library = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library') }).open();
const clients = { tokenFor: (o) => (o === SITE ? SITE_TOKEN : null), siteOf: (k) => (k === SITE_TOKEN ? SITE : null), approve: async () => null };
const server = await startServer({ library, token: WINDOW_TOKEN, origins: [APP], clients });
test.after(async () => { await server.close(); library.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// A window: its connection (`query` its address's), and what reaches it unasked.
const connect = (origin, key) => connectWith(origin, `k=${encodeURIComponent(key)}`);
async function connectWith(origin, query, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?${query}`, { origin, headers });
  ws.pushes = [];
  ws.replies = new Map();
  ws.on('message', (data) => {
    const msg = wire.decode(data);
    if (msg.push) ws.pushes.push(msg);
    else ws.replies.get(msg.id)?.(msg);
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return ws;
}
let seq = 0;
async function call(ws, op, ...args) {
  const id = ++seq;
  const reply = new Promise((resolve) => ws.replies.set(id, resolve));
  ws.send(await wire.encode({ id, op, args }));
  return reply;
}
const settle = () => new Promise((r) => setTimeout(r, 100));

test('what a window relays reaches the library\'s windows on other origins only', async () => {
  const tab = await connect(SITE, SITE_TOKEN);
  const otherTab = await connect(SITE, SITE_TOKEN);
  const desktopWindow = await connect(APP, WINDOW_TOKEN);
  const servedPage = await connect(`http://127.0.0.1:${server.port}`, SITE_TOKEN);
  try {
    const job = { gid: '1790400000000', kind: 'download', status: 'progress', done: 2, total: 5 };
    assert.equal((await call(servedPage, 'relay', 'jobs', job)).ok, true);
    await settle();
    for (const ws of [tab, otherTab, desktopWindow]) assert.deepEqual(ws.pushes, [{ push: 'jobs', msg: job }]);
    assert.deepEqual(servedPage.pushes, [], 'not back to the sender');

    const signal = { type: 'COVER_INVALIDATED', galleryId: '1790400000000' };
    assert.equal((await call(tab, 'relay', 'control', signal)).ok, true);
    await settle();
    assert.deepEqual(otherTab.pushes.slice(1), [], 'a tab of the same site has it from the sender already');
    assert.deepEqual(desktopWindow.pushes.at(-1), { push: 'control', msg: signal });
    assert.deepEqual(servedPage.pushes.at(-1), { push: 'control', msg: signal });

    const refused = await call(tab, 'relay', 'feed', { gid: '1' });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'invalid');
    assert.equal((await call(tab, 'relay', 'jobs', 'not an object')).ok, false);
  } finally {
    for (const ws of [tab, otherTab, desktopWindow, servedPage]) ws.close();
  }
});

test('a page served here connects without a token; any other page, or one naming another host, can\'t', async () => {
  const here = `http://127.0.0.1:${server.port}`;
  const page = await connectWith(here, 's=a-browser');
  try { assert.equal((await call(page, 'galleriesCount')).ok, true, 'a browser tab at the desktop app\'s address'); } finally { page.close(); }
  (await connectWith(`http://localhost:${server.port}`, '')).close();
  await assert.rejects(connectWith(SITE, 's=x'), 'a site without its token');
  await assert.rejects(connectWith('https://elsewhere.example', ''), 'any other site');
  await assert.rejects(connectWith(here, 'k=not-a-token'), 'a page served here with a wrong token');
  await assert.rejects(connectWith(`http://evil.example:${server.port}`, '', { host: `evil.example:${server.port}` }), 'a domain rebound to this address');
});

test('the desktop app\'s window and a browser tab at its address share an origin, not a scope: each hears the other', async () => {
  const here = `http://127.0.0.1:${server.port}`;
  const desktopWindow = await connectWith(here, `k=${WINDOW_TOKEN}&s=the-window`);
  const tab = await connectWith(here, 's=a-browser');
  const otherTab = await connectWith(here, 's=a-browser');
  try {
    const job = { gid: '1790400000001', kind: 'download', status: 'progress', done: 1, total: 3 };
    assert.equal((await call(tab, 'relay', 'jobs', job)).ok, true);
    await settle();
    assert.deepEqual(desktopWindow.pushes, [{ push: 'jobs', msg: job }], 'the window, in another browser, hears it');
    assert.deepEqual(otherTab.pushes, [], 'a tab in the same browser has it from the sender already');
    const signal = { type: 'COVER_INVALIDATED', galleryId: '1790400000001' };
    assert.equal((await call(desktopWindow, 'relay', 'control', signal)).ok, true);
    await settle();
    assert.deepEqual([tab.pushes, otherTab.pushes].map(p => p.at(-1)), [{ push: 'control', msg: signal }, { push: 'control', msg: signal }]);
  } finally {
    for (const ws of [desktopWindow, tab, otherTab]) ws.close();
  }
});

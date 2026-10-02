// relay.test.mjs — the windows of one desktop library reach each other through it whatever their
// origin (the desktop app's window, a site's tabs, a page the desktop app serves): what one relays
// (job status, control signals) reaches the windows on other origins, not those on its own (they
// have it from the sender already), and nothing but those two kinds is relayed.
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

// A window: its connection, and what reaches it unasked.
async function connect(origin, key) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?k=${encodeURIComponent(key)}`, { origin });
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

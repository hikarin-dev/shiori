// jobs.test.mjs — a page of the library (the desktop app's window, or a site's tab keeping its library
// here) hands a job to the app itself (runJob/stopJob), which runs it in its runner: only the kinds
// the app runs (a translation, and collecting what the translation server has done), and only when
// the app takes jobs at all.
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
const clients = { tokenFor: (o) => (o === SITE ? SITE_TOKEN : null), siteOf: (k) => (k === SITE_TOKEN ? SITE : null), approve: async () => null };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-jobs-'));
const library = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library') }).open();
const handed = [];
const jobs = {
  run: async (kind, payload) => { handed.push(['run', kind, payload]); return { ok: true }; },
  stop: async (kind, payload) => { handed.push(['stop', kind, payload]); return { ok: true }; },
};
const server = await startServer({ library, token: WINDOW_TOKEN, origins: [APP], clients, jobs });
const bare = await startServer({ library, token: WINDOW_TOKEN, origins: [APP], clients });
test.after(async () => { await server.close(); await bare.close(); library.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function connect(port, origin, key) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?k=${encodeURIComponent(key)}`, { origin });
  ws.replies = new Map();
  ws.on('message', (data) => { const msg = wire.decode(data); if (!msg.push) ws.replies.get(msg.id)?.(msg); });
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

test('a site\'s tab and the app\'s window hand a translation to the app, and stop it there', async () => {
  const tab = await connect(server.port, SITE, SITE_TOKEN);
  const window = await connect(server.port, APP, WINDOW_TOKEN);
  try {
    const payload = { galleryId: '1790800000001', settings: { serverUrl: 'http://127.0.0.1:5003' } };
    assert.deepEqual(await call(tab, 'runJob', 'translate', payload), { id: seq, ok: true, result: { ok: true } });
    assert.equal((await call(window, 'runJob', 'poll', {})).ok, true);
    assert.equal((await call(tab, 'stopJob', 'translate', { galleryId: '1790800000001' })).ok, true);
    assert.deepEqual(handed, [['run', 'translate', payload], ['run', 'poll', {}], ['stop', 'translate', { galleryId: '1790800000001' }]]);
  } finally { tab.close(); window.close(); }
});

test('nothing else is run, and an app that takes no jobs refuses them', async () => {
  const tab = await connect(server.port, SITE, SITE_TOKEN);
  const other = await connect(bare.port, SITE, SITE_TOKEN);
  try {
    const before = handed.length;
    for (const [kind, payload] of [['download', { galleryId: '1' }], ['upload', { galleryId: '1' }], ['translate', null]]) {
      const reply = await call(tab, 'runJob', kind, payload);
      assert.equal(reply.ok, false, `${kind} refused`);
      assert.equal(reply.error.code, 'invalid');
    }
    assert.equal(handed.length, before);
    assert.equal((await call(other, 'runJob', 'translate', { galleryId: '1' })).ok, false);
  } finally { tab.close(); other.close(); }
});

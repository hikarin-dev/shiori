// sw-install-check.test.mjs — the built worker takes from the server only this release's copy of each
// file it keeps. Its install fetches every file past the browser's cache and checks its bytes against
// the hash its list names: one other copy (a host's edge can hand out an older one for minutes after a
// release) fails the install whole, so the worker before it stays in charge and the browser tries again.
// And once installed, its cache never takes another copy: a check that finds one on the server asks the
// browser to look for the new worker instead, and a file fetched on first use is kept only as this
// release has it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import 'fake-indexeddb/auto';
import { builtSite } from '../../build/built.mjs';

globalThis.BroadcastChannel = class { constructor() { this.onmessage = null; } postMessage() {} close() {} };
Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: () => new Promise(() => {}) } }, configurable: true });
// Each copy of the worker carries the app's write meter (disk-writes.js), which wraps IndexedDB's
// writes to count them. A browser's global has one copy; in this one they would count each other's
// bookkeeping without end, so the writes are left unwrapped.
const { put, add } = IDBObjectStore.prototype;

// The built site (asking for it throws, saying so, when there is none or a source changed since).
const site = builtSite();
const siteUrl = pathToFileURL(site + '/').href;
const { SHELL, HASHES } = await import(new URL('shell-files.js', siteUrl).href);
const isCode = (u) => /\.(m?js|html|css|webmanifest)$/.test(u);
const onFirstUse = (u) => u.startsWith('vendor/pdfjs/') || u === 'vendor/marked.min.js';
const BOOT = SHELL.filter((u) => isCode(u) && !onFirstUse(u));
const ORIGIN = 'https://example.test';

// Caches in memory, keyed by URL.
function memoryCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) {
      const m = new Map();
      stores.set(name, {
        async put(req, res) { m.set(typeof req === 'string' ? req : req.url, res.clone()); },
        async match(req) { return m.get(typeof req === 'string' ? req : req.url)?.clone(); },
        async keys() { return [...m.keys()].map((url) => ({ url })); },
        m,
      });
    }
    return stores.get(name);
  };
  return { open, keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n), stores };
}

// The server: each file of the built site, but for `other`, answered with other bytes. Records each
// request's URL and cache mode.
function server(other = {}) {
  const asked = [];
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    asked.push({ url, cache: init.cache ?? input.cache });
    const path = new URL(url).pathname.slice(1);
    let body;
    try { body = Object.hasOwn(other, path) ? other[path] : readFileSync(join(site, path)); } catch { return new Response('', { status: 404 }); }
    const res = new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  };
  return { fetch, asked };
}

// The built sw.js in a worker scope of its own: its listeners, and what it asked the registration for.
let instance = 0;
async function worker(fetch) {
  const listeners = {};
  const updates = [];
  globalThis.caches = memoryCaches();
  globalThis.fetch = fetch;
  globalThis.self = {
    location: { href: `${ORIGIN}/sw.js`, origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    clients: { claim: async () => {} },
    skipWaiting() {},
    registration: { update: async () => { updates.push(Date.now()); }, active: null, waiting: null },
  };
  await import(`${new URL('sw.js', siteUrl).href}?check-${++instance}`);
  Object.assign(IDBObjectStore.prototype, { put, add });
  return { listeners, updates, caches: globalThis.caches };
}
const install = (sw) => new Promise((resolve, reject) => {
  sw.listeners.install({ waitUntil: (p) => p.then(resolve, reject) });
});
const shellCache = async (sw) => sw.caches.open((await sw.caches.keys()).find((k) => k.includes('-shell-v')));

test('the install takes every file it installs past the browser\'s cache, each as the list names it', async () => {
  const { fetch, asked } = server();
  const sw = await worker(fetch);
  await install(sw);
  const cache = await shellCache(sw);
  assert.deepEqual([...cache.m.keys()].map((u) => new URL(u).pathname.slice(1)).sort(), BOOT.toSorted());
  assert.ok(asked.length >= BOOT.length && asked.every((a) => a.cache === 'no-store'), 'past the browser\'s cache');
});

test('one file that isn\'t this release\'s copy fails the install whole', async () => {
  // A module a page runs, as a host's edge still had it from the release before.
  const stale = BOOT.find((u) => u === 'app/js/format.js');
  assert.ok(stale);
  const sw = await worker(server({ [stale]: '// the release before\n' }).fetch);
  await assert.rejects(install(sw), /app\/js\/format\.js: not this release's copy/);
});

test('a file the server no longer has fails the install whole', async () => {
  const sw = await worker(async (input, init) => {
    if (String(input).endsWith('/index.html')) return Object.defineProperty(new Response('', { status: 404 }), 'type', { value: 'basic' });
    return server().fetch(input, init);
  });
  await assert.rejects(install(sw), /index\.html: 404/);
});

test('once installed, the cache never takes another copy: the browser is asked to look for the new worker', async () => {
  const srv = server();
  const sw = await worker(srv.fetch);
  await install(sw);
  const cache = await shellCache(sw);
  const key = `${ORIGIN}/app/js/format.js`;
  const before = await (await cache.match(key)).text();
  // The next release is on the server: a page's request is answered from the cache, and the check
  // that follows finds another copy.
  globalThis.fetch = server({ 'app/js/format.js': '// the next release\n' }).fetch;
  const waited = [];
  let answer;
  sw.listeners.fetch({ request: { method: 'GET', url: key, mode: 'cors', cache: 'default' }, respondWith: (p) => { answer = p; }, waitUntil: (p) => waited.push(p) });
  assert.equal(await (await answer).text(), before, 'answered with this release\'s copy');
  await Promise.all(waited);
  assert.equal(await (await cache.match(key)).text(), before, 'the cache keeps it');
  assert.equal(sw.updates.length, 1, 'the browser was asked to look for the worker');
});

test('a file fetched on first use is kept only as this release has it', async () => {
  const font = SHELL.find((u) => u.endsWith('.woff2'));
  assert.ok(font && !BOOT.includes(font) && HASHES[font], 'a file of the idle tier, with its hash');
  for (const [body, kept] of [['not the font', false], [readFileSync(join(site, font)), true]]) {
    const sw = await worker(server().fetch);
    await install(sw);
    globalThis.fetch = server({ [font]: body }).fetch;
    const waited = [];
    let answer;
    sw.listeners.fetch({ request: { method: 'GET', url: `${ORIGIN}/${font}`, mode: 'cors', cache: 'default' }, respondWith: (p) => { answer = p; }, waitUntil: (p) => waited.push(p) });
    await answer;
    await Promise.all(waited);
    assert.equal(!!await (await shellCache(sw)).match(`${ORIGIN}/${font}`), kept, kept ? 'this release\'s copy is kept' : 'another copy is answered, not kept');
  }
});

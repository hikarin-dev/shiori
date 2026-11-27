// sw-install-check.test.mjs — the built worker takes from the server only this release's copy of each
// file it keeps. Its install fetches every file past the browser's cache and checks its bytes against
// the hash its list names: one other copy (a host's edge can hand out an older one for minutes after a
// release) fails the install whole, so the worker before it stays in charge and the browser tries again.
// What a cache of the release before holds as this release has it is copied, not fetched. Once
// installed, a file of the release is answered from the cache without asking the server, and a file
// fetched on first use is kept only as this release has it.
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

// The built sw.js in a worker scope of its own: its listeners, its caches, and each time it asked to
// take over. `before`: the worker in charge (registration.active), or none.
let instance = 0;
async function worker(fetch, { before = null } = {}) {
  const listeners = {};
  const took = [];
  globalThis.caches = memoryCaches();
  globalThis.fetch = fetch;
  globalThis.self = {
    location: { href: `${ORIGIN}/sw.js`, origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    clients: { claim: async () => {} },
    skipWaiting() { took.push(Date.now()); },
    registration: { update: async () => {}, active: before, waiting: null },
  };
  await import(`${new URL('sw.js', siteUrl).href}?check-${++instance}`);
  Object.assign(IDBObjectStore.prototype, { put, add });
  return { listeners, caches: globalThis.caches, took };
}
// The worker in charge as another worker sees it: one of this release's kind answers whether its pages
// can be asked (its own message listener, `answers`); 1.3's has no answer.
const beforeWorker = (answers) => ({ postMessage(data, ports) { if (answers) answers({ data, ports, waitUntil() {} }); } });
const dispatch = (listener, event) => new Promise((resolve, reject) => {
  const waited = [];
  listener({ ...event, waitUntil: (p) => waited.push(p) });
  Promise.all(waited).then(resolve, reject);
});
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

test('once installed, a file of the release is answered from the cache, the server not asked, whatever the request\'s cache mode', async () => {
  const sw = await worker(server().fetch);
  await install(sw);
  const key = `${ORIGIN}/app/js/format.js`;
  const before = await (await (await shellCache(sw)).match(key)).text();
  // The next release is on the server: this worker's pages are still answered with this one, whole.
  const next = server({ 'app/js/format.js': '// the next release\n' });
  globalThis.fetch = next.fetch;
  for (const mode of ['default', 'no-cache', 'reload', 'no-store']) {
    const waited = [];
    let answer;
    sw.listeners.fetch({ request: { method: 'GET', url: key, mode: 'cors', cache: mode }, respondWith: (p) => { answer = p; }, waitUntil: (p) => waited.push(p) });
    assert.equal(await (await answer).text(), before, `${mode}: this release's copy`);
    await Promise.all(waited);
  }
  assert.deepEqual(next.asked, [], 'the server was not asked');
});

test('an update copies what the caches before it hold as this release has it, and fetches only the rest', async () => {
  // The release before: every file of this one, but for a module that changed since; the idle tier's
  // files held too.
  const before = await worker(server().fetch);
  await install(before);
  const older = await shellCache(before);
  for (const u of SHELL.filter((f) => !BOOT.includes(f))) await older.put(`${ORIGIN}/${u}`, new Response(readFileSync(join(site, u))));
  await older.put(`${ORIGIN}/app/js/format.js`, new Response('// the release before\n'));
  // This worker in the same browser, the cache before it under another name.
  const srv = server();
  const sw = await worker(srv.fetch);
  const name = (await before.caches.keys())[0];
  sw.caches.stores.set(name.replace(/-shell-v\d+-/, '-shell-v1-'), before.caches.stores.get(name));
  await install(sw);
  assert.deepEqual(srv.asked.map((a) => new URL(a.url).pathname), ['/app/js/format.js'], 'only the changed file is fetched');
  const cache = await sw.caches.open(name);
  assert.equal(cache.m.size, BOOT.length, 'the install holds the first tier (a worker kept waiting holds no more beside the release in charge)');
  await dispatch(sw.listeners.activate, {});
  assert.equal(cache.m.size, SHELL.length, 'taking over, it copies the idle tier\'s too');
  assert.deepEqual(await sw.caches.keys(), [name], 'and the cache before it goes');
  assert.equal(await (await cache.match(`${ORIGIN}/app/js/format.js`)).text(), readFileSync(join(site, 'app/js/format.js'), 'utf8'), 'the changed file as this release has it');
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

// A release of the one page loads code late, by names another build doesn't have: a worker that took
// over its open pages would answer them with another build's files. So a new worker waits where the
// release in charge says its pages can be asked (they show the notice, and Update tells it to take
// over), and takes over at once where it says nothing (1.3, whose pages learn of a new release when the
// worker changes).
test('a new worker waits where the release in charge has pages that can be asked, and takes over only by their Update', async () => {
  const older = await worker(server().fetch);
  const sw = await worker(server().fetch, { before: beforeWorker((event) => older.listeners.message(event)) });
  await install(sw);
  assert.deepEqual(sw.took, [], 'installed, it waits');
  await dispatch(sw.listeners.message, { data: { __shioriTakeOver: true }, ports: [] });
  assert.deepEqual(sw.took, [], 'a hand-over that is not the person\'s Update (the worker before\'s imports done, a page as it starts) leaves it waiting');
  await dispatch(sw.listeners.message, { data: { __shioriTakeOver: true, by: 'update' }, ports: [] });
  assert.equal(sw.took.length, 1, 'Update: it takes over');
});

test('a new worker takes over at once where the release in charge has no answer (1.3), or there is none', async () => {
  const started = Date.now();
  const after13 = await worker(server().fetch, { before: beforeWorker(null) });
  await install(after13);
  assert.equal(after13.took.length, 1, 'after 1.3: at once, once the question has gone unanswered');
  assert.ok(Date.now() - started >= 2900, 'it waited for an answer first');
  await dispatch(after13.listeners.message, { data: { __shioriTakeOver: true }, ports: [] });
  assert.equal(after13.took.length, 2, 'and 1.3\'s hand-over (its imports done) counts');
  const first = await worker(server().fetch);
  await install(first);
  assert.equal(first.took.length, 1, 'a first install: at once');
});

test('the worker in charge says its pages can be asked', async () => {
  const sw = await worker(server().fetch);
  const answered = await new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => { channel.port1.close(); resolve(e.data); };
    sw.listeners.message({ data: { __shioriPagesAsk: true }, ports: [channel.port2], waitUntil() {} });
  });
  assert.deepEqual(answered, { pagesAsk: true });
});

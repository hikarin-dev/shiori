// sw.js — the app's service worker (module). Two roles:
//   1. App-shell cache — offline + installability.
//   2. Background job runner — durable jobs (upload, translate) submitted by tabs run HERE, so
//      they survive the originating tab closing, and resume after the worker is evicted: jobs
//      are idempotent (import skips stored pages, translate skips done pages) and tracked in a
//      pending list, replayed on the next wake.
//
// Downloads are not run here — they run in the extension-hosted agent (which can fetch
// cross-domain and outlives tabs); their status still broadcasts to every tab via platform.jobs.

import * as platform from './js/platform.js';
import { RUNNERS } from './js/jobs-runner.js';

const CACHE = 'shiori-shell-v12';
const FLAGS = ['BR','CN','DE','ES','FR','GB','ID','IT','JP','KR','NL','PL','PT','RU','TH','TW','UA','US','VN']
  .map((c) => `flags/${c}.svg`);
const SHELL = [
  './', 'library.html', 'reader.html', 'settings.html', 'agent.html',
  'manifest.webmanifest', 'font-init.js',
  'library.css', 'reader.css', 'settings.css',
  'js/platform.js', 'js/db.js', 'js/api.js', 'js/store.js',
  'js/import-cbz.js', 'js/translate.js', 'js/backup.js',
  'js/jobs-runner.js', 'js/submit-job.js', 'js/services.js', 'js/ext-bridge.js', 'js/boot.js',
  'js/i18n.js', 'js/locales.js', 'js/tooltip.js',
  'js/library.js', 'js/reader.js', 'js/settings.js', 'js/agent.js',
  ...FLAGS,
  '../icons/icon16.png', '../icons/icon32.png', '../icons/icon48.png', '../icons/icon128.png',
  '../icons/icon192.png', '../icons/icon512.png', '../icons/shiori-logo.svg',
  '../vendor/marked.min.js', '../CHANGELOG.md',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map((u) => cache.add(new URL(u, self.location.href).href)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
    resumePending();   // replay any jobs a previous worker was evicted mid-flight
  })());
});

// Stale-while-revalidate: the cached copy answers immediately (loads never wait on the dev
// server), and a background fetch refreshes the cache so the NEXT load runs the new code.
// A hard reload (Ctrl+Shift+R → request.cache 'reload'/'no-store') bypasses the cache and goes
// network-first, so fresh code is always one hard reload away when iterating. Cache keys are
// normalized to the pathname so reader.html?g=… reuses the one reader.html entry.
//
// Clean URLs: an extensionless navigation (/app/library) resolves to its page file
// (/app/library.html) — both the cache key and the network fetch — so the address bar never
// needs to show .html once this worker controls the scope.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  let pathname = url.pathname;
  if (req.mode === 'navigate' && !pathname.endsWith('/') && !/\.[^/]+$/.test(pathname)) {
    pathname += '.html';
  }
  const key = url.origin + pathname;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const refresh = async () => {
      const resp = await fetch(pathname === url.pathname ? req : new Request(key + url.search, { cache: req.cache }));
      if (resp && resp.ok && resp.type === 'basic') cache.put(key, resp.clone()).catch(() => {});
      return resp;
    };
    if (req.cache !== 'reload' && req.cache !== 'no-store') {
      const cached = await cache.match(key);
      if (cached) {
        e.waitUntil(refresh().catch(() => {}));
        return cached;
      }
    }
    try {
      const resp = await refresh();
      if (resp) return resp;
    } catch {}
    const cached = await cache.match(key);
    return cached || new Response('', { status: 504 });
  })());
});

// ── Background jobs ──
async function runJob(kind, payload) {
  const run = RUNNERS[kind];
  if (!run) return;
  const key = `${payload.galleryId}:${kind}`;
  await platform.jobsPending.add({ key, kind, payload });
  try { await run(payload); }
  finally { await platform.jobsPending.remove(key); }
}
async function resumePending() {
  for (const e of await platform.jobsPending.all()) runJob(e.kind, e.payload);
}
self.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.__shioriJob) e.waitUntil(runJob(d.kind, d.payload));   // waitUntil keeps the worker alive
});

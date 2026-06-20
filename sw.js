// sw.js — root-scoped service worker. The app's files live under /app/, but its pages are served
// at clean URLs (the library at the scope root, plus /settings and /reader). This worker maps
// those clean navigations to the real app/*.html files, caches the shell for offline, and runs
// the durable background jobs.
//
// It has to live at the repo root: a worker under /app/ can only control /app/*, and GitHub Pages
// can't grant a wider scope via the Service-Worker-Allowed header. Same two roles as before —
// app-shell cache (stale-while-revalidate) + background job runner. (See ARCHITECTURE.md §2.)

import * as platform from './app/js/platform.js';
import { RUNNERS } from './app/js/jobs-runner.js';

const CACHE = 'shiori-shell-v14';
// The scope root: http://localhost:5500/ locally, https://…/shiori/ on GitHub Pages.
const ROOT = new URL('./', self.location.href);
// Clean navigation path (relative to the root) → which app page serves it.
const PAGES = { '': 'library', 'library': 'library', 'settings': 'settings', 'reader': 'reader' };

const FLAGS = ['BR','CN','DE','ES','FR','GB','ID','IT','JP','KR','NL','PL','PT','RU','TH','TW','UA','US','VN']
  .map((c) => `app/flags/${c}.svg`);
const SHELL = [
  'app/library.html', 'app/reader.html', 'app/settings.html', 'app/agent.html',
  'app/manifest.webmanifest', 'app/font-init.js',
  'app/library.css', 'app/reader.css', 'app/settings.css',
  'app/js/platform.js', 'app/js/db.js', 'app/js/api.js', 'app/js/store.js',
  'app/js/import-cbz.js', 'app/js/translate.js', 'app/js/backup.js',
  'app/js/jobs-runner.js', 'app/js/submit-job.js', 'app/js/services.js', 'app/js/ext-bridge.js', 'app/js/boot.js',
  'app/js/i18n.js', 'app/js/locales.js', 'app/js/tooltip.js', 'app/js/titles.js',
  'app/js/library.js', 'app/js/reader.js', 'app/js/settings.js', 'app/js/agent.js',
  ...FLAGS,
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
  'icons/icon192.png', 'icons/icon512.png', 'icons/shiori-logo.svg',
  'vendor/marked.min.js', 'CHANGELOG.md',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map((u) => cache.add(new URL(u, ROOT).href)));
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

// Stale-while-revalidate (cached copy answers instantly; background fetch refreshes; a hard reload
// goes network-first). Clean page navigations (root → library, /settings, /reader) are mapped to
// the real app/*.html file — for both the cache key and the network fetch — so the address bar
// stays clean while the served document (which carries <base href="app/">) loads its assets from
// /app/. Everything else (the /app/* assets, /icons/*, the agent iframe) is cached by pathname.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(ROOT.pathname)) return;

  let key = url.origin + url.pathname;
  let navFile = null;
  if (req.mode === 'navigate') {
    const rel = url.pathname.slice(ROOT.pathname.length).replace(/\/$/, '').replace(/\.html$/, '');
    const page = PAGES[rel];
    if (page) { navFile = new URL(`app/${page}.html`, ROOT).pathname; key = url.origin + navFile; }
  }

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const refresh = async () => {
      const resp = await fetch(navFile ? key + url.search : req, navFile ? { cache: req.cache } : undefined);
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

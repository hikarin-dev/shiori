// sw.js — root-scoped service worker. The app's files live under /app/, but its pages are served
// at clean URLs (the library at the scope root, plus /settings and /reader). This worker maps
// those clean navigations to the real app/*.html files, caches the shell for offline, and runs
// the durable background jobs.
//
// It has to live at the repo root: a worker under /app/ can only control /app/*, and GitHub Pages
// can't grant a wider scope via the Service-Worker-Allowed header. Same two roles as before —
// app-shell cache (stale-while-revalidate) + background job runner. (See ARCHITECTURE.md §2.)

import * as platform from './app/js/platform.js';
import { RUNNERS, cancelJobRun, runPoll } from './app/js/jobs-runner.js';

const CACHE = 'shiori-shell-v40';
// The scope root: http://localhost:5500/ locally, https://…/shiori/ on GitHub Pages.
const ROOT = new URL('./', self.location.href);
// Clean navigation path (relative to the root) → which app page serves it.
const PAGES = { '': 'library', 'library': 'library', 'settings': 'settings', 'reader': 'reader', 'overview': 'overview' };

const FLAGS = ['BR','CN','DE','ES','FR','GB','ID','IT','JP','KR','NL','PL','PT','RU','TH','TW','UA','US','VN']
  .map((c) => `app/flags/${c}.svg`);
const SHELL = [
  'app/library.html', 'app/reader.html', 'app/settings.html', 'app/agent.html', 'app/overview.html',
  'app/manifest.webmanifest', 'app/font-init.js',
  'app/library.css', 'app/reader.css', 'app/settings.css', 'app/overview.css',
  'app/fonts/ccvictoryspeech.ttf', 'app/fonts/KiwiMaru-Regular.ttf', 'app/fonts/YasashisaAntique.otf',
  'app/fonts/LICENSE-Kiwi-Maru-OFL.txt', 'app/fonts/LICENSE-YasashisaAntique-IPA.txt',
  'app/fonts/LICENSE-YasashisaAntique-MPLUS.txt', 'app/fonts/README.md',
  'app/js/platform.js', 'app/js/db.js', 'app/js/api.js', 'app/js/store.js', 'app/js/series.js',
  'app/js/import-cbz.js', 'app/js/translate.js', 'app/js/backup.js',
  'app/js/jobs-runner.js', 'app/js/submit-job.js', 'app/js/services.js', 'app/js/ext-bridge.js', 'app/js/boot.js',
  'app/js/i18n.js', 'app/js/locales.js', 'app/js/tooltip.js', 'app/js/titles.js', 'app/js/format.js',
  'app/js/library.js', 'app/js/reader.js', 'app/js/settings.js', 'app/js/agent.js', 'app/js/overview.js',
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
    await resumePending();   // keep replayed jobs inside activate.waitUntil
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
// Keys of jobs this worker is actively running, so a duplicate submit for one already in flight
// here is a cheap no-op instead of starting it twice.
const _running = new Set();
async function runJob(kind, payload) {
  const run = RUNNERS[kind];
  if (!run) return;
  const key = `${payload.galleryId}:${kind}`;
  // A keep-alive nudge for a job already running here is a no-op — don't re-enter (which would
  // wrongly clear _running / the resume entry in its finally while the real run is still going).
  // Claim the key synchronously (no await before the add) so two near-simultaneous nudges can't
  // both slip past the guard.
  if (_running.has(key)) return;
  _running.add(key);
  try {
    await platform.jobsPending.add({ key, kind, payload });
    await run(payload);
  } finally {
    _running.delete(key);
    const resume = kind === 'translate'
      ? await platform.translateResume.get(String(payload && payload.galleryId))
      : null;
    // Keep a still-uploading claim durable; a later heartbeat can replay it safely by token.
    if (!resume || resume.phase !== 'uploading') await platform.jobsPending.remove(key);
  }
}
async function resumePending() {
  await Promise.all((await platform.jobsPending.all()).map((e) =>
    RUNNERS[e.kind] ? runJob(e.kind, e.payload) : platform.jobsPending.remove(e.key)));
}

// Self-sustaining poll loop. A page kicks it off (__shioriPoll), but it then runs INSIDE the worker
// — polling every few seconds for as long as a translation is in flight — so it doesn't depend on
// a page timer, which Chrome throttles to a crawl (or stops) when its tab is backgrounded. That
// throttling was stopping the heartbeat and getting jobs reaped mid-translation. The loop re-arms
// itself just before Chrome's ~5-min single-event cap so it never dies of old age while work
// remains; it ends on its own once nothing is left to poll (so a closed browser still goes quiet).
const POLL_INTERVAL_MS = 3000;
const POLL_LOOP_MAX_MS = 4 * 60 * 1000;   // hand off to a fresh event before the ~5-min event cap
let _pollLoopActive = false;
async function pollLoop() {
  if (_pollLoopActive) return;             // one loop at a time — extra kicks are no-ops
  _pollLoopActive = true;
  const started = Date.now();
  try {
    while (true) {
      try { await runPoll(); } catch {}
      let records = [];
      try { records = await platform.translateResume.all(); } catch {}
      if (!records || !records.length) return;            // nothing in flight → let the loop (and SW) go idle
      if (Date.now() - started > POLL_LOOP_MAX_MS) {       // re-arm a fresh event so we never hit the 5-min cap
        try { self.registration.active && self.registration.active.postMessage({ __shioriPoll: true }); } catch {}
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  } finally { _pollLoopActive = false; }
}

self.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.__shioriPoll) {
    e.waitUntil((async () => {
      // Resume uploads/imports alongside the heartbeat so a long import cannot starve an
      // already-running server job of polls. The second call catches a job whose resume record
      // did not exist until resumePending started it.
      await Promise.all([resumePending(), pollLoop()]);
      await pollLoop();
    })());
    return;
  }
  if (d && d.__shioriJob) e.waitUntil(runJob(d.kind, d.payload));   // waitUntil keeps the worker alive
  else if (d && d.__shioriJobCancel) {
    // Abort the running job and token-scope its durable cleanup. A delayed cancel for an older
    // token must never delete a replacement job's pending row.
    cancelJobRun(d.kind, d.payload);
    e.waitUntil((async () => {
      const gid = String(d.payload && d.payload.galleryId);
      const key = `${gid}:${d.kind}`;
      if (d.kind !== 'translate' || !d.payload?.token) {
        await platform.jobsPending.remove(key);
        return;
      }
      const removed = await platform.translateResume.remove(gid, d.payload.token);
      const current = removed ? null : await platform.translateResume.get(gid);
      if (removed || !current) await platform.jobsPending.remove(key);
    })());
  }
});

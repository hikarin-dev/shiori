// sw.js — root-scoped service worker. The app's files live under /app/, but its pages are served
// at clean URLs (the library at the scope root, plus /settings and /reader). This worker maps
// those clean navigations to the file that answers each (app/js/pages.js: index.html, the one page),
// caches the shell for offline, and runs the durable background jobs.
//
// It has to live at the repo root: a worker under /app/ can only control /app/*, and GitHub Pages
// can't grant a wider scope via the Service-Worker-Allowed header. Same two roles as before —
// app-shell cache (this release's files, answered from the cache) + background job runner. (See ARCHITECTURE.md §2.)
//
// A site whose library the desktop app keeps registers it as sw.js?library=desktop: then it keeps
// the app's files and nothing else. That site's jobs run in its pages, against the desktop library;
// a worker can't tell which library a site uses (it has no localStorage) and would run them
// against this browser's.

import * as platform from './app/js/platform.js';
import { RUNNERS, cancelJobRun, runPoll } from './app/js/jobs-runner.js';
import { enqueue, busy as importsBusy } from './app/js/import-queue.js';
import { runFolderJob, scanning } from './app/js/folder-scan.js';
import { movedTo, pageFile } from './app/js/pages.js';
// Written by the build (build/shell.mjs): every file of the built site this worker keeps, their id (a
// hash over all of them), and the hash of each file's bytes. The build makes this worker one file,
// with the list and every module it imports inside it (build/shell.mjs, writeWorker).
import { SHELL, SHELL_ID, HASHES } from './shell-files.js';

// The scope root: http://localhost:5500/ locally, https://…/shiori/ on GitHub Pages.
const ROOT = new URL('./', self.location.href);
const FILES_ONLY = new URL(self.location.href).searchParams.get('library') === 'desktop';

// Cache names are deployment-root-scoped (Cache Storage is origin-wide, so a sibling project on
// this origin must keep its caches). The shell revision is deliberately independent from the
// user-facing app version: precached code can change outside a release, and changing this value
// makes the browser install every BOOT asset into a fresh cache.
//
// So does any change to any file of the built site. The rule: a build whose files differ in any
// way is a new worker with its own complete cache, and it installs whole before it takes over, or
// not at all. The build gives the files one id (a hash over each one's path and bytes), which ends
// this cache's name, and builds this worker as one file with the list in it: a browser replaces a
// worker when the worker's own file changed. Its install takes each file from the server, past the
// browser's cache, and only as the bytes the list names (a host's edge can still hand out an older
// copy for minutes after a release): any other copy fails the install whole, the worker before it
// stays in charge, and the browser tries again later. The cache never takes a copy the list doesn't
// name either: what it holds is this release, whole, and so is what a page is answered with.
const CACHE_PREFIX = `shiori${ROOT.pathname.replace(/\//g, '_')}`;
const SHELL_CACHE_REVISION = 69;
const CACHE_NAME = `${CACHE_PREFIX}-shell-v${SHELL_CACHE_REVISION}-${SHELL_ID}`;
function cacheName() {
  return CACHE_NAME;
}
function isStaleShellCache(key, current) {
  return (key.startsWith(`${CACHE_PREFIX}-shell-v`) && key !== current)
    || /^shiori-shell-v\d+$/.test(key);
}

// What must be cached before the worker takes over, versus what can arrive later. The first
// visit waits on this install (index.html holds the loading screen until the worker is ready),
// so only the code the app is built from blocks it — about 3 MB of JS/HTML/CSS. The rest is
// ~11 MB of fonts, flags and icons, nearly all of it two study-mode typefaces most sessions
// never open; making the first paint wait for those is what left visitors on a blank screen.
// Code a page asks for only when it is first used comes later too: the PDF reader (vendor/pdfjs,
// at a PDF's import) and the changelog's renderer (vendor/marked.min.js, with CHANGELOG.md itself,
// in the About dialog).
const isCode = (u) => /\.(m?js|html|css|webmanifest)$/.test(u);
const onFirstUse = (u) => u.startsWith('vendor/pdfjs/') || u === 'vendor/marked.min.js';
const BOOT = SHELL.filter((u) => isCode(u) && !onFirstUse(u));
const DEFERRED = SHELL.filter((u) => !BOOT.includes(u));

// Whether `body` is this release's copy of the file at `u` (a path from the root), by the list.
const hashOf = async (body) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');
const isRelease = async (u, body) => Object.hasOwn(HASHES, u) && await hashOf(body) === HASHES[u];
const pathOf = (href) => new URL(href).pathname.slice(ROOT.pathname.length);

// The file at `u` as this release has it, read from the server past the browser's cache; a throw for
// any other copy, or none.
async function releaseCopy(u) {
  const resp = await fetch(new URL(u, ROOT).href, { cache: 'no-store' });
  if (!resp.ok || resp.type !== 'basic' || resp.redirected) throw new Error(`${u}: ${resp.status}`);
  const body = await resp.arrayBuffer();
  if (!await isRelease(u, body)) throw new Error(`${u}: not this release's copy`);
  return new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
}

// This release's copy of the file at `u` from a cache an earlier worker of this site filled (or an
// earlier try of this one's), its bytes checked as a fetched copy's are; null where none has it.
async function heldCopy(u, held) {
  const href = new URL(u, ROOT).href;
  for (const cache of held) {
    const hit = await cache.match(href);
    if (!hit) continue;
    const body = await hit.arrayBuffer();
    if (await isRelease(u, body)) return new Response(body, { status: hit.status, statusText: hit.statusText, headers: hit.headers });
  }
  return null;
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(await cacheName());
    // A file this release shares with the one before is copied from that one's cache; only what
    // changed is fetched. (Copied now: the caches before go when this worker takes over.)
    const held = await Promise.all((await caches.keys())
      .filter((k) => k.startsWith(`${CACHE_PREFIX}-shell-v`) || /^shiori-shell-v\d+$/.test(k)).map((k) => caches.open(k)));
    // All-or-nothing for code: a partial shell must never replace a healthy one, so a failed
    // fetch, or a copy that isn't this release's, fails the whole install and the old worker + cache
    // stay in place.
    await Promise.all(BOOT.map(async (u) => cache.put(new URL(u, ROOT).href, await heldCopy(u, held) ?? await releaseCopy(u))));
    // The pages of a release that can be asked (the one page's) are never answered by this worker
    // while they run: they load code late, by names another build doesn't have, and would run a mix
    // of two builds. This worker waits, the one before it and its cache staying whole and in charge
    // of every open page and of any tab opened meanwhile; the pages show the update notice, and the
    // person's Update tells it to take over (app-update.js). With every tab closed, the browser lets
    // it take over by itself. 1.3's pages can't be asked (theirs learn of a new release when the
    // worker changes): it takes over at once, as it always did.
    if (await pagesCanAsk()) return;
    // A batch of imports running in the worker this one replaces would end with it: then this one
    // waits, and takes over once that worker's imports are done (__shioriTakeOver).
    if (!await platform.jobs.workerImporting()) self.skipWaiting();
  })());
});

// Whether the pages of the release in charge can be asked to update. Asked of that release's worker
// itself, which is the only thing that can answer for it (a cache's name or contents can be left by
// other code: 1.3's worker keeps on demand whatever a page asks it for); 1.3's has no answer, and no
// answer within ASK_MS is a release that can't. No worker in charge: none to ask.
const ASK_MS = 3000;
function pagesCanAsk() {
  const before = self.registration.active;
  if (!before) return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const answer = (asks) => { clearTimeout(timer); channel.port1.close(); resolve(asks); };
    const timer = setTimeout(() => answer(false), ASK_MS);
    channel.port1.onmessage = (e) => answer(e.data?.pagesAsk === true);
    before.postMessage({ __shioriPagesAsk: true }, [channel.port2]);
  });
}

// Pull in the deferred assets once the app is up and idle (boot-core.js asks for this from its
// maintenance window). Anything still missing when it is first needed is cached on demand by
// the fetch handler below, so offline completeness fills in either way — this just gets there
// without a user waiting on it. Already-cached entries are skipped, making re-runs cheap. (Asked of a
// worker still taking over, it waits for that: taking over copies what a cache before it holds.)
async function warmDeferredShell() {
  const me = self.serviceWorker;
  if (me && me.state !== 'activated') {
    await new Promise((resolve) => me.addEventListener('statechange', () => { if (me.state === 'activated' || me.state === 'redundant') resolve(); }));
    if (me.state !== 'activated') return;
  }
  const cache = await caches.open(await cacheName());
  const missing = [];
  for (const u of DEFERRED) if (!(await cache.match(new URL(u, ROOT).href))) missing.push(u);
  if (missing.length) await Promise.allSettled(missing.map(async (u) => cache.put(new URL(u, ROOT).href, await releaseCopy(u))));
}

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const current = await cacheName();
    const keys = await caches.keys();
    // What comes later is copied where a cache before this one holds it (copied now, not at the
    // install: a worker kept waiting holds only its first tier beside the release in charge), and
    // otherwise fetched when the app is idle.
    const cache = await caches.open(current);
    const held = await Promise.all(keys.filter((k) => isStaleShellCache(k, current)).map((k) => caches.open(k)));
    await Promise.all(DEFERRED.map(async (u) => {
      const copy = await heldCopy(u, held).catch(() => null);
      if (copy) await cache.put(new URL(u, ROOT).href, copy);
    }));
    // Delete only OUR prefix (never a sibling app's caches), plus the app's own historical
    // unprefixed name from before cache names were root-scoped.
    await Promise.all(keys
      .filter((k) => isStaleShellCache(k, current))
      .map((k) => caches.delete(k)));
    await self.clients.claim();
    if (!FILES_ONLY) await resumePending();   // keep replayed jobs inside activate.waitUntil
  })());
});

// A file of this release is answered from the cache, without asking the server: its bytes were
// checked as it was stored, and the list is the release. A new release is a new sw.js, which the
// browser looks for itself (at each navigation; app-update.js asks too when a page left open comes
// back to view): its worker installs whole, takes over, and is what tells the pages (app-update.js).
// What the cache doesn't hold goes to the network. Clean page navigations (root → library,
// /settings, /reader) are mapped to the file that answers them (app/js/pages.js) — for both the cache
// key and the network fetch — so
// the address bar stays clean while the served document loads its assets from where they are (a
// page's own file through its <base>, which resolves to the app folder; the one page from the
// root, every address being one segment under it). Everything else (the /app/* assets, /icons/*,
// the bundle, the agent iframe) is cached by pathname.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(ROOT.pathname)) return;
  // Cache keys are pathname-only; a query-carrying non-navigation request is semantically
  // distinct, so it goes straight to the network instead of colliding in the cache.
  if (url.search && req.mode !== 'navigate') return;

  // An old page's file, gone since the one page draws its address: sent on to that address.
  const moved = req.mode === 'navigate' ? movedTo(url.pathname.slice(ROOT.pathname.length)) : null;
  if (moved != null) { e.respondWith(Response.redirect(new URL(moved + url.search, ROOT).href, 301)); return; }

  let key = url.origin + url.pathname;
  let navFile = null;
  if (req.mode === 'navigate') {
    const rel = url.pathname.slice(ROOT.pathname.length).replace(/\/$/, '').replace(/\.html$/, '');
    const file = pageFile(rel);
    if (file) { navFile = new URL(file, ROOT).pathname; key = url.origin + navFile; }
  }

  e.respondWith((async () => {
    const cache = await caches.open(await cacheName());
    const cached = await cache.match(key);
    if (cached) return cached;
    // A file it doesn't hold yet is kept once it is this release's copy (what the idle tier brings,
    // and what only a route not installed draws with).
    try {
      const resp = await fetch(navFile ? key + url.search : req, navFile ? { cache: req.cache } : undefined);
      if (resp.ok && resp.type === 'basic' && !resp.redirected) {
        const copy = resp.clone();
        e.waitUntil(copy.arrayBuffer().then(async (body) => {
          if (await isRelease(pathOf(key), body)) await cache.put(key, new Response(body, { status: copy.status, statusText: copy.statusText, headers: copy.headers }));
        }).catch(() => {}));
      }
      return resp;
    } catch {
      return new Response('', { status: 504 });
    }
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

// ── Imports handed over by a page (submit-job.js handBatchToWorker), and checks of a library
// folder (folder-scan.js startFolderScan) ──
// A batch of titles runs here (import-queue.js), its files read where they are (nothing copied), for
// as long as any app page is open: each page's poll tick (boot-core.js) nudges this worker while an import
// runs, and every nudge holds it awake up to HOLD_MS — longer than a background tab's throttled
// minute between ticks — so it is never idle long enough to be stopped.
const HOLD_MS = 4 * 60 * 1000;
function holdWhileImporting() {
  const until = Date.now() + HOLD_MS;
  return new Promise((resolve) => {
    const check = () => ((!importsBusy() && !scanning()) || Date.now() > until ? resolve() : setTimeout(check, 1000));
    check();
  });
}
// Once nothing is left to import, a newer worker kept waiting (see install) takes over.
function handOverWhenIdle() {
  if (!importsBusy() && !scanning()) self.registration.waiting?.postMessage({ __shioriTakeOver: true });
}

self.addEventListener('message', (e) => {
  const d = e.data;
  // A release before this one whose pages can be asked is replaced only by a page's Update (`by`); any
  // other hand-over (its worker's imports done, a page of 1.3 as it starts) counts where they can't.
  if (d && d.__shioriTakeOver) {
    e.waitUntil((async () => { if (d.by === 'update' || !await pagesCanAsk()) self.skipWaiting(); })());
    return;
  }
  // This release's pages can be asked to update (pagesCanAsk, from the worker after it).
  if (d && d.__shioriPagesAsk) { e.ports[0]?.postMessage({ pagesAsk: true }); return; }
  if (d && d.__shioriWarmShell) { e.waitUntil(warmDeferredShell().catch(() => {})); return; }
  // Updating: a page asks for its files to be brought up to date before it reloads (answered on the
  // port). They are: the cache is this release, whole.
  if (d && d.__shioriRefreshShell) { e.ports[0]?.postMessage({ changed: 0 }); return; }
  // (A page left open asks the browser itself to look for a newer worker now and then; the
  // __shioriCheckShell it sends this one too, from before, has nothing left to do here.)
  if (d && d.__shioriCheckShell) return;
  if (FILES_ONLY) return;
  if (d && d.__shioriPoll) {
    e.waitUntil((async () => {
      // Resume uploads/imports alongside the heartbeat so a long import cannot starve an
      // already-running server job of polls. The second call catches a job whose resume record
      // did not exist until resumePending started it. An import batch running here is held awake.
      await Promise.all([resumePending(), pollLoop(), holdWhileImporting()]);
      await pollLoop();
    })());
    return;
  }
  if (d && d.__shioriImportBatch && d.batch?.groups?.length) {
    e.ports[0]?.postMessage({ taken: true });
    const done = enqueue({ type: 'batch', id: String(d.batch.id), batch: d.batch }).then(handOverWhenIdle);
    e.waitUntil(Promise.race([done, holdWhileImporting()]));
    return;
  }
  if (d && d.__shioriFolderJob && d.folder && ['scan', 'remove'].includes(d.kind)) {
    e.ports[0]?.postMessage({ taken: true });
    const opts = { name: String(d.opts?.name || ''), restored: Number(d.opts?.restored) || 0, moving: !!d.opts?.moving };
    const done = runFolderJob(d.kind, String(d.folder), opts).catch(() => {}).then(handOverWhenIdle);
    e.waitUntil(Promise.race([done, holdWhileImporting()]));
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

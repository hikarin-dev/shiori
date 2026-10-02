// boot.js — shared page bootstrap, imported first by every app page (not by the agent).
// Registers the in-tab services and the PWA service worker, and clears out any service worker
// a previous Shiori layout registered at the site root.

import * as platform from './platform.js';
import { capabilities } from './api.js';
import { services } from './services.js';
import { pollActiveTranslations } from './submit-job.js';
import { applyTranslations } from './i18n.js';
import './app-update.js';

// We reached an app page, so it booted — clear the hard-reload recovery flag that index.html /
// 404.html set to bounce the navigation through the service worker (see those files). Left set, the
// next hard reload would assume the worker had failed and skip the recovery.
try { sessionStorage.removeItem('shiori-sw-retry'); } catch {}

// Localize the page's static markup as early as possible (this module is imported first by
// every page, and runs after the DOM is parsed), so non-English users don't see an English flash.
applyTranslations(document);

platform.registerServices(services);

// A library reset performed in another context invalidates every in-memory cache this page
// holds — reload to a clean state (the resetting context handles its own UI).
platform.control.on((msg) => {
  if (msg?.type === 'LIBRARY_RESET' && msg.context !== platform.contextId) location.reload();
});

// Drive any in-flight translation: a translation is a server-owned job, and this polls it for new
// chunks (preferring the service worker) on every page load and on a short timer. Short polls keep
// the worker warm without any single event hitting Chrome's ~5-min cap, so the job survives a
// navigation, a tab close+reopen, and SW recycling — whichever page is open carries it to the end.
// Idle backoff: consecutive no-work ticks stretch the interval (two durable getAlls per tick are
// not free), and any live job signal snaps it back to the fast cadence.
pollActiveTranslations();
let _pollDelay = 3000;
let _pollIdleTicks = 0;
async function _pollTick() {
  let busy = false;
  try { busy = !!await pollActiveTranslations(); } catch {}
  if (busy) { _pollIdleTicks = 0; _pollDelay = 3000; }
  else if (++_pollIdleTicks >= 5) _pollDelay = Math.min(_pollDelay * 2, 30000);
  setTimeout(_pollTick, _pollDelay);
}
setTimeout(_pollTick, _pollDelay);
platform.jobs.subscribe(() => { _pollIdleTicks = 0; _pollDelay = 3000; });

// Clean URLs: pages are real .html files, but the address bar shows /library — the service
// worker maps extensionless navigations back to the page file. Only rewrite when a worker
// controls this page: without one, the .html URL is the only form a refresh can load directly
// (404.html covers hosts that serve it, but a plain static host has nothing else).
if (location.pathname.endsWith('.html') && navigator.serviceWorker?.controller) {
  const seg = location.pathname.split('/').pop().replace(/\.html$/, '');
  history.replaceState(null, '', new URL('../' + seg, document.baseURI).pathname + location.search + location.hash);
}

// One-time maintenance can touch every library record. Let the page finish its initial paint and
// image work before starting it so a large existing library cannot monopolize IndexedDB while the
// user is waiting for the current surface to open.
const maintenanceReady = new Promise((resolve) => {
  const schedule = () => setTimeout(() => {
    if ('requestIdleCallback' in globalThis) requestIdleCallback(resolve, { timeout: 2000 });
    else resolve();
  }, 1000);
  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
});

// Ordered one-time repairs, then the recurring sweeps. Both live in migrations.js — a step
// records completion only after it actually succeeded, so a failed repair retries next boot. They
// repair the library this browser keeps; a library kept by the desktop app looks after itself.
if (capabilities.browserLibrary) maintenanceReady.then(async () => {
  const { runMigrations, runMaintenance } = await import('./migrations.js');
  await runMigrations(undefined, _updateReport());
  await runMaintenance();
  // After an update, once: how pages stored the old way should move to the new storage layout.
  const { offerStorageUpgrade } = await import('./storage-upgrade.js');
  await offerStorageUpgrade().catch(() => {});
});

// One-time library updates show a progress modal, but only while one takes long enough to notice.
function _updateReport() {
  let modal = null, timer = null, last = [0, 0];
  const show = async () => {
    const { showProgress } = await import('./notice.js');
    const { t } = await import('./i18n.js');
    if (!timer) return;
    modal = showProgress({ title: t('maint.title'), body: t('maint.body') });
    modal.update(...last, last[1] ? t('maint.progress', { done: last[0], total: last[1] }) : '');
  };
  return {
    step() { if (!timer && !modal) timer = setTimeout(show, 700); },
    progress(done, total) {
      last = [done, total];
      if (modal) import('./i18n.js').then(({ t }) => modal?.update(done, total, t('maint.progress', { done, total })));
    },
    end() { clearTimeout(timer); timer = null; modal?.close(); modal = null; },
  };
}

// Finish precaching the offline shell now that the page is up. The worker deliberately installs
// with code only, so the first visit isn't held behind ~9 MB of fonts and flags; this fetches
// the remainder once nobody is waiting on it.
maintenanceReady.then(() => {
  navigator.serviceWorker?.ready
    .then((reg) => reg.active?.postMessage({ __shioriWarmShell: true }))
    .catch(() => {});
});

// The desktop app's window is served by the app itself, always there while it runs, and its jobs
// run in the window: it has no worker.
if ('serviceWorker' in navigator && capabilities.browserLibrary) {
  // Retire the previous layout's worker, which was scoped to THIS app's /app/ directory — the
  // app now lives at the site root with a root-scoped worker (registered below; registering at
  // root replaces any stale root worker in place). Exact-scope match only: another app on this
  // origin whose scope merely ends in /app/ must keep its registration.
  const _appDir = new URL('..', import.meta.url).pathname;
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const r of regs) {
      try { if (new URL(r.scope).pathname === _appDir) r.unregister(); } catch {}
    }
  }).catch(() => {});
  navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url), { type: 'module' }).catch(() => {});
}

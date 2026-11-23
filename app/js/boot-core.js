// boot-core.js — what every page of the app starts with, whatever draws it: a page that has a file
// of its own imports it through boot.js, the one page (src/main.tsx) by itself. (Not the agent.)
// Registers the in-tab services and the PWA service worker, and clears out any service worker
// a previous Shiori layout registered at the site root.
//
// Served as the file it is, at this address, and never bundled: it finds the app's folder and the
// worker from its own address (import.meta.url, at the end of this file). Carried inside a bundle it
// would take the bundle's folder for the app's, and unregister the live worker on every page load.

import * as platform from './platform.js';
import './scrollbar.js';
import { capabilities } from './api.js';
import { savedLocation, desktopHosted } from './library-location.js';
import { services } from './services.js';
import { pollActiveTranslations } from './submit-job.js';
import './app-update.js';

// We reached an app page, so it booted — clear the hard-reload recovery flag that index.html /
// 404.html set to bounce the navigation through the service worker (see those files). Left set, the
// next hard reload would assume the worker had failed and skip the recovery.
try { sessionStorage.removeItem('shiori-sw-retry'); } catch {}

platform.registerServices(services);

// A library reset performed in another context invalidates every in-memory cache this page
// holds — reload to a clean state (the resetting context handles its own UI).
platform.control.on((msg) => {
  if (msg?.type === 'LIBRARY_RESET' && msg.context !== platform.contextId) location.reload();
});

// A site that keeps its library in Shiori Desktop, or a browser tab at the app's own address: what
// to do when the app can't be reached.
if (desktopHosted() && !capabilities.desktopWindow) import('./desktop-link.js').then(m => m.initHostedGate()).catch(() => {});
else if (savedLocation() && !capabilities.desktopWindow) import('./desktop-link.js').then(m => m.initDesktopGate()).catch(() => {});

// A browser library keeping galleries in a folder: asking for it while the browser waits for the
// person's permission (once a visit, unless they allowed it on every visit).
if (capabilities.browserLibrary && capabilities.folders) import('./library-folders.js').then(m => m.promptFolderAccess()).catch(() => {});
// The desktop app's window draws the PDFs its library folders hold whose pages wait (a page draws them).
else if (capabilities.desktopWindow) import('./library-folders.js').then(m => m.drawWaitingPdfs()).catch(() => {});

// Drive any in-flight translation: a translation is a server-owned job, and this polls it for new
// chunks (preferring the service worker) on every page load and on a short timer. Short polls keep
// the worker warm without any single event hitting Chrome's ~5-min cap, so the job survives a
// navigation, a tab close+reopen, and SW recycling — whichever page is open carries it to the end.
// The same tick keeps the worker awake while it imports a batch (sw.js holdWhileImporting).
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

// The worker keeps the app's files, so pages open from this browser's cache (offline too), and runs
// the jobs of the library this browser keeps. A site whose library the desktop app keeps runs its
// jobs itself: its worker keeps the files only (sw.js?library=desktop). A page the desktop app
// serves (its window, or a browser tab at its address) has the files at hand: it has no worker, and
// one left from before goes.
if ('serviceWorker' in navigator && (desktopHosted() || capabilities.desktopWindow)) {
  navigator.serviceWorker.getRegistrations().then((regs) => { for (const r of regs) r.unregister(); }).catch(() => {});
} else if ('serviceWorker' in navigator) {
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
  const worker = capabilities.browserLibrary ? '../../sw.js' : '../../sw.js?library=desktop';
  // Its imports are asked for past the browser's HTTP cache, as its own file always is: a host
  // that lets files be kept for a while would otherwise hand a new worker the old list and modules.
  navigator.serviceWorker.register(new URL(worker, import.meta.url), { type: 'module', updateViaCache: 'none' }).catch(() => {});
}

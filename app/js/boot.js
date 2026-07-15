// boot.js — shared page bootstrap, imported first by every app page (not by the agent).
// Registers the in-tab services and the PWA service worker, and clears out any service worker
// a previous Shiori layout registered at the site root.

import * as platform from './platform.js';
import { services } from './services.js';
import { pollActiveTranslations } from './submit-job.js';
import { applyTranslations } from './i18n.js';

// We reached an app page, so it booted — clear the hard-reload recovery flag that index.html /
// 404.html set to bounce the navigation through the service worker (see those files). Left set, the
// next hard reload would assume the worker had failed and skip the recovery.
try { sessionStorage.removeItem('shiori-sw-retry'); } catch {}

// Localize the page's static markup as early as possible (this module is imported first by
// every page, and runs after the DOM is parsed), so non-English users don't see an English flash.
applyTranslations(document);

platform.registerServices(services);

// Drive any in-flight translation: a translation is a server-owned job, and this polls it for new
// chunks (preferring the service worker) on every page load and on a short timer. Short polls keep
// the worker warm without any single event hitting Chrome's ~5-min cap, so the job survives a
// navigation, a tab close+reopen, and SW recycling — whichever page is open carries it to the end.
pollActiveTranslations();
setInterval(pollActiveTranslations, 3000);

// Clean URLs: pages are real .html files, but the address bar shows /app/library — the
// service worker maps extensionless navigations back to the page file (and the dev server /
// 404.html cover the not-yet-controlled cases).
if (location.pathname.endsWith('.html')) {
  history.replaceState(null, '', location.pathname.replace(/\.html$/, '') + location.search + location.hash);
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

// One-time integrity sweep: fix any gallery whose stored count drifted from its actual image
// records (a pre-guard dbPut could double-count on overwrites). Runs once per browser profile.
const countsRepairReady = maintenanceReady.then(() => platform.kv.get(['countsRepaired'])).then(async ({ countsRepaired }) => {
  if (countsRepaired) return;
  try {
    const { repairGalleryCounts } = await import('./db.js');
    const fixed = await repairGalleryCounts();
    if (fixed) console.log(`[shiori] repaired stat records for ${fixed} galleries`);
  } catch {}
  platform.kv.set({ countsRepaired: true });
});

// One-time repair for early metadata-only series members whose incomplete zero-page stat rows
// could remain numerically invalid after their first images arrived.
countsRepairReady.then(() => platform.kv.get(['seriesShellStatsRepaired'])).then(async ({ seriesShellStatsRepaired }) => {
  if (seriesShellStatsRepaired) return;
  try {
    const { repairSeriesShellStats } = await import('./db.js');
    const fixed = await repairSeriesShellStats();
    if (fixed) console.log(`[shiori] repaired stat records for ${fixed} series chapters`);
  } catch {}
  platform.kv.set({ seriesShellStatsRepaired: true });
});

// One-time backfill: copy each gallery's published date (metadata.uploadDate) into its stat record,
// so the new "Published date" sort runs off the galleries index. Runs once per browser profile.
maintenanceReady.then(() => platform.kv.get(['uploadDateBackfilled'])).then(async ({ uploadDateBackfilled }) => {
  if (uploadDateBackfilled) return;
  try {
    const { backfillUploadDates } = await import('./db.js');
    const filled = await backfillUploadDates();
    if (filled) console.log(`[shiori] backfilled uploadDate for ${filled} galleries`);
  } catch {}
  platform.kv.set({ uploadDateBackfilled: true });
});

if ('serviceWorker' in navigator) {
  // Retire the previous layout's worker, which was scoped to /app/ — the app now lives at the
  // site root with a root-scoped worker (registered below; registering at root replaces any stale
  // root worker in place, so only the /app/ one needs clearing).
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const r of regs) {
      try { if (new URL(r.scope).pathname.endsWith('/app/')) r.unregister(); } catch {}
    }
  }).catch(() => {});
  navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url), { type: 'module' }).catch(() => {});
}

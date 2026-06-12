// boot.js — shared page bootstrap, imported first by every app page (not by the agent).
// Registers the in-tab services and the PWA service worker, and clears out any service worker
// a previous Shiori layout registered at the site root.

import * as platform from './platform.js';
import { services } from './services.js';

platform.registerServices(services);

// Clean URLs: pages are real .html files, but the address bar shows /app/library — the
// service worker maps extensionless navigations back to the page file (and the dev server /
// 404.html cover the not-yet-controlled cases).
if (location.pathname.endsWith('.html')) {
  history.replaceState(null, '', location.pathname.replace(/\.html$/, '') + location.search + location.hash);
}

// One-time integrity sweep: fix any gallery whose stored count drifted from its actual image
// records (a pre-guard dbPut could double-count on overwrites). Runs once per browser profile.
platform.kv.get(['countsRepaired']).then(async ({ countsRepaired }) => {
  if (countsRepaired) return;
  try {
    const { repairGalleryCounts } = await import('./db.js');
    const fixed = await repairGalleryCounts();
    if (fixed) console.log(`[shiori] repaired stat records for ${fixed} galleries`);
  } catch {}
  platform.kv.set({ countsRepaired: true });
});

if ('serviceWorker' in navigator) {
  // The v1 layout registered a worker at the origin root; it would shadow this app forever.
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const r of regs) {
      if (r.scope === location.origin + '/') r.unregister().catch(() => {});
    }
  }).catch(() => {});
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { type: 'module' }).catch(() => {});
}

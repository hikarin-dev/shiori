// boot-root.js — the entry page's only job: get the visitor into the library.
//
// The app's pages are real files under /app/, served at clean URLs by the root service worker.
// This file only runs when no worker is serving the navigation: a genuine first visit, a hard
// reload (which bypasses the worker), or a worker that failed. Those two cases want opposite
// things, so they are handled separately:
//
//   Worker already installed (hard reload, returning visitor) — it is active and waiting, so
//   reloading is near-instant and the worker answers as the library with the URL left clean.
//
//   First visit — nothing is installed yet, and installing means fetching the app's whole code
//   shell. Waiting for that is a blank "Loading Shiori…" screen for several seconds, so we skip
//   it entirely and go straight to the real file. boot.js registers the worker from there, so
//   installation still happens, just with the library already on screen instead of a spinner.
//   The address bar shows app/library.html for that one visit; every later visit is served by
//   the worker at the clean URL.
//
// The retry flag (cleared by the app once it boots, in boot.js) stops a worker that cannot take
// over from bouncing the page in a loop.
//
// External rather than inline so the page's CSP is a plain `script-src 'self'`: an inline script
// would have to be pinned by hash, and a hash computed from a CRLF working tree does not match
// the LF a static host serves — the browser then blocks the script and the page never leaves
// "Loading Shiori…". index.html is only ever served at the deployment root, so a relative src
// resolves correctly whether that root is / or /some-project/.
(async () => {
  const RETRY = 'shiori-sw-retry';
  const toLibrary = () => location.replace('app/library.html');

  if (!('serviceWorker' in navigator) || sessionStorage.getItem(RETRY)) return toLibrary();

  let existing = null;
  try { existing = await navigator.serviceWorker.getRegistration(); } catch {}
  if (!existing || !existing.active) return toLibrary();   // first visit: don't wait on install

  sessionStorage.setItem(RETRY, '1');
  try {
    // Bounded even here: a worker stuck activating must not strand the page on the loading text.
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('sw timeout')), 4000)),
    ]);
    location.reload();   // the worker answers this one, as the library, at the clean URL
    return;
  } catch {}
  toLibrary();
})();

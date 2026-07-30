// boot-root.js — the entry page's only job: hand the navigation to the service worker.
//
// The app's pages are real files under /app/, served at clean URLs by the root service worker.
// A hard reload bypasses the worker and a static host serves index.html cold, so we register the
// worker and reload — that reload IS served by the worker (as the library), with the URL left
// clean. The retry flag (cleared by the app once it boots, in boot.js) lets this run on every
// hard reload, while still bailing to the plain file if the worker genuinely can't take over.
//
// External rather than inline so the page's CSP is a plain `script-src 'self'`: an inline script
// would have to be pinned by hash, and a hash computed from a CRLF working tree does not match
// the LF a static host serves — the browser then blocks the script and the page never leaves
// "Loading Shiori…". index.html is only ever served at the deployment root, so a relative src
// resolves correctly whether that root is / or /some-project/.
(async () => {
  const RETRY = 'shiori-sw-retry';
  if ('serviceWorker' in navigator && !sessionStorage.getItem(RETRY)) {
    sessionStorage.setItem(RETRY, '1');
    try {
      await navigator.serviceWorker.register('sw.js', { type: 'module' });
      // Never wait forever: a worker whose install fails (a missing asset, a quota error) never
      // reaches "ready", and an unbounded await would strand this page on the loading text.
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('sw timeout')), 8000)),
      ]);
      location.reload();
      return;
    } catch {}
  }
  location.replace('app/library.html');   // no worker (or it didn't take over) fallback
})();

// boot.js — shared page bootstrap, imported first by every app page that has a file of its own
// (not by the agent). The start-up every page shares is boot-core.js; this adds what a page with
// static markup and an address of its own file needs on top of it.

import './boot-core.js';
import { applyTranslations } from './i18n.js';

// Localize the page's static markup as early as possible (this module is imported first by
// every page, and runs after the DOM is parsed), so non-English users don't see an English flash.
applyTranslations(document);
// The header's page name, a menu of the app's pages (page-nav.js), is the reader's to start and end.

// Clean URLs: pages are real .html files, but the address bar shows /library — the service
// worker maps extensionless navigations back to the page file. Only rewrite when a worker
// controls this page: without one, the .html URL is the only form a refresh can load directly
// (404.html covers hosts that serve it, but a plain static host has nothing else).
if (location.pathname.endsWith('.html') && navigator.serviceWorker?.controller) {
  const seg = location.pathname.split('/').pop().replace(/\.html$/, '');
  history.replaceState(null, '', new URL('../' + seg, document.baseURI).pathname + location.search + location.hash);
}

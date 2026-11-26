// page-nav.js — the header's page name is a quiet menu of the app's pages: pick one to go there. Each
// page's header holds a <select id="pageNav" data-page="…"> with its own page as the one option, so
// the name paints at once; this adds the others. A gallery's overview is offered where there is a
// gallery (its overview, the reader), the reader only in the reader. Started by the reader (the one
// page left with a file of its own; the one page draws its own menu), and ended by its stop.

import { t } from './i18n.js';

const gallery = () => new URLSearchParams(location.search).get('g');
// Each page's address, from the site's root.
const PAGES = [
  { id: 'library', label: 'nav.library', path: () => '' },
  { id: 'overview', label: 'nav.overview', path: () => `overview?g=${encodeURIComponent(gallery())}` },
  { id: 'reader', label: 'nav.reader', path: () => `reader${location.search}` },
  { id: 'settings', label: 'nav.settings', path: () => 'settings' },
  { id: 'tasks', label: 'tasks.title', path: () => 'tasks' },
];
// The site's root, from this file's own address (app/js/page-nav.js), whatever base the page has.
const SITE_ROOT = new URL('../../', import.meta.url);
const load = (path) => { location.href = new URL(path, SITE_ROOT).href; };

// `go(path)` goes to the page picked (a page load by default; a page that draws the reader inside itself
// gives its own way). Returns what ends it again (its listeners), for a page taken away without unloading.
export function initPageNav(go = load) {
  const select = document.getElementById('pageNav');
  if (!select) return () => {};
  const started = new AbortController();
  const { signal } = started;
  const current = select.dataset.page;
  const offered = PAGES.filter(p => p.id === current
    || (p.id === 'overview' ? !!gallery() : p.id !== 'reader'));
  select.replaceChildren(...offered.map(p => {
    const option = new Option(t(p.label), p.id, false, p.id === current);
    option.dataset.i18n = p.label;   // relabelled with the page when the language changes
    return option;
  }));
  select.addEventListener('change', () => {
    const page = PAGES.find(p => p.id === select.value);
    if (page && page.id !== current) go(page.path());
  }, { signal });
  // Back here from the page picked (the back/forward cache keeps the pick): this page again.
  window.addEventListener('pageshow', () => { select.value = current; }, { signal });
  return () => started.abort();
}

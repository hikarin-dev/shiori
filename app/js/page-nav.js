// page-nav.js — the reader's top bar's page name is a quiet menu of the app's pages: pick one to go
// there. The bar holds a <select id="pageNav" data-page="reader"> with the reader as its one option, so
// the name paints at once; this adds the others: a gallery's overview where there is a gallery, the
// library, Settings and Tasks. Started by the reader and ended by its stop (the one page's own header
// draws its own menu, src/components/ui/page-menu.tsx).

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
// `go(path)` goes to the page picked (`path` from the site's root; the reader's own way out, a change of
// route). Returns what ends it again (its listeners), for a page taken away without unloading.
export function initPageNav(go) {
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
  // In the reader's narrow bar (430px wide and under) the menu leaves the bar and its other pages are
  // rows of the "⋯" list (reader.css): a press goes there as a pick does (a modifier key or the middle
  // button, the browser's own way, to the address it shows).
  for (const link of document.querySelectorAll('[data-page-link]')) {
    const page = offered.find(p => p.id === link.dataset.pageLink);
    link.hidden = !page;
    if (!page) continue;
    link.setAttribute('href', `./${page.path()}`);
    link.addEventListener('click', (e) => {
      if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      go(page.path());
    }, { signal });
  }
  return () => started.abort();
}

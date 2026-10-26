// page-nav.js — the header's page name is a quiet menu of the app's pages: pick one to go there. Each
// page's header holds a <select id="pageNav" data-page="…"> with its own page as the one option, so
// the name paints at once; this adds the others. A gallery's overview is offered where there is a
// gallery (its overview, the reader), the reader only in the reader. Started by boot.js on every page.

import { t } from './i18n.js';

const gallery = () => new URLSearchParams(location.search).get('g');
const PAGES = [
  { id: 'library', label: 'nav.library', href: () => '../' },
  { id: 'overview', label: 'nav.overview', href: () => `../overview?g=${encodeURIComponent(gallery())}` },
  { id: 'reader', label: 'nav.reader', href: () => `../reader${location.search}` },
  { id: 'settings', label: 'nav.settings', href: () => '../settings' },
  { id: 'tasks', label: 'tasks.title', href: () => '../tasks' },
];

export function initPageNav() {
  const select = document.getElementById('pageNav');
  if (!select) return;
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
    if (page && page.id !== current) location.href = page.href();
  });
  // Back here from the page picked (the back/forward cache keeps the pick): this page again.
  window.addEventListener('pageshow', () => { select.value = current; });
}

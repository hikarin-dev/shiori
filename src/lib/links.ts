// links.ts — a plain link to an address the one page draws is followed inside the app, without a page
// load, as React's own links are. React's markup uses the router's links; this is for the rest (a
// link in markup the app didn't write as a component, a link in translated text). A link to a page
// that still has a file of its own loads it as always (pages.js decides), and so does anything the
// person asks the browser for: a modifier key, another window, a download.
import { APP_PAGE, pageFile } from '@lib/pages.js';
import { siteRoot } from '../entry';

type Navigate = (to: string) => unknown;

// Whether the one page draws the address `segment` (a path from the site's root, without slashes):
// then it is followed inside the app; any other is a page load.
export const drawnHere = (segment: string) => pageFile(segment) === APP_PAGE;

// Goes to `path` (from the site's root: 'settings', 'overview?g=…', '' for the library): a route
// change for a page the one page draws, a plain navigation for one that still has a file of its own.
export function goTo(navigate: Navigate, path: string) {
  if (drawnHere(path.split(/[?#]/)[0])) navigate(`/${path}`);
  else location.assign(siteRoot + path);
}

export function keepLinksInApp(navigate: Navigate) {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;
    if ((link.target && link.target !== '_self') || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(siteRoot)) return;
    // Another place on this same page: the browser's own way.
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
    const segment = url.pathname.slice(siteRoot.length);
    if (!drawnHere(segment)) return;
    event.preventDefault();
    navigate(`/${segment}${url.search}${url.hash}`);
  });
}

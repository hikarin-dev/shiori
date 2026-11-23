// links.ts — a plain link to an address the one page draws is followed inside the app, without a page
// load, as React's own links are. React's markup uses the router's links; this is for the rest (a
// link in markup the app didn't write as a component, a link in translated text). A link to a page
// that still has a file of its own loads it as always (pages.js decides), and so does anything the
// person asks the browser for: a modifier key, another window, a download.
import { APP_PAGE, pageFile } from '@lib/pages.js';
import { siteRoot } from '../entry';

type Navigate = (to: string) => unknown;

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
    if (pageFile(segment) !== APP_PAGE) return;
    event.preventDefault();
    navigate(`/${segment}${url.search}${url.hash}`);
  });
}

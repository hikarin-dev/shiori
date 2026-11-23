// pages.js — the app's addresses, and the file that answers each.
//
// Every address is one segment under the site's root ('' is the root itself). A page drawn by the
// one page that holds the whole app is answered by index.html; a page that still has a file of its
// own, by that file. Whoever answers an address reads it here: the service worker, the one page's
// entry, the desktop app's server, the dev server and the server the tests and the preview use.
// (404.html cannot import a module: it names the same addresses in a list of its own, and a test
// holds the two equal.)

// The one page.
export const APP_PAGE = 'index.html';

export const PAGES = Object.freeze({
  '': 'app/library.html',
  library: 'app/library.html',
  settings: 'app/settings.html',
  reader: 'app/reader.html',
  overview: 'app/overview.html',
  tasks: 'app/tasks.html',
  components: APP_PAGE,
});

// The file that answers `segment` (a path from the site's root, without slashes), or null where the
// app has no such address.
export const pageFile = (segment) => (Object.hasOwn(PAGES, segment) ? PAGES[segment] : null);

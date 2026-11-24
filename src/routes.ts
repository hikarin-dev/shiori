// routes.ts — the pages the one page draws, by their address: one segment under the site's root, as
// app/js/pages.js names it ('' is the root). Porting a page is: point its address at the one page in
// pages.js, and add it here. Each is drawn by src/routes/<page>.tsx, its own chunk, loaded when first
// shown. (Plain data, no imports: the build reads it too, for what index.html paints and preloads.)
//
//   page    the module that draws it; for the app's own pages also the name the shiori-app meta
//           carries while it shows
//   app     one of the app's own pages (library, overview, reader, settings, tasks): the meta is
//           there while it shows; on any other route there is none
//   header  drawn under the common header, which index.html paints before any script has run
//   form    the common header's form for this page, where it has one of its own (AppHeader's: settings);
//           start.js puts it on <html> before the first paint (html[data-header-form]), as the frame
//           does while the route shows, so the painted header and React's are one
//   installed  its own files (its chunk, and what only it imports) are among those the service worker
//           installs, so it opens with no network; where not, they are fetched when it is first shown
//           and kept from then on, as any file the page asks for is (build/start.mjs, notInstalled)
export type Route = { page: string; app: boolean; header: boolean; installed: boolean; form?: 'settings' };

export const ROUTES: Readonly<Record<string, Route>> = {
  // The comparison page: no page of the app, and its chunk would be a tenth of what installs.
  components: { page: 'components', app: false, header: true, installed: false },
  tasks: { page: 'tasks', app: true, header: true, installed: true },
  // Settings as the one page draws it, beside 1.3's page (/settings) until it takes that address: no
  // page of the app yet (no shiori-app meta), and not installed.
  'settings-next': { page: 'settings', app: false, header: true, installed: false, form: 'settings' },
};

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
//   installed  its own files (its chunk, and what only it imports) are among those the service worker
//           installs, so it opens with no network; where not, they are fetched when it is first shown
//           and kept from then on, as any file the page asks for is (build/start.mjs, notInstalled)
//   sheets  stylesheets of the app's served files it draws with (paths from the site's root), linked
//           before it is first drawn and kept: asked for with its chunk, on a hard load (start.js) and
//           on a change of route (app.tsx)
export type Route = { page: string; app: boolean; header: boolean; installed: boolean; sheets?: readonly string[] };

export const ROUTES: Readonly<Record<string, Route>> = {
  // The library, at the site's root and at /library alike (1.3's page answered both).
  '': { page: 'library', app: true, header: true, installed: true },
  library: { page: 'library', app: true, header: true, installed: true },
  // The comparison page: no page of the app, and its chunk would be a tenth of what installs.
  components: { page: 'components', app: false, header: true, installed: false },
  tasks: { page: 'tasks', app: true, header: true, installed: true },
  settings: { page: 'settings', app: true, header: true, installed: true },
  // A gallery's or a series' overview (?g=): 1.3's page answered it until its switch (2026-11-25).
  overview: { page: 'overview', app: true, header: true, installed: true },
};

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
export type Route = { page: string; app: boolean; header: boolean };

export const ROUTES: Readonly<Record<string, Route>> = {
  components: { page: 'components', app: false, header: true },
};

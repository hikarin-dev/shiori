// start.mjs — start.js, the one page's first script (its source: src/start.js), with what the build
// knows put in: the app's address map, which routes have the common header, and the preload list —
// every module the page will run to draw an address, so they are all asked for at once, before any of
// them runs, instead of in waves as each import is found.
//
// The list, as paths from the site's root:
//   start    for every address the one page draws: the bundle's entry with what it imports when it
//            draws (the start-up, app/js/boot-core.js, and the app's chunk), and everything those
//            import, chunks and served modules alike, and the modules the start-up itself imports at
//            once where a browser keeps the library (START_ALSO)
//   routes   for each route, its chunk and what that imports, and the served stylesheets it draws with
//            (`sheets` in the route table), less what `start` has
//   words    a language's words, which start.js adds to the list for the language the page will show
//            (`languages`, the app's: app/js/languages.js)
// The entry itself is named apart: start.js adds it first, before the list.
import fs from 'node:fs';
import path from 'node:path';
import { APP_PAGE, PAGES } from '../app/js/pages.js';
import { SUPPORTED } from '../app/js/languages.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// What app/js/boot-core.js imports at once, not by a static import, where the library is kept by this
// browser and can hold folders (the common case: every Chromium browser library) and in the desktop
// app's window: the folder-access check. Elsewhere (Firefox, a site whose library the desktop app
// keeps) it is fetched and not run.
export const START_ALSO = ['app/js/library-folders.js'];

// A language's words (app/js/locales/<code>.js), the code for the star: i18n.js loads the person's
// language as it starts, so start.js asks for it with the rest (English comes in `start`, a static import).
export const WORDS = 'app/js/locales/*.js';

// A served module's static imports, as paths from the site's root. (Its own source is ours: plain
// `import … from '…'`, `import '…'` and `export … from '…'` statements; `import(…)` is not one.)
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
export function servedImports(file, root = ROOT) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  return [...source.matchAll(STATIC_IMPORT)].map((m) => m[1]).filter((spec) => spec.startsWith('.'))
    .map((spec) => path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
}

// `files` and everything they import, statically: bundle chunks by the bundle's own record, served
// modules by their source. `chunks`: fileName → { imports } (a served module is named there as an
// address from assets/: '../app/js/x.js').
function closure(files, chunks, root) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const chunk = chunks[file];
    const imports = chunk
      ? chunk.imports.map((id) => (chunks[id] ? id : path.posix.normalize(path.posix.join(path.posix.dirname(file), id))))
      : servedImports(file, root);
    for (const next of imports) visit(next);
  };
  for (const file of files) visit(file);
  return [...seen];
}

// The data start.js is written with, from a built bundle (Rollup's output: fileName → chunk) and the
// route table (src/routes.ts): each route's header and its form, what its shiori-app meta says (the
// app's own pages: the page's name), and its preload list. In the dev server, with no bundle: the map,
// the header and the meta alone.
/** @param {{ bundle?: Record<string, any> | null, routes: Record<string, { page: string, app: boolean, header: boolean, sheets?: readonly string[] }>, root?: string }} options */
export function startData({ bundle = null, routes, root = ROOT }) {
  const data = { appPage: APP_PAGE, pages: PAGES, languages: SUPPORTED, words: WORDS, entry: null, start: [], routes: {} };
  for (const [segment, route] of Object.entries(routes)) {
    data.routes[segment] = { header: route.header, meta: route.app ? route.page : null, preload: [] };
  }
  if (!bundle) return data;

  const chunks = Object.fromEntries(Object.values(bundle).filter((c) => c.type === 'chunk').map((c) => [c.fileName, c]));
  const entries = Object.values(chunks).filter((c) => c.isEntry);
  if (entries.length !== 1) throw new Error(`start.mjs: the bundle should have one entry, not ${entries.length}`);
  const entry = entries[0];
  const resolve = (from, id) => (chunks[id] ? id : path.posix.normalize(path.posix.join(path.posix.dirname(from), id)));
  data.entry = entry.fileName;
  data.start = closure([entry.fileName, ...entry.dynamicImports.map((id) => resolve(entry.fileName, id)), ...START_ALSO], chunks, root)
    .filter((file) => file !== entry.fileName);
  const started = new Set([entry.fileName, ...data.start]);
  // The stylesheets the built page links itself, in its head (the entry's and those of what it imports
  // statically, as the bundler writes them into index.html): asked for by the page already, never again.
  const linked = new Set(closure([entry.fileName], chunks, root).flatMap((file) => [...(chunks[file]?.viteMetadata?.importedCss ?? [])]));

  for (const [segment, route] of Object.entries(routes)) {
    const chunk = routeChunk(chunks, segment, route, root);
    // Its stylesheets: its own chunk's and those of the chunks it shares with other routes (a component
    // two routes draw, its stylesheet with it), and the served ones it names.
    const files = closure([chunk.fileName], chunks, root);
    const styles = [...new Set(files.flatMap((file) => [...(chunks[file]?.viteMetadata?.importedCss ?? [])]))];
    data.routes[segment].preload = [...files, ...styles, ...(route.sheets ?? [])].filter((file) => !started.has(file) && !linked.has(file));
    // What it may ask for later (its parts, each fetched the first time it is used): the bundle's files
    // its chunk reaches by import() and theirs, with their stylesheets.
    const reached = new Set(), queue = [chunk.fileName];
    while (queue.length) {
      const file = queue.pop();
      if (reached.has(file) || !chunks[file]) continue;
      reached.add(file);
      queue.push(...chunks[file].imports, ...chunks[file].dynamicImports.map((id) => resolve(file, id)));
    }
    const later = [...reached].flatMap((file) => [file, ...(chunks[file].viteMetadata?.importedCss ?? [])]);
    data.routes[segment].later = [...new Set(later)].filter((file) => !started.has(file) && !data.routes[segment].preload.includes(file));
  }
  return data;
}

// The chunk that draws a route (src/routes/<page>.tsx), from the bundle's chunks by file name.
export function routeChunk(chunks, segment, route, root = ROOT) {
  const module = path.join(root, 'src', 'routes', `${route.page}.tsx`).split(path.sep).join('/').toLowerCase();
  const chunk = Object.values(chunks).find((c) => c.facadeModuleId?.toLowerCase() === module);
  if (!chunk) throw new Error(`start.mjs: no chunk draws /${segment} (src/routes/${route.page}.tsx)`);
  return chunk;
}

// The bundle's files that only routes the worker doesn't install draw with (`installed` false in the
// route table): what each such route preloads, less what the start-up or an installed route needs
// too, as it draws or later (a part of it fetched on first use: the reader's settings share a chunk
// with the comparison page's specimens). A served module is never among them: those are the app's
// files, kept whoever imports them. From start.js's data, so the built site says it by itself (the
// tests read it there).
/** @param {{ entry: unknown, start: string[], routes: Record<string, { preload: string[], later?: string[] }> }} data @param {Record<string, { installed: boolean }>} routes */
export function notInstalled(data, routes) {
  const needed = new Set([String(data.entry), ...data.start]);
  const left = new Set();
  for (const [segment, route] of Object.entries(routes)) {
    for (const file of data.routes[segment].preload) (route.installed ? needed : left).add(file);
    if (route.installed) for (const file of data.routes[segment].later ?? []) needed.add(file);
  }
  return [...left].filter((file) => file.startsWith('assets/') && !needed.has(file)).sort();
}

// start.js: its source with the data in place of the line that waits for it.
export const START_LINE = '  const START = null;   // written by the build (build/start.mjs)';
export function startScript(data, root = ROOT) {
  const source = fs.readFileSync(path.join(root, 'src', 'start.js'), 'utf8');
  if (!source.includes(START_LINE)) throw new Error('src/start.js has lost the line the build writes its data on');
  return source.replace(START_LINE, `  const START = ${JSON.stringify(data)};`);
}

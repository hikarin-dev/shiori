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
//   routes   for each route, its chunk and what that imports, less what `start` has
// The entry itself is named apart: start.js adds it in every case, the list only when the page draws
// (a page about to hand the visitor on to another file fetches no more than it needs to decide).
import fs from 'node:fs';
import path from 'node:path';
import { APP_PAGE, PAGES } from '../app/js/pages.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// What app/js/boot-core.js imports at once, not by a static import, where the library is kept by this
// browser and can hold folders (the common case: every Chromium browser library) and in the desktop
// app's window: the folder-access check. Elsewhere (Firefox, a site whose library the desktop app
// keeps) it is fetched and not run.
export const START_ALSO = ['app/js/library-folders.js'];

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
// route table (src/routes.ts): each route's header and its form, and its preload list. In the dev server, with no bundle: the map and the header alone.
/** @param {{ bundle?: Record<string, any> | null, routes: Record<string, { page: string, header: boolean, form?: string }>, root?: string }} options */
export function startData({ bundle = null, routes, root = ROOT }) {
  const data = { appPage: APP_PAGE, pages: PAGES, entry: null, start: [], routes: {} };
  for (const [segment, route] of Object.entries(routes)) data.routes[segment] = { header: route.header, form: route.form ?? null, preload: [] };
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

  for (const [segment, route] of Object.entries(routes)) {
    const module = path.join(root, 'src', 'routes', `${route.page}.tsx`).split(path.sep).join('/').toLowerCase();
    const chunk = Object.values(chunks).find((c) => c.facadeModuleId?.toLowerCase() === module);
    if (!chunk) throw new Error(`start.mjs: no chunk draws /${segment} (src/routes/${route.page}.tsx)`);
    const styles = [...(chunk.viteMetadata?.importedCss ?? [])];
    data.routes[segment].preload = [...closure([chunk.fileName], chunks, root), ...styles].filter((file) => !started.has(file));
  }
  return data;
}

// The bundle's files that only routes the worker doesn't install draw with (`installed` false in the
// route table): what each such route preloads, less what the start-up or an installed route needs
// too. A served module is never among them: those are the app's files, kept whoever imports them.
// From start.js's data, so the built site says it by itself (the tests read it there).
/** @param {{ entry: unknown, start: string[], routes: Record<string, { preload: string[] }> }} data @param {Record<string, { installed: boolean }>} routes */
export function notInstalled(data, routes) {
  const needed = new Set([String(data.entry), ...data.start]);
  const left = new Set();
  for (const [segment, route] of Object.entries(routes)) {
    for (const file of data.routes[segment].preload) (route.installed ? needed : left).add(file);
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

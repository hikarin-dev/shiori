// The build's own rules, as Vite plugins.
//
// The app is two halves. The UI (src/) is bundled. Everything else — the library, storage, jobs,
// formats, under app/js/ — is served as the plain files it is, at the addresses it always had,
// because more than the pages load it from there: the service worker, the desktop app's server and
// its calls into pages, the agent and runner pages. Several of those modules hold state (the
// library's connection, the job registry), so a page must run one copy of each: the bundle imports
// them by address and never carries its own.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { APP_PAGE, pageFile } from '../app/js/pages.js';
import { ROUTES } from '../src/routes.ts';
import { writeShell } from './shell.mjs';
import { notInstalled, startData, startScript } from './start.mjs';

export const ROOT = path.resolve(import.meta.dirname, '..');

// Folders whose modules are served as files, never bundled.
const SERVED = ['app/js', 'vendor'].map((dir) => path.join(ROOT, dir) + path.sep);

// Every chunk lands in assets/, one level under the site's root, so a served module is always
// one step up from its importer.
export function servedModules(): Plugin {
  return {
    name: 'shiori:served-modules',
    apply: 'build',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const file = path.normalize(resolved.id.split('?')[0]);
      if (!SERVED.some((dir) => file.startsWith(dir))) return null;
      return { id: '../' + path.relative(ROOT, file).split(path.sep).join('/'), external: true };
    },
  };
}

// The one page's policy, the same as the pages that have a file of their own carry: scripts from
// the site only (and none inline, so no hash to keep), connections open for the translation server
// the person configures and for a library on this computer. Written into the built page alone: the
// dev server's page needs inline scripts for hot reload.
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
  + "font-src 'self'; connect-src 'self' data: blob: http: https: ws://127.0.0.1:*; object-src 'none'; base-uri 'self'";

export function contentSecurityPolicy(): Plugin {
  return {
    name: 'shiori:content-security-policy',
    apply: 'build',
    // Written as text: a tag handed to Vite has its quotes turned into entities.
    transformIndexHtml(html) {
      const at = '<title>';
      if (!html.includes(at)) throw new Error('index.html has no <title> to write the policy before');
      return html.replace(at, `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n  ${at}`);
    },
  };
}

// The one page's first paint. Vite writes the entry into the built page as a module script with its
// imports preloaded; here they come out of the page again, and the page's first script, start.js,
// gets them instead, with the whole preload list (build/start.mjs): it asks for them only when the page
// is the one to draw its address, and asks for every module that drawing runs, at once. The
// stylesheet stays in the page, first in its head, where it holds the first paint until it is there,
// as every page's did.
const ENTRY_TAGS = /\s*<script type="module"[^>]*><\/script>|\s*<link rel="modulepreload"[^>]*>/g;
const STYLESHEET = /\s*<link rel="stylesheet"[^>]*href="\.\/assets\/[^"]+\.css"[^>]*>/;

export function firstPaint(): Plugin {
  return {
    name: 'shiori:first-paint',
    apply: 'build',
    generateBundle(_, bundle) {
      this.emitFile({ type: 'asset', fileName: 'start.js', source: startScript(startData({ bundle, routes: ROUTES })) });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, { chunk }) {
        const entry = chunk?.fileName;
        const tags = html.match(ENTRY_TAGS) ?? [];
        if (!tags.some((tag) => tag.includes(`src="./${entry}"`))) throw new Error(`the built page doesn't load the entry ${entry} as expected`);
        const style = html.match(STYLESHEET)?.[0];
        if (!style) throw new Error('the built page has no stylesheet in its head');
        // The stylesheet before the head's scripts: asked for first, ahead of everything start.js asks
        // for, it is there for the first paint sooner (and the scripts wait for it, as they did on
        // every page).
        return html.replace(ENTRY_TAGS, '').replace(style, '').replace(/\n(\s*)<script /, `\n$1${style.trim()}\n$1<script `);
      },
    },
  };
}

// What the built site carries besides the bundle: the same files, at the same places, each with the
// date it has here (so a host's "changed since?" answer follows the file, not the build).
const COPIED = ['app', 'icons', 'vendor', 'sw.js', '404.html', 'CHANGELOG.md'];
const NOT_COPIED = new Set([path.join(ROOT, 'app', 'tests')]);

// Once the bundle is written: the copies beside it, then what the service worker keeps of it all
// (shell.mjs: shell-files.js, with the id every file counts in, and the same id at the end of the
// built sw.js), less the files only a route it doesn't install draws with.
export function siteFiles(): Plugin {
  let outDir = '';
  let leftOut: string[] = [];
  return {
    name: 'shiori:site-files',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    generateBundle(_, bundle) { leftOut = notInstalled(startData({ bundle, routes: ROUTES }), ROUTES); },
    closeBundle() {
      for (const name of COPIED) {
        fs.cpSync(path.join(ROOT, name), path.join(outDir, name), {
          recursive: true,
          preserveTimestamps: true,
          filter: (src) => !NOT_COPIED.has(src),
        });
      }
      writeShell(outDir, fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), leftOut);
    },
  };
}

// Under the dev server (`npm run dev`): a page that still has a file of its own is sent as that
// file, at its clean address and as it is — Vite's own handling would rewrite it, and its policy
// pins its one inline script by hash. An address the one page answers goes on to Vite as a request
// for index.html, which Vite serves its own way (left to guess, Vite takes an address without an
// extension for a module when asked by anything but a navigation — and finds one: /components is
// also the name of components.json at the root).
//
// And there is no service worker there: it would keep copies of the dev server's modules, and the
// app runs its jobs in the tab when it has none. /sw.js answers with a worker whose install fails:
// a registration made for it alone is dropped with it, and one a built site left at this address
// is taken away (asked for before the install fails, done after it: waited for inside the install
// it would wait for the install). Never installed, not installed-then-removed: a worker that was
// active even for a moment is one the app hands its jobs to.
const NO_WORKER = `// No service worker under the dev server (build/plugins.ts).
self.addEventListener('install', (event) => {
  self.registration.unregister();
  event.waitUntil(Promise.reject(new Error('no service worker under the dev server')));
});
`;

export function devPages(): Plugin {
  return {
    name: 'shiori:dev-pages',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const { pathname, search } = new URL(req.url ?? '/', 'http://dev');
        if (pathname === '/sw.js') {
          res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(NO_WORKER);
          return;
        }
        // The page's first script, with the map and the routes' headers, and nothing to preload or
        // start: the dev server's page starts its entry itself.
        if (pathname === '/start.js') {
          res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' }).end(startScript(startData({ routes: ROUTES })));
          return;
        }
        const file = pageFile(pathname.replace(/^\/+|\/+$/g, ''));
        if (!file) { next(); return; }
        if (file === APP_PAGE) { req.url = `/${APP_PAGE}${search}`; next(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }).end(fs.readFileSync(path.join(ROOT, file)));
      });
    },
  };
}

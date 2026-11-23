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

// What the built site carries besides the bundle: the same files, at the same places, each with the
// date it has here (so a host's "changed since?" answer follows the file, not the build).
const COPIED = ['app', 'icons', 'vendor', 'sw.js', '404.html', 'CHANGELOG.md'];
const NOT_COPIED = new Set([path.join(ROOT, 'app', 'tests')]);

export function copiedFiles(): Plugin {
  let outDir = '';
  return {
    name: 'shiori:copied-files',
    apply: 'build',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    closeBundle() {
      for (const name of COPIED) {
        fs.cpSync(path.join(ROOT, name), path.join(outDir, name), {
          recursive: true,
          preserveTimestamps: true,
          filter: (src) => !NOT_COPIED.has(src),
        });
      }
    },
  };
}

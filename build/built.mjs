// built.mjs — the built site, for whoever takes it instead of the sources: the server the tests and
// the preview use, the tests that read the built layout, the desktop app's staging. Each asks here,
// so each fails the same clear way when there is no build, or when a source changed after it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = path.join(ROOT, 'dist');

// What the build is made from.
const SOURCES = ['app', 'src', 'build', 'icons', 'vendor', 'index.html', 'sw.js', '404.html', 'CHANGELOG.md', 'vite.config.ts'];
const NOT_SOURCES = new Set([path.join(ROOT, 'app', 'tests')]);

// When the newest file at or under `file` was last written.
function newest(file) {
  if (NOT_SOURCES.has(file)) return 0;
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  return fs.readdirSync(file).reduce((latest, name) => Math.max(latest, newest(path.join(file, name))), 0);
}

// The folder of the built site. Throws when it isn't there, or is older than a source. (Looked
// into once per process: whoever asks takes the site as it is then.)
let fresh = false;
export function builtSite() {
  if (fresh) return DIST;
  // The build writes its page anew every time; the files it copies keep their own dates.
  const built = fs.statSync(path.join(DIST, 'index.html'), { throwIfNoEntry: false });
  if (!built) throw new Error('the built site is missing: run `npm run build`');
  if (SOURCES.some((name) => newest(path.join(ROOT, name)) > built.mtimeMs)) {
    throw new Error('the built site is older than the sources: run `npm run build`');
  }
  fresh = true;
  return DIST;
}

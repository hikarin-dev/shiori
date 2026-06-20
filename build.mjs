// build.mjs — produce the GitHub Pages deploy layout in dist/ from the source tree.
//
// The app's pages stay authored under app/ (app/library.html, app/reader.html, app/settings.html,
// base href="app/"). For a static host to serve clean URLs that survive a hard reload — which
// bypasses the service worker — the entry pages need to exist as real files at the clean paths.
// So this build copies them to:
//     app/library.html  -> dist/index.html          (the library at the site root)
//     app/reader.html   -> dist/reader/index.html    (served at /reader/)
//     app/settings.html -> dist/settings/index.html  (served at /settings/)
// rewriting the reader/settings <base> to ../app/ so their assets still resolve to /app/. Everything
// shared (js, css, flags, agent.html, manifest, icons, vendor) is copied unchanged, and the service
// worker is rewritten to cache + key those clean directory paths instead of the app/*.html files.
//
// Run: node build.mjs   (no dependencies; Node 18+). The workflow runs it and deploys dist/.

import { promises as fs } from 'fs';
import path from 'path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const read = (p) => fs.readFile(path.join(ROOT, p), 'utf8');
const write = async (rel, content) => {
  const p = path.join(DIST, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
};

// Replace exactly once; throw if the anchor is missing so a future source edit can't silently
// produce a broken build.
function replaceOnce(s, find, repl, label) {
  if (!s.includes(find)) throw new Error(`build: anchor not found for ${label}`);
  return s.replace(find, repl);
}

// ── Rewrite the service worker for the clean directory-index layout ──
// Source keys navigations by mapping the clean path to an app/*.html file; on the built site those
// pages live at /, /reader/, /settings/, so the worker just precaches and keys them by path. A
// slash-less /reader is normalised to /reader/ so it hits the same entry offline.
function buildSW(sw) {
  sw = replaceOnce(
    sw,
    "  'app/library.html', 'app/reader.html', 'app/settings.html', 'app/agent.html',",
    "  '', 'reader/', 'settings/', 'app/agent.html',",
    'SW shell list',
  );
  const navStart = '  let key = url.origin + url.pathname;';
  const navEnd = '  e.respondWith((async () => {';
  const i = sw.indexOf(navStart);
  const j = sw.indexOf(navEnd);
  if (i < 0 || j < 0) throw new Error('build: anchor not found for SW navigation block');
  const navBlock =
    '  let key = url.origin + url.pathname;\n' +
    '  let navFile = null;\n' +
    '  if (req.mode === \'navigate\') {\n' +
    '    // The host serves the clean directory paths natively; normalise a slash-less /reader to\n' +
    '    // /reader/ so it keys (and fetches) the same entry the precache stored.\n' +
    '    const rel = url.pathname.slice(ROOT.pathname.length);\n' +
    '    if (rel && !rel.includes(\'.\') && !rel.endsWith(\'/\')) { navFile = url.pathname + \'/\'; key = url.origin + navFile; }\n' +
    '  }\n\n';
  return sw.slice(0, i) + navBlock + sw.slice(j);
}

const NOT_FOUND = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Shiori — Not found</title>
  <style>html,body{margin:0;height:100%;background:#111;color:#888;font:14px system-ui,sans-serif;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center}a{color:#ed2754}</style>
</head>
<body>
  <div>Page not found.</div>
  <a href="./">← Back to library</a>
</body>
</html>
`;

async function main() {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  // Shared assets: copy app/ (minus the three entry pages, which become the clean-path index.html
  // files below), plus icons/, vendor/, and the changelog the settings page renders.
  const skip = new Set(['app/library.html', 'app/reader.html', 'app/settings.html']);
  await fs.cp(path.join(ROOT, 'app'), path.join(DIST, 'app'), {
    recursive: true,
    filter: (src) => !skip.has(path.relative(ROOT, src).replace(/\\/g, '/')),
  });
  await fs.cp(path.join(ROOT, 'icons'), path.join(DIST, 'icons'), { recursive: true });
  await fs.cp(path.join(ROOT, 'vendor'), path.join(DIST, 'vendor'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'CHANGELOG.md'), path.join(DIST, 'CHANGELOG.md'));

  // Entry pages at their clean paths. The library sits at the root, so its base href="app/" is
  // unchanged; the reader/settings pages move one level down, so their base points up to ../app/.
  await write('index.html', await read('app/library.html'));
  await write('reader/index.html',
    replaceOnce(await read('app/reader.html'), '<base href="app/">', '<base href="../app/">', 'reader base'));
  await write('settings/index.html',
    replaceOnce(await read('app/settings.html'), '<base href="app/">', '<base href="../app/">', 'settings base'));

  await write('sw.js', buildSW(await read('sw.js')));
  await write('404.html', NOT_FOUND);
  await write('.nojekyll', '');   // serve files/dirs verbatim (no Jekyll processing)

  console.log('build: wrote dist/ (index.html, reader/, settings/, app/, sw.js, 404.html)');
}

main().catch((e) => { console.error(e); process.exit(1); });

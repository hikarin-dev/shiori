// sw-cache-revision.test.mjs — precached code needs its own deployment revision. Product
// versions change only for releases, while agent.html / agent.js can change during ordinary
// fixes; tying the cache name to the manifest leaves an already-running agent on stale bytes.
//
// The rule now: a build whose files differ in any way is a new worker with its own complete cache,
// and it installs whole before it takes over. The build gives the files the worker keeps one id (a
// hash over each one's path and bytes, build/shell.mjs), which the cache's name ends with, and builds
// the worker as one file with the list in it — so any change is a change to the worker's own file,
// which is what makes a browser replace the worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtSite } from '../../build/built.mjs';
import { shellFiles } from '../../build/shell.mjs';
import { notInstalled } from '../../build/start.mjs';
import { ROUTES } from '../../src/routes.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sw = readFileSync(join(repo, 'sw.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(repo, 'app', 'manifest.webmanifest'), 'utf8'));

const revisionMatch = sw.match(/const SHELL_CACHE_REVISION = (\d+);/);
assert.ok(revisionMatch, 'sw.js must declare a numeric shell cache revision');
const revision = Number(revisionMatch[1]);

// What the build wrote for the worker (asking for the built site throws, saying so, when there is
// none or a source changed since: npm run build).
const { SHELL: shell, SHELL_ID: id, HASHES: hashes } = await import(pathToFileURL(join(builtSite(), 'shell-files.js')).href);
// The bundle's files the worker leaves to be fetched when first shown (a route it doesn't install),
// as the built start.js says them.
const leftOut = notInstalled(JSON.parse(readFileSync(join(builtSite(), 'start.js'), 'utf8').match(/const START = (\{.*\});/)[1]), ROUTES);
const kept = (dir) => shellFiles(dir, leftOut);

const helperMatch = sw.match(/function isStaleShellCache\(key, current\) \{[\s\S]*?\n\}/);
assert.ok(helperMatch, 'sw.js must expose its stale-cache predicate for review');
const staleFor = (prefix) => new Function('CACHE_PREFIX',
  `${helperMatch[0]}; return isStaleShellCache;`)(prefix);

test('shell cache naming is root-scoped and independent from the product version', () => {
  assert.match(sw, /const CACHE_NAME = `\$\{CACHE_PREFIX\}-shell-v\$\{SHELL_CACHE_REVISION\}-\$\{SHELL_ID\}`;/);
  assert.doesNotMatch(sw, /m\.version|manifest\.version/,
    'runtime cache naming must not depend on the release-only product version');

  const prefix = 'shiori_shiori_';
  const cache = `${prefix}-shell-v${revision}-${id}`;
  assert.notEqual(cache, `${prefix}-shell-v${manifest.version}`);
});

test('the worker takes its files, their hashes and their id from the build, and keeps no list of its own', () => {
  assert.match(sw, /import \{ SHELL, SHELL_ID, HASHES \} from '\.\/shell-files\.js';/);
  assert.doesNotMatch(sw, /const (?:SHELL|FLAGS|PAGES) = /, 'the hand-written lists are gone');
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.deepEqual(shell, shell.toSorted(), 'the list is sorted');
  // The id and the hashes shell-files.js carries are the ones the built site's files give: every file
  // the worker keeps, and those it keeps once a route not installed asks for them.
  assert.deepEqual(kept(builtSite()), { files: shell, id, hashes });
  for (const file of shell) assert.match(hashes[file], /^[0-9a-f]{64}$/, `${file} has its hash`);
  assert.deepEqual(Object.keys(hashes).filter((f) => !shell.includes(f)).toSorted(), leftOut, 'and those fetched when first shown');
});

test('the built worker is one file, its imports and its list inside it, so a changed build is a changed worker', () => {
  // A browser replaces a worker whose file changed. A worker whose file is the same and that only
  // imports a changed module is not reliably replaced (Chrome starts the new one and gives it up when
  // it asks for two unchanged imports at once); and a host's edges can serve a new sw.js beside an old
  // import for minutes after a release, which a worker built from them would run until the next one.
  // So the built worker imports nothing: everything it runs, and the list, is in its own file.
  const built = readFileSync(join(builtSite(), 'sw.js'), 'utf8');
  assert.doesNotMatch(built, /^\s*(?:import|export)\b/m, 'no import or export statement');
  assert.doesNotMatch(built, /\bimport\s*\(\s*['"]/, 'no import() of a module of its own');
  assert.ok(built.includes(`const SHELL_ID = ${JSON.stringify(id)};`), 'the id');
  for (const [file, hash] of Object.entries(hashes)) assert.ok(built.includes(`${JSON.stringify(file)}: ${JSON.stringify(hash)}`), `${file}'s hash`);
  // Its modules (their copies in the built site, less their comments), each said where it begins.
  for (const module of ['app/js/platform.js', 'app/js/jobs-runner.js', 'app/js/import-queue.js', 'app/js/folder-scan.js', 'app/js/pages.js']) {
    assert.match(built, new RegExp(`^// ${module.replace(/\./g, '\.')}$`, 'm'), `${module} is inside it`);
  }
});

test('a module inside the worker that finds a file from its own address still finds it there', () => {
  // import.meta.url inside the one file would be the worker's address, at the site's root: a module
  // that finds a sibling from its own (pdf.js from import-files.js, a font from page-image.js) is given
  // its own address instead, said from the worker's, so it holds under a folder too.
  const built = readFileSync(join(builtSite(), 'sw.js'), 'utf8');
  assert.doesNotMatch(built, /\bimport\.meta\b/);
  assert.ok(built.includes('new URL("../../vendor/pdfjs/", new URL("app/js/import-files.js", self.location.href).href)'));
  const at = (href) => new URL('../../vendor/pdfjs/', new URL('app/js/import-files.js', href).href).href;
  assert.equal(at('https://example.test/shiori/sw.js?library=desktop'), 'https://example.test/shiori/vendor/pdfjs/', 'under a folder');
  assert.equal(at('https://example.test/sw.js'), 'https://example.test/vendor/pdfjs/', 'at the root');
});

test('any change to any file the worker keeps is another id: its bytes, its name, one more, one less', (t) => {
  // In a copy of the built site, never in the repo or the build itself.
  const copy = mkdtempSync(join(tmpdir(), 'shiori-shell-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(builtSite(), copy, { recursive: true });
  assert.equal(kept(copy).id, id, 'a copy of the same files has the same id');

  // A module the worker imports, changed by one line: the same list of names, another id and hash.
  assert.match(sw, /from '\.\/app\/js\/jobs-runner\.js';/, 'jobs-runner.js is a module the worker imports');
  appendFileSync(join(copy, 'app', 'js', 'jobs-runner.js'), '// changed\n');
  const changed = kept(copy);
  assert.deepEqual(changed.files, shell, 'the same files by name');
  assert.notEqual(changed.id, id, 'a changed module is another id');
  assert.notEqual(changed.hashes['app/js/jobs-runner.js'], hashes['app/js/jobs-runner.js']);

  // A file that isn't code counts the same.
  appendFileSync(join(copy, 'CHANGELOG.md'), '\n');
  const again = kept(copy);
  assert.notEqual(again.id, changed.id);

  // A file renamed with its bytes kept (as a bundle file is, by its hash), and one added.
  const bundle = shell.find((f) => /^assets\/.+-[\w-]{8}\.js$/.test(f));
  assert.ok(bundle, 'the list names the bundle, by a hashed name');
  renameSync(join(copy, bundle), join(copy, bundle.replace(/-[\w-]{8}\.js$/, '-AAAAAAAA.js')));
  const renamed = kept(copy);
  assert.notEqual(renamed.id, again.id);
  appendFileSync(join(copy, 'app', 'new-file.txt'), 'new');
  assert.notEqual(kept(copy).id, renamed.id);

  // What the worker doesn't keep doesn't count: its own file, its list, the host's 404 page.
  const before = kept(copy).id;
  for (const f of ['sw.js', 'shell-files.js', '404.html']) appendFileSync(join(copy, f), '\n');
  assert.equal(kept(copy).id, before);
});

test('a new worker reads its imports past the HTTP cache, so it never starts with an old list', () => {
  const boot = readFileSync(join(repo, 'app', 'js', 'boot-core.js'), 'utf8');
  const calls = boot.match(/serviceWorker\.register\([^\n]*/g) ?? [];
  assert.equal(calls.length, 1, 'the worker is registered in one place');
  assert.match(calls[0], /updateViaCache: 'none'/);
});

test('the independent revision refreshes both agent entry points during install', () => {
  assert.ok(shell.includes('app/agent.html'), 'agent.html must be part of the precached shell');
  assert.ok(shell.includes('app/js/agent.js'), 'agent.js must be part of the precached shell');

  const install = sw.match(/addEventListener\('install'[\s\S]*?\n\}\);/)[0];
  assert.match(install, /caches\.open\(await cacheName\(\)\)/,
    'install must populate the independently revisioned cache');
  assert.match(install, /Promise\.all\(BOOT\.map\(async \(u\) => cache\.put\(new URL\(u, ROOT\)\.href, await releaseCopy\(u\)\)\)\)/,
    'install must replace every boot asset, including both agent entry points, each as this release has it');
});

test('activation removes only older caches owned by this deployment root', () => {
  const prefix = 'shiori_shiori_';
  const current = `${prefix}-shell-v${revision}-${id}`;
  const isStale = staleFor(prefix);

  assert.equal(isStale(current, current), false, 'the current cache must survive activation');
  assert.equal(isStale(`${prefix}-shell-v${revision}-0123456789ab`, current), true, 'the cache of another build must be removed');
  assert.equal(isStale(`${prefix}-shell-v${revision}`, current), true, 'a cache named before builds had ids must be removed');
  assert.equal(isStale(`${prefix}-shell-v43`, current), true, 'the previous numeric shell cache must be removed');
  assert.equal(isStale(`${prefix}-shell-v${manifest.version}`, current), true,
    'the former manifest-versioned cache must be removed');
  assert.equal(isStale('shiori-shell-v43', current), true, 'the historical unscoped cache must be removed');
  assert.equal(isStale('shiori_other_-shell-v43', current), false, 'a sibling deployment cache must survive');
  assert.equal(isStale('unrelated-shell-v43', current), false, 'an unrelated cache must survive');
});

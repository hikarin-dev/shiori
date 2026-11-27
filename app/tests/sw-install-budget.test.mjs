// sw-install-budget.test.mjs — the first visit holds on a loading screen until the worker is
// ready, so whatever install awaits is time the visitor spends staring at nothing.
//
// This regressed once: install awaited the entire shell, ~10 MB, almost 9 MB of which was fonts
// and flags (two study-mode typefaces alone are 8.4 MB) that the library does not need to draw.
// Install now blocks on code only; everything else is warmed once the app is idle, and the fetch
// handler still caches on demand. These assertions keep that split honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtSite } from '../../build/built.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sw = readFileSync(join(repo, 'sw.js'), 'utf8');

// The list the worker installs from is the one the build wrote (shell-files.js): every file of the
// built site it keeps. Asking for the built site throws, saying so, when there is none or a source
// changed since (npm run build).
const { SHELL: shell } = await import(pathToFileURL(join(builtSite(), 'shell-files.js')).href);
const isCode = (u) => /\.(m?js|html|css|webmanifest)$/.test(u);
const onFirstUse = (u) => u.startsWith('vendor/pdfjs/') || u === 'vendor/marked.min.js';
const installed = (u) => isCode(u) && !onFirstUse(u);
// Sizes as served: the built site's.
const bytes = (files, site = builtSite()) => files.reduce((n, f) => n + (existsSync(join(site, f)) ? statSync(join(site, f)).size : 0), 0);

// Headroom over today's code (about 3.0 MB since the library-storage work; ~1 MB when this was written), far under the
// ~10 MB the regression above awaited: raised from 3 MB at S32 (2026-11-19), whose hand-over rules took the last of it.
// 4 MB while the UI is ported to the one page (from 2026-11-23): until then the built site carries both UIs — the pages
// not ported yet with their scripts, and the new bundle — so the code installed first is larger than either alone.
// Nothing is released in that state; each ported page deletes its old scripts in the same step, and at the cutover the
// budget goes back to 3.25 MB or lower (the figure measured then, plus headroom). Back at 3.25 MB at the cutover (9b,
// 2026-11-27): about 3.0 MB then (the served modules copied without their comments, every language installed).
const BOOT_BUDGET = 3.25 * 1024 * 1024;

test('install blocks on code only, within a sane byte budget', () => {
  // The split the sizes below are taken by is the worker's own.
  assert.ok(sw.includes('const isCode = (u) => /\\.(m?js|html|css|webmanifest)$/.test(u);'), 'the worker\'s test of code');
  assert.ok(sw.includes("const onFirstUse = (u) => u.startsWith('vendor/pdfjs/') || u === 'vendor/marked.min.js';"), 'the worker\'s code fetched on first use');
  assert.match(sw, /const BOOT = SHELL\.filter\(\(u\) => isCode\(u\) && !onFirstUse\(u\)\);\r?\nconst DEFERRED = SHELL\.filter\(\(u\) => !BOOT\.includes\(u\)\);/);
  const boot = shell.filter(installed);
  const size = bytes(boot);
  assert.ok(size <= BOOT_BUDGET,
    `install would block on ${(size / 1024 / 1024).toFixed(2)} MB; keep it under ${BOOT_BUDGET / 1024 / 1024} MB`);
});

test('the heavy assets are deferred, not awaited during install', () => {
  // The install handler must await BOOT and nothing else. Taking over, the worker copies the deferred
  // assets a cache before it holds, and fetches none of them.
  const install = sw.match(/addEventListener\('install'[\s\S]*?\n\}\);/)[0];
  assert.match(install, /await Promise\.all\(BOOT\.map/, 'install should await the BOOT set');
  assert.doesNotMatch(install, /DEFERRED/, 'install must not touch the deferred assets');
  const activate = sw.match(/addEventListener\('activate'[\s\S]*?\n\}\);/)[0];
  const copied = activate.slice(activate.indexOf('DEFERRED'));
  assert.match(copied, /^DEFERRED\.map\(async \(u\) => \{\n\s+const copy = await heldCopy\(u, held\)/, 'the deferred assets are only copied where held');
  assert.doesNotMatch(copied.slice(0, copied.indexOf('}));')), /releaseCopy|fetch\(/, 'taking over must not fetch the deferred assets');

  const deferred = shell.filter((u) => !installed(u));
  assert.ok(bytes(deferred) > bytes(shell.filter(installed)),
    'sanity: the deferred set is the heavy one');
});

test('deferred assets are still precached eventually, and cached on demand meanwhile', () => {
  assert.match(sw, /__shioriWarmShell/, 'a warm-up entry point must exist');
  assert.match(sw, /async function warmDeferredShell/, 'the warm-up must cover the deferred set');
  const boot = readFileSync(join(repo, 'app', 'js', 'boot-core.js'), 'utf8');
  assert.match(boot, /__shioriWarmShell/, 'the app must ask for the warm-up once idle');
  // The fetch handler is the safety net for anything not yet warmed.
  assert.match(sw, /if \(await isRelease\(pathOf\(key\), body\)\) await cache\.put\(key, new Response\(body/, 'responses should still be cached on demand, as this release has them');
});

test('a first visit is not held behind the worker install at all', () => {
  // With nothing installed yet, waiting for the worker means a blank screen for the length of the
  // precache. The one page draws every address itself, so its entry waits on no worker at all;
  // boot-core.js registers the worker once the page runs, so installation still happens.
  const src = readFileSync(join(repo, 'src', 'entry.ts'), 'utf8');
  assert.doesNotMatch(src, /serviceWorker/, 'the entry must not wait on a worker');
  const boot = readFileSync(join(repo, 'app', 'js', 'boot-core.js'), 'utf8');
  assert.match(boot, /serviceWorker\.register/, 'the app page must register the worker');
});

test('every shell entry is classified as exactly one of boot or deferred', () => {
  const boot = shell.filter(installed);
  const deferred = shell.filter((u) => !installed(u));
  assert.equal(boot.length + deferred.length, shell.length);
  assert.equal(boot.filter((f) => deferred.includes(f)).length, 0);
});

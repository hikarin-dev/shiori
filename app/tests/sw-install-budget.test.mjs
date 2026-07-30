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
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sw = readFileSync(join(repo, 'sw.js'), 'utf8');

const listOf = (name) => {
  const block = sw.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(block, `sw.js must define ${name}`);
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};
const shell = [
  ...listOf('SHELL'),
  ...[...sw.match(/const FLAGS = \[([\s\S]*?)\]\s*\n?\s*\.map/)[1].matchAll(/'([A-Z]{2})'/g)]
    .map((m) => `app/flags/${m[1]}.svg`),
];
const isCode = (u) => /\.(js|html|css|webmanifest)$/.test(u);
const bytes = (files) => files.reduce((n, f) => n + (existsSync(join(repo, f)) ? statSync(join(repo, f)).size : 0), 0);

const BOOT_BUDGET = 3 * 1024 * 1024;   // generous headroom over today's ~1 MB of code

test('install blocks on code only, within a sane byte budget', () => {
  const boot = shell.filter(isCode);
  const size = bytes(boot);
  assert.ok(size <= BOOT_BUDGET,
    `install would block on ${(size / 1024 / 1024).toFixed(2)} MB; keep it under ${BOOT_BUDGET / 1024 / 1024} MB`);
});

test('the heavy assets are deferred, not awaited during install', () => {
  // The install handler must await BOOT and nothing else.
  const install = sw.match(/addEventListener\('install'[\s\S]*?\n\}\);/)[0];
  assert.match(install, /await Promise\.all\(BOOT\.map/, 'install should await the BOOT set');
  assert.doesNotMatch(install, /DEFERRED/, 'install must not touch the deferred assets');

  const deferred = shell.filter((u) => !isCode(u));
  assert.ok(bytes(deferred) > bytes(shell.filter(isCode)),
    'sanity: the deferred set is the heavy one');
});

test('deferred assets are still precached eventually, and cached on demand meanwhile', () => {
  assert.match(sw, /__shioriWarmShell/, 'a warm-up entry point must exist');
  assert.match(sw, /async function warmDeferredShell/, 'the warm-up must cover the deferred set');
  const boot = readFileSync(join(repo, 'app', 'js', 'boot.js'), 'utf8');
  assert.match(boot, /__shioriWarmShell/, 'the app must ask for the warm-up once idle');
  // The fetch handler is the safety net for anything not yet warmed.
  assert.match(sw, /cache\.put\(key, resp\.clone\(\)\)/, 'responses should still be cached on demand');
});

test('a first visit is not held behind the worker install at all', () => {
  // With nothing installed yet, waiting for the worker means a blank loading screen for the
  // length of the precache. The entry page must detect that case and go straight to the real
  // page instead; boot.js registers the worker from there, so installation still happens.
  const src = readFileSync(join(repo, 'boot-root.js'), 'utf8');
  assert.match(src, /getRegistration\(\)/, 'the entry page must check for an existing worker');
  assert.match(src, /if \(!existing \|\| !existing\.active\) return toLibrary\(\)/,
    'no active worker must mean an immediate hand-off, not an await on install');
  // The wait that remains (worker already installed) still has to be bounded.
  assert.match(src, /Promise\.race/, 'the remaining wait must be bounded');
  const boot = readFileSync(join(repo, 'app', 'js', 'boot.js'), 'utf8');
  assert.match(boot, /serviceWorker\.register/, 'the app page must register the worker');
});

test('every shell entry is classified as exactly one of boot or deferred', () => {
  const boot = shell.filter(isCode);
  const deferred = shell.filter((u) => !isCode(u));
  assert.equal(boot.length + deferred.length, shell.length);
  assert.equal(boot.filter((f) => deferred.includes(f)).length, 0);
});

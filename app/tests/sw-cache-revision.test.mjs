// sw-cache-revision.test.mjs — precached code needs its own deployment revision. Product
// versions change only for releases, while agent.html / agent.js can change during ordinary
// fixes; tying the cache name to the manifest leaves an already-running agent on stale bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sw = readFileSync(join(repo, 'sw.js'), 'utf8');
const manifest = JSON.parse(readFileSync(join(repo, 'app', 'manifest.webmanifest'), 'utf8'));

const revisionMatch = sw.match(/const SHELL_CACHE_REVISION = (\d+);/);
assert.ok(revisionMatch, 'sw.js must declare a numeric shell cache revision');
const revision = Number(revisionMatch[1]);

const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);
assert.ok(shellBlock, 'sw.js must define SHELL');
const shell = [...shellBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const helperMatch = sw.match(/function isStaleShellCache\(key, current\) \{[\s\S]*?\n\}/);
assert.ok(helperMatch, 'sw.js must expose its stale-cache predicate for review');
const staleFor = (prefix) => new Function('CACHE_PREFIX',
  `${helperMatch[0]}; return isStaleShellCache;`)(prefix);

test('shell cache naming is root-scoped and independent from the product version', () => {
  assert.match(sw, /const CACHE_NAME = `\$\{CACHE_PREFIX\}-shell-v\$\{SHELL_CACHE_REVISION\}`;/);
  assert.doesNotMatch(sw, /m\.version|manifest\.version/,
    'runtime cache naming must not depend on the release-only product version');

  const prefix = 'shiori_shiori_';
  const cache = `${prefix}-shell-v${revision}`;
  assert.notEqual(cache, `${prefix}-shell-v${manifest.version}`);
});

test('the independent revision refreshes both agent entry points during install', () => {
  assert.ok(shell.includes('app/agent.html'), 'agent.html must be part of the precached shell');
  assert.ok(shell.includes('app/js/agent.js'), 'agent.js must be part of the precached shell');

  const install = sw.match(/addEventListener\('install'[\s\S]*?\n\}\);/)[0];
  assert.match(install, /caches\.open\(await cacheName\(\)\)/,
    'install must populate the independently revisioned cache');
  assert.match(install, /Promise\.all\(BOOT\.map/,
    'install must replace every boot asset, including both agent entry points');
});

test('activation removes only older caches owned by this deployment root', () => {
  const prefix = 'shiori_shiori_';
  const current = `${prefix}-shell-v${revision}`;
  const isStale = staleFor(prefix);

  assert.equal(isStale(current, current), false, 'the current cache must survive activation');
  assert.equal(isStale(`${prefix}-shell-v43`, current), true, 'the previous numeric shell cache must be removed');
  assert.equal(isStale(`${prefix}-shell-v${manifest.version}`, current), true,
    'the former manifest-versioned cache must be removed');
  assert.equal(isStale('shiori-shell-v43', current), true, 'the historical unscoped cache must be removed');
  assert.equal(isStale('shiori_other_-shell-v43', current), false, 'a sibling deployment cache must survive');
  assert.equal(isStale('unrelated-shell-v43', current), false, 'an unrelated cache must survive');
});

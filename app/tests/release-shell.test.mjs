// release-shell.test.mjs — deployment integrity. The site is served straight from the repo, so
// "deployable" means: every runtime root file exists, every file the worker precaches exists,
// every app/js module is in that precache list (or it silently breaks offline only), and every
// page resolves its static assets — including a direct app/<page>.html load with no worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const present = (rel) => existsSync(join(repo, rel));

function shellFiles() {
  const sw = read('sw.js');
  const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(shellBlock, 'sw.js must define SHELL');
  const files = [...shellBlock[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const flagsBlock = sw.match(/const FLAGS = \[([\s\S]*?)\]\s*\n?\s*\.map/);
  assert.ok(flagsBlock, 'sw.js must define FLAGS');
  const flags = [...flagsBlock[1].matchAll(/'([A-Z]{2})'/g)].map((x) => `app/flags/${x[1]}.svg`);
  return [...files, ...flags];
}

test('the runtime root files are present', () => {
  for (const required of ['index.html', '404.html', 'sw.js', 'boot-root.js', 'CHANGELOG.md']) {
    assert.ok(present(required), `${required} is missing from the tree`);
  }
});

test('every precached SHELL file exists', () => {
  const missing = shellFiles().filter((f) => !present(f));
  assert.deepEqual(missing, [], 'SHELL lists files that are not in the tree');
});

test('every app/js module is precached in SHELL', () => {
  const shell = new Set(shellFiles());
  const missing = readdirSync(join(repo, 'app', 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `app/js/${f}`)
    .filter((f) => !shell.has(f));
  assert.deepEqual(missing, [], 'app/js modules not listed in the SHELL cache');
});

test('the UI font is served locally — no hosted-font URLs anywhere in the app', () => {
  const offenders = [];
  const scan = (rel) => {
    if (/fonts\.googleapis|fonts\.gstatic/.test(read(rel))) offenders.push(rel);
  };
  scan('sw.js'); scan('index.html'); scan('404.html'); scan('app/font-init.js');
  for (const f of readdirSync(join(repo, 'app', 'js')).filter((f) => f.endsWith('.js'))) scan(`app/js/${f}`);
  for (const f of readdirSync(join(repo, 'app')).filter((f) => f.endsWith('.html') || f.endsWith('.css'))) scan(`app/${f}`);
  assert.deepEqual(offenders, []);
});

// Clean-URL segments the service worker / 404.html serve — not files.
const CLEAN = new Set(['', 'library', 'reader', 'settings', 'overview']);

test('app pages resolve their assets when loaded directly (no service worker)', () => {
  for (const page of ['library', 'reader', 'settings', 'overview']) {
    const html = read(`app/${page}.html`);
    assert.match(html, /document\.querySelector\('base'\)\.href = '\.\/'/,
      `${page}.html lacks the runtime base corrector for direct file loads`);
    for (const [, url] of html.replace(/<base [^>]*>/g, '').matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (/^(https?:|\/\/|data:|#|mailto:)/.test(url)) continue;
      const bare = url.replace(/[?#].*$/, '');
      // <base> points at the app folder in both serve modes; ../ climbs to the site root.
      const rel = bare.startsWith('../') ? bare.slice(3) : `app/${bare}`;
      if (CLEAN.has(rel.replace(/\/$/, ''))) continue;
      assert.ok(present(rel), `${page}.html references ${url} → ${rel}, which is missing`);
    }
  }
});

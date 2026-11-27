// package.test.mjs — the installer carries every module the desktop app loads: a file main.js or
// the server imports but the build's file list leaves out runs in development and fails once
// installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { build } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const listed = (rel) => build.files.some(f => (f.endsWith('/**') ? rel.startsWith(f.slice(0, -2)) : rel === f));

test('every module the desktop app loads is in the installer', () => {
  const seen = new Set(), missing = [];
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    if (!listed(rel)) missing.push(rel);
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const [, spec] of source.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!next.startsWith('..')) visit(next);   // the app's own pages and modules ship as resources/ui
    }
    // Files the main process loads by path (preloads, the title bar's page), and what a page loads.
    for (const m of source.matchAll(/path\.join\(here, '([^']+)'\)|<script src="([^"]+)"/g)) visit(m[1] || m[2]);
  };
  visit('main.js');
  assert.ok(seen.size > 5, `followed ${[...seen].join(', ')}`);
  assert.deepEqual(missing, []);
});

// The app runs on the built site (main.js in development, resources/ui once packaged), so each way of
// running or packaging it builds the site first, once, rather than refusing a build that is missing or
// older than its sources: `start` before Electron, the others through the staging script.
test('start, pack, dist and dev-update each build the site first', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  assert.match(scripts.start, /^npm --prefix \.\. run build && electron \.$/);
  for (const name of ['pack', 'dist']) assert.match(scripts[name], /^node scripts\/stage-ui\.mjs && electron-builder /, name);
  const devUpdate = read('scripts/dev-update.mjs');
  assert.ok(devUpdate.indexOf("'stage-ui.mjs'") > 0 && devUpdate.indexOf("'stage-ui.mjs'") < devUpdate.indexOf("'electron-builder'"), 'dev-update stages before it packs');
  const stage = read('scripts/stage-ui.mjs');
  const built = stage.indexOf("spawnSync('npm run build', { cwd: repo");
  assert.ok(built > 0 && built < stage.indexOf('builtSite()', built) && stage.indexOf('builtSite()', built) < stage.indexOf('fs.cpSync('),
    'the staging builds the site, checks it, then copies it');
});

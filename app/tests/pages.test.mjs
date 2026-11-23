// pages.test.mjs — the app's addresses are stated once (app/js/pages.js), and everything that
// answers one agrees with it: 404.html, which cannot import the map and names the addresses itself;
// the one page, which draws exactly the addresses the map gives it; and the built site, which has
// every file the map names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtSite } from '../../build/built.mjs';
import { PAGES, APP_PAGE, pageFile } from '../js/pages.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8');

test('every address is one segment under the root, answered by a file the built site has', () => {
  assert.ok('' in PAGES, 'the root is an address');
  for (const [segment, file] of Object.entries(PAGES)) {
    assert.match(segment, /^[a-z]*$/, `"${segment}" must be one plain segment: the one page and 404.html find the site's root by it`);
    assert.ok(existsSync(join(builtSite(), file)), `${file} (for /${segment}) is not in the built site`);
  }
  assert.equal(pageFile('settings'), PAGES.settings);
  assert.equal(pageFile(''), PAGES['']);
});

test('only the map\'s own names are addresses', () => {
  for (const segment of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nowhere', 'app/library', 'index.html']) {
    assert.equal(pageFile(segment), null, `/${segment} is no address of the app`);
  }
});

test('404.html names the same addresses as the map', () => {
  // A static host serves 404.html for a clean address; it is never asked for the root.
  const list = read('404.html').match(/const KNOWN = \[([^\]]*)\];/);
  assert.ok(list, '404.html must list the addresses it knows as `const KNOWN = [...]`');
  const known = [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(known.toSorted(), Object.keys(PAGES).filter(Boolean).toSorted());
});

test('the one page draws exactly the addresses the map gives it', async () => {
  // A page's address moves to the one page in the step that ports it, with its route: a route with no
  // entry in the map is never reached, and an entry with no route draws "Not found".
  const { ROUTES } = await import('../../src/routes.ts');
  const given = Object.keys(PAGES).filter((segment) => PAGES[segment] === APP_PAGE);
  assert.ok(given.length, 'the map gives the one page an address');
  assert.deepEqual(Object.keys(ROUTES).toSorted(), given.toSorted());
  // Each route is drawn by its own module, and the router makes a route of each entry.
  for (const { page } of Object.values(ROUTES)) assert.ok(existsSync(join(repo, 'src', 'routes', `${page}.tsx`)), `src/routes/${page}.tsx`);
  assert.match(read('src/app.tsx'), /Object\.entries\(ROUTES\)\.map\(/);
});

test('the shiori-app meta names the app\'s own pages only', async () => {
  const { ROUTES } = await import('../../src/routes.ts');
  const own = new Set(['library', 'overview', 'reader', 'settings', 'tasks']);
  for (const [segment, route] of Object.entries(ROUTES)) {
    assert.equal(route.app, own.has(route.page), `/${segment}: the meta is there exactly on the app's own pages`);
  }
});

test('the one page\'s entry and 404.html hand an address over the same way', () => {
  // 404.html keeps the address under one name and goes to the one page by its file name; the entry
  // reads that name, there only.
  const page = read('404.html'), entry = read('src/entry.ts');
  assert.match(page, /sessionStorage\.setItem\('shiori-route', seg \+ location\.search \+ location\.hash\)/);
  assert.match(page, /location\.replace\(root \+ 'index\.html'\)/);
  assert.equal(APP_PAGE, 'index.html');
  assert.match(entry, /stored\('shiori-route'\)/);
  assert.match(entry, /sessionStorage\.removeItem\('shiori-route'\)/);
});

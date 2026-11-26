// pages.test.mjs — the app's addresses are stated once (app/js/pages.js), and everything that
// answers one agrees with it: 404.html, which cannot import the map and names the addresses itself;
// the one page, which draws exactly the addresses the map gives it; and the built site, which has
// every file the map names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { builtSite } from '../../build/built.mjs';
import { PAGES, APP_PAGE, MOVED, movedTo, pageFile } from '../js/pages.js';
import { startServer } from '../../build/serve.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(repo, rel), 'utf8');

test('every address is one segment under the root, answered by a file the built site has', () => {
  assert.ok('' in PAGES, 'the root is an address');
  for (const [segment, file] of Object.entries(PAGES)) {
    assert.match(segment, /^(?:[a-z]+(?:-[a-z]+)*)?$/, `"${segment}" must be one plain segment: the one page and 404.html find the site's root by it`);
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
  // The library, at the root and at /library, says so as 1.3's page did.
  assert.deepEqual([ROUTES[''].page, ROUTES.library.page], ['library', 'library']);
  // The page's first script writes it for the address a document opens on, before the app runs.
  const { startData } = await import('../../build/start.mjs');
  const start = startData({ routes: ROUTES });
  for (const [segment, route] of Object.entries(ROUTES)) assert.equal(start.routes[segment].meta, route.app ? route.page : null, `/${segment}: what start.js writes`);
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

test('an old page\'s file moved to an address the one page draws, and is gone from the built site', () => {
  for (const [old, segment] of Object.entries(MOVED)) {
    assert.match(old, /^app\/[a-z]+\.html$/);
    assert.equal(PAGES[segment], APP_PAGE, `${old} moved to /${segment}, which the one page draws`);
    assert.ok(!existsSync(join(builtSite(), old)), `${old} is gone`);
    assert.equal(movedTo(old), segment);
  }
  for (const path of ['reader', 'tasks', 'library', 'overview', 'constructor', 'app/tasks.htm', 'app/agent.html']) assert.equal(movedTo(path), null, path);
});

test('the server the tests and the preview use sends an old page\'s file on to its address, the query kept', async (t) => {
  const site = await startServer({ root: builtSite() });
  t.after(() => new Promise((done) => site.server.close(done)));
  // (Asked with a connection of its own, closed with the answer: fetch keeps its connections for a
  // while, and under the desktop run, which ends the process as soon as the file's tests have, one
  // still open took the process down with an assertion of the runtime's.)
  const ask = (url) => new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => { res.resume(); res.on('end', () => resolve([res.statusCode, res.headers.location])); }).on('error', reject);
  });
  for (const [old, segment] of Object.entries(MOVED)) {
    assert.deepEqual(await ask(`${site.origin}/${old}?g=1`), [301, `/${segment}?g=1`]);
  }
});

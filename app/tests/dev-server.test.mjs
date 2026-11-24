// dev-server.test.mjs — what the dev server (`npm run dev`, build/plugins.ts devPages) answers
// before Vite does: a page that still has a file of its own, at its clean address, as the file it
// is; an address the one page answers, as Vite's index.html; and /sw.js as a worker that can never
// become the one in charge — under the dev server the app has no worker, and runs its jobs in the tab.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devPages } from '../../build/plugins.ts';
import { PAGES, APP_PAGE, MOVED } from '../js/pages.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The plugin's middleware, as the dev server would hold it.
let handle = null;
const plugin = devPages();
plugin.configureServer({ middlewares: { use: (fn) => { handle = fn; } } });

// What the middleware does with a request for `url`: answers it itself, or passes it on.
function ask(url) {
  const req = { url, method: 'GET', headers: {} };
  const answer = { passedOn: false, url: null, status: null, headers: {}, body: null };
  const res = {
    writeHead(status, headers) { answer.status = status; answer.headers = headers || {}; return res; },
    end(body) { answer.body = body == null ? '' : Buffer.from(body).toString('utf8'); },
  };
  handle(req, res, () => { answer.passedOn = true; });
  answer.url = req.url;
  return answer;
}

test('it runs under the dev server only, and before Vite\'s own handling', () => {
  assert.equal(plugin.apply, 'serve');
  assert.equal(typeof handle, 'function', 'the middleware is added when the server is configured, not after Vite\'s own');
});

test('a page with a file of its own is sent as that file, at its clean address', () => {
  for (const [segment, file] of Object.entries(PAGES)) {
    if (file === APP_PAGE) continue;
    for (const url of [`/${segment}`, `/${segment}?g=1&page=2`]) {
      const answer = ask(url);
      assert.equal(answer.passedOn, false, `${url} is answered here`);
      assert.equal(answer.status, 200);
      assert.match(answer.headers['Content-Type'], /^text\/html/);
      assert.equal(answer.body, readFileSync(join(repo, file), 'utf8'), `${url} is ${file}, byte for byte (its policy pins its inline script)`);
    }
  }
});

test('an address the one page answers goes to Vite as its index.html, the query kept', () => {
  const mine = Object.keys(PAGES).filter((segment) => PAGES[segment] === APP_PAGE);
  assert.ok(mine.length, 'the one page answers an address');
  for (const segment of mine) {
    assert.deepEqual(ask(`/${segment}`), { passedOn: true, url: `/${APP_PAGE}`, status: null, headers: {}, body: null });
    assert.equal(ask(`/${segment}?x=1`).url, `/${APP_PAGE}?x=1`);
  }
});

test('an old page\'s file, gone since the one page draws its address, is sent on to that address, the query kept', () => {
  assert.ok(Object.keys(MOVED).length, 'a page has moved');
  for (const [old, segment] of Object.entries(MOVED)) {
    assert.equal(PAGES[segment], APP_PAGE, `/${segment} is the one page's`);
    const answer = ask(`/${old}?g=1#x`);
    assert.deepEqual([answer.passedOn, answer.status, answer.headers.Location], [false, 301, `/${segment}?g=1`]);
  }
});

test('everything else is Vite\'s: modules, styles, an address the app doesn\'t have', () => {
  for (const url of ['/app/js/platform.js', '/src/main.tsx', '/app/base.css', '/nowhere', '/app/library.html', '/index.html', '/constructor']) {
    assert.deepEqual(ask(url), { passedOn: true, url, status: null, headers: {}, body: null }, url);
  }
});

test('/sw.js is a worker that never installs, and takes a registration left at the address away', () => {
  const answer = ask('/sw.js');
  assert.equal(answer.passedOn, false, 'the real worker is never served: it would keep copies of the dev server\'s modules');
  assert.match(answer.headers['Content-Type'], /^text\/javascript/);
  assert.equal(answer.headers['Cache-Control'], 'no-store');
  // Its install fails, so it is never active: a worker that was active even for a moment is one
  // the app hands its jobs to (submit-job.js keeps the active worker it once saw).
  assert.match(answer.body, /addEventListener\('install'/);
  assert.match(answer.body, /event\.waitUntil\(Promise\.reject\(/);
  assert.match(answer.body, /self\.registration\.unregister\(\)/);
  assert.doesNotMatch(answer.body, /waitUntil\([^)]*unregister/, 'the removal is not waited for inside the install: it waits for the install');
  assert.doesNotMatch(answer.body, /skipWaiting|addEventListener\('(?:activate|fetch|message)'|\bimport\b/, 'it does nothing else');
  assert.match(readFileSync(join(repo, 'app', 'js', 'submit-job.js'), 'utf8'), /_swActive = reg\.active/, 'the app still keeps the active worker it saw (else this rule can go)');
});

test('/start.js is the page\'s first script with the map and the routes\' frames, and starts nothing', () => {
  // The dev server's page starts its entry itself, and has nothing built to preload.
  const answer = ask('/start.js');
  assert.equal(answer.passedOn, false);
  assert.match(answer.headers['Content-Type'], /^text\/javascript/);
  const data = JSON.parse(answer.body.match(/const START = (\{.*\});/)[1]);
  assert.deepEqual(data.pages, { ...PAGES });
  assert.equal(data.entry, null);
  assert.deepEqual(data.start, []);
  for (const route of Object.values(data.routes)) assert.deepEqual(route.preload, []);
  assert.equal(data.appPage, APP_PAGE);
});

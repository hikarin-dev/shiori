// site.test.mjs — the desktop app's server serves the built site as the app's other servers do: each
// of the app's clean addresses with the file the app's own map names for it (app/js/pages.js — a
// page's own file, or index.html, the one page), the bundle under assets/, and nothing of the web
// root that isn't the app: not its service worker (a page served here has none), not its tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { Library } = await import('../server/library.js');
const { startServer } = await import('../server/server.js');
const { PAGES, APP_PAGE, MOVED } = await import('../../app/js/pages.js');

// A web root laid out as the built site is: every file the map names, saying which file it is.
async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-site-'));
  const webRoot = path.join(dir, 'site');
  const put = (rel, text = `file ${rel}`) => {
    fs.mkdirSync(path.dirname(path.join(webRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(webRoot, rel), text);
  };
  for (const file of new Set(Object.values(PAGES))) put(file);
  for (const file of ['assets/app-abc12345.js', 'assets/app-abc12345.css', 'icons/icon32.png', 'vendor/x.js', 'CHANGELOG.md', 'shell-files.js', 'start.js',
    'sw.js', '404.html', 'app/tests/x.test.mjs', 'package.json']) put(file);
  const library = await new Library({ dataDir: path.join(dir, 'data'), libraryDir: path.join(dir, 'library') }).open();
  const server = await startServer({ library, token: 'window-token-0123456789abcdef', webRoot });
  t.after(async () => { await server.close(); library.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return (pathname) => fetch(`http://127.0.0.1:${server.port}${pathname}`);
}

test('each of the app\'s addresses is answered with the file the app\'s map names', async (t) => {
  const get = await serve(t);
  for (const [segment, file] of Object.entries(PAGES)) {
    const res = await get(`/${segment}`);
    assert.equal(res.status, 200, `/${segment}`);
    assert.equal(await res.text(), `file ${file}`, `/${segment} is answered with ${file}`);
    assert.match(res.headers.get('content-type'), /^text\/html/);
  }
  assert.ok(Object.values(PAGES).includes(APP_PAGE), 'the one page answers an address');
  assert.equal(await (await get('/library?q=x')).text(), `file ${PAGES.library}`, 'whatever the address asks for');
  // A page's own file by its name, too (a direct load).
  assert.equal(await (await get(`/${PAGES.settings}`)).text(), `file ${PAGES.settings}`);
});

test('an old page\'s file, gone since the one page draws its address, is sent on to that address', async (t) => {
  const get = await serve(t);
  assert.ok(Object.keys(MOVED).length, 'a page has moved');
  const at = new URL((await get('/')).url);
  for (const [old, segment] of Object.entries(MOVED)) {
    const res = await fetch(new URL(`/${old}?g=1`, at), { redirect: 'manual' });
    assert.deepEqual([res.status, res.headers.get('location')], [301, `/${segment}?g=1`], `/${old}`);
  }
});

test('the bundle and what the pages load are served; the rest of the web root is not', async (t) => {
  const get = await serve(t);
  for (const [pathname, type] of [['/assets/app-abc12345.js', /^text\/javascript/], ['/assets/app-abc12345.css', /^text\/css/],
    ['/icons/icon32.png', /^image\/png/], ['/vendor/x.js', /^text\/javascript/], ['/CHANGELOG.md', /^text\/markdown/], ['/shell-files.js', /^text\/javascript/],
    ['/start.js', /^text\/javascript/]]) {
    const res = await get(pathname);
    assert.equal(res.status, 200, pathname);
    assert.match(res.headers.get('content-type'), type, pathname);
  }
  // No worker for a page this server serves; no tests; nothing else that happens to lie there;
  // no address the map doesn't have, by any name an object answers to.
  for (const pathname of ['/sw.js', '/404.html', '/app/tests/x.test.mjs', '/package.json', '/nowhere', '/constructor', '/__proto__', '/assets/missing.js']) {
    assert.equal((await get(pathname)).status, 404, pathname);
  }
});

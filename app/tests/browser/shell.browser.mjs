// shell.browser.mjs — the one page (index.html) in Chrome, from the built site: it draws the addresses
// it answers, sends the others on to the file that does, takes an address over from 404.html on a
// host that knows no clean addresses, and breaks nothing of its own policy on the way. And with the
// service worker installed: every address opens with the server gone, and a hard reload of a clean
// address the host doesn't know comes back through the worker.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { builtSite } from '../../../build/built.mjs';
// The files the worker keeps, from the list the build wrote (asking for the built site throws, saying
// so, when there is none or a source changed since: npm run build).
const { SHELL } = await import(pathToFileURL(join(builtSite(), 'shell-files.js')).href);

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

// A page in a profile of its own (nothing installed, nothing stored), recording what goes wrong in
// `page.problems`: uncaught errors, console errors, and anything the page's policy refused.
// `answers`: the file a clean address is answered with instead of what the test server gives —
// '404.html', as a host that knows no clean addresses does; 'index.html', as one that answers every
// address with the one page (`page.answered` counts those answers). `site`: the server the page is
// for, when not the one every test shares.
async function fresh(t, { answers = null, site = origin } = {}) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`uncaught: ${e?.message || e}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (answers === '404.html' && /status of 404/.test(msg.text())) return;   // the host's answer, as asked for
    page.problems.push(`console: ${msg.text()}`);
  });
  await page.evaluateOnNewDocument(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.error(`policy: ${e.violatedDirective} refused ${e.blockedURI}`));
  });
  const body = answers && await readFile(join(builtSite(), answers));
  page.answered = 0;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (answers && request.isNavigationRequest() && /^\/[a-z]+$/.test(new URL(url).pathname)) {
      page.answered++;
      request.respond({ status: answers === '404.html' ? 404 : 200, contentType: 'text/html', body });
    } else if (url.startsWith(site) || url.startsWith('data:') || url.startsWith('blob:')) request.continue();
    else request.abort();
  });
  return page;
}

const drawn = () => document.title === 'Shiori — Components' && document.querySelectorAll('main button').length;
const address = () => location.pathname + location.search + location.hash;

test('the one page draws /components: tokens, a button of each kind, the UI font, nothing refused', async (t) => {
  const page = await fresh(t);
  if (!page) return;
  const fonts = [];
  page.on('requestfinished', (r) => { if (/\.(woff2?|ttf|otf)$/.test(r.url())) fonts.push(new URL(r.url()).pathname); });
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  assert.equal(await until(page, drawn, undefined, { what: 'the components page' }), 6, 'one button of each variant');
  const seen = await page.evaluate(async () => {
    await document.fonts.ready;
    const body = getComputedStyle(document.body);
    return { path: location.pathname, family: body.fontFamily, size: body.fontSize, background: body.backgroundColor,
      primary: getComputedStyle(document.querySelector('main button')).backgroundColor,
      swatches: document.querySelectorAll('[data-token]').length,
      policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '' };
  });
  assert.equal(seen.path, '/components', 'the address stays clean');
  assert.match(seen.family, /JetBrains Mono/);
  assert.equal(seen.size, '13px');
  assert.equal(seen.background, 'rgb(13, 13, 15)', 'the page\'s background is the palette\'s');
  assert.equal(seen.primary, 'rgb(237, 39, 84)', 'the brand colour is the primary one');
  assert.ok(seen.swatches > 10, 'the tokens are shown');
  assert.match(seen.policy, /script-src 'self';/, 'the built page carries its policy');
  assert.ok(fonts.length && fonts.every((f) => f.startsWith('/app/fonts/JetBrainsMono-')), `the UI font comes from app/fonts/: ${fonts}`);
  assert.deepEqual(page.problems, []);
});

test('opened by its file name with no worker installed, the one page goes straight on to the library\'s file', async (t) => {
  const page = await fresh(t);
  if (!page) return;
  await page.goto(`${origin}/index.html?q=x`, { waitUntil: 'load' });
  await until(page, () => document.title === 'Shiori — Library' && !!document.querySelector('header'), undefined, { what: 'the library' });
  assert.equal(await page.evaluate(address), '/app/library.html?q=x');
  assert.deepEqual(page.problems, []);
});

test('an address the app doesn\'t have is said to be not found, by 404.html and by the one page alike', async (t) => {
  const host = await fresh(t);
  if (!host) return;
  await host.goto(`${origin}/nowhere`, { waitUntil: 'load' });   // the test server answers as a host does: 404.html
  assert.match(await host.evaluate(() => document.body.textContent), /Not found\./);

  const page = await fresh(t, { answers: 'index.html' });
  await page.goto(`${origin}/nowhere`, { waitUntil: 'load' });
  await until(page, () => /Not found\./.test(document.getElementById('root').textContent), undefined, { what: 'the one page\'s "Not found."' });
  assert.equal(await page.evaluate(address), '/nowhere');
  assert.deepEqual(page.problems, []);
});

test('on a host that knows no clean addresses, 404.html brings /components to the one page', async (t) => {
  const page = await fresh(t, { answers: '404.html' });
  if (!page) return;
  await page.goto(`${origin}/components?from=reload#buttons`).catch(() => {});   // the 404 page leaves at once
  assert.equal(await until(page, drawn, undefined, { what: 'the components page' }), 6);
  assert.equal(await page.evaluate(address), '/components?from=reload#buttons', 'the address is the one asked for');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('shiori-route')), null, 'the kept address is used once');
  assert.deepEqual(page.problems, []);
});

test('on a host that knows no clean addresses, 404.html brings /settings to the page\'s own file', async (t) => {
  const page = await fresh(t, { answers: '404.html' });
  if (!page) return;
  await page.goto(`${origin}/settings?tab=storage#about`).catch(() => {});
  await until(page, () => document.title === 'Shiori — Settings' && !!document.querySelector('header'), undefined, { what: 'the settings page' });
  assert.equal(await page.evaluate(address), '/app/settings.html?tab=storage#about');
  assert.deepEqual(page.problems, []);
});

// Resolves once the worker is in charge of the page and holds every file of the built site: the code
// it installs with, and the rest, which it fetches once the page is idle.
const workerHoldsAll = (page) => until(page, async (count) => {
  if (!navigator.serviceWorker.controller) return false;
  const name = (await caches.keys()).find((key) => key.includes('-shell-v'));
  return !!name && (await (await caches.open(name)).keys()).length >= count;
}, SHELL.length, { what: 'the worker in charge, holding every file', timeout: 60000 });

test('with the worker installed and the server gone, the library and the one page open at their clean addresses', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const site = await startServer();   // a server of its own, to take away
  t.after(() => site.server.close());
  const page = await fresh(t, { site: site.origin });
  await page.goto(`${site.origin}/`, { waitUntil: 'load' });
  await workerHoldsAll(page);
  assert.deepEqual(page.problems, [], 'nothing went wrong while the server was there');

  site.server.close();
  site.server.closeAllConnections();
  page.problems.length = 0;
  await page.reload({ waitUntil: 'load' });
  await until(page, () => document.title === 'Shiori — Library' && !!document.querySelector('header'), undefined, { what: 'the library, offline' });
  assert.equal(await page.evaluate(address), '/');

  await page.goto(`${site.origin}/components`, { waitUntil: 'load' });
  assert.equal(await until(page, drawn, undefined, { what: 'the components page, offline' }), 6);
  assert.equal(await page.evaluate(address), '/components');
  assert.match(await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family).join(); }),
    /JetBrains Mono/, 'the UI font comes from the worker too');
  assert.deepEqual(page.problems.filter((problem) => /uncaught|policy/.test(problem)), [], 'no error of the page\'s own');
});

test('with the worker installed, a hard reload of a clean address the host doesn\'t know comes back through the worker', async (t) => {
  const page = await fresh(t, { answers: '404.html' });
  if (!page) return;
  // A first visit by a file's own name (every host has it), which installs the worker.
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await until(page, () => !!navigator.serviceWorker.controller, undefined, { what: 'the worker in charge', timeout: 30000 });
  const cdp = await page.createCDPSession();
  let asked = 0;
  for (const [path, title] of [['/components', 'Shiori — Components'], ['/settings', 'Shiori — Settings']]) {
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    await until(page, (title) => document.title === title, title, { what: `${path} from the worker` });
    assert.equal(page.answered, asked, 'the worker answered: the host was not asked');
    await page.evaluate(() => { window.before = true; });
    await cdp.send('Page.reload', { ignoreCache: true });   // past the worker: the host answers with 404.html
    await until(page, (title) => !window.before && document.title === title && !!navigator.serviceWorker.controller && !sessionStorage.getItem('shiori-sw-retry'),
      title, { what: `${path} back through the worker` });
    assert.equal(page.answered, ++asked, 'the hard reload reached the host once, and its 404.html');
    assert.equal(await page.evaluate(address), path, 'the address stays clean');
  }
  assert.deepEqual(page.problems, []);
});

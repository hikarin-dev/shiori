// shell.browser.mjs — the one page (index.html) in Chrome, from the built site: it draws the addresses
// it answers, sends the others on to the file that does, takes an address over from 404.html on a
// host that knows no clean addresses, and breaks nothing of its own policy on the way.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { builtSite } from '../../../build/built.mjs';

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
// address with the one page.
async function fresh(t, { answers = null } = {}) {
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
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (answers && request.isNavigationRequest() && /^\/[a-z]+$/.test(new URL(url).pathname)) {
      request.respond({ status: answers === '404.html' ? 404 : 200, contentType: 'text/html', body });
    } else if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) request.continue();
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

// first-paint.browser.mjs — what the one page shows and fetches before its app runs (index.html,
// start.js, build/start.mjs): the common header's frame, painted from the page itself on the routes
// that have it and drawn again by React on the same pixels — 1.3's header and brand — with nothing
// shifting; none of it where the page hands the visitor on to another file, which fetches none of the
// app either; and every module the page runs to draw an address asked for at once, by the list.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

// The data the build wrote into start.js.
const START = () => JSON.parse(readFileSync(join(builtSite(), 'start.js'), 'utf8').match(/const START = (\{.*\});/)[1]);

// A page in a context of its own whose requests are recorded (`page.asked`: url → resource type), with
// the bundle's entry held back until `page.release()`; `answers`: the file every clean address is
// answered with, as a host that answers each with the one page.
async function fresh(t, { size = { width: 1280, height: 900 }, answers = null } = {}) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setViewport(size);
  await page.setCacheEnabled(false);
  page.problems = [];
  page.on('pageerror', (e) => page.problems.push(`uncaught: ${e?.message || e}`));
  page.on('console', (msg) => { if (msg.type() === 'error') page.problems.push(`console: ${msg.text()}`); });
  await page.evaluateOnNewDocument(() => {
    window.__shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__shifts.push({ value: e.value, nodes: e.sources.map((s) => s.node?.className || s.node?.nodeName) });
    }).observe({ type: 'layout-shift', buffered: true });
  });
  const entry = `${origin}/${START().entry}`;
  const body = answers && readFileSync(join(builtSite(), answers));
  let held = null, released = false;
  page.asked = [];
  page.release = () => { released = true; held?.continue(); held = null; };
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    page.asked.push({ url: url.replace(origin, ''), type: request.resourceType() });
    if (answers && request.isNavigationRequest() && /^\/[a-z]+$/.test(new URL(url).pathname)) {
      request.respond({ status: 200, contentType: 'text/html', body });
    } else if (url === entry && !released) held = request;
    else if (url.startsWith(origin)) request.continue();
    else request.abort();
  });
  return page;
}

// The frame's boxes: the band, the brand and its two parts.
const frame = () => {
  const box = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r && [r.x, r.y, r.width, r.height]; };
  const header = document.querySelector('#root > header');
  return { frame: document.documentElement.dataset.frame ?? null, shown: !!header && getComputedStyle(header).display !== 'none',
    html: header?.outerHTML ?? null, mounted: !!document.querySelector('#root main'),
    band: box('#root > header'), clientWidth: document.documentElement.clientWidth,
    brand: box('.brand-wrap'), icon: box('.brand-icon'), text: box('.brand-text'), font: getComputedStyle(document.querySelector('.brand-text')).fontFamily,
    painted: performance.getEntriesByType('paint').some((e) => e.name === 'first-contentful-paint') };
};

// 1.3's header at every size (the baseline's tasks page, plans/frontend-react-probes): the band 54px
// high, the brand at 20px from the left.
const BRAND = { brand: [20, 14.5, 84.203125, 24], icon: [20, 14.5, 24, 24], text: [52, 16.5, 52.203125, 20] };

for (const [name, size] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
  test(`${name}: the header's frame is painted before the app runs, as 1.3 draws it, and React draws it on the same pixels`, async (t) => {
    const page = await fresh(t, { size });
    if (!page) return;
    await page.goto(`${origin}/components`, { waitUntil: 'domcontentloaded' });
    await until(page, async () => { await document.fonts.ready; return document.querySelector('.brand-icon img').complete && document.fonts.check('700 15px "JetBrains Mono"'); },
      undefined, { what: 'the frame\'s font and icon' });
    await until(page, () => performance.getEntriesByType('paint').length > 0, undefined, { what: 'a paint' });
    const painted = await page.evaluate(frame);
    assert.equal(painted.mounted, false, 'the app has not run (its entry is held back)');
    assert.deepEqual([painted.frame, painted.shown, painted.painted], ['header', true, true], 'the frame shows, painted');
    assert.match(painted.font, /JetBrains Mono/);
    for (const part of ['brand', 'icon', 'text']) assert.deepEqual(painted[part], BRAND[part], `${part}: where 1.3 has it`);
    assert.deepEqual(painted.band, [0, 0, size.width, 54], 'the band: the window\'s width, 54px');

    page.release();
    await until(page, () => document.title === 'Shiori — Components' && !!document.querySelector('#root main'), undefined, { what: 'the route drawn' });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const drawn = await page.evaluate(frame);
    assert.equal(drawn.html, painted.html, 'React draws the frame\'s own markup');
    for (const part of ['brand', 'icon', 'text']) assert.deepEqual(drawn[part], painted[part], `${part}: the same pixels`);
    assert.deepEqual([drawn.band[0], drawn.band[1], drawn.band[3], drawn.band[2]], [0, 0, 54, drawn.clientWidth], 'the band: as high, to the page\'s edge');
    assert.deepEqual(await page.evaluate(() => window.__shifts), [], 'nothing shifted');
    assert.deepEqual(page.problems, []);
  });
}

test('/tasks: the frame painted before the app runs; the page fills it with the brand where it was, and nothing shifts', async (t) => {
  const page = await fresh(t);
  if (!page) return;
  await page.goto(`${origin}/tasks`, { waitUntil: 'domcontentloaded' });
  await until(page, async () => { await document.fonts.ready; return document.querySelector('.brand-icon img').complete && document.fonts.check('700 15px "JetBrains Mono"'); },
    undefined, { what: 'the frame\'s font and icon' });
  await until(page, () => performance.getEntriesByType('paint').length > 0, undefined, { what: 'a paint' });
  const painted = await page.evaluate(frame);
  assert.deepEqual([painted.frame, painted.shown, painted.painted, painted.mounted], ['header', true, true, false], 'the frame shows, painted, before the app');
  for (const part of ['brand', 'icon', 'text']) assert.deepEqual(painted[part], BRAND[part], `${part}: where 1.3 has it`);
  page.release();
  await until(page, () => document.title === 'Shiori — Tasks' && !!document.getElementById('tkCount') && !document.getElementById('tkEmpty').hidden, undefined, { what: 'the page drawn' });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const drawn = await page.evaluate(frame);
  for (const part of ['brand', 'icon', 'text']) assert.deepEqual(drawn[part], painted[part], `${part}: the same pixels`);
  assert.deepEqual([drawn.band[0], drawn.band[1], drawn.band[3]], [0, 0, 54], 'the band where it was, as high');
  assert.deepEqual(await page.evaluate(() => window.__shifts), [], 'nothing shifted');
  assert.deepEqual(page.problems, []);
});

// 1.3's Settings header (the baseline's settings-library): the brand on Settings' 1.2 line, 12px in at
// 520px or less.
const SETTINGS_BRAND = (x) => ({ brand: [x, 14.5, 84.203125, 24], icon: [x, 14.5, 24, 24], text: [x + 32, 17.5, 52.203125, 18] });
for (const [name, size, x] of [['desktop', { width: 1280, height: 900 }, 20], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }, 12]]) {
  test(`${name}, Settings (/settings-next): the frame is painted in Settings' form before the app runs, as 1.3 draws it; the page fills it with the brand where it was`, async (t) => {
    const page = await fresh(t, { size });
    if (!page) return;
    await page.goto(`${origin}/settings-next`, { waitUntil: 'domcontentloaded' });
    await until(page, async () => { await document.fonts.ready; return document.querySelector('.brand-icon img').complete && document.fonts.check('700 15px "JetBrains Mono"'); },
      undefined, { what: 'the frame\'s font and icon' });
    await until(page, () => performance.getEntriesByType('paint').length > 0, undefined, { what: 'a paint' });
    const painted = await page.evaluate(frame);
    assert.deepEqual([painted.frame, painted.shown, painted.painted, painted.mounted], ['header', true, true, false], 'the frame shows, painted, before the app');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.headerForm), 'settings');
    for (const part of ['brand', 'icon', 'text']) assert.deepEqual(painted[part], SETTINGS_BRAND(x)[part], `${part}: where 1.3 has it`);
    page.release();
    await until(page, () => document.title === 'Shiori — Settings' && !!document.getElementById('libMergeSeries'), undefined, { what: 'the page drawn' });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const drawn = await page.evaluate(frame);
    for (const part of ['brand', 'icon', 'text']) assert.deepEqual(drawn[part], painted[part], `${part}: the same pixels`);
    assert.deepEqual([drawn.band[0], drawn.band[1], drawn.band[3]], [0, 0, 54], 'the band where it was, as high');
    assert.deepEqual(await page.evaluate(() => window.__shifts), [], 'nothing shifted');
    assert.deepEqual(page.problems, []);
  });
}

test('where the page hands the visitor on (the reader\'s address), no frame shows and none of the app is fetched', async (t) => {
  const page = await fresh(t, { answers: 'index.html' });   // a host answering every address with the one page
  if (!page) return;
  await page.goto(`${origin}/reader?g=1`, { waitUntil: 'domcontentloaded' });
  await until(page, () => performance.getEntriesByType('paint').length > 0 || document.readyState === 'complete', undefined, { what: 'the page parsed' });
  const held = await page.evaluate(() => ({ ...(() => { const h = document.querySelector('#root > header'); return { frame: document.documentElement.dataset.frame ?? null, shown: getComputedStyle(h).display !== 'none' }; })(),
    preloads: document.querySelectorAll('link[rel=modulepreload], link[rel=preload]').length }));
  assert.deepEqual(held, { frame: null, shown: false, preloads: 0 });
  page.release();
  await until(page, () => location.pathname === '/app/reader.html', undefined, { what: 'the reader\'s own file' });
  const before = page.asked.slice(0, page.asked.findIndex((r) => r.url.startsWith('/app/reader.html')));
  const scripts = before.filter((r) => r.type === 'script').map((r) => r.url);
  const { entry, start } = START();
  assert.ok(scripts.includes(`/${entry}`), 'the entry ran: it handed on');
  // What the entry imports statically it needs to run at all (the address map, the code that decides;
  // the build may put the latter in a chunk of its own when the app shares it).
  const own = [];
  const visit = (file) => {
    for (const [, spec] of readFileSync(join(builtSite(), file), 'utf8').matchAll(/(?:\bfrom|\bimport)\s*["'`](\.{1,2}\/[^"'`]+)["'`]/g)) {
      const url = new URL(spec, `${origin}/${file}`).pathname;
      if (!own.includes(url)) { own.push(url); visit(url.slice(1)); }
    }
  };
  visit(entry);
  assert.ok(own.some((url) => url === '/app/js/pages.js'), 'the entry reads the address map');
  assert.ok(own.length <= 4, `a few small files: ${own}`);
  assert.deepEqual(scripts.filter((url) => start.includes(url.slice(1))).filter((url) => !own.includes(url)), [],
    'nothing of the app, the start-up or a route: only what the entry needs to decide');
});

test('a hard load of /components asks for every module it runs at once, by the list, and for none the list did not name', async (t) => {
  const page = await fresh(t);
  if (!page) return;
  page.release();
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  await until(page, () => document.title === 'Shiori — Components' && !!document.querySelector('#root main'), undefined, { what: 'the route drawn' });
  await new Promise((r) => setTimeout(r, 500));
  const { entry, start, routes } = START();
  const listed = new Set([entry, ...start, ...routes.components.preload].map((f) => `/${f}`));
  const classic = new Set(['/app/font-init.js', '/start.js']);
  const modules = page.asked.filter((r) => r.type === 'script' && !classic.has(r.url)).map((r) => r.url);
  assert.ok(modules.length > 40, `the page ran its modules (${modules.length})`);
  assert.deepEqual(modules.filter((url) => !listed.has(url)), [], 'asked for, not on the list');
  // At once: each was asked for before the entry had even arrived, so before any module ran and
  // could import it.
  const late = await page.evaluate((entry) => {
    const all = performance.getEntriesByType('resource').filter((e) => /\.m?js$/.test(new URL(e.name).pathname) && !/\/(start|font-init)\.js$/.test(e.name));
    const first = all.find((e) => e.name.endsWith(`/${entry}`));
    return all.filter((e) => e.startTime >= first.responseEnd).map((e) => `${new URL(e.name).pathname} at ${Math.round(e.startTime)} ms, the entry arrived at ${Math.round(first.responseEnd)}`);
  }, entry);
  assert.deepEqual(late, [], 'asked for later, by an import');
  // The UI font's faces with them, each once, there before the app drew its text.
  const faces = readdirSync(join(builtSite(), 'app', 'fonts')).filter((f) => /^JetBrainsMono-.+\.woff2$/.test(f)).map((f) => `/app/fonts/${f}`);
  const fonts = page.asked.filter((r) => r.url.startsWith('/app/fonts/')).map((r) => r.url);
  assert.deepEqual(fonts.toSorted(), faces.toSorted());
  assert.deepEqual(await page.evaluate(() => [...document.fonts].filter((f) => /JetBrains Mono/.test(f.family)).map((f) => f.status)), ['loaded', 'loaded', 'loaded']);
  assert.deepEqual(await page.evaluate(() => window.__shifts), [], 'nothing shifted, the coming of the font included');
  assert.deepEqual(page.problems, []);
});

// first-paint.browser.mjs — what the one page shows and fetches before its app runs (index.html,
// start.js, build/start.mjs): the common header's frame, painted from the page itself on the routes
// that have it and drawn again by React on the same pixels — 1.3's header and brand — with nothing
// shifting; and every module the page runs to draw an address asked for at once, by the list.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { builtSite } from '../../../build/built.mjs';
import { LOCALES } from '../../js/locales.js';

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
// the bundle's entry held back until `page.release()`.
async function fresh(t, { size = { width: 1280, height: 900 } } = {}) {
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
  let held = null, released = false;
  page.asked = [];
  page.release = () => { released = true; held?.continue(); held = null; };
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    page.asked.push({ url: url.replace(origin, ''), type: request.resourceType() });
    if (url === entry && !released) held = request;
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

// The header on every page (1.3's, by the baseline's tasks page, plans/frontend-react-probes): the band
// 54px high, the brand 20px from the left; 12px at 600px or less, on every page alike (1.3's library
// and Settings had 12 there and its Tasks 20: one header now, so the logo does not move between pages).
const BRAND_AT = (x) => ({ brand: [x, 14.5, 84.203125, 24], icon: [x, 14.5, 24, 24], text: [x + 32, 16.5, 52.203125, 20] });
const BRAND = BRAND_AT(20);

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
    for (const part of ['brand', 'icon', 'text']) assert.deepEqual(painted[part], BRAND_AT(size.width <= 600 ? 12 : 20)[part], `${part}: where every page has it`);
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

// The library, at the site's root and at /library: the frame painted before the app runs, React's header
// on its pixels with the page's parts in it, nothing shifting as the page and its cards come.
for (const path of ['/', '/library']) test(`${path}: the frame painted before the app runs; the page fills it with the brand where it was, and nothing shifts`, async (t) => {
  const page = await fresh(t);
  if (!page) return;
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
  await until(page, async () => { await document.fonts.ready; return document.querySelector('.brand-icon img').complete && document.fonts.check('700 15px "JetBrains Mono"'); },
    undefined, { what: 'the frame\'s font and icon' });
  await until(page, () => performance.getEntriesByType('paint').length > 0, undefined, { what: 'a paint' });
  const painted = await page.evaluate(frame);
  assert.deepEqual([painted.frame, painted.shown, painted.painted, painted.mounted], ['header', true, true, false], 'the frame shows, painted, before the app');
  for (const part of ['brand', 'icon', 'text']) assert.deepEqual(painted[part], BRAND[part], `${part}: where 1.3 has it`);
  page.release();
  await until(page, () => document.title === 'Shiori — Library' && !!document.getElementById('searchBox') && document.getElementById('hTotalGalleries')?.textContent !== '—', undefined, { what: 'the page drawn' });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const drawn = await page.evaluate(frame);
  for (const part of ['brand', 'icon', 'text']) assert.deepEqual(drawn[part], painted[part], `${part}: the same pixels`);
  assert.deepEqual([drawn.band[0], drawn.band[1], drawn.band[3]], [0, 0, 54], 'the band where it was, as high');
  assert.deepEqual(await page.evaluate(() => window.__shifts), [], 'nothing shifted');
  assert.deepEqual(page.problems, []);
});

for (const [path, segment] of [['/', ''], ['/library', 'library']]) test(`a hard load of ${path} asks for every module it runs at once, by the list, and for none the list did not name`, async (t) => {
  const page = await fresh(t);
  if (!page) return;
  page.release();
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await until(page, () => document.title === 'Shiori — Library' && !!document.getElementById('grid'), undefined, { what: 'the route drawn' });
  await new Promise((r) => setTimeout(r, 500));
  const { entry, start, routes } = START();
  const listed = new Set([entry, ...start, ...routes[segment].preload].map((f) => `/${f}`));
  const classic = new Set(['/app/font-init.js', '/start.js']);
  const modules = page.asked.filter((r) => r.type === 'script' && !classic.has(r.url)).map((r) => r.url);
  assert.ok(modules.length > 40, `the page ran its modules (${modules.length})`);
  assert.deepEqual(modules.filter((url) => !listed.has(url)), [], 'asked for, not on the list');
  // The route's stylesheets are on its list too (the gallery card's, in a chunk two routes share); the
  // page's own, which index.html links in its head, is not.
  const styles = page.asked.filter((r) => r.type === 'stylesheet' && r.url.startsWith('/assets/')).map((r) => r.url);
  const own = `/${readFileSync(join(builtSite(), 'index.html'), 'utf8').match(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"/)[1]}`;
  assert.ok(styles.includes(own), `the page's own stylesheet (${own}) asked for`);
  assert.equal(listed.has(own), false, 'the page\'s own stylesheet is not on the list as well');
  assert.deepEqual(styles.filter((url) => !listed.has(url) && url !== own), [], 'a stylesheet not on the list');
  const late = await page.evaluate((entry) => {
    const all = performance.getEntriesByType('resource').filter((e) => /\.m?js$/.test(new URL(e.name).pathname) && !/\/(start|font-init)\.js$/.test(e.name));
    const first = all.find((e) => e.name.endsWith(`/${entry}`));
    // (Not the start's: what the page's upkeep asks for, a second after the load and on (boot-core.js:
    // migrations.js, then storage-upgrade.js). Where the route was drawn late, this read came after it.)
    const upkeep = performance.getEntriesByType('navigation')[0].loadEventEnd + 1000;
    return all.filter((e) => e.startTime >= first.responseEnd && e.startTime < upkeep).map((e) => `${new URL(e.name).pathname} at ${Math.round(e.startTime)} ms, the entry arrived at ${Math.round(first.responseEnd)}`);
  }, entry);
  assert.deepEqual(late, [], 'asked for later, by an import');
  assert.deepEqual(page.problems, []);
});

// A stylesheet is fetched once: the page's own (index.html links it in its head) is not on a route's list
// as well, and a route's is preloaded as the bundle then links it (a CORS request: a preload asked for
// another way is not used, and the stylesheet came twice), the app's served ones plainly.
for (const path of ['/library', '/settings', '/tasks', '/overview?g=1', '/reader?g=1']) {
  test(`a hard load of ${path} fetches each stylesheet once`, async (t) => {
    const page = await fresh(t);
    if (!page) return;
    page.release();
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    // Drawn, and every stylesheet it preloaded linked.
    await until(page, () => !!document.querySelector('#root > :not(header), .reader-frame') && [...document.querySelectorAll('link[rel="preload"][as="style"]')]
      .every((p) => [...document.querySelectorAll('link[rel="stylesheet"]')].some((s) => s.href === p.href)), undefined, { what: 'the route drawn, its stylesheets linked' });
    await new Promise((r) => setTimeout(r, 1000));
    const styles = page.asked.filter((r) => /\.css$/.test(new URL(r.url, origin).pathname)).map((r) => r.url);
    assert.ok(styles.some((url) => url.startsWith('/assets/')), `the page's stylesheet was asked for (${styles.join(', ')})`);
    assert.deepEqual(styles.filter((url, i) => styles.indexOf(url) !== i), [], 'asked for twice');
    assert.deepEqual(page.problems, []);
  });
}

// Settings' header is the common one (1.3's Settings page had a header of its own: the brand on a 1.2
// line, 12px in at 520px or less).
const SETTINGS_BRAND = BRAND_AT;
for (const [name, size, x] of [['desktop', { width: 1280, height: 900 }, 20], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }, 12]]) {
  test(`${name}, Settings (/settings): the frame is painted before the app runs, the brand where every page has it; the page fills it with the brand where it was`, async (t) => {
    const page = await fresh(t, { size });
    if (!page) return;
    await page.goto(`${origin}/settings`, { waitUntil: 'domcontentloaded' });
    await until(page, async () => { await document.fonts.ready; return document.querySelector('.brand-icon img').complete && document.fonts.check('700 15px "JetBrains Mono"'); },
      undefined, { what: 'the frame\'s font and icon' });
    await until(page, () => performance.getEntriesByType('paint').length > 0, undefined, { what: 'a paint' });
    const painted = await page.evaluate(frame);
    assert.deepEqual([painted.frame, painted.shown, painted.painted, painted.mounted], ['header', true, true, false], 'the frame shows, painted, before the app');
    for (const part of ['brand', 'icon', 'text']) assert.deepEqual(painted[part], SETTINGS_BRAND(x)[part], `${part}: where every page has it`);
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

// What recognises the app by its shiori-app meta may look once, as a page loads (1.3's pages carried it
// in their markup): the one page has it before its app runs, and the app keeps that element.
test('the shiori-app meta is in the page before the app runs, on the app\'s own pages alone, and the app keeps that element', async (t) => {
  const page = await fresh(t);
  if (!page) return;
  const metas = () => page.evaluate(() => [...document.querySelectorAll('meta[name="shiori-app"]')].map((m) => m.content));
  await page.goto(`${origin}/tasks`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => !!document.querySelector('#root main')), false, 'the app has not run (its entry is held back)');
  assert.deepEqual(await metas(), ['tasks'], 'there once the page is parsed');
  await page.evaluate(() => { window.__meta = document.querySelector('meta[name="shiori-app"]'); });
  page.release();
  await until(page, () => document.title === 'Shiori — Tasks' && !!document.querySelector('#root main'), undefined, { what: 'the route drawn' });
  assert.deepEqual(await metas(), ['tasks']);
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="shiori-app"]') === window.__meta), true, 'the app keeps the element');
  // A page that is not the app's own takes it away; back on the app's, the same element.
  await page.evaluate(() => { const a = document.createElement('a'); a.href = '/components'; a.id = 'toOther'; document.body.append(a); });
  await page.$eval('#toOther', (a) => a.click());
  await until(page, () => document.title === 'Shiori — Components', undefined, { what: 'another page' });
  assert.deepEqual(await metas(), []);
  await page.evaluate(() => history.back());
  await until(page, () => document.title === 'Shiori — Tasks', undefined, { what: 'Tasks again' });
  assert.deepEqual(await metas(), ['tasks']);
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="shiori-app"]') === window.__meta), true, 'the same element again');
  assert.deepEqual(page.problems, []);

  // A page that is not the app's own, opened first: none, before the app runs and after.
  const other = await fresh(t);
  await other.goto(`${origin}/components`, { waitUntil: 'domcontentloaded' });
  assert.equal(await other.evaluate(() => document.querySelectorAll('meta[name="shiori-app"]').length), 0);
  other.release();
  await until(other, () => document.title === 'Shiori — Components' && !!document.querySelector('#root main'), undefined, { what: 'the route drawn' });
  assert.equal(await other.evaluate(() => document.querySelectorAll('meta[name="shiori-app"]').length), 0);
});

test('the library says it is the library in the shiori-app meta from its first parse, at / and at /library, as on 1.3', async (t) => {
  for (const path of ['/', '/library', '/?q=x&page=2']) {
    const page = await fresh(t);
    if (!page) return;
    await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => !!document.querySelector('#root main')), false, 'the app has not run (its entry is held back)');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('meta[name="shiori-app"]')].map((m) => m.content)), ['library'], `${path}: there once the page is parsed`);
    page.release();
    await until(page, () => document.title === 'Shiori — Library' && !!document.querySelector('#root main.library-page'), undefined, { what: 'the library drawn' });
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('meta[name="shiori-app"]')].map((m) => m.content)), ['library']);
    assert.deepEqual(page.problems, []);
  }
});

// The reader, drawn by the one page since its switch (2026-11-26; until then the one address this page
// handed on, to the reader's own file, and the only one, so the case went with it): it says it is the
// reader from its first parse, as 1.3's page said it in its markup, and until the reader draws its frame
// the window shows the reader's ground and nothing else (html[data-frame="reader"]: no header band).
test('the reader says it is the reader in the shiori-app meta from its first parse, and shows its ground before the app runs, as on 1.3', async (t) => {
  for (const path of ['/reader?g=1', '/reader?g=1&page=3']) {
    const page = await fresh(t);
    if (!page) return;
    await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
    await until(page, () => performance.getEntriesByType('paint').length > 0, undefined, { what: 'the first paint' });
    const held = await page.evaluate(() => ({ app: !!document.querySelector('#root .reader-frame'), meta: [...document.querySelectorAll('meta[name="shiori-app"]')].map((m) => m.content),
      frame: document.documentElement.dataset.frame ?? null, ground: getComputedStyle(document.body).backgroundColor, header: getComputedStyle(document.querySelector('#root > header')).display }));
    assert.deepEqual(held, { app: false, meta: ['reader'], frame: 'reader', ground: 'rgb(10, 10, 12)', header: 'none' }, `${path}: before the app runs (its entry held back)`);
    page.release();
    await until(page, () => document.title.startsWith('Shiori — ') && !!document.querySelector('#root > .reader-frame #emptyScreen'), undefined, { what: 'the reader drawn' });
    assert.deepEqual(await page.evaluate(() => ({ meta: [...document.querySelectorAll('meta[name="shiori-app"]')].map((m) => m.content), frame: document.documentElement.dataset.frame ?? null,
      ground: getComputedStyle(document.body).backgroundColor })), { meta: ['reader'], frame: null, ground: 'rgb(10, 10, 12)' }, `${path}: drawn, its own ground`);
    assert.deepEqual(page.problems, []);
  }
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
    // (Not the start's: what the page's upkeep asks for, a second after the load and on (boot-core.js:
    // migrations.js, then storage-upgrade.js). Where the route was drawn late, this read came after it.)
    const upkeep = performance.getEntriesByType('navigation')[0].loadEventEnd + 1000;
    return all.filter((e) => e.startTime >= first.responseEnd && e.startTime < upkeep).map((e) => `${new URL(e.name).pathname} at ${Math.round(e.startTime)} ms, the entry arrived at ${Math.round(first.responseEnd)}`);
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

// No flash of unstyled or unworded content, on every page, in English and in Japanese: every frame from
// the navigation on (an animation frame callback from the document's start), the CPU slowed six times,
// the page's ground is its last frame's from the first frame that has a body, the common header (where it
// shows) is its band of 54px, and no frame shows a word of another language or a key in place of a word.
// (The language's words are fetched as the page starts, src/start.js and app/js/i18n.js.)
const G_WORDS = '1790000000931';
const WORDS_PAGES = [['the library', '/'], ['an overview', `/overview?g=${G_WORDS}`], ['the reader', `/reader?g=${G_WORDS}&page=1`], ['Settings', '/settings'], ['Tasks', '/tasks']];
const KEYS = new Set(Object.keys(LOCALES.en));
// A language's words that are no other's: what a frame of the other language must not show.
const own = (lang, other) => new Set(Object.entries(LOCALES[lang]).filter(([k, v]) => v.length >= 4 && v !== LOCALES[other][k] && !Object.values(LOCALES[other]).includes(v)).map(([, v]) => v));
const NOT_SHOWN = { en: own('ja', 'en'), ja: own('en', 'ja') };
for (const lang of ['en', 'ja']) for (const [name, path] of WORDS_PAGES) {
  test(`${name} in ${lang === 'en' ? 'English' : 'Japanese'}, the CPU slowed six times: from its first frame, styled and in its own words`, async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const context = await browser.createBrowserContext();
    t.after(() => context.close());
    const page = await context.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCacheEnabled(false);
    page.problems = [];
    page.on('pageerror', (e) => page.problems.push(`uncaught: ${e?.message || e}`));
    await page.setRequestInterception(true);
    page.on('request', (r) => (r.url().startsWith(origin) || /^(data|blob):/.test(r.url()) ? r.continue() : r.abort()));
    // The library this context has: one gallery of two pages.
    await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
    await page.evaluate(async (gid, lang) => {
      localStorage.setItem('shiori-lang', lang);
      localStorage.setItem('shiori:translateSettings', JSON.stringify({ serverUrl: 'http://127.0.0.1:9' }));
      const api = await import('/app/js/api.js');
      const c = new OffscreenCanvas(300, 430);
      c.getContext('2d').fillRect(0, 0, 300, 430);
      await api.meta.put({ galleryId: gid, title: { english: 'Words', japanese: '', pretty: '' }, tags: [], numPages: 2 });
      for (const n of [1, 2]) await api.pages.put(gid, n, await c.convertToBlob({ type: 'image/png' }));
    }, G_WORDS, lang);
    await page.evaluateOnNewDocument(() => {
      const frames = (window.__frames = []);
      const tick = () => {
        if (document.body) {
          const texts = [];
          const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const text = n.nodeValue.trim();
            if (text && n.parentElement?.checkVisibility?.({ visibilityProperty: true })) texts.push(text);
          }
          const header = document.querySelector('#root > header');
          frames.push({ ground: getComputedStyle(document.body).backgroundColor, header: header && getComputedStyle(header).display !== 'none' ? header.getBoundingClientRect().height : null, texts });
        }
        if (frames.length < 400) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    await until(page, () => window.__frames.length >= 60 && document.title.startsWith('Shiori — '), undefined, { what: 'the page drawn (its title set), and sixty frames', timeout: 60000 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const frames = await page.evaluate(() => window.__frames);
    const last = frames[frames.length - 1];
    assert.ok(last.texts.length > 0, 'the page has words');
    frames.forEach((f, i) => {
      assert.equal(f.ground, last.ground, `frame ${i}: the page's own ground`);
      if (f.header != null) assert.equal(f.header, 54, `frame ${i}: the header's band`);
      const wrong = f.texts.filter((text) => KEYS.has(text) || NOT_SHOWN[lang].has(text));
      assert.deepEqual(wrong, [], `frame ${i}: a key, or the other language's words`);
    });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.frame ?? null), path.startsWith('/reader') ? null : 'header');
    assert.deepEqual(page.problems, []);
  });
}

// The page says its language from its start, as 1.3's pages did: figures are written in it (format.js
// reads <html lang>), and a browser chooses letter shapes and breaks words by it. (The one page said
// "en" in every language until the language was changed in that tab: a German reader's 1.234.567
// was written 1,234,567.)
test('the page says its language from its start, and figures are written in it', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  for (const [lang, figure] of [['de', '1.234.567'], ['ja', '1,234,567'], ['en', '1,234,567']]) {
    for (const path of ['/tasks', '/']) {
      const page = await browser.newPage();
      await page.setBypassServiceWorker(true);
      await page.evaluateOnNewDocument((lang) => { localStorage.setItem('shiori-lang', lang); }, lang);
      await page.goto(`${origin}${path}`, { waitUntil: 'load' });
      await until(page, () => !!document.querySelector('#root main, #tkList, #grid'), null, { what: `${path} in ${lang}` });
      const seen = await page.evaluate(async () => ({ lang: document.documentElement.lang, figure: (await import('/app/js/format.js')).formatCount(1234567) }));
      assert.deepEqual(seen, { lang, figure }, `${path} in ${lang}`);
      await page.close();
    }
  }
});

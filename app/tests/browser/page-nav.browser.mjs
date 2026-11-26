// page-nav.browser.mjs — the header's page name is a menu of the app's pages (page-nav.js; on a page
// the one page draws, PageMenu): each page
// names itself and offers the others (a gallery's overview only where there is a gallery, the reader
// only in the reader); picking one goes there. On a phone it stays where the brand's word gives way;
// in the reader's classic bar at 430px and under (the narrow bar, A3) it leaves the bar, its other
// pages rows of the "⋯" list under "Go to", and the bar fits.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const GID = '1790000000301';
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async (gid) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'A gallery', japanese: '', pretty: '' }, tags: [], numPages: 2 });
    for (let n = 1; n <= 2; n++) {
      const c = new OffscreenCanvas(60, 90);
      c.getContext('2d').fillRect(0, 0, 60, 90);
      await api.pages.put(gid, n, await c.convertToBlob({ type: 'image/png' }));
    }
    localStorage.setItem('shiori-reader-nav', 'top');   // the classic bar, the one with the menu
    localStorage.setItem('shiori-reader-pin', '1');
  }, GID);
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

async function visit(t, path, viewport) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  if (viewport) await page.setViewport(viewport);
  await page.goto(origin + path, { waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('#pageNav option').length > 1, null, { what: 'the page menu' });
  return page;
}
const offered = (page) => page.$$eval('#pageNav option', os => os.map(o => `${o.value}${o.selected ? '*' : ''}`));
// Picking `value`, then the page it goes to, loaded. Told by the path, not by the next navigation: a page
// may replace its own address just after it shows (the library's syncUrl), which waitForNavigation took
// for the pick's (S16: it failed so most runs alone).
const go = async (page, value) => {
  const from = new URL(page.url()).pathname;
  await page.select('#pageNav', value);
  await page.waitForFunction((from) => location.pathname !== from && document.readyState === 'complete', {}, from);
  return new URL(page.url());
};

// The menu of a page the one page draws (PageMenu, ui-page-menu.browser): a list drawn under a pointer,
// not the page's own <select>. Its options as words, the page's own marked; then `nth` (1-based) chosen.
async function drawnMenu(page, nth) {
  await page.click('#pageNav');
  await page.waitForSelector('[data-slot="select-list"] [data-slot="select-option"]');
  await new Promise((r) => setTimeout(r, 300));   // (a press in the list's first moments is not taken as a choice)
  const options = await page.$$eval('[data-slot="select-list"] [data-slot="select-option"]', (os) => os.map((o) => `${o.textContent}${o.hasAttribute('data-selected') ? '*' : ''}`));
  if (nth) await page.click(`[data-slot="select-list"] [data-slot="select-option"]:nth-child(${nth})`);
  return options;
}
// A page the one page draws (its menu's own markup: no options to wait for).
async function visitDrawn(t, path) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.goto(origin + path, { waitUntil: 'load' });
  await page.waitForSelector('#pageNav[data-page]');
  return page;
}

test('each page names itself in the menu and offers the others; picking one goes there', { skip: !chromePath() }, async t => {
  // The library and Tasks are drawn by the one page: their menus are the app's, and a pick a route change.
  const page = await visitDrawn(t, '/library');
  await page.waitForSelector('#pageNav[data-page="library"]');
  await page.evaluate(() => { window.stayed = true; });
  assert.deepEqual(await drawnMenu(page, 3), ['Library*', 'Settings', 'Tasks'], 'no overview without a gallery, no reader outside it');
  await until(page, () => location.pathname === '/tasks' && !!document.getElementById('tkList'), null, { what: 'Tasks' });
  await page.waitForSelector('#pageNav[data-page="tasks"]');
  assert.deepEqual(await drawnMenu(page, 2), ['Library', 'Settings', 'Tasks*']);
  // Settings, drawn by the one page too: a route change.
  await until(page, () => location.pathname === '/settings' && document.title === 'Shiori — Settings' && !!document.getElementById('settingsNav'), null, { what: 'Settings' });
  await page.waitForSelector('#pageNav[data-page="settings"]');
  assert.deepEqual(await drawnMenu(page, 1), ['Library', 'Settings*', 'Tasks']);
  await until(page, () => location.pathname === '/' && document.title === 'Shiori — Library' && !!document.querySelector('#root main.library-page'), null, { what: 'the library' });
  assert.equal(await page.evaluate(() => window.stayed), true, 'no page load');

  // The overview, drawn by the one page since its switch: its menu the app's, a pick a route change.
  const overview = await visitDrawn(t, `/overview?g=${GID}`);
  await overview.waitForSelector('#pageNav[data-page="overview"]');
  await overview.evaluate(() => { window.stayed = true; });
  assert.deepEqual(await drawnMenu(overview, 1), ['Library', 'Overview*', 'Settings', 'Tasks']);
  await until(overview, () => location.pathname === '/' && document.title === 'Shiori — Library' && !!document.querySelector('#root main.library-page') && document.querySelector('meta[name="shiori-app"]')?.content === 'library', null, { what: 'the library, drawn by the one page' });
  assert.equal(await overview.evaluate(() => window.stayed), true, 'the overview\'s menu: no page load');

  // The reader, drawn by the one page since its switch (2026-11-26): its menu its own (page-nav.js), a pick
  // a route change.
  const reader = await visit(t, `/reader?g=${GID}`);
  await reader.evaluate(() => { window.stayed = true; });
  assert.deepEqual(await offered(reader), ['library', 'overview', 'reader*', 'settings', 'tasks']);
  const to = await go(reader, 'overview');
  assert.deepEqual([to.pathname, to.searchParams.get('g')], ['/overview', GID], "the gallery's own overview");
  await until(reader, () => document.title === 'Shiori — Series' && !!document.querySelector('#ovContent .ov-hero') && document.querySelector('meta[name="shiori-app"]')?.content === 'overview', null, { what: 'the overview, drawn by the one page' });
  assert.equal(await reader.evaluate(() => window.stayed), true, "the reader's menu: no page load");
});

// Every way into Settings from the library (drawn by the one page: a route change) and from a page that
// still has a file of its own (its menu, its Settings button) arrives at /settings, drawn by the one
// page (its nav, the shiori-app meta saying so); 1.3's Settings read nothing from the address it was
// opened at, so nothing more is asked of it.
test('every link into Settings from the library, an overview and the reader arrives at Settings, drawn by the one page', { skip: !chromePath() }, async t => {
  // (Every page is drawn by the one page: the library's and the overview's menu and Settings button, and the
  // reader's menu, a route change.)
  const arrived = (page) => until(page, () => location.pathname === '/settings' && location.search === '' && document.title === 'Shiori — Settings'
    && !!document.getElementById('settingsNav') && document.querySelector('meta[name="shiori-app"]')?.content === 'settings', null, { what: 'Settings' });
  for (const [path, nth] of [['/library', 2], [`/overview?g=${GID}`, 3]]) {
    for (const how of ['menu', 'button']) {
      const page = await visitDrawn(t, path);
      await page.evaluate(() => { window.stayed = true; });
      if (how === 'menu') await drawnMenu(page, nth); else await page.click('#settingsBtn');
      await arrived(page);
      assert.equal(await page.evaluate(() => window.stayed), true, `${path}: its ${how}, no page load`);
    }
  }
  for (const path of [`/reader?g=${GID}`]) {
    const page = await visit(t, path);
    await page.evaluate(() => { window.stayed = true; });
    await go(page, 'settings');
    await arrived(page);
    assert.equal(await page.evaluate(() => window.stayed), true, `${path}: its menu, no page load`);
    assert.deepEqual(page.problems, [], `${path}: its menu`);
  }
});

// Every way to the library arrives at it, drawn by the one page at the site's root: the reader's Home and
// the brand on every page (Tasks, Settings, the overview and, since its switch, the reader: a route
// change), the menus (above), the installed app's start (the web manifest's start_url).
test('every way to the library arrives at it, drawn by the one page', { skip: !chromePath() }, async t => {
  const arrived = (page) => until(page, () => location.pathname === '/' && document.title === 'Shiori — Library' && !!document.querySelector('#root main.library-page #grid')
    && document.querySelector('meta[name="shiori-app"]')?.content === 'library', null, { what: 'the library' });
  for (const [path, home] of [[`/reader?g=${GID}`, '#snHome']]) {
    const page = await visit(t, path);
    await page.evaluate(() => { window.stayed = true; });
    // (The reader's bars may be out of sight: its Home pressed as a link is.)
    await page.evaluate((home) => document.querySelector(home).click(), home);
    await arrived(page);
    assert.equal(await page.evaluate(() => window.stayed), true, `${path}: its Home, no page load`);
  }
  for (const path of ['/tasks', '/settings', `/overview?g=${GID}`]) {
    const page = await visitDrawn(t, path);
    await page.evaluate(() => { window.stayed = true; });
    await page.click('.brand-wrap');
    await arrived(page);
    assert.equal(await page.evaluate(() => window.stayed), true, `${path}: the brand, no page load`);
  }
  const page = await visitDrawn(t, '/tasks');
  const start = await page.evaluate(async () => { const url = new URL('/app/manifest.webmanifest', location.href); return new URL((await (await fetch(url)).json()).start_url, url).pathname; });
  assert.equal(start, '/', 'the installed app starts at the root of the site');
});

test("on a phone the menu stays in every header; the reader's classic bar fits, its pages in the \"⋯\" list there", { skip: !chromePath() }, async t => {
  for (const [path, width] of [['/library', 390], ['/settings', 360], ['/tasks', 384], [`/overview?g=${GID}`, 384], [`/reader?g=${GID}`, 420], [`/reader?g=${GID}`, 390], [`/reader?g=${GID}`, 360]]) {
    const page = await visit(t, path, { width, height: 700, hasTouch: true, isMobile: true });
    const state = await page.evaluate(() => {
      const menu = document.getElementById('pageNav'), bar = menu.closest('header, #topbar'), r = menu.getBoundingClientRect();
      const listed = [...document.querySelectorAll('#topbar [data-page-link]')].filter((a) => !a.hidden).map((a) => a.dataset.pageLink);
      return { shown: r.width > 0 && r.right <= innerWidth, fits: bar.scrollWidth <= bar.clientWidth, listed };
    });
    const narrow = path.startsWith('/reader') && width <= 430;
    assert.deepEqual(state, { shown: !narrow, fits: true, listed: path.startsWith('/reader') ? ['overview', 'settings'] : [] }, `${path} at ${width}px`);
  }
});

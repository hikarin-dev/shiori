// page-nav.browser.mjs — the header's page name is a menu of the app's pages (page-nav.js; on a page
// the one page draws, PageMenu): each page
// names itself and offers the others (a gallery's overview only where there is a gallery, the reader
// only in the reader); picking one goes there. On a phone it stays where the brand's word gives way,
// and the reader's classic bar still fits.
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
  await page.goto(`${origin}/library`, { waitUntil: 'load' });
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

test('each page names itself in the menu and offers the others; picking one goes there', { skip: !chromePath() }, async t => {
  const page = await visit(t, '/library');
  assert.deepEqual(await offered(page), ['library*', 'settings', 'tasks'], 'no overview without a gallery, no reader outside it');
  assert.equal((await go(page, 'tasks')).pathname, '/tasks');
  // Tasks is drawn by the one page: its menu is the app's (PageMenu, ui-page-menu.browser), a list
  // drawn under a pointer, not the page's own <select>.
  await page.waitForSelector('#pageNav[data-page="tasks"]');
  await page.click('#pageNav');
  await page.waitForSelector('[data-slot="select-list"] [data-slot="select-option"]');
  await new Promise((r) => setTimeout(r, 300));   // (a press in the list's first moments is not taken as a choice)
  assert.deepEqual(await page.$$eval('[data-slot="select-list"] [data-slot="select-option"]', (os) => os.map((o) => `${o.textContent}${o.hasAttribute('data-selected') ? '*' : ''}`)),
    ['Library', 'Settings', 'Tasks*']);
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('[data-slot="select-list"] [data-slot="select-option"]:nth-child(2)')]);
  assert.equal(new URL(page.url()).pathname, '/settings');

  const overview = await visit(t, `/overview?g=${GID}`);
  assert.deepEqual(await offered(overview), ['library', 'overview*', 'settings', 'tasks']);
  assert.equal((await go(overview, 'library')).pathname, '/', 'the library, at the site root as the brand links');

  const reader = await visit(t, `/reader?g=${GID}`);
  assert.deepEqual(await offered(reader), ['library', 'overview', 'reader*', 'settings', 'tasks']);
  const to = await go(reader, 'overview');
  assert.deepEqual([to.pathname, to.searchParams.get('g')], ['/overview', GID], "the gallery's own overview");
});

test("on a phone the menu stays in every header, and the reader's classic bar still fits", { skip: !chromePath() }, async t => {
  for (const [path, width] of [['/library', 390], ['/settings', 360], ['/tasks', 384], [`/overview?g=${GID}`, 384], [`/reader?g=${GID}`, 390], [`/reader?g=${GID}`, 360]]) {
    const page = await visit(t, path, { width, height: 700, hasTouch: true, isMobile: true });
    const state = await page.evaluate(() => {
      const menu = document.getElementById('pageNav'), bar = menu.closest('header, #topbar'), r = menu.getBoundingClientRect();
      return { shown: r.width > 0 && r.right <= innerWidth, fits: bar.scrollWidth <= bar.clientWidth };
    });
    assert.deepEqual(state, { shown: true, fits: true }, `${path} at ${width}px`);
  }
});

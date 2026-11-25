// ui-page-menu.browser.mjs — PageMenu (src/components/ui/page-menu.tsx) as /components shows it: the
// pages it offers (a gallery's overview only where the address names a gallery, the reader only in
// the reader), and choosing one: a plain page load for a page that still has a file of its own, a
// route change (no load) for one the one page draws; under a coarse pointer the system's picker (T15),
// as wide as the drawn box. (Since the overview's switch, 2026-11-25, every page it offers outside the
// reader is drawn by the one page: the reader, the one page left with a file of its own, is offered only
// in the reader, whose menu is its own page's. Until then a gallery's overview was the page it loaded.)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { componentsPage, spec } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const MENU = spec('page-menu', 'library');

async function offered(page, sel) {
  await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(sel);
  await page.waitForSelector('[data-slot="select-list"] [data-slot="select-option"]');
  await new Promise((r) => setTimeout(r, 300));   // (a press in the list's first moments is not taken as a choice)
  const names = await page.$$eval('[data-slot="select-list"] [data-slot="select-option"]', (els) => els.map((e) => e.textContent));
  return names;
}

test('the pages it offers, and its box', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  assert.deepEqual(await page.$eval(MENU, (el) => [el.className.includes('page-nav'), el.dataset.page, el.getAttribute('aria-label'), el.getBoundingClientRect().height, el.textContent]),
    [true, 'library', 'Go to page', 26, 'Library']);
  assert.deepEqual(await offered(page, MENU), ['Library', 'Settings', 'Tasks'], 'no overview without a gallery, no reader outside it');
  await page.keyboard.press('Escape');
  // An address naming a gallery: its overview is offered too.
  await page.goto(`${origin}/components?g=1790000001058`, { waitUntil: 'load' });
  await page.waitForSelector(MENU);
  assert.deepEqual(await offered(page, MENU), ['Library', 'Overview', 'Settings', 'Tasks']);
  assert.deepEqual(page.problems, []);
});

test('choosing a gallery\'s overview is a route change to its clean address, no load', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  // (The library is the menu's own page here: a gallery's overview is offered once the address names a
  // gallery.)
  await page.goto(`${origin}/components?g=1790000001058`, { waitUntil: 'load' });
  await page.waitForSelector(MENU);
  await page.evaluate(() => { window.stayed = true; });
  assert.deepEqual(await offered(page, MENU), ['Library', 'Overview', 'Settings', 'Tasks']);
  await page.click('[data-slot="select-list"] [data-slot="select-option"]:nth-child(2)');
  await until(page, () => location.pathname === '/overview' && document.title === 'Shiori — Series' && !!document.getElementById('ovContent'), undefined, { what: 'the overview drawn' });
  assert.deepEqual(await page.evaluate(() => [window.stayed ?? null, location.pathname + location.search]), [true, '/overview?g=1790000001058'], 'a route change, at its clean address');
  assert.deepEqual(page.problems, []);
});

test('choosing a page the one page draws is a route change, no load', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await page.evaluate(() => { window.stayed = true; });
  await offered(page, MENU);
  await page.click('[data-slot="select-list"] [data-slot="select-option"]:nth-child(3)');
  await until(page, () => location.pathname === '/tasks', undefined, { what: 'the address' });
  await until(page, () => document.title === 'Shiori — Tasks' && !!document.getElementById('tkList'), undefined, { what: 'the Tasks page drawn' });
  assert.equal(await page.evaluate(() => window.stayed), true, 'no page load');
  assert.deepEqual(page.problems, []);
});

test('under a coarse pointer it is the system\'s picker, as wide as the drawn box (its chosen label), and goes as the other', async (t) => {
  const page = await componentsPage(t, browser, origin, { width: 390, height: 844, isMobile: true, hasTouch: true });
  if (!page) return;
  const box = await page.$eval(MENU, (el) => [el.localName, el.getBoundingClientRect().width, el.getBoundingClientRect().height, getComputedStyle(el).paddingRight, [...el.options].map((o) => o.textContent)]);
  assert.deepEqual([box[0], box[2], box[3], box[4]], ['select', 26, '22px', ['Library', 'Settings', 'Tasks']]);
  const drawn = 6 + 5 + 11 + 6 + await page.$eval(MENU, (el) => {
    const c = document.createElement('canvas').getContext('2d');
    const s = getComputedStyle(el);
    c.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    return c.measureText(el.selectedOptions[0].textContent).width;
  });
  assert.ok(Math.abs(box[1] - 2 - drawn) < 1, `as wide as the drawn box: ${box[1]} vs ${drawn + 2} (the frame)`);
  await page.evaluate(() => { window.stayed = true; });
  await page.select(MENU, 'tasks');
  await until(page, () => document.title === 'Shiori — Tasks' && !!document.getElementById('tkList'), undefined, { what: 'the tasks page' });
  assert.equal(await page.evaluate(() => window.stayed), true, 'a route change: Tasks is drawn by the one page');
});

// kept-modules.browser.mjs — the app's modules that work on any markup behave on the one page as on a
// page with a file of its own: tooltip.js (T10), started once by the app, shows the tip of anything
// carrying data-tip; scrollbar.js (T6), run by the start-up, keeps the page scrollbar's room and, with
// the drawn scrollbars asked for (Chromium), draws the page's. Their styles are the new side's
// (src/styles/tooltip.css, scrollbars.css).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, openPage, until } from './harness.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  // Scrollbars as a window shows them (puppeteer hides them in headless by default).
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--force-device-scale-factor=1'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function components(t, { drawnScrollbars = false } = {}) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  if (drawnScrollbars) await page.evaluateOnNewDocument(() => localStorage.setItem('shiori:customScrollbar', 'true'));
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  await until(page, () => document.title === 'Shiori — Components' && !!document.querySelector('main button'), undefined, { what: 'the components page' });
  return page;
}

test('an element carrying data-tip shows the app\'s tooltip, in its look', async (t) => {
  const page = await components(t);
  if (!page) return;
  await page.evaluate(() => {
    const add = (id, tip, left) => {
      const b = document.body.appendChild(document.createElement('button'));
      Object.assign(b, { id, textContent: id });
      b.dataset.tip = tip;
      b.style.cssText = `position:fixed;left:${left}px;top:200px;width:80px;height:30px`;
    };
    add('one', 'Hello', 100);
    add('two', 'First line\nA dimmer line', 300);
  });
  await page.mouse.move(140, 215);
  await until(page, () => getComputedStyle(document.querySelector('.shiori-tip')).display === 'block', undefined, { what: 'the tip' });
  const tip = await page.evaluate(() => {
    const el = document.querySelector('.shiori-tip'), s = getComputedStyle(el), r = el.getBoundingClientRect();
    return { count: document.querySelectorAll('.shiori-tip').length, text: el.textContent, left: r.left, top: r.top,
      look: [s.position, s.zIndex, s.backgroundColor, s.color, s.borderTopColor, s.borderTopLeftRadius, s.fontSize, s.paddingTop, s.paddingLeft, s.pointerEvents] };
  });
  assert.equal(tip.count, 1, 'one tooltip for the page');
  assert.equal(tip.text, 'Hello');
  assert.deepEqual([tip.left, tip.top], [140 + 14, 215 + 16], 'under the cursor, as tooltip.js places it');
  assert.deepEqual(tip.look, ['fixed', '9999', 'rgb(34, 34, 34)', 'rgb(238, 238, 238)', 'rgb(85, 85, 85)', '4px', '11px', '3px', '7px', 'none']);

  await page.mouse.move(340, 215);
  await until(page, () => document.querySelector('.shiori-tip').textContent === 'First lineA dimmer line', undefined, { what: 'the second tip' });
  assert.equal(await page.$eval('.shiori-tip .shiori-tip-sub', (el) => getComputedStyle(el).color), 'rgb(154, 154, 172)', 'the lines after the first are dimmer');

  await page.mouse.move(700, 600);
  await until(page, () => getComputedStyle(document.querySelector('.shiori-tip')).display === 'none', undefined, { what: 'the tip gone' });
  assert.deepEqual(page.problems, []);
});

test('the page scrollbar keeps its room, in the app\'s colours, while the browser draws it', async (t) => {
  const page = await components(t);
  if (!page) return;
  const seen = await page.evaluate(() => {
    const root = document.documentElement, s = getComputedStyle(root);
    return { classes: [root.classList.contains('chromium-scrollbars'), root.classList.contains('custom-scrollbars')],
      width: s.getPropertyValue('--page-scrollbar-width'), gap: s.getPropertyValue('--page-scrollbar-gap'),
      scrolls: root.scrollHeight > innerHeight, colors: s.scrollbarColor, drawn: !!document.querySelector('.scrollbar-host') };
  });
  assert.deepEqual(seen, { classes: [true, false], width: '15px', gap: '0px', scrolls: true,
    colors: 'rgb(149, 149, 149) rgb(23, 23, 23)', drawn: false });
});

test('with the drawn scrollbars asked for, scrollbar.js draws the page\'s and says it takes no room', async (t) => {
  const page = await components(t, { drawnScrollbars: true });
  if (!page) return;
  await page.waitForSelector('.page-scrollbar .scrollbar-overlay:not([hidden])');
  const seen = await page.evaluate(() => {
    const root = document.documentElement, s = getComputedStyle(root);
    const host = document.querySelector('.scrollbar-host.page-scrollbar'), hs = getComputedStyle(host);
    const thumb = document.querySelector('.page-scrollbar .scrollbar-thumb');
    return { custom: root.classList.contains('custom-scrollbars'),
      width: s.getPropertyValue('--page-scrollbar-width'), gap: s.getPropertyValue('--page-scrollbar-gap'), unit: s.getPropertyValue('--scrollbar-unit'),
      client: root.clientWidth, inner: innerWidth,
      host: [hs.position, hs.zIndex], thumb: [getComputedStyle(thumb).backgroundColor, thumb.getBoundingClientRect().width] };
  });
  assert.deepEqual(seen, { custom: true, width: '0px', gap: '0px', unit: '1px', client: 1280, inner: 1280,
    host: ['fixed', '300'], thumb: ['rgb(149, 149, 149)', 2] });
  assert.deepEqual(page.problems, []);
});

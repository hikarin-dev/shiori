// ui-scroll-box.browser.mjs — ScrollBox (the scroll-box class, src/styles/scroll-box.css) as
// /components shows it: its content scrolls inside it; a wheel at its end does not pass on to the
// page; its bar is the browser's, thin; with the drawn scrollbars asked for (Settings → Experimental,
// Chromium), scrollbar.js takes it and draws its bar.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, openPage, until } from './harness.mjs';
import { spec, centreOf } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  // Scrollbars as a window shows them (puppeteer hides them in headless by default).
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--force-device-scale-factor=1'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function components(t, { drawn = false } = {}) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  await page.evaluateOnNewDocument((drawn) => { if (drawn) localStorage.setItem('shiori:customScrollbar', 'true'); else localStorage.removeItem('shiori:customScrollbar'); }, drawn);
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  await until(page, () => !!document.querySelector('[data-section="scroll-box"] [data-specimen]'), undefined, { what: 'the components page' });
  return page;
}

const BOX = spec('scroll', 'box');

test('it scrolls inside itself, its bar the browser\'s and thin, and keeps a wheel at its end', async (t) => {
  const page = await components(t);
  if (!page) return;
  const box = await page.$eval(BOX, (el) => { const s = getComputedStyle(el); return [s.display, s.overflowY, s.overscrollBehaviorY, s.scrollbarWidth, el.scrollHeight > el.clientHeight, el.offsetWidth - el.clientWidth - 2]; });
  assert.deepEqual(box.slice(0, 5), ['block', 'auto', 'contain', 'thin', true]);
  assert.ok(box[5] > 0, 'a bar takes its room');
  const at = await centreOf(page, BOX);
  const pageY = await page.evaluate(() => scrollY);
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 6; i++) await page.mouse.wheel({ deltaY: 400 });
  await until(page, (sel) => { const el = document.querySelector(sel); return el.scrollTop + el.clientHeight >= el.scrollHeight - 1; }, BOX, { what: 'the box at its end' });
  await page.mouse.wheel({ deltaY: 400 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await page.evaluate(() => scrollY), pageY, 'the page stayed where it was');
  assert.deepEqual(page.problems, []);
});

test('with the drawn scrollbars asked for, scrollbar.js takes it', async (t) => {
  const page = await components(t, { drawn: true });
  if (!page) return;
  await until(page, () => document.documentElement.classList.contains('custom-scrollbars'), undefined, { what: 'the drawn scrollbars on' });
  await until(page, (sel) => document.querySelector(sel).classList.contains('overlay-scroll-target'), BOX, { what: 'the box taken by scrollbar.js' });
});

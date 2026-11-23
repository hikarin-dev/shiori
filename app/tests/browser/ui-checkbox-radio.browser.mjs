// ui-checkbox-radio.browser.mjs — Checkbox and RadioGroup (src/components/ui/) as /components shows
// them: drawn by the app at 13px (A1, F11), a checkbox turned by Space, a click and a click on its
// label; a radio group moved by the arrow keys with one Tab stop; disabled ones inert; the boxes never
// moving; the keyboard ring after a key only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, spec, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('checkbox: a checkbox by role and state, 13px and drawn by the app, turned by Space, a click and its label', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const box = spec('native-checkbox', 'checkbox', 'rest');
  const state = () => page.$eval(box, (el) => el.getAttribute('aria-checked'));
  const look = await page.$eval(box, (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return [el.getAttribute('role'), r.width, r.height, s.appearance, s.backgroundColor, s.borderTopColor]; });
  assert.deepEqual(look, ['checkbox', 13, 13, 'none', 'rgb(59, 59, 59)', 'rgb(133, 133, 133)'], 'Chromium\'s dark checkbox, drawn by the app');
  assert.deepEqual(await page.$eval(spec('native-checkbox', 'checkbox', 'on'), (el) => [el.getAttribute('aria-checked'), getComputedStyle(el).backgroundColor]), ['true', 'rgb(237, 39, 84)'], 'ticked: the brand colour (F11)');
  // Where the box sits in its label (the page scrolls between the steps).
  const place = () => page.$eval(box, (el) => { const r = el.getBoundingClientRect(), l = el.closest('label').getBoundingClientRect(); return [r.left - l.left, r.top - l.top, r.width, r.height, l.width, l.height]; });
  const before = await place();
  await page.evaluate((sel) => { const s = document.createElement('button'); s.id = 'before'; document.querySelector(sel).closest('label').before(s); s.focus(); }, box);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'checkbox');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid', 'the keyboard ring');
  await page.keyboard.press('Space');
  assert.equal(await state(), 'true');
  await page.evaluate(() => document.activeElement.blur());
  let at = await centreOf(page, box);
  await page.mouse.click(at.x, at.y);
  assert.equal(await state(), 'false', 'a click on the box');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'no ring after a click');
  // A click on the label's text turns it too.
  at = await page.$eval(box, (el) => { const r = el.closest('label').getBoundingClientRect(); return { x: r.right - 10, y: r.top + r.height / 2 }; });
  await page.mouse.click(at.x, at.y);
  assert.equal(await state(), 'true', 'a click on its label');
  assert.deepEqual(await place(), before, 'ticking moves nothing');
  // Disabled: Tab passes it, a click does nothing.
  const off = spec('native-checkbox', 'checkbox', 'disabled');
  at = await centreOf(page, off);
  await page.mouse.click(at.x, at.y);
  assert.equal(await page.$eval(off, (el) => [el.getAttribute('aria-checked'), el.getAttribute('aria-disabled') ?? el.dataset.disabled].join()), 'false,true');
  assert.deepEqual(await textMotion(page, '[data-section="checkbox"]'), []);
  assert.deepEqual(page.problems, []);
});

test('radio group: one Tab stop, the arrows move the choice, a click chooses', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const radios = '[data-radio-demo] [role="radio"]';
  const checked = () => page.$$eval(radios, (els) => els.map((el) => el.getAttribute('aria-checked')));
  assert.deepEqual(await checked(), ['false', 'true', 'false'], 'CBZ chosen to start with');
  assert.equal(await page.$eval('[data-radio-demo]', (el) => el.getAttribute('role')), 'radiogroup');
  const sizes = await page.$$eval(radios, (els) => els.map((el) => { const r = el.getBoundingClientRect(); return [r.width, r.height, getComputedStyle(el).borderTopLeftRadius]; }));
  assert.deepEqual(sizes, [[13, 13, '50%'], [13, 13, '50%'], [13, 13, '50%']]);
  // Tab lands on the chosen one only; the arrows move the choice.
  await page.evaluate(() => { const s = document.createElement('button'); s.id = 'before'; document.querySelector('[data-radio-demo]').before(s); s.focus(); });
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.parentElement.textContent), 'CBZ');
  await page.keyboard.press('ArrowDown');
  assert.deepEqual(await checked(), ['false', 'false', 'true']);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.deepEqual(await checked(), ['true', 'false', 'false']);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('[data-radio-demo]')), false, 'one Tab stop for the group');
  // A click on a label's text chooses it.
  const at = await page.$$eval(radios, (els) => { const r = els[1].closest('label').getBoundingClientRect(); return { x: r.right - 5, y: r.top + r.height / 2 }; });
  await page.mouse.click(at.x, at.y);
  assert.deepEqual(await checked(), ['false', 'true', 'false']);
  // Disabled: no choice by a click.
  const off = spec('native-radio', 'radio', 'disabled');
  const d = await centreOf(page, off);
  await page.mouse.click(d.x, d.y);
  assert.equal(await page.$eval(off, (el) => el.getAttribute('aria-checked')), 'false');
  assert.deepEqual(page.problems, []);
});

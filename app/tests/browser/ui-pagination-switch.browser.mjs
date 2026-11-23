// ui-pagination-switch.browser.mjs — Pagination and Switch (src/components/ui/) as /components shows
// them: the page window moving with the current page, arrows off at the ends, the current page
// announced; a switch's role and state, Space and a click turning it, a disabled one inert, its box
// never moving, and no text fading or moving.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, spec, centreOf, boxes, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const DEMO = '[data-pagination-demo] [data-slot="pagination"]:nth-child(2)';
const labels = (page) => page.$$eval(`${DEMO} li`, (lis) => lis.map((li) => {
  const b = li.querySelector('button');
  return b ? `${b.getAttribute('aria-current') ? '[' : ''}${b.textContent}${b.getAttribute('aria-current') ? ']' : ''}${b.disabled ? '(off)' : ''}` : li.textContent;
}));

test('pagination: the window rides with the page, the current one is announced, the arrows stop at the ends', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  assert.deepEqual(await labels(page), ['←', '1', '…', '8', '9', '[10]', '11', '12', '…', '20', '→']);
  // The next page by the keyboard: Tab onto →, Enter.
  await page.focus(`${DEMO} li:last-child button`);
  await page.keyboard.press('Enter');
  assert.deepEqual(await labels(page), ['←', '1', '…', '9', '10', '[11]', '12', '13', '…', '20', '→']);
  // The last page by a click: → is off there.
  const last = await centreOf(page, `${DEMO} li:nth-last-child(2) button`);
  await page.mouse.click(last.x, last.y);
  assert.deepEqual(await labels(page), ['←', '1', '…', '15', '16', '17', '18', '19', '[20]', '→(off)']);
  // Tab goes through the buttons in order and skips the one that is off.
  await page.focus(`${DEMO} li:first-child button`);
  const order = [];
  for (let i = 0; i < 8; i++) { order.push(await page.evaluate(() => document.activeElement.textContent)); await page.keyboard.press('Tab'); }
  assert.deepEqual(order, ['←', '1', '15', '16', '17', '18', '19', '20']);
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-pagination-demo]')), null, 'past the last page, focus leaves the control');
  // The two-page control: ← off, page 2 current.
  assert.deepEqual(await page.$$eval('[data-pagination-demo] [data-slot="pagination"]:first-child button', (bs) => bs.map((b) => [b.textContent, !!b.disabled, b.getAttribute('aria-current')])),
    [['←', false, null], ['1', false, null], ['2', false, 'page'], ['→', true, null]]);
  assert.deepEqual(await textMotion(page, '[data-section="pagination"]'), []);
  assert.deepEqual(page.problems, []);
});

test('switch: a switch by role and state, turned by Space and a click, inert when disabled, its box still', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const sw = spec('switch', 'switch', 'rest');
  const state = () => page.$eval(sw, (el) => [el.getAttribute('role'), el.getAttribute('aria-checked')]);
  assert.deepEqual(await state(), ['switch', 'false']);
  assert.equal(await page.$eval(spec('switch', 'switch', 'on'), (el) => el.getAttribute('aria-checked')), 'true');
  const [before] = await boxes(page, sw);
  // Tab onto it, Space turns it on; a click turns it off.
  await page.evaluate((sel) => { const s = document.createElement('button'); s.id = 'before'; document.querySelector(sel).before(s); s.focus(); }, sw);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'switch');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid', 'the keyboard ring on the track');
  await page.keyboard.press('Space');
  assert.deepEqual(await state(), ['switch', 'true']);
  // (A click on the control the keyboard already focused keeps Chrome's keyboard focus: start afresh.)
  await page.evaluate(() => document.activeElement.blur());
  const at = await centreOf(page, sw);
  await page.mouse.click(at.x, at.y);
  assert.deepEqual(await state(), ['switch', 'false']);
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'no ring after a click');
  const [after] = await boxes(page, sw);
  assert.deepEqual(after.slice(2), before.slice(2), 'turning it changes no box');
  // The knob slides (a transform on an element with no text, rule 11 allows it), the track's colours ease.
  const motion = await page.$eval(sw, (el) => [getComputedStyle(el).transitionProperty, getComputedStyle(el.querySelector('[data-slot="switch-thumb"]')).transitionProperty]);
  assert.deepEqual(motion, ['background-color, border-color', 'background-color, transform']);
  // Disabled: not reached by Tab, a click changes nothing.
  const off = spec('switch', 'switch', 'disabled');
  assert.equal(await page.$eval(off, (el) => el.getAttribute('aria-disabled') ?? el.getAttribute('data-disabled')), 'true');
  const d = await centreOf(page, off);
  await page.mouse.click(d.x, d.y);
  assert.equal(await page.$eval(off, (el) => el.getAttribute('aria-checked')), 'false');
  assert.equal(await page.$eval(off, (el) => el.tabIndex), -1);
  assert.deepEqual(page.problems, []);
});

// ui-info-tip.browser.mjs — InfoTip (src/components/ui/info-tip.tsx) as /components shows it: a button
// the keyboard reaches (with the document's ring) and a screen reader reads by its explanation; under
// the pointer the kept tooltip.js shows that explanation; muted until hovered or focused.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { componentsPage, spec, centreOf } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('reached by Tab and named by its explanation; under the pointer the tooltip shows it', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const sel = spec('field-info', 'settings');
  const tip = await page.$eval(sel, (el) => el.dataset.tip);
  assert.match(tip, /^A snapshot keeps/);
  assert.deepEqual(await page.$eval(sel, (el) => [el.localName, el.getAttribute('type'), el.getAttribute('aria-label'), el.getBoundingClientRect().width, getComputedStyle(el).cursor, getComputedStyle(el).color]),
    ['button', 'button', tip, 13, 'help', 'rgb(161, 161, 170)']);
  // Tab onto it: the keyboard ring, and its colour lifts.
  await page.evaluate((sel) => { const b = document.createElement('button'); b.id = 'before'; document.querySelector(sel).before(b); b.focus(); }, sel);
  await page.keyboard.press('Tab');
  assert.deepEqual(await page.evaluate(() => [document.activeElement.dataset.slot, getComputedStyle(document.activeElement).outlineStyle, getComputedStyle(document.activeElement).color]),
    ['info-tip', 'solid', 'rgb(244, 244, 245)']);
  // The pointer on it: tooltip.js shows its explanation.
  await page.evaluate(() => document.activeElement.blur());
  const at = await centreOf(page, sel);
  await page.mouse.move(at.x - 30, at.y);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  const shown = await until(page, () => { const el = document.querySelector('.shiori-tip'); return el && getComputedStyle(el).display !== 'none' && el.textContent; }, undefined, { what: 'the tooltip' });
  assert.equal(shown, tip);
  assert.deepEqual(page.problems, []);
});

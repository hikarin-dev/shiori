// ui-number-field.browser.mjs — NumberField (src/components/ui/number-field.tsx) as /components shows
// it: −, the value, + in Tab order; Space and Enter on a button step it, the arrows on the value step
// it, Home and End go to the ends; the value shown, not typed in; a button off at its end; the track's
// keyboard ring while the value has keyboard focus; nothing changes size as the value changes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const DEMO = '[data-stepper-demo]';
const read = (page) => page.$eval(DEMO, (root) => {
  const [minus, plus] = root.querySelectorAll('button'), input = root.querySelector('input');
  const g = root.querySelector('[data-slot="number-field-group"]').getBoundingClientRect();
  return { value: input.value, minus: minus.disabled, plus: plus.disabled, box: [g.width, g.height], label: input.getAttribute('aria-label'), buttons: [minus.getAttribute('aria-label'), plus.getAttribute('aria-label')] };
});

test('a number stepped by its buttons and by the keys, shown not typed, its ends closing a button', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const first = await read(page);
  assert.deepEqual([first.value, first.label, first.buttons, first.minus, first.plus], ['100%', 'Zoom', ['Zoom out', 'Zoom in'], false, false]);
  // Tab: −, then the value, then +.
  await page.evaluate((sel) => { const b = document.createElement('button'); b.id = 'before'; document.querySelector(sel).before(b); b.focus(); }, DEMO);
  const order = [];
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))); }
  assert.deepEqual(order, ['Zoom out', 'Zoom', 'Zoom in']);
  // Enter on +.
  await page.keyboard.press('Enter');
  assert.equal((await read(page)).value, '110%');
  // Shift+Tab back to the value; the arrows step it, and its track shows the keyboard ring.
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  assert.equal(await page.$eval(`${DEMO} [data-slot="number-field-group"]`, (g) => getComputedStyle(g).outlineStyle), 'solid');
  await page.keyboard.press('ArrowUp');
  assert.equal((await read(page)).value, '120%');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.equal((await read(page)).value, '100%');
  // Not typed in.
  await page.keyboard.type('7');
  assert.equal((await read(page)).value, '100%');
  // End: the most, and + is off; Home: the least, and − is off.
  await page.keyboard.press('End');
  let s = await read(page);
  assert.deepEqual([s.value, s.plus, s.minus], ['150%', true, false]);
  await page.keyboard.press('Home');
  s = await read(page);
  assert.deepEqual([s.value, s.minus, s.plus], ['50%', true, false]);
  // Space on + by the keyboard, and a click on it.
  await page.focus(`${DEMO} button:last-of-type`);
  await page.keyboard.press('Space');
  const at = await centreOf(page, `${DEMO} button:last-of-type`);
  await page.mouse.click(at.x, at.y);
  s = await read(page);
  assert.equal(s.value, '70%');
  assert.deepEqual(s.box, first.box, 'the value changing changes no size');
  assert.deepEqual(await textMotion(page, '[data-section="number-field"]'), []);
  assert.deepEqual(page.problems, []);
});

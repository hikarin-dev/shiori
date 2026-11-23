// ui-tabs.browser.mjs — Tabs (src/components/ui/tabs.tsx) as /components shows them: tabs and panels
// tied for assistive technology; the arrows move between tabs (down and up in the side navigation),
// Enter and a click show one; every panel stays mounted in one grid cell, so the box keeps one size
// whichever is shown and nothing around it moves; a hidden panel is invisible and inert; the
// segmented highlight under the shown tab.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { componentsPage, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const DEMO = '[data-tabs-demo]';
const read = (page) => page.$eval(DEMO, (root) => {
  const tabs = [...root.querySelectorAll('[role="tab"]')], panels = [...root.querySelectorAll('[role="tabpanel"]')];
  const box = root.getBoundingClientRect(), hl = root.querySelector('[data-slot="tabs-highlight"]').getBoundingClientRect();
  const on = tabs.find((t) => t.getAttribute('aria-selected') === 'true').getBoundingClientRect();
  const next = root.parentElement.nextElementSibling?.getBoundingClientRect();
  return {
    selected: tabs.map((t) => t.getAttribute('aria-selected')),
    tied: tabs.every((t, i) => t.getAttribute('aria-controls') === panels[i].id && panels[i].getAttribute('aria-labelledby') === t.id),
    shown: panels.map((p) => getComputedStyle(p).visibility === 'visible' && !p.inert),
    mounted: panels.length,
    box: [box.width, box.height], after: next ? [next.top, next.left] : null,
    highlight: [hl.left, hl.width], under: [on.left, on.width],
  };
});
// The highlight's place is worked out in CSS, a grid column's by layout: equal to a 64th of a pixel.
const near = (a, b, what) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 0.05, `${what}: ${a} against ${b}`));
const settled = (page) => page.evaluate(() => new Promise((done) => setTimeout(done, 400)));
// The highlight's slide finished, under the chosen one (a busy machine can take longer than its .18s).
const landed = (page, root) => until(page, ({ root, hl, on }) => {
  const g = document.querySelector(root), h = g.querySelector(`[data-slot="${hl}"]`), c = g.querySelector(on);
  if (!h || !c || h.getAnimations().length) return false;
  const a = h.getBoundingClientRect(), b = c.getBoundingClientRect();
  return Math.abs(a.left - b.left) < 0.05 && Math.abs(a.width - b.width) < 0.05;
}, { root, hl: 'tabs-highlight', on: '[aria-selected="true"]' }, { what: 'the highlight settled under the chosen one', timeout: 5000 });

test('segmented tabs over panels: one size whichever is shown, hidden panels inert, the highlight under the tab', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const first = await read(page);
  assert.equal(first.mounted, 3, 'every panel mounted');
  assert.equal(first.tied, true, 'each tab names its panel and each panel its tab');
  assert.deepEqual([first.selected, first.shown], [['true', 'false', 'false'], [true, false, false]]);
  near(first.highlight, first.under, 'the highlight under the shown tab');
  // The keyboard: onto the shown tab, the arrow to the next, Enter shows it.
  await page.focus(`${DEMO} [role="tab"][aria-selected="true"]`);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await landed(page, DEMO);
  const second = await read(page);
  assert.deepEqual([second.selected, second.shown], [['false', 'true', 'false'], [false, true, false]]);
  near(second.highlight, second.under, 'the highlight slid under the shown tab');
  // A click on the third.
  const at = await centreOf(page, `${DEMO} [role="tab"]:last-of-type`);
  await page.mouse.click(at.x, at.y);
  await settled(page);
  const third = await read(page);
  assert.deepEqual(third.shown, [false, false, true]);
  for (const s of [second, third]) assert.deepEqual([s.box, s.after], [first.box, first.after], 'the box keeps its size and nothing after it moves');
  // A control in a hidden panel can't be reached.
  await page.click(`${DEMO} [role="tab"]`);
  const reach = await page.$eval(DEMO, (root) => { const b = root.querySelector('[role="tabpanel"]:last-of-type button'); b.focus(); return document.activeElement === b; });
  assert.equal(reach, false, 'a hidden panel is inert');
  assert.deepEqual(await textMotion(page, '[data-section="tabs"]'), []);
  assert.deepEqual(page.problems, []);
});

test('side navigation: a vertical tab list, down and up move, Enter shows', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const list = await page.$eval('[data-shape="nav-item"] [role="tablist"]', (l) => { l.id = 'nav'; return l.getAttribute('aria-orientation'); });
  assert.equal(list, 'vertical');
  await page.focus('#nav [role="tab"][aria-selected="true"]');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const selected = await page.$$eval('#nav [role="tab"]', (ts) => ts.map((t) => t.getAttribute('aria-selected')));
  assert.deepEqual(selected, ['false', 'true', 'false']);
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Library');
});

// ui-tri-state.browser.mjs — TriStateToggle (src/components/ui/tri-state-toggle.tsx) as /components
// shows it: a press moves it any → show only → hide → any, by a click, Enter or Space; its state in
// data-state (the page's and its tests' hook) and read out in its name; its box never moving.
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

test('a three-state option: any → show only → hide → any, said in its name, nothing moving', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const el = '[data-tri-demo]';
  const now = () => page.$eval(el, (b) => {
    const r = b.getBoundingClientRect(), m = b.querySelector('[data-slot="tri-state-mark"]').getBoundingClientRect();
    return { state: b.dataset.state, name: b.getAttribute('aria-label'), mark: b.querySelector('[data-slot="tri-state-mark"]').textContent, struck: getComputedStyle(b.lastElementChild).textDecorationLine,
      box: [r.width, r.height, m.left - r.left, m.top - r.top] };
  });
  const first = await now();
  assert.deepEqual([first.state, first.name, first.mark, first.struck], ['off', 'romance: Any', '', 'none']);
  const at = await centreOf(page, el);
  await page.mouse.click(at.x, at.y);
  const second = await now();
  assert.deepEqual([second.state, second.name, second.mark], ['include', 'romance: Show only', '✓']);
  await page.keyboard.press('Enter');
  const third = await now();
  assert.deepEqual([third.state, third.name, third.mark, third.struck], ['exclude', 'romance: Hide', '✕', 'line-through']);
  await page.keyboard.press('Space');
  assert.equal((await now()).state, 'off');
  for (const s of [second, third]) assert.deepEqual(s.box, first.box, 'its box and its mark stay where they were');
  assert.equal(await page.$eval(el, (b) => b.localName), 'button');
  assert.deepEqual(await textMotion(page, '[data-section="tri-state"]'), []);
  assert.deepEqual(page.problems, []);
});

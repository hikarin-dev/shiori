// ui-drag-handle.browser.mjs — DragHandle (src/components/ui/drag-handle.tsx) as /components shows it:
// a 14×30 grip held centred at its row's left edge, 2px in, taking no room; the dimmest grey, the text
// colour under the pointer and while its row is dragged; the grab cursor, a finger's drag its own;
// its tip from data-tip.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, spec } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('held at its row\'s left edge, in its colours, the grab cursor', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const read = (state) => page.$eval(spec('ch-grip', 'grip', state), (el) => {
    const r = el.getBoundingClientRect(), row = el.parentElement.getBoundingClientRect(), s = getComputedStyle(el);
    return { box: [r.width, r.height], at: [+(r.left - row.left).toFixed(2), Math.abs(r.top + r.height / 2 - (row.top + row.height / 2)) < 0.05], color: s.color, cursor: s.cursor, touch: s.touchAction, tip: el.dataset.tip };
  });
  const rest = await read('rest');
  assert.deepEqual(rest, { box: [14, 30], at: [3, true], color: 'rgb(124, 124, 140)', cursor: 'grab', touch: 'none', tip: 'Drag to reorder' }, '2px inside the row\'s 1px frame, centred');
  assert.equal((await read('hover')).color, 'rgb(244, 244, 245)');
  assert.equal((await read('on')).color, 'rgb(244, 244, 245)', 'while its row is dragged');
  // It takes no room: the row's content starts where its padding puts it.
  assert.equal(await page.$eval(spec('ch-grip', 'grip'), (el) => el.parentElement.getBoundingClientRect().width), 320);
  assert.deepEqual(page.problems, []);
});

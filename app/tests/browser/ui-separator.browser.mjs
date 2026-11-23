// ui-separator.browser.mjs — Separator (src/components/ui/separator.tsx) as /components shows it: a
// separator to a screen reader in a menu, presentation inside a listbox (where ARIA allows only
// options and groups); one line of the border colour, 1px, held 6px 4px off its neighbours (F30).
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

test('a separator in a menu, presentation in a listbox; one 1px line held 6px 4px off', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const read = (sel) => page.$eval(sel, (el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect();
    return { role: el.getAttribute('role'), orientation: el.getAttribute('aria-orientation'), height: r.height, ground: s.backgroundColor,
      margin: [s.marginTop, s.marginRight, s.marginBottom, s.marginLeft].join(' '), inset: [r.left - p.left, p.right - r.right] };
  });
  const menu = await read(spec('separator', 'menu'));
  assert.deepEqual([menu.role, menu.orientation], ['separator', 'horizontal']);
  const list = await read(spec('separator', 'list'));
  assert.deepEqual([list.role, list.orientation], ['presentation', null], 'inside a listbox: no separator role');
  for (const s of [menu, list]) {
    assert.deepEqual([s.height, s.ground, s.margin], [1, 'rgb(42, 42, 48)', '6px 4px 6px 4px']);
  }
  // The frame's padding plus its own margin: 1 + 6 + 4 in the list, 1 + 5 + 4 in the menu.
  assert.deepEqual(list.inset, [11, 11]);
  assert.deepEqual(menu.inset, [10, 10]);
  // Nothing in the menu and list is focusable because of it.
  assert.equal(await page.$eval(spec('separator', 'menu'), (el) => el.tabIndex), -1);
  assert.deepEqual(page.problems, []);
});

// ui-stat.browser.mjs — Stat (src/components/ui/stat.tsx) as /components shows it: a header's total,
// its figure in the brand colour over its name in tiny capitals, 38px on the page's ground; the
// inline figure, 16px bold tabular on the subtle ground, as Settings' total disk writes (33.2px).
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

test('a header total and an inline figure, each as 1.3 drew it', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const header = await page.$eval(spec('stat', 'header'), (el) => {
    const v = getComputedStyle(el.querySelector('[data-slot="stat-value"]')), l = getComputedStyle(el.querySelector('[data-slot="stat-label"]')), s = getComputedStyle(el);
    return { h: el.getBoundingClientRect().height, ground: s.backgroundColor, frame: s.borderTopColor, value: [v.fontSize, v.fontWeight, v.color], label: [l.fontSize, l.textTransform, l.color], text: el.innerText.replace(/\s+/g, ' ') };
  });
  assert.deepEqual(header, { h: 38, ground: 'rgb(13, 13, 15)', frame: 'rgb(42, 42, 48)', value: ['14px', '700', 'rgb(237, 39, 84)'], label: ['8px', 'uppercase', 'rgb(161, 161, 170)'], text: '6 RUNNING' });
  const inline = await page.$eval(spec('stat', 'inline'), (el) => { const s = getComputedStyle(el); return [+el.getBoundingClientRect().height.toFixed(1), s.fontSize, s.fontWeight, s.fontVariantNumeric, s.backgroundColor, s.borderTopColor]; });
  assert.deepEqual(inline, [33.2, '16px', '700', 'tabular-nums', 'rgb(17, 17, 20)', 'rgb(63, 63, 72)']);
  assert.deepEqual(page.problems, []);
});

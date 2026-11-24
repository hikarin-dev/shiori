// ui-drop-overlay.browser.mjs — DropOverlay (src/components/ui/drop-overlay.tsx) as /components shows
// it: 1.3's look (library.css, body.drag-over::after: 18px in the brand colour, centred, a 2px dashed
// brand-coloured frame, the page's ground at 72%), over the whole window on the drop layer, never
// taking the pointer, shown and gone at once, its words its children.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { componentsPage, spec, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const look = (page, sel) => page.$eval(sel, (el) => {
  const s = getComputedStyle(el);
  return [s.display, s.alignItems, s.justifyContent, s.fontSize, s.fontFamily, s.color, s.backgroundColor, `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`, s.pointerEvents, s.zIndex, s.opacity, s.transitionDuration, el.textContent];
});
const LOOK = ['flex', 'center', 'center', '18px', '"JetBrains Mono", monospace', 'rgb(237, 39, 84)', 'rgba(13, 13, 15, 0.72)', '2px dashed rgb(237, 39, 84)', 'none', '1000', '1', '0s', 'Drop to import'];

test('1.3\'s look, still and over the window, which it covers whole while shown', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  assert.deepEqual(await look(page, spec('drop-overlay', 'still')), LOOK);
  assert.equal(await page.$(spec('drop-overlay', 'window', 'on')), null, 'not shown: not there');
  const at = await centreOf(page, '[data-drop-demo]');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.waitForSelector(spec('drop-overlay', 'window', 'on'));
  assert.deepEqual(await look(page, spec('drop-overlay', 'window', 'on')), LOOK);
  const cover = await page.$eval(spec('drop-overlay', 'window', 'on'), (el) => { const r = el.getBoundingClientRect(); return [getComputedStyle(el).position, r.left, r.top, r.width === document.documentElement.clientWidth, r.height === innerHeight]; });
  assert.deepEqual(cover, ['fixed', 0, 0, true, true]);
  // The pointer goes through it: what lies under it is still what the pointer is over.
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-drop-demo]') != null, at), true);
  assert.deepEqual(await textMotion(page, '[data-section="drop-overlay"]'), []);
  await page.mouse.up();
  await until(page, (sel) => !document.querySelector(sel), spec('drop-overlay', 'window', 'on'), { what: 'gone' });
  assert.deepEqual(page.problems, []);
});

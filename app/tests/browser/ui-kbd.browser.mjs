// ui-kbd.browser.mjs — Kbd (src/components/ui/kbd.tsx) as /components shows it: a <kbd>, in the UI
// font (not the browser's monospace), never broken across lines; the default cap 19px tall on the
// page's ground, the outline cap 15px with no ground; a menu's cap is the keys dialog's (F32).
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

test('a key cap: a <kbd> in the UI font, whole on one line, in its two sizes', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const read = (sel) => page.$eval(sel, (el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return { tag: el.localName, family: s.fontFamily, size: s.fontSize, height: r.height, ground: s.backgroundColor, frame: s.borderTopColor, color: s.color };
  });
  const key = await read(spec('kb-key', 'default'));
  const menu = await read(spec('ctx-kbd', 'default'));
  const outline = await read(spec('rs-kbd', 'outline'));
  for (const k of [key, menu, outline]) {
    assert.equal(k.tag, 'kbd');
    assert.match(k.family, /^"?JetBrains Mono"?, monospace$/, 'the UI font');
  }
  assert.deepEqual([key.size, key.height, key.ground, key.frame, key.color], ['10px', 19, 'rgb(13, 13, 15)', 'rgb(42, 42, 48)', 'rgb(244, 244, 245)']);
  assert.deepEqual(menu, key, 'a menu\'s cap is the keys dialog\'s');
  assert.deepEqual([outline.size, outline.height, outline.ground, outline.frame, outline.color], ['9px', 15, 'rgba(0, 0, 0, 0)', 'rgb(63, 63, 72)', 'rgb(161, 161, 170)']);
  // A long cap in a narrow place stays one cap on one line.
  const lines = await page.evaluate((sel) => {
    const el = document.querySelector(sel).parentElement.querySelector('kbd:last-child');
    el.parentElement.style.width = '20px';
    return el.getClientRects().length;
  }, spec('kb-key', 'default'));
  assert.equal(lines, 1);
  assert.deepEqual(page.problems, []);
});

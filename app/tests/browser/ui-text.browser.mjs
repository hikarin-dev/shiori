// ui-text.browser.mjs — the text styles (src/components/ui/text.tsx) as /components shows them: an
// Eyebrow is a block heading in capitals, one weight (600) and one spacing (.1em) in its three sizes
// and tones (F18), rendered as the element its place needs (a label, a heading); a card's title is
// 13px bold drawn tight on a 1.35 line; a dialog's title 15px bold (F28).
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

const read = (page, sel) => page.$eval(sel, (el) => { const s = getComputedStyle(el); return [el.localName, s.display, s.fontSize, s.fontWeight, s.letterSpacing, s.textTransform, s.color]; });

test('eyebrows: one weight and spacing, three sizes, three tones, each the element its place needs', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  assert.deepEqual(await read(page, spec('eyebrow', 'modal-label')), ['label', 'block', '9px', '600', '0.9px', 'uppercase', 'rgb(161, 161, 170)']);
  assert.deepEqual(await read(page, spec('eyebrow', 'rs-heading')), ['h3', 'block', '9px', '600', '0.9px', 'uppercase', 'rgb(124, 124, 140)']);
  assert.deepEqual(await read(page, spec('eyebrow', 'tcfg')), ['h3', 'block', '10px', '600', '1px', 'uppercase', 'rgb(255, 209, 102)']);
  assert.deepEqual(await read(page, spec('eyebrow', 'ov-section')), ['h2', 'block', '11px', '600', '1.1px', 'uppercase', 'rgb(161, 161, 170)']);
  // A heading keeps no browser margin (the document's reset): its place spaces it.
  assert.equal(await page.$eval(spec('eyebrow', 'ov-section'), (el) => getComputedStyle(el).marginBlockStart), '0px');
  assert.deepEqual(page.problems, []);
});

test('a card\'s title and a dialog\'s', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const card = await page.$eval(spec('titles', 'card'), (el) => { const s = getComputedStyle(el); return [el.localName, s.fontSize, s.fontWeight, s.letterSpacing, s.lineHeight, +el.getBoundingClientRect().height.toFixed(1)]; });
  assert.deepEqual(card, ['h2', '13px', '700', '-0.15px', '17.55px', 17.5]);
  const dialog = await page.$eval(spec('titles', 'dialog'), (el) => { const s = getComputedStyle(el); return [s.fontSize, s.fontWeight, s.color]; });
  assert.deepEqual(dialog, ['15px', '700', 'rgb(244, 244, 245)']);
});

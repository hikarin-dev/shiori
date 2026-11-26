// ui-tag.browser.mjs — Tag (src/components/ui/tag.tsx) as /components shows it: a tag that does
// something is a button or a link (reached by Tab), one that only shows is neither; three sizes as
// 1.3 has them (a card's 14, a search filter's 22, an overview tag's 24); a card's tag is
// cut short at 100px, an overview tag wraps; hovers in each tone (a card's grey is its own, a step
// deeper); with Shift held a removable tag previews its removal in the delete colour, its count's
// divider at half white; the editable detail stands over its text so nothing shifts; no text fades
// or moves.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, spec, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const look = (page, sel) => page.$eval(sel, (el) => {
  const s = getComputedStyle(el), r = el.getBoundingClientRect();
  return { tag: el.localName, box: [+r.width.toFixed(2), +r.height.toFixed(2)], ground: s.backgroundColor, frame: s.borderTopColor, color: s.color, tab: el.tabIndex };
});

test('what a tag is: a button or a link when it does something, a plain word when it only shows', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const card = await look(page, spec('card-tag', 'neutral'));
  assert.deepEqual([card.tag, card.tab, card.box[1]], ['button', 0, 14]);
  const ov = await look(page, spec('ov-chip', 'neutral'));
  assert.deepEqual([ov.tag, ov.tab, ov.box[1]], ['a', 0, 24]);
  assert.equal(await page.$eval(spec('ov-chip', 'neutral'), (el) => el.getAttribute('href')), '#tag');
  const chip = await look(page, spec('search-chip', 'filter'));
  assert.deepEqual([chip.tag, chip.tab, chip.box[1]], ['span', -1, 22]);
  assert.deepEqual(await page.$eval(spec('search-chip', 'filter'), (el) => [el.querySelector('[data-slot="tag-key"]').textContent, getComputedStyle(el).fontWeight, getComputedStyle(el.querySelector('[data-slot="tag-key"]')).fontWeight]),
    ['category:', '600', '400'], 'the key muted and plain, the value semibold');
  // "+" says what it does to a screen reader.
  assert.equal(await page.$eval(spec('card-tag', 'add'), (el) => el.getAttribute('aria-label')), 'Add a tag');
  assert.deepEqual(page.problems, []);
});

test('a card\'s tag is cut short at 100px on one line; an overview tag wraps in a narrow place', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const long = await page.$eval(spec('card-tag', 'long'), (el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height, getComputedStyle(el).textOverflow, el.scrollWidth > el.clientWidth]);
  assert.deepEqual(long, [100, 14, 'ellipsis', true]);
  const wrap = await look(page, spec('ov-chip', 'wrap'));
  assert.ok(wrap.box[0] <= 120 && wrap.box[1] >= 24 + 18, `wraps onto more lines of 18px (${wrap.box})`);
});

test('hovers in each tone; with Shift held, the removal preview; nothing moves', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const pick = (l) => [l.ground, l.frame, l.color];
  assert.deepEqual(pick(await look(page, spec('card-tag', 'neutral'))), ['rgb(28, 28, 33)', 'rgb(42, 42, 48)', 'rgb(107, 107, 128)']);
  assert.deepEqual(pick(await look(page, spec('card-tag', 'neutral', 'hover'))), ['rgb(28, 28, 33)', 'rgb(107, 107, 128)', 'rgb(244, 244, 245)'], 'a card\'s own grey frames it');
  assert.deepEqual(pick(await look(page, spec('card-tag', 'category', 'hover'))), ['rgb(28, 28, 33)', 'rgb(237, 39, 84)', 'rgb(237, 39, 84)']);
  assert.deepEqual(pick(await look(page, spec('card-tag', 'artist', 'hover'))), ['rgb(28, 28, 33)', 'rgb(255, 209, 102)', 'rgb(255, 209, 102)']);
  assert.deepEqual(pick(await look(page, spec('card-tag', 'add', 'hover'))).slice(1), ['rgb(255, 209, 102)', 'rgb(255, 209, 102)']);
  assert.deepEqual(pick(await look(page, spec('ov-chip', 'neutral', 'hover'))), ['rgb(28, 28, 33)', 'rgb(161, 161, 170)', 'rgb(244, 244, 245)']);
  // Shift held (the page's shift-held), under the pointer.
  assert.deepEqual(pick(await look(page, spec('card-tag', 'removing', 'hover'))), ['rgba(255, 77, 61, 0.2)', 'rgb(255, 77, 61)', 'rgb(255, 77, 61)']);
  assert.deepEqual(pick(await look(page, spec('ov-chip', 'removing', 'hover'))), ['rgba(255, 77, 61, 0.2)', 'rgb(255, 77, 61)', 'rgb(255, 77, 61)']);
  assert.deepEqual(await page.$eval(spec('ov-chip', 'removing', 'hover'), (el) => { const s = getComputedStyle(el.querySelector('[data-slot="tag-count"]')); return [s.color, s.borderLeftColor]; }),
    ['rgb(255, 77, 61)', 'rgba(255, 77, 61, 0.5)'], 'the count in the tag\'s colour, its divider half of it');
  assert.deepEqual(await page.$eval(spec('ov-chip', 'neutral', 'hover'), (el) => { const s = getComputedStyle(el.querySelector('[data-slot="tag-count"]')); return [s.color, s.borderLeftColor]; }),
    ['rgb(161, 161, 170)', 'rgb(161, 161, 170)'], 'Shift not held: the count muted, its divider the frame\'s colour');
  assert.deepEqual(pick(await look(page, spec('ov-meta-item', 'removing', 'hover'))).slice(1), ['rgb(255, 77, 61)', 'rgb(255, 77, 61)']);
  // "+" previews nothing (it adds).
  assert.equal((await look(page, spec('card-tag', 'add', 'hover'))).ground, 'rgb(28, 28, 33)');
  // The hover's box is the rest's.
  for (const [shape, variant] of [['card-tag', 'neutral'], ['ov-chip', 'neutral'], ['ov-meta-item', 'ghost']]) {
    assert.deepEqual((await look(page, spec(shape, variant, 'hover'))).box, (await look(page, spec(shape, variant))).box, `${shape}: hover changes no box`);
  }
  assert.deepEqual(await textMotion(page, '[data-section="tag"]'), []);
  assert.deepEqual(page.problems, []);
});

test('the editable detail stands over its text: framed in edit mode, it moves nothing', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const place = await page.$eval(spec('ov-meta-item', 'ghost'), (el) => {
    const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect(), icon = el.querySelector('svg').getBoundingClientRect(), s = getComputedStyle(el);
    return { frame: s.borderTopColor, inset: [r.left - p.left, r.top - p.top], icon: [icon.left - p.left], font: s.fontSize };
  });
  // The row's padding is 8px 4px: the frame starts 7px before the text and 3px above it, the icon at
  // the text's place (8 + the frame's 1 + its 6px padding − 7).
  assert.deepEqual(place, { frame: 'rgba(0, 0, 0, 0)', inset: [1, 1], icon: [8], font: '12px' });
  assert.equal((await look(page, spec('ov-meta-item', 'ghost', 'hover'))).frame, 'rgb(161, 161, 170)');
});

// overview-next-layers.browser.mjs — rule 29 on the overview at /overview-next: a control's own motion
// lifts none of the page's words onto a layer (layers.mjs: the browser's own layer tree, mid-way through
// each motion). A chapter's pages opened (its arrow turning) and closed again; rows sliding to their new
// places after the order changed in another tab: no layer there for an animation, none gained. And the
// page eases no transform but a row button's two faces, flipped under Shift (1.3's flip; they lift their
// own button alone). What the buttons do (7b): edit mode turned on and off, a row moved by its arrow,
// a delete's question opened and answered: the same.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { openRun, nextBase, gid, visit, sleep, NEW, PARTS } from './overview-drive.mjs';
import { layerWatch, easedTransforms } from './layers.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('a chapter\'s pages opened and closed, and rows sliding to their places: nothing lifted onto a layer', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const base = nextBase(1790016000000);
  const maker = await openRun(browser, origin, base);
  const page = await openRun(browser, origin, base);
  t.after(async () => { await page.close(); await maker.close(); });
  await page.setViewport({ width: 1280, height: 900 });
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.bringToFront();
  await page.mouse.move(640, 880);
  const watch = await layerWatch(page);
  t.after(() => watch.close());

  const opened = await watch.during(async () => { await page.hover('.ch-row:nth-child(2) .ch-head'); await page.click('.ch-row:nth-child(2) [data-expand]'); });
  assert.ok(opened.running.includes('--turn'), `met mid-way, the arrow turning by its number (${opened.running})`);
  assert.deepEqual(opened.animated, [], 'no layer is there for an animation');
  assert.deepEqual(opened.gained, [], 'opening: nothing got a layer');
  assert.equal(await page.$eval('.ch-row:nth-child(2) [data-expand] svg', (el) => getComputedStyle(el).rotate), '180deg', 'the arrow turned');
  const closed = await watch.during(() => page.click('.ch-row:nth-child(2) [data-expand]'));
  assert.deepEqual(closed.animated, []);
  assert.deepEqual(closed.gained, [], 'closing: nothing got a layer');

  // The order changed in the other tab: chapters 2 and 2.5 change places, each sliding.
  const id = (p) => String(base + PARTS[p]);
  const slid = await watch.during(() => maker.evaluate(async ({ S, S2, S3 }) => {
    const api = await import('/app/js/api.js');
    const order = (await api.meta.get(S)).chapters.map((c) => String(c.id));
    const i = order.indexOf(S2), j = order.indexOf(S3);
    [order[i], order[j]] = [order[j], order[i]];
    await api.series.reorder(S, order);
  }, { S: id('S'), S2: id('S2'), S3: id('S3') }));
  assert.ok(slid.running.length > 0, `met mid-way, the rows sliding (${slid.running})`);
  assert.deepEqual(slid.animated, []);
  assert.deepEqual(slid.gained, [], 'sliding: nothing got a layer');
  await sleep(300);
  assert.deepEqual(await easedTransforms(page, '.ch-face'), [], 'the page eases no transform but a row button\'s faces');
  assert.deepEqual(page.problems, []);
});

test('edit mode on and off, a row moved by its arrow, a delete’s question: nothing lifted onto a layer', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const base = nextBase(1790016000000);
  const page = await openRun(browser, origin, base);
  t.after(() => page.close());
  await page.setViewport({ width: 1280, height: 900 });
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.bringToFront();
  await page.mouse.move(640, 880);
  const watch = await layerWatch(page);
  t.after(() => watch.close());
  const quiet = (what, seen) => { assert.deepEqual(seen.animated, [], `${what}: no layer is there for an animation`); assert.deepEqual(seen.gained, [], `${what}: nothing got a layer`); };

  quiet('edit mode on', await watch.during(() => page.click('#editToggle')));
  assert.ok(await page.$('#ovContent.ov-editing'));
  quiet('edit mode off', await watch.during(() => page.click('#editToggle')));

  const row = `.ch-row[data-chapter-id="${gid(base, 'S2')}"]`;
  await page.hover(`${row} .ch-main`);
  const moved = await watch.during(() => page.click(`${row} [data-down]`));
  assert.ok(moved.running.length > 0, 'met mid-way, the rows sliding');
  quiet('a row moved by its arrow', moved);

  await page.hover(`${row} .ch-main`);
  const asked = await watch.during(() => page.click(`${row} [data-remove]`));
  assert.ok(await page.$('[data-notice="dialog"]'), 'the delete’s question');
  assert.deepEqual(asked.animated, [], 'the question: no layer is there for an animation');
  const answered = await watch.during(() => page.keyboard.press('Escape'));
  assert.deepEqual(answered.animated, [], 'the question answered: no layer is there for an animation');
  await sleep(300);
  assert.deepEqual(await easedTransforms(page, '.ch-face'), [], 'the page eases no transform but a row button’s faces');
  assert.deepEqual(page.problems, []);
});

// 7c: a row dragged by its grip, the others sliding aside, and dropped (the row travelling to its place).
// The dragged row follows the pointer by its place (no motion of its own); the rows making room ease by
// `top`; nothing is on a layer for an animation, and no row's words are lifted, mid-drag or mid-drop.
test('a row dragged by its grip and dropped: nothing lifted onto a layer', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const base = nextBase(1790016000000);
  const page = await openRun(browser, origin, base);
  t.after(() => page.close());
  await page.setViewport({ width: 1280, height: 900 });
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.bringToFront();
  const watch = await layerWatch(page);
  t.after(() => watch.close());
  // (A layer that is no element's holds none of the page's words: the 0×0 hidden field of the page menu's
  // select comes with one of 4×4 that paints nothing, which comes and goes as the tip under the pointer
  // does: read with the browser's own snapshot of it, plans/frontend-react-probes/7c/layer-probe.mjs.)
  const quiet = (what, seen) => { assert.deepEqual(seen.animated, [], `${what}: no layer is there for an animation`); assert.deepEqual(seen.gained.filter((l) => !l.startsWith(' [')), [], `${what}: nothing got a layer`); };
  const box = (sel) => page.$eval(sel, (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.top }; });
  const grip = await box(`.ch-row[data-chapter-id="${gid(base, 'S')}"] .ch-grip`);
  const target = await box(`.ch-row[data-chapter-id="${gid(base, 'S3')}"]`);
  await page.mouse.move(grip.x + 40, grip.y);
  await page.mouse.move(grip.x, grip.y);
  await sleep(100);
  await page.mouse.down();
  // (Begun first, a few px: the grip's tip, shown under the pointer, is put away as the drag begins, and
  // the page's look at rest is read without it.)
  await page.mouse.move(grip.x, grip.y + 6);
  await sleep(300);
  const dragged = await watch.during(() => page.mouse.move(grip.x, target.y, { steps: 10 }));
  assert.ok(dragged.running.includes('top'), `met mid-way, the rows making room by their place (${dragged.running})`);
  assert.ok(await page.$('.ch-row[data-dragging]'), 'a row lifted');
  quiet('a drag under way', dragged);
  await page.mouse.move(grip.x, target.y - 20);
  await sleep(400);
  const dropped = await watch.during(() => page.mouse.up());
  assert.ok(dropped.running.some((r) => r === '' || r === 'top'), `met mid-way, the dropped row travelling (${dropped.running})`);
  quiet('the drop', dropped);
  await sleep(600);
  assert.deepEqual(await easedTransforms(page, '.ch-face'), [], 'the page eases no transform but a row button’s faces');
  assert.deepEqual(page.problems, []);
});

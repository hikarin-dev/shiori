// overview-layers.browser.mjs — rule 29 on the overview at /overview-next: a control's own motion
// lifts none of the page's words onto a layer (layers.mjs: the browser's own layer tree, mid-way through
// each motion). A chapter's pages opened (its arrow turning) and closed again; rows sliding to their new
// places after the order changed in another tab: no layer there for an animation, none gained. And the
// page eases no transform but a row button's two faces, flipped under Shift (1.3's flip; they lift their
// own button alone). What the buttons do (7b): edit mode turned on and off, a row moved by its arrow,
// a delete's question opened and answered: the same.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
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

// 7c: the add bar's list of galleries opening, and the bar lit by files dragged over it (its frame and
// ground easing by colour): nothing lifted onto a layer.
test('the add list opening and the bar lit by files over it: nothing lifted onto a layer', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const base = nextBase(1790016000000);
  const page = await openRun(browser, origin, base);
  t.after(() => page.close());
  await page.setViewport({ width: 1280, height: 900 });
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.bringToFront();
  await page.$eval('#addSearch', (el) => el.scrollIntoView({ block: 'center' }));
  await page.mouse.move(640, 5);
  const watch = await layerWatch(page);
  t.after(() => watch.close());
  const quiet = (what, seen) => { assert.deepEqual(seen.animated, [], `${what}: no layer is there for an animation`); assert.deepEqual(seen.gained.filter((l) => !l.startsWith(' [')), [], `${what}: nothing got a layer`); };
  await page.click('#addSearch');
  await sleep(400);
  const opened = await watch.during(async () => {
    await page.type('#addSearch', 'gallery', { delay: 20 });
    await until(page, () => document.querySelectorAll('#addResults .add-res').length > 0, null, { what: 'the add list' });
  });
  // The list itself is on layers of its own while it shows (placed against its box by anchor positioning,
  // which the compositor keeps on the box as the page scrolls): its own words, there from its first frame
  // to its last; nothing of the page's.
  assert.deepEqual(opened.animated, [], 'the add list opening: no layer is there for an animation');
  assert.deepEqual(opened.gained.filter((l) => !l.startsWith(' [') && !l.startsWith('div#addResults')), [], 'the add list opening: nothing of the page got a layer');
  await page.click('#ovSection');
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(40, 60); c.getContext('2d').fillRect(0, 0, 40, 60);
    window.__picture = new File([await c.convertToBlob({ type: 'image/png' })], 'Pic.png', { type: 'image/png' });
  });
  const fire = (type) => page.evaluate((type) => {
    const data = new DataTransfer();
    data.items.add(window.__picture);
    document.getElementById('addBar').dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
  }, type);
  const lit = await watch.during(async () => { await fire('dragenter'); await fire('dragover'); });
  assert.ok(lit.running.some((p) => /border|background/.test(p)), `met mid-way, the bar's frame and ground easing (${lit.running})`);
  quiet('the bar lit', lit);
  quiet('the bar unlit', await watch.during(() => fire('dragleave')));
  await sleep(300);
  assert.deepEqual(await easedTransforms(page, '.ch-face'), [], 'the page eases no transform but a row button’s faces');
  assert.deepEqual(page.problems, []);
});

// 7d: a bar with no figure yet (Progress's block travelling, `progress-travel`: an animated transform,
// the compositor's). Measured on a row's job and on the tracker's batch: the block alone is on a layer
// for its animation, and nothing else is lifted that a bar with a figure (no motion of its own) does not
// lift as well (Base UI's hidden fixed spans flip on and off either way): none of the page's words. The
// track clips the block, so nothing painted after it can be overlapped by it. Nothing to move, then.
test('a bar with no figure yet travels with nothing but its block on a layer: a row\'s job, the tracker\'s batch', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const base = nextBase(1790016100000);
  const page = await openRun(browser, origin, base);
  t.after(async () => {
    await page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); });
    await page.close();
  });
  await page.setViewport({ width: 1280, height: 900 });
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.mouse.move(1270, 890);
  const watch = await layerWatch(page);
  t.after(() => watch.close());
  const publish = (job) => () => page.evaluate(async (job) => (await import('/app/js/platform.js')).jobs.publish(job), job);
  const BLOCK = 'div[progress-indicator] [ActiveTransformAnimation]';
  const still = await watch.during(publish({ gid: gid(base, 'S3'), kind: 'download', status: 'downloading', downloaded: 100, total: 1000, pages: 2 }));
  assert.deepEqual(still.animated, []);
  const row = await watch.during(publish({ gid: gid(base, 'S2'), kind: 'download', status: 'downloading', downloaded: 0, pages: 2 }));
  assert.deepEqual(row.running, ['progress-travel'], 'met mid-way, the block travelling');
  assert.deepEqual(row.animated, [BLOCK], 'its block alone is on a layer for the animation');
  assert.deepEqual(row.gained.filter((l) => l !== BLOCK && !still.gained.includes(l)), [], 'nothing else lifted');
  // The tracker's batch: its bar always has a figure here (a title's count); the tracker's bar with none is
  // the library's "reading a drop" panel alone (text-layers.browser.mjs has the library and Tasks).
  await publish({ gid: gid(base, 'S2'), kind: 'download', status: 'downloading', downloaded: 1, total: 2, pages: 2 })();
  await until(page, () => ![...document.querySelectorAll('[data-slot="progress-indicator"]')].some((f) => getComputedStyle(f).animationName === 'progress-travel'), null, { what: 'no bar travelling' });
  const batch = await watch.during(publish({ gid: 'import-travel', kind: 'import', status: 'progress', name: '2 items', total: 2, done: 0, imported: 0, skipped: 0, failed: 0, current: { name: 'One', done: 0, total: 0 }, startedAt: Date.now(), movedAt: Date.now() }));
  assert.ok(await page.$('#ovImports .ib'), 'the batch in the tracker');
  assert.deepEqual([batch.animated, batch.running.filter((r) => r === 'progress-travel')], [[], []], 'the batch\'s bar has a figure: nothing travels');
  assert.deepEqual(await easedTransforms(page, '.ch-face'), [], 'still no transition of a transform');
  assert.deepEqual(page.problems, []);
});

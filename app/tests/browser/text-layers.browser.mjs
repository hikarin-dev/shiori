// text-layers.browser.mjs — rule 29: a control's own motion lifts none of the page's words onto a
// layer. The owner (2026-11-25): "when pulling down this dropdown, there's a weird aliasing issue
// happening with some of the text in library cards too while the dropdown is in animation state".
// The list's arrow turned by an animated rotate: the compositor's, and while it ran every card painted
// after it got a layer of its own (eleven of them), their words smoothed another way for those 180 ms.
// Held by the browser's own layer tree, mid-way through each motion (layers.mjs): the library's sort
// list opened and closed, Settings' switch turned and list opened; and by what the pages ease at all.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage } from './harness.mjs';
import { startTranslator } from './stand-in-translator.mjs';
import { openRun, nextBase, sleep } from './library-drive.mjs';
import { layerWatch, easedTransforms } from './layers.mjs';

let server, origin, browser, translator;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  translator = await startTranslator();
  browser = await launch();
});
after(async () => { await browser?.close(); await translator?.close(); server?.close(); });

// The list's own layers: it is over everything, placed against its box, and nothing is painted after it.
const LIST = /^div\[select-(positioner|list)\] /;
// The one transform the library eases: a card button's two faces, flipped under Shift (measured: it
// lifts the button and its row of icon buttons, in that card alone).
const FACES = '.card-face';

test('the library\'s sort list unrolls and rolls up with no card lifted onto a layer', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const page = await openRun(browser, origin, '/library', { base: nextBase(1790015000000), translator: translator.origin });
  t.after(() => page.close());
  await page.setViewport({ width: 1280, height: 900 });
  await sleep(500);
  await page.mouse.move(640, 880);
  const watch = await layerWatch(page);
  t.after(() => watch.close());
  const opened = await watch.during(() => page.click('#sortSelect'));
  assert.ok(opened.running.includes('clip-path'), `met mid-way, the list unrolling (${opened.running})`);
  assert.ok(opened.running.includes('--turn'), `the arrow turning, by its number (${opened.running})`);
  assert.deepEqual(opened.animated, [], 'no layer is there for an animation');
  assert.deepEqual(opened.gained.filter((l) => !LIST.test(l)), [], 'nothing but the list itself got a layer');
  assert.equal(await page.$eval('#sortSelect svg', (el) => getComputedStyle(el).rotate), '180deg', 'the arrow turned');
  const closed = await watch.during(() => page.keyboard.press('Escape'));
  assert.ok(closed.running.includes('--turn'), `met mid-way, the arrow turning back (${closed.running})`);
  assert.deepEqual(closed.animated, []);
  assert.deepEqual(closed.gained, [], 'rolling up: nothing got a layer');
  assert.deepEqual(await easedTransforms(page, FACES), [], 'the page eases no transform but a card button\'s faces');
  assert.ok((await easedTransforms(page)).length > 0, 'and those are seen by the measure');
  assert.deepEqual(page.problems, []);
});

test('Settings: a switch turns and a list opens with nothing lifted onto a layer', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${origin}/settings`, { waitUntil: 'load' });
  await page.waitForSelector('[data-slot="switch"]');
  await sleep(600);
  await page.mouse.move(640, 880);
  const watch = await layerWatch(page);
  t.after(() => watch.close());
  // The first of each in view, clear of the window's bottom (a list opens downward there).
  const first = async (sel) => (await page.evaluateHandle((sel) => [...document.querySelectorAll(sel)].find((el) => {
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.top > 60 && b.bottom < innerHeight - 260 && !el.disabled && !el.hasAttribute('data-disabled');
  }), sel)).asElement();
  const sw = await first('[data-slot="switch"]');
  assert.ok(sw, 'a switch in view');
  const turned = await watch.during(() => sw.click());
  assert.ok(turned.running.includes('left'), `met mid-way, the knob sliding (${turned.running})`);
  assert.deepEqual(turned.animated, [], 'no layer is there for an animation');
  assert.deepEqual(turned.gained, [], 'nothing got a layer');
  await sw.click();   // (as it was)
  await sleep(400);
  const box = await first('[data-slot="select-trigger"]');
  assert.ok(box, 'a list\'s box in view');
  const opened = await watch.during(() => box.click());
  assert.ok(opened.running.includes('--turn'), `met mid-way, the arrow turning (${opened.running})`);
  assert.deepEqual(opened.animated, []);
  assert.deepEqual(opened.gained.filter((l) => !LIST.test(l)), [], 'nothing but the list itself got a layer');
  await page.keyboard.press('Escape');
  await sleep(400);
  // Every panel of Settings: no transform eased anywhere.
  const tabs = await page.$$('#settingsNav [role="tab"]');
  assert.ok(tabs.length > 3, 'the side nav');
  for (const tab of tabs) {
    await tab.click();
    await sleep(250);
    assert.deepEqual(await easedTransforms(page), [], `no transform eased (${await tab.evaluate((el) => el.textContent.trim())})`);
  }
  assert.deepEqual(page.problems, []);
});

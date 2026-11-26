// reader-layers.browser.mjs — rule 29 in the reader's own chrome: what it eases, it eases on the page's
// own thread, so no motion of it is the compositor's and none lifts its words, or anything painted after
// it, onto a layer for its time (the owner, 2026-11-25: text changed its look while something animated
// over or under it). Held by the browser's own layer tree mid-way through each motion (layers.mjs):
// the unpinned top bar sliding in and out (by its top), the reading mode's and the translate ⇄ study
// switch's marks (by left, and by their colour), the status line of a page's translation (by its bottom
// and its colours), the modern navigation and fit and zoom hidden and shown, the progress bar's page
// pill and the bar hidden, go to top, the loading screen, the top bar's page menu opened (its caret
// turned by a number, its list unrolled with no fade); and by what the reader eases at all. The engine's
// page motion (the glide, the scrub, the strip) is not chrome and is not measured here.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { layerWatch, easedTransforms } from './layers.mjs';

const GID = '1790000000951', TS = '1790000000952';
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async ({ GID, TS }) => {
    const api = await import('/app/js/api.js');
    const canvas = new OffscreenCanvas(600, 1800);
    const c = canvas.getContext('2d'); c.fillStyle = '#8a9'; c.fillRect(0, 0, 600, 1800);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    for (const [gid, tr] of [[GID, false], [TS, true]]) {
      await api.meta.put({ galleryId: gid, title: { english: 'Layers fixture' }, numPages: 6, translated: tr });
      for (let n = 1; n <= 6; n++) {
        await api.pages.put(gid, n, blob);
        if (tr) await api.derived.putTranslation(gid, n, { image: blob, pipeline: { job: 'j1', lines: [], read: [], regions: [] } });
      }
    }
  }, { GID, TS });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reader(t, { nav = 'top', pinned = true, mode = 'single', gid = GID } = {}) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument((o) => {
    localStorage.setItem('shiori-reader-nav', o.nav);
    localStorage.setItem('shiori-reader-pin', o.pinned ? '1' : '0');
    localStorage.setItem('shiori-reader-side-pin', o.pinned ? '1' : '0');
    localStorage.setItem('shiori:readerMode', JSON.stringify(o.mode));
    localStorage.setItem('shiori:readerFitMode', JSON.stringify(o.mode === 'strip' ? 'off' : 'height'));
    localStorage.setItem('shiori:readerView', '"off"');
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
  }, { nav, pinned, mode });
  await page.goto(`${origin}/reader?g=${gid}&page=2`, { waitUntil: 'load' });
  await until(page, () => [...document.querySelectorAll('#stripView img[src], #mainImg')].some((i) => i.naturalWidth > 0) && getComputedStyle(document.getElementById('loadingScreen')).display === 'none', null, { what: 'the reader' });
  await sleep(500);
  await page.mouse.move(640, 600);
  const watch = await layerWatch(page);
  t.after(() => watch.close());
  return { page, watch };
}
// A motion met mid-way: what the compositor animates (nothing), what runs, and what is on a layer then
// that is on none at rest or once it has come to rest (a layer of the state's own, an element shown or
// hidden, is not the motion's).
async function midway(watch, act) {
  const r = await watch.during(act);
  const end = (await watch.read()).map((l) => `${l.who} [${l.why.join(', ')}]`);
  return { ...r, motionOnly: r.gained.filter((l) => !end.includes(l)) };
}

test('the top bar unpinned slides in and out by its top, and fit and zoom come and go by their number: nothing is the compositor\'s', { skip: !chromePath() }, async (t) => {
  const { page, watch } = await reader(t, { pinned: false });
  const shown = await midway(watch, () => page.evaluate(() => document.body.classList.add('reader-nav-hover')));
  assert.deepEqual(shown.running, ['--zoom-shown', 'top'], 'sliding in by its top, zoom by its number');
  assert.deepEqual(shown.animated, [], 'no layer is there for an animation');
  const gone = await midway(watch, () => page.evaluate(() => document.body.classList.remove('reader-nav-hover')));
  assert.deepEqual([gone.running, gone.animated, gone.motionOnly], [['--zoom-shown', 'top'], [], []], 'sliding out');
  assert.deepEqual(await easedTransforms(page), [], 'the reader eases no transform');
});

test('the reading mode\'s mark slides by left, the translate ⇄ study switch\'s comes by its colour: nothing is the compositor\'s', { skip: !chromePath() }, async (t) => {
  const { page, watch } = await reader(t, { gid: TS });
  const mode = await midway(watch, () => page.keyboard.press('2'));
  assert.ok(mode.running.includes('left'), `the mark sliding by left (${mode.running})`);
  assert.deepEqual([mode.animated, mode.gained], [[], []], 'nothing on a layer for it');
  const view = await midway(watch, () => page.keyboard.press('t'));
  assert.ok(view.running.includes('background-color'), `the mark coming by its colour (${view.running})`);
  assert.deepEqual([view.animated, view.gained], [[], []], 'nothing on a layer for it');
});

test('the status line comes up by its bottom and in by its colours, its spinner out of its words\' flow', { skip: !chromePath() }, async (t) => {
  const { page, watch } = await reader(t);
  // (Its first word shows at once, as before: the line is made shown. A later one comes up and in.)
  await page.evaluate(async () => {
    const { pageStatus } = await import('/app/js/reader-page-menu.js');
    pageStatus('Done');
    document.querySelector('.page-status').classList.remove('show');
  });
  await sleep(400);
  const status = await midway(watch, () => page.evaluate(async () => {
    const { pageStatus } = await import('/app/js/reader-page-menu.js');
    pageStatus('Translating this page…', { busy: true });
  }));
  assert.ok(status.running.includes('--status-shown') && status.running.includes('bottom'), `by its number and its bottom (${status.running})`);
  assert.deepEqual(status.animated.filter((l) => !/^::before/.test(l)), [], 'nothing but its spinner is the compositor\'s');
  assert.deepEqual(await page.$eval('.page-status', (el) => [getComputedStyle(el).opacity, getComputedStyle(el, '::before').position]), ['1', 'absolute'], 'its opacity whole, its spinner out of the flow of its words');
});

test('the modern navigation hidden and shown, the progress bar\'s page pill and the bar hidden, go to top and the loading screen: by their numbers or colours', { skip: !chromePath() }, async (t) => {
  const side = await reader(t, { nav: 'side' });
  const hide = await midway(side.watch, () => side.page.keyboard.press('x'));
  assert.deepEqual(hide.running, ['--sn-shown', '--zoom-shown'], 'the rail, the pill and zoom by their numbers');
  assert.deepEqual(hide.animated, [], 'no layer is there for an animation');
  const { page, watch } = await reader(t, { mode: 'strip' });
  const at = await page.$eval('#bottombar', (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + 1 }; });
  const tip = await midway(watch, () => page.mouse.move(at.x, at.y, { steps: 3 }));
  assert.ok(tip.running.includes('--tip-shown'), `the pill by its colours (${tip.running})`);
  assert.deepEqual(tip.animated, [], 'no layer is there for an animation');
  await page.mouse.move(640, 600);
  await sleep(400);
  const top = await midway(watch, () => page.evaluate(() => scrollTo(0, 1500)));
  assert.deepEqual(top.animated, [], 'go to top: no layer is there for an animation');
  assert.equal(await page.$eval('#scrollTopBtn', (el) => [el.classList.contains('visible'), getComputedStyle(el).opacity].join()), 'true,1', 'go to top shown, whole');
  const bar = await midway(watch, () => page.evaluate(() => document.getElementById('bottombar').classList.add('hidden')));
  assert.deepEqual([bar.running, bar.animated], [['--bar-shown'], []], 'the bar hidden by its number');
  const load = await midway(watch, () => page.evaluate(() => { const el = document.getElementById('loadingScreen'); el.style.display = 'flex'; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }));
  assert.ok(load.running.includes('loadingReveal'), `the loading screen fading in (${load.running})`);
  assert.deepEqual(load.animated.filter((l) => !/spinner/.test(l)), [], 'nothing but its spinner is the compositor\'s');
});

test('the top bar\'s page menu: its caret turns by a number and its list unrolls with no fade; only the list is on a layer of its own', { skip: !chromePath() }, async (t) => {
  const { page, watch } = await reader(t);
  const opened = await midway(watch, () => page.click('#pageNav'));
  if (!(await page.evaluate(() => CSS.supports('appearance', 'base-select')))) return;
  assert.ok(opened.running.includes('--pn-turn'), `the caret turning by its number (${opened.running})`);
  assert.deepEqual(opened.animated, [], 'no layer is there for an animation');
  assert.deepEqual(opened.gained.filter((l) => !/AnchorPosition/.test(l)), [], 'nothing but the list itself got a layer');
  await page.keyboard.press('Escape');
});

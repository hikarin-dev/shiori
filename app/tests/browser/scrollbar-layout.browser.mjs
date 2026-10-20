import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, openPage } from './harness.mjs';

const GALLERY = '1790000000301';
let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--force-device-scale-factor=1'] });
  await seed(browser);
});
after(async () => { await browser?.close(); server?.close(); });

async function seed(instance) {
  const page = await openPage(instance, origin);
  await page.goto(origin + '/library');
  await page.evaluate(async gid => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'Scrollbar layout fixture' }, numPages: 2 });
    for (const [index, height] of [200, 1500].entries()) {
      const canvas = new OffscreenCanvas(600, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#789';
      ctx.fillRect(0, 0, canvas.width, height);
      await api.pages.put(gid, index + 1, await canvas.convertToBlob({ type: 'image/png' }));
    }
  }, GALLERY);
  await page.close();
}

async function fresh(t, route, instance = browser) {
  const page = await openPage(instance, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(() => {
    localStorage.removeItem('shiori:customScrollbar');
    localStorage.setItem('shiori-reader-pin', '1');
    for (const [key, value] of Object.entries({ readerMode: 'single', readerFitMode: 'off', readerPageZoom: 1 })) {
      localStorage.setItem('shiori:' + key, JSON.stringify(value));
    }
  });
  await page.goto(origin + route);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function overflow(page, value) {
  await page.evaluate(async value => {
    document.body.style.minHeight = '300vh';
    document.documentElement.style.overflowY = value;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, value);
}

const geometry = (page, selectors) => page.evaluate(selectors => {
  const root = document.documentElement;
  return {
    content: selectors.map(selector => {
      const { x, width } = document.querySelector(selector).getBoundingClientRect();
      return { x, width };
    }),
    padding: parseFloat(getComputedStyle(document.body).paddingRight),
    nativeWidth: parseFloat(getComputedStyle(root).getPropertyValue('--page-scrollbar-width')),
    occupied: innerWidth - root.clientWidth,
    clientWidth: root.clientWidth, scrollWidth: root.scrollWidth,
    headerRight: document.querySelector('header, #topbar').getBoundingClientRect().right,
  };
}, selectors);

for (const [route, selectors] of [
  ['/library', ['.header-right', '.toolbar', '#grid']],
  ['/settings', ['.header-right', '.settings-page', '.content']],
  [`/overview?g=${GALLERY}`, ['.header-right', '.ov-wrap', '.series-cover']],
]) {
  test(`${route.split('?')[0]} content stays aligned while the navbar reaches the edge`, { skip: !chromePath() }, async t => {
    const page = await fresh(t, route);
    await page.waitForSelector(selectors.at(-1));
    for (const width of route === '/settings' ? [1280, 480] : [1280]) {
      await page.setViewport({ width, height: 900 });
      await overflow(page, 'hidden');
      const short = await geometry(page, selectors);
      assert.equal(short.padding, short.nativeWidth);
      assert.ok(short.nativeWidth > 0);
      assert.equal(short.headerRight, short.clientWidth, 'navbar background fills the compensation');
      assert.equal(short.scrollWidth, short.clientWidth, 'compensation must not cause horizontal overflow');
      await overflow(page, 'auto');
      const tall = await geometry(page, selectors);
      assert.equal(tall.padding, 0);
      assert.equal(tall.occupied, short.nativeWidth);
      assert.deepEqual(tall.content, short.content, 'content must not move or reflow');
      assert.equal(tall.headerRight, tall.clientWidth);
      assert.equal(tall.scrollWidth, tall.clientWidth);
      await overflow(page, 'hidden');
      assert.deepEqual(await geometry(page, selectors), short, 'removing the scrollbar restores padding');
    }
  });
}

test('reader images and controls stay aligned across page sizes, modes and pinning', { skip: !chromePath() }, async t => {
  const page = await fresh(t, `/reader?g=${GALLERY}&page=1`);
  await page.waitForFunction(() => document.querySelector('#mainImg').naturalWidth > 0);
  const selectors = ['#modeToggle', '#bottombar', '#mainImg'];
  const short = await geometry(page, selectors);
  assert.equal(short.occupied, 0);
  assert.equal(short.padding, short.nativeWidth);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('#mainImg').naturalHeight === 1500);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const tall = await geometry(page, selectors);
  assert.equal(tall.occupied, short.nativeWidth);
  assert.deepEqual(tall.content, short.content);
  assert.equal(tall.scrollWidth, tall.clientWidth, 'default page width must fit beside the scrollbar');
  for (const pinned of [false, true]) {
    await page.evaluate(pinned => {
      if (document.body.classList.contains('reader-unpinned') === pinned) document.getElementById('readerPinBtn').click();
    }, pinned);
    for (const mode of ['single', 'double', 'strip']) {
      await page.evaluate(mode => document.getElementById('mode' + mode[0].toUpperCase() + mode.slice(1)).click(), mode);
      const image = mode === 'single' ? '#mainImg' : mode === 'double' ? '#doubleInner .dImg' : '#stripView .page-img';
      await overflow(page, 'hidden');
      const before = await geometry(page, ['#modeToggle', '#bottombar', image]);
      await overflow(page, 'auto');
      const after = await geometry(page, ['#modeToggle', '#bottombar', image]);
      assert.deepEqual(after.content, before.content, `${mode}, pinned ${pinned}`);
      assert.equal(before.headerRight, before.clientWidth);
      assert.equal(after.headerRight, after.clientWidth);
    }
  }
});

test('at a fractional display scale the side controls and the reader dialogs stay put as the scrollbar comes and goes', { skip: !chromePath() }, async t => {
  // At 1.25 the scrollbar is 15.2px wide, which the window's whole-pixel sizes read as 15 or 16.
  const scaled = await puppeteer.launch({ executablePath: chromePath(), headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--force-device-scale-factor=1.25'] });
  await seed(scaled);
  const page = await fresh(t, `/reader?g=${GALLERY}&page=1`, scaled);
  t.after(() => scaled.close());
  await page.evaluate(() => localStorage.setItem('shiori-reader-nav', 'side'));
  await page.reload();
  await page.waitForFunction(() => document.body.classList.contains('reader-side-nav') && document.querySelector('#mainImg').naturalWidth > 0);
  const edges = () => page.evaluate(() => {
    const rect = sel => document.querySelector(sel).getBoundingClientRect();
    const open = (overlay, box) => {
      document.querySelector(overlay).classList.add('show');
      const { left, right } = rect(box);
      document.querySelector(overlay).classList.remove('show');
      return [left, right];
    };
    const [settingsLeft, settingsRight] = open('#readerSettingsModal', '#readerSettingsBox');
    const [shortcutsLeft, shortcutsRight] = open('#keybindModal', '#keybindBox');
    // The rail across the top, centred: in the width the pages keep, a scrollbar beside them or not.
    const root = document.documentElement.dataset;
    [root.snPos, root.snAlign] = ['top', 'center'];
    const topCentre = rect('#snRail').left;
    [root.snPos, root.snAlign] = ['right', 'start'];
    return {
      scrollbar: innerWidth > document.documentElement.clientWidth,
      edges: { pill: rect('#snChapter').right, rail: rect('#snRail').right, topCentre, sideZoom: rect('#sideZoom').right, settingsLeft, settingsRight, shortcutsLeft, shortcutsRight },
    };
  });
  await overflow(page, 'hidden');
  const short = await edges();
  await overflow(page, 'auto');
  const tall = await edges();
  assert.deepEqual([short.scrollbar, tall.scrollbar], [false, true]);
  // Within a layout unit (1/64 px): what's left is rounding, not a shift.
  for (const [name, edge] of Object.entries(short.edges)) {
    assert.ok(Math.abs(edge - tall.edges[name]) < 1 / 64, `${name} moved from ${edge} to ${tall.edges[name]}`);
  }
});

test('custom overlays clear compensation and disabling them restores it',{ skip: !chromePath() }, async t => {
  const page = await fresh(t, '/library');
  await overflow(page, 'hidden');
  const native = await geometry(page, ['.toolbar']);
  await page.evaluate(async () => {
    localStorage.setItem('shiori:customScrollbar', 'true');
    (await import('/app/js/scrollbar.js')).applyScrollbarPreference();
  });
  await overflow(page, 'hidden');
  const short = await geometry(page, ['.toolbar']);
  assert.equal(short.padding, 0);
  assert.equal(short.nativeWidth, 0);
  await overflow(page, 'auto');
  assert.deepEqual((await geometry(page, ['.toolbar'])).content, short.content);
  await page.evaluate(async () => {
    localStorage.setItem('shiori:customScrollbar', 'false');
    (await import('/app/js/scrollbar.js')).applyScrollbarPreference();
  });
  await overflow(page, 'hidden');
  assert.deepEqual(await geometry(page, ['.toolbar']), native);
});

test('zero-width native scrollbars use the full page without compensation', { skip: !chromePath() }, async t => {
  // Chrome's headless hidden-scrollbar mode provides the same zero-width geometry as overlays.
  const overlayBrowser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
  const page = await fresh(t, '/library', overlayBrowser);
  t.after(() => overlayBrowser.close());
  await overflow(page, 'hidden');
  const short = await geometry(page, ['.toolbar', '#grid']);
  assert.equal(short.padding, 0);
  assert.equal(short.nativeWidth, 0);
  await overflow(page, 'auto');
  const tall = await geometry(page, ['.toolbar', '#grid']);
  assert.equal(tall.occupied, 0);
  assert.equal(tall.padding, 0);
  assert.deepEqual(tall.content, short.content);
});

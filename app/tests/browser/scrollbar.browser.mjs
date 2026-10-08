import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, openPage } from './harness.mjs';

let server, origin, browser;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pageTrack = '.page-scrollbar .scrollbar-overlay';

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'],
    args: ['--force-device-scale-factor=1'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function settings(t) {
  const page = await openPage(browser, origin);
  await page.evaluateOnNewDocument(() => localStorage.setItem('shiori:customScrollbar', 'true'));
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.goto(`${origin}/settings`, { waitUntil: 'load' });
  await page.waitForSelector(pageTrack);
  await page.evaluate(() => {
    document.body.style.minHeight = `${innerHeight * 20}px`;
    scrollTo({ top: 500, behavior: 'instant' });
  });
  await wait(100);
  return page;
}

async function center(page, selector) {
  return page.$eval(selector, (el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
}

test('the overlay preserves viewport width, expands on hover, and fades after inactivity', { skip: !chromePath() }, async (t) => {
  const page = await settings(t);
  const dimensions = () => page.evaluate(() => ({
    viewport: innerWidth, content: document.documentElement.clientWidth,
    body: document.body.getBoundingClientRect().width,
  }));
  const initial = await dimensions();
  assert.equal(initial.content, initial.viewport, 'the scrollbar must not reserve a gutter');
  await page.mouse.move(20, 20);
  assert.equal(await page.$eval(`${pageTrack} .scrollbar-thumb`, el => getComputedStyle(el).backgroundColor), 'rgb(149, 149, 149)');
  const restWidth = await page.$eval(`${pageTrack} .scrollbar-thumb`, (el) => el.getBoundingClientRect().width);
  assert.ok(Math.abs(restWidth - 2) < .1, `resting thumb width: ${restWidth}`);
  const thumb = await center(page, `${pageTrack} .scrollbar-thumb`);
  await page.mouse.move(thumb.x, thumb.y);
  const hoverWidth = await page.$eval(`${pageTrack} .scrollbar-thumb`, (el) => el.getBoundingClientRect().width);
  assert.ok(Math.abs(hoverWidth - 6) < .1, `hovered thumb width: ${hoverWidth}`);
  assert.equal(await page.$eval(`${pageTrack} .scrollbar-thumb`, el => getComputedStyle(el).backgroundColor), 'rgb(149, 149, 149)', 'Firefox changes width, not color, on hover');
  assert.deepEqual(await dimensions(), initial, 'hovering must not shift the page');
  await page.mouse.move(20, 20);
  await page.evaluate(() => scrollBy({ top: 100, behavior: 'instant' }));
  await page.waitForFunction((selector) => getComputedStyle(document.querySelector(selector)).opacity === '1', {}, pageTrack);
  await wait(2000);
  assert.equal(await page.$eval(pageTrack, (el) => getComputedStyle(el).opacity), '1', 'the fade must not start early');
  await page.mouse.move(21, 20);
  await wait(750);
  assert.equal(await page.$eval(pageTrack, (el) => getComputedStyle(el).opacity), '1', 'mouse activity must postpone fading');
  await page.waitForFunction((selector) => getComputedStyle(document.querySelector(selector)).opacity === '0', { timeout: 4000 }, pageTrack);
  assert.deepEqual(await dimensions(), initial, 'fading must not shift the page');
  await page.mouse.move(1274, 6);
  await page.waitForFunction((selector) => getComputedStyle(document.querySelector(selector)).opacity === '1', {}, pageTrack);
  assert.deepEqual(await dimensions(), initial, 'hovering the hidden bar reveals it without shifting content');
});

test('wheel input preserves capture and continued dragging restores the original cursor grab point', { skip: !chromePath() }, async (t) => {
  const page = await settings(t);
  const thumb = await center(page, `${pageTrack} .scrollbar-thumb`);
  await page.mouse.move(thumb.x, thumb.y);
  await page.mouse.down();
  assert.equal(await page.$eval(`${pageTrack} .scrollbar-thumb`, el => getComputedStyle(el).backgroundColor), 'rgb(120, 120, 120)');
  await page.mouse.move(thumb.x, thumb.y + 12);
  await page.waitForFunction(() => scrollY > 600);
  const dragged = await page.evaluate(() => scrollY);
  await page.mouse.wheel({ deltaY: 400 });
  await page.waitForFunction((previous) => scrollY > previous + 300, {}, dragged);
  await wait(200);
  assert.equal(await page.$eval(pageTrack, el => el.classList.contains('held')), true);
  assert.equal(await page.$eval(`${pageTrack} .scrollbar-thumb`, el => getComputedStyle(el).backgroundColor), 'rgb(120, 120, 120)', 'wheel input must retain the pressed color');
  await page.mouse.move(thumb.x, thumb.y + 24);
  await page.waitForFunction(({ selector, y }) => {
    const rect = document.querySelector(`${selector} .scrollbar-thumb`).getBoundingClientRect();
    return Math.abs(rect.y + rect.height / 2 - y) < 1;
  }, { timeout: 3000 }, { selector: pageTrack, y: thumb.y + 24 });
  const resumed = await page.evaluate(() => scrollY);
  await page.mouse.up();
  await wait(200);
  assert.equal(await page.evaluate(() => scrollY), resumed);
  assert.equal(await page.$eval(`${pageTrack} .scrollbar-thumb`, el => getComputedStyle(el).backgroundColor), 'rgb(149, 149, 149)');
});

test('dragging under 20x CPU throttling does not relayout the page', { skip: !chromePath() }, async (t) => {
  const page = await settings(t);
  await page.evaluate(() => document.fonts.ready);
  const thumb = await center(page, `${pageTrack} .scrollbar-thumb`);
  await page.mouse.move(thumb.x, thumb.y);
  await page.mouse.down();
  await wait(200);
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  try {
    const layoutCount = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount').value;
    const before = await layoutCount();
    await page.mouse.move(thumb.x, thumb.y + 120, { steps: 20 });
    const moved = await center(page, `${pageTrack} .scrollbar-thumb`);
    assert.ok(Math.abs(moved.y - thumb.y - 120) < 1, 'the thumb should follow the dragged position');
    assert.equal(await layoutCount(), before, 'moving the thumb must not trigger page layout');
    await page.mouse.up();
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
});

test('native wheel input cancels a held arrow immediately', { skip: !chromePath() }, async (t) => {
  const page = await settings(t);
  const down = await center(page, `${pageTrack} .scrollbar-arrow.down`);
  await page.mouse.move(down.x, down.y);
  await page.mouse.down();
  await wait(200);
  const beforeWheel = await page.evaluate(() => scrollY);
  assert.ok(beforeWheel > 550, 'holding the arrow should advance the page');
  await page.mouse.wheel({ deltaY: -400 });
  await page.waitForFunction((previous) => scrollY < previous - 300, {}, beforeWheel);
  await wait(200);
  const held = await page.evaluate(() => scrollY);
  await wait(200);
  assert.equal(await page.evaluate(() => scrollY), held, 'the arrow must stop repeating after wheel input');
  await page.mouse.up();
  await wait(100);
  assert.equal(await page.evaluate(() => scrollY), held);
});

test('holding the track moves continuously until the thumb crosses the pointer', { skip: !chromePath() }, async (t) => {
  const page = await settings(t);
  const point = await page.$eval(pageTrack, (el) => {
    const track = el.getBoundingClientRect(), thumb = el.querySelector('.scrollbar-thumb').getBoundingClientRect();
    return { x: track.x + track.width / 2, y: thumb.bottom + thumb.height * 2.5, start: scrollY, page: innerHeight };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForFunction(({ y, start, page, selector }) => {
    const thumb = document.querySelector(`${selector} .scrollbar-thumb`).getBoundingClientRect();
    return scrollY > start + page * 1.5 && thumb.bottom >= y - 1;
  }, { timeout: 5000 }, { ...point, selector: pageTrack });
  await wait(350);
  const reached = await page.$eval(`${pageTrack} .scrollbar-thumb`, (el) => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, offset: scrollY };
  });
  assert.ok(reached.top <= point.y + 1 && reached.bottom >= point.y - 1, 'the thumb must stop over the held pointer');
  await wait(350);
  assert.equal(await page.evaluate(() => scrollY), reached.offset, 'holding must not continue past the pointer');
  await page.mouse.up();
  await wait(150);
  assert.equal(await page.evaluate(() => scrollY), reached.offset, 'release must not restore an earlier offset');
});

test('both track edges accept a hold and advance on consecutive frames', { skip: !chromePath() }, async (t) => {
  const page = await settings(t);
  for (const edge of ['left', 'right']) {
    await page.evaluate(() => scrollTo({ top: 500, behavior: 'instant' }));
    await wait(50);
    const point = await page.$eval(pageTrack, (el, side) => {
      const rect = el.getBoundingClientRect();
      return { x: side === 'left' ? rect.left + .5 : rect.right - .5, y: rect.height * .8 };
    }, edge);
    await page.evaluate(() => {
      window.scrollbarFrames = [];
      window.scrollbarSampling = true;
      const sample = (time) => {
        window.scrollbarFrames.push([time, scrollY]);
        if (window.scrollbarSampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await wait(500);
    await page.mouse.up();
    const frames = await page.evaluate(() => { window.scrollbarSampling = false; return window.scrollbarFrames; });
    const moving = frames.filter(([time], i) => i && time - frames[0][0] > 280 && frames[i][1] > frames[i - 1][1]);
    assert.ok(moving.length >= 7, `${edge}: the hold must advance each frame, not in periodic page jumps`);
    assert.ok(frames.at(-1)[1] > 2300, `${edge}: holding must continue beyond the initial page`);
  }
});

test('a scrollbar appears when page growth creates overflow, then fades normally', { skip: !chromePath() }, async (t) => {
  const page = await openPage(browser, origin);
  await page.evaluateOnNewDocument(() => localStorage.setItem('shiori:customScrollbar', 'true'));
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  page.removeAllListeners('request');
  page.on('request', (request) => {
    if (request.url() === `${origin}/scrollbar-fixture`) request.respond({ status: 200, contentType: 'text/html',
      body: '<!doctype html><link rel="icon" href="/icons/icon16.png"><link rel="stylesheet" href="/app/base.css"><body><div>Short page</div><script type="module" src="/app/js/scrollbar.js"></script>' });
    else if (request.url().startsWith(origin)) request.continue();
    else request.abort();
  });
  await page.goto(`${origin}/scrollbar-fixture`);
  await page.waitForSelector(pageTrack);
  await wait(3000);
  assert.equal(await page.$eval(pageTrack, (el) => el.hidden), true);
  await page.evaluate(() => {
    const content = document.createElement('div');
    content.style.height = `${innerHeight * 2}px`;
    document.body.append(content);
  });
  await page.waitForFunction((selector) => {
    const bar = document.querySelector(selector);
    return !bar.hidden && getComputedStyle(bar).opacity === '1';
  }, {}, pageTrack);
  assert.equal(await page.evaluate(() => innerWidth - document.documentElement.clientWidth), 0);
  await page.waitForFunction((selector) => getComputedStyle(document.querySelector(selector)).opacity === '0', { timeout: 4000 }, pageTrack);
});

test('releasing a held track stops repetition', { skip: !chromePath() }, async (t) => {
  const page = await settings(t);
  const point = await page.$eval(pageTrack, (el) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height * .8 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.waitForFunction(() => scrollY > 800);
  await page.mouse.up();
  await wait(250);
  const released = await page.evaluate(() => scrollY);
  await wait(350);
  assert.equal(await page.evaluate(() => scrollY), released, 'release must stop subsequent track pages');
});

test('arrow colors remain unchanged at the top, middle, and bottom', { skip: !chromePath() }, async (t) => {
  const page = await settings(t);
  const colors = [];
  for (const position of [0, .5, 1]) {
    await page.evaluate((fraction) => {
      const root = document.documentElement;
      scrollTo({ top: (root.scrollHeight - root.clientHeight) * fraction, behavior: 'instant' });
    }, position);
    await wait(50);
    colors.push(await page.$$eval(`${pageTrack} .scrollbar-arrow`, (arrows) => arrows.map((el) => ({
      color: getComputedStyle(el).color,
      glyph: getComputedStyle(el, '::before').backgroundColor,
    }))));
  }
  assert.deepEqual(colors[0], colors[1], 'the top arrow must retain its normal color at the top');
  assert.deepEqual(colors[2], colors[1], 'the bottom arrow must retain its normal color at the bottom');
});

for (const display of ['block', 'flex']) {
  test(`a padded ${display} panel retains its layout and native wheel scrolling`, { skip: !chromePath() }, async (t) => {
    const page = await settings(t);
    await page.evaluate((layout) => {
      const panel = document.createElement('div');
      panel.id = 'scrollbar-test-panel';
      panel.style.cssText = `position:fixed;left:100px;top:100px;width:280px;height:240px;padding:19px;border:1px solid;overflow:auto;overscroll-behavior:contain;display:${layout};flex-direction:column;gap:16px;background:#123`;
      panel.innerHTML = '<div style="height:500px;flex:none">First</div><div style="height:500px;flex:none">Second</div>';
      document.body.append(panel);
    }, display);
    const panelTrack = '#scrollbar-test-panel > .scrollbar-host .scrollbar-overlay';
    await page.waitForSelector(panelTrack);
    const layout = await page.$eval('#scrollbar-test-panel', (el) => {
      const rect = el.getBoundingClientRect(), first = el.children[1].getBoundingClientRect();
      const track = el.querySelector('.scrollbar-overlay').getBoundingClientRect();
      return { width: el.clientWidth, contentTop: first.top - rect.top,
        trackTop: track.top - rect.top, trackRight: rect.right - track.right };
    });
    assert.equal(layout.width, 278, 'the panel must not reserve a vertical gutter');
    assert.equal(layout.contentTop, 20, 'adding controls must not move the first content row');
    assert.equal(layout.trackTop, 1, 'the track starts inside the panel border');
    assert.equal(layout.trackRight, 1, 'the track aligns with the panel border');
    const thumb = await center(page, `${panelTrack} .scrollbar-thumb`);
    await page.mouse.move(thumb.x, thumb.y);
    assert.equal(await page.$eval(panelTrack, (el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    const rootOffset = await page.evaluate(() => scrollY);
    await page.mouse.wheel({ deltaY: 300 });
    await page.waitForFunction(() => document.getElementById('scrollbar-test-panel').scrollTop > 200);
    await wait(100);
    assert.equal(await page.evaluate(() => scrollY), rootOffset, 'wheel input over the panel scrollbar must stay in the panel');
    const after = await page.$eval('#scrollbar-test-panel', (el) => ({
      top: el.querySelector('.scrollbar-overlay').getBoundingClientRect().top - el.getBoundingClientRect().top,
      height: el.scrollHeight,
    }));
    assert.equal(after.top, 1, 'the overlay remains pinned when the panel scrolls');
    assert.equal(after.height, display === 'flex' ? 1054 : 1038, 'the controls must not extend the scrollable content');
  });
}

test('horizontal controls stay native alongside the vertical overlay', { skip: !chromePath() }, async t => {
  const page = await settings(t);
  await page.evaluate(() => {
    const panel = document.createElement('div');
    panel.id = 'horizontal-panel';
    panel.style.cssText = 'position:fixed;left:100px;top:100px;width:200px;height:150px;overflow:auto';
    panel.innerHTML = '<div style="width:600px;height:1000px"></div>';
    document.body.append(panel);
  });
  await page.waitForSelector('#horizontal-panel .scrollbar-overlay');
  const dimensions = await page.$eval('#horizontal-panel', el => ({ width: el.clientWidth, height: el.clientHeight }));
  assert.deepEqual(dimensions, { width: 200, height: 138 }, 'only the native horizontal scrollbar reserves space');
  await page.mouse.move(130, 244);
  await page.mouse.down();
  await page.mouse.move(240, 244, { steps: 5 });
  await page.mouse.up();
  assert.ok(await page.$eval('#horizontal-panel', el => el.scrollLeft > 150), 'the native horizontal thumb remains draggable');
});

test('a panel keeps its overlay after its contents are replaced', { skip: !chromePath() }, async (t) => {
  const page = await settings(t);
  await page.evaluate(() => {
    const panel = document.createElement('div');
    panel.id = 'scrollbar-test-panel';
    panel.style.cssText = 'position:fixed;left:100px;top:100px;width:280px;height:240px;overflow:auto';
    panel.innerHTML = '<div style="height:1000px">Initial content</div>';
    document.body.append(panel);
  });
  const selector = '#scrollbar-test-panel > .scrollbar-host';
  await page.waitForSelector(selector);
  await page.$eval('#scrollbar-test-panel', (el) => {
    el.innerHTML = '<div style="height:1200px">Updated content</div>';
  });
  await page.waitForSelector(selector, { timeout: 3000 });
  assert.equal(await page.$eval('#scrollbar-test-panel', (el) => el.clientWidth), 280);
});

test('the long language picker keeps native wheel input and keyboard selection', { skip: !chromePath() }, async (t) => {
  const page = await settings(t);
  const initial = await page.$eval('#langSelect', (el) => el.value);
  await page.click('#langSelect');
  const list = '#langSelect .dd-options';
  const track = `${list} .scrollbar-overlay`;
  await page.waitForSelector(track, { visible: true });
  await wait(200);
  assert.ok(await page.$eval('#langSelect', (el) => el.matches(':open')));
  assert.equal(await page.$eval('#langSelect', (el) => el.value), initial, 'opening the picker must preserve its selected option');
  const thumb = await center(page, `${track} .scrollbar-thumb`);
  await page.mouse.move(thumb.x, thumb.y);
  assert.equal(await page.$eval(track, (el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  const rootOffset = await page.evaluate(() => scrollY);
  await page.mouse.wheel({ deltaY: 180 });
  await page.waitForFunction(() => document.querySelector('#langSelect .dd-options').scrollTop > 100);
  assert.equal(await page.evaluate(() => scrollY), rootOffset);
  await wait(400); // OverlayScrollbars lets wheel events pass through its controls for 333ms.
  const movedThumb = await center(page, `${track} .scrollbar-thumb`);
  await page.mouse.move(movedThumb.x, movedThumb.y);
  await page.mouse.down();
  await page.mouse.move(movedThumb.x, movedThumb.y + 10);
  await page.mouse.up();
  assert.ok(await page.$eval('#langSelect', (el) => el.matches(':open')), 'dragging the thumb must not close the picker');
  const down = await center(page, `${track} .scrollbar-arrow.down`);
  await page.mouse.move(down.x, down.y);
  await page.mouse.down();
  await wait(100);
  await page.mouse.up();
  assert.ok(await page.$eval('#langSelect', (el) => el.matches(':open')), 'pressing an arrow must not close the picker');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#langSelect', (el) => el.matches(':open')), false);
  await page.click('#langSelect');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.getElementById('langSelect').matches(':open'));
  assert.notEqual(await page.$eval('#langSelect', (el) => el.value), initial, 'keyboard selection must still reach the wrapped options');
});

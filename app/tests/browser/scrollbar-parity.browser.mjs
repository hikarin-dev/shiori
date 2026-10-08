import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, openPage } from './harness.mjs';

let server, origin, browser;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--force-device-scale-factor=1'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function fixture(t, integrated) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  page.removeAllListeners('request');
  page.on('request', request => {
    if (request.url() === `${origin}/parity-fixture`) request.respond({ status: 200, contentType: 'text/html',
      body: `<!doctype html><link rel="icon" href="data:,"><link rel="stylesheet" href="/app/base.css">
        <style>body{height:18000px}.reference.os-scrollbar{position:fixed;--os-size:12px;
          --os-padding-axis:12px;--os-padding-perpendicular:0px;--os-handle-min-size:20px;
          --os-handle-perpendicular-size:6px;--os-handle-perpendicular-size-hover:6px;
          --os-handle-perpendicular-size-active:6px}.reference .os-scrollbar-handle{right:3px}
        </style><body><script type="module">
          ${integrated ? `localStorage.setItem('shiori:customScrollbar','true');await import('/app/js/scrollbar.js');` : `
          import {OverlayScrollbars,ClickScrollPlugin} from '/vendor/overlayscrollbars/overlayscrollbars.mjs';
          OverlayScrollbars.plugin(ClickScrollPlugin);
          OverlayScrollbars({target:document.body,elements:{viewport:document.body},scrollbars:{slot:document.documentElement}},
            {scrollbars:{theme:'reference',clickScroll:true,autoHide:'never'}});`}
          window.ready=true;
        </script>` });
    else if (request.url().startsWith(origin) || request.url().startsWith('data:')) request.continue();
    else request.abort();
  });
  await page.goto(`${origin}/parity-fixture`);
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => scrollTo(0, 500));
  await wait(100);
  return page;
}

const handle = '.os-scrollbar-vertical .os-scrollbar-handle';
async function center(page) {
  return page.$eval(handle, el => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
}

test('drag, repeated wheel input, and continued dragging match unmodified OverlayScrollbars', { skip: !chromePath() }, async t => {
  const results = [];
  for (const integrated of [false, true]) {
    const page = await fixture(t, integrated);
    const grab = await center(page);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    const offsets = [];
    for (const [distance, wheel] of [[40, 450], [70, -300], [25, 500]]) {
      await page.mouse.move(grab.x, grab.y + distance);
      await wait(50);
      const beforeWheel = await page.evaluate(() => scrollY);
      await page.mouse.wheel({ deltaY: wheel });
      await wait(500);
      const afterWheel = await page.evaluate(() => scrollY);
      assert.ok(Math.abs(afterWheel - beforeWheel) > 200, 'wheel input must work during the drag');
      assert.equal(await page.$eval(handle, el => el.hasPointerCapture(1)), true, 'wheel input retains pointer capture');
      await page.mouse.move(grab.x, grab.y + distance + 10);
      await wait(50);
      const resumed = await center(page);
      assert.ok(Math.abs(resumed.y - grab.y - distance - 10) < 1, 'the original grab point returns to the cursor');
      offsets.push(await page.evaluate(() => scrollY));
    }
    await page.mouse.up();
    assert.equal(await page.$eval(handle, el => el.hasPointerCapture(1)), false);
    const released = await page.evaluate(() => scrollY);
    await page.mouse.move(grab.x, grab.y + 150);
    assert.equal(await page.evaluate(() => scrollY), released, 'release ends the drag');
    results.push(offsets);
  }
  for (let i = 0; i < results[0].length; i++) {
    assert.ok(Math.abs(results[0][i] - results[1][i]) <= 1, `upstream and integrated offsets: ${results[0]} / ${results[1]}`);
  }
});

test('track holding, wheel input during a hold, and Shift-click dragging match upstream', { skip: !chromePath() }, async t => {
  const results = [];
  for (const integrated of [false, true]) {
    const page = await fixture(t, integrated);
    const offsets = [];
    await page.mouse.move(1274, 550);
    await page.mouse.down();
    await wait(500);
    await page.mouse.wheel({ deltaY: -400 });
    await wait(1500);
    offsets.push(await page.evaluate(() => scrollY));
    await page.mouse.up();
    await wait(300);
    assert.equal(await page.evaluate(() => scrollY), offsets[0]);
    await page.evaluate(() => scrollTo(0, 500));
    await wait(100);
    await page.keyboard.down('Shift');
    await page.mouse.move(1274, 400);
    await page.mouse.down();
    await page.keyboard.up('Shift');
    await wait(50);
    assert.ok(Math.abs((await center(page)).y - 400) < 1, 'Shift-click places the handle at the pointer');
    await page.mouse.move(1274, 460);
    await wait(50);
    assert.ok(Math.abs((await center(page)).y - 460) < 1, 'Shift-click continues as a drag');
    offsets.push(await page.evaluate(() => scrollY));
    await page.mouse.up();
    results.push(offsets);
  }
  for (let i = 0; i < results[0].length; i++) {
    assert.ok(Math.abs(results[0][i] - results[1][i]) <= 1, `upstream and integrated offsets: ${results[0]} / ${results[1]}`);
  }
});

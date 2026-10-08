import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, openPage } from './harness.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--force-device-scale-factor=1'] });
});
after(async () => { await browser?.close(); server?.close(); });

async function fixture(t, density) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: density });
  page.removeAllListeners('request');
  page.on('request', request => {
    if (request.url() === origin + '/appearance-fixture') request.respond({
      status: 200, contentType: 'text/html',
      body: '<!doctype html><link rel="icon" href="data:,"><link rel="stylesheet" href="/app/base.css">' +
        '<style>body{min-height:2400px}</style><body><script type="module" src="/app/js/scrollbar.js"></script>',
    });
    else if (request.url().startsWith(origin) || request.url().startsWith('data:')) request.continue();
    else request.abort();
  });
  await page.evaluateOnNewDocument(() => localStorage.removeItem('shiori:customScrollbar'));
  await page.goto(origin + '/appearance-fixture');
  return page;
}

// Native scrollbar parts have no DOM rectangles; verify their painted colors.
async function paintedColors(page, density) {
  const gutter = await page.evaluate(() => innerWidth - document.documentElement.clientWidth);
  const png = await page.screenshot({ captureBeyondViewport: false });
  return page.evaluate(async ({ source, density, gutter }) => {
    const bitmap = await createImageBitmap(await (await fetch(source)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const at = (x, y) => Array.from(pixels.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3));
    const colors = new Map(), rail = Math.ceil(gutter * density);
    for (let y = rail; y < canvas.height - rail; y++) for (let x = canvas.width - rail; x < canvas.width; x++) {
      const color = at(x, y);
      if (color[0] <= 100) continue;
      const key = color.join(',');
      colors.set(key, (colors.get(key) || 0) + 1);
    }
    return { track: at(canvas.width - 1, Math.floor(canvas.height / 2)),
      thumb: [...colors].sort((a, b) => b[1] - a[1])[0]?.[0] };
  }, { source: 'data:image/png;base64,' + png.toString('base64'), density, gutter });
}

for (const density of [1, 1.5]) {
  test(`native scrollbar keeps its colors with browser geometry at ${density}x density`, { skip: !chromePath() }, async t => {
    const page = await fixture(t, density);
    await page.evaluate(() => scrollTo({ top: 300, behavior: 'instant' }));
    await page.mouse.move(400, 300);
    const style = await page.evaluate(() => {
      const root = document.documentElement;
      return { width: getComputedStyle(root).scrollbarWidth,
        color: getComputedStyle(root).scrollbarColor,
        customWidth: getComputedStyle(root, '::-webkit-scrollbar').width };
    });
    assert.deepEqual(style, { width: 'auto', color: 'rgb(149, 149, 149) rgb(23, 23, 23)', customWidth: 'auto' });
    assert.equal(await page.$('.scrollbar-host'), null, 'native controls must stay browser-owned');
    assert.deepEqual(await paintedColors(page, density), { track: [23, 23, 23], thumb: '149,149,149' });
    await page.evaluate(async () => {
      localStorage.setItem('shiori:customScrollbar', 'true');
      (await import('/app/js/scrollbar.js')).applyScrollbarPreference();
    });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarColor), 'auto',
      'native colors must not override the overlay controls');
  });
}

test('native thumb dragging avoids repeated painting at 20x CPU throttling', { skip: !chromePath() }, async t => {
  const page = await fixture(t, 1);
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  await page.mouse.move(793, 40);
  await page.mouse.down();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.tracing.start({ categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
  try {
    await page.mouse.move(793, 400, { steps: 36 });
    const trace = JSON.parse(Buffer.from(await page.tracing.stop()).toString('utf8'));
    const paints = trace.traceEvents.filter(event => event.ph === 'X' && event.name === 'Paint').length;
    assert.ok(paints <= 3, `native dragging must not repaint on each pointer move; observed ${paints} paints`);
    assert.ok(await page.evaluate(() => scrollY > 1000), 'the native thumb must still scroll the page');
  } finally {
    await page.mouse.up();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
});

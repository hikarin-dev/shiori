import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage } from './harness.mjs';

const GALLERY = '1790000000201';
const PAGE_COUNT = 180;
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/library`, { waitUntil: 'load' });
  await page.evaluate(async ({ gid, count }) => {
    const api = await import('/app/js/api.js');
    const platform = await import('/app/js/platform.js');
    await platform.kv.set({ readerMode: 'strip', readerFitMode: 'off', readerThumbsOpen: false });
    await api.meta.put({ galleryId: gid, title: { english: 'Navigation fixture' }, numPages: count });
    const blobs = await Promise.all([900, 420].map(async height => {
      const canvas = new OffscreenCanvas(600, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#789';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.convertToBlob({ type: 'image/png' });
    }));
    for (let n = 1; n <= count; n++) await api.pages.put(gid, n, blobs[n % 2]);
  }, { gid: GALLERY, count: PAGE_COUNT });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

async function reader(t, fit = 'off') {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(fit => localStorage.setItem('shiori:readerFitMode', JSON.stringify(fit)), fit);
  await page.goto(`${origin}/reader?g=${GALLERY}&page=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#stripView img')?.naturalWidth > 0);
  return page;
}

async function shiftKey(page, key) {
  await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  await page.keyboard.up('Shift');
}

async function expectPage(page, n) {
  await page.waitForFunction(n => {
    const row = document.querySelector(`#stripView [data-page="${n}"]`);
    if (!row) return false;
    const top = scrollY + row.getBoundingClientRect().top;
    const pinned = !document.body.classList.contains('reader-unpinned');
    const inset = pinned ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'), 10) : 0;
    const target = Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight, top - inset));
    return Math.abs(scrollY - target) < 2;
  }, { timeout: 5000 }, n);
}

for (const fit of ['off', 'height']) {
  test(`first-load jumps reach both ends with fit ${fit} while images stay virtualized`, { skip: !chromePath() }, async t => {
    const page = await reader(t, fit);
    await shiftKey(page, 'D');
    await expectPage(page, PAGE_COUNT);
    const mounted = await page.$$eval('#stripView img[src]', imgs => imgs.length);
    assert.ok(mounted < 50, `only the nearby image window should be mounted: ${mounted}`);
    await shiftKey(page, 'A');
    await expectPage(page, 1);
  });
}

test('manual scrolling still interrupts a jump while images are loading', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await page.mouse.move(600, 400);
  await shiftKey(page, 'D');
  await page.waitForFunction(() => scrollY > 2000);
  await page.mouse.wheel({ deltaY: -700 });
  await page.waitForFunction(() => !document.documentElement.classList.contains('reader-strip-gliding'));
  await new Promise(resolve => setTimeout(resolve, 1000));
  const remaining = await page.$eval('#stripView .page-wrap:last-child', row => row.getBoundingClientRect().top);
  assert.ok(remaining > 2000, 'the jump must stop before the destination when the user scrolls');
});

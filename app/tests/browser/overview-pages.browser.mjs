import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage } from './harness.mjs';

// The overview's page grid: a tile per page, its small copy made from the full page in a worker.
// Full-size, busy pages, so making a copy takes about as long as it does in a real library.
const GALLERY = '1790000000401';
const PAGE_COUNT = 150;
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/library`, { waitUntil: 'load' });
  await page.evaluate(async ({ gid, count }) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'Page grid fixture' }, numPages: count });
    const blobs = await Promise.all([0, 1, 2, 3].map(async k => {
      const canvas = new OffscreenCanvas(1280, 1800);
      const ctx = canvas.getContext('2d');
      for (let i = 0; i < 1000; i++) {
        ctx.fillStyle = `hsl(${(i * 37 + k * 90) % 360} 60% 50%)`;
        ctx.fillRect((i * 97) % 1280, (i * 211) % 1800, 30 + i % 50, 30 + i % 40);
      }
      return canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    }));
    for (let n = 1; n <= count; n++) await api.pages.put(gid, n, blobs[n % 4]);
  }, { gid: GALLERY, count: PAGE_COUNT });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

async function overview(t) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${origin}/overview?g=${GALLERY}`, { waitUntil: 'load' });
  await page.waitForFunction(n => document.querySelectorAll('.ov-page img').length === n, {}, PAGE_COUNT);
  return page;
}

// Scrolls to the end at `pxPerSec` and reports, over the frames on the way, the share of tiles on
// screen with no copy shown, and of those, how many drew as a bare <img> (the broken-image glyph).
function scrollToEnd(page, pxPerSec) {
  return page.evaluate(async (pxPerSec) => {
    const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
    const imgs = [...document.querySelectorAll('.ov-page img')];
    let last = await raf(), tiles = 0, blank = 0, glyph = 0;
    while (scrollY < document.documentElement.scrollHeight - innerHeight - 1) {
      const now = await raf();
      scrollBy(0, pxPerSec * (now - last) / 1000);
      last = now;
      for (const img of imgs) {
        const r = img.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) continue;
        tiles++;
        if (img.getAttribute('src') && img.complete && img.naturalWidth) continue;
        blank++;
        if (!img.getAttribute('src') && getComputedStyle(img).visibility !== 'hidden') glyph++;
      }
    }
    return { blank: blank / Math.max(1, tiles), glyph };
  }, pxPerSec);
}

test('a page tile whose copy is not made yet shows its ground, never a broken image', { skip: !chromePath() }, async t => {
  const page = await overview(t);
  const { glyph } = await scrollToEnd(page, 12000);
  assert.equal(glyph, 0, 'a sized <img> without a source draws the broken-image glyph');
});

// As in the reader, the grid's copies are made ahead, nearest first, once the tiles in view have
// theirs: scrolling on (or back) finds them made rather than making each as it comes.
test("the grid's copies are made ahead, so scrolling to the end finds them made", { skip: !chromePath() }, async t => {
  const page = await overview(t);
  await new Promise(resolve => setTimeout(resolve, 5000));
  const { blank } = await scrollToEnd(page, 12000);
  assert.ok(blank < 0.05, `tiles scrolled to should show their copies (${(blank * 100).toFixed(1)}% blank)`);
});

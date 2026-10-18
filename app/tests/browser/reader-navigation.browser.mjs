import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until, scrollSettled } from './harness.mjs';

const GALLERY = '1790000000201';
const PAGE_COUNT = 180;
const SPARSE_GALLERY = '1790000000202';   // 600 pages, only the first 5 stored
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/library`, { waitUntil: 'load' });
  await page.evaluate(async ({ gid, count, sparse }) => {
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
    await api.meta.put({ galleryId: sparse, title: { english: 'Sparse fixture' }, numPages: 600 });
    for (let n = 1; n <= 5; n++) await api.pages.put(sparse, n, blobs[0]);
  }, { gid: GALLERY, count: PAGE_COUNT, sparse: SPARSE_GALLERY });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

async function reader(t, fit = 'off', { at = 1, pinned = false } = {}) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument((fit, pinned) => {
    localStorage.setItem('shiori:readerFitMode', JSON.stringify(fit));
    localStorage.setItem('shiori:readerPageZoom', JSON.stringify(1));
    localStorage.setItem('shiori-reader-pin', pinned ? '1' : '0');
  }, fit, pinned);
  await page.goto(`${origin}/reader?g=${GALLERY}&page=${at}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#stripView img[src]')?.naturalWidth > 0);
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

// Waits until the mounted pages have loaded and the scroll has stopped moving.
async function settled(page) {
  let last = '', same = 0;
  for (let i = 0; i < 100 && same < 5; i++) {
    const now = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('#stripView img[src]')];
      return `${imgs.length}:${imgs.every(img => img.complete)}:${scrollY}`;
    });
    same = now === last && now.includes(':true:') ? same + 1 : 0;
    last = now;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// The page on the reading line and how far into it, as a fraction of its height.
function readingPoint(page) {
  return page.evaluate(() => {
    const pinned = !document.body.classList.contains('reader-unpinned');
    const line = pinned ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'), 10) : 0;
    for (const row of document.querySelectorAll('#stripView .page-wrap')) {
      const r = row.getBoundingClientRect();
      if (r.bottom > line) return { page: Number(row.dataset.page), top: r.top - line, frac: (line - r.top) / r.height };
    }
  });
}

for (const pinned of [false, true]) {
  test(`a deep link stays on its page while the pages around it load (${pinned ? 'pinned' : 'unpinned'} header)`, { skip: !chromePath() }, async t => {
    const page = await reader(t, 'off', { at: 120, pinned });
    await settled(page);
    const at = await readingPoint(page);
    assert.equal(at.page, 120);
    assert.ok(Math.abs(at.top) <= 1, `page 120 should start on the reading line, not ${at.top}px from it`);
  });
}

test('scaling the strip keeps the same point of the page on the reading line', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'off', { at: 120, pinned: true });
  await settled(page);
  await page.evaluate(() => scrollBy(0, Math.round(innerHeight * 0.4)));
  await settled(page);
  const start = await readingPoint(page);
  for (const [what, act] of [
    ['zoom out', () => page.keyboard.press('-')],
    ['fit height', () => shiftKey(page, 'Q')],
    ['zoom out while fitted', () => page.keyboard.press('-')],
    ['fit width', () => shiftKey(page, 'E')],
    ['window resize', () => page.setViewport({ width: 1000, height: 900 })],
  ]) {
    await act();
    await settled(page);
    const now = await readingPoint(page);
    assert.equal(now.page, start.page, `${what} moved the reading line to another page`);
    assert.ok(Math.abs(now.frac - start.frac) < 0.01, `${what} moved the reading line from ${start.frac} to ${now.frac} of the page`);
  }
});

test('a thumbnail click lands on its page', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await page.evaluate(() => document.getElementById('thumbBtn').click());
  const target = 150;
  const thumb = `#thumbStrip .thumb-item:has(img[data-idx="${target - 1}"])`;
  await until(page, sel => !!document.querySelector(sel), thumb, { what: 'the thumbnail' });
  await new Promise(resolve => setTimeout(resolve, 800));   // the bar has slid open and centred the current page
  await page.$eval(thumb, item => item.scrollIntoView({ inline: 'center', block: 'nearest' }));
  await new Promise(resolve => setTimeout(resolve, 300));
  const point = await page.$eval(thumb, item => { const r = item.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => !document.documentElement.classList.contains('reader-strip-gliding'));
  await settled(page);
  const at = await readingPoint(page);
  assert.equal(at.page, target);
  assert.ok(Math.abs(at.top) <= 1, `page ${target} should start on the reading line, not ${at.top}px from it`);
});

// Scrolls the strip from fractional page `from` to `to` (0-based) over `ms`, one step a frame, the way
// a scrubber drag does; returns how many pages were given an image on the way once it was under way
// (its first frames can't tell a scrub from a wheel yet, and aim the window once).
function flyStrip(page, from, to, ms) {
  return page.evaluate(async ({ from, to, ms }) => {
    const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
    const rows = [...document.querySelectorAll('#stripView .page-wrap')];
    let loads = 0;
    const watch = new MutationObserver(records => { if (performance.now() - t0 < 150) return; for (const r of records) if (r.target.getAttribute('src')) loads++; });
    const t0 = performance.now();
    watch.observe(document.getElementById('stripView'), { subtree: true, attributes: true, attributeFilter: ['src'] });
    for (;;) {
      const now = await raf();
      const f = Math.min(1, (now - t0) / ms), p = from + (to - from) * f, i = Math.floor(p);
      scrollTo(0, rows[i].offsetTop + (p - i) * rows[i].offsetHeight);
      if (f >= 1) break;
    }
    watch.disconnect();
    return loads;
  }, { from, to, ms });
}

test('flying past pages loads none of them, and the page it stops on loads at once', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  const loads = await flyStrip(page, 10, 150, 1500);
  assert.ok(loads <= 4, `passing ~140 pages in 1.5 s should load almost none of them, not ${loads}`);
  const landed = await page.evaluate(async () => {
    const t0 = performance.now();
    const img = document.querySelector('#stripView [data-page="151"] img');
    while (!(img.getAttribute('src') && img.complete && img.naturalWidth) && performance.now() - t0 < 3000) await new Promise(r => requestAnimationFrame(r));
    return Math.round(performance.now() - t0);
  });
  assert.ok(landed < 1000, `the page it stopped on should load at once, took ${landed} ms`);
});

// How much of the screen shows no page while the strip is scrolled at `screensPerSec` for `ms`.
function blankWhileScrolling(page, screensPerSec, ms) {
  return page.evaluate(async ({ screensPerSec, ms }) => {
    const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
    const rows = [...document.querySelectorAll('#stripView .page-wrap')];
    let blankPx = 0, allPx = 0, last = performance.now();
    const t0 = last;
    while (performance.now() - t0 < ms) {
      const now = await raf();
      scrollBy(0, innerHeight * screensPerSec * (now - last) / 1000);
      last = now;
      const top = scrollY, bottom = scrollY + innerHeight;
      for (const row of rows) {
        if (row.offsetTop >= bottom || row.offsetTop + row.offsetHeight <= top) continue;
        const shown = Math.min(bottom, row.offsetTop + row.offsetHeight) - Math.max(top, row.offsetTop);
        const img = row.querySelector('img');
        allPx += shown;
        if (!(img.getAttribute('src') && img.complete && img.naturalWidth)) blankPx += shown;
      }
    }
    return blankPx / allPx;
  }, { screensPerSec, ms });
}

test('reading at a steady pace finds every page loaded', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'off', { at: 30 });
  await settled(page);
  const blank = await blankWhileScrolling(page, 1.2, 3000);
  assert.ok(blank < 0.01, `pages ahead should be loaded before they scroll into view (${(blank * 100).toFixed(1)}% blank)`);
});

// A fast wheel is not a scrub: the pages it reaches should already be there.
test('a fast wheel scroll finds every page loaded', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'off', { at: 20 });
  await settled(page);
  const blank = await blankWhileScrolling(page, 10, 2000);
  assert.ok(blank < 0.02, `10 screens a second should stay within loaded pages (${(blank * 100).toFixed(1)}% blank)`);
});

// The strip rows holding a page: their page numbers, in order.
const keptPages = (page) => page.evaluate(() => [...document.querySelectorAll('#stripView .page-wrap')]
  .filter(row => row.querySelector('img').getAttribute('src')).map(row => Number(row.dataset.page)));

test('leaving scroll mode stops the strip loading and lets its pages go', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await page.evaluate(() => document.getElementById('modeSingle').click());
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.deepEqual(await keptPages(page), [], 'the hidden strip should hold no pages');
  await page.waitForFunction(() => document.getElementById('mainImg').naturalWidth > 0);
  await page.evaluate(() => document.getElementById('modeStrip').click());   // the mode is saved: the next tests read in the strip
  await page.waitForFunction(() => document.querySelector('#stripView img[src]')?.naturalWidth > 0);
});

// The last page here is taller than the screen: the scrubber's far end is its bottom. The indicator
// (its left edge is the top of the screen) runs into the last thumb, cropped there — the strip gets
// no empty space after the last page.
test('Shift-scrubbing to the strip\'s end reaches the bottom of the last page', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'off', { at: 170 });
  await page.evaluate(() => document.getElementById('thumbBtn').click());
  await new Promise(resolve => setTimeout(resolve, 800));
  const before = await page.$eval('#thumbStrip', strip => strip.scrollWidth);
  const y = await page.$eval('#thumbStrip', strip => strip.getBoundingClientRect().top + 30);
  await page.keyboard.down('Shift');
  await page.mouse.move(640, y);
  await page.mouse.down();
  await page.mouse.move(1279, y, { steps: 20 });
  await scrollSettled(page);
  const end = await page.evaluate(() => {
    const strip = document.getElementById('thumbStrip');
    const items = strip.querySelectorAll('.thumb-item');
    const last = items[items.length - 1].getBoundingClientRect();
    const view = document.getElementById('thumbViewport').getBoundingClientRect();
    return {
      bottom: Math.abs(scrollY - (document.documentElement.scrollHeight - innerHeight)) <= 1,
      intoLastThumb: view.left > last.left + 1,
      cropped: view.right <= last.right + 0.5,
      scrollWidth: strip.scrollWidth,
    };
  });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  assert.deepEqual({ ...end, scrollWidth: end.scrollWidth === before }, { bottom: true, intoLastThumb: true, cropped: true, scrollWidth: true });
});

test('scrolled to the end, the last page stops right at the bottom bar', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'height', { pinned: true });
  await shiftKey(page, 'D');
  await expectPage(page, PAGE_COUNT);
  await page.keyboard.press('End');
  await page.waitForFunction(() => Math.abs(scrollY - (document.documentElement.scrollHeight - innerHeight)) <= 1);
  const gap = await page.evaluate(n => {
    const last = document.querySelector(`#stripView [data-page="${n}"]`);
    return document.getElementById('scrubTrack').getBoundingClientRect().top - last.getBoundingClientRect().bottom;
  }, PAGE_COUNT);
  assert.ok(Math.abs(gap) < 1, `space between the last page and the bar: ${gap}px`);
});

// Every running spinner costs each frame's rendering, on screen or not: a series with thousands of
// missing pages ran one per page and dropped to a few frames a second. Only those near the screen spin.
test('only the missing pages near the screen show a spinner', { skip: !chromePath() }, async t => {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(() => localStorage.setItem('shiori:readerFitMode', JSON.stringify('height')));
  await page.goto(`${origin}/reader?g=${SPARSE_GALLERY}&page=300`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#stripView .page-wrap').length === 600);
  await until(page, () => {
    const shown = [...document.querySelectorAll('#stripView .page-wrap')].filter(row => {
      const r = row.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight;
    });
    const spinners = new Set(document.getAnimations().filter(a => a.animationName === 'spin').map(a => a.effect.target));
    return shown.length > 0 && shown.every(row => spinners.has(row));
  }, null, { what: 'a spinner on every missing page on screen' });
  const spinning = await page.evaluate(() => document.getAnimations().filter(a => a.animationName === 'spin').length);
  assert.ok(spinning <= 12, `${spinning} spinners running for 600 slots`);
});

// The resize handle and the go-to-top button ride on the strip's top edge: dragging it, they follow
// frame by frame instead of easing after it.
test('resizing the thumbnails, the handle and the go-to-top button keep up with the strip', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'height', { at: 40 });
  await page.evaluate(() => document.getElementById('thumbBtn').click());
  await page.waitForFunction(() => document.getElementById('scrollTopBtn').classList.contains('visible'));
  await new Promise(resolve => setTimeout(resolve, 800));   // the strip has finished opening
  const grip = await page.$eval('#thumbResizeHandle', el => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  let worst = 0;
  for (let dy = 12; dy <= 120; dy += 12) {
    await page.mouse.move(grip.x, grip.y - dy);
    worst = Math.max(worst, await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      const strip = document.getElementById('thumbStrip').getBoundingClientRect();
      const handle = document.getElementById('thumbResizeHandle').getBoundingClientRect();
      const button = document.getElementById('scrollTopBtn').getBoundingClientRect();
      resolve(Math.max(Math.abs((handle.top + handle.bottom) / 2 - strip.top), Math.abs(button.bottom + 20 - strip.top)));
    })))));
  }
  await page.mouse.up();
  assert.ok(worst <= 1, `the handle or the button trailed the strip's top edge by ${worst}px`);
});

// The address follows the page being read, replaced in place: a reload or a copied link lands on it,
// and none of it piles up in the history.
test('the address follows the page being read, without adding history', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'height', { at: 10 });
  const urlPage = () => page.evaluate(() => new URLSearchParams(location.search).get('page'));
  const counter = () => page.$eval('#pageCounter', el => el.textContent.split('/')[0].trim());
  const entries = await page.evaluate(() => history.length);
  await page.keyboard.press('ArrowRight');
  await until(page, () => new URLSearchParams(location.search).get('page') === '11', null, { what: '?page=11' });
  for (let i = 0; i < 30; i++) await page.evaluate(() => scrollBy(0, innerHeight * 2));   // a fast run
  await settle(400);
  assert.equal(await urlPage(), await counter(), 'the address lands on the page it settles on');
  assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get('g')), GALLERY);
  assert.equal(await page.evaluate(() => history.length), entries, 'no history entries');
  const at = await counter();
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#stripView img[src]')?.naturalWidth > 0);
  await until(page, n => document.getElementById('pageCounter').textContent.split('/')[0].trim() === n, at, { what: `page ${at} after a reload` });
});

const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

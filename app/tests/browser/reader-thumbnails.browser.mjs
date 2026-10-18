import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

// The thumbnails follow the reader lazily. Moving the strip yourself (a thumb clicked, the wheel over
// it) leaves it where you put it: as the reader moves, only the highlight moves. Once the reader
// carries the active page (the indicator, in the strip) to the strip's centre, the strip keeps it
// centred. A reader move that leaves the active thumb wholly out of view centres it at once.
const GALLERY = '1790000000401';
const PAGE_COUNT = 60;
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/library`, { waitUntil: 'load' });
  await page.evaluate(async ({ gid, count }) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'Thumbnails fixture' }, numPages: count });
    const canvas = new OffscreenCanvas(600, 850);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#789';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    for (let n = 1; n <= count; n++) await api.pages.put(gid, n, blob);
  }, { gid: GALLERY, count: PAGE_COUNT });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

async function reader(t, mode, at) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(mode => {
    localStorage.setItem('shiori:readerMode', JSON.stringify(mode));
    localStorage.setItem('shiori:readerFitMode', JSON.stringify('height'));
    localStorage.setItem('shiori:readerThumbsOpen', 'true');
    localStorage.setItem('shiori-reader-pin', '0');
  }, mode);
  await page.goto(`${origin}/reader?g=${GALLERY}&page=${at}`, { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.querySelectorAll('#stripView img[src], #mainImg')].some(img => img.naturalWidth > 0));
  await until(page, () => document.querySelectorAll('#thumbStrip .thumb-item').length > 0 && document.querySelector('#thumbStrip .thumb-item.active'), null, { what: 'the thumbnails' });
  await settle(600);
  return page;
}

const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

// The strip's scroll, the active page, and how far what the strip follows is from its centre: the
// active thumb, or in the strip the indicator (hidden outside a scrub, so read from its placement).
const strip = page => page.evaluate(() => {
  const el = document.getElementById('thumbStrip');
  const r = el.getBoundingClientRect();
  const active = el.querySelector('.thumb-item.active');
  const a = active.getBoundingClientRect();
  const centre = el.scrollLeft + el.clientWidth / 2;
  const followed = document.getElementById('stripView').classList.contains('active')
    ? parseFloat(document.getElementById('thumbViewport').style.left) + active.offsetWidth / 2
    : active.offsetLeft + active.offsetWidth / 2;
  return {
    left: Math.round(el.scrollLeft),
    page: Number(active.dataset.idx) + 1,
    offCentre: Math.round(followed - centre),
    visible: a.right > r.left && a.left < r.right,
    whole: a.left >= r.left && a.right <= r.right,
    // How much of the strip shows beyond the followed thumb on either side, and half a thumb plus a gap.
    room: {
      right: Math.round(el.scrollLeft + el.clientWidth - (followed + active.offsetWidth / 2)),
      left: Math.round(followed - active.offsetWidth / 2 - el.scrollLeft),
    },
    halfAhead: Math.round(active.offsetWidth / 2 + parseFloat(getComputedStyle(el).columnGap)),
  };
});

const thumbPoint = (page, n) => page.$eval(`#thumbStrip .thumb-item[data-idx="${n - 1}"]`, el => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});

async function step(page, key, times = 1) {
  for (let i = 0; i < times; i++) { await page.keyboard.press(key); await settle(250); }
  await settle(400);
}

test('page mode: after a thumb is clicked, the strip waits for the page to reach the centre before following', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'single', 30);
  const start = await strip(page);
  assert.equal(start.page, 30);
  assert.ok(Math.abs(start.offCentre) <= 2, `opened with page 30 centred, not ${start.offCentre}px off`);

  const p = await thumbPoint(page, 26);
  await page.mouse.click(p.x, p.y);
  await settle(500);
  assert.deepEqual(pick(await strip(page), 'left', 'page'), { left: start.left, page: 26 }, 'a click moves only the highlight');

  await step(page, 'ArrowRight');
  assert.deepEqual(pick(await strip(page), 'left', 'page'), { left: start.left, page: 27 }, 'no snap to the centre');
  await step(page, 'ArrowLeft', 2);
  assert.deepEqual(pick(await strip(page), 'left', 'page'), { left: start.left, page: 25 });

  await step(page, 'ArrowRight', 5);   // back on page 30, in the centre
  assert.deepEqual(pick(await strip(page), 'left', 'page'), { left: start.left, page: 30 });
  await step(page, 'ArrowRight', 2);   // from the centre on, it follows
  const following = await strip(page);
  assert.equal(following.page, 32);
  assert.ok(following.left > start.left && Math.abs(following.offCentre) <= 2, `page 32 kept centred (${following.offCentre}px off)`);
});

test('page mode: a move that leaves the active thumb out of view centres it at once', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'single', 30);
  const box = await page.$eval('#thumbStrip', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: 600 }); await settle(30); }
  await settle(600);
  const away = await strip(page);
  assert.equal(away.visible, false, 'wheeled the active thumb out of view');
  await page.mouse.move(640, 200);
  await page.keyboard.press('ArrowRight');
  await settle(100);
  const back = await strip(page);
  assert.equal(back.page, 31);
  assert.ok(Math.abs(back.offCentre) <= 2, `page 31 centred at once, not ${back.offCentre}px off`);
});

test('page mode: at the strip\'s start the strip stays put until the page reaches the centre', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'single', 1);
  const start = await strip(page);
  assert.equal(start.left, 0);
  await step(page, 'ArrowRight', 3);
  assert.deepEqual(pick(await strip(page), 'left', 'page'), { left: 0, page: 4 });
});

test('strip mode: after a thumb is clicked, reading on moves the indicator, and the strip follows from the centre', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'strip', 30);
  const start = await strip(page);
  assert.ok(Math.abs(start.offCentre) <= 2, `opened with the indicator centred, not ${start.offCentre}px off`);

  const p = await thumbPoint(page, 27);
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction(() => !document.documentElement.classList.contains('reader-strip-gliding'));
  await settle(300);
  assert.deepEqual(pick(await strip(page), 'left', 'page'), { left: start.left, page: 27 }, 'the click glides the pages, not the strip');

  await step(page, 'ArrowRight');
  await page.waitForFunction(() => !document.documentElement.classList.contains('reader-strip-gliding'));
  assert.deepEqual(pick(await strip(page), 'left', 'page'), { left: start.left, page: 28 }, 'a page step doesn\'t snap the strip to the centre');

  // Read on down a screen at a time: the strip holds still until the indicator reaches its centre,
  // then keeps it there.
  const trail = [];
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => scrollBy(0, innerHeight / 2));
    await settle(80);
    trail.push(await strip(page));
  }
  const reached = trail.findIndex(s => s.left !== start.left);
  assert.ok(trail[0].offCentre < 0 && reached > 1, `the strip held still at first: ${trail.map(s => s.left)}`);
  assert.ok(trail.slice(0, reached).every(s => s.offCentre <= 0), `while the indicator came up to the centre: ${trail.map(s => s.offCentre)}`);
  assert.ok(trail.slice(reached).every(s => Math.abs(s.offCentre) <= 2), `then kept it centred: ${trail.map(s => s.offCentre)}`);
});

test('strip mode: a scroll that leaves the active thumb out of view centres it at once', { skip: !chromePath() }, async t => {
  const page = await reader(t, 'strip', 30);
  const box = await page.$eval('#thumbStrip', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: -600 }); await settle(30); }
  await settle(600);
  assert.equal((await strip(page)).visible, false, 'wheeled the active thumb out of view');
  await page.evaluate(() => scrollBy(0, 20));
  await settle(100);
  const back = await strip(page);
  assert.ok(back.visible && Math.abs(back.offCentre) <= 2, `the indicator centred at once, not ${back.offCentre}px off`);
});

// A click picks the page: the pages getting there carry the active page across the centre, but it's
// the click that moved it, so the strip doesn't start following.
for (const mode of ['single', 'strip']) {
  test(`${mode} mode: clicking a thumb left of the centre, then one right of it, leaves the strip where it is`, { skip: !chromePath() }, async t => {
    const page = await reader(t, mode, 30);
    const start = await strip(page);
    for (const n of [26, 34]) {
      const p = await thumbPoint(page, n);
      await page.mouse.click(p.x, p.y);
      await page.waitForFunction(() => !document.documentElement.classList.contains('reader-strip-gliding'));
      await settle(400);
      assert.deepEqual(pick(await strip(page), 'left', 'page'), { left: start.left, page: n });
    }
  });
}

// Off to one side and carried further out, the highlight pushes the strip ahead of it, half of the
// next thumb showing beyond it: it never leaves the strip, and the strip doesn't jump to centre it
// either. In the strip the push goes along with the pages, keeping that room the whole way.
for (const [mode, dir] of [['single', 1], ['single', -1], ['strip', 1], ['strip', -1]]) {
  test(`${mode} mode: carried ${dir > 0 ? 'right' : 'left'} past the strip's edge, the highlight pushes the strip along`, { skip: !chromePath() }, async t => {
    const page = await reader(t, mode, 30);
    const start = await strip(page);
    const p = await thumbPoint(page, 30 + dir * 6);
    await page.mouse.click(p.x, p.y);
    await page.waitForFunction(() => !document.documentElement.classList.contains('reader-strip-gliding'));
    await settle(400);
    const trail = [];
    for (let i = 0; i < 16; i++) {
      if (mode === 'strip') await page.evaluate(d => scrollBy(0, d * innerHeight / 2), dir);
      else await page.keyboard.press(dir > 0 ? 'ArrowRight' : 'ArrowLeft');
      await settle(mode === 'strip' ? 90 : 220);
      trail.push(await strip(page));
    }
    await settle(500);
    const end = await strip(page);
    assert.ok(trail.every(s => s.visible), `the highlight stayed on the strip: ${trail.map(s => s.visible)}`);
    assert.ok(end.whole, 'and ends wholly in view');
    assert.ok((end.left - start.left) * dir > 0, `the strip was pushed along (${start.left} → ${end.left})`);
    assert.ok(Math.abs(end.offCentre) > 100, `pushed, not centred (${end.offCentre}px off centre)`);
    const side = dir > 0 ? 'right' : 'left';
    assert.ok(Math.abs(end.room[side] - end.halfAhead) <= 2, `half the next thumb shows ahead: ${end.room[side]}px of ${end.halfAhead}px`);
    if (mode === 'strip') {
      const pushing = trail.filter(s => s.left !== start.left).map(s => s.room[side]);
      assert.ok(pushing.length > 4 && pushing.every(r => Math.abs(r - end.halfAhead) <= 2), `the push kept pace with the pages: ${pushing}`);
    }
  });
}

// A held key flips pages as fast as it repeats: page flips are instant, and so is the strip — it
// keeps up with the page it follows, centred or pushed, and never more than a thumb behind.
for (const from of [30, 36]) {
  test(`page mode: holding a page key, the strip keeps up (${from === 30 ? 'centred' : 'pushing'})`, { skip: !chromePath() }, async t => {
    const page = await reader(t, 'single', 30);
    if (from !== 30) {
      const p = await thumbPoint(page, from);
      await page.mouse.click(p.x, p.y);
      await settle(400);
      await page.mouse.move(640, 200);
    }
    const thumb = await page.$eval('#thumbStrip .thumb-item', el => el.offsetWidth + parseFloat(getComputedStyle(el.parentElement).columnGap));
    let worst = 0;
    for (let i = 0; i < 18; i++) {
      await page.keyboard.down('ArrowRight');   // repeats while held
      await settle(33);
      const s = await strip(page);
      assert.ok(s.visible, `page ${s.page} went out of view`);
      worst = Math.max(worst, from === 30 ? Math.abs(s.offCentre) : s.halfAhead - s.room.right);
    }
    await page.keyboard.up('ArrowRight');
    assert.ok(worst <= thumb + 1, `the strip fell ${worst}px behind (a thumb is ${thumb}px)`);
    await settle(600);
    const end = await strip(page);
    if (from === 30) assert.ok(Math.abs(end.offCentre) <= 2, `settled ${end.offCentre}px off centre`);
    else assert.ok(Math.abs(end.room.right - end.halfAhead) <= 2, `settled with ${end.room.right}px ahead`);
  });
}

const pick = (o, ...keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

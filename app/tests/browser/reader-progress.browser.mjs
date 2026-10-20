import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until, scrollSettled } from './harness.mjs';

// The reader's page progress bar: opaque segments that grow when pointed at, a page-number pill, a
// band for what the screen shows, scrubbing along it, and dragging out of it into the thumbnails.
const GALLERY = '1790000000301';
const HEAVY_GALLERY = '1790000000302';
const HEAVY_COUNT = 120;
const PAGE_COUNT = 40;
const SERIES = ['1790000000311', '1790000000312', '1790000000313'];   // three chapters of 20 pages
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/library`, { waitUntil: 'load' });
  await page.evaluate(async ({ gid, count }) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'Progress fixture' }, numPages: count });
    const blobs = await Promise.all(['#789', '#987'].map(async color => {
      const canvas = new OffscreenCanvas(600, 850);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.convertToBlob({ type: 'image/png' });
    }));
    for (let n = 1; n <= count; n++) await api.pages.put(gid, n, blobs[n % 2]);
  }, { gid: GALLERY, count: PAGE_COUNT });
  // Full-size, busy pages of slightly different shapes: each takes a while to load, and rows reshape
  // as their pages arrive.
  await page.evaluate(async ({ gid, count }) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'Heavy progress fixture' }, numPages: count });
    const blobs = await Promise.all([0, 1, 2, 3].map(async k => {
      const canvas = new OffscreenCanvas(1280, 1795 + k * 4);
      const ctx = canvas.getContext('2d');
      for (let i = 0; i < 1000; i++) {
        ctx.fillStyle = `hsl(${(i * 37 + k * 90) % 360} 60% 50%)`;
        ctx.fillRect((i * 97) % 1280, (i * 211) % 1795, 30 + i % 50, 30 + i % 40);
      }
      return canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    }));
    for (let n = 1; n <= count; n++) await api.pages.put(gid, n, blobs[n % 4]);
  }, { gid: HEAVY_GALLERY, count: HEAVY_COUNT });
  await page.evaluate(async (ids) => {
    const api = await import('/app/js/api.js');
    const title = english => ({ english, japanese: '', pretty: '' });
    const canvas = new OffscreenCanvas(600, 900);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#879';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    for (const [k, gid] of ids.entries()) {
      await api.meta.put({ galleryId: gid, title: title(`Chapter ${k + 1}`), tags: [], numPages: 20 });
      for (let n = 1; n <= 20; n++) await api.pages.put(gid, n, blob);
    }
    await api.series.write(ids[0], ids.map((id, k) => ({ id, title: `Ch ${k + 1}`, number: k + 1 })), { seriesTitle: title('Series fixture'), seriesTags: [] });
  }, SERIES);
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

async function reader(t, { at = 1, mode = 'strip', fit = 'height', gallery = GALLERY, count = PAGE_COUNT, position = 'bottom', flow = 'chapter', pinned = false } = {}) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument((mode, fit, position, flow, pinned) => {
    localStorage.setItem('shiori:readerMode', JSON.stringify(mode));
    localStorage.setItem('shiori:readerFitMode', JSON.stringify(fit));
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
    localStorage.setItem('shiori:readerProgressPosition', JSON.stringify(position));
    localStorage.setItem('shiori:readerStripMode', JSON.stringify(flow));
    localStorage.setItem('shiori-reader-pin', pinned ? '1' : '0');
    localStorage.setItem('shiori:readerDebugLoaded', 'false');
  }, mode, fit, position, flow, pinned);
  await page.goto(`${origin}/reader?g=${gallery}&page=${at}`, { waitUntil: 'load' });
  await page.waitForFunction(n => document.querySelectorAll('.scrub-segment').length === n, {}, count);
  await page.waitForFunction(() => [...document.querySelectorAll('#stripView img[src], #mainImg, .dImg')].some(img => img.naturalWidth > 0));
  return page;
}

// The middle of page n's segment, in viewport pixels.
function segmentPoint(page, n) {
  return page.$eval(`.scrub-segment:nth-child(${n})`, seg => {
    const r = seg.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: innerHeight - 2 };
  });
}

// Whether the page-number pill is centred over the segment pointed at.
const pillOverTip = page => page.evaluate(() => {
  const seg = document.querySelector('.scrub-segment.tip')?.getBoundingClientRect();
  const pill = document.getElementById('scrubTip').getBoundingClientRect();
  return !!seg && Math.abs((pill.left + pill.right) / 2 - (seg.left + seg.right) / 2) < 1;
});

// A height for the pointer that has pulled the thumbnails all the way out of the bar (and a bit).
const pulledOutY = page => page.evaluate(() => document.getElementById('bottombar').getBoundingClientRect().top
  - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb-h')) - 10);

const counterPage = page => page.$eval('#pageCounter', el => Number(el.textContent.split('/')[0].trim()));
const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

test('the bar is opaque, with no slider control', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 12 });
  await page.waitForSelector('.scrub-view');
  const colors = await page.evaluate(() => [...document.querySelectorAll('.scrub-segment, .scrub-view')].flatMap(el => {
    const cs = getComputedStyle(el);
    return [cs.backgroundColor, el.matches('.scrub-segment:not(:last-child)') ? cs.borderRightColor : null].filter(Boolean);
  }));
  const translucent = colors.filter(c => /rgba\([^)]*,\s*0?\.\d+\)|\/\s*0?\.\d/.test(c) || c === 'transparent');
  assert.deepEqual(translucent, [], 'segments, the gaps between them and the band must not let anything show through');
  const [active, band] = await page.evaluate(() => ['.scrub-segment.active', '.scrub-view'].map(sel => getComputedStyle(document.querySelector(sel)).backgroundColor));
  assert.notEqual(band, active, 'what the screen shows is a tone of its own');
  assert.equal(await page.$('#bottombar input'), null);
  const states = await page.evaluate(() => ({
    visited: document.querySelectorAll('.scrub-segment.visited').length,
    active: [...document.querySelectorAll('.scrub-segment.active')].map(s => s.dataset.n),
  }));
  assert.deepEqual(states, { visited: 11, active: ['12'] });
});

test('pointing at the bar grows it and shows the page number', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  const rest = await page.$eval('#scrubTrack', el => el.getBoundingClientRect().height);
  const { x, y } = await segmentPoint(page, 23);
  await page.mouse.move(x, y - 8);   // in the zone, above the resting line
  await settle();
  const hovered = await page.evaluate(() => {
    const tip = document.querySelector('.scrub-segment.tip');
    const pill = document.getElementById('scrubTip');
    return {
      track: document.getElementById('scrubTrack').getBoundingClientRect().height,
      tip: tip?.dataset.n, opacity: getComputedStyle(pill).opacity, content: pill.textContent,
    };
  });
  const zone = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-zone')));
  assert.ok(Math.abs(hovered.track - zone) < 0.5 && zone > rest, `the bar should grow from ${rest}px to ${zone}px, got ${hovered.track}px`);
  assert.deepEqual({ tip: hovered.tip, opacity: hovered.opacity, content: hovered.content }, { tip: '23', opacity: '1', content: '23' });
  assert.equal(await pillOverTip(page), true);
  await page.mouse.move(640, 300);
  await settle();
  assert.equal(await page.$eval('#scrubTrack', el => el.getBoundingClientRect().height), rest);
  assert.equal(await page.$('.scrub-segment.tip'), null);
  assert.equal(await page.$eval('#scrubTip', el => getComputedStyle(el).opacity), '0');
});

// How far the pill is from the page pointed at, in pages, two frames on (the glide has had a frame).
const pillLag = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
  const seg = document.querySelector('.scrub-segment.tip').getBoundingClientRect();
  const pill = document.getElementById('scrubTip').getBoundingClientRect();
  resolve(Math.abs((pill.left + pill.right) / 2 - (seg.left + seg.right) / 2) / seg.width);
}))));

test('the page number slides along the bar from page to page instead of popping up again', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  const a = await segmentPoint(page, 20), b = await segmentPoint(page, 21);
  await page.mouse.move(a.x, a.y - 8);
  await settle();
  const risen = await page.$eval('#scrubTip', el => el.getBoundingClientRect().bottom);
  await page.mouse.move(b.x, b.y - 8);
  const lag = await pillLag(page);
  const moving = await page.$eval('#scrubTip', el => ({
    content: el.textContent, opacity: getComputedStyle(el).opacity, bottom: el.getBoundingClientRect().bottom,
  }));
  assert.deepEqual(moving, { content: '21', opacity: '1', bottom: risen });
  assert.ok(lag > 0.05 && lag < 1, `the pill should be on its way from page 20 to 21, ${lag} pages short`);
  await settle();
  assert.equal(await pillOverTip(page), true);
});

test('sweeping fast along the bar, the page number never falls more than a page behind', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  const { y } = await segmentPoint(page, 1);
  await page.mouse.move((await segmentPoint(page, 2)).x, y - 8);
  await settle();
  let worst = 0;
  for (let n = 8; n <= PAGE_COUNT; n += 6) {
    await page.mouse.move((await segmentPoint(page, n)).x, y - 8);
    worst = Math.max(worst, await pillLag(page));
  }
  assert.ok(worst <= 1.01, `the pill fell ${worst.toFixed(2)} pages behind`);
});

// The side bars run the window's full height, over the header when it shows.
for (const position of ['left', 'right']) {
  test(`the ${position} bar runs the full height of the window, over the header`, { skip: !chromePath() }, async t => {
    const page = await reader(t, { position, pinned: true });
    const bar = await page.evaluate(() => {
      const r = document.getElementById('scrubSegments').getBoundingClientRect();
      const header = document.getElementById('topbar').getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round((r.left + r.right) / 2), Math.round(header.bottom / 2));
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: innerHeight, headerShown: header.bottom > 0,
        overHeader: !!hit?.closest('#bottombar') };
    });
    assert.deepEqual(bar, { top: 0, bottom: bar.height, height: bar.height, headerShown: true, overHeader: true });
  });
}

// A double spread shows two pages at once: the band over them keeps the gap between them.
test('in double page mode the band over the spread keeps a line between its two pages', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'double', at: 10 });
  await until(page, () => document.querySelectorAll('.scrub-view:not([style*="none"])').length === 2, null, { what: 'two bands' });
  const seam = await page.evaluate(() => {
    const [a, b] = [...document.querySelectorAll('.scrub-view')].map(el => el.getBoundingClientRect());
    const line = getComputedStyle(document.querySelectorAll('.scrub-view')[1]);
    return { touching: Math.abs(a.right - b.left) < 0.5, line: line.borderLeftWidth,
      ground: line.borderLeftColor === getComputedStyle(document.body).backgroundColor };
  });
  assert.deepEqual(seam, { touching: true, line: '1px', ground: true });
});

// A page of a pixel or so: a gap after each would leave nothing of the pages but gaps.
test('a side bar too short for its pages drops the gaps between them', { skip: !chromePath() }, async t => {
  const page = await reader(t, { position: 'left' });
  await page.setViewport({ width: 1280, height: 180 });   // under 5px a page
  await page.waitForFunction(() => document.getElementById('bottombar').classList.contains('dense'));
  const gaps = await page.$$eval('.scrub-segment', segs => segs.filter(seg => {
    const cs = getComputedStyle(seg);
    return cs.borderBottomWidth !== '0px' || cs.borderRightWidth !== '0px';
  }).length);
  assert.equal(gaps, 0);
});

for (const mode of ['strip', 'single']) {
  test(`pressing and dragging along the bar goes to the page under the pointer (${mode})`, { skip: !chromePath() }, async t => {
    const page = await reader(t, { mode });
    const a = await segmentPoint(page, 15);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await until(page, () => Number(document.getElementById('pageCounter').textContent.split('/')[0]) === 15, null, { what: 'page 15' });
    const b = await segmentPoint(page, 31);
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await until(page, () => Number(document.getElementById('pageCounter').textContent.split('/')[0]) === 31, null, { what: 'page 31' });
    if (mode === 'strip') {
      await page.waitForFunction(() => !document.documentElement.classList.contains('reader-strip-gliding'));
      const top = await page.$eval('#stripView [data-page="31"]', row => row.getBoundingClientRect().top);
      assert.ok(Math.abs(top) <= 1, `page 31 should start on the reading line, not ${top}px from it`);
    }
  });
}

test('pulled all the way out of the bar, the thumbnails scrub and then stay open as if toggled', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  const a = await segmentPoint(page, 10);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const out = await pulledOutY(page);
  await page.mouse.move(a.x, out, { steps: 10 });
  const opened = await page.evaluate(() => ({
    open: document.getElementById('thumbStrip').classList.contains('open'),
    scrubbing: document.getElementById('thumbStrip').classList.contains('scrubbing'),
    grown: document.getElementById('bottombar').classList.contains('grown'),
    handle: getComputedStyle(document.getElementById('thumbResizeHandle')).display,
  }));
  assert.deepEqual(opened, { open: true, scrubbing: true, grown: false, handle: 'none' }, 'nothing is kept until let go');
  const b = await segmentPoint(page, 30);
  await page.mouse.move(b.x, out, { steps: 10 });
  assert.equal(await counterPage(page), 30);
  const indicator = await page.evaluate(() => {
    const strip = document.getElementById('thumbStrip').getBoundingClientRect();
    const item = document.querySelector('#thumbStrip .thumb-item:nth-of-type(31)').getBoundingClientRect();
    const view = document.getElementById('thumbViewport').getBoundingClientRect();
    return { onThumb: Math.abs(view.left - item.left) < 4, inStrip: view.left >= strip.left && view.right <= strip.right };
  });
  assert.deepEqual(indicator, { onThumb: true, inStrip: true });
  await page.mouse.up();
  await settle();
  const after = await page.evaluate(() => ({
    open: document.getElementById('thumbStrip').classList.contains('open'),
    scrubbing: document.getElementById('thumbStrip').classList.contains('scrubbing'),
    toggle: document.getElementById('thumbBtn').classList.contains('active'),
    saved: localStorage.getItem('shiori:readerThumbsOpen'),
    full: Math.abs(document.getElementById('thumbStrip').getBoundingClientRect().height
      - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb-h'))) < 1,
    handle: getComputedStyle(document.getElementById('thumbResizeHandle')).display,
  }));
  assert.deepEqual(after, { open: true, scrubbing: false, toggle: true, saved: 'true', full: true, handle: 'block' });
  assert.equal(await counterPage(page), 30);
});

// All the way out but still held, nothing is kept yet: the strip goes back in as the drag comes back,
// and let go short of all the way, it goes back in altogether.
test('pulled all the way out and brought back while held, the thumbnails follow the drag back in', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 12 });
  const a = await segmentPoint(page, 12);
  const zoneTop = await page.$eval('#bottombar', el => el.getBoundingClientRect().top);
  const full = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--thumb-h')));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (const past of [full + 40, full, full - 30, 20]) {
    await page.mouse.move(a.x, zoneTop - past, { steps: 3 });
    const pulled = await pulledStrip(page);
    const expect = Math.min(full, past);
    assert.ok(Math.abs(pulled.height - expect) < 1, `${past}px past the bar the strip should be ${expect}px tall, not ${pulled.height}px`);
    assert.equal(pulled.handle, 'none');
  }
  await page.mouse.up();
  await settle();
  const after = await page.evaluate(() => ({
    open: document.getElementById('thumbStrip').classList.contains('open'),
    height: document.getElementById('thumbStrip').getBoundingClientRect().height,
    saved: localStorage.getItem('shiori:readerThumbsOpen'),
  }));
  assert.deepEqual(after, { open: false, height: 0, saved: 'false' });
});

// The strip's state while pulled out: its height, and the go-to-top button's distance from its top edge.
const pulledStrip = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
  const strip = document.getElementById('thumbStrip').getBoundingClientRect();
  const button = document.getElementById('scrollTopBtn').getBoundingClientRect();
  resolve({ height: strip.height, buttonGap: button.bottom + 56 - strip.top,
    handle: getComputedStyle(document.getElementById('thumbResizeHandle')).display });
})));

test('pulled part of the way out of the bar, the thumbnails come out as far as the drag and go back in when let go', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 12 });
  const a = await segmentPoint(page, 12);
  const zoneTop = await page.$eval('#bottombar', el => el.getBoundingClientRect().top);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (const past of [10, 30, 60, 30]) {
    await page.mouse.move(a.x, zoneTop - past, { steps: 3 });
    const pulled = await pulledStrip(page);
    assert.ok(Math.abs(pulled.height - past) < 1, `${past}px past the bar the strip should be ${past}px tall, not ${pulled.height}px`);
    assert.ok(Math.abs(pulled.buttonGap) < 1, `the go-to-top button should ride on the strip, ${pulled.buttonGap}px off`);
    assert.equal(pulled.handle, 'none');
  }
  await page.mouse.up();
  await settle();
  const after = await page.evaluate(() => ({
    open: document.getElementById('thumbStrip').classList.contains('open'),
    height: document.getElementById('thumbStrip').getBoundingClientRect().height,
    saved: localStorage.getItem('shiori:readerThumbsOpen'),
  }));
  assert.deepEqual(after, { open: false, height: 0, saved: 'false' });
});

test('brought back to the bar before they are all out, the thumbnails go back in and the bar picks the page again', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  const a = await segmentPoint(page, 10), b = await segmentPoint(page, 20);
  const zoneTop = await page.$eval('#bottombar', el => el.getBoundingClientRect().top);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, zoneTop - 40, { steps: 4 });
  assert.equal(await page.$eval('#thumbStrip', el => el.classList.contains('scrubbing')), true);
  await page.mouse.move(b.x, b.y, { steps: 4 });
  const back = await page.evaluate(() => ({
    open: document.getElementById('thumbStrip').classList.contains('open'),
    scrubbing: document.getElementById('thumbStrip').classList.contains('scrubbing'),
    grown: document.getElementById('bottombar').classList.contains('grown'),
  }));
  assert.deepEqual(back, { open: false, scrubbing: false, grown: true });
  await until(page, () => Number(document.getElementById('pageCounter').textContent.split('/')[0]) === 20, null, { what: 'page 20' });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori:readerThumbsOpen')), 'false');
});

// A wheel turned mid-scrub scrolls the pages, and the scrub picks up from there: the next small move
// carries on from where the wheel left the page instead of snatching it back, and both ends stay
// within reach.
test('a wheel turned while scrubbing out of the bar moves the page, and the scrub carries on from there', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 10 });
  const a = await segmentPoint(page, 10);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y - 140, { steps: 10 });
  await settle(300);
  const before = await counterPage(page);
  await page.mouse.move(a.x, 300, { steps: 3 });
  for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: 400 }); await settle(40); }
  await settle(400);
  const wheeled = await counterPage(page);
  assert.ok(wheeled > before + 1, `the wheel should scroll the pages mid-scrub (${before} → ${wheeled})`);
  await page.mouse.move(a.x + 6, 300, { steps: 2 });
  await settle(200);
  const carried = await counterPage(page);
  assert.ok(Math.abs(carried - wheeled) <= 1, `a small move should carry on from page ${wheeled}, not jump to ${carried}`);
  await page.mouse.move(0, 300, { steps: 15 });
  assert.equal(await counterPage(page), 1);
  await page.mouse.move(1279, 300, { steps: 30 });
  assert.equal(await counterPage(page), PAGE_COUNT);
  await page.mouse.up();
});

test('a wheel turned while Shift-scrubbing the thumbnails moves the page, and the scrub carries on', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 10 });
  await page.evaluate(() => document.getElementById('thumbBtn').click());
  await settle(800);
  const y = await page.$eval('#thumbStrip', strip => strip.getBoundingClientRect().top + 30);
  await page.keyboard.down('Shift');
  await page.mouse.move(300, y);
  await page.mouse.down();
  await page.mouse.move(320, y, { steps: 4 });
  const before = await counterPage(page);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: 400 }); await settle(40); }
  await settle(400);
  const wheeled = await counterPage(page);
  assert.ok(wheeled > before + 1, `the wheel should scroll the pages mid-scrub (${before} → ${wheeled})`);
  await page.mouse.move(326, y, { steps: 2 });
  await settle(200);
  const carried = await counterPage(page);
  assert.ok(Math.abs(carried - wheeled) <= 1, `a small move should carry on from page ${wheeled}, not jump to ${carried}`);
  await page.mouse.move(0, y, { steps: 15 });
  assert.equal(await counterPage(page), 1);
  await page.mouse.up();
  await page.keyboard.up('Shift');
});

// Jumping back and forth between far pages releases some rows while their pages are still loading
// (a frame after they start, at times). None of those loads may be left hanging: four of them would
// stop every later page from loading. Without the guard this fails by the third round.
test('jumping back and forth between far pages on the bar keeps every page loading', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 28, gallery: HEAVY_GALLERY, count: HEAVY_COUNT });
  const near = await segmentPoint(page, 5), far = await segmentPoint(page, 80);
  const shownLoaded = () => {
    const rows = [...document.querySelectorAll('#stripView .page-wrap')].filter(row => {
      const r = row.getBoundingClientRect();
      return r.bottom > 0 && r.top < innerHeight;
    });
    return rows.length > 0 && rows.every(row => row.querySelector('img')?.naturalWidth > 0);
  };
  const gaps = [55, 262, 3, 141, 380, 27, 198, 9, 315, 84, 240, 1, 120, 349, 66, 17, 287, 173];
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 6; i++) {
      const p = i % 2 ? far : near;
      await page.mouse.click(p.x, p.y);
      await settle(gaps[(round * 6 + i) % gaps.length]);
    }
    await settle(1200);
    assert.ok(await page.evaluate(shownLoaded), `the pages on screen should have loaded after round ${round + 1}`);
  }
});

// In a series read as one strip, the bar shows the chapter the reader is in while the strip (and its
// thumbnails) go on into its neighbours. Scrubbing out of the bar stays within that chapter: its first
// page's top on the reading line at one end, its last page's bottom on the bar at the other — even
// with the pointer pushed off the window, where the next chapter used to take over.
test("scrubbing out of the bar in a middle chapter stops at that chapter's first and last page", { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 10, gallery: SERIES[1], count: 20, flow: 'series' });
  const a = await segmentPoint(page, 10);
  const out = await pulledOutY(page);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, out, { steps: 10 });
  const edges = () => page.evaluate(() => {
    const first = document.querySelector('#stripView .page-wrap[data-page="21"]').getBoundingClientRect();
    const last = document.querySelector('#stripView .page-wrap[data-page="40"]').getBoundingClientRect();
    return {
      page: Number(document.getElementById('pageCounter').textContent.split('/')[0]),
      firstTop: Math.round(first.top),
      lastToBar: Math.round(document.getElementById('scrubTrack').getBoundingClientRect().top - last.bottom),
    };
  });
  await page.mouse.move(0, out, { steps: 15 });
  await scrollSettled(page);
  assert.deepEqual(pick(await edges(), 'page', 'firstTop'), { page: 1, firstTop: 0 });
  await page.mouse.move(1279, out, { steps: 20 });
  await scrollSettled(page);
  assert.deepEqual(pick(await edges(), 'page', 'lastToBar'), { page: 20, lastToBar: 0 });
  await page.mouse.move(1400, out, { steps: 4 });   // off the window's side, still pulled out
  await settle(300);
  assert.deepEqual(pick(await edges(), 'page', 'lastToBar'), { page: 20, lastToBar: 0 });
  await page.mouse.up();
});
const pick = (o, ...keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

// A scrub over tall pages moves them many pixels per pointer pixel: the page eases along between the
// pointer's steps instead of jumping a whole step in one frame, and still keeps up with a fast sweep.
for (const via of ['Shift', 'bar']) {
  test(`scrubbing (${via}) eases the page along between pointer steps, and keeps up with a fast sweep`, { skip: !chromePath() }, async t => {
    const page = await reader(t, { at: 10 });
    let y, x = 400;
    if (via === 'Shift') {
      await page.evaluate(() => document.getElementById('thumbBtn').click());
      await settle(800);
      y = await page.$eval('#thumbStrip', strip => strip.getBoundingClientRect().top + 30);
      await page.keyboard.down('Shift');
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 6, y, { steps: 2 });
      x += 6;
    } else {
      const a = await segmentPoint(page, 10);
      x = a.x;
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      y = await pulledOutY(page);
      await page.mouse.move(a.x, y, { steps: 6 });
    }
    await scrollSettled(page);
    // Record the page every frame while taking one coarse pointer step.
    const recording = page.evaluate(() => new Promise(resolve => {
      const ys = [scrollY], t0 = performance.now();
      const tick = () => { ys.push(scrollY); if (performance.now() - t0 < 450) requestAnimationFrame(tick); else resolve(ys); };
      requestAnimationFrame(tick);
    }));
    await page.mouse.move(x + 50, y);   // one coarse pointer step
    const ys = await recording;
    const steps = ys.slice(1).map((v, i) => Math.abs(v - ys[i]));
    const total = Math.abs(ys.at(-1) - ys[0]);
    assert.ok(total > 300, `the step should move the page well along, moved ${total}px`);
    assert.ok(Math.max(...steps) < total * 0.6 && steps.filter(s => s > 0.5).length >= 3,
      `the page should ease over several frames, not jump: ${steps.filter(s => s > 0.5).map(Math.round)}`);
    await page.mouse.move(x + 650, y, { steps: 25 });   // a fast sweep
    // It keeps up: once the pointer stops, the page lands within a moment.
    const caughtUp = await page.evaluate(() => new Promise(resolve => {
      const t0 = performance.now();
      let last = scrollY, still = 0;
      const tick = () => {
        if (scrollY === last) still++; else { still = 0; last = scrollY; }
        if (still >= 3) resolve(performance.now() - t0); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    assert.ok(caughtUp < 300, `the page took ${Math.round(caughtUp)}ms to land after the sweep`);
    await page.mouse.up();
    if (via === 'Shift') await page.keyboard.up('Shift');
  });
}

// Dragged slowly, a pixel at a time, the page moves at a steady pace — not a pixel's worth at a time,
// settling in between.
for (const via of ['Shift', 'bar']) {
  test(`scrubbing (${via}) a pixel at a time moves the page steadily, not in steps`, { skip: !chromePath() }, async t => {
    const page = await reader(t, { at: 10 });
    let y, x = 400;
    if (via === 'Shift') {
      await page.evaluate(() => document.getElementById('thumbBtn').click());
      await settle(800);
      y = await page.$eval('#thumbStrip', strip => strip.getBoundingClientRect().top + 30);
      await page.keyboard.down('Shift');
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 6, y, { steps: 2 });
      x += 6;
    } else {
      const a = await segmentPoint(page, 10);
      x = a.x;
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      y = await pulledOutY(page);
      await page.mouse.move(a.x, y, { steps: 6 });
    }
    await scrollSettled(page);
    const recording = page.evaluate(() => new Promise(resolve => {
      const ys = [], t0 = performance.now();
      const tick = now => { ys.push([now - t0, scrollY]); if (now - t0 < 1800) requestAnimationFrame(tick); else resolve(ys); };
      requestAnimationFrame(tick);
    }));
    for (let i = 1; i <= 16; i++) { await page.mouse.move(x + i, y); await settle(100); }
    const ys = await recording;
    const steady = ys.filter(([at]) => at > 350 && at < 1450);   // past the first pixels, before the last
    const moves = steady.slice(1).map(([, v], i) => Math.abs(v - steady[i][1]));
    const mean = moves.reduce((a, b) => a + b, 0) / moves.length;
    const spread = Math.sqrt(moves.reduce((a, b) => a + (b - mean) ** 2, 0) / moves.length) / mean;
    assert.ok(mean > 0.5, `the drag should move the page (${mean.toFixed(2)}px a frame)`);
    // Whole-pixel scrolling alone spreads a steady 1.5px a frame by about 0.35; a pixel's worth in one
    // frame and nothing in between spreads it by over 4.
    assert.ok(spread < 1, `the page should move steadily, not in steps: ${moves.map(Math.round).join(',')}`);
    await page.mouse.up();
    if (via === 'Shift') await page.keyboard.up('Shift');
  });
}

// Read on into the next chapter, the address names that chapter and the page within it.
test('in a series read as one strip, the address follows the reader into the next chapter', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 18, gallery: SERIES[1], count: 20, flow: 'series' });
  await page.evaluate(() => {
    const row = document.querySelector('#stripView .page-wrap[data-page="43"]');   // chapter 3, page 3
    scrollTo(0, scrollY + row.getBoundingClientRect().top);
  });
  await until(page, ids => {
    const q = new URLSearchParams(location.search);
    return q.get('g') === ids[2] && q.get('page') === '3';
  }, SERIES, { what: 'the address on chapter 3, page 3' });
});

test('the band covers exactly what the screen shows', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 20 });
  await page.waitForFunction(() => !document.documentElement.classList.contains('reader-strip-gliding'));
  await page.evaluate(() => scrollBy(0, Math.round(innerHeight / 2)));
  await settle();
  const shown = await page.evaluate(count => {
    const rows = [...document.querySelectorAll('#stripView .page-wrap')];
    const at = y => {   // fractional page index at viewport y
      const i = rows.findIndex(r => r.getBoundingClientRect().bottom > y);
      const r = rows[i].getBoundingClientRect();
      return i + Math.max(0, Math.min(1, (y - r.top) / r.height));
    };
    const band = document.querySelector('.scrub-view').getBoundingClientRect();
    const bar = document.getElementById('scrubSegments').getBoundingClientRect();
    return {
      from: (band.left - bar.left) / bar.width * count, to: (band.right - bar.left) / bar.width * count,
      expectFrom: at(0), expectTo: at(innerHeight),
    };
  }, PAGE_COUNT);
  assert.ok(Math.abs(shown.from - shown.expectFrom) < 0.02, `band starts at ${shown.from}, the screen at ${shown.expectFrom}`);
  assert.ok(Math.abs(shown.to - shown.expectTo) < 0.02, `band ends at ${shown.to}, the screen at ${shown.expectTo}`);
});

test('scrubbing out at either edge of the screen shows the first or last thumbnail whole', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 20 });
  const a = await segmentPoint(page, 20);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y - 140, { steps: 10 });
  for (const [x, n] of [[0, 1], [1279, PAGE_COUNT]]) {
    await page.mouse.move(x, a.y - 140, { steps: 10 });
    assert.equal(await counterPage(page), n);
    assert.deepEqual(await stripEnd(page, n), { whole: true, onThumb: true, atEnd: true }, `thumbnail ${n} at the screen's edge`);
  }
  await page.mouse.up();
});

test('Shift-scrubbing in the thumbnails reaches both ends of the strip', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 20 });
  await page.evaluate(() => document.getElementById('thumbBtn').click());
  await settle(800);
  const y = await page.$eval('#thumbStrip', strip => strip.getBoundingClientRect().top + 30);
  await page.keyboard.down('Shift');
  await page.mouse.move(640, y);
  await page.mouse.down();
  for (const [x, n] of [[0, 1], [1279, PAGE_COUNT]]) {
    await page.mouse.move(x, y, { steps: 12 });
    assert.equal(await counterPage(page), n);
    assert.deepEqual(await stripEnd(page, n), { whole: true, onThumb: true, atEnd: true }, `thumbnail ${n} at the screen's edge`);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
});

// At either end of a scrub the strip is scrolled all the way, its end thumb whole and indicated.
function stripEnd(page, n) {
  return page.evaluate(n => {
    const strip = document.getElementById('thumbStrip');
    const box = strip.getBoundingClientRect();
    const item = document.querySelector(`#thumbStrip .thumb-item:nth-of-type(${n + 1})`).getBoundingClientRect();
    const view = document.getElementById('thumbViewport').getBoundingClientRect();
    const end = n === 1 ? 0 : strip.scrollWidth - strip.clientWidth;
    return {
      whole: item.left >= box.left && item.right <= box.right,
      onThumb: Math.abs(view.left - item.left) < 4,
      atEnd: Math.abs(strip.scrollLeft - end) <= 1,
    };
  }, n);
}

// Fit width makes these pages about twice the screen's height: halfway down one, the next isn't in
// view yet, so it mustn't be the current page; once it fills most of the screen, it is.
test('with pages taller than the screen, the current page is one the band covers', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 25, fit: 'width' });
  await page.waitForFunction(() => !document.documentElement.classList.contains('reader-strip-gliding'));
  const scrollInto = (n, f) => page.evaluate(({ n, f }) => {
    const row = document.querySelector(`#stripView [data-page="${n}"]`);
    scrollTo(0, scrollY + row.getBoundingClientRect().top + row.offsetHeight * f);
  }, { n, f });
  const state = () => page.evaluate(count => {
    const bar = document.getElementById('scrubSegments').getBoundingClientRect();
    const band = document.querySelector('.scrub-view').getBoundingClientRect();
    return {
      counter: Number(document.getElementById('pageCounter').textContent.split('/')[0]),
      active: Number(document.querySelector('.scrub-segment.active').dataset.n),
      band: [(band.left - bar.left) / bar.width * count, (band.right - bar.left) / bar.width * count],
    };
  }, PAGE_COUNT);
  assert.ok(await page.$eval('#stripView [data-page="25"]', row => row.offsetHeight > innerHeight * 1.5), 'the fixture needs tall pages');
  await scrollInto(25, 0.62);
  await settle();
  const mid = await state();
  assert.equal(mid.counter, 25, `page 26 barely shows (band ${mid.band}) — page 25 is still current`);
  assert.equal(mid.active, 25);
  assert.ok(mid.band[0] < 25 && mid.band[1] > 24, `the band ${mid.band} should cover page 25`);
  await scrollInto(25, 0.9);
  await settle();
  const late = await state();
  assert.equal(late.counter, 26, `page 26 fills most of the screen now (band ${late.band})`);
  assert.equal(late.active, 26);
});

test('thumbnails are made while reading, so opening them shows them at once', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 20 });
  // The warm-up makes them in idle moments; wait until a probe open would find all of them.
  await until(page, () => document.getElementById('pageCounter').textContent.length > 0, null);
  await settle(4000);
  const shown = await page.evaluate(() => {
    document.getElementById('thumbBtn').click();
    const imgs = [...document.querySelectorAll('#thumbStrip .thumb-item img')];
    return { total: imgs.length, withSrc: imgs.filter(img => img.getAttribute('src')?.startsWith('blob:')).length };
  });
  assert.equal(shown.total, PAGE_COUNT);
  assert.equal(shown.withSrc, PAGE_COUNT, 'every thumbnail should be ready the moment the strip opens');
  const size = await until(page, () => {
    const img = document.querySelector('#thumbStrip .thumb-item img');
    return img.naturalWidth ? { w: img.naturalWidth } : null;
  }, null, { what: 'a thumbnail to load' });
  assert.ok(size.w <= 160, `thumbnails should be made near their shown size, not ${size.w}px wide`);
  // One not made yet (or let go) shows nothing, never the browser's broken-image glyph.
  const hidden = await page.evaluate(() => {
    const img = document.querySelector('#thumbStrip .thumb-item img');
    img.removeAttribute('src');
    return getComputedStyle(img).visibility;
  });
  assert.equal(hidden, 'hidden');
});

// Presses the bar at page n's segment and counts the frames until the page shows, loaded.
const pressShows = (page, n) => page.evaluate(async (n) => {
  const seg = document.querySelector(`.scrub-segment:nth-child(${n})`).getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, button: 0, pointerId: 7, pointerType: 'mouse', isPrimary: true, clientX: seg.left + seg.width / 2, clientY: innerHeight - 2 };
  document.getElementById('bottombar').dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1 }));
  document.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0 }));
  const img = document.getElementById('mainImg');
  for (let frames = 1; frames < 300; frames++) {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const counter = Number(document.getElementById('pageCounter').textContent.split('/')[0].trim());
    if (counter === n && img.complete && img.naturalWidth) return frames;
  }
  return Infinity;
}, n);

test('resting the pointer on the bar readies the page a press there shows', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single', gallery: HEAVY_GALLERY, count: HEAVY_COUNT, at: 5 });
  await page.evaluate(() => {
    const input = document.getElementById('readerDebugLoaded');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
  });
  await settle(1000);
  const { x, y } = await segmentPoint(page, 90);
  await page.mouse.move(x, y - 8);
  await page.waitForFunction(() => document.querySelector('.scrub-segment:nth-child(90)').classList.contains('debug-loaded'), { timeout: 3000 });
  assert.equal(await pressShows(page, 90), 1, 'the page the pointer rested on should show the frame it is pressed');
  // Only a resting pointer preloads: sweeping across the bar asks for nothing on the way.
  await page.mouse.move(x, y - 8);
  const sweep = await page.evaluate(async () => {
    const bar = document.getElementById('bottombar');
    const segs = document.querySelectorAll('.scrub-segment');
    for (let n = 20; n <= 60; n++) {
      const r = segs[n - 1].getBoundingClientRect();
      bar.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: r.left + r.width / 2, clientY: innerHeight - 6 }));
    }   // one task: on a busy machine, frame gaps would count as rests
    await new Promise(resolve => setTimeout(resolve, 300));
    return [...segs].slice(20, 58).filter(s => s.classList.contains('debug-loaded')).length;
  });
  assert.equal(sweep, 0, 'pages swept past should not be loaded');
});

test('resting the pointer on a thumbnail readies its page', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single', gallery: HEAVY_GALLERY, count: HEAVY_COUNT, at: 5 });
  await page.evaluate(() => {
    const input = document.getElementById('readerDebugLoaded');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
    document.getElementById('thumbBtn').click();
  });
  await settle(800);
  // The furthest thumbnail fully on screen, whose page isn't loaded yet.
  const { x, y, n } = await page.evaluate(() => {
    const item = [...document.querySelectorAll('#thumbStrip .thumb-item')].filter(item => {
      const r = item.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }).at(-1);
    const r = item.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, n: Number(item.querySelector('img').dataset.idx) + 1 };
  });
  assert.equal(await page.$eval(`.scrub-segment:nth-child(${n})`, s => s.classList.contains('debug-loaded')), false);
  await page.mouse.move(x, y);
  await page.waitForFunction(n => document.querySelector(`.scrub-segment:nth-child(${n})`).classList.contains('debug-loaded'), { timeout: 3000 }, n);
});

test('the debug view colours the pages the reader holds, and nothing when off', { skip: !chromePath() }, async t => {
  const page = await reader(t, { at: 20 });
  const marked = () => page.evaluate(() => {
    const segs = [...document.querySelectorAll('.scrub-segment')];
    const blue = segs.flatMap((s, i) => s.classList.contains('debug-loaded') ? [i + 1] : []);
    const held = [...document.querySelectorAll('#stripView .page-wrap')]
      .filter(row => { const img = row.querySelector('img'); return img.getAttribute('src') && img.complete && img.naturalWidth; })
      .map(row => Number(row.dataset.page));
    return { blue, held };
  });
  assert.deepEqual((await marked()).blue, [], 'off, the bar shows nothing extra');
  await page.evaluate(() => {
    const input = document.getElementById('readerDebugLoaded');
    input.checked = true;
    input.dispatchEvent(new Event('change'));
  });
  await scrollSettled(page);
  // Every page the strip holds, and only those, turns blue (a frame after it loads).
  await until(page, () => {
    const segs = [...document.querySelectorAll('.scrub-segment')];
    const blue = segs.flatMap((s, i) => s.classList.contains('debug-loaded') ? [i + 1] : []).join();
    const held = [...document.querySelectorAll('#stripView .page-wrap')]
      .filter(row => { const img = row.querySelector('img'); return img.getAttribute('src') && img.complete && img.naturalWidth; })
      .map(row => Number(row.dataset.page)).join();
    return held && blue === held ? held : null;
  }, null, { what: 'the blue segments to match the pages held' });
  const color = await page.$eval('.scrub-segment.debug-loaded:not(.active)', s => getComputedStyle(s).backgroundColor);
  assert.equal(color, 'rgb(47, 124, 246)');
  await page.evaluate(() => {
    const input = document.getElementById('readerDebugLoaded');
    input.checked = false;
    input.dispatchEvent(new Event('change'));
  });
  assert.deepEqual((await marked()).blue, []);
});

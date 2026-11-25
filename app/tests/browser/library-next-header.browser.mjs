// library-next-header.browser.mjs — the library's header on /library-next, held against 1.3's page
// (/library) driven alike: every part's box at every width 1.3's stylesheet has a rule for (above and at
// 1400px, the folded form; above and at 600px, the phone's two rows; a phone; 320px), and at 125% and
// 150% scale; the menu button (what its press shows at each width, and what closes it: its own press
// again and a press anywhere else, not Escape, not a press inside the totals, as 1.3's); the pin (the
// header staying or scrolling away 2,000px down, its two faces and tips, the choice kept across a
// reload); the totals' tips in the open menu. And the layout checklist for what the new page adds: the
// open menu drawn in the frame after the press and after a resize, no motion on it, no keyboard ring
// after a press, the phone's targets. The new page alone: the menu closed when the page is left.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, openPage, until } from './harness.mjs';

let server, origin;
const browsers = {};
const PATHS = ['/library', '/library-next'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  for (const scale of [1, 1.25, 1.5]) {
    browsers[scale] = await puppeteer.launch({ executablePath: chromePath(), headless: true, ignoreDefaultArgs: ['--hide-scrollbars'],
      args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', `--force-device-scale-factor=${scale}`] });
  }
  // (Each browser keeps a library of its own.)
  for (const b of Object.values(browsers)) {
  const page = await openPage(b, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const api = await import('/app/js/api.js');
    for (let i = 0; i < 40; i++) {
      const gid = String(1790007000000 + i);
      const c = new OffscreenCanvas(300, 430); const x = c.getContext('2d'); x.fillStyle = `hsl(${i * 9} 60% 50%)`; x.fillRect(0, 0, 300, 430);
      await api.meta.put({ galleryId: gid, title: { english: `Header gallery ${i}`, japanese: '', pretty: '' }, tags: [{ type: 'tag', name: `t${i % 4}` }], numPages: 1 });
      await api.pages.put(gid, 1, await c.convertToBlob({ type: 'image/png' }));
    }
    await (await import('/app/js/migrations.js')).runMigrations();
  });
  await page.close();
  }
});
after(async () => { for (const b of Object.values(browsers)) await b.close(); server?.close(); });

const PHONE = { width: 390, height: 844, hasTouch: true, isMobile: true };
async function open(path, viewport, { scale = 1, pin } = {}) {
  const page = await openPage(browsers[scale], origin);
  await page.setViewport(viewport);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate((pin) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('shiori:lib')) localStorage.removeItem(k);
    localStorage.removeItem('shiori-safe-mode');
    if (pin == null) localStorage.removeItem('shiori-header-pin'); else localStorage.setItem('shiori-header-pin', pin);
  }, pin);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('#grid > .card').length === 30 && document.getElementById('hTotalGalleries')?.textContent !== '—'
    && !!document.getElementById('hSizeStat')?.dataset.tip, null, { what: 'the page and its totals' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(300);
  return page;
}

// Every part of the header, and the header.
const PARTS = ['header', 'header .brand-wrap', 'header .brand-text', 'header .brand-sep', '#pageNav', 'header .search-wrap', '#searchBox', '#pinBtn', '#burgerBtn', '#collapsibleGroup',
  '#hTotalGalleries', '#hImagesStat', '#hSizeStat', '#uploadCbzBtn', '#safeBtn', '#settingsBtn', '#sortSelect', '#filterBtn', '#grid > .card'];
function boxes(sels) {
  return Object.fromEntries(sels.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return [sel, null];
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return [sel, s.display === 'none' || r.width === 0 ? 'hidden' : [r.x, r.y, r.width, r.height].map((n) => +n.toFixed(2))];
  }));
}
// What differs between the two pages' boxes by more than a pixel.
function differ(a, b) {
  return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .filter((k) => !(Array.isArray(a[k]) && Array.isArray(b[k]) && a[k].every((v, i) => Math.abs(v - b[k][i]) <= 1)))
    .map((k) => [k, a[k], b[k]]);
}
// The open menu's look: its box and frame, and the totals inside it.
function menuLook() {
  const g = document.getElementById('collapsibleGroup');
  const s = getComputedStyle(g);
  return { open: g.classList.contains('open'), shown: s.display !== 'none', position: s.position, zIndex: s.zIndex, background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
    radius: s.borderTopLeftRadius, padding: s.padding, shadow: s.boxShadow, gap: s.columnGap, direction: s.flexDirection, align: s.alignItems };
}

const WIDTHS = [[1500, 900], [1401, 900], [1400, 900], [1280, 900], [800, 900], [601, 900], [600, 900], [320, 700]];

test('the header at every width 1.3 has a rule for, and on a phone: every part\'s box, the menu\'s press', async (t) => {
  if (!browsers[1]) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  for (const [name, viewport] of [...WIDTHS.map(([width, height]) => [`${width}`, { width, height }]), ['phone', PHONE]]) {
    const out = {};
    for (const path of PATHS) {
      const page = await open(path, viewport);
      const r = { rest: await page.evaluate(boxes, PARTS), overflow: await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth) };
      const burger = await page.evaluate(() => { const b = document.getElementById('burgerBtn'); return b && getComputedStyle(b).display !== 'none'; });
      if (burger) {
        if (viewport.hasTouch) await page.tap('#burgerBtn'); else await page.click('#burgerBtn');
        await sleep(200);
        r.open = await page.evaluate(boxes, PARTS);
        r.menu = await page.evaluate(menuLook);
        r.inside = await page.evaluate(() => { const g = document.getElementById('collapsibleGroup').getBoundingClientRect(); return g.left >= 0 && g.right <= document.documentElement.clientWidth; });
      }
      out[path] = r;
      assert.deepEqual(page.problems, []);
      await page.close();
    }
    const was = out['/library'], now = out['/library-next'];
    assert.deepEqual(differ(was.rest, now.rest), [], `at ${name}, at rest`);
    assert.equal(now.overflow, was.overflow, `at ${name}: sideways scroll`);
    assert.equal(!!now.open, !!was.open, `at ${name}: the menu button`);
    if (was.open) {
      assert.deepEqual(differ(was.open, now.open), [], `at ${name}, the menu open`);
      assert.deepEqual(now.menu, was.menu, `at ${name}: the open menu's look`);
      assert.equal(was.menu.shown, true);
      assert.equal(now.inside, was.inside);
    }
  }
});

test('the menu button: its own press closes it, a press anywhere else too; not Escape, not a press inside it', async (t) => {
  if (!browsers[1]) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  for (const path of PATHS) {
    const page = await open(path, { width: 1280, height: 900 });
    const isOpen = () => page.evaluate(() => getComputedStyle(document.getElementById('collapsibleGroup')).display !== 'none');
    const r = {};
    await page.click('#burgerBtn'); await sleep(150); r.pressed = await isOpen();
    await page.click('#burgerBtn'); await sleep(150); r.pressedAgain = await isOpen();
    await page.click('#burgerBtn'); await sleep(150);
    await page.keyboard.press('Escape'); await sleep(150); r.escape = await isOpen();
    await page.click('#hImagesStat'); await sleep(150); r.inside = await isOpen();
    // The totals' tips, in the open menu.
    await page.hover('#hSizeStat');
    await until(page, () => { const tip = document.querySelector('.shiori-tip'); return !!tip && tip.style.display !== 'none' && !!tip.textContent; }, null, { what: 'the tip' });
    await sleep(150);
    r.tip = await page.evaluate(() => document.querySelector('.shiori-tip').textContent);
    await page.mouse.click(100, 85); await sleep(150); r.toolbar = await isOpen();
    await page.click('#burgerBtn'); await sleep(150);
    await page.click('#searchBox'); await sleep(150); r.search = await isOpen();
    await page.keyboard.press('Escape');
    await page.click('#burgerBtn'); await sleep(150);
    await page.click('#grid > .card:nth-child(6) .card-meta'); await sleep(150); r.card = await isOpen();
    await page.click('#burgerBtn'); await sleep(150);
    // At a width where the totals are in the bar the button is gone and the totals show, open or not;
    // back to the folded width, the menu is as it was left.
    await page.setViewport({ width: 1500, height: 900 }); await sleep(150); r.wide = [await isOpen(), await page.evaluate(() => getComputedStyle(document.getElementById('burgerBtn')).display)];
    await page.setViewport({ width: 1280, height: 900 }); await sleep(150); r.foldedAgain = await isOpen();
    out[path] = r;
    assert.deepEqual(page.problems, []);
    await page.close();
  }
  assert.deepEqual(out['/library'], { pressed: true, pressedAgain: false, escape: true, inside: true, tip: out['/library'].tip, toolbar: false, search: false, card: false, wide: [true, 'none'], foldedAgain: true });
  assert.deepEqual(out['/library-next'], out['/library']);
});

test('the new page: the menu closed once the page is left, and its look under the pointer kept', async (t) => {
  if (!browsers[1]) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open('/library-next', { width: 1280, height: 900 });
  await page.click('#burgerBtn');
  await sleep(150);
  await page.evaluate(() => { const a = document.createElement('a'); a.href = '/tasks'; document.body.append(a); a.click(); a.remove(); });
  await page.waitForSelector('#tkList');
  assert.equal(await page.$('#collapsibleGroup'), null, 'gone with the page');
  await page.evaluate(() => history.back());
  await until(page, () => document.querySelectorAll('#grid > .card').length === 30, null, { what: 'back' });
  await sleep(300);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('collapsibleGroup')).display), 'none', 'closed when the page shows again');
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('the pin: the header stays or scrolls away 2,000px down; its faces and tips; the choice kept across a reload', async (t) => {
  if (!browsers[1]) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  for (const path of PATHS) {
    const page = await open(path, { width: 1280, height: 900 });
    const look = () => page.evaluate(async () => {
      window.scrollTo(0, 2000);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const h = document.querySelector('header').getBoundingClientRect();
      const btn = document.getElementById('pinBtn');
      const out = { scrolled: scrollY, headerTop: Math.round(h.top), position: getComputedStyle(document.querySelector('header')).position, tip: btn.dataset.tip,
        icon: [...btn.querySelectorAll('svg *')].map((el) => el.getAttribute('d') ?? [el.localName, ...['x1', 'y1', 'x2', 'y2'].map((a) => el.getAttribute(a))].join(' ')).join('|'), stored: localStorage.getItem('shiori-header-pin') };
      window.scrollTo(0, 0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return out;
    });
    const r = { load: await look() };
    await page.click('#pinBtn'); await sleep(200);
    r.unpinned = await look();
    await page.reload({ waitUntil: 'load' });
    await until(page, () => document.querySelectorAll('#grid > .card').length === 30, null, { what: 'reloaded' });
    await sleep(300);
    r.reload = await look();
    await page.click('#pinBtn'); await sleep(200);
    r.pinned = await look();
    out[path] = r;
    assert.deepEqual(page.problems, []);
    await page.close();
  }
  const was = out['/library'];
  assert.equal(was.load.headerTop, 0);
  assert.equal(was.unpinned.headerTop, -2000);
  assert.equal(was.unpinned.stored, '0');
  assert.deepEqual(out['/library-next'], was);
});

test('the pin, the menu and the header at 125% and 150%: boxes as 1.3\'s; the layout checklist', async (t) => {
  if (!browsers[1.25]) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  for (const scale of [1, 1.25, 1.5]) {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 600, height: 900 }]) {
      const out = {};
      for (const path of PATHS) {
        const page = await open(path, viewport, { scale });
        const r = { rest: await page.evaluate(boxes, PARTS) };
        await page.click('#burgerBtn');
        // Drawn in the frame after the press, and no motion on it.
        r.frame = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => {
          const g = document.getElementById('collapsibleGroup');
          done({ shown: getComputedStyle(g).display !== 'none', moving: g.getAnimations({ subtree: true }).length });
        })));
        r.open = await page.evaluate(boxes, PARTS);
        // A press then a key: what has the keyboard ring.
        await page.keyboard.press('Shift');
        r.ring = await page.evaluate(() => document.querySelector(':focus-visible')?.id ?? null);
        // The scrollbar gone: the open menu as 1.3's.
        await page.evaluate(() => { document.documentElement.style.overflow = 'hidden'; });
        await sleep(100);
        r.noScrollbar = await page.evaluate(boxes, ['#collapsibleGroup', '#burgerBtn', '#settingsBtn']);
        await page.evaluate(() => { document.documentElement.style.overflow = ''; });
        // A resize: final in the next frame.
        await page.setViewport({ width: viewport.width - 37, height: viewport.height });
        r.resized = await page.evaluate((sels) => new Promise((done) => requestAnimationFrame(() => done({ boxes: Object.fromEntries(sels.map((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [s, [b.x, b.width].map((n) => +n.toFixed(1))]; })), moving: document.getElementById('collapsibleGroup').getAnimations({ subtree: true }).length }))), ['#collapsibleGroup', '#burgerBtn']);
        await sleep(300);
        r.settled = await page.evaluate((sels) => Object.fromEntries(sels.map((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [s, [b.x, b.width].map((n) => +n.toFixed(1))]; })), ['#collapsibleGroup', '#burgerBtn']);
        out[path] = r;
        assert.deepEqual(page.problems, []);
        await page.close();
      }
      const was = out['/library'], now = out['/library-next'], at = `${viewport.width} at ${scale * 100}%`;
      // (Under the header: the sort box is a fixed 34px where 1.3's native box rounded its line, 1.33px
      // off at 150%, §5.3 F49; the filter button and the grid follow it.)
      for (const r of [was, now]) for (const boxes of [r.rest, r.open]) for (const k of ['#sortSelect', '#filterBtn', '#grid > .card']) delete boxes[k];
      assert.deepEqual(differ(was.rest, now.rest), [], `${at}, at rest`);
      assert.deepEqual(differ(was.open, now.open), [], `${at}, the menu open`);
      assert.deepEqual(differ(was.noScrollbar, now.noScrollbar), [], `${at}, no scrollbar`);
      assert.deepEqual(now.frame, { shown: true, moving: 0 }, `${at}: drawn at once, still`);
      // A press then a key: Chrome turns the button's focus visible (any key, Shift or Escape alike), on
      // 1.3's page as on this one (each header button; the ring drawn is the app's one ring, T7).
      assert.equal(now.ring, was.ring, `${at}: the ring after a press and a key`);
      assert.deepEqual(now.resized.boxes, now.settled, `${at}: final in the frame after a resize`);
      assert.equal(now.resized.moving, 0);
    }
  }
});

test('on a phone the header\'s buttons are a finger\'s size, as 1.3\'s', async (t) => {
  if (!browsers[1]) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  for (const path of PATHS) {
    const page = await open(path, PHONE);
    out[path] = await page.evaluate(() => ['#pinBtn', '#burgerBtn', '#uploadCbzBtn', '#safeBtn', '#settingsBtn'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [s, r.width, r.height]; }));
    await page.close();
  }
  for (const [s, w, h] of out['/library-next']) assert.ok(w >= 40 && h >= 40, `${s} ${w}×${h}`);
  assert.deepEqual(out['/library-next'], out['/library']);
});

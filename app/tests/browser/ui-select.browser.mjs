// ui-select.browser.mjs — Select (src/components/ui/select.tsx) as /components shows it: a combobox
// opening a listbox; Enter, Space and the arrows open it, move and choose, Escape closes it; the list
// hangs off the box at its width (placed by CSS anchoring) and stays on it in the very frame the page
// scrolls or the window changes; at most eight rows; it opens upward only when just the room above
// holds it; opening it moves nothing on the page; no text fades or moves; under a coarse pointer it
// is the system's select, drawn closed the same.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { componentsPage, spec, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const FIELD = spec('select-field', 'field');
const settled = (page) => page.evaluate(() => new Promise((done) => setTimeout(done, 350)));
// The open list against its box, read in one frame.
const fit = (page, sel) => page.evaluate((sel) => {
  const box = document.querySelector(sel).getBoundingClientRect();
  const list = document.querySelector('[data-slot="select-list"][data-open]');
  if (!list) return null;
  const l = list.getBoundingClientRect();
  return { top: l.top - (box.bottom - 1), bottom: l.bottom - (box.top + 1), left: l.left - box.left, width: l.width - box.width, height: l.height, up: list.parentElement.hasAttribute('data-up') };
}, sel);

test('a combobox and its listbox: opened, moved through and chosen by the keyboard, closed by Escape', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await page.$eval(FIELD, (el) => el.scrollIntoView({ block: 'center' }));
  const aria = () => page.$eval(FIELD, (el) => [el.getAttribute('role'), el.getAttribute('aria-expanded'), el.textContent]);
  assert.deepEqual(await aria(), ['combobox', 'false', 'English']);
  await page.focus(FIELD);
  await page.keyboard.press('Enter');
  await settled(page);
  assert.equal((await aria())[1], 'true');
  const options = await page.$$eval('[data-slot="select-list"][data-open] [role="option"]', (os) => os.map((o) => [o.textContent, o.getAttribute('aria-selected')]));
  assert.equal(options.length, 12);
  assert.deepEqual(options[0], ['English', 'true']);
  assert.equal(await page.$eval('[data-slot="select-list"][data-open] [role="listbox"], [data-slot="select-list"][data-open][role="listbox"]', (l) => !!l), true, 'a listbox');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await settled(page);
  // Reached by the keyboard, an option shows it (the raised ground, once its colour has eased in).
  await until(page, () => document.activeElement?.getAttribute('role') === 'option' && getComputedStyle(document.activeElement).backgroundColor === 'rgb(28, 28, 33)', undefined, { what: 'the option reached by the keyboard lit', timeout: 5000 });
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Deutsch');
  await page.keyboard.press('Enter');
  await settled(page);
  assert.deepEqual(await aria(), ['combobox', 'false', 'Deutsch']);
  // Space opens it too; Escape closes it and leaves the choice.
  await page.keyboard.press('Space');
  await settled(page);
  assert.equal((await aria())[1], 'true');
  await page.keyboard.press('Escape');
  await settled(page);
  assert.deepEqual(await aria(), ['combobox', 'false', 'Deutsch']);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'combobox', 'focus back on the box');
  assert.deepEqual(page.problems, []);
});

test('the list hangs off the box at its width, eight rows at most, and stays on it as the page scrolls and the window changes', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const at = await centreOf(page, FIELD);
  const before = await page.$$eval('[data-section="select"] [data-shape]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.height]; }));
  await page.mouse.click(at.x, at.y);
  await settled(page);
  const open = await fit(page, FIELD);
  assert.deepEqual([open.top, open.left, open.width, open.up], [0, 0, 0, false], 'under the box, its edge over the box\'s, as wide');
  assert.ok(Math.abs(open.height - (8 * 28.8 + 10)) < 0.5, `eight rows (${open.height})`);
  assert.equal(await page.$eval(FIELD, (el) => getComputedStyle(el.querySelector('svg')).rotate), '180deg', 'the chevron turned');
  const after = await page.$$eval('[data-section="select"] [data-shape]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.height]; }));
  assert.deepEqual(after, before, 'opening it moved nothing on the page');
  // Scrolled, then the very next frame painted: the list's seam right under the box's bottom edge and
  // its ground below. (Read in the picture: Chrome keeps an anchored box on its anchor through a
  // scroll as it paints, while its DOM box catches up a frame later.)
  const cdp = await page.createCDPSession();
  const column = async (x, y0, n) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    return page.evaluate(async (b64, x, y0, n) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return [...Array(n).keys()].map((i) => [...g.getImageData(x, y0 + i, 1, 1).data].slice(0, 3).join());
    }, data, x, y0, n);
  };
  for (const dy of [40, -90, 7]) {
    await page.evaluate((dy) => scrollBy(0, dy), dy);
    const [x, bottom] = await page.$eval(FIELD, (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left + 40), Math.round(r.bottom)]; });
    const px = await column(x, bottom - 1, 4);
    assert.deepEqual(px, ['42,42,48', '17,17,20', '17,17,20', '17,17,20'], `scrolled ${dy}px: the seam on the box's edge and the list under it, in the first frame`);
  }
  // The box narrows: the list follows its width and place.
  await page.$eval(FIELD, (el) => { el.parentElement.style.width = '200px'; });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const still = await fit(page, FIELD);
  assert.deepEqual([still.top, still.left, still.width], [0, 0, 0], 'its width and place follow the box');
  assert.deepEqual(await textMotion(page, '[data-slot="select-list"][data-open]'), [], 'no text in the list fades or moves (it unrolls by a clip)');
  assert.deepEqual(page.problems, []);
});

test('near the bottom of the window it opens upward, its top corners squared off the box', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  // The box moved to the window's bottom edge (fixed), then opened.
  await page.$eval(FIELD, (el) => { const p = el.parentElement; Object.assign(p.style, { position: 'fixed', bottom: '10px', left: '20px', zIndex: 5 }); });
  const at = await centreOf(page, FIELD);
  await page.mouse.click(at.x, at.y);
  await settled(page);
  const open = await fit(page, FIELD);
  assert.deepEqual([open.bottom, open.left, open.width, open.up], [0, 0, 0, true], 'above the box, its edge over the box\'s');
  const corners = await page.$eval(FIELD, (el) => { const s = getComputedStyle(el); return [s.borderTopLeftRadius, s.borderBottomLeftRadius]; });
  assert.deepEqual(corners, ['0px', '6px']);
});

test('under a coarse pointer it is the system\'s select, drawn closed as the other', async (t) => {
  const page = await componentsPage(t, browser, origin, { width: 390, height: 844, hasTouch: true, isMobile: true });
  if (!page) return;
  const box = await page.$eval(FIELD, (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return [el.localName, r.height, s.backgroundColor, s.borderTopColor, s.appearance, el.options.length]; });
  assert.deepEqual(box, ['select', 36, 'rgb(17, 17, 20)', 'rgb(63, 63, 72)', 'none', 12]);
  await page.select(FIELD, 'fr');
  assert.equal(await page.$eval(FIELD, (el) => el.value), 'fr');
});

test('in a browser without CSS anchor positioning it is the system\'s select, as under a coarse pointer', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  // Before the page's scripts run, the browser is told to know no anchor positioning.
  await page.evaluateOnNewDocument(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = (...args) => (/anchor/.test(args.join(' ')) ? false : supports(...args));
  });
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  await until(page, () => !!document.querySelector('[data-specimen]'), undefined, { what: 'the components page' });
  const box = await page.$eval(FIELD, (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return [el.localName, r.height, s.backgroundColor, s.borderTopColor, el.options.length]; });
  assert.deepEqual(box, ['select', 36, 'rgb(17, 17, 20)', 'rgb(63, 63, 72)', 12]);
  assert.equal(await page.$$eval('[data-slot="select-trigger"]', (els) => els.length), 0, 'no drawn list anywhere');
  assert.deepEqual(page.problems, []);
});

test('no tip shows while a list is open (the list is over everything, a tip would sit behind it); it is back once the list has closed', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  // The tip is on what holds the box, as a pipeline step of Settings carries its own: the pointer on
  // the box is on it, and stays on it while the list hangs open below.
  await page.$eval(FIELD, (el) => { el.parentElement.dataset.tip = 'About this choice'; });
  const tip = () => page.evaluate(() => { const el = document.querySelector('.shiori-tip'); return el && getComputedStyle(el).display !== 'none' ? el.textContent : null; });
  const open = () => page.$eval(FIELD, (el) => el.getAttribute('aria-expanded') === 'true');
  // The list opens a moment after what asks for it: waited for, then two frames more.
  const opened = async () => { await until(page, (sel) => document.querySelector(sel).getAttribute('aria-expanded') === 'true', FIELD, { what: 'the list open', timeout: 5000 }); await frames(); };
  const shown = (what) => until(page, () => { const el = document.querySelector('.shiori-tip'); return !!el && getComputedStyle(el).display !== 'none' && el.textContent === 'About this choice'; }, undefined, { what, timeout: 5000 });
  // Two frames: what a press or a key changes is looked at in the frame after it.
  const frames = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const at = await centreOf(page, FIELD);
  const rest = async () => { await page.mouse.move(at.x - 6, at.y); await page.mouse.move(at.x, at.y); };
  await rest();
  await shown('the tip, the list closed');

  // Opened by a press: the tip goes, and the pointer moving on the box does not bring it back.
  await page.mouse.click(at.x, at.y);
  await opened();
  assert.equal(await tip(), null, 'opened by a press');
  await rest();
  await frames();
  assert.equal(await tip(), null, 'the pointer moving on the box while the list is open');
  await settled(page);
  assert.equal(await tip(), null, 'and once the list has unrolled');

  // Closed by Escape: back at the pointer's next move.
  await page.keyboard.press('Escape');
  await settled(page);
  assert.equal(await open(), false);
  await rest();
  await shown('the tip after Escape');

  // Opened by the keyboard, the pointer resting on the box: gone with no move of the pointer.
  await page.focus(FIELD);
  await page.keyboard.press('Enter');
  await opened();
  assert.equal(await tip(), null, 'opened by the keyboard');

  // An option chosen by a press: the list closes, and the tip is back at the next move.
  await settled(page);
  const option = await page.evaluate(() => { const r = document.querySelectorAll('[data-slot="select-list"][data-open] [role="option"]')[2].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(option.x, option.y);
  assert.equal(await tip(), null, 'the pointer on an option');
  await page.mouse.click(option.x, option.y);
  await settled(page);
  assert.equal(await open(), false);
  await rest();
  await shown('the tip after a choice');

  // Closed by a press beside it (on what holds the box, clear of the box and the list).
  await page.mouse.click(at.x, at.y);
  await opened();
  assert.equal(await tip(), null);
  const beside = await page.evaluate((sel) => {
    const box = document.querySelector(sel).getBoundingClientRect();
    for (const [x, y] of [[box.right + 40, box.top - 30], [box.left - 40, box.top - 30], [box.right + 40, box.top + 4], [innerWidth - 40, box.top - 30]]) {
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest('a, button, input, select, label, [role], [tabindex], [data-slot="select-positioner"]')) return { x, y };
    }
    return null;
  }, FIELD);
  assert.ok(beside, 'a place beside the box that is nothing to press');
  await page.mouse.click(beside.x, beside.y);
  await settled(page);
  assert.equal(await open(), false, 'closed by a press beside it');
  await rest();
  await shown('the tip after a press beside the list');
  assert.deepEqual(page.problems, []);
});

// The owner (2026-11-26), of the list hung off its box: "when it's sliding in and out, there's a weird
// period where you can see it breaks the illusion as the rounding needs to maybe delayed or synced to
// the dropdown pulling up and down". The box squared and rounded its corners over 120 ms from the
// moment the popup opened or began to close, while the list unrolled or rolled up over 180 ms: as it
// closed, the box was round again with a strip of the list still hanging under it, the list's sides
// showing past the curve, and its frame had gone back to its resting colour beside the list's. Now the
// box keeps its joined look (data-unrolled) from the frame the list starts until the frame it is gone.
// Held every frame, the motion slowed five times so no frame of it is missed: while any of the list is
// there, the corners by it are square and the box's frame is the list's; after it, they are round.
const JOINED = [['field', spec('select-field', 'field')], ['toolbar', spec('sort-select', 'toolbar')], ['inset', spec('modal-select', 'inset')]];
const watchJoin = (page, sel, up) => page.evaluate(({ sel, up }) => {
  const box = document.querySelector(sel);
  const seen = (window.__join = { frames: [], stop: false });
  const tick = () => {
    // (The list is kept in the page while closed, not drawn: "there" is drawn.)
    const kept = document.querySelector('[data-slot="select-list"]'), list = kept && kept.getClientRects().length ? kept : null;
    const b = getComputedStyle(box);
    const row = {
      list: !!list,
      byList: up ? [b.borderTopLeftRadius, b.borderTopRightRadius] : [b.borderBottomLeftRadius, b.borderBottomRightRadius],
      away: up ? [b.borderBottomLeftRadius, b.borderBottomRightRadius] : [b.borderTopLeftRadius, b.borderTopRightRadius],
      frame: up ? b.borderTopColor : b.borderBottomColor,
    };
    if (list) { const l = getComputedStyle(list); row.listFrame = l.borderLeftColor; row.clip = l.clipPath; }
    seen.frames.push(row);
    if (!seen.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}, { sel, up });
const joinSeen = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => { window.__join.stop = true; done(window.__join.frames); })));

for (const [variant, sel] of JOINED) {
  for (const up of [false, true]) {
    test(`${variant}, opening ${up ? 'upward' : 'downward'}: box and list are one outline in every frame the list shows any of itself, unrolling and rolling up`, async (t) => {
      const page = await componentsPage(t, browser, origin);
      if (!page) return;
      const cdp = await page.createCDPSession();
      await cdp.send('Animation.enable');
      await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.2 });
      if (up) await page.$eval(sel, (el) => { const p = el.parentElement; Object.assign(p.style, { position: 'fixed', bottom: '10px', left: '20px', zIndex: 5 }); });
      const at = await centreOf(page, sel);
      await watchJoin(page, sel, up);
      await page.mouse.click(at.x, at.y);
      await until(page, () => { const l = document.querySelector('[data-slot="select-list"]'); return !!l && l.getAnimations().length === 0 && !l.hasAttribute('data-starting-style'); }, null, { what: 'the list unrolled' });
      // An option pressed: the pointer is on the list, off the box, as the list rolls up.
      const option = await page.evaluate(() => { const r = document.querySelectorAll('[data-slot="select-list"] [role="option"]')[1].getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.move(option.x, option.y);
      await page.mouse.click(option.x, option.y);
      await until(page, () => !document.querySelector('[data-slot="select-list"]')?.getClientRects().length, null, { what: 'the list gone' });
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const frames = await joinSeen(page);

      const withList = frames.filter((f) => f.list);
      const moving = new Set(withList.map((f) => f.clip)).size;
      assert.ok(moving >= 6, `the unrolling and the rolling up were watched as they moved (${moving} places of the clip seen)`);
      assert.deepEqual([...new Set(withList.map((f) => f.byList.join(' ')))], ['0px 0px'], 'the corners by the list: square in every frame the list is there');
      assert.deepEqual(withList.filter((f) => f.frame !== f.listFrame).map((f) => `${f.frame} beside ${f.listFrame}`).slice(0, 3), [], 'the box\'s frame is the list\'s in every frame the list is there');
      assert.deepEqual([...new Set(frames.map((f) => f.away.join(' ')))], ['6px 6px'], 'the corners away from the list never change');
      const last = frames[frames.length - 1];
      assert.deepEqual([last.list, last.byList.join(' ')], [false, '6px 6px'], 'the list gone: the box round again');
      // Nothing of it eases a corner (it would curve while the list still hangs there).
      assert.equal(await page.$eval(sel, (el) => getComputedStyle(el).transitionProperty.includes('border-radius') || getComputedStyle(el).transitionProperty === 'all'), false);
    });
  }
}

// The owner (2026-11-26), of the same list: "scrolling up with the dropdown overlay it on top of the
// navbar / and certain zoomlevels dont make the alignment pixelperfect / and the connection border
// doesnt seem to look seamless". Three things, each measured before it was changed:
//  - The list stood over everything (as a dialog's must), so a list hung off a box in the page stayed
//    over the header while its box went behind it. In the page's flow it now stands under the header.
//  - The seam was the list's own top line, in another colour than its sides: it ran across the outline's
//    two side lines, a darker pixel in each at the join. It is now the rows' line, inside the outline.
//  - At a zoom where a CSS pixel is no whole number of device pixels, the browser paints the box's right
//    edge at round(left + width) and the list's, a layer of its own, at round(left) + round(width): one
//    device pixel apart for some widths (8 of 40 zooms and widths measured, all at 150% and 175%). The
//    list's edges are now rounded in device pixels as the box's are painted.
// The last two are read from the picture the browser draws, in a browser at a true device scale (what
// its own zoom does; the viewport's emulated scale blurs every line, the box's too).
const scaled = (zoom) => puppeteer.launch({ executablePath: chromePath(), headless: true, defaultViewport: null,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', `--force-device-scale-factor=${zoom}`, '--window-size=1301,900'] });
const FRAME = '82,82,92';   // the outline with its list showing (border-border-hover)
// In a blank page: the picture's pixels, and what the outline is in it. The picture starts 6 CSS px left
// of the box and 4 above it.
async function outline({ png, boxBottom, listTop, dpr, frame }) {
  const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
  const canvas = new OffscreenCanvas(bmp.width, bmp.height), ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const at = (col, row) => { const i = (row * px.width + col) * 4; return `${px.data[i]},${px.data[i + 1]},${px.data[i + 2]}`; };
  const lines = (row) => { let l = -1, r = -1; for (let col = 0; col < px.width; col++) if (at(col, row) === frame) { if (l < 0) l = col; r = col; } return [l, r]; };
  const inBox = Math.round(boxBottom * dpr) - Math.round(8 * dpr), inList = Math.round(listTop * dpr) + Math.round(10 * dpr);
  const box = lines(inBox), list = lines(inList);
  const down = (col) => { const seen = []; for (let row = inBox; row <= inList; row++) { const c = at(col, row); if (seen[seen.length - 1] !== c) seen.push(c); } return seen; };
  // (Down the middle, from inside the box to the list's own padding over its first row.)
  const mid = Math.round(px.width / 2), join = [], padding = Math.round(listTop * dpr) + Math.round(3 * dpr);
  for (let row = inBox; row <= padding; row++) { const c = at(mid, row); if (join[join.length - 1] !== c) join.push(c); }
  return { box, list, leftSide: down(box[0]), rightSide: down(box[1]), join };
}

for (const zoom of [1.25, 1.5, 1.75]) {
  test(`at ${zoom * 100}% the list's outline is the box's to the device pixel, its sides unbroken across the join, the seam one line inside them`, async (t) => {
    if (!chromePath()) return t.skip('Chrome not found (set CHROME_PATH)');
    const own = await scaled(zoom);
    t.after(() => own.close());
    const lab = await own.newPage();
    await lab.goto('about:blank');
    const page = await own.newPage();
    await page.setBypassServiceWorker(true);
    await page.goto(`${origin}/components`, { waitUntil: 'load' });
    const sel = spec('sort-select', 'toolbar');
    await page.waitForSelector(sel);
    await page.bringToFront();
    assert.equal(await page.evaluate(() => devicePixelRatio), zoom, 'the browser is at the scale asked for');
    // The box nudged across a device pixel in steps, so its edges fall every way between two.
    const found = [];
    for (const nudge of [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
      await page.$eval(sel, (el, nudge) => { el.parentElement.style.marginLeft = `${nudge}px`; el.scrollIntoView({ block: 'center', behavior: 'instant' }); }, nudge);
      const at = await page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.click(at.x, at.y);
      await until(page, () => { const l = document.querySelector('[data-slot="select-list"]'); return !!l && l.getClientRects().length > 0 && l.getAnimations().length === 0 && !l.hasAttribute('data-starting-style'); }, null, { what: 'the list unrolled' });
      await page.mouse.move(3, 3);
      const geo = await page.$eval(sel, (el) => {
        const b = el.getBoundingClientRect(), l = document.querySelector('[data-slot="select-list"]').getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, bottom: b.bottom, listTop: l.top, sx: scrollX, sy: scrollY };
      });
      const clip = { x: Math.floor(geo.x) - 6, y: Math.floor(geo.y) - 4, width: Math.ceil(geo.w) + 12, height: 90 };
      const png = await page.screenshot({ clip: { ...clip, x: clip.x + geo.sx, y: clip.y + geo.sy }, encoding: 'base64' });
      const seen = await lab.evaluate(outline, { png, boxBottom: geo.bottom - clip.y, listTop: geo.listTop - clip.y, dpr: zoom, frame: FRAME });
      assert.ok(seen.box[0] >= 0 && seen.box[1] > seen.box[0], `the box ${nudge}px along: its outline found in the picture`);
      found.push({ nudge, ...seen });
      await page.keyboard.press('Escape');
      await until(page, () => !document.querySelector('[data-slot="select-list"]')?.getClientRects().length, null, { what: 'the list gone' });
    }
    // (Each thing over every place the box was put, so one fault does not hide another.)
    assert.deepEqual(found.filter((f) => String(f.list) !== String(f.box)).map((f) => `the box ${f.nudge}px along: its lines at ${f.box}, the list's at ${f.list}`), [],
      'the list\'s side lines are in the box\'s own columns of device pixels');
    assert.deepEqual(found.filter((f) => String([f.leftSide, f.rightSide]) !== String([[FRAME], [FRAME]])).map((f) => `the box ${f.nudge}px along: ${f.leftSide.join(' then ')}`), [],
      'each side line is one colour from box to list');
    assert.deepEqual(found.filter((f) => f.join.length !== 3).map((f) => `the box ${f.nudge}px along: ${f.join.join(' | ')}`), [],
      'between the box\'s ground and the list\'s, one line of one colour');
  });
}

// A list drawn, past its first frame, nothing of it moving (one still unrolling is clipped: a point over
// it finds its place, not it; a closed one stays in the page, not drawn).
const UNROLLED = () => {
  const l = [...document.querySelectorAll('[data-slot="select-list"]')].find((el) => el.getClientRects().length);
  return !!l && !l.hasAttribute('data-starting-style') && l.getAnimations().length === 0 && !getComputedStyle(l).clipPath.includes('100%');
};

test('a list hung off a box in the page goes behind the header with its box as the page scrolls; the header\'s own list stays over it', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const sel = spec('sort-select', 'toolbar');
  const at = await centreOf(page, sel);
  await page.mouse.click(at.x, at.y);
  await until(page, UNROLLED, null, { what: 'the list unrolled' });
  // The page scrolled until the box's bottom is 10px under the header's: the list's first rows are
  // then where the header is.
  await page.evaluate((sel) => {
    const header = document.querySelector('.app-header').getBoundingClientRect();
    scrollBy({ top: document.querySelector(sel).getBoundingClientRect().bottom - (header.bottom - 10), behavior: 'instant' });
  }, sel);
  await until(page, () => document.querySelector('[data-slot="select-list"]').getBoundingClientRect().top < document.querySelector('.app-header').getBoundingClientRect().bottom - 4, null, { what: 'the list under the header' });
  const over = await page.evaluate(() => {
    const list = document.querySelector('[data-slot="select-list"]'), l = list.getBoundingClientRect(), h = document.querySelector('.app-header').getBoundingClientRect();
    const x = l.left + l.width / 2, inHeader = document.elementFromPoint(x, h.bottom - 4), belowIt = document.elementFromPoint(x, h.bottom + 12);
    return {
      open: list.getClientRects().length > 0, listTop: l.top, headerBottom: h.bottom,
      inHeader: !!inHeader?.closest('.app-header'), belowIt: !!belowIt?.closest('[data-slot="select-list"]'),
      z: [getComputedStyle(list.parentElement).zIndex, getComputedStyle(document.querySelector('.app-header')).zIndex],
    };
  });
  assert.equal(over.open, true, 'the list stays open as the page scrolls');
  assert.ok(over.listTop < over.headerBottom - 4, 'the list reaches under the header');
  assert.deepEqual([over.inHeader, over.belowIt], [true, true], `where they overlap the header is on top; below the header the list shows (${JSON.stringify(over)})`);
  assert.ok(Number(over.z[0]) < Number(over.z[1]), `the list's level is under the header's (${over.z.join(' < ')})`);
  await page.keyboard.press('Escape');

  // The header's own menu (a page of the app: /components has headers drawn in the page as specimens,
  // and those are of the page's flow): over the header and everything else.
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.waitForSelector('.app-header #pageNav');
  await page.click('.app-header #pageNav');
  await until(page, UNROLLED, null, { what: 'the page menu\'s list' });
  const menu = await page.evaluate(() => {
    const list = [...document.querySelectorAll('[data-slot="select-list"]')].find((el) => el.getClientRects().length), l = list.getBoundingClientRect();
    return { z: [getComputedStyle(list.parentElement).zIndex, getComputedStyle(document.querySelector('.app-header')).zIndex], top: !!document.elementFromPoint(l.left + l.width / 2, l.top + 12)?.closest('[data-slot="select-list"]') };
  });
  assert.ok(Number(menu.z[0]) > Number(menu.z[1]) && menu.top, `the header's menu is over the header (${menu.z.join(' > ')})`);
});

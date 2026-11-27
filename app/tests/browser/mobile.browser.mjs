import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage } from './harness.mjs';

// The library and the series overview on a phone: laid out at its own width, every row fitting it,
// buttons big enough for a finger; and a finger on a cover scrolls rather than merging galleries. The
// library is the one page's (/library; until 2026-11-25 these held 1.3's page).
const LIBRARY = '/library';
const OVERVIEW = '/overview';
const SERIES = ['1790000000711', '1790000000712', '1790000000713'];
const SINGLES = ['1790000000721', '1790000000722', '1790000000723'];
const PHONE = { width: 390, height: 844, hasTouch: true, isMobile: true };
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async ({ series, singles }) => {
    const api = await import('/app/js/api.js');
    const title = english => ({ english, japanese: '', pretty: '' });
    const canvas = new OffscreenCanvas(300, 430);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#888';
    ctx.fillRect(0, 0, 300, 430);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    for (const [k, gid] of series.entries()) {
      await api.meta.put({ galleryId: gid, title: title(`A chapter with a long enough title ${k + 1}`), tags: [], numPages: 3 });
      for (let n = 1; n <= 3; n++) await api.pages.put(gid, n, blob);
    }
    await api.series.write(series[0], series.map((id, k) => ({ id, title: `Part ${k + 1}`, number: k + 1 })), { seriesTitle: title('Phone fixture'), seriesTags: [] });
    for (const gid of singles) {
      await api.meta.put({ galleryId: gid, title: title(`Single ${gid}`), tags: [], numPages: 2 });
      for (let n = 1; n <= 2; n++) await api.pages.put(gid, n, blob);
    }
  }, { series: SERIES, singles: SINGLES });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

async function phone(t, path, viewport = PHONE) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.setViewport(viewport);
  await page.goto(origin + path, { waitUntil: 'load' });
  return page;
}
const box = (page, sel) => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
const fitsWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('on a phone the library fits its width: the search on a row of its own, two cards to a row', { skip: !chromePath() }, async t => {
  const page = await phone(t, LIBRARY);
  await page.waitForSelector('.card');
  assert.equal(await page.evaluate(() => innerWidth), 390, 'laid out at the phone\'s width');
  assert.equal(await fitsWidth(page), true, 'nothing wider than the screen');
  const search = await box(page, '.search-wrap'), brand = await box(page, '.brand-wrap'), settings = await box(page, '#settingsBtn');
  assert.ok(search.top >= brand.bottom && search.width > 340, `the search under the bar, the screen's width: ${JSON.stringify(search)}`);
  assert.ok(Math.abs(settings.top - brand.top) < 20, 'the logo and the buttons share the first row');
  const cards = await page.$$eval('.card', cs => cs.slice(0, 2).map(c => { const r = c.getBoundingClientRect(); return [r.left, r.top, r.width]; }));
  assert.ok(cards[0][1] === cards[1][1] && cards[0][0] < cards[1][0], 'two cards side by side');
});

test('on a touch screen a library card is for opening: no quick actions, and a tap grows nothing; a mouse has both', { skip: !chromePath() }, async t => {
  const page = await phone(t, LIBRARY);
  await page.waitForSelector('.card + .card');
  const hidden = () => page.$$eval('.card', cs => cs.map(c => ['.card-actions', '.card-tag-add', '.card-fav']
    .map(s => getComputedStyle(c.querySelector(s)).display).join()));
  assert.ok((await hidden()).every(d => d === 'none,none,none'), `no quick actions, '+' tag or heart: ${await hidden()}`);
  // A tap on a card's text (not its cover, which opens it) leaves it hovered, as a phone does: it grows nothing.
  const card = await page.$('.card + .card');
  const size = () => card.evaluate(c => [c.getBoundingClientRect().height, getComputedStyle(c).marginBottom, c.querySelector('.card-title').getBoundingClientRect().height].join());
  const before = await size();
  const meta = await box(page, '.card + .card .card-meta');
  await page.touchscreen.tap(meta.left + 4, meta.top + meta.height / 2);
  await new Promise(r => setTimeout(r, 450));
  assert.equal(await card.evaluate(c => c.matches(':hover')), true, 'the tap left it hovered');
  assert.equal(await size(), before, 'and it stayed as it was');

  // With a mouse, a hovered card grows and shows its actions.
  const desk = await phone(t, LIBRARY, { width: 1280, height: 900 });
  await desk.waitForSelector('.card + .card');
  await desk.hover('.card + .card .card-meta');
  await new Promise(r => setTimeout(r, 450));
  assert.deepEqual(await desk.$eval('.card + .card', c => [getComputedStyle(c.querySelector('.card-actions')).display, getComputedStyle(c.querySelector('.card-actions')).opacity, getComputedStyle(c).marginBottom]),
    ['flex', '1', '-10000px']);
});

test('a finger on a cover scrolls the library: it never starts merging galleries; a mouse still does', { skip: !chromePath() }, async t => {
  const page = await phone(t, LIBRARY);
  await page.waitForSelector('.card + .card + .card');
  const [from, to] = await page.$$eval('.card .card-thumb-wrap', ws => [ws[0], ws[2]].map(w => { const r = w.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
  // A finger pressed on a cover and drawn down onto the card below, a step at a time (sideways, the
  // phone's browser would take it as a swipe back through the history).
  await page.touchscreen.touchStart(from.x, from.y);
  for (let k = 1; k <= 8; k++) await page.touchscreen.touchMove(from.x + (to.x - from.x) * k / 8, from.y + (to.y - from.y) * k / 8);
  assert.equal(await page.$('.card-drag-clone'), null, 'no card lifted under the finger');
  await page.touchscreen.touchEnd();
  assert.equal(await page.$('dialog[open], [data-notice="dialog"]'), null, 'no merge asked for');
  // A mouse, on a desktop window: the drag still lifts the card.
  const desk = await phone(t, LIBRARY, { width: 1280, height: 900 });
  await desk.waitForSelector('.card + .card');
  const [a, b] = await desk.$$eval('.card .card-thumb-wrap', ws => ws.slice(0, 2).map(w => { const r = w.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
  await desk.mouse.move(a.x, a.y);
  await desk.mouse.down();
  await desk.mouse.move(b.x, b.y, { steps: 8 });
  assert.notEqual(await desk.$('.card-drag-clone'), null, 'the mouse lifts the card');
  await desk.mouse.move(a.x, a.y, { steps: 4 });
  await desk.mouse.up();
});

test("on a phone a chapter's buttons take a line under it, so its title has the row's width", { skip: !chromePath() }, async t => {
  const page = await phone(t, `${OVERVIEW}?g=${SERIES[0]}`);
  await page.waitForSelector('.ch-row .ch-actions button');
  assert.equal(await fitsWidth(page), true, 'nothing wider than the screen');
  const row = await page.$('.ch-row');
  const { title, meta, actions, head } = await row.evaluate(r => Object.fromEntries(
    [['title', '.ch-title-wrap'], ['meta', '.ch-meta'], ['actions', '.ch-actions'], ['head', '.ch-head']]
      .map(([k, s]) => { const b = r.querySelector(s).getBoundingClientRect(); return [k, { top: b.top, bottom: b.bottom, right: b.right, height: b.height, width: b.width }]; })));
  assert.ok(actions.top >= meta.bottom - 1, 'the buttons under the title and its pages');
  assert.ok(meta.height < 20, `the pages on one line: ${meta.height}px`);
  assert.ok(head.right - actions.right <= 70, 'on the right (the expand button after them)');
});

test('on a touch screen the library\'s and the overview\'s buttons are big enough for a finger', { skip: !chromePath() }, async t => {
  const page = await phone(t, LIBRARY);
  await page.waitForSelector('.card');
  const sizes = await page.evaluate(() => ['#settingsBtn', '#safeBtn', '#uploadCbzBtn'].map(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return [s, Math.round(r.width), Math.round(r.height)];
  }));
  for (const [sel, w, h] of sizes) assert.ok(w >= 36 && h >= 36, `${sel} is ${w}×${h}`);
  const ov = await phone(t, `${OVERVIEW}?g=${SERIES[0]}`);
  await ov.waitForSelector('.ch-row .ch-actions .ch-ibtn');
  const btn = await box(ov, '.ch-row .ch-actions .ch-ibtn');
  assert.deepEqual([btn.width, btn.height], [40, 40]);
});

test('a finger raises no tooltip, and a touch puts one away; a mouse still shows them', { skip: !chromePath() }, async t => {
  const page = await phone(t, LIBRARY, { width: 600, height: 800, hasTouch: true });
  await page.waitForSelector('.card');
  // Any control with a tip will do: the tooltip is one for the whole app.
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'tipProbe'; b.dataset.tip = 'A tip';
    Object.assign(b.style, { position: 'fixed', left: '200px', top: '300px', width: '80px', height: '40px', zIndex: 999 });
    document.body.append(b);
  });
  const tipShown = () => page.evaluate(() => { const tip = document.querySelector('.shiori-tip'); return !!tip && getComputedStyle(tip).display !== 'none' && tip.textContent; });
  await page.touchscreen.tap(240, 320);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await tipShown(), false, 'no tip after a tap');
  await page.mouse.move(230, 315);
  await page.mouse.move(240, 320);
  assert.equal(await tipShown(), 'A tip', 'a mouse over it shows it');
  await page.touchscreen.tap(100, 600);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await tipShown(), false, 'a touch elsewhere puts it away');
});

// 9e: a dialog's corner X (28px drawn) and a switch (36×20) take a press 44px square around them under a
// finger, by an area of their own: what is drawn and where is as with a mouse, and every other control
// beside them still takes a press at its own centre. With a mouse, the press is the box drawn.
// The hit area of `sel`: how far from its centre the point still finds it, each way (to 60px), and its box.
function hitArea(sel) {
  const el = document.querySelector(sel);
  const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const mine = (x, y) => { const at = document.elementFromPoint(x, y); return !!at && (at === el || el.contains(at)); };
  const reach = (dx, dy) => { let n = 0; for (let s = 1; s <= 60 && mine(cx + dx * s, cy + dy * s); s++) n = s; return n; };
  // The controls beside it: those of its dialog, or of its panel (the page behind a dialog is under it).
  const around = el.closest('[data-slot="dialog"], [role="tabpanel"]') || document;
  const others = [...around.querySelectorAll('button, a[href], input, select, [role="switch"], [role="tab"]')].filter((o) => o !== el && !el.contains(o)).filter((o) => {
    const b = o.getBoundingClientRect();
    return b.width > 2 && b.height > 2 && b.top >= 0 && b.bottom <= innerHeight && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) !== null;
  });
  const stolen = others.filter((o) => { const b = o.getBoundingClientRect(); return mine(b.left + b.width / 2, b.top + b.height / 2); }).map((o) => o.id || o.textContent.trim().slice(0, 20));
  return { hit: [reach(-1, 0) + reach(1, 0) + 1, reach(0, -1) + reach(0, 1) + 1], box: [r.width, r.height, r.left, r.top], stolen };
}

test('under a finger a dialog\'s corner X and a switch take a 44px press, drawn as with a mouse; a mouse presses their box', { skip: !chromePath() }, async t => {
  for (const finger of [true, false]) {
    const page = await phone(t, '/settings', finger ? PHONE : { width: 390, height: 844 });
    await page.waitForSelector('[data-slot="switch"]');
    const sw = `#panelLibrary [data-slot="switch"]`;
    const switches = await page.$$eval(sw, (all) => all.map((s, i) => { s.dataset.probe = String(i); return i; }));
    assert.ok(switches.length >= 3, 'the Library panel has its switches');
    for (const i of switches) {
      await page.$eval(`[data-probe="${i}"]`, (el) => el.scrollIntoView({ block: 'center' }));
      const a = await page.evaluate(hitArea, `[data-probe="${i}"]`);
      assert.deepEqual(a.box.slice(0, 2), [36, 20], `switch ${i} drawn 36×20`);
      assert.deepEqual(a.hit, finger ? [44, 44] : [36, 20], `switch ${i}'s press`);
      assert.deepEqual(a.stolen, [], `switch ${i} takes no other control's press`);
    }
    await page.click('#aboutBtn');
    await page.waitForSelector('#aboutClose');
    const x = await page.evaluate(hitArea, '#aboutClose');
    assert.deepEqual(x.box.slice(0, 2), [28, 28], 'the X drawn 28px');
    assert.deepEqual(x.hit, finger ? [40, 44] : [28, 28], 'the X\'s press');
    assert.deepEqual(x.stolen, [], 'the X takes no other control\'s press');
    // About's GitHub link, 4px before the X: its own press whole, the X's area beside it (40 wide there).
    assert.deepEqual((await page.evaluate(hitArea, '#aboutRepo')).hit, [28, 28], 'the link beside the X keeps its press');
  }
});

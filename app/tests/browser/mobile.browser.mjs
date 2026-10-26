import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage } from './harness.mjs';

// The library and the series overview on a phone: laid out at its own width, every row fitting it,
// buttons big enough for a finger; and a finger on a cover scrolls rather than merging galleries.
const SERIES = ['1790000000711', '1790000000712', '1790000000713'];
const SINGLES = ['1790000000721', '1790000000722', '1790000000723'];
const PHONE = { width: 390, height: 844, hasTouch: true, isMobile: true };
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/library`, { waitUntil: 'load' });
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
  const page = await phone(t, '/library');
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
  const page = await phone(t, '/library');
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
  const desk = await phone(t, '/library', { width: 1280, height: 900 });
  await desk.waitForSelector('.card + .card');
  await desk.hover('.card + .card .card-meta');
  await new Promise(r => setTimeout(r, 450));
  assert.deepEqual(await desk.$eval('.card + .card', c => [getComputedStyle(c.querySelector('.card-actions')).display, getComputedStyle(c.querySelector('.card-actions')).opacity, getComputedStyle(c).marginBottom]),
    ['flex', '1', '-10000px']);
});

test('a finger on a cover scrolls the library: it never starts merging galleries; a mouse still does', { skip: !chromePath() }, async t => {
  const page = await phone(t, '/library');
  await page.waitForSelector('.card + .card + .card');
  const [from, to] = await page.$$eval('.card .card-thumb-wrap', ws => [ws[0], ws[2]].map(w => { const r = w.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
  // A finger pressed on a cover and drawn down onto the card below, a step at a time (sideways, the
  // phone's browser would take it as a swipe back through the history).
  await page.touchscreen.touchStart(from.x, from.y);
  for (let k = 1; k <= 8; k++) await page.touchscreen.touchMove(from.x + (to.x - from.x) * k / 8, from.y + (to.y - from.y) * k / 8);
  assert.equal(await page.$('.card-drag-clone'), null, 'no card lifted under the finger');
  await page.touchscreen.touchEnd();
  assert.equal(await page.$('.modal-overlay.show, dialog[open]'), null, 'no merge asked for');
  // A mouse, on a desktop window: the drag still lifts the card.
  const desk = await phone(t, '/library', { width: 1280, height: 900 });
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
  const page = await phone(t, `/overview?g=${SERIES[0]}`);
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
  const page = await phone(t, '/library');
  await page.waitForSelector('.card');
  const sizes = await page.evaluate(() => ['#settingsBtn', '#safeBtn', '#uploadCbzBtn'].map(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return [s, Math.round(r.width), Math.round(r.height)];
  }));
  for (const [sel, w, h] of sizes) assert.ok(w >= 36 && h >= 36, `${sel} is ${w}×${h}`);
  const ov = await phone(t, `/overview?g=${SERIES[0]}`);
  await ov.waitForSelector('.ch-row .ch-actions .ch-ibtn');
  const btn = await box(ov, '.ch-row .ch-actions .ch-ibtn');
  assert.deepEqual([btn.width, btn.height], [40, 40]);
});

test('a finger raises no tooltip, and a touch puts one away; a mouse still shows them', { skip: !chromePath() }, async t => {
  const page = await phone(t, '/library', { width: 600, height: 800, hasTouch: true });
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

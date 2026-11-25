// overview-phone.browser.mjs — the overview on a phone (a touch screen, a coarse pointer, no hover),
// the one page's (/overview-next) held to what 1.3's (/overview) gave driven alike over one seeded
// library (overview-drive.mjs). At 390 and 600 wide: a series (its chapters, its volumes),
// a gallery, edit mode and a row's pages open, every part's box within a pixel, the same words, the same
// text sizes, the same targets for a finger (a row's buttons and the header's Settings 40px, the hero's
// buttons 34, the grip 14 × 30, the view tabs 32 tall). No sideways scroll at any width from 320 to 640,
// the boxes alike at each. A finger: a tap does what a click does (the heart, an arrow, a row's pages,
// Edit), a press with no Shift gives what 1.3 gives a finger (Replace where nothing can download, else
// nothing of Shift's), the re-run menu from a long press (the browser's context menu), no tip left
// showing; the grip dragged by a finger, as 1.3's (the page still under it, the order written as 1.3
// writes it; scrolled at the window's foot), a finger elsewhere on a row scrolling the page and dragging
// nothing; what a press opens (the delete's question, the tag editor, the re-run menu) inside the window,
// every button in reach; the add list with the on-screen keyboard's room taken (a window 500 tall).
// (§5.3 F18: the heading's weight 700 → 600 and its count 1.1px nearer; F69: the add list a popup.)
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the overview's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { readDialog, answer } from './library-drive.mjs';
import { record } from './records.mjs';
import { openRun, nextBase, gid, visit, read, boxes, boxDiff, named, outcome, rowSel, sleep, NEW } from './overview-drive.mjs';

const FILE = basename(fileURLToPath(import.meta.url));
const PHONE = { width: 390, height: 844, hasTouch: true, isMobile: true };
let server, origin, browser, page, base;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  base = nextBase(1790009400000);
  page = await openRun(browser, origin, base);
});
after(async () => { await browser?.close(); server?.close(); });

const F18 = (diffs) => diffs.filter((d) => !/^\.count: /.test(d));
// The component's own classes on a tag pressed in edit mode are not 1.3's: its words, link and tip are.
const plainRead = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'cls' ? undefined : v)));

// In the page: text sizes, and what a finger is given to press.
function finger() {
  const f = (sel) => { const el = document.querySelector(sel); if (!el) return null; const s = getComputedStyle(el); return `${s.fontSize}/${s.lineHeight}`; };
  const size = (el) => { const r = el.getBoundingClientRect(); return `${+r.width.toFixed(1)}×${+r.height.toFixed(1)}`; };
  return {
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth, coarse: matchMedia('(pointer: coarse)').matches, hover: matchMedia('(hover: hover)').matches,
    text: { title: f('.series-title-input'), sub: f('#ovSubtitle'), button: f('.series-actions > *'), meta: f('.ov-meta-item'), tag: f('.ov-chip'), label: f('.ov-tag-label'),
      section: f('#ovSection'), num: f('.ch-num'), rowTitle: f('.ch-row .ch-title-input, .ch-row [data-slot="inline-edit"]'), rowMeta: f('.ch-meta'),
      addHeading: f('#addHeading'), addBox: f('#addSearch'), hint: f('.add-hint'), pageNum: f('.ov-page-num') },
    targets: {
      settings: size(document.getElementById('settingsBtn')),
      hero: [...document.querySelectorAll('.series-actions > *')].filter((b) => b.getClientRects().length).map((b) => `${b.id} ${Math.round(b.getBoundingClientRect().height)}`),
      tabs: [...document.querySelectorAll('#ovSection [data-view]')].map(size),
      row: [...document.querySelectorAll('.ch-row:first-child :is(.ch-actions > button, .ch-expand)')].filter((b) => b.getClientRects().length)
        .map((b) => `${size(b)} ${getComputedStyle(b.closest('.ch-actions') ?? b).opacity}`),
      grip: [...document.querySelectorAll('.ch-row:first-child .ch-grip')].map((g) => `${size(g)} ${getComputedStyle(g).opacity}`),
    },
  };
}

const views = {
  volumes: async (p) => { await p.tap('#ovSection [data-view="volumes"]'); await until(p, () => document.querySelectorAll('.ch-row').length === 2 && [...document.querySelectorAll('.ch-row .ch-thumb img')].length === 2, null, { what: 'the volumes' }); await sleep(300); },
  edit: async (p) => { await p.tap('#editToggle'); await until(p, () => !!document.querySelector('#ovContent.ov-editing'), null, { what: 'edit mode' }); await sleep(300); },
  pages: async (p) => {
    await p.$eval('.ch-row:nth-child(2)', (el) => el.scrollIntoView({ block: 'center' }));
    await p.tap('.ch-row:nth-child(2) [data-expand]');
    await until(p, () => document.querySelectorAll('.ch-row:nth-child(2) .ch-pages .ov-page').length === 2
      && [...document.querySelectorAll('.ch-row:nth-child(2) .ch-pages .ov-page img')].every((img) => img.getAttribute('src') && img.complete), null, { what: 'the chapter\'s pages' });
    await p.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
  },
};

async function shown(part, { viewport = PHONE, then } = {}) {
  await page.setViewport(viewport);
  await page.evaluate(() => localStorage.removeItem('shiori:seriesView'));
  await visit(page, origin, NEW, gid(base, part));
  if (then) await then(page);
  return { read: plainRead(named(await page.evaluate(read), base)), boxes: await page.evaluate(boxes), finger: await page.evaluate(finger) };
}

for (const width of [390, 600]) {
  for (const [name, part, then] of [['a series', 'S'], ['its volumes', 'S', views.volumes], ['a gallery', 'G'], ['edit mode', 'S', views.edit], ['a row\'s pages open', 'S', views.pages]]) {
    test(`on a phone ${width} wide, ${name}: every part's box, the words, the text sizes and a finger's targets as 1.3's`, { skip: !chromePath() }, async () => {
      const now = await shown(part, { viewport: { ...PHONE, width }, then });
      const was = record(FILE, 'form', `${width} ${name}`);
      assert.deepEqual(F18(boxDiff(was.boxes, now.boxes, 1)), []);
      assert.deepEqual(now.read, was.read);
      // F18: the heading's weight (600 for 700); its size and line as 1.3's.
      assert.deepEqual(now.finger, was.finger);
      assert.equal(was.finger.sideways, false);
      assert.deepEqual([was.finger.coarse, was.finger.hover], [true, false]);
      if (part === 'S') {
        assert.equal(was.finger.targets.settings, '40×40');
        assert.ok(was.finger.targets.row.every((r) => r.startsWith('40×40 1')), JSON.stringify(was.finger.targets.row));
        assert.deepEqual(was.finger.targets.grip, ['14×30 1']);
      }
    });
  }
}

test('no sideways scroll at any width from 320 to 640, as on 1.3\'s page, a series and a gallery; every box alike at each', { skip: !chromePath() }, async () => {
  const widths = Array.from({ length: 17 }, (_, i) => 320 + i * 20);
  for (const part of ['S', 'G']) {
    const now = [];
    await page.setViewport({ ...PHONE, width: 320 });
    await visit(page, origin, NEW, gid(base, part));
    for (const width of widths) {
      await page.setViewport({ ...PHONE, width });
      await sleep(150);
      now.push({ width: await page.evaluate(() => innerWidth), sideways: await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), boxes: await page.evaluate(boxes) });
    }
    const kept = record(FILE, 'widths', part);
    for (const [i, width] of widths.entries()) {
      const [was, at] = [kept[i], now[i]];
      assert.equal(at.width, width);
      assert.equal(was.sideways, false, `1.3's at ${width}`);
      assert.equal(at.sideways, false, `at ${width}`);
      assert.deepEqual(F18(boxDiff(was.boxes, at.boxes, 1)), [], `${part} at ${width}`);
    }
  }
});

// What a finger does on each page: what the library holds and what shows after each tap.
async function taps(path) {
  await page.setViewport(PHONE);
  await visit(page, origin, path, gid(base, 'S'));
  const shown = async () => page.evaluate(() => ({ tips: [...document.querySelectorAll('.shiori-tip')].filter((t) => getComputedStyle(t).display !== 'none' && getComputedStyle(t).visibility !== 'hidden' && getComputedStyle(t).opacity !== '0').length,
    fav: document.getElementById('favToggle').getAttribute('aria-pressed') ?? String(document.getElementById('favToggle').classList.contains('on')),
    editing: !!document.querySelector('#ovContent.ov-editing'), open: [...document.querySelectorAll('.ch-row.expanded')].map((r) => r.dataset.chapterId),
    order: [...document.querySelectorAll('.ch-row')].map((r) => r.dataset.chapterId) }));
  const r = {};
  const tap = async (sel, what) => { await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' })); await sleep(150); await page.tap(sel); await sleep(600); r[what] = named(await shown(), base); };
  await tap('#favToggle', 'heart');
  await tap(`${rowSel(base, 'S3')} [data-up]`, 'up');
  await tap(`${rowSel(base, 'S2')} [data-expand]`, 'pages');
  await tap('#editToggle', 'edit');
  await tap('#editToggle', 'done');
  // What a finger is told a press does, Shift's faces (a finger has no Shift): the tips, with and without one.
  r.faces = named(await page.evaluate(() => [...document.querySelectorAll('.ch-row:not(.missing) .ch-actions > button')].map((b) => [b.closest('.ch-row').dataset.chapterId, b.dataset.tip ?? null, b.dataset.tipShift ?? null])), base);
  r.library = (await outcome(page, base)).series;
  // Put back what was changed (the heart, the order) for the cases after.
  await page.$eval('#favToggle', (el) => el.scrollIntoView({ block: 'center' }));
  await page.tap('#favToggle'); await sleep(400);
  await page.tap(`${rowSel(base, 'S3')} [data-down]`); await sleep(600);
  return r;
}

test('a finger: a tap does what a click does, and the tips Shift\'s faces give, as 1.3\'s', { skip: !chromePath() }, async () => {
  const now = await taps(NEW);
  const was = record(FILE, 'taps');
  assert.deepEqual(now, was);
  assert.equal(was.heart.fav, 'true');
  assert.deepEqual(was.pages.open, ['<S2>']);
  assert.deepEqual([was.edit.editing, was.done.editing], [true, false]);
  assert.ok(Object.values(was).filter((v) => v.tips != null).every((v) => v.tips === 0), 'no tip left showing after a tap');
});

// The re-run menu: a long press gives the browser's context menu event on a phone, as a right click does.
test('the re-run menu from a long press on a translated chapter\'s translate button: inside the window, its steps as 1.3\'s', { skip: !chromePath() }, async () => {
  let now;
  {
    await page.setViewport(PHONE);
    await visit(page, origin, NEW, gid(base, 'S'));
    const sel = `${rowSel(base, 'S3')} [data-translate]`;
    await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' }));
    await sleep(200);
    await page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 2 })); });
    await until(page, () => [...document.querySelectorAll('.rerun-menu')].some((m) => m.getClientRects().length && m.querySelectorAll('[role="menuitem"], .ctx-menu-item').length), null, { what: 'the menu' });
    await sleep(300);
    now = await page.evaluate(() => {
      const m = [...document.querySelectorAll('.rerun-menu')].find((el) => el.getClientRects().length);
      const r = m.getBoundingClientRect();
      return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, steps: [...m.querySelectorAll('[role="menuitem"], .ctx-menu-item')].map((i) => i.textContent.replace(/\s+/g, ' ').trim()) };
    });
    await page.keyboard.press('Escape');
    await sleep(300);
  }
  const was = record(FILE, 'menu');
  assert.deepEqual(now, was);
  assert.equal(was.inside, true);
});

// A finger on the grip: the row follows it, the page stays still under it, and the drop is written as
// 1.3 writes it; near the window's foot the page scrolls on. A finger elsewhere on a row scrolls the page.
async function fingerDrag(path) {
  await page.setViewport({ ...PHONE, height: 600 });
  await visit(page, origin, path, gid(base, 'S'));
  const seeded = await page.evaluate(async (s) => (await (await import('/app/js/api.js')).meta.get(s)).chapters, gid(base, 'S'));
  const cdp = await page.createCDPSession();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  await page.$eval('.ch-row:nth-child(1)', (el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -60));
  await sleep(300);
  await page.evaluate(() => { window.__seen = { dragging: false }; new MutationObserver(() => { if (document.querySelector('.ch-row.dragging, .ch-row[data-dragging]')) window.__seen.dragging = true; }).observe(document.getElementById('ovContent'), { attributes: true, subtree: true }); });
  const r = {};
  // A finger on a row's words, moved down the window: the page scrolls back up, no row is dragged.
  const meta = await page.$eval('.ch-row:nth-child(2) .ch-meta', (el) => { const b = el.getBoundingClientRect(); return { x: b.x + 4, y: b.y + b.height / 2 }; });
  const y0 = await page.evaluate(() => scrollY);
  await touch('touchStart', [{ x: meta.x, y: meta.y }]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: meta.x, y: meta.y + 12 * i }]); await sleep(20); }
  await touch('touchEnd', []);
  await sleep(400);
  r.scrolled = (await page.evaluate(() => scrollY)) < y0;
  r.draggedByWords = await page.evaluate(() => window.__seen.dragging);
  await page.evaluate((y) => window.scrollTo(0, y), y0);
  await sleep(300);
  // The grip of the second row (the first is the series' owner: ownership would move), held and moved
  // down past the third.
  const grip = await page.$eval('.ch-row:nth-child(2) .ch-grip', (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  const h = await page.$eval('.ch-row:nth-child(2)', (el) => el.getBoundingClientRect().height + 6);
  const sy = await page.evaluate(() => scrollY);
  await touch('touchStart', [{ x: grip.x, y: grip.y }]);
  for (let i = 1; i <= 12; i++) { await touch('touchMove', [{ x: grip.x, y: grip.y + (h * 1.5) * i / 12 }]); await sleep(25); }
  await sleep(200);
  r.mid = await page.evaluate(() => ({ dragging: !!document.querySelector('.ch-row.dragging, .ch-row[data-dragging]') }));
  r.stillUnder = (await page.evaluate(() => scrollY)) === sy;
  await touch('touchEnd', []);
  await sleep(800);
  r.order = (await outcome(page, base)).series.S.chapters;
  // Held near the window's foot: the page scrolls on while the finger rests there.
  const grip2 = await page.$eval('.ch-row:nth-child(2) .ch-grip', (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  const sy2 = await page.evaluate(() => scrollY);
  await touch('touchStart', [{ x: grip2.x, y: grip2.y }]);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', [{ x: grip2.x, y: grip2.y + (590 - grip2.y) * i / 10 }]); await sleep(25); }
  await sleep(700);
  r.edgeScrolled = (await page.evaluate(() => scrollY)) > sy2;
  await touch('touchCancel', []);
  await sleep(600);
  r.afterCancel = (await outcome(page, base)).series.S.chapters;
  // The series as seeded again, for the cases after.
  await page.evaluate(async ({ s, chapters }) => { const api = await import('/app/js/api.js'); await api.meta.put({ ...(await api.meta.get(s)), chapters }); }, { s: gid(base, 'S'), chapters: seeded });
  return r;
}

test('a finger drags a row by its grip as 1.3\'s, and scrolls the page from anywhere else on a row', { skip: !chromePath() }, async () => {
  const now = await fingerDrag(NEW);
  const was = record(FILE, 'finger-drag');
  assert.deepEqual(now, was);
  assert.deepEqual([was.scrolled, was.draggedByWords, was.mid.dragging, was.stillUnder, was.edgeScrolled], [true, false, true, true, true]);
});

// What a press opens, inside the window on a phone, every button in reach.
function inside() {
  const box = [...document.querySelectorAll('.notice-overlay .notice-dialog, [data-notice="dialog"], .modal-overlay.show .modal-box, [data-slot="dialog"]')].find((b) => b.getClientRects().length);
  if (!box) return null;
  const r = box.getBoundingClientRect();
  const buttons = [...box.querySelectorAll('button')].filter((b) => getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0).map((b) => b.getBoundingClientRect());
  return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, reachable: buttons.every((b) => b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight), count: buttons.length };
}

test('the delete\'s question and the tag editor on a phone: inside the window, every button in reach, as 1.3\'s', { skip: !chromePath() }, async () => {
  let now;
  {
    await page.setViewport(PHONE);
    await visit(page, origin, NEW, gid(base, 'S'));
    const r = {};
    await page.$eval(`${rowSel(base, 'S2')} [data-remove]`, (el) => el.scrollIntoView({ block: 'center' }));
    await sleep(200);
    await page.tap(`${rowSel(base, 'S2')} [data-remove]`);
    const asked = await readDialog(page);
    r.question = { title: asked?.title, buttons: asked?.buttons.map((b) => b.text), ...(await page.evaluate(inside)) };
    await answer(page, 'cancel');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.tap('#editToggle');
    await until(page, () => !!document.querySelector('#ovContent.ov-editing'), null, { what: 'edit mode' });
    await page.$eval('.ov-chip-add', (el) => el.scrollIntoView({ block: 'center' }));
    await sleep(200);
    await page.tap('.ov-chip-add');
    await until(page, () => !!document.getElementById('tagEdType'), null, { what: 'the tag editor' });
    await sleep(400);
    r.tags = await page.evaluate(inside);
    await page.keyboard.press('Escape');
    await sleep(300);
    now = r;
  }
  const was = record(FILE, 'opens');
  assert.deepEqual([now.question.title, now.question.buttons], [was.question.title, was.question.buttons]);
  for (const r of [was.question, was.tags, now.question, now.tags]) assert.deepEqual([r.inside, r.reachable], [true, true], JSON.stringify({ was, now }));
});

// The on-screen keyboard takes the window's lower part: the add list, typed into, stays inside what is
// left and nothing of the page moves (§5.3 F69; 1.3's hung under its box in the page's flow).
test('the add list with the on-screen keyboard\'s room taken (390 × 500): inside the window, the page still', { skip: !chromePath() }, async () => {
  await page.setViewport({ ...PHONE, height: 500 });
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.$eval('#addSearch', (el) => el.scrollIntoView({ block: 'end' }));
  await sleep(200);
  await page.tap('#addSearch');
  await page.type('#addSearch', 'gallery', { delay: 10 });
  await until(page, () => document.querySelectorAll('#addResults .add-res').length > 0, null, { what: 'the add list' });
  const before = await page.evaluate(() => [scrollY, document.documentElement.scrollHeight]);
  await sleep(400);
  const r = await page.evaluate(() => {
    const list = document.getElementById('addResults').getBoundingClientRect(), box = document.getElementById('addSearch').getBoundingClientRect();
    return { inside: list.top >= 0 && list.bottom <= innerHeight && list.left >= 0 && list.right <= innerWidth, wide: Math.abs(list.width - box.width) <= 1, page: [scrollY, document.documentElement.scrollHeight] };
  });
  assert.deepEqual([r.inside, r.wide], [true, true]);
  assert.deepEqual(r.page, before);
  await page.keyboard.press('Escape');
});

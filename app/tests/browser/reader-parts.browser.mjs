// reader-parts.browser.mjs — the reader's page menu (a right-click on a page), page properties (I, or
// the menu's last item) and the feedback dialog (F over a bubble in study mode): how each opens and
// closes, where focus goes, and what each of the reader's keys does while one is open (the engine asks
// pageMenuOpen(), propertiesOpen() and feedbackOpen()). What is open is read from those three, the
// engine's own view, whatever draws the parts.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const GALLERY = '1790000000981';
const COUNT = 6;
let server, origin, browser;

// What draws each part (its box, its items or its close button).
const MENU = '[data-reader-part="page-menu"]';
const MENU_ITEM = '[data-slot="menu-item"]';
const PROPERTIES = '[data-reader-part="properties"]';
const FEEDBACK = 'dialog.feedback-dialog[open], [data-reader-part="feedback"]';

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async ({ gid, count }) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'Parts fixture' }, numPages: count });
    const canvas = new OffscreenCanvas(600, 900);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#789';
    ctx.fillRect(0, 0, 600, 900);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    for (let n = 1; n <= count; n++) await api.pages.put(gid, n, blob);
    // Study layers on every page: the cleaned page, and two bubbles' typeset text.
    for (let n = 1; n <= count; n++) {
      await api.derived.putTranslation(gid, n, { image: blob, pipeline: { job: 'j1', lines: [], read: [], regions: [] } });
      const a = { x: 0.1, y: 0.3, w: 0.5, h: 0.15 }, b = { x: 0.2, y: 0.6, w: 0.4, h: 0.12 };
      await api.derived.putStudy(gid, n, { bg: blob, page: { w: 600, h: 900 },
        bubbles: [{ id: 0, box: a, region: a, tr: 'Hello there', src: 'こんにちは', text: blob }, { id: 1, box: b, region: b, tr: 'Second', src: 'にばん', text: blob }] }, 'j1');
    }
  }, { gid: GALLERY, count: COUNT });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The reader at page 2 of the fixture, single page, the classic bar pinned; study mode if asked.
async function reader(t, { study = false, mode = 'single' } = {}) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument((study, mode) => {
    localStorage.setItem('shiori-reader-nav', 'top');
    localStorage.setItem('shiori-reader-pin', '1');
    localStorage.setItem('shiori:readerMode', JSON.stringify(mode));
    localStorage.setItem('shiori:readerView', JSON.stringify(study ? 'study' : 'off'));
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
    localStorage.setItem('shiori:readerFitMode', JSON.stringify('height'));
  }, study, mode);
  await page.goto(`${origin}/reader?g=${GALLERY}&page=2`, { waitUntil: 'load' });
  await until(page, () => [...document.querySelectorAll('#stripView img, #mainImg')].some((i) => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().height > 0), null, { what: 'a page drawn' });
  await sleep(300);
  return page;
}

// What the engine sees open, and the reader's own state a key could change.
const state = (page) => page.evaluate(async () => {
  const [m, p, f] = await Promise.all(['reader-page-menu', 'reader-properties', 'reader-feedback'].map((n) => import(`/app/js/${n}.js`)));
  const a = document.activeElement;
  return {
    menu: m.pageMenuOpen(), properties: p.propertiesOpen(), feedback: f.feedbackOpen(),
    page: document.getElementById('pageCounter').textContent,
    mode: ['singleView', 'doubleView', 'stripView'].find((id) => document.getElementById(id).classList.contains('active')),
    thumbs: document.body.classList.contains('thumbs-open'), study: document.body.classList.contains('study-mode'),
    controls: document.documentElement.classList.contains('reader-controls-hidden') || document.body.classList.contains('reader-controls-hidden'),
    keys: document.getElementById('keybindModal').classList.contains('show'), scrollY: Math.round(scrollY),
    focus: a === document.body || !a ? 'body' : (a.getAttribute('aria-label') || a.textContent.trim().split('\n')[0]).slice(0, 30),
  };
});
const reader_ = (s) => { const { menu, properties, feedback, focus, ...rest } = s; return rest; };

// A point on the page in view: the window's middle, `y` of the way down.
const centre = (page, y = 0.3) => page.evaluate((y) => ({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight * y) }), y);
async function openMenu(page, at) {
  at ??= await centre(page);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await until(page, async () => (await import('/app/js/reader-page-menu.js')).pageMenuOpen() && document.querySelectorAll('[data-reader-part="page-menu"] [data-slot="menu-item"]').length > 1
    && !!document.activeElement?.closest('[data-reader-part="page-menu"]'), null, { what: 'the page menu, focus in it' });
  return at;
}
async function openProperties(page) {
  await page.keyboard.press('i');
  await until(page, async () => (await import('/app/js/reader-properties.js')).propertiesOpen(), null, { what: 'page properties' });
  await until(page, (sel) => document.querySelectorAll(`:is(${sel}) :is(dd, td)`).length > 3, PROPERTIES, { what: 'page properties filled' });
}
async function openFeedback(page, index = 0) {
  // The bubble `index` of a page in view (the strip has every page's).
  const b = await until(page, (i) => {
    const el = [...document.querySelectorAll('.bubble-box')].find((e) => { const r = e.getBoundingClientRect(); return Number(e.dataset.feedbackIndex) === i && r.top > 60 && r.bottom < innerHeight - 20 && r.width > 0; });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, index, { what: `bubble ${index} in view` });
  await page.mouse.move(b.x - 3, b.y); await page.mouse.move(b.x, b.y); await sleep(250);
  await page.keyboard.press('f');
  await until(page, async () => (await import('/app/js/reader-feedback.js')).feedbackOpen(), null, { what: 'the feedback dialog' });
}

test('the page menu opens at the pointer with the page\'s items; Shift+right-click keeps the browser\'s own', { skip: !chromePath() }, async (t) => {
  const page = await reader(t);
  const at = await openMenu(page);
  const seen = await page.evaluate((MENU, ITEM) => {
    const m = document.querySelector(MENU), r = m.getBoundingClientRect();
    return { left: r.left, top: r.top, items: [...m.querySelectorAll(ITEM)].map((i) => [i.querySelector('kbd') ? 'kbd ' + i.querySelector('kbd').textContent : '', i.textContent.trim().replace(/\s+/g, ' ')]) };
  }, MENU, MENU_ITEM);
  assert.equal(seen.left, at.x, 'its left at the pointer');
  assert.equal(seen.top, at.y, 'its top at the pointer');
  assert.deepEqual(seen.items.map(([kbd]) => kbd), ['', 'kbd I']);
  assert.match(seen.items[0][1], /^Translate this page/);
  assert.match(seen.items[1][1], /^Page properties/);
  assert.match(await page.evaluate((MENU) => document.querySelector(MENU).textContent, MENU), /^Page 2/, 'its title names the page');
  await page.keyboard.press('Escape');
  // Shift held: the reader leaves the event alone.
  const prevented = await page.evaluate((at) => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, shiftKey: true, button: 2 });
    document.elementFromPoint(at.x, at.y).dispatchEvent(e);
    return e.defaultPrevented;
  }, at);
  await sleep(300);
  assert.equal(prevented, false, 'Shift+right-click is the browser\'s');
  assert.equal((await state(page)).menu, false);
});

test('the page menu is slid back inside the window, 8px from its edges', { skip: !chromePath() }, async (t) => {
  const page = await reader(t);
  await page.setViewport({ width: 500, height: 700 });
  await sleep(400);
  // The page's bottom right corner, a few pixels in.
  const corner = await page.evaluate(() => { const r = document.getElementById('mainImg').getBoundingClientRect(); return { x: Math.floor(r.right - 4), y: Math.floor(Math.min(r.bottom, innerHeight) - 110) }; });
  await openMenu(page, corner);
  const r = await page.evaluate((MENU) => { const b = document.querySelector(MENU).getBoundingClientRect(); return { right: innerWidth - b.right, bottom: innerHeight - b.bottom, w: b.width }; }, MENU);
  assert.ok(Math.abs(r.bottom - 8) < 0.6, `8px off the bottom (${r.bottom})`);
  assert.ok(r.right >= 7.4 && r.right < 24, `inside the right edge (${r.right})`);
});

test('the page menu closes on a press outside, a scroll, a resize, the window losing focus and a choice', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, { mode: 'strip' });
  const at = await centre(page, 0.4);
  const closers = [
    ['a press outside', () => page.mouse.click(at.x - 200, at.y + 150)],
    ['a scroll', async () => { await page.mouse.move(at.x, at.y + 200); await page.mouse.wheel({ deltaY: 300 }); }],
    ['a resize', () => page.setViewport({ width: 1180, height: 900 })],
    ['the window losing focus', () => page.evaluate(() => window.dispatchEvent(new Event('blur')))],
  ];
  for (const [what, act] of closers) {
    await page.evaluate(() => window.scrollTo(0, 0)); await sleep(200);
    await openMenu(page, at);
    await act();
    await until(page, async () => !(await import('/app/js/reader-page-menu.js')).pageMenuOpen(), null, { what: `the menu closed by ${what}` });
    await sleep(200);
  }
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(200);
  await openMenu(page, at);
  await page.evaluate((ITEM) => [...document.querySelectorAll(ITEM)].at(-1).click(), MENU_ITEM);
  await until(page, async () => (await import('/app/js/reader-properties.js')).propertiesOpen(), null, { what: 'page properties, chosen' });
  assert.equal((await state(page)).menu, false, 'a choice closes it');
});

// The menu's keys are the menu's (the menu pattern, as every menu of the app: §5.3 F39): the arrows move
// and wrap, Home and End, typing a letter goes to the item it starts, Enter chooses, Escape closes; the
// keys it does not use (the side arrows, Space) are the reader's, as with 1.3's menu. Focus starts on the
// menu itself, no item lit (F50: a menu opened by the pointer).
test('keys with the page menu open: the arrows, Home, End and typing are the menu\'s, Enter chooses, Escape closes it; the keys it does not use reach the reader', { skip: !chromePath() }, async (t) => {
  const page = await reader(t);
  await openMenu(page);
  const first = await state(page);
  assert.match(first.focus, /^Page 2/, 'focus on the menu, no item lit');
  for (const [key, lit] of [['ArrowDown', /^Translate this page/], ['ArrowDown', /^Page properties/], ['ArrowDown', /^Translate this page/], ['ArrowUp', /^Page properties/], ['Home', /^Translate this page/], ['End', /^Page properties/]]) {
    await page.keyboard.press(key);
    const now = await state(page);
    assert.deepEqual(reader_(now), reader_(first), `${key}: the reader did nothing`);
    assert.equal(now.menu, true);
    assert.match(now.focus, lit, `${key} moves to ${lit}`);
  }
  for (const key of ['d', 'g', 'i', '2', 'x']) {
    await page.keyboard.press(key);
    await sleep(120);
    const now = await state(page);
    assert.deepEqual(reader_(now), reader_(first), `${key}: typed into the menu, not the reader's`);
    assert.deepEqual([now.menu, now.properties], [true, false]);
  }
  await page.keyboard.press('ArrowRight');
  await sleep(300);
  const turned = await state(page);
  assert.deepEqual([turned.page, turned.menu, turned.focus], ['3 / 6', true, 'body'], 'the arrow the menu does not use turns the page; the reader takes the focus off the menu, which stays');
  // Its keys are still its own, as 1.3's were: Down goes back to its first item, Escape closes it
  // and does not reach the reader (whose Escape opens the shortcuts).
  await page.keyboard.press('ArrowDown');
  const back = await state(page);
  assert.match(back.focus, /^Translate this page/);
  assert.equal(back.scrollY, turned.scrollY);
  await page.keyboard.press('ArrowRight');
  await sleep(300);
  await page.keyboard.press('Escape');
  await sleep(200);
  const closed = await state(page);
  assert.deepEqual([closed.menu, closed.keys], [false, false], 'Escape closes it, and only it');
  assert.equal(closed.page, '4 / 6');
  // Enter chooses the item lit (1.3's reader took the focus off it first, so nothing was chosen).
  await openMenu(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await until(page, async () => (await import('/app/js/reader-properties.js')).propertiesOpen(), null, { what: 'page properties, chosen by Enter' });
  assert.equal((await state(page)).menu, false);
});

// Every key of the reader's that does something with nothing open, pressed with the dialog open: none
// reaches the reader; I (page properties only) and Escape close it.
const READER_KEYS = ['ArrowRight', 'ArrowLeft', 'd', 'a', 'ArrowDown', 's', 'w', 'Home', 'End', 'PageDown', '1', '2', '3', 'g', 'k', 'b', 'x', 'n', '?', '=', '-'];

test('keys with page properties open: none reaches the reader; I and Escape close it, and focus starts on its close button', { skip: !chromePath() }, async (t) => {
  const page = await reader(t);
  await openProperties(page);
  const first = await state(page);
  assert.equal(first.focus, 'Close', 'focus on its close button');
  for (const key of READER_KEYS) {
    await page.keyboard.press(key);
    await sleep(120);
    const now = await state(page);
    assert.equal(now.properties, true, `${key} leaves it open`);
    assert.deepEqual(reader_(now), reader_(first), `${key} reaches no part of the reader`);
  }
  await page.keyboard.press('i');
  await sleep(150);
  assert.equal((await state(page)).properties, false, 'I closes it');
  await openProperties(page);
  await page.keyboard.press('Escape');
  await sleep(150);
  const closed = await state(page);
  assert.equal(closed.properties, false, 'Escape closes it');
  assert.deepEqual(reader_(closed), reader_(first));
});

test('page properties: its close button and a press on the backdrop close it; the wheel over the backdrop leaves the page still', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, { mode: 'strip' });
  await openProperties(page);
  const y = await page.evaluate(() => scrollY);
  await page.mouse.move(30, 450);
  await page.mouse.wheel({ deltaY: 400 });
  await sleep(300);
  assert.equal(await page.evaluate(() => scrollY), y, 'the page behind did not scroll');
  await page.mouse.click(30, 450);
  await sleep(200);
  assert.equal((await state(page)).properties, false, 'a press on the backdrop closes it');
  await openProperties(page);
  await page.evaluate((sel) => [...document.querySelectorAll(`:is(${sel}) button`)].find((b) => b.getAttribute('aria-label') === 'Close').click(), PROPERTIES);
  await sleep(200);
  assert.equal((await state(page)).properties, false, 'its close button closes it');
});

// The owner's rule for dialogs: its top and its size never move once it shows. What it reads after it
// opens (the page, its pictures, the plan from the server) fills it in place. Every frame from the
// press until a second after it is filled, the CPU six times slower, at a desktop's size and a phone's.
async function boxFrames(page, open, sel, filled) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  try {
    await page.evaluate((sel, filled) => {
      window.__frames = [];
      let after = 0;
      const tick = () => {
        const el = document.querySelector(sel);
        if (el) { const r = el.getBoundingClientRect(); window.__frames.push([r.top, r.left, r.height, r.width].map((v) => Math.round(v * 100) / 100).join(' ')); }
        if (el && document.querySelector(filled)) after++;
        if (after < 40) requestAnimationFrame(tick); else window.__framesDone = true;
      };
      window.__framesDone = false;
      requestAnimationFrame(tick);
    }, sel, filled);
    await open();
    await until(page, () => window.__framesDone, null, { what: 'the frames', timeout: 30000 });
    return await page.evaluate(() => window.__frames);
  } finally { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); }
}

test('page properties\' box neither moves nor grows after its first frame, the CPU six times slower', { skip: !chromePath() }, async (t) => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844, hasTouch: true, isMobile: true }]) {
    const page = await reader(t);
    await page.setViewport(viewport);
    await sleep(400);
    // The first opening, which fetches the dialog's code, and the next, which shows it loading first.
    for (const time of ['first', 'second']) {
      const frames = await boxFrames(page, () => page.keyboard.press('i'), PROPERTIES, `${PROPERTIES} [data-pp="again"]`);
      assert.ok(frames.length >= 40, `${frames.length} frames`);
      assert.deepEqual([...new Set(frames)], [frames[0]], `${viewport.width}px, ${time} opening: the box in every frame as in its first`);
      await page.keyboard.press('Escape');
      await until(page, async () => !(await import('/app/js/reader-properties.js')).propertiesOpen(), null, { what: 'closed' });
      await sleep(200);
    }
  }
});

test('auto-play waits while page properties or feedback is open, and goes on once it closes', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, { mode: 'strip', study: true });
  await page.keyboard.press('k');
  await sleep(300);
  for (const [what, open, close] of [['page properties', () => openProperties(page), () => page.keyboard.press('Escape')], ['feedback', () => openFeedback(page), () => page.keyboard.press('Escape')]]) {
    await open();
    const y = await page.evaluate(() => scrollY);
    await sleep(500);
    assert.equal(await page.evaluate(() => scrollY), y, `it waits behind ${what}`);
    await close();
    await sleep(500);
    assert.ok(await page.evaluate(() => scrollY) > y, `it goes on once ${what} closes`);
  }
});

test('keys with the feedback dialog open: none reaches the reader; Escape closes it, and focus starts on its close button', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, { study: true });
  await openFeedback(page);
  const first = await state(page);
  assert.equal(first.focus, 'Close', 'focus on its close button');
  for (const key of [...READER_KEYS, 'i', 'f']) {
    await page.keyboard.press(key);
    await sleep(120);
    const now = await state(page);
    assert.equal(now.feedback, true, `${key} leaves it open`);
    assert.deepEqual(reader_(now), reader_(first), `${key} reaches no part of the reader`);
  }
  await page.keyboard.press('Escape');
  await sleep(150);
  assert.equal((await state(page)).feedback, false, 'Escape closes it');
});

test('a feedback draft is kept while the reader is open: closed and opened again on the same bubble it is as it was left; another bubble has its own', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, { study: true });
  const box = () => page.evaluate((sel) => {
    const d = document.querySelector(sel);
    return { note: d.querySelector('textarea').value, ticked: [...d.querySelectorAll('input[type="checkbox"]:checked, [role="checkbox"][aria-checked="true"]')].length };
  }, FEEDBACK);
  await openFeedback(page, 0);
  await page.evaluate((sel) => {
    const d = document.querySelector(sel);
    const note = d.querySelector('textarea');
    note.focus();
  }, FEEDBACK);
  await page.keyboard.type('the line breaks are off');
  const tick = await page.evaluate((sel) => { const d = document.querySelector(sel); const c = d.querySelector('input[type="checkbox"], [role="checkbox"]'); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, FEEDBACK);
  await page.mouse.click(tick.x, tick.y);
  assert.deepEqual(await box(), { note: 'the line breaks are off', ticked: 1 });
  await page.keyboard.press('Escape');
  await until(page, async () => !(await import('/app/js/reader-feedback.js')).feedbackOpen(), null, { what: 'closed' });
  await openFeedback(page, 0);
  assert.deepEqual(await box(), { note: 'the line breaks are off', ticked: 1 }, 'the same bubble: the draft as it was left');
  await page.keyboard.press('Escape');
  await until(page, async () => !(await import('/app/js/reader-feedback.js')).feedbackOpen(), null, { what: 'closed' });
  await openFeedback(page, 1);
  assert.deepEqual(await box(), { note: '', ticked: 0 }, 'another bubble: a draft of its own');
});

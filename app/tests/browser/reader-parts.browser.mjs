// reader-parts.browser.mjs — the reader's page menu (a right-click on a page), page properties (I, or
// the menu's last item) and the feedback dialog (F over a bubble in study mode): how each opens and
// closes, where focus goes, and what each of the reader's keys does while one is open (the engine asks
// pageMenuOpen(), propertiesOpen() and feedbackOpen()). What is open is read from those three, the
// engine's own view, whatever draws the parts.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const GALLERY = '1790000000981';
const COUNT = 6;
let server, origin, browser;

// What draws each part (its box, its items or its close button).
const MENU = '[data-reader-part="page-menu"]';
const MENU_ITEM = '[data-slot="menu-item"]';
const PROPERTIES = '[data-reader-part="properties"]';
const FEEDBACK = '[data-reader-part="feedback"]';

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
  await until(page, (sel) => !!document.querySelector(sel)?.contains(document.activeElement), FEEDBACK, { what: 'the feedback dialog drawn, focus in it' });
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

// Feedback's box likewise, from the press on a bubble with no draft yet (its code fetched already): the
// evidence captured and the frozen page's pictures replaced after it shows.
test('the feedback dialog\'s box neither moves nor grows after its first frame, the CPU six times slower', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, { study: true });
  await openFeedback(page, 0);
  await page.keyboard.press('Escape');
  await until(page, async () => !(await import('/app/js/reader-feedback.js')).feedbackOpen(), null, { what: 'closed' });
  const b = await until(page, () => {
    const el = [...document.querySelectorAll('.bubble-box')].find((e) => e.dataset.feedbackIndex === '1');
    const r = el?.getBoundingClientRect();
    return r && { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, null, { what: 'the second bubble' });
  await page.mouse.move(b.x - 3, b.y); await page.mouse.move(b.x, b.y); await sleep(250);
  const frames = await boxFrames(page, () => page.keyboard.press('f'), FEEDBACK, `${FEEDBACK} [data-feedback="fidelity"]:not(:empty)`);
  assert.ok(frames.length >= 40, `${frames.length} frames`);
  assert.deepEqual([...new Set(frames)], [frames[0]], 'the box in every frame as in its first');
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
    return { note: d.querySelector('textarea').value, ticked: d.querySelectorAll('[role="checkbox"][aria-checked="true"]').length };
  }, FEEDBACK);
  await openFeedback(page, 0);
  await page.evaluate((sel) => {
    const d = document.querySelector(sel);
    const note = d.querySelector('textarea');
    note.focus();
  }, FEEDBACK);
  await page.keyboard.type('the line breaks are off');
  const tick = await page.evaluate((sel) => { const d = document.querySelector(sel); const c = d.querySelector('[role="checkbox"]'); const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, FEEDBACK);
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

// A send and an export, against a stand-in translation server of the test's own (127.0.0.1, a free
// port): each outcome's words in the status line, a change to the form clearing it. The stand-in reads
// the report's id from the archive (its files are stored, not compressed) as a real one answers it.
test('feedback: sending and exporting a report, each outcome said in its status line', { skip: !chromePath() }, async (t) => {
  const answers = [];
  const ZIP = Buffer.from('a report kept by the server');
  const zipHash = createHash('sha256').update(ZIP).digest('hex');
  const stand = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('latin1');
    const head = { 'Access-Control-Allow-Origin': '*' };
    if (req.url === '/feedback/save') {
      const how = answers.shift() || 'ok';
      if (how === 'fail') { res.writeHead(500, head); res.end(); return; }
      const id = body.match(/"report_id": "([a-f0-9]{32})"/)?.[1];
      res.writeHead(200, { ...head, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(how === 'bad' ? { report_id: 'nope' } : { report_id: id, archive_sha256: zipHash, storage: 'translation-server' }));
    } else if (req.url === '/feedback/export') {
      res.writeHead(200, { ...head, 'Content-Type': 'application/zip' });
      res.end(ZIP);
    } else { res.writeHead(404, head); res.end(); }
  });
  await new Promise((r) => stand.listen(0, '127.0.0.1', r));
  const serverUrl = `http://127.0.0.1:${stand.address().port}`;
  t.after(() => stand.close());
  const page = await openPage(browser, origin, { allow: [serverUrl] });
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument((serverUrl) => {
    localStorage.setItem('shiori-reader-nav', 'top');
    localStorage.setItem('shiori-reader-pin', '1');
    localStorage.setItem('shiori:readerMode', JSON.stringify('single'));
    localStorage.setItem('shiori:readerView', JSON.stringify('study'));
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
    localStorage.setItem('shiori:readerFitMode', JSON.stringify('height'));
    localStorage.setItem('shiori:translateSettings', JSON.stringify({ serverUrl }));
  }, serverUrl);
  await page.goto(`${origin}/reader?g=${GALLERY}&page=2`, { waitUntil: 'load' });
  await until(page, () => document.getElementById('mainImg')?.naturalWidth > 0, null, { what: 'a page drawn' });
  await openFeedback(page, 0);
  const words = (key, args) => page.evaluate(async (key, args) => (await import('/app/js/i18n.js')).t(key, args), key, args);
  const buttons = (keys) => page.evaluate(async (sel, keys) => {
    const { t } = await import('/app/js/i18n.js');
    const all = [...document.querySelector(sel).querySelectorAll('button')];
    return keys.map((key) => !all.find((b) => b.textContent === t(key))?.disabled);
  }, FEEDBACK, keys);
  const press = (key) => page.evaluate(async (sel, key) => {
    const { t } = await import('/app/js/i18n.js');
    [...document.querySelector(sel).querySelectorAll('button')].find((b) => b.textContent === t(key)).click();
  }, FEEDBACK, key);
  const status = () => page.$eval(`${FEEDBACK} [role="status"]`, (el) => el.textContent);
  await until(page, (sel) => document.querySelector(`${sel} [data-feedback="fidelity"]`)?.textContent, FEEDBACK, { what: 'the evidence captured' });
  assert.equal(await page.$eval(`${FEEDBACK} [data-feedback="destination"]`, (el) => el.textContent), await words('feedback.destination'));
  assert.deepEqual(await buttons(['feedback.save', 'feedback.export']), [false, false], 'nothing to send before an issue is ticked');
  const tick = await page.$eval(`${FEEDBACK} [role="checkbox"]`, (c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(tick.x, tick.y);
  assert.deepEqual(await buttons(['feedback.save', 'feedback.export']), [true, true]);
  // A server that fails, one whose receipt is not the report's, one that keeps it.
  const says = (w, what) => until(page, ([sel, w]) => document.querySelector(`${sel} [role="status"]`).textContent === w, [FEEDBACK, w], { what });
  answers.push('fail', 'bad');
  await press('feedback.save');
  await says(await words('feedback.failed', { error: 'HTTP 500' }), 'a failed send');
  await press('feedback.save');
  await says(await words('feedback.failed', { error: await words('feedback.bad_ack') }), 'a receipt not the report\'s');
  await press('feedback.save');
  await says(await words('feedback.saved'), 'a kept report');
  // Exported with a receipt: the server's copy; after a change to the form, the cached evidence.
  await press('feedback.export');
  await says(await words('feedback.exported'), 'the server\'s copy exported');
  await page.focus(`${FEEDBACK} textarea`);
  await page.keyboard.type('x');
  assert.equal(await status(), '', 'a change to the form clears the outcome');
  await press('feedback.export');
  await says(await words('feedback.exported_cached'), 'the cached evidence exported');
});

// Left open when the reader is left (Back to Tasks, a change of route): the reader's stop closes each, its
// host goes with it, and nothing of it is in the document after (a feedback draft's pictures released);
// the same leaving each after it was opened and closed. From Tasks by a link, as the app's own are followed.
test('leaving the reader with the page menu, page properties or feedback open, or after closing them, leaves nothing of them', { skip: !chromePath() }, async (t) => {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('shiori-reader-nav', 'top');
    localStorage.setItem('shiori-reader-pin', '1');
    localStorage.setItem('shiori:readerMode', JSON.stringify('single'));
    localStorage.setItem('shiori:readerView', JSON.stringify('study'));
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
    localStorage.setItem('shiori:readerFitMode', JSON.stringify('height'));
    const urls = new Set(), create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    URL.createObjectURL = (o) => { const u = create.call(URL, o); urls.add(u); return u; };
    URL.revokeObjectURL = (u) => { urls.delete(u); return revoke.call(URL, u); };
    globalThis.__urls = urls;
  });
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  const parts = { menu: (p) => openMenu(p), properties: (p) => openProperties(p), feedback: (p) => openFeedback(p, 0) };
  for (const [name, open] of Object.entries(parts)) {
    for (const closed of [false, true]) {
      await page.evaluate((href) => { const a = Object.assign(document.createElement('a'), { href }); document.body.append(a); a.click(); a.remove(); }, `/reader?g=${GALLERY}&page=2`);
      await until(page, () => document.getElementById('mainImg')?.naturalWidth > 0 && document.querySelectorAll('.bubble-box').length > 1, null, { what: 'the reader' });
      await sleep(300);
      await open(page);
      if (closed) {
        await page.keyboard.press('Escape');
        await until(page, async () => { const [m, p, f] = await Promise.all(['reader-page-menu', 'reader-properties', 'reader-feedback'].map((n) => import(`/app/js/${n}.js`))); return !m.pageMenuOpen() && !p.propertiesOpen() && !f.feedbackOpen(); }, null, { what: `${name} closed` });
      }
      await page.goBack();
      await until(page, () => !document.querySelector('.reader-frame') && !!document.getElementById('tkList'), null, { what: 'Tasks again' });
      await sleep(300);
      const left = await page.evaluate(async () => {
        const [m, p, f] = await Promise.all(['reader-page-menu', 'reader-properties', 'reader-feedback'].map((n) => import(`/app/js/${n}.js`)));
        return { open: [m.pageMenuOpen(), p.propertiesOpen(), f.feedbackOpen()], drawn: document.querySelectorAll('[data-reader-part], [data-slot="dialog-backdrop"], [data-slot="menu"]').length,
          urls: globalThis.__urls.size };
      });
      assert.deepEqual(left, { open: [false, false, false], drawn: 0, urls: 0 }, `${name} ${closed ? 'opened and closed' : 'left open'}`);
      // Its module has no host: a request now would throw, as with no reader.
      assert.equal(await page.evaluate(async () => { try { await (await import('/app/js/reader-properties.js')).openPageProperties({}); return 'drawn'; } catch (e) { return /no page properties host/.test(e.message); } }), true);
    }
  }
});

// Over the reader's chrome in every state: the top bar or the side controls, the thumbnails open, reader
// settings open under page properties (I works with them open); the menu over the side controls it is
// slid onto at the window's corner.
test('the menu and the dialogs show over the reader\'s chrome, reader settings and the thumbnails', { skip: !chromePath() }, async (t) => {
  for (const nav of ['top', 'side']) {
    const page = await reader(t);
    await page.evaluate((nav) => localStorage.setItem('shiori-reader-nav', nav), nav);
    await page.reload({ waitUntil: 'load' });
    await until(page, () => document.getElementById('mainImg')?.naturalWidth > 0, null, { what: 'the reader' });
    await sleep(300);
    await page.keyboard.press('g');
    await until(page, () => document.body.classList.contains('thumbs-open'), null, { what: 'the thumbnails' });
    const onTop = (sel) => page.evaluate((sel) => {
      const box = document.querySelector(sel).getBoundingClientRect();
      const points = [[box.left + 4, box.top + 4], [box.right - 4, box.top + 4], [box.left + 4, box.bottom - 4], [box.right - 4, box.bottom - 4], [box.left + box.width / 2, box.top + box.height / 2]];
      return points.every(([x, y]) => x < 0 || y < 0 || x > innerWidth || y > innerHeight || !!document.elementFromPoint(x, y)?.closest(sel));
    }, sel);
    // The menu at the window's bottom right corner, slid over the side controls and the thumbnails.
    const corner = await page.evaluate(() => { const r = document.getElementById('mainImg').getBoundingClientRect(); return { x: Math.floor(r.right - 6), y: Math.floor(r.top + r.height * 0.6) }; });
    await openMenu(page, corner);
    assert.ok(await onTop(MENU), `${nav}: the menu over everything under it`);
    await page.keyboard.press('Escape');
    // Reader settings open, then I.
    await page.evaluate((nav) => document.getElementById(nav === 'side' ? 'snSettings' : 'readerSettingsBtn').click(), nav);
    await until(page, () => document.getElementById('readerSettingsModal').classList.contains('show'), null, { what: 'reader settings' });
    await openProperties(page);
    assert.ok(await onTop(PROPERTIES), `${nav}: page properties over reader settings`);
    await page.keyboard.press('Escape');
    await until(page, async () => !(await import('/app/js/reader-properties.js')).propertiesOpen(), null, { what: 'page properties closed' });
    assert.equal(await page.evaluate(() => document.getElementById('readerSettingsModal').classList.contains('show')), true, 'Escape closed page properties alone');
    await page.keyboard.press('Escape');
    await page.keyboard.press('b');
    await openFeedback(page, 0);
    assert.ok(await onTop(FEEDBACK), `${nav}: feedback over the thumbnails and the controls`);
  }
});

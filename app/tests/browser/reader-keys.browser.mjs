// reader-keys.browser.mjs — the reader's keys list (its keyboard button, the rail's, ? or Escape): what
// it says, in which order; what each of the reader's keys does while it is open (nothing: Escape and ?
// close it, and the pages behind it stay where they are); how it opens and closes, one dialog at a time
// with Reader settings, and where the focus goes; that the wheel over it moves nothing behind it; and
// that leaving the reader with it open leaves nothing. Whether it is open, and its box, are read from
// what draws it (S below).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const GALLERY = '1790000000992';
const COUNT = 8;
let server, origin, browser;

// What draws the list.
const S = {
  open: '[data-reader-part="keys"]',
  box: '#keybindBox',
  section: '[data-kb="section"]',
  row: '[data-kb="row"]',
  desc: '[data-kb="desc"]',
  key: 'kbd',
};

// What it says, in order: each section's heading, then its rows, each a description and its key caps
// (a locale key where the cap is a word).
const LIST = [
  ['kb.navigation', [
    ['kb.next', ['→', 'Space', 'D']],
    ['kb.prev', ['←', 'A']],
    ['kb.scroll', ['W', 'S', '↑', '↓']],
    ['kb.first', ['Home', 'Shift+←', 'Shift+A']],
    ['kb.last', ['End', 'Shift+→', 'Shift+D']],
  ]],
  ['kb.viewmode', [
    ['kb.single', ['1']],
    ['kb.double', ['2']],
    ['kb.strip', ['3']],
    ['kb.cover_offset', ['C']],
    ['kb.zoom', ['+', '−', 'E', 'Q']],
    ['kb.fit_width', ['Shift+E']],
    ['kb.fit_height', ['Shift+Q']],
  ]],
  ['kb.interface', [
    ['rd.tip_translate', ['T']],
    ['rd.tip_study', ['B']],
    ['feedback.shortcut', ['F']],
    ['page.properties', ['I']],
    ['page.menu_hint', [{ t: 'page.right_click' }]],
    ['kb.toggle_thumbs', ['G']],
    ['kb.hide_controls', ['X', 'N', { t: 'kb.double_click' }]],
    ['kb.autoscroll', ['K']],
    ['kb.swipe_thumbs', [{ t: 'kb.drag' }]],
    ['kb.scrub', [{ t: 'kb.shift_drag' }]],
    ['kb.help', ['?', 'Esc']],
  ]],
];

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async ({ gid, count }) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'Keys fixture' }, numPages: count });
    const canvas = new OffscreenCanvas(600, 1600);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#9a8';
    ctx.fillRect(0, 0, 600, 1600);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    for (let n = 1; n <= count; n++) await api.pages.put(gid, n, blob);
  }, { gid: GALLERY, count: COUNT });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reader(t, { mode = 'single', nav = 'top', fit = 'height', at = 2 } = {}) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument((o) => {
    localStorage.setItem('shiori-reader-nav', o.nav);
    localStorage.setItem('shiori-reader-pin', '1');
    localStorage.setItem('shiori-reader-side-pin', '1');
    localStorage.setItem('shiori:readerMode', JSON.stringify(o.mode));
    localStorage.setItem('shiori:readerFitMode', JSON.stringify(o.fit));
    localStorage.setItem('shiori:readerPageZoom', '1');
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
    localStorage.setItem('shiori:readerView', '"off"');
    localStorage.setItem('shiori:readerCoverOffset', 'false');
  }, { mode, nav, fit });
  await page.goto(`${origin}/reader?g=${GALLERY}&page=${at}`, { waitUntil: 'load' });
  await until(page, () => [...document.querySelectorAll('#stripView img[src], #mainImg, .dImg')].some((img) => img.naturalWidth > 0)
    && getComputedStyle(document.getElementById('loadingScreen')).display === 'none', null, { what: 'a page drawn' });
  await sleep(300);
  return page;
}
const isOpen = (page) => page.evaluate((sel) => !!document.querySelector(sel), S.open);
const button = (nav) => (nav === 'side' ? '#snKeys' : '#keybindBtn');
async function openKeys(page, nav = 'top') {
  await page.click(button(nav));
  await until(page, (sel) => !!document.querySelector(sel), S.open, { what: 'the keys list' });
  await sleep(100);
}
// What the reader shows: everything a key could change.
const state = (page) => page.evaluate(() => ({
  mode: document.getElementById('modeToggle').dataset.state,
  page: document.getElementById('pageCounter').textContent.trim(),
  zoom: document.documentElement.style.getPropertyValue('--page-zoom'),
  fit: document.body.classList.contains('reader-fit-width') ? 'width' : document.body.classList.contains('reader-fit-height') ? 'height' : 'off',
  thumbs: document.body.classList.contains('thumbs-open'),
  hidden: document.documentElement.classList.contains('reader-controls-hidden'),
  unpinned: document.body.classList.contains('reader-unpinned'),
  view: document.getElementById('viewToggle').dataset.state,
  auto: document.getElementById('autoBtn').getAttribute('aria-pressed'),
  cover: localStorage.getItem('shiori:readerCoverOffset'),
  scroll: Math.round(scrollY),
  others: !!document.querySelector('[data-reader-part="settings"], [data-reader-part="properties"], [data-reader-part="page-menu"]'),
}));

test('the keys list says what 1.3\'s said: its sections, rows and key caps in the same order, in the person\'s words', { skip: !chromePath() }, async (t) => {
  const page = await reader(t);
  await openKeys(page);
  const words = await page.evaluate(async (LIST) => {
    const { t } = await import('/app/js/i18n.js');
    return LIST.map(([section, rows]) => [t(section), rows.map(([desc, keys]) => [t(desc), keys.map((k) => (typeof k === 'string' ? k : t(k.t)))])]);
  }, LIST);
  const shown = await page.evaluate((S) => {
    const box = document.querySelector(S.box);
    const out = [];
    for (const el of box.querySelectorAll(`${S.section}, ${S.row}`)) {
      if (el.matches(S.section)) out.push([el.textContent.trim(), []]);
      else out.at(-1)[1].push([el.querySelector(S.desc).textContent.trim(), [...el.querySelectorAll(S.key)].map((k) => k.textContent.trim())]);
    }
    return out;
  }, S);
  assert.deepEqual(shown, words);
});

test('keys with the keys list open: none of the reader\'s keys acts behind it, the pages stay where they are; Escape and ? close it', { skip: !chromePath() }, async (t) => {
  const KEYS = [['2'], ['3'], ['ArrowRight'], ['d'], ['ArrowLeft'], ['a'], [' '], ['End'], ['Home'], ['PageDown'], ['ArrowDown'], ['s'], ['w'],
    ['='], ['-'], ['e'], ['q'], ['Shift', 'E'], ['Shift', 'Q'], ['c'], ['g'], ['x'], ['n'], ['k'], ['t'], ['b'], ['i'], ['1']];
  for (const nav of ['top', 'side']) {
    const page = await reader(t, { mode: 'strip', fit: 'off', nav });
    await page.evaluate(() => scrollTo(0, 900));
    await sleep(300);
    await openKeys(page, nav);
    const before = await state(page);
    for (const keys of KEYS) {
      for (const k of keys) await page.keyboard.down(k);
      for (const k of [...keys].reverse()) await page.keyboard.up(k);
      await sleep(120);
      assert.deepEqual(await state(page), before, `${nav}, ${keys.join('+')}: nothing changed behind the keys list`);
      assert.equal(await isOpen(page), true, `${nav}, ${keys.join('+')}: the list stays open`);
    }
    // The wheel over it, or over the backdrop beside it, moves nothing behind it.
    await page.mouse.move(640, 450);
    await page.mouse.wheel({ deltaY: 400 });
    await page.mouse.move(40, 450);
    await page.mouse.wheel({ deltaY: 400 });
    await sleep(300);
    assert.equal((await state(page)).scroll, before.scroll, `${nav}: the wheel moved nothing behind it`);
    await page.keyboard.press('Escape');
    await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed by Escape' });
    await page.keyboard.press('?');
    await until(page, (sel) => !!document.querySelector(sel), S.open, { what: 'opened by ?' });
    await page.keyboard.press('?');
    await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed by ?' });
    await page.keyboard.press('Escape');
    await until(page, (sel) => !!document.querySelector(sel), S.open, { what: 'opened by Escape' });
    await page.keyboard.press('Escape');
    await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed by Escape' });
    assert.deepEqual(await state(page), before, `${nav}: the reader as it was`);
  }
});

test('the keys list opens by its button and closes by it, by a press beside its box, one dialog at a time with reader settings; the focus back on its button after the keyboard, nowhere after the pointer', { skip: !chromePath() }, async (t) => {
  for (const nav of ['top', 'side']) {
    const page = await reader(t, { nav });
    const focus = () => page.evaluate(() => ({ id: document.activeElement?.id || document.activeElement?.tagName, ring: !!document.querySelector(':focus-visible') }));
    const lit = () => page.evaluate(() => document.getElementById('keybindBtn').classList.contains('active'));
    await openKeys(page, nav);
    if (nav === 'top') assert.equal(await lit(), true, 'its button lit while it is open');
    await page.click(button(nav));
    await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed by its button' });
    if (nav === 'top') assert.equal(await lit(), false, 'and not once it has closed');
    // A press beside its box closes it, the focus nowhere.
    await openKeys(page, nav);
    await page.mouse.click(30, 450);
    await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed by a press beside it' });
    assert.deepEqual(await focus(), { id: 'BODY', ring: false }, `${nav}: closed by the pointer, the focus nowhere`);
    // One at a time: the settings close the list, the list the settings.
    await openKeys(page, nav);
    await page.evaluate((nav) => document.getElementById(nav === 'side' ? 'snSettings' : 'readerSettingsBtn').click(), nav);
    await until(page, () => !!document.querySelector('[data-reader-part="settings"]'), null, { what: 'reader settings' });
    assert.equal(await isOpen(page), false, `${nav}: reader settings in the list's place`);
    await page.evaluate((b) => document.querySelector(b).click(), button(nav));
    await until(page, (sel) => !!document.querySelector(sel), S.open, { what: 'the list again' });
    assert.equal(await page.evaluate(() => !!document.querySelector('[data-reader-part="settings"]')), false, `${nav}: the list in reader settings' place`);
    await page.keyboard.press('Escape');
    await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed' });
    // From the keyboard: Tab, the focus on its button, Enter; Escape closes it, the focus back on its button.
    await page.keyboard.press('Tab');
    await page.focus(button(nav));
    await page.keyboard.press('Enter');
    await until(page, (sel) => !!document.querySelector(sel), S.open, { what: 'opened by Enter' });
    await page.keyboard.press('Escape');
    await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed by Escape' });
    assert.equal((await focus()).id, button(nav).slice(1), `${nav}: the focus back on the button that opened it`);
  }
});

test('leaving the reader with the keys list open, or after it was opened and closed, leaves nothing of it', { skip: !chromePath() }, async (t) => {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('shiori-reader-nav', 'top');
    localStorage.setItem('shiori-reader-pin', '1');
    localStorage.setItem('shiori:readerMode', JSON.stringify('single'));
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
  });
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  for (const how of ['open', 'closed']) {
    await page.evaluate((href) => { const a = Object.assign(document.createElement('a'), { href }); document.body.append(a); a.click(); a.remove(); }, `/reader?g=${GALLERY}&page=2`);
    await until(page, () => document.getElementById('mainImg')?.naturalWidth > 0, null, { what: 'the reader' });
    await sleep(300);
    await page.keyboard.press('?');
    await until(page, (sel) => !!document.querySelector(sel), S.open, { what: 'the keys list' });
    if (how === 'closed') {
      await page.keyboard.press('Escape');
      await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed' });
    }
    await page.goBack();
    await until(page, () => !document.querySelector('.reader-frame') && !!document.getElementById('tkList'), null, { what: 'Tasks again' });
    await sleep(300);
    const left = await page.evaluate((S) => document.querySelectorAll(`${S.open}, ${S.box}, [data-reader-part], [data-slot="dialog-backdrop"], [data-slot="dialog-viewport"]`).length, S);
    assert.equal(left, 0, `left ${how}`);
  }
});

// The hosts the engine shows the keys list and reader settings through are the route's modules, which
// outlive the reader: holding the engine's own functions once closed, they kept a stopped reader's whole
// scope, its frame among it (some 580 DOM nodes), alive until the next reader started (8f's settings
// and this step's keys list alike: 778 nodes on Tasks after a visit that opened either, 199 after one
// that opened neither).
test('closed, the keys list and reader settings keep nothing of the reader: after leaving it, as many DOM nodes as after a visit that opened neither', { skip: !chromePath() }, async (t) => {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('shiori-reader-nav', 'top');
    localStorage.setItem('shiori-reader-pin', '1');
    localStorage.setItem('shiori:readerMode', JSON.stringify('single'));
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
  });
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  const cdp = await page.createCDPSession();
  await cdp.send('HeapProfiler.enable');
  const nodes = async () => {
    let least = Infinity;
    for (let i = 0; i < 4; i++) {
      await cdp.send('HeapProfiler.collectGarbage');
      least = Math.min(least, (await cdp.send('Memory.getDOMCounters')).nodes);
      await sleep(60);
    }
    return least;
  };
  const visit = async (open) => {
    await page.evaluate((href) => { const a = Object.assign(document.createElement('a'), { href }); document.body.append(a); a.click(); a.remove(); }, `/reader?g=${GALLERY}&page=2`);
    await until(page, () => document.getElementById('mainImg')?.naturalWidth > 0, null, { what: 'the reader' });
    await sleep(300);
    for (const [key, part] of open) {
      if (key === 'gear') await page.click('#readerSettingsBtn'); else await page.keyboard.press(key);
      await until(page, (sel) => !!document.querySelector(sel), part, { what: part });
      await page.keyboard.press('Escape');
      await until(page, (sel) => !document.querySelector(sel), part, { what: `${part} closed` });
    }
    await page.goBack();
    await until(page, () => !document.querySelector('.reader-frame') && !!document.getElementById('tkList'), null, { what: 'Tasks again' });
    await sleep(300);
    return nodes();
  };
  const plain = await visit([]);
  const opened = await visit([['?', S.open], ['gear', '[data-reader-part="settings"]']]);
  // (Chrome itself holds the element last pressed by the pointer, here the gear in the frame left, until
  // the next press: a press on Tasks, as a person makes, lets it go.)
  await page.mouse.click(5, 300);
  await sleep(200);
  const pressed = await nodes();
  assert.ok(pressed - plain < 40, `after the keys list and reader settings ${pressed} nodes (${opened} before a press), after neither ${plain}`);
});

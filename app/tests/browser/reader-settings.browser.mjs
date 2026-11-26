// reader-settings.browser.mjs — Reader settings (the top bar's gear, or the rail's): what each of the
// reader's keys does while it is open, how it opens and closes and where the focus goes, the tab it
// opens on, its box under a slow CPU (its top never moves; what shows never changes after its first
// frame), and that leaving the reader with it open, or a picker open, leaves nothing. Whether it is
// open is read from what draws it (S below).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const GALLERY = '1790000000991';
const COUNT = 8;
let server, origin, browser;

// What draws the dialog.
const S = {
  open: '#readerSettingsModal.show',
  top: '.reader-settings-top',
  close: '#readerSettingsClose',
  tab: (name) => `[role="tab"][data-rs-tab="${name}"]`,
  panel: (name) => `[data-rs-panel="${name}"]`,
  heading: '[data-rs-panel="reading"] .rs-heading',
  picker: '#rsPicker:not([hidden])',
  cell: '#rsPicker [data-edge]',
};

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async ({ gid, count }) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'Settings fixture' }, numPages: count });
    const canvas = new OffscreenCanvas(600, 900);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#89a';
    ctx.fillRect(0, 0, 600, 900);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    for (let n = 1; n <= count; n++) await api.pages.put(gid, n, blob);
  }, { gid: GALLERY, count: COUNT });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reader(t, { mode = 'single', nav = 'top', at = 2, fit = 'height' } = {}) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument((o) => {
    if (sessionStorage.getItem('fixture-set')) return;
    sessionStorage.setItem('fixture-set', '1');
    sessionStorage.setItem('fixture', JSON.stringify(o));
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
// Opened by a press of the pointer on its button, as a person opens it.
async function openSettings(page, tab) {
  const button = await page.evaluate(() => (document.body.classList.contains('reader-side-nav') ? '#snSettings' : '#readerSettingsBtn'));
  await page.click(button);
  await until(page, (sel) => !!document.querySelector(sel), S.open, { what: 'reader settings' });
  if (tab) await page.click(S.tab(tab));
}
// What the reader shows: everything a key below changes.
const state = (page) => page.evaluate(() => ({
  mode: document.getElementById('modeToggle').dataset.state,
  page: document.getElementById('pageCounter').textContent.trim(),
  zoom: document.getElementById('snZoomValue').textContent,
  fit: document.body.classList.contains('reader-fit-width') ? 'width' : document.body.classList.contains('reader-fit-height') ? 'height' : 'off',
  thumbs: document.body.classList.contains('thumbs-open'),
  hidden: document.body.classList.contains('reader-controls-hidden') || document.documentElement.classList.contains('reader-controls-hidden'),
  unpinned: document.body.classList.contains('reader-unpinned') || document.body.classList.contains('reader-nav-auto'),
  cover: localStorage.getItem('shiori:readerCoverOffset'),
  scroll: Math.round(scrollY),
}));

test("keys with reader settings open: each of the reader's keys does what it does with them closed, and they stay open", { skip: !chromePath() }, async (t) => {
  // Each key, from the same start, once with the settings closed and once with them open: opened by the
  // pointer, and a press on nothing in the box (its first heading), so that no control has the focus.
  const KEYS = [['2'], ['3'], ['ArrowRight'], ['d'], ['ArrowLeft'], ['a'], [' '], ['End'], ['Home'], ['='], ['-'], ['e'], ['q'],
    ['Shift', 'E'], ['Shift', 'Q'], ['c'], ['g'], ['x'], ['n']];
  const page = await reader(t);
  for (const keys of KEYS) {
    const press = async () => {
      for (const k of keys) await page.keyboard.down(k);
      for (const k of [...keys].reverse()) await page.keyboard.up(k);
      await sleep(250);
      return state(page);
    };
    const reset = async () => {
      await page.evaluate(() => {   // the fixture's settings again: a key's change is saved
        const o = JSON.parse(sessionStorage.getItem('fixture'));
        for (const [k, v] of Object.entries({ 'shiori:readerMode': o.mode, 'shiori:readerFitMode': o.fit, 'shiori:readerPageZoom': 1, 'shiori:readerThumbsOpen': false, 'shiori:readerCoverOffset': false })) localStorage.setItem(k, JSON.stringify(v));
        localStorage.setItem('shiori-reader-pin', '1');
        localStorage.setItem('shiori-reader-side-pin', '1');
      });
      await page.goto(`${origin}/reader?g=${GALLERY}&page=2`, { waitUntil: 'load' });   // (the address follows the page)
      await until(page, () => document.getElementById('mainImg')?.naturalWidth > 0, null, { what: 'the reader' });
      await sleep(300);
    };
    await reset();
    const closed = await press();
    await reset();
    await openSettings(page);
    await page.click(S.heading);
    await sleep(150);
    const open = await press();
    assert.deepEqual(open, closed, `${keys.join('+')}: with the settings open as with them closed`);
    assert.equal(await isOpen(page), true, `${keys.join('+')}: the settings stay open`);
  }
  // K plays and stops in the strip; I opens page properties over them; ? puts the keys list in their place.
  await page.evaluate(() => { localStorage.setItem('shiori:readerMode', '"strip"'); localStorage.setItem('shiori:readerFitMode', '"off"'); localStorage.setItem('shiori-reader-pin', '1'); });
  await page.reload({ waitUntil: 'load' });
  await until(page, () => document.querySelector('#stripView img[src]')?.naturalWidth > 0, null, { what: 'the strip' });
  await sleep(300);
  await openSettings(page, 'reading');
  await page.keyboard.press('k');
  await until(page, () => document.getElementById('snAuto')?.classList.contains('is-on') || document.getElementById('autoBtn').getAttribute('aria-pressed') === 'true', null, { what: 'auto-play' });
  await page.keyboard.press('k');
  await page.keyboard.press('i');
  await until(page, () => !!document.querySelector('[data-reader-part="properties"]'), null, { what: 'page properties' });
  await page.keyboard.press('Escape');
  await until(page, async () => !(await import('/app/js/reader-properties.js')).propertiesOpen(), null, { what: 'page properties closed' });
  assert.equal(await isOpen(page), true, 'Escape closed page properties alone');
  await page.keyboard.press('?');
  assert.deepEqual([await isOpen(page), await page.$eval('#keybindModal', (m) => m.classList.contains('show'))], [false, true], 'the keys list in their place');
});

test('reader settings open on the tab last shown, focus on their close button; closed by the keyboard the focus goes back to their button, after a mouse nowhere', { skip: !chromePath() }, async (t) => {
  for (const nav of ['top', 'side']) {
    const page = await reader(t, { nav });
    const button = nav === 'side' ? 'snSettings' : 'readerSettingsBtn';
    const focus = () => page.evaluate(() => ({ id: document.activeElement?.id || document.activeElement?.tagName, ring: !!document.querySelector(':focus-visible') }));
    await openSettings(page);
    assert.equal(await page.$eval(S.tab('reading'), (tab) => tab.getAttribute('aria-selected')), 'true', `${nav}: Reading first`);
    assert.deepEqual(await focus(), { id: S.close.slice(1), ring: false }, `${nav}: opened by the pointer, the close button has the focus, no ring`);
    await page.click(S.tab('pages'));
    await page.click(S.close);
    await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed' });
    assert.deepEqual(await focus(), { id: 'BODY', ring: false }, `${nav}: closed by the pointer, the focus nowhere`);
    await openSettings(page);
    assert.equal(await page.$eval(S.tab('pages'), (tab) => tab.getAttribute('aria-selected')), 'true', `${nav}: open on the tab last shown`);
    await page.keyboard.press('Escape');
    await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed by Escape' });
    // From the keyboard: Tab to the button, Enter; Escape closes, the focus back on the button.
    await page.keyboard.press('Tab');
    await page.focus(`#${button}`);
    await page.keyboard.press('Enter');
    await until(page, (sel) => !!document.querySelector(sel), S.open, { what: 'opened by Enter' });
    assert.deepEqual(await focus(), { id: S.close.slice(1), ring: true }, `${nav}: opened by a key, the close button rung`);
    await page.keyboard.press('Escape');
    await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed by Escape' });
    assert.equal((await focus()).id, button, `${nav}: the focus back on the button that opened them`);
  }
});

test('the box under a CPU six times slower, the first opening and the next: its top never moves and what shows never changes after its first frame, at each tab', { skip: !chromePath() }, async (t) => {
  for (const nav of ['top', 'side']) {
    const page = await reader(t, { nav });
    await (await page.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const watch = () => page.evaluate((S) => new Promise((resolve) => {
      const seen = []; const t0 = performance.now();
      const tick = () => {
        const top = document.querySelector(S.top), panel = document.querySelector('[role="tabpanel"]:not([hidden]):not(.rs-panel:not(.active)):not([data-hidden])');
        if (top && panel && top.getBoundingClientRect().height) {
          const key = `${top.getBoundingClientRect().top},${top.getBoundingClientRect().height},${panel.getBoundingClientRect().bottom}`;
          if (seen.at(-1) !== key) seen.push(key);
        }
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else resolve(seen);
      };
      requestAnimationFrame(tick);
    }), S);
    const tops = [];
    for (const time of ['first', 'next']) {
      const seen = watch();
      await openSettings(page);
      const frames = await seen;
      assert.equal(frames.length, 1, `${nav}, ${time} opening: the box changed after it showed: ${frames.join(' → ')}`);
      tops.push(frames[0].split(',')[0]);
      for (const tab of ['pages', 'display', 'reading']) {
        const shown = watch();
        await page.click(S.tab(tab));
        const at = await shown;
        assert.ok(at.length <= 2, `${nav}, ${time}, ${tab}: more than one change: ${at.join(' → ')}`);
        tops.push(...at.map((k) => k.split(',')[0]));
      }
      await page.keyboard.press('Escape');
      await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed' });
    }
    assert.equal(new Set(tops).size, 1, `${nav}: the top stayed: ${[...new Set(tops)]}`);
  }
});

test('leaving the reader with reader settings open, a picker open, or after both were opened and closed, leaves nothing of them', { skip: !chromePath() }, async (t) => {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('shiori-reader-nav', 'side');
    localStorage.setItem('shiori-reader-side-pin', '1');
    localStorage.setItem('shiori:readerMode', JSON.stringify('single'));
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
  });
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  for (const how of ['open', 'picker', 'closed']) {
    await page.evaluate((href) => { const a = Object.assign(document.createElement('a'), { href }); document.body.append(a); a.click(); a.remove(); }, `/reader?g=${GALLERY}&page=2`);
    await until(page, () => document.getElementById('mainImg')?.naturalWidth > 0, null, { what: 'the reader' });
    await sleep(300);
    await openSettings(page, 'display');
    if (how !== 'open') {
      await page.click('#readerNavPlace');
      await until(page, (sel) => document.querySelectorAll(sel).length > 0, S.cell, { what: 'the picker' });
    }
    if (how === 'closed') {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await until(page, (sel) => !document.querySelector(sel), S.open, { what: 'closed' });
    }
    await page.goBack();
    await until(page, () => !document.querySelector('.reader-frame') && !!document.getElementById('tkList'), null, { what: 'Tasks again' });
    await sleep(300);
    const left = await page.evaluate((S) => ({
      dialog: document.querySelectorAll(`${S.open}, ${S.picker}, [data-reader-part], [data-slot="dialog-backdrop"], [data-slot="dialog-viewport"]`).length,
      cells: document.querySelectorAll('[data-edge]').length,
    }), S);
    assert.deepEqual(left, { dialog: 0, cells: 0 }, `left ${how}`);
  }
});

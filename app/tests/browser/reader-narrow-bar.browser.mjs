// reader-narrow-bar.browser.mjs — the reader's classic top bar at 400px wide and under (the owner's
// design, A3, chosen 2026-11-26; plans/frontend-react-probes/reader-a3/mock.html): one flat band, at most
// five 44px buttons (Home, the first three of Translate, Study, Thumbnails, Auto-scroll and Reader
// settings that the gallery has, "⋯"), the page number as text; the rest in the "⋯" list, headed by the
// gallery's number and title, with the reading mode's three choices, Pin header, the keys (with a mouse)
// and the page menu's Overview and Settings under "Go to". For the mock's three galleries, at its three
// widths, with a mouse and on a touch screen; what its rows do; the window crossing 400px each way; long
// words and a long page number; a short window; the keyboard. Wider than 400px the bar is as it was
// (reader-sidenav's and reader-styles' tests, and the captures, hold that).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const G = { ts: '1790000000961', t: '1790000000962', plain: '1790000000963' };
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async (G) => {
    const api = await import('/app/js/api.js');
    const canvas = new OffscreenCanvas(600, 900);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#8a9';
    ctx.fillRect(0, 0, 600, 900);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    // A translation with study layers; a translation without; neither.
    for (const [kind, gid] of Object.entries(G)) {
      await api.meta.put({ galleryId: gid, title: { english: `A Long Gallery Title That Runs Past the Edge (${kind})` }, numPages: 4, translated: kind !== 'plain' });
      for (let n = 1; n <= 4; n++) {
        await api.pages.put(gid, n, blob);
        if (kind === 'plain') continue;
        await api.derived.putTranslation(gid, n, { image: blob, pipeline: { job: 'j1', lines: [], read: [], regions: [] } });
        if (kind !== 'ts') continue;
        const a = { x: 0.1, y: 0.3, w: 0.5, h: 0.15 };
        await api.derived.putStudy(gid, n, { bg: blob, page: { w: 600, h: 900 }, bubbles: [{ id: 0, box: a, region: a, tr: 'Hello', src: 'こんにちは', text: blob }] }, 'j1');
      }
    }
  }, G);
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The reader at page 2 of a gallery, single page, the classic bar pinned, sized before it loads.
async function reader(t, kind, viewport, { lang = 'en' } = {}) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument((lang) => {
    if (sessionStorage.getItem('fixture-set')) return;
    sessionStorage.setItem('fixture-set', '1');
    localStorage.setItem('shiori-lang', lang);
    localStorage.setItem('shiori-reader-nav', 'top');
    localStorage.setItem('shiori-reader-pin', '1');
    localStorage.setItem('shiori:readerMode', JSON.stringify('single'));
    localStorage.setItem('shiori:readerFitMode', JSON.stringify('height'));
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
    localStorage.setItem('shiori:readerView', '"off"');
  }, lang);
  await page.goto(`${origin}/reader?g=${G[kind]}&page=2`, { waitUntil: 'load' });
  await until(page, () => document.getElementById('mainImg')?.naturalWidth > 0 && getComputedStyle(document.getElementById('loadingScreen')).display === 'none', null, { what: 'a page drawn' });
  // What the gallery has is known once its study layers are (read while the reader is idle).
  if (kind === 'ts') await until(page, () => !document.getElementById('studySeg').classList.contains('disabled'), null, { what: 'study known' });
  await sleep(250);
  return page;
}

// The bar as it shows, left to right: each thing drawn there that can be pressed (Home is the logo).
const bar = (page) => page.evaluate(() => {
  const name = (el) => (el.classList.contains('brand-wrap') ? 'home' : el.id);
  return [...document.querySelectorAll('#topbar > :is(a, button), #topbar > #viewToggle > button')]
    .filter((el) => el.getClientRects().length && !el.closest('.tb-extra'))
    .map((el) => { const r = el.getBoundingClientRect(); return { name: name(el), x: r.left, w: r.width, h: r.height, border: getComputedStyle(el).borderTopWidth }; })
    .sort((a, b) => a.x - b.x);
});
// The list's rows as they show, top to bottom: their names, sizes, and what each says.
const list = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#topbar .tb-rows > *:not(.tb-go), #topbar .tb-go > a')].filter((el) => el.getClientRects().length);
  return rows.map((el) => {
    const r = el.getBoundingClientRect();
    const said = (el.id === 'modeToggle' ? getComputedStyle(el, '::before').content : getComputedStyle(el, '::after').content).replace(/^"|"$/g, '');
    return { name: el.id || el.dataset.pageLink, top: r.top, left: r.left, right: r.right, h: r.height, said: said === 'none' || said === 'normal' ? el.textContent.trim() : said };
  }).sort((a, b) => a.top - b.top);
});
const openList = async (page) => {
  await page.click('#tbMenuBtn');
  await until(page, () => document.getElementById('topbar').classList.contains('menu-open'), null, { what: 'the list' });
  await sleep(100);
};

const CASES = {
  ts: { bar: ['home', 'translateSeg', 'studySeg', 'thumbBtn', 'tbMenuBtn'], list: ['tbMeta', 'modeToggle', 'autoBtn', 'readerSettingsBtn', 'readerPinBtn', 'keybindBtn', 'overview', 'settings'] },
  t: { bar: ['home', 'translateSeg', 'thumbBtn', 'autoBtn', 'tbMenuBtn'], list: ['tbMeta', 'modeToggle', 'readerSettingsBtn', 'readerPinBtn', 'keybindBtn', 'overview', 'settings'] },
  plain: { bar: ['home', 'thumbBtn', 'autoBtn', 'readerSettingsBtn', 'tbMenuBtn'], list: ['tbMeta', 'modeToggle', 'readerPinBtn', 'keybindBtn', 'overview', 'settings'] },
};

test('at 400px and under the bar is one band of five 44px buttons, the first three the gallery has between Home and "⋯", the rest in the list; for a finger as for a mouse', { skip: !chromePath() }, async (t) => {
  for (const kind of Object.keys(CASES)) {
    for (const width of [390, 360, 320]) {
      for (const touch of [false, true]) {
        const what = `${kind}, ${width}px, ${touch ? 'touch' : 'mouse'}`;
        const page = await reader(t, kind, { width, height: 760, hasTouch: touch, isMobile: touch });
        const shown = await bar(page);
        assert.deepEqual(shown.map((b) => b.name), CASES[kind].bar, `${what}: the bar's buttons`);
        for (const b of shown) assert.deepEqual([b.w, b.h, b.border], [44, 44, '0px'], `${what}: ${b.name} 44px, nothing round it`);
        const band = await page.$eval('#topbar', (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, height: r.height, width: innerWidth, text: document.getElementById('pageCounter').getClientRects().length > 0 && document.getElementById('pageCounter').localName }; });
        assert.deepEqual([band.left, band.right, band.top, band.height], [0, band.width, 0, 54], `${what}: a band across the whole top, as tall as the bar`);
        assert.equal(band.text, 'span', `${what}: the page number as text`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${what}: nothing past the window's side`);
        await openList(page);
        const rows = await list(page);
        const want = CASES[kind].list.filter((n) => !(touch && n === 'keybindBtn'));
        assert.deepEqual(rows.map((r) => r.name), want, `${what}: the list's rows`);
        for (const r of rows) assert.ok(r.h >= 44, `${what}: ${r.name} ${r.h}px tall`);
        const panel = await page.$eval('#topbar .tb-extra', (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, w: r.width }; });
        assert.ok(panel.left >= 0 && panel.right <= width && panel.bottom <= 760, `${what}: the list inside the window: ${JSON.stringify(panel)}`);
        assert.equal(panel.w, 272, `${what}: the list 272px wide`);
        const choices = await page.$$eval('#modeToggle > .seg', (s) => s.map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; }));
        assert.deepEqual(choices, [[44, 44], [44, 44], [44, 44]], `${what}: the reading mode's three choices side by side, 44px`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${what}: nothing past the window's side with the list open`);
      }
    }
  }
});

test('the list says what each row is: the gallery\'s number and title, Reader mode, Auto-scroll, Reader settings as sliders, Pin header, the keys, and the page menu\'s pages under "Go to", each with its icon', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, 'ts', { width: 390, height: 760 });
  await openList(page);
  const said = Object.fromEntries((await list(page)).map((r) => [r.name, r.said.replace(/\s+/g, ' ')]));
  assert.deepEqual(said, {
    tbMeta: `#${G.ts} A Long Gallery Title That Runs Past the Edge (ts)`, modeToggle: 'Reader mode', autoBtn: 'Auto-scroll', readerSettingsBtn: 'Reader settings',
    readerPinBtn: 'Unpin header', keybindBtn: 'Keyboard shortcuts', overview: 'Overview', settings: 'Settings',
  });
  assert.equal(await page.$eval('#topbar .tb-go', (el) => getComputedStyle(el, '::before').content), '"Go to"');
  const icons = await page.evaluate(() => [...document.querySelectorAll('#topbar .tb-rows :is(.tb-btn, .tb-row) > svg')].filter((s) => s.getClientRects().length).map((s) => s.closest('[id], [data-page-link]').id || s.closest('[data-page-link]').dataset.pageLink));
  assert.deepEqual(icons, ['autoBtn', 'readerSettingsBtn', 'readerPinBtn', 'keybindBtn', 'overview', 'settings'], 'each row its icon');
  // Reader settings is the sliders here (on the bar too), where wider it is the gear; one gear in the list.
  const gear = (page) => page.$eval('#readerSettingsBtn', (b) => [...b.querySelectorAll('svg')].map((s) => s.getClientRects().length > 0));
  assert.deepEqual(await gear(page), [false, true], 'sliders in the narrow bar');
  await page.setViewport({ width: 1280, height: 760 });
  await sleep(200);
  assert.deepEqual(await gear(page), [true, false], 'the gear wider');
});

test('the list\'s rows do what the bar\'s buttons do, and a press on one puts the list away', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, 'ts', { width: 390, height: 760 });
  const mode = () => page.$eval('#modeToggle', (m) => m.dataset.state);
  await openList(page);
  await page.click('#modeDouble');
  await until(page, () => document.getElementById('modeToggle').dataset.state === 'double', null, { what: 'double page' });
  assert.equal(await page.$eval('#topbar', (b) => b.classList.contains('menu-open')), false, 'the list put away');
  await openList(page);
  await page.click('#modeSingle');
  await until(page, () => document.getElementById('modeToggle').dataset.state === 'single', null, { what: 'single page' });
  assert.equal(await mode(), 'single');
  await openList(page);
  await page.click('#autoBtn');
  await until(page, () => document.getElementById('autoBtn').getAttribute('aria-pressed') === 'true', null, { what: 'auto-play' });
  await openList(page);
  assert.equal(await page.$eval('#autoBtn', (b) => getComputedStyle(b, '::after').content), '"Stop auto-scroll"', 'playing, the row says Stop');
  assert.equal(await page.$eval('#autoBtn', (b) => getComputedStyle(b).color), await page.$eval('#modeSingle', (b) => getComputedStyle(b).color), 'and is in the accent, as the reading mode chosen');
  await page.click('#autoBtn');
  await until(page, () => document.getElementById('autoBtn').getAttribute('aria-pressed') === 'false', null, { what: 'auto-play stopped' });
  await openList(page);
  await page.click('#readerSettingsBtn');
  await until(page, () => !!document.querySelector('[data-reader-part="settings"]'), null, { what: 'reader settings' });
  await page.keyboard.press('Escape');
  await until(page, () => !document.querySelector('[data-reader-part="settings"]'), null, { what: 'closed' });
  await openList(page);
  await page.click('#keybindBtn');
  await until(page, () => !!document.querySelector('[data-reader-part="keys"]'), null, { what: 'the keys list' });
  await page.keyboard.press('Escape');
  await until(page, () => !document.querySelector('[data-reader-part="keys"]'), null, { what: 'closed' });
  // On the bar: Translate and Study light in the accent when on.
  await page.click('#translateSeg');
  await until(page, () => document.getElementById('translateSeg').classList.contains('active'), null, { what: 'translate on' });
  await until(page, () => document.getElementById('translateSeg').getAnimations().length === 0, null, { what: 'its colour eased in' });   // (read mid-ease under load it was still the white)
  const on = await page.$eval('#translateSeg', (b) => [getComputedStyle(b).color, getComputedStyle(b).backgroundColor]);
  const off = await page.$eval('#studySeg', (b) => getComputedStyle(b).color);
  assert.notEqual(on[0], off, 'what is on is in the accent');
  assert.equal(off, 'rgb(244, 244, 245)', 'the rest white');
  // Go to: Overview and Settings, a change of route as the page menu's.
  await openList(page);
  await page.click('[data-page-link="settings"]');
  await until(page, () => location.pathname === '/settings' && !document.querySelector('.reader-frame'), null, { what: 'Settings' });
  await page.goBack();
  await until(page, () => document.getElementById('mainImg')?.naturalWidth > 0, null, { what: 'the reader again' });
  await sleep(300);
  await openList(page);
  await page.click('[data-page-link="overview"]');
  await until(page, (g) => location.pathname === '/overview' && new URLSearchParams(location.search).get('g') === g, G.ts, { what: 'the overview' });
});

test('the window crossing 400px puts every control where the bar it shows has it, each way, and the wide bar folds as before', { skip: !chromePath() }, async (t) => {
  const order = (page) => page.evaluate(() => [...document.querySelectorAll('#topbar [id]')].map((el) => `${el.parentElement.id || el.parentElement.className}>${el.id}`).join(' '));
  const shown = (page) => page.evaluate(() => [...document.querySelectorAll('#topbar button, #topbar a, #topbar select')].filter((el) => el.getClientRects().length).map((el) => el.id || el.className).join(' '));
  for (const kind of ['ts', 'plain']) {
    const wide = await reader(t, kind, { width: 1280, height: 760 });
    const narrow = await reader(t, kind, { width: 390, height: 760 });
    const mid = await reader(t, kind, { width: 560, height: 760 });
    const at = { wide: await order(wide), narrow: await order(narrow), shownWide: await shown(wide), shownNarrow: await shown(narrow), shownMid: await shown(mid) };
    // (A tab behind another draws nothing, and is told of no change of the window: each in front in its turn.)
    await narrow.bringToFront();
    await narrow.setViewport({ width: 1280, height: 760 });
    await sleep(200);
    assert.equal(await order(narrow), at.wide, `${kind}: 390 → 1280, where a bar loaded at 1280 has them`);
    assert.equal(await shown(narrow), at.shownWide, `${kind}: 390 → 1280, the same shown`);
    await narrow.setViewport({ width: 560, height: 760 });
    await sleep(200);
    assert.equal(await shown(narrow), at.shownMid, `${kind}: 1280 → 560, folded as a bar loaded at 560`);
    await wide.bringToFront();
    await wide.setViewport({ width: 390, height: 760 });
    await sleep(200);
    assert.equal(await order(wide), at.narrow, `${kind}: 1280 → 390, where a bar loaded at 390 has them`);
    assert.equal(await shown(wide), at.shownNarrow, `${kind}: 1280 → 390, the same shown`);
    const moving = await wide.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.('#topbar')).map((a) => a.transitionProperty));
    assert.deepEqual(moving, [], `${kind}: nothing of the bar eases into its narrow form`);
  }
});

test('long words and a long page number: at 320px nothing goes past the window, the page number shortens, the buttons stay 44px, a long row name takes a second line', { skip: !chromePath() }, async (t) => {
  for (const lang of ['en', 'es', 'de', 'ru', 'vi']) {
    const page = await reader(t, 'ts', { width: 320, height: 760 }, { lang });
    await page.evaluate(() => { document.getElementById('pageCounter').textContent = '1234 / 1234'; });
    await sleep(100);
    const shown = await bar(page);
    for (const b of shown) assert.deepEqual([b.w, b.h], [44, 44], `${lang}: ${b.name} 44px`);
    assert.equal(shown.length, 5, `${lang}: five buttons`);
    const counter = await page.$eval('#pageCounter', (el) => ({ fits: el.scrollWidth <= el.clientWidth, right: el.getBoundingClientRect().right }));
    assert.ok(counter.right <= shown[1].x + 0.5, `${lang}: the page number ends before the buttons`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${lang}: nothing past the window's side`);
    await page.keyboard.press('k');   // its row then says Stop, the longer name
    await openList(page);
    const rows = await list(page);
    const panel = await page.$eval('#topbar .tb-extra', (el) => el.getBoundingClientRect().toJSON());
    for (const r of rows) assert.ok(r.left >= panel.left && r.right <= panel.right + 0.5 && r.h >= 44, `${lang}: ${r.name} inside the list, 44px at least (${r.h})`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${lang}: nothing past the window's side, the list open`);
  }
});

test('in a short window the list\'s rows scroll in a box of their own that ends where its corners begin to curve, the list inside the window', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, 'ts', { width: 360, height: 300 });
  await openList(page);
  const m = await page.evaluate(() => {
    const panel = document.querySelector('#topbar .tb-extra'), rows = document.querySelector('#topbar .tb-rows');
    const p = panel.getBoundingClientRect(), r = rows.getBoundingClientRect();
    return { scrolls: rows.scrollHeight > rows.clientHeight, top: r.top - p.top, bottom: p.bottom - r.bottom, radius: parseFloat(getComputedStyle(panel).borderTopRightRadius), panelScrolls: panel.scrollHeight > panel.clientHeight, inside: p.bottom <= innerHeight };
  });
  assert.equal(m.scrolls, true, 'its rows scroll');
  assert.equal(m.panelScrolls, false, 'the panel itself does not');
  assert.ok(m.top >= m.radius - 1 && m.bottom >= m.radius - 1, `the box that scrolls ${m.top}px and ${m.bottom}px from the panel's ends, its rounding ${m.radius}`);
  assert.equal(m.inside, true, 'the list inside the window');
});

test('a narrow window with a mouse: the list\'s rows are reached by the keyboard as the panel\'s were, from "⋯" back, and Enter presses one', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, 'plain', { width: 390, height: 760 });
  await page.focus('#tbMenuBtn');
  await page.keyboard.press('Tab');
  await page.focus('#tbMenuBtn');
  await page.keyboard.press('Enter');
  await until(page, () => document.getElementById('topbar').classList.contains('menu-open'), null, { what: 'the list' });
  const walk = [];
  for (let k = 0; k < 5; k++) {
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    walk.push(await page.evaluate(() => document.activeElement.id || document.activeElement.dataset.pageLink));
  }
  assert.deepEqual(walk, ['settings', 'overview', 'keybindBtn', 'readerPinBtn', 'modeStrip'], 'Shift+Tab walks up the rows from "⋯"');
  await page.keyboard.press('Enter');
  await until(page, () => document.getElementById('modeToggle').dataset.state === 'strip', null, { what: 'Enter on a choice' });
});

test('page properties on a phone with a translated gallery is as wide as the window: the bar no longer widens the page', { skip: !chromePath() }, async (t) => {
  const page = await reader(t, 'ts', { width: 390, height: 844, hasTouch: true, isMobile: true });
  assert.equal(await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth]).then((a) => a.join()), '390,390', 'the page as wide as the window');
  await page.keyboard.press('i');
  await until(page, () => document.querySelectorAll('[data-reader-part="properties"] [data-pp="section"]').length > 1, null, { what: 'page properties' });
  const box = await page.$eval('[data-reader-part="properties"]', (el) => { const r = el.getBoundingClientRect(); return [r.left, Math.round(innerWidth - r.right), innerWidth]; });
  assert.deepEqual(box, [8, 8, 390], 'page properties 8px from the window\'s sides');
});

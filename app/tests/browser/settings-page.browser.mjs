// settings-page.browser.mjs — Settings as the one page draws it (src/routes/settings.tsx), at its
// address beside 1.3's page until it takes /settings. One table of every preference control: its key,
// its control, what it shows of each stored value and what a change stores, held against 1.3's page
// and the new one alike, so the two are seen to agree; each control showing its saved value in the
// first frame drawn; another tab's change followed for every key; a hidden panel kept; the status
// line's 2.5 s; a change of language; the About dialog; the header kept across routes; leaving the page
// five times leaves nothing behind; the experimental section where it can work, and its switch applied
// at once; the study preview following its controls; the phone form.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const ADDRESS = '/settings-next';   // step 5c: '/settings'
const OLD = '/settings';            // 1.3's page, while it answers /settings

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

// Every control of the two panels: its key and the id of its control (a switch's checkbox, a select,
// a segmented choice), the panel it is on, what it shows of stored values ([raw string, shown]; a
// missing raw is nothing stored), and a change: [the value chosen, the raw string stored]. A choice's
// labels (to pick one in the new page's list) are its values' English names.
const TABLE = [
  { key: 'libShowNavStats', kind: 'switch', shows: [[null, true], ['false', false], ['true', true]], change: [false, 'false'] },
  { key: 'libMergeSeries', kind: 'switch', shows: [[null, true], ['false', false], ['true', true]], change: [false, 'false'] },
  { key: 'libQuickActionsMode', kind: 'select', shows: [[null, 'hover'], ['"always"', 'always'], ['"sideways"', 'hover']], change: ['hidden', '"hidden"'],
    labels: { hover: 'Show on hover', always: 'Always visible', hidden: 'Hidden' } },
  { key: 'libHideAppLangFlag', id: 'libAppLangFlag', kind: 'switch', shows: [[null, true], ['false', false], ['true', true]], change: [false, 'false'] },
  { key: 'libShowCategoryTag', kind: 'switch', shows: [[null, true], ['false', false], ['true', true]], change: [false, 'false'] },
  { key: 'libExportFormat', kind: 'select', shows: [[null, 'ask'], ['"cbz"', 'cbz'], ['"rar"', 'ask']], change: ['zip', '"zip"'],
    labels: { ask: 'Ask each time', zip: 'ZIP', cbz: 'CBZ' } },
  { key: 'libExportTranslations', kind: 'switch', shows: [[null, true], ['false', false], ['true', true]], change: [false, 'false'] },
  { key: 'customScrollbar', kind: 'switch', shows: [[null, false], ['true', true], ['false', false]], change: [true, 'true'] },
  { key: 'readerSkipOverview', panel: 'navReader', kind: 'switch', shows: [[null, true], ['true', false], ['false', true]], change: [false, 'true'] },
  { key: 'readerStripMode', panel: 'navReader', kind: 'switch', shows: [[null, true], ['"chapter"', false], ['"series"', true]], change: [false, '"chapter"'] },
  { key: 'readerChapterDivider', panel: 'navReader', kind: 'switch', shows: [[null, true], ['false', false], ['true', true]], change: [false, 'false'] },
  { key: 'readerTranslateDisplay', panel: 'navReader', kind: 'choice', values: ['image', 'text'], shows: [[null, 'image'], ['"text"', 'text'], ['"other"', 'image']], change: ['text', '"text"'] },
  // (The original as text first: the font and furigana are its options, and can be changed only then.)
  { key: 'readerStudyOriginal', panel: 'navReader', kind: 'choice', values: ['image', 'text'], shows: [[null, 'image'], ['"text"', 'text'], ['"image"', 'image']], change: ['text', '"text"'] },
  { key: 'readerStudySrcFont', panel: 'navReader', kind: 'select', shows: [[null, 'yasashisa'], ['"kiwi"', 'kiwi'], ['"other"', 'yasashisa']], change: ['kiwi', '"kiwi"'],
    labels: { yasashisa: 'やさしさアンチック', kiwi: 'Kiwi Maru' } },
  { key: 'readerFurigana', panel: 'navReader', kind: 'switch', shows: [[null, false], ['"on"', true], ['"off"', false]], change: [true, '"on"'] },
  { key: 'readerStudyDisplay', panel: 'navReader', kind: 'choice', values: ['hardcoded_images', 'text'], shows: [[null, 'hardcoded_images'], ['"text"', 'text'], ['"hardcoded_images"', 'hardcoded_images']], change: ['text', '"text"'] },
];
const idOf = (row) => row.id ?? row.key;

// What each control shows, read in the page: a switch's checkbox (1.3's, and the new switch's hidden
// one, both by the id), a select's value (1.3's <select>; the new one's box says it in data-value, and
// shows its label), a segmented choice's (1.3's hidden <select>; the new group's data-value, its
// pressed item the one).
const SHOWN = (rows) => Object.fromEntries(rows.map(({ id, kind, values, labels }) => {
  const el = document.getElementById(id);
  if (!el) return [id, 'missing'];
  if (kind === 'switch') return [id, el.checked];
  if (el.tagName === 'SELECT') return [id, el.value];
  const value = el.dataset.value;
  if (kind === 'select' && labels && !el.textContent.includes(labels[value])) return [id, `${value}, showing "${el.textContent}"`];
  if (kind === 'choice') {
    const pressed = [...el.querySelectorAll('[data-slot="toggle-group-item"]')].findIndex((b) => b.getAttribute('aria-pressed') === 'true');
    if (values[pressed] !== value) return [id, `${value}, pressed ${pressed}`];
  }
  return [id, value];
}));
const rowsForPage = () => TABLE.map((row) => ({ id: idOf(row), kind: row.kind, values: row.values, labels: row.labels }));

async function open(t, path, { viewport, storage } = {}) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  if (viewport) await page.setViewport(viewport);
  await page.evaluateOnNewDocument((storage) => {
    if (!storage || sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    for (const key of Object.keys(localStorage)) if (key.startsWith('shiori:') || key === 'shiori-lang') localStorage.removeItem(key);
    for (const [key, raw] of Object.entries(storage)) localStorage.setItem(key, raw);
  }, storage ?? null);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await drawn(page, path);
  return page;
}
const drawn = (page, path) => until(page, (old) => (old ? document.querySelectorAll('#langSelect option').length > 1 : !!document.querySelector('#settingsNav .nav-item'))
  && document.getElementById('libMergeSeries') && document.title === 'Shiori — Settings', path === OLD, { what: 'the Settings page' });

const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
async function showPanel(page, nav) {
  await page.click(`#${nav}`);
  await until(page, (nav) => document.getElementById(nav).classList.contains('active') && document.getElementById(document.getElementById(nav).dataset.panel).classList.contains('active'), nav, { what: nav });
}

// Drives the control of `row` to `value`, on 1.3's page or the new one.
async function choose(page, row, value, old) {
  const id = idOf(row);
  if (row.panel) await showPanel(page, row.panel); else await showPanel(page, 'navLibrary');
  if (row.kind === 'switch') {
    if (old) await page.click(`label[for="${id}"]`);
    else await (await page.evaluateHandle((id) => document.getElementById(id).parentElement.querySelector('[role="switch"]'), id)).click();
  } else if (row.kind === 'choice') {
    if (old) await page.click(`[data-choice-for="${id}"] [data-value="${value}"]`);
    else await page.click(`#${id} [data-slot="toggle-group-item"]:nth-of-type(${row.values.indexOf(value) + 1})`);
  } else if (old) {
    await page.select(`#${id}`, value);
  } else {
    await page.click(`#${id}`);
    await page.waitForSelector('[data-slot="select-list"] [data-slot="select-option"]');
    await new Promise((r) => setTimeout(r, 300));   // (a press in the list's first moments is not taken as a choice)
    const option = await page.evaluateHandle((label) => [...document.querySelectorAll('[data-slot="select-list"] [data-slot="select-option"]')].find((o) => o.textContent === label), row.labels[value]);
    await option.click();
    await until(page, (id) => !document.getElementById(id).hasAttribute('data-popup-open'), id, { what: 'the list closed' });
  }
}

for (const [name, path] of [['1.3\'s page', OLD], ['the new page', ADDRESS]]) {
  const old = path === OLD;
  test(`the table, on ${name}: what each control shows of each stored value`, async (t) => {
    for (let i = 0; i < 3; i++) {
      const storage = Object.fromEntries(TABLE.filter((row) => row.shows[i][0] !== null).map((row) => [`shiori:${row.key}`, row.shows[i][0]]));
      const page = await open(t, path, { storage });
      if (!page) return;
      const shown = await page.evaluate(SHOWN, rowsForPage());
      assert.deepEqual(shown, Object.fromEntries(TABLE.map((row) => [idOf(row), row.shows[i][1]])), `stored: ${JSON.stringify(storage)}`);
      assert.deepEqual(page.problems, []);
    }
  });

  test(`the table, on ${name}: a change stores what 1.3 stored, and shows it`, async (t) => {
    const page = await open(t, path, { storage: {} });
    if (!page) return;
    for (const row of TABLE) {
      await choose(page, row, row.change[0], old);
      const raw = await until(page, (key) => localStorage.getItem(`shiori:${key}`), row.key, { what: `${row.key} stored` });
      assert.equal(raw, row.change[1], `${row.key} ← ${JSON.stringify(row.change[0])}`);
      assert.equal((await page.evaluate(SHOWN, rowsForPage()))[idOf(row)], row.change[0], `${row.key} shows its new value`);
    }
    // The language: its own key, a plain string.
    await showPanel(page, 'navLibrary');
    if (old) await page.select('#langSelect', 'de');
    else await choose(page, { key: 'lang', id: 'langSelect', kind: 'select', labels: { de: 'Deutsch' } }, 'de', false);
    await until(page, () => localStorage.getItem('shiori-lang') === 'de' && document.getElementById('navLibrary').textContent === 'Bibliothek', null, { what: 'German' });
    await page.evaluate(() => localStorage.removeItem('shiori-lang'));
    assert.deepEqual(page.problems, []);
  });
}

test('every control shows its saved value in the first frame the page is drawn', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  const storage = Object.fromEntries(TABLE.map((row) => [`shiori:${row.key}`, row.shows[1][0]]));
  await page.evaluateOnNewDocument((storage, rows, SHOWN) => {
    for (const key of Object.keys(localStorage)) if (key.startsWith('shiori:') || key === 'shiori-lang') localStorage.removeItem(key);
    for (const [key, raw] of Object.entries(storage)) localStorage.setItem(key, raw);
    const shown = new Function(`return (${SHOWN})`)();
    const look = () => {
      if (document.getElementById('libMergeSeries')) { window.__first = shown(rows); return; }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  }, storage, rowsForPage(), SHOWN.toString());
  await page.goto(`${origin}${ADDRESS}`, { waitUntil: 'load' });
  const first = await until(page, () => window.__first, null, { what: 'the first frame with the controls' });
  assert.deepEqual(first, Object.fromEntries(TABLE.map((row) => [idOf(row), row.shows[1][1]])));
  assert.deepEqual(page.problems, []);
});

test('a change made in another tab is followed, for every key', async (t) => {
  const page = await open(t, ADDRESS, { storage: {} });
  if (!page) return;
  const other = await openPage(browser, origin);
  t.after(() => other.close());
  await other.goto(`${origin}/CHANGELOG.md`, { waitUntil: 'load' });
  await other.evaluate((stored) => { for (const [key, raw] of Object.entries(stored)) localStorage.setItem(key, raw); },
    Object.fromEntries(TABLE.map((row) => [`shiori:${row.key}`, row.shows[1][0]])));
  const want = Object.fromEntries(TABLE.map((row) => [idOf(row), row.shows[1][1]]));
  await until(page, ([rows, want, SHOWN]) => { const now = new Function(`return (${SHOWN})`)()(rows); return Object.keys(want).every((k) => now[k] === want[k]); },
    [rowsForPage(), want, SHOWN.toString()], { what: 'every control following the other tab' });
  // Its storage cleared there: every control back to its default.
  await other.evaluate(() => localStorage.clear());
  const defaults = Object.fromEntries(TABLE.map((row) => [idOf(row), row.shows[0][1]]));
  await until(page, ([rows, want, SHOWN]) => { const now = new Function(`return (${SHOWN})`)()(rows); return Object.keys(want).every((k) => now[k] === want[k]); },
    [rowsForPage(), defaults, SHOWN.toString()], { what: 'the defaults again' });
  assert.deepEqual(page.problems, []);
});

test('a hidden panel is kept, not drawn again: its nodes and their state stay while another shows', async (t) => {
  const page = await open(t, ADDRESS, { storage: {} });
  if (!page) return;
  await page.evaluate(() => { window.__nodes = [...document.querySelectorAll('#panelLibrary *')]; window.__switch = document.getElementById('libMergeSeries'); });
  await showPanel(page, 'navReader');
  const hidden = await page.evaluate(() => ({ library: getComputedStyle(document.getElementById('panelLibrary')).display, reader: getComputedStyle(document.getElementById('panelReader')).display,
    current: [...document.querySelectorAll('#settingsNav .nav-item')].map((b) => [b.dataset.panel, b.getAttribute('aria-current'), b.classList.contains('active')]),
    path: location.pathname }));
  assert.deepEqual(hidden, { library: 'none', reader: 'block', path: ADDRESS, current: [['panelLibrary', null, false], ['panelReader', 'page', true], ['panelTranslation', null, false], ['panelOptional', null, false], ['panelStorage', null, false]] });
  await showPanel(page, 'navLibrary');
  assert.deepEqual(await page.evaluate(() => { const now = [...document.querySelectorAll('#panelLibrary *')]; return { same: now.length === window.__nodes.length && now.every((el, i) => el === window.__nodes[i]), switch: document.getElementById('libMergeSeries') === window.__switch }; }),
    { same: true, switch: true });
  assert.deepEqual(page.problems, []);
});

test('a status line says Saved for 2.5 s, from the last change', async (t) => {
  const page = await open(t, ADDRESS, { storage: {} });
  if (!page) return;
  const look = () => page.evaluate(() => { const s = document.getElementById('libStatus'); return { shown: s.hasAttribute('data-shown'), text: s.textContent, visible: getComputedStyle(s).visibility }; });
  assert.deepEqual(await look(), { shown: false, text: '', visible: 'hidden' });
  await choose(page, TABLE[1], false, false);
  const at = Date.now();
  await new Promise((r) => setTimeout(r, 200));   // (it comes in by its colour, .15 s)
  assert.deepEqual(await look(), { shown: true, text: 'Saved.', visible: 'visible' });
  await new Promise((r) => setTimeout(r, 1500));
  await choose(page, TABLE[1], true, false);   // again: 2.5 s from here
  const again = Date.now();
  await new Promise((r) => setTimeout(r, 2200 - (Date.now() - again)));
  assert.equal((await look()).shown, true, `still there 2.2 s after the second change (${Date.now() - at} ms after the first)`);
  await until(page, () => !document.getElementById('libStatus').hasAttribute('data-shown'), null, { what: 'hidden', timeout: 2000 });
  const gone = Date.now() - again;
  assert.ok(gone >= 2450 && gone < 3300, `hidden ${gone} ms after the change`);
  await new Promise((r) => setTimeout(r, 200));   // (it goes by its colour, .15 s)
  assert.equal((await look()).visible, 'hidden');
  assert.deepEqual(page.problems, []);
});

test('a change of language redraws the whole page in it at once', async (t) => {
  const page = await open(t, ADDRESS, { storage: {} });
  if (!page) return;
  t.after(() => page.evaluate(() => localStorage.setItem('shiori-lang', 'en')).catch(() => {}));
  const words = () => page.evaluate(() => ({ nav: document.getElementById('navLibrary').textContent, about: document.getElementById('aboutBtn').textContent,
    menu: document.getElementById('pageNav').textContent, title: document.querySelector('#panelLibrary [data-slot="card-title"]').textContent,
    quick: document.getElementById('libQuickActionsMode').textContent, lang: document.documentElement.lang }));
  assert.deepEqual(await words(), { nav: 'Library', about: 'About', menu: 'Settings', title: 'Language', quick: 'Show on hover', lang: 'en' });
  await page.evaluate(async () => (await import('/app/js/i18n.js')).setLang('ja'));
  await until(page, () => document.getElementById('navLibrary').textContent === 'ライブラリ', null, { what: 'Japanese' });
  assert.deepEqual(await words(), { nav: 'ライブラリ', about: '情報', menu: '設定', title: '言語', quick: 'ホバー時に表示', lang: 'ja' });
  assert.deepEqual(page.problems, []);
});

test('About: opens with its close focused, the version and the changelog drawn; Escape closes it and focus goes back to About', async (t) => {
  const page = await open(t, ADDRESS);
  if (!page) return;
  await page.click('#aboutBtn');
  const shown = await until(page, () => {
    const box = document.getElementById('aboutBox');
    const log = document.getElementById('aboutChangelog');
    return box && log?.querySelectorAll('h2').length > 2 && document.getElementById('aboutVersion').textContent && {
      role: box.getAttribute('role'), focused: document.activeElement?.id, version: document.getElementById('aboutVersion').textContent,
      title: document.getElementById('aboutTitle').textContent, firstVersion: log.querySelector('h2 .cl-ver')?.textContent, date: !!log.querySelector('h2 .cl-date'),
      heading: log.querySelector('h1') === null, repo: document.getElementById('aboutRepo').href, scrolls: log.scrollHeight > log.clientHeight,
    };
  }, null, { what: 'the About dialog drawn' });
  const manifest = await page.evaluate(async () => (await (await fetch('/app/manifest.webmanifest')).json()).version);
  assert.deepEqual(shown, { role: 'dialog', focused: 'aboutClose', version: `v${manifest}`, title: 'Shiori', firstVersion: shown.firstVersion, date: true, heading: true,
    repo: 'https://github.com/hikarin-dev/shiori/', scrolls: true });
  assert.match(shown.firstVersion, /^v\d+\.\d+\.\d+$/);
  // Focus held inside: Tab from the close goes round to the repository link, not to the page.
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('#aboutBox')), true, 'focus stays in the dialog');
  await page.keyboard.press('Escape');
  await until(page, () => !document.getElementById('aboutBox') && document.activeElement?.id === 'aboutBtn', null, { what: 'closed, focus back on About' });
  assert.deepEqual(page.problems, []);
});

// The frame's header across a route change: the same node, the brand on the same pixels, Settings'
// form on <html> while Settings shows.
test('the header is the frame\'s: /settings-next ↔ /tasks, the same node, the brand unmoved, its form following the route', async (t) => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844, isMobile: true, hasTouch: true }]) {
    const page = await open(t, ADDRESS, { viewport });
    if (!page) return;
    const look = () => page.evaluate(() => {
      const band = document.querySelector('#root > header');
      const r = band.querySelector('.brand-wrap').getBoundingClientRect();
      return { same: window.__band === band, brand: [r.x, r.y, r.width, r.height], form: document.documentElement.dataset.headerForm ?? null,
        page: band.querySelector('#pageNav')?.dataset.page ?? null, right: [...band.querySelector('.header-right').children].map((el) => el.id || el.dataset.slot),
        meta: document.querySelector('meta[name="shiori-app"]')?.content ?? null, padding: getComputedStyle(band).paddingLeft, title: document.title };
    });
    await page.evaluate(() => { window.__band = document.querySelector('#root > header'); window.stayed = true; });
    const settings = await look();
    assert.deepEqual({ ...settings, brand: null }, { same: true, brand: null, form: 'settings', page: 'settings', right: ['aboutBtn'], meta: 'settings',
      padding: viewport.width <= 520 ? '12px' : '20px', title: 'Shiori — Settings' });
    // A plain link to /tasks is followed inside the app (a route change).
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '/tasks'; a.id = 'toTasks'; a.textContent = 'tasks'; document.body.append(a); });
    await page.$eval('#toTasks', (a) => a.click());
    await until(page, () => document.title === 'Shiori — Tasks' && !!document.getElementById('tkList'), null, { what: 'Tasks' });
    const tasks = await look();
    assert.deepEqual({ ...tasks, brand: null }, { same: true, brand: null, form: null, page: 'tasks', right: ['stat', 'stopAllBtn', 'settingsBtn'], meta: 'tasks',
      padding: viewport.width <= 600 ? tasks.padding : '20px', title: 'Shiori — Tasks' });
    if (viewport.width > 520) assert.deepEqual(tasks.brand, settings.brand, 'the brand where it was');
    else assert.deepEqual([tasks.brand[1], tasks.brand[2], tasks.brand[3]], [settings.brand[1], settings.brand[2], settings.brand[3]], 'the brand as high and as wide (Settings\' phone form sets it 12px in, as 1.3)');
    await page.evaluate(() => history.back());
    await until(page, (path) => location.pathname === path && !!document.getElementById('libMergeSeries'), ADDRESS, { what: 'back on Settings' });
    const back = await look();
    assert.deepEqual(back, settings, 'as it was');
    assert.equal(await page.evaluate(() => window.stayed), true, 'no page load');
    assert.deepEqual(page.problems, []);
  }
});

// What a page holds that outlives it unless released (the Tasks page's test's method).
async function instrument(page) {
  await page.evaluateOnNewDocument(() => {
    const live = window.__live = { intervals: new Set(), timeouts: new Map(), channels: new Set() };
    const { setInterval: si, clearInterval: ci, setTimeout: st, clearTimeout: ct } = window;
    window.setInterval = function (...a) { const id = si.apply(this, a); live.intervals.add(id); return id; };
    window.clearInterval = function (id) { live.intervals.delete(id); return ci.call(this, id); };
    window.setTimeout = function (fn, ms, ...rest) {
      let id;
      const run = typeof fn === 'function' ? function (...x) { live.timeouts.delete(id); return fn.apply(this, x); } : fn;
      id = st.call(this, run, ms, ...rest);
      live.timeouts.set(id, ms);
      return id;
    };
    window.clearTimeout = function (id) { live.timeouts.delete(id); return ct.call(this, id); };
    const BC = window.BroadcastChannel;
    window.BroadcastChannel = class extends BC {
      constructor(name) { super(name); live.channels.add(this); }
      close() { live.channels.delete(this); super.close(); }
    };
  });
}
async function held(page) {
  const cdp = await page.createCDPSession();
  const listeners = async (expr) => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.map((l) => l.type).sort();
  };
  const counts = { window: await listeners('window'), document: await listeners('document'), ...await page.evaluate(() => ({
    intervals: window.__live.intervals.size, channels: window.__live.channels.size, subs: { ...window.__subs },
    nodes: document.getElementsByTagName('*').length,
  })) };
  await cdp.detach();
  return counts;
}

test('leaving the page leaves nothing behind: /settings-next → /tasks → /settings-next, five times', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  await instrument(page);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  await page.evaluate(async () => {
    const platform = await import('/app/js/platform.js');
    const subs = window.__subs = { kv: 0, jobs: 0, control: 0, feed: 0 };
    const count = (holder, method, name) => {
      const own = holder[method].bind(holder);
      holder[method] = (cb) => { subs[name]++; const off = own(cb); let done = false; return () => { if (!done) { done = true; subs[name]--; } return off(); }; };
    };
    count(platform.kv, 'watch', 'kv');
    count(platform.jobs, 'subscribe', 'jobs');
    count(platform.control, 'on', 'control');
    count(platform.feed, 'subscribe', 'feed');
    const a = document.createElement('a'); a.href = '/settings-next'; a.id = 'toSettings'; document.body.append(a);
  });
  const go = async (i) => {
    await page.$eval('#toSettings', (a) => a.click());
    await until(page, () => !!document.getElementById('libMergeSeries'), null, { what: `Settings (${i})` });
  };
  const away = async (i) => {
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/tasks' && !document.getElementById('settingsNav') && !!document.getElementById('tkList'), null, { what: `Tasks again (${i})` });
  };
  await go(0);
  // While it shows: its one subscription to other tabs' changes; a status line running; About opened
  // and closed (its changelog read, marked loaded once).
  assert.equal(await page.evaluate(() => window.__subs.kv), 1, 'one subscription for the page');
  await (await page.evaluateHandle(() => document.getElementById('libMergeSeries').parentElement.querySelector('[role="switch"]'))).click();
  await page.click('#aboutBtn');
  await until(page, () => document.getElementById('aboutChangelog')?.querySelectorAll('h2').length > 2, null, { what: 'the changelog' });
  await page.keyboard.press('Escape');
  await until(page, () => !document.getElementById('aboutBox'), null, { what: 'About closed' });
  await away(0);
  await new Promise((r) => setTimeout(r, 300));
  const first = await held(page);
  assert.equal(first.subs.kv, 0, 'its subscription went with it');
  const statusTimers = () => page.evaluate(() => [...window.__live.timeouts.values()].filter((ms) => ms === 2500).length);
  assert.equal(await statusTimers(), 0, 'no status line\'s timer left: it was called off');
  for (let i = 1; i <= 5; i++) {
    await page.evaluate(() => history.forward());
    await until(page, () => !!document.getElementById('libMergeSeries'), null, { what: `Settings (${i})` });
    await (await page.evaluateHandle(() => document.getElementById('libMergeSeries').parentElement.querySelector('[role="switch"]'))).click();
    await page.click('#aboutBtn');
    await until(page, () => document.getElementById('aboutChangelog')?.querySelectorAll('h2').length > 2, null, { what: 'the changelog' });
    await page.keyboard.press('Escape');
    await until(page, () => !document.getElementById('aboutBox'), null, { what: 'About closed' });
    await away(i);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await held(page), first, 'after five more visits, what is held is what it was after the first');
  assert.equal(await statusTimers(), 0);
  assert.deepEqual(page.problems, []);
});

// The experimental section is Chromium's alone (scrollbar.js draws the bars only there): where the
// browser is another, the section is not there, on either page.
for (const [name, path] of [['1.3\'s page', OLD], ['the new page', ADDRESS]]) {
  test(`the experimental section is not shown where the drawn scrollbars are not available, on ${name}`, async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    for (const [agent, shown] of [[null, true], ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0', false]]) {
      const page = await openPage(browser, origin);
      t.after(() => page.close());
      if (agent) await page.setUserAgent(agent);
      await page.goto(`${origin}${path}`, { waitUntil: 'load' });
      await drawn(page, path);
      const look = await page.evaluate(() => {
        const section = document.getElementById('experimentalSection');
        return { display: section && getComputedStyle(section).display !== 'none', chromium: document.documentElement.classList.contains('chromium-scrollbars') };
      });
      assert.deepEqual(look, { display: shown, chromium: shown }, agent ? 'another browser' : 'Chromium');
      assert.deepEqual(page.problems, []);
    }
  });
}

// (The bars are drawn only where the browser's own take room: a browser of its own, without headless
// Chrome's hidden scrollbars, as scrollbar.browser's.)
for (const [name, path] of [['1.3\'s page', OLD], ['the new page', ADDRESS]]) {
  test(`turning the drawn scrollbars on applies them at once, and off takes them away, on ${name}`, async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const own = await puppeteer.launch({ executablePath: chromePath(), headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--force-device-scale-factor=1'] });
    t.after(() => own.close());
    const page = await openPage(own, origin);
    await page.evaluateOnNewDocument(() => localStorage.removeItem('shiori:customScrollbar'));
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    await drawn(page, path);
    const look = () => page.evaluate(() => ({ on: document.documentElement.classList.contains('custom-scrollbars'), bar: !!document.querySelector('.page-scrollbar') }));
    assert.deepEqual(await look(), { on: false, bar: false });
    const flip = async () => (path === OLD ? page.click('label[for="customScrollbar"]')
      : (await page.evaluateHandle(() => document.getElementById('customScrollbar').parentElement.querySelector('[role="switch"]'))).click());
    await flip();
    // In the frames after the press: nothing waited on (no storage event, no other tab).
    await page.evaluate(frames);
    assert.deepEqual(await look(), { on: true, bar: true }, 'drawn at once');
    assert.equal(await page.evaluate(() => localStorage.getItem('shiori:customScrollbar')), 'true');
    await flip();
    await page.evaluate(frames);
    assert.deepEqual(await look(), { on: false, bar: false }, 'taken away at once');
    assert.equal(await page.evaluate(() => localStorage.getItem('shiori:customScrollbar')), 'false');
    assert.deepEqual(page.problems, []);
  });
}

// The study preview says what its four controls say (its data-* state), the text options are off while
// the original shows as an image, and a bubble shown as an image is drawn on its canvas.
test('the study preview follows its four controls', async (t) => {
  const page = await open(t, ADDRESS, { storage: {} });
  if (!page) return;
  await showPanel(page, 'navReader');
  const look = () => page.evaluate(() => {
    const preview = document.getElementById('studyPreview');
    const options = document.getElementById('studyTextOptions');
    const drawn = (which) => {
      const canvas = preview.querySelector(`canvas[data-raster="${which}"]`);
      if (!canvas) return null;
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
      return false;
    };
    const { original, translation, font, furigana } = preview.dataset;
    return { original, translation, font, furigana, disabled: options.disabled, rasterOriginal: drawn('original'), rasterTranslation: drawn('translation'),
      textOriginal: !!preview.querySelector('.study-dom-original'), textTranslation: !!preview.querySelector('.study-dom-translation'),
      furiganaShown: (() => { const rt = preview.querySelector('.study-dom-original rt'); return rt ? getComputedStyle(rt).display !== 'none' : null; })() };
  });
  // As nothing is stored: both as images, each drawn; the text options off.
  const base = await until(page, () => {
    const c = document.querySelector('#studyPreview canvas[data-raster="original"]');
    if (!c) return false;
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
    return false;
  }, null, { what: 'the original drawn as an image' });
  assert.equal(base, true);
  assert.deepEqual(await look(), { original: 'image', translation: 'hardcoded_images', font: 'yasashisa', furigana: 'off', disabled: true,
    rasterOriginal: true, rasterTranslation: true, textOriginal: false, textTranslation: false, furiganaShown: null });
  // The original as text: its options on, the font and furigana followed.
  await choose(page, TABLE.find((r) => r.key === 'readerStudyOriginal'), 'text', false);
  await until(page, () => document.getElementById('studyPreview').dataset.original === 'text' && !document.getElementById('studyTextOptions').disabled, null, { what: 'the original as text' });
  assert.deepEqual(await look(), { original: 'text', translation: 'hardcoded_images', font: 'yasashisa', furigana: 'off', disabled: false,
    rasterOriginal: null, rasterTranslation: true, textOriginal: true, textTranslation: false, furiganaShown: false });
  await choose(page, TABLE.find((r) => r.key === 'readerStudySrcFont'), 'kiwi', false);
  await until(page, () => document.getElementById('studyPreview').dataset.font === 'kiwi', null, { what: 'the font followed' });
  await choose(page, TABLE.find((r) => r.key === 'readerFurigana'), true, false);
  await until(page, () => document.getElementById('studyPreview').dataset.furigana === 'on', null, { what: 'furigana followed' });
  await choose(page, TABLE.find((r) => r.key === 'readerStudyDisplay'), 'text', false);
  await until(page, () => document.getElementById('studyPreview').dataset.translation === 'text', null, { what: 'the translation as text' });
  assert.deepEqual(await look(), { original: 'text', translation: 'text', font: 'kiwi', furigana: 'on', disabled: false,
    rasterOriginal: null, rasterTranslation: null, textOriginal: true, textTranslation: true, furiganaShown: true });
  // The original as an image again: the options off at once, its canvas drawn again.
  await choose(page, TABLE.find((r) => r.key === 'readerStudyOriginal'), 'image', false);
  await until(page, () => document.getElementById('studyPreview').dataset.original === 'image', null, { what: 'the original as an image again' });
  assert.equal(await page.evaluate(() => document.getElementById('studyTextOptions').disabled), true, 'its options off in the same frame');
  await until(page, () => {
    const c = document.querySelector('#studyPreview canvas[data-raster="original"]');
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
    return false;
  }, null, { what: 'drawn again' });
  assert.deepEqual(page.problems, []);
});

test('the phone form: the nav a column of 96px beside the panels, its items 36 high, nothing wider than the screen', async (t) => {
  const page = await open(t, ADDRESS, { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
  if (!page) return;
  const phone = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x * 100) / 100, Math.round(r.y * 100) / 100, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100]; };
    return { inner: innerWidth, nav: box(document.getElementById('settingsNav')), item: box(document.getElementById('navLibrary')), panels: box(document.querySelector('.settings-panels')),
      select: document.getElementById('langSelect').tagName, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      // A field's control under its words, full width; a switch at the row's end.
      lang: box(document.getElementById('langSelect')), switchRight: Math.round(document.getElementById('libMergeSeries').parentElement.querySelector('[role="switch"]').getBoundingClientRect().right) };
  });
  assert.equal(phone.inner, 390);
  assert.deepEqual([phone.nav[0], phone.nav[1], phone.nav[2]], [10, 76, 96], 'the nav, where 1.3 has it');
  assert.deepEqual([phone.item[2], phone.item[3]], [96, 36]);
  assert.deepEqual([phone.panels[0], phone.panels[2]], [116, 264], 'the panels, where 1.3 has them');
  assert.equal(phone.select, 'SELECT', 'under a finger, the system\'s picker (T15)');
  assert.deepEqual([phone.lang[0], phone.lang[2]], [132, 232], 'the language box under its words, the row\'s width less 15px a side');
  assert.equal(phone.switchRight, 364, 'the switch at the row\'s end, 15px in');
  assert.equal(phone.fits, true);
  assert.deepEqual(page.problems, []);
});

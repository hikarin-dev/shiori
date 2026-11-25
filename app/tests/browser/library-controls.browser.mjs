// library-controls.browser.mjs — the library at /library, its header, toolbar, search, filter
// and keys, held to what 1.3's page gave where the two could be driven alike: the header's
// boxes at 1500px (the totals in the bar) and at 1280 (folded: the menu button, Import's icon alone),
// the totals and their tips plain and with Shift; the search's list, its blocks, the X and the 180 ms
// the box waits after a key (kept by an observer in the page, never polled); a card's tag, flag and Alt
// on its heart adding to the search at once; the filter's dialog (each state of an option, the button's
// mark, what is stored, Clear, Escape, focus back on the button, another tab's change); the keyboard
// through the page; the arrows and A/D paging. What 1.3's page gave is each table's record
// (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as measured on 2026-11-25, which a
// deliberate change of the library's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { record } from './records.mjs';
import { librarySettled } from './library-drive.mjs';

const NEW = '/library';
const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(seed);
  // The library's pages are measured once a page has shown them (the totals' tiers count them): the
  // page is then read with them measured.
  await page.goto(`${origin}${NEW}`, { waitUntil: 'load' });
  await librarySettled(page);
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

// 64 galleries: three tags in turn, a category, a rating, a Japanese flag on every other one, every
// seventh a favourite; pages of two sizes, so the tiers' tip has rows.
async function seed() {
  const api = await import('/app/js/api.js');
  const png = async (hue, w) => { const c = new OffscreenCanvas(w, Math.round(w * 1.5)); const x = c.getContext('2d'); x.fillStyle = `hsl(${hue} 60% 50%)`; x.fillRect(0, 0, c.width, c.height); return c.convertToBlob({ type: 'image/png' }); };
  for (let i = 0; i < 64; i++) {
    const gid = String(1790000003000 + i);
    const tags = [{ type: 'tag', name: `t${i % 3}` }, { type: 'category', name: i % 4 ? 'manga' : 'misc' }, { type: 'rating', name: i % 2 ? 'safe' : 'pornographic' }];
    if (i % 2) tags.push({ type: 'language', name: 'japanese' });
    await api.meta.put({ galleryId: gid, title: { english: `Gallery ${i}`, japanese: '', pretty: '' }, tags, numPages: 1 });
    await api.pages.put(gid, 1, await png(i * 5, i % 2 ? 1200 : 300));
    if (i % 7 === 0) await api.personal.favorite(gid, true);
  }
}

const ready = (page) => until(page, () => document.getElementById('hTotalGalleries')?.textContent !== '—' && document.querySelectorAll('#grid > .card').length === 30
  && !!document.getElementById('hSizeStat')?.dataset.tip, null, { what: 'the page and its totals' });
async function open(path, size = { width: 1500, height: 900 }, storage = {}) {
  const page = await openPage(browser, origin);
  await page.setViewport(size);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate((storage) => { localStorage.removeItem('shiori:libFilter'); for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, JSON.stringify(v)); }, storage);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await ready(page);
  await page.evaluate(() => document.fonts.ready);
  await sleep(300);
  return page;
}
const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return s.display === 'none' ? 'hidden' : [r.x, r.y, r.width, r.height].map((n) => +n.toFixed(2)); };
const HEADER = ['header .brand-wrap', '#pageNav', '#searchBox', '#pinBtn', '#burgerBtn', '#hTotalGalleries', '#hImagesStat', '#hSizeStat', '#uploadCbzBtn', '#safeBtn', '#settingsBtn', '#sortSelect', '#filterBtn', '#grid', '#grid > .card'];

test('the header and the toolbar: where 1.3 has them, wide and folded at 1400px or less', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const now = {};
  for (const size of [{ width: 1500, height: 900 }, { width: 1280, height: 900 }, { width: 800, height: 900 }]) {
    const page = await open(NEW, size);
    const boxes = now[size.width] = await page.evaluate((sels, box) => Object.fromEntries(sels.map((s) => [s, new Function(`return (${box})`)()(s)])), HEADER, box.toString());
    // Import's frame, which 1.3 kept in the second accent at every width.
    boxes.importFrame = await page.evaluate(() => getComputedStyle(document.getElementById('uploadCbzBtn')).borderTopColor);
    assert.deepEqual(page.problems, []);
    await page.close();
  }
  const was = record(FILE, 'header');
  for (const width of Object.keys(was)) {
    // The page menu: 1.3's select against the drawn one's box, within a pixel; everything else exact.
    assert.equal(now[width].importFrame, was[width].importFrame, `Import's frame at ${width}`);
    const differ = HEADER.filter((s) => JSON.stringify(was[width][s]) !== JSON.stringify(now[width][s]))
      .filter((s) => !(Array.isArray(was[width][s]) && was[width][s].every((v, i) => Math.abs(v - now[width][s][i]) <= 1)));
    assert.deepEqual(differ.map((s) => [s, was[width][s], now[width][s]]), [], `at ${width}`);
  }
  assert.deepEqual(Object.keys(now), Object.keys(was));
});

test('the totals and their tips, plain and with Shift, as 1.3\'s', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW);
    const tips = await page.evaluate(() => ['hTotalGalleries', 'hTotalImages', 'hTotalSize'].map((id) => document.getElementById(id).textContent)
      .concat([document.getElementById('hImagesStat').dataset.tip, document.getElementById('hSizeStat').dataset.tip, document.getElementById('hSizeStat').dataset.tipShift]));
    const shown = async (shift) => {
      await page.mouse.move(5, 400);
      await sleep(100);
      if (shift) await page.keyboard.down('Shift');
      const r = await (await page.$('#hSizeStat')).boundingBox();
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await until(page, () => { const tip = document.querySelector('.shiori-tip'); return !!tip && tip.style.display !== 'none' && !!tip.textContent; }, null, { what: 'the tip' });
      await sleep(150);
      const text = await page.evaluate(() => document.querySelector('.shiori-tip').textContent);
      if (shift) await page.keyboard.up('Shift');
      return text;
    };
    const now = { tips, plain: await shown(false), shift: await shown(true) };
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'totals');
    assert.ok(/\d/.test(was.tips[0]) && was.tips[3].includes('MP'), 'figures and the tiers\' tip');
    assert.notEqual(was.shift, was.plain, 'Shift shows the average');
    assert.deepEqual(now, was);
  }
});

test('the search: the list, a block, the 180 ms after a key, the X; a card\'s tag, flag and Alt on its heart add to it at once', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW);
    const r = {};
    // When the grid's cards change, and when the last key went down, both kept in the page (a time read
    // from here after the typing comes a round trip late: under the whole suite's load that made the
    // wait look shorter than it was).
    await page.evaluate(() => {
      window.__changed = [];
      window.__keyed = 0;
      new MutationObserver(() => window.__changed.push(performance.now())).observe(document.getElementById('grid'), { childList: true });
      document.addEventListener('keydown', () => { window.__keyed = performance.now(); }, true);
    });
    await page.click('#searchBox');
    await until(page, () => !!document.querySelector('#searchSuggest [role="option"]'), null, { what: 'the list' });
    r.list = await page.evaluate(() => [...document.querySelectorAll('#searchSuggest [role="option"]')].length);
    await page.keyboard.type('tag:"t1"');
    await until(page, () => window.__changed.length > 0, null, { what: 'the search applied' });
    r.waited = await page.evaluate(() => window.__changed[0] - window.__keyed >= 180);
    await sleep(300);
    r.after = await page.evaluate(() => [[...document.querySelectorAll('#searchBox .search-chip')].map((c) => c.dataset.token), document.querySelectorAll('#grid > .card').length,
      location.search, getComputedStyle(document.getElementById('searchClear')).display !== 'none']);
    await page.keyboard.press('Escape');
    // The X: at once, the box empty and focused.
    await page.evaluate(() => { window.__changed = []; });
    await page.click('#searchClear');
    const cleared = await page.evaluate(() => performance.now());
    await until(page, () => window.__changed.length > 0, null, { what: 'cleared' });
    r.clearedAtOnce = (await page.evaluate(() => window.__changed[0])) - cleared < 180;
    await sleep(300);
    r.cleared = await page.evaluate(() => [document.getElementById('searchBox').textContent, document.activeElement?.id, document.querySelectorAll('#grid > .card').length, location.search]);
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 500);
    // A card's tag, its flag, Alt on its heart.
    const card = '#grid > .card:nth-child(2)';
    await page.hover(`${card} .card-thumb-wrap`);
    await sleep(400);
    await page.click(`${card} .card-tag[data-type="tag"]`);
    await sleep(400);
    r.tag = await page.evaluate(() => [location.search, document.querySelectorAll('#grid > .card').length, document.activeElement === document.getElementById('searchBox')]);
    await page.hover(`${card} .card-thumb-wrap`);
    await sleep(300);
    await page.click(`${card} .card-tag-flag`);
    await sleep(400);
    r.flag = await page.evaluate(() => [location.search, document.querySelectorAll('#grid > .card').length]);
    await page.hover(`${card} .card-thumb-wrap`);
    await sleep(300);
    await page.keyboard.down('Alt');
    await page.click(`${card} .card-fav`);
    await page.keyboard.up('Alt');
    await sleep(400);
    r.alt = await page.evaluate(() => [location.search, document.querySelectorAll('#grid > .card').length]);
    const now = r;
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'search');
    assert.equal(was.waited, true);
    assert.equal(was.clearedAtOnce, true);
    assert.deepEqual(now, was);
  }
});

test('the filter\'s dialog: an option\'s states, the button\'s mark, Clear, Escape, focus back, another tab\'s change', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW);
    const r = [];
    const state = () => page.evaluate(() => {
      const btn = document.getElementById('filterBtn');
      return { stored: localStorage.getItem('shiori:libFilter'), cards: document.querySelectorAll('#grid > .card').length, page: location.search,
        mark: btn.classList.contains('active'), options: [...document.querySelectorAll('#filterModal.show .fopt')].filter((o) => o.dataset.state !== 'off').map((o) => `${o.dataset.value}:${o.dataset.state}`),
        focus: document.activeElement?.dataset?.value ?? document.activeElement?.id ?? null };
    });
    await page.evaluate(() => [...document.querySelectorAll('#pagination button')].find((b) => b.textContent === '2').click());
    await sleep(500);
    await page.click('#filterBtn');
    await sleep(300);
    r.push(await state());
    for (let i = 0; i < 3; i++) { await page.click('.fopt[data-value="safe"]'); await sleep(400); r.push(await state()); }
    await page.click('.fopt[data-value="misc"]'); await sleep(200);
    await page.click('.fopt[data-value="pornographic"]'); await sleep(200);
    await page.click('.fopt[data-value="pornographic"]'); await sleep(400);
    r.push(await state());
    await page.click('#filterClear'); await sleep(400);
    r.push(await state());
    await page.click('.fopt[data-value="misc"]'); await sleep(300);
    await page.keyboard.press('Escape'); await sleep(300);
    r.push({ ...(await state()), open: await page.evaluate(() => !!document.querySelector('#filterModal.show')) });
    // Another tab.
    const other = await openPage(browser, origin);
    await other.goto(`${origin}/tasks`, { waitUntil: 'load' });
    await other.evaluate(() => localStorage.setItem('shiori:libFilter', JSON.stringify({ rating: { pornographic: 'exclude' }, category: {} })));
    await other.close();
    await page.bringToFront();
    await sleep(600);
    r.push(await state());
    const now = r;
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'filter');
    assert.equal(was[1].mark, true);
    assert.deepEqual(now, was);
  }
});

test('the keyboard through the page, and the arrows and A/D paging', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(NEW);
  const order = [];
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => { const el = document.activeElement; return el.id || el.closest('[id]')?.id + '>' + (el.className.split(' ').find((c) => /^card-|^page|^brand/.test(c)) || el.getAttribute('data-slot') || el.localName); }));
  }
  const first = (s) => order.indexOf(s);
  for (const [a, b] of [['pageNav', 'searchBox'], ['searchBox', 'pinBtn'], ['pinBtn', 'uploadCbzBtn'], ['uploadCbzBtn', 'safeBtn'], ['safeBtn', 'settingsBtn'], ['settingsBtn', 'sortSelect'], ['sortSelect', 'filterBtn']]) {
    assert.ok(first(a) >= 0 && first(b) === first(a) + 1, `${a} then ${b}: ${order.join(' ')}`);
  }
  assert.ok(order.slice(first('filterBtn') + 1).some((s) => s.startsWith('grid>card')), `the cards come next: ${order.join(' ')}`);
  // A keyboard-focused card shows its quick actions.
  await page.focus('#grid > .card .card-btn-dl');
  await sleep(300);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#grid > .card .card-actions')).opacity), '1');
  // Paging by key, from the page itself (not from the search box).
  await page.mouse.click(5, 500);
  await page.keyboard.press('ArrowRight');
  await until(page, () => location.search === '?page=2', null, { what: 'page 2' });
  await page.keyboard.down('Shift'); await page.keyboard.press('KeyD'); await page.keyboard.up('Shift');
  await until(page, () => location.search === '?page=3', null, { what: 'the last page' });
  await page.keyboard.press('a');
  await until(page, () => location.search === '?page=2', null, { what: 'back a page' });
  await page.click('#searchBox');
  await page.keyboard.press('ArrowLeft');
  await sleep(400);
  assert.equal(await page.evaluate(() => location.search), '?page=2', 'not from the search box');
  // The paging's buttons by keyboard.
  await page.evaluate(() => document.querySelector('#pagination button:not([disabled])').focus());
  await page.keyboard.press('Enter');
  await until(page, () => location.search === '', null, { what: 'page 1 by its button' });
  assert.deepEqual(page.problems, []);
  await page.close();
});

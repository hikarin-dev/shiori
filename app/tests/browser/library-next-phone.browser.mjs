// library-next-phone.browser.mjs — /library-next on a phone (390×844, touch, a coarse pointer, no
// hover), held against 1.3's page (/library) as mobile.browser.mjs holds 1.3's: the two-column grid,
// every card's box and its parts' (the heart a favourite shows, its source button, its tags), the
// header's two rows, text sizes; no sideways scroll at any width from 320 to 600; what a card opens on a
// phone (its source's question, from its source button; a tag's search) and the filter's dialog inside
// the window, their buttons reachable and a finger's size; a tap grows no card and shows no quick
// actions, and a finger on a cover never lifts it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { readDialog, answer } from './library-drive.mjs';

let server, origin, browser;
const PATHS = ['/library', '/library-next'];
const PHONE = { width: 390, height: 844, hasTouch: true, isMobile: true };
const BASE = 1790008300000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async (base) => {
    const api = await import('/app/js/api.js');
    for (let i = 0; i < 12; i++) {
      const gid = String(base + i);
      const c = new OffscreenCanvas(300, 430); const x = c.getContext('2d'); x.fillStyle = `hsl(${i * 25} 60% 50%)`; x.fillRect(0, 0, 300, 430);
      const tags = [{ type: 'category', name: 'manga' }, { type: 'artist', name: 'someone' }, { type: 'tag', name: `tag ${i}` }, { type: 'language', name: 'japanese' }];
      await api.meta.put({ galleryId: gid, title: { english: `Phone gallery ${i} with a title long enough to wrap twice on a narrow card`, japanese: '', pretty: '' }, tags, numPages: 1,
        ...(i % 3 ? { source: 'a.example', sourceId: `55${i}`, sourceUrl: `https://a.example/g/55${i}` } : {}) });
      await api.pages.put(gid, 1, await c.convertToBlob({ type: 'image/png' }));
      if (i % 4 === 0) await api.personal.favorite(gid, true);
    }
    await (await import('/app/js/migrations.js')).runMigrations();
  }, BASE);
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

async function open(path, viewport = PHONE) {
  const page = await openPage(browser, origin);
  await page.setViewport(viewport);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('shiori:lib')) localStorage.removeItem(k); localStorage.removeItem('shiori-safe-mode'); localStorage.removeItem('shiori-header-pin'); });
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('#grid > .card').length >= 12 && document.getElementById('hTotalGalleries')?.textContent !== '—'
    && [...document.querySelectorAll('#grid > .card img.card-thumb')].every((i) => i.getAttribute('src') && i.complete), null, { what: 'the page' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(300);
  return page;
}

// In the page: what the phone form is, box by box (the first four cards and their parts), and text sizes.
function phoneForm() {
  const box = (el) => { if (!el) return null; const s = getComputedStyle(el); if (s.display === 'none') return 'hidden'; const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => +n.toFixed(2)); };
  const font = (el) => el && `${getComputedStyle(el).fontSize}/${getComputedStyle(el).lineHeight}`;
  const cards = [...document.querySelectorAll('#grid > .card')].slice(0, 4).map((c) => ({
    card: box(c), cover: box(c.querySelector('.card-thumb-wrap')), fav: box(c.querySelector('.card-fav')), open: box(c.querySelector('.card-btn-open')), id: box(c.querySelector('.card-id')),
    actions: box(c.querySelector('.card-actions')), title: box(c.querySelector('.card-title')), meta: box(c.querySelector('.card-meta')), tags: box(c.querySelector('.card-tags')),
    add: box(c.querySelector('.card-tag-add')),
  }));
  const c = document.querySelector('#grid > .card');
  return {
    width: innerWidth, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    columns: getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length,
    grid: box(document.getElementById('grid')), toolbar: box(document.querySelector('.toolbar')), sort: box(document.getElementById('sortSelect')), filter: box(document.getElementById('filterBtn')),
    paging: box(document.getElementById('pagination')), cards,
    text: { title: font(c.querySelector('.card-title')), meta: font(c.querySelector('.card-meta')), tag: font(c.querySelector('.card-tag[data-original]')), id: font(c.querySelector('.card-id')),
      search: font(document.getElementById('searchBox')), stat: font(document.getElementById('hTotalGalleries')), sort: font(document.getElementById('sortSelect')) },
  };
}
function differ(a, b, at = '') {
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v) => typeof v === 'number')) return a.every((v, i) => Math.abs(v - b[i]) <= 1) ? [] : [[at, a, b]];
  if (a && b && typeof a === 'object' && typeof b === 'object') return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => differ(a[k], b[k], `${at}.${k}`));
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [[at, a, b]];
}

test('on a phone: two columns, every card\'s box and its parts\', the toolbar, text sizes, as 1.3\'s', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  for (const path of PATHS) {
    const page = await open(path);
    out[path] = await page.evaluate(phoneForm);
    assert.deepEqual(page.problems, []);
    await page.close();
  }
  const was = out['/library'];
  assert.equal(was.columns, 2);
  assert.equal(was.width, 390);
  assert.equal(was.sideways, false);
  assert.deepEqual(differ(was, out['/library-next']), []);
});

test('no sideways scroll at any width from 320 to 600, on either page; the header and the grid as 1.3\'s at each', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  for (const path of PATHS) {
    const page = await open(path);
    out[path] = [];
    for (let width = 320; width <= 600; width += 20) {
      await page.setViewport({ ...PHONE, width });
      await sleep(250);
      out[path].push(await page.evaluate(() => {
        const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => +n.toFixed(1)); };
        return { width: innerWidth, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth, header: box('header'), search: box('header .search-wrap'),
          settings: box('#settingsBtn'), card: box('#grid > .card'), second: box('#grid > .card:nth-child(2)') };
      }));
    }
    await page.close();
  }
  assert.ok(out['/library'].every((r) => !r.sideways), 'no sideways scroll on 1.3\'s page');
  assert.ok(out['/library-next'].every((r) => !r.sideways), 'none on the new page');
  assert.deepEqual(differ(out['/library'], out['/library-next']), []);
});

test('what a card opens on a phone, and the filter: inside the window, the buttons reachable and a finger\'s size', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  const inside = () => {
    const box = document.querySelector('.notice-overlay .notice-dialog, [data-notice="dialog"], #filterModal.show .modal-box, [data-slot="dialog"]');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    const buttons = [...box.querySelectorAll('button')].filter((b) => getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0).map((b) => b.getBoundingClientRect());
    return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0, fitsHeight: r.bottom <= innerHeight || box.scrollHeight > box.clientHeight || box.parentElement.scrollHeight > box.parentElement.clientHeight,
      count: buttons.length, reachable: buttons.every((b) => b.left >= 0 && b.right <= innerWidth), smallest: Math.min(...buttons.map((b) => Math.round(b.height))) };
  };
  for (const path of PATHS) {
    const page = await open(path);
    const r = {};
    // A gallery with no source: its source button asks for one.
    const card = `#grid > .card[data-gallery-id="${BASE + 9}"]`;
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), card);
    await sleep(200);
    await page.tap(`${card} .card-btn-open`);
    const asked = await readDialog(page);
    r.source = { title: asked?.title, buttons: asked?.buttons.map((b) => b.text), ...(await page.evaluate(inside)) };
    await answer(page, 'cancel');
    // A tag: the search.
    await page.tap(`${card} .card-tag[data-type="tag"]`);
    await sleep(500);
    r.tag = await page.evaluate(() => [location.search, document.querySelectorAll('#grid > .card').length]);
    // The filter.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.tap('#filterBtn');
    await sleep(400);
    r.filter = await page.evaluate(inside);
    await page.keyboard.press('Escape');
    await sleep(200);
    out[path] = r;
    assert.deepEqual(page.problems, []);
    await page.close();
  }
  if (process.env.DUMP) console.log(JSON.stringify(out));
  const now = out['/library-next'], was = out['/library'];
  for (const r of [now.source, now.filter]) {
    assert.equal(r.inside, true);
    assert.equal(r.fitsHeight, true);
    assert.equal(r.reachable, true);
  }
  assert.deepEqual(now.tag, was.tag);
  assert.deepEqual([now.source.title, now.source.buttons], [was.source.title, was.source.buttons]);
  // A finger's size: the notices' buttons are 36 on the new page (S16/F01: the dialogs' one height).
  assert.ok(now.source.smallest >= 36 && now.filter.smallest >= 36, `buttons: ${now.source.smallest}, ${now.filter.smallest}`);
});

test('a tap grows no card and shows no quick actions; a finger on a cover lifts nothing', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  for (const path of PATHS) {
    const page = await open(path);
    const card = '#grid > .card:nth-child(2)';
    const size = () => page.$eval(card, (c) => [c.getBoundingClientRect().height, getComputedStyle(c).marginBottom, getComputedStyle(c.querySelector('.card-actions')).display, getComputedStyle(c.querySelector('.card-tag-add')).display].join());
    const before = await size();
    const meta = await (await page.$(`${card} .card-meta`)).boundingBox();
    await page.touchscreen.tap(meta.x + 4, meta.y + meta.height / 2);
    await sleep(450);
    const after = await size();
    const [from, to] = await page.$$eval('#grid > .card .card-thumb-wrap', (ws) => [ws[0], ws[2]].map((w) => { const r = w.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
    await page.touchscreen.touchStart(from.x, from.y);
    for (let k = 1; k <= 8; k++) await page.touchscreen.touchMove(from.x, from.y + (to.y - from.y) * k / 8);
    const lifted = !!(await page.$('.card-drag-clone'));
    await page.touchscreen.touchEnd();
    await sleep(300);
    out[path] = { before, after, lifted, asked: !!(await page.$('.notice-overlay, [data-notice="dialog"]')) };
    await page.close();
  }
  assert.equal(out['/library'].before, out['/library'].after);
  assert.equal(out['/library'].lifted, false);
  assert.deepEqual(out['/library-next'], out['/library']);
});

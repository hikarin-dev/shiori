// reader-route.browser.mjs — the reader drawn by the one page, at its route (/reader; 1.3's reader page
// until 2026-11-26): its frame is that page's markup; what that page had before its first paint the frame
// has before its own, on a hard load and on a change of route, the CPU slowed, and before the frame is
// drawn the window shows the reader's ground and nothing else; every way out of it and every way back is
// a change of route that keeps where the person was; another gallery is another frame; and entering and
// leaving it leaves nothing behind.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { record as kept } from './records.mjs';

const FILE = basename(fileURLToPath(import.meta.url));

const SERIES = ['1790000000811', '1790000000812', '1790000000813'];   // three chapters of 6 pages
const SINGLE = '1790000000821';   // 10 pages
const OTHER = '1790000000822';    // 4 pages
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async ({ series, single, other }) => {
    const api = await import('/app/js/api.js');
    const title = (english) => ({ english, japanese: '', pretty: '' });
    const canvas = new OffscreenCanvas(600, 860);
    const ctx = canvas.getContext('2d');
    const blob = async (hue) => { ctx.fillStyle = `hsl(${hue} 40% 45%)`; ctx.fillRect(0, 0, 600, 860); return canvas.convertToBlob({ type: 'image/png' }); };
    for (const [k, gid] of series.entries()) {
      await api.meta.put({ galleryId: gid, title: title(`Chapter ${k + 1}`), tags: [], numPages: 6 });
      for (let n = 1; n <= 6; n++) await api.pages.put(gid, n, await blob(k * 90 + n * 10));
    }
    await api.series.write(series[0], series.map((id, k) => ({ id, title: `Part ${k + 1}`, number: k + 1 })), { seriesTitle: title('Route series'), seriesTags: [] });
    await api.meta.put({ galleryId: single, title: title('Single'), tags: [], numPages: 10 });
    for (let n = 1; n <= 10; n++) await api.pages.put(single, n, await blob(n * 30));
    await api.meta.put({ galleryId: other, title: title('Other'), tags: [], numPages: 4 });
    for (let n = 1; n <= 4; n++) await api.pages.put(other, n, await blob(200 + n * 5));
  }, { series: SERIES, single: SINGLE, other: OTHER });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drawn = () => [...document.querySelectorAll('#stripView img[src], #mainImg, .dImg')].some((img) => img.naturalWidth > 0)
  && getComputedStyle(document.getElementById('loadingScreen')).display === 'none';
const readerDrawn = (page) => until(page, drawn, null, { what: 'a page of the reader drawn' });
const counter = (page) => page.$eval('#pageCounter', (el) => el.textContent.replace(/\s+/g, ' ').trim());
// A change of route, as a link of the app's makes one (links.ts keeps a plain link to an address the one
// page draws inside it).
const follow = (page, href) => page.evaluate((href) => {
  const a = Object.assign(document.createElement('a'), { href, textContent: 'go' });
  document.body.append(a);
  a.click();
  a.remove();
}, href);
const settingsFor = ({ nav = 'top', shown = true, mode = 'single', lang = null, extra = {} } = {}) => ({
  'shiori-reader-nav': nav, [nav === 'side' ? 'shiori-reader-side-pin' : 'shiori-reader-pin']: shown ? '1' : '0',
  'shiori-reader-nav-place': 'right-start', 'shiori:readerMode': JSON.stringify(mode), 'shiori:readerFitMode': '"height"',
  'shiori:readerThumbsOpen': 'false', ...(lang ? { 'shiori-lang': lang } : {}), ...extra,
});
async function open(t, path, settings = settingsFor()) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument((settings) => {
    if (sessionStorage.getItem('settings-set')) return;
    sessionStorage.setItem('settings-set', '1');
    for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value);
  }, settings);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  return page;
}

// The reader's page's markup as 1.3's page had it (app/reader.html's body, measured on 2026-11-26, three
// runs the same): every element with an id, in its order, and the top-level parts. A deliberate change of
// the frame (a dialog taken out of it as a component of the one page's) edits the record in the same
// commit (records.mjs).
test('the route\'s frame is the reader\'s page\'s markup, element for element, and nothing of the one page\'s stands around it', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(t, `/reader?g=${SINGLE}&page=1`);
  await readerDrawn(page);
  const own = kept(FILE, 'frame');
  const seen = await page.evaluate((own) => {
    const ids = (root) => [...root.querySelectorAll('[id]')].map((el) => `${el.localName}#${el.id}`);
    const frame = document.querySelector('#root > .reader-frame');
    const ownIds = new Set(own.map((id) => id.split('#')[1]));
    return {
      // What the engine makes inside the frame with ids of its own (strip rows, thumbnails…) aside.
      drawn: ids(frame).filter((id) => ownIds.has(id.split('#')[1])),
      // Its top-level parts in the page's order.
      parts: [...frame.children].map((el) => el.id),
      header: !!document.querySelector('header.app-header'), meta: [...document.querySelectorAll('meta[name="shiori-app"]')].map((m) => m.content),
      mark: document.documentElement.hasAttribute('data-reader'), frameMark: document.documentElement.dataset.frame ?? null,
      title: document.title, logo: frame.querySelector('.brand-icon img').naturalWidth, home: frame.querySelector('#snHome').href,
    };
  }, own.elements);
  assert.ok(own.elements.length > 100, `the page's elements with ids (${own.elements.length})`);
  assert.deepEqual(seen.drawn, own.elements, 'every element of the page, in its order');
  assert.deepEqual(seen.parts, own.parts);
  assert.deepEqual({ header: seen.header, meta: seen.meta, mark: seen.mark, frameMark: seen.frameMark },
    { header: false, meta: ['reader'], mark: true, frameMark: null }, 'no common header, the shiori-app meta saying "reader", the reader\'s mark');
  assert.match(seen.title, /^Shiori — #/);
  assert.ok(seen.logo > 0, 'the brand\'s picture found at the site\'s root');
  assert.equal(seen.home, `${origin}/`);
});

// What a frame shows, read in each animation frame (a frame's paint follows them) from the one in which
// the reader's frame is first there until a page of the reader is drawn.
function record() {
  window.__frames = [];
  const tick = () => {
    const frame = document.querySelector('#root > .reader-frame');
    if (frame) {
      const html = document.documentElement, shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
      window.__frames.push({
        mark: html.hasAttribute('data-reader'), side: html.classList.contains('reader-side-nav'), hidden: html.classList.contains('reader-controls-hidden'),
        place: `${html.dataset.snPos}-${html.dataset.snAlign}`,
        // reader.css applied: its loading screen over the window, the page's ground the reader's.
        styled: getComputedStyle(document.getElementById('loadingScreen')).position === 'fixed' && getComputedStyle(document.body).backgroundColor === 'rgb(10, 10, 12)',
        topbar: shown('topbar'), sideNav: shown('sideNav'), zoom: getComputedStyle(document.getElementById('sideZoom')).opacity,
        words: document.getElementById('snChaptersTitle').textContent, header: !!document.querySelector('header.app-header'),
      });
    }
    const done = [...document.querySelectorAll('#stripView img[src], #mainImg, .dImg')].some((img) => img.naturalWidth > 0);
    if (!done) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

test('before its first paint the frame has what the reader\'s page has before its own: on a hard load and on a change of route, the CPU slowed six times', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const cases = [
    { nav: 'top', shown: true }, { nav: 'top', shown: false }, { nav: 'side', shown: true }, { nav: 'side', shown: false },
  ];
  for (const how of ['hard load', 'change of route']) {
    for (const c of cases) {
      const settings = settingsFor({ ...c, lang: 'fr', extra: { 'shiori-reader-nav-place': 'left-center' } });
      const page = await openPage(browser, origin);
      const cdp = await page.createCDPSession();
      await page.evaluateOnNewDocument((settings) => { for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value); }, settings);
      if (how === 'hard load') {
        await page.evaluateOnNewDocument(record);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
        await page.goto(`${origin}/reader?g=${SINGLE}&page=1`, { waitUntil: 'load' });
      } else {
        await page.goto(`${origin}/overview?g=${SINGLE}`, { waitUntil: 'load' });
        await until(page, () => !!document.querySelector('#root main, #ovContent .ov-hero, #settingsNav, #tkList'), null, { what: 'the overview' });
        await sleep(300);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
        await page.evaluate(record);
        await follow(page, `/reader?g=${SINGLE}&page=1`);
      }
      await until(page, drawn, null, { what: 'a page drawn', timeout: 60000 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const frames = await page.evaluate(() => window.__frames);
      const words = await page.evaluate(async () => (await import('/app/js/i18n.js')).t('rd.chapters'));
      const label = `${how}, ${c.nav}${c.shown ? '' : ', hidden'}`;
      assert.ok(frames.length > 0, `${label}: frames recorded`);
      t.diagnostic(`${label}: ${frames.length} frames from the frame's first to a page drawn`);
      const expected = { mark: true, side: c.nav === 'side', hidden: !c.shown, place: 'left-center', styled: true,
        topbar: c.nav === 'top', sideNav: c.nav === 'side', zoom: c.shown ? '1' : '0', words, header: false };
      const off = frames.map((f, i) => [i, f]).filter(([, f]) => JSON.stringify(f) !== JSON.stringify(expected));
      assert.deepEqual(off, [], `${label}: every frame of ${frames.length} as the reader's page first paints`);
      assert.notEqual(words, 'Chapters', 'the words are the person\'s language');
      assert.deepEqual(page.problems, []);
      await page.evaluate(() => localStorage.removeItem('shiori-lang'));   // the other tests read English
      await page.close();
    }
  }
});

test('every way out of the reader is a change of route, and Back finds the reader where it was left', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(t, `/overview?g=${SINGLE}`, settingsFor({ nav: 'top', mode: 'single' }));
  await until(page, () => !!document.querySelector('#root main, #ovContent .ov-hero, #settingsNav, #tkList'), null, { what: 'the overview' });
  await page.evaluate(() => { window.__stayed = true; });
  const stayed = () => page.evaluate(() => window.__stayed === true);
  const at = () => page.evaluate(() => location.pathname + location.search);
  const enter = async (gid, n = 1) => {
    await follow(page, `/reader?g=${gid}&page=${n}`);
    await readerDrawn(page);
  };
  const left = async (path) => {
    await until(page, (path) => location.pathname + location.search === path && !document.querySelector('.reader-frame') && !!document.querySelector('#root main, #ovContent .ov-hero, #settingsNav, #tkList'), path, { what: path });
    assert.equal(await stayed(), true, `${path}: no page load`);
    assert.deepEqual(await page.evaluate(() => ({ mark: document.documentElement.hasAttribute('data-reader'),
      names: ['reader-side-nav', 'reader-controls-hidden'].filter((c) => document.documentElement.classList.contains(c)),
      data: [document.documentElement.dataset.snPos ?? null, document.documentElement.dataset.snAlign ?? null], body: document.body.className })),
    { mark: false, names: [], data: [null, null], body: '' }, `${path}: nothing of the reader on <html> and <body>`);
  };
  const back = async (n) => {
    await page.goBack();
    await readerDrawn(page);
    assert.equal(await stayed(), true, 'Back: no page load');
    await until(page, (n) => document.getElementById('pageCounter').textContent.trim().startsWith(`${n} `), n, { what: `the reader on page ${n}` });
  };

  // In from the overview; a page turned; out by the brand; Back.
  await enter(SINGLE);
  for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); await sleep(150); }
  assert.equal(await counter(page), '5 / 10');
  await sleep(300);   // the address follows the page (at most every 100 ms)
  await page.click('.brand-wrap');
  await left('/');
  await back(5);
  assert.equal(await at(), `/reader?g=${SINGLE}&page=5`);
  // The page menu: Settings, the overview, Tasks, the library.
  for (const [choice, path] of [['settings', '/settings'], ['overview', `/overview?g=${SINGLE}`], ['tasks', '/tasks'], ['library', '/']]) {
    await page.select('#pageNav', choice);
    await left(path);
    await back(5);
  }
  // The side controls' home and overview.
  await page.evaluate(() => { localStorage.setItem('shiori-reader-nav', 'side'); localStorage.setItem('shiori-reader-side-pin', '1'); });
  await follow(page, `/overview?g=${SINGLE}`);
  await left(`/overview?g=${SINGLE}`);
  await enter(SINGLE, 3);
  await page.click('#snOverview');
  await left(`/overview?g=${SINGLE}`);
  await back(3);
  await page.click('#snHome');
  await left('/');
  await back(3);

  // A series: the next chapter and a chapter from the list stay in the reader (one engine, the address
  // following); a chapter card's Series and Home leave.
  await page.evaluate(() => { localStorage.setItem('shiori-reader-nav', 'top'); localStorage.setItem('shiori:readerChapterDivider', 'true'); });
  await follow(page, '/');
  await left('/');
  await enter(SERIES[0], 6);
  const frame = await page.$('.reader-frame');
  await page.keyboard.press(']');
  await until(page, (g) => new URLSearchParams(location.search).get('g') === g, SERIES[1], { what: 'the address in the next chapter' });
  assert.equal(await page.evaluate((f) => f.isConnected && document.querySelector('.reader-frame') === f, frame), true, 'the same frame: one engine');
  await page.keyboard.press('[');
  await until(page, (g) => new URLSearchParams(location.search).get('g') === g, SERIES[0], { what: 'the address back in the first chapter' });
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await until(page, () => !!document.querySelector('#dividerPage .chd [data-act="series"]'), null, { what: 'the chapter card' });
  await page.click('#dividerPage .chd [data-act="series"]');
  await left(`/overview?g=${SERIES[0]}`);
  await page.goBack();
  await readerDrawn(page);
  t.diagnostic(`back in the series: ${await page.evaluate(() => location.search)}, ${await counter(page)}`);
  // Back at the chapter's last page (the address it had): one more page is its card.
  await until(page, () => document.getElementById('pageCounter').textContent.replace(/\s+/g, ' ').trim() === '6 / 6', null, { what: 'the last page of the chapter' });
  await page.keyboard.press('ArrowRight');
  await until(page, () => !!document.querySelector('#dividerPage .chd [data-act="home"]'), null, { what: 'the chapter card again' });
  await page.click('#dividerPage .chd [data-act="home"]');
  await left('/');
  assert.equal(await stayed(), true);
});

// A series' overview (its rows are drawn with it) and a gallery's own (its page grid's tiles come a moment
// after it is drawn: the grid stands at the height it had until they are in, overview-ways.browser).
test('Back from the reader shows the overview as it was left, its scroll kept', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  // [the overview, its scroll, the gallery read, what the overview has drawn]: the gallery's scroll is one
  // the page cannot hold without its grid.
  const cases = [
    [SERIES[0], 150, SERIES[1], () => document.querySelectorAll('.ch-row').length === 3],
    [SINGLE, 500, SINGLE, () => document.querySelectorAll('#ovPages > .ov-page').length === 10],
  ];
  for (const [g, y, read, there] of cases) {
    const page = await open(t, `/overview?g=${g}`, settingsFor({ nav: 'top', mode: 'strip' }));
    await page.setViewport({ width: 1280, height: 300 });
    await until(page, there, null, { what: 'the overview' });
    await until(page, (y) => document.documentElement.scrollHeight > innerHeight + y, y, { what: 'the overview, taller than the window' });
    // Its figures in (a library just written is still being measured): its words still for a second.
    await until(page, () => {
      const text = document.getElementById('ovContent').innerText, now = performance.now();
      if (text !== window.__text) { window.__text = text; window.__textSince = now; return false; }
      return now - window.__textSince >= 1000;
    }, null, { what: 'the words of the overview still' });
    await page.evaluate((y) => { scrollTo(0, y); window.__stayed = true; }, y);
    await sleep(300);
    const before = await page.evaluate(() => ({ y: scrollY, title: document.title, text: document.getElementById('ovContent').innerText }));
    assert.equal(before.y, y);
    await follow(page, `/reader?g=${read}&page=1`);
    await readerDrawn(page);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel({ deltaY: 900 }); await sleep(150); }
    await page.goBack();
    await until(page, () => !document.querySelector('.reader-frame') && !!document.querySelector('#root main, #ovContent .ov-hero, #settingsNav, #tkList'), null, { what: 'the overview' });
    await until(page, there, null, { what: 'the overview again' });
    await sleep(600);
    const now = await page.evaluate(() => ({ y: scrollY, title: document.title, text: document.getElementById('ovContent').innerText }));
    assert.deepEqual(now, before);
    assert.equal(await page.evaluate(() => window.__stayed), true, 'the same document');
  }
});

test('another gallery is another frame and another engine; the address\'s own chapter moves keep the frame', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(t, `/reader?g=${SINGLE}&page=2`);
  await readerDrawn(page);
  const first = await page.$('.reader-frame');
  await page.evaluate(() => { window.__stayed = true; });
  await follow(page, `/reader?g=${OTHER}&page=1`);
  await until(page, (f) => !f.isConnected, first, { what: 'the first frame gone' });
  await readerDrawn(page);
  assert.equal(await counter(page), '1 / 4');
  assert.deepEqual(await page.evaluate(() => [window.__stayed, document.querySelectorAll('.reader-frame').length, document.title]), [true, 1, `Shiori — #${'1790000000822'}`]);
  await page.goBack();
  await readerDrawn(page);
  assert.equal(await counter(page), '2 / 10');
});

// What is left after each leave: listeners on the window and the document (CDP), and the browser's own
// counts of DOM nodes and JS listeners, the least of several reads, each straight after a collection
// (they count objects not yet collected: reader-lifecycle's note).
async function leftBehind(page, cdp) {
  let nodes = Infinity, jsEventListeners = Infinity;
  for (let i = 0; i < 6; i++) {
    await cdp.send('HeapProfiler.collectGarbage');
    const now = await cdp.send('Memory.getDOMCounters');
    nodes = Math.min(nodes, now.nodes);
    jsEventListeners = Math.min(jsEventListeners, now.jsEventListeners);
    await sleep(50);
  }
  const listeners = {};
  for (const [name, expr] of [['window', 'window'], ['document', 'document']]) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    listeners[name] = (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.map((l) => l.type).sort().join(' ');
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
  }
  const inPage = await page.evaluate(() => ({ urls: globalThis.__urls.size, workers: globalThis.__workers.filter((w) => w.alive).length,
    tips: document.querySelectorAll('.shiori-tip').length, bodyKids: [...document.body.children].map((e) => e.id || e.className).join(' '),
    styles: document.head.querySelectorAll('style').length, readerSheets: [...document.querySelectorAll('link[rel="stylesheet"]')].filter((l) => l.href.endsWith('/app/reader.css')).length }));
  return { nodes, jsEventListeners, listeners, ...inPage };
}

test('entered and left five times (pages turned, a mode, study, a dialog), the reader leaves nothing behind', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument((settings) => {
    for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value);
    const urls = new Set(), workers = [];
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    URL.createObjectURL = (o) => { const u = create.call(URL, o); urls.add(u); return u; };
    URL.revokeObjectURL = (u) => { urls.delete(u); return revoke.call(URL, u); };
    const W = globalThis.Worker;
    globalThis.Worker = class extends W { constructor(...a) { super(...a); this.__rec = { alive: true }; workers.push(this.__rec); } terminate() { this.__rec.alive = false; return super.terminate(); } };
    globalThis.__urls = urls; globalThis.__workers = workers;
  }, settingsFor({ nav: 'top', mode: 'strip' }));
  const cdp = await page.createCDPSession();
  // From Tasks and back there: a page that keeps no pictures of its own, so what is left is the reader's.
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  await page.evaluate(() => { window.__stayed = true; });
  const rows = [];
  for (let c = 1; c <= 5; c++) {
    await follow(page, `/reader?g=${SINGLE}&page=1`);
    await readerDrawn(page);
    await page.mouse.move(640, 450);
    for (let i = 0; i < 2; i++) { await page.mouse.wheel({ deltaY: 700 }); await sleep(100); }
    await page.keyboard.press('1');
    await until(page, () => document.getElementById('singleView').classList.contains('active'), null, { what: 'single page' });
    await page.keyboard.press('ArrowRight'); await sleep(150);
    await page.keyboard.press('g');
    await until(page, () => document.querySelectorAll('#thumbStrip .thumb-item img[src]').length > 0, null, { what: 'thumbnails' });
    await page.keyboard.press('g');
    await page.evaluate(() => document.getElementById('readerSettingsBtn').click());
    await until(page, () => !!document.querySelector('#readerSettingsModal.show'), null, { what: 'reader settings' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('i');
    await until(page, () => !!document.querySelector('dialog.pp-dialog[open]'), null, { what: 'page properties' });
    await page.goBack();
    await until(page, () => !document.querySelector('.reader-frame') && !!document.getElementById('tkList'), null, { what: 'Tasks again' });
    await sleep(200);
    rows.push(await leftBehind(page, cdp));
  }
  t.diagnostic(JSON.stringify(rows.map(({ nodes, jsEventListeners, urls, workers }) => ({ nodes, jsEventListeners, urls, workers }))));
  assert.equal(await page.evaluate(() => window.__stayed), true, 'one document throughout');
  const [first] = rows;
  for (const row of rows) {
    assert.deepEqual(row.listeners, first.listeners, 'listeners on the window and the document as after the first visit');
    assert.deepEqual({ urls: row.urls, workers: row.workers, tips: row.tips, styles: row.styles, readerSheets: row.readerSheets, bodyKids: row.bodyKids },
      { urls: 0, workers: 0, tips: 1, styles: first.styles, readerSheets: 1, bodyKids: first.bodyKids });
  }
  assert.ok(rows[4].nodes <= rows[2].nodes, `DOM nodes grew from ${rows[2].nodes} to ${rows[4].nodes}`);
  assert.ok(rows[4].jsEventListeners <= rows[2].jsEventListeners, `JS listeners grew from ${rows[2].jsEventListeners} to ${rows[4].jsEventListeners}`);
});

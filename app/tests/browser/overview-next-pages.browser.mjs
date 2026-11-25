// overview-next-pages.browser.mjs — the overview's page grid and its thumbnails at /overview-next, held
// to what 1.3's page (/overview) gave driven alike (its own measures are overview-pages.browser.mjs's,
// run here too): which copy each tile gets at the grid's
// tile width and at twice the pixel ratio; the tiles in view first; the warm-up making every tile's copy
// ahead, each once; the two bands (a tile far from view lets its picture go, one within 5,400px keeps
// it, scrolled back the copies made show again with none made twice); a tile with no copy yet showing
// its ground, never a broken image; and, the page left (a route change), its workers ended and every
// copy's object URL revoked. Then leaving the page five times with a chapter's pages open and a job
// running leaves nothing behind (listeners, intervals, observers, channels, workers, object URLs).
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the overview's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { record } from './records.mjs';
import { openRun, nextBase, gid, visit, sleep, publish, NEW } from './overview-drive.mjs';

const FILE = basename(fileURLToPath(import.meta.url));
const COUNT = 400;
let server, origin, browser, base, long;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  base = nextBase(1790009700000);
  long = String(base + 60);
  const page = await openRun(browser, origin, base);
  // A gallery of 400 small pages, each its own colour (a few hundred KB in all).
  await page.evaluate(async ({ gid, count }) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'A long gallery', japanese: '', pretty: '' }, tags: [], numPages: count });
    for (let n = 1; n <= count; n++) {
      const c = new OffscreenCanvas(150, 215);
      const x = c.getContext('2d');
      x.fillStyle = `hsl(${(n * 37) % 360} 60% 50%)`; x.fillRect(0, 0, 150, 215);
      x.fillStyle = '#fff'; x.fillRect(20, 20, n % 100, 10);
      await api.pages.put(gid, n, await c.convertToBlob({ type: 'image/png' }));
    }
  }, { gid: long, count: COUNT });
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

// In every document: the copies asked of the workers (by width), the workers started and ended, the
// object URLs alive, and the order tiles got their pictures.
function instrument() {
  const seen = window.__thumbs = { posted: [], workers: 0, ended: 0, urls: new Set(), order: [] };
  const W = window.Worker;
  window.Worker = class extends W {
    constructor(...a) { super(...a); seen.workers++; }
    postMessage(msg, ...rest) { if (msg?.width) seen.posted.push(msg.width); return super.postMessage(msg, ...rest); }
    terminate() { if (!this.__ended) { this.__ended = true; seen.ended++; } return super.terminate(); }
  };
  const cu = URL.createObjectURL, ru = URL.revokeObjectURL;
  URL.createObjectURL = (o) => { const u = cu(o); seen.urls.add(u); return u; };
  URL.revokeObjectURL = (u) => { seen.urls.delete(u); return ru(u); };
  new MutationObserver((records) => {
    for (const r of records) if (r.attributeName === 'src' && r.target.matches?.('.ov-page img') && r.target.getAttribute('src')) seen.order.push(Number(r.target.dataset.pageNum));
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['src'] });
}

async function open(path, { scale = 1 } = {}) {
  const page = await openPage(browser, origin);
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: scale });
  await page.evaluateOnNewDocument(instrument);
  await page.goto(`${origin}${path}?g=${long}`, { waitUntil: 'load' });
  await until(page, (n) => document.querySelectorAll('#ovPages .ov-page img').length === n, COUNT, { what: `${path}: the tiles` });
  return page;
}
const inView = () => [...document.querySelectorAll('#ovPages .ov-page img')].filter((img) => { const r = img.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });

test('each tile\'s copy: 1.5 times its pixels, stepped; at twice the pixel ratio, twice; the tiles in view first: as on 1.3\'s page', { skip: !chromePath() }, async () => {
  const now = {};
  for (const scale of [1, 2]) {
    const page = await open(NEW, { scale });
    await until(page, () => [...document.querySelectorAll('#ovPages .ov-page img')].filter((img) => { const r = img.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).every((img) => img.dataset.ready), null, { what: 'the tiles in view' });
    now[scale] = await page.evaluate((src) => {
      const view = (0, eval)(`(${src})`)();
      const shown = new Set(view.map((img) => Number(img.dataset.pageNum)));
      const first = window.__thumbs.order.slice(0, shown.size);
      // (Which of them came first is the copies' finishing order, which differs run to run: held by its
      // bound, nearly all of the first pictures shown were tiles in view, a few copies running at once.)
      const firstInView = first.filter((n) => shown.has(n)).length;
      return { tile: Math.round(view[0].parentElement.clientWidth * 100) / 100, widths: [...new Set(view.map((img) => img.dataset.width))], inView: shown.size,
        viewFirst: firstInView >= shown.size - 8 };
    }, inView.toString());
    assert.deepEqual(page.problems, []);
    await page.close();
  }
  const was = record(FILE, 'copies');
  assert.deepEqual(now, was);
  assert.deepEqual(was[1].widths, ['192']);
  assert.deepEqual(was[2].widths, ['384']);
  // Of the first pictures shown, nearly all were tiles in view.
  assert.deepEqual([was[1].viewFirst, was[2].viewFirst], [true, true]);
});

test('the warm-up makes every tile\'s copy ahead, each once; far from view a tile lets its picture go, within 5,400px it keeps it; back again, none made twice', { skip: !chromePath() }, async () => {
  let now;
  {
    const path = NEW;
    const page = await open(path);
    await until(page, (n) => window.__thumbs.posted.length >= n, COUNT, { what: `${path}: every copy made`, timeout: 120000 });
    await sleep(1000);
    const made = await page.evaluate(() => window.__thumbs.posted.length);
    // To the end: the top's tiles (more than 5,400px above) let theirs go.
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await sleep(1500);
    const kept = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('#ovPages .ov-page img')];
      return { painted: imgs.filter((img) => img.getAttribute('src')).length, firstPainted: Number(imgs.find((img) => img.getAttribute('src'))?.dataset.pageNum),
        scroll: Math.round(scrollY) };
    });
    // Back to the top: shown again from what was made, nothing made again.
    await page.evaluate(() => scrollTo(0, 0));
    await until(page, () => [...document.querySelectorAll('#ovPages .ov-page img')].filter((img) => { const r = img.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).every((img) => img.getAttribute('src')), null, { what: `${path}: the top again` });
    await sleep(500);
    now = { made, kept, after: await page.evaluate(() => window.__thumbs.posted.length) };
    assert.deepEqual(page.problems, []);
    await page.close();
  }
  const was = record(FILE, 'warm');
  assert.deepEqual(now, was);
  assert.equal(was.made, COUNT, 'each tile\'s copy made once');
  assert.equal(was.after, COUNT, 'none made again on the way back');
  assert.ok(was.kept.firstPainted > 1 && was.kept.painted < COUNT, JSON.stringify(was.kept));
});

// 1.3's own measures (overview-pages.browser.mjs; 1.3's page met them too): scrolled at 12,000px a
// second, no tile draws a broken image; with a moment for the warm-up first, the tiles scrolled to show
// their copies.
function scrollToEnd(page, pxPerSec) {
  return page.evaluate(async (pxPerSec) => {
    const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const imgs = [...document.querySelectorAll('#ovPages .ov-page img')];
    let last = await raf(), tiles = 0, blank = 0, glyph = 0;
    while (scrollY < document.documentElement.scrollHeight - innerHeight - 1) {
      const now = await raf();
      scrollBy(0, pxPerSec * (now - last) / 1000);
      last = now;
      for (const img of imgs) {
        const r = img.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) continue;
        tiles++;
        if (img.getAttribute('src') && img.complete && img.naturalWidth) continue;
        blank++;
        if (!img.getAttribute('src') && getComputedStyle(img).visibility !== 'hidden') glyph++;
      }
    }
    return { blank: blank / Math.max(1, tiles), glyph };
  }, pxPerSec);
}
test('a tile with no copy yet shows its ground; made ahead, the tiles scrolled to show theirs', { skip: !chromePath() }, async () => {
  for (const path of [NEW]) {
    let page = await open(path);
    assert.equal((await scrollToEnd(page, 12000)).glyph, 0, `${path}: no broken image`);
    await page.close();
    page = await open(path);
    await until(page, (n) => window.__thumbs.posted.length >= n, COUNT, { what: `${path}: every copy made`, timeout: 120000 });
    const { blank } = await scrollToEnd(page, 12000);
    assert.ok(blank < 0.05, `${path}: tiles scrolled to show their copies (${(blank * 100).toFixed(1)}% blank)`);
    await page.close();
  }
});

test('the page left: its workers ended, every copy\'s object URL revoked', { skip: !chromePath() }, async () => {
  const page = await open(NEW);
  await until(page, (n) => window.__thumbs.posted.length >= n, 60, { what: 'copies made' });
  await page.click('#settingsBtn');
  await until(page, () => location.pathname === '/settings', null, { what: 'Settings' });
  await sleep(500);
  const left = await page.evaluate(() => ({ workers: window.__thumbs.workers, ended: window.__thumbs.ended, urls: window.__thumbs.urls.size }));
  assert.ok(left.workers >= 1);
  assert.equal(left.ended, left.workers, 'every worker ended');
  assert.equal(left.urls, 0, 'every object URL revoked');
  await page.close();
});

// In the page, from its start: what it holds that a page left must let go of (window and document
// listeners, intervals, timers over a second, observers, channels).
function holding() {
    const held = window.__held = { listeners: 0, intervals: 0, timers: 0, observers: 0, channels: 0 };
    for (const target of [window, document]) {
      const add = target.addEventListener, remove = target.removeEventListener;
      target.addEventListener = function (type, fn, opts) {
        const k = `${type}|${typeof opts === 'object' ? !!opts?.capture : !!opts}`;
        const key = fn && (fn.__keys ??= new Set());
        if (key && !key.has(k)) {
          key.add(k); held.listeners++;
          opts?.signal?.addEventListener('abort', () => { if (key.delete(k)) held.listeners--; }, { once: true });
          if (typeof opts === 'object' && opts?.once) { const self = this; const off = () => { if (key.delete(k)) held.listeners--; }; add.call(self, type, off, { once: true }); }
        }
        return add.call(this, type, fn, opts);
      };
      target.removeEventListener = function (type, fn, opts) { const k = `${type}|${typeof opts === 'object' ? !!opts?.capture : !!opts}`; if (fn?.__keys?.has(k)) { fn.__keys.delete(k); held.listeners--; } return remove.call(this, type, fn, opts); };
    }
    const si = window.setInterval, ci = window.clearInterval, live = new Set();
    window.setInterval = (...a) => { const h = si(...a); live.add(h); held.intervals = live.size; return h; };
    window.clearInterval = (h) => { live.delete(h); held.intervals = live.size; return ci(h); };
    // Timers still to run that are longer than a second (the page's own, not a frame's or a tick's).
    const st = window.setTimeout, ct = window.clearTimeout, pending = new Set();
    window.setTimeout = (fn, ms, ...a) => { let h; h = st((...b) => { pending.delete(h); held.timers = pending.size; if (typeof fn === 'function') fn(...b); }, ms, ...a); if (ms > 1000) { pending.add(h); held.timers = pending.size; } return h; };
    window.clearTimeout = (h) => { pending.delete(h); held.timers = pending.size; return ct(h); };
    for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
      const Base = window[name];
      window[name] = class extends Base { observe(...a) { if (!this.__on) { this.__on = true; held.observers++; } return super.observe(...a); } disconnect() { if (this.__on) { this.__on = false; held.observers--; } return super.disconnect(); } };
    }
    const BC = window.BroadcastChannel;
    window.BroadcastChannel = class extends BC { constructor(n) { super(n); held.channels++; } close() { if (!this.__closed) { this.__closed = true; held.channels--; } return super.close(); } };
}

test('leaving the page five times with a chapter\'s pages open and a job running leaves nothing behind', { skip: !chromePath() }, async () => {
  const page = await openPage(browser, origin);
  await page.evaluateOnNewDocument(instrument);
  await page.evaluateOnNewDocument(holding);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await sleep(1500);
  const counts = [];
  for (let i = 0; i < 6; i++) {
    await page.evaluate((path) => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `${NEW}?g=${gid(base, 'S')}`);
    await until(page, () => document.querySelectorAll('.ch-row').length === 4 && !!document.querySelector('#seriesCover img'), null, { what: 'the overview' });
    await publish(page, { gid: gid(base, 'S2'), kind: 'download', status: 'downloading', downloaded: 100, total: 1000, pages: 2 });
    await page.hover('.ch-row:nth-child(1) .ch-head');
    await page.click('.ch-row:nth-child(1) [data-expand]');
    await until(page, () => [...document.querySelectorAll('.ch-row:nth-child(1) .ch-pages .ov-page img')].some((img) => img.getAttribute('src')) && !!document.querySelector('.ch-row.working'), null, { what: 'the pages open and the job drawn' });
    await sleep(300);
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/tasks' && !document.getElementById('ovContent'), null, { what: 'Tasks again' });
    await sleep(1500);
    counts.push(await page.evaluate(() => ({ ...window.__held, workers: window.__thumbs.workers - window.__thumbs.ended, urls: window.__thumbs.urls.size,
      rows: document.querySelectorAll('.ch-row').length, tips: document.querySelectorAll('.shiori-tip').length })));
  }
  assert.ok(counts.every((c) => c.workers === 0 && c.urls === 0 && c.rows === 0), JSON.stringify(counts));
  // After the first return, nothing grows with each later one.
  assert.deepEqual(counts.slice(1), Array(5).fill(counts[0]), JSON.stringify(counts));
  assert.deepEqual(page.problems, []);
  await page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); });
  await page.close();
});

// What its buttons open (7b): left in edit mode with a delete's question open, a job running, after
// Replace's file input was made and its tag editor opened and closed, five times: nothing of them stays
// (the question is answered as Cancel, the input goes with the page), and nothing grows.
test('leaving the page five times in edit mode, a question open and a job running, leaves nothing behind', { skip: !chromePath() }, async () => {
  const page = await openPage(browser, origin);
  await page.evaluateOnNewDocument(instrument);
  await page.evaluateOnNewDocument(holding);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await sleep(1500);
  const counts = [];
  const row = (part) => `.ch-row[data-chapter-id="${gid(base, part)}"]`;
  for (let i = 0; i < 6; i++) {
    await page.evaluate((path) => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `${NEW}?g=${gid(base, 'S')}`);
    await until(page, () => document.querySelectorAll('.ch-row').length === 4 && !!document.querySelector('#seriesCover img'), null, { what: 'the overview' });
    await publish(page, { gid: gid(base, 'S2'), kind: 'download', status: 'downloading', downloaded: 100, total: 1000, pages: 2 });
    // Replace's input made (its picker cancelled), the tag editor opened and closed.
    await page.hover(`${row('S3')} .ch-main`);
    await page.keyboard.down('Shift');
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 5000 }), page.click(`${row('S3')} [data-download]`)]);
    await page.keyboard.up('Shift');
    await chooser.cancel();
    await page.click('#editToggle');
    await page.click('.ov-chip-add');
    await until(page, () => !!document.getElementById('tagEdType'), null, { what: 'the tag editor' });
    await sleep(300);
    await page.keyboard.press('Escape');
    await until(page, () => !document.getElementById('tagEdType'), null, { what: 'the tag editor closed' });
    // A delete's question open as the page is left.
    await page.hover(`${row('S3')} .ch-main`);
    await page.click(`${row('S3')} [data-remove]`);
    await until(page, () => !!document.querySelector('[data-notice="dialog"]') && !!document.querySelector('.ch-row.working') && !!document.querySelector('#ovContent.ov-editing'), null, { what: 'edit mode, the question and the job' });
    await sleep(300);
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/tasks' && !document.getElementById('ovContent'), null, { what: 'Tasks again' });
    await sleep(1500);
    counts.push(await page.evaluate(() => ({ ...window.__held, workers: window.__thumbs.workers - window.__thumbs.ended, urls: window.__thumbs.urls.size,
      rows: document.querySelectorAll('.ch-row').length, tips: document.querySelectorAll('.shiori-tip').length,
      dialogs: document.querySelectorAll('[data-notice], [role="dialog"]').length, inputs: document.querySelectorAll('input[type="file"]').length })));
  }
  assert.ok(counts.every((c) => c.workers === 0 && c.urls === 0 && c.rows === 0 && c.dialogs === 0 && c.inputs === 0), JSON.stringify(counts));
  assert.deepEqual(counts.slice(1), Array(5).fill(counts[0]), JSON.stringify(counts));
  // Nothing was deleted: the question left was answered as Cancel.
  assert.equal(await page.evaluate(async (id) => !!(await (await import('/app/js/api.js')).galleries.get(id)), gid(base, 'S3')), true);
  assert.deepEqual(page.problems, []);
  await page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); });
  await page.close();
});

// 7c: left five times mid-drag (the pointer still held on a grip), with the add list open and a batch of
// imports running in the tracker: nothing of them stays (the drag's place and look on no row, the page's
// drag cursor, the list, the tracker's panels), the order is not saved, and nothing grows.
test('leaving the page five times mid-drag, with the add list open and a batch running, leaves nothing behind', { skip: !chromePath() }, async () => {
  const page = await openPage(browser, origin);
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(instrument);
  await page.evaluateOnNewDocument(holding);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await sleep(1500);
  const order = () => page.evaluate(async (g) => (await (await import('/app/js/api.js')).series.resolve(g)).chapters.map((c) => String(c.id)).join(), gid(base, 'S'));
  const was = await order();
  const counts = [];
  for (let i = 0; i < 6; i++) {
    await page.evaluate((path) => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `${NEW}?g=${gid(base, 'S')}`);
    await until(page, () => document.querySelectorAll('.ch-row').length === 4 && !!document.querySelector('#seriesCover img'), null, { what: 'the overview' });
    // A batch of imports running (as its runner tells of it; the same one each time: Tasks, where the page
    // is left for, shows it too).
    await publish(page, { gid: 'import-left', kind: 'import', status: 'progress', name: '2 items', total: 2, done: 0, imported: 0, skipped: 0, failed: 0, bytes: 527, bytesDone: 0, current: { name: 'Next One', done: 0, total: 2, bytes: 300 }, startedAt: Date.now(), movedAt: Date.now() });
    await until(page, () => !!document.querySelector('#ovImports .ib[data-state="running"]'), null, { what: 'the batch in the tracker' });
    // The add list open.
    await page.$eval('#addSearch', (el) => { el.value = ''; el.scrollIntoView({ block: 'center' }); });
    await page.click('#addSearch');
    await page.type('#addSearch', 'gallery', { delay: 10 });
    await until(page, () => document.querySelectorAll('#addResults .add-res').length > 0, null, { what: 'the add list' });
    // A row's grip pressed and dragged, the pointer still held as the page is left.
    await page.$eval('.ch-row:nth-child(1)', (el) => el.scrollIntoView({ block: 'center' }));
    const grip = await page.$eval('.ch-row:nth-child(1) .ch-grip', (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await page.mouse.move(grip.x + 30, grip.y); await page.mouse.move(grip.x, grip.y); await sleep(100);
    await page.mouse.down();
    await page.mouse.move(grip.x, grip.y + 80, { steps: 8 });
    await until(page, () => !!document.querySelector('.ch-row[data-dragging]') && !!document.getElementById('addResults'), null, { what: 'mid-drag, the list open' });
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/tasks' && !document.getElementById('ovContent'), null, { what: 'Tasks again' });
    await page.mouse.up();
    await sleep(1500);
    counts.push(await page.evaluate(() => ({ ...window.__held, workers: window.__thumbs.workers - window.__thumbs.ended, urls: window.__thumbs.urls.size,
      rows: document.querySelectorAll('.ch-row').length, tips: document.querySelectorAll('.shiori-tip').length, list: document.querySelectorAll('#addResults').length,
      panels: document.querySelectorAll('#ovImports .ib').length, dragging: document.body.classList.contains('ch-dragging') })));
  }
  assert.ok(counts.every((c) => c.workers === 0 && c.urls === 0 && c.rows === 0 && c.list === 0 && c.panels === 0 && !c.dragging), JSON.stringify(counts));
  // (Tasks, where the page is left for, shows the batch too: its timers of over a second come and go with
  // its own pace, one more or less at the moment counted, never more each time.)
  const but = ({ timers, ...c }) => c;
  assert.deepEqual(counts.slice(1).map(but), Array(5).fill(but(counts[0])), JSON.stringify(counts));
  assert.ok(Math.max(...counts.map((c) => c.timers)) - Math.min(...counts.map((c) => c.timers)) <= 1, JSON.stringify(counts));
  assert.equal(await order(), was, 'the order not saved');
  assert.deepEqual(page.problems, []);
  await page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); });
  await page.close();
});

// 7d: on the phone form, left five times with a finger's drag held on a row's grip and the delete's
// question open (pressed while the finger is still down): nothing of them stays (no row placed or
// lifted, no question, no drag cursor), the order is not saved, and nothing grows.
test('on a phone, leaving the page five times with a finger\'s drag held and a question open leaves nothing behind', { skip: !chromePath() }, async () => {
  const page = await openPage(browser, origin);
  await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
  await page.evaluateOnNewDocument(instrument);
  await page.evaluateOnNewDocument(holding);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await sleep(1500);
  const cdp = await page.createCDPSession();
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const order = () => page.evaluate(async (g) => (await (await import('/app/js/api.js')).series.resolve(g)).chapters.map((c) => String(c.id)).join(), gid(base, 'S'));
  const was = await order();
  const counts = [];
  for (let i = 0; i < 6; i++) {
    await page.evaluate((path) => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `${NEW}?g=${gid(base, 'S')}`);
    await until(page, () => document.querySelectorAll('.ch-row').length === 4 && !!document.querySelector('#seriesCover img'), null, { what: 'the overview' });
    await page.$eval('.ch-row:nth-child(2)', (el) => el.scrollIntoView({ block: 'center' }));
    await sleep(200);
    const grip = await page.$eval('.ch-row:nth-child(2) .ch-grip', (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    await touch('touchStart', [{ x: grip.x, y: grip.y }]);
    for (let k = 1; k <= 8; k++) { await touch('touchMove', [{ x: grip.x, y: grip.y + 10 * k }]); await sleep(20); }
    await page.$eval('.ch-row:nth-child(3) [data-remove]', (el) => el.click());
    await until(page, () => !!document.querySelector('.ch-row[data-dragging]') && !!document.querySelector('[data-notice="dialog"]'), null, { what: 'mid-drag, the question open' });
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/tasks' && !document.getElementById('ovContent'), null, { what: 'Tasks again' });
    await touch('touchEnd', []);
    await sleep(1500);
    counts.push(await page.evaluate(() => ({ ...window.__held, workers: window.__thumbs.workers - window.__thumbs.ended, urls: window.__thumbs.urls.size,
      rows: document.querySelectorAll('.ch-row').length, dialogs: document.querySelectorAll('[data-notice], [role="dialog"]').length,
      dragging: document.body.classList.contains('ch-dragging') })));
  }
  assert.ok(counts.every((c) => c.workers === 0 && c.urls === 0 && c.rows === 0 && c.dialogs === 0 && !c.dragging), JSON.stringify(counts));
  const but = ({ timers, ...c }) => c;
  assert.deepEqual(counts.slice(1).map(but), Array(5).fill(but(counts[0])), JSON.stringify(counts));
  assert.ok(Math.max(...counts.map((c) => c.timers)) - Math.min(...counts.map((c) => c.timers)) <= 1, JSON.stringify(counts));
  assert.equal(await order(), was, 'the order not saved');
  assert.deepEqual(page.problems, []);
  await page.close();
});

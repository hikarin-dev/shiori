// library-keys.browser.mjs — W/S scrolling and F5 on /library, held to what 1.3's page
// (/library) gave driven alike. W and S scroll the window from the keydown, every frame, at 1.3's speed
// (11px a frame, Shift twice that, changing as Shift goes down and up mid-hold) until the key is let go
// or the window loses focus; nothing scrolls from the search box. F5 and Ctrl+R read the library again
// in place: a gallery changed underneath (where the page hears nothing of it) shows its change, no page
// is loaded, the page's scroll is kept, no cover is asked for again; Ctrl+Shift+R is the browser's own
// reload. With the sort list open, or a question or the filter's dialog open, what each page does with
// the keys. And leaving the new page five times with W held, the menu open and Safe Mode on leaves
// nothing behind.
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the library's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { readDialog, answer } from './library-drive.mjs';
import { record } from './records.mjs';

const NEW = '/library';
const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser;
const BASE = 1790008100000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async (base) => {
    const api = await import('/app/js/api.js');
    for (let i = 0; i < 36; i++) {
      const gid = String(base + i);
      const c = new OffscreenCanvas(300, 430); const x = c.getContext('2d'); x.fillStyle = `hsl(${i * 9} 60% 50%)`; x.fillRect(0, 0, 300, 430);
      await api.meta.put({ galleryId: gid, title: { english: `Keys gallery ${i}`, japanese: '', pretty: '' }, tags: [{ type: 'tag', name: `t${i % 4}` }], numPages: 1 });
      await api.pages.put(gid, 1, await c.convertToBlob({ type: 'image/png' }));
    }
    await (await import('/app/js/migrations.js')).runMigrations();
  }, BASE);
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

async function open(path, size = { width: 1280, height: 700 }) {
  const page = await openPage(browser, origin);
  await page.setViewport(size);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('shiori:lib')) localStorage.removeItem(k); localStorage.removeItem('shiori-safe-mode'); });
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('#grid > .card').length === 30 && [...document.querySelectorAll('#grid > .card img.card-thumb')].every((i) => i.getAttribute('src') && i.complete),
    null, { what: 'the page' });
  await sleep(300);
  // The page's scroll in every frame from here (kept in the page).
  await page.evaluate(() => {
    window.__ys = [];
    const tick = () => { window.__ys.push(scrollY); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  return page;
}
// The page's scroll per frame since the last call: the steps it took.
const steps = (page) => page.evaluate(() => { const ys = window.__ys.splice(0); return ys.slice(1).map((y, i) => y - ys[i]); });
// The steps of a phase, its first frame or two aside (a key's frame may land between two).
const kinds = (s) => [...new Set(s.slice(2).filter((d) => d !== 0))].sort((a, b) => a - b);

test('W and S: from the keydown, every frame, at 1.3\'s speed, Shift twice as fast and live; let go, or the window\'s focus lost: still', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW);
    await page.mouse.click(100, 85);
    await steps(page);
    const r = {};
    await page.keyboard.down('s'); await sleep(400); r.s = await steps(page);
    await page.keyboard.down('Shift'); await sleep(300); r.shift = await steps(page);
    await page.keyboard.up('Shift'); await sleep(300); r.shiftUp = await steps(page);
    await page.keyboard.up('s'); await sleep(200); r.up = await steps(page);
    await page.keyboard.down('w'); await sleep(300); r.w = await steps(page);
    // The window's focus lost: it stops, and a key held through it does nothing more.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(200); r.blur = await steps(page);
    await page.keyboard.up('w');
    // Both at once: they cancel (and the loop ends: letting one go starts nothing, as 1.3's).
    await page.keyboard.down('s'); await page.keyboard.down('w'); await sleep(200); r.both = await steps(page);
    await page.keyboard.up('w'); await sleep(200); r.bothS = await steps(page);
    await page.keyboard.up('s'); await sleep(100); await steps(page);
    const now = {
      s: kinds(r.s), sFirst: r.s.findIndex((d) => d !== 0) <= 1, shift: kinds(r.shift), shiftUp: kinds(r.shiftUp), up: kinds(r.up.slice(1)), w: kinds(r.w), blur: kinds(r.blur.slice(1)),
      both: kinds(r.both.slice(2)), bothS: kinds(r.bothS),
      steady: r.s.slice(2).every((d) => d === 11) && r.shift.slice(2).every((d) => d === 22),
    };
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'scroll');
    assert.deepEqual(was, { s: [11], sFirst: true, shift: [22], shiftUp: [11], up: [], w: [-11], blur: [], both: [], bothS: [], steady: true });
    assert.deepEqual(now, was);
  }
});

test('W and S do nothing from the search box; with the sort list, a question or the filter open: what each page does', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW);
    const r = {};
    const held = async (key = 's') => { await steps(page); await page.keyboard.down(key); await sleep(250); await page.keyboard.up(key); await sleep(100); return (await steps(page)).reduce((a, b) => a + b, 0) !== 0; };
    await page.click('#searchBox');
    r.search = [await held(), await page.evaluate(() => document.getElementById('searchBox').textContent)];
    await page.keyboard.press('Escape');
    await page.mouse.click(100, 85);
    // The sort list open.
    await page.click('#sortSelect');
    await sleep(400);
    r.sortOpen = await page.evaluate(() => { const s = document.getElementById('sortSelect'); return s.matches(':open') || s.getAttribute('aria-expanded') === 'true'; });
    r.sort = await held();
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.mouse.click(100, 85);
    // The filter's dialog.
    await page.click('#filterBtn');
    await sleep(400);
    r.filter = await held();
    await page.keyboard.press('ArrowRight'); await sleep(400);
    r.filterArrow = await page.evaluate(() => /page=2/.test(location.search));
    await page.keyboard.press('Escape');
    await sleep(300);
    // A question (a card's delete).
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.hover('#grid > .card:nth-child(2)');
    await page.click('#grid > .card:nth-child(2) .card-btn-del');
    const asked = await readDialog(page);
    r.question = [!!asked, await held()];
    await page.keyboard.press('ArrowRight'); await sleep(400);
    r.questionArrow = await page.evaluate(() => /page=2/.test(location.search));
    await answer(page, 'cancel');
    const now = r;
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'from-boxes');
    assert.deepEqual(was.search, [false, 's']);
    assert.deepEqual(now.search, was.search);
    // No key a list or a dialog has goes to the page (§5.3 F57: 1.3 scrolled and turned the page behind
    // its dialogs, and behind its open sort list: its record says so, sort, filter and question true).
    assert.deepEqual({ ...now, search: undefined },
      { search: undefined, sortOpen: true, sort: false, filter: false, filterArrow: false, question: [true, false], questionArrow: false });
  }
});

// In the page: the gallery `gid`'s title changed in the database itself, where the page hears nothing
// of it.
async function changeUnderneath(gid, title) {
  const db = await new Promise((ok, fail) => { const req = indexedDB.open('shiori-cache'); req.onsuccess = () => ok(req.result); req.onerror = () => fail(req.error); });
  for (const name of ['galleries', 'metadata']) {
    if (!db.objectStoreNames.contains(name)) continue;
    await new Promise((ok, fail) => {
      const tx = db.transaction(name, 'readwrite');
      const os = tx.objectStore(name);
      const get = os.get(gid);
      get.onsuccess = () => { const rec = get.result; if (rec?.title) { rec.title = { ...rec.title, english: title }; os.put(rec); } };
      tx.oncomplete = ok; tx.onerror = () => fail(tx.error);
    });
  }
  db.close();
}

test('F5 and Ctrl+R: the library read again in place, nothing loaded, the scroll kept, no cover asked again; Ctrl+Shift+R the browser\'s', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW);
    const gid = String(BASE + 33);
    await page.evaluate(async () => {
      const { services } = await import('/app/js/services.js');
      window.__covers = 0;
      const handle = services.handle;
      services.handle = function (msg) { if (msg?.type === 'GET_COVER') window.__covers++; return handle.call(this, msg); };
      window.__same = true;
      window.__loads = performance.getEntriesByType('navigation').length;
    });
    const r = {};
    for (const [name, press] of [['F5', async () => page.keyboard.press('F5')],
      ['Ctrl+R', async () => { await page.keyboard.down('Control'); await page.keyboard.press('r'); await page.keyboard.up('Control'); }],
      ['F5 from the search box', async () => { await page.click('#searchBox'); await page.keyboard.press('F5'); }]]) {
      const title = `Changed underneath for ${name}`;
      await page.evaluate(changeUnderneath, gid, title);
      await page.evaluate(() => window.scrollTo(0, 600));
      await sleep(400);
      const before = await page.evaluate((gid) => document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-title`).textContent, gid);
      await press();
      await until(page, ([gid, title]) => document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-title`)?.textContent === title, [gid, title], { what: `${name}: the change shown`, timeout: 5000 }).catch(() => {});
      await sleep(300);
      r[name] = await page.evaluate((gid) => ({ title: document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-title`).textContent, same: window.__same === true,
        loads: performance.getEntriesByType('navigation').length - window.__loads, scroll: scrollY, covers: window.__covers }), gid);
      r[name].changed = before !== title;
      await page.keyboard.press('Escape');
      await page.mouse.click(1020, 27);   // the header's empty middle
    }
    // Ctrl+Shift+R: left to the browser (its reload): the page takes nothing of it.
    await page.evaluate(() => window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'r') window.__hard = e.defaultPrevented; }));
    await page.evaluate(changeUnderneath, gid, 'Changed for Ctrl+Shift+R');
    await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyR'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
    await sleep(800);
    r.hard = await page.evaluate((gid) => ({ taken: window.__hard ?? 'gone', title: document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-title`)?.textContent ?? null }), gid);
    const now = r;
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'reload');
    assert.deepEqual(was.F5, { title: 'Changed underneath for F5', same: true, loads: 0, scroll: 600, covers: 0, changed: true });
    assert.equal(was.hard.taken, false);
    assert.deepEqual(now, was);
  }
});

test('the new page left five times with W held, the menu open and Safe Mode on: nothing left behind', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.setViewport({ width: 1280, height: 700 });
  await page.evaluateOnNewDocument(() => {
    const held = window.__held = { listeners: 0, frames: 0 };
    for (const target of [window, document]) {
      const add = target.addEventListener, remove = target.removeEventListener;
      target.addEventListener = function (type, fn, opts) {
        const k = `${type}|${typeof opts === 'object' ? !!opts?.capture : !!opts}`;
        const key = fn && (fn.__keys ??= new Set());
        if (key && !key.has(k)) { key.add(k); held.listeners++; opts?.signal?.addEventListener('abort', () => { if (key.delete(k)) held.listeners--; }, { once: true }); }
        return add.call(this, type, fn, opts);
      };
      target.removeEventListener = function (type, fn, opts) { const k = `${type}|${typeof opts === 'object' ? !!opts?.capture : !!opts}`; if (fn?.__keys?.has(k)) { fn.__keys.delete(k); held.listeners--; } return remove.call(this, type, fn, opts); };
    }
    // A frame loop is a frame asked for again and again: those asked and not yet run.
    const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame, live = new Set();
    window.requestAnimationFrame = (fn) => { const h = raf((t) => { live.delete(h); held.frames = live.size; fn(t); }); live.add(h); held.frames = live.size; return h; };
    window.cancelAnimationFrame = (h) => { live.delete(h); held.frames = live.size; return caf(h); };
  });
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('shiori:lib')) localStorage.removeItem(k); localStorage.removeItem('shiori-safe-mode'); localStorage.removeItem('shiori-header-pin'); });
  await page.waitForSelector('#tkList');
  await sleep(1000);
  const at = () => page.evaluate(() => ({ ...window.__held, body: document.body.className, html: [...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`).sort().join(' '),
    stored: Object.keys(localStorage).sort(), session: Object.keys(sessionStorage).sort() }));
  const go = (href) => page.evaluate((href) => { const a = document.createElement('a'); a.href = href; document.body.append(a); a.click(); a.remove(); }, href);
  // Once, to load what the page loads the first time.
  await go(NEW);
  await until(page, () => document.querySelectorAll('#grid > .card').length === 30, null, { what: 'the library' });
  await sleep(500);
  await go('/tasks');
  await page.waitForSelector('#tkList');
  await sleep(1000);
  const start = await at();
  for (let i = 0; i < 5; i++) {
    await go(NEW);
    await until(page, () => document.querySelectorAll('#grid > .card').length === 30, null, { what: 'the library' });
    await sleep(300);
    if (i === 0) { await page.click('#safeBtn'); await sleep(200); }
    await page.click('#burgerBtn');
    await page.mouse.click(100, 85);
    await page.click('#burgerBtn');
    await page.keyboard.down('s');
    await sleep(200);
    await go('/tasks');
    await page.keyboard.up('s');
    await page.waitForSelector('#tkList');
  }
  await sleep(1500);
  const end = await at();
  assert.equal(end.listeners, start.listeners, 'listeners');
  assert.ok(end.frames <= start.frames, `frame loops: ${start.frames} → ${end.frames}`);
  assert.equal(end.body, start.body, 'the body\'s classes');
  assert.equal(end.html, start.html, 'the document\'s attributes');
  // (The pin's is written each time the page shows, as 1.3 wrote it: it is there from the first visit.)
  assert.deepEqual([...new Set([...end.stored.filter((k) => !start.stored.includes(k)), 'shiori-header-pin'])].sort(), ['shiori-header-pin', 'shiori-safe-mode'], 'stored: the two choices only');
  assert.ok(start.stored.includes('shiori-header-pin'));
  assert.deepEqual(end.session.filter((k) => !start.session.includes(k)).filter((k) => k !== 'shiori-covers'), [], 'nothing new in the session but the covers');
  assert.equal(await page.evaluate(() => scrollY), 0, 'nothing scrolls on Tasks');
  assert.deepEqual(page.problems, []);
  await page.close();
});

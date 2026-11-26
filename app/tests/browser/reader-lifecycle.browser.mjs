// reader-lifecycle.browser.mjs — the reader's engine has a start and a stop (app/js/reader.js
// startReader), started by the route that draws it: what the stop puts back, and that it leaves nothing
// behind. Where a test stops and starts the engine itself, it is held for it (harness.mjs, openPage's
// `reader`).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const GALLERY = '1790000000401';
const PAGE_COUNT = 12;
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async ({ gid, count }) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'Lifecycle fixture' }, numPages: count });
    const blobs = await Promise.all([900, 600].map(async (height) => {
      const canvas = new OffscreenCanvas(600, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#789';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.convertToBlob({ type: 'image/png' });
    }));
    for (let n = 1; n <= count; n++) await api.pages.put(gid, n, blobs[n % 2]);
    // Study layers on the first three pages: the cleaned page, and one bubble's typeset text.
    for (let n = 1; n <= 3; n++) {
      await api.derived.putTranslation(gid, n, { image: blobs[n % 2], pipeline: { job: 'j1', lines: [], read: [], regions: [] } });
      const b = { x: 0.1, y: 0.3, w: 0.5, h: 0.15 };
      await api.derived.putStudy(gid, n, { bg: blobs[n % 2], page: { w: 600, h: n % 2 ? 600 : 900 },
        bubbles: [{ id: 0, box: b, region: b, tr: 'Hello there', src: 'こんにちは', text: blobs[n % 2] }] }, 'j1');
    }
  }, { gid: GALLERY, count: PAGE_COUNT });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

// The reader's page with its engine held (globalThis.__reader), the settings given (shiori:<key>).
async function reader(t, settings = {}, { entry = 'keep', nav = 'top' } = {}) {
  const page = await openPage(browser, origin, { reader: entry });
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument((settings, nav) => {
    localStorage.setItem('shiori-reader-nav', nav);
    for (const [key, value] of Object.entries(settings)) localStorage.setItem(`shiori:${key}`, JSON.stringify(value));
  }, settings, nav);
  await page.goto(`${origin}/reader?g=${GALLERY}&page=1`, { waitUntil: 'load' });
  await until(page, () => [...document.querySelectorAll('#stripView img, #mainImg, #imgLeft')].some((i) => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().height > 0), null, { what: 'a page drawn' });
  return page;
}

// In the page: the reader's names on <html> and <body> as `attrs` (an element's attributes) has them.
function namesOf(own, attrs) {
  const el = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) if (k === 'class' || k === 'style' || k.startsWith('data-')) el.setAttribute(k, v);
  return {
    classes: own.classes.filter((c) => el.classList.contains(c)),
    data: Object.fromEntries(own.data.map((k) => [k, el.dataset[k] ?? null])),
    style: Object.fromEntries(own.style.map((p) => [p, el.style.getPropertyValue(p)])),
  };
}
const attrsNow = () => ({ html: Object.fromEntries([...document.documentElement.attributes].map((a) => [a.name, a.value])),
  body: Object.fromEntries([...document.body.attributes].map((a) => [a.name, a.value])), title: document.title });

// Every name the reader writes on <html> or <body> in its source is on its list, READER_DOCUMENT.
test('the reader\'s list of its names on <html> and <body> holds every one its code writes', () => {
  const src = ['app/js/reader.js', 'app/js/reader-study.js'].map((f) => readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8')).join('\n');
  const list = src.slice(src.indexOf('export const READER_DOCUMENT'), src.indexOf('};', src.indexOf('export const READER_DOCUMENT')));
  const listed = (kind, tag, name) => {
    const block = list.slice(list.indexOf(`${tag}: {`));
    const line = block.slice(block.indexOf(`${kind}:`), block.indexOf(']', block.indexOf(`${kind}:`)));
    return line.includes(`'${name}'`);
  };
  const found = [];
  const EL = { 'document.documentElement': 'html', 'document.body': 'body' };
  for (const [, el, name] of src.matchAll(/(document\.documentElement|document\.body)\.classList\.(?:add|remove|toggle)\('([^']+)'/g)) found.push(['classes', EL[el], name]);
  for (const [, el, name] of src.matchAll(/(document\.documentElement|document\.body)\.dataset\.(\w+)\s*=[^=]/g)) found.push(['data', EL[el], name]);
  for (const [, el, name] of src.matchAll(/(document\.documentElement|document\.body)\.style\.(?:setProperty|removeProperty)\(\s*'([^']+)'/g)) found.push(['style', EL[el], name]);
  for (const [, el] of src.matchAll(/(document\.documentElement|document\.body)\.style\.scrollPaddingTop\s*=/g)) found.push(['style', EL[el], 'scroll-padding-top']);
  for (const [, key] of src.matchAll(/\['(\w+)', sn\w+\]|\['(\w+)', sideZoom\]/g)) if (key) for (const d of ['w', 'h']) found.push(['style', 'html', `--sn-${key}-${d}`]);
  assert.ok(found.length > 50, `the scan found ${found.length} writes`);
  const missing = found.filter(([kind, tag, name]) => !listed(kind, tag, name)).map(([kind, tag, name]) => `${tag} ${kind} ${name}`);
  assert.deepEqual([...new Set(missing)], []);
});

test('stop puts back what the reader wrote on <html> and <body>, by its own names, and leaves the rest', { skip: !chromePath() }, async (t) => {
  // Settings that have the reader write many of its names as it starts.
  const page = await reader(t, { readerMode: 'double', readerFitMode: 'width', readerDim: 30, readerPageGap: 12, readerThumbsOpen: true,
    readerProgressPosition: 'left', readerPageDirection: 'rtl', readerPageZoom: 1 });
  for (const key of ['3', '1']) { await page.keyboard.press(key); await new Promise((r) => setTimeout(r, 300)); }
  const own = await page.evaluate(async () => (await import('/app/js/reader.js')).READER_DOCUMENT);

  // What the first start found (kept by the entry), what it wrote, and what others wrote meanwhile.
  const firstFound = await page.evaluate(() => globalThis.__beforeStart);
  const during = await page.evaluate(attrsNow);
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--elsewhere', '7px');
    document.documentElement.lang = 'fr';
    document.documentElement.dataset.elsewhere = 'x';
    document.body.classList.add('a-page-class');
  });
  // Every name the reader added to <html> and <body> is on its list.
  const added = await page.evaluate(({ before, now }) => {
    const names = (a) => new Set([...(a.class || '').split(/\s+/).filter(Boolean).map((c) => `class ${c}`),
      ...Object.keys(a).filter((k) => k.startsWith('data-')).map((k) => `data ${k}`),
      ...(() => { const el = document.createElement('div'); el.setAttribute('style', a.style || ''); return [...el.style].map((p) => `style ${p}`); })()]);
    const out = [];
    for (const tag of ['html', 'body']) { const was = names(before[tag]); for (const n of names(now[tag])) if (!was.has(n)) out.push(`${tag} ${n}`); }
    return out;
  }, { before: firstFound, now: during });
  const listedName = (entry) => {
    const [tag, kind, name] = entry.split(' ');
    const o = own[tag];
    if (kind === 'class') return o.classes.includes(name);
    if (kind === 'data') return o.data.includes(name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()));
    return o.style.includes(name);
  };
  // The scrollbar's own names are app-wide (scrollbar.js), not the reader's.
  assert.deepEqual(added.filter((n) => !listedName(n) && !/ style --page-scrollbar-/.test(n)), [], 'names the reader wrote that are not on its list');
  assert.ok(added.length >= 12, `the reader wrote ${added.length} of its names`);

  // scrollbar.js keeps its own names on <html> (--page-scrollbar-gap, -width): as they are before the stop.
  const scrollbarNames = () => ['--page-scrollbar-gap', '--page-scrollbar-width'].map((p) => document.documentElement.style.getPropertyValue(p));
  const scrollbarBefore = await page.evaluate(scrollbarNames);
  const { undone } = await page.evaluate(() => globalThis.__reader.stop());
  assert.deepEqual(await page.evaluate(scrollbarNames), scrollbarBefore, 'scrollbar.js\'s names as they were');
  assert.ok(undone.length >= 12, `stop put back ${undone.length}`);
  t.diagnostic(`written: ${added.join(', ')}; put back: ${undone.join(', ')}`);
  const after1 = await page.evaluate(attrsNow);
  for (const tag of ['html', 'body']) {
    assert.deepEqual(await page.evaluate(namesOf, own[tag], after1[tag]), await page.evaluate(namesOf, own[tag], firstFound[tag]), `${tag}: the reader's names as they were before it started`);
  }
  assert.equal(after1.title, firstFound.title, 'the title as it was');
  assert.equal(after1.body.class, 'a-page-class', 'a class of the page\'s stays, and the reader\'s are gone');
  assert.equal(after1.html.lang, 'fr', 'the language as set meanwhile');
  assert.equal(after1.html['data-elsewhere'], 'x');
  assert.match(after1.html.style || '', /--elsewhere: 7px/, 'a property another owner set meanwhile');
  assert.equal('style' in after1.body, false, 'no style attribute left on <body>');

  // Started again on the same frame, with the side controls, then stopped: back to the second start's.
  await page.evaluate(() => { localStorage.setItem('shiori-reader-nav', 'side'); globalThis.__reader = globalThis.__startReader(globalThis.__startOptions); });
  await until(page, () => document.body.classList.contains('reader-side-nav') && document.querySelector('#stripView img, #mainImg')?.naturalWidth > 0, null, { what: 'the second start drawn' });
  await page.keyboard.press('2');
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => document.documentElement.style.setProperty('--elsewhere', '9px'));
  await page.evaluate(() => globalThis.__reader.stop());
  const after2 = await page.evaluate(attrsNow);
  for (const tag of ['html', 'body']) {
    assert.deepEqual(await page.evaluate(namesOf, own[tag], after2[tag]), await page.evaluate(namesOf, own[tag], after1[tag]), `${tag}: as the second start found them`);
  }
  assert.match(after2.html.style || '', /--elsewhere: 9px/);
  assert.equal(after2.title, firstFound.title);
});

// Before any script of the page: counts the object URLs, workers and resize observers alive, and, once
// asked (after.on), the animation frames, timers and observer callbacks that run, by the module that
// asked for them.
function instrument() {
  const live = { urls: new Set(), workers: new Set(), ros: new Set() };
  const after = { on: false, fired: [] };
  const origin = () => {
    for (const l of (new Error().stack || '').split('\n').slice(2)) { const m = l.match(/\/(app\/js\/[^:?]+|assets\/[^:?]+)(?:\?[^:]*)?:(\d+)/); if (m) return `${m[1]}:${m[2]}`; }
    return 'unknown';
  };
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = function (o) { const u = create.call(URL, o); live.urls.add(u); return u; };
  URL.revokeObjectURL = function (u) { live.urls.delete(u); return revoke.call(URL, u); };
  const W = globalThis.Worker;
  globalThis.Worker = class extends W {
    constructor(...a) { super(...a); this.__rec = { ref: new WeakRef(this), alive: true }; live.workers.add(this.__rec); }
    terminate() { this.__rec.alive = false; return super.terminate(); }
  };
  const RO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class extends RO {
    constructor(fn) {
      const from = origin();
      super((e, o) => { if (after.on) after.fired.push(`observer ${from}`); return fn(e, o); });
      this.__rec = { ref: new WeakRef(this), observing: 0 };
      live.ros.add(this.__rec);
    }
    observe(...a) { this.__rec.observing++; return super.observe(...a); }
    disconnect() { this.__rec.observing = 0; return super.disconnect(); }
  };
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = function (fn) {
    const from = origin();
    return raf.call(globalThis, (t) => { if (after.on) after.fired.push(`frame ${from}`); return fn(t); });
  };
  const st = globalThis.setTimeout;
  globalThis.setTimeout = function (fn, ms, ...a) {
    if (typeof fn !== 'function') return st.call(globalThis, fn, ms, ...a);
    const from = origin();
    return st.call(globalThis, (...x) => { if (after.on) after.fired.push(`timer ${from}`); return fn(...x); }, ms, ...a);
  };
  globalThis.__live = () => ({ objectUrls: live.urls.size, workers: [...live.workers].filter((r) => r.alive && r.ref.deref()).length,
    observers: [...live.ros].filter((r) => r.observing > 0 && r.ref.deref()).length });
  globalThis.__after = after;
}

// The reader in use: the strip wheeled, single page with turns, double page, zoom, the thumbnails, the
// strip with auto-play (left running every other time), the progress bar scrubbed, reader settings
// opened and a setting changed, study mode with its overlay, a bubble's feedback dialog, then page
// properties or the page menu (left open).
async function use(page, c) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (k) => page.keyboard.press(k);
  const active = (id) => until(page, (id) => document.getElementById(id)?.classList.contains('active'), id, { what: id });
  await until(page, () => [...document.querySelectorAll('#stripView img, #mainImg')].some((i) => i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().height > 0), null, { what: 'a page drawn' });
  await page.mouse.move(640, 450);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel({ deltaY: 700 }); await sleep(100); }
  await key('1'); await active('singleView');
  for (const k of ['ArrowRight', 'ArrowRight', 'ArrowLeft']) { await key(k); await sleep(120); }
  await key('2'); await active('doubleView'); await key('ArrowRight'); await sleep(150);
  for (const k of ['=', '=', '-']) { await key(k); await sleep(60); }
  if (!(await page.evaluate(() => document.body.classList.contains('thumbs-open')))) await key('g');
  await until(page, () => document.querySelectorAll('#thumbStrip .thumb-item img[src]').length > 0, null, { what: 'thumbnails' });
  await key('3'); await active('stripView');
  await key('k'); await sleep(300); if (c % 2) await key('k');
  const bar = await page.evaluate(() => { const s = document.querySelectorAll('.scrub-segment'); const a = s[0].getBoundingClientRect(), b = s[s.length - 1].getBoundingClientRect(); return { x1: a.left + a.width / 2, x2: b.left + b.width / 2, y: a.top + a.height / 2 }; });
  await page.mouse.move(bar.x1, bar.y); await page.mouse.down(); await page.mouse.move(bar.x2, bar.y, { steps: 6 }); await page.mouse.move(bar.x1, bar.y, { steps: 4 }); await page.mouse.up(); await sleep(150);
  await page.evaluate(() => document.getElementById('readerSettingsBtn').click());
  await until(page, () => !!document.querySelector('[data-reader-part="settings"] #readerDim input[type="range"]'), null, { what: 'reader settings' });
  await page.evaluate((c) => {
    const i = document.querySelector('#readerDim input[type="range"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, String(c * 5 % 40));
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }, c);
  await key('Escape'); await sleep(150);
  await key('1'); await active('singleView');
  if (!(await page.evaluate(() => document.body.classList.contains('study-mode')))) await key('b');
  await until(page, () => document.querySelectorAll('.bubble-box').length > 0, null, { what: 'the study overlay' });
  const box = await page.evaluate(() => { const r = document.querySelector('.bubble-box').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x - 3, box.y); await page.mouse.move(box.x, box.y); await sleep(300);
  await key('f');
  await until(page, () => !!document.querySelector('[data-reader-part="feedback"]'), null, { what: 'the feedback dialog' });
  await key('Escape'); await sleep(100);
  if (c % 2) {
    await key('i');
    await until(page, () => !!document.querySelector('[data-reader-part="properties"]'), null, { what: 'page properties' });
  } else {
    const at = await page.evaluate(() => { const r = document.getElementById('mainImg').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 20 }; });
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await until(page, () => !!document.querySelector('[data-reader-part="page-menu"]'), null, { what: 'the page menu' });
  }
}

// What is left after a stop: listeners on the window, the document, <html> and <body> (CDP), DOM nodes
// and JS listeners, what the instrument counts, and what the page holds.
// DOM nodes and JS listeners are the browser's counts of objects not yet collected, so one read also
// counts what the page's work in the background made a moment ago (the library's reads and the save
// of the place: each request and transaction has listeners until it is collected). On a busy machine
// a read 50 ms after a collection came to 81, 75, 69 or 67 listeners where the next read was the 63
// that stay, the nodes the same (traced with six copies of this file at once, a read every 80 ms,
// the library's open transactions beside it: none open at a high read). What stays is the least of
// several reads, each straight after a collection: garbage only ever adds to a read.
async function leftAfterStop(page, cdp) {
  let nodes = Infinity, jsEventListeners = Infinity;
  for (let i = 0; i < 6; i++) {
    await cdp.send('HeapProfiler.collectGarbage');
    const now = await cdp.send('Memory.getDOMCounters');
    nodes = Math.min(nodes, now.nodes);
    jsEventListeners = Math.min(jsEventListeners, now.jsEventListeners);
    await new Promise((r) => setTimeout(r, 50));
  }
  const listeners = {};
  for (const [name, expr] of [['window', 'window'], ['document', 'document'], ['html', 'document.documentElement'], ['body', 'document.body']]) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    listeners[name] = (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.length;
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
  }
  const inPage = await page.evaluate(() => ({ ...globalThis.__live(), headStyles: document.head.querySelectorAll('style').length,
    bodyChildren: [...document.body.children].map((e) => e.id || `${e.localName}.${e.className}`).join(' '),
    inDocument: document.getElementsByTagName('*').length,
    dialogs: document.querySelectorAll('dialog').length, menus: document.querySelectorAll('[data-reader-part], .page-status').length }));
  return { nodes, jsEventListeners, listeners, ...inPage };
}

// Started by the one page's route and stopped by leaving it, five times in one document: from Tasks (a page
// that keeps no pictures of its own) into the reader by a change of route, the reader used, and Back. Each
// start has a frame of its own, drawn by the route (until 2026-11-26 the reader's own page, its frame drawn
// again by the test before each start, as the route would).
test('started, used and stopped five times, the reader leaves nothing behind, and nothing of it runs after a stop', { skip: !chromePath() }, async (t) => {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('shiori-reader-nav', 'top'); localStorage.setItem('shiori-reader-pin', '1'); localStorage.setItem('shiori:readerMode', '"strip"'); });
  await page.evaluateOnNewDocument(instrument);
  const cdp = await page.createCDPSession();
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  await page.evaluate(() => { window.__stayed = true; });
  const rows = [];
  for (let c = 1; c <= 5; c++) {
    // In by a link, as the app's own are followed (a change of route).
    await page.evaluate((href) => { const a = Object.assign(document.createElement('a'), { href }); document.body.append(a); a.click(); a.remove(); }, `/reader?g=${GALLERY}&page=1`);
    await use(page, c);
    await page.goBack();
    await until(page, () => !document.querySelector('.reader-frame') && !!document.getElementById('tkList'), null, { what: 'Tasks again' });
    rows.push(await leftAfterStop(page, cdp));
  }
  assert.equal(await page.evaluate(() => window.__stayed), true, 'one document throughout');
  t.diagnostic(JSON.stringify(rows.map(({ nodes, jsEventListeners, listeners, inDocument }) => ({ nodes, inDocument, jsEventListeners, ...listeners }))));
  const [first] = rows, last = rows.at(-1);
  // React listens, once and for the document's life, to every kind of event on each element it draws
  // a portal into (143 listeners, all its own), and the one page's popups portal into <body>: from the
  // first part the reader asked the one page to draw on (its page menu, its dialogs) <body> has them,
  // the same number at every later stop.
  const portalled = rows.findIndex((row) => row.listeners.body > 0);
  if (portalled >= 0) for (const row of rows.slice(portalled)) assert.equal(row.listeners.body, rows[portalled].listeners.body, 'React\'s listeners on <body>, once');
  for (const row of rows) {
    assert.deepEqual({ ...row.listeners, body: portalled >= 0 && rows.indexOf(row) >= portalled ? 0 : row.listeners.body }, { ...first.listeners, body: 0 },
      'listeners on the window, the document, <html> and <body> as after the first stop');
    assert.deepEqual({ objectUrls: row.objectUrls, workers: row.workers, dialogs: row.dialogs, menus: row.menus }, { objectUrls: 0, workers: 0, dialogs: 0, menus: 0 });
    assert.equal(row.observers, first.observers, 'resize observers watching');
    assert.equal(row.headStyles, first.headStyles, 'no <style> left in the head');
    assert.equal(row.bodyChildren, first.bodyChildren, 'nothing left in the body but the frame');
  }
  // Cycles 3 and 5 used the reader alike (page properties; 2 and 4 the page menu): the same is left.
  assert.ok(last.nodes <= rows[2].nodes, `DOM nodes grew from ${rows[2].nodes} to ${last.nodes}`);
  assert.ok(last.jsEventListeners <= rows[2].jsEventListeners, `JS listeners grew from ${rows[2].jsEventListeners} to ${last.jsEventListeners}`);
  // Five seconds with nothing to do, a resize in the middle: nothing of the reader runs, nothing is asked for.
  const asked = [];
  page.on('request', (r) => asked.push(r.url()));
  await page.evaluate(() => { globalThis.__after.on = true; });
  await new Promise((r) => setTimeout(r, 2500));
  await page.setViewport({ width: 1279, height: 899 });
  await new Promise((r) => setTimeout(r, 2500));
  await page.setViewport({ width: 1280, height: 900 });
  const fired = await page.evaluate(() => { globalThis.__after.on = false; return globalThis.__after.fired; });
  assert.deepEqual(fired.filter((f) => /\/reader|page-nav/.test(f)), [], 'frames, timers or observer callbacks of the reader');
  assert.deepEqual(asked, [], 'requests');
});

test('started, stopped and started again in one task (React\'s strict mode), it is one working reader and nothing of the first', { skip: !chromePath() }, async (t) => {
  const count = async (entry) => {
    const page = await reader(t, { readerMode: 'single', readerThumbsOpen: false }, { entry });
    const cdp = await page.createCDPSession();
    await page.keyboard.press('ArrowRight');
    await until(page, () => document.getElementById('pageCounter').textContent.trim().startsWith('2'), null, { what: 'page 2' });
    await page.keyboard.press('g');
    await until(page, () => document.querySelectorAll('#thumbStrip .thumb-item img[src]').length > 0, null, { what: 'thumbnails' });
    const listeners = {};
    for (const [name, expr] of [['window', 'window'], ['document', 'document']]) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
      listeners[name] = (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.map((l) => l.type).sort().join(' ');
      await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
    }
    return { listeners, ...(await page.evaluate(() => ({
      owned: ['.auto-bar', '.speed-tip', 'head > style'].map((s) => document.querySelectorAll(s).length),
      body: [...document.body.children].map((e) => e.id || `${e.localName}.${e.className}`).join(' '),
      pageNav: document.querySelectorAll('#pageNav option').length,
      counter: document.getElementById('pageCounter').textContent.trim(),
    }))) };
  };
  const once = await count('keep');
  const strict = await count('strict');
  assert.deepEqual(strict, once, 'the reader started in strict mode\'s way is the reader started once');
});

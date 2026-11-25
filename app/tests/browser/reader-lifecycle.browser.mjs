// reader-lifecycle.browser.mjs — the reader's engine has a start and a stop (app/js/reader.js
// startReader), on its own page: what the stop puts back, and that it leaves nothing behind. The page's
// entry is answered with one that holds the engine (harness.mjs READER_ENTRIES).
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
  await page.evaluate(() => { localStorage.setItem('shiori-reader-nav', 'side'); globalThis.__reader = globalThis.__startReader(); });
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

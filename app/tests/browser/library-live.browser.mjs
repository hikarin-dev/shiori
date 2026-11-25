// library-next-live.browser.mjs — the library at /library-next under a library that changes, held to what
// 1.3's page (/library) gave driven alike: one gallery changed in place for each kind of change
// (favourite, title, tags, translated, source, its cover, becoming a series and back) with which cards
// and covers stay the same nodes and how many covers load again, a hovered card staying grown;
// galleries added and removed in another context; covers (the tier asked at each width, a resize into
// the next tier, the session's cache on a return with nothing asked again, a cover pushed from another
// context landing in one <img>); each preference changed in another tab; the helper there and then
// not; the translation server there and not (an address nothing answers too), and the tab shown again.
// What 1.3's page gave is each table's record (records/<this file>.<table>.json, records.mjs), 1.3's
// behaviour as measured on 2026-11-25, which a deliberate change of the library's behaviour edits in
// the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { startTranslator } from './stand-in-translator.mjs';
import { record, normalised } from './records.mjs';

const NEW = '/library-next';
const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser, tr;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const G = (i) => String(1790000004000 + i);

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  tr = await startTranslator();
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(seed, [...Array(40).keys()].map(G));
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); await tr?.close(); });

// 40 galleries of one wide page (so a cover is as wide as the tier asked for), each with a long title
// and many tags (a card grows when hovered); the two newest from a made-up source with a source id.
async function seed(ids) {
  const api = await import('/app/js/api.js');
  const png = async (hue) => { const c = new OffscreenCanvas(1200, 1700); const x = c.getContext('2d'); x.fillStyle = `hsl(${hue} 60% 50%)`; x.fillRect(0, 0, 1200, 1700); return c.convertToBlob({ type: 'image/png' }); };
  const tags = Array.from({ length: 16 }, (_, i) => ({ type: 'tag', name: `tag number ${i}` })).concat([{ type: 'category', name: 'manga' }]);
  for (const [i, gid] of ids.entries()) {
    await api.meta.put({ galleryId: gid, title: { english: `Gallery ${i} with a long title that runs over several lines of its card, more than two`, japanese: '', pretty: '' }, tags,
      numPages: 1, ...(i >= 38 ? { source: 'a.example', sourceId: String(500 + i) } : {}) });
    await api.pages.put(gid, 1, await png(i * 9));
  }
}

async function open(path, { size = { width: 1280, height: 900 }, storage = {}, allow = [] } = {}) {
  const page = await openPage(browser, origin, { allow });
  await page.setViewport(size);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate((storage) => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('shiori:lib') || k === 'shiori:readerSkipOverview' || k === 'shiori:seriesView' || k === 'shiori-ext-status' || k === 'shiori:translateSettings') localStorage.removeItem(k);
    sessionStorage.removeItem('shiori-covers');
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  }, storage);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await covered(page);
  return page;
}
// Every card's cover in.
const covered = (page, n = 30) => until(page, (n) => document.querySelectorAll('#grid > .card').length === n
  && [...document.querySelectorAll('#grid > .card img.card-thumb')].every((img) => img.getAttribute('src') && img.complete && img.naturalWidth > 0), n, { what: 'the covers' });

// Marks every card and cover, and counts from here on each cover's loads, by gallery.
const mark = (page) => page.evaluate(() => {
  window.__loads = {};
  for (const el of document.querySelectorAll('#grid > .card, #grid > .card img.card-thumb')) el.__kept = true;
  if (!window.__counting) {
    window.__counting = true;
    document.addEventListener('load', (e) => { const img = e.target; if (img.matches?.('img.card-thumb')) { const gid = img.closest('.card').dataset.galleryId; window.__loads[gid] = (window.__loads[gid] || 0) + 1; } }, true);
  }
});
const kept = (page) => page.evaluate(() => ({
  ids: [...document.querySelectorAll('#grid > .card')].map((c) => c.dataset.galleryId),
  newCards: [...document.querySelectorAll('#grid > .card')].filter((c) => !c.__kept).map((c) => c.dataset.galleryId),
  newCovers: [...document.querySelectorAll('#grid > .card img.card-thumb')].filter((i) => !i.__kept).map((i) => i.closest('.card').dataset.galleryId),
  loads: window.__loads,
}));
const card = (gid) => `#grid > .card[data-gallery-id="${gid}"]`;
const inPage = (page, fn, arg) => page.evaluate(fn, arg);

// Each change made in the page itself, and what to wait for on the card.
const CHANGES = [
  ['favourite', (gid) => import('/app/js/api.js').then((api) => api.personal.favorite(gid, true)), (gid) => document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-fav`)?.matches('.on, [aria-pressed="true"]')],
  ['title', (gid) => import('/app/js/store.js').then((s) => s.mutate(gid, { title: { english: 'Renamed', japanese: '', pretty: '' } })), (gid) => document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-title`)?.textContent === 'Renamed'],
  ['tags', (gid) => import('/app/js/store.js').then((s) => s.mutate(gid, { tags: [{ type: 'tag', name: 'only one' }, { type: 'artist', name: 'someone' }] })),
    (gid) => [...document.querySelectorAll(`#grid > .card[data-gallery-id="${gid}"] .card-tag`)].some((t) => t.textContent === 'someone')],
  ['translated', (gid) => import('/app/js/store.js').then((s) => s.mutate(gid, { translated: true })), (gid) => document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-btn-translate`)?.classList.contains('done')],
  ['source', (gid) => import('/app/js/store.js').then((s) => s.mutate(gid, { source: 'b.example', sourceId: '77', sourceUrl: 'https://b.example/g/77' })),
    (gid) => document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-id`)?.textContent === '77'],
  ['cover', async (gid) => {
    const api = await import('/app/js/api.js');
    const c = new OffscreenCanvas(1200, 1700); c.getContext('2d').fillRect(0, 0, 1200, 1700);
    await api.pages.put(gid, 1, await c.convertToBlob({ type: 'image/png' }));
    (await import('/app/js/platform.js')).control.send({ type: 'COVER_INVALIDATED', galleryId: gid });
  }, (gid) => (window.__loads[gid] || 0) >= 1],
  ['series', (gid) => import('/app/js/api.js').then((api) => api.series.write(gid, [{ id: gid, title: '', number: 1 }, { id: String(Number(gid) - 1), title: '', number: 2 }],
    { seriesTitle: { english: 'Made a series', japanese: '', pretty: '' } })), (gid) => !!document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-series-badge`)],
  ['series undone', (gid) => import('/app/js/api.js').then((api) => api.series.remove(gid, String(Number(gid) - 1))), (gid) => !document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-series-badge`)],
];

test('one gallery changed in place, for each kind of change: its card alone, the same nodes, its cover not loaded again (but for a new one), a hovered card still grown', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  // (The galleries from the eleventh newest on: when 1.3's page was driven beside this one, each took
  // its own, so neither's changes reached the other's.)
  {
    const [path, first] = [NEW, 10];
    const page = await open(path);
    const results = [];
    for (const [i, [kind, change, landed]] of CHANGES.entries()) {
      const gid = G(39 - first - (kind === 'series undone' ? 6 : i));
      // The card's position stays put on the first page (id order): hover it, so it is grown.
      await mark(page);
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), card(gid));
      await sleep(100);
      const box = await (await page.$(`${card(gid)} .card-thumb-wrap`)).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 40);
      await sleep(450);
      await inPage(page, change, gid);
      await until(page, landed, gid, { what: `${path}: the ${kind} change`, timeout: 5000 });
      await sleep(900);
      const after = await kept(page);
      // Still hovered and grown (its height follows its new title or tags: more than a card at rest).
      const still = await inPage(page, (sel) => { const c = document.querySelector(sel); const rest = [...document.querySelectorAll('#grid > .card')].find((x) => x !== c).getBoundingClientRect().height;
        return !!c && c.matches(':hover') && c.getBoundingClientRect().height > rest + 1; }, card(gid));
      results.push({ kind, newCards: after.newCards.length, newCovers: after.newCovers.length, loads: after.loads, still: kind.startsWith('series') ? null : still, cards: after.ids.length, ...(kind.startsWith('series') ? { chapterShown: after.ids.includes(String(Number(gid) - 1)), ownerShown: after.ids.includes(gid) } : {}) });
      await page.mouse.move(5, 5);
      await sleep(400);
    }
    const now = results.map((r) => ({ ...r, loads: Object.values(r.loads).reduce((a, b) => a + b, 0) }));
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'in-place');
    for (const r of now) {
      if (!r.kind.startsWith('series')) {
        assert.deepEqual([r.newCards, r.newCovers, r.still], [0, 0, true], `${r.kind}: in place, hovered and grown`);
        assert.equal(r.loads, r.kind === 'cover' ? 1 : 0, `${r.kind}: covers loaded again`);
      }
    }
    // A gallery becoming a series and back: 1.3 made its card again (a new node, its cover loaded again
    // under the series' role, the same picture); the new page changes it in place (rule 7), the same
    // picture left as it was. What shows is the same.
    const series = (r) => (r.kind.startsWith('series') ? { ...r, newCards: 0, newCovers: 0, loads: 0 } : r);
    for (const r of now.filter((r) => r.kind.startsWith('series'))) assert.deepEqual([r.newCards, r.newCovers, r.loads], [0, 0, 0], `${r.kind}: in place`);
    assert.deepEqual(now, was.map(series));
  }
});

test('galleries added and removed in another context: the page follows, as 1.3\'s', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const path = NEW;
    const page = await open(path);
    // The total as it stands before anything is added (once it has been read: a figure, not "—").
    const before = await until(page, () => { const said = document.getElementById('hTotalGalleries').textContent; return /\d/.test(said) && said; }, null, { what: `${path}: the totals` });
    const other = await openPage(browser, origin);
    await other.goto(`${origin}/tasks`, { waitUntil: 'load' });
    const add = await other.evaluate(async () => {
      const api = await import('/app/js/api.js');
      const c = new OffscreenCanvas(1200, 1700); c.getContext('2d').fillRect(0, 0, 1200, 1700);
      const gid = String(1790000004900 + Math.floor(Math.random() * 90));
      await api.meta.put({ galleryId: gid, title: { english: 'Added elsewhere', japanese: '', pretty: '' }, tags: [], numPages: 1 });
      await api.pages.put(gid, 1, await c.convertToBlob({ type: 'image/png' }));
      return gid;
    });
    await page.bringToFront();
    await until(page, (gid) => document.querySelector('#grid > .card')?.dataset.galleryId === gid, add, { what: `${path}: the added gallery first` });
    await covered(page);
    // The totals are read again 800 ms after the library's last word of a change, and words may still
    // be coming (the new gallery's cover): waited for until they have changed, not for a fixed while
    // (under the whole suite's load 1.2 s was once too short for the one page, once for the other).
    await until(page, (was) => document.getElementById('hTotalGalleries').textContent !== was, before, { what: `${path}: the totals after the gallery was added` });
    const added = await page.evaluate(() => [document.querySelectorAll('#grid > .card').length, document.getElementById('hTotalGalleries').textContent]);
    await other.evaluate(async (gid) => (await import('/app/js/store.js')).remove(gid), add);
    await page.bringToFront();
    await until(page, (gid) => !document.querySelector(`#grid > .card[data-gallery-id="${gid}"]`) && document.querySelectorAll('#grid > .card').length === 30, add, { what: `${path}: removed` });
    await until(page, (was) => document.getElementById('hTotalGalleries').textContent === was, before, { what: `${path}: the totals after the gallery was removed` });
    const now = { added, removed: await page.evaluate(() => [document.querySelectorAll('#grid > .card').length, document.getElementById('hTotalGalleries').textContent]) };
    await other.close();
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'added');
    assert.deepEqual(now, was);
  }
});

test('covers: the tier asked at each width, the next tier after a resize, the session\'s on a return with nothing asked, one pushed lands in one <img>', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const widths = () => [...new Set([...document.querySelectorAll('#grid > .card img.card-thumb')].map((i) => i.naturalWidth))];
  {
    const path = NEW;
    const r = {};
    const page = await open(path, { size: { width: 1280, height: 900 } });
    r.at1280 = await page.evaluate(widths);
    await mark(page);
    await page.setViewport({ width: 1600, height: 900 });
    await until(page, () => [...document.querySelectorAll('#grid > .card img.card-thumb')].every((i) => i.naturalWidth === 384), null, { what: `${path}: the next tier` });
    r.resized = { ...(await kept(page)), loads: undefined, ids: undefined };
    await page.setViewport({ width: 1000, height: 900 });
    await sleep(800);
    r.shrunk = await page.evaluate(widths);
    // To Settings and back: the covers are there as the cards are drawn.
    await sleep(1000);   // the session's cache written
    await page.click('#settingsBtn');
    await until(page, () => location.pathname.endsWith('settings'), null, { what: 'Settings' });
    await page.evaluateOnNewDocument(() => {
      window.__bare = [];
      new MutationObserver((records) => { for (const rec of records) for (const n of rec.addedNodes) if (n.nodeType === 1) for (const img of (n.matches?.('img.card-thumb') ? [n] : n.querySelectorAll?.('img.card-thumb') || [])) if (!img.getAttribute('src')) window.__bare.push(img.closest('.card')?.dataset.galleryId); })
        .observe(document, { childList: true, subtree: true });
    });
    await page.evaluate(() => history.back());
    await until(page, (path) => location.pathname === path, path, { what: 'back' });
    await covered(page);
    r.returned = await page.evaluate(() => ({ bare: (window.__bare || []).length, widths: [...new Set([...document.querySelectorAll('#grid > .card img.card-thumb')].map((i) => i.naturalWidth))] }));
    // A cover pushed from another context: into its card's <img> alone.
    await mark(page);
    const gid = await page.evaluate(() => document.querySelectorAll('#grid > .card')[3].dataset.galleryId);
    const other = await openPage(browser, origin);
    await other.goto(`${origin}/tasks`, { waitUntil: 'load' });
    await other.evaluate(async (gid) => {
      const c = new OffscreenCanvas(384, 544); c.getContext('2d').fillStyle = '#0f0'; c.getContext('2d').fillRect(0, 0, 384, 544);
      const url = await new Promise((r) => { const fr = new FileReader(); c.convertToBlob({ type: 'image/png' }).then((b) => { fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); });
      (await import('/app/js/platform.js')).control.send({ type: 'COVER_READY', page: 'library', galleryId: gid, preferSeries: false, coverDataUrl: url });
    }, gid);
    await other.close();
    await page.bringToFront();
    await until(page, (gid) => document.querySelector(`#grid > .card[data-gallery-id="${gid}"] img.card-thumb`).src.startsWith('data:image/png'), gid, { what: 'the pushed cover' });
    await sleep(500);
    const pushed = await kept(page);
    r.pushed = { newCards: pushed.newCards, newCovers: pushed.newCovers, loads: pushed.loads[gid], others: Object.keys(pushed.loads).filter((k) => k !== gid) };
    const now = normalised(r);
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'covers');
    assert.deepEqual(was.at1280, [256]);
    assert.deepEqual(now, was);
  }
});

test('each preference changed in another tab is followed with no reload', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(NEW);
  await page.evaluate(() => { window.__still = true; });
  const other = await openPage(browser, origin);
  await other.goto(`${origin}/tasks`, { waitUntil: 'load' });
  const set = async (key, value) => { await other.evaluate(([k, v]) => localStorage.setItem(`shiori:${k}`, JSON.stringify(v)), [key, value]); await page.bringToFront(); await sleep(500); };
  const modes = () => page.evaluate(() => document.getElementById('grid').dataset.cardModes.replace('translator-offline', '').trim());
  await set('libQuickActionsMode', 'always');
  assert.equal(await modes(), '');
  await set('libQuickActionsMode', 'hidden');
  assert.equal(await modes(), 'quick-hidden');
  await set('libShowCategoryTag', false);
  assert.equal(await modes(), 'quick-hidden hide-category');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#grid .card-tag.category')).display), 'none');
  await set('libShowNavStats', false);
  assert.equal(await page.evaluate(() => !!document.getElementById('hTotalGalleries')), false, 'the totals gone');
  await set('readerSkipOverview', true);
  assert.match(await page.evaluate(() => document.querySelector('#grid .card-thumb-wrap').getAttribute('href')), /^reader\?g=/);
  await set('libHideAppLangFlag', false);
  await set('libMergeSeries', false);
  await set('seriesView', 'volumes');
  assert.equal(await page.evaluate(() => window.__still && location.pathname), NEW, 'no reload');
  // What it settled on is what 1.3's page showed when opened with the same preferences (its modes were
  // classes of the body: 'hide-card-category quick-actions-hidden').
  const now = normalised(await page.evaluate(() => ({ modes: document.getElementById('grid').dataset.cardModes, totals: !!document.getElementById('hTotalGalleries') && getComputedStyle(document.getElementById('hTotalGalleries')).display !== 'none',
    hrefs: [...document.querySelectorAll('#grid .card-thumb-wrap')].map((a) => a.href), ids: [...document.querySelectorAll('#grid > .card')].map((c) => c.dataset.galleryId) })), { site: origin });
  const was = record(FILE, 'prefs');
  assert.equal(was.modes, 'hide-card-category quick-actions-hidden');
  assert.deepEqual({ ...now, modes: undefined }, { ...was, modes: undefined });
  for (const key of ['libQuickActionsMode', 'libShowCategoryTag', 'libShowNavStats', 'readerSkipOverview', 'libHideAppLangFlag', 'libMergeSeries', 'seriesView']) await other.evaluate((k) => localStorage.removeItem(`shiori:${k}`), key);
  await other.close();
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('the helper there and then not; the translation server there, gone, and back as the tab is shown again; an address nothing answers', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const SITES = { 'a.example': { name: 'Site One', canDownload: true, galleryUrl: 'https://a.example/g/{id}' } };
  const dl = (gid) => (gid ? document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-btn-dl`).getAttribute('data-tip') : null);
  {
    const path = NEW;
    const r = {};
    // The helper seen last time: downloads offered until a probe past the grace window finds none.
    const page = await open(path, { storage: { 'shiori-ext-status': JSON.stringify({ available: true, sites: SITES }), 'shiori:translateSettings': JSON.stringify({ serverUrl: tr.origin }) }, allow: [tr.origin] });
    const gid = G(39);
    r.first = await page.evaluate(dl, gid);
    await until(page, (gid) => !/^Download/.test(document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-btn-dl`).getAttribute('data-tip')), gid, { what: `${path}: the helper gone`, timeout: 12000 });
    r.after = await page.evaluate(dl, gid);
    const shown = () => page.evaluate(() => getComputedStyle(document.querySelector('#grid > .card .card-btn-translate')).display !== 'none');
    await until(page, () => getComputedStyle(document.querySelector('#grid > .card .card-btn-translate')).display !== 'none', null, { what: `${path}: the server answering` });
    tr.state.online = false;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await until(page, () => getComputedStyle(document.querySelector('#grid > .card .card-btn-translate')).display === 'none', null, { what: `${path}: the server gone` });
    r.gone = await shown();
    tr.state.online = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await until(page, () => getComputedStyle(document.querySelector('#grid > .card .card-btn-translate')).display !== 'none', null, { what: `${path}: back as the tab is shown` });
    r.back = await shown();
    await page.close();
    // An address nothing answers: never shown.
    const none = await open(path, { storage: { 'shiori:translateSettings': JSON.stringify({ serverUrl: 'http://127.0.0.1:9' }) } });
    await sleep(1500);
    r.nothing = await none.evaluate(() => getComputedStyle(document.querySelector('#grid > .card .card-btn-translate')).display !== 'none');
    await none.close();
    const now = r;
    const was = record(FILE, 'runners');
    assert.match(was.first, /^Download/);
    assert.deepEqual(now, was);
  }
});

test('a change made in another context shows on its card within two frames of its word; 200 words about one gallery in a second read it a handful of times', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(NEW);
  const gid = await page.evaluate(() => document.querySelectorAll('#grid > .card')[5].dataset.galleryId);
  // In the page: a frame count; the frame each word about the gallery came in; the frame its card's
  // title changed in; and every read of the gallery.
  await page.evaluate(async (gid) => {
    const api = await import('/app/js/api.js');
    window.__frame = 0;
    const tick = () => { window.__frame++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__words = [];
    api.events.watch((id) => { if (String(id) === gid) window.__words.push(window.__frame); });
    window.__drawn = [];
    const title = document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-title`);
    new MutationObserver(() => window.__drawn.push([window.__frame, title.textContent])).observe(title, { childList: true, characterData: true, subtree: true });
    window.__reads = 0;
    const byIds = api.galleries.byIds;
    api.galleries.byIds = (ids, ...rest) => { if (ids.map(String).includes(gid)) window.__reads++; return byIds(ids, ...rest); };
  }, gid);
  const other = await openPage(browser, origin);
  await other.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await other.evaluate(async (gid) => (await import('/app/js/store.js')).mutate(gid, { title: { english: 'Changed elsewhere', japanese: '', pretty: '' } }), gid);
  await page.bringToFront();
  await until(page, () => window.__drawn.some(([, text]) => text === 'Changed elsewhere'), null, { what: 'the new title' });
  const { words, drawn } = await page.evaluate(() => ({ words: window.__words, drawn: window.__drawn.find(([, text]) => text === 'Changed elsewhere')[0] }));
  assert.ok(drawn - words[0] <= 2, `drawn ${drawn - words[0]} frames after its word`);
  // 200 words about it in a second, as the change feed says them (a writer's own feed says one every
  // 250 ms at most: these are said by hand, as many writers would), the last after it was made a
  // favourite.
  await sleep(1000);
  await page.evaluate(() => { window.__reads = 0; window.__words = []; });
  await other.evaluate(async (gid) => {
    const platform = await import('/app/js/platform.js');
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      if (i === 199) await (await import('/app/js/api.js')).personal.favorite(gid, true);
      platform.feed.publish({ gid, context: 'by-hand', n: i + 1, at: Date.now() });
      const due = start + (i + 1) * 5;
      if (performance.now() < due) await new Promise((r) => setTimeout(r, due - performance.now()));
    }
  }, gid);
  await page.bringToFront();
  await sleep(1500);
  const { reads, heard } = await page.evaluate(() => ({ reads: window.__reads, heard: window.__words.length }));
  assert.ok(heard >= 200, `${heard} words heard`);
  assert.ok(reads >= 1 && reads <= 5, `${reads} reads for ${heard} words`);
  // It ends on what the library holds.
  await until(page, (gid) => document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-fav`).getAttribute('aria-pressed') === 'true', gid, { what: 'the favourite as stored' });
  await other.close();
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('the page\'s own edit (the heart) shows in the frame of the press, before the library answers', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(NEW);
  const gid = await page.evaluate(() => document.querySelectorAll('#grid > .card')[7].dataset.galleryId);
  const sel = `${card(gid)} .card-fav`;
  await page.evaluate((sel) => {
    window.__frame = 0;
    const tick = () => { window.__frame++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    document.addEventListener('click', () => { window.__pressed = window.__frame; }, { capture: true });
    const fav = document.querySelector(sel);
    new MutationObserver(() => { if (fav.getAttribute('aria-pressed') === 'true' && window.__drawn == null) window.__drawn = window.__frame; }).observe(fav, { attributes: true });
  }, sel);
  await page.hover(card(gid));
  await page.click(sel);
  await until(page, () => window.__drawn != null, null, { what: 'the heart drawn' });
  const { pressed, drawn } = await page.evaluate(() => ({ pressed: window.__pressed, drawn: window.__drawn }));
  assert.equal(drawn, pressed, 'drawn in the frame of the press');
  await until(page, async (gid) => (await (await import('/app/js/api.js')).galleries.byIds([gid]))[0]?.favorite === true, gid, { what: 'the library holding it' });
  await sleep(600);
  assert.equal(await page.evaluate((sel) => document.querySelector(sel).getAttribute('aria-pressed'), sel), 'true');
  assert.deepEqual(page.problems, []);
  await page.close();
});

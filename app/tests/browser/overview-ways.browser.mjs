// overview-ways.browser.mjs — going between the library and the overview, the app's commonest path, held
// to what it was while the overview was 1.3's page (a document of its own, loaded from the library and
// left by Back; since the overview's switch, 2026-11-25, a change of route in the one page): Back from
// the overview lands on the library as it was (its page, its search, its sort, its scroll; the same
// document), every cover there in its card's first frame and none seen unfitted, Forward goes to the
// overview again, and the overview then reloaded draws as before; the overview's own scroll is kept on
// Back from the reader; an edit made on the overview (the series' title, its order, a chapter deleted)
// shows on the library's card on Back, now with no reload; a download's job begun on a card is drawn on the
// overview's row, and one going on there on the card on Back. What it was is the record
// (records/<this file>.<table>.json, records.mjs), measured on 2026-11-25 with 1.3's overview, three
// runs the same; a deliberate change of either page's behaviour edits it in the same commit. And the
// reader opened from the overview, held to what 1.3's reader page did (the section at the end, its
// records measured on 2026-11-26).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { record } from './records.mjs';
import { standInHelper, HELPER_STATUS } from './stand-in-helper.mjs';
import { librarySettled } from './library-drive.mjs';
import { sleep } from './overview-drive.mjs';

const FILE = basename(fileURLToPath(import.meta.url));
const OVERVIEW = '/overview';
const BASE = 1795200000000;
// The library: 70 galleries of one to three pages (every third one's cover landscape), a series of three
// chapters (S, S2, S3) and one of sixty (L and L2…L60).
const S = String(BASE + 100), S2 = String(BASE + 101), S3 = String(BASE + 102), L = String(BASE + 200);
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(seed, { base: BASE, S, S2, S3, L });
  await librarySettled(page);
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

async function seed({ base, S, S2, S3, L }) {
  const api = await import('/app/js/api.js');
  const picture = async (n, w, h) => {
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
    x.fillStyle = `hsl(${(n * 47) % 360} 60% 50%)`; x.fillRect(0, 0, w, h);
    return c.convertToBlob({ type: 'image/png' });
  };
  const gallery = async (id, title, pages, n, meta = {}) => {
    await api.meta.put({ galleryId: id, title: { english: title, japanese: '', pretty: '' }, tags: [], numPages: pages, ...meta });
    for (let p = 1; p <= pages; p++) await api.pages.put(id, p, await picture(n + p, n % 3 === 0 ? 600 : 400, n % 3 === 0 ? 400 : 570));
  };
  for (let n = 1; n <= 70; n++) await gallery(String(base + n), `Gallery ${n}`, 1 + (n % 3), n);
  for (const [i, id] of [S, S2, S3].entries()) await gallery(id, `Chapter ${i + 1}`, 2, 80 + i, { source: 'a.example', sourceId: String(950 + i) });
  await api.series.write(S, [S, S2, S3].map((id, i) => ({ id, title: '', number: i + 1 })), { seriesTitle: { english: 'A series', japanese: '', pretty: '' } });
  const long = Array.from({ length: 60 }, (_, i) => (i ? String(base + 200 + i) : L));
  for (const [i, id] of long.entries()) await gallery(id, `Long ${i + 1}`, 1, 90 + i);
  await api.series.write(L, long.map((id, i) => ({ id, title: '', number: i + 1 })), { seriesTitle: { english: 'Sixty', japanese: '', pretty: '' } });
  await (await import('/app/js/migrations.js')).runMigrations();
}

// In every document of the page, from its start: each frame, for every card, whether its cover was
// there in the card's first frame and how many frames it was seen unfitted (a landscape cover not
// letterboxed with its glow, a portrait one letterboxed). Started again when the page is shown again
// (Back: a route change, or a document the browser kept).
function watchCovers() {
  const W = (window.__covers = { first: {}, unfitted: {} });
  const again = () => { W.first = {}; W.unfitted = {}; };
  addEventListener('popstate', again);
  addEventListener('pageshow', (e) => { if (e.persisted) again(); });
  const frame = () => {
    for (const img of document.querySelectorAll('#grid > .card img.card-thumb')) {
      const id = img.closest('.card').dataset.galleryId;
      if (!(id in W.first)) W.first[id] = !!img.getAttribute('src') && img.complete && img.naturalWidth > 0;
      if (!img.getAttribute('src') || !img.complete || !img.naturalWidth || getComputedStyle(img).visibility === 'hidden') continue;
      const landscape = img.naturalWidth >= img.naturalHeight;
      const glow = img.parentElement.querySelector('img.card-thumb-glow');
      const fitted = img.classList.contains('landscape') === landscape && (landscape ? !!glow && glow.complete && glow.naturalWidth > 0 : !glow);
      if (!fitted) W.unfitted[id] = (W.unfitted[id] ?? 0) + 1;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function open(path, { viewport = { width: 1280, height: 900 } } = {}) {
  const page = await openPage(browser, origin);
  await standInHelper(page);
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument(watchCovers);
  await page.evaluateOnNewDocument((stored) => { for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v); }, HELPER_STATUS);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  return page;
}

// Until the library's stored sizes have been still for 2 s.
const sizesStill = (page) => until(page, async () => {
  const { totalSize } = await (await import('/app/js/api.js')).galleries.stats();
  const now = performance.now();
  if (totalSize !== window.__size) { window.__size = totalSize; window.__sizeSince = now; return false; }
  return now - window.__sizeSince >= 2000;
}, null, { what: 'the stored sizes still', timeout: 30000 });
// The library once it has drawn what it will: the cards, the totals, every cover.
const librarySettles = (page) => until(page, () => {
  const cards = [...document.querySelectorAll('#grid > .card')];
  const waiting = cards.filter((c) => { const i = c.querySelector('img.card-thumb'); return !(i?.getAttribute('src') && i.complete); }).map((c) => c.dataset.galleryId);
  window.__why = `${location.pathname}: ${cards.length} cards, totals ${document.getElementById('hTotalGalleries')?.textContent}, covers to come ${waiting}`;
  return /^\/(library)?$/.test(location.pathname) && cards.length > 0 && document.getElementById('hTotalGalleries')?.textContent !== '—' && !waiting.length;
}, null, { what: 'the library drawn' }).catch(async (err) => { throw new Error(`${err.message}: ${await page.evaluate(() => window.__why)}`); });
// The library as it shows: its address, its cards, its search's words, its scroll.
const library = (page) => page.evaluate(() => ({
  address: location.pathname + location.search, cards: [...document.querySelectorAll('#grid > .card')].map((c) => c.dataset.galleryId),
  search: document.getElementById('searchBox')?.textContent ?? null, scroll: Math.round(scrollY), kept: window.__mark === 'kept',
}));
// What the cover watch saw since the page was shown again.
const covers = (page) => page.evaluate(() => {
  const ids = [...document.querySelectorAll('#grid > .card')].map((c) => c.dataset.galleryId);
  return { missing: ids.filter((id) => !window.__covers.first[id]).length, unfitted: ids.filter((id) => window.__covers.unfitted[id]).length };
});
const overviewSettles = (page, g) => until(page, (g) => new URLSearchParams(location.search).get('g') === g && !!document.querySelector('#ovContent .ov-hero')
  && !!document.querySelector('#seriesCover img')?.complete, g, { what: 'the overview drawn' });
const overview = (page) => page.evaluate(() => ({
  address: location.pathname + location.search, title: document.title, heading: document.querySelector('.series-title-input')?.value ?? null,
  rows: [...document.querySelectorAll('.ch-row')].map((r) => r.dataset.chapterId), scroll: Math.round(scrollY),
}));
// Whether the document is the one marked before (the browser kept it, or a change of route left it).
const kept = (page) => page.evaluate(() => window.__mark === 'kept');
// A link of the page followed as a press on it does (not scrolled into view first, as a pointer's press is).
const follow = (page, sel) => page.evaluate((sel) => document.querySelector(sel).click(), sel);

test('Back from the overview lands on the library as it was, its covers in their cards\' first frame; Forward, and a reload', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open('/?page=2&q=Gallery&sort=count');
  await librarySettles(page);
  await sleep(500);
  await page.evaluate(() => { scrollTo(0, 600); window.__mark = 'kept'; });
  await sleep(400);
  const before = await library(page);
  const g = before.cards[13];
  await follow(page, `#grid > .card[data-gallery-id="${g}"] .card-thumb-wrap`);
  await overviewSettles(page, g);
  const went = await overview(page);
  await page.goBack();
  await librarySettles(page);
  await sleep(600);
  const back = { ...(await library(page)), covers: await covers(page) };
  await page.goForward();
  await overviewSettles(page, g);
  const forward = await overview(page);
  await page.reload({ waitUntil: 'load' });
  await overviewSettles(page, g);
  const reloaded = await overview(page);
  const now = { before, went, back, forward, reloaded };
  const was = record(FILE, 'back-forward');
  assert.deepEqual(now, was);
  assert.deepEqual({ ...was.back, covers: null }, { ...was.before, covers: null }, 'the library as it was');
  assert.deepEqual(was.back.covers, { missing: 0, unfitted: 0 }, 'every cover in its card\'s first frame, none unfitted');
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('the overview\'s own scroll is kept on Back from the reader', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(`${OVERVIEW}?g=${L}`);
  await overviewSettles(page, L);
  await until(page, () => document.querySelectorAll('.ch-row').length === 60, null, { what: 'sixty rows' });
  await sleep(500);
  await page.evaluate(() => { scrollTo(0, 1500); window.__mark = 'kept'; });
  await sleep(400);
  const before = await overview(page);
  // (Until the reader's switch, 2026-11-26, the reader was a load and Back the document the browser had
  // kept, which it sometimes let go under load: the round trip was made again then. Now a change of route.)
  await follow(page, '.ch-row:nth-child(30) .ch-title-open');
  await until(page, () => location.pathname === '/reader' && !!document.getElementById('topbar'), null, { what: 'the reader' });
  await page.goBack();
  await overviewSettles(page, L);
  await sleep(600);
  const back = { ...(await overview(page)), kept: await kept(page) };
  const now = { before, back };
  const was = record(FILE, 'reader-back');
  assert.deepEqual(now, was);
  const { kept: same, ...wasBack } = was.back;
  assert.deepEqual(wasBack, was.before, 'the overview as it was');
  assert.equal(same, true, 'the same document');
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('an edit made on the overview shows on the library\'s card on Back, with no reload', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open('/?q=Chapter');
  await librarySettles(page);
  await sizesStill(page);
  await page.evaluate(() => { window.__mark = 'kept'; });
  const cardOf = () => page.evaluate((S) => { const c = document.querySelector(`#grid > .card[data-gallery-id="${S}"]`); return c ? c.innerText.replace(/\s+/g, ' ').trim() : null; }, S);
  const before = await cardOf();
  await follow(page, `#grid > .card[data-gallery-id="${S}"] .card-thumb-wrap`);
  await overviewSettles(page, S);
  // The series' title, in edit mode; the second chapter moved down; the third deleted (Shift: no question).
  await page.click('#editToggle');
  await page.click('#seriesTitle');
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.type('Renamed series');
  await page.click('#editToggle');
  await until(page, async (S) => (await (await import('/app/js/api.js')).meta.get(S))?.seriesTitle?.english === 'Renamed series', S, { what: 'the title saved' });
  await page.hover(`.ch-row[data-chapter-id="${S2}"] .ch-main`);
  await page.click(`.ch-row[data-chapter-id="${S2}"] [data-down]`);
  await until(page, async ({ S, S3 }) => (await (await import('/app/js/api.js')).meta.get(S))?.chapters?.[1]?.id == S3, { S, S3 }, { what: 'the order saved' });
  await sleep(300);
  await page.hover(`.ch-row[data-chapter-id="${S2}"] .ch-main`);
  await page.keyboard.down('Shift');
  await page.click(`.ch-row[data-chapter-id="${S2}"] [data-remove]`);
  await page.keyboard.up('Shift');
  await until(page, async (S2) => !(await (await import('/app/js/api.js')).galleries.get(S2)), S2, { what: 'the chapter deleted' });
  await sleep(300);
  const edited = await overview(page);
  await page.goBack();
  await librarySettles(page);
  // What the card shows within 3 s of the library showing again.
  await until(page, (S) => /Renamed series/.test(document.querySelector(`#grid > .card[data-gallery-id="${S}"]`)?.innerText ?? ''), S, { what: 'the new title on the card', timeout: 3000 }).catch(() => {});
  // (Its size as the library has it once its stored sizes are still: a gallery deleted and the covers
  // made again are measured a moment after, read either side of it otherwise.)
  await sizesStill(page);
  await sleep(1000);
  const now = { before, edited, after: await cardOf(), kept: await page.evaluate(() => window.__mark === 'kept') };
  const was = record(FILE, 'edit-back');
  // The card as 1.3's overview left it. 1.3's library came back by a load: the browser let the document
  // it had kept go once the edit's word reached it (was.kept false); the one page's comes back with no
  // load, the same document.
  // (The size on the card, the library's stored size, counts the covers it keeps, which differ by the way
  // back: 1.3's library loaded again made its card's covers anew. Compared without it, the same way for both:
  // 29KB on 1.3's, 28.9KB here, the gallery's own pages the same.)
  const sizeless = (r) => ({ ...r, kept: null, before: r.before.replace(/ · [\d.]+[KMG]?B/, ''), after: r.after.replace(/ · [\d.]+[KMG]?B/, '') });
  assert.deepEqual(sizeless(now), sizeless(was));
  assert.match(was.after, /^2 chapters .*Renamed series/);
  assert.equal(now.kept, true, 'no reload');
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('a download begun on a card is drawn on the overview\'s row, and one going on there on the card on Back', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open('/?q=Gallery');
  t.after(async () => { await page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); }).catch(() => {}); await page.close(); });
  await librarySettles(page);
  await page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); });
  const g = await page.evaluate(() => document.querySelector('#grid > .card').dataset.galleryId);
  const label = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
  const publish = (job) => page.evaluate(async (job) => (await import('/app/js/platform.js')).jobs.publish(job), job);
  // Its download pressed, the helper's first word.
  await page.hover(`#grid > .card[data-gallery-id="${g}"]`);
  await sleep(200);
  await page.click(`#grid > .card[data-gallery-id="${g}"] .card-btn-dl`);
  await publish({ gid: g, kind: 'download', status: 'downloading', downloaded: 1_000_000, total: 4_000_000, pages: 2 });
  await until(page, (g) => /~/.test(document.querySelector(`#grid > .card[data-gallery-id="${g}"] .card-prog-label`)?.textContent ?? ''), g, { what: 'the card\'s job' });
  const card = await label(`#grid > .card[data-gallery-id="${g}"] .card-prog-label`);
  // A series: its overview draws jobs on rows. The first chapter's download.
  await page.evaluate((S) => { const a = document.createElement('a'); a.id = '__toOverview'; a.href = `overview?g=${S}`; a.textContent = 'go'; document.body.append(a); }, S);
  await publish({ gid: S, kind: 'download', status: 'downloading', downloaded: 2_000_000, total: 8_000_000, pages: 2 });
  await follow(page, '#__toOverview');
  await overviewSettles(page, S);
  await until(page, (S) => !!document.querySelector(`.ch-row[data-chapter-id="${S}"].working`), S, { what: 'the row\'s job' });
  await sleep(300);
  const row = await label(`.ch-row[data-chapter-id="${S}"] .ch-prog-label`);
  // A word more on the overview, then Back: the card of the first download, as it goes on.
  await publish({ gid: g, kind: 'download', status: 'downloading', downloaded: 3_000_000, total: 4_000_000, pages: 2 });
  await sleep(300);
  await page.goBack();
  await librarySettles(page);
  await until(page, (g) => /~/.test(document.querySelector(`#grid > .card[data-gallery-id="${g}"] .card-prog-label`)?.textContent ?? ''), g, { what: 'the card\'s job again' });
  await sleep(300);
  const now = { card, row, back: await label(`#grid > .card[data-gallery-id="${g}"] .card-prog-label`) };
  const was = record(FILE, 'jobs');
  assert.deepEqual(now, was);
  assert.deepEqual(page.problems, []);
});

// Where a job runs (its owner tag) names the page its tab shows as the job is published (platform.js
// runner.page, read from the address when asked; 5e). Library and overview are the two pages that start
// jobs, and since the overview's switch a tab moves between them with no load: a job published by a tab
// opened on the library and moved to an overview says it runs in a tab on the overview, and back on the
// library, on the library; the other tab, Tasks, draws each word's tag so. (The one page alone: 1.3's
// overview was a load, a tab of its own.)
test('a job published by a tab moved between the library and the overview names the page it shows', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open('/?q=Chapter');
  const tasks = await openPage(browser, origin);
  t.after(async () => {
    await page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); }).catch(() => {});
    await tasks.close(); await page.close();
  });
  await librarySettles(page);
  await tasks.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.bringToFront();
  await page.evaluate(() => { window.__stayed = true; });
  const tagOn = (g) => until(tasks, (key) => { const el = document.querySelector(`.tk-row[data-key="${key}"] .run-tag`); return el && !el.hidden && el.textContent; }, `${g}:download`, { what: 'the row\'s tag' });
  const publish = (word) => page.evaluate(async (word) => (await import('/app/js/platform.js')).jobs.publish(word), word);
  const g = S3;
  const seen = [];
  await publish({ gid: g, kind: 'download', status: 'progress', done: 1, total: 4 });
  seen.push([await page.evaluate(async () => (await import('/app/js/platform.js')).runner.page), await tagOn(g)]);
  await follow(page, `#grid > .card[data-gallery-id="${S}"] .card-thumb-wrap`);
  await overviewSettles(page, S);
  await publish({ gid: g, kind: 'download', status: 'progress', done: 2, total: 4 });
  await until(tasks, (key) => document.querySelector(`.tk-row[data-key="${key}"] .run-tag`)?.textContent === 'Tab · Overview', `${g}:download`, { what: 'the tag on the overview' }).catch(() => {});
  seen.push([await page.evaluate(async () => (await import('/app/js/platform.js')).runner.page), await tagOn(g)]);
  await page.goBack();
  await librarySettles(page);
  await publish({ gid: g, kind: 'download', status: 'progress', done: 3, total: 4 });
  await until(tasks, (key) => document.querySelector(`.tk-row[data-key="${key}"] .run-tag`)?.textContent === 'Tab · Library', `${g}:download`, { what: 'the tag on the library' }).catch(() => {});
  seen.push([await page.evaluate(async () => (await import('/app/js/platform.js')).runner.page), await tagOn(g)]);
  assert.deepEqual(seen, [['library', 'Tab · Library'], ['overview', 'Tab · Overview'], ['library', 'Tab · Library']]);
  assert.equal(await page.evaluate(() => window.__stayed), true, 'no load: changes of route');
  assert.deepEqual([page.problems, tasks.problems], [[], []]);
});

// Every way into the overview arrives at it: a library card's cover (above), a task's title and cover on
// Tasks, the address loaded (a bookmark, the desktop app's window: /overview?g=), and the reader's page menu
// (a page with a file of its own: a load; page-nav.browser holds it). From the one page's pages, a change of
// route; loaded, the one page drawing it from its first parse (the shiori-app meta saying "overview").
test('a task\'s title and cover on Tasks open the overview with no load; the address loaded opens it too', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open('/tasks');
  t.after(async () => {
    await page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); }).catch(() => {});
    await page.close();
  });
  await page.evaluate(async (g) => (await import('/app/js/platform.js')).jobs.publish({ gid: g, kind: 'download', status: 'progress', done: 1, total: 4 }), S3);
  const arrived = [];
  for (const sel of ['.tk-title', '.tk-thumb']) {
    await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
    await until(page, (g) => !!document.querySelector(`.tk-row[data-key="${g}:download"]`), S3, { what: 'the task' });
    await page.evaluate(() => { window.__stayed = true; });
    await follow(page, `.tk-row[data-key="${S3}:download"] ${sel}`);
    await overviewSettles(page, S3);
    arrived.push([sel, await page.evaluate(() => [location.pathname, window.__stayed === true, document.querySelector('meta[name="shiori-app"]')?.content])]);
  }
  await page.goto(`${origin}/overview?g=${S3}`, { waitUntil: 'domcontentloaded' });
  arrived.push(['loaded', await page.evaluate(() => [location.pathname, false, document.querySelector('meta[name="shiori-app"]')?.content])]);
  await overviewSettles(page, S3);
  assert.deepEqual(arrived, [['.tk-title', ['/overview', true, 'overview']], ['.tk-thumb', ['/overview', true, 'overview']], ['loaded', ['/overview', false, 'overview']]]);
  assert.deepEqual(page.problems, []);
});

// A gallery's own overview: its page grid's tiles are listed from storage a moment after the page is
// drawn. Coming Back, the grid stands at the height it had until they are in, so the page is as tall as
// it was left in its first frame and the browser's return to the scroll lands (before: the page a grid
// short, the scroll stopped short of where it was, then pushed on as the tiles came:
// plans/frontend-react-probes/8c/back-scroll.mjs). The gallery is made here, so the library the tests
// above are held to is theirs as it was.
test('Back to a gallery\'s overview finds it as tall as it was left, its page grid\'s place held: the scroll is kept in every frame', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const G = String(BASE + 300), PAGES = 24;
  const page = await open('/tasks', { viewport: { width: 1280, height: 420 } });
  t.after(() => page.close());
  await page.evaluate(async ({ gid, pages }) => {
    const api = await import('/app/js/api.js');
    const c = new OffscreenCanvas(400, 570), x = c.getContext('2d');
    await api.meta.put({ galleryId: gid, title: { english: 'Pages', japanese: '', pretty: '' }, tags: [], numPages: pages });
    for (let p = 1; p <= pages; p++) { x.fillStyle = `hsl(${p * 15} 60% 50%)`; x.fillRect(0, 0, 400, 570); await api.pages.put(gid, p, await c.convertToBlob({ type: 'image/png' })); }
  }, { gid: G, pages: PAGES });
  await page.goto(`${origin}${OVERVIEW}?g=${G}`, { waitUntil: 'load' });
  const drawn = async () => {
    await overviewSettles(page, G);
    await until(page, (n) => document.querySelectorAll('#ovPages > .ov-page').length === n, PAGES, { what: 'the grid\'s tiles' });
  };
  await drawn();
  await page.evaluate(() => { window.__mark = 'kept'; });
  // Away by a change of route (a link, as the app's own are followed), and Back: the scroll in each of
  // the forty frames from the Back on.
  const awayAndBack = async () => {
    await page.evaluate(() => { const a = Object.assign(document.createElement('a'), { href: '/tasks' }); document.body.append(a); a.click(); a.remove(); });
    await until(page, () => !document.getElementById('ovContent') && !!document.getElementById('tkList'), null, { what: 'Tasks' });
    await sleep(200);
    const frames = await page.evaluate(() => new Promise((done) => {
      const seen = [];
      addEventListener('popstate', () => {
        const tick = () => { seen.push(Math.round(scrollY)); if (seen.length < 40) requestAnimationFrame(tick); else done(seen); };
        requestAnimationFrame(tick);
      }, { once: true });
      history.back();
    }));
    await drawn();
    await sleep(300);
    return { frames: [...new Set(frames)], after: await page.evaluate(() => ({ scroll: Math.round(scrollY), height: document.documentElement.scrollHeight, held: document.getElementById('ovPages').style.minHeight })) };
  };
  // Three places: one the page holds without its grid, one past that (a page a grid short stops short of
  // it, and the tiles coming in then push what is in view to the page's end), and the end.
  const { short, end } = await page.evaluate(() => {
    const height = document.documentElement.scrollHeight;
    return { short: height - document.getElementById('ovPages').offsetHeight - innerHeight, end: height - innerHeight };
  });
  assert.ok(short > 150 && end - short > 300, `the page without its grid scrolls ${short}px, with it ${end}px`);
  for (const to of [short - 100, short + 150, end]) {
    await page.evaluate((to) => scrollTo(0, to), to);
    await sleep(300);
    const before = await page.evaluate(() => ({ scroll: Math.round(scrollY), height: document.documentElement.scrollHeight }));
    assert.equal(before.scroll, Math.round(to));
    const back = await awayAndBack();
    assert.deepEqual(back, { frames: [before.scroll], after: { scroll: before.scroll, height: before.height, held: '' } }, `scrolled to ${to}: every frame at the scroll it was left at, the grid's height its own again`);
  }
  assert.equal(await kept(page), true, 'the same document throughout');
  // Another width meanwhile: the height it had is not this width's, and the grid takes none.
  await page.evaluate(() => { const a = Object.assign(document.createElement('a'), { href: '/tasks' }); document.body.append(a); a.click(); a.remove(); });
  await until(page, () => !document.getElementById('ovContent') && !!document.getElementById('tkList'), null, { what: 'Tasks' });
  await page.setViewport({ width: 900, height: 420 });
  const held = await page.evaluate(() => new Promise((done) => {
    addEventListener('popstate', () => done(document.getElementById('ovPages')?.style.minHeight ?? null), { once: true });   // drawn by now: the app heard first
    history.back();
  }));
  assert.equal(held, '', 'no height held at another width');
  await drawn();
  assert.deepEqual(page.problems, []);
});

// A series' overview: its hero's cover takes its box once decoded, and a landscape cover's box is shorter
// than the empty one. Drawn again with its cover still to come, the hero took its shape some frames after
// the page was drawn and moved everything under it (the series of sixty left at 1500 came back at 1337:
// plans/frontend-react-probes/8d/back-series.mjs). The covers an overview has shown are kept for the
// session, decoded (src/routes/overview/covers.ts `kept`, parts.tsx useDecoded): coming Back, the hero's
// cover and the rows' are in the page's first frame, as a document the browser kept had them.
test('Back to a series\' overview finds its covers in its first frame, the hero\'s in its shape: the scroll is kept in every frame', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(`${OVERVIEW}?g=${L}`);
  t.after(() => page.close());
  // What shows: the scroll, the hero's cover and its shape, the rows in view with no cover yet.
  const shows = () => {
    const hero = document.querySelector('#seriesCover img');
    const rows = [...document.querySelectorAll('.ch-row')].filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; });
    return `${Math.round(scrollY)} ${hero?.complete && hero.naturalWidth ? (hero.classList.contains('landscape') ? 'landscape' : 'portrait') : 'none'} ${rows.length ? rows.filter((r) => { const i = r.querySelector('.ch-thumb img'); return !(i?.complete && i.naturalWidth); }).length : 'no rows'}`;
  };
  await page.evaluate(`window.__shows = ${shows}`);   // the page's to call in each frame (one document throughout)
  const settled = async () => {
    await overviewSettles(page, L);
    await until(page, () => document.querySelectorAll('.ch-row').length === 60, null, { what: 'sixty rows' });
    await until(page, () => / 0$/.test(window.__shows()), null, { what: 'the covers of the rows in view' });
  };
  await settled();
  await page.evaluate(() => { scrollTo(0, 1500); window.__mark = 'kept'; });
  await settled();
  await sleep(300);
  const before = await page.evaluate(shows);
  assert.equal(before, '1500 landscape 0', 'left at 1500, its cover a landscape one, every row in view with its cover');
  for (const round of [1, 2]) {
    await page.evaluate(() => { const a = Object.assign(document.createElement('a'), { href: '/tasks' }); document.body.append(a); a.click(); a.remove(); });
    await until(page, () => !document.getElementById('ovContent') && !!document.getElementById('tkList'), null, { what: 'Tasks' });
    await sleep(200);
    const frames = await page.evaluate(() => new Promise((done) => {
      const seen = [];
      addEventListener('popstate', () => {
        const tick = () => { seen.push(window.__shows()); if (seen.length < 40) requestAnimationFrame(tick); else done(seen); };
        requestAnimationFrame(tick);
      }, { once: true });
      history.back();
    }));
    assert.deepEqual([...new Set(frames)], [before], `round ${round}: every one of forty frames as the page was left`);
    await settled();
    await sleep(300);
    assert.equal(await page.evaluate(shows), before, `round ${round}: and once everything is in`);
  }
  assert.equal(await kept(page), true, 'the same document throughout');
  assert.deepEqual(page.problems, []);
});

// ── The reader, from the overview ──
// Overview → reader → Back is the commonest path of reading. Until the reader's switch (2026-11-26) the
// reader was a page with a file of its own: a page tile, a row's title or Read loaded it, and Back brought
// the overview's document back from the browser's keeping; since, it is a change of route in the one
// page. What 1.3's reader page gave is the record (measured at the tree before the switch, three runs the
// same): the address, the page and the scroll at each step. Whether a step was a load is the one page's
// own (`kept`: it keeps its document throughout), asserted apart.

// In every document of the page, from its start: the page's scroll in each of the 40 frames from the
// moment it is shown again by Back or Forward (a change of route, a document the browser kept, or one
// loaded again by them).
function watchReturn() {
  const start = () => {
    const seen = (window.__returned = []);
    const tick = () => { seen.push(Math.round(scrollY)); if (seen.length < 40) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  };
  addEventListener('popstate', start);
  addEventListener('pageshow', (e) => { if (e.persisted) start(); });
  if (performance.getEntriesByType('navigation')[0]?.type === 'back_forward') start();
}
// A gallery of `pages` pages, made by the test that reads it (the library the tests above are held to
// stays theirs).
const pagesGallery = (page, gid, pages) => page.evaluate(async ({ gid, pages }) => {
  const api = await import('/app/js/api.js');
  const c = new OffscreenCanvas(400, 570), x = c.getContext('2d');
  await api.meta.put({ galleryId: gid, title: { english: 'Pages to read', japanese: '', pretty: '' }, tags: [], numPages: pages });
  for (let p = 1; p <= pages; p++) { x.fillStyle = `hsl(${p * 15} 60% 50%)`; x.fillRect(0, 0, 400, 570); await api.pages.put(gid, p, await c.convertToBlob({ type: 'image/png' })); }
}, { gid, pages });
const READER_SETTINGS = { 'shiori-reader-nav': 'top', 'shiori-reader-pin': '1', 'shiori:readerMode': '"single"', 'shiori:readerThumbsOpen': 'false' };
// The reader once it shows page `n`: its address, its counter, its title.
const readerAt = async (page, n) => {
  await until(page, (n) => !!document.getElementById('topbar') && document.getElementById('pageCounter').textContent.trim().startsWith(`${n} `)
    && document.getElementById('mainImg')?.naturalWidth > 0 && getComputedStyle(document.getElementById('loadingScreen')).display === 'none', n, { what: `the reader at page ${n}` });
  return page.evaluate(() => ({ address: location.pathname + location.search, counter: document.getElementById('pageCounter').textContent.replace(/\s+/g, ' ').trim(), title: document.title }));
};

test('a page tile opens the reader at its page; Back lands on the overview at its scroll in every frame; Forward finds the reader where it was left, and a reload draws it there', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const G = String(BASE + 301), PAGES = 24;
  const page = await open('/tasks', { viewport: { width: 1280, height: 420 } });
  t.after(() => page.close());
  await page.evaluateOnNewDocument(watchReturn);
  await page.evaluateOnNewDocument((stored) => { for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v); }, READER_SETTINGS);
  await pagesGallery(page, G, PAGES);
  await page.goto(`${origin}${OVERVIEW}?g=${G}`, { waitUntil: 'load' });
  const drawn = async () => {
    await overviewSettles(page, G);
    await until(page, (n) => document.querySelectorAll('#ovPages > .ov-page').length === n, PAGES, { what: 'the grid\'s tiles' });
  };
  await drawn();
  await page.evaluate(() => { scrollTo(0, 320); window.__mark = 'kept'; });
  await sleep(400);
  const before = await page.evaluate(() => ({ address: location.pathname + location.search, scroll: Math.round(scrollY) }));
  await follow(page, '#ovPages > .ov-page:nth-child(7)');
  const opened = await readerAt(page, 7);
  const openedKept = await kept(page);
  for (let i = 0; i < 2; i++) { await page.keyboard.press('ArrowRight'); await sleep(150); }
  await sleep(400);   // the address follows the page (at most every 100 ms)
  const turned = await readerAt(page, 9);
  await page.goBack();
  await drawn();
  await sleep(600);
  const back = await page.evaluate(() => ({ address: location.pathname + location.search, scroll: Math.round(scrollY),
    frames: window.__returned ? [...new Set(window.__returned)] : null }));
  const backKept = await kept(page);
  await page.goForward();
  const forward = await readerAt(page, 9);
  await page.reload({ waitUntil: 'load' });
  const reloaded = await readerAt(page, 9);
  const now = { before, opened, turned, back, forward, reloaded };
  const was = record(FILE, 'reader-tile');
  assert.deepEqual(now, was);
  assert.deepEqual(was.back, { address: was.before.address, scroll: was.before.scroll, frames: [was.before.scroll] }, 'the overview as it was left, in every frame');
  assert.deepEqual([openedKept, backKept], [true, true], 'into the reader and Back with no load: changes of route');
  assert.deepEqual(page.problems, []);
});

// A job begun in the reader (a page's translation, as its page menu starts one: its first word published by
// the reader's tab) is drawn on the overview's row on Back and on the library's card on Back again; its tag
// on Tasks names the page the tab showed as it was published (runner.page, read from the address each time
// it is asked for: a tab that came into the reader by a change of route says the reader).
test('a job begun in the reader is drawn on the overview\'s row and the library\'s card on Back; its tag names the reader', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  // A series of its own (the tests above edit and delete the seeded one's chapters).
  const R = String(BASE + 400), R2 = String(BASE + 401), R3 = String(BASE + 402);
  const page = await open('/tasks');
  const tasks = await openPage(browser, origin);
  const clear = (p) => p.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); });
  t.after(async () => { await clear(page).catch(() => {}); await tasks.close(); await page.close(); });
  await page.evaluateOnNewDocument((stored) => { for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v); }, READER_SETTINGS);
  await page.evaluate(async (ids) => {
    const api = await import('/app/js/api.js');
    const c = new OffscreenCanvas(400, 570), x = c.getContext('2d');
    for (const [i, id] of ids.entries()) {
      await api.meta.put({ galleryId: id, title: { english: `Reading ${i + 1}`, japanese: '', pretty: '' }, tags: [], numPages: 2, source: 'a.example', sourceId: String(970 + i) });
      for (let p = 1; p <= 2; p++) { x.fillStyle = `hsl(${i * 90 + p * 20} 60% 50%)`; x.fillRect(0, 0, 400, 570); await api.pages.put(id, p, await c.convertToBlob({ type: 'image/png' })); }
    }
    await api.series.write(ids[0], ids.map((id, i) => ({ id, title: '', number: i + 1 })), { seriesTitle: { english: 'A series to read', japanese: '', pretty: '' } });
    await (await import('/app/js/migrations.js')).runMigrations();
  }, [R, R2, R3]);
  await page.goto(`${origin}/?q=Reading`, { waitUntil: 'load' });
  await librarySettles(page);
  await clear(page);
  await tasks.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.bringToFront();
  await page.evaluate(() => { window.__mark = 'kept'; });
  const label = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
  const publish = (job) => page.evaluate(async (job) => (await import('/app/js/platform.js')).jobs.publish(job), job);
  const runnerPage = () => page.evaluate(async () => (await import('/app/js/platform.js')).runner.page);
  const tagOn = (key, text) => until(tasks, ({ key, text }) => { const el = document.querySelector(`.tk-row[data-key="${key}"] .run-tag`); return el && !el.hidden && el.textContent && (!text || el.textContent === text) ? el.textContent : 0; }, { key, text }, { what: `the row's tag${text ? ` (${text})` : ''}`, timeout: 5000 });
  await follow(page, `#grid > .card[data-gallery-id="${R}"] .card-thumb-wrap`);
  await overviewSettles(page, R);
  await follow(page, `.ch-row[data-chapter-id="${R2}"] .ch-title-open`);
  const reading = await readerAt(page, 1);
  await publish({ gid: R2, kind: 'translate', status: 'progress', pct: 40, labelKey: 'prog.translating' });
  const begun = { runner: await runnerPage(), tag: await tagOn(`${R2}:translate`) };
  await page.goBack();
  await overviewSettles(page, R);
  await until(page, (g) => !!document.querySelector(`.ch-row[data-chapter-id="${g}"].working`), R2, { what: 'the row\'s job' });
  await sleep(300);
  const row = await label(`.ch-row[data-chapter-id="${R2}"] .ch-prog-label`);
  // A word more, published by the tab now on the overview: its tag says so.
  await publish({ gid: R2, kind: 'translate', status: 'progress', pct: 60, labelKey: 'prog.translating' });
  const onOverview = { runner: await runnerPage(), tag: await tagOn(`${R2}:translate`, 'Tab · Overview').catch(() => tagOn(`${R2}:translate`)) };
  await page.goBack();
  await librarySettles(page);
  await sleep(600);
  const card = await label(`#grid > .card[data-gallery-id="${R}"] .card-prog-label`);
  const now = { reading, begun, row, onOverview, card };
  const was = record(FILE, 'reader-job');
  assert.deepEqual(now, was);
  assert.equal(await kept(page), true, 'one document throughout: changes of route');
  assert.deepEqual([page.problems, tasks.problems], [[], []]);
});

// A chapter's pages opened under its row stay open for that visit of the page. 1.3's page, come Back to
// as a document the browser kept, had them open still; the one page drew every row closed again, so the
// page was shorter than it was left and what was in view had moved. The rows open are kept by history
// entry (src/routes/overview.tsx, openedRows), and an opened chapter's grid stands at the height it had
// until its tiles are back (parts.tsx): the page is as it was left in its first frame. Arrived at anew
// (another entry), none is open.
test('Back to a series\' overview finds the chapters\' pages that were open still open, the scroll and the place kept in every frame; arrived at anew, none is open', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(`${OVERVIEW}?g=${L}`);
  t.after(() => page.close());
  // What shows: the scroll, the rows open, and the row at the window's middle with its place.
  const shows = () => {
    const rows = [...document.querySelectorAll('.ch-row')];
    const mid = rows.find((r) => r.getBoundingClientRect().bottom > innerHeight / 2);
    return `${Math.round(scrollY)} open:${rows.filter((r) => r.classList.contains('expanded')).map((r) => rows.indexOf(r) + 1).join(',')} mid:${rows.indexOf(mid) + 1}@${Math.round(mid?.getBoundingClientRect().top ?? 0)}`;
  };
  await page.evaluate(`window.__shows = ${shows}`);
  const OPEN = [5, 12, 40];
  const settled = async () => {
    await overviewSettles(page, L);
    await until(page, () => document.querySelectorAll('.ch-row').length === 60, null, { what: 'sixty rows' });
  };
  const tilesIn = () => until(page, (open) => open.every((n) => document.querySelectorAll(`.ch-row:nth-child(${n}) .ch-pages > .ov-page`).length === 1
    && document.querySelector(`.ch-row:nth-child(${n}) .ch-pages`).style.minHeight === ''), OPEN, { what: 'the opened chapters\' tiles' });
  const goTo = async (href, there) => {
    await page.evaluate((href) => { const a = Object.assign(document.createElement('a'), { href }); document.body.append(a); a.click(); a.remove(); }, href);
    await until(page, there, null, { what: href });
  };
  const tasks = () => !document.getElementById('ovContent') && !!document.getElementById('tkList');
  await settled();
  for (const n of OPEN) await page.evaluate((n) => document.querySelector(`.ch-row:nth-child(${n}) .ch-expand`).click(), n);
  await tilesIn();
  await page.evaluate(() => { scrollTo(0, 1500); window.__mark = 'kept'; });
  await sleep(500);
  const before = await page.evaluate(shows);
  assert.match(before, /^1500 open:5,12,40 mid:\d+@-?\d+$/, 'left at 1500 with three chapters\' pages open, two of them above what is in view');
  // Away and Back, twice: every frame as the page was left.
  for (const round of [1, 2]) {
    await goTo('/tasks', tasks);
    await sleep(200);
    const frames = await page.evaluate(() => new Promise((done) => {
      const seen = [];
      addEventListener('popstate', () => {
        const tick = () => { seen.push(window.__shows()); if (seen.length < 40) requestAnimationFrame(tick); else done(seen); };
        requestAnimationFrame(tick);
      }, { once: true });
      history.back();
    }));
    assert.deepEqual([...new Set(frames)], [before], `round ${round}: every one of forty frames as the page was left`);
    await settled();
    await tilesIn();
    assert.equal(await page.evaluate(shows), before, `round ${round}: and once the tiles are in`);
  }
  // Arrived at anew, from Tasks by a link: another entry, no chapter open, at the top.
  await goTo('/tasks', tasks);
  await goTo(`${OVERVIEW}?g=${L}`, () => !!document.getElementById('ovContent') && !document.getElementById('tkList'));
  await settled();
  assert.match(await page.evaluate(shows), /^0 open: mid:/, 'a new visit: none open');
  // And Back twice, to the visit left: as it was left still.
  await page.goBack();
  await until(page, tasks, null, { what: 'Tasks' });
  await page.goBack();
  await settled();
  await tilesIn();
  await sleep(300);
  assert.equal(await page.evaluate(shows), before, 'the visit left, as it was left');
  assert.equal(await kept(page), true, 'the same document throughout');
  assert.deepEqual(page.problems, []);
});

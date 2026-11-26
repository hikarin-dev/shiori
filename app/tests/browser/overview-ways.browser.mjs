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
// runs the same; a deliberate change of either page's behaviour edits it in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until, READER_PATH } from './harness.mjs';
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
  // The browser may let a document it kept for Back go (its reason not told: "masked"); then the page is
  // loaded again at the top, 1.3's as the one page (both measured with the browser keeping none). Seen
  // under a whole suite's load, 1 time in 6 with six copies at once: the round trip is made again then,
  // at most three times, the document marked anew each time.
  let back;
  for (let round = 1; round <= 3; round++) {
    await follow(page, '.ch-row:nth-child(30) .ch-title-open');
    await until(page, (path) => location.pathname.endsWith(path) && !!document.getElementById('topbar'), READER_PATH, { what: 'the reader' });
    await page.goBack();
    await overviewSettles(page, L);
    await sleep(600);
    back = { ...(await overview(page)), kept: await kept(page) };
    if (back.kept || round === 3) break;
    await page.evaluate(() => { scrollTo(0, 1500); window.__mark = 'kept'; });
    await sleep(400);
  }
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

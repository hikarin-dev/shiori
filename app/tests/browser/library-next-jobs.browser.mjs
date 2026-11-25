// library-next-jobs.browser.mjs — jobs on the cards of /library-next, held to what 1.3's page (/library)
// gave driven alike (library-drive.mjs): every state a download, an upload, a translation and a sync show
// on a card as their news comes on the real jobs channel, kept by an observer in the page (the card's
// place shown, its bar, its line, the buttons the job holds), through the last word's while and back to
// rest; a job said in another tab; what is under way as the page opens (each of 1.3's rows); a done
// job's page read again; an upload's empty gallery removed; a card's job while the page is turned and
// turned back. Then the new page alone: 300 words about one gallery draw its card and none of the
// other 29, and leaving the page five times with a job running and a question open leaves nothing.
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the library's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { openRun, seedRun, nextBase, publish, readDialog, sleep, PARTS } from './library-drive.mjs';
import { record } from './records.mjs';

const NEW = '/library-next';
const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser;
const id = (base, part) => String(base + PARTS[part]);

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  // 30 galleries older than every run's, so a run's cards share page 1 with them and page 2 exists.
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const api = await import('/app/js/api.js');
    const c = new OffscreenCanvas(300, 430); c.getContext('2d').fillRect(0, 0, 300, 430);
    const blob = await c.convertToBlob({ type: 'image/png' });
    for (let i = 0; i < 30; i++) {
      const gid = String(1790000500000 + i);
      await api.meta.put({ galleryId: gid, title: { english: `Filler ${i}`, japanese: '', pretty: '' }, tags: [], numPages: 1 });
      await api.pages.put(gid, 1, blob);
    }
  });
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

// In the page: what the card of `gid` shows of a job, as one line of words, whichever page draws it.
function stateOf(gid) {
  const card = document.querySelector(`#grid > .card[data-gallery-id="${gid}"]`);
  if (!card) return 'no card';
  const shown = card.querySelector('.card-body').classList.contains('downloading');
  const fill = card.querySelector('.prog-fill');
  const moving = fill.classList.contains('indeterminate') || /progress-travel/.test(fill.className);
  const bar = moving ? 'moving' : (fill.style.width || '0%');
  const done = fill.classList.contains('done') || fill.hasAttribute('data-done');
  const btn = (b) => [b.classList.contains('cancelling') && 'stop', b.classList.contains('done') && 'done', b.disabled && 'off', b.textContent.trim(), b.dataset.tip].filter(Boolean).join(' ');
  // (A job's line shows only with its place: 1.3 left its last words in the hidden line.)
  return [shown ? `shown ${bar}${done ? ' done' : ''}` : 'at rest', shown ? card.querySelector('.card-prog-label').textContent : '',
    `dl: ${btn(card.querySelector('.card-btn-dl'))}`, `tr: ${btn(card.querySelector('.card-btn-translate'))}`].join(' | ');
}

// In the page: every state the card of `gid` goes through from here on, by an observer on it.
function watch(gid) {
  const read = new Function(`return (${window.__stateOf})`)();
  window.__states = [read(gid)];
  const look = () => { const now = read(gid); if (now !== window.__states.at(-1)) window.__states.push(now); };
  window.__watching?.disconnect();
  window.__watching = new MutationObserver(look);
  window.__watching.observe(document.getElementById('grid'), { subtree: true, childList: true, attributes: true, characterData: true });
}

async function watching(page, gid) {
  await page.evaluate((src) => { window.__stateOf = src; }, stateOf.toString());
  await page.evaluate(watch, gid);
}
const states = (page) => page.evaluate(() => window.__states);

// Each job's news, in order, some said twice; then its last word's while.
const NEWS = {
  download: (gid) => [
    { gid, kind: 'download', status: 'started', labelKey: 'prog.contacting_helper' },
    { gid, kind: 'download', status: 'downloading', downloaded: 300000 },
    { gid, kind: 'download', status: 'downloading', downloaded: 600000, total: 2400000, pages: 4 },
    { gid, kind: 'download', status: 'extracting' },
    { gid, kind: 'download', status: 'progress', done: 1, total: 4, skipped: 1 },
    { gid, kind: 'download', status: 'progress', done: 3, total: 4, label: 'Storing', skipped: 1 },
    { gid, kind: 'download', status: 'done', done: 4, total: 4, skipped: 1 },
    { gid, kind: 'download', status: 'done', done: 4, total: 4, skipped: 1 },
  ],
  upload: (gid) => [
    { gid, kind: 'upload', status: 'started', labelKey: 'prog.reading' },
    { gid, kind: 'upload', status: 'progress', done: 1, total: 2 },
    { gid, kind: 'upload', status: 'error', errorKey: 'err.helper_unreachable' },
  ],
  translate: (gid) => [
    { gid, kind: 'translate', status: 'started' },
    { gid, kind: 'translate', status: 'progress', pct: 12, labelKey: 'prog.translating' },
    { gid, kind: 'translate', status: 'progress', done: 1, total: 2 },
    { gid, kind: 'translate', status: 'done', done: 2, total: 2, stale: 1, costNote: '$0.01' },
  ],
  'translate stopped': (gid) => [
    { gid, kind: 'translate', status: 'progress', pct: 40, labelKey: 'prog.translating' },
    { gid, kind: 'translate', status: 'cancelled' },
  ],
  sync: (gid) => [
    { gid, kind: 'sync', status: 'started' },
    { gid, kind: 'sync', status: 'progress', done: 1, total: 2 },
    { gid, kind: 'sync', status: 'done', done: 2, total: 2 },
  ],
};
const ON = { download: 'I', upload: 'N', translate: 'T', 'translate stopped': 'T', sync: 'S' };

for (const [kind, news] of Object.entries(NEWS)) {
  test(`a ${kind}: every state on its card, in order, to its end and back to rest`, async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const base = nextBase(1790004000000);
    const page = await openRun(browser, origin, NEW, { base });
    const gid = id(base, ON[kind]);
    await watching(page, gid);
    for (const word of news(gid)) { await publish(page, word); await sleep(150); }
    await sleep(4800);
    const now = { states: (await states(page)).map((s) => s.split(gid).join('<gid>')), problems: page.problems };
    await page.close();
    const was = record(FILE, 'news', kind);
    // §5.3 F50: when a finished download's last word has stayed its while, 1.3 hid its place and only
    // then put the button back, once the page's read again had landed: its ✓ stood on a card at rest
    // for that read. The new card rests in one step.
    const f50 = (s) => !/^at rest .*dl: done ✓/.test(s);
    assert.deepEqual(now, { ...was, states: was.states.filter(f50) });
    assert.ok(now.states.length > news(String(0)).length / 2);
  });
}

// Two jobs on one gallery at once: the bar and the line are the latest news', and each button stays
// its own job's (1.3 painted each button from its own job's words): a download's Stop does not go
// while its series' sync, or a translation, says a word.
const TWO = {
  'a series\' download while its sync runs': ['S', (gid) => [
    { gid, kind: 'download', status: 'started', labelKey: 'prog.contacting_helper' },
    { gid, kind: 'sync', status: 'started' },
    { gid, kind: 'download', status: 'progress', done: 1, total: 4 },
    { gid, kind: 'sync', status: 'progress', done: 1, total: 2 },
    { gid, kind: 'sync', status: 'done', done: 2, total: 2 },
    { gid, kind: 'download', status: 'progress', done: 3, total: 4 },
    { gid, kind: 'download', status: 'done', done: 4, total: 4 },
  ]],
  'a download while a translation runs and is stopped': ['P', (gid) => [
    { gid, kind: 'download', status: 'started', labelKey: 'prog.contacting_helper' },
    { gid, kind: 'translate', status: 'started' },
    { gid, kind: 'download', status: 'progress', done: 1, total: 4 },
    { gid, kind: 'translate', status: 'progress', pct: 12, labelKey: 'prog.translating' },
    { gid, kind: 'translate', status: 'cancelled' },
    { gid, kind: 'download', status: 'progress', done: 3, total: 4 },
    { gid, kind: 'download', status: 'done', done: 4, total: 4 },
  ]],
};

for (const [name, [part, news]] of Object.entries(TWO)) {
  test(`two jobs on one gallery, ${name}: each button its own job's, word by word`, async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const base = nextBase(1790004000000);
    const page = await openRun(browser, origin, NEW, { base });
    const gid = id(base, part);
    await watching(page, gid);
    for (const word of news(gid)) { await publish(page, word); await sleep(150); }
    await sleep(4800);
    const now = { states: (await states(page)).map((s) => s.split(gid).join('<gid>')), problems: page.problems };
    await page.close();
    const was = record(FILE, 'two', name);
    const f50 = (s) => !/^at rest .*dl: done ✓/.test(s);   // §5.3 F50, as above
    assert.deepEqual(now, { ...was, states: was.states.filter(f50) });
    // From its first word to its last, the download's button is its Stop in every state.
    const first = now.states.findIndex((s) => /dl: stop/.test(s)), last = now.states.findIndex((s) => /dl: done ✓/.test(s));
    assert.ok(first > 0 && last > first + 4, `the download's states were seen (${first}, ${last})`);
    assert.deepEqual(now.states.slice(first, last).filter((s) => !/dl: stop/.test(s)), [], 'the download\'s Stop never went');
    assert.match(now.states.at(-1), /^at rest/);
  });
}

// A title of a batch of imports says its own news on the live channel alone (jobs-runner.js: the
// batch keeps the record), and its card shows it as an upload's. The batch then tells of the title's
// end in a signal of its own (IMPORT_TITLE), which is no job's news.
const signal = (page, event) => page.evaluate(async (event) => (await import('/app/js/platform.js')).jobs.signal({ ...event, at: Date.now() }), event);

test('a title of a batch of imports: its own news on its card, to its end and back to rest', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const base = nextBase(1790004000000);
    const page = await openRun(browser, origin, NEW, { base });
    const gid = id(base, 'N');
    await watching(page, gid);
    for (const word of [
      { gid, kind: 'upload', status: 'started', labelKey: 'prog.reading', batch: 'b1' },
      { gid, kind: 'upload', status: 'progress', done: 1, total: 2, batch: 'b1' },
      { gid, kind: 'upload', status: 'done', done: 2, total: 2, batch: 'b1' },
      { type: 'IMPORT_TITLE', batch: 'b1', name: 'N gallery', gid, status: 'done', error: null },
    ]) { await signal(page, word); await sleep(150); }
    await sleep(4800);
    const now = { states: (await states(page)).map((s) => s.split(gid).join('<gid>')), problems: page.problems };
    await page.close();
    const was = record(FILE, 'batch-title');
    const f50 = (s) => !/^at rest .*dl: done ✓/.test(s);   // §5.3 F50
    assert.deepEqual(now, { ...was, states: was.states.filter(f50) });
    assert.ok(now.states.some((s) => /^shown .*1 \/ 2/.test(s)), 'its progress showed');
  }
});

// §5.3 F52: 1.3's page took a batch's word of a title's end for a job's news. For a title found
// imported already (its gallery there, with a card) that opened the card's place for a job, empty, and
// left it open until the page was loaded again (driven here beside this page until 2026-11-25, its last
// state was "shown"). The new page takes a signal for what it is.
test('a batch telling that a title was imported already draws nothing on that gallery\'s card', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const base = nextBase(1790004000000);
  const page = await openRun(browser, origin, NEW, { base });
  const gid = id(base, 'P');
  await watching(page, gid);
  await signal(page, { type: 'IMPORT_TITLE', batch: 'b1', name: 'P gallery', gid, status: 'skipped', error: null });
  await sleep(600);
  const now = { states: (await states(page)).map((s) => s.split(gid).join('<gid>')), problems: page.problems };
  await page.close();
  assert.equal(now.states.length, 1, 'the card stays as it was');
  assert.match(now.states[0], /^at rest/);
  assert.deepEqual(now.problems, []);
});

test('a job said in another tab shows on the card', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const base = nextBase(1790004000000);
    const page = await openRun(browser, origin, NEW, { base });
    const gid = id(base, 'I');
    await watching(page, gid);
    const other = await openPage(browser, origin);
    await other.goto(`${origin}/tasks`, { waitUntil: 'load' });
    await publish(other, { gid, kind: 'download', status: 'progress', done: 2, total: 4 });
    await sleep(300);
    await other.close();
    await page.bringToFront();
    await until(page, (gid) => !!document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-body.downloading`), gid, { what: 'the job' });
    await sleep(300);
    const now = { states: (await states(page)).map((s) => s.split(gid).join('<gid>')), problems: page.problems };
    await page.close();
    const was = record(FILE, 'other-tab');
    assert.deepEqual(now, was);
  }
});

test('what is under way as the page opens: each of 1.3\'s rows', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const base = nextBase(1790004000000);
    const ids = Object.fromEntries(Object.keys(PARTS).map((part) => [part, id(base, part)]));
    // The rows as they would be left in the registry, written there before the page opens.
    const writer = await openPage(browser, origin);
    await seedRun(writer, origin, base);
    await writer.evaluate(async (ids) => {
      const platform = await import('/app/js/platform.js');
      const now = Date.now();
      // Each row as its runner left it (the registry keeps an end that failed or was stopped).
      const rows = [
        { gid: ids.P, kind: 'download', status: 'error', errorKey: 'err.helper_unreachable', at: now - 5000 },
        { gid: ids.N, kind: 'upload', status: 'cancelled', at: now - 5000 },
        { gid: ids.T, kind: 'translate', status: 'progress', pct: 30, labelKey: 'prog.translating', at: now - 60 * 60 * 1000 },
        { gid: ids.I, kind: 'download', status: 'progress', done: 1, total: 4, at: now - 3 * 60 * 1000 },
        { gid: ids.S, kind: 'download', status: 'progress', done: 1, total: 2, at: now - 2000 },
      ];
      for (const row of rows) await platform.jobs.receive(row);
    }, ids);
    await writer.close();
    const view = await openPage(browser, origin);
    await view.goto(`${origin}${NEW}`, { waitUntil: 'load' });
    await until(view, (first) => document.querySelector('#grid > .card')?.dataset.galleryId === first, ids.P, { what: 'the run\'s cards' });
    await view.evaluate((src) => { window.__stateOf = src; }, stateOf.toString());
    await sleep(800);
    const read = () => view.evaluate((ids) => { const s = new Function(`return (${window.__stateOf})`)(); return Object.fromEntries(['P', 'N', 'T', 'I', 'S'].map((p) => [p, s(ids[p]).split(ids[p]).join('<gid>')])); }, ids);
    const first = await read();
    await sleep(4500);
    const later = await read();
    const left = await view.evaluate(async (ids) => (await (await import('/app/js/platform.js')).jobs.current()).filter((j) => Object.values(ids).includes(String(j.gid))).map((j) => `${Object.keys(ids).find((k) => ids[k] === String(j.gid))}:${j.kind}:${j.status}`).sort(), ids);
    const now = { first, later, left, problems: view.problems };
    await view.evaluate(async () => { const p = await import('/app/js/platform.js'); for (const j of await p.jobs.current()) await p.jobs.clear(j.gid, j.kind); });
    await view.close();
    const was = record(FILE, 'at-load');
    assert.deepEqual(now, was);
  }
});

test('a done job\'s end reads the page again; an upload that ends with its gallery empty removes it', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const base = nextBase(1790004000000);
    const page = await openRun(browser, origin, NEW, { base });
    await page.evaluate(async () => {
      const api = await import('/app/js/api.js');
      window.__pages = 0;
      const read = api.galleries.page;
      api.galleries.page = (...a) => { window.__pages++; return read(...a); };
    });
    await publish(page, { gid: id(base, 'I'), kind: 'download', status: 'progress', done: 3, total: 4 });
    await publish(page, { gid: id(base, 'I'), kind: 'download', status: 'done', done: 4, total: 4 });
    await sleep(3000);
    const before = await page.evaluate(() => window.__pages);
    await sleep(2000);
    const reread = await page.evaluate(() => window.__pages) - before;
    // An upload into the empty gallery fails: the gallery goes.
    await publish(page, { gid: id(base, 'E'), kind: 'upload', status: 'started' });
    await publish(page, { gid: id(base, 'E'), kind: 'upload', status: 'error', error: 'unreadable' });
    await sleep(1500);
    const empty = await page.evaluate(async (gid) => !!(await (await import('/app/js/api.js')).galleries.byIds([gid]))[0], id(base, 'E'));
    await until(page, (gid) => !document.querySelector(`#grid > .card[data-gallery-id="${gid}"]`), id(base, 'E'), { what: 'its card gone', timeout: 8000 });
    const now = { reread: reread > 0, emptyKept: empty, problems: page.problems };
    await page.close();
    const was = record(FILE, 'done-read');
    assert.deepEqual(now, { reread: true, emptyKept: false, problems: [] });
    assert.deepEqual(now, was);
  }
});

// A gallery removed from the library while its job runs. 1.3's rule (library.js: a gallery gone from
// the page reads it again `if (!_liveJobs.has(gid))`) leaves the page as it is until the job's end, its
// card kept; at the end the page is read again and the card goes. 1.3's page, driven here, did not
// always keep to its rule: in two quiet runs it read the page again at once and the card went, in one
// under the whole suite's load it kept the card. The new page keeps the rule; of 1.3's run the record
// keeps its end (and that nothing went unhandled), which the new page's is held to.
test('a gallery removed while its job runs: the page is not read again until the job ends, by 1.3 rule', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const base = nextBase(1790004000000);
    const page = await openRun(browser, origin, NEW, { base });
    const gid = id(base, 'I');
    await page.evaluate(async () => {
      const api = await import('/app/js/api.js');
      window.__pages = 0;
      const read = api.galleries.page;
      api.galleries.page = (...a) => { window.__pages++; return read(...a); };
    });
    await publish(page, { gid, kind: 'download', status: 'progress', done: 1, total: 4 });
    await until(page, (gid) => !!document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-btn-dl.cancelling`), gid, { what: 'the job' });
    await page.evaluate(async (gid) => (await import('/app/js/api.js')).galleries.delete(gid), gid);
    await sleep(2000);
    const during = await page.evaluate((gid) => ({ read: window.__pages > 0, card: !!document.querySelector(`#grid > .card[data-gallery-id="${gid}"]`) }), gid);
    await publish(page, { gid, kind: 'download', status: 'done', done: 4, total: 4 });
    await sleep(6000);
    const seen = { during, after: await page.evaluate((gid) => ({ read: window.__pages > 0, card: !!document.querySelector(`#grid > .card[data-gallery-id="${gid}"]`) }), gid), problems: page.problems };
    await page.close();
    const now = { after: seen.after, problems: seen.problems };
    const was = record(FILE, 'removed');
    assert.deepEqual(seen, { during: { read: false, card: true }, after: { read: true, card: false }, problems: [] });
    assert.deepEqual(now.after, was.after);
    assert.deepEqual(was.problems, []);
  }
});

test('a card\'s job while the page is turned and turned back', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const base = nextBase(1790004000000);
    const page = await openRun(browser, origin, NEW, { base });
    const gid = id(base, 'I');
    await publish(page, { gid, kind: 'download', status: 'progress', done: 1, total: 4 });
    await publish(page, { gid: id(base, 'N'), kind: 'download', status: 'error', error: 'gone' });
    await sleep(400);
    await page.evaluate(() => [...document.querySelectorAll('#pagination button')].find((b) => b.textContent === '2').click());
    await until(page, (gid) => !document.querySelector(`#grid > .card[data-gallery-id="${gid}"]`), gid, { what: 'page 2' });
    await publish(page, { gid, kind: 'download', status: 'progress', done: 2, total: 4 });
    await sleep(400);
    await page.evaluate(() => [...document.querySelectorAll('#pagination button')].find((b) => b.textContent === '1').click());
    await until(page, (gid) => !!document.querySelector(`#grid > .card[data-gallery-id="${gid}"]`), gid, { what: 'page 1' });
    await page.evaluate((src) => { window.__stateOf = src; }, stateOf.toString());
    await sleep(400);
    const now = await page.evaluate(([i, n]) => { const s = new Function(`return (${window.__stateOf})`)(); return [s(i).split(i).join('<gid>'), s(n).split(n).join('<gid>')]; }, [gid, id(base, 'N')]);
    await page.close();
    const was = record(FILE, 'turned');
    assert.deepEqual(now, was);
  }
});

test('300 words about one gallery draw its card and none of the other 29', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const base = nextBase(1790004000000);
    const page = await openRun(browser, origin, NEW, { base });
    const gid = id(base, 'I');
    // The library settled first: every cover in, and no word of a change for 1.5 s (the run's galleries
    // just made have their sizes and typical pages worked out a while after: changes to their cards,
    // not a job's).
    await until(page, () => [...document.querySelectorAll('#grid > .card img.card-thumb')].every((img) => img.getAttribute('src') && img.complete), null, { what: 'every cover' });
    await page.evaluate(async () => {
      const api = await import('/app/js/api.js');
      let last = performance.now();
      const off = api.events.watch(() => { last = performance.now(); });
      while (performance.now() - last < 1500) await new Promise((r) => setTimeout(r, 100));
      off();
    });
    await sleep(300);
    await page.evaluate(() => {
      window.__touched = {};
      new MutationObserver((records) => {
        for (const r of records) {
          const card = (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest('#grid > .card');
          if (card) window.__touched[card.dataset.galleryId] = (window.__touched[card.dataset.galleryId] || 0) + 1;
        }
      }).observe(document.getElementById('grid'), { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await page.evaluate(async (gid) => {
      const platform = await import('/app/js/platform.js');
      for (let i = 1; i <= 300; i++) {
        platform.jobs.signal({ gid, kind: 'download', status: 'progress', done: i, total: 300 });
        if (i % 10 === 0) await new Promise((r) => requestAnimationFrame(r));
      }
    }, gid);
    await sleep(600);
    const touched = await page.evaluate(() => window.__touched);
    const now = { cards: Object.keys(touched).map((k) => (k === gid ? 'its card' : 'another')).sort(), label: await page.evaluate((gid) => document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-prog-label`).textContent, gid) };
    await page.close();
    const was = record(FILE, 'words');
    assert.deepEqual(now, { cards: ['its card'], label: was.label });
    assert.deepEqual(now, was);
  }
});

test('leaving the page five times with a job running and a question open leaves nothing behind', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const base = nextBase(1790004000000);
  const page = await openPage(browser, origin);
  await seedRun(page, origin, base);
  await page.evaluateOnNewDocument(() => {
    const held = window.__held = { listeners: 0, intervals: 0, observers: 0, channels: 0, urls: 0 };
    for (const target of [window, document]) {
      const add = target.addEventListener, remove = target.removeEventListener;
      target.addEventListener = function (type, fn, opts) {
        const k = `${type}|${typeof opts === 'object' ? !!opts?.capture : !!opts}`;
        const key = fn && (fn.__keys ??= new Set());
        if (key && !key.has(k)) {
          key.add(k); held.listeners++;
          opts?.signal?.addEventListener('abort', () => { if (key.delete(k)) held.listeners--; }, { once: true });
        }
        return add.call(this, type, fn, opts);
      };
      target.removeEventListener = function (type, fn, opts) { const k = `${type}|${typeof opts === 'object' ? !!opts?.capture : !!opts}`; if (fn?.__keys?.has(k)) { fn.__keys.delete(k); held.listeners--; } return remove.call(this, type, fn, opts); };
    }
    const si = window.setInterval, ci = window.clearInterval, live = new Set();
    window.setInterval = (...a) => { const h = si(...a); live.add(h); held.intervals = live.size; return h; };
    window.clearInterval = (h) => { live.delete(h); held.intervals = live.size; return ci(h); };
    for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
      const Base = window[name];
      window[name] = class extends Base { observe(...a) { if (!this.__on) { this.__on = true; held.observers++; } return super.observe(...a); } disconnect() { if (this.__on) { this.__on = false; held.observers--; } return super.disconnect(); } };
    }
    const BC = window.BroadcastChannel;
    window.BroadcastChannel = class extends BC { constructor(n) { super(n); held.channels++; } close() { if (!this.__closed) { this.__closed = true; held.channels--; } return super.close(); } };
    const cu = URL.createObjectURL, ru = URL.revokeObjectURL, urls = new Set();
    URL.createObjectURL = (o) => { const u = cu(o); urls.add(u); held.urls = urls.size; return u; };
    URL.revokeObjectURL = (u) => { urls.delete(u); held.urls = urls.size; return ru(u); };
  });
  await page.goto(`${origin}${NEW}`, { waitUntil: 'load' });
  const gid = id(base, 'I');
  await until(page, (gid) => !!document.querySelector(`#grid > .card[data-gallery-id="${gid}"]`), gid, { what: 'the page' });
  const counts = [];
  for (let i = 0; i < 6; i++) {
    await publish(page, { gid, kind: 'download', status: 'progress', done: i + 1, total: 9 });
    await until(page, (gid) => !!document.querySelector(`#grid > .card[data-gallery-id="${gid}"] .card-btn-dl.cancelling`), gid, { what: 'the job' });
    await page.hover(`#grid > .card[data-gallery-id="${id(base, 'P')}"]`);
    await page.click(`#grid > .card[data-gallery-id="${id(base, 'P')}"] .card-btn-del`);
    await readDialog(page);
    // Away by a link to Settings (the question still open), and back.
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '/settings'; document.body.append(a); a.click(); a.remove(); });
    await until(page, () => location.pathname === '/settings' && !!document.getElementById('settingsNav'), null, { what: 'Settings' });
    await sleep(300);
    const left = await page.evaluate(() => !!document.querySelector('[data-notice="dialog"]'));
    await page.evaluate(() => history.back());
    await until(page, ([path, gid]) => location.pathname === path && !!document.querySelector(`#grid > .card[data-gallery-id="${gid}"]`), [NEW, gid], { what: 'the library again' });
    await sleep(1200);
    counts.push(await page.evaluate((left) => ({ ...window.__held, cards: document.querySelectorAll('.card').length, tips: document.querySelectorAll('.shiori-tip').length, dialogs: document.querySelectorAll('[data-slot="dialog"]').length, left }), left));
  }
  assert.equal(counts[0].left, false, 'the question went with the page');
  assert.deepEqual(counts.slice(1), Array(5).fill(counts[0]), JSON.stringify(counts));
  // The library holds the gallery the question was about: nothing was answered for the person.
  assert.equal(await page.evaluate(async (gid) => !!(await (await import('/app/js/api.js')).galleries.byIds([gid]))[0], id(base, 'P')), true);
  assert.deepEqual(page.problems, []);
  await page.close();
});

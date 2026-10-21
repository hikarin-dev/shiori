// tasks.browser.mjs — the tasks page (/tasks) lists every job under way, a row per job (so a gallery
// doing two has two), news of each live from any page, and stops one or all of them; and a running
// download's button is a Stop control, on a library card and on a chapter row. No helper runs here,
// so a stopped download is one nothing answers for: the app clears it itself.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const G = { a: '1790000000201', b: '1790000000202', ch1: '1790000000203', ch2: '1790000000204' };

let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await page.evaluate(async (G) => {
    const api = await import('/app/js/api.js');
    const png = async (hue) => {
      const canvas = new OffscreenCanvas(60, 90);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = `hsl(${hue} 60% 50%)`;
      ctx.fillRect(0, 0, 60, 90);
      return canvas.convertToBlob({ type: 'image/png' });
    };
    const title = (english) => ({ english, japanese: '', pretty: '' });
    for (const [gid, name] of [[G.a, 'Alpha'], [G.b, 'Beta'], [G.ch1, 'Chapter One'], [G.ch2, 'Chapter Two']]) {
      await api.meta.put({ galleryId: gid, title: title(name), tags: [], numPages: 2 });
      for (const n of [1, 2]) await api.pages.put(gid, n, await png(n * 60));
    }
    await api.series.write(G.ch1, [{ id: G.ch1, title: 'One', number: 1 }, { id: G.ch2, title: 'Two', number: 2 }],
      { seriesTitle: title('Saga'), seriesTags: [] });
  }, G);
  await page.close();
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function visit(path, t) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  return page;
}
async function finish(page) {
  await new Promise((r) => setTimeout(r, 300));
  const problems = [...page.problems];
  await page.close();
  assert.deepEqual(problems, [], 'the page left nothing unhandled');
}
// Publish a job's news from `page`, as whatever runs it would.
const publish = (page, job) => page.evaluate(async (job) => (await import('/app/js/platform.js')).jobs.publish(job), job);
const rowsOf = () => [...document.querySelectorAll('.tk-row')].map((r) => ({
  key: r.dataset.key, kind: r.querySelector('.tk-kind').textContent, title: r.querySelector('.tk-title').textContent,
  sub: r.querySelector('.tk-sub').textContent, label: r.querySelector('.tk-label').textContent,
  ended: ['done', 'error', 'cancelled'].some((c) => r.classList.contains(c)),
}));
// The rows, once `ok(rows)` holds.
async function rowsUntil(page, ok, what) {
  const end = Date.now() + 15000;
  let rows;
  while (Date.now() < end) {
    rows = await page.evaluate(rowsOf);
    if (ok(rows)) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(rows)}) ${page.problems.join(' | ')}`);
}

test('the tasks page lists every running job, a row per job, live, and stops one or all of them', async (t) => {
  const other = await visit('/app/library.html', t);
  if (!other) return;
  await publish(other, { gid: G.a, kind: 'download', status: 'progress', done: 1, total: 4 });
  await publish(other, { gid: G.a, kind: 'translate', status: 'progress', pct: 40, labelKey: 'prog.translating' });
  await publish(other, { gid: G.ch2, kind: 'upload', status: 'progress', done: 1, total: 3, labelKey: 'prog.importing' });

  const page = await visit('/tasks', t);
  const rows = await rowsUntil(page, (rows) => rows.length === 3 && rows.every((r) => !r.title.startsWith('#')) && rows[2].sub.includes('Saga'),
    'three rows with their galleries');
  assert.deepEqual(rows.map((r) => [r.key, r.kind, r.title]), [
    [`${G.a}:download`, 'Download', 'Alpha'], [`${G.a}:translate`, 'Translation', 'Alpha'], [`${G.ch2}:upload`, 'Import', 'Chapter Two']]);
  assert.match(rows[0].label, /1 \/ 4/);
  assert.equal(rows[2].sub, `#${G.ch2} · Saga`, 'a chapter says which series it is in');
  assert.equal(await page.$eval('#tkCount', (el) => el.textContent), '3');
  assert.equal(await page.$eval('#stopAllBtn', (el) => el.disabled), false);

  // A job started elsewhere joins the end of the list.
  await publish(other, { gid: G.b, kind: 'download', status: 'started', labelKey: 'prog.contacting_helper' });
  await until(page, () => document.querySelectorAll('.tk-row').length === 4 && document.querySelector('.tk-row:last-child .tk-title').textContent === 'Beta', null, { what: 'the new job, last' });

  // One Stop: the translation, and only it.
  await page.click(`.tk-row[data-key="${G.a}:translate"] .tk-stop`);
  await until(page, (key) => document.querySelector(`.tk-row[data-key="${key}"]`)?.classList.contains('cancelled'), `${G.a}:translate`, { what: 'the translation cancelled' });
  assert.equal(await page.$eval('#tkCount', (el) => el.textContent), '3');
  assert.equal(await page.$eval(`.tk-row[data-key="${G.a}:download"]`, (el) => el.classList.contains('cancelled')), false);

  // Stop all, confirmed: every job left — a download nothing runs any more, and an import.
  await page.click('#stopAllBtn');
  await page.waitForSelector('.notice-actions .btn.danger');
  await page.click('.notice-actions .btn.danger');
  const ended = await rowsUntil(page, (rows) => rows.every((r) => r.ended), 'every job stopped');
  assert.ok(ended.every((r) => r.label === 'Cancelled'), JSON.stringify(ended));
  assert.equal(await page.$eval('#tkCount', (el) => el.textContent), '0');
  assert.equal(await page.$eval('#stopAllBtn', (el) => el.disabled), true);
  assert.deepEqual(await page.evaluate(async () => (await (await import('/app/js/platform.js')).jobs.current())
    .filter((j) => !['done', 'error', 'cancelled'].includes(j.status)).length), 0, 'nothing left running in the jobs list');

  // Finished rows leave once the pointer is off the list, and the page says nothing is running.
  await page.mouse.move(5, 5);
  await until(page, () => !document.querySelector('.tk-row') && !document.getElementById('tkEmpty').hidden, null, { what: 'the empty list', timeout: 8000 });
  await finish(page);
  await finish(other);
});

test('a running download\'s button is a Stop control, on a library card and on a chapter row', async (t) => {
  const library = await visit('/app/library.html', t);
  if (!library) return;
  const card = `.card[data-gallery-id="${G.a}"]`;
  await library.waitForSelector(`${card} .card-btn-dl`);
  await publish(library, { gid: G.a, kind: 'download', status: 'progress', done: 1, total: 4 });
  const stopTip = await until(library, (card) => {
    const b = document.querySelector(`${card} .card-btn-dl`);
    return b?.classList.contains('cancelling') && !b.disabled && b.querySelector('rect') ? b.dataset.tip : 0;
  }, card, { what: 'the card\'s Stop' });
  assert.equal(stopTip, 'Stop downloading');
  await library.hover(card);
  await library.click(`${card} .card-btn-dl`);
  await until(library, (card) => {
    const b = document.querySelector(`${card} .card-btn-dl`);
    return !b.classList.contains('cancelling') && !b.querySelector('rect') && document.querySelector(`${card} .card-prog-label`).textContent === 'Cancelled';
  }, card, { what: 'the download stopped, the button back' });
  await finish(library);

  const overview = await visit(`/app/overview.html?g=${G.ch1}`, t);
  const row = `.ch-row[data-chapter-id="${G.ch2}"]`;
  await overview.waitForSelector(`${row} [data-download]`);
  await publish(overview, { gid: G.ch2, kind: 'download', status: 'progress', done: 1, total: 2 });
  assert.equal(await until(overview, (row) => {
    const b = document.querySelector(`${row} [data-download]`);
    return b?.classList.contains('cancelling') && !b.disabled && b.querySelector('rect') ? b.dataset.tip : 0;
  }, row, { what: 'the chapter\'s Stop' }), 'Stop downloading');
  await overview.click(`${row} [data-download]`);
  const tip = await until(overview, (row) => {
    const b = document.querySelector(`${row} [data-download]`);
    return !b.classList.contains('cancelling') && !b.querySelector('rect') ? b.dataset.tip : 0;
  }, row, { what: 'the chapter\'s download stopped' });
  assert.equal(tip, 'Replace images from CBZ', 'with nothing to download from, the button is Replace again');
  await finish(overview);
});

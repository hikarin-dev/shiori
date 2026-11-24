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
  await until(page, (key) => document.querySelector(`.tk-row[data-key="${key}"]`)?.classList.contains('cancelled'), `${G.a}:translate`, { what: 'the translation cancelled' })
    .catch(async (e) => {
      const row = await page.$eval(`.tk-row[data-key="${G.a}:translate"]`, (r) => ({ cls: r.className, label: r.querySelector('.tk-label').textContent, stopDisabled: r.querySelector('.tk-stop').disabled }));
      throw new Error(`${e.message} — the row: ${JSON.stringify(row)}`);
    });
  assert.equal(await page.$eval('#tkCount', (el) => el.textContent), '3');
  assert.equal(await page.$eval(`.tk-row[data-key="${G.a}:download"]`, (el) => el.classList.contains('cancelled')), false);

  // Stop all, confirmed: every job left — a download nothing runs any more, and an import.
  await page.click('#stopAllBtn');
  // The question is the app's notice host's (T11).
  const confirmStop = '[data-notice="dialog"] [data-slot="button"][data-variant="danger"]';
  await page.waitForSelector(confirmStop);
  await page.click(confirmStop);
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

test('a row leads to its gallery: its cover drawn, its title and cover linked; a folder\'s row and the Settings button lead to Settings', async (t) => {
  const page = await visit('/tasks', t);
  if (!page) return;
  const jobs = [[G.b, 'download'], ['folder-links', 'folder']];
  t.after(async () => {
    await page.evaluate(async (jobs) => { const platform = await import('/app/js/platform.js'); for (const [gid, kind] of jobs) await platform.jobs.clear(gid, kind); }, jobs).catch(() => {});
    await page.close();
  });
  await publish(page, { gid: G.b, kind: 'download', status: 'progress', done: 1, total: 4 });
  await publish(page, { gid: 'folder-links', kind: 'folder', status: 'progress', title: 'Shelf', done: 1, total: 3 });
  const row = `.tk-row[data-key="${G.b}:download"]`, folder = '.tk-row[data-key="folder-links:folder"]';
  // The cover is asked for once the gallery is read and drawn when it comes; none shows as nothing.
  const cover = await until(page, (row) => {
    const img = document.querySelector(`${row} .tk-thumb img`);
    return img?.naturalWidth > 0 && [img.src.slice(0, 11), getComputedStyle(img).visibility];
  }, row, { what: 'the cover' });
  assert.deepEqual(cover, ['data:image/', 'visible']);
  const to = (sel) => page.$eval(sel, (a) => { const u = new URL(a.href); return u.pathname + u.search; });
  assert.equal(await to(`${row} .tk-title`), `/overview?g=${G.b}`, 'the title: its overview');
  assert.equal(await to(`${row} .tk-thumb`), `/overview?g=${G.b}`, 'the cover: its overview');
  // A library folder's check: the folder's mark in the cover's place, and Settings, where the folders are.
  await page.waitForSelector(folder);
  assert.deepEqual(await page.$eval(folder, (r) => [r.querySelector('.tk-title').textContent, !!r.querySelector('.tk-thumb.folder svg'), !!r.querySelector('.tk-thumb img')]), ['Shelf', true, false]);
  assert.equal(await to(`${folder} .tk-title`), '/settings');
  assert.deepEqual(page.problems, []);
  // The header's Settings button: the Settings page, drawn by the one page (no load).
  await page.evaluate(() => { window.stayed = true; });
  await page.click('#settingsBtn');
  await until(page, () => location.pathname === '/settings' && document.title === 'Shiori — Settings' && !!document.getElementById('settingsNav'), null, { what: 'the Settings page' });
  assert.equal(await page.evaluate(() => window.stayed), true, 'a route change');
});

// Where a job runs names the page its tab shows as the job is published: a tab opened on Tasks that has
// moved to Settings since (a route change, no load) names Settings (platform.js runner.page).
test('a job published by a tab opened on Tasks and moved to Settings says it runs in a tab on Settings', async (t) => {
  const tab = await visit('/tasks', t);
  if (!tab) return;
  const page = await visit('/tasks', t);
  t.after(async () => {
    await page.evaluate(async (gid) => (await import('/app/js/platform.js')).jobs.clear(gid, 'download'), G.b).catch(() => {});
    await page.close(); await tab.close();
  });
  await until(tab, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  assert.equal(await tab.evaluate(async () => (await import('/app/js/platform.js')).runner.page), 'tasks');
  await tab.evaluate(() => { window.stayed = true; const a = document.createElement('a'); a.href = '/settings'; a.id = 'toSettings'; document.body.append(a); });
  await tab.$eval('#toSettings', (a) => a.click());
  await until(tab, () => document.title === 'Shiori — Settings' && !!document.getElementById('settingsNav'), null, { what: 'Settings' });
  assert.equal(await tab.evaluate(() => window.stayed), true, 'a route change, no load');
  await publish(tab, { gid: G.b, kind: 'download', status: 'progress', done: 1, total: 4 });
  const tag = await until(page, (key) => { const el = document.querySelector(`.tk-row[data-key="${key}"] .run-tag`); return el && !el.hidden && [el.textContent, el.dataset.runner]; },
    `${G.b}:download`, { what: 'the row\'s tag' });
  assert.deepEqual(tag, ['Tab · Settings', 'tab']);
  assert.deepEqual(tab.problems, []);
  assert.deepEqual(page.problems, []);
});

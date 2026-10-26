// import-batch.browser.mjs — a real folder dropped on the library: a drop of several titles asks
// first (how many titles, what can't be read, what is left out), then imports as one job its tracker
// follows to the end; each title gets a card of its own and the one that fails leaves none; its
// titles list says how each went; the same folder again skips them all; a single title asks nothing
// and says so when it is in the library already. The tasks page shows a batch too, and one whose page
// is gone as interrupted. The tracker sits in line with the grid, and fits a phone.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { zipCreate } from '../../js/zip.js';

let server, origin, browser, dir;

// A small PNG of one colour, so every title's pictures differ.
function png(r, g, b) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(12, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 12 }, () => Buffer.from([0, ...Array.from({ length: 8 }, () => [r, g, b]).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const cbz = (file, colours) => fs.writeFileSync(file, zipCreate(colours.map((c, i) => ({ name: `${i + 1}.png`, data: png(...c) }))));

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-batch-'));
  const shelf = path.join(dir, 'Shelf');
  fs.mkdirSync(path.join(shelf, 'part 1'), { recursive: true });
  fs.mkdirSync(path.join(shelf, 'part 2'));
  cbz(path.join(shelf, 'part 1', 'Alpha.cbz'), [[200, 40, 40], [200, 80, 40]]);
  cbz(path.join(shelf, 'part 1', 'Beta.cbz'), [[40, 200, 40]]);
  cbz(path.join(shelf, 'part 2', 'Gamma.cbz'), [[40, 40, 200], [40, 80, 200], [40, 120, 200]]);
  fs.writeFileSync(path.join(shelf, 'part 2', 'broken.cbz'), Buffer.alloc(400, 7));
  fs.writeFileSync(path.join(shelf, 'notes.txt'), 'not a picture');
  cbz(path.join(dir, 'Delta.cbz'), [[120, 120, 120]]);
});
after(async () => { await browser?.close(); server?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

async function library(t) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.goto(`${origin}/library`, { waitUntil: 'load' });
  await page.waitForSelector('#uploadCbzBtn');
  return page;
}
async function drop(page, files) {
  const cdp = await page.createCDPSession();
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: 640, y: 500, data });
  await cdp.detach();
}
const dialogText = (page) => until(page, () => document.querySelector('.notice-modal')?.innerText, null, { what: 'the question' });
const answer = (page, ok) => page.click(`.notice-actions .btn${ok ? '.primary' : ':not(.primary)'}`);
const tracker = (page) => page.evaluate(() => [...document.querySelectorAll('#importTracker .ib')].map((p) => ({
  state: p.dataset.state, name: p.querySelector('.ib-name')?.textContent, tally: p.querySelector('.ib-tally')?.textContent,
  issues: p.querySelector('.ib-issues')?.textContent })));
const titles = (page) => page.evaluate(async () => {
  const api = await import('/app/js/api.js');
  const ids = (await api.galleries.idsSorted({})).map(String);
  return (await Promise.all(ids.map((id) => api.galleries.get(id)))).map((g) => [g?.title?.english, g?.count]).sort();
});

test('a dropped folder of titles asks first, then imports as one job with a card for each', { skip: !chromePath() }, async (t) => {
  const page = await library(t);
  await drop(page, [path.join(dir, 'Shelf')]);
  const asked = await dialogText(page);
  assert.match(asked, /Import “Shelf”\?/);
  assert.match(asked, /4 titles/);
  assert.match(asked, /1 other files are left out/);
  assert.match(asked, /Import 4 titles/);
  await answer(page, true);
  await until(page, () => document.querySelector('#importTracker .ib')?.dataset.state === 'done', null, { what: 'the batch to end' });
  const [panel] = await tracker(page);
  assert.equal(panel.name, 'Shelf');
  assert.equal(panel.tally, 'Imported 3 titles');
  assert.equal(panel.issues, '1 failed');
  assert.deepEqual(await titles(page), [['Alpha', 2], ['Beta', 1], ['Gamma', 3]], 'a gallery for each title, none for the one that failed');

  // Its titles, and why one failed.
  await page.click('#importTracker .ib-list-btn');
  const rows = await until(page, () => {
    const r = [...document.querySelectorAll('#importTracker .ib-row')];
    return r.length === 4 && r.map((row) => [row.dataset.status, row.children[1].textContent, row.children[2].textContent]);
  }, null, { what: 'the titles list' });
  assert.deepEqual(rows.map(([s, n]) => [s, n]), [['done', 'Alpha'], ['done', 'Beta'], ['failed', 'broken'], ['done', 'Gamma']]);
  assert.match(rows[2][2], /not a valid zip/i);
  await page.click('#importTracker .ib-filter[data-filter="failed"]');
  assert.equal(await page.$$eval('#importTracker .ib-row', (r) => r.length), 1);

  // The same folder again: every title is in already.
  await drop(page, [path.join(dir, 'Shelf')]);
  await dialogText(page);
  await answer(page, true);
  await until(page, async () => {
    const panels = [...document.querySelectorAll('#importTracker .ib')];
    return panels.length === 2 && panels[1].dataset.state === 'done';
  }, null, { what: 'the second batch to end' });
  const second = (await tracker(page))[1];
  assert.equal(second.tally, 'Imported 0 titles');
  assert.equal(second.issues, '3 already in your library · 1 failed');
  assert.deepEqual(await titles(page), [['Alpha', 2], ['Beta', 1], ['Gamma', 3]], 'nothing added');

  // Dismissed, they're gone.
  for (const btn of await page.$$('#importTracker .ib-dismiss')) await btn.click();
  assert.equal(await page.$eval('#importTracker', (h) => h.hidden), true);
});

test('a single title asks nothing, and says so when it is in the library already', { skip: !chromePath() }, async (t) => {
  const page = await library(t);
  await drop(page, [path.join(dir, 'Delta.cbz')]);
  await until(page, async () => {
    const api = await import('/app/js/api.js');
    const ids = (await api.galleries.idsSorted({})).map(String);
    return (await Promise.all(ids.map((id) => api.galleries.get(id)))).some((g) => g?.title?.english === 'Delta' && g.count === 1);
  }, null, { what: 'Delta imported' });
  assert.equal(await page.$('.notice-modal'), null, 'no question for one title');
  assert.equal(await page.$eval('#importTracker', (h) => h.hidden), true, 'no batch shown for one title');
  await drop(page, [path.join(dir, 'Delta.cbz')]);
  const toast = await until(page, () => document.querySelector('.notice-toast, .toast')?.textContent, null, { what: 'the notice' });
  assert.match(toast, /Already in your library: Delta/);
});

test('the tasks page shows a batch running, and one whose page is gone as interrupted', { skip: !chromePath() }, async (t) => {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const platform = await import('/app/js/platform.js');
    const base = { kind: 'import', status: 'progress', total: 10, done: 4, imported: 3, skipped: 1, failed: 0, bytes: 5e8, bytesDone: 2e8, startedAt: Date.now() - 60000 };
    await platform.jobs.receive({ ...base, gid: 'import-1', name: 'Live', current: { name: 'Fifth', done: 2, total: 8, bytes: 5e7 }, movedAt: Date.now(), at: Date.now() });
    await platform.jobs.receive({ ...base, gid: 'import-2', name: 'Gone', current: null, at: Date.now() - 60000 });
  });
  const panels = await until(page, () => {
    const p = [...document.querySelectorAll('#tkImports .ib')];
    return p.length === 2 && p.map((el) => ({ state: el.dataset.state, tally: el.querySelector('.ib-tally').textContent,
      now: el.querySelector('.ib-now').textContent, stop: !el.querySelector('.ib-stop').hidden }));
  }, null, { what: 'two batches' });
  assert.equal(panels[0].state, 'running');
  assert.match(panels[0].tally, /^4 \/ 10 titles · /);
  assert.equal(panels[0].now, 'Now: Fifth · page 2 / 8');
  assert.equal(panels[0].stop, true);
  assert.equal(panels[1].state, 'lost');
  assert.match(panels[1].tally, /Interrupted at 4 of 10 titles/);
  assert.equal(panels[1].stop, false);
  assert.equal(await page.$eval('#tkCount', (el) => el.textContent), '1', 'the running batch counts as a job');
  assert.equal(await page.$eval('#tkEmpty', (el) => el.hidden), true);
});

test('the tracker is in line with the grid, and fits a phone with finger-sized buttons', { skip: !chromePath() }, async (t) => {
  const page = await library(t);
  const show = () => page.evaluate(async () => {
    const platform = await import('/app/js/platform.js');
    await platform.jobs.receive({ gid: 'import-9', kind: 'import', status: 'progress', name: 'A folder with a rather long name that has to give way',
      total: 18608, done: 2341, imported: 2300, skipped: 40, failed: 1, bytes: 8.3e11, bytesDone: 9.8e10, startedAt: Date.now() - 3600e3,
      current: { name: 'A title of its own that is long as well', done: 14, total: 30, bytes: 4e7 }, movedAt: Date.now(), at: Date.now() });
  });
  await show();
  await page.waitForSelector('#importTracker .ib');
  const desk = await page.evaluate(() => {
    const ib = document.querySelector('#importTracker .ib').getBoundingClientRect();
    const grid = document.getElementById('grid');
    const g = grid.getBoundingClientRect(), pad = parseFloat(getComputedStyle(grid).paddingLeft);
    return { ibLeft: ib.left, ibRight: ib.right, gridLeft: g.left + pad, gridRight: g.right - pad };
  });
  assert.ok(Math.abs(desk.ibLeft - desk.gridLeft) < 0.5 && Math.abs(desk.ibRight - desk.gridRight) < 0.5, `in line with the cards: ${JSON.stringify(desk)}`);

  await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
  await page.reload({ waitUntil: 'load' });
  await show();
  await page.waitForSelector('#importTracker .ib');
  const phone = await page.evaluate(() => {
    const ib = document.querySelector('#importTracker .ib').getBoundingClientRect();
    const btns = [...document.querySelectorAll('#importTracker .ib-btn:not([hidden])')].map((b) => b.getBoundingClientRect().height);
    return { fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth, left: ib.left, right: innerWidth - ib.right, btns };
  });
  assert.equal(phone.fits, true, 'nothing wider than the screen');
  assert.ok(Math.abs(phone.left - 12) < 0.5 && Math.abs(phone.right - 12) < 0.5, `the phone's margins: ${JSON.stringify(phone)}`);
  assert.ok(phone.btns.length >= 2 && phone.btns.every((h) => h >= 44), `buttons a finger can hit: ${phone.btns}`);
});

test('every job says where it runs, and its tooltip what would stop it', { skip: !chromePath() }, async (t) => {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const platform = await import('/app/js/platform.js');
    const job = (gid, kind, runner) => platform.jobs.receive({ gid, kind, status: 'progress', done: 1, total: 4, runner, at: Date.now() });
    await job('1790900000001', 'upload', { kind: 'tab', page: 'library', id: 'another-tab' });
    await job('1790900000002', 'upload', { kind: 'tab', page: 'tasks', id: platform.contextId });
    await job('1790900000003', 'upload', { kind: 'service-worker' });
    await job('1790900000004', 'download', { kind: 'helper', host: 'Chrome' });
    await job('1790900000008', 'download', { kind: 'helper', host: 'desktop' });
    await job('1790900000005', 'translate', { kind: 'service-worker' });   // what collects the server's pages
    await job('1790900000006', 'upload', { kind: 'desktop-background' });
    await job('1790900000007', 'upload', { kind: 'desktop-window', page: 'overview', id: 'another-window' });
    await platform.jobs.receive({ gid: 'import-7', kind: 'import', status: 'progress', name: 'Batch', total: 3, done: 1, bytes: 1e6, bytesDone: 3e5,
      runner: { kind: 'tab', page: 'library', id: 'another-tab' }, startedAt: Date.now(), movedAt: Date.now(), at: Date.now() });
  });
  const tags = await until(page, () => {
    const rows = [...document.querySelectorAll('.tk-row .run-tag')].map((el) => [el.textContent, el.dataset.tip]);
    return rows.length === 8 && rows;
  }, null, { what: 'eight tagged rows' });
  assert.deepEqual(tags.map(([text]) => text),
    ['Tab · Library', 'This tab', 'Background worker', 'Chrome extension', 'Desktop extension', 'Background worker', 'App background', 'Window · Overview']);
  assert.match(tags[0][1], /Closing that tab, reloading it or leaving the page stops it/);
  assert.match(tags[2][1], /about five minutes after the last one closes/);
  assert.match(tags[3][1], /in the extension in Chrome, not in a Shiori tab\. Closing Chrome or turning the extension off/);
  assert.match(tags[4][1], /in the extension inside Shiori Desktop, not in one of its windows\. Quitting Shiori Desktop or removing the extension/);
  assert.match(tags[6][1], /quitting the app stops it/);
  assert.equal(await page.$eval('#tkImports .ib[data-batch="import-7"] .run-tag', (el) => el.textContent), 'Tab · Library', 'the batch says so too');
});

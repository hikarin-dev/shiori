// overview-next-press.browser.mjs — a press on the overview at /overview-next, as it is drawn: its change
// in the frame of the press, and put back when the library refuses it (the heart); a press on one row
// draws that row alone (the other rows' nodes untouched); a job begun by a press, each of its words, and
// what its end does (the gallery read again, the row's cover asked again for pages that changed, the
// hero's details, the "✓" for 4 s, then the row at rest).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { openRun, nextBase, gid, visit, sleep, publish, record, pressRow, rowSel, read, NEW } from './overview-drive.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

// In the page: the frame a click on `sel` was taken in, and the frame `sel`'s pressed state changed in.
function watchPress(sel) {
  const at = window.__press = { frame: 0, clicked: null, changed: [] };
  const tick = () => { at.frame++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  document.addEventListener('click', (e) => { if (e.target.closest(sel)) at.clicked = at.frame; }, true);
  new MutationObserver(() => {
    const pressed = document.querySelector(sel)?.getAttribute('aria-pressed');
    if (at.changed.at(-1)?.pressed !== pressed) at.changed.push({ pressed, frame: at.frame });
  }).observe(document.getElementById('ovContent'), { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
}

test('the heart: drawn in the frame of the press; refused, put back', { skip: !chromePath() }, async () => {
  const base = nextBase(1790014000000);
  const page = await openRun(browser, origin, base);
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.evaluate(watchPress, '#favToggle');
  await page.click('#favToggle');
  await until(page, () => window.__press.changed.length >= 1, null, { what: 'the heart on' });
  const on = await page.evaluate(() => window.__press);
  assert.deepEqual(on.changed.map((c) => c.pressed), ['true']);
  assert.equal(on.changed[0].frame, on.clicked, 'on in the frame of the press');
  await sleep(600);
  assert.equal(await page.evaluate(async (id) => !!(await (await import('/app/js/api.js')).galleries.get(id)).favorite, gid(base, 'S')), true);
  // The library refuses the next: off at once, then on again.
  await page.evaluate(async () => { const api = await import('/app/js/api.js'); api.personal.favorite = async () => { await new Promise((r) => setTimeout(r, 300)); throw new Error('refused'); }; window.__press.changed = []; });
  await page.click('#favToggle');
  await until(page, () => window.__press.changed.length >= 2, null, { what: 'off, then on again' });
  const refused = await page.evaluate(() => window.__press);
  assert.deepEqual(refused.changed.map((c) => c.pressed), ['false', 'true']);
  assert.equal(refused.changed[0].frame, refused.clicked, 'off in the frame of the press');
  await sleep(500);
  assert.equal(await page.$eval('#favToggle', (b) => b.getAttribute('aria-pressed')), 'true');
  assert.equal(page.problems.filter((p) => !/refused/.test(p)).length, 0, page.problems.join('\n'));
  await page.close();
});

test('a press on one row draws that row alone; its job begun, word by word, and what its end does', { skip: !chromePath() }, async () => {
  const base = nextBase(1790014000000);
  const page = await openRun(browser, origin, base);
  // S2 with 2 of 3 pages: a download of it is not "again".
  await page.evaluate(async (id) => { const api = await import('/app/js/api.js'); const m = await api.meta.get(id); await api.meta.put({ ...m, numPages: 3 }); }, gid(base, 'S2'));
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.evaluate(record);
  // Every change to the other rows, and the covers asked for, from here on.
  await page.evaluate((keep) => {
    window.__others = 0;
    window.__covers = [];
    for (const row of document.querySelectorAll('.ch-row')) {
      if (row.dataset.chapterId === keep) continue;
      new MutationObserver((list) => { window.__others += list.length; }).observe(row, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    window.__rowsBefore = [...document.querySelectorAll('.ch-row')];
  }, gid(base, 'S2'));
  await page.evaluate(async () => {
    const { services } = await import('/app/js/services.js');
    const handle = services.handle;
    services.handle = function (msg) { if (msg?.type === 'GET_COVER') window.__covers.push(msg.galleryId); return handle.call(this, msg); };
  });
  await page.mouse.move(5, 5);
  await sleep(300);
  const rowOf = async () => { const r = await page.evaluate(read); const row = r.rows.find((x) => x.id === gid(base, 'S2')); return { state: row.state, progress: row.progress, download: row.actions.find((a) => a.kind === 'download') }; };
  await pressRow(page, base, 'S2', 'download');
  await page.mouse.move(5, 5);
  assert.deepEqual((await page.evaluate(() => window.__said)).map((m) => m.type), ['CACHE_ALL_PAGES']);
  const begun = await rowOf();
  assert.deepEqual([begun.state, begun.progress?.label, begun.download.state], [['working'], 'Contacting download helper…', ['cancelling']]);
  // (Its words are 1.3's: overview-next-jobs holds them, both pages alike.)
  const labels = [begun.progress.label];
  for (const word of [{ status: 'downloading', downloaded: 1000, total: 4000, pages: 3 }, { status: 'progress', done: 1, total: 1 }]) {
    await publish(page, { gid: gid(base, 'S2'), kind: 'download', ...word });
    await until(page, (was) => { const l = document.querySelector('.ch-row:nth-child(2) .ch-prog-label')?.textContent; return l && l !== was; }, labels.at(-1), { what: JSON.stringify(word) });
    labels.push(await page.$eval('.ch-row:nth-child(2) .ch-prog-label', (el) => el.textContent));
  }
  assert.equal(new Set(labels).size, 3, labels.join(' | '));
  // A page stored by the download, then its end: the gallery read again (3 pages), its cover asked again
  // (by the read of the change, which may land before the end's word: the end's read then finds nothing new).
  await page.evaluate(() => { window.__covers = []; });
  await page.evaluate(async (id) => {
    const api = await import('/app/js/api.js');
    const c = new OffscreenCanvas(30, 43); c.getContext('2d').fillRect(0, 0, 30, 43);
    await api.pages.put(id, 3, await c.convertToBlob({ type: 'image/png' }));
  }, gid(base, 'S2'));
  await sleep(300);
  await publish(page, { gid: gid(base, 'S2'), kind: 'download', status: 'done', done: 1, total: 1 });
  await until(page, () => document.querySelector('.ch-row:nth-child(2) [data-download]')?.textContent === '✓', null, { what: 'the ✓' });
  const ended = await rowOf();
  assert.deepEqual([ended.state, ended.progress?.done], [['working'], true]);
  await until(page, () => /3 \/ 3 pages/.test(document.querySelector('.ch-row:nth-child(2) .ch-meta')?.textContent ?? '') || /3 \/ 3/.test(document.querySelector('.ch-row:nth-child(2)').textContent), null, { what: 'its pages read again' }).catch(() => {});
  // The 4 s past: at rest again, its pages and the hero's details as the library has them.
  await until(page, () => !document.querySelector('.ch-row:nth-child(2).working'), null, { what: 'at rest', timeout: 7000 });
  const rest = await page.evaluate(read);
  const row = rest.rows.find((x) => x.id === gid(base, 'S2'));
  assert.equal(row.meta[1].text, '3 / 3 pages');
  assert.ok(rest.hero.meta.flat().some((m) => m.text === '9 pages'), JSON.stringify(rest.hero.meta));
  assert.ok((await page.evaluate(() => window.__covers)).includes(gid(base, 'S2')), 'its cover asked again');
  // The other rows: the same nodes, never changed.
  assert.equal(await page.evaluate(() => window.__others), 0, 'the other rows untouched');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.ch-row')].every((r, i) => r === window.__rowsBefore[i])), true, 'the same row nodes');
  assert.deepEqual(page.problems, []);
  await page.close();
});

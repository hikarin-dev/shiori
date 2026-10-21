// library-card-updates.browser.mjs — the library's cards take changes in place, in Chrome. While a
// series' chapter downloads (pages arriving, progress reported) and other galleries change, every
// card stays the same element: only the changed text redraws, covers stay put, and a hovered card
// stays grown. The new values show at once, and a card's own job keeps its progress showing while
// its numbers change under it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const S = { owner: '1790000000601', ch2: '1790000000602' };
const PLAIN = ['1790000000611', '1790000000612', '1790000000613', '1790000000614', '1790000000615'];

let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await page.evaluate(seed, { S, PLAIN });
  await page.close();
});

after(async () => {
  await browser?.close();
  server?.close();
});

// Runs in the page: a series of two chapters, and five galleries — every title several lines long,
// every gallery with enough tags to grow its card.
async function seed({ S, PLAIN }) {
  const api = await import('/app/js/api.js');
  const png = async (hue) => {
    const canvas = new OffscreenCanvas(300, 450);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `hsl(${hue} 60% 50%)`;
    ctx.fillRect(0, 0, 300, 450);
    return canvas.convertToBlob({ type: 'image/png' });
  };
  const tags = Array.from({ length: 24 }, (_, i) => ({ type: 'tag', name: `tag number ${i}`, url: '' }));
  const gallery = async (gid, name, i, pages) => {
    await api.meta.put({ galleryId: gid, title: { english: `${name} with a long title that runs over several lines of the card, far more than two`, japanese: '', pretty: '' },
      tags, numPages: 6, addedAt: Date.now() - i * 1000 });
    for (let n = 1; n <= pages; n++) await api.pages.put(gid, n, await png(i * 40 + n));
  };
  await gallery(S.owner, 'Series chapter one', 0, 2);
  await gallery(S.ch2, 'Series chapter two', 1, 1);
  await api.series.write(S.owner, [{ id: S.owner, title: '', number: 1 }, { id: S.ch2, title: '', number: 2 }],
    { seriesTitle: { english: 'A series whose title also runs over several lines of the card, as long as the others', japanese: '', pretty: '' }, seriesTags: tags });
  for (let i = 0; i < PLAIN.length; i++) await gallery(PLAIN[i], `Gallery ${i}`, i + 2, 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('changes land on the cards in place and at once, a hovered card staying grown', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.setViewport({ width: 1280, height: 1700 });
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('.card img.card-thumb[src]').length === 6, null, { what: 'six cards with covers' });
  await sleep(500);

  // Mark what is on the page now; record, from here on, any card or cover taken out.
  await page.evaluate(() => {
    window.__gone = [];
    for (const el of document.querySelectorAll('.card, .card img.card-thumb')) el.__kept = true;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.removedNodes) {
        if (n.nodeType === 1 && (n.matches('.card') || n.matches('img.card-thumb'))) window.__gone.push(n.dataset?.galleryId || n.className);
      }
    }).observe(document.getElementById('grid'), { childList: true, subtree: true });
  });
  const card = (gid) => `.card[data-gallery-id="${gid}"]`;
  const height = (gid) => page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().height, card(gid));
  const meta = (gid) => page.evaluate((sel) => document.querySelector(`${sel} .card-meta`).textContent, card(gid));
  const restHeight = await height(S.owner);
  const metaBefore = await meta(S.owner);

  // Hover the series card until it has grown.
  const box = await (await page.$(card(S.owner))).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  await sleep(500);
  const grown = await height(S.owner);
  assert.ok(grown > restHeight + 50, `the hovered series card grew (${restHeight} → ${grown})`);

  // Its second chapter downloads: pages arrive and progress is reported, as a download does.
  await page.evaluate(async ({ S }) => {
    const api = await import('/app/js/api.js');
    const platform = await import('/app/js/platform.js');
    const png = async (hue) => { const c = new OffscreenCanvas(300, 450); const x = c.getContext('2d'); x.fillStyle = `hsl(${hue} 60% 50%)`; x.fillRect(0, 0, 300, 450); return c.convertToBlob({ type: 'image/png' }); };
    platform.jobs.publish({ gid: S.ch2, kind: 'download', status: 'started' });
    for (let n = 2; n <= 6; n++) {
      await api.pages.put(S.ch2, n, await png(n * 30));
      platform.jobs.publish({ gid: S.ch2, kind: 'download', status: 'progress', done: n, total: 6 });
      await new Promise((r) => setTimeout(r, 120));
    }
  }, { S });
  // The series' page count follows the new pages: two of the first chapter, six of the second.
  assert.match(metaBefore, /\b3 pages\b/);
  await until(page, (sel) => /\b8 pages\b/.test(document.querySelector(`${sel} .card-meta`).textContent), card(S.owner), { what: 'the series card counting the new pages', timeout: 3000 });
  assert.equal(await page.evaluate((sel) => document.querySelector(sel).matches(':hover'), card(S.owner)), true, 'still hovered');
  assert.ok(Math.abs(await height(S.owner) - grown) < 1, 'and still grown — it never started over');

  // Another gallery is renamed: its title changes at once, in place.
  await page.evaluate(async (gid) => (await import('/app/js/store.js')).mutate(gid, { title: { english: 'Renamed', japanese: '', pretty: '' } }), PLAIN[1]);
  await until(page, (sel) => document.querySelector(`${sel} .card-title`)?.textContent === 'Renamed', card(PLAIN[1]), { what: 'the new title', timeout: 2000 });

  // A gallery's own download: its numbers change under its progress, which stays.
  await page.evaluate(async (gid) => {
    const api = await import('/app/js/api.js');
    const platform = await import('/app/js/platform.js');
    const c = new OffscreenCanvas(300, 450); c.getContext('2d').fillRect(0, 0, 300, 450);
    platform.jobs.publish({ gid, kind: 'download', status: 'progress', done: 2, total: 6, labelKey: 'prog.downloading' });
    await api.pages.put(gid, 2, await c.convertToBlob({ type: 'image/png' }));
  }, PLAIN[2]);
  await until(page, (sel) => /\b2 \/ 6 pages\b/.test(document.querySelector(`${sel} .card-meta`).textContent), card(PLAIN[2]), { what: 'its page count', timeout: 2000 });
  assert.equal(await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const dl = c.querySelector('.card-btn-dl');   // busy downloading: its Stop control
    return c.querySelector('.card-body').classList.contains('downloading') && c.querySelector('.prog-fill').style.width !== '' && dl.classList.contains('cancelling') && !!dl.querySelector('rect');
  }, card(PLAIN[2])), true, 'the progress bar and the busy button stay while it changes');

  await sleep(800);
  const state = await page.evaluate(() => ({
    gone: window.__gone,
    cardsKept: [...document.querySelectorAll('.card')].every((c) => c.__kept),
    coversKept: [...document.querySelectorAll('.card img.card-thumb')].every((img) => img.__kept),
  }));
  assert.deepEqual(state, { gone: [], cardsKept: true, coversKept: true }, 'no card or cover was made again');
  assert.deepEqual([...page.problems], [], 'the page left nothing unhandled');
  await page.close();
});

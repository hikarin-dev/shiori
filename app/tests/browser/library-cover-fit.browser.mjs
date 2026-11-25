// library-cover-fit.browser.mjs — a landscape cover is never seen unfitted. The owner (2026-11-25): "i
// have issue with landscape thumbnail cards not settling instantly when going to the next page or
// refreshing the page". The card fitted its cover after drawing it: the picture came cropped to the
// portrait box, a frame or two later whole (React drawing the card again after the picture's load),
// and its glow later still (a picture of its own, loaded after that): one to two frames unfitted for
// every landscape cover on every page, the glow painted 30 to 60 ms after its cover. 1.3 fitted a
// cover in the turn its picture loaded, canvas and all, so nothing of this was ever seen.
//
// Now how a cover sits is known before it is shown (src/lib/cover-fit.ts). Held here in the page
// itself, every frame from the one a cover first shows, and by when the browser says each picture was
// painted (element timing): at a first load, on the next page, back on a page seen before, and after
// a reload, every landscape cover is whole and has its glow from its first frame, both painted in the
// same frame, no portrait cover is ever letterboxed; on a page seen before every card has its cover in
// the first frame the card is there, and after a reload (the session's covers at hand) every portrait
// one has (a landscape one's glow is made anew while the page reads its galleries: it is there with
// its card or a few frames after, as the machine has time).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const GALLERIES = 70;     // three pages; every third one's first page is landscape
const BASE = 1795100000000;

// In the page: the galleries made, each of one page, a picture wide enough that its cover is made anew
// at the width the library asks for (the cover service's own picture).
async function seed({ count, base }) {
  const api = await import('/app/js/api.js');
  const picture = async (n, w, h) => {
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, `hsl(${(n * 47) % 360} 70% 55%)`); g.addColorStop(1, `hsl(${(n * 47 + 140) % 360} 70% 35%)`);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    return c.convertToBlob({ type: 'image/png' });
  };
  for (let n = 1; n <= count; n++) {
    const id = String(base + n), wide = n % 3 === 0;
    await api.meta.put({ galleryId: id, title: { english: `${wide ? 'Wide' : 'Tall'} ${n}`, japanese: '', pretty: '' }, tags: [], numPages: 1 });
    await api.pages.put(id, 1, await picture(n, wide ? 1200 : 800, wide ? 800 : 1130));
  }
  await (await import('/app/js/migrations.js')).runMigrations();
  sessionStorage.removeItem('shiori-covers');
}

// In every document of the page, from its start: each cover and glow named for element timing as it
// is put in, and each frame, for every card, whether its cover is there and whether it is fitted.
function watch() {
  const W = (window.__fit = { paints: [], cards: {}, first: {} });
  const PICTURES = 'img.card-thumb, img.card-thumb-glow';
  const name = (el) => { if (!el.hasAttribute('elementtiming')) el.setAttribute('elementtiming', el.classList.contains('card-thumb-glow') ? 'glow' : 'cover'); };
  new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches(PICTURES)) name(n);
      n.querySelectorAll(PICTURES).forEach(name);
    }
  }).observe(document, { childList: true, subtree: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) W.paints.push({ what: e.identifier, id: e.element?.closest('.card')?.dataset.galleryId ?? null, at: e.renderTime });
  }).observe({ type: 'element', buffered: true });
  const frame = () => {
    for (const img of document.querySelectorAll('#grid > .card img.card-thumb')) {
      const id = img.closest('.card').dataset.galleryId;
      if (!(id in W.first)) W.first[id] = !!img.getAttribute('src');
      if (!img.getAttribute('src') || !img.complete || !img.naturalWidth || getComputedStyle(img).visibility === 'hidden') continue;
      const landscape = img.naturalWidth >= img.naturalHeight;
      const glow = img.parentElement.querySelector('img.card-thumb-glow');
      const fitted = img.classList.contains('landscape') === landscape && (landscape ? !!glow && glow.complete && glow.naturalWidth > 0 : !glow);
      const card = (W.cards[id] ??= { landscape, unfitted: 0 });
      if (!fitted) card.unfitted++;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Every card's cover there, and nothing of the covers changing for half a second.
const coversIn = (page, what) => until(page, () => {
  const cards = [...document.querySelectorAll('#grid > .card')];
  const there = cards.length > 0 && cards.every((c) => { const i = c.querySelector('img.card-thumb'); return i?.getAttribute('src') && i.complete; });
  const now = performance.now(), sig = cards.map((c) => c.dataset.galleryId + (c.querySelector('img.card-thumb-glow') ? 'g' : '')).join();
  if (!there || sig !== window.__sig) { window.__sig = sig; window.__since = now; return false; }
  return now - window.__since > 500;
}, null, { timeout: 60000, what });

// What the watch saw of the cards the page shows now.
const seen = (page) => page.evaluate(() => {
  const W = window.__fit;
  const ids = [...document.querySelectorAll('#grid > .card')].map((c) => c.dataset.galleryId);
  const painted = (id, what) => W.paints.filter((p) => p.id === id && p.what === what).map((p) => p.at).sort((a, b) => a - b)[0] ?? null;
  return ids.map((id) => ({ id, ...W.cards[id], coverAtFirstFrame: W.first[id], cover: painted(id, 'cover'), glow: painted(id, 'glow') }));
});
const forget = (page) => page.evaluate(() => { const W = window.__fit; W.cards = {}; W.first = {}; W.paints.length = 0; window.__sig = ''; });

function fittedFromTheFirstFrame(cards, when) {
  assert.equal(cards.length, 30, `${when}: a page of cards`);
  const wide = cards.filter((c) => c.landscape);
  assert.equal(wide.length, 10, `${when}: its landscape covers`);
  assert.deepEqual(cards.filter((c) => c.unfitted).map((c) => `${c.id}: ${c.unfitted} frame(s)`), [], `${when}: no cover seen unfitted`);
  for (const c of wide) {
    assert.ok(c.cover != null && c.glow != null, `${when}: ${c.id}'s cover and glow painted`);
    assert.ok(Math.abs(c.glow - c.cover) < 1, `${when}: ${c.id}'s glow painted with its cover (${Math.round(c.glow - c.cover)} ms apart)`);
  }
}

test('a landscape cover shows fitted, its glow with it, from its first frame: a first load, the next page, a page seen before, a reload', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(seed, { count: GALLERIES, base: BASE });
  await page.evaluateOnNewDocument(watch);

  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await coversIn(page, 'the first load');
  fittedFromTheFirstFrame(await seen(page), 'a first load');

  const goTo = async (n) => {
    await forget(page);
    await page.evaluate((n) => [...document.querySelectorAll('#pagination [data-slot="page-button"]')].find((b) => b.textContent.trim() === String(n)).click(), n);
    await until(page, (n) => (new URLSearchParams(location.search).get('page') ?? '1') === String(n), n, { what: `page ${n}` });
    await coversIn(page, `page ${n}`);
    return seen(page);
  };
  fittedFromTheFirstFrame(await goTo(2), 'the next page');

  const back = await goTo(1);
  fittedFromTheFirstFrame(back, 'a page seen before');
  assert.deepEqual(back.filter((c) => !c.coverAtFirstFrame).map((c) => c.id), [], 'a page seen before: every card has its cover in its first frame');

  // (The session's covers are written 800 ms after the last change: the reload starts from them.)
  await new Promise((done) => setTimeout(done, 1500));
  await page.reload({ waitUntil: 'load' });
  await coversIn(page, 'the reload');
  const reloaded = await seen(page);
  fittedFromTheFirstFrame(reloaded, 'a reload');
  assert.deepEqual(reloaded.filter((c) => !c.landscape && !c.coverAtFirstFrame).map((c) => c.id), [], 'a reload: every portrait cover is there in its card\'s first frame');
  assert.deepEqual(page.problems, []);
});

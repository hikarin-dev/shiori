// library-cards.browser.mjs — the library's cards on a real grid, as the one page draws the library
// (/library; until 2026-11-25 this file held 1.3's page, and a file of its own held the new page to
// 1.3's, driven alike: what 1.3's page gave is each table's record, records/<this
// file>.<table>.json, records.mjs, 1.3's behaviour as measured on 2026-11-25, which a deliberate change of
// the library's behaviour edits in the same commit). At rest a card shows two lines of its title and one
// row of its tags; hovered, it grows down over the cards below to show all of both, animated, and never
// pushes anything: in every frame while it grows and shrinks back, no other card's top or height moves,
// the grid's height, the page's scroll height and the paging stay; the grown card is drawn over the card
// below; moving up to the card above while it shrinks, the new one is on top at once and the shrinking
// one above the resting cards (and the earlier of the two stays over the later); a card alone in the last
// row grows over the space below and its row keeps its height; the grid's only card grows the grid; the
// same at the two-column width; on a touch screen a tap grows nothing. No card's text is lifted onto a
// compositor layer meanwhile (text there is antialiased differently). And leaving the page and coming
// back five times leaves nothing behind (listeners, timers, observers, channels, object URLs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { record } from './records.mjs';

const NEW = '/library';
const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IDS = Array.from({ length: 9 }, (_, i) => String(1790000005001 + i));

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async (ids) => {
    const api = await import('/app/js/api.js');
    const tags = Array.from({ length: 30 }, (_, i) => ({ type: 'tag', name: `tag number ${i}`, url: '' }));
    for (const [i, gid] of ids.entries()) {
      const c = new OffscreenCanvas(300, 450); const x = c.getContext('2d'); x.fillStyle = `hsl(${i * 40} 60% 50%)`; x.fillRect(0, 0, 300, 450);
      await api.meta.put({ galleryId: gid, title: { english: `Card ${i} with a long title that runs over several lines of the card, far more than the two it shows at rest`, japanese: '', pretty: '' }, tags, numPages: 1 });
      await api.pages.put(gid, 1, await c.convertToBlob({ type: 'image/png' }));
    }
  }, IDS);
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

// Every card's place and height, what its title and tags show, and where the pagination sits.
const layout = () => ({
  cards: [...document.querySelectorAll('.card')].map((card) => {
    const box = card.getBoundingClientRect();
    const title = card.querySelector('.card-title'), tags = card.querySelector('.card-tags');
    return { at: `${box.left.toFixed(1)},${box.top.toFixed(1)}`, height: box.height, z: Number(getComputedStyle(card).zIndex),
      titleAll: title.clientHeight >= title.scrollHeight, tagsAll: tags.clientHeight >= tags.scrollHeight };
  }),
  pagination: document.getElementById('pagination').getBoundingClientRect().top,
});

test('a hovered card grows over the cards below without moving anything, then shrinks back', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.setViewport({ width: 1280, height: 2400 });   // all three rows whole: four cards a row
  await page.goto(`${origin}${NEW}`, { waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('.card img.card-thumb[src]').length === 9, null, { what: 'nine cards with covers' });
  await sleep(300);

  // What the compositor holds while things animate: any layer that isn't the page itself, the
  // header, a card's buttons (icons only) or the hidden field a drawn select keeps for a form (Base
  // UI's: fixed, 1px, clipped, no text shown; the sort box's and the page menu's) would be carrying a
  // card's text.
  const cdp = await page.createCDPSession();
  await cdp.send('DOM.getDocument', { depth: -1 });
  let layers = [];
  cdp.on('LayerTree.layerTreeDidChange', (e) => { if (e.layers) layers = e.layers; });
  await cdp.send('LayerTree.enable');
  const textLayersDuring = async (ms) => {
    const seen = new Map();
    for (const end = Date.now() + ms; Date.now() < end; await sleep(8)) for (const l of layers) if (l.drawsContent && l.backendNodeId) seen.set(l.layerId, l.backendNodeId);
    const names = await Promise.all([...seen.values()].map(async (backendNodeId) => {
      const { node } = await cdp.send('DOM.describeNode', { backendNodeId });
      const at = node.attributes?.indexOf('class') ?? -1;
      const cls = at >= 0 ? node.attributes[at + 1] : '';
      return `${node.nodeName.toLowerCase()}${cls ? '.' + cls.split(' ')[0] : ''}`;
    }));
    return names.filter((n) => !['#document', 'header', 'header.app-header', 'div.card-actions', 'input'].includes(n));
  };

  const rest = await page.evaluate(layout);
  const restHeight = rest.cards[0].height;
  for (const c of rest.cards) {
    assert.equal(c.height, restHeight, 'every card the same height at rest');
    assert.equal(c.titleAll, false, 'two lines of the title');
    assert.equal(c.tagsAll, false, 'one row of the tags');
  }
  const unmoved = (now, what) => {
    assert.deepEqual(now.cards.map((c) => c.at), rest.cards.map((c) => c.at), `${what}: no card moved`);
    assert.equal(now.pagination, rest.pagination, `${what}: nothing below the grid moved`);
  };

  const A = await (await page.$('.card:nth-child(3)')).boundingBox();   // the first row
  const B = await (await page.$('.card:nth-child(7)')).boundingBox();   // under it
  const x = A.x + A.width / 2, overB = { x, y: B.y + 30 };              // the top of B's cover

  // The card's height, frame by frame, as it grows.
  await page.evaluate(() => {
    const card = document.querySelectorAll('.card')[2], heights = [];
    window.__growth = new Promise((done) => {
      const end = performance.now() + 400;
      (function frame() { heights.push(card.getBoundingClientRect().height); performance.now() < end ? requestAnimationFrame(frame) : done(heights); })();
    });
  });
  await page.mouse.move(x, A.y + 60);
  assert.deepEqual(await textLayersDuring(220), [], 'no card text on a layer while it grows');
  const growth = await page.evaluate(() => window.__growth);
  const hovered = await page.evaluate(layout);
  assert.ok(growth.some((h) => h > restHeight + 1 && h < hovered.cards[2].height - 1), 'it grows over several frames');
  assert.ok(hovered.cards[2].titleAll && hovered.cards[2].tagsAll, 'hovered, it shows the whole title and every tag');
  assert.ok(hovered.cards[2].height > restHeight + 100);
  unmoved(hovered, 'hovered');
  assert.equal(await page.evaluate(drawnAt, overB), 3, 'drawn over the card below');

  // A change to a hovered card's gallery (1.3 made the card again once it had shrunk back; the one page
  // changes it in place, §5.3 F49).
  await page.evaluate(async () => (await import('/app/js/api.js')).personal.favorite(document.querySelectorAll('.card')[2].dataset.galleryId, true));
  await sleep(200);

  // Down into B: A shrinks back still drawn over B's cover, until it has.
  await page.mouse.move(x, B.y + 300);
  await sleep(40);
  assert.equal(await page.evaluate(drawnAt, overB), 3, 'the earlier card shrinks back over the hovered one');
  assert.deepEqual(await textLayersDuring(200), [], 'no card text on a layer while they trade places');
  await sleep(250);
  let now = await page.evaluate(layout);
  assert.equal(await page.evaluate(drawnAt, overB), 7);
  assert.ok(now.cards[2].height === restHeight && now.cards[6].titleAll, 'A at rest, B grown');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.card')[2].querySelector('.card-fav.on') !== null), true, 'A made again from the change');
  unmoved(now, 'B hovered');

  // Back up into A: A grows over B's cover at once, and B shrinks back above the resting cards.
  await page.mouse.move(x, A.y + 60);
  await sleep(40);
  now = await page.evaluate(layout);
  assert.equal(await page.evaluate(drawnAt, overB), 3, 'the hovered card is drawn over the later card shrinking back');
  assert.ok(now.cards[6].z > 0 && now.cards[6].z < now.cards[2].z, `the shrinking card sits between (z ${now.cards[6].z}, hovered ${now.cards[2].z})`);
  assert.ok(now.cards[6].height > restHeight, 'B is still shrinking');
  assert.deepEqual(await textLayersDuring(200), [], 'no card text on a layer');
  await sleep(250);
  now = await page.evaluate(layout);
  assert.equal(now.cards[6].z, 0, 'and then rests');
  assert.equal(now.cards[6].height, restHeight);

  // The card alone in the last row grows over the space below it; its row keeps its height.
  const lone = await (await page.$('.card:nth-child(9)')).boundingBox();
  await page.mouse.move(lone.x + 100, lone.y + 60);
  await sleep(450);
  now = await page.evaluate(layout);
  assert.ok(now.cards[8].height > restHeight + 100, 'the lone card grew');
  unmoved(now, 'the lone card hovered');
  await page.mouse.move(5, 5);
  await sleep(450);
  unmoved(await page.evaluate(layout), 'all at rest again');

  await sleep(200);
  assert.deepEqual([...page.problems], [], 'the page left nothing unhandled');
  await page.close();
});

async function open(path, size = { width: 1280, height: 2400 }, n = 9) {
  const page = await openPage(browser, origin);
  await page.setViewport(size);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await until(page, (n) => document.querySelectorAll('#grid > .card img.card-thumb[src]').length === n, n, { what: `${n} cards with covers` });
  await sleep(400);
  return page;
}

// Every frame from now until `stop()`: each card's top and height, the grid's height, the page's scroll
// height, the paging's top (kept in the page as they change).
const watch = (page) => page.evaluate(() => {
  const frames = [];
  let on = true;
  const tick = () => {
    if (!on) return;
    frames.push({ cards: [...document.querySelectorAll('#grid > .card')].map((c) => { const r = c.getBoundingClientRect(); return [r.top, r.height]; }),
      grid: document.getElementById('grid').getBoundingClientRect().height, scroll: document.documentElement.scrollHeight, paging: document.getElementById('pagination').getBoundingClientRect().top });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__stop = () => { on = false; return frames; };
});
const stop = (page) => page.evaluate(() => window.__stop());
// What moved in any frame: every card but `except` (0-based) against the first frame.
function moved(frames, except) {
  const first = frames[0], out = [];
  for (const f of frames) {
    f.cards.forEach(([top, h], i) => { if (!except.includes(i) && (top !== first.cards[i][0] || h !== first.cards[i][1])) out.push(`card ${i + 1}: ${first.cards[i]} → ${top},${h}`); });
    if (f.grid !== first.grid) out.push(`grid ${first.grid} → ${f.grid}`);
    if (f.scroll !== first.scroll) out.push(`scroll height ${first.scroll} → ${f.scroll}`);
    if (f.paging !== first.paging) out.push(`paging ${first.paging} → ${f.paging}`);
  }
  return [...new Set(out)];
}
const drawnAt = ({ x, y }) => { const c = document.elementFromPoint(x, y)?.closest('.card'); return c ? [...document.querySelectorAll('#grid > .card')].indexOf(c) + 1 : null; };
const z = (i) => Number(getComputedStyle(document.querySelectorAll('#grid > .card')[i]).zIndex);

async function growth(path, size, perRow) {
  const page = await open(path, size);
  const r = {};
  const box = async (n) => (await page.$(`#grid > .card:nth-child(${n})`)).boundingBox();
  const A = await box(3), B = await box(3 + perRow);
  const x = A.x + A.width / 2, overB = { x, y: B.y + 30 };
  // Grows over the card below, nothing else moving.
  await watch(page);
  await page.mouse.move(x, A.y + 60);
  await sleep(450);
  r.grownOver = await page.evaluate(drawnAt, overB);
  r.grew = (await box(3)).height > A.height + 50;
  // Down into B: A shrinks back over B's cover, then rests.
  await page.mouse.move(x, B.y + B.height - 40);
  await sleep(40);
  r.shrinkingOver = await page.evaluate(drawnAt, overB);
  await sleep(450);
  // Back up into A while B shrinks: A on top at once, B between it and the resting cards.
  await page.mouse.move(x, A.y + 60);
  await sleep(40);
  r.upOnTop = await page.evaluate(drawnAt, overB);
  r.zBetween = await page.evaluate(([a, b]) => { const za = Number(getComputedStyle(document.querySelectorAll('#grid > .card')[a]).zIndex), zb = Number(getComputedStyle(document.querySelectorAll('#grid > .card')[b]).zIndex); return zb > 0 && zb < za; }, [2, 2 + perRow]);
  await page.mouse.move(5, 5);
  await sleep(500);
  r.moved = moved(await stop(page), [2, 2 + perRow]);
  // The card alone in the last row: it grows over the space below; its row, the grid and the paging stay.
  const lone = await box(IDS.length);
  await watch(page);
  await page.mouse.move(lone.x + lone.width / 2, lone.y + 60);
  await sleep(450);
  r.loneGrew = (await box(IDS.length)).height > lone.height + 50;
  await page.mouse.move(5, 5);
  await sleep(500);
  r.loneMoved = moved(await stop(page), [IDS.length - 1]);
  assert.deepEqual(page.problems, []);
  await page.close();
  return r;
}

for (const [name, size, perRow] of [['at 1280', { width: 1280, height: 2400 }, 4], ['at the two-column width', { width: 500, height: 2400 }, 2]]) {
  test(`${name}: a hovered card grows down over the cards below and pushes nothing, as 1.3's`, async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    // (A lone card at the page's end may reach past it: the page's scroll height then follows the card
    // frame by frame, as on 1.3's page, to a height a pixel apart from run to run; nothing in the grid or
    // under it moves. Its frames are left out, and that it reached past the end is kept.)
    const plain = (r) => ({ ...r, loneMoved: r.loneMoved.filter((m) => !m.startsWith('scroll height')), pastEnd: r.loneMoved.some((m) => m.startsWith('scroll height')) });
    const now = plain(await growth(NEW, size, perRow));
    const was = record(FILE, 'growth', name);
    assert.deepEqual(now, was);
    assert.deepEqual({ ...now, pastEnd: undefined },
      { grownOver: 3, grew: true, shrinkingOver: 3, upOnTop: 3, zBetween: true, moved: [], loneGrew: true, loneMoved: [], pastEnd: undefined });
  });
}

test('the grid\'s only card grows the grid (it has nothing to grow over), as 1.3\'s', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(`${NEW}?q=${IDS[4]}`, { width: 1280, height: 900 }, 1);
    const before = await page.evaluate(() => document.getElementById('grid').getBoundingClientRect().height);
    const b = await (await page.$('#grid > .card')).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 60);
    await sleep(450);
    const grown = await page.evaluate(() => [document.getElementById('grid').getBoundingClientRect().height, document.querySelector('#grid > .card').getBoundingClientRect().height]);
    const now = { grewGrid: grown[0] > before + 50, cardFills: Math.abs(grown[0] - 40 - grown[1]) < 1 };
    await page.close();
    const was = record(FILE, 'only');
    assert.deepEqual(now, { grewGrid: true, cardFills: true });
    assert.deepEqual(now, was);
  }
});

// A file picker opened from a card (Replace: these galleries have no source, so download is Replace)
// takes the window's focus; the pointer may be anywhere once it closes, while the browser still holds
// the card under it as hovered (grown). When the window has its focus back, the card is made to drop the
// pointer for a moment, so what is under the pointer is worked out again (1.3's _operatingOnCard): its
// pointer-events none, read, and back. Once only: a focus after that does nothing.
test('a card a file picker was opened from: what is under the pointer worked out again once the window has its focus back', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW);
    const sel = '#grid > .card:nth-child(2)';
    await page.hover(sel);
    await sleep(400);
    await page.evaluate((sel) => {
      const c = document.querySelector(sel);
      window.__styles = [];
      new MutationObserver(() => window.__styles.push(c.style.pointerEvents)).observe(c, { attributes: true, attributeFilter: ['style'] });
      const read = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight').get;
      Object.defineProperty(c, 'offsetHeight', { get() { window.__styles.push(`read while ${c.style.pointerEvents || 'auto'}`); return read.call(this); }, configurable: true });
    }, sel);
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 8000 }), page.click(`${sel} .card-btn-dl`)]);
    await chooser.cancel();
    await sleep(200);
    const before = await page.evaluate(() => [...window.__styles]);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(100);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(100);
    const now = { before, after: await page.evaluate(() => window.__styles), problems: page.problems };
    await page.close();
    const was = record(FILE, 'picker');
    // Nothing before the focus came back; then once its pointer-events none, read so, and back.
    assert.deepEqual(now.before, []);
    assert.ok(now.after.includes('read while none') && now.after.at(-1) === '', JSON.stringify(now));
    assert.deepEqual(now, was);
  }
});

test('on a touch screen a tap grows nothing', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await open(NEW, { width: 390, height: 2400, isMobile: true, hasTouch: true });
    const heights = () => page.evaluate(() => [...document.querySelectorAll('#grid > .card')].map((c) => c.getBoundingClientRect().height));
    const before = await heights();
    const title = await (await page.$('#grid > .card:nth-child(3) .card-title')).boundingBox();
    await page.touchscreen.tap(title.x + 10, title.y + 5);
    await sleep(500);
    const now = { same: JSON.stringify(await heights()) === JSON.stringify(before), columns: await page.evaluate(() => getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length) };
    await page.close();
    const was = record(FILE, 'touch');
    assert.deepEqual(now, { same: true, columns: 2 });
    assert.deepEqual(now, was);
  }
});

test('no card\'s text is lifted onto a compositor layer while cards grow and trade places', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open(NEW);
  const cdp = await page.createCDPSession();
  await cdp.send('DOM.getDocument', { depth: -1 });
  let layers = [];
  cdp.on('LayerTree.layerTreeDidChange', (e) => { if (e.layers) layers = e.layers; });
  await cdp.send('LayerTree.enable');
  const textLayersDuring = async (ms) => {
    const seen = new Map();
    for (const end = Date.now() + ms; Date.now() < end; await sleep(8)) for (const l of layers) if (l.drawsContent && l.backendNodeId) seen.set(l.layerId, l.backendNodeId);
    const names = await Promise.all([...seen.values()].map(async (backendNodeId) => {
      const { node } = await cdp.send('DOM.describeNode', { backendNodeId });
      const at = node.attributes?.indexOf('class') ?? -1;
      const cls = at >= 0 ? node.attributes[at + 1] : '';
      return `${node.nodeName.toLowerCase()}${cls ? '.' + cls.split(' ')[0] : ''}`;
    }));
    // The page itself, the header, a card's quick actions (icons only, fading), and the hidden field a
    // drawn select keeps for a form (Base UI's: fixed, 1px, clipped, no text shown; the sort box's and
    // the page menu's).
    return names.filter((n) => !['#document', 'header', 'header.app-header', 'div.card-actions', 'input'].includes(n));
  };
  const A = await (await page.$('#grid > .card:nth-child(3)')).boundingBox();
  const B = await (await page.$('#grid > .card:nth-child(7)')).boundingBox();
  await page.mouse.move(A.x + A.width / 2, A.y + 60);
  assert.deepEqual(await textLayersDuring(250), [], 'while it grows');
  await page.mouse.move(A.x + A.width / 2, B.y + 300);
  assert.deepEqual(await textLayersDuring(250), [], 'while they trade places');
  await page.mouse.move(A.x + A.width / 2, A.y + 60);
  assert.deepEqual(await textLayersDuring(250), [], 'and back');
  assert.deepEqual(page.problems, []);
  await page.close();
});

test('leaving the page and coming back five times leaves nothing behind', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  // What is held, counted as it is taken and given back: listeners on the window and the document,
  // intervals and timers, observers, channels, object URLs.
  await page.evaluateOnNewDocument(() => {
    const held = window.__held = { listeners: 0, intervals: 0, observers: 0, channels: 0, urls: 0 };
    for (const target of [window, document]) {
      const add = target.addEventListener, remove = target.removeEventListener;
      const live = new Set();
      // (One added with a signal goes when the signal is aborted.)
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
  await until(page, () => document.querySelectorAll('#grid > .card img.card-thumb[src]').length === 9, null, { what: 'the page' });
  const counts = [];
  for (let i = 0; i < 6; i++) {
    await page.click('#settingsBtn');
    await until(page, () => location.pathname === '/settings' && !!document.getElementById('settingsNav'), null, { what: 'Settings' });
    await sleep(300);
    await page.evaluate(() => history.back());
    await until(page, (path) => location.pathname === path && document.querySelectorAll('#grid > .card img.card-thumb[src]').length === 9, NEW, { what: 'the library again' });
    await sleep(1200);
    counts.push(await page.evaluate(() => ({ ...window.__held, cards: document.querySelectorAll('.card').length, tips: document.querySelectorAll('.shiori-tip').length })));
  }
  // After the first return, nothing grows with each later one.
  assert.deepEqual(counts.slice(1), Array(5).fill(counts[0]), JSON.stringify(counts));
  assert.deepEqual(page.problems, []);
  await page.close();
});

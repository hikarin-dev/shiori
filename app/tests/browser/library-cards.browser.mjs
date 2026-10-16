// library-cards.browser.mjs — a library card growing while hovered, in Chrome. At rest a card shows
// two lines of its title and one row of its tags; hovered, it grows over the cards below to show
// all of both, animated, and nothing else moves — not even when it is alone in the last row. A
// card shrinking back stays drawn over the card the pointer moved to when it is the earlier of the
// two, and under it otherwise, above the resting cards either way. And no card's text is lifted
// onto a compositor layer while any of it animates: text there is antialiased differently.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await page.evaluate(seed);
  await page.close();
});

after(async () => {
  await browser?.close();
  server?.close();
});

// Runs in the page: nine galleries — two full rows of four and one alone — each with a title of
// several lines and thirty tags.
async function seed() {
  const api = await import('/app/js/api.js');
  const png = async (hue) => {
    const canvas = new OffscreenCanvas(300, 450);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `hsl(${hue} 60% 50%)`;
    ctx.fillRect(0, 0, 300, 450);
    return canvas.convertToBlob({ type: 'image/png' });
  };
  const tags = Array.from({ length: 30 }, (_, i) => ({ type: 'tag', name: `tag number ${i}`, url: '' }));
  for (let i = 0; i < 9; i++) {
    const gid = String(1790000000801 + i);
    await api.meta.put({ galleryId: gid, title: { english: `Card ${i} with a long title that runs over several lines of the card, far more than the two it shows at rest`, japanese: '', pretty: '' },
      tags, numPages: 1, addedAt: Date.now() - i * 1000 });
    await api.pages.put(gid, 1, await png(i * 40));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
// Which card (1-based) is drawn at a point.
const drawnAt = ({ x, y }) => {
  const card = document.elementFromPoint(x, y)?.closest('.card');
  return card ? [...document.querySelectorAll('.card')].indexOf(card) + 1 : null;
};

test('a hovered card grows over the cards below without moving anything, then shrinks back', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.setViewport({ width: 1280, height: 2400 });   // all three rows whole: four cards a row
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('.card img.card-thumb[src]').length === 9, null, { what: 'nine cards with covers' });
  await sleep(300);

  // What the compositor holds while things animate: any layer that isn't the page itself, the
  // header or a card's buttons (icons only) would be carrying a card's text.
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
    return names.filter((n) => !['#document', 'header', 'div.card-actions'].includes(n));
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

  // A change to a hovered card's gallery waits for it to shrink back before the card is made again.
  await page.evaluate(async () => (await import('/app/js/store.js')).mutate(document.querySelectorAll('.card')[2].dataset.galleryId, { favorite: true }, { touch: false }));
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

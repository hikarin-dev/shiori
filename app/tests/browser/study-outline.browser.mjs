// study-outline.browser.mjs — a study text's outline, in Chrome. It is the text again as SVG beneath
// the DOM text, with round joins, so a thick outline never covers a neighbouring line's glyphs (an
// HTML text stroke covered the line above with the line below's ring, and mitred corners into
// spikes). Its box is inert, so find-in-page finds the text once. It follows the page's zoom, waits
// for hidden text to be shown, and gets narrower strokes beneath when it is thick enough to fold open
// around dots and curls. And an original's emphasis group (!!, ??) paints in its face.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

// Runs in the page: a page-sized layer holding study texts built by the reader's own builders —
// red text on two lines with a thick outline in the page's own grey (so it shows only where it
// covers), a vertical original with furigana and a ?? group, and black text with its thin white halo —
// plus one hidden translation.
async function mount() {
  const study = await import('/app/js/reader-study.js');
  const layer = document.createElement('div');
  layer.className = 'bubble-layer';
  layer.style.setProperty('--pgscale', '1');
  const fg = layer.appendChild(document.createElement('div'));
  fg.className = 'bubble-fg';
  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';
  Object.assign(wrap.style, { position: 'fixed', left: '0', top: '0', width: '900px', height: '600px', zIndex: 1000, background: '#ccc' });
  wrap.appendChild(layer);
  document.body.appendChild(wrap);
  const box = (x, y, w, h) => ({ x: x / 900, y: y / 600, w: w / 900, h: h / 600 });
  const thick = study._buildStudyText({ tr: 'MANY\nVIVID WAYS', box: box(20, 20, 400, 200),
    style: { fg: [255, 0, 0], bg: [204, 204, 204], strokeWidth: 20, fontSize: 30 } }, true, 900);
  const original = study._buildStudySrc({ src: '悪いんだ\nから??', box: box(450, 20, 200, 300),
    furi: [[['悪', 'わる'], ['いんだ', '']], [['から??', '']]],
    style: { dir: 'v', fg: [0, 0, 0], bg: [255, 255, 255], strokeWidth: 6, srcFontSize: 40 } }, true, { w: 900 }, { furi: true, lang: 'ja' });
  const thin = study._buildStudyText({ tr: 'Thin halo', box: box(20, 300, 300, 80),
    style: { fg: [0, 0, 0], bg: [0, 0, 0], fontSize: 30 } }, true, 900);
  const hidden = study._buildStudyText({ tr: 'Later', box: box(20, 420, 300, 80),
    style: { fg: [0, 0, 0], bg: [255, 255, 255], strokeWidth: 4, fontSize: 30 } }, true, 900);
  hidden.style.display = 'none';
  thick.id = 'thick'; original.id = 'original'; thin.id = 'thin'; hidden.id = 'hidden';
  fg.append(thick, original, thin, hidden);
  await document.fonts.ready;
}

// Runs in the page: how many of a screenshot's pixels are the text's pure red.
async function redPixels(png) {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] < 25 && d[i + 2] < 25) n++;
  return n;
}

test('the outline is SVG text under the DOM text, with round joins, covering none of it', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/reader`, { waitUntil: 'load' });
  await page.evaluate(mount);
  await until(page, () => ['thick', 'original', 'thin'].every(id => document.querySelector(`#${id} > .study-outline`)),
    null, { what: 'the shown texts\' outlines' });

  const look = await page.evaluate(() => [...document.querySelectorAll('.study-text:not(#hidden)')].map(el => {
    const outline = el.firstElementChild, svg = outline.firstElementChild, cs = getComputedStyle(svg);
    return { id: el.id, first: outline.classList.contains('study-outline'), inert: outline.inert,
      domStroke: getComputedStyle(el).webkitTextStrokeWidth,
      join: cs.strokeLinejoin, stroke: cs.stroke, fill: cs.fill, width: parseFloat(svg.style.strokeWidth),
      runs: svg.querySelectorAll('text').length, narrower: svg.querySelectorAll('use').length };
  }));
  assert.deepEqual(look.map(l => [l.id, l.first, l.inert, l.domStroke, l.join]), [
    ['thick', true, true, '0px', 'round'], ['original', true, true, '0px', 'round'], ['thin', true, true, '0px', 'round']]);
  assert.deepEqual(look.map(l => [l.stroke, l.fill]), [['rgb(204, 204, 204)', 'rgb(204, 204, 204)'],
    ['rgb(255, 255, 255)', 'rgb(255, 255, 255)'], ['rgb(255, 255, 255)', 'rgb(255, 255, 255)']]);
  assert.deepEqual(look.map(l => [l.width, l.runs]), [[40, 2], [12, 5], [3, 1]],
    'the ring doubled into a stroke; a run per line, column, reading and group');
  // 20 px out on 30 px text is 6.7 tenths of an em: six narrower strokes beneath; a thin halo needs none.
  assert.deepEqual(look.map(l => l.narrower), [6, 1, 0]);

  // The outline, the page's grey, changes no pixel unless it covers text: the lower line's ring lies
  // under the upper line, not over it.
  const clip = await page.evaluate(() => { const r = document.getElementById('thick').getBoundingClientRect();
    return { x: r.x - 20, y: r.y - 20, width: r.width + 40, height: r.height + 40 }; });
  const withOutline = await page.evaluate(redPixels, await page.screenshot({ clip, encoding: 'base64' }));
  const hideOutline = await page.addStyleTag({ content: '.study-outline { visibility: hidden }' });
  const withoutOutline = await page.evaluate(redPixels, await page.screenshot({ clip, encoding: 'base64' }));
  assert.ok(withoutOutline > 1000, `the text is on screen (${withoutOutline} red pixels)`);
  assert.equal(withOutline, withoutOutline, 'the outline covers no text');
  await hideOutline.evaluate(tag => tag.remove());

  // The outline's copy of the text is out of find-in-page (window.find searches as it does): with
  // the text itself hidden, only the copy could be found — and it is once its box isn't inert.
  const find = () => page.evaluate(() => ['VIVID', 'いんだ', 'halo'].map(word => {
    getSelection().removeAllRanges();
    return window.find(word, false, false, true);
  }));
  await page.addStyleTag({ content: '.study-text-content { visibility: hidden }' });
  assert.deepEqual(await find(), [false, false, false], 'the outline\'s copy is not found');
  await page.evaluate(() => document.querySelectorAll('.study-outline').forEach(o => { o.inert = false; }));
  assert.deepEqual(await find(), [true, true, true], 'not inert, it would be');

  const problems = [...page.problems];
  await page.close();
  assert.deepEqual(problems, [], 'the page left nothing unhandled');
});

test('the outline follows the page\'s zoom and waits for hidden text to be shown', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/reader`, { waitUntil: 'load' });
  await page.evaluate(mount);
  await until(page, () => document.querySelector('#thick > .study-outline'), null, { what: 'the outline' });
  assert.equal(await page.evaluate(() => document.querySelector('#hidden > .study-outline')), null, 'hidden text has no outline yet');

  await page.evaluate(() => {
    document.querySelector('.bubble-layer').style.setProperty('--pgscale', '1.5');
    document.getElementById('hidden').style.display = '';
  });
  await until(page, () => parseFloat(document.querySelector('#thick > .study-outline > svg').style.strokeWidth) === 60,
    null, { what: 'the outline drawn again at the new zoom' });
  const fit = await page.evaluate(() => {
    const el = document.getElementById('thick'), r = el.getBoundingClientRect();
    return { viewBox: el.querySelector('.study-outline > svg').getAttribute('viewBox'), box: `0 0 ${r.width} ${r.height}`,
      shown: !!document.querySelector('#hidden > .study-outline') };
  });
  assert.equal(fit.viewBox, fit.box, 'the outline spans its text\'s box at the new size');
  assert.equal(fit.shown, true, 'shown text gets its outline');

  const problems = [...page.problems];
  await page.close();
  assert.deepEqual(problems, [], 'the page left nothing unhandled');
});

// Runs in the page: how many of a screenshot's pixels are dark, as black text is.
async function darkPixels(png) {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const ctx = new OffscreenCanvas(img.width, img.height).getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 240) n++;
  return n;
}

test('an emphasis group in the original\'s face paints in its column', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/reader`, { waitUntil: 'load' });
  await page.evaluate(mount);
  // Fitting ?? into one cell, Chrome asked Yasashisa Antique for half-width forms, which are blank
  // (Firefox did so for every pair, !! included).
  const clip = await page.evaluate(() => { const r = document.querySelector('#original .study-combined').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const dark = await page.evaluate(darkPixels, await page.screenshot({ clip, encoding: 'base64' }));
  assert.ok(dark > 40, `the ?? group is drawn (${dark} dark pixels in its cell)`);

  const problems = [...page.problems];
  await page.close();
  assert.deepEqual(problems, [], 'the page left nothing unhandled');
});

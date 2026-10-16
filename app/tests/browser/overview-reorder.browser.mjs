// overview-reorder.browser.mjs — reordering a series on its overview, in Chrome. The arrows and the
// grip's drag move rows in place: the rows, their thumbnails and the header are the same elements
// afterwards and no placeholder shows in between. The order is saved with the volumes keeping their
// places among the chapters, it survives a reload, and Escape puts a dragged row back.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const G = { a: '1790000000201', b: '1790000000202', c: '1790000000203', d: '1790000000204', v: '1790000000205' };

let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await page.evaluate(seed, G);
  await page.close();
});

after(async () => {
  await browser?.close();
  server?.close();
});

// Runs in the page: four chapters without numbers, each its own colour, and a volume among them.
async function seed(G) {
  const api = await import('/app/js/api.js');
  const png = async (hue) => {
    const canvas = new OffscreenCanvas(300, 450);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `hsl(${hue} 60% 50%)`;
    ctx.fillRect(0, 0, 300, 450);
    return canvas.convertToBlob({ type: 'image/png' });
  };
  const gallery = async (gid, name, hue, extra = {}) => {
    await api.meta.put({ galleryId: gid, title: { english: name, japanese: '', pretty: '' }, tags: [], numPages: 1, ...extra });
    await api.pages.put(gid, 1, await png(hue));
  };
  await gallery(G.a, 'Alpha', 0);
  await gallery(G.b, 'Bravo', 90);
  await gallery(G.c, 'Charlie', 180);
  await gallery(G.d, 'Delta', 270);
  await gallery(G.v, 'Volume', 45, { kind: 'volume' });
  await api.series.write(G.a, [{ id: G.a, title: '' }, { id: G.b, title: '' }, { id: G.v, title: '', kind: 'volume' },
    { id: G.c, title: '' }, { id: G.d, title: '' }], { seriesTitle: { english: 'Series', japanese: '', pretty: '' }, seriesTags: [] });
}

async function visit(t) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/overview.html?g=${G.a}`, { waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('.ch-row .ch-thumb img').length === 4 && document.querySelector('#seriesCover img'),
    null, { what: 'four rows with their thumbnails, and the cover' });
  return page;
}
async function finish(page) {
  await new Promise((r) => setTimeout(r, 300));
  const problems = [...page.problems];
  await page.close();
  assert.deepEqual(problems, [], 'the page left nothing unhandled');
}

// Marks what is on the page now and records, from here on, any placeholder put in and any row
// thumbnail taken out.
const watch = () => {
  window.__seen = [];
  document.querySelector('.ov-hero').__kept = true;
  for (const el of document.querySelectorAll('.ch-row, .ch-thumb img')) el.__kept = true;
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1 && (n.matches('.ph') || n.querySelector('.ph'))) window.__seen.push(`placeholder in ${r.target.className}`);
      for (const n of r.removedNodes) if (n.nodeType === 1 && n.matches('img') && r.target.matches('.ch-thumb')) window.__seen.push('a row thumbnail removed');
    }
  }).observe(document.getElementById('ovContent'), { childList: true, subtree: true });
};
const report = () => ({
  seen: window.__seen,
  heroKept: !!document.querySelector('.ov-hero').__kept,
  rowsKept: [...document.querySelectorAll('.ch-row')].every((r) => r.__kept),
  thumbsKept: [...document.querySelectorAll('.ch-thumb img')].every((img) => img.__kept),
});
const shown = () => [...document.querySelectorAll('.ch-row')].map((r) => r.dataset.chapterId);
const saved = async (gid) => {
  const api = await import('/app/js/api.js');
  return (await api.series.resolve(gid))?.chapters.map((c) => String(c.id)) || [];
};
const waitSaved = (page, order, what) =>
  until(page, async (o) => JSON.stringify(await (await import('/app/js/api.js')).series.resolve(o[0]).then((s) => s?.chapters.map((c) => String(c.id)))) === JSON.stringify(o), order, { what });

test('the arrows move a row in place and save the order', async (t) => {
  const page = await visit(t);
  if (!page) return;
  await page.evaluate(watch);
  await page.evaluate(() => document.querySelector('.ch-row [data-down]').click());
  await waitSaved(page, [G.b, G.a, G.v, G.c, G.d], 'the order saved, the volume in its place');
  await new Promise((r) => setTimeout(r, 600));   // the render after the save, and any change beacons
  assert.deepEqual(await page.evaluate(shown), [G.b, G.a, G.c, G.d]);
  assert.deepEqual(await page.evaluate(report), { seen: [], heroKept: true, rowsKept: true, thumbsKept: true });
  const state = await page.evaluate(() => ({
    nums: [...document.querySelectorAll('.ch-num')].map((n) => n.textContent),
    titles: [...document.querySelectorAll('.ch-title-input')].map((i) => i.value),
    ups: [...document.querySelectorAll('[data-up]')].map((b) => b.disabled),
    downs: [...document.querySelectorAll('[data-down]')].map((b) => b.disabled),
    heading: document.getElementById('seriesTitle')?.value,
    start: document.getElementById('readStart').getAttribute('href'),
  }));
  assert.deepEqual(state.nums, ['1', '2', '3', '4'], 'unnumbered chapters count by place');
  assert.deepEqual(state.titles, ['Bravo', 'Alpha', 'Charlie', 'Delta']);
  assert.deepEqual(state.ups, [true, false, false, false]);
  assert.deepEqual(state.downs, [false, false, false, true]);
  assert.equal(state.heading, 'Series', 'the title moves with the series to its new head');
  assert.match(state.start, new RegExp(`g=${G.b}$`), 'reading starts at the new first chapter');
  await finish(page);
});

test('the grip drags a row to a new place, and the order is saved', async (t) => {
  const page = await visit(t);
  if (!page) return;
  assert.deepEqual(await page.evaluate(shown), [G.b, G.a, G.c, G.d], 'the order the last test saved');
  await page.evaluate(watch);
  const box = async (sel) => page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, top: b.top }; }, sel);
  const grip = await box('.ch-row:nth-child(4) .ch-grip');
  const first = await box('.ch-row:nth-child(1)');
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x, first.y, { steps: 16 });
  await new Promise((r) => setTimeout(r, 250));
  const mid = await page.evaluate(() => ({
    order: [...document.querySelectorAll('.ch-row')].map((r) => r.dataset.chapterId),
    dragging: document.querySelector('.ch-row.dragging')?.dataset.chapterId,
    aside: [...document.querySelectorAll('.ch-row:not(.dragging)')].map((r) => r.style.transform),
  }));
  assert.deepEqual(mid.order, [G.b, G.a, G.c, G.d], 'nothing moves in the DOM until the drop');
  assert.equal(mid.dragging, G.d);
  assert.ok(mid.aside.every((tf) => /translateY\(\d/.test(tf)), `the rows it passed slid down (${mid.aside})`);
  await page.mouse.up();
  await waitSaved(page, [G.d, G.b, G.v, G.a, G.c], 'the dragged order saved');
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(await page.evaluate(shown), [G.d, G.b, G.a, G.c]);
  assert.deepEqual(await page.evaluate(report), { seen: [], heroKept: true, rowsKept: true, thumbsKept: true });
  assert.equal(await page.evaluate(() => !!document.querySelector('.ch-row.dragging, .ch-list.sorting, body.ch-dragging') || [...document.querySelectorAll('.ch-row')].some((r) => r.style.transform)), false, 'the drag left nothing behind');

  await page.reload({ waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('.ch-row').length === 4, null, { what: 'the rows after a reload' });
  assert.deepEqual(await page.evaluate(shown), [G.d, G.b, G.a, G.c]);
  await finish(page);
});

test('Escape puts a dragged row back', async (t) => {
  const page = await visit(t);
  if (!page) return;
  const before = await page.evaluate(shown);
  const grip = await page.evaluate(() => { const b = document.querySelector('.ch-row .ch-grip').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x, grip.y + 120, { steps: 10 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(await page.evaluate(shown), before);
  assert.deepEqual(await page.evaluate(saved, before[0]), [G.d, G.b, G.v, G.a, G.c]);
  await finish(page);
});

test('after an arrow click only the row under the pointer shows its buttons, Shift held or not', async (t) => {
  const page = await visit(t);
  if (!page) return;
  // Which rows show their buttons, and which row the pointer is over.
  const showing = (at) => {
    const under = document.elementFromPoint(at.x, at.y)?.closest('.ch-row')?.dataset.chapterId;
    const shown = [...document.querySelectorAll('.ch-row')].filter((r) => getComputedStyle(r.querySelector('.ch-actions')).opacity === '1').map((r) => r.dataset.chapterId);
    return { under, shown };
  };
  const up = await (await page.$('.ch-row:nth-child(3) [data-up]')).boundingBox();
  const at = { x: up.x + up.width / 2, y: up.y + up.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);   // the clicked row slides up, keeping its button's focus
  await new Promise((r) => setTimeout(r, 600));
  const after = await page.evaluate(showing, at);
  assert.deepEqual(after.shown, [after.under], 'only the hovered row');
  await page.keyboard.down('Shift');   // the quick-delete key
  await new Promise((r) => setTimeout(r, 100));
  const shifted = await page.evaluate(showing, at);
  await page.keyboard.up('Shift');
  assert.deepEqual(shifted.shown, [shifted.under], 'only the hovered row, Shift held');
  await finish(page);
});

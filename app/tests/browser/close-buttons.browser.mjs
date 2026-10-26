// close-buttons.browser.mjs — every dialog's close button, and the toast's, is the reader settings'
// X: the same box, frame, colour and glyph, so no corner of the app draws its own.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

const GID = '1790000000601';

let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/library.html`, { waitUntil: 'load' });
  await page.evaluate(async (gid) => {
    const api = await import('/app/js/api.js');
    const canvas = new OffscreenCanvas(300, 450);
    canvas.getContext('2d').fillRect(0, 0, 300, 450);
    await api.meta.put({ galleryId: gid, title: { english: 'Alpha', japanese: '', pretty: '' }, tags: [], numPages: 1 });
    await api.pages.put(gid, 1, await canvas.convertToBlob({ type: 'image/png' }));
  }, GID);
  await page.close();
});

after(async () => {
  await browser?.close();
  server?.close();
});

// Runs in the page: how a button looks at rest — its box, frame, colours and where its glyph sits.
function look(sel) {
  const b = document.querySelector(sel);
  const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
  const svg = b.querySelector('svg');
  const g = svg?.getBoundingClientRect();
  const gs = svg && getComputedStyle(svg);
  return { w: r.width, h: r.height, border: cs.borderTopWidth, radius: cs.borderRadius, background: cs.backgroundColor,
    color: cs.color, text: b.textContent.trim(),
    glyph: svg && { w: g.width, h: g.height, x: g.x - r.x, y: g.y - r.y, stroke: gs.stroke, strokeWidth: gs.strokeWidth, fill: gs.fill,
      paths: [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d')) } };
}

test('every close button is the reader settings\' X', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/app/reader.html?g=${GID}`, { waitUntil: 'load' });
  await until(page, () => document.getElementById('readerSettingsClose'), null, { what: 'the reader' });
  await page.evaluate(() => document.getElementById('readerSettingsModal').classList.add('show'));
  const model = await page.evaluate(look, '#readerSettingsClose');
  await page.evaluate(() => document.getElementById('readerSettingsModal').classList.remove('show'));
  assert.equal(model.w, 28);
  assert.ok(model.glyph, 'the model has an icon');

  await page.evaluate(async (gid) => {
    const m = await import('/app/js/reader-properties.js');
    m.openPageProperties({ gid, pageNum: 1, url: '', number: 1, total: 1, chapter: null });
  }, GID);
  await until(page, () => document.querySelector('.pp-head .icon-btn'), null, { what: 'page properties' });
  const got = { properties: await page.evaluate(look, '.pp-head .icon-btn') };
  await page.evaluate(() => document.querySelector('.pp-dialog').close());
  await page.evaluate(async () => (await import('/app/js/notice.js')).showToast({ text: 'Note', action: 'OK', onAction: () => {} }));
  got.toast = await page.evaluate(look, '.notice-toast .icon-btn');
  const problems = [...page.problems];
  await page.close();

  const settings = await openPage(browser, origin);
  await settings.goto(`${origin}/app/settings.html`, { waitUntil: 'load' });
  for (const [where, modal, button] of [['about', 'aboutModal', '#aboutClose'], ['translate', 'translateModal', '#translateClose']]) {
    await settings.evaluate((id) => document.getElementById(id).classList.add('show'), modal);
    got[where] = await settings.evaluate(look, button);
    await settings.evaluate((id) => document.getElementById(id).classList.remove('show'), modal);
  }
  problems.push(...settings.problems);
  await settings.close();

  for (const [where, button] of Object.entries(got)) assert.deepEqual(button, model, `the ${where} close button`);
  assert.deepEqual(problems, [], 'the pages left nothing unhandled');
});

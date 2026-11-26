// close-buttons.browser.mjs — every dialog's close button, and the toast's, is the reader settings'
// X: the same box, frame, colour and glyph, so no corner of the app draws its own. (Since 8e the reader's
// own dialogs left are reader settings and the keys; page properties is the app's Dialog, whose corner X
// ui-dialog.browser holds, and the reader's notices are the one page's toast.)
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
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
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
  await page.goto(`${origin}/reader?g=${GID}`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('readerSettingsBtn'), null, { what: 'the reader' });
  // (Reader settings are the app's Dialog since 8f: their X is the Dialog's corner X.)
  await page.evaluate(() => (document.body.classList.contains('reader-side-nav') ? document.getElementById('snSettings') : document.getElementById('readerSettingsBtn')).click());
  await until(page, () => !!document.getElementById('readerSettingsClose'), null, { what: 'reader settings' });
  const model = await page.evaluate(look, '#readerSettingsClose');
  await page.keyboard.press('Escape');
  assert.equal(model.w, 28);
  assert.ok(model.glyph, 'the model has an icon');

  // (Page properties is the app's Dialog since 8e, its corner X held by ui-dialog.browser.)
  const got = {};
  await page.evaluate(async () => (await import('/app/js/notice.js')).showToast({ text: 'Note', action: 'OK', onAction: () => {} }));
  // The reader drawn by the one page: its notices are the one page's (its Toast, whose close button
  // ui-toast.browser holds), not notice.js's own (plans: F77).
  await until(page, () => !!document.querySelector('[data-slot="toast"] button'), null, { what: 'the one page\'s toast' });
  assert.equal(await page.$('.notice-toast'), null, 'notice.js draws no toast of its own there');
  const problems = [...page.problems];
  await page.close();
  // (Settings' dialogs are the app's Dialog, its corner X held by ui-dialog.browser.)

  for (const [where, button] of Object.entries(got)) assert.deepEqual(button, model, `the ${where} close button`);
  assert.deepEqual(problems, [], 'the pages left nothing unhandled');
});

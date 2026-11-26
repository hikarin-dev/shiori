// ui-notice.browser.mjs — notice.js through the notice host (src/lib/notice-store.ts,
// src/components/notice-host.tsx): on the one page each function is drawn with the app's Dialog and
// Toast and answers as notice.js's own drawing did (OK, Cancel, Escape, the backdrop, Enter in the
// prompt; ask() and the progress windows only by their buttons), focus starts where it did and goes
// back; an operation locks the page behind it; a notice opens over a page's dialog. On a page that
// is not React's, notice.js draws as it always has.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until, openPage } from './harness.mjs';
import { componentsPage } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function call(page, name) {
  await page.$eval(`[data-notice-call="${name}"]`, (el) => { el.scrollIntoView({ block: 'center' }); el.focus(); el.click(); });
  await page.waitForSelector('[data-notice]');
  await frame(page);
}
const answer = (page) => until(page, () => { const a = document.querySelector('[data-notice-answer]').textContent; return a && a !== '…' ? a : null; }, null, { what: 'the answer' });
const gone = (page) => until(page, () => !document.querySelector('[data-notice]'), null, { what: 'the notice gone' });
const focused = (page) => page.evaluate(() => { const a = document.activeElement; return a?.dataset.noticeCall ?? a?.textContent ?? a?.localName; });

test('confirm and alert: each way out, and where focus starts and goes back', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  // A danger: an alert dialog, Cancel focused first.
  await call(page, 'confirm');
  assert.deepEqual(await page.$eval('[data-notice]', (el) => [el.getAttribute('role'), document.activeElement.textContent, !!el.querySelector('[data-slot="notice-icon"]'), el.querySelector('[data-slot="dialog-title"]').textContent]), ['alertdialog', 'Cancel', true, 'Delete this gallery?']);
  await page.click('[data-notice] [data-variant="danger"]');
  assert.equal(await answer(page), 'true');
  assert.equal(await focused(page), 'confirm');
  for (const [how, expected] of [['Cancel', 'false'], ['Escape', 'false'], ['backdrop', 'false']]) {
    await call(page, 'confirm');
    if (how === 'Cancel') await page.click('[data-notice] [data-variant="outline"]');
    else if (how === 'Escape') await page.keyboard.press('Escape');
    else await page.mouse.click(10, 450);
    assert.equal(await answer(page), expected, how);
    await gone(page);
  }
  await call(page, 'alert');
  assert.equal(await page.$eval('[data-notice]', (el) => el.getAttribute('role')), 'alertdialog');
  assert.equal(await focused(page), 'OK');
  await page.keyboard.press('Escape');
  assert.equal(await answer(page), 'undefined');
  await call(page, 'alert');
  await page.keyboard.press('Enter');
  assert.equal(await answer(page), 'true');
  assert.deepEqual(page.problems, []);
});

test('prompt, choice and toggle: their answers, and null for every cancel', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  // The prompt: its text chosen, Enter takes it trimmed.
  await call(page, 'prompt');
  assert.deepEqual(await page.evaluate(() => { const f = document.activeElement; return [f.dataset.slot, f.selectionStart, f.selectionEnd, f.value.length]; }), ['input', 0, 13, 13]);
  await page.keyboard.type('  Tide  ');
  await page.keyboard.press('Enter');
  assert.equal(await answer(page), '"Tide"');
  await call(page, 'prompt');
  await page.keyboard.press('Escape');
  assert.equal(await answer(page), 'null');
  // A choice: the radio cards and a check.
  await call(page, 'choice');
  await page.click('[data-notice] [data-slot="option-card"]:nth-child(2)');
  await page.click('[data-notice] [data-slot="checkbox"]');
  await page.click('[data-notice] [data-variant="primary"]');
  assert.equal(await answer(page), '{"value":"cbz","checks":{"remember":true}}');
  await call(page, 'choice');
  await page.mouse.click(10, 450);
  assert.equal(await answer(page), 'null');
  // A toggle: turning it on asks first, over it; while that question is open the toggle takes no
  // Escape. Turned down, the switch stays off.
  await call(page, 'toggle');
  await page.click('[data-notice] [role="switch"]');
  await until(page, () => document.querySelectorAll('[data-notice]').length === 2 && [...document.querySelectorAll('[data-notice]')].at(-1).contains(document.activeElement), null, { what: 'the confirm over the toggle, focused' });
  await page.keyboard.press('Escape');
  await until(page, () => document.querySelectorAll('[data-notice]').length === 1, null, { what: 'the confirm gone' });
  assert.equal(await page.$eval('[data-notice] [role="switch"]', (el) => el.getAttribute('aria-checked')), 'false');
  // Turned on and confirmed: the choice beside it opens up, the answer carries both.
  await page.click('[data-notice] [role="switch"]');
  await until(page, () => document.querySelectorAll('[data-notice]').length === 2, null, { what: 'the confirm over the toggle' });
  await page.evaluate(() => [...document.querySelectorAll('[data-notice]')].at(-1).querySelector('[data-variant="primary"]').click());
  await until(page, () => document.querySelectorAll('[data-notice]').length === 1, null, { what: 'the confirm gone' });
  await page.click('[data-notice] [data-variant="primary"]');
  assert.equal(await answer(page), '{"toggle":true,"option":"zip"}');
  assert.deepEqual(page.problems, []);
});

test('ask and the progress windows: only their own buttons end them; an operation locks the page', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await call(page, 'ask');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.slot), 'option-card');
  await page.keyboard.press('Escape');
  await page.mouse.click(10, 450);
  await frame(page);
  assert.ok(await page.$('[data-notice="ask"]'), 'still asking');
  await page.click('[data-notice] [data-slot="option-card"]:nth-child(2)');
  assert.equal(await answer(page), '"browser"');

  await call(page, 'progress');
  await page.keyboard.press('Escape');
  await page.mouse.click(10, 450);
  assert.ok(await page.$('[data-notice="progress"]'), 'still in progress');
  assert.ok(await page.$eval('[data-notice] [data-slot="progress"]', (el) => +el.getAttribute('aria-valuenow') >= 0));
  await page.click('[data-notice-stop]');
  assert.equal(await answer(page), '"stopped"');

  await call(page, 'operation');
  // Everything already on the page is inert; a key does nothing there; the box keeps focus.
  assert.deepEqual(await page.evaluate(() => [document.getElementById('root').inert, document.activeElement?.hasAttribute('data-notice-stop')]), [true, true]);
  const scrolled = await page.evaluate(() => scrollY);
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await frame(page);
  assert.equal(await page.evaluate(() => scrollY), scrolled);
  assert.ok(await page.evaluate(() => document.querySelector('[data-notice="operation"]').contains(document.activeElement)));
  await page.keyboard.press('Enter');
  assert.equal(await answer(page), '"stopped"');
  assert.equal(await page.evaluate(() => document.getElementById('root').inert), false);
  assert.deepEqual(page.problems, []);
});

test('the toast, and a notice over a page\'s dialog', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await page.$eval('[data-notice-call="toast"]', (el) => el.click());
  const toast = '[data-notice-toast] [data-slot="toast"]';
  await page.waitForSelector(toast);
  assert.equal(await page.$eval('[data-notice-toast]', (el) => el.getAttribute('role')), 'status');
  await page.click(`${toast} [data-variant="primary"]`);
  assert.equal(await page.$eval(`${toast} [data-variant="primary"]`, (el) => el.textContent), 'Updating…');
  // A second one replaces it (one at a time); its close.
  await page.$eval('[data-notice-call="toast"]', (el) => el.click());
  await until(page, (sel) => document.querySelectorAll(sel).length === 1 && !!document.querySelector(`${sel} [data-variant="ghost"]`), toast, { what: 'a fresh toast' });
  await page.click(`${toast} [data-variant="ghost"]`);
  assert.equal(await page.$(toast), null);

  await page.$eval('[data-notice-open="dialog"]', (el) => { el.scrollIntoView({ block: 'center' }); el.click(); });
  await page.waitForSelector('[data-notice-page-dialog]');
  await page.click('[data-notice-page-dialog] [data-notice-call="over"]');
  await page.waitForSelector('[data-notice]');
  const backdrops = await page.evaluate(() => [...document.querySelectorAll('[data-slot="dialog-backdrop"]')].map((b) => getComputedStyle(b).zIndex));
  assert.deepEqual(backdrops, ['400', '10001']);
  await frame(page);
  await page.keyboard.press('Escape');
  assert.equal(await answer(page), 'false');
  await gone(page);
  assert.ok(await page.$('[data-notice-page-dialog]'), 'the page dialog stays');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.noticeCall), 'over');
  await page.keyboard.press('Escape');
  await until(page, () => !document.querySelector('[data-notice-page-dialog]'), null, { what: 'the page dialog closed' });
  assert.deepEqual(page.problems, []);
});

test('a page that is not React\'s: notice.js draws its own', async (t) => {
  if (!browser) { t.skip('Chrome not found'); return; }
  // The reader's own page, whichever draws the reader in the other tests (READER_ROUTE): it is the page
  // with a file of its own, where notice.js draws by itself (on the route the one page's notice host
  // draws, as ui-notice's other tests hold).
  const page = await openPage(browser, origin, { route: false });
  t.after(() => page.close());
  await page.goto(`${origin}/reader`, { waitUntil: 'load' });
  await page.evaluate(() => { import('/app/js/notice.js').then((n) => n.confirmDialog({ title: 'Stop?' }).then((a) => { window.__answer = a; })); });
  await page.waitForSelector('.notice-overlay .notice-modal.notice-dialog');
  assert.equal(await page.$('[data-slot="dialog"]'), null);
  await page.keyboard.press('Escape');
  await until(page, () => window.__answer === false, null, { what: 'its answer' });
  assert.deepEqual(page.problems, []);
});

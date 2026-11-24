// ui-toast.browser.mjs — Toast (src/components/ui/toast.tsx) as /components shows it: the update
// toast at 1.3's size, 22px over the window's bottom and centred by layout, its action going busy, its
// close; the reader's status pill 28px over the bottom, going 3.5s after it was said (a busy one
// staying), by its colours; both in a polite status region that is there before they are.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { componentsPage, spec, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('the toast: 1.3\'s size, its place, busy, closed', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const look = await page.$eval(spec('notice-toast', 'action'), (el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const close = el.querySelector('[data-variant="ghost"]');
    return [+r.height.toFixed(2), s.padding, s.borderTopLeftRadius, s.fontSize, s.lineHeight, s.gap, close.getAttribute('aria-label'), close.getBoundingClientRect().width, close.querySelector('svg').getBoundingClientRect().width];
  });
  assert.deepEqual(look, [58, '10px 10px 10px 16px', '10px', '12.5px', '17.5px', '12px', 'Later', 28, 15]);
  // The region is there, empty, before any toast.
  const region = '[data-specimen-region="toast"]';
  assert.deepEqual(await page.$eval(region, (el) => [el.getAttribute('role'), el.getAttribute('aria-live'), el.children.length]), ['status', 'polite', 0]);
  await page.click('[data-specimen-open="toast"]');
  const placed = await page.$eval(`${region} [data-slot="toast"]`, (el) => {
    const r = el.getBoundingClientRect();
    return [innerHeight - r.bottom, Math.abs((r.left + r.right) / 2 - document.documentElement.clientWidth / 2) < 0.01, getComputedStyle(el).transform, getComputedStyle(el.parentElement).zIndex];
  });
  assert.deepEqual(placed, [22, true, 'none', '10000']);
  // The page's scrollbar going moves it not at all (rule 12; 1.3's moved by half the bar).
  const left = () => page.$eval(`${region} [data-slot="toast"]`, (el) => el.getBoundingClientRect().left);
  const at = await left();
  await page.evaluate(() => { document.documentElement.style.overflow = 'hidden'; });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.equal(await left(), at);
  await page.evaluate(() => { document.documentElement.style.overflow = ''; });
  // Its action: busy, the close gone.
  await page.click(`${region} [data-variant="primary"]`);
  assert.deepEqual(await page.$eval(`${region} [data-slot="toast"]`, (el) => [el.querySelector('[data-variant="primary"]').disabled, el.querySelector('[data-variant="primary"]').textContent, !!el.querySelector('[data-variant="ghost"]')]), [true, 'Updating…', false]);
  // A new one; its close.
  await page.$eval('[data-specimen-open="toast"]', (el) => el.click());
  await page.click(`${region} [data-variant="ghost"]`);
  assert.equal(await page.$eval(region, (el) => el.children.length), 0);
  assert.deepEqual(page.problems, []);
});

test('the status pill: its look, its place, gone after 3.5s by its colours, a busy one staying', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const pill = spec('page-status', 'status');
  assert.deepEqual(await page.$eval(pill, (el) => { const s = getComputedStyle(el); return [s.padding, s.borderTopLeftRadius, s.fontSize, s.borderTopColor]; }), ['8px 14px', '999px', '12px', 'rgb(42, 42, 48)']);
  assert.equal(await page.$eval(spec('page-status', 'error'), (el) => getComputedStyle(el).borderTopColor), 'rgb(237, 39, 84)');
  assert.equal(await page.$eval(spec('page-status', 'busy'), (el) => getComputedStyle(el.querySelector('[data-slot="spinner"]')).width), '13px');
  const live = '[data-slot="toast-region"]:has([data-slot="status-pill"]):not(:has([data-specimen]))';
  const state = () => page.$eval(`${live} [data-slot="status-pill"]`, (el) => [el.hasAttribute('data-shown'), getComputedStyle(el).color, innerHeight - el.getBoundingClientRect().bottom]);
  assert.equal((await state())[0], false);
  await page.$eval('[data-specimen-open="status"]', (el) => el.click());
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await state(), [true, 'rgb(244, 244, 245)', 28]);
  await new Promise((r) => setTimeout(r, 3500));
  assert.deepEqual((await state()).slice(0, 2), [false, 'rgba(0, 0, 0, 0)']);
  // Busy: it stays past 3.5s.
  await page.$eval('[data-specimen-open="status-busy"]', (el) => el.click());
  await new Promise((r) => setTimeout(r, 3800));
  assert.equal((await state())[0], true);
  assert.deepEqual(await textMotion(page, '[data-section="toast"]'), []);
  assert.deepEqual(page.problems, []);
});

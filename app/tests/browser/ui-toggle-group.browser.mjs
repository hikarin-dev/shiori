// ui-toggle-group.browser.mjs — ToggleGroup (src/components/ui/toggle-group.tsx) as /components shows
// it: each choice a toggle button with its pressed state; the arrows move between them, Space and
// Enter choose, pressing the chosen one keeps it; the segmented highlight sits exactly under the
// chosen segment, slides there by `left` (no transform: nothing holding text goes onto a layer of its
// own) and follows a resize at once, without gliding; no box moves when the choice changes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const DEMO = '[data-seg-demo]';
const read = (page) => page.$eval(DEMO, (g) => {
  const items = [...g.querySelectorAll('[data-slot="toggle-group-item"]')];
  const hl = g.querySelector('[data-slot="toggle-group-highlight"]').getBoundingClientRect();
  const on = items.find((b) => b.getAttribute('aria-pressed') === 'true');
  const r = on?.getBoundingClientRect();
  return { pressed: items.map((b) => b.getAttribute('aria-pressed')), focused: items.indexOf(document.activeElement),
    highlight: [hl.left, hl.top, hl.width, hl.height], under: r ? [r.left, r.top, r.width, r.height] : null,
    items: items.map((b) => { const x = b.getBoundingClientRect(); return [x.left, x.width]; }) };
});
const settled = (page) => page.evaluate(() => new Promise((done) => setTimeout(done, 400)));

test('segmented: pressed state, arrows and Space, the chosen one kept, the highlight under it', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  let s = await read(page);
  assert.deepEqual(s.pressed, ['true', 'false']);
  assert.deepEqual(s.highlight, s.under, 'the highlight is exactly the chosen segment');
  const items = s.items;
  // Tab into the group, the arrow to the next one, Space chooses it.
  await page.evaluate((sel) => { const b = document.createElement('button'); b.id = 'before'; document.querySelector(sel).before(b); b.focus(); }, DEMO);
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowRight');
  assert.equal((await read(page)).focused, 1);
  await page.keyboard.press('Space');
  await settled(page);
  s = await read(page);
  assert.deepEqual(s.pressed, ['false', 'true']);
  assert.deepEqual(s.highlight, s.under, 'it slid under the chosen one');
  assert.deepEqual(s.items, items, 'no segment moved or resized');
  // Pressing the chosen one again keeps it chosen.
  await page.keyboard.press('Enter');
  assert.deepEqual((await read(page)).pressed, ['false', 'true']);
  // A click on the first.
  const at = await centreOf(page, `${DEMO} [data-slot="toggle-group-item"]`);
  await page.mouse.click(at.x, at.y);
  await settled(page);
  s = await read(page);
  assert.deepEqual([s.pressed, s.highlight], [['true', 'false'], s.under]);
  assert.deepEqual(page.problems, []);
});

test('segmented: the highlight moves by left, not by a transform, and a resize moves it with the track at once', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const motion = await page.$eval(`${DEMO} [data-slot="toggle-group-highlight"]`, (el) => { const s = getComputedStyle(el); return [s.transitionProperty, s.transform]; });
  assert.deepEqual(motion, ['left', 'none']);
  // Mid-slide, a frame later, it is between the two places and the labels are on no layer of their own.
  await page.$eval(`${DEMO} [data-slot="toggle-group-item"]:last-of-type`, (b) => b.click());
  const mid = await page.evaluate((sel) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const hl = document.querySelector(`${sel} [data-slot="toggle-group-highlight"]`);
    done({ running: hl.getAnimations().length, left: hl.getBoundingClientRect().left });
  }))), DEMO);
  assert.equal(mid.running, 1, 'it slides');
  await settled(page);
  // The window narrows: the track is narrower (it is a fraction of its place), the highlight follows in
  // the very next frame with nothing running.
  await page.$eval(DEMO, (g) => { g.style.width = '200px'; });
  const after = await page.evaluate((sel) => new Promise((done) => requestAnimationFrame(() => {
    const g = document.querySelector(sel), hl = g.querySelector('[data-slot="toggle-group-highlight"]');
    const on = g.querySelector('[aria-pressed="true"]').getBoundingClientRect(), h = hl.getBoundingClientRect();
    done({ running: hl.getAnimations().length, same: [h.left, h.width].join() === [on.left, on.width].join() });
  })), DEMO);
  assert.deepEqual(after, { running: 0, same: true });
  assert.deepEqual(await textMotion(page, '[data-section="toggle-group"]'), []);
});

test('cards and pills: one chosen, Space chooses, the chosen look by pressed state', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await page.$eval('[data-section="toggle-group"] [data-slot="toggle-group"][data-variant="pill"]', (g) => { g.id = 'pills'; });
  const group = '#pills';
  const pressed = () => page.$$eval(`${group} [data-slot="toggle-group-item"]`, (bs) => bs.map((b) => b.getAttribute('aria-pressed')));
  const before = await pressed();
  await page.focus(`${group} [data-slot="toggle-group-item"]:last-child`);
  await page.keyboard.press('Space');
  const now = await pressed();
  assert.equal(now.filter((p) => p === 'true').length, 1);
  assert.equal(now.at(-1), 'true');
  assert.notDeepEqual(now, before);
  await settled(page);
  const look = await page.$eval(`${group} [aria-pressed="true"]`, (b) => getComputedStyle(b).backgroundColor);
  assert.equal(look, 'rgb(28, 28, 33)', 'the chosen pill on the raised surface');
});

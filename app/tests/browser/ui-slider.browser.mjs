// ui-slider.browser.mjs — Slider (src/components/ui/slider.tsx) as /components shows it: a slider by
// role and value; the arrows, Page Up and Down, Home and End move it; a press on the track moves the
// knob there; the knob keeps inside the track's ends; the keyboard ring on the knob, after a key only;
// a disabled one does not move.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, spec } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const DEMO = '[data-slider-demo]';
const value = (page) => page.$eval(`${DEMO} input[type="range"]`, (i) => [i.getAttribute('aria-valuenow') ?? i.value, i.getAttribute('aria-label')]);

test('a slider: the keys move it, a press on the track moves it there, the knob inside the ends', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  assert.deepEqual(await value(page), ['12', 'Gap']);
  await page.focus(`${DEMO} input[type="range"]`);
  const ring = await page.$eval(`${DEMO} [data-slot="slider-thumb"]`, (k) => getComputedStyle(k).outlineStyle);
  assert.equal(ring, 'solid', 'the keyboard ring on the knob');
  await page.keyboard.press('ArrowRight');
  assert.equal((await value(page))[0], '13');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  assert.equal((await value(page))[0], '11');
  await page.keyboard.press('Home');
  assert.equal((await value(page))[0], '0');
  await page.keyboard.press('End');
  assert.equal((await value(page))[0], '30');
  assert.equal(await page.$eval(`${DEMO} + output`, (o) => o.textContent), '30', 'the page hears of it');
  // The knob at each end sits inside the track: its edges on the track's.
  const ends = await page.$$eval('[data-section="slider"] [data-slot="slider-track"]', (tracks) => tracks.map((tr) => {
    const t = tr.getBoundingClientRect(), k = tr.querySelector('[data-slot="slider-thumb"]').getBoundingClientRect();
    return [+(k.left - t.left).toFixed(2), +(t.right - k.right).toFixed(2), +(k.top + k.height / 2 - (t.top + t.height / 2)).toFixed(2)];
  }));
  assert.ok(ends.some(([l]) => l === 0), 'at 0 the knob\'s left edge on the track\'s');
  assert.ok(ends.some(([, r]) => r === 0), 'at the most the knob\'s right edge on the track\'s');
  for (const [, , dy] of ends) assert.equal(dy, 0, 'the knob centred on the track');
  // A press a quarter along the track (from no focus: a press on what the keyboard focused keeps Chrome's keyboard focus).
  await page.evaluate(() => document.activeElement.blur());
  const at = await page.$eval(`${DEMO} [data-slot="slider-control"]`, (c) => { const r = c.getBoundingClientRect(); return { x: r.left + 7 + (r.width - 14) * 0.25, y: r.top + r.height / 2 }; });
  await page.mouse.click(at.x, at.y);
  const now = Number((await value(page))[0]);
  assert.ok(Math.abs(now - 7.5) <= 1, `a press a quarter along: ${now}`);
  assert.equal(await page.$eval(`${DEMO} [data-slot="slider-thumb"]`, (k) => getComputedStyle(k).outlineStyle), 'none', 'no ring after a press');
  // Disabled: a press does nothing.
  const off = spec('rs-range', 'slider', 'disabled');
  const before = await page.$eval(`${off} input[type="range"]`, (i) => i.value);
  const d = await page.$eval(off, (c) => { c.scrollIntoView({ block: 'center' }); const r = c.getBoundingClientRect(); return { x: r.left + r.width * 0.9, y: r.top + r.height / 2 }; });
  await page.mouse.click(d.x, d.y);
  assert.equal(await page.$eval(`${off} input[type="range"]`, (i) => i.value), before);
  assert.deepEqual(page.problems, []);
});

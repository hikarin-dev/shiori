// ui-popover.browser.mjs — Popover (src/components/ui/popover.tsx) as /components shows it: the burger
// panel, the bar's ⋯ panel and the chapter list at 1.3's sizes with one floating shadow; and a working
// one, fixed to the window (the page neither lengthens nor gains a scrollbar), kept 8px inside it,
// placed in its first frame, closed by Escape (focus back on its button) or a press outside.
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

const SHADOW = 'rgba(0, 0, 0, 0.45) 0px 8px 24px 0px';
const shadowOf = (s) => s.boxShadow.split(/,(?![^(]*\))/).map((x) => x.trim()).filter((x) => x !== 'rgba(0, 0, 0, 0) 0px 0px 0px 0px').join(', ');

test('the panels: 1.3\'s sizes, one frame and shadow', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const look = (sel) => page.$eval(sel, (el, src) => { const s = getComputedStyle(el); const shadow = new Function('s', `return (${src})(s)`)(s); return [s.padding, s.gap, s.borderTopLeftRadius, s.borderTopColor, s.backgroundColor, shadow, el.getBoundingClientRect().height]; }, shadowOf.toString());
  assert.deepEqual(await look(spec('burger-pop', 'panel')), ['12px', '8px', '8px', 'rgb(42, 42, 48)', 'rgb(22, 22, 26)', SHADOW, 64]);
  assert.deepEqual((await look(spec('overflow-pop', 'panel'))).slice(0, 6), ['8px', '8px', '8px', 'rgb(42, 42, 48)', 'rgb(22, 22, 26)', SHADOW]);
  // The chapter list: its own width, radius and shadow; rows 35 tall; the one being read in the brand colour.
  const chapters = await page.$eval(spec('sn-chapters', 'chapters'), (el) => {
    const s = getComputedStyle(el), rows = [...el.querySelectorAll('[data-slot="popover-item"]')];
    const cur = el.querySelector('[data-current]');
    return [el.getBoundingClientRect().width, s.borderTopLeftRadius, rows.map((r) => r.getBoundingClientRect().height), getComputedStyle(cur).color, cur.getAttribute('aria-current'), rows.at(-1).disabled];
  });
  assert.deepEqual(chapters, [320, '12px', [35, 35, 35, 35], 'rgb(237, 39, 84)', 'true', true]);
  assert.deepEqual(await textMotion(page, '[data-section="popover"]'), []);
  assert.deepEqual(page.problems, []);
});

test('a working panel: fixed, inside the window, placed at once, closed by Escape or a press outside', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const trigger = '[data-specimen-open="popover"]';
  await page.$eval(trigger, (el) => el.scrollIntoView({ block: 'center' }));
  const pageBox = () => page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollHeight, scrollY]);
  const before = await pageBox();
  // Every frame from the press: the panel's place never changes once it shows.
  const frames = await page.evaluate((sel) => new Promise((resolve) => {
    const seen = [];
    const tick = () => {
      const el = document.querySelector('[data-specimen-popover]');
      if (el) { const r = el.getBoundingClientRect(); seen.push([r.left, r.top, r.width, r.height]); }
      if (seen.length < 10) requestAnimationFrame(tick); else resolve(seen);
    };
    document.querySelector(sel).click();
    requestAnimationFrame(tick);
  }), trigger);
  for (const f of frames) assert.deepEqual(f, frames[0]);
  assert.deepEqual(await pageBox(), before);
  const placed = await page.evaluate((sel) => {
    const p = document.querySelector('[data-specimen-popover]'), b = document.querySelector(sel).getBoundingClientRect(), r = p.getBoundingClientRect();
    return { fixed: getComputedStyle(p.parentElement).position, z: getComputedStyle(p.parentElement).zIndex, right: Math.abs(r.right - b.right) < 0.5 || innerWidth - r.right >= 8, inside: r.left >= 8 && r.top >= 8 && r.bottom <= innerHeight - 8 };
  }, trigger);
  assert.deepEqual(placed, { fixed: 'fixed', z: '900', right: true, inside: true });
  await page.keyboard.press('Escape');
  await until(page, () => !document.querySelector('[data-specimen-popover]'), null, { what: 'the panel closed' });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.specimenOpen), 'popover');
  await page.click(trigger);
  await page.waitForSelector('[data-specimen-popover]');
  await page.mouse.click(20, 300);
  await until(page, () => !document.querySelector('[data-specimen-popover]'), null, { what: 'the panel closed by a press outside' });
  assert.deepEqual(page.problems, []);
});

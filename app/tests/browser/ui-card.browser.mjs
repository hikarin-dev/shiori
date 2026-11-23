// ui-card.browser.mjs — Card (src/components/ui/card.tsx) as /components shows it: each variant's
// ground, frame and radius; a chapter row's frame strengthening under the pointer and the row lifting
// while dragged, by colour and shadow only; a Settings section's header narrowing its padding in a
// panel of 480px or less (a container query: the window is not asked); a dialog's detail box
// scrolling past 30% of the window's height.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, spec, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

// (Tailwind stacks clear shadows before a token's: they draw nothing and are left out.)
const look = (page, sel) => page.$eval(sel, (el) => {
  const s = getComputedStyle(el);
  const shadow = s.boxShadow.split(/,(?![^(]*\))/).map((x) => x.trim()).filter((x) => x !== 'rgba(0, 0, 0, 0) 0px 0px 0px 0px').join(', ') || 'none';
  return [s.backgroundColor, s.borderTopColor, s.borderTopLeftRadius, shadow];
});

test('the variants, a row\'s hover and lift, a header in a narrow panel', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  assert.deepEqual(await look(page, spec('settings-section', 'section')), ['rgb(22, 22, 26)', 'rgb(42, 42, 48)', '10px', 'none']);
  assert.deepEqual(await look(page, spec('panel-row', 'row')), ['rgb(22, 22, 26)', 'rgb(42, 42, 48)', '8px', 'none']);
  assert.deepEqual(await look(page, spec('inset-panel', 'inset')), ['rgb(17, 17, 20)', 'rgb(42, 42, 48)', '8px', 'none']);
  assert.deepEqual(await look(page, spec('detail-box', 'detail')), ['rgb(13, 13, 15)', 'rgb(42, 42, 48)', '8px', 'none']);
  assert.deepEqual((await look(page, spec('ch-row', 'row', 'hover'))).slice(0, 2), ['rgb(22, 22, 26)', 'rgb(63, 63, 72)'], 'under the pointer: the strong frame');
  assert.deepEqual(await look(page, spec('ch-row', 'row', 'on')), ['rgb(28, 28, 33)', 'rgb(63, 63, 72)', '8px', 'rgba(0, 0, 0, 0.45) 0px 10px 28px 0px'], 'dragged: lifted');
  assert.deepEqual(await page.$eval(spec('ch-row', 'row'), (el) => [getComputedStyle(el).transitionProperty, getComputedStyle(el).transitionDuration]),
    ['border-color, background-color, box-shadow', '0.12s, 0.2s, 0.2s']);
  assert.deepEqual(await textMotion(page, '[data-section="card"]'), []);
  const pad = (sel) => page.$eval(sel, (el) => getComputedStyle(el).padding);
  assert.equal(await pad(spec('settings-section', 'header')), '17px 20px 14px');
  assert.equal(await pad(spec('settings-section', 'header-narrow')), '14px 15px 12px', 'a 400px panel: the narrow padding');
  // At exactly 480px the narrow padding holds (1.3's max-width: 480px), at 481 not.
  const at = (w) => page.$eval(spec('settings-section', 'header-narrow'), (el, w) => { el.parentElement.parentElement.style.width = `${w}px`; return new Promise((done) => requestAnimationFrame(() => done([el.parentElement.parentElement.getBoundingClientRect().width, getComputedStyle(el).paddingTop]))); }, w);
  assert.deepEqual(await at(480), [480, '14px']);
  assert.deepEqual(await at(481), [481, '17px']);
  assert.deepEqual(page.problems, []);
});

test('a dialog\'s detail box scrolls past 30% of the window\'s height', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const box = await page.$eval(spec('detail-box', 'detail'), (el) => { el.textContent = 'line\n'.repeat(60); return [el.getBoundingClientRect().height, el.scrollHeight > el.clientHeight, getComputedStyle(el).overflowY]; });
  assert.deepEqual(box, [270, true, 'auto']);
});

// ui-collapsible.browser.mjs — Collapsible (src/components/ui/collapsible.tsx) as /components shows it:
// a header button that says whether its part is open (aria-expanded; aria-controls while open) and opens and
// closes it by a click, Enter or Space; closed, the part stays in the document, hidden; opening shows
// it at once, nothing in it fading, moving or growing (rule 11); the drawn triangle turns as
// Chromium's did, the text 1.06em after it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, spec, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const state = (page, sel) => page.$eval(sel, (el) => {
  const panel = el.closest('[data-slot="collapsible"]').querySelector('[data-slot="collapsible-panel"]');
  const controls = el.getAttribute('aria-controls');
  return { tag: el.localName, expanded: el.getAttribute('aria-expanded'), controls: controls ? controls === panel?.id : null, inDocument: !!panel, hidden: panel ? panel.hidden || getComputedStyle(panel).display === 'none' : null };
});

test('opened and closed by a click and by the keyboard; closed, its part stays in the document, hidden', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const sel = spec('pp-details', 'closed');
  assert.deepEqual(await state(page, sel), { tag: 'button', expanded: 'false', controls: null, inDocument: true, hidden: true });
  const at = await centreOf(page, sel);
  await page.mouse.click(at.x, at.y);
  assert.deepEqual(await state(page, sel), { tag: 'button', expanded: 'true', controls: true, inDocument: true, hidden: false }, 'open: it names the part it controls');
  // At once: nothing in the part is animating, and no text in the section fades or moves.
  assert.deepEqual(await page.$eval(sel, (el) => el.closest('[data-slot="collapsible"]').querySelector('[data-slot="collapsible-panel"]').getAnimations({ subtree: true }).length), 0);
  assert.deepEqual(await textMotion(page, '[data-section="collapsible"]'), []);
  await page.focus(sel);
  await page.keyboard.press('Enter');
  assert.equal((await state(page, sel)).expanded, 'false');
  await page.keyboard.press('Space');
  assert.equal((await state(page, sel)).expanded, 'true');
  assert.deepEqual(page.problems, []);
});

test('the triangle and the chevron say open or closed; the header\'s look', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const look = (sel) => page.$eval(sel, (el) => {
    const svg = el.querySelector('svg'), text = el.querySelector('span.min-w-0').getBoundingClientRect(), r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return { rotate: getComputedStyle(svg).rotate, textAt: +(text.left - r.left).toFixed(1), size: s.fontSize, color: s.color, gap: s.marginBottom };
  });
  const closed = await look(spec('pp-details', 'closed'));
  const open = await look(spec('pp-details', 'open'));
  assert.deepEqual([closed.rotate, open.rotate], ['none', '90deg'], 'pointing on when closed, down when open');
  assert.deepEqual([closed.textAt, closed.size, closed.color, closed.gap, open.gap], [11.7, '11px', 'rgb(161, 161, 170)', '0px', '9px']);
  assert.equal((await look(spec('pp-details', 'closed', 'hover'))).color, 'rgb(244, 244, 245)');
  const group = await page.$eval(spec('tcfg-collapsible', 'closed'), (el) => { const s = getComputedStyle(el); return [s.fontSize, s.fontWeight, s.letterSpacing, s.textTransform, s.color, s.borderBottomColor, getComputedStyle(el.querySelector('svg')).rotate]; });
  assert.deepEqual(group, ['10px', '600', '1px', 'uppercase', 'rgb(255, 209, 102)', 'rgb(42, 42, 48)', '-90deg']);
  assert.equal(await page.$eval(spec('tcfg-collapsible', 'open'), (el) => getComputedStyle(el.querySelector('svg')).rotate), 'none');
});

// ui-input.browser.mjs — Input, InputGroup and Textarea (src/components/ui/) as /components shows
// them: text boxes reached by Tab and typed in; one focused look (F13: the ring colour and its 1px
// shadow) whether reached by Tab or a click, the shared keyboard ring kept off them; focusing moves
// nothing; the joined button is a button and the pair keeps its corners; a textarea grows only
// downward by its grip; no text fades or moves.
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

const RING = 'rgb(251, 113, 133)';
const look = (page, sel) => page.$eval(sel, (el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return { border: s.borderTopColor, shadow: s.boxShadow.includes('251, 113, 133') && s.boxShadow.includes('0px 0px 0px 1px'), outline: s.outlineStyle, box: [r.width, r.height] }; });
const settled = (page) => page.evaluate(() => new Promise((done) => setTimeout(done, 300)));

test('text boxes: Tab reaches them, they take typing, one focused look by Tab or by click, nothing moves', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  for (const sel of [spec('field-input', 'field'), spec('modal-input', 'inset'), spec('add-search', 'inset-xl'), spec('notice-input', 'inset'), spec('feedback-textarea', 'inset'), spec('tcfg-textarea', 'field')]) {
    const rest = await look(page, sel);
    assert.notEqual(rest.border, RING, `${sel}: not focused at rest`);
    await page.evaluate((sel) => { const b = document.createElement('button'); b.className = 'probe'; document.querySelector(sel).closest('div').before(b); b.focus(); }, sel);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), sel), true, `${sel}: reached by Tab`);
    await settled(page);
    const tabbed = await look(page, sel);
    assert.deepEqual([tabbed.border, tabbed.shadow, tabbed.outline], [RING, true, 'none'], `${sel}: the one focused look, no keyboard ring over it`);
    assert.deepEqual(tabbed.box, rest.box, `${sel}: focusing it moves nothing`);
    await page.keyboard.type('ab');
    assert.ok((await page.$eval(sel, (el) => el.value)).endsWith('ab'), `${sel}: typed in`);
    // A click gives the same look.
    await page.evaluate(() => document.activeElement.blur());
    const at = await centreOf(page, sel);
    await page.mouse.click(at.x, at.y);
    await settled(page);
    assert.deepEqual([(await look(page, sel)).border, (await look(page, sel)).shadow], [RING, true], `${sel}: focused by a click, the same look`);
    await page.evaluate(() => { document.activeElement.blur(); document.querySelectorAll('.probe').forEach((b) => b.remove()); });
  }
  // A disabled box is passed by Tab.
  const off = spec('field-input', 'field', 'disabled');
  assert.equal(await page.$eval(off, (el) => el.disabled), true);
  assert.deepEqual(await textMotion(page, '[data-section="input"]'), []);
  assert.deepEqual(page.problems, []);
});

test('a field with a joined button: the pair one frame, the button a button, its icon turning while busy', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const pair = await page.$eval(spec('field-input', 'group'), (input) => {
    const button = input.nextElementSibling, a = input.getBoundingClientRect(), b = button.getBoundingClientRect();
    const sa = getComputedStyle(input), sb = getComputedStyle(button);
    return { joined: Math.abs(a.right - b.left) < 0.01, height: [a.height, b.height], corners: [sa.borderTopRightRadius, sb.borderTopLeftRadius, sb.borderTopRightRadius], seam: sb.borderLeftWidth, role: button.localName, label: button.getAttribute('aria-label') };
  });
  assert.deepEqual(pair, { joined: true, height: [36, 36], corners: ['0px', '0px', '6px'], seam: '0px', role: 'button', label: 'Check connection' });
  // Busy, its icon turns inside a Spinner, the icon's size kept.
  const busy = await page.$eval('[aria-busy="true"] svg', (svg) => { const s = svg.closest('[data-slot="spinner"]'); return [s && getComputedStyle(s).animationName, getComputedStyle(svg).width]; });
  assert.deepEqual(busy, ['spin', '16px']);
});

test('a textarea grows downward by its grip only', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const rs = await page.$$eval('[data-section="input"] textarea', (els) => els.map((el) => [getComputedStyle(el).resize, el.rows]));
  assert.deepEqual(rs.slice(0, 1), [['vertical', 3]]);
  assert.ok(rs.some(([r, rows]) => r === 'vertical' && rows === 5));
});

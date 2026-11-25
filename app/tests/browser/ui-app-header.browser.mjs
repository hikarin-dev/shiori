// ui-app-header.browser.mjs — AppHeader (src/components/ui/app-header.tsx, styles/frame.css) as
// /components shows it: 1.3's band (54px, 20px in, 16 between its parts, 10 in the left, 8 in the
// right, sticky on the header's layer), the "/" and the page menu placed as 1.3's, Settings' form
// (its parts held apart, its taller line, 12px in at 520px or less) opaque by default and 1.3's
// see-through blur one prop away (F33), and the frame the route draws still index.html's own markup.
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

const look = (page, sel) => page.$eval(sel, (el) => {
  const s = getComputedStyle(el), r = el.getBoundingClientRect();
  const at = (q) => { const p = el.querySelector(q)?.getBoundingClientRect(); return p && [+(p.left - r.left).toFixed(2), +(p.top - r.top).toFixed(2), +p.width.toFixed(2), +p.height.toFixed(2)]; };
  return {
    height: r.height, position: s.position, z: s.zIndex, padding: s.padding, gap: s.gap, justify: s.justifyContent, line: s.lineHeight,
    ground: s.backgroundColor, blur: s.backdropFilter, rule: `${s.borderBottomWidth} ${s.borderBottomColor}`,
    leftGap: getComputedStyle(el.querySelector('.header-left')).gap, rightGap: el.querySelector('.header-right') && getComputedStyle(el.querySelector('.header-right')).gap,
    brand: at('.brand-wrap'), text: at('.brand-text'), sep: at('.brand-sep'), menu: at('.page-nav'),
    sepColour: el.querySelector('.brand-sep') && getComputedStyle(el.querySelector('.brand-sep')).color,
  };
});

test('the page header: 1.3\'s band, brand, "/" and page menu, its right part', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const tasks = await look(page, spec('app-header', 'default'));
  assert.deepEqual([tasks.height, tasks.position, tasks.z, tasks.padding, tasks.gap, tasks.leftGap, tasks.rightGap], [54, 'sticky', '30', '0px 20px', '16px', '10px', '8px']);
  assert.deepEqual([tasks.ground, tasks.rule, tasks.line], ['rgb(22, 22, 26)', '1px rgb(42, 42, 48)', 'normal']);
  // Where 1.3's Tasks header has them (baseline: desktop/tasks-rows).
  assert.deepEqual(tasks.brand, [20, 14.5, 84.2, 24]);
  assert.deepEqual(tasks.sep, [114.2, 18, 7.81, 17]);
  assert.deepEqual([tasks.menu[0], tasks.menu[1], tasks.menu[3]], [127.02, 13.5, 26], 'the page menu 5px into the gap, 26 tall, centred');
  assert.equal(tasks.sepColour, 'rgb(63, 63, 72)');
  // The frame alone is index.html's markup to the letter.
  assert.equal(await page.$eval(spec('app-header', 'frame'), (el) => { const c = el.cloneNode(true); for (const a of [...c.attributes]) if (a.name !== 'class') c.removeAttribute(a.name); return c.outerHTML; }),
    await page.$eval('#root > header', (el) => el.outerHTML));
  assert.deepEqual(await textMotion(page, '[data-section="header"]'), []);
  assert.deepEqual(page.problems, []);
});

test('Settings\' header: the common one, opaque by default (F33) and 1.3\'s blur one prop away', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const opaque = await look(page, spec('settings-header', 'opaque'));
  const glass = await look(page, spec('settings-header', 'translucent'));
  // No form of its own: the line, the sides and the brand's line are every page's (1.3's Settings page
  // had space-between, a 1.5 line and the brand on 1.2, which moved the header's words by a fraction of
  // a pixel when the page changed).
  const common = await look(page, spec('app-header', 'default'));
  assert.deepEqual([opaque.justify, opaque.line, opaque.padding, opaque.text], [common.justify, common.line, common.padding, common.text], 'as the page header');
  assert.equal(opaque.text[3], 20, 'the brand on its 20px line');
  assert.deepEqual([opaque.ground, opaque.blur], ['rgb(22, 22, 26)', 'none']);
  assert.deepEqual([glass.ground, glass.blur], ['color(srgb 0.0862745 0.0862745 0.101961 / 0.94)', 'blur(10px)']);
  assert.deepEqual(opaque.brand, glass.brand);
  assert.deepEqual(page.problems, []);
});

test('on a phone: the page header keeps its band, 12px in on every page', async (t) => {
  const page = await componentsPage(t, browser, origin, { width: 390, height: 844, isMobile: true, hasTouch: true });
  if (!page) return;
  const overview = await look(page, spec('app-header', 'overview'));
  assert.deepEqual([overview.height, overview.padding, overview.brand[0], overview.text[2]], [54, '0px 12px', 12, 52.2]);
  const settings = await look(page, spec('settings-header', 'opaque'));
  assert.deepEqual([settings.height, settings.padding, settings.brand[0]], [54, '0px 12px', 12]);
  // At 601px the desktop's 20 again (inclusive at 600, as the library's header was).
  await page.setViewport({ width: 601, height: 844, isMobile: true, hasTouch: true });
  for (const name of [['app-header', 'overview'], ['settings-header', 'opaque']]) assert.equal((await look(page, spec(...name))).padding, '0px 20px');
  await page.setViewport({ width: 600, height: 844, isMobile: true, hasTouch: true });
  for (const name of [['app-header', 'overview'], ['settings-header', 'opaque']]) assert.equal((await look(page, spec(...name))).padding, '0px 12px');
  assert.deepEqual(page.problems, []);
});

// ui-select.browser.mjs — Select (src/components/ui/select.tsx) as /components shows it: a combobox
// opening a listbox; Enter, Space and the arrows open it, move and choose, Escape closes it; the list
// hangs off the box at its width (placed by CSS anchoring) and stays on it in the very frame the page
// scrolls or the window changes; at most eight rows; it opens upward only when just the room above
// holds it; opening it moves nothing on the page; no text fades or moves; under a coarse pointer it
// is the system's select, drawn closed the same.
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

const FIELD = spec('select-field', 'field');
const settled = (page) => page.evaluate(() => new Promise((done) => setTimeout(done, 350)));
// The open list against its box, read in one frame.
const fit = (page, sel) => page.evaluate((sel) => {
  const box = document.querySelector(sel).getBoundingClientRect();
  const list = document.querySelector('[data-slot="select-list"][data-open]');
  if (!list) return null;
  const l = list.getBoundingClientRect();
  return { top: l.top - (box.bottom - 1), bottom: l.bottom - (box.top + 1), left: l.left - box.left, width: l.width - box.width, height: l.height, up: list.parentElement.hasAttribute('data-up') };
}, sel);

test('a combobox and its listbox: opened, moved through and chosen by the keyboard, closed by Escape', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await page.$eval(FIELD, (el) => el.scrollIntoView({ block: 'center' }));
  const aria = () => page.$eval(FIELD, (el) => [el.getAttribute('role'), el.getAttribute('aria-expanded'), el.textContent]);
  assert.deepEqual(await aria(), ['combobox', 'false', 'English']);
  await page.focus(FIELD);
  await page.keyboard.press('Enter');
  await settled(page);
  assert.equal((await aria())[1], 'true');
  const options = await page.$$eval('[data-slot="select-list"][data-open] [role="option"]', (os) => os.map((o) => [o.textContent, o.getAttribute('aria-selected')]));
  assert.equal(options.length, 12);
  assert.deepEqual(options[0], ['English', 'true']);
  assert.equal(await page.$eval('[data-slot="select-list"][data-open] [role="listbox"], [data-slot="select-list"][data-open][role="listbox"]', (l) => !!l), true, 'a listbox');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await settled(page);
  // Reached by the keyboard, an option shows it (the raised ground).
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).backgroundColor), 'rgb(28, 28, 33)');
  await page.keyboard.press('Enter');
  await settled(page);
  assert.deepEqual(await aria(), ['combobox', 'false', 'Deutsch']);
  // Space opens it too; Escape closes it and leaves the choice.
  await page.keyboard.press('Space');
  await settled(page);
  assert.equal((await aria())[1], 'true');
  await page.keyboard.press('Escape');
  await settled(page);
  assert.deepEqual(await aria(), ['combobox', 'false', 'Deutsch']);
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('role')), 'combobox', 'focus back on the box');
  assert.deepEqual(page.problems, []);
});

test('the list hangs off the box at its width, eight rows at most, and stays on it as the page scrolls and the window changes', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const at = await centreOf(page, FIELD);
  const before = await page.$$eval('[data-section="select"] [data-shape]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.height]; }));
  await page.mouse.click(at.x, at.y);
  await settled(page);
  const open = await fit(page, FIELD);
  assert.deepEqual([open.top, open.left, open.width, open.up], [0, 0, 0, false], 'under the box, its edge over the box\'s, as wide');
  assert.ok(Math.abs(open.height - (8 * 28.8 + 10)) < 0.5, `eight rows (${open.height})`);
  assert.equal(await page.$eval(FIELD, (el) => getComputedStyle(el.querySelector('svg')).rotate), '180deg', 'the chevron turned');
  const after = await page.$$eval('[data-section="select"] [data-shape]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.height]; }));
  assert.deepEqual(after, before, 'opening it moved nothing on the page');
  // Scrolled, then the very next frame painted: the list's seam right under the box's bottom edge and
  // its ground below. (Read in the picture: Chrome keeps an anchored box on its anchor through a
  // scroll as it paints, while its DOM box catches up a frame later.)
  const cdp = await page.createCDPSession();
  const column = async (x, y0, n) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    return page.evaluate(async (b64, x, y0, n) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      return [...Array(n).keys()].map((i) => [...g.getImageData(x, y0 + i, 1, 1).data].slice(0, 3).join());
    }, data, x, y0, n);
  };
  for (const dy of [40, -90, 7]) {
    await page.evaluate((dy) => scrollBy(0, dy), dy);
    const [x, bottom] = await page.$eval(FIELD, (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left + 40), Math.round(r.bottom)]; });
    const px = await column(x, bottom - 1, 4);
    assert.deepEqual(px, ['42,42,48', '17,17,20', '17,17,20', '17,17,20'], `scrolled ${dy}px: the seam on the box's edge and the list under it, in the first frame`);
  }
  // The box narrows: the list follows its width and place.
  await page.$eval(FIELD, (el) => { el.parentElement.style.width = '200px'; });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const still = await fit(page, FIELD);
  assert.deepEqual([still.top, still.left, still.width], [0, 0, 0], 'its width and place follow the box');
  assert.deepEqual(await textMotion(page, '[data-slot="select-list"][data-open]'), [], 'no text in the list fades or moves (it unrolls by a clip)');
  assert.deepEqual(page.problems, []);
});

test('near the bottom of the window it opens upward, its top corners squared off the box', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  // The box moved to the window's bottom edge (fixed), then opened.
  await page.$eval(FIELD, (el) => { const p = el.parentElement; Object.assign(p.style, { position: 'fixed', bottom: '10px', left: '20px', zIndex: 5 }); });
  const at = await centreOf(page, FIELD);
  await page.mouse.click(at.x, at.y);
  await settled(page);
  const open = await fit(page, FIELD);
  assert.deepEqual([open.bottom, open.left, open.width, open.up], [0, 0, 0, true], 'above the box, its edge over the box\'s');
  const corners = await page.$eval(FIELD, (el) => { const s = getComputedStyle(el); return [s.borderTopLeftRadius, s.borderBottomLeftRadius]; });
  assert.deepEqual(corners, ['0px', '6px']);
});

test('under a coarse pointer it is the system\'s select, drawn closed as the other', async (t) => {
  const page = await componentsPage(t, browser, origin, { width: 390, height: 844, hasTouch: true, isMobile: true });
  if (!page) return;
  const box = await page.$eval(FIELD, (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return [el.localName, r.height, s.backgroundColor, s.borderTopColor, s.appearance, el.options.length]; });
  assert.deepEqual(box, ['select', 38, 'rgb(17, 17, 20)', 'rgb(63, 63, 72)', 'none', 12]);
  await page.select(FIELD, 'fr');
  assert.equal(await page.$eval(FIELD, (el) => el.value), 'fr');
});

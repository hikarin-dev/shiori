// ui-menu.browser.mjs — Menu and ContextMenu (src/components/ui/menu.tsx) as /components shows them:
// 1.3's sizes (items, a title, a detail line, a key cap, a danger item, the menu's separator, the
// checklist's options), one floating shadow and layer; and working: under its button or at the
// pointer, the page's scrollbar kept, the keyboard of a menu (arrows, Home, End, a letter, Enter,
// Escape, focus back to the button; opened from its button reached by Tab, in Chrome and Firefox), closed by a
// scroll; a right-click's menu slid back inside the window at its edge; a checklist's ticks leave it open. (The
// pointer is moved to a right-click's place first: puppeteer's click alone is not taken as one there.)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { componentsPage, spec, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const frame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const highlighted = (page, menu) => page.evaluate((sel) => document.querySelector(`${sel} [data-highlighted]`)?.textContent ?? null, menu);

test('the menus at rest: 1.3\'s sizes, one frame', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const style = (sel, ...props) => page.$eval(sel, (el, props) => { const s = getComputedStyle(el); return props.map((p) => s.getPropertyValue(p)); }, props);
  assert.deepEqual(await style(spec('ctx-menu', 'rerun'), 'padding', 'border-top-left-radius', 'border-top-color', 'background-color', 'max-width', 'width'), ['5px', '8px', 'rgb(42, 42, 48)', 'rgb(22, 22, 26)', '320px', '320px']);
  assert.deepEqual(await style(spec('ctx-menu', 'item'), 'padding', 'border-top-left-radius', 'font-size', 'background-color'), ['7px 9px', '5px', '12px', 'rgba(0, 0, 0, 0)']);
  assert.equal((await style(spec('ctx-menu', 'item', 'hover'), 'background-color'))[0], 'rgb(42, 42, 48)');   // F30: the border's grey, as 1.3
  assert.equal((await style(spec('ctx-menu', 'item', 'disabled'), 'opacity'))[0], '0.55');
  assert.equal((await style(spec('ctx-menu', 'danger'), 'color'))[0], 'rgb(255, 100, 103)');
  const detail = await page.$eval(`${spec('ctx-menu', 'item')} [data-slot="menu-detail"]`, (el) => { const s = getComputedStyle(el); return [s.fontSize, s.lineHeight, s.marginTop, s.color]; });
  assert.deepEqual(detail, ['11px', '14.85px', '2px', 'rgb(161, 161, 170)']);
  // A key cap: 1.3's 17px in its line (F32: its text the text colour, radius 4).
  const cap = await page.$eval(`${spec('ctx-menu', 'shortcut')} kbd`, (el) => { const s = getComputedStyle(el); return [el.getBoundingClientRect().height, s.color, s.borderTopLeftRadius]; });
  assert.deepEqual(cap, [17, 'rgb(244, 244, 245)', '4px']);
  // The folder menu's line: 4px above and below, 2px in.
  assert.deepEqual(await page.$eval(`${spec('ctx-menu', 'folder')} [data-slot="separator"]`, (el) => getComputedStyle(el).margin), '4px 2px');
  // The checklist: 290 wide, 4px above and below, options 7px 11px, under the pointer the raised surface.
  assert.deepEqual(await style(spec('bench-tier-menu', 'checklist'), 'width', 'padding', 'border-top-left-radius', 'background-color'), ['290px', '4px 0px', '8px', 'rgb(22, 22, 26)']);
  assert.deepEqual(await style(spec('bench-tier-menu', 'option'), 'padding', 'gap', 'font-size'), ['7px 11px', '8px', '12px']);
  assert.deepEqual(await textMotion(page, '[data-section="menu"]'), []);
  assert.deepEqual(page.problems, []);
});

test('a menu under its button: the keyboard of a menu, focus back, the scrollbar kept, closed by a scroll', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const trigger = '[data-specimen-open="menu"]', menu = '[data-specimen-menu="folder"]';
  const at = await centreOf(page, trigger);
  const before = await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollHeight, getComputedStyle(document.documentElement).overflow, getComputedStyle(document.body).paddingRight]);
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(menu);
  await frame(page);
  assert.deepEqual(await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollHeight, getComputedStyle(document.documentElement).overflow, getComputedStyle(document.body).paddingRight]), before);
  const placed = await page.evaluate((m, b) => {
    const r = document.querySelector(m).getBoundingClientRect(), a = document.querySelector(b).getBoundingClientRect();
    // 4px under its button, or over it where the window has no room below.
    const gap = r.top >= a.bottom ? r.top - a.bottom : a.top - r.bottom;
    return [getComputedStyle(document.querySelector(m).parentElement).position, getComputedStyle(document.querySelector(m).parentElement).zIndex, Math.round(gap), r.left >= 8, Math.abs(r.right - a.right) < 0.5 || Math.abs(r.left - 8) < 0.5];
  }, menu, trigger);
  assert.deepEqual(placed, ['fixed', '900', 4, true, true], JSON.stringify(await page.evaluate((m, b) => [document.querySelector(m).getBoundingClientRect().toJSON(), document.querySelector(b).getBoundingClientRect().toJSON()], menu, trigger)));
  // The arrows (wrapping), Home, End, a letter.
  await page.keyboard.press('ArrowDown');
  assert.equal(await highlighted(page, menu), 'Open folder');
  await page.keyboard.press('ArrowUp');
  assert.equal(await highlighted(page, menu), 'Remove');
  await page.keyboard.press('Home');
  assert.equal(await highlighted(page, menu), 'Open folder');
  await page.keyboard.press('End');
  assert.equal(await highlighted(page, menu), 'Remove');
  await page.keyboard.press('r');
  assert.equal(await highlighted(page, menu), 'Rescan');
  await page.keyboard.press('Escape');
  await until(page, (m) => !document.querySelector(m), menu, { what: 'the menu closed' });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.specimenOpen), 'menu');
  // Opened from the keyboard: its first item lit; Enter chooses and closes; focus back.
  await page.keyboard.press('Enter');
  await page.waitForSelector(menu);
  await until(page, (m) => document.querySelector(`${m} [data-highlighted]`)?.textContent === 'Open folder', menu, { what: 'the first item lit' });
  await page.keyboard.press('Enter');
  await until(page, (m) => !document.querySelector(m), menu, { what: 'the menu closed on a choice' });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.specimenOpen), 'menu');
  // A scroll closes it, as 1.3's.
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(menu);
  await frame(page);   // a scroll once it is open (one in the frame it opened in is the one before it)
  await page.evaluate(() => window.scrollBy(0, -40));
  await until(page, (m) => !document.querySelector(m), menu, { what: 'the menu closed by a scroll' });
  assert.deepEqual(page.problems, []);
});

test('a right-click menu at the pointer, and a checklist that stays open', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const area = await centreOf(page, '[data-specimen-open="context"]');
  const menu = '[data-specimen-menu="context"]';
  await page.mouse.move(area.x, area.y);
  await page.mouse.click(area.x, area.y, { button: 'right' });
  await page.waitForSelector(menu);
  await frame(page);
  // Its top left corner on the pointer, or its bottom left where the window has no room below.
  const box = await page.$eval(menu, (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.bottom]; });
  assert.ok(Math.abs(box[0] - area.x) <= 1 && (Math.abs(box[1] - area.y) <= 1 || Math.abs(box[2] - area.y) <= 1), `at the pointer: ${box} vs ${area.x},${area.y}`);
  // The right-click's release chose nothing; the title names the menu's items; the disabled one is passed over.
  assert.ok(await page.$(menu));
  assert.equal(await page.$eval(`${menu} [role="group"]`, (g) => document.getElementById(g.getAttribute('aria-labelledby'))?.textContent), 'Page 4');
  // The arrows reach a disabled item too (Base UI, as the ARIA menu pattern has it; 1.3 passed over
  // it), which says why it is off and does nothing.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  assert.match(await highlighted(page, menu), /^Follow/);
  await page.keyboard.press('Enter');
  assert.ok(await page.$(menu), 'a disabled item chooses nothing');
  await page.keyboard.press('ArrowDown');
  assert.match(await highlighted(page, menu), /^Page propertiesI/);
  await page.keyboard.press('Escape');
  await until(page, (m) => !document.querySelector(m), menu, { what: 'the context menu closed' });

  // Near the window's bottom right corner it slides back inside, 8px from each edge, as 1.3's page
  // menu was clamped: it never turns to open upward or leftward from the pointer.
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluate(() => {
    const el = document.querySelector('[data-specimen-open="context"]');
    el.scrollIntoView({ block: 'end', behavior: 'instant' });
    window.scrollBy(0, -2);
  });
  const edge = await page.evaluate(() => {
    const r = document.querySelector('[data-specimen-open="context"]').getBoundingClientRect();
    return { x: r.right - 4, y: Math.min(r.bottom, innerHeight) - 20, w: document.documentElement.clientWidth, h: innerHeight };
  });
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.click(edge.x, edge.y, { button: 'right' });
  await page.waitForSelector(menu);
  await frame(page);
  const slid = await page.$eval(menu, (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
  assert.ok(Math.abs(slid.bottom - (edge.h - 8)) <= 1, `its bottom 8px over the window's: ${JSON.stringify(slid)} in ${edge.h}`);
  assert.ok(slid.top < edge.y && slid.bottom > edge.y, `over the pointer, slid up, not opened upward from it: ${JSON.stringify(slid)} at ${edge.y}`);
  assert.ok(slid.left <= edge.x + 1 && slid.left >= 8, `its left at the pointer or slid in: ${JSON.stringify(slid)} at ${edge.x}`);
  await page.keyboard.press('Escape');
  await until(page, (m) => !document.querySelector(m), menu, { what: 'the context menu closed' });

  const list = '[data-specimen-menu="checklist"]';
  await page.click('[data-specimen-open="checklist"]');
  await page.waitForSelector(list);
  const ticks = () => page.$$eval(`${list} [role="menuitemcheckbox"]`, (els) => els.map((e) => e.getAttribute('aria-checked')));
  assert.deepEqual(await ticks(), ['true', 'false', 'false']);
  await page.click(`${list} [role="menuitemcheckbox"]:nth-child(2)`);
  assert.deepEqual(await ticks(), ['true', 'true', 'false']);
  assert.ok(await page.$(list), 'still open');
  assert.deepEqual(page.problems, []);
});

// A keyboard user who tabs to a menu's button opens it with Enter, Space or ArrowDown (the first item
// lit and focused) or ArrowUp (the last), as the menu-button pattern has it; in Chrome and, where it
// is installed, in Firefox. (Reached by Tab from a button put just before it: the page is long. The page
// is scrolled to it just before, as a Tab that brings a button into view does: that scroll's event,
// which comes a frame later, once closed the menu the key had just opened.)
const firefoxPath = [process.env.FIREFOX_PATH, 'C:/Program Files/Mozilla Firefox/firefox.exe',
  '/Applications/Firefox.app/Contents/MacOS/firefox', '/usr/bin/firefox'].find((p) => p && existsSync(p));

async function openedByKeys(page) {
  const seen = [];
  for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp']) {
    await page.evaluate(() => {
      const button = document.querySelector('[data-specimen-open="menu"]');
      document.getElementById('before-menu')?.remove();
      const start = Object.assign(document.createElement('button'), { id: 'before-menu', textContent: '·' });
      button.before(start);
      start.scrollIntoView({ block: 'center', behavior: 'instant' });
      start.focus();
    });
    await page.keyboard.press('Tab');
    const reached = await page.evaluate(() => document.activeElement?.dataset.specimenOpen ?? null);
    await page.keyboard.press(key);
    // Lit, then focused (Base UI moves focus to it in a later frame).
    await until(page, () => { const lit = document.querySelector('[data-specimen-menu="folder"] [data-highlighted]'); return !!lit && document.activeElement === lit; }, undefined, { what: `the menu opened by ${JSON.stringify(key)}, an item focused` });
    seen.push(await page.evaluate((key) => {
      const menu = document.querySelector('[data-specimen-menu="folder"]');
      const lit = menu.querySelector('[data-highlighted]');
      return [key, document.querySelector('[data-specimen-open="menu"]').getAttribute('aria-expanded'), lit.textContent, document.activeElement === lit];
    }, key).then((r) => [reached, ...r]));
    await page.keyboard.press('Escape');
    await until(page, () => !document.querySelector('[data-specimen-menu="folder"]') && document.activeElement?.dataset.specimenOpen === 'menu', undefined, { what: 'closed, focus back on its button' });
  }
  return seen;
}

const BY_KEYS = [
  ['menu', 'Enter', 'true', 'Open folder', true],
  ['menu', ' ', 'true', 'Open folder', true],
  ['menu', 'ArrowDown', 'true', 'Open folder', true],
  ['menu', 'ArrowUp', 'true', 'Remove', true],
];

test('a menu\'s button reached by Tab opens by Enter, Space and the arrows, an item focused (Chrome)', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  assert.deepEqual(await openedByKeys(page), BY_KEYS);
  assert.deepEqual(page.problems, []);
});

test('a menu\'s button reached by Tab opens by Enter, Space and the arrows, an item focused (Firefox)', { skip: !firefoxPath && 'Firefox not found (set FIREFOX_PATH)' }, async (t) => {
  if (!origin) { t.skip('Chrome not found (the server starts with it)'); return; }
  const firefox = await puppeteer.launch({ browser: 'firefox', executablePath: firefoxPath, headless: true });
  t.after(() => firefox.close());
  const page = await firefox.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`uncaught: ${e?.message || e}`));
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  await until(page, () => document.title === 'Shiori — Components' && !!document.querySelector('[data-specimen-open="menu"]'), undefined, { what: 'the components page' });
  assert.deepEqual(await openedByKeys(page), BY_KEYS);
  assert.deepEqual(problems, []);
});

// ui-listbox.browser.mjs — Listbox and useCombobox (src/components/ui/listbox.tsx) as /components
// shows them: one frame for the three lists (F16, F31) at 1.3's sizes; and the combobox pattern on a
// text box: the box keeps focus, the arrows move the active option (none, then not past either end),
// Enter or a press picks, Escape closes the list and nothing round it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { componentsPage, spec, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const SHADOW = 'rgba(0, 0, 0, 0.45) 0px 8px 24px 0px';

test('the lists: one frame, 1.3\'s sizes', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const look = (sel) => page.$eval(sel, (el) => {
    const s = getComputedStyle(el);
    const shadow = s.boxShadow.split(/,(?![^(]*\))/).map((x) => x.trim()).filter((x) => x !== 'rgba(0, 0, 0, 0) 0px 0px 0px 0px').join(', ');
    return [el.getAttribute('role'), s.padding, s.borderTopLeftRadius, s.borderTopColor, s.backgroundColor, shadow];
  });
  assert.deepEqual(await look(spec('search-suggest', 'search')), ['listbox', '6px', '8px', 'rgb(63, 63, 72)', 'rgb(22, 22, 26)', SHADOW]);
  assert.deepEqual(await look(spec('tag-ed-list', 'tag')), ['listbox', '0px', '8px', 'rgb(63, 63, 72)', 'rgb(22, 22, 26)', SHADOW]);
  assert.deepEqual(await look(spec('add-results', 'rich')), ['listbox', '0px', '8px', 'rgb(63, 63, 72)', 'rgb(22, 22, 26)', SHADOW]);
  const opt = (sel) => page.$eval(sel, (el) => { const s = getComputedStyle(el); return [el.getAttribute('role'), s.padding, s.borderTopLeftRadius, s.fontSize, s.gap, +el.getBoundingClientRect().height.toFixed(2)]; });
  assert.deepEqual(await opt(spec('search-suggest', 'option')), ['option', '6px 8px', '5px', '12px', '10px', 34]);
  assert.deepEqual(await opt(spec('search-suggest', 'option-hint')), ['option', '6px 8px', '5px', '12px', '10px', 42]);
  assert.deepEqual(await opt(spec('tag-ed-list', 'option')), ['option', '6px 10px', '0px', '12px', '10px', 28]);
  assert.deepEqual(await opt(spec('add-results', 'row')), ['option', '8px 10px', '0px', '12px', '10px', 58.42]);
  // The active option and the one under the pointer: the raised surface.
  assert.equal(await page.$eval(spec('search-suggest', 'option-hint', 'on'), (el) => [el.getAttribute('aria-selected'), getComputedStyle(el).backgroundColor].join()), 'true,rgb(28, 28, 33)');
  assert.equal(await page.$eval(spec('search-suggest', 'option', 'rest'), (el) => el.getAttribute('aria-selected')), 'false');
  // A line between groups and a group's head: not options, nothing a screen reader stops at.
  assert.deepEqual(await page.$eval(spec('search-suggest', 'separator'), (el) => [el.getAttribute('role'), getComputedStyle(el).margin]), ['presentation', '6px 4px']);
  assert.equal(await page.$eval(`${spec('search-suggest', 'search')} [data-slot="eyebrow"]`, (el) => el.getAttribute('role')), 'presentation');
  assert.deepEqual(await textMotion(page, '[data-section="listbox"]'), []);
  assert.deepEqual(page.problems, []);
});

test('the combobox pattern: the box keeps focus, arrows, Enter, a press, Escape', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const box = '[data-specimen-open="listbox"]';
  const at = await centreOf(page, box);
  await page.mouse.click(at.x, at.y);
  const state = () => page.$eval(box, (el) => {
    const list = document.getElementById(el.getAttribute('aria-controls'));
    const active = el.getAttribute('aria-activedescendant');
    return { focused: document.activeElement === el, role: el.getAttribute('role'), expanded: el.getAttribute('aria-expanded'), list: !!list && list.getAttribute('role'),
      active: active ? document.getElementById(active)?.textContent : null, selected: list ? [...list.querySelectorAll('[aria-selected="true"]')].length : 0 };
  });
  assert.deepEqual(await state(), { focused: true, role: 'combobox', expanded: 'true', list: 'listbox', active: null, selected: 0 });
  await page.keyboard.press('ArrowDown');
  assert.deepEqual(await state(), { focused: true, role: 'combobox', expanded: 'true', list: 'listbox', active: 'romance1,204', selected: 1 });
  await page.keyboard.press('ArrowUp');
  assert.equal((await state()).active, null);   // back to none, not round to the end
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
  assert.equal((await state()).active, 'sports98');   // and not past the end
  await page.keyboard.press('Enter');
  assert.equal(await page.$eval(box, (el) => el.value), 'sports');
  assert.deepEqual(await state(), { focused: true, role: 'combobox', expanded: 'false', list: false, active: null, selected: 0 });
  // Typing narrows it; a press on an option picks it, the box keeping focus.
  await page.$eval(box, (el) => el.select());
  await page.keyboard.type('o');
  await until(page, (sel) => document.querySelector(sel).getAttribute('aria-expanded') === 'true', box, { what: 'the list open' });
  const second = await page.evaluateHandle((sel) => { const el = document.querySelector(sel); return document.getElementById(el.getAttribute('aria-controls')).querySelectorAll('[role="option"]')[1]; }, box);
  await second.click();
  assert.equal(await page.$eval(box, (el) => [el.value, document.activeElement === el].join()), 'school,true');
  // Escape closes the list (and is not passed on).
  await page.keyboard.press('ArrowDown');
  await page.$eval(box, (el) => { window.__passed = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__passed++; }); });
  await page.keyboard.press('Escape');
  assert.deepEqual([(await state()).expanded, await page.evaluate(() => window.__passed)], ['false', 0]);
  assert.deepEqual(page.problems, []);
});

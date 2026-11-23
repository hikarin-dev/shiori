// ui-setting-row.browser.mjs — SettingRow (src/components/ui/setting-row.tsx) as /components shows
// it: the name labels the control and the description describes it; rows of a kind ruled apart, a
// sub-setting set in and not ruled off; at the desktop width the control in its own column; in a
// panel of 560px or less a field's control under its words, full width, a switch still at the end;
// at 480px or less the narrow padding and an action's button under its words, full width — all by
// the panel's width (a container query), not the window's.
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

// A row: its padding and top rule, and where its words and control sit in it.
const row = (page, variant) => page.$eval(spec('setting-row', variant), (el) => {
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  const box = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return [Math.round(b.left - r.left), Math.round(b.top - r.top), Math.round(b.width)]; };
  const words = el.querySelector('[id$="-name"]') ?? el.querySelector('[id$="-desc"]');
  return { padding: s.padding, rule: s.borderTopWidth, width: Math.round(r.width), words: box(words), control: box(el.querySelector('[data-slot="setting-control"]')), status: box(el.querySelector('[data-slot="setting-status"]')) };
});

test('the name and description label and describe the control', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const named = await page.$eval(spec('setting-row', 'switch'), (el) => {
    const sw = el.querySelector('[role="switch"]');
    const text = (ids) => ids.split(' ').map((id) => document.getElementById(id)?.textContent).join(' ');
    return [text(sw.getAttribute('aria-labelledby')), text(sw.getAttribute('aria-describedby'))];
  });
  assert.deepEqual(named, ['Show storage stats', 'Show the gallery, image and storage totals in the top bar.']);
  // A control that names itself keeps its own name; the description still describes it.
  const own = await page.$eval(spec('setting-row', 'field'), (el) => { const c = el.querySelector('[role="combobox"]'); return [c.getAttribute('aria-label'), c.hasAttribute('aria-labelledby'), document.getElementById(c.getAttribute('aria-describedby'))?.textContent]; });
  assert.deepEqual(own, ['Language', false, 'Display language for the app.']);
  assert.deepEqual(page.problems, []);
});

test('desktop: the control in its column, rows ruled apart, a sub-setting set in', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const field = await row(page, 'labelled');
  assert.deepEqual([field.padding, field.rule, field.width], ['17px 20px', '1px', 846]);
  assert.deepEqual(field.control.slice(2), [260], 'the control column at its widest, 260px');
  assert.equal(field.control[0], 846 - 20 - 260, 'at the row\'s end');
  assert.equal((await row(page, 'field')).rule, '0px', 'the first row is not ruled off from the header');
  const status = await row(page, 'status');
  assert.deepEqual([status.status[0], status.status[1] > status.control[1]], [status.control[0], true], 'the status under the control');
  const sub = await row(page, 'sub');
  assert.deepEqual([sub.padding, sub.rule], ['0px 20px 17px 40px', '0px'], 'set in, not ruled off from the one above');
  const sw = await row(page, 'switch');
  assert.equal(sw.control[0] + sw.control[2], 846 - 20, 'a switch at the row\'s end');
  const action = await row(page, 'action');
  assert.equal(action.control[0] + action.control[2], 846 - 20);
  assert.equal((await row(page, 'footer')).padding, '11px 20px');
});

test('a phone\'s panel: the control under its words, full width; the narrow padding; a switch at the end', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const field = await row(page, 'labelled-narrow');
  assert.deepEqual([field.padding, field.width], ['15px', 262]);
  assert.deepEqual([field.control[0], field.control[2], field.control[1] > field.words[1]], [15, 232, true], 'under its words, the row\'s full width');
  const status = await row(page, 'status-narrow');
  assert.ok(status.status[1] > status.control[1] && status.status[0] === 15, 'the status under the control');
  const sw = await row(page, 'switch-narrow');
  assert.equal(sw.control[0] + sw.control[2], 262 - 15, 'a switch stays at the end');
  const action = await row(page, 'action-narrow');
  assert.deepEqual([action.control[0], action.control[2]], [15, 232], 'an action\'s button under its words, full width');
  assert.equal(await page.$eval(spec('setting-row', 'action-narrow'), (el) => el.querySelector('button').getBoundingClientRect().width), 232);
  assert.equal((await row(page, 'footer-narrow')).padding, '10px 15px');
  assert.equal((await row(page, 'sub-narrow')).padding, '0px 15px 15px', 'the narrow padding takes the sub-setting\'s inset, as 1.3\'s did');
  // The forms follow the panel: at 561px a field is two columns, at 560 one; the window is the same.
  const columns = (w) => page.$eval(spec('setting-row', 'labelled-narrow'), (el, w) => {
    el.closest('[data-slot="card"]').parentElement.style.width = `${w}px`;
    return getComputedStyle(el).gridTemplateColumns.split(' ').length;
  }, w);
  assert.equal(await columns(560), 1);
  assert.equal(await columns(561), 2);
});

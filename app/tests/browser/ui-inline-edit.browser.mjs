// ui-inline-edit.browser.mjs — InlineEdit (src/components/ui/inline-edit.tsx) as /components shows it:
// 1.3's two sizes (the title 34px, 20px bold, 4px 8px, 9px into its left; a chapter's 24.3px, 13px,
// 3px 5px, as wide as its words), no frame until hovered, focused the ring colour's frame (F13) on the
// page's ground; read-only text outside edit mode; Enter saves, Escape puts the saved text back,
// leaving it saves, only a changed (trimmed) text.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { componentsPage, spec } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const look = (page, sel) => page.$eval(sel, (el) => {
  const s = getComputedStyle(el), r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect();
  return [+r.width.toFixed(2), +r.height.toFixed(2), s.padding, s.fontSize, s.fontWeight, s.lineHeight, s.borderTopLeftRadius, s.borderTopColor, s.backgroundColor, +(r.left - p.left).toFixed(2)];
});
const saved = (page) => page.$eval('[data-inline-saved]', (el) => el.textContent);

test('1.3\'s sizes and looks, at rest, hovered, focused and as text', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const clear = 'rgba(0, 0, 0, 0)';
  assert.deepEqual(await look(page, spec('inline-title', 'title')), [320, 34, '4px 8px', '20px', '700', '24px', '6px', clear, clear, 0]);
  assert.equal((await look(page, spec('inline-title', 'title', 'hover')))[7], 'rgb(42, 42, 48)');
  const focused = await look(page, spec('inline-title', 'title', 'focus'));
  assert.deepEqual([focused[7], focused[8]], ['rgb(251, 113, 133)', 'rgb(13, 13, 15)'], 'F13: the ring colour, on the page\'s ground');
  // The title stands 9px into its left: its words line up with the text around it.
  assert.equal(await page.$eval(spec('inline-title', 'title'), (el) => el.getBoundingClientRect().left + 9 - el.parentElement.getBoundingClientRect().left), 9);
  const row = await look(page, spec('inline-title', 'row'));
  assert.deepEqual(row.slice(1, 8), [24.25, '3px 5px', '13px', '400', '16.25px', '5px', clear]);
  // As wide as its words, plus its padding and frame.
  const words = await page.$eval(spec('inline-title', 'row'), (el) => {
    const c = document.createElement('canvas').getContext('2d'), s = getComputedStyle(el);
    c.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    return c.measureText(el.value).width + 12;
  });
  assert.ok(Math.abs(row[0] - words) < 1, `${row[0]} vs ${words}`);
  // Read-only: text, no tab stop, the pointer passing through.
  assert.deepEqual(await page.$eval(spec('inline-title', 'title', 'disabled'), (el) => [el.readOnly, el.tabIndex, getComputedStyle(el).pointerEvents]), [true, -1, 'none']);
  assert.deepEqual(page.problems, []);
});

test('Enter saves, Escape puts the saved text back, leaving it saves; only a changed text', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const row = spec('inline-title', 'row');
  assert.equal(await saved(page), 'Harbor Lights · Chapter 2');
  await page.$eval(row, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(row);
  await page.$eval(row, (el) => el.select());
  await page.keyboard.type('  Chapter Two  ');
  await page.keyboard.press('Enter');
  await until(page, () => document.querySelector('[data-inline-saved]').textContent === 'Harbor Lights · Chapter Two', undefined, { what: 'saved, trimmed' });
  await page.keyboard.type(' and more');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval(row, (el) => [el.value, document.activeElement === el].join()), 'Chapter Two,true', 'the saved text back, still focused');
  // The title: Enter takes no line break; leaving it saves.
  const title = spec('inline-title', 'title');
  await page.click(title);
  await page.keyboard.press('End');
  await page.keyboard.type(' Bay');
  await page.keyboard.press('Enter');
  assert.equal(await page.$eval(title, (el) => el.value), 'Harbor Lights Bay', 'no line break');
  await until(page, () => document.querySelector('[data-inline-saved]').textContent === 'Harbor Lights Bay · Chapter Two', undefined, { what: 'the title saved' });
  await page.keyboard.type(' North');
  await page.$eval(title, (el) => el.blur());
  await until(page, () => document.querySelector('[data-inline-saved]').textContent === 'Harbor Lights Bay North · Chapter Two', undefined, { what: 'saved on leaving' });
  // The other specimens of the same text follow it (they are not being edited).
  assert.equal(await page.$eval(spec('inline-title', 'title', 'hover'), (el) => el.value), 'Harbor Lights Bay North');
  // Grown to its lines.
  await page.click(title);
  await page.keyboard.type(' with a name long enough to take a second line of its own');
  assert.ok(await page.$eval(title, (el) => el.getBoundingClientRect().height) >= 58, 'two lines tall');
  assert.deepEqual(page.problems, []);
});

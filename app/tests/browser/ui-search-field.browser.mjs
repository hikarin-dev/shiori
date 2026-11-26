// ui-search-field.browser.mjs — SearchField (src/components/ui/search-field.tsx) on /components, its
// editing app/js/search-field.js's: the box (1.3's 40px, 12 and 34 in, a 38px line, one line scrolling
// sideways with no scrollbar), a finished filter as a block in Tag's look (typed with its quotes, or
// bare and ended by a space), the list under the box (6px under it, as wide, the filters then the
// tags), its keys (the arrows from none, Enter or Tab takes the active one, Escape closes it; Enter
// with none active finishes the filter being typed), a press picking without the box losing focus,
// and the X clearing it; in the library header's phone form, the search on a row of its own.
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

const BOX = spec('header-search', 'library');
const tokens = (page) => page.$$eval(`${BOX} .search-chip`, (els) => els.map((e) => e.dataset.token));
const list = (page) => page.evaluate(() => {
  const l = document.getElementById('searchSuggest');
  return l ? { heads: [...l.querySelectorAll('[data-slot="eyebrow"]')].map((h) => h.textContent), options: [...l.querySelectorAll('[role="option"]')].map((o) => o.textContent), active: l.querySelector('[aria-selected="true"]')?.textContent ?? null } : null;
});

async function focusAtEnd(page) {
  await page.$eval(BOX, (el) => el.scrollIntoView({ block: 'center' }));
  await page.click(BOX);
  await page.keyboard.press('End');
}

test('the box at rest: 1.3\'s, a filter a block in Tag\'s look, the X showing while there is a query', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const box = await page.$eval(BOX, (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return [r.width, r.height, s.padding, s.fontSize, s.lineHeight, s.whiteSpace, s.overflowX, s.scrollbarWidth, s.borderTopColor, s.backgroundColor, s.borderTopLeftRadius, el.getAttribute('role'), el.getAttribute('contenteditable')]; });
  assert.deepEqual(box, [670, 40, '0px 34px 0px 12px', '12px', '38px', 'pre', 'auto', 'none', 'rgb(42, 42, 48)', 'rgb(13, 13, 15)', '6px', 'combobox', 'plaintext-only']);
  assert.deepEqual(await tokens(page), ['category:"manga"']);
  const chip = await page.$eval(`${BOX} .search-chip`, (el) => { const s = getComputedStyle(el); return [el.getBoundingClientRect().height, s.padding, s.lineHeight, s.fontWeight, s.backgroundColor, s.borderTopColor, s.borderTopLeftRadius, el.contentEditable, getComputedStyle(el.firstElementChild).color, getComputedStyle(el.firstElementChild).fontWeight]; });
  assert.deepEqual(chip, [22, '0px 6px', '20px', '600', 'rgb(28, 28, 33)', 'rgb(63, 63, 72)', '4px', 'false', 'rgb(161, 161, 170)', '400']);
  const x = await page.$eval('#searchClear', (el) => { const r = el.getBoundingClientRect(), b = el.parentElement.getBoundingClientRect(); return [r.width, r.height, +(b.right - r.right).toFixed(2), +(r.top - b.top - (b.height - r.height) / 2).toFixed(2), el.hidden, el.getAttribute('aria-label')]; });
  assert.deepEqual(x, [22, 22, 8, 0, false, 'Clear search']);
  assert.deepEqual(page.problems, []);
});

test('typing: blocks made, the list and its keys, a press picks, the X clears', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await page.$eval('#searchClear', (b) => b.click());
  assert.equal(await page.$eval(BOX, (el) => [el.childNodes.length, document.activeElement === el].join()), '0,true', 'cleared, and the box keeps focus');
  assert.equal(await page.$eval('#searchClear', (b) => b.hidden), true, 'no query, no X');
  // Focused: the filters, under the box, 6px down, as wide.
  await until(page, () => !!document.getElementById('searchSuggest'), undefined, { what: 'the list' });
  const placed = await page.evaluate((sel) => {
    const l = document.getElementById('searchSuggest').getBoundingClientRect(), b = document.querySelector(sel).getBoundingClientRect();
    return [l.top - b.bottom, l.left - b.left, l.width - b.width, getComputedStyle(document.getElementById('searchSuggest')).position];
  }, BOX);
  assert.deepEqual(placed, [6, 0, 0, 'fixed']);
  assert.equal((await list(page)).heads[0], 'Filters');
  assert.equal(await page.$eval(BOX, (el) => [el.getAttribute('aria-expanded'), el.getAttribute('aria-controls')].join()), 'true,searchSuggest');
  // A filter typed with its quotes becomes a block; one typed bare, at the space.
  await page.keyboard.type('artist:"ann"');
  await until(page, (sel) => document.querySelectorAll(`${sel} .search-chip`).length === 1, BOX, { what: 'a quoted filter\'s block' });
  await page.keyboard.type('category:doujinshi ');
  await until(page, (sel) => document.querySelectorAll(`${sel} .search-chip`).length === 2, BOX, { what: 'a bare filter\'s block' });
  assert.deepEqual(await tokens(page), ['artist:"ann"', 'category:"doujinshi"']);
  // The arrows from none, not past the first; Escape closes the list only.
  await page.keyboard.type('fa');
  // (Its first row: the list drawn for 'f' alone holds it too, further down.)
  await until(page, () => (document.querySelector('#searchSuggest [role="option"]')?.textContent || '').includes('favorite:'), undefined, { what: 'the filters matching' });
  assert.equal((await list(page)).active, null, 'nothing active as it opens');
  await page.keyboard.press('ArrowUp');
  assert.equal((await list(page)).active, null, 'not past the first');
  await page.keyboard.press('ArrowDown');
  assert.match((await list(page)).active, /favorite:/);
  assert.match(await page.$eval(BOX, (el) => el.getAttribute('aria-activedescendant')), /^searchSuggest-0$/);
  await page.keyboard.press('Escape');
  await until(page, () => !document.getElementById('searchSuggest'), undefined, { what: 'closed by Escape' });
  // Typing again opens it; Enter takes the active one: a filter starts its value.
  await page.keyboard.type('v');
  await until(page, () => !!document.getElementById('searchSuggest'), undefined, { what: 'open again' });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await until(page, (sel) => document.querySelector(sel).textContent.endsWith('favorite:'), BOX, { what: 'the filter started' });
  // Its values; a press picks one, the box keeping focus.
  await until(page, () => [...document.querySelectorAll('#searchSuggest [role="option"] [data-slot="tag"]')].some((t) => t.textContent === 'favorite:yes'), undefined, { what: 'its values' });
  await page.evaluate(() => {
    const opt = [...document.querySelectorAll('#searchSuggest [role="option"]')].find((o) => o.querySelector('[data-slot="tag"]')?.textContent === 'favorite:yes');
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  await until(page, (sel) => document.querySelectorAll(`${sel} .search-chip`).length === 3, BOX, { what: 'a picked value\'s block' });
  assert.deepEqual(await tokens(page), ['artist:"ann"', 'category:"doujinshi"', 'favorite:"yes"']);
  assert.equal(await page.$eval(BOX, (el) => document.activeElement === el), true);
  // Enter with nothing active finishes the filter being typed.
  await page.keyboard.type('rating:5');
  await page.keyboard.press('Enter');
  await until(page, (sel) => document.querySelectorAll(`${sel} .search-chip`).length === 4, BOX, { what: 'Enter finishing a filter' });
  // One line: it scrolls sideways, no scrollbar, never taller.
  await page.keyboard.type(' a long run of words that goes past the end of the box');
  assert.deepEqual(await page.$eval(BOX, (el) => [el.getBoundingClientRect().height, el.scrollWidth > el.clientWidth, el.scrollHeight <= el.clientHeight]), [40, true, true]);
  // Leaving the box closes the list.
  await page.$eval(BOX, (el) => el.blur());
  await until(page, () => !document.getElementById('searchSuggest'), undefined, { what: 'closed on blur' });
  assert.deepEqual(page.problems, []);
});

test('an arrow pressed just after typing keeps its row: a list worked out again with the same rows is left as it is', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  // The module works the list out again as the caret moves, a frame or more after the typing that
  // moved it: on a slow machine, after the arrow has landed. (Slowed six times, every run lost its
  // row while each of those wrote the list again with none active.)
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.$eval('#searchClear', (b) => b.click());
  await until(page, () => !!document.getElementById('searchSuggest'), undefined, { what: 'the list' });
  await page.keyboard.type('fa');
  await until(page, () => (document.querySelector('#searchSuggest [role="option"]')?.textContent || '').includes('favorite:'), undefined, { what: 'the filters matching' });
  await page.keyboard.press('ArrowDown');
  const active = await page.evaluate(() => new Promise((done) => {
    const seen = [];
    const read = () => { seen.push(document.querySelector('#searchSuggest [aria-selected="true"]')?.textContent.includes('favorite:') ?? false); };
    read();
    let frames = 0;
    const step = () => { read(); if (++frames < 12) requestAnimationFrame(step); else done(seen); };
    requestAnimationFrame(step);
  }));
  assert.deepEqual(active, Array(13).fill(true), 'active from the key on, through every frame after');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  assert.deepEqual(page.problems, []);
});

test('Escape closes the list for good: the drawing a key had just asked for is called off', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await page.$eval('#searchClear', (b) => b.click());
  await until(page, () => !!document.getElementById('searchSuggest'), undefined, { what: 'the list' });
  // A letter typed, and Escape once the caret's move has been heard (as a key pressed after it is)
  // but before the next frame, when the module would draw the letter's list.
  const shown = await page.evaluate((sel) => new Promise((done) => {
    document.addEventListener('selectionchange', () => {
      document.querySelector(sel).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const seen = [];
      let frames = 0;
      const step = () => { seen.push(!!document.getElementById('searchSuggest')); if (++frames < 6) requestAnimationFrame(step); else done(seen); };
      requestAnimationFrame(step);
    }, { once: true });
    document.execCommand('insertText', false, 'f');
  }), BOX);
  assert.equal(await page.$eval(BOX, (el) => el.textContent), 'f', 'the letter typed');
  assert.deepEqual(shown, Array(6).fill(false), 'closed, and not drawn again');
  assert.deepEqual(page.problems, []);
});

// That test failed once in the whole suite (2026-11-26) and passed alone. Traced, twelve copies at
// once with every frame asked for after the Escape recorded with its caller: in 7 of 47 the list was
// drawn again, each time by the library's tags, read as the box gains focus, coming back after the
// Escape. A closed list stays closed until a key, a move of the caret or focus opens it; the tags
// coming in fill a list that is showing or awaited, and open none. Here the read is held back.
const heldTags = (page) => page.evaluate(async () => {
  const api = await import('/app/js/api.js');
  api.galleries.tagCounts = () => new Promise((answer) => { globalThis.__tagsIn = () => answer(new Map([['artist:zzq somebody', 3]])); });
});
const frames = (page, n) => page.evaluate((n) => new Promise((done) => { const step = () => (n-- > 0 ? requestAnimationFrame(step) : done()); step(); }), n);

test('the library\'s tags coming in after Escape leave the list closed; the next key opens it with them', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await heldTags(page);
  await page.$eval('#searchClear', (b) => b.click());
  await until(page, () => !!document.getElementById('searchSuggest') && typeof globalThis.__tagsIn === 'function', undefined, { what: 'the list, its tags asked for' });
  await page.keyboard.press('Escape');
  await until(page, () => !document.getElementById('searchSuggest'), undefined, { what: 'closed by Escape' });
  await page.evaluate(() => globalThis.__tagsIn());
  await frames(page, 6);
  assert.equal(await list(page), null, 'still closed with the tags in');
  await page.keyboard.type('zzq');
  await until(page, () => (document.getElementById('searchSuggest')?.textContent || '').includes('zzq somebody'), undefined, { what: 'the list again, the tag in it' });
  assert.deepEqual(page.problems, []);
});

test('the library\'s tags coming in fill a list that had nothing to show yet', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await heldTags(page);
  await page.$eval('#searchClear', (b) => b.click());
  await until(page, () => !!document.getElementById('searchSuggest') && typeof globalThis.__tagsIn === 'function', undefined, { what: 'the list, its tags asked for' });
  // A word no filter answers to, the tags not in yet: nothing to list, and nobody closed it.
  await page.keyboard.type('zzq');
  await until(page, () => !document.getElementById('searchSuggest'), undefined, { what: 'nothing to list' });
  await page.evaluate(() => globalThis.__tagsIn());
  await until(page, () => (document.getElementById('searchSuggest')?.textContent || '').includes('zzq somebody'), undefined, { what: 'the tag listed as the tags come in' });
  assert.deepEqual(page.problems, []);
});

test('on a phone, the library header\'s form: the search on a row of its own under the rest', async (t) => {
  const page = await componentsPage(t, browser, origin, { width: 390, height: 844, isMobile: true, hasTouch: true });
  if (!page) return;
  const form = await page.$eval(spec('app-header', 'library'), (h) => {
    const r = h.getBoundingClientRect(), box = (sel) => { const b = h.querySelector(sel).getBoundingClientRect(); return [+(b.left - r.left).toFixed(2), +(b.top - r.top).toFixed(2), +b.width.toFixed(2), +b.height.toFixed(2)]; };
    return { header: [r.width, r.height], padding: getComputedStyle(h).padding, text: getComputedStyle(h.querySelector('.brand-text')).display, sep: getComputedStyle(h.querySelector('.brand-sep')).display, brand: box('.brand-wrap'), search: box('.header-search') };
  });
  // Where 1.3's phone library header has them (baseline: phone/library-default).
  assert.deepEqual(form, { header: [390, 103], padding: '7px 12px', text: 'none', sep: 'none', brand: [12, 15, 24, 24], search: [12, 55, 366, 40] });
  assert.deepEqual(page.problems, []);
});

// ui-empty-state.browser.mjs — EmptyState (src/components/ui/empty-state.tsx) as /components shows it:
// each variant's type and spacing as 1.3's (the library's lines 2× apart, Tasks' at the normal line,
// the overview's 13px: F23), the full screen's icon over its message and links 12px apart, the
// icon hidden from a screen reader, a loading line a status.
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

const read = (page, sel) => page.$eval(sel, (el) => { const s = getComputedStyle(el); return [s.fontSize, s.lineHeight, s.padding, s.textAlign, s.color]; });

test('each empty as its place had it', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const MUTED = 'rgb(161, 161, 170)';
  assert.deepEqual(await read(page, spec('empty', 'library')), ['13px', '26px', '80px 20px', 'center', MUTED]);
  assert.deepEqual(await read(page, spec('empty', 'tasks')), ['13px', 'normal', '80px 20px', 'center', MUTED]);
  assert.deepEqual(await read(page, spec('loading-text', 'page')), ['13px', 'normal', '80px 20px', 'center', MUTED], 'the overview\'s 14 → 13px (F23)');
  assert.deepEqual(await read(page, spec('small-empty', 'md')), ['12px', 'normal', '24px 0px', 'center', MUTED]);
  assert.deepEqual(await read(page, spec('small-empty', 'sm')), ['12px', 'normal', '10px', 'center', MUTED]);
  assert.deepEqual(await read(page, spec('loading-text', 'note')), ['10px', '15.5px', '0px', 'left', MUTED]);
  assert.equal(await page.$eval(spec('loading-text', 'page'), (el) => el.getAttribute('role')), 'status');
  assert.deepEqual(page.problems, []);
});

test('the full screen: an icon over its message and links, 12px apart, the icon hidden from a screen reader', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const screen = await page.$eval(spec('reader-empty', 'screen'), (el) => {
    const icon = el.querySelector('[data-slot="empty-icon"]'), msg = el.querySelector('[data-slot="empty-message"]'), link = el.querySelector('a');
    const i = icon.getBoundingClientRect(), m = msg.getBoundingClientRect(), l = link.getBoundingClientRect();
    return { gaps: [Math.round(m.top - i.bottom), Math.round(l.top - m.bottom)], hidden: icon.getAttribute('aria-hidden'), sizes: [getComputedStyle(icon).fontSize, getComputedStyle(msg).fontSize, getComputedStyle(msg).lineHeight, getComputedStyle(link).fontSize, getComputedStyle(link).color],
      ground: getComputedStyle(el).backgroundColor };
  });
  assert.deepEqual(screen, { gaps: [12, 12], hidden: 'true', sizes: ['48px', '12px', '21.6px', '11px', 'rgb(237, 39, 84)'], ground: 'rgb(10, 10, 12)' });
});

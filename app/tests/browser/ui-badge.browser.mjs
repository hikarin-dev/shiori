// ui-badge.browser.mjs — Badge (src/components/ui/badge.tsx) as /components shows it: a label that
// does nothing (not reached by Tab, no role of its own); a kind and the runner tag beside it level at
// 16px; Settings' and the dialogs' badges one size, 20px (the status pills, the version tag); the
// series card's count 22px and a page tile's number 14 as today, both letting the pointer through to
// the picture; each status tone a tint of 8% framed at 28%.
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

// (A colour mixed in CSS reads back as color(srgb …): written here as rgba to compare.)
const read = (page, sel) => page.$eval(sel, (el) => {
  const s = getComputedStyle(el);
  const rgba = (c) => c.replace(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+) \/ ([\d.]+)\)$/, (_, r, g, b, a) => `rgba(${[r, g, b].map((v) => Math.round(v * 255)).join(', ')}, ${a})`);
  return { h: el.getBoundingClientRect().height, tab: el.tabIndex, role: el.getAttribute('role'), ground: s.backgroundColor, frame: rgba(s.borderTopColor), color: s.color, weight: s.fontWeight, events: s.pointerEvents };
});

test('heights: 16 in the tasks\' rows, 20 in Settings and the dialogs, 22 and 14 over pictures', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const heights = {};
  for (const [shape, variant] of [['kind', 'warning'], ['kind', 'neutral'], ['run-tag', 'quiet'], ['key-status-badge', 'neutral'], ['key-status-badge', 'warning'],
    ['pp-chip', 'success'], ['pp-chip', 'muted'], ['about-version', 'quiet'], ['card-series-badge', 'overlay'], ['card-series-badge', 'page'], ['pp-tag', 'quiet'], ['inverse-badge', 'inverse']]) {
    const b = await read(page, spec(shape, variant));
    heights[`${shape}/${variant}`] = b.h;
    assert.deepEqual([b.tab, b.role], [-1, null], `${shape}/${variant}: not a control`);
  }
  assert.deepEqual(heights, {
    'kind/warning': 16, 'kind/neutral': 16, 'run-tag/quiet': 16,
    'key-status-badge/neutral': 20, 'key-status-badge/warning': 20, 'pp-chip/success': 20, 'pp-chip/muted': 20, 'about-version/quiet': 20,
    'card-series-badge/overlay': 22, 'card-series-badge/page': 14, 'pp-tag/quiet': 16, 'inverse-badge/inverse': 16,
  });
  assert.equal((await read(page, spec('card-series-badge', 'overlay'))).events, 'none', 'the pointer goes through to the cover');
  assert.equal((await read(page, spec('card-series-badge', 'page'))).events, 'none');
  assert.deepEqual(page.problems, []);
});

test('the status tones: a tint of 8%, a frame of 28%, one weight', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const pick = (b) => [b.ground, b.frame, b.color, b.weight];
  assert.deepEqual(pick(await read(page, spec('key-status-badge', 'success'))), ['rgba(6, 214, 160, 0.08)', 'rgba(6, 214, 160, 0.28)', 'rgb(6, 214, 160)', '400']);
  assert.deepEqual(pick(await read(page, spec('key-status-badge', 'warning'))), ['rgba(255, 209, 102, 0.08)', 'rgba(255, 209, 102, 0.28)', 'rgb(255, 209, 102)', '400']);
  assert.deepEqual(pick(await read(page, spec('pp-chip', 'primary'))), ['rgba(237, 39, 84, 0.08)', 'rgba(237, 39, 84, 0.28)', 'rgb(237, 39, 84)', '400']);
  assert.deepEqual(pick(await read(page, spec('key-status-badge', 'neutral'))), ['rgba(0, 0, 0, 0)', 'rgb(63, 63, 72)', 'rgb(244, 244, 245)', '400']);
  assert.deepEqual(pick(await read(page, spec('pp-chip', 'muted'))), ['rgba(0, 0, 0, 0)', 'rgb(42, 42, 48)', 'rgb(161, 161, 170)', '400']);
  // A kind in its button's colour; the quiet ones the dimmest grey with no ground.
  assert.deepEqual(pick(await read(page, spec('kind', 'primary'))).slice(1, 3), ['rgb(74, 26, 38)', 'rgb(237, 39, 84)']);
  assert.deepEqual(pick(await read(page, spec('about-version', 'quiet'))).slice(0, 3), ['rgba(0, 0, 0, 0)', 'rgb(42, 42, 48)', 'rgb(124, 124, 140)']);
  // A long status wraps in a narrow place rather than running out of it.
  const wraps = await page.$eval(spec('key-status-badge', 'warning'), (el) => { el.parentElement.style.width = '60px'; return el.getBoundingClientRect().width <= 60 && el.getBoundingClientRect().height > 20; });
  assert.equal(wraps, true);
});

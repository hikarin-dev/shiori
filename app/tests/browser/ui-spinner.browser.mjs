// ui-spinner.browser.mjs — Spinner (src/components/ui/spinner.tsx) as /components shows it, held to
// 1.3's stylesheet values (nothing of it was captured): the ring 32px with a 3px border (the reader's
// .spinner, a pending page's marker) and 13px with a 2px one (the status line's), the border's grey
// with a brand-coloured arc, one turn in .8s at an even pace; an icon given turns, 16px, in the
// colour around it. A lone spinner is a status with a name; one beside words is hidden from a screen
// reader. With less motion asked for, it stands still.
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

const read = (page, sel) => page.$eval(sel, (el) => {
  // (Its layout box: the client rect of a turning element is the rect round its turned box.)
  const s = getComputedStyle(el);
  return { box: [parseFloat(s.width), parseFloat(s.height), s.boxSizing], border: [s.borderTopWidth, s.borderRightColor, s.borderTopColor], radius: s.borderTopLeftRadius,
    animation: [s.animationName, s.animationDuration, s.animationTimingFunction, s.animationIterationCount],
    role: el.getAttribute('role'), label: el.getAttribute('aria-label'), hidden: el.getAttribute('aria-hidden') };
});

test('the ring in two sizes and an icon, each turning once in .8s; a status when alone, hidden beside words', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const TURN = ['spin', '0.8s', 'linear', 'infinite'];
  const lg = await read(page, spec('spinner', 'ring'));
  assert.deepEqual(lg.box, [32, 32, 'border-box']);
  assert.deepEqual(lg.border, ['3px', 'rgb(42, 42, 48)', 'rgb(237, 39, 84)']);
  assert.equal(lg.radius, '50%');
  assert.deepEqual(lg.animation, TURN);
  assert.deepEqual([lg.role, lg.label, lg.hidden], ['status', 'Loading…', null], 'alone: a status, named');
  const sm = await read(page, spec('spinner-inline', 'ring'));
  assert.deepEqual(sm.box, [13, 13, 'border-box']);
  assert.deepEqual(sm.border, ['2px', 'rgb(42, 42, 48)', 'rgb(237, 39, 84)']);
  assert.deepEqual(sm.animation, TURN);
  assert.deepEqual([sm.role, sm.hidden], [null, 'true'], 'beside its words: decoration');
  const icon = await read(page, spec('spinner-inline', 'icon'));
  assert.deepEqual(icon.animation, TURN);
  assert.deepEqual(await page.$eval(spec('spinner-inline', 'icon'), (el) => { const s = getComputedStyle(el.querySelector('svg')); return [parseFloat(s.width), parseFloat(s.height), s.stroke]; }),
    [16, 16, 'rgb(161, 161, 170)'], 'the icon, 16px (S13), in the colour around it');
  // It turns about its centre: the centre of its turned box stays where it is through a turn.
  const at = await page.$eval(spec('spinner', 'ring'), (el) => {
    const c = () => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
    const a = c();
    return new Promise((done) => setTimeout(() => { const b = c(); done([Math.abs(a[0] - b[0]) < 0.01, Math.abs(a[1] - b[1]) < 0.01]); }, 200));
  });
  assert.deepEqual(at, [true, true]);
  assert.deepEqual(page.problems, []);
});

test('with less motion asked for, a spinner stands still', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const running = await page.$eval(spec('spinner', 'ring'), (el) => new Promise((done) => setTimeout(() => done(el.getAnimations().filter((a) => a.playState === 'running').length), 100)));
  assert.equal(running, 0);
});

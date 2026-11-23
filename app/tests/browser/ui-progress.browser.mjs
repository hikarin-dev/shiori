// ui-progress.browser.mjs — Progress and Meter (src/components/ui/progress.tsx) as /components shows
// them: a progressbar with its value, range and name, and none of a value when it has no figure; a
// job's fill in the second accent, the success colour once done; with no figure, F22's one motion (a
// block 35% wide travelling from off the start to off the end in 1.2s, at an even pace), resting at
// the start when less motion is asked for; the fill's width easing as each bar's did; Meter a meter,
// drawn as Chromium drew one.
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

const aria = (page, sel) => page.$eval(sel, (el) => ['role', 'aria-label', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext'].map((a) => el.getAttribute(a)));
const fill = (page, sel) => page.$eval(sel, (el) => {
  const f = el.querySelector('[data-slot="progress-indicator"]'), s = getComputedStyle(f), r = f.getBoundingClientRect(), t = el.getBoundingClientRect();
  return { share: +(r.width / t.width).toFixed(4), height: r.height, ground: s.backgroundColor, image: s.backgroundImage, transition: [s.transitionProperty, s.transitionDuration],
    track: [t.height, getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopLeftRadius] };
});

test('a progressbar with its value, range and name; a job in the second accent, done in the success colour; a dialog\'s in the brand colour', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  assert.deepEqual(await aria(page, spec('prog', 'job')), ['progressbar', 'Downloading', '40', '0', '100', '40%']);
  const job = await fill(page, spec('prog', 'job'));
  assert.deepEqual([job.share, job.height, job.ground], [0.4, 3, 'rgb(255, 209, 102)']);
  assert.deepEqual(job.track, [3, 'rgb(42, 42, 48)', '2px']);
  assert.deepEqual(job.transition, ['width', '0.25s'], 'its width eases as a job bar\'s did');
  const done = await fill(page, spec('prog', 'job', 'on'));
  assert.deepEqual([done.share, done.ground], [1, 'rgb(6, 214, 160)']);
  assert.deepEqual(await aria(page, spec('notice-bar', 'accent')), ['progressbar', 'Restoring', '1', '0', '3', '33%']);
  const dialog = await fill(page, spec('notice-bar', 'accent'));
  assert.deepEqual([dialog.share, dialog.ground], [0.3333, 'rgb(237, 39, 84)']);
  assert.deepEqual(dialog.track, [6, 'rgb(42, 42, 48)', '999px']);
  assert.deepEqual(dialog.transition, ['width', '0.2s'], 'a dialog\'s eases as it did');
  assert.deepEqual(await textMotion(page, '[data-section="progress"]'), []);
  assert.deepEqual(page.problems, []);
});

test('with no figure: no value, and a block 35% wide travels across from off the start to off the end in 1.2s', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  for (const sel of [spec('prog', 'job-unknown'), spec('lf-bar', 'job-unknown'), spec('notice-bar', 'accent-unknown')]) {
    const [role, , now, , , text] = await aria(page, sel);
    assert.deepEqual([role, now, text], ['progressbar', null, null], `${sel}: a progressbar with no value and no words for one`);
    const travel = await page.$eval(sel, (el) => {
      const f = el.querySelector('[data-slot="progress-indicator"]'), [a] = f.getAnimations(), t = el.getBoundingClientRect();
      const at = (ms) => { a.currentTime = ms; const r = f.getBoundingClientRect(); return [+((r.left - t.left) / t.width).toFixed(2), +((r.right - t.left) / t.width).toFixed(2)]; };
      a.pause();
      const timing = a.effect.getComputedTiming();
      return { name: a.animationName, duration: timing.duration, iterations: timing.iterations === Infinity ? 'endless' : timing.iterations, easing: timing.easing, start: at(0), middle: at(600), end: at(1199.99) };
    });
    assert.deepEqual([travel.name, travel.duration, travel.iterations, travel.easing], ['progress-travel', 1200, 'endless', 'linear'], sel);
    assert.deepEqual(travel.start, [-0.35, 0], 'off the start');
    assert.deepEqual(travel.middle, [0.33, 0.68], 'half way at half time (-35% → 101.5%): an even pace');
    assert.ok(travel.end[0] >= 1, `off the end (${travel.end})`);
  }
  const ground = (sel) => page.$eval(sel, (el) => getComputedStyle(el.querySelector('[data-slot="progress-indicator"]')).backgroundImage);
  assert.match(await ground(spec('prog', 'job-unknown')), /^linear-gradient\(90deg, rgba\(0, 0, 0, 0\), rgb\(255, 209, 102\), rgba\(0, 0, 0, 0\)\)$/, 'a job\'s block soft-edged');
  assert.equal(await ground(spec('notice-bar', 'accent-unknown')), 'none', 'a dialog\'s solid');
  assert.deepEqual(page.problems, []);
});

test('with less motion asked for, the block rests at the start', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const at = await page.$eval(spec('prog', 'job-unknown'), (el) => new Promise((done) => setTimeout(() => {
    const f = el.querySelector('[data-slot="progress-indicator"]'), r = f.getBoundingClientRect(), t = el.getBoundingClientRect();
    done([f.getAnimations().filter((a) => a.playState === 'running').length, r.left - t.left, +(r.width / t.width).toFixed(3)]);
  }, 100)));
  assert.deepEqual(at, [0, 0, 0.35]);
});

test('a meter: its value and name, a 10px pill in a 20px box in Chromium\'s meter colours', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const sel = spec('meter', 'meter');
  assert.deepEqual(await aria(page, sel), ['meter', 'Model A seconds per page', '6', '0', '10', '60%']);
  const look = await page.$eval(sel, (el) => {
    const track = el.querySelector('[data-slot="meter-track"]'), f = el.querySelector('[data-slot="meter-indicator"]');
    const b = el.getBoundingClientRect(), tr = track.getBoundingClientRect(), fr = f.getBoundingClientRect(), ts = getComputedStyle(track);
    return { box: b.height, track: [tr.top - b.top, tr.height, ts.borderTopColor, ts.backgroundColor, ts.borderTopLeftRadius], fill: [+(fr.width / (tr.width - 2)).toFixed(3), fr.height, getComputedStyle(f).backgroundColor] };
  });
  assert.deepEqual(look, { box: 20, track: [5, 10, 'rgb(133, 133, 133)', 'rgb(59, 59, 59)', '999px'], fill: [0.6, 8, 'rgb(116, 179, 116)'] });
});

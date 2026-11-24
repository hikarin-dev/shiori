// ui-button.browser.mjs — the Button (src/components/ui/button.tsx) as /components shows it: a real
// button (or a link) reached by Tab in order, pressed by Enter and Space, skipped and inert when
// disabled; its on state said to assistive technology; the keyboard ring only after a key; its box
// the same whatever state it is in; nothing holding text fading or moving; the finger sizes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, spec, centreOf, boxes, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('a button is a button: Tab reaches each in order, Enter and Space press it, a disabled one is skipped and inert', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const order = await page.evaluate(() => {
    window.__pressed = [];
    const all = [...document.querySelectorAll('[data-section="button"] [data-specimen]')];
    for (const el of all) el.addEventListener('click', (e) => { e.preventDefault(); window.__pressed.push(el.dataset.specimen + '/' + el.dataset.variant + '/' + el.dataset.specimenState); });
    return all.filter((el) => !el.matches(':disabled')).map((el) => el.dataset.specimen + '/' + el.dataset.variant + '/' + el.dataset.specimenState);
  });
  // Every button specimen is a native button but the link, which is an <a href>.
  const kinds = await page.evaluate(() => [...new Set([...document.querySelectorAll('[data-section="button"] [data-specimen]')].map((el) => `${el.localName}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}`))]);
  assert.deepEqual(kinds.sort(), ['a', 'button']);
  // Tab from just before the first: each enabled specimen in turn, none of the disabled ones.
  await page.evaluate(() => { const b = document.querySelector('[data-section="button"]'); const s = document.createElement('button'); s.id = 'start'; b.prepend(s); s.focus(); });
  const seen = [];
  for (let i = 0; i < order.length; i++) {
    await page.keyboard.press('Tab');
    seen.push(await page.evaluate(() => { const el = document.activeElement; return `${el.dataset.specimen}/${el.dataset.variant}/${el.dataset.specimenState}`; }));
  }
  assert.deepEqual(seen, order, 'Tab follows the page order and skips disabled buttons');
  // Enter and Space press a button; Enter follows a link.
  const target = spec('btn', 'primary');
  await page.focus(target);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await page.focus(spec('link', 'link'));
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.__pressed), ['btn/primary/rest', 'btn/primary/rest', 'link/link/rest']);
  // A disabled one: a click does nothing.
  await page.evaluate(() => { window.__pressed = []; });
  const at = await centreOf(page, spec('btn', 'primary', 'disabled'));
  await page.mouse.click(at.x, at.y);
  assert.deepEqual(await page.evaluate(() => window.__pressed), []);
  assert.equal(await page.$eval(spec('btn', 'primary', 'disabled'), (el) => el.disabled), true);
  assert.deepEqual(page.problems, []);
});

test('an on button says so (aria-pressed), an open one aria-expanded', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const on = await page.$$eval('[data-section="button"] [data-specimen-state="on"]', (els) => els.map((el) => [el.dataset.specimen, el.getAttribute('aria-pressed') ?? el.getAttribute('aria-expanded') ?? (el.dataset.specimen === 'card-btn' ? 'done' : null)]));
  assert.ok(on.length >= 8);
  for (const [shape, value] of on) assert.ok(['true', 'done'].includes(value), `${shape}: on is announced (${value})`);
  // The on look comes from the attribute: a quiet button pressed takes its pressed tone.
  const safe = await page.$eval(spec('header-icon', 'quiet-warning', 'on'), (el) => getComputedStyle(el).color);
  assert.equal(safe, 'rgb(6, 214, 160)', 'Safe mode on: the success tone');
});

test('the keyboard ring shows after a key, never after a click', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const ring = () => page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  const at = await centreOf(page, spec('btn', 'outline'));
  await page.mouse.click(at.x, at.y);
  assert.equal(await ring(), 'none');
  await page.keyboard.press('Tab');
  assert.equal(await ring(), 'solid');
});

test('hover, press and focus change no box, and no text fades or moves', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const rests = await page.$$eval('[data-section="button"] [data-specimen-state="rest"]', (els) => els.map((el) => `[data-specimen="${el.dataset.specimen}"][data-variant="${el.dataset.variant}"][data-specimen-state="rest"]`));
  for (const sel of rests) {
    const [before] = await boxes(page, sel);
    const at = await centreOf(page, sel);
    const [still] = await boxes(page, sel);
    await page.mouse.move(at.x, at.y);
    const [hovered] = await boxes(page, sel);
    await page.mouse.down();
    const [pressed] = await boxes(page, sel);
    await page.mouse.up();
    await page.mouse.move(1, 1);
    for (const [what, box] of [['hovered', hovered], ['pressed', pressed]]) assert.deepEqual(box.slice(2), before.slice(2), `${sel} ${what}: same size`);
    assert.deepEqual(hovered, still, `${sel}: hovered, it stays where it was`);
    assert.deepEqual(pressed, still, `${sel}: pressed, it stays where it was (no 1px press, F02)`);
  }
  assert.deepEqual(await textMotion(page, '[data-section="button"] [data-specimen]'), []);
});

test('under a coarse pointer each button grows to the finger size today\'s page gives it', async (t) => {
  const page = await componentsPage(t, browser, origin, { width: 390, height: 844, hasTouch: true, isMobile: true });
  if (!page) return;
  const size = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return [r.width, r.height]; });
  assert.deepEqual(await size(spec('header-icon', 'quiet-primary')), [40, 40], 'header icon: 40');
  assert.deepEqual(await size(spec('card-btn', 'quiet-primary')), [36, 36], 'card action: 36');
  assert.deepEqual(await size(spec('tk-stop', 'quiet-danger')), [44, 44], 'task Stop: 44');
  assert.equal((await size(spec('ib-btn', 'quiet')))[1], 44, 'tracker text button: 44 tall');
  assert.equal((await size(spec('btn-stop-all', 'tint-danger')))[1], 40, 'Stop all: 40 tall');
  assert.deepEqual(await size(spec('btn', 'outline')), [73.203125, 36], 'a dialog button keeps its size (12px, S11)');
});

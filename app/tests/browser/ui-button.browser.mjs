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
  // The on look comes from the attribute: a button pressed takes its pressed tone.
  const safe = await page.$eval(spec('header-icon', 'ghost-safe', 'on'), (el) => getComputedStyle(el).color);
  assert.equal(safe, 'rgb(6, 214, 160)', 'Safe mode on: the success tone');
});

// §5.3 F60 (the owner, 2026-11-25): a button's words and icon are the text colour at rest, never the
// muted grey (it read as disabled), and the brand's red is not on translate; the header's buttons have
// no frame and take the raised ground under the pointer; Import is filled in its yellow.
test('at rest a button is the text colour; the header\'s have no frame and fill under the pointer; Import is filled', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const look = (sel) => page.$eval(sel, (el) => { const cs = getComputedStyle(el); return { text: cs.color, ground: cs.backgroundColor, frame: cs.borderTopColor, filter: cs.filter }; });
  const TEXT = 'rgb(244, 244, 245)', NONE = 'rgba(0, 0, 0, 0)', RAISED = 'rgb(28, 28, 33)', YELLOW = 'rgb(255, 209, 102)';
  // Plain at rest, whatever the family: the text colour.
  for (const [shape, variant] of [['header-icon', 'ghost-menu'], ['header-icon', 'ghost-settings'], ['header-icon', 'ghost-pin'], ['header-icon', 'ghost-safe'], ['btn-about', 'ghost'],
    ['icon-btn', 'ghost'], ['btn-mini', 'subtle'], ['card-btn', 'quiet'], ['card-btn', 'quiet-warning'], ['filter-btn', 'quiet-toolbar'], ['tk-stop', 'quiet-danger'], ['card-fav', 'overlay']]) {
    assert.equal((await look(spec(shape, variant))).text, TEXT, `${shape} ${variant}: the text colour at rest`);
  }
  // A tone at rest where the colour says something: download, delete; translated, in the colour of success.
  assert.equal((await look(spec('card-btn', 'quiet-warning-fill'))).text, YELLOW, 'download: its yellow');
  assert.equal((await look(spec('card-btn', 'quiet-danger-fill'))).text, 'rgb(255, 100, 103)', 'delete: its red');
  assert.equal((await look(spec('card-btn', 'quiet', 'on'))).text, 'rgb(6, 214, 160)', 'translated: the colour of success');
  // The header's buttons: no frame at rest or under the pointer, the raised ground under it; on, the
  // pressed tone's words on its tint, still no frame.
  for (const variant of ['ghost-menu', 'ghost-settings', 'ghost-pin', 'ghost-safe']) {
    const rest = await look(spec('header-icon', variant)), hover = await look(spec('header-icon', variant, 'hover'));
    assert.deepEqual([rest.frame, rest.ground], [NONE, NONE], `${variant}: no frame, no ground at rest`);
    assert.deepEqual([hover.frame, hover.ground, hover.text], [NONE, RAISED, TEXT], `${variant}: the raised ground under the pointer, no frame`);
  }
  const on = await look(spec('header-icon', 'ghost-safe', 'on'));
  assert.deepEqual([on.frame, on.text], [NONE, 'rgb(6, 214, 160)'], 'Safe Mode on: no frame');
  assert.notEqual(on.ground, NONE, 'Safe Mode on: on its tint');
  const about = await look(spec('btn-about', 'ghost', 'hover'));
  assert.deepEqual([about.frame, about.ground], [NONE, RAISED], 'About: as the header\'s other buttons');
  // Import: filled at rest, its words dark on it; brighter under the pointer, never darker.
  for (const variant of ['tint-warning', 'tint-warning-icon']) {
    const rest = await look(spec('btn-upload', variant)), hover = await look(spec('btn-upload', variant, 'hover'));
    assert.deepEqual([rest.ground, rest.frame, rest.text, rest.filter], [YELLOW, YELLOW, 'rgb(17, 17, 17)', 'none'], `${variant}: filled in its yellow`);
    assert.deepEqual([hover.ground, hover.text, hover.filter], [YELLOW, 'rgb(17, 17, 17)', 'brightness(1.1)'], `${variant}: brighter under the pointer`);
  }
  assert.deepEqual(page.problems, []);
});

// §5.3 F61 (the owner, 2026-11-25: "try switch my danger color profile to the destructive color of
// shadcn"): danger is shadcn's destructive on its dark theme (oklch(0.704 0.191 22.216), as sRGB), and
// a danger fill under white words is that colour at 60%, as shadcn fills its destructive button there
// (white on the colour itself is 2.9:1), framed in the colour.
test('danger is shadcn\'s destructive: the colour in words and frames, its 60% under white words', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const look = (sel) => page.$eval(sel, (el) => { const cs = getComputedStyle(el); return [cs.backgroundColor, cs.borderTopColor, cs.color]; });
  const RED = 'rgb(255, 100, 103)', FILL = 'rgba(255, 100, 103, 0.6)', WHITE = 'rgb(255, 255, 255)', NONE = 'rgba(0, 0, 0, 0)';
  // A dialog's filled button.
  assert.deepEqual(await look(spec('btn', 'danger')), [FILL, RED, WHITE], 'a dialog\'s danger button');
  // Settings' outline: the colour at rest, the fill under the pointer.
  assert.deepEqual(await look(spec('btn-clear-all', 'tint-danger')), [NONE, RED, RED], 'Clear All at rest');
  assert.deepEqual(await look(spec('btn-clear-all', 'tint-danger', 'hover')), [FILL, RED, WHITE], 'Clear All under the pointer');
  // A card's delete: the colour at rest, the fill under the pointer.
  assert.equal((await look(spec('card-btn', 'quiet-danger-fill')))[2], RED);
  assert.deepEqual(await look(spec('card-btn', 'quiet-danger-fill', 'hover')), [FILL, RED, WHITE], 'a card\'s delete under the pointer');
  // The other tones fill with the tone itself.
  assert.equal((await look(spec('card-btn', 'quiet-warning-fill', 'hover')))[0], 'rgb(255, 209, 102)', 'download: its yellow, whole');
  assert.deepEqual(page.problems, []);
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
  assert.deepEqual(await size(spec('header-icon', 'ghost-settings')), [40, 40], 'header icon: 40');
  assert.deepEqual(await size(spec('card-btn', 'quiet')), [36, 36], 'card action: 36');
  assert.deepEqual(await size(spec('tk-stop', 'quiet-danger')), [44, 44], 'task Stop: 44');
  assert.equal((await size(spec('ib-btn', 'quiet')))[1], 44, 'tracker text button: 44 tall');
  assert.equal((await size(spec('btn-stop-all', 'tint-danger')))[1], 40, 'Stop all: 40 tall');
  assert.deepEqual(await size(spec('btn', 'outline')), [73.203125, 36], 'a dialog button keeps its size (12px, S11)');
});

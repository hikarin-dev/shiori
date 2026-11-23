// ui-option-card.browser.mjs — OptionCard (src/components/ui/option-card.tsx) as /components shows
// it: a card that is a button (named by its title and line, chosen by a click, Enter or Space); a
// radio group of cards where the whole card is the target, the arrows move the choice and the chosen
// card is framed in the brand colour; one padding, 12px 14px.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch } from './harness.mjs';
import { componentsPage, spec, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('a card that is a button: its name, chosen by a click or a key', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const sel = spec('notice-choice', 'button');
  const look = await page.$eval(sel, (el) => { const s = getComputedStyle(el); return [el.localName, el.getAttribute('type'), el.textContent, s.padding, s.borderTopLeftRadius, s.borderTopColor]; });
  assert.deepEqual(look, ['button', 'button', 'Open Shiori DesktopYour library, as you left it', '12px 14px', '8px', 'rgb(63, 63, 72)']);
  assert.equal(await page.$eval(spec('notice-choice', 'button', 'hover'), (el) => getComputedStyle(el).borderTopColor), 'rgb(237, 39, 84)');
  await page.$eval(sel, (el) => { window.__chosen = 0; el.addEventListener('click', () => window.__chosen++); });
  const at = await centreOf(page, sel);
  await page.mouse.click(at.x, at.y);
  await page.focus(sel);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => window.__chosen), 3);
  assert.deepEqual(await textMotion(page, '[data-section="option-card"]'), []);
  assert.deepEqual(page.problems, []);
});

test('radio cards: the whole card is the target, the arrows move the choice, the chosen one framed', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const state = () => page.$eval(spec('native-radio', 'card-on', 'on'), (on) => [...on.closest('[role="radiogroup"]').querySelectorAll('[data-slot="option-card"]')]
    .map((c) => [c.querySelector('[role="radio"]').getAttribute('aria-checked'), getComputedStyle(c).borderTopColor]));
  const second = `${spec('native-radio', 'card-on', 'on')} + [data-slot="option-card"]`;
  assert.deepEqual(await state(), [['true', 'rgb(237, 39, 84)'], ['false', 'rgb(63, 63, 72)']]);
  // A click on the second card's line under its title chooses it.
  const line = await centreOf(page, `${second} [data-slot="option-detail"]`);
  await page.mouse.click(line.x, line.y);
  assert.deepEqual(await state(), [['false', 'rgb(63, 63, 72)'], ['true', 'rgb(237, 39, 84)']]);
  // The keyboard: the arrows move the choice within the group.
  await page.focus(`${second} [role="radio"]`);
  await page.keyboard.press('ArrowUp');
  assert.deepEqual((await state()).map(([c]) => c), ['true', 'false']);
  assert.equal(await page.evaluate(() => document.activeElement.closest('[data-slot="option-card"]').dataset.variant), 'card-on');
  await page.keyboard.press('ArrowDown');
  assert.deepEqual((await state()).map(([c]) => c), ['false', 'true']);
  assert.deepEqual(page.problems, []);
});

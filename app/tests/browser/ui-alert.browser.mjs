// ui-alert.browser.mjs — Alert and StatusText (src/components/ui/alert.tsx) as /components shows them:
// the note's frame and type; a status line a polite status, 10.5px at its line's end in its tone;
// hidden, it takes no room in a section and keeps a line in a row; it fades by its colour, never by
// opacity (rule 11).
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

test('a note, and a status line in its tones, shown and hidden', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const note = await page.$eval(spec('caps-note', 'alert'), (el) => { const s = getComputedStyle(el); return [s.padding, s.borderTopColor, s.borderTopLeftRadius, s.fontSize, s.color]; });
  assert.deepEqual(note, ['9px 11px', 'rgb(42, 42, 48)', '6px', '11px', 'rgb(161, 161, 170)']);
  const status = (variant) => page.$eval(spec('status-msg', variant), (el) => {
    const s = getComputedStyle(el);
    return { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), size: s.fontSize, align: s.textAlign, color: s.color, height: el.getBoundingClientRect().height, padding: s.padding, visibility: s.visibility };
  });
  const ok = await status('ok');
  assert.deepEqual([ok.role, ok.live, ok.size, ok.align, ok.color], ['status', 'polite', '10.5px', 'right', 'rgb(6, 214, 160)']);
  const err = await status('err');
  assert.deepEqual([err.color, err.padding], ['rgb(255, 90, 54)', '0px 20px 14px']);
  const hidden = await status('hidden');
  assert.deepEqual([hidden.height, hidden.visibility], [0, 'hidden'], 'hidden in a section: no room');
  assert.equal((await status('muted')).color, 'rgb(161, 161, 170)');
  // Its fade is its colour's (and visibility's, which holds it visible till the colour has gone).
  assert.equal(await page.$eval(spec('status-msg', 'ok'), (el) => getComputedStyle(el).transitionProperty), 'color, visibility');
  assert.deepEqual(await textMotion(page, '[data-section="alert"]'), []);
  // Hidden in a row of buttons, it keeps a line's height.
  const kept = await page.$eval(spec('status-msg', 'ok'), (el) => { el.classList.add('invisible', 'text-transparent'); return el.getBoundingClientRect().height; });
  assert.ok(kept >= 15.75, `${kept}`);
  assert.deepEqual(page.problems, []);
});

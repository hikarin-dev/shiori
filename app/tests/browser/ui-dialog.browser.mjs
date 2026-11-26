// ui-dialog.browser.mjs — Dialog (src/components/ui/dialog.tsx) as /components shows it: the nine
// shapes at their widths with one set of sizes per layout (S16, F26–F29), and a working dialog: it
// traps focus and gives it back, Escape and the backdrop close it, the page and its scrollbar stay
// where they are, the box is centred by layout and never moves after its first frame (also with the
// CPU slowed six times), and a second dialog opened over it is the only one a key or a press closes.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { componentsPage, spec, centreOf, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const OUTER = '[data-specimen-dialog="outer"]', INNER = '[data-specimen-dialog="inner"]';

test('the shapes: widths, one frame, one title, the sizes of each layout', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const look = (sel) => page.$eval(sel, (el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const title = el.querySelector('[data-slot="dialog-title"]'), ts = getComputedStyle(title);
    const part = (slot) => { const p = el.querySelector(`[data-slot="${slot}"]`); return p ? +p.getBoundingClientRect().height.toFixed(2) : null; };
    const shadow = s.boxShadow.split(/,(?![^(]*\))/).map((x) => x.trim()).filter((x) => x !== 'rgba(0, 0, 0, 0) 0px 0px 0px 0px').join(', ');
    const contents = el.querySelector(':scope > [data-slot="dialog-contents"]');
    return { w: r.width, pad: s.padding, contents: contents && getComputedStyle(contents).padding, radius: s.borderTopLeftRadius, frame: s.borderTopColor, ground: s.backgroundColor, shadow,
      title: [ts.fontSize, ts.fontWeight, ts.lineHeight], header: part('dialog-header'), footer: part('dialog-footer'), transform: s.transform };
  });
  const widths = { 'notice-dialog/simple': 440, 'notice-ask/simple': 440, 'notice-ask/operation': 480, 'modal-box/simple': 340, 'modal-box/filter': 620,
    'settings-dialog/sectioned': 440, 'settings-dialog/close': 760, 'reader-settings/sectioned': 480, 'keys/simple': 440, 'pp-dialog/sectioned': 760, 'feedback/simple': 960 };
  for (const [id, w] of Object.entries(widths)) {
    const [shape, variant] = id.split('/');
    const l = await look(spec(shape, variant));
    assert.equal(l.w, w, id);
    assert.equal(l.radius, '12px', id);
    assert.equal(l.frame, 'rgb(63, 63, 72)', id);
    assert.equal(l.ground, 'rgb(22, 22, 26)', id);
    assert.equal(l.shadow, 'rgba(0, 0, 0, 0.5) 0px 20px 50px 0px', id);   // F26
    assert.deepEqual(l.title, ['15px', '700', '20px'], id);                // F28
    assert.equal(l.transform, 'none', id);
    if (l.pad === '0px') {
      // Sectioned: the header 16 20 round a 20px title (52, its rule under), the footer 13 20 round a 36px button.
      assert.ok(l.header === 53 || l.header > 53, `${id} header ${l.header}`);
      if (l.footer != null) assert.equal(l.footer, 63, id);
    } else {
      // S16, 20px every side: the frame's 11 above and below (12 with its line: its rounding) and its
      // contents' 9, the contents' 20 at the sides.
      assert.deepEqual([l.pad, l.contents], ['11px 0px', '9px 20px'], id);
    }
  }
  // The settings dialog with a description: 16 + 20 + 4 + 16.5 + 16 and its rule.
  assert.equal((await look(spec('settings-dialog', 'sectioned'))).header, 73.5);
  // The corner close (F29): a borderless 28px button with its icon alone at 16, named.
  const close = await page.$eval(`${spec('feedback', 'simple')} [data-slot="dialog-close"]`, (el) => [el.getAttribute('aria-label'), el.getBoundingClientRect().width, el.querySelector('svg').getBoundingClientRect().width]);
  assert.deepEqual(close, ['Close', 28, 16]);
  assert.deepEqual(await textMotion(page, '[data-section="dialog"]'), []);
  assert.deepEqual(page.problems, []);
});

// The owner (2026-11-26): the scrollbar "limited" to the straight part of a dialog's side, out of the
// "curve part", and the browser's own bar, not one drawn to look like it. The browser draws a box's
// scrollbar the whole height of the box that scrolls, so the measure is that box: in a window too
// short for a dialog, what scrolls in it starts and ends at least the frame's rounding from the
// frame's top and bottom, and the frame itself does not scroll.
test('what scrolls in a dialog stops where its corners begin to curve, so the browser\'s scrollbar keeps to the straight side', async (t) => {
  const page = await componentsPage(t, browser, origin, { width: 1280, height: 170 });
  if (!page) return;
  const read = () => page.evaluate(() => [...document.querySelectorAll('[data-slot="dialog"][data-specimen]')].map((frame) => {
    const f = frame.getBoundingClientRect(), fs = getComputedStyle(frame);
    const scrollers = [frame, ...frame.querySelectorAll('*')].filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
      .map((el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { slot: el.dataset.slot, fromTop: r.top + parseFloat(s.borderTopWidth) - f.top, fromBottom: f.bottom - (r.bottom - parseFloat(s.borderBottomWidth)), atSide: f.right - r.right < 2 }; });
    return { id: `${frame.dataset.specimen}/${frame.dataset.variant}`, layout: frame.dataset.layout, radius: [parseFloat(fs.borderTopRightRadius), parseFloat(fs.borderBottomRightRadius)], frameScrolls: /auto|scroll/.test(fs.overflowY), scrollers };
  }));
  const shapes = await read();
  const scrolling = shapes.filter((s) => s.scrollers.length);
  assert.ok(scrolling.filter((s) => s.layout === 'simple').length >= 4 && scrolling.some((s) => s.layout === 'sectioned'), `dialogs of both layouts scroll in this window: ${scrolling.map((s) => s.id)}`);
  for (const s of shapes) {
    assert.equal(s.frameScrolls, false, `${s.id}: the frame does not scroll`);
    for (const box of s.scrollers.filter((b) => b.atSide)) {
      assert.ok(box.fromTop >= s.radius[0], `${s.id} ${box.slot}: ${box.fromTop}px from the top, the rounding ${s.radius[0]}`);
      assert.ok(box.fromBottom >= s.radius[1], `${s.id} ${box.slot}: ${box.fromBottom}px from the bottom, the rounding ${s.radius[1]}`);
    }
  }
  // A simple dialog's contents: exactly the rounding off each end (the rest of its 20px goes with what scrolls).
  for (const s of scrolling.filter((x) => x.layout === 'simple')) assert.deepEqual(s.scrollers.map((b) => [b.slot, b.fromTop, b.fromBottom]), [['dialog-contents', 12, 12]], s.id);
  assert.deepEqual(page.problems, []);
});

test('a working dialog: focus, Escape, the backdrop, the page held still, a dialog over it', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const pageState = () => page.evaluate(() => [document.documentElement.clientWidth, getComputedStyle(document.body).paddingRight, getComputedStyle(document.body).overflow, getComputedStyle(document.documentElement).overflow, scrollY]);
  const trigger = '[data-specimen-open="dialog"]';
  const at = await centreOf(page, trigger);
  const before = await pageState();
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(OUTER);
  // The page keeps its scrollbar and its place.
  assert.deepEqual(await pageState(), before);
  // Centred by layout: no transform, the box in the middle of the room left of the scrollbar.
  const placed = await page.$eval(OUTER, (el) => { const r = el.getBoundingClientRect(); return [getComputedStyle(el).transform, Math.abs((r.left + r.right) / 2 - document.documentElement.clientWidth / 2) < 1, Math.abs((r.top + r.bottom) / 2 - innerHeight / 2) < 1]; });
  assert.deepEqual(placed, ['none', true, true]);
  // Focus is inside and stays inside.
  // (Read a frame after each key: Base UI's focus guards hand focus on within one.)
  const inside = () => page.evaluate((sel) => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(!!document.querySelector(sel)?.contains(document.activeElement))))), OUTER);
  assert.ok(await inside());
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); assert.ok(await inside(), `Tab ${i}`); }
  // A wheel over the backdrop doesn't scroll the page.
  await page.mouse.move(30, 450);
  await page.mouse.wheel({ deltaY: 400 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await page.evaluate(() => scrollY), before[4]);
  // Escape closes it and gives focus back to the button that opened it.
  await page.keyboard.press('Escape');
  await until(page, (sel) => !document.querySelector(sel), OUTER, { what: 'the dialog closed' });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.specimenOpen), 'dialog');
  // A press on the backdrop closes it too.
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(OUTER);
  await page.mouse.click(30, 450);
  await until(page, (sel) => !document.querySelector(sel), OUTER, { what: 'the dialog closed by the backdrop' });

  // A dialog over it: its own backdrop on top; Escape and its backdrop close it alone.
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(OUTER);
  await page.click('[data-specimen-open="inner"]');
  await page.waitForSelector(INNER);
  const stack = await page.evaluate(() => [...document.querySelectorAll('[data-slot="dialog-backdrop"]')].map((b) => getComputedStyle(b).zIndex));
  assert.deepEqual(stack, ['400', '10001']);
  assert.ok(await page.evaluate((sel) => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(document.querySelector(sel).contains(document.activeElement))))), INNER));
  await page.keyboard.press('Escape');
  await until(page, (sel) => !document.querySelector(sel), INNER, { what: 'the inner dialog closed' });
  assert.ok(await page.$(OUTER), 'the outer dialog stays');
  await page.click('[data-specimen-open="inner"]');
  await page.waitForSelector(INNER);
  await page.mouse.click(30, 450);
  await until(page, (sel) => !document.querySelector(sel), INNER, { what: 'the inner dialog closed by its backdrop' });
  assert.ok(await page.$(OUTER), 'the outer dialog stays after a press on the inner one\'s backdrop');
  await page.keyboard.press('Escape');
  await until(page, (sel) => !document.querySelector(sel), OUTER, { what: 'the outer dialog closed' });
  assert.deepEqual(page.problems, []);
});

test('the box never moves or grows after its first frame, with the CPU six times slower', async (t) => {
  const page = await componentsPage(t, browser, origin);
  if (!page) return;
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  try {
    await centreOf(page, '[data-specimen-open="dialog"]');
    const frames = await page.evaluate((sel) => new Promise((resolve) => {
      const seen = [];
      const tick = () => {
        const el = document.querySelector(sel);
        if (el) { const r = el.getBoundingClientRect(); seen.push([r.top, r.height, r.width]); }
        if (seen.length < 20) requestAnimationFrame(tick); else resolve(seen);
      };
      document.querySelector('[data-specimen-open="dialog"]').click();
      requestAnimationFrame(tick);
    }), OUTER);
    assert.ok(frames.length === 20);
    for (const f of frames) assert.deepEqual(f, frames[0]);
  } finally { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); }
  assert.deepEqual(page.problems, []);
});

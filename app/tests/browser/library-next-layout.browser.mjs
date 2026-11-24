// library-next-layout.browser.mjs — the layout checklist (the layout-principles skill) for what a card
// opens on /library-next: the delete question with its cover, the series' translation window, the tag
// editor with its suggestions, and the re-run menu. Each at the desktop width, the narrow one and a
// phone's, at 100%, 125% and 150% scale, with a gallery whose title runs long: inside the window (8px
// or more from its edges), drawn at once and never moving or changing size after (the CPU slowed six
// times), the page's scrollbar left where it is; the menu turning upward at the window's foot and
// sliding back inside at its right edge, as 1.3's did; a press then a key leaving no keyboard ring.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath } from './harness.mjs';
import { startTranslator } from './stand-in-translator.mjs';
import { openRun, nextBase, press, sleep, PARTS } from './library-drive.mjs';

let server, origin, tr;
const browsers = {};
const LONG = 'A title that runs on and on, far longer than any box it is shown in, '.repeat(4).trim();

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  tr = await startTranslator();
  for (const scale of [1, 1.25, 1.5]) {
    browsers[scale] = await puppeteer.launch({ executablePath: chromePath(), headless: true,
      ignoreDefaultArgs: ['--hide-scrollbars'],
      args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', `--force-device-scale-factor=${scale}`] });
  }
});
after(async () => { for (const b of Object.values(browsers)) await b.close(); server?.close(); await tr?.close(); });

// In the page: the box of `sel` in every frame for `ms` from the frame it first shows in (what opens
// the first time is loaded then: under a slowed CPU it may take a while to come), and the window.
const boxes = (page, sel, ms = 600) => page.evaluate(([sel, ms]) => new Promise((done) => {
  const seen = [];
  let t0 = null;
  const given = performance.now();
  const tick = () => {
    const el = document.querySelector(sel);
    if (el) { t0 ??= performance.now(); const r = el.getBoundingClientRect(); seen.push([r.left, r.top, r.width, r.height].map((v) => Math.round(v * 100) / 100).join(',')); }
    if (t0 == null ? performance.now() - given < 5000 : performance.now() - t0 < ms) requestAnimationFrame(tick); else done({ seen, w: innerWidth, h: innerHeight, cw: document.documentElement.clientWidth, overflow: getComputedStyle(document.body).overflow + getComputedStyle(document.documentElement).overflow });
  };
  requestAnimationFrame(tick);
}), [sel, ms]);

function inside(name, { seen, w, h }) {
  assert.ok(seen.length > 0, `${name}: drawn`);
  assert.equal(new Set(seen).size, 1, `${name}: never moved or changed size (${[...new Set(seen)].join(' | ')})`);
  const [left, top, width, height] = seen[0].split(',').map(Number);
  assert.ok(left >= 8 && top >= 8 && left + width <= w - 8 && top + height <= h - 8, `${name}: inside the window (${seen[0]} in ${w}×${h})`);
}

const SIZES = [['desktop', 1280, 900], ['narrow', 400, 800], ['phone', 390, 844]];

for (const scale of [1, 1.25, 1.5]) {
  test(`the questions, the window and the editor at ${scale * 100}%: inside the window, still once shown`, async (t) => {
    if (!browsers[scale]) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    for (const [name, width, height] of SIZES) {
      const base = nextBase(1790005000000);
      const page = await openRun(browsers[scale], origin, '/library-next', { base, translator: tr.origin });
      await page.evaluate(async ([gid, long]) => (await import('/app/js/store.js')).mutate(gid, { title: { english: long, japanese: '', pretty: '' } }), [String(base + PARTS.P), LONG]);
      await page.setViewport({ width, height });
      await sleep(600);
      const cdp = await page.createCDPSession();
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      const scrollbar = await page.evaluate(() => document.documentElement.clientWidth);
      // The delete question, with its cover and the long title.
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), `#grid > .card[data-gallery-id="${base + PARTS.P}"]`);
      await press(page, base, 'P', 'del');
      const del = await boxes(page, '[data-notice="dialog"]');
      inside(`${name}: the delete question`, del);
      assert.equal(del.cw, scrollbar, `${name}: the page's scrollbar left where it is`);
      await page.keyboard.press('Escape'); await sleep(300);
      // The series' window.
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), `#grid > .card[data-gallery-id="${base + PARTS.S}"]`);
      await press(page, base, 'S', 'tr');
      inside(`${name}: the series' window`, await boxes(page, '#seriesTranslateModal'));
      await page.keyboard.press('Escape'); await sleep(300);
      // The tag editor, its suggestions open.
      await press(page, base, 'P', 'add');
      inside(`${name}: the tag editor`, await boxes(page, '#tagEditor'));
      await page.type('#tagEdValue', 'a'); await sleep(400);
      const list = await page.evaluate(() => { const l = document.querySelector('[data-slot="listbox"]'); if (!l) return null; const r = l.getBoundingClientRect(), f = document.getElementById('tagEdValue').getBoundingClientRect(); return { gap: r.top - f.bottom, left: r.left - f.left, width: r.width - f.width }; });
      if (list) assert.deepEqual(list, { gap: 4, left: 0, width: 0 }, `${name}: the suggestions under the box, as wide`);
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await sleep(300);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      assert.deepEqual(page.problems, []);
      await page.close();
    }
  });
}

test('the re-run menu: under its button, upward at the window\'s foot, back inside at its right edge; no ring after a press', async (t) => {
  if (!browsers[1]) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  for (const path of ['/library', '/library-next']) {
    const base = nextBase(1790005000000);
    const page = await openRun(browsers[1], origin, path, { base, translator: tr.origin });
    const btn = `#grid > .card[data-gallery-id="${base + PARTS.T}"] .card-btn-translate`;
    // The button `y` px from the window's top, or (y < 0) -y px from its foot: the window's height
    // made to fit.
    const place = async (y, width) => {
      await page.setViewport({ width, height: 900 });
      await sleep(300);
      await page.evaluate(() => window.scrollTo(0, 0));
      if (y < 0) {
        const bottom = await page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().bottom, btn);
        await page.setViewport({ width, height: Math.round(bottom - y) });
      } else await page.evaluate(([sel, y]) => { const b = document.querySelector(sel); window.scrollBy(0, b.getBoundingClientRect().top - y); }, [btn, y]);
      await sleep(300);
      await press(page, base, 'T', 'tr', { right: true });
      await sleep(400);
      const r = await page.evaluate((btn) => {
        const m = document.querySelector('.ctx-menu, [data-slot="menu"]').getBoundingClientRect(), b = document.querySelector(btn).getBoundingClientRect();
        return { below: Math.round(m.top - b.bottom), above: Math.round(b.top - m.bottom), left: Math.round(m.left - b.left), right: Math.round(innerWidth - m.right), ring: (() => { const f = document.querySelector(':focus-visible'); if (!f) return 'none'; const cs = getComputedStyle(f); return cs.outlineStyle === 'none' ? 'focused, nothing drawn' : `drawn on ${f.className}`; })(), bar: innerWidth - document.documentElement.clientWidth };
      }, btn);
      await page.keyboard.press('Escape');
      await sleep(300);
      return r;
    };
    out[path] = { top: await place(120, 1280), foot: await place(-60, 1280), narrow: await place(120, 400) };
    await page.close();
  }
  const now = out['/library-next'], was = out['/library'];
  assert.equal(now.top.below, 6, 'under its button, 6px down');
  assert.equal(now.foot.above, 6, 'above it at the window\'s foot');
  assert.ok(now.narrow.right >= 8, 'back inside the window at its right edge');
  if (process.env.DUMP) console.log(JSON.stringify(out));
  for (const r of [now.top, now.foot, now.narrow]) assert.notEqual(r.ring.slice(0, 5), 'drawn', 'no keyboard ring drawn after a press');
  // Up or down, and how far from its button, as 1.3's. Slid back inside at the right: 8px from the
  // page's scrollbar (§5.3 F51; 1.3's reached the scrollbar, placed against the window's whole width).
  const where = (r) => ({ top: r.top.below, foot: r.foot.above, narrow: r.narrow.below });
  assert.deepEqual(where(now), where(was));
  for (const r of [now.top, now.foot, now.narrow]) assert.equal(r.right, 8 + r.bar, 'slid back 8px inside the page');
});

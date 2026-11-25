// header-places.browser.mjs — the common header's parts stand on the same pixels whichever page shows.
// The one page keeps one header while its routes change, so anything of it that sat elsewhere on
// another page is seen to move: the logo, the name, the "/" and the page menu are measured (their
// boxes, and where their words are drawn) in every frame of a walk from the library to Settings, to
// Tasks and back, at several widths and at 100%, 125% and 150% scale, and none may differ from the
// first frame's. (The page menu's own word changes with the page: where it begins does not.) The
// overview joined the walk at its switch (2026-11-25): a series' overview between them.
//
// What it found the first time: Settings had a form of the header of its own (1.3's Settings page's:
// a 1.5 line, the brand on a 1.2 line), which drew the "/" and the menu's word a quarter of a pixel
// higher at 100% and the name 0.6px higher at 125%; and on a phone Settings' and the library's headers
// came 12px in at the sides where Tasks' kept 20, so the logo moved 8px.
//
// At 600px or less the library's header is another shape on purpose (its search takes a row of its
// own, and the brand's word and the "/" give way): there the logo's distance from the side is held on
// every page, and every part between Settings and Tasks.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, until } from './harness.mjs';
import { openRun, nextBase, PARTS } from './library-drive.mjs';

let server, origin;
const browsers = {};
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  for (const scale of [1, 1.25, 1.5]) {
    browsers[scale] = await puppeteer.launch({ executablePath: chromePath(), headless: true, ignoreDefaultArgs: ['--hide-scrollbars'],
      args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', `--force-device-scale-factor=${scale}`] });
  }
});
after(async () => { for (const b of Object.values(browsers)) await b.close(); server?.close(); });

// In the page: where each part of the header's left is, kept for every frame from here on (a part
// that is not there in a frame is "-": the page's own parts are put in by its route).
function record() {
  const box = (el, keys = ['left', 'top', 'width', 'height']) => { if (!el) return '-'; const b = el.getBoundingClientRect(); return keys.map((k) => Math.round(b[k] * 100) / 100).join(','); };
  const words = (el, keys) => {
    const node = el && [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (!node) return '-';
    const range = document.createRange();
    range.selectNodeContents(node);
    return box(range, keys);
  };
  const PLACE = ['left', 'top', 'height'];
  const look = () => {
    const h = document.querySelector('.app-header');
    const q = (sel) => h.querySelector(sel);
    const menu = q('.page-nav');
    return {
      logo: box(q('.brand-icon')), name: box(q('.brand-text')), nameWords: words(q('.brand-text')), sep: box(q('.brand-sep')), sepWords: words(q('.brand-sep')),
      menu: box(menu, PLACE), menuWords: words(menu?.querySelector('span') ?? menu, PLACE),
    };
  };
  window.__places = { frames: 0, seen: {}, pages: new Set() };
  const tick = () => {
    const now = look();
    window.__places.frames++;
    window.__places.pages.add(location.pathname);
    for (const [part, place] of Object.entries(now)) (window.__places.seen[part] ??= new Set()).add(place);
    window.__placesFrame = requestAnimationFrame(tick);
  };
  tick();
}
const recorded = (page) => page.evaluate(() => {
  cancelAnimationFrame(window.__placesFrame);
  return { frames: window.__places.frames, pages: [...window.__places.pages], seen: Object.fromEntries(Object.entries(window.__places.seen).map(([part, set]) => [part, [...set]])) };
});

const shown = {
  library: (page) => until(page, () => /^\/(library)?$/.test(location.pathname) && !!document.querySelector('#grid > .card') && !!document.querySelector('.app-header .page-nav'), null, { what: 'the library' }),
  settings: (page) => until(page, () => location.pathname === '/settings' && !!document.querySelector('#settingsNav .nav-item') && !!document.getElementById('aboutBtn'), null, { what: 'Settings' }),
  tasks: (page) => until(page, () => location.pathname === '/tasks' && !!document.getElementById('tkList') && !!document.querySelector('.app-header .page-nav'), null, { what: 'Tasks' }),
  overview: (page) => until(page, () => location.pathname === '/overview' && !!document.querySelector('#ovContent .ov-hero') && !!document.querySelector('.app-header .page-nav'), null, { what: 'the overview' }),
};
// A change of route as a link in the app makes it (no load).
const go = (page, path) => page.evaluate((path) => { const a = document.createElement('a'); a.href = path; document.body.append(a); a.click(); a.remove(); }, path);
const settle = (page) => page.evaluate(() => new Promise((done) => { let n = 0; const tick = () => (++n < 20 ? requestAnimationFrame(tick) : done()); tick(); }));

// A page of `path` over a run's library; `page.series`: the address of its series' overview.
async function open(scale, width, path) {
  const base = nextBase(1790011000000);
  const page = await openRun(browsers[scale], origin, path, { base });
  page.series = `/overview?g=${base + PARTS.S}`;
  await page.setViewport({ width, height: 900 });
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  await page.evaluate(() => { window.__stayed = true; });
  return page;
}

for (const scale of [1, 1.25, 1.5]) {
  test(`a change of page moves nothing of the header's logo, name, "/" and page menu, at ${scale * 100}%`, async (t) => {
    if (!browsers[scale]) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    for (const width of [1600, 1280, 760, 601]) {
      const page = await open(scale, width, '/library');
      await shown.library(page);
      await page.evaluate(record);
      for (const [path, name] of [['/settings', 'settings'], ['/tasks', 'tasks'], ['/library', 'library'], [page.series, 'overview'], ['/settings', 'settings'], [page.series, 'overview'], ['/tasks', 'tasks'], ['/library', 'library']]) {
        await go(page, path);
        await shown[name](page);
        await settle(page);
      }
      const { frames, pages, seen } = await recorded(page);
      assert.ok(frames > 100 && pages.length >= 4, `${width}: the walk was watched (${frames} frames, ${pages})`);
      assert.equal(await page.evaluate(() => window.__stayed), true, `${width}: no page load`);
      for (const [part, places] of Object.entries(seen)) {
        assert.deepEqual(places.filter((p) => p !== '-').length, 1, `${width}: the ${part} stood in one place (${places.join(' | ')})`);
      }
      // The frame's own parts are never away; the page's are in their place the frame the page shows.
      for (const part of ['logo', 'name', 'nameWords']) assert.ok(!seen[part].includes('-'), `${width}: the ${part} was always there`);
      assert.deepEqual(page.problems, []);
      await page.close();
    }
  });
}

test('at a phone\'s width the logo is as far from the side on every page; Settings, Tasks and the overview are the same in every part', async (t) => {
  if (!browsers[1]) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  for (const width of [600, 520, 390, 320]) {
    const page = await open(1, width, '/library');
    await shown.library(page);
    const logo = () => page.evaluate(() => { const b = document.querySelector('.app-header .brand-icon').getBoundingClientRect(); return [b.left, b.width, b.height]; });
    const places = { library: await logo() };
    await go(page, '/settings');
    await shown.settings(page);
    await settle(page);
    places.settings = await logo();
    // Settings ↔ Tasks ↔ the overview: one shape of header, every part in one place.
    await page.evaluate(record);
    for (const [path, name] of [['/tasks', 'tasks'], [page.series, 'overview'], ['/settings', 'settings'], ['/tasks', 'tasks']]) {
      await go(page, path);
      await shown[name](page);
      await settle(page);
    }
    const { seen } = await recorded(page);
    for (const [part, at] of Object.entries(seen)) assert.deepEqual(at.filter((p) => p !== '-').length, 1, `${width}: the ${part} stood in one place between Settings, Tasks and the overview (${at.join(' | ')})`);
    places.tasks = await logo();
    assert.deepEqual(places.settings, places.library, `${width}: the logo on Settings where the library has it`);
    assert.deepEqual(places.tasks, places.library, `${width}: the logo on Tasks where the library has it`);
    assert.equal(places.library[0], 12, `${width}: 12px in`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0, true, `${width}: nothing runs past the side`);
    assert.deepEqual(page.problems, []);
    await page.close();
  }
});

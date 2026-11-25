// hover-states.browser.mjs — nothing gets darker under the pointer, and a control that is on, chosen
// or focused keeps that look under it. Measured (hover-audit.mjs: the pointer forced over every
// element a :hover rule can change, its look compared with its look at rest) on every page of the
// built site and on every shared component in every state /components shows it in.
//
// What it found the first time: the header's name and logo dimmed to 80%; the chosen item of Settings'
// side nav went to the darker ground of an item merely pointed at, a focused select and a focused
// title lost their focused frame, Safe Mode's button its green and the overview's Edit its yellow (a
// hover outweighed every state's look); "Add folder…", the overview's chapter buttons and its "add a
// chapter" results went to a ground darker than the surface they sit on; the chapter being read lost
// its tint in the reader's chapter list.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { openRun, nextBase, publish, sleep, PARTS } from './library-drive.mjs';
import { hoverChanges } from './hover-audit.mjs';
import { startTranslator } from './stand-in-translator.mjs';
import * as ov from './overview-drive.mjs';

let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const said = (c) => `${c.element}: ${c.what} ${c.from} → ${c.to}${c.words ? `  (“${c.words}”)` : ''}`;

// The page as it stands: nothing in it darker under the pointer. `least`: how many elements a :hover
// rule names there at least (the measure found its rules).
async function nothingDarker(page, name, least) {
  await page.mouse.move(2, 2);
  const { hosts, changes } = await hoverChanges(page);
  assert.ok(hosts >= least, `${name}: the elements its :hover rules name were found (${hosts})`);
  assert.ok(changes.length > 0, `${name}: something changes under the pointer`);
  assert.deepEqual(changes.filter((c) => c.darker).map(said), [], `${name}: darker under the pointer`);
  return changes;
}

// A page of the app with a file of its own, or one the one page draws, opened on the run's library.
async function open(path, ready) {
  const page = await openPage(browser, origin);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await until(page, (sel) => !!document.querySelector(sel), ready, { what: `${path}: ${ready}` });
  await sleep(800);
  return page;
}

// A run's galleries made and the library opened at `path`: the page, and a gallery's id by its part.
async function run(path) {
  const base = nextBase(1790009000000);
  return { page: await openRun(browser, origin, path, { base }), gid: (part) => String(base + PARTS[part]) };
}

// (Until the library's switch, 2026-11-25, 1.3's /library was measured beside the one page's.)
for (const path of ['/library']) {
  test(`${path}: its header, toolbar and cards; cards with jobs running and a favourite`, async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const { page, gid } = await run(path);
    await nothingDarker(page, path, 20);
    await publish(page, { gid: gid('I'), kind: 'download', status: 'progress', done: 1, total: 4 });
    await publish(page, { gid: gid('T'), kind: 'translate', status: 'progress', done: 1, total: 4 });
    await page.evaluate(async (id) => (await import('/app/js/api.js')).personal.favorite(id, true), gid('P'));
    await until(page, (id) => !!document.querySelector(`#grid > .card[data-gallery-id="${id}"] .card-btn-dl.cancelling`), gid('I'), { what: 'the download\'s Stop' });
    await nothingDarker(page, `${path}, jobs running`, 20);
    // Safe Mode on, the header unpinned, the menu's list of totals open (the window is 1280 wide: the
    // totals are folded behind it). Safe Mode's button keeps its green under the pointer.
    // (Both choices are kept from one page to the next: each pressed only where it is not so yet.)
    if (!(await page.evaluate(() => document.getElementById('safeBtn').matches('.active, [aria-pressed="true"]')))) await page.click('#safeBtn');
    if (await page.evaluate(() => getComputedStyle(document.querySelector('header')).position === 'sticky')) await page.click('#pinBtn');
    await page.click('#burgerBtn');
    await until(page, () => document.getElementById('safeBtn').matches('.active, [aria-pressed="true"]') && getComputedStyle(document.querySelector('header')).position === 'relative', null, { what: 'Safe Mode on, the header unpinned' });
    await until(page, () => getComputedStyle(document.getElementById('collapsibleGroup')).display !== 'none', null, { what: 'the menu open' });
    await sleep(300);
    const changes = await nothingDarker(page, `${path}, Safe Mode on, unpinned, the menu open`, 20);
    assert.deepEqual(changes.filter((c) => c.element.includes('#safeBtn') && !c.element.includes('▸')).map(said), [], `${path}: Safe Mode's button, on, under the pointer`);
    // (The measure's pointer leaves the open list where it is: a move is no press.)
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById('collapsibleGroup')).display), 'none', 'the menu still open');
    await page.close();
  });
}

// (Until the overview's switch, 2026-11-25, 1.3's /overview was measured beside the one page's.)
test('the overview (a gallery and a series) and the reader', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const { page: seeded, gid } = await run('/library');
  await seeded.close();
  for (const [name, path, ready, least] of [
    ['the overview of a gallery', `/overview?g=${gid('P')}`, '.ov-btn', 8],
    ['the overview of a series', `/overview?g=${gid('S')}`, '.ch-ibtn', 15],
    ['the reader', `/reader?g=${gid('P')}`, '#topbar .tb-btn', 5],
  ]) {
    const page = await open(path, ready);
    await nothingDarker(page, name, least);
    // The overview in edit mode too: its titles to type in, its tags and details pressable, its Edit
    // on (Done, in its yellow), which keeps that look under the pointer.
    if (path.startsWith('/overview')) {
      await page.click('#editToggle');
      await until(page, () => !!document.querySelector('#ovContent.ov-editing'), null, { what: 'edit mode' });
      await page.mouse.move(5, 5);
      await sleep(300);
      const changes = await nothingDarker(page, `${name}, in edit mode`, least);
      assert.deepEqual(changes.filter((c) => c.element.includes('#editToggle') && !c.element.includes('▸')).map(said), [], `${name}: Edit, on, under the pointer`);
    }
    // A series' add bar with its list of galleries open (7c): its results lift under the pointer.
    if (path.startsWith('/overview') && path.endsWith(gid('S'))) {
      await page.$eval('#addSearch', (el) => el.scrollIntoView({ block: 'center' }));
      await page.click('#addSearch');
      await page.type('#addSearch', gid('S').slice(0, 6), { delay: 30 });
      await until(page, () => document.querySelectorAll('#addResults.open .add-res').length > 0, null, { what: `${name}: the add list` });
      await sleep(500);
      const changes = await nothingDarker(page, `${name}, its add list open`, least);
      assert.ok(changes.some((c) => /add-res|listbox-option/.test(c.element)), `${name}: the add list's results measured (${changes.map((c) => c.element).join('; ')})`);
    }
    await page.close();
  }
});

// 7d: the new overview in the states that have more to point at: a row with a job (its bar, its Stop),
// a row's pages open (its tiles, its toggle on), the re-run menu open (a translated chapter's steps), the
// tag editor open, and the phone form (a row's buttons shown with no pointer over them).
test('the overview\'s other states: a row with a job, a row\'s pages open, the re-run menu, the tag editor, the phone form', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const tr = await startTranslator();
  t.after(() => tr.close());
  // (Ids below the library runs' here: the library's first card is a run's own, which the tests after wait for.)
  const base = ov.nextBase(1790008900000);
  const page = await ov.openRun(browser, origin, base, { translator: tr.origin, storage: { 'shiori:translateSettings': { serverUrl: tr.origin } } });
  t.after(async () => { await page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); }); await page.close(); });
  const row = (part) => ov.rowSel(base, part);
  for (const path of [ov.NEW]) {
    const name = 'the overview';
    await page.setViewport({ width: 1280, height: 900 });
    await ov.visit(page, origin, path, ov.gid(base, 'S'));
    await until(page, () => getComputedStyle(document.querySelector('.ch-row:not(.missing) [data-translate]')).display !== 'none', null, { what: 'the translation server' });
    await ov.publish(page, { gid: ov.gid(base, 'S2'), kind: 'download', status: 'downloading', downloaded: 100, total: 1000, pages: 2 });
    await page.hover(`${row('S')} .ch-main`);
    await page.click(`${row('S')} [data-expand]`);
    await until(page, (s) => !!document.querySelector(`${s}.working`) && [...document.querySelectorAll('.ch-row.expanded .ov-page img')].some((i) => i.getAttribute('src')), row('S2'), { what: `${name}: a job and a row's pages` });
    await sleep(300);
    const changes = await nothingDarker(page, `${name}, a row with a job and a row's pages open`, 15);
    assert.ok(changes.some((c) => /ov-page/.test(c.element)), `${name}: the tiles measured`);
    await page.hover(`${row('S3')} .ch-main`);
    await page.click(`${row('S3')} [data-translate]`, { button: 'right' });
    await until(page, () => [...document.querySelectorAll('.rerun-menu')].some((m) => m.getClientRects().length), null, { what: `${name}: the menu` });
    await sleep(400);
    await nothingDarker(page, `${name}, the re-run menu open`, 15);
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.$eval('#editToggle', (el) => el.click());
    await page.$eval('.ov-chip-add', (el) => el.click());
    await until(page, () => !!document.querySelector('.modal-overlay.show #tagEdType, [data-slot="dialog"] #tagEdType'), null, { what: `${name}: the tag editor` });
    await sleep(400);
    await nothingDarker(page, `${name}, the tag editor open`, 8);
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
    await ov.visit(page, origin, path, ov.gid(base, 'S'));
    await sleep(300);
    const phone = await nothingDarker(page, `${name}, on a phone`, 15);
    assert.ok(phone.some((c) => /ch-ibtn/.test(c.element)), `${name}: a row's shown buttons measured`);
  }
});

test('Tasks, and Settings panel by panel', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const { page: seeded, gid } = await run('/library');
  await seeded.close();
  let page = await open('/tasks', '.app-header .page-nav');
  await publish(page, { gid: gid('I'), kind: 'download', status: 'progress', done: 1, total: 4 });
  await until(page, () => !!document.querySelector('.tk-stop'), null, { what: 'a task\'s row' });
  await nothingDarker(page, 'Tasks', 5);
  await page.close();
  page = await open('/settings', '#settingsNav .nav-item');
  const tabs = await page.$$eval('#settingsNav .nav-item', (els) => els.map((e) => e.id));
  assert.ok(tabs.length >= 4, `Settings' panels (${tabs})`);
  for (const id of tabs) {
    await page.click(`#${id}`);
    await until(page, (id) => document.getElementById(id)?.getAttribute('aria-current') === 'page', id, { what: `${id} shown` });
    await sleep(300);
    const changes = await nothingDarker(page, `Settings, ${id}`, 8);
    // The chosen item of the side nav is as it was under the pointer.
    assert.deepEqual(changes.filter((c) => c.element.includes(`#${id}`) && !c.element.includes('▸')).map(said), [], `${id}: the chosen item, under the pointer`);
  }
  await page.close();
});

test('every shared component in every state /components shows; a control that is on, chosen or focused keeps that look', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await open('/components', '[data-specimen="gallery-card"]');
  await sleep(1500);
  const changes = await nothingDarker(page, '/components', 600);
  const of = (specimen, state, what) => changes.filter((c) => c.element.includes(`«${specimen} / ${state}»`) && !c.element.includes('▸') && (!what || what.includes(c.what))).map(said);
  // On: the header's Safe Mode button (its green), the overview's Edit (its yellow frame).
  assert.deepEqual(of('header-icon', 'on'), [], 'a header button that is on');
  assert.deepEqual(of('ov-btn', 'on'), [], 'an overview button that is on');
  // Chosen: Settings' side nav item, the overview's chapters/volumes tab.
  assert.deepEqual(of('nav-item', 'on'), [], 'the chosen item of a side nav');
  assert.deepEqual(of('ov-view', 'on'), [], 'the chosen underlined tab');
  // Focused: a select's box and a title being edited keep the focused frame (their ground may lift).
  for (const specimen of ['select-field', 'sort-select', 'modal-select', 'rs-select', 'inline-title']) assert.deepEqual(of(specimen, 'focus', ['frame']), [], `${specimen}: the focused frame`);
  // The chapter being read, in the reader's chapter list: its tint stays.
  assert.deepEqual(changes.filter((c) => /current=true[^▸]*slot=popover-item/.test(c.element) && !c.element.includes('▸')).map(said), [], 'the chapter being read');
  // And the measure sees a plain hover: a header button's ground does change (it has no frame: F60),
  // and a card's quiet button's frame.
  assert.ok(of('header-icon', 'rest', ['ground']).length > 0, 'a header button at rest takes the raised ground under the pointer');
  assert.ok(of('card-btn', 'rest', ['frame']).length > 0, 'a card\'s button at rest takes its frame under the pointer');
  await page.close();
});

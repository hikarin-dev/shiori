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

test('the overview (a gallery and a series, 1.3\'s page and the new one) and the reader', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const { page: seeded, gid } = await run('/library');
  await seeded.close();
  for (const [name, path, ready, least] of [
    ['the overview of a gallery', `/overview?g=${gid('P')}`, '.ov-btn', 8],
    ['the overview of a series', `/overview?g=${gid('S')}`, '.ch-ibtn', 15],
    // The overview as the one page draws it, beside 1.3's until its switch (7e).
    ['the new overview of a gallery', `/overview-next?g=${gid('P')}`, '.ov-btn', 8],
    ['the new overview of a series', `/overview-next?g=${gid('S')}`, '.ch-ibtn', 15],
    ['the reader', `/reader?g=${gid('P')}`, '#topbar .tb-btn', 5],
  ]) {
    const page = await open(path, ready);
    await nothingDarker(page, name, least);
    // The new overview in edit mode too: its titles to type in, its tags and details pressable, its Edit
    // on (Done, in its yellow), which keeps that look under the pointer.
    if (path.startsWith('/overview-next')) {
      await page.click('#editToggle');
      await until(page, () => !!document.querySelector('#ovContent.ov-editing'), null, { what: 'edit mode' });
      await page.mouse.move(5, 5);
      await sleep(300);
      const changes = await nothingDarker(page, `${name}, in edit mode`, least);
      assert.deepEqual(changes.filter((c) => c.element.includes('#editToggle') && !c.element.includes('▸')).map(said), [], `${name}: Edit, on, under the pointer`);
    }
    await page.close();
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

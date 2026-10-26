import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';

// The reader's side navigation (Reader settings → Navigation → Side): the chapter pill, the column
// of buttons, fit and zoom, hiding and showing them, auto-scroll, dimming, and page turns that only a
// click on the page makes.
const SERIES = ['1790000000611', '1790000000612', '1790000000613'];   // three chapters of 12 pages
const SINGLE = '1790000000621';       // 10 pages
const TRANSLATED = '1790000000622';   // 2 pages, translated, with study layers
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/library`, { waitUntil: 'load' });
  await page.evaluate(async ({ series, single, translated }) => {
    const api = await import('/app/js/api.js');
    const title = english => ({ english, japanese: '', pretty: '' });
    const png = async (shade) => {
      const canvas = new OffscreenCanvas(600, 860);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.convertToBlob({ type: 'image/png' });
    };
    const blob = await png(200);
    for (const [k, gid] of series.entries()) {
      await api.meta.put({ galleryId: gid, title: title(`Chapter ${k + 1}`), tags: [], numPages: 12 });
      for (let n = 1; n <= 12; n++) await api.pages.put(gid, n, blob);
    }
    await api.series.write(series[0], series.map((id, k) => ({ id, title: `Part ${k + 1}`, number: k + 1 })), { seriesTitle: title('Side fixture'), seriesTags: [] });
    await api.meta.put({ galleryId: single, title: title('Single'), tags: [], numPages: 10 });
    for (let n = 1; n <= 10; n++) await api.pages.put(single, n, blob);
    await api.meta.put({ galleryId: translated, title: title('Translated'), tags: [], numPages: 2 });
    for (const n of [1, 2]) {
      await api.pages.put(translated, n, blob);
      await api.derived.putTranslation(translated, n, { image: await png(120), pipeline: { job: 'job1',
        lines: [{ pts: [[10, 10], [200, 10], [200, 60], [10, 60]], score: 0.9, text: 'こんにちは' }],
        read: [0], regions: [{ lines: [0], tr: 'Hello' }] } });
      await api.derived.putStudy(translated, n, { bg: await png(150), page: { w: 600, h: 860 },
        bubbles: [{ id: 0, box: { x: 10, y: 10, w: 190, h: 50 }, region: { x: 10, y: 10, w: 190, h: 50 }, tr: 'Hello', src: 'こんにちは', text: await png(220) }] }, 'job1');
    }
    const meta = await api.meta.get(translated);
    await api.meta.put({ ...meta, translated: true, translations: { job1: { at: Date.now(), config: {} } } });
  }, { series: SERIES, single: SINGLE, translated: TRANSLATED });
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

async function reader(t, { gallery = SINGLE, at = 1, mode = 'strip', fit = 'height', side = true, sidePinned = true, position = 'bottom',
  place = 'right-start', autoBar = 'bottom', pauseOnUp = true } = {}) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.setViewport({ width: 1400, height: 900 });
  await page.evaluateOnNewDocument((o) => {
    if (sessionStorage.getItem('fixture-set')) return;   // a reload keeps what the test changed
    sessionStorage.setItem('fixture-set', '1');
    localStorage.setItem('shiori-reader-nav', o.side ? 'side' : 'top');
    localStorage.setItem('shiori-reader-side-pin', o.sidePinned ? '1' : '0');
    localStorage.setItem('shiori-reader-nav-place', o.place);
    localStorage.setItem('shiori:readerAutoBarPosition', JSON.stringify(o.autoBar));
    localStorage.setItem('shiori:readerAutoPauseOnUp', JSON.stringify(o.pauseOnUp));
    localStorage.setItem('shiori-reader-pin', '0');
    localStorage.setItem('shiori:readerMode', JSON.stringify(o.mode));
    localStorage.setItem('shiori:readerFitMode', JSON.stringify(o.fit));
    localStorage.setItem('shiori:readerPageZoom', '1');
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
    localStorage.setItem('shiori:readerProgressPosition', JSON.stringify(o.position));
    localStorage.setItem('shiori:readerView', '"off"');
    localStorage.setItem('shiori:readerAutoScrollSpeed', '150');
    localStorage.setItem('shiori:readerDim', '0');
  }, { side, sidePinned, mode, fit, position, place, autoBar, pauseOnUp });
  await page.goto(`${origin}/reader?g=${gallery}&page=${at}`, { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.querySelectorAll('#stripView img[src], #mainImg, .dImg')].some(img => img.naturalWidth > 0));
  return page;
}

const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
const opacity = (page, sel) => page.$eval(sel, el => Number(getComputedStyle(el).opacity));
const isOn = (page, sel) => page.$eval(sel, el => el.classList.contains('is-on'));
const counter = page => page.$eval('#pageCounter', el => Number(el.textContent.split('/')[0].trim()));
// The reader settings, open on a tab (the one last shown otherwise).
async function openSettings(page, tab) {
  await page.evaluate(() => (document.body.classList.contains('reader-side-nav') ? document.getElementById('snSettings') : document.getElementById('readerSettingsBtn')).click());
  await page.waitForSelector('#readerSettingsModal.show');
  if (tab) await page.$eval(`[role="tab"][data-rs-tab="${tab}"]`, el => el.click());
}
const rect = (page, sel) => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
// Sets a range in the reader settings as dragging it would.
const setRange = (page, id, value) => page.$eval(`#${id}`, (input, value) => {
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

test('the settings switch the reader between the top bar and the side controls, and it stays', { skip: !chromePath() }, async t => {
  const page = await reader(t, { side: false });
  const shown = () => page.evaluate(() => ({
    side: document.body.classList.contains('reader-side-nav'),
    top: getComputedStyle(document.getElementById('topbar')).display !== 'none',
    rail: getComputedStyle(document.getElementById('sideNav')).display !== 'none',
  }));
  assert.deepEqual(await shown(), { side: false, top: true, rail: false });
  await openSettings(page, 'display');
  assert.equal(await page.$eval('#readerNavPlace', b => b.matches(':disabled')), true, 'the classic navigation has no place to pick');
  await page.click('[data-reader-nav="side"]');
  assert.deepEqual(await shown(), { side: true, top: false, rail: true });
  assert.equal(await page.$eval('[data-reader-nav="side"]', b => b.classList.contains('active')), true);
  assert.deepEqual(await page.$$eval('[data-reader-nav] span', s => s.map(el => el.textContent)), ['Classic', 'Modern']);
  await page.reload({ waitUntil: 'load' });
  assert.deepEqual(await shown(), { side: true, top: false, rail: true }, 'a reload opens with the side controls');
  await openSettings(page, 'display');
  await page.click('[data-reader-nav="top"]');
  assert.deepEqual(await shown(), { side: false, top: true, rail: false });
});

test('a reader set to the side controls never shows the top bar, not even before its script runs', { skip: !chromePath() }, async t => {
  for (const side of [true, false]) {
    // The reader's own script held back: what the page shows before it runs (the first paint can).
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on('request', req => (req.url().includes('/app/js/') ? req.abort() : req.continue()));
    await page.evaluateOnNewDocument(side => localStorage.setItem('shiori-reader-nav', side ? 'side' : 'top'), side);
    await page.goto(`${origin}/reader?g=${SINGLE}&page=1`, { waitUntil: 'load' });
    const shown = await page.$eval('#topbar', el => getComputedStyle(el).display !== 'none');
    assert.equal(shown, !side, side ? 'the top bar showed before the side controls took over' : 'the top bar should show');
  }
});

test('the mode button steps through single, double and the strip', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single' });
  const mode = () => page.$eval('#modeToggle', el => el.dataset.state);
  for (const next of ['double', 'strip', 'single']) {
    await page.click('#snMode');
    assert.equal(await mode(), next);
  }
});

test('translate and study are one at a time, or neither', { skip: !chromePath() }, async t => {
  const page = await reader(t, { gallery: TRANSLATED, mode: 'single' });
  await until(page, () => !document.getElementById('snStudy').hidden && !document.getElementById('snStudy').disabled, null, { what: 'study to be available' });
  const state = async () => ({ translate: await isOn(page, '#snTranslate'), study: await isOn(page, '#snStudy') });
  await page.click('#snTranslate');
  assert.deepEqual(await state(), { translate: true, study: false });
  await page.click('#snStudy');
  assert.deepEqual(await state(), { translate: false, study: true });
  await page.click('#snStudy');
  assert.deepEqual(await state(), { translate: false, study: false });
});

test('the chapter pill steps through the chapters and lists them', { skip: !chromePath() }, async t => {
  const page = await reader(t, { gallery: SERIES[1], at: 3 });
  const label = () => page.$eval('#snChLabel', el => el.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(await label(), 'Ch. 2 / 3');
  assert.equal(await page.$eval('#snChLabel', el => el.dataset.tip), 'Chapters');
  await page.click('#snChNext');
  await until(page, () => document.getElementById('snChLabel').textContent.includes('Ch. 3'), null, { what: 'the next chapter' });
  assert.equal(await page.$eval('#snChNext', b => b.disabled), true, 'no chapter after the last');
  await page.click('#snChLabel');
  const rows = await page.$$eval('#snChList .sn-ch', rows => rows.map(r => ({ text: r.textContent, current: r.classList.contains('current') })));
  assert.deepEqual(rows.map(r => r.current), [false, false, true]);
  assert.match(rows[0].text, /Ch\. 1\s*Part 1/);
  await page.click('#snChList .sn-ch:first-child');
  await until(page, () => document.getElementById('snChLabel').textContent.includes('Ch. 1'), null, { what: 'the first chapter' });
  assert.equal(await page.$eval('body', b => b.classList.contains('sn-pop-open')), false, 'picking a chapter closes the list');
});

test('a single gallery shows its page in the pill, without chapter arrows', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single' });
  const pill = () => page.evaluate(() => ({
    text: document.getElementById('snChLabel').textContent.trim(),
    arrows: [document.getElementById('snChPrev').hidden, document.getElementById('snChNext').hidden],
    tip: document.getElementById('snChLabel').closest('[data-tip]')?.dataset.tip ?? null,
  }));
  assert.deepEqual(await pill(), { text: '1 / 10', arrows: [true, true], tip: null }, 'no chapter list, so no "Chapters" tooltip');
  await page.keyboard.press('ArrowRight');
  await until(page, () => document.getElementById('snChLabel').textContent.trim() === '2 / 10', null, { what: 'the pill to follow the page' });
});

test("a page turn never scrolls into the room a phone's address bar leaves; a tall page still starts at its top", { skip: !chromePath() }, async t => {
  // A page's view is 100vh tall, on a phone the window without its address bar: with the bar out, the
  // page has the bar's height to spare. Scrolled into by script, Firefox on Android moved its layout
  // without the screen and stopped painting the rail's icons and the progress bar. Headless browsers
  // clamp such a scroll away, so this watches what the reader asks for.
  const watch = page => page.evaluate(() => {
    window.__asked = [];
    const to = window.scrollTo.bind(window);
    window.scrollTo = (x, y) => { window.__asked.push(typeof x === 'object' ? x.top : y); return to(x, y); };
  });
  const asked = page => page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('div'));
    probe.style.cssText = 'position:fixed;height:100vh';
    const spare = document.documentElement.scrollHeight - probe.getBoundingClientRect().height;
    probe.remove();
    return { asked: window.__asked, spare: Math.max(0, Math.floor(spare)) };
  });
  for (const mode of ['single', 'double']) {
    const page = await reader(t, { mode, fit: 'off' });
    for (let k = 0; k < 7; k++) await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true })));   // well under the window's height
    await settle(300);
    await watch(page);
    for (let k = 0; k < 2; k++) { await page.keyboard.press('ArrowRight'); await settle(300); }
    const { asked: ys, spare } = await asked(page);
    assert.ok(ys.length > 0, `${mode}: the turns scrolled to their page`);
    assert.ok(ys.every(y => y <= spare), `${mode}: asked for ${ys}, with ${spare}px to scroll`);
  }
  // A page taller than the window, read down a way: the next one starts at its top.
  const page = await reader(t, { mode: 'single', fit: 'width' });
  await page.evaluate(() => window.scrollTo(0, 500));
  await settle(200);
  await page.keyboard.press('ArrowRight');
  await settle(400);
  assert.equal(await page.evaluate(() => Math.round(document.getElementById('singleInner').getBoundingClientRect().top)), 0, 'the next page at the top of the window');
});

test('X and a double-click hide the side controls, and the right edge brings them back', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  assert.equal(await page.$('#snPin'), null, 'no pin button: X, N or a double-click hide them');
  await page.mouse.move(700, 450);
  assert.equal(await opacity(page, '#sideNav'), 1);
  await page.keyboard.press('x');
  await settle();
  assert.deepEqual([await opacity(page, '#sideNav'), await opacity(page, '#sideZoom')], [0, 0], 'X hides them');
  await page.mouse.move(1395, 300);   // the right edge
  await settle();
  assert.deepEqual([await opacity(page, '#sideNav'), await opacity(page, '#sideZoom')], [1, 1], 'the right edge brings back the column, and zoom with it');
  await page.mouse.move(1300, 880);   // the bottom right corner
  await settle();
  assert.deepEqual([await opacity(page, '#sideNav'), await opacity(page, '#sideZoom')], [0, 1], 'the bottom right corner brings back zoom');
  await page.mouse.move(700, 450);
  await page.mouse.click(700, 450, { count: 2 });
  await settle();
  assert.equal(await opacity(page, '#sideNav'), 1, 'a double-click on the pages brings them back for good');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori-reader-side-pin')), '1');
});

test('N does what X does, and double-clicks straight after one another toggle the controls each time', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  const hidden = () => page.$eval('body', b => b.classList.contains('reader-side-hidden'));
  await page.keyboard.press('n');
  assert.equal(await hidden(), true, 'N hides them');
  await page.keyboard.press('n');
  assert.equal(await hidden(), false, 'N brings them back');
  // One run of quick clicks, counted the way the browser does (1, 2, 3, …): every second one toggles.
  await page.mouse.move(700, 450);
  for (let n = 1; n <= 6; n++) {
    await page.mouse.down({ clickCount: n });
    await page.mouse.up({ clickCount: n });
    assert.equal(await hidden(), Math.floor(n / 2) % 2 === 1, `after click ${n} of the run`);
  }
});

test('in single page only a click on the page turns it, and a double-click beside it hides the controls', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single' });
  const box = await page.$eval('#mainImg', img => { const r = img.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  assert.ok(box.left > 100, 'the page leaves room beside it');
  const y = (box.top + Math.min(box.bottom, 850)) / 2;
  await page.mouse.click(box.left / 2, y);
  await settle(300);
  assert.equal(await counter(page), 1, 'a click beside the page leaves it');
  await page.mouse.click(box.right - 40, y);
  await until(page, () => document.getElementById('pageCounter').textContent.trim().startsWith('2'), null, { what: 'the right half to turn the page on' });
  await page.mouse.click(box.left + 40, y);
  await until(page, () => document.getElementById('pageCounter').textContent.trim().startsWith('1'), null, { what: 'the left half to turn it back' });
  await page.mouse.click(box.left / 2, y, { count: 2 });
  await settle();
  assert.equal(await counter(page), 1);
  assert.equal(await page.$eval('body', b => b.classList.contains('reader-side-hidden')), true, 'the double-click beside the page hides the controls');
});

// The card stands over where the page goes: its click once also reached the page, as a turn.
test("the transition page's next chapter card lands on that chapter's first page, in single and double page", { skip: !chromePath() }, async t => {
  for (const mode of ['single', 'double']) {
    const page = await reader(t, { gallery: SERIES[0], at: 12, mode });
    await page.keyboard.press('ArrowRight');
    await page.waitForSelector('body.page-divider #dividerPage .chd-adj.next');
    const card = await page.$eval('#dividerPage .chd-adj.next', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.click(card.x, card.y);
    await until(page, gid => new URLSearchParams(location.search).get('g') === gid, SERIES[1], { what: 'the next chapter' });
    await settle(300);
    assert.equal(await counter(page), 1, `${mode}: the card's click turns no page as well`);
  }
});

test('double-clicking the pages or the ground beside them selects nothing', { skip: !chromePath() }, async t => {
  for (const mode of ['single', 'double', 'strip']) {
    const page = await reader(t, { mode });
    // Any selection at all, however briefly (a double-click handler could clear it after it painted).
    await page.evaluate(() => {
      window.__selected = 0;
      document.addEventListener('selectionchange', () => { if (!getSelection().isCollapsed) window.__selected++; });
    });
    const box = await page.$eval(mode === 'strip' ? '#stripView .page-wrap' : mode === 'single' ? '#mainImg' : '#doubleInner', el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: Math.max(0, r.top) };
    });
    for (const x of [box.left / 2, (box.left + box.right) / 2]) {
      await page.mouse.click(x, box.top + 300, { count: 2 });
      await settle(150);
      assert.equal(await page.evaluate(() => window.__selected), 0, `a double-click at x=${Math.round(x)} in ${mode} selected something`);
    }
  }
});

test('auto-play runs the strip down at its speed until stopped, or the strip ends', { skip: !chromePath() }, async t => {
  const page = await reader(t, { gallery: SERIES[0], fit: 'off' });
  await openSettings(page);
  await setRange(page, 'readerAutoScroll', 300);
  assert.equal(await page.$eval('#readerAutoScrollValue', el => el.textContent), '300 px/s');
  await page.keyboard.press('Escape');
  const y0 = await page.evaluate(() => scrollY);
  await page.keyboard.press('k');
  await settle(1000);
  const moved = await page.evaluate(() => scrollY) - y0;
  assert.ok(moved > 200 && moved < 420, `about 300 px in a second, not ${moved}`);
  assert.equal(await isOn(page, '#snAuto'), true);
  await page.click('#snAuto');
  const y1 = await page.evaluate(() => scrollY);
  await settle(400);
  assert.equal(await page.evaluate(() => scrollY), y1, 'stopped');
  // It stops by itself at the end of the strip.
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight - innerHeight - 60));
  await settle(200);
  await page.keyboard.press('k');
  await until(page, () => !document.getElementById('snAuto').classList.contains('is-on'), null, { what: 'auto-scroll to stop at the end', timeout: 3000 });
});

// What a page turn shows, measured: its pages' heights one above the other, and the bar's box.
const pagesShown = (page) => page.evaluate(() => {
  const wraps = [...document.querySelectorAll(document.getElementById('singleView').classList.contains('active') ? '#mainImg' : '.dImg:not(.page-blank)')]
    .map(img => (img.parentElement.classList.contains('page-wrap') ? img.parentElement : img).getBoundingClientRect());
  return { height: wraps.reduce((sum, r) => sum + r.height, 0), bottom: Math.max(...wraps.map(r => r.bottom)), left: Math.min(...wraps.map(r => r.left)), right: Math.max(...wraps.map(r => r.right)) };
});

// The seconds a page the settings show for the speed (single/double).
const pageSeconds = (page) => page.$eval('#readerAutoScrollValue', el => parseFloat(el.textContent));

test('in single and double page the speed converts to seconds a page, within 60–1 s and 120–2 s', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single' });
  await openSettings(page);
  const label = () => page.$eval('#readerAutoScrollValue', el => el.textContent);
  const at = async (px) => { await setRange(page, 'readerAutoScroll', px); return label(); };
  assert.equal(await at(20), '60.0 s/page', 'the slowest speed: a minute a page');
  assert.equal(await at(1000), '1.0 s/page', 'the fastest: a second a page');
  assert.equal(await at(150), '52.2 s/page', 'the default, the slider moving the seconds evenly');
  assert.equal(await at(510), '30.5 s/page', 'half way, half way between');
  await page.keyboard.press('Escape');
  await page.keyboard.press('2');   // double page: a spread has its two pages' time
  await openSettings(page);
  assert.equal(await at(1000), '2.0 s/page');
  assert.equal(await at(20), '120.0 s/page');
  await page.keyboard.press('Escape');
  await page.keyboard.press('3');   // the strip: the same speed, as it is
  await openSettings(page);
  assert.equal(await label(), '20 px/s');
});

test('in single page auto-play turns the page after its seconds a page', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single' });
  await openSettings(page);
  await setRange(page, 'readerAutoScroll', 1000);
  const seconds = '1.0';
  assert.equal(await page.$eval('#readerAutoScrollValue', el => el.textContent), `${seconds} s/page`, 'the speed reads as seconds a page');
  await page.keyboard.press('Escape');
  await page.keyboard.press('k');
  await settle(Number(seconds) * 500);   // half its time
  const bar = await page.evaluate(() => {
    const el = document.querySelector('.auto-bar'), r = el.getBoundingClientRect(), fill = el.firstElementChild.getBoundingClientRect();
    return { shown: getComputedStyle(el).display !== 'none', height: r.height, bottom: r.bottom, left: r.left, right: r.right, filled: fill.width / r.width, opacity: Number(getComputedStyle(el).opacity) };
  });
  assert.equal(bar.shown, true);
  assert.equal(bar.height, 4);
  assert.ok(Math.abs(bar.bottom - await page.$eval('#scrubTrack', b => b.getBoundingClientRect().top)) <= 1, "at the window's bottom, on the progress bar's line");
  assert.ok(bar.left === 0 && Math.abs(bar.right - await page.evaluate(() => document.documentElement.clientWidth)) <= 1, 'across the window');
  assert.ok(bar.filled > 0.3 && bar.filled < 0.7, `half filled at half its time, not ${bar.filled}`);
  assert.ok(bar.opacity < 1 && bar.opacity > 0.7, 'just slightly see-through');
  await until(page, () => document.getElementById('pageCounter').textContent.trim().startsWith('2'), null, { what: 'the page to turn', timeout: 3000 });
  assert.equal(await isOn(page, '#snAuto'), true, 'and it plays on');
  await page.keyboard.press('k');
  assert.equal(await page.$eval('.auto-bar', el => getComputedStyle(el).display), 'none', 'paused, no bar');
});

test("a double spread gets its two pages' time, and auto-play stops on the last page", { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'double', at: 4 });
  await openSettings(page);
  await setRange(page, 'readerAutoScroll', 1000);
  assert.equal(await page.$eval('#readerAutoScrollValue', el => el.textContent), '2.0 s/page', 'a spread has its two pages\' time');
  await page.keyboard.press('Escape');
  await page.keyboard.press('End');   // the last spread, pages 9 and 10 (the counter gives its first)
  await until(page, () => document.getElementById('pageCounter').textContent.trim().startsWith('9'), null, { what: 'the last spread' });
  await page.keyboard.press('k');
  await until(page, () => !document.getElementById('snAuto').classList.contains('is-on'), null, { what: 'auto-play to stop on the last page', timeout: 6000 });
  assert.match(await page.$eval('#pageCounter', el => el.textContent), /^9/);
});

test('a page taller than the screen scrolls down evenly, reaching its bottom a second before it turns', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single', fit: 'width' });
  await openSettings(page);
  await setRange(page, 'readerAutoScroll', 980);   // about 2 s a page
  await page.keyboard.press('Escape');
  assert.ok((await pagesShown(page)).height > 1500, 'the page is taller than the screen');
  // Every frame from the press to the turn: where the page is, and how far it can go.
  const run = await page.evaluate(() => new Promise(resolve => {
    const frames = [], t0 = performance.now(), counter = () => document.getElementById('pageCounter').textContent.trim();
    const first = counter();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    const tick = () => {
      frames.push({ t: performance.now() - t0, y: scrollY, max: document.documentElement.scrollHeight - innerHeight, turned: counter() !== first,
        bar: document.querySelector('.auto-bar').getBoundingClientRect().bottom, floor: document.getElementById('scrubTrack').getBoundingClientRect().top });
      if (frames.at(-1).turned || performance.now() - t0 > 5000) resolve(frames); else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const turn = run.findIndex(f => f.turned);
  assert.ok(turn > 0, 'the page turned');
  const before = run.slice(0, turn), last = before.at(-1);
  const bottomAt = before.findIndex(f => f.y >= f.max - 2);
  assert.ok(Math.abs(last.y - last.max) <= 2, `at the turn the page is at its bottom (${last.y} of ${last.max})`);
  const held = run[turn].t - before[bottomAt].t;
  assert.ok(held > 850 && held < 1150, `its bottom comes a second before it turns, not ${Math.round(held)} ms`);
  const half = before.find(f => f.t >= before[bottomAt].t / 2);
  assert.ok(Math.abs(half.y / half.max - 0.5) < 0.15, `evenly: about halfway down at half the way, not ${(half.y / half.max).toFixed(2)}`);
  const mid = before[Math.floor(turn / 2)];
  assert.ok(Math.abs(mid.bar - mid.floor) <= 1, 'the bar stays on screen, just above the progress bar');
});

test('dragging a play button sets the auto-scroll speed, and a press still plays', { skip: !chromePath() }, async t => {
  const page = await reader(t, { gallery: SERIES[0], fit: 'off' });
  await page.click('#snAuto');   // playing: the page scrolls under the drag
  const btn = await page.$eval('#snAuto', b => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(btn.x, btn.y);
  await page.mouse.down();
  const readoutAt = () => page.$eval('.speed-tip', el => { const r = el.getBoundingClientRect(); return [r.left, r.top]; });
  await page.mouse.move(btn.x - 30, btn.y - 20, { steps: 4 });   // left 30, up 20: (−30 + 20) × 2 = −20
  const opened = await readoutAt();
  await page.mouse.move(btn.x + 20, btn.y - 30, { steps: 4 });   // right 50, up 10: (50 + 10) × 2 = +120
  assert.deepEqual(await readoutAt(), opened, 'the readout stays where it opened, not following the cursor');
  // Held there while it plays: the readout stays, the regular tip never shows, frame after frame.
  const frames = await page.evaluate(() => new Promise(resolve => {
    const seen = []; const t0 = performance.now();
    const tick = () => {
      const tip = document.querySelector('.shiori-tip');
      seen.push({ readout: getComputedStyle(document.querySelector('.speed-tip')).display, tip: tip && getComputedStyle(tip).display !== 'none' ? tip.textContent : '' });
      if (performance.now() - t0 < 400) requestAnimationFrame(tick); else resolve(seen);
    };
    requestAnimationFrame(tick);
  }));
  assert.ok(frames.every(f => f.readout === 'flex' && !f.tip), `the readout flickered or the tip showed: ${JSON.stringify(frames.find(f => f.readout !== 'flex' || f.tip))}`);
  const readout = await page.evaluate(() => ({
    value: document.querySelector('.speed-tip-value').textContent,
    fill: document.querySelector('.speed-tip-fill').style.width,
    text: document.querySelector('.speed-tip').textContent,
  }));
  assert.equal(readout.value, '250 px/s');
  assert.equal(parseFloat(readout.fill).toFixed(1), ((250 - 20) / 980 * 100).toFixed(1), 'the bar shows where the speed sits in its range');
  assert.ok(!/Auto-scroll|Drag/.test(readout.text), 'only the bar and the value');
  await page.mouse.up();
  assert.equal(await page.$eval('.speed-tip', el => getComputedStyle(el).display), 'none');
  assert.equal(await isOn(page, '#snAuto'), true, 'a drag sets the speed, it doesn\'t stop or start it');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori:readerAutoScrollSpeed')), '250');
  assert.match(await page.$eval('#snAuto', b => b.dataset.tip), /250 px\/s\nDrag to change the speed/, 'the tip comes back');
  await openSettings(page);
  assert.equal(await page.$eval('#readerAutoScrollValue', el => el.textContent), '250 px/s');
  await setRange(page, 'readerAutoScroll', 1000);
  assert.equal(await page.$eval('#readerAutoScrollValue', el => el.textContent), '1000 px/s', 'up to 1000 px/s');
  await page.keyboard.press('Escape');
  await page.click('#snAuto');
  assert.equal(await isOn(page, '#snAuto'), false, 'a press pauses');
});

test('a speed drag held against the screen\'s edge keeps going, without locking the pointer', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await page.evaluate(() => {
    window.__locked = false;   // a pointer lock would make the browser show its "press Esc" note
    HTMLElement.prototype.requestPointerLock = function () { window.__locked = true; return Promise.resolve(); };
  });
  const btn = await page.$eval('#snAuto', b => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(btn.x, btn.y);
  await page.mouse.down();
  await page.mouse.move(btn.x + 10, btn.y, { steps: 2 });   // a drag: 150 + 20
  const speed = () => page.$eval('.speed-tip-value', el => parseInt(el.textContent, 10));
  // The cursor reaches the screen's right edge and stays there: no more moves arrive.
  const move = (atEdge) => page.evaluate((atEdge) => {
    document.getElementById('snAuto').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1,
      screenX: atEdge ? screen.availLeft + screen.width - 1 : screen.availLeft + screen.width - 200, screenY: 300, clientX: 300, clientY: 300, movementX: atEdge ? 2 : -3, movementY: 0 }));
  }, atEdge);
  await move(true);
  const atEdge = await speed();
  await settle(500);
  const held = await speed();
  assert.ok(held - atEdge > 100 && held - atEdge < 220, `held against the edge for half a second, about +150, not ${held - atEdge}`);
  await move(false);   // off the edge
  const off = await speed();
  await settle(300);
  assert.equal(await speed(), off, 'off the edge, it stops');
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__locked), false, 'the pointer is never locked');
});

test('the top bar has its own play button, left of the reading mode', { skip: !chromePath() }, async t => {
  const page = await reader(t, { side: false });
  const order = await page.evaluate(() => document.getElementById('autoBtn').nextElementSibling.id);
  assert.equal(order, 'modeToggle');
  await page.keyboard.press('n');   // the header pinned, its buttons on screen to press
  await page.click('#autoBtn');
  assert.equal(await page.$eval('#autoBtn', b => b.classList.contains('active')), true);
  assert.equal(await isOn(page, '#snAuto'), true, 'one auto-scroll, both buttons');
  await page.keyboard.press('k');
  assert.equal(await page.$eval('#autoBtn', b => b.classList.contains('active')), false);
});

test('a tooltip follows a click on its button without the mouse moving', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single' });
  const btn = await page.$eval('#snMode', b => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(btn.x, btn.y);
  const tip = () => page.$eval('.shiori-tip', el => el.textContent);
  assert.equal(await tip(), 'Single page');
  await page.mouse.down(); await page.mouse.up();
  await until(page, () => document.querySelector('.shiori-tip').textContent === 'Double page', null, { what: 'the tip to name the new mode' });
});

test('revealing the thumbnails from the progress bar lifts zoom and the go-to-top button with them', { skip: !chromePath() }, async t => {
  const page = await reader(t, { side: false });   // the classic navigation's go-to-top button, above zoom
  const seg = await page.$eval('.scrub-segment:nth-child(5)', s => { const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: innerHeight - 2 }; });
  await page.mouse.move(seg.x, seg.y);
  await page.mouse.down();
  for (const up of [30, 60]) {
    await page.mouse.move(seg.x, seg.y - up, { steps: 3 });
    const gap = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      const strip = document.getElementById('thumbStrip').getBoundingClientRect();
      const zoom = document.getElementById('sideZoom').getBoundingClientRect();
      const top = document.getElementById('scrollTopBtn').getBoundingClientRect();
      resolve({ strip: strip.height, zoom: Math.round(strip.top - zoom.bottom), top: Math.round(strip.top - top.bottom) });
    }))));
    assert.ok(gap.strip > 10, 'the strip is coming out');
    assert.deepEqual([gap.zoom, gap.top], [12, 56], `zoom and the go-to-top button ride on the strip (${JSON.stringify(gap)})`);
  }
  await page.mouse.up();
});

test('someone new to the reader starts with the side controls, pinned; someone who has read before keeps the top bar', { skip: !chromePath() }, async t => {
  for (const readBefore of [false, true]) {
    const page = await openPage(browser, origin);
    t.after(() => page.close());
    await page.evaluateOnNewDocument((readBefore) => {
      if (sessionStorage.getItem('fixture-set')) return;
      sessionStorage.setItem('fixture-set', '1');
      for (const key of ['shiori-reader-nav', 'shiori-reader-side-pin', 'shiori:readerMode']) localStorage.removeItem(key);
      if (readBefore) localStorage.setItem('shiori:readerMode', '"strip"');
    }, readBefore);
    await page.goto(`${origin}/reader?g=${SINGLE}&page=1`, { waitUntil: 'load' });
    await page.waitForSelector('#sideNav');
    const state = await page.evaluate(() => ({
      side: document.body.classList.contains('reader-side-nav'),
      shown: !document.body.classList.contains('reader-side-hidden'),
      saved: localStorage.getItem('shiori-reader-nav'),
    }));
    assert.deepEqual(state, readBefore ? { side: false, shown: true, saved: 'top' } : { side: true, shown: true, saved: 'side' });
  }
});

test('hidden, zoom comes back where it stands, above open thumbnails', { skip: !chromePath() }, async t => {
  const page = await reader(t, { sidePinned: false });
  await page.keyboard.press('g');   // thumbnails
  await settle(500);
  const zoom = await page.$eval('#sideZoom', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const strip = await page.$eval('#thumbStrip', el => el.getBoundingClientRect().top);
  assert.ok(zoom.y < strip, 'zoom stands above the thumbnails');
  await page.mouse.move(zoom.x, strip + 20);   // the corner, down on the thumbnails
  await settle();
  assert.equal(await opacity(page, '#sideZoom'), 0, 'the thumbnails below it don\'t bring it back');
  await page.mouse.move(zoom.x, zoom.y);
  await settle();
  assert.equal(await opacity(page, '#sideZoom'), 1, 'pointing where it stands brings it back');
});

const barFilled = (page) => page.$eval('.auto-bar', el => el.firstElementChild.getBoundingClientRect().width / el.getBoundingClientRect().width);

test('scrolling back up, or turning a page back, stops auto-play; going on by hand keeps it', { skip: !chromePath() }, async t => {
  const playing = (page) => isOn(page, '#snAuto');
  // A tall page in single page: the wheel up stops it.
  let page = await reader(t, { mode: 'single', fit: 'width' });
  await openSettings(page);
  await setRange(page, 'readerAutoScroll', 900);   // about 7 s a page
  await page.keyboard.press('Escape');
  await page.mouse.move(700, 450);
  await page.keyboard.press('k');
  await settle(800);
  assert.ok(await page.evaluate(() => scrollY) > 50, 'it has scrolled down some');
  await page.mouse.wheel({ deltaY: -200 });
  await settle(200);
  assert.equal(await playing(page), false, 'the wheel up stopped it');
  assert.equal(await page.$eval('.auto-bar', el => getComputedStyle(el).display), 'none');
  // The strip: the wheel up stops it.
  page = await reader(t, { gallery: SERIES[0], fit: 'off' });
  await page.mouse.move(700, 450);
  await page.keyboard.press('k');
  await settle(600);
  await page.mouse.wheel({ deltaY: -200 });
  await settle(200);
  assert.equal(await playing(page), false, 'the wheel up stopped the strip');
  // Single page: turning forward by hand keeps it, turning back stops it.
  page = await reader(t, { mode: 'single', at: 3 });
  await page.keyboard.press('k');
  await page.keyboard.press('ArrowRight');
  await until(page, () => document.getElementById('pageCounter').textContent.trim().startsWith('4'), null, { what: 'the page to turn on' });
  await settle(900);   // past the turn's own scroll to the page's top
  assert.equal(await playing(page), true, 'going on by hand keeps it playing');
  await page.keyboard.press('ArrowLeft');
  await settle(200);
  assert.equal(await playing(page), false, 'turning back stopped it');
});

test('started again partway down a tall page, auto-play goes on from where it is', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single', fit: 'width' });
  await openSettings(page);
  await setRange(page, 'readerAutoScroll', 900);   // about 7 s a page
  await page.keyboard.press('Escape');
  await page.keyboard.press('k');
  await settle(1200);
  await page.keyboard.press('k');   // paused partway down
  const y = await page.evaluate(() => scrollY);
  assert.ok(y > 100);
  await page.keyboard.press('k');
  await settle(100);
  assert.ok(await page.evaluate(() => scrollY) >= y - 1, 'it didn\'t jump back to the page\'s top');
  assert.ok(await barFilled(page) > 0.05, 'its time is as far along as the page');
  await page.keyboard.press('k');
});

test('scrolling a tall page on by hand keeps its time: it still turns on time, at its bottom', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single', fit: 'width' });
  await openSettings(page);
  await setRange(page, 'readerAutoScroll', 980);   // about 2 s a page
  const seconds = await pageSeconds(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('k');
  const t0 = Date.now();
  await settle(seconds * 300);
  const before = await barFilled(page);
  await page.evaluate(() => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * 0.85));   // most of the way down, by hand
  await settle(100);
  assert.ok(await barFilled(page) < before + 0.15, 'its time doesn\'t jump ahead with the page');
  // It turns when its time is up, its bottom showing at the turn.
  const last = await page.evaluate(() => new Promise(resolve => {
    let prev = null;
    const tick = () => {
      const now = { y: scrollY, max: document.documentElement.scrollHeight - innerHeight, counter: document.getElementById('pageCounter').textContent.trim() };
      if (!now.counter.startsWith('1')) resolve(prev); else { prev = now; requestAnimationFrame(tick); }
    };
    requestAnimationFrame(tick);
  }));
  const took = (Date.now() - t0) / 1000;
  assert.ok(took > seconds * 0.85, `it kept its time (${took.toFixed(2)} s of ${seconds.toFixed(2)} s)`);
  assert.ok(Math.abs(last.y - last.max) <= 2, `at its bottom as it turned (${last.y} of ${last.max})`);
});

test('the auto-play bar stands on the progress bar\'s line, and its growing lifts it', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single' });
  await openSettings(page);
  await setRange(page, 'readerAutoScroll', 100);   // a long page time
  await page.keyboard.press('Escape');
  await page.mouse.move(700, 300);
  await page.keyboard.press('k');
  await settle(300);
  const gap = () => page.evaluate(() => {
    const bar = document.querySelector('.auto-bar').getBoundingClientRect(), track = document.getElementById('scrubTrack').getBoundingClientRect();
    return { gap: Math.round(track.top - bar.bottom), track: Math.round(track.height) };
  });
  const resting = await gap();
  assert.deepEqual(resting, { gap: 0, track: 3 }, 'right on the resting line, nothing between');
  const segment = await page.$eval('.scrub-segment:nth-child(3)', s => { const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: innerHeight - 6 }; });
  await page.mouse.move(segment.x, segment.y);   // the progress bar grows under the pointer
  await settle(400);
  const grown = await gap();
  assert.equal(grown.track, 12);
  assert.equal(grown.gap, 0, 'lifted with it, still right on it');
  await page.keyboard.press('k');
});

test('on a page that fits, the wheel turned down leaves auto-play be, and turned up stops it', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single' });
  await openSettings(page);
  await setRange(page, 'readerAutoScroll', 900);   // about 7 s a page
  await page.keyboard.press('Escape');
  await page.keyboard.press('k');
  await settle(600);
  const before = await barFilled(page);
  await page.mouse.move(700, 450);
  await page.mouse.wheel({ deltaY: 600 });
  await settle(300);
  assert.ok(await barFilled(page) > before, 'turned down, its bar runs on');
  await page.mouse.wheel({ deltaY: -100 });
  await settle(100);
  assert.equal(await isOn(page, '#snAuto'), false, 'turned up, even with nothing to scroll, it stops');
});

test('auto-play waits while a dialog is open, and goes on once it closes; not the reader settings', { skip: !chromePath() }, async t => {
  const page = await reader(t, { gallery: SERIES[0], fit: 'off' });
  await page.keyboard.press('k');
  await settle(300);
  await page.keyboard.press('?');   // the shortcuts
  await page.waitForSelector('#keybindModal.show');
  const y = await page.evaluate(() => scrollY);
  await settle(500);
  assert.equal(await page.evaluate(() => scrollY), y, 'it waits behind the shortcuts');
  assert.equal(await isOn(page, '#snAuto'), true, 'still playing');
  await page.keyboard.press('Escape');
  await settle(400);
  assert.ok(await page.evaluate(() => scrollY) > y, 'it goes on once they close');
  await openSettings(page);
  const under = await page.evaluate(() => scrollY);
  await settle(500);
  assert.ok(await page.evaluate(() => scrollY) > under + 30, 'under the reader settings it plays on: its speed is set watching it');
});

test('auto-play stops at its chapter\'s end, on another chapter, and on another reading mode', { skip: !chromePath() }, async t => {
  // Single page: the chapter's last page ends it; it doesn't turn into the next chapter.
  let page = await reader(t, { gallery: SERIES[0], mode: 'single', at: 12 });
  await openSettings(page);
  await setRange(page, 'readerAutoScroll', 1000);
  await page.keyboard.press('Escape');
  await page.keyboard.press('k');
  await until(page, () => !document.getElementById('snAuto').classList.contains('is-on'), null, { what: 'auto-play to stop at the chapter\'s end', timeout: 4000 });
  assert.equal(await page.$eval('#snChLabel', el => el.textContent.replace(/\s+/g, ' ').trim()), 'Ch. 1 / 3', 'still in its chapter');
  // Another chapter, by hand.
  page = await reader(t, { gallery: SERIES[0] });
  await page.keyboard.press('k');
  await page.click('#snChNext');
  await settle(300);
  assert.equal(await isOn(page, '#snAuto'), false, 'another chapter stops it');
  // Another reading mode.
  await page.keyboard.press('k');
  await page.keyboard.press('1');
  assert.equal(await isOn(page, '#snAuto'), false, 'another reading mode stops it');
});

test('dim pages darkens the pages by the chosen amount', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  const filter = () => page.$eval('#stripView .page-wrap', w => getComputedStyle(w).filter);
  assert.equal(await filter(), 'none');
  await openSettings(page);
  await setRange(page, 'readerDim', 40);
  assert.equal(await page.$eval('#readerDimValue', el => el.textContent), '40%');
  assert.equal(await filter(), 'brightness(0.6)');
  await setRange(page, 'readerDim', 0);
  assert.equal(await filter(), 'none');
});

test('the fit button switches fit width and fit height, and zooming turns it off', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single', fit: 'off' });
  const fit = () => page.evaluate(() => ({
    width: document.body.classList.contains('reader-fit-width'),
    height: document.body.classList.contains('reader-fit-height'),
    lit: document.getElementById('snFit').classList.contains('is-on'),
  }));
  assert.deepEqual(await fit(), { width: false, height: false, lit: false });
  await page.click('#snFit');
  assert.deepEqual(await fit(), { width: true, height: false, lit: true });
  await page.click('#snFit');
  assert.deepEqual(await fit(), { width: false, height: true, lit: true });
  const before = await page.$eval('#snZoomValue', el => el.textContent);
  await page.click('#snZoomIn');
  assert.deepEqual(await fit(), { width: false, height: false, lit: false }, 'zooming turns the fit off');
  assert.notEqual(await page.$eval('#snZoomValue', el => el.textContent), before);
});

test('the side controls sit as far from the right as from the top and bottom', { skip: !chromePath() }, async t => {
  for (const custom of ['true', 'false']) {   // our scrollbars, and the browser's own beside the pages
    const page = await reader(t, { position: 'off' });
    await page.evaluate(custom => localStorage.setItem('shiori:customScrollbar', custom), custom);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#sideNav');
    await settle();   // zoom eases to its place once the saved progress-bar position applies
    const gaps = await page.evaluate(() => {
      const edge = document.documentElement.clientWidth;   // the pages' right edge, a scrollbar beside them or not
      const r = id => document.getElementById(id).getBoundingClientRect();
      const pill = r('snChapter'), rail = r('snRail'), zoom = r('sideZoom');
      return { top: pill.top, right: edge - pill.right, railRight: edge - rail.right, railBelowPill: rail.top - pill.bottom,
        zoomRight: edge - zoom.right, zoomBottom: innerHeight - zoom.bottom };
    });
    assert.deepEqual(gaps, { top: 12, right: 12, railRight: 12, railBelowPill: 10, zoomRight: 12, zoomBottom: 12 },
      `with custom scrollbars ${custom}`);
  }
  // The classic navigation: zoom in the same corner, and its go-to-top button 10px above it.
  const page = await reader(t, { side: false, position: 'off' });
  await settle();
  const classic = await page.evaluate(() => {
    const edge = document.documentElement.clientWidth;
    const zoom = document.getElementById('sideZoom').getBoundingClientRect(), top = document.getElementById('scrollTopBtn').getBoundingClientRect();
    return { zoomRight: edge - zoom.right, zoomBottom: innerHeight - zoom.bottom,
      topBtn: { right: edge - top.right, size: [top.width, top.height], aboveZoom: zoom.top - top.bottom } };
  });
  assert.deepEqual(classic, { zoomRight: 12, zoomBottom: 12, topBtn: { right: 12, size: [34, 34], aboveZoom: 10 } });
});

test('resizing the thumbnails, zoom and the go-to-top button keep up with their top edge', { skip: !chromePath() }, async t => {
  const page = await reader(t, { side: false });   // the classic navigation's go-to-top button, above zoom
  await page.keyboard.press('g');   // thumbnails
  await settle(800);   // the strip has finished opening
  const grip = await page.$eval('#thumbResizeHandle', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  let worst = 0;
  for (let dy = 12; dy <= 120; dy += 12) {
    await page.mouse.move(grip.x, grip.y - dy);
    worst = Math.max(worst, await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      const strip = document.getElementById('thumbStrip').getBoundingClientRect();
      const zoom = document.getElementById('sideZoom').getBoundingClientRect();
      const top = document.getElementById('scrollTopBtn').getBoundingClientRect();
      resolve(Math.max(Math.abs(zoom.bottom + 12 - strip.top), Math.abs(top.bottom + 56 - strip.top)));
    })))));
  }
  await page.mouse.up();
  assert.ok(worst <= 1, `zoom or the go-to-top button trailed the strip's top edge by ${worst}px`);
});

test('the side controls keep clear of the progress bar and the thumbnails', { skip: !chromePath() }, async t => {
  for (const [position, place] of [['right', 'right-start'], ['top', 'right-start'], ['left', 'left-start'], ['top', 'top-center']]) {
    const page = await reader(t, { position, place });
    const gap = await page.evaluate((position) => {
      const bar = document.getElementById('bottombar').getBoundingClientRect();
      return Math.min(...['snChapter', 'snRail'].map(id => {
        const nav = document.getElementById(id).getBoundingClientRect();
        return position === 'right' ? bar.left - nav.right : position === 'left' ? nav.left - bar.right : nav.top - bar.bottom;
      }));
    }, position);
    assert.ok(gap >= 0, `the side controls (${place}) overlap a ${position} bar by ${-gap}px`);
  }
  const page = await reader(t);
  await page.click('#snThumbs');
  await settle(400);
  const gap = await page.evaluate(() => document.getElementById('thumbStrip').getBoundingClientRect().top - document.getElementById('sideZoom').getBoundingClientRect().bottom);
  assert.ok(gap >= 0, `zoom overlaps the open thumbnails by ${-gap}px`);
  assert.equal(await isOn(page, '#snThumbs'), true);
});

// The modern navigation's rail: on its edge, 12px out, at its start, centre or end, clear of the
// chapter pill (top left for a rail on the left, top right otherwise) and of zoom (bottom right).
test('the rail stands at any of twelve places, clear of the chapter pill and zoom', { skip: !chromePath() }, async t => {
  for (const pos of ['top', 'bottom', 'left', 'right']) {
    for (const align of ['start', 'center', 'end']) {
      const what = `${pos}-${align}`;
      const page = await reader(t, { place: what, position: 'off' });
      await settle();   // a rail on the bottom eases to its place once the saved progress-bar position applies, as zoom does
      const { rail, pill, zoom, W, H } = await page.evaluate(() => {
        const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
        return { rail: r('snRail'), pill: r('snChapter'), zoom: r('sideZoom'), W: document.documentElement.clientWidth, H: innerHeight };
      });
      const across = pos === 'top' || pos === 'bottom';
      assert.equal(Math.round({ top: rail.top, bottom: H - rail.bottom, left: rail.left, right: W - rail.right }[pos]), 12, `${what}: 12px from its edge`);
      assert.equal(rail.width > rail.height, across, `${what}: a row across the window, a column down it`);
      assert.equal(Math.round(Math.min(rail.width, rail.height)), Math.round(pill.height), `${what}: as thick as the pill, across or down`);
      assert.equal(Math.round(pill.top), 12, `${what}: the pill at the top`);
      assert.equal(Math.round(pos === 'left' ? pill.left : W - pill.right), 12, `${what}: the pill on the rail's side`);
      const along = {
        'right-start': rail.top - pill.bottom, 'left-start': rail.top - pill.bottom, 'top-start': rail.left - 2, 'bottom-start': rail.left - 2,
        'right-end': zoom.top - rail.bottom, 'left-end': H - rail.bottom - 2, 'top-end': pill.left - rail.right, 'bottom-end': zoom.left - rail.right,
      }[what];
      if (align === 'center') assert.ok(Math.abs((across ? rail.left + rail.right - W : rail.top + rail.bottom - H) / 2) <= 1, `${what}: centred`);
      else assert.equal(Math.round(along), 10, `${what}: 10px past the pill or short of zoom, or 12px from the corner`);
      for (const [name, other] of [['the pill', pill], ['zoom', zoom]]) {
        const overlap = rail.left < other.right && other.left < rail.right && rail.top < other.bottom && other.top < rail.bottom;
        assert.equal(overlap, false, `${what}: the rail overlaps ${name}`);
      }
    }
  }
});

test('the position picker: a click shows the edges, an edge its places, a place is picked; a drag picks where it lets go', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await openSettings(page, 'display');
  const place = () => page.evaluate(() => localStorage.getItem('shiori-reader-nav-place'));
  const tips = () => page.$$eval('#rsPicker .rs-pick-cell', cs => cs.map(c => c.dataset.tip));
  const hidden = () => page.$eval('#rsPicker', p => p.hidden);
  await page.click('#readerNavPlace');
  assert.deepEqual(await tips(), ['Top', 'Left', 'Right', 'Bottom'], 'a cross of the edges');
  await page.click('#rsPicker [data-edge="top"]');
  assert.deepEqual(await tips(), ['Top · Left', 'Top · Center', 'Top · Right', 'Left', 'Right', 'Bottom'], "the top edge's places, the other edges still there");
  await page.click('#rsPicker [data-edge="top"][data-along="end"]');
  assert.equal(await place(), 'top-end');
  assert.equal(await hidden(), true, 'picked, it goes away');
  assert.equal(await page.$eval('#readerNavPlaceValue', el => el.textContent), 'Top · Right');
  assert.equal(await page.evaluate(() => `${document.documentElement.dataset.snPos}-${document.documentElement.dataset.snAlign}`), 'top-end', 'the rail moves at once');
  // Pressed and dragged: onto the left edge, down to its end, let go there.
  const btn = await page.$eval('#readerNavPlace', b => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const drag = async (...to) => {
    await page.mouse.move(btn.x, btn.y);
    await page.mouse.down();
    for (const [dx, dy] of to) await page.mouse.move(btn.x + dx, btn.y + dy, { steps: 4 });
    await page.mouse.up();
  };
  await drag([-44, 0], [-44, 44]);
  assert.equal(await place(), 'left-end');
  await drag([44, 0]);
  assert.equal(await place(), 'right-center', 'let go on an edge: its centre');
  await drag([-200, -150]);
  assert.deepEqual([await place(), await hidden()], ['right-center', true], 'let go anywhere else: nothing picked');
  // The button puts them away again; so does Escape, before it closes the settings.
  await page.click('#readerNavPlace');
  await page.click('#readerNavPlace');
  assert.deepEqual([await place(), await hidden()], ['right-center', true]);
  await page.click('#readerNavPlace');
  await page.keyboard.press('Escape');
  assert.deepEqual([await hidden(), await page.$eval('#readerSettingsModal', m => m.classList.contains('show'))], [true, true]);
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#readerSettingsModal', m => m.classList.contains('show')), false);
});

test('the progress bar and the auto-scroll bar pick their edge the same way, Off in a corner', { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single' });
  await openSettings(page, 'display');
  const cells = () => page.$$eval('#rsPicker .rs-pick-cell', cs => cs.map(c => c.dataset.tip + (c.classList.contains('current') ? '*' : '')));
  await page.click('#readerProgress');
  assert.deepEqual(await cells(), ['Top', 'Left', 'Right', 'Bottom*', 'Off']);
  await page.click('#rsPicker [data-edge="right"]');
  assert.equal(await page.$eval('#bottombar', b => b.dataset.position), 'right');
  await page.click('#readerProgress');
  await page.click('#readerProgress');   // pressed again, the button puts them away: nothing under it to pick
  assert.equal(await page.$eval('#bottombar', b => b.dataset.position), 'right');
  await page.click('#readerProgress');
  await page.click('#rsPicker [data-edge="off"]');
  assert.equal(await page.$eval('#bottombar', b => b.dataset.position), 'off');
  await page.click('#readerAutoBar');
  assert.deepEqual(await cells(), ['Top', 'Bottom*'], 'the auto-scroll bar has the top or the bottom');
  await page.click('#rsPicker [data-edge="top"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori:readerAutoBarPosition')), '"top"');
  assert.equal(await page.$eval('#readerAutoBarValue', el => el.textContent), 'Top');
});

test('the auto-scroll bar runs across the window at its top or bottom, inside a progress bar on that edge', { skip: !chromePath() }, async t => {
  for (const [autoBar, position] of [['top', 'top'], ['top', 'bottom'], ['bottom', 'left']]) {
    const page = await reader(t, { mode: 'single', autoBar, position });
    await openSettings(page);
    await setRange(page, 'readerAutoScroll', 100);   // a long page time
    await page.keyboard.press('Escape');
    await page.keyboard.press('k');
    await settle(300);
    const { bar, track, W, H } = await page.evaluate(() => {
      const r = el => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
      return { bar: r(document.querySelector('.auto-bar')), track: r(document.getElementById('scrubTrack')), W: document.documentElement.clientWidth, H: innerHeight };
    });
    const where = `${autoBar} with a ${position} progress bar`;
    if (position === 'top') assert.equal(bar.top, track.bottom, `${where}: just under the progress bar`);
    else if (autoBar === 'top') assert.equal(bar.top, 0, `${where}: at the window's top`);
    else assert.equal(bar.bottom, H, `${where}: at the window's bottom`);
    assert.deepEqual([bar.left, bar.right], [position === 'left' ? track.right : 0, W], `${where}: across the window`);
    await page.keyboard.press('k');
  }
});

test('the rail ends with a go-to-top button, there to press once the strip is scrolled down, and it works while auto-play plays', { skip: !chromePath() }, async t => {
  for (const pauseOnUp of [true, false]) {
    const page = await reader(t, { gallery: SERIES[0], fit: 'off', pauseOnUp });
    assert.equal(await page.$eval('#snRail', r => r.lastElementChild.id), 'snTop');
    assert.equal(await page.$eval('#snTop', b => b.disabled), true, 'at the top, nothing to go back up to');
    await page.evaluate(() => scrollTo(0, 3000));
    await settle(200);
    assert.equal(await page.$eval('#snTop', b => b.disabled), false);
    await page.keyboard.press('k');
    await settle(300);
    await page.click('#snTop');
    // Every frame for a second: how high it got, and whether it plays at the end.
    const run = await page.evaluate(() => new Promise(resolve => {
      let lowest = Infinity; const t0 = performance.now();
      const tick = () => {
        lowest = Math.min(lowest, scrollY);
        if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
        else resolve({ lowest, y: scrollY, playing: document.getElementById('snAuto').classList.contains('is-on') });
      };
      requestAnimationFrame(tick);
    }));
    assert.equal(run.lowest, 0, `pause on going up ${pauseOnUp}: it reached the top`);
    if (pauseOnUp) assert.deepEqual([run.playing, run.y], [false, 0], 'going back up paused auto-play');
    else assert.ok(run.playing && run.y > 0, `it reads on from the top (${JSON.stringify(run)})`);
    await page.keyboard.press('1');
    assert.equal(await page.$eval('#snTop', b => b.disabled), true, 'single page: none');
  }
});

test('with "pause when going back up" off, the wheel up and a page turned back leave auto-play playing', { skip: !chromePath() }, async t => {
  let page = await reader(t, { gallery: SERIES[0], fit: 'off' });
  await openSettings(page, 'pages');
  assert.equal(await page.$eval('#readerPauseOnUp', i => i.checked), true, 'on by default');
  await page.click('label[for="readerPauseOnUp"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori:readerAutoPauseOnUp')), 'false');
  await page.keyboard.press('Escape');
  await page.evaluate(() => scrollTo(0, 1500));
  await page.mouse.move(700, 450);
  await page.keyboard.press('k');
  await settle(300);
  await page.mouse.wheel({ deltaY: -300 });
  await settle(300);
  assert.equal(await isOn(page, '#snAuto'), true, 'the wheel up: it reads on from there');
  page = await reader(t, { mode: 'single', at: 3, pauseOnUp: false });
  await page.keyboard.press('k');
  await page.keyboard.press('ArrowLeft');
  await until(page, () => document.getElementById('pageCounter').textContent.trim().startsWith('2'), null, { what: 'the page to turn back' });
  await settle(200);
  assert.equal(await isOn(page, '#snAuto'), true, 'a page turned back: it reads on from there');
});

test("with the reader settings open the reader's keys work, but not the keys their focused control uses", { skip: !chromePath() }, async t => {
  const page = await reader(t, { mode: 'single' });
  await openSettings(page, 'reading');
  const state = () => page.evaluate(() => ({ mode: document.getElementById('modeToggle').dataset.state, page: document.getElementById('pageCounter').textContent.trim(),
    open: document.getElementById('readerSettingsModal').classList.contains('show') }));
  await page.keyboard.press('2');
  assert.deepEqual(await state(), { mode: 'double', page: '1 / 10', open: true }, 'a key changes the reading mode behind the settings');
  await page.focus('#readerAutoScroll');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.$eval('#readerAutoScroll', i => i.value), '160', 'the slider takes its arrow');
  assert.deepEqual(await state(), { mode: 'double', page: '1 / 10', open: true }, 'and the page stays');
  await page.keyboard.press('k');
  assert.equal(await isOn(page, '#snAuto'), true, 'K plays, the slider focused');
  await page.keyboard.press('k');
  await page.keyboard.press('?');
  assert.deepEqual([await state().then(s => s.open), await page.$eval('#keybindModal', m => m.classList.contains('show'))], [false, true], 'the shortcuts take the settings\' place');
});

test('the reader settings keep their top from tab to tab and end with the tab shown, the most used first', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await openSettings(page, 'reading');
  assert.deepEqual(await page.$$eval('[role="tab"]', tabs => tabs.map(tab => tab.textContent)), ['Reading', 'Pages', 'Display']);
  const boxes = {};
  for (const tab of ['reading', 'pages', 'display']) {
    await page.$eval(`[data-rs-tab="${tab}"]`, el => el.click());
    // What shows: the header over the tab, its bottom right under the tab's last setting.
    const panel = await rect(page, `[data-rs-panel="${tab}"]`);
    boxes[tab] = { top: (await rect(page, '.reader-settings-top')).top, bottom: panel.bottom };
    assert.equal(await page.$eval(`[data-rs-panel="${tab}"]`, p => getComputedStyle(p).visibility), 'visible');
    const last = await page.$eval(`[data-rs-panel="${tab}"] > :last-child`, el => el.getBoundingClientRect().bottom);
    assert.ok(Math.abs(panel.bottom - 19 - last) <= 1, `${tab}: ${panel.bottom - last}px below its last setting`);
  }
  const { reading, pages, display } = boxes;
  assert.ok(reading.top === pages.top && pages.top === display.top, `the top stays put: ${JSON.stringify(boxes)}`);
  assert.ok(pages.bottom < display.bottom, 'a shorter tab, a shorter box');
  // Centred as the tallest tab would be.
  assert.ok(Math.abs((display.top + display.bottom) / 2 - 450) <= 1, `the tallest tab centred: ${display.top}–${display.bottom}`);
  // Below a shorter tab is the backdrop's: a click there closes the settings.
  await page.$eval('[data-rs-tab="pages"]', el => el.click());
  await page.mouse.click(700, display.bottom - 10);
  assert.equal(await page.$eval('#readerSettingsModal', m => m.classList.contains('show')), false, 'a click under a shorter tab closes them');
  await openSettings(page, 'reading');
  // The fit choices show their keys, as the reading modes do; the page gap is with them.
  assert.deepEqual(await page.$$eval('[data-reader-fit] .rs-kbd', ks => ks.map(k => k.textContent)), ['Shift+E', 'Shift+Q']);
  assert.equal(await page.$eval('#readerGap', el => el.closest('[role="tabpanel"]').dataset.rsPanel), 'reading');
  // The spread settings can be set from any mode: the reading mode is on another tab.
  assert.equal(await page.$eval('#modeToggle', m => m.dataset.state), 'strip');
  assert.equal(await page.$$eval('[data-page-direction], #readerCoverOffset', els => els.some(el => el.matches(':disabled'))), false);
  await page.$eval('[data-rs-tab="pages"]', el => el.click());
  await page.click('[data-page-direction="rtl"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori:readerPageDirection')), '"rtl"');
  // The arrow keys go from tab to tab.
  await page.focus('[data-rs-tab="display"]');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.$eval('[aria-selected="true"]', tab => tab.dataset.rsTab), 'reading');
});

test('what Settings → Reader has applies at once from the reader settings', { skip: !chromePath() }, async t => {
  const page = await reader(t, { gallery: SERIES[1], at: 5 });
  const strip = () => page.evaluate(() => ({ rows: document.querySelectorAll('#stripView .page-wrap').length, cards: document.querySelectorAll('#stripView .chapter-divider').length,
    page: document.getElementById('pageCounter').textContent.trim(), onLine: Math.round(document.querySelector('#stripView .page-wrap[data-page="17"]').getBoundingClientRect().top) }));
  assert.deepEqual(await strip(), { rows: 36, cards: 3, page: '5 / 12', onLine: 0 });
  await openSettings(page, 'pages');
  await page.click('label[for="readerStripFlow"]');
  assert.deepEqual(await strip(), { rows: 12, cards: 1, page: '5 / 12', onLine: 0 }, 'one chapter, the same page on the reading line');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori:readerStripMode')), '"chapter"');
  await page.click('label[for="readerStripFlow"]');
  await page.click('label[for="readerTransitions"]');
  assert.deepEqual(await strip(), { rows: 36, cards: 0, page: '5 / 12', onLine: 0 }, 'the whole series, no chapter cards');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori:readerChapterDivider')), 'false');
  await page.click('label[for="readerOverview"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori:readerSkipOverview')), 'true');
  // Translation and study: the pages on screen are drawn again as they ask.
  const tr = await reader(t, { gallery: TRANSLATED, mode: 'single' });
  await until(tr, () => !document.getElementById('snTranslate').disabled, null, { what: 'the translation' });
  await tr.click('#snTranslate');
  await until(tr, () => document.getElementById('mainImg').src.startsWith('blob:'), null, { what: 'the translated page' });
  const before = await tr.$eval('#mainImg', img => img.src);
  await openSettings(tr, 'display');
  await tr.click('[data-translate-display="text"]');
  await until(tr, (src) => document.getElementById('mainImg').src !== src, before, { what: 'the page drawn as text over its cleaned image' });
  assert.equal(await tr.evaluate(() => localStorage.getItem('shiori:readerTranslateDisplay')), '"text"');
  assert.equal(await tr.$eval('#readerStudyFont', s => s.matches(':disabled')), true, 'the font is for the original shown as text');
  await tr.click('[data-study-original="text"]');
  assert.equal(await tr.$eval('#readerStudyFont', s => s.matches(':disabled')), false);
  await tr.select('#readerStudyFont', 'kiwi');
  await tr.click('label[for="readerFurigana"]');
  await tr.click('[data-study-display="text"]');
  assert.deepEqual(await tr.evaluate(() => ['readerStudyOriginal', 'readerStudySrcFont', 'readerFurigana', 'readerStudyDisplay'].map(k => JSON.parse(localStorage.getItem(`shiori:${k}`)))),
    ['text', 'kiwi', 'on', 'text']);
});

test('the classic top bar: its title lights up when pointed at, and zoom stands at the bottom right', { skip: !chromePath() }, async t => {
  const page = await reader(t, { side: false });
  await page.evaluate(() => localStorage.setItem('shiori-reader-pin', '1'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#tbMeta');
  assert.equal(await page.$eval('#sideZoom', z => getComputedStyle(z).display), 'flex');
  await page.hover('#tbMeta');
  await settle(200);
  const filter = await page.$eval('#tbMeta', el => getComputedStyle(el).filter);
  assert.match(filter, /^brightness\((\d*\.?\d+)\)$/);
  assert.ok(parseFloat(filter.slice(11)) > 1, `brighter, not dimmer: ${filter}`);
});

test('in a narrow window the picker stays inside it, and a click on its button only opens it', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await page.setViewport({ width: 420, height: 800 });
  await openSettings(page, 'display');
  await page.$eval('#readerNavPlace', b => b.scrollIntoView({ block: 'center' }));
  await settle(200);
  await page.click('#readerNavPlace');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori-reader-nav-place')), 'right-start', 'nothing picked by the click that opened it');
  await page.click('#rsPicker [data-edge="right"]');
  const cells = await page.$$eval('#rsPicker .rs-pick-cell', cs => cs.map(c => { const r = c.getBoundingClientRect(); return [r.left, r.right]; }));
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  assert.equal(cells.length, 6);
  assert.ok(cells.every(([left, right]) => left >= 0 && right <= width), `inside the window: ${JSON.stringify(cells)} of ${width}`);
});

// The picker once shifted left to stay in a narrow window, off the button it belongs to. Now the button
// makes the room: it stands in from the right by just what the picker lacks, and only then.
test('a place button stands in from the right only as far as its picker needs, and the picker opens centred on it', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await openSettings(page, 'display');
  for (const [width, height, moves] of [[1400, 900, false], [560, 800, false], [540, 800, true], [520, 800, true], [420, 800, true], [360, 700, true], [420, 420, true]]) {
    await page.setViewport({ width, height });
    await page.$eval('#readerNavPlace', b => b.scrollIntoView({ block: 'center' }));
    await settle(100);
    const at = await page.evaluate(() => {
      const btn = document.getElementById('readerNavPlace').getBoundingClientRect();
      return { centre: (btn.left + btn.right) / 2, right: btn.right,
        edge: document.getElementById('readerSettingsModal').getBoundingClientRect().right,
        content: document.getElementById('readerNavPlace').closest('.rs-section').getBoundingClientRect().right,
        all: [...document.querySelectorAll('[data-rs-panel="display"] .rs-pick')].map(b => b.getBoundingClientRect().right) };
    });
    const room = at.edge - at.centre, inset = at.content - at.right, size = `${width}×${height}`;
    assert.equal(inset > 0.01, moves, `${size}: moved in by ${inset}px with ${room}px of room`);
    if (moves) assert.ok(Math.abs(room - 71) < 0.02, `${size}: just the picker's room, ${room}px`);
    else assert.ok(room > 71, `${size}: ${room}px of room`);
    assert.ok(at.all.every(r => r === at.right), `${size}: the place buttons stand in together: ${at.all}`);
    await page.click('#readerNavPlace');
    const picker = await page.evaluate(() => ({ x: document.getElementById('rsPicker').getBoundingClientRect().left,
      cells: [...document.querySelectorAll('#rsPicker .rs-pick-cell')].map(c => { const r = c.getBoundingClientRect(); return [r.left, r.right]; }) }));
    assert.ok(Math.abs(picker.x - at.centre) < 0.02, `${size}: the picker centred on its button: ${picker.x} against ${at.centre}`);
    assert.ok(picker.cells.every(([left, right]) => left >= 0 && right <= at.edge), `${size}: inside the window: ${JSON.stringify(picker.cells)}`);
    await page.keyboard.press('Escape');
  }
});

// Their labels' semibold face was only fetched once they showed, and the box grew by 10px when it
// arrived: on a slow machine, after the first frames.
test('the reader settings open at their size: nothing in them moves once they show', { skip: !chromePath() }, async t => {
  const page = await reader(t, { side: false });
  await (await page.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const seen = await page.evaluate(() => new Promise(resolve => {
    document.getElementById('readerSettingsBtn').click();
    document.querySelector('[data-rs-tab="display"]').click();
    const keys = []; const t0 = performance.now();
    const tick = () => {
      const box = document.getElementById('readerSettingsBox').getBoundingClientRect();
      const key = `${box.top},${box.height}`;
      if (keys.at(-1) !== key) keys.push(key);
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else resolve(keys);
    };
    tick();
  }));
  assert.equal(seen.length, 1, `the box moved after it showed: ${seen.join(' → ')}`);
});

test('the display tab: the navigation bar, the progress bars, and study mode in two columns with a font dropdown', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await openSettings(page, 'display');
  assert.deepEqual(await page.$$eval('[data-rs-panel="display"] .rs-heading', hs => hs.map(h => h.textContent)),
    ['Navigation bar', 'Progress bars', 'Translation', 'Study Mode', 'Debug']);
  assert.equal(await page.$eval('#readerProgressLabel', el => el.textContent), 'Page bar');
  const [original, translation] = await page.$$eval('.rs-cols > .rs-col', cols => cols.map(c => { const r = c.getBoundingClientRect(); return { left: r.left, top: r.top }; }));
  assert.ok(original.top === translation.top && original.left < translation.left, 'the original and the translation side by side');
  assert.deepEqual(await page.$$eval('#readerStudyFont option', os => os.map(o => o.value)), ['yasashisa', 'kiwi']);
});

test('a rail down a side keeps clear of zoom and the thumbnails: they push it up as they come and grow, at once while resized', { skip: !chromePath() }, async t => {
  const page = await reader(t, { place: 'right-center' });
  // The thumbnails at their usual height (earlier tests resize them, and it's saved).
  await page.evaluate(() => localStorage.removeItem('shiori:readerThumbHeight'));
  await page.reload({ waitUntil: 'load' });
  await page.setViewport({ width: 1400, height: 560 });
  await settle();
  const free = await page.$eval('#snRail', r => r.getBoundingClientRect().top);
  await page.keyboard.press('g');   // thumbnails
  // Pushed up as they come out, it settles 10px above zoom (however long a busy machine takes).
  await until(page, () => Math.abs(document.getElementById('sideZoom').getBoundingClientRect().top
    - document.getElementById('snRail').getBoundingClientRect().bottom - 10) <= 1, null, { what: 'the rail pushed to 10px above zoom', timeout: 4000 });
  assert.ok(await page.$eval('#snRail', r => r.getBoundingClientRect().top) < free, 'up from where it stood');
  const grip = await page.$eval('#thumbResizeHandle', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  let worst = 0;
  for (let dy = 12; dy <= 48; dy += 12) {
    await page.mouse.move(grip.x, grip.y - dy);
    worst = Math.max(worst, await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve(Math.abs(document.getElementById('sideZoom').getBoundingClientRect().top - document.getElementById('snRail').getBoundingClientRect().bottom - 10));
    })))));
  }
  assert.ok(worst <= 1, `the rail trailed the thumbnails' edge by ${worst}px`);
  // Taller still, there's no height left for it between the pill and zoom: crowded, zoom steps in
  // beside it, and nothing overlaps.
  await page.mouse.move(grip.x, grip.y - 120, { steps: 4 });
  await page.mouse.up();
  await settle(500);
  const end = await page.evaluate(() => ({
    beside: Math.round(document.getElementById('snRail').getBoundingClientRect().left - document.getElementById('sideZoom').getBoundingClientRect().right),
    above: Math.round(document.getElementById('thumbStrip').getBoundingClientRect().top - document.getElementById('snRail').getBoundingClientRect().bottom),
  }));
  assert.ok(end.beside === 10 && end.above >= 12, JSON.stringify(end));
});

test('fit and zoom hide with the controls, and come back with the navigation or where they stand', { skip: !chromePath() }, async t => {
  // The classic header unpinned: hidden, out with the header, back where they stand; pinned, shown.
  let page = await reader(t, { side: false });
  await page.mouse.move(700, 450);
  await settle();
  assert.equal(await opacity(page, '#sideZoom'), 0, 'hidden with the unpinned header');
  await page.mouse.move(700, 4);   // the header comes out
  await settle();
  assert.equal(await opacity(page, '#sideZoom'), 1, 'out with the header');
  await page.mouse.move(700, 450);
  await settle();
  const zoom = await page.$eval('#sideZoom', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(zoom.x, zoom.y);
  await settle();
  assert.equal(await opacity(page, '#sideZoom'), 1, 'where they stand');
  await page.mouse.move(700, 450);
  await page.keyboard.press('n');   // pinned
  await settle();
  assert.equal(await opacity(page, '#sideZoom'), 1, 'pinned, always there');
  // The modern navigation hidden: the pointer on the rail brings them too.
  page = await reader(t, { sidePinned: false });
  await page.mouse.move(700, 450);
  await settle();
  assert.equal(await opacity(page, '#sideZoom'), 0);
  const rail = await page.$eval('#snRail', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(rail.x, rail.y, { steps: 3 });
  await settle();
  assert.deepEqual([await opacity(page, '#sideNav'), await opacity(page, '#sideZoom')], [1, 1], 'the rail and zoom with it');
});

test('hidden from the start, fit and zoom never show before the reader has set itself up', { skip: !chromePath() }, async t => {
  for (const side of [true, false]) {
    // The reader's own script held back: what the page shows before it runs.
    const page = await browser.newPage();
    t.after(() => page.close());
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on('request', req => (req.url().includes('/app/js/') ? req.abort() : req.continue()));
    await page.evaluateOnNewDocument(side => {
      localStorage.setItem('shiori-reader-nav', side ? 'side' : 'top');
      localStorage.setItem(side ? 'shiori-reader-side-pin' : 'shiori-reader-pin', '0');
    }, side);
    await page.goto(`${origin}/reader?g=${SINGLE}&page=1`, { waitUntil: 'load' });
    assert.equal(await page.$eval('#sideZoom', el => getComputedStyle(el).opacity), '0', side ? 'modern, hidden' : 'classic, unpinned');
  }
});

test('a key pressed after a click rings nothing, and lets hidden controls hide; focus moved by Tab stays', { skip: !chromePath() }, async t => {
  const page = await reader(t, { sidePinned: false });
  const ringed = () => page.evaluate(() => document.querySelector(':focus-visible')?.id ?? null);
  const rail = await page.$eval('#snThumbs', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(rail.x - 10, rail.y, { steps: 3 });   // the hidden rail comes back under the pointer
  await settle();
  await page.mouse.click(rail.x, rail.y);   // thumbnails, by the mouse
  await page.mouse.move(700, 300);
  await page.keyboard.press('g');   // and away again, by a key
  await settle();
  assert.equal(await ringed(), null, 'no focus ring on the button the mouse pressed');
  assert.equal(await opacity(page, '#sideNav'), 0, 'its focus no longer holds the hidden controls up');
  // The settings opened by the mouse: their close button has the focus, but a key rings nothing.
  await page.evaluate(() => document.getElementById('snSettings').click());
  await page.waitForSelector('#readerSettingsModal.show');
  await page.mouse.click(700, 120);   // inside the box, on nothing
  await page.keyboard.press('2');
  assert.equal(await ringed(), null);
  await page.keyboard.press('Escape');
  assert.equal(await ringed(), null, 'closed, the focus goes nowhere');
  // From the keyboard, the focus stays where Tab put it.
  await page.keyboard.press('Tab');
  const tabbed = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  await page.keyboard.press('g');
  assert.equal(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName), tabbed);
});

test('on a touch screen the rail, the chapter pill and fit and zoom take the standard 44px, at the phone\'s own width', { skip: !chromePath() }, async t => {
  // A rail button, the pill's height, the fit button, a zoom button.
  const size = (page) => page.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect();
    return [r('snMode').width, r('snMode').height, r('snChapter').height, r('snFit').width, r('snFit').height, r('snZoomIn').width].map(Math.round);
  });
  const page = await reader(t);
  assert.deepEqual(await size(page), [34, 34, 34, 34, 34, 34], 'compact for a mouse');
  await page.setViewport({ width: 400, height: 860, hasTouch: true, isMobile: true });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('body.reader-side-nav');
  assert.equal(await page.evaluate(() => innerWidth), 400, 'laid out at the phone\'s width, not zoomed out from a desktop one');
  assert.deepEqual(await size(page), [44, 44, 44, 44, 44, 44]);
});

test('on a touch screen neither navigation shows the keyboard shortcuts button; with a mouse both do', { skip: !chromePath() }, async t => {
  const shown = (page) => page.evaluate(() => ['snKeys', 'keybindBtn'].map(id => getComputedStyle(document.getElementById(id)).display !== 'none'));
  const page = await reader(t);
  assert.deepEqual(await shown(page), [true, true], 'with a mouse');
  await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('body.reader-side-nav');
  assert.deepEqual(await shown(page), [false, false], 'on a touch screen');
  // The rail closes up: settings sits straight above go-to-top, one gap apart.
  const settings = await rect(page, '#snSettings'), top = await rect(page, '#snTop');
  assert.ok(Math.abs(top.top - settings.bottom - 2) < 0.5, `settings, then go-to-top: ${settings.bottom} → ${top.top}`);
});

test('Tab goes to every settings tab, and Enter shows it', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await openSettings(page, 'reading');
  await page.focus('#readerSettingsClose');
  const stops = [];
  for (let k = 0; k < 3; k++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => document.activeElement.dataset.rsTab ?? document.activeElement.id));
  }
  assert.deepEqual(stops, ['reading', 'pages', 'display']);
  await page.keyboard.press('Enter');
  assert.equal(await page.$eval('[aria-selected="true"]', tab => tab.dataset.rsTab), 'display');
});

test('smooth page scrolling: the strip glides to another page, or is there at once when it is off', { skip: !chromePath() }, async t => {
  const page = await reader(t, { gallery: SERIES[0], fit: 'off' });
  await page.mouse.move(700, 450);
  // The page a key goes to, and how far the strip got a frame after the press.
  const step = () => page.evaluate(() => new Promise(resolve => {
    const target = document.querySelector('#stripView .page-wrap[data-page="2"]');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    requestAnimationFrame(() => resolve(Math.round(target.getBoundingClientRect().top)));
  }));
  assert.ok(await step() > 50, 'on: a frame after the press, still on its way');
  await page.evaluate(() => scrollTo(0, 0));
  await settle(300);
  await openSettings(page, 'pages');
  assert.equal(await page.$eval('#readerSmoothScroll', i => i.checked), true, 'on by default');
  await page.click('label[for="readerSmoothScroll"]');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori:readerSmoothScroll')), 'false');
  await page.keyboard.press('Escape');
  assert.ok(Math.abs(await step()) <= 1, 'off: there at once');
});

test('crowded, the rail takes the whole edge and the panels in its corners move a row in, easing there', { skip: !chromePath() }, async t => {
  const r = (page) => page.evaluate(() => Object.fromEntries(['snChapter', 'snRail', 'sideZoom'].map(id => {
    const b = document.getElementById(id).getBoundingClientRect();
    return [id, { left: b.left, top: b.top, right: b.right, bottom: b.bottom }];
  })));
  const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
  for (const [place, width, height, check] of [
    ['top-end', 400, 800, (g) => Math.round(g.snChapter.top - g.snRail.bottom) === 10],     // the pill a row down
    ['bottom-center', 400, 800, (g) => Math.round(g.snRail.top - g.sideZoom.bottom) === 10],   // zoom a row up
    // Held at its start, the rail takes the top: the pill a column in, zoom left in its corner.
    ['right-start', 1200, 380, (g) => Math.round(g.snRail.left - g.snChapter.right) === 10 && Math.round(g.snRail.top) === 12 && Math.round(g.sideZoom.right) === Math.round(g.snRail.right)],
  ]) {
    const page = await reader(t, { gallery: SERIES[0], place, position: 'off' });   // a series: the pill with its arrows
    await settle();
    assert.equal(check(await r(page)), false, `${place}: room enough, each in its corner`);
    await page.setViewport({ width, height });
    assert.ok(await page.evaluate(() => document.getElementById('snChapter').getAnimations().length + document.getElementById('sideZoom').getAnimations().length > 0),
      `${place}: the panels ease to their row`);
    await settle(500);
    const g = await r(page);
    assert.ok(check(g), `${place}: crowded at ${width}×${height}: ${JSON.stringify(g)}`);
    assert.ok(apart(g.snRail, g.snChapter) && apart(g.snRail, g.sideZoom), `${place}: nothing overlaps`);

  }
});

test('the side controls follow the window (a resize, browser zoom) and their own sizes at once; nothing trails behind', { skip: !chromePath() }, async t => {
  // Measured in the very next frame.
  const now = (page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    const ids = ['snChapter', 'snRail', 'sideZoom'];
    const [pill, rail, zoom] = ids.map(id => document.getElementById(id).getBoundingClientRect());
    const w = document.documentElement.clientWidth;
    resolve({ pill: w - pill.right, pillWidth: pill.width, zoom: [w - zoom.right, innerHeight - zoom.bottom],
      across: rail.left + rail.width / 2 - w / 2, down: rail.top + rail.height / 2 - innerHeight / 2,
      moving: ids.flatMap(id => document.getElementById(id).getAnimations().map(a => a.transitionProperty)) });
  })));
  for (const [place, centred] of [['top-center', 'across'], ['right-center', 'down']]) {
    const page = await reader(t, { place, position: 'off' });
    await settle();
    const before = await now(page);
    await page.setViewport({ width: 1200, height: 800 });
    const after = await now(page);
    assert.deepEqual(after.moving, [], `${place}: nothing eases after a resize`);
    assert.deepEqual([after.pill, after.zoom], [before.pill, before.zoom], `${place}: the pill and zoom keep to their corners`);
    assert.ok(Math.abs(after[centred] - before[centred]) <= 1, `${place}: the rail stays centred (${before[centred]} → ${after[centred]})`);
  }
  // The pill grows with its page number, away from the edge it's held by.
  const page = await reader(t, { mode: 'single', position: 'off' });   // a single gallery: the pill shows its page
  await settle();
  const before = await now(page);
  for (let k = 0; k < 9; k++) await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => /^10\b/.test(document.getElementById('snChNum').textContent.trim()));
  const after = await now(page);
  assert.ok(after.pillWidth > before.pillWidth, `the pill grew (${before.pillWidth} → ${after.pillWidth})`);
  assert.equal(after.pill, before.pill, 'its right edge stays put');
  assert.deepEqual(after.moving, [], 'and nothing slides');
});

test('down the right the corners make way one at a time: zoom first, or the pill for a rail held at the top', { skip: !chromePath() }, async t => {
  for (const [place, first] of [['right-center', 'zoom'], ['right-end', 'zoom'], ['right-start', 'pill']]) {
    const page = await reader(t, { gallery: SERIES[0], place, position: 'off' });   // a series: the pill with its arrows
    await page.evaluate(() => localStorage.removeItem('shiori:readerThumbHeight'));   // their usual height
    await page.reload({ waitUntil: 'load' });
    await settle();
    const g = () => page.evaluate(() => {
      const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, height: b.height }; };
      return { rail: r('snRail'), pill: r('snChapter'), zoom: r('sideZoom'), thumbs: r('thumbStrip'), W: document.documentElement.clientWidth, H: innerHeight };
    });
    // How much the thumbnails lift what stands on the bottom.
    const shut = await g();
    await page.keyboard.press('g');
    await settle(500);
    const lift = shut.zoom.bottom - (await g()).zoom.bottom;
    await page.keyboard.press('g');
    await settle(500);
    // A window with room for the rail between the pill and zoom; with the thumbnails out, room for it
    // beside only one of them (22px short of both).
    const below = shut.H - shut.zoom.bottom - 12;   // what zoom stands on, the thumbnails shut
    const H = Math.round(12 + shut.pill.height + 10 + shut.rail.height + 10 + shut.zoom.height + 12 + below + lift - 22);
    await page.setViewport({ width: 1400, height: H });
    await settle(500);
    let now = await g();
    assert.deepEqual([Math.round(now.W - now.pill.right), Math.round(now.W - now.zoom.right)], [12, 12], `${place}: room enough, each in its corner`);
    await page.keyboard.press('g');
    await settle(500);
    now = await g();
    const [moved, stays] = first === 'zoom' ? [now.zoom, now.pill] : [now.pill, now.zoom];
    assert.equal(Math.round(now.rail.left - moved.right), 10, `${place}: ${first} steps in beside the rail`);
    assert.equal(Math.round(now.W - stays.right), 12, `${place}: the other stays in its corner`);
    const [top, bottom] = first === 'zoom' ? [now.pill.bottom + 10, now.thumbs.top - 12] : [12, now.zoom.top - 10];
    assert.ok(now.rail.top >= top - 1 && now.rail.bottom <= bottom + 1, `${place}: the rail between them: ${JSON.stringify(now)}`);
    // Shorter still: no room beside the other either, so it steps in too, easing there as the first did.
    const otherId = first === 'zoom' ? 'snChapter' : 'sideZoom';
    await page.setViewport({ width: 1400, height: H - 30 });
    const easing = await page.evaluate(id => new Promise(resolve => requestAnimationFrame(() =>
      resolve(document.getElementById(id).getAnimations().map(a => a.transitionProperty)))), otherId);
    assert.ok(easing.length > 0, `${place}: ${otherId} eases to its row, not jumps`);
    await settle(500);
    now = await g();
    const other = first === 'zoom' ? now.pill : now.zoom;
    assert.equal(Math.round(now.rail.left - other.right), 10, `${place}: the other steps in too`);
  }
});

test('with no room at all, a rail keeps its start (home) in view, and its end runs off', { skip: !chromePath() }, async t => {
  for (const place of ['right-start', 'right-center', 'right-end', 'left-center', 'left-end', 'top-end', 'bottom-center']) {
    const page = await reader(t, { place, position: 'off' });
    const across = /^(top|bottom)/.test(place);
    await page.setViewport(across ? { width: 220, height: 800 } : { width: 1400, height: 220 });
    await settle(500);
    const home = await rect(page, '#snHome');
    assert.equal(Math.round(across ? home.left : home.top), 12, `${place}: home 12px from the ${across ? 'left' : 'top'}`);
  }
});

test('in single and double page a page shorter than the window stands in its middle', { skip: !chromePath() }, async t => {
  for (const [mode, side] of [['single', true], ['double', true], ['single', false]]) {
    const page = await reader(t, { mode, side, fit: 'off' });
    if (!side) {   // the classic header pinned: the room below it
      await page.keyboard.press('n');
      await settle();
    }
    for (let k = 0; k < 7; k++) await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true })));   // well under the window's height
    await settle(300);
    const { above, below } = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('#mainImg, .dImg:not(.page-blank)')].filter(i => i.offsetParent).map(i => i.getBoundingClientRect());
      const header = document.body.classList.contains('reader-unpinned') ? 0 : document.getElementById('topbar').getBoundingClientRect().bottom;
      return { above: Math.min(...imgs.map(b => b.top)) - header, below: innerHeight - 3 - Math.max(...imgs.map(b => b.bottom)) };
    });
    assert.ok(above > 20 && Math.abs(above - below) <= 4, `${mode}${side ? '' : ', pinned header'}: ${above}px above, ${below}px below`);
  }
});

test("each panel is fixed to the window on its own, held by its nearest edge, so a phone's toolbar carries it along", { skip: !chromePath() }, async t => {
  // The window made shorter (as a phone's toolbar does): each keeps its distance to the edge it's held by.
  for (const [place, railEdge] of [['bottom-center', 'bottom'], ['right-end', 'bottom'], ['top-start', 'top']]) {
    const page = await reader(t, { place, position: 'off' });
    await settle();
    const gaps = () => page.evaluate(() => Object.fromEntries(['snChapter', 'snRail', 'sideZoom'].map(id => {
      const b = document.getElementById(id).getBoundingClientRect();
      return [id, { position: getComputedStyle(document.getElementById(id)).position, top: Math.round(b.top), bottom: Math.round(innerHeight - b.bottom) }];
    })));
    const tall = await gaps();
    await page.setViewport({ width: 1400, height: 700 });
    await settle(500);
    const short = await gaps();
    for (const [id, edge] of [['snChapter', 'top'], ['snRail', railEdge], ['sideZoom', 'bottom']]) {
      assert.equal(short[id].position, 'fixed', `${place}: ${id} fixed on its own`);
      assert.equal(short[id][edge], tall[id][edge], `${place}: ${id} held by the ${edge}`);
    }
  }
  const page = await reader(t, { mode: 'single', autoBar: 'bottom' });
  await page.keyboard.press('k');
  await settle(200);
  const fromBottom = () => page.$eval('.auto-bar', b => Math.round(innerHeight - b.getBoundingClientRect().bottom));
  const tall = await fromBottom();
  await page.setViewport({ width: 1400, height: 700 });
  await settle(200);
  assert.equal(await fromBottom(), tall, 'the auto-scroll bar too, by the bottom');
  await page.keyboard.press('k');
});

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

async function reader(t, { gallery = SINGLE, at = 1, mode = 'strip', fit = 'height', side = true, sidePinned = true, position = 'bottom' } = {}) {
  const page = await openPage(browser, origin);
  t.after(async () => { await page.close(); assert.deepEqual(page.problems, []); });
  await page.setViewport({ width: 1400, height: 900 });
  await page.evaluateOnNewDocument((o) => {
    if (sessionStorage.getItem('fixture-set')) return;   // a reload keeps what the test changed
    sessionStorage.setItem('fixture-set', '1');
    localStorage.setItem('shiori-reader-nav', o.side ? 'side' : 'top');
    localStorage.setItem('shiori-reader-side-pin', o.sidePinned ? '1' : '0');
    localStorage.setItem('shiori-reader-pin', '0');
    localStorage.setItem('shiori:readerMode', JSON.stringify(o.mode));
    localStorage.setItem('shiori:readerFitMode', JSON.stringify(o.fit));
    localStorage.setItem('shiori:readerPageZoom', '1');
    localStorage.setItem('shiori:readerThumbsOpen', 'false');
    localStorage.setItem('shiori:readerProgressPosition', JSON.stringify(o.position));
    localStorage.setItem('shiori:readerView', '"off"');
    localStorage.setItem('shiori:readerAutoScrollSpeed', '150');
    localStorage.setItem('shiori:readerDim', '0');
  }, { side, sidePinned, mode, fit, position });
  await page.goto(`${origin}/reader?g=${gallery}&page=${at}`, { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.querySelectorAll('#stripView img[src], #mainImg, .dImg')].some(img => img.naturalWidth > 0));
  return page;
}

const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));
const opacity = (page, sel) => page.$eval(sel, el => Number(getComputedStyle(el).opacity));
const isOn = (page, sel) => page.$eval(sel, el => el.classList.contains('is-on'));
const counter = page => page.$eval('#pageCounter', el => Number(el.textContent.split('/')[0].trim()));
async function openSettings(page) {
  await page.evaluate(() => (document.body.classList.contains('reader-side-nav') ? document.getElementById('snSettings') : document.getElementById('readerSettingsBtn')).click());
  await page.waitForSelector('#readerSettingsModal.show');
}
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
  await openSettings(page);
  await page.click('[data-reader-nav="side"]');
  assert.deepEqual(await shown(), { side: true, top: false, rail: true });
  assert.equal(await page.$eval('[data-reader-nav="side"]', b => b.classList.contains('active')), true);
  await page.reload({ waitUntil: 'load' });
  assert.deepEqual(await shown(), { side: true, top: false, rail: true }, 'a reload opens with the side controls');
  await openSettings(page);
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

test('X, a double-click and the pin hide the side controls, and the right edge brings them back', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await page.mouse.move(700, 450);
  assert.equal(await opacity(page, '#sideNav'), 1);
  await page.keyboard.press('x');
  await settle();
  assert.deepEqual([await opacity(page, '#sideNav'), await opacity(page, '#sideZoom')], [0, 0], 'X hides them');
  await page.mouse.move(1395, 300);   // the right edge
  await settle();
  assert.deepEqual([await opacity(page, '#sideNav'), await opacity(page, '#sideZoom')], [1, 0], 'the right edge brings back the column');
  await page.mouse.move(1300, 880);   // the bottom right corner
  await settle();
  assert.deepEqual([await opacity(page, '#sideNav'), await opacity(page, '#sideZoom')], [0, 1], 'the bottom right corner brings back zoom');
  await page.mouse.move(700, 450);
  await page.mouse.click(700, 450, { count: 2 });
  await settle();
  assert.equal(await opacity(page, '#sideNav'), 1, 'a double-click on the pages brings them back for good');
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori-reader-side-pin')), '1');
  await page.click('#snPin');
  await page.mouse.move(700, 450);
  await settle();
  assert.equal(await opacity(page, '#sideNav'), 0, 'the pin hides them');
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
  const shown = await pagesShown(page);
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
  assert.ok(Math.abs(bar.bottom - Math.min(shown.bottom, await page.$eval('#scrubTrack', b => b.getBoundingClientRect().top))) <= 1, "along the page's bottom edge");
  assert.ok(Math.abs(bar.left - shown.left) <= 1 && Math.abs(bar.right - shown.right) <= 1, 'as wide as the page');
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
  const page = await reader(t);
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

test('auto-play waits while a dialog is open, and goes on once it closes', { skip: !chromePath() }, async t => {
  const page = await reader(t, { gallery: SERIES[0], fit: 'off' });
  await page.keyboard.press('k');
  await settle(300);
  await openSettings(page);
  const y = await page.evaluate(() => scrollY);
  await settle(500);
  assert.equal(await page.evaluate(() => scrollY), y, 'it waits behind the settings');
  assert.equal(await isOn(page, '#snAuto'), true, 'still playing');
  await page.keyboard.press('Escape');
  await settle(400);
  assert.ok(await page.evaluate(() => scrollY) > y, 'it goes on once they close');
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
      const nav = document.getElementById('sideNav').getBoundingClientRect();
      const zoom = document.getElementById('sideZoom').getBoundingClientRect();
      const top = document.getElementById('scrollTopBtn').getBoundingClientRect();
      return { top: nav.top, right: edge - nav.right, zoomRight: edge - zoom.right, zoomBottom: innerHeight - zoom.bottom,
        topBtn: { right: edge - top.right, size: [top.width, top.height], aboveZoom: zoom.top - top.bottom } };
    });
    assert.deepEqual(gaps, { top: 12, right: 12, zoomRight: 12, zoomBottom: 12, topBtn: { right: 12, size: [34, 34], aboveZoom: 10 } },
      `with custom scrollbars ${custom}`);
  }
});

test('resizing the thumbnails, zoom and the go-to-top button keep up with their top edge', { skip: !chromePath() }, async t => {
  const page = await reader(t);
  await page.click('#snThumbs');
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
  for (const position of ['right', 'top']) {
    const page = await reader(t, { position });
    const gap = await page.evaluate((position) => {
      const nav = document.getElementById('sideNav').getBoundingClientRect();
      const bar = document.getElementById('bottombar').getBoundingClientRect();
      return position === 'right' ? bar.left - nav.right : nav.top - bar.bottom;
    }, position);
    assert.ok(gap >= 0, `the side controls overlap a ${position} bar by ${-gap}px`);
  }
  const page = await reader(t);
  await page.click('#snThumbs');
  await settle(400);
  const gap = await page.evaluate(() => document.getElementById('thumbStrip').getBoundingClientRect().top - document.getElementById('sideZoom').getBoundingClientRect().bottom);
  assert.ok(gap >= 0, `zoom overlaps the open thumbnails by ${-gap}px`);
  assert.equal(await isOn(page, '#snThumbs'), true);
});

// reader-styles.browser.mjs — the reader's stylesheets and the one page's share one document once the
// reader is drawn inside it, and must leave each other alone both ways. Out: no rule of the reader's
// sheets matches anything on the one page's routes, whatever it shows (the browser's own rule-usage
// tracking). In: where the one page's document defaults give a control something else than the
// reader's own page did, the reader's sheets give it what it had there: each control computes as on 1.3's
// reader page, whose controls are the record (records/reader-styles.browser.mjs.controls.json, measured
// on 2026-11-26, three runs the same; each look kept once, every control by the look it had). A
// deliberate change of a control's look edits the record in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until, readerSheets } from './harness.mjs';
import { record } from './records.mjs';

const FILE = basename(fileURLToPath(import.meta.url));

const GALLERY = '1790000000501';
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async (gid) => {
    const api = await import('/app/js/api.js');
    await api.meta.put({ galleryId: gid, title: { english: 'Styles fixture' }, tags: [{ type: 'tag', name: 'a', url: '' }], numPages: 4 });
    const canvas = new OffscreenCanvas(600, 860);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#789';
    ctx.fillRect(0, 0, 600, 860);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    for (let n = 1; n <= 4; n++) await api.pages.put(gid, n, blob);
  }, GALLERY);
  await page.close();
});

after(async () => { await browser?.close(); server?.close(); });

// Two frames, and every transition and animation running at its end (a press eases a button's colours).
const settle = (page) => page.evaluate(async () => {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  for (const a of document.getAnimations()) if (a.effect?.getComputedTiming().endTime !== Infinity) a.finish();
});

test('no rule of the reader\'s sheets is used on any route of the one page, its sheets in the document', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const sheets = readerSheets().map((href) => `/app/${href}`);
  assert.ok(sheets.includes('/app/reader.css'));
  const page = await openPage(browser, origin, { onePage: sheets });
  t.after(() => page.close());
  const cdp = await page.createCDPSession();
  const urls = new Map();
  const loaded = new Set();   // the reader's sheets, each time a document of the one page has them
  cdp.on('CSS.styleSheetAdded', ({ header }) => {
    urls.set(header.styleSheetId, header.sourceURL);
    const url = header.sourceURL && new URL(header.sourceURL).pathname;
    if (sheets.includes(url)) loaded.add(url);
  });
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await cdp.send('CSS.startRuleUsageTracking');
  // The reader's rules used (CSS.takeCoverageDelta lists the rules used since it was last asked).
  const used = new Map();
  const take = async (where) => {
    const { coverage } = await cdp.send('CSS.takeCoverageDelta');
    for (const r of coverage) {
      const url = new URL(urls.get(r.styleSheetId) || 'about:blank').pathname;
      if (!sheets.includes(url) || !r.used) continue;
      const { text } = await cdp.send('CSS.getStyleSheetText', { styleSheetId: r.styleSheetId });
      used.set(`${url}@${r.startOffset}`, `${where}: ${text.slice(r.startOffset, r.endOffset).split('{')[0].trim()}`);
    }
  };
  const visit = async (path, ready, what) => {
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    await until(page, ready, null, { what });
    await settle(page);
    await take(path);
  };
  await visit('/components', () => document.title === 'Shiori — Components' && document.querySelectorAll('[data-specimen]').length > 20, 'the components page');
  // Every specimen drawn: the page scrolled through, a window at a time.
  for (let y = 0, h = await page.evaluate(() => document.documentElement.scrollHeight); y < h; y += 800) {
    await page.evaluate((y) => window.scrollTo(0, y), y);
    await settle(page);
  }
  await take('/components, scrolled');
  await visit('/library', () => !!document.querySelector('#grid .card'), 'the library');
  await visit(`/overview?g=${GALLERY}`, () => document.querySelectorAll('#ovPages .ov-page img').length === 4, 'the overview');
  await visit('/settings', () => document.querySelectorAll('#langSelect option').length > 1 || !!document.querySelector('#langSelect[data-value]'), 'the settings page');
  for (const id of await page.evaluate(() => [...document.querySelectorAll('[id^="nav"][role="tab"], nav [id^="nav"]')].map((el) => el.id))) {
    await page.click(`#${id}`).catch(() => {});
    await settle(page);
    await take(`/settings #${id}`);
  }
  await visit('/tasks', () => !!(document.getElementById('tkEmpty') || document.querySelector('.tk-row')), 'the tasks page');
  assert.deepEqual([...loaded].sort(), [...sheets].sort(), 'the reader\'s sheets were in the document');
  assert.deepEqual([...used.values()], [], 'rules of the reader\'s sheets used on the one page');
  assert.deepEqual(page.problems, []);
});

// In the page: every control of the reader's (its frame, its dialogs and its menu), its computed font,
// colour, ground, frame, rounding and opacity, by its place in the frame (a part put straight in the body,
// the page menu or a dialog, by its class).
function controls() {
  const PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'font-variant-ligatures',
    'color', 'background-color', 'opacity', 'appearance',
    ...['top', 'right', 'bottom', 'left'].flatMap((s) => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
  const out = {};
  const key = (el) => { const parts = []; for (let e = el; e && e !== document.body && !e.classList.contains('reader-frame'); e = e.parentElement) parts.unshift(e.id ? `#${e.id}` : e.parentElement === document.body ? `${e.localName}.${e.classList[0]}` : `${e.localName}:${[...e.parentElement.children].indexOf(e)}`); return parts.join('>'); };
  for (const el of document.body.querySelectorAll('button, input, select, textarea, option')) {
    if (el.closest('.notice-overlay, .notice-toast, .shiori-tip')) continue;
    const s = getComputedStyle(el);
    out[key(el)] = Object.fromEntries(PROPS.map((p) => [p, s.getPropertyValue(p)]));
  }
  return out;
}

test('the one page\'s document defaults reach no control of the reader\'s: each computes as on 1.3\'s reader page', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const look = async (nav) => {
    const page = await openPage(browser, origin);
    t.after(() => page.close());
    await page.evaluateOnNewDocument((nav) => {
      localStorage.setItem('shiori-reader-nav', nav);
      localStorage.setItem('shiori-reader-pin', '1');
      localStorage.setItem('shiori-reader-side-pin', '1');
      localStorage.setItem('shiori:readerMode', JSON.stringify('single'));
    }, nav);
    await page.goto(`${origin}/reader?g=${GALLERY}&page=1`, { waitUntil: 'load' });
    await until(page, () => document.getElementById('mainImg')?.naturalWidth > 0 && getComputedStyle(document.getElementById('loadingScreen')).display === 'none', null, { what: 'a page drawn' });
    await settle(page);
    const seen = { rest: await page.evaluate(controls) };
    // Reader settings, each tab; the page's right-click menu; page properties.
    await page.evaluate((nav) => document.getElementById(nav === 'side' ? 'snSettings' : 'readerSettingsBtn').click(), nav);
    await page.waitForSelector('#readerSettingsModal.show');
    for (const tab of ['reading', 'pages', 'display']) {
      await page.click(`[data-rs-tab="${tab}"]`);
      await settle(page);
      seen[tab] = await page.evaluate(controls);
    }
    await page.keyboard.press('Escape');
    await page.mouse.click(640, 400, { button: 'right' });
    await page.waitForSelector('.page-menu');
    await settle(page);
    seen.menu = await page.evaluate(controls);
    await page.keyboard.press('Escape');
    await page.keyboard.press('i');
    await page.waitForSelector('.pp-dialog[open]');
    await until(page, () => document.querySelectorAll('.pp-dialog button').length > 1, null, { what: 'page properties' });
    await settle(page);
    seen.properties = await page.evaluate(controls);
    assert.deepEqual(page.problems, []);
    return seen;
  };
  const { looks, controls: kept } = record(FILE, 'controls');
  for (const nav of ['top', 'side']) {
    const seen = await look(nav);
    const was = Object.fromEntries(Object.entries(kept[nav]).map(([state, all]) => [state, Object.fromEntries(Object.entries(all).map(([key, n]) => [key, looks[n]]))]));
    assert.ok(Object.keys(was.display).length > 30, 'the controls are found');
    assert.deepEqual(Object.keys(seen), Object.keys(was));
    for (const state of Object.keys(was)) assert.deepEqual(seen[state], was[state], `${nav} navigation, ${state}`);
  }
});

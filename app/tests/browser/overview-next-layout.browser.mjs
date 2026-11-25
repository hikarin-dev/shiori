// overview-next-layout.browser.mjs — the layout checklist (the layout-principles skill) on the overview
// at /overview-next, held against 1.3's page (/overview) where 1.3 sets the bar: a window resized across
// every column count of the page grid and across the page's own widths settles in the next frame with
// nothing easing; at 125% and 150% scale, with the page's scrollbar shown, every part's box is 1.3's
// within a pixel; the scrollbar coming (a series of 2 chapters against one of 60) moves the column as
// 1.3's does and nothing else; with the CPU slowed six times, nothing moves while the pictures land that
// does not on 1.3's page (the column, once, as the scrollbar comes); a title that runs long wraps as
// 1.3's; on a phone's screen nothing scrolls sideways and
// a row's buttons show with no pointer to hover. Edit mode (7b): every box 1.3's at 100%, 125% and 150%,
// 1280 and 760 wide; the title growing with its lines in the frame they are typed, as 1.3's; the
// delete's question and the re-run menu inside the window at 1280, 760, a phone and 125%/150%, the
// question never moving from its first frame with the CPU slowed six times.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { startServer, chromePath, openPage, until } from './harness.mjs';
import { seedRun, nextBase, gid, visit, boxes, boxDiff, sleep, OLD, NEW } from './overview-drive.mjs';
import { standInHelper } from './stand-in-helper.mjs';
import { startTranslator } from './stand-in-translator.mjs';

let server, origin, browser, base, long, sixty, titled;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  // The page's scrollbar shown, as a window has it (the harness's browser hides it).
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, ignoreDefaultArgs: ['--hide-scrollbars'],
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'] });
  base = nextBase(1790009900000);
  long = String(base + 60); sixty = String(base + 70); titled = String(base + 80);
  const page = await openPage(browser, origin);
  await standInHelper(page);
  await seedRun(page, origin, base);
  await page.evaluate(async ({ long, sixty, titled }) => {
    const api = await import('/app/js/api.js');
    const png = async (hue, w = 300, h = 430) => { const c = new OffscreenCanvas(w, h); const x = c.getContext('2d'); x.fillStyle = `hsl(${hue} 60% 50%)`; x.fillRect(0, 0, w, h); return c.convertToBlob({ type: 'image/png' }); };
    await api.meta.put({ galleryId: long, title: { english: 'Forty pages', japanese: '', pretty: '' }, tags: [], numPages: 40 });
    for (let n = 1; n <= 40; n++) await api.pages.put(long, n, await png(n * 9));
    const ids = Array.from({ length: 60 }, (_, i) => String(Number(sixty) + 1000 + i));
    ids[0] = sixty;
    for (const [i, id] of ids.entries()) { await api.meta.put({ galleryId: id, title: { english: `Chapter ${i + 1}`, japanese: '', pretty: '' }, tags: [], numPages: 1 }); await api.pages.put(id, 1, await png(i * 6)); }
    await api.series.write(sixty, ids.map((id, i) => ({ id, title: '', number: i + 1 })), { seriesTitle: { english: 'Sixty chapters', japanese: '', pretty: '' } });
    await api.meta.put({ galleryId: titled, title: { english: 'A title that runs long, and longer still, over more than one line of the page and then over a third one as well, with words that wrap', japanese: '長い題名', pretty: '' },
      tags: [{ type: 'tag', name: 'a tag whose name is long enough to wrap inside its own chip on a narrow page' }], numPages: 1 });
    await api.pages.put(titled, 1, await png(30, 800, 400));
  }, { long, sixty, titled });
  await page.close();
});
after(async () => { await browser?.close(); server?.close(); });

async function open(path, g, view = { width: 1280, height: 900 }) {
  const page = await openPage(browser, origin);
  await page.setViewport(view);
  await visit(page, origin, path, g);
  return page;
}

test('a resize across every column count of the grid and the page\'s widths: settled in the next frame, nothing easing', { skip: !chromePath() }, async () => {
  const page = await open(NEW, long);
  const widths = [1280, 1100, 980, 900, 820, 760, 700, 640, 641, 600, 560, 500, 460, 420, 400, 1280];
  const columns = new Set();
  for (const width of widths) {
    await page.setViewport({ width, height: 900 });
    const next = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
      const moving = document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.target?.closest?.('#ovContent') && !a.effect.target.closest('.ch-progress'));
      const tiles = [...document.querySelectorAll('#ovPages .ov-page')].map((el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width].map((n) => Math.round(n * 100) / 100); });
      resolve({ moving: moving.length, tiles, columns: new Set(tiles.map((t) => t[0])).size });
    })));
    await sleep(400);
    const later = await page.evaluate(() => [...document.querySelectorAll('#ovPages .ov-page')].map((el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width].map((n) => Math.round(n * 100) / 100); }));
    assert.equal(next.moving, 0, `${width}: nothing easing in the frame after the resize`);
    assert.deepEqual(next.tiles, later, `${width}: the tiles where they end up, in the next frame`);
    columns.add(next.columns);
  }
  assert.ok(columns.size >= 4, `the grid's column counts gone through: ${[...columns]}`);
  assert.deepEqual(page.problems, []);
  await page.close();
});

for (const scale of [1.25, 1.5]) {
  test(`at ${scale * 100}% scale with the page's scrollbar: every box 1.3's within a pixel`, { skip: !chromePath() }, async () => {
    for (const [part, g] of [['a series', gid(base, 'S')], ['a gallery', gid(base, 'G')], ['a long title', titled]]) {
      const got = {};
      for (const path of [OLD, NEW]) {
        const page = await open(path, g, { width: 1280, height: 900, deviceScaleFactor: scale });
        got[path] = await page.evaluate(boxes);
        await page.close();
      }
      assert.deepEqual(boxDiff(got[OLD], got[NEW], 1).filter((d) => !/^\.count: /.test(d)), [], part);
    }
  });
}

test('the scrollbar coming (2 chapters, then 60) moves the column as 1.3\'s does, at 100% and 125%', { skip: !chromePath() }, async () => {
  for (const scale of [1, 1.25]) {
    const x = {};
    for (const path of [OLD, NEW]) {
      for (const [n, g] of [[2, gid(base, 'W')], [60, sixty]]) {
        const page = await open(path, g, { width: 1280, height: 900, deviceScaleFactor: scale });
        x[`${path} ${n}`] = await page.evaluate(() => ({ bar: innerWidth - document.documentElement.clientWidth, wrap: document.querySelector('.ov-wrap').getBoundingClientRect().x, header: document.querySelector('#settingsBtn').getBoundingClientRect().x }));
        await page.close();
      }
    }
    for (const n of [2, 60]) assert.deepEqual(x[`${NEW} ${n}`], x[`${OLD} ${n}`], `${scale}: ${n} chapters`);
    assert.ok(x[`${NEW} 60`].bar > 0 && x[`${NEW} 2`].bar === 0, JSON.stringify(x));
  }
});

// What moved while the pictures landed: each move as its shift (x, y, width, height, in hundredths).
async function landing(path, g, sel) {
  const page = await openPage(browser, origin);
  await page.setViewport({ width: 1280, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.evaluateOnNewDocument((sel) => {
    window.__moved = new Set();
    const seen = new Map();
    const frame = () => {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect(), at = [r.x, r.y + scrollY, r.width, r.height].map((n) => Math.round(n * 100));
        const was = seen.get(el);
        if (was && was.some((n, i) => n !== at[i])) window.__moved.add(at.map((n, i) => n - was[i]).join(','));
        seen.set(el, at);
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, sel);
  await page.goto(`${origin}${path}?g=${g}`, { waitUntil: 'load' });
  await until(page, (sel) => { const imgs = [...document.querySelectorAll(sel)].map((el) => el.querySelector('img')).filter((img) => img && img.getBoundingClientRect().top < innerHeight); const missing = imgs.filter((img) => !(img.complete && img.getAttribute('src'))); window.__missing = `${missing.length} of ${imgs.length}: ${missing.slice(0, 3).map((img) => JSON.stringify(img.dataset)).join(' ')}`; return imgs.length > 0 && !missing.length; }, sel, { what: `${path} ${sel}: its pictures`, timeout: 60000 })
    .catch(async (err) => { throw new Error(`${err.message}: ${await page.evaluate(() => window.__missing)}`); });
  await sleep(500);
  const moved = await page.evaluate(() => [...window.__moved].sort());
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.close();
  return moved;
}

test('with the CPU slowed six times, nothing moves while the pictures land but what moves on 1.3\'s page (the column, as the scrollbar comes)', { skip: !chromePath() }, async () => {
  for (const [what, g, sel] of [['the grid', long, '#ovPages .ov-page'], ['the rows', sixty, '.ch-row']]) {
    const old = await landing(OLD, g, sel), now = await landing(NEW, g, sel);
    for (const shift of now) assert.ok(old.includes(shift), `${what}: a move of ${shift} (1.3's: ${old.join(' | ')})`);
  }
});

test('on a phone\'s screen: nothing scrolls sideways, a row\'s buttons show with no pointer to hover, the same boxes as 1.3\'s', { skip: !chromePath() }, async () => {
  const view = { width: 390, height: 844, hasTouch: true, isMobile: true };
  for (const g of [gid(base, 'S'), gid(base, 'G'), titled]) {
    const got = {};
    for (const path of [OLD, NEW]) {
      const page = await open(path, g, view);
      got[path] = await page.evaluate(() => ({
        sideways: document.documentElement.scrollWidth - innerWidth,
        actions: [...document.querySelectorAll('.ch-actions')].map((el) => getComputedStyle(el).opacity),
      }));
      got[`${path} boxes`] = await page.evaluate(boxes);
      await page.close();
    }
    assert.deepEqual(got[NEW], got[OLD]);
    assert.equal(got[NEW].sideways, 0);
    assert.ok(got[NEW].actions.every((o) => o === '1'));
    // (The header is every page's one header, 12px in at the sides at 600px or less: not 1.3's 20.)
    assert.deepEqual(boxDiff(got[`${OLD} boxes`], got[`${NEW} boxes`], 1).filter((d) => !/^\.count: /.test(d)), []);
  }
});

// ── Edit mode, the delete's question and the re-run menu (7b) ──

const editing = async (page) => {
  await page.click('#editToggle');
  await until(page, () => !!document.querySelector('#ovContent.ov-editing'), null, { what: 'edit mode' });
  await page.mouse.move(2, 2);
  await sleep(300);
};

for (const scale of [1, 1.25, 1.5]) {
  test(`edit mode at ${scale * 100}% scale, 1280 and 760 wide: every box 1.3's within a pixel`, { skip: !chromePath() }, async () => {
    for (const width of [1280, 760]) {
      for (const [part, g] of [['a series', gid(base, 'S')], ['a long title and a long tag', titled]]) {
        const got = {};
        for (const path of [OLD, NEW]) {
          const page = await open(path, g, { width, height: 900, deviceScaleFactor: scale });
          await editing(page);
          got[path] = await page.evaluate(boxes);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, `${path} ${width}: no sideways scroll`);
          await page.close();
        }
        assert.deepEqual(boxDiff(got[OLD], got[NEW], 1).filter((d) => !/^\.count: /.test(d)), [], `${part}, ${width}`);
      }
    }
  });
}

test('edit mode: the title grows with its lines as they are typed, in the frame they come, as 1.3\'s; on a phone nothing scrolls sideways', { skip: !chromePath() }, async () => {
  const more = ' and the words go on and on, over the end of the line, to a line of their own and then one more after it';
  const got = {};
  for (const path of [OLD, NEW]) {
    for (const view of [{ width: 1280, height: 900 }, { width: 390, height: 844, isMobile: true, hasTouch: true }]) {
      const page = await open(path, titled, view);
      // (The title as it was made: a page closed with its box focused may have saved what was typed.)
      await page.evaluate(async (id) => { const api = await import('/app/js/api.js'); const m = await api.meta.get(id); await api.meta.put({ ...m, title: { ...m.title, english: 'A title that runs long, and longer still, over more than one line of the page and then over a third one as well, with words that wrap' } }); }, titled);
      await visit(page, origin, path, titled);
      await editing(page);
      const before = await page.$eval('.series-title-input', (el) => el.getBoundingClientRect().height);
      await page.click('.series-title-input');
      await page.keyboard.press('End');
      await page.keyboard.type(more, { delay: 0 });
      // In the frame after the last letter: the box as tall as its lines, nothing easing, and no sideways scroll.
      const next = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
        const el = document.querySelector('.series-title-input');
        resolve({ height: Math.round(el.getBoundingClientRect().height * 100) / 100, fits: el.scrollHeight <= el.clientHeight + 2,
          moving: document.getAnimations().filter((a) => a.playState === 'running').length, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth });
      })));
      assert.ok(next.height > before, `${path} ${view.width}: grown (${before} → ${next.height})`);
      assert.deepEqual([next.fits, next.moving, next.sideways], [true, 0, 0], `${path} ${view.width}`);
      got[`${path} ${view.width}`] = [before, next.height];
      await page.close();
    }
  }
  for (const width of [1280, 390]) {
    const [a, b] = [got[`${OLD} ${width}`], got[`${NEW} ${width}`]];
    assert.ok(Math.abs(a[0] - b[0]) <= 4 && Math.abs(a[1] - b[1]) <= 4, `${width}: 1.3's heights (${a}) and the new (${b}), within 1.3's 4px of an inline box`);
  }
});

test('the delete\'s question and the re-run menu stay inside the window (1280, 760, a phone; 125% and 150%); the question still from its first frame with the CPU slowed six times', { skip: !chromePath() }, async () => {
  const row = `.ch-row[data-chapter-id="${gid(base, 'S3')}"]`;
  // The translation server's stand-in answering (the translate buttons show).
  const tr = await startTranslator();
  const open = async (path, g, view) => {
    const page = await openPage(browser, origin, { allow: [tr.origin] });
    await page.setViewport(view);
    await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
    await page.evaluate((url) => localStorage.setItem('shiori:translateSettings', JSON.stringify({ serverUrl: url })), tr.origin);
    await visit(page, origin, path, g);
    await until(page, (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none', `${row} [data-translate]`, { what: 'the translation server' });
    return page;
  };
  try {
  for (const [view, scale] of [[{ width: 1280, height: 900 }, 1], [{ width: 760, height: 700 }, 1], [{ width: 1280, height: 900 }, 1.25], [{ width: 1280, height: 900 }, 1.5], [{ width: 390, height: 844, isMobile: true, hasTouch: true }, 1]]) {
    const page = await open(NEW, gid(base, 'S'), { ...view, deviceScaleFactor: scale });
    const inside = (sel) => page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); const e = document.documentElement; return r.left >= 0 && r.top >= 0 && r.right <= e.clientWidth && r.bottom <= innerHeight && e.scrollWidth <= e.clientWidth; }, sel);
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    // Every frame of the question's box from the press on.
    await page.evaluate(() => {
      window.__boxes = [];
      const tick = () => { const d = document.querySelector('[data-notice="dialog"]'); if (d) { const r = d.getBoundingClientRect(); window.__boxes.push(`${r.top},${r.height},${r.left},${r.width}`); } if (window.__boxes.length < 40) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await page.$eval(`${row} [data-remove]`, (b) => b.scrollIntoView({ block: 'center' }));
    if (!view.isMobile) await page.hover(`${row} .ch-main`);
    await page.click(`${row} [data-remove]`);
    await page.waitForFunction(() => window.__boxes.length >= 40, { timeout: 20000 });
    assert.equal(new Set(await page.evaluate(() => window.__boxes)).size, 1, `${view.width}@${scale}: the question never moves or changes size`);
    assert.ok(await inside('[data-notice="dialog"]'), `${view.width}@${scale}: the question inside the window`);
    await page.keyboard.press('Escape');
    await until(page, () => !document.querySelector('[data-notice="dialog"]'), null, { what: 'the question gone' });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    if (!view.isMobile) await page.hover(`${row} .ch-main`);
    await page.click(`${row} [data-translate]`, { button: 'right' });
    await until(page, () => !!document.querySelector('[data-slot="menu"]'), null, { what: 'the menu' });
    await sleep(400);
    assert.ok(await inside('[data-slot="menu"]'), `${view.width}@${scale}: the menu inside the window`);
    await page.keyboard.press('Escape');
    assert.deepEqual(page.problems, []);
    await page.close();
  }
  } finally {
    const last = await openPage(browser, origin);
    await last.goto(`${origin}/tasks`, { waitUntil: 'load' });
    await last.evaluate(() => localStorage.removeItem('shiori:translateSettings'));
    await last.close();
    await tr.close();
  }
});

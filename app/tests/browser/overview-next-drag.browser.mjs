// overview-next-drag.browser.mjs — a chapter row dragged by its grip at /overview-next, held to 1.3's page
// (/overview) driven alike, 1.3's page the oracle: nothing until the pointer has moved 3px; a row down a
// place, up to the first (ownership moving with it), over several rows to the end, released in its own
// place, Escape and a pointer lost (every row back, nothing saved), a volume among the volumes, with a
// row's pages open, with a job running on a row, in edit mode, a finger on the grip, a long list scrolled
// past the window's edge, the order changed in another context while the drag runs, and a save the
// library refuses. For each: what is said to whatever runs things, what the rows show mid-way (which is
// lifted, whether the list sorts, the order they show in from the top, the DOM's order, the rows'
// buttons gone, the grip's tip put away), what they show once settled (nothing of the drag left), the
// order the page shows, and what the library holds after. Any difference from 1.3's fails.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { openRun, nextBase, gid, visit, read, named, named as named0, sleep, publish, record, outcome, rowSel, OLD, NEW, PARTS } from './overview-drive.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

// In the page: the rows as they show now. `lifted`: the row being dragged; `sorting`: the list making
// room; `seen`: the rows in the order they show from the top; `dom`: the order of the list's nodes;
// `buttons`: a row's buttons showing; `tips`: the rows whose grip has its tip; `left`: anything of a
// drag left on a row or the page (a row placed off its place, the page's drag cursor).
function rowsNow() {
  const rows = [...document.querySelectorAll('.ch-row')];
  const id = (r) => r.dataset.chapterId;
  const list = document.querySelector('.ch-list');
  return {
    lifted: rows.filter((r) => r.classList.contains('dragging') || r.hasAttribute('data-dragging')).map(id),
    sorting: !!list && (list.classList.contains('sorting') || list.hasAttribute('data-sorting')),
    seen: rows.map((r) => [id(r), r.getBoundingClientRect().top]).sort((a, b) => a[1] - b[1]).map((x) => x[0]),
    dom: rows.map(id),
    buttons: rows.filter((r) => getComputedStyle(r.querySelector('.ch-actions')).opacity !== '0').map(id),
    tips: rows.filter((r) => r.querySelector('.ch-grip')?.hasAttribute('data-tip')).map(id),
    left: [...rows.filter((r) => r.style.transform || r.style.top).map((r) => `placed ${id(r)}`), ...(document.body.classList.contains('ch-dragging') ? ['body'] : [])],
  };
}

// The grip of a part's row: its middle.
const gripAt = (page, base, part) => page.$eval(part === 'last' ? '.ch-row:last-child .ch-grip' : `${rowSel(base, part)} .ch-grip`, (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
const rowAt = (page, base, part) => page.$eval(rowSel(base, part), (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, y: b.top + b.height / 2 }; });

// A press on a part's grip (its row hovered first: the grip shows under the pointer).
async function press(d, part) {
  const at = await gripAt(d.page, d.base, part);
  await d.page.mouse.move(at.x + 40, at.y);
  await sleep(60);
  await d.page.mouse.move(at.x, at.y);
  await sleep(60);
  await d.page.mouse.down();
  return at;
}
// The pointer to `y` (from where it is) in steps, then the rows' look once their slide has run.
async function moveTo(d, x, y, steps = 12) {
  await d.page.mouse.move(x, y, { steps });
  await sleep(350);
}
const look = async (d, what) => { d.seen.push({ [what]: await d.page.evaluate(rowsNow) }); };

// Each case: its name, how its page opens, what is done.
const CASES = [
  ['a press and 2px: no drag; let go, nothing', {}, async (d) => {
    const at = await press(d, 'S2');
    await moveTo(d, at.x, at.y + 2, 2);
    await look(d, 'under 3px');
    await d.page.mouse.up(); await sleep(500);
  }],
  ['a row down a place', {}, async (d) => {
    const at = await press(d, 'S2');
    const s3 = await rowAt(d.page, d.base, 'S3');
    await moveTo(d, at.x, s3.y + 4);
    await look(d, 'mid-way');
    await d.page.mouse.up(); await sleep(1200);
  }],
  ['a row up to the first: ownership moves with it', {}, async (d) => {
    const at = await press(d, 'S3');
    const first = await rowAt(d.page, d.base, 'S');
    await moveTo(d, at.x, first.top + 4);
    await look(d, 'mid-way');
    await d.page.mouse.up(); await sleep(1500);
  }],
  ['the first over several rows to the end', {}, async (d) => {
    const at = await press(d, 'S');
    const last = await rowAt(d.page, d.base, 'X');
    await moveTo(d, at.x, last.bottom + 200, 20);
    await look(d, 'mid-way, past the end');
    await d.page.mouse.up(); await sleep(1500);
  }],
  ['let go in its own place: nothing saved', {}, async (d) => {
    const at = await press(d, 'S2');
    await moveTo(d, at.x, at.y + 70);
    await look(d, 'away');
    await moveTo(d, at.x, at.y + 1);
    await look(d, 'back');
    await d.page.mouse.up(); await sleep(800);
  }],
  ['Escape: every row back, nothing saved', {}, async (d) => {
    const at = await press(d, 'S');
    await moveTo(d, at.x, at.y + 120);
    await look(d, 'mid-way');
    await d.page.keyboard.press('Escape'); await sleep(400);
    await look(d, 'after Escape, still pressed');
    await moveTo(d, at.x, at.y + 160);
    await d.page.mouse.up(); await sleep(800);
  }],
  ['the pointer lost: every row back, nothing saved', {}, async (d) => {
    const at = await press(d, 'S2');
    await moveTo(d, at.x, at.y + 90);
    await d.page.evaluate((sel) => { const g = document.querySelector(sel); for (const id of [1, 2, 3]) if (g.hasPointerCapture(id)) g.releasePointerCapture(id); }, `${rowSel(d.base, 'S2')} .ch-grip`);
    await sleep(400);
    await look(d, 'lost');
    await d.page.mouse.up(); await sleep(800);
  }],
  ['a volume up among the volumes', { view: 'volumes' }, async (d) => {
    const at = await press(d, 'V2');
    const v1 = await rowAt(d.page, d.base, 'V1');
    await moveTo(d, at.x, v1.top + 2);
    await look(d, 'mid-way');
    await d.page.mouse.up(); await sleep(1200);
  }],
  ['over a row whose pages are open', {}, async (d) => {
    await d.page.hover(`${rowSel(d.base, 'S2')} .ch-head`); await sleep(80);
    await d.page.click(`${rowSel(d.base, 'S2')} [data-expand]`);
    await until(d.page, (sel) => !!document.querySelector(`${sel} .ch-pages .ov-page`), rowSel(d.base, 'S2'), { what: 'its pages' });
    await sleep(300);
    const at = await press(d, 'S');
    const s3 = await rowAt(d.page, d.base, 'S3');
    await moveTo(d, at.x, s3.y, 16);
    await look(d, 'mid-way');
    await d.page.mouse.up(); await sleep(1200);
    d.seen.push({ open: await d.page.evaluate((sel) => document.querySelector(sel).classList.contains('expanded'), rowSel(d.base, 'S2')) });
  }],
  ['a row with a job running', {}, async (d) => {
    await publish(d.page, { gid: d.id('S2'), kind: 'download', status: 'downloading', downloaded: 100, total: 1000, pages: 2 });
    await until(d.page, (sel) => document.querySelector(sel)?.classList.contains('working'), rowSel(d.base, 'S2'), { what: 'the job drawn' });
    const at = await press(d, 'S2');
    const first = await rowAt(d.page, d.base, 'S');
    await moveTo(d, at.x, first.top + 2);
    await publish(d.page, { gid: d.id('S2'), kind: 'download', status: 'downloading', downloaded: 300, total: 1000, pages: 2 });
    await sleep(300);
    await look(d, 'mid-way');
    await d.page.mouse.up(); await sleep(1200);
    await d.page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); });
  }],
  ['in edit mode', {}, async (d) => {
    await d.page.click('#editToggle'); await sleep(300);
    const at = await press(d, 'S3');
    const s2 = await rowAt(d.page, d.base, 'S2');
    await moveTo(d, at.x, s2.top + 2);
    await look(d, 'mid-way');
    await d.page.mouse.up(); await sleep(1200);
  }],
  // (Under a mouse the grip shows only under the pointer: a finger's press there reaches the row.)
  ['a finger on the grip, under a mouse', {}, async (d) => {
    const at = await gripAt(d.page, d.base, 'S2');
    const s3 = await rowAt(d.page, d.base, 'S3');
    const cdp = await d.page.createCDPSession();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
    for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x, y: at.y + ((s3.y + 4 - at.y) * i) / 10 }] }); await sleep(30); }
    await sleep(300);
    await look(d, 'mid-way');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); await sleep(1200);
  }],
  ['a finger on the grip of a phone: it drags', { phone: true }, async (d) => {
    await d.page.$eval(rowSel(d.base, 'S2'), (el) => el.scrollIntoView({ block: 'center' })); await sleep(300);
    const at = await gripAt(d.page, d.base, 'S2');
    const s3 = await rowAt(d.page, d.base, 'S3');
    const cdp = await d.page.createCDPSession();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
    for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x, y: at.y + ((s3.y + 4 - at.y) * i) / 10 }] }); await sleep(30); }
    await sleep(300);
    await look(d, 'mid-way');
    d.seen.push({ sideways: await d.page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); await sleep(1200);
  }],
  ['a long list: past the window’s bottom edge the page scrolls, to the end', { long: 16 }, async (d) => {
    const at = await press(d, 'S2');
    await moveTo(d, at.x, 880, 20);
    // Held by the edge: the page scrolls until it can go no further.
    await until(d.page, () => scrollY > 0 && Math.abs(scrollY + innerHeight - document.documentElement.scrollHeight) < 2, null, { what: 'scrolled to the end', timeout: 10000 });
    await sleep(200);
    const last = await d.page.evaluate(() => { const rows = document.querySelectorAll('.ch-row:not(.dragging):not([data-dragging])'); const b = rows[rows.length - 1].getBoundingClientRect(); return b.bottom; });
    await moveTo(d, at.x, Math.min(last + 4, 860), 6);
    await look(d, 'at the end');
    d.seen.push({ scrolled: await d.page.evaluate(() => scrollY > 0) });
    await d.page.mouse.up(); await sleep(1500);
  }],
  ['a long list: at the window’s top edge the page scrolls back up', { long: 16, scrolled: true }, async (d) => {
    const at = await press(d, 'last');
    await moveTo(d, at.x, 60, 20);
    await until(d.page, () => scrollY === 0, null, { what: 'scrolled to the top', timeout: 10000 });
    await sleep(200);
    const first = await rowAt(d.page, d.base, 'S');
    await moveTo(d, at.x, first.top + 2, 6);
    await look(d, 'at the top');
    await d.page.mouse.up(); await sleep(1500);
  }],
  ['the order changed in another context while it runs, then dropped elsewhere', {}, async (d) => {
    const at = await press(d, 'S');
    const s2 = await rowAt(d.page, d.base, 'S2');
    await moveTo(d, at.x, s2.bottom - 2);
    // Another context swaps S2 and S3 meanwhile.
    await d.page.evaluate(async ({ S, S2, S3 }) => {
      const api = await import('/app/js/api.js');
      const order = (await api.meta.get(S)).chapters.map((c) => String(c.id));
      const i = order.indexOf(S2), j = order.indexOf(S3);
      [order[i], order[j]] = [order[j], order[i]];
      await api.series.reorder(S, order);
    }, { S: d.id('S'), S2: d.id('S2'), S3: d.id('S3') });
    await sleep(800);
    await look(d, 'mid-way, after the change');
    await d.page.mouse.up(); await sleep(1500);
  }],
  ['the order changed in another context while it runs, let go in its own place', {}, async (d) => {
    const at = await press(d, 'S');
    await moveTo(d, at.x, at.y + 40);
    await d.page.evaluate(async ({ S, S2, S3 }) => {
      const api = await import('/app/js/api.js');
      const order = (await api.meta.get(S)).chapters.map((c) => String(c.id));
      const i = order.indexOf(S2), j = order.indexOf(S3);
      [order[i], order[j]] = [order[j], order[i]];
      await api.series.reorder(S, order);
    }, { S: d.id('S'), S2: d.id('S2'), S3: d.id('S3') });
    await sleep(800);
    await look(d, 'mid-way, after the change');
    await moveTo(d, at.x, at.y);
    await d.page.mouse.up(); await sleep(1500);
  }],
  ['the save refused by the library', {}, async (d) => {
    await d.page.evaluate(async () => { const api = await import('/app/js/api.js'); api.series.reorder = () => Promise.reject(Object.assign(new Error('refused'), { code: 'unavailable', reason: 'not-owned' })); });
    const at = await press(d, 'S2');
    const s3 = await rowAt(d.page, d.base, 'S3');
    await moveTo(d, at.x, s3.y + 4);
    await d.page.mouse.up(); await sleep(1500);
  }],
];

// In the page: `n` chapters more at the series' end (each a gallery of one page, numbered on from 3).
async function lengthen({ S, n, base }) {
  const api = await import('/app/js/api.js');
  const c = new OffscreenCanvas(30, 43); c.getContext('2d').fillRect(0, 0, 30, 43);
  const png = await c.convertToBlob({ type: 'image/png' });
  const owner = await api.meta.get(S);
  const more = [];
  for (let i = 0; i < n; i++) {
    const id = String(base + 60 + i);
    await api.meta.put({ galleryId: id, title: { english: `More ${i + 1}`, japanese: '', pretty: '' }, tags: [], numPages: 1 });
    await api.pages.put(id, 1, png);
    more.push({ id, title: '', number: 4 + i });
  }
  await api.series.write(S, [...owner.chapters, ...more], { seriesTitle: owner.seriesTitle, seriesTags: owner.seriesTags });
}

// One case on one page: what it said, showed and left.
async function run(path, [, opts, steps]) {
  const base = nextBase(1790017000000);
  const context = await browser.createBrowserContext();
  const page = await openRun(context, origin, base, { storage: opts.view ? { 'shiori:seriesView': opts.view } : {} });
  await page.setViewport(opts.phone ? { width: 390, height: 844, hasTouch: true, isMobile: true } : { width: 1280, height: 900 });
  const id = (part) => gid(base, part);
  if (opts.long) await page.evaluate(lengthen, { S: id('S'), n: opts.long, base });
  await visit(page, origin, path, id(opts.part ?? 'S'));
  if (opts.scrolled) { await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await sleep(400); }
  await page.evaluate(record);
  const seen = [];
  await steps({ page, base, seen, id });
  await sleep(300);
  const r = await page.evaluate(read);
  let out = named({ ...(await outcome(page, base)), seen, rest: await page.evaluate(rowsNow),
    shown: r.empty ? { empty: r.empty } : { title: r.hero.title, rows: r.rows.map((x) => `${x.num} ${x.id} ${x.title}`) } }, base);
  // (The long list's chapters named by their place among them.)
  let text = JSON.stringify(out);
  for (let i = 0; i < (opts.long ?? 0); i++) text = text.split(String(base + 60 + i)).join(`<M${i + 1}>`);
  out = JSON.parse(text);
  out.problems = page.problems;
  await context.close();
  return out;
}

for (const c of CASES) {
  test(c[0], async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const was = await run(OLD, c);
    const now = await run(NEW, c);
    if (process.env.DUMP) console.log(JSON.stringify({ seen: was.seen, rest: was.rest, rows: was.shown.rows, said: was.said }));
    assert.deepEqual(now, was);
  });
}

// ── Every frame of a drag ──

// In the page, from now: every frame's dragged row against the pointer, the list's order, which rows are
// moving (an animation or a transition running), and whether every row is a node that was there before.
function recordFrames() {
  window.__f = [];
  window.__p = null;
  window.__up = false;
  document.addEventListener('pointermove', (e) => { window.__p = e.clientY; }, true);
  document.addEventListener('pointerup', () => { window.__up = true; }, true);
  for (const r of document.querySelectorAll('.ch-row')) r.__kept = true;
  const tick = () => {
    const rows = [...document.querySelectorAll('.ch-row')];
    const lifted = rows.find((r) => r.classList.contains('dragging') || r.hasAttribute('data-dragging'));
    window.__f.push({
      up: window.__up, p: window.__p, top: lifted ? lifted.getBoundingClientRect().top : null, lifted: lifted?.dataset.chapterId ?? null,
      dom: rows.map((r) => r.dataset.chapterId).join(','),
      // (A row's own frame and ground easing as it is lifted or set down is no motion of its place.)
      moving: rows.filter((r) => r.getAnimations().some((a) => a.playState === 'running' && !/^(border|background|box-shadow)/.test(a.transitionProperty ?? ''))).map((r) => r.dataset.chapterId),
      // (A missing chapter's row is made again by both pages once the series' head has moved.)
      kept: rows.filter((r) => !r.classList.contains('missing')).every((r) => r.__kept) || rows.filter((r) => !r.__kept).map((r) => r.dataset.chapterId + r.className).join(),
    });
    window.__raf = requestAnimationFrame(tick);
  };
  window.__raf = requestAnimationFrame(tick);
}

test('every frame of a drag: the row on the pointer, the others easing to make room, the drop drawn in its frame, the same nodes', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  for (const path of [OLD, NEW]) {
    const base = nextBase(1790017000000);
    const context = await browser.createBrowserContext();
    const page = await openRun(context, origin, base);
    await page.setViewport({ width: 1280, height: 900 });
    await visit(page, origin, path, gid(base, 'S'));
    const d = { page, base, seen: [], id: (part) => gid(base, part) };
    await page.evaluate(recordFrames);
    const at = await press(d, 'S');
    const last = await rowAt(page, base, 'X');
    // Down past three rows, a frame or so a step, then let go there.
    for (let i = 1; i <= 40; i++) { await page.mouse.move(at.x, at.y + ((last.y - at.y) * i) / 40); await sleep(12); }
    // (Let go 15px short of its place: it travels the rest.)
    await page.mouse.move(at.x, last.y - 15);
    await sleep(400);
    await page.mouse.up();
    await sleep(800);
    const frames = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__f; });
    const named = (s) => named0(s, base);
    const during = frames.filter((f) => !f.up && f.lifted);
    const offset = during[0].top - during[0].p;
    const drop = frames.findIndex((f) => f.up);
    out[path] = {
      // How far the row strays from where the pointer holds it, at most (px).
      trail: Math.max(...during.map((f) => Math.abs(f.top - f.p - offset))) <= 1,
      othersEased: during.some((f) => f.moving.some((id) => id !== during[0].lifted)),
      before: named(frames[drop - 1].dom),
      // The first frame after the release: the order drawn, and what moves: the dropped row alone.
      dropFrame: { dom: named(frames[drop].dom), moving: named(frames[drop].moving) },
      settled: frames.at(-1).moving.length === 0,
      kept: frames.every((f) => f.kept) || frames.find((f) => f.kept !== true).kept,
      problems: page.problems,
    };
    await context.close();
  }
  assert.deepEqual(out[NEW], out[OLD]);
  assert.deepEqual(out[NEW], { trail: true, othersEased: true, before: '<S>,<S2>,<S3>,<X>', dropFrame: { dom: '<S2>,<S3>,<X>,<S>', moving: ['<S>'] }, settled: true, kept: true, problems: [] });
});

// library-drag.browser.mjs — a card dragged onto another to make them a series, on /library,
// held to what 1.3's page gave driven alike (library-drive.mjs): nothing until the pointer has moved
// 6px; the copy's box in every frame against the pointer; the target's mark; each answer of the
// question and what the library holds after; a refusal told; the copy going back when let go over
// nothing; the click after a drag swallowed; a finger, and a drag begun on the title, doing nothing
// (the title's words selectable); a card with a job running; a hovered (grown) card; Escape, a second
// button and the window losing focus during a drag (none of them ends it, in 1.3 as now); and what the
// compositor holds while the copy moves (no card text on a layer of its own). Then the new page alone:
// a drag the page leaves leaves nothing behind.
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the library's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { openRun, result, readDialog, answer, publish, nextBase, card, sleep, PARTS } from './library-drive.mjs';
import { record, normalised } from './records.mjs';

const NEW = '/library';
const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

// In the page: a recorder of the drag, frame by frame (the copy's box against the last pointer
// position, the card marked as the target, the dragged card's state) and of what a click reached.
function recordDrag() {
  const name = (el) => el?.dataset.galleryId ?? null;
  window.__frames = [];
  window.__pointer = null;
  window.__clicks = [];
  document.addEventListener('pointermove', (e) => { window.__pointer = [e.clientX, e.clientY]; }, true);
  document.addEventListener('click', (e) => { window.__clicks.push({ target: e.target.closest?.('.card') ? name(e.target.closest('.card')) : e.target.localName, prevented: e.defaultPrevented }); });
  const frame = () => {
    const copy = document.querySelector('.card-drag-clone');
    const box = copy?.getBoundingClientRect();
    const p = window.__pointer;
    const dragging = document.body.classList.contains('card-dragging');
    // (Let go, the copy flies to its place for 0.2 s: "flying", however many frames it takes.)
    window.__frames.push({
      copy: box && !dragging ? 'flying' : box ? { dx: Math.round((box.left - p[0]) * 10) / 10, dy: Math.round((box.top - p[1]) * 10) / 10, w: Math.round(box.width * 10) / 10, h: Math.round(box.height * 10) / 10 } : null,
      target: name(document.querySelector('#grid > .card.merge-target')),
      source: name(document.querySelector('#grid > .card.drag-source')),
      dragging,
    });
    window.__frame = requestAnimationFrame(frame);
  };
  window.__frame = requestAnimationFrame(frame);
}
// The frames recorded so far, each distinct one once in order, ids named by their parts.
const frames = (page) => page.evaluate(() => { cancelAnimationFrame(window.__frame); const out = []; for (const f of window.__frames ?? []) { const s = JSON.stringify(f); if (s !== out.at(-1)) out.push(s); } return out.map((s) => JSON.parse(s)); });

const coverOf = async (page, base, part) => {
  const box = await (await page.$(`${card(base, part)} .card-thumb-wrap`)).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

// Each case: its name, how its page opens, and what is done there (`d`: the page, its run's base,
// `seen` for what it showed).
const dragTo = async (d, from, to, { steps = 12, release = true } = {}) => {
  const a = await coverOf(d.page, d.base, from);
  const b = typeof to === 'string' ? await coverOf(d.page, d.base, to) : to;
  await d.page.mouse.move(a.x, a.y);
  await sleep(100);
  await d.page.mouse.down();
  await d.page.mouse.move(b.x, b.y, { steps });
  await sleep(150);
  if (release) await d.page.mouse.up();
};
const dialog = async (d) => { const box = await readDialog(d.page); d.seen.push({ dialog: box && { title: box.title, body: box.body, detail: box.detail, tone: box.tone, buttons: box.buttons.map((b) => b.text) } }); };
const CASES = [
  ['nothing until the pointer has moved 6px, then the copy follows it', {}, async (d) => {
    const a = await coverOf(d.page, d.base, 'P');
    await d.page.mouse.move(a.x, a.y); await sleep(100); await d.page.mouse.down();
    for (const dx of [2, 4, 5.9]) { await d.page.mouse.move(a.x + dx, a.y); await sleep(60); }
    d.seen.push({ under6: await d.page.evaluate(() => !!document.querySelector('.card-drag-clone')) });
    await d.page.mouse.move(a.x + 7, a.y); await sleep(100);
    d.seen.push({ past6: await d.page.evaluate(() => !!document.querySelector('.card-drag-clone')) });
    await d.page.mouse.move(a.x + 80, a.y + 60, { steps: 8 }); await sleep(100);
    await d.page.mouse.move(640, 60, { steps: 6 }); await d.page.mouse.up(); await sleep(400);
  }],
  ['let go over a card: asked, OK, a series', {}, async (d) => { await dragTo(d, 'P', 'I'); await dialog(d); await answer(d.page, 'ok'); await sleep(1500); }],
  ['let go over a card: asked, Cancel', {}, async (d) => { await dragTo(d, 'P', 'I'); await dialog(d); await answer(d.page, 'cancel'); await sleep(800); }],
  ['let go over a card: asked, Escape', {}, async (d) => { await dragTo(d, 'N', 'T'); await dialog(d); await answer(d.page, 'escape'); await sleep(800); }],
  ['a merge refused: told so', {}, async (d) => {
    await d.page.evaluate(async () => { const api = await import('/app/js/api.js'); api.series.attach = () => Promise.reject(Object.assign(new Error('refused'), { code: 'unavailable', reason: 'not-owned' })); });
    await dragTo(d, 'P', 'I'); await dialog(d); await answer(d.page, 'ok'); await dialog(d); await answer(d.page, 'ok'); await sleep(500);
  }],
  ['let go over nothing: the copy goes back', {}, async (d) => { await dragTo(d, 'P', { x: 640, y: 60 }); await sleep(500); d.seen.push({ dialog: await readDialog(d.page, 800) }); }],
  ['the click after a drag is swallowed; the next one opens the card', {}, async (d) => {
    const a = await coverOf(d.page, d.base, 'P');
    await dragTo(d, 'P', { x: a.x + 60, y: a.y }, { release: false });
    await d.page.mouse.move(a.x, a.y, { steps: 6 }); await d.page.mouse.up(); await sleep(500);
    d.seen.push({ stayed: await d.page.evaluate((path) => location.pathname === path, d.path), clicks: await d.page.evaluate(() => window.__clicks) });
    await sleep(200);
    await Promise.all([d.page.waitForNavigation({ timeout: 8000 }).catch(() => null), d.page.mouse.click(a.x, a.y)]);
    d.seen.push({ opened: await d.page.evaluate(() => location.pathname) });
  }],
  ['a finger on a cover does nothing', {}, async (d) => {
    const a = await coverOf(d.page, d.base, 'P');
    const cdp = await d.page.createCDPSession();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
    for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + i * 12, y: a.y + i * 4 }] }); await sleep(20); }
    d.seen.push({ copy: await d.page.evaluate(() => !!document.querySelector('.card-drag-clone')) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); await sleep(300);
  }],
  ['a drag begun on the title does nothing; its words are selected', {}, async (d) => {
    const box = await (await d.page.$(`${card(d.base, 'P')} .card-title`)).boundingBox();
    await d.page.mouse.move(box.x + 2, box.y + 5); await d.page.mouse.down();
    await d.page.mouse.move(box.x + box.width - 4, box.y + 6, { steps: 8 }); await sleep(100);
    d.seen.push({ copy: await d.page.evaluate(() => !!document.querySelector('.card-drag-clone')), selected: await d.page.evaluate(() => getSelection().toString()) });
    await d.page.mouse.up(); await sleep(300);
  }],
  ['a card with a job running: its bar in the copy', {}, async (d) => {
    await publish(d.page, { gid: String(d.base + PARTS.I), kind: 'download', status: 'progress', done: 1, total: 4 });
    await until(d.page, (sel) => document.querySelector(sel)?.classList.contains('downloading'), `${card(d.base, 'I')} .card-body`, { what: 'the job' });
    await sleep(400);
    await dragTo(d, 'I', { x: 640, y: 60 }, { release: false });
    d.seen.push({ copy: await d.page.evaluate(() => { const c = document.querySelector('.card-drag-clone'); return c && { shown: c.querySelector('.card-body').classList.contains('downloading'), bar: c.querySelector('.prog-fill').style.width, line: c.querySelector('.card-prog-label').textContent }; }) });
    await d.page.mouse.up(); await sleep(500);
  }],
  ['a hovered (grown) card dragged: the copy as the card at rest', {}, async (d) => {
    const a = await coverOf(d.page, d.base, 'P');
    await d.page.mouse.move(a.x, a.y); await sleep(500);
    const rest = await d.page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().height, card(d.base, 'I'));
    await dragTo(d, 'P', { x: 640, y: 60 }, { release: false });
    d.seen.push({ copy: await d.page.evaluate((rest) => { const c = document.querySelector('.card-drag-clone'); const t = c.querySelector('.card-title'); return { atRest: Math.abs(c.getBoundingClientRect().height - rest) < 0.5, titleAll: t.scrollHeight <= t.clientHeight + 1 }; }, rest) });
    await d.page.mouse.up(); await sleep(500);
  }],
  ['Escape, a second button and the window losing focus during a drag: it goes on, and ends where it is let go', {}, async (d) => {
    await dragTo(d, 'P', 'I', { release: false });
    await d.page.keyboard.press('Escape'); await sleep(100);
    await d.page.mouse.down({ button: 'right' }); await sleep(60); await d.page.mouse.up({ button: 'right' }); await sleep(60);
    await d.page.evaluate(() => { window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange')); }); await sleep(100);
    d.seen.push({ still: await d.page.evaluate(() => !!document.querySelector('.card-drag-clone') && document.body.classList.contains('card-dragging')) });
    await d.page.mouse.up(); await dialog(d); await answer(d.page, 'cancel');
  }],
];

// One case on one page: its record (the frames, what it showed, what the library holds).
async function run(path, [, opts, steps]) {
  const base = nextBase(1790007000000);
  const page = await openRun(browser, origin, path, { base, ...opts });
  await page.evaluate(recordDrag);
  const seen = [];
  await steps({ page, base, seen, path });
  await sleep(300);
  const out = await result(page, base, seen);
  out.frames = (await frames(page)).map((f) => JSON.parse(JSON.stringify(f).split(String(base + PARTS.P)).join('<P>').split(String(base + PARTS.I)).join('<I>').split(String(base + PARTS.N)).join('<N>').split(String(base + PARTS.T)).join('<T>')));
  out.left = await page.evaluate(() => ({ copies: document.querySelectorAll('.card-drag-clone').length, marked: document.querySelectorAll('.merge-target, .drag-source').length, dragging: document.body.classList.contains('card-dragging') }));
  out.problems = page.problems;
  await page.close();
  return out;
}

for (const c of CASES) {
  test(c[0], async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const now = normalised(await run(NEW, c), { site: origin });
    const was = record(FILE, 'cases', c[0]);
    assert.deepEqual(now, was);
  });
}

// What the compositor holds while a card's copy moves, and while the drop overlay shows: the layers that
// draw something, by the element each is for (library-cards.browser.mjs's check). Any card text on a
// layer of its own is drawn thinner; the copy is held to 1.3's.
test('what the compositor holds while the copy moves and while the drop overlay shows, as 1.3', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const base = nextBase(1790007000000);
    const page = await openRun(browser, origin, NEW, { base });
    const cdp = await page.createCDPSession();
    await cdp.send('DOM.getDocument', { depth: -1 });
    let layers = [];
    cdp.on('LayerTree.layerTreeDidChange', (e) => { if (e.layers) layers = e.layers; });
    await cdp.send('LayerTree.enable');
    const during = async (ms) => {
      const seen = new Map();
      for (const end = Date.now() + ms; Date.now() < end; await sleep(8)) for (const l of layers) if (l.drawsContent && l.backendNodeId) seen.set(l.layerId, l.backendNodeId);
      const names = await Promise.all([...seen.values()].map(async (backendNodeId) => {
        const { node } = await cdp.send('DOM.describeNode', { backendNodeId }).catch(() => ({ node: { nodeName: '?', attributes: [] } }));
        const at = node.attributes?.indexOf('class') ?? -1;
        const cls = at >= 0 ? node.attributes[at + 1].split(' ').filter((c) => ['card', 'card-drag-clone', 'card-actions'].includes(c)).join('.') : '';
        // A fixed box drawn over others shares their layer, named for the first of them: on the new
        // page Base UI's hidden fixed inputs (the sort's, the page menu's), the copy drawn with them.
        const id = node.attributes?.[node.attributes.indexOf('id') + 1] ?? '';
        if (node.nodeName === 'INPUT' && /hidden-input$/.test(id)) return 'fixed layer';
        return `${node.nodeName.toLowerCase()}${cls ? '.' + cls : ''}`;
      }));
      return [...new Set(names)].filter((n) => !['#document', 'header'].includes(n)).sort();
    };
    const a = await coverOf(page, base, 'P');
    await page.mouse.move(a.x, a.y); await sleep(300); await page.mouse.down();
    const moving = page.mouse.move(a.x + 300, a.y + 200, { steps: 40 });
    const copy = await during(500);
    await moving; await page.mouse.move(640, 60, { steps: 4 }); await page.mouse.up(); await sleep(400);
    await page.evaluate(() => { const data = new DataTransfer(); data.items.add(new File(['x'], 'A.cbz')); document.getElementById('grid').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data })); });
    const overlay = await during(300);
    await page.evaluate(() => document.getElementById('grid').dispatchEvent(new DragEvent('dragleave', { bubbles: true })));
    // On a layer, as 1.3's own was: the copy (its own, or shared with the fixed layer it is drawn over),
    // the overlay; never a card of the grid.
    const now = { copyOnLayer: copy.some((n) => n === 'div.card.card-drag-clone' || n === 'fixed layer'), overlayOnLayer: overlay.some((n) => n === '::after' || n === 'div'),
      gridCards: [...copy, ...overlay].filter((n) => n === 'div.card' || n === 'div.card-actions'), problems: page.problems };
    await cdp.detach();
    await page.close();
    const was = record(FILE, 'layers');
    assert.deepEqual(now, { copyOnLayer: true, overlayOnLayer: true, gridCards: [], problems: [] });
    assert.deepEqual(now, was);
  }
});

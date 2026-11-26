// overview-add.browser.mjs — the add-a-chapter bar at /overview, held to what 1.3's page
// (/overview) gave driven alike. The search: by a title, by an id, nothing found, typed fast, the box
// emptied, focus coming back with words in the box, a press outside, keys (none do anything: 1.3's list
// had none); a result pressed (a gallery, a series of the library, on a gallery that is no series, in
// the volumes' view, refused). Files dropped on the bar: one archive, two (asked first: OK, Cancel), a
// folder of pictures, a file that is neither, an archive and a file that is neither, one that cannot be
// read, in the volumes' view, on a gallery that is no series, without the helper, and handed to the
// desktop app's runner (its stand-in); the bar lit while files are over it. For each: what the list
// shows (each result's title, id and cover), every dialog, the imports' tracker as it ends, the rows
// the page shows and what the library holds after. Any difference from 1.3's fails, but those named
// here (§5.3's rows).
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the overview's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { readDialog, answer } from './library-drive.mjs';
import { record as kept } from './records.mjs';
import { openRun, nextBase, gid, visit, read, named, sleep, record, NEW } from './overview-drive.mjs';
import { zipCreate } from '../../js/zip.js';

const FILE = path.basename(fileURLToPath(import.meta.url));
let server, origin, browser, dir;
const at = (name) => path.join(dir, name);

// A small PNG of one colour.
function png(r, g, b) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(12, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 12 }, () => Buffer.from([0, ...Array.from({ length: 8 }, () => [r, g, b]).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const cbz = (file, colours) => fs.writeFileSync(file, zipCreate(colours.map((c, i) => ({ name: `${i + 1}.png`, data: png(...c) }))));

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-ov-add-'));
  cbz(at('Next One.cbz'), [[200, 40, 40], [200, 80, 40]]);
  cbz(at('Next Two.cbz'), [[40, 200, 40]]);
  fs.writeFileSync(at('notes.txt'), 'not a picture');
  fs.writeFileSync(at('broken.cbz'), Buffer.alloc(400, 7));
  fs.mkdirSync(at('Loose pages'));
  for (const n of [1, 2]) fs.writeFileSync(at(`Loose pages/${n}.png`), png(30 * n, 90, 90));
});
after(async () => { await browser?.close(); server?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

// In the page: the add bar as it shows (the list open or not, each result's title, id and cover; the box's
// words; the bar lit).
function readAdd() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const list = document.getElementById('addResults');
  const open = !!list && list.classList.contains('open') && getComputedStyle(list).display !== 'none';
  return {
    open,
    rows: open ? [...list.querySelectorAll('.add-res')].map((r) => ({ title: text(r.querySelector('.add-res-title')), id: text(r.querySelector('.add-res-id')), cover: !!r.querySelector('.add-res-thumb img') })) : [],
    empty: open ? text(list.querySelector('.add-empty')) : null,
    value: document.getElementById('addSearch').value,
    lit: document.getElementById('addBar').classList.contains('drag'),
  };
}
// What the library holds of the series or gallery shown: its members' titles (and kinds), and how many
// galleries the library has.
async function holdings(page, owner) {
  return page.evaluate(async (owner) => {
    const api = await import('/app/js/api.js');
    const series = await api.series.resolve(owner);
    const ids = series ? series.chapters.map((c) => String(c.id)) : [owner];
    const title = async (id) => (await api.galleries.get(id))?.title?.english ?? null;
    const members = [];
    for (const [i, id] of ids.entries()) members.push(`${await title(id)}${series?.chapters[i].kind === 'volume' ? ' (volume)' : ''}${series?.chapters[i].title ? ` "${series.chapters[i].title}"` : ''} ${(await api.galleries.get(id))?.count ?? '-'}p`);
    return { series: !!series, members, galleries: (await api.transfer.ids()).length };
  }, owner);
}
// The imports' tracker: each panel's state and words.
const tracker = (page) => page.evaluate(() => [...document.querySelectorAll('#ovImports .ib')].map((p) => [p.classList.contains('listing') ? 'reading' : p.dataset.state,
  ...['.ib-name', '.ib-tally', '.ib-issues'].map((s) => p.querySelector(s)?.textContent ?? '')].join(' | ')));

// Until nothing has changed for 1.5 s (the library, the rows, a dialog, the tracker) and no batch runs.
async function settle(page, owner, timeout = 30000) {
  const end = Date.now() + timeout;
  let last = '', since = Date.now();
  while (Date.now() < end) {
    const now = JSON.stringify([await holdings(page, owner), (await page.evaluate(read)).rows?.map((r) => r.id), await tracker(page), await page.evaluate(() => !!document.querySelector('[data-notice]'))]);
    const running = await page.evaluate(() => !!document.querySelector('#ovImports .ib:is([data-state="running"], [data-state="waiting"])'));
    if (now !== last) { last = now; since = Date.now(); } else if (!running && Date.now() - since > 1500) return;
    await sleep(250);
  }
}

// Words typed into the box (a key at a time), then the list as it settles.
async function type(d, words) {
  await d.page.click('#addSearch');
  await d.page.type('#addSearch', words, { delay: 40 });
  await sleep(600);
  await until(d.page, () => { const l = document.getElementById('addResults'); return !l || [...l.querySelectorAll('.add-res-thumb')].every((t) => t.querySelector('img')); }, null, { what: 'the covers', timeout: 5000 }).catch(() => {});
  await sleep(150);
}
const look = async (d, what) => d.seen.push({ [what]: await d.page.evaluate(readAdd) });
const dialog = async (d, wait) => { const box = await readDialog(d.page, wait); d.seen.push({ dialog: box && { title: box.title, body: box.body, detail: box.detail, tone: box.tone, buttons: box.buttons.map((b) => b.text) } }); return box; };
// Files dropped on the bar, as the system's drag hands them over.
async function drop(d, files) {
  const box = await d.page.$eval('#addBar', (el) => { el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height - 12 }; });
  await sleep(200);
  const cdp = await d.page.createCDPSession();
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data });
  await cdp.detach();
}
const pickRow = (d, title) => d.page.evaluate((title) => {
  const row = [...document.querySelectorAll('#addResults .add-res')].find((r) => r.querySelector('.add-res-title').textContent === title);
  // (1.3's list hangs under the box past the page's end: brought into the window first.)
  row.scrollIntoView({ block: 'nearest' });
  const b = row.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}, title).then(async (p) => { await d.page.mouse.click(p.x, p.y); await sleep(1500); });

// In the page, before it is shown: what a case needs.
const PREP = {
  // A desktop app's runner, standing in: it takes every batch it is handed (and keeps it).
  runner: () => {
    window.__batches = [];
    window.shioriDesktop = { shell: async (action) => action === 'runner' };
    const channel = new BroadcastChannel('shiori-runner');
    channel.onmessage = ({ data }) => {
      if (data?.type !== 'batch') return;
      window.__batches.push({ id: data.batch.id, name: data.batch.name, attachTo: data.batch.attachTo, meta: data.batch.meta, groups: data.batch.groups.map((g) => [g.name, g.files.length]) });
      channel.postMessage({ type: 'taken', id: data.id });
    };
  },
  // The library refusing an addition.
  refuse: async () => { const api = await import('/app/js/api.js'); api.series.attach = () => Promise.reject(Object.assign(new Error('refused'), { code: 'unavailable', reason: 'not-owned' })); },
};

const CASES = [
  // ── The search ──
  ['a search by a title: the first eight, the series\' own left out', {}, async (d) => { await type(d, 'gallery'); await look(d, 'list'); }],
  ['a search by an id', {}, async (d) => { await type(d, d.id('F')); await look(d, 'list'); }],
  ['a search that finds nothing', {}, async (d) => { await type(d, 'nothing like it'); await look(d, 'list'); }],
  ['the box emptied: the list closes', {}, async (d) => {
    await type(d, 'gallery'); await look(d, 'list');
    for (let i = 0; i < 7; i++) await d.page.keyboard.press('Backspace');
    await sleep(500); await look(d, 'emptied');
  }],
  ['a press outside closes it; focus back with words in the box opens it again', {}, async (d) => {
    await type(d, 'F gal'); await look(d, 'list');
    await d.page.click('#ovSection'); await sleep(400); await look(d, 'pressed outside');
    await d.page.click('#addSearch'); await sleep(600); await look(d, 'focused again');
  }],
  ['keys in the box: the arrows, Enter and Escape do nothing to the list', {}, async (d) => {
    await type(d, 'gallery');
    for (const key of ['ArrowDown', 'ArrowDown', 'Enter', 'Escape']) await d.page.keyboard.press(key);
    await sleep(800); await look(d, 'after the keys');
  }],
  ['a result pressed: the next chapter', {}, async (d) => { await type(d, 'F gal'); await pickRow(d, 'F gallery'); await look(d, 'after'); }],
  ['a series of the library pressed: its members brought in', {}, async (d) => { await type(d, 'W gal'); await look(d, 'list'); await pickRow(d, 'W gallery'); await look(d, 'after'); }],
  ['on a gallery that is no series: it becomes one', { part: 'F' }, async (d) => { await type(d, 'E gal'); await pickRow(d, 'E gallery'); await look(d, 'after'); }],
  ['in the volumes\' view: added as its own kind', { view: 'volumes' }, async (d) => { await type(d, 'F gal'); await pickRow(d, 'F gallery'); await look(d, 'after'); }],
  ['the addition refused: told so, nothing added', { prep: 'refuse' }, async (d) => { await type(d, 'F gal'); await pickRow(d, 'F gallery'); await dialog(d); await answer(d.page, 'ok'); await look(d, 'after'); }],
  // ── Files dropped on the bar ──
  // §5.3 F10: the tint 6% → 8%.
  ['files over the bar light it, not text; gone on leaving and on a drop; over the page elsewhere, not', { differs: (was) => {
    for (const step of was.seen) for (const v of Object.values(step)) if (v?.ground === 'rgba(237, 39, 84, 0.06)') v.ground = 'rgba(237, 39, 84, 0.08)';
  } }, async (d) => {
    await d.page.evaluate(async () => {
      const c = new OffscreenCanvas(40, 60); c.getContext('2d').fillRect(0, 0, 40, 60);
      window.__picture = new File([await c.convertToBlob({ type: 'image/png' })], 'Pic.png', { type: 'image/png' });
    });
    const fire = (type, kind, where = '#addBar') => d.page.evaluate((type, kind, where) => {
      const data = new DataTransfer();
      if (kind === 'files') data.items.add(window.__picture); else data.setData('text/plain', 'some words');
      document.querySelector(where).dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    }, type, kind, where);
    const bar = async (what) => { await sleep(250); d.seen.push({ [what]: await d.page.evaluate(() => { const b = document.getElementById('addBar'); const s = getComputedStyle(b); return { lit: b.classList.contains('drag'), frame: s.borderTopColor, ground: s.backgroundColor }; }) }); };
    await fire('dragenter', 'text'); await fire('dragover', 'text'); await bar('text over it');
    await fire('dragleave', 'text');
    await fire('dragenter', 'files', '#ovSection'); await fire('dragover', 'files', '#ovSection'); await bar('files over the page elsewhere');
    await fire('dragleave', 'files', '#ovSection');
    await fire('dragenter', 'files'); await fire('dragover', 'files'); await bar('files over it');
    await fire('dragenter', 'files', '#addHeading'); await fire('dragleave', 'files'); await bar('files over its heading');
    await fire('dragleave', 'files', '#addHeading'); await bar('the drag gone');
    await fire('dragenter', 'files'); await fire('dragover', 'files'); await bar('files again');
    await fire('drop', 'files'); await bar('dropped');
    await settle(d.page, d.id('S'));
  }],
  ['a drop of one archive: the next chapter', {}, async (d) => { await drop(d, [at('Next One.cbz')]); await settle(d.page, d.id('S')); }],
  ['a drop of two archives: asked first, OK', {}, async (d) => { await drop(d, [at('Next One.cbz'), at('Next Two.cbz')]); await dialog(d, 8000); await answer(d.page, 'ok'); await settle(d.page, d.id('S')); }],
  ['a drop of two archives: asked first, Cancel', {}, async (d) => { await drop(d, [at('Next One.cbz'), at('Next Two.cbz')]); await dialog(d, 8000); await answer(d.page, 'cancel'); await settle(d.page, d.id('S')); }],
  ['a drop of a folder of pictures: one chapter', {}, async (d) => { await drop(d, [at('Loose pages')]); await settle(d.page, d.id('S')); }],
  ['a drop of a file that is neither: told so', {}, async (d) => { await drop(d, [at('notes.txt')]); await dialog(d, 8000); await answer(d.page, 'ok'); await settle(d.page, d.id('S')); }],
  ['a drop of an archive and a file that is neither', {}, async (d) => { await drop(d, [at('Next Two.cbz'), at('notes.txt')]); await dialog(d, 8000); await answer(d.page, 'ok'); await settle(d.page, d.id('S')); }],
  ['a drop of an archive that cannot be read: told so', {}, async (d) => { await drop(d, [at('broken.cbz')]); await dialog(d, 8000); await answer(d.page, 'escape'); await settle(d.page, d.id('S')); }],
  ['a drop in the volumes\' view: a volume', { view: 'volumes' }, async (d) => { await drop(d, [at('Next One.cbz')]); await settle(d.page, d.id('S')); }],
  ['a drop on a gallery that is no series: it becomes one', { part: 'F' }, async (d) => { await drop(d, [at('Next One.cbz')]); await settle(d.page, d.id('F')); }],
  ['a drop without the helper', { helper: false }, async (d) => { await drop(d, [at('Next Two.cbz')]); await settle(d.page, d.id('S')); }],
  ['a drop of two handed to the desktop app\'s runner', { prep: 'runner' }, async (d) => {
    await drop(d, [at('Next One.cbz'), at('Next Two.cbz')]); await dialog(d, 8000); await answer(d.page, 'ok'); await sleep(1500);
    d.seen.push({ handed: await d.page.evaluate(() => window.__batches.map(({ id, ...b }) => b)) });
  }],
];

// ── The imports' tracker: a batch begun on the page, as its runner tells of it ──

// In the page: each panel of the tracker, word by word, and its buttons.
function panels() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const shown = (el) => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
  return [...document.querySelectorAll('#ovImports .ib')].map((p) => ({
    state: p.dataset.state, kind: text(p.querySelector('.ib-kind')), runner: shown(p.querySelector('.run-tag')) ? text(p.querySelector('.run-tag')) : null,
    name: text(p.querySelector('.ib-name')), total: text(p.querySelector('.ib-total')),
    lines: ['.ib-tally', '.ib-now', '.ib-issues'].map((s) => text(p.querySelector(s))),
    stop: shown(p.querySelector('.ib-stop')) ? (p.querySelector('.ib-stop').disabled ? 'off' : 'on') : null,
    dismiss: shown(p.querySelector('.ib-dismiss')), titles: shown(p.querySelector('.ib-list-btn')),
  }));
}

test('the imports’ tracker: a batch begun on the page, each of its states, Stop, its end, Dismiss', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  let now;
  {
    const where = NEW;
    const base = nextBase(1790018000000);
    const context = await browser.createBrowserContext();
    const page = await openRun(context, origin, base);
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluateOnNewDocument(PREP.runner);
    await visit(page, origin, where, gid(base, 'S'));
    await page.evaluate(record);
    const d = { page, base, seen: [], id: (part) => gid(base, part) };
    await drop(d, [at('Next One.cbz'), at('Next Two.cbz')]);
    await readDialog(page, 8000);
    await answer(page, 'ok');
    const id = await until(page, () => window.__batches[0]?.id, null, { what: 'the batch handed over' });
    const job = { gid: id, kind: 'import', name: '2 items', total: 2, done: 0, imported: 0, skipped: 0, failed: 0, bytes: 527, bytesDone: 0, runner: { kind: 'app' }, startedAt: Date.now() };
    const tell = (word) => page.evaluate(async (word) => (await import('/app/js/platform.js')).jobs.publish({ ...word, movedAt: Date.now(), at: Date.now() }), word);
    const steps = [];
    const look = async (what) => { await sleep(400); steps.push([what, await page.evaluate(panels)]); };
    await tell({ ...job, status: 'progress', current: { name: 'Next One', done: 0, total: 2, bytes: 300 } });
    await until(page, () => !!document.querySelector('#ovImports .ib'), null, { what: 'the panel' });
    await look('the first title under way');
    await tell({ ...job, status: 'progress', done: 1, imported: 1, bytesDone: 300, current: { name: 'Next Two', done: 0, total: 1, bytes: 227 } });
    await look('the second under way');
    await page.click('#ovImports .ib-stop');
    await look('Stop pressed');
    await tell({ ...job, status: 'cancelled', done: 1, imported: 1, bytesDone: 300, current: null });
    await look('stopped');
    const said = await page.evaluate(() => window.__said.filter((m) => m.type === 'STOP_JOB'));
    await page.click('#ovImports .ib-dismiss');
    await look('dismissed');
    // Another batch, ended with a title failed.
    await tell({ ...job, gid: `${id}-b`, status: 'done', done: 2, imported: 1, failed: 1, bytesDone: 527, current: null });
    await look('another, ended with a title failed');
    now = { steps, said: said.map((m) => ({ ...m, galleryId: m.galleryId === id ? '<batch>' : m.galleryId })), problems: page.problems };
    await page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); });
    await context.close();
  }
  const was = kept(FILE, 'tracker');
  assert.deepEqual(now, was);
  assert.equal(now.said.length, 1, 'Stop said once');
});

// ── Live: a gallery added drawn in the frame of the press, taken off again when refused ──

// In the page, from now: every frame's rows (by chapter) and whether each was there before, from the
// press on a result.
function framesFromPress() {
  window.__f = [];
  for (const r of document.querySelectorAll('.ch-row')) r.__kept = true;
  document.addEventListener('mousedown', (e) => { if (e.target.closest('#addResults')) window.__pressed = true; }, true);
  const tick = () => {
    if (window.__pressed) {
      const rows = [...document.querySelectorAll('.ch-row')];
      window.__f.push({ rows: rows.map((r) => r.dataset.chapterId).join(','), fresh: rows.filter((r) => !r.__kept).map((r) => r.dataset.chapterId).join(','), dialog: !!document.querySelector('[data-notice="dialog"]') });
    }
    window.__raf = requestAnimationFrame(tick);
  };
  window.__raf = requestAnimationFrame(tick);
}

test('live: a gallery added is drawn in the frame of the press, the other rows the same nodes; refused, it is taken off again', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  for (const refuse of [false, true]) {
    const base = nextBase(1790018000000);
    const context = await browser.createBrowserContext();
    const page = await openRun(context, origin, base);
    await page.setViewport({ width: 1280, height: 900 });
    if (refuse) await page.evaluateOnNewDocument(PREP.refuse);
    await visit(page, origin, NEW, gid(base, 'S'));
    const d = { page, base, seen: [], id: (part) => gid(base, part) };
    await type(d, 'F gal');
    await page.evaluate(framesFromPress);
    await pickRow(d, 'F gallery');
    const frames = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__f; });
    // Each distinct frame once, ids named by their parts.
    const seen = [];
    for (const f of named(frames, base)) if (JSON.stringify(f) !== JSON.stringify(seen.at(-1))) seen.push(f);
    out[refuse ? 'refused' : 'added'] = { first: seen[0], seen, problems: page.problems };
    await context.close();
  }
  const rows = '<S>,<S2>,<S3>,<X>';
  assert.deepEqual(out.added.first, { rows: `${rows},<F>`, fresh: '<F>', dialog: false }, 'in the frame of the press');
  assert.deepEqual(out.added.seen.at(-1), { rows: `${rows},<F>`, fresh: '<F>', dialog: false });
  assert.deepEqual(out.refused.first, { rows: `${rows},<F>`, fresh: '<F>', dialog: false }, 'refused: drawn at the press too');
  assert.deepEqual(out.refused.seen.at(-1), { rows, fresh: '', dialog: true }, 'then taken off, and told');
  assert.deepEqual([out.added.problems, out.refused.problems], [[], []]);
});

// One case on one page: what it showed, asked and left.
async function run(where, [, opts, steps]) {
  const base = nextBase(1790018000000);
  const context = await browser.createBrowserContext();
  const page = await openRun(context, origin, base, { helper: opts.helper !== false, storage: opts.view ? { 'shiori:seriesView': opts.view } : {} });
  await page.setViewport({ width: 1280, height: 900 });
  const id = (part) => gid(base, part);
  if (opts.prep) await page.evaluateOnNewDocument(PREP[opts.prep]);
  const owner = id(opts.part ?? 'S');
  await visit(page, origin, where, owner);
  const seen = [];
  await steps({ page, base, seen, id });
  await sleep(300);
  const r = await page.evaluate(read);
  let out = named({ seen, holds: await holdings(page, owner), tracker: await tracker(page),
    shown: r.empty ? { empty: r.empty } : { title: r.hero.title, section: r.section, rows: r.rows.map((x) => `${x.num} ${x.title}${x.state.length ? ` (${x.state.join(' ')})` : ''}`), add: r.add } }, base);
  // (The batches' ids and an import's made-up gallery ids differ run to run.)
  out = JSON.parse(JSON.stringify(out).replace(/import-\d+/g, 'import-…'));
  out.problems = page.problems;
  await context.close();
  return out;
}

for (const c of CASES) {
  test(c[0], async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const now = await run(NEW, c);
    const was = kept(FILE, 'cases', c[0]);
    c[1].differs?.(was);
    assert.deepEqual(now, was);
  });
}

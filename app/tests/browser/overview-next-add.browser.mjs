// overview-next-add.browser.mjs — the add-a-chapter bar at /overview-next, held to 1.3's page (/overview)
// driven alike, 1.3's page the oracle. The search: by a title, by an id, nothing found, typed fast, the box
// emptied, focus coming back with words in the box, a press outside, keys (none do anything: 1.3's list
// had none); a result pressed (a gallery, a series of the library, on a gallery that is no series, in
// the volumes' view, refused). Files dropped on the bar: one archive, two (asked first: OK, Cancel), a
// folder of pictures, a file that is neither, an archive and a file that is neither, one that cannot be
// read, in the volumes' view, on a gallery that is no series, without the helper, and handed to the
// desktop app's runner (its stand-in); the bar lit while files are over it. For each: what the list
// shows (each result's title, id and cover), every dialog, the imports' tracker as it ends, the rows
// the page shows and what the library holds after. Any difference from 1.3's fails, but those named
// here (§5.3's rows).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { readDialog, answer } from './library-drive.mjs';
import { openRun, nextBase, gid, visit, read, named, sleep, OLD, NEW } from './overview-drive.mjs';
import { zipCreate } from '../../js/zip.js';

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
    const now = JSON.stringify([await holdings(page, owner), (await page.evaluate(read)).rows?.map((r) => r.id), await tracker(page), await page.evaluate(() => !!document.querySelector('.notice-overlay, [data-notice]'))]);
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
      window.__batches.push({ name: data.batch.name, attachTo: data.batch.attachTo, meta: data.batch.meta, groups: data.batch.groups.map((g) => [g.name, g.files.length]) });
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
    d.seen.push({ handed: await d.page.evaluate(() => window.__batches) });
  }],
];

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
    const was = await run(OLD, c);
    const now = await run(NEW, c);
    if (process.env.DUMP) console.log(JSON.stringify(was));
    c[1].differs?.(was);
    assert.deepEqual(now, was);
  });
}

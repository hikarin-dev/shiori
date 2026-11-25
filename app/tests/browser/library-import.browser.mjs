// library-import.browser.mjs — import on /library, held to what 1.3's page gave driven alike:
// what Import's picker offers and what a pick of it does (one archive, a PDF, loose pictures, several
// titles with each answer to their question, a title imported already, a file that is neither, a
// backup alone and one under another name among titles, a read that fails), the same by a drop of
// files and of a real folder (and a folder of chapter folders: a series), the overlay while files are
// dragged over the window (for files only, gone on leave, on a drop, on a drag that ends outside), the
// tracker's "reading a drop" panel during a slow listing and gone at its end, and ?import=1. For each:
// every dialog and toast (its words), the tracker's panels as they end, the cards the page shows and
// the header's totals, and what the library holds after. Any difference from 1.3's fails, but those
// named here (§5.3's rows). What 1.3's page gave is the record (records/<this file>.<table>.json,
// records.mjs), 1.3's behaviour as measured on 2026-11-25, which a deliberate change of the library's
// behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { readDialog, answer, sleep } from './library-drive.mjs';
import { record, normalised } from './records.mjs';
import { zipCreate } from '../../js/zip.js';

const NEW = '/library';
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
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const BACKUP = JSON.stringify([{ galleryId: '1790006000001', title: { english: 'From the backup', japanese: '', pretty: '' }, tags: [{ type: 'tag', name: 'kept' }], numPages: 2 }]);

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiori-import-'));
  cbz(at('One.cbz'), [[200, 40, 40], [200, 80, 40]]);
  cbz(at('Two.cbz'), [[40, 200, 40]]);
  cbz(at('Three.cbz'), [[40, 40, 200], [40, 80, 200], [40, 120, 200]]);
  fs.writeFileSync(at('Paper.pdf'), PDF);
  fs.writeFileSync(at('Loose 1.png'), png(120, 120, 20));
  fs.writeFileSync(at('Loose 2.png'), png(120, 20, 120));
  fs.writeFileSync(at('notes.txt'), 'not a picture');
  fs.writeFileSync(at('broken.cbz'), Buffer.alloc(400, 7));
  fs.writeFileSync(at('library.shi'), BACKUP);
  fs.writeFileSync(at('Unconfirmed 51.crdownload'), BACKUP);
  fs.mkdirSync(at('Shelf/part 1'), { recursive: true });
  cbz(at('Shelf/part 1/Alpha.cbz'), [[200, 40, 40]]);
  cbz(at('Shelf/part 1/Beta.cbz'), [[40, 200, 40], [40, 200, 80]]);
  fs.writeFileSync(at('Shelf/notes.txt'), 'not a picture');
  for (const n of [1, 2]) { fs.mkdirSync(at(`Saga/Chapter ${n}`), { recursive: true }); fs.writeFileSync(at(`Saga/Chapter ${n}/1.png`), png(30 * n, 90, 90)); }
});
after(async () => { await browser?.close(); server?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

// A page of `path` over an empty library (its one-time updates run, no jobs, no settings of the library).
async function openEmpty(where, { url = where } = {}) {
  const page = await openPage(browser, origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const api = await import('/app/js/api.js');
    await api.maintenance.clearAll();
    await (await import('/app/js/migrations.js')).runMigrations();
    const platform = await import('/app/js/platform.js');
    for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind);
    for (const k of Object.keys(localStorage)) if (k.startsWith('shiori:lib')) localStorage.removeItem(k);
    sessionStorage.removeItem('shiori-covers');
  });
  await page.goto(`${origin}${url}`, { waitUntil: 'load' });
  await until(page, () => !!document.querySelector('#grid .empty, #grid > .card') && !!document.getElementById('uploadCbzBtn'), null, { what: `${where}: the page` });
  await page.evaluate(watchCards);
  return page;
}

// In the page: what each card that comes shows of a job while it is shown (its line's words, each once).
function watchCards() {
  window.__news = {};
  window.__words = [];
  import('/app/js/platform.js').then((p) => p.jobs.subscribe((j) => window.__words.push([j.type, j.gid, j.kind, j.status, j.done, j.total, j.labelKey, j.batch].map((x) => x ?? '').join(' '))));
  const look = () => {
    for (const card of document.querySelectorAll('#grid > .card')) {
      const title = card.querySelector('.card-title')?.textContent ?? card.dataset.galleryId;
      if (!card.querySelector('.card-body')?.classList.contains('downloading')) continue;
      const words = (window.__news[title] ??= []);
      const line = card.querySelector('.card-prog-label')?.textContent ?? '';
      if (line && !words.includes(line)) words.push(line);
    }
  };
  new MutationObserver(look).observe(document.getElementById('grid'), { subtree: true, childList: true, attributes: true, characterData: true });
}

// What the library holds: each gallery's title, pages stored and listed, its series' title, its chapters.
const holdings = (page) => page.evaluate(async () => {
  const api = await import('/app/js/api.js');
  const ids = (await api.transfer.ids()).map(String);
  const gs = (await api.galleries.byIds(ids)).filter(Boolean);
  const byId = new Map(gs.map((g) => [String(g.id), g]));
  const title = (g) => g?.title?.english || g?.title?.pretty || '';
  return gs.map((g) => [title(g), g.count ?? null, g.numPages ?? null, g.parentId ? title(byId.get(String(g.parentId))) : null, (g.chapters || []).map((c) => title(byId.get(String(c.id))))])
    .map((row) => JSON.stringify(row)).sort();
});
// What the page shows: its cards (title and meta line), the header's totals, the tracker's panels.
const shown = (page) => page.evaluate(() => ({
  cards: [...document.querySelectorAll('#grid > .card')].map((c) => `${c.querySelector('.card-title')?.textContent ?? ''} | ${c.querySelector('.card-meta')?.textContent ?? ''}`),
  totals: document.getElementById('hTotalGalleries')?.textContent ?? null,
  tracker: [...document.querySelectorAll('#importTracker .ib')].map((p) => [p.classList.contains('listing') ? 'reading' : p.dataset.state,
    ...['.ib-name', '.ib-tally', '.ib-issues'].map((s) => p.querySelector(s)?.textContent ?? '')].join(' | ')),
  trackerShown: !!document.getElementById('importTracker') && !document.getElementById('importTracker').hidden,
}));
const toastText = (page) => page.evaluate(() => document.querySelector('.notice-toast, [data-slot="toast-text"]')?.textContent?.trim() ?? null);

// Until nothing has changed for 1.5 s (the library, the page, a dialog) and no batch runs.
async function settle(page, timeout = 30000) {
  const end = Date.now() + timeout;
  let last = '', since = Date.now();
  while (Date.now() < end) {
    const now = JSON.stringify([await holdings(page), await shown(page), await page.evaluate(() => !!document.querySelector('.notice-overlay, [data-notice]'))]);
    const running = await page.evaluate(() => !!document.querySelector('#importTracker .ib:is([data-state="running"], [data-state="waiting"]), #importTracker .ib.listing'));
    // (2.5 s: the new page reads its totals 800 ms after the library's last word of a change, which may
    // come a second after the last change seen; 1.3 read them as a job ended.)
    if (now !== last) { last = now; since = Date.now(); } else if (!running && Date.now() - since > 2500) return;
    await sleep(250);
  }
}

// A pick with Import: what the picker offered, then `files` chosen.
async function pick(page, files, seen) {
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 8000 }), page.click('#uploadCbzBtn')]);
  seen.push({ picker: { multiple: chooser.isMultiple(), accept: await page.$eval('#cbzFileInput', (i) => i.accept) } });
  await chooser.accept(files);
}
// Files or folders dropped on the page, as the system's drag hands them over.
async function drop(page, files, steps = ['dragEnter', 'dragOver', 'drop']) {
  const cdp = await page.createCDPSession();
  const data = { items: [], files, dragOperationsMask: 1 };
  for (const type of steps) await cdp.send('Input.dispatchDragEvent', { type, x: 640, y: 500, data });
  await cdp.detach();
}

// Each case: its name and what is done on the page (`d`: the page and `seen`, where each dialog and
// toast is kept as it shows).
const dialog = async (d, wait) => { const box = await readDialog(d.page, wait); d.seen.push({ dialog: box && { title: box.title, body: box.body, detail: box.detail, tone: box.tone, buttons: box.buttons.map((b) => b.text) } }); return box; };
const toast = async (d) => { const text = await until(d.page, () => document.querySelector('.notice-toast, [data-slot="toast-text"]')?.textContent?.trim(), null, { what: 'the toast' }); d.seen.push({ toast: text }); };
// (A backup of the galleries' details asks nothing before it is restored: it says how it went.)
const backupAnswered = async (d) => { await dialog(d); await answer(d.page, 'ok'); };
const CASES = [
  ['a pick of one archive', async (d) => { await pick(d.page, [at('One.cbz')], d.seen); await settle(d.page); }],
  ['a pick of a PDF', async (d) => { await pick(d.page, [at('Paper.pdf')], d.seen); await settle(d.page); }],
  ['a pick of loose pictures', async (d) => { await pick(d.page, [at('Loose 1.png'), at('Loose 2.png')], d.seen); await settle(d.page); }],
  ['a pick of several titles and a file that is neither: asked first, OK', async (d) => {
    await pick(d.page, [at('Two.cbz'), at('Three.cbz'), at('notes.txt')], d.seen); await dialog(d); await answer(d.page, 'ok'); await settle(d.page);
  }],
  ['a pick of several titles: asked first, Cancel', async (d) => { await pick(d.page, [at('Two.cbz'), at('Three.cbz')], d.seen); await dialog(d); await answer(d.page, 'cancel'); await settle(d.page); }],
  ['a pick of several titles: asked first, Escape', async (d) => { await pick(d.page, [at('Two.cbz'), at('Three.cbz')], d.seen); await dialog(d); await answer(d.page, 'escape'); await settle(d.page); }],
  ['a title imported already', async (d) => {
    await pick(d.page, [at('One.cbz')], d.seen); await settle(d.page);
    await pick(d.page, [at('One.cbz')], d.seen); await toast(d); await settle(d.page);
  }],
  ['a pick of a file that is neither', async (d) => { await pick(d.page, [at('notes.txt')], d.seen); await dialog(d, 1500); await settle(d.page); }],
  ['a pick of a backup alone', async (d) => { await pick(d.page, [at('library.shi')], d.seen); await backupAnswered(d); await settle(d.page); }],
  ['a pick of a backup under another name, among titles: restored first, then imported', async (d) => {
    await pick(d.page, [at('Unconfirmed 51.crdownload'), at('One.cbz')], d.seen); await backupAnswered(d); await settle(d.page);
  }],
  ['a pick whose read fails', async (d) => { await pick(d.page, [at('broken.cbz')], d.seen); await dialog(d); await answer(d.page, 'escape'); await settle(d.page); }],
  ['a drop of one archive', async (d) => { await drop(d.page, [at('One.cbz')]); await settle(d.page); }],
  ['a drop of several titles: asked first, OK', async (d) => { await drop(d.page, [at('Two.cbz'), at('Three.cbz')]); await dialog(d); await answer(d.page, 'ok'); await settle(d.page); }],
  ['a drop of a real folder: asked first (its titles, what is left out), OK', async (d) => { await drop(d.page, [at('Shelf')]); await dialog(d); await answer(d.page, 'ok'); await settle(d.page); }],
  ['a drop of a folder of chapter folders: a series', async (d) => { await drop(d.page, [at('Saga')]); await dialog(d, 1500); await settle(d.page); }],
  ['a drop of a backup among titles', async (d) => { await drop(d.page, [at('library.shi'), at('Two.cbz')]); await backupAnswered(d); await settle(d.page); }],
  ['a drop whose read fails', async (d) => { await drop(d.page, [at('broken.cbz')]); await dialog(d); await answer(d.page, 'escape'); await settle(d.page); }],
  ['a drop of a file that is neither', async (d) => { await drop(d.page, [at('notes.txt')]); await dialog(d, 1500); await settle(d.page); }],
];

// One case on one page: its record.
async function run(where, steps) {
  const page = await openEmpty(where);
  const seen = [];
  await steps({ page, seen });
  // §5.3 F52: 1.3's page took a batch's word that a title was imported already for a job's news, and
  // opened that card's place, empty (no words): left out of the record.
  const news = Object.fromEntries(Object.entries(await page.evaluate(() => window.__news)).filter(([, words]) => words.length));
  // (What a card said during an import that takes a few ms is timing: the slowed batch's test holds it.)
  void news;
  const out = { seen, holdings: await holdings(page), ...(await shown(page)), toast: await toastText(page), problems: page.problems, words: process.env.DUMP ? await page.evaluate(() => window.__words) : undefined };
  await page.close();
  return out;
}

for (const [name, steps] of CASES) {
  test(name, async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const now = normalised(await run(NEW, steps), { site: origin });
    const was = record(FILE, 'cases', name);
    assert.deepEqual(now, was);
  });
}

// A real batch of two titles, slowed (each read of a file a while coming): each title on a card of its
// own, what each card said meanwhile, the tracker to its end. (Here a title's card comes once its
// gallery is made, as its import ends, on both pages: what a card draws of a title's news while it
// runs is held by library-jobs' batch test.)
test('a batch of two titles: each title on its own card', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await openEmpty(NEW);
    await page.evaluate(() => {
      const read = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () { return new Promise((r) => setTimeout(r, 250)).then(() => read.call(this)); };
    });
    const seen = [];
    await pick(page, [at('Two.cbz'), at('Three.cbz')], seen);
    await readDialog(page);
    await answer(page, 'ok');
    await settle(page, 60000);
    const news = await page.evaluate(() => window.__news);
    // Each card's words, the counts and readings it showed (a word the paced store may skip between two
    // of a title's pages is no part of it: the first and last of each kind are).
    const now = { titles: Object.keys(news).sort(), shown: Object.fromEntries(Object.entries(news).map(([k, w]) => [k, [w[0], w.at(-1)]])), ...(await shown(page)), problems: page.problems };
    await page.close();
    const was = record(FILE, 'batch');
    assert.deepEqual(now.cards.length, 2);
    assert.deepEqual(now, was);
  }
});

// ── The overlay, the reading panel, the tracker's place, ?import=1 ──

// In the page: the drop overlay as it shows now (1.3 drew it as the body's ::after), with its look.
function overlay() {
  const old = document.body.classList.contains('drag-over');
  const el = document.querySelector('[data-slot="drop-overlay"]');
  if (!old && !el) return null;
  const s = old ? getComputedStyle(document.body, '::after') : getComputedStyle(el);
  const words = old ? s.content.replace(/^"|"$/g, '') : el.textContent;
  return { words, ...Object.fromEntries(['position', 'top', 'left', 'right', 'bottom', 'zIndex', 'display', 'alignItems', 'justifyContent', 'fontSize', 'fontFamily', 'color', 'backgroundColor', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'pointerEvents'].map((k) => [k, s[k]])) };
}

test('the overlay: while files are dragged over the window, never for text; gone on leaving, on a drop, on a drag ending outside', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await openEmpty(NEW);
    const seen = [];
    const look = async (what) => seen.push([what, await page.evaluate(overlay)]);
    // The events a drag from outside brings, as the browser sends them to the element under it: each
    // element it enters says so, and each it leaves (the window's last, as the drag leaves it).
    await page.evaluate(async () => {
      const c = new OffscreenCanvas(40, 60); c.getContext('2d').fillRect(0, 0, 40, 60);
      window.__picture = new File([await c.convertToBlob({ type: 'image/png' })], 'Pic.png', { type: 'image/png' });
    });
    const fire = (type, kind, at = '#grid') => page.evaluate((type, kind, at) => {
      const data = new DataTransfer();
      if (kind === 'files') data.items.add(window.__picture); else data.setData('text/plain', 'some words');
      document.querySelector(at).dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    }, type, kind, at);
    await fire('dragenter', 'text'); await fire('dragover', 'text'); await look('text over the page');
    await fire('dragleave', 'text'); await look('text gone');
    await fire('dragenter', 'files'); await fire('dragover', 'files'); await look('files over the page');
    await fire('dragenter', 'files', 'header'); await fire('dragleave', 'files'); await look('files over the header');
    await fire('dragleave', 'files', 'header'); await look('the drag ended outside the window');
    await fire('dragenter', 'files'); await fire('dragover', 'files'); await look('files again');
    await fire('drop', 'files'); await look('dropped');
    await settle(page);
    const now = { seen, holdings: await holdings(page), problems: page.problems };
    await page.close();
    const was = record(FILE, 'overlay');
    // §5.3 A6: 1.3's words were its stylesheet's, in English in every language; the new page's are a
    // string of its own, the same words (no key exists for them yet).
    assert.deepEqual(now, was);
    assert.equal(now.seen.find(([w]) => w === 'files over the page')[1]?.words, 'Drop to import');
  }
});

test('a drop being read: the tracker\'s reading panel during a slow listing, gone at its end', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await openEmpty(NEW);
    await page.evaluate(() => {
      // Each batch of a folder's list a while coming, so the reading is seen.
      const getEntry = DataTransferItem.prototype.webkitGetAsEntry;
      DataTransferItem.prototype.webkitGetAsEntry = function () {
        const entry = getEntry.call(this);
        if (entry?.isDirectory) {
          const slowed = (dir) => { const create = dir.createReader.bind(dir); dir.createReader = () => { const reader = create(), read = reader.readEntries.bind(reader); reader.readEntries = (ok, fail) => setTimeout(() => read((list) => ok(list.map((e) => (e.isDirectory ? slowed(e) : e))), fail), 400); return reader; }; return dir; };
          slowed(entry);
        }
        return entry;
      };
      window.__panels = [];
      const look = () => {
        const p = document.querySelector('#importTracker .ib.listing');
        const now = p ? [p.querySelector('.ib-kind')?.textContent, p.querySelector('.ib-name')?.textContent, p.querySelector('.ib-tally')?.textContent].join(' | ') : null;
        if (now !== window.__panels.at(-1)) window.__panels.push(now);
      };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await drop(page, [at('Shelf')]);
    const box = await readDialog(page, 15000);
    await answer(page, 'cancel');
    await settle(page);
    const now = { panels: await page.evaluate(() => window.__panels), dialog: box?.title, tracker: (await shown(page)).trackerShown, problems: page.problems };
    await page.close();
    const was = record(FILE, 'reading');
    assert.ok(now.panels.some((p) => p && /Reading the folder/.test(p)), JSON.stringify(now.panels));
    assert.equal(now.panels.at(-1), null, 'gone at its end');
    assert.deepEqual(now, was);
  }
});

// The tracker's panel and its host, as boxes, with a batch under way: at every width 1.3 has a rule
// for, on a phone, and at 125% and 150%.
const SIZES = [
  { width: 1600, height: 900 }, { width: 1280, height: 900 }, { width: 760, height: 900 }, { width: 601, height: 900 }, { width: 600, height: 900 },
  { width: 400, height: 800 }, { width: 390, height: 844, isMobile: true, hasTouch: true },
  { width: 1280, height: 900, deviceScaleFactor: 1.25 }, { width: 1280, height: 900, deviceScaleFactor: 1.5 },
];
function trackerBoxes() {
  const round = (n) => Math.round(n * 100) / 100;
  const toolbar = document.querySelector('.toolbar').getBoundingClientRect().bottom;
  const r = (el) => { const b = el.getBoundingClientRect(); return [b.left, b.top - toolbar, b.width, b.height].map(round); };
  const host = document.getElementById('importTracker');
  const ib = host.querySelector('.ib');
  return {
    host: r(host), ib: r(ib), gridGap: round(document.getElementById('grid').getBoundingClientRect().top - host.getBoundingClientRect().bottom),
    buttons: [...ib.querySelectorAll('.ib-btn:not([hidden])')].map((b) => r(b).slice(2)),
    fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  };
}
test('the tracker: in 1.3\'s place and on its margins at every width, on a phone, at 125% and 150%', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  {
    const page = await openEmpty(NEW);
    const now = [];
    for (const size of SIZES) {
      await page.setViewport(size);
      await page.reload({ waitUntil: 'load' });
      await until(page, () => !!document.querySelector('#grid .empty, #grid > .card'), null, { what: 'the page' });
      await page.evaluate(async () => {
        const platform = await import('/app/js/platform.js');
        await platform.jobs.receive({ gid: 'import-9', kind: 'import', status: 'progress', name: 'A folder with a rather long name that has to give way',
          total: 18608, done: 2341, imported: 2300, skipped: 40, failed: 1, bytes: 8.3e11, bytesDone: 9.8e10, startedAt: Date.now() - 3600e3,
          current: { name: 'A title of its own that is long as well', done: 14, total: 30, bytes: 4e7 }, movedAt: Date.now(), at: Date.now(),
          runner: { kind: 'tab', page: 'library', id: 'another-tab' } });
      });
      await until(page, () => document.querySelector('#importTracker .ib .ib-tally')?.textContent, null, { what: 'the panel' });
      await sleep(300);
      now.push(await page.evaluate(trackerBoxes));
      await page.evaluate(async () => (await import('/app/js/platform.js')).jobs.clear('import-9', 'import'));
    }
    assert.deepEqual(page.problems, []);
    await page.close();
    const was = record(FILE, 'tracker');
    assert.deepEqual(now, was);
  }
});

// What is true of ?import=1 (6e, plans/frontend-react-probes/6e/import-param.mjs, Chrome and Firefox
// alike): on a load each page asks its file input to open once the page has loaded, with no press of the
// person's to go on (a load ends the press that led to it), and the browser shows no picker (Chrome says
// "File chooser dialog can only be shown with a user activation"; Firefox refuses without a word). On
// the new page a change of route to it, from a press, keeps that press: its picker opens.
test('?import=1: on a load each page asks for the picker and the browser shows none; a change of route to it after a press opens it', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const out = {};
  const opened = (page, go) => Promise.all([page.waitForFileChooser({ timeout: 4000 }).then((c) => c.cancel().then(() => true), () => false), go()]).then(([o]) => o);
  const asked = (page) => page.evaluate(() => window.__asked);
  const instrument = (page) => page.evaluateOnNewDocument(() => {
    window.__asked = [];
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { if (this.type === 'file') window.__asked.push([this.id, navigator.userActivation.isActive]); return click.call(this); };
  });
  {
    const page = await openEmpty(NEW);
    await instrument(page);
    const now = { load: await opened(page, () => page.goto(`${origin}${NEW}?import=1`, { waitUntil: 'load' })) };
    await sleep(500);
    now.asked = await asked(page);
    now.address = await page.evaluate(() => location.search);
    await page.close();
    const was = record(FILE, 'import-param');
    assert.deepEqual(was, { load: false, asked: [['cbzFileInput', false]], address: '' });
    assert.deepEqual(now, was);
  }
  // A change of route to it, from Tasks: a link in the page, pressed, followed inside the app.
  const page = await openEmpty(NEW);
  await instrument(page);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.waitForSelector('#tkList');
  await page.evaluate((href) => { const a = document.createElement('a'); a.id = 'toImport'; a.href = href; a.textContent = 'Import'; Object.assign(a.style, { position: 'fixed', left: '10px', top: '200px', zIndex: 9999 }); document.body.append(a); }, `${NEW}?import=1`);
  out.route = await opened(page, () => page.click('#toImport'));
  out.routeAt = await page.evaluate(() => location.pathname);
  out.routeAsked = await asked(page);
  await page.close();
  assert.deepEqual([out.route, out.routeAt, out.routeAsked], [true, NEW, [['cbzFileInput', true]]]);
});

// ── The new page alone: leaving it leaves nothing behind ──

// In every document: what is held on the window and the document (listeners, intervals, observers,
// channels, object URLs), counted as it is taken and given back.
function countHeld() {
  const held = window.__held = { listeners: 0, intervals: 0, observers: 0, channels: 0, urls: 0 };
  for (const target of [window, document]) {
    const add = target.addEventListener, remove = target.removeEventListener;
    target.addEventListener = function (type, fn, opts) {
      const k = `${type}|${typeof opts === 'object' ? !!opts?.capture : !!opts}`;
      const key = fn && (fn.__keys ??= new Set());
      if (key && !key.has(k)) {
        key.add(k); held.listeners++;
        opts?.signal?.addEventListener('abort', () => { if (key.delete(k)) held.listeners--; }, { once: true });
      }
      return add.call(this, type, fn, opts);
    };
    target.removeEventListener = function (type, fn, opts) { const k = `${type}|${typeof opts === 'object' ? !!opts?.capture : !!opts}`; if (fn?.__keys?.has(k)) { fn.__keys.delete(k); held.listeners--; } return remove.call(this, type, fn, opts); };
  }
  const si = window.setInterval, ci = window.clearInterval, live = new Set();
  window.setInterval = (...a) => { const h = si(...a); live.add(h); held.intervals = live.size; return h; };
  window.clearInterval = (h) => { live.delete(h); held.intervals = live.size; return ci(h); };
  for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
    const Base = window[name];
    window[name] = class extends Base { observe(...a) { if (!this.__on) { this.__on = true; held.observers++; } return super.observe(...a); } disconnect() { if (this.__on) { this.__on = false; held.observers--; } return super.disconnect(); } };
  }
  const BC = window.BroadcastChannel;
  window.BroadcastChannel = class extends BC { constructor(n) { super(n); held.channels++; } close() { if (!this.__closed) { this.__closed = true; held.channels--; } return super.close(); } };
  const cu = URL.createObjectURL, ru = URL.revokeObjectURL, urls = new Set();
  URL.createObjectURL = (o) => { const u = cu(o); urls.add(u); held.urls = urls.size; return u; };
  URL.revokeObjectURL = (u) => { urls.delete(u); held.urls = urls.size; return ru(u); };
  // A folder's list read slowly, and a backup read slowly, so each is under way when the page is left.
      const getEntry = DataTransferItem.prototype.webkitGetAsEntry;
      DataTransferItem.prototype.webkitGetAsEntry = function () {
        const entry = getEntry.call(this);
        if (entry?.isDirectory) {
          const slowed = (dir) => { const create = dir.createReader.bind(dir); dir.createReader = () => { const reader = create(), read = reader.readEntries.bind(reader); reader.readEntries = (ok, fail) => setTimeout(() => read((list) => ok(list.map((e) => (e.isDirectory ? slowed(e) : e))), fail), 600); return reader; }; return dir; };
          slowed(entry);
        }
        return entry;
      };
  const text = Blob.prototype.text;
  Blob.prototype.text = function () { return this.name === 'library.shi' ? new Promise((r) => setTimeout(r, 1500)).then(() => text.call(this)) : text.call(this); };
}

test('leaving the page five times with a drop being read, a batch running, a drag under way and a backup\'s window open leaves nothing behind', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const page = await openEmpty(NEW);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    const api = await import('/app/js/api.js');
    const c = new OffscreenCanvas(60, 90); c.getContext('2d').fillRect(0, 0, 60, 90);
    for (const n of [1, 2]) {
      await api.meta.put({ galleryId: `179000900000${n}`, title: { english: `Kept ${n}`, japanese: '', pretty: '' }, tags: [], numPages: 1 });
      await api.pages.put(`179000900000${n}`, 1, await c.convertToBlob({ type: 'image/png' }));
    }
  });
  await page.evaluateOnNewDocument(countHeld);
  await page.goto(`${origin}${NEW}`, { waitUntil: 'load' });
  await until(page, () => document.querySelectorAll('#grid > .card img.card-thumb[src]').length === 2, null, { what: 'the page' });
  const away = async () => {
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '/settings'; document.body.append(a); a.click(); a.remove(); });
    await until(page, () => location.pathname === '/settings' && !!document.getElementById('settingsNav'), null, { what: 'Settings' });
  };
  const back = async () => {
    await page.evaluate(() => history.back());
    await until(page, (path) => location.pathname === path && document.querySelectorAll('#grid > .card img.card-thumb[src]').length >= 2, NEW, { what: 'the library again' });
  };
  // Until nothing of the app's own is still running or asking (a backup's window and what it says).
  const quiet = async () => {
    for (let i = 0; i < 60; i++) {
      const open = await page.evaluate(() => document.querySelector('[data-notice="operation"], [data-notice="dialog"]')?.getAttribute('data-notice') ?? null);
      if (!open) break;
      if (open === 'dialog') await page.evaluate(() => document.querySelector('[data-notice="dialog"] [data-slot="dialog-footer"] button:last-child')?.click());
      await sleep(250);
    }
    await sleep(1500);
  };
  const counts = [];
  for (let i = 0; i < 6; i++) {
    // A batch of imports under way in another tab, shown by the tracker.
    await page.evaluate(async (i) => (await import('/app/js/platform.js')).jobs.receive({ gid: 'import-77', kind: 'import', status: 'progress', name: 'Elsewhere',
      total: 10, done: i, imported: i, skipped: 0, failed: 0, bytes: 1e6, bytesDone: i * 1e5, startedAt: Date.now() - 60000, movedAt: Date.now(), at: Date.now(),
      runner: { kind: 'tab', page: 'library', id: 'another-tab' } }), i);
    await until(page, () => !!document.querySelector('#importTracker .ib[data-batch="import-77"]'), null, { what: 'the batch' });
    // A drop being read, and a drag under way, as the page is left.
    await drop(page, [at('Shelf')]);
    await until(page, () => !!document.querySelector('#importTracker .ib.listing'), null, { what: 'the reading' });
    const cover = await (await page.$('#grid > .card .card-thumb-wrap')).boundingBox();
    await page.mouse.move(cover.x + 40, cover.y + 40); await page.mouse.down(); await page.mouse.move(cover.x + 120, cover.y + 90, { steps: 6 });
    await until(page, () => !!document.querySelector('.card-drag-clone'), null, { what: 'the drag' });
    await away();
    const left = await page.evaluate(() => ({ copy: !!document.querySelector('.card-drag-clone'), dragging: document.body.classList.contains('card-dragging'), overlay: !!document.querySelector('[data-slot="drop-overlay"]') }));
    await page.mouse.up();
    await back();
    // A backup's window open as the page is left.
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 8000 }), page.click('#uploadCbzBtn')]);
    await chooser.accept([at('library.shi')]);
    await until(page, () => !!document.querySelector('[data-notice="operation"]'), null, { what: 'the backup\'s window' });
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '/settings'; document.body.append(a); a.click(); a.remove(); });
    await until(page, () => location.pathname === '/settings', null, { what: 'Settings' });
    await quiet();
    await back();
    await quiet();
    counts.push(await page.evaluate((left) => ({ ...window.__held, left, cards: document.querySelectorAll('.card').length, copies: document.querySelectorAll('.card-drag-clone').length,
      panels: document.querySelectorAll('#importTracker .ib').length, dialogs: document.querySelectorAll('[data-slot="dialog"]').length,
      bodyClasses: document.body.className }), left));
  }
  assert.deepEqual(counts[0].left, { copy: false, dragging: false, overlay: false }, 'the drag went with the page');
  assert.deepEqual(counts.slice(1), Array(5).fill(counts[0]), JSON.stringify(counts));
  assert.deepEqual(page.problems, []);
  await page.close();
});

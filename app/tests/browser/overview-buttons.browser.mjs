// overview-buttons.browser.mjs — what the overview's buttons do at /overview-next, held to what 1.3's
// page (/overview) gave driven alike, with stand-ins for the helper and the translation
// server: for each press in each case (plain, Shift, the right button; a series' chapter, its owner, a
// volume, a translated one, one with no pages, one whose download is under way, a missing one, a linked
// one; the helper there and not; the translation server's answer taken and not), what is said to
// whatever runs things (type and fields, in order), each dialog and menu (its words, cover, buttons,
// focus), each answer's outcome (OK, Cancel, Escape), what the row shows right after (a job begun) and
// what the library holds after (each gallery; the series' order and its own titles). Any difference from
// 1.3's fails, but those named here (§5.3's rows).
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the overview's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { startTranslator } from './stand-in-translator.mjs';
import { readDialog, answer, readMenu, pickStep } from './library-drive.mjs';
import { record as kept } from './records.mjs';
import { openRun, nextBase, gid, visit, read, named, sleep, publish, record, outcome, pressRow, pressAt, rowSel, NEW } from './overview-drive.mjs';

const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser, tr, dir, picture;

// A small PNG, for Replace.
function png(w, h) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([60, 90 + y, 200], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  tr = await startTranslator();
  browser = await launch();
  dir = mkdtempSync(join(tmpdir(), 'shiori-ov-replace-'));
  picture = join(dir, 'Replacement 1.png');
  writeFileSync(picture, png(60, 85));
});
after(async () => { await browser?.close(); server?.close(); await tr?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

// In the page, before it is shown: what a case needs of the library.
const PREP = {
  // S2 with 2 of 5 pages (a download of it is not "again").
  incomplete: async ({ id }) => { const api = await import('/app/js/api.js'); const m = await api.meta.get(id.S2); await api.meta.put({ ...m, numPages: 5 }); },
  // S2 with no pages.
  empty: async ({ id }) => { const api = await import('/app/js/api.js'); await api.pages.prune(id.S2, []); },
  // S2 and S3 read as linked (files the app did not make).
  linked: async ({ id }) => {
    const api = await import('/app/js/api.js');
    const ids = [id.S2, id.S3];
    const mark = (g) => (g && ids.includes(String(g.id)) ? { ...g, linked: { kind: 'folder', path: 'Shelf' } } : g);
    for (const name of ['get', 'byIds']) { const was = api.galleries[name]; api.galleries[name] = async (...a) => { const out = await was(...a); return Array.isArray(out) ? out.map(mark) : mark(out); }; }
    const chapters = api.series.chapters;
    api.series.chapters = async (...a) => (await chapters(...a)).map((c) => ({ ...c, entity: mark(c.entity) }));
  },
  // What translating S3 kept: page 1 every step's (the re-run menu's steps can be used).
  rerun: async ({ id }) => {
    const api = await import('/app/js/api.js');
    const c = new OffscreenCanvas(20, 30); c.getContext('2d').fillRect(0, 0, 20, 30);
    await api.derived.putTranslation(id.S3, 1, { image: await c.convertToBlob({ type: 'image/png' }), pipeline: { job: 'j1', lines: [], read: [], regions: [] } });
  },
  // A removal the library's folder refuses.
  refuse: async () => {
    const api = await import('/app/js/api.js');
    api.series.remove = async () => { throw Object.assign(new Error('refused'), { code: 'unavailable', reason: 'not-owned' }); };
  },
};

// Each case: its name, how its page opens ({ helper, prep, part: the gallery shown }), what is done.
const CASES = [
  ['the heart: a gallery, off', { part: 'G' }, async (d) => { await d.at('#favToggle'); await sleep(500); }],
  ['the heart: a series, on', {}, async (d) => { await d.at('#favToggle'); await sleep(500); }],
  ['an arrow: a chapter down, its focus kept', {}, async (d) => { await d.row('S2', 'down'); await sleep(900); d.seen.push({ focus: await d.focus() }); }],
  ['an arrow: the owner down (ownership moves)', {}, async (d) => { await d.row('S', 'down'); await sleep(1200); }],
  ['an arrow: a chapter up twice', {}, async (d) => { await d.row('S3', 'up'); await d.row('S3', 'up'); await sleep(1200); d.seen.push({ focus: await d.focus() }); }],
  ['an arrow: a volume up', { view: 'volumes' }, async (d) => { await d.row('V2', 'up'); await sleep(1000); }],
  ['an arrow: the first\'s up is off', {}, async (d) => { d.seen.push({ off: await d.page.evaluate((sel) => document.querySelector(sel).disabled, `${rowSel(d.base, 'S')} [data-up]`) }); }],
  ['download: whole, asked again, Cancel', {}, async (d) => { await d.row('S2', 'download'); await d.dialog(); await d.answer('cancel'); }],
  ['download: whole, asked again, OK', {}, async (d) => { await d.row('S2', 'download'); await d.dialog(); await d.answer('ok'); await d.job('S2'); }],
  ['download: whole, asked again, Escape', {}, async (d) => { await d.row('S2', 'download'); await d.dialog(); await d.answer('escape'); }],
  ['download: incomplete, no question', { prep: 'incomplete' }, async (d) => { await d.row('S2', 'download'); await d.dialog(800); await d.job('S2'); }],
  ['download\'s Stop, pressed twice', {}, async (d) => {
    await publish(d.page, { gid: d.id('S2'), kind: 'download', status: 'progress', done: 1, total: 4 });
    await until(d.page, (sel) => document.querySelector(sel)?.classList.contains('cancelling'), `${rowSel(d.base, 'S2')} [data-download]`, { what: 'the Stop' });
    await d.page.evaluate((sel) => { const b = document.querySelector(sel); b.click(); b.click(); }, `${rowSel(d.base, 'S2')} [data-download]`);
    await sleep(800);
  }],
  ['download while an import runs: nothing', {}, async (d) => {
    await publish(d.page, { gid: d.id('S2'), kind: 'upload', status: 'progress', done: 1, total: 4 });
    await until(d.page, (sel) => document.querySelector(sel)?.disabled, `${rowSel(d.base, 'S2')} [data-download]`, { what: 'off' });
    await d.page.evaluate((sel) => document.querySelector(sel).click(), `${rowSel(d.base, 'S2')} [data-download]`);
    await sleep(500);
  }],
  ['Shift on download, the helper there: Replace\'s picker, cancelled', {}, async (d) => {
    const [chooser] = await Promise.all([d.page.waitForFileChooser({ timeout: 5000 }), d.row('S2', 'download', { shift: true })]);
    d.seen.push({ picker: chooser.isMultiple() });
    await chooser.cancel();
    await sleep(400);
  }],
  ['Replace, no helper: a picture picked', { helper: false }, async (d) => {
    const [chooser] = await Promise.all([d.page.waitForFileChooser({ timeout: 5000 }), d.row('S2', 'download')]);
    d.seen.push({ picker: chooser.isMultiple() });
    await chooser.accept([picture]);
    await until(d.page, async (id) => (await (await import('/app/js/api.js')).galleries.get(id))?.count === 1, d.id('S2'), { what: 'the pages replaced' });
    await sleep(1500);
  }],
  ['translate: asked first, Cancel', {}, async (d) => { await d.row('S2', 'translate'); await d.dialog(); await d.answer('cancel'); }],
  ['translate: asked first, OK', {}, async (d) => { await d.row('S2', 'translate'); await d.dialog(); await d.answer('ok'); await d.job('S2'); }],
  // N1 (a fault of 1.3's, not copied): 1.3 took the row's job back (discardChapterJob) but never drew
  // the row again (its buttons were painted by the job, not by the row's own state, which had not
  // changed): "Translating…" and a Stop stayed until the page was loaded again. The new page puts the
  // row at rest.
  ['translate: the press not taken, its job gone', { differs: (was) => {
    const row = was.dialogs.at(-1).row;
    row.state = []; row.progress = null; row.actions.find((a) => a[0] === 'translate')[1] = [];
  } }, async (d) => {
    await d.page.evaluate(() => { window.__refuseStart = true; });
    await d.row('S2', 'translate'); await d.dialog(); await d.answer('ok'); await sleep(600); await d.job('S2');
  }],
  ['translate: no pages, told so', { prep: 'empty' }, async (d) => { await d.row('S2', 'translate'); await d.dialog(); await d.answer('escape'); }],
  ['translate: translated already, no question', {}, async (d) => { await d.row('S3', 'translate'); await d.dialog(800); await d.job('S3'); }],
  ['Shift on translate: revert, OK', {}, async (d) => { await d.row('S3', 'translate', { shift: true }); await d.dialog(); await d.answer('ok'); await sleep(1200); }],
  ['Shift on translate: revert, Cancel', {}, async (d) => { await d.row('S3', 'translate', { shift: true }); await d.dialog(); await d.answer('cancel'); }],
  ['Shift on translate, not translated: translate', {}, async (d) => { await d.row('S2', 'translate', { shift: true }); await d.dialog(); await d.answer('cancel'); }],
  ['the right button: Re-run from…, a step, OK', { prep: 'rerun' }, async (d) => {
    await d.row('S3', 'translate', { right: true }); d.seen.push({ menu: await readMenu(d.page) });
    await pickStep(d.page, 'Text recognition'); await d.dialog(); await d.answer('ok'); await d.job('S3');
  }],
  ['the right button: Re-run from…, Escape', { prep: 'rerun' }, async (d) => {
    await d.row('S3', 'translate', { right: true }); d.seen.push({ menu: await readMenu(d.page) }); await d.page.keyboard.press('Escape'); await sleep(400);
    d.seen.push({ menuLeft: await d.page.evaluate(() => !!document.querySelector('.ctx-menu, [data-slot="menu"]')) });
  }],
  ['the right button, not translated: no menu', {}, async (d) => { await d.row('S2', 'translate', { right: true }); d.seen.push({ menu: await readMenu(d.page, 800) }); }],
  ['translate\'s Stop', {}, async (d) => {
    await publish(d.page, { gid: d.id('S3'), kind: 'translate', status: 'progress', pct: 30, labelKey: 'prog.translating' });
    await until(d.page, (sel) => document.querySelector(sel)?.classList.contains('cancelling'), `${rowSel(d.base, 'S3')} [data-translate]`, { what: 'the Stop' });
    await d.row('S3', 'translate'); await sleep(600);
  }],
  ['detach: no question, a gallery of its own again', {}, async (d) => { await d.row('S2', 'detach'); await d.dialog(800); await sleep(1500); }],
  ['delete: asked, Cancel', {}, async (d) => { await d.row('S2', 'remove'); await d.dialog(); await d.answer('cancel'); }],
  ['delete: asked, OK', {}, async (d) => { await d.row('S2', 'remove'); await d.dialog(); await d.answer('ok'); await sleep(1500); }],
  ['delete with Shift: no question', {}, async (d) => { await d.row('S3', 'remove', { shift: true }); await d.dialog(800); await sleep(1500); }],
  ['delete the owner with Shift: the series goes on from the next', {}, async (d) => { await d.row('S', 'remove', { shift: true }); await sleep(2000); }],
  ['delete a missing chapter: asked, OK', {}, async (d) => { await d.row('X', 'remove'); await d.dialog(); await d.answer('ok'); await sleep(1500); }],
  ['delete a linked chapter: its words, OK', { prep: 'linked' }, async (d) => { await d.row('S2', 'remove'); await d.dialog(); await d.answer('ok'); await sleep(1500); }],
  ['delete refused by its folder: told so', { prep: 'refuse' }, async (d) => { await d.row('S2', 'remove', { shift: true }); await d.dialog(); await d.answer('ok'); await sleep(800); }],
  ['delete a volume of two: the series ends', { part: 'W' }, async (d) => { await d.row('W2', 'remove', { shift: true }); await sleep(2000); }],
];

// One case on one page: what it said, asked and left.
async function run(path, [, opts, steps]) {
  const base = nextBase(1790010000000);
  // A library of its own.
  const context = await browser.createBrowserContext();
  const page = await openRun(context, origin, base, { translator: tr.origin, helper: opts.helper !== false,
    storage: { 'shiori:translateSettings': { serverUrl: tr.origin }, ...(opts.view ? { 'shiori:seriesView': opts.view } : {}) } });
  const id = (part) => gid(base, part);
  if (opts.prep) await page.evaluateOnNewDocument(PREP[opts.prep], { id: { S2: id('S2'), S3: id('S3') } });
  await visit(page, origin, path, id(opts.part ?? 'S'));
  // The translate buttons: shown once the stand-in server has answered.
  await until(page, () => !document.querySelector('.ch-row') || getComputedStyle(document.querySelector('.ch-row:not(.missing) [data-translate]')).display !== 'none', null, { what: 'the translation server' });
  await page.evaluate(record);
  const seen = [];
  const d = {
    page, base, seen, id,
    row: (part, what, mods) => pressRow(page, base, part, what, mods),
    at: (sel, mods) => pressAt(page, sel, mods),
    dialog: async (wait) => { const shown = await readDialog(page, wait); seen.push(shown); return shown; },
    answer: (how) => answer(page, how),
    // What the row shows right after (its job's words, its buttons' states).
    job: async (part) => { await sleep(150); const r = await page.evaluate(read); const row = r.rows.find((x) => x.id === id(part)); seen.push({ row: row && { state: row.state, progress: row.progress, actions: row.actions.map((a) => [a.kind, a.state, a.disabled]) } }); },
    // What has focus: a row's button (its row's part and kind).
    focus: () => page.evaluate(() => { const b = document.activeElement?.closest('button'); const row = b?.closest('.ch-row'); return row ? `${row.dataset.chapterId} ${['up', 'down', 'download', 'translate', 'detach', 'remove'].find((k) => b.hasAttribute(`data-${k}`))}` : null; }),
  };
  await steps(d);
  const r = await page.evaluate(read);
  const out = named({ ...(await outcome(page, base)), dialogs: seen,
    shown: r.empty ? { empty: r.empty } : { title: r.hero.title, rows: r.rows.map((x) => `${x.num} ${x.id} ${x.title}`) }, at: new URL(page.url()).pathname.replace(/-next$/, '') }, base);
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

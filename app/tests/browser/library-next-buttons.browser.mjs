// library-next-buttons.browser.mjs — a card's heart, open, download and translate buttons on
// /library-next, held to what 1.3's page (/library) gave driven alike, with stand-ins for the helper and the
// translation server: for each press in each case (plain, Shift, Alt, the right button; a gallery
// whole, incomplete, empty, translated, with no source, a series merged and unmerged; the helper there
// and not), what is said to whatever runs things and to the helper (type and fields, in order), each
// dialog (its words, cover, buttons, focus), menu and window, each answer's outcome, what is opened or
// picked, and what the library holds after. Any difference from 1.3's fails, but those named here
// (§5.3's rows).
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the library's behaviour edits in the same commit.
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
import { openRun, result, press, readDialog, answer, typeInto, readMenu, pickStep, readSeriesWindow, publish, nextBase, card, sleep } from './library-drive.mjs';
import { record, normalised } from './records.mjs';

const NEW = '/library-next';
const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser, tr, dir, picture;

// A small PNG, for Replace.
function png(w, h) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([200, 60 + y, 90], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  tr = await startTranslator();
  browser = await launch();
  await browser.defaultBrowserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  dir = mkdtempSync(join(tmpdir(), 'shiori-replace-'));
  picture = join(dir, 'Replacement 1.png');
  writeFileSync(picture, png(60, 85));
});
after(async () => { await browser?.close(); server?.close(); await tr?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

// Each case: its name, how its page opens, and what is done there (`d`: the page, its run's base,
// and `seen`, where what each dialog, menu and window showed is kept).
const CASES = [
  ['the heart', {}, async (d) => { await d.press('P', 'fav'); await sleep(600); }],
  ['the open button: the source\'s page, in a new window', {}, async (d) => { await d.press('P', 'open'); }],
  ['Shift on the open button: the source prompt, Escape', {}, async (d) => { await d.press('P', 'open', { shift: true }); await d.dialog(); await d.answer('escape'); }],
  ['Shift on the open button: a new link, the helper there', {}, async (d) => {
    await d.press('P', 'open', { shift: true }); await d.dialog(); await typeInto(d.page, 'https://a.example/g/777'); await d.answer('ok'); await sleep(800);
  }],
  ['Shift on the open button: a new link, no helper', { helper: false }, async (d) => {
    await d.press('P', 'open', { shift: true }); await d.dialog(); await typeInto(d.page, 'a.example/g/778'); await d.answer('ok'); await sleep(800);
  }],
  ['no link: the clipboard\'s link taken without asking', {}, async (d) => {
    await d.clipboard('https://a.example/g/555'); await d.press('N', 'open'); await d.dialog(1000); await sleep(600);
  }],
  ['no link, words on the clipboard: the prompt, empty, Cancel', {}, async (d) => {
    await d.clipboard('just some words'); await d.press('N', 'open'); await d.dialog(); await d.answer('cancel');
  }],
  ['no link, Shift: the prompt with the clipboard\'s link in it', {}, async (d) => {
    await d.clipboard('https://a.example/g/556'); await d.press('N', 'open', { shift: true }); await d.dialog(); await d.answer('ok'); await sleep(800);
  }],
  ['a merged series, Shift on open: the prompt, then every chapter', {}, async (d) => {
    await d.press('S', 'open', { shift: true }); await d.dialog(); await typeInto(d.page, 'https://a.example/g/888'); await d.answer('ok');
    await d.dialog(); await d.answer('ok'); await sleep(900);
  }],
  ['a merged series, Shift on open: the prompt, then this one only', {}, async (d) => {
    await d.press('S', 'open', { shift: true }); await d.dialog(); await typeInto(d.page, 'https://a.example/g/889'); await d.answer('ok');
    await d.dialog(); await d.answer('cancel'); await sleep(900);
  }],
  ['download: whole, asked again, Cancel', {}, async (d) => { await d.press('P', 'dl'); await d.dialog(); await d.answer('cancel'); }],
  ['download: whole, asked again, OK', {}, async (d) => { await d.press('P', 'dl'); await d.dialog(); await d.answer('ok'); await sleep(800); }],
  ['download: incomplete, no question', {}, async (d) => { await d.press('I', 'dl'); await d.dialog(800); await sleep(800); }],
  ['download: a merged series, nothing missing, OK', {}, async (d) => { await d.press('S', 'dl'); await d.dialog(); await d.answer('ok'); await sleep(800); }],
  ['download: the series\' owner unmerged, a gallery, OK', { merge: false }, async (d) => { await d.press('S', 'dl'); await d.dialog(); await d.answer('ok'); await sleep(800); }],
  ['download\'s Stop, pressed twice', {}, async (d) => {
    await publish(d.page, { gid: d.id('I'), kind: 'download', status: 'progress', done: 1, total: 4 });
    await until(d.page, (sel) => document.querySelector(sel)?.classList.contains('cancelling'), `${card(d.base, 'I')} .card-btn-dl`, { what: 'the Stop' });
    await d.page.evaluate((sel) => { const b = document.querySelector(sel); b.click(); b.click(); }, `${card(d.base, 'I')} .card-btn-dl`);
    await sleep(1000);
  }],
  ['Replace, no helper: a picture picked', { helper: false }, async (d) => {
    const [chooser] = await Promise.all([d.page.waitForFileChooser({ timeout: 5000 }), d.press('P', 'dl')]);
    d.seen.push({ picker: chooser.isMultiple() });
    await chooser.accept([picture]);
    await until(d.page, async (gid) => (await (await import('/app/js/api.js')).galleries.byIds([gid]))[0]?.count === 1, d.id('P'), { what: 'the pages replaced' });
    await sleep(1500);
  }],
  ['Shift on download, the helper there: Replace\'s picker, cancelled', {}, async (d) => {
    const [chooser] = await Promise.all([d.page.waitForFileChooser({ timeout: 5000 }), d.press('P', 'dl', { shift: true })]);
    d.seen.push({ picker: chooser.isMultiple() });
    await chooser.cancel();
    await sleep(400);
  }],
  ['translate: asked first, Cancel', {}, async (d) => { await d.press('P', 'tr'); await d.dialog(); await d.answer('cancel'); }],
  ['translate: asked first, OK', {}, async (d) => { await d.press('P', 'tr'); await d.dialog(); await d.answer('ok'); await sleep(500); }],
  ['translate: no pages, told so', {}, async (d) => { await d.press('E', 'tr'); await d.dialog(); await d.answer('escape'); }],
  ['translate: translated already, no question', {}, async (d) => { await d.press('T', 'tr'); await d.dialog(800); await sleep(500); }],
  ['Shift on translate: revert, OK', {}, async (d) => { await d.press('T', 'tr', { shift: true }); await d.dialog(); await d.answer('ok'); await sleep(1500); }],
  ['Shift on translate, not translated: translate', {}, async (d) => { await d.press('P', 'tr', { shift: true }); await d.dialog(); await d.answer('cancel'); }],
  ['the right button: Re-run from…, a step, OK', {}, async (d) => {
    await d.press('T', 'tr', { right: true }); d.seen.push({ menu: await readMenu(d.page) });
    await pickStep(d.page, 'Text recognition'); await d.dialog(); await d.answer('ok'); await sleep(500);
  }],
  ['the right button: Re-run from…, Escape', {}, async (d) => {
    await d.press('T', 'tr', { right: true }); d.seen.push({ menu: await readMenu(d.page) }); await d.page.keyboard.press('Escape'); await sleep(400);
    d.seen.push({ menuLeft: await d.page.evaluate(() => !!document.querySelector('.ctx-menu, [data-slot="menu"]')) });
  }],
  ['the right button, not translated: no menu', {}, async (d) => { await d.press('P', 'tr', { right: true }); d.seen.push({ menu: await readMenu(d.page, 800) }); }],
  ['a merged series: its window, Translate', {}, async (d) => {
    await d.press('S', 'tr'); d.seen.push({ window: await readSeriesWindow(d.page) }); await d.page.click('#_serTrGo'); await sleep(500);
  }],
  ['a merged series: its window, Cancel', {}, async (d) => {
    await d.press('S', 'tr'); d.seen.push({ window: await readSeriesWindow(d.page) }); await d.page.click('#_serTrCancel'); await sleep(400);
    d.seen.push({ windowLeft: await d.page.evaluate(() => !!document.getElementById('_serTrSel')) });
  }],
  ['translate\'s Stop', {}, async (d) => {
    await publish(d.page, { gid: d.id('T'), kind: 'translate', status: 'progress', pct: 30, labelKey: 'prog.translating' });
    await until(d.page, (sel) => document.querySelector(sel)?.classList.contains('cancelling'), `${card(d.base, 'T')} .card-btn-translate`, { what: 'the Stop' });
    await d.press('T', 'tr'); await sleep(800);
  }],
];

// One case on one page: its record.
async function run(path, [, opts, steps]) {
  const base = nextBase(1790002000000);
  const page = await openRun(browser, origin, path, { base, translator: tr.origin, ...opts });
  const seen = [];
  const d = {
    page, base, seen,
    id: (part) => String(base + { P: 10, I: 9, N: 8, T: 7, E: 6, S: 5, S2: 4 }[part]),
    press: (part, what, mods) => press(page, base, part, what, mods),
    dialog: async (wait) => { const shown = await readDialog(page, wait); seen.push(shown); return shown; },
    answer: (how) => answer(page, how),
    clipboard: async (text) => { await page.bringToFront(); await page.evaluate((text) => navigator.clipboard.writeText(text), text); },
  };
  await steps(d);
  const out = await result(page, base, seen);
  out.problems = page.problems;
  await page.close();
  return out;
}

for (const c of CASES) {
  test(c[0], async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const now = normalised(await run(NEW, c), { site: origin, translator: tr.origin });
    const was = record(FILE, 'cases', c[0]);
    assert.deepEqual(now, was);
  });
}

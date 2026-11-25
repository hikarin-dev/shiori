// library-edits.browser.mjs — a card's delete and export buttons, its tags' Shift-click and the
// tag editor on /library, held to what 1.3's page gave driven alike (library-drive.mjs): for each
// press in each case (plain, Shift; a gallery, a series merged and unmerged, its chapter, a linked one
// of each, one whose delete the library refuses), what is said to whatever runs things (type and
// fields, in order), each dialog's words and buttons, each answer's outcome, the files saved, and what
// the library holds after. Any difference from 1.3's fails.
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the library's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { startTranslator } from './stand-in-translator.mjs';
import { openRun, result, press, readDialog, answer, nextBase, choose, publish, sleep, PARTS } from './library-drive.mjs';
import { record, normalised } from './records.mjs';

const NEW = '/library';
const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser, tr;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  tr = await startTranslator();
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); await tr?.close(); });

// In the page: the galleries `ids` read as linked ones (files the app did not make, in a library
// folder), and the page told to read what it shows again.
async function linked(page, ids) {
  await page.evaluate(async (ids) => {
    const api = await import('/app/js/api.js');
    const platform = await import('/app/js/platform.js');
    const mark = (g) => (g && ids.includes(String(g.id)) ? { ...g, linked: { kind: 'folder', path: 'Shelf' } } : g);
    for (const name of ['page', 'byIds', 'get']) {
      const read = api.galleries[name];
      api.galleries[name] = async (...args) => { const out = await read(...args); return Array.isArray(out) ? out.map(mark) : mark(out); };
    }
    platform.feed.publish({ gid: '*', context: 'by-hand', n: 1, at: Date.now() });
  }, ids);
  await sleep(1500);
}

// A press on the text of something in the dialog (an option, a tick).
async function pressText(page, selector, text) {
  const el = await page.evaluateHandle(([selector, text]) => [...document.querySelectorAll(selector)].find((e) => e.textContent.includes(text)), [selector, text]);
  await el.click();
  await sleep(150);
}

// The tag editor showing: its title, the type chosen, its value's label and field, its buttons.
async function readEditor(page) {
  await page.waitForFunction(() => { const box = document.getElementById('tagEdType')?.closest('.modal-box, [data-slot="dialog"]'); return box && box.getBoundingClientRect().height > 0; }, { timeout: 3000 });
  await sleep(250);
  return page.evaluate(() => {
    const box = document.getElementById('tagEdType').closest('.modal-box, [data-slot="dialog"]');
    const type = document.getElementById('tagEdType');
    const pick = document.getElementById('tagEdPick');
    const shown = (el) => !!el && el.getClientRects().length > 0;
    return {
      title: box.querySelector('.modal-title, [data-slot="dialog-title"]').textContent,
      labels: [...box.querySelectorAll('.modal-label, [data-slot="eyebrow"]')].map((l) => l.textContent),
      type: type instanceof HTMLSelectElement ? type.selectedOptions[0].textContent : type.textContent.trim(),
      value: shown(document.getElementById('tagEdValue')) ? { typed: document.getElementById('tagEdValue').value, placeholder: document.getElementById('tagEdValue').placeholder } : null,
      pick: shown(pick) ? (pick instanceof HTMLSelectElement ? pick.selectedOptions[0]?.textContent : pick.textContent.trim()) : null,
      buttons: [...box.querySelectorAll('.modal-actions button, [data-slot="dialog-footer"] button')].filter(shown).map((b) => b.textContent),
      focus: document.activeElement?.id || null,
    };
  });
}
// The editor's suggestions showing: their names.
const suggestions = (page) => page.evaluate(() => [...document.querySelectorAll('#tagEdList.open .tag-ed-opt-name, [data-slot="listbox"] [data-slot="listbox-option"] > span:first-child')].map((s) => s.textContent));
const editorOpen = (page) => page.evaluate(() => { const box = document.getElementById('tagEdType')?.closest('.modal-overlay.show, [data-slot="dialog"]'); return !!box; });

const CASES = [
  ['delete: asked, Escape', {}, async (d) => { await d.press('P', 'del'); await d.dialog(); await d.answer('escape'); await sleep(400); }],
  ['delete: asked, Cancel', {}, async (d) => { await d.press('P', 'del'); await d.dialog(); await d.answer('cancel'); await sleep(400); }],
  ['delete: asked, OK', {}, async (d) => { await d.press('P', 'del'); await d.dialog(); await d.answer('ok'); await sleep(1200); }],
  ['Shift on delete: no question', {}, async (d) => { await d.press('P', 'del', { shift: true }); await d.dialog(800); await sleep(1200); }],
  ['delete a merged series: asked, OK', {}, async (d) => { await d.press('S', 'del'); await d.dialog(); await d.answer('ok'); await sleep(1500); }],
  ['Shift on delete, a merged series: no question', {}, async (d) => { await d.press('S', 'del', { shift: true }); await d.dialog(800); await sleep(1500); }],
  ['delete a chapter, unmerged: asked, OK', { merge: false }, async (d) => { await d.press('S2', 'del'); await d.dialog(); await d.answer('ok'); await sleep(1500); }],
  ['delete a series\' owner, unmerged: asked, OK', { merge: false }, async (d) => { await d.press('S', 'del'); await d.dialog(); await d.answer('ok'); await sleep(1500); }],
  ['delete a linked gallery: its words, Cancel', {}, async (d) => { await linked(d.page, [d.id('P')]); await d.press('P', 'del'); await d.dialog(); await d.answer('cancel'); }],
  ['delete a linked series: its words, Cancel', {}, async (d) => { await linked(d.page, [d.id('S')]); await d.press('S', 'del'); await d.dialog(); await d.answer('cancel'); }],
  ['delete refused by its folder: told so', {}, async (d) => {
    await d.page.evaluate((id) => { window.__refuse = [id]; }, d.id('P'));
    await d.press('P', 'del'); await d.dialog(); await d.answer('ok'); await d.dialog(); await d.answer('ok'); await sleep(600);
  }],
  ['Shift on a tag: asked, OK', {}, async (d) => { await d.press('P', '.card-tag[data-original="alpha"]', { shift: true }); await d.dialog(); await d.answer('ok'); await sleep(900); }],
  ['Shift on a tag: asked, Cancel', {}, async (d) => { await d.press('P', '.card-tag[data-original="beta"]', { shift: true }); await d.dialog(); await d.answer('cancel'); await sleep(500); }],
  ['Shift on a language flag: asked, OK', {}, async (d) => { await d.press('P', '.card-tag-flag[data-lang-code="ja"]', { shift: true }); await d.dialog(); await d.answer('ok'); await sleep(900); }],
  ['+: the editor, a tag typed, Enter', {}, async (d) => {
    await d.press('P', 'add'); d.seen.push({ editor: await readEditor(d.page) });
    await d.page.type('#tagEdValue', 'gamma'); await d.page.keyboard.press('Enter'); await sleep(900);
    d.seen.push({ open: await editorOpen(d.page) });
  }],
  ['+: a category picked, Add', {}, async (d) => {
    await d.press('P', 'add'); await readEditor(d.page);
    await choose(d.page, 'tagEdType', 'Category'); await sleep(200); d.seen.push({ editor: await readEditor(d.page) });
    await choose(d.page, 'tagEdPick', 'doujinshi'); await d.page.click('#tagEdOk'); await sleep(900);
  }],
  ['+: the suggestions, an arrow, Enter twice', {}, async (d) => {
    await d.press('N', 'add'); await readEditor(d.page);
    await d.page.type('#tagEdValue', 'a'); await sleep(500);
    d.seen.push({ suggested: await suggestions(d.page) });
    await d.page.keyboard.press('ArrowDown'); await d.page.keyboard.press('Enter'); await sleep(200);
    d.seen.push({ editor: await readEditor(d.page), suggested: await suggestions(d.page) });
    await d.page.keyboard.press('Enter'); await sleep(900);
  }],
  ['+: Escape closes the list, then the editor', {}, async (d) => {
    await d.press('N', 'add'); await readEditor(d.page);
    await d.page.type('#tagEdValue', 'a'); await sleep(500);
    await d.page.keyboard.press('Escape'); await sleep(200);
    d.seen.push({ suggested: await suggestions(d.page), open: await editorOpen(d.page) });
    await d.page.keyboard.press('Escape'); await sleep(400);
    d.seen.push({ open: await editorOpen(d.page) });
  }],
  ['+: Add with nothing typed', {}, async (d) => { await d.press('N', 'add'); await readEditor(d.page); await d.page.click('#tagEdOk'); await sleep(400); d.seen.push({ editor: await readEditor(d.page) }); }],
  ['export: the choice, Cancel', {}, async (d) => { await d.press('P', 'export'); await d.dialog(); await d.answer('cancel'); await sleep(400); }],
  ['export: the choice, OK', {}, async (d) => { await d.press('P', 'export'); await d.dialog(); await d.answer('ok'); await d.saved(1); }],
  ['export: CBZ without translations, remembered', {}, async (d) => {
    await d.press('P', 'export'); await d.dialog();
    await pressText(d.page, '.notice-option, label[data-slot="option-card"]', 'CBZ');
    await pressText(d.page, '.notice-check, [data-notice="dialog"] label', 'Include translations');
    await pressText(d.page, '.notice-check, [data-notice="dialog"] label', 'Remember');
    await d.dialog(); await d.answer('ok'); await d.saved(1);
    d.seen.push({ kept: await d.page.evaluate(() => [localStorage.getItem('shiori:libExportFormat'), localStorage.getItem('shiori:libExportTranslations')]) });
  }],
  ['export with a format kept: no question', { storage: { 'shiori:libExportFormat': 'cbz' } }, async (d) => { await d.press('P', 'export'); await d.dialog(800); await d.saved(1); }],
  ['Shift on export: the metadata', {}, async (d) => { await d.press('P', 'export', { shift: true }); await d.saved(1); }],
  ['Shift on export, a merged series: its metadata', {}, async (d) => { await d.press('S', 'export', { shift: true }); await d.saved(1); }],
  ['export fails: told so', { storage: { 'shiori:libExportFormat': 'zip' } }, async (d) => {
    await d.page.evaluate(async () => { const api = await import('/app/js/api.js'); api.transfer.read = async () => { throw new Error('the disk said no'); }; });
    await d.press('P', 'export'); await d.dialog(); await d.answer('ok'); await sleep(300);
    d.seen.push({ button: await d.page.evaluate((sel) => document.querySelector(sel).disabled, `#grid > .card[data-gallery-id="${d.id('P')}"] .card-btn-export`) });
  }],
  // Each button is held by itself: an export under way (here, its question still open) keeps its
  // button off and "…" whatever its gallery's jobs say meanwhile, until it ends.
  ['export under way: its button held while a job\'s news comes, until it ends', {}, async (d) => {
    const button = () => d.page.evaluate((sel) => { const b = document.querySelector(sel); return [b.disabled, b.textContent.trim()]; }, `#grid > .card[data-gallery-id="${d.id('P')}"] .card-btn-export`);
    await d.press('P', 'export'); await d.dialog();
    d.seen.push({ asked: await button() });
    await publish(d.page, { gid: d.id('P'), kind: 'translate', status: 'progress', done: 1, total: 2 }); await sleep(300);
    d.seen.push({ 'a word': await button() });
    await publish(d.page, { gid: d.id('P'), kind: 'translate', status: 'done', done: 2, total: 2 }); await sleep(300);
    d.seen.push({ 'its last word': await button() });
    await d.answer('cancel'); await sleep(400);
    d.seen.push({ ended: await button() });
  }],
];

async function run(path, [, opts, steps]) {
  const base = nextBase(1790003000000);
  const page = await openRun(browser, origin, path, { base, translator: tr.origin, ...opts });
  const seen = [];
  const d = {
    page, base, seen,
    id: (part) => String(base + PARTS[part]),
    press: (part, what, mods) => press(page, base, part, what, mods),
    dialog: async (wait) => { const shown = await readDialog(page, wait); seen.push(shown); return shown; },
    answer: (how) => answer(page, how),
    saved: (n) => until(page, (n) => window.__saved.length >= n, n, { what: 'the file saved' }),
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

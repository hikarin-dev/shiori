// overview-edit.browser.mjs — edit mode on the overview at /overview-next, held to what 1.3's page
// (/overview) gave driven alike: every way into and out of it, every way a title is
// saved and is not (the series', a gallery's own, a chapter's; typed, emptied, the same text again; left
// by a press elsewhere or by Done), the tags (a tag and the category pressed: the tag editor on it, its
// value changed, Remove; Shift: its question, OK and Cancel; "+": a tag added), and the counts after.
// What is said, each dialog and editor, what the page shows after and what the library holds. Enter and
// Escape in a title are §5.3 F40: held by their own test. Then the case that made 1.3 hold its whole page
// back after a save (_suppressRenderUntil): a title saved while a change of the same gallery arrives is
// never drawn back to the old one.
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the overview's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { readDialog, answer, typeInto } from './library-drive.mjs';
import { record as kept } from './records.mjs';
import { openRun, nextBase, gid, visit, read, named, sleep, record, outcome, rowSel, NEW } from './overview-drive.mjs';

const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

// The tag editor showing: its title, the type chosen (and whether it can change), its value, its buttons.
async function readEditor(page) {
  await page.waitForFunction(() => { const box = document.getElementById('tagEdType')?.closest('.modal-box, [data-slot="dialog"]'); return box && box.getBoundingClientRect().height > 0; }, { timeout: 3000 });
  await sleep(300);
  return page.evaluate(() => {
    const box = document.getElementById('tagEdType').closest('.modal-box, [data-slot="dialog"]');
    const type = document.getElementById('tagEdType');
    const pick = document.getElementById('tagEdPick');
    const shown = (el) => !!el && el.getClientRects().length > 0;
    return {
      title: box.querySelector('.modal-title, [data-slot="dialog-title"]').textContent,
      type: type instanceof HTMLSelectElement ? type.selectedOptions[0].textContent : type.textContent.trim(),
      typeOff: type.disabled || type.hasAttribute('data-disabled'),
      value: shown(document.getElementById('tagEdValue')) ? document.getElementById('tagEdValue').value : null,
      pick: shown(pick) ? (pick instanceof HTMLSelectElement ? pick.selectedOptions[0]?.textContent : pick.textContent.trim()) : null,
      buttons: [...box.querySelectorAll('.modal-actions button, [data-slot="dialog-footer"] button')].filter(shown).map((b) => b.textContent),
      focus: document.activeElement?.id || null,
    };
  });
}
const editorGone = (page) => page.waitForFunction(() => !document.getElementById('tagEdType')?.closest('.modal-overlay.show, [data-slot="dialog"]'), { timeout: 3000 }).catch(() => {});

// A title box emptied and `text` typed in (none: emptied).
async function typeTitle(page, sel, text) {
  await page.click(sel, { clickCount: 1 });
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  if (text) await page.keyboard.type(text);
}
const SERIES_TITLE = '#seriesTitle';
const chapterTitle = (base, part) => `${rowSel(base, part)} .ch-title-input, ${rowSel(base, part)} [data-slot="inline-edit"]`;
// A press somewhere that holds nothing (the details' line), which leaves a title box.
const elsewhere = (page) => page.mouse.click(900, 40);

const CASES = [
  ['into edit mode and out', {}, async (d) => { await d.edit(); await d.look(); await d.edit(); }],
  ['the series\' title: typed, a press elsewhere', {}, async (d) => { await d.edit(); await typeTitle(d.page, SERIES_TITLE, 'A new name'); await elsewhere(d.page); await sleep(800); await d.edit(); }],
  ['the series\' title: typed, then Done', {}, async (d) => { await d.edit(); await typeTitle(d.page, SERIES_TITLE, 'Done name'); await d.edit(); await sleep(800); }],
  ['the series\' title: emptied (its gallery\'s shows)', {}, async (d) => { await d.edit(); await typeTitle(d.page, SERIES_TITLE, ''); await d.edit(); await sleep(800); }],
  ['the series\' title: the same text again, nothing saved', {}, async (d) => { await d.edit(); await typeTitle(d.page, SERIES_TITLE, 'S series'); await d.edit(); await sleep(600); }],
  ['a gallery\'s own title: typed, Done', { part: 'G' }, async (d) => { await d.edit(); await typeTitle(d.page, '#galleryTitle', 'G renamed'); await d.edit(); await sleep(800); }],
  ['a chapter\'s title: typed, a press elsewhere', {}, async (d) => { await d.edit(); await typeTitle(d.page, chapterTitle(d.base, 'S3'), 'An extra'); await elsewhere(d.page); await sleep(800); await d.edit(); await sleep(300); }],
  ['a chapter\'s title: emptied (its gallery\'s shows)', {}, async (d) => { await d.edit(); await typeTitle(d.page, chapterTitle(d.base, 'S2'), ''); await d.edit(); await sleep(800); }],
  ['a chapter\'s title: typed, then Done', {}, async (d) => { await d.edit(); await typeTitle(d.page, chapterTitle(d.base, 'S'), 'The first'); await d.edit(); await sleep(800); }],
  ['edit mode closes a row\'s pages', {}, async (d) => {
    await d.page.hover(`${rowSel(d.base, 'S2')} .ch-main`); await d.page.click(`${rowSel(d.base, 'S2')} [data-expand]`); await sleep(400);
    await d.edit(); await d.look(); await d.edit(); await d.look();
  }],
  ['a tag pressed: the tag editor on it, Cancel', {}, async (d) => { await d.edit(); await d.page.click('.ov-chip[data-type="tag"][data-name="alpha"]'); d.seen.push({ editor: await readEditor(d.page) }); await d.page.click('#tagEdCancel'); await editorGone(d.page); }],
  ['a tag pressed: its value changed, Save', {}, async (d) => {
    await d.edit(); await d.page.click('.ov-chip[data-type="tag"][data-name="alpha"]'); d.seen.push({ editor: await readEditor(d.page) });
    await d.page.focus('#tagEdValue'); await d.page.keyboard.down('Control'); await d.page.keyboard.press('a'); await d.page.keyboard.up('Control'); await d.page.keyboard.type('alphabet');
    await d.page.click('#tagEdOk'); await editorGone(d.page); await sleep(1200);
  }],
  ['a tag pressed: Remove', {}, async (d) => { await d.edit(); await d.page.click('.ov-chip[data-type="tag"][data-name="beta"]'); d.seen.push({ editor: await readEditor(d.page) }); await d.page.click('#tagEdRemove'); await editorGone(d.page); await sleep(1200); }],
  ['Shift on a tag: asked, OK', {}, async (d) => {
    await d.edit(); await d.page.keyboard.down('Shift'); await d.page.click('.ov-chip[data-type="artist"]'); await d.page.keyboard.up('Shift');
    await d.dialog(); await d.answer('ok'); await sleep(1200);
  }],
  ['Shift on a tag: asked, Cancel', {}, async (d) => {
    await d.edit(); await d.page.keyboard.down('Shift'); await d.page.click('.ov-chip[data-type="tag:female"]'); await d.page.keyboard.up('Shift');
    await d.dialog(); await d.answer('cancel'); await sleep(400);
  }],
  ['the category pressed: the tag editor on it, Cancel', {}, async (d) => { await d.edit(); await d.page.click('.ov-meta-item[data-tag-type="category"]'); d.seen.push({ editor: await readEditor(d.page) }); await d.page.keyboard.press('Escape'); await editorGone(d.page); }],
  ['Shift on the rating: asked, OK', {}, async (d) => {
    await d.edit(); await d.page.keyboard.down('Shift'); await d.page.click('.ov-meta-item[data-tag-type="rating"]'); await d.page.keyboard.up('Shift');
    await d.dialog(); await d.answer('ok'); await sleep(1200);
  }],
  ['"+": a tag added, the counts after', {}, async (d) => {
    await d.edit(); await d.page.click('.ov-chip-add'); d.seen.push({ editor: await readEditor(d.page) });
    await d.page.type('#tagEdValue', 'gamma'); await sleep(200);
    await d.page.click('#tagEdOk'); await editorGone(d.page); await sleep(1500); await d.edit();
  }],
  // A gallery whose record has no tags at all (one read from a folder): shown (it stayed "Loading…" on
  // the new page until 7b), "+" alone in edit mode, its first tag added.
  ['a gallery with no tags at all: "+" adds its first', { part: 'N', prep: async (id) => {
    const api = await import('/app/js/api.js');
    const c = new OffscreenCanvas(30, 43); c.getContext('2d').fillRect(0, 0, 30, 43);
    await api.meta.put({ galleryId: id, title: { english: 'No tags', japanese: '', pretty: '' }, numPages: 1 });
    await api.pages.put(id, 1, await c.convertToBlob({ type: 'image/png' }));
  } }, async (d) => {
    await d.look(); await d.edit(); await d.look();
    await d.page.click('.ov-chip-add'); d.seen.push({ editor: await readEditor(d.page) });
    await d.page.type('#tagEdValue', 'first'); await sleep(200);
    await d.page.click('#tagEdOk'); await editorGone(d.page); await sleep(1500); await d.edit();
  }],
  ['outside edit mode a tag is a link, and Shift does nothing to it', {}, async (d) => {
    d.seen.push({ href: await d.page.evaluate(() => new URL(document.querySelector('.ov-chip[data-type="tag"]').href).href.replace(location.origin, '')) });
    await d.page.keyboard.down('Shift'); await d.page.hover('.ov-chip[data-type="tag"]'); await sleep(300);
    d.seen.push({ shiftLook: await d.page.evaluate(() => getComputedStyle(document.querySelector('.ov-chip[data-type="tag"]')).color) });
    await d.page.keyboard.up('Shift');
  }],
];

async function run(path, [, opts, steps]) {
  const base = nextBase(1790011000000);
  // A library of its own (the tags' counts are the whole library's).
  const context = await browser.createBrowserContext();
  const page = await openRun(context, origin, base);
  await page.setViewport({ width: 1280, height: 1000 });
  if (opts.prep) await page.evaluate(opts.prep, gid(base, opts.part));
  await visit(page, origin, path, gid(base, opts.part ?? 'S'));
  await page.evaluate(record);
  const seen = [];
  const looks = [];
  const look = async () => {
    const r = await page.evaluate(read);
    looks.push({ title: [r.hero.title, r.hero.readOnly], rows: r.rows.map((x) => [x.title, x.placeholder, x.readOnly, x.state.join(' '), x.expand?.expanded ?? null]),
      editing: await page.evaluate(() => document.getElementById('ovContent').classList.contains('ov-editing')),
      expandShown: await page.evaluate(() => [...document.querySelectorAll('[data-expand]')].map((b) => getComputedStyle(b).display !== 'none')),
      edit: r.hero.actions.find((a) => a.id === 'editToggle') });
  };
  const d = {
    page, base, seen, look,
    edit: async () => { await page.click('#editToggle'); await sleep(400); },
    dialog: async (wait) => { const shown = await readDialog(page, wait); seen.push(shown); return shown; },
    answer: (how) => answer(page, how),
  };
  await steps(d);
  await sleep(300);
  const r = await page.evaluate(read);
  const out = named({ ...(await outcome(page, base)), dialogs: seen, looks,
    shown: { title: r.hero.title, subtitle: r.hero.subtitle, rows: r.rows.map((x) => `${x.num} ${x.title} ${x.titleLabel}`), tags: r.hero.tags,
      // (Not the size and the typical page, which the library measures by itself after a run is made, in
      // whichever page is open: a page's own edit reads them again at another moment than 1.3's.)
      meta: r.hero.meta.flat().map((m) => m.text).filter((text) => !/^[\d.]+\s?[KMG]?B$|^\d+×\d+$/.test(text)) } }, base);
  out.problems = page.problems;
  await context.close();
  return out;
}

for (const c of CASES) {
  test(c[0], async (t) => {
    if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
    const now = await run(NEW, c);
    const was = kept(FILE, 'cases', c[0]);
    assert.deepEqual(now, was);
  });
}

// §5.3 F40: Enter saves a title (1.3's series title took a line break, its chapter title nothing) and
// Escape puts the saved text back (1.3: nothing; the typed text was then saved as the box was left).
test('F40: Enter saves a title, Escape puts the saved one back (the new page alone)', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const base = nextBase(1790011000000);
  const page = await openRun(browser, origin, base);
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.click('#editToggle');
  await typeTitle(page, SERIES_TITLE, 'Entered');
  await page.keyboard.press('Enter');
  await until(page, async (id) => (await (await import('/app/js/api.js')).meta.get(id))?.seriesTitle?.english === 'Entered', gid(base, 'S'), { what: 'the title saved on Enter' });
  assert.equal(await page.$eval(SERIES_TITLE, (el) => el.value), 'Entered');
  await typeTitle(page, chapterTitle(base, 'S2'), 'Not kept');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval(chapterTitle(base, 'S2'), (el) => el.value), 'The second');
  await elsewhere(page);
  await sleep(800);
  const chapters = (await page.evaluate(async (id) => (await (await import('/app/js/api.js')).meta.get(id)).chapters, gid(base, 'S'))).map((c) => c.title);
  assert.equal(chapters[1], 'The second');
  assert.deepEqual(page.problems, []);
  await page.close();
});

// 1.3 held its page back for 500 ms after a title was saved (_suppressRenderUntil): a change of the same
// gallery arriving meanwhile drew the page from a read begun before the save, the old title back in the
// box. Here the save is drawn at once and held over any read begun before the library has it: the box
// and the heading never show the old title again, while the owner changes in another context.
test('a title saved while the same gallery changes elsewhere never shows the old one again', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const base = nextBase(1790011000000);
  const page = await openRun(browser, origin, base);
  const other = await browser.newPage();
  await other.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.bringToFront();
  for (let round = 1; round <= 5; round++) {
    await page.click('#editToggle');
    const name = `Saved ${round}`;
    await typeTitle(page, SERIES_TITLE, name);
    await typeTitle(page, chapterTitle(base, 'S3'), `Extra ${round}`);
    // Every value the two boxes show from the save on, each frame.
    await page.evaluate((sel) => {
      // (For 2 s of the page's time, however many frames that is: under a whole suite's load a frame can
      // take a tenth of a second, and 120 of them did not come within 10 s.)
      window.__seen = []; window.__done = false;
      const t0 = performance.now();
      const tick = () => { const a = document.querySelector('#seriesTitle')?.value, b = document.querySelector(sel)?.value; window.__seen.push(`${a}|${b}`); if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else window.__done = true; };
      requestAnimationFrame(tick);
    }, chapterTitle(base, 'S3'));
    // The owner changed in another context while the saves are under way: a page of it read again,
    // and its favourite flipped, each a word of the change feed.
    await Promise.all([
      page.click('#editToggle'),
      other.evaluate(async (id) => { const api = await import('/app/js/api.js'); for (let i = 0; i < 6; i++) { await api.personal.favorite(id, i % 2 === 0); await new Promise((r) => setTimeout(r, 15)); } }, gid(base, 'S')),
    ]);
    await page.waitForFunction(() => window.__done, { timeout: 30000 });
    const seen = await page.evaluate(() => window.__seen);
    const first = seen.findIndex((v) => v === `${name}|Extra ${round}`);
    assert.ok(first >= 0, `round ${round}: the saved titles shown (${[...new Set(seen)].join(', ')})`);
    assert.deepEqual([...new Set(seen.slice(first))], [`${name}|Extra ${round}`], `round ${round}: never the old titles again`);
  }
  const meta = await page.evaluate(async (id) => (await (await import('/app/js/api.js')).meta.get(id)), gid(base, 'S'));
  assert.equal(meta.seriesTitle.english, 'Saved 5');
  assert.equal(meta.chapters[2].title, 'Extra 5');
  assert.deepEqual(page.problems, []);
  await other.close();
  await page.close();
});

// The address changing while in edit mode (another gallery's overview, then back): edit mode is off,
// as 1.3's page, loaded again, began; a title being typed is saved as its box is left by the press.
test('the address changing in edit mode: off for the next gallery and back (the new page alone)', async (t) => {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return; }
  const base = nextBase(1790011000000);
  const page = await openRun(browser, origin, base);
  await visit(page, origin, NEW, gid(base, 'S'));
  await page.click('#editToggle');
  await typeTitle(page, SERIES_TITLE, 'Left by a link');
  // A press on a link to another overview (the address changes in the page).
  await page.evaluate((g) => { const a = document.createElement('a'); a.href = `overview-next?g=${g}`; a.id = '__go'; a.textContent = 'go'; a.style.cssText = 'position:fixed;left:0;top:60px;z-index:99'; document.body.append(a); }, gid(base, 'G'));
  await page.click('#__go');
  await until(page, (g) => new URLSearchParams(location.search).get('g') === g && document.querySelector('#galleryTitle')?.value === 'G gallery', gid(base, 'G'), { what: 'the next gallery' });
  assert.equal(await page.evaluate(() => document.getElementById('ovContent').classList.contains('ov-editing')), false, 'edit mode off');
  assert.equal(await page.$eval('#galleryTitle', (el) => el.readOnly), true);
  await page.goBack();
  await until(page, () => document.querySelector('#seriesTitle')?.value === 'Left by a link', null, { what: 'the series again, its title saved' });
  assert.equal(await page.evaluate(() => document.getElementById('ovContent').classList.contains('ov-editing')), false, 'off coming back');
  assert.deepEqual(page.problems, []);
  await page.close();
});

// overview-keys.browser.mjs — the overview by the keyboard, the one page's (/overview) held to
// what 1.3's (/overview) gave driven alike over one seeded library (overview-drive.mjs; the translation
// server's stand-in answering, so a row has its translate button). The keys 1.3's
// overview answers: Tab through every control (the header's, the hero's, the tags, the view's tabs, each
// row's links and buttons, the add box); a row's buttons shown while focus came there by a key (1.3's
// key-focus) and not after a press; Enter and Space on the hero's buttons, a row's arrows and its pages'
// toggle, the view's tabs; Shift held under the pointer (the faces turn; let go, held again, the
// pointer gone) and with focus on a button (nothing turns: the faces are the pointer's); Escape closing
// the delete's question (as Cancel), the re-run menu (focus back on its button), the tag editor, and
// a drag (the order as it was); edit mode by keys (Tab between the title boxes, Enter saving one, Done);
// the add box (typed into, its list has no keys, Escape leaves it open, Tab leaves it). No page key
// beyond these: 1.3's overview has no scroll key and no F5 of its own.
// Differences named: the view's tabs are one Tab stop and the arrows move between them, as Settings'
// nav (F44's choice; 1.3: two stops, no arrows); a menu's arrows reach its disabled items (F39); Escape in
// a title box puts its saved words back (F40); in edit mode the category and rating among the details,
// which open the tag editor, are reached by Tab too (1.3: by the pointer alone).
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the overview's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { startTranslator } from './stand-in-translator.mjs';
import { record } from './records.mjs';
import { openRun, nextBase, gid, visit, named, rowSel, outcome, sleep, NEW } from './overview-drive.mjs';

const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser, tr;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  tr = await startTranslator();
});
after(async () => { await browser?.close(); server?.close(); await tr?.close(); });


// In the page: the focused element, named alike on both pages.
function focusName() {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  const row = el.closest('.ch-row')?.dataset.chapterId;
  const kind = ['up', 'down', 'download', 'translate', 'detach', 'remove', 'expand', 'view'].find((k) => el.hasAttribute(`data-${k}`));
  const text = (el.getAttribute('aria-label') || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  let name;
  if (el.matches('.ch-row input, .ch-row textarea')) name = 'row-title-box';
  else if (kind === 'view') name = `view:${el.dataset.view}`;
  else if (kind) name = `${kind}`;
  else if (el.id) name = `#${el.id}`;
  else if (el.matches('.ch-title-open')) name = 'title-link';
  else if (el.matches('.ch-thumb')) name = 'thumb';
  else if (el.matches('.ch-id')) name = 'id-link';
  else if (el.matches('.ch-grip')) name = 'grip';
  else if (el.matches('.series-title-open')) name = 'hero-title-link';
  else if (el.closest('.ov-chip, [data-slot="tag"]')) name = `tag:${text}`;
  else if (el.matches('.ch-row input, .ch-row textarea, .ch-row [data-slot="inline-edit"]')) name = 'row-title-box';
  else if (el.closest('header')) name = `header:${el.tagName.toLowerCase()}:${text}`;
  else name = `${el.tagName.toLowerCase()}.${[...el.classList][0] ?? ''}:${text}`;
  return row ? `${row} ${name}` : name;
}

// The face a row's button shows (its icon's first line), on either page.
function face(sel) {
  const b = document.querySelector(sel);
  if (!b) return null;
  const faces = [...b.querySelectorAll('.ch-face > *')];
  const shown = faces.length ? faces.find((f) => !/matrix\(1, 0, 0, 0/.test(getComputedStyle(f).transform)) : b;
  return shown?.querySelector('path, rect, circle, line')?.outerHTML.replace(/ class="[^"]*"/, '').slice(0, 60) ?? null;
}

const tipText = () => [...document.querySelectorAll('.shiori-tip')].filter((t) => getComputedStyle(t).display !== 'none' && getComputedStyle(t).opacity !== '0' && getComputedStyle(t).visibility !== 'hidden').map((t) => t.textContent.replace(/\s+/g, ' ').trim()).join(' | ');

async function tabOrder(page, max = 80) {
  const order = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const name = await page.evaluate(focusName);
    if (order.length && name === order[0]) break;
    order.push(name);
  }
  return order;
}

async function keyFacts(page, origin, path, base) {
  const r = {};
  const S2 = rowSel(base, 'S2'), S3 = rowSel(base, 'S3');
  const fresh = async () => { await visit(page, origin, path, gid(base, 'S')); await until(page, () => getComputedStyle(document.querySelector('.ch-row:not(.missing) [data-translate]')).display !== 'none', null, { what: 'the translation server' }); await page.mouse.move(1270, 890); };
  // 1. Tab's order from the top, and a row's buttons shown while focus came by a key.
  await fresh();
  r.order = await tabOrder(page);
  await fresh();
  for (let i = 0; i < 80; i++) { await page.keyboard.press('Tab'); if ((await page.evaluate(focusName)).endsWith(' up')) break; }
  r.keyFocus = await page.evaluate(() => { const box = document.activeElement.closest('.ch-actions'); return { cls: box.classList.contains('key-focus'), opacity: getComputedStyle(box).opacity, ring: document.activeElement.matches(':focus-visible') }; });
  // 2. A press, then the pointer away and a key: no ring, the row's buttons hidden again.
  await fresh();
  await page.hover(`${S2} .ch-main`); await sleep(100);
  await page.click(`${S2} [data-expand]`); await sleep(300);
  await page.mouse.move(1270, 890); await sleep(200);
  r.afterPress = await page.evaluate(() => ({ focused: !!document.activeElement.closest('.ch-row'), ring: document.querySelectorAll(':focus-visible').length }));
  await page.keyboard.press('a'); await sleep(100);
  r.afterPressKey = await page.evaluate(() => ({ ring: document.querySelectorAll(':focus-visible').length, keyFocus: document.querySelectorAll('.ch-actions.key-focus').length }));
  // 3. Enter and Space.
  await fresh();
  const focus = (sel) => page.$eval(sel, (el) => el.focus());
  await focus('#editToggle'); await page.keyboard.press('Enter'); await sleep(300);
  r.editByEnter = await page.evaluate(() => !!document.querySelector('#ovContent.ov-editing'));
  await focus('#editToggle'); await page.keyboard.press('Space'); await sleep(300);
  r.editOffBySpace = await page.evaluate(() => !document.querySelector('#ovContent.ov-editing'));
  await focus('#favToggle'); await page.keyboard.press('Space'); await sleep(400);
  r.favBySpace = await page.evaluate(() => document.getElementById('favToggle').classList.contains('on'));
  await focus('#favToggle'); await page.keyboard.press('Enter'); await sleep(400);
  r.favOffByEnter = await page.evaluate(() => !document.getElementById('favToggle').classList.contains('on'));
  await focus(`${S2} [data-expand]`); await page.keyboard.press('Enter'); await sleep(300);
  r.pagesByEnter = await page.evaluate((s) => document.querySelector(s).classList.contains('expanded'), S2);
  await focus(`${S2} [data-expand]`); await page.keyboard.press('Space'); await sleep(300);
  r.pagesOffBySpace = await page.evaluate((s) => !document.querySelector(s).classList.contains('expanded'), S2);
  await focus(`${S3} [data-up]`); await page.keyboard.press('Enter'); await sleep(600);
  r.upByEnter = { order: (await outcome(page, base)).series.S.chapters, focus: await page.evaluate(focusName) };
  await focus(`${S3} [data-down]`); await page.keyboard.press('Space'); await sleep(600);
  r.downBySpace = { order: (await outcome(page, base)).series.S.chapters, focus: await page.evaluate(focusName) };
  // The view's tabs: Enter on one, then the arrows.
  await focus('[data-view="volumes"]'); await page.keyboard.press('Enter'); await sleep(400);
  r.volumesByEnter = await page.evaluate(() => document.querySelectorAll('.ch-row').length);
  await focus('[data-view="volumes"]'); await page.keyboard.press('ArrowLeft'); await sleep(400);
  r.arrowLeft = { focus: await page.evaluate(focusName), rows: await page.evaluate(() => document.querySelectorAll('.ch-row').length) };
  await page.keyboard.press('Space'); await sleep(400);
  r.thenSpace = await page.evaluate(() => document.querySelectorAll('.ch-row').length);
  await page.evaluate(() => localStorage.removeItem('shiori:seriesView'));
  // 4. Shift's faces: under the pointer (held, let go, held again, the pointer away), and with focus by a key.
  await fresh();
  const del = `${S2} [data-remove]`;
  await page.hover(del); await sleep(300);
  const faces = [await page.evaluate(face, del)];
  for (const step of ['down', 'up', 'down']) { await page.keyboard[step]('Shift'); await sleep(350); faces.push(await page.evaluate(face, del), await page.evaluate(tipText)); }
  await page.mouse.move(1270, 890); await sleep(350); faces.push(await page.evaluate(face, del));
  await page.keyboard.up('Shift'); await sleep(350); faces.push(await page.evaluate(face, del));
  r.shiftUnderPointer = faces;
  await focus(del); await page.keyboard.down('Shift'); await sleep(350);
  r.shiftOnFocus = [await page.evaluate(face, del), await page.evaluate(tipText)];
  await page.keyboard.up('Shift'); await sleep(300);
  // 5. Escape: the delete's question, the re-run menu, the tag editor, a title box.
  await fresh();
  await page.hover(`${S2} .ch-main`); await page.click(del); await sleep(500);
  const open = () => page.evaluate(() => ({ dialog: !!document.querySelector('.notice-overlay, [data-notice="dialog"]'), menu: [...document.querySelectorAll('.rerun-menu')].some((m) => m.getClientRects().length), tags: !!document.querySelector('.modal-overlay.show #tagEdType, [data-slot="dialog"] #tagEdType') }));
  r.question = await open();
  await page.keyboard.press('Escape'); await sleep(400);
  r.questionEscape = { ...(await open()), kept: !!(await outcome(page, base)).galleries.S2 };
  await page.hover(`${S3} .ch-main`); await page.click(`${S3} [data-translate]`, { button: 'right' }); await sleep(500);
  r.menu = await open();
  await page.keyboard.press('ArrowDown'); await sleep(100);
  r.menuArrow = await page.evaluate(() => (document.activeElement?.textContent ?? '').replace(/\s+/g, ' ').trim());
  await page.keyboard.press('Escape'); await sleep(400);
  r.menuEscape = { ...(await open()), focus: await page.evaluate(focusName) };
  await page.$eval('#editToggle', (el) => el.click()); await sleep(300);
  await page.$eval('.ov-chip-add', (el) => el.click()); await until(page, () => !!document.getElementById('tagEdType'), null, { what: 'the tag editor' }); await sleep(300);
  await page.keyboard.press('Escape'); await sleep(400);
  r.tagsEscape = await open();
  // A title box: typed into, Escape, then left.
  await page.$eval(`${S2} input, ${S2} textarea`, (el) => el.focus());
  await page.keyboard.press('End'); await page.keyboard.type(' typed'); await page.keyboard.press('Escape'); await sleep(200);
  r.titleEscape = await page.evaluate((s) => document.querySelector(`${s} input, ${s} textarea`).value, S2);
  // 6. Edit mode by keys: Tab between the boxes, a title typed and Enter.
  await page.$eval('#seriesTitle', (el) => el.focus());
  const boxes = [];
  for (let i = 0; i < 12; i++) { boxes.push(await page.evaluate(focusName)); await page.keyboard.press('Tab'); }
  r.editTab = boxes;
  await page.$eval(`${S3} input, ${S3} textarea`, (el) => { el.focus(); el.select?.(); });
  await page.keyboard.type('Keyed title'); await page.keyboard.press('Enter'); await sleep(600);
  r.enterSaved = { focus: await page.evaluate(focusName), series: (await outcome(page, base)).series.S.chapters };
  await page.$eval('#editToggle', (el) => el.focus()); await page.keyboard.press('Enter'); await sleep(400);
  r.out = await page.evaluate(() => !document.querySelector('#ovContent.ov-editing'));
  // 7. The add box: typed into, then Escape, ArrowDown, Tab.
  await fresh();
  await page.click('#addSearch'); await page.keyboard.type('gallery'); await until(page, () => document.querySelectorAll('#addResults .add-res').length > 0, null, { what: 'the list' }); await sleep(200);
  const list = () => page.evaluate(() => { const l = document.getElementById('addResults'); return { open: !!l && l.getClientRects().length > 0 && getComputedStyle(l).display !== 'none', focus: document.activeElement?.id || document.activeElement?.className?.toString().slice(0, 20), sel: document.querySelectorAll('#addResults .sel, #addResults [data-highlighted], #addResults [aria-selected="true"]').length }; });
  r.addTyped = await list();
  await page.keyboard.press('ArrowDown'); await sleep(150);
  r.addArrow = await list();
  await page.keyboard.press('Escape'); await sleep(200);
  r.addEscape = await list();
  await page.keyboard.type('s'); await sleep(500);
  await page.keyboard.press('Tab'); await sleep(300);
  r.addTab = { ...(await list()), focus: await page.evaluate(focusName) };
  // 8. A drag, Escape.
  await fresh();
  await page.$eval(`${S2}`, (el) => el.scrollIntoView({ block: 'center' }));
  await page.hover(`${S2} .ch-main`);
  const g = await page.$eval(`${S2} .ch-grip`, (el) => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x, g.y + 60, { steps: 6 }); await sleep(200);
  await page.keyboard.press('Escape'); await sleep(400);
  await page.mouse.up(); await sleep(400);
  r.dragEscape = { dragging: await page.evaluate(() => !!document.querySelector('.ch-row.dragging, .ch-row[data-dragging]')), order: (await outcome(page, base)).series.S.chapters };
  return r;
}

async function facts(path) {
  const base = nextBase(1790009600000);
  const context = await browser.createBrowserContext();
  const page = await openRun(context, origin, base, { translator: tr.origin, storage: { 'shiori:translateSettings': { serverUrl: tr.origin } } });
  await page.setViewport({ width: 1280, height: 900 });
  const r = named(await keyFacts(page, origin, path, base), base);
  r.problems = page.problems;
  await context.close();
  return r;
}

test('the keyboard on the overview: every key 1.3\'s answers, as on 1.3\'s page but the differences named', { skip: !chromePath() }, async () => {
  const now = await facts(NEW);
  const was = record(FILE, 'keys');
  // The view's tabs: one Tab stop, the arrows moving between them (F44's choice).
  assert.deepEqual(now.order, was.order.filter((n) => n !== 'view:volumes'));
  assert.ok(was.order.includes('view:volumes'));
  assert.deepEqual([was.arrowLeft, was.thenSpace], [{ focus: 'view:volumes', rows: 2 }, 2]);
  assert.deepEqual([now.arrowLeft, now.thenSpace], [{ focus: 'view:chapters', rows: 2 }, 4]);
  // A menu's arrows reach its disabled items (F39): the re-run menu's steps are all off with nothing saved.
  assert.equal(was.menuArrow, '');
  assert.match(now.menuArrow, /^Text detection/);
  // Escape in a title box: the saved words back (F40); 1.3 kept the typed ones, saved as the box was left.
  assert.equal(was.titleEscape, 'The second typed');
  assert.equal(now.titleEscape, 'The second');
  const f40 = (list) => list.map((c) => (c === '<S2>:The second typed' ? '<S2>:The second' : c));
  assert.deepEqual(now.enterSaved, { ...was.enterSaved, series: f40(was.enterSaved.series) });
  assert.deepEqual(now.dragEscape, { ...was.dragEscape, order: f40(was.dragEscape.order) });
  // Edit mode: the category and the rating are reached by Tab too.
  assert.deepEqual(now.editTab.filter((n) => !['tag:manga', 'tag:safe'].includes(n)).slice(0, 10), was.editTab.slice(0, 10));
  assert.deepEqual(now.editTab.slice(5, 7), ['tag:manga', 'tag:safe']);
  // Everything else alike.
  const rest = (r) => { const { order, arrowLeft, thenSpace, menuArrow, titleEscape, enterSaved, dragEscape, editTab, ...others } = r; return others; };
  assert.deepEqual(rest(now), rest(was));
  // What each holds, on 1.3's page.
  assert.deepEqual(was.keyFocus, { cls: true, opacity: '1', ring: true });
  assert.deepEqual(was.afterPressKey, { ring: 1, keyFocus: 0 });
  assert.deepEqual([was.editByEnter, was.editOffBySpace, was.favBySpace, was.favOffByEnter, was.pagesByEnter, was.pagesOffBySpace], [true, true, true, true, true, true]);
  assert.deepEqual(was.shiftOnFocus[0], was.shiftUnderPointer[0], 'a focused button keeps its face under Shift');
  assert.notEqual(was.shiftUnderPointer[1], was.shiftUnderPointer[0], 'under the pointer the face turns');
  assert.deepEqual([was.question.dialog, was.questionEscape.dialog, was.questionEscape.kept], [true, false, true]);
  assert.deepEqual([was.menu.menu, was.menuEscape.menu, was.menuEscape.focus], [true, false, '<S3> translate']);
  assert.equal(was.tagsEscape.tags, false);
  assert.deepEqual([was.addTyped.open, was.addEscape.open, was.addTab.open, was.addTab.focus], [true, true, true, 'body']);
  assert.equal(was.dragEscape.dragging, false);
  assert.deepEqual(now.problems, []);
});

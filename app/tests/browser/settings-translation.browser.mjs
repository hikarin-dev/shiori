// settings-translation.browser.mjs — Settings → Translation as the one page draws it
// (src/routes/settings/translation.tsx, benchmark.tsx). Where 1.3's page was driven alike, what it gave
// is the record the page is held to (records/settings-translation.browser.mjs.<table>.json,
// records.mjs): 1.3's behaviour as measured on 2026-11-24, which a deliberate change edits in the same
// commit. Every server here is a stand-in on a port of its own (stand-in-translator.mjs); the harness
// refuses any other address, so nothing reaches a real translation server.
//
//   - One table of edits (the panel's fields, the pipeline, the language, every kind of option of the
//     advanced window, a preset, a reset): the text stored under translateSettings after each, and what
//     the status line says, as 1.3's page stored and said; and the stored forms read at load (an older
//     schema migrated once) as 1.3's page read them.
//   - The status badge through checking, online and offline; nothing contacted before a server is
//     configured (Check is a request: it asks); the benchmark only for a local server that answers.
//   - What depends on what: the pipeline and the window's engine, the language, a preset and the
//     options it fills, the batch caps, Reset without capabilities, the window's note, the fold.
//   - The window: focus, Escape, focus back, the fold kept on reopening, its box still under a slowed
//     CPU; the benchmark's run, Stop and report (and a comparison); a change of language; the phone
//     form; leaving the page five times with the window opened each time leaves nothing behind.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { startTranslator, CAPS } from './stand-in-translator.mjs';
import { record, normalised } from './records.mjs';

const NEW = '/settings';
const FILE = 'settings-translation.browser.mjs';

let server, origin, browser, tr, away, scratch;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  tr = await startTranslator();
  away = await startTranslator({ host: '127.0.0.2' }).catch(() => null);   // a server elsewhere (not this machine's name)
  browser = await launch();
  scratch = mkdtempSync(join(tmpdir(), 'shiori-tr-'));
});
after(async () => { await browser?.close(); server?.close(); await tr?.close(); await away?.close(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });

const skip = (t) => { if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return true; } return false; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The page at `path` with `storage` (raw localStorage values by key, set once before it loads),
// Translation shown.
async function open(t, path, { storage = {}, viewport, galleries = false } = {}) {
  const page = await openPage(browser, origin, { allow: [tr.origin, ...(away ? [away.origin] : [])] });
  t.after(() => page.close().catch(() => {}));
  if (viewport) await page.setViewport(viewport);
  if (galleries) {
    await page.goto(`${origin}/CHANGELOG.md`, { waitUntil: 'load' });
    await page.evaluate(async () => {
      const api = await import('/app/js/api.js');
      const png = async (hue) => { const c = new OffscreenCanvas(60, 90); const x = c.getContext('2d'); x.fillStyle = `hsl(${hue} 60% 50%)`; x.fillRect(0, 0, 60, 90); return c.convertToBlob({ type: 'image/png' }); };
      for (const [gid, name] of [['1790000000001', 'Alpha'], ['1790000000002', 'Beta']]) {
        await api.meta.put({ galleryId: gid, title: { english: name, japanese: '', pretty: '' }, tags: [], numPages: 3 });
        for (let n = 1; n <= 3; n++) await api.pages.put(gid, n, await png(n * 40));
      }
    });
    page.problems.length = 0;   // (the file seeded from has no icon of its own)
  }
  await page.evaluateOnNewDocument((storage) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    for (const key of Object.keys(localStorage)) if (key.startsWith('shiori:') || key === 'shiori-lang') localStorage.removeItem(key);
    for (const [key, raw] of Object.entries(storage)) localStorage.setItem(key, raw);
  }, storage);
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('navTranslation') && !!document.getElementById('translateSummary')?.textContent, null, { what: 'the Translation panel' });
  await page.click('#navTranslation');
  await until(page, () => document.getElementById('panelTranslation').classList.contains('active'), null, { what: 'Translation shown' });
  return page;
}
const configured = (url = tr.origin) => ({ 'shiori:translateSettings': JSON.stringify({ serverUrl: url }) });
const raw = (page) => page.evaluate(() => localStorage.getItem('shiori:translateSettings'));
const drawnCaps = (page) => until(page, () => !!document.getElementById('step-detect') && document.getElementById('translateStatusBadge').textContent !== '○ Checking…', null, { what: 'the capabilities drawn' });

// A control's value: a drawn select's (data-value), a native one's or a box's.
const value = (page, sel) => page.$eval(sel, (el) => (el.tagName === 'SELECT' ? el.value : el.dataset.value ?? el.value));
const exists = (page, sel) => page.evaluate((sel) => !!document.querySelector(sel), sel);

// Drives a select (1.3's <select>, or the drawn one: the option at `index`, the order both lists share).
async function choose(page, sel, json, index) {
  if (await page.$eval(sel, (el) => el.tagName === 'SELECT')) { await page.select(sel, json); return; }
  await page.click(sel).catch(async (e) => { throw new Error(`${e.message} ${await page.$eval(sel, (el) => JSON.stringify([el.getBoundingClientRect(), el.closest('[hidden]')?.id, document.activeElement?.id, innerHeight, scrollY]))}`); });
  await page.waitForSelector('[data-slot="select-list"][data-open] [data-slot="select-option"]');
  await pause(300);   // (a press in the list's first moments is not taken as a choice)
  // (The open list's: a select focused by the keyboard keeps a closed one mounted, with no box.)
  const options = await page.$$('[data-slot="select-list"][data-open] [data-slot="select-option"]');
  await options[index].click().catch(async (e) => { throw new Error(`${e.message} ${await page.evaluate(() => JSON.stringify([...document.querySelectorAll('[data-slot="select-list"] [data-slot="select-option"]')].map((o) => [o.textContent, o.getBoundingClientRect().y, o.getBoundingClientRect().height]).concat([[innerHeight, scrollY, document.querySelectorAll('[data-slot="select-list"]').length]])))}`); });
  await until(page, (sel) => !document.querySelector(sel).hasAttribute('data-popup-open') && !document.querySelector('[data-slot="select-list"][data-open]'), sel, { what: 'the list closed' });
}
// Types into a box and leaves it (Tab), as a person commits it.
async function type(page, sel, text, { leave = true } = {}) {
  await page.click(sel);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text);
  if (leave) await page.keyboard.press('Tab');
}
async function flip(page, id) {
  if (await exists(page, `label[for="${id}"]`)) await page.click(`label[for="${id}"]`);
  else await (await page.evaluateHandle((id) => document.getElementById(id).parentElement.querySelector('[role="switch"]'), id)).click();
}
async function tick(page, param) {
  if (await exists(page, `[data-slot="checkbox"][data-param="${param}"]`)) await page.click(`[data-slot="checkbox"][data-param="${param}"]`);
  else await page.click(`input[type="checkbox"][data-param="${param}"]`);
}
const modalOpen = () => !!document.querySelector('#translateBox[data-open]');
async function openWindow(page) {
  await page.click('#openTranslateModalBtn');
  await until(page, modalOpen, null, { what: 'the advanced window' });
  await pause(100);
}
async function fold(page, open) {
  const isOpen = () => page.$eval('#cfgAdvancedHeader', (h) => h.getAttribute('aria-expanded') === 'true');
  if (await isOpen() !== open) await page.click('#cfgAdvancedHeader');
  await until(page, (open) => (document.getElementById('cfgAdvancedHeader').getAttribute('aria-expanded') === 'true') === open, open, { what: 'the fold' });
}
// The danger-zone style question notice.js asks, answered with its button named `ok`.
async function answer(page, ok) {
  await until(page, (ok) => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ok && b.id !== 'resetTranslateBtn' && b.getClientRects().length), ok, { what: `the question's ${ok}` });
  await (await page.evaluateHandle((ok) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ok && b.id !== 'resetTranslateBtn' && b.getClientRects().length), ok)).click();
}
const status = (page, id) => page.$eval(`#${id}`, (el) => el.textContent.trim());

// Where a value sits in the server's list (both pages list choices in the server's order).
const stage = (id) => CAPS.stages.find((s) => s.id === id);
const implIndex = (id, value) => stage(id).implementations.findIndex((i) => i.id === value);
const paramIndex = (key, v) => CAPS.stages.flatMap((s) => s.params || []).find((p) => p.key === key).choices.findIndex((c) => c.value === v);
const langIndex = (v) => CAPS.languages.findIndex((l) => l.id === v);
const presetIndex = (v) => CAPS.presets.findIndex((p) => p.id === v);

// ── The stored settings, on both pages from one table ────────────────────────────────────────────
// Each edit: what to do, and the status line that says how it went.
const EDITS = [
  ['the server\'s address (a trailing slash)', 'translateServerStatus', (p) => type(p, '#translateServerInput', `${tr.origin}/`)],
  ['an address that is not a web address', 'translateServerStatus', (p) => type(p, '#translateServerInput', 'ftp://nope')],
  ['the address put right', 'translateServerStatus', (p) => type(p, '#translateServerInput', tr.origin)],
  ['the token', 'translateServerStatus', (p) => type(p, '#translateTokenInput', ' secret ')],
  ['Study data', 'translateStatus', (p) => choose(p, '#studyModeGeneration', 'text_and_image', 2)],
  ['save snapshots', 'translateStatus', (p) => flip(p, 'translateSaveSnapshots')],
  ['keep snapshots', 'translateStatus', (p) => flip(p, 'translateKeepSnapshots')],
  ['the pipeline\'s OCR step', 'translateStatus', (p) => choose(p, '#step-ocr', '"48px"', implIndex('ocr', '48px'))],
  ['the target language', 'translateStatus', (p) => choose(p, '#translateLanguage', '"JPN"', langIndex('JPN'))],
  ['the window: the engine', 'translateModalStatus', async (p) => { await openWindow(p); await choose(p, '[data-param="translator.translator"]:not(#step-translate)', '"gemini"', implIndex('translate', 'gemini')); }],
  ['a clearing preset', 'translateModalStatus', (p) => choose(p, '[data-preset]', '"fast"', presetIndex('fast'))],
  ['a tick', 'translateModalStatus', (p) => tick(p, 'translator.content_screen_enabled')],
  ['a screening model', 'translateModalStatus', (p) => choose(p, '[data-param="translator.content_screen_translator"]', '"qwen2"', paramIndex('translator.content_screen_translator', 'qwen2'))],
  ['the prompt (kept as typed)', 'translateModalStatus', (p) => type(p, '[data-param="translator.content_screen_prompt"]', '  my prompt  ')],
  ['a number (the fold opened)', 'translateModalStatus', async (p) => { await fold(p, true); await type(p, '[data-param="detector.text_threshold"]', '0.35'); }],
  ['a whole number', 'translateModalStatus', (p) => type(p, '[data-param="kernel_size"]', '9.7')],
  ['a number left empty', 'translateModalStatus', (p) => type(p, '[data-param="detector.box_threshold"]', '')],
  ['a text option (trimmed)', 'translateModalStatus', (p) => type(p, '[data-param="render.font_color"]', '  #fff  ')],
  ['a stage\'s model in the fold', 'translateModalStatus', (p) => choose(p, '[data-param="render.renderer"]:not(#step-render)', '"manga2eng"', implIndex('render', 'manga2eng'))],
  ['an option of a list in the fold', 'translateModalStatus', (p) => choose(p, '[data-param="detector.detection_size"]', '1024', paramIndex('detector.detection_size', 1024))],
  ['a batch cap', 'translateModalStatus', (p) => type(p, '[data-batch="gemini"]', '4')],
  ['a batch cap that is not a number', 'translateModalStatus', (p) => type(p, '[data-batch="chatgpt"]', 'x')],
  ['a price', 'translateModalStatus', (p) => type(p, '#cfgPriceIn', '2.5')],
  ['reset, cancelled', 'translateModalStatus', async (p) => { await p.click('#resetTranslateBtn'); await answer(p, 'Cancel'); await pause(200); }],
  ['reset', 'translateModalStatus', async (p) => { await p.click('#resetTranslateBtn'); await answer(p, 'Reset'); }],
];

async function drive(t, path) {
  const page = await open(t, path, { storage: configured() });
  await drawnCaps(page);
  const seen = [[ 'load', await raw(page), '' ]];
  for (const [name, statusId, edit] of EDITS) {
    const before = await raw(page);
    try { await edit(page); } catch (e) { throw new Error(`${path}: ${name}: ${e.message}`); }
    await pause(150);
    const after = await raw(page);
    const said = after !== before || name.includes('not a web') || name.includes('cancelled') ? await status(page, statusId) : '';
    seen.push([name, after, said]);
    if (name.startsWith('the address put right')) await drawnCaps(page);   // (its capabilities asked again)
  }
  assert.deepEqual(page.problems, [], path);
  return seen;
}

test('the stored settings: every edit stores the text 1.3\'s page stored, and says what it said', async (t) => {
  if (skip(t)) return;
  const now = normalised(await drive(t, NEW), { translator: tr.origin });
  const was = record(FILE, 'stored');
  assert.equal(now.length, was.length);
  for (let i = 0; i < was.length; i++) assert.deepEqual(now[i], was[i], `after ${was[i][0]}`);
  // What the edits came to (the table's own check that each did something).
  const stored = (i) => JSON.parse(was[i][1]);
  assert.equal(stored(1).serverUrl, '<translator>', 'the trailing slash left off');
  assert.equal(was[2][2], 'Server URL must start with http:// or https://');
  assert.equal(stored(4).serverToken, 'secret');
  assert.equal(stored(14).params['translator.content_screen_prompt'], '  my prompt  ');
  assert.equal(stored(17).params.kernel_size, 9);
  assert.equal(stored(19).params['render.font_color'], '#fff');
  assert.equal(stored(21).batchCaps.gemini, 4);
  assert.deepEqual(stored(was.length - 1).params, {});
  assert.equal(was.at(-2)[1], was.at(-3)[1], 'a reset cancelled stores nothing');
});

test('a box stores nothing until it is left: typing alone changes nothing', async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { storage: configured() });
  await drawnCaps(page);
  await openWindow(page);
  await fold(page, true);
  const before = await raw(page);
  await type(page, '[data-param="render.font_color"]', '#abc', { leave: false });
  await pause(300);
  assert.equal(await raw(page), before, 'not while typing');
  await page.keyboard.press('Enter');
  await until(page, () => JSON.parse(localStorage.getItem('shiori:translateSettings') || '{}').params?.['render.font_color'] === '#abc', null, { what: 'stored on Enter' });
});

test('what is read at load: each stored form shows and stores as 1.3\'s page shows and stores it (an older schema migrated once)', async (t) => {
  if (skip(t)) return;
  const FORMS = [
    null,
    JSON.stringify({ translator: 'chatgpt', targetLang: 'JPN', screenEnabled: true, serverToken: 'tok', studyModeGeneration: 'text_and_image' }),
    JSON.stringify({ schema: 2, params: { 'ocr.ocr': '48px' }, saveSnapshots: true }),
    JSON.stringify({ schema: 3, params: {}, studyModeGeneration: 'sideways', keepSnapshotsOnRevert: true }),
  ];
  const seen = [];
  for (const form of FORMS) {
    const page = await open(t, NEW, { storage: form ? { 'shiori:translateSettings': form } : {} });
    await pause(400);
    seen.push({ stored: await raw(page), server: await value(page, '#translateServerInput'), token: await value(page, '#translateTokenInput'),
      study: await value(page, '#studyModeGeneration'),
      snapshots: await page.$eval('#translateSaveSnapshots', (el) => el.checked), keep: await page.$eval('#translateKeepSnapshots', (el) => el.checked),
      refused: page.refused.length });
    assert.deepEqual(page.problems, []);
  }
  const now = normalised(seen, { translator: tr.origin });
  const was = record(FILE, 'load-forms');
  for (let i = 0; i < FORMS.length; i++) {
    assert.deepEqual(now[i], was[i], `stored: ${FORMS[i]}`);
    assert.equal(was[i].refused, 0, 'nothing asked of any server');
  }
});

// ── The server's status ─────────────────────────────────────────────────────────────────────────
test(`the status badge through checking, online and offline`, async (t) => {
  if (skip(t)) return;
  tr.state.delay = 600;
  t.after(() => { tr.state.delay = 0; tr.state.online = true; });
  const page = await open(t, NEW, { storage: configured() });
  const look = () => page.evaluate(() => ({ text: document.getElementById('translateStatusBadge').textContent, busy: document.getElementById('checkTranslateBtn').getAttribute('aria-busy') }));
  assert.deepEqual(await until(page, () => document.getElementById('translateStatusBadge').textContent === '○ Checking…' && { text: '○ Checking…', busy: document.getElementById('checkTranslateBtn').getAttribute('aria-busy') }, null, { what: 'checking' }),
    { text: '○ Checking…', busy: 'true' });
  await until(page, () => document.getElementById('translateStatusBadge').textContent === '● Server online', null, { what: 'online' });
  assert.deepEqual(await look(), { text: '● Server online', busy: 'false' });
  assert.equal(await page.$eval('#translationBenchmark', (el) => !el.hidden && getComputedStyle(el).display !== 'none'), true, 'the benchmark, for a local server that answers');
  // (A server that is down answers at once: "Checking…" may stand for less than one look at the
  // page, so what the badge says is kept as it changes.)
  await page.evaluate(() => {
    const said = window.__badge = [document.getElementById('translateStatusBadge').textContent];
    new MutationObserver(() => { const text = document.getElementById('translateStatusBadge').textContent; if (said.at(-1) !== text) said.push(text); })
      .observe(document.body, { childList: true, characterData: true, subtree: true });
  });
  tr.state.online = false;
  await page.click('#checkTranslateBtn');
  await until(page, () => document.getElementById('translateStatusBadge').textContent === '○ Server offline', null, { what: 'offline' });
  assert.deepEqual(await page.evaluate(() => window.__badge), ['● Server online', '○ Checking…', '○ Server offline'], 'checking again, then offline');
  assert.deepEqual(await look(), { text: '○ Server offline', busy: 'false' });
  assert.equal(await page.$eval('#translationBenchmark', (el) => el.hidden || getComputedStyle(el).display === 'none'), true, 'no benchmark once it stops answering');
  assert.deepEqual(page.problems.filter((p) => !/Failed to load resource/.test(p)), []);
});

test(`nothing is contacted before a server is configured; Check asks the default address`, async (t) => {
  if (skip(t)) return;
  const asked = tr.state.requests.length;
  const page = await open(t, NEW, { storage: {} });
  await until(page, () => document.getElementById('translateStatusBadge').textContent === '○ Server offline', null, { what: 'offline at once' });
  await openWindow(page);
  await pause(1500);
  assert.deepEqual(page.refused, [], 'no request left for any server');
  assert.equal(tr.state.requests.length, asked);
  assert.equal(await raw(page), null, 'nothing stored');
  assert.equal(await page.$eval('#resetTranslateBtn', (b) => b.disabled), true, 'Reset off: nothing known of a server');
  assert.equal(await page.$eval('#translateCapsNote', (n) => n.textContent), 'Connect to a translation server to choose models.');
  await page.keyboard.press('Escape');
  await until(page, () => !(document.querySelector('#translateBox[data-open]')), null, { what: 'closed' });
  await page.click('#checkTranslateBtn');
  await until(page, () => document.getElementById('translateStatusBadge').textContent === '○ Server offline' && document.getElementById('checkTranslateBtn').getAttribute('aria-busy') === 'false', null, { what: 'checked' });
  assert.ok(page.refused.includes('http://127.0.0.1:5003/stats'), `Check asked the default address (refused by the harness: ${page.refused})`);
  assert.equal(await raw(page), null, 'still nothing stored');
});

test('the benchmark only for a server on this machine: one elsewhere that answers gets none', async (t) => {
  if (skip(t)) return;
  if (!away) { t.skip('no second loopback address'); return; }
  const page = await open(t, NEW, { storage: configured(away.origin) });
  await until(page, () => document.getElementById('translateStatusBadge').textContent === '● Server online', null, { what: 'online' });
  await pause(200);
  assert.equal(await page.$eval('#translationBenchmark', (el) => el.hidden || getComputedStyle(el).display === 'none'), true, NEW);
});

// ── What depends on what ────────────────────────────────────────────────────────────────────────
test(`what depends on what`, async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { storage: configured() });
  await drawnCaps(page);
  // The pipeline's translator and the window's engine are one choice.
  await choose(page, '#step-translate', '"sugoi"', implIndex('translate', 'sugoi'));
  await openWindow(page);
  assert.equal(await value(page, '[data-param="translator.translator"]:not(#step-translate)'), '"sugoi"', 'the window follows the pipeline');
  await choose(page, '[data-param="translator.translator"]:not(#step-translate)', '"gemini"', implIndex('translate', 'gemini'));
  await until(page, () => (document.getElementById('step-translate').value ?? '') === '"gemini"' || document.getElementById('step-translate').dataset.value === '"gemini"', null, { what: 'the pipeline follows the window' });
  // The panel's language and the window's target are one choice.
  await page.keyboard.press('Escape');
  await until(page, () => !(document.querySelector('#translateBox[data-open]')), null, { what: 'closed' });
  await choose(page, '#translateLanguage', '"JPN"', langIndex('JPN'));
  await openWindow(page);
  assert.equal(await value(page, '[data-param="translator.target_lang"]:not(#translateLanguage)'), '"JPN"');
  // A preset fills its options; an option changed by hand makes it Custom.
  await choose(page, '[data-preset]', '"fast"', presetIndex('fast'));
  await fold(page, true);
  assert.deepEqual([await value(page, '[data-param="inpainter.inpainting_size"]'), await value(page, '[data-param="mask_dilation_offset"]'), await value(page, '[data-param="kernel_size"]')], ['1024', '20', '3']);
  await type(page, '[data-param="kernel_size"]', '9');
  await until(page, () => { const p = document.querySelector('[data-preset]'); return (p.value ?? p.dataset.value) === '"custom"' || p.dataset.value === '"custom"'; }, null, { what: 'Custom' });
  // Batch caps only for the translators that take one.
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-batch]')].map((el) => el.dataset.batch).sort()), ['chatgpt', 'gemini']);
  // The fold hides all it holds.
  await fold(page, false);
  assert.equal(await page.$eval('[data-param="kernel_size"]', (el) => el.getClientRects().length), 0, 'folded away');
  assert.equal(await page.$eval('[data-param="translator.content_screen_prompt"]', (el) => el.getClientRects().length > 0), true, 'the grouped options stay');
  // The note: a model the server doesn't offer.
  assert.equal(await page.$eval('#translateCapsNote', (n) => n.hidden || getComputedStyle(n).display === 'none'), true, 'no note while all is offered');
  assert.equal(await page.$eval('#resetTranslateBtn', (b) => b.disabled), false);
  assert.deepEqual(page.problems, []);
});

test(`the window's note: a kept copy while the server is down, a model it no longer offers`, async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { storage: { ...configured(), 'shiori:translateSettings': JSON.stringify({ schema: 3, serverUrl: tr.origin, params: { 'ocr.ocr': 'gone' } }) } });
  await drawnCaps(page);
  await openWindow(page);
  assert.match(await page.$eval('#translateCapsNote', (n) => n.textContent), /gone/);
  tr.state.online = false;
  t.after(() => { tr.state.online = true; });
  await page.keyboard.press('Escape');
  await until(page, () => !(document.querySelector('#translateBox[data-open]')), null, { what: 'closed' });
  await page.click('#checkTranslateBtn');
  await until(page, () => document.getElementById('translateStatusBadge').textContent === '○ Server offline', null, { what: 'offline' });
  await pause(300);
  await openWindow(page);
  const note = await page.$eval('#translateCapsNote', (n) => n.textContent);
  const cached = await page.evaluate(async () => (await import('/app/js/i18n.js')).t('tm.caps_cached'));
  assert.ok(note.startsWith(cached), `the kept copy said: ${note}`);
  assert.equal(await exists(page, '#step-detect'), true, 'its choices still drawn');
});

// ── The window ──────────────────────────────────────────────────────────────────────────────────
test(`the advanced window: its close focused, focus held, Escape, focus back; the fold kept on reopening`, async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { storage: configured() });
  await drawnCaps(page);
  await page.focus('#openTranslateModalBtn');
  await page.keyboard.press('Enter');
  await until(page, () => document.activeElement?.id === 'translateClose', null, { what: 'its close focused' });
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));   // (a focus guard at the box's end hands focus round)
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#translateBox')), true, `focus held (Tab ${i + 1}): ${await page.evaluate(() => document.activeElement.outerHTML.slice(0, 200))}`);
  }
  await fold(page, true);
  await page.keyboard.press('Escape');
  await until(page, () => !document.querySelector('#translateBox[data-open]') && document.activeElement?.id === 'openTranslateModalBtn', null, { what: 'closed, focus back' });
  await openWindow(page);
  assert.equal(await page.$eval('#cfgAdvancedHeader', (h) => h.getAttribute('aria-expanded')), 'true', 'the fold as it was left');
  assert.deepEqual(page.problems, []);
});

test('the window\'s box never moves or changes size after its first frame, with the CPU slowed six times', async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { storage: configured() });
  await drawnCaps(page);
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  t.after(() => cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {}));
  await page.evaluate(() => {
    window.__boxes = [];
    const look = () => {
      const box = document.getElementById('translateBox');
      if (box) { const r = box.getBoundingClientRect(); window.__boxes.push([r.x, r.y, r.width, r.height].join()); }
      if (window.__boxes.length < 40) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await page.click('#openTranslateModalBtn');
  await until(page, () => window.__boxes.length >= 40, null, { what: '40 frames', timeout: 30000 });
  const boxes = await page.evaluate(() => window.__boxes);
  assert.equal(new Set(boxes).size, 1, `one box in every frame: ${[...new Set(boxes)].join(' | ')}`);
  assert.deepEqual(page.problems, []);
});

// ── The benchmark ───────────────────────────────────────────────────────────────────────────────
async function loadBenchmark(page) {
  await page.click('#benchmarkLoad');
  await until(page, () => /galleries\.$/.test(document.getElementById('benchmarkStatus').textContent), null, { what: 'loaded' });
  // One model a stage, one gallery, short waits.
  await page.evaluate(() => {
    for (const fs of document.querySelectorAll('#translationBenchmark .benchmark-models fieldset')) {
      [...fs.querySelectorAll('[role="checkbox"]')].filter((b) => b.getAttribute('aria-checked') === 'true').slice(1).forEach((b) => b.click());
    }
    [...document.querySelectorAll('#translationBenchmark .bench-gallery')].find((l) => l.textContent.includes('Alpha')).querySelector('[role="checkbox"]').click();
  });
  for (const [key, v] of [['warmupPages', '1'], ['cooldownSeconds', '1']]) await type(page, `[data-number="${key}"]`, v);
  await until(page, () => document.querySelector('.benchmark-estimate').textContent.startsWith('1 configurations · 1 galleries · 2 jobs'), null, { what: 'the estimate' });
}

test('the benchmark: a run and its report, View last report, Compare JSON…, Escape', async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { storage: configured(), galleries: true });
  await until(page, () => !document.getElementById('translationBenchmark').hidden, null, { what: 'the card' });
  assert.equal(await page.$eval('#benchmarkLast', (b) => b.disabled), true, 'no report yet');
  await loadBenchmark(page);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#translationBenchmark .bench-gallery .bench-gallery-meta')].map((m) => m.textContent)), ['3 pages · 336B/page', '3 pages · 336B/page']);
  const starts = tr.state.starts.length;
  await page.click('#benchmarkRun');
  assert.equal(await page.$eval('#benchmarkStop', (b) => b.disabled), false, 'Stop while it runs');
  assert.equal(await page.$eval('#benchmarkRun', (b) => b.disabled), true);
  await until(page, () => !!document.getElementById('benchmarkReport'), null, { what: 'the report', timeout: 60000 });
  assert.equal(await page.$eval('#benchmarkStatus', (s) => s.textContent), 'done');
  assert.deepEqual(tr.state.starts.slice(starts).map((s) => s.images), [1, 3], 'a warm-up of one page, then the gallery');
  const report = await page.evaluate(() => ({ title: document.getElementById('benchmarkReportTitle').textContent, line: document.querySelector('#benchmarkReport p').textContent,
    headings: [...document.querySelectorAll('#benchmarkReport h3')].map((h) => h.textContent), meters: document.querySelectorAll('#benchmarkReport [data-slot="meter"]').length,
    runs: [...document.querySelectorAll('#benchmarkReport [data-slot="collapsible-trigger"]')].map((s) => s.textContent.replace(/ · [\d.]+ s$/, '')) }));
  assert.equal(report.title, 'Translation benchmark');
  assert.match(report.line, /^done · \d{4}-\d\d-\d\dT.* · 2 runs including warm-ups$/);
  assert.deepEqual(report.headings, ['Corpus', 'Stage work per measured page', 'Individual runs']);
  assert.equal(report.meters, 1);
  assert.deepEqual(report.runs, ['#1 · 1790000000001 · warmup  · done', '#1 · 1790000000001 · measure 1 · done', 'Method, environment and reproducible plan']);
  // Compare with an earlier report.
  const earlier = await page.evaluate(async () => JSON.parse(localStorage.getItem('shiori:translationBenchmarkReport')));
  earlier.startedAt = '2026-01-01T00:00:00.000Z';
  const file = join(scratch, 'earlier.json');
  writeFileSync(file, JSON.stringify(earlier));
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.evaluate(() => [...document.querySelectorAll('#benchmarkReport button')].find((b) => b.textContent === 'Compare JSON…').click())]);
  await chooser.accept([file]);
  await until(page, () => [...document.querySelectorAll('#benchmarkReport h3')].some((h) => h.textContent === 'Comparison with 2026-01-01T00:00:00.000Z'), null, { what: 'the comparison' });
  await page.keyboard.press('Escape');
  await until(page, () => !document.getElementById('benchmarkReport'), null, { what: 'closed' });
  // The last report, from storage.
  assert.equal(await page.$eval('#benchmarkLast', (b) => b.disabled), false);
  await page.click('#benchmarkLast');
  await until(page, () => !!document.getElementById('benchmarkReport'), null, { what: 'the last report' });
  await page.keyboard.press('Escape');
  await until(page, () => !document.getElementById('benchmarkReport') && document.activeElement?.id === 'benchmarkLast', null, { what: 'closed, focus back' });
  assert.deepEqual(page.problems, []);
});

test('the benchmark: Stop cancels the job under way and leaves a report saying so; the estimate as 1.3\'s', async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { storage: configured(), galleries: true });
  await page.click('#benchmarkLoad');
  await until(page, () => /galleries\.$/.test(document.getElementById('benchmarkStatus').textContent), null, { what: 'loaded' });
  const now = await page.$eval('.benchmark-estimate', (p) => p.textContent);
  const was = record(FILE, 'estimate');
  assert.equal(now, was, 'the same estimate for the same plan');
  await loadBenchmark(page);
  tr.state.hold = true;
  t.after(() => { tr.state.hold = false; });
  const cancels = tr.state.cancels.length;
  await page.click('#benchmarkRun');
  await until(page, () => /^(warmup|Warming)/.test(document.getElementById('benchmarkStatus').textContent), null, { what: 'a job under way', timeout: 30000 });
  // Every line the status says from here (the stand-in cancels at once: 'Stopping…' may last a frame).
  await page.evaluate(() => {
    const status = document.getElementById('benchmarkStatus');
    window.__said = [];
    new MutationObserver(() => window.__said.push(status.textContent)).observe(status, { childList: true, characterData: true, subtree: true });
  });
  await page.click('#benchmarkStop');
  await until(page, () => !!document.getElementById('benchmarkReport'), null, { what: 'the report', timeout: 30000 });
  const said = await page.evaluate(() => window.__said);
  assert.equal(said[0], 'Stopping and cancelling the current job…', `said: ${JSON.stringify(said)}`);
  assert.match(said.at(-1), /^cancelled/);
  assert.match(await page.$eval('#benchmarkStatus', (s) => s.textContent), /^cancelled/);
  assert.equal(tr.state.cancels.length, cancels + 1, 'the job under way cancelled');
  assert.equal(await page.$eval('#benchmarkStop', (b) => b.disabled), true);
  assert.equal(await page.$eval('#benchmarkRun', (b) => b.disabled), false);
  assert.deepEqual(page.problems, []);
});

test('the benchmark: going to another page of the app while it runs asks first; staying keeps it running, leaving cancels its job', async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { storage: configured(), galleries: true });
  await until(page, () => !document.getElementById('translationBenchmark').hidden, null, { what: 'the card' });
  await loadBenchmark(page);
  tr.state.hold = true;
  t.after(() => { tr.state.hold = false; });
  await page.click('#benchmarkRun');
  await until(page, () => /^(warmup|Warming)/.test(document.getElementById('benchmarkStatus').textContent), null, { what: 'a job under way', timeout: 30000 });
  await page.evaluate(() => { const a = document.createElement('a'); a.href = '/tasks'; a.id = 'toTasks'; document.body.append(a); });
  await page.$eval('#toTasks', (a) => a.click());
  await answer(page, 'Cancel');
  await pause(300);
  assert.equal(await page.evaluate(() => location.pathname), NEW, 'stayed');
  assert.equal(await page.$eval('#benchmarkStop', (b) => b.disabled), false, 'still running');
  const cancels = tr.state.cancels.length;
  await page.$eval('#toTasks', (a) => a.click());
  await answer(page, 'Leave');
  await until(page, () => location.pathname === '/tasks' && !!document.getElementById('tkList'), null, { what: 'Tasks' });
  const deadline = Date.now() + 10000;
  while (tr.state.cancels.length === cancels && Date.now() < deadline) await pause(100);
  assert.equal(tr.state.cancels.length, cancels + 1, 'its job cancelled');
  assert.deepEqual(page.problems, []);
});

// ── A change of language, the phone form, leaving ───────────────────────────────────────────────
test('a change of language redraws the panel and the window in it at once', async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { storage: configured() });
  await drawnCaps(page);
  t.after(() => page.evaluate(() => localStorage.setItem('shiori-lang', 'en')).catch(() => {}));
  await openWindow(page);
  const words = () => page.evaluate(() => ({ badge: document.getElementById('translateStatusBadge').textContent, step: document.querySelector('.translate-step-name').textContent,
    title: document.getElementById('translateTitle').textContent, fold: document.getElementById('cfgAdvancedHeader').textContent }));
  assert.deepEqual(await words(), { badge: '● Server online', step: 'Detector', title: 'Advanced settings', fold: 'Pipeline details' });
  await page.evaluate(async () => (await import('/app/js/i18n.js')).setLang('ja'));
  const want = await page.evaluate(async () => { const { t } = await import('/app/js/i18n.js'); return { badge: t('set.tr_online'), step: t('tm.detector'), title: t('tm.title'), fold: t('tm.advanced') }; });
  await until(page, (title) => document.getElementById('translateTitle').textContent === title, want.title, { what: 'Japanese' });
  assert.deepEqual(await words(), want);
  assert.deepEqual(page.problems, []);
});

test('the phone form: the pipeline one step under another, the window\'s options one to a row, nothing wider than the screen', async (t) => {
  if (skip(t)) return;
  const page = await open(t, NEW, { storage: configured(), viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
  await drawnCaps(page);
  const panel = await page.evaluate(() => ({
    steps: [...new Set([...document.querySelectorAll('.translate-step')].map((s) => Math.round(s.getBoundingClientRect().x)))].length,
    turned: getComputedStyle(document.querySelector('.translate-step-sep')).rotate,
    study: document.getElementById('studyModeGeneration').tagName,
    fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  }));
  assert.deepEqual(panel, { steps: 1, turned: '90deg', study: 'SELECT', fits: true });
  await openWindow(page);
  await fold(page, true);
  const box = await page.evaluate(() => {
    const r = document.getElementById('translateBox').getBoundingClientRect();
    const cols = getComputedStyle(document.getElementById('tcfgGrid')).gridTemplateColumns.split(' ').length;
    return { left: r.left, right: innerWidth - r.right, cols, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
  });
  assert.deepEqual(box, { left: 8, right: 8, cols: 1, fits: true });
  assert.deepEqual(page.problems, []);
});

test('leaving the page leaves nothing behind: /settings → /tasks → /settings, five times, the window opened each time', async (t) => {
  if (skip(t)) return;
  const page = await openPage(browser, origin, { allow: [tr.origin] });
  t.after(() => page.close());
  await page.evaluateOnNewDocument((s) => {
    localStorage.setItem('shiori:translateSettings', JSON.stringify({ serverUrl: s }));
    const live = window.__live = { intervals: new Set(), channels: new Set() };
    const { setInterval: si, clearInterval: ci } = window;
    window.setInterval = function (...a) { const id = si.apply(this, a); live.intervals.add(id); return id; };
    window.clearInterval = function (id) { live.intervals.delete(id); return ci.call(this, id); };
    const BC = window.BroadcastChannel;
    window.BroadcastChannel = class extends BC { constructor(name) { super(name); live.channels.add(this); } close() { live.channels.delete(this); super.close(); } };
  }, tr.origin);
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await until(page, () => !!document.getElementById('tkList'), null, { what: 'Tasks' });
  await page.evaluate(() => { const a = document.createElement('a'); a.href = '/settings'; a.id = 'toSettings'; document.body.append(a); });
  const held = async () => {
    const cdp = await page.createCDPSession();
    const listeners = async (expr) => {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
      return (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.map((l) => l.type).sort();
    };
    const out = { window: await listeners('window'), document: await listeners('document'),
      ...await page.evaluate(() => ({ intervals: window.__live.intervals.size, channels: window.__live.channels.size, nodes: document.getElementsByTagName('*').length })) };
    await cdp.detach();
    return out;
  };
  const visit = async (i, first) => {
    if (first) await page.$eval('#toSettings', (a) => a.click()); else await page.evaluate(() => history.forward());
    await until(page, () => !!document.getElementById('step-detect'), null, { what: `Settings (${i})` });
    await page.click('#navTranslation');
    await openWindow(page);
    await fold(page, true);
    await page.keyboard.press('Escape');
    await until(page, () => !document.getElementById('translateBox'), null, { what: 'closed' });
    await page.evaluate(() => history.back());
    await until(page, () => location.pathname === '/tasks' && !document.getElementById('settingsNav') && !!document.getElementById('tkList'), null, { what: `Tasks again (${i})` });
  };
  await visit(0, true);
  await pause(300);
  const first = await held();
  for (let i = 1; i <= 5; i++) await visit(i, false);
  await pause(300);
  assert.deepEqual(await held(), first, 'after five more visits, what is held is what it was after the first');
  assert.deepEqual(page.problems, []);
});

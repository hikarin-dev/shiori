// library-drive.mjs — driving the library page (/library) for the tests that hold its buttons to what
// 1.3's page gave (driven alike, 1.3's page beside it, until 2026-11-25): a seeded set of galleries per run, the helper's
// and the translation server's stand-ins, and in the page recorders of what it says (to whatever runs
// things: services.handle's messages; to the helper: the bridge's requests), what it opens and saves,
// and readers of its dialogs and menus, whichever drawing they are (notice.js's own, or the one page's).
// A run's record names its galleries by their parts (P, I, …), never by their ids, so a run compares
// with its record.
import { setTimeout as sleep } from 'node:timers/promises';
import { openPage, until } from './harness.mjs';
import { standInHelper, HELPER_STATUS } from './stand-in-helper.mjs';

export { sleep };

// The parts of a run's library, each a gallery at `base + n`:
//   P  plain: whole (2 of 2 pages), from Site One with a link, tags alpha and beta, Japanese, manga
//   I  incomplete (1 of 4 pages), from Site One, no link of its own
//   N  no source, 1 page
//   T  translated, 2 pages with what translating them kept (the re-run menu's steps)
//   E  empty (none of its 3 pages)
//   S  a series' owner (chapter 1) and S2 its chapter 2, each whole, from Site One
export const PARTS = { P: 10, I: 9, N: 8, T: 7, E: 6, S: 5, S2: 4 };
let runs = 0;
export const nextBase = (start) => start + (runs++) * 100;

// In the page: the run's galleries made (a fresh set, ids above every earlier run's).
async function seed({ base, parts }) {
  const api = await import('/app/js/api.js');
  const id = (part) => String(base + parts[part]);
  const png = async (hue, w = 300, h = 430) => { const c = new OffscreenCanvas(w, h); const x = c.getContext('2d'); x.fillStyle = `hsl(${hue} 60% 50%)`; x.fillRect(0, 0, w, h); return c.convertToBlob({ type: 'image/png' }); };
  const title = (english) => ({ english, japanese: '', pretty: '' });
  const gallery = async (part, meta, pages) => {
    await api.meta.put({ galleryId: id(part), title: title(`${part} gallery`), tags: [], numPages: pages, ...meta });
    for (let n = 1; n <= pages; n++) await api.pages.put(id(part), n, await png(base % 360 + n * 30));
  };
  await gallery('S2', { source: 'a.example', sourceId: '904' }, 1);
  await gallery('S', { source: 'a.example', sourceId: '905' }, 1);
  await api.series.write(id('S'), [{ id: id('S'), title: '', number: 1 }, { id: id('S2'), title: 'The second', number: 2 }], { seriesTitle: title('S series') });
  await gallery('E', { source: 'a.example', sourceId: '906', numPages: 3 }, 1);
  await api.pages.prune(id('E'), []);
  await gallery('T', { translated: true }, 2);
  // What translating T kept: page 1 every step's, page 2 its reading only.
  const tr = await png(200);
  await api.derived.putTranslation(id('T'), 1, { image: tr, pipeline: { job: 'j1', lines: [], read: [], regions: [] } });
  await api.derived.putTranslation(id('T'), 2, { image: tr, pipeline: { job: 'j1', lines: [], read: [] } });
  await gallery('N', {}, 1);
  await gallery('I', { source: 'a.example', sourceId: '902', numPages: 4 }, 1);
  await gallery('P', { source: 'a.example', sourceId: '901', sourceUrl: 'https://a.example/g/901',
    tags: [{ type: 'language', name: 'japanese', url: '' }, { type: 'category', name: 'manga', url: '' }, { type: 'tag', name: 'alpha', url: '' }, { type: 'tag', name: 'beta', url: '' }] }, 2);
}

// A page of `path` over a fresh run of galleries at `base`. `helper`: the helper's stand-in there (and
// seen there last time); `merge`: series shown merged (the default); `storage`: more of the page's
// stored settings; `translator`: the translation server stand-in's origin (the translate buttons show).
export async function openRun(browser, origin, path, { base, helper = true, merge = true, storage = {}, translator } = {}) {
  const page = await openPage(browser, origin, { allow: translator ? [translator] : [] });
  if (helper) await standInHelper(page);
  await seedRun(page, origin, base, { helper, merge, storage, translator });
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  const first = String(base + PARTS.P);
  await until(page, (first) => document.querySelector('#grid > .card')?.dataset.galleryId === first
    && [...document.querySelectorAll('#grid > .card img.card-thumb')].slice(0, 5).every((img) => img.getAttribute('src') && img.complete), first, { what: `${path}: the run's cards` });
  // The translate buttons: shown once the stand-in server has answered.
  if (translator) await until(page, () => getComputedStyle(document.querySelector('#grid > .card .card-btn-translate')).display !== 'none', null, { what: 'the translation server' });
  await page.evaluate(record);
  return page;
}

// The run's galleries made (from /tasks, in `page`), the jobs registry emptied, and the library's
// settings for the run stored.
export async function seedRun(page, origin, base, { helper = true, merge = true, storage = {}, translator } = {}) {
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(seed, { base, parts: PARTS });
  // The library's one-time updates, run to their end here. A page starts them a second or more after
  // its load (boot-core.js), and one that takes over 700 ms shows its progress window over the page:
  // on a browser's first page, with the CPU slowed or under the whole suite's load, that window came
  // up in the middle of a test and took its press (the layout checklist's "not drawn", about one
  // first page in five).
  await page.evaluate(async () => (await import('/app/js/migrations.js')).runMigrations());
  await page.evaluate(async (stored) => {
    const platform = await import('/app/js/platform.js');
    for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind);
    for (const k of Object.keys(localStorage)) if (k.startsWith('shiori:lib') || k === 'shiori-ext-status' || k === 'shiori:translateSettings') localStorage.removeItem(k);
    sessionStorage.removeItem('shiori-covers');
    for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  }, { ...(helper ? HELPER_STATUS : {}), 'shiori:libMergeSeries': merge, 'shiori:libQuickActionsMode': 'always',
    ...(translator ? { 'shiori:translateSettings': { serverUrl: translator } } : {}), ...storage });
}

// Until the library has measured every gallery just made (each one's typical page, and the copies it
// keeps of its pages: the stored size's "other data") and its stored size has stood still for 3 s. The
// measuring runs in whatever page is open: a page closed before it ends leaves the library part-measured,
// so what the totals and a sort by size show then differs from run to run.
export async function librarySettled(page) {
  await until(page, async () => {
    const api = await import('/app/js/api.js');
    const stats = await api.galleries.stats();
    const measured = Object.values(stats.galleries).every((g) => g.medianPage);
    const now = performance.now();
    if (!measured || stats.totalSize !== window.__settledSize) { window.__settledSize = stats.totalSize; window.__settledSince = now; return false; }
    return now - window.__settledSince >= 3000;
  }, null, { what: 'every gallery measured, the stored size still', timeout: 60000 });
}

// In the page: what it says and does from here on.
async function record() {
  const { services } = await import('/app/js/services.js');
  window.__said = [];
  window.__opened = [];
  window.__saved = [];
  window.__helperSaid = window.__helperSaid ?? [];
  window.__helperSaid.length = 0;
  const QUIET = new Set(['GET_COVER', 'TRANSLATOR_PING']);
  const handle = services.handle;
  // What is said to whatever runs things. A translation asked for is answered "started" and goes no
  // further (its runner is not this page's; its news is held by the jobs tests); a delete may be
  // refused as a library folder refuses it (window.__refuse: the gallery ids).
  services.handle = function (msg) {
    if (!QUIET.has(msg?.type)) window.__said.push(JSON.parse(JSON.stringify(msg)));
    if (msg?.type === 'TRANSLATE_GALLERY') return Promise.resolve({ ok: true, started: true });
    if (/^DELETE_/.test(msg?.type) && window.__refuse?.includes(String(msg.galleryId))) return Promise.reject(Object.assign(new Error('refused'), { code: 'unavailable', reason: 'not-owned' }));
    return handle.call(this, msg);
  };
  window.open = (...args) => { window.__opened.push(args); return null; };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) { window.__saved.push(this.download); return; }
    return click.call(this);
  };
}

// The run's record: what was said, opened and saved, and what the library holds of its galleries
// (with every id named by its part).
export async function result(page, base, dialogs = []) {
  const out = await page.evaluate(async ({ base, parts }) => {
    const api = await import('/app/js/api.js');
    const after = {};
    for (const [part, n] of Object.entries(parts)) {
      const [g] = await api.galleries.byIds([String(base + n)]);
      after[part] = g ? { favorite: !!g.favorite, translated: !!g.translated, source: g.source || '', sourceId: g.sourceId || null, sourceUrl: g.sourceUrl || null,
        count: g.count, tags: (g.tags || []).map((t) => `${t.type}:${t.name}`), parent: g.parentId ? String(g.parentId) : null, chapters: (g.chapters || []).map((c) => String(c.id)) } : null;
    }
    // (A cover asked of the helper is the covers' own, at the page's load: not a button's.)
    return { said: window.__said, helper: window.__helperSaid.filter((m) => m?.type !== 'EXT_FETCH_COVER'), opened: window.__opened, saved: window.__saved, after };
  }, { base, parts: PARTS });
  return named({ ...out, dialogs }, base);
}

// Every id of the run in `value` named by its part.
export function named(value, base) {
  let text = JSON.stringify(value);
  for (const [part, n] of Object.entries(PARTS).sort((a, b) => b[0].length - a[0].length)) text = text.split(String(base + n)).join(`<${part}>`);
  return JSON.parse(text);
}

export const card = (base, part) => `#grid > .card[data-gallery-id="${base + PARTS[part]}"]`;
const BUTTON = { fav: '.card-fav', open: '.card-btn-open', dl: '.card-btn-dl', tr: '.card-btn-translate', export: '.card-btn-export', del: '.card-btn-del', add: '.card-tag-add' };

// A press on a card's part (`what`: a button's name, or a selector inside the card), with Shift or
// Alt held, or the right button.
export async function press(page, base, part, what, { shift = false, alt = false, right = false } = {}) {
  const sel = `${card(base, part)} ${BUTTON[what] ?? what}`;
  await page.hover(card(base, part));
  await sleep(50);
  // The card under the pointer grows: what is pressed may still be moving with it (a long title opening
  // under a slowed CPU took the "+" 136px down while the press was on its way, 1 time in 10). Pressed
  // once it stands still (the same box three frames running).
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    if (!el) return true;
    const r = el.getBoundingClientRect(), at = `${r.x},${r.y},${r.width},${r.height}`;
    const still = window.__pressAt?.sel === sel && window.__pressAt.at === at ? window.__pressAt.n + 1 : 0;
    window.__pressAt = { sel, at, n: still };
    return still >= 2;
  }, { polling: 'raf', timeout: 8000 }, sel).catch(() => {});
  if (shift) await page.keyboard.down('Shift');
  if (alt) await page.keyboard.down('Alt');
  await page.click(sel, right ? { button: 'right' } : {});
  if (alt) await page.keyboard.up('Alt');
  if (shift) await page.keyboard.up('Shift');
  await sleep(300);
}

// The dialog showing (1.3's own drawing, or the notice host's), as words: or null when none shows
// within `wait` ms.
export async function readDialog(page, wait = 2000) {
  try {
    await page.waitForFunction(() => document.querySelector('.notice-overlay .notice-dialog, [data-notice="dialog"]'), { timeout: wait });
  } catch { return null; }
  await sleep(150);
  return page.evaluate(() => {
    const text = (el) => el?.textContent.trim() ?? null;
    // What has focus: a button (by its words), the text field, a tick, a choice.
    const focusOf = () => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      if (a.matches('input[type="checkbox"], [role="checkbox"]')) return 'tick';
      if (a.matches('input[type="radio"], [role="radio"]')) return 'choice';
      if (a.matches('input')) return 'field';
      return text(a.closest('button'));
    };
    const old = document.querySelector('.notice-overlay .notice-dialog');
    if (old) {
      return {
        title: text(old.querySelector('h2')), body: text(old.querySelector(':scope > p')),
        detail: [text(old.querySelector('.notice-detail-main')), text(old.querySelector('.notice-detail-sub'))].filter((x) => x != null),
        cover: old.querySelector('.notice-thumb') ? (old.querySelector('.notice-thumb img') ? 'picture' : 'none yet') : null,
        tone: old.querySelector('.notice-icon')?.classList[1] ?? null,
        input: old.querySelector('.notice-input') ? { value: old.querySelector('.notice-input').value, placeholder: old.querySelector('.notice-input').placeholder } : null,
        choices: [...old.querySelectorAll('.notice-option')].map((o) => ({ label: text(o.querySelector('strong')), detail: text(o.querySelector('.notice-option-text span')), checked: o.querySelector('input').checked })),
        checks: [...old.querySelectorAll('.notice-check')].filter((c) => !c.hidden).map((c) => ({ label: text(c.querySelector('span')), checked: c.querySelector('input').checked })),
        buttons: [...old.querySelectorAll('.notice-actions button')].map((b) => ({ text: text(b), danger: b.classList.contains('danger') })),
        focus: focusOf(),
      };
    }
    const box = document.querySelector('[data-notice="dialog"]');
    const detailBox = box.querySelector('[data-slot="notice-detail"]');
    const lines = detailBox ? [...detailBox.querySelectorAll(':scope > span:last-child > span')].map(text) : [];
    const thumb = box.querySelector('[data-slot="notice-thumb"]');
    const ICONS = { 'lucide-triangle-alert': 'danger', 'lucide-circle-alert': 'error', 'lucide-circle-check': 'success', 'lucide-info': 'info' };
    const svg = box.querySelector('[data-slot="notice-icon"] svg');
    const tone = svg ? ICONS[[...svg.classList].find((c) => c in ICONS)] ?? null : null;
    const field = box.querySelector('input:not([type]), input[type="text"]');
    return {
      title: text(box.querySelector('[data-slot="dialog-title"]')), body: text(box.querySelector('[data-slot="dialog-description"]')),
      detail: lines,
      cover: thumb ? (thumb.querySelector('img') ? 'picture' : 'none yet') : null,
      tone,
      input: field ? { value: field.value, placeholder: field.placeholder } : null,
      choices: [...box.querySelectorAll('label[data-slot="option-card"]')].map((o) => ({ label: text(o.querySelector('[data-slot="option-title"]')), detail: text(o.querySelector('[data-slot="option-detail"]')), checked: !!o.querySelector('[data-checked]') })),
      checks: [...box.querySelectorAll('label:not([hidden])')].filter((l) => l.querySelector('[data-slot="checkbox"]')).map((l) => ({ label: text(l.querySelector(':scope > span:last-child')), checked: l.querySelector('[data-slot="checkbox"]').hasAttribute('data-checked') })),
      buttons: [...box.querySelectorAll('[data-slot="dialog-footer"] button')].map((b) => ({ text: text(b), danger: b.getAttribute('data-variant') === 'danger' || /destructive/.test(b.className) })),
      focus: focusOf(),
    };
  });
}

// Answers the dialog showing: 'ok' (its last button), 'cancel' (its first, when it has two), 'escape'.
export async function answer(page, how) {
  if (how === 'escape') await page.keyboard.press('Escape');
  else {
    const nth = how === 'ok' ? 'last-child' : 'first-child';
    await page.click(`.notice-overlay .notice-dialog .notice-actions button:${nth}, [data-notice="dialog"] [data-slot="dialog-footer"] button:${nth}`);
  }
  await page.waitForFunction(() => !document.querySelector('.notice-overlay .notice-dialog, [data-notice="dialog"]'), { timeout: 3000 }).catch(() => {});
  await sleep(300);
}

// The prompt's field emptied and `text` typed in.
export async function typeInto(page, text) {
  const sel = '.notice-overlay .notice-input, [data-notice="dialog"] input';
  await page.focus(sel);
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(sel, text);
}

// The re-run menu showing: its title and steps (label, detail, off).
export async function readMenu(page, wait = 2000) {
  try { await page.waitForFunction(() => document.querySelector('.ctx-menu, [data-slot="menu"]'), { timeout: wait }); } catch { return null; }
  await sleep(150);
  return page.evaluate(() => {
    const old = document.querySelector('.ctx-menu');
    if (old) return { title: old.querySelector('.ctx-menu-title').textContent, steps: [...old.querySelectorAll('.ctx-menu-item')].map((i) => [i.querySelector('.ctx-menu-label').textContent, i.querySelector('.ctx-menu-detail').textContent, i.disabled]) };
    const menu = document.querySelector('[data-slot="menu"]');
    return { title: menu.querySelector('[data-slot="menu-title"]').textContent, steps: [...menu.querySelectorAll('[data-slot="menu-item"]')].map((i) => [i.querySelector('[data-slot="menu-label"]').textContent, i.querySelector('[data-slot="menu-detail"]').textContent, i.hasAttribute('data-disabled')]) };
  });
}
export async function pickStep(page, label) {
  const item = await page.evaluateHandle((label) => [...document.querySelectorAll('.ctx-menu-item, [data-slot="menu-item"]')].find((i) => i.textContent.startsWith(label)), label);
  await item.click();
  await sleep(300);
}

// The series' translation window: its title, words, chapters (and the one chosen), buttons.
export async function readSeriesWindow(page) {
  await page.waitForFunction(() => document.querySelector('#_serTrSel'), { timeout: 3000 });
  await sleep(200);
  const drawn = await page.evaluate(() => !(document.getElementById('_serTrSel') instanceof HTMLSelectElement));
  let options;
  if (drawn) {
    await page.click('#_serTrSel');
    // The list is in the document before it opens, and it opens a frame or two after the press (its
    // focus goes into it about 30 ms after): an Escape pressed before that goes to the window and
    // closes it. Open and focused first; closed again before the window is read.
    await page.waitForFunction(() => document.getElementById('_serTrSel')?.getAttribute('aria-expanded') === 'true' && !!document.activeElement?.closest('[data-slot="select-list"]'), { timeout: 3000 });
    options = await page.evaluate(() => [...document.querySelectorAll('[data-slot="select-list"] [data-slot="select-option"]')].map((o) => o.textContent));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('_serTrSel')?.getAttribute('aria-expanded') === 'false', { timeout: 3000 });
    await sleep(200);
  } else options = await page.evaluate(() => [...document.getElementById('_serTrSel').options].map((o) => o.textContent));
  return page.evaluate((options) => {
    const box = document.getElementById('_serTrSel').closest('.modal-box, [data-slot="dialog"]');
    const sel = document.getElementById('_serTrSel');
    return {
      title: (box.querySelector('.modal-title, [data-slot="dialog-title"]')).textContent, words: box.querySelector('.modal-label, [data-slot="eyebrow"]').textContent,
      options, chosen: sel instanceof HTMLSelectElement ? sel.selectedOptions[0].textContent : sel.textContent.trim(),
      buttons: [...box.querySelectorAll('.modal-actions button, [data-slot="dialog-footer"] button')].map((b) => b.textContent),
    };
  }, options);
}

// A drawn or native select's choice, by its label.
export async function choose(page, id, label) {
  const native = await page.evaluate((id) => document.getElementById(id) instanceof HTMLSelectElement, id);
  if (native) {
    await page.focus(`#${id}`);
    await page.evaluate(([id, label]) => { const s = document.getElementById(id); s.value = [...s.options].find((o) => o.textContent === label).value; s.dispatchEvent(new Event('change', { bubbles: true })); }, [id, label]);
    return;
  }
  await page.click(`#${id}`);
  await page.waitForSelector('[data-slot="select-list"] [data-slot="select-option"]');
  await sleep(300);   // (a press in the list's first moments is not taken as a choice)
  const option = await page.evaluateHandle((label) => [...document.querySelectorAll('[data-slot="select-list"] [data-slot="select-option"]')].find((o) => o.textContent === label), label);
  await option.click();
  await until(page, (id) => !document.getElementById(id).hasAttribute('data-popup-open'), id, { what: 'the list closed' });
}

// A job's news, as whatever runs it says it.
export const publish = (page, job) => page.evaluate(async (job) => (await import('/app/js/platform.js')).jobs.publish(job), job);

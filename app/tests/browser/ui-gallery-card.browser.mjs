// ui-gallery-card.browser.mjs — GalleryCard (src/components/gallery-card.tsx) as /components shows it,
// in Chrome: what each part of a card shows for the fixture's galleries (the words, figures, tags,
// links and tips 1.3's cards show for them); the tips as they show with the pointer on a button, plain,
// with Shift and with Alt, and the Shift face the hovered button turns to; what the keyboard reaches,
// in what order, and the quick actions showing for it; each handler called with the gallery's id when
// its button is pressed (with Shift, with Alt, right-clicked) and nothing else happening; a job's
// states one after another on one card, kept as they change by an observer in the page (the bar, the
// line, the button the job holds as its Stop, pressable again at once, its last word staying its while
// and the card back at rest after it); a change to one part leaving the others' nodes in place and the
// cover not loaded again, a hovered card staying grown; the glow under a landscape cover and none under
// a portrait one; and nothing left behind after the page is left and come back to five times.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { spec, textMotion } from './specimens.mjs';

let server, origin, browser;
before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const card = (variant, state = 'rest') => spec('gallery-card', variant, state);
const DRIVEN = card('driven');

// What a page holds that outlives it unless released: timers, observers, object URLs, canvases made.
function instrument() {
  const live = window.__live = { timeouts: new Map(), intervals: new Set(), observers: new Set(), urls: new Set(), canvases: 0 };
  const { setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci } = window;
  window.setTimeout = function (fn, ms, ...rest) {
    let id;
    const run = typeof fn === 'function' ? function (...x) { live.timeouts.delete(id); return fn.apply(this, x); } : fn;
    id = st.call(this, run, ms, ...rest);
    live.timeouts.set(id, ms);
    return id;
  };
  window.clearTimeout = function (id) { live.timeouts.delete(id); return ct.call(this, id); };
  window.setInterval = function (...a) { const id = si.apply(this, a); live.intervals.add(id); return id; };
  window.clearInterval = function (id) { live.intervals.delete(id); return ci.call(this, id); };
  for (const name of ['MutationObserver', 'ResizeObserver', 'IntersectionObserver']) {
    const Base = window[name];
    window[name] = class extends Base {
      constructor(cb, o) { super(cb, o); live.observers.add(this); }
      disconnect() { live.observers.delete(this); return super.disconnect(); }
    };
  }
  const { createObjectURL, revokeObjectURL } = URL;
  URL.createObjectURL = (b) => { const u = createObjectURL(b); live.urls.add(u); return u; };
  URL.revokeObjectURL = (u) => { live.urls.delete(u); return revokeObjectURL(u); };
  const make = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, ...rest) { if (String(tag).toLowerCase() === 'canvas') live.canvases++; return make.call(this, tag, ...rest); };
}

async function page$(t, viewport) {
  if (!browser) { t.skip('Chrome not found (set CHROME_PATH)'); return null; }
  const page = await openPage(browser, origin);
  t.after(() => page.close());
  await page.evaluateOnNewDocument(instrument);
  if (viewport) await page.setViewport(viewport);
  await page.goto(`${origin}/components`, { waitUntil: 'load' });
  await until(page, () => document.title === 'Shiori — Components' && document.querySelector('[data-section="gallery-card"] [data-covers="ready"]')
    && [...document.querySelectorAll('[data-section="gallery-card"] img.card-thumb[src]')].every((i) => i.complete && i.naturalWidth > 0), null, { what: 'the cards with their covers' });
  await page.evaluate(() => document.fonts.ready);
  return page;
}
// The driven card (the specimens' last) given what it shows; its handlers' calls forgotten.
const drive = (page, detail) => page.evaluate((d) => { window.__galleryCardCalls = []; window.dispatchEvent(new CustomEvent('gallery-card-drive', { detail: d })); }, detail);
const calls = (page) => page.evaluate(() => window.__galleryCardCalls ?? []);
// A part's centre, the card brought into the window first (nothing under the pointer moves then).
async function centre(page, sel) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    const r0 = el.getBoundingClientRect();
    if (r0.top < 60 || r0.bottom > innerHeight - 20) el.closest('.card').scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  return box;
}
const tipText = (page) => page.evaluate(() => { const tip = document.querySelector('.shiori-tip'); return tip && tip.style.display !== 'none' ? tip.textContent : null; });

test('what each part of a card shows, for the fixture\'s galleries', async (t) => {
  const page = await page$(t);
  if (!page) return;
  const read = (sel) => page.$eval(sel, (c) => ({
    id: c.querySelector('.card-id').textContent, idLink: c.querySelector('.card-id').localName === 'a' ? [c.querySelector('.card-id').getAttribute('href'), c.querySelector('.card-id').target, c.querySelector('.card-id').rel] : null,
    local: c.querySelector('.card-id').classList.contains('local'), href: c.querySelector('.card-thumb-wrap').getAttribute('href'),
    title: c.querySelector('.card-title')?.textContent ?? null, meta: c.querySelector('.card-meta').textContent,
    tags: [...c.querySelectorAll('.card-tags > *')].map((x) => (x.dataset.langCode ? `flag:${x.dataset.langCode}:${x.dataset.langName}:${x.querySelector('img').getAttribute('src')}` : x.textContent)),
    badge: c.querySelector('.card-series-badge')?.textContent ?? null, favorite: c.querySelector('.card-fav').getAttribute('aria-pressed'),
    cover: c.querySelector('img.card-thumb') ? (c.querySelector('img.card-thumb').getAttribute('src') ? 'picture' : 'coming') : c.querySelector('.card-thumb-placeholder').textContent,
    pages: c.querySelector('.card-pages') ? [c.querySelector('.card-pages').dataset.tip, c.querySelector('.card-pages').dataset.tipBadge] : null,
    size: c.querySelector('.card-size').dataset.tip, sfw: c.classList.contains('card-sfw'),
  }));
  const TABLE = [
    ['tagged', { id: '1790000001060', idLink: null, local: false, href: 'overview?g=1790000001060', title: 'A Card With Many Tags', meta: '4 / 4 pages · 21.9KB',
      tags: ['doujinshi', 'studio north', 'ito', ...Array.from({ length: 22 }, (_, i) => `tag number ${i + 1}`), 'glasses ♀', 'long hair ♀', 'ponytail ♀', 'suit ♂', '+'],
      badge: null, favorite: 'false', cover: 'picture', pages: ['600×860, 0.52 MP\n4.2KB/page average', 'T1'], size: 'Original pages\t16.7KB\nOther data\t5.2KB', sfw: false }],
    ['long', { id: '1790000001059', idLink: null, local: false, href: 'overview?g=1790000001059',
      title: 'The Extraordinarily Long and Winding Chronicle of a Librarian Who Catalogued Every Single Volume in the Kingdom, Twice, and Then Started Over From the Very Beginning',
      meta: '5 / 5 pages · 23.6KB', tags: ['flag:ja:japanese:/app/flags/JP.svg', 'manga', 'aoki ren', 'library', 'slice of life', 'comedy', '+'], badge: null, favorite: 'true', cover: 'picture',
      pages: ['600×860, 0.52 MP\n4.1KB/page average', 'T1'], size: 'Original pages\t20.6KB\nOther data\t2.9KB', sfw: true }],
    ['series', { id: '1790000001057', idLink: null, local: false, href: 'overview?g=1790000001057', title: 'Harbor Lights', meta: '26 pages · 213KB',
      tags: ['manga', 'kanzaki', 'sea', 'mystery', '+'], badge: '4 chapters', favorite: 'true', cover: 'picture', pages: ['600×860, 0.52 MP\n4.2KB/page average', 'T1'],
      size: 'Original pages\t109KB\nOther data\t104KB', sfw: true }],
    ['series-volumes', { badge: '2 volumes' }],
    ['sourced', { id: '48213', idLink: [`${origin}/g/48213`, '_blank', 'noopener noreferrer'], title: 'Gallery With a Source', sfw: false }],
    ['pageless', { id: '1790000001052', meta: '0 / 18 pages · 608B', cover: '📁', pages: null, size: 'Original pages\t0B\nOther data\t608B', tags: ['manga', 'waiting', '+'] }],
    ['local', { id: '1790000001101', local: true }],
    ['missing', { meta: '3 / 3 pages · 14.1KB · Files missing' }],
    ['no-cover', { cover: 'coming', title: 'Plain' }],
    ['empty-downloadable', { id: '48214', idLink: null, cover: '📁' }],
  ];
  for (const [variant, want] of TABLE) {
    const got = await read(card(variant));
    assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, got[k]])), want, variant);
  }
  // The missing mark in the danger colour; the local id in the second accent; the brand's red id.
  assert.equal(await page.$eval(`${card('missing')} .card-missing`, (e) => getComputedStyle(e).color), 'rgb(255, 64, 64)');
  assert.equal(await page.$eval(`${card('local')} .card-id`, (e) => getComputedStyle(e).color), 'rgb(255, 209, 102)');
  assert.equal(await page.$eval(`${card('plain')} .card-id`, (e) => getComputedStyle(e).color), 'rgb(237, 39, 84)');
  // The buttons' words (download, or Replace with nothing to download from).
  const tips = (variant) => page.$eval(card(variant), (c) => ['.card-fav', '.card-btn-open', '.card-btn-dl', '.card-btn-translate', '.card-btn-export', '.card-btn-del']
    .map((s) => { const b = c.querySelector(s); return [b.dataset.tip, b.dataset.tipShift ?? null, b.dataset.tipAlt ?? null]; }));
  assert.deepEqual(await tips('translated'), [['Add to favorites', null, 'Search for galleries not in favorites'], ['Set source site', null, null], ['Replace images from CBZ', null, null],
    ['Translate any new pages · Right-click: re-run from a stage', 'Revert to original', 'Search for translated galleries'], ['Export gallery', 'Export metadata', null], ['Delete gallery', 'Quick delete', null]]);
  assert.deepEqual((await tips('empty-downloadable')).slice(1, 3), [[`Site One: ${origin}/g/48214`, 'Edit source link', 'Search for galleries from Site One'], ['Download all 18 pages', 'Replace images from CBZ', null]]);
  assert.deepEqual(page.problems, []);
});

test('the tips as they show under the pointer, plain, with Shift and with Alt; the Shift face', async (t) => {
  const page = await page$(t);
  if (!page) return;
  await drive(page, { g: 'sourced', cover: 'sourced', env: { helper: true }, modes: { quickActions: 'always' } });
  await sleep(100);
  const shown = async (sel) => { const at = await centre(page, `${DRIVEN} ${sel}`); await page.mouse.move(at.x, at.y, { steps: 3 }); await sleep(60); return tipText(page); };
  assert.equal(await shown('.card-btn-open'), `Site One: ${origin}/g/48213`);
  await page.keyboard.down('Shift');
  await until(page, () => document.querySelector('.shiori-tip')?.textContent === 'Edit source link', null, { what: 'the Shift tip' });
  await page.keyboard.up('Shift');
  await page.keyboard.down('Alt');
  await until(page, () => document.querySelector('.shiori-tip')?.textContent === 'Search for galleries from Site One', null, { what: 'the Alt tip' });
  await page.keyboard.up('Alt');
  await until(page, (want) => document.querySelector('.shiori-tip')?.textContent === want, `Site One: ${origin}/g/48213`, { what: 'the plain tip again' });

  // Delete: its tip with Shift, and its face turned (the one at rest folded shut, the other open),
  // the section's one class following the key; let go, back.
  assert.equal(await shown('.card-btn-del'), 'Delete gallery');
  const faces = () => page.$eval(`${DRIVEN} .card-btn-del`, (b) => [...b.querySelectorAll(':scope > .card-face > *')].map((f) => getComputedStyle(f).transform));
  assert.deepEqual(await faces(), ['none', 'matrix(1, 0, 0, 0, 0, 0)']);
  await page.keyboard.down('Shift');
  await until(page, () => document.querySelector('.shiori-tip')?.textContent === 'Quick delete', null, { what: 'Quick delete' });
  assert.equal(await page.$eval('[data-section="gallery-card"] > div', (s) => s.classList.contains('shift-held')), true, 'the section follows Shift');
  await sleep(350);
  assert.deepEqual(await faces(), ['matrix(1, 0, 0, 0, 0, 0)', 'none'], 'the Shift face shows');
  // The download button (the helper there): its Replace face; export its metadata face.
  assert.equal(await shown('.card-btn-dl'), 'Replace images from CBZ');
  await sleep(350);
  assert.equal(await page.$eval(`${DRIVEN} .card-btn-dl .face-shift`, (f) => getComputedStyle(f).transform), 'none');
  assert.equal(await page.$eval(`${DRIVEN} .card-btn-del .face-rest`, (f) => getComputedStyle(f).transform), 'none', 'the pointer gone, delete back at rest');
  await page.keyboard.up('Shift');
  await sleep(350);
  assert.equal(await page.$eval('[data-section="gallery-card"] > div', (s) => s.classList.contains('shift-held')), false);
  assert.equal(await page.$eval(`${DRIVEN} .card-btn-dl .face-rest`, (f) => getComputedStyle(f).transform), 'none');
  assert.equal(await tipText(page), 'Download all 3 pages');
  // A button with no Shift face (translate, not translated) turns to nothing.
  assert.equal(await page.$eval(`${DRIVEN} .card-btn-translate`, (b) => b.querySelectorAll('.face-shift').length), 0);
  // Nothing holding text moves by opacity or transform.
  assert.deepEqual((await textMotion(page, DRIVEN)).filter((x) => !/card-actions/.test(x)), []);
  assert.deepEqual(page.problems, []);
});

test('the keyboard: every control in order, tags left out as in 1.3, the quick actions showing', async (t) => {
  const page = await page$(t);
  if (!page) return;
  await drive(page, { g: 'sourced', cover: 'sourced', modes: { quickActions: 'hover' } });
  await sleep(100);
  await page.evaluate((sel) => { const c = document.querySelector(sel); c.scrollIntoView({ block: 'center' }); c.querySelector('.card-thumb-wrap').focus(); }, DRIVEN);
  const order = [];
  for (let i = 0; i < 9; i++) {
    order.push(await page.evaluate((sel) => { const a = document.activeElement; return document.querySelector(sel).contains(a) ? String(a.getAttribute('class')).split(' ').find((c) => /^card-(thumb-wrap|fav|btn-|id)/.test(c)) : 'outside'; }, DRIVEN));
    if (order.at(-1) === 'card-btn-dl') {
      await sleep(200);
      assert.equal(await page.$eval(`${DRIVEN} .card-actions`, (a) => [getComputedStyle(a).opacity, getComputedStyle(a).pointerEvents].join()), '1,auto', 'focused inside: the actions show');
      assert.equal(await page.evaluate(() => document.activeElement.matches(':focus-visible')), true);
    }
    await page.keyboard.press('Tab');
  }
  assert.deepEqual(order, ['card-thumb-wrap', 'card-fav', 'card-btn-open', 'card-id', 'card-btn-dl', 'card-btn-translate', 'card-btn-export', 'card-btn-del', 'outside']);
  await sleep(200);
  assert.equal(await page.$eval(`${DRIVEN} .card-actions`, (a) => getComputedStyle(a).opacity), '0', 'focus gone, hover mode: hidden again');
  // A press with the mouse leaves no ring.
  const at = await centre(page, `${DRIVEN} .card-btn-export`);
  await page.mouse.click(at.x, at.y);
  assert.equal(await page.evaluate(() => document.querySelectorAll(':focus-visible').length), 0);
  assert.deepEqual(page.problems, []);
});

test('each handler, called with the gallery\'s id, as 1.3 chose by Shift, Alt and the button\'s form; nothing else happens', async (t) => {
  const page = await page$(t);
  if (!page) return;
  const url = page.url();
  const press = async (detail, sel, { keys = [], button = 'left' } = {}) => {
    await drive(page, { modes: { quickActions: 'always' }, ...detail });
    await sleep(60);
    const at = await centre(page, `${DRIVEN} ${sel}`);
    for (const k of keys) await page.keyboard.down(k);
    await page.mouse.click(at.x, at.y, { button });
    for (const k of keys.reverse()) await page.keyboard.up(k);
    await sleep(60);
    return calls(page);
  };
  const plain = { g: 'plain', cover: 'plain', env: {}, job: null, pending: null };
  const P = '1790000001051', S = '1790000001053', T = '1790000001056', L = '1790000001059';
  const sourced = { ...plain, g: 'sourced', cover: 'sourced', env: { helper: true } };
  const translated = { ...plain, g: 'translated', cover: 'translated' };
  const CASES = [
    [plain, '.card-fav', {}, [['favorite', P]]],
    [plain, '.card-fav', { keys: ['Alt'] }, [['searchFavorite', P]]],
    [plain, '.card-btn-open', {}, [['editSource', P]]],                       // no link yet
    [sourced, '.card-btn-open', {}, [['openSource', S]]],
    [sourced, '.card-btn-open', { keys: ['Shift'] }, [['editSource', S]]],
    [sourced, '.card-btn-open', { keys: ['Alt'] }, [['searchSource', S]]],
    [plain, '.card-btn-dl', {}, [['replace', P]]],                             // nothing to download from
    [sourced, '.card-btn-dl', {}, [['download', S]]],
    [sourced, '.card-btn-dl', { keys: ['Shift'] }, [['replace', S]]],
    [plain, '.card-btn-translate', {}, [['translate', P]]],
    [plain, '.card-btn-translate', { keys: ['Alt'] }, [['searchTranslated', P]]],
    [plain, '.card-btn-translate', { keys: ['Shift'] }, [['translate', P]]],   // nothing to revert
    [translated, '.card-btn-translate', { keys: ['Shift'] }, [['revert', T]]],
    [translated, '.card-btn-translate', { button: 'right' }, [['rerun', T, 'element:card-btn-translate']]],
    [plain, '.card-btn-translate', { button: 'right' }, []],                    // not translated: the browser's own menu
    // A translation just finished, its last word still showing: the button is pressable again (1.3's was).
    [{ ...translated, job: { gid: T, kind: 'translate', status: 'done', done: 3, total: 3 } }, '.card-btn-translate', { button: 'right' }, [['rerun', T, 'element:card-btn-translate']]],
    [plain, '.card-btn-export', {}, [['export', P]]],
    [plain, '.card-btn-export', { keys: ['Shift'] }, [['exportMetadata', P]]],
    [plain, '.card-btn-del', {}, [['remove', P]]],
    [plain, '.card-btn-del', { keys: ['Shift'] }, [['quickRemove', P]]],
    [plain, '.card-tag[data-type="tag"]', {}, [['tag', P, { type: 'tag', name: 'smoke' }]]],
    [plain, '.card-tag[data-type="tag"]', { keys: ['Shift'] }, [['removeTag', P, { type: 'tag', name: 'smoke' }]]],
    [plain, '.card-tag-add', {}, [['addTag', P]]],
    [{ ...plain, g: 'long', cover: 'long' }, '.card-tag-flag', {}, [['flag', L, 'ja', 'japanese']]],
    [{ ...plain, g: 'long', cover: 'long' }, '.card-tag-flag', { keys: ['Shift'] }, [['removeFlag', L, 'ja']]],
    // A job's Stop, pressed twice: each press reaches it (1.3 never held it).
    [{ ...sourced, job: { gid: S, kind: 'download', status: 'progress', done: 1, total: 3 } }, '.card-btn-dl', {}, [['stopDownload', S]]],
    [{ ...translated, job: { gid: T, kind: 'translate', status: 'progress', pct: 20 } }, '.card-btn-translate', {}, [['cancelTranslate', T]]],
    [{ ...translated, job: { gid: T, kind: 'translate', status: 'progress', pct: 20 } }, '.card-btn-translate', { button: 'right' }, []],
  ];
  for (const [detail, sel, how, want] of CASES) {
    assert.deepEqual(await press(detail, sel, how), want, `${detail.g} ${sel} ${JSON.stringify(how)}`);
  }
  // Stop again at once.
  await drive(page, { ...sourced, job: { gid: S, kind: 'download', status: 'progress', done: 1, total: 3 } });
  const stop = await centre(page, `${DRIVEN} .card-btn-dl`);
  await page.mouse.click(stop.x, stop.y);
  await page.mouse.click(stop.x, stop.y);
  assert.deepEqual(await calls(page), [['stopDownload', S], ['stopDownload', S]]);
  // A press held, no word yet: the button off, nothing called.
  await drive(page, { ...sourced, job: null, pending: 'download' });
  await sleep(60);
  assert.equal(await page.$eval(`${DRIVEN} .card-btn-dl`, (b) => [b.disabled, b.textContent].join()), 'true,…');
  assert.equal(await page.$eval(`${DRIVEN} .card-prog-label`, (l) => l.textContent), 'Fetching metadata…');
  // The cover: a mouse's press is handed over (the drag is the page's); the link not followed.
  await drive(page, { ...plain });
  await sleep(60);
  const cover = await centre(page, `${DRIVEN} .card-thumb-wrap`);
  await page.mouse.move(cover.x, cover.y);
  await page.mouse.down();
  await page.mouse.move(cover.x, cover.y + 600, { steps: 4 });
  await page.mouse.up();
  assert.deepEqual(await calls(page), [['coverPointerDown', P, 'event:pointerdown']]);
  // Nothing else: the page where it was, nothing asked of the network, nothing unhandled.
  assert.equal(page.url(), url);
  assert.deepEqual(page.refused, []);
  assert.deepEqual(page.problems, []);
});

test('a job\'s states one after another on one card: its bar, its line, the Stop it holds, its last word\'s while', async (t) => {
  const page = await page$(t);
  if (!page) return;
  const S = '1790000001053';
  await drive(page, { g: 'sourced', cover: 'sourced', env: { helper: true }, modes: { quickActions: 'always' }, lingerMs: 600, job: null });
  await sleep(100);
  // Every state the card passes through, as it changes (a state may stand for a frame).
  await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    const look = () => {
      const dl = c.querySelector('.card-btn-dl'), tr = c.querySelector('.card-btn-translate'), fill = c.querySelector('.prog-fill');
      return JSON.stringify({
        shown: c.querySelector('.card-body').classList.contains('downloading'),
        bar: fill.style.width || null, done: fill.hasAttribute('data-done'), moving: getComputedStyle(fill).animationName !== 'none',
        label: c.querySelector('.card-prog-label').textContent,
        dl: [dl.classList.contains('cancelling') ? 'stop' : dl.textContent === '✓' ? 'done' : dl.textContent === '…' ? 'pressed' : 'rest', dl.disabled, dl.dataset.tip],
        tr: [tr.classList.contains('cancelling') ? 'stop' : 'rest', tr.disabled, tr.dataset.tip, tr.dataset.tipShift ?? null],
      });
    };
    window.__states = [look()];
    new MutationObserver(() => { const s = look(); if (s !== window.__states.at(-1)) window.__states.push(s); })
      .observe(c, { subtree: true, childList: true, attributes: true, characterData: true });
  }, DRIVEN);
  const news = async (job) => { await page.evaluate((job) => window.dispatchEvent(new CustomEvent('gallery-card-drive', { detail: { job } })), job); await sleep(80); };
  await news({ gid: S, kind: 'download', status: 'started', total: 4 });
  await news({ gid: S, kind: 'download', status: 'downloading', downloaded: 2048 });
  await news({ gid: S, kind: 'download', status: 'downloading', downloaded: 2048, total: 8192, pages: 4 });
  await news({ gid: S, kind: 'download', status: 'progress', done: 2, total: 4 });
  await news({ gid: S, kind: 'download', status: 'done', done: 4, total: 4 });
  await until(page, () => window.__galleryCardCalls?.some((c) => c[0] === 'jobSettled'), null, { what: 'the last word\'s while over' });
  await sleep(100);
  const download = (await page.evaluate(() => window.__states)).map((s) => JSON.parse(s));
  const D = 'Download all 3 pages';
  assert.deepEqual(download, [
    { shown: false, bar: '0%', done: false, moving: false, label: '', dl: ['rest', false, D], tr: ['rest', false, 'Translate gallery', null] },
    { shown: true, bar: '0%', done: false, moving: false, label: '0 / 4', dl: ['stop', false, 'Stop downloading'], tr: ['rest', false, 'Translate gallery', null] },
    { shown: true, bar: null, done: false, moving: true, label: '↓ 2KB', dl: ['stop', false, 'Stop downloading'], tr: ['rest', false, 'Translate gallery', null] },
    { shown: true, bar: '21%', done: false, moving: false, label: '~1 / 4 · 2KB', dl: ['stop', false, 'Stop downloading'], tr: ['rest', false, 'Translate gallery', null] },
    { shown: true, bar: '93%', done: false, moving: false, label: '2 / 4', dl: ['stop', false, 'Stop downloading'], tr: ['rest', false, 'Translate gallery', null] },
    { shown: true, bar: '100%', done: true, moving: false, label: 'Done — 4/4', dl: ['done', false, D], tr: ['rest', false, 'Translate gallery', null] },
    { shown: false, bar: '0%', done: false, moving: false, label: '', dl: ['rest', false, D], tr: ['rest', false, 'Translate gallery', null] },
  ].map((s, i) => (i === 0 ? s : s)), 'a download');
  assert.deepEqual(await calls(page), [['jobSettled', S]], 'told once its while is over');

  // A translation: stopped by its Stop, "Cancelled" where it showed; then one that fails, its bar
  // left where it was; then an interruption.
  await page.evaluate(() => { window.__states = [window.__states.at(-1)]; window.__galleryCardCalls = []; });
  await news({ gid: S, kind: 'translate', status: 'progress', pct: 40, labelKey: 'prog.translating' });
  await news({ gid: S, kind: 'translate', status: 'cancelled' });
  await until(page, () => window.__galleryCardCalls?.length === 1, null, { what: 'the cancel\'s while over' });
  await news({ gid: S, kind: 'download', status: 'progress', done: 1, total: 4 });
  await news({ gid: S, kind: 'download', status: 'error', errorKey: 'prog.cancelled' });
  await until(page, () => window.__galleryCardCalls?.length === 2, null, { what: 'the error\'s while over' });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gallery-card-drive', { detail: { job: null, interrupted: true } })));
  await until(page, () => window.__galleryCardCalls?.length === 3, null, { what: 'the interruption\'s while over' });
  await sleep(100);
  const more = (await page.evaluate(() => window.__states)).map((s) => JSON.parse(s)).map((s) => [s.shown, s.bar, s.label, s.dl[0], s.tr[0], s.tr[2]]);
  assert.deepEqual(more, [
    [false, '0%', '', 'rest', 'rest', 'Translate gallery'],
    [true, '40%', 'Translating…', 'rest', 'stop', 'Stop translating'],
    [true, '0%', 'Cancelled', 'rest', 'rest', 'Translate gallery'],
    [false, '0%', '', 'rest', 'rest', 'Translate gallery'],
    [true, '89%', '1 / 4', 'stop', 'rest', 'Translate gallery'],
    [true, '89%', 'Error: Cancelled', 'rest', 'rest', 'Translate gallery'],
    [false, '0%', '', 'rest', 'rest', 'Translate gallery'],
    [true, '0%', 'Interrupted — run again to resume', 'rest', 'rest', 'Translate gallery'],
    [false, '0%', '', 'rest', 'rest', 'Translate gallery'],
  ]);
  // While the translation ran its Stop had no Shift or Alt words.
  assert.ok((await page.evaluate(() => window.__states)).map((s) => JSON.parse(s)).filter((s) => s.tr[0] === 'stop').every((s) => s.tr[3] === null));
  // News after an interruption's hint shows in its place (the card is still told of that interruption):
  // a job that fails with no figure yet, its bar's motion stopped and empty (1.3 took the motion away).
  await page.evaluate(() => { window.__states = [window.__states.at(-1)]; window.__galleryCardCalls = []; });
  await news({ gid: S, kind: 'download', status: 'downloading', downloaded: 2048 });
  await news({ gid: S, kind: 'download', status: 'error', error: 'gone' });
  await until(page, () => window.__galleryCardCalls?.length === 1, null, { what: 'this error\'s while over' });
  await sleep(100);
  assert.deepEqual((await page.evaluate(() => window.__states)).map((s) => JSON.parse(s)).map((s) => [s.shown, s.bar, s.moving, s.label]), [
    [false, '0%', false, ''],
    [true, null, true, '↓ 2KB'],
    [true, '0%', false, 'Error: gone'],
    [false, '0%', false, ''],
  ]);
  // And a word said while the hint still shows takes its place at once.
  await page.evaluate(() => { window.__states = [window.__states.at(-1)]; window.__galleryCardCalls = []; window.dispatchEvent(new CustomEvent('gallery-card-drive', { detail: { job: null, interrupted: false } })); });
  await sleep(80);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gallery-card-drive', { detail: { interrupted: true } })));
  await sleep(80);
  await news({ gid: S, kind: 'download', status: 'error', error: 'gone' });
  await until(page, () => window.__galleryCardCalls?.length === 1, null, { what: 'the later word\'s while over' });
  await sleep(100);
  assert.deepEqual((await page.evaluate(() => window.__states)).map((s) => JSON.parse(s)).map((s) => [s.shown, s.label]), [
    [false, ''],
    [true, 'Interrupted — run again to resume'],
    [true, 'Error: gone'],
    [false, ''],
  ]);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gallery-card-drive', { detail: { job: null, interrupted: false } })));
  await sleep(80);
  // A cancelled job the card wasn't showing brings nothing up.
  await page.evaluate(() => { window.__states = [window.__states.at(-1)]; });
  await news({ gid: S, kind: 'download', status: 'cancelled' });
  const quiet = (await page.evaluate(() => window.__states)).map((s) => JSON.parse(s));
  assert.ok(quiet.some((s) => s.label === 'Cancelled'), 'the word is there (as 1.3 set it)');
  assert.ok(quiet.every((s) => !s.shown), 'and its place stays shut');
  assert.deepEqual(page.problems, []);
});

test('one part changing leaves the others\' nodes, the cover not loaded again; a hovered card stays grown', async (t) => {
  const page = await page$(t);
  if (!page) return;
  const P = '1790000001051';
  const base = { id: P, count: 3, numPages: 3, size: 14394, origSize: 12913, aggPages: 3, aggSize: 14394, aggOrig: 12913, medianPage: { w: 600, h: 860, mp: 0.516, tier: 'T1' },
    title: { english: 'Plain', japanese: '', pretty: '' }, tags: Array.from({ length: 24 }, (_, i) => ({ type: 'tag', name: `tag number ${i}` })), languages: [], favorite: false };
  await drive(page, { g: base, cover: 'plain', modes: { quickActions: 'hover' }, lingerMs: 60000 });
  await until(page, (sel) => document.querySelector(`${sel} img.card-thumb`)?.complete, DRIVEN, { what: 'the cover' });
  await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    window.__kept = new Map();
    for (const el of [c, ...c.querySelectorAll('*')]) el.__kept = true;
    const img = c.querySelector('img.card-thumb');
    window.__loads = 0;
    img.addEventListener('load', () => { window.__loads++; });
  }, DRIVEN);
  const unkept = (keep) => page.$eval(DRIVEN, (c, keep) => [c, ...c.querySelectorAll('*')].filter((el) => !el.__kept && !el.closest(keep)).map((el) => el.localName + '.' + el.className), keep);
  // Hovered, grown.
  const at = await centre(page, `${DRIVEN} .card-meta`);
  await page.mouse.move(at.x, at.y, { steps: 3 });
  await sleep(450);
  const grown = await page.$eval(DRIVEN, (c) => c.getBoundingClientRect().height);
  // A favourite: the heart alone.
  await drive(page, { g: { ...base, favorite: true } });
  await sleep(80);
  assert.equal(await page.$eval(`${DRIVEN} .card-fav`, (b) => b.getAttribute('aria-pressed')), 'true');
  assert.deepEqual(await unkept('.card-fav'), [], 'a favourite: nothing but the heart made again');
  // A new title, a new tag, a job under way: each its own part.
  await drive(page, { g: { ...base, favorite: true, title: { english: 'Renamed', japanese: '', pretty: '' } } });
  await sleep(80);
  assert.equal(await page.$eval(`${DRIVEN} .card-title`, (e) => e.textContent), 'Renamed');
  await drive(page, { g: { ...base, favorite: true, title: { english: 'Renamed', japanese: '', pretty: '' }, tags: [...base.tags, { type: 'tag', name: 'new one' }] } });
  await sleep(450);
  const now = await page.$eval(DRIVEN, (c) => [c.matches(':hover'), c.getBoundingClientRect().height]);
  assert.ok(now[0] && now[1] >= grown - 0.5, `still hovered and grown (${grown} → ${now[1]})`);
  await drive(page, { job: { gid: P, kind: 'download', status: 'progress', done: 1, total: 3 } });
  await sleep(80);
  assert.deepEqual(await unkept('.card-fav, .card-tags, .card-btn-dl'), [], 'only the changed parts made again');
  assert.equal(await page.$eval(DRIVEN, (c) => c.matches(':hover')), true, 'still hovered mid-job');
  assert.equal(await page.evaluate(() => window.__loads), 0, 'the cover never loaded again');
  // A cover that changes: the same <img>, loaded once.
  await drive(page, { cover: 'tagged' });
  await until(page, () => window.__loads === 1, null, { what: 'the new cover' });
  assert.equal(await page.$eval(`${DRIVEN} img.card-thumb`, (i) => i.__kept), true, 'the same <img>');
  // No cover at hand for a while: the last one stays.
  await drive(page, { cover: null });
  await sleep(80);
  assert.ok(await page.$eval(`${DRIVEN} img.card-thumb`, (i) => i.getAttribute('src')?.startsWith('data:image/')), 'the last cover kept');
  assert.equal(await page.evaluate(() => window.__loads), 1);
  assert.deepEqual(page.problems, []);
});

test('a landscape cover sits whole with a glow behind it; a portrait one fills its place, no glow', async (t) => {
  const page = await page$(t);
  if (!page) return;
  const look = (variant) => page.$eval(card(variant), (c) => {
    const img = c.querySelector('img.card-thumb'), glow = c.querySelector('.card-thumb-glow');
    return { landscape: img.classList.contains('landscape'), fit: getComputedStyle(img).objectFit, glow: glow ? [glow.getAttribute('src').slice(0, 22), /^blur\([\d.]+cqw\)$/.test(glow.style.filter), glow.getAttribute('aria-hidden')] : null };
  });
  assert.deepEqual(await look('landscape'), { landscape: true, fit: 'contain', glow: ['data:image/png;base64,', true, 'true'] });
  for (const v of ['tagged', 'plain', 'small', 'series']) assert.deepEqual(await look(v), { landscape: false, fit: 'cover', glow: null }, v);
  // The glow overhangs the cover by half its size a side; the cover's place cuts it.
  const boxes = await page.$eval(card('landscape'), (c) => [c.querySelector('.card-thumb-wrap'), c.querySelector('.card-thumb-glow')].map((e) => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }));
  assert.deepEqual(boxes[1], [boxes[0][0] * 2, boxes[0][1] * 2]);
  // A portrait cover the landscape one turns into, and back: the glow follows.
  await drive(page, { g: 'landscape', cover: 'landscape' });
  await until(page, (sel) => !!document.querySelector(`${sel} .card-thumb-glow`), DRIVEN, { what: 'the glow' });
  await drive(page, { cover: 'plain' });
  await until(page, (sel) => !document.querySelector(`${sel} .card-thumb-glow`) && !document.querySelector(`${sel} img.landscape`), DRIVEN, { what: 'no glow' });
  assert.deepEqual(page.problems, []);
});

test('leaving the page and coming back five times leaves nothing behind', async (t) => {
  const page = await page$(t);
  if (!page) return;
  const cdp = await page.createCDPSession();
  const listeners = async (expr) => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
    return (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.map((l) => l.type).sort();
  };
  const held = async () => ({ window: await listeners('window'), document: await listeners('document'), ...await page.evaluate(() => ({
    timeouts: [...window.__live.timeouts.values()].filter((ms) => ms > 0).length, intervals: window.__live.intervals.size, observers: window.__live.observers.size,
    urls: window.__live.urls.size, canvases: document.querySelectorAll('canvas').length,
  })) });
  const away = async () => {
    await page.evaluate(() => { history.pushState(null, '', '/tasks'); dispatchEvent(new PopStateEvent('popstate')); });
    await until(page, () => document.title === 'Shiori — Tasks' && !document.querySelector('[data-section="gallery-card"]'), null, { what: 'Tasks' });
    await sleep(300);
  };
  const back = async () => {
    await page.evaluate(() => history.back());
    await until(page, () => document.querySelector('[data-section="gallery-card"] [data-covers="ready"]')
      && [...document.querySelectorAll('[data-section="gallery-card"] img.card-thumb[src]')].every((i) => i.complete), null, { what: 'the cards again' });
    await sleep(600);
  };
  await away();
  const first = await held();
  await back();
  for (let i = 0; i < 5; i++) { await away(); await back(); }
  await away();
  const last = await held();
  assert.deepEqual(last, first, 'the same listeners, timers, observers, object URLs and canvases as after the first time away');
  assert.equal(last.canvases, 0, 'no glow\'s canvas kept');
  assert.equal(last.urls, 0, 'no object URL left');
  await cdp.detach();
  assert.deepEqual(page.problems, []);
});

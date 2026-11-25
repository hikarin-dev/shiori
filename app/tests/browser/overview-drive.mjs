// overview-drive.mjs — driving the overview for the tests that hold the one page's (/overview-next) to
// 1.3's (/overview), both pages driven alike over one seeded library, 1.3's page the oracle: a run's
// galleries, the page read as words, links and tips (read), every part's box (boxes), and waiting for a
// page to have drawn what it will (settled). A run's galleries are named by their parts, never by ids.
import { setTimeout as sleep } from 'node:timers/promises';
import { openPage, until } from './harness.mjs';
import { standInHelper, HELPER_STATUS } from './stand-in-helper.mjs';

export { sleep };
export const OLD = '/overview';
export const NEW = '/overview-next';

// The parts of a run's library, each a gallery at `base + n`:
//   G   a gallery: 3 of its 4 pages, from Site One with a link, posted, translated, a favourite, tags
//       of every kind the table shows (two female, a male), its category and rating, a Japanese title
//   S   a series' owner (chapter 1, its title the gallery's), S2 its chapter 2 (a title of its own),
//       S3 an extra (chapter 2.5), V1 and V2 its volumes, and X a member whose gallery is gone; the
//       series' own title in English and Japanese, its tags
//   W   a series of volumes alone (W, W2)
//   E   a gallery with no pages
//   F   a gallery of one page, in no series
//   N   none at first: a test's gallery made later
export const PARTS = { G: 10, S: 20, S2: 21, S3: 22, V1: 23, V2: 24, X: 25, W: 30, W2: 31, E: 40, F: 45, N: 50 };
let runs = 0;
export const nextBase = (start) => start + (runs++) * 100;
export const gid = (base, part) => String(base + PARTS[part]);

async function seed({ base, parts }) {
  const api = await import('/app/js/api.js');
  const id = (part) => String(base + parts[part]);
  const png = async (hue, w = 300, h = 430) => { const c = new OffscreenCanvas(w, h); const x = c.getContext('2d'); x.fillStyle = `hsl(${hue} 60% 50%)`; x.fillRect(0, 0, w, h); return c.convertToBlob({ type: 'image/png' }); };
  const title = (english, japanese = '') => ({ english, japanese, pretty: '' });
  const tags = [{ type: 'language', name: 'japanese' }, { type: 'artist', name: 'someone' }, { type: 'group', name: 'a circle' }, { type: 'parody', name: 'original' },
    { type: 'character', name: 'a hero' }, { type: 'tag:female', name: 'glasses' }, { type: 'tag:male', name: 'beard' }, { type: 'tag', name: 'alpha' },
    { type: 'tag', name: 'beta' }, { type: 'category', name: 'manga' }, { type: 'rating', name: 'safe' }].map((tg) => ({ ...tg, url: '' }));
  const gallery = async (part, meta, pages, { w = 300 } = {}) => {
    await api.meta.put({ galleryId: id(part), title: title(`${part} gallery`), tags: [], numPages: pages, ...meta });
    for (let n = 1; n <= pages; n++) await api.pages.put(id(part), n, await png((base % 360) + n * 30 + parts[part], n === 2 ? w : 300));
  };
  await gallery('G', { title: title('G gallery', 'Gギャラリー'), tags, source: 'a.example', sourceId: '701', sourceUrl: 'https://a.example/g/701', uploadDate: 1700000000, translated: true, numPages: 4 }, 3, { w: 600 });
  await api.personal.favorite(id('G'), true);
  await gallery('S2', { source: 'a.example', sourceId: '722', sourceUrl: 'https://a.example/g/722', tags: tags.slice(0, 3) }, 2);
  await gallery('S3', { source: 'a.example', sourceId: '723', translated: true }, 1);
  await gallery('V1', { source: 'a.example', sourceId: '724' }, 1);
  await gallery('V2', { source: 'a.example', sourceId: '725' }, 2);
  await gallery('S', { source: 'a.example', sourceId: '720', sourceUrl: 'https://a.example/g/720', tags }, 2);
  await api.series.write(id('S'), [{ id: id('S'), title: '', number: 1 }, { id: id('S2'), title: 'The second', number: 2 }, { id: id('S3'), title: '', number: 2.5 },
    { id: id('V1'), title: '', kind: 'volume' }, { id: id('V2'), title: 'Volume two', kind: 'volume' }],
  { seriesTitle: title('S series', 'Sシリーズ'), seriesTags: tags });
  // X: a place in the series whose gallery is not in the library, a row for a missing chapter.
  const owner = await api.meta.get(id('S'));
  await api.meta.put({ ...owner, chapters: [...owner.chapters, { id: id('X'), title: 'Gone', number: 3 }] });
  await gallery('W2', {}, 1);
  await gallery('W', {}, 1);
  await api.series.write(id('W'), [{ id: id('W'), title: '', kind: 'volume' }, { id: id('W2'), title: '', kind: 'volume' }], { seriesTitle: title('W volumes') });
  await gallery('E', { source: 'a.example', sourceId: '740', numPages: 5 }, 1);
  await api.pages.prune(id('E'), []);
  await gallery('F', {}, 1);
}

// The run's galleries made (from /tasks), the jobs registry emptied, the page's settings stored. Each
// page then opened at `path` waits for `settled`.
export async function seedRun(page, origin, base, { helper = true, storage = {} } = {}) {
  await page.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await page.evaluate(seed, { base, parts: PARTS });
  await page.evaluate(async () => (await import('/app/js/migrations.js')).runMigrations());
  // Each gallery's typical page measured, and each series' from its chapters', now: the library measures
  // them 3 s after a gallery's pages stop changing, on a timer of the page that stored them, which this
  // seeding page leaves at once; the overview then asks again as it reads, so under load 1.3's page was
  // read before the size had come and the new page after it ("a gallery at 1280", six copies at once).
  await page.evaluate(async ({ base, parts }) => {
    const db = await import('/app/js/db.js');
    for (const n of Object.values(parts)) await db.refreshMedianPage(String(base + n));
    for (const part of ['S', 'W']) await db.refreshSeriesAggregate(String(base + parts[part]));
  }, { base, parts: PARTS });
  await page.evaluate(async (stored) => {
    const platform = await import('/app/js/platform.js');
    for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind);
    for (const k of Object.keys(localStorage)) if (k.startsWith('shiori:') || k === 'shiori-ext-status') localStorage.removeItem(k);
    for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  }, { ...(helper ? HELPER_STATUS : {}), ...storage });
}

export async function openRun(browser, origin, base, opts = {}) {
  const page = await openPage(browser, origin, { allow: opts.translator ? [opts.translator] : [] });
  if (opts.helper !== false) await standInHelper(page);
  await seedRun(page, origin, base, opts);
  return page;
}

// Until the overview at `path` has drawn what it will: its hero's cover, every row's cover, the tags,
// the page grid's tiles in view.
export async function settled(page) {
  await until(page, () => !!document.querySelector('#ovContent .ov-hero, #ovContent .ov-empty'), null, { what: 'the overview drawn' });
  // The covers and the tiles in view, as far as they come within 5 s (a gallery with no pages has none).
  await until(page, () => {
    const content = document.getElementById('ovContent');
    if (content.querySelector('.ov-empty')) return true;
    if (!content.querySelector('#seriesCover img')?.complete) return false;
    if ([...content.querySelectorAll('.ch-row:not(.missing) .ch-thumb')].some((t) => !t.querySelector('img')?.complete)) return false;
    const tiles = [...content.querySelectorAll('#ovPages .ov-page img')].filter((img) => { const r = img.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
    return tiles.every((img) => img.getAttribute('src') && img.complete);
  }, null, { what: 'the covers and tiles', timeout: 5000 }).catch(() => {});
  await sleep(200);
}

export async function visit(page, origin, path, gidOrQuery) {
  await page.goto(`${origin}${path}${gidOrQuery == null ? '' : `?g=${gidOrQuery}`}`, { waitUntil: 'load' });
  await settled(page);
}

// In the page: the overview as words, links and tips (an address as it resolves, from the site's root).
export function read() {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const link = (el) => (el?.getAttribute('href') != null ? new URL(el.href).href.replace(location.origin, '') : null);
  const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const tip = (el) => (el ? { tip: el.dataset.tip ?? null, shift: el.dataset.tipShift ?? null, badge: el.dataset.tipBadge ?? null } : null);
  const content = document.getElementById('ovContent');
  if (content.querySelector('.ov-empty')) return { empty: text(content.querySelector('.ov-empty')) };
  const title = content.querySelector('.series-title-input');
  const actions = [...content.querySelectorAll('.series-actions > *')].map((b) => ({
    id: b.id, text: text(b), href: shown(b) ? link(b) : null, ...tip(b), shown: shown(b), pressed: b.getAttribute('aria-pressed'), disabled: !!b.disabled,
    target: b.getAttribute('target'), filled: !!b.querySelector('svg') && getComputedStyle(b.querySelector('svg')).fill !== 'none' }));
  const meta = [...content.querySelectorAll('#ovMeta .ov-meta-line')].map((line) => [...line.children].map((item) => ({
    text: text(item), icon: !!item.querySelector('svg'), cls: [...item.classList].filter((c) => c !== 'ov-meta-item').sort().join(' '),
    ...tip(item), tag: item.dataset.tagType ? `${item.dataset.tagType}:${item.dataset.tagName}` : null })));
  const tagTable = content.querySelector('#ovTags');
  const tags = tagTable ? { shown: shown(tagTable), rows: [...tagTable.querySelectorAll('.ov-tag-row')].map((row) => ({
    label: text(row.querySelector('.ov-tag-label')),
    chips: [...row.querySelectorAll('.ov-chip')].map((chip) => ({ text: text(chip), count: text(chip.querySelector('.ov-chip-n, [data-slot="tag-count"]')), href: link(chip), shown: shown(chip), type: chip.dataset.type ?? null, tip: chip.dataset.tip ?? null })) })) } : null;
  const section = content.querySelector('#ovSection');
  const views = [...section.querySelectorAll('[data-view]')].map((b) => ({ view: b.dataset.view, text: text(b), selected: b.getAttribute('aria-selected') }));
  const rows = [...content.querySelectorAll('.ch-row')].map((row) => {
    const input = row.querySelector('.ch-title-input, [data-slot="inline-edit"]');
    return {
      id: row.dataset.chapterId,
      state: ['missing', 'working', 'expanded'].filter((c) => row.classList.contains(c)),
      num: text(row.querySelector('.ch-num')),
      title: input.value, placeholder: input.placeholder, readOnly: input.readOnly,
      titleHref: link(row.querySelector('.ch-title-open')), titleLabel: row.querySelector('.ch-title-open').getAttribute('aria-label'),
      thumbHref: link(row.querySelector('.ch-thumb')), thumbImg: !!row.querySelector('.ch-thumb img'),
      meta: [...row.querySelector('.ch-meta').children].map((el) => ({ text: text(el), href: link(el), cls: el.className || null, target: el.getAttribute('target') })),
      progress: shown(row.querySelector('.ch-progress')) ? { label: text(row.querySelector('.ch-prog-label')),
        // The bar: how far it is filled (its share of the track, to a whole per cent once still), whether it moves, done.
        fill: (() => { const fill = row.querySelector('.prog-fill'); return fill.classList.contains('indeterminate') ? 'moving' : `${Math.round(parseFloat(fill.style.width) || 0)}%`; })(),
        done: row.querySelector('.prog-fill').classList.contains('done') } : null,
      grip: row.querySelector('.ch-grip')?.dataset.tip ?? null,
      actions: [...row.querySelectorAll('.ch-actions > button')].map((b) => ({
        kind: ['up', 'down', 'download', 'translate', 'detach', 'remove'].find((k) => b.hasAttribute(`data-${k}`)),
        ...tip(b), disabled: b.disabled, shown: getComputedStyle(b).display !== 'none',
        state: ['cancelling', 'done'].filter((c) => b.classList.contains(c)),
        // Its face: the icon at rest (its first line's drawing), or its words.
        face: b.querySelector('svg') ? (b.querySelector('.face-rest svg, svg').querySelector('path, rect')?.getAttribute('d') ?? 'rect') : text(b) })),
      expand: row.querySelector('[data-expand]') ? { expanded: row.querySelector('[data-expand]').getAttribute('aria-expanded'), ...tip(row.querySelector('[data-expand]')) } : null,
      pages: [...row.querySelectorAll('.ch-pages .ov-page')].map((a) => ({ href: link(a), num: text(a.querySelector('.ov-page-num')) })),
    };
  });
  const grid = content.querySelector('#ovPages');
  return {
    title: document.title,
    hero: {
      title: title.value, titleId: title.id, placeholder: title.placeholder, readOnly: title.readOnly,
      titleHref: link(content.querySelector('.series-title-open')), titleLabel: content.querySelector('.series-title-open').getAttribute('aria-label'),
      subtitle: shown(content.querySelector('#ovSubtitle')) ? text(content.querySelector('#ovSubtitle')) : null,
      coverHref: link(content.querySelector('#seriesCover')), cover: !!content.querySelector('#seriesCover img'),
      backdrop: !!content.querySelector('#ovBackdrop')?.style.backgroundImage,
      actions, meta, tags,
    },
    section: { views, text: views.length ? null : text(section.firstChild), count: text(section.querySelector('.ov-count')) },
    rows,
    grid: grid ? { tiles: [...grid.querySelectorAll('.ov-page')].map((a) => ({ href: link(a), num: text(a.querySelector('.ov-page-num')) })), empty: text(grid.querySelector('.ov-pages-empty')) } : null,
    add: { heading: text(content.querySelector('#addHeading')), placeholder: content.querySelector('#addSearch').placeholder, hint: text(content.querySelector('.add-hint')) },
  };
}

// In the page: every part's box (x, y, width, height to a hundredth), by a name both pages share.
export function boxes() {
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const f = (n) => Math.round(n * 100) / 100; return [f(r.x), f(r.y + scrollY), f(r.width), f(r.height)]; };
  const all = (sel) => [...document.querySelectorAll(sel)].map(box);
  return {
    hero: box(document.querySelector('.ov-hero')), cover: box(document.querySelector('#seriesCover')), info: box(document.querySelector('.series-info')),
    title: box(document.querySelector('.series-title-input')), subtitle: box(document.querySelector('#ovSubtitle')),
    actions: all('.series-actions > *'), actionIcons: all('.series-actions > * svg'),
    meta: box(document.querySelector('#ovMeta')), metaItems: all('.ov-meta-item'), metaIcons: all('.ov-meta-item svg'),
    tags: box(document.querySelector('#ovTags')), tagLabels: all('.ov-tag-label'), chips: all('.ov-chip'),
    section: box(document.querySelector('#ovSection')), views: all('#ovSection [data-view]'), count: box(document.querySelector('.ov-count')),
    rows: all('.ch-row'), nums: all('.ch-num'), thumbs: all('.ch-thumb'), titles: all('.ch-row .ch-title-input, .ch-row [data-slot="inline-edit"]'),
    metas: all('.ch-meta'), metaParts: all('.ch-meta > *'), rowActions: all('.ch-actions'), rowButtons: all('.ch-actions > button'), expands: all('.ch-expand'),
    grips: all('.ch-grip'), progress: all('.ch-progress'), pages: all('.ov-page'), pageNums: all('.ov-page-num'),
    add: box(document.querySelector('#addBar')), addHeading: box(document.querySelector('#addHeading')), addSearch: box(document.querySelector('#addSearch')),
    addHint: box(document.querySelector('.add-hint')), page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
  };
}

// Every difference between two box tables larger than `tolerance` px.
export function boxDiff(a, b, tolerance = 1) {
  const out = [];
  const walk = (x, y, path) => {
    if (Array.isArray(x) && typeof x[0] === 'number' && Array.isArray(y)) {
      if (x.some((n, i) => Math.abs(n - y[i]) > tolerance)) out.push(`${path}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
      return;
    }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) { out.push(`${path}: ${x?.length} → ${y?.length} items`); return; }
      x.forEach((v, i) => walk(v, y[i], `${path}[${i}]`));
      return;
    }
    if (x && typeof x === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y ?? {})])) walk(x[k], y?.[k], `${path}.${k}`); return; }
    if (x !== y) out.push(`${path}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
  };
  walk(a, b, '');
  return out;
}

// Every id of the run in `value` named by its part.
export function named(value, base) {
  let text = JSON.stringify(value);
  for (const [part, n] of Object.entries(PARTS).sort((a, b) => b[0].length - a[0].length)) text = text.split(String(base + n)).join(`<${part}>`);
  return JSON.parse(text);
}

export const publish = (page, job) => page.evaluate(async (job) => (await import('/app/js/platform.js')).jobs.publish(job), job);

// ── Driving the buttons (7b) ──

// In the page: what it says from here on to whatever runs things (but covers and the translation
// server's ping), what it opens in a new window, the dialogs it asks. A translation asked for is
// answered "started" and goes no further (its runner is not this page's); a revert, "done".
export async function record() {
  const { services } = await import('/app/js/services.js');
  window.__said = [];
  window.__opened = [];
  const QUIET = new Set(['GET_COVER', 'TRANSLATOR_PING']);
  const handle = services.__handle ??= services.handle;
  services.handle = function (msg) {
    if (!QUIET.has(msg?.type)) window.__said.push(JSON.parse(JSON.stringify(msg)));
    if (msg?.type === 'TRANSLATE_GALLERY') return Promise.resolve(window.__refuseStart ? { ok: false, started: false } : { ok: true, started: true });
    if (msg?.type === 'REVERT_GALLERY') return Promise.resolve({ ok: true });
    return handle.call(this, msg);
  };
  window.open = (...args) => { window.__opened.push(args); return null; };
}

// What the library holds of the run after a press: each part's gallery, and the series' order, own
// titles and title (every id named by its part).
export async function outcome(page, base) {
  const out = await page.evaluate(async ({ base, parts }) => {
    const api = await import('/app/js/api.js');
    const galleries = {};
    for (const [part, n] of Object.entries(parts)) {
      const g = await api.galleries.get(String(base + n));
      galleries[part] = g ? { count: g.count, translated: !!g.translated, favorite: !!g.favorite, parent: g.parentId ? String(g.parentId) : null,
        title: g.title?.english ?? null, tags: (g.tags || []).map((t) => `${t.type}:${t.name}`) } : null;
    }
    const series = {};
    for (const part of ['S', 'S2', 'W', 'W2']) {
      const meta = await api.meta.get(String(base + parts[part]));
      if (meta?.chapters?.length) series[part] = { chapters: meta.chapters.map((c) => `${c.id}${c.title ? `:${c.title}` : ''}`), title: meta.seriesTitle ?? null };
    }
    return { said: window.__said ?? [], opened: window.__opened ?? [], galleries, series };
  }, { base, parts: PARTS });
  return named(out, base);
}

export const rowSel = (base, part) => `.ch-row[data-chapter-id="${gid(base, part)}"]`;

// A press on a row's button (`what`: up, down, download, translate, detach, remove), with Shift held or
// the right button; the row hovered first (its buttons show under the pointer).
export async function pressRow(page, base, part, what, { shift = false, right = false } = {}) {
  const sel = `${rowSel(base, part)} [data-${what}]`;
  await page.hover(`${rowSel(base, part)} .ch-main`);
  await sleep(80);
  if (shift) await page.keyboard.down('Shift');
  await page.click(sel, right ? { button: 'right' } : {});
  if (shift) await page.keyboard.up('Shift');
  await sleep(300);
}

// A press on one of the page's own parts, with Shift held.
export async function pressAt(page, sel, { shift = false } = {}) {
  if (shift) await page.keyboard.down('Shift');
  await page.click(sel);
  if (shift) await page.keyboard.up('Shift');
  await sleep(300);
}

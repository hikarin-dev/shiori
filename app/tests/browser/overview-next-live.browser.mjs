// overview-next-live.browser.mjs — the overview at /overview-next under a library that changes, held
// to what 1.3's (/overview) gave driven alike. The page is shown over a run's library while a tab behind
// it makes the changes there (another context, as a download's runner or another window is). After each
// kind of change the page reads as 1.3's did (words, links, tips, rows in order), and of what was there
// before, it leaves every row the change did not reach as the same node with its subtree untouched, keeps
// its cover pictures (no <img> put in again), and touches no more parts than 1.3's page did; a row that
// moved slides to its place as on 1.3's. The series: a chapter's title (1.3 misses it: a fault, not
// copied), its pages, its translation, the series' title, its tags, the favourite, its order, a chapter
// added, one removed. The gallery: its title, a page added (a tile more in its grid), the favourite,
// becoming a series and a gallery again.
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the overview's behaviour edits in the same commit.
// (1.3's page missed a change marked `missed`: it was read 2.5 s after the change, then loaded again to
// go on from the same library.)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, openPage, until } from './harness.mjs';
import { record } from './records.mjs';
import { openRun, nextBase, gid, visit, read, named, sleep, NEW, PARTS } from './overview-drive.mjs';

const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser, run;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  const base = nextBase(1790009300000);
  const maker = await openRun(browser, origin, base);
  const page = await openPage(browser, origin);
  run = { base, maker, page };
});
after(async () => { await browser?.close(); server?.close(); });

// In the page: everything that is there now marked, and from now on which rows (by chapter) and which
// other parts had something in them changed, and which rows slid.
function watch() {
  const content = document.getElementById('ovContent');
  for (const el of content.querySelectorAll('*')) el.__was = true;
  window.__touched = new Set();
  window.__slid = new Set();
  const where = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    const row = el?.closest?.('.ch-row');
    return row ? `row ${row.dataset.chapterId}` : el?.closest?.('.ov-hero') ? 'hero' : el?.closest?.('#ovSection') ? 'section' : el?.closest?.('#ovPages') ? 'grid' : el?.closest?.('#addBar') ? 'add' : 'list';
  };
  window.__watch?.disconnect();
  window.__watch = new MutationObserver((records) => {
    for (const r of records) {
      // (A row's slide, and the list's rows moved or added: not a change inside a row.)
      if (r.type === 'attributes' && r.attributeName === 'style' && r.target.matches?.('.ch-row')) continue;
      if (r.type === 'childList' && r.target.matches?.('.ch-list')) { for (const n of r.addedNodes) if (!n.__was) window.__touched.add(`new ${n.dataset?.chapterId}`); continue; }
      window.__touched.add(where(r.target));
    }
  });
  window.__watch.observe(content, { subtree: true, childList: true, attributes: true, characterData: true });
  const frame = () => { for (const row of document.querySelectorAll('.ch-row')) if (row.getAnimations().some((a) => { const k = a.effect?.getKeyframes?.()[0]; return k?.transform || k?.top; })) window.__slid.add(row.dataset.chapterId); window.__slideFrame = requestAnimationFrame(frame); };
  cancelAnimationFrame(window.__slideFrame);
  frame();
}
// What changed since watch(): parts touched, cover pictures put in again where one was, rows that slid,
// rows kept as the same nodes.
function seen() {
  const rows = new Set([...document.querySelectorAll('.ch-row')].map((row) => `row ${row.dataset.chapterId}`));
  const covers = [...document.querySelectorAll('#seriesCover img, .ch-row .ch-thumb img')].filter((img) => img.closest('#seriesCover, .ch-row').__was && !img.__was).length;
  // (A row gone since is not counted: what it showed on its way out is not seen.)
  return { touched: [...window.__touched].filter((p) => !p.startsWith('row ') || rows.has(p)).sort(), covers, slid: [...window.__slid].sort(),
    kept: [...document.querySelectorAll('.ch-row')].filter((row) => row.__was).map((row) => row.dataset.chapterId) };
}

const hasTitle = (title) => [...document.querySelectorAll('.ch-row [data-slot="inline-edit"], .ch-row .ch-title-input')].some((i) => i.value === title);

// Each change: what makes it (in the tab behind), and what shows it is drawn. `missed`: 1.3's page is
// known not to show it.
const SERIES = [
  { name: 'a chapter\'s title', missed: true, title: 'Renamed',
    make: async ({ id }) => { const s = await import('/app/js/series.js'); await s.setChapterTitle(id.S, id.S3, 'Renamed'); } },
  { name: 'its pages',
    make: async ({ id }) => { const api = await import('/app/js/api.js'); const c = new OffscreenCanvas(300, 430); c.getContext('2d').fillRect(0, 0, 300, 430); await api.pages.put(id.S2, 3, await c.convertToBlob({ type: 'image/png' })); },
    done: () => document.body.textContent.includes('3 / 2 pages') },
  { name: 'its translation',
    make: async ({ id }) => { const api = await import('/app/js/api.js'); const m = await api.meta.get(id.S2); await api.meta.put({ ...m, translated: true }); },
    done: () => document.querySelectorAll('.ch-row .ch-meta .done').length === 2 },
  { name: 'the series\' title', missed: true,
    make: async ({ id }) => { const s = await import('/app/js/series.js'); await s.setSeriesTitle(id.S, 'en', 'A new title'); },
    done: () => document.querySelector('.series-title-input').value === 'A new title' },
  { name: 'its tags',
    make: async ({ id }) => { const te = await import('/app/js/tag-editor.js'); await te.writeTag(id.S, 'tag', 'gamma'); },
    done: () => [...document.querySelectorAll('.ov-chip')].some((chip) => chip.textContent.startsWith('gamma')) },
  { name: 'the favourite',
    make: async ({ id }) => { const api = await import('/app/js/api.js'); await api.personal.favorite(id.S, true); },
    done: () => document.querySelector('#favToggle').getAttribute('aria-pressed') === 'true' },
  { name: 'its order',
    make: async ({ id }) => {
      const api = await import('/app/js/api.js');
      const order = (await api.meta.get(id.S)).chapters.map((c) => String(c.id));
      const i = order.indexOf(id.S2), j = order.indexOf(id.S3);
      [order[i], order[j]] = [order[j], order[i]];
      await api.series.reorder(id.S, order);
    },
    done: () => !!document.querySelectorAll('.ch-row')[2]?.dataset.chapterId?.endsWith('21') },
  { name: 'a chapter added', title: 'Added later',
    make: async ({ id }) => {
      const api = await import('/app/js/api.js');
      const c = new OffscreenCanvas(300, 430); c.getContext('2d').fillRect(0, 0, 300, 430);
      await api.meta.put({ galleryId: id.N, title: { english: 'Added later', japanese: '', pretty: '' }, tags: [], numPages: 1 });
      await api.pages.put(id.N, 1, await c.convertToBlob({ type: 'image/png' }));
      await api.series.attach(id.S, id.N);
    } },
  { name: 'one removed',
    make: async ({ id }) => { const api = await import('/app/js/api.js'); await api.series.remove(id.S, id.S2, { deleteImages: false }); },
    done: () => !document.querySelector('.ch-row[data-chapter-id$="21"]') },
];
const GALLERY = [
  { name: 'its title',
    make: async ({ id }) => { const s = await import('/app/js/series.js'); await s.setGalleryTitle(id.G, 'en', 'Called otherwise'); },
    done: () => document.querySelector('.series-title-input').value === 'Called otherwise' },
  { name: 'a page added',
    make: async ({ id }) => { const api = await import('/app/js/api.js'); const c = new OffscreenCanvas(300, 430); c.getContext('2d').fillRect(0, 0, 300, 430); await api.pages.put(id.G, 4, await c.convertToBlob({ type: 'image/png' })); },
    done: () => document.querySelectorAll('#ovPages .ov-page').length === 4 },
  { name: 'the favourite',
    make: async ({ id }) => { const api = await import('/app/js/api.js'); await api.personal.favorite(id.G, false); },
    done: () => document.querySelector('#favToggle').getAttribute('aria-pressed') === 'false' },
  { name: 'a series now',
    make: async ({ id }) => { const api = await import('/app/js/api.js'); await api.series.attach(id.G, id.F); },
    done: () => document.querySelectorAll('.ch-row').length === 2 },
  { name: 'a gallery again',
    make: async ({ id }) => { const api = await import('/app/js/api.js'); await api.series.remove(id.G, id.F, { deleteImages: false }); },
    done: () => document.querySelectorAll('#ovPages .ov-page').length === 4 },
];

const shows = (page, c) => (c.title ? page.evaluate(hasTitle, c.title) : page.evaluate(c.done));

// The page shown on `part`, and each change made in turn: what it reads and what it changed.
async function drive(part, changes) {
  const { base, maker, page } = run;
  const id = Object.fromEntries(Object.entries(PARTS).map(([p, n]) => [p, String(base + n)]));
  await page.bringToFront();
  await visit(page, origin, NEW, gid(base, part));
  await until(page, () => document.querySelector('#seriesCover img')?.complete, null, { what: 'the cover' });
  await page.evaluate(watch);
  const out = [];
  for (const c of changes) {
    await maker.evaluate(c.make, { id });
    if (c.title) await until(page, hasTitle, c.title, { what: `${c.name} drawn` });
    else await until(page, c.done, null, { what: `${c.name} drawn` });
    await sleep(1200);
    out.push({ name: c.name, shown: await shows(page, c), read: named(await page.evaluate(read), base), seen: named(await page.evaluate(seen), base) });
    await page.evaluate(watch);
  }
  assert.deepEqual(page.problems, []);
  return out;
}

// The tags' counts are the whole library's, which the other page's run changed meanwhile: left out here
// (overview-next-table holds them).
const uncounted = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'count' && typeof v !== 'object' ? null : k === 'text' && typeof v === 'string' ? v : v)));
const withoutCounts = (r) => { const out = uncounted(r); for (const row of out.hero?.tags?.rows ?? []) for (const chip of row.chips) if (chip.count != null || chip.text) { chip.text = chip.text.replace(/\d+(\.\d+)?[KM]?$/, ''); chip.count = null; } return out; };

function held(old, now, c) {
  if (c.missed) {
    assert.equal(old.shown, false, `${c.name}: 1.3's page misses it`);
    assert.equal(now.shown, true, `${c.name}: the new page shows it`);
  } else {
    assert.deepEqual(withoutCounts(now.read), withoutCounts(old.read), `${c.name}: both pages show the same`);
    for (const part of now.seen.touched) assert.ok(old.seen.touched.includes(part), `${c.name}: the new page touched ${part}, 1.3's did not (1.3: ${old.seen.touched.join(', ')})`);
  }
  for (const row of old.seen.kept) assert.ok(now.seen.kept.includes(row), `${c.name}: row ${row} kept by 1.3's page, made again by the new one`);
  assert.equal(now.seen.covers, 0, `${c.name}: no cover put in again`);
  assert.deepEqual(now.seen.slid, old.seen.slid, `${c.name}: the same rows slid`);
}

test('the series: each kind of change drawn as 1.3 draws it, touching no more', { skip: !chromePath() }, async () => {
  const now = await drive('S', SERIES);
  const old = record(FILE, 'series');
  SERIES.forEach((c, i) => held(old[i], now[i], c));
  // A chapter's title (1.3 misses it), its translation: its row alone.
  assert.deepEqual(now[0].seen.touched, ['row <S3>']);
  assert.deepEqual(now[2].seen.touched.filter((p) => p.startsWith('row')), ['row <S2>']);
  // The series' own: no row.
  for (const i of [3, 4, 5]) assert.ok(!now[i].seen.touched.some((p) => p.startsWith('row')), `${now[i].name}: ${now[i].seen.touched}`);
  assert.deepEqual(now[6].seen.slid, ['<S2>', '<S3>'], 'the two rows that changed places slid');
});

test('the gallery: its title, a page added, the favourite; becoming a series and a gallery again', { skip: !chromePath() }, async () => {
  const now = await drive('G', GALLERY);
  const old = record(FILE, 'gallery');
  GALLERY.forEach((c, i) => held(old[i], now[i], c));
  assert.equal(now[1].read.grid.tiles.length, 4);
  assert.equal(now[3].read.rows.length, 2);
});

// overview-table.browser.mjs — the overview at /overview held to what 1.3's (/overview) gave
// driven alike over one seeded library (overview-drive.mjs): for a gallery, a
// series in each of its views, a chapter's own id, a series of volumes alone, a gallery with no pages,
// an id that is not there and no id at all, every part's words, links and tips (the hero's details item
// by item, the tags and their counts, each row and its buttons, the heading and its count, the page
// grid, the add bar) are the same, and every part's box is within a pixel, at 1280 and 760, but the
// heading's count after a heading of capitals (§5.3 F18: the heading's letter spacing .12em → .1em
// moves it 1.1px). A row's pages opened and closed again; the view's choice written and followed.
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the overview's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { record } from './records.mjs';
import { openRun, nextBase, gid, visit, settled, read, boxes, boxDiff, named, sleep, NEW } from './overview-drive.mjs';

const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser, page, base;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  base = nextBase(1790009100000);
  page = await openRun(browser, origin, base);
});
after(async () => { await browser?.close(); server?.close(); });

// F18: the count after a heading in capitals stands 1.11px nearer (its letters' spacing).
const F18 = (diffs) => diffs.filter((d) => !/^\.count: /.test(d));

// The page at `g` (then `then` done on it): its words, links and tips, and its boxes. Read once the
// library's stored sizes are still: a gallery's size counts the covers the library keeps of it, made as
// a page first shows it and measured a moment after, so a read straight after the first showing caught
// it either side of that (a series of volumes alone, one run in three of 1.3's page).
const sizesStill = (page) => until(page, async () => {
  const { totalSize } = await (await import('/app/js/api.js')).galleries.stats();
  const now = performance.now();
  if (totalSize !== window.__size) { window.__size = totalSize; window.__sizeSince = now; return false; }
  return now - window.__sizeSince >= 2000;
}, null, { what: 'the stored sizes still', timeout: 30000 });
async function shown(g, { width = 1280, then } = {}) {
  await page.setViewport({ width, height: 900 });
  await visit(page, origin, NEW, g);
  await sizesStill(page);
  await sleep(800);
  if (then) await then(page);
  return { read: named(await page.evaluate(read), base), boxes: await page.evaluate(boxes) };
}

const CASES = [
  ['a gallery', 'G'], ['a series', 'S'], ['a chapter\'s own id', 'S2'], ['a series of volumes alone', 'W'], ['a gallery with no pages', 'E'],
  ['an id that is not there', '1790009199999'], ['no id', null],
];

for (const width of [1280, 760]) {
  for (const [what, part] of CASES) {
    test(`${what} at ${width}: the same words, links, tips and boxes as 1.3's page`, { skip: !chromePath() }, async () => {
      const g = part == null ? null : /^\d+$/.test(part) ? part : gid(base, part);
      const now = await shown(g, { width });
      const was = record(FILE, 'cases', `${what} at ${width}`);
      assert.deepEqual(now.read, was.read);
      assert.deepEqual(F18(boxDiff(was.boxes, now.boxes, 1)), []);
      assert.deepEqual(page.problems, []);
    });
  }
}

test('what the tests read: the series\' rows, the gallery\'s details and tags as 1.3 has them', { skip: !chromePath() }, async () => {
  const now = { S: (await shown(gid(base, 'S'))).read, G: (await shown(gid(base, 'G'))).read };
  const was = record(FILE, 'read');
  assert.deepEqual(now, was);
  const r = was.S;
  assert.deepEqual(r.rows.map((row) => [row.num, row.title, row.state]), [['1', 'S gallery', []], ['2', 'The second', []], ['2.5', 'S3 gallery', []], ['3', 'Gone', ['missing']]]);
  assert.equal(r.section.count, '4');
  assert.equal(r.hero.subtitle, 'Sシリーズ');
  const g = was.G;
  assert.deepEqual(g.hero.meta.map((line) => line.map((item) => item.text)), [['manga', 'safe', '3 / 4 pages', g.hero.meta[0][3].text, '300×430', 'translated'], [g.hero.meta[1][0].text, g.hero.meta[1][1].text]]);
  assert.deepEqual(g.hero.tags.rows.map((row) => row.label), ['Language', 'Artist', 'Group', 'Parody', 'Character', 'Tag']);
  assert.deepEqual(g.hero.tags.rows.at(-1).chips.map((c) => c.text), ['glasses ♀2', 'beard ♂2', 'alpha2', 'beta2', '+']);
});

test('the volumes, chosen on the page: as on 1.3\'s, kept as the view, and followed by the other page', { skip: !chromePath() }, async () => {
  const choose = async (p) => { await p.click('#ovSection [data-view="volumes"]'); await until(p, () => document.querySelector('#ovSection [data-view="volumes"]').getAttribute('aria-selected') === 'true' && document.querySelectorAll('.ch-row').length === 2, null, { what: 'the volumes' }); await settled(p); };   // (its rows' covers in: 300 ms read 1.3's before they came, under load)
  const reset = () => page.evaluate(() => localStorage.removeItem('shiori:seriesView'));
  await reset();
  const now = await shown(gid(base, 'S'), { then: async (p) => { await choose(p); } });
  const was = record(FILE, 'volumes');
  assert.deepEqual(now.read, was.read);
  assert.deepEqual(F18(boxDiff(was.boxes, now.boxes, 1)), []);
  assert.equal(await page.evaluate(() => localStorage.getItem('shiori:seriesView')), '"volumes"');
  assert.deepEqual(was.read.rows.map((row) => row.title), ['V1 gallery', 'Volume two']);
  // Chosen in another tab while the page shows: the new page follows (1.3 read it once, as it loaded).
  await reset();
  await visit(page, origin, NEW, gid(base, 'S'));
  const other = await browser.newPage();
  await other.goto(`${origin}/tasks`, { waitUntil: 'load' });
  await other.evaluate(() => localStorage.setItem('shiori:seriesView', '"volumes"'));
  await until(page, () => document.querySelectorAll('.ch-row').length === 2, null, { what: 'the volumes, chosen in another tab' });
  await other.evaluate(() => localStorage.setItem('shiori:seriesView', '"chapters"'));
  await until(page, () => document.querySelectorAll('.ch-row').length === 4, null, { what: 'the chapters again' });
  await other.close();
  await reset();
});

test('a row\'s pages opened and closed: as on 1.3\'s page', { skip: !chromePath() }, async () => {
  const open = async (p) => {
    await p.hover('.ch-row[data-chapter-id] .ch-head');
    await p.click('.ch-row:nth-child(2) [data-expand]');
    await until(p, () => [...document.querySelectorAll('.ch-row:nth-child(2) .ch-pages .ov-page img')].every((img) => img.getAttribute('src') && img.complete)
      && document.querySelectorAll('.ch-row:nth-child(2) .ch-pages .ov-page').length === 2, null, { what: 'the chapter\'s pages' });
    await sleep(400);
  };
  let now = await shown(gid(base, 'S'), { then: open });
  const opened = record(FILE, 'opened');
  assert.deepEqual(now.read, opened.read);
  assert.deepEqual(opened.read.rows[1].pages.map((p) => p.num), ['1', '2']);
  assert.equal(opened.read.rows[1].expand.expanded, 'true');
  assert.deepEqual(F18(boxDiff(opened.boxes, now.boxes, 1)), []);
  now = await shown(gid(base, 'S'), { then: async (p) => { await open(p); await p.click('.ch-row:nth-child(2) [data-expand]'); await sleep(400); } });
  const closed = record(FILE, 'closed');
  assert.deepEqual(now.read, closed.read);
  assert.equal(closed.read.rows[1].expand.expanded, 'false');
  assert.deepEqual(F18(boxDiff(closed.boxes, now.boxes, 1)), []);
});

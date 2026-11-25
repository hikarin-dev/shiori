// overview-jobs.browser.mjs — jobs drawn on the overview's rows at /overview-next, held to what
// 1.3's page (/overview) gave driven alike: every state of a download (started, its
// bytes with and without a size, extracting, its pages, done and the 4 s it stays, then at rest), an
// import (started, its pages, failed), a translation (started, its figure, done with what failed and
// what went stale, stopped), word by word: the row's state, its bar's words, its buttons (Stop, off, ✓,
// tips); the hero's details as the chapter's pages come; a job under way as the page opens, and one
// left from before that is an interruption; another gallery's word drawing nothing on the row.
// What 1.3's page gave is the record (records/<this file>.<table>.json, records.mjs), 1.3's behaviour as
// measured on 2026-11-25, which a deliberate change of the overview's behaviour edits in the same commit.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, chromePath, launch, until } from './harness.mjs';
import { record } from './records.mjs';
import { openRun, nextBase, gid, visit, read, named, sleep, publish, NEW } from './overview-drive.mjs';

const FILE = basename(fileURLToPath(import.meta.url));
let server, origin, browser, page, base;

before(async () => {
  if (!chromePath()) return;
  ({ server, origin } = await startServer());
  browser = await launch();
  base = nextBase(1790009500000);
  page = await openRun(browser, origin, base);
});
after(async () => { await browser?.close(); server?.close(); });

const clearJobs = () => page.evaluate(async () => { const platform = await import('/app/js/platform.js'); for (const job of await platform.jobs.current()) await platform.jobs.clear(job.gid, job.kind); });

// The row of chapter S2 (and the hero's details) as each word of `steps` is said: each read once the
// row shows the word (its bar's words changed, or at rest again), a moment after.
async function drive(steps) {
  const path = NEW;
  await clearJobs();
  await visit(page, origin, path, gid(base, 'S'));
  const out = [];
  for (const step of steps) {
    if (step.wait) await sleep(step.wait);
    else {
      const before = await page.evaluate(() => document.querySelectorAll('.ch-row')[1].outerHTML);
      await publish(page, { gid: gid(base, step.gid ?? 'S2'), ...step.job });
      if (step.gid) await sleep(600);
      else await until(page, (was) => document.querySelectorAll('.ch-row')[1].outerHTML !== was, before, { what: `${path}: ${JSON.stringify(step.job)}`, timeout: 5000 }).catch(() => {});
      await sleep(250);
    }
    const r = named(await page.evaluate(read), base);
    out.push({ step: step.job ?? `wait ${step.wait}`, row: r.rows[1], meta: r.hero.meta });
  }
  assert.deepEqual(page.problems, []);
  await clearJobs();
  return out;
}

const DOWNLOAD = [
  { job: { kind: 'download', status: 'started', labelKey: 'prog.fetching_meta' } },
  { job: { kind: 'download', status: 'downloading', downloaded: 0, total: 0 } },
  { job: { kind: 'download', status: 'downloading', downloaded: 2_000_000, total: 8_000_000, pages: 12 } },
  { job: { kind: 'download', status: 'extracting' } },
  { job: { kind: 'download', status: 'progress', done: 5, total: 12, labelKey: 'prog.saving' } },
  { job: { kind: 'translate', status: 'progress', done: 1, total: 2 }, gid: 'S3' },
  { job: { kind: 'download', status: 'done', done: 12, total: 12, skipped: 2 } },
  { wait: 4500 },
];
const UPLOAD = [
  { job: { kind: 'upload', status: 'started', label: 'Reading the file…' } },
  { job: { kind: 'upload', status: 'progress', done: 3, total: 9 } },
  { job: { kind: 'upload', status: 'error', error: 'it broke' } },
  { wait: 4500 },
  { job: { kind: 'upload', status: 'started', labelKey: 'prog.starting' } },
  { job: { kind: 'upload', status: 'done', done: 9, total: 9 } },
  { wait: 4500 },
];
const TRANSLATE = [
  { job: { kind: 'translate', status: 'started' } },
  { job: { kind: 'translate', status: 'progress', done: 1, total: 4, pct: 37 } },
  { job: { kind: 'translate', status: 'progress', done: 2, total: 4 } },
  { job: { kind: 'translate', status: 'done', done: 3, total: 4, failed: 1, stale: 2 } },
  { wait: 4500 },
  { job: { kind: 'translate', status: 'started', total: 4 } },
  { job: { kind: 'translate', status: 'cancelled' } },
  { wait: 4500 },
];

for (const [what, steps] of [['a download', DOWNLOAD], ['an import', UPLOAD], ['a translation', TRANSLATE]]) {
  test(`${what}, word by word: as on 1.3's page`, { skip: !chromePath() }, async () => {
    const now = await drive(steps);
    const old = record(FILE, 'words', what);
    for (let i = 0; i < steps.length; i++) assert.deepEqual(now[i], old[i], `after ${JSON.stringify(old[i].step)}`);
    // What it said is a job's, not nothing.
    assert.ok(old.some((x) => x.row.progress?.label), 'the row showed its job');
    assert.equal(old.at(-1).row.progress, null, 'at rest again after its end');
    assert.ok(old.some((x) => /^[1-9]\d*%$/.test(x.row.progress?.fill ?? '')), 'the bar filled');
  });
}

test('a job under way as the page opens, and one left from before (an interruption): as on 1.3\'s page', { skip: !chromePath() }, async () => {
  const seed = (stale) => page.evaluate(async ({ gid, stale }) => {
    const platform = await import('/app/js/platform.js');
    const now = Date.now;
    if (stale) Date.now = () => now() - 5 * 60 * 1000;
    try { await platform.jobs.publish({ gid, kind: 'download', status: 'downloading', downloaded: 1_000_000, total: 4_000_000, pages: 8 }); } finally { Date.now = now; }
  }, { gid: gid(base, 'S2'), stale });
  const now = {};
  for (const stale of [false, true]) {
    await clearJobs();
    await seed(stale);
    await visit(page, origin, NEW, gid(base, 'S'));
    await until(page, () => !!document.querySelector('.ch-row.working'), null, { what: 'the job drawn' });
    await sleep(300);
    // The row, and (an interruption) the registry's entries left as the page opens.
    now[stale] = { row: named(await page.evaluate(read), base).rows[1],
      left: stale ? await page.evaluate(async () => (await (await import('/app/js/platform.js')).jobs.current()).length) : null };
  }
  const was = record(FILE, 'at-load');
  assert.deepEqual(now, was);
  // An interruption is cleared from the registry as the page opens.
  assert.equal(was.true.left, 0, 'the interruption\'s row cleared');
  assert.match(was.true.row.progress.label, /Interrupted/i);
  assert.match(was.false.row.progress.label, /^~2 \/ 8/);
  await clearJobs();
});

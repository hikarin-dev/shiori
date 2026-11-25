// overview-stores.test.mjs — the overview's stores outside React, each in its world of stand-ins: the
// jobs on its rows (src/routes/overview/jobs.ts: 1.3's applyChapterJob and its boot's hydration), its
// covers (covers.ts: 1.3's coverUrl and invalidateCover), and the page grids' rules that are plain
// arithmetic (src/lib/page-thumbs.ts:
// the copy's width), each held to 1.3's numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChapterJobs, LINGER_MS } from '../../src/routes/overview/jobs.ts';
import { createOverviewCovers, coverKey, WAIT_MS } from '../../src/routes/overview/covers.ts';
import { thumbWidth, thumbWorkers, PAGE_CACHE_MAX, PAGE_CACHE_BYTES, PAGE_MOUNT_MARGIN, PAGE_UNMOUNT_MARGIN, PAGE_THUMB_FORMAT } from '../../src/lib/page-thumbs.ts';

// Timers run by hand: advance(ms).
function handTimers() {
  let now = 0, seq = 0;
  const due = new Map();
  return {
    setTimeout: (fn, ms) => { due.set(++seq, { at: now + ms, fn }); return seq; },
    clearTimeout: (h) => { due.delete(h); },
    advance(ms) { now += ms; for (const [h, { at, fn }] of [...due].sort((a, b) => a[1].at - b[1].at)) if (at <= now) { due.delete(h); fn(); } },
    get pending() { return due.size; },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

function jobsWorld(rows = [], now = 1_000_000) {
  const listeners = new Set(), cleared = [], reread = [];
  const timers = handTimers();
  const jobs = createChapterJobs({
    jobs: { subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }, current: async () => rows, clear: async (gid, kind) => { cleared.push(`${gid} ${kind}`); } },
    now: () => now, reread: (gid) => reread.push(gid), timers,
  });
  return { jobs, timers, cleared, reread, say: (job) => { for (const cb of [...listeners]) cb(job); }, listening: () => listeners.size };
}

test('a row\'s job: its latest word, one gallery told; an end stays 4 s, then the row rests and is read again', async () => {
  const w = jobsWorld();
  w.jobs.start();
  await tick();
  const told = [];
  w.jobs.subscribe('a', () => told.push('a'));
  w.jobs.subscribe('b', () => told.push('b'));
  w.say({ gid: 'a', kind: 'download', status: 'downloading', downloaded: 1 });
  assert.equal(w.jobs.get('a').status, 'downloading');
  assert.deepEqual(told, ['a']);
  // Not a row's: another kind, a signal with no status, a batch of imports.
  w.say({ gid: 'a', kind: 'sync', status: 'progress' });
  w.say({ gid: 'a', kind: 'import', status: 'progress' });
  w.say({ kind: 'download', status: 'done' });
  assert.equal(w.jobs.get('a').status, 'downloading');
  w.say({ gid: 'a', kind: 'download', status: 'done', done: 3, total: 3 });
  assert.deepEqual(w.reread, ['a'], 'read again at its end');
  w.timers.advance(LINGER_MS - 1);
  assert.equal(w.jobs.get('a').status, 'done');
  w.timers.advance(1);
  assert.equal(w.jobs.get('a'), null);
  assert.deepEqual(w.reread, ['a', 'a'], 'and when its 4 s are up');
  // A word within the 4 s keeps the row: the end's clearing is called off.
  w.say({ gid: 'b', kind: 'translate', status: 'error', error: 'x' });
  w.timers.advance(1000);
  w.say({ gid: 'b', kind: 'translate', status: 'started' });
  w.timers.advance(LINGER_MS);
  assert.equal(w.jobs.get('b').status, 'started');
  assert.equal(LINGER_MS, 4000);
});

test('a press: its job begun at once as a word; one not taken discarded (gone at once, the row read again, no 4 s); a revert holds the translate button', async () => {
  const w = jobsWorld();
  w.jobs.start();
  await tick();
  const told = [];
  w.jobs.subscribe('a', () => told.push('a'));
  w.jobs.begin('a', 'download', 'Fetching…');
  assert.deepEqual({ ...w.jobs.get('a') }, { gid: 'a', kind: 'download', status: 'started', label: 'Fetching…' });
  assert.equal(told.length, 1);
  w.jobs.discard('a');
  assert.equal(w.jobs.get('a'), null);
  assert.deepEqual(w.reread, ['a']);
  assert.equal(told.length, 2);
  assert.equal(w.timers.pending, 0);
  // An end discarded within its 4 s: no clearing left to come.
  w.say({ gid: 'a', kind: 'translate', status: 'error', error: 'x' });
  w.jobs.discard('a');
  assert.equal(w.timers.pending, 0);
  // Held: told once each way; stop() lets go of it.
  w.jobs.hold('a', true);
  w.jobs.hold('a', true);
  assert.equal(w.jobs.held('a'), true);
  w.jobs.hold('a', false);
  assert.equal(w.jobs.held('a'), false);
  w.jobs.hold('a', true);
  w.jobs.stop();
  assert.equal(w.jobs.held('a'), false);
});

test('what is under way as the page opens: a download or import over 2 minutes old is an interruption (cleared); a translation as it is; an end lingers', async () => {
  const now = 10_000_000;
  const w = jobsWorld([
    { gid: 'a', kind: 'download', status: 'downloading', at: now - 3 * 60 * 1000 },
    { gid: 'b', kind: 'upload', status: 'progress', at: now - 1000 },
    { gid: 'c', kind: 'translate', status: 'progress', at: now - 60 * 60 * 1000 },
    { gid: 'd', kind: 'download', status: 'error', at: now - 1000 },
    { gid: 'e', kind: 'import', status: 'progress', at: now },
  ], now);
  w.jobs.start();
  await tick(); await tick();
  assert.equal(w.jobs.get('a').status, 'interrupted');
  assert.deepEqual(w.cleared, ['a download']);
  assert.equal(w.jobs.get('b').status, 'progress');
  assert.equal(w.jobs.get('c').status, 'progress');
  assert.equal(w.jobs.get('d').status, 'error');
  assert.equal(w.jobs.get('e'), null);
  w.timers.advance(LINGER_MS);
  assert.equal(w.jobs.get('a'), null);
  assert.equal(w.jobs.get('d'), null);
  // Stopped: nothing listened to, nothing kept, no timer left; started again, it hears again.
  w.jobs.stop();
  assert.equal(w.listening(), 0);
  assert.equal(w.jobs.get('b'), null);
  assert.equal(w.timers.pending, 0);
});

test('covers: asked once per role, gallery and width with a request id; an answer for another id or page is not taken; asked again on a change, the shown kept until a different picture', () => {
  const said = [], controls = new Set();
  const timers = handTimers();
  const covers = createOverviewCovers({ rpc: (msg) => said.push(msg), onControl: (cb) => { controls.add(cb); return () => controls.delete(cb); }, timers });
  const push = (msg) => { for (const cb of [...controls]) cb(msg); };
  covers.start();
  let told = 0;
  covers.subscribe(() => told++);
  covers.want('7', { preferSeries: true, width: 480 });
  covers.want('7', { preferSeries: true, width: 480 });
  covers.want('8');
  assert.deepEqual(said.map((m) => [m.type, m.galleryId, m.thumbWidth, m.preferSeries, m.requester]), [['GET_COVER', '7', 480, true, 'overview'], ['GET_COVER', '8', 160, false, 'overview']]);
  push({ type: 'COVER_READY', requester: 'library', requestId: said[0].requestId, coverDataUrl: 'data:x' });
  push({ type: 'COVER_READY', requester: 'overview', requestId: 'ov-99', coverDataUrl: 'data:x' });
  assert.equal(covers.get(coverKey('7', true, 480)), null);
  push({ type: 'COVER_READY', requester: 'overview', requestId: said[0].requestId, coverDataUrl: 'data:seven' });
  assert.equal(covers.get(coverKey('7', true, 480)), 'data:seven');
  assert.equal(told, 1);
  // Kept: not asked again; asked again (its gallery changed): the same picture tells nothing.
  covers.want('7', { preferSeries: true, width: 480 });
  assert.equal(said.length, 2);
  covers.again('7', { preferSeries: true, width: 480 });
  push({ type: 'COVER_READY', requester: 'overview', requestId: said[2].requestId, coverDataUrl: 'data:seven' });
  assert.equal(told, 1);
  covers.again('7', { preferSeries: true, width: 480 });
  push({ type: 'COVER_READY', requester: 'overview', requestId: said[3].requestId, coverDataUrl: 'data:seven-new' });
  assert.equal(covers.get(coverKey('7', true, 480)), 'data:seven-new');
  assert.equal(told, 2);
  // No answer in 10 s: none, asked again the next time.
  timers.advance(WAIT_MS);
  covers.want('8');
  assert.equal(said.at(-1).galleryId, '8');
  covers.stop();
  assert.equal(controls.size, 0);
  assert.equal(timers.pending, 0);
});

test('the page grids\' copies: 1.5 times the tile\'s pixels (zoom and pinch included), stepped by 32, at most 768; 1.3\'s bounds', () => {
  // 1.3's own formula (app/js/overview.js _pageThumbWidth), for the tiles' widths a grid has.
  const old = (tileW, dpr, vv) => Math.min(768, Math.ceil((tileW || 120) * (dpr || 1) * (vv || 1) * 1.5 / 32) * 32);
  for (const w of [0, 84, 112, 121.33, 150, 200, 240, 400])
    for (const dpr of [1, 1.25, 1.5, 2, 3])
      for (const vv of [1, 1.5]) assert.equal(thumbWidth(w, dpr, vv), old(w, dpr, vv), `${w} at ${dpr}×${vv}`);
  assert.equal(thumbWidth(112, 1, 1), 192);
  assert.equal(thumbWidth(400, 2, 1), 768);
  assert.deepEqual([thumbWorkers(2), thumbWorkers(4), thumbWorkers(8), thumbWorkers(16), thumbWorkers(32), thumbWorkers(undefined)], [1, 1, 2, 4, 4, 1]);
  assert.deepEqual([PAGE_CACHE_MAX, PAGE_CACHE_BYTES, PAGE_MOUNT_MARGIN, PAGE_UNMOUNT_MARGIN], [4000, 64 * 1024 * 1024, 900, 5400]);
  assert.deepEqual(PAGE_THUMB_FORMAT, { format: 'image/webp', quality: 0.82 });
});

// task-store.test.mjs — the Tasks page's jobs (src/lib/task-store.ts), each of 1.3's rules
// (app/js/tasks.js): what is under way at load and in which order of precedence, a row per gid:kind,
// new rows at the end, what is ignored, the 4 s linger and the pointer, Stop and its 3 s, the quiet
// note read again every 15 s, and a stop that leaves nothing behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskStore, quietMinutes, LINGER_MS, QUIET_EVERY_MS, STOP_RETRY_MS } from '../../src/lib/task-store.ts';

const flush = () => new Promise((r) => setTimeout(r, 0));

// The platform and a clock by hand.
function world({ current = [], translating = [], pending = [] } = {}) {
  let now = 1_000_000, seq = 0;
  const due = new Map();
  const subs = new Set();
  const asked = [];
  const timers = {
    setTimeout: (fn, ms) => { due.set(++seq, { at: now + ms, fn }); return seq; },
    clearTimeout: (h) => { due.delete(h); },
    setInterval: (fn, ms) => { const h = ++seq; due.set(h, { at: now + ms, fn, every: ms }); return h; },
    clearInterval: (h) => { due.delete(h); },
  };
  const w = {
    deps: {
      jobs: { subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); }, current: async () => current },
      translateResume: { all: async () => translating },
      jobsPending: { all: async () => pending },
      rpc: async (msg) => { asked.push(msg); },
      now: () => now,
      timers,
    },
    asked,
    news: (job) => { for (const cb of [...subs]) cb(job); },
    get listening() { return subs.size; },
    get timers() { return due.size; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [h, d] = next;
        now = d.at;
        if (d.every) d.at += d.every; else due.delete(h);
        d.fn();
      }
      now = end;
    },
  };
  return w;
}
const keys = (store) => store.getSnapshot().map((r) => r.key);

test('at load: the live list (running, oldest first), then translations under way, then jobs waiting; the first of a key wins', async () => {
  const w = world({
    current: [
      { gid: 2, kind: 'download', status: 'progress', at: 20 },
      { gid: 1, kind: 'download', status: 'progress', at: 10 },
      { gid: 3, kind: 'upload', status: 'done', at: 5 },
      { gid: 9, kind: 'import', status: 'progress', at: 1 },
    ],
    translating: [{ gid: 4 }, { gid: 1 }],
    pending: [{ key: '5:download', kind: 'download' }, { payload: { galleryId: 4 }, kind: 'translate' }, { key: '6:x' }],
  });
  const store = createTaskStore(w.deps);
  store.start();
  await flush();
  assert.deepEqual(keys(store), ['1:download', '2:download', '4:translate', '1:translate', '5:download']);
  const rows = Object.fromEntries(store.getSnapshot().map((r) => [r.key, r.job]));
  assert.deepEqual([rows['4:translate'].status, rows['4:translate'].labelKey], ['progress', 'prog.translating'], 'a translation on the server, by the live list\'s word');
  assert.deepEqual([rows['5:download'].status, rows['5:download'].labelKey], ['started', 'prog.starting']);
  assert.equal(rows['1:download'].gid, '1', 'ids as strings');
  store.stop();
});

test('news heard before the load\'s answer keeps its row and place', async () => {
  let answer;
  const w = world();
  w.deps.jobs.current = () => new Promise((r) => { answer = r; });
  const store = createTaskStore(w.deps);
  store.start();
  w.news({ gid: 7, kind: 'download', status: 'progress', done: 2, total: 4 });
  answer([{ gid: 7, kind: 'download', status: 'progress', done: 1, total: 4, at: 1 }, { gid: 8, kind: 'download', status: 'progress', at: 2 }]);
  await flush();
  assert.deepEqual(keys(store), ['7:download', '8:download']);
  assert.equal(store.getSnapshot()[0].job.done, 2, 'the news, not the older record');
  store.stop();
});

test('a row per gid:kind, new ones at the end; signals, batches, their titles, the end of an unseen job and late news are ignored', async () => {
  const w = world();
  const store = createTaskStore(w.deps);
  store.start();
  await flush();
  w.news({ gid: 1, kind: 'download', status: 'progress' });
  w.news({ gid: 1, kind: 'translate', status: 'progress' });
  w.news({ gid: 2, status: 'progress' });
  assert.deepEqual(keys(store), ['1:download', '1:translate', '2:job']);
  w.news({ type: 'IMPORT_TITLE', batch: 'b' });
  w.news({ gid: 3, kind: 'download' });
  w.news({ gid: 'import-1', kind: 'import', status: 'progress' });
  w.news({ gid: 4, kind: 'upload', status: 'progress', batch: 'import-1' });
  w.news({ gid: 5, kind: 'download', status: 'done' });
  assert.deepEqual(keys(store), ['1:download', '1:translate', '2:job']);
  const before = store.getSnapshot()[0];
  w.news({ gid: 1, kind: 'download', status: 'progress', done: 3 });
  assert.equal(store.getSnapshot()[0].job.done, 3);
  assert.notEqual(store.getSnapshot()[0], before, 'a new row object for the news');
  assert.equal(store.getSnapshot()[1], store.getSnapshot()[1], 'the others as they were');
  w.news({ gid: 1, kind: 'download', status: 'done' });
  w.news({ gid: 1, kind: 'download', status: 'progress', done: 9 });
  assert.equal(store.getSnapshot()[0].job.status, 'done', 'late news of the job whose end shows');
  store.stop();
});

test('a finished row stays 4 s, and leaves only while the pointer is off the list', async () => {
  const w = world();
  const store = createTaskStore(w.deps);
  store.start();
  await flush();
  w.news({ gid: 1, kind: 'download', status: 'progress' });
  w.news({ gid: 2, kind: 'download', status: 'progress' });
  w.news({ gid: 1, kind: 'download', status: 'error', error: 'x' });
  w.advance(LINGER_MS - 1);
  assert.deepEqual(keys(store), ['1:download', '2:download'], 'still there');
  store.pointer(true);
  w.advance(1000);
  assert.deepEqual(keys(store), ['1:download', '2:download'], 'the pointer is on the list');
  store.pointer(false);
  assert.deepEqual(keys(store), ['2:download'], 'leaving the list sweeps');
  w.news({ gid: 2, kind: 'download', status: 'done' });
  w.advance(LINGER_MS + 50);
  assert.deepEqual(keys(store), [], 'off the list, it goes after 4 s');
  w.news({ gid: 2, kind: 'download', status: 'progress' });
  assert.deepEqual(keys(store), ['2:download'], 'a new job of the same key is a new row');
  store.stop();
});

test('Stop: "Stopping…" until the job\'s word; with none, pressable again after 3 s; nothing when stopping or ended', async () => {
  const w = world();
  const store = createTaskStore(w.deps);
  store.start();
  await flush();
  w.news({ gid: 1, kind: 'translate', status: 'progress' });
  assert.equal(store.stoppable(), true);
  await store.stopJob('1:translate');
  assert.deepEqual(w.asked, [{ type: 'STOP_JOB', galleryId: '1', kind: 'translate' }]);
  assert.equal(store.getSnapshot()[0].stopping, true);
  assert.equal(store.stoppable(), false);
  await store.stopJob('1:translate');
  assert.equal(w.asked.length, 1, 'not again while stopping');
  w.news({ gid: 1, kind: 'translate', status: 'progress', pct: 50 });
  assert.equal(store.getSnapshot()[0].stopping, true, 'news while stopping keeps it stopping');
  w.advance(STOP_RETRY_MS - 1);
  assert.equal(store.getSnapshot()[0].stopping, true);
  w.advance(1);
  assert.equal(store.getSnapshot()[0].stopping, false, 'no word in 3 s: Stop again');
  await store.stopJob('1:translate');
  w.news({ gid: 1, kind: 'translate', status: 'cancelled' });
  assert.deepEqual([store.getSnapshot()[0].stopping, store.getSnapshot()[0].job.status], [false, 'cancelled'], 'its word came');
  w.advance(STOP_RETRY_MS);
  await store.stopJob('1:translate');
  assert.equal(w.asked.length, 2, 'an ended job is not stopped');
  store.stop();
});

test('Stop all stops every running row, once each', async () => {
  const w = world();
  const store = createTaskStore(w.deps);
  store.start();
  await flush();
  w.news({ gid: 1, kind: 'download', status: 'progress' });
  w.news({ gid: 2, kind: 'translate', status: 'progress' });
  w.news({ gid: 3, kind: 'upload', status: 'progress' });
  w.news({ gid: 3, kind: 'upload', status: 'done' });
  await store.stopJob('2:translate');
  await store.stopAll();
  assert.deepEqual(w.asked.map((m) => m.galleryId), ['2', '1']);
  store.stop();
});

test('a running job silent 2 min says for how long, read again every 15 s', async () => {
  const w = world();
  const store = createTaskStore(w.deps);
  store.start();
  await flush();
  const at = w.deps.now();
  w.news({ gid: 1, kind: 'download', status: 'progress', at });
  w.news({ gid: 2, kind: 'download', status: 'progress', at });
  w.news({ gid: 2, kind: 'download', status: 'done', at });
  store.pointer(true);   // keep the finished row
  assert.equal(quietMinutes(store.getSnapshot()[0]), 0);
  const ended = store.getSnapshot()[1];
  w.advance(2 * 60 * 1000 - QUIET_EVERY_MS);
  assert.equal(quietMinutes(store.getSnapshot()[0]), 0, 'at 1:45, nothing');
  w.advance(QUIET_EVERY_MS + 1);
  assert.equal(quietMinutes(store.getSnapshot()[0]), 0, 'at exactly 2:00 nothing yet (more than two minutes)');
  w.advance(QUIET_EVERY_MS);
  assert.equal(quietMinutes(store.getSnapshot()[0]), 2, 'once read again past 2:00');
  assert.equal(store.getSnapshot()[1], ended, 'a finished row is not read again');
  await store.stopJob('1:download');
  assert.equal(quietMinutes(store.getSnapshot()[0]), 0, 'a stopping row says Stopping… only');
  store.stop();
});

test('stopped, it leaves nothing: no listener, no timer, no row, and work under way does nothing', async () => {
  let answer;
  const w = world();
  w.deps.jobs.current = () => new Promise((r) => { answer = r; });
  const store = createTaskStore(w.deps);
  let heard = 0;
  const off = store.subscribe(() => { heard++; });
  store.start();
  w.news({ gid: 1, kind: 'download', status: 'progress' });
  w.news({ gid: 2, kind: 'download', status: 'progress' });
  w.news({ gid: 2, kind: 'download', status: 'done' });
  const stopping = store.stopJob('1:download');
  store.stop();
  await stopping;
  answer([{ gid: 3, kind: 'download', status: 'progress' }]);
  await flush();
  assert.equal(w.listening, 0);
  assert.equal(w.timers, 0);
  assert.deepEqual(keys(store), []);
  // Started again (as React's StrictMode does): as new.
  store.start();
  answer([]);
  await flush();
  assert.equal(w.listening, 1);
  store.stop();
  off();
  assert.ok(heard > 0);
});

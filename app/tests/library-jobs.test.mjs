// library-jobs.test.mjs — the library page's jobs (src/lib/library-jobs.ts), every rule of 1.3's
// applyJob, _jobDoneHandled, _markJobInterrupted and hydrateJobs (app/js/library.js) as the store
// states it: a card's job is its gallery's latest news, one object a word; a "done" said again is no
// new word; what a job's end does (an upload's empty gallery removed, a done job's page read again
// once its last word has stayed); a job for a gallery the page shows no card for looks for it; what is
// under way when the page shows, row by row; a press no news has answered yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AT_REST, JOB_STALE_MS, createLibraryJobs } from '../../src/lib/library-jobs.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

// A world by hand: the jobs channel, the registry's rows, the clock, and what the page was asked.
function world({ rows = [], now = 1_000_000 } = {}) {
  const listeners = new Set();
  const asked = [];
  const w = {
    now,
    rows,
    asked,
    listening: () => listeners.size,
    say: (job) => { for (const cb of [...listeners]) cb(job); },
    deps: {
      jobs: {
        subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
        current: async () => { asked.push(['current']); return w.rows.map((r) => ({ ...r })); },
        clear: (gid, kind) => { asked.push(['clear', gid, kind]); w.rows = w.rows.filter((r) => !(String(r.gid) === gid && r.kind === kind)); },
      },
      now: () => w.now,
      reread: () => asked.push(['reread']),
      dropIfEmpty: (gid) => asked.push(['dropIfEmpty', gid]),
      reveal: (gid) => asked.push(['reveal', gid]),
    },
  };
  return w;
}

// A started store showing `ids`, its hydrate (rows) done.
async function started(w, ids = ['1', '2', '3']) {
  const store = createLibraryJobs(w.deps);
  store.start();
  store.showing(ids);
  await tick();
  return store;
}

// How many times each gallery's listener was told.
function listen(store, ids) {
  const told = Object.fromEntries(ids.map((id) => [id, 0]));
  const offs = ids.map((id) => store.subscribe(id, () => { told[id]++; }));
  return { told, off: () => offs.forEach((off) => off()) };
}

test('a card\'s job is its gallery\'s latest news, one new object a word; other galleries are not told', async () => {
  const w = world();
  const store = await started(w);
  const { told } = listen(store, ['1', '2']);
  assert.equal(store.get('1'), AT_REST, 'at rest: the one shared state');
  const a = { gid: 1, kind: 'download', status: 'progress', done: 1, total: 4 };
  w.say(a);
  const first = store.get('1').job;
  assert.notEqual(first, a, 'a copy of its own');
  assert.equal(first.gid, '1');
  w.say({ ...a, done: 2 });
  const second = store.get('1').job;
  assert.notEqual(second, first, 'each word a new object');
  assert.equal(second.done, 2);
  assert.deepEqual(told, { 1: 2, 2: 0 });
  assert.equal(store.get('2'), AT_REST);
  // 300 words about one gallery: its listener alone.
  for (let i = 0; i < 300; i++) w.say({ ...a, done: i });
  assert.deepEqual(told, { 1: 302, 2: 0 });
  assert.equal(store.live('1'), true);
  store.stop();
});

test('a "done" said again is not a new word; a word after it starts over', async () => {
  const w = world();
  const store = await started(w);
  const { told } = listen(store, ['1']);
  w.say({ gid: '1', kind: 'download', status: 'done', done: 4, total: 4 });
  const done = store.get('1');
  w.say({ gid: '1', kind: 'download', status: 'done', done: 4, total: 4 });
  assert.equal(store.get('1'), done, 'the same state: the card draws nothing new');
  assert.equal(told['1'], 1);
  assert.equal(store.live('1'), false);
  w.say({ gid: '1', kind: 'translate', status: 'started' });
  w.say({ gid: '1', kind: 'translate', status: 'done', done: 3, total: 3 });
  assert.equal(store.get('1').job.kind, 'translate', 'a done after another word is a word');
  assert.equal(told['1'], 3);
  store.stop();
});

test('not a job: a signal (it has a type, or no gallery or no status), an import', async () => {
  const w = world();
  const store = await started(w);
  const { told } = listen(store, ['1']);
  w.say(null);
  w.say({ type: 'STOP_IMPORT', galleryId: '1' });
  w.say({ gid: '1', kind: 'download' });
  w.say({ gid: '1', kind: 'import', status: 'progress' });
  // A batch telling of a title's end, whichever way it ended (1.3 took these for a job's news: a
  // title found imported already opened its gallery's card for a job that never came).
  for (const status of ['done', 'skipped', 'failed']) w.say({ type: 'IMPORT_TITLE', batch: 'b1', gid: '1', status });
  w.say({ type: 'IMPORT_TITLE', batch: 'b1', gid: '9', status: 'skipped' });
  assert.equal(told['1'], 0);
  assert.equal(store.get('1'), AT_REST);
  assert.deepEqual(w.asked.filter(([k]) => k === 'reveal'), []);
  store.stop();
});

test('a title of a batch of imports says its own news: on its card, looked for where it has none, its end as an upload\'s', async () => {
  const w = world();
  const store = await started(w, ['1']);
  const { told } = listen(store, ['1']);
  w.say({ gid: '1', kind: 'upload', status: 'started', labelKey: 'prog.reading', batch: 'b1' });
  w.say({ gid: '1', kind: 'upload', status: 'progress', done: 1, total: 2, batch: 'b1' });
  assert.equal(store.get('1').job.done, 1);
  assert.equal(told['1'], 2);
  w.say({ gid: '9', kind: 'upload', status: 'started', batch: 'b1' });
  assert.deepEqual(w.asked.filter(([k]) => k === 'reveal'), [['reveal', '9']]);
  w.say({ gid: '1', kind: 'upload', status: 'error', error: 'x', batch: 'b1' });
  assert.deepEqual(w.asked.filter(([k]) => k === 'dropIfEmpty'), [['dropIfEmpty', '1']]);
  store.stop();
});

test('a gallery the page shows no card for: its running job is kept and looked for (not a translation or a sync, not at its end); its end forgotten', async () => {
  const w = world();
  const store = await started(w, ['1']);
  const cases = [
    [{ gid: '9', kind: 'download', status: 'started' }, true],
    [{ gid: '9', kind: 'upload', status: 'progress' }, true],
    [{ gid: '9', kind: 'download', status: 'cancelled' }, true],
    [{ gid: '9', kind: 'download', status: 'error' }, false],
    [{ gid: '9', kind: 'download', status: 'done' }, false],
    [{ gid: '9', kind: 'translate', status: 'progress' }, false],
    [{ gid: '9', kind: 'sync', status: 'progress' }, false],
  ];
  for (const [job, looked] of cases) {
    w.asked.length = 0;
    w.say(job);
    assert.deepEqual(w.asked, looked ? [['reveal', '9']] : [], `${job.kind} ${job.status}`);
    const running = job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled';
    assert.equal(store.live('9'), running, `${job.kind} ${job.status}: kept while running`);
    if (!running) assert.equal(store.get('9'), AT_REST, `${job.kind} ${job.status}: its end forgotten`);
  }
  // Its card shows (the page read again): the job it runs is there to draw.
  w.say({ gid: '9', kind: 'download', status: 'progress', done: 1, total: 2 });
  store.showing(['1', '9']);
  assert.equal(store.get('9').job.done, 1);
  // An upload's end on no card does not touch the gallery.
  store.showing(['1']);
  w.asked.length = 0;
  w.say({ gid: '9', kind: 'upload', status: 'error', error: 'x' });
  assert.deepEqual(w.asked, []);
  store.stop();
});

test('an upload that ends on a card: its gallery removed if still empty, once for a done said twice', async () => {
  for (const status of ['done', 'error', 'cancelled']) {
    const w = world();
    const store = await started(w);
    w.say({ gid: '2', kind: 'upload', status: 'progress', done: 1, total: 3 });
    w.say({ gid: '2', kind: 'upload', status });
    w.say({ gid: '2', kind: 'upload', status });
    assert.deepEqual(w.asked.filter(([k]) => k === 'dropIfEmpty'), status === 'done' ? [['dropIfEmpty', '2']] : [['dropIfEmpty', '2'], ['dropIfEmpty', '2']], status);
    // A download's end never does.
    w.say({ gid: '3', kind: 'download', status });
    assert.equal(w.asked.filter(([k, gid]) => k === 'dropIfEmpty' && gid === '3').length, 0);
    store.stop();
  }
});

test('a last word that has stayed its while (the card says so): a done one reads the page again and what is under way; any other only rests', async () => {
  const w = world();
  const store = await started(w);
  const { told } = listen(store, ['1']);
  w.say({ gid: '1', kind: 'download', status: 'error', error: 'x' });
  w.asked.length = 0;
  store.settled('1');
  assert.equal(store.get('1'), AT_REST);
  assert.deepEqual(w.asked, []);
  w.say({ gid: '1', kind: 'translate', status: 'done', done: 2, total: 2 });
  store.settled('1');
  await tick();
  assert.deepEqual(w.asked, [['reread'], ['current']]);
  assert.equal(store.get('1'), AT_REST);
  // A settle for a job running again (a word came in the meantime) leaves the job.
  w.say({ gid: '1', kind: 'translate', status: 'started' });
  const running = store.get('1');
  store.settled('1');
  assert.equal(store.get('1').job, running.job);
  assert.ok(told['1'] >= 4);
  store.stop();
});

test('what is under way as the page shows, row by row (1.3\'s hydrateJobs)', async () => {
  const now = 10_000_000;
  const old = (kind) => now - JOB_STALE_MS[kind] - 1;
  const rows = [
    { gid: '1', kind: 'download', status: 'error', error: 'gone', at: now - 5000 },          // shown once, cleared
    { gid: '2', kind: 'upload', status: 'cancelled', at: now - 5000 },                        // shown once, cleared
    { gid: '3', kind: 'translate', status: 'progress', pct: 30, at: now - 60 * 60 * 1000 },   // as it is, however old
    { gid: '4', kind: 'download', status: 'progress', done: 1, total: 9, at: old('download') }, // stale: interrupted
    { gid: '5', kind: 'upload', status: 'progress', done: 1, total: 9, at: old('upload') },     // stale: interrupted
    { gid: '6', kind: 'download', status: 'downloading', downloaded: 10, total: 100, at: now - 1000 }, // fresh: shown
    { gid: '7', kind: 'sync', status: 'progress', at: now - 3 * 60 * 1000 },                 // stale (2 min): interrupted
    { gid: 'import-1', kind: 'import', status: 'progress', at: now },                         // the tracker's
    { gid: '8', kind: 'download', status: 'progress', at: now - 1000 },                       // no card: kept, looked for
    { gid: '9', kind: 'download', status: 'error', at: now - 1000 },                          // no card: forgotten, cleared
  ];
  const w = world({ rows, now });
  const store = await started(w, ['1', '2', '3', '4', '5', '6', '7']);
  const state = (id) => { const s = store.get(id); return { job: s.job ? `${s.job.kind} ${s.job.status}` : null, interrupted: s.interrupted }; };
  assert.deepEqual(Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((id) => [id, state(id)])), {
    1: { job: 'download error', interrupted: false },
    2: { job: 'upload cancelled', interrupted: false },
    3: { job: 'translate progress', interrupted: false },
    4: { job: null, interrupted: true },
    5: { job: null, interrupted: true },
    6: { job: 'download downloading', interrupted: false },
    7: { job: null, interrupted: true },
    8: { job: 'download progress', interrupted: false },
    9: { job: null, interrupted: false },
  });
  assert.deepEqual(w.asked.filter(([k]) => k === 'clear').map(([, gid, kind]) => `${gid}:${kind}`).sort(),
    ['1:download', '2:upload', '4:download', '5:upload', '7:sync', '9:download']);
  assert.ok(w.asked.some(([k, gid]) => k === 'reveal' && gid === '8'));
  assert.equal(store.live('4'), false, 'an interrupted job is not running');
  // An interruption's hint rests when the card says so.
  store.settled('4');
  assert.equal(store.get('4'), AT_REST);
  // Asked once a start: the page's next page does not ask again.
  const asks = w.asked.filter(([k]) => k === 'current').length;
  store.showing(['1']);
  await tick();
  assert.equal(w.asked.filter(([k]) => k === 'current').length, asks);
  store.stop();
});

test('a press no news has answered yet: set, cleared by the first word or by the press failing; a hint shown over no job', async () => {
  const w = world();
  const store = await started(w);
  store.press('1', 'download');
  assert.equal(store.get('1').pending, 'download');
  w.say({ gid: '1', kind: 'download', status: 'started', labelKey: 'prog.contacting_helper' });
  assert.equal(store.get('1').pending, null, 'the first word answers it');
  store.press('2', 'download', 'Reading file…');
  assert.deepEqual([store.get('2').pending, store.get('2').pendingLabel], ['download', 'Reading file…']);
  store.press('2', 'download', 'Importing…');
  assert.equal(store.get('2').pendingLabel, 'Importing…');
  store.note('2', 'Error: could not read file.');
  assert.deepEqual([store.get('2').pending, store.get('2').interrupted], [null, 'Error: could not read file.']);
  store.settled('2');
  assert.equal(store.get('2'), AT_REST);
  store.press('3', 'translate');
  store.release('3');
  assert.equal(store.get('3'), AT_REST);
  store.stop();
});

test('two jobs on one gallery: each button stays its own job\'s while the news is another\'s; a job still running is the card\'s again once a last word has stayed', async () => {
  const w = world();
  const store = await started(w);
  const buttons = (gid) => { const h = store.get(gid).holding; return h ? Object.fromEntries(Object.entries(h).map(([b, j]) => [b, `${j.kind} ${j.status} ${j.done ?? ''}`.trim()])) : null; };
  // A download, then its series' sync says a word: the download keeps its button (a sync holds none).
  w.say({ gid: '1', kind: 'download', status: 'progress', done: 1, total: 4 });
  assert.equal(buttons('1'), null, 'one job: nothing beside it');
  const download = store.get('1').job;
  w.say({ gid: '1', kind: 'sync', status: 'progress', done: 1, total: 9 });
  assert.equal(store.get('1').job.kind, 'sync', 'the bar and the line are the latest news\'');
  assert.equal(store.get('1').holding.download, download, 'the download\'s own word, as it was');
  // The download's next word is its button's again; a sync is kept by no button.
  w.say({ gid: '1', kind: 'download', status: 'progress', done: 2, total: 4 });
  assert.equal(buttons('1'), null);
  // A translation beside it, then the sync again: both buttons held.
  w.say({ gid: '1', kind: 'translate', status: 'started' });
  assert.deepEqual(buttons('1'), { download: 'download progress 2' });
  w.say({ gid: '1', kind: 'sync', status: 'progress', done: 2, total: 9 });
  assert.deepEqual(buttons('1'), { download: 'download progress 2', translate: 'translate started' });
  assert.equal(store.live('1'), true);
  // The sync ends (a last word is nobody's button) and the download ends straight after: a job's own
  // "done", not lost behind another's.
  w.say({ gid: '1', kind: 'sync', status: 'done', done: 9, total: 9 });
  w.say({ gid: '1', kind: 'download', status: 'done', done: 4, total: 4 });
  assert.deepEqual([store.get('1').job.kind, store.get('1').job.status, buttons('1')], ['download', 'done', { translate: 'translate started' }]);
  w.say({ gid: '1', kind: 'download', status: 'done', done: 4, total: 4 });
  assert.equal(w.asked.filter(([k]) => k === 'reread').length, 0);
  // Its last word has stayed its while: the page read again, and the translation still running is the
  // card's job again.
  store.settled('1');
  assert.equal(w.asked.filter(([k]) => k === 'reread').length, 1);
  assert.deepEqual([store.get('1').job.kind, store.get('1').job.status, buttons('1'), store.live('1')], ['translate', 'started', null, true]);
  w.say({ gid: '1', kind: 'translate', status: 'cancelled' });
  store.settled('1');
  assert.equal(store.get('1'), AT_REST);
  assert.equal(store.live('1'), false);

  // A press is answered by its own button's first word: another job's word leaves it pressed.
  w.say({ gid: '2', kind: 'download', status: 'progress', done: 1, total: 4 });
  store.press('2', 'translate');
  w.say({ gid: '2', kind: 'download', status: 'progress', done: 2, total: 4 });
  w.say({ gid: '2', kind: 'sync', status: 'progress', done: 1, total: 9 });
  assert.deepEqual([store.get('2').pending, buttons('2')], ['translate', { download: 'download progress 2' }]);
  w.say({ gid: '2', kind: 'translate', status: 'started' });
  assert.deepEqual([store.get('2').pending, buttons('2')], [null, { download: 'download progress 2' }]);
  // A hint, a press and its release leave the buttons' jobs as they are.
  store.note('2', 'x');
  assert.deepEqual([store.get('2').job, store.get('2').interrupted, buttons('2')], [null, 'x', { download: 'download progress 2' }]);
  store.press('2', 'revert');
  store.release('2');
  assert.deepEqual(buttons('2'), { download: 'download progress 2' });

  // Its card gone from the page: what still runs is kept, the download the card's when it comes back.
  w.say({ gid: '3', kind: 'download', status: 'progress', done: 1, total: 4 });
  w.say({ gid: '3', kind: 'translate', status: 'progress', done: 1, total: 4 });
  w.say({ gid: '3', kind: 'translate', status: 'error', error: 'x' });
  store.showing(['1']);
  assert.deepEqual([store.get('3').job.kind, store.get('3').job.status, buttons('3'), store.live('3')], ['download', 'progress', null, true]);
  store.stop();
});

test('an export under way holds its own button: through a word, a press and its release, a hint, a last word\'s while; gone with its end', async () => {
  const w = world();
  const store = await started(w);
  const { told } = listen(store, ['1']);
  store.exporting('1', true);
  store.exporting('1', true);
  assert.deepEqual([store.get('1').exporting, store.get('1').pending, told['1']], [true, null, 1]);
  // A download pressed while it runs is held too, and the first word answers the press alone.
  store.press('1', 'download');
  assert.deepEqual([store.get('1').exporting, store.get('1').pending], [true, 'download']);
  w.say({ gid: '1', kind: 'download', status: 'progress', done: 1, total: 2 });
  assert.deepEqual([store.get('1').exporting, store.get('1').pending, store.get('1').job.done], [true, null, 1]);
  store.press('1', 'translate');
  store.release('1');
  assert.deepEqual([store.get('1').exporting, store.get('1').pending], [true, null]);
  w.say({ gid: '1', kind: 'download', status: 'done', done: 2, total: 2 });
  store.settled('1');
  assert.deepEqual([store.get('1').exporting, store.get('1').job], [true, null]);
  store.note('1', 'x');
  assert.deepEqual([store.get('1').exporting, store.get('1').interrupted], [true, 'x']);
  store.settled('1');
  assert.equal(store.get('1').exporting, true);
  // Its end: at rest, the one shared state.
  store.exporting('1', false);
  assert.equal(store.get('1'), AT_REST);
  // An export that ends while a job shows leaves the job.
  store.exporting('2', true);
  w.say({ gid: '2', kind: 'translate', status: 'progress', done: 1, total: 2 });
  store.exporting('2', false);
  assert.deepEqual([store.get('2').exporting, store.get('2').job.kind], [false, 'translate']);
  store.stop();
});

test('the page\'s galleries change: what ended on a card no longer shown is forgotten, a running job kept', async () => {
  const w = world();
  const store = await started(w, ['1', '2', '3', '4']);
  w.say({ gid: '1', kind: 'download', status: 'done', done: 2, total: 2 });
  w.say({ gid: '2', kind: 'download', status: 'progress', done: 1, total: 2 });
  store.note('3', 'x');
  store.exporting('4', true);
  store.exporting('2', true);
  store.showing(['5']);
  assert.equal(store.get('1'), AT_REST);
  assert.equal(store.get('2').job.done, 1);
  assert.equal(store.get('3'), AT_REST);
  assert.equal(store.get('4'), AT_REST);
  assert.equal(store.get('2').exporting, undefined, 'a card made again has its export button back, as 1.3\'s had');
  // Back on the page: the running one is there at once, the others at rest.
  store.showing(['1', '2', '3', '4']);
  assert.equal(store.get('2').job.done, 1);
  assert.equal(store.get('1'), AT_REST);
  store.stop();
});

test('stopped: it hears nothing more, forgets everything, and a hydrate still under way does nothing; started again it asks again', async () => {
  let release;
  const w = world({ rows: [{ gid: '1', kind: 'download', status: 'error', at: 999_000 }] });
  const gate = new Promise((r) => { release = r; });
  const current = w.deps.jobs.current;
  w.deps.jobs.current = async () => { await gate; return current(); };
  const store = createLibraryJobs(w.deps);
  store.start();
  store.showing(['1', '2']);
  w.say({ gid: '2', kind: 'download', status: 'progress' });
  const { told } = listen(store, ['2']);
  store.stop();
  assert.equal(w.listening(), 0);
  assert.equal(store.get('2'), AT_REST);
  assert.equal(told['2'], 1, 'told it is at rest');
  release();
  await tick(); await tick();
  assert.equal(store.get('1'), AT_REST, 'the hydrate that landed after the stop did nothing');
  assert.deepEqual(w.asked.filter(([k]) => k === 'clear'), []);
  w.say({ gid: '2', kind: 'download', status: 'progress' });
  assert.equal(store.get('2'), AT_REST);
  store.start();
  store.showing(['1', '2']);
  await tick(); await tick();
  assert.equal(store.get('1').job.status, 'error');
  store.stop();
});

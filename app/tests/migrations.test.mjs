// migrations.test.mjs — a repair that throws must NOT be recorded as done (the previous
// hand-rolled flags were set even after a swallowed error, so a failed repair never re-ran),
// and legacy per-repair flags must be honoured so an already-migrated profile stays put.
import test from 'node:test';
import assert from 'node:assert/strict';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
};

const platform = await import('../js/platform.js');
const { runMigrations, STEPS } = await import('../js/migrations.js');

const calls = [];
let seriesThrows = false;
const fakeSteps = [
  { id: 'countsRepaired', run: async () => { calls.push('counts'); } },
  { id: 'seriesShellStatsRepaired', run: async () => { calls.push('series'); if (seriesThrows) throw new Error('boom'); } },
  { id: 'uploadDateBackfilled', run: async () => { calls.push('upload'); } },
];

const steps = async () => (await platform.kv.get(['schemaSteps'])).schemaSteps || [];

test('the real step list is ordered and uniquely identified', () => {
  const ids = STEPS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'step ids must be unique');
  for (const step of STEPS) assert.equal(typeof step.run, 'function');
});

test('a successful run records every step once', async () => {
  _store.clear();
  calls.length = 0;
  seriesThrows = false;
  await runMigrations(fakeSteps);
  assert.deepEqual(calls, ['counts', 'series', 'upload']);
  assert.deepEqual(await steps(), ['countsRepaired', 'seriesShellStatsRepaired', 'uploadDateBackfilled']);

  calls.length = 0;
  await runMigrations(fakeSteps);
  assert.deepEqual(calls, [], 'completed steps never re-run');
});

test('a throwing step is not recorded and is retried on the next run', async () => {
  _store.clear();
  calls.length = 0;
  seriesThrows = true;

  await runMigrations(fakeSteps);
  assert.deepEqual(calls, ['counts', 'series']);
  assert.deepEqual(await steps(), ['countsRepaired'], 'a failed repair must not be marked done');

  calls.length = 0;
  seriesThrows = false;
  await runMigrations(fakeSteps);
  assert.deepEqual(calls, ['series', 'upload'], 'the failed step retries, then the rest follow');
  assert.deepEqual(await steps(), ['countsRepaired', 'seriesShellStatsRepaired', 'uploadDateBackfilled']);
});

test('legacy per-repair flags count as completed steps', async () => {
  _store.clear();
  calls.length = 0;
  seriesThrows = false;
  platform.kv.set({ countsRepaired: true, seriesShellStatsRepaired: true });
  await runMigrations(fakeSteps);
  assert.deepEqual(calls, ['upload'], 'an already-migrated profile only runs what it is missing');
});

test('a run reports each step and its progress, so the page can show it', async () => {
  _store.clear();
  const events = [];
  await runMigrations([{ id: 'reported', run: async (progress) => { progress(1, 2); progress(2, 2); } }],
    { step: () => events.push('step'), progress: (done, total) => events.push(`${done}/${total}`), end: () => events.push('end') });
  assert.deepEqual(events, ['step', '1/2', '2/2', 'end']);
  events.length = 0;
  await runMigrations([{ id: 'reported', run: async () => events.push('ran again') }],
    { step: () => events.push('step'), progress: () => {}, end: () => events.push('end') });
  assert.deepEqual(events, ['end'], 'nothing left to run: nothing to show');
});

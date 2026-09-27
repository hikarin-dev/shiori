// jobs-writes.test.mjs — a translation's polls write a few bytes, not its whole job record: the
// poll position lives on its own and is written only when it moves; progress rows in the job
// registry are saved every few seconds, other statuses always.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const platform = await import('../js/platform.js');

const puts = [];
const put = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function () { puts.push(this.name); return put.apply(this, arguments); };

test('a poll writes only its position, and nothing when the position did not move', async () => {
  const rec = { gid: '9', token: 't1', phase: 'polling', cursor: 0, pendingUrls: Array.from({ length: 500 }, (_, i) => `local://9/${i}.webp`) };
  assert.equal(await platform.translateResume.claim(rec), 'claimed');
  puts.length = 0;
  assert.equal(await platform.translateResume.advance('9', 't1', 5), true);
  assert.deepEqual(puts, ['cursors'], 'the position alone');
  puts.length = 0;
  assert.equal(await platform.translateResume.advance('9', 't1', 5), true);
  assert.deepEqual(puts, [], 'it did not move');
  assert.equal(await platform.translateResume.advance('9', 'other', 9), false, 'another job\'s poll');
  assert.equal((await platform.translateResume.get('9')).cursor, 5);
  assert.equal((await platform.translateResume.all()).find(r => r.gid === '9').cursor, 5);
  assert.equal(await platform.translateResume.remove('9', 't1'), true);
  assert.equal(await platform.translateResume.claim({ ...rec, token: 't2' }), 'claimed');
  assert.equal((await platform.translateResume.get('9')).cursor, 0, 'a new job starts from its own position');
});

test('progress rows are saved every few seconds; other statuses always', async () => {
  puts.length = 0;
  for (let i = 0; i < 5; i++) await platform.jobs.publish({ gid: '9', kind: 'translate', status: 'progress', done: i, total: 5 });
  assert.equal(puts.filter(s => s === 'jobs').length, 1);
  await platform.jobs.publish({ gid: '9', kind: 'translate', status: 'error', error: 'x' });
  await platform.jobs.publish({ gid: '9', kind: 'translate', status: 'progress', done: 1, total: 5 });
  assert.equal(puts.filter(s => s === 'jobs').length, 3, 'after another status, progress is saved again');
});

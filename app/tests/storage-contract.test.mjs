// storage-contract.test.mjs — the folder store contract's helpers (storage/contract.js): its typed
// results are told apart and never collapsed, and only 'ok' and 'missing' may change stored state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PURPOSES, REFUSALS, MISSING, refused, unreadable, corrupt, mayChangeState, parsed, surelyMissing, surelyMissingNow } from '../js/storage/contract.js';

test('a root is opened for one of five purposes, and refused for one of six reasons', () => {
  assert.deepEqual([...PURPOSES], ['read', 'write', 'publish', 'removal', 'claim']);
  // 'handover' (S32): the folder came (back) to this library and its check hasn't read it yet.
  assert.deepEqual([...REFUSALS], ['unavailable', 'other-library', 'no-permission', 'not-owned', 'handover', 'hidden']);
  assert.deepEqual(refused('other-library', 'Shelf'), { status: 'other-library', detail: 'Shelf' });
  assert.deepEqual(refused('unavailable'), { status: 'unavailable', detail: null });
});

test('only what was read whole, or found not there, may change stored state', () => {
  const ok = { kind: 'ok', data: 'x', size: 1, mtime: 0 };
  assert.equal(mayChangeState(ok), true);
  assert.equal(mayChangeState(MISSING), true);
  assert.equal(mayChangeState(unreadable(Object.assign(new Error('busy'), { code: 'EBUSY' }))), false);
  assert.equal(mayChangeState(corrupt('not JSON')), false);
  assert.deepEqual(unreadable(new Error('EACCES: denied')), { kind: 'unreadable', error: 'EACCES: denied' });
  assert.deepEqual(unreadable('NotReadableError'), { kind: 'unreadable', error: 'NotReadableError' });
});

test('a parse keeps the read\'s own result, and text that isn\'t what it should be is corrupt', () => {
  const read = (data) => ({ kind: 'ok', data, size: data.length, mtime: 0 });
  const json = (text) => JSON.parse(text);
  assert.deepEqual(parsed(read('{"a":1}'), json), { kind: 'ok', value: { a: 1 } });
  assert.equal(parsed(MISSING, json), MISSING);
  const failed = unreadable(new Error('gone'));
  assert.equal(parsed(failed, json), failed);
  assert.deepEqual(parsed(read('{'), json, 'gallery.json'), { kind: 'corrupt', detail: 'gallery.json is not valid' });
  assert.deepEqual(parsed(read('{}'), () => null, 'source.json'), { kind: 'corrupt', detail: 'source.json is not valid' });
});

test('"not found" counts only while the library folder is there as itself and a second look agrees — its looks awaited or made at once', async () => {
  const error = 'NotFoundError: not there';
  const cases = [[true, false, 'missing'], [false, false, 'unreadable'], [true, true, 'unreadable']];
  for (const [home, there, kind] of cases) {
    assert.equal((await surelyMissing({ home: async () => home, there: async () => there }, error)).kind, kind);
    assert.equal(surelyMissingNow({ home: () => home, there: () => there }, error).kind, kind);
  }
  // The folder is asked first: away, the file isn't looked at; a look that fails concludes nothing.
  let looked = false;
  assert.deepEqual(surelyMissingNow({ home: () => false, there: () => { looked = true; return false; } }, error), unreadable(error));
  assert.equal(looked, false);
  assert.deepEqual(surelyMissingNow({ home: () => true, there: () => { throw new Error('EIO: busy'); } }, error), unreadable(new Error('EIO: busy')));
});

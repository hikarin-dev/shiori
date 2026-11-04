// storage-contract.test.mjs — the folder store contract's helpers (storage/contract.js): its typed
// results are told apart and never collapsed, and only 'ok' and 'missing' may change stored state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PURPOSES, REFUSALS, MISSING, refused, unreadable, corrupt, mayChangeState, parsed } from '../js/storage/contract.js';

test('a root is opened for one of five purposes, and refused for one of five reasons', () => {
  assert.deepEqual([...PURPOSES], ['read', 'write', 'publish', 'removal', 'claim']);
  assert.deepEqual([...REFUSALS], ['unavailable', 'other-library', 'no-permission', 'not-owned', 'hidden']);
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

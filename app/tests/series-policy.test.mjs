import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.BroadcastChannel = class {
  postMessage() {}
  close() {}
};

const { canDetachChapter } = await import('../js/series.js');

test('pageless chapter galleries cannot be detached from their series', () => {
  assert.equal(canDetachChapter({ count: 0, numPages: 24 }), false);
  assert.equal(canDetachChapter({ count: undefined, numPages: 24 }), false);
  assert.equal(canDetachChapter({ count: Number.NaN, numPages: 24 }), false);
  assert.equal(canDetachChapter({ count: 1, numPages: 24 }), true);
});

test('missing chapter records remain detachable for stale-reference cleanup', () => {
  assert.equal(canDetachChapter(null), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.BroadcastChannel = class {
  postMessage() {}
  close() {}
};

const { canDetachChapter, chapterNumberLabel, chapterTally } = await import('../js/series.js');

test('pageless chapter galleries cannot be detached from their series', () => {
  assert.equal(canDetachChapter({ count: 0, numPages: 24 }), false);
  assert.equal(canDetachChapter({ count: undefined, numPages: 24 }), false);
  assert.equal(canDetachChapter({ count: Number.NaN, numPages: 24 }), false);
  assert.equal(canDetachChapter({ count: 1, numPages: 24 }), true);
});

test('missing chapter records remain detachable for stale-reference cleanup', () => {
  assert.equal(canDetachChapter(null), true);
});

test("a chapter is labelled by the source's own number, decimals kept, or not at all", () => {
  assert.equal(chapterNumberLabel({ number: 23.5 }), '23.5');
  assert.equal(chapterNumberLabel({ number: '10.50' }), '10.5');
  assert.equal(chapterNumberLabel({ number: 0 }), '0', 'a prologue numbered 0 is still numbered');
  assert.equal(chapterNumberLabel({ number: 1 / 3 }), '0.333');
  assert.equal(chapterNumberLabel({ number: 'Special' }), 'Special');
  assert.equal(chapterNumberLabel({ title: 'Merged by hand' }), null, 'the caller falls back to the position');
  assert.equal(chapterNumberLabel({ number: '' }), null);
});

test('a series counts its whole chapters and its extras apart', () => {
  const nums = (...ns) => ns.map(number => (number === undefined ? {} : { number }));
  assert.deepEqual(chapterTally(nums(1, 2, 2.5, 3, 3.1, 3.2)), { chapters: 3, extras: 3 });
  assert.deepEqual(chapterTally(nums(1, '1', 2)), { chapters: 2, extras: 0 }, 'two releases of chapter 1 are one chapter');
  assert.deepEqual(chapterTally(nums(undefined, undefined, 'Special')), { chapters: 3, extras: 0 }, 'unnumbered chapters count as chapters');
  assert.deepEqual(chapterTally(nums(0, 1, undefined)), { chapters: 2, extras: 1 }, 'a chapter 0 is an extra');
  assert.deepEqual(chapterTally([]), { chapters: 0, extras: 0 });
});

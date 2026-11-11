// personal.test.mjs — a person's own marks on a gallery (storage/personal.js, plan D6, D10, D11): what
// a mark holds, how reading moves it, where the reader resumes, and when an earlier version's
// favorite is taken into a library's store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutPersonal, marksOf, withMarks, importMarks, resumeAt } from '../js/storage/personal.js';

test('metadata holds no personal mark: an earlier version\'s favorite is taken out, the rest kept', () => {
  const meta = { galleryId: '1', title: { english: 'A' }, favorite: true };
  assert.deepEqual(withoutPersonal(meta), { galleryId: '1', title: { english: 'A' } });
  const plain = { galleryId: '2' };
  assert.equal(withoutPersonal(plain), plain, 'unchanged when there is nothing to take out');
  assert.equal(withoutPersonal(null), null);
});

test('marks are read field by field: only well-formed fields kept, none at all is null', () => {
  assert.equal(marksOf(null), null);
  assert.equal(marksOf({ favorite: 'yes', page: 0, readAt: -1 }), null);
  assert.deepEqual(marksOf({ favorite: false, page: 3, pages: 10, readAt: 5, finished: true, extra: 1 }),
    { favorite: false, page: 3, pages: 10, readAt: 5, finished: true });
  assert.deepEqual(marksOf({ page: 3 }), null, 'a page without the pages it had then is not kept');
});

test('reading moves where the person left off; the last page finishes the gallery, and it stays finished', () => {
  let m = withMarks(null, { favorite: true });
  assert.deepEqual(m, { favorite: true });
  m = withMarks(m, { read: { page: 4, pages: 10 } }, 100);
  assert.deepEqual(m, { favorite: true, page: 4, pages: 10, readAt: 100 });
  m = withMarks(m, { read: { page: 10, pages: 10 } }, 200);
  assert.equal(m.finished, true);
  m = withMarks(m, { read: { page: 2, pages: 10 } }, 300);
  assert.deepEqual([m.page, m.readAt, m.finished], [2, 300, true], 'read again: its place moves, it stays finished');
  assert.deepEqual(withMarks(m, { favorite: false }).favorite, false, 'unset, a favorite is kept as unset');
  assert.deepEqual(withMarks(null, { read: { page: 0, pages: 3 } }), null, 'nothing read: nothing kept');
});

test('the reader resumes where the person left off; from the start when nothing was read, or the end was reached and nothing came since', () => {
  assert.equal(resumeAt(null, 20), 1);
  assert.equal(resumeAt({ page: 7, pages: 20 }, 20), 7);
  assert.equal(resumeAt({ page: 7, pages: 20 }, 5), 5, 'never past the pages it has now');
  assert.equal(resumeAt({ page: 20, pages: 20, finished: true }, 20), 1, 'read to its end: again from the start');
  assert.equal(resumeAt({ page: 20, pages: 20, finished: true }, 25), 20, 'pages came since: on from where it ended');
  assert.equal(resumeAt({ page: 3, pages: 20, finished: true }, 20), 3, 'read again part way: there');
});

test('an earlier version\'s favorite is taken in once: never over a favorite the library has of its own', () => {
  assert.deepEqual(importMarks(null, { favorite: true }), { favorite: true });
  assert.deepEqual(importMarks({ page: 2, pages: 5 }, { favorite: true }), { page: 2, pages: 5, favorite: true });
  assert.equal(importMarks({ favorite: false }, { favorite: true }), null, 'unset by the person: stays unset');
  assert.equal(importMarks(null, { favorite: false }), null);
  assert.equal(importMarks(null, {}), null);
});

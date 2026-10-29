// hidden-writes.test.mjs — which galleries a library write touches, so one whose folder is hidden or
// removed is never written to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WRITES, writeTargets, hiddenError } from '../js/hidden-writes.js';

test('a write names the galleries it touches; a read names none', () => {
  assert.deepEqual(writeTargets('pagePut', ['17', 3, null]), ['17']);
  assert.deepEqual(writeTargets('metaPut', [{ galleryId: '17' }]), ['17']);
  assert.deepEqual(writeTargets('putTranslatedImage', [{ galleryId: '17', pageNum: 2 }, null]), ['17']);
  assert.deepEqual(writeTargets('setPagesOwn', [[{ galleryId: '17', pageNum: 1 }, { galleryId: '18', pageNum: 1 }], 'j']), ['17', '18']);
  assert.deepEqual(writeTargets('seriesCommand', ['attach', '17', '18', { title: 'x' }]), ['17', '18']);
  assert.deepEqual(writeTargets('getGallery', ['17']), []);
  assert.ok(WRITES.has('deleteGallery') && !WRITES.has('galleriesPage'));
  const e = hiddenError('17');
  assert.equal(e.code, 'invalid');
  assert.equal(e.reason, 'hidden');
});

// series-merge.test.mjs — turning a standalone gallery into a series must leave EVERY chapter
// (the owner included) with a chapter title, so chapter 1 is never the odd one out in the
// reader's chapter divider, the overview's title fields or a series export.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const { mutateGallery, metaGet } = await import('../js/db.js');
const { mergeIntoSeries } = await import('../js/series.js');

const titled = (english, japanese = '') => ({ title: { english, japanese, pretty: '' } });

test('the owner chapter gets its own title when a standalone gallery becomes a series', async () => {
  await mutateGallery('OWN1', titled('Chapter One'));
  await mutateGallery('KID1', titled('Chapter Two'));

  await mergeIntoSeries('OWN1', 'KID1');

  const meta = await metaGet('OWN1');
  assert.deepEqual(meta.chapters.map(c => [String(c.id), c.title]), [
    ['OWN1', 'Chapter One'],
    ['KID1', 'Chapter Two'],
  ]);
});

test('a later merge leaves the established chapter titles alone', async () => {
  await mutateGallery('OWN2', titled('One'));
  await mutateGallery('KID2', titled('Two'));
  await mutateGallery('KID3', titled('Three'));

  await mergeIntoSeries('OWN2', 'KID2');
  await mergeIntoSeries('OWN2', 'KID3');

  const meta = await metaGet('OWN2');
  assert.deepEqual(meta.chapters.map(c => c.title), ['One', 'Two', 'Three']);
});

test('absorbing a series keeps every absorbed chapter title, its former owner included', async () => {
  await mutateGallery('OWN3', titled('A1'));
  await mutateGallery('KID4', titled('A2'));
  await mutateGallery('SUB1', titled('B1'));
  await mutateGallery('KID5', titled('B2'));

  await mergeIntoSeries('OWN3', 'KID4');
  await mergeIntoSeries('SUB1', 'KID5');
  await mergeIntoSeries('OWN3', 'SUB1');

  const meta = await metaGet('OWN3');
  assert.deepEqual(meta.chapters.map(c => c.title), ['A1', 'A2', 'B1', 'B2']);
});

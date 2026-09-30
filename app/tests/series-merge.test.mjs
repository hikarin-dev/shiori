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

const { reorderChapters, removeChapter } = await import('../js/series.js');
const tag = (type, name) => ({ type, name, url: '' });
const favorites = (...ids) => Promise.all(ids.map(async (id) => !!(await metaGet(id)).favorite));

test('a merged series keeps one category, the first, and its highest rating', async () => {
  await mutateGallery('RAT1', { ...titled('A'), tags: [tag('category', 'manga'), tag('rating', 'suggestive'), tag('artist', 'x')] });
  await mutateGallery('RAT2', { ...titled('B'), tags: [tag('category', 'doujinshi'), tag('rating', 'pornographic')] });
  await mutateGallery('RAT3', { ...titled('C'), tags: [tag('rating', 'safe'), tag('artist', 'y')] });

  await mergeIntoSeries('RAT1', 'RAT2');
  await mergeIntoSeries('RAT1', 'RAT3');

  const { seriesTags } = await metaGet('RAT1');
  assert.deepEqual(seriesTags.map(t => `${t.type}:${t.name}`), ['category:manga', 'artist:x', 'rating:pornographic', 'artist:y']);
  assert.deepEqual((await metaGet('RAT2')).tags.map(t => t.name), ['doujinshi', 'pornographic'], "a chapter's own tags are untouched");
});

test('the series favorite moves with the first chapter: reordered, removed, dissolved', async () => {
  for (const id of ['FAV1', 'FAV2', 'FAV3']) await mutateGallery(id, { ...titled(id), count: 1 });
  await mergeIntoSeries('FAV1', 'FAV2');
  await mergeIntoSeries('FAV1', 'FAV3');
  await mutateGallery('FAV1', { favorite: true });

  await reorderChapters('FAV1', ['FAV2', 'FAV1', 'FAV3']);   // FAV2 heads the series now
  assert.deepEqual(await favorites('FAV1', 'FAV2', 'FAV3'), [false, true, false]);

  await removeChapter('FAV2', 'FAV2');                       // the head leaves: FAV1 takes over
  assert.deepEqual(await favorites('FAV1', 'FAV2', 'FAV3'), [true, false, false]);

  await removeChapter('FAV1', 'FAV1');                       // one chapter left: it stands alone
  assert.deepEqual(await favorites('FAV1', 'FAV3'), [false, true]);
});

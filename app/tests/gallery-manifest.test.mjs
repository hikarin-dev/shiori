// gallery-manifest.test.mjs — the shared rules of a gallery's deletion (storage/gallery-manifest.js,
// plan principle 4): what it takes, in what order, and which descriptions are the gallery's; and when a
// folder an earlier desktop version never described may be given its identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryDeletion, isOwnDescription, undescribedMatch, sha256Hex, foreignEntries } from '../js/storage/gallery-manifest.js';

const G = '1700000000001';
const manifest = (sizes) => ({ format: 'shiori-gallery', version: 2, galleryId: G, generation: 3, writer: 'test',
  files: { pages: {}, covers: {} }, sizes, descriptions: {} });

test('a deletion takes the pictures the library recorded, those the manifest records beside them, then the descriptions, what names the gallery last', () => {
  const plan = galleryDeletion({ area: '.shiori/', manifest: manifest({ 'images/0001.png': [5, 100], 'images/0002.png': [6, 200] }),
    named: [{ name: 'images/0001.png', size: 5, mtime: 101 }, { name: 'translated/0001.png', size: 7, mtime: null }] });
  assert.deepEqual(plan.pictures, [{ name: 'images/0001.png', size: 5, mtime: 101 }, { name: 'translated/0001.png', size: 7, mtime: null },
    { name: 'images/0002.png', size: 6, mtime: 200 }], 'the library\'s record wins for a file both name');
  assert.deepEqual(plan.descriptions, ['image_records.json', 'study/bubbles.json', 'covers/manifest.json']);
  assert.equal(plan.stored, '.shiori/d');
  assert.deepEqual(plan.identity, ['metadata.json', 'shiori.json', '.shiori/gallery.json'], 'the manifest last');
  assert.deepEqual(galleryDeletion({ area: '.shiori/', manifest: null, named: [] }).pictures, [], 'format v1: what the library recorded alone');
});

test('a description is the gallery\'s only when Shiori wrote it so: stored by its content, naming the gallery, of its shape', async () => {
  const meta = JSON.stringify({ galleryId: G, title: { english: 'T', japanese: '', pretty: '' } });
  assert.equal(await isOwnDescription(`.shiori/d/${await sha256Hex(meta)}.json`, meta, G, '.shiori/'), true);
  assert.equal(await isOwnDescription(`.shiori/d/${'0'.repeat(64)}.json`, meta, G, '.shiori/'), false, 'content not matching its name');
  assert.equal(await isOwnDescription('metadata.json', meta, G, '.shiori/'), true);
  assert.equal(await isOwnDescription('metadata.json', meta, '1700000000002', '.shiori/'), false, 'another gallery\'s');
  assert.equal(await isOwnDescription('metadata.json', '{"title":"a tool\'s own"}', G, '.shiori/'), false);
  assert.equal(await isOwnDescription('image_records.json', '[]', G, '.shiori/'), true);
  assert.equal(await isOwnDescription('image_records.json', '{', G, '.shiori/'), false, 'not of its shape');
  assert.equal(await isOwnDescription('notes.json', '[]', G, '.shiori/'), false, 'not a description\'s name');
  const m = JSON.stringify(manifest({}));
  assert.equal(await isOwnDescription('.shiori/gallery.json', m, G, '.shiori/'), true);
  assert.equal(await isOwnDescription('.shiori/gallery.json', m, '1700000000002', '.shiori/'), false);
});

test('a folder never described may take its gallery\'s identity only holding no description and exactly the pictures recorded', () => {
  const named = new Map([['images/0001.png', { size: 5, mtime: 100.4 }], ['images/0002.png', { size: 6, mtime: null }]]);
  const found = new Map([['images/0001.png', { size: 5, mtime: 100.9 }], ['images/0002.png', { size: 6, mtime: 999 }]]);
  assert.equal(undescribedMatch({ texts: {}, named, found }), 'match');
  assert.equal(undescribedMatch({ texts: { 'metadata.json': '{' }, named, found }), 'described', 'a description of no gallery is never written over');
  assert.equal(undescribedMatch({ texts: {}, named, found: new Map([...found, ['images/0003.png', { size: 1, mtime: 1 }]]) }), 'mismatch', 'one more picture');
  assert.equal(undescribedMatch({ texts: {}, named, found: new Map([['images/0001.png', { size: 5, mtime: 100 }]]) }), 'mismatch', 'one less');
  assert.equal(undescribedMatch({ texts: {}, named, found: new Map([['images/0001.png', { size: 5, mtime: 300 }], ['images/0002.png', { size: 6, mtime: 1 }]]) }), 'mismatch', 'changed since');
});

test('F6: an archive\'s entries that aren\'t Shiori\'s — a file added, a picture of another size than its manifest records — are the person\'s', () => {
  const manifest = /** @type {any} */ ({ files: { pages: { 1: { original: 'images/0001.png' } }, covers: {} }, sizes: { 'images/0001.png': [10, 0] } });
  const entries = (/** @type {[string, number][]} */ list) => new Map(list.map(([name, size]) => [name, { size }]));
  const own = [['images/0001.png', 10], ['metadata.json', 5], ['image_records.json', 5], ['.shiori/gallery.json', 5], ['ComicInfo.xml', 5]];
  assert.deepEqual(foreignEntries(entries(/** @type {any} */ (own)), manifest), []);
  assert.deepEqual(foreignEntries(entries([...(/** @type {any} */ (own)), ['notes.txt', 4], ['images/0099.png', 3]]), manifest), ['notes.txt', 'images/0099.png']);
  assert.deepEqual(foreignEntries(entries([['images/0001.png', 11]]), manifest), ['images/0001.png'], 'replaced by one of another size');
  assert.deepEqual(foreignEntries(entries([['images/0099.png', 3], ['notes.txt', 4]]), null), ['notes.txt'], 'before manifests: any picture where pictures go');
});

test('S25b: a deletion met at the other kind of place than it recorded takes what that place\'s manifest records alone, nothing without one', () => {
  const plan = galleryDeletion({ area: '.shiori/', manifest: manifest({ 'images/0001.png': [5, 100] }), named: null });
  assert.deepEqual(plan?.pictures, [{ name: 'images/0001.png', size: 5, mtime: 100 }], 'a folder the other app unpacked the gallery into');
  assert.equal(galleryDeletion({ area: '.shiori/', manifest: null, named: null }), null, 'one without a manifest: nothing there is known to be Shiori\'s');
  const archived = /** @type {any} */ ({ files: { pages: { 1: { original: 'images/0001.png' } }, covers: {} }, sizes: { 'images/0001.png': [10, 0] } });
  const entries = new Map([['images/0001.png', { size: 10 }], ['metadata.json', { size: 5 }]]);
  assert.deepEqual(foreignEntries(entries, archived, { met: true }), [], 'an archive the other app made of the gallery\'s folder');
  assert.deepEqual(foreignEntries(entries, null, { met: true }), ['images/0001.png', 'metadata.json'], 'one without a manifest: all of it the person\'s');
});

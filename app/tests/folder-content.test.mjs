// folder-content.test.mjs — what a library folder holds, as both apps read it: a folder or archive
// is Shiori's own only when it carries a description Shiori writes (a metadata.json naming a gallery,
// a series.json, an earlier desktop version's shiori.json) — everything Shiori has written passes,
// an images/ folder or another tool's metadata.json doesn't (R01, A20); an archive with an entry
// whose name leaves its folder is never Shiori's (it would be unpacked); a series export ZIP is a
// series, not chapters made of its images/ and translated/ folders (R14); and one rule decodes
// archive entry names, so both apps name an archive's chapters alike (A08).
import test from 'node:test';
import assert from 'node:assert/strict';
import { OWN_FILES, TEMPORARY, galleryIdOf, seriesOf, classifyFolder, classifyArchive, galleryAt, zipName } from '../js/storage/folder-content.js';
import { firstGeneration } from '../js/storage/gallery-manifest.js';
import { galleryFiles, seriesManifest } from '../js/storage/gallery-files.js';
import { zipTitles, sourceKey } from '../js/storage/linked-source.js';

const png = (n) => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, n])], { type: 'image/png' });
const meta = (galleryId, english = 'A Title') => ({ galleryId, title: { english, japanese: '', pretty: english }, tags: [], numPages: 2 });
// A gallery's files as Shiori writes them (gallery-files.js): their names, and metadata.json's text.
function written(m, { covers = {} } = {}) {
  const files = galleryFiles({ meta: m, records: [1, 2].map(n => ({ pageNum: n, url: `local://${m.galleryId}/${n}.png`, blob: png(n) })), covers });
  const text = new TextDecoder().decode(files.find(f => f.name === 'metadata.json').source);
  return { names: files.map(f => f.name), text };
}

test('every metadata.json Shiori has written names its gallery: the title object, or an early version\'s flat titles and number id', () => {
  assert.equal(galleryIdOf(written(meta('1790000000001')).text), '1790000000001', 'as gallery-files.js writes it today');
  assert.equal(galleryIdOf(JSON.stringify({ galleryId: 123456, titleEnglish: 'Old', titleJapanese: '', titlePretty: 'Old', tags: [] })), '123456',
    'an early export: flat title fields, a number id');
  assert.equal(galleryIdOf(JSON.stringify({ galleryId: '42', titlePretty: '' })), '42');
});

test('a metadata.json Shiori didn\'t write names no gallery', () => {
  for (const text of [
    JSON.stringify({ title: 'Downloaded', id: 5, pages: 20 }),                       // another tool's
    JSON.stringify({ galleryId: '1790000000001', title: 'a plain string' }),        // no title object
    JSON.stringify({ galleryId: '1790000000001' }),                                  // no title at all
    JSON.stringify({ galleryId: 'abc', title: { english: 'x' } }),                   // not an id
    JSON.stringify({ galleryId: '../../x', title: { english: 'x' } }),
    JSON.stringify({ galleryId: '', title: { english: 'x' } }),
    JSON.stringify({ galleryId: 1e21, title: { english: 'x' } }),
    JSON.stringify({ galleryId: { id: 1 }, title: { english: 'x' } }),
    JSON.stringify({ galleryId: '1790000000001', title: ['x'] }),
    JSON.stringify([{ galleryId: '1790000000001', title: { english: 'x' } }]),
    'null', '{"galleryId": "1790000000001", "title": {', '', null, undefined,
  ]) assert.equal(galleryIdOf(text), null, String(text));
});

test('every series.json Shiori has written is a series; one that isn\'t, or names a folder outside, is not', () => {
  const owner = { galleryId: '1790000000010', seriesTitle: { english: 'Saga', japanese: '', pretty: 'Saga' }, tags: [],
    chapters: [{ id: '1790000000010', title: 'One', number: 1 }, { id: '1790000000011', title: 'Two', number: 2, kind: 'volume' }] };
  const s = seriesOf(JSON.stringify(seriesManifest(owner)));
  assert.deepEqual(s.chapters.map(c => [c.id, c.folder, c.title]), [['1790000000010', 'Saga Ch. 001', 'One'], ['1790000000011', 'Saga Vol. 002', 'Two']]);
  assert.deepEqual(s.seriesTitle, owner.seriesTitle);
  const early = seriesOf(JSON.stringify({ format: 'shiori-series', version: 1, seriesTitle: 'S', chapters: [
    { id: '1790000000010', title: 'One', folder: 'chapter-01' }, { id: 1790000000011, title: 'Two' }] }));
  assert.deepEqual(early.chapters.map(c => [c.id, c.folder]), [['1790000000010', 'chapter-01'], ['1790000000011', 'chapter-02']],
    'an early export: chapter-NN folders, a missing one implied, a number id');
  const chapters = (c) => JSON.stringify({ format: 'shiori-series', version: 1, chapters: [c] });
  for (const text of [
    JSON.stringify({ chapters: [{ id: '1790000000010', folder: 'a' }] }),           // no format
    JSON.stringify({ format: 'shiori-series', chapters: [] }),
    chapters({ title: 'no id', folder: 'a' }), chapters({ id: 'x', folder: 'a' }),
    chapters({ id: '1790000000010', folder: '../outside' }), chapters({ id: '1790000000010', folder: 'a/b' }),
    chapters({ id: '1790000000010', folder: 'C:' }), chapters({ id: '1790000000010', folder: '..' }),
    'not json', null,
  ]) assert.equal(seriesOf(text), null, String(text));
});

test('a folder is Shiori\'s by what its descriptions say, never by its file or folder names (R01)', () => {
  assert.deepEqual(OWN_FILES, ['.shiori/gallery.json', 'metadata.json', 'series.json', 'shiori.json']);
  assert.deepEqual(classifyFolder({}), { kind: 'other' }, 'images/ alone (no description): not Shiori\'s');
  const manifest = JSON.stringify({ format: 'shiori-gallery', version: 2, galleryId: '1790000000003', generation: 4, writer: 'w' });
  assert.deepEqual(classifyFolder({ '.shiori/gallery.json': manifest }), { kind: 'gallery', id: '1790000000003' }, 'its manifest (format v2), metadata.json or not');
  assert.deepEqual(classifyFolder({ '.shiori/gallery.json': manifest, 'metadata.json': written(meta('1790000000001')).text }), { kind: 'gallery', id: '1790000000003' },
    'the manifest first');
  assert.deepEqual(classifyFolder({ 'metadata.json': JSON.stringify({ title: 'Downloaded', creator: 'someone' }) }), { kind: 'other' },
    'another tool\'s metadata.json');
  assert.deepEqual(classifyFolder({ 'metadata.json': written(meta('1790000000001')).text }), { kind: 'gallery', id: '1790000000001' });
  assert.deepEqual(classifyFolder({ 'shiori.json': JSON.stringify({ format: 'shiori-gallery', version: 1, id: '1790000000002', meta: null, pages: [] }) }),
    { kind: 'gallery', id: '1790000000002', legacy: true }, 'an earlier desktop version\'s gallery');
  assert.deepEqual(classifyFolder({ 'shiori.json': JSON.stringify({ id: '1790000000002' }) }), { kind: 'other' });
  const series = JSON.stringify({ format: 'shiori-series', version: 1, chapters: [{ id: '1790000000010', folder: 'Saga Ch. 001' }] });
  assert.equal(classifyFolder({ 'series.json': series }).kind, 'series');
  assert.equal(classifyFolder({ 'series.json': series, 'metadata.json': written(meta('1790000000001')).text }).kind, 'series',
    'a series\' folder is walked for its members, never taken whole as one gallery');
  assert.deepEqual(classifyFolder({ 'series.json': '{"format":"other"}', 'metadata.json': written(meta('1790000000001')).text }),
    { kind: 'gallery', id: '1790000000001' });
});

test('a gallery\'s folder still as its reservation made it is reserved: its gallery\'s, never taken for it by a check (S12, review 4 F2)', () => {
  const reservation = JSON.stringify(firstGeneration('1790000000003', 'w'));
  assert.deepEqual(classifyFolder({ '.shiori/gallery.json': reservation }), { kind: 'gallery', id: '1790000000003', reserved: true });
  assert.equal(galleryAt({ '.shiori/gallery.json': reservation }, '1790000000003').kind, 'ok', 'it names its gallery for the library writing to it');
  assert.deepEqual(classifyFolder({ '.shiori/gallery.json': reservation, 'metadata.json': written(meta('1790000000003')).text }),
    { kind: 'gallery', id: '1790000000003', reserved: true }, 'the manifest first');
  const published = JSON.stringify({ ...JSON.parse(reservation), generation: 1 });
  assert.deepEqual(classifyFolder({ '.shiori/gallery.json': published }), { kind: 'gallery', id: '1790000000003' }, 'whole from its first publication');
});

test('Shiori\'s temporary names are told by both apps alike (S12, review 4 F7)', () => {
  for (const name of ['Alpha.shiori-tmp', 'Alpha.1a2b3c4d.shiori-tmp', 'Alpha.zip.1a2b3c4d.shiori-tmp', 'gallery.json.shiori-tmp', '0001.png.0a1b2c3d4e.shiori-new', 'x.shiori-old']) {
    assert.ok(TEMPORARY.test(name), name);
  }
  for (const name of ['Alpha', 'Alpha.zip', 'shiori-tmp', 'Alpha.shiori-tmp.png', 'Alpha (2)']) assert.ok(!TEMPORARY.test(name), name);
});

test('an archive is Shiori\'s own when its description says so and every entry stays inside it; else it is linked (R01, R14, A20)', () => {
  const { names, text } = written(meta('1790000000001'), { covers: { gallery: png(9) } });
  assert.deepEqual(classifyArchive(names, { 'metadata.json': text }), { kind: 'gallery', id: '1790000000001' },
    'an export with a cover of its own: one gallery, not chapters of images/ and covers/');
  assert.deepEqual(classifyArchive(['metadata.json', '01.png', '02.png'], { 'metadata.json': JSON.stringify({ title: 'Other tool' }) }), { kind: 'linked' },
    'another tool\'s metadata.json beside its pictures');
  assert.deepEqual(classifyArchive(['images/0001.png', 'images/0002.png'], {}), { kind: 'linked' }, 'images/ alone');
  for (const bad of ['../evil.png', 'images/../../evil.png', 'x\\..\\..\\evil.png', '/abs/evil.png', 'C:/evil.png', '//host/share/evil.png']) {
    assert.deepEqual(classifyArchive([...names, bad], { 'metadata.json': text }), { kind: 'linked' }, `an entry named ${bad}`);
  }
  assert.deepEqual(classifyArchive(['images/', ...names], { 'metadata.json': text }).kind, 'gallery', 'folder entries end in /');
  assert.deepEqual(classifyArchive(['shiori.json', '001.png'], { 'shiori.json': JSON.stringify({ format: 'shiori-gallery', id: '1790000000003' }) }),
    { kind: 'gallery', id: '1790000000003', legacy: true });
});

test('a series export ZIP is a series, each chapter saying whether the archive holds its folder (R14)', () => {
  const owner = { galleryId: '1790000000010', seriesTitle: 'Saga', tags: [],
    chapters: [{ id: '1790000000010', title: 'One' }, { id: '1790000000011', title: 'Two' }, { id: '1790000000012', title: 'Three' }] };
  const manifest = seriesManifest(owner);
  const member = (i) => written(meta(manifest.chapters[i].id)).names.map(n => `${manifest.chapters[i].folder}/${n}`);
  const names = [...member(0), ...member(1), 'series.json'];
  const got = classifyArchive(names, { 'series.json': JSON.stringify(manifest) });
  assert.equal(got.kind, 'series');
  assert.deepEqual(got.series.chapters.map(c => [c.id, c.present]), [['1790000000010', true], ['1790000000011', true], ['1790000000012', false]]);
  // Without the classification the linked planner would split it by its folders: the bug it prevents.
  assert.deepEqual(zipTitles(names).map(t => t.inner), ['Saga Ch. 001/images/', 'Saga Ch. 002/images/'],
    'zipTitles alone takes the members\' images/ folders for chapters');
});

test('entry names: flagged UTF-8 as UTF-8; unflagged, UTF-8 when valid, else code page 437 — one rule for both apps (A08)', () => {
  const enc = new TextEncoder();
  assert.equal(zipName(enc.encode('第1話/001.png'), true), '第1話/001.png');
  assert.equal(zipName(enc.encode('第1話/001.png'), false), '第1話/001.png', 'UTF-8 without the flag, as macOS and many tools write it');
  assert.equal(zipName(enc.encode('Plain/001.png'), false), 'Plain/001.png');
  assert.equal(zipName(new Uint8Array([0x81, 0x82, 0x2f, 0xe1, 0x80, 0xb0, 0xff]), false), 'üé/ßÇ░\u00a0', 'code page 437');
  assert.equal(zipName(new Uint8Array([0xff, 0x41]), true), '\ufffdA', 'a flagged name that isn\'t UTF-8 keeps its replacement mark');
  const all = zipName(Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i), false);
  assert.equal(all.length, 128, 'every high byte is one character');
  assert.equal(new Set(all).size, 128, 'and no two alike');
  // The same archive read by either app gives its chapters the same keys (desktop read latin1 before).
  const raw = ['第1話/001.png', '第1話/002.png', '第2話/001.png'].map(n => enc.encode(n));
  const keys = zipTitles(raw.map(b => zipName(b, false))).map(t => sourceKey({ kind: 'zip', path: 'A.zip', inner: t.inner }));
  assert.deepEqual(keys, ['zip\u0000A.zip\u0000第1話/', 'zip\u0000A.zip\u0000第2話/']);
});

// linked-source.test.mjs — what a library folder holds that Shiori didn't make, as galleries: every
// folder holding pictures one, every archive one (a series when its pictures sit in folders), every
// PDF one; Shiori's own folders left out; names read the way such names are written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTitles, zipTitles, metaFromName, sourceText, parseSource, sourceKey, isRemoved } from '../js/linked-source.js';

test('every folder holding pictures, every archive and every PDF is a title; Shiori\'s own folders and other files are left out', () => {
  const titles = planTitles([
    { path: 'Pack/[A] One.zip' }, { path: 'Pack/readme.txt' }, { path: 'Pack/checksums.sfv' },
    { path: 'Loose/10.png' }, { path: 'Loose/2.png' }, { path: 'Loose/1.png' },
    { path: 'Pack/Title X/001.jpg' }, { path: 'Pack/Title Y/001.jpg' }, { path: 'Pack/cover.jpg' },
    { path: 'Book.pdf' }, { path: 'top.png' },
    { path: 'Mine/metadata.json' }, { path: 'Mine/images/0001.png' }, { path: 'Mine/translated/0001.png' },
    { path: '.shiori/library.json' }, { path: 'x/.hidden/1.png' }, { path: '__MACOSX/a.png' },
  ], 'Library');
  assert.deepEqual(titles.map(t => [t.kind, t.path, t.name || '']), [
    ['dir', '', 'Library'], ['pdf', 'Book.pdf', ''], ['dir', 'Loose', 'Loose'], ['dir', 'Pack', 'Pack'],
    ['zip', 'Pack/[A] One.zip', ''], ['dir', 'Pack/Title X', 'Title X'], ['dir', 'Pack/Title Y', 'Title Y'],
  ]);
  assert.deepEqual(titles.find(t => t.path === 'Loose').pictures.map(p => p.path), ['Loose/1.png', 'Loose/2.png', 'Loose/10.png'], 'in natural order');
});

test('an archive is one gallery — a series when its pictures sit in folders, loose pictures opening the first chapter', () => {
  assert.deepEqual(zipTitles(['b.png', 'a.png', 'notes.txt']), [{ inner: '', pictures: ['a.png', 'b.png'], chapter: false }]);
  assert.deepEqual(zipTitles(['Only/1.png', 'cover.png']), [{ inner: '', pictures: ['cover.png', 'Only/1.png'], chapter: false }], 'one folder is no series');
  assert.deepEqual(zipTitles(['Ch 2/1.png', 'Ch 10/1.png', 'Ch 2/2.png', 'cover.png', '__MACOSX/Ch 2/1.png']), [
    { inner: 'Ch 2/', pictures: ['cover.png', 'Ch 2/1.png', 'Ch 2/2.png'], chapter: true },
    { inner: 'Ch 10/', pictures: ['Ch 10/1.png'], chapter: true },
  ]);
  assert.deepEqual(zipTitles(['readme.txt']), []);
});

test('a name says its title, artist and circle; its folders are tags', () => {
  assert.deepEqual(metaFromName('[Circle (Artist A, B)] The Title (Collection 2020).zip', ['h', 'chapters']), {
    title: { english: '[Circle (Artist A, B)] The Title (Collection 2020)', japanese: '', pretty: 'The Title' },
    tags: [{ type: 'group', name: 'circle' }, { type: 'artist', name: 'artist a' }, { type: 'artist', name: 'b' },
      { type: 'tag', name: 'h' }, { type: 'tag', name: 'chapters' }],
  });
  assert.deepEqual(metaFromName('Book.pdf'), { title: { english: 'Book', japanese: '', pretty: 'Book' }, tags: [] });
  assert.deepEqual(metaFromName('Plain Title'), { title: { english: 'Plain Title', japanese: '', pretty: 'Plain Title' }, tags: [] });
});

test('a source is kept as it was written, and one removed is told by where it is and what it holds', () => {
  const src = { kind: 'zip', path: 'Pack/Series.zip', inner: 'Ch 1/', size: 10, fingerprint: 'abc' };
  assert.deepEqual(parseSource(sourceText('1790000000000', src)), { galleryId: '1790000000000', source: src });
  assert.equal(parseSource('{"format":"other"}'), null);
  assert.notEqual(sourceKey(src), sourceKey({ ...src, inner: 'Ch 2/' }));
  const removed = [{ kind: 'zip', path: 'Pack/Series.zip', inner: 'Ch 1/', fingerprint: 'abc' }];
  assert.ok(isRemoved(removed, src));
  assert.ok(!isRemoved(removed, { ...src, fingerprint: 'changed' }), 'changed since: new');
  assert.ok(!isRemoved(removed, { ...src, inner: 'Ch 2/' }));
});

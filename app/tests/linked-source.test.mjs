// linked-source.test.mjs — what a library folder holds that Shiori didn't make, as galleries: every
// folder holding pictures one, every archive one (a series when its pictures sit in folders), every
// PDF one; Shiori's own folders left out; names read the way such names are written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTitles, zipTitles, metaFromName, sourceText, parseSource, sourceKey, isRemoved, safeRelPath, withRemoved, linkedPages,
  pdfReady, drawFailed, matchSources, parseRemoved, removedText } from '../js/linked-source.js';

test('every folder holding pictures, every archive and every PDF is a title; Shiori\'s own folders and other files are left out', () => {
  const titles = planTitles([
    { path: 'Pack/[A] One.zip' }, { path: 'Pack/readme.txt' }, { path: 'Pack/checksums.sfv' },
    { path: 'Loose/10.png' }, { path: 'Loose/2.png' }, { path: 'Loose/1.png' },
    { path: 'Pack/Title X/001.jpg' }, { path: 'Pack/Title Y/001.jpg' }, { path: 'Pack/cover.jpg' },
    { path: 'Book.pdf' }, { path: 'top.png' },
    { path: 'Mine/metadata.json' }, { path: 'Mine/images/0001.png' }, { path: 'Mine/translated/0001.png' },
    { path: '.shiori/library.json' }, { path: 'x/.hidden/1.png' }, { path: '__MACOSX/a.png' },
  ], 'Library', ['Mine']);
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

test('a path read from a folder\'s files is used only when it stays inside the folder (R12)', () => {
  for (const ok of ['a.zip', 'Pack/Book.pdf', 'Ünïcode/第1話.zip', 'a b/c.d']) assert.equal(safeRelPath(ok), true, ok);
  for (const bad of ['', '/abs.pdf', '../outside.pdf', 'x/../../y.pdf', 'x\\..\\..\\y.pdf', 'C:/y.pdf', 'C:y.pdf', '//host/share/y.pdf',
    'a//b', 'a/./b', 'a/.../b', 'a/ . /b', 'nul', 'CON.txt', 'a/com1.zip', 'a\u0000b', 'file.txt:stream', null, 7]) {
    assert.equal(safeRelPath(bad), false, String(bad));
  }
  const text = (path, inner) => JSON.stringify({ format: 'shiori-linked', version: 1, galleryId: '1700000000000', source: { kind: 'zip', path, inner } });
  assert.equal(parseSource(text('../outside.zip')), null);
  assert.equal(parseSource(text('a\\..\\..\\outside.zip')), null);
  assert.equal(parseSource(text('ok.zip', '../x/')), null, 'an inner folder is checked too');
  assert.equal(parseSource(text('ok.zip', 'Ch 1/')).source.inner, 'Ch 1/');
  assert.equal(parseSource(JSON.stringify({ format: 'shiori-linked', galleryId: '../x', source: { kind: 'dir', path: 'a' } })), null, 'a gallery id that isn\'t one');
  assert.deepEqual(parseRemoved(removedText([{ kind: 'zip', path: '../x.zip' }, { kind: 'zip', path: 'y.zip' }])).map(r => r.path), ['y.zip']);
});

test('removed.json keeps one note per source, the newest (R17)', () => {
  let list = withRemoved([], { kind: 'zip', path: 'A.zip', inner: 'Ch 1/', fingerprint: 'f1' }, 1);
  list = withRemoved(list, { kind: 'zip', path: 'A.zip', inner: 'Ch 2/', fingerprint: 'f1' }, 2);
  list = withRemoved(list, { kind: 'zip', path: 'A.zip', inner: 'Ch 1/', fingerprint: 'f2' }, 3);
  assert.deepEqual(list.map(r => [r.inner, r.fingerprint, r.at]), [['Ch 2/', 'f1', 2], ['Ch 1/', 'f2', 3]]);
});

test('a linked gallery\'s own page stands in for its source\'s page of the same number (R13)', () => {
  const source = [{ name: 'a.png', size: 1 }, { name: 'b.png', size: 2 }, { name: 'c.png', size: 3 }];
  assert.deepEqual(linkedPages(source, [{ name: '0002.webp', size: 9 }, { name: '0005.png', size: 5 }, { name: 'notes.txt' }]), [
    { n: 1, from: 'source', name: 'a.png', size: 1 }, { n: 2, from: 'overlay', name: '0002.webp', size: 9 },
    { n: 3, from: 'source', name: 'c.png', size: 3 }, { n: 5, from: 'overlay', name: '0005.png', size: 5 },
  ]);
  assert.equal(linkedPages(source, [{ name: '0001-ab12.png', size: 7 }, { name: '0001.png', size: 8 }])[0].name, '0001.png',
    'two files for one page: the one under the layout name');
});

test('a PDF joins only once all its pages are drawn, and one that failed waits for its file to change (R11, A23)', () => {
  const pdf = (rendered) => ({ kind: 'pdf', path: 'B.pdf', ...(rendered ? { rendered } : {}) });
  const drawn = (n) => Array.from({ length: n }, (_, i) => ({ name: `${String(i + 1).padStart(4, '0')}.png` }));
  assert.equal(pdfReady(pdf(null), drawn(3)), false, 'pages drawn so far, no marker: still drawing, or stopped half way');
  assert.equal(pdfReady(pdf(3), drawn(2)), false);
  assert.equal(pdfReady(pdf(3), drawn(3)), true);
  assert.equal(pdfReady({ kind: 'zip', path: 'x.zip', rendered: 1 }, drawn(1)), false);
  const failed = { kind: 'pdf', path: 'B.pdf', failed: { fingerprint: 'f1', at: 1 } };
  assert.equal(drawFailed(failed, 'f1'), true);
  assert.equal(drawFailed(failed, 'f2'), false, 'the file changed: tried again');
  const text = sourceText('1700000000000', { kind: 'pdf', path: 'B.pdf', rendered: 3, failed: { fingerprint: 'f1', at: 5 } });
  assert.deepEqual(parseSource(text).source, { kind: 'pdf', path: 'B.pdf', size: null, fingerprint: null, rendered: 3, failed: { fingerprint: 'f1', at: 5 } });
});

test('a check finds each source again: where it was, changed there, moved — an archive with all its chapters — or new (R18, R19)', () => {
  const zip = (path, inner, fingerprint = 'Z') => ({ kind: 'zip', path, ...(inner ? { inner } : {}), fingerprint });
  const kept = [{ gid: '1', source: zip('Before.zip', 'Ch 1/') }, { gid: '2', source: zip('Before.zip', 'Ch 2/') },
    { gid: '3', source: { kind: 'dir', path: 'Loose', fingerprint: 'D1' } }, { gid: '4', source: { kind: 'dir', path: 'Gone', fingerprint: 'G' } }];
  const out = matchSources({ kept, found: [zip('After.zip', 'Ch 1/'), zip('After.zip', 'Ch 2/'), zip('After.zip', 'Ch 3/'),
    { kind: 'dir', path: 'Loose', fingerprint: 'D2' }, { kind: 'dir', path: 'Fresh', fingerprint: 'F' }] });
  assert.deepEqual(out.moved.map(m => [m.gid, m.title.inner]), [['1', 'Ch 1/'], ['2', 'Ch 2/']], 'a renamed archive keeps its chapters\' galleries');
  assert.deepEqual(out.changed.map(c => [c.gid, c.was.fingerprint, c.title.fingerprint]), [['3', 'D1', 'D2']], 'files added where it was: read again');
  assert.deepEqual(out.new.map(n => n.title.path + (n.title.inner || '')), ['After.zipCh 3/', 'Fresh']);
  assert.deepEqual(out.missing.map(m => m.gid), ['4']);
});

test('a check skips what was removed — unless its files changed — and an overlay\'s gallery the library has elsewhere (R19)', () => {
  const removed = [{ kind: 'dir', path: 'Old', fingerprint: 'O1' }];
  const over = { galleryId: '1700000000009', source: { kind: 'dir', path: 'Copied', fingerprint: 'C' } };
  const out = matchSources({ removed, overlays: [over], known: new Set(['1700000000009']), found: [
    { kind: 'dir', path: 'Old', fingerprint: 'O1' }, { kind: 'dir', path: 'Old2', fingerprint: 'x' }, { kind: 'dir', path: 'Copied', fingerprint: 'C' }] });
  assert.deepEqual(out.skipped.map(s => [s.title.path, s.reason]).sort(), [['Copied', 'copy'], ['Old', 'removed']]);
  const changed = matchSources({ removed, found: [{ kind: 'dir', path: 'Old', fingerprint: 'O2' }] });
  assert.deepEqual(changed.new.map(n => n.title.path), ['Old'], 'other files where a removed one was: new');
  const restored = matchSources({ overlays: [{ galleryId: '1700000000001', source: { kind: 'dir', path: 'Back', fingerprint: 'B' } }],
    found: [{ kind: 'dir', path: 'Back', fingerprint: 'B' }] });
  assert.deepEqual(restored.new, [{ title: { kind: 'dir', path: 'Back', fingerprint: 'B' }, gid: '1700000000001' }], 'its overlay keeps its identity');
});

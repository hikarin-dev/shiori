// linked-source.test.mjs — what a library folder holds that Shiori didn't make, as galleries: every
// folder holding pictures one, every archive one (a series when its pictures sit in folders), every
// PDF one; Shiori's own folders left out; names read the way such names are written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTitles, zipTitles, metaFromName, sourceText, parseSource, sourceKey, isRemoved, safeRelPath, withRemoved, linkedPages,
  keepsDerived, pdfReady, drawFailed, pdfWaits, matchSources, parseRemoved, removedText, provenanceOf, sameSource, sameProvenance, crcHex,
  folderPrint, folderContent, drawnFrom, pdfPrint, isDrawing, pageToken, madeFromPage } from '../js/storage/linked-source.js';

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
  assert.equal(linkedPages(source, [{ name: '0001-ab12cd34.png', size: 7 }, { name: '0001.png', size: 8 }])[0].name, '0001.png',
    'two files for one page: the one under the layout name');
});

test('F05: of two overlay files for one page, the one its description names wins — an unnamed one never does', () => {
  const source = [{ name: 'a.png', size: 1 }];
  const overlay = [{ name: '0001.png', size: 8 }, { name: '0001-ab12cd34.png', size: 7 }, { name: '0001-0badc0de.png', size: 6 }];
  assert.equal(linkedPages(source, overlay, new Set(['images/0001-ab12cd34.png']))[0].name, '0001-ab12cd34.png', 'the saved replacement');
  assert.equal(linkedPages(source, overlay, new Set())[0].name, '0001.png', 'nothing named: the layout name, never a leftover');
});

test('F07: what was made from a linked page stays only while the page shows the source picture it was made from', () => {
  const page = (name, size, from = 'source') => ({ n: 1, from, name, size });
  assert.equal(keepsDerived(page('001.png', 10), { name: '001.png', size: 10 }), true);
  assert.equal(keepsDerived(page('000.png', 10), { name: '001.png', size: 10 }), false, 'another picture inserted before it');
  assert.equal(keepsDerived(page('001.png', 11), { name: '001.png', size: 10 }), false, 'its bytes replaced');
  assert.equal(keepsDerived(page('001.png', 10), null), false, 'nothing recorded: not known to be the same');
  assert.equal(keepsDerived(page('0001.png', 4, 'overlay'), null), true, 'a page of the overlay\'s own');
});

test('T07: a linked page keeps what was made from it only while its picture\'s content signal is the one recorded — a ZIP entry\'s CRC-32, a folder file\'s time', () => {
  const [zipPage] = linkedPages([{ name: '001.png', size: 10, crc: 'aaaa0001' }]);
  assert.equal(zipPage.crc, 'aaaa0001', 'a page carries its picture\'s signal');
  assert.equal(keepsDerived(zipPage, provenanceOf({ name: '001.png', size: 10, crc: 'aaaa0001' })), true);
  assert.equal(keepsDerived(zipPage, { name: '001.png', size: 10, crc: 'bbbb0002' }), false, 'the same name and size, other bytes');
  const [dirPage] = linkedPages([{ name: '001.png', size: 10, mtime: 1700000000123.4 }]);
  assert.equal(dirPage.mtime, 1700000000123, 'whole milliseconds, as both apps read them');
  assert.equal(keepsDerived(dirPage, { name: '001.png', size: 10, mtime: 1700000000123 }), true);
  assert.equal(keepsDerived(dirPage, { name: '001.png', size: 10, mtime: 1700000999000 }), false, 'replaced in place by a file of the same size');
  // Recorded before content signals were: kept only while the source is as the library was told of it.
  assert.equal(keepsDerived(zipPage, { name: '001.png', size: 10 }, true), true, 'the source unchanged');
  assert.equal(keepsDerived(zipPage, { name: '001.png', size: 10 }, false), false, 'the source changed: not known to be the same picture');
  assert.equal(sameSource({ kind: 'zip', path: 'A.zip', fingerprint: 'f1' }, { kind: 'zip', path: 'A.zip', fingerprint: 'f1' }), true);
  assert.equal(sameSource({ kind: 'zip', path: 'A.zip', fingerprint: 'f1' }, { kind: 'zip', path: 'A.zip', fingerprint: 'f2' }), false);
  assert.equal(sameSource({ kind: 'dir', path: 'D', fingerprint: 'f1', content: 'c1' }, { kind: 'dir', path: 'D', fingerprint: 'f1', content: 'c2' }), false, 'a folder\'s content');
  assert.equal(sameSource(null, { kind: 'dir', path: 'D', fingerprint: 'f1' }), false, 'nothing recorded');
  assert.equal(sameProvenance({ name: '001.png', size: 10 }, zipPage), false, 'recorded without its signal: recorded anew');
  assert.equal(sameProvenance({ name: '001.png', size: 10, crc: 'aaaa0001' }, zipPage), true);
  assert.equal(crcHex(0xdeadbeef), 'deadbeef');
  assert.equal(crcHex(5), '00000005');
});

test('T07: a folder of pictures with a picture replaced in place by one of the same size is changed — its fingerprint, what a removal keeps, the same', () => {
  const before = [{ name: '001.png', size: 4, mtime: 1 }, { name: '002.png', size: 5, mtime: 2 }];
  const after = [{ name: '001.png', size: 4, mtime: 9 }, { name: '002.png', size: 5, mtime: 2 }];
  assert.equal(folderPrint(before), folderPrint(after));
  assert.notEqual(folderContent(before), folderContent(after));
  const kept = [{ gid: '1', source: { kind: 'dir', path: 'D', fingerprint: 'F', content: 'c1' } }];
  const found = (content) => [{ kind: 'dir', path: 'D', fingerprint: 'F', content }];
  assert.deepEqual(matchSources({ found: found('c2'), kept }).changed.map(c => c.gid), ['1']);
  assert.deepEqual(matchSources({ found: found('c1'), kept }).same.map(c => c.gid), ['1']);
  assert.deepEqual(matchSources({ found: found('c2'), kept: [{ gid: '1', source: { kind: 'dir', path: 'D', fingerprint: 'F' } }] }).same.map(c => c.gid), ['1'],
    'kept before its content was recorded: the same (it is recorded then)');
});

test('T10, T11: a PDF\'s drawing is kept only for the version it read, and only when it is pages with bytes', () => {
  assert.equal(drawnFrom('5:abc', '5:abc'), true);
  assert.equal(drawnFrom('5:abc', '6:def'), false, 'the file changed since');
  assert.equal(drawnFrom('5:abc', null), false, 'the file can\'t be read now');
  assert.equal(drawnFrom(undefined, '5:abc'), false, 'a drawing naming no version');
  assert.equal(pdfPrint(5, 'abc'), '5:abc');
  assert.equal(isDrawing([new Blob([new Uint8Array([1])])]), true);
  assert.equal(isDrawing([]), false, 'no pages');
  assert.equal(isDrawing([new Blob([new Uint8Array([1])]), new Blob([])]), false, 'a page with no bytes');
  assert.equal(isDrawing([new Blob([new Uint8Array([1])]), 'not a picture']), false);
  assert.equal(isDrawing(null), false);
});

const drawn = (n) => Array.from({ length: n }, (_, i) => ({ name: `${String(i + 1).padStart(4, '0')}.png` }));
test('a PDF joins only once all its pages are drawn, and one that failed waits for its file to change (R11, A23)', () => {
  const pdf = (pages) => ({ kind: 'pdf', path: 'B.pdf', ...(pages ? { rendered: { pages, fingerprint: null } } : {}) });
  assert.equal(pdfReady(pdf(null), drawn(3)), false, 'pages drawn so far, no marker: still drawing, or stopped half way');
  assert.equal(pdfReady(pdf(3), drawn(2)), false);
  assert.equal(pdfReady(pdf(3), drawn(3)), true);
  assert.equal(pdfReady({ kind: 'zip', path: 'x.zip', rendered: { pages: 1 } }, drawn(1)), false);
  const failed = { kind: 'pdf', path: 'B.pdf', failed: { fingerprint: 'f1', at: 1 } };
  assert.equal(drawFailed(failed, 'f1'), true);
  assert.equal(drawFailed(failed, 'f2'), false, 'the file changed: tried again');
  const text = sourceText('1700000000000', { kind: 'pdf', path: 'B.pdf', rendered: { pages: 3, fingerprint: 'f0' }, failed: { fingerprint: 'f1', at: 5 } });
  assert.deepEqual(parseSource(text).source, { kind: 'pdf', path: 'B.pdf', size: null, fingerprint: null, rendered: { pages: 3, fingerprint: 'f0' }, failed: { fingerprint: 'f1', at: 5 } });
});

test('F10: a drawn PDF is drawn again once its file changed — unless drawing that version failed — and the marker\'s first form still reads', () => {
  const pdf = (fingerprint, rendered, failed) => ({ kind: 'pdf', path: 'B.pdf', fingerprint, rendered, ...(failed ? { failed: { fingerprint: failed, at: 1 } } : {}) });
  assert.equal(pdfWaits(pdf('v1', null), drawn(0)), true, 'not drawn yet');
  assert.equal(pdfWaits(pdf('v1', { pages: 2, fingerprint: 'v1' }), drawn(2)), false, 'drawn from the file as it is');
  assert.equal(pdfWaits(pdf('v2', { pages: 2, fingerprint: 'v1' }), drawn(2)), true, 'drawn from an earlier version');
  assert.equal(pdfWaits(pdf('v1', { pages: 2, fingerprint: 'v1' }), drawn(2), 'v3'), true, 'the file as read just now');
  assert.equal(pdfWaits(pdf('v2', { pages: 2, fingerprint: 'v1' }, 'v2'), drawn(2)), false, 'drawing this version failed');
  assert.equal(pdfWaits({ kind: 'dir', path: 'D', fingerprint: 'v2', rendered: { pages: 1, fingerprint: 'v1' } }, drawn(1)), false);
  const old = JSON.stringify({ format: 'shiori-linked', version: 1, galleryId: '1700000000000', source: { kind: 'pdf', path: 'B.pdf', fingerprint: 'v2', rendered: 2 } });
  const read = parseSource(old).source;
  assert.deepEqual(read.rendered, { pages: 2, fingerprint: null }, 'a bare count');
  assert.equal(pdfWaits(read, drawn(2)), false, 'not known to be of another version: kept');
});

test('D5 (R18, R19 rewritten): a check takes each source where it is — the same there, changed there, or new; one renamed or moved is new, its gallery missing', () => {
  const zip = (path, inner, fingerprint = 'Z') => ({ kind: 'zip', path, ...(inner ? { inner } : {}), fingerprint });
  const kept = [{ gid: '1', source: zip('Before.zip', 'Ch 1/') }, { gid: '2', source: zip('Before.zip', 'Ch 2/') },
    { gid: '3', source: { kind: 'dir', path: 'Loose', fingerprint: 'D1' } }, { gid: '4', source: { kind: 'dir', path: 'Gone', fingerprint: 'G' } }];
  const out = matchSources({ kept, found: [zip('After.zip', 'Ch 1/'), zip('After.zip', 'Ch 2/'), zip('After.zip', 'Ch 3/'),
    { kind: 'dir', path: 'Loose', fingerprint: 'D2' }, { kind: 'dir', path: 'Fresh', fingerprint: 'F' }, { kind: 'dir', path: 'Gone renamed', fingerprint: 'G' }] });
  assert.equal(out.moved, undefined, 'no source is followed to another path');
  assert.deepEqual(out.changed.map(c => [c.gid, c.was.fingerprint, c.title.fingerprint]), [['3', 'D1', 'D2']], 'files added where it was: read again');
  assert.deepEqual(out.new.map(n => [n.title.path + (n.title.inner || ''), n.gid]),
    [['After.zipCh 1/', undefined], ['After.zipCh 2/', undefined], ['After.zipCh 3/', undefined], ['Fresh', undefined], ['Gone renamed', undefined]],
    'a renamed archive\'s chapters, and a renamed folder of the same fingerprint, join as new');
  assert.deepEqual(out.missing.map(m => m.gid), ['1', '2', '4'], 'the galleries that were there are missing');
  // An overlay is its gallery's only where its source is: one whose source was moved is left as it is.
  const overlays = [{ galleryId: '1700000000003', source: { kind: 'dir', path: 'Was', fingerprint: 'W' } }];
  const away = matchSources({ overlays, found: [{ kind: 'dir', path: 'Is', fingerprint: 'W' }] });
  assert.deepEqual(away.new, [{ title: { kind: 'dir', path: 'Is', fingerprint: 'W' } }]);
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

test('F12: a removed source whose overlay is still there (its removal couldn\'t delete it yet) stays removed', () => {
  const overlays = [{ galleryId: '1700000000002', source: { kind: 'dir', path: 'Gone', fingerprint: 'G' } }];
  const found = [{ kind: 'dir', path: 'Gone', fingerprint: 'G' }];
  const out = matchSources({ overlays, found, removed: [{ kind: 'dir', path: 'Gone' }] });   // a note still owed: no fingerprint
  assert.deepEqual([out.new, out.skipped.map(s => [s.title.path, s.reason])], [[], [['Gone', 'removed']]]);
});

test('O1: a page\'s token — a linked page\'s source picture, a page of the library\'s own its picture as stored — changes when the picture does', () => {
  const linked = pageToken({ name: '001.png', size: 4, crc: 'abcd1234' });
  assert.equal(linked, pageToken({ name: '001.png', size: 4, crc: 'abcd1234' }, { size: 9, cachedAt: 1 }), 'a linked page\'s is its source picture\'s');
  assert.notEqual(linked, pageToken({ name: '001.png', size: 4, crc: 'abcd9999' }));
  const own = pageToken(null, { size: 10, cachedAt: 1000.6 });
  assert.equal(own, pageToken(null, { size: 10, cachedAt: 1000 }), 'kept while the picture is (to the millisecond)');
  assert.notEqual(own, pageToken(null, { size: 10, cachedAt: 2000 }), 'stored again: another');
  assert.ok(madeFromPage(own, own) && !madeFromPage(own, pageToken(null, { size: 11, cachedAt: 1000 })));
});

// cbz-export.test.mjs — a CBZ export is the ZIP export's files plus ComicInfo.xml: Shiori imports it
// the same way, translations included; it can leave the translations out (the original pages and
// details still come back, nothing made from them does); and its ComicInfo.xml carries what other
// comic readers show.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

const api = await import('../js/api.js');
const { galleryFiles, fileBytes, comicInfoXml, exportFiles } = await import('../js/gallery-files.js');
const { importCbzBuffer } = await import('../js/import-cbz.js');
const { zipCreate } = await import('../js/zip.js');

const bytes = (...values) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...values]);
const png = (...values) => new Blob([bytes(...values)], { type: 'image/png' });
const blobBytes = async (blob) => (blob ? [...new Uint8Array(await blob.arrayBuffer())] : null);
const title = (english) => ({ english, japanese: '', pretty: english });

// The CBZ the library's export writes for one gallery (library.js exportGallery → exportFiles).
async function cbz(gid, { translations = true } = {}) {
  const { files } = await exportFiles(gid, { read: api.transfer.read, metaGet: api.meta.get, translations, comicInfo: true });
  const z = zipCreate(files);
  const info = new TextDecoder().decode(files.find(f => f.name === 'ComicInfo.xml').data);
  return { buffer: z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength), names: files.map(f => f.name), info };
}

async function translatedGallery(gid) {
  await api.meta.put({ galleryId: gid, title: title('Book'), tags: [{ type: 'artist', name: 'someone' }], numPages: 2 });
  for (const n of [1, 2]) await api.pages.put(gid, n, png(n), { key: `local://${gid}/${n}.png` });
  await api.derived.putTranslation(gid, 1, { image: png(9, 9), pipeline: null });
  await api.derived.putStudy(gid, 1, { bg: png(7), page: { w: 10, h: 10 },
    bubbles: [{ box: [0, 0, 5, 5], region: [0, 0, 5, 5], tr: 'Hi', src: 'あ', text: png(8) }] });
}

// Exported, deleted from the library, and imported back.
async function roundTrip(gid, opts) {
  const out = await cbz(gid, opts);
  await api.galleries.delete(gid);
  assert.equal(await api.pages.get(gid, 1), null);
  await importCbzBuffer(gid, out.buffer, `shiori-${gid}.cbz`, true);
  return out;
}

test('a CBZ export imports into Shiori like a ZIP, translations and all', async () => {
  await translatedGallery('701');
  const { names, info } = await roundTrip('701');
  for (const name of ['ComicInfo.xml', 'metadata.json', 'image_records.json', 'images/0001.png', 'images/0002.png', 'translated/0001.png', 'study/bg/0001.png']) {
    assert.ok(names.includes(name), `holds ${name}`);
  }
  assert.match(info, /<PageCount>2<\/PageCount>/);
  const rec = await api.pages.get('701', 1);
  assert.deepEqual(await blobBytes(rec.blob), [...bytes(1)]);
  assert.deepEqual(await blobBytes(rec.translated), [...bytes(9, 9)], 'its translation comes back');
  assert.equal(rec.bubbles.length, 1);
  assert.deepEqual(await blobBytes(rec.studyBg), [...bytes(7)], 'and its study layers');
  assert.deepEqual(await blobBytes((await api.pages.get('701', 2)).blob), [...bytes(2)]);
  assert.equal((await api.meta.get('701')).title.english, 'Book');
});

test('a CBZ without translations holds the original pages only, and imports as such', async () => {
  await translatedGallery('711');
  const { names } = await cbz('711', { translations: false });
  assert.ok((await api.pages.get('711', 1)).translated, 'exporting without them leaves the library’s translation alone');
  assert.deepEqual(names.filter(n => /^(translated|study|pipeline)\//.test(n)), [], 'nothing made from the pages');
  assert.ok(names.includes('images/0001.png') && names.includes('ComicInfo.xml'));

  await roundTrip('711', { translations: false });
  const rec = await api.pages.get('711', 1);
  assert.deepEqual(await blobBytes(rec.blob), [...bytes(1)]);
  assert.equal(rec.translated, undefined);
  assert.equal(rec.bubbles, undefined);
  assert.equal((await api.meta.get('711')).title.english, 'Book');
});

test('a CBZ whose translation folders were deleted by hand imports its originals, claiming no translation', async () => {
  await translatedGallery('721');
  await api.derived.putTranslation('721', 2, { image: null, pipeline: null });   // page 2 translated as its study layers
  await api.derived.putStudy('721', 2, { bg: png(6), page: { w: 10, h: 10 }, bubbles: [{ box: [0, 0, 5, 5], region: [0, 0, 5, 5], tr: 'Yo', src: 'よ', text: png(5) }] });
  assert.equal((await api.pages.get('721', 2)).translatedLayers, true);
  const { meta, pages, cover } = await api.transfer.read('721');
  const listed = galleryFiles({ meta, records: pages, covers: { gallery: cover?.cover } })
    .filter(f => !/^(translated|study|pipeline)\//.test(f.name));   // the folders deleted from the CBZ
  const files = [];
  for (const f of listed) files.push({ name: f.name, data: await fileBytes(f.source) });
  files.push({ name: 'ComicInfo.xml', data: new TextEncoder().encode(comicInfoXml(meta, { pageCount: 2 })) });
  const z = zipCreate(files);
  await api.galleries.delete('721');
  await importCbzBuffer('721', z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength), 'shiori-721.cbz', true);
  for (const n of [1, 2]) {
    const rec = await api.pages.get('721', n);
    assert.deepEqual(await blobBytes(rec.blob), [...bytes(n)], `page ${n}'s original`);
    assert.equal(rec.translated, undefined);
    assert.equal(rec.bubbles, undefined);
    assert.ok(!rec.translatedLayers, `page ${n} doesn't claim the translation whose layers were deleted`);
  }
});

test('ComicInfo.xml names the gallery, its series and its number', () => {
  const owner = { galleryId: '900', seriesTitle: title('The Series'), title: title('One'),
    chapters: [{ id: '900', title: 'One', number: 1 }, { id: '901', title: 'Two & More', number: 2.5 }, { id: '902', title: 'Vol', number: 3, kind: 'volume' }] };
  const member = { galleryId: '901', title: title('Two'), parentId: '900', sourceUrl: 'https://example.com/g/901',
    tags: [{ type: 'artist', name: 'someone' }, { type: 'rating', name: 'safe' }, { type: 'language', name: 'japanese' }, { type: 'tag', name: 'a' }, { type: 'tag', name: 'b' }] };
  const xml = comicInfoXml(member, { owner, pageCount: 12 });
  for (const field of ['<Title>Two &amp; More</Title>', '<Series>The Series</Series>', '<Number>2.5</Number>', '<Writer>someone</Writer>',
    '<Tags>a, b</Tags>', '<Web>https://example.com/g/901</Web>', '<LanguageISO>ja</LanguageISO>', '<PageCount>12</PageCount>', '<AgeRating>Everyone</AgeRating>']) {
    assert.ok(xml.includes(field), `has ${field}`);
  }
  assert.match(comicInfoXml({ galleryId: '902', title: title('Vol') }, { owner, pageCount: 1 }), /<Volume>3<\/Volume>/);
  const whole = comicInfoXml(owner, { series: true, pageCount: 30 });
  assert.match(whole, /<Title>The Series<\/Title>/);
  assert.match(whole, /<Count>3<\/Count>/);
  assert.doesNotMatch(whole, /<Number>/);
  assert.match(comicInfoXml({ galleryId: '1', title: title('Alone') }, { pageCount: 3 }), /<Title>Alone<\/Title>\n {2}<Series>Alone<\/Series>/);
});

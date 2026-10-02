// gallery-export.test.mjs — a per-gallery export carries each page's pipeline data (inline in
// image_records.json, masks as pipeline/NNNN-{raw,text}.webp) and the gallery's translations, so an
// imported gallery can be re-translated from where it left off.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

const api = await import('../js/api.js');
const { BUBBLE_EXTRA_FIELDS } = await import('../js/gallery-files.js');
const { importCbzBuffer } = await import('../js/import-cbz.js');
const { zipCreate } = await import('../js/zip.js');
const { planPage } = await import('../js/page-data.js');

const enc = new TextEncoder();
const zip = (files) => { const z = zipCreate(files); return z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength); };
const bytes = (...values) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...values]);
const RECORD = { lines: [{ pts: [[0, 0], [9, 0], [9, 9], [0, 9]], score: 0.9, text: 'あ', prob: 0.99, fg: [0, 0, 0], bg: [255, 255, 255], dir: 'v' }],
  read: [0], regions: [{ lines: [0], size: 20, prob: 0.99, fg: [0, 0, 0], bg: [255, 255, 255], lang: 'ja', src: 'v', tr: 'Hi' }] };
const TRANSLATION = { at: 1, config: { render: { renderer: 'manga2eng' } }, builds: { render: 'r1' } };

// The archive the gallery export writes (same layout and field choices as library.js).
async function exportArchive(gid, targetGid) {
  const meta = await api.meta.get(gid);
  const records = await api.pages.all(gid);
  const files = [{ name: 'metadata.json', data: enc.encode(JSON.stringify({ ...meta, galleryId: targetGid })) }];
  files.push({ name: 'image_records.json', data: enc.encode(JSON.stringify(records.map((r) => {
    const entry = { url: r.url, translated: r.translated !== undefined };
    if (r.pipeline) { const { masks, ...data } = r.pipeline; entry.pipeline = data; }
    if (r.own) entry.own = r.own;
    return entry;
  }))) });
  const study = {};
  for (const r of records) {
    const num = r.url.match(/\/(\d+)\.\w+$/)[1].padStart(4, '0');
    files.push({ name: `images/${num}.png`, data: new Uint8Array(await r.blob.arrayBuffer()) });
    if (r.translated) files.push({ name: `translated/${num}.png`, data: new Uint8Array(await r.translated.arrayBuffer()) });
    for (const name of ['raw', 'text']) {
      const mask = r.pipeline?.masks?.[name];
      if (mask) files.push({ name: `pipeline/${num}-${name}.${mask.type.split('/')[1]}`, data: new Uint8Array(await mask.arrayBuffer()) });
    }
    if (r.bubbles?.length) {
      study[num] = { page: r.studyPage, bubbles: r.bubbles.map((b) => {
        const entry = { box: b.box, region: b.region, tr: b.tr, src: b.src, textFile: null };
        for (const key of BUBBLE_EXTRA_FIELDS) if (b[key] != null) entry[key] = b[key];
        return entry;
      }) };
    }
  }
  files.push({ name: 'study/bubbles.json', data: enc.encode(JSON.stringify(study)) });
  return zip(files);
}

async function translatedGallery(gid) {
  const url = `local://${gid}/1.png`;
  await api.meta.put({ galleryId: gid, title: { english: 'G', japanese: '', pretty: 'G' }, tags: [], numPages: 1,
    translated: true, translatedLang: 'en', translations: { j1: TRANSLATION } });
  await api.pages.put(gid, 1, new Blob([bytes(1, 2, 3)], { type: 'image/png' }), { key: url });
  await api.derived.putTranslation(gid, 1, { image: new Blob([bytes(9, 9, 9)], { type: 'image/png' }), pipeline: { job: 'j1', ...RECORD,
    masks: { raw: new Blob([bytes(5)], { type: 'image/webp' }), text: new Blob([bytes(6)], { type: 'image/png' }) } }, own: 'j1' });
  await api.derived.putStudy(gid, 1, { bg: null, page: { w: 10, h: 10 },
    bubbles: [{ box: [0, 0, 5, 5], region: [0, 0, 5, 5], tr: 'Hi', src: 'あ', text: null, id: 0, lineIds: [0], rawTr: 'Hi!',
      shape: [[0.1, 0.1], [0.5, 0.1], [0.3, 0.5]] }] }, 'j1');
  return url;
}

const resolved = { config: TRANSLATION.config, builds: TRANSLATION.builds, fields: { render: ['render.renderer'] } };

test('an exported page comes back with its pipeline data, ready to be re-translated from there', async () => {
  const url = await translatedGallery('101');
  await importCbzBuffer('202', await exportArchive('101', '202'), 'shiori-101.zip', true);
  const rec = await api.pages.get('202', 1);
  const source = await api.pages.get('101', 1);
  const strip = ({ masks, ...rest }) => rest;
  assert.deepEqual(strip(rec.pipeline), strip(source.pipeline));
  assert.deepEqual(new Uint8Array(await rec.pipeline.masks.text.arrayBuffer()), bytes(6));
  assert.deepEqual([rec.pipeline.masks.raw.type, rec.pipeline.masks.text.type], ['image/webp', 'image/png'],
    'WebP masks, and PNG ones (a very long page, or data saved before WebP), both come back');
  assert.deepEqual(rec.bubbles.map(b => [b.id, b.lineIds, b.rawTr, b.shape]), [[0, [0], 'Hi!', [[0.1, 0.1], [0.5, 0.1], [0.3, 0.5]]]]);
  assert.equal(rec.own, 'j1', 'a page keeping its own settings still does');
  assert.deepEqual((await api.meta.get('202')).translations, { j1: TRANSLATION });
  assert.equal(planPage(rec, { j1: TRANSLATION }, resolved, new Map()), null, 'unchanged settings: nothing to redo');
  const renderer = { ...resolved, config: { render: { renderer: 'shiori_v2' } } };
  assert.equal(planPage(rec, { j1: TRANSLATION }, renderer, new Map()).from, 'render');
});

test('a reverted page keeps its data through the round trip', async () => {
  await translatedGallery('303');
  await api.derived.clear('303', { keepSnapshots: true });
  await importCbzBuffer('404', await exportArchive('303', '404'), 'shiori-303.zip', true);
  const rec = await api.pages.get('404', 1);
  assert.equal(rec.translated, undefined);
  assert.deepEqual(rec.pipeline.regions, RECORD.regions);
  assert.equal(planPage(rec, { j1: TRANSLATION }, resolved, new Map()).from, 'render', 'only rendering is redone');
});

test('malformed pipeline data is not restored', async () => {
  await translatedGallery('505');
  const archive = await exportArchive('505', '606');
  const { unzip } = await import('../js/import-cbz.js');
  const files = (await unzip(archive)).map(({ filename, data }) => {
    if (filename !== 'image_records.json') return { name: filename, data };
    const records = JSON.parse(new TextDecoder().decode(data));
    records[0].pipeline = { lines: 'not a list', job: 7 };
    return { name: filename, data: enc.encode(JSON.stringify(records)) };
  });
  await importCbzBuffer('606', zip(files), 'x.zip', true);
  const rec = await api.pages.get('606', 1);
  assert.equal(rec.pipeline, undefined);
  assert.ok(rec.translated, 'the rest of the page still imports');
});

// ── What the real exporter (gallery-files.js) writes, restored into a library that lost it ──

const { galleryFiles, fileBytes, seriesManifest } = await import('../js/gallery-files.js');
const { mergeIntoSeries, setChapterTitle } = await import('../js/series.js');

const TAGS = [{ type: 'category', name: 'manga', url: '' }, { type: 'rating', name: 'safe', url: '' },
  { type: 'artist', name: 'someone', url: '' }];
const TITLE = { english: 'Kept', japanese: '残す', pretty: 'Kept' };
const img = (type, ...values) => new Blob([new Uint8Array(values)], { type });

async function galleryArchiveFiles(gid, prefix = '', opts = {}) {
  const [meta, records, covers] = await Promise.all([api.meta.get(gid), api.pages.all(gid), api.transfer.read(gid).then(t => t.cover)]);
  const files = galleryFiles({ meta, records, covers: { gallery: covers?.cover, series: covers?.seriesCover } }, prefix, opts);
  return Promise.all(files.map(async (f) => ({ name: f.name, data: await fileBytes(f.source) })));
}

async function pagesOf(gid) {
  const recs = (await api.pages.all(gid)).sort((a, b) => a.url.localeCompare(b.url));
  return Promise.all(recs.map(async (r) => [r.url, r.blob.type, [...new Uint8Array(await r.blob.arrayBuffer())]]));
}

// Set on every restore, so not compared: when the record was written (nothing reads it back) and
// the page formats, which come from the restored pages themselves.
const restored = ({ fetchedAt, pageExts, ...m }) => m;

async function seedGallery(gid, { favorite = true } = {}) {
  await api.meta.put({ galleryId: gid, title: TITLE, tags: TAGS, numPages: 2 });
  await api.pages.put(gid, null, img('image/avif', 1, 1), { key: `local://${gid}/1.avif` });
  await api.pages.put(gid, null, img('image/webp', 2, 2), { key: `local://${gid}/2.webp` });
  await api.galleries.mutate(gid, { favorite }, { touch: false });
}

test('a gallery export restores its favorite, category, rating, title and AVIF/WebP pages', async () => {
  await seedGallery('701');
  const pages = await pagesOf('701');
  const archive = zip(await galleryArchiveFiles('701'));
  await api.galleries.delete('701');
  await importCbzBuffer('701', archive, 'shiori-701.zip', true);
  const meta = await api.meta.get('701');
  assert.equal(meta.favorite, true);
  assert.deepEqual(meta.tags, TAGS);
  assert.deepEqual(meta.title, TITLE);
  assert.deepEqual(await pagesOf('701'), pages, 'every page comes back in its own format, bytes untouched');
  assert.equal((await api.transfer.read('701')).cover.cover.type, 'image/avif', 'page 1 (AVIF) is the cover again');
});

test('a series export restores the series favorite, title, category, rating and chapter titles and numbers', async () => {
  for (const gid of ['801', '802', '803']) await seedGallery(gid, { favorite: false });
  await mergeIntoSeries('801', '802');
  await mergeIntoSeries('801', '803');
  await setChapterTitle('801', '803', 'Extra');
  const seriesTags = [{ type: 'category', name: 'doujinshi', url: '' }, { type: 'rating', name: 'suggestive', url: '' }];
  // Chapters 1 and 2, and a volume.
  const numbered = (await api.meta.get('801')).chapters.map((c, i) => ({ ...c, number: [1, 2, 1][i], ...(i === 2 ? { kind: 'volume' } : {}) }));
  await api.galleries.mutate('801', { favorite: true, seriesTags, seriesTitle: { english: 'Series', japanese: '', pretty: 'Series' }, chapters: numbered });
  // A field no exporter or importer knows about still makes the trip.
  await api.meta.put({ ...await api.meta.get('802'), futureField: { kept: [1, 'two'] } });
  const before = await api.meta.get('801');
  const chapterBefore = await api.meta.get('802');

  // The bundle library.js writes: chapter-NN/ per chapter (series fields stripped) + series.json.
  const manifest = seriesManifest(before);
  const files = [];
  for (const { id, folder } of manifest.chapters) files.push(...await galleryArchiveFiles(id, `${folder}/`, { stripSeriesFields: true }));
  files.push({ name: 'series.json', data: enc.encode(JSON.stringify(manifest)) });
  for (const gid of ['801', '802', '803']) await api.galleries.delete(gid);

  await importCbzBuffer('801', zip(files), 'shiori-series-801.zip', true);
  const owner = await api.meta.get('801');
  assert.equal(owner.favorite, true);
  assert.deepEqual(owner.seriesTags, seriesTags);
  assert.deepEqual(owner.seriesTitle, before.seriesTitle);
  assert.deepEqual(owner.chapters, before.chapters, 'member order, titles, numbers and kinds');
  assert.equal(owner.chapters[2].kind, 'volume');
  for (const gid of ['802', '803']) {
    const chapter = await api.meta.get(gid);
    assert.equal(chapter.parentId, '801');
    assert.deepEqual(chapter.tags, TAGS, "a chapter's own tags come back too");
  }
  assert.deepEqual(restored(await api.meta.get('802')), restored(chapterBefore), "every field of a chapter's metadata comes back");
  assert.equal((await pagesOf('803')).length, 2);
});

test('a gallery export brings back every metadata field, including ones the app does not know', async () => {
  await seedGallery('711');
  await api.meta.put({ ...await api.meta.get('711'), futureField: { kept: [1, 'two'] }, sourceMetadata: { kind: 'chapter', chapter: { number: '10.5' } } });
  const before = await api.meta.get('711');
  const archive = zip(await galleryArchiveFiles('711'));
  await api.galleries.delete('711');
  await importCbzBuffer('711', archive, 'shiori-711.zip', true);
  assert.deepEqual(restored(await api.meta.get('711')), restored(before));
});

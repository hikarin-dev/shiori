// gallery-export.test.mjs — a per-gallery export carries each page's pipeline data (inline in
// image_records.json, masks as pipeline/NNNN-{raw,text}.webp) and the gallery's translations, so an
// imported gallery can be re-translated from where it left off.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

const db = await import('../js/db.js');
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
  const meta = await db.metaGet(gid);
  const records = await db.getGalleryImageRecords(gid);
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
        for (const key of db.BUBBLE_EXTRA_FIELDS) if (b[key] != null) entry[key] = b[key];
        return entry;
      }) };
    }
  }
  files.push({ name: 'study/bubbles.json', data: enc.encode(JSON.stringify(study)) });
  return zip(files);
}

async function translatedGallery(gid) {
  const url = `local://${gid}/1.png`;
  await db.metaPut({ galleryId: gid, title: { english: 'G', japanese: '', pretty: 'G' }, tags: [], numPages: 1,
    translated: true, translatedLang: 'en', translations: { j1: TRANSLATION } });
  await db.dbPut(url, new Blob([bytes(1, 2, 3)], { type: 'image/png' }), gid, gid);
  await db.putTranslatedPage(url, new Blob([bytes(9, 9, 9)], { type: 'image/png' }), { job: 'j1', ...RECORD,
    masks: { raw: new Blob([bytes(5)], { type: 'image/webp' }), text: new Blob([bytes(6)], { type: 'image/png' }) } }, 'j1');
  await db.putPageStudy(url, { bg: null, page: { w: 10, h: 10 },
    bubbles: [{ box: [0, 0, 5, 5], region: [0, 0, 5, 5], tr: 'Hi', src: 'あ', text: null, id: 0, lineIds: [0], rawTr: 'Hi!',
      shape: [[0.1, 0.1], [0.5, 0.1], [0.3, 0.5]] }] }, 'j1');
  return url;
}

const resolved = { config: TRANSLATION.config, builds: TRANSLATION.builds, fields: { render: ['render.renderer'] } };

test('an exported page comes back with its pipeline data, ready to be re-translated from there', async () => {
  const url = await translatedGallery('101');
  await importCbzBuffer('202', await exportArchive('101', '202'), 'shiori-101.zip', true);
  const rec = await db.dbGet('local://202/1.png');
  const source = await db.dbGet(url);
  const strip = ({ masks, ...rest }) => rest;
  assert.deepEqual(strip(rec.pipeline), strip(source.pipeline));
  assert.deepEqual(new Uint8Array(await rec.pipeline.masks.text.arrayBuffer()), bytes(6));
  assert.deepEqual([rec.pipeline.masks.raw.type, rec.pipeline.masks.text.type], ['image/webp', 'image/png'],
    'WebP masks, and PNG ones (a very long page, or data saved before WebP), both come back');
  assert.deepEqual(rec.bubbles.map(b => [b.id, b.lineIds, b.rawTr, b.shape]), [[0, [0], 'Hi!', [[0.1, 0.1], [0.5, 0.1], [0.3, 0.5]]]]);
  assert.equal(rec.own, 'j1', 'a page keeping its own settings still does');
  assert.deepEqual((await db.metaGet('202')).translations, { j1: TRANSLATION });
  assert.equal(planPage(rec, { j1: TRANSLATION }, resolved, new Map()), null, 'unchanged settings: nothing to redo');
  const renderer = { ...resolved, config: { render: { renderer: 'shiori_v2' } } };
  assert.equal(planPage(rec, { j1: TRANSLATION }, renderer, new Map()).from, 'render');
});

test('a reverted page keeps its data through the round trip', async () => {
  await translatedGallery('303');
  await db.clearGalleryTranslations('303', { keepSnapshots: true });
  await importCbzBuffer('404', await exportArchive('303', '404'), 'shiori-303.zip', true);
  const rec = await db.dbGet('local://404/1.png');
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
  const rec = await db.dbGet('local://606/1.png');
  assert.equal(rec.pipeline, undefined);
  assert.ok(rec.translated, 'the rest of the page still imports');
});

// ── What the real exporter (gallery-files.js) writes, restored into a library that lost it ──

const { galleryFiles, fileBytes } = await import('../js/gallery-files.js');
const { mergeIntoSeries, setChapterTitle } = await import('../js/series.js');

const TAGS = [{ type: 'category', name: 'manga', url: '' }, { type: 'rating', name: 'safe', url: '' },
  { type: 'artist', name: 'someone', url: '' }];
const TITLE = { english: 'Kept', japanese: '残す', pretty: 'Kept' };
const img = (type, ...values) => new Blob([new Uint8Array(values)], { type });

async function galleryArchiveFiles(gid, prefix = '', opts = {}) {
  const [meta, records, covers] = await Promise.all([db.metaGet(gid), db.getGalleryImageRecords(gid), db.coverRecordGet(gid)]);
  const files = galleryFiles({ meta, records, covers: { gallery: covers?.cover, series: covers?.seriesCover } }, prefix, opts);
  return Promise.all(files.map(async (f) => ({ name: f.name, data: await fileBytes(f.source) })));
}

async function pagesOf(gid) {
  const recs = (await db.getGalleryImageRecords(gid)).sort((a, b) => a.url.localeCompare(b.url));
  return Promise.all(recs.map(async (r) => [r.url, r.blob.type, [...new Uint8Array(await r.blob.arrayBuffer())]]));
}

async function seedGallery(gid, { favorite = true } = {}) {
  await db.metaPut({ galleryId: gid, title: TITLE, tags: TAGS, numPages: 2 });
  await db.dbPut(`local://${gid}/1.avif`, img('image/avif', 1, 1), gid, gid);
  await db.dbPut(`local://${gid}/2.webp`, img('image/webp', 2, 2), gid, gid);
  await db.mutateGallery(gid, { favorite }, { touch: false });
}

test('a gallery export restores its favorite, category, rating, title and AVIF/WebP pages', async () => {
  await seedGallery('701');
  const pages = await pagesOf('701');
  const archive = zip(await galleryArchiveFiles('701'));
  await db.deleteGallery('701');
  await importCbzBuffer('701', archive, 'shiori-701.zip', true);
  const meta = await db.metaGet('701');
  assert.equal(meta.favorite, true);
  assert.deepEqual(meta.tags, TAGS);
  assert.deepEqual(meta.title, TITLE);
  assert.deepEqual(await pagesOf('701'), pages, 'every page comes back in its own format, bytes untouched');
  assert.equal((await db.coverRecordGet('701')).cover.type, 'image/avif', 'page 1 (AVIF) is the cover again');
});

test('a series export restores the series favorite, title, category, rating and chapter titles', async () => {
  for (const gid of ['801', '802', '803']) await seedGallery(gid, { favorite: false });
  await mergeIntoSeries('801', '802');
  await mergeIntoSeries('801', '803');
  await setChapterTitle('801', '803', 'Extra');
  const seriesTags = [{ type: 'category', name: 'doujinshi', url: '' }, { type: 'rating', name: 'suggestive', url: '' }];
  await db.mutateGallery('801', { favorite: true, seriesTags, seriesTitle: { english: 'Series', japanese: '', pretty: 'Series' } });
  const before = await db.metaGet('801');

  // The bundle library.js writes: chapter-NN/ per chapter (series fields stripped) + series.json.
  const files = [];
  const manifest = { format: 'shiori-series', version: 1, seriesTitle: before.seriesTitle, seriesTags: before.seriesTags, chapters: [] };
  for (const [i, c] of before.chapters.entries()) {
    const folder = `chapter-${String(i + 1).padStart(2, '0')}`;
    manifest.chapters.push({ id: c.id, title: c.title, folder });
    files.push(...await galleryArchiveFiles(c.id, `${folder}/`, { stripSeriesFields: true }));
  }
  files.push({ name: 'series.json', data: enc.encode(JSON.stringify(manifest)) });
  for (const gid of ['801', '802', '803']) await db.deleteGallery(gid);

  await importCbzBuffer('801', zip(files), 'shiori-series-801.zip', true);
  const owner = await db.metaGet('801');
  assert.equal(owner.favorite, true);
  assert.deepEqual(owner.seriesTags, seriesTags);
  assert.deepEqual(owner.seriesTitle, before.seriesTitle);
  assert.deepEqual(owner.chapters, before.chapters);
  for (const gid of ['802', '803']) {
    const chapter = await db.metaGet(gid);
    assert.equal(chapter.parentId, '801');
    assert.deepEqual(chapter.tags, TAGS, "a chapter's own tags come back too");
  }
  assert.equal((await pagesOf('803')).length, 2);
});

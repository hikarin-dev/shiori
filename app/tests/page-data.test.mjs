// page-data.test.mjs — the rules that decide where a page's re-translation starts, how its data
// travels to and from the server, what "Re-run from…" says each step can do, and that a full
// backup keeps the data.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
globalThis.window = { addEventListener() {}, dispatchEvent() {} };   // i18n listens for language changes
const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null), setItem: (k, v) => _store.set(k, String(v)), removeItem: (k) => _store.delete(k),
};

const { decodePageData, encodePageData, firstChange, latestStart, planPage, rerunAvailability, translationGroups, keptConfig,
  referencedTranslations, contextBefore } = await import('../js/page-data.js');
const { rerunStatus } = await import('../js/rerun-menu.js');

const png = (n) => new Blob([new Uint8Array([137, 80, 78, 71, n])], { type: 'image/png' });
const FIELDS = { prepare: [], detect: ['detector.detection_size'], ocr: ['ocr.ocr'], merge: [], translate: ['translator.translator'],
  mask: ['mask_dilation_offset'], inpaint: ['inpainter.inpainting_size'], bubbles: [], render: ['render.renderer'] };
const CONFIG = { detector: { detection_size: 2048 }, ocr: { ocr: 'mocr' }, translator: { translator: 'sugoi' },
  mask_dilation_offset: 20, inpainter: { inpainting_size: 2048 }, render: { renderer: 'manga2eng' } };
const BUILDS = { prepare: 'a', detect: 'b', ocr: 'c', merge: 'd', translate: 'e', mask: 'f', inpaint: 'g', bubbles: 'h', render: 'i' };
const ENTRY = { at: 1, config: CONFIG, builds: BUILDS };
const resolveWith = (config = {}, builds = {}) => ({
  config: structuredClone({ ...CONFIG, ...config }), builds: { ...BUILDS, ...builds }, fields: FIELDS });
const PIPELINE = { job: 'j1', lines: [{ pts: [[0, 0], [9, 0], [9, 9], [0, 9]], score: 0.9, text: 'あ' }], read: [0],
  regions: [{ lines: [0], tr: 'Hi' }], bubbles: [{ box: [0, 0, 9, 9], bits: 'AA==' }], masks: { raw: png(1), text: png(2) } };
const page = (pipeline = PIPELINE, extra = {}) => ({ url: 'p', translated: png(9), pipeline, ...extra });
const plan = (rec, resolved, rerun) => planPage(rec, { j1: ENTRY }, resolved, new Map(), rerun);

test('the server\'s container decodes to the stored shape and a request encodes back', async () => {
  const head = new TextEncoder().encode(JSON.stringify({ lines: [], read: [], blobs: { raw: 5, text: 5 } }));
  const u8 = new Uint8Array(4 + head.length + 10);
  new DataView(u8.buffer).setUint32(0, head.length);
  u8.set(head, 4); u8.set([82, 73, 70, 70, 1, 137, 80, 78, 71, 2], 4 + head.length);   // a WebP, then a PNG
  const { record, masks } = decodePageData(u8);
  assert.deepEqual(record, { lines: [], read: [] });
  assert.deepEqual([...new Uint8Array(await masks.text.arrayBuffer())], [137, 80, 78, 71, 2]);
  assert.deepEqual([masks.raw.type, masks.text.type], ['image/webp', 'image/png'], 'each mask is labelled by its bytes');
  assert.equal(decodePageData(u8.subarray(0, u8.length - 1)), null, 'truncated data is rejected');
  const sent = new Uint8Array(await encodePageData(PIPELINE, { from: 'render', keep: [] }).arrayBuffer());
  const size = new DataView(sent.buffer).getUint32(0);
  const doc = JSON.parse(new TextDecoder().decode(sent.subarray(4, 4 + size)));
  assert.equal(doc.from, 'render');
  assert.equal(doc.job, undefined);
  assert.deepEqual(doc.blobs, { raw: 5, text: 5 });
  assert.equal(sent.length, 4 + size + 10);
});

test('the first changed step comes from builds and each step\'s own fields', () => {
  assert.equal(firstChange(ENTRY, resolveWith()), null);
  assert.equal(firstChange(ENTRY, resolveWith({ render: { renderer: 'shiori_v2' } })), 'render');
  assert.equal(firstChange(ENTRY, resolveWith({}, { ocr: 'c2' })), 'ocr', 'new OCR code');
  assert.equal(firstChange(ENTRY, resolveWith({ mask_dilation_offset: 30 })), 'mask');
  const noBubbles = resolveWith();
  delete noBubbles.builds.bubbles;
  assert.equal(firstChange({ ...ENTRY, builds: { ...BUILDS, bubbles: 'h2' } }, noBubbles), null, 'a step that no longer runs never counts');
});

test('pages start at the first change, keep what still holds, and fall back when data is missing', () => {
  assert.equal(plan(page(), resolveWith()), null, 'current');
  assert.deepEqual(plan(page(), resolveWith({ render: { renderer: 'shiori_v2' } })), { from: 'render', keep: [], data: true });
  assert.deepEqual(plan(page(), resolveWith({ translator: { translator: 'deepseek' } })),
    { from: 'translate', keep: ['mask', 'bubbles'], data: true });
  assert.deepEqual(plan(page(), resolveWith({ ocr: { ocr: '48px' } })).keep, ['translate', 'mask', 'bubbles']);
  const noMask = { ...PIPELINE, masks: { raw: png(1) } };
  assert.equal(plan(page(noMask), resolveWith({ render: { renderer: 'shiori_v2' } })).from, 'mask', 'no saved mask: refine it again');
  const untranslated = { ...PIPELINE, regions: [{ lines: [0] }] };
  assert.equal(plan(page(untranslated), resolveWith({ render: { renderer: 'shiori_v2' } })).from, 'translate');
  assert.deepEqual(plan(page(null), resolveWith()), { from: 'prepare', keep: [], data: false }, 'no data: full run');
  assert.deepEqual(plan(page({ ...PIPELINE, job: 'unknown' }), resolveWith()), { from: 'prepare', keep: [], data: false });
});

test('forcing a step redoes it and everything after, keeping nothing past it', () => {
  assert.deepEqual(plan(page(), resolveWith(), 'translate'), { from: 'translate', keep: [], data: true });
  assert.deepEqual(plan(page(), resolveWith(), 'inpaint'), { from: 'mask', keep: [], data: true });
  assert.deepEqual(plan(page(), resolveWith(), 'render'), { from: 'render', keep: [], data: true });
  assert.equal(plan(page(), resolveWith({}, { detect: 'b2' }), 'render').from, 'detect', 'an earlier change still wins');
});

test('text-less pages and reverted pages', () => {
  const blank = { job: 'j1', end: 'detect', lines: [], read: [] };
  assert.equal(latestStart(blank), 'render');
  assert.equal(plan(page(blank), resolveWith({ render: { renderer: 'shiori_v2' } })), null, 'stopped before the change');
  assert.equal(plan(page(blank), resolveWith({ detector: { detection_size: 1536 } })).from, 'detect');
  assert.equal(plan(page(blank, { translated: undefined }), resolveWith()).from, 'render', 'output removed: produce it again');
  assert.equal(plan(page(PIPELINE, { translated: undefined }), resolveWith()).from, 'render');
});

test('"Re-run from…" says how many pages can start at each step', () => {
  const records = [page(), page({ ...PIPELINE, masks: { raw: png(1) } }), page(null),
    page({ job: 'j1', end: 'ocr', lines: [PIPELINE.lines[0]], read: [], masks: { raw: png(1) } })];
  const availability = rerunAvailability(records);
  assert.deepEqual(availability.detect, { pages: 4, ready: 3 });
  assert.deepEqual(availability.translate, { pages: 3, ready: 2 }, 'the text-less page never reaches translation');
  assert.deepEqual(availability.render, { pages: 3, ready: 1 }, 'a page without its mask cannot start at rendering');
  assert.deepEqual(rerunStatus(availability.render), { enabled: true, text: '1 of 3 pages reuse the earlier steps; the rest start over' });
  assert.equal(rerunStatus({ pages: 3, ready: 3 }).text, '3 pages · reuses the earlier steps');
  assert.equal(rerunStatus({ pages: 2, ready: 0 }).enabled, false);
  assert.equal(rerunStatus({ pages: 0, ready: 0 }).enabled, false);
});

test('pages group by the settings they keep: the current ones first, then kept ones oldest first', () => {
  const entries = { a: { at: 2, config: {} }, b: { at: 1, config: {} } };
  const records = [{ url: '1' }, { url: '2', own: 'a' }, { url: '3', own: 'b' }, { url: '4', own: 'gone' }];
  assert.deepEqual(translationGroups(records, entries).map(g => [g.own, g.pages.map(r => r.url)]),
    [[null, ['1', '4']], ['b', ['3']], ['a', ['2']]], 'a page whose kept entry is gone follows the current settings');
});

test('a kept config is the recorded one over the current settings', () => {
  const base = { translator: { translator: 'sugoi', target_lang: 'ENG', gpt_config: null }, render: { renderer: 'manga2eng' }, timeout: 9 };
  const recorded = { translator: { translator: 'deepseek', gpt_config: 'digest' }, render: { renderer: 'shiori_v2' } };
  assert.deepEqual(keptConfig(base, recorded),
    { translator: { translator: 'deepseek', target_lang: 'ENG' }, render: { renderer: 'shiori_v2' }, timeout: 9 });
  assert.deepEqual(keptConfig(base, { render: { renderer: 'x' } }).translator, { translator: 'sugoi', target_lang: 'ENG' });
  assert.equal(base.translator.gpt_config, null, 'the current settings are left as they are');
});

test('translation entries stay while a page comes from or keeps them', () => {
  const entries = { a: {}, b: {}, c: {} };
  assert.deepEqual(Object.keys(referencedTranslations(entries, [{ pipeline: { job: 'a' } }, { own: 'c' }, {}])), ['a', 'c']);
});

test('context is the earlier pages\' saved texts and translations, oldest first', () => {
  const lines = [{ text: 'あ' }, { text: 'い' }, { text: 'Hello' }, { text: 'there' }];
  const rec = (n, regions) => ({ url: `/g/${n}.webp`, pipeline: { lines, regions } });
  const records = [rec(4, [{ lines: [0], tr: 'D' }]), rec(3, [{ lines: [2, 3], lang: 'en', tr: 'C' }]), rec(2, []),
    rec(1, [{ lines: [0, 1], lang: 'ja', tr: 'A' }, { lines: [1], keep: false, tr: 'x' }, { lines: [0], text: 'edited', tr: 'B' }])];
  const pageNum = (u) => parseInt(u.match(/(\d+)\.webp/)[1], 10);
  assert.deepEqual(contextBefore(records, records[0], pageNum),
    [{ src: ['あい', 'edited'], tr: ['A', 'B'] }, { src: ['Hello there'], tr: ['C'] }]);
  assert.deepEqual(contextBefore(records, records[3], pageNum), [], 'nothing comes before page 1');
  // Snapshots off: a page's study balloons stand in, their line breaks joined as the text reads.
  const bare = [{ url: 'local://g/1.webp', pipeline: { job: 'j1' }, bubbles: [{ src: 'おはよう\nございます', tr: 'Good\nmorning' }, { src: 'x', tr: '' }] },
    { url: 'local://g/2.webp', pipeline: { job: 'j1' } }];
  assert.deepEqual(contextBefore(bare, bare[1], pageNum), [{ src: ['おはようございます'], tr: ['Good morning'] }]);
});

test('page properties describe what is stored for a page and how big each part is', async () => {
  const { describePage } = await import('../js/reader-properties.js');
  const pipeline = { ...PIPELINE, regions: [{ lines: [0], lang: 'ja', tr: 'Hi' }, { lines: [0], tr: 'Oh', keep: false }] };
  const record = { url: 'u', galleryId: 'g', cachedAt: 5, blob: png(1), translated: png(9), pipeline, own: 'j1',
    bubbles: [{ box: {}, tr: 'Hi', src: 'あ', text: png(4) }], studyBg: png(5), studyPage: { w: 9, h: 9 } };
  const info = describePage({ record, meta: { translations: { j1: ENTRY } },
    images: { original: { bytes: 5, format: 'PNG', w: 10, h: 20 }, translated: { bytes: 5, format: 'WebP', w: 10, h: 20 } } });
  assert.equal(info.status, 'translated');
  assert.equal(info.own, true);
  assert.equal(info.entry, ENTRY);
  const { steps } = info;
  assert.deepEqual([steps.lines, steps.read, steps.regions, steps.filtered, steps.translations, steps.bubbles], [1, 1, 2, 1, 2, 1]);
  assert.deepEqual([steps.raw.bytes, steps.mask.bytes, steps.restart], [5, 5, 'render']);
  assert.equal(steps.bytes, steps.recordBytes + 10);
  assert.deepEqual(info.text, [{ src: 'あ', tr: 'Hi', filtered: false }, { src: 'あ', tr: 'Oh', filtered: true }]);
  assert.deepEqual([info.study.balloons, info.study.layers, info.study.layersBytes, info.study.bg.bytes], [1, 1, 5, 5]);
  assert.equal(info.storage.total, 5 + 5 + steps.bytes + info.study.bytes);
  const reverted = describePage({ record: { ...record, translated: undefined, bubbles: undefined, own: 'gone' }, meta: { translations: { j1: ENTRY } } });
  assert.deepEqual([reverted.status, reverted.own, reverted.study], ['reverted', false, null]);
  assert.equal(describePage({ record: { url: 'v', blob: png(1) }, meta: null }).status, 'none');
  // Saving steps off: the page names its translation and settings, and has no steps.
  const bare = describePage({ record: { ...record, pipeline: { job: 'j1' } }, meta: { translations: { j1: ENTRY } } });
  assert.deepEqual([bare.status, bare.entry, bare.steps, bare.storage.steps], ['translated', ENTRY, null, 0]);
  assert.deepEqual(bare.text, [{ src: 'あ', tr: 'Hi', filtered: false }], 'its text comes from the study data');
  const bareReverted = describePage({ record: { ...record, pipeline: { job: 'j1' }, translated: undefined, bubbles: undefined },
    meta: { translations: { j1: ENTRY } } });
  assert.equal(bareReverted.status, 'none', 'nothing is kept once reverted');
});

test('a full backup keeps each page\'s pipeline data and masks', async () => {
  const api = await import('../js/api.js');
  const { exportFull, importBackup } = await import('../js/backup.js');
  await api.meta.put({ galleryId: '555', title: { english: 'B', japanese: '', pretty: 'B' }, tags: [], translations: { j1: ENTRY } });
  await api.pages.put('555', 1, png(3), { key: 'local://555/1.png' });
  await api.derived.putTranslation('555', 1, { image: png(9), pipeline: PIPELINE, own: 'j1' });
  const { archive } = await exportFull();
  await api.derived.putTranslation('555', 1, { image: png(9), pipeline: null, own: null });
  assert.equal((await api.pages.get('555', 1)).pipeline, undefined);
  assert.equal((await api.pages.get('555', 1)).own, undefined);
  await importBackup(new File([archive], 'backup.shioridb'));
  const rec = await api.pages.get('555', 1);
  assert.deepEqual(rec.pipeline.regions, PIPELINE.regions);
  assert.deepEqual([...new Uint8Array(await rec.pipeline.masks.text.arrayBuffer())], [137, 80, 78, 71, 2]);
  assert.equal(rec.own, 'j1', 'a page keeping its own settings still does');
  assert.deepEqual((await api.meta.get('555')).translations, { j1: ENTRY });
});

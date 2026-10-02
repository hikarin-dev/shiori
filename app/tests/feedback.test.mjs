import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { captureFeedback, feedbackZip, feedbackDestination, feedbackRequest, feedbackKey, feedbackTarget, sha256 } = await import('../js/feedback.js');
const api = await import('../js/api.js');
const metaPut = api.meta.put;
const { unzip } = await import('../js/import-cbz.js');

const TRANSLATION = { at: 1, config: { render: { renderer: 'shiori_v2' } }, builds: { render: 'a'.repeat(12) } };

async function example(mode = 'text', gallery = 'feedback-example') {
  const original = new Blob(['original bytes'], { type: 'image/png' });
  const translated = new Blob(['translated bytes'], { type: 'image/png' });
  await metaPut({ galleryId: gallery, translations: { j1: TRANSLATION } });
  const bubbles = [{ id: 0, lineIds: [0], tr: 'A trans-\nlation', rawTr: 'A translation', box: { x: .1, y: .1, w: .2, h: .2 },
    text: mode === 'image' ? new Blob(['glyph layer']) : null }, { id: 1, tr: 'Neighbour', box: { x: .5, y: .1, w: .2, h: .2 } }];
  const pipeline = { job: 'j1', lines: [{ pts: [[0, 0], [9, 0], [9, 9], [0, 9]], score: 0.9, text: 'あ' }], read: [0],
    regions: [{ lines: [0], tr: 'A translation' }, { lines: [0], tr: 'Neighbour' }],
    masks: { raw: new Blob(['raw mask'], { type: 'image/png' }), text: new Blob(['text mask'], { type: 'image/png' }) } };
  const record = { galleryId: gallery, blob: original, translated, pipeline,
    studyBg: mode === 'image' ? new Blob(['clean background']) : null, bubbles, studyPage: { w: 1000, h: 1500 } };
  return { record, displayed: { bubbles, job: 'j1' }, display: { readerMode: 'strip', view: 'study', pageNumber: 1, study: { display: mode } } };
}

for (const mode of ['text', 'image']) test(`${mode} feedback freezes all cached page data and survives library deletion`, async () => {
  const gallery = `feedback-${mode}`, url = `page://${gallery}/1.png`;
  const { record, displayed, display } = await example(mode, gallery);
  await api.pages.put(gallery, 1, record.blob, { key: url });
  await api.transfer.write({ galleryId: gallery, pages: [{ ...await api.pages.get(gallery, 1), ...record }] });   // the page as stored
  const capture = await captureFeedback(await api.pages.get(gallery, 1), displayed, display, 1);
  capture.manifest.issues = ['grouping']; capture.manifest.note = 'Join with the first region';
  capture.manifest.selection.related = [0];
  await api.galleries.delete(gallery);
  assert.equal(await api.pages.get(gallery, 1), null);
  const files = new Map((await unzip(await (await feedbackZip(capture)).arrayBuffer())).map(e => [e.filename, e.data]));
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  assert.equal(manifest.note, 'Join with the first region');
  assert.equal(manifest.selection.primary, 1);
  assert.deepEqual(manifest.selection.related, [0]);
  assert.equal(manifest.page.bubbles[0].rawTr, 'A translation');
  assert.equal(manifest.page.bubbles[0].tr, 'A trans-\nlation');
  assert.equal(manifest.display.study.display, mode);
  // The page's pipeline data, its masks and the translation behind it travel in the report.
  assert.deepEqual(manifest.pipeline.regions, record.pipeline.regions);
  assert.equal(new TextDecoder().decode(files.get(manifest.pipeline.masks.text.path)), 'text mask');
  assert.deepEqual(manifest.translation, TRANSLATION);
  assert.equal(manifest.fidelity, mode === 'text' ? 'incomplete' : 'complete');
  assert.deepEqual(manifest.missing, mode === 'text' ? ['study_background'] : []);
  for (const [path, blob] of capture.assets) assert.deepEqual(files.get(path), new Uint8Array(await blob.arrayBuffer()));
});

test('study layers from another translation or a stale display cannot be reported together', async () => {
  for (const mutate of [r => { r.pipeline.job = 'j2'; }, r => { r.bubbles[0].tr = 'new text'; }, r => { delete r.pipeline; }]) {
    const { record, displayed, display } = await example();
    const changed = structuredClone(record); mutate(changed);
    await assert.rejects(captureFeedback(changed, displayed, display, 0), /feedback.mismatch/);
  }
});

test('historical evidence stays incomplete and remote-looking image fields are never fetched', async () => {
  const { record, displayed, display } = await example();
  delete record.pipeline; delete displayed.job;
  record.blob = 'https://example.invalid/image.png'; record.translated = null;
  for (const b of displayed.bubbles) delete b.id;
  const previous = globalThis.fetch; globalThis.fetch = () => { throw new Error('must not fetch'); };
  try {
    const capture = await captureFeedback(record, displayed, display, 0);
    assert.equal(capture.manifest.selection.primary, 'legacy-0');
    for (const key of ['pipeline', 'original', 'translated', 'study_background', 'original_region_ids']) assert.ok(capture.manifest.missing.includes(key));
    assert.equal(capture.manifest.pipeline, null);
  } finally { globalThis.fetch = previous; }
});

test('server credentials only go to the configured destination and never enter archives', () => {
  const settings = { serverUrl: 'https://one.invalid/base/', serverToken: 'secret' };
  assert.deepEqual(feedbackDestination(settings).headers, { 'X-Access-Token': 'secret' });
  assert.equal(feedbackDestination(settings).server, 'https://one.invalid/base');
  assert.throws(() => feedbackDestination({ serverUrl: 'https://user:secret@one.invalid' }), /server_invalid/);
});

test('failed save requests reject, leaving captured notes and retry identity intact', async () => {
  const { record, displayed, display } = await example();
  const capture = await captureFeedback(record, displayed, display, 0);
  capture.manifest.note = 'Keep my note';
  const before = JSON.stringify(capture.manifest), previous = globalThis.fetch;
  try {
    for (const failure of [async () => { throw new TypeError('offline'); }, async () => new Response('no disk', { status: 507 })]) {
      globalThis.fetch = failure;
      await assert.rejects(feedbackRequest(feedbackDestination({}), '/feedback/save', { archive: await feedbackZip(capture) }));
      assert.equal(JSON.stringify(capture.manifest), before);
    }
  } finally { globalThis.fetch = previous; }
});

test('F ignores repeats and modifiers; sibling DOM content resolves its own region owner', () => {
  assert.ok(feedbackKey({ key: 'f' }));
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'repeat', 'isComposing']) assert.equal(feedbackKey({ key: 'f', [modifier]: true }), false);
  const wrap = {}, owner = { dataset: { feedbackIndex: '2', feedbackVisible: 'true' }, closest: () => wrap };
  const span = { closest: selector => selector === '[data-feedback-index]' ? owner : null };
  assert.deepEqual(feedbackTarget(span), { wrap, index: 2, surface: 'translation' });
  owner.dataset.feedbackSurface = 'ocr';
  assert.equal(feedbackTarget(span).surface, 'ocr');
  owner.dataset.feedbackSurface = 'original';
  assert.equal(feedbackTarget(span).surface, 'original');
  owner.dataset.feedbackVisible = 'false'; assert.equal(feedbackTarget(span), null);
});

test('source and OCR feedback preserve their target without requiring a selected translation', async () => {
  for (const surface of ['original', 'ocr']) {
    const { record, displayed, display } = await example();
    record.bubbles[0].src = 'Recognized source wording';
    record.bubbles[0].tr = '';
    const capture = await captureFeedback(record, displayed, { ...display, surface }, 0);
    assert.equal(capture.manifest.selection.surface, surface);
    assert.equal(capture.manifest.page.bubbles[0].src, 'Recognized source wording');
    assert.ok(!capture.manifest.missing.includes('selected_translation'));
  }
});

test('feedback modal copy sends to the developer without exposing review or storage addresses', async () => {
  const { LOCALES } = await import('../js/locales.js');
  assert.equal(LOCALES.en['feedback.save'], 'Send feedback');
  assert.match(LOCALES.en['feedback.destination'], /developer/);
  for (const locale of Object.values(LOCALES)) {
    for (const key of ['destination', 'saved']) {
      assert.doesNotMatch(locale['feedback.' + key], /\{server\}|\/dashboard|feedback\/|localhost|127\.0\.0\.1/);
    }
    for (const key of ['subject', 'surface_original', 'surface_ocr', 'surface_translation', 'ocr']) assert.equal(typeof locale['feedback.' + key], 'string');
  }
});

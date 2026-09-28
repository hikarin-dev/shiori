// page-image.test.mjs — a translated page kept as its study data alone (layers that rebuild it
// exactly, or text over the background): what the reader shows for each display setting and when
// one can't be provided, that it counts as translated, that it is composed into one image for
// anything that needs one (the page served back to a site, feedback), and the job flow that stores it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
// Canvas stand-ins: record what is drawn, in order (text as `fill <line> @x,y`).
const drawn = [];
let pen = null;
globalThis.createImageBitmap = async (blob) => ({ width: 800, height: 600, blob, close() {} });
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; this.size = [w, h]; }
  getContext() {
    return pen = { drawImage: (bitmap) => drawn.push(bitmap.blob),
      measureText: (t) => ({ width: t.length * 10, fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4 }),
      fillText: (t, x, y) => drawn.push(`fill ${t} @${x},${y}`), strokeText: (t) => drawn.push(`stroke ${t}`) };
  }
  async convertToBlob(opts) { return new Blob([`composed ${this.size}`], { type: opts.type }); }
};

const { hasTranslation, translationView, translatedImage } = await import('../js/page-image.js');
const db = await import('../js/db.js');
const { planPage } = await import('../js/page-data.js');

const blob = (s, type = 'image/webp') => new Blob([s], { type });
const LAYERED = () => ({ url: 'L', translatedLayers: true, studyBg: blob('bg'), pipeline: { job: 'j' },
  bubbles: [{ tr: 'Hi', text: blob('t0', 'image/webp') }, { tr: 'Oh', text: blob('t1') }] });

test('the translate view shows what each page has, falling back when the chosen display can\'t be shown', () => {
  const both = { translated: true, bg: 'bg', bubbles: [{ tr: 'Hi', text: 'png' }] };
  const layered = { translated: false, bg: 'bg', bubbles: [{ tr: 'Hi', text: 'png' }] };
  const textOnly = { translated: true, bg: 'bg', bubbles: [{ tr: 'Hi' }] };
  const imageOnly = { translated: true, bg: null, bubbles: [] };
  const oldTextOnly = { translated: true, bg: null, bubbles: [{ tr: 'Hi' }] };
  const none = { translated: false, bg: null, bubbles: [] };
  const view = (p, d) => { const v = translationView(p, d); return `${v.source}+${v.overlay}`; };
  assert.equal(view(both, 'image'), 'translated+null');
  assert.equal(view(both, 'text'), 'bg+text');
  assert.equal(view(layered, 'image'), 'bg+images', 'a page kept as its layers shows them as the image');
  assert.equal(view(layered, 'text'), 'bg+text');
  assert.equal(view(textOnly, 'text'), 'bg+text');
  assert.equal(view(imageOnly, 'text'), 'translated+null', 'text display without a background shows the image');
  assert.equal(view(oldTextOnly, 'text'), 'translated+null');
  assert.equal(view(none, 'image'), 'original+null');
  assert.equal(view({ translated: false, bg: 'bg', bubbles: [{ tr: 'Hi' }] }, 'image'), 'bg+text', 'no image of either kind: the text');
});

test('a page kept as its study layers counts as translated only while they are all there', () => {
  assert.equal(hasTranslation({ translated: blob('p') }), true);
  assert.equal(hasTranslation(LAYERED()), true);
  assert.equal(hasTranslation({ ...LAYERED(), studyBg: null }), false, 'the layers have not arrived');
  assert.equal(hasTranslation({ translatedLayers: true, studyBg: blob('bg'), bubbles: [{ tr: 'Hi' }] }), true, 'text over the bg');
  assert.equal(hasTranslation({ translatedLayers: true, studyBg: blob('bg'), bubbles: [] }), false);
  assert.equal(hasTranslation({}), false);
});

test('its layers compose into one image — the background, then each balloon\'s text — once', async () => {
  const stored = blob('page');
  assert.equal(await translatedImage({ translated: stored }), stored, 'a stored image is returned as it is');
  drawn.length = 0;
  const rec = LAYERED();
  const image = await translatedImage(rec);
  assert.equal(image.type, 'image/webp');
  assert.deepEqual(await Promise.all(drawn.map(b => b.text())), ['bg', 't0', 't1']);
  assert.equal(await translatedImage(rec), image, 'composed once, then reused');
  assert.equal(drawn.length, 3);
  assert.equal(await translatedImage({ url: 'x' }), null);
});

test('a page kept as text over its background is typeset as the reader shows it', async () => {
  drawn.length = 0;
  const rec = { url: 'T', translatedLayers: true, studyBg: blob('bg'), pipeline: { job: 'j' }, bubbles: [
    { tr: 'Hello there\nfriend', tbox: { x: 0.25, y: 0.5, w: 0.1, h: 0.2 }, style: { fg: [0, 0, 0], strokeWidth: 2, fontSize: 20 } },
    { tr: '', box: { x: 0, y: 0, w: 1, h: 1 } }] };
  await translatedImage(rec);
  const labels = await Promise.all(drawn.map(d => (typeof d === 'string' ? d : d.text())));
  // The renderer's two lines, kept as drawn though 'Hello there' (110 px) is wider than the 80 px
  // rect at x 200–280; two 23 px lines centred on y 360, each 20 px glyph box centred in its line.
  assert.deepEqual(labels, ['bg', 'stroke Hello there', 'fill Hello there @240,354.5', 'stroke friend', 'fill friend @240,377.5']);
  assert.equal(pen.lineWidth, 4, 'the outward ring doubled, as the reader strokes it');
  assert.equal(pen.strokeStyle, 'rgb(255,255,255)');
  assert.equal(pen.fillStyle, 'rgb(0,0,0)');
  assert.equal(pen.textAlign, 'center');
  drawn.length = 0;
  rec.bubbles[0].tr = 'Bye';
  await translatedImage(rec);
  assert.ok(drawn.includes('stroke Bye'), 'a changed translation is composed again');
});

test('the page is served back as one image, like a stored translation', async () => {
  await db.metaPut({ galleryId: '70', numPages: 1 });
  await db.dbPut('local://70/1.webp', blob('original'), '70', '70');
  const rec = await db.dbGet('local://70/1.webp');
  await db.imageRecordPut({ ...rec, ...LAYERED(), url: 'local://70/1.webp' });
  const served = await db.getPageBlob('70', 1, 'translated');
  assert.match(await served.text(), /^composed/);
  const { pages } = await db.getGalleryPageRange('70', 1, 1, { preferTranslated: true });
  assert.match(atob(pages[0].dataUrl.split(',')[1]), /^composed/);
  assert.equal(await (await db.getPageBlob('70', 1)).text(), 'original');
});

// ── The job flow ────────────────────────────────────────────────────────────────────────────
const CAPS = JSON.parse(readFileSync(new URL('./fixtures/capabilities.json', import.meta.url), 'utf8'));
const { startTranslation, pollTranslation } = await import('../js/translate.js');
const { migrateTranslateSettings } = await import('../js/translate-config.js');
const BASE = migrateTranslateSettings({ serverUrl: 'http://127.0.0.1:5003' });
const SETTINGS = { ...BASE, studyModeGeneration: 'text_and_image',
  params: { ...BASE.params, 'translator.translator': 'sugoi', 'render.renderer': 'manga2eng' } };
const BUILDS = { prepare: 'p', detect: 'd', ocr: 'o', merge: 'm', translate: 't', mask: 'k', inpaint: 'i', bubbles: 'b', render: 'r' };
const FIELDS = Object.fromEntries(Object.keys(BUILDS).map(s => [s, []]));
let started = null;
const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const frame = (status, data) => { const out = new Uint8Array(5 + data.length); out[0] = status; new DataView(out.buffer).setUint32(1, data.length); out.set(data, 5); return out; };
const pageFrame = (status, token, idx, payload) => {
  const t = new TextEncoder().encode(token);
  const out = new Uint8Array(1 + t.length + 4 + payload.length);
  out[0] = t.length; out.set(t, 1); new DataView(out.buffer).setUint32(1 + t.length, idx); out.set(payload, 5 + t.length);
  return frame(status, out);
};
const container = (record) => {
  const head = new TextEncoder().encode(JSON.stringify(record));
  const out = new Uint8Array(4 + head.length);
  new DataView(out.buffer).setUint32(0, head.length); out.set(head, 4);
  return out;
};
const dataUrl = (s) => `data:image/webp;base64,${btoa(s)}`;
let poll = null;
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url, 'http://x').pathname;
  if (url.startsWith('data:')) return new Response(Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0)), { headers: { 'content-type': 'image/webp' } });
  if (path === '/capabilities') return json(CAPS);
  if (path === '/translate/gallery/resolve') return json({ config: JSON.parse(init.body.get('config')), builds: BUILDS, fields: FIELDS, signature: 's' });
  if (path === '/translate/gallery/start') { started = { token: init.body.get('job_token'), images: init.body.getAll('image').length, capture: init.body.get('capture') }; return json({ token: started.token }); }
  if (path === '/translate/gallery/poll') return new Response(poll);
  return new Response('', { status: 404 });
};

test('a page sent as its study layers is stored as them, counts as translated, and is current next time', async () => {
  await db.metaPut({ galleryId: '71', numPages: 1, translated: false });
  await db.dbPut('local://71/1.webp', blob('original'), '71', '71');
  await startTranslation('71', { ...SETTINGS, saveSnapshots: true }, () => {});
  assert.equal(started.capture, null, 'snapshots on: the page data comes back');
  const record = { lines: [{ pts: [[0, 0], [9, 0], [9, 9], [0, 9]], score: 0.9, text: 'あ' }], read: [0], regions: [{ lines: [0], tr: 'Hi' }], bubbles: [] };
  const study = { page: { w: 8, h: 6 }, bg: dataUrl('bg'), bubbles: [{ box: { x: 0, y: 0, w: 1, h: 1 }, tr: 'Hi', src: 'あ', text: dataUrl('t0') }] };
  const parts = [frame(7, new TextEncoder().encode(JSON.stringify({ cursor: 0, status: 'done', done: 1, total: 1 }))),
    pageFrame(9, started.token, 0, container(record)), pageFrame(5, started.token, 0, new Uint8Array(0)),
    pageFrame(6, started.token, 0, new TextEncoder().encode(JSON.stringify(study))),
    frame(0, new TextEncoder().encode(JSON.stringify({ count: 1, failed: [] })))];
  poll = new Uint8Array(parts.flatMap(p => [...p]));
  await pollTranslation('71', () => {});
  const rec = await db.dbGet('local://71/1.webp');
  assert.equal(rec.translated, undefined, 'no second copy of the page');
  assert.equal(rec.translatedLayers, true);
  assert.equal(await rec.studyBg.text(), 'bg');
  assert.equal(hasTranslation(rec), true);
  assert.equal((await db.metaGet('71')).translated, true);
  const meta = await db.metaGet('71');
  const resolved = { config: meta.translations[rec.pipeline.job].config, builds: BUILDS, fields: FIELDS };
  assert.equal(planPage(rec, meta.translations, resolved, new Map()), null, 'nothing to redo');
  assert.equal(await db.clearGalleryTranslations('71'), 1, 'a revert counts it');
  const reverted = await db.dbGet('local://71/1.webp');
  assert.equal(reverted.translatedLayers, undefined);
  assert.notEqual(planPage(reverted, meta.translations, resolved, new Map()), null, 'reverted: it is produced again');
});

test('with snapshots off (the default), a page keeps only which translation made it — and its study data', async () => {
  await db.metaPut({ galleryId: '72', numPages: 1, translated: false });
  await db.dbPut('local://72/1.webp', blob('original'), '72', '72');
  await startTranslation('72', SETTINGS, () => {});
  assert.equal(started.capture, '0', 'the server is asked for no page data');
  const study = { page: { w: 8, h: 6 }, bg: dataUrl('bg'), bubbles: [{ box: { x: 0, y: 0, w: 1, h: 1 }, tr: 'Hi', src: 'あ' }] };
  const parts = [frame(7, new TextEncoder().encode(JSON.stringify({ cursor: 0, status: 'done', done: 1, total: 1 }))),
    pageFrame(5, started.token, 0, new Uint8Array(0)),
    pageFrame(6, started.token, 0, new TextEncoder().encode(JSON.stringify(study))),
    frame(0, new TextEncoder().encode(JSON.stringify({ count: 1, failed: [] })))];
  poll = new Uint8Array(parts.flatMap(p => [...p]));
  await pollTranslation('72', () => {});
  const rec = await db.dbGet('local://72/1.webp');
  assert.deepEqual(Object.keys(rec.pipeline), ['job']);
  assert.equal(rec.bubbles?.length, 1, 'its study data is kept: the page is that data');
  assert.equal(hasTranslation(rec), true);
  const meta = await db.metaGet('72');
  assert.equal(meta.translated, true);
  const resolved = { config: meta.translations[rec.pipeline.job].config, builds: BUILDS, fields: FIELDS };
  assert.equal(planPage(rec, meta.translations, resolved, new Map()), null, 'current while its settings are');
  assert.deepEqual(planPage(rec, meta.translations, { ...resolved, builds: { ...BUILDS, translate: 't2' } }, new Map()),
    { from: 'prepare', keep: [], data: false }, 'otherwise every step runs');
});

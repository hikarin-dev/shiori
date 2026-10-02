// translate-reuse.test.mjs — what a translation sends and keeps: each page's saved pipeline data
// decides where it starts (a renderer change re-renders only, a translator change keeps the mask),
// finished pages store their data with the job that made them, current pages aren't sent,
// "Re-run from…" forces a step, a revert keeps the data, and pages without data start over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const CAPS = JSON.parse(readFileSync(new URL('./fixtures/capabilities.json', import.meta.url), 'utf8'));
const S = 'http://127.0.0.1:5003';

// The library through its interface, by the page keys these tests use ("/<gallery>/<n>.webp").
const api = await import('../js/api.js');
const _at = (key) => { const m = String(key).match(/^(?:local:\/)?\/([^/]+)\/(\d+)\.\w+$/); return [m[1], Number(m[2])]; };
const dbPut = (key, image, mediaId, gid) => api.pages.put(gid, _at(key)[1], image, { key, mediaId });
const dbGet = (key) => api.pages.get(..._at(key));
const putTranslatedPage = (key, image, pipeline, own) => api.derived.putTranslation(..._at(key), { image, pipeline, own });
const putTranslatedImage = (key, image) => api.derived.putTranslatedImage(..._at(key), image);
const putPageStudy = (key, study, job) => api.derived.putStudy(..._at(key), study, job);
const setPagesOwn = (keys, own) => api.derived.setOwn(keys.map(k => { const [galleryId, pageNum] = _at(k); return { galleryId, pageNum }; }), own);
const metaPut = api.meta.put, metaGet = api.meta.get, clearGalleryTranslations = api.derived.clear;
const { startTranslation, pollTranslation, revertGallery } = await import('../js/translate.js');
const { translateResume } = await import('../js/platform.js');
const { buildConfig, migrateTranslateSettings } = await import('../js/translate-config.js');

const BASE = migrateTranslateSettings({ serverUrl: S });
const SETTINGS = { ...BASE, params: { ...BASE.params, 'translator.translator': 'sugoi', 'render.renderer': 'manga2eng' } };
const FIELDS = {
  prepare: [], detect: ['detector.detector', 'detector.detection_size'], ocr: ['ocr.ocr'], merge: ['translator.target_lang'],
  translate: ['translator.translator', 'translator.target_lang'], mask: ['mask_dilation_offset'],
  inpaint: ['inpainter.inpainter', 'inpainter.inpainting_size'], bubbles: [], render: ['render.renderer', 'study_mode_generation'],
};
const BUILDS = { prepare: 'p1', detect: 'd1', ocr: 'o1', merge: 'm1', translate: 't1', mask: 'k1', inpaint: 'i1', bubbles: 'b1', render: 'r1' };

// A page's data as the server returns it: [u32 BE JSON length][JSON][raw PNG][text PNG].
function container(record, masks = {}) {
  const blobs = ['raw', 'text'].filter(n => masks[n]);
  const head = new TextEncoder().encode(JSON.stringify({ ...record, ...(blobs.length ? { blobs: Object.fromEntries(blobs.map(n => [n, masks[n].length])) } : {}) }));
  const out = new Uint8Array(4 + head.length + blobs.reduce((s, n) => s + masks[n].length, 0));
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  let at = 4 + head.length;
  for (const n of blobs) { out.set(masks[n], at); at += masks[n].length; }
  return out;
}
async function unpack(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  if (!u8.length) return null;
  const size = new DataView(u8.buffer).getUint32(0);
  const record = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + size)));
  return { record, tail: u8.length - 4 - size };
}
const RECORD = { lines: [{ pts: [[0, 0], [9, 0], [9, 9], [0, 9]], score: 0.9, text: 'あ', prob: 0.99, fg: [0, 0, 0], bg: [255, 255, 255], dir: 'v' }],
  read: [0], regions: [{ lines: [0], size: 20, prob: 0.99, fg: [0, 0, 0], bg: [255, 255, 255], lang: 'ja', src: 'v', tr: 'Hi' }],
  bubbles: [{ box: [0, 0, 9, 9], bits: 'AA==' }] };
const MASKS = { raw: new Uint8Array([137, 80, 78, 71, 1]), text: new Uint8Array([137, 80, 78, 71, 2]) };

let server;
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  server.calls.push(path);
  const reply = await server.routes[path]?.(init);
  if (!reply) return new Response('not found', { status: 404 });
  return reply;
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const frame = (status, data) => {
  const out = new Uint8Array(5 + data.length);
  out[0] = status;
  new DataView(out.buffer).setUint32(1, data.length);
  out.set(data, 5);
  return out;
};
const pageFrame = (status, token, idx, payload) => {
  const t = new TextEncoder().encode(token);
  const out = new Uint8Array(1 + t.length + 4 + payload.length);
  out[0] = t.length; out.set(t, 1);
  new DataView(out.buffer).setUint32(1 + t.length, idx);
  out.set(payload, 5 + t.length);
  return frame(status, out);
};

function useServer({ caps = CAPS, builds = BUILDS, resolve = true } = {}) {
  server = { calls: [], started: null, routes: {
    '/capabilities': () => (caps ? json(caps) : null),
    '/translate/gallery/resolve': (init) => {
      if (!resolve) return null;
      const config = JSON.parse(init.body.get('config'));
      return json({ config, builds, fields: FIELDS, signature: 'sig-' + Object.values(builds).join('') });
    },
    '/translate/gallery/start': async (init) => {
      const form = init.body;
      server.started = { images: form.getAll('image').length, stages: await Promise.all(form.getAll('stage').map(unpack)),
        builds: form.get('builds'), config: JSON.parse(form.get('config')), token: form.get('job_token') };
      return json({ token: server.started.token, started: true });
    },
  } };
}

// Let the fake server finish the started job: every uploaded page comes back with its data.
async function finish(gid, record = RECORD, { study = true } = {}) {
  const { token } = server.started;
  const parts = [frame(7, new TextEncoder().encode(JSON.stringify({ cursor: 0, status: 'done', done: server.started.images, total: 3 })))];
  for (let i = 0; i < server.started.images; i++) {
    parts.push(pageFrame(9, token, i, container(record, MASKS)));
    parts.push(pageFrame(5, token, i, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, i])));
    if (study) parts.push(pageFrame(6, token, i, new TextEncoder().encode(JSON.stringify({ bubbles: [{ id: 0, line_ids: [0], box: { x: 0, y: 0, w: 1, h: 1 }, tr: 'Hi', src: 'あ' }] }))));
  }
  parts.push(frame(0, new TextEncoder().encode(JSON.stringify({ count: server.started.images, failed: [] }))));
  server.routes['/translate/gallery/poll'] = () => new Response(new Uint8Array(parts.flatMap(p => [...p])));
  await pollTranslation(gid, () => {});
}

async function seed(gid, { withData = true } = {}) {
  await metaPut({ galleryId: gid, numPages: 3, translated: false });
  for (const n of [1, 2, 3]) await dbPut(`/${gid}/${n}.webp`, new Blob([`original ${gid} ${n}`]), gid, gid);
  if (!withData) return;
  useServer();
  await startTranslation(gid, SETTINGS, () => {});
  await finish(gid);
}

test('a fresh translation stores every page with its data and the gallery with its config', async () => {
  useServer();
  await seed('80', { withData: false });
  const sent = [];
  await startTranslation('80', SETTINGS, (m) => sent.push(m));
  assert.ok(!sent.some(m => m.status === 'error'), JSON.stringify(sent));
  assert.equal(server.started.images, 3);
  assert.deepEqual(server.started.stages, [null, null, null], 'nothing saved yet: every page runs in full');
  assert.equal(server.started.builds, 'sig-p1d1o1m1t1k1i1b1r1');
  assert.deepEqual(server.started.config, buildConfig(SETTINGS, CAPS));
  await finish('80');
  const rec = await dbGet('/80/1.webp');
  const meta = await metaGet('80');
  const [job] = Object.keys(meta.translations);
  assert.equal(rec.pipeline.job, job);
  assert.deepEqual({ ...rec.pipeline, masks: undefined, job: undefined }, { ...RECORD, masks: undefined, job: undefined });
  assert.equal(await rec.pipeline.masks.text.text(), new TextDecoder().decode(MASKS.text));
  assert.equal(rec.bubbles[0].id, 0, 'study stored for the job that made the page');
  assert.deepEqual(meta.translations[job].builds, BUILDS);
  assert.equal(meta.translations[job].config.render.renderer, 'manga2eng');
  assert.equal(meta.translated, true);
});

test('unchanged settings send nothing', async () => {
  await seed('81');
  useServer();
  const sent = [];
  await startTranslation('81', SETTINGS, (m) => sent.push(m));
  assert.equal(server.started, null);
  assert.equal(sent.at(-1).status, 'done');
});

test('a renderer change starts every page at rendering, with its data', async () => {
  await seed('82');
  useServer({ builds: { ...BUILDS, render: 'r2' } });
  await startTranslation('82', { ...SETTINGS, params: { ...SETTINGS.params, 'render.renderer': 'shiori_v2' } }, () => {});
  assert.equal(server.started.images, 3);
  for (const page of server.started.stages) {
    assert.equal(page.record.from, 'render');
    assert.deepEqual(page.record.keep, []);
    assert.deepEqual(page.record.regions, RECORD.regions);
    assert.equal(page.record.job, undefined, 'the job id stays in the app');
    assert.equal(page.tail, MASKS.raw.length + MASKS.text.length, 'masks ride along');
  }
});

test('a translator change keeps what doesn\'t depend on the wording', async () => {
  await seed('83');
  useServer({ builds: { ...BUILDS, translate: 't2' } });
  await startTranslation('83', { ...SETTINGS, params: { ...SETTINGS.params, 'translator.translator': 'deepseek' } }, () => {});
  assert.deepEqual(server.started.stages.map(p => [p.record.from, p.record.keep]),
    Array(3).fill(['translate', ['mask', 'bubbles']]));
});

test('"Re-run from…" redoes the step even with unchanged settings', async () => {
  await seed('84');
  useServer();
  await startTranslation('84', SETTINGS, () => {}, { forceFrom: 'translate' });
  assert.deepEqual(server.started.stages.map(p => [p.record.from, p.record.keep]), Array(3).fill(['translate', []]));
  await finish('84');
  useServer();
  await startTranslation('84', SETTINGS, () => {}, { forceFrom: 'inpaint' });
  assert.deepEqual(server.started.stages.map(p => p.record.from), ['mask', 'mask', 'mask'], 'inpainting redoes its mask');
});

test('a revert that keeps the snapshots lets translating again only render', async () => {
  await seed('85');
  await clearGalleryTranslations('85', { keepSnapshots: true });
  const rec = await dbGet('/85/1.webp');
  assert.equal(rec.translated, undefined);
  assert.ok(rec.pipeline?.regions?.length, 'pipeline data survives a revert');
  useServer();
  await startTranslation('85', SETTINGS, () => {});
  assert.deepEqual(server.started.stages.map(p => p.record.from), ['render', 'render', 'render']);
});

test('a text-less page is untouched by later steps, and its output comes back after a revert', async () => {
  await seed('86', { withData: false });
  useServer();
  await startTranslation('86', SETTINGS, () => {});
  await finish('86', { end: 'detect', lines: [], read: [] }, { study: false });
  useServer({ builds: { ...BUILDS, render: 'r2' } });
  const sent = [];
  await startTranslation('86', { ...SETTINGS, params: { ...SETTINGS.params, 'render.renderer': 'shiori_v2' } }, (m) => sent.push(m));
  assert.equal(server.started, null, 'nothing past detection applies to it');
  await clearGalleryTranslations('86', { keepSnapshots: true });
  useServer();
  await startTranslation('86', SETTINGS, () => {});
  assert.deepEqual(server.started.stages.map(p => p.record.from), ['render', 'render', 'render']);
});

test('a revert drops the snapshots unless they are kept; settings a page keeps stay', async () => {
  await seed('88');
  const [job] = Object.keys((await metaGet('88')).translations);
  await setPagesOwn(['/88/1.webp'], job);
  await revertGallery('88');
  const recs = await Promise.all([1, 2, 3].map(n => dbGet(`/88/${n}.webp`)));
  assert.ok(recs.every(r => r.pipeline === undefined && r.translated === undefined), 'nothing of the translation is left');
  assert.equal(recs[0].own, job);
  const meta = await metaGet('88');
  assert.equal(meta.translated, false);
  assert.deepEqual(Object.keys(meta.translations), [job], 'the page keeping its settings still refers to them');
  await seed('89');
  await revertGallery('89', { keepSnapshots: true });
  assert.ok((await dbGet('/89/1.webp')).pipeline?.regions?.length, 'kept when asked');
  assert.equal(Object.keys((await metaGet('89')).translations).length, 1);
});

test('pages translated before this format start over', async () => {
  await seed('87', { withData: false });
  await putTranslatedImage('/87/1.webp', new Blob(['old output']));
  useServer();
  await startTranslation('87', SETTINGS, () => {});
  assert.equal(server.started.images, 3);
  assert.deepEqual(server.started.stages, [null, null, null]);
});

test('translations no page comes from are dropped when a job finishes', async () => {
  await seed('88');
  const first = Object.keys((await metaGet('88')).translations);
  useServer({ builds: { ...BUILDS, render: 'r2' } });
  await startTranslation('88', { ...SETTINGS, params: { ...SETTINGS.params, 'render.renderer': 'shiori_v2' } }, () => {});
  await finish('88');
  const now = Object.keys((await metaGet('88')).translations);
  assert.equal(now.length, 1);
  assert.notDeepEqual(now, first);
});

test('a stale study frame never lands on a newer translation', async () => {
  await seed('89');
  const rec = await dbGet('/89/1.webp');
  await putTranslatedPage(rec.url, new Blob(['newer']), { ...rec.pipeline, job: 'newer' });
  await putPageStudy(rec.url, { bg: null, bubbles: [{ id: 0, box: [0, 0, 1, 1] }], page: null }, rec.pipeline.job);
  assert.equal((await dbGet(rec.url)).bubbles, undefined);
});

test('a server that can\'t describe its pipeline stops before uploading', async () => {
  await seed('90', { withData: false });
  useServer({ resolve: false });
  const sent = [];
  await startTranslation('90', SETTINGS, (m) => sent.push(m));
  assert.equal(server.started, null);
  assert.equal(sent.at(-1).status, 'error');
  assert.equal(await translateResume.get('90'), null);
});

test('a model the server no longer offers stops the job with a clear message', async () => {
  const trimmed = structuredClone(CAPS);
  const render = trimmed.stages.find(s => s.id === 'render');
  render.implementations = render.implementations.filter(i => i.id !== 'manga2eng');
  await seed('91', { withData: false });
  useServer({ caps: trimmed });
  const sent = [];
  await startTranslation('91', SETTINGS, (m) => sent.push(m));
  assert.equal(server.started, null);
  assert.equal(sent.at(-1).errorKey, 'err.model_unavailable');
  assert.equal(await translateResume.get('91'), null);
});

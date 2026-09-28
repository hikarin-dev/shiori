// per-page-translate.test.mjs — a page translated on its own keeps those settings: a gallery
// translation leaves it on them (its own job, queued after the gallery's pages), "Follow the
// gallery's settings" undoes that, the gallery's status comes from its pages, and a
// context-aware translator gets the pages before a mid-gallery job as context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const CAPS = JSON.parse(readFileSync(new URL('./fixtures/capabilities.json', import.meta.url), 'utf8'));
const S = 'http://127.0.0.1:5003';

const { dbPut, dbGet, metaPut, metaGet } = await import('../js/db.js');
const { startTranslation, pollTranslation, followGallerySettings } = await import('../js/translate.js');
const { translateResume, jobsPending } = await import('../js/platform.js');
const { migrateTranslateSettings } = await import('../js/translate-config.js');

const BASE = migrateTranslateSettings({ serverUrl: S });
const SETTINGS = { ...BASE, params: { ...BASE.params, 'translator.translator': 'sugoi', 'render.renderer': 'manga2eng' } };
const withTranslator = (translator) => ({ ...SETTINGS, params: { ...SETTINGS.params, 'translator.translator': translator } });
const FIELDS = { prepare: [], detect: [], ocr: [], merge: [], translate: ['translator.translator'], mask: [], inpaint: [],
  bubbles: [], render: ['render.renderer'] };
const BUILDS = { prepare: 'p', detect: 'd', ocr: 'o', merge: 'm', translate: 't', mask: 'k', inpaint: 'i', bubbles: 'b', render: 'r' };
const MASKS = { raw: new Uint8Array([82, 73, 70, 70, 1]), text: new Uint8Array([82, 73, 70, 70, 2]) };
const record = (tr) => ({ lines: [{ pts: [[0, 0], [9, 0], [9, 9], [0, 9]], score: 0.9, text: 'あ' }], read: [0],
  regions: [{ lines: [0], lang: 'ja', tr }], bubbles: [] });

function container(rec) {
  const head = new TextEncoder().encode(JSON.stringify({ ...rec, blobs: { raw: MASKS.raw.length, text: MASKS.text.length } }));
  const out = new Uint8Array(4 + head.length + MASKS.raw.length + MASKS.text.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4); out.set(MASKS.raw, 4 + head.length); out.set(MASKS.text, 4 + head.length + MASKS.raw.length);
  return out;
}
const frame = (status, data) => {
  const out = new Uint8Array(5 + data.length);
  out[0] = status; new DataView(out.buffer).setUint32(1, data.length); out.set(data, 5);
  return out;
};
const pageFrame = (status, token, idx, payload) => {
  const t = new TextEncoder().encode(token);
  const out = new Uint8Array(1 + t.length + 4 + payload.length);
  out[0] = t.length; out.set(t, 1); new DataView(out.buffer).setUint32(1 + t.length, idx); out.set(payload, 5 + t.length);
  return frame(status, out);
};

let server;
globalThis.fetch = async (url, init = {}) => {
  const reply = await server.routes[new URL(url).pathname]?.(init);
  return reply || new Response('not found', { status: 404 });
};
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function useServer({ builds = BUILDS, caps = CAPS } = {}) {
  server = { jobs: [], routes: {
    '/capabilities': () => json(caps),
    '/translate/gallery/resolve': (init) => json({ config: JSON.parse(init.body.get('config')), builds, fields: FIELDS, signature: 'sig' }),
    '/translate/gallery/start': async (init) => {
      const form = init.body;
      const job = { images: form.getAll('image').length, config: JSON.parse(form.get('config')), token: form.get('job_token'),
        context: form.get('context') ? JSON.parse(form.get('context')) : null };
      server.jobs.push(job);
      return json({ token: job.token, started: true });
    },
  } };
}
const lastJob = () => server.jobs.at(-1);

// The server finishes the job it last started; each page's translation names the translator.
async function finish(gid) {
  const { token, images, config } = lastJob();
  const parts = [frame(7, new TextEncoder().encode(JSON.stringify({ cursor: 0, status: 'done', done: images, total: images })))];
  for (let i = 0; i < images; i++) {
    parts.push(pageFrame(9, token, i, container(record(`by ${config.translator.translator}`))));
    parts.push(pageFrame(5, token, i, new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, i])));
  }
  parts.push(frame(0, new TextEncoder().encode(JSON.stringify({ count: images, failed: [] }))));
  server.routes['/translate/gallery/poll'] = () => new Response(new Uint8Array(parts.flatMap(p => [...p])));
  const sent = [];
  await pollTranslation(gid, (m) => sent.push(m));
  return sent;
}

async function seed(gid, pages = 3) {
  await metaPut({ galleryId: gid, numPages: pages, translated: false });
  for (let n = 1; n <= pages; n++) await dbPut(`/${gid}/${n}.webp`, new Blob([`original ${n}`]), gid, gid);
}
const url = (gid, n) => `/${gid}/${n}.webp`;
const pending = async (gid) => (await jobsPending.all()).find(e => e.key === `${gid}:translate`) || null;

test('a page translated on its own keeps its settings, and the gallery is partly translated', async () => {
  await seed('10');
  useServer();
  await startTranslation('10', withTranslator('deepseek'), () => {}, { pages: [url('10', 2)] });
  assert.equal(lastJob().images, 1, 'only that page is sent');
  assert.equal(lastJob().config.translator.translator, 'deepseek');
  await finish('10');
  const page = await dbGet(url('10', 2));
  const meta = await metaGet('10');
  assert.equal(page.own, page.pipeline.job, 'it keeps the settings of the translation that made it');
  assert.equal(meta.translated, 'partial', 'two pages are still untranslated');
  assert.deepEqual(Object.keys(meta.translations), [page.own]);
  assert.equal(await translateResume.get('10'), null);
});

test('a gallery translation leaves a kept page on its settings, in a job of its own after the rest', async () => {
  await seed('11');
  useServer();
  await startTranslation('11', withTranslator('deepseek'), () => {}, { pages: [url('11', 2)] });
  await finish('11');
  const kept = (await dbGet(url('11', 2))).own;

  useServer();
  await startTranslation('11', SETTINGS, () => {});
  assert.equal(lastJob().images, 2, 'pages 1 and 3 follow the current settings');
  assert.equal(lastJob().config.translator.translator, 'sugoi');
  const sent = await finish('11');
  assert.equal(sent.at(-1).status, 'started', 'the kept page is next, so it is not done yet');
  const next = await pending('11');
  assert.deepEqual(next.payload.after, [''], 'queued after the gallery’s own pages');

  // The kept page is current under its own settings: nothing to redo.
  await startTranslation('11', next.payload.settings, (m) => sent.push(m), next.payload);
  assert.equal(server.jobs.length, 1);
  assert.equal(sent.at(-1).status, 'done');
  const meta = await metaGet('11');
  assert.equal(meta.translated, true);
  assert.equal((await dbGet(url('11', 2))).own, kept);
  assert.equal((await dbGet(url('11', 2))).pipeline.regions[0].tr, 'by deepseek', 'still on its own translator');
  assert.equal(Object.keys(meta.translations).length, 2, 'the gallery’s translation and the kept one');
  await jobsPending.remove('11:translate');
});

test('a kept page is translated again with its own settings when its steps change', async () => {
  await seed('12');
  useServer();
  await startTranslation('12', withTranslator('deepseek'), () => {}, { pages: [url('12', 1)] });
  await finish('12');
  const first = (await dbGet(url('12', 1))).own;

  useServer({ builds: { ...BUILDS, render: 'r2' } });   // the server was updated
  await startTranslation('12', SETTINGS, () => {});
  assert.equal(lastJob().images, 2);
  await finish('12');
  const next = await pending('12');
  await startTranslation('12', next.payload.settings, () => {}, next.payload);
  assert.equal(lastJob().images, 1);
  assert.equal(lastJob().config.translator.translator, 'deepseek', 'its own translator, not the current one');
  await finish('12');
  const page = await dbGet(url('12', 1));
  assert.notEqual(page.own, first, 'it now keeps the new translation (same settings)');
  assert.equal(page.own, page.pipeline.job);
  assert.ok(!(first in (await metaGet('12')).translations), 'the old entry is gone once nothing refers to it');
  await jobsPending.remove('12:translate');
});

test('following the gallery’s settings again brings the page in line on the next translation', async () => {
  await seed('13');
  useServer();
  await startTranslation('13', withTranslator('deepseek'), () => {}, { pages: [url('13', 3)] });
  await finish('13');
  await followGallerySettings('13', [url('13', 3)]);
  assert.equal((await dbGet(url('13', 3))).own, undefined);
  useServer();
  await startTranslation('13', SETTINGS, () => {});
  assert.equal(lastJob().images, 3, 'every page, with the current settings');
  const sent = await finish('13');
  assert.equal(sent.at(-1).status, 'done', 'no kept pages are left to follow');
  assert.equal((await dbGet(url('13', 3))).pipeline.regions[0].tr, 'by sugoi');
  assert.equal(Object.keys((await metaGet('13')).translations).length, 1);
});

test('a context-aware translator gets the earlier pages when a job starts mid-gallery', async () => {
  await seed('14');
  useServer();
  await startTranslation('14', SETTINGS, () => {});
  await finish('14');
  // A context-aware translator this server can run.
  const caps = structuredClone(CAPS);
  caps.stages.find(s => s.id === 'translate').implementations.find(i => i.id === 'chatgpt').available = true;
  useServer({ caps });
  await startTranslation('14', withTranslator('chatgpt'), () => {}, { pages: [url('14', 3)] });
  assert.deepEqual(lastJob().context, [{ src: ['あ'], tr: ['by sugoi'] }, { src: ['あ'], tr: ['by sugoi'] }]);
  await finish('14');
  useServer();
  await startTranslation('14', withTranslator('sugoi'), () => {}, { pages: [url('14', 3)] });
  assert.equal(lastJob().context, null, 'a translator without context gets none');
});

test('asking for a page that is already current keeps it on those settings without a job', async () => {
  await seed('15');
  useServer();
  await startTranslation('15', SETTINGS, () => {});
  await finish('15');
  useServer();
  const sent = [];
  await startTranslation('15', SETTINGS, (m) => sent.push(m), { pages: [url('15', 1)] });
  assert.equal(server.jobs.length, 0);
  assert.equal(sent.at(-1).status, 'done');
  const page = await dbGet(url('15', 1));
  assert.equal(page.own, page.pipeline.job);
});

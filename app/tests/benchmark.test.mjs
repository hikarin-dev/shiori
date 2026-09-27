import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'fake-indexeddb/auto';
import { benchmarkCases, samplePages, parseBenchmarkFrames, benchmarkSummary, benchmarkCoverage } from '../js/benchmark-core.js';

const models = { detect: ['default'], ocr: ['hayai', 'mocr_fast', '48px', 'mocr'], translate: ['deepseek', 'sugoi'], inpaint: ['lama_large'], render: ['manga2eng', 'shiori', 'shiori_v2'] };
test('a controlled sweep changes one factor; the matrix covers all combinations', () => {
  const sweep = benchmarkCases(models);
  assert.equal(sweep.length, 7);
  assert.ok(sweep.slice(1).every(row => Object.keys(row).filter(k => row[k] !== sweep[0][k]).length === 1));
  const matrix = benchmarkCases(models, 'matrix');
  assert.equal(matrix.length, 24);
  assert.equal(new Set(matrix.map(JSON.stringify)).size, 24);
  assert.throws(() => benchmarkCases({ ...models, ocr: [] }), /Select/);
});
test('page sampling is deterministic, spread across the entire gallery, and has no duplicates', () => {
  const pages = Array.from({ length: 33 }, (_, i) => i + 1);
  const selected = samplePages(pages, 20);
  assert.equal(selected[0], 1); assert.equal(selected.at(-1), 33);
  assert.equal(new Set(selected).size, 20);
  assert.deepEqual(samplePages(pages, 20), selected);
});
const frame = (code, bytes) => {
  const out = new Uint8Array(5 + bytes.length); out[0] = code;
  new DataView(out.buffer).setUint32(1, bytes.length); out.set(bytes, 5); return out;
};
const jsonFrame = (code, value) => frame(code, new TextEncoder().encode(JSON.stringify(value)));
const pageFrame = (token, index) => {
  const t = new TextEncoder().encode(token), out = new Uint8Array(1 + t.length + 4 + 3);
  out[0] = t.length; out.set(t, 1); new DataView(out.buffer).setUint32(1 + t.length, index);
  return frame(5, out);
};
test('poll parsing retains identity, discards image bytes and rejects incomplete frames', () => {
  const page = pageFrame('job', 9);
  assert.deepEqual(parseBenchmarkFrames(page.buffer), [{ code: 5, token: 'job', index: 9, bytes: 3 }]);
  assert.throws(() => parseBenchmarkFrames(page.slice(0, -1).buffer), /Truncated/);
  assert.throws(() => parseBenchmarkFrames(new Uint8Array([7, 0]).buffer), /Truncated/);
});
test('summary excludes warmups, errors and competing jobs and weights throughput by pages', () => {
  const r = { caseIndex: 0, phase: 'measure', status: 'done', pageCount: 20, wallMs: 20000 };
  const report = { cases: [models], runs: [r, { ...r, pageCount: 40, wallMs: 80000 },
    { ...r, phase: 'warmup', wallMs: 999999 }, { ...r, status: 'failed' }, { ...r, contaminated: true }] };
  const [s] = benchmarkSummary(report);
  assert.equal(s.pages, 60); assert.equal(s.secondsPerPage, 100 / 60);
  assert.equal(s.excluded, 2); assert.equal(s.successful, 2);
});
test('comparison coverage catches a missing measured gallery despite identical input manifests', () => {
  const run = { caseIndex: 0, phase: 'measure', status: 'done', galleryId: 'small', pageCount: 20 };
  const complete = { runs: [run, { ...run, galleryId: 'large' }] };
  const partial = { runs: [run, { ...run, galleryId: 'large', contaminated: true }] };
  assert.notEqual(benchmarkCoverage(complete, 0), benchmarkCoverage(partial, 0));
  assert.equal(benchmarkCoverage(complete, 0), benchmarkCoverage({ runs: [...complete.runs].reverse() }, 0));
});

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const { dbPut, dbGet, putTranslatedImage } = await import('../js/db.js');
const { kv } = await import('../js/platform.js');
const { runBenchmark } = await import('../js/benchmark.js');
const caps = JSON.parse(readFileSync(new URL('./fixtures/capabilities.json', import.meta.url)));
const selectedModels = { detect: ['default'], ocr: ['48px'], translate: ['sugoi'], inpaint: ['lama_large'], render: ['manga2eng'] };
const json = data => new Response(JSON.stringify(data));

async function scenario(t, { rejectStart = false, abortAfterStart = false, pageCount = 20, hideAfterStart = false } = {}) {
  const realTimeout = globalThis.setTimeout, waits = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => { waits.push(ms); return realTimeout(fn, Math.min(ms, 1), ...args); });
  t.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_n, _o, fn) => fn({}) } });
  globalThis.createImageBitmap = async () => ({ width: 720, height: 1400, close() {} });
  const id = String(Math.random()), urls = [];
  for (let i = 1; i <= pageCount; i++) { const url = `/${id}/${i}.png`; urls.push(url); await dbPut(url, new Blob(['original']), id, id); }
  await putTranslatedImage(urls[0], new Blob(['saved translation']));
  await kv.set({ translateSettings: { schema: 2, params: {}, serverToken: 'secret-test-token' } });
  const controller = new AbortController(), starts = [], cancels = [], calls = [];
  let token, count;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = new URL(url).pathname; calls.push(path);
    if (path === '/capabilities') return json(caps);
    if (path === '/benchmark/info') return json({ api_version: 1, limits: {}, queue: { live_jobs: 0, uploads_pending: 0 }, workers: { busy: 0 }, uptime_s: 1 });
    if (path === '/translate/gallery/resolve') return json({ config: JSON.parse(init.body.get('config')), signature: 'build', builds: {} });
    if (path === '/benchmark/gallery/start') {
      starts.push(init.body);
      if (rejectStart) return new Response('hourly limit', { status: 429, headers: { 'Retry-After': '300' } });
      token = init.body.get('job_token'); count = init.body.getAll('image').length;
      if (abortAfterStart) controller.abort();
      if (hideAfterStart) { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }
      return json({ token });
    }
    if (path === '/benchmark/gallery/cancel') { cancels.push(init.body.get('job_token')); return json({ cancelling: true }); }
    if (path === '/benchmark/gallery/poll') {
      const chunks = [jsonFrame(7, { cursor: count, status: 'done' }), ...Array.from({ length: count }, (_, i) => pageFrame(token, i)),
        jsonFrame(0, { count, failed: [], benchmark: { stages_s: { ocr: 2 }, model_loads: [], chunk_metrics: [{ model_loads: [] }] } })];
      return new Response(new Uint8Array(chunks.flatMap(x => [...x])));
    }
    throw new Error(path);
  });
  const report = await runBenchmark({ galleryIds: [id], models: selectedModels, cooldownSeconds: 1 }, { signal: controller.signal });
  assert.equal(await (await dbGet(urls[0])).translated.text(), 'saved translation');
  assert.equal(JSON.stringify(report).includes('secret-test-token'), false);
  assert.ok(calls.every(p => p !== '/translate/gallery/start' && p !== '/stats'));
  return { report, starts, cancels, token, waits };
}
test('browser experiment warms then measures original pages without mutating saved output', async t => {
  const { report, starts, waits } = await scenario(t);
  assert.equal(report.status, 'done'); assert.deepEqual(starts.map(f => f.getAll('image').length), [3, 20]);
  assert.ok(starts.every(f => f.getAll('stage').length === 0));
  assert.deepEqual(report.runs.map(r => r.phase), ['warmup', 'measure']);
  assert.ok(waits.includes(2000));
  assert.equal(report.galleries[0].pages.length, 20);
});
test('rate limiting stops the experiment with Retry-After recorded instead of hammering retries', async t => {
  const { report, starts, cancels } = await scenario(t, { rejectStart: true });
  assert.equal(report.status, 'failed'); assert.equal(starts.length, 1); assert.equal(cancels.length, 1);
  assert.equal(report.runs[0].httpStatus, 429); assert.equal(report.runs[0].retryAfter, '300');
});
test('cancellation after admission cancels only the benchmark token and preserves a partial report', async t => {
  const { report, cancels, token } = await scenario(t, { abortAfterStart: true });
  assert.equal(report.status, 'cancelled'); assert.deepEqual(cancels, [token]);
  assert.equal(report.runs[0].status, 'cancelled');
});
test('a one-page gallery still uploads a nonempty warm-up', async t => {
  const { report, starts } = await scenario(t, { pageCount: 1 });
  assert.equal(report.status, 'done');
  assert.deepEqual(starts.map(f => f.getAll('image').length), [1, 1]);
});
test('hiding the tab cancels its active job before background timers can distort results', async t => {
  const previous = globalThis.document;
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  try {
    const { report, cancels, token } = await scenario(t, { hideAfterStart: true });
    assert.equal(report.status, 'cancelled');
    assert.match(report.error, /tab visible/);
    assert.deepEqual(cancels, [token]);
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

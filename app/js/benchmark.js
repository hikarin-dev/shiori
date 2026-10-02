import * as api from './api.js';
import { imageToBlob } from './image-util.js';
import { kv, jobsPending, translateResume } from './platform.js';
import { pickTitle } from './titles.js';
import { buildConfig, migrateTranslateSettings, batchCap, stageOf } from './translate-config.js';
import { BENCHMARK_LOCK, MODEL_STAGES, benchmarkCases, samplePages, parseBenchmarkFrames, benchmarkSummary, distribution } from './benchmark-core.js';

export const DEFAULT_MODELS = { detect: ['default'], ocr: ['hayai', 'mocr_fast', '48px', 'mocr'],
  translate: ['deepseek', 'sugoi'], inpaint: ['lama_large'], render: ['manga2eng', 'shiori', 'shiori_v2'] };
const REPORT_KEY = 'translationBenchmarkReport';
const PACING_KEY = 'translationBenchmarkStarts';
const check = signal => signal?.throwIfAborted();
const now = () => performance.now();
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  check(signal);
  const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(finish, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Cancelled', 'AbortError')); };
  signal?.addEventListener('abort', abort, { once: true });
});

// Every standalone gallery with stored pages — no series or their chapters — smallest typical page
// first (page-size.js); not yet measured last.
export async function benchmarkGalleries() {
  const galleries = await api.galleries.page({ sort: 'id', limit: Infinity, merge: false });
  return galleries.filter(g => g.count > 0 && !g.parentId && !g.isSeries)
    .map(g => ({ id: g.id, title: pickTitle(g, 'en') || g.id, pages: g.count, bytes: g.origSize, page: g.medianPage }))
    .sort((a, b) => (a.page?.mp ?? Infinity) - (b.page?.mp ?? Infinity) || a.title.localeCompare(b.title));
}

export async function benchmarkSettings() {
  return migrateTranslateSettings((await kv.get('translateSettings')).translateSettings);
}

export async function benchmarkCapabilities(settings) {
  const url = (settings.serverUrl || 'http://127.0.0.1:5003').replace(/\/+$/, '');
  const headers = settings.serverToken ? { 'X-Access-Token': settings.serverToken } : {};
  const response = await fetch(url + '/capabilities', { headers, cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Cannot read server capabilities (${response.status})`);
  return response.json();
}

export async function inspectBenchmarkGallery(id, { limit = 0, signal } = {}) {
  const keys = await api.pages.list(id);
  if (!keys.length) throw new Error(`Gallery ${id} has no stored pages`);
  const pages = [];
  for (const key of samplePages(keys, limit)) {
    check(signal);
    const rec = await api.pages.get(id, key.pageNum);
    const blob = await imageToBlob(rec?.blob ?? rec?.dataUrl);
    if (!blob) throw new Error(`Gallery ${id}, page ${key.pageNum}: original missing`);
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width, height = bitmap.height;
    bitmap.close();
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    pages.push({ page: key.pageNum, width, height, bytes: blob.size,
      sha256: [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('') });
  }
  return { id: String(id), storedPages: keys.length, pages,
    megapixels: distribution(pages.map(p => p.width * p.height / 1e6)),
    bytes: pages.reduce((n, p) => n + p.bytes, 0) };
}

export async function lastBenchmarkReport() { return (await kv.get(REPORT_KEY))[REPORT_KEY] || null; }

// Exported browser API: automation and the Settings card run exactly the same experiment.
export async function runBenchmark(options, { signal, onProgress = () => {}, onReport = () => {} } = {}) {
  if (!navigator.locks) throw new Error('Benchmark isolation requires browser Web Locks');
  return navigator.locks.request(BENCHMARK_LOCK, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('A benchmark is already running in another tab');
    const visibility = new AbortController();
    const visible = () => {
      if (globalThis.document?.visibilityState === 'hidden') visibility.abort(new Error('Keep the benchmark tab visible. Background timer throttling invalidates timings; the current job was cancelled.'));
    };
    globalThis.document?.addEventListener('visibilitychange', visible);
    visible();
    try {
      return await executeBenchmark(options, { signal: signal ? AbortSignal.any([signal, visibility.signal]) : visibility.signal, onProgress, onReport });
    } finally { globalThis.document?.removeEventListener('visibilitychange', visible); }
  });
}

async function executeBenchmark(options, { signal, onProgress, onReport }) {
  const settings = await benchmarkSettings();
  if (options.serverUrl) {
    // An imported experiment must never forward saved credentials to a different server.
    if (new URL(options.serverUrl).origin !== new URL(settings.serverUrl || 'http://127.0.0.1:5003').origin) settings.serverToken = '';
    settings.serverUrl = options.serverUrl;
  }
  const caps = await benchmarkCapabilities(settings);
  const url = (settings.serverUrl || 'http://127.0.0.1:5003').replace(/\/+$/, '');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  const opts = { mode: 'sweep', repeats: 1, pageLimit: 0, warmupPages: 3, cooldownSeconds: 10,
    minStartIntervalSeconds: local ? 0 : 310, timeoutMinutes: 30, ...options };
  for (const [key, min, max] of [['repeats', 1, 20], ['pageLimit', 0, 10000], ['warmupPages', 1, 20],
    ['cooldownSeconds', 1, 3600], ['minStartIntervalSeconds', 0, 86400], ['timeoutMinutes', 1, 240]]) {
    if (!Number.isInteger(opts[key]) || opts[key] < min || opts[key] > max) throw new Error(`Invalid ${key}`);
  }
  opts.galleryIds = [...new Set((opts.galleryIds || []).map(String))];
  if (!opts.galleryIds.length) throw new Error('Select a gallery');
  const cases = benchmarkCases(opts.models || DEFAULT_MODELS, opts.mode);
  for (const models of cases) for (const stage of MODEL_STAGES) {
    const impl = stageOf(caps, stage)?.implementations.find(i => i.id === models[stage]);
    if (!impl?.available) throw new Error(`${stage}: ${models[stage]} is unavailable`);
  }
  const headers = settings.serverToken ? { 'X-Access-Token': settings.serverToken } : {};
  const report = { schema: 'shiori-benchmark/1', startedAt: new Date().toISOString(), status: 'running',
    options: { ...opts, models: opts.models || DEFAULT_MODELS }, cases, galleries: [], runs: [],
    environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
      server: new URL(url).origin, capabilitiesEtag: caps.etag, apiVersion: caps.api_version },
    methodology: { warmup: 'Separate unmeasured warm-up before each case and gallery; initial model residency unknown.',
      timing: 'Browser upload-to-terminal wall time includes polling, transfers and server queues. Warm-ups and pacing excluded.',
      stages: 'Server cumulative stage seconds overlap; substage values are nested. They must not be summed into wall time.',
      images: 'Original bytes, full pipeline, no reuse, no resizing; outputs discarded. Input hashes identify the corpus.',
      telemetry: 'Dedicated benchmark endpoint returns only this job’s detailed metrics; missing fields are unknown, never zero.',
      isolation: 'One job at a time, idle checks, same-origin benchmark lock; concurrent external work invalidates measurements.' } };
  let activeToken = null, lastFinish = 0, lastStart = 0;
  const persist = async () => { report.summary = benchmarkSummary(report); await kv.set({ [REPORT_KEY]: report }); onReport(report); };
  const progress = message => onProgress({ message, runs: report.runs.length, report });
  const request = async (path, body, { cleanup = false } = {}) => {
    const timeout = AbortSignal.timeout(120000);
    const response = await fetch(url + path, { method: body ? 'POST' : 'GET', body, headers, cache: 'no-store',
      signal: cleanup || !signal ? timeout : AbortSignal.any([signal, timeout]) });
    if (!response.ok) {
      if (path === '/benchmark/info' && response.status === 404) throw new Error('Benchmark API unavailable. Update or restart the translation server to load benchmark support.');
      const error = new Error(`Server ${response.status}: ${(await response.text()).slice(0, 200)}`);
      error.status = response.status;
      error.retryAfter = response.headers.get('Retry-After');
      throw error;
    }
    return response;
  };
  const form = values => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.append(k, String(v)); return f; };
  const stats = async () => (await request('/benchmark/info')).json();
  const cancel = async () => {
    if (activeToken) await request('/benchmark/gallery/cancel', form({ job_token: activeToken }), { cleanup: true });
    activeToken = null;
  };
  const idle = s => s.queue?.live_jobs === 0 && s.queue?.uploads_pending === 0 && s.workers?.busy === 0;
  const waitIdle = async () => {
    const deadline = Date.now() + opts.timeoutMinutes * 60000;
    let clean = 0, s;
    while (clean < 2) {
      check(signal);
      const pending = await jobsPending.all(), resumed = await translateResume.all();
      s = await stats();
      if (idle(s) && !pending.some(j => j.kind === 'translate') && !resumed.length) clean++;
      else { clean = 0; progress('Waiting for translation work to finish'); }
      if (Date.now() > deadline) throw new Error('Server did not become idle');
      if (clean < 2) await sleep(2000, signal);
    }
    return s;
  };
  const pace = async () => {
    const stored = (await kv.get(PACING_KEY))[PACING_KEY] || {};
    const earliest = Math.max(lastFinish + opts.cooldownSeconds * 1000,
      Math.max(lastStart, stored[url] || 0) + opts.minStartIntervalSeconds * 1000);
    if (earliest > Date.now()) { progress('Cooling down / respecting job start interval'); await sleep(earliest - Date.now(), signal); }
  };
  const run = async (caseIndex, gallery, phase, repetition, resolved, config) => {
    await pace();
    const before = await waitIdle();
    const stored = new Set((await api.pages.list(gallery.id)).map(k => k.pageNum));
    // Warm a few interior pages; a cover alone may never exercise OCR or rendering.
    const interior = gallery.pages.length > 2 ? gallery.pages.slice(1, -1) : gallery.pages;
    const selected = phase === 'warmup' ? samplePages(interior, opts.warmupPages) : gallery.pages;
    const entry = { caseIndex, galleryId: gallery.id, phase, repetition, pageCount: selected.length,
      startedAt: new Date().toISOString(), status: 'running', config, effectiveConfig: resolved.config, builds: resolved.builds,
      batchSize: batchCap(caps, cases[caseIndex].translate, settings.batchCaps), capture: settings.saveSnapshots !== false,
      warmState: phase === 'warmup' ? 'unknown' : 'primed; residency not independently verified',
      before: { gpu: before.gpu, workers: before.workers, uptimeSeconds: before.uptime_s },
      pageArrivals: [], requests: { upload: 0, poll: 0, bytesReceived: 0 }, contaminated: false };
    report.runs.push(entry);
    await persist();
    progress(`${phase === 'warmup' ? 'Warming' : 'Measuring'} case ${caseIndex + 1}/${cases.length}, gallery ${gallery.id}, ${selected.length} pages`);
    const prepStart = now(), blobs = [];
    for (const page of selected) {
      check(signal);
      const rec = stored.has(page.page) ? await api.pages.get(gallery.id, page.page) : null;
      const blob = await imageToBlob(rec?.blob ?? rec?.dataUrl);
      if (!blob || blob.size !== page.bytes) throw new Error('Corpus changed during benchmark');
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      if ([...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('') !== page.sha256) throw new Error('Corpus changed during benchmark');
      if (report.environment.policy.max_page_bytes && blob.size > report.environment.policy.max_page_bytes) throw new Error('An original exceeds the server page limit; use a local server to preserve resolution');
      blobs.push(blob);
    }
    if (report.environment.policy.max_pages && blobs.length > report.environment.policy.max_pages) throw new Error('Gallery exceeds the server page limit');
    entry.inputReadMs = now() - prepStart;
    const parts = [[]]; let partBytes = 0;
    for (const blob of blobs) {
      const partCap = Math.min(64 * 1024 * 1024, (report.environment.policy.max_body_bytes || Infinity) * .8);
      if (partBytes && partBytes + blob.size > partCap) { parts.push([]); partBytes = 0; }
      parts.at(-1).push(blob); partBytes += blob.size;
    }
    activeToken = crypto.randomUUID().replaceAll('-', '');
    entry.token = activeToken;
    const start = now();
    try {
      lastStart = Date.now();
      const starts = (await kv.get(PACING_KEY))[PACING_KEY] || {};
      await kv.set({ [PACING_KEY]: { ...starts, [url]: lastStart } });
      for (let part = 0; part < parts.length; part++) {
        const body = form({ config: JSON.stringify(config), builds: resolved.signature, capture: entry.capture ? '1' : '0',
          batch_size: entry.batchSize, job_token: activeToken, part, parts: parts.length });
        for (const blob of parts[part]) body.append('image', blob, 'page.png');
        entry.requests.upload++;
        const result = await (await request('/benchmark/gallery/start', body)).json();
        if (result.token !== activeToken) throw new Error('Server returned a different job token');
      }
      entry.uploadMs = now() - start;
      let cursor = 0, terminal = false, lastStats = 0, lastPollAt = now();
      const seen = new Set(), deadline = Date.now() + opts.timeoutMinutes * 60000;
      while (!terminal) {
        await sleep(2000, signal);
        const gap = now() - lastPollAt;
        entry.maxPollGapMs = Math.max(entry.maxPollGapMs || 0, gap);
        lastPollAt = now();
        if (gap > 10000) {
          entry.contaminated = true;
          throw new Error('Polling was delayed more than 10 seconds; stopping to exclude distorted browser timings');
        }
        if (Date.now() > deadline) throw new Error('Benchmark job timed out');
        const poll = await request('/benchmark/gallery/poll', form({ job_token: activeToken, since: cursor }));
        const buffer = await poll.arrayBuffer();
        entry.requests.poll++; entry.requests.bytesReceived += buffer.byteLength;
        for (const frame of parseBenchmarkFrames(buffer)) {
          if (frame.code === 7) {
            cursor = frame.value.cursor;
            if (frame.value.queue > 0) entry.contaminated = true;
            if (['error', 'cancelled', 'notfound'].includes(frame.value.status)) throw new Error(`Job ${frame.value.status}`);
          } else if (frame.code === 2) throw new Error(frame.value);
          else if (frame.code === 0) { terminal = true; entry.result = frame.value; }
          else if (frame.code === 5 && !seen.has(frame.index)) {
            if (frame.token !== activeToken || frame.index >= selected.length) throw new Error('Unexpected benchmark page identity');
            seen.add(frame.index);
            entry.pageArrivals.push({ index: frame.index, page: selected[frame.index]?.page, atMs: now() - start, bytes: frame.bytes });
          }
        }
        if (Date.now() - lastStats >= 10000 && !terminal) {
          const current = await stats(); lastStats = Date.now();
          if (current.queue?.live_jobs > 1 || current.queue?.uploads_pending > 0 || current.uptime_s < before.uptime_s) entry.contaminated = true;
        }
        progress(`${phase}: case ${caseIndex + 1}/${cases.length}, gallery ${gallery.id} — ${seen.size}/${selected.length} pages`);
      }
      entry.wallMs = now() - start;
      entry.telemetry = entry.result?.benchmark;
      if (!entry.telemetry) throw new Error('Server returned no benchmark metrics');
      delete entry.result.benchmark;
      entry.warmState = entry.telemetry.model_loads?.length ? 'model loads observed (see timings)' : 'no ModelWrapper loads observed; lazy initialization unverified';
      if (entry.telemetry.chunk_metrics?.some(c => !('model_loads' in c))) entry.warmState = 'worker lacks model-load instrumentation';
      entry.status = entry.result?.failed?.length || seen.size !== selected.length ? 'failed' : 'done';
      entry.firstPageMs = entry.pageArrivals[0]?.atMs ?? null;
      entry.lastPageMs = entry.pageArrivals.at(-1)?.atMs ?? null;
      activeToken = null;
      if (entry.status !== 'done') throw new Error('Some benchmark pages failed; stopping to preserve comparability');
    } catch (error) {
      entry.status = signal?.aborted ? 'cancelled' : 'failed';
      entry.error = error.message;
      entry.httpStatus = error.status;
      entry.retryAfter = error.retryAfter;
      entry.wallMs = now() - start;
      throw error;
    } finally { lastFinish = Date.now(); await persist(); }
  };
  try {
    const info = await stats();
    if (info.api_version !== 1) throw new Error('Update the server to use the benchmark API');
    report.environment.policy = info.limits;
    if (info.limits.starts_per_hour) opts.minStartIntervalSeconds = Math.max(opts.minStartIntervalSeconds, Math.ceil(3600 / info.limits.starts_per_hour) + 10);
    report.options.minStartIntervalSeconds = opts.minStartIntervalSeconds;
    report.environment.initial = await waitIdle().then(s => ({ gpu: s.gpu, workers: s.workers, uptimeSeconds: s.uptime_s }));
    for (const id of opts.galleryIds) {
      progress(`Reading dimensions and hashing gallery ${id}`);
      report.galleries.push(await inspectBenchmarkGallery(id, { limit: opts.pageLimit, signal }));
    }
    await persist();
    for (let ci = 0; ci < cases.length; ci++) {
      const params = { ...settings.params };
      for (const stage of MODEL_STAGES) params[stageOf(caps, stage).implementation_param] = cases[ci][stage];
      params['translator.target_lang'] = 'ENG';
      const config = buildConfig({ ...settings, params }, caps);
      const resolved = await (await request('/translate/gallery/resolve', form({ config: JSON.stringify(config) }))).json();
      // Rotate gallery order between cases to reduce systematic order effects.
      const galleries = report.galleries.map((_, i, all) => all[(i + ci) % all.length]);
      for (const gallery of galleries) {
        await run(ci, gallery, 'warmup', 0, resolved, config);
        for (let repetition = 1; repetition <= opts.repeats; repetition++) await run(ci, gallery, 'measure', repetition, resolved, config);
      }
    }
    report.status = 'done';
  } catch (error) {
    report.status = signal?.aborted ? 'cancelled' : 'failed'; report.error = error.message;
    for (const r of report.runs) if (r.status === 'running') { r.status = report.status; r.error = error.message; }
    try { await cancel(); } catch (cleanup) { report.cleanupError = cleanup.message; }
  } finally {
    report.finishedAt = new Date().toISOString(); await persist();
  }
  return report;
}

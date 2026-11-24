// benchmark-view.test.mjs — what Settings' benchmark card and its report say (app/js/benchmark-view.js),
// held against 1.3's own code: the report as 1.3's showBenchmarkReport drew it (copied verbatim below,
// over a stand-in document) says, word for word and in its order, what the view says (Settings' report,
// src/routes/settings/benchmark.tsx, draws the view), for reports with and without errors, telemetry
// and a comparison; the card's rules
// (the plan, the estimate, the server it loads from, the models offered, an imported plan, the
// picker's groups, meta and filter) as 1.3 worked them out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };

// A stand-in document: elements that hold what the report sets on them, serialisable.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.className = ''; this.id = ''; }
  append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'string' ? { text: n } : n); }
  set textContent(v) { this.children = [{ text: String(v) }]; }
  get textContent() { return this.children.map((c) => c.text ?? c.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener() {}
  showModal() {}
  close() {}
  remove() {}
  get shape() {
    const own = { tag: this.tag, class: this.className, id: this.id, attrs: this.attrs, dataset: this.dataset };
    if (this.tag === 'meter') Object.assign(own, { min: this.min, max: this.max, value: this.value });
    if (this.tag === 'button') own.type = this.type;
    return { ...own, children: this.children.map((c) => (c instanceof Element ? c.shape : c)) };
  }
}
const { reportView, isBenchmarkReport, reportFileName, PLAN_FILE_NAME, number, RECOMMENDED_PAGES, tierRange, galleryMeta, galleryGroups, tierCounts,
  galleryHidden, tierFilterText, benchmarkPlan, selectedText, estimateText, benchmarkServerSettings, defaultStartInterval, modelGroups, planFields,
  finishedText, MODES, NUMBERS } = await import('../js/benchmark-view.js');
const { MODEL_STAGES, benchmarkSummary, benchmarkCoverage } = await import('../js/benchmark-core.js');
const { TIERS } = await import('../js/page-size.js');
const { formatBytes, formatCount, formatMegapixels } = await import('../js/format.js');
// (Set once the modules are in: some look for a document as they load.)
const body = new Element('body');
globalThis.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => ({ text }), body, documentElement: { lang: 'en' } };

const CAPS = JSON.parse(readFileSync(new URL('./fixtures/capabilities.json', import.meta.url), 'utf8'));

// ── 1.3's report, verbatim (benchmark-ui.js at a7af098) ──────────────────────────────────────────
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const oldNumber = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const button = (label, action, className = 'btn-mini') => { const b = el('button', label, className); b.type = 'button'; b.onclick = action; return b; };
function table(headers, rows) {
  const wrap = el('div', null, 'benchmark-table-wrap'), t = el('table');
  const head = el('thead'), tr = el('tr'); headers.forEach(h => tr.append(el('th', h))); head.append(tr); t.append(head);
  const body = el('tbody');
  for (const row of rows) { const r = el('tr'); for (const cell of row) r.append(el('td', cell)); body.append(r); }
  t.append(body); wrap.append(t); return wrap;
}
function oldShowBenchmarkReport(report, comparison = null) {
  const number = oldNumber;
  const dialog = el('dialog', null, 'benchmark-dialog'); dialog.setAttribute('aria-labelledby', 'benchmarkReportTitle');
  const header = el('div', null, 'benchmark-dialog-header'), title = el('h2', 'Translation benchmark'); title.id = 'benchmarkReportTitle';
  header.append(title, button('Close', () => dialog.close(), 'btn')); dialog.append(header);
  dialog.append(el('p', `${report.status} · ${report.startedAt} · ${report.runs.length} runs including warm-ups`));
  const actions = el('div', null, 'benchmark-actions');
  actions.append(button('Export JSON', () => {}, 'btn'), button('Compare JSON…', async () => {}, 'btn'));
  dialog.append(actions);
  if (report.error) dialog.append(el('p', report.error, 'benchmark-error'));
  dialog.append(el('p', 'Warm-ups, failed runs and runs affected by competing work or delayed polling are excluded from the summary. Stage times overlap and include nested substages; they do not add up to elapsed time. Missing telemetry is shown as unknown. Job percentiles span the selected galleries and repeats; they are not confidence intervals.'));
  const summaries = benchmarkSummary(report);
  const maximum = Math.max(1, ...summaries.map(s => s.secondsPerPage || 0));
  const charts = el('div', null, 'benchmark-chart');
  for (const s of summaries) {
    const row = el('div', null, 'benchmark-chart-row');
    const label = Object.values(s.models).join(' / ');
    const meter = el('meter'); meter.min = 0; meter.max = maximum; meter.value = s.secondsPerPage || 0;
    meter.setAttribute('aria-label', label + ' seconds per page');
    row.append(el('span', `#${s.caseIndex + 1} ${label}`), meter, el('strong', `${number(s.secondsPerPage)} s/page`)); charts.append(row);
  }
  dialog.append(charts);
  dialog.append(table(['Case', 'Measured / excluded', 'Pages', 's/page', 'Pages/min', 'Median job s', 'P95 job s'], summaries.map(s =>
    [s.caseIndex + 1, `${s.successful} / ${s.excluded}`, s.pages, number(s.secondsPerPage), number(s.pagesPerMinute), number(s.wallSeconds?.median), number(s.wallSeconds?.p95)])));
  if (comparison) {
    dialog.append(el('h3', `Comparison with ${comparison.startedAt}`));
    const other = benchmarkSummary(comparison);
    const corpus = r => JSON.stringify(r.galleries.map(g => ({ id: g.id, pages: g.pages })).sort((a, b) => a.id.localeCompare(b.id)));
    const sameCorpus = corpus(report) === corpus(comparison);
    dialog.append(el('p', sameCorpus ? 'Input manifests match. Compare effective settings, worker count and warm-up policy below before attributing differences to code changes.' : 'The input manifests differ. These results are not a controlled before/after comparison.', sameCorpus ? '' : 'benchmark-error'));
    dialog.append(table(['Models', 'Current s/page', 'Imported s/page', 'Change'], summaries.map(s => {
      const match = other.find(o => MODEL_STAGES.every(k => o.models[k] === s.models[k]));
      const sameCoverage = match && benchmarkCoverage(report, s.caseIndex) === benchmarkCoverage(comparison, match.caseIndex);
      const delta = sameCorpus && sameCoverage && s.secondsPerPage && match?.secondsPerPage ? (s.secondsPerPage / match.secondsPerPage - 1) * 100 : null;
      const change = !sameCorpus ? 'Inputs differ' : match && !sameCoverage ? 'Measured coverage differs' : delta == null ? '—' : `${number(delta, 1)}%`;
      return [Object.values(s.models).join(' / '), number(s.secondsPerPage), number(match?.secondsPerPage), change];
    })));
  }
  dialog.append(el('h3', 'Corpus'));
  dialog.append(table(['Gallery', 'Stored / tested pages', 'Median MP', 'Min–max MP', 'Original MiB'], report.galleries.map(g =>
    [g.id, `${g.storedPages} / ${g.pages.length}`, number(g.megapixels?.median), `${number(g.megapixels?.min)}–${number(g.megapixels?.max)}`, number(g.bytes / 1048576)])));
  dialog.append(el('h3', 'Stage work per measured page'));
  const stageNames = [...new Set(summaries.flatMap(s => Object.keys(s.stagesSecondsPerPage)))];
  dialog.append(table(['Stage (seconds)', ...summaries.map(s => `#${s.caseIndex + 1}`)], stageNames.map(stage =>
    [stage, ...summaries.map(s => number(s.stagesSecondsPerPage[stage], 3))])));
  dialog.append(el('h3', 'Individual runs'));
  for (const r of report.runs) {
    const detail = el('details');
    detail.append(el('summary', `#${r.caseIndex + 1} · ${r.galleryId} · ${r.phase} ${r.repetition || ''} · ${r.status}${r.contaminated ? ' · timing affected' : ''} · ${number(r.wallMs / 1000)} s`));
    detail.append(table(['Metric', 'Value'], [
      ['Pages', r.pageCount], ['Model state', r.warmState], ['Input read (s)', number(r.inputReadMs / 1000)],
      ['Upload (s)', number(r.uploadMs / 1000)], ['First page received (s)', number(r.firstPageMs == null ? null : r.firstPageMs / 1000)],
      ['Server wall (s)', number(r.telemetry?.wall_s)], ['GPU peak (%)', number(r.telemetry?.gpu_max_pct, 0)],
      ['Observed model loading (s)', number(r.telemetry?.model_load_s, 4)],
      ['GPU average (%)', number(r.telemetry?.gpu_avg_pct, 1)], ['CPU average (%)', number(r.telemetry?.cpu_avg_pct, 1)],
      ['VRAM peak (MiB)', number(r.telemetry?.vram_max_mb, 0)], ['LLM requests', r.telemetry?.llm_requests ?? '—'],
      ['Estimated LLM cost (USD)', number(r.telemetry?.llm_cost_usd, 4)], ['Polling requests', r.requests?.poll ?? '—'],
      ['Longest poll interval (s)', number(r.maxPollGapMs == null ? null : r.maxPollGapMs / 1000)],
      ['Downloaded MiB', number((r.requests?.bytesReceived || 0) / 1048576)],
    ]));
    if (r.telemetry?.model_loads?.length) detail.append(table(['Model loaded', 'Chunk', 'Start in chunk (s)', 'Load await (s)'],
      r.telemetry.model_loads.map(m => [m.model, m.chunk, number(m.at_s), number(m.seconds, 4)])));
    if (r.telemetry?.waits_s) {
      detail.append(table(['Worker waiting for upstream work', 'Cumulative seconds'], Object.entries(r.telemetry.waits_s).map(([k, v]) => [k, number(v)])));
      detail.append(el('p', 'These counters measure workers awaiting queue input, not how long pages remain queued.'));
    }
    detail.append(el('p', 'Page timestamps are receipt times with 2-second polling granularity, not per-page compute latency.'));
    detail.append(table(['Page', 'Received at (s)', 'Page-frame KiB'], (r.pageArrivals || []).map(p => [p.page, number(p.atMs / 1000), number(p.bytes / 1024)])));
    detail.append(el('p', 'Page frames can be empty when Study data carries the result. Downloaded MiB above includes all frames.'));
    const raw = el('pre', JSON.stringify(r, null, 2)); detail.append(raw); dialog.append(detail);
  }
  const environment = el('details'); environment.append(el('summary', 'Method, environment and reproducible plan'),
    el('pre', JSON.stringify({ methodology: report.methodology, environment: report.environment, options: report.options }, null, 2)));
  dialog.append(environment);
  return dialog;
}

// Reports of every shape the report draws: done, failed with an error, two cases (one excluded run, one
// timing affected), telemetry with model loads and queue waits, and none.
const models = (ocr) => ({ detect: 'default', ocr, translate: 'sugoi', inpaint: 'lama_large', render: 'manga2eng' });
const run = (over) => ({ caseIndex: 0, galleryId: '17', phase: 'measure', repetition: 1, status: 'done', pageCount: 20, wallMs: 40000,
  inputReadMs: 120, uploadMs: 900, firstPageMs: 4100, warmState: 'primed', requests: { poll: 9, bytesReceived: 3 * 1048576 }, maxPollGapMs: 2100,
  pageArrivals: [{ page: 1, atMs: 4100, bytes: 2048 }, { page: 2, atMs: 6200, bytes: 0 }],
  telemetry: { wall_s: 38.2, gpu_max_pct: 97, gpu_avg_pct: 71.4, cpu_avg_pct: 22.1, vram_max_mb: 9123.4, llm_requests: 3, llm_cost_usd: 0.0123, model_load_s: 1.23456,
    stages_s: { ocr: 4.2, detect: 2.1 }, model_loads: [{ model: 'ocr', chunk: 0, at_s: 0.5, seconds: 1.23456 }], waits_s: { ocr: 3.25 } }, ...over });
const gallery = (id, pages) => ({ id, storedPages: pages, pages: Array.from({ length: pages }, (_, i) => ({ page: i + 1 })), megapixels: { median: 1.8, min: 1.2, max: 2.6 }, bytes: 5 * 1048576 });
const REPORT = { schema: 'shiori-benchmark/1', startedAt: '2026-11-20T10:00:00.000Z', status: 'done', cases: [models('48px'), models('hayai')],
  galleries: [gallery('17', 20), gallery('9', 31)], options: { mode: 'sweep' }, environment: { server: 'http://127.0.0.1:5003' }, methodology: { warmup: 'w' },
  runs: [run({ phase: 'warmup', repetition: 0 }), run({}), run({ galleryId: '9', pageCount: 31, wallMs: 50000 }), run({ caseIndex: 1, wallMs: 30000, telemetry: { stages_s: { ocr: 2 } } }),
    run({ caseIndex: 1, contaminated: true }), run({ caseIndex: 1, status: 'failed', telemetry: null, requests: null, pageArrivals: null, maxPollGapMs: null, firstPageMs: null })] };
const FAILED = { ...REPORT, status: 'failed', error: 'Server 429: hourly limit', runs: REPORT.runs.slice(0, 2) };
const EMPTY = { ...REPORT, status: 'cancelled', cases: [models('48px')], galleries: [], runs: [] };
const EARLIER = { ...REPORT, startedAt: '2026-11-10T08:00:00.000Z', runs: REPORT.runs.map((r) => ({ ...r, wallMs: r.wallMs * 1.25 })) };
const OTHER_CORPUS = { ...EARLIER, galleries: [gallery('17', 20)] };
const OTHER_COVERAGE = { ...EARLIER, runs: EARLIER.runs.filter((r) => r.galleryId !== '9') };

// The words of a tree drawn by 1.3's code, in order; the words of the view, in the order of its fields
// (each table's headers, then its rows); the report's own labels, which the page writes itself.
const WORDS = (shape) => { const out = []; const walk = (n) => { if (n.text != null) out.push(n.text); for (const c of n.children || []) walk(c); }; walk(shape); return out; };
const SAID = (view) => {
  const out = [];
  const walk = (v, key) => {
    if (v == null || typeof v === 'boolean' || ['value', 'max', 'name'].includes(key)) return;
    if (typeof v !== 'object') { out.push(String(v)); return; }
    for (const [k, x] of Object.entries(v)) if (k !== 'waitsNote' || v.waits) walk(x, Array.isArray(v) ? key : k);   // (the note goes with its table)
  };
  walk(view);
  return out;
};
const CHROME = new Set(['Translation benchmark', 'Close', 'Export JSON', 'Compare JSON…']);

test('the report says what 1.3\'s said, word for word, with and without a comparison', () => {
  for (const [report, comparison] of [[REPORT, null], [FAILED, null], [EMPTY, null], [REPORT, EARLIER], [REPORT, OTHER_CORPUS], [REPORT, OTHER_COVERAGE], [EMPTY, REPORT]]) {
    const was = WORDS(oldShowBenchmarkReport(report, comparison).shape).filter((w) => !CHROME.has(w));
    assert.deepEqual(SAID(reportView(report, comparison)), was, `${report.status} against ${comparison?.startedAt ?? 'nothing'}`);
  }
  const view = reportView(REPORT, EARLIER);
  assert.equal(view.comparison.table.rows[0][3], '-20.0%', 'a quarter slower before: a fifth faster now');
  assert.equal(reportView(REPORT, OTHER_CORPUS).comparison.table.rows[0][3], 'Inputs differ');
  assert.equal(reportView(REPORT, OTHER_COVERAGE).comparison.table.rows[0][3], 'Measured coverage differs');
});

test('what a report file is, and what the files are called', () => {
  assert.equal(isBenchmarkReport(REPORT), true);
  for (const not of [null, {}, { schema: 'shiori-benchmark/1' }, { schema: 'other', runs: [] }]) assert.equal(isBenchmarkReport(not), false);
  assert.equal(reportFileName(REPORT), 'shiori-benchmark-2026-11-20.json');
  assert.equal(PLAN_FILE_NAME, 'shiori-benchmark-plan.json');
  assert.equal(number(1 / 3), '0.33');
  assert.equal(number(null), '—');
  assert.equal(finishedText(FAILED), 'failed: Server 429: hourly limit');
  assert.equal(finishedText(REPORT), 'done');
});

test('the plan the card\'s fields make, and what it comes to', () => {
  const numbers = Object.fromEntries(NUMBERS.map(([key, , value]) => [key, String(value)]));
  assert.deepEqual(NUMBERS.map(([key]) => key), ['repeats', 'pageLimit', 'warmupPages', 'cooldownSeconds', 'minStartIntervalSeconds']);
  assert.deepEqual(MODES.map(([value]) => value), ['sweep', 'matrix']);
  const chosen = { detect: ['default'], ocr: ['hayai', '48px'], translate: ['sugoi'], inpaint: ['lama_large'], render: ['manga2eng'] };
  const plan = benchmarkPlan({ serverUrl: '  ', mode: 'sweep', numbers, models: chosen, galleryIds: ['17', '9'] });
  assert.deepEqual(plan, { mode: 'sweep', repeats: 1, pageLimit: 0, warmupPages: 3, cooldownSeconds: 10, minStartIntervalSeconds: 0, models: chosen, galleryIds: ['17', '9'] });
  assert.equal(JSON.stringify(Object.keys(benchmarkPlan({ serverUrl: ' http://x.test:1 ', mode: 'matrix', numbers, models: chosen, galleryIds: [] }))),
    JSON.stringify(['serverUrl', 'mode', 'repeats', 'pageLimit', 'warmupPages', 'cooldownSeconds', 'minStartIntervalSeconds', 'models', 'galleryIds']));
  assert.match(estimateText(plan), /^2 configurations · 2 galleries · 8 jobs including warm-ups\. First selected model/);
  assert.equal(estimateText({ ...plan, models: { ...chosen, ocr: [] } }), 'Select at least one model per group.');
  assert.equal(selectedText(0), '');
  assert.equal(selectedText(1200), `${formatCount(1200)} selected`);
});

test('the server the card loads from: one typed there replaces the saved, and the saved token stays with its own origin', () => {
  assert.deepEqual(benchmarkServerSettings({ serverUrl: 'http://127.0.0.1:5003', serverToken: 's' }, ''), { serverUrl: 'http://127.0.0.1:5003', serverToken: 's' });
  assert.deepEqual(benchmarkServerSettings({ serverUrl: 'http://127.0.0.1:5003', serverToken: 's' }, ' http://127.0.0.1:5003/x '), { serverUrl: 'http://127.0.0.1:5003/x', serverToken: 's' });
  assert.deepEqual(benchmarkServerSettings({ serverToken: 's' }, 'https://mt.example.test'), { serverUrl: 'https://mt.example.test', serverToken: '' });
  assert.equal(defaultStartInterval('http://localhost:9'), 0);
  assert.equal(defaultStartInterval(undefined), 0);
  assert.equal(defaultStartInterval('https://mt.example.test'), 310);
});

test('the models offered: stage by stage, the defaults first and ticked, those the server can\'t run off with why', () => {
  const groups = modelGroups(CAPS);
  assert.deepEqual(groups.map((g) => g.stage), MODEL_STAGES);
  const translate = groups.find((g) => g.stage === 'translate');
  assert.equal(translate.legend, 'Translation');
  assert.deepEqual(translate.models.slice(0, 2).map((m) => [m.id, m.checked]), [['deepseek', true], ['sugoi', true]]);
  const chatgpt = translate.models.find((m) => m.id === 'chatgpt');
  assert.equal(chatgpt.disabled, true);
  assert.equal(chatgpt.checked, false);
  assert.match(chatgpt.reason, /^ — /);
  // An imported plan: its order, ticks as it says (never one the server can't run), its galleries.
  const fields = planFields({ mode: 'matrix', repeats: 3, models: { translate: ['sugoi', 'chatgpt'] }, galleryIds: ['9'] }, { translate: translate.models });
  assert.deepEqual(fields.numbers, { repeats: 3 });
  assert.equal(fields.mode, 'matrix');
  assert.equal(fields.serverUrl, '');
  assert.deepEqual(fields.models.translate.slice(0, 2).map((m) => [m.id, m.checked]), [['sugoi', true], ['chatgpt', false]]);
  assert.equal(fields.models.translate.filter((m) => m.checked).length, 1);
  assert.deepEqual(fields.galleryIds, ['9']);
  assert.deepEqual(planFields({}, {}), { serverUrl: '', mode: 'sweep', numbers: {}, models: {}, galleryIds: [] });
});

test('the gallery picker: groups by tier, what a row says, the filter', () => {
  const g = (id, title, tier, pages = 30) => ({ id, title, pages, bytes: pages * 2048, page: tier ? { tier, w: 1000, h: 1400, mp: 1.4 } : null });
  const galleries = [g('1', 'Alpha', 'T2'), g('2', 'Beta', null, 5), g('3', 'Gamma', 'T1'), g('4', 'delta', 'T2')];
  assert.deepEqual(galleryGroups(galleries).map((group) => [group.tier.id, group.galleries.map((x) => x.id)]), [['T1', ['3']], ['T2', ['1', '4']], [null, ['2']]]);
  assert.equal(galleryGroups(galleries).at(-1).tier.name, 'Not measured yet');
  assert.deepEqual(tierCounts(galleries), [1, 2, 0, 0, 0, 0]);
  assert.deepEqual(galleryMeta(galleries[0]), { size: ['1000×1400', formatMegapixels(1.4)], pages: { text: '30 pages', low: false, tip: null }, perPage: `${formatBytes(2048)}/page` });
  assert.deepEqual(galleryMeta(galleries[1]).pages, { text: '5 pages', low: true, tip: `Under ${RECOMMENDED_PAGES} pages — ${RECOMMENDED_PAGES}+ is recommended for steady timings` });
  assert.deepEqual(galleryMeta(galleries[1]).size, []);
  assert.equal(galleryMeta({ ...galleries[0], pages: 1, bytes: 1 }).pages.text, '1 page');
  const none = new Set(), all = new Set(TIERS.map((x) => x.id));
  assert.deepEqual(galleries.map((x) => galleryHidden(x, none, '')), [false, false, false, false]);
  assert.deepEqual(galleries.map((x) => galleryHidden(x, all, '')), [false, false, false, false]);
  assert.deepEqual(galleries.map((x) => galleryHidden(x, new Set(['T2']), '')), [false, true, true, false]);
  assert.deepEqual(galleries.map((x) => galleryHidden(x, none, ' DELTA ')), [true, true, true, false]);
  assert.deepEqual(galleries.map((x) => galleryHidden(x, none, '3')), [true, true, false, true], 'by its id');
  assert.equal(tierFilterText(none), 'All tiers');
  assert.equal(tierFilterText(all), 'All tiers');
  assert.equal(tierFilterText(new Set(['T1', 'T3'])), 'T1, T3');
  assert.deepEqual(TIERS.map((_, i) => tierRange(i)), ['under 1.4 MP', '1.4–2.2 MP', '2.2–3 MP', '3–5 MP', '5–8 MP', '8 MP and up']);
});

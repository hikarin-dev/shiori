// benchmark-view.js — what Settings' benchmark card and its report say, worked out from the experiment's
// plan, the server's models, the library's galleries and a report: for 1.3's page (benchmark-ui.js) and
// the port to share while both run. Pure: no DOM, no network (app/tests/benchmark-view.test.mjs). Its
// words are English only, as they have always been.

import { MODEL_STAGES, benchmarkCases, benchmarkSummary, benchmarkCoverage } from './benchmark-core.js';
import { DEFAULT_MODELS } from './benchmark.js';
import { TIERS } from './page-size.js';
import { formatBytes, formatCount, formatMegapixels } from './format.js';

export const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';

// ── The report ────────────────────────────────────────────────────────────────────────────────
// A file is a report when it says so and lists its runs.
export const isBenchmarkReport = (value) => value?.schema === 'shiori-benchmark/1' && Array.isArray(value.runs);
export const reportFileName = (report) => `shiori-benchmark-${report.startedAt.slice(0, 10)}.json`;
export const PLAN_FILE_NAME = 'shiori-benchmark-plan.json';
export const REPORT_TITLE = 'Translation benchmark';

// Everything the report shows, in its order: its line, its error, the note, the chart, the summary,
// the comparison with an earlier report (when given), the corpus, the stages, each run, the method.
// A table is { headers, rows } with every cell as it shows.
export function reportView(report, comparison = null) {
  const summaries = benchmarkSummary(report);
  const maximum = Math.max(1, ...summaries.map(s => s.secondsPerPage || 0));
  const table = (headers, rows) => ({ headers, rows });
  let compared = null;
  if (comparison) {
    const other = benchmarkSummary(comparison);
    const corpus = r => JSON.stringify(r.galleries.map(g => ({ id: g.id, pages: g.pages })).sort((a, b) => a.id.localeCompare(b.id)));
    const sameCorpus = corpus(report) === corpus(comparison);
    compared = {
      title: `Comparison with ${comparison.startedAt}`,
      note: sameCorpus ? 'Input manifests match. Compare effective settings, worker count and warm-up policy below before attributing differences to code changes.' : 'The input manifests differ. These results are not a controlled before/after comparison.',
      differs: !sameCorpus,
      table: table(['Models', 'Current s/page', 'Imported s/page', 'Change'], summaries.map(s => {
        const match = other.find(o => MODEL_STAGES.every(k => o.models[k] === s.models[k]));
        const sameCoverage = match && benchmarkCoverage(report, s.caseIndex) === benchmarkCoverage(comparison, match.caseIndex);
        const delta = sameCorpus && sameCoverage && s.secondsPerPage && match?.secondsPerPage ? (s.secondsPerPage / match.secondsPerPage - 1) * 100 : null;
        const change = !sameCorpus ? 'Inputs differ' : match && !sameCoverage ? 'Measured coverage differs' : delta == null ? '—' : `${number(delta, 1)}%`;
        return [Object.values(s.models).join(' / '), number(s.secondsPerPage), number(match?.secondsPerPage), change];
      })),
    };
  }
  const stageNames = [...new Set(summaries.flatMap(s => Object.keys(s.stagesSecondsPerPage)))];
  return {
    line: `${report.status} · ${report.startedAt} · ${report.runs.length} runs including warm-ups`,
    error: report.error || null,
    note: 'Warm-ups, failed runs and runs affected by competing work or delayed polling are excluded from the summary. Stage times overlap and include nested substages; they do not add up to elapsed time. Missing telemetry is shown as unknown. Job percentiles span the selected galleries and repeats; they are not confidence intervals.',
    chart: summaries.map(s => {
      const label = Object.values(s.models).join(' / ');
      return { label: `#${s.caseIndex + 1} ${label}`, name: label + ' seconds per page', value: s.secondsPerPage || 0, max: maximum, figure: `${number(s.secondsPerPage)} s/page` };
    }),
    summary: table(['Case', 'Measured / excluded', 'Pages', 's/page', 'Pages/min', 'Median job s', 'P95 job s'], summaries.map(s =>
      [s.caseIndex + 1, `${s.successful} / ${s.excluded}`, s.pages, number(s.secondsPerPage), number(s.pagesPerMinute), number(s.wallSeconds?.median), number(s.wallSeconds?.p95)])),
    comparison: compared,
    corpusTitle: 'Corpus',
    corpus: table(['Gallery', 'Stored / tested pages', 'Median MP', 'Min–max MP', 'Original MiB'], report.galleries.map(g =>
      [g.id, `${g.storedPages} / ${g.pages.length}`, number(g.megapixels?.median), `${number(g.megapixels?.min)}–${number(g.megapixels?.max)}`, number(g.bytes / 1048576)])),
    stagesTitle: 'Stage work per measured page',
    stages: table(['Stage (seconds)', ...summaries.map(s => `#${s.caseIndex + 1}`)], stageNames.map(stage =>
      [stage, ...summaries.map(s => number(s.stagesSecondsPerPage[stage], 3))])),
    runsTitle: 'Individual runs',
    runs: report.runs.map(r => ({
      summary: `#${r.caseIndex + 1} · ${r.galleryId} · ${r.phase} ${r.repetition || ''} · ${r.status}${r.contaminated ? ' · timing affected' : ''} · ${number(r.wallMs / 1000)} s`,
      metrics: table(['Metric', 'Value'], [
        ['Pages', r.pageCount], ['Model state', r.warmState], ['Input read (s)', number(r.inputReadMs / 1000)],
        ['Upload (s)', number(r.uploadMs / 1000)], ['First page received (s)', number(r.firstPageMs == null ? null : r.firstPageMs / 1000)],
        ['Server wall (s)', number(r.telemetry?.wall_s)], ['GPU peak (%)', number(r.telemetry?.gpu_max_pct, 0)],
        ['Observed model loading (s)', number(r.telemetry?.model_load_s, 4)],
        ['GPU average (%)', number(r.telemetry?.gpu_avg_pct, 1)], ['CPU average (%)', number(r.telemetry?.cpu_avg_pct, 1)],
        ['VRAM peak (MiB)', number(r.telemetry?.vram_max_mb, 0)], ['LLM requests', r.telemetry?.llm_requests ?? '—'],
        ['Estimated LLM cost (USD)', number(r.telemetry?.llm_cost_usd, 4)], ['Polling requests', r.requests?.poll ?? '—'],
        ['Longest poll interval (s)', number(r.maxPollGapMs == null ? null : r.maxPollGapMs / 1000)],
        ['Downloaded MiB', number((r.requests?.bytesReceived || 0) / 1048576)],
      ]),
      loads: r.telemetry?.model_loads?.length ? table(['Model loaded', 'Chunk', 'Start in chunk (s)', 'Load await (s)'],
        r.telemetry.model_loads.map(m => [m.model, m.chunk, number(m.at_s), number(m.seconds, 4)])) : null,
      waits: r.telemetry?.waits_s ? table(['Worker waiting for upstream work', 'Cumulative seconds'], Object.entries(r.telemetry.waits_s).map(([k, v]) => [k, number(v)])) : null,
      waitsNote: 'These counters measure workers awaiting queue input, not how long pages remain queued.',
      arrivalsNote: 'Page timestamps are receipt times with 2-second polling granularity, not per-page compute latency.',
      arrivals: table(['Page', 'Received at (s)', 'Page-frame KiB'], (r.pageArrivals || []).map(p => [p.page, number(p.atMs / 1000), number(p.bytes / 1024)])),
      framesNote: 'Page frames can be empty when Study data carries the result. Downloaded MiB above includes all frames.',
      raw: JSON.stringify(r, null, 2),
    })),
    environment: { summary: 'Method, environment and reproducible plan',
      raw: JSON.stringify({ methodology: report.methodology, environment: report.environment, options: report.options }, null, 2) },
  };
}

// ── The gallery picker ──────────────────────────────────────────────────────────────────────────
// Galleries grouped by the tier of their typical page, filtered by title and tier. Fewer than 20
// pages is allowed but marked: timings over a few pages are noisy.
export const RECOMMENDED_PAGES = 20;
export const tierRange = (i) => i === 0 ? `under ${TIERS[0].max} MP`
  : TIERS[i].max === Infinity ? `${TIERS[i - 1].max} MP and up` : `${TIERS[i - 1].max}–${TIERS[i].max} MP`;

// What a gallery's row says under its title: its typical page's size, its pages (marked when too few
// for steady timings), its bytes per page.
export function galleryMeta(g) {
  return {
    size: g.page ? [`${g.page.w}×${g.page.h}`, formatMegapixels(g.page.mp)] : [],
    pages: { text: `${formatCount(g.pages)} ${g.pages === 1 ? 'page' : 'pages'}`, low: g.pages < RECOMMENDED_PAGES,
      tip: g.pages < RECOMMENDED_PAGES ? `Under ${RECOMMENDED_PAGES} pages — ${RECOMMENDED_PAGES}+ is recommended for steady timings` : null },
    perPage: `${formatBytes(g.bytes / g.pages)}/page`,
  };
}

// The galleries by tier, in the tiers' order, then those not measured yet; tiers with none left out.
export function galleryGroups(galleries) {
  const byTier = [...TIERS.map((tier, i) => ({ id: tier.id, name: tier.name, range: tierRange(i) })),
    { id: null, name: 'Not measured yet', range: 'measured in the background' }];
  return byTier.map(tier => ({ tier, galleries: galleries.filter(g => (g.page?.tier ?? null) === tier.id) })).filter(group => group.galleries.length);
}

// How many galleries are of each tier (the tier filter's counts).
export const tierCounts = (galleries) => TIERS.map(tier => galleries.filter(g => g.page?.tier === tier.id).length);

// Whether a gallery is left out by the filter: the tiers ticked (none or all ticked: every tier) and
// the words typed (in its title or its id).
export function galleryHidden(g, picked, query) {
  const q = query.trim().toLowerCase();
  const all = !picked.size || picked.size === TIERS.length;
  return !(all || picked.has(g.page?.tier)) || (!!q && !g.title.toLowerCase().includes(q) && !g.id.includes(q));
}
export const tierFilterText = (picked) => (!picked.size || picked.size === TIERS.length ? 'All tiers' : [...picked].join(', '));

// ── The card ────────────────────────────────────────────────────────────────────────────────────
export const MODES = [['sweep', 'Change one model at a time'], ['matrix', 'Every model combination']];
// The plan's numbers: its key, its label, its first value, its bounds.
export const NUMBERS = [['repeats', 'Measured repeats', 1, 1, 20], ['pageLimit', 'Pages per gallery (0 = all)', 0, 0, 10000],
  ['warmupPages', 'Warm-up pages per case / gallery', 3, 1, 20], ['cooldownSeconds', 'Cooldown seconds', 10, 1, 3600],
  ['minStartIntervalSeconds', 'Minimum seconds between job starts', 0, 0, 86400]];

// The experiment as the card's fields say it: { serverUrl (typed), mode, numbers by key, models by
// stage (the ids ticked, in the order shown), galleryIds (ticked) }.
export function benchmarkPlan({ serverUrl, mode, numbers, models, galleryIds }) {
  return { ...(serverUrl.trim() ? { serverUrl: serverUrl.trim() } : {}),
    mode, repeats: Number(numbers.repeats), pageLimit: Number(numbers.pageLimit),
    warmupPages: Number(numbers.warmupPages), cooldownSeconds: Number(numbers.cooldownSeconds), minStartIntervalSeconds: Number(numbers.minStartIntervalSeconds),
    models, galleryIds };
}

export const selectedText = (n) => (n ? `${formatCount(n)} selected` : '');

// What the plan comes to, or what it lacks.
export function estimateText(plan) {
  try {
    const count = benchmarkCases(plan.models, plan.mode).length, jobs = count * plan.galleryIds.length * (1 + plan.repeats);
    return `${count} configurations · ${plan.galleryIds.length} galleries · ${jobs} jobs including warm-ups. First selected model in each group is the baseline. Saved Translation settings supply all other parameters; target language is English. Remote providers may charge for translation requests.`;
  } catch { return 'Select at least one model per group.'; }
}

// The saved settings the card loads models with: a server typed into the card replaces the saved one,
// and the saved token goes only to the saved server's origin.
export function benchmarkServerSettings(settings, typed) {
  if (typed.trim()) {
    if (new URL(typed).origin !== new URL(settings.serverUrl || 'http://127.0.0.1:5003').origin) settings.serverToken = '';
    settings.serverUrl = typed.trim();
  }
  return settings;
}

// A local server needs no pause between job starts; a remote one is paced.
export const defaultStartInterval = (serverUrl) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(serverUrl || 'http://127.0.0.1:5003').hostname) ? 0 : 310;

// The server's models, stage by stage: the defaults first, those it can't run off (with why).
export function modelGroups(caps) {
  return MODEL_STAGES.map(stage => {
    const spec = caps.stages.find(s => s.id === stage);
    const implementations = [...(spec?.implementations || [])].sort((a, b) => {
      const order = id => { const i = DEFAULT_MODELS[stage].indexOf(id); return i < 0 ? 999 : i; }; return order(a.id) - order(b.id);
    });
    return { stage, legend: spec?.label || stage, models: implementations.map(impl => ({ id: impl.id, label: impl.label || impl.id,
      checked: impl.available && DEFAULT_MODELS[stage].includes(impl.id), disabled: !impl.available,
      reason: impl.available ? null : ` — ${impl.unavailable_reason || 'unavailable'}` })) };
  });
}

// An imported plan laid over the card: its server, mode and numbers (a number it leaves out is kept),
// each stage's models in the plan's order and ticked as it says (one the server can't run stays off),
// its galleries ticked.
export function planFields(plan, models) {
  return {
    serverUrl: plan.serverUrl || '',
    mode: plan.mode || 'sweep',
    numbers: Object.fromEntries(NUMBERS.filter(([key]) => plan[key] != null).map(([key]) => [key, plan[key]])),
    models: Object.fromEntries(Object.entries(models).map(([stage, list]) => {
      const selected = plan.models?.[stage] || [];
      const rank = model => { const i = selected.indexOf(model.id); return i < 0 ? 999 : i; };
      return [stage, [...list].sort((a, b) => rank(a) - rank(b)).map(model => ({ ...model, checked: !model.disabled && selected.includes(model.id) }))];
    })),
    galleryIds: plan.galleryIds || [],
  };
}

export const finishedText = (report) => `${report.status}${report.error ? ': ' + report.error : ''}`;

import { benchmarkGalleries, benchmarkSettings, benchmarkCapabilities,
  runBenchmark, lastBenchmarkReport, DEFAULT_MODELS } from './benchmark.js';
import { MODEL_STAGES, benchmarkCases, benchmarkSummary, benchmarkCoverage } from './benchmark-core.js';
import { coverPreviewGet } from './db.js';
import { TIERS } from './page-size.js';
import { formatBytes, formatCount, formatMegapixels } from './format.js';

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const button = (label, action) => { const b = el('button', label, 'btn-mini'); b.type = 'button'; b.onclick = action; return b; };
const download = (value, name) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const jsonFile = async () => new Promise(resolve => {
  const input = el('input'); input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = async () => { try { resolve(JSON.parse(await input.files[0].text())); } catch { resolve(null); } };
  input.oncancel = () => resolve(null); input.click();
});
function table(headers, rows) {
  const wrap = el('div', null, 'benchmark-table-wrap'), t = el('table');
  const head = el('thead'), tr = el('tr'); headers.forEach(h => tr.append(el('th', h))); head.append(tr); t.append(head);
  const body = el('tbody');
  for (const row of rows) { const r = el('tr'); for (const cell of row) r.append(el('td', cell)); body.append(r); }
  t.append(body); wrap.append(t); return wrap;
}

export function showBenchmarkReport(report, comparison = null) {
  const dialog = el('dialog', null, 'benchmark-dialog'); dialog.setAttribute('aria-labelledby', 'benchmarkReportTitle');
  const header = el('div', null, 'benchmark-dialog-header'), title = el('h2', 'Translation benchmark'); title.id = 'benchmarkReportTitle';
  header.append(title, button('Close', () => dialog.close())); dialog.append(header);
  dialog.append(el('p', `${report.status} · ${report.startedAt} · ${report.runs.length} runs including warm-ups`));
  const actions = el('div', null, 'benchmark-actions');
  actions.append(button('Export JSON', () => download(report, `shiori-benchmark-${report.startedAt.slice(0, 10)}.json`)),
    button('Compare JSON…', async () => {
      const other = await jsonFile();
      if (other?.schema !== 'shiori-benchmark/1' || !Array.isArray(other.runs)) return;
      dialog.close(); showBenchmarkReport(report, other);
    }));
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
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}

// ── Gallery picker ──
// Galleries grouped by the tier of their typical page, filtered by title and tier. Fewer than 20
// pages is allowed but marked: timings over a few pages are noisy.
const RECOMMENDED_PAGES = 20;
const tierRange = (i) => i === 0 ? `under ${TIERS[0].max} MP`
  : TIERS[i].max === Infinity ? `${TIERS[i - 1].max} MP and up` : `${TIERS[i - 1].max}–${TIERS[i].max} MP`;

// Covers are drawn small as their rows come into view, a few at a time, from a thumbnail the
// library already stored where there is one — nothing is written.
const COVER_W = 36, COVER_H = 50;
function coverLoader(root) {
  const queue = [];
  let active = 0;
  const draw = async (canvas) => {
    const blob = await coverPreviewGet(canvas.dataset.id).catch(() => null);
    if (!blob) return;
    const w = Math.round(COVER_W * (devicePixelRatio || 1)), h = Math.round(COVER_H * (devicePixelRatio || 1));
    let bitmap;
    try { bitmap = await createImageBitmap(blob, { resizeWidth: w * 2, resizeQuality: 'medium' }); } catch { return; }
    canvas.width = w; canvas.height = h;
    const s = Math.max(w / bitmap.width, h / bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, (w - bitmap.width * s) / 2, 0, bitmap.width * s, bitmap.height * s);
    bitmap.close();
  };
  const pump = () => {
    while (active < 3 && queue.length) { active++; draw(queue.shift()).finally(() => { active--; pump(); }); }
  };
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); queue.push(e.target); }
    pump();
  }, { root, rootMargin: '200px 0px' });
  return { observe: (canvas) => observer.observe(canvas), stop: () => { observer.disconnect(); queue.length = 0; } };
}

function galleryPicker() {
  const inputs = new Map();
  let rows = [], groups = [], covers = null;
  const search = el('input'); search.type = 'search'; search.placeholder = 'Filter galleries'; search.setAttribute('aria-label', 'Filter benchmark galleries');

  // The tier filter: a dropdown of checkboxes. None or all checked shows every gallery.
  const toggle = el('button', 'All tiers', 'bench-tier-toggle'); toggle.type = 'button';
  const menu = el('div', null, 'bench-tier-menu'); menu.popover = 'auto';
  toggle.popoverTargetElement = menu;
  const tierInputs = TIERS.map((tier, i) => {
    const label = el('label', null, 'bench-tier-option'), input = el('input'); input.type = 'checkbox'; input.value = tier.id;
    const count = el('span', '', 'bench-tier-count');
    label.append(input, el('span', tier.id, 'bench-tier'), el('span', tier.name), el('small', tierRange(i)), count);
    menu.append(label);
    return { input, count };
  });
  const filterRow = el('div', null, 'bench-gallery-filters'); filterRow.append(search, toggle, menu);

  const list = el('div', null, 'benchmark-galleries');
  const apply = () => {
    const q = search.value.trim().toLowerCase();
    const picked = new Set(tierInputs.filter(t => t.input.checked).map(t => t.input.value));
    const all = !picked.size || picked.size === TIERS.length;
    toggle.textContent = all ? 'All tiers' : [...picked].join(', ');
    for (const r of rows) r.el.hidden = !(all || picked.has(r.g.page?.tier)) || (!!q && !r.g.title.toLowerCase().includes(q) && !r.g.id.includes(q));
    for (const group of groups) {
      const n = group.rows.filter(r => !r.el.hidden).length;
      group.head.hidden = !n; group.count.textContent = formatCount(n);
    }
  };
  search.oninput = apply;
  menu.onchange = apply;

  const row = (g) => {
    const label = el('label', null, 'bench-gallery'), input = el('input'); input.type = 'checkbox';
    const cover = el('canvas', null, 'bench-cover'); cover.width = cover.height = 0; cover.dataset.id = g.id;
    const text = el('span', null, 'bench-gallery-text'), meta = el('span', null, 'bench-gallery-meta');
    const pages = el('span', `${formatCount(g.pages)} ${g.pages === 1 ? 'page' : 'pages'}`, g.pages < RECOMMENDED_PAGES ? 'bench-pages low' : 'bench-pages');
    if (g.pages < RECOMMENDED_PAGES) pages.dataset.tip = `Under ${RECOMMENDED_PAGES} pages — ${RECOMMENDED_PAGES}+ is recommended for steady timings`;
    const parts = [...(g.page ? [`${g.page.w}×${g.page.h}`, formatMegapixels(g.page.mp)] : []), pages, `${formatBytes(g.bytes / g.pages)}/page`];
    parts.forEach((part, i) => meta.append(...(i ? [' · '] : []), part));
    text.append(el('span', g.title, 'bench-gallery-title'), meta);
    label.append(input, cover, text);
    inputs.set(g.id, input);
    return { g, el: label, cover };
  };

  return {
    el: [filterRow, list], inputs,
    selectedIds: () => [...inputs].filter(([, input]) => input.checked).map(([id]) => id),
    show(galleries) {
      covers?.stop();
      covers = coverLoader(list);
      inputs.clear(); list.replaceChildren();
      rows = galleries.map(row);
      const byTier = [...TIERS.map((tier, i) => ({ id: tier.id, name: tier.name, range: tierRange(i) })),
        { id: null, name: 'Not measured yet', range: 'measured in the background' }];
      groups = byTier.map(tier => ({ tier, rows: rows.filter(r => (r.g.page?.tier ?? null) === tier.id) })).filter(group => group.rows.length);
      for (const group of groups) {
        const head = el('div', null, 'bench-group'), count = el('span', '', 'bench-tier-count');
        if (group.tier.id) head.append(el('span', group.tier.id, 'bench-tier'));
        head.append(el('span', group.tier.name), el('small', group.tier.range), count);
        Object.assign(group, { head, count });
        list.append(head, ...group.rows.map(r => r.el));
      }
      tierInputs.forEach(({ count }, i) => { count.textContent = formatCount(rows.filter(r => r.g.page?.tier === TIERS[i].id).length); });
      for (const r of rows) covers.observe(r.cover);
      apply();
    },
  };
}

export function initBenchmarkCard() {
  const host = document.getElementById('translationBenchmark');
  if (!host) return;
  let caps, galleries = [], latest, controller;
  const modelInputs = new Map(), picker = galleryPicker(), galleryInputs = picker.inputs;
  const body = el('div', null, 'section-body');
  const head = el('div', null, 'section-header'); head.append(el('h2', 'Benchmark', 'section-title')); host.append(head, body);
  body.append(el('p', 'Compare translation models on your stored galleries. Each job runs alone after a warm-up and cooldown. Results include timing, page resolution and server metrics. Generated pages leave your saved translations unchanged.', 'field-desc'));
  const status = el('p', 'Load models and galleries to configure a benchmark.', 'benchmark-status'); status.setAttribute('role', 'status');
  const controls = el('fieldset', null, 'benchmark-controls'); controls.hidden = true;
  const serverLabel = el('label', 'Benchmark server (blank uses saved Translation server)', 'benchmark-server');
  const serverInput = el('input'); serverInput.type = 'url'; serverInput.placeholder = 'Use saved server'; serverLabel.append(serverInput);
  const modelHost = el('div', null, 'benchmark-models');
  const numeric = (label, value, min, max) => {
    const l = el('label', label), input = el('input'); input.type = 'number'; input.min = min; input.max = max; input.step = 1; input.value = value; l.append(input); return { label: l, input };
  };
  const repeats = numeric('Measured repeats', 1, 1, 20), limit = numeric('Pages per gallery (0 = all)', 0, 0, 10000),
    warm = numeric('Warm-up pages per case / gallery', 3, 1, 20), cooldown = numeric('Cooldown seconds', 10, 1, 3600),
    interval = numeric('Minimum seconds between job starts', 0, 0, 86400);
  const modeLabel = el('label', 'Comparison mode'), mode = el('select');
  for (const [value, label] of [['sweep', 'Change one model at a time'], ['matrix', 'Every model combination']]) { const option = el('option', label); option.value = value; mode.append(option); }
  modeLabel.append(mode);
  const fields = el('div', null, 'benchmark-fields'); fields.append(modeLabel, repeats.label, limit.label, warm.label, cooldown.label, interval.label);
  const estimate = el('p', '', 'field-desc');
  const options = () => ({ ...(serverInput.value.trim() ? { serverUrl: serverInput.value.trim() } : {}),
    mode: mode.value, repeats: Number(repeats.input.value), pageLimit: Number(limit.input.value),
    warmupPages: Number(warm.input.value), cooldownSeconds: Number(cooldown.input.value), minStartIntervalSeconds: Number(interval.input.value),
    models: Object.fromEntries([...modelInputs].map(([stage, inputs]) => [stage, inputs.filter(i => i.checked).map(i => i.value)])),
    galleryIds: picker.selectedIds() });
  const selectedCount = el('span', '', 'bench-selected');
  const updateEstimate = () => {
    const n = picker.selectedIds().length;
    selectedCount.textContent = n ? `${formatCount(n)} selected` : '';
    try { const opts = options(), count = benchmarkCases(opts.models, opts.mode).length, jobs = count * opts.galleryIds.length * (1 + opts.repeats);
      estimate.textContent = `${count} configurations · ${opts.galleryIds.length} galleries · ${jobs} jobs including warm-ups. First selected model in each group is the baseline. Saved Translation settings supply all other parameters; target language is English. Remote providers may charge for translation requests.`;
    } catch { estimate.textContent = 'Select at least one model per group.'; }
  };
  controls.onchange = updateEstimate;
  const load = button('Load models and galleries', async () => {
    load.disabled = true; status.textContent = 'Loading…';
    try {
      const settings = await benchmarkSettings();
      if (serverInput.value.trim()) {
        if (new URL(serverInput.value).origin !== new URL(settings.serverUrl || 'http://127.0.0.1:5003').origin) settings.serverToken = '';
        settings.serverUrl = serverInput.value.trim();
      }
      [caps, galleries] = await Promise.all([benchmarkCapabilities(settings), benchmarkGalleries()]);
      modelHost.replaceChildren(); modelInputs.clear();
      for (const stage of MODEL_STAGES) {
        const spec = caps.stages.find(s => s.id === stage), group = el('fieldset'); group.append(el('legend', spec?.label || stage));
        const implementations = [...(spec?.implementations || [])].sort((a, b) => {
          const order = id => { const i = DEFAULT_MODELS[stage].indexOf(id); return i < 0 ? 999 : i; }; return order(a.id) - order(b.id);
        });
        const inputs = [];
        for (const impl of implementations) {
          const label = el('label'), input = el('input'); input.type = 'checkbox'; input.value = impl.id;
          input.checked = impl.available && DEFAULT_MODELS[stage].includes(impl.id); input.disabled = !impl.available;
          label.append(input, document.createTextNode(impl.label || impl.id));
          if (!impl.available) label.append(el('small', ` — ${impl.unavailable_reason || 'unavailable'}`));
          group.append(label); inputs.push(input);
        }
        modelInputs.set(stage, inputs); modelHost.append(group);
      }
      picker.show(galleries);
      interval.input.value = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(settings.serverUrl || 'http://127.0.0.1:5003').hostname) ? 0 : 310;
      controls.hidden = false; status.textContent = `${formatCount(galleries.length)} galleries.`; updateEstimate();
    } catch (error) { status.textContent = error.message; } finally { load.disabled = false; }
  });
  const start = button('Run benchmark', async () => {
    controller = new AbortController(); controls.disabled = true; load.disabled = true; serverInput.disabled = true; stop.disabled = false;
    const unload = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', unload);
    let wake;
    try {
      try { wake = await navigator.wakeLock?.request('screen'); } catch {}
      latest = await runBenchmark(options(), { signal: controller.signal,
        onProgress: p => { status.textContent = p.message; }, onReport: r => { latest = r; reportButton.disabled = false; } });
      status.textContent = `${latest.status}${latest.error ? ': ' + latest.error : ''}`; showBenchmarkReport(latest);
    } catch (e) { status.textContent = e.message; }
    finally { await wake?.release(); window.removeEventListener('beforeunload', unload); controls.disabled = false; load.disabled = false; serverInput.disabled = false; stop.disabled = true; controller = null; }
  });
  const stop = button('Stop', () => { controller?.abort(); status.textContent = 'Stopping and cancelling the current job…'; }); stop.disabled = true;
  const reportButton = button('View last report', async () => { latest = await lastBenchmarkReport() || latest; if (latest) showBenchmarkReport(latest); }); reportButton.disabled = true;
  const actions = el('div', null, 'benchmark-actions');
  actions.append(start, button('Export plan', () => download(options(), 'shiori-benchmark-plan.json')),
    button('Import plan…', async () => {
      const plan = await jsonFile(); if (!plan) return;
      serverInput.value = plan.serverUrl || '';
      mode.value = plan.mode || 'sweep';
      for (const [control, key] of [[repeats, 'repeats'], [limit, 'pageLimit'], [warm, 'warmupPages'], [cooldown, 'cooldownSeconds'], [interval, 'minStartIntervalSeconds']]) if (plan[key] != null) control.input.value = plan[key];
      for (const [stage, inputs] of modelInputs) {
        const selected = plan.models?.[stage] || [];
        const rank = input => { const i = selected.indexOf(input.value); return i < 0 ? 999 : i; };
        inputs.sort((a, b) => rank(a) - rank(b));
        for (const input of inputs) {
          input.checked = !input.disabled && selected.includes(input.value);
          const label = input.parentElement; label.parentElement.append(label);
        }
      }
      for (const [id, input] of galleryInputs) input.checked = !!plan.galleryIds?.includes(id);
      updateEstimate();
    }));
  const galleryHead = el('div', null, 'bench-gallery-head'); galleryHead.append(el('h3', 'Galleries'), selectedCount);
  controls.append(modelHost, galleryHead,
    el('p', `${RECOMMENDED_PAGES}+ pages per gallery is recommended for steady timings; galleries with fewer show their page count in red.`, 'field-desc'),
    ...picker.el, fields, estimate,
    el('p', 'Keep this tab visible and the device awake. Switching tabs stops the benchmark to prevent background timer throttling from distorting results. Avoid other GPU work. Remote defaults allow about 12 starts/hour; adjust pacing to your server policy. A rate-limit response stops the experiment and is recorded in the report.', 'field-desc'), actions);
  body.append(serverLabel, load, controls, status);
  const reports = el('div', null, 'benchmark-actions'); reports.append(stop, reportButton,
    button('Open report JSON…', async () => { const r = await jsonFile(); if (r?.schema === 'shiori-benchmark/1' && Array.isArray(r.runs)) showBenchmarkReport(r); })); body.append(reports);
  lastBenchmarkReport().then(r => { if (r) { latest = r; reportButton.disabled = false; } });
}

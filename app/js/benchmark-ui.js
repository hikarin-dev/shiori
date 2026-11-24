import { benchmarkGalleries, benchmarkSettings, benchmarkCapabilities, runBenchmark, lastBenchmarkReport } from './benchmark.js';
import * as api from './api.js';
import { TIERS } from './page-size.js';
import { formatCount } from './format.js';
import { isBenchmarkReport, reportFileName, PLAN_FILE_NAME, REPORT_TITLE, reportView, RECOMMENDED_PAGES, tierRange, galleryMeta,
  galleryGroups, tierCounts, galleryHidden, tierFilterText, MODES, NUMBERS, benchmarkPlan, selectedText, estimateText,
  benchmarkServerSettings, defaultStartInterval, modelGroups, planFields, finishedText } from './benchmark-view.js';

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const button = (label, action, className = 'btn-mini') => { const b = el('button', label, className); b.type = 'button'; b.onclick = action; return b; };
const download = (value, name) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const jsonFile = async () => new Promise(resolve => {
  const input = el('input'); input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = async () => { try { resolve(JSON.parse(await input.files[0].text())); } catch { resolve(null); } };
  input.oncancel = () => resolve(null); input.click();
});
function table({ headers, rows }) {
  const wrap = el('div', null, 'benchmark-table-wrap'), t = el('table');
  const head = el('thead'), tr = el('tr'); headers.forEach(h => tr.append(el('th', h))); head.append(tr); t.append(head);
  const body = el('tbody');
  for (const row of rows) { const r = el('tr'); for (const cell of row) r.append(el('td', cell)); body.append(r); }
  t.append(body); wrap.append(t); return wrap;
}

// The report's words and figures are benchmark-view.js's; this draws them.
export function showBenchmarkReport(report, comparison = null) {
  const view = reportView(report, comparison);
  const dialog = el('dialog', null, 'benchmark-dialog'); dialog.setAttribute('aria-labelledby', 'benchmarkReportTitle');
  const header = el('div', null, 'benchmark-dialog-header'), title = el('h2', REPORT_TITLE); title.id = 'benchmarkReportTitle';
  header.append(title, button('Close', () => dialog.close(), 'btn')); dialog.append(header);
  dialog.append(el('p', view.line));
  const actions = el('div', null, 'benchmark-actions');
  actions.append(button('Export JSON', () => download(report, reportFileName(report)), 'btn'),
    button('Compare JSON…', async () => {
      const other = await jsonFile();
      if (!isBenchmarkReport(other)) return;
      dialog.close(); showBenchmarkReport(report, other);
    }, 'btn'));
  dialog.append(actions);
  if (view.error) dialog.append(el('p', view.error, 'benchmark-error'));
  dialog.append(el('p', view.note));
  const charts = el('div', null, 'benchmark-chart');
  for (const bar of view.chart) {
    const row = el('div', null, 'benchmark-chart-row');
    const meter = el('meter'); meter.min = 0; meter.max = bar.max; meter.value = bar.value;
    meter.setAttribute('aria-label', bar.name);
    row.append(el('span', bar.label), meter, el('strong', bar.figure)); charts.append(row);
  }
  dialog.append(charts);
  dialog.append(table(view.summary));
  if (view.comparison) {
    dialog.append(el('h3', view.comparison.title));
    dialog.append(el('p', view.comparison.note, view.comparison.differs ? 'benchmark-error' : ''));
    dialog.append(table(view.comparison.table));
  }
  dialog.append(el('h3', view.corpusTitle));
  dialog.append(table(view.corpus));
  dialog.append(el('h3', view.stagesTitle));
  dialog.append(table(view.stages));
  dialog.append(el('h3', view.runsTitle));
  for (const r of view.runs) {
    const detail = el('details');
    detail.append(el('summary', r.summary));
    detail.append(table(r.metrics));
    if (r.loads) detail.append(table(r.loads));
    if (r.waits) {
      detail.append(table(r.waits));
      detail.append(el('p', r.waitsNote));
    }
    detail.append(el('p', r.arrivalsNote));
    detail.append(table(r.arrivals));
    detail.append(el('p', r.framesNote));
    const raw = el('pre', r.raw); detail.append(raw); dialog.append(detail);
  }
  const environment = el('details'); environment.append(el('summary', view.environment.summary),
    el('pre', view.environment.raw));
  dialog.append(environment);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}

// ── Gallery picker ──
// Galleries grouped by the tier of their typical page, filtered by title and tier (benchmark-view.js).

// Covers are drawn small as their rows come into view, a few at a time, from a thumbnail the
// library already stored where there is one — nothing is written.
const COVER_W = 36, COVER_H = 50;
function coverLoader(root) {
  const queue = [];
  let active = 0;
  const draw = async (canvas) => {
    const blob = await api.covers.preview(canvas.dataset.id).catch(() => null);
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
    const picked = new Set(tierInputs.filter(t => t.input.checked).map(t => t.input.value));
    toggle.textContent = tierFilterText(picked);
    for (const r of rows) r.el.hidden = galleryHidden(r.g, picked, search.value);
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
    const said = galleryMeta(g);
    const pages = el('span', said.pages.text, said.pages.low ? 'bench-pages low' : 'bench-pages');
    if (said.pages.tip) pages.dataset.tip = said.pages.tip;
    const parts = [...said.size, pages, said.perPage];
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
      const rowOf = new Map(rows.map(r => [r.g, r]));
      groups = galleryGroups(galleries).map(group => ({ tier: group.tier, rows: group.galleries.map(g => rowOf.get(g)) }));
      for (const group of groups) {
        const head = el('div', null, 'bench-group'), count = el('span', '', 'bench-tier-count');
        if (group.tier.id) head.append(el('span', group.tier.id, 'bench-tier'));
        head.append(el('span', group.tier.name), el('small', group.tier.range), count);
        Object.assign(group, { head, count });
        list.append(head, ...group.rows.map(r => r.el));
      }
      const counts = tierCounts(galleries);
      tierInputs.forEach(({ count }, i) => { count.textContent = formatCount(counts[i]); });
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
  const numbers = Object.fromEntries(NUMBERS.map(([key, label, value, min, max]) => [key, numeric(label, value, min, max)]));
  const interval = numbers.minStartIntervalSeconds;
  const modeLabel = el('label', 'Comparison mode'), mode = el('select');
  for (const [value, label] of MODES) { const option = el('option', label); option.value = value; mode.append(option); }
  modeLabel.append(mode);
  const fields = el('div', null, 'benchmark-fields'); fields.append(modeLabel, ...Object.values(numbers).map(n => n.label));
  const estimate = el('p', '', 'field-desc');
  const options = () => benchmarkPlan({ serverUrl: serverInput.value, mode: mode.value,
    numbers: Object.fromEntries(Object.entries(numbers).map(([key, n]) => [key, n.input.value])),
    models: Object.fromEntries([...modelInputs].map(([stage, inputs]) => [stage, inputs.filter(i => i.checked).map(i => i.value)])),
    galleryIds: picker.selectedIds() });
  const selectedCount = el('span', '', 'bench-selected');
  const updateEstimate = () => {
    selectedCount.textContent = selectedText(picker.selectedIds().length);
    estimate.textContent = estimateText(options());
  };
  controls.onchange = updateEstimate;
  const load = button('Load models and galleries', async () => {
    load.disabled = true; status.textContent = 'Loading…';
    try {
      const settings = benchmarkServerSettings(await benchmarkSettings(), serverInput.value);
      [caps, galleries] = await Promise.all([benchmarkCapabilities(settings), benchmarkGalleries()]);
      modelHost.replaceChildren(); modelInputs.clear();
      for (const { stage, legend, models } of modelGroups(caps)) {
        const group = el('fieldset'); group.append(el('legend', legend));
        const inputs = [];
        for (const model of models) {
          const label = el('label'), input = el('input'); input.type = 'checkbox'; input.value = model.id;
          input.checked = model.checked; input.disabled = model.disabled;
          label.append(input, document.createTextNode(model.label));
          if (model.reason) label.append(el('small', model.reason));
          group.append(label); inputs.push(input);
        }
        modelInputs.set(stage, inputs); modelHost.append(group);
      }
      picker.show(galleries);
      interval.input.value = defaultStartInterval(settings.serverUrl);
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
      status.textContent = finishedText(latest); showBenchmarkReport(latest);
    } catch (e) { status.textContent = e.message; }
    finally { await wake?.release(); window.removeEventListener('beforeunload', unload); controls.disabled = false; load.disabled = false; serverInput.disabled = false; stop.disabled = true; controller = null; }
  });
  const stop = button('Stop', () => { controller?.abort(); status.textContent = 'Stopping and cancelling the current job…'; }); stop.disabled = true;
  const reportButton = button('View last report', async () => { latest = await lastBenchmarkReport() || latest; if (latest) showBenchmarkReport(latest); }); reportButton.disabled = true;
  const actions = el('div', null, 'benchmark-actions');
  actions.append(start, button('Export plan', () => download(options(), PLAN_FILE_NAME)),
    button('Import plan…', async () => {
      const plan = await jsonFile(); if (!plan) return;
      const given = planFields(plan, Object.fromEntries([...modelInputs].map(([stage, inputs]) => [stage, inputs.map(input => ({ id: input.value, disabled: input.disabled, input }))])));
      serverInput.value = given.serverUrl;
      mode.value = given.mode;
      for (const [key, value] of Object.entries(given.numbers)) numbers[key].input.value = value;
      for (const [stage, models] of Object.entries(given.models)) {
        modelInputs.set(stage, models.map(model => model.input));
        for (const model of models) {
          model.input.checked = model.checked;
          const label = model.input.parentElement; label.parentElement.append(label);
        }
      }
      for (const [id, input] of galleryInputs) input.checked = given.galleryIds.includes(id);
      updateEstimate();
    }));
  const galleryHead = el('div', null, 'bench-gallery-head'); galleryHead.append(el('h3', 'Galleries'), selectedCount);
  controls.append(modelHost, galleryHead,
    el('p', `${RECOMMENDED_PAGES}+ pages per gallery is recommended for steady timings; galleries with fewer show their page count in red.`, 'field-desc'),
    ...picker.el, fields, estimate,
    el('p', 'Keep this tab visible and the device awake. Switching tabs stops the benchmark to prevent background timer throttling from distorting results. Avoid other GPU work. Remote defaults allow about 12 starts/hour; adjust pacing to your server policy. A rate-limit response stops the experiment and is recorded in the report.', 'field-desc'), actions);
  body.append(serverLabel, load, controls, status);
  const reports = el('div', null, 'benchmark-actions'); reports.append(stop, reportButton,
    button('Open report JSON…', async () => { const r = await jsonFile(); if (isBenchmarkReport(r)) showBenchmarkReport(r); })); body.append(reports);
  lastBenchmarkReport().then(r => { if (r) { latest = r; reportButton.disabled = false; } });
}

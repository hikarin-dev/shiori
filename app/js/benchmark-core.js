// Pure benchmark planning and wire parsing, shared by the UI and automation.
export const BENCHMARK_LOCK = 'shiori-translation-benchmark';
export const MODEL_STAGES = ['detect', 'ocr', 'translate', 'inpaint', 'render'];

export function benchmarkCases(selections, mode = 'sweep') {
  if (!['sweep', 'matrix'].includes(mode)) throw new Error('Unknown benchmark mode');
  const choices = MODEL_STAGES.map(stage => [...new Set(selections[stage] || [])]);
  if (choices.some(values => !values.length)) throw new Error('Select at least one model in every stage');
  const base = Object.fromEntries(MODEL_STAGES.map((stage, i) => [stage, choices[i][0]]));
  if (mode === 'sweep') return [base, ...MODEL_STAGES.flatMap((stage, i) =>
    choices[i].slice(1).map(value => ({ ...base, [stage]: value })))];
  return MODEL_STAGES.reduce((rows, stage, i) => rows.flatMap(row =>
    choices[i].map(value => ({ ...row, [stage]: value }))), [{}]);
}

export function samplePages(pages, limit = 0) {
  if (!limit || limit >= pages.length) return pages;
  if (limit === 1) return [pages[Math.floor(pages.length / 2)]];
  return Array.from({ length: limit }, (_, i) => pages[Math.round(i * (pages.length - 1) / (limit - 1))]);
}

export function parseBenchmarkFrames(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), out = [];
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 5 > bytes.length) throw new Error('Truncated poll frame');
    const code = bytes[offset], size = view.getUint32(offset + 1);
    offset += 5;
    if (offset + size > bytes.length) throw new Error('Truncated poll payload');
    const data = bytes.subarray(offset, offset + size);
    offset += size;
    if ([0, 7].includes(code)) out.push({ code, value: JSON.parse(new TextDecoder().decode(data)) });
    else if (code === 2) out.push({ code, value: new TextDecoder().decode(data) });
    else if (code === 5) {
      const start = 1 + data[0];
      if (start + 4 > data.length) throw new Error('Invalid page frame');
      out.push({ code, token: new TextDecoder().decode(data.subarray(1, start)),
        index: new DataView(data.buffer, data.byteOffset + start, 4).getUint32(0), bytes: data.length - start - 4 });
    }
  }
  return out;
}

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const quantile = p => {
    const index = (sorted.length - 1) * p, lo = Math.floor(index);
    return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
  };
  return { n: sorted.length, min: sorted[0], median: quantile(.5), p95: quantile(.95), max: sorted.at(-1),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length };
}

// Equal manifests alone do not guarantee that both cases actually measured the same pages.
export function benchmarkCoverage(report, caseIndex) {
  return JSON.stringify(report.runs.filter(r => r.caseIndex === caseIndex && r.phase === 'measure' && r.status === 'done' && !r.contaminated)
    .map(r => [r.galleryId, r.pageCount]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[1] - b[1]));
}

export function benchmarkSummary(report) {
  return report.cases.map((models, caseIndex) => {
    const runs = report.runs.filter(r => r.caseIndex === caseIndex && r.phase === 'measure');
    const valid = runs.filter(r => r.status === 'done' && !r.contaminated);
    const pages = valid.reduce((n, r) => n + r.pageCount, 0);
    const seconds = valid.reduce((n, r) => n + r.wallMs / 1000, 0);
    const stages = {};
    for (const r of valid) for (const [key, value] of Object.entries(r.telemetry?.stages_s || {})) stages[key] = (stages[key] || 0) + value;
    return { caseIndex, models, successful: valid.length, excluded: runs.length - valid.length, pages,
      secondsPerPage: pages ? seconds / pages : null, pagesPerMinute: seconds ? pages * 60 / seconds : null,
      wallSeconds: distribution(valid.map(r => r.wallMs / 1000)),
      stagesSecondsPerPage: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, v / pages])) };
  });
}

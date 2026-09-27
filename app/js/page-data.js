// page-data.js — a page's pipeline data: what each translation stage produced, kept with the page
// (record.pipeline) so translating again can skip the stages whose settings, code and models are
// unchanged. The translation server keeps nothing between jobs: it returns this data with each
// finished page and accepts it back with a later job.
//
//   pipeline = { job, lines, read, regions, bubbles?, end?, masks: { raw?: Blob, text?: Blob } }
//
// `job` names the gallery's translation entry (metadata.translations[job] = { at, config, builds })
// that produced the page. The rest is the server's record, stored as received — or absent, when the
// page kept no data (snapshots are off in Settings → Translation, or the worker returned none):
// such a page is current while its translation's settings are, and otherwise runs every step. A page
// translated on its own also carries `record.own`: the entry whose settings it keeps (see
// translationGroups).

import { hasTranslation } from './page-image.js';

export const STAGES = ['prepare', 'detect', 'ocr', 'merge', 'translate', 'mask', 'inpaint', 'bubbles', 'render'];
const ORDER = Object.fromEntries(STAGES.map((stage, i) => [stage, i]));
const KEEPABLE = ['translate', 'mask', 'bubbles'];
const BLOBS = ['raw', 'text'];
// "Re-run from…" choices → the first stage each runs (inpainting redoes its mask too).
export const RERUN_POINTS = { detect: 'detect', ocr: 'ocr', translate: 'translate', inpaint: 'mask', render: 'render' };

const _earlier = (a, b) => (a == null ? b : b == null ? a : ORDER[a] <= ORDER[b] ? a : b);

// ── Container: [u32 BE JSON length][JSON][raw mask][text mask] ─────────────────────────────────
// Masks are lossless WebP, or PNG for a page too long for WebP; the bytes say which.
const _maskType = (u8) => (u8[0] === 0x89 ? 'image/png' : 'image/webp');

export function decodePageData(u8) {
  try {
    if (u8.length < 4) return null;
    const size = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0);
    if (4 + size > u8.length) return null;
    const record = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + size)));
    if (!record || typeof record !== 'object' || !Array.isArray(record.lines)) return null;
    const sizes = record.blobs || {};
    delete record.blobs;
    const masks = {};
    let offset = 4 + size;
    for (const name of BLOBS) {
      if (!(name in sizes)) continue;
      const bytes = u8.slice(offset, offset + sizes[name]);
      masks[name] = new Blob([bytes], { type: _maskType(bytes) });
      offset += sizes[name];
    }
    return offset === u8.length ? { record, masks } : null;
  } catch { return null; }
}

// The container for a job request: the page's stored data plus where the run starts.
export function encodePageData(pipeline, plan) {
  const { job, masks = {}, ...record } = pipeline;
  const blobs = BLOBS.filter(name => masks[name] instanceof Blob);
  const head = new TextEncoder().encode(JSON.stringify({
    ...record, from: plan.from, keep: plan.keep,
    ...(blobs.length ? { blobs: Object.fromEntries(blobs.map(name => [name, masks[name].size])) } : {}),
  }));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, head.length);
  return new Blob([size, head, ...blobs.map(name => masks[name])], { type: 'application/octet-stream' });
}

// ── What changed ────────────────────────────────────────────────────────────────────────────
function _value(doc, path) {
  let v = doc;
  for (const part of path.split('.')) v = v == null ? undefined : v[part];
  return v;
}
const _same = (a, b) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function _changed(stage, entry, resolved) {
  return entry.builds?.[stage] !== resolved.builds[stage]
    || (resolved.fields[stage] || []).some(path => !_same(_value(entry.config, path), _value(resolved.config, path)));
}

// The first stage whose output would differ from what `entry` produced, under `resolved` (the
// server's resolve document for the new config); null when none would. Stages the new config
// doesn't run (balloons for a renderer without them) never count.
export function firstChange(entry, resolved) {
  return STAGES.find(stage => stage in resolved.builds && _changed(stage, entry, resolved)) || null;
}

// The latest stage a run can start from with only this data: every earlier stage must be
// restorable. Inpainting and rendering always run; a text-less page restores entirely.
export function latestStart(pipeline) {
  if (!pipeline || !Array.isArray(pipeline.lines)) return 'prepare';
  if (pipeline.end) return 'render';
  const masks = pipeline.masks || {};
  if (pipeline.lines.length && !(masks.raw instanceof Blob)) return 'detect';
  if (!Array.isArray(pipeline.read)) return 'ocr';
  if (!Array.isArray(pipeline.regions)) return 'merge';
  if (!pipeline.regions.every(region => typeof region.tr === 'string')) return 'translate';
  if (pipeline.regions.some(region => region.keep !== false) && !(masks.text instanceof Blob)) return 'mask';
  return 'render';
}

// One page's plan for a job: null when the page is current (not sent), otherwise
// { from, keep, data } — `data` false means the page has nothing usable and runs in full.
// `changes` memoizes firstChange per translation entry.
export function planPage(rec, entries, resolved, changes, rerun = null) {
  const pipeline = rec.pipeline;
  const entry = pipeline && entries[pipeline.job];
  const forced = rerun ? RERUN_POINTS[rerun] || null : null;
  if (!entry) return { from: 'prepare', keep: [], data: false };
  if (!changes.has(pipeline.job)) changes.set(pipeline.job, firstChange(entry, resolved));
  let start = _earlier(changes.get(pipeline.job), forced);
  // A page that stopped before the first change is unaffected by it.
  if (pipeline.end && (start == null || ORDER[start] > ORDER[pipeline.end])) start = null;
  // Output removed (a revert): render again from the saved data.
  if (start == null && !hasTranslation(rec)) start = 'render';
  if (start == null) return null;
  const from = _earlier(start, latestStart(pipeline));
  if (from === 'prepare') return { from, keep: [], data: false };
  const kept = { translate: () => pipeline.regions?.length && pipeline.regions.every(r => typeof r.tr === 'string'),
                 mask: () => pipeline.masks?.text instanceof Blob, bubbles: () => Array.isArray(pipeline.bubbles) };
  const keep = KEEPABLE.filter(stage => ORDER[stage] >= ORDER[from] && stage in resolved.builds
    && !_changed(stage, entry, resolved) && !(forced && ORDER[stage] >= ORDER[forced]) && kept[stage]());
  return { from, keep, data: true };
}

// "Re-run from…": per choice, how many pages it affects and how many of them have the saved data
// to start there (the rest run in full). Pages that stop before a stage are unaffected by it.
export function rerunAvailability(records) {
  const out = {};
  for (const [point, stage] of Object.entries(RERUN_POINTS)) {
    let pages = 0, ready = 0;
    for (const rec of records) {
      const pipeline = rec.pipeline;
      if (pipeline?.end && ORDER[pipeline.end] < ORDER[stage]) continue;
      pages++;
      if (pipeline && ORDER[latestStart(pipeline)] >= ORDER[stage]) ready++;
    }
    out[point] = { pages, ready };
  }
  return out;
}

// ── Pages that keep their own settings ─────────────────────────────────────────────────────────
// A page translated on its own keeps that translation's settings: `record.own` names the gallery
// entry holding them, so a gallery translation leaves the page on them instead of the current
// ones. The server runs one config per job, so a gallery translates in groups of pages that share
// settings: the pages following the current settings first (own: null), then each kept setting,
// oldest first. A page whose kept entry is gone follows the current settings.
export function translationGroups(records, entries) {
  const groups = new Map([[null, []]]);
  for (const rec of records) {
    const own = rec.own && entries[rec.own] ? rec.own : null;
    if (!groups.has(own)) groups.set(own, []);
    groups.get(own).push(rec);
  }
  return [...groups].map(([own, pages]) => ({ own, pages }))
    .sort((a, b) => (a.own === null ? -1 : b.own === null ? 1 : entries[a.own].at - entries[b.own].at));
}

// The config a kept page runs with: the settings its translation recorded, over the current ones
// (which still supply what no stage reads). `translator.gpt_config` is recorded as a digest of the
// server-side file it names, which can't be sent back; the app never sets it.
export function keptConfig(base, recorded) {
  const merge = (a, b) => {
    const out = { ...a };
    for (const [key, value] of Object.entries(b || {})) {
      out[key] = value && typeof value === 'object' && !Array.isArray(value) && a?.[key] && typeof a[key] === 'object'
        ? merge(a[key], value) : value;
    }
    return out;
  };
  const config = merge(base, recorded);
  if (config.translator) {
    config.translator = { ...config.translator };
    delete config.translator.gpt_config;
  }
  return config;
}

// The gallery's translation entries some page still comes from or keeps; the rest can go.
export function referencedTranslations(entries, records) {
  const used = new Set(records.flatMap(rec => [rec.pipeline?.job, rec.own]).filter(Boolean));
  return Object.fromEntries(Object.entries(entries || {}).filter(([id]) => used.has(id)));
}

// What a context-aware translator starts from when a job begins at `first` rather than page 1:
// the saved source texts and translations of the pages before it (oldest first, those with any) —
// from their snapshots, or from their study data when snapshots weren't saved.
const CONTEXT_PAGES = 8;   // the server reads its last --context-size of them (4 by default)
const _CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
export function contextBefore(records, first, pageNum) {
  const before = records.filter(rec => pageNum(rec.url) < pageNum(first.url))
    .sort((a, b) => pageNum(a.url) - pageNum(b.url));
  const pages = [];
  for (const rec of before) {
    const { lines, regions } = rec.pipeline || {};
    const kept = (regions || []).filter(region => region.keep !== false && typeof region.tr === 'string');
    if (kept.length) {
      const source = (region) => region.text ?? region.lines.map(i => lines?.[i]?.text ?? '')
        .join(/^(ja|zh|ko)/.test(region.lang || '') ? '' : ' ');
      pages.push({ src: kept.map(source), tr: kept.map(region => region.tr) });
      continue;
    }
    // A study balloon keeps its text with the renderer's line breaks: joined as the source reads.
    const balloons = (Array.isArray(rec.bubbles) ? rec.bubbles : []).filter(b => b?.tr && b.src);
    if (balloons.length) {
      const join = (text, cjk) => String(text).split(/\r?\n/).join(cjk ? '' : ' ');
      pages.push({ src: balloons.map(b => join(b.src, _CJK.test(b.src))), tr: balloons.map(b => join(b.tr, false)) });
    }
  }
  return pages.slice(-CONTEXT_PAGES);
}

// reader-properties.js — "Page properties" (I, or the page's right-click menu): everything stored
// for one page, organized — its images, how it was translated (settings, the build of each step and
// where a new translation would start), what each pipeline step saved and how big it is, its study
// layers and its text — plus all of it as JSON, so nothing has to be dug out of an export.

import * as api from './api.js';
import { kv } from './platform.js';
import { t, getLang } from './i18n.js';
import { formatBytes } from './format.js';
import { latestStart } from './page-data.js';
import { hasTranslation } from './page-image.js';
import { previewPagePlans } from './translate.js';

// ── The page, described (pure: the inputs are the stored record, its gallery's metadata and each
// image's inspection, so this runs anywhere) ────────────────────────────────────────────────────
const _bytes = (value) => new TextEncoder().encode(JSON.stringify(value ?? null)).length;
const _source = (region, lines) => region.text ?? (region.lines || []).map(i => lines?.[i]?.text ?? '')
  .join(/^(ja|zh|ko)/.test(region.lang || '') ? '' : ' ');

// `images` holds inspectImage() results: original, translated, raw, text (masks), bg, layers[].
export function describePage({ record, meta, images = {} }) {
  const pipeline = record.pipeline || null;
  const entries = meta?.translations || {};
  const entry = pipeline ? entries[pipeline.job] || null : null;
  const translatedOut = hasTranslation(record);
  const saved = Array.isArray(pipeline?.lines);   // a page can name its translation yet keep no steps
  const out = {
    url: record.url, galleryId: record.galleryId, mediaId: record.mediaId ?? null, added: record.cachedAt ?? null,
    original: images.original || null,
    translated: record.translated != null ? images.translated || null : null,
    layered: translatedOut && record.translated == null,   // the page is its study layers
    status: translatedOut ? 'translated' : saved ? 'reverted' : 'none',
    own: !!(record.own && entries[record.own]),
    job: pipeline?.job ?? null, entry,
    steps: null, study: null, text: [],
  };
  if (saved) {
    const { masks = {}, ...data } = pipeline;
    const regions = pipeline.regions || [];
    out.steps = {
      recordBytes: _bytes(data),
      fields: Object.fromEntries(['lines', 'read', 'regions', 'bubbles'].filter(k => k in data).map(k => [k, _bytes(data[k])])),
      lines: (pipeline.lines || []).length,
      read: Array.isArray(pipeline.read) ? pipeline.read.length : null,
      regions: Array.isArray(pipeline.regions) ? regions.length : null,
      filtered: regions.filter(r => r.keep === false).length,
      translations: regions.filter(r => typeof r.tr === 'string').length,
      bubbles: Array.isArray(pipeline.bubbles) ? pipeline.bubbles.length : null,
      bubblesBytes: Array.isArray(pipeline.bubbles) ? _bytes(pipeline.bubbles) : 0,
      raw: masks.raw instanceof Blob ? images.raw || { bytes: masks.raw.size } : null,
      mask: masks.text instanceof Blob ? images.text || { bytes: masks.text.size } : null,
      end: pipeline.end || null,
      restart: latestStart(pipeline),
    };
    out.steps.bytes = out.steps.recordBytes + (out.steps.raw?.bytes || 0) + (out.steps.mask?.bytes || 0);
    out.text = regions.map(r => ({ src: _source(r, pipeline.lines), tr: typeof r.tr === 'string' ? r.tr : null, filtered: r.keep === false }));
  }
  if (Array.isArray(record.bubbles) && record.bubbles.length) {
    const layers = record.bubbles.filter(b => b.text instanceof Blob);
    out.study = {
      balloons: record.bubbles.length,
      bg: record.studyBg ? images.bg || { bytes: record.studyBg.size } : null,
      layers: layers.length, layersBytes: layers.reduce((s, b) => s + b.text.size, 0), layersFormat: images.layers?.format || null,
      metaBytes: _bytes({ bubbles: record.bubbles.map(({ text, ...rest }) => rest), page: record.studyPage ?? null }),
    };
    out.study.bytes = (out.study.bg?.bytes || 0) + out.study.layersBytes + out.study.metaBytes;
    if (!out.text.length) out.text = record.bubbles.map(b => ({ src: b.src || '', tr: b.tr || null, filtered: false }));
  }
  const parts = { original: out.original?.bytes || 0, translated: out.translated?.bytes || 0,
    steps: out.steps?.bytes || 0, study: out.study?.bytes || 0 };
  out.storage = { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
  return out;
}

// ── Images ────────────────────────────────────────────────────────────────────────────────────
// Format from the bytes (a stored type can be wrong), dimensions from a decode.
function _format(u8) {
  const at = (i, ...v) => v.every((b, k) => u8[i + k] === b);
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'WebP';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'PNG';
  if (at(0, 0xff, 0xd8, 0xff)) return 'JPEG';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'GIF';
  if (at(4, 0x66, 0x74, 0x79, 0x70) && at(8, 0x61, 0x76, 0x69)) return 'AVIF';
  if (at(0, 0x42, 0x4d)) return 'BMP';
  return null;
}

export async function inspectImage(blob) {
  if (!(blob instanceof Blob)) return null;
  const info = { bytes: blob.size, format: _format(new Uint8Array(await blob.slice(0, 16).arrayBuffer())), w: null, h: null };
  try {
    const bitmap = await createImageBitmap(blob);
    info.w = bitmap.width; info.h = bitmap.height;
    bitmap.close();
  } catch {}
  return info;
}

// ── Words and figures (pure: what the dialog writes for each value) ─────────────────────────────
export const stepName = (stage) => t(`page.step.${stage}`);
export const dims = (i) => (i?.w ? `${i.w} × ${i.h}` : '');
export const share = (part, whole) => (whole ? new Intl.NumberFormat(getLang(), { style: 'percent', maximumFractionDigits: part / whole < 0.1 ? 1 : 0 }).format(part / whole) : '');
export const when = (ms) => (ms ? new Intl.DateTimeFormat(getLang(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) : '');
export const joined = (...parts) => parts.filter(Boolean).join(' · ');
export const imageLine = (i) => (i ? joined(dims(i), i.format, formatBytes(i.bytes)) : t('page.not_stored'));
export const megapixels = (i) => (i?.w ? t('page.megapixels', { n: new Intl.NumberFormat(getLang(), { maximumFractionDigits: 1 }).format(i.w * i.h / 1e6) }) : '');
export const times = (x) => t('page.times', { x: new Intl.NumberFormat(getLang(), { maximumFractionDigits: 1 }).format(x) });

// A translation's config, every key flattened to a dotted name and its value as JSON.
export function flattenSettings(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flattenSettings(v, prefix ? `${prefix}.${k}` : k, out);
  } else out.push([prefix, value === null ? '—' : JSON.stringify(value)]);
  return out;
}

// Where a translation made again would start (previewPagePlans' plan for the gallery or the page).
export function planText(plan) {
  if (plan === null) return t('page.again_current');
  if (!plan.data) return t('page.again_full');
  const keeps = plan.keep.length ? ` · ${t('page.again_keeps', { steps: plan.keep.map(stepName).join(', ') })}` : '';
  return t('page.again_from', { step: stepName(plan.from) }) + keeps;
}

// ── The dialog ────────────────────────────────────────────────────────────────────────────────
// The one page draws it: the reader's route registers a host here (setPropertiesHost,
// src/routes/reader/properties-store.ts) before it starts the reader. This reads the page and hands
// each step to the host, which draws it (src/routes/reader/properties.tsx).
let _host = null;
export function setPropertiesHost(host) {
  _host = host;
  return () => { if (_host === host) _host = null; };
}
const _drawer = () => {
  if (!_host) throw new Error('reader-properties.js: no page properties host has registered (setPropertiesHost)');
  return _host;
};
export const propertiesOpen = () => !!_host?.isOpen();
export function closePageProperties() { _host?.close(); }

// All of it as JSON, on the clipboard: the description without its text, the pipeline without its
// masks, the study layers' balloons without their pictures.
async function _copyJson(info, record) {
  const { masks: _, ...data } = record.pipeline || {};
  const json = { ...info, text: undefined, pipeline: record.pipeline ? data : null, study: info.study && { ...info.study,
    page: record.studyPage ?? null, balloons: (record.bubbles || []).map(({ text: _t, ...rest }) => rest) } };
  try { await navigator.clipboard.writeText(JSON.stringify(json, null, 2)); return true; }
  catch { return false; }
}

// `page`: { gid, pageNum, url, number, total, chapter } — gid and pageNum say which stored page it
// is; chapter is a label for a series, else null.
export async function openPageProperties(page) {
  const view = _drawer().open(page);   // shown at once, loading
  const record = await api.pages.get(page.gid, page.pageNum).catch(() => null);
  if (!view.live()) return;
  if (!record) { view.missing(); return; }
  const meta = await api.meta.get(record.galleryId).catch(() => null);
  const masks = record.pipeline?.masks || {};
  const [original, translated, raw, text, bg, layer] = await Promise.all([record.blob, record.translated, masks.raw, masks.text,
    record.studyBg, (record.bubbles || []).find(b => b.text instanceof Blob)?.text].map(inspectImage));
  if (!view.live()) return;
  const info = describePage({ record, meta, images: { original, translated, raw, text, bg, layers: layer } });
  const thumb = record.translated instanceof Blob && info.status === 'translated' ? record.translated : record.blob;
  view.ready({ info, thumb: thumb instanceof Blob ? thumb : null, copy: () => _copyJson(info, record) });

  // Where a new translation would start needs the server; filled in when it answers.
  const settings = (await kv.get('translateSettings')).translateSettings;
  const preview = await previewPagePlans(record.galleryId, record.pageNum, settings).catch(() => ({ unavailable: 'offline' }));
  if (!view.live()) return;
  view.again(preview);
}

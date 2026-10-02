// reader-properties.js — "Page properties" (I, or the page's right-click menu): everything stored
// for one page, organized — its images, how it was translated (settings, the build of each step and
// where a new translation would start), what each pipeline step saved and how big it is, its study
// layers and its text — plus all of it as JSON, so nothing has to be dug out of an export.

import * as api from './api.js';
import { kv } from './platform.js';
import { t, getLang } from './i18n.js';
import { formatBytes, formatCount } from './format.js';
import { STAGES, latestStart } from './page-data.js';
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

// ── Formatting ────────────────────────────────────────────────────────────────────────────────
const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
const _step = (stage) => t(`page.step.${stage}`);
const _dims = (i) => (i?.w ? `${i.w} × ${i.h}` : '');
const _pct = (part, whole) => (whole ? new Intl.NumberFormat(getLang(), { style: 'percent', maximumFractionDigits: part / whole < 0.1 ? 1 : 0 }).format(part / whole) : '');
const _date = (ms) => (ms ? new Intl.DateTimeFormat(getLang(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) : '');
const _join = (...parts) => parts.filter(Boolean).join(' · ');
const _image = (i) => (i ? _join(_dims(i), i.format, formatBytes(i.bytes)) : t('page.not_stored'));

function _rows(pairs) {
  const dl = node('dl', 'pp-grid');
  for (const [label, value] of pairs) {
    if (value == null || value === '') continue;
    dl.append(node('dt', '', label));
    const dd = node('dd');
    if (value instanceof Node) dd.append(value); else dd.textContent = value;
    dl.append(dd);
  }
  return dl;
}

function _section(title, meta) {
  const sec = node('section', 'pp-sec');
  const h = node('h3', '', title);
  if (meta) h.append(node('span', 'pp-sec-meta', meta));
  sec.append(h);
  return sec;
}

function _details(summary, content, open = false) {
  const d = node('details', 'pp-details');
  d.open = open;
  d.append(node('summary', '', summary), content);
  return d;
}

function _flatten(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) _flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out.push([prefix, value === null ? '—' : JSON.stringify(value)]);
  return out;
}

function _planText(plan) {
  if (plan === null) return t('page.again_current');
  if (!plan.data) return t('page.again_full');
  const keeps = plan.keep.length ? ` · ${t('page.again_keeps', { steps: plan.keep.map(_step).join(', ') })}` : '';
  return t('page.again_from', { step: _step(plan.from) }) + keeps;
}

// ── The modal ─────────────────────────────────────────────────────────────────────────────────
let _dialog = null;
export const propertiesOpen = () => !!_dialog?.open;
export function closePageProperties() { _dialog?.close(); }

// `page`: { gid, pageNum, url, number, total, chapter } — gid and pageNum say which stored page it
// is; chapter is a label for a series, else null.
export async function openPageProperties(page) {
  closePageProperties();
  const dialog = _dialog = node('dialog', 'pp-dialog');
  const titleId = 'pp-' + crypto.randomUUID();
  dialog.setAttribute('aria-labelledby', titleId);
  const head = node('header', 'pp-head');
  const heading = node('div');
  const title = node('h2', 'pp-title', t('page.properties')); title.id = titleId;
  heading.append(title, node('p', 'pp-sub', _join(page.chapter, t('page.of', { n: formatCount(page.number), total: formatCount(page.total) }))));
  const copy = node('button', 'pp-btn', t('page.copy')); copy.type = 'button'; copy.disabled = true;
  const close = node('button', 'pp-close', '×'); close.type = 'button';
  close.setAttribute('aria-label', t('common.close')); close.title = t('common.close');
  const actions = node('div', 'pp-actions'); actions.append(copy, close);
  head.append(heading, actions);
  const body = node('div', 'pp-body');
  body.append(node('p', 'pp-note', t('page.loading')));
  dialog.append(head, body);
  document.body.append(dialog);
  const urls = [];
  close.onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });   // the backdrop
  // The ::backdrop belongs to no scroller, so a wheel or swipe over it would scroll the pages
  // behind; scrolls over the dialog itself stay in it (overscroll-behavior: contain).
  const holdPage = (e) => {
    const p = e.touches ? e.touches[0] : e;
    const r = dialog.getBoundingClientRect();
    if (p.clientX < r.left || p.clientX > r.right || p.clientY < r.top || p.clientY > r.bottom) e.preventDefault();
  };
  dialog.addEventListener('wheel', holdPage, { passive: false });
  dialog.addEventListener('touchmove', holdPage, { passive: false });
  dialog.addEventListener('close', () => {
    urls.forEach(u => URL.revokeObjectURL(u));
    dialog.remove();
    if (_dialog === dialog) _dialog = null;
  });
  dialog.showModal();

  const record = await api.pages.get(page.gid, page.pageNum).catch(() => null);
  if (!dialog.open) return;
  if (!record) { body.replaceChildren(node('p', 'pp-note', t('page.not_stored'))); return; }
  const meta = await api.meta.get(record.galleryId).catch(() => null);
  const masks = record.pipeline?.masks || {};
  const [original, translated, raw, text, bg, layer] = await Promise.all([record.blob, record.translated, masks.raw, masks.text,
    record.studyBg, (record.bubbles || []).find(b => b.text instanceof Blob)?.text].map(inspectImage));
  if (!dialog.open) return;
  const info = describePage({ record, meta, images: { original, translated, raw, text, bg, layers: layer } });
  body.replaceChildren(..._render(info, record, urls));

  copy.disabled = false;
  copy.onclick = async () => {
    const { masks: _, ...data } = record.pipeline || {};
    const json = { ...info, text: undefined, pipeline: record.pipeline ? data : null, study: info.study && { ...info.study,
      page: record.studyPage ?? null, balloons: (record.bubbles || []).map(({ text: _t, ...rest }) => rest) } };
    try { await navigator.clipboard.writeText(JSON.stringify(json, null, 2)); copy.textContent = t('page.copied'); }
    catch { copy.textContent = t('page.copy_failed'); }
    setTimeout(() => { copy.textContent = t('page.copy'); }, 1600);
  };

  // Where a new translation would start needs the server; filled in when it answers.
  const again = body.querySelector('[data-again]');
  if (!again) return;
  const settings = (await kv.get('translateSettings')).translateSettings;
  const preview = await previewPagePlans(record.galleryId, record.pageNum, settings).catch(() => ({ unavailable: 'offline' }));
  if (!dialog.open) return;
  if (preview.unavailable) { again.replaceChildren(_rows([[t('page.again'), t(`page.again_${preview.unavailable}`)]])); return; }
  again.replaceChildren(_rows([
    [t('page.again_gallery'), _planText(preview.gallery)],
    [t('page.translate'), _planText(preview.page)],
  ]));
}

function _render(info, record, urls) {
  const out = [];
  const original = info.original?.bytes || 0;

  // Overview: the page, its state, and what it takes to store it.
  const hero = node('section', 'pp-hero');
  const thumbSrc = record.translated instanceof Blob && info.status === 'translated' ? record.translated : record.blob;
  if (thumbSrc instanceof Blob) {
    const img = node('img', 'pp-thumb'); img.alt = '';
    img.src = URL.createObjectURL(thumbSrc); urls.push(img.src);
    hero.append(img);
  }
  const summary = node('div', 'pp-hero-info');
  summary.append(node('div', 'pp-hero-dims', _join(_dims(info.original), info.original?.format)));
  const chips = node('div', 'pp-chips');
  chips.append(node('span', `pp-chip ${info.status}`, t(`page.status_${info.status}`)));
  if (info.status !== 'none') chips.append(node('span', `pp-chip${info.own ? ' own' : ''}`, t(info.own ? 'page.keeps_own' : 'page.follows')));
  if (info.study) chips.append(node('span', 'pp-chip', t('page.study')));
  summary.append(chips);
  const total = node('div', 'pp-total');
  total.append(document.createTextNode(`${t('page.stored')} `), node('b', '', formatBytes(info.storage.total)));
  if (original) total.append(document.createTextNode(` · ${t('page.times', { x: new Intl.NumberFormat(getLang(), { maximumFractionDigits: 1 }).format(info.storage.total / original) })}`));
  summary.append(total);
  const bar = node('div', 'pp-bar');
  const legend = node('ul', 'pp-legend');
  for (const [key, label] of [['original', 'page.original'], ['translated', 'page.translated'], ['steps', 'page.steps'], ['study', 'page.study']]) {
    const bytes = info.storage[key];
    if (!bytes) continue;
    const seg = node('span', `pp-seg c-${key}`);
    seg.style.flexGrow = String(bytes);
    seg.title = `${t(label)} · ${formatBytes(bytes)}`;
    bar.append(seg);
    const li = node('li');
    li.append(node('i', `c-${key}`), document.createTextNode(`${t(label)} `), node('b', '', formatBytes(bytes)));
    if (original && key !== 'original') li.append(node('span', 'pp-dim', ` ${_pct(bytes, original)}`));
    legend.append(li);
  }
  summary.append(bar, legend);
  hero.append(summary);
  out.push(hero);

  // Images.
  const images = _section(t('page.images'));
  const mp = (i) => (i?.w ? t('page.megapixels', { n: new Intl.NumberFormat(getLang(), { maximumFractionDigits: 1 }).format(i.w * i.h / 1e6) }) : '');
  images.append(_rows([
    [t('page.original'), _join(_image(info.original), mp(info.original))],
    [t('page.translated'), info.translated ? _join(_image(info.translated), t('page.of_original', { pct: _pct(info.translated.bytes, original) }))
      : info.layered ? t('page.rebuilt') : null],
    [t('page.added'), _date(info.added)],
    [t('page.source'), node('span', 'pp-mono pp-wrap', info.url)],
  ]));
  out.push(images);

  // Translation: what made the page, and what would change it.
  const tr = _section(t('page.translation'));
  if (info.entry) {
    const c = info.entry.config || {};
    const size = (v) => (v ? ` · ${formatCount(v)}` : '');
    tr.append(_rows([
      [t('page.made'), _join(_date(info.entry.at), info.job)],
      [t('page.settings'), t(info.own ? 'page.keeps_own' : 'page.follows')],
      [t('tm.translator'), c.translator?.translator && c.translator.translator + (c.translator.target_lang ? ` → ${c.translator.target_lang}` : '')],
      [t('tm.ocr_model'), c.ocr?.ocr],
      [t('tm.detector'), c.detector?.detector && c.detector.detector + size(c.detector.detection_size)],
      [t('tm.inpainter'), c.inpainter?.inpainter && c.inpainter.inpainter + size(c.inpainter.inpainting_size)],
      [t('tm.renderer'), c.render?.renderer],
    ]));
    const settings = _flatten(c);
    const all = node('dl', 'pp-grid pp-mono');
    for (const [k, v] of settings) all.append(node('dt', '', k), node('dd', '', v));
    tr.append(_details(t('page.all_settings', { n: formatCount(settings.length) }), all));
    const builds = node('dl', 'pp-grid pp-mono');
    for (const stage of STAGES) if (info.entry.builds?.[stage]) builds.append(node('dt', '', _step(stage)), node('dd', '', info.entry.builds[stage]));
    const buildsBox = node('div');
    buildsBox.append(node('p', 'pp-note', t('page.builds_note')), builds);
    tr.append(_details(t('page.builds', { n: formatCount(Object.keys(info.entry.builds || {}).length) }), buildsBox));
  } else {
    tr.append(node('p', 'pp-note', t('page.no_translation')));
  }
  const again = node('div', 'pp-again'); again.dataset.again = '';
  again.append(_rows([[t('page.again'), t('page.again_checking')]]));
  tr.append(again);
  out.push(tr);

  // What each step saved: what a new translation reuses instead of running.
  const s = info.steps;
  const steps = _section(t('page.steps'), s ? `${formatBytes(s.bytes)}${original ? ` · ${_pct(s.bytes, original)}` : ''}` : '');
  if (!s) {
    steps.append(node('p', 'pp-note', t('page.nothing_saved')));
  } else {
    const table = node('table', 'pp-steps');
    const row = (stage, what, bytes) => {
      const tr_ = node('tr');
      tr_.append(node('th', '', _step(stage)), node('td', '', what), node('td', 'pp-num', bytes ? formatBytes(bytes) : ''));
      table.append(tr_);
    };
    const maskText = (m) => _join(_dims(m), m?.format);
    row('detect', _join(t('page.lines', { n: formatCount(s.lines) }), s.raw && `${t('page.raw_mask')} ${maskText(s.raw)}`), s.raw?.bytes);
    if (s.read != null) row('ocr', t('page.read', { n: formatCount(s.read) }));
    if (s.regions != null) row('merge', _join(t('page.regions', { n: formatCount(s.regions) }), s.filtered && t('page.filtered', { n: formatCount(s.filtered) })));
    if (s.regions) row('translate', t('page.translations', { n: formatCount(s.translations) }));
    if (s.mask) row('mask', maskText(s.mask), s.mask.bytes);
    if (s.bubbles != null) row('bubbles', t('page.balloons', { n: formatCount(s.bubbles) }), s.bubbles ? s.bubblesBytes : 0);
    const rec = node('tr', 'pp-total-row');
    const fields = Object.entries(s.fields).map(([k, v]) => `${k} ${formatBytes(v)}`).join(' · ');
    rec.append(node('th', '', t('page.record')), node('td', 'pp-dim', fields), node('td', 'pp-num', formatBytes(s.recordBytes)));
    table.append(rec);
    steps.append(table);
    steps.append(node('p', 'pp-note', s.end ? t('page.stopped', { step: _step(s.end) }) : t('page.restart', { step: _step(s.restart) })));
    steps.append(node('p', 'pp-note', t('page.always_run')));
  }
  out.push(steps);

  // Study layers.
  const st = info.study;
  const study = _section(t('page.study'), st ? formatBytes(st.bytes) : '');
  if (!st) study.append(node('p', 'pp-note', t('page.no_study')));
  else study.append(_rows([
    [t('page.balloons_label'), formatCount(st.balloons)],
    [t('page.background'), st.bg ? _image(st.bg) : null],
    [t('page.text_layers'), st.layers ? _join(formatCount(st.layers), st.layersFormat, formatBytes(st.layersBytes)) : null],
    [t('page.metadata'), formatBytes(st.metaBytes)],
  ]));
  out.push(study);

  // The page's text.
  const text = node('section', 'pp-sec');
  if (!info.text.length) {
    text.append(node('h3', '', t('page.text')), node('p', 'pp-note', t('page.no_text')));
  } else {
    const table = node('table', 'pp-text');
    const head = node('tr');
    head.append(node('th', '', '#'), node('th', '', t('page.col_source')), node('th', '', t('page.col_translation')));
    table.append(head);
    info.text.forEach((r, i) => {
      const row = node('tr', r.filtered ? 'filtered' : '');
      const tr_ = node('td', '', r.tr ?? '—');
      if (r.filtered) tr_.append(node('span', 'pp-tag', t('page.filtered_tag')));
      row.append(node('td', 'pp-num', String(i + 1)), node('td', 'pp-src', r.src), tr_);
      table.append(row);
    });
    text.append(_details(`${t('page.text')} (${formatCount(info.text.length)})`, table, true));
  }
  out.push(text);
  return out;
}

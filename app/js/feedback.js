// Data-only feedback capture. Every page asset comes from the cached record: the images, the study
// layers, and the page's pipeline data with the config and builds of the translation behind it.
import { metaGet } from './db.js';
import { translatedImage } from './page-image.js';
import { zipCreate } from './zip.js';

export const ISSUES = ['placement', 'readability', 'line_breaks', 'overflow', 'grouping', 'ocr', 'translation', 'other'];
export const sha256 = async blob => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const bubbleKeys = ['id', 'lineIds', 'src', 'tr', 'rawTr', 'box', 'region', 'rbox', 'tbox', 'style', 'furi', 'shape'];
export const bubbleData = b => pick(b, bubbleKeys);

// Do not use imageToBlob: its URL fallback is useful to readers but feedback must be cache-only.
async function cachedBlob(value) {
  if (value instanceof Blob) return value;
  if (typeof value !== 'string' || !value.startsWith('data:')) return null;
  const match = value.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!match) return null;
  const raw = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  return new Blob([Uint8Array.from(raw, c => c.charCodeAt(0))], { type: match[1] });
}

export async function captureFeedback(record, displayed, display, primaryIndex) {
  if (!record || !displayed?.bubbles?.[primaryIndex]) throw new Error('feedback.missing_page');
  // The mounted study layers must be this record's, from the translation that made its output.
  if ((displayed.job || null) !== (record.pipeline?.job || null)
      || JSON.stringify(displayed.bubbles.map(bubbleData)) !== JSON.stringify((record.bubbles || []).map(bubbleData))) {
    throw new Error('feedback.mismatch');
  }
  const assets = new Map();
  const missing = new Set();
  async function asset(value, label) {
    const blob = await cachedBlob(value);
    if (!blob) { if (label) missing.add(label); return null; }
    const hash = await sha256(blob), path = 'assets/' + hash;
    assets.set(path, blob);
    return { path, sha256: hash, bytes: blob.size, media_type: blob.type || 'application/octet-stream' };
  }
  const original = await asset(record.blob ?? record.dataUrl, 'original');
  const translated = await asset(await translatedImage(record), 'translated');
  const background = await asset(record.studyBg, 'study_background');
  const bubbles = [];
  for (const [i, b] of displayed.bubbles.entries()) {
    if (b.id == null) missing.add('original_region_ids');
    bubbles.push({ ...bubbleData(b), id: b.id ?? `legacy-${i}`, text: await asset(b.text, null) });
  }
  let pipeline = null, translation = null;
  if (record.pipeline) {
    const { masks = {}, ...data } = record.pipeline;
    pipeline = { ...data, masks: {} };
    for (const name of ['raw', 'text']) {
      const ref = await asset(masks[name], null);
      if (ref) pipeline.masks[name] = ref;
    }
    translation = (await metaGet(record.galleryId))?.translations?.[record.pipeline.job] || null;
    if (!Array.isArray(data.lines)) missing.add('pipeline');   // it names its translation but kept no steps
  } else {
    missing.add('pipeline');
  }
  const surface = ['original', 'ocr', 'translation'].includes(display.surface) ? display.surface : 'translation';
  if (surface === 'translation' && !bubbles[primaryIndex].tr && !bubbles[primaryIndex].text) missing.add('selected_translation');
  if (surface === 'ocr' && !bubbles[primaryIndex].src) missing.add('selected_ocr');
  return {
    assets,
    manifest: {
      schema: 'typesetting-feedback', version: 1, report_id: crypto.randomUUID().replaceAll('-', ''),
      created_at: new Date().toISOString(), issues: [], note: '',
      selection: { primary: bubbles[primaryIndex].id, related: [], surface },
      page: { number: display.pageNumber, size: record.studyPage || null, original, translated,
        study_background: background, bubbles },
      display, pipeline, translation,
      missing: [...missing], fidelity: missing.size ? 'incomplete' : 'complete',
    },
  };
}

export async function feedbackZip(capture) {
  const manifest = structuredClone(capture.manifest);
  const files = [{ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) }];
  for (const [name, blob] of capture.assets) files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
  return new Blob([zipCreate(files)], { type: 'application/zip' });
}

export function feedbackDestination(settings) {
  const configured = new URL(settings?.serverUrl || 'http://127.0.0.1:5003');
  const target = configured;
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error('feedback.server_invalid');
  }
  const server = target.href.replace(/\/+$/, '');
  const same = server === configured.href.replace(/\/+$/, '');
  return { server, headers: same && settings?.serverToken ? { 'X-Access-Token': settings.serverToken.trim() } : {} };
}

export async function feedbackRequest(destination, route, fields, asBlob = false) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await fetch(destination.server + route, { method: 'POST', body: form,
    headers: destination.headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return asBlob ? response.blob() : response.json();
}

export function feedbackKey(e) {
  return e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat && !e.isComposing;
}

export function editingTarget(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}

// Text nodes and glyph images are siblings of the click box. All carry the same owner index.
export function feedbackTarget(element) {
  const owner = element?.closest?.('[data-feedback-index]');
  if (!owner || owner.dataset.feedbackVisible !== 'true') return null;
  const wrap = owner.closest('.page-wrap');
  return wrap ? { wrap, index: Number(owner.dataset.feedbackIndex), surface: owner.dataset.feedbackSurface || 'translation' } : null;
}

export function tagFeedback(el, index, visible = true, surface = 'translation') {
  if (!el) return;
  el.dataset.feedbackIndex = String(index);
  el.dataset.feedbackVisible = String(visible);
  el.dataset.feedbackSurface = surface;
}

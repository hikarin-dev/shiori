// translate.js — gallery translation engine (self-hosted manga-image-translator).
//
// Shared by the standalone/PWA app (which now owns translation) and, for parity, the extension's
// service worker. Pure logic: it reads a gallery's images from db.js, POSTs them to the translate
// server, and stores the translated variants. The caller passes the settings object and a progress
// callback — the app wires its own, the extension wires its job reporter.
//
// CORS: a web origin POSTing to the translate server needs permissive CORS headers from that server
// (the extension bypassed CORS via host permissions). See ARCHITECTURE-v2 §12 and the translator
// patches noted in the project memory.

import {
  getGalleryImageRecords, putTranslatedImage, clearGalleryTranslations,
  metaGet, metaPut, imageToBlob, imageToDataUrl,
} from './db.js';

const _pageNumOf = (url) => parseInt(url.match(/\/(\d+)\.\w+$/)?.[1] || '999999');
const BATCHABLE = new Set(['gemini', 'deepseek', 'chatgpt']);
const DEFAULT_BATCH_CAPS = { gemini: 8, deepseek: 8, chatgpt: 6 };
const _translating = new Set();

export function serverUrlFromSettings(ts) {
  return ((ts || {}).serverUrl || 'http://127.0.0.1:5003').replace(/\/+$/, '');
}

export async function pingServer(serverUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try { await fetch(`${serverUrl}/`, { signal: ctrl.signal }); return true; }
  catch { return false; }
  finally { clearTimeout(timer); }
}

export async function revertGallery(galleryId) {
  const gid = String(galleryId);
  await clearGalleryTranslations(gid);
  const meta = await metaGet(gid);
  if (meta?.translated) await metaPut({ ...meta, translated: false });
}

function buildConfig(ts) {
  const target = ts.targetLang || 'ENG';
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    translator: {
      translator: ts.translator || 'sugoi',
      target_lang: target,
      enable_post_translation_check: false,
      ...(ts.screenEnabled ? {
        content_screen_enabled: true,
        content_screen_translator: ts.screenTranslator || 'qwen2',
        content_screen_fallback_translator: ts.screenFallback || 'qwen2',
        content_screen_prompt: ts.screenPrompt || undefined,
      } : {}),
    },
    detector: {
      detector: ts.detector || 'default',
      detection_size: num(ts.detectionSize, 1536),
      text_threshold: num(ts.textThreshold, 0.5),
      box_threshold: num(ts.boxThreshold, 0.7),
      unclip_ratio: num(ts.unclipRatio, 2.3),
    },
    ocr: { ocr: ts.ocr || '48px' },
    inpainter: {
      inpainter: ts.inpainter || 'lama_large',
      inpainting_size: num(ts.inpaintingSize, 1536),
      inpainting_precision: ts.inpaintingPrecision || 'bf16',
    },
    render: {
      renderer: ts.renderer || (target === 'ENG' ? 'manga2eng' : 'default'),
      direction: ts.direction || 'auto',
      alignment: ts.alignment || 'auto',
      font_size_offset: num(ts.fontSizeOffset, 0),
      uppercase: !!ts.uppercase,
      no_hyphenation: !!ts.noHyphenation,
      ...(ts.fontColor ? { font_color: ts.fontColor } : {}),
    },
    mask_dilation_offset: num(ts.maskDilationOffset, 30),
    kernel_size: num(ts.kernelSize, 5),
  };
}

// POST one page; the stream returns framed status(1) + size(4 BE) + data. status 0 = final image,
// 2 = error, 1/3/4 = progress we ignore.
async function translateOneImage(serverUrl, config, img) {
  const form = new FormData();
  form.append('image', await imageToBlob(img), 'page.png');
  form.append('config', JSON.stringify(config));
  const resp = await fetch(`${serverUrl}/translate/with-form/image/stream`, { method: 'POST', body: form });
  if (!resp.ok) throw new Error(`server responded ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  let off = 0, resultBytes = null, errMsg = null;
  while (off + 5 <= buf.length) {
    const status = buf[off];
    const size = ((buf[off + 1] << 24) | (buf[off + 2] << 16) | (buf[off + 3] << 8) | buf[off + 4]) >>> 0;
    const data = buf.subarray(off + 5, off + 5 + size);
    off += 5 + size;
    if (status === 0) resultBytes = data;
    else if (status === 2) errMsg = new TextDecoder().decode(data);
  }
  if (errMsg) throw new Error(errMsg);
  if (!resultBytes) throw new Error('server returned no image');
  return imageToDataUrl(new Blob([resultBytes], { type: 'image/png' }));
}

// Translate a chunk of pages in one server request (shared translation call). Streams:
// status 1 = progress state → onProgress(state); 5 = finished page (4-byte BE index + PNG) →
// onPage(idx, dataUrl); 0 = final JSON summary; 2 = error.
async function translateGalleryChunk(serverUrl, config, pages, onProgress, onPage) {
  const form = new FormData();
  for (const p of pages) form.append('image', await imageToBlob(p.blob ?? p.dataUrl), 'page.png');
  form.append('config', JSON.stringify(config));
  const resp = await fetch(`${serverUrl}/translate/gallery/stream`, { method: 'POST', body: form });
  if (!resp.ok) throw new Error(`server responded ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = new Uint8Array(0);
  let summary = { count: pages.length, failed: [] };
  let errMsg = null, finished = false;
  while (true) {
    const { done, value } = await reader.read();
    if (value) { const next = new Uint8Array(buf.length + value.length); next.set(buf, 0); next.set(value, buf.length); buf = next; }
    let off = 0;
    while (buf.length - off >= 5) {
      const status = buf[off];
      const size = ((buf[off + 1] << 24) | (buf[off + 2] << 16) | (buf[off + 3] << 8) | buf[off + 4]) >>> 0;
      if (buf.length - off < 5 + size) break;
      const data = buf.subarray(off + 5, off + 5 + size);
      off += 5 + size;
      if (status === 1) { onProgress(dec.decode(data)); }
      else if (status === 5) {
        const idx = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
        const dataUrl = await imageToDataUrl(new Blob([data.subarray(4)], { type: 'image/png' }));
        await onPage(idx, dataUrl);
      } else if (status === 0) { try { summary = JSON.parse(dec.decode(data)); } catch {} finished = true; }
      else if (status === 2) { errMsg = dec.decode(data); finished = true; }
    }
    if (off > 0) buf = buf.slice(off);
    if (finished || done) break;
  }
  if (errMsg) throw new Error(errMsg);
  return summary;
}

// Translate every not-yet-translated page of a gallery. `ts` is the settings object; `onProgress`
// receives { status, done, total, label?, failed?, costNote?, error? }.
export async function translateGallery(galleryId, ts, onProgress = () => {}) {
  const gid = String(galleryId);
  if (_translating.has(gid)) return;
  _translating.add(gid);
  const send = onProgress;
  try {
    ts = ts || {};
    const serverUrl = serverUrlFromSettings(ts);
    const config = buildConfig(ts);
    const isContextMode = (config.translator.translator === 'chatgpt');
    const localHF = ['qwen2', 'qwen2_big', 'sugoi', 'nllb', 'nllb_big', 'm2m100', 'm2m100_big'].includes(config.translator.translator);
    const sequential = isContextMode || ['gemini', 'deepseek'].includes(config.translator.translator) || localHF;
    const isBatchable = BATCHABLE.has(config.translator.translator);

    const records = (await getGalleryImageRecords(gid)).filter(r => r.blob ?? r.dataUrl);
    const total = records.length;
    const pending = records.filter(r => r.translated === undefined).sort((a, b) => _pageNumOf(a.url) - _pageNumOf(b.url));
    let done = total - pending.length;

    if (pending.length === 0) {
      const meta = await metaGet(gid);
      if (meta && !meta.translated) await metaPut({ ...meta, translated: true });
      send({ status: 'done', done, total });
      return;
    }
    send({ status: 'started', done, total });

    if (isContextMode || isBatchable) await fetch(`${serverUrl}/reset-context`, { method: 'POST' }).catch(() => {});

    let failed = 0, firstError = null, cap = 0;
    if (isBatchable) {
      const caps = { ...DEFAULT_BATCH_CAPS, ...(ts.batchCaps || {}) };
      cap = Math.max(1, parseInt(caps[config.translator.translator], 10) || DEFAULT_BATCH_CAPS[config.translator.translator] || 8);
      for (let i = 0; i < pending.length; i += cap) {
        const chunk = pending.slice(i, i + cap);
        const stored = new Set();
        let ocrCount = 0;
        try {
          await translateGalleryChunk(serverUrl, config, chunk,
            (state) => {
              if (state === 'ocr') { ocrCount++; send({ status: 'progress', done, total, label: `Extracting text ${Math.min(ocrCount, chunk.length)}/${chunk.length}` }); }
              else if (state === 'translating') { send({ status: 'progress', done, total, label: `Translating ${chunk.length} page${chunk.length > 1 ? 's' : ''}…` }); }
            },
            async (idx, dataUrl) => {
              const rec = chunk[idx];
              if (rec) { await putTranslatedImage(rec.url, dataUrl); stored.add(idx); }
              done++;
              send({ status: 'progress', done, total, label: 'Rendering' });
            });
        } catch (e) { if (!firstError) firstError = e.message; }
        for (let k = 0; k < chunk.length; k++) { if (!stored.has(k)) { failed++; done++; } }
        send({ status: 'progress', done, total });
      }
    } else {
      let cursor = 0;
      const worker = async () => {
        while (cursor < pending.length) {
          const rec = pending[cursor++];
          try { await putTranslatedImage(rec.url, await translateOneImage(serverUrl, config, rec.blob ?? rec.dataUrl)); }
          catch (e) { failed++; if (!firstError) firstError = e.message; }
          done++;
          send({ status: 'progress', done, total });
        }
      };
      const CONCURRENCY = sequential ? 1 : 2;
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
    }

    if (failed === pending.length) { send({ status: 'error', error: firstError || 'translation failed' }); return; }

    const meta = await metaGet(gid);
    if (meta && !meta.translated) await metaPut({ ...meta, translated: true });

    let costNote = '';
    if (config.translator.translator === 'gemini') {
      const n = pending.length;
      const chunks = cap > 0 ? Math.ceil(n / cap) : n;
      const estIn = chunks * 800 + n * 215;
      const estOut = n * 600;
      const priceIn = Number(ts.priceIn ?? 1.5), priceOut = Number(ts.priceOut ?? 9);
      const usd = (estIn * priceIn + estOut * priceOut) / 1e6;
      costNote = `${chunks} call${chunks > 1 ? 's' : ''} · ~${((estIn + estOut) / 1000).toFixed(1)}K tokens · ~$${usd.toFixed(2)} est.`;
    }
    send({ status: 'done', done, total, failed, costNote });
  } catch (e) {
    send({ status: 'error', error: e.message });
  } finally {
    _translating.delete(gid);
  }
}

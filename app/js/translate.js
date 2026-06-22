// translate.js — gallery translation engine (self-hosted manga-image-translator).
//
// Shared by the standalone/PWA app (which now owns translation) and, for parity, the extension's
// service worker. Pure logic: it reads a gallery's images from db.js, POSTs them to the translate
// server, and stores the translated variants. The caller passes the settings object and a progress
// callback — the app wires its own, the extension wires its job reporter.
//
// The whole gallery goes up in ONE /translate/gallery/stream request. The server pipelines the
// stages (detect/OCR page by page, every `batch_size` pages share one translation call that runs
// while later pages keep preprocessing, finished pages render and stream back as status-5 frames),
// so the progress reads Reading → Translating → Rendering even though the stages overlap.
// batch_size is the token/cost knob for cloud LLM translators; per-page translators use 1.
//
// CORS: a web origin POSTing to the translate server needs permissive CORS headers from that server
// (the extension bypassed CORS via host permissions). See ARCHITECTURE-v2 §12 and the translator
// patches noted in the project memory.

import {
  getGalleryImageRecords, putTranslatedImage, clearGalleryTranslations,
  metaGet, metaPut, imageToBlob, imageToDataUrl,
} from './db.js';

const _pageNumOf = (url) => parseInt(url.match(/\/(\d+)\.\w+$/)?.[1] || '999999');
// Translators whose batch size is a real token/cost knob (one LLM call per batch).
// Everything else translates page by page (batch_size 1) but still rides the pipeline.
const BATCH_CAPPED = new Set(['gemini', 'deepseek', 'chatgpt']);
const DEFAULT_BATCH_CAPS = { gemini: 8, deepseek: 8, chatgpt: 6 };
const _translating = new Set();
// gid → { ctrl, serverUrl, jobToken } for the in-flight request, so cancelTranslate()
// can abort the fetch AND tell the server to stop the exact job (by token).
const _controllers = new Map();

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

// Cancel an in-flight gallery translation: abort the local fetch (frees this client at
// once) AND tell the server to stop that exact job by token, so the worker isn't left
// churning the GPU. Best-effort; safe to call when nothing is running. Runs in whichever
// context owns the request (the SW when a SW drives the job, else the tab).
export function cancelTranslate(galleryId) {
  const entry = _controllers.get(String(galleryId));
  if (!entry) return false;
  try { entry.ctrl.abort(); } catch {}
  if (entry.serverUrl && entry.jobToken) {
    const form = new FormData();
    form.append('job_token', entry.jobToken);
    fetch(`${entry.serverUrl}/translate/gallery/cancel`, { method: 'POST', body: form }).catch(() => {});
  }
  return true;
}

// manga-image-translator target-language codes → the card flag's language code.
const TARGET_LANG_TO_CODE = {
  ENG: 'en', CHS: 'zh', CHT: 'zh-TW', JPN: 'ja', KOR: 'ko', VIN: 'vi',
  FRA: 'fr', DEU: 'de', ESP: 'es', RUS: 'ru', PTB: 'pt-BR', IND: 'id',
};

export async function revertGallery(galleryId) {
  const gid = String(galleryId);
  await clearGalleryTranslations(gid);
  const meta = await metaGet(gid);
  if (meta?.translated || meta?.translatedLang) {
    const { translatedLang, ...rest } = meta;   // drop the override so the flag reverts
    await metaPut({ ...rest, translated: false });
  }
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

// POST the whole gallery in one streaming request. Frames: status(1) + size(4 BE) + data.
// status 3 = queue position, 4 = dispatched to a worker, 1 = progress state string,
// 5 = finished page (tokenLen(1) + token + 4-byte BE index + PNG) → onPage(idx, dataUrl),
// 0 = final JSON summary, 2 = error. onEvent receives { queue } | { start } | { state }.
// `signal` lets the caller abort; `jobToken` identifies this job — every status-5 frame
// must carry it, else it belongs to another gallery and is rejected (mix-up guard).
async function translateGalleryStream(serverUrl, config, pages, batchSize, onEvent, onPage, signal, jobToken) {
  const form = new FormData();
  for (const p of pages) {
    if (signal?.aborted) return { count: pages.length, failed: [] };
    form.append('image', await imageToBlob(p.blob ?? p.dataUrl), 'page.png');
  }
  form.append('config', JSON.stringify(config));
  form.append('batch_size', String(batchSize));
  form.append('job_token', jobToken || '');
  const resp = await fetch(`${serverUrl}/translate/gallery/stream`, { method: 'POST', body: form, signal });
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
      if (status === 1) { onEvent({ state: dec.decode(data) }); }
      else if (status === 3) { onEvent({ queue: parseInt(dec.decode(data), 10) || 0 }); }
      else if (status === 4) { onEvent({ start: true }); }
      else if (status === 5) {
        const tlen = data[0];
        const token = dec.decode(data.subarray(1, 1 + tlen));
        // A page frame whose token isn't ours means a different gallery's image reached
        // this stream — never write it. With the server's per-job queue isolation this
        // can't happen; this is the second, independent guard for the SaaS guarantee.
        if (token !== (jobToken || '')) throw new Error('translation page token mismatch — refusing to store another gallery\'s image');
        const b = 1 + tlen;
        const idx = ((data[b] << 24) | (data[b + 1] << 16) | (data[b + 2] << 8) | data[b + 3]) >>> 0;
        const dataUrl = await imageToDataUrl(new Blob([data.subarray(b + 4)], { type: 'image/png' }));
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
    const tlName = config.translator.translator;
    const langCode = TARGET_LANG_TO_CODE[ts.targetLang || 'ENG'] || '';   // for the card language flag
    const caps = { ...DEFAULT_BATCH_CAPS, ...(ts.batchCaps || {}) };
    const cap = BATCH_CAPPED.has(tlName)
      ? Math.max(1, parseInt(caps[tlName], 10) || DEFAULT_BATCH_CAPS[tlName] || 8)
      : 1;

    const records = (await getGalleryImageRecords(gid)).filter(r => r.blob ?? r.dataUrl);
    const total = records.length;
    const pending = records.filter(r => r.translated === undefined).sort((a, b) => _pageNumOf(a.url) - _pageNumOf(b.url));
    let done = total - pending.length;

    if (pending.length === 0) {
      const meta = await metaGet(gid);
      if (meta && (!meta.translated || meta.translatedLang !== langCode)) await metaPut({ ...meta, translated: true, translatedLang: langCode });
      send({ status: 'done', done, total });
      return;
    }
    send({ status: 'started', done, total });

    // Per-request abort handle + identity token (stored so cancelTranslate(gid) can reach
    // this exact job). The token is echoed on every page frame and verified on the way in.
    const ctrl = new AbortController();
    const jobToken = (globalThis.crypto?.randomUUID?.() || `${gid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    _controllers.set(gid, { ctrl, serverUrl, jobToken });

    // The label tracks the furthest pipeline stage (the server overlaps them); the
    // bar itself tracks rendered pages arriving as status-5 frames.
    const batches = Math.ceil(pending.length / cap);
    let pre = 0, tlStarted = 0, tlDone = 0, queued = 0, waiting = false;
    const label = () => {
      if (waiting) return queued > 0 ? `Waiting for server (${queued} ahead)` : 'Waiting for server…';
      if (pre < pending.length) return `Reading text ${pre}/${pending.length}`;
      if (tlDone < batches) return batches > 1 ? `Translating batch ${Math.max(tlStarted, tlDone + 1)}/${batches}` : 'Translating…';
      return 'Rendering';
    };
    const stored = new Set();
    let failed = 0, firstError = null, cancelled = false;
    try {
      await translateGalleryStream(serverUrl, config, pending, cap,
        (ev) => {
          if (ev.queue !== undefined) { waiting = true; queued = ev.queue; }
          else if (ev.start) { waiting = false; }
          else if (ev.state) {
            waiting = false;
            const m = ev.state.match(/^gallery-(pre|tl|tl-done):(\d+)\/(\d+)$/);
            if (!m) return;
            if (m[1] === 'pre') pre = +m[2];
            else if (m[1] === 'tl') tlStarted = +m[2];
            else tlDone = +m[2];
          } else return;
          send({ status: 'progress', done, total, label: label() });
        },
        async (idx, dataUrl) => {
          const rec = pending[idx];
          if (rec) { await putTranslatedImage(rec.url, dataUrl); stored.add(idx); }
          done++;
          send({ status: 'progress', done, total, label: label() });
        },
        ctrl.signal, jobToken);
    } catch (e) {
      if (e?.name === 'AbortError' || ctrl.signal.aborted) cancelled = true;
      else firstError = e.message;
    }

    // Cancelled: leave the already-stored pages in place (re-running resumes the rest) and
    // do NOT flag the gallery translated. No error — the user asked to stop.
    if (cancelled) { send({ status: 'cancelled', done, total }); return; }

    for (let k = 0; k < pending.length; k++) { if (!stored.has(k)) { failed++; done++; } }
    send({ status: 'progress', done, total });

    if (failed === pending.length) { send({ status: 'error', error: firstError || 'translation failed' }); return; }

    const meta = await metaGet(gid);
    if (meta && (!meta.translated || meta.translatedLang !== langCode)) await metaPut({ ...meta, translated: true, translatedLang: langCode });

    let costNote = '';
    if (tlName === 'gemini') {
      const n = pending.length;
      const estIn = batches * 800 + n * 215;
      const estOut = n * 600;
      const priceIn = Number(ts.priceIn ?? 1.5), priceOut = Number(ts.priceOut ?? 9);
      const usd = (estIn * priceIn + estOut * priceOut) / 1e6;
      costNote = `${batches} call${batches > 1 ? 's' : ''} · ~${((estIn + estOut) / 1000).toFixed(1)}K tokens · ~$${usd.toFixed(2)} est.`;
    }
    send({ status: 'done', done, total, failed, costNote });
  } catch (e) {
    send({ status: 'error', error: e.message });
  } finally {
    _translating.delete(gid);
    _controllers.delete(gid);
  }
}

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
  getGalleryImageRecords, putTranslatedImage, putPageStudy, clearGalleryTranslations,
  metaGet, metaPut, imageToBlob, imageToDataUrl,
} from './db.js';
import { translateResume, jobsPending } from './platform.js';

const _pageNumOf = (url) => parseInt(url.match(/\/(\d+)\.\w+$/)?.[1] || '999999');

// Sniff PNG vs WebP from the leading bytes so a page frame is stored with the right MIME — the
// server may send either (it prefers WebP for size), and the type drives blob URLs + the file
// extension chosen by the per-gallery export.
function _imgMime(u8) {
  if (u8.length > 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
  return 'image/png';
}
// Translators whose batch size is a real token/cost knob (one LLM call per batch).
// Everything else translates page by page (batch_size 1) but still rides the pipeline.
const BATCH_CAPPED = new Set(['gemini', 'deepseek', 'chatgpt']);
const DEFAULT_BATCH_CAPS = { gemini: 8, deepseek: 8, chatgpt: 6 };
const _translating = new Set();   // gids whose job is being STARTED (guards the upload)
const _polling = new Set();        // gids with an in-flight poll (guards overlapping ticks)
// gid → { serverUrl, jobToken } so a same-context cancel can reach the server even before the
// reattach record is read. The token is the source of truth (it's also in translateResume).
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

// Cancel a gallery translation: tell the server to stop that exact job by token, so the worker
// isn't left churning the GPU. The polling stops on its own once the reattach record is removed
// (services.js does that). `arg` is { galleryId, token, serverUrl } (token/serverUrl read from the
// record by the caller, so a cancel works across contexts) or just a gid. Best-effort.
export function cancelTranslate(arg) {
  const p = (arg && typeof arg === 'object') ? arg : { galleryId: arg };
  const gid = String(p.galleryId);
  const entry = _controllers.get(gid);
  const token = p.token || (entry && entry.jobToken);
  const serverUrl = p.serverUrl || (entry && entry.serverUrl);
  _polling.delete(gid);
  _controllers.delete(gid);
  if (serverUrl && token) {
    const form = new FormData();
    form.append('job_token', token);
    fetch(`${serverUrl}/translate/gallery/cancel`, { method: 'POST', body: form }).catch(() => {});
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
    // disabled | text_only | text_and_image — study layers are opt-in; skipping them is the
    // fastest path and most translations never open Study mode.
    study_mode_generation: ts.studyModeGeneration || 'disabled',
  };
}

// ── Polling model ───────────────────────────────────────────────────────────────────────────
// A whole-gallery translation is a SERVER-OWNED job. We POST it once (/translate/gallery/start),
// then collect results with short /translate/gallery/poll requests instead of one long stream. A
// long stream can't survive in a service worker (Chrome kills any single event at its ~5-min cap);
// a series of short polls never lets one event approach the cap, so a translation survives a
// navigation, a tab close+reopen, and repeated SW recycling — driven by whichever page is open
// (the poll tick lives in boot.js → submit-job.js's pollActiveTranslations).
//
// Poll frames reuse the worker's envelope: status(1)+size(4 BE)+data. status 5 = a finished page
// (tokenLen(1)+token+idx(4 BE)+PNG), 6 = its study layers (…+JSON), 0 = final summary, 2 = error.
// The page index maps back to a url through the job's stored pendingUrls.

// Build a stage-aware label from the server's per-stage counters. The pipeline overlaps
// (read → translate → render), so we name the furthest stage that isn't finished and carry that
// stage's own moving count — the part that conveys "something is happening" even before any page
// has fully rendered. `m` is the poll metadata frame.
function _galleryLabel(m) {
  if (!m) return 'Starting…';
  if ((m.queue || 0) > 0) return `Waiting for server · ${m.queue} ahead`;
  const total = m.total || 0;
  if (!m.dispatched && (m.pre || 0) === 0 && (m.done || 0) === 0) return 'Starting…';
  if (total && (m.pre || 0) < total) return `Reading text ${m.pre || 0}/${total}`;
  const batches = m.batches || 0;
  if (batches && (m.tlDone || 0) < batches) {
    const b = Math.min(batches, Math.max(m.tlStarted || 0, (m.tlDone || 0) + 1));
    return batches > 1 ? `Translating batch ${b}/${batches}` : 'Translating…';
  }
  if (total && (m.done || 0) < total) return `Rendering ${m.done || 0}/${total}`;
  return 'Finishing…';
}

// A weighted overall fraction (0–100) across the three stages, so the bar creeps forward from the
// first second instead of sitting at 0 until pages start rendering.
function _galleryPct(m) {
  const total = (m && m.total) || 0;
  if (!total) return 0;
  const read = Math.min(1, (m.pre || 0) / total);
  const batches = m.batches || 0;
  const tl = batches ? Math.min(1, (m.tlDone || 0) / batches) : 0;
  const render = Math.min(1, (m.done || 0) / total);
  return Math.round((0.25 * read + 0.35 * tl + 0.40 * render) * 100);
}

// Start a server-owned gallery job: upload the not-yet-translated pages once and record the token
// + page order so any page can poll it (and resume after a navigation / SW kill) without
// re-uploading. Returns as soon as the job is created; the poll ticks drive it to completion.
export async function startTranslation(galleryId, ts, send = () => {}) {
  const gid = String(galleryId);
  if (_translating.has(gid)) return;
  _translating.add(gid);
  try {
    // A translation already in flight for this gallery (its resume record still exists)? Don't
    // start a duplicate server job — that orphans the first one and churns the GPU (worst exactly
    // when it's contended, e.g. another app is using it). The poll loop is already driving it, so a
    // repeat Translate click is a no-op; the notfound-restart path clears the record before
    // re-calling here, so genuine resumes still go through.
    if (await translateResume.get(gid)) return;
    ts = ts || {};
    const serverUrl = serverUrlFromSettings(ts);
    const config = buildConfig(ts);
    const tlName = config.translator.translator;
    const langCode = TARGET_LANG_TO_CODE[ts.targetLang || 'ENG'] || '';
    const caps = { ...DEFAULT_BATCH_CAPS, ...(ts.batchCaps || {}) };
    const cap = BATCH_CAPPED.has(tlName) ? Math.max(1, parseInt(caps[tlName], 10) || DEFAULT_BATCH_CAPS[tlName] || 8) : 1;

    const records = (await getGalleryImageRecords(gid)).filter(r => r.blob ?? r.dataUrl);
    const total = records.length;
    const pending = records.filter(r => r.translated === undefined).sort((a, b) => _pageNumOf(a.url) - _pageNumOf(b.url));

    if (pending.length === 0) {
      const meta = await metaGet(gid);
      if (meta && (!meta.translated || meta.translatedLang !== langCode)) await metaPut({ ...meta, translated: true, translatedLang: langCode });
      await translateResume.remove(gid);
      send({ status: 'done', done: total, total });
      return;
    }

    const jobToken = (globalThis.crypto?.randomUUID?.() || `${gid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    // Upload the pages and create the job — the server runs the worker detached and buffers frames.
    const form = new FormData();
    for (const p of pending) form.append('image', await imageToBlob(p.blob ?? p.dataUrl), 'page.png');
    form.append('config', JSON.stringify(config));
    form.append('batch_size', String(cap));
    form.append('job_token', jobToken);
    let ok = false;
    try { const resp = await fetch(`${serverUrl}/translate/gallery/start`, { method: 'POST', body: form }); ok = resp.ok; }
    catch {}
    if (!ok) { send({ status: 'error', error: 'could not reach translation server' }); return; }

    _controllers.set(gid, { serverUrl, jobToken });
    // Everything a poll needs to resume this server-owned job from any page (and the cursor it
    // advances). pendingUrls maps the server's page indices back to gallery urls.
    await translateResume.set({
      gid, token: jobToken, serverUrl, settings: ts, langCode, translator: tlName, cap,
      pendingUrls: pending.map(p => p.url), total, cursor: 0,
    });
    send({ status: 'started', done: total - pending.length, total, label: 'Starting…', pct: 0 });
  } finally {
    _translating.delete(gid);
  }
}

// One short poll: read the server's metadata frame (cursor/status/state/done/total) + the page
// frames produced since our cursor, store the pages, and broadcast the server-authoritative
// progress. The bar comes straight from the server's emitted-page count — the client never tallies
// it — so it can't drift, and all of this rides in the BODY (a status-7 frame) so cross-origin
// fetches can read it. Only the cursor is persisted; the rest is recomputed from the server each tick.
export async function pollTranslation(galleryId, send = () => {}) {
  const gid = String(galleryId);
  if (_polling.has(gid)) return;
  _polling.add(gid);
  try {
    const rec = await translateResume.get(gid);
    if (!rec) return;
    const { token, serverUrl, pendingUrls, settings, langCode, translator, cap, total } = rec;
    const cursor = rec.cursor || 0;

    const form = new FormData();
    form.append('job_token', token);
    form.append('since', String(cursor));
    let resp;
    try { resp = await fetch(`${serverUrl}/translate/gallery/poll`, { method: 'POST', body: form }); }
    catch { return; }                       // server unreachable — next tick retries
    if (!resp.ok) return;

    const buf = new Uint8Array(await resp.arrayBuffer());
    const dec = new TextDecoder();

    let meta = null, summary = null, errMsg = null, off = 0;
    while (buf.length - off >= 5) {
      const st = buf[off];
      const size = ((buf[off + 1] << 24) | (buf[off + 2] << 16) | (buf[off + 3] << 8) | buf[off + 4]) >>> 0;
      if (buf.length - off < 5 + size) break;
      const data = buf.subarray(off + 5, off + 5 + size);
      off += 5 + size;
      if (st === 7) { try { meta = JSON.parse(dec.decode(data)); } catch {} }   // {cursor,status,state,done,total}
      else if (st === 5) {
        const tlen = data[0];
        if (dec.decode(data.subarray(1, 1 + tlen)) !== token) continue;   // mix-up guard
        const b = 1 + tlen;
        const idx = ((data[b] << 24) | (data[b + 1] << 16) | (data[b + 2] << 8) | data[b + 3]) >>> 0;
        const url = pendingUrls[idx];
        if (url) { const img = data.subarray(b + 4); await putTranslatedImage(url, await imageToDataUrl(new Blob([img], { type: _imgMime(img) }))); }
      } else if (st === 6) {
        const tlen = data[0];
        if (dec.decode(data.subarray(1, 1 + tlen)) !== token) continue;
        const b = 1 + tlen;
        const idx = ((data[b] << 24) | (data[b + 1] << 16) | (data[b + 2] << 8) | data[b + 3]) >>> 0;
        const url = pendingUrls[idx];
        let study = null; try { study = JSON.parse(dec.decode(data.subarray(b + 4))); } catch {}
        if (url && study && Array.isArray(study.bubbles) && study.bubbles.length) {
          // text_and_image frames carry bg + per-bubble text layers; text_only frames carry
          // metadata only (no bg, no text) and render as DOM text in the reader.
          const bg = study.bg ? await imageToBlob(study.bg) : null;
          if (!study.bg || bg) {
            const bubbles = [];
            for (const bb of study.bubbles) {
              if (!bb.box) continue;
              const bubble = { box: bb.box, region: bb.region || bb.box, tr: bb.tr || '', src: bb.src || '' };
              if (bb.rbox)  bubble.rbox  = bb.rbox;
              if (bb.style) bubble.style = bb.style;
              if (bb.text) { const text = await imageToBlob(bb.text); if (!text) continue; bubble.text = text; }
              bubbles.push(bubble);
            }
            if (bubbles.length) await putPageStudy(url, { bg, bubbles, page: study.page || null });
          }
        }
      } else if (st === 0) { try { summary = JSON.parse(dec.decode(data)); } catch {} }
      else if (st === 2) { errMsg = dec.decode(data); }
    }

    if (!meta) return;                       // malformed response — try again next tick
    if (meta.status === 'notfound') {
      // Server lost the job (reaped after a long absence, or restarted) → start fresh for the rest.
      await translateResume.remove(gid);
      _controllers.delete(gid);
      await startTranslation(gid, settings, send);
      return;
    }

    const startDone = total - pendingUrls.length;          // pages already translated before this job
    const done = Math.min(startDone + (meta.done || 0), total);   // server's emitted count is authoritative
    await translateResume.set({ ...rec, cursor: meta.cursor });   // only the cursor needs persisting

    const terminal = summary || errMsg || meta.status === 'done' || meta.status === 'error' || meta.status === 'cancelled';
    if (!terminal) { send({ status: 'progress', done, total, label: _galleryLabel(meta), pct: _galleryPct(meta) }); return; }

    // Terminal — finalize once and stop polling this gallery.
    await translateResume.remove(gid);
    _controllers.delete(gid);
    if (meta.status === 'cancelled' && !summary) {
      // Server-side cancel (liveness reaper, or a cancel issued from another context). Clearing
      // the resume token above is what stops the polling — without it the job would sit in
      // 'cancelled' until eviction and then restart from scratch via the notfound path. Already
      // stored pages stay; a later Translate resumes with only the missing ones.
      await jobsPending.remove(`${gid}:translate`);
      send({ status: 'cancelled' });
      return;
    }
    if (errMsg && done <= startDone) { send({ status: 'error', error: errMsg }); return; }
    const failed = (summary && Array.isArray(summary.failed)) ? summary.failed.length : Math.max(0, total - done);
    const gMeta = await metaGet(gid);
    if (gMeta && (!gMeta.translated || gMeta.translatedLang !== langCode)) await metaPut({ ...gMeta, translated: true, translatedLang: langCode });
    let costNote = '';
    if (translator === 'gemini') {
      const n = pendingUrls.length, batches = Math.ceil(n / (cap || 8));
      const estIn = batches * 800 + n * 215, estOut = n * 600;
      const s = settings || {};
      const usd = (estIn * Number(s.priceIn ?? 1.5) + estOut * Number(s.priceOut ?? 9)) / 1e6;
      costNote = `${batches} call${batches > 1 ? 's' : ''} · ~${((estIn + estOut) / 1000).toFixed(1)}K tokens · ~$${usd.toFixed(2)} est.`;
    }
    send({ status: 'done', done, total, failed, costNote });
  } finally {
    _polling.delete(gid);
  }
}


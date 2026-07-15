// translate.js — gallery translation engine (self-hosted manga-image-translator).
//
// Shared by the standalone/PWA app (which now owns translation) and, for parity, the extension's
// service worker. Pure logic: it reads a gallery's images from db.js, POSTs them to the translate
// server, and stores the translated variants. The caller passes the settings object and a progress
// callback — the app wires its own, the extension wires its job reporter.
//
// The gallery is uploaded once (in byte-capped parts when needed), then short token-scoped polls
// collect completed pages and study metadata. The server pipelines detection/OCR, translation and
// rendering, so progress reads Reading → Translating → Rendering even while stages overlap.
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
// Translators that batch several pages into one LLM call (vs. page-by-page, batch_size 1).
// For gemini/chatgpt the sent value IS the pages-per-request the user tunes. DeepSeek also
// batches, but the server sizes each request adaptively from the pages' text volume, so its
// value here is only an internal scheduling/memory hint (not user-tunable) — hence no UI knob.
const BATCH_CAPPED = new Set(['gemini', 'deepseek', 'chatgpt']);
const DEFAULT_BATCH_CAPS = { gemini: 8, deepseek: 10, chatgpt: 6 };
const _translating = new Set();   // gids whose job is being STARTED (guards the upload)
const _polling = new Map();        // gid → {token}; same-token ticks coalesce, replacements proceed
// gid → { serverUrl, jobToken, abort, cancelled } so a same-context cancel can abort an upload
// immediately, even before the durable record is re-read. The token remains the source of truth.
const _controllers = new Map();

export function serverUrlFromSettings(ts) {
  return ((ts || {}).serverUrl || 'http://127.0.0.1:5003').replace(/\/+$/, '');
}

// Remote/shared servers can require a shared access token; it rides as a header on every
// job request. Empty (the local-server default) sends nothing.
function _authHeaders(ts) {
  const tok = ((ts || {}).serverToken || '').trim();
  return tok ? { 'X-Access-Token': tok } : {};
}

function _isLocalServer(serverUrl) {
  try { const h = new URL(serverUrl).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'; }
  catch { return true; }
}

// Remote servers cap pages at 8MB (MT_MAX_PAGE_MB) and only accept common raster types.
// Rather than fail the whole gallery on one 15MB PNG scan, oversized/exotic pages are
// re-encoded to WebP for the upload only (the stored original is untouched). Uses
// OffscreenCanvas so it works from both a page and the service worker.
const PAGE_BYTE_CAP = 8 * 1024 * 1024;

// Mirror of the server's accepted-format sniff, on the REAL bytes — the stored MIME type
// can lie (a source may serve one format under another format's file extension).
function _uploadableMagic(u8) {
  if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return true;   // WEBP
  if (u8.length >= 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70 &&
      u8[8] === 0x61 && u8[9] === 0x76 && u8[10] === 0x69) return true;                      // AVIF (ftypavif/avis)
  const magics = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x42, 0x4d]]; // PNG, JPEG, GIF, BMP
  return magics.some(m => m.every((v, i) => u8[i] === v));
}

async function _fitForUpload(blob) {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (blob.size <= PAGE_BYTE_CAP && _uploadableMagic(head)) return blob;
  try {
    const bmp = await createImageBitmap(blob);
    // Cap the long side (scans beyond this add nothing for OCR), then WebP q0.9 —
    // stepping down once if a page somehow still exceeds the cap.
    const scale = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    for (const quality of [0.9, 0.75]) {
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const out = await canvas.convertToBlob({ type: 'image/webp', quality });
      if (out && out.size <= PAGE_BYTE_CAP) { bmp.close(); return out; }
    }
    bmp.close();
  } catch {}
  return blob;   // couldn't shrink it — let the server's own limit answer for this page
}

// The server (and the proxy in front of a remote one) rejects with a JSON {detail} for
// limits/auth; fall back to a readable label when the body isn't ours (e.g. a proxy page).
async function _errorDetail(resp) {
  try { const j = await resp.json(); if (j && j.detail) return String(j.detail); } catch {}
  return resp.status === 401 ? 'access token missing or wrong — check Settings → Translation'
       : resp.status === 413 ? 'gallery too large for the server'
       : resp.status === 429 ? 'server rate limit reached — try again later'
       : resp.status === 503 ? 'server is at capacity — try again later'
       : `server error (${resp.status})`;
}

export async function pingServer(serverUrl, settings = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const resp = await fetch(`${serverUrl}/stats`, { signal: ctrl.signal, headers: _authHeaders(settings) });
    return resp.ok;
  }
  catch { return false; }
  finally { clearTimeout(timer); }
}

// Cancel a gallery translation: tell the server to stop that exact job by token, so the worker
// isn't left churning the GPU. The polling stops on its own once the reattach record is removed
// (services.js does that). `arg` is { galleryId, token, serverUrl, settings } (read from the
// record by the caller, so a cancel works across contexts) or just a gid. Best-effort.
export function cancelTranslate(arg) {
  const p = (arg && typeof arg === 'object') ? arg : { galleryId: arg };
  const gid = String(p.galleryId);
  const entry = _controllers.get(gid);
  const token = p.token || (entry && entry.jobToken);
  const serverUrl = p.serverUrl || (entry && entry.serverUrl);
  const headers = _authHeaders(p.settings || (entry && entry.ts));
  // A delayed cancel for an older token must not tear down a newer controller/poll for the gid.
  const activePoll = _polling.get(gid);
  if (!token || activePoll?.token === token) _polling.delete(gid);
  if (!token || entry?.jobToken === token) {
    if (entry) {
      entry.cancelled = true;
      try { entry.abort?.abort(); } catch {}
    }
    _controllers.delete(gid);
  }
  if (serverUrl && token) {
    const form = new FormData();
    form.append('job_token', token);
    fetch(`${serverUrl}/translate/gallery/cancel`, { method: 'POST', body: form, headers }).catch(() => {});
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
    return batches > 1 ? `Translating ${b}/${batches}` : 'Translating…';
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
  let ownedStart = null;
  try {
    // A server-owned job already being polled is a no-op. An interrupted upload claim is replayed
    // below with its original token, so accepted parts remain idempotent instead of being orphaned.
    let resume = await translateResume.get(gid);
    if (resume && resume.phase !== 'uploading') return;
    ts = (resume && resume.settings) || ts || {};
    const serverUrl = serverUrlFromSettings(ts);
    const config = buildConfig(ts);
    const tlName = config.translator.translator;
    const langCode = TARGET_LANG_TO_CODE[ts.targetLang || 'ENG'] || '';
    const caps = { ...DEFAULT_BATCH_CAPS, ...(ts.batchCaps || {}) };
    const cap = BATCH_CAPPED.has(tlName) ? Math.max(1, parseInt(caps[tlName], 10) || DEFAULT_BATCH_CAPS[tlName] || 8) : 1;

    const records = (await getGalleryImageRecords(gid)).filter(r => r.blob ?? r.dataUrl);
    const byUrl = new Map(records.map(r => [r.url, r]));
    const total = Number(resume && resume.total) || records.length;
    const pending = resume && Array.isArray(resume.pendingUrls)
      ? resume.pendingUrls.map(url => byUrl.get(url)).filter(Boolean)
      : records.filter(r => r.translated === undefined).sort((a, b) => _pageNumOf(a.url) - _pageNumOf(b.url));

    if (pending.length === 0) {
      const meta = await metaGet(gid);
      if (meta && (!meta.translated || meta.translatedLang !== langCode)) await metaPut({ ...meta, translated: true, translatedLang: langCode });
      if (resume?.token) await translateResume.remove(gid, resume.token);
      send({ status: 'done', done: total, total });
      return;
    }

    if (resume && pending.length !== resume.pendingUrls.length) {
      if (await translateResume.remove(gid, resume.token)) send({ status: 'error', error: 'one or more source pages could not be read' });
      return;
    }

    const jobToken = (resume && resume.token) || (globalThis.crypto?.randomUUID?.() || `${gid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    if (!resume) {
      resume = {
        gid, token: jobToken, serverUrl, settings: ts, langCode, translator: tlName, cap,
        pendingUrls: pending.map(p => p.url), total, cursor: 0, phase: 'uploading',
      };
      const claimed = await translateResume.claim(resume);
      if (claimed === 'exists') return;
      if (claimed !== 'claimed') { send({ status: 'error', error: 'could not save translation job state' }); return; }
    }
    ownedStart = { token: jobToken, serverUrl, settings: ts };

    const controller = { serverUrl, jobToken, ts, cancelled: false, abort: new AbortController() };
    _controllers.set(gid, controller);
    const stillOwned = async () => {
      if (controller.cancelled || _controllers.get(gid) !== controller) return false;
      const current = await translateResume.get(gid);
      return !!current && current.token === jobToken && current.phase === 'uploading';
    };
    const cancelRemote = () => cancelTranslate({ galleryId: gid, token: jobToken, serverUrl, settings: ts });
    const failStart = async (message) => {
      const removed = await translateResume.remove(gid, jobToken);
      const current = removed ? null : await translateResume.get(gid);
      cancelRemote();
      if (removed || current?.token === jobToken) send({ status: 'error', error: message });
    };
    send({ status: 'started', done: total - pending.length, total, label: 'Preparing upload…', pct: 0 });

    // Upload the pages and create the job — the server runs the worker detached and buffers
    // frames. A remote proxy may cap request bodies, so a big gallery is uploaded as several
    // deterministic page groups sharing the job token; the server assembles them in order and
    // starts when the last one lands. Eight pages stay below the request cap even when every
    // converted page reaches its 8 MB ceiling, and only one group is retained in memory at once.
    const REMOTE_PAGES_PER_PART = 8;
    const split = !_isLocalServer(serverUrl);
    const partCount = split ? Math.ceil(pending.length / REMOTE_PAGES_PER_PART) : 1;
    if (partCount > 200) { await failStart('gallery has too many pages for remote upload'); return; }

    const headers = _authHeaders(ts);
    for (let i = 0; i < partCount; i++) {
      if (!await stillOwned()) { cancelRemote(); return; }
      const form = new FormData();
      const first = split ? i * REMOTE_PAGES_PER_PART : 0;
      const last = split ? Math.min(pending.length, first + REMOTE_PAGES_PER_PART) : pending.length;
      for (let j = first; j < last; j++) {
        let blob = await imageToBlob(pending[j].blob ?? pending[j].dataUrl);
        if (!blob) { await failStart('one or more source pages could not be read'); return; }
        if (split) blob = await _fitForUpload(blob);   // remote page-size/type cap; local is uncapped
        if (split && blob.size > PAGE_BYTE_CAP) {
          await failStart('a source page exceeds the remote server size limit');
          return;
        }
        if (!await stillOwned()) { cancelRemote(); return; }
        form.append('image', blob, 'page.png');
      }
      form.append('config', JSON.stringify(config));
      form.append('batch_size', String(cap));
      form.append('job_token', jobToken);
      form.append('part', String(i));
      form.append('parts', String(partCount));
      let resp = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          resp = await fetch(`${serverUrl}/translate/gallery/start`, {
            method: 'POST', body: form, headers, signal: controller.abort.signal,
          });
        }
        catch {
          if (controller.cancelled || _controllers.get(gid) !== controller) return;
          if (attempt === 0) continue;
        }
        if (resp && (resp.status === 502 || resp.status === 504) && attempt === 0) { resp = null; continue; }
        break;
      }
      if (!resp) { await failStart('could not reach translation server'); return; }
      if (!resp.ok) { await failStart(await _errorDetail(resp)); return; }
      let ack = null;
      try { ack = await resp.json(); } catch {}
      if (!ack || ack.token !== jobToken) { await failStart('translation server returned an invalid job token'); return; }
      if (!await stillOwned()) { cancelRemote(); return; }
    }

    // Atomically hand the durable claim from the upload phase to the poller. If cancellation won
    // this race, stop the just-created remote job and publish nothing over the cancelled state.
    if (!await translateResume.patch(gid, jobToken, { phase: 'polling' })) {
      const current = await translateResume.get(gid);
      cancelRemote();
      if (current?.token === jobToken) {
        await translateResume.remove(gid, jobToken);
        send({ status: 'error', error: 'could not save translation job state' });
      }
      return;
    }
    send({ status: 'started', done: total - pending.length, total, label: 'Starting…', pct: 0 });
  } catch (error) {
    // An unexpected conversion/FormData/IDB failure must not strand an `uploading` record that
    // the poller can never advance. Clean up only the token this invocation owns, then let the
    // runner publish the original error.
    if (ownedStart) {
      try {
        const current = await translateResume.get(gid);
        if (current?.token === ownedStart.token && current.phase === 'uploading') {
          cancelTranslate({ galleryId: gid, ...ownedStart });
          await translateResume.remove(gid, ownedStart.token);
        }
      } catch {}
    }
    throw error;
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
  const rec = await translateResume.get(gid);
  if (!rec || rec.phase === 'uploading') return;
  const active = _polling.get(gid);
  if (active?.token === rec.token) return;
  const poll = { token: rec.token };
  _polling.set(gid, poll);
  try {
    const { token, serverUrl, pendingUrls, settings, langCode, translator, cap, total } = rec;
    const cursor = rec.cursor || 0;
    const ownsToken = async () => (await translateResume.get(gid))?.token === token;

    const form = new FormData();
    form.append('job_token', token);
    form.append('since', String(cursor));
    let resp;
    try { resp = await fetch(`${serverUrl}/translate/gallery/poll`, { method: 'POST', body: form, headers: _authHeaders(settings) }); }
    catch { return; }                       // server unreachable — next tick retries
    if (!resp.ok) {
      const permanent = resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429;
      if (permanent) {
        const detail = await _errorDetail(resp);
        if (await translateResume.remove(gid, token)) {
          const entry = _controllers.get(gid);
          if (!entry || entry.jobToken === token) _controllers.delete(gid);
          send({ status: 'error', error: detail });
        }
      }
      return;
    }
    if (!await ownsToken()) return;

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
        if (url && await ownsToken()) {
          const img = data.subarray(b + 4);
          await putTranslatedImage(url, await imageToDataUrl(new Blob([img], { type: _imgMime(img) })));
        }
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
              // Optional DOM-text extras: the renderer's drawn rect and source-line furigana.
              if (Array.isArray(bb.furi)     && bb.furi.length)     bubble.furi     = bb.furi;
              if (bb.tbox) bubble.tbox = bb.tbox;
              if (bb.text) { const text = await imageToBlob(bb.text); if (!text) continue; bubble.text = text; }
              bubbles.push(bubble);
            }
            if (bubbles.length && await ownsToken()) await putPageStudy(url, { bg, bubbles, page: study.page || null });
          }
        }
      } else if (st === 0) { try { summary = JSON.parse(dec.decode(data)); } catch {} }
      else if (st === 2) { errMsg = dec.decode(data); }
    }

    if (!meta) return;                       // malformed response — try again next tick
    if (meta.status === 'notfound') {
      // Server lost the job (reaped after a long absence, or restarted) → start fresh for the rest.
      if (await translateResume.remove(gid, token)) {
        const entry = _controllers.get(gid);
        if (!entry || entry.jobToken === token) _controllers.delete(gid);
        // Queue the restart through the durable runner rather than uploading inside the poller.
        // The next heartbeat claims this row, so a worker eviction can never lose the restart.
        const key = `${gid}:translate`;
        if (await jobsPending.add({ key, kind: 'translate', payload: { galleryId: gid, settings } })) {
          send({ status: 'started', done: total - pendingUrls.length, total, label: 'Restarting…', pct: 0 });
        } else {
          send({ status: 'error', error: 'could not save translation restart state' });
        }
      }
      return;
    }

    const startDone = total - pendingUrls.length;          // pages already translated before this job
    const done = Math.min(startDone + (meta.done || 0), total);   // server's emitted count is authoritative
    if (!await translateResume.advance(gid, token, meta.cursor)) return;

    const terminal = summary || errMsg || meta.status === 'done' || meta.status === 'error' || meta.status === 'cancelled';
    if (!terminal) {
      if (await ownsToken()) send({ status: 'progress', done, total, label: _galleryLabel(meta), pct: _galleryPct(meta) });
      return;
    }

    // Terminal — finalize once and stop polling this gallery.
    if (!await translateResume.remove(gid, token)) return;
    const entry = _controllers.get(gid);
    if (!entry || entry.jobToken === token) _controllers.delete(gid);
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
    if (_polling.get(gid) === poll) _polling.delete(gid);
  }
}


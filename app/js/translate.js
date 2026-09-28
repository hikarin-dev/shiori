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
// (a privileged helper can bypass CORS via host permissions; a web origin cannot). See
// ARCHITECTURE.md and the translator patches noted in the project memory.

import {
  getGalleryImageRecords, putTranslatedPage, putPageStudy, clearGalleryTranslations, metaGet, metaPut, imageToBlob,
  setPagesOwn, dbGet,
} from './db.js';
import {
  decodePageData, encodePageData, planPage, translationGroups, keptConfig, referencedTranslations, contextBefore,
} from './page-data.js';
import { hasTranslation } from './page-image.js';
import { translateResume, jobsPending } from './platform.js';
import { resizeToWidth } from './image-util.js';
import { getCapabilities } from './capabilities.js';
import { BENCHMARK_LOCK } from './benchmark-core.js';
import {
  buildConfig, migrateTranslateSettings, languageTag, batchCap, unavailableChoices, stageOf,
} from './translate-config.js';

const _pageNumOf = (url) => parseInt(url.match(/\/(\d+)\.\w+$/)?.[1] || '999999');

// Sniff PNG vs WebP from the leading bytes so a page frame is stored with the right MIME — the
// server may send either (it prefers WebP for size), and the type drives blob URLs + the file
// extension chosen by the per-gallery export.
function _imgMime(u8) {
  if (u8.length > 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
  return 'image/png';
}
const _translating = new Set();   // gids whose job is being STARTED (guards the upload)
const _polling = new Map();        // gid → {token}; same-token ticks coalesce, replacements proceed
// gid → { serverUrl, jobToken, abort, cancelled } so a same-context cancel can abort an upload
// immediately, even before the durable record is re-read. The token remains the source of truth.
const _controllers = new Map();

export function serverUrlFromSettings(ts) {
  return ((ts || {}).serverUrl || 'http://127.0.0.1:5003').replace(/\/+$/, '');
}

// Has the user actually pointed Shiori at a translation server? Until they have, nothing may
// contact the default address on its own: reaching 127.0.0.1 from a hosted page makes the
// browser ask for local-network access, and a first-time visitor should never face that prompt
// for a feature they haven't set up. Explicit actions (Check, Save, translating) still use the
// default — there the request is something the user just asked for.
export function hasConfiguredServer(ts) {
  return typeof ts?.serverUrl === 'string' && ts.serverUrl.trim() !== '';
}

// Remote/shared servers can require a shared access token; it rides as a header on every
// job request. Empty (the local-server default) sends nothing.
function _authHeaders(ts) {
  const tok = ((ts || {}).serverToken || '').trim();
  return tok ? { 'X-Access-Token': tok } : {};
}

export function isLocalServer(serverUrl) {
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
    // stepping down once if a page somehow still exceeds the cap. Upload copy only;
    // the stored original is untouched.
    const scale = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    bmp.close();
    for (const quality of [0.9, 0.75]) {
      const out = await resizeToWidth(blob, w, { format: 'image/webp', quality });
      if (out && out.size <= PAGE_BYTE_CAP) return out;
    }
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

// Back to the originals. The pages' snapshots go too unless `keepSnapshots` (Settings →
// Translation), and with them the translation entries no page refers to any more.
export async function revertGallery(galleryId, { keepSnapshots = false } = {}) {
  const gid = String(galleryId);
  await clearGalleryTranslations(gid, { keepSnapshots });
  const meta = await metaGet(gid);
  if (!meta) return;
  const { translatedLang, ...rest } = meta;   // drop the override so the flag reverts
  const translations = referencedTranslations(meta.translations, await getGalleryImageRecords(gid));
  await metaPut({ ...rest, translated: false, translations });
}

// Where translating one page again would start, without starting anything: `gallery` for a
// gallery translation (the page's kept settings, when it keeps its own), `page` for translating
// just this page (the current settings) — each a planPage result, null meaning up to date. Only a
// server the user set up is asked; `unavailable` says why there is no answer.
export async function previewPagePlans(galleryId, url, ts) {
  ts = migrateTranslateSettings(ts || {});
  if (!hasConfiguredServer(ts)) return { unavailable: 'no_server' };
  const serverUrl = serverUrlFromSettings(ts);
  const [{ doc: capsDoc }, rec, meta] = await Promise.all([getCapabilities(serverUrl, ts), dbGet(url), metaGet(galleryId)]);
  if (!rec) return { unavailable: 'no_page' };
  const entries = meta?.translations || {};
  const base = buildConfig(ts, capsDoc);
  const own = rec.own && entries[rec.own] ? rec.own : null;
  const [current, kept] = await Promise.all([_resolve(serverUrl, ts, base),
    own ? _resolve(serverUrl, ts, keptConfig(base, entries[own].config)) : null]);
  if (!current || (own && !kept)) return { unavailable: 'offline' };
  return { own: !!own, gallery: planPage(rec, entries, kept || current, new Map()), page: planPage(rec, entries, current, new Map()) };
}

// Pages back on the gallery's settings: they stop keeping their own, and the next gallery
// translation brings them in line.
export async function followGallerySettings(galleryId, urls) {
  await setPagesOwn(urls, null);
  await _finishGallery(String(galleryId));
}

// What the server's pipeline would do with this config: its effective config, the build of each
// stage and the config fields each stage reads (see page-data.js). Null when it can't say.
async function _resolve(serverUrl, settings, config) {
  const form = new FormData();
  form.append('config', JSON.stringify(config));
  try {
    const resp = await fetch(`${serverUrl}/translate/gallery/resolve`, { method: 'POST', body: form, headers: _authHeaders(settings) });
    return resp.ok ? await resp.json() : null;
  } catch { return null; }
}

// Names this translation in the gallery's metadata.translations; pages record which one made them.
const _jobId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 4);

// The server accepts up to 64 KB of context; the oldest pages go first when it runs over.
const CONTEXT_BYTES = 60 * 1024;

// Settle a gallery after a job (or when nothing needed one): keep the translation entries some page
// still comes from or keeps, and take its status from the pages — every page translated, some
// ('partial') or none. `lang` is set by a job that ran the gallery's own settings.
async function _finishGallery(gid, { job = null, entry = null, lang = null } = {}) {
  const meta = await metaGet(gid);
  if (!meta) return;
  const records = (await getGalleryImageRecords(gid)).filter(r => r.blob ?? r.dataUrl);
  const translations = referencedTranslations(job ? { ...(meta.translations || {}), [job]: entry } : meta.translations, records);
  const done = records.filter(hasTranslation).length;
  const translated = done && done === records.length ? true : done ? 'partial' : false;
  const { translation, ...rest } = meta;   // the previous format's single record
  await metaPut({ ...rest, translated, translatedLang: lang || meta.translatedLang, translations });
}

// Page data frames (status 9) wait here until their page (status 5) arrives, possibly one poll later.
const _staged = new Map();   // job token → Map(page index → { record, masks })

// ── Polling model ───────────────────────────────────────────────────────────────────────────
// A whole-gallery translation is a SERVER-OWNED job. We POST it once (/translate/gallery/start),
// then collect results with short /translate/gallery/poll requests instead of one long stream. A
// long stream can't survive in a service worker (Chrome kills any single event at its ~5-min cap);
// a series of short polls never lets one event approach the cap, so a translation survives a
// navigation, a tab close+reopen, and repeated SW recycling — driven by whichever page is open
// (the poll tick lives in boot.js → submit-job.js's pollActiveTranslations).
//
// Poll frames reuse the worker's envelope: status(1)+size(4 BE)+data. status 9 = a page's pipeline
// data (tokenLen(1)+token+idx(4 BE)+container), 5 = the finished page (…+image), 6 = its study
// layers (…+JSON), 0 = final summary, 2 = error. The page index maps back to a url through the
// job's stored pendingUrls.

// Build a stage-aware label from the server's per-stage counters. The pipeline overlaps
// (read → translate → render), so we name the furthest stage that isn't finished and carry that
// stage's own moving count — the part that conveys "something is happening" even before any page
// has fully rendered. `m` is the poll metadata frame. Returns an i18n key + args (the UI owns
// t(); this code also runs in the service worker, which cannot resolve a language).
function _galleryLabelKey(m) {
  if (!m) return { key: 'prog.starting' };
  if ((m.queue || 0) > 0) return { key: 'prog.queue_ahead', args: { n: m.queue } };
  const total = m.total || 0;
  if (!m.dispatched && (m.pre || 0) === 0 && (m.done || 0) === 0) return { key: 'prog.starting' };
  if (total && (m.pre || 0) < total) return { key: 'prog.reading_text', args: { done: m.pre || 0, total } };
  const batches = m.batches || 0;
  if (batches && (m.tlDone || 0) < batches) {
    const b = Math.min(batches, Math.max(m.tlStarted || 0, (m.tlDone || 0) + 1));
    return batches > 1 ? { key: 'prog.translating_n', args: { done: b, total: batches } } : { key: 'prog.translating' };
  }
  if (total && (m.done || 0) < total) return { key: 'prog.rendering', args: { done: m.done || 0, total } };
  return { key: 'prog.finishing' };
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

// Start a server-owned gallery job: upload the pages that need work and record the token + page
// order so any page can poll it (and resume after a navigation / SW kill) without re-uploading.
// Returns as soon as the job is created; the poll ticks drive it to completion. Each page is sent
// with its saved pipeline data and the stage its settings, code or models first changed, so the
// server skips everything before it. `forceFrom` re-runs every page from that stage at the latest
// (detect | ocr | translate | inpaint | render).
//
// The server runs one config per job, so a gallery with pages that keep their own settings is
// translated in groups (page-data.js translationGroups), one job each; when one finishes the next
// is queued, and `after` lists the groups this translation already ran. `pages` (urls) translates
// only those pages, with the current settings, and they keep those settings from then on.
export async function startTranslation(galleryId, ts, send = () => {}, { forceFrom = null, pages = null, after = [] } = {}) {
  const start = () => startTranslationUnlocked(galleryId, ts, send, { forceFrom, pages, after });
  if (!globalThis.navigator?.locks) return start();
  return navigator.locks.request(BENCHMARK_LOCK, { mode: 'shared', ifAvailable: true }, lock => {
    if (!lock) {
      send({ status: 'error', error: 'A translation benchmark is running. Try again after it finishes.' });
      return;
    }
    return start();
  });
}

async function startTranslationUnlocked(galleryId, ts, send, { forceFrom, pages, after }) {
  const gid = String(galleryId);
  if (_translating.has(gid)) return;
  _translating.add(gid);
  let ownedStart = null;
  try {
    // A server-owned job already being polled is a no-op. An interrupted upload claim is replayed
    // below with its original token, so accepted parts remain idempotent instead of being orphaned.
    let resume = await translateResume.get(gid);
    if (resume && resume.phase !== 'uploading') return;
    if (resume && !resume.config) { await translateResume.remove(gid, resume.token); resume = null; }   // an older format
    ts = migrateTranslateSettings((resume && resume.settings) || ts || {});
    const serverUrl = serverUrlFromSettings(ts);
    forceFrom = (resume && resume.forceFrom) || forceFrom || null;
    pages = (resume && resume.pages) || pages || null;
    after = (resume && resume.after) || after || [];
    // What the server offers (models, options, languages). A server that can't say degrades to
    // sending the stored choices as they are.
    const { doc: capsDoc } = await getCapabilities(serverUrl, ts);
    if (capsDoc && unavailableChoices(ts, capsDoc).length) {
      if (resume?.token) await translateResume.remove(gid, resume.token);
      send({ status: 'error', errorKey: 'err.model_unavailable',
        error: 'a model chosen in Settings → Translation is not available on this translation server' });
      return;
    }
    const noPipeline = async () => {
      if (resume?.token) await translateResume.remove(gid, resume.token);
      send({ status: 'error', error: 'the translation server could not describe its pipeline' });
    };

    const records = (await getGalleryImageRecords(gid)).filter(r => r.blob ?? r.dataUrl);
    const byUrl = new Map(records.map(r => [r.url, r]));
    const total = Number(resume && resume.total) || records.length;
    const entries = (await metaGet(gid))?.translations || {};
    const byPage = (a, b) => _pageNumOf(a.url) - _pageNumOf(b.url);

    // The group of pages this job runs, with its config, the server's resolve document for it and
    // where each page starts (null = current, from the translation that produced its saved data).
    let group = null;
    if (resume) {
      const changes = new Map();
      group = { own: resume.group ?? null, pin: !!resume.pin, more: !!resume.more, config: resume.config,
        resolved: resume.resolved, pending: resume.pendingUrls.map(url => byUrl.get(url)).filter(Boolean) };
      group.plans = new Map(group.pending.map(r => [r.url, planPage(r, entries, group.resolved, changes, forceFrom)]));
    } else {
      const base = buildConfig(ts, capsDoc);
      const groups = pages
        ? [{ own: null, pages: records.filter(r => pages.includes(r.url)) }]
        : translationGroups(records, entries).filter(g => !after.includes(g.own ?? ''));
      const current = [];
      for (const [i, candidate] of groups.entries()) {
        if (!candidate.pages.length) continue;
        const config = candidate.own ? keptConfig(base, entries[candidate.own].config) : base;
        const resolved = await _resolve(serverUrl, ts, config);
        if (!resolved) { await noPipeline(); return; }
        const changes = new Map();
        const plans = new Map(candidate.pages.map(r => [r.url, planPage(r, entries, resolved, changes, forceFrom)]));
        const pending = candidate.pages.filter(r => plans.get(r.url) !== null).sort(byPage);
        if (pending.length) {
          // Pages asked for by themselves, and pages keeping settings, keep this job's from now on.
          group = { own: candidate.own, pin: !!(pages || candidate.own), more: i < groups.length - 1,
            config, resolved, plans, pending };
          break;
        }
        current.push(...candidate.pages);
      }
      if (!group) {
        // Nothing to redo. Pages asked for by themselves keep the settings they are current with.
        if (pages) for (const r of current) if (entries[r.pipeline?.job]) await setPagesOwn([r.url], r.pipeline.job);
        await _finishGallery(gid, { lang: pages ? null : languageTag(capsDoc, base.translator?.target_lang) });
        send({ status: 'done', done: total, total });
        return;
      }
    }
    const { config, resolved, plans, pending } = group;
    if (!resolved) { await noPipeline(); return; }
    const tlName = config.translator.translator;
    const langCode = languageTag(capsDoc, config.translator.target_lang);
    const cap = batchCap(capsDoc, tlName, ts.batchCaps);
    // A context-aware translator starting mid-gallery gets the pages before as context.
    const usesContext = !!stageOf(capsDoc, 'translate')?.implementations.find(i => i.id === tlName)?.context;
    let context = resume ? resume.context || null : (usesContext ? contextBefore(records, pending[0], _pageNumOf) : null);
    while (context && context.length && JSON.stringify(context).length > CONTEXT_BYTES) context = context.slice(1);
    if (!context?.length) context = null;

    if (resume && pending.length !== resume.pendingUrls.length) {
      if (await translateResume.remove(gid, resume.token)) send({ status: 'error', error: 'one or more source pages could not be read' });
      return;
    }

    const jobToken = (resume && resume.token) || (globalThis.crypto?.randomUUID?.() || `${gid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const job = (resume && resume.job) || _jobId();
    // Sent with the job so the server's operator can tell their own queued translations apart.
    // Whatever the gallery already carries, passed through verbatim; kept on the resume record
    // so a job that resumes after a restart still reports the same origin.
    const sourceUrl = (resume && resume.sourceUrl) || ((await metaGet(gid))?.sourceUrl || '');
    if (!resume) {
      // `settings` stays on the record deliberately: a notfound restart can run in the service
      // worker, which cannot read localStorage-backed settings — this row is the only durable
      // carrier. Its one credential (serverToken) is required for every poll/cancel auth.
      // `group`/`pin`/`more`/`after`/`pages` say which pages of the gallery this job is and what
      // follows it; `config` and `context` let an interrupted upload resume unchanged.
      resume = {
        gid, token: jobToken, job, serverUrl, settings: ts, langCode, translator: tlName, cap,
        sourceUrl, forceFrom, resolved, config, context, group: group.own, pin: group.pin, more: group.more,
        after, pages, pendingUrls: pending.map(p => p.url), total, cursor: 0, phase: 'uploading',
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
    send({ status: 'started', done: total - pending.length, total, labelKey: 'prog.preparing', pct: 0 });

    // Upload the pages and create the job — the server runs the worker detached and buffers
    // frames. A remote proxy may cap request bodies, so a big gallery is uploaded as several
    // deterministic page groups sharing the job token; the server assembles them in order and
    // starts when the last one lands. Eight pages stay below the request cap even when every
    // converted page reaches its 8 MB ceiling, and only one group is retained in memory at once.
    const REMOTE_PAGES_PER_PART = 8;
    const split = !isLocalServer(serverUrl);
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
        // The page's saved stage outputs and where to start; empty for a full run.
        const plan = plans.get(pending[j].url);
        form.append('stage', plan?.data ? encodePageData(pending[j].pipeline, plan) : new Blob([]), 'stage.bin');
      }
      form.append('config', JSON.stringify(config));
      form.append('builds', resolved.signature);
      if (context) form.append('context', JSON.stringify(context));
      // Snapshots off (Settings → Translation, the default): pages keep no pipeline data, so none
      // comes back.
      if (!ts.saveSnapshots) form.append('capture', '0');
      form.append('batch_size', String(cap));
      form.append('job_token', jobToken);
      form.append('part', String(i));
      form.append('parts', String(partCount));
      if (sourceUrl) form.append('source_url', sourceUrl);
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

    // Record this translation before any page names it, so a page stored mid-job always points at
    // a known config (the entry is pruned once no page refers to it).
    const meta = await metaGet(gid);
    if (meta) await metaPut({ ...meta, translations: { ...(meta.translations || {}), [job]: _entry(resolved) } }, { silent: true });

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
    send({ status: 'started', done: total - pending.length, total, labelKey: 'prog.starting', pct: 0 });
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

const _entry = (resolved) => ({ at: Date.now(), config: resolved.config, builds: resolved.builds });

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
    const { token, job, serverUrl, pendingUrls, settings, langCode, translator, cap, total } = rec;
    if (!_staged.has(token)) _staged.set(token, new Map());
    const staged = _staged.get(token);
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
      else if (st === 9 || st === 5 || st === 6) {
        const tlen = data[0];
        if (dec.decode(data.subarray(1, 1 + tlen)) !== token) continue;   // mix-up guard
        const b = 1 + tlen;
        const idx = ((data[b] << 24) | (data[b + 1] << 16) | (data[b + 2] << 8) | data[b + 3]) >>> 0;
        const url = pendingUrls[idx];
        const payload = data.subarray(b + 4);
        if (!url) continue;
        if (st === 9) {
          const page = decodePageData(payload);
          if (page) staged.set(idx, page);
        } else if (st === 5) {
          if (!await ownsToken()) continue;
          const page = staged.get(idx);
          staged.delete(idx);
          // Stored as a Blob (data URLs cost ~33% more), together with the data that produced it —
          // or, when none came back (snapshots are off, or a worker with other builds), only
          // which translation made it; a page that keeps its own settings keeps this translation's.
          // No image: the page is its study data, in the frame that follows.
          await putTranslatedPage(url, payload.length ? new Blob([payload], { type: _imgMime(payload) }) : null,
            page ? { job, ...page.record, masks: page.masks } : { job }, rec.pin ? job : undefined);
        } else {
          let study = null; try { study = JSON.parse(dec.decode(payload)); } catch {}
          if (study && Array.isArray(study.bubbles) && study.bubbles.length) {
            // text_and_image frames carry bg + per-bubble text layers; text_only frames carry
            // metadata only (no bg, no text) and render as DOM text in the reader.
            const bg = study.bg ? await imageToBlob(study.bg) : null;
            if (!study.bg || bg) {
              const bubbles = [];
              for (const bb of study.bubbles) {
                if (!bb.box) continue;
                const bubble = { box: bb.box, region: bb.region || bb.box, tr: bb.tr || '', src: bb.src || '' };
                if (bb.id != null) bubble.id = bb.id;
                if (bb.line_ids) bubble.lineIds = bb.line_ids;
                if (bb.raw_tr != null) bubble.rawTr = bb.raw_tr;
                if (bb.rbox)  bubble.rbox  = bb.rbox;
                if (bb.style) bubble.style = bb.style;
                // Optional DOM-text extras: the renderer's drawn rect and source-line furigana.
                if (Array.isArray(bb.furi)     && bb.furi.length)     bubble.furi     = bb.furi;
                if (bb.tbox) bubble.tbox = bb.tbox;
                // The area the renderer laid the text into (page-fraction polygon).
                if (Array.isArray(bb.shape) && bb.shape.length >= 3) bubble.shape = bb.shape;
                if (bb.text) { const text = await imageToBlob(bb.text); if (!text) continue; bubble.text = text; }
                bubbles.push(bubble);
              }
              if (bubbles.length && await ownsToken()) await putPageStudy(url, { bg, bubbles, page: study.page || null }, job);
            }
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
        const payload = { galleryId: gid, settings, forceFrom: rec.forceFrom, pages: rec.pages, after: rec.after };
        if (await jobsPending.add({ key, kind: 'translate', payload })) {
          send({ status: 'started', done: total - pendingUrls.length, total, labelKey: 'prog.restarting', pct: 0 });
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
      if (await ownsToken()) {
        const lbl = _galleryLabelKey(meta);
        send({ status: 'progress', done, total, labelKey: lbl.key, labelArgs: lbl.args, pct: _galleryPct(meta) });
      }
      return;
    }

    // Terminal — finalize once and stop polling this gallery. Cancel/error still remove the
    // durable row first (there is nothing to finalize); the success path writes the gallery
    // meta BEFORE removing the row, so a kill in that gap self-heals on the next poll (the
    // idempotent meta write simply runs again) instead of silently losing the finalization.
    const _dropController = () => {
      const entry = _controllers.get(gid);
      if (!entry || entry.jobToken === token) _controllers.delete(gid);
    };
    if (meta.status === 'cancelled' && !summary) {
      if (!await translateResume.remove(gid, token)) return;
      _dropController();
      // Server-side cancel (liveness reaper, or a cancel issued from another context). Clearing
      // the resume token above is what stops the polling — without it the job would sit in
      // 'cancelled' until eviction and then restart from scratch via the notfound path. Already
      // stored pages stay; a later Translate resumes with only the missing ones.
      await jobsPending.remove(`${gid}:translate`);
      send({ status: 'cancelled' });
      return;
    }
    if (errMsg && done <= startDone) {
      if (!await translateResume.remove(gid, token)) return;
      _dropController();
      send({ status: 'error', error: errMsg });
      return;
    }
    const failed = (summary && Array.isArray(summary.failed)) ? summary.failed.length : Math.max(0, total - done);
    if (!await ownsToken()) return;
    // Gallery status reflects the pages: only complete output is marked translated; partial
    // output is durably 'partial' — never labeled complete.
    await _finishGallery(gid, { job, entry: _entry(rec.resolved), lang: rec.group == null && !rec.pages ? langCode : null });
    if (!await translateResume.remove(gid, token)) return;
    _dropController();
    if (rec.more) {
      // Pages keeping other settings are next: queued through the durable runner, which the next
      // heartbeat picks up, like a restart.
      const payload = { galleryId: gid, settings, forceFrom: rec.forceFrom, after: [...(rec.after || []), rec.group ?? ''] };
      if (await jobsPending.add({ key: `${gid}:translate`, kind: 'translate', payload })) {
        send({ status: 'started', done, total, labelKey: 'prog.preparing', pct: 0 });
        return;
      }
    }
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

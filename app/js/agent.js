// agent.js — the app's database agent, hosted by the extension.
//
// The extension's offscreen document embeds agent.html in an iframe. This frame is app-origin
// and (because the extension has host permissions for it) exempt from storage partitioning, so
// everything here operates on the real library: the same IndexedDB, localStorage and
// BroadcastChannels every app tab uses.
//
// The API is deliberately GENERIC: store a page under a key, read metadata, publish a job,
// report what exists. The agent knows nothing about any external site — which sites exist, how
// their URLs look, and how to fetch from them is entirely the embedding extension's business.
//
// Protocol (window.postMessage handshake, then a dedicated MessagePort):
//   host → agent   { __shioriAgentHello, secret }             pairing attempt (repeat until paired)
//   agent → host   { __shioriAgentPaired } + [MessagePort]    session opened; ops use the port
//   port: host → agent { id, op, data } · agent → host { __shioriAgentReply, id, ok, data|error }

import * as platform from './platform.js';
import { isValidGalleryId } from './sanitize.js';
import {
  resolveGalleryId, dbGet, dbPut, metaGet, metaPut, galleryGet, coverGet, coverPut,
  resizeCover, getStats, galleriesPage, galleriesCount, existingPageNums, pageExistsForGallery,
  deleteGallery, deleteGalleryImages, rebuildGalleryEntry,
  mutateGallery, refreshSeriesAggregate, isSeriesMeta, effectiveTagsOf, publishFeed,
  metaGetAllMap, getGalleryPages, getGalleryPageRange, getGalleryImageRecords, imageToBlob, imageToDataUrl,
} from './db.js';
import { pickTitle } from './titles.js';

function storedPageNum(pageNum, url) {
  const explicit = Number(pageNum);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  const match = String(url || '').match(/\/([1-9]\d*)\.[^/?#]+$/);
  const parsed = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// ── Toast payload (the "saved to library" card the extension shows on-site) ────────────────
async function toastFor(gid) {
  const m = await metaGet(gid).catch(() => null);
  if (!m || m.isStub) return null;
  const isSeries = isSeriesMeta(m);
  const tags = effectiveTagsOf(m) || [];
  let cover = null;
  try { const src = await coverGet(gid, { preferSeries: isSeries }); if (src) cover = await resizeCover(src, 96); } catch {}
  return {
    galleryId: m.sourceId || gid,
    title: pickTitle(m),
    tags,
    numPages: m.numPages || 0,
    cover,
  };
}

const _toastedGalleries = new Set();

async function allOrThrow(promises) {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map(result => result.value);
}

// Series grouping (chapters / parentId / seriesTitle / seriesTags) is an app-only concept the
// embedding side knows nothing about. metaPut replaces the whole record, so a generic per-gallery
// meta — which never carries these fields — would dissolve a series (wiping the owner's chapter
// list) or orphan a chapter (wiping its parentId) just by backfilling its metadata. Carry across
// any grouping field the incoming meta didn't set so a metadata write can't destroy grouping.
const GROUPING_FIELDS = ['chapters', 'parentId', 'seriesTitle', 'seriesTags'];
async function metaPutKeepingGrouping(meta, opts) {
  const prev = await metaGet(meta.galleryId).catch(() => null);
  if (!prev) return metaPut(meta, opts);
  const merged = { ...meta };
  for (const field of GROUPING_FIELDS) {
    if (merged[field] === undefined && prev[field] !== undefined) merged[field] = prev[field];
  }
  return metaPut(merged, opts);
}

// ── Payload validation ──────────────────────────────────────────────────────────────────────
// Every id is format-checked and every collection capped before a handler runs — a malformed
// payload is a protocol error, never a best-effort write. Ids must be the app's own numeric
// convention (they reach DOM attributes and hrefs on every surface).
const MAX_PAGE_BYTES  = 64 * 1024 * 1024;
const MAX_COVER_BYTES = 16 * 1024 * 1024;
const MAX_BATCH = 500;
const _id = (v) => { const s = String(v ?? ''); if (!isValidGalleryId(s)) throw new Error('invalid gallery id'); return s; };
const _cap = (arr, n, what) => { const a = Array.isArray(arr) ? arr : []; if (a.length > n) throw new Error(`${what} exceeds the allowed size`); return a; };
const _bytesOk = (bytes, max) => bytes == null || ((bytes.byteLength ?? bytes.length ?? 0) <= max);
function _checkMetaIds(meta) {
  _id(meta.galleryId);
  if (meta.parentId != null) _id(meta.parentId);
  if (Array.isArray(meta.chapters)) for (const c of _cap(meta.chapters, MAX_BATCH, 'chapters')) _id(c?.id);
}

// The kv surface the companion actually needs — never arbitrary keys, never values that carry
// credentials for other services (translateSettings) or the pairing capability itself.
const KV_GET_KEYS = new Set(['cacheEnabled', 'apiKey']);
const KV_SET_KEYS = new Set(['cacheEnabled', 'apiKey', 'translateSettings']);
const KV_HAS_KEYS = new Set(['cacheEnabled', 'apiKey', 'translateSettings']);

// ── Operations ──────────────────────────────────────────────────────────────────────────────
const OPS = {
  async ping() { return { ok: true, at: Date.now() }; },

  async kv_get({ keys }) {
    return platform.kv.get((Array.isArray(keys) ? keys : []).filter((k) => KV_GET_KEYS.has(k)));
  },
  async kv_set({ values }) {
    platform.kv.set(Object.fromEntries(Object.entries(values || {}).filter(([k]) => KV_SET_KEYS.has(k))));
    return { ok: true };
  },
  // Presence check without value exposure (a settings handoff only needs "is it already set").
  async kv_has({ keys }) {
    const allowed = (Array.isArray(keys) ? keys : []).filter((k) => KV_HAS_KEYS.has(k));
    const vals = await platform.kv.get(allowed);
    const out = {};
    for (const k of allowed) out[k] = vals[k] !== undefined;
    return out;
  },

  // Library snapshot for the extension popup: totals + the most recent galleries with covers.
  async snapshot({ coverWidth = 88, limit = 5 } = {}) {
    coverWidth = Math.min(Math.max(Number(coverWidth) || 88, 1), 1024);
    limit = Math.min(Math.max(Number(limit) || 5, 1), 50);
    const [stats, total, recent] = await Promise.all([getStats(), galleriesCount(), galleriesPage({ sort: 'updated', limit })]);
    const galleries = [];
    for (const g of recent) {
      let cover = null;
      try { const src = await coverGet(g.id, { preferSeries: g.isSeries }); if (src) cover = await resizeCover(src, coverWidth); } catch {}
      galleries.push({
        id: g.id, sourceId: g.sourceId, title: pickTitle(g), count: g.count || 0, size: g.size || 0,
        source: g.source || '', tags: (g.tags || []).slice(0, 8), cover,
      });
    }
    return { stats: { totalImages: stats.totalImages, totalSize: stats.totalSize, totalGalleries: total }, galleries };
  },

  async delete_gallery({ galleryId }) {
    await deleteGallery(_id(galleryId));
    return { ok: true };
  },

  // ── Serving cached pages back (translated variant preferred) ──
  async gallery_pages({ galleryId }) {
    const gid = await resolveGalleryId(_id(galleryId));
    return getGalleryPages(gid, { preferTranslated: true });
  },

  async pages_window({ galleryId, startPage, endPage }) {
    const gid = await resolveGalleryId(_id(galleryId));
    return getGalleryPageRange(gid, Number(startPage) || 0, Number(endPage) || 0, { preferTranslated: true });
  },

  async images_batch({ galleryId, queries }) {
    const results = {};
    if (!galleryId || !queries?.length) return { results };
    _cap(queries, 2000, 'queries');
    const gid = await resolveGalleryId(_id(galleryId));
    const records = await getGalleryImageRecords(gid);
    const byUrl  = new Map(records.map(r => [r.url, r]));
    const byPage = new Map();
    for (const r of records) {
      const m = r.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      if (m) byPage.set(parseInt(m[1]), r);
    }
    for (const { url, pageNum } of queries) {
      const rec = byUrl.get(url) ?? (!isNaN(pageNum) ? byPage.get(pageNum) : undefined);
      const dataUrl = rec ? await imageToDataUrl(rec.translated ?? rec.blob ?? rec.dataUrl) : undefined;
      if (dataUrl) results[url] = dataUrl;
    }
    return { results };
  },

  // ── Generic storage ops the extension's site engines compose ──

  // Map an external source reference to this library's gallery id (creates a stub on first
  // sight). Internal ids are ≥13-digit timestamps (see resolveGalleryId): an external ref that
  // long would silently bypass resolution and alias an internal record, so it is refused here.
  async resolve_gid({ sourceRef }) {
    const ref = _id(sourceRef);
    if (/^\d{13,}$/.test(ref)) throw new Error('source ref collides with the internal id space');
    return { gid: await resolveGalleryId(ref) };
  },

  async resolve_gids({ sourceRefs }) {
    return { gids: await allOrThrow(_cap(sourceRefs, 2000, 'sourceRefs').map((r) => {
      const ref = _id(r);
      if (/^\d{13,}$/.test(ref)) throw new Error('source ref collides with the internal id space');
      return resolveGalleryId(ref);
    })) };
  },

  // Everything an engine needs to decide what to do with a gallery: stats + the meta record.
  async gallery_info({ galleryId }) {
    const gid = _id(galleryId);
    const [gal, meta] = await Promise.all([galleryGet(gid), metaGet(gid)]);
    return { gid, count: gal?.count || 0, size: gal?.size || 0, meta: meta || null };
  },

  async source_galleries({ source }) {
    const [metas, stats] = await Promise.all([metaGetAllMap(), getStats()]);
    const galleries = [];
    for (const [gid, meta] of metas) {
      if (source && meta?.source !== source) continue;
      const stat = stats.galleries?.[gid] || {};
      galleries.push({
        gid,
        count: stat.count || 0,
        size: stat.size || 0,
        meta,
      });
    }
    return { galleries };
  },

  async existing_pages({ galleryId }) {
    return { pages: [...await existingPageNums(_id(galleryId))] };
  },

  async page_exists({ galleryId, url, pageNum }) {
    if (url && await dbGet(String(url))) return { exists: true };
    if (pageNum != null && await pageExistsForGallery(_id(galleryId), Number(pageNum))) return { exists: true };
    return { exists: false };
  },

  // Store one page under the key the engine chose. Accepts raw bytes (transferred) or a data URL.
  async store_page({ galleryId, url, bytes, dataUrl, mime, mediaId, pageNum, wantDataUrl }) {
    const gid = _id(galleryId);
    if (typeof url !== 'string' || !url || url.length > 2048) throw new Error('invalid page key');
    if (!_bytesOk(bytes, MAX_PAGE_BYTES) || !_bytesOk(dataUrl, MAX_PAGE_BYTES * 1.4)) throw new Error('page too large');
    const src = bytes ? new Blob([bytes], { type: mime || 'application/octet-stream' }) : dataUrl;
    await dbPut(url, src, mediaId ?? gid, gid);
    const storedNum = storedPageNum(pageNum, url);
    if (storedNum != null) {
      platform.jobs.signal({ type: 'PAGE_STORED', galleryId: gid, pageNum: storedNum, url });
    }
    const out = { stored: true };
    if (wantDataUrl) out.dataUrl = await imageToDataUrl(src instanceof Blob ? src : dataUrl);
    return out;
  },

  async store_cover({ galleryId, bytes, dataUrl, mime, role, silent }) {
    if (!galleryId || (!bytes && !dataUrl)) return { ok: false };
    if (!_bytesOk(bytes, MAX_COVER_BYTES) || !_bytesOk(dataUrl, MAX_COVER_BYTES * 1.4)) throw new Error('cover too large');
    const gid = _id(galleryId);
    const src = bytes ? new Blob([bytes], { type: mime || 'application/octet-stream' }) : dataUrl;
    const cover = await imageToBlob(src);
    if (!cover) return { ok: false };
    // coverPut normally announces the change itself; a prepared batch can defer that announcement.
    await coverPut(gid, cover, { role: role === 'series' ? 'series' : 'gallery', silent: !!silent });
    return { ok: true };
  },

  async meta_put({ meta }) {
    if (!meta || !meta.galleryId) return { ok: false };
    _checkMetaIds(meta);
    await metaPutKeepingGrouping(meta);
    return { ok: true };
  },

  async mutate_gallery({ galleryId, patch }) {
    if (!galleryId) return { ok: false };
    if (patch) _checkMetaIds({ ...patch, galleryId });
    await mutateGallery(_id(galleryId), patch || {});
    return { ok: true };
  },

  // Apply a prepared set of generic gallery records without exposing each intermediate state.
  // The caller chooses the final records and notification ids; the app only commits them and
  // announces the completed batch once.
  async gallery_batch({ metas, mutations, refreshSeries, notifyGalleryIds, invalidateCoverIds }) {
    for (const meta of _cap(metas, MAX_BATCH, 'metas')) { if (meta?.galleryId) _checkMetaIds(meta); }
    for (const mutation of _cap(mutations, MAX_BATCH, 'mutations')) {
      if (mutation?.galleryId) _checkMetaIds({ ...(mutation.patch || {}), galleryId: mutation.galleryId });
    }
    _cap(refreshSeries, MAX_BATCH, 'refreshSeries').forEach((ownerId) => { if (ownerId != null) _id(ownerId); });
    _cap(notifyGalleryIds, 2000, 'notifyGalleryIds').forEach((gid) => _id(gid));
    _cap(invalidateCoverIds, 2000, 'invalidateCoverIds').forEach((gid) => _id(gid));
    await allOrThrow((metas || [])
      .filter(meta => meta?.galleryId)
      .map(meta => metaPutKeepingGrouping(meta, { silent: true })));
    await allOrThrow((mutations || [])
      .filter(mutation => mutation?.galleryId)
      .map(mutation => mutateGallery(String(mutation.galleryId), mutation.patch || {}, { silent: true })));
    await allOrThrow((refreshSeries || [])
      .filter(ownerId => ownerId != null)
      .map(ownerId => refreshSeriesAggregate(String(ownerId), { silent: true })));
    for (const galleryId of new Set(invalidateCoverIds || [])) {
      platform.control.send({ type: 'COVER_INVALIDATED', galleryId: String(galleryId) });
    }
    for (const galleryId of new Set(notifyGalleryIds || [])) publishFeed(String(galleryId));
    return { ok: true };
  },

  async refresh_series({ ownerId }) {
    if (!ownerId) return { ok: false };
    await refreshSeriesAggregate(_id(ownerId));
    return { ok: true };
  },

  // One-shot "saved to library" toast payload per gallery per agent lifetime.
  async toast_once({ galleryId }) {
    const gid = _id(galleryId);
    if (_toastedGalleries.has(gid)) return { toast: null };
    const toast = await toastFor(gid);
    if (toast) _toastedGalleries.add(gid);
    return { toast };
  },

  async delete_pages({ galleryId }) {
    await deleteGalleryImages(_id(galleryId));
    return { ok: true };
  },

  // Recompute a gallery's stat record from its actual stored pages.
  async rebuild({ galleryId }) {
    await rebuildGalleryEntry(_id(galleryId));
    return { ok: true };
  },

  // Relay job status into the app's live job channel (registry + broadcast to every tab).
  async publish_job({ job }) {
    if (job && job.gid != null) { _id(job.gid); await platform.jobs.publish(job); }
    return { ok: true };
  },
};

// ── Message wiring ──────────────────────────────────────────────────────────────────────────
// Trust model (a deliberate decision, not an oversight). The agent must serve exactly one
// embedder — the user's companion helper — without naming it (no extension-id pinning in app
// code; the app stays generic). Possession of the pairing capability IS the authentication:
// the companion's own UI runs inside app pages, mints an unguessable secret, and stores it in
// the app's kv under 'agentPairSecret'; only a context that can present that secret opens a
// session. The scheme gate below merely narrows the surface to extension embedders and
// same-origin callers (a same-origin caller already owns this storage outright, so the bridge
// grants it nothing it lacks). A session binds to the exact WindowProxy + origin that presented
// the secret, and all ops then flow over a dedicated MessagePort — ambient window messages are
// never accepted for operations, and an unpaired caller receives no reply at all.
const _isPlausibleEmbedder = (o) =>
  o.startsWith('chrome-extension://') || o.startsWith('moz-extension://') || o === location.origin;

let _session = null;   // { source, origin, port }

async function _pairSecretOk(secret) {
  if (typeof secret !== 'string' || secret.length < 16) return false;
  const { agentPairSecret } = await platform.kv.get(['agentPairSecret']);
  return typeof agentPairSecret === 'string' && agentPairSecret.length >= 16 && secret === agentPairSecret;
}

function _openSession(source, origin) {
  const channel = new MessageChannel();
  _session = { source, origin, port: channel.port1 };
  channel.port1.onmessage = (ev) => {
    const { id, op, data } = ev.data || {};
    if (id == null || typeof op !== 'string') return;
    Promise.resolve()
      .then(() => { const handler = OPS[op]; if (!handler) throw new Error(`unknown op: ${op}`); return handler(data || {}); })
      .then((result) => channel.port1.postMessage({ __shioriAgentReply: true, id, ok: true, data: result }))
      .catch((err) => channel.port1.postMessage({ __shioriAgentReply: true, id, ok: false, error: String(err && err.message || err) }));
  };
  source.postMessage({ __shioriAgentPaired: true }, origin, [channel.port2]);
}

window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || !d.__shioriAgentHello || !_isPlausibleEmbedder(e.origin)) return;
  const source = e.source, origin = e.origin;
  _pairSecretOk(d.secret).then((ok) => {
    // Silent on failure: an unpaired caller learns nothing, not even that an agent lives here.
    if (ok && source) _openSession(source, origin);
  });
});

console.log('[shiori] agent loaded', location.href);

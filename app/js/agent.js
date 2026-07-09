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
// Protocol (window.postMessage with the embedding offscreen document):
//   host → agent   { __shioriAgent, id, op, data }            an operation request
//   agent → host   { __shioriAgentReply, id, ok, data|error } its reply
//   agent → host   { __shioriAgentReady }                     posted once on load

import * as platform from './platform.js';
import {
  resolveGalleryId, dbGet, dbPut, metaGet, metaPut, galleryGet, coverGet, coverPut,
  resizeCover, getStats, galleriesPage, galleriesCount, existingPageNums, pageExistsForGallery,
  deleteGallery, deleteGalleryImages, rebuildGalleryEntry,
  mutateGallery, refreshSeriesAggregate, isSeriesMeta, effectiveTagsOf,
  metaGetAllMap, getGalleryPages, getGalleryPageRange, getGalleryImageRecords, imageToBlob, imageToDataUrl,
} from './db.js';
import { pickTitle } from './titles.js';

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

// ── Operations ──────────────────────────────────────────────────────────────────────────────
const OPS = {
  async ping() { return { ok: true, at: Date.now() }; },

  async kv_get({ keys }) { return platform.kv.get(keys || []); },
  async kv_set({ values }) { platform.kv.set(values || {}); return { ok: true }; },

  // Library snapshot for the extension popup: totals + the most recent galleries with covers.
  async snapshot({ coverWidth = 88, limit = 5 } = {}) {
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
    await deleteGallery(String(galleryId));
    return { ok: true };
  },

  // ── Serving cached pages back (translated variant preferred) ──
  async gallery_pages({ galleryId }) {
    const gid = await resolveGalleryId(galleryId);
    return getGalleryPages(gid, { preferTranslated: true });
  },

  async pages_window({ galleryId, startPage, endPage }) {
    const gid = await resolveGalleryId(galleryId);
    return getGalleryPageRange(gid, startPage, endPage, { preferTranslated: true });
  },

  async images_batch({ galleryId, queries }) {
    const results = {};
    if (!galleryId || !queries?.length) return { results };
    const gid = await resolveGalleryId(galleryId);
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

  // Map an external source reference to this library's gallery id (creates a stub on first sight).
  async resolve_gid({ sourceRef }) {
    return { gid: await resolveGalleryId(sourceRef) };
  },

  // Everything an engine needs to decide what to do with a gallery: stats + the meta record.
  async gallery_info({ galleryId }) {
    const gid = String(galleryId);
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
    return { pages: [...await existingPageNums(String(galleryId))] };
  },

  async page_exists({ galleryId, url, pageNum }) {
    if (url && await dbGet(url)) return { exists: true };
    if (pageNum != null && await pageExistsForGallery(String(galleryId), pageNum)) return { exists: true };
    return { exists: false };
  },

  // Store one page under the key the engine chose. Accepts raw bytes (transferred) or a data URL.
  async store_page({ galleryId, url, bytes, dataUrl, mime, mediaId, wantDataUrl }) {
    const gid = String(galleryId);
    const src = bytes ? new Blob([bytes], { type: mime || 'application/octet-stream' }) : dataUrl;
    await dbPut(url, src, mediaId ?? gid, gid);
    const out = { stored: true };
    if (wantDataUrl) out.dataUrl = await imageToDataUrl(src instanceof Blob ? src : dataUrl);
    return out;
  },

  async store_cover({ galleryId, bytes, dataUrl, mime, role }) {
    if (!galleryId || (!bytes && !dataUrl)) return { ok: false };
    const gid = String(galleryId);
    const src = bytes ? new Blob([bytes], { type: mime || 'application/octet-stream' }) : dataUrl;
    const cover = await imageToBlob(src);
    if (!cover) return { ok: false };
    // coverPut announces the change itself (libraryVersion bump + COVER_INVALIDATED + feed).
    await coverPut(gid, cover, { role: role === 'series' ? 'series' : 'gallery' });
    return { ok: true };
  },

  async meta_put({ meta }) {
    if (!meta || !meta.galleryId) return { ok: false };
    await metaPut(meta);
    platform.kv.set({ libraryVersion: Date.now() });
    return { ok: true };
  },

  async mutate_gallery({ galleryId, patch }) {
    if (!galleryId) return { ok: false };
    await mutateGallery(String(galleryId), patch || {});
    platform.kv.set({ libraryVersion: Date.now() });
    return { ok: true };
  },

  async refresh_series({ ownerId }) {
    if (!ownerId) return { ok: false };
    await refreshSeriesAggregate(String(ownerId));
    platform.kv.set({ libraryVersion: Date.now() });
    return { ok: true };
  },

  // One-shot "saved to library" toast payload per gallery per agent lifetime.
  async toast_once({ galleryId }) {
    const gid = String(galleryId);
    if (_toastedGalleries.has(gid)) return { toast: null };
    const toast = await toastFor(gid);
    if (toast) _toastedGalleries.add(gid);
    return { toast };
  },

  async delete_pages({ galleryId }) {
    await deleteGalleryImages(String(galleryId));
    return { ok: true };
  },

  // Recompute a gallery's stat record from its actual stored pages.
  async rebuild({ galleryId }) {
    await rebuildGalleryEntry(String(galleryId));
    return { ok: true };
  },

  // Relay job status into the app's live job channel (registry + broadcast to every tab).
  async publish_job({ job }) {
    if (job && job.gid != null) await platform.jobs.publish(job);
    return { ok: true };
  },
};

// ── Message wiring ──────────────────────────────────────────────────────────────────────────
const _isTrustedOrigin = (o) => o.startsWith('chrome-extension://') || o === location.origin;

window.addEventListener('message', (e) => {
  if (!e.data || !_isTrustedOrigin(e.origin) || !e.data.__shioriAgent) return;
  const { id, op, data } = e.data;
  const handler = OPS[op];
  Promise.resolve()
    .then(() => { if (!handler) throw new Error(`unknown op: ${op}`); return handler(data || {}); })
    .then((result) => e.source.postMessage({ __shioriAgentReply: true, id, ok: true, data: result }, e.origin))
    .catch((err) => e.source.postMessage({ __shioriAgentReply: true, id, ok: false, error: String(err && err.message || err) }, e.origin));
});

if (window.parent !== window) window.parent.postMessage({ __shioriAgentReady: true }, '*');
console.log('[shiori] agent ready', location.href);

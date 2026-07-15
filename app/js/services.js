// services.js — the in-tab service layer behind the UI's rpc() calls. Light work (covers,
// deletes) runs right here; durable jobs (upload, translate) go to submitJob, which prefers the
// PWA service worker so they survive the tab closing; anything needing cross-domain access
// (downloads, source-site metadata) is delegated to the extension over the bridge — the
// extension's agent runs it against this same database and progress comes back live via
// platform.jobs / the change feed.

import * as platform from './platform.js';
import {
  coverThumbnailGet, coverThumbnailPut, resizeCoverBlob, imageToDataUrl,
  deleteGallery, metaGet, metaPut,
} from './db.js';
import { resolveSeries } from './series.js';
import { pingServer, revertGallery, serverUrlFromSettings } from './translate.js';
import { request as extRequest } from './ext-bridge.js';
import { submitJob, cancelJob } from './submit-job.js';

const _seriesCoverRequested = new Set();
const _coverWork = new Map();
const _coverResizeWaiters = [];
let _activeCoverResizes = 0;
const MAX_COVER_RESIZES = 4;

async function withCoverResizeSlot(task) {
  if (_activeCoverResizes >= MAX_COVER_RESIZES) {
    await new Promise(resolve => _coverResizeWaiters.push(resolve));
  }
  _activeCoverResizes++;
  try { return await task(); }
  finally {
    _activeCoverResizes--;
    _coverResizeWaiters.shift()?.();
  }
}

function normalizedCoverWidth(value) {
  const width = Math.round(Number(value));
  return Number.isFinite(width) && width > 0 ? width : 0;
}

function coverWorkKey(msg) {
  return JSON.stringify([
    String(msg.galleryId), normalizedCoverWidth(msg.thumbWidth),
    !!msg.preferSeries, String(msg.source || ''),
  ]);
}

function coverRequesterKey(msg) {
  return JSON.stringify([msg.page ?? null, msg.requester ?? null, msg.requestId ?? null]);
}

// GET_COVER is request→push: compute the thumbnail, deliver via COVER_READY. A gallery with no
// pages yet but a known source is offered to the extension (which knows whether that source can
// supply a cover); when it stores one, the change feed re-triggers this request.
async function buildCover(msg) {
  const preferSeries = !!msg.preferSeries;
  const seriesCoverKey = `${msg.source || ''}:${msg.galleryId}`;
  const width = normalizedCoverWidth(msg.thumbWidth);
  let entry = await coverThumbnailGet(msg.galleryId, width, { preferSeries });
  if (!entry.source) {
    if (msg.source) extRequest({ type: 'EXT_FETCH_COVER', galleryId: msg.galleryId, source: msg.source, preferSeries });
    return null;
  }
  if (preferSeries && !entry.hasSeriesCover && msg.source && !_seriesCoverRequested.has(seriesCoverKey)) {
    _seriesCoverRequested.add(seriesCoverKey);
    // One request per series per session — but an unanswered bridge (extension offline) shouldn't
    // burn the one shot, or the series stays stuck on its gallery cover until a full reload.
    extRequest({ type: 'EXT_FETCH_COVER', galleryId: msg.galleryId, source: msg.source, preferSeries })
      .then((r) => { if (r == null) _seriesCoverRequested.delete(seriesCoverKey); },
        () => _seriesCoverRequested.delete(seriesCoverKey));
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    let thumbnail = entry.thumbnail;
    let stored = true;
    if (!thumbnail) {
      thumbnail = await withCoverResizeSlot(() => resizeCoverBlob(entry.source, width));
      if (thumbnail) {
        stored = await coverThumbnailPut(msg.galleryId, entry.role, width, thumbnail, entry.revision);
      }
    }

    const coverDataUrl = await imageToDataUrl(thumbnail);
    // A series cover may land while its gallery fallback is being prepared. Recheck that fallback
    // before emitting; a duplicate invalidation request may have joined this same in-flight work.
    if (stored && !(preferSeries && entry.role === 'gallery')) return { coverDataUrl };
    const latest = await coverThumbnailGet(msg.galleryId, width, { preferSeries });
    if (latest.source && latest.role === entry.role && latest.revision === entry.revision) {
      return { coverDataUrl };
    }
    if (!latest.source) return null;
    entry = latest;
  }
  return null;
}

function getCover(msg) {
  const key = coverWorkKey(msg);
  const requesterKey = coverRequesterKey(msg);
  const pending = _coverWork.get(key);
  if (pending) {
    pending.requesters.set(requesterKey, msg);
    return;
  }

  const work = { requesters: new Map([[requesterKey, msg]]) };
  _coverWork.set(key, work);
  buildCover(msg).then((result) => {
    if (!result) return;
    for (const requester of work.requesters.values()) {
      const ready = {
        type: 'COVER_READY', galleryId: msg.galleryId,
        coverDataUrl: result.coverDataUrl, page: requester.page,
      };
      if (requester.requester != null) ready.requester = requester.requester;
      if (requester.requestId != null) ready.requestId = requester.requestId;
      platform.emitControl(ready);
    }
  }).catch(() => {}).finally(() => {
    if (_coverWork.get(key) === work) _coverWork.delete(key);
  });
}

export const services = {
  async handle(msg) {
    switch (msg && msg.type) {
      case 'GET_COVER':      getCover(msg); return null;                  // result arrives via COVER_READY
      case 'DELETE_GALLERY': await deleteGallery(msg.galleryId); return { ok: true };

      case 'IMPORT_CBZ':                                                  // upload → durable runner
        submitJob('upload', { galleryId: msg.galleryId, tempFile: msg.tempFile, filename: msg.filename, skipExisting: msg.skipExisting });
        return { ok: true, started: true };

      case 'TRANSLATE_GALLERY': {                                         // translate → durable runner
        const { translateSettings } = await platform.kv.get(['translateSettings']);
        submitJob('translate', { galleryId: msg.galleryId, settings: translateSettings });
        return { ok: true, started: true };
      }

      case 'CANCEL_TRANSLATE': {
        const gid = String(msg.galleryId);
        const rec = await platform.translateResume.get(gid);          // token/serverUrl so the cancel reaches the job from any context
        cancelJob('translate', { galleryId: gid, token: rec && rec.token, serverUrl: rec && rec.serverUrl, settings: rec && rec.settings });  // token-scoped server cancel (settings carry the access token)
        // Authoritative stop: clear the durable state too, so Stop also recovers an ORPHANED
        // job — one whose runner (e.g. the SW) was killed by a browser close. Its abort handle
        // is gone, so cancelJob can't reach it; without this, the stale 'progress' row keeps the
        // card stuck in Stop mode forever (until the 10-min purge) and Stop appears to do nothing.
        let removePending = !rec;
        if (rec?.token) {
          removePending = await platform.translateResume.remove(gid, rec.token);
          // A failed compare can mean the old token was already replaced. Preserve that newer
          // job's replay entry; only clear a stale pending row when no replacement exists.
          if (!removePending) removePending = !(await platform.translateResume.get(gid));
        }
        if (removePending) await platform.jobsPending.remove(`${gid}:translate`);
        platform.jobs.publish({ gid, kind: 'translate', status: 'cancelled' });  // drop the registry row + reset every tab
        return { ok: true };
      }

      case 'REVERT_GALLERY': await revertGallery(msg.galleryId); return { ok: true };

      case 'CACHE_ALL_PAGES': {                                          // download → extension agent
        const gid = String(msg.galleryId);
        platform.jobs.publish({ gid, kind: 'download', status: 'started', label: 'Contacting extension…' });
        const resp = await extRequest({ type: 'EXT_DOWNLOAD', galleryId: gid, source: msg.source, overwrite: !!msg.overwrite });
        // Any failure to hand off — no extension, no reply, or the agent refusing — must end
        // the job, or the card would sit on "Contacting extension…" forever.
        if (!resp || resp.ok === false || resp.started === false) {
          platform.jobs.publish({ gid, kind: 'download', status: 'error', error: !resp
            ? 'Shiori extension not reachable — install/enable it (then reload this tab).'
            : (resp.error || 'Extension could not start the download.') });
          return { ok: false };
        }
        return resp;
      }

      case 'SET_SOURCE': {
        const gid = String(msg.galleryId);
        const meta = await metaGet(gid);
        if (!meta) return { ok: false };

        // Normally just this gallery. When asked, the whole series (owner + every chapter) so one
        // link enriches all of them with the same source metadata. Each write spreads the chapter's
        // existing meta, so series grouping (chapters / parentId) is left intact.
        let targetIds = [gid];
        if (msg.applyToChapters) {
          const series = await resolveSeries(gid);
          if (series) targetIds = series.chapters.map(c => String(c.id));
        }

        for (const id of targetIds) {
          const m = id === gid ? meta : await metaGet(id);
          if (!m) continue;
          const updated = { ...m, source: msg.source };
          if (msg.sourceId) updated.sourceId = String(msg.sourceId);
          if (msg.sourceUrl) updated.sourceUrl = String(msg.sourceUrl);
          await metaPut(updated);
          // Offer the new source to the extension for metadata enrichment; the change feed
          // updates the card when it lands. Fire-and-forget — no extension, no enrichment.
          if (msg.source) extRequest({ type: 'EXT_FETCH_META', galleryId: id, source: msg.source, sourceId: msg.sourceId || null });
        }
        return { ok: true, newGalleryId: gid };
      }

      case 'TRANSLATOR_PING': {
        const { translateSettings } = await platform.kv.get(['translateSettings']);
        const serverUrl = serverUrlFromSettings(translateSettings);
        return { online: await pingServer(serverUrl, translateSettings), serverUrl };
      }

      default: return null;
    }
  },
};

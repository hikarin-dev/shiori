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
import { pingServer, revertGallery, followGallerySettings, serverUrlFromSettings, hasConfiguredServer } from './translate.js';
import { request as extRequest } from './ext-bridge.js';
import { submitJob, cancelJob } from './submit-job.js';

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

// GET_COVER is request→push: compute the thumbnail, deliver via COVER_READY. A gallery that
// lacks a cover but has a source broadcasts that one-way fact; whoever can supply covers decides
// whether to act, how often, and when to give up (no scheduling or dedup state lives here). When
// a cover is stored, the change feed re-triggers this request.
async function buildCover(msg) {
  const preferSeries = !!msg.preferSeries;
  const width = normalizedCoverWidth(msg.thumbWidth);
  let entry = await coverThumbnailGet(msg.galleryId, width, { preferSeries });
  if (!entry.source) {
    if (msg.source) extRequest({ type: 'EXT_FETCH_COVER', galleryId: msg.galleryId, source: msg.source, preferSeries });
    return null;
  }
  if (preferSeries && !entry.hasSeriesCover && msg.source) {
    extRequest({ type: 'EXT_FETCH_COVER', galleryId: msg.galleryId, source: msg.source, preferSeries });
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
        preferSeries: !!requester.preferSeries,
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

      case 'IMPORT_CBZ': {                                                // upload → durable runner
        // started:true only after the durable enqueue acknowledgement inside submitJob.
        const routed = await submitJob('upload', { galleryId: msg.galleryId, tempFile: msg.tempFile, filename: msg.filename, skipExisting: msg.skipExisting });
        return { ok: routed != null, started: routed != null };
      }

      case 'TRANSLATE_GALLERY': {                                         // translate → durable runner
        const { translateSettings } = await platform.kv.get(['translateSettings']);
        const routed = await submitJob('translate', { galleryId: msg.galleryId, settings: translateSettings,
          ...(msg.forceFrom ? { forceFrom: msg.forceFrom } : {}) });
        return { ok: routed != null, started: routed != null };
      }

      case 'TRANSLATE_PAGES': {                                           // some pages → durable runner
        // One translation at a time per gallery: a page waits for the gallery's to finish.
        const gid = String(msg.galleryId);
        const busy = await platform.translateResume.get(gid)
          || (await platform.jobsPending.all()).some(entry => entry.key === `${gid}:translate`);
        if (busy) return { ok: false, busy: true };
        const { translateSettings } = await platform.kv.get(['translateSettings']);
        const routed = await submitJob('translate', { galleryId: gid, settings: translateSettings, pages: msg.urls });
        return { ok: routed != null, started: routed != null };
      }

      case 'FOLLOW_GALLERY_SETTINGS': await followGallerySettings(msg.galleryId, msg.urls); return { ok: true };

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

      case 'REVERT_GALLERY': {
        const { translateSettings: ts } = await platform.kv.get(['translateSettings']);
        await revertGallery(msg.galleryId, { keepSnapshots: !!ts?.keepSnapshotsOnRevert });
        return { ok: true };
      }

      case 'CACHE_ALL_PAGES': {                                          // download → external helper
        const gid = String(msg.galleryId);
        platform.jobs.publish({ gid, kind: 'download', status: 'started', labelKey: 'prog.contacting_helper' });
        // One forwarded intent. `series` means "this item and whatever belongs with it" — the
        // receiver expands that; the app neither enumerates chapters nor schedules the work.
        const resp = await extRequest({ type: 'EXT_DOWNLOAD', galleryId: gid, source: msg.source, overwrite: !!msg.overwrite, series: !!msg.series });
        // Any failure to hand off — no helper, no reply, or a refusal — must end the job, or the
        // card would sit on the contacting label forever. Error keys keep the copy generic and
        // localized; a helper-supplied error string passes through as-is.
        if (!resp || resp.ok === false || resp.started === false) {
          platform.jobs.publish({ gid, kind: 'download', status: 'error', ...(!resp
            ? { errorKey: 'err.helper_unreachable', error: 'download helper not reachable' }
            : resp.error ? { error: resp.error }
            : { errorKey: 'err.helper_start_failed', error: 'download helper could not start' }) });
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
        // Background status polling only — never touch the network for a server the user has
        // not configured (see hasConfiguredServer). Unconfigured simply reads as offline.
        if (!hasConfiguredServer(translateSettings)) return { online: false, serverUrl: '', configured: false };
        const serverUrl = serverUrlFromSettings(translateSettings);
        return { online: await pingServer(serverUrl, translateSettings), serverUrl, configured: true };
      }

      default: return null;
    }
  },
};

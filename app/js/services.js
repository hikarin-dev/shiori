// services.js — the in-tab service layer behind the UI's rpc() calls. Light work (covers,
// deletes) runs right here; durable jobs (upload, translate) go to submitJob, which prefers the
// PWA service worker so they survive the tab closing; anything needing cross-domain access
// (downloads, source-site metadata) is delegated to the extension over the bridge — the
// extension's agent runs it against this same database and progress comes back live via
// platform.jobs / the change feed.

import * as platform from './platform.js';
import { coverGet, resizeCover, deleteGallery, metaGet, metaPut } from './db.js';
import { pingServer, revertGallery, serverUrlFromSettings } from './translate.js';
import { request as extRequest } from './ext-bridge.js';
import { submitJob, cancelJob } from './submit-job.js';

// GET_COVER is request→push: compute the thumbnail, deliver via COVER_READY. A gallery with no
// pages yet but a known source is offered to the extension (which knows whether that source can
// supply a cover); when it stores one, the change feed re-triggers this request.
async function getCover(msg) {
  const src = await coverGet(msg.galleryId);
  if (!src) {
    if (msg.source) extRequest({ type: 'EXT_FETCH_COVER', galleryId: msg.galleryId, source: msg.source });
    return;
  }
  const coverDataUrl = await resizeCover(src, msg.thumbWidth);
  platform.emitControl({ type: 'COVER_READY', galleryId: msg.galleryId, coverDataUrl, page: msg.page });
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
        cancelJob('translate', { galleryId: gid });                  // abort a live request (SW or tab) + token-scoped server cancel
        // Authoritative stop: clear the durable state too, so Stop also recovers an ORPHANED
        // job — one whose runner (e.g. the SW) was killed by a browser close. Its abort handle
        // is gone, so cancelJob can't reach it; without this, the stale 'progress' row keeps the
        // card stuck in Stop mode forever (until the 10-min purge) and Stop appears to do nothing.
        await platform.jobsPending.remove(`${gid}:translate`);        // never auto-resume it
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
        const updated = { ...meta, source: msg.source };
        if (msg.sourceId) updated.sourceId = String(msg.sourceId);
        if (msg.sourceUrl) updated.sourceUrl = String(msg.sourceUrl);
        await metaPut(updated);
        // Offer the new source to the extension for metadata enrichment; the change feed
        // updates the card when it lands. Fire-and-forget — no extension, no enrichment.
        if (msg.source) extRequest({ type: 'EXT_FETCH_META', galleryId: gid, source: msg.source, sourceId: msg.sourceId || null });
        return { ok: true, newGalleryId: gid };
      }

      case 'TRANSLATOR_PING': {
        const { translateSettings } = await platform.kv.get(['translateSettings']);
        const serverUrl = serverUrlFromSettings(translateSettings);
        return { online: await pingServer(serverUrl), serverUrl };
      }

      default: return null;
    }
  },
};

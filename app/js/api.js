// api.js — the resource-oriented contract the UI/store code calls. Dispatches in-process to
// the IndexedDB backend today; a different storage backend (HTTP/NAS, Electron file serving)
// registers here later WITHOUT any caller changing. This is the seam a future backend slots into.

import * as idb from './db.js';
import * as platform from './platform.js';

// The active storage backend.
const backend = idb;

// ── Galleries / metadata ──
export const galleries = {
  page:      (opts)      => backend.galleriesPage(opts),     // { sort, dir, offset, limit } -> entity[]
  count:     ()          => backend.galleriesCount(),
  idsSorted: (opts)      => backend.galleryIdsSorted(opts),  // { sort, dir } -> gid[] (keys only)
  metaMap:   ()          => backend.metaGetAllMap(),         // gid -> metadata (no covers) for search
  get:       (id)        => backend.getGallery(id),
  byIds:     (ids)       => backend.getGalleriesByIds(ids),
  mutate:    (id, patch) => backend.mutateGallery(id, patch),
  remove:    (id)        => backend.removeGallery(id),
};

// ── Page images ──
export const pages = {
  blob: (gid, n, variant) => backend.getPageBlob(gid, n, variant),
  // A blob: URL the UI drops straight into img.src. The caller revokes it when done.
  async url(gid, n, variant) {
    const blob = await backend.getPageBlob(gid, n, variant);
    return blob ? URL.createObjectURL(blob) : '';
  },
};

// ── Change-feed transport ──
export const events = {
  // cb receives the beacon `{ gid, n, at }` for each change. Returns an unsubscribe.
  onChange(cb) { return platform.feed.subscribe(cb); },
};

// api.js — the resource-oriented view store.js reads the library through: entity-shaped
// gallery/page accessors plus the change-feed subscription, named for what they mean rather
// than how they are stored.
//
// It is NOT a swappable-backend abstraction — it forwards to db.js, which is the app's one
// data layer (every store name and index lives there, and nothing outside it opens a
// transaction). Page modules import db.js directly; this module exists for the reactive store,
// not as a layer everything must route through.

import * as backend from './db.js';
import * as platform from './platform.js';

// ── Galleries / metadata ──
export const galleries = {
  page:      (opts)      => backend.galleriesPage(opts),     // { sort, dir, offset, limit, merge } -> entity[]
  count:     (opts)      => backend.galleriesCount(opts),
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
  // cb receives the beacon `{ gid, context, n, at }` for each change. Returns an unsubscribe.
  onChange(cb) { return platform.feed.subscribe(cb); },
};

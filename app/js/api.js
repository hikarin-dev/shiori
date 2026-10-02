// api.js — the library interface: everything the app reads from or writes to its library goes
// through here, never to a backend directly. Two backends offer the same operations: db.js, the
// library kept in this browser's IndexedDB, and desktop-backend.js, the library the desktop app
// keeps as files (used when the desktop app's window says so).
//
// The rules every operation keeps:
//   • async, and its arguments and results are plain data plus Blobs for images;
//   • a write commits whole or not at all, and has announced what it changed once it resolves
//     (unless asked to be `silent`) — callers never announce a change themselves, except to end
//     a run of silent writes (events.announce);
//   • the library works out page counts, sizes, sort times, cover pages and series totals itself
//     (gallery-model.js DERIVED_FIELDS); a change naming one is refused;
//   • pages are addressed by (gallery id, page number); a page's `url` is the key it is stored
//     under, a name for it, not its address;
//   • a refused command rejects with a BackendError whose `code` says why (backend-error.js).

import * as browserLibrary from './db.js';
import * as desktopLibrary from './desktop-backend.js';
import * as platform from './platform.js';
import { BackendError } from './backend-error.js';
import { DERIVED_FIELDS } from './gallery-model.js';

export { BackendError };

const backend = desktopLibrary.active ? desktopLibrary : browserLibrary;

// What this library can do beyond the common interface; surfaces hide what it lacks.
// `browserLibrary`: it is this browser's own (its one-time repairs and storage upgrades apply).
export const capabilities = { storageLayout: backend === browserLibrary, browserLibrary: backend === browserLibrary };

// A new gallery's id: its creation time, minted by the caller so it is known before anything is
// written. Monotonic within one window.
export const newGalleryId = () => backend.nextGalleryId();

const _gid = (v) => String(v);

// A failure reaches the app as a BackendError: out of space is `quota`, a value the library can't
// hold is `invalid`, anything else that kept a write from committing is `aborted` (the original
// error is its `cause`).
function _asBackendError(e) {
  if (e instanceof BackendError) return e;
  const name = e?.name || '';
  const code = name === 'QuotaExceededError' ? 'quota' : (name === 'DataError' || name === 'DataCloneError') ? 'invalid' : 'aborted';
  const err = new BackendError(code, e?.message || String(e));
  err.cause = e;
  return err;
}
function _typed(group) {
  for (const [key, value] of Object.entries(group)) {
    if (typeof value === 'function') {
      group[key] = (...args) => {
        try {
          const out = value(...args);
          return out && typeof out.then === 'function' ? out.then(undefined, (e) => { throw _asBackendError(e); }) : out;
        } catch (e) { return Promise.reject(_asBackendError(e)); }
      };
    } else if (value && typeof value === 'object') _typed(value);
  }
  return group;
}
function _metadataOnly(patch) {
  const derived = Object.keys(patch || {}).filter(k => DERIVED_FIELDS.has(k));
  if (derived.length) throw new BackendError('invalid', `the library works out ${derived.join(', ')} itself`);
}

// ── Galleries ──
export const galleries = _typed({
  page:        (opts) => backend.galleriesPage(opts),          // { sort, dir, offset, limit, merge } → Gallery[]
  count:       (opts) => backend.galleriesCount(opts),
  idsSorted:   (opts) => backend.galleryIdsSorted(opts),       // { sort, dir } → gid[] (keys only)
  get:         (gid) => backend.getGallery(gid),
  byIds:       (gids) => backend.getGalleriesByIds(gids),
  stats:       () => backend.getStats(),
  tagCounts:   (opts) => backend.tagCounts(opts),
  searchIndex: () => backend.metaGetAllMap(),                  // gid → metadata, for search
  // The gallery a source reference stands for, a placeholder created on first sight; the first one
  // added when several galleries share it.
  resolveSource: (ref) => backend.resolveGalleryId(ref),
  // A gallery under a minted id with this metadata merged in (an import reserving its card); an
  // empty stat record when it has none yet.
  create: (gid, meta = {}) => { _metadataOnly(meta); return backend.galleryCreate(_gid(gid), meta); },
  mutate: (gid, patch, opts) => { _metadataOnly(patch); return backend.mutateGallery(_gid(gid), patch, opts); },
  recount: (gid, opts) => backend.rebuildGalleryEntry(_gid(gid), opts),
  delete:  (gid) => backend.deleteGallery(_gid(gid)),
});

// ── A gallery's metadata record ──
export const meta = _typed({
  get: (gid) => backend.metaGet(gid),
  all: () => backend.metaGetAll(),
  put: (record, opts) => backend.metaPut(record, opts),
});

// ── Series ──
export const series = _typed({
  resolve:  (gid) => backend.seriesResolve(gid),
  chapters: (ownerId) => backend.seriesChapters(ownerId),
  attach:   (ownerId, childId, opts) => backend.seriesCommand('attach', ownerId, childId, opts),
  remove:   (ownerId, childId, opts) => backend.seriesCommand('remove', ownerId, childId, opts),
  reorder:  (ownerId, ids) => backend.seriesCommand('reorder', ownerId, ids),
  setChapterTitle: (ownerId, chapterId, title) => backend.seriesCommand('chapterTitle', ownerId, chapterId, title),
  write:    (ownerId, chapters, opts) => backend.seriesCommand('write', ownerId, chapters, opts),
  delete:   (ownerId) => backend.seriesCommand('deleteSeries', ownerId),
  refreshTotals: (ownerId, opts) => backend.refreshSeriesAggregate(ownerId, opts),
});

// ── Pages ──
export const pages = _typed({
  list: (gid) => backend.pageList(gid),                         // [{ pageNum, url }] by page number
  has:  (gid, n) => backend.pageHas(gid, n),
  get:  (gid, n) => backend.pageGet(gid, n),
  all:  (gid) => backend.getGalleryImageRecords(gid),           // every page with its data
  blob: (gid, n, variant) => backend.getPageBlob(gid, n, variant),
  // What an <img> loads; the caller releases it with releaseUrl when done.
  async url(gid, n, variant) {
    const blob = await backend.getPageBlob(gid, n, variant);
    return blob ? URL.createObjectURL(blob) : '';
  },
  releaseUrl: (url) => { if (url) URL.revokeObjectURL(url); },
  // Page `n` of a gallery; `meta` (its first page's) is committed with it.
  put:   (gid, n, image, opts) => backend.pagePut(gid, n, image, opts),
  // Drop the gallery's pages whose keys aren't in `keepUrls` (the tidy-up after an overwrite).
  prune: (gid, keepUrls) => backend.deleteStaleGalleryImages(_gid(gid), keepUrls),
});

// ── Page-derived data: translations and study layers, by (gallery, page number) ──
const _at = (gid, n) => ({ galleryId: _gid(gid), pageNum: Number(n) });
export const derived = _typed({
  putTranslation:     (gid, n, { image, pipeline, own } = {}) => backend.putTranslatedPage(_at(gid, n), image, pipeline, own),
  putTranslatedImage: (gid, n, image) => backend.putTranslatedImage(_at(gid, n), image),
  putStudy:           (gid, n, study, job) => backend.putPageStudy(_at(gid, n), study, job),
  setOwn:             (list, own) => backend.setPagesOwn(list.map(p => _at(p.galleryId, p.pageNum)), own),
  clear:              (gid, opts) => backend.clearGalleryTranslations(gid, opts),
  studyList:          (gid) => backend.listGalleryStudyRecords(gid),
  // A page's pipeline data as an export kept it: { pipeline, own, translatedLayers }.
  restore:            (gid, n, data) => backend.putPageData(_at(gid, n), data),
});

// ── Covers and source icons ──
export const covers = _typed({
  get:          (gid, opts) => backend.coverGet(gid, opts),
  thumbnail:    (gid, maxW, opts) => backend.coverThumbnailGet(gid, maxW, opts),
  preview:      (gid) => backend.coverPreviewGet(gid),
  putThumbnail: (gid, role, maxW, blob, revision) => backend.coverThumbnailPut(gid, role, maxW, blob, revision),
  put:          (gid, image, opts) => backend.coverPut(gid, image, opts),
});
export const icons = _typed({
  get: (source) => backend.sourceIconGet(source),
  all: () => backend.sourceIconsAll(),
  put: (source, patch) => backend.sourceIconPut(source, patch),
});

// ── Transfer: a gallery's records exactly as stored (backup, restore, moving a library) ──
export const transfer = _typed({
  ids:   () => backend.transferIds(),
  read:  (gid) => backend.transferRead(gid),
  write: (bundle, opts) => backend.transferWrite(bundle, opts),
});

// ── Change feed ──
// Every change is logged under a revision of the library, so a window that slept through the
// announcements can ask what changed since the revision it last saw.
export const events = _typed({
  // cb receives the beacon `{ gid, context, n, at, rev }` for each change. Returns an unsubscribe.
  onChange(cb) { return platform.feed.subscribe(cb); },
  // Ends a run of silent writes.
  announce: (gid) => backend.publishFeed(gid),
  revision: () => backend.changeRevision(),
  // { rev, gids } changed after `rev`, or { rev, resync: true } when the log can't say.
  since: (rev) => backend.changesSince(rev),
  watch: (cb) => _watch(cb),
});

// Every gallery that changes, as it changes — cb(gid, beacon) — and, whenever this window comes
// back (visible again, focused, restored from the back/forward cache, back online), each one that
// changed while it wasn't listening: cb(gid, null), or cb('*', null) when too much changed to list,
// meaning everything shown should be read again. Returns an unsubscribe.
function _watch(cb) {
  let seen = null;        // the revision this watcher has caught up to
  let running = null;
  const catchUp = () => {
    running ??= (async () => {
      try {
        if (seen == null) { seen = await backend.changeRevision(); return; }
        const { rev, gids, resync } = await backend.changesSince(seen);
        seen = rev;
        if (resync) cb('*', null);
        else for (const gid of gids) cb(gid, null);
      } catch {} finally { running = null; }
    })();
    return running;
  };
  catchUp();
  const off = platform.feed.subscribe((beacon) => { if (beacon?.gid != null) cb(String(beacon.gid), beacon); });
  const offReconnect = backend.onReconnect?.(catchUp);
  const onVisible = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') catchUp(); };
  const target = typeof window !== 'undefined' && window.addEventListener ? window : null;
  const doc = typeof document !== 'undefined' && document.addEventListener ? document : null;
  for (const type of ['focus', 'pageshow', 'online']) target?.addEventListener(type, onVisible);
  doc?.addEventListener('visibilitychange', onVisible);
  return () => {
    off();
    offReconnect?.();
    for (const type of ['focus', 'pageshow', 'online']) target?.removeEventListener(type, onVisible);
    doc?.removeEventListener('visibilitychange', onVisible);
  };
}

// ── Maintenance ──
export const maintenance = _typed({
  integritySnapshot: () => backend.integritySnapshot(),
  clearAll: () => backend.clearAll(),
  storageLayout: {
    status:  () => backend.storageLayoutStatus(),
    convert: (opts) => backend.convertStorage(opts),
  },
});

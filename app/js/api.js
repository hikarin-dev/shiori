// api.js — the library interface: everything the app reads from or writes to its library goes
// through here, never to a backend directly. Two backends offer the same operations: db.js, the
// library kept in this browser's IndexedDB, and desktop-backend.js, the library the desktop app
// keeps as files (used in the desktop app's window, and by a site that chose it: library-location.js).
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
import { WRITES, writeTargets, hiddenError } from './hidden-writes.js';
import * as platform from './platform.js';
import { BackendError } from './backend-error.js';
import { DERIVED_FIELDS } from './gallery-model.js';

export { BackendError };

const own = !desktopLibrary.active;
// This browser's own library, its writes refused for a gallery whose folder is hidden or removed (out
// of the library meanwhile; the desktop app's server does the same: hidden-writes.js).
const backend = own ? _guardWrites(browserLibrary) : desktopLibrary;
function _guardWrites(lib) {
  const out = {};
  for (const [op, fn] of Object.entries(lib)) {
    out[op] = typeof fn !== 'function' || !WRITES.has(op) ? fn : async (...args) => {
      for (const gid of writeTargets(op, args)) if (gid != null && await lib.galleryUnmounted(String(gid))) throw hiddenError(gid);
      return fn(...args);
    };
  }
  return out;
}

// What this library can do beyond the common interface; surfaces hide what it lacks.
// `browserLibrary`: it is this browser's own (its one-time repairs and storage upgrades apply).
// `desktopWindow`: this page is the desktop app's own window. `archive`: it keeps galleries as files
// and can pack one into an archive (galleries.archive).
// `folders`: how folders are added to this library — 'pick' (a browser library: the person picks one
// with the browser's folder picker), 'path' (the desktop app's window: its own folder picker hands
// a path), or null (this browser can't keep a library in folders; a site using the desktop library
// manages its folders in the desktop app).
export const capabilities = { storageLayout: own, browserLibrary: own,
  desktopWindow: !!globalThis.shioriDesktop?.shell, archive: typeof backend.archiveGallery === 'function',
  folders: own ? (browserLibrary.foldersSupported() ? 'pick' : null)
    : globalThis.shioriDesktop?.shell ? 'path' : null };

// Whether this page's library can be reached now — always, for this browser's — and, for the
// desktop app's, being told when the connection to it is lost.
export const connection = {
  reachable: () => backend.reachable?.() ?? Promise.resolve(true),
  onUnavailable: (cb) => backend.onUnavailable?.(cb) ?? (() => {}),
};

// The libraries a move reads from and writes to, whichever this page uses: this browser's (its
// galleries as stored, and clearing it once moved) and the desktop library `config` names
// ({ url, token }), opened for the move and closed after it.
export function browserLibraryForMove() {
  return _typed({
    // Every gallery it holds: { gid, isStub, addedAt, count }, read without any page.
    async list() {
      const [ids, metas, entries] = await Promise.all([browserLibrary.transferIds(), browserLibrary.metaGetAllMap(),
        browserLibrary.galleriesPage({ sort: 'id', limit: Infinity, merge: false })]);
      const byId = new Map(entries.map(e => [e.id, e]));
      return ids.map(gid => ({ gid, isStub: !!metas.get(gid)?.isStub, addedAt: byId.get(gid)?.addedAt ?? (Number(gid) || 0),
        count: byId.get(gid)?.count || 0 }));
    },
    ids: () => browserLibrary.transferIds(),
    read: (gid) => browserLibrary.transferRead(gid),
    clear: () => browserLibrary.clearAll(),
  });
}
// Whether the desktop library `config` names can be reached now (a site continuing without it asks).
export async function desktopReachable(config) {
  const client = desktopLibrary.createClient(config);
  try { return await client.reachable(); } finally { client.close(); }
}
export function desktopLibraryForMove(config) {
  const client = desktopLibrary.createClient(config);
  return {
    ..._typed({
      write: (bundle, opts) => client.transferWrite(bundle, opts),
      pages: (gid) => client.pageList(gid),
      integritySnapshot: () => client.integritySnapshot(),
    }),
    close: () => client.close(),
  };
}

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
  // The gallery a source and reference stand for, a placeholder created on first sight; the first one
  // added when several galleries share it.
  resolveSource: (ref, source) => backend.resolveGalleryId(ref, source),
  // A gallery under a minted id with this metadata merged in (an import reserving its card); an
  // empty stat record when it has none yet.
  create: (gid, meta = {}) => { _metadataOnly(meta); return backend.galleryCreate(_gid(gid), meta); },
  mutate: (gid, patch, opts) => { _metadataOnly(patch); return backend.mutateGallery(_gid(gid), patch, opts); },
  recount: (gid, opts) => backend.rebuildGalleryEntry(_gid(gid), opts),
  delete:  (gid) => backend.deleteGallery(_gid(gid)),
  // The gallery this page's reader shows (null: none). A library that writes a gallery's files in
  // the background writes them once the reader leaves it — for another, or by closing.
  reading: async (gid) => backend.reading?.(gid == null ? null : _gid(gid)),
  // The gallery — a series owner: its whole series — packed into an archive now (capabilities.archive):
  // { archived, kept } (gallery ids; kept: one in use, or holding files of someone else's).
  archive: async (gid) => backend.archiveGallery?.(_gid(gid)) ?? { archived: [], kept: [String(gid)] },
  // The gallery — a series owner: its whole series — moved to another of the library's places
  // (folders.list ids): its files copied there, then switched over, then the old copies deleted.
  // `onProgress(done, total)` follows its pictures where the library can say. Resolves { moved }.
  move: (gid, to, opts) => backend.moveGallery(_gid(gid), String(to), opts),
});

// ── Where the library is kept ──
// The places a library keeps galleries in, the same for both: this browser's own storage and the
// folders the person added (a browser library), or the desktop app's library folders —
// [{ id, kind: 'browser'|'folder', name, path?, isDefault, access, galleries, size, removable, hidden? }].
// New galleries go to the default place; a gallery stays where it is kept unless moved. `access`:
// 'granted', 'prompt' (the browser asks the person once a visit: allow), 'unavailable' (it can't
// be reached now — a folder gone, a drive away) or 'taken' (another app took it over — `owner` says
// which: { app, host | browser, site, active, at } — so this library only reads it; claim takes it
// back; see folder-owner.js). Removing a place takes its galleries out of the
// library and leaves their files where they are, their records set aside: adding it again brings
// them back at once. Hiding one does the same but keeps it listed: showing it brings them back.
export const folders = _typed({
  list: async () => backend.foldersList?.() ?? [],
  // capabilities.folders 'pick': a folder's handle; 'path': its full path. A folder removed before
  // comes back with the galleries it held. Resolves { id, restored } (or `existed`); checking it for
  // galleries put there meanwhile is scan's. One another app holds is refused (reason 'claimed',
  // `owner` who) unless `force`: this library takes it over.
  add: (target, { force = false } = {}) => backend.folderAdd(target, force ? { force: true } : {}),
  // A folder another app took over held by this library again. Resolves its access.
  claim: (id) => backend.folderClaim(String(id)),
  // Off the list at once, its galleries out of the library — moved to place `moveTo` first, when
  // given; what it still owes the folder is a task (setAside, or the desktop app's): everything the
  // library has of them written there, then the folder and its galleries' records forgotten (their
  // files stay; added again, it is checked from scratch). Refused (reason 'unsaved', `galleries` how
  // many) while it can't be written to and galleries of it have what only this library has — unless
  // `discard`: that is lost. Resolves { id, galleries } (how many leave).
  remove: (id, { moveTo, discard = false } = {}) => backend.folderRemove(String(id), { ...(moveTo ? { moveTo: String(moveTo) } : {}), ...(discard ? { discard: true } : {}) }),
  setDefault: (id) => backend.folderSetDefault(String(id)),
  // Listed still, its galleries out of the library at once (not the default place's): nothing of
  // theirs moves. Resolves { id, galleries } (how many left). Shown again: they come back at once
  // ({ id, restored }).
  hide: (id) => backend.folderHide(String(id)),
  show: (id) => backend.folderShow(String(id)),
  // Asks the person to let this page use the folder (from a click); resolves its access then.
  allow: async (id) => backend.folderAllow?.(String(id)) ?? 'granted',
  // Galleries put in it from outside the app join the library — those it kept are known already, and
  // their folders aren't looked into. A browser library's: `onProgress(done, total, added)` and
  // `stopped()` (folder-scan.js runs it as a job); the desktop app's runs it as a job of its own.
  // Resolves { added, stopped }.
  scan: (id, opts) => backend.folderScan(String(id), opts),
  // What waits in this browser for a folder it couldn't reach is moved out to it: how many galleries.
  settle: async () => backend.settleFolders?.() ?? 0,
  // A browser library: what a folder removed still owes it — its galleries moved (when asked),
  // everything the library has of them written there, the folder let go and forgotten (remove only
  // marks it; folder-scan.js runs this as a task). `onProgress(done, total)`, `stopped()`. Resolves
  // { removed, stopped }; throws (`errorKey` 'lf.task_kept', `unsaved`) when what it owes couldn't
  // be written and it stays. (The desktop app does it as a task of its own.)
  setAside: async (id, opts) => backend.folderSetAside?.(String(id), opts) ?? { removed: 0, stopped: false },
  // The PDFs the library's folders hold, waiting for a page to draw their pages (linked-source.js):
  // [{ folder, gid, path, name }]; one's file (a Blob); its pages drawn (Blobs, in order), kept with
  // it as it joins the library (resolves its id).
  pdfsWaiting: async () => backend.pdfsWaiting?.() ?? [],
  pdfSource: (folder, gid) => backend.pdfSource(String(folder), String(gid)),
  addRendered: (folder, gid, pages) => backend.addRendered(String(folder), String(gid), pages),
  // What a page should carry on with (a removal cut short): { setAside: [{ id, name }] }.
  pending: async () => backend.foldersPending?.() ?? { setAside: [] },
  // The folders holding galleries that wait for this page's permission (allow): [{ id, name }].
  waiting: async () => backend.foldersWaiting?.() ?? [],
});

// ── Jobs the library's keeper runs itself ──
// A library kept by the desktop app runs a job it is handed (a translation, and collecting what the
// translation server has done: 'poll') in the app itself, so it goes on whatever this page does
// next. Resolves its answer ({ ok, busy }), or null when the library can't take jobs (this
// browser's own) or the app didn't answer.
export const keeperJobs = {
  run: (kind, payload = {}) => Promise.resolve(backend.runJob?.(kind, payload)).then((r) => r ?? null, () => null),
  stop: (kind, payload = {}) => Promise.resolve(backend.stopJob?.(kind, payload)).then((r) => r ?? null, () => null),
};

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
  get:  (gid, n, key) => backend.pageGet(gid, n, key),            // key: its url from list, read directly
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

// ── Disk writes of a library that keeps galleries as files (capabilities.archive) ──
// { total, by: { pages, pictures, descriptions, archive, database, thumbnails }, since } in bytes,
// or null for this browser's own library (platform.writes counts what the browser stores).
export const diskWrites = _typed({
  get: async () => backend.diskWrites?.() ?? null,
  reset: async () => backend.resetDiskWrites?.() ?? null,
});

// ── Transfer: a gallery's records exactly as stored (backup, restore, moving a library) ──
export const transfer = _typed({
  ids:   () => backend.transferIds(),
  // { meta, stat, pages, cover }; with { pages: false } only its metadata and stat record.
  read:  (gid, opts) => backend.transferRead(gid, opts),
  // The gallery whole or not at all → { pages } stored. Refuses a page with no number or picture,
  // and (`conflict`) one whose key another gallery's page is stored under.
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
  // `folders`: forget the library's folders too (a factory reset of a browser library).
  clearAll: (opts) => (opts ? backend.clearAll(opts) : backend.clearAll()),
  storageLayout: {
    status:  () => backend.storageLayoutStatus(),
    convert: (opts) => backend.convertStorage(opts),
  },
});

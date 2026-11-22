// db.js — the app's IndexedDB storage layer: images (Blobs), gallery metadata, gallery stats,
// and covers. This is the single canonical library — pages, the PWA service worker, and the
// extension-hosted agent all read and write the same origin-scoped database through this module.

import * as platform from './platform.js';
import { normalizeTitle, migrateTitle } from './titles.js';
import { imageToBlob, imageToDataUrl } from './image-util.js';
import { isSeriesMeta, effectiveTagsOf, LANG_NAME_TO_CODE, DERIVED_FIELDS, uploadDateSeconds } from './gallery-model.js';
import { translatedImage } from './page-image.js';
import { galleryFiles, layoutPath, layoutOf, extOfType, originalExt, galleryName, DESCRIPTION_FILES } from './storage/gallery-files.js';
import { slotFiles, tokenOf, generationOf, published, inFolder, nothingToWrite, parseManifest, foreignEntries } from './storage/gallery-manifest.js';
import { MISSING, unreadable } from './storage/contract.js';
import { exportSize } from './gallery-export.js';
import * as folderFiles from './storage/folder-store-web.js';
import { OWNER_FILE, readClaim, access, nextClaim, claimText, heldElsewhere, knownAfter, handoverIn, HANDOVER_RETRY_MS } from './storage/folder-owner.js';
import { mounted, writeAllowed, changeRefusal, unfoundEnd, unfoundMayBeIn } from './storage/folder-lifecycle.js';
import { galleryIdOf, seriesOf, MANIFEST_FILE } from './storage/folder-content.js';
import { REMOVED_FILE, ARCHIVE_NAME, overlayDir, parseRemoved, removedText, withRemoved, provenanceOf, pageToken, madeFromPage } from './storage/linked-source.js';
import { withoutPersonal, marksOf, withMarks, importMarks, favoriteMoved } from './storage/personal.js';
import { createFolderLibrary } from './folder-library.js';
import { zipEntries } from './zip-read.js';
import { imageSize, medianPage, describePage } from './page-size.js';
import { BackendError } from './backend-error.js';
import { planAttach, planRemove, planReorder, planChapterTitle, planWrite, planDelete, planDeleteSeries, planRelink } from './series-plan.js';

const DB_NAME = 'shiori-cache';
const DB_VERSION = 20;
export const STORE = 'images';
const META_STORE = 'metadata';
const GALLERY_STORE = 'galleries';
const COVER_STORE = 'covers';
const SOURCE_ICON_STORE = 'sourceIcons';
const BLOB_STORE = 'blobs';   // the images of page and cover records, one record each (see below)
const CHANGES_STORE = 'changes';   // the change log: one entry per changed gallery (see below)
const FOLDER_STORE = 'folders';    // the folders galleries may be kept in (see "Library folders")
const UNDESCRIBED_STORE = 'undescribed';   // galleries whose folder doesn't have their latest changes yet
const DORMANT_STORE = 'dormant';   // galleries an earlier version set aside: read only to bring them back
// The person's own marks on each gallery — favorite, reading progress (storage/personal.js): { gid,
// ...marks }. This library's alone: never written to a gallery's folder.
const PERSONAL_STORE = 'personal';
// A stored page's url ends in its page number and image type ("…/12.webp") — every type a page
// can be stored as, so no page goes unnumbered. Pages are addressed by (gallery, page number); the
// url is the key they are stored under. This is the one place a page number is read from a key:
// every page record read back carries it as `pageNum` (never stored), and every write checks the
// key agrees with the number it was given.
const PAGE_URL = /\/(\d+)\.(webp|jpg|jpeg|png|gif|avif)$/i;
const _keyPage = (key) => { const m = String(key ?? '').match(PAGE_URL); return m ? parseInt(m[1], 10) : null; };

// Reactive change feed: every durable gallery change is announced through one tiny beacon
// (platform.feed); surfaces subscribe and re-read only the changed gallery from IndexedDB.
let _feedSeq = 0;
const _feedContext = globalThis.crypto?.randomUUID?.()
  || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const _feedTimers = new Map();

// Announce that one gallery changed. Debounced per gallery so a burst of writes (e.g. storing
// every page of a download) collapses into a single beacon instead of thrashing every surface.
// The gallery's size is brought up to date first, so every surface reads it current.
// A gallery announced while work on many galleries runs (`_bulk`: a folder's galleries set aside or
// brought back, a check) isn't announced on its own: every window hears once, every half second or
// so, that much changed ('*': each reads what it shows again) — rather than each reading every
// gallery that changed, a thousand times over.
let _bulk = 0, _muchTimer = null;
const _quietFeeds = new Set();
export function publishFeed(galleryId) {
  const gid = String(galleryId);
  if (_bulk) _quietFeeds.add(gid);
  if (_feedTimers.has(gid)) return;
  _feedTimers.set(gid, setTimeout(async () => {
    _feedTimers.delete(gid);
    await refreshGallerySize(gid).catch(() => {});
    if (_quietFeeds.delete(gid)) { _muchLater(); return; }
    platform.feed.publish({ gid, context: _feedContext, n: ++_feedSeq, at: Date.now(), rev: _lastRev });
  }, 250));
}
function _muchLater() {
  _muchTimer ??= setTimeout(() => {
    _muchTimer = null;
    platform.feed.publish({ gid: '*', context: _feedContext, n: ++_feedSeq, at: Date.now(), rev: _lastRev });
  }, 500);
}
// `fn` (async) run as work on many galleries (see publishFeed).
async function _bulkRun(fn) {
  _bulk++;
  try { return await fn(); } finally { _bulk--; }
}

// A change made without an announcement (a page stored mid-translation, a restored record) still
// moves the gallery's size; it is announced when it does.
const _sizeTimers = new Map();
function scheduleGallerySize(galleryId) {
  const gid = String(galleryId);
  if (_sizeTimers.has(gid)) return;
  _sizeTimers.set(gid, setTimeout(() => {
    _sizeTimers.delete(gid);
    refreshGallerySize(gid).then(changed => { if (changed) publishFeed(gid); }, () => {});
  }, 1000));
}

// A gallery's size is its export archive's (gallery-export.js exportSize): the original pages plus
// translations, study data, snapshots, covers and metadata — `size` the whole, `origSize` the
// original pages. Always recomputed from what is stored, never adjusted by deltas, so it cannot
// drift. Returns whether it changed. Every change to a gallery comes here (publishFeed,
// scheduleGallerySize), so one kept in a folder has what it changed published there soon after
// (_describeSoon) — the change itself marked it as not published there yet (_logIn).
export async function refreshGallerySize(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  const stored = await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, META_STORE, COVER_STORE, UNDESCRIBED_STORE], 'readonly');
    const records = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    const meta = tx.objectStore(META_STORE).get(gid);
    const cover = tx.objectStore(COVER_STORE).get(gid);
    const mark = tx.objectStore(UNDESCRIBED_STORE).get(gid);
    tx.oncomplete = () => resolve({ records: records.result || [], meta: meta.result || null, cover: cover.result || null, marked: !!mark.result });
    tx.onerror = () => reject(_txError(tx));
  });
  const { total, original } = exportSize(galleryFiles({ meta: stored.meta, records: _numbered(stored.records),
    covers: { gallery: stored.cover?.cover, series: stored.cover?.seriesCover } }));
  let changed = null, stat = null;
  await new Promise((resolve, reject) => {
    const tx = _tx(db, GALLERY_STORE, 'readwrite');
    const store = tx.objectStore(GALLERY_STORE);
    const req = store.get(gid);
    req.onsuccess = () => {
      const cur = stat = req.result;
      if (!cur || (cur.size === total && cur.origSize === original)) return;
      changed = cur;
      store.put({ ...cur, size: total, origSize: original });
      _logIn(tx, gid, { mark: false });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
  if (stat && _medianPageStale(stat, stored.records)) scheduleMedianPage(gid);
  if (stat?.folder && stored.marked) _describeSoon(gid);   // what its folder lacks is published there soon
  if (!changed) return false;
  if (changed.parentId) scheduleSeriesAggregate(changed.parentId);
  if (changed.chapterCount != null) scheduleSeriesAggregate(gid);
  return true;
}

// ── A gallery's typical page ──
// Its median page by area (page-size.js), measured from the stored originals' image headers and
// kept on the stat record — it describes the files, not the gallery, so it never joins the tags —
// as `medianPage: { w, h, n, bytes }`. `n` and `bytes` are the page count and page bytes it was
// measured from, so a changed set of pages is noticed without reading an image. It is measured
// once the pages have stopped changing for a moment: a download is measured once, not per page.
const MEDIAN_PAGE_SETTLE_MS = 3000;
// Next to it the stat record keeps `pageSizes`, every measured page's size tallied as [w, h, count]
// (a gallery has a handful of distinct sizes), so a series can take the exact median of all its
// chapters' pages rather than an estimate from the chapters' medians.
const _pagesSig = (pages) => ({ n: pages.length, bytes: pages.reduce((sum, p) => sum + (p.size || 0), 0) });
function _medianPageStale(stat, records) {
  const stored = stat?.medianPage;
  if (!stored) return records.length > 0;
  if (records.length && !Array.isArray(stat.pageSizes)) return true;   // measured before sizes were tallied
  const sig = _pagesSig(records);
  return stored.n !== sig.n || stored.bytes !== sig.bytes;
}
function _sizeTally(sizes) {
  const counts = new Map();
  for (const { w, h } of sizes) counts.set(`${w}x${h}`, (counts.get(`${w}x${h}`) || 0) + 1);
  return [...counts].map(([k, n]) => [...k.split('x').map(Number), n]).sort((a, b) => a[0] * a[1] - b[0] * b[1] || a[0] - b[0]);
}

const _medianPageTimers = new Map();
function scheduleMedianPage(galleryId) {
  const gid = String(galleryId);
  clearTimeout(_medianPageTimers.get(gid));
  _medianPageTimers.set(gid, setTimeout(() => {
    _medianPageTimers.delete(gid);
    refreshMedianPage(gid).then(changed => { if (changed) publishFeed(gid); }, () => {});
  }, MEDIAN_PAGE_SETTLE_MS));
}

// Measure one gallery's median page (and tally its page sizes) from its stored originals. Returns
// whether its typical page changed.
export async function refreshMedianPage(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  const pages = await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, BLOB_STORE], 'readonly');
    const out = [];
    const req = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    req.onsuccess = () => {
      for (const rec of req.result || []) {
        const page = { size: rec.size || 0, src: _isRef(rec.blob) ? null : (rec.blob ?? rec.dataUrl ?? null) };
        out.push(page);
        if (_isPath(rec.blob)) { page.src = rec.blob; (tx._paths ||= []).push([page, 'src', gid]); continue; }
        if (!_isRef(rec.blob)) continue;
        const read = tx.objectStore(BLOB_STORE).get(rec.blob[REF]);
        read.onsuccess = () => { page.src = read.result?.blob || null; };
      }
    };
    tx.oncomplete = () => _completed(tx, out).then(resolve, reject);
    tx.onerror = () => reject(_txError(tx));
  });
  const sizes = [];
  let at = 0;
  await Promise.all(Array.from({ length: Math.min(8, pages.length) }, async () => {
    while (at < pages.length) {
      const blob = await imageToBlob(pages[at++].src);
      const size = blob && await imageSize(blob).catch(() => null);
      if (size) sizes.push(size);
    }
  }));
  // A gallery whose pages can't be read keeps a 0×0 entry, so it isn't measured again until they change.
  const median = medianPage(sizes);
  const next = pages.length ? { w: median?.w || 0, h: median?.h || 0, ..._pagesSig(pages) } : null;
  const tally = pages.length ? _sizeTally(sizes) : null;
  let prev = null, stat = null, tallied = false;
  await new Promise((resolve, reject) => {
    const tx = _tx(db, GALLERY_STORE, 'readwrite');
    const store = tx.objectStore(GALLERY_STORE);
    const req = store.get(gid);
    req.onsuccess = () => {
      const cur = req.result;
      prev = cur?.medianPage;
      tallied = JSON.stringify(cur?.pageSizes ?? null) !== JSON.stringify(tally);
      if (!cur || (['w', 'h', 'n', 'bytes'].every(k => prev?.[k] === next?.[k]) && !tallied)) return;
      stat = cur;
      const { medianPage: _, pageSizes: __, ...rest } = cur;
      store.put(next ? { ...rest, medianPage: next, pageSizes: tally } : rest);
      _logIn(tx, gid, { mark: false });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
  const typical = !!stat && (prev?.w !== next?.w || prev?.h !== next?.h);
  if (stat && (typical || tallied)) {
    if (stat.parentId) scheduleSeriesAggregate(stat.parentId);
    if (stat.chapterCount != null) scheduleSeriesAggregate(gid);
  }
  return typical;
}

// Galleries stored before their median page was kept: measure each once. Returns how many.
export async function backfillMedianPages() {
  const pending = (await galleryGetAll()).filter(g => g.count > 0 && !g.medianPage).map(g => String(g.galleryId));
  for (const gid of pending) if (await refreshMedianPage(gid)) publishFeed(gid);
  return pending.length;
}

// Lower-cased `type:name` strings for the metadata.tagNames multiEntry index, so
// tag:/artist: filters resolve through an index instead of a full scan.
function tagNamesOf(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(t => `${t.type}:${t.name}`.toLowerCase());
}


let _db = null;
let _dbPromise = null;
export function openDB() {
  if (_db) return Promise.resolve(_db);
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Data-preserving migration: never deletes a store on upgrade — creates stores/indexes
    // only when missing and backfills existing records, so a populated library survives.
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const tx = e.target.transaction; // the versionchange transaction

      const images = db.objectStoreNames.contains(STORE)
        ? tx.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: 'url' });
      if (!images.indexNames.contains('mediaId'))   images.createIndex('mediaId', 'mediaId', { unique: false });
      if (!images.indexNames.contains('galleryId')) images.createIndex('galleryId', 'galleryId', { unique: false });

      const meta = db.objectStoreNames.contains(META_STORE)
        ? tx.objectStore(META_STORE)
        : db.createObjectStore(META_STORE, { keyPath: 'galleryId' });
      if (!meta.indexNames.contains('sourceId')) meta.createIndex('sourceId', 'sourceId', { unique: false });
      if (!meta.indexNames.contains('tagNames')) meta.createIndex('tagNames', 'tagNames', { unique: false, multiEntry: true });

      const gal = db.objectStoreNames.contains(GALLERY_STORE)
        ? tx.objectStore(GALLERY_STORE)
        : db.createObjectStore(GALLERY_STORE, { keyPath: 'galleryId' });
      for (const idx of ['addedAt', 'latestAt', 'size', 'count', 'uploadDate'])
        if (!gal.indexNames.contains(idx)) gal.createIndex(idx, idx, { unique: false });
      // Series membership: a chapter's stat record carries parentId (the owner gallery). The index
      // counts only children (IndexedDB skips records missing the key), so the top-level grid count
      // is total − children, and the grid cursor can skip them. Denormalized here (not only on
      // metadata) so pagination stays a pure index-cursor walk with no metadata read per row.
      if (!gal.indexNames.contains('parentId')) gal.createIndex('parentId', 'parentId', { unique: false });
      // Galleries kept in a library folder whose pictures wait in this browser (see "Library folders").
      if (!gal.indexNames.contains('spilled')) gal.createIndex('spilled', 'spilled', { unique: false });

      // Covers live in their own store so gallery stat records stay tiny and a
      // sort/scan over the whole library never loads cover blobs.
      const covers = db.objectStoreNames.contains(COVER_STORE)
        ? tx.objectStore(COVER_STORE)
        : db.createObjectStore(COVER_STORE, { keyPath: 'galleryId' });
      if (!db.objectStoreNames.contains(SOURCE_ICON_STORE)) {
        db.createObjectStore(SOURCE_ICON_STORE, { keyPath: 'source' });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CHANGES_STORE)) db.createObjectStore(CHANGES_STORE, { keyPath: 'rev', autoIncrement: true });
      const places = db.objectStoreNames.contains(FOLDER_STORE) ? tx.objectStore(FOLDER_STORE) : db.createObjectStore(FOLDER_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DORMANT_STORE)) db.createObjectStore(DORMANT_STORE, { keyPath: 'gid' }).createIndex('folder', 'folder', { unique: false });
      const marks = db.objectStoreNames.contains(UNDESCRIBED_STORE) ? tx.objectStore(UNDESCRIBED_STORE) : db.createObjectStore(UNDESCRIBED_STORE, { keyPath: 'gid' });
      const personal = db.objectStoreNames.contains(PERSONAL_STORE) ? tx.objectStore(PERSONAL_STORE) : db.createObjectStore(PERSONAL_STORE, { keyPath: 'gid' });

      // Backfill when upgrading an existing database (fresh installs start empty). The folders go
      // first: a stat record naming a folder the library doesn't know is put right as it is read.
      if (e.oldVersion > 0) {
        const folders = places.getAll();
        folders.onsuccess = () => {
          const known = new Set();
          for (const r of folders.result || []) {
            if (e.oldVersion < 19 && (r.id === BROWSER || !String(r.id).startsWith('$'))) places.put(_folderRecordV19(r));
            if (r.id !== BROWSER && !String(r.id).startsWith('$')) known.add(r.id);
          }
          gal.openCursor().onsuccess = (ev) => {
            const c = ev.target.result;
            if (!c) return;
            let v = c.value;
            let dirty = false;
            if (v.addedAt == null) { v.addedAt = Number(v.galleryId) || v.latestAt || Date.now(); dirty = true; }
            if (v.cover != null)   { covers.put({ galleryId: v.galleryId, cover: v.cover }); delete v.cover; dirty = true; }
            // IndexedDB 19: the mark of changes not written to the gallery's folder yet has a store of
            // its own; a gallery naming a folder no longer known (one written as it was forgotten) is
            // this browser's, as every reader took it already.
            if (v.undescribed != null) { if (v.undescribed) marks.put({ gid: String(v.galleryId), rev: 0 }); delete v.undescribed; dirty = true; }
            if (v.folder && !known.has(v.folder)) { v = _withoutHome(v); dirty = true; }
            if (dirty) c.update(v);
            c.continue();
          };
        };
        meta.openCursor().onsuccess = (ev) => {
          const c = ev.target.result;
          if (!c) return;
          let v = c.value;
          let dirty = false;
          if (v.tagNames == null && (Array.isArray(v.tags) || Array.isArray(v.seriesTags))) { v.tagNames = tagNamesOf(effectiveTagsOf(v)); dirty = true; }
          // Legacy flat title fields → the canonical { english, japanese, pretty } object.
          if (v.title == null || typeof v.title !== 'object') { v = migrateTitle(v); dirty = true; }
          // IndexedDB 20: the favorite moves out of the metadata into the library's personal store, and a
          // gallery kept in a folder is marked to publish its description again, without it (plan D6).
          if (e.oldVersion < 20 && withoutPersonal(v) !== v) {
            const gid = String(v.galleryId);
            const mark = importMarks(null, v);
            if (mark) personal.put({ gid, ...mark });
            gal.get(gid).onsuccess = (s) => { if (s.target.result?.folder) marks.put({ gid, rev: 0 }); };
            v = withoutPersonal(v);
            dirty = true;
          }
          if (dirty) c.update(v);
          c.continue();
        };
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      // Newer code upgraded the database: close so it can, and a page (or the agent) running this
      // older code reloads onto the new code rather than failing to open the database again.
      _db.onversionchange = (e) => {
        _db.close(); _db = null; _dbPromise = null;
        if (typeof window !== 'undefined' && e.newVersion > DB_VERSION) location.reload();
      };
      resolve(_db);
    };
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

// Every transaction here goes through _tx: one that ends without committing — aborted by an
// exception in one of its callbacks, by running out of space (neither fires `error`), or refused by
// the mount check (_logIn) — reaches its `onerror` all the same, so no caller is left waiting on it;
// _txError(tx) says why it failed. A write transaction also holds the change log, the folders, the
// galleries' stat records and their marks of changes not written to their folders yet, so what it
// changes is logged, checked and marked in the same commit (_logIn).
const WRITE_SCOPE = [CHANGES_STORE, FOLDER_STORE, GALLERY_STORE, UNDESCRIBED_STORE];
function _tx(db, stores, mode) {
  const list = Array.isArray(stores) ? stores : [stores];
  const tx = db.transaction(mode === 'readwrite' ? [...new Set([...list, ...WRITE_SCOPE])] : list, mode);
  tx.addEventListener('abort', () => { if (typeof tx.onerror === 'function') tx.onerror(new Event('error')); });
  return tx;
}
// What `tx` failed with: the mount check's refusal, else its own error (none for one aborted by hand).
const _txError = (tx) => tx._refused || tx.error || new BackendError('aborted', 'the write was abandoned');

// ── The change log, and the mount check ──
// Every write that changes what a gallery shows logs the gallery in the same transaction, under the
// next revision of the library (the log's own key). A window that slept through announcements asks
// what changed since the revision it last saw (changesSince) instead of trusting it heard them all.
// The log keeps the last CHANGES_KEPT revisions; a window further behind than that resyncs.
//
// Logging a gallery also checks, in the same transaction, that it may be written: its place — the
// folder its stat record names, as the transaction has it when _logIn is called (a write that makes
// the record logs it after putting it), or this browser — must be in the library (shown:
// folder-lifecycle.js mounted). A gallery whose folder is hidden, being removed or no longer known
// (forgotten while the write was under way) is refused: the transaction is aborted and rejects with
// BackendError 'invalid', reason 'hidden' — so a hide or a removal and a write in flight are
// serialized by IndexedDB, whatever the write names (a series expanded, an id inferred). Folder work
// (`tx._work`, _workOn: a removal's write-back, a folder read back, a migration) writes such galleries
// by design — those placed in the folder it is about, as the transaction has them, alone: a removal
// moving a gallery out is checked where it goes (F02). A record with no stat (metadata alone) is in
// no folder.
// A gallery kept in a folder is marked as having changes its folder lacks (UNDESCRIBED_STORE: { gid,
// rev }, the revision of this change) until _describe has written them there — `mark: false` for a
// change no description shows (its size, a series' totals, the person's own marks). A change its folder
// would get (one marked) is refused too while this context knows another app holds that folder (the last
// claim it read names another app: _heldElsewhere, no file call) and the gallery is the folder's — it has a
// place there (its folder, overlay or archive: `dir`), not a reservation no publication made whole, whatever
// stamp this library keeps of it (gallery-manifest.js inFolder, S31): one app changes a folder's galleries at
// a time (folder-lifecycle.js changeRefusal) — BackendError 'unavailable', reason 'not-owned', as a deletion is
// refused there. A gallery only this library has (made meanwhile, never placed there) keeps working: its
// pictures wait in this browser (`spilled`).
// A write of a gallery's pictures (_writing: `tx._write` its `w`) is refused too once the gallery it began for has
// ended — deleted or forgotten since, in any page (_life, S34, S36), as this transaction reads its stat record:
// BackendError 'aborted', reason 'gone' — so nothing of it lands in a gallery made again under the id meanwhile, and
// what it wrote goes again (_discard).
const CHANGES_KEPT = 20000;
let _lastRev = 0;   // the newest revision this window has written
function _logIn(tx, gid, { mark = true } = {}) {
  const id = String(gid);
  const seen = (tx._logged ||= new Map()).get(id);
  if (seen) {
    if (mark && !seen.mark) {
      seen.mark = true;
      const why = seen.held?.();
      if (why) _refuseIn(tx, id, why, seen.folder);
      else if (seen.folder) _markIn(tx, id, seen.rev);
    }
    return;
  }
  const entry = { mark, rev: null, folder: null, held: null };
  tx._logged.set(id, entry);
  const log = tx.objectStore(CHANGES_STORE);
  const req = log.add({ gid: id, at: Date.now() });
  req.onsuccess = () => {
    const rev = entry.rev = req.result;
    _lastRev = Math.max(_lastRev, rev);
    if (rev % 1000 === 0 && rev > CHANGES_KEPT) {
      log.delete(IDBKeyRange.upperBound(rev - CHANGES_KEPT));
      log.put({ rev: 'compacted', upTo: rev - CHANGES_KEPT });
    }
  };
  if (id === '*') return;
  const stat = tx.objectStore(GALLERY_STORE).get(id);
  stat.onsuccess = () => _placeStateIn(tx, stat.result, (state, place) => {
    if (tx._write?.gid === id && !_still(tx._write.life, stat.result)) { _refuseIn(tx, id, 'gone'); return; }
    const folder = stat.result?.folder || null;
    const work = !!_workOn(tx._work, folder || BROWSER);
    if (changeRefusal({ state, work })) { _refuseIn(tx, id); return; }
    entry.folder = folder;
    const held = inFolder(!!stat.result?.dir, stat.result?.stamp);
    // A hand-over's mark (S32), as this transaction reads it, refuses first; else the last claim read decides.
    const handover = !!folder && held && !work && !!place?.handover;
    // Weighed once the change is one its folder would get (marked), and the gate asked only then: a change no
    // description shows (a size, the person's marks) costs it no read of the claim. The last claim read naming another
    // app says so whatever the mark (S33) — while handed over, as known: nothing read again.
    entry.held = () => changeRefusal({ state, work, change: true, handover, taken: !!folder && held && !work && _heldElsewhere(folder, { read: !handover }), held });
    const why = entry.mark ? entry.held() : null;
    if (why) { _refuseIn(tx, id, why, folder); return; }
    if (entry.folder && entry.mark) _markIn(tx, id, entry.rev);
  });
}
const _markIn = (tx, gid, rev) => tx.objectStore(UNDESCRIBED_STORE).put({ gid, rev });
// Folder work: { kind, folder } — folder `folder`'s own work of kind 'removal' (its removal's moves and
// write-back), 'adopt' (a check reading it back), 'forget' (its removal forgetting it) or 'migration'
// (what an earlier version kept of it brought back; `folder` '*': a field derived from what each
// gallery holds, filled in for every one). The kind it is for folder `folder` — null for any other: the
// write gate lets a removal write to its own folder alone (_rootOf), the mount check lets the work
// change galleries placed there alone (_logIn), never where a removal moves them to (F02).
const _workOn = (work, folder) => (work && (work.folder === folder || work.folder === '*') ? work.kind : null);
// The state of the place of the gallery whose stat record is `stat`, read in `tx` and passed to
// `found`: its folder's, or this browser's — 'shown' for one with no stat, null for a folder the
// library doesn't know.
function _placeStateIn(tx, stat, found) {
  if (!stat) { found('shown', null); return; }
  const req = tx.objectStore(FOLDER_STORE).get(stat.folder || BROWSER);
  req.onsuccess = () => found(req.result ? req.result.state || 'shown' : stat.folder ? null : 'shown', req.result ?? null);
}
// `tx` aborted: gallery `gid` is out of the library, its place hidden or removed — or, `why`
// 'not-owned' / 'handover', in folder `folder`, which another app holds / is still being read (_logIn).
function _refuseIn(tx, gid, why = 'hidden', folder = null) {
  if (tx._refused) return;
  if (why === 'handover') _folderLibrary.handOverSoon(folder);   // its check comes back where it ended without reading (S33)
  tx._refused = why === 'gone' ? Object.assign(new BackendError('aborted', `gallery ${gid} was deleted meanwhile`), { reason: why })
    : why === 'not-owned' || why === 'handover'
    ? Object.assign(new BackendError('unavailable', why === 'handover' ? `gallery ${gid} is in a library folder still being read`
      : `gallery ${gid} is in a library folder another app is using`), { reason: why, folder })
    : Object.assign(new BackendError('invalid', `gallery ${gid} is in a hidden library folder`), { reason: 'hidden' });
  try { tx.abort(); } catch {}
}

// The library's current revision (0 for a library that has never changed).
export async function changeRevision() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, CHANGES_STORE, 'readonly');
    let rev = 0;
    const req = tx.objectStore(CHANGES_STORE).openKeyCursor(IDBKeyRange.upperBound(Number.MAX_SAFE_INTEGER), 'prev');
    req.onsuccess = () => { rev = req.result ? Number(req.result.key) : 0; };
    tx.oncomplete = () => resolve(rev);
    tx.onerror = () => reject(_txError(tx));
  });
}

// The galleries changed after revision `rev`: { rev, gids } with `rev` the revision they bring the
// caller to — or { rev, resync: true } when the log can't say (it no longer reaches back that far,
// or the whole library was cleared).
export async function changesSince(rev) {
  const since = Number(rev) || 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, CHANGES_STORE, 'readonly');
    const store = tx.objectStore(CHANGES_STORE);
    const out = { rev: since, gids: [], resync: false };
    const gids = new Set();
    const marker = store.get('compacted');
    marker.onsuccess = () => { if (marker.result && since < marker.result.upTo) out.resync = true; };
    const req = store.openCursor(IDBKeyRange.bound(since, Number.MAX_SAFE_INTEGER, true, false));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      out.rev = Number(c.key);
      if (c.value.gid === '*') out.resync = true; else gids.add(c.value.gid);
      c.continue();
    };
    tx.oncomplete = () => { if (!out.resync) out.gids = [...gids]; resolve(out); };
    tx.onerror = () => reject(_txError(tx));
  });
}

// ── Images kept apart from their records ──
// Chrome rewrites every Blob in a record each time the record is put, so a page record that held
// its images rewrote all of them on every small change: its settings, a revert, study data
// arriving. Images live in BLOB_STORE instead, each written once under an id naming its record and
// place; the record holds a reference ({ $blob: id, size, type }) where the image was. Every reader
// here hands records back with their Blobs in place, so the rest of the app sees the same records.
// A record stored before this keeps its images inline until it next changes.
const REF = '$blob';
// A reference to a stored image: one in BLOB_STORE ({ $blob }), or a file in a gallery's library
// folder ({ $path, folder, dir } — see "Library folders"; `ro` for a linked gallery's source, read
// and never written or deleted — `zip` when `$path` is an entry of the archive `dir`).
const _isPath = (v) => v != null && typeof v === 'object' && typeof v.$path === 'string';
const _isRef = (v) => v != null && typeof v === 'object' && (typeof v[REF] === 'string' || typeof v.$path === 'string');
// A file's id: where it is, and the size and modification time it was recorded with (a reference is
// never changed once made, so a file keeps its id; deleting it later checks them: principle 4).
const _pathKey = (ref) => `file:${JSON.stringify([ref.folder, ref.dir, ref.$path, ref.size ?? null, ref.mtime ?? null])}`;
const _refId = (v) => (typeof v[REF] === 'string' ? v[REF] : _pathKey(v));
const _stored = new WeakMap();   // a Blob read back from BLOB_STORE → its id

// Where a record's images sit: [container, key, id] for each. Legacy data-URL strings stay inline.
function _pageSlots(rec) {
  const out = [];
  const at = (obj, key, part) => { if (obj?.[key] != null && typeof obj[key] === 'object') out.push([obj, key, `${rec.url}|${part}`]); };
  at(rec, 'blob', 'page');
  at(rec, 'translated', 'tr');
  at(rec, 'studyBg', 'bg');
  if (Array.isArray(rec.bubbles)) rec.bubbles.forEach((b, k) => at(b, 'text', `t${k}`));
  at(rec.pipeline?.masks, 'raw', 'raw');
  at(rec.pipeline?.masks, 'text', 'mask');
  return out;
}
function _coverSlots(rec) {
  const out = [];
  const at = (obj, key, id) => { if (obj?.[key] != null && typeof obj[key] === 'object') out.push([obj, key, `cover|${rec.galleryId}|${id}`]); };
  at(rec, 'cover', 'gallery');
  at(rec, 'seriesCover', 'series');
  for (const [role, widths] of Object.entries(rec.coverThumbs || {})) {
    for (const width of Object.keys(widths || {})) at(widths, width, `${role}|${width}`);
  }
  return out;
}
// A record owns the images stored under its own prefix. A cover may also point at its gallery's first
// page image — that page owns it, so the cover never deletes it and reads it by its id.
// In a library folder, a cover owns the files in its gallery's covers/; a page every other one it names.
const PAGE = { slots: _pageSlots, prefix: (rec) => `${rec.url}|`, ownsPath: (p) => !p.startsWith('covers/') };
const COVER = { slots: _coverSlots, prefix: (rec) => `cover|${rec.galleryId}|`, ownsPath: (p) => p.startsWith('covers/') };
const _ref = (id, blob) => ({ [REF]: id, size: blob.size, type: blob.type });
// The ids of the images `rec` owns (a file's: its _pathKey).
function _refIds(rec, kind) {
  if (!rec) return [];
  const own = kind.prefix(rec);
  return kind.slots(rec).map(([obj, key]) => obj[key]).filter(_isRef).filter(v => !v.ro)
    .filter(v => (typeof v[REF] === 'string' ? v[REF].startsWith(own) : kind.ownsPath(v.$path))).map(_refId);
}
// Images let go: deleted from BLOB_STORE with the transaction, files once it has committed.
const _dropBlobs = (tx, ids) => {
  const blobs = tx.objectStore(BLOB_STORE);
  for (const id of ids) { if (id.startsWith('file:')) _unlinkLater(tx, id); else blobs.delete(id); }
};

// The record to put for `rec` (never changed itself): images not yet stored go to BLOB_STORE and
// are referenced, and images the record it replaces owned (`before`, their ids) that it no longer
// holds are deleted. An image read back from BLOB_STORE into the same place is not stored again.
function _stash(tx, rec, before, kind) {
  const out = { ...rec };
  if (kind === PAGE) delete out.pageNum;   // read from the key, never stored
  if (Array.isArray(rec.bubbles)) out.bubbles = rec.bubbles.map(b => (b && typeof b === 'object' ? { ...b } : b));
  if (rec.pipeline?.masks) out.pipeline = { ...rec.pipeline, masks: { ...rec.pipeline.masks } };
  if (rec.coverThumbs) out.coverThumbs = Object.fromEntries(Object.entries(rec.coverThumbs).map(([role, w]) => [role, { ...w }]));
  const blobs = tx.objectStore(BLOB_STORE);
  const had = new Set(before);
  const keep = new Set();
  const written = [];
  for (const [obj, key, id] of kind.slots(out)) {
    const value = obj[key];
    if (_isRef(value)) { keep.add(_refId(value)); continue; }
    if (!(value instanceof Blob)) continue;
    if (!(_stored.get(value) === id && had.has(id))) { blobs.put({ id, blob: value }); written.push([value, id]); }
    obj[key] = _ref(id, value);
    keep.add(id);
  }
  _dropBlobs(tx, before.filter(id => !keep.has(id)));
  if (written.length) tx.addEventListener('complete', () => { for (const [blob, id] of written) _stored.set(blob, id); });
  return out;
}

// Put the Blobs back into records read in `tx` (which includes BLOB_STORE; call it from a request
// callback, while `tx` is active). One range read per record fetches the images it owns.
// Files in a library folder are read once `tx` has completed: the reader awaits _withFiles(tx).
function _loadBlobs(tx, recs, kind) {
  const blobs = tx.objectStore(BLOB_STORE);
  const place = (obj, key, blob) => {
    const id = obj[key][REF];
    if (blob) _stored.set(blob, id);
    obj[key] = blob || null;
  };
  for (const rec of recs) {
    if (!rec) continue;
    const slots = kind.slots(rec).filter(([obj, key]) => _isRef(obj[key]));
    for (const [obj, key] of slots) if (_isPath(obj[key])) (tx._paths ||= []).push([obj, key, String(rec.galleryId)]);
    const refs = slots.filter(([obj, key]) => !_isPath(obj[key]));
    if (!refs.length) continue;
    const own = kind.prefix(rec);
    const owned = refs.filter(([obj, key]) => obj[key][REF].startsWith(own));
    if (owned.length) {
      const req = blobs.getAll(IDBKeyRange.bound(own, own + '\uffff'));
      req.onsuccess = () => {
        const byId = new Map((req.result || []).map(r => [r.id, r.blob]));
        for (const [obj, key] of owned) place(obj, key, byId.get(obj[key][REF]));
      };
    }
    for (const [obj, key] of refs) {
      if (owned.some(([o, k]) => o === obj && k === key)) continue;
      const req = blobs.get(obj[key][REF]);
      req.onsuccess = () => place(obj, key, req.result?.blob);
    }
  }
}
// Page records read back carry their page number (null for a key without one).
const _numbered = (recs) => { for (const rec of recs) if (rec) rec.pageNum = _keyPage(rec.url); return recs; };
const _loadPages = (tx, recs) => _loadBlobs(tx, _numbered(recs), PAGE);
const _loadCovers = (tx, recs) => _loadBlobs(tx, recs, COVER);

// ── Library folders ──
// A gallery's pictures may be kept in a folder the person picked (storage/folder-store-web.js, the
// folder store adapter, reads and writes them) rather than in this browser's own storage, "this
// browser" (BROWSER), which is always there.
// FOLDER_STORE holds each folder — { id, name, handle, addedAt, epoch, state, removal? } — and
// { id: '$default', folder } (where new galleries go; none: this browser), { id: BROWSER, state }
// (this browser's own place, once it has been hidden) and { id: '$instance', instance } (this
// library's id among the apps that keep folders). `state` is the place's one lifecycle state
// (folder-lifecycle.js: 'shown', 'hidden', or 'removing' with `removal` { moveTo, discard, before });
// `epoch` the claim's counter this library last held the folder at (folder-owner.js). A gallery kept
// in a folder says so on its stat record: `folder` (the folder's id) and `dir` (its own folder in it,
// reserved and bound to it when its first picture arrives: _reserveDir). Its records refer to a
// picture there by { $path, folder, dir, size, type, mtime } where an image in BLOB_STORE has { $blob }:
// `$path` is where the gallery format puts it (gallery-files.js layoutPath — or that name with a
// random part, while a file had the layout name: no write goes over a file a record refers to), so a
// gallery's folder reads like an unzipped export of it — and the gallery's descriptions
// (metadata.json, image_records.json…) and its manifest are published beside its pictures a moment
// after it changes (_describe). Cover thumbnails stay in BLOB_STORE, being a cache. A write brings its
// pictures to the folder before its transaction and refers to them there; files no record refers to
// any more go once a publication no longer naming them has committed (the commit protocol: _writing). A context that may not write to the folder (permission not granted
// this visit, another app's claim, the folder hidden) keeps the pictures in BLOB_STORE meanwhile and
// marks the gallery `spilled`; a window that may moves them out (settleFolders). A gallery read from
// an archive in the gallery format is kept in it (`packed`), its records referring to its entries,
// until its first change unpacks it (_unpackLocked). What the person does with the folders, and
// reading one into the library, is folder-library.js's (see the end of this section).
export const BROWSER = 'browser';
const DEFAULT_FOLDER = '$default';
let _foldersRead = null;
const _grants = new Map();     // folder id → { state, owned, claim, at }: what it allows, asked at most every few seconds
const GRANT_TTL_MS = 2000;     // as the desktop's (folders.js IDENTITY_TTL): the window a read may lag a folder swapped by hand
const _known = new Map();      // folder id → the last claim this context read of it: what the commit gate knows (folder-owner.js knownAfter)
const _reached = new Map();    // folder id → which folder its handle was last found to reach (identityOf: 'ok', 'other-library'…), for _unfoundMayBeIn
const _fileOf = new WeakMap(); // a picture read from or written to a gallery's folder → its reference

// A folder record as IndexedDB 18 kept it (flags `hidden`, `dormant`, `settingAside`, `claimEpoch`…),
// or this browser's ({ id: BROWSER, hidden }), in today's shape. A folder an earlier version removed
// without writing back what only the library had of its galleries (`dormant` with no `settingAside`:
// removed before removals did) is being removed again, so the removal writes that back first.
function _folderRecordV19(r) {
  if (r.id === BROWSER) return { id: BROWSER, state: r.state || (r.hidden ? 'hidden' : 'shown') };
  const { hidden, dormant, settingAside, removedAt, hiddenAt, claimEpoch, moveTo, discard, hiddenCount, hiddenSize, ...rest } = r;
  const out = { ...rest, epoch: rest.epoch ?? claimEpoch ?? null, state: rest.state || (dormant ? 'removing' : hidden ? 'hidden' : 'shown') };
  if (dormant && !rest.removal) out.removal = { moveTo: (settingAside && moveTo) || null, discard: !!(settingAside && discard), before: hidden ? 'hidden' : 'shown' };
  return out;
}

// { byId: Map id → folder of the library's (shown or hidden), removing: Map id → folder being removed,
// defaultId, browser (this browser's place: { id, state }), unmounted }. `unmounted`: the places whose
// galleries are out of the library meanwhile — hidden, or being removed.
function _folders() {
  return _foldersRead ??= openDB().then(db => new Promise((resolve, reject) => {
    const tx = _tx(db, FOLDER_STORE, 'readonly');
    const req = tx.objectStore(FOLDER_STORE).getAll();
    tx.oncomplete = () => {
      const byId = new Map(), removing = new Map();
      let defaultId = null, browser = { id: BROWSER, state: 'shown' };
      for (const r of req.result || []) {
        if (r.id === DEFAULT_FOLDER) defaultId = r.folder || null;
        else if (r.id === BROWSER) browser = r;
        else if (!String(r.id).startsWith('$')) (r.state === 'removing' ? removing : byId).set(r.id, r);
      }
      const unmounted = new Set([...byId.values(), ...removing.values(), browser].filter(f => !mounted(f.state)).map(f => f.id));
      resolve({ byId, removing, defaultId: byId.has(defaultId) ? defaultId : null, browser, unmounted });
    };
    tx.onerror = () => reject(_txError(tx));
  })).catch((e) => { _foldersRead = null; throw e; });
}
function _foldersChanged() {
  _forgetFolders();
  platform.control.send({ type: 'FOLDERS_CHANGED' });
}
function _forgetFolders() { _foldersRead = null; _grants.clear(); _ours.clear(); _readable.clear(); }
// What the commit gate knew of folder `id`'s claim forgotten, in every context of this browser: this
// library wrote the claim (claimed the folder, took it back, let it go: _writeClaim), or forgot the folder.
const _forgetKnown = (id) => platform.control.send({ type: 'CLAIM_FORGOTTEN', folder: id });
// How many times what the gate knew of each folder was forgotten here: a read of its claim begun before the
// latest (its claim written since by this library: "Take back") tells of the claim before, and teaches
// nothing (_access; review 8, S31).
const _forgotten = new Map();   // folder id → count
platform.control.on((msg) => {
  if (msg?.type === 'FOLDERS_CHANGED') _forgetFolders();
  else if (msg?.type === 'CLAIM_FORGOTTEN') { _known.delete(msg.folder); _forgotten.set(msg.folder, (_forgotten.get(msg.folder) || 0) + 1); }
});

// What this context may do with folder `id` now: { state (its permission — or 'other-library': the
// folder its handle reaches is another library folder, or names none: principle 1), owned, claim (as
// read) }. It reads a folder it may use, and that is it; it writes to it only while this library holds
// its claim (folder-owner.js access 'mine'). A folder no app holds — never claimed, or let go by this
// library and untouched since — is claimed here first, and read back: of two apps claiming it at once
// only one goes on. One another app holds, or whose claim can't be read, is read, never written.
// Another library folder at its handle's path is neither read, claimed, scanned nor written (T01).
// What a folder reached allows is taken as it is for GRANT_TTL_MS, for reads; one out of reach, another
// library's at its place, without leave or whose claim couldn't be read now (readClaim `unread`: C1) is
// asked again the next time, so one back is used at once (S8: a folder whose drive came back couldn't be
// checked for five seconds), and one failed read refuses only what it met. Every claim read is what the
// commit gate knows from then on (`_known`, folder-owner.js knownAfter: one that failed, or a folder out of
// reach, changes nothing of it — nor one begun before what was known was forgotten here: _forgotten).
// `fresh` (every write, and every check, through the write gate: _rootOf) reads which folder the handle
// reaches again, as the desktop does: another library put at its path a moment after a write is never
// written to, nor its galleries adopted (F1, S10).
async function _access(id, { fresh = false } = {}) {
  if (!id) return { state: 'unavailable', owned: false, claim: null };
  const since = _forgotten.get(id) || 0;
  const hit = _grants.get(id);
  if (hit && Date.now() - hit.at < GRANT_TTL_MS) {
    if (!fresh) return hit;
    const folder = await _folderById(id);
    const here = folder ? await folderFiles.identityOf(id, folder.handle) : 'unavailable';
    _reached.set(id, here);
    if (here === 'ok') return hit;
    _grants.delete(id);
    return { state: here, owned: false, claim: null };
  }
  const folder = await _folderById(id);
  let state = folder ? await folderFiles.permission(folder.handle) : 'unavailable';
  if (state === 'granted') { const here = await folderFiles.identityOf(id, folder.handle); _reached.set(id, here); if (here !== 'ok') state = here; }
  const held = state === 'granted' ? await _holds(folder).catch(() => ({ owned: false, claim: readClaim(undefined) })) : { owned: false, claim: null };
  const out = { state, ...held, at: Date.now() };
  const current = (_forgotten.get(id) || 0) === since;   // what it read is still the latest this context may know
  if (state === 'granted' && !held.claim?.unread && current) _grants.set(id, out); else _grants.delete(id);
  if (state === 'granted' && held.claim && current) { const known = knownAfter(_known.get(id), held.claim, held.owned || !!held.handover, out.at); if (known) _known.set(id, known); }
  return out;
}
// Whether this context knows another app holds folder `id` — what the commit gate weighs (_logIn): the
// last claim it read of it (`_known`), weighed by folder-owner.js heldElsewhere. One naming another app
// refuses until a later read says otherwise; a read that failed, or the folder out of reach, changes
// nothing of it. The gate sits inside a transaction and can't wait for a read: none read yet here, or one
// older than the claim's time to live, it weighs the last answer (none: nothing refused) and has the claim
// read again at once in the background (one read under way per folder), so the next change rests on it.
// No file call for a change inside the time to live.
const _rereads = new Map();   // folder id → its claim's read under way, asked by the gate
// `read` false: what is known alone, nothing read again (the gate of a folder being handed over).
function _heldElsewhere(id, { read = true } = {}) {
  const { held, again } = heldElsewhere(_known.get(id));
  if (read && again && !_rereads.has(id)) {
    _grants.delete(id);   // read afresh: a grant of a moment ago may be older than a claim this library wrote since
    _rereads.set(id, _access(id).catch(() => {}).finally(() => _rereads.delete(id)));
  }
  return held;
}
// The write gate: folder `id`'s handle when this context may change its files now — it can be
// reached, this library holds its claim, and its state allows it (folder-lifecycle.js writeAllowed:
// shown; while it is being removed, that removal's own write-back alone: `work` its work, _workOn) — else
// null. Every change to the files of a library folder goes through here (its claim file aside:
// _holds, and folder-library.js letting it go); what may not be written waits in this browser (`spilled`), or keeps its mark.
async function _rootOf(id, { work = null } = {}) {
  const folder = await _folderById(id);
  if (!folder) return null;
  const a = await _access(id, { fresh: true });
  return writeAllowed({ state: folder.state, owned: a.owned, reachable: a.state === 'granted', work: _workOn(work, id) }) ? folder.handle : null;
}
const _usable = async (id, opts) => !!(await _rootOf(id, opts));
// Folder `id`'s handle when this context may read it (its permission granted), whatever its state.
async function _readRootOf(id) { return (await _access(id)).state === 'granted' ? (await _folderById(id))?.handle || null : null; }
// A folder of the library's, or one being removed (its galleries read and written back until it is
// forgotten).
async function _folderById(id) { const { byId, removing } = await _folders(); return byId.get(id) || removing.get(id) || null; }
// The library's folders as the folder store contract has them (storage/folder-store-web.js): each
// weighed as its record, this page's permission, the folder its handle reaches and the library's claim
// say now (asked afresh).
export const folderStore = folderFiles.folderStore(async (id) => {
  const folder = await _folderById(id);
  if (!folder) return null;
  _grants.delete(id);
  const a = await _access(id);
  const here = a.state !== 'other-library';
  return { handle: folder.handle, state: folder.state, owned: a.owned, handover: !!a.handover, permission: here ? a.state : 'granted', here, writer: await _me() };
});

// ── Which app keeps a folder (folder-owner.js) ──
// This library's own id among the apps that may keep a folder, made once and kept in FOLDER_STORE
// ('$instance': a factory reset keeps it), and how a folder's claim describes it.
const INSTANCE = '$instance';
const _randomId = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
let _meRead = null;
function _me() {
  return _meRead ??= openDB().then(db => new Promise((resolve, reject) => {
    const tx = _tx(db, FOLDER_STORE, 'readwrite');
    const store = tx.objectStore(FOLDER_STORE);
    let id = null;
    const req = store.get(INSTANCE);
    req.onsuccess = () => {
      id = req.result?.instance || null;
      if (!id) { id = _randomId(); store.put({ id: INSTANCE, instance: id }); }
    };
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(_txError(tx));
  })).catch((e) => { _meRead = null; throw e; });
}
const _myLabel = () => ({ app: 'web', browser: platform.helperHost, site: globalThis.location?.host || '' });
// A folder's claim as read (folder-owner.js readClaim): absent, damaged (a file that can't be read
// too), or a claim.
async function _readClaim(id, root) {
  try { return readClaim(await folderFiles.readText(id, root, OWNER_FILE)); } catch (e) { return readClaim(e); }
}
// The claim this library writes (claiming the folder, taking it back, letting it go) ends what the commit
// gate knew of it in every context: the next read tells (_forgetKnown).
async function _writeClaim(id, root, claim) {
  await folderFiles.writeFile(id, root, OWNER_FILE, claimText(claim));
  _forgetKnown(id);
}
// The claim's counter this library holds folder `id` at, kept on its record: added back after it was
// removed, the folder tells by it whether another app had it meanwhile.
const _noteEpoch = (id, epoch) => _folderWrite((store) => {
  const req = store.get(id);
  req.onsuccess = () => { if (req.result && req.result.epoch !== epoch) store.put({ ...req.result, epoch }); };
});
// Whether this library holds folder `folder`'s claim: { owned, handover, claim (as read) }. One no app holds is
// claimed now, and is this library's only if the claim read back says so. `handover`: its claim, its hand-over's
// check yet to read it (folder-owner.js): not `owned`. The mark is read afresh after the claim (it is written
// before it), so no context takes the folder for its own before the read.
async function _holds(folder) {
  const me = await _me();
  const held = folder.epoch ?? null;
  let read = await _readClaim(folder.id, folder.handle);
  if (access(read, me, held) === 'free') {
    await _writeClaim(folder.id, folder.handle, nextClaim(read, me, _myLabel(), { held }).claim);
    read = await _readClaim(folder.id, folder.handle);
    if (access(read, me, held) === 'mine') await _noteEpoch(folder.id, read.epoch);
  }
  const now = access(read, me, held, access(read, me, held) === 'mine' ? await _markOf(folder.id) : null);
  // Being handed over: its check started where none is under way here; its claim's read failing meanwhile, read again in a
  // moment — so a check that ended without reading the folder comes back by itself (S33, review 10 A1).
  if (now === 'handover') _folderLibrary.handOverSoon(folder.id);
  else if (read.state === 'damaged' && read.unread && folder.handover && !_claimRereads.has(folder.id)) {
    _claimRereads.set(folder.id, setTimeout(() => { _claimRereads.delete(folder.id); _grants.delete(folder.id); _access(folder.id).catch(() => {}); }, HANDOVER_RETRY_MS));
  }
  return { owned: now === 'mine', handover: now === 'handover', claim: read };
}
const _claimRereads = new Map();   // folder id → the timer reading its claim again (_holds)
// Folder `id`'s hand-over as its record holds it now (read afresh), or null.
async function _markOf(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, FOLDER_STORE, 'readonly');
    const req = tx.objectStore(FOLDER_STORE).get(id);
    tx.oncomplete = () => resolve(handoverIn(req.result?.handover));
    tx.onerror = () => reject(_txError(tx));
  });
}
// The claim's counter this library let folder `id` go at (folder-library.js _release): added again untouched
// since, it is its own (no hand-over). Kept apart from the folder's record, which its removal forgets.
const _releasedKey = (id) => `$released:${id}`;
const _noteReleased = (id, epoch) => _recordsWrite((store) => store.put({ id: _releasedKey(id), epoch }));
async function _releasedOf(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, FOLDER_STORE, 'readonly');
    const req = tx.objectStore(FOLDER_STORE).get(_releasedKey(id));
    tx.oncomplete = () => resolve(Number.isSafeInteger(req.result?.epoch) ? req.result.epoch : null);
    tx.onerror = () => reject(_txError(tx));
  });
}
// Folder `id`'s hand-over recorded (`handover`) or ended (null). Resolves whether the record was there.
async function _setHandover(id, handover) {
  let there = false;
  await _folderWrite((store) => {
    const req = store.get(id);
    req.onsuccess = () => {
      if (!req.result) return;
      there = true;
      const { handover: was, ...rest } = req.result;
      store.put(handover ? { ...rest, handover } : rest);
    };
  });
  return there;
}

// A stat record without its home (what travels with a gallery to another library doesn't), and its
// home alone (what a gallery keeps through a restore of it: transferWrite). `packed`: the gallery is
// kept in an archive in the gallery format, `dir` (a native archive, read in place — { inner }: its
// folder in a series export, '' for an archive of its own), until its first change unpacks it
// (_unpackLocked). `missing`: a linked gallery whose source isn't where it was (folder-library.js).
const HOME_FIELDS = ['folder', 'dir', 'spilled', 'stamp', 'linked', 'packed', 'missing'];
const _withoutHome = (stat) => { if (!stat) return stat; const { undescribed, ...rest } = stat; for (const k of HOME_FIELDS) delete rest[k]; return rest; };
const _homeOf = (stat) => Object.fromEntries(HOME_FIELDS.filter(k => stat?.[k] != null).map(k => [k, stat[k]]));
// A stat record as it travels to another library (a backup, a library moved: transferRead, transferWrite) — without its
// home, nor the mark it was made with here (`born`, this browser's own: _born).
const _forTransfer = (stat) => { if (!stat) return stat; const { born, ...rest } = _withoutHome(stat); return rest; };

// Where gallery `gid`'s pictures go: null for one kept in this browser, else { folder, dir, root,
// claimed } — `root` the folder's handle when this context may write there (the gate, _rootOf; null:
// they wait in this browser for now), `dir` its folder in it (reserved now — `claimed` — when it has
// none yet, for write `w`). A gallery not stored yet goes where new galleries go; `meta` describes it.
async function _home(gid, meta = null, w = null) {
  const { byId, removing, defaultId } = await _folders();
  let stat = await galleryGet(gid);
  const folder = stat ? stat.folder : defaultId;
  if (!folder || !(byId.has(folder) || removing.has(folder))) return null;
  const home = { gid: String(gid), folder, dir: stat?.dir || null, root: await _rootOf(folder), claimed: false };
  // Kept in an archive: unpacked first (its first change), else what is written waits in this browser.
  if (home.root && stat?.packed) {
    stat = await _unpackLocked(gid).then(() => galleryGet(gid), () => stat);
    if (stat?.packed) home.root = null; else home.dir = stat?.dir || null;
  }
  if (home.root && !home.dir) {
    try { ({ dir: home.dir, token: home.token } = await _reserveDir(gid, folder, home.root, meta, w)); home.claimed = true; } catch { home.root = null; }
  } else if (home.root && !(await _mayWriteDir(folder, home.root, home.dir, gid).catch(() => false))) {
    home.root = null;   // its folder is another gallery's: nothing is written there
  }
  return home;
}
// The home fields a gallery's stat record takes after a write to `home` (`left`: pictures it left in
// this browser for now) — a folder reserved for it with the reservation's stamp.
const _homeFields = (home, left) => (!home ? {} : { folder: home.folder, ...(home.dir ? { dir: home.dir } : {}),
  ...(home.claimed && home.token ? { stamp: home.token } : {}), ...(left ? { spilled: 1 } : {}) });

// Gallery `gid`'s own folder in folder `folder`, named after it (or `base`, a path in the folder) and
// bound to it by its first generation (folderFiles.reserveDir: the only way a folder becomes a
// gallery's; never at a name a deletion still waits on) — noted for write `w`, which deletes it should
// it not commit. Resolves its place, held as reserved (`dir` its name, `token` the reservation's
// publication: the stamp its stat record takes with it). A reservation that failed and couldn't be taken
// back now is recorded for deletion (_owe: review 6 F9 b).
async function _reserveDir(gid, folder, root, meta, w, base = null) {
  const m = migrateTitle({ ...(meta || await metaGet(gid) || {}), galleryId: String(gid) });
  const taken = new Set((await _deletions(folder)).map(d => d.dir));   // a deletion still waits there
  const place = await folderFiles.reserveDir(folder, root, base || galleryName(m), JSON.stringify(m, null, 2), { gid: String(gid), writer: await _me(), taken })
    .catch(async (e) => { if (e?.left) await _owe(folder, e.left.dir, gid, e.left.files).catch(() => {}); throw e; });
  w?.made.push({ folder, root, path: place.dir, dir: true, gid: String(gid) });
  return place;
}
// Whether `dir` in a folder is gallery `gid`'s own: it names it (folderFiles.galleryIn: its manifest,
// else its metadata.json; an overlay, its source.json) — or, for an archive in the gallery format, its
// descriptions name it (its own metadata.json, or a series export's series.json) and no other gallery
// is still read from it. Nothing is deleted from a folder another gallery's description names, nor
// from one no description names. Null when that can't be told now (a read failed, or what was there a
// moment ago isn't: principle 6 — nothing is concluded, S21).
async function _ownsDir(folder, root, dir, gid) {
  const found = await folderFiles.galleryIn(folder, root, dir, String(gid));
  if (found.kind === 'ok') return true;
  if (found.kind === 'unreadable' || found.kind === 'missing') return null;
  if (found.found != null) return false;
  if (dir === overlayDir(gid)) return true;   // its overlay, named by its id in the folder's .shiori/, naming no other
  const file = await folderFiles.readFile(folder, root, dir).catch(() => undefined);
  if (file === undefined) return null;
  if (!file) return false;   // a folder naming none, not an archive
  const names = await _archiveNames(folder, root, dir).catch(() => null);
  if (!names) return null;
  if (!names.has(String(gid))) return false;
  return !(await galleryGetAll()).some(g => g.folder === folder && g.dir === dir && String(g.galleryId) !== String(gid));
}
// The galleries an archive in the gallery format describes: its own metadata.json's, or a series
// export's chapters (folder-content.js).
async function _archiveNames(folder, root, path) {
  const archive = await _archiveOf(folder, root, path);
  const text = async (name) => { const e = archive?.entries.get(name); return e ? new TextDecoder().decode(await e.read()) : null; };
  const own = galleryIdOf(await text('metadata.json'));
  return new Set(own ? [own] : (seriesOf(await text('series.json'))?.chapters || []).map(c => c.id));
}
// Whether the archive at `path` holds nothing but what Shiori put there (gallery-manifest.js
// foreignEntries, by its own manifest; `met`: one a folder's deletion met in its place): what may be
// deleted whole (F6). One whose manifest is damaged holds nothing known to be Shiori's; null when it
// can't be read now (gone a moment after it was read, or a read failed: principle 6 — never taken for the
// person's, S21).
async function _archiveOnlyOwn(folder, root, path, met = false) {
  try {
    const archive = await _archiveOf(folder, root, path);
    if (!archive) return null;
    const at = archive.entries.get(MANIFEST_FILE);
    const manifest = at ? parseManifest(new TextDecoder().decode(await at.read()), { archive: true }) : null;
    if (manifest?.kind === 'corrupt') return false;
    return !foreignEntries(archive.entries, manifest?.kind === 'ok' ? manifest.value : null, { met }).length;
  } catch { return null; }
}
// Whether gallery `gid` may write into its folder `dir`: the folder names it (folderFiles.galleryIn,
// principle 2) — one naming another gallery, or none (put there by hand), or gone, is written to
// never, its pictures kept in this browser meanwhile; a folder naming none is noted on its library
// folder's Needs attention list. Found so, taken as it is for GRANT_TTL_MS (each write asks; a
// deletion asks afresh: _ownsDir), and forgotten with the folders' grants — but `fresh`: asked again, as
// a picture is about to be written there (_place: F2, S10).
const _ours = new Map();   // `${folder}\0${dir}\0${gid}` → when it was found to be the gallery's
async function _mayWriteDir(folder, root, dir, gid, { fresh = false } = {}) {
  const key = `${folder}\0${dir}\0${gid}`;
  if (!fresh && Date.now() - (_ours.get(key) ?? -Infinity) < GRANT_TTL_MS) return true;
  const found = await folderFiles.galleryIn(folder, root, dir, String(gid));
  if (found.kind === 'conflict') await _note(folder, { reason: 'conflict', path: dir, gid: String(gid) });
  if (found.kind !== 'ok') { _ours.delete(key); return false; }
  _ours.set(key, Date.now());
  return true;
}
// Whether file reference `ref` (not a linked source's: those are the source's, read as it is) may be
// read as gallery `gid`'s: not while its folder names another gallery — a folder swapped by hand for
// another gallery's never serves that gallery's pictures as this one's, which the library folder's
// identity alone (_readRootOf) doesn't tell — nor an archive whose descriptions name others only, nor
// while what it holds can't be read. One naming no gallery is read as the records say. Found so, taken
// as it is for GRANT_TTL_MS (a page read then costs a Map lookup), and forgotten with the folders' grants.
const _readable = new Map();   // `${folder}\0${dir}\0${gid}` → when it was found readable as the gallery's
async function _mayReadDir(ref, root, gid) {
  if (ref.ro || gid == null) return true;
  const key = `${ref.folder}\0${ref.dir}\0${gid}`;
  if (Date.now() - (_readable.get(key) ?? -Infinity) < GRANT_TTL_MS) return true;
  let ok;
  if (ref.zip) {
    const names = await _archiveNames(ref.folder, root, ref.dir).catch(() => null);
    ok = !!names && (!names.size || names.has(String(gid)));
  } else {
    const found = await folderFiles.galleryIn(ref.folder, root, ref.dir, String(gid));
    if (found.kind === 'missing') return true;   // the read finds nothing there itself
    ok = found.kind === 'ok' || (found.kind === 'conflict' && found.found == null);
  }
  if (!ok) { _readable.delete(key); return false; }
  _readable.set(key, Date.now());
  if (_readable.size > 4096) _readable.delete(_readable.keys().next().value);
  return true;
}

// Where the gallery format puts each picture of page `n`'s record `rec`: [obj, key, path] for each.
const _pictureExt = (blob) => extOfType(blob.type) || 'png';
function _pageFiles(rec, n) {
  const out = [];
  const at = (obj, key, path) => { if (obj?.[key] instanceof Blob) out.push([obj, key, path(obj[key])]); };
  at(rec, 'blob', (b) => layoutPath.original(n, originalExt(b.type, rec.url)));
  at(rec, 'translated', (b) => layoutPath.translated(n, _pictureExt(b)));
  at(rec, 'studyBg', (b) => layoutPath.studyBg(n, _pictureExt(b)));
  if (Array.isArray(rec.bubbles)) rec.bubbles.forEach((bubble, k) => at(bubble, 'text', (b) => layoutPath.studyText(n, k, _pictureExt(b))));
  at(rec.pipeline?.masks, 'raw', (b) => layoutPath.mask(n, 'raw', _pictureExt(b)));
  at(rec.pipeline?.masks, 'text', (b) => layoutPath.mask(n, 'text', _pictureExt(b)));
  return out;
}
// A cover's own pictures (a cover that is a page refers to the page's file, wherever it is named).
function _coverFiles(rec) {
  const out = [];
  for (const [field, role] of [['cover', 'gallery'], ['seriesCover', 'series']]) {
    if (rec?.[field] instanceof Blob) out.push([rec, field, layoutPath.cover(role, _pictureExt(rec[field])), true]);
  }
  return out;
}
// A page record's parts that hold pictures, copied, so placing them changes nothing of the caller's.
function _pageCopy(rec) {
  const out = { ...rec };
  if (Array.isArray(rec.bubbles)) out.bubbles = rec.bubbles.map(b => (b && typeof b === 'object' ? { ...b } : b));
  if (rec.pipeline && typeof rec.pipeline === 'object') out.pipeline = { ...rec.pipeline, ...(rec.pipeline.masks ? { masks: { ...rec.pipeline.masks } } : {}) };
  return out;
}
// The pictures `slots` holds ([obj, key, path, anyPath]: a picture and where the gallery format puts
// it) written to the gallery's folder at `home` and referred to there — each under a name no file has
// (folderFiles.writeNew), noted for write `w` — one already there (read from a file at that place in
// the format; for a cover, from any file of the gallery's) referred to again, not written. Left as
// they are for a gallery kept in this browser. Resolves whether any was left in this browser for now,
// its folder out of reach (the gallery is then `spilled`), or no longer naming the gallery: asked
// afresh before the first picture is written (a folder swapped by hand for another gallery's a moment
// after a write never takes this one's pictures: F2, S10) — the gallery's own place held (_hold), where
// another app's publication since this library read it stands, read here first so the pictures go on the
// folder's version; one reserved for it by this write (`claimed`), or held by the operation writing
// (`moved`: a move's, an unpack's, its place held as it began), only told as the gallery's.
const OUT_OF_REACH = ['NotFoundError', 'NotAllowedError', 'SecurityError', 'InvalidStateError'];
async function _place(home, slots, w) {
  let left = false, asked = false;
  for (const [obj, key, path, anyPath] of slots) {
    const blob = obj[key];
    if (!home || !(blob instanceof Blob)) continue;
    const known = _fileOf.get(blob);
    // A linked gallery's own picture, in its source in this folder: referred to there, never copied.
    if (known?.ro && known.folder === home.folder) { obj[key] = known; continue; }
    if (!home.root) { left = true; continue; }
    if (known && known.folder === home.folder && known.dir === home.dir && (anyPath || layoutOf(known.$path) === path)) { obj[key] = known; continue; }
    if (!asked) {
      asked = true;
      const ours = home.claimed || home.moved ? await _mayWriteDir(home.folder, home.root, home.dir, home.gid, { fresh: true }).catch(() => false)
        : await _hold(home.gid, { held: w.gid }).then(at => { if (at.kind === 'conflict') _note(home.folder, { reason: 'conflict', path: home.dir, gid: home.gid }).catch(() => {}); return at.kind === 'ok'; });
      if (!ours) {
        home.root = null;
        left = true;
        continue;
      }
    }
    let written;
    try { written = await folderFiles.writeNew(home.folder, home.root, home.dir, path, blob); } catch (e) {
      // A file the failed write may have left there and couldn't delete now retires (deleted once it can
      // be: review 6 F9 b) — a folder reserved for it is undone with it (_discard) — so nothing unrecorded
      // stays in the gallery's folder.
      if (e?.left) await _retireLater(home.folder, home.dir, [e.left]);
      // The folder went out of reach (taken away, or its permission withdrawn): kept here for now.
      if (!OUT_OF_REACH.includes(e?.name)) throw e;
      _grants.delete(home.folder);
      home.root = null;
      left = true;
      continue;
    }
    const ref = { $path: written.path, folder: home.folder, dir: home.dir, size: blob.size, type: blob.type, mtime: written.file.lastModified };
    w.made.push({ folder: home.folder, root: home.root, path: `${home.dir}/${written.path}`, in: home.dir, blob, file: written.file });
    _fileOf.set(written.file, ref);
    _fileOf.set(blob, ref);
    obj[key] = ref;
  }
  return left;
}

// Inside `tx` (which holds GALLERY_STORE): the gallery's stat record told of its folder once named,
// and of pictures left in this browser for now.
function _noteHomeIn(tx, gid, home, left) {
  if (!home || (!home.claimed && !left)) return;
  const store = tx.objectStore(GALLERY_STORE);
  const req = store.get(String(gid));
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) return;
    const next = { ...cur, ..._homeFields(home, left) };
    if (next.folder !== cur.folder || next.dir !== cur.dir || !!next.spilled !== !!cur.spilled) store.put(next);
  };
}

// ── The commit protocol ──
// Every write of a gallery's pictures runs as _writing(gid, fn): `fn(w)` under the gallery's lock
// (folderFiles.withLock shiori:gallery:<gid> — across every tab and the service worker). Its pictures
// are written to the gallery's folder first, each under a name no file has (_place; a folder of its
// own reserved first when it has none: _home); then its records commit, referring to them — `fn` sets
// `w.committed` once its transaction has — and the files they referred to before retire, deleted after
// the gallery's next publication (_unlinkLater). What it wrote (`w.made`) is deleted should its records not commit, or commit without
// them (`w.kept` false: the page went meanwhile, its translation was replaced). So a record never
// refers to bytes another write put there, and no two writes to one gallery interleave (a page stored
// while the gallery moves, two tabs, a page and the service worker). Its records commit only for the gallery it
// began for (`life`, as its caller began: _life; as it is called, by default) — each commit's transaction names the
// write (`tx._write = w`), which the mount check refuses once that gallery has ended (_logIn).
async function _writing(gid, fn, life = null) {
  life ??= await _life(gid);
  return _galleryLocked(gid, async () => {
    const w = { gid: String(gid), life, made: [], kept: true, committed: false };
    try { return await fn(w); } finally { if (!w.committed || !w.kept) await _discard(w.made); }
  });
}
// `fn` while gallery `gid`'s lock is held: a write of its pictures (_writing), its publication (_describe), its place
// followed (_follow), a write of its overlay's source.json (folder-library.js _writeSource), the deletion of its folder
// or overlay (_deletion, _deleteOverlay).
// The website's locks (Web Locks: across the site's tabs and its service worker) are taken in one order, each waited
// for only while those before it, never one after it, are held (S36):
//   shiori:folder-job:<folder> (folder-scan.js: a folder's task) → shiori:folder:<folder> (folder-library.js: its check,
//   its removal, its adding, a PDF drawn into it) → shiori:gallery:<gid> (here: a gallery's work) →
//   shiori:deleting:<folder> (_deletion: a deletion of its galleries' folders) → shiori:removed:<folder> (_publishRemoved:
//   its removed.json); and shiori:dirs:<folder> (folder-store-web.js reserveDir: a new gallery's folder named), within
//   which nothing is waited for.
// A gallery's lock wanted where a later one is held — an overlay's deletion its removal note owes (_publishRemoved) —
// is asked for there and waited for once that one is let go.
// A gallery's lock is never waited for while a gallery's lock is held (S37): work under gallery `held`'s lock that
// reaches work of a gallery (_galleryWork) runs its own gallery's inline, under the lock it holds, and takes another
// gallery's only if it is free at that moment — else that gallery can't be read now ('unreadable', `busy`: nothing
// decided, weighed again at its next publication or check). Every holder says which gallery's lock it holds (`held`,
// its id, or null for none) down to every place that asks for one.
const _galleryLocked = (gid, fn) => folderFiles.withLock(`shiori:gallery:${gid}`, fn);
// `fn` under gallery `gid`'s lock, the caller holding gallery `held`'s (null: none) — by the rule above.
function _galleryWork(gid, held, fn) {
  if (held != null && String(held) === String(gid)) return Promise.resolve().then(fn);
  if (held == null) return _galleryLocked(gid, fn);
  return folderFiles.withLock(`shiori:gallery:${gid}`, fn, { ifFree: true }).catch((e) => {
    if (e?.name !== 'LockBusy') throw e;
    throw Object.assign(new BackendError('unavailable', `gallery ${gid} is busy: it can't be read now`), { reason: 'unreadable', busy: true });
  });
}

// ── Which gallery of an id (S34, review 11; S36) ──
// A gallery deleted — or forgotten with its folder — and made again under its id (an export imported again, a
// download asked again, a backup restored) is another gallery with the same key. Work on a gallery runs under its
// lock (one at a time, across the site's tabs and its service worker: _writing, _describe), but its deletion takes
// no lock, so the work knows which gallery of the id it began for — its life — and asks after its awaits before it
// writes anything by id (_logIn for a write's records; _describe, _described for a publication; _seriesCommand for a
// command over several; folder-library.js _storeAdopted for a check reading one again), ending otherwise. A life is
// told two ways, so that whichever page ended the gallery ends it: in this page, by its deletion or forgetting as it
// commits here (_ended; the library cleared here, _era) — and in any page, the site's tabs and its service worker
// alike, by the mark its stat record was made with (`born`, a field of that record alone: _born), which a gallery
// made again under the id has another of. The mark is asked as the stat record is read where the decision holds —
// in the transaction that commits the work, or under the gallery's lock — never before it.
// A gallery being made has no stat record yet (`born` null): whichever record its making makes is its own — one made
// in another page in that moment, deleted and made again before this page's first write of it, is the limit (plan
// §8). A gallery an earlier version made has a record with no mark ('') — it is the id's while its record has none.
let _ends = 0;                // galleries ended in this page so far
const _endedAt = new Map();   // gid → when the last gallery of that id ended here (its count in _ends)
let _era = 0;                 // the library cleared here, so many times: every gallery ended
// Every gallery as it is now in this page (a command over several, a check: what each is is read since).
const _now = () => ({ at: _ends, era: _era });
// The mark of the gallery whose stat record is `stat`: its `born`, '' for a record an earlier version made, null for none.
const _bornOf = (stat) => (stat ? stat.born ?? '' : null);
// A stat record's mark, made with it: the field a record made where none was takes (`cur`: the record it replaces, read
// in the same transaction — whose mark it keeps, the same gallery written again).
const _born = (cur = null) => (cur ? (cur.born != null ? { born: cur.born } : {}) : { born: _randomId() });
// Gallery `gid`'s life from `began` (_now: as it was then), its stat record read since being `stat`.
const _lifeOf = (began, gid, stat) => ({ gid: String(gid), at: began.at, era: began.era, born: _bornOf(stat) });
// Gallery `gid` as it is now (its life): as this page has it at the call, its mark as its stat record is read.
async function _life(gid) {
  const began = _now();
  return _lifeOf(began, gid, await galleryGet(gid));
}
// Whether gallery life `life` is still the id's, its stat record now being `stat` (as the transaction or the lock the
// decision holds in reads it).
const _still = (life, stat) => life.era === _era && (_endedAt.get(life.gid) ?? 0) <= life.at && (life.born == null || _bornOf(stat) === life.born);
// The same, its stat record read now (a step that writes nothing before its next ask).
const _stillNow = async (life) => _still(life, await galleryGet(life.gid));
const _ended = (gid) => { _endedAt.set(String(gid), ++_ends); };
// What a write made, deleted: its files, and a folder it reserved by name (folderFiles.deleteGalleryIn:
// the files the write put there and those a failed write left there, then what its reservation wrote),
// so the folder names the gallery until every picture in it is gone — one that can't be deleted now
// never leaves a folder of pictures naming no gallery, for a check to add as new. What can't be deleted
// now stays recorded, deleted later (review 6 F9 b): a file, to retire with its gallery's next
// publication; a reserved folder, as a deletion (_owe).
async function _discard(made) {
  const all = made.splice(0).reverse();
  const reserved = all.filter(m => m.dir);
  const inside = (m) => reserved.find(r => r.folder === m.folder && m.path.startsWith(`${r.path}/`));
  for (const m of all) {
    if (m.blob) _fileOf.delete(m.blob);
    if (m.file) _fileOf.delete(m.file);
    if (m.dir) {
      const named = [...all.filter(f => !f.dir && inside(f) === m).map(f => ({ name: f.path.slice(m.path.length + 1), size: f.file?.size, mtime: f.file?.lastModified })),
        ...(await _retiringOf(m.folder, m.path).catch(() => [])).map(r => ({ name: r.path, size: r.size, mtime: r.mtime }))];
      const done = await folderFiles.deleteGalleryIn(m.folder, m.root, m.path, m.gid, named).catch(() => false);
      await (done === true || done === 'missing' ? _forgetRetiring(m.folder, m.path) : _owe(m.folder, m.path, m.gid, named)).catch(() => {});
    } else if (!inside(m)) {
      await folderFiles.removeFile(m.folder, m.root, m.path)
        .catch(() => _retireLater(m.folder, m.in, [{ name: m.path.slice(m.in.length + 1), size: m.file.size, mtime: m.file.lastModified }]));
    }
  }
}
// Files a write left in gallery folder `dir` of folder `folder` that couldn't be deleted now ([{ name,
// size, mtime }], as they were left), noted to retire: deleted, each while it is as noted, by the
// gallery's next publication or the deletion of its folder (_unlinkLater's notes).
const _retireLater = (folder, dir, files) => _recordsWrite((store) => {
  for (const f of files) store.put({ id: `${_retiringPrefix(folder, dir)}${f.name}`, folder, dir, path: f.name, size: f.size, mtime: f.mtime ?? null });
}).catch(() => {});
// Folder `dir` of folder `folder`, reserved for gallery `gid` by a write that didn't commit, and what of
// it couldn't be deleted now (`named`: [{ name, size, mtime }]), recorded for deletion as a deleted
// gallery's folder is (_goneLater: DELETING, beside its files' notes) — deleted by name later
// (_applyDeletions), never read by a check meanwhile, and its name taken by no reservation of this
// library's — `reserved`: only while it is still that reservation (_deleteOne: another app may have made a
// folder for the same gallery at that name since — its unpack of it, say: review 7 B6, S29b's sweep).
const _owe = (folder, dir, gid, named) => _recordsWrite((store) => {
  store.put({ id: _deletingKey(folder, dir), folder, dir, gid: String(gid), reserved: true });
  for (const f of named) store.put({ id: `${_retiringPrefix(folder, dir)}${f.name}`, folder, dir, path: f.name, size: f.size, mtime: f.mtime ?? null });
});

// The files records read in `tx` refer to, put in place of the references once it has completed
// (_loadBlobs lists them): null for one that can't be read (its folder out of reach, or the file gone),
// or what the read asked for instead (`tx._unread`: transferRead's).
async function _withFiles(tx) {
  const list = tx._paths;
  if (!list?.length) return;
  tx._paths = null;
  const unread = tx._unread ?? null;
  let at = 0;
  await Promise.all(Array.from({ length: Math.min(16, list.length) }, async () => {
    while (at < list.length) { const [obj, key, gid] = list[at++]; obj[key] = (await _readPath(obj[key], gid)) ?? unread; }
  }));
}
// File reference `ref` of gallery `gid`'s records read: null when it can't be read, or when the
// gallery's folder doesn't let it be read as the gallery's (_mayReadDir).
async function _readPath(ref, gid) {
  const root = await _readRootOf(ref.folder).catch(() => null);
  if (!root || !(await _mayReadDir(ref, root, gid))) return null;
  const file = ref.zip ? await _readEntry(ref.folder, root, ref.dir, ref.$path, ref.type).catch(() => null)
    : await folderFiles.readFile(ref.folder, root, _joinPath(ref.dir, ref.$path), ref.type || undefined).catch(() => null);
  if (file) _fileOf.set(file, ref);
  return file;
}
const _joinPath = (dir, path) => (dir ? `${dir}/${path}` : path);

// An archive in a library folder, read where it is (zip-read.js): its entries by name, its
// fingerprint and size — its directory read once per version of the file.
const _archives = new Map();   // `${folder}\0${path}` → { at, size, entries, fingerprint }
async function _archiveOf(folder, root, path) {
  const file = await folderFiles.readFile(folder, root, path);
  if (!file) return null;
  const key = `${folder}\0${path}`;
  const hit = _archives.get(key);
  if (hit && hit.at === file.lastModified && hit.size === file.size) return hit;
  const list = await zipEntries(file);
  const out = { at: file.lastModified, size: file.size, entries: new Map(list.map(e => [e.filename, e])), fingerprint: list.fingerprint };
  _archives.set(key, out);
  if (_archives.size > 64) _archives.delete(_archives.keys().next().value);
  return out;
}
// A picture's type, as its name's extension says.
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const _typeOfName = (name) => TYPE_OF_EXT[String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase()] || '';
// Entry `name` of the archive at `path`, as a Blob (a slice of the file for one stored as it is).
async function _readEntry(folder, root, path, name, type) {
  const entry = (await _archiveOf(folder, root, path))?.entries.get(name);
  return entry ? entry.blob(type || _typeOfName(name)) : null;
}
// `tx`'s completion, its records' files read.
const _completed = (tx, value) => _withFiles(tx).then(() => value);

// Files let go in `tx` — unless it only forgets them (`_keepFiles`: a folder removed from the library
// keeps its files) — retire: noted by the same transaction (RETIRING, with the size and modification
// time each was recorded with), and deleted once a publication of their gallery no longer naming them
// has committed (_describe), only while each is still as written (principle 4). A gallery that leaves
// its folder (deleted, or moved out) takes its own folder there too: recorded for deletion by the same
// transaction (DELETING, beside those files of it) and deleted by name once that has committed, through
// the write gate (as `tx._work` may write) — `_goneLater`, `gid` the gallery's (_applyDeletions). A
// linked one (`linked`, its source) leaves a note that its source was removed, written by the same
// transaction (REMOVED_NOTE), so no check of the folder adds it again — its overlay goes once the note
// is in removed.json (_publishRemoved).
const RETIRING = '$retiring:';
const _retiringPrefix = (folder, dir) => `${RETIRING}${folder}\u0000${dir}\u0000`;
function _unlinkLater(tx, key) {
  if (tx._keepFiles) return;
  const [folder, dir, path, size, mtime] = JSON.parse(key.slice('file:'.length));
  tx.objectStore(FOLDER_STORE).put({ id: `${_retiringPrefix(folder, dir)}${path}`, folder, dir, path, size, mtime });
}
// The files of gallery folder `dir` in folder `folder` waiting to retire (_unlinkLater), as `tx` (which
// holds FOLDER_STORE) has them, passed to `found`.
function _retiringIn(tx, folder, dir, found) {
  const prefix = _retiringPrefix(folder, dir);
  const req = tx.objectStore(FOLDER_STORE).getAll(IDBKeyRange.bound(prefix, `${prefix}￿`));
  req.onsuccess = () => found(req.result || []);
}
// A chapter of an archive read in place (`inner`, its folder in it: a series export's) leaves the archive
// as it is — the person's file, never changed for it — with its removal noted for that chapter (a
// REMOVED_NOTE without an overlay, as a linked source's is noted), which every check honours, on both apps
// (review 7 A5); the archive itself is recorded as any archive a gallery leaves, deleted only once no
// gallery is read from it (_ownsDir).
// `made`, a deletion's or a move's: the token the gallery was last published or read at there, and the
// claim's counter its folder was held at (`stamp`, `epoch`: what its place is held at as it is deleted,
// _hold — a deletion made before another app took the folder over that finds a generation that app
// published since is dropped, and a move's old place holding one made since the move read it is kept),
// the linked gallery's removal note's as well (its overlay's deletion: _publishRemoved).
function _goneLater(tx, folder, dir, gid, linked = null, inner = null, made = {}) {
  if (!folder || !dir) return;
  const chapter = inner ? { kind: 'zip', path: dir, inner } : null;
  if (!tx._keepFiles) {
    const store = tx.objectStore(FOLDER_STORE);
    const at = { ...(made.stamp ? { stamp: made.stamp } : {}), ...(made.epoch != null ? { epoch: made.epoch } : {}) };
    store.put(linked ? { id: `${REMOVED_NOTE}${gid}`, folder, dir, gid: String(gid), linked, ...at }
      : { id: _deletingKey(folder, dir), folder, dir, gid: String(gid), ...at });
    if (chapter) store.put({ id: `${REMOVED_NOTE}${gid}`, folder, dir: null, gid: String(gid), linked: chapter });
  }
  _afterFiles(tx).dirs.push({ folder, dir, gid: String(gid), linked });
  if (chapter) _afterFiles(tx).dirs.push({ folder, dir: null, gid: String(gid), linked: chapter });
}
// `tx._unlinked` settles once they are gone (at once for a transaction that didn't commit). `tx._held`: the gallery
// whose lock the transaction's caller holds as it awaits that, where it names no write (_follow).
function _afterFiles(tx) {
  if (!tx._afterFiles) {
    const after = tx._afterFiles = { dirs: [] };
    let done;
    tx._unlinked = new Promise((resolve) => { done = resolve; });
    tx.addEventListener('complete', () => { (tx._keepFiles ? Promise.resolve() : _unlink(after, tx._work, tx._write?.gid ?? tx._held ?? null)).catch(() => {}).then(done); });
    tx.addEventListener('abort', () => done());
  }
  return tx._afterFiles;
}
// `held`: the gallery whose lock the transaction's writer holds, awaiting this (_writing: a move; _follow).
async function _unlink({ dirs }, work, held = null) {
  // The places this transaction let go, only — never another deletion of the folder, which may wait for a gallery's
  // lock its writer holds, awaiting this (a gallery deleted while it is moved: S34). A linked gallery's overlay goes
  // once its note is written, by name with what of it waited to retire (_publishRemoved).
  const own = dirs.filter(d => !d.linked);
  for (const folder of new Set(own.map(d => d.folder))) {
    await _applyDeletions(folder, work, new Set(own.filter(d => d.folder === folder).map(d => _deletingKey(d.folder, d.dir))), held).catch(() => {});
  }
  for (const folder of new Set(dirs.filter(d => d.linked).map(d => d.folder))) await _publishRemoved(folder, work, [], { held });
}

// ── Galleries' folders to delete ──
// A gallery's own folder (or archive) that its deletion, or a move out of it, let go: recorded in the
// folders store by the transaction that let it go (_goneLater) as { id: DELETING + folder \0 dir,
// folder, dir, gid }, beside the files of it waiting to retire there (RETIRING: those the library
// recorded writing), so the intent outlives a page closed or a crash (N2). It is deleted once that
// commits (_applyDeletions), or else as a page opens (foldersPending), at its folder's next check —
// which meanwhile never reads it, nor adds what is left of it as new (N4) — and by its removal, which
// doesn't forget a folder still owed one. One whose folder isn't where it has it (renamed or moved by
// hand before the deletion: F4, S10) is kept, `unfound`, until a look at its folder ends it: a check
// meeting a folder that names its gallery deletes that by name instead of adopting it (_deletedFound);
// one that didn't rules it out, or counts it (`misses`) towards giving it up (_endUnfound), and the
// folder's removal looks for it first, as a check would (folder-library.js _finishUnfound) — never refused for it
// (S42 C: a removal waits only for what is still owed at its place), the record staying while another folder may
// hold the gallery's folder.
const DELETING = '$deleting:';
const _deletingKey = (folder, dir) => `${DELETING}${folder}\u0000${dir}`;
// The folders waiting to be deleted (of folder `folder` alone, when given): [{ id, folder, dir, gid,
// unfound?, misses? }].
async function _deletions(folder = null) {
  const db = await openDB();
  const prefix = folder == null ? DELETING : `${DELETING}${folder}\u0000`;
  return new Promise((resolve, reject) => {
    const req = _tx(db, FOLDER_STORE, 'readonly').objectStore(FOLDER_STORE).getAll(IDBKeyRange.bound(prefix, `${prefix}￿`));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
// What waits to be deleted (of folder `folder` alone, when given) deleted, each while the write gate
// lets this context change its folder (`work` as _rootOf), weighed one context at a time (lock
// shiori:deleting:<folder>) and deleted under its gallery's lock (_deletion): a gallery's folder by name
// (folderFiles.deleteGalleryIn: the files it recorded writing, its descriptions, what names it last, then
// the folders left empty); an archive, or one of its own another library describes it by, whole while it
// is the gallery's (_ownsDir). A record goes, with its files' notes, once that is done, or once the folder
// is found gone, or another's or no one's (nothing deleted then); one that can't be done now stays. What a
// deletion leaves in a gallery's folder — files Shiori didn't make, or changed since it wrote them — stays
// the person's, never joining the library as a gallery of its own: every title a check would find there is
// noted as removed in the folder's removed.json, as it is now (folder-library.js leftBehind), and the folder
// is reported once on its Needs attention list ('left', kept until dismissed) before its record goes.
// Resolves whether none of `folder`'s waits. `only`: those records alone (their ids); `held`: the gallery
// whose lock the caller holds.
async function _applyDeletions(folder = null, work = null, only = null, held = null) {
  for (const d of await _deletions(folder)) {
    if (only && !only.has(d.id)) continue;
    await _deletion(d, { folder: d.folder, dir: d.dir }, work, held);
  }
  return !(await _deletions(folder)).some(d => !d.unfound);
}
// Deletion `d` done at `at` ({ folder, dir }: where its record has it, or where a check met its gallery's folder),
// under its gallery's lock — unless the caller holds that (`held`) — then lock shiori:deleting:<its folder>, in that
// order (the lock order: _galleryLocked), whether or not the id has a gallery again: what is under way for the
// gallery (its publication begun before the deletion) lands first and goes with its folder, and its folder isn't
// written again once deleted (S8; S36 — a deletion waited for its gallery's work only while the id had none). Under
// another gallery's lock (`held`), only while its gallery's lock is free: else it stays recorded, done at the
// folder's next check, its removal, or a page opening (S37). Never rejects.
async function _deletion(d, at, work, held = null) {
  const run = () => folderFiles.withLock(`shiori:deleting:${d.folder}`, () => _deleteOne(d, at, work));
  await _galleryWork(d.gid, held, run).catch(() => {});
}
// Deletion `d` weighed at `dir` of folder `folder`, a place a hand-over's read met naming its gallery: held as the
// deletion recorded it (_hold, S29a's rule 3), nothing deleted. Resolves the answer's kind ('dropped': reported).
async function _deletionHeld(d, folder, dir) {
  const place = { folder, dir, packed: ARCHIVE_NAME.test(dir) ? { inner: '' } : null };
  return (await _hold(d.gid, { stat: place, known: d.stamp ?? null, deletion: { epoch: d.epoch ?? null, forget: (store) => store.delete(d.id) } })).kind;
}
// Deletion `d` done at `at`, under its gallery's lock and lock shiori:deleting:<its folder> (_deletion).
async function _deleteOne(d, at, work) {
  if (!(await _deletions(d.folder)).some(x => x.id === d.id)) return;   // done meanwhile, in another context
  const root = await _rootOf(at.folder, { work }).catch(() => null);
  const named = async () => (await _retiringOf(d.folder, d.dir)).map(r => ({ name: r.path, size: r.size, mtime: r.mtime }));
  const gone = !(await galleryGet(d.gid));
  // Its place held at the token the deletion recorded (_hold, S29a's rule 3): one made before another app
  // took the folder over (its claim held at another counter since), which published the gallery there since
  // (one app changes a folder's galleries at a time), is dropped — that app's version stands, nothing of it is
  // deleted, the folder's next check joins it again, reported once ('changed-both') — and so is one of the
  // place a moved gallery left, should a publication have reached it since. One made since the take-back
  // takes it whatever its folder holds (S25b).
  if (root) {
    const place = { folder: at.folder, dir: at.dir, packed: ARCHIVE_NAME.test(at.dir) ? { inner: '' } : null };
    const held = await _hold(d.gid, { stat: place, known: d.stamp ?? null, deletion: { epoch: d.epoch ?? null, forget: (store) => store.delete(d.id) } });
    if (held.kind === 'dropped') return;
  }
  // A reservation of this library's cut short (`reserved`: _owe) is deleted only while it is one: a folder
  // there naming the gallery at a generation past its reservation's is the gallery's — made since, by
  // another app (its unpack of it), never this library's to delete — and the record goes, nothing deleted.
  if (root && d.reserved) {
    const there = await folderFiles.manifestIn(at.folder, root, at.dir, d.gid);
    if (there.kind === 'unreadable') return;
    if (there.kind === 'ok' && published(tokenOf(there.value))) {
      await _forgetRetiring(d.folder, d.dir);
      await _recordsWrite((store) => store.delete(d.id));
      return;
    }
  }
  const done = root && await _deleteDir(at.folder, root, at.dir, d.gid, named, at.dir !== d.dir ? ARCHIVE_NAME.test(d.dir) : null);
  if (!done) return;
  // Gone for a gallery still in the library — the place it left (an archive it was unpacked from, whose
  // other app may have deleted it first: review 7 B6) — is done: only a deleted gallery's is looked for.
  if (done === 'missing' && gone) {
    if (!d.unfound) await _recordsWrite((store) => store.put({ ...d, unfound: true }));
    return;
  }
  if (done === 'left') {
    const titles = await _folderLibrary.leftBehind(at.folder, root, at.dir);
    if (titles.length && !await _publishRemoved(at.folder, work, titles, { held: String(d.gid) })) return;
    await _note(at.folder, { reason: 'left', path: at.dir, gid: d.gid }, { event: true });
    platform.control.send({ type: 'FOLDERS_CHANGED' });
  }
  await _forgetRetiring(d.folder, d.dir);
  await _recordsWrite((store) => store.delete(d.id));
}
// Deletion `d`, its gallery's folder not where its record has it, finished at `dir` in folder `folder`,
// where a check met a folder naming its gallery (F4): deleted as it would have been where it was.
const _deletedFound = (d, folder, dir, work = null) => _deletion(d, { folder, dir }, work);
// What waited `unfound` in folder `folder` once a look at it ended (a check, or its removal's:
// folder-library.js _finishUnfound), as folder-lifecycle.js unfoundEnd weighs each: those it met (`met`:
// their ids) kept until they are done where it met them; the rest forgotten when it ruled them out
// (`whole`), else counted (`misses`, kept with the deletion), and given up after a few such looks (review
// 7 A1).
// Every deletion waiting `unfound` is weighed at every folder's look (S41): another folder's whole look that didn't
// meet it rules that folder out (`ruled`, kept with the deletion: a field of its record, written only when it changes),
// and it is given up only once its own folder and every other it may still be in ruled it out — which those are is told
// without a call on any of them (_unfoundMayBeIn, S42 B), and only when one waits so.
// A folder's removal looks as a check does (folder-library.js _finishUnfound) and rules its own folder out as its whole
// look does, and no more (S42 C; S41's removal gave its own folder's deletions up by that look alone, and a deleted
// gallery moved by hand into another folder came back at that folder's check): one every other folder it may be in
// ruled out is forgotten, any other stays recorded — the removal doesn't wait for it, its folder leaves the library —
// and is weighed by the other folders' looks, its own folder counted only while it is the library's.
async function _endUnfound(folder, met, whole) {
  const waiting = (await _deletions()).filter(d => d.unfound);
  if (!waiting.length) return;
  const need = await _unfoundMayBeIn();
  const { byId, removing } = await _folders();
  for (const d of waiting) {
    const own = d.folder === folder;
    const mine = byId.has(d.folder) || removing.has(d.folder) ? [d.folder] : [];
    const end = unfoundEnd({ met: met.has(d.id), whole, misses: d.misses, own, at: folder, ruledOut: d.ruled ?? [], need: [...new Set([...mine, ...need])] });
    if (end === 'keep') continue;
    if (end === 'forget') {
      await _forgetRetiring(d.folder, d.dir);
      await _recordsWrite((store) => store.delete(d.id));
    } else {
      await _recordsWrite((store) => {
        const now = store.get(d.id);   // as it is now: one done meanwhile stays done
        now.onsuccess = () => { if (now.result?.unfound) store.put({ ...now.result, ...(typeof end === 'number' ? { misses: end } : { ruled: end.ruledOut }) }); };
      });
    }
  }
}
// The library folders a deletion not found may still be in (folder-lifecycle.js unfoundMayBeIn), told from what the
// library already knows of each — its record, the last claim read of it (_heldElsewhere, nothing read again), its
// permission as the browser says it without a read, which folder its handle was last found to reach (_reached) — with
// no call on any folder (S42 B: a look at one folder never waits on another's drive; before, each shown folder's
// library.json was read at the end of every check).
async function _unfoundMayBeIn() {
  const out = [];
  for (const f of (await _folders()).byId.values()) {
    const permission = await folderFiles.permission(f.handle, { look: false }).catch(() => 'unavailable');
    if (unfoundMayBeIn({ state: f.state, taken: _heldElsewhere(f.id, { read: false }), permission, reach: _reached.get(f.id) ?? null })) out.push(String(f.id));
  }
  return out;
}
// Gallery `gid`'s own folder `dir` (in folder `folder`, its handle `root`) deleted: an archive whole
// while it is the gallery's (_ownsDir) and holds nothing but what Shiori put there (_archiveOnlyOwn); a
// folder by name (folderFiles.deleteGalleryIn, `named()` the files the library recorded writing there:
// all of it while it names the gallery, those files alone while it names none). `archived`: where a
// check met it in place of the one its deletion recorded, whether that was an archive — met at the other
// kind of place (the other app archived the gallery's folder, or unpacked its archive: D17), whose files
// the library never recorded, it is deleted by that place's own manifest alone (gallery-manifest.js
// galleryDeletion, foreignEntries `met`). Resolves whether that is done ('left': something was left
// there — an archive the person added to stays whole, F6; 'missing': nothing there; false: something
// there couldn't be read or deleted now, or told).
async function _deleteDir(folder, root, dir, gid, named, archived = null) {
  const file = await folderFiles.readFile(folder, root, dir).catch(() => undefined);
  if (file === undefined) return false;
  const met = archived != null && archived !== !!file;
  if (!file) return folderFiles.deleteGalleryIn(folder, root, dir, gid, met ? null : await named());
  const owns = await _ownsDir(folder, root, dir, gid);
  if (owns == null) return false;
  if (!owns) return true;
  const only = await _archiveOnlyOwn(folder, root, dir, met);
  if (only == null) return false;
  if (!only) return 'left';
  await folderFiles.removeFile(folder, root, dir);
  return true;
}
// The files of gallery folder `dir` in folder `folder` waiting to retire (_unlinkLater), as stored.
async function _retiringOf(folder, dir) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, FOLDER_STORE, 'readonly');
    _retiringIn(tx, folder, dir, resolve);
    tx.onerror = () => reject(_txError(tx));
  });
}
// Folder `folder` forgotten: what waited to be deleted there stays.
// (One waiting `unfound` stays: the gallery's folder may be in another library folder, whose looks weigh it — S42 C.)
const _forgetDeletions = (folder) => _recordsWrite((store) => {
  const q = store.getAll(IDBKeyRange.bound(`${DELETING}${folder}\u0000`, `${DELETING}${folder}\u0000￿`));
  q.onsuccess = () => { for (const d of q.result || []) if (!d.unfound) store.delete(d.id); };
});
// The notes of files of gallery folder `dir` (in folder `folder`; every gallery folder's there, with no
// `dir`: the folder forgotten) waiting to retire, forgotten (only those of `paths`, when given).
async function _forgetRetiring(folder, dir = null, paths = null) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = _tx(db, FOLDER_STORE, 'readwrite');
    const prefix = dir == null ? `${RETIRING}${folder}\u0000` : _retiringPrefix(folder, dir);
    if (paths) for (const p of paths) tx.objectStore(FOLDER_STORE).delete(`${prefix}${p}`);
    else tx.objectStore(FOLDER_STORE).delete(IDBKeyRange.bound(prefix, `${prefix}￿`));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
}

// ── Needs attention (D15) ──
// What a folder's "Needs attention" list shows, in the folders store as { id: ATTENTION + folder \0
// reason \0 path, folder, reason, path (in the folder), gid?, event?, at }: what its last check found
// (_noteChecked: in place of what the one before found) and what happened once (`event`: a publication
// over another app's newer one), which stays until it is dismissed.
const ATTENTION = '$attention:';
const _attentionPrefix = (folder) => `${ATTENTION}${folder}\u0000`;
// `fn(store)` on the folders store in a transaction of its own, telling the windows nothing (unlike
// _folderWrite): for the records kept beside the folders (these, the deletions waiting).
async function _recordsWrite(fn) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = _tx(db, FOLDER_STORE, 'readwrite');
    fn(tx.objectStore(FOLDER_STORE));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
}
const _attentionRecord = (folder, { reason, path = '', gid = null }, event) => ({ id: `${_attentionPrefix(folder)}${reason}\u0000${path}`, folder,
  reason: String(reason), path: String(path), ...(gid != null ? { gid: String(gid) } : {}), ...(event ? { event: true } : {}), at: Date.now() });
// Something about folder `folder` to show there ({ reason, path, gid? }; `event`: kept by later checks).
async function _note(folder, problem, { event = false } = {}) {
  await _recordsWrite((store) => store.put(_attentionRecord(folder, problem, event))).catch(() => {});
}
// The same for what happened once, inside `tx` (which holds FOLDER_STORE): noted with the change itself.
const _noteIn = (tx, folder, problem) => tx.objectStore(FOLDER_STORE).put(_attentionRecord(folder, problem, true));
// What folder `folder`'s check found (`problems`), in place of what its last one found.
async function _noteChecked(folder, problems) {
  const all = await _attentionOf(folder, { records: true });
  await _recordsWrite((store) => {
    for (const r of all) if (!r.event) store.delete(r.id);
    for (const p of problems) store.put(_attentionRecord(folder, p, false));
  });
}
// Folder `folder`'s list: [{ reason, path, gid? }], oldest first (`records`: as stored).
async function _attentionOf(folder, { records = false } = {}) {
  const db = await openDB();
  const found = await new Promise((resolve, reject) => {
    const prefix = _attentionPrefix(folder);
    const req = _tx(db, FOLDER_STORE, 'readonly').objectStore(FOLDER_STORE).getAll(IDBKeyRange.bound(prefix, `${prefix}￿`));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  found.sort((a, b) => a.at - b.at);
  return records ? found : found.map(r => ({ reason: r.reason, path: r.path, ...(r.gid ? { gid: r.gid } : {}) }));
}
// An item of folder `folder`'s list put away (a check that finds it again shows it again).
async function _dismiss(folder, { reason, path = '' }) {
  await _recordsWrite((store) => store.delete(`${_attentionPrefix(folder)}${reason}\u0000${path}`));
}
// Every item of folder `folder`'s, gone with it (the folder forgotten).
const _forgetAttention = (folder) => _recordsWrite((store) => store.delete(IDBKeyRange.bound(_attentionPrefix(folder), `${_attentionPrefix(folder)}￿`)));

// ── Notes of removed sources (linked-source.js removed.json) ──
// A linked gallery's source that left its folder (the gallery deleted, or moved to another place as
// the library's own) is noted by the transaction letting it go, in the folders store — which every
// write transaction holds — as { id: REMOVED_NOTE + gid, folder, dir (its overlay), gid, linked (the
// source) }, and counted as removed by every check of the folder (folder-library.js) until it is in
// the folder's removed.json (F12). A chapter that left an archive read in place is noted alike, `linked`
// the chapter ({ kind: 'zip', path, inner }) and no overlay (`dir` null: _goneLater).
const REMOVED_NOTE = '$removed:';
// The notes still owed to folder `id` (to every folder: no `id`).
async function _removedNotes(id = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = _tx(db, FOLDER_STORE, 'readonly').objectStore(FOLDER_STORE).getAll(IDBKeyRange.bound(REMOVED_NOTE, `${REMOVED_NOTE}~`));   // a gallery's id sorts below '~'
    req.onsuccess = () => resolve((req.result || []).filter(n => id == null || n.folder === id));
    req.onerror = () => reject(req.error);
  });
}
// The notes owed to folder `id` written to its removed.json, then cleared and the overlays they stand
// for deleted — read, changed and written while lock shiori:removed:<folder> is held, so notes made at
// once (two deletes, two tabs, the service worker) all stay — through the write gate (`work` as
// _rootOf). A note is cleared only once it is written; one that can't be now (the folder may not be
// written to, its list can't be read) waits: tried again as a page opens (foldersPending), at the
// folder's next check, and by its removal, which doesn't forget a folder still owed one. Each note
// carries its source's fingerprint as its files are now (folder-library.js fingerprintNow), not as the
// index last had it: a source changed in place and removed before a check noticed is removed all the
// same (N3). `also`: sources noted with them, as they are (what a deletion left: _applyDeletions). A
// linked gallery's deletion made before another app took the folder over, which published its overlay
// there since, is dropped (_hold, S29a's rule 3): its source isn't noted removed, its overlay stays, and the
// gallery joins again as the folder has it — reported once. One moved out (still in the library) is noted
// whatever: its overlay is weighed as it goes (_deleteOverlay). Each overlay goes once what is under way for its
// gallery is over (_deleteOverlay: under the gallery's lock), waited for once this lock is let go — a gallery's lock
// may be held by a move awaiting this one (_unlink). A caller holding a gallery's lock (`held`: a move of it out of
// the folder, the deletion of its folder) writes that gallery's notes alone, its overlay deleted under the lock it
// holds: no other gallery's lock is waited for under it (S37) — the others are written by the work that noted them
// (its own _unlink), or else by the folder's next check, its removal or a page opening. Resolves whether it wrote
// every note it was to write.
async function _publishRemoved(id, work = null, also = [], { held = null } = {}) {
  const going = [];
  const owed = async () => (await _removedNotes(id)).filter(n => held == null || String(n.gid) === String(held));
  const written = await folderFiles.withLock(`shiori:removed:${id}`, async () => {
    const notes = [];
    for (const n of await owed()) {
      if (n.dir && !(await galleryGet(n.gid))) {
        const held = await _hold(n.gid, { stat: { folder: id, dir: n.dir }, known: n.stamp ?? null, deletion: { epoch: n.epoch ?? null, forget: (store) => store.delete(n.id) } });
        if (held.kind === 'dropped') continue;
      }
      notes.push(n);
    }
    if (!notes.length && !also.length) return !(await owed()).length;
    const root = await _rootOf(id, { work }).catch(() => null);
    if (!root) return false;
    try {
      let list = parseRemoved(await folderFiles.readText(id, root, REMOVED_FILE));
      const now = async (s) => ({ ...s, fingerprint: await _folderLibrary.fingerprintNow(id, root, s) ?? s.fingerprint ?? null });
      for (const source of [...await Promise.all(notes.map(n => now(n.linked))), ...also]) list = withRemoved(list, source);
      await folderFiles.writeFile(id, root, REMOVED_FILE, removedText(list));
    } catch { return false; }
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = _tx(db, FOLDER_STORE, 'readwrite');
      for (const n of notes) tx.objectStore(FOLDER_STORE).delete(n.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(_txError(tx));
    });
    for (const n of notes) if (n.dir) going.push({ gid: String(n.gid), gone: _deleteOverlay(id, n.dir, n.gid, n, work, held) });
    return true;
  }).catch(() => false);
  await Promise.all(going.map(o => o.gone));
  return written;
}
// Linked gallery `gid`'s overlay `dir` in folder `id` deleted by name (folderFiles.deleteGalleryIn:
// the files the library recorded writing there — what of it waited to retire — and those its manifest
// names, its descriptions and its source.json while they name it), then those records forgotten — its
// place held as its removal note recorded it (`note`: { stamp, epoch }; _hold, S29a's rule 3): one holding
// a publication made since — another app's, after the gallery was let go here — stays, reported. Done under the
// gallery's lock, unless the caller holds it (`held`), and through the write gate as it is then (`work` as _rootOf):
// what was under way there for the gallery the note is of — a check writing its source.json, a publication, a picture
// — lands first and goes with it, and none comes after it (each asks under that lock whether its gallery is still the
// id's: S35). Never rejects.
function _deleteOverlay(id, dir, gid, note, work = null, held = null) {
  const run = async () => {
    const root = await _rootOf(id, { work }).catch(() => null);
    if (!root) return;
    const kept = await _hold(gid, { stat: { folder: id, dir }, known: note.stamp ?? null, deletion: { epoch: note.epoch ?? null, forget: () => {} } });
    if (kept.kind === 'dropped') return;
    const named = (await _retiringOf(id, dir).catch(() => [])).map(r => ({ name: r.path, size: r.size, mtime: r.mtime }));
    await folderFiles.deleteGalleryIn(id, root, dir, gid, named).catch(() => {});
    await _forgetRetiring(id, dir).catch(() => {});
  };
  return _galleryWork(gid, held, run).catch(() => {});
}

// ── A gallery's publication in its folder ──
// What a gallery's folder holds of it (format v2, storage/gallery-manifest.js): its saved state, one
// generation, committed by one atomic write of its manifest, which names every picture's file and its
// descriptions (stored by their content), and the descriptions under their usual names (metadata.json,
// image_records.json…) for people, other tools and older versions. A change to a gallery kept in a
// folder marks it in its own transaction (UNDESCRIBED_STORE, _logIn) — committed — and is published a
// moment after the gallery last changed (D12: about 5 s; at once every PUBLISH_EVERY changes) —
// published; publishing it clears the mark only when no change came since. The stat record keeps the
// token of the generation last published or read here (`stamp`, gallery-manifest.js tokenOf; a v1
// folder's, its descriptions' stamp): a check of the folder tells by it whether another app published
// one since (folderScan reads such a gallery again, D4).
const DESCRIPTIONS = DESCRIPTION_FILES;
const DESCRIBE_AFTER_MS = 5000;
const PUBLISH_EVERY = 20;
// The publication of changes committed before a folder was hidden carries on there (folder-lifecycle.js
// writeAllowed 'publish', plan §3.4): the folder work a publication runs as, any folder's.
const PUBLISHING = { kind: 'publish', folder: '*' };
const _describeTimers = new Map();
const _changesSince = new Map();   // gid → changes since its last publication
function _describeSoon(gid) {
  const id = String(gid);
  clearTimeout(_describeTimers.get(id));
  const n = (_changesSince.get(id) || 0) + 1;
  _changesSince.set(id, n);
  _describeTimers.set(id, setTimeout(() => { _describeTimers.delete(id); _describe(id).catch(() => {}); }, n >= PUBLISH_EVERY ? 0 : DESCRIBE_AFTER_MS));
}
// Gallery `gid`'s publication due in a moment let go of (its caller publishes it now).
function _cancelDescribe(gid) {
  clearTimeout(_describeTimers.get(gid));
  _describeTimers.delete(gid);
}
// Gallery `gid` as this library holds it, read in one transaction with its mark, for its publication:
// { stat, wanted: Map name → its descriptions' text (a description it has none of is missing), next
// (its next generation's manifest but the descriptions, gallery-manifest.js: every slot's file, the
// size and time each was recorded written with, a linked page's source picture), rev (its mark's: the
// revision of its last change not published yet; null: none), retiring (its files waiting to retire,
// _unlinkLater) }, or null for a gallery kept in no folder of its own. The descriptions name the file
// each picture is in where it isn't the layout name, and a linked gallery's page the source picture it
// shows (gallery-files.js galleryFiles `fileOf`, `sourceOf`).
const _sourcePicture = (rec) => (_isPath(rec.blob) && rec.blob.ro
  ? provenanceOf({ name: rec.blob.$path, size: rec.blob.size, crc: rec.blob.crc, mtime: rec.blob.mtime }) : null);
async function _wantedDescriptions(gid) {
  const db = await openDB();
  const read = await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, UNDESCRIBED_STORE, FOLDER_STORE], 'readonly');
    const stat = tx.objectStore(GALLERY_STORE).get(gid);
    const meta = tx.objectStore(META_STORE).get(gid);
    const pages = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    const cover = tx.objectStore(COVER_STORE).get(gid);
    const mark = tx.objectStore(UNDESCRIBED_STORE).get(gid);
    let retiring = [];
    stat.onsuccess = () => { if (stat.result?.folder && stat.result.dir) _retiringIn(tx, stat.result.folder, stat.result.dir, (found) => { retiring = found; }); };
    tx.oncomplete = () => resolve({ stat: stat.result, meta: meta.result, pages: pages.result || [], cover: cover.result, rev: mark.result?.rev ?? null, retiring });
    tx.onerror = () => reject(_txError(tx));
  });
  const { stat } = read;
  if (!stat?.folder || !stat.dir || !read.meta) return null;
  return { stat, ...await _generationOf(gid, stat, read.meta, _numbered(read.pages), read.cover), rev: read.rev, retiring: read.retiring };
}
// Gallery `gid`'s next generation in its folder (`stat`: its stat record, with its place — folder and dir —
// and the token it was last published or read at), from its metadata, page records (numbered) and cover
// record as they are: { wanted (its descriptions by name), next (its manifest but the descriptions) } —
// naming every picture its records refer to in that folder, with the size and time each was written with.
async function _generationOf(gid, stat, meta, records, cover) {
  const decode = new TextDecoder();
  const fileOf = (src) => (_isPath(src) && !src.ro && src.folder === stat.folder && src.dir === stat.dir ? src.$path : null);
  const covers = { gallery: cover?.cover, series: cover?.seriesCover };
  const wanted = new Map(galleryFiles({ meta, records, covers }, '', { fileOf, sourceOf: _sourcePicture })
    .filter(f => DESCRIPTIONS.includes(f.name)).map(f => [f.name, decode.decode(f.source)]));
  const sizes = {}, sources = {};
  for (const rec of records) {
    for (const [obj, key] of PAGE.slots(rec)) { const v = obj[key]; if (fileOf(v)) sizes[v.$path] = [v.size ?? 0, v.mtime ?? 0]; }
    const source = _sourcePicture(rec);
    if (source && rec.pageNum != null) sources[rec.pageNum] = source;
  }
  for (const v of [covers.gallery, covers.series]) if (fileOf(v)) sizes[v.$path] = [v.size ?? 0, v.mtime ?? 0];
  const next = { format: 'shiori-gallery', version: 2, galleryId: String(gid), generation: generationOf(stat.stamp) + 1, writer: await _me(),
    files: slotFiles({ records, covers }, fileOf), sizes, ...(Object.keys(sources).length ? { sources } : {}) };
  return { wanted, next };
}
const _textsOf = (wanted) => Object.fromEntries(DESCRIPTIONS.map(name => [name, wanted.get(name) ?? null]));
// Gallery `gid` published in its folder, under the gallery's lock (no write of its pictures
// interleaves), through the folder store (storage/folder-store-web.js: the folder opened to publish —
// or for `work`, a removal's own write-back — and the gallery's directory there): its generation
// committed by one manifest written whole, then — in one transaction — its mark cleared if no change
// came since it was read (a later one is published next time) and the token it was published at kept;
// then the files that waited for this publication retire, each deleted only while still as written
// (a note stays only for one that couldn't be deleted now). Resolves { ok }: whether its folder now has
// what the library has of it — not when it is kept in no folder of its own, nor in one this context may
// not write to (the gate): its mark stays, for settleFolders or the removal. A gallery with nothing
// waiting (a removal's write-back) whose folder has a generation already writes nothing (another app's
// since is read by a check, D4), nor one whose folder never held one this library knew of
// (gallery-manifest.js nothingToWrite: an earlier version's folder, a linked gallery's overlay not described
// yet). A gallery kept in an archive (`packed`) is described there as it was read until it changes;
// changed, it is unpacked first (_unpackLocked), then published in its folder. Its place is held first
// (_hold; through the folder store, its Root.gallery, for the publication itself): another app's
// publication there since this library read it stands — what waited here for it dropped, reported — and
// nothing of this library's is published over it, nor unpacked out of its archive.
async function _describe(gid, { work = null } = {}) {
  const as = work ?? PUBLISHING;
  const life = await _life(gid);
  return _galleryLocked(gid, async () => {
    _cancelDescribe(String(gid));   // this publication is that one: a change from now on asks for the next
    let read = await _wantedDescriptions(gid);
    if (read?.stat.packed && read.rev == null) return { ok: true };   // its archive describes it as read
    const root = read && await _rootOf(read.stat.folder, { work: as });
    // Its series command weighed as one first (S32) — with nothing waiting, it is of none (a publication's transaction
    // ungroups the gallery it clears, as a stand's does).
    const weighed = !root ? null : read.rev != null ? await _weighGroup(gid) : { go: true, grp: null, how: 'none' };
    if (weighed && !weighed.go) return { ok: false };
    if (root && read.stat.packed) {
      if ((await _hold(gid, { held: String(gid) })).kind !== 'ok') return { ok: false };
      read = await _wantedDescriptions(gid);
      if (read?.stat.packed && read.rev == null) return { ok: true };   // what waited dropped: the archive's version stands
      if (read?.stat.packed) await _unpackLocked(gid, as);
      read = await _wantedDescriptions(gid);
      if (!read || read.stat.packed) return { ok: false };
    }
    if (!root || !(await _mayWriteDir(read.stat.folder, root, read.stat.dir, gid))) return { ok: false };
    const opened = await folderStore.open({ id: read.stat.folder, location: root }, { purpose: as.kind === 'removal' ? 'removal' : 'publish' });
    if (opened.status !== 'ok') return { ok: false };
    const place = read.stat;
    const found = await _hold(gid, { stat: place, ask: (view) => opened.root.gallery(place.dir, gid, view), held: String(gid) });
    if (found.kind === 'conflict') await _note(place.folder, { reason: 'conflict', path: place.dir, gid: String(gid) });
    if (found.kind !== 'ok') return { ok: false };
    // As it now is (what waited dropped, where the folder's version stood) — and only the gallery it began for, at
    // the place it held: one deleted meanwhile isn't, nor a gallery of the id made again since — kept elsewhere (a
    // check joined a copy of it: S34, review 11 A2) or nowhere yet — and nothing of either is published here.
    read = await _wantedDescriptions(gid);
    if (!read || !_still(life, read.stat) || !_samePlace(read.stat, place)) return { ok: false };
    // And only for the command it weighed (S42 A), its group read after what it publishes: a series command made since
    // its weighing is none of this publication's — nothing of it published here, the gallery asked again (its next
    // publication weighs it). Only now, its own place held 'ok', is its command taken as weighed whole (S41 A).
    if (!(await _weighedStill(gid, weighed))) { _describeSoon(gid); return { ok: false }; }
    await _groupWeighed(gid, weighed);
    const { stat, wanted, next, rev, retiring } = read;
    if (rev == null && nothingToWrite(stat.stamp, (await found.dir.manifest()).kind)) return { ok: true };
    const { token } = await found.dir.publish({ manifest: next, descriptions: _textsOf(wanted) });
    if (!(await _described(gid, rev, token, place, life))) return { ok: false };
    _changesSince.delete(String(gid));
    if (retiring.length) {
      // Never a file the generation just published names: a failed write's leftover is noted without its
      // time (_retireLater), and its name may hold a picture of the gallery's by now, of the same size.
      const { kept } = await found.dir.deleteNamed(retiring.filter(n => !(n.path in next.sizes)).map(n => ({ name: n.path, size: n.size, mtime: n.mtime })));
      const again = new Set(kept.filter(k => k.why === 'unreadable').map(k => k.name));
      for (const k of kept) if (k.why === 'changed') console.warn(`[shiori] ${stat.dir}/${k.name} changed since Shiori wrote it: left as it is`);
      await _forgetRetiring(stat.folder, stat.dir, retiring.map(n => n.path).filter(p => !again.has(p))).catch(() => {});
    }
    return { ok: true };
  });
}
// ── A gallery's place held (S31) ──
// Gallery `gid`'s place held for a change there: the gateway every operation that writes into, moves, unpacks
// or deletes at a gallery's place passes first (and a check meeting another publication of a gallery with
// something waiting here), the only caller of the adapter's folderFiles.placeIn — where whose version the place
// holds is weighed (gallery-manifest.js whoseVersion). `stat`: where the gallery is (its stat record's place,
// its own by default: { folder, dir, packed, stamp }); `known`: this library's stamp of it (`stat.stamp`);
// `ask(view)`: how the place is asked — placeIn by default, a publication's through the folder store contract
// (its Root.gallery). Where another publication is there — another app's since this library last read it, or
// any where it has no stamp — the folder's version stands (_stands): what waited here for the gallery is dropped
// and reported once, or, nothing of it waiting, it is read again from there, nothing reported — and the place
// is held again, so the operation goes on from the folder's version. One read there and found damaged
// ('corrupt', 'missing-file') is no version to stand (T08): held over it (`over`; `damaged` its reason, for a
// check to report), what waits is published over it. Resolves the answer — 'ok' (with `place`, or through the contract its `dir`), 'missing', 'conflict',
// 'unreadable' — 'unreadable' too where the folder can't be read now (out of reach, its version unreadable):
// nothing is decided, the operation waits or is refused, and is tried again. `deletion`: the place is to be
// deleted — a deletion's record, a linked gallery's overlay its removal note owes ({ epoch: the claim's counter
// its folder was held at as it was made, null for one recorded before S29a; forget(store): its record dropped,
// in the transaction that reports it}). That is S29a's rule 3: one made before another app took the folder over
// that meets a publication made there since is dropped ('dropped': nothing deleted, reported once, the gallery
// joins again as the folder has it); one made since the take-back takes the gallery whatever its place holds;
// and a place a gallery left (a move's old folder or archive: the gallery still in the library) that holds a
// publication made since the move read it is never deleted ('dropped'). A gallery its series command's drop left to
// stand (S37, _groupDropped: the command's other gallery couldn't be read again as the first stood) stands by the
// folder's version here first, whatever its place holds — or, with no version there to stand by, is settled (S38).
// `held`: the gallery whose lock the caller holds — its own (its write, publication or move), another's (a publication
// weighing its series command), or null for none (a check, a deletion's weighing) — under which the folder's version
// is read (_galleryWork: a linked gallery's re-read writes its overlay's source.json —
// inline under its own lock, under another's only while its own is free); `handover`: asked by a hand-over's read,
// which writes nothing in the folder (S37: the re-read's own read writes nothing either).
async function _hold(gid, { stat = null, known, deletion = null, ask = null, held = null, handover = false } = {}) {
  const id = String(gid);
  const at = stat ?? await galleryGet(id);
  if (!at?.folder || !at.dir) return MISSING;
  const root = await _readRootOf(at.folder).catch(() => null);
  if (!root) return unreadable(new Error(`library folder ${at.folder} can't be read now`));
  const archive = at.packed ? { read: () => _archiveManifest(at.folder, root, at.dir, at.packed.inner || '') } : null;
  const asked = ask ?? (async (view) => folderFiles.placeIn(at.folder, root, at.dir, id, { ...view, writer: await _me(), archive }));
  const stamp = async () => (await galleryGet(id))?.stamp ?? null;
  const first = await asked({ known: known === undefined ? at.stamp ?? null : known });
  const left = !deletion && first.kind === 'ok' && await _groupDropped(id);
  if (first.kind !== 'theirs' && !left) return first;
  if (deletion) {
    const before = deletion.epoch != null && deletion.epoch !== (await _folderById(at.folder))?.epoch;
    if (!before && !(await galleryGet(id))) return { ...first, kind: 'ok' };   // the person's, since the take-back
    await _recordsWrite((store) => { deletion.forget(store); store.put(_attentionRecord(at.folder, { reason: 'changed-both', path: at.dir, gid: id }, true)); });
    return { kind: 'dropped' };
  }
  // What the first look saw (S40): a manifest at the place, whoever's (`seen`), and whether another writer's (`theirs`).
  // (Asked through the folder store contract — a publication — the answer carries the token itself: S41.)
  const look = { seen: first.kind === 'theirs' || first.place?.token != null || first.token != null, theirs: first.kind === 'theirs' };
  const stood = await _stands(id, held, handover, look).catch(() => false);
  if (stood?.damaged) return { ...await asked({ known: await stamp(), over: first.token }), damaged: stood.damaged };
  const again = stood ? await asked({ known: await stamp() }) : null;
  return again && again.kind !== 'theirs' ? again : unreadable(new Error(`the folder's version of gallery ${id} can't be read now`));
}
// ── A series command weighed as one (S32, review 9 B1) ──
// The galleries one series command changed ('$group:<gid>': { gid, grp }) are weighed as one before any is
// published (_weighGroup); folder-library.js folderStands drops the rest with one. Left once published or deleted.
const GROUP = '$group:';
const GROUP_WEIGHED_MS = 2000;   // a group weighed whole is taken as it is this long
const _weighedGroups = new Map();   // group → when it was last weighed whole
// Inside the command's transaction: `gids` one group, merged with any group one of them is in — a gallery its
// group's drop left to stand keeps that (`drop`).
function _groupIn(tx, gids) {
  const ids = [...new Set(gids.map(String))];
  if (ids.length < 2) return;
  const store = tx.objectStore(FOLDER_STORE);
  const all = store.getAll(IDBKeyRange.bound(GROUP, `${GROUP}￿`));
  all.onsuccess = () => {
    const had = new Map((all.result || []).map(r => [r.gid, r]));
    const old = new Set((all.result || []).filter(r => ids.includes(r.gid)).map(r => r.grp));
    const grp = _randomId();
    for (const gid of new Set([...ids, ...(all.result || []).filter(r => old.has(r.grp)).map(r => r.gid)])) {
      store.put({ id: `${GROUP}${gid}`, gid, grp, ...(had.get(gid)?.drop ? { drop: true } : {}) });
    }
  };
}
// A series command's drop is whole (S37). Where one gallery of a group stands by the folder's version, the rest of
// the group waiting stand with it (folder-library.js folderStands, its others); one that can't be read again then (its
// place unreadable for a moment, its lock busy) is left to stand: its group's record says so (`drop`), written in the
// transaction that drops the first one's — so it is never published with its part of the command. It stands by the
// folder's version under its own lock before anything of it is published, moved or written at its place (_hold), at its
// next publication — due a moment later (_describeSoon) — or the folder's next check (folder-library.js _catchUp holds
// every gallery left so); its record goes with it. One whose place holds no version to stand by is settled instead
// (S38: folder-library.js folderStands, gallery-manifest.js dropBasis) — never left to stand for good.
// Galleries `gids` of the group of gallery `first` (the one whose drop this is) left to stand, in the folders store
// `store` — inside `tx` (_groupDropIn), or in a transaction of its own where the first one couldn't be read again itself
// (its lock busy: _groupDrop). Only one still of that group as the transaction reads it (S38): one published since and
// grouped again by a new command is that command's, not left to stand for this one (a group merged by a later command
// is the first one's still, and stands with it).
function _dropIn(store, gids, first) {
  const at = store.get(`${GROUP}${first}`);
  at.onsuccess = () => {
    const grp = at.result?.grp;
    if (!grp) return;
    for (const gid of new Set(gids.map(String))) {
      const req = store.get(`${GROUP}${gid}`);
      req.onsuccess = () => { if (req.result?.grp === grp && !req.result.drop) store.put({ ...req.result, drop: true }); };
    }
  };
}
const _groupDropIn = (tx, gids, first) => _dropIn(tx.objectStore(FOLDER_STORE), gids, first);
// Inside `tx`: whether gallery `gid` is left to stand by its group's drop, as `tx` reads it — `then(left)`.
function _groupDroppedIn(tx, gid, then) {
  const q = tx.objectStore(FOLDER_STORE).get(`${GROUP}${gid}`);
  q.onsuccess = () => then(!!q.result?.drop);
}
const _groupDrop = (gids, first) => _recordsWrite((store) => _dropIn(store, gids, first));
// Whether gallery `gid` was left to stand by its group's drop; every gallery left so.
const _groupDropped = async (gid) => !!(await _groupRecords()).find(r => r.gid === String(gid))?.drop;
const _groupLeft = async () => (await _groupRecords()).filter(r => r.drop).map(r => r.gid);
// Gallery `gid` out of its group: settled with no version to stand by (S38).
const _ungroup = (gid) => _recordsWrite((store) => store.delete(`${GROUP}${gid}`));
const _ungroupIn = (tx, gid) => tx.objectStore(FOLDER_STORE).delete(`${GROUP}${gid}`);
async function _groupRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = _tx(db, FOLDER_STORE, 'readonly').objectStore(FOLDER_STORE).getAll(IDBKeyRange.bound(GROUP, `${GROUP}￿`));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
const _groupOf = async (gid) => (await _groupRecords()).find(r => r.gid === String(gid))?.grp ?? null;
// The other galleries of gallery `gid`'s group whose change still waits here.
async function _groupWaiting(gid) {
  const all = await _groupRecords();
  const grp = all.find(r => r.gid === String(gid))?.grp;
  if (!grp) return [];
  const marked = await _marked();
  return all.filter(r => r.grp === grp && r.gid !== String(gid) && marked.has(r.gid)).map(r => r.gid);
}
// Gallery `gid` weighed with its group: each other one waiting holds its place (_hold) — another publication there
// drops the group; one not held now, or whose folder can't be written now (another app's, being handed over, out of
// reach: S33, review 10 B3), keeps it waiting — each held under `gid`'s lock, which the publication weighing it holds
// (_hold `held`: another gallery's lock is taken only while it is free, S37). One its group's drop left to stand isn't
// weighed: its own place is held next, where it stands (_hold). Resolves what the weighing did (S42 A): { go — whether
// `gid` goes on; grp — the group it was about (null: none); how — 'weighed' (every other gallery of it waiting held
// 'ok' by this weighing itself), 'window' (passed through the window a weighing of the group opened), 'none' (no
// group to weigh) or 'left' (left to stand) }. The group is taken as weighed whole (for GROUP_WEIGHED_MS) only by a
// weighing that weighed it whole itself and then held the weigher's own place 'ok' (_groupWeighed, by _describe: S41
// A, S42 A) — never by the weighing of the others alone, nor by a gallery that passed through the window (2 seconds
// from a real weighing, never carried forward from member to member): a gallery whose own place holds another writer's
// publication lets no other part of its command through meanwhile.
async function _weighGroup(gid) {
  const record = (await _groupRecords()).find(r => r.gid === String(gid));
  const grp = record?.grp ?? null;
  if (!grp) return { go: true, grp, how: 'none' };
  if (record.drop) return { go: true, grp, how: 'left' };
  if (Date.now() - (_weighedGroups.get(grp) ?? -Infinity) < GROUP_WEIGHED_MS) return { go: true, grp, how: 'window' };
  for (const m of await _groupWaiting(gid)) {
    const folder = (await galleryGet(m))?.folder;
    if ((folder && !(await _usable(folder, { work: PUBLISHING }))) || (await _hold(m, { held: String(gid) })).kind !== 'ok' || (await _groupOf(gid)) !== grp) return { go: false, grp, how: 'weighed' };
  }
  return { go: (await _groupOf(gid)) === grp, grp, how: 'weighed' };   // (dropped meanwhile, with the group: no)
}
// Whether gallery `gid`, its own place held 'ok', acts for what its weighing `weighed` (_weighGroup's answer) was about
// (S42 A): its group now the one weighed — that group still, or still none. A series command made since the weighing
// (a group formed or changed in between: each command groups its galleries afresh, _groupIn) is none of this work's.
// One left to stand goes on: its own hold stood or settled it, and what it then is, it is.
const _weighedStill = async (gid, weighed) => weighed.how === 'left' || (await _groupOf(gid)) === weighed.grp;
// Gallery `gid`'s group taken as weighed whole from now on — weighed whole by this weighing itself (`weighed`), its own
// place held 'ok', the group still that one (S41 A, S42 A).
async function _groupWeighed(gid, weighed) {
  if (weighed.how !== 'weighed') return;
  const record = (await _groupRecords()).find(r => r.gid === String(gid));
  if (record?.grp === weighed.grp && !record.drop) _weighedGroups.set(weighed.grp, Date.now());
}
// The text of the manifest of the gallery whose folder in the archive at `path` is `inner` ('' for an archive of
// its own), read where it lies (_archiveOf): null for none, undefined when no archive is there.
async function _archiveManifest(folder, root, path, inner) {
  const archive = await _archiveOf(folder, root, path);
  if (!archive) return undefined;
  const entry = archive.entries.get(`${inner}${MANIFEST_FILE}`);
  return entry ? new TextDecoder().decode(await entry.read()) : null;
}
// The folder's version of gallery `gid` stands (folder-library.js folderStands): what waited here for it
// dropped, reported once — or, nothing of it waiting, the gallery read again from there. Resolves true when
// that is done, false when it can't be now (its place can't be read now: tried again later) — or { damaged },
// its reason ('corrupt', 'missing-file'), when the publication there was read and is damaged (a description
// that doesn't parse, a file it names not there): no version to stand, so what waits is published over it, as
// a change to a damaged folder always was (T08), never left waiting for good. `held`, `handover`: _hold's; `look`:
// what the look that asked saw (S39, S40: what the place shows decides — gallery-manifest.js dropBasis) — `seen`, a
// manifest there, whoever's; `theirs`, another writer's publication.
async function _stands(gid, held = null, handover = false, { seen = false, theirs = false } = {}) {
  try { return await _folderLibrary.folderStands(String(gid), { held, handover, seen, theirs }); } catch (e) {
    if (['corrupt', 'missing-file'].includes(e?.reason)) return { damaged: e.reason };
    throw e;
  }
}
// Inside `tx`: files of gallery folder `dir` in folder `folder` ({ path, size, mtime }, as Shiori recorded
// writing them) to retire, as a change letting them go records them (_unlinkLater) — deleted once a
// publication of the gallery no longer naming them has committed, each only while still as written.
function _retireIn(tx, folder, dir, files) {
  for (const f of files) tx.objectStore(FOLDER_STORE).put({ id: `${_retiringPrefix(folder, dir)}${f.path}`, folder, dir, path: f.path, size: f.size ?? null, mtime: f.mtime ?? null });
}
// Inside one transaction, while gallery `gid` is still the one its publication began for (`life`), kept at
// `place` (the place it held: none of a gallery made again under its id meanwhile): its mark cleared when it is
// still the one of revision `rev` (compare-and-clear), and its stamp kept. Resolves whether it was.
// Dropped as it landed (S42 D): published from what waited (`rev`), it finds the mark gone — a stand dropped what
// waited after this publication read it (the others of a dropped command are stood by the stand that drops it, not
// under this gallery's lock: folder-library.js folderStands), its record read again from the folder's version before
// this one landed. The stamp kept is still the token of what is in the folder (this publication), and the gallery
// waits again (its mark put back): the library's record as it stands is published next, so the folder says what the
// library says. (Before, it ended as if nothing happened: the library kept the stood record, the folder this
// publication, the stamps equal — no check read it again.)
async function _described(gid, rev, stamp, place, life) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [GALLERY_STORE, UNDESCRIBED_STORE], 'readwrite');
    const marks = tx.objectStore(UNDESCRIBED_STORE), stats = tx.objectStore(GALLERY_STORE);
    const stat = stats.get(gid);
    let ours = false, dropped = false;
    stat.onsuccess = () => {
      if (!stat.result || !_still(life, stat.result) || !_samePlace(stat.result, place)) return;
      ours = true;
      if (stat.result.stamp !== stamp) stats.put({ ...stat.result, stamp });
      const mark = marks.get(gid);
      mark.onsuccess = () => {
        if (mark.result && mark.result.rev === rev) { marks.delete(gid); _ungroupIn(tx, gid); }
        else if (rev != null && !mark.result) { _markIn(tx, gid, rev); dropped = true; }
      };
    };
    tx.oncomplete = () => { if (dropped) _describeSoon(gid); resolve(ours && !dropped); };
    tx.onerror = () => reject(_txError(tx));
  });
}
// Whether stat records `a` and `b` keep their gallery at one place: the same folder, its directory there, and an
// archive's folder in it (a series export's chapter).
const _samePlace = (a, b) => a?.folder === b?.folder && a?.dir === b?.dir && (a?.packed?.inner ?? null) === (b?.packed?.inner ?? null);
// The galleries marked as having changes their folders lack (_logIn): their ids.
async function _marked() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, UNDESCRIBED_STORE, 'readonly');
    const req = tx.objectStore(UNDESCRIBED_STORE).getAllKeys();
    tx.oncomplete = () => resolve(new Set((req.result || []).map(String)));
    tx.onerror = () => reject(_txError(tx));
  });
}
// Gallery `gid`'s stat record changed as `fn` makes it (null: left as it is).
async function _patchStat(gid, fn) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = _tx(db, GALLERY_STORE, 'readwrite');
    const store = tx.objectStore(GALLERY_STORE);
    const req = store.get(gid);
    req.onsuccess = () => {
      const next = req.result ? fn(req.result) : null;
      if (next) store.put(next);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
}

// ── Moving a gallery's pictures ──
// What a gallery's records refer to now, to tell whether they changed while its pictures were being
// copied.
const _refOrType = (v) => (_isRef(v) ? _refId(v) : v == null ? null : typeof v);
const _picturesOf = (pages, cover) => JSON.stringify([
  pages.map(r => [r.url, PAGE.slots(r).map(([obj, key]) => _refOrType(obj[key]))]).sort(),
  cover ? [_refOrType(cover.cover), _refOrType(cover.seriesCover), cover.coverRevisions || null] : null]);
async function _rawGallery(gid) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, GALLERY_STORE, COVER_STORE, META_STORE], 'readonly');
    const stat = tx.objectStore(GALLERY_STORE).get(gid);
    const meta = tx.objectStore(META_STORE).get(gid);
    const pages = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    const cover = tx.objectStore(COVER_STORE).get(gid);
    tx.oncomplete = () => resolve({ stat: stat.result || null, meta: meta.result || null, pages: pages.result || [], cover: cover.result || null });
    tx.onerror = () => reject(_txError(tx));
  });
}
// A cover image that is the gallery's page (its url), not a picture of its own.
const _pageOfCover = (ref) => (typeof ref?.[REF] === 'string' && ref[REF].endsWith('|page') ? { url: ref[REF].slice(0, -'|page'.length) }
  : _isPath(ref) && !COVER.ownsPath(ref.$path) ? { path: ref.$path } : null);

// Page record `rec` as it is now, its pictures where a move copied them (`copy`: the record as the
// move read it, its pictures placed — the same pictures, the move checked): nothing else of it changes,
// so what was written to it meanwhile (its settings, its pipeline data) stays.
function _withPicturesOf(rec, copy) {
  const next = _pageCopy(rec);
  const from = PAGE.slots(copy);
  PAGE.slots(next).forEach(([obj, key], i) => { obj[key] = from[i][0][from[i][1]]; });
  return next;
}

// Gallery `gid`'s pictures brought to `to` (a folder's id, or BROWSER), under the gallery's lock
// (_writing: no other write of its pictures, in any tab or the service worker, runs meanwhile):
// copied there (a folder of its own reserved there first), its records switched over in one
// transaction — only if its pictures are still the ones copied, and the place it leaves is still in
// the library (else refused: 'hidden') — then the old copies deleted. A linked gallery that leaves
// its folder becomes the library's own, its source noted as removed there (so a check of the folder
// doesn't add it again). A gallery already there has only what waits in this browser moved out
// (settling it) — or, kept in an archive there (`packed`), is unpacked into a folder beside it. `tick()`
// after each picture; `work` a removal's own (_workOn), for its moves and write-back. Resolves whether it
// moved anything.
async function _relocate(gid, to, tick = () => {}, { work = null } = {}) {
  return _writing(gid, (w) => _relocateLocked(gid, to, tick, work, w));
}
async function _relocateLocked(gid, to, tick, work, w) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const moved = await _relocateOnce(gid, to, tick, work, w);
    if (moved !== 'changed') return moved;
    await _discard(w.made);   // it changed meanwhile: copied again from what it is now
  }
  throw new BackendError('conflict', `gallery ${gid} kept changing while it was being moved`);
}
// Gallery `gid`, kept in an archive in the gallery format (`packed`: read in place), unpacked on its
// first change — under its lock, held by the caller (a write of it, or its describe): its pictures
// copied out as they are (each entry's bytes, never encoded again) into a folder beside the archive
// named after it, its records switched over, then the archive deleted once no gallery is read from it
// (_ownsDir) — _relocateOnce to the folder it is in. Its descriptions are written there afresh (the
// change marks it).
async function _unpackLocked(gid, work = null) {
  const w = { gid: String(gid), life: await _life(gid), made: [], kept: true, committed: false };
  try {
    const stat = await galleryGet(gid);
    if (stat?.packed) await _relocateLocked(gid, stat.folder, () => {}, work, w);
  } finally { if (!w.committed) await _discard(w.made); }
}
// Gallery `gid`'s generation, as unpacked into folder `home` (its pictures placed there: `pages`, `cover`;
// `stat` its stat record with that place; `home.token` its reservation's publication), published in that
// folder through the folder store (opened to publish — or for `work`, a removal's own write-back), at its
// place as reserved: resolves the token it is published at. Rejects when the folder can't take it now (the
// unpack fails, its reservation undone: _discard).
async function _publishUnpacked(gid, home, stat, meta, pages, cover, work) {
  const { wanted, next } = await _generationOf(gid, stat, meta, pages, cover);
  const opened = await folderStore.open({ id: home.folder, location: home.root }, { purpose: _workOn(work, home.folder) === 'removal' ? 'removal' : 'publish' });
  const found = opened.status === 'ok' ? await opened.root.gallery(home.dir, gid, { known: home.token ?? null }) : null;
  if (found?.kind !== 'ok') throw new BackendError('unavailable', `the folder gallery ${gid} is unpacked into can't be written now`);
  return (await found.dir.publish({ manifest: next, descriptions: _textsOf(wanted) })).token;
}
// The folder an archive's gallery is unpacked into: beside the archive, named after it — a series
// export's chapter in the series' folder, named as in the archive.
const _unpackedName = (stat) => {
  const base = stat.dir.replace(/\.(zip|cbz)$/i, '');
  const inner = stat.packed?.inner ? stat.packed.inner.replace(/\/$/, '') : '';
  return inner ? `${base}/${inner}` : base;
};
async function _relocateOnce(gid, to, tick, work, w) {
  // Its place held first (_hold): another app's publication there since this library read it stands — what
  // waited here for it dropped, reported — so what moves out, is unpacked or settles there is the folder's
  // version, never this library's older view of it; one that can't be held now is refused, tried again.
  const was = await galleryGet(gid);
  if (was?.folder && was.dir) {
    // One whose folder came back and is still being read (S32) waits for that read before its place is looked at.
    if ((await _access(was.folder)).handover) throw Object.assign(new BackendError('unavailable', `library folder ${was.folder} is still being read after it came back`), { reason: 'handover', folder: was.folder });
    const held = await _hold(gid, { stat: was, held: w.gid });   // its lock is the move's (_writing)
    if (held.kind !== 'ok') throw Object.assign(new BackendError(held.kind === 'conflict' ? 'conflict' : 'unavailable', `the place of gallery ${gid} can't be held now (${held.kind})`), { reason: held.kind });
  }
  const raw = await _rawGallery(gid);
  const stat = raw.stat;
  if (!stat) return false;
  const from = stat.folder || BROWSER;
  const same = from === to;
  const packed = same && stat.packed;   // unpacked where it is
  if (same && !stat.spilled && !packed) return false;
  // Every unpack — a first change's (_unpackLocked), or what waits in this browser going out (settleFolders)
  // — first meets a folder beside the archive naming the gallery at a later generation: an unpack of it
  // begun and cut short before the archive went, by the other app or this one (review 7 B6), taken instead
  // (folder-library.js followUnpacked) and never unpacked a second time; then tried again from where it is
  // now ('changed': what waits in this browser goes there).
  if (packed && await _folderLibrary.followUnpacked(stat)) return 'changed';
  if (from !== BROWSER && !(await _usable(from, { work }))) {
    const why = (await _access(from)).handover ? 'handover' : _heldElsewhere(from) ? 'taken' : null;
    throw Object.assign(new BackendError('unavailable', `library folder ${from} can't be reached`), why ? { reason: why, folder: from } : {});
  }
  const before = _picturesOf(raw.pages, raw.cover);
  const pages = await getGalleryImageRecords(gid);
  const cover = await _coverRecord(gid);
  // A picture that can't be read now would be lost by moving: it stays where it is.
  const rawByUrl = new Map(raw.pages.map(r => [r.url, r]));
  const unread = pages.reduce((n, rec) => n + PAGE.slots(rawByUrl.get(rec.url) || {}).length - PAGE.slots(rec).length, 0);
  if (unread > 0) throw new BackendError('aborted', `${unread} pictures of gallery ${gid} can't be read`);
  let home = null;
  if (to !== BROWSER) {
    const root = await _rootOf(to, { work });
    // (One being handed over says so: S33, review 10 B7.)
    if (!root) throw Object.assign(new BackendError('unavailable', `library folder ${to} can't be reached`), (await _access(to)).handover ? { reason: 'handover', folder: to } : {});
    const keepDir = same && stat.dir && !packed;
    if (keepDir && !(await _mayWriteDir(to, root, stat.dir, gid))) throw new BackendError('conflict', `the folder of gallery ${gid} names another gallery`);
    const reserved = keepDir ? null : await _reserveDir(gid, to, root, raw.meta, w, packed ? _unpackedName(stat) : null);
    home = { gid: String(gid), folder: to, dir: keepDir ? stat.dir : reserved.dir, root, moved: true, token: reserved?.token ?? null };
  }
  for (const rec of pages) {
    for (const slot of _pageFiles(rec, rec.pageNum)) { await _place(home, [slot], w); tick(); }
  }
  // A cover that is a page follows the page; one of its own is copied like any picture.
  if (cover) {
    for (const field of ['cover', 'seriesCover']) {
      const page = _pageOfCover(raw.cover?.[field]);
      if (!page) continue;
      const rec = pages.find(r => (page.url ? r.url === page.url : _isPath(r.blob) && r.blob.$path === page.path)) || pages[0];
      if (!rec) { delete cover[field]; continue; }
      cover[field] = _isPath(rec.blob) ? rec.blob : rec.blob instanceof Blob ? _ref(`${rec.url}|page`, rec.blob) : cover[field];
    }
    await _place(home, _coverFiles(cover), w);
  }
  // The place it goes to must still take it as it commits: a folder hidden, removed or taken over while
  // the copy was made is refused here or, in between, by the transaction's mount check (F02).
  if (home && !(home.root && await _usable(to, { work }))) throw new BackendError('unavailable', `library folder ${to} can't take it now`);
  // An unpack's folder is published there, whole — naming what it now holds — before the gallery's records
  // take it and its archive goes (review 7 B6): a page that dies after leaves a folder any reader takes for
  // this gallery's, never a reservation beside the archive, which the other app passes over and unpacks a
  // second copy beside. Its records then keep the token it is published at.
  const stamp = packed && home ? await _publishUnpacked(gid, home, { ...stat, folder: home.folder, dir: home.dir }, raw.meta, pages, cover, work) : null;
  // The place it leaves is recorded with the publication this move carried (its stamp as it commits) and the
  // claim's counter its folder is held at: deleted only while it still holds that (_deleteOne, _hold).
  const leftEpoch = from === BROWSER ? null : (await _folderById(from))?.epoch ?? null;
  const db = await openDB();
  let changed = false, tx;
  await new Promise((resolve, reject) => {
    tx = _tx(db, [STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE], 'readwrite');
    tx._work = work;
    tx._write = w;
    tx.oncomplete = () => { w.committed = true; resolve(); };
    tx.onerror = () => (changed ? resolve() : reject(_txError(tx)));
    const images = tx.objectStore(STORE);
    const covers = tx.objectStore(COVER_STORE);
    const stats = tx.objectStore(GALLERY_STORE);
    const now = images.index('galleryId').getAll(IDBKeyRange.only(gid));
    const curCover = covers.get(gid);
    const curStat = stats.get(gid);
    curStat.onsuccess = () => {
      const cur = curStat.result;
      if (!cur || (cur.folder || BROWSER) !== from || _picturesOf(now.result || [], curCover.result || null) !== before) { changed = true; tx.abort(); return; }
      // The place it leaves hidden or removed meanwhile: out of the library, nothing of it moves —
      // unless this is that place's own removal moving it out.
      _placeStateIn(tx, cur, (state) => {
        if (!mounted(state) && !_workOn(work, from)) { _refuseIn(tx, gid); return; }
        const copies = new Map(pages.map(r => [r.url, r]));
        for (const rec of now.result || []) images.put(_stash(tx, _withPicturesOf(rec, copies.get(rec.url)), _refIds(rec, PAGE), PAGE));
        // The cover record as it is now (thumbnails made meanwhile kept), with its images moved.
        const c = curCover.result;
        if (c && cover) {
          const next = { ...c };
          for (const field of ['cover', 'seriesCover']) if (cover[field] != null) next[field] = cover[field];
          covers.put(_stash(tx, next, _refIds(c, COVER), COVER));
        }
        const kept = _homeOf(cur);   // what it keeps where it stays: not what waited, nor its archive
        delete kept.spilled;
        delete kept.packed;
        const at = stamp ?? home?.token;   // published there (an unpack), or its reservation there
        stats.put(home ? { ..._withoutHome(cur), ...(same ? kept : {}), folder: home.folder, dir: home.dir, ...(at ? { stamp: at } : {}) } : _withoutHome(cur));
        if (!home) tx.objectStore(UNDESCRIBED_STORE).delete(gid);
        _logIn(tx, gid, { mark: !stamp });   // the place it goes to, and the descriptions it owes there (none, unpacked: published)
        if (!same || packed) _goneLater(tx, from === BROWSER ? null : from, cur.dir, gid, cur.linked || null, cur.packed?.inner || null, { stamp: cur.stamp, epoch: leftEpoch });
      });
    };
  });
  if (changed) return 'changed';
  await tx._unlinked;   // the old copies are gone once it resolves
  if (home) _describeSoon(gid);
  platform.control.send({ type: 'COVER_INVALIDATED', galleryId: gid });
  publishFeed(gid);
  return true;
}

// Gallery `gid` followed to where a check found its folder (or archive) — renamed or moved there by
// hand, or packed, unpacked or moved there by another app while it held the library folder — from the
// place its stat record has (`from`: { folder, dir, inner }) to `to` (the same; `inner` its folder in the
// archive `dir`: '' for an archive of its own, null for a folder), under its lock (no write of its
// pictures interleaves), in one transaction and only while its record still has it at `from`: its place
// taken there, every file its records refer to at `from` referred to where it now lies (`refAt(rel)`: the
// file at `rel` in the gallery's folder as the check read it there — or, one it didn't find, the reference
// as recorded, moved along), and its files waiting to retire noted there (a folder to a folder: they
// moved with it). Nothing of a folder is read or written here, and what waits of it stays — pictures in
// this browser (`spilled`), changes not published (its mark) — to go to that place as they would have to
// the one it left (review 7 B5): following a gallery is apart from reading it again, which waits for
// them (folder-library.js _storeAdopted). `leave`: `from` is an archive still there, left by an unpack of
// it cut short (review 7 B6) — recorded for deletion in that transaction, and deleted once it commits, as
// this app's own unpack deletes it (_goneLater); `held`: the gallery whose lock the caller holds (its id: its own, an
// unpack about to be made, _relocateOnce — or null: a check's). Resolves whether it was followed.
async function _follow(gid, from, to, refAt, { leave = false, held = null } = {}) {
  const run = async () => {
    const db = await openDB();
    const leftEpoch = leave ? (await _folderById(from.folder))?.epoch ?? null : null;   // the archive left recorded as it was held (_goneLater)
    let followed = false, tx;
    await new Promise((resolve, reject) => {
      tx = _tx(db, [STORE, GALLERY_STORE, COVER_STORE], 'readwrite');
      tx._work = { kind: 'adopt', folder: to.folder };
      tx._held = String(gid);   // its lock held as it awaits the archive it left (_unlink)
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(_txError(tx));
      const stats = tx.objectStore(GALLERY_STORE), images = tx.objectStore(STORE), covers = tx.objectStore(COVER_STORE);
      const stat = stats.get(gid);
      const pages = images.index('galleryId').getAll(IDBKeyRange.only(gid));
      const cover = covers.get(gid);
      const there = (v) => _isPath(v) && !v.ro && v.folder === from.folder && v.dir === from.dir;
      const moved = (v) => {
        const rel = from.inner != null && v.$path.startsWith(from.inner) ? v.$path.slice(from.inner.length) : v.$path;
        const found = refAt(rel);
        if (found) return found;
        const { zip, ...rest } = v;
        return { ...rest, folder: to.folder, dir: to.dir, $path: `${to.inner ?? ''}${rel}`, ...(to.inner != null ? { zip: 1 } : {}) };
      };
      const repoint = (rec, kind) => {
        let changed = false;
        for (const [obj, key] of kind.slots(rec)) if (there(obj[key])) { obj[key] = moved(obj[key]); changed = true; }
        return changed;
      };
      cover.onsuccess = () => {
        const cur = stat.result;
        if (!cur || cur.linked || cur.folder !== from.folder || cur.dir !== from.dir || (cur.packed ? cur.packed.inner || '' : null) !== from.inner) return;
        for (const rec of pages.result || []) if (repoint(rec, PAGE)) images.put(rec);
        if (cover.result && repoint(cover.result, COVER)) covers.put(cover.result);
        const { packed, ...rest } = cur;
        stats.put({ ...rest, folder: to.folder, dir: to.dir, ...(to.inner != null ? { packed: { inner: to.inner } } : {}) });
        if (from.inner == null && to.inner == null) {
          _retiringIn(tx, from.folder, from.dir, (list) => {
            const notes = tx.objectStore(FOLDER_STORE);
            for (const r of list) {
              notes.delete(r.id);
              notes.put({ ...r, id: `${_retiringPrefix(to.folder, to.dir)}${r.path}`, folder: to.folder, dir: to.dir });
            }
          });
        }
        _logIn(tx, gid, { mark: false });   // its place as it now is, in the library (the mount check)
        if (leave && from.inner != null) _goneLater(tx, from.folder, from.dir, gid, null, from.inner || null, { stamp: cur.stamp, epoch: leftEpoch });
        followed = true;
      };
    });
    await tx._unlinked;   // the archive it left gone (`leave`), as far as it could be now
    if (followed) platform.control.send({ type: 'COVER_INVALIDATED', galleryId: gid });
    return followed;
  };
  return _galleryWork(gid, held, run);
}

// What waits in this browser for the library's folders moved out to them, and the changes their folders
// lack published there — for every folder this context may write to now (the write gate: pictures for a
// hidden folder wait until it is shown, but what was committed before it was hidden is published there
// too, plan §3.4; one another app holds waits until it is taken back). Resolves how many galleries had
// pictures moved out.
export async function settleFolders() {
  const { byId } = await _folders();
  if (!byId.size) return 0;
  const db = await openDB();
  const waiting = await new Promise((resolve, reject) => {
    const tx = _tx(db, GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).index('spilled').getAll();
    tx.oncomplete = () => resolve(req.result || []);
    tx.onerror = () => reject(_txError(tx));
  });
  let settled = 0;
  for (const stat of waiting) {
    if (!stat.spilled || !byId.has(stat.folder) || !(await _usable(stat.folder))) continue;
    // Its pictures never go into a generation another app published there since: its place is held as
    // they go (_relocateOnce, _hold) — the folder's version stands, and they are dropped with what else waited.
    try { if (await _relocate(String(stat.galleryId), stat.folder)) settled++; } catch {}
  }
  for (const gid of await _marked()) {
    const stat = await galleryGet(gid);
    if (!byId.has(stat?.folder) || !(await _usable(stat.folder, { work: PUBLISHING }))) continue;
    await _describe(gid).catch(() => {});
  }
  return settled;
}

// ── The library's places ──

// Whether this browser can keep galleries in a folder at all.
export const foldersSupported = () => folderFiles.supported();

// `fn(store, tx)` over the folder records, in one read-write transaction (`tx`, to log in it what
// changed); every context reads the folders again once it has committed.
async function _folderWrite(fn) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = _tx(db, FOLDER_STORE, 'readwrite');
    fn(tx.objectStore(FOLDER_STORE), tx);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
  _foldersChanged();
}
const _refuse = (reason, message) => { const e = new BackendError('invalid', message); e.reason = reason; throw e; };

// Place `id` (a folder of the library's, or BROWSER) shown or hidden: { place, hidden } (place null:
// no such place).
async function _placeOf(id) {
  const { byId, browser } = await _folders();
  const place = id === BROWSER ? browser : byId.get(id) || null;
  return { place, hidden: place?.state === 'hidden' };
}
// A gallery's place (its stat record `g`): its folder, or BROWSER — this browser, or a folder the
// library no longer knows (`f`: _folders()) — and whether it is in the library (its place neither
// hidden nor being removed: one out of it is never read as the library's; nor written to — the mount
// check, _logIn).
const _placeKey = (g, { byId, removing }) => (g?.folder && (byId.has(g.folder) || removing.has(g.folder)) ? g.folder : BROWSER);
const _mounted = (g, f) => !f.unmounted.size || !f.unmounted.has(_placeKey(g, f));

// Gallery `gid` moved to `to` (a library folder's id, or BROWSER) — a series owner with every chapter
// of its series, unless `series` is false. Its pictures are copied there, its records switched over
// at once, then the old copies deleted (_relocate). A series with a chapter out of the library (its
// folder hidden or being removed) is refused whole ('hidden'). `onProgress(done, total)` follows the
// pictures. Resolves { moved } (gallery ids).
export async function moveGallery(galleryId, to, { onProgress = () => {}, series = true } = {}) {
  const gid = String(galleryId);
  const target = to == null || to === BROWSER ? BROWSER : String(to);
  const { place, hidden } = await _placeOf(target);
  if (!place) throw new BackendError('not-found', `no library folder ${target}`);
  if (hidden) _refuse('hidden', 'nothing is moved to a hidden place');
  const meta = series ? await metaGet(gid) : null;
  const ids = [gid, ...(Array.isArray(meta?.chapters) ? meta.chapters.map(c => String(c?.id ?? '')).filter(id => id && id !== gid) : [])];
  const f = await _folders();
  let total = 0, done = 0;
  for (const id of ids) {
    const raw = await _rawGallery(id);
    if (raw.stat && !_mounted(raw.stat, f)) _refuse('hidden', `gallery ${id} is in a hidden library folder`);
    if ((raw.stat?.folder || BROWSER) === target && !raw.stat?.spilled) continue;
    for (const rec of raw.pages) total += PAGE.slots(rec).length;
  }
  onProgress(0, total);
  const moved = [];
  for (const id of ids) if (await _relocate(id, target, () => onProgress(Math.min(++done, total), total))) moved.push(id);
  return { moved };
}

// ── The folder layer (folder-library.js) ──
// The folders as the person manages them — adding, taking back, the default, hiding, showing,
// removing — a removal's work, checking a folder, and its PDFs: folder-library.js, built over what
// this kernel hands it (every record it writes goes through these transactions and their mount check,
// every folder file through the write gate), and exported here under the names api.js uses.
// Whether this library has work due for gallery `gid` — its announcement, its size, its publication: a check
// reads another app's work of it at a later check meanwhile (folder-library.js _catchUp; §8, S26a).
export const galleryBusy = (gid) => _feedTimers.has(gid) || _sizeTimers.has(gid) || _describeTimers.has(gid);
const _folderLibrary = createFolderLibrary({
  BROWSER, DEFAULT_FOLDER, REF, PAGE, COVER,
  stores: { STORE, META: META_STORE, GALLERY: GALLERY_STORE, COVER: COVER_STORE, BLOB: BLOB_STORE, UNDESCRIBED: UNDESCRIBED_STORE, DORMANT: DORMANT_STORE, PERSONAL: PERSONAL_STORE },
  // IndexedDB, the change log and the change feed
  openDB, tx: _tx, txError: _txError, logIn: _logIn, deleteIn: _deleteIn, afterDelete: _afterDelete, ended: _ended,
  now: _now, life: _life, lifeOf: _lifeOf, still: _still, stillNow: _stillNow, born: _born, stash: _stash, keyPage: _keyPage,
  canonicalMeta, importMarksIn: _importMarksIn, publishFeed, muchLater: _muchLater, bulkRun: _bulkRun,
  busy: galleryBusy,
  // the records
  galleryGet, galleryGetAll, metaGet, metaGetAll, transferIds, nextGalleryId, rebuildGalleryEntry, refreshSeriesAggregate, putCoverPatch,
  seriesWrite: (...args) => _seriesCommand('write', args),
  // the places, the write gate, the claims
  folders: _folders, folderById: _folderById, folderWrite: _folderWrite, forgetGrant: (id) => _grants.delete(id), forgetKnown: _forgetKnown, forgetRetiring: _forgetRetiring,
  note: _note, noteIn: _noteIn, noteChecked: _noteChecked, attentionOf: _attentionOf, dismiss: _dismiss, forgetAttention: _forgetAttention,
  placeOf: _placeOf, placeKey: _placeKey, access: _access, rootOf: _rootOf, usable: _usable, readRootOf: _readRootOf,
  removedNotes: _removedNotes, publishRemoved: _publishRemoved,
  deletions: _deletions, applyDeletions: _applyDeletions, forgetDeletions: _forgetDeletions, deletedFound: _deletedFound, endUnfound: _endUnfound,
  deletionHeld: _deletionHeld,
  me: _me, myLabel: _myLabel, readClaim: _readClaim, writeClaim: _writeClaim, noteEpoch: _noteEpoch, randomId: _randomId,
  markOf: _markOf, setHandover: _setHandover, noteReleased: _noteReleased, releasedOf: _releasedOf, groupWaiting: _groupWaiting,
  // the pictures' storage in folders
  writing: _writing, galleryWork: _galleryWork, groupDropIn: _groupDropIn, groupDroppedIn: _groupDroppedIn, groupDrop: _groupDrop, groupDropped: _groupDropped, groupLeft: _groupLeft,
  ungroup: _ungroup, describeSoon: _describeSoon, replacePages: _replacePages, relocate: _relocate, follow: _follow, unpackedName: _unpackedName, reserveDir: _reserveDir, describe: _describe, cancelDescribe: _cancelDescribe,
  hold: (gid, view) => _hold(gid, view),
  marked: _marked, patchStat: _patchStat, wantedDescriptions: _wantedDescriptions, textsOf: _textsOf, retireIn: _retireIn,
  archiveOf: _archiveOf, typeOfName: _typeOfName, settleFolders,
});
export const { foldersList, foldersWaiting, folderAdd, folderClaim, folderSetDefault, folderAllow, folderHide, folderShow,
  folderRemove, folderSetAside, foldersPending, folderScan, folderDismiss, pdfsWaiting, pdfSource, addRendered, pdfFailed } = _folderLibrary;

export async function dbGet(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, BLOB_STORE], 'readonly');
    let rec = null;
    const req = tx.objectStore(STORE).get(url);
    req.onsuccess = () => { rec = req.result || null; _loadPages(tx, [rec]); };
    tx.oncomplete = () => _completed(tx, rec).then(resolve, reject);
    tx.onerror = () => reject(_txError(tx));
  });
}

// Store one page image (Blob or data-URL — normalized to a Blob) under the caller's key and
// keep the gallery's stat record and cover in step, all in one transaction. Keys are stored
// verbatim — any canonicalization is the caller's business. Re-putting a key that already
// exists replaces the record and adjusts the gallery's size delta — it NEVER double-counts,
// so gallery counts stay truthful no matter how callers overlap (capture, download, import).
// `opts.meta`, when given, is the gallery's metadata, written in the same transaction as the page:
// a gallery's first page and its metadata land together or not at all.
export async function dbPut(url, src, mediaId, galleryId, opts = {}) {
  const life = await _life(galleryId || mediaId);   // the gallery it is for (_writing)
  const db = await openDB();
  const gid = String(galleryId || mediaId);
  const meta = opts.meta ? canonicalMeta({ ...opts.meta, galleryId: gid }) : null;
  const canonUrl = url;
  const blob = await imageToBlob(src);
  const size = blob ? blob.size : 0;
  const cachedAt = Date.now();
  const pageNum = _keyPage(canonUrl) ?? 9999;
  // If this gallery is a chapter (has parentId) or is itself a series owner (has aggregate fields),
  // its size/count just changed → refresh the affected series aggregate after the tx (debounced).
  let _aggParent = null, _aggSelf = null;
  // A re-put of a URL another gallery owns is a MOVE: the old gallery loses the page from its
  // stats and the new one gains it — without this, the new gallery absorbed a negative size
  // delta for bytes it never owned and its count silently drifted.
  let _movedFromGid = null, _aggMovedParent = null;
  let coverChanged = false;

  // A gallery kept in a library folder has its page written there first (the commit protocol).
  await _writing(gid, async (w) => {
    const home = await _home(gid, meta, w);
    const page = { url: canonUrl, blob, mediaId: String(mediaId), galleryId: gid, cachedAt, size };
    const left = await _place(home, _pageFiles(page, pageNum), w);
    const coverOf = () => (_isPath(page.blob) ? page.blob : _ref(`${canonUrl}|page`, blob));
    await new Promise((resolve, reject) => {
      // META_STORE joins the tx so a brand-new stat record can seed its denormalized uploadDate
      // (the "Published date" sort key) from the gallery's metadata.
      const tx = _tx(db, [STORE, GALLERY_STORE, COVER_STORE, META_STORE, BLOB_STORE], 'readwrite');
      tx._write = w;
      tx.oncomplete = () => { w.committed = true; resolve(); };
      tx.onerror = () => reject(_txError(tx));
      if (meta) tx.objectStore(META_STORE).put(meta);

      const images = tx.objectStore(STORE);
      const prevReq = images.get(canonUrl);
      prevReq.onsuccess = () => {
        const prev = prevReq.result || null;
        const sameGallery = !!prev && String(prev.galleryId) === gid;
        images.put(_stash(tx, page, _refIds(prev, PAGE), PAGE));
        if (prev && !sameGallery) _logIn(tx, prev.galleryId);

        if (prev && !sameGallery) {
          const oldGid = String(prev.galleryId);
          _movedFromGid = oldGid;
          const oldReq = tx.objectStore(GALLERY_STORE).get(oldGid);
          oldReq.onsuccess = () => {
            const old = oldReq.result;
            if (!old) return;
            if (old.parentId) _aggMovedParent = old.parentId;
            tx.objectStore(GALLERY_STORE).put({
              ...old,
              count: Math.max(0, (Number(old.count) || 0) - 1),
              size: Math.max(0, (Number(old.size) || 0) - (prev.size || 0)),
            });
          };
        }

        const galReq = tx.objectStore(GALLERY_STORE).get(gid);
        galReq.onsuccess = () => {
          const cur = galReq.result;
          if (cur) {
            if (cur.parentId) _aggParent = cur.parentId;
            if (cur.chapterCount != null) _aggSelf = gid;
            const entry = {
              ...cur,
              ...(cur.folder || !home ? _homeFields(home, left || cur.spilled) : {}),
              count: (Number(cur.count) || 0) + (sameGallery ? 0 : 1),
              size: (Number(cur.size) || 0) - (sameGallery ? (prev.size || 0) : 0) + size,
              latestAt: Math.max(cur.latestAt || 0, cachedAt),
            };
            // addedAt is the gallery's creation marker — the gid IS the creation time, so it never
            // shifts when a stat record is rebuilt (e.g. an overwrite re-download).
            if (entry.addedAt == null) entry.addedAt = Number(gid) || entry.latestAt;
            if (meta?.uploadDate != null) entry.uploadDate = Number(meta.uploadDate) || 0;   // metaPut parity
            if (pageNum <= (cur.coverPage ?? 9999)) {
              entry.coverPage = pageNum;
              putCoverPatch(tx, gid, { cover: coverOf() });
              coverChanged = true;
            }
            tx.objectStore(GALLERY_STORE).put(entry);
            _logIn(tx, gid);
          } else {
            // First page of a gallery: seed addedAt from the gid (creation time) and the published
            // date from metadata (0 = unknown → sorts last under "Published date").
            const metaReq = tx.objectStore(META_STORE).get(gid);
            metaReq.onsuccess = () => {
              if (pageNum < 9999) { putCoverPatch(tx, gid, { cover: coverOf() }); coverChanged = true; }
              tx.objectStore(GALLERY_STORE).put({
                galleryId: gid, count: 1, size, latestAt: cachedAt,
                addedAt: Number(gid) || cachedAt, coverPage: pageNum,
                uploadDate: Number(metaReq.result?.uploadDate) || 0,
                ..._homeFields(home, left), ..._born(),
              });
              _logIn(tx, gid);   // after its record is made: the folder it takes is checked
            };
          }
        };
      };
    });
  }, life);

  _forgetOtherSourceLookup(meta?.sourceId, gid, meta?.source);
  if (coverChanged) {
    platform.control.send({ type: 'COVER_INVALIDATED', galleryId: gid });
  }
  if (_aggParent) scheduleSeriesAggregate(_aggParent);
  if (_aggSelf)   scheduleSeriesAggregate(_aggSelf);
  if (_movedFromGid) {
    if (_aggMovedParent) scheduleSeriesAggregate(_aggMovedParent);
    publishFeed(_movedFromGid);
  }
  publishFeed(gid);
}

// Every page of gallery `gid` replaced by `blobs` (in order) in one commit (_writing's protocol) — a
// PDF's pages drawn again (folder-library.js addRendered, F10): the new pictures written beside the old
// ones, then one transaction replacing every page record — what was made from the old pages
// (translations, study layers) going with them, since each page shows another picture now — and the old
// files deleted once it has committed. Until then the old pages are read. `before()`: asked once the new
// pictures are written, just before the commit; when it rejects, nothing is replaced and they go again. `life`: the
// gallery the drawing began for (_life), as it is called by default.
async function _replacePages(gid, blobs, { before = async () => {}, life = null } = {}) {
  life ??= await _life(gid);
  const db = await openDB();
  await _writing(gid, async (w) => {
    const home = await _home(gid, null, w);
    const now = Date.now();
    const pages = blobs.map((blob, i) => ({ url: `local://${gid}/${i + 1}.${extOfType(blob.type) || 'webp'}`, blob, mediaId: gid, galleryId: gid, cachedAt: now, size: blob.size }));
    let left = false;
    for (const [i, page] of pages.entries()) if (await _place(home, _pageFiles(page, i + 1), w)) left = true;
    await before();
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE, GALLERY_STORE, BLOB_STORE], 'readwrite');
      tx._write = w;
      tx.oncomplete = () => { w.committed = true; resolve(); };
      tx.onerror = () => reject(_txError(tx));
      const images = tx.objectStore(STORE);
      const req = images.index('galleryId').openCursor(IDBKeyRange.only(gid));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) { _dropBlobs(tx, _refIds(cursor.value, PAGE)); cursor.delete(); cursor.continue(); return; }
        for (const page of pages) images.put(_stash(tx, page, [], PAGE));
        _noteHomeIn(tx, gid, home, left);
        _logIn(tx, gid);
      };
    });
  }, life);
  await rebuildGalleryEntry(gid, { silent: true });
  platform.control.send({ type: 'COVER_INVALIDATED', galleryId: gid });
  publishFeed(gid);
}

// ── Metadata store helpers ──

export async function metaGet(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(String(galleryId));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// Every metadata write converges on the canonical title format (legacy flat fields stripped), then
// the tagNames index is kept in sync automatically for every writer. Metadata holds no personal mark
// (storage/personal.js): an earlier version's favorite is the personal store's (_importMarksIn).
function canonicalMeta(meta) {
  const record = migrateTitle(withoutPersonal(meta));
  if (record?.uploadDate != null) record.uploadDate = uploadDateSeconds(record.uploadDate);
  if (Array.isArray(record.tags) || Array.isArray(record.seriesTags)) return { ...record, tagNames: tagNamesOf(effectiveTagsOf(record)) };
  return record;
}

export async function metaPut(meta, opts = {}) {
  const silent = !!opts.silent;
  // `onlyIfExists`: a late write (a background pass still running for a gallery deleted meanwhile)
  // must not bring the gallery's metadata back — checked and written in one transaction.
  const onlyIfExists = !!opts.onlyIfExists;
  const db = await openDB();
  const record = canonicalMeta(meta);
  const gid = String(record.galleryId);
  let prevSourceId = null, written = false;
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [META_STORE, GALLERY_STORE, PERSONAL_STORE], 'readwrite');
    // A bare stub (sourceId placeholder, no pages yet) is not a user-visible gallery —
    // don't wake subscribers for it, or a reactive read could purge it mid-creation
    // (see the pageless-stub grace window in purgePagelessStubs).
    tx.oncomplete = () => {
      if (!written) { resolve(false); return; }
      if (prevSourceId && String(prevSourceId) !== String(record.sourceId || '')) forgetSourceMapping(prevSourceId, gid);
      _forgetOtherSourceLookup(record.sourceId, gid, record.source);
      // A silent write still moves the gallery's size (its metadata is part of the export).
      if (!record.isStub) { if (silent) scheduleGallerySize(gid); else publishFeed(gid); }
      resolve(true);
    };
    tx.onerror = () => reject(_txError(tx));
    const mstore = tx.objectStore(META_STORE);
    const prevReq = mstore.get(gid);
    prevReq.onsuccess = () => {
      if (onlyIfExists && !prevReq.result) return;
      written = true;
      prevSourceId = prevReq.result?.sourceId || null;
      mstore.put(record);
      _importMarksIn(tx, gid, meta);   // an earlier version's record (an export imported, say)
      _logIn(tx, gid);
      // Any metadata change counts as a modification: mark the gallery "updated" and keep its
      // denormalized published date (the Published-date sort key) in step. Only touch a REAL gallery
      // that already has a stat record — never create one here, and never for a bare stub.
      if (record.isStub) return;
      const gstore = tx.objectStore(GALLERY_STORE);
      const greq = gstore.get(gid);
      greq.onsuccess = () => {
        const g = greq.result;
        if (!g) return;
        g.latestAt = Math.max(g.latestAt || 0, Date.now());
        if (record.uploadDate != null) g.uploadDate = Number(record.uploadDate) || 0;
        else if (g.uploadDate == null) g.uploadDate = 0;
        gstore.put(g);
      };
    };
  });
}

export async function metaGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ── The person's own marks (storage/personal.js) ──
// What the person marked on a gallery for themselves — favorite, reading progress — kept in
// PERSONAL_STORE by this library alone, never in the gallery's folder.

// Gallery `galleryId`'s marks ({ favorite?, page?, pages?, readAt?, finished? }), or null.
export async function personalGet(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, PERSONAL_STORE, 'readonly');
    const req = tx.objectStore(PERSONAL_STORE).get(String(galleryId));
    tx.oncomplete = () => resolve(marksOf(req.result));
    tx.onerror = () => reject(_txError(tx));
  });
}
// Every gallery's marks: Map gid → marks (search's favorite filter reads it).
export async function personalAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, PERSONAL_STORE, 'readonly');
    const req = tx.objectStore(PERSONAL_STORE).getAll();
    tx.oncomplete = () => resolve(new Map((req.result || []).map(r => [String(r.gid), marksOf(r)]).filter(([, m]) => m)));
    tx.onerror = () => reject(_txError(tx));
  });
}
// Gallery `galleryId`'s marks changed (personal.js withMarks: { favorite }, or { read: { page, pages } }).
// A favorite is shown with the gallery, so its change is logged and announced like any other (refused,
// like any other, while the gallery's folder is hidden) — but no description of its folder carries it,
// so its folder isn't marked to publish anything. Reading progress is neither. Resolves the marks.
export async function personalSet(galleryId, change) {
  const gid = String(galleryId);
  const shown = typeof change?.favorite === 'boolean';
  const db = await openDB();
  let next = null;
  await new Promise((resolve, reject) => {
    const tx = _tx(db, PERSONAL_STORE, 'readwrite');
    const store = tx.objectStore(PERSONAL_STORE);
    const req = store.get(gid);
    req.onsuccess = () => {
      next = withMarks(req.result, change);
      if (next) store.put({ gid, ...next }); else store.delete(gid);
      if (shown) _logIn(tx, gid, { mark: false });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
  if (shown) publishFeed(gid);
  return next;
}
// Inside `tx` (which holds PERSONAL_STORE): the favorite an earlier version's metadata `meta` carries
// taken into the store, while it has none of its own for gallery `gid` (personal.js importMarks).
function _importMarksIn(tx, gid, meta) {
  if (meta?.favorite !== true) return;
  const store = tx.objectStore(PERSONAL_STORE);
  const req = store.get(String(gid));
  req.onsuccess = () => { const next = importMarks(req.result, meta); if (next) store.put({ gid: String(gid), ...next }); };
}

async function metaDelete(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    // Resolve on commit, not request success — a resolved write must not still be able to abort.
    const tx = _tx(db, META_STORE, 'readwrite');
    tx.objectStore(META_STORE).delete(String(galleryId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
}

// ── Gallery stats store helpers ──

export async function galleryGet(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).get(String(galleryId));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// The record's mark is its own (_born): kept as it is, or made with a record where none was — never the entry's.
export async function galleryPut(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    // Resolve on commit, not request success — a resolved write must not still be able to abort.
    const tx = _tx(db, GALLERY_STORE, 'readwrite');
    const store = tx.objectStore(GALLERY_STORE);
    const cur = store.get(String(entry.galleryId));
    cur.onsuccess = () => { const { born, ...rest } = entry; store.put({ ...rest, ..._born(cur.result) }); _logIn(tx, entry.galleryId); };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
}

async function galleryDelete(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, GALLERY_STORE, 'readwrite');
    tx.objectStore(GALLERY_STORE).delete(String(galleryId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
}

export async function galleryGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ── Cover store helpers ──

const _hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const _nextCoverRevision = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// `mark` false: the gallery's folder describes it as it is (a gallery read from there).
function putCoverPatch(tx, galleryId, patch, { mark = true } = {}) {
  const gid = String(galleryId);
  const store = tx.objectStore(COVER_STORE);
  const req = store.get(gid);
  req.onsuccess = () => {
    const current = req.result || {};
    const coverThumbs = { ...(current.coverThumbs || {}) };
    const coverRevisions = { ...(current.coverRevisions || {}) };
    for (const [role, field] of [['gallery', 'cover'], ['series', 'seriesCover']]) {
      if (!_hasOwn(patch, field)) continue;
      delete coverThumbs[role];
      coverRevisions[role] = _nextCoverRevision();
    }
    const next = { ...current, galleryId: gid, ...patch, coverRevisions };
    if (Object.keys(coverThumbs).length) next.coverThumbs = coverThumbs;
    else delete next.coverThumbs;
    store.put(_stash(tx, next, _refIds(req.result, COVER), COVER));
    _logIn(tx, gid, { mark });
  };
}

function selectCover(rec, opts = {}) {
  const preferSeries = opts === 'series' || !!opts.preferSeries;
  const seriesOnly = opts === 'seriesOnly' || !!opts.seriesOnly;
  if (seriesOnly || (preferSeries && rec?.seriesCover)) {
    return { role: 'series', source: rec?.seriesCover || null };
  }
  return { role: 'gallery', source: rec?.cover || null };
}

// One gallery's cover record, its images in place.
async function _coverRecord(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [COVER_STORE, BLOB_STORE], 'readonly');
    let rec = null;
    const req = tx.objectStore(COVER_STORE).get(String(galleryId));
    req.onsuccess = () => { rec = req.result || null; _loadCovers(tx, [rec]); };
    tx.oncomplete = () => _completed(tx, rec).then(resolve, reject);
    tx.onerror = () => reject(_txError(tx));
  });
}

export async function coverGet(galleryId, opts = {}) {
  return selectCover(await _coverRecord(galleryId), opts).source;
}

function coverWidthKey(maxW) {
  const width = Math.round(Number(maxW));
  return Number.isFinite(width) && width > 0 ? String(width) : null;
}

// Read the selected original and any persistent thumbnail in one pass. The selected role is
// returned explicitly so a preferred-series request that falls back to the gallery cover caches
// and invalidates against the gallery role, not the absent series role.
export async function coverThumbnailGet(galleryId, maxW, opts = {}) {
  const widthKey = coverWidthKey(maxW);
  const rec = await _coverRecord(galleryId);
  const selected = selectCover(rec, opts);
  return {
    ...selected,
    thumbnail: widthKey ? (rec?.coverThumbs?.[selected.role]?.[widthKey] || null) : null,
    revision: rec?.coverRevisions?.[selected.role],
    hasSeriesCover: !!rec?.seriesCover,
  };
}

// The smallest image showing a gallery's cover — a thumbnail already stored, else the cover itself —
// for small previews that shouldn't store a thumbnail of their own.
export async function coverPreviewGet(galleryId) {
  const rec = await _coverRecord(galleryId);
  const thumbs = rec?.coverThumbs?.gallery || {};
  const width = Object.keys(thumbs).filter(w => thumbs[w]).sort((a, b) => a - b)[0];
  return (width && thumbs[width]) || await imageToBlob(rec?.cover);
}

// Store a derived thumbnail without publishing feed/control notifications. The revision check
// drops stale work if the original cover was replaced while it was being decoded.
export async function coverThumbnailPut(galleryId, role, maxW, thumbnail, revision) {
  const widthKey = coverWidthKey(maxW);
  const blob = await imageToBlob(thumbnail);
  if (!widthKey || !blob || (role !== 'gallery' && role !== 'series')) return false;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let stored = false;
    const tx = _tx(db, [COVER_STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(COVER_STORE);
    const req = store.get(String(galleryId));
    req.onsuccess = () => {
      const rec = req.result;
      const sourceField = role === 'series' ? 'seriesCover' : 'cover';
      if (!rec?.[sourceField] || rec.coverRevisions?.[role] !== revision) return;
      const roleThumbs = { ...(rec.coverThumbs?.[role] || {}), [widthKey]: blob };
      store.put(_stash(tx, { ...rec, coverThumbs: { ...(rec.coverThumbs || {}), [role]: roleThumbs } },
        _refIds(rec, COVER), COVER));
      stored = true;
    };
    tx.oncomplete = () => resolve(stored);
    tx.onerror = () => reject(_txError(tx));
  });
}

// `opts.silent` skips the change announcements — for bulk writers (backup restore, stat rebuild)
// that already publish their own change signals, so one import doesn't storm the feed.
export async function coverPut(galleryId, cover, opts = {}) {
  const gid = String(galleryId);
  const role = opts === 'series' ? 'series' : opts.role;
  const silent = opts !== 'series' && !!opts.silent;
  const field = role === 'series' ? 'seriesCover' : 'cover';
  const life = await _life(gid);
  const db = await openDB();
  await _writing(gid, async (w) => {
    const home = await _home(gid, null, w);
    const made = { [field]: cover };
    const left = await _place(home, _coverFiles(made), w);
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [COVER_STORE, BLOB_STORE, GALLERY_STORE], 'readwrite');
      tx._write = w;
      _noteHomeIn(tx, gid, home, left);
      putCoverPatch(tx, gid, { [field]: made[field] });
      tx.oncomplete = () => { w.committed = true; resolve(); };
      tx.onerror = () => reject(_txError(tx));
    });
  }, life);
  if (!silent) {
    platform.control.send({ type: 'COVER_INVALIDATED', galleryId: gid });
    publishFeed(gid);
  }
}

async function coverDelete(galleryId, opts = {}) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = _tx(db, [COVER_STORE, BLOB_STORE], 'readwrite');
    _coverDeleteIn(tx, galleryId, opts === 'series' ? 'series' : opts.role);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// coverDelete's work inside a caller's transaction (which includes COVER_STORE and BLOB_STORE).
function _coverDeleteIn(tx, galleryId, role) {
  const store = tx.objectStore(COVER_STORE);
  const gid = String(galleryId);
  const req = store.get(gid);
  req.onsuccess = () => {
    const rec = req.result;
    if (!rec) return;
    _logIn(tx, gid);
    const before = _refIds(rec, COVER);
    if (!role) {
      _dropBlobs(tx, before);
      store.delete(gid);
    } else {
      const coverRole = role === 'series' ? 'series' : 'gallery';
      if (coverRole === 'series') delete rec.seriesCover;
      else delete rec.cover;
      if (rec.coverThumbs) {
        delete rec.coverThumbs[coverRole];
        if (!Object.keys(rec.coverThumbs).length) delete rec.coverThumbs;
      }
      if (rec.coverRevisions) {
        delete rec.coverRevisions[coverRole];
        if (!Object.keys(rec.coverRevisions).length) delete rec.coverRevisions;
      }
      if (rec.cover || rec.seriesCover) store.put(_stash(tx, rec, before, COVER));
      else { _dropBlobs(tx, before); store.delete(gid); }
    }
  };
}

// Source-site favicons are durable app assets, not browser HTTP-cache hints. They stay in the DB
// even when the user clears gallery/image cache so source labels remain usable offline.
export async function sourceIconGet(source) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, SOURCE_ICON_STORE, 'readonly');
    const req = tx.objectStore(SOURCE_ICON_STORE).get(String(source || ''));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function sourceIconsAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, SOURCE_ICON_STORE, 'readonly');
    const req = tx.objectStore(SOURCE_ICON_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function sourceIconPut(source, patch) {
  const key = String(source || '');
  if (!key) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, SOURCE_ICON_STORE, 'readwrite');
    const store = tx.objectStore(SOURCE_ICON_STORE);
    const req = store.get(key);
    req.onsuccess = () => store.put({ ...(req.result || {}), source: key, ...patch });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
}

// Merge a gallery's stat record + metadata into the single entity shape every UI
// surface consumes. Intentionally excludes the heavy cover blob (loaded lazily).
// A gallery's display language codes (one flag each). An app-translated copy shows only its
// target language; otherwise every valid 'language'-type tag (the non-language "translated"
// marker and unsupported names are ignored), falling back to the source metadata's language.
function _deriveLangs(m, tags = effectiveTagsOf(m)) {
  if (!m) return [];
  if (m.translatedLang) return [m.translatedLang];
  const out = [];
  const add = (code) => { if (code && !out.includes(code)) out.push(code); };
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (tag.type !== 'language' || !tag.name) continue;
      const name = tag.name.toLowerCase();
      if (name === 'translated') continue;
      add(LANG_NAME_TO_CODE[name]);
    }
  }
  if (!out.length && m.sourceMetadata && m.sourceMetadata.language) {
    add(LANG_NAME_TO_CODE[String(m.sourceMetadata.language).toLowerCase()]);
  }
  return out;
}

// A gallery as surfaces render it: its stat record and metadata merged, with the favorite of its
// personal marks (`marks`).
function _entityFrom(id, gal, meta, marks = null) {
  const g = gal || {};
  const m = meta || {};
  const isSeries = isSeriesMeta(m);
  const tags = effectiveTagsOf(m);
  return {
    id: String(id),
    count: g.count || 0,
    size: g.size || 0,
    origSize: g.origSize ?? (g.size || 0),   // the original pages (a size not yet recomputed is only those)
    latestAt: g.latestAt || 0,
    addedAt: g.addedAt ?? (Number(id) || g.latestAt || 0),
    uploadDate: g.uploadDate ?? (Number(m.uploadDate) || 0),
    coverPage: g.coverPage,
    title: normalizeTitle(m),
    numPages: m.numPages,
    tags,
    ownTags: m.tags,
    seriesTags: m.seriesTags,
    mediaId: m.mediaId,
    pageExts: m.pageExts,
    isLocalImport: m.isLocalImport || false,
    source: m.source ?? '',
    sourceId: m.sourceId || null,
    sourceUrl: m.sourceUrl || '',
    fetchedAt: m.fetchedAt,
    translated: m.translated || false,
    translatedLang: m.translatedLang || '',
    favorite: !!marks?.favorite,
    languages: _deriveLangs(m, tags),
    // Series/chapter grouping. `chapters` (owner only) is the ordered source of truth for order +
    // titles; `parentId` (children only) is the reverse link. The aggregate fields are denormalized
    // onto the owner's stat record (see refreshSeriesAggregate) so the card never fans out to read
    // every chapter. A gallery is a series when it owns 2+ chapters.
    chapters: Array.isArray(m.chapters) ? m.chapters : null,
    parentId: m.parentId || g.parentId || null,
    seriesTitle: m.seriesTitle || null,
    isSeries,
    chapterCount: g.chapterCount ?? (Array.isArray(m.chapters) ? m.chapters.length : 0),
    aggPages: g.aggPages ?? (g.count || 0),
    aggSize: g.aggSize ?? (g.size || 0),
    aggOrig: g.aggOrig ?? g.aggSize ?? (g.origSize ?? (g.size || 0)),
    // The typical page ({ w, h, mp, tier }, see page-size.js) — of the gallery, and of a series.
    medianPage: describePage(g.medianPage),
    aggMedianPage: describePage(g.aggMedianPage ?? g.medianPage),
    // Where it is kept: a library folder's id, or this browser's own storage; `missing` when its files
    // can't be found there (a linked gallery's source, folder-library.js), as the desktop says it.
    folder: g.folder || BROWSER,
    ...(g.missing ? { missing: true } : {}),
    // A gallery whose files Shiori didn't make (linked-source.js): where they are, read as they are.
    linked: g.linked ? { kind: g.linked.kind, path: g.linked.path, ...(g.linked.inner ? { inner: g.linked.inner } : {}) } : null,
  };
}

// Recompute a gallery's stat record (count/size/cover) from its actual image records —
// the repair path that makes stats truthful again after any historical drift. The pages are read
// and the result written in ONE transaction: a page stored meanwhile can never be lost under a
// stale recount. The record keeps its other fields (series link and totals, measurements); a
// gallery left with no pages keeps a zero entry, unless it is only a placeholder. `mark` false: its
// folder describes it as it is (a gallery just read from there). `work`: folder work it is part of
// (_workOn: a gallery read back from its folder — while that folder is being removed too).
export async function rebuildGalleryEntry(galleryId, opts = {}) {
  const gid = String(galleryId);
  const silent = !!opts.silent;
  const mark = opts.mark !== false;
  const db = await openDB();
  let prev = null, gone = false, inlineCover = null;
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, GALLERY_STORE, META_STORE, COVER_STORE, BLOB_STORE], 'readwrite');
    if (opts.work) tx._work = opts.work;
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
    const gals = tx.objectStore(GALLERY_STORE);
    const recsReq = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    const prevReq = gals.get(gid);
    const metaReq = tx.objectStore(META_STORE).get(gid);
    metaReq.onsuccess = () => {
      const records = recsReq.result || [];
      const meta = metaReq.result || null;
      prev = prevReq.result || null;
      _logIn(tx, gid, { mark });
      if (!records.length) {
        _coverDeleteIn(tx, gid, 'gallery');
        gone = !prev || !meta || !!meta.isStub;
        if (gone) gals.delete(gid);
        else gals.put({ ...prev, count: 0, size: 0, coverPage: 9999 });
        return;
      }
      let count = 0, size = 0, latestAt = 0, first = null, coverPage = 9999;
      for (const r of records) {
        count++;
        size += r.size || 0;
        latestAt = Math.max(latestAt, r.cachedAt || 0);
        const pn = _keyPage(r.url) ?? 9999;
        if (pn < coverPage) { coverPage = pn; first = r; }
      }
      const uploadDate = prev?.uploadDate ?? (Number(meta?.uploadDate) || 0);
      gals.put({ ...prev, galleryId: gid, count, size, latestAt, addedAt: prev?.addedAt ?? (Number(gid) || latestAt), coverPage, uploadDate, ..._born(prev) });
      // The cover points at the first page's stored image rather than copying it. Silent: this
      // repair path publishes its own feed beacon below.
      if (_isRef(first?.blob) && (first.blob[REF] === `${first.url}|page` || _isPath(first.blob))) putCoverPatch(tx, gid, { cover: first.blob }, { mark });
      else if (first) inlineCover = first.blob ?? first.dataUrl ?? null;   // stored before images moved out
    };
  });
  if (inlineCover != null) await coverPut(gid, await imageToBlob(inlineCover), { silent: true });
  if (gone) return;
  if (prev?.parentId)      scheduleSeriesAggregate(prev.parentId);
  if (prev?.chapterCount != null) scheduleSeriesAggregate(gid);   // this gallery is a series owner
  if (!silent) publishFeed(gid);
  else scheduleGallerySize(gid);
}

// Sweep every gallery and fix any whose stored count disagrees with its actual image records
// (counts written by the pre-guard dbPut could drift on overwrites). Cheap: an index count per
// gallery; only mismatches pay for a full rebuild. Returns how many were repaired.
export async function repairGalleryCounts() {
  const entries = await galleryGetAll();
  const actualCounts = await galleryImageCounts(entries.map(e => e.galleryId), entries.map(e => e.count));
  let fixed = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const actual = actualCounts[i];
    if (actual !== e.count) { await rebuildGalleryEntry(e.galleryId); fixed++; }
  }
  return fixed;
}

async function galleryImageCounts(ids, fallbacks = []) {
  const db = await openDB();
  const tx = _tx(db, STORE, 'readonly');
  const index = tx.objectStore(STORE).index('galleryId');
  return Promise.all((ids || []).map((id, i) => new Promise((resolve) => {
    const req = index.count(IDBKeyRange.only(String(id)));
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => resolve(fallbacks[i] ?? 0);
  })));
}

// Repair metadata-only series records created before empty galleries received complete numeric
// stats. Populated records are rebuilt from their stored images; truly empty members retain a
// zero-count stat row so their series ownership and future first-page transition stay valid.
export async function repairSeriesShellStats() {
  const [metas, entries] = await Promise.all([metaGetAll(), galleryGetAll()]);
  const byId = new Map(entries.map(entry => [String(entry.galleryId), entry]));
  const structural = metas.filter(meta => meta?.parentId || (Array.isArray(meta?.chapters) && meta.chapters.length > 1));
  const actualCounts = await galleryImageCounts(structural.map(meta => meta.galleryId));
  const owners = new Set();
  let fixed = 0;

  for (let i = 0; i < structural.length; i++) {
    const meta = structural[i];
    const gid = String(meta.galleryId);
    const current = byId.get(gid) || null;
    const valid = current
      && current.count != null
      && current.size != null
      && current.latestAt != null
      && current.addedAt != null
      && current.uploadDate != null
      && Number.isFinite(Number(current.count))
      && Number.isFinite(Number(current.size))
      && Number.isFinite(Number(current.latestAt))
      && Number.isFinite(Number(current.addedAt))
      && Number.isFinite(Number(current.uploadDate))
      && Number(current.count) === actualCounts[i];
    if (valid) continue;

    const records = await getGalleryImageRecords(gid);
    if (records.length) {
      await rebuildGalleryEntry(gid, { silent: true });
      await mutateGallery(gid, { parentId: meta.parentId || null }, { silent: true });
    } else {
      const now = Date.now();
      await galleryPut({
        ...(current || {}),
        galleryId: gid,
        count: 0,
        size: 0,
        latestAt: Number(current?.latestAt) || now,
        addedAt: Number(current?.addedAt) || Number(gid) || now,
        uploadDate: Number(current?.uploadDate ?? meta.uploadDate) || 0,
        ...(meta.parentId ? { parentId: String(meta.parentId) } : { parentId: null }),
      });
    }
    owners.add(String(meta.parentId || gid));
    fixed++;
  }

  for (const ownerId of owners) await refreshSeriesAggregate(ownerId, { silent: true });
  if (fixed) {
    for (const ownerId of owners) publishFeed(ownerId);
  }
  return fixed;
}

// One-time backfill: copy each gallery's published date (metadata.uploadDate) into its stat record,
// so the "Published date" sort runs off the galleries index. Cheap: only rows still missing the
// field pay a metadata read. Returns how many were filled.
export async function backfillUploadDates() {
  const entries = await galleryGetAll();
  const missing = entries.filter(e => e.uploadDate == null);
  if (!missing.length) return 0;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [META_STORE, GALLERY_STORE], 'readwrite');
    tx._work = { kind: 'migration', folder: '*' };   // a field derived from what each holds: galleries out of the library too
    const metas = tx.objectStore(META_STORE);
    const galleries = tx.objectStore(GALLERY_STORE);
    for (const entry of missing) {
      const req = metas.get(String(entry.galleryId));
      req.onsuccess = () => {
        // 0 = unknown published date, so every gallery remains in the index and sorts last.
        galleries.put({ ...entry, uploadDate: Number(req.result?.uploadDate) || 0 });
        _logIn(tx, entry.galleryId, { mark: false });
      };
    }
    tx.oncomplete = () => resolve(missing.length);
    tx.onerror = () => reject(_txError(tx));
  });
}

// ── Pages by (gallery, page number) ──

// The key of page `pageNum` of gallery `gid`, found in `tx` (which includes STORE) and passed to
// `found` — null when there is none. A gallery's keys are walked in key order, so when an
// interrupted overwrite left two keys for one page (I13) the first one answers.
function _pageKeyIn(tx, gid, pageNum, found) {
  const req = tx.objectStore(STORE).index('galleryId').openKeyCursor(IDBKeyRange.only(String(gid)));
  req.onsuccess = () => {
    const c = req.result;
    if (!c) { found(null); return; }
    if (_keyPage(c.primaryKey) === pageNum) { found(String(c.primaryKey)); return; }
    c.continue();
  };
}

// One page's record (as stored, without its pageNum) in `tx`, passed to `found` — null when there
// is none. `at` is the page's { galleryId, pageNum }, or its key.
function _pageIn(tx, at, found) {
  const store = tx.objectStore(STORE);
  const get = (key) => {
    if (key == null) { found(null); return; }
    const req = store.get(key);
    req.onsuccess = () => found(req.result || null);
  };
  if (typeof at === 'string') get(at);
  else _pageKeyIn(tx, at.galleryId, Number(at.pageNum), get);
}

// `key`, when the caller already knows the page's key (pageList's url), reads it directly. Finding it
// by gallery and number walks the gallery's keys one at a time, each step a round trip through a main
// thread that may be busy: a reader scrubbing a long chapter waited on that for every page. A key
// that doesn't answer for this gallery and page falls back to the walk.
export async function pageGet(galleryId, pageNum, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, BLOB_STORE], 'readonly');
    let found = null;
    const use = (rec) => { found = rec; _loadPages(tx, [rec]); };
    const byNumber = () => _pageIn(tx, { galleryId, pageNum }, use);
    if (typeof key !== 'string') byNumber();
    else _pageIn(tx, key, (rec) => (rec && String(rec.galleryId) === String(galleryId) && _keyPage(key) === Number(pageNum) ? use(rec) : byNumber()));
    tx.oncomplete = () => _completed(tx, found).then(resolve, reject);
    tx.onerror = () => reject(_txError(tx));
  });
}

export async function pageHas(galleryId, pageNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, STORE, 'readonly');
    let found = false;
    _pageKeyIn(tx, galleryId, Number(pageNum), (key) => { found = key != null; });
    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(_txError(tx));
  });
}

// A gallery's pages as { pageNum, url }, by page number, from a key-only cursor: no page is loaded,
// so a page grid can list every page without holding the gallery in memory.
export async function pageList(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = _tx(db, STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').openKeyCursor(IDBKeyRange.only(String(galleryId)));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const pageNum = _keyPage(c.primaryKey);
      if (pageNum != null) out.push({ pageNum, url: String(c.primaryKey) });
      c.continue();
    };
    tx.oncomplete = () => resolve(out.sort((a, b) => a.pageNum - b.pageNum));
    tx.onerror = () => reject(_txError(tx));
  });
}

// Store page `pageNum` of a gallery (dbPut does the work): under `key`, which must carry that page
// number, or without one under `local://<gid>/<pageNum>.<type>`. With no number given, the key's
// is the page's. Resolves the page number it was stored as.
const _EXT_OF_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
export async function pagePut(galleryId, pageNum, image, { key, mediaId, meta } = {}) {
  const gid = String(galleryId);
  const n = pageNum == null && key != null ? _keyPage(key) : Number(pageNum);
  if (!Number.isSafeInteger(n) || n < 1) throw new BackendError('invalid', `not a page number: ${pageNum ?? key}`);
  const blob = await imageToBlob(image);
  if (!blob) throw new BackendError('invalid', 'no image');
  const url = key ?? `local://${gid}/${n}.${_EXT_OF_TYPE[blob.type] || 'jpg'}`;
  if (_keyPage(url) !== n) throw new BackendError('invalid', `key ${url} is not page ${n}`);
  await dbPut(url, blob, mediaId ?? gid, gid, meta ? { meta } : {});
  return n;
}

// Study-mode layers for every page of a gallery that has them: { url, bg, bubbles, page }.
// One cursor pass; bg/text layers stay Blobs (the caller makes object URLs lazily).
export async function listGalleryStudyRecords(galleryId) {
  const db = await openDB();
  return new Promise((resolve) => {
    const hits = [];
    const tx = _tx(db, [STORE, BLOB_STORE], 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(String(galleryId)));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { _loadPages(tx, hits); return; }
      const v = cursor.value;
      if (Array.isArray(v.bubbles) && v.bubbles.length) hits.push(v);
      cursor.continue();
    };
    // bg is null only for older metadata-only study records — those render as boxed DOM text.
    // `translated`: the page also has a translated image (otherwise it is these layers).
    tx.oncomplete = () => _withFiles(tx).then(() => resolve(hits.map(v => ({ url: v.url, bg: v.studyBg || null, bubbles: v.bubbles, page: v.studyPage || null,
      job: v.pipeline?.job || null, translated: v.translated != null }))), () => resolve([]));
    tx.onerror = () => resolve([]);
  });
}

// ── Transfer (backup, restore, moving a library) ──
// A gallery's records exactly as stored — metadata, stat record, pages, cover, and the person's own
// marks — read in one transaction and written in one, so a restored gallery arrives whole or not at all.

// Every gallery id the library holds anything for: metadata, a stat record, pages or a cover.
export async function transferIds() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const ids = new Set();
    const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE], 'readonly');
    for (const name of [META_STORE, GALLERY_STORE, COVER_STORE]) {
      const req = tx.objectStore(name).getAllKeys();
      req.onsuccess = () => { for (const k of req.result || []) ids.add(String(k)); };
    }
    const pages = tx.objectStore(STORE).index('galleryId').openKeyCursor(null, 'nextunique');
    pages.onsuccess = () => { const c = pages.result; if (c) { ids.add(String(c.key)); c.continue(); } };
    tx.oncomplete = () => resolve([...ids]);
    tx.onerror = () => reject(_txError(tx));
  });
}

// { meta, stat, pages, cover, personal } for one gallery, images as Blobs (null for what it lacks).
// With `pages: false`, only its metadata, stat record and marks. `unread`: what a picture in a library
// folder that can't be read now is given as — none by default; a backup asks for false, so it lists the
// picture missing (backup-core) rather than leave it out saying nothing (S27).
export async function transferRead(galleryId, { pages: withPages = true, unread = null } = {}) {
  const gid = String(galleryId);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = { meta: null, stat: null, pages: [], cover: null, personal: null };
    const stores = [META_STORE, GALLERY_STORE, PERSONAL_STORE, ...(withPages ? [STORE, COVER_STORE, BLOB_STORE] : [])];
    const tx = _tx(db, stores, 'readonly');
    tx._unread = unread;
    const marks = tx.objectStore(PERSONAL_STORE).get(gid);
    marks.onsuccess = () => { out.personal = marksOf(marks.result); };
    const meta = tx.objectStore(META_STORE).get(gid);
    meta.onsuccess = () => { out.meta = meta.result || null; };
    const stat = tx.objectStore(GALLERY_STORE).get(gid);
    stat.onsuccess = () => { out.stat = _forTransfer(stat.result) || null; };
    if (withPages) {
      const pages = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
      pages.onsuccess = () => { out.pages = pages.result || []; _loadPages(tx, out.pages); };
      const cover = tx.objectStore(COVER_STORE).get(gid);
      cover.onsuccess = () => { out.cover = cover.result || null; _loadCovers(tx, [out.cover]); };
    }
    tx.oncomplete = () => _completed(tx, out).then(resolve, reject);
    tx.onerror = () => reject(_txError(tx));
  });
}

// Write one gallery's records as given (a restore), in one transaction: its metadata, its stat
// record (sort times kept; the published date filled from the metadata when the record predates
// it), its pages and its cover's images — all of it, or nothing. Where the gallery is kept, and what
// only this library knows of it there (`folder`, `dir`, `spilled`, `stamp`, `linked`) and its mark (`born`),
// stay as the record it replaces has them — a gallery with none is made with a mark of its own: a bundle never
// carries them. Its pictures go to its folder first (the
// commit protocol: _writing). Sizes are brought up to date afterwards. Refused before anything is
// written: a page with no page number or no picture, and a page whose key another gallery's page is
// stored under (`conflict`: it would be taken from that gallery — checked again as it commits).
// The person's marks (`personal`) replace the gallery's; a bundle without them (an earlier version's
// backup) has the favorite its metadata kept taken in (_importMarksIn).
// Resolves { pages }: how many pages it stored.
export async function transferWrite({ galleryId = null, meta = null, stat = null, pages = [], cover = null, personal = undefined } = {}, { silent = false } = {}) {
  const gid = String(galleryId ?? meta?.galleryId ?? stat?.galleryId ?? pages[0]?.galleryId ?? '');
  if (!gid) throw new BackendError('invalid', 'a gallery to restore names no gallery');
  for (const rec of pages) {
    if (_keyPage(rec?.url) == null) throw new BackendError('invalid', 'a page to restore has no page number');
    if (!(rec.blob instanceof Blob) && typeof rec.dataUrl !== 'string') throw new BackendError('invalid', `page ${_keyPage(rec.url)} to restore has no picture`);
  }
  const life = await _life(gid);
  const db = await openDB();
  await _writing(gid, async (w) => {
    const taken = await _pageOfAnother(gid, pages.map(r => r.url));
    if (taken) throw new BackendError('conflict', `page ${_keyPage(taken.url)} is stored for gallery ${taken.galleryId}`);
    // A gallery kept in a library folder (or a new one, when new galleries go to one) has its
    // pictures written there first.
    const home = await _home(gid, meta, w);
    pages = pages.map(_pageCopy);
    let left = false;
    for (const rec of pages) if (await _place(home, _pageFiles(rec, _keyPage(rec.url)), w)) left = true;
    if (cover) {
      cover = { ...cover };
      for (const field of ['cover', 'seriesCover']) {
        // A cover that is the first page refers to the page's file.
        const page = cover[field] instanceof Blob && home?.root ? pages.find(r => _isPath(r.blob) && r.blob.size === cover[field].size && _fileOf.get(cover[field]) === r.blob) : null;
        if (page) cover[field] = page.blob;
      }
      if (await _place(home, _coverFiles(cover), w)) left = true;
    }
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE, PERSONAL_STORE], 'readwrite');
      tx._write = w;
      let failure = null;
      // Anything going wrong while the writes are queued aborts them all: nothing queued so far commits.
      const fail = (e) => { if (!failure) { failure = e; try { tx.abort(); } catch {} } };
      tx.oncomplete = () => { w.committed = true; resolve(); };
      tx.onerror = () => reject(failure || _txError(tx));
      try {
        if (meta) tx.objectStore(META_STORE).put(canonicalMeta({ ...meta, galleryId: gid }));
        if (personal !== undefined) {
          const marks = marksOf(personal);
          if (marks) tx.objectStore(PERSONAL_STORE).put({ gid, ...marks }); else tx.objectStore(PERSONAL_STORE).delete(gid);
        } else _importMarksIn(tx, gid, meta);
        const stats = tx.objectStore(GALLERY_STORE);
        if (stat) {
          const cur = stats.get(gid);
          cur.onsuccess = () => {
            stats.put({ ..._forTransfer(stat), galleryId: gid, uploadDate: uploadDateSeconds(stat.uploadDate ?? (Number(meta?.uploadDate) || 0)),
              ..._homeOf(cur.result), ..._homeFields(home, left || !!cur.result?.spilled), ..._born(cur.result) });
            _logIn(tx, gid);
          };
        } else {
          _noteHomeIn(tx, gid, home, left);
          _logIn(tx, gid);
        }
        const images = tx.objectStore(STORE);
        for (const rec of pages) {
          const prev = images.get(rec.url);
          prev.onsuccess = () => {
            if (failure) return;
            try {
              if (prev.result && String(prev.result.galleryId) !== gid) {
                fail(new BackendError('conflict', `page ${_keyPage(rec.url)} is stored for gallery ${prev.result.galleryId}`));
                return;
              }
              images.put(_stash(tx, { ...rec, galleryId: gid }, _refIds(prev.result, PAGE), PAGE));
            } catch (e) { fail(e); }
          };
        }
        const patch = {};
        if (cover?.cover) patch.cover = cover.cover;
        if (cover?.seriesCover) patch.seriesCover = cover.seriesCover;
        if (Object.keys(patch).length) putCoverPatch(tx, gid, patch);
      } catch (e) { fail(e); }
    });
  }, life);
  _forgetOtherSourceLookup(meta?.sourceId, gid, meta?.source);
  if (!silent) publishFeed(gid);
  else scheduleGallerySize(gid);
  return { pages: pages.length };
}
// The first of page keys `urls` another gallery's page is stored under (that page's record), or null.
async function _pageOfAnother(gid, urls) {
  if (!urls.length) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, STORE, 'readonly');
    let found = null;
    for (const url of urls) {
      const req = tx.objectStore(STORE).get(url);
      req.onsuccess = () => { if (!found && req.result && String(req.result.galleryId) !== gid) found = req.result; };
    }
    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(_txError(tx));
  });
}

// ── Raw record access (backup/restore) ──
// Backup streams record-at-a-time and restores records verbatim, so it needs key-level access
// the entity-shaped helpers don't expose. These keep that knowledge here rather than letting
// backup.js hold its own copy of the store names.

// Store an image record exactly as given — no stat arithmetic (a restore writes the gallery
// stat records from the archive itself). Use dbPut for normal page writes.
export async function imageRecordPut(rec) {
  const gid = rec?.galleryId != null ? String(rec.galleryId) : null;
  const life = gid ? await _life(gid) : null;
  const db = await openDB();
  const put = async (w) => {
    const home = gid ? await _home(gid, null, w) : null;
    rec = _pageCopy(rec);
    const left = await _place(home, _pageFiles(rec, _keyPage(rec.url)), w);
    await new Promise((res, rej) => {
      const tx = _tx(db, [STORE, BLOB_STORE, GALLERY_STORE], 'readwrite');
      if (w) tx._write = w;
      const store = tx.objectStore(STORE);
      if (gid) _noteHomeIn(tx, gid, home, left);
      const prev = store.get(rec.url);
      prev.onsuccess = () => { store.put(_stash(tx, rec, _refIds(prev.result, PAGE), PAGE)); if (gid) _logIn(tx, gid); };
      tx.oncomplete = () => { if (w) w.committed = true; res(); };
      tx.onerror = () => rej(_txError(tx));
    });
  };
  await (gid ? _writing(gid, put, life) : put(null));
  if (gid) scheduleGallerySize(gid);
}

async function coverKeysAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const q = _tx(db, COVER_STORE, 'readonly').objectStore(COVER_STORE).getAllKeys();
    q.onsuccess = () => res(q.result || []);
    q.onerror = () => rej(q.error);
  });
}

export async function coverRecordGet(galleryId) {
  return _coverRecord(galleryId);
}

// Delete a gallery's image records whose url is not in keepUrls — a replace-import's or an
// overwrite re-download's stale leftovers (old extensions, old remote-source keys, pages past the
// new set) — then rebuild the stat record so count/size/cover are truthful again. Called only after
// the replacement set is fully written, so an interruption before this point leaves the union of
// old and new pages.
export async function deleteStaleGalleryImages(galleryId, keepUrls) {
  const gid = String(galleryId);
  const keep = new Set(keepUrls || []);
  const db = await openDB();
  let removed = 0;
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, BLOB_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      if (!keep.has(cursor.value.url)) { _dropBlobs(tx, _refIds(cursor.value, PAGE)); cursor.delete(); removed++; _logIn(tx, gid); }
      cursor.continue();
    };
  });
  if (removed) await rebuildGalleryEntry(gid, { silent: true });
  return removed;
}

// ── Shared state ──

export const _sourceIdToGalleryId = new Map();
const _galleryResolvePending      = new Map();
let _lastGeneratedGalleryId       = 0;

const sourceLookupKey = (sid, source) => JSON.stringify([String(source || ''), String(sid)]);

function forgetSourceMapping(sourceId, galleryId, source) {
  const sid = sourceId != null ? String(sourceId) : '';
  if (sid) _sourceIdToGalleryId.delete(sourceLookupKey(sid, source));
  if (galleryId != null) {
    const gid = String(galleryId);
    for (const [k, v] of _sourceIdToGalleryId) {
      if (String(v) === gid) _sourceIdToGalleryId.delete(k);
    }
  }
}

platform.control.on((msg) => {
  if (msg?.type === 'GALLERY_DELETED') forgetSourceMapping(msg.sourceId, msg.galleryId);
});

async function cachedGalleryIdForSource(sid, source) {
  const key = sourceLookupKey(sid, source);
  if (!_sourceIdToGalleryId.has(key)) return null;
  const gid = String(_sourceIdToGalleryId.get(key));
  const meta = await metaGet(gid).catch(() => null);
  if (meta && String(meta.sourceId || '') === sid && String(meta.source || '') === source) return gid;
  forgetSourceMapping(sid, gid, source);
  return null;
}

// ── Gallery ID resolution ──
// Source + reference pairs map to internal gallery ids (timestamps). A first sighting
// creates a stub metadata record so concurrent captures agree on the same internal id. Several
// galleries may share a source and reference (a copy kept on purpose): a lookup answers the first one
// added — a real gallery before any placeholder — so only the lookup itself fills the cache, and a
// metadata write only drops an entry it may have made stale.
function _forgetOtherSourceLookup(sourceId, gid, source) {
  const sid = sourceId != null ? String(sourceId) : '';
  const key = sourceLookupKey(sid, source);
  if (sid && _sourceIdToGalleryId.has(key) && _sourceIdToGalleryId.get(key) !== gid) _sourceIdToGalleryId.delete(key);
}

// The one internal-id mint: Date.now()-sequenced, monotonic per context. Import paths must
// route through this too, so at least the per-context uniqueness guard always applies.
export function nextGalleryId() {
  _lastGeneratedGalleryId = Math.max(Date.now(), _lastGeneratedGalleryId + 1);
  return String(_lastGeneratedGalleryId);
}

async function resolveSourceGalleryId(sid, source) {
  const cached = await cachedGalleryIdForSource(sid, source);
  if (cached) return cached;
  const db = await openDB();
  // Index lookup + stub creation in ONE readwrite transaction: two contexts racing on the same
  // source and reference serialize here, so the loser sees the winner's stub instead of minting a second
  // internal id for the same gallery. (The stub bypasses metaPut deliberately — it carries no
  // title/tags to canonicalize, and metaPut's stat-record touch skips stubs anyway.)
  const gid = await new Promise((resolve, reject) => {
    const tx = _tx(db, META_STORE, 'readwrite');
    let result = null;
    const store = tx.objectStore(META_STORE);
    const req = store.index('sourceId').getAll(sid);   // oldest first: ids are creation times
    req.onsuccess = () => {
      const matches = req.result.filter(m => String(m.source || '') === source);
      const held = matches.find(m => !m.isStub) || matches[0];
      if (held) { result = String(held.galleryId); return; }
      const newGid = nextGalleryId();
      store.put({ galleryId: newGid, sourceId: sid, source, isStub: true });
      result = newGid;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(_txError(tx));
  });
  _sourceIdToGalleryId.set(sourceLookupKey(sid, source), gid);
  return gid;
}

export async function resolveGalleryId(id, source = '') {
  const raw = String(id);
  // Internal ids are Date.now()-derived → always ≥13 digits. Anything that long is treated as
  // already-internal; SOURCE refs that long are rejected at the agent boundary (resolve_gid)
  // so an unusually long external id can never silently bypass resolution.
  if (/^\d{13,}$/.test(raw)) return raw;
  source = String(source || '');
  const key = sourceLookupKey(raw, source);
  if (_galleryResolvePending.has(key)) return _galleryResolvePending.get(key);
  const pending = resolveSourceGalleryId(raw, source).finally(() => {
    if (_galleryResolvePending.get(key) === pending) _galleryResolvePending.delete(key);
  });
  _galleryResolvePending.set(key, pending);
  return pending;
}

// ── Stats / gallery helpers ──

export async function getStats() {
  const f = await _folders();
  const entries = (await galleryGetAll()).filter(g => _mounted(g, f));
  const galleries = {};
  let totalImages = 0, totalSize = 0, totalOrig = 0;
  for (const e of entries) {
    galleries[e.galleryId] = { count: e.count, size: e.size, latestAt: e.latestAt, medianPage: e.medianPage };
    totalImages += e.count;
    totalSize += e.size;
    totalOrig += e.origSize ?? e.size;
  }
  return { totalImages, totalSize, totalOrig, galleries };
}

// ── Integrity snapshot (read-only) ──
// What library-check.js needs to test the library's invariants: every record's identity, links and
// image references, every stored image's id, and each gallery's export size recomputed as
// refreshGallerySize does. One readonly transaction, so the stores are seen at one moment (writers
// wait until it ends); no image is ever loaded. Pages stream gallery by gallery off the galleryId
// index, so only one gallery's records are held at a time.
export async function integritySnapshot() {
  const db = await openDB();
  const title = (m) => { const t = normalizeTitle(m); return String(t.english || t.pretty || t.japanese || '').slice(0, 80); };
  // Images in BLOB_STORE (a picture in a library folder is a file, not checked here).
  const refsOf = (rec, kind) => kind.slots(rec).map(([obj, key]) => obj[key]).filter(v => _isRef(v) && !_isPath(v)).map(v => v[REF]);
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE], 'readonly');
    const out = { metas: [], galleries: [], pages: [], covers: [], images: [], exportSizes: {}, pagesWithoutGallery: 0 };
    let metaById = null, coverById = null;
    const sizeOf = (gid, records) => {
      const cover = coverById.get(gid);
      out.exportSizes[gid] = exportSize(galleryFiles({ meta: metaById.get(gid) || null, records: _numbered(records),
        covers: { gallery: cover?.cover, series: cover?.seriesCover } }));
    };
    const metasReq = tx.objectStore(META_STORE).getAll();
    const galsReq = tx.objectStore(GALLERY_STORE).getAll();
    const coversReq = tx.objectStore(COVER_STORE).getAll();
    const imagesReq = tx.objectStore(BLOB_STORE).getAllKeys();
    const pageTotalReq = tx.objectStore(STORE).count();
    const pageIndexedReq = tx.objectStore(STORE).index('galleryId').count();
    coversReq.onsuccess = () => {
      metaById = new Map(metasReq.result.map(m => [String(m.galleryId), m]));
      coverById = new Map(coversReq.result.map(c => [String(c.galleryId), c]));
      for (const m of metasReq.result) {
        out.metas.push({ gid: String(m.galleryId), title: title(m), isStub: !!m.isStub,
          parentId: m.parentId ? String(m.parentId) : null, chapters: Array.isArray(m.chapters) ? m.chapters.map(c => String(c?.id)) : null,
          sourceId: m.sourceId != null && m.sourceId !== '' ? String(m.sourceId) : null, source: m.source || null });
      }
      for (const g of galsReq.result) {
        const { galleryId, count, size, origSize, latestAt, addedAt, uploadDate, parentId, chapterCount, aggPages, aggSize } = g;
        out.galleries.push({ gid: String(galleryId), count, size, origSize, latestAt, addedAt, uploadDate,
          parentId: parentId ? String(parentId) : null, chapterCount, aggPages, aggSize });
      }
      for (const c of coversReq.result) out.covers.push({ gid: String(c.galleryId), refs: refsOf(c, COVER) });
      let gid = null, group = [];
      const cursor = tx.objectStore(STORE).index('galleryId').openCursor();
      cursor.onsuccess = () => {
        const cur = cursor.result;
        const at = cur ? String(cur.value.galleryId) : null;
        if (gid !== null && at !== gid) { sizeOf(gid, group); group = []; }
        if (!cur) {
          for (const g of out.galleries) if (!(g.gid in out.exportSizes)) sizeOf(g.gid, []);
          return;
        }
        gid = at;
        const rec = cur.value;
        group.push(rec);
        out.pages.push({ url: rec.url, gid, pageNum: _keyPage(rec.url), refs: refsOf(rec, PAGE) });
        cur.continue();
      };
    };
    tx.oncomplete = () => {
      out.images = imagesReq.result.map(String);
      out.pagesWithoutGallery = pageTotalReq.result - pageIndexedReq.result;
      resolve(out);
    };
    tx.onerror = () => reject(_txError(tx));
  });
}

// Purge stubs that never received pages — but spare ones created in the last day, so a gallery
// whose first page (and the metadata that may arrive with it) is still on its way isn't deleted
// out from under it. A stub is invisible and counted nowhere, so the long grace costs nothing.
// Stub ids are Date.now() creation timestamps. Runs from the boot maintenance window — never from
// a read path.
export async function purgePagelessStubs() {
  const allMeta = await metaGetAll();
  const _stubCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const stubs = allMeta.filter(m => m.isStub && Number(m.galleryId) < _stubCutoff);
  if (!stubs.length) return 0;
  const stats = await getStats();
  const pagelessStubs = stubs.filter(m => !(stats.galleries[m.galleryId]?.count > 0));
  await Promise.all(pagelessStubs.map(m =>
    metaDelete(m.galleryId).then(() => galleryDelete(m.galleryId)).catch(() => {})
  ));
  return pagelessStubs.length;
}

// ── Windowed reads (scale: load only the visible page) ──

// 'id' is intentionally absent: it sorts by the gallery's own primary key (the unix-time-based
// id), handled directly below — never an index, so it stays immutable across re-downloads.
const _SORT_INDEX = { updated: 'latestAt', size: 'size', count: 'count', uploadDate: 'uploadDate' };

// One page of galleries, sorted in the database via an index cursor. Memory is bounded
// by `limit`, not by library size, and cover blobs are never loaded.
export async function galleriesPage({ sort = 'updated', dir, offset = 0, limit = 60, merge = true } = {}) {
  const direction = dir === 'asc' ? 'next' : 'prev';
  const f = await _folders();
  const db = await openDB();
  const stats = await new Promise((resolve, reject) => {
    const out = [];
    let skipped = 0;
    const tx = _tx(db, GALLERY_STORE, 'readonly');
    const store = tx.objectStore(GALLERY_STORE);
    // 'id' cursors the primary key (galleryId) itself; everything else uses its sort index.
    const source = sort === 'id' ? store : store.index(_SORT_INDEX[sort] || 'latestAt');
    const req = source.openCursor(null, direction);
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) { resolve(out); return; }
      // Child chapters normally appear only inside their series; the unmerged view (merge:false)
      // lists every gallery instead. We skip manually instead of cur.advance because offset counts
      // visible rows only.
      if (merge && cur.value.parentId) { cur.continue(); return; }
      if (!_mounted(cur.value, f)) { cur.continue(); return; }
      if (skipped < offset) { skipped++; cur.continue(); return; }
      out.push(cur.value);
      if (out.length >= limit) { resolve(out); return; }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const [metas, marks] = await Promise.all([Promise.all(stats.map(s => metaGet(s.galleryId))), Promise.all(stats.map(s => personalGet(s.galleryId)))]);
  return stats.map((s, i) => _entityFrom(s.galleryId, s, metas[i], marks[i]));
}

// Number of child chapters (stat records carrying a parentId). The main library subtracts this so
// a series counts as one top-level gallery.
export async function childGalleryCount() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = _tx(db, GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).index('parentId').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => resolve(0);
  });
}

export async function galleriesCount({ merge = true } = {}) {
  const f = await _folders();
  if (f.unmounted.size) return (await galleryGetAll()).filter(g => _mounted(g, f) && (!merge || !g.parentId)).length;
  const db = await openDB();
  const total = await new Promise((resolve, reject) => {
    const req = _tx(db, GALLERY_STORE, 'readonly').objectStore(GALLERY_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  // Unmerged view counts every gallery; merged view counts a series as one top-level row.
  if (!merge) return total;
  return total - await childGalleryCount();
}

// Gallery ids in sorted order, keys only (no records, no covers). Used by search:
// the store filters this list against metadata, then loads only the visible window.
export async function galleryIdsSorted({ sort = 'updated', dir } = {}) {
  const direction = dir === 'asc' ? 'next' : 'prev';
  const f = await _folders();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = _tx(db, GALLERY_STORE, 'readonly');
    const store = tx.objectStore(GALLERY_STORE);
    // 'id' cursors the primary key (galleryId) itself; everything else uses its sort index — keys
    // only, unless some galleries are out of the library (their records then say which).
    const source = sort === 'id' ? store : store.index(_SORT_INDEX[sort] || 'latestAt');
    const req = f.unmounted.size ? source.openCursor(null, direction) : source.openKeyCursor(null, direction);
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) { resolve(out); return; }
      if (!f.unmounted.size || _mounted(c.value, f)) out.push(String(c.primaryKey));
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// gid -> metadata record, for search filtering (metadata holds no cover blobs).
export async function metaGetAllMap() {
  const all = await metaGetAll();
  const f = await _folders();
  const out = f.unmounted.size ? new Set((await galleryGetAll()).filter(g => !_mounted(g, f)).map(g => String(g.galleryId))) : null;
  const map = new Map();
  for (const m of all) if (!out?.has(String(m.galleryId))) map.set(String(m.galleryId), m);
  return map;
}

// How many library entries carry each tag, keyed like the tagNames index (`type:name`, lower-cased).
// Read from that index, so it is never out of step with the tags themselves. An entry is a card in
// the merged library: a series counts once (through its combined tags) and its chapters not on their
// own; metadata that never became a gallery doesn't count. `keys` limits it to those tags, `prefix`
// to one tag type ('artist:'); with neither, every tag in the library.
export async function tagCounts({ keys, prefix } = {}) {
  const f = await _folders();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [META_STORE, GALLERY_STORE], 'readonly');
    const counts = new Map();
    let entries = null, children = null;
    const gals = tx.objectStore(GALLERY_STORE);
    // Only galleries in the library (their records then say which, when some are out of it).
    const allReq = f.unmounted.size ? gals.getAll() : gals.getAllKeys();
    const childReq = gals.index('parentId').getAllKeys();
    const counted = (gid) => entries.has(gid) && !children.has(gid);
    const index = tx.objectStore(META_STORE).index('tagNames');
    childReq.onsuccess = () => {
      entries = new Set(f.unmounted.size ? allReq.result.filter(g => _mounted(g, f)).map(g => String(g.galleryId)) : allReq.result.map(String));
      children = new Set(childReq.result.map(String));
      if (keys) {
        for (const key of new Set(keys)) {
          const req = index.getAllKeys(IDBKeyRange.only(key));
          req.onsuccess = () => { counts.set(key, req.result.filter(gid => counted(String(gid))).length); };
        }
        return;
      }
      const range = prefix ? IDBKeyRange.bound(prefix, prefix + '￿') : null;
      const cur = index.openKeyCursor(range);
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        if (counted(String(c.primaryKey))) counts.set(c.key, (counts.get(c.key) || 0) + 1);
        c.continue();
      };
    };
    tx.oncomplete = () => resolve(counts);
    tx.onerror = () => reject(_txError(tx));
  });
}

export async function getGallery(galleryId) {
  const gid = String(galleryId);
  const [gal, meta, marks, f] = await Promise.all([galleryGet(gid), metaGet(gid), personalGet(gid), _folders()]);
  if (!gal && !meta) return null;
  if (gal && !_mounted(gal, f)) return null;   // its place hidden or removed
  return _entityFrom(gid, gal, meta, marks);
}

export async function getGalleriesByIds(ids) {
  return Promise.all((ids || []).map(id => getGallery(id)));
}

// ── Single write path ──

// Merge a patch into a gallery's metadata and/or stat record, then announce the change
// so every subscribed surface re-renders. The one mutation entry point for gallery
// records — callers never touch metaPut/galleryPut directly. One logical mutation is one
// transaction: metadata and stats can never disagree after an abort mid-way.
// `touch: false` keeps the "Last updated" time — for library upgrades, which change no content.
// `onlyIfExists` leaves a gallery that no longer has metadata alone (see metaPut).
// Resolves whether anything was written.
export async function mutateGallery(galleryId, patch, opts = {}) {
  const gid = String(galleryId);
  const silent = !!opts.silent;
  if (!patch || !Object.keys(patch).length) { if (!silent) publishFeed(gid); return false; }
  // A change to series links keeps every series it touches whole (planRelink).
  if ('parentId' in patch || 'chapters' in patch) {
    return seriesCommand('relink', gid, patch, { touch: opts.touch !== false, onlyIfExists: !!opts.onlyIfExists, silent });
  }
  const db = await openDB();
  let info = { written: false };
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [META_STORE, GALLERY_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
    _mutateIn(tx, gid, patch, { touch: opts.touch !== false, onlyIfExists: !!opts.onlyIfExists }, (r) => { info = r; });
  });
  _afterMutate(gid, info);
  if (!silent) publishFeed(gid);
  else scheduleGallerySize(gid);   // a silent change still moves the gallery's size
  return info.written;
}

// A gallery under a caller-minted id (its creation time), its metadata merged in: an import reserves
// its card this way before its first page arrives. A gallery that already has a stat record keeps
// it (its pages, sizes and sort times); one without gets an empty one.
export async function galleryCreate(galleryId, meta = {}) {
  const gid = String(galleryId);
  const db = await openDB();
  let info = { written: false };
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [META_STORE, GALLERY_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
    _mutateIn(tx, gid, meta, { ensureStat: true }, (r) => { info = r; });
  });
  _afterMutate(gid, info);
  publishFeed(gid);
  return info.written;
}

// The source-id lookup cache after a mutation committed.
function _afterMutate(gid, { prevSourceId = null, nextSourceId = null, nextSource } = {}) {
  if (prevSourceId && String(prevSourceId) !== String(nextSourceId || '')) forgetSourceMapping(prevSourceId, gid);
  _forgetOtherSourceLookup(nextSourceId, gid, nextSource);
}

// mutateGallery's work inside `tx` (which includes META_STORE and GALLERY_STORE). `done` gets
// { written, prevSourceId, nextSourceId } once its writes are issued.
function _mutateIn(tx, gid, patch, { touch = true, onlyIfExists = false, ensureStat = false } = {}, done = () => {}) {
  const metaPatch = {}, galPatch = {};
  // Everything a change names is metadata (kept as given, so a new field travels with the gallery),
  // except what the library derives (gallery-model.js), which only creating a gallery sets.
  for (const [k, v] of Object.entries(patch || {})) {
    if (DERIVED_FIELDS.has(k)) galPatch[k] = v; else metaPatch[k] = v;
  }
  // parentId is denormalized onto BOTH stores: metadata (search exclusion) and the stat record
  // (grid index-cursor exclusion + the aggregate hook). Routing above put it only on metadata.
  if ('parentId' in (patch || {})) galPatch.parentId = patch.parentId;
  const hasMeta = Object.keys(metaPatch).length > 0;
  const hasGal = Object.keys(galPatch).length > 0 || ensureStat;   // ensureStat: create the record if missing
  if (!hasMeta && !hasGal) { done({ written: false }); return; }

  const metas = tx.objectStore(META_STORE);
  const gals = tx.objectStore(GALLERY_STORE);
  let prevSourceId = null, nextSourceId = null;
  const metaReq = metas.get(gid);
  metaReq.onsuccess = () => {
    const curMeta = metaReq.result || null;
    if (onlyIfExists && !curMeta) { done({ written: false }); return; }
    let merged = curMeta || { galleryId: gid };
    if (hasMeta) {
      prevSourceId = curMeta?.sourceId || null;
      // Same canonicalization metaPut applies: title format + tagNames index kept in sync.
      merged = canonicalMeta({ ...merged, ...metaPatch, galleryId: gid });
      nextSourceId = merged.sourceId || null;
      metas.put(merged);
    }
    const galReq = gals.get(gid);
    // `made`: the stat record a gallery that has none is made with.
    const write = (made) => {
      let cur = galReq.result || null;
      // A metadata change marks a REAL gallery updated and keeps the denormalized published
      // date in step (metaPut parity) — never for a bare stub.
      if (hasMeta && cur && !merged.isStub) {
        cur = touch ? { ...cur, latestAt: Math.max(cur.latestAt || 0, Date.now()) } : { ...cur };
        if (merged.uploadDate != null) cur.uploadDate = Number(merged.uploadDate) || 0;
        else if (cur.uploadDate == null) cur.uploadDate = 0;
      }
      if (hasGal) cur = { ...(cur || made), ...galPatch, galleryId: gid };
      if (cur) gals.put(cur);
      _logIn(tx, gid);
      done({ written: true, prevSourceId, nextSourceId, nextSource: merged.source });
    };
    galReq.onsuccess = () => {
      if (!hasGal || galReq.result) { write(null); return; }
      // A new gallery goes where new galleries go, as this transaction reads it.
      const now = Date.now();
      _defaultIn(tx, (folder) => write({ galleryId: gid, count: 0, size: 0, latestAt: now, addedAt: Number(gid) || now,
        uploadDate: Number(merged?.uploadDate) || 0, ...(folder ? { folder } : {}), ..._born() }));
    };
  };
}
// Where a gallery made inside `tx` goes, read in it and passed to `found`: the default folder's id
// while it is shown, else null (this browser).
function _defaultIn(tx, found) {
  const places = tx.objectStore(FOLDER_STORE);
  const req = places.get(DEFAULT_FOLDER);
  req.onsuccess = () => {
    if (!req.result?.folder) { found(null); return; }
    const folder = places.get(req.result.folder);
    folder.onsuccess = () => found(mounted(folder.result?.state) ? req.result.folder : null);
  };
}

// ── Series aggregate ──
// The owner's stat record caches whole-series totals (chapterCount / aggPages / aggSize) so the
// library card reads them O(1) instead of fanning out to every chapter. Recomputed on structural
// changes (merge/remove) and, debounced, whenever a member's size/count shifts (see dbPut).

const _aggTimers = new Map();
export function scheduleSeriesAggregate(ownerId) {
  const oid = String(ownerId);
  if (_aggTimers.has(oid)) return;
  _aggTimers.set(oid, setTimeout(() => {
    _aggTimers.delete(oid);
    refreshSeriesAggregate(oid).catch(() => {});
  }, 400));
}

// The owner's record is read and rewritten in ONE transaction with its chapters' stats, so a page
// stored to the owner meanwhile can't be overwritten by a stale copy of the record.
export async function refreshSeriesAggregate(ownerId, opts = {}) {
  const oid = String(ownerId);
  const silent = !!opts.silent;
  const db = await openDB();
  let changed = false;
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [META_STORE, GALLERY_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
    _aggregateIn(tx, oid, (c) => { changed = c; });
  });
  if (changed && !silent) publishFeed(oid);
}

// Whether records `a` and `b` hold the same fields with the same values (in any order).
const _sameRecord = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => k in b && JSON.stringify(a[k]) === JSON.stringify(b[k]));
};
// refreshSeriesAggregate's work inside `tx` (META_STORE + GALLERY_STORE); `done(changed)` — the owner's stat record
// put and logged only where a total differs from what it holds (S40: as the desktop's _statPut).
function _aggregateIn(tx, oid, done = () => {}) {
  const gals = tx.objectStore(GALLERY_STORE);
  const metaReq = tx.objectStore(META_STORE).get(oid);
  const ownerReq = gals.get(oid);
  ownerReq.onsuccess = () => {
    const owner = ownerReq.result;
    if (!owner) { done(false); return; }
    const chapters = Array.isArray(metaReq.result?.chapters) ? metaReq.result.chapters : null;
    if (!chapters || chapters.length < 2) {
      // No longer a series — strip any stale aggregate so the card falls back to its own stats.
      if (owner.chapterCount != null || owner.aggPages != null || owner.aggSize != null) {
        const { chapterCount, aggPages, aggSize, aggOrig, aggMedianPage, ...rest } = owner;
        gals.put(rest);
        _logIn(tx, oid, { mark: false });
        done(true);
      } else done(false);
      return;
    }
    const chapterStats = new Array(chapters.length);
    let left = chapters.length;
    chapters.forEach((c, i) => {
      const req = gals.get(String(c.id));
      req.onsuccess = () => {
        chapterStats[i] = req.result || null;
        if (--left) return;
        let aggPages = 0, aggSize = 0, aggOrig = 0;
        for (const s of chapterStats) {
          if (s) { aggPages += s.count || 0; aggSize += s.size || 0; aggOrig += s.origSize ?? s.size ?? 0; }
        }
        // The series' typical page: the median of every chapter's pages, from their size tallies (a
        // chapter measured before those were kept stands in with its own median for its pages).
        const aggMedianPage = medianPage(chapterStats.filter(Boolean).flatMap(s => (Array.isArray(s.pageSizes)
          ? s.pageSizes.map(([w, h, n]) => ({ w, h, n }))
          : [{ ...s.medianPage, n: s.count }])));
        const { aggMedianPage: _, ...base } = owner;
        const next = { ...base, chapterCount: chapters.length, aggPages, aggSize, aggOrig, ...(aggMedianPage ? { aggMedianPage } : {}) };
        // Totals that haven't changed aren't written (S40): nothing put, nothing logged.
        if (_sameRecord(next, owner)) { done(false); return; }
        gals.put(next);
        _logIn(tx, oid, { mark: false });
        done(true);
      };
    });
  };
}

// One transaction across every store the gallery lives in — an abort mid-delete can no longer
// leave images without metadata or a cover without its gallery. A series member's series stays
// whole: a chapter leaves its list, an owner hands the series to its next chapter (planDelete).
export async function deleteGallery(galleryId) {
  await seriesCommand('delete', String(galleryId));
}

// deleteGallery's work inside `tx` (every store a gallery lives in); `done(meta)` with the metadata
// it had, once its pages are gone. A gallery with a folder of its own in a library folder shown that
// `tx._deletable` (_writeGates) says can't be changed now is refused, the transaction with it (plan D3,
// principle 8: BackendError 'unavailable', `reason` the folder store's refusal — 'unavailable',
// 'other-library', 'no-permission', 'not-owned' — `folder` its id), so a deletion is never left for a
// folder that comes back (T12); a gallery only forgotten (`tx._keepFiles`) never is.
function _deleteIn(tx, gid, done = () => {}) {
  const metas = tx.objectStore(META_STORE);
  const metaReq = metas.get(gid);
  metaReq.onsuccess = () => {
    const meta = metaReq.result || null;
    metas.delete(gid);
    const stats = tx.objectStore(GALLERY_STORE);
    const stat = stats.get(gid);
    stat.onsuccess = () => {
      const folder = stat.result?.dir ? stat.result.folder : null;
      const why = folder && tx._deletable && !tx._keepFiles ? tx._deletable.get(folder) : null;
      if (why) {
        if (!tx._refused) tx._refused = Object.assign(new BackendError('unavailable', `the library folder of gallery ${gid} can't be written to now`), { reason: why, folder });
        try { tx.abort(); } catch {}
        return;
      }
      // Its folder's deletion notes the claim's counter the folder is held at now (_deleteOne).
      const goneLater = (epoch) => _goneLater(tx, stat.result?.folder, stat.result?.dir, gid, stat.result?.linked || null, stat.result?.packed?.inner || null,
        { stamp: stat.result?.stamp || null, epoch });
      if (folder && !tx._keepFiles) { const at = tx.objectStore(FOLDER_STORE).get(folder); at.onsuccess = () => goneLater(at.result?.epoch ?? null); } else goneLater(null);
      stats.delete(gid);
      tx.objectStore(UNDESCRIBED_STORE).delete(gid);
      _ungroupIn(tx, gid);
    };
    _logIn(tx, gid, { mark: false });
    const covers = tx.objectStore(COVER_STORE);
    const cover = covers.get(gid);
    cover.onsuccess = () => { _dropBlobs(tx, _refIds(cover.result, COVER)); covers.delete(gid); };
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(gid));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { _dropBlobs(tx, _refIds(cursor.value, PAGE)); cursor.delete(); cursor.continue(); }
      else done(meta);
    };
  };
}

// What every window hears once a gallery's deletion committed.
function _afterDelete(gid, meta) {
  forgetSourceMapping(meta?.sourceId, gid);
  platform.control.send({ type: 'GALLERY_DELETED', galleryId: gid, sourceId: meta?.sourceId || null });
  publishFeed(gid);
}

// ── Series reads ──

// The series any gallery belongs to: { ownerId, chapters, seriesTitle, currentId } (`currentId` is
// the gallery asked about), or null for a standalone gallery.
export async function seriesResolve(galleryId) {
  const gid = String(galleryId);
  const meta = await metaGet(gid);
  if (!meta) return null;
  const ownerId = meta.parentId ? String(meta.parentId) : gid;
  const ownerMeta = meta.parentId ? await metaGet(ownerId) : meta;
  if (!ownerMeta || !Array.isArray(ownerMeta.chapters) || ownerMeta.chapters.length < 2) return null;
  return { ownerId, chapters: ownerMeta.chapters, seriesTitle: ownerMeta.seriesTitle || '', currentId: gid };
}

// A series' chapters in order, each { id, title, number?, entity } — `entity` the chapter's gallery,
// or null when it has gone missing.
export async function seriesChapters(ownerId) {
  const meta = await metaGet(String(ownerId));
  const f = await _folders();
  // A chapter whose folder is hidden or removed is out of the library meanwhile: not listed.
  const out = f.unmounted.size ? new Set((await galleryGetAll()).filter(g => !_mounted(g, f)).map(g => String(g.galleryId))) : null;
  const chapters = (Array.isArray(meta?.chapters) ? meta.chapters : []).filter(c => !out?.has(String(c?.id)));
  const entities = await getGalleriesByIds(chapters.map(c => c.id));
  return chapters.map((c, i) => ({ id: String(c.id), title: c.title || '', ...(c.number != null ? { number: c.number } : {}),
    ...(c.kind === 'volume' ? { kind: 'volume' } : {}), entity: entities[i] || null }));
}

// ── Series commands ──
// Each runs in ONE transaction (audit A-04): its plan (series-plan.js) reads the galleries it needs,
// then its writes, its deletions and the totals of every series it touched commit together or not
// at all. A plan that refuses (a BackendError) changes nothing.
const _SERIES_PLANS = {
  attach: planAttach, remove: planRemove, reorder: planReorder, chapterTitle: planChapterTitle, write: planWrite,
  delete: planDelete, deleteSeries: planDeleteSeries, relink: planRelink,
};
export async function seriesCommand(name, ...args) {
  return _seriesCommand(name, args);
}
// The series commands that may delete galleries (series-plan.js `deletes`).
const DELETING_PLANS = new Set(['delete', 'deleteSeries', 'remove', 'write']);
// What each of the library's folders shown refuses a change to its files with now — the folder store's
// open() for 'write' (asked afresh), null where it takes one: Map folder id → refusal | null. (A gallery
// in a folder that isn't shown is refused by the mount check: reason 'hidden'.)
async function _writeGates() {
  const out = new Map();
  for (const [id, f] of (await _folders()).byId) {
    if (!mounted(f.state)) continue;
    const opened = await folderStore.open({ id, location: null }, { purpose: 'write' }).catch(() => ({ status: 'unavailable' }));
    out.set(id, opened.status === 'ok' ? null : opened.status);
  }
  return out;
}
// Series command `name`'s plan over `args`, read in `tx` (which holds META_STORE and GALLERY_STORE): what the plan asks
// for loaded into `read` ({ metas, stats, children }) and planned again, until it plans — then the stat record of every
// gallery it writes or deletes that it hasn't read, so each gallery it reads or changes is read there — `done(plan)`;
// `fail(e)` when it refuses (or asks again for what it has).
function _planIn(tx, name, args, { metas, stats, children }, fail, done) {
  const s = {
    meta: (id) => metas.get(String(id)),
    stat: (id) => stats.get(String(id)),
    children: (id) => children.get(String(id)),
    need: (ids = [], childrenOf = []) => ({ need: { ids: ids.map(String), childrenOf: childrenOf.map(String) } }),
  };
  // Load what the plan asked for, then plan again.
  const load = ({ ids, childrenOf }, next) => {
    const gets = [];
    for (const id of ids) {
      if (!metas.has(id)) gets.push([META_STORE, id, metas]);
      if (!stats.has(id)) gets.push([GALLERY_STORE, id, stats]);
    }
    const kids = childrenOf.filter(id => !children.has(id));
    if (!gets.length && !kids.length) { fail(new BackendError('aborted', `series plan ${name} asked again for what it has`)); return; }
    let left = gets.length + kids.length;
    const one = () => { if (!--left) next(); };
    for (const [store, id, into] of gets) {
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => { into.set(id, req.result || null); one(); };
    }
    for (const id of kids) {
      const req = tx.objectStore(GALLERY_STORE).index('parentId').getAllKeys(IDBKeyRange.only(id));
      req.onsuccess = () => { children.set(id, (req.result || []).map(String)); one(); };
    }
  };
  const step = () => {
    let out;
    try { out = _SERIES_PLANS[name](s, ...args); } catch (e) { fail(e); return; }
    if (out?.need) { load(out.need, step); return; }
    const unread = [...new Set([...[...out.writes].map(([gid]) => String(gid)), ...out.deletes.map(String)])].filter(id => !stats.has(id));
    let left = unread.length;
    if (!left) { done(out); return; }
    for (const id of unread) {
      const req = tx.objectStore(GALLERY_STORE).get(id);
      req.onsuccess = () => { stats.set(id, req.result || null); if (!--left) done(out); };
    }
  };
  step();
}
// `keepFiles`: galleries it deletes keep their files in their library folder (forgotten, not deleted).
async function _seriesCommand(name, args, { keepFiles = false } = {}) {
  if (!_SERIES_PLANS[name]) throw new BackendError('invalid', `no series command ${name}`);
  const began = _now();   // the galleries it is asked for, as they are now
  const db = await openDB();
  // Each as its stat record is read now (_life, S36): the command planned once as the library is, nothing written —
  // the galleries it reads or changes, and their marks.
  const first = await new Promise((resolve) => {
    const read = { metas: new Map(), stats: new Map(), children: new Map() };
    const tx = _tx(db, [META_STORE, GALLERY_STORE], 'readonly');
    _planIn(tx, name, args, read, () => {}, () => {});
    tx.oncomplete = () => resolve(read.stats);
    tx.onerror = () => resolve(read.stats);
  });
  const lifeOf = (id) => _lifeOf(began, id, first.get(id));   // one it hadn't read then: none known of it before
  const metas = new Map(), stats = new Map(), children = new Map();
  // A command that may delete galleries weighs the folders they are in first: a deletion is refused
  // where its gallery's folder can't take it now (_deleteIn).
  const deletable = !keepFiles && DELETING_PLANS.has(name) ? await _writeGates() : null;
  let plan = null, refused = null;
  const written = new Set(), deleted = [], mutated = [];
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE, PERSONAL_STORE], 'readwrite');
    if (keepFiles) tx._keepFiles = true;
    if (deletable) tx._deletable = deletable;
    tx.oncomplete = () => { for (const [gid] of deleted) _ended(gid); resolve(); };
    tx.onerror = () => reject(refused || _txError(tx));
    tx.onabort = () => reject(refused || _txError(tx));
    const fail = (e) => { refused = e; tx.abort(); };

    // Writes first (a new head's favorite with them), then deletions — a gallery deleted takes the
    // person's marks along; one only forgotten keeps them — then the totals, each issued once the step
    // before has been.
    const apply = () => {
      const gone = new Set(plan.deletes.map(String));
      const writes = [...plan.writes].filter(([gid]) => !gone.has(gid));
      _groupIn(tx, writes.map(([gid]) => gid));   // weighed as one before any of it is published (S32, review 9 B1)
      const marks = tx.objectStore(PERSONAL_STORE);
      if (plan.favorite) {
        const { from, to } = plan.favorite;
        const was = [marks.get(from), marks.get(to)];
        was[1].onsuccess = () => {
          const moved = favoriteMoved(was[0].result, was[1].result);
          for (const [gid, next] of [[from, moved.from], [to, moved.to]]) if (next) { marks.put({ gid, ...next }); written.add(gid); }
        };
      }
      const totals = () => {
        for (const oid of new Set(plan.totals.map(String))) {
          if (!gone.has(oid)) _aggregateIn(tx, oid, (c) => { if (c) written.add(oid); });
        }
      };
      const deletes = () => {
        let left = gone.size;
        if (!left) { totals(); return; }
        for (const gid of gone) {
          if (!keepFiles) marks.delete(gid);
          _deleteIn(tx, gid, (meta) => { deleted.push([gid, meta]); if (!--left) totals(); });
        }
      };
      let left = writes.length;
      if (!left) { deletes(); return; }
      for (const [gid, patch] of writes) {
        _mutateIn(tx, gid, patch, plan.opts.get(gid) || {}, (info) => {
          if (info.written) { written.add(gid); mutated.push([gid, info]); }
          if (!--left) deletes();
        });
      }
    };

    _planIn(tx, name, args, { metas, stats, children }, fail, (out) => {
      // Every gallery it read or changes the one it began for, as this transaction reads it: one deleted meanwhile, in
      // any page (made again under its id, perhaps), refuses it.
      const gone = [...metas.keys(), ...stats.keys()].find(id => !_still(lifeOf(id), stats.get(id)));
      if (gone) { fail(Object.assign(new BackendError('aborted', `gallery ${gone} was deleted meanwhile`), { reason: 'gone' })); return; }
      plan = out;
      apply();
    });
  });
  for (const [gid, info] of mutated) _afterMutate(gid, info);
  const totalled = new Set(plan.totals.map(String));
  for (const [gid, meta] of deleted) {
    _afterDelete(gid, meta);
    if (meta?.parentId && !totalled.has(String(meta.parentId))) scheduleSeriesAggregate(meta.parentId);
  }
  // A silent change still moves the sizes of what it touched; it is announced when they do.
  for (const gid of written) { if (plan.silent) scheduleGallerySize(gid); else publishFeed(gid); }
  return plan.result;
}

// Galleries kept in a library folder go with their folders there — through the write gate, as the
// folders were before anything was cleared: a folder hidden, being removed, out of reach or held by
// another app keeps its files — and only a folder its gallery's description names (_ownsDir).
// `folders` forgets the library folders too (a factory reset).
export async function clearAll({ folders = false } = {}) {
  _sourceIdToGalleryId.clear();
  const { byId, removing } = await _folders().catch(() => ({ byId: new Map(), removing: new Map() }));
  const roots = new Map();
  for (const id of [...byId.keys(), ...removing.keys()]) roots.set(id, await _rootOf(id).catch(() => null));
  const me = folders ? await _me().catch(() => null) : null;
  const db = await openDB();
  // Every store in one transaction — "clear everything" must mean everything, including the
  // source icons that earlier versions left behind.
  const stores = [STORE, META_STORE, GALLERY_STORE, COVER_STORE, SOURCE_ICON_STORE, BLOB_STORE, DORMANT_STORE, UNDESCRIBED_STORE, PERSONAL_STORE, ...(folders ? [FOLDER_STORE] : [])];
  // Each gallery kept in a folder of its own, with the files it recorded writing there (read before the
  // stores are cleared): { folder, dir, gid, linked, named }. Its folder is deleted by name, as a
  // deletion's is — recorded by this transaction while the folders are kept (DELETING, and its files'
  // notes); deleted at once, where it can be, as the folders are forgotten too.
  const gone = [];
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [...stores, FOLDER_STORE], 'readwrite');
    tx.oncomplete = () => { _era++; resolve(); };   // every gallery's life ends (_life)
    tx.onerror = () => reject(_txError(tx));
    const kept = tx.objectStore(GALLERY_STORE).getAll();
    const pages = tx.objectStore(STORE).getAll();
    const covers = tx.objectStore(COVER_STORE).getAll();
    covers.onsuccess = () => {
      const byGid = new Map();
      for (const g of kept.result || []) {
        if (g.folder && g.dir && (byId.has(g.folder) || removing.has(g.folder))) byGid.set(String(g.galleryId), { folder: g.folder, dir: g.dir, gid: String(g.galleryId), linked: g.linked || null, named: [] });
      }
      for (const [recs, kind] of [[pages.result, PAGE], [covers.result, COVER]]) {
        for (const rec of recs || []) {
          const g = byGid.get(String(rec.galleryId));
          for (const key of g ? _refIds(rec, kind) : []) {
            if (!key.startsWith('file:')) continue;
            const [folder, dir, path, size, mtime] = JSON.parse(key.slice('file:'.length));
            if (folder !== g.folder || dir !== g.dir) continue;
            g.named.push({ name: path, size, mtime });
            if (!folders && !g.linked) _unlinkLater(tx, key);
          }
        }
      }
      gone.push(...byGid.values());
      if (!folders) for (const g of gone) if (!g.linked) tx.objectStore(FOLDER_STORE).put({ id: _deletingKey(g.folder, g.dir), folder: g.folder, dir: g.dir, gid: g.gid });
    };
    for (const storeName of stores) tx.objectStore(storeName).clear();
    if (me) tx.objectStore(FOLDER_STORE).put({ id: INSTANCE, instance: me });   // still this library, to the folders it claimed
    // Places kept: none hides anything any more (what they hid went with the rest).
    if (!folders) {
      const places = tx.objectStore(FOLDER_STORE);
      const all = places.getAll();
      all.onsuccess = () => { for (const r of all.result || []) if (r.state === 'hidden') places.put({ ...r, state: 'shown' }); };
    }
    _logIn(tx, '*');
  });
  for (const g of gone) {
    const root = roots.get(g.folder);
    if (!root) continue;
    if (g.linked) await folderFiles.deleteGalleryIn(g.folder, root, g.dir, g.gid, g.named).catch(() => {});
    else if (folders) await _deleteDir(g.folder, root, g.dir, g.gid, async () => g.named).catch(() => {});
  }
  if (folders) _known.clear();   // the folders forgotten, what the commit gate knew of their claims with them
  _foldersChanged();
  if (!folders) await _applyDeletions().catch(() => {});
}

export async function getGalleryImageRecords(galleryId) {
  const db = await openDB();
  const gid = String(galleryId);
  return new Promise((resolve, reject) => {
    const tx  = _tx(db, [STORE, BLOB_STORE], 'readonly');
    let recs = [];
    const req = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    req.onsuccess = () => { recs = req.result || []; _loadPages(tx, recs); };
    tx.oncomplete = () => _completed(tx, recs).then(resolve, reject);
    tx.onerror    = () => reject(_txError(tx));
  });
}

// Return one page's image as a Blob, transparently decoding a legacy base64 record and
// lazily rewriting it to a Blob on read. variant 'translated' returns the stored
// translated copy when present.
export async function getPageBlob(galleryId, pageNum, variant) {
  const rec = await pageGet(galleryId, pageNum);
  if (!rec) return null;
  const translated = variant === 'translated' ? await translatedImage(rec) : null;
  const wantTranslated = translated != null;
  const blob = await imageToBlob(wantTranslated ? translated : (rec.blob ?? rec.dataUrl));
  if (blob && !wantTranslated && typeof rec.dataUrl === 'string' && rec.blob == null) {
    _rewritePageBlob(rec.url, blob).catch(() => {});  // lazy migrate legacy base64 -> Blob
  }
  return blob;
}

function _rewritePageBlob(url, blob) {
  return openDB().then(db => new Promise((resolve) => {
    const tx = _tx(db, [STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(url);
    req.onsuccess = () => {
      const rec = req.result;
      if (rec && rec.blob == null && typeof rec.dataUrl === 'string') {
        const before = _refIds(rec, PAGE);
        rec.blob = blob;
        delete rec.dataUrl;
        store.put(_stash(tx, rec, before, PAGE));
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  }));
}

// ── Converting a library stored before images were kept apart ──
// Records stored inline move their images out, each written once, when they next change — or all
// at once here. Covers that are a copy of their gallery's first page point at that page's image.

// { pages, converted, remaining }: a page counts as converted once its image lives in BLOB_STORE.
export async function storageLayoutStatus() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, BLOB_STORE, GALLERY_STORE], 'readonly');
    let pages = 0, converted = 0;
    const count = tx.objectStore(STORE).count();
    count.onsuccess = () => { pages = count.result; };
    // Pages kept in a library folder are files, never stored inline.
    const stats = tx.objectStore(GALLERY_STORE).getAll();
    stats.onsuccess = () => { for (const g of stats.result || []) if (g.folder) converted += Number(g.count) || 0; };
    const keys = tx.objectStore(BLOB_STORE).openKeyCursor();
    keys.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      if (String(c.key).endsWith('|page')) converted++;
      c.continue();
    };
    tx.oncomplete = () => resolve({ pages, converted: Math.min(pages, converted), remaining: Math.max(0, pages - converted) });
    tx.onerror = () => reject(_txError(tx));
  });
}

// One batch of page records after `after` (a url; null from the start), converted in one
// transaction: at most CONVERT_BATCH records or CONVERT_BYTES of images, so a stop is never far off.
const CONVERT_BATCH = 25;
const CONVERT_BYTES = 48 * 1024 * 1024;
async function _convertPages(after) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, BLOB_STORE], 'readwrite');
    const out = { last: after, ended: false, converted: 0, legacy: [] };
    let seen = 0, bytes = 0;
    const req = tx.objectStore(STORE).openCursor(after == null ? null : IDBKeyRange.lowerBound(after, true));
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) { out.ended = true; return; }
      const v = c.value;
      out.last = v.url;
      const inline = PAGE.slots(v).map(([obj, key]) => obj[key]).filter(x => x instanceof Blob);
      if (inline.length) {
        c.update(_stash(tx, v, _refIds(v, PAGE), PAGE));
        bytes += inline.reduce((n, x) => n + x.size, 0);
        if (v.blob instanceof Blob) out.converted++;
      } else if (v.blob == null && typeof v.dataUrl === 'string') {
        out.legacy.push(v.url);
      }
      if (++seen < CONVERT_BATCH && bytes < CONVERT_BYTES) c.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(_txError(tx));
  });
}

// A gallery's inline cover: pointed at its first page's image when the two are the same bytes,
// otherwise moved out like any image. Returns whether the record changed.
async function _convertCover(gid) {
  const db = await openDB();
  const read = await new Promise((resolve, reject) => {
    const tx = _tx(db, [COVER_STORE], 'readonly');
    const req = tx.objectStore(COVER_STORE).get(gid);
    tx.oncomplete = () => resolve(req.result || null);
    tx.onerror = () => reject(_txError(tx));
  });
  if (!read || !COVER.slots(read).some(([obj, key]) => obj[key] instanceof Blob)) return false;
  let pointer = null;
  if (read.cover instanceof Blob) {
    const urls = (await pageList(gid)).map(k => k.url);
    const first = urls.length ? await dbGet(urls[0]) : null;
    const image = first?.blob;
    if (image instanceof Blob && image.size === read.cover.size && _stored.get(image) === `${first.url}|page`) {
      const [a, c] = await Promise.all([image.arrayBuffer(), read.cover.arrayBuffer()]);
      const x = new Uint8Array(a), y = new Uint8Array(c);
      if (x.every((v, i) => v === y[i])) pointer = _ref(`${first.url}|page`, image);
    }
  }
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [COVER_STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(COVER_STORE);
    let changed = false;
    const req = store.get(gid);
    req.onsuccess = () => {
      const cur = req.result;
      // Replaced meanwhile: its next change converts it.
      if (!cur || JSON.stringify(cur.coverRevisions || null) !== JSON.stringify(read.coverRevisions || null)) return;
      store.put(_stash(tx, pointer ? { ...cur, cover: pointer } : cur, _refIds(cur, COVER), COVER));
      changed = true;
    };
    tx.oncomplete = () => resolve(changed);
    tx.onerror = () => reject(_txError(tx));
  });
}

// Convert every record still stored inline: pages first, then covers. `onProgress({ phase, done,
// total })` follows it; it stops between batches once `stopped()` (the rest converts as it changes).
// Resolves true when everything was converted.
export async function convertStorage({ onProgress = () => {}, stopped = () => false } = {}) {
  const status = await storageLayoutStatus();
  let done = status.converted, after = null;
  onProgress({ phase: 'pages', done, total: status.pages });
  for (;;) {
    if (stopped()) return false;
    const batch = await _convertPages(after);
    for (const url of batch.legacy) {   // pages stored as data URLs become Blobs first
      const rec = await dbGet(url);
      const blob = rec?.dataUrl ? await imageToBlob(rec.dataUrl) : null;
      if (blob) { await _rewritePageBlob(url, blob); batch.converted++; }
    }
    done += batch.converted;
    after = batch.last;
    onProgress({ phase: 'pages', done: Math.min(done, status.pages), total: status.pages });
    if (batch.ended) break;
  }
  const covers = await coverKeysAll();
  for (let i = 0; i < covers.length; i++) {
    if (stopped()) return false;
    await _convertCover(String(covers[i]));
    onProgress({ phase: 'covers', done: i + 1, total: covers.length });
  }
  return true;
}

// A page a write names (`at`: { galleryId, pageNum }, or its key) as it is stored, read on its own.
async function _pageRaw(at) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, STORE, 'readonly');
    let found = null;
    _pageIn(tx, at, (rec) => { found = rec; });
    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(_txError(tx));
  });
}
// A write to the record of page `at` (as for every write below: its { galleryId, pageNum }, or its
// key) bringing pictures (`fields`, as they go on the record), under its gallery's lock (the commit
// protocol, _writing): `ready(rec)` — the record as stored — first says whether to write at all;
// the pictures are written to the gallery's folder when it is kept in one; then, in one transaction,
// `apply(rec, made)` changes the record as it is now (`made`: `fields` as the record takes them —
// references in place of what was written), unless it returns false: the record is left as it is,
// and what was written is deleted.
async function _pageWrite(at, fields, apply, ready = () => true) {
  const n = typeof at === 'string' ? _keyPage(at) : Number(at.pageNum);
  const gid = typeof at === 'string' ? (await _pageRaw(at))?.galleryId : at.galleryId;
  if (gid == null) return;
  const life = await _life(gid);   // the gallery it is for (_writing)
  const db = await openDB();
  await _writing(String(gid), async (w) => {
    const page = typeof at === 'string' ? at : { galleryId: String(gid), pageNum: n };
    if (!ready(await _pageRaw(page))) return;
    const home = await _home(String(gid), null, w);
    const made = _pageCopy(fields);
    const left = home && n != null ? await _place(home, _pageFiles(made, n), w) : false;
    w.kept = false;
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE, BLOB_STORE, GALLERY_STORE], 'readwrite');
      tx._write = w;
      _pageIn(tx, page, (rec) => {
        if (!rec) return;
        const before = _refIds(rec, PAGE);
        if (apply(rec, made) === false) return;
        w.kept = true;
        _noteHomeIn(tx, rec.galleryId, home, left);
        tx.objectStore(STORE).put(_stash(tx, rec, before, PAGE));
        _logIn(tx, rec.galleryId);
        scheduleGallerySize(rec.galleryId);
      });
      tx.oncomplete = () => { w.committed = true; resolve(); };
      tx.onerror    = () => (tx._refused?.reason === 'gone' ? resolve() : reject(_txError(tx)));   // its gallery deleted meanwhile: nothing changed
    });
  }, life);
}

// ── Translation variants ──
// A translated page is stored as an extra `translated` field on the existing images
// record, leaving the original untouched. IndexedDB records are schemaless, so this
// needs no DB version bump.

// Study bubble fields beyond box/region/src/tr/text that round-trip through backups and exports.
export { BUBBLE_EXTRA_FIELDS } from './storage/gallery-files.js';
// Per-page fields an earlier storage format wrote; dropped whenever a page is translated again.
const RETIRED_FIELDS = ['translatedLang', 'translatedConfig', 'translatedOutputHash', 'translatedJob', 'snapshot',
  'pendingSnapshot', 'studySnapshot', 'priorSnapshot', 'sourceSha256'];

// A page's translation: its output image and the pipeline data that produced it (page-data.js).
// Study layers belong to one translation, so a new one drops the page's previous layers. A null
// `image` means the page is its study layers, stored next (page-image.js). `own` names the
// translation whose settings the page keeps from now on; undefined leaves that as is. `source`: the
// page's source token the translation was made from (pageSources); one the page no longer shows is
// refused, checked before any picture is written and again as the record commits (linked-source.js
// madeFromPage). Resolves { stale }: whether it was refused so (the job counts such pages).
// `at` is the page's { galleryId, pageNum } (or, until every caller moves, its key) — as for every
// write below.
export async function putTranslatedPage(at, image, pipeline, own, source) {
  let stale = false;
  const shows = (rec) => {
    if (!rec || madeFromPage(source, pageToken(_sourcePicture(rec), rec))) return true;
    stale = true;
    return false;
  };
  await _pageWrite(at, { translated: image ?? undefined, pipeline: pipeline ?? undefined }, (rec, made) => {
    if (!shows(rec)) return false;
    delete rec.studyBg;
    delete rec.studyPage;
    delete rec.bubbles;
    for (const key of RETIRED_FIELDS) delete rec[key];
    if (image) { rec.translated = made.translated; delete rec.translatedLayers; }
    else { delete rec.translated; rec.translatedLayers = true; }
    if (pipeline) rec.pipeline = made.pipeline;
    else delete rec.pipeline;
    if (own) rec.own = own;
    else if (own !== undefined) delete rec.own;
  }, shows);
  return { stale };
}
// Gallery `galleryId`'s pages' source tokens, { [pageNum]: token } (linked-source.js pageToken), read
// before their pictures are for work done away from the library (a translation), which gives each back
// with its result (putTranslatedPage `source`).
export async function pageSources(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(String(galleryId)));
    tx.oncomplete = () => resolve(Object.fromEntries(_numbered(req.result || []).filter(r => r.pageNum != null)
      .map(r => [r.pageNum, pageToken(_sourcePicture(r), r)])));
    tx.onerror = () => reject(_txError(tx));
  });
}

// Restore a page's pipeline data from an export: `pipeline`, `own` and `translatedLayers` only,
// leaving its images and study layers as they are.
const _RESTORABLE = ['pipeline', 'own', 'translatedLayers'];
export async function putPageData(at, data) {
  await _pageWrite(at, { pipeline: data?.pipeline ?? undefined }, (rec, made) => {
    const from = made.pipeline !== undefined ? { ...data, pipeline: made.pipeline } : data;
    for (const key of _RESTORABLE) if (from?.[key] !== undefined) rec[key] = from[key];
  });
}

// Pages that keep the settings of translation `own` from now on — or, with null, follow the
// current settings again (page-data.js translationGroups). No picture changes, so no gallery's lock
// is taken: a move of the gallery meanwhile keeps the setting (_withPicturesOf).
export async function setPagesOwn(pages, own) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = _tx(db, [STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    for (const at of pages) {
      _pageIn(tx, at, (rec) => {
        if (!rec) return;
        const before = _refIds(rec, PAGE);
        if (own) rec.own = own;
        else delete rec.own;
        store.put(_stash(tx, rec, before, PAGE));
        _logIn(tx, rec.galleryId);
        scheduleGallerySize(rec.galleryId);
      });
    }
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(_txError(tx));
  });
}

// The output image alone (restoring an export; its pipeline data is restored separately).
// `translatedSrc` is a Blob (preferred — data URLs cost ~33% more storage).
export async function putTranslatedImage(at, translatedSrc) {
  await _pageWrite(at, { translated: translatedSrc ?? undefined }, (rec, made) => { rec.translated = made.translated ?? translatedSrc; });
}

// Study-mode data for one page: { bg, bubbles, page }. `bg` is a Blob (the inpainted page, text
// removed) shared by every bubble — or null for metadata-only (text-mode) study records; each
// bubble is { box, region, tr, src, rbox?, style?, tbox?,
// furi?, text? } where `text` is a Blob (a full-page transparent PNG of just that bubble's
// glyphs, absent on metadata-only records), `box` is the OCR detection region (the hover/click
// border), `region` is the area to clip `bg` to, `rbox` the renderer's layout box, `style`
// renderer hints for DOM-text display, `src` and `tr` preserve their line breaks, `tbox` is the
// rect where the renderer drew, and `furi` contains per-source-line
// [text, reading|null] ruby segments. `page` is {w,h} in
// source pixels. All are stored on the page's images record like `translated`, so they ride
// along in backups and clear on revert. A reader reveals one bubble at a time by overlaying its
// text layer (whole) and clipping the shared bg to its region — or as styled DOM text. With a
// `job`, the layers are stored only while the page still shows that translation's output —
// checked before any picture is written, and again as the record commits.
export async function putPageStudy(at, study, job = null) {
  const shows = (rec) => job == null || rec?.pipeline?.job === job;
  await _pageWrite(at, { studyBg: study.bg ?? undefined, bubbles: study.bubbles }, (rec, made) => {
    if (!shows(rec)) return false;
    rec.studyBg = (made.studyBg ?? study.bg) || null;
    rec.bubbles = made.bubbles ?? study.bubbles;
    rec.studyPage = study.page || null;
  }, (rec) => !rec || shows(rec));
}

// Strips the `translated` field (and any per-bubble study overlays) from every page of a
// gallery, reverting to originals. Returns the number of pages that had a translation removed.
export async function clearGalleryTranslations(galleryId, { keepSnapshots = false } = {}) {
  const db = await openDB();
  const gid = String(galleryId);
  return new Promise((resolve, reject) => {
    let cleared = 0;
    const tx  = _tx(db, [STORE, BLOB_STORE], 'readwrite');
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const v = cursor.value;
      if (v.translated !== undefined || v.translatedLayers || v.bubbles !== undefined || (!keepSnapshots && v.pipeline)) {
        const had = v.translated !== undefined || !!v.translatedLayers;
        const before = _refIds(v, PAGE);
        // Kept snapshots (the pipeline data) let translating again reuse their work. Settings a
        // page keeps stay either way.
        if (!keepSnapshots) delete v.pipeline;
        delete v.translated;
        delete v.translatedLayers;
        delete v.bubbles;
        delete v.studyBg;
        delete v.studyPage;
        for (const key of RETIRED_FIELDS) delete v[key];
        cursor.update(_stash(tx, v, before, PAGE));
        _logIn(tx, gid);
        if (had) cleared++;
      }
      cursor.continue();
    };
    tx.oncomplete = () => { scheduleGallerySize(gid); resolve(cleared); };
    tx.onerror    = () => reject(_txError(tx));
  });
}

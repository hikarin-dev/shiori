// db.js — the app's IndexedDB storage layer: images (Blobs), gallery metadata, gallery stats,
// and covers. This is the single canonical library — pages, the PWA service worker, and the
// extension-hosted agent all read and write the same origin-scoped database through this module.

import * as platform from './platform.js';
import { normalizeTitle, migrateTitle } from './titles.js';
import { imageToBlob, imageToDataUrl } from './image-util.js';
import { isSeriesMeta, effectiveTagsOf, LANG_NAME_TO_CODE, DERIVED_FIELDS, uploadDateSeconds } from './gallery-model.js';
import { translatedImage } from './page-image.js';
import { galleryFiles, exportSize, layoutPath, extOfType, originalExt, galleryName, DESCRIPTION_FILES, descriptionStamp, pageNumberOf } from './gallery-files.js';
import * as folderFiles from './folder-files.js';
import { OWNER_FILE, readClaim, access, nextClaim, releasedClaim, unchangedSince, claimText } from './folder-owner.js';
import { mounted, writeAllowed } from './folder-lifecycle.js';
import { galleryIdOf } from './folder-content.js';
import { LINKED_DIR, SOURCE_FILE, REMOVED_FILE, overlayDir, sourceText, parseSource, sourceKey, parseRemoved, removedText, isRemoved,
  withRemoved, folderPrint, metaFromName, planTitles, zipTitles, sortPictures } from './linked-source.js';
import { zipEntries, sha256Hex } from './zip-read.js';
import { imageSize, medianPage, describePage } from './page-size.js';
import { BackendError } from './backend-error.js';
import { planAttach, planRemove, planReorder, planChapterTitle, planWrite, planDelete, planDeleteSeries, planRelink } from './series-plan.js';

const DB_NAME = 'shiori-cache';
const DB_VERSION = 19;
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

// A gallery's size is its export archive's (gallery-files.js): the original pages plus
// translations, study data, snapshots, covers and metadata — `size` the whole, `origSize` the
// original pages. Always recomputed from what is stored, never adjusted by deltas, so it cannot
// drift. Returns whether it changed. Every change to a gallery comes here (publishFeed,
// scheduleGallerySize), so one kept in a folder has its descriptions written there soon after
// (_describeSoon) — the change itself marked it as not written there yet (_logIn).
export async function refreshGallerySize(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  const stored = await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, META_STORE, COVER_STORE], 'readonly');
    const records = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    const meta = tx.objectStore(META_STORE).get(gid);
    const cover = tx.objectStore(COVER_STORE).get(gid);
    tx.oncomplete = () => resolve({ records: records.result || [], meta: meta.result || null, cover: cover.result || null });
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
  if (stat?.folder) _describeSoon(gid);   // its folder's descriptions follow
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
        if (_isPath(rec.blob)) { page.src = rec.blob; (tx._paths ||= []).push([page, 'src']); continue; }
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
// (`tx._work`: a removal's write-back, a folder read back, a migration) writes such galleries by
// design and isn't checked. A record with no stat (metadata alone) is in no folder.
// A gallery kept in a folder is marked as having changes its folder lacks (UNDESCRIBED_STORE: { gid,
// rev }, the revision of this change) until _describe has written them there — `mark: false` for a
// change no description shows (its size, a series' totals).
const CHANGES_KEPT = 20000;
let _lastRev = 0;   // the newest revision this window has written
function _logIn(tx, gid, { mark = true } = {}) {
  const id = String(gid);
  const seen = (tx._logged ||= new Map()).get(id);
  if (seen) {
    if (mark && !seen.mark) { seen.mark = true; if (seen.folder) _markIn(tx, id, seen.rev); }
    return;
  }
  const entry = { mark, rev: null, folder: null };
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
  stat.onsuccess = () => _placeStateIn(tx, stat.result, (state) => {
    if (!tx._work && !mounted(state)) { _refuseIn(tx, id); return; }
    entry.folder = stat.result?.folder || null;
    if (entry.folder && entry.mark) _markIn(tx, id, entry.rev);
  });
}
const _markIn = (tx, gid, rev) => tx.objectStore(UNDESCRIBED_STORE).put({ gid, rev });
// The state of the place of the gallery whose stat record is `stat`, read in `tx` and passed to
// `found`: its folder's, or this browser's — 'shown' for one with no stat, null for a folder the
// library doesn't know.
function _placeStateIn(tx, stat, found) {
  if (!stat) { found('shown'); return; }
  const req = tx.objectStore(FOLDER_STORE).get(stat.folder || BROWSER);
  req.onsuccess = () => found(req.result ? req.result.state || 'shown' : stat.folder ? null : 'shown');
}
// `tx` aborted: gallery `gid` is out of the library, its place hidden or removed.
function _refuseIn(tx, gid) {
  if (tx._refused) return;
  tx._refused = Object.assign(new BackendError('invalid', `gallery ${gid} is in a hidden library folder`), { reason: 'hidden' });
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
const _pathKey = (ref) => `file:${JSON.stringify([ref.folder, ref.dir, ref.$path])}`;
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
    for (const slot of slots) if (_isPath(slot[0][slot[1]])) (tx._paths ||= []).push(slot);
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
// A gallery's pictures may be kept in a folder the person picked (folder-files.js reads and writes
// them) rather than in this browser's own storage, "this browser" (BROWSER), which is always there.
// FOLDER_STORE holds each folder — { id, name, handle, addedAt, epoch, state, removal? } — and
// { id: '$default', folder } (where new galleries go; none: this browser), { id: BROWSER, state }
// (this browser's own place, once it has been hidden) and { id: '$instance', instance } (this
// library's id among the apps that keep folders). `state` is the place's one lifecycle state
// (folder-lifecycle.js: 'shown', 'hidden', or 'removing' with `removal` { moveTo, discard, before });
// `epoch` the claim's counter this library last held the folder at (folder-owner.js). A gallery kept
// in a folder says so on its stat record: `folder` (the folder's id) and `dir` (its own folder in it,
// reserved and bound to it when its first picture arrives: _reserveDir). Its records refer to a
// picture there by { $path, folder, dir, size, type } where an image in BLOB_STORE has { $blob }:
// `$path` is where the gallery format puts it (gallery-files.js layoutPath — or that name with a
// random part, while a file had the layout name: no write goes over a file a record refers to), so a
// gallery's folder reads like an unzipped export of it — and the gallery's descriptions
// (metadata.json, image_records.json…) are kept beside its pictures a moment after it changes. Cover
// thumbnails stay in BLOB_STORE, being a cache. A write brings its pictures to the folder before its
// transaction and refers to them there; files no record refers to any more go once it has committed
// (the commit protocol: _writing). A context that may not write to the folder (permission not granted
// this visit, another app's claim, the folder hidden) keeps the pictures in BLOB_STORE meanwhile and
// marks the gallery `spilled`; a window that may moves them out (settleFolders).
export const BROWSER = 'browser';
const DEFAULT_FOLDER = '$default';
let _foldersRead = null;
const _grants = new Map();     // folder id → { state, owned, claim, at }: what it allows, asked at most every few seconds
const GRANT_TTL_MS = 5000;
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
function _forgetFolders() { _foldersRead = null; _grants.clear(); _ours.clear(); }
platform.control.on((msg) => { if (msg?.type === 'FOLDERS_CHANGED') _forgetFolders(); });

// What this context may do with folder `id` now: { state (its permission), owned, claim (as read) }.
// It reads a folder it may use; it writes to it only while this library holds its claim
// (folder-owner.js access 'mine'). A folder no app holds — never claimed, or let go by this library
// and untouched since — is claimed here first, and read back: of two apps claiming it at once only
// one goes on. One another app holds, or whose claim can't be read, is read, never written.
async function _access(id) {
  if (!id) return { state: 'unavailable', owned: false, claim: null };
  const hit = _grants.get(id);
  if (hit && Date.now() - hit.at < GRANT_TTL_MS) return hit;
  const folder = await _folderById(id);
  const state = folder ? await folderFiles.permission(folder.handle) : 'unavailable';
  const held = state === 'granted' ? await _holds(folder).catch(() => ({ owned: false, claim: { state: 'damaged' } })) : { owned: false, claim: null };
  const out = { state, ...held, at: Date.now() };
  _grants.set(id, out);
  return out;
}
// The write gate: folder `id`'s handle when this context may change its files now — it can be
// reached, this library holds its claim, and its state allows it (folder-lifecycle.js writeAllowed:
// shown; while it is being removed, that removal's own write-back alone: `work` 'removal') — else
// null. Every change to the files of a library folder goes through here (its claim file aside:
// _holds, _release); what may not be written waits in this browser (`spilled`), or keeps its mark.
async function _rootOf(id, { work = null } = {}) {
  const folder = await _folderById(id);
  if (!folder) return null;
  const a = await _access(id);
  return writeAllowed({ state: folder.state, owned: a.owned, reachable: a.state === 'granted', work }) ? folder.handle : null;
}
const _usable = async (id, opts) => !!(await _rootOf(id, opts));
// Folder `id`'s handle when this context may read it (its permission granted), whatever its state.
async function _readRootOf(id) { return (await _access(id)).state === 'granted' ? (await _folderById(id))?.handle || null : null; }
// A folder of the library's, or one being removed (its galleries read and written back until it is
// forgotten).
async function _folderById(id) { const { byId, removing } = await _folders(); return byId.get(id) || removing.get(id) || null; }

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
const _writeClaim = (id, root, claim) => folderFiles.writeFile(id, root, OWNER_FILE, claimText(claim));
// The claim's counter this library holds folder `id` at, kept on its record: added back after it was
// removed, the folder tells by it whether another app had it meanwhile.
const _noteEpoch = (id, epoch) => _folderWrite((store) => {
  const req = store.get(id);
  req.onsuccess = () => { if (req.result && req.result.epoch !== epoch) store.put({ ...req.result, epoch }); };
});
// Whether this library holds folder `folder`'s claim: { owned, claim (as read) }. One no app holds is
// claimed now, and is this library's only if the claim read back says so.
async function _holds(folder) {
  const me = await _me();
  const held = folder.epoch ?? null;
  let read = await _readClaim(folder.id, folder.handle);
  if (access(read, me, held) === 'free') {
    await _writeClaim(folder.id, folder.handle, nextClaim(read, me, _myLabel(), { held }).claim);
    read = await _readClaim(folder.id, folder.handle);
    if (access(read, me, held) === 'mine') await _noteEpoch(folder.id, read.epoch);
  }
  return { owned: access(read, me, held) === 'mine', claim: read };
}
// Folder `id` let go by this library (it removed it): its claim released, when it holds it.
async function _release(id) {
  const folder = await _folderById(id);
  if (!folder || await folderFiles.permission(folder.handle) !== 'granted') return;
  const next = releasedClaim(await _readClaim(id, folder.handle), await _me());
  if (next) await _writeClaim(id, folder.handle, next);
}
// Another app's claim as the person is told of it: who (`by`), whether it still holds it, since when —
// null for a claim that can't be read.
const _ownerOf = (read) => (read?.state === 'claim' ? { ...(read.by || {}), active: !!read.owner, at: read.at } : null);

// A stat record without its home (what travels with a gallery to another library doesn't), and its
// home alone (what a gallery keeps through a restore of it: transferWrite).
const _withoutHome = (stat) => { if (!stat) return stat; const { folder, dir, spilled, undescribed, stamp, linked, ...rest } = stat; return rest; };
const _homeOf = (stat) => Object.fromEntries(['folder', 'dir', 'spilled', 'stamp', 'linked'].filter(k => stat?.[k] != null).map(k => [k, stat[k]]));

// Where gallery `gid`'s pictures go: null for one kept in this browser, else { folder, dir, root,
// claimed } — `root` the folder's handle when this context may write there (the gate, _rootOf; null:
// they wait in this browser for now), `dir` its folder in it (reserved now — `claimed` — when it has
// none yet, for write `w`). A gallery not stored yet goes where new galleries go; `meta` describes it.
async function _home(gid, meta = null, w = null) {
  const { byId, removing, defaultId } = await _folders();
  const stat = await galleryGet(gid);
  const folder = stat ? stat.folder : defaultId;
  if (!folder || !(byId.has(folder) || removing.has(folder))) return null;
  const home = { folder, dir: stat?.dir || null, root: await _rootOf(folder), claimed: false };
  if (home.root && !home.dir) {
    try { home.dir = await _reserveDir(gid, folder, home.root, meta, w); home.claimed = true; } catch { home.root = null; }
  } else if (home.root && !(await _mayWriteDir(folder, home.root, home.dir, gid).catch(() => false))) {
    home.root = null;   // its folder is another gallery's: nothing is written there
  }
  return home;
}
// The home fields a gallery's stat record takes after a write to `home` (`left`: pictures it left in
// this browser for now).
const _homeFields = (home, left) => (!home ? {} : { folder: home.folder, ...(home.dir ? { dir: home.dir } : {}), ...(left ? { spilled: 1 } : {}) });

// Gallery `gid`'s own folder in folder `folder`, named after it and bound to it by its metadata.json
// (folderFiles.reserveDir) — noted for write `w`, which deletes it should it not commit. Resolves its
// name.
async function _reserveDir(gid, folder, root, meta, w) {
  const m = migrateTitle({ ...(meta || await metaGet(gid) || {}), galleryId: String(gid) });
  const dir = await folderFiles.reserveDir(folder, root, galleryName(m), JSON.stringify(m, null, 2));
  w?.made.push({ folder, root, path: dir, dir: true });
  return dir;
}
// Whether `dir` in a folder is gallery `gid`'s own: its metadata.json names it (folder-content.js
// galleryIdOf), or it is the gallery's overlay. Nothing is deleted from a folder another gallery's
// description names, nor from one no description names.
async function _ownsDir(folder, root, dir, gid) {
  if (dir === overlayDir(gid)) return true;
  return galleryIdOf(await folderFiles.readText(folder, root, `${dir}/metadata.json`).catch(() => null)) === String(gid);
}
// Whether gallery `gid` may write into its folder `dir`: no other gallery's description names it (one
// reserved before folders were bound may not be described yet). Asked once per folder in a context.
const _ours = new Set();   // `${folder}\0${dir}\0${gid}` found to be the gallery's
async function _mayWriteDir(folder, root, dir, gid) {
  const key = `${folder}\0${dir}\0${gid}`;
  if (_ours.has(key)) return true;
  const named = galleryIdOf(await folderFiles.readText(folder, root, `${dir}/metadata.json`));
  if (named != null && named !== String(gid)) return false;
  _ours.add(key);
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
// The place in the gallery format a picture's file stands for: its path without the random part
// folderFiles.writeNew adds to a name in use (study/text/0001-0-3fa2c9e1.webp → study/text/0001-0.webp).
const _layoutOf = (path) => String(path).replace(/-[0-9a-f]{8}(\.[^./]*)$/, '$1');

// The pictures `slots` holds ([obj, key, path, anyPath]: a picture and where the gallery format puts
// it) written to the gallery's folder at `home` and referred to there — each under a name no file has
// (folderFiles.writeNew), noted for write `w` — one already there (read from a file at that place in
// the format; for a cover, from any file of the gallery's) referred to again, not written. Left as
// they are for a gallery kept in this browser. Resolves whether any was left in this browser for now,
// its folder out of reach (the gallery is then `spilled`).
const OUT_OF_REACH = ['NotFoundError', 'NotAllowedError', 'SecurityError', 'InvalidStateError'];
async function _place(home, slots, w) {
  let left = false;
  for (const [obj, key, path, anyPath] of slots) {
    const blob = obj[key];
    if (!home || !(blob instanceof Blob)) continue;
    const known = _fileOf.get(blob);
    // A linked gallery's own picture, in its source in this folder: referred to there, never copied.
    if (known?.ro && known.folder === home.folder) { obj[key] = known; continue; }
    if (!home.root) { left = true; continue; }
    if (known && known.folder === home.folder && known.dir === home.dir && (anyPath || _layoutOf(known.$path) === path)) { obj[key] = known; continue; }
    let written;
    try { written = await folderFiles.writeNew(home.folder, home.root, home.dir, path, blob); } catch (e) {
      // The folder went out of reach (taken away, or its permission withdrawn): kept here for now.
      if (!OUT_OF_REACH.includes(e?.name)) throw e;
      _grants.delete(home.folder);
      home.root = null;
      left = true;
      continue;
    }
    const ref = { $path: written.path, folder: home.folder, dir: home.dir, size: blob.size, type: blob.type };
    w.made.push({ folder: home.folder, root: home.root, path: `${home.dir}/${written.path}`, blob, file: written.file });
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
// `w.committed` once its transaction has — and the files they referred to before are deleted
// (_unlinkLater). What it wrote (`w.made`) is deleted should its records not commit, or commit without
// them (`w.kept` false: the page went meanwhile, its translation was replaced). So a record never
// refers to bytes another write put there, and no two writes to one gallery interleave (a page stored
// while the gallery moves, two tabs, a page and the service worker).
async function _writing(gid, fn) {
  return folderFiles.withLock(`shiori:gallery:${gid}`, async () => {
    const w = { made: [], kept: true, committed: false };
    try { return await fn(w); } finally { if (!w.committed || !w.kept) await _discard(w.made); }
  });
}
// What a write made, deleted: its files, and a folder it reserved, with everything in it.
async function _discard(made) {
  for (const m of made.splice(0).reverse()) {
    if (m.blob) _fileOf.delete(m.blob);
    if (m.file) _fileOf.delete(m.file);
    await (m.dir ? folderFiles.removeDir(m.folder, m.root, m.path) : folderFiles.removeFile(m.folder, m.root, m.path)).catch(() => {});
  }
}

// The files records read in `tx` refer to, put in place of the references once it has completed
// (_loadBlobs lists them): null for one that can't be read (its folder out of reach, or the file gone).
async function _withFiles(tx) {
  const list = tx._paths;
  if (!list?.length) return;
  tx._paths = null;
  let at = 0;
  await Promise.all(Array.from({ length: Math.min(16, list.length) }, async () => {
    while (at < list.length) { const [obj, key] = list[at++]; obj[key] = await _readPath(obj[key]); }
  }));
}
async function _readPath(ref) {
  const root = await _readRootOf(ref.folder).catch(() => null);
  if (!root) return null;
  const file = ref.zip ? await _readEntry(ref.folder, root, ref.dir, ref.$path, ref.type).catch(() => null)
    : await folderFiles.readFile(ref.folder, root, _joinPath(ref.dir, ref.$path), ref.type || undefined);
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
// Entry `name` of the archive at `path`, as a Blob (a slice of the file for one stored as it is).
async function _readEntry(folder, root, path, name, type) {
  const entry = (await _archiveOf(folder, root, path))?.entries.get(name);
  return entry ? entry.blob(type || _typeOfName(name)) : null;
}
// `tx`'s completion, its records' files read.
const _completed = (tx, value) => _withFiles(tx).then(() => value);

// Files let go in `tx`, deleted once it has committed — unless it only forgets them (`_keepFiles`:
// a folder removed from the library keeps its files) — through the write gate (as `tx._work` may
// write): a folder this context may not write to keeps them. A gallery that leaves its folder takes
// its own folder there too (`_goneLater`, `gid` the gallery's: _ownsDir) — a linked one noting its
// source as removed there first (`linked`), so a check of the folder doesn't add it again; should
// that note not be written, its overlay stays.
function _unlinkLater(tx, key) {
  _afterFiles(tx).files.push(key);
}
function _goneLater(tx, folder, dir, gid, linked = null) {
  if (folder && dir) _afterFiles(tx).dirs.push({ folder, dir, gid: String(gid), linked });
}
// `tx._unlinked` settles once they are gone (at once for a transaction that didn't commit).
function _afterFiles(tx) {
  if (!tx._afterFiles) {
    const after = tx._afterFiles = { files: [], dirs: [] };
    let done;
    tx._unlinked = new Promise((resolve) => { done = resolve; });
    tx.addEventListener('complete', () => { (tx._keepFiles ? Promise.resolve() : _unlink(after, tx._work)).catch(() => {}).then(done); });
    tx.addEventListener('abort', () => done());
  }
  return tx._afterFiles;
}
async function _unlink({ files, dirs }, work) {
  const gone = new Set(dirs.map(({ folder, dir }) => `${folder}\0${dir}`));
  for (const key of files) {
    const [folder, dir, path] = JSON.parse(key.slice('file:'.length));
    if (gone.has(`${folder}\0${dir}`)) continue;
    const root = await _rootOf(folder, { work }).catch(() => null);
    if (root) await folderFiles.removeFile(folder, root, `${dir}/${path}`).catch(() => {});
  }
  for (const { folder, dir, gid, linked } of dirs) {
    const root = await _rootOf(folder, { work }).catch(() => null);
    if (!root || !(await _ownsDir(folder, root, dir, gid))) continue;
    if (linked && !(await _noteRemoved(folder, linked, work).then(() => true, () => false))) continue;
    await folderFiles.removeDir(folder, root, dir).catch(() => {});
  }
}

// ── A gallery's descriptions in its folder ──
// What the gallery format describes a gallery with, beside its pictures, so its folder can be read
// back (adding the folder to a library again): written a moment after the gallery last changed, and
// only what changed. A change to a gallery kept in a folder marks it in its own transaction
// (UNDESCRIBED_STORE, _logIn); describing it clears the mark only when no change came since. The
// stat record keeps a stamp of the descriptions as last written or read here (`stamp`,
// gallery-files.js descriptionStamp): a check of the folder tells by it whether another app changed
// them since (folderScan reads such a gallery again).
const DESCRIPTIONS = DESCRIPTION_FILES;
const DESCRIBE_AFTER_MS = 4000;
const _describeTimers = new Map();
function _describeSoon(gid) {
  const id = String(gid);
  clearTimeout(_describeTimers.get(id));
  _describeTimers.set(id, setTimeout(() => { _describeTimers.delete(id); _describe(id).catch(() => {}); }, DESCRIBE_AFTER_MS));
}
// Gallery `gid`'s descriptions as this library holds it, read in one transaction with its mark:
// { stat, wanted: Map name → text (a description it has none of is missing), rev (its mark's: the
// revision of its last change not written to its folder yet; null: none) }, or null for a gallery
// kept in no folder of its own.
async function _wantedDescriptions(gid) {
  const db = await openDB();
  const read = await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, UNDESCRIBED_STORE], 'readonly');
    const stat = tx.objectStore(GALLERY_STORE).get(gid);
    const meta = tx.objectStore(META_STORE).get(gid);
    const pages = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    const cover = tx.objectStore(COVER_STORE).get(gid);
    const mark = tx.objectStore(UNDESCRIBED_STORE).get(gid);
    tx.oncomplete = () => resolve({ stat: stat.result, meta: meta.result, pages: pages.result || [], cover: cover.result, rev: mark.result?.rev ?? null });
    tx.onerror = () => reject(_txError(tx));
  });
  const { stat } = read;
  if (!stat?.folder || !stat.dir || !read.meta) return null;
  const decode = new TextDecoder();
  const wanted = new Map(galleryFiles({ meta: read.meta, records: _numbered(read.pages),
    covers: { gallery: read.cover?.cover, series: read.cover?.seriesCover } })
    .filter(f => DESCRIPTIONS.includes(f.name)).map(f => [f.name, decode.decode(f.source)]));
  return { stat, wanted, rev: read.rev };
}
const _textsOf = (wanted) => Object.fromEntries(DESCRIPTIONS.map(name => [name, wanted.get(name) ?? null]));
// Gallery `gid`'s descriptions written to its folder, under the gallery's lock (no write of its
// pictures interleaves): each that differs written, all of them read back to check, then — in one
// transaction — its mark cleared if no change came since the descriptions were read (a later one is
// written by the next describe) and its stamp kept. Resolves { ok }: whether its folder now describes
// it as the library had it — not when it is kept in no folder of its own, nor in one this context may
// not write to (the gate; `work` 'removal' for a removal's write-back): its mark stays, for
// settleFolders or the removal.
async function _describe(gid, { work = null } = {}) {
  return folderFiles.withLock(`shiori:gallery:${gid}`, async () => {
    const read = await _wantedDescriptions(gid);
    const root = read && await _rootOf(read.stat.folder, { work });
    if (!root || !(await _mayWriteDir(read.stat.folder, root, read.stat.dir, gid))) return { ok: false };
    const { stat, wanted, rev } = read;
    const have = async (name) => folderFiles.readText(stat.folder, root, `${stat.dir}/${name}`);
    for (const name of DESCRIPTIONS) {
      const want = wanted.get(name) ?? null;
      if (want === await have(name).catch(() => undefined)) continue;
      if (want == null) await folderFiles.removeFile(stat.folder, root, `${stat.dir}/${name}`);
      else await folderFiles.writeFile(stat.folder, root, `${stat.dir}/${name}`, want);
    }
    for (const name of DESCRIPTIONS) if (await have(name) !== (wanted.get(name) ?? null)) return { ok: false };
    await _described(gid, rev, descriptionStamp(_textsOf(wanted)));
    return { ok: true };
  });
}
// Inside one transaction: gallery `gid`'s mark cleared when it is still the one of revision `rev`
// (compare-and-clear), and its stamp kept.
async function _described(gid, rev, stamp) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [GALLERY_STORE, UNDESCRIBED_STORE], 'readwrite');
    const marks = tx.objectStore(UNDESCRIBED_STORE), stats = tx.objectStore(GALLERY_STORE);
    const mark = marks.get(gid), stat = stats.get(gid);
    mark.onsuccess = () => { if (mark.result && mark.result.rev === rev) marks.delete(gid); };
    stat.onsuccess = () => { if (stat.result && stat.result.stamp !== stamp) stats.put({ ...stat.result, stamp }); };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
}
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
// (settling it). `tick()` after each picture; `work` 'removal' for a removal's own moves and
// write-back. Resolves whether it moved anything.
async function _relocate(gid, to, tick = () => {}, { work = null } = {}) {
  return _writing(gid, async (w) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const moved = await _relocateOnce(gid, to, tick, work, w);
      if (moved !== 'changed') return moved;
      await _discard(w.made);   // it changed meanwhile: copied again from what it is now
    }
    throw new BackendError('conflict', `gallery ${gid} kept changing while it was being moved`);
  });
}
async function _relocateOnce(gid, to, tick, work, w) {
  const raw = await _rawGallery(gid);
  const stat = raw.stat;
  if (!stat) return false;
  const from = stat.folder || BROWSER;
  const same = from === to;
  if (same && !stat.spilled) return false;
  if (from !== BROWSER && !(await _usable(from, { work }))) throw new BackendError('unavailable', `library folder ${from} can't be reached`);
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
    if (!root) throw new BackendError('unavailable', `library folder ${to} can't be reached`);
    if (same && stat.dir && !(await _mayWriteDir(to, root, stat.dir, gid))) throw new BackendError('conflict', `the folder of gallery ${gid} names another gallery`);
    home = { folder: to, dir: same && stat.dir ? stat.dir : await _reserveDir(gid, to, root, raw.meta, w), root };
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
  if (home && !home.root) throw new BackendError('unavailable', `library folder ${to} went out of reach`);
  const db = await openDB();
  let changed = false, tx;
  await new Promise((resolve, reject) => {
    tx = _tx(db, [STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE], 'readwrite');
    tx._work = work;
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
      // The place it leaves hidden or removed meanwhile: out of the library, nothing of it moves.
      _placeStateIn(tx, cur, (state) => {
        if (!work && !mounted(state)) { _refuseIn(tx, gid); return; }
        const copies = new Map(pages.map(r => [r.url, r]));
        for (const rec of now.result || []) images.put(_stash(tx, _withPicturesOf(rec, copies.get(rec.url)), _refIds(rec, PAGE), PAGE));
        // The cover record as it is now (thumbnails made meanwhile kept), with its images moved.
        const c = curCover.result;
        if (c && cover) {
          const next = { ...c };
          for (const field of ['cover', 'seriesCover']) if (cover[field] != null) next[field] = cover[field];
          covers.put(_stash(tx, next, _refIds(c, COVER), COVER));
        }
        const { spilled, ...kept } = _homeOf(cur);
        stats.put(home ? { ..._withoutHome(cur), ...(same ? kept : {}), folder: home.folder, dir: home.dir } : _withoutHome(cur));
        if (!home) tx.objectStore(UNDESCRIBED_STORE).delete(gid);
        _logIn(tx, gid);   // the place it goes to, and the descriptions it owes there
        if (!same) _goneLater(tx, from === BROWSER ? null : from, cur.dir, gid, cur.linked || null);
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

// What waits in this browser for the library's folders moved out to them, and the descriptions their
// folders lack written there — for every folder this context may write to now (the write gate: a
// hidden folder waits until it is shown, one another app holds until it is taken back). Resolves how
// many galleries had pictures moved out.
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
    try { if (await _relocate(String(stat.galleryId), stat.folder)) settled++; } catch {}
  }
  for (const gid of await _marked()) {
    const stat = await galleryGet(gid);
    if (!byId.has(stat?.folder) || !(await _usable(stat.folder))) continue;
    await _describe(gid).catch(() => {});
  }
  return settled;
}

// ── The library's folders, as the person manages them ──

// Whether this browser can keep galleries in a folder at all.
export const foldersSupported = () => folderFiles.supported();

// The library folders holding galleries that this page may not use yet, but may with one click
// (folderAllow): [{ id, name }]. Reads no gallery unless some folder waits.
export async function foldersWaiting() {
  const { byId } = await _folders();
  const waiting = [];
  // A hidden folder isn't asked for: nothing of it is read or written until it is shown.
  for (const f of byId.values()) if (mounted(f.state) && await folderFiles.permission(f.handle) === 'prompt') waiting.push(f);
  if (!waiting.length) return [];
  const used = new Set((await galleryGetAll()).map(g => g.folder).filter(Boolean));
  return waiting.filter(f => used.has(f.id)).map(f => ({ id: f.id, name: f.name }));
}

async function _folderWrite(fn) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = _tx(db, FOLDER_STORE, 'readwrite');
    fn(tx.objectStore(FOLDER_STORE));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
  });
  _foldersChanged();
}

// Where the library is kept: this browser, then each library folder in the order they were added —
// [{ id, kind: 'browser'|'folder', name, isDefault, access, galleries, size, removable, hidden? }].
// `access`: 'granted', 'prompt' (one click lets this page use it: folderAllow) or 'unavailable' (not
// there). A hidden place counts the galleries it hid.
export async function foldersList() {
  const { byId, defaultId, browser } = await _folders();
  const tally = new Map([[BROWSER, { galleries: 0, size: 0 }], ...[...byId.keys()].map(id => [id, { galleries: 0, size: 0 }])]);
  for (const g of await galleryGetAll()) {
    const t = tally.get(g.folder && byId.has(g.folder) ? g.folder : BROWSER);
    t.galleries++;
    t.size += Number(g.size) || 0;
  }
  const counts = (place) => ({ ...tally.get(place.id), ...(place.state === 'hidden' ? { hidden: true } : {}) });
  const out = [{ id: BROWSER, kind: 'browser', name: '', isDefault: !defaultId, access: 'granted', removable: false, ...counts(browser) }];
  for (const f of [...byId.values()].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))) {
    _grants.delete(f.id);
    const { state, owned, claim } = await _access(f.id);
    const taken = state === 'granted' && !owned;
    out.push({ id: f.id, kind: 'folder', name: f.name, isDefault: f.id === defaultId,
      access: taken ? 'taken' : state === 'denied' ? 'prompt' : state, removable: true, ...counts(f),
      ...(taken ? { owner: _ownerOf(claim) } : {}) });
  }
  return out;
}

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
// Whether gallery `g` (its stat record) is kept in place `id` — for BROWSER, in no folder of the
// library's (`f`: _folders()).
const _keptIn = (id, g, f) => (id === BROWSER ? _placeKey(g, f) === BROWSER : g.folder === id);

// A folder's own id, kept in its .shiori/library.json — the file a desktop library folder keeps its
// id in, the same format — and written the first time: the folder is known by it wherever it is
// reached from (another drive letter, a folder renamed or moved), and removing it from the library
// and adding it again finds what it held. A file that can't be read is an error, never a reason to
// start over under a new id.
const LIBRARY_FILE = '.shiori/library.json';
async function _folderIdOf(handle) {
  const probe = `probe-${Date.now()}-${Math.random()}`;
  try {
    const file = await folderFiles.readFile(probe, handle, LIBRARY_FILE);
    if (file) {
      const id = JSON.parse(await file.text())?.id;
      if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new BackendError('invalid', `${LIBRARY_FILE} names no library id`);
      return id;
    }
    const id = _randomId();
    await folderFiles.writeFile(probe, handle, LIBRARY_FILE, JSON.stringify({ format: 'shiori-library', version: 1, id }, null, 2));
    return id;
  } finally { folderFiles.forgetFolder(probe); }
}
const _refuse = (reason, message) => { const e = new BackendError('invalid', message); e.reason = reason; throw e; };

// A folder the person picked (its handle) joins the library's folders, claimed by this library
// (folder-owner.js). Its galleries are found by checking it (folderScan, which the caller runs next —
// a task of its own) — one removed before as well: the library kept nothing of it. Added back while
// it is being removed, the removal ends and its galleries are back as they were — unless another app
// claimed it meanwhile: what the library has of them is out of date then, and goes (checking the
// folder finds them as they are). Resolves { id, restored } — for a folder already among them, its id and `existed`. Refused
// (`invalid`): a folder inside another of them or holding one (reason 'nested'), a copy of one of
// them (reason 'copy': it carries the same id), and one another app holds (reason 'claimed', `owner`
// who) — unless `force`: this library takes it over.
export async function folderAdd(handle, { force = false } = {}) {
  if (handle?.kind !== 'directory') throw new BackendError('invalid', 'not a folder');
  if (await folderFiles.permission(handle) !== 'granted') throw new BackendError('unavailable', 'the folder can\'t be used');
  const id = await _folderIdOf(handle);
  const { byId, removing } = await _folders();
  const active = byId.get(id);
  if (active) {
    if (!(await active.handle.isSameEntry(handle).catch(() => false))) _refuse('copy', 'the folder is a copy of one of the library\'s folders');
    return active.state === 'hidden' ? folderShow(id) : { id, restored: 0, existed: true };   // a hidden one is shown
  }
  for (const f of byId.values()) {
    if (await f.handle.resolve(handle).catch(() => null) || await handle.resolve(f.handle).catch(() => null)) {
      _refuse('nested', 'a library folder inside another would hold the same galleries twice');
    }
  }
  const me = await _me();
  const before = removing.get(id);
  const read = await _readClaim(id, handle);
  const got = nextClaim(read, me, _myLabel(), { held: before?.epoch ?? null, force });
  if (got.refused) {
    const e = new BackendError('invalid', 'the folder is in use by another app');
    e.reason = 'claimed';
    e.owner = _ownerOf(got.refused);
    throw e;
  }
  if (got.changed) await _writeClaim(id, handle, got.claim);
  const fresh = !!before && unchangedSince(read, me, before.epoch ?? null);
  await _folderWrite((store) => store.put({ id, name: handle.name, handle, addedAt: before?.addedAt ?? Date.now(), epoch: got.claim.epoch, state: 'shown' }));
  folderFiles.forgetFolder(id);
  _grants.delete(id);
  if (before && !fresh) await _dropFolderRecords(id);
  _muchLater();
  const restored = fresh ? (await galleryGetAll()).filter(g => g.folder === id).length : 0;
  return { id, restored };
}

// Folder `id`, taken over by another app, held by this library again (from a click — the person told
// what that risks): what waited in this browser for it moves out. Resolves its access.
export async function folderClaim(id) {
  const folder = (await _folders()).byId.get(id);
  if (!folder) throw new BackendError('not-found', `no library folder ${id}`);
  if (await folderFiles.permission(folder.handle) !== 'granted') throw new BackendError('unavailable', `library folder ${id} can't be reached`);
  const { claim, changed } = nextClaim(await _readClaim(id, folder.handle), await _me(), _myLabel(), { held: folder.epoch ?? null, force: true });
  if (changed) await _writeClaim(id, folder.handle, claim);
  await _noteEpoch(id, claim.epoch);
  const { owned } = await _access(id);   // read back: this library's only if the claim now says so
  if (owned) settleFolders().catch(() => {});
  return owned ? 'granted' : 'taken';
}

// Folder `id` leaves the library's folders — at once (its state 'removing', `removal` { moveTo,
// discard, before }): it is no longer listed, new galleries no longer go to it, and its galleries
// leave the library (out of it meanwhile: _folders `unmounted`; a write to one is refused as it
// commits, _logIn). What it
// still owes the folder — its galleries moved to place `moveTo` first, then everything the library
// has of the rest written there (what waits in this browser moved out, every description that
// differs, a folder of its own for one with no pictures yet), the folder let go — is setAside's work,
// a task of its own (folder-scan.js runFolderRemoval), carried on by the next page opened should it
// be cut short (foldersPending); then the library forgets the folder and its galleries (their files
// stay): added again, it is checked as one never seen. A folder this context can't write to now
// while galleries of it have what only this library has is refused (reason 'unsaved', `galleries`
// how many) — unless `discard`: that is lost. Resolves { id, galleries }: how many leave it.
export async function folderRemove(id, { moveTo = null, discard = false } = {}) {
  const { byId, defaultId, browser } = await _folders();
  if (!byId.has(id)) throw new BackendError('not-found', `no library folder ${id}`);
  const folder = byId.get(id);
  const to = moveTo == null ? null : String(moveTo);
  if (to && !mounted((to === BROWSER ? browser : to !== id && byId.get(to))?.state)) throw new BackendError('not-found', `no place ${to} to move to`);
  // The default leaves with it: this browser is the default again — or, while it is hidden, the first
  // other folder shown (with none, it stays: new galleries need somewhere shown to go).
  let next = null;
  if (defaultId === id && !mounted(browser.state)) {
    next = [...byId.values()].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)).find(f => f.id !== id && mounted(f.state))?.id;
    if (!next) _refuse('default', 'no other place is shown to keep new galleries in');
  }
  const galleries = (await galleryGetAll()).filter(g => g.folder === id).length;
  const now = await _access(id);
  if (!discard && !(now.state === 'granted' && now.owned)) {   // its removal couldn't write back
    const n = (await _unsavedIn(id)).length;
    if (n) {
      const e = new BackendError('invalid', `${n} galleries have changes not saved to library folder ${id}`);
      e.reason = 'unsaved';
      e.galleries = n;
      throw e;
    }
  }
  await _folderWrite((store) => {
    store.put({ ...folder, state: 'removing', removal: { moveTo: to, discard: !!discard, before: folder.state } });
    if (defaultId === id) store.put({ id: DEFAULT_FOLDER, folder: next });
  });
  _muchLater();
  return { id, galleries };
}

// Place `id` (a folder of the library's, or this browser: BROWSER) hidden — at once: it stays listed,
// state 'hidden', and its galleries leave the library (out of it while it is hidden: nothing of
// theirs moves, and nothing is written to it — a write to one of them is refused as it commits,
// _logIn; what they owe the folder is written once it is shown) until it is shown again
// (folderShow). The default place can't be hidden. Resolves { id, galleries }: how many left.
export async function folderHide(id) {
  const key = String(id);
  const { place, hidden } = await _placeOf(key);
  if (!place) throw new BackendError('not-found', `no library folder ${key}`);
  const f = await _folders();
  if (key === (f.defaultId || BROWSER)) _refuse('default', 'the default place stays shown');
  if (hidden) return { id: key, galleries: 0 };
  const galleries = (await galleryGetAll()).filter(g => _keptIn(key, g, f)).length;
  await _folderWrite((store) => store.put({ ...place, state: 'hidden' }));
  _muchLater();
  return { id: key, galleries };
}

// Hidden place `id` shown again: its galleries are back in the library at once. Resolves { id, restored }.
export async function folderShow(id) {
  const key = String(id);
  const { place, hidden } = await _placeOf(key);
  if (!place) throw new BackendError('not-found', `no library folder ${key}`);
  if (!hidden) return { id: key, restored: 0 };
  await _folderWrite((store) => store.put({ ...place, state: 'shown' }));
  const f = await _folders();
  _muchLater();
  settleFolders().catch(() => {});   // what waited while it was hidden is written there now
  return { id: key, restored: (await galleryGetAll()).filter(g => _keptIn(key, g, f)).length };
}

// What folder `id`, removed, still owes it: its galleries moved to the place chosen (each on its own —
// what can't be moved leaves with the rest), then — while this library may write there (its own
// write-back, `work` 'removal': all the write gate and the mount check let in now) — everything
// it has of the rest written there: what waits in this browser moved out, every description that
// differs, and a folder of its own, described, for one with no pictures yet. Then it is let go
// (another app may take it without asking) and forgotten, its galleries' records with it. Should
// something only this library has still not be there (the folder went out of reach meanwhile), it
// isn't removed: back in the state it had before (unless the person chose to discard that) — an error
// (`errorKey` 'lf.task_kept', `unsaved` how many). `onProgress(done, total)` as it goes; it ends there
// once `stopped()`, or once the folder is added back. Resolves { removed, stopped }.
export async function folderSetAside(id, opts = {}) { return _bulkRun(() => _folderSetAside(id, opts)); }
async function _folderSetAside(id, { onProgress = () => {}, stopped = () => false } = {}) {
  const still = async () => (await _folders()).removing.get(id) || null;
  const work = 'removal';
  let done = 0;
  const moveTo = (await still())?.removal?.moveTo;
  if (moveTo) {
    const ids = (await galleryGetAll()).filter(g => g.folder === id).map(g => String(g.galleryId));
    onProgress(0, ids.length);
    for (const gid of ids) {
      if (stopped() || !(await still())) break;
      try { await _relocate(gid, moveTo, () => {}, { work }); } catch {}
      onProgress(++done, ids.length);
    }
  }
  // Gallery `g` (its stat record) brought up to date there — `saved` once it is: its galleries take
  // no writes meanwhile (out of the library: the mount check), so what is written now is all it has.
  const saved = new Set();
  const writeBack = async (g) => {
    const gid = String(g.galleryId);
    if (g.spilled) await _relocate(gid, id, () => {}, { work }).catch(() => {});
    if (!g.dir) await _writing(gid, async (w) => {
      const root = await _rootOf(id, { work });
      const dir = root && await _reserveDir(gid, id, root, null, w);
      if (dir) await _patchStat(gid, (cur) => (cur.dir ? null : { ...cur, dir }));
      w.committed = !!dir;
    }).catch(() => {});
    if (_describeTimers.has(gid)) { clearTimeout(_describeTimers.get(gid)); _describeTimers.delete(gid); }
    const described = await _describe(gid, { work }).catch(() => ({ ok: false }));
    const now = await galleryGet(gid);
    if (described.ok && now && !now.spilled && now.dir) saved.add(gid);
  };
  const unsavedNow = async () => (await _unsavedIn(id)).filter(g => !saved.has(String(g.galleryId)));
  if (!stopped() && await still() && await _usable(id, { work })) {
    const stats = (await galleryGetAll()).filter(g => g.folder === id);
    let written = 0;
    onProgress(0, stats.length);
    for (const g of stats) {
      if (stopped() || !(await still())) break;
      await writeBack(g);
      onProgress(++written, stats.length);
    }
    done += written;
  }
  const place = await still();
  if (!place || stopped()) return { removed: done, stopped: true };
  // One not written (the folder out of reach for a moment) is tried once more.
  const discard = !!place.removal?.discard;
  if (!discard && await _usable(id, { work })) for (const g of await unsavedNow()) await writeBack(g);
  const unsaved = discard ? 0 : (await unsavedNow()).length;
  if (unsaved) {
    // Kept: back as it was before its removal (a hidden one stays hidden).
    const { removal, ...back } = place;
    await _folderWrite((store) => store.put({ ...back, state: removal?.before || 'shown' }));
    _muchLater();
    const e = new BackendError('unavailable', `what library folder ${id} is owed couldn't be written there: it stays`);
    e.errorKey = 'lf.task_kept';
    e.unsaved = unsaved;
    throw e;
  }
  await _release(id).catch(() => {});   // let go: another app may take it without asking
  await _forgetFolder(id);
  return { removed: done, stopped: false };
}
// The galleries of folder `id` with something only this library has — pictures waiting in this
// browser, descriptions not written there yet, or no folder of their own there (one with no pictures
// yet: described only here) — which forgetting the folder would lose.
async function _unsavedIn(id) {
  const marked = await _marked();
  return (await galleryGetAll()).filter(g => g.folder === id && (g.spilled || marked.has(String(g.galleryId)) || !g.dir));
}
// Folder `id` forgotten: every record of its galleries gone (their files stay — the folder has what
// the library had of them), and the folder with them: added again, it is checked as one never seen.
async function _forgetFolder(id) {
  await _dropFolderRecords(id);
  await _folderWrite((store) => store.delete(id));
  folderFiles.forgetFolder(id);
  _muchLater();
}

// What a page should carry on with: folders being removed whose task hasn't ended (`setAside`, for
// folderSetAside) — a folder an earlier version removed among them (IndexedDB 19 made it one being
// removed, so its removal writes back what only the library has of it before forgetting it).
// Galleries an earlier version set aside (DORMANT_STORE) are brought back first — out of the library
// still while their folder is hidden or being removed.
export async function foldersPending() {
  await _unsetAside().catch(() => {});
  const { removing } = await _folders();
  return { setAside: [...removing.values()].map(f => ({ id: f.id, name: f.name || '' })) };
}
async function _unsetAside() {
  const db = await openDB();
  const folders = await new Promise((resolve, reject) => {
    const tx = _tx(db, DORMANT_STORE, 'readonly');
    const req = tx.objectStore(DORMANT_STORE).getAll();
    tx.oncomplete = () => resolve(new Set((req.result || []).map(r => r.folder)));
    tx.onerror = () => reject(_txError(tx));
  });
  for (const folder of folders) await _restoreDormant(folder);
}

// The galleries of folder `folder` let go — their records deleted, their files kept: checking the
// folder finds them as they are there.
async function _dropFolderRecords(folder) {
  const gids = (await galleryGetAll()).filter(g => g.folder === folder).map(g => String(g.galleryId));
  const db = await openDB();
  for (let at = 0; at < gids.length; at += 50) {
    const gone = [];
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE], 'readwrite');
      tx._keepFiles = true;
      tx._work = 'forget';
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(_txError(tx));
      for (const gid of gids.slice(at, at + 50)) _deleteIn(tx, gid, (meta) => gone.push([gid, meta]));
    });
    for (const [gid, meta] of gone) _afterDelete(gid, meta);
  }
}

// The images in BLOB_STORE a gallery's records an earlier version set aside refer to: their ids.
const _asideBlobIds = (rec) => [...rec.pages.flatMap(p => PAGE.slots(p)), ...(rec.cover ? COVER.slots(rec.cover) : [])]
  .map(([obj, key]) => obj[key]?.[REF]).filter(id => typeof id === 'string');

// The galleries place `folder` held when it was removed or hidden, back in the library as they were —
// but not one whose own folder is no longer in it (its images in BLOB_STORE go with it), nor one the
// library has meanwhile. Resolves how many.
async function _restoreDormant(folder) { return _bulkRun(() => _restoreNow(folder)); }
async function _restoreNow(folder) {
  const db = await openDB();
  const aside = await new Promise((resolve, reject) => {
    const tx = _tx(db, DORMANT_STORE, 'readonly');
    const req = tx.objectStore(DORMANT_STORE).index('folder').getAll(IDBKeyRange.only(folder));
    tx.oncomplete = () => resolve(req.result || []);
    tx.onerror = () => reject(_txError(tx));
  });
  if (!aside.length) return 0;
  const root = await _readRootOf(folder);
  const known = new Set(await transferIds());
  const back = [];
  for (const rec of aside) {
    const there = !root || !rec.stat?.dir || (await folderFiles.list(folder, root, rec.stat.dir).catch(() => [])).length > 0;
    const restore = there && !known.has(rec.gid);
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE, DORMANT_STORE], 'readwrite');
      tx._work = 'migration';
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(_txError(tx));
      tx.objectStore(DORMANT_STORE).delete(rec.gid);
      if (!there && !known.has(rec.gid)) for (const blob of _asideBlobIds(rec)) tx.objectStore(BLOB_STORE).delete(blob);
      if (!restore) return;
      if (rec.meta) tx.objectStore(META_STORE).put(canonicalMeta(rec.meta));
      const { undescribed, ...stat } = rec.stat;   // its folder's removal or showing writes it there
      tx.objectStore(GALLERY_STORE).put(stat);
      const images = tx.objectStore(STORE);
      for (const page of rec.pages) images.put(_stash(tx, page, [], PAGE));
      if (rec.cover) tx.objectStore(COVER_STORE).put(_stash(tx, rec.cover, [], COVER));
      _logIn(tx, rec.gid);
    });
    if (restore) { back.push(rec.gid); known.add(rec.gid); }
  }
  await _tidySeriesLinks(back);
  for (const gid of back) publishFeed(gid);
  return back.length;
}

// Where new galleries go: folder `id`, or this browser (BROWSER) — a place shown.
export async function folderSetDefault(id) {
  const folder = id == null || id === BROWSER ? null : String(id);
  const { place, hidden } = await _placeOf(folder || BROWSER);
  if (!place) throw new BackendError('not-found', `no library folder ${folder}`);
  if (hidden) _refuse('hidden', 'a hidden place is never the default');
  await _folderWrite((store) => store.put({ id: DEFAULT_FOLDER, folder }));
}

// This page asks the person to let it use folder `id` (from a click), and moves out what waited in
// this browser for it once it may. Resolves the folder's access, as folderList gives it.
export async function folderAllow(id) {
  const folder = (await _folders()).byId.get(id);
  if (!folder) throw new BackendError('not-found', `no library folder ${id}`);
  const state = await folderFiles.permission(folder.handle, { ask: true });
  _grants.delete(id);
  if (state === 'granted') {
    platform.control.send({ type: 'FOLDERS_CHANGED' });
    settleFolders().catch(() => {});
  }
  return state === 'denied' ? 'prompt' : state;
}

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

// ── Reading a folder back into the library ──
const IMAGE_NAME = /\.(jpe?g|png|webp|gif|avif)$/i;
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const _typeOfName = (name) => TYPE_OF_EXT[String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase()] || '';
const _natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// The folders of the gallery format a gallery's pictures made from its pages live in.
const DERIVED_DIRS = ['translated', 'study/bg', 'study/text', 'pipeline', 'covers'];

// The galleries in folder `id` the library doesn't have, joined to it as they lie: a folder in the
// gallery format (a library folder's gallery, or an unzipped export) with what its descriptions say
// and what was made from its pages — and everything else it holds that Shiori didn't make, as linked
// galleries (linked-source.js: every folder holding pictures, every archive, every PDF a title, its
// files read where they are and what Shiori adds kept in its overlay — one removed from the library
// before isn't added again; one whose overlay is there, as another app or this library left it, comes
// back with it; one moved or renamed is found by its fingerprint). A gallery whose id the library
// already has is a copy, left alone; the folders of the galleries it keeps there aren't looked into.
// A PDF's pages are drawn by a page (pdfsWaiting, addRendered): until then it waits, its overlay made.
// Then the galleries it keeps there are read again whose descriptions changed since this library
// last wrote or read them (another app wrote to the folder) — not one with changes of its own still
// to be written there: those win. `onProgress(done, total, added, step)` as it goes — each step
// counted on its own: 'lf.task_checking' (what the folder holds), 'lf.task_adding' (the galleries
// joining), 'lf.task_comparing' (those it keeps, checked for changes) — and it ends there once
// `stopped()`. Resolves { added, updated, stopped }.
export async function folderScan(id, opts = {}) { return _bulkRun(() => _folderScan(id, opts)); }
async function _folderScan(id, { onProgress = () => {}, stopped = () => false } = {}) {
  if ((await _placeOf(id)).hidden) _refuse('hidden', `library folder ${id} is hidden`);
  const root = await _rootOf(id);
  if (!root) throw new BackendError('unavailable', `library folder ${id} can't be reached`);
  const known = new Set(await transferIds());
  const kept = (await galleryGetAll()).filter(g => g.folder === id && g.dir);
  const ours = new Set(kept.filter(g => !g.linked).map(g => g.dir.toLowerCase()));
  const keptLinked = new Map(kept.filter(g => g.linked).map(g => [sourceKey(g.linked), g]));
  const { layout, files } = await _walkFolder(id, root, ours, stopped);
  const planned = planTitles(files.map(f => ({ path: f.path })), (await _folders()).byId.get(id)?.name || '');
  const overlays = await _overlaysOf(id, root);
  const removed = parseRemoved(await folderFiles.readText(id, root, REMOVED_FILE).catch(() => null));
  const adopted = [], updated = [];
  let step = 'lf.task_checking', total = layout.length + planned.length, done = 0;
  const begin = (next, n) => { step = next; total = n; done = 0; onProgress(0, total, adopted.length, step); };
  const tick = () => onProgress(Math.min(++done, total), total, adopted.length, step);
  begin('lf.task_checking', total);
  for (const dir of layout) {
    if (stopped()) break;
    try {
      const gid = await _adopt(id, root, { dir, layout: true }, known);
      if (gid) { known.add(gid); adopted.push(gid); }
    } catch {}
    tick();
  }
  // Everything else, a title at a time (an archive's titles read from it) — joining the library
  // after, as a step of its own.
  const seen = new Set(), fresh = [], series = [];
  for (const t of planned) {
    if (stopped()) break;
    let titles = [t];
    if (t.kind === 'zip') titles = await _zipTitlesOf(id, root, t).catch(() => []);
    if (t.kind === 'dir') titles = [{ kind: 'dir', path: t.path, name: t.name }];
    const chapters = [];
    for (const title of titles) {
      const key = sourceKey(title);
      seen.add(key);
      if (keptLinked.has(key)) continue;
      const over = overlays.get(key);
      if (over && known.has(over.galleryId)) continue;
      if (!over && isRemoved(removed, title)) continue;
      if (over) fresh.push({ title, gid: over.galleryId });   // its overlay keeps its series
      else if (title.chapter) chapters.push(title);
      else fresh.push({ title });
    }
    if (chapters.length) series.push({ path: t.path, chapters });
    tick();
  }
  // New ones: an overlay whose files moved or were renamed takes them back (the same fingerprint) —
  // as does a gallery the library keeps, its files gone from where it had them.
  const orphans = new Map();
  for (const [key, over] of overlays) if (!seen.has(key) && over.source.fingerprint) orphans.set(over.source.fingerprint, over);
  for (const g of keptLinked.values()) if (!seen.has(sourceKey(g.linked)) && g.linked.fingerprint) orphans.set(g.linked.fingerprint, { galleryId: String(g.galleryId), kept: true });
  begin('lf.task_adding', fresh.length + series.reduce((n, s) => n + s.chapters.length, 0));
  for (const { title, gid } of fresh) {
    if (stopped()) break;
    const print = !gid && orphans.size ? await _fingerprintOf(id, root, title).catch(() => null) : null;
    const was = print && orphans.get(print);
    if (was) orphans.delete(print);
    try {
      if (was?.kept) { if (await _adoptLinked(id, root, title, known, { replace: was.galleryId })) updated.push(was.galleryId); }
      else await _linkTitle(id, root, title, known, gid || was?.galleryId || null, adopted);
    } catch {}
    tick();
  }
  // An archive's chapters, new: joined as a series named after it (the import does the same).
  for (const { path, chapters } of series) {
    if (stopped()) break;
    const made = [];
    for (const title of chapters) {
      const before = adopted.length;
      await _linkTitle(id, root, title, known, null, adopted);
      if (adopted.length > before) made.push({ id: adopted.at(-1), title: title.inner.replace(/\/$/, '').split('/').pop() });
      tick();
    }
    if (made.length >= 2) await _seriesCommand('write', [made[0].id, made, { seriesTitle: metaFromName(path.split('/').pop()).title }]).catch(() => {});
  }
  begin('lf.task_comparing', kept.length);
  const marked = await _marked();
  for (const stat of kept) {
    if (stopped()) break;
    try { if (await _refreshFromFolder(id, root, stat, known, marked)) updated.push(String(stat.galleryId)); } catch {}
    tick();
  }
  await _tidySeriesLinks([...adopted, ...updated]);
  for (const gid of [...adopted, ...updated]) publishFeed(gid);
  return { added: adopted.length, updated: updated.length, stopped: !!stopped() };
}

// Title `title` joined to the library as a linked gallery (`gid`: its overlay's) — a PDF only made
// ready (its overlay; a page draws its pages: pdfsWaiting) unless they are drawn already.
async function _linkTitle(id, root, title, known, gid, adopted) {
  try {
    if (title.kind === 'pdf' && !(await _hasRendered(id, root, gid))) { await _overlayFor(id, root, title, gid || nextGalleryId()); return; }
    const made = await _adoptLinked(id, root, title, known, { gid });
    if (made) { known.add(made); adopted.push(made); }
  } catch {}
}

// Gallery `stat` (kept in folder `id`) read again from its folder when its descriptions there
// changed since this library last wrote or read them — unless it has changes of its own waiting to
// be written there (they win), or its folder no longer describes it. A gallery stamped before stamps
// existed counts as changed only when its descriptions differ from this library's. `marked`: the
// galleries with changes not written to their folders yet (_marked). Resolves whether it was read
// again.
async function _refreshFromFolder(id, root, stat, known, marked) {
  const gid = String(stat.galleryId);
  if (marked.has(gid) || stat.spilled || _feedTimers.has(gid) || _sizeTimers.has(gid) || _describeTimers.has(gid)) return false;
  const texts = {};
  for (const name of DESCRIPTIONS) texts[name] = await folderFiles.readText(id, root, `${stat.dir}/${name}`).catch(() => null);
  if (texts['metadata.json'] == null) return false;
  let described = null;
  try { described = JSON.parse(texts['metadata.json'])?.galleryId; } catch {}
  if (described == null || String(described) !== gid) return false;
  const stamp = descriptionStamp(texts);
  if (stamp === stat.stamp) return false;
  if (!stat.stamp) {
    const mine = await _wantedDescriptions(gid);
    if (mine && descriptionStamp(_textsOf(mine.wanted)) === stamp) {
      await _patchStat(gid, (cur) => ({ ...cur, stamp }));
      return false;
    }
  }
  if (stat.linked) return !!(await _adoptLinked(id, root, stat.linked, known, { replace: gid }));
  return !!(await _adopt(id, root, { dir: stat.dir, layout: true }, known, { replace: gid }));
}

// What folder `id` holds: { layout: [folders in the gallery format the library doesn't keep yet],
// files: [{ path, handle }] — every other file, hidden ones and the library's own .shiori left out,
// nor looking into `skip` (paths, lower-cased: galleries the library keeps there) }.
const WALK_DEPTH = 12;
async function _walkFolder(id, root, skip, stopped) {
  const layout = [], files = [];
  const walk = async (path, depth) => {
    if (stopped() || (path && skip.has(path.toLowerCase()))) return;
    const entries = await folderFiles.list(id, root, path).catch(() => []);
    const names = new Set(entries.map(e => e.name));
    if (path && (names.has('metadata.json') || names.has('image_records.json') || entries.some(e => e.kind === 'directory' && e.name === 'images'))) {
      layout.push(path);
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
      const p = path ? `${path}/${e.name}` : e.name;
      if (e.kind === 'directory') { if (depth < WALK_DEPTH) await walk(p, depth + 1); }
      else files.push({ path: p, handle: e.handle });
    }
  };
  await walk('', 0);
  return { layout, files };
}

// The overlays folder `id` holds (.shiori/linked/*/source.json): source key → { galleryId, source }.
async function _overlaysOf(id, root) {
  const out = new Map();
  for (const e of await folderFiles.list(id, root, LINKED_DIR).catch(() => [])) {
    if (e.kind !== 'directory') continue;
    const read = parseSource(await folderFiles.readText(id, root, `${LINKED_DIR}/${e.name}/${SOURCE_FILE}`).catch(() => null));
    if (read && read.galleryId === e.name) out.set(sourceKey(read.source), read);
  }
  return out;
}

// An archive's titles (linked-source.js zipTitles), as sources.
async function _zipTitlesOf(id, root, t) {
  const archive = await _archiveOf(id, root, t.path);
  if (!archive) return [];
  return zipTitles([...archive.entries.keys()]).map(z => ({ kind: 'zip', path: t.path, ...(z.inner ? { inner: z.inner } : {}), chapter: z.chapter }));
}

// A title's pictures where they are, in order: [{ name (in its folder, or the archive), size }] —
// and its fingerprint and size. Null when they can't be read.
async function _titlePictures(id, root, title) {
  if (title.kind === 'zip') {
    const archive = await _archiveOf(id, root, title.path);
    if (!archive) return null;
    const mine = zipTitles([...archive.entries.keys()]).find(z => z.inner === (title.inner || ''));
    if (!mine) return null;
    return { pictures: mine.pictures.map(name => ({ name, size: archive.entries.get(name).size })), fingerprint: archive.fingerprint, size: archive.size, archive };
  }
  if (title.kind === 'dir') {
    const pictures = [];
    for (const e of await folderFiles.list(id, root, title.path).catch(() => [])) {
      if (e.kind !== 'file' || !IMAGE_NAME.test(e.name) || e.name.startsWith('.')) continue;
      const file = await e.handle.getFile().catch(() => null);
      if (file) pictures.push({ name: e.name, path: e.name, size: file.size });
    }
    const sorted = sortPictures(pictures);
    return { pictures: sorted, fingerprint: await sha256Hex(new TextEncoder().encode(folderPrint(sorted))), size: sorted.reduce((n, p) => n + p.size, 0) };
  }
  const file = await folderFiles.readFile(id, root, title.path);
  if (!file) return null;
  const head = await file.slice(0, 1024 * 1024).arrayBuffer();
  return { pictures: [], fingerprint: `${file.size}:${await sha256Hex(head)}`, size: file.size };
}
const _fingerprintOf = async (id, root, title) => (await _titlePictures(id, root, title))?.fingerprint || null;

// Title `title`'s overlay, made as gallery `gid`'s (its source.json written). Resolves its folder.
async function _overlayFor(id, root, title, gid, read = null) {
  const at = read || await _titlePictures(id, root, title);
  const dir = overlayDir(gid);
  const want = sourceText(gid, { ...title, size: at?.size ?? null, fingerprint: at?.fingerprint ?? null });
  if (await folderFiles.readText(id, root, `${dir}/${SOURCE_FILE}`).catch(() => null) !== want) {
    await folderFiles.writeFile(id, root, `${dir}/${SOURCE_FILE}`, want);
  }
  return dir;
}
// Whether gallery `gid`'s overlay holds pages of its own (a PDF's, drawn).
async function _hasRendered(id, root, gid) {
  if (!gid) return false;
  return (await folderFiles.list(id, root, `${overlayDir(gid)}/images`).catch(() => [])).some(e => e.kind === 'file' && IMAGE_NAME.test(e.name));
}

// A source of folder `id` that left the library (deleted, or moved to another place): noted in the
// folder's removed.json so a check doesn't add it again — read, changed and written while lock
// shiori:removed:<folder> is held, so notes made at once (two deletes, two tabs, the service worker)
// all stay. Rejects when it can't be noted (the folder may not be written to now, or the list can't
// be read).
async function _noteRemoved(id, linked, work = null) {
  const root = await _rootOf(id, { work });
  if (!root) throw new BackendError('unavailable', `library folder ${id} can't be written to`);
  await folderFiles.withLock(`shiori:removed:${id}`, async () => {
    const list = withRemoved(parseRemoved(await folderFiles.readText(id, root, REMOVED_FILE)), linked);
    await folderFiles.writeFile(id, root, REMOVED_FILE, removedText(list));
  });
}

// What a folder in the gallery format holds: its descriptions (`texts`, and as read), and its
// pictures ([path → { size, type }]: images/ and what was made from its pages).
async function _readLayout(folder, root, dir) {
  const texts = {};
  const text = async (name) => (texts[name] = await (await folderFiles.readFile(folder, root, `${dir}/${name}`))?.text().catch(() => null) ?? null);
  const json = async (name) => { try { const t = await text(name); return t == null ? null : JSON.parse(t); } catch { return null; } };
  const files = new Map();
  const meta = await json('metadata.json');
  const records = await json('image_records.json');
  const bubbles = (await json('study/bubbles.json')) || {};
  const manifest = await json('covers/manifest.json');
  for (const sub of ['images', ...DERIVED_DIRS]) {
    for (const e of await folderFiles.list(folder, root, `${dir}/${sub}`).catch(() => [])) {
      if (e.kind !== 'file' || !IMAGE_NAME.test(e.name)) continue;
      const file = await e.handle.getFile().catch(() => null);
      if (file) files.set(`${sub}/${e.name}`, { size: file.size, type: _typeOfName(e.name) });
    }
  }
  return { texts, meta, records, bubbles, manifest, files };
}

// One found folder in the gallery format joined to the library, its records referring to its files
// where they lie. Resolves its id, or null when there is nothing to add (no pages, or a copy of one
// the library has). `replace`: a gallery the library keeps there, read again — its records replaced
// by what its folder holds now (its files stay).
async function _adopt(folder, root, found, known, { replace = null } = {}) {
  const { dir } = found;
  const { texts, meta, records, bubbles, manifest, files } = await _readLayout(folder, root, dir);
  const pictures = _pagePictures(files);
  // One with no pages joins when its folder describes it (a series' record, a chapter not downloaded:
  // written there as its folder left a library).
  if (!pictures.size && !meta) return null;
  const described = meta?.galleryId != null ? String(meta.galleryId) : null;
  if (replace ? described !== replace : described && known.has(described)) return null;
  const gid = replace || (described && /^\d{13,}$/.test(described) ? described : nextGalleryId());
  const now = Date.now();
  const ref = (path) => { const at = _fileAt(files, path); return at ? { $path: at, folder, dir, ...files.get(at) } : null; };
  const entryOf = new Map((Array.isArray(records) ? records : []).map(r => [_keyPage(r?.url), r]).filter(([n]) => n != null));
  const pages = [...pictures].sort((a, b) => a[0] - b[0]).map(([n, path]) => {
    const entry = entryOf.get(n);
    const ext = path.match(/\.(\w+)$/)[1].toLowerCase();
    const url = entry?.url && _keyPage(entry.url) === n ? entry.url : `local://${gid}/${n}.${ext}`;
    return { url, n, record: { url, blob: ref(path), mediaId: String(entry?.mediaId ?? gid), galleryId: gid,
      cachedAt: entry?.cachedAt || now, size: files.get(path).size, ..._derivedRecord(files, bubbles, n, entry, ref) } };
  });
  const record = meta ? { ...meta, galleryId: gid }
    : { galleryId: gid, title: { english: dir.split('/').pop(), japanese: '', pretty: dir.split('/').pop() }, tags: [], numPages: pages.length, isLocalImport: true };
  return _storeAdopted({ folder, dir, gid, record, pages, ownCover: _ownCoverOf(manifest, ref), stamp: descriptionStamp(texts), replace });
}

// The file of a folder in the gallery format (`files`: path → { size, type }, _readLayout) at place
// `path` of the format: that very path, or that path with the random part a write adds while the
// layout name is in use (folderFiles.writeNew) — null when it has neither.
const _fileAt = (files, path) => (files.has(path) ? path : [...files.keys()].find(p => _layoutOf(p) === path) || null);
// Its original pages: page number (gallery-files.js pageNumberOf; a name with none counts by its
// place among them) → path — the layout-named one, when a page has two (one not deleted yet).
function _pagePictures(files) {
  const byN = new Map();
  [...files.keys()].filter(p => /^images\/[^/]+$/.test(p)).sort(_natural.compare).forEach((path, i) => {
    const n = pageNumberOf(path) ?? i + 1;
    if (!byN.has(n) || _layoutOf(path) === path) byN.set(n, path);
  });
  return byN;
}

// A cover of its own, as a folder's covers/manifest.json names it: { cover?, seriesCover? }.
function _ownCoverOf(manifest, ref) {
  const out = {};
  for (const c of manifest?.covers || []) {
    const r = (c?.role === 'gallery' || c?.role === 'series') && typeof c.file === 'string' ? ref(c.file) : null;
    if (r) out[c.role === 'series' ? 'seriesCover' : 'cover'] = r;
  }
  return out;
}

// Title `title` of folder `folder` (linked-source.js: an archive, a folder of pictures, a PDF) joined
// to the library as a linked gallery: its pages referring to its files where they are (read-only),
// in its overlay what Shiori keeps of it — as gallery `gid` (its overlay's, when it has one) or a new
// one. Its metadata is its overlay's when there is one, else an archive's own (metadata.json in it),
// else what its name and folders say. `replace`: a gallery the library keeps, read again (from its
// overlay, its files where `title` says now). Resolves its id, or null when it has no pages.
async function _adoptLinked(folder, root, title, known, { gid: given = null, replace = null } = {}) {
  const at = await _titlePictures(folder, root, title);
  if (!at) return null;
  let embedded = null;
  if (title.kind === 'zip' && !title.inner && at.archive?.entries.has('metadata.json')) {
    try { embedded = JSON.parse(new TextDecoder().decode(await at.archive.entries.get('metadata.json').read())); } catch {}
  }
  const embeddedId = embedded?.galleryId != null && /^\d{13,}$/.test(String(embedded.galleryId)) && !known.has(String(embedded.galleryId)) ? String(embedded.galleryId) : null;
  const gid = replace || given || embeddedId || nextGalleryId();
  if (!replace && known.has(gid)) return null;
  const dir = await _overlayFor(folder, root, title, gid, at);
  const read = await _readLayout(folder, root, dir);
  const now = Date.now();
  const own = (path) => { const p = _fileAt(read.files, path); return p ? { $path: p, folder, dir, ...read.files.get(p) } : null; };
  const source = (p) => ({ $path: p.name, folder, dir: title.path, ro: 1, ...(title.kind === 'zip' ? { zip: 1 } : {}), size: p.size, type: _typeOfName(p.name) });
  const entryOf = new Map((Array.isArray(read.records) ? read.records : []).map(r => [_keyPage(r?.url), r]).filter(([n]) => n != null));
  // Its pages: its files' in order, then pages of its own its overlay holds (a PDF's, drawn).
  const byN = new Map(at.pictures.map((p, i) => [i + 1, { blob: source(p), size: p.size, ext: p.name.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg' }]));
  for (const [n, path] of _pagePictures(read.files)) {
    if (!byN.has(n)) byN.set(n, { blob: own(path), size: read.files.get(path).size, ext: path.match(/\.(\w+)$/)[1].toLowerCase() });
  }
  if (!byN.size) return null;
  const pages = [...byN].sort((a, b) => a[0] - b[0]).map(([n, p]) => {
    const entry = entryOf.get(n);
    const url = entry?.url && _keyPage(entry.url) === n ? entry.url : `local://${gid}/${n}.${p.ext}`;
    return { url, n, record: { url, blob: p.blob, mediaId: String(entry?.mediaId ?? gid), galleryId: gid, cachedAt: entry?.cachedAt || now,
      size: p.size, ..._derivedRecord(read.files, read.bubbles, n, entry, own) } };
  });
  // What its name and folders say: an archive's chapter is named after its folder in it, its tags the
  // archive's.
  const parts = title.path.split('/');
  const file = parts.pop();
  let named;
  if (title.kind === 'zip' && title.inner) {
    const chapter = title.inner.replace(/\/$/, '').split('/').pop();
    named = { title: { english: chapter, japanese: '', pretty: chapter }, tags: metaFromName(file, parts).tags };
  } else {
    named = metaFromName(title.kind === 'dir' ? (title.name || file || (await _folders()).byId.get(folder)?.name || gid) : file, parts);
  }
  const record = read.meta && String(read.meta.galleryId) === gid ? { ...read.meta, galleryId: gid }
    : embedded ? { ...embedded, galleryId: gid }
    : { galleryId: gid, ...named, numPages: pages.length, isLocalImport: true, source: '' };
  const linked = { kind: title.kind, path: title.path, ...(title.inner ? { inner: title.inner } : {}), ...(at.fingerprint ? { fingerprint: at.fingerprint } : {}) };
  return _storeAdopted({ folder, dir, gid, record, pages, ownCover: _ownCoverOf(read.manifest, own),
    stamp: read.texts['metadata.json'] != null ? descriptionStamp(read.texts) : null, replace, extra: { linked } });
}

// A gallery read from its folder stored: its metadata, stat record (`extra` on it) and pages in one
// transaction (`replace`: its records as they were going first, its files staying), then its stat
// rebuilt and a cover of its own put. Resolves its id.
async function _storeAdopted({ folder, dir, gid, record, pages, ownCover = {}, stamp = null, replace = null, extra = {} }) {
  const now = Date.now();
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE], 'readwrite');
    tx._work = 'adopt';
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
    const put = () => {
      tx.objectStore(META_STORE).put(canonicalMeta(record));
      tx.objectStore(GALLERY_STORE).put({ galleryId: gid, count: 0, size: 0, latestAt: now, addedAt: Number(gid) || now,
        uploadDate: uploadDateSeconds(record.uploadDate ?? 0) || 0, folder, dir, ...(record.parentId ? { parentId: String(record.parentId) } : {}),
        ...(stamp ? { stamp } : {}), ...extra });
      const images = tx.objectStore(STORE);
      for (const p of pages) {
        // A key another gallery's page is stored under stays that gallery's: this page takes its own.
        const prev = images.get(p.url);
        prev.onsuccess = () => {
          const rec = prev.result ? { ...p.record, url: `local://${gid}/${p.n}.${p.url.match(/\.(\w+)$/)?.[1] || 'jpg'}` } : p.record;
          images.put(_stash(tx, rec, [], PAGE));
        };
      }
      _logIn(tx, gid, { mark: false });   // its folder describes it as read
    };
    // Read again: its records as they were go first (its files stay), then it is put as its folder has it.
    if (replace) { tx._keepFiles = true; _deleteIn(tx, gid, put); } else put();
  });
  if (replace) platform.control.send({ type: 'COVER_INVALIDATED', galleryId: gid });
  await rebuildGalleryEntry(gid, { silent: true });
  // A cover of its own, where its folder keeps one (rebuilding pointed the cover at the first page).
  if (Object.keys(ownCover).length) {
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [COVER_STORE, BLOB_STORE], 'readwrite');
      putCoverPatch(tx, gid, ownCover);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(_txError(tx));
    });
  }
  return gid;
}

// ── PDFs a library folder holds, drawn by a page ──
// The PDFs found in the library's folders (folderScan made each an overlay) waiting for their pages
// to be drawn: [{ folder, gid, path, name }]. Only folders this context may write to.
export async function pdfsWaiting() {
  const { byId } = await _folders();
  const known = new Set(await transferIds());
  const out = [];
  for (const f of byId.values()) {
    if (!(await _usable(f.id))) continue;
    const root = await _rootOf(f.id);
    const removed = parseRemoved(await folderFiles.readText(f.id, root, REMOVED_FILE).catch(() => null));
    for (const over of (await _overlaysOf(f.id, root)).values()) {
      if (over.source.kind !== 'pdf' || known.has(over.galleryId) || isRemoved(removed, over.source)) continue;
      if (!(await folderFiles.readFile(f.id, root, over.source.path))) continue;
      out.push({ folder: f.id, gid: over.galleryId, path: over.source.path, name: over.source.path.split('/').pop() });
    }
  }
  return out;
}
// The PDF a waiting gallery is drawn from, as a File.
export async function pdfSource(folder, gid) {
  const root = await _rootOf(folder);
  const over = root && [...(await _overlaysOf(folder, root)).values()].find(o => o.galleryId === String(gid));
  if (!over || over.source.kind !== 'pdf') throw new BackendError('not-found', `no PDF waiting as gallery ${gid}`);
  return folderFiles.readFile(folder, root, over.source.path);
}
// A waiting PDF's pages, drawn (`pages`: Blobs in order), kept in its overlay and the gallery joined
// to the library. Resolves its id.
export async function addRendered(folder, gid, pages) {
  const root = await _rootOf(folder);
  if (!root) throw new BackendError('unavailable', `library folder ${folder} can't be reached`);
  const over = [...(await _overlaysOf(folder, root)).values()].find(o => o.galleryId === String(gid));
  if (!over) throw new BackendError('not-found', `no PDF waiting as gallery ${gid}`);
  const dir = overlayDir(gid);
  for (const [i, blob] of pages.entries()) {
    await folderFiles.writeFile(folder, root, `${dir}/${layoutPath.original(i + 1, extOfType(blob.type) || 'webp')}`, blob);
  }
  const known = new Set(await transferIds());
  const made = await _adoptLinked(folder, root, over.source, known, { gid: String(gid) });
  if (made) { await _tidySeriesLinks([made]); publishFeed(made); }
  return made;
}

// A page's record fields made from it, as a gallery's folder holds them (desktop scan.js
// derivedRecord, the same): its translated picture, study layers and pipeline data, referred to
// where they lie.
function _derivedRecord(files, bubbles, n, entry, ref) {
  const out = {};
  const num = String(n).padStart(4, '0');
  const find = (prefix) => [...files.keys()].find(p => p.startsWith(prefix) && /^(-[0-9a-f]{8})?\.\w+$/.test(p.slice(prefix.length)));
  const translated = find(`translated/${num}`);
  if (translated) out.translated = ref(translated);
  const study = bubbles[num];
  const list = Array.isArray(study) ? study : study?.bubbles;
  if (Array.isArray(list) && list.length) {
    out.bubbles = list.filter(b => b?.box).map((b) => {
      const { textFile, ...rest } = b;
      return { ...rest, region: b.region || b.box, tr: b.tr || '', src: b.src || '', text: textFile ? ref(`study/text/${textFile}`) : null };
    });
    const bg = find(`study/bg/${num}`);
    out.studyBg = bg ? ref(bg) : null;
    out.studyPage = Array.isArray(study) ? null : (study.page || null);
  }
  if (entry?.pipeline && typeof entry.pipeline === 'object' && typeof entry.pipeline.job === 'string') {
    const masks = {};
    for (const name of ['raw', 'text']) { const p = find(`pipeline/${num}-${name}`); if (p) masks[name] = ref(p); }
    out.pipeline = { ...entry.pipeline, masks };
    if (typeof entry.own === 'string') out.own = entry.own;
  }
  if (entry?.translatedLayers === true && out.bubbles) out.translatedLayers = true;
  return out;
}

// Series links among galleries just read back that point at galleries the library doesn't have (or
// that don't point back) are dropped; the series that remain have their totals worked out.
async function _tidySeriesLinks(gids) {
  if (!gids.length) return;
  const owners = new Set();
  for (const gid of gids) {
    const meta = await metaGet(gid);
    if (!meta) continue;
    const patch = {};
    if (Array.isArray(meta.chapters)) {
      const kept = [];
      for (const c of meta.chapters) {
        const id = String(c?.id ?? '');
        const member = id === gid ? meta : await metaGet(id);
        if (member && (id === gid || String(member.parentId || '') === gid)) kept.push(c);
      }
      if (kept.length !== meta.chapters.length) patch.chapters = kept.length > 1 ? kept : undefined;
      if (kept.length > 1) owners.add(gid);
    }
    if (meta.parentId) {
      const owner = await metaGet(String(meta.parentId));
      const listed = Array.isArray(owner?.chapters) && owner.chapters.some(c => String(c?.id) === gid);
      if (!listed) patch.parentId = undefined;
      else owners.add(String(meta.parentId));
    }
    if (!Object.keys(patch).length) continue;
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [META_STORE, GALLERY_STORE], 'readwrite');
      tx._work = 'adopt';   // galleries just read back, or brought back still out of the library
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(_txError(tx));
      const next = { ...meta };
      for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete next[k]; else next[k] = v; }
      tx.objectStore(META_STORE).put(canonicalMeta(next));
      if ('parentId' in patch) {
        const stats = tx.objectStore(GALLERY_STORE);
        const req = stats.get(gid);
        req.onsuccess = () => { if (req.result) { const { parentId, ...rest } = req.result; stats.put(rest); } };
      }
      _logIn(tx, gid);
    });
  }
  for (const oid of owners) await refreshSeriesAggregate(oid, { silent: true }).catch(() => {});
}

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
                ..._homeFields(home, left),
              });
              _logIn(tx, gid);   // after its record is made: the folder it takes is checked
            };
          }
        };
      };
    });
  });

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
// the tagNames index is kept in sync automatically for every writer.
function canonicalMeta(meta) {
  const record = migrateTitle(meta);
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
    const tx = _tx(db, [META_STORE, GALLERY_STORE], 'readwrite');
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

export async function galleryPut(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    // Resolve on commit, not request success — a resolved write must not still be able to abort.
    const tx = _tx(db, GALLERY_STORE, 'readwrite');
    tx.objectStore(GALLERY_STORE).put(entry);
    _logIn(tx, entry.galleryId);
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

function putCoverPatch(tx, galleryId, patch) {
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
    _logIn(tx, gid);
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
  const db = await openDB();
  await _writing(gid, async (w) => {
    const home = await _home(gid, null, w);
    const made = { [field]: cover };
    const left = await _place(home, _coverFiles(made), w);
    await new Promise((resolve, reject) => {
      const tx = _tx(db, [COVER_STORE, BLOB_STORE, GALLERY_STORE], 'readwrite');
      _noteHomeIn(tx, gid, home, left);
      putCoverPatch(tx, gid, { [field]: made[field] });
      tx.oncomplete = () => { w.committed = true; resolve(); };
      tx.onerror = () => reject(_txError(tx));
    });
  });
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

function _entityFrom(id, gal, meta) {
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
    favorite: !!m.favorite,
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
    // Where it is kept: a library folder's id, or this browser's own storage.
    folder: g.folder || BROWSER,
    // A gallery whose files Shiori didn't make (linked-source.js): where they are, read as they are.
    linked: g.linked ? { kind: g.linked.kind, path: g.linked.path, ...(g.linked.inner ? { inner: g.linked.inner } : {}) } : null,
  };
}

// Recompute a gallery's stat record (count/size/cover) from its actual image records —
// the repair path that makes stats truthful again after any historical drift. The pages are read
// and the result written in ONE transaction: a page stored meanwhile can never be lost under a
// stale recount. The record keeps its other fields (series link and totals, measurements); a
// gallery left with no pages keeps a zero entry, unless it is only a placeholder.
export async function rebuildGalleryEntry(galleryId, opts = {}) {
  const gid = String(galleryId);
  const silent = !!opts.silent;
  const db = await openDB();
  let prev = null, gone = false, inlineCover = null;
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, GALLERY_STORE, META_STORE, COVER_STORE, BLOB_STORE], 'readwrite');
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
      _logIn(tx, gid);
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
      gals.put({ ...prev, galleryId: gid, count, size, latestAt, addedAt: prev?.addedAt ?? (Number(gid) || latestAt), coverPage, uploadDate });
      // The cover points at the first page's stored image rather than copying it. Silent: this
      // repair path publishes its own feed beacon below.
      if (_isRef(first?.blob) && (first.blob[REF] === `${first.url}|page` || _isPath(first.blob))) putCoverPatch(tx, gid, { cover: first.blob });
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
    tx._work = 'migration';   // a field derived from what each holds: galleries out of the library too
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
// A gallery's records exactly as stored — metadata, stat record, pages, cover — read in one
// transaction and written in one, so a restored gallery arrives whole or not at all.

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

// { meta, stat, pages, cover } for one gallery, images as Blobs (null for what it lacks). With
// `pages: false`, only its metadata and stat record.
export async function transferRead(galleryId, { pages: withPages = true } = {}) {
  const gid = String(galleryId);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = { meta: null, stat: null, pages: [], cover: null };
    const stores = withPages ? [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE] : [META_STORE, GALLERY_STORE];
    const tx = _tx(db, stores, 'readonly');
    const meta = tx.objectStore(META_STORE).get(gid);
    meta.onsuccess = () => { out.meta = meta.result || null; };
    const stat = tx.objectStore(GALLERY_STORE).get(gid);
    stat.onsuccess = () => { out.stat = _withoutHome(stat.result) || null; };
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
// only this library knows of it there (`folder`, `dir`, `spilled`, `stamp`, `linked`), stay as the
// record it replaces has them: a bundle never carries them. Its pictures go to its folder first (the
// commit protocol: _writing). Sizes are brought up to date afterwards. Refused before anything is
// written: a page with no page number or no picture, and a page whose key another gallery's page is
// stored under (`conflict`: it would be taken from that gallery — checked again as it commits).
// Resolves { pages }: how many pages it stored.
export async function transferWrite({ galleryId = null, meta = null, stat = null, pages = [], cover = null } = {}, { silent = false } = {}) {
  const gid = String(galleryId ?? meta?.galleryId ?? stat?.galleryId ?? pages[0]?.galleryId ?? '');
  if (!gid) throw new BackendError('invalid', 'a gallery to restore names no gallery');
  for (const rec of pages) {
    if (_keyPage(rec?.url) == null) throw new BackendError('invalid', 'a page to restore has no page number');
    if (!(rec.blob instanceof Blob) && typeof rec.dataUrl !== 'string') throw new BackendError('invalid', `page ${_keyPage(rec.url)} to restore has no picture`);
  }
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
      const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE], 'readwrite');
      let failure = null;
      // Anything going wrong while the writes are queued aborts them all: nothing queued so far commits.
      const fail = (e) => { if (!failure) { failure = e; try { tx.abort(); } catch {} } };
      tx.oncomplete = () => { w.committed = true; resolve(); };
      tx.onerror = () => reject(failure || _txError(tx));
      try {
        if (meta) tx.objectStore(META_STORE).put(canonicalMeta({ ...meta, galleryId: gid }));
        const stats = tx.objectStore(GALLERY_STORE);
        if (stat) {
          const cur = stats.get(gid);
          cur.onsuccess = () => {
            stats.put({ ..._withoutHome(stat), galleryId: gid, uploadDate: uploadDateSeconds(stat.uploadDate ?? (Number(meta?.uploadDate) || 0)),
              ..._homeOf(cur.result), ..._homeFields(home, left || !!cur.result?.spilled) });
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
  });
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
  const db = await openDB();
  const put = async (w) => {
    const home = gid ? await _home(gid, null, w) : null;
    rec = _pageCopy(rec);
    const left = await _place(home, _pageFiles(rec, _keyPage(rec.url)), w);
    await new Promise((res, rej) => {
      const tx = _tx(db, [STORE, BLOB_STORE, GALLERY_STORE], 'readwrite');
      const store = tx.objectStore(STORE);
      if (gid) _noteHomeIn(tx, gid, home, left);
      const prev = store.get(rec.url);
      prev.onsuccess = () => { store.put(_stash(tx, rec, _refIds(prev.result, PAGE), PAGE)); if (gid) _logIn(tx, gid); };
      tx.oncomplete = () => { if (w) w.committed = true; res(); };
      tx.onerror = () => rej(_txError(tx));
    });
  };
  await (gid ? _writing(gid, put) : put(null));
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
  const metas = await Promise.all(stats.map(s => metaGet(s.galleryId)));
  return stats.map((s, i) => _entityFrom(s.galleryId, s, metas[i]));
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
  const [gal, meta, f] = await Promise.all([galleryGet(gid), metaGet(gid), _folders()]);
  if (!gal && !meta) return null;
  if (gal && !_mounted(gal, f)) return null;   // its place hidden or removed
  return _entityFrom(gid, gal, meta);
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
      merged = migrateTitle({ ...merged, ...metaPatch, galleryId: gid });
      if (merged.uploadDate != null) merged.uploadDate = uploadDateSeconds(merged.uploadDate);
      if (Array.isArray(merged.tags) || Array.isArray(merged.seriesTags)) merged = { ...merged, tagNames: tagNamesOf(effectiveTagsOf(merged)) };
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
        uploadDate: Number(merged?.uploadDate) || 0, ...(folder ? { folder } : {}) }));
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

// refreshSeriesAggregate's work inside `tx` (META_STORE + GALLERY_STORE); `done(changed)`.
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
        gals.put({ ...base, chapterCount: chapters.length, aggPages, aggSize, aggOrig, ...(aggMedianPage ? { aggMedianPage } : {}) });
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
// it had, once its pages are gone.
function _deleteIn(tx, gid, done = () => {}) {
  const metas = tx.objectStore(META_STORE);
  const metaReq = metas.get(gid);
  metaReq.onsuccess = () => {
    const meta = metaReq.result || null;
    metas.delete(gid);
    const stats = tx.objectStore(GALLERY_STORE);
    const stat = stats.get(gid);
    stat.onsuccess = () => {
      _goneLater(tx, stat.result?.folder, stat.result?.dir, gid, stat.result?.linked || null);
      stats.delete(gid);
      tx.objectStore(UNDESCRIBED_STORE).delete(gid);
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
// `keepFiles`: galleries it deletes keep their files in their library folder (forgotten, not deleted).
async function _seriesCommand(name, args, { keepFiles = false } = {}) {
  const planOf = _SERIES_PLANS[name];
  if (!planOf) throw new BackendError('invalid', `no series command ${name}`);
  const metas = new Map(), stats = new Map(), children = new Map();
  const s = {
    meta: (id) => metas.get(String(id)),
    stat: (id) => stats.get(String(id)),
    children: (id) => children.get(String(id)),
    need: (ids = [], childrenOf = []) => ({ need: { ids: ids.map(String), childrenOf: childrenOf.map(String) } }),
  };
  const db = await openDB();
  let plan = null, refused = null;
  const written = new Set(), deleted = [], mutated = [];
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE], 'readwrite');
    if (keepFiles) tx._keepFiles = true;
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(refused || _txError(tx));
    tx.onabort = () => reject(refused || _txError(tx));
    const fail = (e) => { refused = e; tx.abort(); };

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

    // Writes first, then deletions, then the totals — each issued once the step before has been.
    const apply = () => {
      const gone = new Set(plan.deletes.map(String));
      const writes = [...plan.writes].filter(([gid]) => !gone.has(gid));
      const totals = () => {
        for (const oid of new Set(plan.totals.map(String))) {
          if (!gone.has(oid)) _aggregateIn(tx, oid, (c) => { if (c) written.add(oid); });
        }
      };
      const deletes = () => {
        let left = gone.size;
        if (!left) { totals(); return; }
        for (const gid of gone) _deleteIn(tx, gid, (meta) => { deleted.push([gid, meta]); if (!--left) totals(); });
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

    const step = () => {
      let out;
      try { out = planOf(s, ...args); } catch (e) { fail(e); return; }
      if (out?.need) { load(out.need, step); return; }
      plan = out;
      apply();
    };
    step();
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
  const stores = [STORE, META_STORE, GALLERY_STORE, COVER_STORE, SOURCE_ICON_STORE, BLOB_STORE, DORMANT_STORE, UNDESCRIBED_STORE, ...(folders ? [FOLDER_STORE] : [])];
  const gone = [];
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [...stores, FOLDER_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(_txError(tx));
    const kept = tx.objectStore(GALLERY_STORE).getAll();
    kept.onsuccess = () => { for (const g of kept.result || []) if (roots.get(g.folder) && g.dir) gone.push(g); };
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
    if (await _ownsDir(g.folder, root, g.dir, g.galleryId)) await folderFiles.removeDir(g.folder, root, g.dir).catch(() => {});
  }
  _foldersChanged();
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
      tx.onerror    = () => reject(_txError(tx));
    });
  });
}

// ── Translation variants ──
// A translated page is stored as an extra `translated` field on the existing images
// record, leaving the original untouched. IndexedDB records are schemaless, so this
// needs no DB version bump.

// Study bubble fields beyond box/region/src/tr/text that round-trip through backups and exports.
export { BUBBLE_EXTRA_FIELDS } from './gallery-files.js';
// Per-page fields an earlier storage format wrote; dropped whenever a page is translated again.
const RETIRED_FIELDS = ['translatedLang', 'translatedConfig', 'translatedOutputHash', 'translatedJob', 'snapshot',
  'pendingSnapshot', 'studySnapshot', 'priorSnapshot', 'sourceSha256'];

// A page's translation: its output image and the pipeline data that produced it (page-data.js).
// Study layers belong to one translation, so a new one drops the page's previous layers. A null
// `image` means the page is its study layers, stored next (page-image.js). `own` names the
// translation whose settings the page keeps from now on; undefined leaves that as is.
// `at` is the page's { galleryId, pageNum } (or, until every caller moves, its key) — as for every
// write below.
export async function putTranslatedPage(at, image, pipeline, own) {
  await _pageWrite(at, { translated: image ?? undefined, pipeline: pipeline ?? undefined }, (rec, made) => {
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

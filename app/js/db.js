// db.js — the app's IndexedDB storage layer: images (Blobs), gallery metadata, gallery stats,
// and covers. This is the single canonical library — pages, the PWA service worker, and the
// extension-hosted agent all read and write the same origin-scoped database through this module.

import * as platform from './platform.js';
import { normalizeTitle, migrateTitle } from './titles.js';
import { imageToBlob, imageToDataUrl } from './image-util.js';
import { isSeriesMeta, effectiveTagsOf, LANG_NAME_TO_CODE, DERIVED_FIELDS, uploadDateSeconds } from './gallery-model.js';
import { translatedImage } from './page-image.js';
import { galleryFiles, exportSize } from './gallery-files.js';
import { imageSize, medianPage, describePage } from './page-size.js';
import { BackendError } from './backend-error.js';
import { planAttach, planRemove, planReorder, planChapterTitle, planWrite, planDelete, planDeleteSeries, planRelink } from './series-plan.js';

const DB_NAME = 'shiori-cache';
const DB_VERSION = 16;
export const STORE = 'images';
const META_STORE = 'metadata';
const GALLERY_STORE = 'galleries';
const COVER_STORE = 'covers';
const SOURCE_ICON_STORE = 'sourceIcons';
const BLOB_STORE = 'blobs';   // the images of page and cover records, one record each (see below)
const CHANGES_STORE = 'changes';   // the change log: one entry per changed gallery (see below)
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
export function publishFeed(galleryId) {
  const gid = String(galleryId);
  if (_feedTimers.has(gid)) return;
  _feedTimers.set(gid, setTimeout(async () => {
    _feedTimers.delete(gid);
    await refreshGallerySize(gid).catch(() => {});
    platform.feed.publish({ gid, context: _feedContext, n: ++_feedSeq, at: Date.now(), rev: _lastRev });
  }, 250));
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
// drift. Returns whether it changed.
export async function refreshGallerySize(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  const stored = await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, META_STORE, COVER_STORE], 'readonly');
    const records = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    const meta = tx.objectStore(META_STORE).get(gid);
    const cover = tx.objectStore(COVER_STORE).get(gid);
    tx.oncomplete = () => resolve({ records: records.result || [], meta: meta.result || null, cover: cover.result || null });
    tx.onerror = () => reject(tx.error);
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
      _logIn(tx, gid);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  if (stat && _medianPageStale(stat, stored.records)) scheduleMedianPage(gid);
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
        if (!_isRef(rec.blob)) continue;
        const read = tx.objectStore(BLOB_STORE).get(rec.blob[REF]);
        read.onsuccess = () => { page.src = read.result?.blob || null; };
      }
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
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
      _logIn(tx, gid);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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

      // Backfill when upgrading an existing database (fresh installs start empty).
      if (e.oldVersion > 0) {
        gal.openCursor().onsuccess = (ev) => {
          const c = ev.target.result;
          if (!c) return;
          const v = c.value;
          let dirty = false;
          if (v.addedAt == null) { v.addedAt = Number(v.galleryId) || v.latestAt || Date.now(); dirty = true; }
          if (v.cover != null)   { covers.put({ galleryId: v.galleryId, cover: v.cover }); delete v.cover; dirty = true; }
          if (dirty) c.update(v);
          c.continue();
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
// exception in one of its callbacks, or by running out of space, neither of which fires `error` —
// reaches its `onerror` all the same, so no caller is left waiting on it. A write transaction also
// holds the change log, so what it changes is logged in the same commit (_logIn).
function _tx(db, stores, mode) {
  const list = Array.isArray(stores) ? stores : [stores];
  const tx = db.transaction(mode === 'readwrite' && !list.includes(CHANGES_STORE) ? [...list, CHANGES_STORE] : stores, mode);
  tx.addEventListener('abort', () => { if (typeof tx.onerror === 'function') tx.onerror(new Event('error')); });
  return tx;
}

// ── The change log ──
// Every write that changes what a gallery shows logs the gallery in the same transaction, under the
// next revision of the library (the log's own key). A window that slept through announcements asks
// what changed since the revision it last saw (changesSince) instead of trusting it heard them all.
// The log keeps the last CHANGES_KEPT revisions; a window further behind than that resyncs.
const CHANGES_KEPT = 20000;
let _lastRev = 0;   // the newest revision this window has written
function _logIn(tx, gid) {
  const id = String(gid);
  if (!tx._logged) tx._logged = new Set();
  if (tx._logged.has(id)) return;
  tx._logged.add(id);
  const log = tx.objectStore(CHANGES_STORE);
  const req = log.add({ gid: id, at: Date.now() });
  req.onsuccess = () => {
    const rev = req.result;
    _lastRev = Math.max(_lastRev, rev);
    if (rev % 1000 === 0 && rev > CHANGES_KEPT) {
      log.delete(IDBKeyRange.upperBound(rev - CHANGES_KEPT));
      log.put({ rev: 'compacted', upTo: rev - CHANGES_KEPT });
    }
  };
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
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
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
const _isRef = (v) => v != null && typeof v === 'object' && typeof v[REF] === 'string';
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
const PAGE = { slots: _pageSlots, prefix: (rec) => `${rec.url}|` };
const COVER = { slots: _coverSlots, prefix: (rec) => `cover|${rec.galleryId}|` };
const _ref = (id, blob) => ({ [REF]: id, size: blob.size, type: blob.type });
// The ids of the images `rec` owns.
function _refIds(rec, kind) {
  if (!rec) return [];
  const own = kind.prefix(rec);
  return kind.slots(rec).map(([obj, key]) => obj[key]).filter(_isRef).map(v => v[REF]).filter(id => id.startsWith(own));
}
const _dropBlobs = (tx, ids) => { const blobs = tx.objectStore(BLOB_STORE); for (const id of ids) blobs.delete(id); };

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
    if (_isRef(value)) { keep.add(value[REF]); continue; }
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
function _loadBlobs(tx, recs, kind) {
  const blobs = tx.objectStore(BLOB_STORE);
  const place = (obj, key, blob) => {
    const id = obj[key][REF];
    if (blob) _stored.set(blob, id);
    obj[key] = blob || null;
  };
  for (const rec of recs) {
    if (!rec) continue;
    const refs = kind.slots(rec).filter(([obj, key]) => _isRef(obj[key]));
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

export async function dbGet(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, BLOB_STORE], 'readonly');
    let rec = null;
    const req = tx.objectStore(STORE).get(url);
    req.onsuccess = () => { rec = req.result || null; _loadPages(tx, [rec]); };
    tx.oncomplete = () => resolve(rec);
    tx.onerror = () => reject(tx.error);
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
  let coverChanged = false;
  // If this gallery is a chapter (has parentId) or is itself a series owner (has aggregate fields),
  // its size/count just changed → refresh the affected series aggregate after the tx (debounced).
  let _aggParent = null, _aggSelf = null;
  // A re-put of a URL another gallery owns is a MOVE: the old gallery loses the page from its
  // stats and the new one gains it — without this, the new gallery absorbed a negative size
  // delta for bytes it never owned and its count silently drifted.
  let _movedFromGid = null, _aggMovedParent = null;

  await new Promise((resolve, reject) => {
    // META_STORE joins the tx so a brand-new stat record can seed its denormalized uploadDate
    // (the "Published date" sort key) from the gallery's metadata.
    const tx = _tx(db, [STORE, GALLERY_STORE, COVER_STORE, META_STORE, BLOB_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    if (meta) tx.objectStore(META_STORE).put(meta);

    const images = tx.objectStore(STORE);
    const prevReq = images.get(canonUrl);
    prevReq.onsuccess = () => {
      const prev = prevReq.result || null;
      const sameGallery = !!prev && String(prev.galleryId) === gid;
      images.put(_stash(tx, { url: canonUrl, blob, mediaId: String(mediaId), galleryId: gid, cachedAt, size },
        _refIds(prev, PAGE), PAGE));
      _logIn(tx, gid);
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
            putCoverPatch(tx, gid, { cover: _ref(`${canonUrl}|page`, blob) });
            coverChanged = true;
          }
          tx.objectStore(GALLERY_STORE).put(entry);
        } else {
          // First page of a gallery: seed addedAt from the gid (creation time) and the published
          // date from metadata (0 = unknown → sorts last under "Published date").
          const metaReq = tx.objectStore(META_STORE).get(gid);
          metaReq.onsuccess = () => {
            if (pageNum < 9999) { putCoverPatch(tx, gid, { cover: _ref(`${canonUrl}|page`, blob) }); coverChanged = true; }
            tx.objectStore(GALLERY_STORE).put({
              galleryId: gid, count: 1, size, latestAt: cachedAt,
              addedAt: Number(gid) || cachedAt, coverPage: pageNum,
              uploadDate: Number(metaReq.result?.uploadDate) || 0,
            });
          };
        }
      };
    };
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
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
  });
}

async function galleryDelete(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, GALLERY_STORE, 'readwrite');
    tx.objectStore(GALLERY_STORE).delete(String(galleryId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
    tx.oncomplete = () => resolve(rec);
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
  });
}

// `opts.silent` skips the change announcements — for bulk writers (backup restore, stat rebuild)
// that already publish their own change signals, so one import doesn't storm the feed.
export async function coverPut(galleryId, cover, opts = {}) {
  const gid = String(galleryId);
  const role = opts === 'series' ? 'series' : opts.role;
  const silent = opts !== 'series' && !!opts.silent;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [COVER_STORE, BLOB_STORE], 'readwrite');
    putCoverPatch(tx, gid, role === 'series' ? { seriesCover: cover } : { cover });
    tx.oncomplete = () => {
      if (!silent) {
        platform.control.send({ type: 'COVER_INVALIDATED', galleryId: gid });
        publishFeed(gid);
      }
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
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
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
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
      if (_isRef(first?.blob) && first.blob[REF] === `${first.url}|page`) putCoverPatch(tx, gid, { cover: first.blob });
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
    const metas = tx.objectStore(META_STORE);
    const galleries = tx.objectStore(GALLERY_STORE);
    for (const entry of missing) {
      const req = metas.get(String(entry.galleryId));
      req.onsuccess = () => {
        // 0 = unknown published date, so every gallery remains in the index and sorts last.
        galleries.put({ ...entry, uploadDate: Number(req.result?.uploadDate) || 0 });
        _logIn(tx, entry.galleryId);
      };
    }
    tx.oncomplete = () => resolve(missing.length);
    tx.onerror = () => reject(tx.error);
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

export async function pageGet(galleryId, pageNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, BLOB_STORE], 'readonly');
    let found = null;
    _pageIn(tx, { galleryId, pageNum }, (rec) => { found = rec; _loadPages(tx, [rec]); });
    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(tx.error);
  });
}

export async function pageHas(galleryId, pageNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, STORE, 'readonly');
    let found = false;
    _pageKeyIn(tx, galleryId, Number(pageNum), (key) => { found = key != null; });
    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
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
    tx.oncomplete = () => resolve(hits.map(v => ({ url: v.url, bg: v.studyBg || null, bubbles: v.bubbles, page: v.studyPage || null,
      job: v.pipeline?.job || null, translated: v.translated != null })));
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
    tx.onerror = () => reject(tx.error);
  });
}

// { meta, stat, pages, cover } for one gallery, images as Blobs (null for what it lacks).
export async function transferRead(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = { meta: null, stat: null, pages: [], cover: null };
    const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE], 'readonly');
    const meta = tx.objectStore(META_STORE).get(gid);
    meta.onsuccess = () => { out.meta = meta.result || null; };
    const stat = tx.objectStore(GALLERY_STORE).get(gid);
    stat.onsuccess = () => { out.stat = stat.result || null; };
    const pages = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    pages.onsuccess = () => { out.pages = pages.result || []; _loadPages(tx, out.pages); };
    const cover = tx.objectStore(COVER_STORE).get(gid);
    cover.onsuccess = () => { out.cover = cover.result || null; _loadCovers(tx, [out.cover]); };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

// Write one gallery's records as given (a restore), in one transaction: its metadata, its stat
// record (sort times kept; the published date filled from the metadata when the record predates
// it), its pages and its cover's images. Sizes are brought up to date afterwards.
export async function transferWrite({ galleryId = null, meta = null, stat = null, pages = [], cover = null } = {}, { silent = false } = {}) {
  const gid = String(galleryId ?? meta?.galleryId ?? stat?.galleryId ?? pages[0]?.galleryId ?? '');
  if (!gid) throw new BackendError('invalid', 'a gallery to restore names no gallery');
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = _tx(db, [STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    _logIn(tx, gid);
    if (meta) tx.objectStore(META_STORE).put(canonicalMeta({ ...meta, galleryId: gid }));
    if (stat) tx.objectStore(GALLERY_STORE).put({ ...stat, galleryId: gid, uploadDate: uploadDateSeconds(stat.uploadDate ?? (Number(meta?.uploadDate) || 0)) });
    const images = tx.objectStore(STORE);
    for (const rec of pages) {
      const prev = images.get(rec.url);
      prev.onsuccess = () => images.put(_stash(tx, { ...rec, galleryId: gid }, _refIds(prev.result, PAGE), PAGE));
    }
    const patch = {};
    if (cover?.cover) patch.cover = cover.cover;
    if (cover?.seriesCover) patch.seriesCover = cover.seriesCover;
    if (Object.keys(patch).length) putCoverPatch(tx, gid, patch);
  });
  _forgetOtherSourceLookup(meta?.sourceId, gid, meta?.source);
  if (!silent) publishFeed(gid);
  else scheduleGallerySize(gid);
}

// ── Raw record access (backup/restore) ──
// Backup streams record-at-a-time and restores records verbatim, so it needs key-level access
// the entity-shaped helpers don't expose. These keep that knowledge here rather than letting
// backup.js hold its own copy of the store names.

// Store an image record exactly as given — no stat arithmetic (a restore writes the gallery
// stat records from the archive itself). Use dbPut for normal page writes.
export async function imageRecordPut(rec) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = _tx(db, [STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const prev = store.get(rec.url);
    prev.onsuccess = () => { store.put(_stash(tx, rec, _refIds(prev.result, PAGE), PAGE)); if (rec?.galleryId != null) _logIn(tx, rec.galleryId); };
    tx.oncomplete = () => { if (rec?.galleryId != null) scheduleGallerySize(rec.galleryId); res(); };
    tx.onerror = () => rej(tx.error);
  });
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
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
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
  const entries = await galleryGetAll();
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
  const refsOf = (rec, kind) => kind.slots(rec).map(([obj, key]) => obj[key]).filter(_isRef).map(v => v[REF]);
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
    tx.onerror = () => reject(tx.error);
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
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = _tx(db, GALLERY_STORE, 'readonly');
    const store = tx.objectStore(GALLERY_STORE);
    // 'id' cursors the primary key (galleryId) itself; everything else uses its sort index.
    const source = sort === 'id' ? store : store.index(_SORT_INDEX[sort] || 'latestAt');
    const req = source.openKeyCursor(null, direction);
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) { resolve(out); return; }
      out.push(String(c.primaryKey));
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// gid -> metadata record, for search filtering (metadata holds no cover blobs).
export async function metaGetAllMap() {
  const all = await metaGetAll();
  const map = new Map();
  for (const m of all) map.set(String(m.galleryId), m);
  return map;
}

// How many library entries carry each tag, keyed like the tagNames index (`type:name`, lower-cased).
// Read from that index, so it is never out of step with the tags themselves. An entry is a card in
// the merged library: a series counts once (through its combined tags) and its chapters not on their
// own; metadata that never became a gallery doesn't count. `keys` limits it to those tags, `prefix`
// to one tag type ('artist:'); with neither, every tag in the library.
export async function tagCounts({ keys, prefix } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = _tx(db, [META_STORE, GALLERY_STORE], 'readonly');
    const counts = new Map();
    let entries = null, children = null;
    const gals = tx.objectStore(GALLERY_STORE);
    const allReq = gals.getAllKeys();
    const childReq = gals.index('parentId').getAllKeys();
    const counted = (gid) => entries.has(gid) && !children.has(gid);
    const index = tx.objectStore(META_STORE).index('tagNames');
    childReq.onsuccess = () => {
      entries = new Set(allReq.result.map(String));
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
    tx.onerror = () => reject(tx.error);
  });
}

export async function getGallery(galleryId) {
  const gid = String(galleryId);
  const [gal, meta] = await Promise.all([galleryGet(gid), metaGet(gid)]);
  if (!gal && !meta) return null;
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
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
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
    galReq.onsuccess = () => {
      let cur = galReq.result || null;
      // A metadata change marks a REAL gallery updated and keeps the denormalized published
      // date in step (metaPut parity) — never for a bare stub.
      if (hasMeta && cur && !merged.isStub) {
        cur = touch ? { ...cur, latestAt: Math.max(cur.latestAt || 0, Date.now()) } : { ...cur };
        if (merged.uploadDate != null) cur.uploadDate = Number(merged.uploadDate) || 0;
        else if (cur.uploadDate == null) cur.uploadDate = 0;
      }
      if (hasGal) {
        if (!cur) {
          const now = Date.now();
          cur = {
            galleryId: gid,
            count: 0,
            size: 0,
            latestAt: now,
            addedAt: Number(gid) || now,
            uploadDate: Number(merged?.uploadDate) || 0,
          };
        }
        cur = { ...cur, ...galPatch, galleryId: gid };
      }
      if (cur) gals.put(cur);
      _logIn(tx, gid);
      done({ written: true, prevSourceId, nextSourceId, nextSource: merged.source });
    };
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
    tx.onerror = () => reject(tx.error);
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
        _logIn(tx, oid);
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
        _logIn(tx, oid);
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
    tx.objectStore(GALLERY_STORE).delete(gid);
    _logIn(tx, gid);
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
  const chapters = Array.isArray(meta?.chapters) ? meta.chapters : [];
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(refused || tx.error);
    tx.onabort = () => reject(refused || tx.error);
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

export async function clearAll() {
  _sourceIdToGalleryId.clear();
  const db = await openDB();
  // Every store in one transaction — "clear everything" must mean everything, including the
  // source icons that earlier versions left behind.
  const stores = [STORE, META_STORE, GALLERY_STORE, COVER_STORE, SOURCE_ICON_STORE, BLOB_STORE];
  await new Promise((resolve, reject) => {
    const tx = _tx(db, stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    for (const storeName of stores) tx.objectStore(storeName).clear();
    _logIn(tx, '*');
  });
}

export async function getGalleryImageRecords(galleryId) {
  const db = await openDB();
  const gid = String(galleryId);
  return new Promise((resolve, reject) => {
    const tx  = _tx(db, [STORE, BLOB_STORE], 'readonly');
    let recs = [];
    const req = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    req.onsuccess = () => { recs = req.result || []; _loadPages(tx, recs); };
    tx.oncomplete = () => resolve(recs);
    tx.onerror    = () => reject(tx.error);
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
    const tx = _tx(db, [STORE, BLOB_STORE], 'readonly');
    let pages = 0, converted = 0;
    const count = tx.objectStore(STORE).count();
    count.onsuccess = () => { pages = count.result; };
    const keys = tx.objectStore(BLOB_STORE).openKeyCursor();
    keys.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return;
      if (String(c.key).endsWith('|page')) converted++;
      c.continue();
    };
    tx.oncomplete = () => resolve({ pages, converted, remaining: Math.max(0, pages - converted) });
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
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
    tx.onerror = () => reject(tx.error);
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
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = _tx(db, [STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    _pageIn(tx, at, (rec) => {
      if (!rec) return;
      const before = _refIds(rec, PAGE);
      delete rec.studyBg;
      delete rec.studyPage;
      delete rec.bubbles;
      for (const key of RETIRED_FIELDS) delete rec[key];
      if (image) { rec.translated = image; delete rec.translatedLayers; }
      else { delete rec.translated; rec.translatedLayers = true; }
      if (pipeline) rec.pipeline = pipeline;
      else delete rec.pipeline;
      if (own) rec.own = own;
      else if (own !== undefined) delete rec.own;
      store.put(_stash(tx, rec, before, PAGE));
      _logIn(tx, rec.galleryId);
      scheduleGallerySize(rec.galleryId);
    });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// Restore a page's pipeline data from an export: `pipeline`, `own` and `translatedLayers` only,
// leaving its images and study layers as they are.
const _RESTORABLE = ['pipeline', 'own', 'translatedLayers'];
export async function putPageData(at, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = _tx(db, [STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    _pageIn(tx, at, (rec) => {
      if (!rec) return;
      const before = _refIds(rec, PAGE);
      for (const key of _RESTORABLE) if (data?.[key] !== undefined) rec[key] = data[key];
      store.put(_stash(tx, rec, before, PAGE));
      _logIn(tx, rec.galleryId);
      scheduleGallerySize(rec.galleryId);
    });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// Pages that keep the settings of translation `own` from now on — or, with null, follow the
// current settings again (page-data.js translationGroups).
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
    tx.onerror    = () => reject(tx.error);
  });
}

// The output image alone (restoring an export; its pipeline data is restored separately).
// `translatedSrc` is a Blob (preferred — data URLs cost ~33% more storage).
export async function putTranslatedImage(at, translatedSrc) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = _tx(db, [STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    _pageIn(tx, at, (rec) => {
      if (rec) {
        const before = _refIds(rec, PAGE);
        rec.translated = translatedSrc;
        store.put(_stash(tx, rec, before, PAGE));
        _logIn(tx, rec.galleryId);
        scheduleGallerySize(rec.galleryId);
      }
    });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
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
// `job`, the layers are stored only while the page still shows that translation's output.
export async function putPageStudy(at, study, job = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = _tx(db, [STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    _pageIn(tx, at, (rec) => {
      if (rec && (job == null || rec.pipeline?.job === job)) {
        const before = _refIds(rec, PAGE);
        rec.studyBg = study.bg || null;
        rec.bubbles = study.bubbles;
        rec.studyPage = study.page || null;
        store.put(_stash(tx, rec, before, PAGE));
        _logIn(tx, rec.galleryId);
        scheduleGallerySize(rec.galleryId);
      }
    });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
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
    tx.onerror    = () => reject(tx.error);
  });
}

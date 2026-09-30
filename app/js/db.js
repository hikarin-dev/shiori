// db.js — the app's IndexedDB storage layer: images (Blobs), gallery metadata, gallery stats,
// and covers. This is the single canonical library — pages, the PWA service worker, and the
// extension-hosted agent all read and write the same origin-scoped database through this module.

import * as platform from './platform.js';
import { normalizeTitle, migrateTitle } from './titles.js';
import { resizeToWidth } from './image-util.js';
import { translatedImage } from './page-image.js';
import { galleryFiles, exportSize } from './gallery-files.js';
import { imageSize, medianPage, describePage } from './page-size.js';

const DB_NAME = 'shiori-cache';
const DB_VERSION = 15;
export const STORE = 'images';
const META_STORE = 'metadata';
const GALLERY_STORE = 'galleries';
const COVER_STORE = 'covers';
const SOURCE_ICON_STORE = 'sourceIcons';
const BLOB_STORE = 'blobs';   // the images of page and cover records, one record each (see below)
// A stored page's url ends in its page number and image type ("…/12.webp") — every type a page
// can be stored as, so no page goes unnumbered.
export const PAGE_URL = /\/(\d+)\.(webp|jpg|jpeg|png|gif|avif)$/i;

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
    platform.feed.publish({ gid, context: _feedContext, n: ++_feedSeq, at: Date.now() });
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
    const tx = db.transaction([STORE, META_STORE, COVER_STORE], 'readonly');
    const records = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    const meta = tx.objectStore(META_STORE).get(gid);
    const cover = tx.objectStore(COVER_STORE).get(gid);
    tx.oncomplete = () => resolve({ records: records.result || [], meta: meta.result || null, cover: cover.result || null });
    tx.onerror = () => reject(tx.error);
  });
  const { total, original } = exportSize(galleryFiles({ meta: stored.meta, records: stored.records,
    covers: { gallery: stored.cover?.cover, series: stored.cover?.seriesCover } }));
  let changed = null, stat = null;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readwrite');
    const store = tx.objectStore(GALLERY_STORE);
    const req = store.get(gid);
    req.onsuccess = () => {
      const cur = stat = req.result;
      if (!cur || (cur.size === total && cur.origSize === original)) return;
      changed = cur;
      store.put({ ...cur, size: total, origSize: original });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  if (stat && _medianPageStale(stat.medianPage, stored.records)) scheduleMedianPage(gid);
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
const _pagesSig = (pages) => ({ n: pages.length, bytes: pages.reduce((sum, p) => sum + (p.size || 0), 0) });
function _medianPageStale(stored, records) {
  if (!stored) return records.length > 0;
  const sig = _pagesSig(records);
  return stored.n !== sig.n || stored.bytes !== sig.bytes;
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

// Measure one gallery's median page from its stored originals. Returns whether its size changed.
export async function refreshMedianPage(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  const pages = await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, BLOB_STORE], 'readonly');
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
  let prev = null, stat = null;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readwrite');
    const store = tx.objectStore(GALLERY_STORE);
    const req = store.get(gid);
    req.onsuccess = () => {
      const cur = req.result;
      prev = cur?.medianPage;
      if (!cur || ['w', 'h', 'n', 'bytes'].every(k => prev?.[k] === next?.[k])) return;
      stat = cur;
      const { medianPage: _, ...rest } = cur;
      store.put(next ? { ...rest, medianPage: next } : rest);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  if (!stat || (prev?.w === next?.w && prev?.h === next?.h)) return false;
  if (stat.parentId) scheduleSeriesAggregate(stat.parentId);
  if (stat.chapterCount != null) scheduleSeriesAggregate(gid);
  return true;
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
export function isSeriesMeta(meta) {
  return Array.isArray(meta?.chapters) && meta.chapters.length > 1;
}
// The tag list a series exposes (its rollup) vs. a plain gallery's own tags — the single
// definition every surface should consume.
export function effectiveTagsOf(meta) {
  return isSeriesMeta(meta) && Array.isArray(meta.seriesTags) ? meta.seriesTags : meta?.tags;
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
const _loadPages = (tx, recs) => _loadBlobs(tx, recs, PAGE);
const _loadCovers = (tx, recs) => _loadBlobs(tx, recs, COVER);

export async function dbGet(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, BLOB_STORE], 'readonly');
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
export async function dbPut(url, src, mediaId, galleryId) {
  const db = await openDB();
  const gid = String(galleryId || mediaId);
  const canonUrl = url;
  const blob = await imageToBlob(src);
  const size = blob ? blob.size : 0;
  const cachedAt = Date.now();
  const pm = canonUrl.match(PAGE_URL);
  const pageNum = pm ? parseInt(pm[1]) : 9999;
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
    const tx = db.transaction([STORE, GALLERY_STORE, COVER_STORE, META_STORE, BLOB_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);

    const images = tx.objectStore(STORE);
    const prevReq = images.get(canonUrl);
    prevReq.onsuccess = () => {
      const prev = prevReq.result || null;
      const sameGallery = !!prev && String(prev.galleryId) === gid;
      images.put(_stash(tx, { url: canonUrl, blob, mediaId: String(mediaId), galleryId: gid, cachedAt, size },
        _refIds(prev, PAGE), PAGE));

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
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(String(galleryId));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function metaPut(meta, opts = {}) {
  const silent = !!opts.silent;
  const db = await openDB();
  // Every write converges on the canonical title format (legacy flat fields stripped), then the
  // tagNames index is kept in sync automatically for every writer.
  let record = migrateTitle(meta);
  if (Array.isArray(record.tags) || Array.isArray(record.seriesTags)) record = { ...record, tagNames: tagNamesOf(effectiveTagsOf(record)) };
  const gid = String(record.galleryId);
  let prevSourceId = null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, GALLERY_STORE], 'readwrite');
    // A bare stub (sourceId placeholder, no pages yet) is not a user-visible gallery —
    // don't wake subscribers for it, or a reactive read could purge it mid-creation
    // (see the pageless-stub grace window in purgePagelessStubs).
    tx.oncomplete = () => {
      if (prevSourceId && String(prevSourceId) !== String(record.sourceId || '')) _sourceIdToGalleryId.delete(String(prevSourceId));
      if (record.sourceId) _sourceIdToGalleryId.set(String(record.sourceId), gid);
      if (!silent && !record.isStub) publishFeed(gid);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    const mstore = tx.objectStore(META_STORE);
    const prevReq = mstore.get(gid);
    prevReq.onsuccess = () => { prevSourceId = prevReq.result?.sourceId || null; };
    mstore.put(record);
    // Any metadata change counts as a modification: mark the gallery "updated" and keep its
    // denormalized published date (the Published-date sort key) in step. Only touch a REAL gallery
    // that already has a stat record — never create one here, and never for a bare stub.
    if (!record.isStub) {
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
    }
  });
}

export async function metaGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function metaDelete(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    // Resolve on commit, not request success — a resolved write must not still be able to abort.
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).delete(String(galleryId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Gallery stats store helpers ──

export async function galleryGet(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).get(String(galleryId));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function galleryPut(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    // Resolve on commit, not request success — a resolved write must not still be able to abort.
    const tx = db.transaction(GALLERY_STORE, 'readwrite');
    tx.objectStore(GALLERY_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function galleryDelete(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readwrite');
    tx.objectStore(GALLERY_STORE).delete(String(galleryId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function galleryGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readonly');
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
    const tx = db.transaction([COVER_STORE, BLOB_STORE], 'readonly');
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
    const tx = db.transaction([COVER_STORE, BLOB_STORE], 'readwrite');
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
    const tx = db.transaction([COVER_STORE, BLOB_STORE], 'readwrite');
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
  const role = opts === 'series' ? 'series' : opts.role;
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction([COVER_STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(COVER_STORE);
    const gid = String(galleryId);
    const req = store.get(gid);
    req.onsuccess = () => {
      const rec = req.result;
      if (!rec) return;
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// Source-site favicons are durable app assets, not browser HTTP-cache hints. They stay in the DB
// even when the user clears gallery/image cache so source labels remain usable offline.
export async function sourceIconGet(source) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SOURCE_ICON_STORE, 'readonly');
    const req = tx.objectStore(SOURCE_ICON_STORE).get(String(source || ''));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function sourceIconsAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SOURCE_ICON_STORE, 'readonly');
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
    const tx = db.transaction(SOURCE_ICON_STORE, 'readwrite');
    const store = tx.objectStore(SOURCE_ICON_STORE);
    const req = store.get(key);
    req.onsuccess = () => store.put({ ...(req.result || {}), source: key, ...patch });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Merge a gallery's stat record + metadata into the single entity shape every UI
// surface consumes. Intentionally excludes the heavy cover blob (loaded lazily).
// Source language names → ISO-ish codes used for the card language flag. Covers every language
// the translator can output to, plus the common source-site language names.
export const _LANG_NAME_TO_CODE = {
  english: 'en', japanese: 'ja', chinese: 'zh', 'chinese (simplified)': 'zh',
  'chinese (traditional)': 'zh-TW', korean: 'ko', german: 'de', french: 'fr',
  spanish: 'es', russian: 'ru', portuguese: 'pt', 'portuguese (brazil)': 'pt-BR',
  italian: 'it', vietnamese: 'vi', indonesian: 'id', thai: 'th', dutch: 'nl',
  polish: 'pl', ukrainian: 'uk',
};

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
      add(_LANG_NAME_TO_CODE[name]);
    }
  }
  if (!out.length && m.sourceMetadata && m.sourceMetadata.language) {
    add(_LANG_NAME_TO_CODE[String(m.sourceMetadata.language).toLowerCase()]);
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
// the repair path that makes stats truthful again after any historical drift.
export async function rebuildGalleryEntry(galleryId, opts = {}) {
  const gid = String(galleryId);
  const silent = !!opts.silent;
  const records = await getGalleryImageRecords(gid);
  if (records.length === 0) { await galleryDelete(gid); await coverDelete(gid, { role: 'gallery' }); return; }
  const prev = await galleryGet(gid);
  let count = 0, size = 0, latestAt = 0, coverSrc = null, coverUrl = null, coverPage = 9999;
  for (const r of records) {
    count++;
    size += r.size || 0;
    latestAt = Math.max(latestAt, r.cachedAt || 0);
    const pm = r.url.match(PAGE_URL);
    const pn = pm ? parseInt(pm[1]) : 9999;
    if (pn < coverPage) { coverPage = pn; coverSrc = r.blob ?? r.dataUrl; coverUrl = r.url; }
  }
  const uploadDate = prev?.uploadDate ?? (Number((await metaGet(gid))?.uploadDate) || 0);
  // Preserve series membership (parentId) — a stat rebuild must not orphan a chapter.
  const seriesFields = prev?.parentId ? { parentId: prev.parentId } : {};
  await galleryPut({ galleryId: gid, count, size, latestAt, addedAt: prev?.addedAt ?? (Number(gid) || latestAt), coverPage, uploadDate, ...seriesFields });
  // Silent: this repair path publishes its own feed beacon below, and it runs during library
  // reads (dedup/count sweeps) where a loud cover write would echo change signals back at readers.
  // The cover points at the first page's stored image, rather than copying it, when it can.
  const pageImage = coverSrc instanceof Blob && _stored.get(coverSrc) === `${coverUrl}|page`;
  if (coverSrc != null) await coverPut(gid, pageImage ? _ref(`${coverUrl}|page`, coverSrc) : await imageToBlob(coverSrc), { silent: true });
  if (prev?.parentId)      scheduleSeriesAggregate(prev.parentId);
  if (prev?.chapterCount != null) scheduleSeriesAggregate(gid);   // this gallery is a series owner
  if (!silent) publishFeed(gid);
  else scheduleGallerySize(gid);
}

async function galleryGetMany(ids) {
  const db = await openDB();
  const tx = db.transaction(GALLERY_STORE, 'readonly');
  const store = tx.objectStore(GALLERY_STORE);
  return Promise.all((ids || []).map(id => new Promise((resolve) => {
    const req = store.get(String(id));
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  })));
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
  const tx = db.transaction(STORE, 'readonly');
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

// Delete child galleries whose parent still points at `ownerId`, but whose id is no longer in the
// owner's authoritative chapter list. Used by full series replacements so shorter imports do not
// leave hidden stale chapters behind.
export async function pruneSeriesChildren(ownerId, keepIds = []) {
  const oid = String(ownerId);
  const keep = new Set((keepIds || []).map(id => String(id && typeof id === 'object' ? id.id : id)));
  keep.add(oid);

  const stale = (await galleryGetAll())
    .filter(e => String(e.parentId || '') === oid && !keep.has(String(e.galleryId)))
    .map(e => String(e.galleryId));

  for (const gid of stale) await deleteGallery(gid);
  if (stale.length) {
    await refreshSeriesAggregate(oid);
    publishFeed(oid);
  }
  return stale.length;
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
    const tx = db.transaction([META_STORE, GALLERY_STORE], 'readwrite');
    const metas = tx.objectStore(META_STORE);
    const galleries = tx.objectStore(GALLERY_STORE);
    for (const entry of missing) {
      const req = metas.get(String(entry.galleryId));
      req.onsuccess = () => {
        // 0 = unknown published date, so every gallery remains in the index and sorts last.
        galleries.put({ ...entry, uploadDate: Number(req.result?.uploadDate) || 0 });
      };
    }
    tx.oncomplete = () => resolve(missing.length);
    tx.onerror = () => reject(tx.error);
  });
}

// ── Page lookup ──

export async function dbGetByGalleryPage(galleryId, pageNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction([STORE, BLOB_STORE], 'readonly');
    let found = null;
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(String(galleryId)));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const m = cursor.value.url.match(PAGE_URL);
      if (m && parseInt(m[1]) === pageNum) { found = cursor.value; _loadPages(tx, [found]); return; }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(found);
    tx.onerror = () => reject(tx.error);
  });
}

export async function pageExistsForGallery(galleryId, pageNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').openKeyCursor(IDBKeyRange.only(String(galleryId)));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(false); return; }
      const m = cursor.primaryKey.match(PAGE_URL);
      if (m && parseInt(m[1]) === pageNum) { resolve(true); return; }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// Page numbers already stored for a gallery (cheap key cursor) — used to skip re-downloads.
export async function existingPageNums(galleryId) {
  const db = await openDB();
  return new Promise((resolve) => {
    const nums = new Set();
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('galleryId')
      .openKeyCursor(IDBKeyRange.only(String(galleryId)));
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) { resolve(nums); return; }
      const m = String(c.primaryKey).match(/\/(\d+)\.\w+$/);
      if (m) nums.add(parseInt(m[1]));
      c.continue();
    };
    req.onerror = () => resolve(nums);
  });
}

// Page keys (page number + url) for a gallery via a cheap key cursor — no image blobs are
// loaded, so a page grid can list every page without materializing the gallery in memory.
// Each thumbnail then fetches its own record by url on demand (O(1) get), one at a time.
export async function listGalleryPageKeys(galleryId) {
  const db = await openDB();
  return new Promise((resolve) => {
    const out = [];
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('galleryId')
      .openKeyCursor(IDBKeyRange.only(String(galleryId)));
    req.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) { out.sort((a, b) => a.pageNum - b.pageNum); resolve(out); return; }
      const m = String(c.primaryKey).match(PAGE_URL);
      if (m) out.push({ pageNum: parseInt(m[1]), url: String(c.primaryKey) });
      c.continue();
    };
    req.onerror = () => resolve(out);
  });
}

// Every page url stored for a gallery, unsorted, via a key-only cursor (no image bytes loaded).
// Unlike listGalleryPageKeys this returns raw keys — callers that own their own ordering (the
// reader builds chapter slots) use this and never touch a raw transaction.
export async function listGalleryPageUrls(galleryId) {
  const db = await openDB();
  return new Promise((resolve) => {
    const urls = [];
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('galleryId')
      .openKeyCursor(IDBKeyRange.only(String(galleryId)));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { urls.push(cursor.primaryKey); cursor.continue(); } else resolve(urls);
    };
    req.onerror = () => resolve(urls);
  });
}

// Study-mode layers for every page of a gallery that has them: { url, bg, bubbles, page }.
// One cursor pass; bg/text layers stay Blobs (the caller makes object URLs lazily).
export async function listGalleryStudyRecords(galleryId) {
  const db = await openDB();
  return new Promise((resolve) => {
    const hits = [];
    const tx = db.transaction([STORE, BLOB_STORE], 'readonly');
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

// ── Raw record access (backup/restore) ──
// Backup streams record-at-a-time and restores records verbatim, so it needs key-level access
// the entity-shaped helpers don't expose. These keep that knowledge here rather than letting
// backup.js hold its own copy of the store names.

export async function imageKeysAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const q = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
    q.onsuccess = () => res(q.result || []);
    q.onerror = () => rej(q.error);
  });
}

// Store an image record exactly as given — no stat arithmetic (a restore writes the gallery
// stat records from the archive itself). Use dbPut for normal page writes.
export async function imageRecordPut(rec) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction([STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const prev = store.get(rec.url);
    prev.onsuccess = () => store.put(_stash(tx, rec, _refIds(prev.result, PAGE), PAGE));
    tx.oncomplete = () => { if (rec?.galleryId != null) scheduleGallerySize(rec.galleryId); res(); };
    tx.onerror = () => rej(tx.error);
  });
}

export async function coverKeysAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const q = db.transaction(COVER_STORE, 'readonly').objectStore(COVER_STORE).getAllKeys();
    q.onsuccess = () => res(q.result || []);
    q.onerror = () => rej(q.error);
  });
}

export async function coverRecordGet(galleryId) {
  return _coverRecord(galleryId);
}

export async function deleteGalleryImages(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, GALLERY_STORE, BLOB_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { _dropBlobs(tx, _refIds(cursor.value, PAGE)); cursor.delete(); cursor.continue(); }
      else { tx.objectStore(GALLERY_STORE).delete(gid); }
    };
  });
  await coverDelete(gid, { role: 'gallery' });
}

// Delete a gallery's image records whose url is not in keepUrls — a replace-import's stale
// leftovers (old extensions, old remote-source keys, pages past the new set) — then rebuild the
// stat record so count/size/cover are truthful again. Called only after the replacement set is
// fully written, so an interruption before this point leaves the union of old and new pages.
export async function deleteStaleGalleryImages(galleryId, keepUrls) {
  const gid = String(galleryId);
  const keep = new Set(keepUrls || []);
  const db = await openDB();
  let removed = 0;
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, BLOB_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      if (!keep.has(cursor.value.url)) { _dropBlobs(tx, _refIds(cursor.value, PAGE)); cursor.delete(); removed++; }
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

function forgetSourceMapping(sourceId, galleryId) {
  const sid = sourceId != null ? String(sourceId) : '';
  if (sid) _sourceIdToGalleryId.delete(sid);
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

async function cachedGalleryIdForSource(sid) {
  if (!_sourceIdToGalleryId.has(sid)) return null;
  const gid = String(_sourceIdToGalleryId.get(sid));
  const meta = await metaGet(gid).catch(() => null);
  if (meta && String(meta.sourceId || '') === sid) return gid;
  forgetSourceMapping(sid, gid);
  return null;
}

// ── Gallery ID resolution ──
// Site source ids (short numbers) map to internal gallery ids (timestamps). A first sighting
// creates a stub metadata record so concurrent captures agree on the same internal id.

// The one internal-id mint: Date.now()-sequenced, monotonic per context. Import paths must
// route through this too, so at least the per-context uniqueness guard always applies.
export function nextGalleryId() {
  _lastGeneratedGalleryId = Math.max(Date.now(), _lastGeneratedGalleryId + 1);
  return String(_lastGeneratedGalleryId);
}

async function resolveSourceGalleryId(sid) {
  const cached = await cachedGalleryIdForSource(sid);
  if (cached) return cached;
  const db = await openDB();
  // Index lookup + stub creation in ONE readwrite transaction: two contexts racing on the same
  // source id serialize here, so the loser sees the winner's stub instead of minting a second
  // internal id for the same gallery. (The stub bypasses metaPut deliberately — it carries no
  // title/tags to canonicalize, and metaPut's stat-record touch skips stubs anyway.)
  const gid = await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    let result = null;
    const store = tx.objectStore(META_STORE);
    const req = store.index('sourceId').get(sid);
    req.onsuccess = () => {
      if (req.result) { result = String(req.result.galleryId); return; }
      const newGid = nextGalleryId();
      store.put({ galleryId: newGid, sourceId: sid, isStub: true });
      result = newGid;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
  _sourceIdToGalleryId.set(sid, gid);
  return gid;
}

export async function resolveGalleryId(id) {
  const raw = String(id);
  // Internal ids are Date.now()-derived → always ≥13 digits. Anything that long is treated as
  // already-internal; SOURCE refs that long are rejected at the agent boundary (resolve_gid)
  // so an unusually long external id can never silently bypass resolution.
  if (/^\d{13,}$/.test(raw)) return raw;
  if (_galleryResolvePending.has(raw)) return _galleryResolvePending.get(raw);
  const pending = resolveSourceGalleryId(raw).finally(() => {
    if (_galleryResolvePending.get(raw) === pending) _galleryResolvePending.delete(raw);
  });
  _galleryResolvePending.set(raw, pending);
  return pending;
}

// ── Stats / gallery helpers ──

// Blob-returning resize primitive used by callers that persist derived thumbnails. Falls back to
// the full cover when it is already small enough or on any decode error. Cover thumbnails keep
// their historical WebP q0.82 parameters (see image-util.js).
export async function resizeCoverBlob(src, maxW) {
  const inBlob = await imageToBlob(src);
  if (!inBlob || !maxW) return inBlob;
  try {
    const bitmap = await createImageBitmap(inBlob);
    const alreadySmall = bitmap.width <= maxW;
    bitmap.close();
    if (alreadySmall) return inBlob;
    return await resizeToWidth(inBlob, maxW, { format: 'image/webp', quality: 0.82 });
  } catch { return inBlob; }
}

// Existing data-URL API retained for callers that do not need the persistent thumbnail cache.
export async function resizeCover(src, maxW) {
  return imageToDataUrl(await resizeCoverBlob(src, maxW));
}

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

// Purge stubs that never received pages — but spare ones created in the last minute,
// so a gallery whose metadata fetch / first image capture is still in flight isn't
// deleted out from under it. Stub ids are Date.now() creation timestamps.
// Runs from the boot maintenance window — never from a read path.
export async function purgePagelessStubs() {
  const allMeta = await metaGetAll();
  const _stubCutoff = Date.now() - 60000;
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
    const tx = db.transaction(GALLERY_STORE, 'readonly');
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
    const tx = db.transaction(GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).index('parentId').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => resolve(0);
  });
}

export async function galleriesCount({ merge = true } = {}) {
  const db = await openDB();
  const total = await new Promise((resolve, reject) => {
    const req = db.transaction(GALLERY_STORE, 'readonly').objectStore(GALLERY_STORE).count();
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
    const tx = db.transaction(GALLERY_STORE, 'readonly');
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
    const tx = db.transaction([META_STORE, GALLERY_STORE], 'readonly');
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

const _META_FIELDS = new Set([
  'title', 'titlePretty', 'titleEnglish', 'numPages', 'tags', 'mediaId', 'pageExts',
  'isLocalImport', 'source', 'sourceId', 'sourceUrl', 'fetchedAt', 'translated', 'translatedLang', 'isStub', 'sourceMetadata',
  'favorite',
  // Series/chapter grouping: `chapters`, `seriesTitle`, and `seriesTags` live on the owner's
  // metadata; `parentId` lives on a child's metadata AND is mirrored onto its stat record
  // (see mutateGallery).
  'chapters', 'seriesTitle', 'seriesTags', 'parentId',
]);

// Merge a patch into a gallery's metadata and/or stat record, then announce the change
// so every subscribed surface re-renders. The one mutation entry point for gallery
// records — callers never touch metaPut/galleryPut directly. One logical mutation is one
// transaction: metadata and stats can never disagree after an abort mid-way.
// `touch: false` keeps the "Last updated" time — for library upgrades, which change no content.
export async function mutateGallery(galleryId, patch, opts = {}) {
  const gid = String(galleryId);
  const silent = !!opts.silent;
  const touch = opts.touch !== false;
  const metaPatch = {}, galPatch = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (_META_FIELDS.has(k)) metaPatch[k] = v; else galPatch[k] = v;
  }
  // parentId is denormalized onto BOTH stores: metadata (search exclusion) and the stat record
  // (grid index-cursor exclusion + the aggregate hook). Routing above put it only on metadata.
  if ('parentId' in (patch || {})) galPatch.parentId = patch.parentId;
  const hasMeta = Object.keys(metaPatch).length > 0;
  const hasGal = Object.keys(galPatch).length > 0;
  if (!hasMeta && !hasGal) { if (!silent) publishFeed(gid); return; }

  const db = await openDB();
  let prevSourceId = null, nextSourceId = null;
  await new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, GALLERY_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const metas = tx.objectStore(META_STORE);
    const gals = tx.objectStore(GALLERY_STORE);
    const metaReq = metas.get(gid);
    metaReq.onsuccess = () => {
      const curMeta = metaReq.result || null;
      let merged = curMeta || { galleryId: gid };
      if (hasMeta) {
        prevSourceId = curMeta?.sourceId || null;
        // Same canonicalization metaPut applies: title format + tagNames index kept in sync.
        merged = migrateTitle({ ...merged, ...metaPatch, galleryId: gid });
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
      };
    };
  });
  if (prevSourceId && String(prevSourceId) !== String(nextSourceId || '')) _sourceIdToGalleryId.delete(String(prevSourceId));
  if (nextSourceId) _sourceIdToGalleryId.set(String(nextSourceId), gid);
  if (!silent) publishFeed(gid);
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

export async function refreshSeriesAggregate(ownerId, opts = {}) {
  const oid = String(ownerId);
  const silent = !!opts.silent;
  const [meta, owner] = await Promise.all([metaGet(oid), galleryGet(oid)]);
  if (!owner) return;
  const chapters = Array.isArray(meta?.chapters) ? meta.chapters : null;
  if (!chapters || chapters.length < 2) {
    // No longer a series — strip any stale aggregate so the card falls back to its own stats.
    if (owner.chapterCount != null || owner.aggPages != null || owner.aggSize != null) {
      const { chapterCount, aggPages, aggSize, aggOrig, aggMedianPage, ...rest } = owner;
      await galleryPut(rest);
      if (!silent) publishFeed(oid);
    }
    return;
  }
  let aggPages = 0, aggSize = 0, aggOrig = 0;
  const chapterStats = await galleryGetMany(chapters.map(c => c.id));
  for (const s of chapterStats) {
    if (s) { aggPages += s.count || 0; aggSize += s.size || 0; aggOrig += s.origSize ?? s.size ?? 0; }
  }
  // The series' typical page: each chapter's median page, standing for its pages.
  const aggMedianPage = medianPage(chapterStats.filter(Boolean).map(s => ({ ...s.medianPage, n: s.count })));
  const { aggMedianPage: _, ...base } = owner;
  await galleryPut({ ...base, chapterCount: chapters.length, aggPages, aggSize, aggOrig, ...(aggMedianPage ? { aggMedianPage } : {}) });
  if (!silent) publishFeed(oid);
}

export async function removeGallery(galleryId) {
  await deleteGallery(galleryId);
  publishFeed(galleryId);
}

export async function deleteGallery(galleryId) {
  const gid = String(galleryId);
  const meta = await metaGet(gid).catch(() => null);
  forgetSourceMapping(meta?.sourceId, gid);
  // One transaction across every store the gallery lives in — an abort mid-delete can no longer
  // leave images without metadata or a cover without its gallery.
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, META_STORE, GALLERY_STORE, COVER_STORE, BLOB_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { _dropBlobs(tx, _refIds(cursor.value, PAGE)); cursor.delete(); cursor.continue(); }
    };
    tx.objectStore(GALLERY_STORE).delete(gid);
    tx.objectStore(META_STORE).delete(gid);
    const covers = tx.objectStore(COVER_STORE);
    const cover = covers.get(gid);
    cover.onsuccess = () => { _dropBlobs(tx, _refIds(cover.result, COVER)); covers.delete(gid); };
  });
  if (meta?.parentId) scheduleSeriesAggregate(meta.parentId);   // a chapter left its series
  platform.control.send({ type: 'GALLERY_DELETED', galleryId: gid, sourceId: meta?.sourceId || null });
  publishFeed(gid);
}

export async function clearAll() {
  _sourceIdToGalleryId.clear();
  const db = await openDB();
  // Every store in one transaction — "clear everything" must mean everything, including the
  // source icons that earlier versions left behind.
  const stores = [STORE, META_STORE, GALLERY_STORE, COVER_STORE, SOURCE_ICON_STORE, BLOB_STORE];
  await new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    for (const storeName of stores) tx.objectStore(storeName).clear();
  });
}

export async function getGalleryImageRecords(galleryId) {
  const db = await openDB();
  const gid = String(galleryId);
  return new Promise((resolve, reject) => {
    const tx  = db.transaction([STORE, BLOB_STORE], 'readonly');
    let recs = [];
    const req = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    req.onsuccess = () => { recs = req.result || []; _loadPages(tx, recs); };
    tx.oncomplete = () => resolve(recs);
    tx.onerror    = () => reject(tx.error);
  });
}

// Image source of one record for serving. preferTranslated picks the translated page when there
// is one (stored, or composed from its study layers) — this is what makes a revisited site page
// show the modified image.
const _recSrc = async (r, preferTranslated) =>
  (preferTranslated ? ((await translatedImage(r)) ?? r.blob ?? r.dataUrl) : (r.blob ?? r.dataUrl));

// All pages of a gallery as data-URLs, capped so a big gallery doesn't materialize at once.
// Used by the agent to serve the extension's content scripts.
export async function getGalleryPages(galleryId, { preferTranslated = false, capBytes = 8 * 1024 * 1024 } = {}) {
  const records = await getGalleryImageRecords(galleryId);

  const entries = records
    .map(r => {
      const m = r.url.match(PAGE_URL);
      return { pageNum: m ? parseInt(m[1]) : 9999, url: r.url, rec: r };
    })
    .sort((a, b) => a.pageNum - b.pageNum);

  let total = 0;
  const pages = [];
  for (const e of entries) {
    // One page at a time: a page kept as study layers is composed only when it fits.
    const src = total < capBytes ? await _recSrc(e.rec, preferTranslated) : null;
    const bytes = src instanceof Blob ? src.size : (typeof src === 'string' ? Math.round(src.length * 0.75) : 0);
    let dataUrl;
    if (src && total + bytes <= capBytes) { dataUrl = await imageToDataUrl(src); total += bytes; }
    pages.push({ pageNum: e.pageNum, url: e.url, dataUrl });
  }
  return { pages };
}

export async function getGalleryPageRange(galleryId, startPage, endPage, { preferTranslated = false } = {}) {
  const records = await getGalleryImageRecords(galleryId);

  const entries = records
    .map(r => {
      const m = r.url.match(PAGE_URL);
      return { pageNum: m ? parseInt(m[1]) : 9999, url: r.url, rec: r };
    })
    .filter(p => p.pageNum >= startPage && p.pageNum <= endPage)
    .sort((a, b) => a.pageNum - b.pageNum);

  const pages = [];
  for (const e of entries) pages.push({ pageNum: e.pageNum, url: e.url, dataUrl: await imageToDataUrl(await _recSrc(e.rec, preferTranslated)) });
  return { pages };
}

// Image records may hold a Blob (current format) or a legacy base64 data-URL (imported from an
// old backup). These helpers normalize either to the shape a caller needs, in both the service
// worker and pages (no FileReader — it is unavailable in a service worker).
export async function imageToBlob(src) {
  if (!src) return null;
  if (src instanceof Blob) return src;
  try { return await (await fetch(src)).blob(); } catch { return null; }
}
export async function imageToDataUrl(src) {
  if (!src) return null;
  if (typeof src === 'string') return src;
  const buf = new Uint8Array(await src.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
  return `data:${src.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

// Return one page's image as a Blob, transparently decoding a legacy base64 record and
// lazily rewriting it to a Blob on read. variant 'translated' returns the stored
// translated copy when present.
export async function getPageBlob(galleryId, pageNum, variant) {
  const rec = await dbGetByGalleryPage(galleryId, pageNum);
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
    const tx = db.transaction([STORE, BLOB_STORE], 'readwrite');
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
    const tx = db.transaction([STORE, BLOB_STORE], 'readonly');
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
    const tx = db.transaction([STORE, BLOB_STORE], 'readwrite');
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
    const tx = db.transaction([COVER_STORE], 'readonly');
    const req = tx.objectStore(COVER_STORE).get(gid);
    tx.oncomplete = () => resolve(req.result || null);
    tx.onerror = () => reject(tx.error);
  });
  if (!read || !COVER.slots(read).some(([obj, key]) => obj[key] instanceof Blob)) return false;
  let pointer = null;
  if (read.cover instanceof Blob) {
    const urls = (await listGalleryPageKeys(gid)).map(k => k.url);
    const first = urls.length ? await dbGet(urls[0]) : null;
    const image = first?.blob;
    if (image instanceof Blob && image.size === read.cover.size && _stored.get(image) === `${first.url}|page`) {
      const [a, c] = await Promise.all([image.arrayBuffer(), read.cover.arrayBuffer()]);
      const x = new Uint8Array(a), y = new Uint8Array(c);
      if (x.every((v, i) => v === y[i])) pointer = _ref(`${first.url}|page`, image);
    }
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction([COVER_STORE, BLOB_STORE], 'readwrite');
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
export async function putTranslatedPage(url, image, pipeline, own) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(url);
    getReq.onsuccess = () => {
      const rec = getReq.result;
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
      scheduleGallerySize(rec.galleryId);
    };
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// Pages that keep the settings of translation `own` from now on — or, with null, follow the
// current settings again (page-data.js translationGroups).
export async function setPagesOwn(urls, own) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    for (const url of urls) {
      const getReq = store.get(url);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (!rec) return;
        const before = _refIds(rec, PAGE);
        if (own) rec.own = own;
        else delete rec.own;
        store.put(_stash(tx, rec, before, PAGE));
        scheduleGallerySize(rec.galleryId);
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// The output image alone (restoring an export; its pipeline data is restored separately).
// `translatedSrc` is a Blob (preferred — data URLs cost ~33% more storage).
export async function putTranslatedImage(url, translatedSrc) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(url);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (rec) {
        const before = _refIds(rec, PAGE);
        rec.translated = translatedSrc;
        store.put(_stash(tx, rec, before, PAGE));
        scheduleGallerySize(rec.galleryId);
      }
    };
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
export async function putPageStudy(url, study, job = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction([STORE, BLOB_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(url);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (rec && (job == null || rec.pipeline?.job === job)) {
        const before = _refIds(rec, PAGE);
        rec.studyBg = study.bg || null;
        rec.bubbles = study.bubbles;
        rec.studyPage = study.page || null;
        store.put(_stash(tx, rec, before, PAGE));
        scheduleGallerySize(rec.galleryId);
      }
    };
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
    const tx  = db.transaction([STORE, BLOB_STORE], 'readwrite');
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
        if (had) cleared++;
      }
      cursor.continue();
    };
    tx.oncomplete = () => { scheduleGallerySize(gid); resolve(cleared); };
    tx.onerror    = () => reject(tx.error);
  });
}

// db.js — the app's IndexedDB storage layer: images (Blobs), gallery metadata, gallery stats,
// and covers. This is the single canonical library — pages, the PWA service worker, and the
// extension-hosted agent all read and write the same origin-scoped database through this module.

import * as platform from './platform.js';
import { normalizeTitle, migrateTitle } from './titles.js';

const DB_NAME = 'shiori-cache';
const DB_VERSION = 10;
export const STORE = 'images';
const META_STORE = 'metadata';
const GALLERY_STORE = 'galleries';
const COVER_STORE = 'covers';

// Reactive change feed: every durable gallery change is announced through one tiny beacon
// (platform.feed); surfaces subscribe and re-read only the changed gallery from IndexedDB.
let _feedSeq = 0;
const _feedTimers = new Map();

// Announce that one gallery changed. Debounced per gallery so a burst of writes (e.g. storing
// every page of a download) collapses into a single beacon instead of thrashing every surface.
export function publishFeed(galleryId) {
  const gid = String(galleryId);
  if (_feedTimers.has(gid)) return;
  _feedTimers.set(gid, setTimeout(() => {
    _feedTimers.delete(gid);
    platform.feed.publish({ gid, n: ++_feedSeq, at: Date.now() });
  }, 250));
}

// Lower-cased `type:name` strings for the metadata.tagNames multiEntry index, so
// tag:/artist: filters resolve through an index instead of a full scan.
function tagNamesOf(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(t => `${t.type}:${t.name}`.toLowerCase());
}

// ── Lifetime write counter ──

let _writtenBytesPending = 0;
let _writtenBytesTimer   = null;
function _queueWrittenBytes(bytes) {
  _writtenBytesPending += bytes;
  clearTimeout(_writtenBytesTimer);
  _writtenBytesTimer = setTimeout(() => {
    _writtenBytesTimer = null;
    const pending = _writtenBytesPending;
    _writtenBytesPending = 0;
    platform.kv.get(['totalWrittenBytes']).then(r => {
      platform.kv.set({ totalWrittenBytes: (r.totalWrittenBytes || 0) + pending });
    });
  }, 2000);
}

let _db = null;
export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
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

      // Covers live in their own store so gallery stat records stay tiny and a
      // sort/scan over the whole library never loads cover blobs.
      const covers = db.objectStoreNames.contains(COVER_STORE)
        ? tx.objectStore(COVER_STORE)
        : db.createObjectStore(COVER_STORE, { keyPath: 'galleryId' });

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
          if (v.tagNames == null && Array.isArray(v.tags)) { v.tagNames = tagNamesOf(v.tags); dirty = true; }
          // Legacy flat title fields → the canonical { english, japanese, pretty } object.
          if (v.title == null || typeof v.title !== 'object') { v = migrateTitle(v); dirty = true; }
          if (dirty) c.update(v);
          c.continue();
        };
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => { _db.close(); _db = null; };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet(url) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(url);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
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
  const pm = canonUrl.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
  const pageNum = pm ? parseInt(pm[1]) : 9999;
  let coverChanged = false;

  await new Promise((resolve, reject) => {
    // META_STORE joins the tx so a brand-new stat record can seed its denormalized uploadDate
    // (the "Published date" sort key) from the gallery's metadata.
    const tx = db.transaction([STORE, GALLERY_STORE, COVER_STORE, META_STORE], 'readwrite');
    tx.oncomplete = () => { _queueWrittenBytes(size); resolve(); };
    tx.onerror = () => reject(tx.error);

    const images = tx.objectStore(STORE);
    const prevReq = images.get(canonUrl);
    prevReq.onsuccess = () => {
      const prev = prevReq.result || null;
      images.put({ url: canonUrl, blob, mediaId: String(mediaId), galleryId: gid, cachedAt, size });

      const galReq = tx.objectStore(GALLERY_STORE).get(gid);
      galReq.onsuccess = () => {
        const cur = galReq.result;
        if (cur) {
          const entry = {
            ...cur,
            count: cur.count + (prev ? 0 : 1),
            size: cur.size - (prev ? (prev.size || 0) : 0) + size,
            latestAt: Math.max(cur.latestAt || 0, cachedAt),
          };
          // addedAt is the gallery's creation marker — the gid IS the creation time, so it never
          // shifts when a stat record is rebuilt (e.g. an overwrite re-download).
          if (entry.addedAt == null) entry.addedAt = Number(gid) || entry.latestAt;
          if (pageNum <= (cur.coverPage ?? 9999)) {
            entry.coverPage = pageNum;
            tx.objectStore(COVER_STORE).put({ galleryId: gid, cover: blob });
            coverChanged = true;
          }
          tx.objectStore(GALLERY_STORE).put(entry);
        } else {
          // First page of a gallery: seed addedAt from the gid (creation time) and the published
          // date from metadata (0 = unknown → sorts last under "Published date").
          const metaReq = tx.objectStore(META_STORE).get(gid);
          metaReq.onsuccess = () => {
            if (pageNum < 9999) { tx.objectStore(COVER_STORE).put({ galleryId: gid, cover: blob }); coverChanged = true; }
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
    platform.kv.set({ libraryVersion: Date.now() });
    platform.control.send({ type: 'COVER_INVALIDATED', galleryId: gid });
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

export async function metaPut(meta) {
  const db = await openDB();
  // Every write converges on the canonical title format (legacy flat fields stripped), then the
  // tagNames index is kept in sync automatically for every writer.
  let record = migrateTitle(meta);
  if (Array.isArray(record.tags)) record = { ...record, tagNames: tagNamesOf(record.tags) };
  const gid = String(record.galleryId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, GALLERY_STORE], 'readwrite');
    // A bare stub (sourceId placeholder, no pages yet) is not a user-visible gallery —
    // don't wake subscribers for it, or a reactive read could purge it mid-creation
    // (see the pageless-stub grace window in getAllGalleries).
    tx.oncomplete = () => { if (!record.isStub) publishFeed(gid); resolve(); };
    tx.onerror = () => reject(tx.error);
    tx.objectStore(META_STORE).put(record);
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

async function metaGetAll() {
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
    const tx = db.transaction(META_STORE, 'readwrite');
    const req = tx.objectStore(META_STORE).delete(String(galleryId));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
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

async function galleryPut(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readwrite');
    const req = tx.objectStore(GALLERY_STORE).put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function galleryDelete(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readwrite');
    const req = tx.objectStore(GALLERY_STORE).delete(String(galleryId));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function galleryGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ── Cover store helpers ──

export async function coverGet(galleryId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COVER_STORE, 'readonly');
    const req = tx.objectStore(COVER_STORE).get(String(galleryId));
    req.onsuccess = () => resolve(req.result ? req.result.cover : null);
    req.onerror = () => reject(req.error);
  });
}

async function coverPut(galleryId, cover) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COVER_STORE, 'readwrite');
    const req = tx.objectStore(COVER_STORE).put({ galleryId: String(galleryId), cover });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function coverDelete(galleryId) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(COVER_STORE, 'readwrite');
    tx.objectStore(COVER_STORE).delete(String(galleryId));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
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
function _deriveLangs(m) {
  if (!m) return [];
  if (m.translatedLang) return [m.translatedLang];
  const out = [];
  const add = (code) => { if (code && !out.includes(code)) out.push(code); };
  if (Array.isArray(m.tags)) {
    for (const tag of m.tags) {
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
  return {
    id: String(id),
    count: g.count || 0,
    size: g.size || 0,
    latestAt: g.latestAt || 0,
    addedAt: g.addedAt ?? (Number(id) || g.latestAt || 0),
    uploadDate: g.uploadDate ?? (Number(m.uploadDate) || 0),
    coverPage: g.coverPage,
    title: normalizeTitle(m),
    numPages: m.numPages,
    tags: m.tags,
    mediaId: m.mediaId,
    pageExts: m.pageExts,
    isLocalImport: m.isLocalImport || false,
    source: m.source ?? '',
    sourceId: m.sourceId || null,
    sourceUrl: m.sourceUrl || '',
    fetchedAt: m.fetchedAt,
    translated: m.translated || false,
    translatedLang: m.translatedLang || '',
    languages: _deriveLangs(m),
  };
}

// Recompute a gallery's stat record (count/size/cover) from its actual image records —
// the repair path that makes stats truthful again after any historical drift.
export async function rebuildGalleryEntry(galleryId) {
  const gid = String(galleryId);
  const records = await getGalleryImageRecords(gid);
  if (records.length === 0) { await galleryDelete(gid); await coverDelete(gid); return; }
  const prev = await galleryGet(gid);
  let count = 0, size = 0, latestAt = 0, coverSrc = null, coverPage = 9999;
  for (const r of records) {
    count++;
    size += r.size || 0;
    latestAt = Math.max(latestAt, r.cachedAt || 0);
    const pm = r.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
    const pn = pm ? parseInt(pm[1]) : 9999;
    if (pn < coverPage) { coverPage = pn; coverSrc = r.blob ?? r.dataUrl; }
  }
  const uploadDate = prev?.uploadDate ?? (Number((await metaGet(gid))?.uploadDate) || 0);
  await galleryPut({ galleryId: gid, count, size, latestAt, addedAt: prev?.addedAt ?? (Number(gid) || latestAt), coverPage, uploadDate });
  if (coverSrc != null) await coverPut(gid, await imageToBlob(coverSrc));
  publishFeed(gid);
}

// Sweep every gallery and fix any whose stored count disagrees with its actual image records
// (counts written by the pre-guard dbPut could drift on overwrites). Cheap: an index count per
// gallery; only mismatches pay for a full rebuild. Returns how many were repaired.
export async function repairGalleryCounts() {
  const db = await openDB();
  const entries = await galleryGetAll();
  let fixed = 0;
  for (const e of entries) {
    const actual = await new Promise((res) => {
      const q = db.transaction(STORE, 'readonly').objectStore(STORE).index('galleryId').count(IDBKeyRange.only(e.galleryId));
      q.onsuccess = () => res(q.result); q.onerror = () => res(e.count);
    });
    if (actual !== e.count) { await rebuildGalleryEntry(e.galleryId); fixed++; }
  }
  return fixed;
}

// One-time backfill: copy each gallery's published date (metadata.uploadDate) into its stat record,
// so the "Published date" sort runs off the galleries index. Cheap: only rows still missing the
// field pay a metadata read. Returns how many were filled.
export async function backfillUploadDates() {
  const entries = await galleryGetAll();
  let filled = 0;
  for (const e of entries) {
    if (e.uploadDate != null) continue;
    // 0 = unknown published date, so every gallery still appears in the uploadDate index (sorted last).
    const ud = Number((await metaGet(e.galleryId))?.uploadDate) || 0;
    await galleryPut({ ...e, uploadDate: ud });
    filled++;
  }
  return filled;
}

// ── Page lookup ──

export async function dbGetByGalleryPage(galleryId, pageNum) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(String(galleryId)));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(null); return; }
      const m = cursor.value.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      if (m && parseInt(m[1]) === pageNum) { resolve(cursor.value); return; }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
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
      const m = cursor.primaryKey.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
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

export async function deleteGalleryImages(galleryId) {
  const gid = String(galleryId);
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, GALLERY_STORE], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); } else { tx.objectStore(GALLERY_STORE).delete(gid); }
    };
  });
  await coverDelete(gid);
}

export async function getAvgImageSize() {
  const FALLBACK = 310 * 1024;
  try {
    const entries = await galleryGetAll();
    let totalImages = 0, totalSize = 0;
    for (const e of entries) { totalImages += e.count; totalSize += e.size; }
    if (totalImages === 0) return FALLBACK;
    const dbAvg = totalSize / totalImages;
    const ratio = dbAvg / FALLBACK;
    if ((ratio > 1.25 || ratio < 0.75) && totalImages < 30) return FALLBACK;
    return Math.round(dbAvg);
  } catch {
    return FALLBACK;
  }
}

// ── Shared state ──

export const metaFetchPending     = new Set();
const _dedupedGalleries           = new Set();
export const _sourceIdToGalleryId = new Map();

// ── Gallery ID resolution ──
// Site source ids (short numbers) map to internal gallery ids (timestamps). A first sighting
// creates a stub metadata record so concurrent captures agree on the same internal id.

export async function resolveGalleryId(id) {
  const sid = String(id);
  if (sid.length >= 13) return sid;
  if (_sourceIdToGalleryId.has(sid)) return _sourceIdToGalleryId.get(sid);
  const db = await openDB();
  const existing = await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).index('sourceId').get(sid);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (existing) {
    _sourceIdToGalleryId.set(sid, existing.galleryId);
    return existing.galleryId;
  }
  const newGid = String(Date.now());
  await metaPut({ galleryId: newGid, sourceId: sid, isStub: true });
  _sourceIdToGalleryId.set(sid, newGid);
  return newGid;
}

// ── Stats / gallery helpers ──

// Accepts the stored cover (a Blob, or a legacy base64 data-URL) and returns a resized
// webp data-URL the UI can drop into an <img>. Falls back to the full cover when it is
// already small enough or on any decode error.
export async function resizeCover(src, maxW) {
  const inBlob = await imageToBlob(src);
  if (!inBlob || !maxW) return imageToDataUrl(inBlob);
  try {
    const bitmap = await createImageBitmap(inBlob);
    if (bitmap.width <= maxW) { bitmap.close(); return imageToDataUrl(inBlob); }
    const scale = maxW / bitmap.width;
    const canvas = new OffscreenCanvas(maxW, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return imageToDataUrl(await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 }));
  } catch { return imageToDataUrl(inBlob); }
}

export async function getStats() {
  const entries = await galleryGetAll();
  const galleries = {};
  let totalImages = 0, totalSize = 0;
  for (const e of entries) {
    galleries[e.galleryId] = { count: e.count, size: e.size, latestAt: e.latestAt };
    totalImages += e.count;
    totalSize += e.size;
  }
  return { totalImages, totalSize, galleries };
}

async function deduplicateGalleryImages(galleryId) {
  const gid = String(galleryId);
  if (_dedupedGalleries.has(gid)) return;
  const db = await openDB();

  const urlsByPage = new Map();
  await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').openKeyCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { resolve(); return; }
      const url = cursor.primaryKey;
      const m   = url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      if (m) {
        const pn = parseInt(m[1]);
        if (!urlsByPage.has(pn)) urlsByPage.set(pn, []);
        urlsByPage.get(pn).push(url);
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });

  const urlsToDelete = [];
  for (const urls of urlsByPage.values()) {
    if (urls.length <= 1) continue;
    if (urls.some(u => u.startsWith('local://'))) {
      for (const u of urls) {
        if (!u.startsWith('local://')) urlsToDelete.push(u);
      }
    }
  }

  if (urlsToDelete.length === 0) {
    _dedupedGalleries.add(gid);
    return;
  }

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const url of urlsToDelete) store.delete(url);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await rebuildGalleryEntry(gid);
  _dedupedGalleries.add(gid);
}

export async function getAllGalleries() {
  const allMeta = await metaGetAll();

  const localImports = allMeta.filter(m => m.isLocalImport);
  if (localImports.length > 0) {
    await Promise.all(localImports.map(m => deduplicateGalleryImages(m.galleryId)));
  }

  const stats = await getStats();

  // Purge stubs that never received pages — but spare ones created in the last minute,
  // so a gallery whose metadata fetch / first image capture is still in flight isn't
  // deleted out from under it. Stub ids are Date.now() creation timestamps.
  const _stubCutoff = Date.now() - 60000;
  const pagelessStubs = allMeta.filter(m =>
    m.isStub && !(stats.galleries[m.galleryId]?.count > 0) && Number(m.galleryId) < _stubCutoff);
  if (pagelessStubs.length > 0) {
    await Promise.all(pagelessStubs.map(m =>
      metaDelete(m.galleryId).then(() => galleryDelete(m.galleryId)).catch(() => {})
    ));
    const purged = new Set(pagelessStubs.map(m => m.galleryId));
    allMeta.splice(0, allMeta.length, ...allMeta.filter(m => !purged.has(m.galleryId)));
  }

  const metaMap = {};
  for (const m of allMeta) metaMap[m.galleryId] = m;

  const galleries = Object.entries(stats.galleries)
    .sort((a, b) => (b[1].latestAt || 0) - (a[1].latestAt || 0))
    .map(([id, info]) => _entityFrom(id, info, metaMap[id]));
  return { galleries, totalImages: stats.totalImages, totalSize: stats.totalSize };
}

// ── Windowed reads (scale: load only the visible page) ──

// 'id' is intentionally absent: it sorts by the gallery's own primary key (the unix-time-based
// id), handled directly below — never an index, so it stays immutable across re-downloads.
const _SORT_INDEX = { updated: 'latestAt', size: 'size', count: 'count', uploadDate: 'uploadDate' };

// One page of galleries, sorted in the database via an index cursor. Memory is bounded
// by `limit`, not by library size, and cover blobs are never loaded.
export async function galleriesPage({ sort = 'updated', dir, offset = 0, limit = 60 } = {}) {
  const direction = dir === 'asc' ? 'next' : 'prev';
  const db = await openDB();
  const stats = await new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(GALLERY_STORE, 'readonly');
    const store = tx.objectStore(GALLERY_STORE);
    // 'id' cursors the primary key (galleryId) itself; everything else uses its sort index.
    const source = sort === 'id' ? store : store.index(_SORT_INDEX[sort] || 'latestAt');
    const req = source.openCursor(null, direction);
    let advanced = offset <= 0;
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) { resolve(out); return; }
      if (!advanced) { advanced = true; cur.advance(offset); return; }
      out.push(cur.value);
      if (out.length >= limit) { resolve(out); return; }
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
  const metas = await Promise.all(stats.map(s => metaGet(s.galleryId)));
  return stats.map((s, i) => _entityFrom(s.galleryId, s, metas[i]));
}

export async function galleriesCount() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GALLERY_STORE, 'readonly');
    const req = tx.objectStore(GALLERY_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
]);

// Merge a patch into a gallery's metadata and/or stat record, then announce the change
// so every subscribed surface re-renders. The one mutation entry point for gallery
// records — callers never touch metaPut/galleryPut/libraryVersion directly.
export async function mutateGallery(galleryId, patch) {
  const gid = String(galleryId);
  const metaPatch = {}, galPatch = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (_META_FIELDS.has(k)) metaPatch[k] = v; else galPatch[k] = v;
  }
  if (Object.keys(metaPatch).length) {
    const cur = await metaGet(gid) || { galleryId: gid };
    await metaPut({ ...cur, ...metaPatch, galleryId: gid });
  }
  if (Object.keys(galPatch).length) {
    const cur = await galleryGet(gid) || { galleryId: gid };
    await galleryPut({ ...cur, ...galPatch, galleryId: gid });
  }
  publishFeed(gid);
}

export async function removeGallery(galleryId) {
  await deleteGallery(galleryId);
  publishFeed(galleryId);
}

export async function deleteGallery(galleryId) {
  const gid = String(galleryId);
  const meta = await metaGet(gid).catch(() => null);
  if (meta?.sourceId) _sourceIdToGalleryId.delete(String(meta.sourceId));
  await deleteGalleryImages(gid);
  await metaDelete(gid);
  publishFeed(gid);
}

export async function clearAll() {
  _sourceIdToGalleryId.clear();
  const db = await openDB();
  await Promise.all([STORE, META_STORE, GALLERY_STORE, COVER_STORE].map(storeName =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    })
  ));
}

export async function getGalleryImageRecords(galleryId) {
  const db = await openDB();
  const gid = String(galleryId);
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('galleryId').getAll(IDBKeyRange.only(gid));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

// Image source of one record for serving. preferTranslated picks the stored translated
// variant when present — this is what makes a revisited site page show the modified image.
const _recSrc = (r, preferTranslated) =>
  (preferTranslated ? (r.translated ?? r.blob ?? r.dataUrl) : (r.blob ?? r.dataUrl));

// All pages of a gallery as data-URLs, capped so a big gallery doesn't materialize at once.
// Used by the agent to serve the extension's content scripts.
export async function getGalleryPages(galleryId, { preferTranslated = false, capBytes = 8 * 1024 * 1024 } = {}) {
  const records = await getGalleryImageRecords(galleryId);

  const entries = records
    .map(r => {
      const m = r.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      return { pageNum: m ? parseInt(m[1]) : 9999, url: r.url, src: _recSrc(r, preferTranslated) };
    })
    .sort((a, b) => a.pageNum - b.pageNum);

  let total = 0;
  const pages = [];
  for (const e of entries) {
    const bytes = e.src instanceof Blob ? e.src.size : (typeof e.src === 'string' ? Math.round(e.src.length * 0.75) : 0);
    let dataUrl;
    if (e.src && total + bytes <= capBytes) { dataUrl = await imageToDataUrl(e.src); total += bytes; }
    pages.push({ pageNum: e.pageNum, url: e.url, dataUrl });
  }
  return { pages };
}

export async function getGalleryPageRange(galleryId, startPage, endPage, { preferTranslated = false } = {}) {
  const records = await getGalleryImageRecords(galleryId);

  const entries = records
    .map(r => {
      const m = r.url.match(/\/(\d+)\.(webp|jpg|jpeg|png|gif)$/i);
      return { pageNum: m ? parseInt(m[1]) : 9999, url: r.url, src: _recSrc(r, preferTranslated) };
    })
    .filter(p => p.pageNum >= startPage && p.pageNum <= endPage)
    .sort((a, b) => a.pageNum - b.pageNum);

  const pages = [];
  for (const e of entries) pages.push({ pageNum: e.pageNum, url: e.url, dataUrl: await imageToDataUrl(e.src) });
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
  const wantTranslated = variant === 'translated' && rec.translated;
  const blob = await imageToBlob(wantTranslated ? rec.translated : (rec.blob ?? rec.dataUrl));
  if (blob && !wantTranslated && typeof rec.dataUrl === 'string' && rec.blob == null) {
    _rewritePageBlob(rec.url, blob).catch(() => {});  // lazy migrate legacy base64 -> Blob
  }
  return blob;
}

function _rewritePageBlob(url, blob) {
  return openDB().then(db => new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(url);
    req.onsuccess = () => {
      const rec = req.result;
      if (rec && rec.blob == null && typeof rec.dataUrl === 'string') { rec.blob = blob; delete rec.dataUrl; store.put(rec); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  }));
}

// ── Translation variants ──
// A translated page is stored as an extra `translated` field on the existing images
// record, leaving the original untouched. IndexedDB records are schemaless, so this
// needs no DB version bump.

export async function putTranslatedImage(url, translatedDataUrl) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(url);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (rec) { rec.translated = translatedDataUrl; store.put(rec); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// Study-mode data for one page: { bg, bubbles, page }. `bg` is a Blob (the inpainted page, text
// removed) shared by every bubble — or null for metadata-only (text-mode) study records; each
// bubble is { box, region, tr, src, rbox?, style?, text? } where `text` is a Blob (a full-page
// transparent PNG of just that bubble's glyphs, absent on metadata-only records), `box` is the
// OCR detection region (the hover/click border), `region` is the area to clip `bg` to, `rbox`
// the renderer's layout box and `style` renderer hints for DOM-text display. `page` is {w,h} in
// source pixels. All are stored on the page's images record like `translated`, so they ride
// along in backups and clear on revert. A reader reveals one bubble at a time by overlaying its
// text layer (whole) and clipping the shared bg to its region — or as styled DOM text.
export async function putPageStudy(url, study) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(url);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (rec) {
        rec.studyBg = study.bg || null;
        rec.bubbles = study.bubbles;
        rec.studyPage = study.page || null;
        store.put(rec);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// Strips the `translated` field (and any per-bubble study overlays) from every page of a
// gallery, reverting to originals. Returns the number of pages that had a translation removed.
export async function clearGalleryTranslations(galleryId) {
  const db = await openDB();
  const gid = String(galleryId);
  return new Promise((resolve, reject) => {
    let cleared = 0;
    const tx  = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).index('galleryId').openCursor(IDBKeyRange.only(gid));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      if (cursor.value.translated !== undefined || cursor.value.bubbles !== undefined) {
        const v = cursor.value;
        const had = v.translated !== undefined;
        delete v.translated;
        delete v.bubbles;
        delete v.studyBg;
        delete v.studyPage;
        cursor.update(v);
        if (had) cleared++;
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(cleared);
    tx.onerror    = () => reject(tx.error);
  });
}

// backup.js — library backup/restore for moving Shiori between browsers, machines, or a future
// Electron build. Two formats:
//
//   • Metadata-only (.shi)  — a small JSON array of every gallery's metadata. Lightweight;
//     restoring recreates gallery entries without images.
//   • Full (.shioridb)      — the whole database, images included, streamed to disk.
//     Layout: [ blob bytes … ][ manifest JSON ][ uint32 LE manifest length ]. Export streams
//     each blob straight to the destination file (File System Access API) recording offsets;
//     import reads only the manifest and lazily slices each image out of the picked file —
//     nothing but one image (and the manifest) is ever resident, so multi-GB libraries work.
//
// importBackup() detects the format from the file itself, so one picker handles both.

import {
  publishFeed, metaPut, backfillUploadDates, coverPut, refreshSeriesAggregate, sourceIconPut,
  metaGetAll, galleryGetAll, galleryGet, galleryPut, sourceIconsAll,
  imageKeysAll, imageRecordPut, dbGet, coverKeysAll, coverRecordGet, BUBBLE_EXTRA_FIELDS,
} from './db.js';
import { isValidGalleryId } from './sanitize.js';

// Decode a base64 data-URL to a Blob (legacy records store images as strings). One image at a time.
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const mime = (dataUrl.slice(0, comma).match(/^data:([^;,]+)/) || [, 'application/octet-stream'])[1];
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
const toBlob = (v) => v instanceof Blob ? v : (typeof v === 'string' ? dataUrlToBlob(v) : null);

function footerBytes(manifestLen) {
  const f = new Uint8Array(4); new DataView(f.buffer).setUint32(0, manifestLen, true); return f;
}

// A full backup carries the archive format version. Bumped to 8 when the settings snapshot was
// added; older archives simply restore without settings. Newer-than-us archives are refused.
const ARCHIVE_VERSION = 8;

// ── Settings snapshot ───────────────────────────────────────────────────────────────────────
// Every persistent preference rides in the full backup, both conventions: the shiori:* kv keys
// and the small set of boot-synchronous dash keys. Per-browser state (integration status cache,
// session-scoped caches, how this browser stores its images), one-time repair flags (a restored
// library should re-run its repairs — `schemaSteps` now, the older per-repair flags before it), and
// the pairing capability stay out — they must not follow the library to another browser.
// Values are raw localStorage strings, restored verbatim.
const SETTINGS_DASH_KEYS = ['shiori-lang', 'shiori-safe-mode', 'shiori-reader-pin', 'shiori-header-pin'];
const SETTINGS_KV_EXCLUDE = new Set(['agentPairSecret', 'schemaSteps', 'countsRepaired', 'seriesShellStatsRepaired',
  'uploadDateBackfilled', 'storageLayout']);

function snapshotSettings() {
  const out = { kv: {}, dash: {} };
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('shiori:')) continue;
      const short = key.slice('shiori:'.length);
      if (SETTINGS_KV_EXCLUDE.has(short)) continue;
      out.kv[short] = localStorage.getItem(key);
    }
    for (const key of SETTINGS_DASH_KEYS) {
      const v = localStorage.getItem(key);
      if (v != null) out.dash[key] = v;
    }
  } catch {}
  return out;
}

function restoreSettings(settings) {
  if (!settings || typeof settings !== 'object') return 0;
  let n = 0;
  try {
    for (const [k, v] of Object.entries(settings.kv || {})) {
      if (SETTINGS_KV_EXCLUDE.has(k) || typeof v !== 'string') continue;
      localStorage.setItem('shiori:' + k, v); n++;
    }
    for (const [k, v] of Object.entries(settings.dash || {})) {
      if (!SETTINGS_DASH_KEYS.includes(k) || typeof v !== 'string') continue;
      localStorage.setItem(k, v); n++;
    }
  } catch {}
  return n;
}

// ── Metadata-only export (.shi) ─────────────────────────────────────────────────────────────
export async function exportMetadata() {
  const allMeta = await metaGetAll();
  const payload = allMeta.map(({ pageExts, ...rest }) => rest);
  return {
    blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    suggestedName: `shiori-backup-${new Date().toISOString().slice(0, 10)}.shi`,
    count: payload.length,
  };
}

// ── Full export (.shioridb) ─────────────────────────────────────────────────────────────────
// Streams to a user-chosen file when the File System Access API is available (no archive ever
// held in memory). Otherwise falls back to assembling a Blob the caller downloads.
export async function exportFull(onProgress) {
  const suggestedName = `shiori-${new Date().toISOString().slice(0, 10)}.shioridb`;

  // Ask for the destination FIRST, while the export click's user activation is still live
  // (before any await), so the file picker is allowed to open.
  let handle = null;
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: 'Shiori database', accept: { 'application/octet-stream': ['.shioridb'] } }] });
    } catch (e) { if (e && e.name === 'AbortError') return { aborted: true }; throw e; }
  }

  if (handle) {
    const writable = await handle.createWritable();
    let offset = 0;
    const writeBlob = async (blob) => { await writable.write(blob); const spec = { off: offset, len: blob.size, type: blob.type || '' }; offset += blob.size; return spec; };
    try {
      const manifest = await build(writeBlob, onProgress);
      const mb = new TextEncoder().encode(JSON.stringify(manifest));
      await writable.write(mb); await writable.write(footerBytes(mb.length));
      await writable.close();
    } catch (e) { try { await writable.abort(); } catch {} throw e; }
    if (onProgress) onProgress('done', 1, 1);
    return { counts: lastCounts, savedVia: 'picker' };
  }

  // Fallback: collect blob references, assemble one archive Blob (disk-backed), hand it back.
  const parts = []; let offset = 0;
  const refBlob = async (blob) => { const spec = { off: offset, len: blob.size, type: blob.type || '' }; parts.push(blob); offset += blob.size; return spec; };
  const manifest = await build(refBlob, onProgress);
  const mb = new TextEncoder().encode(JSON.stringify(manifest));
  const archive = new Blob([...parts, mb, footerBytes(mb.length)], { type: 'application/octet-stream' });
  if (onProgress) onProgress('done', 1, 1);
  return { counts: lastCounts, savedVia: 'download', archive, suggestedName };
}

let lastCounts = null;
const PIPELINE_MASKS = ['raw', 'text'];

// Walk every store one record at a time, handing each blob to `sink` (which writes it and returns
// its { off, len, type }). Returns the manifest. Holds at most one image at a time.
async function build(sink, onProgress) {
  const images = [];
  const imgKeys = await imageKeysAll();
  for (let i = 0; i < imgKeys.length; i++) {
    const r = await dbGet(imgKeys[i]);
    if (!r) continue;
    const ent = { url: r.url, mediaId: r.mediaId, galleryId: r.galleryId, cachedAt: r.cachedAt, size: r.size };
    // The page's pipeline data (what a later translation reuses): inline, with its masks streamed.
    if (r.pipeline) {
      const { masks = {}, ...data } = r.pipeline;
      const specs = {};
      for (const name of PIPELINE_MASKS) { const m = toBlob(masks[name]); if (m) specs[name] = await sink(m); }
      ent.pipeline = { ...data, masks: specs };
    }
    if (r.own) ent.own = r.own;   // the translation whose settings the page keeps
    if (r.translatedLayers) ent.translatedLayers = true;   // the translated page is its study layers
    const body = toBlob(r.blob ?? r.dataUrl);
    if (body) ent.body = await sink(body);
    if (r.translated != null) { const tb = toBlob(r.translated); if (tb) ent.translated = await sink(tb); }
    // Study-mode layers: stream the shared inpaint bg and each bubble's transparent text PNG
    // into the blob region (like body/translated), and keep layout/text metadata inline in the
    // manifest. A text-only study record has bubbles but no studyBg and must still round-trip.
    if (r.studyBg != null) { const sb = toBlob(r.studyBg); if (sb) ent.studyBg = await sink(sb); }
    if (r.studyPage != null) ent.studyPage = r.studyPage;
    if (Array.isArray(r.bubbles) && r.bubbles.length) {
      const bubs = [];
      for (const b of r.bubbles) {
        const tb = toBlob(b.text);
        const bubble = { box: b.box, region: b.region, tr: b.tr || '', src: b.src || '', text: tb ? await sink(tb) : null };
        for (const key of BUBBLE_EXTRA_FIELDS) {
          if (b[key] != null) bubble[key] = b[key];
        }
        bubs.push(bubble);
      }
      ent.bubbles = bubs;
    }
    images.push(ent);
    if (onProgress && i % 25 === 0) onProgress('images', i + 1, imgKeys.length);
  }
  const covers = [];
  for (const key of await coverKeysAll()) {
    const c = await coverRecordGet(key);
    if (!c) continue;
    const ent = { galleryId: c.galleryId };
    const body = toBlob(c.cover);
    if (body) ent.body = await sink(body);
    const seriesBody = toBlob(c.seriesCover);
    if (seriesBody) ent.seriesBody = await sink(seriesBody);
    if (ent.body || ent.seriesBody) covers.push(ent);
  }
  const metadata = await metaGetAll();
  const galleries = await galleryGetAll();
  const sourceIcons = await sourceIconsAll().catch(() => []);
  lastCounts = { images: images.length, galleries: galleries.length, covers: covers.length, sourceIcons: sourceIcons.length };
  return { format: 'shiori-db', version: ARCHIVE_VERSION, exportedAt: Date.now(), counts: lastCounts, images, covers, sourceIcons, metadata, galleries, settings: snapshotSettings() };
}

// ── Import (auto-detect) ────────────────────────────────────────────────────────────────────
// Accepts either format: a .shioridb archive (binary, manifest at tail) or a .shi metadata
// JSON. Returns { kind, counts }.
export async function importBackup(file, onProgress) {
  if (/\.shi$/i.test(file.name) || file.type === 'application/json') {
    return { kind: 'metadata', counts: await importMetadataFile(file) };
  }
  return { kind: 'full', counts: await importFullFile(file, onProgress) };
}

// Reject a record whose identity fields aren't the app's own numeric id format. Imported ids end
// up in DOM attributes and hrefs on every surface, so a crafted backup with markup ids is a
// stored-XSS attempt — the whole file is rejected before any write.
function _assertValidIds(meta) {
  if (!isValidGalleryId(meta.galleryId)) throw new Error('Backup contains an invalid gallery id — file rejected.');
  if (meta.parentId != null && !isValidGalleryId(meta.parentId)) throw new Error('Backup contains an invalid gallery id — file rejected.');
  if (Array.isArray(meta.chapters) && meta.chapters.some(c => !isValidGalleryId(c?.id))) throw new Error('Backup contains an invalid gallery id — file rejected.');
}

async function importMetadataFile(file) {
  let entries;
  try { entries = JSON.parse(await file.text()); }
  catch { throw new Error('Invalid backup file — could not parse JSON.'); }
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Backup file is empty or unrecognised.');
  for (const meta of entries) { if (meta?.galleryId) _assertValidIds(meta); }

  let n = 0;
  const seriesOwners = new Set();
  for (const meta of entries) {
    if (!meta.galleryId) continue;
    const gid = String(meta.galleryId);
    const nextMeta = { ...meta, galleryId: gid, fetchedAt: Date.now() };
    await metaPut(nextMeta);
    const existingGal = await galleryGet(gid).catch(() => null);
    await galleryPut({
      galleryId: gid,
      count:     existingGal?.count    || 0,
      size:      existingGal?.size     || 0,
      latestAt:  Date.now(),                                       // a metadata upload is a modification
      addedAt:   existingGal?.addedAt  || Date.now(),              // restore-time marks "came from backup"
      coverPage: existingGal?.coverPage ?? 9999,
      uploadDate: Number(meta.uploadDate) || existingGal?.uploadDate || 0,
      // Keep the stat record's series link in step with the metadata, so a chapter restored from a
      // metadata-only backup stays hidden from the top-level grid (which filters on stat.parentId).
      ...(nextMeta.parentId ? { parentId: String(nextMeta.parentId) } : {}),
      ...(Array.isArray(nextMeta.chapters) && nextMeta.chapters.length > 1 ? { chapterCount: nextMeta.chapters.length } : {}),
    });
    if (nextMeta.parentId) seriesOwners.add(String(nextMeta.parentId));
    if (Array.isArray(nextMeta.chapters) && nextMeta.chapters.length > 1) seriesOwners.add(gid);
    n++;
  }
  for (const ownerId of seriesOwners) await refreshSeriesAggregate(ownerId).catch(() => {});
  return { galleries: n, images: 0 };
}

const _validSpec = (spec, blobRegionEnd) => spec == null
  || (Number.isInteger(spec.off) && spec.off >= 0 && Number.isInteger(spec.len) && spec.len >= 0
      && spec.off + spec.len <= blobRegionEnd);

// Full structural validation before the first write: identity format (imported ids reach DOM
// attributes on every surface — see _assertValidIds) and every blob slice inside the file's blob
// region. A truncated or crafted archive must fail before it can mutate anything.
function validateFullManifest(manifest, blobRegionEnd) {
  if (!manifest || manifest.format !== 'shiori-db') throw new Error('Not a Shiori database archive');
  if (Number(manifest.version) > ARCHIVE_VERSION) throw new Error('Archive was created by a newer app version.');
  if (!manifest.counts || typeof manifest.counts !== 'object') throw new Error('Corrupt archive (missing counts)');
  const bad = (what) => { throw new Error(`Corrupt archive (${what})`); };
  for (const e of (manifest.images || [])) {
    if (!isValidGalleryId(e.galleryId)) bad('invalid gallery id');
    const specs = [e.body, e.translated, e.studyBg, ...(Array.isArray(e.bubbles) ? e.bubbles.map(b => b?.text) : []),
      ...PIPELINE_MASKS.map(name => e.pipeline?.masks?.[name])];
    if (!specs.every(s => _validSpec(s, blobRegionEnd))) bad('blob out of bounds');
  }
  for (const c of (manifest.covers || [])) {
    if (!isValidGalleryId(c.galleryId)) bad('invalid gallery id');
    if (!_validSpec(c.body, blobRegionEnd) || !_validSpec(c.seriesBody, blobRegionEnd)) bad('blob out of bounds');
  }
  for (const m of (manifest.metadata || [])) _assertValidIds(m);
  for (const g of (manifest.galleries || [])) { if (!isValidGalleryId(g.galleryId)) bad('invalid gallery id'); }
}

// Reads the manifest from the file's tail, then lazily slices each image out of the picked
// file — the whole archive is never loaded.
async function importFullFile(file, onProgress) {
  const size = file.size;
  if (size < 4) throw new Error('Empty or invalid archive');
  const manifestLen = new DataView(await file.slice(size - 4).arrayBuffer()).getUint32(0, true);
  const manifestStart = size - 4 - manifestLen;
  if (manifestStart < 0) throw new Error('Corrupt archive (bad manifest length)');
  const manifest = JSON.parse(await file.slice(manifestStart, size - 4).text());
  validateFullManifest(manifest, manifestStart);

  const sliceOf = (spec) => spec ? file.slice(spec.off, spec.off + spec.len, spec.type || '') : null;
  let n = 0;
  for (const e of (manifest.images || [])) {
    const rec = { url: e.url, mediaId: e.mediaId, galleryId: e.galleryId, cachedAt: e.cachedAt, size: e.size };
    if (e.pipeline && typeof e.pipeline === 'object') {
      const { masks = {}, ...data } = e.pipeline;
      rec.pipeline = { ...data, masks: {} };
      for (const name of PIPELINE_MASKS) { const m = sliceOf(masks[name]); if (m) rec.pipeline.masks[name] = m; }
    }
    if (typeof e.own === 'string') rec.own = e.own;
    if (e.translatedLayers === true) rec.translatedLayers = true;
    const b = sliceOf(e.body); if (b) rec.blob = b;
    const tb = sliceOf(e.translated); if (tb) rec.translated = tb;
    const sb = sliceOf(e.studyBg); if (sb) rec.studyBg = sb;
    if (e.studyPage != null) rec.studyPage = e.studyPage;
    if (Array.isArray(e.bubbles) && e.bubbles.length) {
      rec.bubbles = e.bubbles.map((b) => {
        const bubble = { box: b.box, region: b.region || b.box, tr: b.tr || '', src: b.src || '', text: sliceOf(b.text) };
        for (const key of BUBBLE_EXTRA_FIELDS) {
          if (b[key] != null) bubble[key] = b[key];
        }
        return bubble;
      });
    }
    await imageRecordPut(rec);
    if (onProgress && (++n % 25 === 0)) onProgress('images', n, (manifest.images || []).length);
  }
  for (const m of (manifest.metadata || [])) await metaPut(m);
  for (const g of (manifest.galleries || [])) await galleryPut(g);
  // Silent cover writes: the per-gallery publishFeed pass below announces the restore — loud
  // coverPuts here would additionally ping every open surface once per cover blob.
  for (const e of (manifest.covers || [])) {
    const b = sliceOf(e.body);
    const sb = sliceOf(e.seriesBody);
    if (b) await coverPut(e.galleryId, b, { role: 'gallery', silent: true });
    if (sb) await coverPut(e.galleryId, sb, { role: 'series', silent: true });
  }
  for (const icon of (manifest.sourceIcons || [])) {
    if (icon?.source && /^data:image\//i.test(icon.dataUrl || '')) await sourceIconPut(icon.source, icon);
  }
  await backfillUploadDates();   // older archives predate the denormalized uploadDate — fill it from metadata
  const seriesOwners = new Set();
  for (const m of (manifest.metadata || [])) {
    if (m?.parentId) seriesOwners.add(String(m.parentId));
    if (Array.isArray(m?.chapters) && m.chapters.length > 1) seriesOwners.add(String(m.galleryId));
  }
  for (const ownerId of seriesOwners) await refreshSeriesAggregate(ownerId).catch(() => {});
  for (const g of (manifest.galleries || [])) publishFeed(g.galleryId);
  // Settings restore LAST: preferences must never land if the data restore failed part-way.
  restoreSettings(manifest.settings);
  if (onProgress) onProgress('done', 1, 1);
  return manifest.counts;
}

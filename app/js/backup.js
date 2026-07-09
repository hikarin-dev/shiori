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

import { openDB, publishFeed, metaPut, backfillUploadDates, coverPut, refreshSeriesAggregate, sourceIconPut } from './db.js';

const IMAGES = 'images', META = 'metadata', GALLERIES = 'galleries', COVERS = 'covers', SOURCE_ICONS = 'sourceIcons';

const getAllKeys = (db, s) => new Promise((res, rej) => { const tx = db.transaction(s, 'readonly'); const q = tx.objectStore(s).getAllKeys(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
const getByKey = (db, s, k) => new Promise((res, rej) => { const tx = db.transaction(s, 'readonly'); const q = tx.objectStore(s).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
const getAll = (db, s) => new Promise((res, rej) => { const tx = db.transaction(s, 'readonly'); const q = tx.objectStore(s).getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
const put = (db, s, rec) => new Promise((res, rej) => { const tx = db.transaction(s, 'readwrite'); tx.objectStore(s).put(rec); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });

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

// ── Metadata-only export (.shi) ─────────────────────────────────────────────────────────────
export async function exportMetadata() {
  const db = await openDB();
  const allMeta = await getAll(db, META);
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
  const db = await openDB();

  if (handle) {
    const writable = await handle.createWritable();
    let offset = 0;
    const writeBlob = async (blob) => { await writable.write(blob); const spec = { off: offset, len: blob.size, type: blob.type || '' }; offset += blob.size; return spec; };
    try {
      const manifest = await build(db, writeBlob, onProgress);
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
  const manifest = await build(db, refBlob, onProgress);
  const mb = new TextEncoder().encode(JSON.stringify(manifest));
  const archive = new Blob([...parts, mb, footerBytes(mb.length)], { type: 'application/octet-stream' });
  if (onProgress) onProgress('done', 1, 1);
  return { counts: lastCounts, savedVia: 'download', archive, suggestedName };
}

let lastCounts = null;

// Walk every store one record at a time, handing each blob to `sink` (which writes it and returns
// its { off, len, type }). Returns the manifest. Holds at most one image at a time.
async function build(db, sink, onProgress) {
  const images = [];
  const imgKeys = await getAllKeys(db, IMAGES);
  for (let i = 0; i < imgKeys.length; i++) {
    const r = await getByKey(db, IMAGES, imgKeys[i]);
    if (!r) continue;
    const ent = { url: r.url, mediaId: r.mediaId, galleryId: r.galleryId, cachedAt: r.cachedAt, size: r.size };
    const body = toBlob(r.blob ?? r.dataUrl);
    if (body) ent.body = await sink(body);
    if (r.translated != null) { const tb = toBlob(r.translated); if (tb) ent.translated = await sink(tb); }
    // Study-mode layers: stream the shared inpaint bg and each bubble's transparent text PNG
    // into the blob region (like body/translated), and keep each bubble's box/region geometry
    // + text strings inline in the manifest — small and human-readable (easy to inspect/debug).
    if (r.studyBg != null) { const sb = toBlob(r.studyBg); if (sb) ent.studyBg = await sink(sb); }
    if (Array.isArray(r.bubbles) && r.bubbles.length) {
      const bubs = [];
      for (const b of r.bubbles) {
        const tb = toBlob(b.text);
        bubs.push({ box: b.box, region: b.region, tr: b.tr || '', src: b.src || '', text: tb ? await sink(tb) : null });
      }
      ent.bubbles = bubs;
    }
    images.push(ent);
    if (onProgress && i % 25 === 0) onProgress('images', i + 1, imgKeys.length);
  }
  const covers = [];
  for (const key of await getAllKeys(db, COVERS)) {
    const c = await getByKey(db, COVERS, key);
    if (!c) continue;
    const ent = { galleryId: c.galleryId };
    const body = toBlob(c.cover);
    if (body) ent.body = await sink(body);
    const seriesBody = toBlob(c.seriesCover);
    if (seriesBody) ent.seriesBody = await sink(seriesBody);
    if (ent.body || ent.seriesBody) covers.push(ent);
  }
  const metadata = await getAll(db, META);
  const galleries = await getAll(db, GALLERIES);
  const sourceIcons = await getAll(db, SOURCE_ICONS).catch(() => []);
  lastCounts = { images: images.length, galleries: galleries.length, covers: covers.length, sourceIcons: sourceIcons.length };
  return { format: 'shiori-db', version: 6, exportedAt: Date.now(), counts: lastCounts, images, covers, sourceIcons, metadata, galleries };
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

async function importMetadataFile(file) {
  let entries;
  try { entries = JSON.parse(await file.text()); }
  catch { throw new Error('Invalid backup file — could not parse JSON.'); }
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Backup file is empty or unrecognised.');

  const db = await openDB();
  let n = 0;
  const seriesOwners = new Set();
  for (const meta of entries) {
    if (!meta.galleryId) continue;
    const gid = String(meta.galleryId);
    const nextMeta = { ...meta, galleryId: gid, fetchedAt: Date.now() };
    await metaPut(nextMeta);
    const existingGal = await getByKey(db, GALLERIES, gid).catch(() => null);
    await put(db, GALLERIES, {
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

// Reads the manifest from the file's tail, then lazily slices each image out of the picked
// file — the whole archive is never loaded.
async function importFullFile(file, onProgress) {
  const size = file.size;
  if (size < 4) throw new Error('Empty or invalid archive');
  const manifestLen = new DataView(await file.slice(size - 4).arrayBuffer()).getUint32(0, true);
  const manifestStart = size - 4 - manifestLen;
  if (manifestStart < 0) throw new Error('Corrupt archive (bad manifest length)');
  const manifest = JSON.parse(await file.slice(manifestStart, size - 4).text());
  if (manifest.format !== 'shiori-db') throw new Error('Not a Shiori database archive');

  const sliceOf = (spec) => spec ? file.slice(spec.off, spec.off + spec.len, spec.type || '') : null;
  const db = await openDB();
  let n = 0;
  for (const e of (manifest.images || [])) {
    const rec = { url: e.url, mediaId: e.mediaId, galleryId: e.galleryId, cachedAt: e.cachedAt, size: e.size };
    const b = sliceOf(e.body); if (b) rec.blob = b;
    const tb = sliceOf(e.translated); if (tb) rec.translated = tb;
    const sb = sliceOf(e.studyBg); if (sb) rec.studyBg = sb;
    if (Array.isArray(e.bubbles) && e.bubbles.length) {
      rec.bubbles = e.bubbles.map(b => ({ box: b.box, region: b.region, tr: b.tr || '', src: b.src || '', text: sliceOf(b.text) }));
    }
    await put(db, IMAGES, rec);
    if (onProgress && (++n % 25 === 0)) onProgress('images', n, (manifest.images || []).length);
  }
  for (const m of (manifest.metadata || [])) await metaPut(m);
  for (const g of (manifest.galleries || [])) await put(db, GALLERIES, g);
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
  if (onProgress) onProgress('done', 1, 1);
  return manifest.counts;
}

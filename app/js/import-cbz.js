// import-cbz.js — CBZ/zip import engine, plus the shared zip primitives (unzip, image-entry
// sorting) the download orchestration reuses. Runs in a page or in the PWA service worker.

import * as platform from './platform.js';
import { dbPut, metaPut, metaGet, galleryGet, deleteGalleryImages, existingPageNums, publishFeed,
         putTranslatedImage, putPageStudy, mutateGallery, refreshSeriesAggregate, pruneSeriesChildren, coverPut } from './db.js';

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Parse a zip via its central directory (store + deflate entries) -> [{ filename, data }].
export async function unzip(buffer) {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i--) { if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd === -1) throw new Error('Not a valid ZIP file');
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const filename = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;
    if (filename.endsWith('/')) continue;
    const lNameLen = view.getUint16(local + 26, true), lExtraLen = view.getUint16(local + 28, true);
    const dataStart = local + 30 + lNameLen + lExtraLen;
    const comp = bytes.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = await inflateRaw(comp);
    else continue;
    out.push({ filename, data });
  }
  return out;
}

async function restoreExportedCovers(gid, byName) {
  const coverEntries = [];
  const manifestData = byName.get('covers/manifest.json');
  if (manifestData) {
    try {
      const manifest = JSON.parse(new TextDecoder().decode(manifestData));
      for (const c of (manifest.covers || [])) {
        if ((c.role === 'gallery' || c.role === 'series') && c.file) coverEntries.push(c);
      }
    } catch {}
  }
  if (!coverEntries.length) {
    for (const role of ['gallery', 'series']) {
      for (const name of byName.keys()) {
        if (new RegExp(`^covers/${role}\\.(jpe?g|png|webp|gif)$`, 'i').test(name)) {
          coverEntries.push({ role, file: name });
          break;
        }
      }
    }
  }

  for (const c of coverEntries) {
    const data = byName.get(c.file);
    if (!data) continue;
    const ext = normExt(c.file.match(/\.(\w+)$/)?.[1]);
    await coverPut(gid, new Blob([data], { type: c.mime || MIME[ext] || 'image/jpeg' }), { role: c.role });
  }
}

export function sortImageEntries(entries) {
  return entries
    .filter(e => /\.(jpe?g|png|webp|gif)$/i.test(e.filename))
    .sort((a, b) => {
      const na = a.filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
      const nb = b.filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
      return na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' });
    });
}

export const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
export const normExt = (ext) => { const e = (ext || 'jpg').toLowerCase(); return e === 'jpeg' ? 'jpg' : e; };

// Import a zip buffer into the library. Idempotent in skipExisting mode: re-running only
// stores missing pages, which is what makes the upload job resumable.
//   skipExisting=false → replace mode: delete existing pages, write all from CBZ
//   skipExisting=true  → import mode:  keep existing pages, write only new ones
export async function importCbzBuffer(galleryId, buffer, filename, skipExisting, onProgress = () => {}) {
  const origGid = String(galleryId);
  onProgress({ status: 'extracting' });
  let entries;
  try { entries = await unzip(buffer); }
  catch (e) { onProgress({ status: 'error', error: 'Failed to parse CBZ: ' + e.message }); return; }

  // A Shiori series export bundles each chapter under chapter-NN/ with a top-level series.json.
  // Restore every chapter as its own gallery, then rebuild the series grouping.
  const seriesEntry = entries.find(en => en.filename === 'series.json');
  if (seriesEntry) {
    let manifest = null;
    try { manifest = JSON.parse(new TextDecoder().decode(seriesEntry.data)); } catch {}
    if (manifest && Array.isArray(manifest.chapters) && manifest.chapters.length) {
      return _importSeriesZip(entries, manifest, onProgress);
    }
  }

  const metaEntry = entries.find(en => en.filename === 'metadata.json');
  let embeddedMeta = null;
  if (metaEntry) { try { embeddedMeta = JSON.parse(new TextDecoder().decode(metaEntry.data)); } catch {} }

  // A Shiori per-gallery export (has image_records.json) carries pages under images/ plus
  // translated/ and study/ folders. Restore it losslessly — and never let those parallel
  // folders get imported as extra pages (the plain-CBZ path below only sees a normal archive).
  if (entries.some(en => en.filename === 'image_records.json')) {
    const gid = String(embeddedMeta?.galleryId || origGid);
    return _importShioriEntries(gid, entries, embeddedMeta, onProgress);
  }

  const nameNoExt = filename.replace(/\.[^.]+$/, '');
  const gid = (skipExisting && embeddedMeta?.galleryId) ? String(embeddedMeta.galleryId) : origGid;
  const imgEntries = sortImageEntries(entries);

  if (imgEntries.length === 0) {
    if (!embeddedMeta) { onProgress({ status: 'error', error: 'No images found in CBZ.' }); return; }
    await _putMetadataOnlyGallery(gid, embeddedMeta);
    onProgress({ status: 'done', done: 0, total: 0, skipped: 0 });
    platform.kv.set({ libraryVersion: Date.now() });
    publishFeed(gid);
    return;
  }

  const pageExts = imgEntries.map(en => normExt(en.filename.match(/\.(\w+)$/)?.[1]));
  // Uploading a Shiori-exported CBZ over an existing gallery is a replace.
  if (skipExisting && embeddedMeta) {
    const gal = await galleryGet(gid).catch(() => null);
    if (gal?.count > 0) skipExisting = false;
  }
  if (skipExisting) {
    await metaPut(embeddedMeta
      ? { ...embeddedMeta, galleryId: gid, pageExts, fetchedAt: Date.now() }
      : { galleryId: gid, title: { english: nameNoExt, japanese: '', pretty: nameNoExt }, tags: [], numPages: 0, pageExts, fetchedAt: Date.now(), isLocalImport: true, source: '' });
  } else {
    const existing = await metaGet(gid).catch(() => null);
    await metaPut(existing
      ? { ...existing, isLocalImport: true }
      : { galleryId: gid, title: { english: nameNoExt, japanese: '', pretty: nameNoExt }, tags: [], numPages: 0, pageExts, fetchedAt: Date.now(), isLocalImport: true, source: '' });
    await deleteGalleryImages(gid);
  }

  // Pages already stored (a resumed/interrupted run) are skipped, never re-put — re-putting
  // would double-count the gallery's stat record.
  const have = skipExisting ? await existingPageNums(gid) : new Set();

  onProgress({ status: 'started', done: 0, total: imgEntries.length, skipped: 0 });
  let done = 0, skipped = 0;
  for (let i = 0; i < imgEntries.length; i++) {
    if (have.has(i + 1)) { skipped++; onProgress({ done, total: imgEntries.length, skipped, status: 'progress' }); continue; }
    const ext = normExt(imgEntries[i].filename.match(/\.(\w+)$/)?.[1]);
    const blob = new Blob([imgEntries[i].data], { type: MIME[ext] || 'image/jpeg' });
    await dbPut(`local://${gid}/${i + 1}.${ext}`, blob, gid, gid);
    onProgress({ done: ++done, total: imgEntries.length, skipped, status: 'progress' });
  }
  onProgress({ status: 'done', done, total: imgEntries.length, skipped });
  platform.kv.set({ libraryVersion: Date.now() });
  publishFeed(gid);
}

// Tag union de-duped by lower-cased `type:name` (the key db.js indexes on).
function _unionTags(...lists) {
  const seen = new Set(), out = [];
  for (const list of lists) for (const t of (list || [])) {
    if (!t || t.type == null || t.name == null) continue;
    const k = `${t.type}:${t.name}`.toLowerCase();
    if (seen.has(k)) continue; seen.add(k); out.push(t);
  }
  return out;
}

async function _putMetadataOnlyGallery(gid, meta) {
  const id = String(gid);
  const nextMeta = meta
    ? { ...meta, galleryId: id, fetchedAt: Date.now() }
    : { galleryId: id, title: { english: id, japanese: '', pretty: id }, tags: [], numPages: 0, pageExts: [], fetchedAt: Date.now(), isLocalImport: true, source: '' };
  await metaPut(nextMeta);
  const existing = await galleryGet(id).catch(() => null);
  await mutateGallery(id, {
    count: existing?.count || 0,
    size: existing?.size || 0,
    latestAt: Date.now(),
    addedAt: existing?.addedAt || (Number(id) || Date.now()),
    coverPage: existing?.coverPage ?? 9999,
    uploadDate: Number(nextMeta.uploadDate) || existing?.uploadDate || 0,
    parentId: nextMeta.parentId ? String(nextMeta.parentId) : null,
    ...(Array.isArray(nextMeta.chapters) && nextMeta.chapters.length > 1 ? { chapterCount: nextMeta.chapters.length } : {}),
  });
}

// Restore a Shiori series export: each chapter-NN/ folder is a self-contained per-gallery export.
// Import every chapter into its own gallery (its embedded id), then wire the grouping onto the
// first chapter (the owner) and back-link every other chapter.
async function _importSeriesZip(entries, manifest, onProgress) {
  const chapters = [];   // { id, title } in series order, with the imported gids
  const tagLists = [];
  let embeddedSeriesTags = null;
  const total = manifest.chapters.length;
  for (let i = 0; i < total; i++) {
    const c = manifest.chapters[i];
    const folder = String(c.folder || `chapter-${String(i + 1).padStart(2, '0')}`).replace(/\/+$/, '') + '/';
    const sub = entries.filter(en => en.filename.startsWith(folder))
      .map(en => ({ filename: en.filename.slice(folder.length), data: en.data }));
    if (!sub.length) continue;
    const metaEntry = sub.find(en => en.filename === 'metadata.json');
    let cmeta = null;
    if (metaEntry) { try { cmeta = JSON.parse(new TextDecoder().decode(metaEntry.data)); } catch {} }
    if (i === 0 && Array.isArray(cmeta?.seriesTags)) embeddedSeriesTags = cmeta.seriesTags;
    if (cmeta) { delete cmeta.chapters; delete cmeta.parentId; delete cmeta.seriesTitle; delete cmeta.seriesTags; }  // grouping is rebuilt below
    const gid = String(cmeta?.galleryId || c.id || (Date.now() + i));
    const hasFullPayload = sub.some(en =>
      en.filename === 'image_records.json' ||
      /^(images|translated|study|covers)\//i.test(en.filename));
    if (hasFullPayload) {
      await _importShioriEntries(gid, sub, cmeta, (p) => { if (p.status !== 'done') onProgress({ ...p, chapter: i + 1, chapterCount: total }); });
    } else {
      await _putMetadataOnlyGallery(gid, cmeta);
      publishFeed(gid);
    }
    chapters.push({ id: gid, title: c.title || '' });
    if (cmeta?.tags) tagLists.push(cmeta.tags);
  }

  if (chapters.length >= 2) {
    const ownerId = chapters[0].id;
    const ownerMeta = await metaGet(ownerId).catch(() => null);
    await mutateGallery(ownerId, {
      chapters,
      seriesTitle: manifest.seriesTitle || '',
      seriesTags: Array.isArray(manifest.seriesTags)
        ? manifest.seriesTags
        : (embeddedSeriesTags || _unionTags(ownerMeta?.tags, ...tagLists)),
      parentId: null,
    });
    for (const c of chapters) if (c.id !== ownerId) await mutateGallery(c.id, { parentId: ownerId });
    await pruneSeriesChildren(ownerId, chapters.map(c => c.id));
    await refreshSeriesAggregate(ownerId);
  } else if (chapters.length === 1) {
    const ownerId = chapters[0].id;
    await mutateGallery(ownerId, { chapters: null, seriesTitle: '', seriesTags: null, parentId: null });
    await pruneSeriesChildren(ownerId, [ownerId]);
    await refreshSeriesAggregate(ownerId);
  }

  platform.kv.set({ libraryVersion: Date.now() });
  onProgress({ status: 'done', done: total, total });
}

// Restore a Shiori per-gallery export (images/ + translated/ + study/ + metadata.json +
// image_records.json) into `gid`. Always a full replace, so the originals, the translated
// variants AND the study-mode layers all come back intact.
async function _importShioriEntries(gid, entries, embeddedMeta, onProgress) {
  const byName = new Map(entries.map(en => [en.filename, en.data]));

  const pageEntries = sortImageEntries(entries.filter(en => /^images\//i.test(en.filename)));
  const pageExts = pageEntries.map(en => normExt(en.filename.match(/\.(\w+)$/)?.[1]));

  await metaPut(embeddedMeta
    ? { ...embeddedMeta, galleryId: gid, pageExts, fetchedAt: Date.now() }
    : { galleryId: gid, title: { english: gid, japanese: '', pretty: gid }, tags: [], numPages: pageEntries.length, pageExts, fetchedAt: Date.now(), isLocalImport: true, source: '' });
  await deleteGalleryImages(gid);

  if (pageEntries.length === 0) {
    await restoreExportedCovers(gid, byName);
    onProgress({ status: 'done', done: 0, total: 0, skipped: 0 });
    platform.kv.set({ libraryVersion: Date.now() });
    publishFeed(gid);
    return;
  }

  onProgress({ status: 'started', done: 0, total: pageEntries.length, skipped: 0 });
  const urlByNum = new Map();
  let done = 0;
  for (const en of pageEntries) {
    const m = en.filename.replace(/^.*\//, '').match(/(\d+)\.(\w+)$/);
    if (!m) continue;
    const num = parseInt(m[1]);
    const ext = normExt(m[2]);
    const url = `local://${gid}/${num}.${ext}`;
    await dbPut(url, new Blob([en.data], { type: MIME[ext] || 'image/jpeg' }), gid, gid);
    urlByNum.set(num, url);
    onProgress({ done: ++done, total: pageEntries.length, skipped: 0, status: 'progress' });
  }

  // Translated variants → rec.translated on the matching page.
  for (const en of entries) {
    const m = en.filename.match(/^translated\/(\d+)\.(\w+)$/i);
    const url = m && urlByNum.get(parseInt(m[1]));
    if (url) await putTranslatedImage(url, new Blob([en.data], { type: MIME[normExt(m[2])] || 'image/png' }));
  }

  // Study layers → rec.studyBg + rec.bubbles, driven by study/bubbles.json. Files may be PNG
  // or WebP, so match by name prefix and read the MIME from the extension.
  const mimeOf = (name) => MIME[normExt(name?.match(/\.(\w+)$/)?.[1])] || 'image/png';
  const bubblesData = byName.get('study/bubbles.json');
  if (bubblesData) {
    let index = {};
    try { index = JSON.parse(new TextDecoder().decode(bubblesData)); } catch {}
    for (const numStr of Object.keys(index)) {
      const url = urlByNum.get(parseInt(numStr));
      let bgName = null;
      for (const k of byName.keys()) { if (k.startsWith(`study/bg/${numStr}.`)) { bgName = k; break; } }
      const bgData = bgName ? byName.get(bgName) : null;
      if (!url || !bgData) continue;
      const bubbles = [];
      for (const ent of (index[numStr] || [])) {
        const td = ent.textFile ? byName.get(`study/text/${ent.textFile}`) : null;
        bubbles.push({ box: ent.box, region: ent.region, tr: ent.tr || '', src: ent.src || '', text: td ? new Blob([td], { type: mimeOf(ent.textFile) }) : null });
      }
      if (bubbles.length) await putPageStudy(url, { bg: new Blob([bgData], { type: mimeOf(bgName) }), bubbles });
    }
  }

  await restoreExportedCovers(gid, byName);
  onProgress({ status: 'done', done, total: pageEntries.length, skipped: 0 });
  platform.kv.set({ libraryVersion: Date.now() });
  publishFeed(gid);
}

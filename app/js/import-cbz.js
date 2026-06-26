// import-cbz.js — CBZ/zip import engine, plus the shared zip primitives (unzip, image-entry
// sorting) the download orchestration reuses. Runs in a page or in the PWA service worker.

import * as platform from './platform.js';
import { dbPut, metaPut, metaGet, galleryGet, deleteGalleryImages, existingPageNums, publishFeed,
         putTranslatedImage, putPageStudy } from './db.js';

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

  const metaEntry = entries.find(en => en.filename === 'metadata.json');
  let embeddedMeta = null;
  if (metaEntry) { try { embeddedMeta = JSON.parse(new TextDecoder().decode(metaEntry.data)); } catch {} }

  // A Shiori per-gallery export (has image_records.json) carries pages under images/ plus
  // translated/ and study/ folders. Restore it losslessly — and never let those parallel
  // folders get imported as extra pages (the plain-CBZ path below only sees a normal archive).
  if (entries.some(en => en.filename === 'image_records.json')) {
    return _importShioriZip(origGid, entries, embeddedMeta, onProgress);
  }

  const nameNoExt = filename.replace(/\.[^.]+$/, '');
  const gid = (skipExisting && embeddedMeta?.galleryId) ? String(embeddedMeta.galleryId) : origGid;
  const imgEntries = sortImageEntries(entries);

  if (imgEntries.length === 0) {
    if (!embeddedMeta) { onProgress({ status: 'error', error: 'No images found in CBZ.' }); return; }
    await metaPut({ ...embeddedMeta, galleryId: gid, fetchedAt: Date.now() });
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

// Restore a Shiori per-gallery export (images/ + translated/ + study/ + metadata.json +
// image_records.json). Always a full replace into the embedded gallery id, so the originals,
// the translated variants AND the study-mode layers all come back intact.
async function _importShioriZip(origGid, entries, embeddedMeta, onProgress) {
  const gid = String(embeddedMeta?.galleryId || origGid);
  const byName = new Map(entries.map(en => [en.filename, en.data]));

  const pageEntries = sortImageEntries(entries.filter(en => /^images\//i.test(en.filename)));
  const pageExts = pageEntries.map(en => normExt(en.filename.match(/\.(\w+)$/)?.[1]));

  await metaPut(embeddedMeta
    ? { ...embeddedMeta, galleryId: gid, pageExts, fetchedAt: Date.now() }
    : { galleryId: gid, title: { english: gid, japanese: '', pretty: gid }, tags: [], numPages: pageEntries.length, pageExts, fetchedAt: Date.now(), isLocalImport: true, source: '' });
  await deleteGalleryImages(gid);

  if (pageEntries.length === 0) {
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

  onProgress({ status: 'done', done, total: pageEntries.length, skipped: 0 });
  platform.kv.set({ libraryVersion: Date.now() });
  publishFeed(gid);
}

// import-cbz.js — CBZ/zip import engine, plus the shared zip primitives (unzip, image-entry
// sorting) the download orchestration reuses. Runs in a page or in the PWA service worker.

import * as platform from './platform.js';
import * as api from './api.js';
import { BUBBLE_EXTRA_FIELDS } from './gallery-files.js';
import { isValidGalleryId } from './sanitize.js';
import { unionTags } from './series-plan.js';

// An embedded id that fails the app's numeric-id gate is ignored (remapped to the caller's
// gallery) — imported ids reach DOM attributes and hrefs, so markup in one is an XSS attempt.
const _validEmbeddedId = (id) => (id != null && isValidGalleryId(id) ? String(id) : null);

// Typed import failure. Thrown (never swallowed) so the job runner publishes a real error —
// an invalid archive must never look like success — and retains the staged input for a retry.
export class CbzImportError extends Error {
  constructor(code, message) { super(message); this.name = 'CbzImportError'; this.code = code; }
}

// Archive guards: generous bounds no real archive reaches, cheap insurance against a corrupt
// central directory or a zip bomb expanding into memory.
const MAX_ZIP_ENTRIES = 20000;
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;   // 4 GiB decompressed

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Parse a zip via its central directory (store + deflate entries) -> [{ filename, data }].
export async function unzip(buffer) {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i--) { if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd === -1) throw new CbzImportError('cbz_parse', 'Not a valid ZIP file');
  const count = view.getUint16(eocd + 10, true);
  if (count > MAX_ZIP_ENTRIES) throw new CbzImportError('cbz_limits', `Archive has too many entries (${count}).`);
  let pos = view.getUint32(eocd + 16, true);
  const out = [];
  let expanded = 0;
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
    expanded += data.length;
    if (expanded > MAX_EXPANDED_BYTES) throw new CbzImportError('cbz_limits', 'Archive expands beyond the supported size.');
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
        if (new RegExp(`^covers/${role}\\.(jpe?g|png|webp|gif|avif)$`, 'i').test(name)) {
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
    await api.covers.put(gid, new Blob([data], { type: c.mime || MIME[ext] || 'image/jpeg' }), { role: c.role });
  }
}

export function sortImageEntries(entries) {
  return entries
    .filter(e => /\.(jpe?g|png|webp|gif|avif)$/i.test(e.filename))
    .sort((a, b) => {
      const na = a.filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
      const nb = b.filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
      return na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' });
    });
}

export const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
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
  catch (e) {
    if (e instanceof CbzImportError) throw e;
    throw new CbzImportError('cbz_parse', 'Failed to parse CBZ: ' + (e && e.message || e));
  }

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
    const gid = _validEmbeddedId(embeddedMeta?.galleryId) || origGid;
    return _importShioriEntries(gid, entries, embeddedMeta, onProgress);
  }

  const nameNoExt = filename.replace(/\.[^.]+$/, '');
  const gid = (skipExisting && _validEmbeddedId(embeddedMeta?.galleryId)) || origGid;
  const imgEntries = sortImageEntries(entries);

  if (imgEntries.length === 0) {
    if (!embeddedMeta) throw new CbzImportError('cbz_empty', 'No images found in CBZ.');
    await _putMetadataOnlyGallery(gid, embeddedMeta);
    onProgress({ status: 'done', done: 0, total: 0, skipped: 0 });
    api.events.announce(gid);
    return;
  }

  const pageExts = imgEntries.map(en => normExt(en.filename.match(/\.(\w+)$/)?.[1]));
  // Uploading a Shiori-exported CBZ over an existing gallery is a replace.
  if (skipExisting && embeddedMeta) {
    const gal = await api.galleries.get(gid).catch(() => null);
    if (gal?.count > 0) skipExisting = false;
  }
  if (skipExisting) {
    await api.meta.put(embeddedMeta
      ? { ...embeddedMeta, galleryId: gid, pageExts, fetchedAt: Date.now() }
      : { galleryId: gid, title: { english: nameNoExt, japanese: '', pretty: nameNoExt }, tags: [], numPages: 0, pageExts, fetchedAt: Date.now(), isLocalImport: true, source: '' });
  } else {
    const existing = await api.meta.get(gid).catch(() => null);
    await api.meta.put(existing
      ? { ...existing, isLocalImport: true }
      : { galleryId: gid, title: { english: nameNoExt, japanese: '', pretty: nameNoExt }, tags: [], numPages: 0, pageExts, fetchedAt: Date.now(), isLocalImport: true, source: '' });
    // Replace mode intentionally does NOT delete the old pages here: the new set is written over
    // them in place (a page stored again replaces it without double-counting), and stale leftovers
    // are swept only after every new page is stored — so a crash or quota failure mid-write can
    // never leave fewer pages than the old or the new set.
  }

  // Pages already stored (a resumed/interrupted run) are skipped, never re-put — re-putting
  // would double-count the gallery's stat record.
  const have = skipExisting ? new Set((await api.pages.list(gid)).map(p => p.pageNum)) : new Set();

  onProgress({ status: 'started', done: 0, total: imgEntries.length, skipped: 0 });
  let done = 0, skipped = 0;
  for (let i = 0; i < imgEntries.length; i++) {
    if (have.has(i + 1)) { skipped++; onProgress({ done, total: imgEntries.length, skipped, status: 'progress' }); continue; }
    await api.pages.put(gid, i + 1, new Blob([imgEntries[i].data], { type: MIME[pageExts[i]] || 'image/jpeg' }), { key: `local://${gid}/${i + 1}.${pageExts[i]}` });
    onProgress({ done: ++done, total: imgEntries.length, skipped, status: 'progress' });
  }
  // Only now that the whole new set is stored: drop old pages the new set didn't overwrite
  // (different extensions, remote-source keys, pages past the new count).
  if (!skipExisting) await api.pages.prune(gid, pageExts.map((ext, i) => `local://${gid}/${i + 1}.${ext}`));
  onProgress({ status: 'done', done, total: imgEntries.length, skipped });
  api.events.announce(gid);
}

async function _putMetadataOnlyGallery(gid, meta) {
  const id = String(gid);
  const nextMeta = meta
    ? { ...meta, galleryId: id, fetchedAt: Date.now() }
    : { galleryId: id, title: { english: id, japanese: '', pretty: id }, tags: [], numPages: 0, pageExts: [], fetchedAt: Date.now(), isLocalImport: true, source: '' };
  await api.meta.put(nextMeta);
  // Its stat record (an empty one when it has none), linked to its series like its metadata.
  await api.galleries.create(id, { parentId: nextMeta.parentId ? String(nextMeta.parentId) : null });
}

// Restore a Shiori series export: each chapter-NN/ folder is a self-contained per-gallery export.
// Import every chapter into its own gallery (its embedded id), then wire the grouping onto the
// first chapter (the owner) and back-link every other chapter.
async function _importSeriesZip(entries, manifest, onProgress) {
  const chapters = [];   // { id, title, number?, kind? } in series order, with the imported gids
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
    const gid = _validEmbeddedId(cmeta?.galleryId) || _validEmbeddedId(c.id) || api.newGalleryId();
    const hasFullPayload = sub.some(en =>
      en.filename === 'image_records.json' ||
      /^(images|translated|study|covers)\//i.test(en.filename));
    if (hasFullPayload) {
      await _importShioriEntries(gid, sub, cmeta, (p) => { if (p.status !== 'done') onProgress({ ...p, chapter: i + 1, chapterCount: total }); });
    } else {
      await _putMetadataOnlyGallery(gid, cmeta);
      api.events.announce(gid);
    }
    const number = c.number == null || c.number === '' ? NaN : Number(c.number);
    chapters.push({ id: gid, title: c.title || '', ...(Number.isFinite(number) ? { number } : {}), ...(c.kind === 'volume' ? { kind: 'volume' } : {}) });
    if (cmeta?.tags) tagLists.push(cmeta.tags);
  }

  // The whole series in one step: its chapter list, every chapter linked to it, and any chapter it
  // held before that this import doesn't list deleted.
  if (chapters.length) {
    const ownerId = chapters[0].id;
    const ownerMeta = await api.meta.get(ownerId).catch(() => null);
    await api.series.write(ownerId, chapters, {
      seriesTitle: manifest.seriesTitle || '',
      seriesTags: Array.isArray(manifest.seriesTags)
        ? manifest.seriesTags
        : (embeddedSeriesTags || unionTags(ownerMeta?.tags, ...tagLists)),
    });
  }

  onProgress({ status: 'done', done: total, total });
}

// Pipeline data from image_records.json (plus its pipeline/NNNN-{raw,text}.webp masks): what a later
// translation of the page reuses. Only the shape is checked; the translation server validates
// whatever it is sent and runs a page in full when its data doesn't fit.
async function _restorePipelines(gid, data, urlByNum, byName) {
  let records = null;
  try { records = JSON.parse(new TextDecoder().decode(data)); } catch {}
  if (!Array.isArray(records)) return;
  for (const e of records) {
    const pipeline = e?.pipeline;
    const m = String(e?.url || '').match(/\/(\d+)\.\w+$/);
    const url = m && urlByNum.get(parseInt(m[1]));
    if (!url) continue;
    // A translated page kept as its study layers (restored with the study files).
    const patch = e.translatedLayers === true ? { translatedLayers: true } : {};
    if (pipeline && typeof pipeline === 'object' && typeof pipeline.job === 'string') {
      const num = m[1].padStart(4, '0');
      const masks = {};
      for (const name of ['raw', 'text']) {
        const ext = ['webp', 'png'].find((e) => byName.has(`pipeline/${num}-${name}.${e}`));
        if (ext) masks[name] = new Blob([byName.get(`pipeline/${num}-${name}.${ext}`)], { type: MIME[ext] });
      }
      patch.pipeline = { ...pipeline, masks };
      if (typeof e.own === 'string') patch.own = e.own;   // the translation whose settings it keeps
    }
    if (!Object.keys(patch).length) continue;
    await api.derived.restore(gid, parseInt(m[1]), patch);
  }
}

// Restore a Shiori per-gallery export (images/ + translated/ + study/ + metadata.json +
// image_records.json) into `gid`. Always a full replace, so the originals, the translated
// variants AND the study-mode layers all come back intact.
async function _importShioriEntries(gid, entries, embeddedMeta, onProgress) {
  const byName = new Map(entries.map(en => [en.filename, en.data]));

  const pageEntries = sortImageEntries(entries.filter(en => /^images\//i.test(en.filename)));
  const pageExts = pageEntries.map(en => normExt(en.filename.match(/\.(\w+)$/)?.[1]));

  // Reject ambiguous archives before any write: two files claiming the same page number.
  const seenNums = new Set();
  for (const en of pageEntries) {
    const num = parseInt(en.filename.replace(/^.*\//, '').match(/(\d+)\.(\w+)$/)?.[1]);
    if (!Number.isFinite(num)) continue;
    if (seenNums.has(num)) throw new CbzImportError('cbz_duplicate_pages', `Duplicate page number ${num} in archive.`);
    seenNums.add(num);
  }

  // Grouping references are ids too — drop any that fail the id gate rather than storing them.
  if (embeddedMeta) {
    if (embeddedMeta.parentId != null && !isValidGalleryId(embeddedMeta.parentId)) delete embeddedMeta.parentId;
    if (Array.isArray(embeddedMeta.chapters) && embeddedMeta.chapters.some(c => !isValidGalleryId(c?.id))) delete embeddedMeta.chapters;
  }
  await api.meta.put(embeddedMeta
    ? { ...embeddedMeta, galleryId: gid, pageExts, fetchedAt: Date.now() }
    : { galleryId: gid, title: { english: gid, japanese: '', pretty: gid }, tags: [], numPages: pageEntries.length, pageExts, fetchedAt: Date.now(), isLocalImport: true, source: '' });
  // Full replace, but old pages are only removed after the whole new set is stored (see the
  // stale sweep below) so an interruption cannot destroy a previously valid gallery.

  if (pageEntries.length === 0) {
    await api.pages.prune(gid, []);
    await restoreExportedCovers(gid, byName);
    onProgress({ status: 'done', done: 0, total: 0, skipped: 0 });
    api.events.announce(gid);
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
    await api.pages.put(gid, num, new Blob([en.data], { type: MIME[ext] || 'image/jpeg' }), { key: url });
    urlByNum.set(num, url);
    onProgress({ done: ++done, total: pageEntries.length, skipped: 0, status: 'progress' });
  }

  // The whole new set is stored — now drop the old pages it didn't overwrite in place.
  await api.pages.prune(gid, [...urlByNum.values()]);

  // Translated variants → rec.translated on the matching page.
  for (const en of entries) {
    const m = en.filename.match(/^translated\/(\d+)\.(\w+)$/i);
    const url = m && urlByNum.get(parseInt(m[1]));
    if (url) await api.derived.putTranslatedImage(gid, parseInt(m[1]), new Blob([en.data], { type: MIME[normExt(m[2])] || 'image/png' }));
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
      if (!url) continue;
      // Older bundles store a bare entry array; newer ones wrap it with the page dimensions.
      const raw = index[numStr] || [];
      const ents = Array.isArray(raw) ? raw : (Array.isArray(raw.bubbles) ? raw.bubbles : []);
      const page = Array.isArray(raw) ? null : (raw.page || null);
      const bubbles = [];
      for (const ent of ents) {
        if (!ent || !ent.box) continue;
        const td = ent.textFile ? byName.get(`study/text/${ent.textFile}`) : null;
        const bubble = { box: ent.box, region: ent.region || ent.box, tr: ent.tr || '', src: ent.src || '', text: td ? new Blob([td], { type: mimeOf(ent.textFile) }) : null };
        for (const key of BUBBLE_EXTRA_FIELDS) {
          if (ent[key] != null) bubble[key] = ent[key];
        }
        bubbles.push(bubble);
      }
      if (bubbles.length) await api.derived.putStudy(gid, parseInt(numStr), { bg: bgData ? new Blob([bgData], { type: mimeOf(bgName) }) : null, bubbles, page });
    }
  }

  const recordsData = byName.get('image_records.json');
  if (recordsData) await _restorePipelines(gid, recordsData, urlByNum, byName);

  await restoreExportedCovers(gid, byName);
  onProgress({ status: 'done', done, total: pageEntries.length, skipped: 0 });
  api.events.announce(gid);
}

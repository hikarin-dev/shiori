// gallery-files.js — the files one gallery's export archive holds, listed without reading any image
// bytes, so the same list builds the archive (library.js) and gives the gallery's size in the
// library (db.js): the store-only zip's exact byte count, split into the original pages and the
// rest (translations, study data, snapshots, covers and metadata).
//
// Layout: metadata.json, image_records.json, covers/, images/, pipeline/, translated/,
// study/{bg,text,bubbles.json} — the shape the importer restores losslessly.

import { migrateTitle } from './titles.js';

// Study bubble fields beyond box/region/src/tr/text that round-trip through backups and exports.
export const BUBBLE_EXTRA_FIELDS = ['rbox', 'style', 'tbox', 'furi', 'id', 'lineIds', 'rawTr', 'shape'];

// The per-page JSON files hold one page per line: compact, yet easy to scan.
export const perPageJson = (value) => (Array.isArray(value)
  ? `[\n${value.map((v) => JSON.stringify(v)).join(',\n')}\n]`
  : `{\n${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`);

// Page records as the library returns them carry their page number; an archive names a page's
// files by it (images/0007.webp), keeping the extension its key was stored with.
const _pageNum = (rec) => rec.pageNum ?? 9999;
const _fileNum = (rec) => (rec.pageNum != null ? String(rec.pageNum).padStart(4, '0') : null);
const _keyExt = (rec) => String(rec.url).match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg';
// An image is a Blob, or a stored image's reference ({ size, type } — db.js), or a legacy base64
// data URL.
const _blobLike = (src) => src instanceof Blob || (src != null && typeof src === 'object' && typeof src.size === 'number' && typeof src.type === 'string');
const _imgExt = (src) => (_blobLike(src) ? src.type?.split('/')[1] : (typeof src === 'string' ? src.match(/^data:image\/(\w+)/)?.[1] : null)) || 'png';
const _hasBytes = (src) => _blobLike(src) || src instanceof Uint8Array || (typeof src === 'string' && !!src.split(',')[1]);

// The byte length of a file's source, without reading it.
export function sourceBytes(src) {
  if (_blobLike(src)) return src.size;
  if (src instanceof Uint8Array) return src.length;
  const b64 = typeof src === 'string' ? src.split(',')[1] : null;
  if (!b64) return 0;
  return Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
}

// A file's bytes, read for the archive.
export async function fileBytes(src) {
  if (src instanceof Uint8Array) return src;
  if (src instanceof Blob) return new Uint8Array(await src.arrayBuffer());
  const bin = atob(String(src).split(',')[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// A series bundle's series.json for the owner's `meta`: the members in order, each with its id,
// title, number, kind (a volume says so) and chapter-NN folder, plus the series title and tags. The importer rebuilds the
// series from it.
export function seriesManifest(meta, { metadataOnly = false } = {}) {
  return {
    format: 'shiori-series',
    version: 1,
    ...(metadataOnly ? { metadataOnly: true } : {}),
    seriesTitle: meta.seriesTitle || '',
    seriesTags: Array.isArray(meta.seriesTags) ? meta.seriesTags : (meta.tags || []),
    chapters: meta.chapters.map((c, i) => ({
      id: String(c.id),
      title: c.title || '',
      ...(c.number != null ? { number: c.number } : {}),
      ...(c.kind === 'volume' ? { kind: 'volume' } : {}),
      folder: `chapter-${String(i + 1).padStart(2, '0')}`,
    })),
  };
}

// [{ name, source, original? }] for the gallery's stored `meta`, image `records` and `covers`
// ({ gallery, series }), every name under `prefix` ("chapter-01/" in a series bundle).
export function galleryFiles({ meta, records, covers = {} }, prefix = '', { stripSeriesFields = false } = {}) {
  const enc = new TextEncoder();
  let m = migrateTitle(meta);
  if (stripSeriesFields) {
    const { chapters, parentId, seriesTitle, seriesTags, ...plainMeta } = m || {};
    m = plainMeta;
  }
  const pages = [...(records || [])].sort((a, b) => _pageNum(a) - _pageNum(b));
  const files = [];
  const text = (name, value) => files.push({ name: prefix + name, source: enc.encode(value) });

  text('metadata.json', JSON.stringify(m, null, 2));
  text('image_records.json', perPageJson(pages.map(r => {
    const entry = {
      url: r.url,
      mediaId: r.mediaId,
      galleryId: r.galleryId,
      cachedAt: r.cachedAt,
      cachedAtISO: r.cachedAt ? new Date(r.cachedAt).toISOString() : null,
      size: r.size,
      translated: r.translated !== undefined,
      hasStudy: !!(Array.isArray(r.bubbles) && r.bubbles.length),
      bubbleCount: Array.isArray(r.bubbles) ? r.bubbles.length : 0,
    };
    // The page's pipeline data, so the imported page can be re-translated from where it left
    // off; its masks travel as pipeline/NNNN-raw.webp and -text.webp.
    if (r.pipeline) {
      const { masks, ...data } = r.pipeline;
      entry.pipeline = data;
    }
    if (r.own) entry.own = r.own;   // the translation whose settings the page keeps
    if (r.translatedLayers) entry.translatedLayers = true;   // the translated page is its study layers
    return entry;
  })));

  const coverEntries = [];
  for (const [role, src] of [['gallery', covers.gallery], ['series', covers.series]]) {
    if (!_hasBytes(src)) continue;
    const file = `covers/${role}.${_imgExt(src).toLowerCase().replace(/^jpeg$/, 'jpg')}`;
    files.push({ name: prefix + file, source: src });
    coverEntries.push({
      role,
      file,
      mime: _blobLike(src) ? (src.type || '') : (String(src).match(/^data:([^;,]+)/)?.[1] || ''),
      size: sourceBytes(src),
    });
  }
  if (coverEntries.length) text('covers/manifest.json', JSON.stringify({ version: 1, covers: coverEntries }, null, 2));

  for (const rec of pages) {
    const num = _fileNum(rec);
    const src = rec.blob ?? rec.dataUrl;
    if (!num || !_hasBytes(src)) continue;
    files.push({ name: `${prefix}images/${num}.${_keyExt(rec)}`, source: src, original: true });
  }

  for (const rec of pages) {
    const num = _fileNum(rec);
    if (!num || !rec.pipeline?.masks) continue;
    for (const name of ['raw', 'text']) {
      const mask = rec.pipeline.masks[name];
      if (_hasBytes(mask)) files.push({ name: `${prefix}pipeline/${num}-${name}.${_imgExt(mask)}`, source: mask });
    }
  }

  // Translated variants in a parallel folder (only pages that have one).
  for (const rec of pages) {
    const num = _fileNum(rec);
    if (!num || !rec.translated || !_hasBytes(rec.translated)) continue;
    const ext = (typeof rec.translated === 'string' ? rec.translated.match(/^data:image\/(\w+)/)?.[1] : rec.translated.type?.split('/')[1]) || 'png';
    files.push({ name: `${prefix}translated/${num}.${ext.toLowerCase()}`, source: rec.translated });
  }

  // Study-mode layers: the shared inpaint bg (study/bg) + each bubble's transparent text layer
  // (study/text), and bubbles.json mapping page → boxes/regions/text-file. Mirrors the DB shape
  // so the import can restore it losslessly.
  const studyIndex = {};
  for (const rec of pages) {
    const n = _fileNum(rec);
    if (!n || !Array.isArray(rec.bubbles) || !rec.bubbles.length) continue;
    if (rec.studyBg && _hasBytes(rec.studyBg)) files.push({ name: `${prefix}study/bg/${n}.${_imgExt(rec.studyBg)}`, source: rec.studyBg });
    const entries = rec.bubbles.map((b, k) => {
      const textFile = `${n}-${k}.${_imgExt(b.text)}`;
      const has = _hasBytes(b.text);
      if (has) files.push({ name: `${prefix}study/text/${textFile}`, source: b.text });
      const entry = { box: b.box, region: b.region, tr: b.tr || '', src: b.src || '', textFile: has ? textFile : null };
      // DOM-text layout metadata rides along verbatim (style hints, line breaks, furigana, region ids).
      for (const key of BUBBLE_EXTRA_FIELDS) {
        if (b[key] != null) entry[key] = b[key];
      }
      return entry;
    });
    // Newer bundles wrap the entries with the page's source dimensions; import accepts both.
    studyIndex[n] = rec.studyPage ? { page: rec.studyPage, bubbles: entries } : entries;
  }
  if (Object.keys(studyIndex).length) text('study/bubbles.json', perPageJson(studyIndex));
  return files;
}

// The archive's exact size (zip.js stores files uncompressed: each adds a 30-byte local header
// and a 46-byte directory entry, each carrying its name, and a 22-byte record ends the archive),
// and how much of it is the original pages.
export function exportSize(files) {
  const enc = new TextEncoder();
  let total = 22, original = 0;
  for (const f of files) {
    const bytes = sourceBytes(f.source);
    total += 76 + 2 * enc.encode(f.name).length + bytes;
    if (f.original) original += bytes;
  }
  return { total, original };
}

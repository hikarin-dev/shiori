// gallery-files.js — the Shiori gallery format: one gallery (or series) laid out as files. The same
// layout is an export (a ZIP or CBZ of it), what an import reads (such an archive, or the folder
// dropped as it is) and, in the desktop app, each gallery's folder in the library. The files are
// listed without reading any image bytes, so the same list builds an export (library.js), gives a
// gallery's size in the library (db.js — the store-only zip's exact byte count, split into the
// original pages and the rest) and tells the desktop app what a gallery's folder holds.
//
// One gallery: metadata.json, image_records.json, images/0001.<ext> (the original pages),
// translated/0001.<ext>, study/bubbles.json, study/bg/0001.<ext>, study/text/0001-<bubble>.<ext>,
// pipeline/0001-{raw,text}.<ext>, and — only for a cover that is a picture of its own — covers/
// with its manifest.json. A cover that is the first page is implied, never a copy.
// A series: series.json (its members in order, the series' title and tags, each member's folder)
// beside each member's gallery folder, named "<Series> Ch. 001" or "<Series> Vol. 003".
// Folders and archives are named after the gallery's or series' title (layoutPath, galleryName,
// seriesName, memberName). A CBZ export adds ComicInfo.xml (comicInfoXml), and may leave the
// translations out (withoutTranslations).

import { migrateTitle, pickTitle, pickSeriesTitle } from './titles.js';
import { LANG_NAME_TO_CODE } from './gallery-model.js';

// ── Names ──
// A name Windows (and every other system) accepts for a file or folder.
export function safeName(value, fallback) {
  let name = String(value || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim();
  name = name.slice(0, 100).trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `_${name}`;
  return name || fallback;
}

// A chapter or volume number as a name sorts it: 1 → 001, 12.5 → 012.5.
export function padNumber(n) {
  const [whole, part] = String(n).split('.');
  return whole.padStart(3, '0') + (part ? `.${part}` : '');
}

// A gallery's folder (and its export's) name: its title. A series' name: the series' title. A
// series member's folder: "<Series> Ch. 001" or "<Series> Vol. 003", by its entry in the series'
// list (`ref`, at `index`).
export const galleryName = (meta) => safeName(pickTitle(meta || {}, 'en'), `Gallery ${meta?.galleryId ?? ''}`.trim());
export const seriesName = (owner) => safeName(pickSeriesTitle(owner?.seriesTitle, owner || {}, 'en'), `Series ${owner?.galleryId ?? ''}`.trim());
export const memberName = (owner, ref, index) =>
  `${seriesName(owner)} ${ref?.kind === 'volume' ? 'Vol.' : 'Ch.'} ${padNumber(ref?.number ?? index + 1)}`;

// A picture's extension, from its type (null for a type that isn't a picture's).
const EXT_OF_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
export const extOfType = (type) => EXT_OF_TYPE[String(type || '').toLowerCase()] || null;
// An original page's extension: its type's, else its key's, else jpg.
export const originalExt = (type, key) => extOfType(type)
  || String(key ?? '').match(/\.(\w+)$/)?.[1]?.toLowerCase().replace(/^jpeg$/, 'jpg') || 'jpg';

// Where each picture of page `n` lives in its gallery's folder.
const _num = (n) => String(n).padStart(4, '0');
export const layoutPath = {
  original: (n, ext) => `images/${_num(n)}.${ext}`,
  translated: (n, ext) => `translated/${_num(n)}.${ext}`,
  studyBg: (n, ext) => `study/bg/${_num(n)}.${ext}`,
  studyText: (n, bubble, ext) => `study/text/${_num(n)}-${bubble}.${ext}`,
  mask: (n, name, ext) => `pipeline/${_num(n)}-${name}.${ext}`,
  cover: (role, ext) => `covers/${role}.${ext}`,
};

// Study bubble fields beyond box/region/src/tr/text that round-trip through backups and exports.
export const BUBBLE_EXTRA_FIELDS = ['rbox', 'style', 'tbox', 'furi', 'id', 'lineIds', 'rawTr', 'shape'];

// The per-page JSON files hold one page per line: compact, yet easy to scan.
export const perPageJson = (value) => (Array.isArray(value)
  ? `[\n${value.map((v) => JSON.stringify(v)).join(',\n')}\n]`
  : `{\n${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`);

// Page records as the library returns them carry their page number; a gallery's folder names a
// page's pictures by it (images/0007.webp).
const _pageNum = (rec) => rec.pageNum ?? 9999;
// An image is a Blob, or a stored image's reference ({ size, type } — db.js, the desktop library),
// or a legacy base64 data URL.
const _blobLike = (src) => src instanceof Blob || (src != null && typeof src === 'object' && typeof src.size === 'number' && typeof src.type === 'string');
const _typeOf = (src) => (_blobLike(src) ? src.type : (typeof src === 'string' ? src.match(/^data:([^;,]+)/)?.[1] : null));
const _imgExt = (src) => extOfType(_typeOf(src)) || 'png';
const _hasBytes = (src) => _blobLike(src) || src instanceof Uint8Array || (typeof src === 'string' && !!src.split(',')[1]);
// A stored cover that is one of the gallery's pages (db.js's `<key>|page` blob, the desktop
// library's `$page`): implied by the folder, never written as a file.
const _isPageCover = (src) => typeof src?.$page === 'number' || (typeof src?.$blob === 'string' && src.$blob.endsWith('|page'));

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

// A series' series.json for the owner's `meta`: the members in order, each with its id, title,
// number, kind (a volume says so) and folder, plus the series title and tags. The importer rebuilds
// the series from it. `folders`: the members' folders where they already have one (the desktop
// library's), else each is named by memberName — no two alike.
export function seriesManifest(meta, { metadataOnly = false, folders = [] } = {}) {
  const taken = new Set();
  const unique = (name) => {
    let out = name;
    for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${name} (${i})`;
    taken.add(out.toLowerCase());
    return out;
  };
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
      folder: unique(folders[i] || memberName(meta, c, i)),
    })),
  };
}

// [{ name, source, original? }] for the gallery's stored `meta`, image `records` and `covers`
// ({ gallery, series } — a cover that is one of its pages, or none, is left out), every name under
// `prefix` (the member's folder in a series).
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
    if (!_hasBytes(src) || _isPageCover(src)) continue;
    const file = layoutPath.cover(role, _imgExt(src));
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
    const src = rec.blob ?? rec.dataUrl;
    if (rec.pageNum == null || !_hasBytes(src)) continue;
    files.push({ name: prefix + layoutPath.original(rec.pageNum, originalExt(_typeOf(src), rec.url)), source: src, original: true });
  }

  for (const rec of pages) {
    if (rec.pageNum == null || !rec.pipeline?.masks) continue;
    for (const name of ['raw', 'text']) {
      const mask = rec.pipeline.masks[name];
      if (_hasBytes(mask)) files.push({ name: prefix + layoutPath.mask(rec.pageNum, name, _imgExt(mask)), source: mask });
    }
  }

  // Translated variants in a parallel folder (only pages that have one).
  for (const rec of pages) {
    if (rec.pageNum == null || !rec.translated || !_hasBytes(rec.translated)) continue;
    files.push({ name: prefix + layoutPath.translated(rec.pageNum, _imgExt(rec.translated)), source: rec.translated });
  }

  // Study-mode layers: the shared inpaint bg (study/bg) + each bubble's transparent text layer
  // (study/text), and bubbles.json mapping page → boxes/regions/text-file. Mirrors the DB shape
  // so the import can restore it losslessly.
  const studyIndex = {};
  for (const rec of pages) {
    if (rec.pageNum == null || !Array.isArray(rec.bubbles) || !rec.bubbles.length) continue;
    const n = _num(rec.pageNum);
    if (rec.studyBg && _hasBytes(rec.studyBg)) files.push({ name: prefix + layoutPath.studyBg(rec.pageNum, _imgExt(rec.studyBg)), source: rec.studyBg });
    const entries = rec.bubbles.map((b, k) => {
      const path = layoutPath.studyText(rec.pageNum, k, _imgExt(b.text));
      const textFile = path.slice('study/text/'.length);
      const has = _hasBytes(b.text);
      if (has) files.push({ name: prefix + path, source: b.text });
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

// Page records without what was made from the pages — translations, study layers, pipeline data
// and masks — for an export that holds the original pages only.
const TRANSLATION_FIELDS = ['translated', 'translatedLayers', 'bubbles', 'studyBg', 'studyPage', 'pipeline', 'own'];
export function withoutTranslations(records) {
  return (records || []).map((rec) => {
    const out = { ...rec };
    for (const key of TRANSLATION_FIELDS) delete out[key];
    return out;
  });
}

// Ratings (series-plan.js RATINGS) as ComicInfo's age ratings.
const AGE_RATING = { safe: 'Everyone', suggestive: 'Teen', erotica: 'Mature 17+', pornographic: 'Adults Only 18+' };
const _xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ComicInfo.xml for a CBZ export: the details other comic readers show. `meta` is the exported
// gallery's; `owner` the series it belongs to (its member entry gives the number and title);
// `series` when the export is a whole series (meta is then the series owner's); `pageCount` the
// original pages the archive holds.
export function comicInfoXml(meta, { owner = null, series = false, pageCount } = {}) {
  const m = meta || {};
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const named = (type) => tags.filter(t => t.type === type).map(t => t.name);
  const ref = !series && owner ? owner.chapters?.find(c => String(c.id) === String(m.galleryId)) : null;
  const seriesTitle = series ? pickSeriesTitle(m.seriesTitle, m, 'en') : owner ? pickSeriesTitle(owner.seriesTitle, owner, 'en') : null;
  const fields = [
    ['Title', series ? seriesTitle : (ref?.title || pickTitle(m, 'en'))],
    ['Series', seriesTitle || pickTitle(m, 'en')],
    [ref?.kind === 'volume' ? 'Volume' : 'Number', ref?.number],
    ['Count', series && Array.isArray(m.chapters) ? m.chapters.length : null],
    ['Writer', named('artist').join(', ')],
    ['Genre', named('category').join(', ')],
    ['Tags', named('tag').join(', ')],
    ['Characters', named('character').join(', ')],
    ['Web', m.sourceUrl],
    ['LanguageISO', m.translatedLang || LANG_NAME_TO_CODE[String(named('language').find(l => l !== 'translated') || '').toLowerCase()]],
    ['PageCount', pageCount],
    ['AgeRating', AGE_RATING[String(named('rating')[0] || '').toLowerCase()]],
  ].filter(([, v]) => v != null && v !== '');
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n${
    fields.map(([k, v]) => `  <${k}>${_xml(v)}</${k}>`).join('\n')}\n</ComicInfo>\n`;
}

// Two pictures with the same bytes.
async function _same(a, b) {
  if (!(a instanceof Blob) || !(b instanceof Blob) || a.size !== b.size) return false;
  const [x, y] = (await Promise.all([a.arrayBuffer(), b.arrayBuffer()])).map(buf => new Uint8Array(buf));
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// One gallery's files, read for an archive, from its transfer record (api.transfer.read), every
// name under `prefix`. A cover that is the gallery's first page is left out: it is implied.
async function _galleryExport({ meta, pages, cover }, prefix, { translations, stripSeriesFields }) {
  const records = translations ? pages : withoutTranslations(pages);
  const first = [...(pages || [])].sort((a, b) => _pageNum(a) - _pageNum(b))[0]?.blob ?? null;
  const own = async (src) => (src && !(await _same(src, first)) ? src : null);
  const listed = galleryFiles({ meta, records, covers: { gallery: await own(cover?.cover), series: await own(cover?.seriesCover) } },
    prefix, { stripSeriesFields });
  const out = [];
  for (const f of listed) out.push({ name: f.name, data: await fileBytes(f.source), original: !!f.original });
  return out;
}

// What exporting gallery `gid` writes — a series owner exports its whole series: { name, files }
// in the Shiori gallery format, `name` the archive's (without its extension), each file { name,
// data, original }. `read(gid)` and `metaGet(gid)` read the library (api.transfer.read,
// api.meta.get). `translations: false` leaves out what was made from the pages; `comicInfo` adds
// ComicInfo.xml (a CBZ).
export async function exportFiles(gid, { read, metaGet, translations = true, comicInfo = false }) {
  const enc = new TextEncoder();
  const meta = await metaGet(String(gid));
  const pageCount = (files) => files.filter(f => f.original).length;
  const chapters = Array.isArray(meta?.chapters) && meta.chapters.length > 1 ? meta.chapters : null;
  if (!chapters) {
    const files = await _galleryExport(await read(String(gid)), '', { translations });
    if (comicInfo) {
      const owner = meta?.parentId ? await metaGet(String(meta.parentId)) : null;
      files.push({ name: 'ComicInfo.xml', data: enc.encode(comicInfoXml(meta, { owner, pageCount: pageCount(files) })) });
    }
    return { name: galleryName(meta || { galleryId: gid }), files };
  }
  const manifest = seriesManifest(meta);
  const files = [];
  for (const { id, folder } of manifest.chapters) {
    files.push(...await _galleryExport(await read(id), `${folder}/`, { translations, stripSeriesFields: true }));
  }
  files.push({ name: 'series.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });
  if (comicInfo) files.push({ name: 'ComicInfo.xml', data: enc.encode(comicInfoXml(meta, { series: true, pageCount: pageCount(files) })) });
  return { name: seriesName(meta), files };
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

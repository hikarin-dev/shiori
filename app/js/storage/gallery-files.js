// gallery-files.js — the Shiori gallery format: one gallery (or series) laid out as files. The same
// layout is an export (a ZIP or CBZ of it: gallery-export.js), what an import reads (such an archive,
// or the folder dropped as it is) and each gallery's folder in a library folder, on both apps. The
// files are listed without reading any image bytes, so the same list builds an export, gives a
// gallery's size in the library (gallery-export.js exportSize — the store-only zip's exact byte
// count, split into the original pages and the rest) and writes a gallery's descriptions into its
// folder.
//
// One gallery: metadata.json, image_records.json, images/0001.<ext> (the original pages),
// translated/0001.<ext>, study/bubbles.json, study/bg/0001.<ext>, study/text/0001-<bubble>.<ext>,
// pipeline/0001-{raw,text}.<ext>, and — only for a cover that is a picture of its own — covers/
// with its manifest.json. A cover that is the first page is implied, never a copy.
// A series: series.json (its members in order, the series' title and tags, each member's folder)
// beside each member's gallery folder, named "<Series> Ch. 001" or "<Series> Vol. 003".
// Folders and archives are named after the gallery's or series' title (layoutPath, galleryName,
// seriesName, memberName).

import { migrateTitle, pickTitle, pickSeriesTitle } from '../titles.js';

/** @typedef {import('../titles.js').Meta} Meta */
/** A picture as the library hands it over: a Blob, a stored picture's reference (StoredRef), bytes,
 * or a legacy base64 data URL.
 * @typedef {Blob | StoredRef | Uint8Array | string} Picture */
/** A stored picture's reference: its size and type, and where the library keeps it (db.js `$blob`,
 * the desktop library's `$page` and `$own`, a browser library folder's `$path`).
 * @typedef {{ size: number, type: string, [field: string]: unknown }} StoredRef */
/** A study bubble as a page record holds it: its boxes, text and text layer, plus BUBBLE_EXTRA_FIELDS.
 * @typedef {{ box?: unknown, region?: unknown, tr?: string, src?: string, text?: Picture | null,
 *   [field: string]: unknown }} Bubble */
/** A page record as the library returns it: its page number (never stored), its pictures and what was
 * made from it.
 * @typedef {{
 *   pageNum?: number | null, url?: string, mediaId?: unknown, galleryId?: string | number, cachedAt?: number, size?: number,
 *   blob?: Picture | null, dataUrl?: string, translated?: Picture | null, translatedLayers?: boolean,
 *   bubbles?: Bubble[] | null, studyBg?: Picture | null, studyPage?: unknown, own?: string,
 *   pipeline?: { [field: string]: unknown, masks?: { raw?: Picture | null, text?: Picture | null } } | null,
 * }} PageRecord */
/** A file of a gallery laid out (galleryFiles): its name, what its bytes come from, and whether it
 * is an original page.
 * @typedef {{ name: string, source: Picture, original?: boolean }} LaidOutFile */

// ── Names ──
// A name Windows (and every other system) accepts for a file or folder.
/** @param {unknown} value @param {string} fallback @returns {string} */
export function safeName(value, fallback) {
  let name = String(value || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim();
  name = name.slice(0, 100).trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `_${name}`;
  return name || fallback;
}

// A chapter or volume number as a name sorts it: 1 → 001, 12.5 → 012.5.
/** @param {number | string} n @returns {string} */
export function padNumber(n) {
  const [whole, part] = String(n).split('.');
  return whole.padStart(3, '0') + (part ? `.${part}` : '');
}

// A gallery's folder (and its export's) name: its title. A series' name: the series' title. A
// series member's folder: "<Series> Ch. 001" or "<Series> Vol. 003", by its entry in the series'
// list (`ref`, at `index`).
/** @param {Meta | null | undefined} meta @returns {string} */
export const galleryName = (meta) => safeName(pickTitle(meta || {}, 'en'), `Gallery ${meta?.galleryId ?? ''}`.trim());
/** @param {Meta | null | undefined} owner @returns {string} */
export const seriesName = (owner) => safeName(pickSeriesTitle(owner?.seriesTitle, owner || {}, 'en'), `Series ${owner?.galleryId ?? ''}`.trim());
/** @param {Meta | null | undefined} owner @param {{ kind?: string, number?: number | string } | null | undefined} ref @param {number} index @returns {string} */
export const memberName = (owner, ref, index) =>
  `${seriesName(owner)} ${ref?.kind === 'volume' ? 'Vol.' : 'Ch.'} ${padNumber(ref?.number ?? index + 1)}`;

// A picture's extension, from its type (null for a type that isn't a picture's).
/** @type {Record<string, string>} */
const EXT_OF_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
/** @param {string | null | undefined} type @returns {string | null} */
export const extOfType = (type) => EXT_OF_TYPE[String(type || '').toLowerCase()] || null;
// An original page's extension: its type's, else its key's, else jpg.
/** @param {string | null | undefined} type @param {string | null | undefined} key @returns {string} */
export const originalExt = (type, key) => extOfType(type)
  || String(key ?? '').match(/\.(\w+)$/)?.[1]?.toLowerCase().replace(/^jpeg$/, 'jpg') || 'jpg';

// Where each picture of page `n` lives in its gallery's folder.
/** @param {number | string} n */
const _num = (n) => String(n).padStart(4, '0');
/** @typedef {number | string} PageNum */
export const layoutPath = {
  /** @param {PageNum} n @param {string} ext */
  original: (n, ext) => `images/${_num(n)}.${ext}`,
  /** @param {PageNum} n @param {string} ext */
  translated: (n, ext) => `translated/${_num(n)}.${ext}`,
  /** @param {PageNum} n @param {string} ext */
  studyBg: (n, ext) => `study/bg/${_num(n)}.${ext}`,
  /** @param {PageNum} n @param {number | string} bubble @param {string} ext */
  studyText: (n, bubble, ext) => `study/text/${_num(n)}-${bubble}.${ext}`,
  /** @param {PageNum} n @param {string} name @param {string} ext */
  mask: (n, name, ext) => `pipeline/${_num(n)}-${name}.${ext}`,
  /** @param {string} role @param {string} ext */
  cover: (role, ext) => `covers/${role}.${ext}`,
};
// The pipeline masks a page may have, in this order (layoutPath.mask's `name`).
/** @type {('raw' | 'text')[]} */
const MASKS = ['raw', 'text'];

// The page number a page picture's file name carries, as both apps write it: images/0007.webp, or
// 0007-<random part>.webp when another file already had the layout name (a folder named by hand, a
// picture replaced while the old one was still in use). Null for a name that carries none (or 0).
/** @param {string | null | undefined} name @returns {number | null} */
export function pageNumberOf(name) {
  const n = Number(String(name ?? '').match(/(?:^|\/)(\d+)(?:-[0-9a-z]+)?\.[0-9a-z]+$/i)?.[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

// Study bubble fields beyond box/region/src/tr/text that round-trip through backups and exports.
export const BUBBLE_EXTRA_FIELDS = ['rbox', 'style', 'tbox', 'furi', 'id', 'lineIds', 'rawTr', 'shape'];

// The per-page JSON files hold one page per line: compact, yet easy to scan.
/** @param {unknown[] | Record<string, unknown>} value @returns {string} */
export const perPageJson = (value) => (Array.isArray(value)
  ? `[\n${value.map((v) => JSON.stringify(v)).join(',\n')}\n]`
  : `{\n${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`);

// Page records as the library returns them carry their page number; a gallery's folder names a
// page's pictures by it (images/0007.webp).
/** @param {PageRecord} rec */
const _pageNum = (rec) => rec.pageNum ?? 9999;
// An image is a Blob, or a stored image's reference ({ size, type } — db.js, the desktop library),
// or a legacy base64 data URL.
/** @param {unknown} src @returns {src is Blob | StoredRef} */
const _blobLike = (src) => src instanceof Blob || (src != null && typeof src === 'object'
  && typeof /** @type {StoredRef} */ (src).size === 'number' && typeof /** @type {StoredRef} */ (src).type === 'string');
/** @param {unknown} src */
const _typeOf = (src) => (_blobLike(src) ? src.type : (typeof src === 'string' ? src.match(/^data:([^;,]+)/)?.[1] : null));
/** @param {unknown} src */
const _imgExt = (src) => extOfType(_typeOf(src)) || 'png';
/** @param {unknown} src @returns {src is Picture} */
const _hasBytes = (src) => _blobLike(src) || src instanceof Uint8Array || (typeof src === 'string' && !!src.split(',')[1]);
// A stored cover that is one of the gallery's pages (db.js's `<key>|page` blob, the desktop
// library's `$page`, a browser library folder's page file): implied by the folder, never written as
// a file.
/** @param {any} src a cover in any of the libraries' stored forms */
const _isPageCover = (src) => typeof src?.$page === 'number' || (typeof src?.$blob === 'string' && src.$blob.endsWith('|page'))
  || (typeof src?.$path === 'string' && !src.$path.startsWith('covers/'));

// The byte length of a file's source, without reading it.
/** @param {unknown} src @returns {number} */
export function sourceBytes(src) {
  if (_blobLike(src)) return src.size;
  if (src instanceof Uint8Array) return src.length;
  const b64 = typeof src === 'string' ? src.split(',')[1] : null;
  if (!b64) return 0;
  return Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
}

// A series' series.json for the owner's `meta`: the members in order, each with its id, title,
// number, kind (a volume says so) and folder, plus the series title and tags. The importer rebuilds
// the series from it. `folders`: the members' folders where they already have one (the desktop
// library's), else each is named by memberName — no two alike.
/** @param {Meta} meta @param {{ metadataOnly?: boolean, folders?: string[] }} [options] */
export function seriesManifest(meta, { metadataOnly = false, folders = [] } = {}) {
  const taken = new Set();
  /** @param {string} name */
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
    chapters: meta.chapters.map(/** @param {Meta} c @param {number} i */ (c, i) => ({
      id: String(c.id),
      title: c.title || '',
      ...(c.number != null ? { number: c.number } : {}),
      ...(c.kind === 'volume' ? { kind: 'volume' } : {}),
      folder: unique(folders[i] || memberName(meta, c, i)),
    })),
  };
}

// The files a gallery's folder describes it in, beside its pictures.
export const DESCRIPTION_FILES = ['metadata.json', 'image_records.json', 'study/bubbles.json', 'covers/manifest.json'];

// A short stamp of a gallery's descriptions as its folder holds them (`texts`: each of
// DESCRIPTION_FILES' text, null or missing when the folder hasn't it): a 53-bit hash of the raw text.
// How an app tells whether they changed since it last wrote or read them: a stamp that differs means
// other text (even the same description written another way: spacing, key order); an equal one, the
// same text, short of a hash collision.
/** @param {Record<string, string | null | undefined> | null | undefined} texts @returns {string} */
export function descriptionStamp(texts) {
  const s = DESCRIPTION_FILES.map(name => `${name}\u0000${texts?.[name] ?? '\u0001'}`).join('\u0000');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// A gallery's own covers as its covers/manifest.json (parsed) names them: { gallery?, series? }, each
// the file's path in the gallery's folder. Only a picture directly in covers/ counts (galleryFiles
// writes covers/<role>.<ext>, or the file a gallery's folder keeps it in); the first entry of a role
// is taken.
/** @typedef {{ gallery?: string, series?: string }} CoverFiles */
/** @param {any} manifest covers/manifest.json as parsed, of any shape @returns {CoverFiles} */
export function coverRoles(manifest) {
  /** @type {CoverFiles} */
  const out = {};
  for (const c of Array.isArray(manifest?.covers) ? manifest.covers : []) {
    /** @type {unknown} */
    const role = c?.role;
    if ((role !== 'gallery' && role !== 'series') || out[role]) continue;
    if (typeof c.file === 'string' && /^covers\/[^/\\:\u0000]+$/.test(c.file) && !/^covers\/[. ]+$/.test(c.file)) out[role] = c.file;
  }
  return out;
}

// ── A gallery's folder read back ──
// A gallery's folder can hold more than one file for a picture. One written while a file had its
// layout name goes beside it, under that name with a random part (the website's 8 hex digits:
// folder-store-web.js writeNew; the desktop's 10, for a page whose layout name another page has:
// files.js _nameFor), and the old file is deleted only once the change is saved — a delete refused,
// or the app closed in between, leaves both. So a folder's descriptions name each picture's file
// where it isn't the layout name (galleryFiles `fileOf`), and both apps read a picture's file as
// pickFile says.

// A file's layout name: its path without that random part (study/text/0001-0-3fa2c9e1.webp →
// study/text/0001-0.webp).
/** @param {string} path @returns {string} */
export const layoutOf = (path) => String(path).replace(/-[0-9a-f]{8,10}(\.[^./]*)$/, '$1');
// The picture a file of a gallery's folder stands for: its layout name without its extension
// (translated/0001, study/text/0001-0, covers/gallery).
/** @param {string} path */
const _slotOf = (path) => layoutOf(path).replace(/\.[^./]*$/, '');

// Which of the files standing for one picture (`candidates`) holds it: the one the folder's
// descriptions name (`described`, a Set: describedFiles) — so a picture saved under a new name wins over
// the old file left behind, and a file left by a write that was never saved loses —; else the one under
// the layout name; else, in a folder described before descriptions named files, the only one. Null when
// none can be told the current one.
/** @param {Iterable<string>} candidates @param {Set<string> | null} [described] @returns {string | null} */
export function pickFile(candidates, described = null) {
  const sorted = [...candidates].sort();
  return sorted.find(p => described?.has(p)) ?? sorted.find(p => layoutOf(p) === p) ?? (sorted.length === 1 ? sorted[0] : null);
}

// The files a gallery folder's descriptions name for its pictures: each page's `files` in its
// image_records.json and each cover's in its covers/manifest.json (both parsed).
/** @param {any} records image_records.json as parsed @param {any} manifest covers/manifest.json as parsed @returns {Set<string>} */
export function describedFiles(records, manifest) {
  /** @type {Set<string>} */
  const out = new Set(Object.values(coverRoles(manifest)));
  for (const r of Array.isArray(records) ? records : []) {
    for (const f of Array.isArray(r?.files) ? r.files : []) if (typeof f === 'string') out.add(f);
  }
  return out;
}

// A gallery's folder read back picture by picture, the same on both apps: `paths`, the picture files it
// holds (paths in it: images/, translated/, study/, pipeline/, covers/), with its image_records.json and
// covers/manifest.json as parsed. { file(slot): the file holding the picture at `slot` (its layout name
// without extension: translated/0001), or null — pickFile; pages: Map page number → its original's
// file, in page order, each counted by the number its name carries (pageNumberOf), one with none by
// its place among them; covers: { gallery?, series? }, the file of each role its manifest names }.
const _natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** @typedef {{ file(slot: string): string | null, pages: Map<number, string>, covers: CoverFiles }} FolderPictures */
/** @param {Iterable<string>} paths @param {{ records?: any, manifest?: any }} [described] @returns {FolderPictures} */
export function folderPictures(paths, { records = null, manifest = null } = {}) {
  const described = describedFiles(records, manifest);
  /** @type {Map<string, string[]>} */
  const slots = new Map();
  /** @type {Map<number, string[]>} */
  const numbered = new Map();
  /** @template K @param {Map<K, string[]>} map @param {K} key @param {string} path */
  const add = (map, key, path) => { const list = map.get(key); if (list) list.push(path); else map.set(key, [path]); };
  const list = [...paths];
  for (const p of list) add(slots, _slotOf(p), p);
  list.filter(p => /^images\/[^/]+$/.test(p)).sort(_natural.compare).forEach((p, i) => add(numbered, pageNumberOf(p) ?? i + 1, p));
  /** @param {string} slot */
  const file = (slot) => pickFile(slots.get(slot) || [], described);
  /** @type {Map<number, string>} */
  const pages = new Map();
  for (const [n, files] of [...numbered].sort((a, b) => a[0] - b[0])) {
    const p = pickFile(files, described);
    if (p) pages.set(n, p);
  }
  /** @type {CoverFiles} */
  const covers = {};
  for (const [role, named] of /** @type {['gallery' | 'series', string][]} */ (Object.entries(coverRoles(manifest)))) {
    const p = file(_slotOf(named));
    if (p) covers[role] = p;
  }
  return { file, pages, covers };
}

// A page's record fields made from it, as its gallery's folder holds them (`pictures`: folderPictures';
// `bubbles`: its study/bubbles.json, parsed; `entry`: the page's image_records.json entry): its
// translated picture, study layers and pipeline data, each file referred to as `ref(path)` makes it.
// A translation the entry says the page hasn't is never read: such a file was left by a write that
// was never saved, or made from a picture the page no longer shows.
/**
 * @template R
 * @typedef {{ translated?: R, bubbles?: Record<string, unknown>[], studyBg?: R | null, studyPage?: unknown,
 *   pipeline?: Record<string, unknown> & { masks: { raw?: R, text?: R } }, own?: string, translatedLayers?: true }} Derived
 */
/**
 * @template R
 * @param {FolderPictures} pictures @param {any} bubbles study/bubbles.json as parsed @param {PageNum} n
 * @param {any} entry the page's image_records.json entry as parsed @param {(path: string) => R} ref
 * @returns {Derived<R>}
 */
export function derivedRecord(pictures, bubbles, n, entry, ref) {
  /** @type {Derived<R>} */
  const out = {};
  const num = _num(n);
  /** @param {string} slot */
  const at = (slot) => { const p = pictures.file(slot); return p ? ref(p) : null; };
  const translated = entry?.translated === false ? null : at(`translated/${num}`);
  if (translated) out.translated = translated;
  const study = bubbles?.[num];
  const list = Array.isArray(study) ? study : study?.bubbles;
  if (Array.isArray(list) && list.length) {
    out.bubbles = list.filter(b => b?.box).map(/** @param {Record<string, any>} b */ (b) => {
      const { textFile, ...rest } = b;
      return { ...rest, region: b.region || b.box, tr: b.tr || '', src: b.src || '', text: typeof textFile === 'string' ? at(_slotOf(`study/text/${textFile}`)) : null };
    });
    out.studyBg = at(`study/bg/${num}`);
    out.studyPage = Array.isArray(study) ? null : (study.page || null);
  }
  if (entry?.pipeline && typeof entry.pipeline === 'object' && typeof entry.pipeline.job === 'string') {
    /** @type {{ raw?: R, text?: R }} */
    const masks = {};
    for (const name of MASKS) {
      const mask = at(`pipeline/${num}-${name}`);
      if (mask) masks[name] = mask;
    }
    out.pipeline = { ...entry.pipeline, masks };
    if (typeof entry.own === 'string') out.own = entry.own;
  }
  if (entry?.translatedLayers === true && out.bubbles) out.translatedLayers = true;
  return out;
}

// A page record's pictures, each where the gallery format puts it: [{ kind, src, name }], `kind`
// 'original', 'mask' (raw, then text), 'translated' or 'study' (its background, then each bubble's text
// layer — only for a page with bubbles).
/** @typedef {PageRecord & { pageNum: number }} NumberedPage */
/** @param {NumberedPage} rec @returns {{ kind: 'original' | 'mask' | 'translated' | 'study', src: Picture, name: string }[]} */
function _pictures(rec) {
  const n = rec.pageNum;
  /** @type {{ kind: 'original' | 'mask' | 'translated' | 'study', src: Picture, name: string }[]} */
  const out = [];
  /** @param {'original' | 'mask' | 'translated' | 'study'} kind @param {Picture} src @param {string} name */
  const add = (kind, src, name) => out.push({ kind, src, name });
  const original = rec.blob ?? rec.dataUrl;
  if (_hasBytes(original)) add('original', original, layoutPath.original(n, originalExt(_typeOf(original), rec.url)));
  for (const name of MASKS) {
    const mask = rec.pipeline?.masks?.[name];
    if (_hasBytes(mask)) add('mask', mask, layoutPath.mask(n, name, _imgExt(mask)));
  }
  if (rec.translated && _hasBytes(rec.translated)) add('translated', rec.translated, layoutPath.translated(n, _imgExt(rec.translated)));
  if (Array.isArray(rec.bubbles) && rec.bubbles.length) {
    if (rec.studyBg && _hasBytes(rec.studyBg)) add('study', rec.studyBg, layoutPath.studyBg(n, _imgExt(rec.studyBg)));
    rec.bubbles.forEach((b, k) => { if (_hasBytes(b.text)) add('study', b.text, layoutPath.studyText(n, k, _imgExt(b.text))); });
  }
  return out;
}

// [{ name, source, original? }] for the gallery's stored `meta`, image `records` and `covers`
// ({ gallery, series } — a cover that is one of its pages, or none, is left out), every name under
// `prefix` (the member's folder in a series). For the descriptions of a gallery's copy in a library
// folder (never an export, whose names are the layout's): `fileOf(src)`, the file the folder keeps a
// picture in (null: none of its own), so each page's image_records.json entry lists its pictures' files
// that aren't the layout name (`files`) and covers/manifest.json names each cover's; `sourceOf(rec)`,
// for a linked gallery, the source picture a page shows ({ name, size, crc? | mtime? } — linked-source.js
// provenanceOf, keepsDerived), kept as its entry's `source`.
/**
 * @param {{ meta: Meta | null | undefined, records: PageRecord[] | null | undefined, covers?: { gallery?: unknown, series?: unknown } }} gallery
 * @param {string} [prefix]
 * @param {{ stripSeriesFields?: boolean, fileOf?: ((src: Picture) => string | null | undefined) | null,
 *   sourceOf?: ((rec: PageRecord) => { name: string, size: number, crc?: string, mtime?: number } | null | undefined) | null }} [options]
 * @returns {LaidOutFile[]}
 */
export function galleryFiles({ meta, records, covers = {} }, prefix = '', { stripSeriesFields = false, fileOf = null, sourceOf = null } = {}) {
  const enc = new TextEncoder();
  let m = migrateTitle(meta);
  if (stripSeriesFields) {
    const { chapters, parentId, seriesTitle, seriesTags, ...plainMeta } = m || {};
    m = plainMeta;
  }
  const pages = [...(records || [])].sort((a, b) => _pageNum(a) - _pageNum(b));
  /** @type {Map<PageRecord, ReturnType<typeof _pictures>>} */
  const pictures = new Map();
  for (const r of pages) if (r.pageNum != null) pictures.set(r, _pictures(/** @type {NumberedPage} */ (r)));
  /** @type {LaidOutFile[]} */
  const files = [];
  /** @param {string} name @param {string} value */
  const text = (name, value) => files.push({ name: prefix + name, source: enc.encode(value) });

  text('metadata.json', JSON.stringify(m, null, 2));
  text('image_records.json', perPageJson(pages.map(r => {
    /** @type {Record<string, unknown>} */
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
    if (fileOf) {
      const moved = (pictures.get(r) || []).map(p => [fileOf(p.src), p.name]).filter(([file, name]) => file && file !== name).map(([file]) => /** @type {string} */ (file));
      if (moved.length) entry.files = moved;
    }
    const source = sourceOf?.(r);
    if (source) entry.source = { name: source.name, size: source.size, ...(source.crc != null ? { crc: source.crc } : {}), ...(source.mtime != null ? { mtime: source.mtime } : {}) };
    return entry;
  })));

  const coverEntries = [];
  for (const [role, src] of /** @type {['gallery' | 'series', unknown][]} */ ([['gallery', covers.gallery], ['series', covers.series]])) {
    if (!_hasBytes(src) || _isPageCover(src)) continue;
    const file = layoutPath.cover(role, _imgExt(src));
    files.push({ name: prefix + file, source: src });
    coverEntries.push({
      role,
      file: fileOf?.(src) || file,
      mime: _blobLike(src) ? (src.type || '') : (String(src).match(/^data:([^;,]+)/)?.[1] || ''),
      size: sourceBytes(src),
    });
  }
  if (coverEntries.length) text('covers/manifest.json', JSON.stringify({ version: 1, covers: coverEntries }, null, 2));

  // The pages' pictures: the originals, the pipeline masks, the translated variants in a parallel
  // folder, then the study layers — each page's shared inpaint background (study/bg) and each bubble's
  // transparent text layer (study/text).
  for (const kind of ['original', 'mask', 'translated', 'study']) {
    for (const rec of pages) {
      for (const p of pictures.get(rec) || []) {
        if (p.kind === kind) files.push({ name: prefix + p.name, source: p.src, ...(kind === 'original' ? { original: true } : {}) });
      }
    }
  }

  // bubbles.json mapping page → boxes/regions/text-file. Mirrors the DB shape so the import can
  // restore it losslessly.
  /** @type {Record<string, unknown>} */
  const studyIndex = {};
  for (const rec of pages) {
    const pageNum = rec.pageNum;
    if (pageNum == null || !Array.isArray(rec.bubbles) || !rec.bubbles.length) continue;
    const n = _num(pageNum);
    const entries = rec.bubbles.map((b, k) => {
      const textFile = layoutPath.studyText(pageNum, k, _imgExt(b.text)).slice('study/text/'.length);
      /** @type {Record<string, unknown>} */
      const entry = { box: b.box, region: b.region, tr: b.tr || '', src: b.src || '', textFile: _hasBytes(b.text) ? textFile : null };
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

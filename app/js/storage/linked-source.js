// linked-source.js — galleries a library folder holds that Shiori didn't make: an archive (zip/cbz)
// or a folder of pictures put there some other way, or a PDF. Their files are used as they are — read,
// never written, moved, renamed, unpacked or deleted — and everything Shiori adds to such a gallery
// (its descriptions, translations, study layers, covers, pages it fetches or draws itself) is kept in
// an overlay: a folder in the gallery format of its own, in the library folder's hidden
// .shiori/linked/<gallery id>/, beside a source.json naming the files it belongs to (where they are in
// the library folder, their size, and a fingerprint that tells when they change there). An
// overlay's own page NNNN stands in for the source's page NNNN. Removing such a gallery from the
// library leaves its files, and notes them in .shiori/linked/removed.json so that checking the folder
// doesn't add them again. What counts as Shiori's own, and so not linked, is folder-content.js's to
// say. A path read from these files is used only when it is relative and stays inside the library
// folder (safeRelPath). Pure: the browser library (db.js) and the desktop app's (server/library.js,
// scan.js, linked.js) read and write the files.

import { isValidGalleryId } from '../sanitize.js';
import { pageNumberOf, pickFile } from './gallery-files.js';

export const LINKED_DIR = '.shiori/linked';
export const SOURCE_FILE = 'source.json';
export const REMOVED_FILE = `${LINKED_DIR}/removed.json`;
/** @param {string | number} gid @returns {string} */
export const overlayDir = (gid) => `${LINKED_DIR}/${gid}`;

export const IMAGE_NAME = /\.(jpe?g|png|webp|gif|avif)$/i;
export const ARCHIVE_NAME = /\.(zip|cbz)$/i;
export const PDF_NAME = /\.pdf$/i;
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** @param {string} a @param {string} b @returns {number} */
export const naturalCompare = (a, b) => natural.compare(a, b);

// Whether `p` is a path that stays inside the folder it is read against: relative, '/'-separated,
// every segment a plain name — not empty, not made of dots and spaces only ('.', '..', '...' — which
// Windows may read as '..'), without '\', ':' (a drive, or another file's stream on Windows) or NUL,
// and not a Windows device name (CON, NUL, COM1…). So no absolute, drive (C:/) or UNC (//host) path.
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** @param {unknown} p @returns {p is string} */
export const safeRelPath = (p) => typeof p === 'string' && p !== '' && p.split('/').every(s =>
  s !== '' && !/^[. ]+$/.test(s) && !/[\\:\u0000]/.test(s) && !DEVICE.test(s.split('.')[0].trimEnd()));
// An archive's chapter folder as a source names it ("Name/" or "A/B/"): a safe path, ending in '/'.
/** @param {unknown} inner @returns {boolean} */
const _safeInner = (inner) => typeof inner === 'string' && inner.endsWith('/') && safeRelPath(inner.slice(0, -1));

// A source as source.json keeps it: { kind: 'zip' | 'dir' | 'pdf', path (in the library folder,
// '/'-separated), inner (for an archive whose folders are titles each: the folder in it, "Name/"),
// size, fingerprint (the file's as a check last found it) } — and for a PDF, once its pages are drawn
// into the overlay, `rendered` ({ pages: how many — the overlay holds them all, pdfReady — fingerprint:
// the file's they were drawn from, pdfWaits }; an earlier marker was the bare count, read as drawn from
// a version not known), or, when drawing them failed, `failed` ({ fingerprint (the file's, as it was
// then), at }: not tried again until the file changes, drawFailed).
/** @typedef {'zip' | 'dir' | 'pdf'} SourceKind */
/** @typedef {{ kind: SourceKind, path: string, inner?: string, size?: number | null, fingerprint?: string | null,
 *   rendered?: { pages: number, fingerprint: string | null }, failed?: { fingerprint: string | null, at: number } }} Source */
const KINDS = new Set(['zip', 'dir', 'pdf']);
/** @param {string | number} galleryId @param {Source} source @returns {string} */
export const sourceText = (galleryId, source) => JSON.stringify({ format: 'shiori-linked', version: 1, galleryId: String(galleryId),
  source: { kind: source.kind, path: source.path, ...(source.inner ? { inner: source.inner } : {}), size: source.size ?? null,
    fingerprint: source.fingerprint ?? null,
    ...(source.rendered ? { rendered: { pages: source.rendered.pages, fingerprint: source.rendered.fingerprint ?? null } } : {}),
    ...(source.failed ? { failed: { fingerprint: source.failed.fingerprint ?? null, at: source.failed.at } } : {}) } }, null, 2);
/** @param {unknown} n @returns {n is number} */
const _count = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) > 0;
// source.json's { galleryId, source }, or null when it isn't one — or names a path that doesn't stay
// inside the library folder, or a gallery id that isn't one.
/** @param {string} text @returns {{ galleryId: string, source: Source } | null} */
export function parseSource(text) {
  /** @type {any} JSON of any shape, checked field by field below */
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  const s = v?.source;
  if (v?.format !== 'shiori-linked' || !isValidGalleryId(v.galleryId) || !KINDS.has(s?.kind) || !safeRelPath(s.path)) return null;
  const inner = s.inner === '' || s.inner == null ? null : s.inner;
  if (inner != null && (s.kind !== 'zip' || !_safeInner(inner))) return null;
  const pdf = s.kind === 'pdf';
  const drawn = !pdf ? null : _count(s.rendered) ? { pages: s.rendered, fingerprint: null }
    : _count(s.rendered?.pages) ? { pages: s.rendered.pages, fingerprint: typeof s.rendered.fingerprint === 'string' ? s.rendered.fingerprint : null } : null;
  const failed = pdf && s.failed && typeof s.failed === 'object' && Number.isFinite(s.failed.at)
    ? { fingerprint: typeof s.failed.fingerprint === 'string' ? s.failed.fingerprint : null, at: s.failed.at } : null;
  return { galleryId: String(v.galleryId), source: { kind: s.kind, path: s.path, ...(inner ? { inner } : {}),
    size: Number.isFinite(s.size) ? s.size : null, fingerprint: typeof s.fingerprint === 'string' ? s.fingerprint : null,
    ...(drawn ? { rendered: drawn } : {}), ...(failed ? { failed } : {}) } };
}
// A source's key: what it is and where (two titles of one archive differ by their folder in it).
/** A source, or a title found, as far as where it is: what it is, its path, its folder in an archive.
 * `content`: a folder of pictures' folderContent, hashed, beside its fingerprint.
 * @typedef {{ kind: string, path: string, inner?: string | null, fingerprint?: string | null, content?: string | null }} SourceAt */
/** @param {SourceAt} s @returns {string} */
export const sourceKey = (s) => `${s.kind}\u0000${s.path}\u0000${s.inner || ''}`;

// The sources removed from the library: [{ kind, path, inner?, fingerprint, at }].
/** @typedef {SourceAt & { at?: number }} Removed */
/** @param {string} text @returns {Removed[]} */
export function parseRemoved(text) {
  try { const v = JSON.parse(text); return Array.isArray(v?.removed) ? v.removed.filter(/** @param {{ path?: unknown } | null} r */ r => safeRelPath(r?.path)) : []; } catch { return []; }
}
/** @param {Removed[]} list @returns {string} */
export const removedText = (list) => JSON.stringify({ format: 'shiori-linked-removed', version: 1, removed: list }, null, 2);
// Whether `source` (as found: { path, inner?, fingerprint } — its fingerprint as it is now) is one of
// `removed`: the same files where they were — one changed since (another fingerprint) counts as new.
/** @param {Removed[]} removed @param {SourceAt} source @returns {boolean} */
export const isRemoved = (removed, source) => removed.some(r => r.path === source.path && (r.inner || '') === (source.inner || '')
  && (!r.fingerprint || !source.fingerprint || r.fingerprint === source.fingerprint));
// `removed` with `source` noted as removed (its fingerprint as it is now), in place of an earlier note
// of the same files.
/** @param {Removed[]} removed @param {SourceAt} source @param {number} [now] @returns {Removed[]} */
export const withRemoved = (removed, source, now = Date.now()) => [
  ...removed.filter(r => !(r.path === source.path && (r.inner || '') === (source.inner || ''))),
  { kind: source.kind, path: source.path, ...(source.inner ? { inner: source.inner } : {}), fingerprint: source.fingerprint || null, at: now },
];

// What a folder of pictures' fingerprint is made from (hashed by the caller, SHA-256 in hex): its
// pictures' names and sizes. An archive's is its central directory's bytes (import-cbz.js zipEntries:
// every entry's name, size and CRC-32). A folder's `content` (folderContent, hashed alike) adds each
// picture's modification time, so a picture replaced in place by one of the same size is told too
// (matchSources) — its fingerprint, what a removal note keeps, stays as it was.
/** @typedef {{ name: string, size?: number | null, mtime?: number | null }} Pictured */
/** @param {Iterable<Pictured>} pictures */
const _byName = (pictures) => [...pictures].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
/** @param {Iterable<Pictured>} pictures @returns {string} */
export const folderPrint = (pictures) => _byName(pictures).map(p => `${p.name}\t${p.size}`).join('\n');
/** @param {Iterable<Pictured>} pictures @returns {string} */
export const folderContent = (pictures) => _byName(pictures).map(p => `${p.name}\t${p.size}\t${wholeMs(p.mtime)}`).join('\n');

// A source picture's content signal (principle 7, T07): what tells its bytes from other bytes under
// the same name and size — a ZIP entry's CRC-32, as its archive's directory has it (8 hex digits:
// crcHex), or a folder file's modification time (in whole milliseconds, as both apps read it: wholeMs).
/** @param {number} crc @returns {string} */
export const crcHex = (crc) => (crc >>> 0).toString(16).padStart(8, '0');
/** @param {number | null | undefined} ms @returns {number | null} */
export const wholeMs = (ms) => (Number.isFinite(ms) ? Math.floor(/** @type {number} */ (ms)) : null);
/** A source picture as a page records it (gallery-files.js galleryFiles `sourceOf`, a manifest's
 * `sources`): its name and size, and its content signal when it has one.
 * @typedef {{ name: string, size: number, crc?: string, mtime?: number }} Provenance */
/** @param {{ name: string, size: number | null, crc?: string | null, mtime?: number | null }} p @returns {Provenance} */
export const provenanceOf = (p) => ({ name: p.name, size: p.size ?? 0, ...(typeof p.crc === 'string' ? { crc: p.crc } : {}),
  ...(wholeMs(p.mtime) != null ? { mtime: /** @type {number} */ (wholeMs(p.mtime)) } : {}) });
/** Whether a page's recorded provenance is the source picture it shows now (`page`), its content signal
 * included: one that isn't (what was made from it dropped, or recorded before content signals were) is
 * recorded anew at its gallery's next publication.
 * @param {{ name: string, size: number, crc?: string, mtime?: number }} recorded @param {{ name: string, size: number | null, crc?: string, mtime?: number }} page
 * @returns {boolean} */
export const sameProvenance = (recorded, page) => JSON.stringify(provenanceOf(recorded)) === JSON.stringify(provenanceOf(page));
// A page's source token (principle 7, a translation in flight): what work made from a page's picture
// away from the library — a translation — is bound to. Both apps hand it out before the picture is read
// (pageSources), the work gives it back with its result, and the result is kept only while the page
// still shows that picture (madeFromPage): one made from a source picture a check has since read anew
// (changed in place, or another now) is refused and changes nothing. A linked page's token is its
// source picture's provenance, content signal included; a page of the library's own (`record`, its page
// record: no provenance) its picture's size and when it was stored (`cachedAt`), so one made from the
// picture a page had before it was stored again (downloaded again) is refused too (O1, S10) — while a
// move, an archiving or a settle, which keep the picture, keep the token.
/** @param {{ name: string, size: number | null, crc?: string | null, mtime?: number | null } | null | undefined} provenance
 * @param {{ size?: number | null, cachedAt?: number | null } | null} [record] @returns {string} */
export const pageToken = (provenance, record = null) => (provenance ? JSON.stringify(provenanceOf(provenance))
  : JSON.stringify({ size: record?.size ?? 0, stored: wholeMs(record?.cachedAt) ?? 0 }));
/** Whether a result made from a page's picture read as `token` may be kept now that the page's token is
 * `now`. No token (work handed out before tokens were): kept, as before.
 * @param {unknown} token @param {string} now @returns {boolean} */
export const madeFromPage = (token, now) => token == null || token === now;

/** @param {string} path @returns {boolean} */
const _hidden = (path) => path.split('/').some(s => s.startsWith('.') || s === '__MACOSX');
/** @param {string} name @returns {string} */
const _stem = (name) => name.replace(/\.[^./]+$/, '');

// Pictures in the order the import takes them (import-cbz.js sortImageEntries): natural order by
// path, folder by folder, the extension not counting. `key` gives each one's path.
/**
 * @template {object} T
 * @param {T[]} list
 * @param {(p: T) => string} [key] by default its `path`
 * @returns {T[]}
 */
export function sortPictures(list, key = (p) => /** @type {{ path: string }} */ (p).path) {
  const parts = /** @param {T} p */ (p) => _stem(key(p)).split('/');
  return [...list].sort((a, b) => {
    const pa = parts(a), pb = parts(b);
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const c = naturalCompare(pa[i], pb[i]);
      if (c) return c;
    }
    return pa.length - pb.length;
  });
}

// What a library folder holds that isn't Shiori's, as titles. Every folder holding pictures is one
// gallery (its own pictures; its subfolders' are titles of their own — folders not laid out as
// Shiori's are most likely titles each, put there some other way), named after it — the pictures
// loose at the top of the library folder one more, named after it (`rootName`); every archive a
// gallery, or a series when its pictures sit in folders (zipTitles); every PDF a gallery. `files`:
// every file in the library folder, [{ path, size? }] ('/'-separated, from its top; hidden ones and
// the library's own .shiori left out here, as is a path that isn't safe: safeRelPath). `own`: the
// paths of Shiori's own galleries there (folder-content.js: its folders, all they hold left out, and
// its archives). Resolves [{ kind: 'zip' | 'pdf', path, size } | { kind: 'dir', path ('' for the top),
// name, pictures: [{ path, size }] }].
/** @typedef {{ path: string, size: number | null }} Picture */
/** @typedef {{ kind: 'zip' | 'pdf', path: string, size: number | null }
 *   | { kind: 'dir', path: string, name: string, pictures: Picture[] }} PlannedTitle */
/**
 * @param {{ path: string, size?: number | null }[]} files @param {string} rootName @param {Iterable<string>} own
 * @returns {PlannedTitle[]}
 */
export function planTitles(files, rootName, own) {
  const list = files.filter(f => safeRelPath(f?.path) && !_hidden(f.path));
  /** @param {string} p */
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
  const mine = [...own];
  /** @param {string} p */
  const isOwn = (p) => mine.some(o => p === o || p.startsWith(`${o}/`));
  /** @type {PlannedTitle[]} */
  const titles = [];
  /** @type {Map<string, Picture[]>} */
  const folders = new Map();   // a folder ('' for the top) → its own pictures
  for (const f of list) {
    if (isOwn(f.path)) continue;
    if (ARCHIVE_NAME.test(f.path)) titles.push({ kind: 'zip', path: f.path, size: f.size ?? null });
    else if (PDF_NAME.test(f.path)) titles.push({ kind: 'pdf', path: f.path, size: f.size ?? null });
    else if (IMAGE_NAME.test(f.path)) {
      const dir = dirOf(f.path).replace(/\/$/, '');
      if (!folders.has(dir)) folders.set(dir, []);
      /** @type {Picture[]} */ (folders.get(dir)).push({ path: f.path, size: f.size ?? null });
    }
  }
  for (const [dir, pictures] of folders) titles.push({ kind: 'dir', path: dir, name: dir ? dir.slice(dir.lastIndexOf('/') + 1) : rootName, pictures: sortPictures(pictures) });
  return titles.sort((a, b) => naturalCompare(a.path, b.path));
}
// An archive's galleries (`names`: its entries' names, decoded by folder-content.js zipName), as the
// import makes them: its pictures in order — or, when they sit in more than one folder, a series (the
// archive) of chapters: each folder holding pictures one, named after it (folders holding only
// folders don't count), the pictures beside the folders opening the first. A picture whose name isn't
// a safe path is left out, so every chapter's folder can be kept in its source. Resolves [{ inner (''
// or "Folder/": the chapter's folder in the archive), pictures: [names], chapter (in a series) }].
/** @param {string[]} names @returns {{ inner: string, pictures: string[], chapter: boolean }[]} */
export function zipTitles(names) {
  const pictures = sortPictures(names.filter(n => IMAGE_NAME.test(n) && safeRelPath(n) && !_hidden(n)).map(path => ({ path }))).map(p => p.path);
  /** @type {Map<string, string[]>} */
  const byFolder = new Map();
  for (const n of pictures) {
    const dir = n.slice(0, n.lastIndexOf('/') + 1);
    if (!byFolder.has(dir)) byFolder.set(dir, []);
    /** @type {string[]} */ (byFolder.get(dir)).push(n);
  }
  const folders = [...byFolder].filter(([dir]) => dir);
  if (folders.length < 2) return pictures.length ? [{ inner: '', pictures, chapter: false }] : [];
  const loose = byFolder.get('') || [];
  return folders.map(([inner, list], i) => ({ inner, pictures: i === 0 ? [...loose, ...list] : list, chapter: true }));
}

// A linked gallery's pages: its source's pictures in order (`source`: [{ name, size, crc? | mtime? }]
// — each one's content signal, when read — page n the n-th), each one its overlay holds a page of its
// own for (`overlay`: the files in its overlay's images/, [{ name, size }] — named by page number,
// gallery-files.js pageNumberOf) replaced by that one, and the overlay's pages past the source's added
// (a PDF's, drawn). Of two overlay files for one page (a write's, not tidied yet), the one
// gallery-files.js pickFile takes — `described`: the files the overlay's descriptions name
// (describedFiles). Resolves [{ n, from: 'source' | 'overlay', name, size, crc?, mtime? }] in page
// order.
/** @typedef {{ n: number, from: 'source' | 'overlay', name: string, size: number | null, crc?: string, mtime?: number }} LinkedPage */
/**
 * @param {{ name: string, size?: number | null, crc?: string | null, mtime?: number | null }[]} source
 * @param {{ name: string, size?: number | null }[]} [overlay]
 * @param {Set<string> | null} [described]
 * @returns {LinkedPage[]}
 */
export function linkedPages(source, overlay = [], described = null) {
  /** @type {Map<number, LinkedPage>} */
  const pages = new Map(source.map((p, i) => [i + 1, { n: i + 1, from: 'source', name: p.name, size: p.size ?? null,
    ...(typeof p.crc === 'string' ? { crc: p.crc } : {}), ...(wholeMs(p.mtime) != null ? { mtime: /** @type {number} */ (wholeMs(p.mtime)) } : {}) }]));
  /** @type {Map<number, Map<string, { name: string, size?: number | null }>>} */
  const byNumber = new Map();   // page number → its overlay files, by their path in the overlay
  for (const f of overlay) {
    const n = IMAGE_NAME.test(f.name) ? pageNumberOf(f.name) : null;
    if (n == null) continue;
    if (!byNumber.has(n)) byNumber.set(n, new Map());
    /** @type {Map<string, { name: string, size?: number | null }>} */ (byNumber.get(n)).set(`images/${f.name}`, f);
  }
  for (const [n, files] of byNumber) {
    const f = files.get(pickFile([...files.keys()], described) ?? '');
    if (f) pages.set(n, { n, from: 'overlay', name: f.name, size: f.size ?? null });
  }
  return [...pages.values()].sort((a, b) => a.n - b.n);
}

// Whether what was made from a linked gallery's page (its translation, study layers, pipeline data) is
// still the page's: always for a page of its overlay's own; for one of its source, only while the
// source picture it shows (`page`, linkedPages') is the one its overlay's description says it was made
// from (`recorded`: the page's Provenance — image_records.json `source`, gallery-files.js galleryFiles
// `sourceOf`): the same name and size, and the same content signal (T07: a ZIP entry's CRC-32, a
// folder file's modification time). A page whose picture changed, or that shows another now (one added
// before it), has it dropped: it is never shown over another picture. A page recorded before content
// signals were (its provenance has none) can't be told apart from a picture of the same name and size:
// it keeps what was made from it only while the source as a whole is the one the library was last told
// of (`unchanged`: sameSource).
/**
 * @param {LinkedPage} page @param {{ name?: string, size?: number, crc?: string, mtime?: number } | null | undefined} recorded
 * @param {boolean} [unchanged]
 * @returns {boolean}
 */
export function keepsDerived(page, recorded, unchanged = false) {
  if (page.from === 'overlay') return true;
  if (!Number.isSafeInteger(page.size) || recorded?.name !== page.name || recorded.size !== page.size) return false;
  if (page.crc != null) return recorded.crc == null ? unchanged : recorded.crc === page.crc;
  if (page.mtime != null) return recorded.mtime == null ? unchanged : wholeMs(recorded.mtime) === page.mtime;
  return true;
}
// Whether a source is as the library was last told of it (`before`: the source its index keeps, or
// its overlay's source.json; `now`: as a check reads it): the same fingerprint, and, where both are
// known, the same content (keepsDerived's `unchanged`).
/** @param {SourceAt | null | undefined} before @param {SourceAt | null | undefined} now @returns {boolean} */
export const sameSource = (before, now) => before?.fingerprint != null && before.fingerprint === now?.fingerprint
  && (before.content == null || now.content == null || before.content === now.content);

// Whether a PDF's pages are drawn: its source says how many (`rendered`, written once the last was
// kept) and its overlay's images/ (`overlay`: [{ name }]) holds each of them. Until then it waits —
// pages a window is still drawing, or one that stopped half way, don't make a gallery.
/** @param {Source | null | undefined} source @param {{ name: string }[]} [overlay] @returns {boolean} */
export function pdfReady(source, overlay = []) {
  const count = source?.kind === 'pdf' ? source.rendered?.pages : null;
  if (!_count(count)) return false;
  const have = new Set(overlay.filter(f => IMAGE_NAME.test(f.name)).map(f => pageNumberOf(f.name)));
  for (let n = 1; n <= count; n++) if (!have.has(n)) return false;
  return true;
}
// Whether drawing a PDF's pages failed for the file as it is now (`fingerprint`, its current one): it
// isn't tried again until the file changes.
/** @param {Source | null | undefined} source @param {string | null | undefined} fingerprint @returns {boolean} */
export const drawFailed = (source, fingerprint) => !!source?.failed && fingerprint != null && source.failed.fingerprint === fingerprint;
// Whether a PDF's pages are to be drawn (both apps' pdfsWaiting): not drawn yet (pdfReady), or drawn
// from another version of its file than the one there now (`fingerprint`; by default its source's, as
// its last check found it) — a gallery the library has keeps the pages it has until the new ones are
// all in (F10) — and in either case not one whose drawing failed for that version (drawFailed). Pages
// whose marker doesn't say what they were drawn from (its first form) are taken as of the file as it is.
/**
 * @param {Source | null | undefined} source @param {{ name: string }[]} [overlay]
 * @param {string | null} [fingerprint] @returns {boolean}
 */
export function pdfWaits(source, overlay = [], fingerprint = source?.fingerprint ?? null) {
  if (source?.kind !== 'pdf' || drawFailed(source, fingerprint)) return false;
  if (!pdfReady(source, overlay)) return true;
  const from = source.rendered?.fingerprint;
  return from != null && fingerprint != null && from !== fingerprint;
}

// A PDF's fingerprint: its size and the SHA-256 (hex, the caller's) of its first PDF_HEAD bytes.
export const PDF_HEAD = 1024 * 1024;
/** @param {number} size @param {string | null} headHash @returns {string} */
export const pdfPrint = (size, headHash) => `${size}:${headHash}`;
// Whether a PDF's drawing — its pages, or that it couldn't be drawn — is for the file as it is now
// (principle 7, T10): a drawing names the version it read (`token`: the fingerprint of the bytes
// pdfSource handed out), and it is kept only while the file is still that version (`now`: its
// fingerprint read again just before anything is written; null when it can't be read). One of another
// version, or of a file that can't be read now, is refused and changes nothing — the PDF waits to be
// drawn from the file as it is.
/** @param {unknown} token @param {string | null | undefined} now @returns {boolean} */
export const drawnFrom = (token, now) => typeof token === 'string' && token !== '' && token === now;
// Whether a PDF's drawing is pages to keep (principle 7, T11): one at least, each a picture with bytes
// (a Blob, or what reads like one). Checked before anything is written or replaced, so an empty or
// broken result never takes the place of the pages a gallery has.
/** @param {unknown} pages @returns {boolean} */
export const isDrawing = (pages) => Array.isArray(pages) && pages.length > 0
  && pages.every(p => p != null && typeof p.arrayBuffer === 'function' && p.size !== 0);

// What a check of a library folder makes of the linked titles it found (`found`: planTitles' and
// zipTitles' titles, [{ kind, path, inner?, fingerprint, … }], each with its fingerprint as it is now,
// null when it couldn't be read), against the linked galleries the library keeps there (`kept`:
// [{ gid, source }], as stored), the overlays the folder holds (`overlays`: [{ galleryId, source }],
// parseSource's), the galleries the library has anywhere (`known`: a Set of ids) and removed.json's
// list (`removed`). A source is where it is (plan D5): one renamed or moved outside the app is another
// source — it joins as new, and the gallery that was there is missing, its overlay (what the library
// added to it) kept until it is deleted. Each title found lands in one list, each kept gallery in one:
// - same: a kept gallery's source where it was, its fingerprint the same (or unreadable now).
// - changed: where it was, its files changed (another fingerprint, or, both known, another content: a
//   picture replaced in place by one of the same size): its pages are read again.
// - new: a title nothing knows, joining the library — as gallery `gid` when the folder holds an
//   overlay made for it where it is (that overlay keeps its identity: its series, its edits), unless
//   it was removed (an overlay its removal hasn't deleted yet: the note is written first).
// - missing: a kept gallery whose source isn't where it was: { gid, source }.
// - skipped: a title not to join: 'removed' (removed from the library before: isRemoved), 'copy' (its
//   overlay's gallery the library has elsewhere) or 'unknown' (the overlays, or removed.json, couldn't be
//   read now: null — either may be about it, so it waits for a check that reads them; review 6 F2, F4).
//   { title, reason }.
/** @typedef {SourceAt & { [field: string]: unknown }} FoundTitle */
/** @typedef {{ gid: string, source: SourceAt }} KeptSource */
/** @typedef {{
 *   same: { title: FoundTitle, gid: string }[], changed: { title: FoundTitle, gid: string, was: SourceAt }[],
 *   new: { title: FoundTitle, gid?: string }[], missing: KeptSource[], skipped: { title: FoundTitle, reason: 'removed' | 'copy' | 'unknown' }[],
 * }} SourceMatch */
/**
 * @param {{ found: FoundTitle[], kept?: { gid: string | number, source: SourceAt }[], overlays?: { galleryId: string, source: SourceAt }[] | null,
 *   known?: Set<string>, removed?: Removed[] | null }} check
 * @returns {SourceMatch}
 */
export function matchSources({ found, kept = [], overlays = [], known = new Set(), removed = [] }) {
  /** @type {SourceMatch} */
  const out = { same: [], changed: [], new: [], missing: [], skipped: [] };
  const keptAt = new Map(kept.map(k => [sourceKey(k.source), { ...k, gid: String(k.gid) }]));
  const keptIds = new Set([...keptAt.values()].map(k => k.gid));
  // An overlay of a gallery the library keeps here says nothing the library doesn't know.
  const overAt = new Map((overlays ?? []).filter(o => !keptIds.has(o.galleryId)).map(o => [sourceKey(o.source), o]));
  const foundKeys = new Set(found.map(sourceKey));
  for (const title of found) {
    const k = keptAt.get(sourceKey(title));
    const over = !k && overAt.get(sourceKey(title));
    if (k) {
      const changed = (title.fingerprint != null && title.fingerprint !== (k.source.fingerprint ?? null))
        || (title.content != null && k.source.content != null && title.content !== k.source.content);
      if (changed) out.changed.push({ title, gid: k.gid, was: k.source }); else out.same.push({ title, gid: k.gid });
    } else if (!overlays || !removed) out.skipped.push({ title, reason: 'unknown' });
    else if (isRemoved(removed, title)) out.skipped.push({ title, reason: 'removed' });   // a removed one's overlay its removal couldn't delete yet too
    else if (over && known.has(over.galleryId)) out.skipped.push({ title, reason: 'copy' });
    else out.new.push(over ? { title, gid: over.galleryId } : { title });
  }
  for (const k of keptAt.values()) if (!foundKeys.has(sourceKey(k.source))) out.missing.push({ gid: k.gid, source: k.source });
  return out;
}

// A gallery's metadata as its file or folder name tells it, the way such names are usually written —
// "[Circle (Artist)] Title (Collection)", "[Artist] Title" — and the folders it is in (`folders`,
// outermost first) as tags. Resolves { title, tags }.
/**
 * @param {string} name @param {string[]} [folders]
 * @returns {{ title: { english: string, japanese: string, pretty: string }, tags: { type: string, name: string }[] }}
 */
export function metaFromName(name, folders = []) {
  const stem = String(name).replace(ARCHIVE_NAME, '').replace(PDF_NAME, '').trim();
  /** @type {{ type: string, name: string }[]} */
  const tags = [];
  let rest = stem;
  const lead = rest.match(/^\[([^\]]+)\]\s*/);
  if (lead) {
    rest = rest.slice(lead[0].length);
    const who = lead[1].trim();
    const pair = who.match(/^(.+?)\s*\((.+)\)$/);
    /** @param {string} type @param {string} list */
    const add = (type, list) => { for (const n of list.split(/\s*[,&、]\s*/)) if (n) tags.push({ type, name: n.toLowerCase() }); };
    if (pair) { add('group', pair[1]); add('artist', pair[2]); } else add('artist', who);
  }
  const plain = rest.replace(/\s*(\([^)]*\)|\[[^\]]*\]|\{[^}]*\})\s*$/g, '').trim() || rest.trim() || stem;
  for (const f of folders) if (f && !f.startsWith('.')) tags.push({ type: 'tag', name: f.toLowerCase() });
  const seen = new Set();
  return { title: { english: stem, japanese: '', pretty: plain },
    tags: tags.filter(t => { const k = `${t.type}:${t.name}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
}

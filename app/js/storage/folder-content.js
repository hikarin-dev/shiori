// folder-content.js — what a library folder holds, as both apps read it: which of its folders and
// archives are Shiori's own (the library may write, move, archive, unpack and delete them) and which
// are not (linked: read where they lie, never written — linked-source.js). Shiori's own is told by a
// description only Shiori writes, read and checked — never by file or folder names: a metadata.json
// naming a gallery (its id and title), a series' series.json, or the desktop app's earlier
// shiori.json. A folder with an images/ subfolder, or with another tool's metadata.json, is not
// Shiori's. And one rule decodes an archive's entry names (zipName), so both apps name an archive's
// titles alike. Pure: the browser library (db.js) and the desktop app's (server/scan.js, linked.js)
// read the files and hand them here.

import { isValidGalleryId } from '../sanitize.js';
import { safeRelPath } from './linked-source.js';

// The files whose text classifyFolder and classifyArchive read (those a folder or archive has): a
// gallery's manifest (format v2, gallery-manifest.js: in its .shiori/ subfolder) first, the strongest
// mark that it is one, then the descriptions at its top.
export const MANIFEST_FILE = '.shiori/gallery.json';
export const OWN_FILES = [MANIFEST_FILE, 'metadata.json', 'series.json', 'shiori.json'];
// The gallery a manifest's text names, when it is one: { format: 'shiori-gallery', version: 2,
// galleryId } (gallery-manifest.js parseManifest checks the rest when it is read).
/** @param {unknown} text @returns {string | null} */
const _manifestIdOf = (text) => { const m = _json(text); return _object(m) && m.format === 'shiori-gallery' && m.version === 2 ? _id(m.galleryId) : null; };
// Whether a manifest's text is a reservation's (gallery-manifest.js firstGeneration: generation 0) —
// the folder made for its gallery, nothing of the gallery published there yet.
/** @param {unknown} text @returns {boolean} */
const _reservedOnly = (text) => _json(text)?.generation === 0;

// The names Shiori writes something under before it takes its place, and nothing else: `<name>.shiori-tmp`
// (a file replaced whole; a gallery's folder copied, unpacked or archived — `<name>.<hex>.shiori-tmp`),
// `-new`, `-old`. Neither app's check reads one as a gallery or a linked source; what one holds is Shiori's
// only once it is in place.
export const TEMPORARY = /\.shiori-(tmp|old|new)$/;

/** A file's text as parsed JSON, of any shape (each reader checks what it uses), or null.
 * @param {unknown} text @returns {any} */
const _json = (text) => { if (typeof text !== 'string') return null; try { return JSON.parse(text); } catch { return null; } };
/** @param {unknown} v @returns {boolean} */
const _object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// A gallery id as Shiori writes it (a string of digits, or the number an early version wrote), as a
// string; null for anything else.
/** @param {unknown} v @returns {string | null} */
const _id = (v) => ((typeof v === 'string' || Number.isSafeInteger(v)) && isValidGalleryId(v) ? String(v) : null);
// The title fields an early version wrote in place of the title object (titles.js normalizeTitle).
const FLAT_TITLES = ['titleEnglish', 'titleJapanese', 'titlePretty'];

/** A series' series.json as seriesOf reads it: its chapters each with a gallery id and a folder.
 * @typedef {{ [field: string]: unknown, id: string, folder: string }} SeriesChapter
 * @typedef {{ [field: string]: unknown, chapters: SeriesChapter[] }} Series */
/** What a folder or archive is (classifyFolder, classifyArchive).
 * @typedef {{ kind: 'series', series: Series } | { kind: 'gallery', id: string, legacy?: boolean, reserved?: boolean } | { kind: 'other' }} FolderKind
 * @typedef {{ kind: 'series', series: { [field: string]: unknown, chapters: (SeriesChapter & { present: boolean })[] } }
 *   | { kind: 'gallery', id: string, legacy?: boolean, reserved?: boolean } | { kind: 'linked' }} ArchiveKind */
/** The texts of a folder's (or archive's) OWN_FILES: name → text, missing or null when it hasn't it.
 * @typedef {Record<string, string | null | undefined>} OwnTexts */

// The gallery a metadata.json's text describes: its id, when it is Shiori's — an object with a gallery
// id and a title (the title object, or an early version's flat title fields) — else null.
/** @param {unknown} text @returns {string | null} */
export function galleryIdOf(text) {
  const m = _json(text);
  if (!_object(m)) return null;
  return _object(m.title) || FLAT_TITLES.some(k => typeof m[k] === 'string') ? _id(m.galleryId) : null;
}

// The series a series.json's text describes, when it is Shiori's (gallery-files.js seriesManifest):
// the manifest, its chapters each { id, folder, … } — `folder` the member's folder in the series'
// folder or archive (chapter-NN when an early export left it out) — else null. A chapter without a
// gallery id, or whose folder isn't a plain name, makes it not Shiori's.
/** @param {unknown} text @returns {Series | null} */
export function seriesOf(text) {
  const s = _json(text);
  if (!_object(s) || s.format !== 'shiori-series' || !Array.isArray(s.chapters) || !s.chapters.length) return null;
  /** @type {SeriesChapter[]} */
  const chapters = [];
  for (const [i, c] of s.chapters.entries()) {
    const id = _object(c) ? _id(c.id) : null;
    const folder = String(c?.folder || `chapter-${String(i + 1).padStart(2, '0')}`).replace(/\/+$/, '');
    if (!id || folder.includes('/') || !safeRelPath(folder)) return null;
    chapters.push({ ...c, id, folder });
  }
  return { ...s, chapters };
}

// The gallery an earlier desktop version's shiori.json describes ({ format: 'shiori-gallery', id,
// meta, pages }): its id, or null.
/** @param {unknown} text @returns {string | null} */
function _legacyIdOf(text) {
  const d = _json(text);
  return _object(d) && d.format === 'shiori-gallery' ? _id(d.id) : null;
}

// What a folder of a library folder is, from its OWN_FILES' texts (`texts`: name → text; a file it
// hasn't, missing or null):
// - { kind: 'series', series }: a series' folder (seriesOf). Its members are folders (or archives) of
//   their own in it, each classified on its own.
// - { kind: 'gallery', id, legacy?, reserved? }: a gallery's folder — all it holds is the gallery's — by
//   its manifest (MANIFEST_FILE), else its metadata.json. `legacy`: described by an earlier desktop
//   version's shiori.json (its pictures beside it, not in images/). `reserved`: its manifest is still
//   its reservation's (generation 0) — the folder names its gallery for the library writing to it, but
//   isn't whole: what was to be put in it may never have committed (a first write, a move or an unpack
//   cut short by a failed write, a kill or the page closing). A check never takes it for the gallery,
//   nor what it holds for a linked one; the gallery's first publication there makes it whole (S12,
//   review 4 F2).
// - { kind: 'other' }: not Shiori's. What it holds is linked (linked-source.js planTitles), its
//   subfolders classified on their own.
/** @param {OwnTexts} [texts] @returns {FolderKind} */
export function classifyFolder(texts = {}) {
  const series = seriesOf(texts['series.json']);
  if (series) return { kind: 'series', series };
  const manifest = _manifestIdOf(texts[MANIFEST_FILE]);
  if (manifest) return _reservedOnly(texts[MANIFEST_FILE]) ? { kind: 'gallery', id: manifest, reserved: true } : { kind: 'gallery', id: manifest };
  const id = galleryIdOf(texts['metadata.json']);
  if (id) return { kind: 'gallery', id };
  const legacy = _legacyIdOf(texts['shiori.json']);
  return legacy ? { kind: 'gallery', id: legacy, legacy: true } : { kind: 'other' };
}

// Whether a gallery's directory, there, is gallery `gid`'s (principle 2: an existing directory is
// touched only once it names the gallery), from the texts of its OWN_FILES — its manifest, else its
// metadata.json, else an earlier desktop version's shiori.json (classifyFolder) — and, for a linked
// gallery's overlay (`linked`), its source.json (`source`: the gallery id it names, linked-source.js
// parseSource). { kind: 'ok' }, or a conflict: `found` the gallery it names instead, or null for a
// directory naming none (put there by hand, or a series' folder). Nothing but a reservation makes a
// directory name a gallery: a description written into one that doesn't would make it look like one.
/** @param {OwnTexts} texts @param {string} gid @param {{ source?: string | null }} [linked]
 * @returns {{ kind: 'ok' } | { kind: 'conflict', found: string | null }} */
export function galleryAt(texts, gid, linked) {
  const what = classifyFolder(texts);
  const found = linked ? (_manifestIdOf(texts[MANIFEST_FILE]) ?? linked.source ?? null) : what.kind === 'gallery' ? what.id : null;
  return found === String(gid) ? { kind: 'ok' } : { kind: 'conflict', found };
}

// The id a library folder's .shiori/library.json names — the file written once, when the folder first
// joins a library ({ format: 'shiori-library', version: 1, id }: sixteen hex digits) — or null for
// text that names none. Which library folder a path holds is told by it alone (principle 1).
export const LIBRARY_FILE = '.shiori/library.json';
/** @param {unknown} text @returns {string | null} */
export function libraryIdOf(text) {
  const id = _json(text)?.id;
  return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) ? id : null;
}

// What an archive in a library folder is, from its entries' names (`names`, zipName's) and the texts
// of the OWN_FILES at its top (`texts`, as for classifyFolder):
// - { kind: 'gallery', id, legacy? }: a gallery in the gallery format (an export, or one the desktop
//   app archived) — Shiori's own, as its folder would be.
// - { kind: 'series', series }: a series export; each chapter says whether the archive holds its
//   folder (`present`).
// - { kind: 'linked' }: anything else — or one with an entry whose name isn't a safe path (an archive
//   Shiori's own are unpacked from must never write outside the folder it unpacks to): linked.
/** @param {Iterable<string>} names @param {OwnTexts} [texts] @returns {ArchiveKind} */
export function classifyArchive(names, texts = {}) {
  const list = [...names];
  if (!list.every(n => safeRelPath(String(n).replace(/\/$/, '')))) return { kind: 'linked' };
  const found = classifyFolder(texts);
  if (found.kind === 'other') return { kind: 'linked' };
  if (found.kind === 'gallery') return found;
  const chapters = found.series.chapters.map(c => ({ ...c, present: list.some(n => n.startsWith(`${c.folder}/`)) }));
  return { kind: 'series', series: { ...found.series, chapters } };
}

// An archive entry's name from its bytes (`bytes`, a Uint8Array) — the one rule both apps decode by:
// UTF-8 when the entry says so (`utf8Flag`: general purpose flag bit 11); else UTF-8 when the bytes
// are valid UTF-8 (as macOS and many tools write names without saying so), else code page 437, the
// format's own.
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐'
  + '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const _strictUtf8 = new TextDecoder('utf-8', { fatal: true });
/** @param {Uint8Array} bytes @param {boolean | number} utf8Flag @returns {string} */
export function zipName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder().decode(bytes);
  try { return _strictUtf8.decode(bytes); } catch {}
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

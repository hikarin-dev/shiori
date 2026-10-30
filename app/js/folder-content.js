// folder-content.js — what a library folder holds, as both apps read it: which of its folders and
// archives are Shiori's own (the library may write, move, archive, unpack and delete them) and which
// are not (linked: read where they lie, never written — linked-source.js). Shiori's own is told by a
// description only Shiori writes, read and checked — never by file or folder names: a metadata.json
// naming a gallery (its id and title), a series' series.json, or the desktop app's earlier
// shiori.json. A folder with an images/ subfolder, or with another tool's metadata.json, is not
// Shiori's. And one rule decodes an archive's entry names (zipName), so both apps name an archive's
// titles alike. Pure: the browser library (db.js) and the desktop app's (server/scan.js, linked.js)
// read the files and hand them here.

import { isValidGalleryId } from './sanitize.js';
import { safeRelPath } from './linked-source.js';

// The files whose text classifyFolder and classifyArchive read (those a folder or archive has).
export const OWN_FILES = ['metadata.json', 'series.json', 'shiori.json'];

const _json = (text) => { if (typeof text !== 'string') return null; try { return JSON.parse(text); } catch { return null; } };
const _object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// A gallery id as Shiori writes it (a string of digits, or the number an early version wrote), as a
// string; null for anything else.
const _id = (v) => ((typeof v === 'string' || Number.isSafeInteger(v)) && isValidGalleryId(v) ? String(v) : null);
// The title fields an early version wrote in place of the title object (titles.js normalizeTitle).
const FLAT_TITLES = ['titleEnglish', 'titleJapanese', 'titlePretty'];

// The gallery a metadata.json's text describes: its id, when it is Shiori's — an object with a gallery
// id and a title (the title object, or an early version's flat title fields) — else null.
export function galleryIdOf(text) {
  const m = _json(text);
  if (!_object(m)) return null;
  return _object(m.title) || FLAT_TITLES.some(k => typeof m[k] === 'string') ? _id(m.galleryId) : null;
}

// The series a series.json's text describes, when it is Shiori's (gallery-files.js seriesManifest):
// the manifest, its chapters each { id, folder, … } — `folder` the member's folder in the series'
// folder or archive (chapter-NN when an early export left it out) — else null. A chapter without a
// gallery id, or whose folder isn't a plain name, makes it not Shiori's.
export function seriesOf(text) {
  const s = _json(text);
  if (!_object(s) || s.format !== 'shiori-series' || !Array.isArray(s.chapters) || !s.chapters.length) return null;
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
function _legacyIdOf(text) {
  const d = _json(text);
  return _object(d) && d.format === 'shiori-gallery' ? _id(d.id) : null;
}

// What a folder of a library folder is, from its OWN_FILES' texts (`texts`: name → text; a file it
// hasn't, missing or null):
// - { kind: 'series', series }: a series' folder (seriesOf). Its members are folders (or archives) of
//   their own in it, each classified on its own.
// - { kind: 'gallery', id, legacy? }: a gallery's folder — all it holds is the gallery's. `legacy`:
//   described by an earlier desktop version's shiori.json (its pictures beside it, not in images/).
// - { kind: 'other' }: not Shiori's. What it holds is linked (linked-source.js planTitles), its
//   subfolders classified on their own.
export function classifyFolder(texts = {}) {
  const series = seriesOf(texts['series.json']);
  if (series) return { kind: 'series', series };
  const id = galleryIdOf(texts['metadata.json']);
  if (id) return { kind: 'gallery', id };
  const legacy = _legacyIdOf(texts['shiori.json']);
  return legacy ? { kind: 'gallery', id: legacy, legacy: true } : { kind: 'other' };
}

// What an archive in a library folder is, from its entries' names (`names`, zipName's) and the texts
// of the OWN_FILES at its top (`texts`, as for classifyFolder):
// - { kind: 'gallery', id, legacy? }: a gallery in the gallery format (an export, or one the desktop
//   app archived) — Shiori's own, as its folder would be.
// - { kind: 'series', series }: a series export; each chapter says whether the archive holds its
//   folder (`present`).
// - { kind: 'linked' }: anything else — or one with an entry whose name isn't a safe path (an archive
//   Shiori's own are unpacked from must never write outside the folder it unpacks to): linked.
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
export function zipName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder().decode(bytes);
  try { return _strictUtf8.decode(bytes); } catch {}
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

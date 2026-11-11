// zip-read.js — reading a zip where it is: its central directory, then each entry as it is stored
// (a slice of the file for one stored as it is, inflated for one compressed), never the whole file
// at once. Used by the import (import-cbz.js) and by a library folder's archives read in place
// (db.js, folder-library.js). Runs anywhere: a page, a worker, the service worker. An entry's name is
// decoded by folder-content.js zipName, the rule both apps share, so an archive's titles are named
// alike in either.

import { zipName } from './storage/folder-content.js';

// Typed import failure. Thrown (never swallowed) so the job runner publishes a real error —
// an invalid archive must never look like success — and retains the staged input for a retry.
export class CbzImportError extends Error {
  constructor(code, message) { super(message); this.name = 'CbzImportError'; this.code = code; }
}

// Archive guards: generous bounds no real archive reaches, cheap insurance against a corrupt
// central directory or a zip bomb expanding into memory (unzip holds every entry at once).
const MAX_ZIP_ENTRIES = 20000;

export async function inflateRaw(part) {
  const stream = new Blob([part]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A zip's entries, from its central directory (store + deflate entries) -> [{ filename, size, crc (its
// CRC-32, as the directory says), read, blob }]: read() resolves to the entry's bytes, blob(type) to a
// Blob of them — for an entry stored
// as it is in a zip kept as a Blob, a slice of that Blob, so a page goes into the library without
// ever being read into memory. `source` is the zip as a Blob (a picked or dropped file), read a
// piece at a time — the browser reads no more than 2 GiB of a file into one buffer — or its bytes as
// an ArrayBuffer or a view of one (a Uint8Array, as zipCreate makes), or a list of such entries
// already (import-files.js importBytes: a dropped folder's files), taken as it is. The list's
// `fingerprint` is a SHA-256 of the archive's central directory — every entry's name, size and CRC-32,
// so the same archive always gives the same one and any changed picture another — or null where the
// browser can't hash (a page not on a secure origin).
export async function zipEntries(source) {
  if (Array.isArray(source)) return source;
  const bytes = source instanceof Blob ? null
    : ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
  const part = (from, to) => (bytes || source).slice(from, to);
  const read = async (from, to) => (bytes ? part(from, to) : new Uint8Array(await part(from, to).arrayBuffer()));
  const size = bytes ? bytes.byteLength : source.size;
  const found = await _directory(read, size);
  if (!found) throw new CbzImportError('cbz_parse', 'Not a valid ZIP file');
  const { cd, count } = found;
  if (count > MAX_ZIP_ENTRIES) throw new CbzImportError('cbz_limits', `Archive has too many entries (${count}).`);
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out = [];
  let pos = 0;
  for (let i = 0; i < count && pos + 46 <= cd.byteLength; i++) {
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const compSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const filename = zipName(cd.slice(pos + 46, pos + 46 + nameLen), (flags & 0x0800) !== 0);
    pos += 46 + nameLen + extraLen + commentLen;
    if (filename.endsWith('/') || (method !== 0 && method !== 8)) continue;
    // Where the entry's data starts: past its local header, whose name and extra field may differ
    // in length from the central directory's.
    const dataStart = async () => {
      const head = await read(local, local + 30);
      const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
      return local + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    };
    const failed = (e) => new CbzImportError('cbz_parse', `Failed to read ${filename}: ${e && e.message || e}`);
    const entry = { filename, size, crc, read: async () => {
      try {
        const at = await dataStart();
        return method === 0 ? await read(at, at + compSize) : await inflateRaw(part(at, at + compSize));
      } catch (e) { throw failed(e); }
    }, blob: async (type = '') => {
      if (method !== 0 || bytes) return new Blob([await entry.read()], { type });
      try { const at = await dataStart(); return source.slice(at, at + compSize, type); }
      catch (e) { throw failed(e); }
    } };
    out.push(entry);
  }
  out.fingerprint = await sha256Hex(cd);
  return out;
}
// A zip's central directory ({ cd: its bytes, count: its entries }), or null when it has none. The end
// record closes the zip, followed only by its comment (at most 64 KiB): the last one there whose
// directory reads as one is taken — ending where the record starts, each of its records one; when none
// does, one further back, a piece at a time: an addition cut short (the desktop's, appending to an
// archive it keeps: its entries written, not yet its directory) leaves the previous directory and end
// record whole before them, and that previous generation is what the zip holds (F3). The desktop's
// reader (desktop/server/zip.js readDirectory) has the same rule.
const END_RECORD = 0x06054b50;
const LOOK_BACK = 1 << 20;   // how much is read at a time looking further back
async function _directory(read, size) {
  const at = async (pos) => {
    const end = await read(pos, pos + 22);
    const ev = new DataView(end.buffer, end.byteOffset, end.byteLength);
    const count = ev.getUint16(10, true), cdSize = ev.getUint32(12, true), cdStart = ev.getUint32(16, true);
    if (cdStart + cdSize !== pos) return null;
    const cd = await read(cdStart, pos);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    for (let i = 0, p = 0; i < count && p + 46 <= cd.byteLength; i++) {
      if (cv.getUint32(p, true) !== 0x02014b50) return null;
      p += 46 + cv.getUint16(p + 28, true) + cv.getUint16(p + 30, true) + cv.getUint16(p + 32, true);
    }
    return { cd, count };
  };
  for (let to = size, from = Math.max(0, size - 22 - 0xffff); to > 0; to = from + 3, from = Math.max(0, to - 3 - LOOK_BACK)) {
    const piece = await read(from, to);
    const pv = new DataView(piece.buffer, piece.byteOffset, piece.byteLength);
    for (let i = Math.min(piece.byteLength - 4, size - 22 - from); i >= 0; i--) {
      if (pv.getUint32(i, true) !== END_RECORD) continue;
      const found = await at(from + i);
      if (found) return found;
    }
    if (from === 0) break;
  }
  return null;
}

// The SHA-256 of `data` in hex, or null where the browser offers no hashing.
export async function sha256Hex(data) {
  if (!globalThis.crypto?.subtle) return null;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// An archive's pictures in natural order by path, folder by folder, the extension not counting
// ("Ch 2/10.jpg" after "Ch 2/9.png", "Ch 10/" after "Ch 2/"). Hidden files and folders (".name",
// and the "__MACOSX" folder a Mac adds to the zips it makes) are left out.
export function sortImageEntries(entries) {
  const parts = (e) => e.filename.replace(/\.[^./\\]+$/, '').split(/[\\/]/);
  return entries
    .filter(e => /\.(jpe?g|png|webp|gif|avif)$/i.test(e.filename)
      && !e.filename.split(/[\\/]/).some(s => s.startsWith('.') || s === '__MACOSX'))
    .sort((a, b) => {
      const pa = parts(a), pb = parts(b);
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
        const c = pa[i].localeCompare(pb[i], undefined, { numeric: true, sensitivity: 'base' });
        if (c) return c;
      }
      return pa.length - pb.length;
    });
}


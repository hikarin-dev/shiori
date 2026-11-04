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

// A zip's entries, from its central directory (store + deflate entries) -> [{ filename, size, read,
// blob }]: read() resolves to the entry's bytes, blob(type) to a Blob of them — for an entry stored
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
  // The end record closes the zip, followed only by its comment (at most 64 KiB).
  const size = bytes ? bytes.byteLength : source.size;
  const tailAt = Math.max(0, size - 22 - 0xffff);
  const tail = await read(tailAt, size);
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) { if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd === -1) throw new CbzImportError('cbz_parse', 'Not a valid ZIP file');
  const count = tv.getUint16(eocd + 10, true);
  if (count > MAX_ZIP_ENTRIES) throw new CbzImportError('cbz_limits', `Archive has too many entries (${count}).`);
  const cd = await read(tv.getUint32(eocd + 16, true), tailAt + eocd);
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
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
    const entry = { filename, size, read: async () => {
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


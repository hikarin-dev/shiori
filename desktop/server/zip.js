// zip.js — the archives the library keeps: written store-only (pages are already compressed images),
// added to without writing again what they hold, read whatever wrote them (stored or deflated
// entries, ZIP64). A reader keeps an archive's central directory, not an open file, so an archive
// can always be replaced or moved while it is read. Entry names are read by the one rule both apps
// share (folder-content.js zipName), so an archive's titles are named alike in either.
import { disk } from './folder-store.js';
import zlib from 'node:zlib';
import { content } from './shared.js';

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

// A DOS date and time for `date`.
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// Each entry stored (not compressed) at `offset` through `write`, read one at a time when it names a
// file (`from`) or a way to read it (`read()`) rather than holding its bytes (`data`): its directory
// record's fields (with its `name`).
async function writeEntries(write, offset, entries) {
  const { time, day } = dosTime(new Date());
  const central = [];
  for (const { name, data: given, from, read } of entries) {
    const data = given ?? (read ? await read() : await disk.readFile(from));
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(45, 4);              // version needed (ZIP64 aware)
    header.writeUInt16LE(0x0800, 6);          // names are UTF-8
    header.writeUInt16LE(0, 8);               // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    central.push({ name, nameBytes, crc, method: 0, compressedSize: data.length, size: data.length, offset, time, day });
    offset = await write(header);
    offset = await write(nameBytes);
    offset = await write(data);
  }
  return central;
}

// The directory of `central` and the records ending the archive, written through `write` from
// `dirStart`. Offsets past 4 GB and more than 65 535 entries use ZIP64. Resolves where it ends.
async function writeDirectory(write, dirStart, central) {
  let offset = dirStart;
  for (const e of central) {
    const big = e.offset >= MAX32;
    const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
    if (big) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(e.offset), 4); }
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE(45, 4);
    rec.writeUInt16LE(45, 6);
    rec.writeUInt16LE(0x0800, 8);
    rec.writeUInt16LE(e.method, 10);
    rec.writeUInt16LE(e.time, 12);
    rec.writeUInt16LE(e.day, 14);
    rec.writeUInt32LE(e.crc, 16);
    rec.writeUInt32LE(e.compressedSize, 20);
    rec.writeUInt32LE(e.size, 24);
    rec.writeUInt16LE(e.nameBytes.length, 28);
    rec.writeUInt16LE(extra.length, 30);
    rec.writeUInt32LE(big ? MAX32 : e.offset, 42);
    offset = await write(rec);
    offset = await write(e.nameBytes);
    if (extra.length) offset = await write(extra);
  }
  const dirSize = offset - dirStart;
  const zip64 = central.length >= MAX16 || dirStart >= MAX32 || dirSize >= MAX32;
  if (zip64) {
    const end64At = offset;
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(central.length), 24);
    end64.writeBigUInt64LE(BigInt(central.length), 32);
    end64.writeBigUInt64LE(BigInt(dirSize), 40);
    end64.writeBigUInt64LE(BigInt(dirStart), 48);
    await write(end64);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(end64At), 8);
    locator.writeUInt32LE(1, 16);
    await write(locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(central.length, MAX16), 8);
  end.writeUInt16LE(Math.min(central.length, MAX16), 10);
  end.writeUInt32LE(Math.min(dirSize, MAX32), 12);
  end.writeUInt32LE(Math.min(dirStart, MAX32), 16);
  return write(end);
}

// What a write put in the archive: { entries: [[name, bytes]], structure } — each entry's own bytes,
// and the rest (its headers, the directory and the records ending it), for writes.js.
const written = (added, from, to) => {
  const entries = added.map(e => [e.name, e.size]);
  return { entries, structure: to - from - entries.reduce((sum, [, bytes]) => sum + bytes, 0) };
};

// A writer at `offset` in an open file: write(bytes) resolves the offset after them.
function writerAt(handle, offset) {
  return async (bytes) => { await handle.write(bytes, 0, bytes.length, offset); offset += bytes.length; return offset; };
}

// Write `entries` ([{ name, data: Uint8Array }, { name, from: path } or { name, read }]) to the file at `file` as
// one store-only archive, flushed to the disk. Names are UTF-8. Resolves what it wrote (`written`).
export async function writeZip(file, entries) {
  const handle = await disk.open(file, 'w');
  try {
    let end = 0;
    const write = writerAt(handle, 0);
    const central = await writeEntries(async (bytes) => (end = await write(bytes)), 0, entries);
    const total = await writeDirectory(write, end, central);
    await handle.sync();
    return written(central, 0, total);
  } finally {
    await handle.close();
  }
}

// `entries` (as writeZip's) added to the archive at `file`, replacing those of the same names, and
// the entries named in `drop` left out — written after everything already in it, with a directory
// of its own: nothing already in the archive is written again (an entry replaced stays behind as
// unused bytes). Readers find the archive's last directory, so until this one is complete the
// archive reads as it was; the caller keeps the length it had, to cut back to after an interruption.
// Resolves what it wrote (`written`).
export async function appendZip(file, entries, { drop = [] } = {}) {
  const old = await readDirectory(file);
  const handle = await disk.open(file, 'r+');
  try {
    const { size } = await handle.stat();
    let end = size;
    const write = writerAt(handle, size);
    const added = await writeEntries(async (bytes) => (end = await write(bytes)), size, entries);
    const gone = new Set([...drop, ...entries.map(e => e.name)]);
    const kept = [...old].filter(([name]) => !gone.has(name)).map(([name, e]) => ({
      nameBytes: Buffer.from(name, 'utf8'), crc: e.crc, method: e.method, compressedSize: e.compressedSize, size: e.size,
      offset: e.headerOffset, ...dosTime(new Date()) }));
    const total = await writeDirectory(write, end, [...kept, ...added]);
    await handle.sync();
    return written(added, size, total);
  } finally {
    await handle.close();
  }
}

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

// An archive's entries: Map name → { method, compressedSize, size, headerOffset, crc }. Its end record
// is looked for in its last 64 KiB (it ends the archive, followed only by a comment), the last one there
// that reads as an archive's; when none does, further back, a piece at a time: an addition cut short
// (appendZip: its entries written, not yet its directory) leaves the previous directory and end record
// whole before them, and that previous generation is what the archive holds (F3). The same rule as the
// website's reader (zip-read.js zipEntries).
export async function readDirectory(file) { return (await lastDirectory(file)).entries; }
// Where the archive at `file`, as readDirectory reads it, ends: the end of the end record its directory
// is read from, comment included. Less than its length when what follows is no part of it (an addition
// cut short, which readers pass over).
export async function directoryEnd(file) { return (await lastDirectory(file)).end; }
const END = 0x06054b50;
const BACK = 1 << 20;   // how much is read at a time looking further back
async function lastDirectory(file) {
  const handle = await disk.open(file, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const tailLength = Math.min(fileSize, 22 + MAX16);
    for (let to = fileSize, from = fileSize - tailLength; to > 0; to = from + 3, from = Math.max(0, to - 3 - BACK)) {
      const piece = await readAt(handle, from, to - from);
      for (let i = Math.min(piece.length - 4, fileSize - 22 - from); i >= 0; i--) {
        if (piece.readUInt32LE(i) !== END) continue;
        const found = await directoryAt(handle, from + i);
        if (found) return found;
      }
      if (from === 0) break;
    }
    throw new Error('not a zip archive');
  } finally {
    await handle.close();
  }
}
// The directory the end record at `at` describes, read, as { entries, end: where the record ends } —
// null when it doesn't read as an archive's directory: one that doesn't end where the record (or its
// ZIP64 record) starts, or a record of it that isn't one (an end record's signature that happens to be
// in an entry's bytes).
async function directoryAt(handle, at) {
  const from = Math.max(0, at - 20);
  const head = await readAt(handle, from, at + 22 - from);
  const end = head.subarray(at - from);
  let count = end.readUInt16LE(10);
  let dirSize = end.readUInt32LE(12);
  let dirStart = end.readUInt32LE(16);
  let dirEnd = at;
  if (at - from === 20 && head.readUInt32LE(0) === 0x07064b50) {
    const end64At = Number(head.readBigUInt64LE(8));
    const end64 = await readAt(handle, end64At, 56);
    if (end64.length === 56 && end64.readUInt32LE(0) === 0x06064b50) {
      count = Number(end64.readBigUInt64LE(32));
      dirSize = Number(end64.readBigUInt64LE(40));
      dirStart = Number(end64.readBigUInt64LE(48));
      dirEnd = end64At;
    }
  }
  if (dirStart + dirSize !== dirEnd) return null;
  const dir = await readAt(handle, dirStart, dirSize);
  const entries = new Map();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= dir.length; i++) {
    if (dir.readUInt32LE(p) !== 0x02014b50) return null;
    const flags = dir.readUInt16LE(p + 8);
    const method = dir.readUInt16LE(p + 10);
    const crc = dir.readUInt32LE(p + 16);
    let compressedSize = dir.readUInt32LE(p + 20);
    let size = dir.readUInt32LE(p + 24);
    const nameLength = dir.readUInt16LE(p + 28);
    const extraLength = dir.readUInt16LE(p + 30);
    const commentLength = dir.readUInt16LE(p + 32);
    let headerOffset = dir.readUInt32LE(p + 42);
    const nameBytes = dir.subarray(p + 46, p + 46 + nameLength);
    const name = content.zipName(nameBytes, (flags & 0x0800) !== 0);
    // ZIP64 sizes and offset, in that order, for the fields that overflowed.
    let e = p + 46 + nameLength;
    const extraEnd = e + extraLength;
    while (e + 4 <= extraEnd) {
      const id = dir.readUInt16LE(e), len = dir.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === MAX32) { size = Number(dir.readBigUInt64LE(q)); q += 8; }
        if (compressedSize === MAX32) { compressedSize = Number(dir.readBigUInt64LE(q)); q += 8; }
        if (headerOffset === MAX32) { headerOffset = Number(dir.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    if (!name.endsWith('/')) entries.set(name, { method, compressedSize, size, headerOffset, crc });
    p = extraEnd + commentLength;
  }
  return { entries, end: at + 22 + end.readUInt16LE(20) };
}

// One entry's bytes, from an entry of readDirectory's.
export async function readEntry(file, entry) {
  const handle = await disk.open(file, 'r');
  try {
    const local = await readAt(handle, entry.headerOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('damaged zip entry');
    const start = entry.headerOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const raw = await readAt(handle, start, entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`zip method ${entry.method} is not supported`);
  } finally {
    await handle.close();
  }
}

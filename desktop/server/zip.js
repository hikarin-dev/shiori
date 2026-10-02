// zip.js — the archives the library keeps: written store-only (pages are already compressed images),
// read whatever wrote them (stored or deflated entries, ZIP64). A reader keeps an archive's central
// directory, not an open file, so an archive can always be replaced or moved while it is read.
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

// A DOS date and time for `date`.
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// Write `entries` ([{ name, data: Uint8Array }]) to the file at `file` as one store-only archive.
// Names are UTF-8; offsets past 4 GB and more than 65 535 entries use ZIP64.
export async function writeZip(file, entries) {
  const handle = await fsp.open(file, 'w');
  try {
    const { time, day } = dosTime(new Date());
    const central = [];
    let offset = 0;
    const write = async (bytes) => { await handle.write(bytes, 0, bytes.length, offset); offset += bytes.length; };
    for (const { name, data } of entries) {
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
      central.push({ nameBytes, crc, size: data.length, offset });
      await write(header);
      await write(nameBytes);
      await write(data);
    }
    const dirStart = offset;
    for (const e of central) {
      const big = e.offset >= MAX32;
      const extra = big ? Buffer.alloc(12) : Buffer.alloc(0);
      if (big) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(e.offset), 4); }
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(0x02014b50, 0);
      rec.writeUInt16LE(45, 4);
      rec.writeUInt16LE(45, 6);
      rec.writeUInt16LE(0x0800, 8);
      rec.writeUInt16LE(0, 10);
      rec.writeUInt16LE(time, 12);
      rec.writeUInt16LE(day, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(e.size, 20);
      rec.writeUInt32LE(e.size, 24);
      rec.writeUInt16LE(e.nameBytes.length, 28);
      rec.writeUInt16LE(extra.length, 30);
      rec.writeUInt32LE(big ? MAX32 : e.offset, 42);
      await write(rec);
      await write(e.nameBytes);
      if (extra.length) await write(extra);
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
    await write(end);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

// An archive's entries: Map name → { method, compressedSize, size, headerOffset, crc }.
export async function readDirectory(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const tailLength = Math.min(fileSize, 22 + MAX16);
    const tail = await readAt(handle, fileSize - tailLength, tailLength);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
    if (at < 0) throw new Error('not a zip archive');
    let count = tail.readUInt16LE(at + 10);
    let dirSize = tail.readUInt32LE(at + 12);
    let dirStart = tail.readUInt32LE(at + 16);
    if (at >= 20 && tail.readUInt32LE(at - 20) === 0x07064b50) {
      const end64 = await readAt(handle, Number(tail.readBigUInt64LE(at - 20 + 8)), 56);
      if (end64.readUInt32LE(0) === 0x06064b50) {
        count = Number(end64.readBigUInt64LE(32));
        dirSize = Number(end64.readBigUInt64LE(40));
        dirStart = Number(end64.readBigUInt64LE(48));
      }
    }
    const dir = await readAt(handle, dirStart, dirSize);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= dir.length; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
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
      const name = (flags & 0x0800) ? nameBytes.toString('utf8') : nameBytes.toString('latin1');
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
    return entries;
  } finally {
    await handle.close();
  }
}

// One entry's bytes, from an entry of readDirectory's.
export async function readEntry(file, entry) {
  const handle = await fsp.open(file, 'r');
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

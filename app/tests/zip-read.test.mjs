// zip-read.test.mjs — how an archive read in place names its entries: by folder-content.js zipName,
// the one rule both apps decode by, so a linked archive's chapters keep their identity (`inner`)
// whichever app reads them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipEntries } from '../js/zip-read.js';

// A zip of stored entries ({ name: bytes, data: bytes, utf8: whether its flag says UTF-8 }), built by
// hand so the name bytes and the flag are exactly as given.
function zipOf(entries) {
  const parts = [], central = [];
  let at = 0;
  for (const e of entries) {
    const flags = e.utf8 ? 0x0800 : 0;
    const local = new Uint8Array(30 + e.name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(6, flags, true);
    lv.setUint32(18, e.data.length, true); lv.setUint32(22, e.data.length, true); lv.setUint16(26, e.name.length, true);
    local.set(e.name, 30);
    const head = new Uint8Array(46 + e.name.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x02014b50, true); hv.setUint16(8, flags, true);
    hv.setUint32(20, e.data.length, true); hv.setUint32(24, e.data.length, true); hv.setUint16(28, e.name.length, true);
    hv.setUint32(42, at, true);
    head.set(e.name, 46);
    parts.push(local, e.data);
    central.push(head);
    at += local.length + e.data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, at, true);
  const out = new Uint8Array(at + size + 22);
  let pos = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, pos); pos += p.length; }
  return out;
}

test('A08: an entry named in UTF-8 without its flag reads as UTF-8; one that isn\'t UTF-8 reads as code page 437', async () => {
  const utf8 = new TextEncoder().encode('第1話/1.png');
  const flagged = new TextEncoder().encode('第2話/1.png');
  const cp437 = new Uint8Array([0x82, 0x2f, 0x31, 0x2e, 0x70, 0x6e, 0x67]);   // "é/1.png" as code page 437 writes it
  const data = new Uint8Array([1, 2, 3]);
  const names = (await zipEntries(zipOf([{ name: utf8, data }, { name: flagged, data, utf8: true }, { name: cp437, data }]))).map(e => e.filename);
  assert.deepEqual(names, ['第1話/1.png', '第2話/1.png', 'é/1.png']);
});

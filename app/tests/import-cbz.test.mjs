// import-cbz.test.mjs — an invalid archive must throw a typed error (never look like success),
// and it must fail before any database write: these tests run without an indexedDB global and
// assert it stays undefined, proving the failure paths cannot have touched the library.
import test from 'node:test';
import assert from 'node:assert/strict';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const { importCbzBuffer, CbzImportError } = await import('../js/import-cbz.js');

const enc = new TextEncoder();

// Minimal store-method zip: enough structure for unzip's central-directory walk (CRCs unused).
function buildZip(entries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(10, 0, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of parts) { out.set(c, p); p += c.length; }
  return out.buffer;
}

test('a corrupt buffer rejects with a typed parse error and touches no data', async () => {
  await assert.rejects(
    importCbzBuffer('1', new ArrayBuffer(64), 'x.cbz', true),
    (e) => e instanceof CbzImportError && e.code === 'cbz_parse');
  assert.equal(globalThis.indexedDB, undefined);
});

test('an archive with no images rejects instead of reporting success', async () => {
  const zip = buildZip([{ name: 'readme.txt', data: enc.encode('hello') }]);
  const seen = [];
  await assert.rejects(
    importCbzBuffer('1', zip, 'x.cbz', true, (p) => seen.push(p.status)),
    (e) => e instanceof CbzImportError && e.code === 'cbz_empty');
  assert.ok(!seen.includes('done'), 'no done status may be reported for a failed import');
  assert.equal(globalThis.indexedDB, undefined);
});

test('an absurd entry count rejects before the directory walk', async () => {
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(10, 25000, true);
  await assert.rejects(
    importCbzBuffer('1', eocd.buffer, 'x.cbz', true),
    (e) => e instanceof CbzImportError && e.code === 'cbz_limits');
});

test('duplicate page numbers reject before any write', async () => {
  const zip = buildZip([
    { name: 'image_records.json', data: enc.encode('{}') },
    { name: 'images/1.jpg', data: enc.encode('a') },
    { name: 'images/01.png', data: enc.encode('b') },
  ]);
  await assert.rejects(
    importCbzBuffer('1', zip, 'x.cbz', true),
    (e) => e instanceof CbzImportError && e.code === 'cbz_duplicate_pages');
  assert.equal(globalThis.indexedDB, undefined);
});

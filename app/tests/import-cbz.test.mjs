// import-cbz.test.mjs — an invalid archive must throw a typed error (never look like success),
// and it must fail before any database write: these tests run without an indexedDB global and
// assert it stays undefined, proving the failure paths cannot have touched the library. A zip is
// read from whatever holds its bytes, a view of a larger buffer included.
import test from 'node:test';
import assert from 'node:assert/strict';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const { importCbzBuffer, CbzImportError, unzip } = await import('../js/import-cbz.js');

const enc = new TextEncoder();

// Minimal zip: enough structure for unzip's central-directory walk (CRCs and uncompressed sizes
// unused). An entry's `data` is held as it is: stored, or already deflated when `method` is 8.
function buildZip(entries) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data, method = 0 } of entries) {
    const nameBytes = enc.encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(10, method, true);
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

test('a zip handed over as a view of a larger buffer is read from where the view starts', async () => {
  const zip = new Uint8Array(buildZip([{ name: 'a.jpg', data: enc.encode('page') }]));
  const larger = new Uint8Array(zip.length + 16);
  larger.set(zip, 8);
  const entries = await unzip(larger.subarray(8, 8 + zip.length));
  assert.deepEqual(entries.map((e) => [e.filename, new TextDecoder().decode(e.data)]), [['a.jpg', 'page']]);
});

// A file too big to read into one buffer, as the browser has it past 2 GiB: read whole, it fails;
// its pieces read.
class TooBigToReadWhole extends File {
  arrayBuffer() { return Promise.reject(new DOMException('The requested file could not be read.', 'NotReadableError')); }
}
const deflate = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());

test('a zip handed over as a file is read a piece at a time, stored and deflated entries alike', async () => {
  const zip = buildZip([
    { name: 'Ch 1/', data: new Uint8Array() },
    { name: 'Ch 1/1.jpg', data: enc.encode('stored page') },
    { name: 'Ch 1/2.jpg', data: await deflate(enc.encode('deflated page '.repeat(50))), method: 8 },
  ]);
  const read = async (source) => (await unzip(source)).map((e) => [e.filename, new TextDecoder().decode(e.data)]);
  const expected = [['Ch 1/1.jpg', 'stored page'], ['Ch 1/2.jpg', 'deflated page '.repeat(50)]];
  assert.deepEqual(await read(zip), expected);
  assert.deepEqual(await read(new TooBigToReadWhole([zip], 'big.zip')), expected);
});

test('a file that is not a zip, or one cut short, rejects with a typed parse error', async () => {
  await assert.rejects(unzip(new TooBigToReadWhole([new Uint8Array(64)], 'x.zip')),
    (e) => e instanceof CbzImportError && e.code === 'cbz_parse');
  // An entry whose local header points past the end of the file.
  const zip = new Uint8Array(buildZip([{ name: 'a.jpg', data: enc.encode('page') }]));
  new DataView(zip.buffer).setUint32(zip.length - 22 - 46 - 5 + 42, 1 << 20, true);
  await assert.rejects(unzip(new TooBigToReadWhole([zip], 'x.zip')),
    (e) => e instanceof CbzImportError && e.code === 'cbz_parse');
});

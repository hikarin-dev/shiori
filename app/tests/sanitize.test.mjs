// sanitize.test.mjs — the XSS gates: escaping, id format, external-URL constraint, and the
// import boundaries that enforce them. Backup fixtures with markup ids must be rejected before
// any database write — asserted by running without an indexedDB global, which stays undefined.
import test from 'node:test';
import assert from 'node:assert/strict';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const { escHtml, isValidGalleryId, safeExternalUrl } = await import('../js/sanitize.js');
const { importBackup } = await import('../js/backup.js');

test('escHtml neutralizes markup metacharacters', () => {
  assert.equal(escHtml('"><img src=x onerror=alert(1)>'),
    '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escHtml('a & b'), 'a &amp; b');
  assert.equal(escHtml(null), '');
});

test('isValidGalleryId accepts only bounded digit strings', () => {
  assert.ok(isValidGalleryId('123'));
  assert.ok(isValidGalleryId('1753900000000'));
  assert.ok(!isValidGalleryId(''));
  assert.ok(!isValidGalleryId('12a'));
  assert.ok(!isValidGalleryId('"><svg onload=alert(1)>'));
  assert.ok(!isValidGalleryId('1'.repeat(20)));
  assert.ok(!isValidGalleryId(null));
});

test('safeExternalUrl allows only credential-free http(s)', () => {
  assert.equal(safeExternalUrl('https://example.com/g/1'), 'https://example.com/g/1');
  assert.equal(safeExternalUrl('http://example.com/'), 'http://example.com/');
  assert.equal(safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(safeExternalUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeExternalUrl('file:///etc/passwd'), null);
  assert.equal(safeExternalUrl('https://user:pass@example.com/'), null);
  assert.equal(safeExternalUrl('not a url'), null);
  assert.equal(safeExternalUrl(''), null);
});

test('a .shi backup with markup ids is rejected before any write', async () => {
  const payload = [{ galleryId: '"><img src=x onerror=alert(1)>', title: 'x' }];
  const file = new File([JSON.stringify(payload)], 'evil.shi', { type: 'application/json' });
  await assert.rejects(importBackup(file), /invalid gallery id/i);
  assert.equal(globalThis.indexedDB, undefined);
});

test('a .shi backup with a markup chapter reference is rejected', async () => {
  const payload = [{ galleryId: '123', chapters: [{ id: '1"><script>' }, { id: '2' }] }];
  const file = new File([JSON.stringify(payload)], 'evil.shi', { type: 'application/json' });
  await assert.rejects(importBackup(file), /invalid gallery id/i);
  assert.equal(globalThis.indexedDB, undefined);
});

function fullArchive(manifest) {
  const body = new TextEncoder().encode(JSON.stringify(manifest));
  const footer = new Uint8Array(4);
  new DataView(footer.buffer).setUint32(0, body.length, true);
  return new File([body, footer], 'evil.shioridb');
}

test('a .shioridb manifest with markup ids is rejected before any write', async () => {
  const file = fullArchive({
    format: 'shiori-db', version: 7, counts: {},
    images: [], covers: [], sourceIcons: [],
    metadata: [{ galleryId: '"><svg onload=alert(1)>' }], galleries: [],
  });
  await assert.rejects(importBackup(file), /invalid gallery id/i);
  assert.equal(globalThis.indexedDB, undefined);
});

test('a .shioridb blob slice outside the file bounds is rejected', async () => {
  const file = fullArchive({
    format: 'shiori-db', version: 7, counts: {},
    images: [{ url: 'local://1/1.jpg', galleryId: '1', body: { off: 0, len: 99999999 } }],
    covers: [], sourceIcons: [], metadata: [], galleries: [],
  });
  await assert.rejects(importBackup(file), /out of bounds/i);
  assert.equal(globalThis.indexedDB, undefined);
});

test('a truncated .shioridb (bad manifest length) is rejected', async () => {
  const footer = new Uint8Array(4);
  new DataView(footer.buffer).setUint32(0, 5000, true);
  const file = new File([new Uint8Array(10), footer], 'evil.shioridb');
  await assert.rejects(importBackup(file));
  assert.equal(globalThis.indexedDB, undefined);
});

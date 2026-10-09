// backup-settings.test.mjs — the settings a full backup carries: only preferences that may follow a
// library to another device (an allowlist, applied when a backup is made and when one is restored,
// so an older backup that carried this device's connections can't plant them); the translation
// settings without their server; restored last, merged into this device's. Archives from a newer
// app version are refused before any write. And every setting the app stores has been decided:
// portable, or this device's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'fake-indexeddb/auto';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;

const _store = new Map();
globalThis.localStorage = {
  getItem: (k) => (_store.has(k) ? _store.get(k) : null),
  setItem: (k, v) => _store.set(k, String(v)),
  removeItem: (k) => _store.delete(k),
};
const { importBackup } = await import('../js/backup.js');
const { PORTABLE_SETTINGS, PORTABLE_DASH_SETTINGS, snapshotSettings, restoreSettings, portableSettings } = await import('../js/backup-core.js');

function archive(manifest) {
  const body = new TextEncoder().encode(JSON.stringify(manifest));
  const footer = new Uint8Array(4);
  new DataView(footer.buffer).setUint32(0, body.length, true);
  return new File([body, footer], 'backup.shioridb');
}

const emptyArchive = (extra) => ({
  format: 'shiori-db', version: 8, counts: {},
  images: [], covers: [], sourceIcons: [], metadata: [], galleries: [], ...extra,
});

test('restore applies the portable settings section and nothing of another device', async () => {
  _store.clear();
  localStorage.setItem('shiori:translateSettings', JSON.stringify({ schema: 3, params: { a: 1 }, serverUrl: 'http://127.0.0.1:5003', serverToken: 'mine' }));
  localStorage.setItem('shiori:libraryLocation', '{"kind":"browser"}');
  const file = archive(emptyArchive({
    settings: {
      kv: {
        translateSettings: JSON.stringify({ schema: 3, params: { a: 2, b: 'x' }, saveSnapshots: true, serverUrl: 'http://evil', serverToken: 'theirs' }),
        agentPairSecret: '"stolen"', libraryLocation: '{"kind":"desktop","url":"http://evil","token":"t"}',
        moveJournal: '{"token":"t","done":["1"]}', relayScope: '"scope"', libraryFallback: '{"since":1}',
        apiKey: '"secret"', translateCapabilities: '{}', restoreJournal: '{"id":"x","done":[]}',
        libMergeSeries: 'false', readerView: '"study"',
      },
      dash: { 'shiori-lang': 'ja', 'shiori-evil': '1' },
    },
  }));
  const result = await importBackup(file);
  assert.deepEqual(result.settings.failed, []);
  const ts = JSON.parse(localStorage.getItem('shiori:translateSettings'));
  assert.deepEqual(ts.params, { a: 2, b: 'x' }, 'the portable translation choices come with the backup');
  assert.equal(ts.saveSnapshots, true);
  assert.equal(ts.serverUrl, 'http://127.0.0.1:5003', "this device's translation server stays");
  assert.equal(ts.serverToken, 'mine');
  for (const key of ['agentPairSecret', 'moveJournal', 'relayScope', 'libraryFallback', 'apiKey', 'translateCapabilities', 'restoreJournal']) {
    assert.equal(localStorage.getItem(`shiori:${key}`), null, `${key} never restores`);
  }
  assert.equal(localStorage.getItem('shiori:libraryLocation'), '{"kind":"browser"}', 'which library this device uses is its own');
  assert.equal(localStorage.getItem('shiori:libMergeSeries'), 'false');
  assert.equal(localStorage.getItem('shiori:readerView'), '"study"');
  assert.equal(localStorage.getItem('shiori-lang'), 'ja');
  assert.equal(localStorage.getItem('shiori-evil'), null, 'unknown dash keys are dropped');
});

test('a translation server is never put in a backup, nor restored onto a device that has none', () => {
  _store.clear();
  localStorage.setItem('shiori:translateSettings', JSON.stringify({ schema: 3, params: { a: 1 }, serverUrl: 'http://127.0.0.1:5003', serverToken: 'tok' }));
  localStorage.setItem('shiori:libraryLocation', '{"kind":"desktop","url":"http://127.0.0.1:47153","token":"t"}');
  localStorage.setItem('shiori-lang', 'de');
  const snap = snapshotSettings(localStorage);
  assert.deepEqual(JSON.parse(snap.kv.translateSettings), { schema: 3, params: { a: 1 } });
  assert.equal(snap.kv.libraryLocation, undefined);
  assert.deepEqual(snap.dash, { 'shiori-lang': 'de' });
  _store.clear();
  restoreSettings({ kv: { translateSettings: JSON.stringify({ schema: 3, params: { a: 1 }, serverUrl: 'http://x' }) } }, localStorage);
  assert.deepEqual(JSON.parse(localStorage.getItem('shiori:translateSettings')), { schema: 3, params: { a: 1 } });
});

test('settings that are not strings, too large or unparseable are left out', () => {
  const out = portableSettings({ kv: { readerView: 5, readerMode: 'x'.repeat(300 * 1024), translateSettings: '{not json', libFilter: '{}' }, dash: { 'shiori-lang': 7 } });
  assert.deepEqual(out, { kv: { libFilter: '{}' }, dash: {} });
});

test('a setting that cannot be stored is reported, the others still land', () => {
  const failing = { getItem: () => null, setItem: (k) => { if (k === 'shiori:readerView') throw new Error('quota'); } };
  const out = restoreSettings({ kv: { readerView: '"text"', readerMode: '"strip"' } }, failing);
  assert.deepEqual(out, { restored: 1, failed: ['shiori:readerView'] });
});

test('archives from a newer app version are refused', async () => {
  await assert.rejects(importBackup(archive(emptyArchive({ version: 99 }))), { code: 'newer' });
});

test('older archives without a settings section still restore', async () => {
  const manifest = emptyArchive({ version: 7 });
  delete manifest.settings;
  await importBackup(archive(manifest));   // must not throw
});

// Every setting the app stores (shiori:<name> through platform.kv or directly) is either listed as
// portable in backup-core.js or here as this device's own — a new one has to be decided.
const DEVICE_SETTINGS = new Set([
  'libraryLocation', 'libraryFallback', 'moveJournal', 'relayScope', 'restoreJournal',   // which library, how it is reached
  'translateCapabilities', 'translationBenchmarkReport', 'translationBenchmarkStarts',     // caches and measurements of this device
  'schemaSteps', 'countsRepaired', 'seriesShellStatsRepaired', 'uploadDateBackfilled', 'storageLayout', 'totalWrittenBytes',
  'agentPairSecret', 'apiKey', 'cacheEnabled',                                             // pairing and an integration's own state
]);
const DEVICE_DASH = new Set(['shiori-ext-status', 'shiori-font', 'shiori-covers', 'shiori-sw-retry']);

function storedKeys() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
  const kv = new Set(), dash = new Set();
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    const consts = new Map([...src.matchAll(/const\s+(\w+)\s*=\s*'([\w:-]+)'/g)].map(m => [m[1], m[2].replace(/^shiori:/, '')]));
    for (const m of src.matchAll(/'shiori:(\w+)'/g)) kv.add(m[1]);
    for (const m of src.matchAll(/kv\.get\(\[([^\]]*)\]/g)) for (const k of m[1].matchAll(/'(\w+)'/g)) kv.add(k[1]);
    for (const m of src.matchAll(/kv\.get\((\w+)\)/g)) if (consts.has(m[1])) kv.add(consts.get(m[1]));
    for (const m of src.matchAll(/kv\.set\(\{/g)) {
      // The object literal's own keys (depth 0): `name:`, a shorthand `name`, or `[CONST]:`.
      let depth = 0, token = '', inValue = false;
      const key = () => { if (!inValue && /^\w+$/.test(token.trim())) kv.add(token.trim()); token = ''; };
      for (let i = m.index + m[0].length; i < src.length; i++) {
        const c = src[i];
        if ('{[('.includes(c)) {
          if (depth === 0 && c === '[' && !inValue) { const id = src.slice(i + 1, src.indexOf(']', i)).trim(); if (consts.has(id)) kv.add(consts.get(id)); }
          depth++;
          continue;
        }
        if ('}])'.includes(c)) { if (depth === 0) { key(); break; } depth--; continue; }
        if (depth > 0) continue;
        if (c === ':') { key(); inValue = true; continue; }
        if (c === ',') { key(); inValue = false; continue; }
        if (!inValue) token += c;
      }
    }
    for (const m of src.matchAll(/(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\('(shiori-[\w-]+)'/g)) dash.add(m[1]);
  }
  for (const k of [...kv]) if (!/^[a-z]\w*$/i.test(k)) kv.delete(k);
  return { kv, dash };
}

test('every setting the app stores is either portable or this device\'s own', () => {
  const { kv, dash } = storedKeys();
  assert.ok(kv.has('readerView') && kv.has('libraryLocation'), 'the scan finds settings');
  const undecided = [...kv].filter(k => !PORTABLE_SETTINGS.has(k) && !DEVICE_SETTINGS.has(k));
  assert.deepEqual(undecided, [], 'list each in backup-core.js PORTABLE_SETTINGS or in DEVICE_SETTINGS here');
  const undecidedDash = [...dash].filter(k => !PORTABLE_DASH_SETTINGS.includes(k) && !DEVICE_DASH.has(k));
  assert.deepEqual(undecidedDash, []);
  for (const k of PORTABLE_SETTINGS) assert.ok(!DEVICE_SETTINGS.has(k), `${k} can't be both`);
});

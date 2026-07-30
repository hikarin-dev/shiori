// backup-settings.test.mjs — a v8 full archive round-trips the settings section (applied last,
// with the pairing capability and unknown dash keys filtered), and archives from a newer app
// version are refused before any write.
import test from 'node:test';
import assert from 'node:assert/strict';
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

test('restore applies the settings section, filtering protected keys', async () => {
  const file = archive(emptyArchive({
    settings: {
      kv: { translateSettings: '{"serverUrl":"http://x"}', agentPairSecret: '"stolen"' },
      dash: { 'shiori-lang': 'ja', 'shiori-evil': '1' },
    },
  }));
  await importBackup(file);
  assert.equal(localStorage.getItem('shiori:translateSettings'), '{"serverUrl":"http://x"}');
  assert.equal(localStorage.getItem('shiori:agentPairSecret'), null, 'the pairing capability must never restore');
  assert.equal(localStorage.getItem('shiori-lang'), 'ja');
  assert.equal(localStorage.getItem('shiori-evil'), null, 'unknown dash keys are dropped');
});

test('archives from a newer app version are refused', async () => {
  await assert.rejects(importBackup(archive(emptyArchive({ version: 99 }))), /newer app version/);
});

test('older archives without a settings section still restore', async () => {
  const manifest = emptyArchive({ version: 7 });
  delete manifest.settings;
  await importBackup(archive(manifest));   // must not throw
});

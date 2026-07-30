// jobs-durability.test.mjs — a submitted job is durable BEFORE any runner touches it (closing
// the tab in the handoff gap must not lose it), and terminal failures are retained in the
// registry so an error produced with zero open listeners is still visible on the next open.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

class SilentBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}
globalThis.BroadcastChannel = SilentBroadcastChannel;
// A runner that never finishes: the staged-file read hangs, so the pending row must stay put.
Object.defineProperty(globalThis, 'navigator', {
  value: { storage: { getDirectory: () => new Promise(() => {}) } },
  configurable: true,
});

const platform = await import('../js/platform.js');
const { submitJob } = await import('../js/submit-job.js');

test('submitJob writes the durable replay row before reporting a route', async () => {
  const routed = await submitJob('upload', { galleryId: '77', tempFile: 'x.bin', filename: 'x.cbz', skipExisting: true });
  assert.equal(routed, 'tab');
  const pending = await platform.jobsPending.all();
  assert.ok(pending.some((e) => e.key === '77:upload'), 'replay row must exist as soon as submit resolves');
});

test('unknown job kinds are refused without a durable write', async () => {
  const routed = await submitJob('nonsense', { galleryId: '1' });
  assert.equal(routed, null);
  const pending = await platform.jobsPending.all();
  assert.ok(!pending.some((e) => e.key === '1:nonsense'));
});

test('error rows are retained in the registry until acknowledged; done rows are not', async () => {
  await platform.jobs.publish({ gid: '9', kind: 'upload', status: 'error', error: 'boom' });
  let rows = await platform.jobs.current();
  const row = rows.find((r) => r.gid === '9' && r.kind === 'upload');
  assert.ok(row, 'an error must survive publish with no live listener');
  assert.equal(row.status, 'error');
  assert.equal(row.seen, false);

  await platform.jobs.clear('9', 'upload');   // the UI acknowledges after painting
  rows = await platform.jobs.current();
  assert.ok(!rows.some((r) => r.gid === '9' && r.kind === 'upload'));

  await platform.jobs.publish({ gid: '10', kind: 'upload', status: 'done' });
  rows = await platform.jobs.current();
  assert.ok(!rows.some((r) => r.gid === '10'), 'success rows vanish at publish');
});

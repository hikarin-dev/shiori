// jobs-relay.test.mjs — job status that reaches a page from a window of its desktop library on
// another origin (the relay) keeps this origin's registry as current as its own publications do. A
// download handed off from a site's page is reported back that way; its end must clear the row the
// page wrote at the hand-off, or every page opened next shows the job still contacting its helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
const platform = await import('../js/platform.js');

const row = async (gid) => (await platform.jobs.current()).find((r) => r.gid === gid && r.kind === 'download');

test('a relayed job end clears the row this origin wrote when it handed the job off', async () => {
  await platform.jobs.publish({ gid: '20', kind: 'download', status: 'started', labelKey: 'prog.contacting_helper' });
  await platform.jobs.receive({ gid: '20', kind: 'download', status: 'progress', done: 1, total: 3, at: Date.now() });
  assert.equal((await row('20'))?.status, 'progress', 'a page opened mid-download shows where it is');
  await platform.jobs.receive({ gid: '20', kind: 'download', status: 'done', at: Date.now() });
  assert.equal(await row('20'), undefined);
});

test('a relayed failure is kept for the next page, as a local one is', async () => {
  await platform.jobs.publish({ gid: '21', kind: 'download', status: 'started', labelKey: 'prog.contacting_helper' });
  await platform.jobs.receive({ gid: '21', kind: 'download', status: 'error', error: 'boom', at: Date.now() });
  const failed = await row('21');
  assert.equal(failed?.status, 'error');
  assert.equal(failed?.seen, false);
});

test('the hand-off is heard before a relayed status that follows it, however fast that comes', async () => {
  const heard = [];
  const off = platform.jobs.subscribe((j) => { if (j.gid === '22') heard.push(j.status); });
  const handoff = platform.jobs.publish({ gid: '22', kind: 'download', status: 'started', labelKey: 'prog.contacting_helper' });
  await platform.jobs.receive({ gid: '22', kind: 'download', status: 'done', at: Date.now() });
  await handoff;
  off();
  assert.deepEqual(heard, ['started', 'done']);
  assert.equal(await row('22'), undefined);
});

test('relayed signals reach listeners and are never written', async () => {
  const heard = [];
  const off = platform.jobs.subscribe((e) => heard.push(e.type));
  await platform.jobs.receive({ type: 'STOP_IMPORT', galleryId: '23' });
  off();
  assert.deepEqual(heard, ['STOP_IMPORT']);
  assert.ok(!(await platform.jobs.current()).some((r) => r.galleryId === '23' || r.gid === '23'));
});

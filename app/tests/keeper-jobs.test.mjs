// keeper-jobs.test.mjs — with the library in the desktop app, a translation is handed to the app
// itself (its runner keeps it going whatever the page does next): starting one goes there, a few
// pages asked for while the app translates that gallery are refused as busy, and a stop reaches it.
// Only meaningful against the desktop library (npm run test:desktop); skipped against this browser's.
import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

globalThis.BroadcastChannel = class { postMessage() {} close() {} };
// services.js pulls in the page-side bridge, which expects a window to listen on.
globalThis.window = { addEventListener() {}, removeEventListener() {}, postMessage() {} };
const desktop = !!globalThis.shioriDesktop;
const { submitJob } = await import('../js/submit-job.js');
const { services } = await import('../js/services.js');

test('a translation goes to the desktop app, busy is told, and a stop reaches it', { skip: !desktop && 'the desktop library only' }, async () => {
  const heard = [];
  let answer = { ok: true };
  globalThis.__keeperJobs = (op, kind, payload) => { heard.push([op, kind, payload]); return op === 'run' ? answer : { ok: true }; };
  try {
    const payload = { galleryId: '1790800000101', settings: { serverUrl: 'http://127.0.0.1:1' } };
    assert.equal(await submitJob('translate', payload), 'desktop');
    answer = { ok: false, busy: true };
    assert.equal(await submitJob('translate', { ...payload, pages: ['local://1790800000101/2.png'] }), 'busy');
    await services.handle({ type: 'CANCEL_TRANSLATE', galleryId: '1790800000101' });
    assert.deepEqual(heard.map(([op, kind]) => [op, kind]), [['run', 'translate'], ['run', 'translate'], ['stop', 'translate']]);
    assert.deepEqual(heard[0][2], payload);
    assert.deepEqual(heard[2][2], { galleryId: '1790800000101' });
  } finally { delete globalThis.__keeperJobs; }
});

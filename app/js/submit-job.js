// submit-job.js — route a job to the most durable runner available. With a controlling PWA
// service worker the job runs there and survives this tab closing; otherwise it runs in this tab
// and leaves a durable replay entry if the tab closes. Either way status broadcasts everywhere.
import { RUNNERS, cancelJobRun, runPoll } from './jobs-runner.js';
import * as platform from './platform.js';

// The active service worker, even when it isn't CONTROLLING this page. A hard reload
// (Ctrl+Shift+R) loads the document uncontrolled — controller is null for its whole life — but
// the worker is still registered and active, and it accepts messages all the same. Caching it
// here lets jobs run in the SW regardless, so a force reload no longer demotes a translation to
// the dying tab. (Best-effort: it fills in shortly after load; until then we fall back to the tab.)
let _swActive = null;
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.ready.then((reg) => { _swActive = reg.active; }).catch(() => {});
  try { navigator.serviceWorker.addEventListener('controllerchange', () => { _swActive = navigator.serviceWorker.controller || _swActive; }); } catch {}
}
function _sw() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;
  return navigator.serviceWorker.controller || _swActive || null;
}

const _tabRunning = new Set();
async function _runInTab(kind, payload, existingKey = null) {
  const run = RUNNERS[kind];
  const key = existingKey || `${payload && payload.galleryId}:${kind}`;
  if (!run) { if (existingKey) await platform.jobsPending.remove(existingKey); return; }
  if (_tabRunning.has(key)) return;
  _tabRunning.add(key);
  try {
    await platform.jobsPending.add({ key, kind, payload });
    await run(payload);
  } finally {
    _tabRunning.delete(key);
    const resume = kind === 'translate'
      ? await platform.translateResume.get(String(payload && payload.galleryId))
      : null;
    // A failed/interrupted start that still owns an upload claim must remain replayable.
    if (!resume || resume.phase !== 'uploading') await platform.jobsPending.remove(key);
  }
}

export function submitJob(kind, payload) {
  const sw = _sw();
  if (sw) { try { sw.postMessage({ __shioriJob: true, kind, payload }); return 'sw'; } catch {} }
  const run = RUNNERS[kind];
  if (run) { _runInTab(kind, payload); return 'tab'; }
  return null;
}

// Cancel a job. The abort handle lives in whichever context is running the job, so route
// the cancel the same way submitJob routed the work: to the SW if one controls this page,
// otherwise in-tab.
export function cancelJob(kind, payload) {
  const sw = _sw();
  if (sw) { try { sw.postMessage({ __shioriJobCancel: true, kind, payload }); return 'sw'; } catch {} }
  cancelJobRun(kind, payload);
  return 'tab';
}

let _pendingRecovery = null;
function _recoverPendingInTab(entries) {
  if (_pendingRecovery) return _pendingRecovery;
  _pendingRecovery = Promise.all((entries || []).map((entry) =>
    _runInTab(entry.kind, entry.payload, entry.key)
  )).finally(() => { _pendingRecovery = null; });
  return _pendingRecovery;
}

// Poll tick: collect the latest chunks for every in-flight translation and broadcast them. Prefer
// the service worker — one short __shioriPoll event keeps it warm (no single long event to hit the
// ~5-min cap) and it keeps running across navigations; fall back to polling in this tab when there's
// no worker. A cheap no-op when nothing is translating. Called on a short timer from boot.js, this
// is the heartbeat that drives a server-owned translation to completion and survives SW recycling.
export async function pollActiveTranslations() {
  let records = [];
  let pending = [];
  try { records = await platform.translateResume.all(); } catch {}
  try { pending = await platform.jobsPending.all(); } catch {}
  if (!records.length && !pending.length) return;
  const sw = _sw();
  if (sw) { try { sw.postMessage({ __shioriPoll: true }); return; } catch {} }
  if (pending.length) await _recoverPendingInTab(pending);
  await runPoll();   // no service worker — recover queued work and poll in this tab
}

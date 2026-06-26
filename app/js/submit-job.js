// submit-job.js — route a job to the most durable runner available. With a controlling PWA
// service worker the job runs there and survives this tab closing; otherwise it runs in this tab
// (works, but dies with the tab). Either way status broadcasts to every tab via platform.jobs.
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

export function submitJob(kind, payload) {
  const sw = _sw();
  if (sw) { try { sw.postMessage({ __shioriJob: true, kind, payload }); return 'sw'; } catch {} }
  const run = RUNNERS[kind];
  if (run) { run(payload); return 'tab'; }
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

// Poll tick: collect the latest chunks for every in-flight translation and broadcast them. Prefer
// the service worker — one short __shioriPoll event keeps it warm (no single long event to hit the
// ~5-min cap) and it keeps running across navigations; fall back to polling in this tab when there's
// no worker. A cheap no-op when nothing is translating. Called on a short timer from boot.js, this
// is the heartbeat that drives a server-owned translation to completion and survives SW recycling.
export async function pollActiveTranslations() {
  let records;
  try { records = await platform.translateResume.all(); } catch { return; }
  if (!records || !records.length) return;
  const sw = _sw();
  if (sw) { try { sw.postMessage({ __shioriPoll: true }); return; } catch {} }
  await runPoll();   // no service worker — poll in this tab
}

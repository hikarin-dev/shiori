// submit-job.js — route a job to the most durable runner available. With a controlling PWA
// service worker the job runs there and survives this tab closing; otherwise it runs in this tab
// (works, but dies with the tab). Either way status broadcasts to every tab via platform.jobs.
import { RUNNERS } from './jobs-runner.js';

export function submitJob(kind, payload) {
  const sw = (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller) || null;
  if (sw) { try { sw.postMessage({ __shioriJob: true, kind, payload }); return 'sw'; } catch {} }
  const run = RUNNERS[kind];
  if (run) { run(payload); return 'tab'; }
  return null;
}

// submit-job.js — route a job to the most durable runner available. With the library in the desktop
// app, a translation runs in the app itself (its runner page), which keeps it going whatever this page
// does next. With a controlling PWA service worker the job runs there and survives this tab closing;
// otherwise it runs in this tab and leaves a durable replay entry if the tab closes. Either way
// status broadcasts everywhere.
import { RUNNERS, cancelJobRun, runPoll } from './jobs-runner.js';
import * as platform from './platform.js';
import { capabilities, keeperJobs } from './api.js';

// The desktop app's runner itself routes nothing back to the app.
const _inDesktopRunner = platform.runner.kind === 'desktop-background';

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
  // The worker only knows this browser's library: a page using another library runs its jobs itself.
  if (!capabilities.browserLibrary) return null;
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

// Resolves where it went: 'desktop', 'sw' or 'tab' — or 'busy' when the desktop app is translating
// that gallery already (a few pages asked for meanwhile), or null for a kind nothing runs.
export async function submitJob(kind, payload) {
  if (!RUNNERS[kind]) return null;
  if (kind === 'translate' && !_inDesktopRunner) {
    const answer = await keeperJobs.run('translate', payload);
    if (answer?.ok) return 'desktop';
    if (answer?.busy) return 'busy';
  }
  const key = `${payload && payload.galleryId}:${kind}`;
  // Durable-first: the replay row is written HERE, before any handoff — so closing the tab in
  // the gap between the "started" reply and the runner's own (idempotent) re-add can no longer
  // lose the job. Recovery replays it: the SW's resumePending or the next tab's poll tick.
  await platform.jobsPending.add({ key, kind, payload });
  const sw = _sw();
  if (sw) { try { sw.postMessage({ __shioriJob: true, kind, payload }); return 'sw'; } catch {} }
  _runInTab(kind, payload, key);
  return 'tab';
}

// ── The desktop app's runner ──
// The desktop app keeps a page of its own open out of sight (runner.js), where an import a window
// hands over runs to the end whatever the window does meanwhile — goes to an overview or the
// reader, reloads, closes to the tray. The app is asked to open it (it answers once the page
// listens), the import goes over this channel, and the runner says it took it. Resolves false when
// there is no runner to take it: the caller imports it itself.
export const RUNNER_CHANNEL = 'shiori-runner';
const RUNNER_ANSWER_MS = 30000;   // the runner answers between steps of the import it is running
export async function handImport({ galleryId, group, skipExisting = true }) {
  const shell = globalThis.shioriDesktop?.shell;
  if (typeof shell !== 'function') return false;
  try { if (!await shell('runner')) return false; } catch { return false; }
  const id = crypto.randomUUID();
  const channel = new BroadcastChannel(RUNNER_CHANNEL);
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), RUNNER_ANSWER_MS);
      channel.onmessage = ({ data }) => { if (data?.type === 'taken' && data.id === id) { clearTimeout(timer); resolve(true); } };
      channel.postMessage({ type: 'import', id, galleryId: String(galleryId), skipExisting,
        group: { files: [...group.files], paths: group.paths, name: group.name, unreadable: group.unreadable } });
    });
  } finally { channel.close(); }
}

// A batch of titles (import-batch.js runImportBatch takes it) handed to the desktop app's runner
// whole, the same way: false when there is none, and this page runs it.
export async function handImportBatch({ id, name, groups, attachTo = null, meta = {} }) {
  const shell = globalThis.shioriDesktop?.shell;
  if (typeof shell !== 'function') return false;
  try { if (!await shell('runner')) return false; } catch { return false; }
  const channel = new BroadcastChannel(RUNNER_CHANNEL);
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), RUNNER_ANSWER_MS);
      channel.onmessage = ({ data }) => { if (data?.type === 'taken' && data.id === id) { clearTimeout(timer); resolve(true); } };
      channel.postMessage({ type: 'batch', id, batch: { id, name, attachTo, meta, groups: groups.map((g) => ({
        files: [...g.files], paths: g.paths, name: g.name, unreadable: g.unreadable, fromFolder: g.fromFolder })) } });
    });
  } finally { channel.close(); }
}

// A batch of titles (import-batch.js runImportBatch takes it) handed to this browser's service
// worker, which runs it for as long as any app page is open — each page's poll tick keeps it awake
// (pollActiveTranslations) — whatever the page it came from does. False when there is no worker, or
// it doesn't take it in time: this page runs it.
const WORKER_ANSWER_MS = 10000;
export const workerAvailable = () => !!_sw();
export function handBatchToWorker({ id, name, groups, attachTo = null, meta = {} }) {
  const sw = _sw();
  if (!sw) return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), WORKER_ANSWER_MS);
    channel.port1.onmessage = ({ data }) => { clearTimeout(timer); resolve(!!data?.taken); };
    try {
      sw.postMessage({ __shioriImportBatch: true, batch: { id, name, attachTo, meta, groups: groups.map((g) => ({
        files: [...g.files], paths: g.paths, name: g.name, unreadable: g.unreadable, fromFolder: g.fromFolder })) } }, [channel.port2]);
    } catch { clearTimeout(timer); resolve(false); }
  });
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
// is the heartbeat that drives a server-owned translation to completion and survives SW recycling
// — and that keeps the worker awake while it imports a batch (handBatchToWorker), from any page.
export async function pollActiveTranslations() {
  let records = [];
  let pending = [];
  try { records = await platform.translateResume.all(); } catch {}
  try { pending = await platform.jobsPending.all(); } catch {}
  if (!records.length && !pending.length && !await platform.jobs.workerImporting()) return false;   // idle — boot.js backs its timer off
  // A window of the desktop app keeps its jobs where the app's runner does: the runner collects
  // them (polled here too, every result would be stored twice).
  if (capabilities.desktopWindow && (await keeperJobs.run('poll'))?.ok) return true;
  const sw = _sw();
  if (sw) { try { sw.postMessage({ __shioriPoll: true }); return true; } catch {} }
  if (pending.length) await _recoverPendingInTab(pending);
  await runPoll();   // no service worker — recover queued work and poll in this tab
  return true;
}

// folder-scan.js — the work on a library folder that takes a while, as jobs the tasks page lists and
// can stop: checking a folder for galleries put in it outside the app (what adding a folder does
// after it is added, and "Check now") and what a folder removed from the library still owes it (its
// galleries moved elsewhere, everything the library has of them written there, the folder let go and
// forgotten). Kind 'folder', one per
// place (`folder-<id>`). A browser library's run where they are
// handed: in the service worker (sw.js), so they go on whatever page is open next, or — with none —
// in the page that asked; a removal cut short is carried on by the next page opened
// (resumeFolderWork). (The desktop app's run in the app itself and are announced the same way, by
// server/library.js.) Stop reaches them as a signal on the jobs channel (services.js STOP_JOB).
import * as platform from './platform.js';
import { folders } from './api.js';

export const folderJobId = (id) => `folder-${id}`;
const HEARTBEAT_MS = 5000;       // a running job says so this often, so a page keeps the worker awake
const WORKER_ANSWER_MS = 2000;   // how long the worker has to say it took a job
const _running = new Map();      // folder id → its run

// Whether a folder's job runs in this context now (the service worker stays awake while one does).
export const scanning = () => _running.size > 0;

// What each job does: its label, what its end says, how its progress names what it found ('' for
// nothing), and its work —
// `work(opts)` resolving { found, updated?, stopped } (`opts`: { onProgress(done, total, found, step?),
// stopped() }) — `updated`: galleries read again from the folder (another app changed them); `step`
// the label of the step under way, when the work goes in steps (its own count each).
const JOBS = {
  scan: ({ id, restored = 0 }) => ({ labelKey: 'lf.task_checking', doneKey: 'lf.task_done', found: restored,
    work: async ({ onProgress, stopped }) => {
      const r = await folders.scan(id, { stopped, onProgress: (done, total, added, step) => onProgress(done, total, added + restored, step) });
      return { found: r.added + restored, ...(r.updated ? { updated: r.updated } : {}), stopped: r.stopped };
    } }),
  remove: ({ id, moving = false }) => ({ labelKey: moving ? 'lf.task_moving' : 'lf.task_removing',
    doneKey: moving ? 'lf.task_moved' : 'lf.task_removed', foundKey: '', found: 0, work: setAside(id) }),
};
function setAside(id) {
  return async ({ onProgress, stopped }) => {
    const r = await folders.setAside(id, { stopped, onProgress: (done, total) => onProgress(done, total, done) });
    return { found: r.removed, stopped: r.stopped };
  };
}

// Job `kind` ('scan' or 'remove') on place `id`, run here. `name`: the place's, for the
// task's title (none: this browser's own storage, by name).
export function runFolderJob(kind, id, { name = '', ...args } = {}) {
  const key = String(id);
  if (_running.has(key)) return _running.get(key);
  const spec = JOBS[kind]({ id: key, ...args });
  let stop = false, last = { done: 0, total: 0, found: spec.found }, shown = 0;
  const off = platform.jobs.subscribe((e) => { if (e?.type === 'STOP_FOLDER_SCAN' && String(e.folder) === key) stop = true; });
  const job = (status, extra = {}) => platform.jobs.publish({ gid: folderJobId(key), kind: 'folder', status, title: name,
    ...(name ? {} : { titleKey: 'set.loc_browser' }), labelKey: spec.labelKey, labelArgs: { name }, doneKey: spec.doneKey, foundKey: spec.foundKey, ...last, ...extra });
  const beat = setInterval(() => { job('progress').catch(() => {}); }, HEARTBEAT_MS);
  const run = (async () => {
    await job('started');
    try {
      const result = await spec.work({ stopped: () => stop, onProgress: (done, total, found, step) => {
        const next = step && step !== last.labelKey;
        last = { done, total, found, ...(step ? { labelKey: step } : {}) };
        if (!next && Date.now() - shown < 300 && done < total) return;
        shown = Date.now();
        job('progress').catch(() => {});
      } });
      last.found = result.found;
      if (result.updated) last.updated = result.updated;
      await job(result.stopped ? 'cancelled' : 'done');
      return result;
    } catch (e) {
      await job('error', { error: String(e?.message || e), ...(e?.errorKey ? { errorKey: e.errorKey } : {}), ...(e?.unsaved ? { unsaved: e.unsaved } : {}) });
      throw e;
    } finally {
      clearInterval(beat);
      off();
      _running.delete(key);
    }
  })();
  _running.set(key, run);
  return run;
}
export const runFolderScan = (id, opts) => runFolderJob('scan', id, opts);

// Job `kind` on folder `id` run in the service worker when this page has one that takes it, else in
// this page. Resolves where: 'worker' or 'page' (the job tells the rest).
export async function startFolderJob(kind, id, opts = {}) {
  const sw = globalThis.navigator?.serviceWorker?.controller;
  if (sw) {
    const taken = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(false), WORKER_ANSWER_MS);
      channel.port1.onmessage = ({ data }) => { clearTimeout(timer); resolve(!!data?.taken); };
      try { sw.postMessage({ __shioriFolderJob: true, kind, folder: String(id), opts }, [channel.port2]); }
      catch { clearTimeout(timer); resolve(false); }
    });
    if (taken) return 'worker';
  }
  runFolderJob(kind, id, opts).catch(() => {});
  return 'page';
}
export const startFolderScan = (id, opts) => startFolderJob('scan', id, opts);
export const startFolderRemoval = (id, opts) => startFolderJob('remove', id, opts);

// A page of a browser library carrying on what was cut short: folders removed whose task hasn't
// ended (foldersPending).
export async function resumeFolderWork() {
  const { setAside } = await folders.pending();
  for (const f of setAside) startFolderRemoval(f.id, { name: f.name }).catch(() => {});
}

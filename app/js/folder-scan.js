// folder-scan.js — the work on a library folder that takes a while, as jobs the tasks page lists and
// can stop: checking a folder for galleries put in it outside the app (what adding a folder does
// after it is added, and "Check now") and what a folder removed from the library still owes it (its
// galleries moved elsewhere, everything the library has of them written there, the folder let go and
// forgotten). Kind 'folder', one per place (`folder-<id>`). A browser library's run where they are
// handed: in the service worker (sw.js), so they go on whatever page is open next, or — with none —
// in the page that asked; a removal cut short is carried on by the next page opened, moving where it
// was moving (resumeFolderWork). (The desktop app's run in the app itself and are announced the same
// way.) Stop reaches them as a signal on the jobs channel (services.js STOP_JOB).
//
// One job runs on a folder at a time, across every tab and the service worker: a job holds Web Lock
// shiori:folder-job:<id> while it runs, and says what it is by holding shiori:folder-job:<id>:<kind>
// too (navigator.locks.query reads it). A job asked for while another runs follows
// folder-lifecycle.js jobPlan: a check asked during a check joins it (the running one's task says how
// it goes), a removal asked during a check stops the check and runs after it, a check asked during a
// removal is refused, a removal asked again joins the one under way. So a page running a job itself
// after the worker was slow to answer, or two tabs asking at once, never run it twice — the lock
// decides. (The library's own work on a folder holds the folder's lock as well: folder-library.js.)
import * as platform from './platform.js';
import { folders } from './api.js';
import { jobPlan } from './storage/folder-lifecycle.js';

const folderJobId = (id) => `folder-${id}`;
const HEARTBEAT_MS = 5000;       // a running job says so this often, so a page keeps the worker awake
const WORKER_ANSWER_MS = 2000;   // how long the worker has to say it took a job
const _running = new Map();      // folder id → { kind, run }: the job this context runs on it

// Whether a folder's job runs in this context now (the service worker stays awake while one does).
export const scanning = () => _running.size > 0;

// What each job does: its kind (folder-lifecycle.js JOBS), its label, what its end says, how its
// progress names what it found ('' for nothing), whether there is still work for it (`still`: a
// removal another context finished meanwhile has none), and its work — `work(opts)` resolving
// { found, updated?, problems?, left?, stopped } (`opts`: { onProgress(done, total, found, step?),
// stopped() }): `updated` galleries read again from the folder (another app changed them),
// `problems` how many things in it couldn't be read, `left` how many galleries a move couldn't take
// — each only when there are some; `step` the label of the step under way, when the work goes in
// steps (its own count each).
const _some = (counts) => Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
const JOBS = {
  scan: ({ id, restored = 0 }) => ({ kind: 'scan', labelKey: 'lf.task_checking', doneKey: 'lf.task_done', found: restored,
    work: async ({ onProgress, stopped }) => {
      const r = await folders.scan(id, { stopped, onProgress: (done, total, added, step) => onProgress(done, total, added + restored, step) });
      return { found: r.added + restored, ..._some({ updated: r.updated, problems: r.problems?.length }), stopped: r.stopped };
    } }),
  remove: ({ id, moving = false }) => ({ kind: 'removal', labelKey: moving ? 'lf.task_moving' : 'lf.task_removing',
    doneKey: moving ? 'lf.task_moved' : 'lf.task_removed', foundKey: '', found: 0,
    still: async () => (await folders.pending()).setAside.some(f => f.id === id),
    work: async ({ onProgress, stopped }) => {
      const r = await folders.setAside(id, { stopped, onProgress: (done, total) => onProgress(done, total, done) });
      return { found: moving ? r.moved : r.removed, ..._some({ left: r.left }), stopped: r.stopped };
    } }),
};

// Job `kind` ('scan' or 'remove') on place `id`, run here — or, while another runs on it, as
// folder-lifecycle.js jobPlan says: joined (resolves that job's outcome when it runs here, else null),
// after it (a check stopped first), or refused (null). `name`: the place's, for the task's title
// (none: this browser's own storage, by name). `moving` (a removal): its galleries are moved first.
export function runFolderJob(kind, id, { name = '', ...args } = {}) {
  const key = String(id);
  const spec = JOBS[kind]({ id: key, ...args });
  const stop = _stopSignal(key, spec.kind);   // a stop asked from now on reaches it, even before it starts
  return (async () => {
    const here = _running.get(key);
    const plan = jobPlan(here?.kind ?? await _runningElsewhere(key), spec.kind);
    if (plan === 'refuse' || plan === 'join') {
      stop.off();
      return plan === 'join' ? here?.run ?? null : null;
    }
    if (plan === 'after') platform.jobs.signal({ type: 'STOP_FOLDER_SCAN', folder: key, kind: 'scan' });
    return _start(key, spec, name, stop);
  })();
}
export const runFolderScan = (id, opts) => runFolderJob('scan', id, opts);

// Whether a stop of job `kind` on folder `key` was asked for (`asked`), heard on the jobs channel —
// one naming no kind stops whatever runs there — until `off()`.
function _stopSignal(key, kind) {
  const out = { asked: false };
  out.off = platform.jobs.subscribe((e) => {
    if (e?.type === 'STOP_FOLDER_SCAN' && String(e.folder) === key && (!e.kind || e.kind === kind)) out.asked = true;
  });
  return out;
}

// Job `spec` on folder `key` started: it runs once this context holds the folder's job lock (after the
// job running elsewhere, if any), announced on the jobs channel as it goes; `stop` says when to end.
function _start(key, spec, name, stop) {
  let last = { done: 0, total: 0, found: spec.found }, shown = 0;
  const job = (status, extra = {}) => platform.jobs.publish({ gid: folderJobId(key), kind: 'folder', status, title: name,
    ...(name ? {} : { titleKey: 'set.loc_browser' }), labelKey: spec.labelKey, labelArgs: { name }, doneKey: spec.doneKey, foundKey: spec.foundKey, ...last, ...extra });
  const work = async () => {
    if (spec.still && !(await spec.still())) return null;
    const beat = setInterval(() => { job('progress').catch(() => {}); }, HEARTBEAT_MS);
    await job('started');
    try {
      const result = await spec.work({ stopped: () => stop.asked, onProgress: (done, total, found, step) => {
        const next = step && step !== last.labelKey;
        last = { done, total, found, ...(step ? { labelKey: step } : {}) };
        if (!next && Date.now() - shown < 300 && done < total) return;
        shown = Date.now();
        job('progress').catch(() => {});
      } });
      last.found = result.found;
      Object.assign(last, _some({ updated: result.updated, problems: result.problems, left: result.left }));
      await job(result.stopped ? 'cancelled' : 'done');
      return result;
    } catch (e) {
      await job('error', { error: String(e?.message || e), ...(e?.errorKey ? { errorKey: e.errorKey } : {}), ...(e?.unsaved ? { unsaved: e.unsaved } : {}),
        ...(e?.left ? { left: e.left } : {}) });
      throw e;
    } finally { clearInterval(beat); }
  };
  const run = _holding(key, spec.kind, work).finally(() => {
    stop.off();
    if (_running.get(key)?.run === run) _running.delete(key);
  });
  _running.set(key, { kind: spec.kind, run });
  return run;
}

// `fn` run while this context holds folder `key`'s job lock, and the lock saying which job it is —
// at once where there are no Web Locks (one context: _running is the queue).
const JOB_LOCK = (key) => `shiori:folder-job:${key}`;
const _locks = () => (typeof globalThis.navigator?.locks?.request === 'function' ? navigator.locks : null);
function _holding(key, kind, fn) {
  const locks = _locks();
  if (!locks) return fn();
  return locks.request(JOB_LOCK(key), { mode: 'exclusive' }, () => locks.request(`${JOB_LOCK(key)}:${kind}`, { mode: 'exclusive' }, fn));
}
// The job another context runs on folder `key` — 'scan', 'removal' — or null, as the locks held say.
// Its kind's lock is taken right after its job lock: asked again a moment later while only the first
// shows.
async function _runningElsewhere(key) {
  const locks = _locks();
  if (typeof locks?.query !== 'function') return null;
  for (let tries = 0; tries < 5; tries++) {
    const names = ((await locks.query()).held || []).map(h => h.name);
    const kind = names.find(n => n.startsWith(`${JOB_LOCK(key)}:`))?.slice(JOB_LOCK(key).length + 1) ?? null;
    if (kind || !names.includes(JOB_LOCK(key))) return kind;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

// Job `kind` on folder `id` run in the service worker when this page has one that takes it, else in
// this page. Resolves where: 'worker' or 'page' (the job tells the rest).
async function startFolderJob(kind, id, opts = {}) {
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
// ended (foldersPending) — one moving its galleries still says so.
export async function resumeFolderWork() {
  const { setAside, handover = [] } = await folders.pending();
  for (const f of setAside) startFolderRemoval(f.id, { name: f.name, moving: !!f.moving }).catch(() => {});
  // A folder still being read after it came back (its check started again as the page opened): its task.
  for (const f of handover) startFolderScan(f.id, { name: f.name }).catch(() => {});
}

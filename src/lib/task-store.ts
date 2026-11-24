// task-store.ts — the jobs the Tasks page lists, kept outside React (read with useSyncExternalStore):
// a row per job, so a gallery doing two (downloading while translating) has two, keyed `gid:kind`.
// The rules are 1.3's (app/js/tasks.js), each kept as it was:
//
//   - What is under way at load: the live jobs list (jobs.current: those still running, oldest first),
//     then a translation still under way on the translation server (translateResume), then a job
//     waiting to be resumed (jobsPending); the first of a key wins. Later news arrives on the channel,
//     which is listened to before they are asked for, so news that came first is kept.
//   - A new job's row goes at the end, so nothing already listed moves.
//   - News that is not a job (a signal on the channel) is ignored; so is a batch of imports and its
//     titles (the import tracker's); so is late news of a job whose end shows, and the end of a job
//     this page never saw.
//   - A finished row stays LINGER_MS with its last word and leaves only while the pointer is off the
//     list, so the rows under the pointer never shift; leaving the list sweeps.
//   - Stop reaches the job wherever it runs (STOP_JOB) and the row says "Stopping…" until the job's own
//     word comes back; should none come in STOP_RETRY_MS, Stop can be pressed again.
//   - A running job silent QUIET_MS says for how long; the note is read again every QUIET_EVERY_MS.
//
// A row is an immutable object, replaced when what it shows changes (its job, its stopping, the time
// it was last looked at), so a view draws again only the row that changed. Pure: the platform, the
// clock and the timers are handed in (app/tests/task-store.test.mjs).
import { isRunning, type JobNews } from './job-view.ts';

export const LINGER_MS = 4000;          // a finished job's last word stays this long, as on a library card
export const QUIET_MS = 2 * 60 * 1000;  // a running job silent this long says for how long
export const QUIET_EVERY_MS = 15000;    // ...read again this often
export const STOP_RETRY_MS = 3000;      // a Stop no word answered can be pressed again after this

export type Job = JobNews & { gid: string };
export type TaskRow = {
  key: string;
  job: Job;
  stopping: boolean;
  endedAt: number;     // when its end showed (0: running)
  shownAt: number;     // when what it says was last worked out (its "no news for" note counts to this)
};

type Handle = unknown;
export type TaskDeps = {
  jobs: { subscribe: (cb: (job: JobNews) => void) => () => unknown; current: () => Promise<JobNews[]> };
  translateResume: { all: () => Promise<{ gid: string | number }[]> };
  jobsPending: { all: () => Promise<{ key?: string; kind?: string; payload?: { galleryId?: string | number } }[]> };
  rpc: (msg: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
  timers: {
    setTimeout: (fn: () => void, ms: number) => Handle; clearTimeout: (h: Handle) => void;
    setInterval: (fn: () => void, ms: number) => Handle; clearInterval: (h: Handle) => void;
  };
};

export const keyOf = (job: JobNews) => `${job.gid}:${job.kind || 'job'}`;

// Minutes without news a running row says, or 0 when it says none.
export function quietMinutes(row: TaskRow) {
  const silent = isRunning(row.job) && !row.stopping && row.job.at ? row.shownAt - (row.job.at as number) : 0;
  return silent > QUIET_MS ? Math.floor(silent / 60000) : 0;
}

export function createTaskStore(deps: TaskDeps) {
  const { now, timers } = deps;
  let rows = new Map<string, TaskRow>();
  let snapshot: readonly TaskRow[] = [];
  let pointerOnList = false;
  const listeners = new Set<() => void>();
  // While started: what stops it. A run's own number, so work a stopped run left under way does nothing.
  let run = 0;
  let off: (() => unknown) | null = null;
  let tick: Handle = null;
  const pending = new Set<Handle>();

  const publish = () => {
    snapshot = [...rows.values()];
    for (const listener of [...listeners]) listener();
  };
  const put = (row: TaskRow) => { rows.set(row.key, { ...row, shownAt: now() }); };
  const later = (fn: () => void, ms: number) => {
    const handle = timers.setTimeout(() => { pending.delete(handle); fn(); }, ms);
    pending.add(handle);
  };

  function onJob(news: JobNews) {
    if (!news || news.gid == null || !news.status) return;   // a signal on the jobs channel, not a job
    if (news.kind === 'import' || news.batch) return;        // a batch, and its titles: the tracker's
    const job: Job = { ...news, gid: String(news.gid) };
    const key = keyOf(job);
    const row = rows.get(key);
    if (row?.endedAt && isRunning(job)) return;              // late news of the job whose end shows
    if (!row && !isRunning(job)) return;                     // the end of a job this page never saw
    const next: TaskRow = row ? { ...row, job } : { key, job, stopping: false, endedAt: 0, shownAt: 0 };
    if (!isRunning(job)) {
      next.stopping = false;
      next.endedAt = now();
      later(sweep, LINGER_MS + 50);
    }
    put(next);
    publish();
  }

  function sweep() {
    if (pointerOnList) return;
    const at = now();
    let gone = false;
    for (const [key, row] of rows) {
      if (!row.endedAt || at - row.endedAt < LINGER_MS) continue;
      rows.delete(key);
      gone = true;
    }
    if (gone) publish();
  }

  async function hydrate(mine: number) {
    const [current, translating, pending] = await Promise.all([deps.jobs.current(), deps.translateResume.all(), deps.jobsPending.all()]);
    if (mine !== run) return;
    const found = new Map<string, JobNews>();
    const add = (job: JobNews) => { if (!found.has(keyOf(job))) found.set(keyOf(job), job); };
    for (const job of current.filter(isRunning).sort((a, b) => ((a.at as number) || 0) - ((b.at as number) || 0))) add({ ...job, gid: String(job.gid) });
    const at = now();
    for (const rec of translating) add({ gid: String(rec.gid), kind: 'translate', status: 'progress', labelKey: 'prog.translating', at });
    for (const entry of pending) {
      const gid = String(entry.payload?.galleryId ?? String(entry.key || '').split(':')[0]);
      if (gid && entry.kind) add({ gid, kind: entry.kind, status: 'started', labelKey: 'prog.starting', at });
    }
    for (const [key, job] of found) if (!rows.has(key)) onJob(job);
  }

  // Stop the row `key`'s job (nothing when it is stopping already, or has ended).
  async function stopJob(key: string) {
    const row = rows.get(key);
    if (!off || !row || row.stopping || !isRunning(row.job)) return;
    const mine = run;
    put({ ...row, stopping: true });
    publish();
    try { await deps.rpc({ type: 'STOP_JOB', galleryId: row.job.gid, kind: row.job.kind }); } catch {}
    if (mine !== run) return;
    later(() => {
      const cur = rows.get(key);
      if (!cur || !cur.stopping || !isRunning(cur.job)) return;
      put({ ...cur, stopping: false });
      publish();
    }, STOP_RETRY_MS);
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,

    // Listens to the jobs channel, asks what is under way, and reads the quiet notes again every
    // QUIET_EVERY_MS. stop() undoes all of it and forgets the rows; start() may follow again.
    start() {
      if (off) return;
      const mine = ++run;
      off = deps.jobs.subscribe(onJob);
      hydrate(mine).catch(() => {});
      tick = timers.setInterval(() => {
        let changed = false;
        for (const row of rows.values()) if (isRunning(row.job)) { put(row); changed = true; }
        if (changed) publish();
      }, QUIET_EVERY_MS);
    },
    stop() {
      if (!off) return;
      run++;
      off();
      off = null;
      timers.clearInterval(tick);
      for (const handle of pending) timers.clearTimeout(handle);
      pending.clear();
      rows = new Map();
      pointerOnList = false;
      publish();
    },

    // The pointer came onto the list, or left it (which sweeps what has lingered long enough).
    pointer(on: boolean) {
      pointerOnList = on;
      if (!on) sweep();
    },

    stopJob,
    // Whether a row can be stopped (running, not stopping already).
    stoppable: () => snapshot.some((row) => isRunning(row.job) && !row.stopping),
    // Stop every running row's job.
    stopAll: () => Promise.all(snapshot.filter((row) => isRunning(row.job)).map((row) => stopJob(row.key))),
  };
}

export type TaskStore = ReturnType<typeof createTaskStore>;

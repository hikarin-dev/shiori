// import-batches.ts — the batches of imports a page follows, for the ImportTracker component
// (src/components/import-tracker.tsx), kept outside React (read with useSyncExternalStore). The same
// channel and state as app/js/import-tracker.js's panels, which the pages not ported yet still draw:
// a panel per batch, by the 'import' jobs on the jobs channel and those under way at load; Stop
// (STOP_JOB, pressable again after 3 s), Dismiss (once it has ended: it goes, and its record is
// cleared), and its titles as a list, asked for again every 2 s while it runs. What a batch says and
// how it stands are import-batch-view.js's, read when it is drawn: the store says to draw again every
// 5 s, when time left, quiet and lost may have changed. A batch's word older than the one it shows is
// let go (what is under way, read as the store starts, may land after a newer word). Words a page
// heard before its store started are handed in (hear). And a drop being read (listing: the page's
// reading of a dropped folder's list, before any batch is made), shown above the batches until it ends.
import * as platform from '@lib/platform.js';
import { PAINT_EVERY_MS, ROWS_STEP, TITLES_EVERY_MS, batchState, hasTitles, isLive, titlesSource } from '@lib/import-batch-view.js';

export type Title = { name: string; status: string; error?: string };
export type BatchJob = {
  gid: string; kind: 'import'; status: string; name?: string; runner?: unknown; at?: number;
  total: number; done: number; [field: string]: unknown;
};
export type Batch = {
  id: string;
  job: BatchJob;
  stopping: boolean;
  list: { open: boolean; filter: string; shown: number; titles: Title[] | null };
};
export type Reading = { name: string; found: number };
export type BatchesSnapshot = { batches: readonly Batch[]; tick: number; reading: Reading | null };

export const batchStateOf = (batch: Batch) => batchState(batch.job, batch.id) as string;

export function createBatchStore() {
  let batches = new Map<string, Batch>();
  const dismissed = new Set<string>();
  let snapshot: BatchesSnapshot = { batches: [], tick: 0, reading: null };
  let reading: Reading | null = null;
  const listeners = new Set<() => void>();
  let run = 0;
  let off: (() => unknown) | null = null;
  let paintTimer: ReturnType<typeof setInterval> | null = null;
  const listTimers = new Map<string, ReturnType<typeof setInterval>>();
  const stopTimers = new Set<ReturnType<typeof setTimeout>>();
  let source: { titlesOf: (id: string) => Promise<Title[] | null>; close: () => void } | null = null;

  const publish = (tick = snapshot.tick) => {
    snapshot = { batches: [...batches.values()], tick, reading };
    for (const l of [...listeners]) l();
  };
  const put = (batch: Batch) => { if (batches.has(batch.id)) batches.set(batch.id, batch); };

  async function loadTitles(id: string) {
    const mine = run;
    const titles = await source!.titlesOf(id);
    const batch = batches.get(id);
    if (mine !== run || !batch) return;
    put({ ...batch, list: { ...batch.list, titles: titles ?? batch.list.titles } });
    publish();
  }

  function setList(id: string, open: boolean) {
    const batch = batches.get(id);
    if (!batch) return;
    clearInterval(listTimers.get(id));
    listTimers.delete(id);
    put({ ...batch, list: { ...batch.list, open } });
    publish();
    if (!open) return;
    loadTitles(id);
    listTimers.set(id, setInterval(() => {
      const b = batches.get(id);
      if (b && batchStateOf(b) === 'running') loadTitles(id);
    }, TITLES_EVERY_MS));
  }

  // A batch not begun, or whose page is gone, has no titles to tell: its open list closes.
  const closeUntold = () => {
    for (const batch of batches.values()) if (batch.list.open && !hasTitles(batchStateOf(batch))) setList(batch.id, false);
  };

  function onJob(job: BatchJob) {
    if (job?.kind !== 'import' || job.gid == null || !job.status) return;
    const id = String(job.gid);
    if (dismissed.has(id)) return;
    const was = batches.get(id);
    if (was && job.at != null && was.job.at != null && job.at < was.job.at) return;
    const ended = job.status !== 'progress' && was?.job.status === 'progress';
    batches.set(id, {
      id, job,
      stopping: job.status !== 'progress' ? false : was?.stopping ?? false,
      list: was?.list ?? { open: false, filter: 'all', shown: ROWS_STEP, titles: null },
    });
    publish();
    closeUntold();
    if (ended && batches.get(id)!.list.open) loadTitles(id);
  }

  function stopBatch(id: string) {
    const batch = batches.get(id);
    if (!batch || batch.stopping) return;
    put({ ...batch, stopping: true });
    publish();
    platform.rpc({ type: 'STOP_JOB', galleryId: id, kind: 'import' }).catch(() => {});
    const timer = setTimeout(() => {
      stopTimers.delete(timer);
      const b = batches.get(id);
      if (b) { put({ ...b, stopping: false }); publish(); }
    }, 3000);
    stopTimers.add(timer);
  }

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,

    start() {
      if (off) return;
      const mine = ++run;
      source = titlesSource();
      off = platform.jobs.subscribe(onJob);
      platform.jobs.current().then((jobs: BatchJob[]) => { if (mine === run) for (const j of jobs) if (j.kind === 'import') onJob(j); }).catch(() => {});
      paintTimer = setInterval(() => { publish(snapshot.tick + 1); closeUntold(); }, PAINT_EVERY_MS);
    },
    stop() {
      if (!off) return;
      run++;
      off();
      off = null;
      clearInterval(paintTimer!);
      for (const timer of listTimers.values()) clearInterval(timer);
      listTimers.clear();
      for (const timer of stopTimers) clearTimeout(timer);
      stopTimers.clear();
      source?.close();
      source = null;
      batches = new Map();
      dismissed.clear();
      reading = null;
      publish(0);
    },

    // A drop being read: its name and how many files its folders have shown so far; null once read.
    // (Not while stopped: a page left takes its reading with it.)
    listing(name: string | null, found = 0) {
      if (!off) return;
      reading = name == null ? null : { name, found };
      publish();
    },

    // A word the page heard before this store started (or any other way), as if from the channel.
    hear(job: BatchJob) { if (off) onJob(job); },

    // How many batches run or wait, now.
    running: () => snapshot.batches.filter((b) => isLive(batchStateOf(b))).length,

    stopBatch,
    stopAll() { for (const b of snapshot.batches) if (isLive(batchStateOf(b))) stopBatch(b.id); },
    dismiss(id: string) {
      setList(id, false);
      dismissed.add(id);
      batches.delete(id);
      platform.jobs.clear(id, 'import');
      publish();
    },
    toggleList(id: string) { const b = batches.get(id); if (b) setList(id, !b.list.open); },
    filter(id: string, filter: string) {
      const b = batches.get(id);
      if (b) { put({ ...b, list: { ...b.list, filter, shown: ROWS_STEP } }); publish(); }
    },
    more(id: string) {
      const b = batches.get(id);
      if (b) { put({ ...b, list: { ...b.list, shown: b.list.shown + ROWS_STEP } }); publish(); }
    },
  };
}

export type BatchStore = ReturnType<typeof createBatchStore>;

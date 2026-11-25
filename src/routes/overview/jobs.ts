// jobs.ts — the jobs the overview shows on its chapter rows, kept outside React: per gallery, its
// latest news. A row reads its own chapter's (subscribe(gid), get(gid)), so one gallery's word draws
// one row. The rules are 1.3's (app/js/overview.js: applyChapterJob, paintChapterJob, the boot's
// hydration), each kept:
//
//   - A chapter's job is its latest news, one object a word: a download, an upload or a translation
//     with a gallery (any other kind, a signal with a type, a batch of imports: not a row's).
//   - A job's end (done, error, cancelled, interrupted) is shown for 4 s, then the row is at rest
//     again, unless another word came meanwhile. Its gallery is read again at its end and once more
//     when the 4 s are up (1.3's refreshChangedChapter after each).
//   - What is under way as the page opens (hydrate): a download's or an upload's row older than 2
//     minutes is an interruption: its row cleared from the registry and shown as interrupted; a
//     translation's is shown as it is; each then as a word heard now.
//
// Where the library's rules (src/lib/library-jobs.ts) differ, the overview keeps its own: a row has
// no "interrupted" hint apart from the job (an interruption is the job's own status, said in words);
// an end is shown for 4 s whether or not the page then reads anything (no "settled" from the row); a
// row at its end in the registry as the page opens is shown and lingers, not cleared; one job at a
// time a row (the latest word's), no button held for another job; a sync is not a row's.
//
// Pure: the jobs channel and registry, the clock and the gallery's read are handed in
// (app/tests/overview-jobs.test.mjs).
import type { JobNews } from '@/lib/job-view';

export const KINDS: ReadonlySet<string> = new Set(['download', 'upload', 'translate']);
export const LINGER_MS = 4000;
export const STALE_MS: Readonly<Record<string, number>> = { download: 2 * 60 * 1000, upload: 2 * 60 * 1000 };
const ENDED = new Set(['done', 'error', 'cancelled', 'interrupted']);
export const isEnded = (job: JobNews | null | undefined) => !!job && ENDED.has(job.status ?? '');

type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };
export type ChapterJobDeps = {
  jobs: {
    subscribe: (cb: (job: JobNews) => void) => () => unknown;
    current: () => Promise<JobNews[]>;
    clear: (gid: string, kind?: string) => unknown;
  };
  now: () => number;
  // The gallery read again (its row and the hero drawn from what it now holds).
  reread: (gid: string) => void;
  timers?: Timers;
};

export function createChapterJobs(deps: ChapterJobDeps) {
  const timers = deps.timers ?? (globalThis as unknown as Timers);
  const live = new Map<string, JobNews>();
  const clearTimers = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  let off: (() => unknown) | null = null;
  let run = 0;

  const tell = (gid: string) => { for (const l of [...(listeners.get(gid) ?? [])]) l(); };

  function apply(news: JobNews | null | undefined) {
    if (!news || news.gid == null || !KINDS.has(news.kind ?? '')) return;
    const gid = String(news.gid);
    const job: JobNews = { ...news, gid };
    timers.clearTimeout(clearTimers.get(gid));
    clearTimers.delete(gid);
    live.set(gid, job);
    tell(gid);
    if (!isEnded(job)) return;
    deps.reread(gid);
    clearTimers.set(gid, timers.setTimeout(() => {
      if (live.get(gid) !== job) return;
      clearTimers.delete(gid);
      live.delete(gid);
      tell(gid);
      deps.reread(gid);
    }, LINGER_MS));
  }

  async function hydrate(mine: number) {
    const rows = await deps.jobs.current();
    if (mine !== run) return;
    const kept: JobNews[] = [];
    for (const job of rows) {
      if (!KINDS.has(job.kind ?? '')) continue;
      if (job.kind !== 'translate' && (deps.now() - ((job.at as number) || 0)) > (STALE_MS[job.kind!] || 2 * 60 * 1000)) {
        await deps.jobs.clear(String(job.gid), job.kind);
        if (mine !== run) return;
        kept.push({ ...job, status: 'interrupted' });
      } else kept.push(job);
    }
    for (const job of kept) apply(job);
  }

  return {
    subscribe(gid: string, listener: () => void) {
      let mine = listeners.get(gid);
      if (!mine) listeners.set(gid, (mine = new Set()));
      mine.add(listener);
      return () => { mine.delete(listener); if (!mine.size && listeners.get(gid) === mine) listeners.delete(gid); };
    },
    get: (gid: string) => live.get(gid) ?? null,

    // Listens to the jobs channel and asks what is under way; stop() undoes it and forgets every job;
    // start() may follow again.
    start() {
      if (off) return;
      const mine = ++run;
      off = deps.jobs.subscribe(apply);
      hydrate(mine).catch(() => {});
    },
    stop() {
      if (!off) return;
      run++;
      off();
      off = null;
      for (const timer of clearTimers.values()) timers.clearTimeout(timer);
      clearTimers.clear();
      const had = [...live.keys()];
      live.clear();
      for (const gid of had) tell(gid);
    },
    // A job the page itself begins (7b's presses): drawn at once, as a word of its own.
    begin: (gid: string, kind: string, label: string) => apply({ gid, kind, status: 'started', label }),
  };
}

export type ChapterJobs = ReturnType<typeof createChapterJobs>;

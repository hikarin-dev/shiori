// library-jobs.ts — the jobs the library page shows on its cards, kept outside React: per gallery, its
// latest news, an interruption's hint, and a press no news has answered yet. A card reads its own
// gallery's state (subscribe(gid), get(gid)), so one gallery's word draws one card. The rules are
// 1.3's (app/js/library.js applyJob, _jobDoneHandled, _markJobInterrupted, hydrateJobs), each kept:
//
//   - A gallery's job is its latest news, one object a word (its identity is how the card knows a new
//     word). A "done" said again is not a new word. Not the page's: a signal on the jobs channel (it
//     has a type, or no gallery or no status: a batch telling of a title's end among them) and an
//     import's words (the tracker's). A title of a batch says its own news as an upload does, and its
//     card shows it.
//   - A gallery the page shows no card for: a running job is kept (its card may come: a page read
//     again, or a page turned back to) and looked for (reveal: not a translation or a sync, not at its
//     end); its end is forgotten, as is what ended on a card that leaves the page.
//   - What a job's end does, on a card: an upload's gallery is removed if it is still empty
//     (dropIfEmpty); a done job's last word, once it has stayed its while (the card says settled),
//     reads the page and its totals again (reread) and what is under way (1.3's loadAll).
//   - What is under way as the page shows (hydrate, once its first page is known): a row at its end
//     (failed or stopped) is shown once and cleared; a translation's is shown as it is (its runner
//     reattaches); a download's or an upload's older than JOB_STALE_MS is an interruption: its row
//     cleared, the hint shown until the card says settled; an import's is the tracker's.
//   - A press no news has answered yet (pending: its button held, its words) is cleared by the first
//     word, or by the press failing (release). A hint in words of its own (note) shows over no job,
//     as an interruption's does.
//   - An export under way (exporting) holds its own button until it ends, whatever is pressed or said
//     meanwhile: 1.3 held each button by itself.
//
// Pure: the jobs channel and registry, the clock and what a job's end does to the page are handed in
// (app/tests/library-jobs.test.mjs).
import type { Pending } from './card-view.ts';
import { isRunning, type JobNews } from './job-view.ts';

// How old a registry row may be and still be a job running (1.3's): a translation's runner can sit
// quiet for minutes in one call to a server.
export const JOB_STALE_MS: Readonly<Record<string, number>> = { download: 2 * 60 * 1000, upload: 2 * 60 * 1000, translate: 10 * 60 * 1000 };
const STALE_MS = 2 * 60 * 1000;

// What a card shows of its gallery's jobs: `interrupted` true (1.3's hint) or the hint's own words.
export type CardJobs = { job: JobNews | null; interrupted: boolean | string; pending: Pending; pendingLabel?: string; exporting?: boolean };
export const AT_REST: CardJobs = Object.freeze({ job: null, interrupted: false, pending: null });

export type LibraryJobDeps = {
  jobs: {
    subscribe: (cb: (job: JobNews) => void) => () => unknown;
    current: () => Promise<JobNews[]>;
    clear: (gid: string, kind?: string) => unknown;
  };
  now: () => number;
  reread: () => void;
  dropIfEmpty: (gid: string) => void;
  reveal: (gid: string) => void;
};

export function createLibraryJobs(deps: LibraryJobDeps) {
  let states = new Map<string, CardJobs>();
  const listeners = new Map<string, Set<() => void>>();
  const doneHandled = new Set<string>();
  let shown = new Set<string>();
  let run = 0;
  let off: (() => unknown) | null = null;
  let hydrated = false;

  const get = (gid: string) => states.get(gid) ?? AT_REST;
  const tell = (gid: string) => { for (const l of [...(listeners.get(gid) ?? [])]) l(); };
  // An export under way is kept through every other change of its card's state.
  const held = (was: CardJobs) => (was.exporting ? { exporting: true } : null);
  const set = (gid: string, next: CardJobs) => {
    const at = !next.job && !next.interrupted && !next.pending && !next.exporting;
    if (at ? !states.has(gid) : states.get(gid) === next) return;
    if (at) states.delete(gid); else states.set(gid, next);
    tell(gid);
  };

  function onJob(news: JobNews | null | undefined) {
    if (!news || news.type || news.gid == null || !news.status || news.kind === 'import') return;
    const gid = String(news.gid);
    if (news.status !== 'done') doneHandled.delete(gid);
    else if (doneHandled.has(gid)) return;
    const job: JobNews = { ...news, gid };
    const ended = !isRunning(job);
    const was = get(gid);
    if (!shown.has(gid)) {
      if (job.kind !== 'translate' && job.kind !== 'sync' && job.status !== 'done' && job.status !== 'error') deps.reveal(gid);
      set(gid, ended ? AT_REST : { job, interrupted: false, pending: null });
      return;
    }
    if (job.status === 'done') doneHandled.add(gid);
    if (job.kind === 'upload' && ended) deps.dropIfEmpty(gid);
    set(gid, { job, interrupted: was.interrupted, pending: null, ...held(was) });
  }

  async function hydrate(mine: number) {
    const rows = await deps.jobs.current();
    if (mine !== run) return;
    for (const row of rows) {
      if (row.kind === 'import' || row.gid == null) continue;
      const gid = String(row.gid);
      if (row.status === 'error' || row.status === 'cancelled') {
        onJob(row);
        deps.jobs.clear(gid, row.kind);
        continue;
      }
      if (row.kind !== 'translate' && deps.now() - ((row.at as number) || 0) > (JOB_STALE_MS[row.kind ?? ''] ?? STALE_MS)) {
        deps.jobs.clear(gid, row.kind);
        if (shown.has(gid)) set(gid, { ...get(gid), job: null, interrupted: true });
        continue;
      }
      onJob(row);
    }
  }

  return {
    subscribe(gid: string, listener: () => void) {
      let mine = listeners.get(gid);
      if (!mine) listeners.set(gid, (mine = new Set()));
      mine.add(listener);
      return () => { mine.delete(listener); if (!mine.size && listeners.get(gid) === mine) listeners.delete(gid); };
    },
    get,
    // Whether the gallery's latest news is a job still running (1.3's _liveJobs).
    live: (gid: string) => { const job = states.get(gid)?.job; return !!job && isRunning(job); },

    // Listens to the jobs channel; what is under way is asked once the page says what it shows.
    // stop() undoes all of it and forgets every state; start() may follow again.
    start() {
      if (off) return;
      ++run;
      hydrated = false;
      off = deps.jobs.subscribe(onJob);
    },
    stop() {
      if (!off) return;
      run++;
      off();
      off = null;
      const had = [...states.keys()];
      states = new Map();
      doneHandled.clear();
      shown = new Set();
      for (const gid of had) tell(gid);
    },

    // The galleries the page shows cards for now. What ended on a card no longer shown is forgotten
    // (its card is made at rest when it comes back); a job running is kept. The first call of a start
    // asks what is under way.
    showing(ids: readonly string[]) {
      shown = new Set(ids);
      for (const [gid, state] of [...states]) {
        if (shown.has(gid) || (state.job && isRunning(state.job))) continue;
        set(gid, AT_REST);
      }
      for (const [gid, state] of [...states]) if (!shown.has(gid) && (state.interrupted || state.pending || state.exporting)) set(gid, { job: state.job, interrupted: false, pending: null });
      if (off && !hydrated) { hydrated = true; hydrate(run).catch(() => {}); }
    },

    // The card's last word has stayed its while: the card rests (a job running again is kept), and a
    // done job's end reads the page again.
    settled(gid: string) {
      const was = get(gid);
      if (was === AT_REST) return;
      const job = was.job && isRunning(was.job) ? was.job : null;
      set(gid, { ...was, job, interrupted: false });
      if (was.job?.status === 'done') { deps.reread(); hydrate(run).catch(() => {}); }
    },

    press(gid: string, pending: Exclude<Pending, null>, label?: string) {
      const was = get(gid);
      set(gid, { job: was.job, interrupted: was.interrupted, pending, ...(label ? { pendingLabel: label } : {}), ...held(was) });
    },
    release(gid: string) {
      const was = get(gid);
      if (was.pending) set(gid, { job: was.job, interrupted: was.interrupted, pending: null, ...held(was) });
    },
    note(gid: string, label: string) {
      set(gid, { job: null, interrupted: label, pending: null, ...held(get(gid)) });
    },
    // An export of the gallery begun (true) or ended.
    exporting(gid: string, on: boolean) {
      const was = get(gid);
      if (!!was.exporting !== on) set(gid, { ...was, exporting: on });
    },
  };
}

export type LibraryJobs = ReturnType<typeof createLibraryJobs>;

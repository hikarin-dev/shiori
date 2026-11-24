// job-view.ts — what a job's bar and words say, from the job's news alone: how far it has come and
// its line of text, per status and kind. Two places draw it, each as 1.3 does: a task row (Tasks,
// app/js/tasks.js view) and a library card (app/js/library.js applyJob, drawn from this in Phase 6).
// Pure: the translation and number formats are handed in, so Node tests every branch
// (app/tests/job-view.test.mjs).
//
// What it gives:
//   pct     the bar's fill, 0–100; null when there is no figure yet (the bar says so by its motion);
//           undefined (a card, on an error) when the bar stays where it was
//   done    the fill in the colour of success
//   label   the line under the bar
// A card does not draw some news at all (a status it doesn't know, a library folder's check): null.
//
// The bar: a download's bytes fill it to 85%, its pages the rest; a translation says its own figure
// (weighted across its stages) where it has one.

export type JobNews = {
  gid?: string | number;
  kind?: string;
  status?: string;
  label?: string; labelKey?: string; labelArgs?: Record<string, string | number>;
  error?: string; errorKey?: string;
  done?: number; total?: number; pct?: number;
  downloaded?: number; pages?: number;
  skipped?: number; stale?: number; failed?: number; costNote?: string;
  // A library folder's check (folder-scan.js).
  found?: number; foundKey?: string; doneKey?: string; updated?: number; problems?: number; left?: number;
  [field: string]: unknown;
};

export type JobFormat = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  count: (n: number) => string;
  bytes: (n: number) => string;
};

export type JobView = { pct: number | null | undefined; done: boolean; label: string };

export const TERMINAL: ReadonlySet<string> = new Set(['done', 'error', 'cancelled']);
export const isRunning = (job: JobNews) => !TERMINAL.has(job.status ?? '');

const view = (pct: number | null | undefined, label: string, done = false): JobView => ({ pct, done, label });

// A finished folder job's counts (folder-scan.js): galleries read again, things it couldn't read,
// galleries a move couldn't take.
const folderCounts = (job: JobNews, { t, count }: JobFormat) => ([['lf.task_updated', job.updated], ['lf.task_problems', job.problems], ['lf.task_left', job.left]] as const)
  .filter(([, n]) => (n ?? 0) > 0).map(([key, n]) => t(key, { n: count(n!) })).join(' · ');

const errorLabel = (job: JobNews, { t }: JobFormat) => `${t('prog.error')}: ${(job.errorKey ? t(job.errorKey) : job.error) || 'unknown'}`;

export function jobView(job: JobNews, f: JobFormat, place: 'task' | 'card' = 'task'): JobView | null {
  const { t, count, bytes } = f;
  const card = place === 'card';
  const label = job.labelKey ? t(job.labelKey, job.labelArgs) : job.label;
  const done = job.done || 0, total = job.total || 0;

  // A library folder's check (a task only): its progress (the folders at its top gone through, or the
  // galleries set aside) and the galleries found; at its end what it did and what it couldn't.
  if (job.kind === 'folder') {
    if (card) return null;
    if (isRunning(job)) {
      const tally = total ? `${count(done)} / ${count(total)}` : '';
      const found = job.found && job.foundKey !== '' ? t(job.foundKey || 'lf.task_found', { n: count(job.found) }) : '';
      return view(total ? Math.round((done / total) * 100) : null, [label, tally, found].filter(Boolean).join(' · '));
    }
    const said = job.status === 'done' ? t(job.doneKey || 'lf.task_done', { n: count(job.found || 0) })
      : job.status === 'cancelled' ? t('prog.cancelled') : errorLabel(job, f);
    return view(job.status === 'done' ? 100 : 0, [said, folderCounts(job, f)].filter(Boolean).join(' · '), job.status === 'done');
  }

  const skipped = (job.skipped ?? 0) > 0 ? ` (${t('prog.already_cached', { n: count(job.skipped!) })})` : '';
  switch (job.status) {
    case 'error': return view(card ? undefined : 0, errorLabel(job, f));
    case 'cancelled': return view(0, t('prog.cancelled'));
    case 'downloading': {
      const { downloaded = 0, total: size = 0, pages = 0 } = job;
      if (!size) return view(null, `↓ ${bytes(downloaded)}`);
      return view(Math.min(85, Math.round((downloaded / size) * 85)), pages > 0
        ? `~${count(Math.min(pages, Math.round((downloaded * pages) / size)))} / ${count(pages)} · ${bytes(downloaded)}`
        : `↓ ${bytes(downloaded)}`);
    }
    case 'extracting': return view(85, t('prog.extracting'));
    case 'started': return view(0, label || (job.kind === 'sync' ? t('prog.syncing') : total ? `0 / ${count(total)}` : t('prog.starting')));
    case 'progress': case 'done': break;
    default: if (card) return null;   // a card draws only the statuses it knows; a task row any other as progress
  }

  // progress, done.
  const isDone = job.status === 'done';
  const tally = `${count(done)}/${count(total)}`;
  if (card) {
    const pct = job.kind === 'translate' ? (typeof job.pct === 'number' ? job.pct : total > 0 ? Math.round((done / total) * 100) : 0)
      : job.kind === 'upload' || job.kind === 'sync' ? (total > 0 ? Math.round((done / total) * 100) : 0)
      : total > 0 ? Math.round(85 + (done / total) * 15) : 85;
    if (job.kind === 'translate') {
      return view(pct, isDone
        ? `${t('prog.translated')} ${tally}${job.failed ? ` (${count(job.failed)} failed)` : ''}${(job.stale ?? 0) > 0 ? ` · ${t('prog.stale_pages', { n: count(job.stale!) })}` : ''}${job.costNote ? ` · ${job.costNote}` : ''}`
        : label || `${t('prog.translating')} ${count(done)} / ${count(total)}`, isDone);
    }
    if (job.kind === 'sync') return view(pct, isDone ? t('prog.synced') : `${t('prog.syncing')} · ${tally}`, isDone);
    return view(pct, isDone ? `${t('prog.done')} — ${tally}${skipped}`
      : label ? `${label} · ${tally}${skipped}` : `${count(done)} / ${count(total)}${skipped}`, isDone);
  }

  const shortTally = total ? `${count(done)} / ${count(total)}` : '';
  const pct = job.kind === 'translate' ? (typeof job.pct === 'number' ? job.pct : total ? Math.round((done / total) * 100) : 0)
    : job.kind === 'download' ? (total ? Math.round(85 + (done / total) * 15) : 85)
    : total ? Math.round((done / total) * 100) : 0;
  if (isDone) {
    return view(100, job.kind === 'translate'
      ? `${t('prog.translated')} ${tally}${(job.stale ?? 0) > 0 ? ` · ${t('prog.stale_pages', { n: count(job.stale!) })}` : ''}`
      : job.kind === 'sync' ? t('prog.synced') : `${t('prog.done')} — ${tally}${skipped}`, true);
  }
  if (job.kind === 'translate') return view(pct, label || `${t('prog.translating')} ${shortTally}`);
  if (job.kind === 'sync') return view(pct, [t('prog.syncing'), shortTally].filter(Boolean).join(' · '));
  return view(pct, [label, shortTally].filter(Boolean).join(' · ') + skipped || t('prog.starting'));
}

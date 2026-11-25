// tasks.tsx — the Tasks page (/tasks): every job under way in the library, wherever it runs and
// whether or not another page shows it (a chapter inside a series, a gallery filtered out or on
// another page of the library, a job that went quiet), each with its own Stop, and Stop all. A gallery
// doing two jobs at once (downloading while translating) has a row for each. A batch of imports is one
// job, shown by its tracker above the rows; its titles have no rows of their own. A check of a library
// folder is a row too, named after the folder.
//
// The rows' rules are the page's store's (src/lib/task-store.ts), the batches' the tracker's
// (src/lib/import-batches.ts); both start when the page shows and stop when it is left. What a row
// says is job-view.ts's; its gallery's title, sub line and cover are read through the app's cache
// (lib/gallery.ts), which the library's change feed keeps up to date.
//
// Drawn as 1.3's page (app/tasks.html, tasks.css) on its sizes: a column 960px wide at most, 20px 24px
// 48px round (12px 12px 32px at 600px or less), the batches then the rows 8px apart; a row a card
// with its cover (48px, 2:3), its kind, where it runs and its title, its sub line, its bar and words,
// and its Stop (28, a finger's 44), which keeps its place, hidden, once the job has ended. The
// header's right: the running count, Stop all (an icon alone at 600px or less), Settings.
import { memo, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { Settings } from 'lucide-react';
import * as platform from '@lib/platform.js';
import { confirmDialog } from '@lib/notice.js';
import { formatBytes, formatCount } from '@lib/format.js';
import { getLang } from '@lib/i18n.js';
import { pickSeriesTitle, pickTitle } from '@lib/titles.js';
import { HeaderSlot } from '@/components/header-slot';
import { ImportTracker, RunnerTag } from '@/components/import-tracker';
import { StopIcon } from '@/components/stop-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageMenu } from '@/components/ui/page-menu';
import { Progress } from '@/components/ui/progress';
import { Stat } from '@/components/ui/stat';
import { useGallery } from '@/lib/gallery';
import { useT, type Translate } from '@/lib/i18n';
import { isRunning, jobView } from '@/lib/job-view';
import { goTo } from '@/lib/links';
import { createBatchStore } from '@/lib/import-batches';
import { createTaskStore, quietMinutes, type TaskDeps, type TaskRow, type TaskStore } from '@/lib/task-store';
import { useTitle } from '@/lib/title';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<string, string> = { download: 'tasks.kind_download', translate: 'tasks.kind_translate', upload: 'tasks.kind_upload',
  sync: 'tasks.kind_sync', folder: 'tasks.kind_folder' };
// A job's kind in its button's colour on a card: download and import yellow, translation pink.
const KIND_TONE: Record<string, 'warning' | 'primary'> = { download: 'warning', upload: 'warning', translate: 'primary' };

// A library folder's mark in the cover's place, the same size (1.3's).
const FolderMark = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="size-[24px]">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

// (notice.js's JSDoc names every field; a confirmation takes these.)
const askToStop = confirmDialog as unknown as (ask: { title: string; body: string; ok: string; danger?: boolean }) => Promise<boolean>;

const format = (t: Translate) => ({ t, count: (n: number) => formatCount(n), bytes: (n: number) => formatBytes(n) });

// A gallery's cover, asked for once its gallery is read and has pages, until one comes (COVER_READY,
// for this page's requests: 'tasks').
function useCover(gid: string, gallery: { count?: number } | null | undefined) {
  const [cover, setCover] = useState<string | null>(null);
  useEffect(() => platform.onControl((msg: { type?: string; requester?: string; coverDataUrl?: string; galleryId?: unknown }) => {
    if (msg?.type !== 'COVER_READY' || msg.requester !== 'tasks' || !msg.coverDataUrl || String(msg.galleryId) !== gid) return;
    setCover(msg.coverDataUrl);
  }), [gid]);
  useEffect(() => {
    if (cover || !gallery || !((gallery.count ?? 0) > 0)) return;
    platform.rpc({ type: 'GET_COVER', galleryId: gid, thumbWidth: 96, preferSeries: false, requester: 'tasks', requestId: gid });
  }, [cover, gallery, gid]);
  return cover;
}

const Row = memo(function Row({ row, store }: { row: TaskRow; store: TaskStore }) {
  const t = useT();
  const labelId = useId();
  const { job } = row;
  const folder = job.kind === 'folder';
  // Its gallery, and the series it is a chapter of: named by its id until both are read (and when it
  // is not in the library, yet or any more).
  const gallery = useGallery(folder ? null : job.gid).data;
  const ownerId = gallery?.parentId ? String(gallery.parentId) : null;
  const owner = useGallery(ownerId);
  const read = gallery !== undefined && (!ownerId || owner.data !== undefined) ? gallery : undefined;
  const lang = getLang();
  const title = folder ? (job.titleKey ? t(job.titleKey as string) : (job.title as string) || '') : (read && pickTitle(read, lang)) || `#${job.gid}`;
  const sub = read ? [`#${read.sourceId || job.gid}`, owner.data ? pickSeriesTitle(owner.data.seriesTitle as never, owner.data, lang) : ''].filter(Boolean).join(' · ') : '';
  const cover = useCover(job.gid, folder ? null : read);

  const running = isRunning(job);
  const v = jobView(job, format(t))!;
  const quiet = quietMinutes(row);
  // A library folder's check opens Settings, where the folders are; a gallery's job its overview.
  const href = folder ? 'settings' : `overview?g=${encodeURIComponent(job.gid)}`;
  return (
    <Card variant="row" data-key={row.key} className={cn(
      'tk-row grid grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-[14px] px-[12px] py-[10px]',
      '[@media(max-width:600px)]:gap-[10px] [@media(max-width:600px)]:px-[10px] [@media(max-width:600px)]:py-[8px]',
      !running && job.status)}>
      {/* The cover keeps its place before it arrives, and shows no broken-image mark meanwhile. */}
      <a className={cn('tk-thumb block aspect-[2/3] w-[48px] overflow-hidden rounded-4 bg-surface-subtle', folder && 'folder grid place-items-center text-muted-foreground')}
        href={href} tabIndex={-1} aria-hidden="true">
        {folder ? <FolderMark /> : <img alt="" src={cover ?? undefined} className="block size-full object-cover [&:not([src])]:invisible" />}
      </a>
      <div className="tk-body flex min-w-0 flex-col gap-[4px]">
        <div className="tk-head flex min-w-0 items-center gap-[8px]">
          <Badge variant="kind" tone={KIND_TONE[job.kind ?? ''] ?? 'neutral'} className="tk-kind" data-kind={job.kind || ''}>
            {KIND_LABEL[job.kind ?? ''] ? t(KIND_LABEL[job.kind!]) : (job.kind || '')}
          </Badge>
          <RunnerTag runner={job.runner} />
          <a className="tk-title min-w-0 overflow-hidden text-13 font-semibold text-ellipsis whitespace-nowrap text-foreground no-underline hover:text-primary" href={href}>{title}</a>
        </div>
        <div className="tk-sub overflow-hidden text-11 text-ellipsis whitespace-nowrap text-muted-dim">{sub}</div>
        <div className="tk-prog mt-[2px] flex flex-col gap-[3px]">
          <Progress value={v.pct ?? null} done={v.done} aria-labelledby={labelId} className="prog-track"
            indicatorClassName={cn('prog-fill', v.pct == null && 'indeterminate', v.done && 'done')} />
          <span id={labelId} className={cn('tk-label overflow-hidden text-11 text-ellipsis whitespace-nowrap text-muted-foreground', job.status === 'error' && 'text-destructive')}>
            {row.stopping && running ? t('tasks.stopping') : v.label}
            {quiet > 0 && <span className="tk-quiet text-muted-dim">{` · ${t('tasks.quiet', { n: formatCount(quiet) })}`}</span>}
          </span>
        </div>
      </div>
      {/* A finished row keeps its Stop's place, so nothing beside it moves while it lingers. */}
      <Button variant="quiet" tone="danger" size="icon" coarse="44" className={cn('tk-stop', !running && 'invisible')}
        disabled={row.stopping || !running} data-tip={t('tasks.stop')} aria-label={t('tasks.stop')} onClick={() => store.stopJob(row.key)}>
        <StopIcon className="size-[14px]" />
      </Button>
    </Card>
  );
});

export default function Tasks() {
  useTitle('Tasks');
  const t = useT();
  const navigate = useNavigate();
  const [tasks] = useState(() => createTaskStore({
    jobs: platform.jobs, translateResume: platform.translateResume, jobsPending: platform.jobsPending,
    rpc: platform.rpc, now: Date.now, timers: globalThis as unknown as TaskDeps['timers'],
  }));
  const [batches] = useState(createBatchStore);
  useEffect(() => {
    tasks.start();
    batches.start();
    return () => { tasks.stop(); batches.stop(); };
  }, [tasks, batches]);
  const rows = useSyncExternalStore(tasks.subscribe, tasks.getSnapshot);
  const shown = useSyncExternalStore(batches.subscribe, batches.getSnapshot).batches.length;

  const importsRunning = batches.running();
  const running = rows.filter((row) => isRunning(row.job)).length + importsRunning;
  const stoppable = tasks.stoppable() || importsRunning > 0;
  const stopAll = async () => {
    if (!tasks.stoppable() && !batches.running()) return;
    if (!(await askToStop({ title: t('tasks.stop_all_title'), body: t('tasks.stop_all_body'), ok: t('tasks.stop_all'), danger: true }))) return;
    batches.stopAll();
    await tasks.stopAll();
  };

  return (
    <>
      <HeaderSlot side="left"><span className="brand-sep">/</span><PageMenu page="tasks" /></HeaderSlot>
      <HeaderSlot side="right">
        <Stat value={formatCount(running)} valueId="tkCount" label={t('tasks.running')} />
        <Button id="stopAllBtn" variant="danger" size="compact" coarse="40" disabled={!stoppable} onClick={stopAll}
          data-tip={t('tasks.stop_all')} aria-label={t('tasks.stop_all')}
          className="btn-stop-all [@media(max-width:600px)]:w-[28px] [@media(max-width:600px)]:px-0 [@media(pointer:coarse)_and_(max-width:600px)]:w-[40px]">
          <StopIcon width="13" height="13" />
          <span className="btn-stop-all-label [@media(max-width:600px)]:hidden">{t('tasks.stop_all')}</span>
        </Button>
        <Button id="settingsBtn" variant="ghost" size="icon" coarse="40" data-tip={t('nav.settings')} aria-label={t('nav.settings')}
          onClick={() => goTo(navigate, 'settings')}>
          <Settings className="size-[16px]" />
        </Button>
      </HeaderSlot>
      {/* Every job under way, one row each — a gallery with two jobs has two rows. */}
      <main className="tk-wrap mx-auto max-w-[960px] px-[24px] pt-[20px] pb-[48px] [@media(max-width:600px)]:px-[12px] [@media(max-width:600px)]:pt-[12px] [@media(max-width:600px)]:pb-[32px]">
        <ImportTracker store={batches} id="tkImports" className="mb-[8px]" />
        <div id="tkList" className="tk-list flex flex-col gap-[8px]" onPointerEnter={() => tasks.pointer(true)} onPointerLeave={() => tasks.pointer(false)}>
          {rows.map((row) => <Row key={row.key} row={row} store={tasks} />)}
        </div>
        <EmptyState id="tkEmpty" className="tk-empty" hidden={rows.length > 0 || shown > 0}>{t('tasks.empty')}</EmptyState>
      </main>
    </>
  );
}

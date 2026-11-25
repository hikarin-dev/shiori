// A series' list (1.3's .ch-list) and its rows (.ch-row): each row drawn from its chapter's entry in the
// query cache and its job from the page's job store, so one chapter changing draws its row alone; a
// row is kept for its chapter while the list changes round it (its node, its opened pages), and a row
// that moved slides to its new place, as 1.3's flipRows did (FLIP: where each row showed before the
// change, then from there to where it is, 220 ms; a slide still running is taken from where it is; a
// row off the screen just moves; nothing with less motion asked for). A chapter whose gallery went
// missing (or came back) is laid out differently: a new row, as 1.3 made.
//
// What a row's buttons do is 7b's (and the grip's drag 7c's): drawn in their place, with their tips and
// their Shift faces, doing nothing yet. The title and the cover open the chapter in the reader, the id
// its source (a new tab); the toggle at the end opens the chapter's pages under the row.
import { Component, memo, useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DragHandle } from '@/components/ui/drag-handle';
import { InlineEdit } from '@/components/ui/inline-edit';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { Translate } from '@/lib/i18n';
import type { Entity, Ref } from './data';
import { DetachIcon, DownIcon, DownloadIcon, QuickRemoveIcon, RemoveIcon, RevertIcon, StopIcon, TranslateIcon, UpIcon, UploadIcon } from './icons';
import { Faces, PageGrid, useCover, useDecoded, type GridEngine } from './parts';
import type { ChapterJobs } from './jobs';
import type { OverviewCovers } from './covers';
import type { RowActions, RowView } from './view';
import type { JobView } from '@/lib/job-view';
import type { JobNews } from '@/lib/job-view';

export type RowDeps = {
  t: Translate;
  covers: OverviewCovers;
  jobs: ChapterJobs;
  grids: GridEngine;
  view: (chapter: Ref, idx: number, entity: Entity | null) => RowView;
  actions: (entity: Entity | null, job: JobNews | null) => RowActions;
  jobView: (job: JobNews) => JobView | null;
};

const RowThumb = memo(function RowThumb({ url, href }: { url: string | null; href: string | null }) {
  const shown = useDecoded(url);
  const inner = shown ? <img className={cn('ov-thumb', shown.landscape && 'landscape')} alt="" src={shown.src} /> : <div className="ph">📄</div>;
  return href != null
    ? <a className={cn('ch-thumb link', shown?.landscape && 'landscape')} href={href} draggable={false}>{inner}</a>
    : <div className={cn('ch-thumb', shown?.landscape && 'landscape')}>{inner}</div>;
});

function Actions({ t, a, first, last }: { t: Translate; a: RowActions; first: boolean; last: boolean }) {
  const dl = a.download, tr = a.translate;
  return (
    <div className="ch-actions">
      <Button variant="ghost" size="icon-md" coarse="40" className="ch-ibtn" data-up data-tip={t('ov.move_up')} disabled={first}><UpIcon /></Button>
      <Button variant="ghost" size="icon-md" coarse="40" className="ch-ibtn" data-down data-tip={t('ov.move_down')} disabled={last}><DownIcon /></Button>
      {dl && (
        <Button variant="ghost" tone={dl.face === 'done' ? 'success' : 'warning'} rest={dl.face === 'done' ? 'framed' : 'tone'} hover="fill" size="icon-md" coarse="40"
          className={cn('ch-ibtn download', dl.cancelling && 'cancelling', dl.face === 'done' && 'done')}
          data-download data-tip={dl.tip} data-tip-shift={dl.shift ?? undefined} disabled={dl.disabled}>
          {dl.face === 'done' ? '✓' : dl.face === 'stop' ? <StopIcon /> : dl.face === 'download'
            ? <Faces rest={<DownloadIcon />} shift={dl.shift ? <UploadIcon /> : undefined} /> : <Faces rest={<UploadIcon />} />}
        </Button>
      )}
      {tr && (
        <Button variant="ghost" tone={tr.done ? 'success' : 'primary'} rest="tone" size="icon-md" coarse="40"
          className={cn('ch-ibtn translate', tr.done && 'done', tr.cancelling && 'cancelling')}
          data-translate data-tip={tr.tip} data-tip-shift={tr.shift ?? undefined}>
          {tr.face === 'stop' ? <StopIcon /> : <Faces rest={<TranslateIcon />} shift={tr.shift ? <RevertIcon /> : undefined} />}
        </Button>
      )}
      {a.detach && <Button variant="ghost" tone="primary" size="icon-md" coarse="40" className="ch-ibtn detach" data-detach data-tip={t('ov.remove_detach')}><DetachIcon /></Button>}
      <Button variant="ghost" tone="danger" size="icon-md" coarse="40" className="ch-ibtn danger" data-remove data-tip={a.remove.tip} data-tip-shift={a.remove.shift}>
        <Faces rest={<RemoveIcon />} shift={<QuickRemoveIcon />} />
      </Button>
    </div>
  );
}
export const ChapterRow = memo(function ChapterRow({ chapter, idx, entity, last, deps }: {
  chapter: Ref; idx: number; entity: Entity | null; last: boolean; deps: RowDeps;
}) {
  const { t, covers, jobs, grids } = deps;
  const id = chapter.id;
  const view = useMemo(() => deps.view(chapter, idx, entity), [deps, chapter, idx, entity]);
  const first = idx === 0;
  // The title's box drawn again only when what it shows changes (React writes an input's name again
  // each time it draws it).
  const title = useMemo(() => <InlineEdit size="row" readOnly value={view.title} placeholder={view.fallback} data-chapter-id={id} data-fallback={view.fallback} />, [view.title, view.fallback, id]);
  const follow = useCallback((cb: () => void) => jobs.subscribe(id, cb), [jobs, id]);
  const job = useSyncExternalStore(follow, () => jobs.get(id));
  const cover = useCover(covers, entity ? id : null, {}, entity);
  const [open, setOpen] = useState(false);
  const actions = deps.actions(entity, job);
  const progress = job ? deps.jobView(job) : null;
  const working = !!job;
  return (
    <Card variant="row" hover className={cn('ch-row', !entity && 'missing', working && 'working', open && 'expanded')} data-chapter-id={id}>
      <div className="ch-head">
        <DragHandle className="ch-grip" data-tip={t('ov.drag_reorder')} />
        <div className="ch-num">{view.num}</div>
        <RowThumb url={cover} href={entity ? view.href : null} />
        <div className="ch-main">
          <span className="ch-title-wrap">
            {title}
            <a className="ch-title-open" href={view.href} aria-label={view.title} />
          </span>
          <div className="ch-meta">
            {view.id.href ? <a className="ch-id" href={view.id.href} target="_blank" rel="noopener noreferrer">{view.id.text}</a> : <span>{view.id.text}</span>}
            <span>{view.pages}</span>
            {view.translated && <span className="done">{t('ov.translated')}</span>}
            {view.missing && <span className="missing">{t('card.files_missing')}</span>}
          </div>
          <div className="ch-progress">
            <Progress value={progress ? progress.pct ?? null : 0} done={!!progress?.done} aria-label={progress?.label || undefined} className="prog-track"
              indicatorClassName={cn('prog-fill', progress && progress.pct == null && 'indeterminate', progress?.done && 'done')} />
            <span className="ch-prog-label">{progress?.label ?? ''}</span>
          </div>
        </div>
        <Actions t={t} a={actions} first={first} last={last} />
        {entity && (
          <Button variant="ghost" size="icon-md" coarse="40" className="ch-ibtn ch-expand" data-expand aria-expanded={open}
            data-tip={t(open ? 'ov.hide_pages' : 'ov.show_pages')} onClick={() => setOpen((was) => !was)}>
            <DownIcon />
          </Button>
        )}
      </div>
      <PageGrid engine={grids} gid={id} open={open} version={entity?.count} className="ch-pages" />
    </Card>
  );
});

// ── The list: rows that moved slide to their place ──
const FLIP_MS = 220;
const FLIP_EASING = 'cubic-bezier(.2, .8, .2, 1)';

type ListProps = { order: string; numChars: string; children: ReactNode };
type Snapshot = { tops: Map<Element, number>; focused: Element | null } | null;

export class ChapterList extends Component<ListProps> {
  private list: HTMLDivElement | null = null;
  getSnapshotBeforeUpdate(prev: ListProps): Snapshot {
    if (prev.order === this.props.order || !this.list) return null;
    return { tops: new Map([...this.list.children].map((row) => [row, row.getBoundingClientRect().top])), focused: document.activeElement };
  }
  componentDidUpdate(_: ListProps, __: unknown, snap: Snapshot) {
    if (!snap || !this.list) return;
    const list = this.list;
    for (const row of snap.tops.keys()) for (const a of row.getAnimations()) a.cancel();
    // Moving a row out of the DOM and back drops its focus; give it back.
    const focused = snap.focused as HTMLElement | null;
    if (focused && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const row of list.children as HTMLCollectionOf<HTMLElement>) {
      const was = snap.tops.get(row);
      if (was == null) continue;
      const now = row.getBoundingClientRect().top;
      const offScreen = Math.max(was, now) < -row.offsetHeight || Math.min(was, now) > innerHeight;
      if (Math.abs(was - now) < 0.5 || offScreen) continue;
      row.animate([{ transform: `translateY(${was - now}px)` }, { transform: 'none' }], { duration: FLIP_MS, easing: FLIP_EASING });
    }
  }
  render() {
    // The number column fits the longest label (1084.5) so every row's cover lines up.
    return <div className="ch-list" id="chList" ref={(el) => { this.list = el; }} style={{ '--ch-num-chars': this.props.numChars } as React.CSSProperties}>{this.props.children}</div>;
  }
}

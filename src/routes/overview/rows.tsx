// A series' list (1.3's .ch-list) and its rows (.ch-row): each row drawn from its chapter's entry in the
// query cache and its job from the page's job store, so one chapter changing draws its row alone; a
// row is kept for its chapter while the list changes round it (its node, its opened pages), and a row
// that moved slides to its new place, as 1.3's flipRows did (./slide.ts: by `top`, not a transform,
// rule 29). A chapter whose gallery went
// missing (or came back) is laid out differently: a new row, as 1.3 made.
//
// What a row's buttons do is the page's (./actions.ts; the grip's drag ./row-drag.ts): the arrows, download
// (Replace with Shift; its Stop while it runs), translate (Revert with Shift; its Stop; "Re-run from…"
// on the right button), detach, delete (no question with Shift). Each Shift face shows while Shift is
// held on its button (CSS). The title and the cover open the chapter in the reader, the id its source
// (a new tab); the toggle at the end opens the chapter's pages under the row. In edit mode the title is
// a box to type in (saved as it is left, on Enter, and as edit mode ends), the toggle is gone and the
// pages close.
import { Component, memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
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
import { rowTops, setDown, slideRows } from './slide';
import type { RowActions, RowView } from './view';
import type { JobView } from '@/lib/job-view';
import type { JobNews } from '@/lib/job-view';

// What a row's buttons do (the page's ./actions.ts). `label`: the title the row shows (a dialog names
// the chapter by it).
export type RowOn = {
  grip: (e: ReactPointerEvent<HTMLElement>) => void;   // a press on the grip: the row dragged (./row-drag.ts)
  step: (chapterId: string, delta: number) => void;
  download: (ch: Ref, e: Entity | null, label: string, shift: boolean) => Promise<void>;
  translate: (ch: Ref, e: Entity | null, label: string, shift: boolean) => Promise<void>;
  rerun: (ch: Ref, e: Entity | null, label: string, anchor: HTMLElement) => boolean;
  detach: (ch: Ref) => void;
  delete: (ch: Ref, e: Entity | null, label: string, quick: boolean) => Promise<void>;
  saveChapterTitle: (chapterId: string, text: string) => void;
};

export type RowDeps = {
  t: Translate;
  covers: OverviewCovers;
  jobs: ChapterJobs;
  grids: GridEngine;
  // The chapters whose pages are open in this visit of the page (the page keeps them by history entry:
  // coming Back to it, they are open as they were left).
  opened: { has: (id: string) => boolean; set: (id: string, open: boolean) => void };
  on: RowOn;
  view: (chapter: Ref, idx: number, entity: Entity | null) => RowView;
  actions: (entity: Entity | null, job: JobNews | null, held: boolean) => RowActions;
  jobView: (job: JobNews) => JobView | null;
};

const RowThumb = memo(function RowThumb({ url, href }: { url: string | null; href: string | null }) {
  const shown = useDecoded(url);
  const inner = shown ? <img className={cn('ov-thumb', shown.landscape && 'landscape')} alt="" src={shown.src} /> : <div className="ph">📄</div>;
  return href != null
    ? <a className={cn('ch-thumb link', shown?.landscape && 'landscape')} href={href} draggable={false}>{inner}</a>
    : <div className={cn('ch-thumb', shown?.landscape && 'landscape')}>{inner}</div>;
});

const failed = (err: unknown) => console.error(err);

function Actions({ t, a, first, last, on, chapter, entity, label }: {
  t: Translate; a: RowActions; first: boolean; last: boolean; on: RowOn; chapter: Ref; entity: Entity | null; label: string;
}) {
  const dl = a.download, tr = a.translate;
  const rerun = (e: MouseEvent<HTMLButtonElement>) => { if (on.rerun(chapter, entity, label, e.currentTarget)) e.preventDefault(); };
  return (
    <div className="ch-actions">
      <Button variant="ghost" size="icon-md" coarse="40" className="ch-ibtn" data-up data-tip={t('ov.move_up')} disabled={first} onClick={() => on.step(chapter.id, -1)}><UpIcon /></Button>
      <Button variant="ghost" size="icon-md" coarse="40" className="ch-ibtn" data-down data-tip={t('ov.move_down')} disabled={last} onClick={() => on.step(chapter.id, 1)}><DownIcon /></Button>
      {dl && (
        <Button variant="ghost" tone={dl.face === 'done' ? 'success' : 'warning'} rest={dl.face === 'done' ? 'framed' : 'tone'} hover="fill" size="icon-md" coarse="40"
          className={cn('ch-ibtn download', dl.cancelling && 'cancelling', dl.face === 'done' && 'done')}
          data-download data-tip={dl.tip} data-tip-shift={dl.shift ?? undefined} disabled={dl.disabled}
          onClick={(e) => { on.download(chapter, entity, label, e.shiftKey).catch(failed); }}>
          {dl.face === 'done' ? '✓' : dl.face === 'stop' ? <StopIcon /> : dl.face === 'download'
            ? <Faces rest={<DownloadIcon />} shift={dl.shift ? <UploadIcon /> : undefined} /> : <Faces rest={<UploadIcon />} />}
        </Button>
      )}
      {tr && (
        <Button variant="ghost" {...(tr.done ? { tone: 'success', rest: 'tone' } as const : {})} size="icon-md" coarse="40"
          className={cn('ch-ibtn translate', tr.done && 'done', tr.cancelling && 'cancelling')}
          data-translate data-tip={tr.tip} data-tip-shift={tr.shift ?? undefined} disabled={tr.disabled}
          onClick={(e) => { on.translate(chapter, entity, label, e.shiftKey).catch(failed); }} onContextMenu={rerun}>
          {tr.face === 'stop' ? <StopIcon /> : <Faces rest={<TranslateIcon />} shift={tr.shift ? <RevertIcon /> : undefined} />}
        </Button>
      )}
      {a.detach && <Button variant="ghost" tone="primary" size="icon-md" coarse="40" className="ch-ibtn detach" data-detach data-tip={t('ov.remove_detach')}
        onClick={() => on.detach(chapter)}><DetachIcon /></Button>}
      <Button variant="ghost" tone="danger" size="icon-md" coarse="40" className="ch-ibtn danger" data-remove data-tip={a.remove.tip} data-tip-shift={a.remove.shift}
        onClick={(e) => { on.delete(chapter, entity, label, e.shiftKey).catch(failed); }}>
        <Faces rest={<RemoveIcon />} shift={<QuickRemoveIcon />} />
      </Button>
    </div>
  );
}
export const ChapterRow = memo(function ChapterRow({ chapter, idx, entity, last, editing, deps }: {
  chapter: Ref; idx: number; entity: Entity | null; last: boolean; editing: boolean; deps: RowDeps;
}) {
  const { t, covers, jobs, grids, on } = deps;
  const id = chapter.id;
  const view = useMemo(() => deps.view(chapter, idx, entity), [deps, chapter, idx, entity]);
  const first = idx === 0;
  // The title's box drawn again only when what it shows changes (React writes an input's name again
  // each time it draws it). In edit mode it holds the chapter's own title (empty: none, the gallery's
  // as its placeholder).
  const title = useMemo(() => (
    <InlineEdit size="row" readOnly={!editing} value={editing ? view.custom : view.title} placeholder={view.fallback} data-chapter-id={id} data-fallback={view.fallback}
      onCommit={(text) => on.saveChapterTitle(id, text)} />
  ), [editing, view.custom, view.title, view.fallback, id, on]);
  const follow = useCallback((cb: () => void) => jobs.subscribe(id, cb), [jobs, id]);
  const job = useSyncExternalStore(follow, () => jobs.get(id));
  const held = useSyncExternalStore(follow, () => jobs.held(id));
  const cover = useCover(covers, entity ? id : null, {}, entity);
  const { opened } = deps;
  const [open, setOpen] = useState(() => opened.has(id));
  const show = useCallback((next: boolean) => { opened.set(id, next); setOpen(next); }, [opened, id]);
  // Edit mode closes the chapter's pages (its toggle is gone meanwhile).
  useEffect(() => { if (editing) show(false); }, [editing, show]);
  const actions = deps.actions(entity, job, held);
  const progress = job ? deps.jobView(job) : null;
  const working = !!job;
  return (
    <Card variant="row" hover className={cn('ch-row', !entity && 'missing', working && 'working', open && 'expanded')} data-chapter-id={id}>
      <div className="ch-head">
        <DragHandle className="ch-grip" data-tip={t('ov.drag_reorder')} onPointerDown={on.grip} />
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
        <Actions t={t} a={actions} first={first} last={last} on={on} chapter={chapter} entity={entity} label={chapter.title || view.fallback} />
        {entity && (
          <Button variant="ghost" size="icon-md" coarse="40" className="ch-ibtn ch-expand" data-expand aria-expanded={open}
            data-tip={t(open ? 'ov.hide_pages' : 'ov.show_pages')} onClick={() => show(!open)}>
            <DownIcon />
          </Button>
        )}
      </div>
      <PageGrid engine={grids} gid={id} open={open} version={entity?.count} className="ch-pages" />
    </Card>
  );
});

// ── The list: rows that moved slide to their place (./slide.ts) ──
type ListProps = { order: string; numChars: string; children: ReactNode };
type Snapshot = { tops: Map<Element, number>; focused: Element | null } | null;

export class ChapterList extends Component<ListProps> {
  private list: HTMLDivElement | null = null;
  getSnapshotBeforeUpdate(prev: ListProps): Snapshot {
    if (prev.order === this.props.order || !this.list) return null;
    return { tops: rowTops(this.list), focused: document.activeElement };
  }
  componentDidUpdate(_: ListProps, __: unknown, snap: Snapshot) {
    if (!snap || !this.list) return;
    // Moving a row out of the DOM and back drops its focus; give it back.
    const focused = snap.focused as HTMLElement | null;
    if (focused && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
    // Rows dropped by the grip (./row-drag.ts) stand where the drag put them (their `top`): taken from
    // there, they slide to their places in the order drawn.
    const dropped = this.list.getAttribute('data-sorting') === 'dropped';
    if (dropped) {
      this.list.removeAttribute('data-sorting');
      for (const row of this.list.children as HTMLCollectionOf<HTMLElement>) row.style.top = '';
    }
    slideRows(this.list, snap.tops);
    if (dropped) setDown(this.list);
  }
  render() {
    // The number column fits the longest label (1084.5) so every row's cover lines up.
    return <div className="ch-list" id="chList" ref={(el) => { this.list = el; }} style={{ '--ch-num-chars': this.props.numChars } as React.CSSProperties}>{this.props.children}</div>;
  }
}

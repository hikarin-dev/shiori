// ImportTracker — a batch of imports as people follow it: a panel per batch (the library, an overview
// and Tasks show one), wherever the batch runs. Its store is the page's (src/lib/import-batches.ts:
// the same channel and state as app/js/import-tracker.js), so the page can stop every batch and count
// those running; what a panel says is import-batch-view.js's, worked out as it is drawn.
//
// Drawn as 1.3's .ib: the row card (8px apart, 10px 12px inside, 6px between its lines; 8px 10px at
// 600px or less), a head 28px high at least (the kind, where it runs, the batch's name and size, the
// Titles, Stop and Dismiss buttons, a finger's 44), the job bar, the tally, the title under way (in the
// warning colour once nothing has moved for a while) and the issues (in the danger colour once a title
// failed), each line hidden while it has nothing to say; then, opened, its titles: the filter pills,
// the titles (up to 320px, scrolling), "More", or why there are none. Ids, classes and states kept
// (the tests' and other pages' selectors: .ib[data-batch][data-state], .ib-tally, .ib-stop…).
import { memo, useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { FILTERS, batchView, hasTitles, isLive, titlesView } from '@lib/import-batch-view.js';
import { formatCount } from '@lib/format.js';
import { runnerTag } from '@lib/runner-tag.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { StopIcon } from '@/components/stop-icon';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { batchStateOf, type Batch, type BatchStore } from '@/lib/import-batches';

const LINE = 'overflow-hidden text-ellipsis whitespace-nowrap text-11 text-muted-foreground empty:hidden';

// Where a job runs (runner-tag.js: its words and tip, kept exactly), as the quiet badge; hidden when
// the job doesn't say.
export function RunnerTag({ runner }: { runner: unknown }) {
  const tag = runnerTag(runner);
  return (
    <Badge className="run-tag cursor-default" hidden={!tag} data-tip={tag?.tip} data-runner={tag ? (runner as { kind: string }).kind : undefined}>
      {tag?.text}
    </Badge>
  );
}

type Data = { [data: `data-${string}`]: string | undefined };

const Panel = memo(function Panel({ batch, store, tick, data }: { batch: Batch; store: BatchStore; tick: number; data?: Data }) {
  const t = useT();
  void tick;   // drawn again every 5 s: time left, quiet and lost read the clock
  const s = batchStateOf(batch);
  const v = batchView(batch.job, s);
  const live = isLive(s);
  const told = hasTitles(s);
  const { counts, rows, more } = titlesView(batch.list.titles, batch.list.filter, batch.list.shown);
  return (
    <Card variant="row" className={cn('ib flex flex-col gap-[6px] px-[12px] py-[10px]', '[@media(max-width:600px)]:px-[10px] [@media(max-width:600px)]:py-[8px]')}
      data-batch={batch.id} data-state={s} {...data}>
      <div className="ib-head flex min-h-[28px] min-w-0 items-center gap-[8px]">
        <Badge variant="kind" tone="warning" className="ib-kind">{t('tasks.kind_upload')}</Badge>
        <RunnerTag runner={batch.job.runner} />
        <span className="ib-name min-w-0 overflow-hidden text-13 font-semibold text-ellipsis whitespace-nowrap text-foreground">{v.name}</span>
        <span className={cn('ib-total shrink-0 text-11 whitespace-nowrap text-muted-dim', '[@media(max-width:600px)]:hidden')}>{v.total}</span>
        <Button variant="quiet" size="compact" coarse="44" className="ib-btn ib-list-btn ml-auto" hidden={!told}
          aria-expanded={batch.list.open} onClick={() => store.toggleList(batch.id)}>{t('imp.titles')}</Button>
        <Button variant="quiet" tone="danger" size="icon" coarse="44" className="ib-btn ib-icon ib-stop" hidden={!live} disabled={batch.stopping}
          data-tip={t('imp.stop')} aria-label={t('imp.stop')} onClick={() => store.stopBatch(batch.id)}><StopIcon className="size-[14px]" /></Button>
        <Button variant="quiet" size="icon" coarse="44" className="ib-btn ib-icon ib-dismiss" hidden={live}
          data-tip={t('imp.dismiss')} aria-label={t('imp.dismiss')} onClick={() => store.dismiss(batch.id)}><X className="size-[14px]" /></Button>
      </div>
      <Progress value={parseFloat(v.width)} done={s === 'done'} className="prog-track" indicatorClassName={cn('prog-fill', s === 'done' && 'done')} aria-label={v.name} />
      <div className={cn('ib-line ib-tally', LINE, (s === 'stopped' || s === 'lost') && 'whitespace-normal')}>{v.tally}</div>
      <div className={cn('ib-line ib-now', LINE, v.quiet && 'quiet text-warning')}>{v.now}</div>
      <div className={cn('ib-line ib-issues', LINE, v.failed && 'has-failed text-destructive')}>{v.issues}</div>
      <div className="ib-titles mt-[4px] flex flex-col gap-[8px] border-0 border-t border-solid border-border pt-[10px]" hidden={!batch.list.open}>
        <ToggleGroup variant="pill" className="ib-filters" value={batch.list.filter} onValueChange={(f) => store.filter(batch.id, f)}>
          {(FILTERS as string[]).map((f) => (
            <ToggleGroupItem key={f} value={f} className="ib-filter" data-filter={f} hidden={f !== 'all' && !counts[f]}>
              {`${t(`imp.f_${f}`)} ${formatCount(counts[f])}`}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ol className="ib-rows m-0 max-h-[320px] list-none overflow-y-auto p-0">
          {rows.map((ti: { name: string; status: string; error?: string }, i: number) => (
            <li key={i} className={cn('ib-row grid grid-cols-[96px_minmax(0,1fr)] gap-x-[10px] py-[3px] text-12', '[@media(max-width:600px)]:grid-cols-[76px_minmax(0,1fr)]')} data-status={ti.status}>
              <span className={cn('ib-row-status text-11 leading-[18px] text-muted-dim', ti.status === 'importing' && 'text-warning', ti.status === 'done' && 'text-success', ti.status === 'failed' && 'text-destructive')}>{t(`imp.f_${ti.status}`)}</span>
              <span className="ib-row-name overflow-hidden leading-[18px] text-ellipsis whitespace-nowrap text-foreground">{ti.name}</span>
              <span className="ib-row-error col-start-2 text-11 [overflow-wrap:anywhere] text-destructive empty:hidden">{ti.status === 'failed' ? ti.error || '' : ''}</span>
            </li>
          ))}
        </ol>
        <div className={cn('ib-line ib-rows-note', LINE)} hidden={!!batch.list.titles}>{batch.list.titles ? '' : t('imp.no_titles')}</div>
        <Button variant="quiet" size="compact" coarse="44" className="ib-btn ib-more self-start" hidden={!more} onClick={() => store.more(batch.id)}>{t('imp.more')}</Button>
      </div>
    </Card>
  );
});

// `panelData`: data attributes every panel carries (/components tags its specimen so).
type Props = { store: BatchStore; id?: string; className?: string; panelData?: Data };

function ImportTracker({ store, id, className, panelData }: Props) {
  const { batches, tick } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <div id={id} className={cn('ib-host flex flex-col gap-[8px]', className)} hidden={!batches.length}>
      {batches.map((batch) => <Panel key={batch.id} batch={batch} store={store} tick={tick} data={panelData} />)}
    </div>
  );
}

export { ImportTracker };

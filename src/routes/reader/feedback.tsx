// reader/feedback.tsx — the feedback dialog (F over a bubble in study or translate view; 1.3's
// app/js/reader-feedback.js drew it by hand): the page as it showed with the bubbles' places marked, what
// will be sent and where, what needs improvement, a note, the other bubbles to include, and send or
// export. It draws the draft ./feedback-store.ts shows, which the module keeps for the reader's session:
// closed and opened again on the same bubble it is as it was left.
//
// The app's simple Dialog (3xl 960) on the layer over the reader's chrome; its corner X (F29); the shared
// Checkbox (F11: accent ticks), the inset Textarea (S12: 12px), the dialog Buttons. A press outside does
// not close it (a form, as 1.3's had no such way); Escape and the X do. The frozen page keeps the place
// it took on the reader (its aspect, measured as F was pressed), so the box has its size from its first
// frame, its pictures coming in place.
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { closeFeedbackDialog, getShown, subscribe, type FeedbackDraft } from './feedback-store';

const LINE = 'm-0 text-12 leading-[1.5] [overflow-wrap:anywhere]';
const FIELDSET = 'mx-0 my-[12px] min-w-0 rounded-6 border border-solid border-border p-[10px]';
const LEGEND = 'px-[2px] text-13';
const CHECK = 'my-[6px] flex cursor-pointer items-center gap-[8px] text-13';

// The page as it showed (a copy of the reader's own, which only this draws), at the column's width:
// what the page's own sheet gives a page in the reader (its width, a zoom's transform) is held off it.
const FROZEN = cn('relative',
  '[&>.page-wrap]:m-0! [&>.page-wrap]:w-full! [&>.page-wrap]:max-w-full! [&>.page-wrap]:transform-none! [&>.page-wrap]:pointer-events-none',
  '[&>.page-wrap>img]:m-0! [&>.page-wrap>img]:block! [&>.page-wrap>img]:h-auto! [&>.page-wrap>img]:max-h-none! [&>.page-wrap>img]:w-full! [&>.page-wrap>img]:max-w-none!');

function Preview({ draft }: { draft: FeedbackDraft }) {
  const t = useT();
  const holder = useRef<HTMLDivElement>(null);
  // Put in before the box is painted (its bubbles' layers keep to its width: the module's observer).
  useLayoutEffect(() => {
    const box = holder.current;
    if (!box) return;
    box.append(draft.page);
    return () => { draft.page.remove(); };
  }, [draft]);
  const selected = (i: number) => i === draft.index || draft.ticked.has(i);
  return (
    <div data-feedback="preview-column" className="min-w-0 max-[650.02px]:mx-auto max-[650.02px]:w-full max-[650.02px]:max-w-[330px]">
      <p className={LINE}>{t('feedback.preview')}</p>
      <div className="relative" style={{ aspectRatio: draft.aspect }}>
        <div ref={holder} data-feedback="preview" aria-hidden className={FROZEN} />
        <div className="pointer-events-none absolute inset-0">
          {draft.regions.map((r, i) => r && (
            <div key={i} data-feedback-region={i} data-selected={selected(i) ? '' : undefined}
              className={cn('absolute z-10 text-white [font:bold_12px_sans-serif] [text-shadow:0_1px_3px_#000]',
                selected(i) ? 'bg-[rgba(237,39,84,.12)] outline-3 outline-primary outline-solid' : 'outline-1 outline-[#558bff] outline-dashed')}
              style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}>{i + 1}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Form({ draft }: { draft: FeedbackDraft }) {
  const t = useT();
  return (
    <form data-feedback="form" className="min-w-0" onSubmit={(e) => { e.preventDefault(); void draft.send(); }}>
      <p data-feedback="destination" className={LINE}>{t(draft.destination ? 'feedback.destination' : 'feedback.loading')}</p>
      <p data-feedback="subject" className={LINE}>{t('feedback.subject', { subject: t(`feedback.surface_${draft.surface}`) })}</p>
      <div data-feedback="fidelity" className={LINE}>
        {draft.fidelity && t(`feedback.${draft.fidelity}`)}
        {draft.missing.length > 0 && <ul className="my-[12px] pl-[40px]">{draft.missing.map((m) => <li key={m}>{t(`feedback.${m}`)}</li>)}</ul>}
      </div>
      <fieldset data-feedback="issues" disabled={draft.busy} className={FIELDSET}>
        <legend className={LEGEND}>{t('feedback.issues')}</legend>
        {draft.issues.map((issue) => (
          <label key={issue} className={CHECK}>
            <Checkbox name="issue" value={issue} checked={draft.chosen.has(issue)} disabled={draft.busy} onCheckedChange={(on) => draft.setIssue(issue, !!on)} />
            {t(`feedback.${issue}`)}
          </label>
        ))}
      </fieldset>
      <label className="block text-13">
        {t('feedback.note')}
        <Textarea variant="inset" name="note" rows={5} maxLength={10000} value={draft.note} disabled={draft.busy}
          onChange={(e) => draft.setNote(e.currentTarget.value)} className="mt-[8px] block w-full resize-y" />
      </label>
      {/* The other bubbles, in a box that scrolls inside the frame's straight sides. */}
      <fieldset data-feedback="related" disabled={draft.busy} className={FIELDSET}>
        <legend className={LEGEND}>{t('feedback.related')}</legend>
        <div className="scroll-box max-h-[180px]">
          {draft.related.map(({ index, text }) => (
            <label key={index} className={CHECK}>
              <Checkbox name="related" value={String(index)} checked={draft.ticked.has(index)} disabled={draft.busy} onCheckedChange={(on) => draft.setRelated(index, !!on)} />
              {text}
            </label>
          ))}
        </div>
      </fieldset>
      <p data-feedback="status" role="status" aria-live="polite" className={LINE}>{draft.status}</p>
      <DialogFooter className="justify-between">
        <Button type="submit" variant="primary" disabled={!draft.canSave()}>{t('feedback.save')}</Button>
        <Button type="button" disabled={!draft.canExport()} onClick={() => void draft.export()}>{t('feedback.export')}</Button>
      </DialogFooter>
    </form>
  );
}

export default function Feedback() {
  const t = useT();
  const shown = useSyncExternalStore(subscribe, getShown);
  const draft = shown?.draft;
  return (
    <Dialog open={!!draft} disablePointerDismissal onOpenChange={(open) => { if (!open) closeFeedbackDialog(); }}>
      {draft && (
        <DialogContent key={draft.key} size="3xl" layer="over" data-reader-part="feedback" className="text-13">
          <DialogHeader>
            <DialogTitle>{t('feedback.title')}</DialogTitle>
            <DialogClose />
          </DialogHeader>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(260px,1fr)] gap-[24px] max-[650.02px]:grid-cols-[minmax(0,1fr)]">
            <Preview draft={draft} />
            <Form draft={draft} />
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

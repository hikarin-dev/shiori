// A series' translation window (1.3's openSeriesTranslateModal): one press translates one chapter.
// The chapters listed with their number (a volume as a volume), their title and whether they are
// translated; the lowest one not translated chosen first (else the first). Translate sends that
// chapter's translation and closes it; Cancel, Escape or a press beside it closes it. A dialog of the
// app's (xs 340, the tag editor's: §5.3 S06, S16, F26–F28), focus on its list as it opens.
import { useRef, useState } from 'react';
import * as api from '@lib/api.js';
import { getLang } from '@lib/i18n.js';
import { pickTitle } from '@lib/titles.js';
import { memberKind } from '@lib/gallery-model.js';
import { chapterNumberLabel } from '@lib/series.js';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, type SelectOption } from '@/components/ui/select';
import { Eyebrow } from '@/components/ui/text';
import type { Translate } from '@/lib/i18n';

export type SeriesTranslateAsk = { options: SelectOption[]; value: string };

type Chapter = { id: string; title?: string; number?: unknown; kind?: string };

// The window's list for the series `g`, read from its chapters as they are now.
export async function seriesTranslateAsk(t: Translate, g: { chapters?: Chapter[] | null }): Promise<SeriesTranslateAsk> {
  const chapters = g.chapters || [];
  const entities = await api.galleries.byIds(chapters.map((c) => c.id)) as ({ translated?: boolean } | null)[];
  let first = entities.findIndex((e) => e && !e.translated);
  if (first < 0) first = 0;
  const options = chapters.map((c, i) => {
    const e = entities[i];
    const name = c.title || pickTitle(e as never, getLang()) || '';
    const flag = e?.translated ? ` · ${t('ov.translated')}` : '';
    const n = (chapterNumberLabel(c as never) as string | null) ?? i + 1;
    return { value: String(c.id), label: `${t(memberKind(c as never) === 'volume' ? 'ov.volume_n' : 'ov.chapter_n', { n })}${name ? ` — ${name}` : ''}${flag}` };
  });
  return { options, value: options[first]?.value ?? '' };
}

export function SeriesTranslateDialog({ t, ask, onGo, onClose }: { t: Translate; ask: SeriesTranslateAsk | null; onGo: (gid: string) => void; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [shown, setShown] = useState<SeriesTranslateAsk | null>(null);
  if (ask !== shown) { setShown(ask); if (ask) setValue(ask.value); }
  const box = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={!!ask} onOpenChange={(open) => { if (!open) onClose(); }}>
      {ask && (
        <DialogContent size="xs" id="seriesTranslateModal" aria-labelledby="serTrTitle"
          initialFocus={() => box.current?.querySelector<HTMLElement>('button, select') ?? null}>
          <DialogHeader><DialogTitle id="serTrTitle">{t('sertr.title')}</DialogTitle></DialogHeader>
          <div ref={box} className="flex flex-col gap-[8px]">
            <Eyebrow size="xs" id="serTrDesc">{t('sertr.desc')}</Eyebrow>
            <Select id="_serTrSel" variant="inset" options={ask.options} value={value} onValueChange={setValue} aria-labelledby="serTrDesc" />
          </div>
          <DialogFooter>
            <Button id="_serTrCancel" onClick={onClose}>{t('common.cancel')}</Button>
            <Button id="_serTrGo" variant="primary" onClick={() => { const gid = value; onClose(); onGo(gid); }}>{t('sertr.go')}</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

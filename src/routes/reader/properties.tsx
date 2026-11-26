// reader/properties.tsx — page properties (I, or the page menu's last item; 1.3's
// app/js/reader-properties.js drew it by hand): everything stored for one page, as the app's sectioned
// Dialog. The module reads the page (its record, its gallery's translation, each picture inspected,
// describePage, then where a new translation would start) and hands each step to ./properties-store.ts;
// this draws it. The box is drawn once the page has been read, as tall as what it holds (at most 860px),
// and neither moves nor grows after its first frame (the owner's rule for dialogs): what comes later, the
// plan of a translation made again, has its room from the start. (1.3's showed at once with a loading
// line and grew when the page came.)
//
// Sizes are the dialogs' (D8, §5.3 S16): the Dialog's frame, header (title 15px), body padding 20, corner
// X, an sm outline button for Copy as JSON; the chips are Badge's status pills, the table tag Badge's
// quiet one, the lists Collapsible's details. Colours, words, rows and their order are 1.3's.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible } from '@/components/ui/collapsible';
import { Eyebrow } from '@/components/ui/text';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatBytes, formatCount } from '@lib/format.js';
import { STAGES } from '@lib/page-data.js';
import { dims, flattenSettings, imageLine, joined, megapixels, planText, share, stepName, times, when } from '@lib/reader-properties.js';
import { closeProperties, getAsk, subscribe, type PropertiesAsk } from './properties-store';

type Info = NonNullable<PropertiesAsk['info']>;

const NOTE = 'mt-[8px] mb-0 text-10 leading-[1.55] text-muted-foreground';

// Rows of a label and what it is (1.3's dl.pp-grid): two columns, one on a phone.
function Rows({ rows, mono }: { rows: [string, ReactNode][]; mono?: boolean }) {
  const shown = rows.filter(([, v]) => v != null && v !== '');
  return (
    <dl data-pp="grid" className={cn('m-0 grid grid-cols-[minmax(120px,max-content)_minmax(0,1fr)] gap-x-[18px] gap-y-[6px] text-11',
      'max-[560.02px]:grid-cols-[minmax(0,1fr)] max-[560.02px]:gap-[1px]', mono && 'text-10')}>
      {shown.map(([label, value], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className={cn('m-0 min-w-0 [overflow-wrap:anywhere] max-[560.02px]:mb-[7px]', mono && 'text-[color-mix(in_srgb,var(--foreground)_80%,var(--muted-foreground))]')}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, meta, children, first }: { title?: ReactNode; meta?: ReactNode; children: ReactNode; first?: boolean }) {
  return (
    <section data-pp="section" className={cn('py-[13px]', !first && 'border-0 border-t border-solid border-border')}>
      {title != null && (
        <Eyebrow as="h3" className="m-0 mb-[9px] flex items-baseline justify-between gap-[12px]">
          <span>{title}</span>
          {meta ? <span className="text-10 font-normal tracking-normal text-foreground normal-case">{meta}</span> : null}
        </Eyebrow>
      )}
      {children}
    </section>
  );
}

// A list that opens under its header, scrolling in a box of its own past `max` (its scrollbar kept
// to its own straight sides: the box is square).
function Details({ title, max, open, before, children }: { title: string; max: number; open?: boolean; before?: ReactNode; children: ReactNode }) {
  return (
    <Collapsible title={title} defaultOpen={open} className="mt-[11px]">
      {before}
      <div data-pp="scroll" className="scroll-box overflow-auto pr-[6px]" style={{ maxHeight: max }}>{children}</div>
    </Collapsible>
  );
}

const PART_COLOUR = { original: 'bg-[#7b8cff]', translated: 'bg-success', steps: 'bg-warning', study: 'bg-primary' } as const;
const PART_LABEL = { original: 'page.original', translated: 'page.translated', steps: 'page.steps', study: 'page.study' } as const;
const TH = 'py-[6px] pr-[10px] pl-0 text-left align-top border-0 border-b border-solid border-[color-mix(in_srgb,var(--border)_60%,transparent)]';
const NUM = 'text-right whitespace-nowrap tabular-nums pr-0';

function Hero({ info, thumb, t }: { info: Info; thumb: Blob | null; t: ReturnType<typeof useT> }) {
  const original = info.original?.bytes || 0;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!thumb) return;
    const u = URL.createObjectURL(thumb);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [thumb]);
  const shown = info.status === 'translated' && info.translated ? info.translated : info.original;
  const ratio = shown?.w && shown?.h ? `${shown.w} / ${shown.h}` : undefined;
  return (
    <section data-pp="hero" className="flex gap-[16px] pt-0 pb-[14px]">
      {thumb && (
        // Its box sized from the picture's own size before it shows (it never grows into place).
        <span className="block w-[92px] max-h-[136px] shrink-0 self-start overflow-hidden rounded-6 border border-solid border-border bg-reader-background" style={{ aspectRatio: ratio }}>
          {url && <img alt="" src={url} className="block size-full object-contain" />}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-[9px]">
        <div className="text-16 font-bold">{joined(dims(info.original), info.original?.format)}</div>
        <div className="flex flex-wrap gap-[6px]">
          <Badge variant="status" tone={info.status === 'translated' ? 'success' : info.status === 'reverted' ? 'warning' : 'muted'} data-pp-chip={info.status}>{t(`page.status_${info.status}`)}</Badge>
          {info.status !== 'none' && <Badge variant="status" tone={info.own ? 'primary' : 'muted'} data-pp-chip={info.own ? 'own' : 'follows'}>{t(info.own ? 'page.keeps_own' : 'page.follows')}</Badge>}
          {info.study && <Badge variant="status" tone="muted" data-pp-chip="study">{t('page.study')}</Badge>}
        </div>
        <div className="text-11 text-muted-foreground">
          {t('page.stored')} <b className="text-foreground">{formatBytes(info.storage.total)}</b>
          {original ? ` · ${times(info.storage.total / original)}` : ''}
        </div>
        {/* The bar: a part's share of what is stored (its own drawing: Progress shows one figure). */}
        <div data-pp="bar" className="flex h-[8px] gap-[2px] overflow-hidden rounded-4 bg-reader-background">
          {(['original', 'translated', 'steps', 'study'] as const).filter((k) => info.storage[k]).map((k) => (
            <span key={k} className={cn('min-w-[3px]', PART_COLOUR[k])} style={{ flexGrow: info.storage[k] }} title={`${t(PART_LABEL[k])} · ${formatBytes(info.storage[k])}`} />
          ))}
        </div>
        <ul data-pp="legend" className="m-0 flex list-none flex-wrap gap-x-[14px] gap-y-[4px] p-0 text-10 text-muted-foreground">
          {(['original', 'translated', 'steps', 'study'] as const).filter((k) => info.storage[k]).map((k) => (
            <li key={k} className="flex items-center gap-[5px]">
              <i className={cn('inline-block size-[8px] rounded-2', PART_COLOUR[k])} />
              {t(PART_LABEL[k])} <b className="font-semibold text-foreground">{formatBytes(info.storage[k])}</b>
              {original && k !== 'original' ? <span className="text-muted-foreground"> {share(info.storage[k], original)}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Body({ ask, t }: { ask: PropertiesAsk; t: ReturnType<typeof useT> }) {
  if (ask.state === 'missing' || !ask.info) return <p className={cn(NOTE, 'mt-0')}>{t('page.not_stored')}</p>;
  const info = ask.info;
  const original = info.original?.bytes || 0;
  const entry = info.entry;
  const c = (entry?.config || {}) as Record<string, any>;
  const size = (v: number | undefined) => (v ? ` · ${formatCount(v)}` : '');
  const settings = entry ? flattenSettings(c) : [];
  const builds = entry ? STAGES.filter((stage: string) => entry.builds?.[stage]) : [];
  const s = info.steps;
  const st = info.study;
  const again = ask.again;
  const againRows: [string, ReactNode][] = again === undefined ? [[t('page.again'), t('page.again_checking')]]
    : again.unavailable ? [[t('page.again'), t(`page.again_${again.unavailable}`)]]
    : [[t('page.again_gallery'), planText(again.gallery)], [t('page.translate'), planText(again.page)]];
  return (
    <>
      <Hero info={info} thumb={ask.thumb ?? null} t={t} />
      <Section title={t('page.images')}>
        <Rows rows={[
          [t('page.original'), joined(imageLine(info.original), megapixels(info.original))],
          [t('page.translated'), info.translated ? joined(imageLine(info.translated), t('page.of_original', { pct: share(info.translated.bytes, original) }))
            : info.layered ? t('page.rebuilt') : null],
          [t('page.added'), when(info.added)],
          [t('page.source'), <span className="text-10 break-all">{info.url}</span>],
        ]} />
      </Section>
      <Section title={t('page.translation')}>
        {entry ? (
          <>
            <Rows rows={[
              [t('page.made'), joined(when(entry.at), info.job)],
              [t('page.settings'), t(info.own ? 'page.keeps_own' : 'page.follows')],
              [t('tm.translator'), c.translator?.translator && c.translator.translator + (c.translator.target_lang ? ` → ${c.translator.target_lang}` : '')],
              [t('tm.ocr_model'), c.ocr?.ocr],
              [t('tm.detector'), c.detector?.detector && c.detector.detector + size(c.detector.detection_size)],
              [t('tm.inpainter'), c.inpainter?.inpainter && c.inpainter.inpainter + size(c.inpainter.inpainting_size)],
              [t('tm.renderer'), c.render?.renderer],
            ]} />
            <Details title={t('page.all_settings', { n: formatCount(settings.length) })} max={240}>
              <Rows mono rows={settings.map(([k, v]: [string, string]) => [k, v])} />
            </Details>
            <Details title={t('page.builds', { n: formatCount(Object.keys(entry.builds || {}).length) })} max={240} before={<p className={NOTE}>{t('page.builds_note')}</p>}>
              <Rows mono rows={builds.map((stage: string) => [stepName(stage), entry.builds?.[stage]])} />
            </Details>
          </>
        ) : <p className={NOTE}>{t('page.no_translation')}</p>}
        {/* Two rows' room from the start: the server's answer is one row or two, and the box does not grow for it. */}
        <div data-pp="again" className="mt-[11px] min-h-[calc(2lh+6px)] text-11 max-[560.02px]:min-h-[calc(4lh+15px)]"><Rows rows={againRows} /></div>
      </Section>
      <Section title={t('page.steps')} meta={s ? `${formatBytes(s.bytes)}${original ? ` · ${share(s.bytes, original)}` : ''}` : ''}>
        {!s ? <p className={NOTE}>{t('page.nothing_saved')}</p> : (
          <>
            <table data-pp="steps" className="w-full border-collapse text-11">
              <tbody>
                {stepRows(s, t).map(([stage, what, bytes]) => (
                  <tr key={stage}>
                    <th className={cn(TH, 'w-[150px] font-medium text-muted-foreground max-[560.02px]:w-[96px]')}>{stepName(stage)}</th>
                    <td className={TH}>{what}</td>
                    <td className={cn(TH, NUM)}>{bytes ? formatBytes(bytes) : ''}</td>
                  </tr>
                ))}
                <tr>
                  <th className={cn(TH, 'w-[150px] border-b-0 pt-[8px] font-medium text-muted-foreground max-[560.02px]:w-[96px]')}>{t('page.record')}</th>
                  <td className={cn(TH, 'border-b-0 pt-[8px] text-muted-foreground')}>{Object.entries(s.fields).map(([k, v]) => `${k} ${formatBytes(v as number)}`).join(' · ')}</td>
                  <td className={cn(TH, NUM, 'border-b-0 pt-[8px]')}>{formatBytes(s.recordBytes)}</td>
                </tr>
              </tbody>
            </table>
            <p className={NOTE}>{s.end ? t('page.stopped', { step: stepName(s.end) }) : t('page.restart', { step: stepName(s.restart) })}</p>
            <p className={NOTE}>{t('page.always_run')}</p>
          </>
        )}
      </Section>
      <Section title={t('page.study')} meta={st ? formatBytes(st.bytes) : ''}>
        {!st ? <p className={NOTE}>{t('page.no_study')}</p> : (
          <Rows rows={[
            [t('page.balloons_label'), formatCount(st.balloons)],
            [t('page.background'), st.bg ? imageLine(st.bg) : null],
            [t('page.text_layers'), st.layers ? joined(formatCount(st.layers), st.layersFormat, formatBytes(st.layersBytes)) : null],
            [t('page.metadata'), formatBytes(st.metaBytes)],
          ]} />
        )}
      </Section>
      {!info.text.length ? (
        <Section title={t('page.text')}><p className={NOTE}>{t('page.no_text')}</p></Section>
      ) : (
        <Section>
          <Details open title={`${t('page.text')} (${formatCount(info.text.length)})`} max={320}>
            <table data-pp="text" className="w-full border-collapse text-11">
              <thead>
                <tr>
                  <th className={cn(TH, 'text-10 font-medium text-muted-foreground')}>#</th>
                  <th className={cn(TH, 'text-10 font-medium text-muted-foreground')}>{t('page.col_source')}</th>
                  <th className={cn(TH, 'text-10 font-medium text-muted-foreground')}>{t('page.col_translation')}</th>
                </tr>
              </thead>
              <tbody>
                {info.text.map((r, i) => (
                  <tr key={i} data-filtered={r.filtered ? '' : undefined} className={cn(r.filtered && '[&>td]:opacity-55')}>
                    <td className={cn(TH, 'w-[24px] pr-0 text-muted-foreground tabular-nums')}>{i + 1}</td>
                    <td className={cn(TH, 'w-[45%] text-muted-foreground')}>{r.src}</td>
                    <td className={TH}>{r.tr ?? '—'}{r.filtered && <Badge variant="quiet" className="ml-[6px]">{t('page.filtered_tag')}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Details>
        </Section>
      )}
    </>
  );
}

// The steps a translation saved, as 1.3's table listed them: [stage, what it holds, its size].
function stepRows(s: NonNullable<Info['steps']>, t: ReturnType<typeof useT>): [string, string, number | undefined][] {
  const mask = (m: { w?: number | null; h?: number | null; format?: string | null } | null) => joined(dims(m), m?.format);
  const rows: [string, string, number | undefined][] = [['detect', joined(t('page.lines', { n: formatCount(s.lines) }), s.raw && `${t('page.raw_mask')} ${mask(s.raw)}`), s.raw?.bytes]];
  if (s.read != null) rows.push(['ocr', t('page.read', { n: formatCount(s.read) }), undefined]);
  if (s.regions != null) rows.push(['merge', joined(t('page.regions', { n: formatCount(s.regions) }), s.filtered && t('page.filtered', { n: formatCount(s.filtered) })), undefined]);
  if (s.regions) rows.push(['translate', t('page.translations', { n: formatCount(s.translations) }), undefined]);
  if (s.mask) rows.push(['mask', mask(s.mask), s.mask.bytes]);
  if (s.bubbles != null) rows.push(['bubbles', t('page.balloons', { n: formatCount(s.bubbles) }), s.bubbles ? s.bubblesBytes : 0]);
  return rows;
}

export default function PageProperties() {
  const t = useT();
  const ask = useSyncExternalStore(subscribe, getAsk);
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef(0);
  const close = useRef<HTMLButtonElement>(null);
  // Whether the last press was a key's (I) or the pointer's (the page menu's item): its close button
  // shows the keyboard's ring only after a key, as 1.3's did (rule 12).
  const byKey = useRef(false);
  useEffect(() => {
    const key = () => { byKey.current = true; };
    const pointer = () => { byKey.current = false; };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', pointer, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', pointer, true); };
  }, []);
  const focusClose = () => { close.current?.focus({ preventScroll: true, focusVisible: byKey.current } as FocusOptions); return false; };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setCopied(null); }, [ask?.id]);
  const copy = async () => {
    const ok = await ask?.copy?.();
    setCopied(t(ok ? 'page.copied' : 'page.copy_failed'));
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 1600);
  };
  const sub = ask ? joined(ask.page.chapter, t('page.of', { n: formatCount(ask.page.number), total: formatCount(ask.page.total) })) : '';
  // Drawn once the page has been read (a few frames after it is asked for; the engine counts it open
  // from the request): the box is as tall as what it holds, at most 860px, from its first frame.
  const shown = ask && ask.state !== 'loading' ? ask : null;
  return (
    <Dialog open={!!shown} onOpenChange={(open) => { if (!open) closeProperties(); }}>
      {shown && (
        // Focus on its close button, as 1.3's.
        <DialogContent key={shown.id} size="2xl" layout="sectioned" layer="over" data-reader-part="properties" initialFocus={focusClose}
          className="max-h-[min(860px,calc(100dvh-32px))]">
          <DialogHeader className="items-start">
            <div className="min-w-0">
              <DialogTitle>{t('page.properties')}</DialogTitle>
              <DialogDescription>{sub}</DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-[8px]">
              <Button size="sm" disabled={!shown.copy} onClick={() => void copy()}>{copied ?? t('page.copy')}</Button>
              <DialogClose ref={close} />
            </div>
          </DialogHeader>
          <DialogBody data-pp="body">
            <Body ask={shown} t={t} />
          </DialogBody>
        </DialogContent>
      )}
    </Dialog>
  );
}

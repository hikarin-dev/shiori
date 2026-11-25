// GalleryCard — a gallery in the library's grid, as 1.3's card draws it (app/js/library.js buildCard,
// _paintCard, _syncThumb, _syncCardActions, applyJob's drawing): the cover (letterboxed with a glow
// when it is landscape), a series' badge, the heart, the id row with the source button and the quick
// actions, the title, the meta line, a job's bar and line, the tags. Its look is gallery-card.css.
//
//   view     what it shows of its gallery: cardView(g, cover, env) (src/lib/card-view.ts); with its
//            `safe` words (Safe Mode, src/lib/safe-mode.ts) it shows those in place of the title's,
//            the id's and the tags', keeps the real ones as its originals, and its id is no link
//   cover    its cover's picture, where the page keeps it apart from the view (a cover arriving then
//            draws the cover alone, the view being the same object); left out, the view's is shown
//   job      the gallery's job, its latest news as published (null: none): its bar and line, the
//            button it holds as its Stop (or busy), its last word kept JOB_LINGER_MS, then the card
//            returns to rest and says so (on.jobSettled)
//   interrupted  a job left unfinished by its runner: the hint, for JOB_LINGER_MS (true: 1.3's words;
//            a string: a hint in words of its own, as a replace that could not read its file)
//   lingerMs how long a last word stays (JOB_LINGER_MS; /components holds one still with Infinity)
//   pending  a press its handler has taken and no news has answered yet, drawn as 1.3 drew it:
//            'download' (its button "…", "Fetching metadata…"), 'translate' (its button off,
//            "Translating…"), 'revert' (translate off)
//   pendingLabel  the line a pressed download shows in place of "Fetching metadata…" (a replace's
//            "Reading file…")
//   exporting  an export of it under way: its button "…" and off, whatever else the card shows
//   holding  the jobs of its buttons that still run while `job` is another job's news (a download
//            while its series' sync or a translation says a word): each keeps its own button, as 1.3
//            painted each button from its own job's words; the bar and the line are the latest news'
//   on       the handlers, each called with the gallery's id (and what was pressed, where there is a
//            choice): the card starts nothing itself. Which one a press means is the card's, as 1.3's
//            handlers chose: Shift, Alt, the button's form.
// The modes (the quick actions' preference, the category tag, the translation server, Safe Mode's blur,
// the phone form) come from the grid's element: cardModes() below, read by the stylesheet, so a mode
// changes no card's markup. Shift held comes as the grid's class (useShiftHeld): the hovered button
// turns to its Shift face in CSS. A change to one part changes that part's nodes only (React keeps the
// rest, the cover's <img> above all), and a card under the pointer keeps its hover.
//
// What the card asks of its place: to be a child of the grid (its growth under the pointer reads its
// siblings), the grid's element to carry the modes, and `app/flags/` beside the page for the flags.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tag } from '@/components/ui/tag';
import { StopIcon } from '@/components/stop-icon';
import { siteRoot } from '@/entry';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { JOB_LINGER_MS, buttonForm, cardJob, type CardJob, type CardTag, type CardView, type Pending } from '@/lib/card-view';
import type { JobButton, JobFormat, JobNews } from '@/lib/job-view';
import { formatBytes, formatCount } from '@lib/format.js';
import { ChainIcon, DeleteIcon, DownloadIcon, ExportIcon, ExportMetaIcon, HeartIcon, QuickDeleteIcon, RevertIcon, TranslateIcon, UploadIcon } from './gallery-card-icons';
import './gallery-card.css';

export type CardTagRef = { type: string; name: string };
export type CardHandlers = {
  favorite?(id: string): void;
  searchFavorite?(id: string): void;            // Alt
  openSource?(id: string): void;                // its page, in a new window
  editSource?(id: string, shift: boolean): void; // Shift, or no link yet
  searchSource?(id: string): void;              // Alt, with a source
  download?(id: string): void;
  replace?(id: string): void;                   // Shift, or nothing to download from
  stopDownload?(id: string): void;              // its Stop, while it downloads
  translate?(id: string): void;
  revert?(id: string): void;                    // Shift, translated (not a series)
  cancelTranslate?(id: string): void;           // its Stop, while it translates
  searchTranslated?(id: string): void;          // Alt
  rerun?(id: string, anchor: HTMLElement): void; // a right-click on a translated gallery's button
  export?(id: string): void;
  exportMetadata?(id: string): void;            // Shift
  remove?(id: string): void;
  quickRemove?(id: string): void;               // Shift: no question asked
  tag?(id: string, tag: CardTagRef): void;      // search for it
  removeTag?(id: string, tag: CardTagRef): void; // Shift
  flag?(id: string, code: string, name: string): void;   // search for the language
  removeFlag?(id: string, code: string): void;  // Shift
  addTag?(id: string): void;
  coverPointerDown?(id: string, event: PointerEvent<HTMLAnchorElement>): void;   // a mouse's left button on the cover
  jobSettled?(id: string): void;                // a job's last word has stayed its while
};
export type { Pending } from '@/lib/card-view';

export type CardModes = { quickActions?: 'hover' | 'always' | 'hidden'; hideCategory?: boolean; translatorOffline?: boolean; safeMode?: boolean; narrow?: boolean };
// The value of data-card-modes for the grid's element.
export function cardModes({ quickActions = 'hover', hideCategory, translatorOffline, safeMode, narrow }: CardModes): string {
  return [quickActions === 'hover' && 'quick-hover', quickActions === 'hidden' && 'quick-hidden', hideCategory && 'hide-category',
    translatorOffline && 'translator-offline', safeMode && 'safe', narrow && 'narrow'].filter(Boolean).join(' ');
}

type Props = {
  view: CardView;
  cover?: string | null;
  job?: JobNews | null;
  interrupted?: boolean | string;
  lingerMs?: number;
  pending?: Pending;
  pendingLabel?: string;
  exporting?: boolean;
  holding?: Partial<Record<JobButton, JobNews>>;
  on?: CardHandlers;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'onPointerDown'> & Record<`data-${string}`, string | undefined>;

const NO_HANDLERS: CardHandlers = {};

// ── The cover ──
// 1.3's paintCardGlow, moved as it is: a landscape cover's bars are filled with an ambient glow built
// as ambient-light video players build theirs, copies of the cover stacked behind it, each a step
// taller than the last so its edge colours reach outward, then blurred. Tuned to the maximum spread
// (400%, in 12% edge steps) and a 100% blur (a radius of 25% of the cover's height). The copies grow
// only vertically (the bars are above and below), so each colour runs straight out of the edge it
// touches. Shown as an image, not the canvas it is drawn on: a canvas gets a compositor layer of its
// own, and a card growing over one would be drawn on another, its text thinned.
const GLOW_SPREAD = 4, GLOW_EDGE = 0.12, GLOW_BLUR = 0.25;
// The glow overhangs the cover's box by half its size on every side (the stylesheet, same fraction).
const GLOW_BLEED = 0.5;
type Glow = { src: string; blur: string };
function paintGlow(img: HTMLImageElement): Glow | null {
  const aspect = img.naturalWidth / img.naturalHeight;
  // Small is enough: the result is blurred and scaled up. One downscaled copy is drawn repeatedly.
  const src = document.createElement('canvas');
  src.width = 48; src.height = Math.max(1, Math.round(48 / aspect));
  const sctx = src.getContext('2d');
  if (!sctx) return null;
  sctx.drawImage(img, 0, 0, src.width, src.height);
  const W = 96, H = W * Math.SQRT2;                       // the cover's box (1:√2) in canvas px
  const padX = W * GLOW_BLEED, padY = H * GLOW_BLEED;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W + 2 * padX);
  canvas.height = Math.round(H + 2 * padY);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const coverW = W, coverH = W / aspect;                  // object-fit: contain, width-bound
  const cx = canvas.width / 2, cy = canvas.height / 2;
  // Tallest first, each shorter copy covering the middle of the one behind it; the step is scaled by
  // the aspect ratio, as the spread would be for a glow around all four sides. Each copy's outer
  // columns are stretched sideways across the overhang so the blur finds colour at the card's sides.
  const x0 = cx - coverW / 2, x1 = cx + coverW / 2;
  for (let level = Math.round(GLOW_SPREAD / GLOW_EDGE); level >= 0; level--) {
    const h = coverH * (1 + GLOW_EDGE * aspect * level), y0 = cy - h / 2;
    ctx.drawImage(src, 0, 0, 1, src.height, 0, y0, x0, h);
    ctx.drawImage(src, src.width - 1, 0, 1, src.height, x1, y0, canvas.width - x1, h);
    ctx.drawImage(src, x0, y0, coverW, h);
  }
  // The radius in the cover's width units (cqw), so it holds at any card size.
  return { src: canvas.toDataURL(), blur: `blur(${(GLOW_BLUR * 100 / aspect).toFixed(2)}cqw)` };
}

// The cover: the picture once there is one to show (its place kept empty while it comes, 📁 where
// none will), letterboxed when it is landscape (1.3's updateCardThumbFit). A new picture replaces the
// old in the same <img>, which shows the old one until the new has come; a cover taken away (none at
// hand for now) leaves the last one showing, as 1.3's did.
const Cover = memo(function Cover({ id, href, src, expected, badge, onPointerDown }: {
  id: string; href: string; src: string | null; expected: boolean; badge: string;
  onPointerDown: (event: PointerEvent<HTMLAnchorElement>) => void;
}) {
  const [kept, setKept] = useState<string | null>(src);
  if (src && src !== kept) setKept(src);
  const shown = src || kept;
  const [fit, setFit] = useState<{ landscape: boolean; glow: Glow | null }>({ landscape: false, glow: null });
  const loaded = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const landscape = img.naturalWidth >= img.naturalHeight;
    // (A portrait cover after a portrait one changes nothing: the same object, nothing drawn again.)
    setFit((was) => (landscape ? { landscape, glow: paintGlow(img) } : was.landscape || was.glow ? { landscape: false, glow: null } : was));
  }, []);
  return (
    // draggable off on the cover and its link: grabbing it starts the card's own drag (6d), not the
    // browser's, whose dragged image carries a 'Files' type the page's file drop would take.
    <a className="card-thumb-wrap" href={href} draggable={false} onPointerDown={onPointerDown}>
      {expected && fit.glow && <img className="card-thumb-glow" alt="" aria-hidden="true" src={fit.glow.src} style={{ filter: fit.glow.blur }} />}
      {expected
        ? <img className={fit.landscape ? 'card-thumb landscape' : 'card-thumb'} draggable={false} alt="" src={shown ?? undefined} onLoad={loaded} data-cover={id} />
        : <div className="card-thumb-placeholder">📁</div>}
      {badge && <Badge variant="overlay" className="card-series-badge absolute top-[8px] left-[8px] z-[6]">{badge}</Badge>}
    </a>
  );
});

// ── A button's faces ──
// (data-shift: it has a face for Shift, which the stylesheet turns it to; without one it stays still.)
function Faces({ rest, shift }: { rest: ReactNode; shift?: ReactNode }) {
  return (
    <span className="card-face" data-shift={shift ? '' : undefined}>
      <span className="face-rest card-face">{rest}</span>
      {shift && <span className="face-shift card-face">{shift}</span>}
    </span>
  );
}
const ICON = 'size-[14px]';

// ── The tags ──
const TAG_VARIANT = { category: 'category', artist: 'artist' } as const;
// `shown`: Safe Mode's words, chip by chip (the view's `safe`), in place of each tag's own.
const Tags = memo(function Tags({ id, tags, shown, on }: { id: string; tags: CardTag[]; shown?: (string | null)[]; on: CardHandlers }) {
  return (
    <div className="card-tags">
      {tags.map((chip, i) => {
        if (chip.kind === 'flag') {
          return (
            <span key={`flag:${chip.code}`} className="card-tag-flag" data-lang-code={chip.code} data-lang-name={chip.name} data-tip={chip.tip}
              onClick={(e) => { e.preventDefault(); if (e.shiftKey) on.removeFlag?.(id, chip.code); else on.flag?.(id, chip.code, chip.name); }}>
              <img className="flag-img" src={`${siteRoot}app/flags/${chip.flag}.svg`} alt={chip.code} loading="lazy" />
            </span>
          );
        }
        if (chip.kind === 'add') {
          return <Tag key="add" size="xs" variant="add" className="card-tag card-tag-add" tabIndex={-1} data-tip={chip.tip} aria-label={chip.tip}
            onClick={(e) => { e.preventDefault(); on.addTag?.(id); }}>+</Tag>;
        }
        const ref = { type: chip.type, name: chip.name };
        const variant = chip.type === 'category' || chip.type === 'artist' ? TAG_VARIANT[chip.type] : 'neutral';
        return (
          <Tag key={`${i}:${chip.type}:${chip.name}`} size="xs" variant={variant} removable tabIndex={-1}
            className={cn('card-tag', chip.type === 'category' && 'category', chip.type === 'artist' && 'artist')} data-type={chip.type} data-original={chip.name}
            onClick={(e) => { e.preventDefault(); if (e.shiftKey) on.removeTag?.(id, ref); else on.tag?.(id, ref); }}>{shown?.[i] ?? chip.text}</Tag>
        );
      })}
    </div>
  );
});

// ── The open button's face ──
function OpenFace({ view }: { view: CardView }) {
  const face = view.open.face;
  const rest = face.kind === 'chain' ? <ChainIcon />
    : face.kind === 'icon' ? <img src={face.src} data-fav={face.source} alt="" decoding="async" />
    : <span className="source-icon-slot" data-fav={face.source}><ChainIcon /></span>;
  // Flipped to its Shift face only where there is a link to edit (1.3's flip asked for its Shift tip).
  return (
    <span className="card-face" data-shift={view.open.shift ? '' : undefined}>
      <span className="face-rest open-inner">{rest}</span>
      {view.open.shift && <span className="face-shift open-inner"><ChainIcon /></span>}
    </span>
  );
}

// ── The card ──
type Drawn = { job: CardJob; key: object };
const INTERRUPTED = (label: string): CardJob => ({ shown: true, bar: undefined, done: false, label, hold: null, form: 'rest', ended: true });

// Everything of the card but its cover. A component of its own, drawn again only when something it
// shows changes: a cover arriving (the commonest change of a card, thirty to a page) draws the cover
// alone.
type Form = CardJob['form'] | 'pending';
const Rest = memo(function Rest({ view, on, shown, bar, done, label, dlForm, trForm, exporting }: {
  view: CardView; on: CardHandlers; shown: boolean; bar: number | null; done: boolean; label: string; dlForm: Form; trForm: Form; exporting: boolean;
}) {
  const t = useT();
  const id = view.id;
  const labelId = useId();

  const press = (fn: (e: MouseEvent<HTMLButtonElement>) => void) => (e: MouseEvent<HTMLButtonElement>) => { fn(e); };
  const onFav = press((e) => (e.altKey ? on.searchFavorite?.(id) : on.favorite?.(id)));
  const onOpen = press((e) => {
    if (e.altKey && view.open.alt) on.searchSource?.(id);
    else if (!view.open.shift || e.shiftKey) on.editSource?.(id, e.shiftKey);
    else on.openSource?.(id);
  });
  const onDownload = press((e) => {
    if (dlForm === 'cancel') on.stopDownload?.(id);
    else if (e.shiftKey || !view.canDownload) on.replace?.(id);
    else on.download?.(id);
  });
  const onTranslate = press((e) => {
    if (trForm === 'cancel') on.cancelTranslate?.(id);
    else if (e.altKey) on.searchTranslated?.(id);
    else if (e.shiftKey && view.translated && !view.series) on.revert?.(id);
    else on.translate?.(id);
  });
  const onRerun = (e: MouseEvent<HTMLButtonElement>) => {
    // Not while it is its job's Stop, or off: a translation just finished leaves it pressable, as 1.3's.
    if (!view.translated || view.series || (trForm !== 'rest' && trForm !== 'done')) return;
    e.preventDefault();
    on.rerun?.(id, e.currentTarget);
  };
  const onExport = press((e) => (e.shiftKey ? on.exportMetadata?.(id) : on.export?.(id)));
  const onRemove = press((e) => (e.shiftKey ? on.quickRemove?.(id) : on.remove?.(id)));

  // Download: Replace's icon when there is nothing to download from; Stop while it downloads; "…"
  // pressed; ✓ done.
  const dl = dlForm === 'cancel' ? { face: <StopIcon className={ICON} />, tip: t('card.tip_stop_dl'), shift: null }
    : dlForm === 'pending' ? { face: '…', tip: view.download.tip, shift: view.download.shift }
    : dlForm === 'done' ? { face: '✓', tip: view.download.tip, shift: view.download.shift }
    : { face: view.canDownload ? <Faces rest={<DownloadIcon className={ICON} />} shift={<UploadIcon className={ICON} />} /> : <UploadIcon className={ICON} />,
      tip: view.download.tip, shift: view.download.shift };
  const trDone = view.translated || trForm === 'done';
  const tr = trForm === 'cancel' ? { face: <StopIcon className={ICON} />, tip: t('card.tip_cancel'), shift: null, alt: null }
    : { face: <Faces rest={<TranslateIcon className={ICON} />} shift={view.translate.shift ? <RevertIcon className={ICON} /> : undefined} />,
      tip: view.translate.tip, shift: view.translate.shift, alt: view.translate.alt };

  return (
    <>
      <Button variant="overlay" size="icon-sm" coarse="36" type="button" className={cn('card-fav absolute top-[8px] right-[8px] z-[7]', view.favorite && 'on')}
        aria-pressed={view.favorite} aria-label={view.fav.tip} data-tip={view.fav.tip} data-tip-alt={view.fav.alt} onClick={onFav}>
        <HeartIcon className={cn(ICON, view.favorite && 'fill-current')} />
      </Button>
      <div className={cn('card-body', shown && 'downloading')}>
        <div className="card-id-row">
          <Button variant="ghost" size="icon-2xs" type="button" className="card-btn card-btn-open hover:bg-transparent" data-id={id}
            aria-label={view.open.tip} data-tip={view.open.tip} data-tip-shift={view.open.shift ?? undefined} data-tip-alt={view.open.alt ?? undefined} onClick={onOpen}>
            <OpenFace view={view} />
          </Button>
          {/* Safe Mode: its words in place of the id's, and no link (nothing of the address in the page). */}
          {view.idHref
            ? <a className={cn('card-id', view.local && 'local')} href={view.safe ? undefined : view.idHref} target="_blank" rel="noopener noreferrer" data-original={view.idText}>{view.safe?.idText ?? view.idText}</a>
            : <div className={cn('card-id', view.local && 'local')} data-original={view.idText}>{view.safe?.idText ?? view.idText}</div>}
          <div className="card-actions">
            <Button variant="quiet" tone={dlForm === 'done' ? 'success' : 'warning'} rest={dlForm === 'done' ? 'framed' : 'tone'} hover="fill" size="icon" coarse="36" type="button"
              className={cn('card-btn card-btn-dl', dlForm === 'cancel' && 'cancelling', dlForm === 'done' && 'done')} data-id={id}
              disabled={dlForm === 'pending' || dlForm === 'busy'} aria-label={dl.tip} data-tip={dl.tip} data-tip-shift={dl.shift ?? undefined} onClick={onDownload}>
              {dl.face}
            </Button>
            {/* (No tone of its own: the brand's red said nothing here, §5.3 F60. Translated, it is green.) */}
            <Button variant="quiet" size="icon" coarse="36" type="button"
              className={cn('card-btn card-btn-translate', trForm === 'cancel' && 'cancelling', trDone && 'done text-success hover:text-success')} data-id={id}
              disabled={trForm === 'pending' || trForm === 'busy'} aria-label={tr.tip} data-tip={tr.tip} data-tip-shift={tr.shift ?? undefined} data-tip-alt={tr.alt ?? undefined}
              onClick={onTranslate} onContextMenu={onRerun}>
              {tr.face}
            </Button>
            <Button variant="quiet" tone="warning" size="icon" coarse="36" type="button" className="card-btn card-btn-export" data-id={id}
              disabled={exporting} aria-label={view.export.tip} data-tip={view.export.tip} data-tip-shift={view.export.shift} onClick={onExport}>
              {exporting ? '…' : <Faces rest={<ExportIcon className={ICON} />} shift={<ExportMetaIcon className={ICON} />} />}
            </Button>
            <Button variant="quiet" tone="danger" rest="tone" hover="fill" size="icon" coarse="36" type="button" className="card-btn card-btn-del" data-id={id}
              aria-label={view.remove.tip} data-tip={view.remove.tip} data-tip-shift={view.remove.shift} onClick={onRemove}>
              <Faces rest={<DeleteIcon className={ICON} />} shift={<QuickDeleteIcon className={ICON} />} />
            </Button>
          </div>
        </div>
        {view.title && <div className="card-title" data-original={view.title}>{view.safe?.title ?? view.title}</div>}
        <div className="card-meta">
          {view.pages.tip == null ? view.pages.text
            : <span className="card-pages" data-tip={view.pages.tip} data-tip-badge={view.pages.badge ?? undefined}>{view.pages.text}</span>}
          {' · '}
          <span className="card-size" data-tip={view.size.tip}>{view.size.text}</span>
          {view.missing != null && <>{' · '}<span className="card-missing">{view.missing}</span></>}
        </div>
        <div className="card-progress">
          <Progress value={bar} done={done} className="prog-track" indicatorClassName="prog-fill" aria-labelledby={labelId} />
          <span className="card-prog-label" id={labelId}>{label}</span>
        </div>
        <Tags id={id} tags={view.tags} shown={view.safe?.tags} on={on} />
      </div>
    </>
  );
});

function GalleryCardImpl({ view, cover, job = null, interrupted = false, lingerMs = JOB_LINGER_MS, pending = null, pendingLabel, exporting = false, holding, on = NO_HANDLERS, className, ...rest }: Props) {
  const t = useT();
  const id = view.id;
  const format: JobFormat = useMemo(() => ({ t, count: formatCount, bytes: formatBytes }), [t]);

  // What the job's news says, kept while news comes that a card doesn't draw.
  const drawnRef = useRef<Drawn | null>(null);
  // The hint of an interruption shows over no job, or over the last word of the one there when it was
  // said; news that comes after it shows in its place (1.3: whichever was said last).
  const interruptedKey = useMemo(() => (interrupted ? { before: job } : null), [interrupted]);   // eslint-disable-line react-hooks/exhaustive-deps
  let drawn: Drawn | null = null;
  const fromNews = job ? cardJob(job, format) : null;
  if (job && fromNews) drawn = { job: fromNews, key: job };
  else if (job && !fromNews) drawn = drawnRef.current;
  if (interruptedKey && (!drawn || (drawn.job.ended && job === interruptedKey.before))) drawn = { job: INTERRUPTED(typeof interrupted === 'string' ? interrupted : t('prog.interrupted')), key: interruptedKey };

  // A last word stays its while, then the card is at rest again.
  const [settled, setSettled] = useState<object | null>(null);
  const onRef = useRef(on);
  onRef.current = on;
  const endedKey = drawn?.job.ended ? drawn.key : null;
  useEffect(() => {
    if (!endedKey || settled === endedKey || !Number.isFinite(lingerMs)) return;
    const timer = setTimeout(() => { setSettled(endedKey); onRef.current.jobSettled?.(id); }, lingerMs);
    return () => clearTimeout(timer);
  }, [endedKey, settled, id, lingerMs]);
  const live = drawn && drawn.key !== settled ? drawn.job : null;

  // A cancelled job's word shows where its job showed; an error's bar stays where it was (empty, where
  // it had no figure yet: its motion stops, as 1.3's did).
  const wasShown = useRef(false);
  const barRef = useRef<number | null>(0);
  const shown = !!live && (live.shown || wasShown.current) || pending === 'download' || pending === 'translate';
  const bar = live ? (live.bar === undefined ? barRef.current ?? 0 : live.bar) : 0;
  const label = live ? live.label : pending === 'download' ? pendingLabel ?? t('prog.fetching_meta') : pending === 'translate' ? t('prog.translating') : '';
  useEffect(() => {
    drawnRef.current = drawn;
    wasShown.current = shown;
    barRef.current = live ? bar : 0;
  });

  // The buttons a job or a press holds: the latest news' own, another job's still running, a press.
  const dlForm = live?.hold === 'download' ? live.form : holding?.download ? buttonForm(holding.download) : pending === 'download' ? 'pending' : 'rest';
  const trForm = live?.hold === 'translate' ? live.form : holding?.translate ? buttonForm(holding.translate) : pending === 'translate' || pending === 'revert' ? 'pending' : 'rest';

  const coverDown = useCallback((e: PointerEvent<HTMLAnchorElement>) => {
    // The left button of a mouse or pen: a finger on a cover scrolls the library.
    if (e.button !== 0 || e.pointerType === 'touch') return;
    onRef.current.coverPointerDown?.(id, e);
  }, [id]);

  const src = cover === undefined ? view.cover.src : cover;
  return (
    <div className={cn('card', view.sfw && 'card-sfw', className)} data-gallery-id={id} {...rest}>
      <Cover id={id} href={view.href} src={src} expected={view.cover.expected || !!src} badge={view.series ? view.badge : ''} onPointerDown={coverDown} />
      <Rest view={view} on={on} shown={shown} bar={bar} done={!!live?.done} label={label} dlForm={dlForm} trForm={trForm} exporting={exporting} />
    </div>
  );
}

export const GalleryCard = memo(GalleryCardImpl);

// GalleryCard's specimens: the library's cards as the Phase 0 captures show them, drawn from the same
// galleries and pictures (gallery-card-fixture.ts), at the widths 1.3's grid gives a card (292.25 at
// 1280 in Chrome, 175.5 at 400, 178 on a 390 phone; Firefox's grid, with no scrollbar, gives 296 and
// 183): plain, a series by its chapters and by its volumes, empty (one the helper can fill, one not),
// a local import, files missing, a favourite, translated, a long title with twenty tags, a landscape
// cover, a cover on its way; hovered, keyboard-focused, Shift held over delete, Alt held over the
// source; no helper, no translation server; each quick-actions mode; a job of each kind, with no figure
// yet, done, failed, interrupted, the Stop it holds; Safe Mode over a safe and an unrated cover; the
// phone form at its widths. Each card sits in a grid element of its own that carries its modes; Shift
// held anywhere on the page turns the section's hovered buttons (one listener, the section's).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getLang } from '@lib/i18n.js';
import { GalleryCard, cardModes, type CardHandlers, type CardModes, type Pending } from '@/components/gallery-card';
import { cardView, type CardEnv, type CardGallery } from '@/lib/card-view';
import { CARD_FORMATS } from '@/lib/card-rules';
import type { JobNews } from '@/lib/job-view';
import { useT, type Translate } from '@/lib/i18n';
import { useShiftHeld } from '@/lib/modifiers';
import { GALLERIES, fixtureCovers, type FixtureName } from './gallery-card-fixture';
import { Section, Shape, tag, type State } from './specimen';

// A card's width in 1.3's grid.
export const CARD_WIDTH = { desktop: 292.25, narrow: 175.5, phone: 178 } as const;

// The site a gallery's source names, as the helper would describe it (a made-up one, its pages on
// this site: the app names no address of anyone else's).
const SITES: Record<string, { name: string; galleryUrl: string; canDownload: boolean }> = {
  'a.example': { name: 'Site One', galleryUrl: `${location.origin}/g/{id}`, canDownload: true },
};
const site = (helper: boolean): CardEnv['site'] => ({
  canDownload: (g) => helper && SITES[g.source ?? '']?.canDownload === true,
  name: (source) => (helper && SITES[source ?? '']?.name) || source || '',
  link: (g, page) => (g.sourceUrl as string) || (helper && SITES[g.source ?? '']?.galleryUrl.replace('{id}', String(g.sourceId || g.id)).replace('{page}', String(page))) || '',
  icon: () => '',
});

type EnvOptions = { helper?: boolean; seriesView?: 'chapters' | 'volumes' };
const envFor = (t: Translate, { helper = false, seriesView = 'chapters' }: EnvOptions = {}): CardEnv => ({
  t, lang: getLang(), ...CARD_FORMATS,
  prefs: { mergeSeries: true, bypassOverview: false, seriesView, hideAppLangFlag: true },
  site: site(helper),
});

// Galleries made from the fixture's for a state the fixture has no gallery in.
const TWENTY = Array.from({ length: 20 }, (_, i) => ({ type: 'tag', name: `tag number ${i + 1}` }));
const MADE: Record<string, CardGallery> = {
  local: { ...GALLERIES.small, id: '1790000001101', isLocalImport: true },
  missing: { ...GALLERIES.plain, id: '1790000001102', missing: true },
  downloadable: { ...GALLERIES.pageless, id: '1790000001103', source: 'a.example', sourceId: '48214', sourceUrl: '' },
  longTags: { ...GALLERIES.long, id: '1790000001104', tags: [...GALLERIES.long.tags, ...TWENTY].slice(0, 20), favorite: false },
};

type Spec = {
  variant: string;
  state?: State;
  g: FixtureName | keyof typeof MADE;
  cover?: FixtureName | null;            // whose cover it shows (its own, by default)
  env?: EnvOptions;
  modes?: CardModes;
  width?: number;
  job?: JobNews;
  interrupted?: boolean;
  pending?: Pending;
  shift?: boolean;                       // Shift held (the grid's class)
  force?: Record<string, string>;        // a part of the card, forced into a state: selector → data-force
  note: string;
};

// The galleries the captures' first rows show, as 1.3's library-default draws them.
const AT_REST: Spec[] = [
  { variant: 'tagged', g: 'tagged', note: 'many tags (one row at rest)' },
  { variant: 'long', g: 'long', note: 'a favourite, a long title, a flag' },
  { variant: 'landscape', g: 'landscape', note: 'a landscape cover: the glow' },
  { variant: 'series', g: 'series', note: 'a series, by its chapters' },
  { variant: 'translated', g: 'translated', note: 'translated' },
  { variant: 'reading', g: 'reading', note: 'a favourite' },
  { variant: 'korean', g: 'korean', note: 'a flag' },
  { variant: 'sourced', g: 'sourced', note: 'a source with a link (the id), no icon cached' },
  { variant: 'pageless', g: 'pageless', note: 'empty, nothing to download from: 📁' },
  { variant: 'plain', g: 'plain', note: 'plain' },
  { variant: 'chinese', g: 'chinese', note: 'a flag' },
  { variant: 'small', g: 'small', note: 'one small page' },
];

const MORE: Spec[] = [
  { variant: 'series-volumes', g: 'series', env: { seriesView: 'volumes' }, note: 'a series, by its volumes (the overview\'s choice)' },
  { variant: 'empty-downloadable', g: 'downloadable', cover: null, env: { helper: true }, modes: { quickActions: 'always' }, note: 'empty, the helper can fill it: download' },
  { variant: 'local', g: 'local', cover: 'small', note: 'a local import' },
  { variant: 'missing', g: 'missing', cover: 'plain', note: 'files missing' },
  { variant: 'long-tags', g: 'longTags', cover: 'long', state: 'hover', note: 'a long title and twenty tags, hovered' },
  { variant: 'no-cover', g: 'plain', cover: null, note: 'a cover on its way' },
];

const POINTER: Spec[] = [
  { variant: 'tagged', state: 'hover', g: 'tagged', note: 'hovered (library-card-hover)' },
  { variant: 'plain', state: 'focus', g: 'plain', force: { '.card-btn-dl': 'focus-visible' }, note: 'a button keyboard-focused: the actions show' },
  { variant: 'translated-shift', state: 'hover', g: 'translated', shift: true, force: { '.card-btn-del': 'hover' }, note: 'Shift held over delete (library-shift-held)' },
  { variant: 'sourced-alt', state: 'hover', g: 'sourced', force: { '.card-btn-open': 'hover' }, note: 'Alt held over the source: its tip alone changes (library-alt-held)' },
  { variant: 'translated-offline', state: 'hover', g: 'translated', modes: { translatorOffline: true }, note: 'no translation server: no translate (library-card-hover-offline)' },
  { variant: 'sourced-helper', state: 'hover', g: 'sourced', env: { helper: true }, note: 'the helper there: download, its tip' },
];

const QUICK: Spec[] = [
  { variant: 'quick-hover', g: 'plain', note: 'on hover (the default), at rest: none' },
  { variant: 'quick-always', g: 'plain', modes: { quickActions: 'always' }, note: 'always' },
  { variant: 'quick-hidden', state: 'hover', g: 'plain', modes: { quickActions: 'hidden' }, note: 'never, hovered' },
];

const JOBS: Spec[] = [
  { variant: 'job-download', g: 'landscape', job: { gid: GALLERIES.landscape.id, kind: 'download', status: 'progress', done: 1, total: 4 }, note: 'a download, 1 of 4 (library-job-progress)' },
  { variant: 'job-translate', g: 'translated', job: { gid: GALLERIES.translated.id, kind: 'translate', status: 'progress', pct: 40, labelKey: 'prog.translating' }, note: 'a translation, 40% (library-job-progress)' },
  { variant: 'job-download-stop', state: 'hover', g: 'landscape', job: { gid: GALLERIES.landscape.id, kind: 'download', status: 'progress', done: 1, total: 4 }, note: 'hovered: its Stop' },
  { variant: 'job-translate-stop', state: 'hover', g: 'translated', job: { gid: GALLERIES.translated.id, kind: 'translate', status: 'progress', pct: 40, labelKey: 'prog.translating' }, note: 'hovered: its Stop' },
  { variant: 'job-upload', state: 'hover', g: 'plain', job: { gid: GALLERIES.plain.id, kind: 'upload', status: 'progress', done: 2, total: 3 }, note: 'an import: its button off' },
  { variant: 'job-sync', state: 'hover', g: 'series', job: { gid: GALLERIES.series.id, kind: 'sync', status: 'progress', done: 2, total: 7 }, note: 'a series\' sync: holds no button' },
  { variant: 'job-unknown', g: 'plain', job: { gid: GALLERIES.plain.id, kind: 'download', status: 'downloading', downloaded: 120 * 1024 }, note: 'no figure yet' },
  { variant: 'job-done', state: 'hover', g: 'plain', job: { gid: GALLERIES.plain.id, kind: 'download', status: 'done', done: 3, total: 3 }, note: 'a download done: ✓' },
  { variant: 'job-translated', state: 'hover', g: 'translated', job: { gid: GALLERIES.translated.id, kind: 'translate', status: 'done', done: 3, total: 3 }, note: 'a translation done' },
  { variant: 'job-error', state: 'hover', g: 'plain', job: { gid: GALLERIES.plain.id, kind: 'download', status: 'error', errorKey: 'prog.cancelled' }, note: 'failed' },
  { variant: 'job-interrupted', g: 'plain', interrupted: true, note: 'interrupted' },
  { variant: 'pending-download', state: 'hover', g: 'downloadable', cover: null, env: { helper: true }, pending: 'download', note: 'pressed, no word yet' },
];

const SAFE: Spec[] = [
  { variant: 'safe-rated', g: 'long', modes: { safeMode: true }, note: 'Safe Mode, rated safe: as it is' },
  { variant: 'safe-unrated', g: 'plain', modes: { safeMode: true }, note: 'Safe Mode, unrated: blurred' },
  { variant: 'safe-placeholder', g: 'pageless', modes: { safeMode: true }, note: 'Safe Mode, no cover' },
];

const PHONE: Spec[] = [
  { variant: 'narrow-tagged', g: 'tagged', width: CARD_WIDTH.narrow, modes: { narrow: true }, note: '400 wide: two to a row' },
  { variant: 'narrow-long', g: 'long', width: CARD_WIDTH.narrow, modes: { narrow: true }, note: '400 wide' },
  { variant: 'narrow-tagged-hover', state: 'hover', g: 'tagged', width: CARD_WIDTH.narrow, modes: { narrow: true }, note: '400 wide, hovered: the actions a row of their own' },
  { variant: 'phone-tagged', g: 'tagged', width: CARD_WIDTH.phone, modes: { narrow: true }, note: 'a 390 phone' },
  { variant: 'phone-series', g: 'series', width: CARD_WIDTH.phone, modes: { narrow: true }, note: 'a 390 phone' },
];

const gallery = (name: Spec['g']): CardGallery => (name in MADE ? MADE[name as keyof typeof MADE] : GALLERIES[name as FixtureName]);

function Specimen({ spec, t, covers }: { spec: Spec; t: Translate; covers: Partial<Record<FixtureName, string>> }) {
  const g = gallery(spec.g);
  const coverOf = spec.cover === undefined ? (spec.g in GALLERIES ? spec.g as FixtureName : null) : spec.cover;
  const cover = coverOf ? covers[coverOf] ?? null : null;
  const view = useMemo(() => cardView(g, cover, envFor(t, spec.env)), [g, cover, t, spec.env]);
  const ref = useRef<HTMLDivElement>(null);
  // A part held in a state (a button hovered or focused), as data-force does for a whole specimen.
  useEffect(() => {
    const root = ref.current;
    if (!root || !spec.force) return;
    const forced = Object.entries(spec.force).map(([sel, state]) => { const el = root.querySelector(sel); el?.setAttribute('data-force', state); return el; });
    return () => { for (const el of forced) el?.removeAttribute('data-force'); };
  }, [spec.force]);
  const state = spec.state ?? 'rest';
  const tags = tag('gallery-card', spec.variant, state);
  // Keyboard focus inside the card: what the actions' reveal answers.
  if (state === 'focus') tags['data-force'] = 'focus-within';
  return (
    <div className="flex flex-col gap-[4px]" style={{ width: spec.width ?? CARD_WIDTH.desktop }}>
      <div ref={ref} className={spec.shift ? 'shift-held' : undefined} data-card-modes={cardModes(spec.modes ?? {})} data-card-grid="">
        <GalleryCard view={view} job={spec.job ?? null} interrupted={spec.interrupted} pending={spec.pending ?? null} lingerMs={Infinity} {...tags} />
      </div>
      <span className="text-10 text-muted-dim">{spec.variant} · {state} — {spec.note}</span>
    </div>
  );
}

function Row({ label, specs, t, covers }: { label: string; specs: Spec[]; t: Translate; covers: Partial<Record<FixtureName, string>> }) {
  return (
    <div className="flex flex-col gap-[8px]">
      <span className="text-11 text-muted-dim">{label}</span>
      <div className="flex flex-wrap items-start gap-[16px]">
        {specs.map((spec) => <Specimen key={`${spec.variant}/${spec.state ?? 'rest'}`} spec={spec} t={t} covers={covers} />)}
      </div>
    </div>
  );
}

// A card the browser test drives (app/tests/browser/ui-gallery-card.browser.mjs): what it shows is
// set by a 'gallery-card-drive' event on the window (its detail: g, a fixture gallery's name or a
// gallery; cover, a fixture's name or null; job, interrupted, pending, lingerMs, env, modes), and each
// handler's call is kept, with what it was given, in window.__galleryCardCalls.
const HANDLERS = ['favorite', 'searchFavorite', 'openSource', 'editSource', 'searchSource', 'download', 'replace', 'stopDownload', 'translate', 'revert',
  'cancelTranslate', 'searchTranslated', 'rerun', 'export', 'exportMetadata', 'remove', 'quickRemove', 'tag', 'removeTag', 'flag', 'removeFlag', 'addTag',
  'coverPointerDown', 'jobSettled'] as const;
type Drive = { g: FixtureName | CardGallery; cover: FixtureName | null; job: JobNews | null; interrupted: boolean; pending: Pending; lingerMs?: number; env: EnvOptions; modes: CardModes };
const record = (name: string) => (...args: unknown[]) => {
  const calls = ((window as unknown as { __galleryCardCalls?: unknown[][] }).__galleryCardCalls ??= []);
  calls.push([name, ...args.map((a) => (a instanceof HTMLElement ? `element:${a.className.split(' ').find((c) => c.startsWith('card-btn-')) ?? a.localName}` : a && typeof a === 'object' && 'nativeEvent' in a ? `event:${(a as unknown as { type: string }).type}` : a))]);
};
const RECORDING = Object.fromEntries(HANDLERS.map((n) => [n, record(n)])) as unknown as CardHandlers;
function Driven({ t, covers }: { t: Translate; covers: Partial<Record<FixtureName, string>> }) {
  const [drive, setDrive] = useState<Drive>({ g: 'plain', cover: 'plain', job: null, interrupted: false, pending: null, env: {}, modes: {} });
  useEffect(() => {
    const on = (e: Event) => setDrive((d) => ({ ...d, ...(e as CustomEvent<Partial<Drive>>).detail }));
    window.addEventListener('gallery-card-drive', on);
    return () => window.removeEventListener('gallery-card-drive', on);
  }, []);
  const g = typeof drive.g === 'string' ? GALLERIES[drive.g] : drive.g;
  const cover = drive.cover ? covers[drive.cover] ?? null : null;
  const view = useMemo(() => cardView(g, cover, envFor(t, drive.env)), [g, cover, t, drive.env]);
  return (
    <div className="flex flex-col gap-[4px]" style={{ width: CARD_WIDTH.desktop }}>
      <div data-card-modes={cardModes(drive.modes)} data-card-grid="">
        <GalleryCard view={view} job={drive.job} interrupted={drive.interrupted} pending={drive.pending} lingerMs={drive.lingerMs} on={RECORDING} {...tag('gallery-card', 'driven', 'rest')} />
      </div>
      <span className="text-10 text-muted-dim">driven · rest — the browser test's card, its handlers recorded</span>
    </div>
  );
}

export function GalleryCardSpecimens() {
  const t = useT();
  const [covers, setCovers] = useState<Partial<Record<FixtureName, string>>>({});
  useEffect(() => {
    let live = true;
    fixtureCovers().then((made) => { if (live) setCovers(made); }).catch(() => {});
    return () => { live = false; };
  }, []);
  // Some seventy cards: drawn a frame after the page, so the page itself shows as soon as before.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const root = useRef<HTMLDivElement>(null);
  useShiftHeld(root);
  const rows: [string, Spec[]][] = [
    ['At rest, as the library\'s first page shows them', AT_REST], ['More galleries', MORE], ['Under the pointer and the keyboard', POINTER],
    ['Quick actions', QUICK], ['Jobs', JOBS], ['Safe Mode', SAFE], ['The phone form', PHONE],
  ];
  return (
    <Section id="gallery-card" title="Gallery card">
      <div ref={root} className="flex flex-col gap-[16px]" data-covers={drawn && Object.keys(covers).length ? 'ready' : 'coming'}>
        <Shape id="gallery-card" name="Gallery card" used="The library's grid: a gallery's cover, its id and source, its quick actions, title, pages and size, a job's bar, its tags.">
          {drawn && rows.map(([label, specs]): ReactNode => <Row key={label} label={label} specs={specs} t={t} covers={covers} />)}
          {drawn && (
            <div className="flex flex-col gap-[8px]">
              <span className="text-11 text-muted-dim">Driven by the browser test</span>
              <Driven t={t} covers={covers} />
            </div>
          )}
        </Shape>
      </div>
    </Section>
  );
}

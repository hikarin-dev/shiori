// Settings → Storage → Library storage, the panel's first card: where the library is kept. A site
// chooses at its top between this browser's library and the desktop app's (with what this browser still
// holds, to move or delete); under it the places the library keeps galleries in, each a row: its name,
// what it is, its galleries and size, its marks (the default, hidden, waiting for leave, out of reach,
// another library's, used by another app), what it is doing as its task says, its Needs attention
// lines, a button (Allow, Take back) and its menu. "Add folder" under the list (the row shows at once and
// fills in); the header's button checks every folder. A browser that can't pick folders says so; a
// library the desktop app keeps, seen from a site, shows only the location. In the desktop app's window,
// a card after it says when and how galleries left alone are archived.
//
// What a row says, what its menu offers and asks, and the card's flow are app/js/folder-card.js's (1.3's
// page draws from it too); the location's, app/js/desktop-link.js's. Every question is notice.js's.
//
// Drawn as 1.3's (settings.css .lf-*): the location a field row; the list 16px 20px 18px in (14px 15px
// 16px in a panel of 480px or less), rows 8px apart, each an inset panel (11px 10px 11px 12px; a 32px
// icon box, 12px gaps); a name 12.5px semibold, what it is 11px muted, the place's location in the
// browser's code face 10.5px; a task's bar 60–180px wide beside its line (under it, at 480px or less).
// §5.3 S04: the row's buttons 28 (30); S05: "Add folder" 36 (40); S11, S13: their text 11 and 12px, the
// plus 14; S02: the location's track 36 (40); S15/F20: the marks one pill of 20px, weight 400 (600 in a
// name, 21.9px); F22: a task's bar with no figure yet the one travelling block; F24: the icon box's
// radius 8 (7); F30, F39: the menu's keyboard. The icons are 1.3's own drawings.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import * as api from '@lib/api.js';
import * as folderCard from '@lib/folder-card.js';
import { chooseBrowser, chooseDesktop, deleteLeft, locationView, moveLeft, retryDesktop } from '@lib/desktop-link.js';
import { formatCount } from '@lib/format.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { Progress } from '@/components/ui/progress';
import { Select } from '@/components/ui/select';
import { SettingRow } from '@/components/ui/setting-row';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Section, SectionStatus, useStatus } from './parts';

type Place = { id: string; kind: 'browser' | 'folder'; name?: string; path?: string; ghost?: boolean } & Record<string, unknown>;
type Row = {
  id: string; kind: string; ghost: boolean; hidden: boolean; name: string; where: string; counts: string;
  badges: { text: string; warn: boolean; tip: string }[]; button: [string, string] | null; busy: boolean; actions: number;
  attention: { reason: string; text: string; path: string; more: number; del: boolean }[];
};
type Item = { label: string; danger?: boolean; run: () => void } | '-';
type Card = {
  subscribe(listener: () => void): () => void;
  get(): { rows: Place[]; rescanHidden: boolean };
  row(f: Place): Row;
  job(id: string): { pct: number | null; text: string };
  menu(f: Place): Item[];
  place(id: string): Place | null;
  act(id: string, action: string, reason?: string): Promise<void>;
  pick(): Promise<void>;
  rescanAll(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
};
type Shape = { manage: 'pick' | 'path' | null; readOnly: boolean; withLocation: boolean; shown: boolean };
type Say = (text: string, tone?: 'ok' | 'err') => void;

const STATUS_MS = 8000;   // the card's status line stays this long (1.3's)

// 1.3's drawings (library-folders.js ICON).
const Svg = ({ children, className }: { children: ReactNode; className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{children}</svg>
);
const FolderIcon = () => <Svg className="size-[16px]"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>;
const BrowserIcon = () => <Svg className="size-[16px]"><ellipse cx="12" cy="5.5" rx="8" ry="2.5" /><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13" /><path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" /></Svg>;
const MoreIcon = () => <Svg><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></Svg>;
const RescanIcon = () => <Svg><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" /></Svg>;
const PlusIcon = () => <Svg><path d="M12 5v14" /><path d="M5 12h14" /></Svg>;

// The place's location in the browser's code face, as 1.3 set it (the text colour, 10.5px).
const Code = ({ children }: { children: ReactNode }) => <code className="text-10.5 text-foreground">{children}</code>;

// The card's flow (folder-card.js), followed while the page shows.
function useFolderCard(say: Say): [Card, ReturnType<Card['get']>] {
  const sayRef = useRef(say);
  sayRef.current = say;
  const [card] = useState(() => (folderCard.createFolderCard as unknown as (o: { status: Say }) => Card)({ status: (text, tone) => sayRef.current(text, tone) }));
  useEffect(() => { card.start(); return () => card.stop(); }, [card]);
  return [card, useSyncExternalStore(card.subscribe, card.get)];
}

export function FoldersSection() {
  const t = useT();
  const [shape] = useState(() => folderCard.cardShape() as Shape);
  const [status, show] = useStatus(STATUS_MS);
  const [located, setLocated] = useState(false);
  if (!shape.shown) return null;
  const location = shape.withLocation ? <Location show={show} onShown={setLocated} /> : null;
  const end = <SectionStatus id="lfStatus" status={status} />;
  if (shape.readOnly) return <Section id="foldersSection" title={t('lf.card_title')}>{location}{end}</Section>;
  return <Places shape={shape} show={show} location={location} ruled={!!location && located} end={end} />;
}

// The card with the library's places (its flow runs only where the library has places of its own):
// the header's check of every folder, off while it runs and hidden while there is none to check; the
// list; Add folder (or what this browser is told).
function Places({ shape, show, location, ruled, end }: { shape: Shape; show: Say; location: ReactNode; ruled: boolean; end: ReactNode }) {
  const t = useT();
  const [card, state] = useFolderCard(show);
  const [checking, setChecking] = useState(false);
  const rescan = shape.manage ? (
    <Button id="lfRescan" variant="ghost" size="icon" hidden={state.rescanHidden} disabled={checking} data-tip={folderCard.rescanTip()} aria-label={t('lf.rescan')}
      className={cn('lf-rescan-all -mt-[6px] -mb-[5px] ml-auto', state.rescanHidden && 'hidden')}
      onClick={async () => { setChecking(true); try { await card.rescanAll(); } finally { setChecking(false); } }}>
      <RescanIcon />
    </Button>
  ) : null;
  return (
    <Section id="foldersSection" title={t('lf.card_title')} aside={rescan}>
      {location}
      <div className={cn('lf-folders grid gap-[10px] px-[20px] pt-[16px] pb-[18px] @max-[480.02px]/settings-panel:px-[15px] @max-[480.02px]/settings-panel:pt-[14px] @max-[480.02px]/settings-panel:pb-[16px]',
        ruled && 'border-0 border-t border-solid border-border')}>
        <div className="lf-head flex min-w-0 flex-wrap items-baseline justify-between gap-x-[12px] gap-y-[2px]">
          <span className="lf-head-title text-12 font-semibold text-foreground">{t('lf.title')}</span>
          <span className="lf-head-hint text-11 text-muted-foreground">{t('lf.desc')}</span>
        </div>
        <div className="lf-list grid gap-[8px]" id="lfRows">
          {state.rows.map((f) => <FolderRow key={f.id} card={card} place={f} />)}
        </div>
        {shape.manage
          ? <Button id="lfAdd" variant="dashed" className="lf-add" onClick={() => card.pick()}><PlusIcon /><span>{t('lf.add')}</span></Button>
          : <div className="lf-note text-11 leading-[1.5] text-muted-foreground">{t(folderCard.unsupportedKey())}</div>}
      </div>
      {end}
    </Section>
  );
}

function FolderRow({ card, place }: { card: Card; place: Place }) {
  const t = useT();
  const v = card.row(place);
  const job = v.busy ? card.job(v.id) : null;
  const items = v.actions ? card.menu(place) : [];
  return (
    <Card variant="inset" data-folder={v.id}
      className={cn('lf-item grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[12px] py-[11px] pr-[10px] pl-[12px]', v.busy && 'busy', v.hidden && 'is-hidden')}>
      <span className="lf-icon grid size-[32px] place-items-center rounded-8 border border-solid border-border bg-secondary text-muted-foreground">
        {v.kind === 'browser' ? <BrowserIcon /> : <FolderIcon />}
      </span>
      <div className="lf-main grid min-w-0 gap-[3px]">
        <div className="lf-name flex min-w-0 flex-wrap items-center gap-x-[8px] gap-y-[4px] text-12.5 leading-[1.4] font-semibold text-foreground">
          <span className={cn('lf-title min-w-0 [overflow-wrap:anywhere]', v.hidden && 'text-muted-foreground')}>{v.name}</span>
          {v.badges.map((b) => (
            <Badge key={b.text} variant="status" size="sm" tone={b.warn ? 'warning' : 'neutral'} data-tip={b.tip || undefined}
              className={cn('key-status-badge', b.warn && 'unset')}>{b.text}</Badge>
          ))}
        </div>
        {(v.where || v.counts) && (
          <div className={cn('lf-meta min-w-0 text-11 leading-[1.5] text-muted-foreground [overflow-wrap:anywhere]', v.hidden && '[&_code]:text-muted-foreground')}>
            {v.where && <Code>{v.where}</Code>}{v.where && v.counts && ' · '}{v.counts}
          </div>
        )}
        {job && (
          <div className="lf-job mt-[3px] grid min-w-0 grid-cols-[minmax(60px,180px)_minmax(0,1fr)] items-center gap-[10px] @max-[480.02px]/settings-panel:grid-cols-[minmax(0,1fr)] @max-[480.02px]/settings-panel:gap-[4px]">
            <Progress value={job.pct} aria-label={job.text || v.name} className="lf-bar" />
            <span className="lf-job-text min-w-0 truncate text-11 text-muted-foreground @max-[480.02px]/settings-panel:whitespace-normal">{job.text}</span>
          </div>
        )}
        {v.attention.length > 0 && (
          <div className="lf-att mt-[4px] grid min-w-0 gap-[3px]">
            <span className="lf-att-title text-11 font-semibold text-foreground">{t('lf.attention')}</span>
            <ul className="lf-att-list m-0 grid min-w-0 list-none gap-[4px] p-0">
              {v.attention.map((a) => (
                <li key={a.reason} className="lf-att-item flex min-w-0 flex-wrap items-center justify-between gap-x-[8px] gap-y-[4px]">
                  <span className="lf-att-text min-w-0 text-11 leading-[1.5] text-muted-foreground [overflow-wrap:anywhere]">
                    {a.text}{a.path && <>{' · '}<Code>{a.path}</Code>{a.more > 0 && ` (+${formatCount(a.more)})`}</>}
                  </span>
                  <span className="lf-att-acts flex flex-wrap gap-[4px]">
                    {a.del && <Button variant="subtle" size="sm" data-act="att-delete" data-reason={a.reason} onClick={() => card.act(v.id, 'att-delete', a.reason)}>{t('lf.att_delete')}</Button>}
                    <Button variant="subtle" size="sm" data-act="att-dismiss" data-reason={a.reason} onClick={() => card.act(v.id, 'att-dismiss', a.reason)}>{t('lf.att_dismiss')}</Button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {(v.button || v.actions > 0) && (
        <div className="lf-actions flex items-center gap-[4px]">
          {v.button && <Button variant="subtle" size="sm" data-act={v.button[0]} onClick={() => card.act(v.id, v.button![0])}>{v.button[1]}</Button>}
          {v.actions > 0 && (
            <Menu>
              <MenuTrigger render={<Button variant="ghost" size="icon" className="lf-more" data-act="more" aria-label={t('lf.more')} data-tip={t('lf.more')} />}>
                <MoreIcon />
              </MenuTrigger>
              <MenuContent align="end" sideOffset={4} className="lf-menu min-w-[170px] leading-[1.5]">
                {items.map((item, i) => (item === '-'
                  ? <MenuSeparator key={`sep-${i}`} />
                  : <MenuItem key={item.label} danger={item.danger} className={cn('ctx-menu-item', item.danger && 'danger')} onClick={() => item.run()}>{item.label}</MenuItem>))}
              </MenuContent>
            </Menu>
          )}
        </div>
      )}
    </Card>
  );
}

// Where the library is: this browser's or the desktop app's, as a choice of the two; continuing in
// this browser for now, Retry; on the desktop library, what this browser still holds, to move or
// delete. Read again as the language changes, as 1.3's was.
type LocationView = { saved: { url: string; token: string } | null; away: boolean; left: number; descKey: string; url: string };
function Location({ show, onShown }: { show: Say; onShown: (shown: boolean) => void }) {
  const t = useT();
  const [view, setView] = useState<LocationView | null>(null);
  const read = useCallback(() => (locationView() as Promise<LocationView>).then(setView), []);
  useEffect(() => {
    let live = true;
    (locationView() as Promise<LocationView>).then((v) => { if (live) setView(v); });
    return () => { live = false; };
  }, [t]);
  useEffect(() => { onShown(!!view); }, [view, onShown]);
  if (!view) return <div id="lfLocation" />;
  const { saved, away, left } = view;
  const row = 'lf-loc-row flex flex-wrap items-center justify-between gap-x-[12px] gap-y-[8px] px-[20px] pb-[14px] text-11 leading-[1.5] text-muted-foreground @max-[480.02px]/settings-panel:px-[15px] @max-[480.02px]/settings-panel:pb-[12px]';
  return (
    <div id="lfLocation">
      <SettingRow label={t('lf.location')} description={<>{t(view.descKey)}{view.url && <> <Code>{view.url}</Code></>}</>} control={(
        <ToggleGroup value={saved ? 'desktop' : 'browser'} className="choice-toggle lf-loc w-full"
          onValueChange={(v) => { if (v === 'desktop') chooseDesktop(show); else chooseBrowser(); }}>
          <ToggleGroupItem value="browser" data-loc="browser">{t('set.loc_browser')}</ToggleGroupItem>
          <ToggleGroupItem value="desktop" data-loc="desktop">{t('set.loc_desktop')}</ToggleGroupItem>
        </ToggleGroup>
      )} />
      {away && (
        <div className={row}><span /><Button id="locRetry" variant="subtle" size="sm" onClick={() => retryDesktop(saved)}>{t('set.loc_retry')}</Button></div>
      )}
      {left > 0 && (
        <div className={row}>
          <span>{t('set.loc_left', { n: formatCount(left) })}</span>
          <span className="desk-actions inline-flex gap-[8px]">
            <Button id="locMove" variant="subtle" size="sm" onClick={async () => { if (await moveLeft(saved, left, show)) read(); }}>{t('set.loc_move')}</Button>
            <Button id="locDelete" variant="danger-subtle" size="sm" onClick={async () => { if (await deleteLeft(left)) read(); }}>{t('set.loc_delete')}</Button>
          </span>
        </div>
      )}
    </div>
  );
}

// The desktop app's window: when and how galleries left alone are archived (its settings, through the
// window's bridge), a card after the library's.
type ArchiveState = { archiveAfter: string; archiveFormat: string };
const shell = (action: string, ...args: unknown[]) => (globalThis as unknown as { shioriDesktop: { shell(a: string, ...r: unknown[]): Promise<unknown> } }).shioriDesktop.shell(action, ...args);

export function ArchiveSection() {
  const t = useT();
  const [state, setState] = useState<ArchiveState | null>(null);
  useEffect(() => {
    if (!api.capabilities.desktopWindow) return;
    let live = true;
    (shell('state') as Promise<ArchiveState>).then((s) => { if (live) setState(s); }, () => {});
    return () => { live = false; };
  }, []);
  if (!state) return null;
  const set = async (key: string, value: string) => { const next = await shell('set', key, value) as ArchiveState; setState(next); };
  const after = Object.entries(folderCard.ARCHIVE_AFTER as Record<string, string>).map(([value, key]) => ({ value, label: t(key) }));
  const formats = (folderCard.ARCHIVE_FORMATS as string[]).map((value) => ({ value, label: t(`set.lib_export_${value}`) }));
  return (
    <Section id="archiveSection" title={t('lf.archive_title')}>
      <SettingRow label={t('set.desk_archive')} description={t('set.desk_archive_desc')}
        control={<Select id="deskArchiveAfter" data-value={state.archiveAfter} options={after} value={state.archiveAfter} onValueChange={(v) => set('archiveAfter', v)} />} />
      <SettingRow label={t('set.desk_archive_format')} description={t('set.desk_archive_format_desc')}
        control={<Select id="deskArchiveFormat" data-value={state.archiveFormat} options={formats} value={state.archiveFormat} onValueChange={(v) => set('archiveFormat', v)} />} />
    </Section>
  );
}

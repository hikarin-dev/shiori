// reader/settings.tsx — Reader settings (the top bar's gear, the rail's; 1.3 drew it in the reader's
// frame and bound it by hand in app/js/reader.js): Reading, Pages and Display, each setting applied at
// once. It shows the values the engine hands it and calls the engine's own functions to change them
// (./settings-store.ts); it keeps nothing of the engine's but the tab last shown.
//
// The app's sectioned Dialog (md 480) on the dialogs' layer, its header (title 15px, the corner X), its
// paddings (20; 14 on a phone) and the controls' stock sizes (D8, §5.3 S08, S09, S14, S21): the tabs are
// the segmented Tabs, the choices ToggleGroup's cards, the zoom NumberField, the sliders Slider, the
// switches Switch, the font Select, the (i) InfoTip, the key caps Kbd's outline.
//
// The box (the owner's rules, as 1.3's): laid out as tall as its tallest tab, every tab in one grid
// cell, and centred as that, so its top and its tabs never move from tab to tab; what shows is its
// header and the tab shown, which ends under its last setting: the room below a shorter tab is the
// backdrop's (a press there closes it). So the frame is drawn on those two pieces, not on the box. In a
// window too short for it the header stays and the tab shown scrolls under it on its own, its scrollbar
// inside its frame. On a phone (the Dialog's phone form, 520px and under) every tab reaches the box's
// foot. Its fonts' weights are asked for by the engine as it starts, so it opens at its size.
//
// The placement pickers (the navigation's place, the page bar, the auto-scroll bar) are the reader's
// own (no shared piece is this, and the Popover places by script): a button drawn as where the thing
// stands; a click opens its choices around it and a click picks; a press dragged onto a choice picks
// where it lets go, an edge with places showing them as the drag comes onto it; pressed again it puts
// them away; a press elsewhere, the tab scrolling or the window resizing put them away. Placed by CSS
// alone (anchored to the open button, clamped 71px inside the window); where the window leaves a button
// less room on its right than that, the place buttons stand in from the right by just what is missing.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { InfoTip } from '@/components/ui/info-tip';
import { Kbd } from '@/components/ui/kbd';
import { NumberField } from '@/components/ui/number-field';
import { Select } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsPanel, TabsPanels, TabsTab } from '@/components/ui/tabs';
import { Eyebrow } from '@/components/ui/text';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useT, type Translate } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getShown, getTab, registerParts, setTab, subscribe, type SettingsActions, type SettingsValues } from './settings-store';

// ── Icons (1.3's drawings: Lucide's lines) ──
function Ico({ children, className }: { children: ReactNode; className?: string }) {
  return <svg className={cn('shrink-0 fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]', className)} viewBox="0 0 24 24" aria-hidden="true">{children}</svg>;
}
const FRAME = <rect width="18" height="18" x="3" y="3" rx="2" />;
const BAR = 'stroke-3';   // the bar inside the screen outline
const ICON = {
  single: <><path d="M2 3v18" /><rect width="12" height="18" x="6" y="3" rx="2" /><path d="M22 3v18" /></>,
  double: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M12 3v18" /></>,
  strip: <><path d="M3 2h18" /><rect width="18" height="12" x="3" y="6" rx="2" /><path d="M3 22h18" /></>,
  off: <><rect width="18" height="18" x="3" y="3" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></>,
  width: <><path d="m18 8 4 4-4 4" /><path d="M2 12h20" /><path d="m6 8-4 4 4 4" /></>,
  height: <><path d="M12 2v20" /><path d="m8 18 4 4 4-4" /><path d="m8 6 4-4 4 4" /></>,
  ltr: <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
  rtl: <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>,
  top: <>{FRAME}<path className={BAR} d="M7.5 7.5h9" /></>,
  side: <>{FRAME}<path className={BAR} d="M16.5 7.5v6" /></>,
};
const GEAR = <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>;

// A window, with a bar along the whole of an edge or at a place along it; Off crosses it out.
const acrossEdge = (edge: string) => edge === 'top' || edge === 'bottom';
function PlaceIcon({ edge, along }: { edge: string; along?: string }) {
  if (edge === 'off') return <Ico className="size-[20px]">{FRAME}<path d="m3.5 3.5 17 17" /></Ico>;
  const at = edge === 'top' || edge === 'left' ? 7.5 : 16.5;
  const [from, len] = along ? [{ start: 7, center: 9.5, end: 12 }[along] ?? 7.5, 5] : [7.5, 9];
  return <Ico className="size-[20px]">{FRAME}<path className={BAR} d={acrossEdge(edge) ? `M${from} ${at}h${len}` : `M${at} ${from}v${len}`} /></Ico>;
}
// Along a top or bottom edge, its start is the left; along a side, the top.
function placeLabel(t: Translate, edge: string, along?: string) {
  const edgeLabel = t(`rd.${edge}`);
  if (!along) return edgeLabel;
  const alongLabel = t(along === 'center' ? 'rd.center'
    : acrossEdge(edge) ? (along === 'start' ? 'rd.left' : 'rd.right') : (along === 'start' ? 'rd.top' : 'rd.bottom'));
  return `${edgeLabel} · ${alongLabel}`;
}

// ── The placement pickers ──
// Its choices, each in its cell of the 3×3 around the button: a cross of the edges (the page bar's
// Off in a corner) and, for the navigation, once an edge is picked, the places along it: its start and
// end in the corners beside that edge, its centre on the edge's own cell.
const EDGE_CELL: Record<string, [number, number]> = { top: [0, -1], left: [-1, 0], right: [1, 0], bottom: [0, 1] };
const ALONG_CELL: Record<string, Record<string, [number, number]>> = {
  top: { start: [-1, -1], center: [0, -1], end: [1, -1] },
  bottom: { start: [-1, 1], center: [0, 1], end: [1, 1] },
  left: { start: [-1, -1], center: [-1, 0], end: [-1, 1] },
  right: { start: [1, -1], center: [1, 0], end: [1, 1] },
};
const ALONGS = ['start', 'center', 'end'];
type Spec = { id: string; edges: string[]; along?: boolean; off?: [number, number]; current: { edge: string; along?: string }; pick: (edge: string, along?: string) => void };
type Cell = { edge: string; along?: string; at: [number, number]; current: boolean; opens?: boolean };
function cellsOf(spec: Spec, shownEdge: string | null): Cell[] {
  const now = spec.current, cells: Cell[] = [];
  for (const edge of spec.edges) {
    if (spec.along && shownEdge === edge) {
      for (const along of ALONGS) cells.push({ edge, along, at: ALONG_CELL[edge][along], current: now.edge === edge && now.along === along });
    } else {
      cells.push({ edge, at: EDGE_CELL[edge], current: now.edge === edge, opens: !!spec.along });
    }
  }
  if (spec.off) cells.push({ edge: 'off', at: spec.off, current: now.edge === 'off' });
  return cells;
}
const PICK_ANCHOR = '--place-pick';
const cellUnder = (e: { clientX: number; clientY: number }) => document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-pick-cell]') ?? null;
const onButton = (btn: Element, e: { clientX: number; clientY: number }) => {
  const r = btn.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
};

type Open = { spec: Spec; edge: string | null };
function usePickers(byKeys: () => boolean) {
  const [open, setOpenState] = useState<Open | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const openRef = useRef<Open | null>(null);
  const press = useRef<{ id: number; opening: boolean; left: boolean } | null>(null);
  const ownClick = useRef(false);   // the click that ends a press on a picker's button is that press's
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const cells = useRef<HTMLDivElement>(null);
  // Drawn at once: what is under the pointer, or which cell takes the focus, is asked of the page next.
  const set = (next: Open | null) => { openRef.current = next; flushSync(() => { setOpenState(next); setHot(null); }); };
  // Put away with the dialog (from an effect: drawn with the next render, not at once).
  const drop = () => { if (!openRef.current) return; openRef.current = null; setOpenState(null); setHot(null); };
  const close = (refocus?: boolean) => {
    const was = openRef.current;
    if (!was) return;
    set(null);
    if (refocus && byKeys()) buttons.current.get(was.spec.id)?.focus();   // for the keyboard, back to its button
  };
  const openOn = (spec: Spec) => { set({ spec, edge: null }); };
  // A choice taken: clicked, an edge with places shows them; anything else, or a drag let go on an edge
  // (its centre), is picked.
  const take = (cell: HTMLElement, dragged: boolean) => {
    const now = openRef.current;
    if (!now) return;
    const { edge = '', along } = cell.dataset;
    if (cell.dataset.opens !== undefined && !dragged) {
      set({ spec: now.spec, edge });
      cells.current?.querySelector<HTMLElement>('[data-along="center"]')?.focus();
      return;
    }
    close(true);
    now.spec.pick(edge, along || (cell.dataset.opens !== undefined ? 'center' : undefined));
  };
  // A press anywhere else, the tab scrolling under it or the window resizing puts it away.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const target = e.target as Element | null;
      const now = openRef.current;
      if (now && !target?.closest?.('#rsPicker') && !buttons.current.get(now.spec.id)?.contains(target)) close();
    };
    const away = () => close();
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('resize', away);
    return () => { document.removeEventListener('pointerdown', down, true); window.removeEventListener('resize', away); };
  });
  const buttonProps = (spec: Spec) => ({
    ref: (el: HTMLButtonElement | null) => { if (el) buttons.current.set(spec.id, el); else buttons.current.delete(spec.id); },
    'aria-expanded': open?.spec.id === spec.id,
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      ownClick.current = false;
      if (e.button !== 0 || e.currentTarget.disabled) return;   // its row may be what is disabled
      const opening = openRef.current?.spec.id !== spec.id;
      if (opening) openOn(spec);
      // Until the pointer leaves the button it is a click on it, even with a choice drawn over it (near
      // the window's top or bottom the choices shift to stay inside it).
      press.current = { id: e.pointerId, opening, left: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const p = press.current, now = openRef.current;
      if (!p || !now || e.pointerId !== p.id) return;
      if (!p.left && onButton(e.currentTarget, e)) return;
      p.left = true;
      let cell = cellUnder(e);
      if (cell?.dataset.opens !== undefined && now.edge !== cell.dataset.edge) {
        set({ spec: now.spec, edge: cell.dataset.edge ?? null });   // dragged onto an edge: its places come up, the drag on its centre
        cell = cellUnder(e);
      }
      const key = cell ? `${cell.dataset.edge}:${cell.dataset.along ?? ''}` : null;
      if (key !== hot) setHot(key);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const p = press.current;
      if (!p || e.pointerId !== p.id) return;
      press.current = null;
      ownClick.current = true;
      if (!p.left) {   // a click on the button: it opened them, or puts them away again
        if (!p.opening) close();
        return;
      }
      const cell = cellUnder(e);
      if (cell) { take(cell, true); return; }
      if (!onButton(e.currentTarget, e)) close();   // let go anywhere else: nothing picked (back on the button, they stay)
    },
    onPointerCancel: () => { press.current = null; },
    // From the keyboard (or a click the press didn't make): open on the choice it is now, or close.
    onClick: () => {
      if (ownClick.current) { ownClick.current = false; return; }
      if (openRef.current?.spec.id === spec.id) { close(); return; }
      openOn(spec);
      (cells.current?.querySelector<HTMLElement>('[data-current]') ?? cells.current?.querySelector<HTMLElement>('[data-pick-cell]'))?.focus();
    },
  });
  return { open, hot, cells, close, drop, take, buttonProps, isOpen: () => !!openRef.current };
}

type Pickers = ReturnType<typeof usePickers>;

function PickerCells({ pickers, t }: { pickers: Pickers; t: Translate }) {
  const { open, hot } = pickers;
  if (!open) return null;
  return (
    <div
      id="rsPicker" ref={pickers.cells} role="menu" data-rs="picker"
      className="pointer-events-auto fixed z-[2] size-0 touch-none"
      style={{ positionAnchor: PICK_ANCHOR, left: 'clamp(71px, anchor(center), calc(100% - 71px))', top: 'clamp(71px, anchor(center), calc(100% - 71px))' } as CSSProperties}
      // Showing an edge's places takes the clicked cell out of the page: the click is the picker's.
      onClick={(e) => { const cell = (e.target as Element).closest<HTMLElement>('[data-pick-cell]'); if (cell) pickers.take(cell, false); }}
    >
      {cellsOf(open.spec, open.edge).map((c) => {
        const label = placeLabel(t, c.edge, c.along);
        const key = `${c.edge}:${c.along ?? ''}`;
        return (
          <button
            key={key} type="button" role="menuitem" data-pick-cell="" data-edge={c.edge} data-along={c.along} data-opens={c.opens ? '' : undefined}
            data-current={c.current ? '' : undefined} data-hot={hot === key ? '' : undefined} data-tip={label} aria-label={label}
            className={cn(PICK_BOX, 'absolute -translate-x-1/2 -translate-y-1/2 border-input bg-secondary shadow-[0_8px_22px_rgba(0,0,0,.5)]',
              'data-current:text-primary [&:is(:hover,[data-hot],:focus-visible)]:border-primary [&:is(:hover,[data-hot],:focus-visible)]:text-foreground',
              '[&[data-current]:is(:hover,[data-hot])]:text-primary')}
            style={{ left: c.at[0] * 44, top: c.at[1] * 44 }}
          >
            <PlaceIcon edge={c.edge} along={c.along} />
          </button>
        );
      })}
    </div>
  );
}

const PICK_BOX = 'grid size-[38px] cursor-pointer place-items-center rounded-8 border border-solid p-0 transition-[background-color,border-color,color] duration-fast ease-standard';

// A placement: what it is now, and a button showing it that opens the picker. The place buttons stand
// in from the right by just what the picker lacks: the button's centre is half its width in from the
// section's right edge, which is the box's left edge, its 1px frame, the tab's padding and the
// section's width (100cqw) in from the window's right edge (--settings-reach, the popup's).
function PlaceRow({ spec, label, pickers, disabled, t }: { spec: Spec; label: string; pickers: Pickers; disabled?: boolean; t: Translate }) {
  const open = pickers.open?.spec.id === spec.id;
  return (
    <div className={cn(ROW_INLINE, disabled && 'opacity-[.42]')} data-rs="row">
      <div className={LABEL} id={`${spec.id}Label`}>{label}</div>
      <div className="flex flex-none items-center gap-[10px]" style={{ marginRight: 'max(0px, 71px - 19px - (var(--settings-reach) - 1px - var(--settings-pad) - 100cqw))' }}>
        <span className="text-11 font-semibold whitespace-nowrap text-muted-foreground" id={`${spec.id}Value`}>{placeLabel(t, spec.current.edge, spec.current.along)}</span>
        <button
          type="button" id={spec.id} data-rs="pick" aria-haspopup="true" aria-labelledby={`${spec.id}Label ${spec.id}Value`} disabled={disabled}
          className={cn(PICK_BOX, 'border-border bg-surface-subtle text-muted-foreground disabled:cursor-default',
            'hover:not-disabled:border-input hover:not-disabled:text-foreground aria-expanded:border-input aria-expanded:text-foreground')}
          style={open ? ({ anchorName: PICK_ANCHOR } as CSSProperties) : undefined}
          {...pickers.buttonProps(spec)}
        >
          <PlaceIcon edge={spec.current.edge} along={spec.current.along} />
        </button>
      </div>
    </div>
  );
}

// ── Rows ──
// Sections are set apart by space and a quiet heading alone; every control sits straight on the box.
const SECTION = '[container-type:inline-size] [&+&]:mt-[22px]';
// A setting: its name over its control, or beside it; 16px after the setting before it.
const ROW = 'grid min-w-0 gap-[8px] [[data-rs=row]+&]:mt-[16px]';
const ROW_INLINE = 'flex min-w-0 items-center justify-between gap-[16px] [[data-rs=row]+&]:mt-[16px]';
const LABEL = 'text-11.5 font-semibold text-foreground';
const VALUE = 'text-11 text-muted-foreground tabular-nums';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section data-rs="section" className={SECTION}>
      <Eyebrow as="h3" tone="dim" data-rs="heading" className="mt-0 mb-[10px]">{title}</Eyebrow>
      {children}
    </section>
  );
}
function Name({ label, tip, kbd }: { label: string; tip?: string; kbd?: string }) {
  return (
    <div className={LABEL}>
      <span>{label}</span>
      {kbd && <Kbd variant="outline" className="ml-[7px] align-[1px]">{kbd}</Kbd>}
      {tip && <InfoTip tip={tip} />}
    </div>
  );
}
function SwitchRow({ id, label, tip, kbd, checked, onChange }: { id: string; label: string; tip?: string; kbd?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={ROW_INLINE} data-rs="row">
      <Name label={label} tip={tip} kbd={kbd} />
      <Switch id={id} aria-label={label} checked={checked} onCheckedChange={(on) => onChange(on)} />
    </div>
  );
}
function SliderRow({ id, label, value, shown, min, max, step, onChange }: { id: string; label: string; value: number; shown: string; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className={ROW} data-rs="row">
      {/* The value is held by its right edge, so a longer figure moves nothing but itself. */}
      <div className="flex items-center justify-between gap-[12px]">
        <span className={LABEL} id={`${id}Label`}>{label}</span>
        <output className={VALUE} id={`${id}Value`}>{shown}</output>
      </div>
      <Slider id={id} aria-labelledby={`${id}Label`} value={value} min={min} max={max} step={step} onValueChange={(v) => onChange(v as number)} />
    </div>
  );
}
// One choice of a few, as separate cards; each press is the engine's (a press on the chosen one too:
// Original size pressed again sets the zoom back to 100%, as 1.3's did).
function Choices({ value, size, attr, items, onPick, className }: {
  value: string; size?: 'default' | 'sm' | 'stack'; attr: string; className?: string;
  items: { value: string; label: string; icon?: ReactNode; kbd?: string }[]; onPick: (v: string) => void;
}) {
  return (
    <ToggleGroup variant="cards" size={size} value={value} className={className}>
      {items.map((item) => (
        <ToggleGroupItem key={item.value} value={item.value} {...{ [attr]: item.value }} onClick={() => onPick(item.value)}
          className={cn(size === 'stack' && 'max-[540.02px]:text-10')}>
          {item.kbd && <Kbd variant="outline" className="absolute top-[5px] right-[5px]">{item.kbd}</Kbd>}
          {item.icon}
          <span>{item.label}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
function Spread({ order }: { order: [string, string] }) {
  return (
    <span className="inline-flex flex-none gap-[2px]" aria-hidden="true">
      {order.map((n) => <i key={n} className="grid h-[15px] w-[11px] place-items-center rounded-2 border-[1.5px] border-solid border-current text-[8px] leading-none font-bold not-italic">{n}</i>)}
    </span>
  );
}

// ── The tabs ──
function Reading({ v, act, t }: { v: SettingsValues; act: SettingsActions; t: Translate }) {
  return (
    <>
      <Section title={t('rd.reader_mode')}>
        <Choices value={v.mode} size="stack" attr="data-reader-mode" onPick={act.mode} items={[
          { value: 'single', label: t('kb.single'), icon: <Ico>{ICON.single}</Ico>, kbd: '1' },
          { value: 'double', label: t('kb.double'), icon: <Ico>{ICON.double}</Ico>, kbd: '2' },
          { value: 'strip', label: t('kb.strip'), icon: <Ico>{ICON.strip}</Ico>, kbd: '3' },
        ]} />
      </Section>
      <Section title={t('rd.sec_view')}>
        <div className={ROW} data-rs="row">
          <div className={LABEL}>{t('rd.image_fit')}</div>
          <Choices value={v.fit} size="stack" attr="data-reader-fit" onPick={act.fit} items={[
            { value: 'off', label: t('rd.original_size'), icon: <Ico>{ICON.off}</Ico> },
            { value: 'width', label: t('kb.fit_width'), icon: <Ico>{ICON.width}</Ico>, kbd: 'Shift+E' },
            { value: 'height', label: t('kb.fit_height'), icon: <Ico>{ICON.height}</Ico>, kbd: 'Shift+Q' },
          ]} />
        </div>
        <div className={ROW_INLINE} data-rs="row">
          <div className={LABEL}>{t('rd.zoom')}</div>
          <NumberField id="readerZoom" aria-label={t('rd.zoom')} decrementLabel={t('rd.zoom_out')} incrementLabel={t('rd.zoom_in')}
            value={v.zoom.scale} min={v.zoom.min} max={v.zoom.max} step={0.1} format={{ style: 'percent', maximumFractionDigits: 0 }}
            onValueChange={(next) => { if (next != null && next !== v.zoom.scale) act.zoom(next > v.zoom.scale ? 1 : -1); }} />
        </div>
        <SliderRow id="readerGap" label={t('rd.page_gap')} value={v.gap} shown={`${v.gap} px`} min={0} max={40} step={1} onChange={act.gap} />
        <SliderRow id="readerDim" label={t('rd.dim_pages')} value={v.dim} shown={`${v.dim}%`} min={0} max={100} step={1} onChange={act.dim} />
      </Section>
      <Section title={t('rd.sec_autoplay')}>
        <SliderRow id="readerAutoScroll" label={t('rd.autoscroll_speed')} value={v.speed} shown={v.speedLabel} min={20} max={1000} step={10} onChange={act.speed} />
      </Section>
    </>
  );
}

function Pages({ v, act, t }: { v: SettingsValues; act: SettingsActions; t: Translate }) {
  return (
    <>
      {/* The two spread settings act in double page; they are set from any mode, the reading mode being on another tab. */}
      <Section title={t('rd.sec_turning')}>
        <div className={ROW} data-rs="row">
          <Name label={t('rd.nav_direction')} tip={t('rd.nav_direction_desc')} />
          <Choices value={v.navDirection} attr="data-nav-direction" onPick={act.navDirection} items={[
            { value: 'ltr', label: t('rd.left_to_right'), icon: <Ico>{ICON.ltr}</Ico> },
            { value: 'rtl', label: t('rd.right_to_left'), icon: <Ico>{ICON.rtl}</Ico> },
          ]} />
        </div>
        <div className={ROW} data-rs="row">
          <Name label={t('rd.page_direction')} tip={t('rd.page_direction_desc')} />
          <Choices value={v.pageDirection} attr="data-page-direction" onPick={act.pageDirection} items={[
            { value: 'ltr', label: t('rd.left_to_right'), icon: <Spread order={['1', '2']} /> },
            { value: 'rtl', label: t('rd.right_to_left'), icon: <Spread order={['2', '1']} /> },
          ]} />
        </div>
        <SwitchRow id="readerCoverOffset" label={t('rd.cover_offset')} kbd="C" tip={t('rd.cover_offset_desc')} checked={v.coverOffset} onChange={act.coverOffset} />
        <SwitchRow id="readerSmoothScroll" label={t('rd.smooth_scroll')} tip={t('rd.smooth_scroll_desc')} checked={v.smoothScroll} onChange={act.smoothScroll} />
      </Section>
      <Section title={t('rd.sec_chapters')}>
        <SwitchRow id="readerOverview" label={t('set.skip_overview')} tip={t('set.skip_overview_desc')} checked={v.overview} onChange={act.overview} />
        <SwitchRow id="readerStripFlow" label={t('set.strip_flow')} tip={t('set.strip_flow_desc')} checked={v.stripFlow} onChange={act.stripFlow} />
        <SwitchRow id="readerTransitions" label={t('set.ch_divider')} tip={t('set.ch_divider_desc')} checked={v.transitions} onChange={act.transitions} />
      </Section>
      <Section title={t('rd.sec_autoplay')}>
        <SwitchRow id="readerPauseOnUp" label={t('rd.pause_on_up')} tip={t('rd.pause_on_up_desc')} checked={v.pauseOnUp} onChange={act.pauseOnUp} />
      </Section>
    </>
  );
}

const FONTS = [
  { value: 'yasashisa', label: 'やさしさアンチック', className: "font-['Yasashisa_Antique',sans-serif]" },
  { value: 'kiwi', label: 'Kiwi Maru', className: "font-['Kiwi_Maru',sans-serif]" },
];

function Display({ v, act, t, pickers }: { v: SettingsValues; act: SettingsActions; t: Translate; pickers: Pickers }) {
  const ids = useId();
  const imageOrText = (value: string, image: string, attr: string, onPick: (v: string) => void) => (
    <Choices value={value} size="sm" attr={attr} onPick={onPick} items={[{ value: image, label: t('set.image') }, { value: 'text', label: t('set.text') }]} />
  );
  return (
    <>
      <Section title={t('rd.nav_bar')}>
        <div className={ROW} data-rs="row">
          <Choices value={v.nav} attr="data-reader-nav" onPick={act.nav} items={[
            { value: 'top', label: t('rd.nav_classic'), icon: <Ico>{ICON.top}</Ico> },
            { value: 'side', label: t('rd.nav_modern'), icon: <Ico>{ICON.side}</Ico> },
          ]} />
        </div>
        {/* Classic has no place: the row stays, greyed out, so nothing moves. */}
        <PlaceRow pickers={pickers} t={t} label={t('rd.nav_position')} disabled={v.off.navPlace}
          spec={{ id: 'readerNavPlace', edges: ['top', 'left', 'right', 'bottom'], along: true, current: v.navPlace, pick: act.navPlace }} />
      </Section>
      <Section title={t('rd.sec_bars')}>
        <PlaceRow pickers={pickers} t={t} label={t('rd.page_bar')}
          spec={{ id: 'readerProgress', edges: ['top', 'left', 'right', 'bottom'], off: [1, 1], current: { edge: v.progress }, pick: act.progress }} />
        <PlaceRow pickers={pickers} t={t} label={t('rd.auto_bar')}
          spec={{ id: 'readerAutoBar', edges: ['top', 'bottom'], current: { edge: v.autoBar }, pick: act.autoBar }} />
      </Section>
      <Section title={t('set.translation_short')}>
        <div className={ROW_INLINE} data-rs="row">
          <Name label={t('set.tr_display')} tip={t('set.tr_display_desc')} />
          {imageOrText(v.translateDisplay, 'image', 'data-translate-display', act.translateDisplay)}
        </div>
      </Section>
      <Section title={t('set.study')}>
        {/* Side by side, as in Settings: how the original shows, and the translation. */}
        <div className="grid grid-cols-2 gap-[20px]">
          <div className="grid min-w-0 content-start gap-[8px]" data-rs="col">
            <div className={LABEL}>{t('set.original')}</div>
            {imageOrText(v.study.original, 'image', 'data-study-original', (x) => act.study('original', x))}
            {/* The original as text has a font and furigana; as the image, neither applies. */}
            <div className={cn('grid min-w-0 gap-[8px]', v.off.studyText && 'opacity-[.42]')} data-rs="study-text" aria-disabled={v.off.studyText || undefined}>
              <Select id="readerStudyFont" aria-label={t('set.font')} options={FONTS} value={v.study.srcFont} disabled={v.off.studyText}
                onValueChange={(x) => act.study('srcFont', x)} className="data-disabled:opacity-100 disabled:opacity-100" />
              <div className="flex min-w-0 items-center justify-between gap-[16px]">
                <span className="text-11 font-semibold text-muted-foreground" id={`${ids}-furigana`}>{t('set.study_furi')}</span>
                <Switch id="readerFurigana" aria-labelledby={`${ids}-furigana`} checked={v.study.furigana} disabled={v.off.studyText}
                  onCheckedChange={(on) => act.study('furigana', on)} className="data-disabled:opacity-100" />
              </div>
            </div>
          </div>
          <div className="grid min-w-0 content-start gap-[8px]" data-rs="col">
            <div className={LABEL}>{t('set.translation_short')}</div>
            {imageOrText(v.study.display, 'hardcoded_images', 'data-study-display', (x) => act.study('display', x))}
          </div>
        </div>
      </Section>
      <Section title={t('rd.sec_debug')}>
        <SwitchRow id="readerDebugLoaded" label={t('rd.debug_loaded')} tip={t('rd.debug_loaded_desc')} checked={v.debugLoaded} onChange={act.debugLoaded} />
      </Section>
    </>
  );
}

// ── The keys it keeps ──
// The keys a focused control uses itself: a slider's arrows, Home, End and page keys (and the zoom's);
// a select's too, with Space and Enter; a tab's and a group of choices' arrows, Home and End; Space and
// Enter on a button or a switch. And every key while a picker or the select's list is open.
const SLIDER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const ROVING_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
function controlKey(el: Element, e: KeyboardEvent) {
  if (el.matches('input[type="range"], [data-slot="number-field"] input')) return SLIDER_KEYS.has(e.key);
  if (el.matches('[role="combobox"]')) return SLIDER_KEYS.has(e.key) || e.key === ' ' || e.key === 'Enter';
  if (el.matches('[role="tab"], [data-slot="toggle-group-item"]') && ROVING_KEYS.has(e.key)) return true;
  if (el.matches('[data-reader-part="settings"], [role="tabpanel"]')) return false;   // the box, or the tab shown, after a press on nothing in it
  return (e.key === ' ' || e.key === 'Enter') && el.matches('button, input, [tabindex], [role="switch"]');
}

export default function ReaderSettings() {
  const { open, values: v, actions: act } = useSyncExternalStore(subscribe, getShown);
  const t = useT();
  const [tab, setShownTab] = useState(getTab);
  const popup = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const pickers = usePickers(() => !!act?.byKeys());
  // Whether the last press was a key's or the pointer's: the close button shows the keyboard's ring only
  // after a key, as 1.3's did (rule 12).
  const byKey = useRef(false);
  useEffect(() => {
    const key = () => { byKey.current = true; };
    const pointer = () => { byKey.current = false; };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', pointer, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', pointer, true); };
  }, []);
  // A select's list of the dialog is open: its box says so while it shows.
  const listOpen = () => !!popup.current?.querySelector('[data-slot="select-trigger"][data-popup-open]');
  // What the engine asks of it (contains, escape, ownsKey), while it is drawn. The keys are judged as
  // they come (a capture on the window, before anything acts on them): a list closing on Escape stops
  // the key there, and anything else reaches the engine with what was open when it was pressed.
  const inner = useRef<{ event: KeyboardEvent | null; open: boolean }>({ event: null, open: false });
  useEffect(() => {
    if (!open) return;
    const note = (e: KeyboardEvent) => { inner.current = { event: e, open: pickers.isOpen() || listOpen() }; };
    window.addEventListener('keydown', note, true);
    const off = registerParts({
      contains: (el) => {
        const box = popup.current;
        if (!box) return false;
        // The box's layer (the backdrop's room around it), and a list of its select while it shows.
        return !!box.parentElement?.contains(el) || (listOpen() && !!el.closest('[data-slot="select-positioner"]'));
      },
      escape: () => {
        if (pickers.isOpen()) { pickers.close(true); return true; }
        return false;
      },
      ownsKey: (e) => {
        const was = inner.current.event === e ? inner.current.open : pickers.isOpen() || listOpen();
        if (was || pickers.isOpen() || listOpen()) return true;
        const el = e.target instanceof Element ? e.target : null;
        return !!el && !!popup.current?.contains(el) && controlKey(el, e);
      },
    });
    return () => { window.removeEventListener('keydown', note, true); off(); };
  });
  useEffect(() => { if (!open) pickers.drop(); });
  if (!v || !act) return null;
  const focusClose = () => { close.current?.focus({ preventScroll: true, focusVisible: byKey.current } as FocusOptions); return false as const; };
  const showTab = (next: string) => { setTab(next); setShownTab(next); pickers.close(); };
  const PIECE = 'pointer-events-auto border border-solid border-input bg-popover shadow-dialog';
  const PANEL = cn(PIECE, 'max-h-full scroll-box rounded-b-12 border-t-0 px-[20px] pb-[20px] max-[520.02px]:self-stretch max-[520.02px]:rounded-b-10 max-[520.02px]:px-[14px] max-[520.02px]:pb-[14px]');
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        // Escape is the engine's (a picker first, then the dialog): let it through to the reader.
        if (details.reason === 'escape-key') { details.cancel(); details.allowPropagation(); return; }
        act.close();
      }}
    >
      {open && (
        <DialogContent
          ref={popup} size="md" layout="sectioned" id="readerSettingsBox" data-reader-part="settings"
          initialFocus={focusClose} finalFocus={false}
          // The arrows, Home and End reach the reader (they turn its pages, as with the box closed) unless
          // what has the focus uses them; the Dialog's box would keep them all.
          onKeyDown={(e) => { if (!pickers.isOpen() && !listOpen() && !controlKey(e.target as Element, e.nativeEvent)) e.preventBaseUIHandler(); }}
          className={cn('pointer-events-none overflow-visible rounded-none border-0 bg-transparent shadow-none',
            // For the place buttons: how far the window's right edge is from the box's left edge (the box
            // centred in the layer's room, the window less a scrollbar and the layer's padding), and the
            // tabs' side padding. Viewport units: container units on the layer would restyle all of it
            // on every step of a resize.
            '[--settings-gutter:16px] [--settings-pad:20px] max-[520.02px]:[--settings-gutter:8px] max-[520.02px]:[--settings-pad:14px]',
            '[--settings-room:calc(100vw_-_var(--page-scrollbar-width)_-_2*var(--settings-gutter))]',
            '[--settings-reach:calc(var(--settings-gutter)_+_var(--page-scrollbar-gap)_+_(var(--settings-room)_+_min(480px,var(--settings-room)))/2)]')}
        >
          <Tabs variant="segmented" value={tab} onValueChange={showTab} className="flex min-h-0 flex-col">
            {/* The header and the tabs stay put; the tab shown scrolls under them on its own. */}
            <div data-rs="top" className={cn(PIECE, 'shrink-0 rounded-t-12 border-b-0 max-[520.02px]:rounded-t-10')}>
              <DialogHeader className="border-b-0 pb-[12px]">
                <DialogTitle className="flex items-center gap-[9px]"><Ico className="size-[17px] text-muted-foreground">{GEAR}</Ico>{t('rd.reader_settings')}</DialogTitle>
                <DialogClose ref={close} id="readerSettingsClose" />
              </DialogHeader>
              {/* The most used settings come first. */}
              <TabsList activateOnFocus className="mx-[20px] mb-[16px] max-[520.02px]:mx-[14px]">
                <TabsTab value="reading" data-rs-tab="reading">{t('rd.tab_reading')}</TabsTab>
                <TabsTab value="pages" data-rs-tab="pages">{t('rd.tab_pages')}</TabsTab>
                <TabsTab value="display" data-rs-tab="display">{t('rd.tab_display')}</TabsTab>
              </TabsList>
            </div>
            {/* Every tab in one grid cell: the box as tall as the tallest, its top where it was from tab to tab. */}
            <TabsPanels className="min-h-0 grid-rows-[minmax(0,1fr)]">
              <TabsPanel value="reading" data-rs-panel="reading" className={PANEL} onScroll={() => pickers.close()}><Reading v={v} act={act} t={t} /></TabsPanel>
              <TabsPanel value="pages" data-rs-panel="pages" className={PANEL} onScroll={() => pickers.close()}><Pages v={v} act={act} t={t} /></TabsPanel>
              <TabsPanel value="display" data-rs-panel="display" className={PANEL} onScroll={() => pickers.close()}><Display v={v} act={act} t={t} pickers={pickers} /></TabsPanel>
            </TabsPanels>
          </Tabs>
          {/* The placement picker (one at a time): the choices around the button that opened it. */}
          <PickerCells pickers={pickers} t={t} />
        </DialogContent>
      )}
    </Dialog>
  );
}

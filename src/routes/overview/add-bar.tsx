// add-bar.tsx — the add-a-chapter bar under the list (1.3's #addBar: wireAdd, runSearch, wireDrop): its
// heading and hint in the words of the view shown (a chapter or a volume), a search box for a gallery of
// the library to add, and the bar itself a place to drop files as the next chapters.
//
// The search, as 1.3's: what is typed is looked for 180 ms after the last key (and again as the box takes
// focus with something in it), in the library's galleries by their id or title, newest change first,
// leaving out the series' own members and the owner (a series of the library shows as its owner, its
// chapters within it); the first eight shown under the box, each with its cover, title and id, or "No
// results". A press on one adds it to the series (the page's onPick) and empties the box. The list closes
// with a press anywhere outside the box and its list, and when the box is emptied; it has no keys (1.3's
// had none). What finds and draws the results (./add-results.tsx) is loaded at the first key.
//
// The list is a popup: fixed on the window, placed against the box by CSS anchor positioning (under it,
// or over it where only the room above holds it, settled as it opens), at most 320px and never past the
// window's edge, so the page under it neither grows nor moves when it opens. Without anchor positioning
// it hangs under the box as 1.3's did.
//
// Files dragged over the bar light it (1.3's .add-bar.drag: the brand's frame on its 8% tint); dropped
// there, they are the next chapters (./add-drop.ts, loaded at the drop): the drop's items are kept as
// the drop event has them, since they can only be listed while it lasts.
import { Suspense, lazy, memo, useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Eyebrow } from '@/components/ui/text';
import type { Translate } from '@/lib/i18n';
import { dropItems, type DropItems } from '@/lib/drop-items';
import { cn } from '@/lib/utils';
import type { Entity } from './data';
import type { OverviewCovers } from './covers';

const addResults = () => import('./add-results');
const AddResults = lazy(() => addResults().then((m) => ({ default: m.AddResults })));

const SEARCH_DELAY_MS = 180;
const ANCHORS = typeof CSS !== 'undefined' && CSS.supports('anchor-name: --a');
const ROW = 58.43;          // a result's height: its 30px cover at 1:√2, 8px over and under
const LIST_MAX = 320;
const EDGE = 8;             // kept clear of the window's edge

export type AddBarDeps = {
  t: Translate;
  covers: OverviewCovers;
  owner: () => string | null;                      // the series' owner (or the gallery) as the page knows it
  onPick: (g: Entity) => void;                     // a result pressed: added to the series
  onDrop: (drop: DropItems) => void;               // files dropped on the bar
};

type Found = { term: string; items: Entity[] };
type Place = { up: boolean; max: number };

export const AddBar = memo(function AddBar({ kind, deps }: { kind: 'chapter' | 'volume'; deps: AddBarDeps }) {
  const { t } = deps;
  const input = useRef<HTMLInputElement>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place>({ up: false, max: LIST_MAX });
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); asked.current++; }, []);

  // Which way it opens and how tall it may be, settled as it opens: down, unless only the room above
  // holds it; never past the window's edge.
  const placeFor = (rows: number) => {
    const box = input.current?.getBoundingClientRect();
    if (!box) return { up: false, max: LIST_MAX };
    const header = document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0;
    const below = innerHeight - box.bottom - 4 - EDGE, above = box.top - 4 - Math.max(EDGE, header);
    const want = Math.min(LIST_MAX, Math.max(1, rows) * ROW + 2);
    const up = below < want && above > below;
    return { up, max: Math.max(0, Math.min(LIST_MAX, up ? above : below)) };
  };

  async function search(term: string) {
    const mine = ++asked.current;
    if (!term) { setOpen(false); return; }
    const owner = deps.owner();
    if (!owner) return;
    const { findGalleries } = await addResults();
    const items = await findGalleries(term, owner);
    if (mine !== asked.current) return;
    setFound({ term, items });
    setPlace(placeFor(items.length));
    setOpen(true);
  }
  const later = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; search(input.current?.value.trim() ?? '').catch((err) => console.error(err)); }, SEARCH_DELAY_MS);
  };

  // A press anywhere outside the box and its list closes it.
  useEffect(() => {
    if (!open) return;
    const press = (e: MouseEvent) => { if (!(e.target as Element | null)?.closest?.('.add-search-wrap')) setOpen(false); };
    document.addEventListener('click', press);
    return () => document.removeEventListener('click', press);
  }, [open]);

  const pick = (g: Entity) => {
    setOpen(false);
    if (input.current) input.current.value = '';
    deps.onPick(g);
  };

  // ── Files dragged over the bar, and dropped on it ──
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const files = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  const drag = {
    onDragEnter: (e: DragEvent) => { if (files(e)) { depth.current++; setOver(true); } },
    onDragOver: (e: DragEvent) => { if (files(e)) e.preventDefault(); },
    onDragLeave: () => { if (--depth.current <= 0) { depth.current = 0; setOver(false); } },
    onDrop: (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      deps.onDrop(dropItems(e.dataTransfer));
    },
  };

  const anchored: CSSProperties = ANCHORS
    ? { position: 'fixed', positionAnchor: '--ov-add-search', left: 'anchor(left)', width: 'anchor-size(width)', maxHeight: place.max,
      ...(place.up ? { bottom: 'calc(anchor(top) + 4px)' } : { top: 'calc(anchor(bottom) + 4px)' }) } as CSSProperties
    : { position: 'absolute', top: 44, left: 0, right: 0, maxHeight: LIST_MAX };
  return (
    <div className={cn('add-bar', over && 'drag')} id="addBar" {...drag}>
      <Eyebrow as="h3" size="lg" id="addHeading">{t(kind === 'volume' ? 'ov.add_volume' : 'ov.add_chapter')}</Eyebrow>
      <div className="add-search-wrap">
        <Input ref={input} variant="inset" size="xl" className="add-search" id="addSearch" placeholder={t('ov.add_search_ph')} autoComplete="off" spellCheck={false}
          style={ANCHORS ? { anchorName: '--ov-add-search' } as CSSProperties : undefined}
          onInput={later} onFocus={() => { const term = input.current?.value.trim(); if (term) search(term).catch((err) => console.error(err)); }} />
        {open && found && (
          <Suspense fallback={null}>
            <AddResults t={t} covers={deps.covers} items={found.items} style={anchored} data-up={place.up ? '' : undefined} onPick={pick} />
          </Suspense>
        )}
      </div>
      <div className="add-hint">{t('ov.add_hint')}</div>
    </div>
  );
});

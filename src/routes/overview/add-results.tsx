// add-results.tsx — what the add bar finds and shows (1.3's runSearch, app/js/overview.js), loaded at the
// first key in its box (./add-bar.tsx).
//
// Found: the library's galleries whose id holds what is typed or whose title does (any case), newest
// change first, the first 40 so (store.getPage: a series of the library is one entry, its owner, its
// chapters within it), less the series' own members and the owner, the first eight of what is left.
// Shown: each with its cover (the page's covers store, 160 wide), its title in the app's language (or
// "#id") and its id, in the add-chapter list's look (Listbox rich); none: "No results".
import { memo, type CSSProperties } from 'react';
import * as api from '@lib/api.js';
import * as store from '@lib/store.js';
import { getLang } from '@lib/i18n.js';
import { pickTitle } from '@lib/titles.js';
import { Listbox, ListboxOption } from '@/components/ui/listbox';
import type { Translate } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { Entity } from './data';
import type { OverviewCovers } from './covers';
import { useCover, useDecoded } from './parts';

type Lite = { id: string; title?: string };
const getPage = store.getPage as unknown as (opts: { sort: string; page: number; pageSize: number; match: (g: Lite) => boolean }) => Promise<{ items: Entity[] }>;

export async function findGalleries(term: string, ownerId: string): Promise<Entity[]> {
  const existing = new Set((((await api.meta.get(ownerId)) as { chapters?: { id: unknown }[] } | null)?.chapters || []).map((c) => String(c.id)));
  existing.add(String(ownerId));
  const lower = term.toLowerCase();
  const match = (g: Lite) => (g.id.includes(term) || (!!g.title && g.title.toLowerCase().includes(lower)));
  const { items } = await getPage({ sort: 'updated', page: 1, pageSize: 40, match });
  return items.filter((g) => !existing.has(String(g.id))).slice(0, 8);
}

const Thumb = memo(function Thumb({ covers, g }: { covers: OverviewCovers; g: Entity }) {
  const shown = useDecoded(useCover(covers, String(g.id), {}, g));
  return (
    <span className={cn('add-res-thumb relative flex w-[30px] shrink-0 items-center justify-center overflow-hidden rounded-4 border border-solid border-border bg-background [aspect-ratio:1/1.41421356]',
      shown?.landscape && 'landscape border-transparent bg-transparent')}>
      {shown && <img className={cn('ov-thumb', shown.landscape && 'landscape')} alt="" src={shown.src} />}
    </span>
  );
});

type Props = { t: Translate; covers: OverviewCovers; items: Entity[]; style: CSSProperties; onPick: (g: Entity) => void; 'data-up'?: string };

export function AddResults({ t, covers, items, style, onPick, ...rest }: Props) {
  const lang = getLang();
  return (
    <Listbox variant="rich" id="addResults" className="add-results open z-page-popup overflow-y-auto" style={style} {...rest}>
      {items.length ? items.map((g) => {
        const id = String(g.sourceId || g.id);
        return (
          <ListboxOption key={String(g.id)} className="add-res" data-gallery-id={String(g.id)} onPick={() => onPick(g)}>
            <Thumb covers={covers} g={g} />
            <span className="add-res-title min-w-0 flex-1 truncate">{pickTitle(g as never, lang) || `#${id}`}</span>
            <span className="add-res-id shrink-0 text-11 text-muted-foreground">#{id}</span>
          </ListboxOption>
        );
      }) : <div className="add-empty p-[10px] text-center text-12 text-muted-foreground">{t('ov.no_results')}</div>}
    </Listbox>
  );
}

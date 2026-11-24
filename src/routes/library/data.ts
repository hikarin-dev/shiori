// What the library page reads, through the app's one query cache (T4, src/lib/library-query.ts): a page
// of galleries for what the page asks (its sort, its page, its search, its filter, whether series are
// merged), and the header's totals.
//
// A page is read from the library as 1.3's applyFilters read it: store.getPage, the database sorting
// and paging it alone when nothing narrows it, the search's predicate otherwise; one past the end falls
// back to the last (and is kept under that page's key too, so the page that follows finds it). Its
// galleries go into the cache under their own keys (lib/gallery.ts's), where the library's change feed
// keeps each up to date, so a card is drawn from its gallery's entry: one gallery changing changes one
// entry. A gallery's entry already newer than the page's read is left as it is, and an edit the page
// made that the library did not hold when the read started is laid over what it read.
//
// A newer ask supersedes an older one by its key: the page shows the data of what it asks now (the
// last page shown stays while the next is read, as 1.3's grid did), whatever order reads land in.
import type { QueryClient } from '@tanstack/react-query';
import * as api from '@lib/api.js';
import * as store from '@lib/store.js';
import { LANG_NAME_TO_CODE } from '@lib/gallery-model.js';
import { SEARCH_TYPES } from '@lib/search-field.js';
import { galleryKey, readMark, withEdits } from '@/lib/library-query';
import { libraryMatch, type LibFilter, type SearchRules } from '@/lib/library-search';

export const PAGE_SIZE = 30;
export const RULES: SearchRules = { searchTypes: SEARCH_TYPES, langNameToCode: LANG_NAME_TO_CODE };

// What the page asks for. `filter` is the filter's canonical form (prefs' libFilter).
export type PageAsk = { sort: string; page: number; query: string; filter: string; merge: boolean };
export type PageData = { page: number; total: number; ids: string[] };

export const PAGES = ['library-page'] as const;
export const pageKey = (ask: PageAsk) => ['library-page', ask] as const;
export const pageCount = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE));

type Entity = { id: string | number; [field: string]: unknown };
const getPage = store.getPage as unknown as (opts: { sort: string; page: number; pageSize: number; match: ((g: never) => boolean) | null; merge: boolean }) => Promise<{ items: Entity[]; total: number }>;

export async function readPage(client: QueryClient, ask: PageAsk, ready: Promise<unknown>): Promise<PageData> {
  await ready;
  const match = libraryMatch(ask.query, JSON.parse(ask.filter) as LibFilter, RULES);
  let page = ask.page;
  for (;;) {
    const started = Date.now(), mark = readMark();
    const { items, total } = await getPage({ sort: ask.sort, page, pageSize: PAGE_SIZE, match: match as ((g: never) => boolean) | null, merge: ask.merge });
    const last = pageCount(total);
    if (page > last) { page = last; continue; }
    for (const g of items) {
      const key = galleryKey(String(g.id));
      if ((client.getQueryState(key)?.dataUpdatedAt ?? 0) > started) continue;
      client.setQueryData(key, withEdits(String(g.id), g, mark), { updatedAt: started });
    }
    const data: PageData = { page, total, ids: items.map((g) => String(g.id)) };
    if (page !== ask.page) client.setQueryData(pageKey({ ...ask, page }), data);
    return data;
  }
}

// The header's totals: every gallery's stats, and how many cards the library makes (a series one
// while merged, every chapter otherwise).
export type Totals = { stats: { totalImages: number; totalSize: number; totalOrig?: number; galleries: Record<string, { count?: number; medianPage?: unknown }> }; topLevel: number };
export const TOTALS = ['library-totals'] as const;
export const totalsKey = (merge: boolean) => ['library-totals', merge] as const;
export async function readTotals(merge: boolean): Promise<Totals> {
  const [stats, topLevel] = await Promise.all([api.galleries.stats(), api.galleries.count({ merge })]);
  return { stats: stats as Totals['stats'], topLevel: topLevel as number };
}

// library.tsx — the library page, as the one page draws it (for now at /library-next, beside 1.3's page
// at / and /library): the header's parts (the page menu, the search, the totals, the buttons), the
// toolbar (the sort and the filter), the grid of cards, one page of 30 at a time, and the paging.
// It reads and searches; what a card's buttons do, the jobs on cards, import and Safe Mode come with
// the page's later steps (a card's every other handler is left out, and its job is none).
//
// What it shows is data (T4): the page asked for (sort, page, search, filter, merged or not) is read
// through the app's query cache (./library/data.ts), each card drawn from its gallery's entry there,
// its cover from the cover store (src/lib/covers.ts) and its source's icon from the icon store
// (src/lib/source-icons.ts). Nothing on the page is patched by hand: a gallery changing in the library
// changes its entry (the change feed, lib/gallery.ts) and its card alone is drawn again; galleries
// added or removed, here or in another context, read the page again 250 ms after the last such word
// (1.3's _scheduleReloadPage), and a gallery the page shows no card for is looked for (1.3's
// _revealCard: not a chapter of a series shown merged, and once in 5 s at most per gallery); the
// totals are read again 800 ms after the last change.
//
// The address: page, q and sort, read once as the page shows and written back (replacing the entry, as
// 1.3's syncUrl) after each read of the page; Back and Forward land on what they showed.
//
// Drawn on 1.3's sizes (library.css): the toolbar 12px 24px round (10px 12px at 600px or less), its two
// controls 12 apart; the grid of cards at least 240px wide, 16 apart, 1512px wide at most, 24px in at
// the sides and 40 under it (two to a row, 10 apart, 12 in and 32 under at 600px or less); the paging
// 8px under it and 48 above the page's end, its buttons 5 apart.
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { Funnel } from 'lucide-react';
import * as api from '@lib/api.js';
import * as platform from '@lib/platform.js';
import { getLang } from '@lib/i18n.js';
import { appendSearchToken, searchQuery } from '@lib/search-field.js';
import { canDownload, galleryLink, siteMap, siteName } from '@lib/sites.js';
import { request as helperRequest } from '@lib/ext-bridge.js';
import { GalleryCard, cardModes, type CardHandlers } from '@/components/gallery-card';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { cardView, type CardEnv, type CardGallery } from '@/lib/card-view';
import { CARD_FORMATS } from '@/lib/card-rules';
import { coverKeyOf, createCoverStore, type CoverStore } from '@/lib/covers';
import { galleryQuery } from '@/lib/gallery';
import { useT } from '@/lib/i18n';
import { NO_FILTER, filtering, flagToken, sourceToken, stateToken, stepFilter, tagToken, type FilterType, type LibFilter } from '@/lib/library-search';
import { readAgain } from '@/lib/library-query';
import { useShiftHeld } from '@/lib/modifiers';
import { createIconStore, type IconStore } from '@/lib/source-icons';
import { useTitle } from '@/lib/title';
import { cn } from '@/lib/utils';
import { PAGES, TOTALS, pageCount, pageKey, readPage, readTotals, totalsKey, type PageAsk, type PageData } from './library/data';
import { FilterDialog } from './library/filter-dialog';
import { LibraryHeader } from './library/header';
import { prefs, usePref } from './library/prefs';
import { useRunners } from './library/runners';

const SORTS = ['id', 'updated', 'size', 'count', 'uploadDate'] as const;
const SEARCH_MS = 180;        // the search waits this long after the last key (1.3's)
const RELOAD_MS = 250;        // the page read again this long after the last word that asks it
const TOTALS_MS = 800;        // the totals read again this long after the last change
const REVEAL_EVERY_MS = 5000; // a gallery the page shows no card for is looked for once in this at most

// The address as 1.3 read it (initFromUrl): a page past the first, a search, a sort.
function fromAddress(search: string) {
  const params = new URLSearchParams(search);
  const page = parseInt(params.get('page') ?? '', 10);
  return { page: page > 1 ? page : 1, query: params.get('q') || '', sort: params.get('sort') || 'id' };
}
// And as it wrote it (syncUrl).
function toAddress(page: number, query: string, sort: string) {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  if (query) params.set('q', query);
  if (sort && sort !== 'id') params.set('sort', sort);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

type Gallery = CardGallery & { parentId?: unknown };

// A card of the grid: its gallery's entry, its cover and its source's icon, drawn as the card's view.
// The card is the grid's own child (this draws nothing of its own).
const LibraryCard = memo(function LibraryCard({ g, env, covers, icons, on }: { g: Gallery; env: CardEnv; covers: CoverStore; icons: IconStore; on: CardHandlers }) {
  const key = coverKeyOf(g, env.prefs.mergeSeries);
  const cover = useSyncExternalStore(covers.subscribe, () => covers.get(key));
  const icon = useSyncExternalStore(icons.subscribe, () => icons.get(g.source));
  // The view without its cover, which the card takes apart: a cover arriving leaves the view the same
  // object, and the card draws its cover alone.
  const view = useMemo(() => cardView(g, null, env), [g, env, icon]);   // eslint-disable-line react-hooks/exhaustive-deps
  // A source with no icon kept: asked for each time its card is drawn anew (1.3's _siteFavicon).
  useEffect(() => { if (g.source && !icon) icons.want(g.source); }, [g, icon, icons]);
  return <GalleryCard view={view} cover={cover} job={null} on={on} />;
});

export default function Library() {
  useTitle('Library');
  const t = useT();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  // ── Preferences ──
  // Other tabs' and Settings' changes followed while the page shows.
  useEffect(() => { prefs.start(); return () => prefs.stop(); }, []);
  const merge = usePref<boolean>('libMergeSeries');
  const showTotals = usePref<boolean>('libShowNavStats');
  const quickActions = usePref<'hover' | 'always' | 'hidden'>('libQuickActionsMode');
  const hideAppLangFlag = usePref<boolean>('libHideAppLangFlag');
  const showCategory = usePref<boolean>('libShowCategoryTag');
  const overviewShown = usePref<boolean>('readerSkipOverview');
  const seriesView = usePref<string>('seriesView');
  const filterJson = usePref<string>('libFilter');
  const filter = useMemo(() => JSON.parse(filterJson) as LibFilter, [filterJson]);

  // ── What the page asks: from the address once, as it shows ──
  const [start] = useState(() => fromAddress(location.search));
  const [page, setPage] = useState(start.page);
  const [sort, setSort] = useState(start.sort);
  const [typed, setTyped] = useState(start.query);     // what the search box holds
  const [query, setQuery] = useState(start.query);     // the search applied (180 ms after the last key)
  const typedRef = useRef(typed);
  typedRef.current = typed;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);
  // A change of the filter or of merging (here, in another tab, or in Settings) starts at page 1.
  const [seen, setSeen] = useState({ filterJson, merge });
  if (seen.filterJson !== filterJson || seen.merge !== merge) {
    setSeen({ filterJson, merge });
    setPage(1);
  }

  // ── The stores of the page's covers and icons, started while it shows ──
  const [icons] = useState(() => createIconStore({
    all: api.icons.all, get: api.icons.get, put: api.icons.put,
    request: helperRequest as never, sources: () => Object.keys(siteMap() || {}),
  }));
  const [iconsReady] = useState(() => icons.hydrate());
  const reloadRef = useRef<() => void>(() => {});
  const totalsRef = useRef<() => void>(() => {});
  const [covers] = useState(() => createCoverStore({
    rpc: platform.rpc, onControl: platform.onControl, canDownload: canDownload as never,
    viewport: () => window, onResize: (cb) => { window.addEventListener('resize', cb); return () => window.removeEventListener('resize', cb); },
    session: (() => { try { return sessionStorage; } catch { return null; } })(),
    prime: (dataUrl) => { const img = new Image(); img.src = dataUrl; },
    // A gallery with no pages whose cover came: its record read again, and the totals.
    onEmptyCover: (gid) => { readAgain(client, gid).catch(() => {}); totalsRef.current(); },
  }));
  useEffect(() => { covers.start(); return () => covers.stop(); }, [covers]);

  const { sites, translatorOnline } = useRunners(icons);

  // ── The page ──
  const ask: PageAsk = { sort, page, query, filter: filterJson, merge };
  const pageQuery = useQuery({
    queryKey: pageKey(ask), queryFn: () => readPage(client, ask, iconsReady),
    placeholderData: keepPreviousData, staleTime: 0,
  });
  const data: PageData | undefined = pageQuery.data;
  // One past the end fell back to the last: the page follows.
  useEffect(() => {
    if (data && !pageQuery.isPlaceholderData && data.page !== page) setPage(data.page);
  }, [data, pageQuery.isPlaceholderData, page]);

  // Its galleries, each from its own entry (kept while one is gone, until the page is read again).
  const ids = data?.ids ?? [];
  const read = useQueries({
    queries: ids.map((id) => ({ ...galleryQuery(id), staleTime: Infinity })),
    combine: (results) => results.map((r) => r.data as Gallery | null | undefined),
  });
  const last = useRef(new Map<string, Gallery>());
  const galleries = useMemo(() => {
    const out: Gallery[] = [];
    for (let i = 0; i < ids.length; i++) {
      const g = read[i] ?? last.current.get(ids[i]);
      if (g) out.push(g);
    }
    last.current = new Map(out.map((g) => [String(g.id), g]));
    return out;
  }, [ids, read]);

  // The address follows each read of the page.
  useEffect(() => {
    if (!data || pageQuery.isPlaceholderData) return;
    const search = toAddress(data.page, typedRef.current, sort);
    if (search !== window.location.search) navigate({ search }, { replace: true, preventScrollReset: true });
  }, [data, pageQuery.isPlaceholderData]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Covers: the page's galleries, each without one asked for; one changed in place, again ──
  const shownBefore = useRef(new Map<string, Gallery>());
  useEffect(() => { covers.show(galleries, merge); }, [data, merge, sites]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const before = shownBefore.current;
    const changed = galleries.filter((g) => before.has(String(g.id)) && before.get(String(g.id)) !== g);
    shownBefore.current = new Map(galleries.map((g) => [String(g.id), g]));
    if (changed.length) covers.changed(galleries, changed);
  }, [galleries, covers]);

  // ── The totals: read once the first page is drawn, again 800 ms after the last change ──
  const totals = useQuery({ queryKey: totalsKey(merge), queryFn: () => readTotals(merge), enabled: !!data, staleTime: 0, placeholderData: keepPreviousData });

  // ── A library that changes under the page ──
  const idsRef = useRef<string[]>(ids);
  idsRef.current = ids;
  const galleriesRef = useRef<Gallery[]>(galleries);
  galleriesRef.current = galleries;
  const mergeRef = useRef(merge);
  mergeRef.current = merge;
  useEffect(() => {
    let reloadTimer: ReturnType<typeof setTimeout> | undefined, totalsTimer: ReturnType<typeof setTimeout> | undefined;
    const revealed = new Map<string, number>();
    const reload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => client.invalidateQueries({ queryKey: PAGES }).catch(() => {}), RELOAD_MS); };
    const readTotalsAgain = () => { clearTimeout(totalsTimer); totalsTimer = setTimeout(() => client.invalidateQueries({ queryKey: TOTALS }).catch(() => {}), TOTALS_MS); };
    reloadRef.current = reload;
    totalsRef.current = readTotalsAgain;
    // A gallery the page shows no card for may need one (an import or a download just made it, or a
    // change moved it onto this page): the page read again to see. Never for a chapter of a series
    // shown merged (it has no card of its own; its series' card hears of it), and once in 5 s at most
    // for any one gallery.
    const reveal = async (gid: string) => {
      if (mergeRef.current) {
        if (galleriesRef.current.some((g) => g.chapters?.some((c) => String(c.id) === gid))) return;
        const g = await client.fetchQuery({ ...galleryQuery(gid), staleTime: 0 }).catch(() => null) as Gallery | null;
        if (g?.parentId) return;
      }
      const now = Date.now();
      if (now - (revealed.get(gid) || 0) < REVEAL_EVERY_MS) return;
      revealed.set(gid, now);
      reload();
    };
    const off = api.events.watch((gid: string) => {
      readTotalsAgain();
      // Much changed at once (a folder's galleries set aside or brought back): the page read again.
      if (gid === '*') { reload(); return; }
      if (!idsRef.current.includes(gid)) reveal(String(gid)).catch(() => {});
    });
    // A gallery of the page gone from the library: the page read again, to fill its place.
    const offCache = client.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const [kind, gid] = event.query.queryKey as [string, string];
      if (kind === 'gallery' && event.query.state.data === null && idsRef.current.includes(gid)) reload();
    });
    return () => {
      off();
      offCache();
      clearTimeout(reloadTimer);
      clearTimeout(totalsTimer);
      reloadRef.current = () => {};
      totalsRef.current = () => {};
    };
  }, [client]);

  // ── The cards ──
  const env = useMemo<CardEnv>(() => ({
    t, lang: getLang(), ...CARD_FORMATS,
    prefs: { mergeSeries: merge, bypassOverview: !overviewShown, seriesView, hideAppLangFlag },
    site: { canDownload: canDownload as CardEnv['site']['canDownload'], name: siteName, link: galleryLink as CardEnv['site']['link'], icon: (source) => icons.get(source) },
  }), [t, merge, overviewShown, seriesView, hideAppLangFlag, sites, icons]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A word added to the search (1.3's _addSearchToken): the search applied at once from page 1; the
  // box keeps its focus only if it had it (so a hovered card stays grown).
  const addToken = useCallback((token: string) => {
    const box = document.getElementById('searchBox');
    const had = !!box && document.activeElement === box;
    appendSearchToken(token);
    const q = searchQuery();
    clearTimeout(searchTimer.current);
    setTyped(q);
    setQuery(q);
    setPage(1);
    if (had) box!.focus();
  }, []);
  const galleryOf = (id: string) => galleriesRef.current.find((g) => String(g.id) === id);
  const on = useMemo<CardHandlers>(() => ({
    tag: (_id, tag) => addToken(tagToken(tag.type, String(tag.name).trim())),
    flag: (_id, _code, name) => { if (name) addToken(flagToken(name)); },
    searchFavorite: (id) => { const g = galleryOf(id); if (g) addToken(stateToken('favorite', g.favorite)); },
    searchTranslated: (id) => { const g = galleryOf(id); if (g) addToken(stateToken('translated', g.translated)); },
    searchSource: (id) => { const g = galleryOf(id); if (g?.source) addToken(sourceToken(g.source)); },
  }), [addToken]);

  // The search box: typed, cleared, or read back.
  const onQueryChange = useCallback((q: string, how: 'typed' | 'cleared' | 'set') => {
    setTyped(q);
    clearTimeout(searchTimer.current);
    if (how === 'set') { setQuery(q); return; }
    if (how === 'cleared') { setQuery(''); setPage(1); return; }
    searchTimer.current = setTimeout(() => { setQuery(q); setPage(1); }, SEARCH_MS);
  }, []);

  // ── Paging: a button, or the arrows and A/D (Shift: the first or the last page) ──
  const pages = data ? pageCount(data.total) : 1;
  const shownPage = data?.page ?? page;
  const goToPage = useCallback((n: number) => {
    setPage(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);
  const pagingRef = useRef({ page: shownPage, pages });
  pagingRef.current = { page: shownPage, pages };
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.defaultPrevented) return;   // a key an open list took (the sort's, the page menu's)
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const fwd = e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D';
      const bck = e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A';
      if (!fwd && !bck) return;
      e.preventDefault();
      const now = pagingRef.current;
      const next = e.shiftKey ? (fwd ? now.pages : 1) : Math.max(1, Math.min(now.pages, now.page + (fwd ? 1 : -1)));
      if (next === now.page) return;
      goToPage(next);
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [goToPage]);

  // ── The filter ──
  const [filterOpen, setFilterOpen] = useState(false);
  // A press or Clear: kept, and the library read again from page 1 (even when Clear found nothing set).
  const setFilter = (next: LibFilter) => {
    prefs.set('libFilter', JSON.stringify(next));
    setPage(1);
  };

  // ── The grid's element: the cards' modes, Shift held ──
  const grid = useRef<HTMLDivElement>(null);
  useShiftHeld(grid);
  const modes = cardModes({ quickActions, hideCategory: !showCategory, translatorOffline: !translatorOnline });

  return (
    <>
      <LibraryHeader t={t} query={typed} onQueryChange={onQueryChange} totals={totals.data} showTotals={showTotals} />
      <main className="library-page">
        <div className="toolbar flex items-center justify-center gap-[12px] px-[24px] py-[12px] [@media(max-width:600px)]:px-[12px] [@media(max-width:600px)]:py-[10px]">
          <Select id="sortSelect" variant="toolbar" size="toolbar" width="widest" className="sort-select"
            options={SORTS.map((value) => ({ value, label: t(`sort.${value}`) }))}
            value={sort} onValueChange={(value) => { setSort(value); setPage(1); }} />
          <Button id="filterBtn" variant="quiet" size="toolbar" className={cn('filter-btn self-stretch', filtering(filter) && 'active')} aria-haspopup="dialog"
            aria-pressed={filtering(filter)} aria-label={t('filter.btn')} data-tip={t('filter.btn')} onClick={() => setFilterOpen(true)}>
            <Funnel />
          </Button>
        </div>
        <div ref={grid} id="grid" data-card-modes={modes}
          className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] auto-rows-fr items-start gap-[16px] px-[24px] pb-[40px] max-w-[1512px] mx-auto [@media(max-width:600px)]:grid-cols-[repeat(2,minmax(0,1fr))] [@media(max-width:600px)]:gap-[10px] [@media(max-width:600px)]:px-[12px] [@media(max-width:600px)]:pb-[32px]">
          {galleries.map((g) => <LibraryCard key={String(g.id)} g={g} env={env} covers={covers} icons={icons} on={on} />)}
          {data && galleries.length === 0 && (
            <EmptyState loose className="empty">{t('lib.empty_title')}<br />{t('lib.empty_sub')}</EmptyState>
          )}
        </div>
        <div id="pagination" className="flex items-center justify-center gap-[5px] px-[24px] pt-[8px] pb-[48px]">
          <Pagination page={shownPage} count={pages} onPage={goToPage} />
        </div>
      </main>
      <FilterDialog t={t} open={filterOpen} onOpenChange={setFilterOpen} filter={filter}
        onStep={(type: FilterType, value: string) => setFilter(stepFilter(filter, type, value))} onClear={() => setFilter(NO_FILTER)} />
    </>
  );
}

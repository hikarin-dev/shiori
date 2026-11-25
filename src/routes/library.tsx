// library.tsx — the library page, as the one page draws it (at / and /library): the header's parts (the
// page menu, the search, the totals, the buttons), the toolbar (the sort and the filter), the grid of
// cards, one page of 30 at a time, and the paging.
// What a card's buttons do is ./library/actions.ts's (1.3's questions, and its words to the library
// and to whatever runs things); the jobs on cards are the page's job store's (src/lib/library-jobs.ts),
// each card reading its own gallery's. Import (the picker, a drop of files or folders, the tracker of
// its batches, backups picked or dropped) is src/lib/library-import.ts's and ./library/tracker.tsx's,
// a card dragged onto another src/lib/card-drag.ts's: each loaded the first time it is needed, so the
// page's own load takes none of them.
//
// The header's choices are the page's, kept as 1.3 kept them (raw keys, read as the page shows): Safe
// Mode (`shiori-safe-mode`: the grid's `safe` mode blurs the covers not rated safe, every card shows the
// words src/lib/safe-mode.ts stands in for its own, made once a gallery while it stays on, and a
// question about a card shows no cover while its cover is blurred) and the pin (`shiori-header-pin`:
// unpinned, html[data-header-unpinned] lets the header scroll away with the page, frame.css).
//
// The keys, in one place (1.3's): W and S scroll the window every frame from the keydown (Shift twice
// as fast, live) until let go or the window's focus is lost; the arrows and A/D turn the page (Shift:
// the first or the last); F5 and Ctrl+R read the library again in place. None from a text box, and none
// for a key an open list or a dialog has.
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
import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { Funnel } from 'lucide-react';
import * as api from '@lib/api.js';
import * as platform from '@lib/platform.js';
import * as store from '@lib/store.js';
import { confirmDialog } from '@lib/notice.js';
import { getLang } from '@lib/i18n.js';
import { appendSearchToken, searchQuery } from '@lib/search-field.js';
import { canDownload, galleryLink, siteMap, siteName } from '@lib/sites.js';
import { request as helperRequest } from '@lib/ext-bridge.js';
import { GalleryCard, cardModes, type CardHandlers } from '@/components/gallery-card';
import { Button } from '@/components/ui/button';
import { DropOverlay } from '@/components/ui/drop-overlay';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { cardView, ratedSafe, type CardEnv, type CardGallery } from '@/lib/card-view';
import { CARD_FORMATS } from '@/lib/card-rules';
import { coverKeyOf, createCoverStore, type CoverStore } from '@/lib/covers';
import { galleryQuery } from '@/lib/gallery';
import { useT } from '@/lib/i18n';
import { dismissSince, noticeMark } from '@/lib/notice-store';
import { NO_FILTER, filtering, flagToken, sourceToken, stateToken, stepFilter, tagToken, type FilterType, type LibFilter } from '@/lib/library-search';
import { createLibraryJobs, type LibraryJobs } from '@/lib/library-jobs';
import type { BatchJob, BatchStore, Reading } from '@/lib/import-batches';
import type { CardDrag } from '@/lib/card-drag';
import type { DropItems } from '@/lib/library-import';
import { attachNativeBackupOnce } from '@/lib/native-backup';
import { readAgain } from '@/lib/library-query';
import { SAFE_MODE_KEY, createScrambler, type Scrambler } from '@/lib/safe-mode';
import { useShiftHeld } from '@/lib/modifiers';
import { createIconStore, type IconStore } from '@/lib/source-icons';
import { useTitle } from '@/lib/title';
import { cn } from '@/lib/utils';
import { cardActions } from './library/actions';
import { galleryDetail, type ShownGallery } from '@/lib/gallery-actions';
import { PAGES, TOTALS, pageCount, pageKey, readPage, readTotals, totalsKey, type PageAsk, type PageData } from './library/data';
import { FilterDialog } from './library/filter-dialog';
import { LibraryHeader } from './library/header';
import { prefs, usePref } from './library/prefs';
import type { RerunAsk } from '@/components/rerun-menu';
import { useRunners } from './library/runners';
import type { SeriesTranslateAsk } from './library/series-translate';

// What a card opens, loaded the first time it is asked for (the page draws none of it at rest): the
// re-run menu, a series' translation window, the tag editor.
const rerunMenu = () => import('@/components/rerun-menu');
const seriesWindow = () => import('./library/series-translate');
const RerunMenu = lazy(() => rerunMenu().then((m) => ({ default: m.RerunMenu })));
const SeriesTranslateDialog = lazy(() => seriesWindow().then((m) => ({ default: m.SeriesTranslateDialog })));
const TagEditor = lazy(() => import('@/components/tag-editor').then((m) => ({ default: m.TagEditor })));
// Import and the card drag, loaded at their first press or drop; the tracker drawn from the first time
// there is something for it.
const libraryImport = () => import('@/lib/library-import');
const cardDrag = () => import('@/lib/card-drag');
const LibraryTracker = lazy(() => import('./library/tracker').then((m) => ({ default: m.LibraryTracker })));

const SORTS = ['id', 'updated', 'size', 'count', 'uploadDate'] as const;
const SEARCH_MS = 180;        // the search waits this long after the last key (1.3's)
const RELOAD_MS = 250;        // the page read again this long after the last word that asks it
const TOTALS_MS = 800;        // the totals read again this long after the last change
const REVEAL_EVERY_MS = 5000; // a gallery the page shows no card for is looked for once in this at most
const LISTING_EVERY_MS = 100; // a drop being read is told this often at most (1.3's)
const SCROLL_SPEED = 22;      // W/S: px a frame with Shift held; half of it without (1.3's)
const PIN_KEY = 'shiori-header-pin';   // the header pinned unless '0' (1.3's)

// A raw key of the page's, kept as 1.3 kept it (storage may be refused: a private window).
const readKey = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeKey = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* not kept */ } };
// A key the page's own keys leave alone: one an open list took, one in a text box, or one an open list,
// menu or dialog has.
const KEYS_TAKEN = '[role="listbox"], [role="menu"], [role="dialog"], [role="alertdialog"]';
const keysTaken = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return e.defaultPrevented || (!!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest?.(KEYS_TAKEN)));
};

// A drop's items as the drop event has them, for reading after it (they can only be listed while it
// lasts): each file's entry, and its file where it is not a folder.
function dropItems(dt: DataTransfer): DropItems {
  return { items: [...dt.items].filter((item) => item.kind === 'file').map((item) => {
    const entry = item.webkitGetAsEntry?.() ?? null;
    const file = entry?.isDirectory ? null : item.getAsFile();
    return { kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => file };
  }) };
}

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

// A card of the grid: its gallery's entry, its cover, its source's icon and its jobs, drawn as the
// card's view (with Safe Mode's words while it is on). The card is the grid's own child (this draws
// nothing of its own).
const LibraryCard = memo(function LibraryCard({ g, env, covers, icons, jobs, on, safe, scrambler }: {
  g: Gallery; env: CardEnv; covers: CoverStore; icons: IconStore; jobs: LibraryJobs; on: CardHandlers; safe: boolean; scrambler: Scrambler;
}) {
  const key = coverKeyOf(g, env.prefs.mergeSeries);
  const cover = useSyncExternalStore(covers.subscribe, () => covers.get(key));
  const icon = useSyncExternalStore(icons.subscribe, () => icons.get(g.source));
  // Its gallery's jobs alone: another gallery's word draws nothing here.
  const gid = String(g.id);
  const followJobs = useCallback((cb: () => void) => jobs.subscribe(gid, cb), [jobs, gid]);
  const state = useSyncExternalStore(followJobs, () => jobs.get(gid));
  // The view without its cover, which the card takes apart: a cover arriving leaves the view the same
  // object, and the card draws its cover alone.
  const view = useMemo(() => cardView(g, null, env), [g, env, icon]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Safe Mode's words: one view a gallery while it stays on (the scrambler keeps them).
  const shown = useMemo(() => (safe ? scrambler.view(view) : view), [view, safe, scrambler]);
  // A source with no icon kept: asked for each time its card is drawn anew (1.3's _siteFavicon).
  useEffect(() => { if (g.source && !icon) icons.want(g.source); }, [g, icon, icons]);
  return <GalleryCard view={shown} cover={cover} job={state.job} interrupted={state.interrupted} pending={state.pending} pendingLabel={state.pendingLabel} exporting={state.exporting} holding={state.holding} on={on} />;
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

  // ── The header's choices: Safe Mode and the pin, read as the page shows ──
  const [safe, setSafe] = useState(() => readKey(SAFE_MODE_KEY) === '1');
  const [scrambler] = useState(() => createScrambler());
  const safeRef = useRef(safe);
  safeRef.current = safe;
  const toggleSafe = useCallback(() => {
    const next = !safeRef.current;
    writeKey(SAFE_MODE_KEY, next ? '1' : '0');
    // Off: the stand-ins go; on again, new ones (1.3 scrambled anew each time).
    if (!next) scrambler.clear();
    setSafe(next);
  }, [scrambler]);
  const [pinned, setPinned] = useState(() => readKey(PIN_KEY) !== '0');
  // Kept (1.3 wrote it each time the page showed, and at each press), and the header told; the header
  // stays at the window's top again when the page is left.
  useLayoutEffect(() => {
    writeKey(PIN_KEY, pinned ? '1' : '0');
    const { dataset } = document.documentElement;
    if (pinned) delete dataset.headerUnpinned; else dataset.headerUnpinned = '';
    return () => { delete dataset.headerUnpinned; };
  }, [pinned]);

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

  // ── The tracker of import batches: drawn from the first time there is something for it ──
  const [tracking, setTracking] = useState(false);
  // (The words of a batch heard before its store has come are handed to it once it has.)
  const tracker = useRef<{ store: BatchStore | null; reading: Reading | null; early: BatchJob[] }>({ store: null, reading: null, early: [] });
  const onTrackerStore = useCallback((store: BatchStore | null) => {
    tracker.current.store = store;
    if (!store) return;
    for (const job of tracker.current.early.splice(0)) store.hear(job);
    const reading = tracker.current.reading;
    if (reading) store.listing(reading.name, reading.found);
  }, []);
  // A drop being read, told to the tracker (null: read).
  const listing = useCallback((name: string | null, found = 0) => {
    tracker.current.reading = name == null ? null : { name, found };
    if (name != null) setTracking(true);
    tracker.current.store?.listing(name, found);
  }, []);
  // Whether the page has been left (a drop still being read, a picker the address asked for).
  const left = useRef(false);
  useEffect(() => { left.current = false; return () => { left.current = true; }; }, []);

  // ── The jobs on the cards: started while the page shows ──
  const revealRef = useRef<(gid: string) => void>(() => {});
  const [jobs] = useState(() => createLibraryJobs({
    jobs: platform.jobs as never, now: Date.now,
    // A done job's end: the page and its totals read again (1.3's loadAll).
    reread: () => { client.invalidateQueries({ queryKey: PAGES }).catch(() => {}); client.invalidateQueries({ queryKey: TOTALS }).catch(() => {}); },
    // An upload's end: its gallery removed if it is still empty.
    dropIfEmpty: (gid) => { (store.load(gid) as Promise<{ count?: number } | null>).then((g) => { if (!g || g.count === 0) store.remove(gid); }).catch(() => {}); },
    reveal: (gid) => revealRef.current(gid),
    importSeen: (news) => {
      const store = tracker.current.store;
      if (store) return;   // (it hears the channel itself)
      tracker.current.early.push(news as BatchJob);
      setTracking(true);
    },
  }));
  useEffect(() => { jobs.start(); return () => jobs.stop(); }, [jobs]);
  // The questions the page asked go with it when it is left.
  useEffect(() => { const mark = noticeMark(); return () => dismissSince(mark); }, []);
  // A backup the desktop app's window left by a reload: followed again, once a document.
  useEffect(attachNativeBackupOnce, []);

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

  // The jobs store learns which galleries have cards (the first time, what is under way is asked).
  useEffect(() => { if (data) jobs.showing(data.ids); }, [data, jobs]);

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
    const reveal = revealRef.current = async (gid: string) => {
      if (idsRef.current.includes(gid)) return;
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
      // (Not while its job runs: 1.3's rule, library.js `if (!_liveJobs.has(gid)) _scheduleReloadPage()`;
      // its page, driven, did not always keep it: library-jobs' case.)
      if (kind === 'gallery' && event.query.state.data === null && idsRef.current.includes(gid) && !jobs.live(gid)) reload();
    });
    return () => {
      off();
      offCache();
      clearTimeout(reloadTimer);
      clearTimeout(totalsTimer);
      reloadRef.current = () => {};
      totalsRef.current = () => {};
      revealRef.current = () => {};
    };
  }, [client, jobs]);

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

  // What the page opens for a card: the re-run menu, a series' translation window, the tag editor,
  // the file picker of Replace.
  const tRef = useRef(t);
  tRef.current = t;
  const [rerun, setRerun] = useState<RerunAsk | null>(null);
  const [seriesAsk, setSeriesAsk] = useState<SeriesTranslateAsk | null>(null);
  const [tagging, setTagging] = useState<string | null>(null);
  // Which of them has been opened: drawn from then on (closed, it keeps its place to close from).
  const [opened, setOpened] = useState({ rerun: false, series: false, tags: false });
  const open = (which: keyof typeof opened) => setOpened((was) => (was[which] ? was : { ...was, [which]: true }));
  const replaceInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
  // The card a file picker was opened from: once the window has its focus back, the browser is made to
  // work out again what is under the pointer, or the card stays grown with nothing over it (1.3's
  // _operatingOnCard).
  const operating = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const focus = () => {
      const card = operating.current;
      if (!card) return;
      operating.current = null;
      card.style.pointerEvents = 'none';
      void card.offsetHeight;
      card.style.pointerEvents = '';
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  // The cover a card shows, for a dialog about it: none while Safe Mode blurs it (1.3's _cardCover).
  const coverOf = (id: string) => {
    const g = galleryOf(id);
    if (!g || (safeRef.current && !ratedSafe(g))) return '';
    return covers.get(coverKeyOf(g, mergeRef.current)) || '';
  };
  const actions = useMemo(() => cardActions({
    client, jobs,
    gallery: (id) => galleryOf(id) as ShownGallery | undefined,
    merged: () => mergeRef.current,
    cover: coverOf,
    canDownload: (g) => canDownload(g as never) as boolean,
    // (What it accepts is import-files.js's, loaded at the press: the page reads none of it.)
    pickFile: (id) => {
      replacing.current = id;
      operating.current = grid.current?.querySelector<HTMLElement>(`:scope > .card[data-gallery-id="${CSS.escape(id)}"]`) ?? null;
      import('@lib/import-files.js').then(({ IMPORT_ACCEPT }) => { const input = replaceInput.current; if (input) { input.accept = IMPORT_ACCEPT; input.click(); } }, () => {});
    },
    rerunMenu: (id, anchor) => { rerunMenu().then((m) => m.rerunSteps(id, anchor)).then((ask) => { open('rerun'); setRerun(ask); }, (err) => console.error(err)); },
    seriesTranslate: (g) => { seriesWindow().then((m) => m.seriesTranslateAsk(tRef.current, g as never)).then((ask) => { open('series'); setSeriesAsk(ask); }, (err) => console.error(err)); },
    tagEditor: (id) => { open('tags'); setTagging(id); },
    reread: () => Promise.all([client.invalidateQueries({ queryKey: PAGES }), client.invalidateQueries({ queryKey: TOTALS })]),
  }), [client, jobs, covers]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── A card dragged onto another: a series ──
  // The drags begun (a copy still flying to its place among them), undone when the page is left.
  const drags = useRef(new Set<CardDrag>());
  useEffect(() => () => { for (const drag of drags.current) drag.cancel(); drags.current.clear(); }, []);
  const coverPointerDown = useCallback((id: string, e: React.PointerEvent<HTMLAnchorElement>) => {
    const card = e.currentTarget.closest<HTMLElement>('.card');
    if (!card) return;
    const start = { x: e.clientX, y: e.clientY };
    // A press let go before the module has come was a click.
    let released = false;
    const up = () => { released = true; };
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    cardDrag().then(({ beginCardDrag }) => {
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      if (released || left.current) return;
      const drag = beginCardDrag(start, card, id, { onDrop: (target, source) => { actions.mergeDrop(target, source).catch((err) => console.error(err)); }, onDone: () => drags.current.delete(drag) });
      drags.current.add(drag);
    }, (err) => console.error(err));
  }, [actions]);
  const on = useMemo<CardHandlers>(() => ({
    ...actions,
    tag: (_id, tag) => addToken(tagToken(tag.type, String(tag.name).trim())),
    flag: (_id, _code, name) => { if (name) addToken(flagToken(name)); },
    searchFavorite: (id) => { const g = galleryOf(id); if (g) addToken(stateToken('favorite', g.favorite)); },
    searchTranslated: (id) => { const g = galleryOf(id); if (g) addToken(stateToken('translated', g.translated)); },
    searchSource: (id) => { const g = galleryOf(id); if (g?.source) addToken(sourceToken(g.source)); },
    jobSettled: (id) => jobs.settled(id),
    coverPointerDown,
  }), [actions, addToken, jobs, coverPointerDown]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A step of the re-run menu chosen: asked first, then translated again from that step.
  const rerunFrom = async (id: string, point: string, label: string) => {
    const g = galleryOf(id) as ShownGallery | undefined;
    if (!g) return;
    if (!(await (confirmDialog as unknown as (ask: object) => Promise<boolean>)({
      title: t('dlg.rerun_title', { stage: label }), body: t('dlg.rerun_body'),
      detail: galleryDetail(g), cover: coverOf(id), ok: t('dlg.rerun_ok'),
    }))) return;
    await actions.startTranslation(g, point);
  };

  // The search box: typed, cleared, or read back.
  const onQueryChange = useCallback((q: string, how: 'typed' | 'cleared' | 'set') => {
    setTyped(q);
    clearTimeout(searchTimer.current);
    if (how === 'set') { setQuery(q); return; }
    if (how === 'cleared') { setQuery(''); setPage(1); return; }
    searchTimer.current = setTimeout(() => { setQuery(q); setPage(1); }, SEARCH_MS);
  }, []);

  // ── Paging: a button, or the arrows and A/D (Shift: the first or the last page); W/S; F5 ──
  const pages = data ? pageCount(data.total) : 1;
  const shownPage = data?.page ?? page;
  const goToPage = useCallback((n: number) => {
    setPage(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);
  const pagingRef = useRef({ page: shownPage, pages });
  pagingRef.current = { page: shownPage, pages };
  // The library read again in place (1.3's F5: loadAll): the page, its totals, what is under way. Its
  // covers are kept, so none is asked for again.
  const refreshRef = useRef(() => {});
  refreshRef.current = () => {
    client.invalidateQueries({ queryKey: PAGES }).catch(() => {});
    client.invalidateQueries({ queryKey: TOTALS }).catch(() => {});
    jobs.refresh();
  };
  useEffect(() => {
    // W/S: a frame loop from the keydown, skipping the system's repeat delay. Each key held is a
    // direction; both cancel out.
    const held = new Set<'up' | 'down'>();
    let frame = 0, fast = false;
    const scroll = () => {
      const dir = (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0);
      if (!dir) { frame = 0; return; }
      window.scrollBy(0, dir * (fast ? SCROLL_SPEED : SCROLL_SPEED / 2));
      frame = requestAnimationFrame(scroll);
    };
    const hold = (dir: 'up' | 'down') => {
      if (held.has(dir)) return;
      held.add(dir);
      if (!frame) frame = requestAnimationFrame(scroll);
    };
    const keys = (e: KeyboardEvent) => {
      if (keysTaken(e)) return;
      fast = e.shiftKey;   // Shift held: twice as fast, even mid-hold
      if (e.key === 'w' || e.key === 'W') { e.preventDefault(); hold('up'); return; }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); hold('down'); return; }
      const fwd = e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D';
      const bck = e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A';
      if (!fwd && !bck) return;
      e.preventDefault();
      const now = pagingRef.current;
      const next = e.shiftKey ? (fwd ? now.pages : 1) : Math.max(1, Math.min(now.pages, now.page + (fwd ? 1 : -1)));
      if (next === now.page) return;
      goToPage(next);
    };
    const released = (e: KeyboardEvent) => {
      fast = e.shiftKey;   // Shift let go: back to the half speed, live
      if (e.key === 'w' || e.key === 'W') held.delete('up');
      if (e.key === 's' || e.key === 'S') held.delete('down');
    };
    const lost = () => { held.clear(); fast = false; };
    // F5 and Ctrl+R (not Ctrl+Shift+R): read in place, nothing loaded. Before anything else has the key,
    // from a text box too.
    const reload = (e: KeyboardEvent) => {
      if (e.key !== 'F5' && !((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r' && !e.shiftKey)) return;
      e.preventDefault();
      refreshRef.current();
    };
    document.addEventListener('keydown', reload, true);
    document.addEventListener('keydown', keys);
    document.addEventListener('keyup', released);
    window.addEventListener('blur', lost);
    return () => {
      document.removeEventListener('keydown', reload, true);
      document.removeEventListener('keydown', keys);
      document.removeEventListener('keyup', released);
      window.removeEventListener('blur', lost);
      cancelAnimationFrame(frame);
    };
  }, [goToPage]);

  // ── The filter ──
  const [filterOpen, setFilterOpen] = useState(false);
  // A press or Clear: kept, and the library read again from page 1 (even when Clear found nothing set).
  const setFilter = (next: LibFilter) => {
    prefs.set('libFilter', JSON.stringify(next));
    setPage(1);
  };

  // ── Import: the picker, a drop on the page, the address asking for the picker ──
  // What a pick or a drop holds goes the way 1.3's _handleImportFiles sent it (library-import.ts).
  const importInput = useRef<HTMLInputElement>(null);
  const importFiles = useCallback((files: File[], folders: never[] = [], leftOut = 0) => {
    libraryImport().then((m) => m.handleImportFiles(files, folders, { leftOut, reread: actions.reread })).catch((err) => console.error(err));
  }, [actions]);
  // The picker, once what it offers has come (the first press loads it).
  const pickImport = useCallback(() => {
    libraryImport().then(({ PICK_ACCEPT }) => {
      const input = importInput.current;
      if (!input) return;
      input.accept = PICK_ACCEPT;
      input.click();
    }, (err) => console.error(err));
  }, []);
  // ?import=1: the picker opened once the page has loaded (on a change of route to it, at once).
  useEffect(() => {
    if (new URLSearchParams(location.search).get('import') !== '1') return;
    const go = () => { if (!left.current) pickImport(); };
    if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
  }, [location.key]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Files dragged in from outside the window: the overlay while they are over it (1.3's depth count;
  // never for a card being dragged, which is no drag of the browser's, or for text), and a drop read
  // (its folders' lists in full, the tracker telling how far, at most every 100 ms), then imported as a
  // pick is. Only while the page shows: Tasks and Settings take no drop.
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    let depth = 0, shown = true;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      setDragOver(true);
    };
    const leave = () => { if (--depth <= 0) { depth = 0; setDragOver(false); } };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      if (!e.dataTransfer) return;
      const items = dropItems(e.dataTransfer);
      const name = items.items.map((item) => item.webkitGetAsEntry()?.name).find(Boolean) || '';
      let toldAt = 0;
      libraryImport().then(async (m) => {
        if (!shown) return;
        const { files, folders, leftOut } = await m.readDrop(items, (found) => {
          if (!shown || Date.now() - toldAt < LISTING_EVERY_MS) return;
          toldAt = Date.now();
          listing(name, found);
        });
        listing(null);
        // (A page left while its drop was read takes the drop with it, as 1.3's did.)
        if (shown) await m.handleImportFiles(files, folders, { leftOut, reread: actions.reread });
      }).catch((err) => console.error(err));
    };
    document.addEventListener('dragenter', enter);
    document.addEventListener('dragleave', leave);
    document.addEventListener('dragover', over);
    document.addEventListener('drop', drop);
    return () => {
      shown = false;
      document.removeEventListener('dragenter', enter);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('dragover', over);
      document.removeEventListener('drop', drop);
    };
  }, [actions, listing]);

  // ── The grid's element: the cards' modes, Shift held ──
  const grid = useRef<HTMLDivElement>(null);
  useShiftHeld(grid);
  const modes = cardModes({ quickActions, hideCategory: !showCategory, translatorOffline: !translatorOnline, safeMode: safe });

  return (
    <>
      <LibraryHeader t={t} query={typed} onQueryChange={onQueryChange} totals={totals.data} showTotals={showTotals} onImport={pickImport}
        pinned={pinned} onPin={() => setPinned((was) => !was)} safe={safe} onSafe={toggleSafe} />
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
        {tracking && <Suspense fallback={null}><LibraryTracker onStore={onTrackerStore} /></Suspense>}
        <div ref={grid} id="grid" data-card-modes={modes}
          className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] auto-rows-fr items-start gap-[16px] px-[24px] pb-[40px] max-w-[1512px] mx-auto [@media(max-width:600px)]:grid-cols-[repeat(2,minmax(0,1fr))] [@media(max-width:600px)]:gap-[10px] [@media(max-width:600px)]:px-[12px] [@media(max-width:600px)]:pb-[32px]">
          {galleries.map((g) => <LibraryCard key={String(g.id)} g={g} env={env} covers={covers} icons={icons} jobs={jobs} on={on} safe={safe} scrambler={scrambler} />)}
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
      <Suspense fallback={null}>
        {opened.rerun && <RerunMenu t={t} ask={rerun} onClose={() => setRerun(null)} onPick={(id, point, label) => { setRerun(null); rerunFrom(id, point, label).catch(() => {}); }} />}
        {opened.series && <SeriesTranslateDialog t={t} ask={seriesAsk} onClose={() => setSeriesAsk(null)}
          onGo={(gid) => { platform.rpc({ type: 'TRANSLATE_GALLERY', galleryId: gid }); }} />}
        {opened.tags && <TagEditor gid={tagging} onClose={() => setTagging(null)} />}
      </Suspense>
      <input ref={importInput} type="file" id="cbzFileInput" multiple hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = '';
          importFiles(files);
        }} />
      {/* (1.3's words for it were its stylesheet's, in English for every language: A6.) */}
      <DropOverlay shown={dragOver}>Drop to import</DropOverlay>
      <input ref={replaceInput} type="file" id="replaceImgInput" multiple hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          const gid = replacing.current;
          e.currentTarget.value = '';
          if (gid && files.length) actions.replaceImages(gid, files).catch(() => {});
        }} />
    </>
  );
}

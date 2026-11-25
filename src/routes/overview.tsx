// overview.tsx — a gallery's or a series' overview, the landing before the reader, as the one page
// draws it (at /overview-next while 1.3's page answers /overview): the header's parts (the page menu,
// Settings), the hero (./overview/hero.tsx: the cover and its backdrop, the titles, the actions, the
// details, the tags), the heading over the list (a series' chapters/volumes switch with its count, a
// gallery's pages with theirs), a series' rows (./overview/rows.tsx) or a gallery's page grid, the
// add-a-chapter bar, and the import batches' tracker (1.3's #ovImports).
//
// It reads; it changes nothing (7a). The buttons that change things (the heart, Edit, Archive now,
// Move, a row's arrows, download, translate, detach, delete, the grip, the add bar) are drawn in their
// place and do nothing yet: 7b's and 7c's.
//
// What it shows is data (T4): the page's frame (which gallery, a series or not, its members, the
// series' title) and the tags' counts are queries (./overview/data.ts), each member's gallery its own
// entry in the app's cache, which the library's change feed keeps up to date (lib/gallery.ts): one
// chapter changing draws its row alone; the series changing (here or in another context) reads the
// frame again and draws what differs, a row that moved sliding to its place. Nothing on the page is
// patched by hand, but for the page grids' tiles, which the thumbnail engine makes inside an element
// React leaves alone (src/lib/page-thumbs.ts, 1.3's own engine moved: a long gallery has thousands).
// Covers are the page's store (./overview/covers.ts), jobs on rows the page's job store
// (./overview/jobs.ts), each outside React and read by the part that shows them.
//
// Drawn on 1.3's sizes (overview.css, ./overview/overview.css).
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import * as api from '@lib/api.js';
import * as platform from '@lib/platform.js';
import { getLang } from '@lib/i18n.js';
import { canDownload, galleryLink, siteName } from '@lib/sites.js';
import { canDetachChapter, chapterNumberLabel, chapterTally } from '@lib/series.js';
import { normalizeTitle, pickSeriesTitle, pickTitle, seriesTitleObject } from '@lib/titles.js';
import { formatBytes, formatCompact, formatCount, formatMegapixels } from '@lib/format.js';
import { describePage } from '@lib/page-size.js';
import { memberKind } from '@lib/gallery-model.js';
import { safeExternalUrl } from '@lib/sanitize.js';
import { imageToBlob, resizeToWidth } from '@lib/image-util.js';
import { tagKey } from '@lib/tag-editor.js';
import { HeaderSlot } from '@/components/header-slot';
import { ImportTracker } from '@/components/import-tracker';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { PageMenu } from '@/components/ui/page-menu';
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs';
import { Eyebrow } from '@/components/ui/text';
import { galleryQuery } from '@/lib/gallery';
import { useT, type Translate } from '@/lib/i18n';
import { createBatchStore } from '@/lib/import-batches';
import { readAgain } from '@/lib/library-query';
import { goTo } from '@/lib/links';
import { useShiftHeld } from '@/lib/modifiers';
import { useTitle } from '@/lib/title';
import { siteRoot } from '../entry';
import { createOverviewCovers, HERO_WIDTH } from './overview/covers';
import { followFrame, overviewKey, readFrame, readTagCounts, tagCountsKey, type Entity, type Ref } from './overview/data';
import { Hero, type HeroView } from './overview/hero';
import { createChapterJobs } from './overview/jobs';
import { createGridEngine, PageGrid, useCover } from './overview/parts';
import { prefs, useSeriesView } from './overview/prefs';
import { ChapterList, ChapterRow, type RowDeps } from './overview/rows';
import { useRunners } from './overview/runners';
import { altTitle, chapterJob, heroMeta, rowActions, rowView, shownKind, tableTags, tagRows, type Formats, type Member } from './overview/view';
import './overview/overview.css';

const readerHref = (gid: string) => `reader?g=${encodeURIComponent(String(gid))}`;

// The add-a-chapter bar: drawn, doing nothing yet (7c: a chapter added from the library, a file dropped).
const AddBar = memo(function AddBar({ t, kind }: { t: Translate; kind: 'chapter' | 'volume' }) {
  return (
    <div className="add-bar" id="addBar">
      <Eyebrow as="h3" size="lg" id="addHeading">{t(kind === 'volume' ? 'ov.add_volume' : 'ov.add_chapter')}</Eyebrow>
      <div className="add-search-wrap">
        <Input variant="inset" size="xl" className="add-search" id="addSearch" placeholder={t('ov.add_search_ph')} autoComplete="off" spellCheck={false} />
      </div>
      <div className="add-hint">{t('ov.add_hint')}</div>
    </div>
  );
});

export default function Overview() {
  // 1.3's page's own title (overview.html).
  useTitle('Series');
  const t = useT();
  const navigate = useNavigate();
  const client = useQueryClient();
  const g = new URLSearchParams(useLocation().search).get('g');

  // ── The page's stores: covers, jobs on rows, the page grids' engine, the import batches ──
  const [covers] = useState(() => createOverviewCovers({ rpc: platform.rpc, onControl: platform.onControl }));
  useEffect(() => { covers.start(); return () => covers.stop(); }, [covers]);
  const [jobs] = useState(() => createChapterJobs({ jobs: platform.jobs as never, now: Date.now, reread: (gid) => { readAgain(client, gid).catch(() => {}); } }));
  useEffect(() => { jobs.start(); return () => jobs.stop(); }, [jobs]);
  const [grids] = useState(() => createGridEngine({
    pages: api.pages as never, imageToBlob: imageToBlob as never, resizeToWidth: resizeToWidth as never,
    worker: () => new Worker(new URL(`${siteRoot}app/js/thumb-worker.js`, location.origin), { type: 'module' }),
    readerHref: (gid, n) => `${readerHref(gid)}&page=${n}`,
    noPages: () => t('ov.no_pages'),
  }));
  useEffect(() => () => grids.stop(), [grids]);
  const [batches] = useState(createBatchStore);
  useEffect(() => { batches.start(); return () => batches.stop(); }, [batches]);
  useEffect(() => { prefs.start(); return () => prefs.stop(); }, []);
  const { sites, translatorOnline } = useRunners();

  // ── The frame: which gallery, its members ──
  // Resolved from the owner the page found (1.3 kept it), from the address's gallery at first.
  const owner = useRef<{ g: string | null; id: string | null }>({ g, id: null });
  if (owner.current.g !== g) owner.current = { g, id: null };
  const frameQuery = useQuery({
    queryKey: overviewKey(g ?? ''), enabled: !!g, staleTime: Infinity,
    queryFn: async () => {
      const at = owner.current;
      const frame = await readFrame(client, at.id ?? g!);
      if (frame.found && owner.current === at) at.id = frame.ownerId;
      return frame;
    },
  });
  const frame = frameQuery.data;
  const refs: Ref[] = useMemo(() => (frame?.found ? frame.refs : []), [frame]);
  const ownerId = frame?.found ? frame.ownerId : null;
  const ids = useMemo(() => [...new Set([...(ownerId ? [ownerId] : []), ...refs.map((r) => r.id)])], [ownerId, refs]);
  // The frame read again when the library says the owner, the address's gallery or everything changed.
  const followed = useRef<string[]>([]);
  followed.current = [g ?? '', ownerId ?? ''];
  useEffect(() => followFrame(api.events.watch, () => followed.current,
    () => { client.invalidateQueries({ queryKey: overviewKey(g ?? '') }).catch(() => {}); }), [client, g]);

  // Every member's gallery (and the owner's), each from its own entry.
  const entities = useQueries({
    queries: ids.map((id) => ({ ...galleryQuery(id), staleTime: Infinity })),
    combine: (results) => results.map((r) => r.data as Entity | null | undefined),
  });
  const entityOf = useMemo(() => new Map(ids.map((id, i) => [id, entities[i] ?? null])), [ids, entities]);
  const ownerEntity = ownerId ? entityOf.get(ownerId) ?? null : null;
  const members: Member[] = useMemo(() => refs.map((r) => ({ ...r, entity: entityOf.get(r.id) ?? null })), [refs, entityOf]);

  // ── Chapters or volumes ──
  const view = useSeriesView();
  const [forced, setForced] = useState<string | null>(null);
  useEffect(() => setForced(null), [g]);
  const isSeries = !!(frame?.found && frame.isSeries);
  const kind = isSeries ? shownKind(refs, view, forced, memberKind) : 'chapter';
  const chapters = useMemo(() => (isSeries ? refs.filter((r) => memberKind(r) === kind) : refs), [isSeries, refs, kind]);
  const chooseView = (next: string) => {
    if (next === (kind === 'volume' ? 'volumes' : 'chapters')) return;
    setForced(next);
    prefs.set('seriesView', next);
  };

  // ── The tags' counts: read when the owner's tags change; the last table drawn stays until then ──
  const tags = useMemo(() => tableTags(ownerEntity?.tags), [ownerEntity?.tags]);
  const keys = useMemo(() => tags.map((tg) => tagKey(tg.type, tg.name) as string), [tags]);
  const counts = useQuery({ queryKey: tagCountsKey(keys), queryFn: () => readTagCounts(keys), enabled: !!frame?.found, staleTime: Infinity });
  const drawnTags = useRef<{ tags: Entity['tags']; counts: Map<string, number> } | null>(null);
  if (counts.data && drawnTags.current?.tags !== ownerEntity?.tags) drawnTags.current = { tags: ownerEntity?.tags, counts: counts.data };

  // Places the gallery could move to: asked once (1.3's buildShell).
  const [movable, setMovable] = useState(false);
  useEffect(() => {
    let live = true;
    api.folders.list().then((places: { hidden?: boolean }[]) => { if (live) setMovable(places.filter((p) => !p.hidden).length >= 2); }, () => {});
    return () => { live = false; };
  }, []);

  // ── The cover ──
  const heroCover = useCover(covers, ownerId, { preferSeries: isSeries, width: HERO_WIDTH }, ownerEntity);

  // ── What the page draws ──
  const lang = getLang();
  const formats = useMemo<Formats>(() => ({
    t, lang, count: (n) => formatCount(n), bytes: (n) => formatBytes(n), compact: (n) => formatCompact(n),
    megapixels: (mp) => formatMegapixels(mp), describePage: describePage as Formats['describePage'], now: Date.now,
  }), [t, lang]);
  const hero = useMemo<HeroView | null>(() => {
    if (!frame?.found || !ownerId) return null;
    const heading = isSeries
      ? (pickSeriesTitle(frame.seriesTitle as never, ownerEntity as never, lang) || `#${ownerId}`)
      : (pickTitle(ownerEntity as never, lang) || `#${ownerId}`);
    const titles = isSeries ? (seriesTitleObject(frame.seriesTitle as never) || normalizeTitle(ownerEntity as never)) : normalizeTitle(ownerEntity as never);
    const source = galleryLink(ownerEntity as never, 1) as string;
    const drawn = drawnTags.current;
    const rows = drawn ? tagRows(drawn.tags, drawn.counts, tagKey as never, formats) : [];
    return {
      isSeries, ownerId, heading, fallback: pickTitle(ownerEntity as never, lang) || `#${ownerId}`,
      subtitle: altTitle(titles as never, heading, lang),
      startHref: readerHref((chapters[0] || refs[0]).id),
      favorite: !!ownerEntity?.favorite,
      archive: api.capabilities.archive ? { archived: members.every((m) => m.entity?.archived) } : null,
      movable,
      source: source ? { href: source, tip: `${siteName(ownerEntity?.source as never)}: ${source}` } : null,
      meta: heroMeta({ isSeries, owner: ownerEntity, uploadDate: frame.uploadDate, kind }, members, memberKind, chapterTally as never, formats),
      tags: rows.length ? rows : null,
    };
  }, [frame, ownerId, ownerEntity, isSeries, kind, chapters, refs, members, movable, formats, lang, sites, drawnTags.current]);   // eslint-disable-line react-hooks/exhaustive-deps

  const rowDeps = useMemo<RowDeps>(() => ({
    t, covers, jobs, grids,
    view: (ch, idx, e) => rowView(ch, idx, e, { pickTitle: pickTitle as never, chapterNumberLabel: chapterNumberLabel as never, memberKind, safeExternalUrl: safeExternalUrl as never, readerHref }, formats),
    actions: (e, job) => rowActions(e, job, !!e && (canDownload(e as never) as boolean), canDetachChapter(e as never) as boolean, formats),
    jobView: (job) => chapterJob(job, formats),
  }), [t, covers, jobs, grids, formats, sites]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard use: a row's buttons stay up while one of them has keyboard focus ──
  // Not the focus a click leaves behind: the clicked row may slide away from the pointer (an arrow
  // press), and its buttons would stay up beside the hovered row's. A key other than a modifier marks
  // keyboard use, and a press of the pointer clears it (1.3's).
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let keyboard = false;
    const key = (e: KeyboardEvent) => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) keyboard = true; };
    const press = () => { keyboard = false; };
    const focus = (e: FocusEvent) => {
      for (const box of document.querySelectorAll('.ch-actions.key-focus')) box.classList.remove('key-focus');
      if (keyboard) (e.target as Element | null)?.closest?.('.ch-actions')?.classList.add('key-focus');
    };
    const el = content.current;
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', press, true);
    el?.addEventListener('focusin', focus);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', press, true);
      el?.removeEventListener('focusin', focus);
    };
  }, []);
  const wrap = useRef<HTMLDivElement>(null);
  useShiftHeld(wrap);

  const ready = !!frame && (!frame.found || (ownerEntity !== undefined && !!drawnTags.current));
  const totalPages = members.reduce((s, c) => s + (c.entity?.count || 0), 0);
  const numChars = String(Math.max(1, ...chapters.map((c, i) => String(chapterNumberLabel(c) ?? i + 1).length)));

  return (
    <>
      <HeaderSlot side="left"><span className="brand-sep">/</span><PageMenu page="overview" /></HeaderSlot>
      <HeaderSlot side="right">
        <Button id="settingsBtn" variant="quiet" tone="primary" size="icon" coarse="40" className="btn-settings" aria-label={t('nav.settings')} data-tip={t('nav.settings')}
          onClick={() => goTo(navigate, 'settings')}>
          <Settings className="size-[16px]" />
        </Button>
      </HeaderSlot>
      <div className="ov-wrap" ref={wrap}>
        <div id="ovContent" ref={content} data-translator-offline={translatorOnline ? undefined : ''}>
          {!g || (frame && !frame.found) ? <EmptyState className="ov-empty">{t('ov.not_found')}</EmptyState>
            : !ready || !hero ? <EmptyState className="ov-loading">{t('ov.loading')}</EmptyState>
            : (
              <>
                <Hero t={t} view={hero} cover={heroCover} />
                <Eyebrow as="h2" size="md" className="ov-section-title m-0 mb-[12px] flex items-baseline gap-[8px]" id="ovSection">
                  {isSeries ? (
                    <Tabs variant="underline" className="contents" value={kind === 'volume' ? 'volumes' : 'chapters'} onValueChange={chooseView}>
                      <TabsList className="ov-view-toggle">
                        <TabsTab value="chapters" className="ov-view" data-view="chapters">{t('ov.chapters')}</TabsTab>
                        <TabsTab value="volumes" className="ov-view" data-view="volumes">{t('ov.volumes')}</TabsTab>
                      </TabsList>
                    </Tabs>
                  ) : t('card.pages')}
                  <span className="ov-count">{formatCount(isSeries ? chapters.length : totalPages)}</span>
                </Eyebrow>
                <div id="ovBody">
                  {isSeries ? (
                    <ChapterList order={chapters.map((c) => `${c.id}:${!!entityOf.get(c.id)}`).join(',')} numChars={numChars}>
                      {chapters.map((c, i) => {
                        const e = entityOf.get(c.id) ?? null;
                        return <ChapterRow key={`${c.id}:${!!e}`} chapter={c} idx={i} entity={e} last={i === chapters.length - 1} deps={rowDeps} />;
                      })}
                    </ChapterList>
                  ) : <PageGrid key={ownerId} engine={grids} gid={ownerId!} version={ownerEntity} className="ov-pages" id="ovPages" />}
                </div>
                <AddBar t={t} kind={kind} />
              </>
            )}
        </div>
        <ImportTracker store={batches} id="ovImports" className="mt-[16px]" />
      </div>
    </>
  );
}

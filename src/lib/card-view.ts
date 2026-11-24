// card-view.ts — what a library card shows of its gallery, as data: 1.3's _cardView (app/js/library.js)
// stated once, with the words its _paintCard and _syncCardActions put on the card's buttons, and what a
// job on the card does to it (applyJob's drawing). GalleryCard (src/components/gallery-card.tsx) draws
// it; nothing here draws, reads the library or keeps anything.
//
// cardView(g, cover, env): g is the gallery as the library hands it over (store.js's entity), cover the
// data URL of its cover when one is at hand (null until then), env everything else it depends on:
//   t, lang          the words, and the app's language (titles, flags)
//   count, bytes, megapixels   the number formats (app/js/format.js)
//   prefs            mergeSeries (a series shown as one card), bypassOverview (a card opens the reader),
//                    seriesView ('chapters' | 'volumes', the overview's), hideAppLangFlag
//   site             canDownload(g), name(source), link(g, page), icon(source) (a cached icon's data URL,
//                    or ''): sites.js's, and the page's icon cache
//   langName(code)   a language's name in the app's language (tag-editor.js's langDisplayName)
//   rules            the pure rules it shares with the rest of the app: titles.js's pickTitle and
//                    pickSeriesTitle, series.js's chapterTally, gallery-model.js's memberKind,
//                    sanitize.js's safeExternalUrl, tag-editor.js's LANG_TAG_NAME
// Pure: all of it handed in, so Node tests it against 1.3's own lines (app/tests/card-view.test.mjs).
import type * as Titles from '@lib/titles.js';
import type * as Series from '@lib/series.js';
import type * as Model from '@lib/gallery-model.js';
import type * as Sanitize from '@lib/sanitize.js';
import type * as TagEditor from '@lib/tag-editor.js';
import { isRunning, jobButton, jobView, type JobFormat, type JobNews, type JobView } from './job-view.ts';

// A gallery as the library hands it over: the fields a card reads.
export type CardGallery = {
  id: string;
  isSeries?: boolean;
  count?: number; numPages?: number; size?: number; origSize?: number;
  aggPages?: number; aggSize?: number; aggOrig?: number;
  medianPage?: PageSize | null; aggMedianPage?: PageSize | null;
  missing?: boolean;
  chapters?: { id: string; title?: string; number?: number | string | null; kind?: string }[] | null;
  chapterCount?: number;
  source?: string; sourceId?: string | null; sourceUrl?: string;
  isLocalImport?: boolean;
  tags?: { type: string; name: string }[];
  languages?: string[];
  favorite?: boolean;
  translated?: boolean;
  title?: unknown; seriesTitle?: unknown;
  [field: string]: unknown;
};
// A typical page, as store.js describes it (page-size.js describePage): its size, megapixels and tier.
export type PageSize = { w: number; h: number; mp: number; tier: string };

export type CardRules = Pick<typeof Titles, 'pickTitle' | 'pickSeriesTitle'> & Pick<typeof Series, 'chapterTally'>
  & Pick<typeof Model, 'memberKind'> & Pick<typeof Sanitize, 'safeExternalUrl'> & Pick<typeof TagEditor, 'LANG_TAG_NAME'>;

export type CardEnv = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  lang: string;
  count: (n: unknown) => string;
  bytes: (n: number) => string;
  megapixels: (mp: number) => string;
  prefs: { mergeSeries: boolean; bypassOverview: boolean; seriesView: string; hideAppLangFlag: boolean };
  site: {
    canDownload: (g: CardGallery) => boolean;
    name: (source: string | undefined) => string;
    link: (g: CardGallery, page: number) => string;
    icon: (source: string) => string;
  };
  langName: (code: string) => string;
  rules: CardRules;
};

// A tag chip, in the order the card lays them: the language flags, then the category, the artists,
// the tags, the female and the male ones, then "+".
export type CardTag =
  | { kind: 'flag'; code: string; name: string; tip: string; flag: string }
  | { kind: 'tag'; type: 'category' | 'artist' | 'tag' | 'tag:female' | 'tag:male'; name: string; text: string }
  | { kind: 'add'; tip: string };

// What the open button shows at rest: the chain (no source), a source's cached icon, or, while a
// source has none cached, the chain at the icon's smaller size where the icon will go.
export type OpenFace = { kind: 'chain' } | { kind: 'icon'; src: string; source: string } | { kind: 'slot'; source: string };

export type CardView = {
  id: string;
  series: boolean;              // drawn (and acting) as its series
  sfw: boolean;                 // rated safe or suggestive: Safe Mode leaves its cover alone
  href: string;                 // where it leads, from the site's root: the overview, or the reader
  cover: { src: string | null; expected: boolean };   // expected: a picture is (or will be) there
  badge: string;                // a series' chapters or volumes; '' for a gallery
  favorite: boolean;
  fav: { tip: string; alt: string };
  idText: string;
  local: boolean;               // a local import: the id in the second accent
  idHref: string | null;        // the source's page, when it has a safe link
  open: { tip: string; shift: string | null; alt: string | null; face: OpenFace };
  canDownload: boolean;         // the download button downloads; otherwise it is Replace
  download: { tip: string; shift: string | null };
  translated: boolean;
  translate: { tip: string; shift: string | null; alt: string };
  export: { tip: string; shift: string };
  remove: { tip: string; shift: string };
  title: string;
  pages: { text: string; tip: string | null; badge: string | null };
  size: { text: string; tip: string };
  missing: string | null;
  tags: CardTag[];
};

// Language code → its flag (app/flags/<code>.svg), for the leading flag chips.
export const LANG_FLAG: Readonly<Record<string, string>> = {
  en: 'GB', ja: 'JP', zh: 'CN', 'zh-CN': 'CN', 'zh-TW': 'TW', ko: 'KR', de: 'DE', fr: 'FR',
  es: 'ES', ru: 'RU', pt: 'PT', 'pt-BR': 'BR', it: 'IT', vi: 'VN', id: 'ID', th: 'TH',
  nl: 'NL', pl: 'PL', uk: 'UA',
};
// A language as its base code (zh-CN → zh): a flag in the app's own language is left out (an option).
const langBase = (code: unknown) => String(code || '').split('-')[0];

const TAG_ORDER = ['category', 'artist', 'tag', 'tag:female', 'tag:male'] as const;
const TAG_MARK: Record<string, string> = { 'tag:female': ' ♀', 'tag:male': ' ♂' };

export function cardTags(tags: unknown, languages: unknown, env: CardEnv): CardTag[] {
  const list = Array.isArray(tags) ? tags as { type: string; name: string }[] : [];
  const chips: CardTag[] = [];
  const appBase = langBase(env.lang);
  for (const code of Array.isArray(languages) ? languages as string[] : []) {
    if (!LANG_FLAG[code] || (env.prefs.hideAppLangFlag && langBase(code) === appBase)) continue;
    chips.push({ kind: 'flag', code, name: (env.rules.LANG_TAG_NAME as Record<string, string>)[code] || code, tip: env.langName(code), flag: LANG_FLAG[code] });
  }
  for (const type of TAG_ORDER) {
    for (const tag of list) if (tag.type === type) chips.push({ kind: 'tag', type, name: tag.name, text: `${tag.name}${TAG_MARK[type] ?? ''}` });
  }
  chips.push({ kind: 'add', tip: env.t('card.tip_addtag') });
  return chips;
}

// "Original pages X" over "Other data Y": a size not worked out again yet is all original.
function sizeTip(total: number | undefined, original: number | undefined, env: CardEnv) {
  const orig = original ?? total ?? 0;
  return env.t('lib.size_split', { orig: env.bytes(orig), rest: env.bytes(Math.max(0, (total || 0) - orig)) });
}
// The page count's tip: the typical page (its size and megapixels; its tier as the tip's badge) over
// the average original page's bytes. None while there are no pages.
function pagesPart(text: string, page: PageSize | null | undefined, original: number | undefined, count: number | undefined, env: CardEnv) {
  if (!count) return { text, tip: null, badge: null };
  const avg = env.t('card.tip_page_avg', { size: env.bytes((original || 0) / count) });
  return { text, tip: page ? `${page.w}×${page.h}, ${env.megapixels(page.mp)}\n${avg}` : avg, badge: page ? page.tier : null };
}

function openFace(source: string | undefined, env: CardEnv): OpenFace {
  if (!source) return { kind: 'chain' };
  const icon = env.site.icon(source);
  return icon ? { kind: 'icon', src: icon, source } : { kind: 'slot', source };
}

export function cardView(g: CardGallery, cover: string | null, env: CardEnv): CardView {
  const { t, count, prefs, site, rules } = env;
  // A series owner is drawn (and acts) as its series only while series are merged; otherwise it is
  // its own plain chapter-1 gallery.
  const series = !!(prefs.mergeSeries && g.isSeries);
  const src = cover || null;
  const totalCount = g.numPages ? ` / ${count(g.numPages)}` : '';
  const pages = series
    ? pagesPart(`${count(g.aggPages)} ${t('card.pages')}`, g.aggMedianPage, g.aggOrig, g.aggPages, env)
    : pagesPart(`${count(g.count)}${totalCount} ${t('card.pages')}`, g.medianPage, g.origSize, g.count, env);
  const size = series ? { text: env.bytes(g.aggSize as number), tip: sizeTip(g.aggSize, g.aggOrig, env) } : { text: env.bytes(g.size as number), tip: sizeTip(g.size, g.origSize, env) };
  // A series counts what the overview lists: its chapters or its volumes (the view chosen there), or
  // the other kind when it has none of that one.
  const tally = series && g.chapters ? rules.chapterTally(g.chapters) : { chapters: g.chapterCount, extras: 0 };
  const volumes = series && g.chapters ? g.chapters.filter((c) => rules.memberKind(c) === 'volume').length : 0;
  const countVolumes = volumes > 0 && (prefs.seriesView === 'volumes' || !tally.chapters);
  const canDownload = site.canDownload(g);
  const visitUrl = site.link(g, 1);
  const siteName = site.name(g.source);
  const translated = !!g.translated;
  return {
    id: String(g.id),
    series,
    // Safe Mode blurs a cover unless the gallery is rated safe or suggestive (an unrated one blurs).
    sfw: (g.tags || []).some((tg) => tg.type === 'rating' && (tg.name === 'safe' || tg.name === 'suggestive')),
    // Every gallery has an overview; the "skip overview" preference sends a card to the reader.
    href: prefs.bypassOverview ? `reader?g=${encodeURIComponent(g.id)}` : `overview?g=${encodeURIComponent(g.id)}`,
    cover: { src, expected: series ? ((g.aggPages || g.count || 0) > 0 || !!src) : ((g.count ?? 0) > 0 || !!src) },
    badge: !series ? '' : countVolumes ? t('card.volumes_n', { n: count(volumes) }) : t('card.chapters_n', { n: count(tally.chapters) }),
    favorite: !!g.favorite,
    fav: { tip: t(g.favorite ? 'card.tip_fav_remove' : 'card.tip_fav_add'), alt: t(g.favorite ? 'card.tip_search_fav' : 'card.tip_search_unfav') },
    idText: String(g.sourceId || g.id),
    local: !!g.isLocalImport,
    idHref: rules.safeExternalUrl(g.sourceUrl),
    open: {
      tip: visitUrl ? `${siteName}: ${visitUrl}` : t('card.tip_setsource'),
      shift: visitUrl ? t('card.tip_editsource') : null,
      // Alt searches the library for the gallery's source: only when it has one.
      alt: g.source ? t('card.tip_search_source', { site: siteName }) : null,
      face: openFace(g.source, env),
    },
    canDownload,
    download: {
      tip: !canDownload ? t('card.tip_replace') : g.numPages ? t('card.tip_dl', { n: count(g.numPages) }) : t('card.tip_dl_meta'),
      shift: canDownload ? t('card.tip_replace') : null,
    },
    translated,
    // A translated gallery's button also offers "Re-run from…" on a right-click, and Revert with Shift.
    translate: {
      tip: translated ? `${t('card.tip_translate_new')} · ${t('card.tip_rerun')}` : t('card.tip_translate'),
      shift: translated ? t('card.tip_revert') : null,
      alt: t(translated ? 'card.tip_search_translated' : 'card.tip_search_untranslated'),
    },
    export: { tip: t('card.tip_export'), shift: t('card.tip_export_meta') },
    remove: { tip: t('card.tip_delete'), shift: t('card.tip_quickdelete') },
    title: (series ? rules.pickSeriesTitle(g.seriesTitle as never, g as never, env.lang) : rules.pickTitle(g as never, env.lang)) || '',
    pages,
    size,
    // A library kept as files says when a gallery's files can't be found in its folder.
    missing: g.missing ? t('card.files_missing') : null,
    tags: cardTags(g.tags, g.languages, env),
  };
}

// ── A job on the card ──
// What the card shows of its gallery's job (applyJob's drawing), from the job's latest news:
//   shown   the job's place shows (its bar and line, in place of the meta line and the tags)
//   bar     the bar's fill, 0–100; null: no figure yet; undefined: as it was (an error)
//   done    the fill in the colour of success
//   label   the line under the bar
//   hold    the button the job holds: 'translate' (a translation), 'download' (a download, an upload),
//           or null (a series' sync, which has a bar of its own and holds none)
//   form    what that button is meanwhile: 'cancel' (a translation's or a download's Stop), 'busy'
//           (an upload's, pressed nothing), 'done' (finished: a download's shows ✓) or 'rest'
//   ended   a terminal word (done, failed, cancelled, interrupted): it stays JOB_LINGER_MS, then the
//           card returns to rest
// Null for news a card doesn't draw (a status it doesn't know: what it showed stays).
export type CardJob = { shown: boolean; bar: number | null | undefined; done: boolean; label: string; hold: 'translate' | 'download' | null; form: 'cancel' | 'busy' | 'done' | 'rest'; ended: boolean };

// How long a job's last word stays on a card before it returns to rest (1.3's JOB_MSG_LINGER_MS).
export const JOB_LINGER_MS = 4000;

// A press on a card that no news has answered yet, drawn as 1.3 drew it (GalleryCard's `pending`).
export type Pending = 'download' | 'translate' | 'revert' | null;

// What the button a job holds is while the job's latest news is `job`.
export const buttonForm = (job: JobNews): CardJob['form'] =>
  (job.status === 'done' ? 'done' : !isRunning(job) ? 'rest' : job.kind === 'translate' || job.kind === 'download' ? 'cancel' : 'busy');

export function cardJob(job: JobNews, f: JobFormat): CardJob | null {
  const view: JobView | null = jobView(job, f, 'card');
  if (!view) return null;
  // A cancelled job's word shows where the job showed; it doesn't bring the job's place up by itself.
  return { shown: job.status !== 'cancelled', bar: view.pct, done: view.done, label: view.label, hold: jobButton(job), form: buttonForm(job), ended: !isRunning(job) };
}

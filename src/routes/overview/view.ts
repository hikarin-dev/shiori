// view.ts — what the overview shows, as data: 1.3's "Header details" and its row painting
// (app/js/overview.js: tagTableHtml, heroMetaHtml, stampOf, relTime, altTitle, updateChapterRow,
// rowActionsHtml, paintChapterJob, shownKind), each stated once, in 1.3's order and words, returning
// what to draw instead of markup. Nothing here reads the library or the page: the galleries, the
// language, the helper's state and the formats are handed in.
import type { Entity, Ref } from './data';
import type { JobNews, JobView } from '@/lib/job-view';
import { jobView } from '@/lib/job-view';

type T = (key: string, vars?: Record<string, string | number>) => string;
export type Formats = {
  t: T;
  lang: string;
  count: (n: number) => string;
  bytes: (n: number) => string;
  compact: (n: number) => string;
  megapixels: (mp: number) => string;
  describePage: (page: unknown) => { w: number; h: number; mp: number; tier: string } | null;
  now: () => number;
};

// ── Tags ──
// The tags as a table: one labelled row per kind (the tag editor's names), each chip a link to the
// library searching for that tag, with how many library entries carry it. Female and male tags lead
// the general row, marked.
export const TAG_ROWS: [string, string[]][] = [
  ['addtag.cat_language', ['language']],
  ['addtag.cat_artist', ['artist']],
  ['addtag.cat_group', ['group']],
  ['addtag.cat_parody', ['parody']],
  ['addtag.cat_character', ['character']],
  ['addtag.cat_tag', ['tag:female', 'tag:male', 'tag']],
];
export const TAG_MARK: Record<string, string> = { 'tag:female': ' ♀', 'tag:male': ' ♂' };
export type TagChip = { type: string; name: string; text: string; href: string; count: string | null; key: string };
export type TagRow = { label: string; chips: TagChip[] };

// The owner's tags the table shows (the kinds it has rows for).
export const tableTags = (tags: Entity['tags']) => (Array.isArray(tags) ? tags : []).filter((tg) => TAG_ROWS.some(([, types]) => types.includes(tg.type)));

export function tagRows(tags: Entity['tags'], counts: Map<string, number>, tagKey: (type: string, name: string) => string, f: Pick<Formats, 't' | 'compact'>): TagRow[] {
  const list = tableTags(tags);
  return TAG_ROWS.map(([labelKey, types]) => ({
    label: f.t(labelKey),
    chips: types.flatMap((type) => list.filter((tg) => tg.type === type).map((tg) => {
      const n = counts.get(tagKey(type, tg.name));
      return { type, name: tg.name, text: `${tg.name}${TAG_MARK[type] || ''}`, key: `${type}\n${tg.name}`,
        href: `./?q=${encodeURIComponent(`${type}:"${tg.name}"`)}`, count: n ? f.compact(n) : null };
    })),
  })).filter((row) => row.chips.length);
}

// ── The details ──
// "2024/06/15 18:30" for a millisecond timestamp.
export function stampOf(ms: number) {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// "2 years ago" / "3 days ago" for a Unix-seconds timestamp, localized to the app language.
export function relTime(secs: number, lang: string, now: number) {
  const diffMs = secs * 1000 - now;
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536e6], ['month', 2592e6], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
  for (const [unit, ms] of units)
    if (abs >= ms) return rtf.format(Math.round(diffMs / ms), unit);
  return rtf.format(Math.round(diffMs / 1000), 'second');
}

// The title in the other script (the Japanese title under an English heading, and the reverse),
// when there is one and it differs from the heading.
export function altTitle(titles: { english?: string; japanese?: string; pretty?: string } | null | undefined, heading: string, lang: string) {
  const tt = titles || {};
  const alt = lang.startsWith('ja') ? (tt.english || tt.pretty) : tt.japanese;
  return alt && alt !== heading ? alt : '';
}

export type MetaIcon = 'category' | 'rating' | 'chapters' | 'pages' | 'size' | 'resolution' | 'posted' | 'added' | 'translate' | null;
export type MetaItem = { icon: MetaIcon; text: string; tip?: string; badge?: string; cls?: string; tag?: { type: string; name: string } };
export type Member = Ref & { entity: Entity | null };

// The details line under the actions: category and rating, then the chapters or volumes, pages,
// size, typical page size, whether it's translated and whether files are missing; then when it was
// posted and added, on a line of their own. Each explains itself on hover. `members`: every member
// of a series (or the gallery alone), whichever kind the list shows.
export function heroMeta(hero: { isSeries: boolean; owner: Entity | null; uploadDate: unknown; kind: 'chapter' | 'volume' }, members: Member[],
  memberKind: (m: unknown) => string, chapterTally: (m: unknown[]) => { chapters: number; extras: number }, f: Formats): MetaItem[][] {
  const { isSeries, owner, kind } = hero;
  const { t } = f;
  const tags = owner?.tags || [];
  const names = (type: string) => tags.filter((tg) => tg.type === type).map((tg) => tg.name).join(', ');
  const items: MetaItem[] = [];
  const item = (icon: MetaIcon, text: string, { tip = '', badge = '', cls = '', tag = '' } = {}) => items.push({
    icon, text, ...(tip ? { tip } : {}), ...(badge ? { badge } : {}), ...(cls ? { cls } : {}),
    ...(tag ? { tag: { type: tag, name: tags.find((tg) => tg.type === tag)!.name } } : {}) });
  const category = names('category'), rating = names('rating');
  if (category) item('category', category, { tip: t('filter.category'), cls: 'cap', tag: 'category' });
  if (rating) item('rating', rating, { tip: t('filter.rating'), cls: 'cap', tag: 'rating' });
  if (isSeries && kind === 'volume') {
    item('chapters', `${f.count(members.filter((c) => memberKind(c) === 'volume').length)} ${t('ov.volumes')}`);
  } else if (isSeries) {
    const tally = chapterTally(members);
    item('chapters', `${f.count(tally.chapters)} ${t('ov.chapters')}${tally.extras ? ` · ${t('card.extras_n', { n: f.count(tally.extras) })}` : ''}`);
  }
  const count = members.reduce((s, c) => s + (c.entity?.count || 0), 0);
  const size = members.reduce((s, c) => s + (c.entity?.size || 0), 0);
  const orig = members.reduce((s, c) => s + (c.entity?.origSize || 0), 0);
  const total = !isSeries && owner?.numPages ? ` / ${f.count(owner.numPages)}` : '';
  item('pages', `${f.count(count)}${total} ${t('card.pages')}`,
    { tip: count ? t('card.tip_page_avg', { size: f.bytes(orig / count) }) : '' });
  // Hovering the size splits it, as the library card does: the original pages, and the rest.
  item('size', f.bytes(size), { tip: t('lib.size_split', { orig: f.bytes(orig), rest: f.bytes(Math.max(0, size - orig)) }) });
  const page = f.describePage(isSeries ? owner?.aggMedianPage : owner?.medianPage);
  if (page) item('resolution', `${page.w}×${page.h}`, { tip: f.megapixels(page.mp), badge: page.tier });
  if (!isSeries && owner?.translated) item('translate', t('ov.translated'), { cls: 'done' });
  // A library kept as files says when a gallery's (or any member's) files can't be found.
  if (members.some((c) => c.entity?.missing)) item(null, t('card.files_missing'), { cls: 'missing' });
  // The dates get a line of their own.
  const details = items.splice(0);
  const posted = Number(hero.uploadDate) || Number(owner?.uploadDate) || 0;
  if (posted) item('posted', stampOf(posted * 1000), { tip: `${t('ov.posted')} · ${relTime(posted, f.lang, f.now())}` });
  if (owner?.addedAt) item('added', stampOf(owner.addedAt), { tip: `${t('page.added')} · ${relTime(owner.addedAt / 1000, f.lang, f.now())}` });
  return [details, items].filter((line) => line.length);
}

// ── Chapters or volumes ──
// Which members the series list shows: chapters or volumes, remembered for every series. A series
// with none of the chosen kind shows the other, unless the choice was just made on this page.
export function shownKind(members: unknown[], view: string, forced: string | null, memberKind: (m: unknown) => string): 'chapter' | 'volume' {
  const want = (forced || view) === 'volumes' ? 'volume' : 'chapter';
  if (forced || members.some((m) => memberKind(m) === want)) return want;
  return members.some((m) => memberKind(m) !== want) ? (want === 'volume' ? 'chapter' : 'volume') : want;
}

// ── A chapter's row ──
export type RowView = {
  num: string;
  href: string;
  // The title shown (its own, or the gallery's, or "Chapter n"), its placeholder, its own title.
  title: string; fallback: string; custom: string;
  id: { text: string; href: string | null };
  pages: string;
  translated: boolean;
  missing: boolean;
};

export function rowView(ch: Ref, idx: number, e: Entity | null, deps: {
  pickTitle: (e: unknown, lang: string) => string; chapterNumberLabel: (ch: unknown) => string | null; memberKind: (m: unknown) => string;
  safeExternalUrl: (u: unknown) => string | null; readerHref: (gid: string) => string;
}, f: Pick<Formats, 't' | 'lang' | 'count'>): RowView {
  const { t } = f;
  const title = deps.pickTitle(e, f.lang) || '';
  const num = deps.chapterNumberLabel(ch) ?? String(idx + 1);
  const nameKey = deps.memberKind(ch) === 'volume' ? 'ov.volume_n' : 'ov.chapter_n';
  const custom = ch.title || '';
  const fallback = title || t(nameKey, { n: num });
  const sourceHref = deps.safeExternalUrl(e?.sourceUrl) || null;
  return {
    num, href: deps.readerHref(ch.id), custom, fallback, title: custom.trim() || fallback,
    // The id opens the chapter's source page, as a library card's id does.
    id: { text: `#${e?.sourceId || ch.id}`, href: sourceHref },
    pages: e ? `${f.count(e.count || 0)}${e.numPages ? ` / ${f.count(e.numPages)}` : ''} ${t('card.pages')}` : t('ov.missing'),
    translated: !!e?.translated,
    missing: !!e?.missing,
  };
}

// A row's buttons, as its job and its gallery have them: download (Replace under Shift where a
// download is possible; Replace alone where not; Stop while its download runs, off while an import
// does; "✓" once a download or an import is done), translate (Revert under Shift once translated; Stop
// while it runs), detach (where its gallery has pages), and delete (quick under Shift).
export type DownloadButton = { face: 'download' | 'upload' | 'stop' | 'done'; tip: string; shift: string | null; disabled: boolean; cancelling: boolean };
export type TranslateButton = { face: 'translate' | 'stop'; tip: string; shift: string | null; done: boolean; cancelling: boolean };
export type RowActions = { download: DownloadButton | null; translate: TranslateButton | null; detach: boolean; remove: { tip: string; shift: string } };

export function rowActions(e: Entity | null, job: JobNews | null, canDownload: boolean, canDetach: boolean, f: Pick<Formats, 't' | 'count'>): RowActions {
  const { t } = f;
  const active = !!job && !['done', 'error', 'cancelled', 'interrupted'].includes(job.status ?? '');
  // A running download's button is its Stop control (as a translation's is); an import's is disabled.
  const stopDownload = active && job!.kind === 'download';
  const busyImport = active && job!.kind === 'upload';
  const busyTranslate = active && job!.kind === 'translate';
  // A download or an import done says so on its button until the row is at rest again.
  const doneDownload = !!job && job.status === 'done' && job.kind !== 'translate';
  const dlTitle = e?.numPages ? t('card.tip_dl', { n: f.count(e.numPages) }) : t('card.tip_dl_meta');
  const translatedTip = `${t('card.tip_translate_new')} · ${t('card.tip_rerun')}`;
  return {
    download: e ? {
      face: doneDownload ? 'done' : stopDownload ? 'stop' : canDownload ? 'download' : 'upload',
      tip: stopDownload ? t('card.tip_stop_dl') : canDownload ? dlTitle : t('card.tip_replace'),
      shift: canDownload && !stopDownload ? t('card.tip_replace') : null,
      disabled: busyImport, cancelling: stopDownload,
    } : null,
    translate: e ? {
      face: busyTranslate ? 'stop' : 'translate',
      tip: busyTranslate ? t('card.tip_cancel') : (e.translated ? translatedTip : t('card.tip_translate')),
      shift: e.translated && !busyTranslate ? t('card.tip_revert') : null,
      done: !!e.translated, cancelling: busyTranslate,
    } : null,
    detach: canDetach,
    remove: { tip: t('card.tip_delete'), shift: t('card.tip_quickdelete') },
  };
}

// What a row's job shows in its place of the details: the bar (its fill, 0–100, or null with no
// figure yet: the bar's motion), done in the colour of success, and the words. As the library card's
// (jobView, 'card'), but an error empties the bar, and an interruption is said in words.
export function chapterJob(job: JobNews, f: Pick<Formats, 't' | 'count' | 'bytes'>): JobView | null {
  if (job.status === 'interrupted') return { pct: 0, done: false, label: f.t('prog.interrupted') };
  const v = jobView(job, { t: f.t, count: f.count, bytes: f.bytes }, 'card');
  if (!v) return null;
  return job.status === 'error' ? { ...v, pct: 0 } : v;
}

// gallery-actions.ts — what a press on a gallery's button asks and says, stated once for every page
// that shows the button (the library's cards, the overview's rows): the questions, through the app's
// dialogs (notice.js's, drawn by the notice host), how a dialog names the gallery, and the intents
// forwarded to whatever runs things (1.3's messages, their fields in 1.3's order). The app decides
// nothing about fetching: a press is forwarded as it is. What a page shows while a press has no answer
// is the page's own (the library's cards and the overview's rows hold their buttons differently).
import * as platform from '@lib/platform.js';
import { t as translate, getLang } from '@lib/i18n.js';
import { formatCount } from '@lib/format.js';
import { pickSeriesTitle, pickTitle } from '@lib/titles.js';
import { alertDialog, choiceDialog, confirmDialog, promptDialog } from '@lib/notice.js';

export type ShownGallery = {
  id: string; isSeries?: boolean; parentId?: unknown; linked?: boolean; source?: string; sourceId?: string | null; sourceUrl?: string;
  count?: number; numPages?: number; chapterCount?: number; chapters?: { id: string }[] | null; translated?: boolean; favorite?: boolean;
  seriesTitle?: unknown; tags?: { type: string; name: string; url?: string }[]; [field: string]: unknown;
};

// notice.js's JSDoc leaves its fields loose; the page asks with these.
export type Ask = { title: string; body?: string; detail?: string | string[]; cover?: string; ok?: string; cancel?: string; danger?: boolean; tone?: string; value?: string; placeholder?: string };
export const confirmNotice = confirmDialog as unknown as (ask: Ask) => Promise<boolean>;
export const alertNotice = alertDialog as unknown as (ask: Ask) => Promise<void>;
export const promptNotice = promptDialog as unknown as (ask: Ask) => Promise<string | null>;
export const choose = choiceDialog as unknown as (ask: Ask & { choices: { value: string; label: string; detail?: string }[]; checks: { name: string; label: string; checked?: boolean }[] }) => Promise<{ value: string; checks: Record<string, boolean> } | null>;
export const t = translate as (key: string, vars?: Record<string, string | number>) => string;
export const rpc = (msg: Record<string, unknown>) => platform.rpc(msg) as Promise<{ ok?: boolean } | null>;

// How a dialog names what it acts on: the title (the gallery's own, or the one the page shows it by: a
// chapter's in its series), then "#id · N pages" / "N chapters".
export const galleryDetail = (g: ShownGallery, title: string = pickTitle(g as never, getLang())) => {
  const id = g.sourceId || g.id;
  return [title || `#${id}`, t('dlg.detail_pages', { id, n: formatCount(g.count || 0) })];
};
export const seriesDetail = (g: ShownGallery) => [
  pickSeriesTitle(g.seriesTitle as never, g as never, getLang()) || `#${g.id}`,
  t('dlg.detail_chapters', { n: formatCount(g.chapterCount || g.chapters?.length || 0) }),
];

// What a question shows of the gallery: its detail lines and its cover ('' for none).
export type About = { detail: string[]; cover: string };

// Whether a gallery has every page its source lists: a download of it can only be "again".
export const isWhole = (g: ShownGallery) => (g.numPages ?? 0) > 0 && (g.count ?? 0) >= (g.numPages ?? 0);

// ── The questions: each resolves whether to go on ──
// A download of a whole gallery.
export const askDownloadAgain = (g: ShownGallery, about: About) => confirmNotice({
  title: t('dlg.redl_title'), body: t('dlg.redl_body', { n: formatCount(g.numPages) }), detail: about.detail, cover: about.cover, ok: t('dlg.redl_ok'),
});
// A translation: none of a gallery with no pages (told so); a first one asked first.
export async function askTranslate(g: ShownGallery, about: About) {
  if (g.count === 0) {
    alertNotice({ title: t('dlg.no_pages_title'), body: t('dlg.no_pages_body'), detail: about.detail[0], cover: about.cover });
    return false;
  }
  return !!g.translated || confirmNotice({
    title: t('dlg.tr_title'), body: t('dlg.tr_body', { n: formatCount(g.count) }), detail: about.detail, cover: about.cover, ok: t('dlg.tr_ok'),
  });
}
// The originals back.
export const askRevert = (about: About) => confirmNotice({
  title: t('dlg.revert_title'), body: t('dlg.revert_body'), detail: about.detail, cover: about.cover, ok: t('dlg.revert_ok'), danger: true,
});
// A translation again from the step `stage` (its name) of the re-run menu.
export const askRerun = (stage: string, about: About) => confirmNotice({
  title: t('dlg.rerun_title', { stage }), body: t('dlg.rerun_body'), detail: about.detail, cover: about.cover, ok: t('dlg.rerun_ok'),
});
// A gallery deleted; a linked one (its files Shiori didn't make) leaves the library, its files kept.
export const askDelete = (g: ShownGallery, about: About) => confirmNotice(g.linked
  ? { title: t('dlg.del_linked_title'), body: t('dlg.del_linked_body'), detail: about.detail, cover: about.cover, ok: t('dlg.del_linked_ok'), danger: true }
  : { title: t('dlg.del_gallery_title'), body: t('dlg.del_gallery_body'), detail: about.detail, cover: about.cover, ok: t('dlg.delete'), danger: true });
// A tag taken off (`kind`: its kind's name; `title`: the gallery's).
export const askRemoveTag = (kind: string, name: string, title: string, cover: string) => confirmNotice({
  title: t('dlg.tag_title'), body: t('dlg.tag_body'), detail: [`${kind} · ${name}`, title], cover, ok: t('dlg.tag_ok'), danger: true,
});

// ── The intents ──
export const intent = {
  download: (g: ShownGallery, overwrite: boolean) => rpc({ type: 'CACHE_ALL_PAGES', galleryId: g.id, source: g.source, overwrite }),
  stopDownload: (gid: string) => rpc({ type: 'STOP_JOB', galleryId: gid, kind: 'download' }),
  translate: (gid: string, forceFrom?: string) => rpc({ type: 'TRANSLATE_GALLERY', galleryId: gid, ...(forceFrom ? { forceFrom } : {}) }),
  cancelTranslate: (gid: string) => rpc({ type: 'CANCEL_TRANSLATE', galleryId: gid }),
  revert: (gid: string) => rpc({ type: 'REVERT_GALLERY', galleryId: gid }),
};

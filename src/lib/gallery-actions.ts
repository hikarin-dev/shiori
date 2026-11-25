// gallery-actions.ts — what a press on a gallery's button asks and says, stated once for every page
// that shows the button (the library's cards, the overview's rows): the questions, through the app's
// dialogs (notice.js's, drawn by the notice host), and how a dialog names the gallery.
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

// How a dialog names what it acts on: the title, then "#id · N pages" / "N chapters".
export const galleryDetail = (g: ShownGallery) => {
  const id = g.sourceId || g.id;
  return [pickTitle(g as never, getLang()) || `#${id}`, t('dlg.detail_pages', { id, n: formatCount(g.count || 0) })];
};
export const seriesDetail = (g: ShownGallery) => [
  pickSeriesTitle(g.seriesTitle as never, g as never, getLang()) || `#${g.id}`,
  t('dlg.detail_chapters', { n: formatCount(g.chapterCount || g.chapters?.length || 0) }),
];

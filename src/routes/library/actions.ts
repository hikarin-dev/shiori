// What a library card's buttons do (1.3's buildCard handlers, the grid's click handler, the export and
// replace helpers of app/js/library.js), as the page's handlers: each asks 1.3's questions through the
// app's dialogs (notice.js's, drawn by the notice host) and says to the library and to whatever runs
// things what 1.3's page said, the same messages with the same fields in the same order. The app
// forwards the person's press as a generic intent and decides nothing about fetching.
//
// A handler is given the card's gallery id; the gallery is the one the page shows now (its entry in
// the query cache), as 1.3's handlers read card._g. A series owner shown merged acts as its series.
//
// A card dragged onto another (src/lib/card-drag.ts) asks here whether to make them a series
// (mergeDrop: 1.3's handleMergeDrop).
//
// Where 1.3 said one rule twice, it is said once here: the delete question in its four wordings and
// the delete itself (deleteGallery), a translation started and its button held (startTranslation:
// the button, a series' chapter and the re-run menu's choice).
import type { QueryClient } from '@tanstack/react-query';
import * as api from '@lib/api.js';
import * as platform from '@lib/platform.js';
import * as store from '@lib/store.js';
import { t as translate, getLang } from '@lib/i18n.js';
import { formatCount } from '@lib/format.js';
import { pickSeriesTitle, pickTitle, migrateTitle } from '@lib/titles.js';
import { safeExternalUrl } from '@lib/sanitize.js';
import { galleryLink, helperAvailable } from '@lib/sites.js';
import { request as helperRequest } from '@lib/ext-bridge.js';
import { alertDialog, choiceDialog, confirmDialog, promptDialog } from '@lib/notice.js';
import { LANG_NAME_TO_CODE } from '@lib/gallery-model.js';
import { TAG_TYPE_LABEL, langDisplayName, tagPatchFor } from '@lib/tag-editor.js';
// What a press needs beyond what the page reads is loaded at the press (the page draws none of it).
const zipping = () => import('@lib/zip.js');
import type { CardHandlers, CardTagRef } from '@/components/gallery-card';
import { editGallery } from '@/lib/library-query';
import type { LibraryJobs } from '@/lib/library-jobs';
import { PAGES, TOTALS } from './data';

type Tag = { type: string; name: string; url?: string };
export type ShownGallery = {
  id: string; isSeries?: boolean; parentId?: unknown; linked?: boolean; source?: string; sourceId?: string | null; sourceUrl?: string;
  count?: number; numPages?: number; chapterCount?: number; chapters?: { id: string }[] | null; translated?: boolean; favorite?: boolean;
  seriesTitle?: unknown; tags?: Tag[]; [field: string]: unknown;
};

// notice.js's JSDoc leaves its fields loose; the page asks with these.
type Ask = { title: string; body?: string; detail?: string | string[]; cover?: string; ok?: string; cancel?: string; danger?: boolean; tone?: string; value?: string; placeholder?: string };
const confirmNotice = confirmDialog as unknown as (ask: Ask) => Promise<boolean>;
const alertNotice = alertDialog as unknown as (ask: Ask) => Promise<void>;
const promptNotice = promptDialog as unknown as (ask: Ask) => Promise<string | null>;
const choose = choiceDialog as unknown as (ask: Ask & { choices: { value: string; label: string; detail?: string }[]; checks: { name: string; label: string; checked?: boolean }[] }) => Promise<{ value: string; checks: Record<string, boolean> } | null>;
const t = translate as (key: string, vars?: Record<string, string | number>) => string;
const rpc = (msg: Record<string, unknown>) => platform.rpc(msg) as Promise<{ ok?: boolean } | null>;

// How a dialog names what it acts on: the title, then "#id · N pages" / "N chapters".
export const galleryDetail = (g: ShownGallery) => {
  const id = g.sourceId || g.id;
  return [pickTitle(g as never, getLang()) || `#${id}`, t('dlg.detail_pages', { id, n: formatCount(g.count || 0) })];
};
export const seriesDetail = (g: ShownGallery) => [
  pickSeriesTitle(g.seriesTitle as never, g as never, getLang()) || `#${g.id}`,
  t('dlg.detail_chapters', { n: formatCount(g.chapterCount || g.chapters?.length || 0) }),
];

// A link or a host typed into the source prompt, as 1.3 parsed it: the helper's reading when it is
// there, otherwise the host and the address as given.
async function parseSourceInput(input: string) {
  if (helperAvailable()) {
    const r = await helperRequest({ type: 'EXT_PARSE_URL', input }) as { ok?: boolean; source?: string; sourceId?: string; sourceUrl?: string } | null;
    if (r && r.ok) return { source: r.source || '', sourceId: r.sourceId || null, sourceUrl: r.sourceUrl || '' };
  }
  const s = String(input || '').trim();
  try {
    const u = new URL(s.includes('://') ? s : 'https://' + s);
    return { source: u.hostname.replace(/^www\./, ''), sourceId: null, sourceUrl: u.href };
  } catch {
    return { source: s.toLowerCase().replace(/^www\./, '').split('/')[0], sourceId: null, sourceUrl: '' };
  }
}
const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(s);

// ── Export (1.3's "Per-gallery ZIP export") ──
const zipCreate = async (files: unknown) => (await zipping()).zipCreate(files as never);
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Every record's metadata (a series: each chapter's in its folder, and the series' manifest).
async function exportMetadataBundle(galleryId: string) {
  const gid = String(galleryId);
  const enc = new TextEncoder();
  const getMeta = (id: unknown) => api.meta.get(String(id)) as Promise<Record<string, unknown> | null>;
  const cleanMeta = (raw: unknown, { stripSeriesFields = false } = {}) => {
    const { pageExts: _p, ...base } = migrateTitle((raw || {}) as never) as Record<string, unknown>;
    if (!stripSeriesFields) return base;
    const { chapters: _c, parentId: _pa, seriesTitle: _s, seriesTags: _st, ...plain } = base;
    return plain;
  };
  const meta = await getMeta(gid);
  const chapters = Array.isArray(meta?.chapters) && meta.chapters.length > 1 ? meta.chapters : null;
  if (!chapters) {
    saveBlob(new Blob([await zipCreate([{ name: 'metadata.json', data: enc.encode(JSON.stringify(cleanMeta(meta), null, 2)) }])], { type: 'application/zip' }), `shiori-${gid}-metadata.zip`);
    return;
  }
  const files = [];
  const { seriesManifest } = await import('@lib/storage/gallery-files.js');
  const manifest = seriesManifest(meta as never, { metadataOnly: true }) as { chapters: { id: string; folder: string }[] };
  for (const { id, folder } of manifest.chapters) {
    files.push({ name: `${folder}/metadata.json`, data: enc.encode(JSON.stringify(cleanMeta(await getMeta(id), { stripSeriesFields: true }), null, 2)) });
  }
  files.push({ name: 'series.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });
  saveBlob(new Blob([await zipCreate(files)], { type: 'application/zip' }), `shiori-series-${gid}-metadata.zip`);
}

// How to export (Settings → Library): asked each time unless a format is set there; the question can
// set it ("remember my choice"). Null when cancelled.
async function exportFormat(gid: string, meta: unknown) {
  const kv = await platform.kv.get(['libExportFormat', 'libExportTranslations', 'libExportCbzTranslations']) as Record<string, unknown>;
  const translations = (kv.libExportTranslations ?? kv.libExportCbzTranslations) !== false;
  if (kv.libExportFormat === 'zip' || kv.libExportFormat === 'cbz') return { format: kv.libExportFormat, translations };
  const answer = await choose({
    title: t('dlg.export_title'),
    detail: [pickTitle((meta || {}) as never, getLang()) || `#${gid}`],
    choices: [
      { value: 'zip', label: t('set.lib_export_zip'), detail: t('dlg.export_zip_desc') },
      { value: 'cbz', label: t('set.lib_export_cbz'), detail: t('dlg.export_cbz_desc') },
    ],
    checks: [
      { name: 'translations', label: t('set.lib_export_tr'), checked: translations },
      { name: 'remember', label: t('dlg.export_remember'), checked: false },
    ],
    ok: t('dlg.export_ok'),
  });
  if (!answer) return null;
  const choice = { format: answer.value, translations: answer.checks.translations };
  if (answer.checks.remember) platform.kv.set({ libExportFormat: choice.format, libExportTranslations: choice.translations });
  return choice;
}

// A gallery (a series owner: its whole series) in the app's gallery format, as a ZIP or a CBZ named
// after its title.
async function exportGallery(galleryId: string) {
  const gid = String(galleryId);
  const meta = await api.meta.get(gid);
  const how = await exportFormat(gid, meta);
  if (!how) return;
  const { exportFiles } = await import('@lib/gallery-export.js');
  const { name, files } = await exportFiles(gid, { read: api.transfer.read, metaGet: api.meta.get, translations: how.translations, comicInfo: how.format === 'cbz' }) as { name: string; files: never[] };
  saveBlob(new Blob([await zipCreate(files)], { type: how.format === 'cbz' ? 'application/vnd.comicbook+zip' : 'application/zip' }), `${name}.${how.format}`);
}

export type ActionDeps = {
  client: QueryClient;
  jobs: LibraryJobs;
  gallery: (id: string) => ShownGallery | undefined;   // as the page shows it now
  merged: () => boolean;                                // series shown merged
  cover: (id: string) => string;                        // the cover its card shows ('' for none)
  canDownload: (g: ShownGallery) => boolean;
  pickFile: (id: string) => void;                       // Replace: the file input, for this gallery
  rerunMenu: (id: string, anchor: HTMLElement) => void; // "Re-run from…" under its button
  seriesTranslate: (g: ShownGallery) => void;           // a series' window: one chapter at a time
  tagEditor: (id: string) => void;
  reread: () => Promise<unknown>;                       // the page and its totals read again
};

export function cardActions(deps: ActionDeps): Omit<CardHandlers, 'tag' | 'flag' | 'searchFavorite' | 'searchTranslated' | 'searchSource' | 'jobSettled'> & {
  startTranslation(g: ShownGallery, forceFrom?: string): Promise<void>;
  replaceImages(gid: string, files: FileList | File[]): Promise<void>;
  mergeDrop(targetId: string, sourceId: string): Promise<void>;
  reread: () => Promise<unknown>;
} {
  const { client, jobs } = deps;
  const series = (g: ShownGallery) => deps.merged() && !!g.isSeries;
  const reread = () => {
    client.invalidateQueries({ queryKey: PAGES }).catch(() => {});
    client.invalidateQueries({ queryKey: TOTALS }).catch(() => {});
  };
  const shown = (id: string, fn: (g: ShownGallery) => unknown) => {
    const g = deps.gallery(id);
    if (g) Promise.resolve(fn(g)).catch((err) => console.error(err));
  };

  // A translation asked for: its button held, "Translating…", until its job's first word.
  async function startTranslation(g: ShownGallery, forceFrom?: string) {
    jobs.press(g.id, 'translate');
    try { await rpc({ type: 'TRANSLATE_GALLERY', galleryId: g.id, ...(forceFrom ? { forceFrom } : {}) }); } catch (err) { jobs.release(g.id); throw err; }
  }

  // A gallery deleted, a series shown merged with every chapter: asked first (unless `quick`), in one of
  // four wordings (a gallery, a series; a linked one of each, which leaves the library with its files
  // kept). In the unmerged view a card may still belong to a series (its owner shown plainly, or a
  // chapter): removed through the series, which re-owns or detaches the rest. One whose folder can't be
  // changed now is refused, and said so.
  async function deleteGallery(g: ShownGallery, quick: boolean) {
    const whole = series(g);
    const n = formatCount(g.chapterCount);
    if (!quick && !(await confirmNotice(g.linked
      ? { title: t('dlg.del_linked_title'), body: t('dlg.del_linked_body'), detail: whole ? seriesDetail(g) : galleryDetail(g), cover: deps.cover(g.id), ok: t('dlg.del_linked_ok'), danger: true }
      : whole
        ? { title: t('dlg.del_series_title'), body: t('dlg.del_series_body', { n }), detail: seriesDetail(g), cover: deps.cover(g.id), ok: t('dlg.del_series_ok', { n }), danger: true }
        : { title: t('dlg.del_gallery_title'), body: t('dlg.del_gallery_body'), detail: galleryDetail(g), cover: deps.cover(g.id), ok: t('dlg.delete'), danger: true }))) return;
    try {
      if (whole) await rpc({ type: 'DELETE_SERIES', galleryId: g.id });
      else if (g.isSeries || g.parentId) await (await import('@lib/series.js')).removeChapter(String(g.parentId || g.id), g.id, { deleteImages: true });
      else await rpc({ type: 'DELETE_GALLERY', galleryId: g.id });
    } catch (err) { if (await (await import('@lib/library-folders.js')).deleteRefused(err)) return; throw err; }
    reread();
  }

  // A tag (or a language flag's tags) taken off the gallery, after its question.
  async function removeTags(g: ShownGallery, gone: (tag: Tag) => boolean, label: string, name: string) {
    if (!Array.isArray(g.tags)) return;
    if (!(await confirmNotice({
      title: t('dlg.tag_title'), body: t('dlg.tag_body'),
      detail: [`${label} · ${name}`, galleryDetail(g)[0]], cover: deps.cover(g.id), ok: t('dlg.tag_ok'), danger: true,
    }))) return;
    await store.mutate(g.id, tagPatchFor(g, g.tags.filter((tag) => !gone(tag))));
  }

  // Replace: the gallery's pages from a file the person picked (the desktop app's runner takes it
  // when there is one; it reports on the jobs channel).
  async function replaceImages(gid: string, picked: FileList | File[]) {
    const [{ groupImports, importBytes }, { startImport }, { handImport }] = await Promise.all([import('@lib/import-files.js'), import('@lib/jobs-runner.js'), import('@lib/submit-job.js')]);
    const [group] = groupImports([...picked]) as { name: string }[];
    if (!group || !gid) return;
    jobs.press(gid, 'download', t('prog.reading_file'));
    if (await handImport({ galleryId: gid, group, skipExisting: false })) return;
    let buffer;
    const rendering = ((p: Record<string, number>) => jobs.press(gid, 'download', t('prog.rendering', p))) as () => void;
    try { buffer = await importBytes(group as never, rendering); }
    catch { jobs.note(gid, t('prog.err_read')); return; }
    jobs.press(gid, 'download', t('prog.importing_file'));
    if (!await startImport({ galleryId: gid, buffer, filename: group.name, skipExisting: false })) jobs.note(gid, t('prog.err_stage'));
  }

  // A card dropped on another: asked first, then made the target's next chapter (the target keeps its
  // id); a refusal told (a library folder's in its own words), else the page and its totals read again.
  // Each is named by its title as the page shows it.
  async function mergeDrop(targetId: string, sourceId: string) {
    const name = (id: string) => { const g = deps.gallery(id); return (g && pickTitle(g as never, getLang())) || `#${id}`; };
    if (!(await confirmNotice({
      title: t('dlg.merge_title'), body: t('dlg.merge_body'), detail: [name(sourceId), t('dlg.merge_into', { title: name(targetId) })], ok: t('dlg.merge_ok'),
    }))) return;
    try {
      await (await import('@lib/series.js')).mergeIntoSeries(targetId, sourceId);
    } catch (err) {
      const refusal = (await import('@lib/library-folders.js')).refusalText(err) as string | null | undefined;
      alertNotice({ title: t('dlg.merge_fail_title'), body: t('dlg.merge_fail_body'), detail: refusal ?? (err as Error).message, tone: 'error' });
      return;
    }
    await deps.reread();
  }

  return {
    startTranslation,
    replaceImages,
    mergeDrop,
    reread: deps.reread,

    favorite: (id) => shown(id, (g) => editGallery(client, g.id, { favorite: !g.favorite }, () => api.personal.favorite(g.id, !g.favorite))),

    openSource: (id) => shown(id, (g) => {
      const safe = safeExternalUrl(galleryLink(g as never, 1));
      if (safe) window.open(safe, '_blank', 'noopener');
    }),

    // The source prompt: with no link, the clipboard's link is taken without asking; Shift edits the
    // link there is. A series shown merged may give every chapter the link.
    editSource: (id, shift) => shown(id, async (g) => {
      const visit = galleryLink(g as never, 1) as string;
      let prefill = visit || '';
      if (!prefill) {
        try {
          const clip = (await navigator.clipboard.readText()).trim();
          if (looksLikeUrl(clip)) prefill = clip;
        } catch {}
      }
      const autoApply = !shift && !visit && prefill && looksLikeUrl(prefill);
      const input = autoApply ? prefill : await promptNotice({
        title: t(visit ? 'dlg.src_edit_title' : 'dlg.src_title'), body: t('dlg.src_body'),
        detail: series(g) ? seriesDetail(g)[0] : galleryDetail(g)[0], cover: deps.cover(g.id),
        value: prefill, placeholder: t('dlg.src_ph'), ok: t('common.save'),
      });
      if (input === null) return;
      const parsed = await parseSourceInput(input);
      const n = formatCount(g.chapters?.length || g.chapterCount || 0);
      const applyToChapters = series(g) && await confirmNotice({
        title: t('dlg.src_all_title'), body: t('dlg.src_all_body', { n }), ok: t('dlg.src_all_ok', { n }), cancel: t('dlg.src_all_one'),
      });
      const fields = { ...(parsed.sourceId ? { sourceId: parsed.sourceId } : {}), ...(parsed.sourceUrl ? { sourceUrl: parsed.sourceUrl } : {}) };
      await editGallery(client, g.id, { source: parsed.source, ...fields }, async () => (await rpc({
        type: 'SET_SOURCE', galleryId: g.id, source: parsed.source, ...fields, ...(applyToChapters ? { applyToChapters: true } : {}),
      }))?.ok === true);
    }),

    // Download: a series shown merged forwards one intent for the whole series (what to fetch is the
    // runner's to work out); asked first only when nothing is missing, which can only mean "again".
    download: (id) => shown(id, async (g) => {
      if (series(g)) {
        const known = ((await api.galleries.byIds((g.chapters || []).map((c) => c.id))) as ShownGallery[]).filter(Boolean);
        if (!known.length || !known.some((x) => deps.canDownload(x))) return;
        const nothingMissing = known.every((x) => (x.numPages ?? 0) > 0 && (x.count ?? 0) >= (x.numPages ?? 0));
        if (nothingMissing && !(await confirmNotice({
          title: t('dlg.redl_series_title'), body: t('dlg.redl_series_body'), detail: seriesDetail(g), cover: deps.cover(g.id), ok: t('dlg.redl_ok'),
        }))) return;
        await rpc({ type: 'CACHE_ALL_PAGES', galleryId: g.id, source: g.source, series: true, overwrite: nothingMissing });
        return;
      }
      if (jobs.get(g.id).pending) return;
      const alreadyComplete = (g.numPages ?? 0) > 0 && (g.count ?? 0) >= (g.numPages ?? 0);
      if (alreadyComplete && !(await confirmNotice({
        title: t('dlg.redl_title'), body: t('dlg.redl_body', { n: formatCount(g.numPages) }), detail: galleryDetail(g), cover: deps.cover(g.id), ok: t('dlg.redl_ok'),
      }))) return;
      jobs.press(g.id, 'download');
      try { await rpc({ type: 'CACHE_ALL_PAGES', galleryId: g.id, source: g.source, overwrite: alreadyComplete }); } catch (err) { jobs.release(g.id); throw err; }
    }),
    stopDownload: (id) => shown(id, (g) => rpc({ type: 'STOP_JOB', galleryId: g.id, kind: 'download' })),
    replace: (id) => deps.pickFile(id),

    // Translate: a series shown merged opens its window (one chapter a press); no pages: told so; a
    // first translation asks first.
    translate: (id) => shown(id, async (g) => {
      if (series(g)) { deps.seriesTranslate(g); return; }
      if (jobs.get(g.id).pending) return;
      if (g.count === 0) {
        alertNotice({ title: t('dlg.no_pages_title'), body: t('dlg.no_pages_body'), detail: galleryDetail(g)[0], cover: deps.cover(g.id) });
        return;
      }
      if (!g.translated && !(await confirmNotice({
        title: t('dlg.tr_title'), body: t('dlg.tr_body', { n: formatCount(g.count) }), detail: galleryDetail(g), cover: deps.cover(g.id), ok: t('dlg.tr_ok'),
      }))) return;
      await startTranslation(g);
    }),
    cancelTranslate: (id) => shown(id, (g) => rpc({ type: 'CANCEL_TRANSLATE', galleryId: g.id })),
    // Revert with Shift: the originals back, after its question; drawn untranslated once done.
    revert: (id) => shown(id, async (g) => {
      if (jobs.get(g.id).pending) return;
      if (!(await confirmNotice({
        title: t('dlg.revert_title'), body: t('dlg.revert_body'), detail: galleryDetail(g), cover: deps.cover(g.id), ok: t('dlg.revert_ok'), danger: true,
      }))) return;
      jobs.press(g.id, 'revert');
      try {
        await rpc({ type: 'REVERT_GALLERY', galleryId: g.id });
        await editGallery(client, g.id, { translated: false }, async () => true);
      } finally { jobs.release(g.id); }
    }),
    rerun: (id, anchor) => deps.rerunMenu(id, anchor),

    // Export, or with Shift the metadata alone; its button "…" meanwhile, a failure told.
    export: (id) => shown(id, (g) => exporting(g.id, () => exportGallery(g.id))),
    exportMetadata: (id) => shown(id, (g) => exporting(g.id, () => exportMetadataBundle(g.id))),

    remove: (id) => shown(id, (g) => deleteGallery(g, false)),
    quickRemove: (id) => shown(id, (g) => deleteGallery(g, true)),

    removeTag: (id: string, tag: CardTagRef) => shown(id, (g) => {
      const name = String(tag.name).trim();
      return removeTags(g, (tg) => tg.type === tag.type && tg.name === name, t((TAG_TYPE_LABEL as Record<string, string>)[tag.type] || 'addtag.cat_tag'), name);
    }),
    // A language flag: its language's tags (none when the flag came from elsewhere: nothing asked).
    removeFlag: (id: string, code: string) => shown(id, (g) => {
      if (!Array.isArray(g.tags)) return;
      const gone = g.tags.filter((tg) => tg.type === 'language' && (LANG_NAME_TO_CODE as Record<string, string>)[String(tg.name).toLowerCase()] === code);
      if (!gone.length) return;
      return removeTags(g, (tg) => gone.includes(tg), t('addtag.cat_language'), langDisplayName(code) || code);
    }),
    addTag: (id) => deps.tagEditor(id),
  };

  async function exporting(gid: string, run: () => Promise<void>) {
    if (jobs.get(gid).exporting) return;
    jobs.exporting(gid, true);
    try { await run(); } catch (err) {
      alertNotice({ title: t('dlg.export_fail_title'), body: t('dlg.export_fail_body'), detail: (err as Error).message, tone: 'error' });
    } finally { jobs.exporting(gid, false); }
  }
}

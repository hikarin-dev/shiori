// actions.ts — what the overview's buttons do (1.3's app/js/overview.js: toggleFavorite, the Archive
// now and Move handlers of buildShell, setEditMode's saves (saveOwnerTitleInput, saveChapterTitleInput),
// editTag and removeTagConfirmed, move and saveShownOrder, downloadOrReplaceChapter and its file input
// (ensureReplaceInput, stageImport), translateChapter, rerunChapter, deleteChapter, detachChapter,
// doRemove): each asks 1.3's questions through the app's dialogs and says to the library and to
// whatever runs things what 1.3's page said, the same messages with the same fields in the same order.
// The app forwards the person's press as a generic intent and decides nothing about fetching.
//
// The questions and the intents a library card shares are src/lib/gallery-actions.ts's. Where the
// overview differs from the library, it keeps 1.3's overview's own ways: a dialog names a chapter by the
// title its row shows; a press begins its row's job at once, as a word with 1.3's words (the store's
// begin), and a press that is refused or not taken discards it (1.3's discardChapterJob), where a card
// holds its button until its job's first word (F53); a revert holds the row's translate button until
// it is answered, then the row is read again; Replace tells a file it cannot read in a dialog.
//
// An edit the page makes is drawn before the library answers and put back if refused: the heart and a
// gallery's own title on its entry (editGallery), the series' title, a chapter's title and the order
// on the page's frame (editFrame). Nothing else is patched: a removal, an archive, a move or a tag
// reaches the page through the library's change feed or the frame read again.
import type { QueryClient } from '@tanstack/react-query';
import * as api from '@lib/api.js';
import { getLang } from '@lib/i18n.js';
import { editKeyForLang, normalizeTitle, seriesTitleObject } from '@lib/titles.js';
import { memberKind } from '@lib/gallery-model.js';
import { removeChapter, reorderChapters, setChapterTitle, setGalleryTitle, setSeriesTitle } from '@lib/series.js';
import { TAG_TYPE_LABEL, removeTag } from '@lib/tag-editor.js';
import { alertNotice, askDelete, askDownloadAgain, askRemoveTag, askRerun, askRevert, askTranslate, galleryDetail, intent, isWhole, t, type About } from '@/lib/gallery-actions';
import { editGallery, readAgain } from '@/lib/library-query';
import { editFrame, overviewKey, type Entity, type Frame, type Ref } from './data';
import { isEnded, type ChapterJobs } from './jobs';

type Found = Extract<Frame, { found: true }>;
export type TagRef = { type: string; name: string };

export type OverviewDeps = {
  client: QueryClient;
  jobs: ChapterJobs;
  key: () => string;                              // the address's gallery: the frame's key
  frame: () => Found | null;                      // the frame as the page shows it now
  ownerId: () => string | null;                   // the series' owner, as the page knows it now
  setOwner: (id: string) => void;                 // the owner the frame is read from from now on
  kind: () => 'chapter' | 'volume';               // which members the list shows
  entity: (id: string) => Entity | null;          // a member's gallery, as the page shows it
  cover: (id: string) => string;                  // its row's cover ('' for none)
  heroCover: () => string;                        // the hero's cover, as shown
  heading: () => string;                          // the hero's title
  canDownload: (e: Entity) => boolean;
  pickFile: (gid: string) => void;                // Replace: the file input, for this chapter
  rerunMenu: (gid: string, anchor: HTMLElement) => void;
  tagEditor: (tag: TagRef | null) => void;        // the tag editor on the owner: a tag edited, or one added
  home: () => void;                               // the library (the page's gallery is gone)
};

// A press refused, or a start not taken (1.3's test of every answer to a press that begins a job).
const notTaken = (resp: { ok?: boolean; started?: boolean } | null) => !resp || resp.ok === false || resp.started === false;
const answer = <T,>(sent: Promise<T>) => sent.catch(() => null);
const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => String(id) === String(b[i]));

// The frame with the members of `kind` in the order `shown` (the other kind keeps its places).
export function withShownOrder(frame: Found, kind: string, shown: string[]): Found {
  const slots = frame.refs.filter((r) => memberKind(r) === kind);
  const byId = new Map(slots.map((r) => [r.id, r]));
  if (slots.length !== shown.length || !shown.every((id) => byId.has(id))) return frame;
  let k = 0;
  return { ...frame, refs: frame.refs.map((r) => (memberKind(r) === kind ? byId.get(shown[k++])! : r)) };
}

export function overviewActions(deps: OverviewDeps) {
  const { client, jobs } = deps;
  // How a dialog names a chapter: the title its row shows, then "#id · N pages"; its row's cover.
  const about = (ch: Ref, e: Entity | null, label: string): About => ({ detail: galleryDetail(e ?? { id: ch.id }, label), cover: deps.cover(ch.id) });
  const running = (gid: string, kind: string) => { const job = jobs.get(gid); return !!job && !isEnded(job) && job.kind === kind; };
  const failed = (err: unknown) => console.error(err);

  // ── The order ── Saves run one after another, each reading the list as the page shows it by then;
  // the places the shown kind holds in the series' order take its rows in turn.
  let orderSave: Promise<unknown> = Promise.resolve();
  const saveShownOrder = () => (orderSave = orderSave.then(async () => {
    const frame = deps.frame(), owner = deps.ownerId();
    if (!frame || !owner) return;
    const kind = deps.kind();
    const refs = ((await api.meta.get(owner)) as { chapters?: Ref[] } | null)?.chapters || [];
    const order = refs.map((c) => String(c.id));
    const shown = frame.refs.filter((r) => memberKind(r) === kind).map((r) => r.id);
    const slots = order.filter((_, i) => memberKind(refs[i]) === kind);
    const shownSet = new Set(shown);
    if (shown.length !== slots.length || !slots.every((id) => shownSet.has(id))) return;   // the list is stale: its read redoes it
    let k = 0;
    const next = refs.map((c, i) => (memberKind(c) === kind ? shown[k++] : order[i]));
    if (sameOrder(next, order)) return;
    await reorderChapters(owner, next);
    deps.setOwner(next[0]);   // the head may have changed: ownership moved
    // (A save the library refuses is told to no one, as 1.3's: the order drawn is dropped, and the page
    // shows the series as the library has it.)
  }).catch(() => false));
  // The shown kind's rows in the order `shown`, drawn at once (the frame), then saved.
  const place = (shown: string[]) => {
    const kind = deps.kind();
    editFrame(client, deps.key(), (f) => withShownOrder(f, kind, shown), saveShownOrder).catch(failed);
  };

  // A chapter removed from the series (its gallery deleted, or kept as a gallery of its own): a refusal
  // told; the page then shows what the series is now (its owner moved on when the owner went), or the
  // library when nothing of it is left.
  async function remove(ch: Ref, deleteImages: boolean) {
    const prevOwner = deps.ownerId();
    if (!prevOwner) return;
    const remaining = (((await api.meta.get(prevOwner)) as { chapters?: Ref[] } | null)?.chapters || []).map((c) => String(c.id)).filter((id) => id !== String(ch.id));
    let removed: unknown;
    try {
      removed = await removeChapter(prevOwner, ch.id, { deleteImages });
    } catch (err) {
      if (await (await import('@lib/library-folders.js')).deleteRefused(err)) return;
      throw err;
    }
    if (removed === false) return;
    let owner = String(ch.id) === String(prevOwner) ? (remaining[0] || prevOwner) : prevOwner;
    const series = await api.series.resolve(owner) as { ownerId: string } | null;
    if (series) owner = String(series.ownerId);
    else if (!(await api.galleries.get(owner))) { deps.home(); return; }
    deps.setOwner(owner);
    client.invalidateQueries({ queryKey: overviewKey(deps.key()) }).catch(() => {});
  }

  // A chapter's translation started: its row's job begun, discarded when the press is not taken.
  async function translateFrom(gid: string, forceFrom?: string) {
    jobs.begin(gid, 'translate', t('prog.translating'));
    if (notTaken(await answer(intent.translate(gid, forceFrom)))) jobs.discard(gid);
  }

  // The re-run menu's chapter while it is open (the menu names the gallery alone).
  let rerunning: { ch: Ref; e: Entity; label: string } | null = null;

  return {
    // ── The hero ──
    // Favouriting is the person's own mark, not an update to the gallery.
    favorite() {
      const owner = deps.ownerId();
      const e = owner ? deps.entity(owner) : null;
      if (!owner || !e) return;
      const favorite = !e.favorite;
      editGallery(client, owner, { favorite }, () => api.personal.favorite(owner, favorite)).catch(failed);
    },

    // The owner's title in the app's language (the other languages kept): a series' own title, or a
    // standalone gallery's. Empty: none in this language (the page then shows the one it falls back to).
    saveOwnerTitle(isSeries: boolean, text: string) {
      const owner = deps.ownerId();
      if (!owner) return;
      const lang = getLang(), field = editKeyForLang(lang);
      if (isSeries) {
        editFrame(client, deps.key(), (f) => ({ ...f, seriesTitle: { ...(seriesTitleObject(f.seriesTitle as never) || { english: '', japanese: '', pretty: '' }), [field]: text } }),
          () => setSeriesTitle(owner, lang, text)).catch(failed);
      } else {
        editGallery(client, owner, { title: { ...normalizeTitle(deps.entity(owner) as never), [field]: text } }, () => setGalleryTitle(owner, lang, text)).catch(failed);
      }
    },
    // A chapter's own title in its series (empty: none, its gallery's shows).
    saveChapterTitle(chapterId: string, text: string) {
      const owner = deps.ownerId();
      if (!owner) return;
      editFrame(client, deps.key(), (f) => ({ ...f, refs: f.refs.map((r) => (r.id === chapterId ? { ...r, title: text } : r)) }),
        () => setChapterTitle(owner, chapterId, text)).catch(failed);
    },

    // A library that keeps galleries as files packs this one (a series: every member) into an archive
    // now; what it had to keep as it was is told. Its button off until then.
    async archive() {
      const owner = deps.ownerId();
      if (!owner) return;
      try {
        const { kept } = await api.galleries.archive(owner) as { kept: unknown[] };
        if (kept.length) alertNotice({ title: t('ov.archive_kept_title'), body: t('ov.archive_kept') });
      } catch (err) {
        alertNotice({ title: t('ov.archive_kept_title'), body: String((err as Error)?.message || err), tone: 'error' });
      }
      client.invalidateQueries({ queryKey: overviewKey(deps.key()) }).catch(() => {});
    },
    // Another of the library's places (a series: every member), asked in the library folders' own window.
    async moveTo() {
      const owner = deps.ownerId();
      if (!owner) return;
      const current = (await api.galleries.get(owner) as { folder?: string } | null)?.folder;
      await (await import('@lib/library-folders.js')).moveGalleryTo(owner, current);
      client.invalidateQueries({ queryKey: overviewKey(deps.key()) }).catch(() => {});
    },

    // In edit mode a tag (or the category or rating among the details) opens the tag editor on it, and
    // with Shift is taken off after its question; "+" adds one.
    tag(tag: TagRef, shift: boolean) {
      if (!shift) { deps.tagEditor(tag); return; }
      const owner = deps.ownerId();
      if (!owner) return;
      const kind = t((TAG_TYPE_LABEL as Record<string, string>)[tag.type] || 'addtag.cat_tag');
      (async () => {
        if (!(await askRemoveTag(kind, tag.name, deps.heading(), deps.heroCover()))) return;
        await removeTag(owner, tag);
      })().catch(failed);
    },
    addTag: () => deps.tagEditor(null),

    // ── A row ──
    // A row a place up or down: drawn there at once (the rows sliding), then saved.
    step(chapterId: string, delta: number) {
      const frame = deps.frame();
      if (!frame) return;
      const kind = deps.kind();
      const shown = frame.refs.filter((r) => memberKind(r) === kind).map((r) => r.id);
      const at = shown.indexOf(chapterId), to = at + delta;
      if (at < 0 || to < 0 || to >= shown.length) return;
      [shown[at], shown[to]] = [shown[to], shown[at]];
      place(shown);
    },
    // The rows shown in the order the grip's drop left them: drawn so at once, then saved. Answers
    // whether the page draws that order (not when the list it was dragged in is no longer the series'
    // members of that kind: the library changed meanwhile, and the series is shown as it is).
    drop(shown: string[]) {
      const key = overviewKey(deps.key()), before = client.getQueryData(key);
      place(shown);
      return client.getQueryData(key) !== before;
    },

    // Download (its Stop while its download runs; nothing while an import runs); with Shift, or where no
    // download is possible, Replace: the pages from a file.
    async download(ch: Ref, e: Entity | null, label: string, shift: boolean) {
      if (!e) return;
      if (running(ch.id, 'download')) { await intent.stopDownload(ch.id); return; }
      if (running(ch.id, 'upload')) return;
      if (shift || !deps.canDownload(e)) { deps.pickFile(ch.id); return; }
      const whole = isWhole(e);
      if (whole && !(await askDownloadAgain(e, about(ch, e, label)))) return;
      jobs.begin(ch.id, 'download', t('prog.fetching_meta'));
      if (notTaken(await answer(intent.download(e, whole)))) jobs.discard(ch.id);
    },

    // Translate (its Stop while it runs); with Shift, once translated, the originals back.
    async translate(ch: Ref, e: Entity | null, label: string, shift: boolean) {
      if (!e) return;
      if (running(ch.id, 'translate')) { await intent.cancelTranslate(ch.id); return; }
      if (jobs.held(ch.id)) return;
      if (shift && e.translated) {
        if (!(await askRevert(about(ch, e, label)))) return;
        jobs.hold(ch.id, true);
        const resp = await answer(intent.revert(ch.id));
        jobs.hold(ch.id, false);
        if (!resp || resp.ok === false) return;
        readAgain(client, ch.id).catch(() => {});
        return;
      }
      if (!(await askTranslate(e, about(ch, e, label)))) return;
      await translateFrom(ch.id);
    },

    // The right button on a translated chapter's translate button: "Re-run from…". Answers whether it
    // took the press (the browser's own menu shows otherwise).
    rerun(ch: Ref, e: Entity | null, label: string, anchor: HTMLElement) {
      if (!e?.translated || jobs.held(ch.id) || running(ch.id, 'translate')) return false;
      rerunning = { ch, e, label };
      deps.rerunMenu(ch.id, anchor);
      return true;
    },
    // A step of the menu chosen: asked first, then translated again from it.
    async rerunFrom(gid: string, point: string, stage: string) {
      const at = rerunning;
      rerunning = null;
      if (!at || at.ch.id !== gid) return;
      if (!(await askRerun(stage, about(at.ch, at.e, at.label)))) return;
      await translateFrom(gid, point);
    },

    // Detach: the chapter a gallery of its own again (no question, as 1.3).
    detach: (ch: Ref) => { remove(ch, false).catch(failed); },
    // Delete: asked first (a linked chapter in its own words), with Shift not.
    async delete(ch: Ref, e: Entity | null, label: string, quick: boolean) {
      if (!quick && !(await askDelete({ ...(e ?? {}), id: ch.id, linked: !!e?.linked }, about(ch, e, label)))) return;
      await remove(ch, true);
    },

    // Replace's file picked: its pages from it, as a library card's Replace does (the desktop app's
    // runner takes it when there is one, so it goes on whatever this window does).
    async replace(gid: string, files: File[]) {
      const [{ groupImports, importBytes }, { startImport }, { handImport }] = await Promise.all([import('@lib/import-files.js'), import('@lib/jobs-runner.js'), import('@lib/submit-job.js')]);
      const [group] = groupImports(files) as { name: string; fromFolder?: boolean }[];
      if (!group) { alertNotice({ title: t('dlg.file_type_title'), body: t('dlg.file_type_body'), detail: files[0]?.name, tone: 'error' }); return; }
      jobs.begin(gid, 'upload', t('prog.reading_file'));
      const staged = await (async () => {
        if (await handImport({ galleryId: gid, group, skipExisting: false })) return true;
        let buffer;
        try { buffer = await importBytes(group as never, ((p: Record<string, number>) => jobs.begin(gid, 'upload', t('prog.rendering', p))) as never); }
        catch {
          alertNotice({ title: t('dlg.file_read_title'), body: t('dlg.file_read_body'), detail: group.name, tone: 'error' });
          return false;
        }
        if (await startImport({ galleryId: gid, buffer, filename: group.name, skipExisting: false, inPlace: group.fromFolder })) return true;
        alertNotice({ title: t('dlg.file_stage_title'), body: t('dlg.file_stage_body'), detail: group.name, tone: 'error' });
        return false;
      })();
      if (!staged) jobs.discard(gid);
    },
  };
}

export type OverviewActions = ReturnType<typeof overviewActions>;

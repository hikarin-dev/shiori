// series.js — grouping standalone galleries into an ordered series of chapters.
//
// Each chapter stays a fully self-contained gallery (its own images, metadata, translation, study
// layers, cover). A "series" is a thin layer on top: the FIRST chapter's gallery owns the series
// and keeps its galleryId. The owner's metadata carries the ordered `chapters` list (the single
// source of truth for order + titles, chapters[0] being the owner itself) plus `seriesTags`, the
// searchable/display tag rollup for the series. Every chapter's own `tags` remain untouched; every
// other member's metadata carries `parentId` pointing back at the owner. db.js keeps a denormalized
// aggregate (chapterCount / aggPages / aggSize) on the owner's stat record for O(1) card rendering.
//
// What each change does is planned in series-plan.js and applied by the library in one
// transaction, so `chapters`, every `parentId` and the series totals change together or not at all.

import * as api from './api.js';
import { memberKind } from './gallery-model.js';
import { normalizeTitle, seriesTitleObject, editKeyForLang } from './titles.js';
export { RATINGS, unionTags, canDetachChapter } from './series-plan.js';

const _id = (v) => String(v);

// Resolve the series any gallery belongs to. Returns null for a standalone gallery.
// { ownerId, chapters:[{id,title,number?}], seriesTitle, currentId } — `currentId` is the queried gallery.
export function resolveSeries(galleryId) {
  return api.series.resolve(galleryId);
}

// Hydrated chapter list for the overview: each { id, title, number?, entity } in series order.
// `entity` is the full gallery entity (or null if the chapter's gallery has gone missing — rendered
// tolerantly).
export function getSeriesChapters(ownerId) {
  return api.series.chapters(ownerId);
}

// A chapter's own number from its source (a chapter-list entry's `number`: 23.5, "10.5", 0) as a
// label, decimals kept; null when the source gave none — a series merged by hand — so callers fall
// back to the chapter's position. Never a position: an extra (23.5) would shift every later one.
export function chapterNumberLabel(chapter) {
  const raw = chapter?.number;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : (String(raw).trim() || null);
}

// How many chapters a series has, counted as readers count them: each whole-numbered chapter once,
// the extras apart — the decimal ones (23.5) and a chapter 0 (a prologue or one-shot ahead of the
// story). A chapter without a number counts as a chapter; volumes aren't chapters.
export function chapterTally(chapters) {
  const wholes = new Set();
  let unnumbered = 0, extras = 0;
  for (const c of chapters || []) {
    if (memberKind(c) === 'volume') continue;
    const n = c?.number == null || c.number === '' ? NaN : Number(c.number);
    if (!Number.isFinite(n)) unnumbered++;
    else if (Number.isInteger(n) && n !== 0) wholes.add(n);
    else extras++;
  }
  return { chapters: wholes.size + unnumbered, extras };
}

// Merge `childId` into the series owned by `ownerId` as its next chapter (the owner keeps its id).
// A child that is itself a series is flattened in. `opts.title` overrides the chapter title.
export function mergeIntoSeries(ownerId, childId, opts = {}) {
  return api.series.attach(ownerId, childId, opts);
}

// Remove one chapter from a series: `deleteImages` deletes its gallery, otherwise it becomes a
// standalone gallery again. Resolves false when it can't be detached (a chapter with no pages).
export function removeChapter(ownerId, childId, { deleteImages = false } = {}) {
  return api.series.remove(ownerId, childId, { deleteImages });
}

// A new chapter order (ids in the desired order). If the head changes, ownership moves.
export function reorderChapters(ownerId, orderedIds) {
  return api.series.reorder(ownerId, orderedIds);
}

// One chapter's optional title.
export function setChapterTitle(ownerId, chapterId, title) {
  return api.series.setChapterTitle(ownerId, chapterId, title);
}

// Set the series title for the given app language (Japanese UI edits `japanese`, everything else
// edits `english`). The other languages are preserved, so switching the app language shows/edits
// the matching variant with an English fallback.
export async function setSeriesTitle(ownerId, langCode, value) {
  ownerId = _id(ownerId);
  const meta = await api.meta.get(ownerId);
  const cur = seriesTitleObject(meta?.seriesTitle) || { english: '', japanese: '', pretty: '' };
  cur[editKeyForLang(langCode)] = value || '';
  await api.galleries.mutate(ownerId, { seriesTitle: cur });
}

// Set a standalone gallery's OWN title for the given app language — the mirror of setSeriesTitle
// but writing the gallery's `title` object, so a non-series gallery's title is editable too. Other
// languages are preserved.
export async function setGalleryTitle(galleryId, langCode, value) {
  galleryId = _id(galleryId);
  const meta = await api.meta.get(galleryId);
  const cur = normalizeTitle(meta);
  cur[editKeyForLang(langCode)] = value || '';
  await api.galleries.mutate(galleryId, { title: cur });
}

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
// This module is the ONE place that keeps `chapters` and `parentId` in sync — every mutation ends
// by refreshing the affected aggregate so open surfaces re-render.

import { metaGet, mutateGallery, deleteGallery, refreshSeriesAggregate, getGalleriesByIds } from './db.js';
import { pickTitle, normalizeTitle, seriesTitleObject, editKeyForLang } from './titles.js';

const _id = (v) => String(v);
const _tagKey = (t) => `${t.type}:${t.name}`.toLowerCase();
const _seriesTagsOf = (m) => Array.isArray(m?.seriesTags) ? m.seriesTags : m?.tags;

// Metadata-only chapter shells must stay inside their series: detached, they would become empty
// top-level galleries with no useful reader context. A missing record remains detachable so stale
// chapter references can still be pruned from an owner's list.
export function canDetachChapter(entity) {
  return !entity || Number(entity.count) > 0;
}

// Union tag lists, de-duped by lower-cased `type:name` (the key db.js already indexes on). The
// first occurrence of each tag wins, so any extra fields on the original tag object are preserved.
function unionTags(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const t of (list || [])) {
      if (!t || t.type == null || t.name == null) continue;
      const k = _tagKey(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

// Resolve the series any gallery belongs to. Returns null for a standalone gallery.
// { ownerId, chapters:[{id,title}], seriesTitle, currentId } — `currentId` is the queried gallery.
export async function resolveSeries(galleryId) {
  const gid = _id(galleryId);
  const meta = await metaGet(gid);
  if (!meta) return null;
  const ownerId = meta.parentId ? _id(meta.parentId) : gid;
  const ownerMeta = meta.parentId ? await metaGet(ownerId) : meta;
  if (!ownerMeta || !Array.isArray(ownerMeta.chapters) || ownerMeta.chapters.length < 2) return null;
  return { ownerId, chapters: ownerMeta.chapters, seriesTitle: ownerMeta.seriesTitle || '', currentId: gid };
}

// Hydrated chapter list for the overview: each { id, title, entity } in series order. `entity` is
// the full gallery entity (or null if the chapter's gallery has gone missing — rendered tolerantly).
export async function getSeriesChapters(ownerId) {
  const meta = await metaGet(_id(ownerId));
  const chapters = Array.isArray(meta?.chapters) ? meta.chapters : [];
  const entities = await getGalleriesByIds(chapters.map(c => c.id));
  return chapters.map((c, i) => ({ id: _id(c.id), title: c.title || '', entity: entities[i] || null }));
}

// Merge `childId` into the series owned by `ownerId` as its next chapter (owner keeps its id).
// If the child is itself a series, its chapters are flattened in and its members re-parented.
// Tags from every absorbed gallery are unioned into the owner's `seriesTags`; chapter `tags` stay
// chapter-local. `opts.title` overrides the default chapter title (the child's own gallery title).
export async function mergeIntoSeries(ownerId, childId, opts = {}) {
  ownerId = _id(ownerId); childId = _id(childId);
  if (ownerId === childId) throw new Error('Cannot merge a gallery into itself');
  const [ownerMeta, childMeta] = await Promise.all([metaGet(ownerId), metaGet(childId)]);
  if (!ownerMeta) throw new Error('Target gallery not found');
  if (!childMeta) throw new Error('Chapter gallery not found');
  if (ownerMeta.parentId) throw new Error('Target is already a chapter of another series');
  if (childMeta.parentId) throw new Error('That gallery is already part of a series');

  const hadSeries = Array.isArray(ownerMeta.chapters) && ownerMeta.chapters.length > 0;
  const chapters = hadSeries ? ownerMeta.chapters.slice() : [{ id: ownerId, title: '' }];
  const present = new Set(chapters.map(c => _id(c.id)));

  const tagLists = [hadSeries ? _seriesTagsOf(ownerMeta) : ownerMeta.tags];
  const childChapters = Array.isArray(childMeta.chapters) ? childMeta.chapters : null;

  if (childChapters && childChapters.length > 1) {
    const childSeriesTags = Array.isArray(childMeta.seriesTags) ? childMeta.seriesTags : null;
    tagLists.push(childSeriesTags || childMeta.tags);
    // Child is a series → absorb every member, re-parenting each to the new owner.
    for (const c of childChapters) {
      const cid = _id(c.id);
      if (present.has(cid)) continue;
      chapters.push({ id: cid, title: c.title || '' });
      present.add(cid);
      if (!childSeriesTags) {
        const cm = await metaGet(cid);
        if (cm) tagLists.push(cm.tags);
      }
      if (cid !== childId) await mutateGallery(cid, { parentId: ownerId });
    }
    // The former sub-owner is now a plain chapter — clear its owner-only fields.
    await mutateGallery(childId, { chapters: null, seriesTitle: '', seriesTags: null });
  } else {
    const title = opts.title != null ? opts.title : (pickTitle(childMeta, 'en') || '');
    chapters.push({ id: childId, title });
    tagLists.push(childMeta.tags);
  }

  const patch = { chapters, seriesTags: unionTags(...tagLists) };
  // Converting a standalone gallery into a series: seed the series title from the owner's own title
  // so every source language it had (english/japanese/pretty) is preserved and editable.
  if (!hadSeries && !ownerMeta.seriesTitle) patch.seriesTitle = normalizeTitle(ownerMeta);
  await mutateGallery(ownerId, patch);
  await mutateGallery(childId, { parentId: ownerId });
  await refreshSeriesAggregate(ownerId);
}

// Establish `newChapters` (already in final order) as a series owned by newChapters[0], migrating
// ownership off `oldOwnerId` if the head changed. Dissolves to standalone when < 2 chapters remain.
async function _writeSeries(oldOwnerId, newChapters) {
  oldOwnerId = _id(oldOwnerId);
  const owner = newChapters[0] ? _id(newChapters[0].id) : null;

  if (!owner || newChapters.length < 2) {
    if (owner) await mutateGallery(owner, { chapters: null, seriesTitle: '', seriesTags: null, parentId: null });
    if (oldOwnerId !== owner) {
      await mutateGallery(oldOwnerId, { chapters: null, seriesTitle: '', seriesTags: null, parentId: null });
      await refreshSeriesAggregate(oldOwnerId);
    }
    if (owner) await refreshSeriesAggregate(owner);
    return;
  }

  const prevMeta = await metaGet(oldOwnerId);
  await mutateGallery(owner, {
    chapters: newChapters,
    seriesTitle: prevMeta?.seriesTitle || '',
    seriesTags: _seriesTagsOf(prevMeta),
    parentId: null,
  });
  for (const c of newChapters) {
    if (_id(c.id) === owner) continue;
    await mutateGallery(c.id, { parentId: owner });
  }
  if (oldOwnerId !== owner) {
    const stillPresent = newChapters.some(c => _id(c.id) === oldOwnerId);
    await mutateGallery(oldOwnerId, stillPresent
      ? { chapters: null, seriesTitle: '', seriesTags: null }              // demoted to a plain chapter
      : { chapters: null, seriesTitle: '', seriesTags: null, parentId: null }); // removed entirely → standalone
    await refreshSeriesAggregate(oldOwnerId);
  }
  await refreshSeriesAggregate(owner);
}

// Remove one chapter from a series. `deleteImages` deletes the chapter's gallery outright;
// otherwise it detaches and returns to the top-level library as a standalone gallery. Removing the
// owner (chapter 1) promotes the next chapter to owner; dropping below 2 chapters dissolves the
// series (the survivor becomes standalone).
export async function removeChapter(ownerId, childId, { deleteImages = false } = {}) {
  ownerId = _id(ownerId); childId = _id(childId);
  const ownerMeta = await metaGet(ownerId);
  // Orphaned chapter: its owner is gone (or is no longer a series), so there is no chapter list to
  // update. Act on the chapter alone — delete it outright, or detach it into a standalone gallery —
  // clearing its dangling parentId so no trail of the vanished series remains.
  if (!ownerMeta || !Array.isArray(ownerMeta.chapters)) {
    if (deleteImages) { await deleteGallery(childId); return true; }
    const [child] = await getGalleriesByIds([childId]);
    if (child) await mutateGallery(childId, { parentId: null });
    return true;
  }
  const remaining = ownerMeta.chapters.filter(c => _id(c.id) !== childId);
  let child = null;

  if (!deleteImages) {
    [child] = await getGalleriesByIds([childId]);
    if (!canDetachChapter(child)) return false;
  }

  if (childId === ownerId) {
    // Removing the owner: re-own the remainder (or dissolve), then detach/delete the old owner.
    await _writeSeries(ownerId, remaining);
    if (deleteImages) await deleteGallery(ownerId);
    return;
  }

  if (deleteImages) await deleteGallery(childId);
  else {
    // A series can contain a stale chapter id whose gallery record is already gone. Detaching that
    // should only prune the owner's chapter list; writing parentId:null would create an empty
    // top-level gallery shell.
    if (child) await mutateGallery(childId, { parentId: null });
  }

  if (remaining.length < 2) {
    await _writeSeries(ownerId, remaining);   // dissolve — owner reverts to standalone
  } else {
    await mutateGallery(ownerId, { chapters: remaining });
    await refreshSeriesAggregate(ownerId);
  }
  return true;
}

// Persist a new chapter order (ids in the desired order). If the head changes, ownership moves.
export async function reorderChapters(ownerId, orderedIds) {
  ownerId = _id(ownerId);
  const ownerMeta = await metaGet(ownerId);
  if (!ownerMeta || !Array.isArray(ownerMeta.chapters)) return;
  const byId = new Map(ownerMeta.chapters.map(c => [_id(c.id), c]));
  const next = orderedIds.map(id => byId.get(_id(id))).filter(Boolean);
  // Keep any chapter the caller forgot to list, appended in existing order (defensive).
  for (const c of ownerMeta.chapters) if (!orderedIds.map(_id).includes(_id(c.id))) next.push(c);
  if (next.length < 2) return;

  if (_id(next[0].id) === ownerId) {
    await mutateGallery(ownerId, { chapters: next });
    await refreshSeriesAggregate(ownerId);
  } else {
    await _writeSeries(ownerId, next);   // head changed → transfer ownership
  }
}

// Set one chapter's optional title.
export async function setChapterTitle(ownerId, chapterId, title) {
  ownerId = _id(ownerId); chapterId = _id(chapterId);
  const ownerMeta = await metaGet(ownerId);
  if (!ownerMeta || !Array.isArray(ownerMeta.chapters)) return;
  const chapters = ownerMeta.chapters.map(c => _id(c.id) === chapterId ? { ...c, title: title || '' } : c);
  await mutateGallery(ownerId, { chapters });
}

// Set the series title for the given app language (Japanese UI edits `japanese`, everything else
// edits `english`). The other languages are preserved, so switching the app language shows/edits
// the matching variant with an English fallback.
export async function setSeriesTitle(ownerId, langCode, value) {
  ownerId = _id(ownerId);
  const meta = await metaGet(ownerId);
  const cur = seriesTitleObject(meta?.seriesTitle) || { english: '', japanese: '', pretty: '' };
  cur[editKeyForLang(langCode)] = value || '';
  await mutateGallery(ownerId, { seriesTitle: cur });
}

// Set a standalone gallery's OWN title for the given app language — the mirror of setSeriesTitle
// but writing the gallery's `title` object, so a non-series gallery's title is editable too. Other
// languages are preserved.
export async function setGalleryTitle(galleryId, langCode, value) {
  galleryId = _id(galleryId);
  const meta = await metaGet(galleryId);
  const cur = normalizeTitle(meta);
  cur[editKeyForLang(langCode)] = value || '';
  await mutateGallery(galleryId, { title: cur });
}

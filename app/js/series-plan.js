// series-plan.js — what each series command changes, as pure code over the galleries it reads, so a
// library backend can apply the whole change in one transaction (db.js seriesCommand).
//
// A plan reads through `s`: `s.meta(gid)` and `s.stat(gid)` (a gallery's metadata and stat record,
// null when missing) and `s.children(ownerId)` (the galleries whose stat record names it as their
// series) are undefined until loaded. A plan that meets one returns `s.need(ids, childrenOf)` and is
// run again once they are, so it must only read, never keep state between runs. It returns
// `{ writes, deletes, totals, result }`:
//   writes   Map gid → patch, applied as mutateGallery applies one
//   deletes  galleries deleted outright: pages, metadata, cover
//   totals   series owners whose totals are recomputed after the writes and deletes
//   result   what the command returns

import { pickTitle, normalizeTitle } from './titles.js';
import { BackendError } from './backend-error.js';
import { memberKind } from './gallery-model.js';

const _id = (v) => String(v);
const _tagKey = (t) => `${t.type}:${t.name}`.toLowerCase();
const _seriesTagsOf = (m) => Array.isArray(m?.seriesTags) ? m.seriesTags : m?.tags;

// Ratings from lowest to highest.
export const RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'];
const _ratingRank = (t) => RATINGS.indexOf(String(t.name).toLowerCase());

// Union tag lists, de-duped by lower-cased `type:name` (the key the library indexes tags by). The
// first occurrence of each tag wins, so any extra fields on the original tag object are preserved.
// A series has one category and one rating, as a gallery does: the first category listed stays,
// and the highest rating.
export function unionTags(...lists) {
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
  const category = out.find(t => t.type === 'category');
  const rating = out.filter(t => t.type === 'rating').reduce((top, t) => (!top || _ratingRank(t) > _ratingRank(top) ? t : top), null);
  return out.filter(t => (t.type !== 'category' || t === category) && (t.type !== 'rating' || t === rating));
}

// Metadata-only chapter shells must stay inside their series: detached, they would become empty
// top-level galleries with no useful reader context. A missing record remains detachable so stale
// chapter references can still be pruned from an owner's list.
export function canDetachChapter(entity) {
  return !entity || Number(entity.count) > 0;
}

// A plan under construction: patches to one gallery merge, as consecutive mutations would. `opts`
// are mutateGallery's (touch, onlyIfExists); `silent` plans change without announcing it.
function _plan() {
  const writes = new Map(), opts = new Map();
  return {
    writes, opts, deletes: [], totals: [], result: undefined, silent: false,
    write(gid, patch, o) {
      writes.set(_id(gid), { ...(writes.get(_id(gid)) || {}), ...patch });
      if (o) opts.set(_id(gid), o);
    },
  };
}

// A series list entry's kind, as the gallery it names says (a chapter needs none).
const _kindOf = (meta) => (memberKind(meta) === 'volume' ? { kind: 'volume' } : {});

// Merge `childId` into the series owned by `ownerId` as its next member (the owner keeps its id),
// listed as a chapter or a volume as the gallery says. A child that is itself a series is flattened
// in, its members re-parented. Tags from every absorbed
// gallery are unioned into the owner's `seriesTags`; chapter `tags` stay chapter-local. `opts.title`
// overrides the default chapter title (the child's own gallery title).
export function planAttach(s, ownerId, childId, opts = {}) {
  ownerId = _id(ownerId); childId = _id(childId);
  if (ownerId === childId) throw new BackendError('invalid', 'Cannot merge a gallery into itself');
  const ownerMeta = s.meta(ownerId), childMeta = s.meta(childId);
  if (ownerMeta === undefined || childMeta === undefined) return s.need([ownerId, childId]);
  if (!ownerMeta) throw new BackendError('not-found', 'Target gallery not found');
  if (!childMeta) throw new BackendError('not-found', 'Chapter gallery not found');
  if (ownerMeta.parentId) throw new BackendError('invalid', 'Target is already a chapter of another series');
  if (childMeta.parentId) throw new BackendError('invalid', 'That gallery is already part of a series');

  const childChapters = Array.isArray(childMeta.chapters) && childMeta.chapters.length > 1 ? childMeta.chapters : null;
  const childSeriesTags = Array.isArray(childMeta.seriesTags) ? childMeta.seriesTags : null;
  if (childChapters && !childSeriesTags) {
    const ids = childChapters.map(c => _id(c.id));
    if (ids.some(id => s.meta(id) === undefined)) return s.need(ids);
  }

  const plan = _plan();
  const hadSeries = Array.isArray(ownerMeta.chapters) && ownerMeta.chapters.length > 0;
  // Chapter one is titled the same way every other chapter is — from its own gallery title — so it
  // still reads as a chapter once it is no longer the head (reorder, or absorbed into another
  // series) and so surfaces that show the stored titles verbatim don't leave it blank.
  const chapters = hadSeries ? ownerMeta.chapters.slice() : [{ id: ownerId, title: pickTitle(ownerMeta, 'en') || '', ..._kindOf(ownerMeta) }];
  const present = new Set(chapters.map(c => _id(c.id)));
  const tagLists = [hadSeries ? _seriesTagsOf(ownerMeta) : ownerMeta.tags];

  if (childChapters) {
    tagLists.push(childSeriesTags || childMeta.tags);
    // The child is a series: absorb every member, re-parenting each to the new owner.
    for (const c of childChapters) {
      const cid = _id(c.id);
      if (present.has(cid)) continue;
      chapters.push({ id: cid, title: c.title || '', ...(c.number != null ? { number: c.number } : {}), ..._kindOf(c) });
      present.add(cid);
      if (!childSeriesTags) { const cm = s.meta(cid); if (cm) tagLists.push(cm.tags); }
      if (cid !== childId) plan.write(cid, { parentId: ownerId });
    }
    // The former sub-owner is now a plain chapter: clear its owner-only fields.
    plan.write(childId, { chapters: null, seriesTitle: '', seriesTags: null });
  } else {
    const title = opts.title != null ? opts.title : (pickTitle(childMeta, 'en') || '');
    chapters.push({ id: childId, title, ..._kindOf(childMeta) });
    tagLists.push(childMeta.tags);
  }

  const patch = { chapters, seriesTags: unionTags(...tagLists) };
  // Converting a standalone gallery into a series: seed the series title from the owner's own title
  // so every source language it had (english/japanese/pretty) is preserved and editable.
  if (!hadSeries && !ownerMeta.seriesTitle) patch.seriesTitle = normalizeTitle(ownerMeta);
  plan.write(ownerId, patch);
  plan.write(childId, { parentId: ownerId });
  plan.totals.push(ownerId);
  return plan;
}

// Establish `newChapters` (already in final order) as a series owned by newChapters[0], moving
// ownership off `oldOwnerId` if the head changed. Dissolves to standalone when < 2 chapters remain.
function _writeSeries(plan, prevMeta, oldOwnerId, newChapters) {
  oldOwnerId = _id(oldOwnerId);
  const owner = newChapters[0] ? _id(newChapters[0].id) : null;
  // A new head takes over the series' favorite, as it does its title and tags, and the old head
  // gives it up — the card that stands for the series stays favorited (or not).
  const handover = !!owner && owner !== oldOwnerId;
  const takeFavorite = handover ? { favorite: !!prevMeta?.favorite } : {};
  const dropFavorite = handover ? { favorite: false } : {};

  if (!owner || newChapters.length < 2) {
    if (owner) plan.write(owner, { chapters: null, seriesTitle: '', seriesTags: null, parentId: null, ...takeFavorite });
    if (oldOwnerId !== owner) {
      plan.write(oldOwnerId, { chapters: null, seriesTitle: '', seriesTags: null, parentId: null, ...dropFavorite });
      plan.totals.push(oldOwnerId);
    }
    if (owner) plan.totals.push(owner);
    return;
  }

  plan.write(owner, {
    chapters: newChapters,
    seriesTitle: prevMeta?.seriesTitle || '',
    seriesTags: _seriesTagsOf(prevMeta),
    parentId: null,
    ...takeFavorite,
  });
  for (const c of newChapters) {
    if (_id(c.id) !== owner) plan.write(c.id, { parentId: owner });
  }
  if (oldOwnerId !== owner) {
    const stillPresent = newChapters.some(c => _id(c.id) === oldOwnerId);
    plan.write(oldOwnerId, stillPresent
      ? { chapters: null, seriesTitle: '', seriesTags: null, ...dropFavorite }                  // demoted to a plain chapter
      : { chapters: null, seriesTitle: '', seriesTags: null, parentId: null, ...dropFavorite }); // removed entirely → standalone
    plan.totals.push(oldOwnerId);
  }
  plan.totals.push(owner);
}

// Remove one chapter from a series. `deleteImages` deletes the chapter's gallery outright; otherwise
// it detaches and returns to the top-level library as a standalone gallery. Removing the owner
// (chapter 1) promotes the next chapter to owner; dropping below 2 chapters dissolves the series (the
// survivor becomes standalone). Results in false when the chapter can't be detached.
export function planRemove(s, ownerId, childId, { deleteImages = false } = {}) {
  ownerId = _id(ownerId); childId = _id(childId);
  const ownerMeta = s.meta(ownerId), childMeta = s.meta(childId), childStat = s.stat(childId);
  if ([ownerMeta, childMeta, childStat].includes(undefined)) return s.need([ownerId, childId]);
  const plan = _plan();
  plan.result = true;
  const childExists = !!(childStat || childMeta);
  // Orphaned chapter: its owner is gone (or is no longer a series), so there is no chapter list to
  // update. Act on the chapter alone — delete it outright, or detach it into a standalone gallery —
  // clearing its dangling parentId so no trail of the vanished series remains.
  if (!ownerMeta || !Array.isArray(ownerMeta.chapters)) {
    if (deleteImages) plan.deletes.push(childId);
    else if (childExists) plan.write(childId, { parentId: null });
    return plan;
  }
  const remaining = ownerMeta.chapters.filter(c => _id(c.id) !== childId);
  if (!deleteImages && !canDetachChapter(childExists ? { count: Number(childStat?.count) || 0 } : null)) {
    plan.result = false;
    return plan;
  }

  if (childId === ownerId) {
    // Removing the owner: re-own the remainder (or dissolve), then detach/delete the old owner.
    _writeSeries(plan, ownerMeta, ownerId, remaining);
    if (deleteImages) plan.deletes.push(ownerId);
    return plan;
  }

  if (deleteImages) plan.deletes.push(childId);
  // A series can hold a stale chapter id whose gallery is already gone. Detaching that only prunes
  // the owner's chapter list; writing parentId:null would create an empty top-level gallery shell.
  else if (childExists) plan.write(childId, { parentId: null });

  if (remaining.length < 2) {
    _writeSeries(plan, ownerMeta, ownerId, remaining);   // dissolve: the owner reverts to standalone
  } else {
    plan.write(ownerId, { chapters: remaining });
    plan.totals.push(ownerId);
  }
  return plan;
}

// A new chapter order (ids in the desired order). If the head changes, ownership moves.
export function planReorder(s, ownerId, orderedIds) {
  ownerId = _id(ownerId);
  const ownerMeta = s.meta(ownerId);
  if (ownerMeta === undefined) return s.need([ownerId]);
  const plan = _plan();
  if (!ownerMeta || !Array.isArray(ownerMeta.chapters)) return plan;
  const ordered = (orderedIds || []).map(_id);
  const byId = new Map(ownerMeta.chapters.map(c => [_id(c.id), c]));
  const next = ordered.map(id => byId.get(id)).filter(Boolean);
  // Keep any chapter the caller forgot to list, appended in existing order (defensive).
  for (const c of ownerMeta.chapters) if (!ordered.includes(_id(c.id))) next.push(c);
  if (next.length < 2) return plan;
  if (_id(next[0].id) === ownerId) {
    plan.write(ownerId, { chapters: next });
    plan.totals.push(ownerId);
  } else {
    _writeSeries(plan, ownerMeta, ownerId, next);   // the head changed: ownership moves
  }
  return plan;
}

// One chapter's optional title.
export function planChapterTitle(s, ownerId, chapterId, title) {
  ownerId = _id(ownerId); chapterId = _id(chapterId);
  const ownerMeta = s.meta(ownerId);
  if (ownerMeta === undefined) return s.need([ownerId]);
  const plan = _plan();
  if (!ownerMeta || !Array.isArray(ownerMeta.chapters)) return plan;
  plan.write(ownerId, { chapters: ownerMeta.chapters.map(c => (_id(c.id) === chapterId ? { ...c, title: title || '' } : c)) });
  return plan;
}

// Make exactly this series, as a series import does: `chapters` (the owner first) with the given
// title and tags, every chapter linked to the owner, and any former chapter of the owner that isn't
// listed deleted — a shorter import replaces the series rather than leaving hidden chapters. One
// chapter makes a standalone gallery.
export function planWrite(s, ownerId, chapters, { seriesTitle = '', seriesTags = null } = {}) {
  ownerId = _id(ownerId);
  const children = s.children(ownerId);
  if (children === undefined) return s.need([], [ownerId]);
  const plan = _plan();
  const list = (chapters || []).map(c => ({ ...c, id: _id(c.id) }));
  if (list.length >= 2) {
    plan.write(ownerId, { chapters: list, seriesTitle: seriesTitle || '', seriesTags, parentId: null });
    for (const c of list) if (c.id !== ownerId) plan.write(c.id, { parentId: ownerId });
  } else {
    plan.write(ownerId, { chapters: null, seriesTitle: '', seriesTags: null, parentId: null });
  }
  const keep = new Set([ownerId, ...(list.length >= 2 ? list.map(c => c.id) : [])]);
  for (const gid of children) if (!keep.has(_id(gid))) plan.deletes.push(_id(gid));
  plan.totals.push(ownerId);
  return plan;
}

// Delete one gallery and keep its series whole: a chapter leaves its series' list (the series
// dissolving below two chapters), an owner hands the series to its next chapter.
export function planDelete(s, gid) {
  gid = _id(gid);
  const meta = s.meta(gid);
  if (meta === undefined) return s.need([gid]);
  if (meta?.parentId) return planRemove(s, meta.parentId, gid, { deleteImages: true });
  if (Array.isArray(meta?.chapters) && meta.chapters.length > 1) return planRemove(s, gid, gid, { deleteImages: true });
  const plan = _plan();
  plan.deletes.push(gid);
  plan.result = true;
  return plan;
}

// Delete a whole series at once: the owner, every chapter it lists, and any chapter that still
// points at it without being listed.
export function planDeleteSeries(s, ownerId) {
  ownerId = _id(ownerId);
  const meta = s.meta(ownerId), children = s.children(ownerId);
  if (meta === undefined || children === undefined) return s.need([ownerId], [ownerId]);
  const plan = _plan();
  const ids = new Set([ownerId, ...children.map(_id)]);
  if (Array.isArray(meta?.chapters)) for (const c of meta.chapters) ids.add(_id(c.id));
  plan.deletes.push(...ids);
  plan.result = true;
  return plan;
}

// A change to one gallery that touches its series links (`parentId`, `chapters`), as a source's own
// series sync writes them, applied as given while every series it touches stays whole: a series the
// gallery leaves drops it from its list (dissolving below two chapters), and chapters an owner no
// longer lists stop pointing at it. Joining a series doesn't add the gallery to that series' list;
// the list is the series' own to write. Results in whether the gallery was there to change.
export function planRelink(s, gid, patch, { touch = true, onlyIfExists = false, silent = false } = {}) {
  gid = _id(gid);
  const meta = s.meta(gid);
  if (meta === undefined) return s.need([gid]);
  const plan = _plan();
  plan.silent = silent;
  plan.result = !(onlyIfExists && !meta);
  if (!plan.result) return plan;
  plan.write(gid, patch, { touch, onlyIfExists });

  const oldParent = meta?.parentId ? _id(meta.parentId) : null;
  const newParent = 'parentId' in patch ? (patch.parentId ? _id(patch.parentId) : null) : oldParent;
  if (oldParent && oldParent !== newParent) {
    const parentMeta = s.meta(oldParent);
    if (parentMeta === undefined) return s.need([oldParent]);
    const listed = Array.isArray(parentMeta?.chapters) ? parentMeta.chapters : [];
    if (listed.some(c => _id(c.id) === gid)) {
      const remaining = listed.filter(c => _id(c.id) !== gid);
      if (remaining.length < 2) _writeSeries(plan, parentMeta, oldParent, remaining);
      else { plan.write(oldParent, { chapters: remaining }); plan.totals.push(oldParent); }
    }
  }
  if ('chapters' in patch) {
    const children = s.children(gid);
    if (children === undefined) return s.need([], [gid]);
    const keep = new Set((Array.isArray(patch.chapters) && patch.chapters.length > 1 ? patch.chapters : []).map(c => _id(c.id)));
    for (const child of children) if (_id(child) !== gid && !keep.has(_id(child))) plan.write(child, { parentId: null });
    plan.totals.push(gid);
  }
  return plan;
}

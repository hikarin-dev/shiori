// store.js — Reactive, windowed gallery store (see ARCHITECTURE.md §5).
//
// The single client-side view over the durable library. Surfaces read one page at a
// time, subscribe per-gallery, and re-render from a pure function of state; they never
// keep their own divergent copy or hand-patch fields. Reads/writes and the change feed go
// through the api.js contract (see ARCHITECTURE-v2.md), so the storage backend and transport
// stay swappable (IndexedDB now; PWA service worker / HTTP-NAS later).

import { galleries, events } from './api.js';

// Windowed cache: only entities currently referenced (the visible page + explicit
// get/load calls). Off-screen galleries are never materialized — memory is bounded by
// what is on screen, not by library size.
const _cache = new Map();          // gid -> entity
const _subs  = new Map();          // gid (or '*') -> Set<cb>
let _lastFeedN = 0;

function _emit(gid) {
  const direct = _subs.get(gid);
  if (direct) for (const cb of [...direct]) { try { cb(gid); } catch {} }
  const all = _subs.get('*');
  if (all) for (const cb of [...all]) { try { cb(gid); } catch {} }
}

// Subscribe to changes for one gallery, or '*' for any change. Returns an unsubscribe.
export function subscribe(gid, cb) {
  const key = String(gid);
  if (!_subs.has(key)) _subs.set(key, new Set());
  _subs.get(key).add(cb);
  return () => {
    const s = _subs.get(key);
    if (s) { s.delete(cb); if (!s.size) _subs.delete(key); }
  };
}

// Synchronous read of a cached entity (undefined if not loaded/visible).
export function get(gid) {
  return _cache.get(String(gid));
}

// Re-read one gallery from the database into the cache.
export async function load(gid) {
  const key = String(gid);
  const entity = await galleries.get(key);
  if (entity) _cache.set(key, entity); else _cache.delete(key);
  return entity || null;
}

// Lightweight projection used for search filtering (no cover, no stats — just what a
// search predicate needs). Keeps the filter pass off the heavy data.
function _lite(id, meta) {
  const m = meta || {};
  return { id: String(id), title: m.titlePretty || m.titleEnglish || '', tags: m.tags || [] };
}

// One page of galleries. Without `match`, sorting + pagination happen in the database
// (index cursor, O(pageSize)). With `match`, ids are sorted in the DB, filtered against
// metadata (no covers loaded), then only the visible window is hydrated.
export async function getPage({ sort = 'updated', dir, page = 1, pageSize = 60, match = null } = {}) {
  if (!match) {
    const offset = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      galleries.page({ sort, dir, offset, limit: pageSize }),
      galleries.count(),
    ]);
    for (const e of items) _cache.set(e.id, e);
    return { items, total };
  }

  const [ids, metaMap] = await Promise.all([galleries.idsSorted({ sort, dir }), galleries.metaMap()]);
  const matched = ids.filter(id => match(_lite(id, metaMap.get(id))));
  const total = matched.length;
  const start = (page - 1) * pageSize;
  const windowIds = matched.slice(start, start + pageSize);
  const items = (await galleries.byIds(windowIds)).filter(Boolean);
  for (const e of items) _cache.set(e.id, e);
  return { items, total };
}

export async function mutate(gid, patch) {
  return galleries.mutate(gid, patch);
}

export async function remove(gid) {
  _cache.delete(String(gid));
  return galleries.remove(gid);
}

// Feed listener: on a beacon, re-read just the changed gallery and notify its subscribers.
// Galleries nobody is watching (and not cached) are ignored — the lazy path that keeps a
// large library cheap. The transport (chrome.storage now; BroadcastChannel/SW later) is
// hidden behind api.events.
events.onChange((v) => {
  if (v.n != null && v.n === _lastFeedN) return;   // drop duplicate beacon
  _lastFeedN = v.n;
  const gid = String(v.gid);
  if (!_subs.has(gid) && !_subs.has('*') && !_cache.has(gid)) return;
  load(gid).then(() => _emit(gid)).catch(() => _emit(gid));
});

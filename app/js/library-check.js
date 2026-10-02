// library-check.js — the library's invariants, checked without changing anything.
//
// checkInvariants(snapshot) is a pure function of the library's integrity snapshot
// (api.maintenance.integritySnapshot), so tests can check any library state they build; checkLibrary() reads the live library and checks it. Errors break
// what a person sees or keeps (hidden or lost galleries, wrong counts, unreadable images); warnings
// are drift the app repairs on its own next change, or tolerated leftovers (wasted space,
// duplicate page numbers after an interrupted overwrite).

import * as api from './api.js';

export const INVARIANTS = {
  I1: { severity: 'error', text: 'Every metadata record is a placeholder or has a gallery entry' },
  I2: { severity: 'error', text: 'Every gallery entry has a metadata record' },
  I3: { severity: 'error', text: 'Every page belongs to a gallery entry' },
  I4: { severity: 'error', text: 'Every cover belongs to a gallery entry' },
  I5: { severity: 'error', text: 'Every image reference resolves to a stored image' },
  I5w: { severity: 'warning', text: 'Every stored image is referenced by its record' },
  I6: { severity: 'warning', text: 'A source gallery stored more than once (allowed: lookups by source id answer the first added)' },
  I6w: { severity: 'warning', text: 'A source id is used by one source only (lookups go by id alone)' },
  I7: { severity: 'error', text: "A chapter's series link agrees between its metadata and its gallery entry" },
  I8: { severity: 'error', text: 'Series and chapters point at each other (no hidden chapters)' },
  I8w: { severity: 'warning', text: 'A series has more than one chapter' },
  I9: { severity: 'error', text: 'Every gallery entry carries every sort key, or it is counted but never listed under that sort' },
  I10: { severity: 'error', text: "A gallery's page count equals its stored pages" },
  I11: { severity: 'warning', text: "A gallery's size equals its export archive's" },
  I12: { severity: 'warning', text: "A series' chapter count and totals equal its chapters'" },
  I13: { severity: 'warning', text: 'Page numbers are readable and unique within a gallery' },
  I14: { severity: 'warning', text: 'A gallery with pages has real metadata, not just a placeholder' },
};

const SORT_KEYS = ['count', 'size', 'latestAt', 'addedAt', 'uploadDate'];
const isKey = (v) => typeof v === 'number' && !Number.isNaN(v);

export function checkInvariants(snap) {
  const violations = [];
  const add = (id, gid, detail) => violations.push({ id, severity: INVARIANTS[id].severity, gid: gid ?? null, detail });

  const metas = new Map(snap.metas.map(m => [m.gid, m]));
  const stats = new Map(snap.galleries.map(g => [g.gid, g]));
  const pagesBy = new Map();
  for (const p of snap.pages) {
    if (!pagesBy.has(p.gid)) pagesBy.set(p.gid, []);
    pagesBy.get(p.gid).push(p);
  }
  const isSeries = (m) => Array.isArray(m?.chapters) && m.chapters.length > 1;

  // I1 / I2 — metadata and gallery entries come in pairs (placeholders excepted).
  for (const m of snap.metas) if (!m.isStub && !stats.has(m.gid)) add('I1', m.gid, `"${m.title}" has metadata but no gallery entry`);
  for (const g of snap.galleries) if (!metas.has(g.gid)) add('I2', g.gid, 'gallery entry without metadata');

  // I3 / I4 — pages and covers belong to a gallery entry.
  for (const [gid, pages] of pagesBy) if (!stats.has(gid)) add('I3', gid, `${pages.length} page(s) with no gallery entry`);
  if (snap.pagesWithoutGallery) add('I3', null, `${snap.pagesWithoutGallery} page record(s) carry no gallery id`);
  for (const c of snap.covers) if (!stats.has(c.gid)) add('I4', c.gid, 'cover with no gallery entry');

  // I5 — every reference resolves; every stored image is referenced.
  const images = new Set(snap.images);
  const referenced = new Set();
  for (const p of snap.pages) for (const id of p.refs) {
    referenced.add(id);
    if (!images.has(id)) add('I5', p.gid, `page ${p.url} refers to a missing image (${id})`);
  }
  for (const c of snap.covers) for (const id of c.refs) {
    referenced.add(id);
    if (!images.has(id)) add('I5', c.gid, `cover refers to a missing image (${id})`);
  }
  let unreferenced = 0;
  for (const id of images) if (!referenced.has(id)) unreferenced++;
  if (unreferenced) add('I5w', null, `${unreferenced} stored image(s) no record refers to`);

  // I6 — copies of one source gallery (kept on purpose; lookups answer the first added); ids shared
  // across sources are a lookup hazard.
  const bySource = new Map();
  for (const m of snap.metas) if (m.sourceId) {
    if (!bySource.has(m.sourceId)) bySource.set(m.sourceId, []);
    bySource.get(m.sourceId).push(m);
  }
  for (const [sid, group] of bySource) {
    if (group.length < 2) continue;
    const sources = group.map(m => m.source);
    const distinct = sources.every(Boolean) && new Set(sources).size === group.length;
    add(distinct ? 'I6w' : 'I6', group[0].gid, `source id ${sid} is held by ${group.map(m => `${m.gid}${m.source ? ` (${m.source})` : m.isStub ? ' (placeholder)' : ''}`).join(', ')}`);
  }

  // I7 / I8 — series links, both directions.
  for (const g of snap.galleries) {
    const m = metas.get(g.gid);
    if (m && (m.parentId || null) !== (g.parentId || null)) {
      add('I7', g.gid, `metadata says series ${m.parentId || 'none'}, gallery entry says ${g.parentId || 'none'}`);
    }
  }
  for (const m of snap.metas) {
    if (!m.parentId) continue;
    const owner = metas.get(m.parentId);
    if (!owner || !stats.has(m.parentId)) add('I8', m.gid, `"${m.title}" is a chapter of ${m.parentId}, which doesn't exist — hidden from the library`);
    else if (!isSeries(owner) || !owner.chapters.includes(m.gid)) add('I8', m.gid, `"${m.title}" points at series ${m.parentId}, which doesn't list it — hidden from the library`);
  }
  for (const m of snap.metas) {
    if (!Array.isArray(m.chapters) || !m.chapters.length) continue;
    if (m.chapters.length === 1) { add('I8w', m.gid, 'a chapter list of one'); continue; }
    if (m.parentId) add('I8', m.gid, `series "${m.title}" is itself a chapter of ${m.parentId}`);
    if (!m.chapters.includes(m.gid)) add('I8', m.gid, `series "${m.title}" doesn't list itself as a chapter`);
    if (new Set(m.chapters).size !== m.chapters.length) add('I8', m.gid, `series "${m.title}" lists a chapter twice`);
    for (const cid of m.chapters) {
      if (cid === m.gid) continue;
      const c = metas.get(cid);
      if (!c || !stats.has(cid)) add('I8', m.gid, `series "${m.title}" lists chapter ${cid}, which doesn't exist`);
      else if (c.parentId !== m.gid) add('I8', m.gid, `series "${m.title}" lists chapter ${cid}, which points at ${c.parentId || 'no series'}`);
      else if (isSeries(c)) add('I8', cid, `chapter ${cid} of "${m.title}" is itself a series`);
    }
  }

  // I9 — sort keys (index cursors skip records missing them).
  for (const g of snap.galleries) {
    const missing = SORT_KEYS.filter(k => !isKey(g[k]));
    if (missing.length) add('I9', g.gid, `missing ${missing.join(', ')}`);
  }

  // I10 / I11 — derived per-gallery numbers.
  for (const g of snap.galleries) {
    const actual = pagesBy.get(g.gid)?.length || 0;
    if (g.count !== actual) add('I10', g.gid, `count ${g.count}, stored pages ${actual}`);
    const size = snap.exportSizes[g.gid];
    if (size && (g.size !== size.total || g.origSize !== size.original)) {
      add('I11', g.gid, `size ${g.size}/${g.origSize}, export archive ${size.total}/${size.original}`);
    }
  }

  // I12 — series totals; and no stale totals on what isn't a series.
  for (const g of snap.galleries) {
    const m = metas.get(g.gid);
    if (!isSeries(m)) {
      if (g.chapterCount != null || g.aggPages != null || g.aggSize != null) add('I12', g.gid, 'series totals on a gallery that is not a series');
      continue;
    }
    let pages = 0, size = 0;
    for (const cid of m.chapters) { const s = stats.get(cid); if (s) { pages += s.count || 0; size += s.size || 0; } }
    if (g.chapterCount !== m.chapters.length || g.aggPages !== pages || g.aggSize !== size) {
      add('I12', g.gid, `chapters ${g.chapterCount}/${m.chapters.length}, pages ${g.aggPages}/${pages}, size ${g.aggSize}/${size}`);
    }
  }

  // I13 / I14 — pages are numbered; a gallery with pages has real metadata.
  for (const [gid, pages] of pagesBy) {
    const unnumbered = pages.filter(p => p.pageNum == null).length;
    if (unnumbered) add('I13', gid, `${unnumbered} page(s) without a readable page number`);
    const nums = pages.map(p => p.pageNum).filter(n => n != null);
    const dupes = nums.length - new Set(nums).size;
    if (dupes) add('I13', gid, `${dupes} page number(s) stored twice`);
    if (metas.get(gid)?.isStub) add('I14', gid, `${pages.length} page(s) under placeholder metadata`);
  }

  const summary = {};
  for (const v of violations) summary[v.id] = (summary[v.id] || 0) + 1;
  return {
    totals: { metadata: snap.metas.length, galleries: snap.galleries.length, pages: snap.pages.length, covers: snap.covers.length, images: snap.images.length },
    errors: violations.filter(v => v.severity === 'error').length,
    warnings: violations.filter(v => v.severity === 'warning').length,
    summary,
    violations,
  };
}

export async function checkLibrary() {
  return checkInvariants(await api.maintenance.integritySnapshot());
}

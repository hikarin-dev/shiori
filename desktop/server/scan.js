// scan.js — the library folders and the index agreeing again: the full check, run only when asked
// (Settings → Storage), once for an index with no galleries, and for a folder just added to the
// library (its galleries join it) — the app otherwise opens files only when it needs them. Each
// folder is checked on its own; one that can't be reached (a drive away) is left as it is. Files may be changed outside the app: a gallery whose folder or archive moved
// or was renamed is found by the id its metadata.json carries; one whose files are gone is marked
// missing (never deleted); a folder or archive the index doesn't know is added — rebuilt from its
// descriptions when it is in the Shiori gallery format (gallery-files.js; the index can be rebuilt
// from the files, a folder's translations and study layers picked up where they lie), or as a new
// gallery of its pictures when it was put there by hand (an archive in the gallery format — one the
// app archived — rebuilt alike, from what it holds). Leftovers of an interrupted write
// (temporary files and folders, staged pages, cache files and pictures nothing refers to) go.
//
// A known path costs one existence check; only files the index doesn't know are opened.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { readDirectory, readEntry } from './zip.js';
import { files as layout, linked as linkedSource } from './shared.js';
import { descriptionStampOf } from './files.js';
import { linkRoot, adoptLinked } from './linked.js';

const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const typeOf = (name) => TYPE_OF_EXT[String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase()] || '';
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const numberOf = (name) => { const m = String(name).match(/(?:^|\/)(\d+)(?:-[0-9a-z]+)?\.\w+$/i); return m ? parseInt(m[1], 10) : null; };
const MAX_DEPTH = 6;
// A moment for the app's process to answer its windows, every so many galleries.
const breathe = () => new Promise((resolve) => setImmediate(resolve));
const CHUNK = 20;
// The folders of the gallery format a gallery's pictures made from its pages live in.
const DERIVED = ['translated', 'study/bg', 'study/text', 'pipeline', 'covers'];

// Every gallery in the library folder: { found: [{ rel, format, layout?, entries? }], files }. A
// folder in the gallery format (metadata.json, image_records.json or images/) is a gallery, as is a
// folder of pictures an earlier version described (shiori.json), and every archive (one not in the
// gallery format becomes a linked gallery: linked.js); any other folder — a series' folder among
// them, or one of pictures put there some other way — is walked, its pictures and PDFs listed in
// `files` ([{ path }] in the folder: linked galleries too). `skip`: the folders of galleries the
// index knows are there (paths in the folder), not looked into; `onTop(found)` after each thing at
// the folder's top; the walk ends once `stopped()`.
async function findGalleries(root, { skip = new Set(), onTop = () => {}, stopped = () => false } = {}) {
  const found = [], files = [];
  const walk = async (dir, depth) => {
    const here = path.relative(root, dir).split(path.sep).join('/');
    if (stopped() || (dir !== root && skip.has(here))) return;
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const rel = (name) => path.relative(root, path.join(dir, name)).split(path.sep).join('/');
    if (dir !== root) {
      if (items.some(i => (i.isFile() && (i.name === 'metadata.json' || i.name === 'image_records.json')) || (i.isDirectory() && i.name === 'images'))) {
        found.push({ rel: here, format: 'folder', layout: true });
        return;
      }
      const images = items.filter(i => i.isFile() && IMAGE.test(i.name));
      if (images.length && items.some(i => i.name === 'shiori.json')) {
        found.push({ rel: here, format: 'folder', entries: images.map(i => i.name).sort(natural.compare), hasDescription: true });
        return;
      }
    }
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === '__MACOSX' || /\.shiori-(tmp|old|new)$/.test(item.name)) continue;
      if (item.isFile() && /\.(cbz|zip)$/i.test(item.name)) found.push({ rel: rel(item.name), format: /\.cbz$/i.test(item.name) ? 'cbz' : 'zip' });
      else if (item.isFile() && (IMAGE.test(item.name) || linkedSource.PDF_NAME.test(item.name))) files.push({ path: rel(item.name) });
      else if (item.isDirectory() && depth < MAX_DEPTH) await walk(path.join(dir, item.name), depth + 1);
      if (depth === 0) onTop(found.length);
    }
  };
  await walk(root, 0);
  return { found, files };
}

// A found gallery's description — { id, meta, pages: [{ n, file, key, mediaId, cachedAt, record }] }
// from its metadata.json and image_records.json (an earlier version's shiori.json, too), or null —
// its page files ([{ name, size }], in reading order), and, for an archive in the gallery format,
// what it holds beside its pages (`derived`, as readDerived reads a folder's).
async function readGallery(g) {
  const abs = g.abs;
  if (g.format === 'folder' && g.layout) {
    const text = (name) => fsp.readFile(path.join(abs, name), 'utf8').catch(() => null);
    const names = (await fsp.readdir(path.join(abs, 'images')).catch(() => [])).filter(n => IMAGE.test(n)).sort(natural.compare);
    const pages = await Promise.all(names.map(async (name) => ({ name: `images/${name}`, size: (await fsp.stat(path.join(abs, 'images', name))).size })));
    return { described: describedBy(parse(await text('metadata.json')), parse(await text('image_records.json')), pages), pages };
  }
  if (g.format === 'folder') {
    const described = g.hasDescription ? parse(await fsp.readFile(path.join(abs, 'shiori.json'), 'utf8').catch(() => null)) : null;
    const pages = await Promise.all(g.entries.map(async (name) => ({ name, size: (await fsp.stat(path.join(abs, name))).size })));
    return { described, pages };
  }
  const dir = await readDirectory(abs);
  const json = async (name) => (dir.get(name) ? parse(String(await readEntry(abs, dir.get(name)))) : null);
  if (dir.has('metadata.json') || dir.has('image_records.json')) {
    const pages = [...dir].filter(([n]) => /^images\//.test(n) && IMAGE.test(n)).sort(([a], [b]) => natural.compare(a, b))
      .map(([name, e]) => ({ name, size: e.size }));
    const files = new Map();
    for (const [name, e] of dir) {
      if (IMAGE.test(name) && DERIVED.includes(name.slice(0, name.lastIndexOf('/')))) files.set(name, { size: e.size, type: typeOf(name) });
    }
    return { described: describedBy(await json('metadata.json'), await json('image_records.json'), pages), pages,
      derived: derivedOf(files, await json('study/bubbles.json'), await json('covers/manifest.json')) };
  }
  const pages = [...dir].filter(([n]) => IMAGE.test(n) && !n.startsWith('__MACOSX/')).sort(([a], [b]) => natural.compare(a, b))
    .map(([name, e]) => ({ name, size: e.size }));
  return { described: await json('shiori.json'), pages };
}

// A description from the gallery format's metadata.json and image_records.json: each page's record
// joined to its file by page number.
function describedBy(meta, records, pages) {
  if (!meta && !Array.isArray(records)) return null;
  const byNumber = new Map((Array.isArray(records) ? records : []).map(r => [numberOf(r?.url), r]).filter(([n]) => n != null));
  return {
    id: meta?.galleryId != null ? String(meta.galleryId) : null,
    meta,
    pages: pages.map(({ name }) => {
      const n = numberOf(name);
      const r = byNumber.get(n);
      return { n, file: name, key: r?.url, mediaId: r?.mediaId, cachedAt: r?.cachedAt, record: r };
    }),
  };
}

// Bring the index and the library folder into agreement. Resolves { moved, missing, found, added,
// removed, stopped } (gallery ids, and how many leftover files went).
// `roots`: the library folders to check (their ids; by default every one shown that the library may
// write to — not one another app took over). The folders are gone
// through one thing at their top at a time — `onProgress(done, total, added)` after each — and the
// walk ends once `stopped()`: what it found so far joins the library, and nothing is marked missing
// (the rest wasn't looked at).
export async function scanLibrary(library, { roots = library.activeRoots(), onProgress = () => {}, stopped = () => false } = {}) {
  const out = { moved: [], missing: [], found: [], added: [], updated: [], removed: 0, stopped: false };
  const files = library.files;
  const reachable = [];
  for (const id of roots) if (await fsp.stat(library.rootDir(id)).then(st => st.isDirectory(), () => false)) reachable.push(id);
  const checked = new Set(reachable);
  const known = library._s('SELECT * FROM files').all().filter(r => checked.has(files._split(r.path).root));
  const byPath = new Map(known.map(r => [r.path, r]));
  const exists = (rel) => fsp.access(files._abs(rel)).then(() => true, () => false);

  // Leftovers of interrupted writes.
  for (const id of reachable) {
    for (const g of await findLeftovers(library.rootDir(id))) { await fsp.rm(g, { recursive: true, force: true }).catch(() => {}); out.removed++; }
  }

  const present = new Set();
  // A linked gallery is there while its source is (its overlay alone doesn't make it so).
  const sourceThere = (row) => !row.source || fsp.access(files._sourceAbs(row)).then(() => true, () => false);
  for (const row of known) if (await exists(row.path) && await sourceThere(row)) present.add(row.gid);
  const kept = known.filter(r => present.has(r.gid) && r.format === 'folder');
  const tops = await Promise.all(reachable.map(async (id) => (await fsp.readdir(library.rootDir(id)).catch(() => []))
    .filter(n => !n.startsWith('.') && !/\.shiori-(tmp|old|new)$/.test(n)).length));
  // Its steps, each counted on its own: what the folders hold, the galleries joining, and those it
  // keeps checked for changes.
  let total = tops.reduce((a, b) => a + b, 0), done = 0, step = 'lf.task_checking';
  const begin = (next, n) => { step = next; total = n; done = 0; onProgress(0, total, out.added.length, step); };
  const tick = () => onProgress(Math.min(++done, total), total, out.added.length, step);
  onProgress(0, total, 0, step);
  const galleries = [];
  const loose = new Map();   // a library folder → its pictures and PDFs outside the galleries (linked.js)
  for (const id of reachable) {
    const root = library.rootDir(id);
    const skip = new Set(known.filter(r => present.has(r.gid) && files._split(r.path).root === id).map(r => files._split(r.path).rest));
    const base = galleries.length;
    const onTop = (n) => onProgress(Math.min(++done, total), total, base + n, step);
    const walked = await findGalleries(root, { skip, onTop, stopped });
    for (const g of walked.found) galleries.push({ ...g, abs: path.join(root, ...g.rel.split('/')), rel: files._join(id, g.rel), root: id, inRoot: g.rel });
    loose.set(id, walked.files);
  }
  out.stopped = !!stopped();
  const unknown = galleries.filter(g => !byPath.has(g.rel) || !present.has(byPath.get(g.rel).gid));
  const byId = new Map();
  for (const g of unknown) {
    try { g.read = await readGallery(g); } catch { continue; }
    const id = g.read.described?.id;
    if (id && !byId.has(String(id))) byId.set(String(id), g);
  }
  // What a folder or archive in the gallery format holds beside its pages, read before the index changes.
  for (const g of unknown) {
    if (g.read) g.derived = g.read.derived ?? (g.layout ? await readDerived(g.abs) : undefined);
  }

  // An archive not in the gallery format (put there some other way) is a linked gallery's (linked.js).
  const plain = (g) => g.format !== 'folder' && !g.read?.described;
  const changed = new Set();
  library._tx(() => {
    for (const row of known) {
      if (present.has(row.gid)) {
        if (row.state === 'missing') { setState(library, row.gid, 'packed'); out.found.push(row.gid); changed.add(row.gid); }
        continue;
      }
      const moved = byId.get(row.gid);
      if (moved && moved.format === row.format) {
        library._s(`UPDATE files SET path = ?, state = 'packed' WHERE gid = ?`).run(moved.rel, row.gid);
        byId.delete(row.gid);
        moved.claimed = true;
        out.moved.push(row.gid);
        changed.add(row.gid);
      } else if (row.state !== 'missing' && !out.stopped) {
        setState(library, row.gid, 'missing');
        out.missing.push(row.gid);
        changed.add(row.gid);
      }
    }
  });
  // The galleries found, joined a few at a time (each few one transaction), the windows answered between.
  // (One with no pages joins too when its folder describes it: a series' record, a chapter not
  // downloaded — written there as its folder left a library.)
  const joining = unknown.filter(g => !g.claimed && g.read && (g.read.pages.length || (g.layout && g.read.described?.meta)) && !plain(g));
  const linking = reachable.map(id => ({ id, archives: unknown.filter(g => g.root === id && g.read && plain(g)).map(g => g.inRoot) }));
  begin('lf.task_adding', joining.length);
  for (let at = 0; at < joining.length && !stopped(); at += CHUNK) {
    const made = [];
    library._tx(() => {
      for (const g of joining.slice(at, at + CHUNK)) {
        const id = g.read.described?.id ? String(g.read.described.id) : null;
        if (id && library._s('SELECT 1 FROM files WHERE gid = ?').get(id)) continue;   // a copy of a gallery the library has
        const gid = id && /^\d{13,}$/.test(id) && !library._metaGet(id) ? id : library.nextGalleryId();
        addGallery(library, gid, g);
        made.push([gid, g]);
      }
    });
    for (const [gid, g] of made) {
      await library.rebuildGalleryEntry(gid, { silent: true });
      if (g.derived?.cover) library._tx(() => library._coverPatchIn(gid, { cover: g.derived.cover }));
      out.added.push(gid);
      changed.add(gid);
      tick();
    }
    await breathe();
  }
  // What each library folder holds that Shiori didn't make: linked galleries (linked.js).
  for (const { id, archives } of linking) {
    if (stopped()) { out.stopped = true; break; }
    const r = await linkRoot(library, id, { files: loose.get(id) || [], archives, stopped,
      onProgress: (d, n, s, added) => onProgress(d, n, out.added.length + added, s) });
    out.added.push(...r.added);
    out.updated.push(...r.updated);
    for (const gid of [...r.added, ...r.updated]) changed.add(gid);
  }
  // Then the galleries it keeps whose descriptions another app changed since: read again.
  begin('lf.task_comparing', kept.length);
  for (const row of kept) {
    if (stopped()) { out.stopped = true; break; }
    try { if (await refreshGallery(library, row)) { out.updated.push(row.gid); changed.add(row.gid); } } catch {}
    tick();
    if (done % CHUNK === 0) await breathe();
  }
  library._tidyLinks(out.updated);
  for (const gid of changed) library.publishFeed(gid);
  out.removed += await removeOrphans(library);
  library.files.resume();   // galleries found again settle what waited for them
  return out;
}

// Gallery `row` (a folder the index keeps) read again from its folder when its descriptions there
// changed since the library last wrote or read them — another app wrote to the folder — unless it
// has changes of its own still to be written there (they win), or its folder no longer describes it.
// One stamped before stamps existed counts as changed only when its descriptions differ from the
// index's. Resolves whether it was read again.
async function refreshGallery(library, row) {
  const files = library.files;
  const gid = row.gid;
  const busy = () => { const r = files._row(gid); return !r || r.pending || r.unpack || files._staged(gid).length > 0; };
  if (busy()) return false;
  const abs = files._abs(row.path);
  const texts = {};
  for (const name of layout.DESCRIPTION_FILES) texts[name] = await fsp.readFile(path.join(abs, ...name.split('/')), 'utf8').catch(() => null);
  if (texts['metadata.json'] == null || String(parse(texts['metadata.json'])?.galleryId ?? '') !== gid) return false;
  const stamp = layout.descriptionStamp(texts);
  const had = library._s('SELECT stamp FROM stamps WHERE gid = ?').get(gid)?.stamp;
  if (stamp === had) return false;
  if (!had && descriptionStampOf(files._descriptions(gid)) === stamp) {
    library._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(gid, stamp);
    return false;
  }
  const src = files.sourceOf(row);
  if (src) return !!(await adoptLinked(library, files._split(row.path).root, src, { replace: gid }).catch(() => null));
  const g = { abs, rel: row.path, format: 'folder', layout: true };
  g.read = await readGallery(g);
  if (!g.read.pages.length && !g.read.described?.meta) return false;
  g.derived = await readDerived(abs);
  if (busy()) return false;   // changed here meanwhile: its own changes win
  library._tx(() => {
    files.keep.add(gid);
    try { library._deleteIn(gid); } finally { files.keep.delete(gid); }
    addGallery(library, gid, g);
    library._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(gid, stamp);
  });
  await library.rebuildGalleryEntry(gid, { silent: true });
  if (g.derived.cover) library._tx(() => library._coverPatchIn(gid, { cover: g.derived.cover }));
  library._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
  return true;
}

function setState(library, gid, state) {
  library._s('UPDATE files SET state = ? WHERE gid = ?').run(state, gid);
  library._logIn(gid);
}

// The pictures a folder in the gallery format holds beside its pages, and its study index:
// { files: Map rel → { size, type }, bubbles, cover }.
export async function readDerived(abs) {
  const files = new Map();
  for (const sub of DERIVED) {
    for (const name of await fsp.readdir(path.join(abs, ...sub.split('/'))).catch(() => [])) {
      if (!IMAGE.test(name)) continue;
      const size = (await fsp.stat(path.join(abs, ...sub.split('/'), name)).catch(() => null))?.size;
      if (size != null) files.set(`${sub}/${name}`, { size, type: typeOf(name) });
    }
  }
  const bubbles = parse(await fsp.readFile(path.join(abs, 'study', 'bubbles.json'), 'utf8').catch(() => null));
  const manifest = parse(await fsp.readFile(path.join(abs, 'covers', 'manifest.json'), 'utf8').catch(() => null));
  return derivedOf(files, bubbles, manifest);
}
function derivedOf(files, bubbles, manifest) {
  const coverFile = (manifest?.covers || []).find(c => c?.role === 'gallery')?.file;
  const cover = coverFile && files.has(coverFile) ? { $own: coverFile, ...files.get(coverFile) } : null;
  return { files, bubbles: bubbles || {}, cover };
}

// A page's record fields made from it, as a folder in the gallery format holds them: its translated
// picture, study layers and pipeline data, referenced where they lie.
export function derivedRecord(derived, n, entry) {
  const out = {};
  const num = String(n).padStart(4, '0');
  const own = (rel) => (derived.files.has(rel) ? { $own: rel, ...derived.files.get(rel) } : null);
  const find = (prefix) => [...derived.files.keys()].find(rel => rel.startsWith(prefix) && /^\.\w+$/.test(rel.slice(prefix.length)));
  const translated = find(`translated/${num}`);
  if (translated) out.translated = own(translated);
  const study = derived.bubbles[num];
  const bubbles = Array.isArray(study) ? study : study?.bubbles;
  if (Array.isArray(bubbles) && bubbles.length) {
    out.bubbles = bubbles.filter(b => b?.box).map((b) => {
      const { textFile, ...rest } = b;
      return { ...rest, region: b.region || b.box, tr: b.tr || '', src: b.src || '', text: textFile ? own(`study/text/${textFile}`) : null };
    });
    const bg = find(`study/bg/${num}`);
    out.studyBg = bg ? own(bg) : null;
    out.studyPage = Array.isArray(study) ? null : (study.page || null);
  }
  if (entry?.pipeline && typeof entry.pipeline === 'object' && typeof entry.pipeline.job === 'string') {
    const masks = {};
    for (const name of ['raw', 'text']) { const rel = find(`pipeline/${num}-${name}`); if (rel) masks[name] = own(rel); }
    out.pipeline = { ...entry.pipeline, masks };
    if (typeof entry.own === 'string') out.own = entry.own;
  }
  if (entry?.translatedLayers === true && out.bubbles) out.translatedLayers = true;
  return out;
}

// A gallery the index didn't have, from its files: its own metadata and page keys when it describes
// itself (and, for a folder in the gallery format, what was made from its pages), else a new
// gallery named after its folder or file.
function addGallery(library, gid, g) {
  const { described, pages } = g.read;
  g.addedAs = gid;
  const listed = new Map((described?.pages || []).map(p => [p.file, p]));
  const stem = g.rel.split('/').pop().replace(/\.(cbz|zip)$/i, '');
  const meta = described?.meta
    ? { ...described.meta, galleryId: gid }
    : { galleryId: gid, title: { english: stem, japanese: '', pretty: stem }, tags: [], numPages: pages.length, isLocalImport: true };
  library._metaPutRaw(meta);
  const now = Date.now();
  // One with no pages has its entry from the start (its pages, as they come, keep it up to date).
  if (!pages.length) library._statPut({ galleryId: gid, count: 0, size: 0, latestAt: now, addedAt: Number(gid) || now,
    uploadDate: Number(meta.uploadDate) || 0, ...(meta.parentId ? { parentId: String(meta.parentId) } : {}) });
  pages.forEach(({ name, size }, i) => {
    const p = listed.get(name);
    const n = p?.n ?? i + 1;
    const ext = name.match(/\.(\w+)$/)[1].toLowerCase();
    const key = p?.key && /\/(\d+)\.\w+$/.test(p.key) ? p.key : `local://${gid}/${n}.${ext}`;
    if (library._pageRowByKey(key) || library._pageRow(gid, n)) return;
    const type = typeOf(name);
    const made = g.derived ? derivedRecord(g.derived, n, p?.record) : {};
    library._pagePutRow({ gid, n, key, w: null, h: null, orig: { at: 'p', entry: name, size, type },
      record: { url: key, blob: { $orig: 1, size, type }, mediaId: String(p?.mediaId ?? gid), galleryId: gid, cachedAt: p?.cachedAt || now, size, ...made } });
  });
  library._s(`INSERT INTO files (gid, path, format, state, packed_at, used_at) VALUES (?, ?, ?, 'packed', ?, ?)`).run(gid, g.rel, g.format, now, now);
  library._logIn(gid);
}

async function findLeftovers(root) {
  const out = [];
  const walk = async (dir, depth) => {
    for (const item of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('.')) continue;
      const abs = path.join(dir, item.name);
      if (/\.shiori-(tmp|old|new)$/.test(item.name)) out.push(abs);
      else if (item.isDirectory() && depth < MAX_DEPTH) await walk(abs, depth + 1);
    }
  };
  await walk(root, 0);
  return out;
}

// Staged pages, cache files and a gallery folder's pictures no record refers to (a write that failed
// half way, or the app closed in the middle of one). A file written in the last few minutes is
// spared: its write may still be on its way to committing.
const ORPHAN_AGE_MS = 10 * 60 * 1000;
async function removeOrphans(library) {
  const staged = new Set(), cached = new Set();
  for (const r of library._s('SELECT orig, record FROM pages').all()) {
    const orig = parse(r.orig);
    if (orig?.at === 's') staged.add(orig.file);
    collect(parse(r.record), cached);
  }
  for (const r of library._s('SELECT record FROM covers').all()) collect(parse(r.record), cached);
  for (const r of library._s('SELECT file FROM staged_own').all()) staged.add(r.file);   // pictures waiting for their archive
  let removed = 0;
  const stale = async (file) => {
    const stat = await fsp.stat(file).catch(() => null);
    return !!stat && Date.now() - stat.mtimeMs >= ORPHAN_AGE_MS;
  };
  // Each library folder's staging names its files as library.js _stagedName does (a hidden one's is
  // left alone: what its galleries set aside refer to may wait there; so is one another app took
  // over). Staged pages of galleries this library doesn't have are another app's, left alone too.
  const places = [...library.activeRoots().map(id => [library._stagingOf(id), staged, (name) => library.files._join(id, name)]),
    [library.cacheDir, cached, (name) => name]];
  for (const [dir, keep, named] of places) {
    for (const gid of await fsp.readdir(dir).catch(() => [])) {
      if (dir !== library.cacheDir && !library._s('SELECT 1 FROM stats WHERE gid = ?').get(gid)) continue;
      for (const name of await fsp.readdir(path.join(dir, gid)).catch(() => [])) {
        if (keep.has(named(`${gid}/${name}`))) continue;
        const file = path.join(dir, gid, name);
        if (!await stale(file)) continue;
        await fsp.rm(file, { force: true }).catch(() => {});
        removed++;
      }
      fsp.rmdir(path.join(dir, gid)).catch(() => {});
    }
  }
  // Pictures in a gallery's folder made from its pages that no record refers to.
  for (const { gid } of library._s(`SELECT gid FROM files WHERE format = 'folder' AND gid NOT IN (SELECT gid FROM unmounted)`).all()) {
    if (!library.folders.writable(library.files.rootFor(gid))) continue;   // another app's folder, or out of reach
    const dir = library.files.folderOf(gid);
    const keep = new Set();
    for (const r of library._s('SELECT record FROM pages WHERE gid = ?').all(gid)) collect(parse(r.record), keep, '$own');
    collect(library._coverGet(gid), keep, '$own');
    for (const sub of DERIVED) {
      for (const name of await fsp.readdir(path.join(dir, ...sub.split('/'))).catch(() => [])) {
        const rel = `${sub}/${name}`;
        if (!IMAGE.test(name) || keep.has(rel) || !await stale(path.join(dir, ...rel.split('/')))) continue;
        await fsp.rm(path.join(dir, ...rel.split('/')), { force: true }).catch(() => {});
        removed++;
      }
    }
  }
  return removed;
}

// The `key` references (cache files by default, or a gallery's own files) in a value.
function collect(value, into, key = '$file') {
  if (value == null || typeof value !== 'object') return;
  if (typeof value[key] === 'string') { into.add(value[key]); return; }
  for (const v of Array.isArray(value) ? value : Object.values(value)) collect(v, into, key);
}

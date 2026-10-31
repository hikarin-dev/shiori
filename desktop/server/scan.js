// scan.js — the library folders and the index agreeing again: the full check, run only when asked
// (Settings → Storage), once for an index with no galleries, and for a folder just added to the
// library (its galleries join it) — the app otherwise opens files only when it needs them. Each
// folder is checked on its own; one that can't be reached (a drive away) is left as it is. Files may
// be changed outside the app: a gallery whose folder or archive moved or was renamed — within its
// library folder or into another — is found by the id its description carries; one whose files are
// gone is marked missing (never deleted); one the index doesn't know joins it.
//
// What a folder or archive is, is told by its descriptions only (folder-content.js, the rule both apps
// share), never by its names: Shiori's own — a gallery in the gallery format (gallery-files.js: its
// index rebuilt from its files, its translations and study layers picked up where they lie), an
// earlier version's described folder of pictures, a native archive, a series export — or not, and
// then linked (linked.js): read where it lies, never written. Shiori writes, tidies and deletes only
// in its own. Galleries it keeps whose descriptions another app changed since are read again (their
// own changes not yet written win: localChanges). Leftovers of an interrupted write (temporary files,
// staged pages, cache files and pictures nothing refers to) go, once old enough that no write under
// way can be making them. What can't be read or joined is reported (`problems`), never passed over
// in silence.
//
// A known path costs one existence check (and its descriptions, to catch up); only files the index
// doesn't know are opened.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { readDirectory, readEntry } from './zip.js';
import { files as layout, linked as linkedSource, content } from './shared.js';
import { descriptionStampOf, writeFlushed } from './files.js';
import { linkRoot, adoptLinked } from './linked.js';

const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const typeOf = (name) => TYPE_OF_EXT[String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase()] || '';
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const MAX_DEPTH = 6;
// A moment for the app's process to answer its windows, every so many galleries.
const breathe = () => new Promise((resolve) => setImmediate(resolve));
const CHUNK = 20;
// The folders of the gallery format a gallery's pictures made from its pages live in.
const DERIVED = ['translated', 'study/bg', 'study/text', 'pipeline', 'covers'];
// The temporary files and folders the app writes beside what they become: `<name>.shiori-tmp` (a
// file replaced whole, a gallery moved, unpacked or archived), `<name>.<hex>.shiori-new` (a picture
// written beside its folder's), and -old.
const TEMP = /\.shiori-(tmp|old|new)$/;
// How old a temporary file must be before a check takes it for a leftover: a write still under way (a
// large gallery copied to another drive, an archive written) keeps changing its own.
const LEFTOVER_AGE_MS = 60 * 60 * 1000;
// How old a staged page, cache file or picture nothing refers to must be before it goes: its write may
// still be on its way to committing.
const ORPHAN_AGE_MS = 10 * 60 * 1000;
const stale = async (file, age) => {
  const stat = await fsp.stat(file).catch(() => null);
  return !!stat && Date.now() - stat.mtimeMs >= age;
};
// Why a file couldn't be read, for `problems`: the disk wouldn't ('unreadable'), or what it holds isn't
// what it should be ('corrupt').
const unreadable = (e) => (e?.syscall ? 'unreadable' : 'corrupt');

// Whether gallery `gid` has changes of its own not yet written to its folder or overlay — pages or
// pictures staged, descriptions pending, an archive to unpack or being written, a settle or a
// description under way — or no files at all: reading it again from its files would lose them, so it
// isn't (the rule every re-read keeps, re-checked as it commits: "local changes win").
export function localChanges(library, gid) {
  const files = library.files;
  const id = String(gid);
  const row = files._row(id);
  return !row || !!row.pending || !!row.unpack || row.tail != null || files._staged(id).length > 0 || files._stagedOwn(id).length > 0
    || files._placing.has(id) || files._describing.has(id) || files._writing.has(id);
}

// What a folder of a library folder is (folder-content.js classifyFolder), from the descriptions it
// holds (`items`: its entries).
async function classifyAt(dir, items) {
  const texts = {};
  for (const name of content.OWN_FILES) {
    if (items.some(i => i.isFile() && i.name === name)) texts[name] = await fsp.readFile(path.join(dir, name), 'utf8').catch(() => null);
  }
  return content.classifyFolder(texts);
}

// Every gallery of Shiori's own in library folder `root`, and what else it holds: { found: [{ rel,
// format, layout?, entries? }], files, own }. A folder its description says is a gallery's is one
// (`layout`: in the gallery format; else an earlier version's folder of pictures, `entries` its
// pictures), and is not looked into; every archive is found, to be read (readGallery); a series' folder
// and any other folder are walked, their pictures and PDFs listed in `files` ([{ path }] in the folder:
// linked galleries), `own` the paths of the galleries found. `skip`: the folders of galleries the index
// knows are there (paths in the folder), not looked into; `onTop(found)` after each thing at the
// folder's top; the walk ends once `stopped()`. A folder that can't be listed is added to `problems`.
async function findGalleries(root, { skip = new Set(), onTop = () => {}, stopped = () => false, problems = [] } = {}) {
  const found = [], files = [], own = [];
  const walk = async (dir, depth) => {
    const here = path.relative(root, dir).split(path.sep).join('/');
    if (stopped() || (dir !== root && skip.has(here))) return;
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { problems.push({ path: here, reason: 'unreadable' }); return; }
    const rel = (name) => (here ? `${here}/${name}` : name);
    if (dir !== root) {
      const what = await classifyAt(dir, items);
      if (what.kind === 'gallery') {
        own.push(here);
        found.push(what.legacy
          ? { rel: here, format: 'folder', entries: items.filter(i => i.isFile() && IMAGE.test(i.name)).map(i => i.name).sort(natural.compare) }
          : { rel: here, format: 'folder', layout: true });
        return;
      }
    }
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === '__MACOSX' || TEMP.test(item.name)) continue;
      if (item.isFile() && linkedSource.ARCHIVE_NAME.test(item.name)) found.push({ rel: rel(item.name), format: /\.cbz$/i.test(item.name) ? 'cbz' : 'zip' });
      else if (item.isFile() && (IMAGE.test(item.name) || linkedSource.PDF_NAME.test(item.name))) files.push({ path: rel(item.name) });
      else if (item.isDirectory() && depth < MAX_DEPTH) await walk(path.join(dir, item.name), depth + 1);
      if (depth === 0) onTop(found.length);
    }
  };
  await walk(root, 0);
  return { found, files, own };
}

// A found gallery read: { kind, described, pages, derived?, series?, entries? }. `kind` 'gallery' — its
// description ({ id, meta, pages: [{ n, file, key, mediaId, cachedAt, record }] }, from its
// metadata.json and image_records.json, or an earlier version's shiori.json), its page files ([{ name,
// size }], in reading order) and, for an archive in the gallery format, what it holds beside its pages
// (`derived`, as readDerived reads a folder's); 'series' — a series export (`series`: its series.json,
// folder-content.js seriesOf); 'linked' — an archive that isn't Shiori's (linked.js). An archive's
// `entries`: its directory.
async function readGallery(g) {
  const abs = g.abs;
  if (g.format === 'folder' && g.layout) {
    const text = (name) => fsp.readFile(path.join(abs, name), 'utf8').catch(() => null);
    const records = parse(await text('image_records.json'));
    const names = (await fsp.readdir(path.join(abs, 'images')).catch(() => [])).filter(n => IMAGE.test(n)).map(n => `images/${n}`);
    const pages = await Promise.all([...layout.folderPictures(names, { records }).pages].map(async ([n, name]) =>
      ({ n, name, size: (await fsp.stat(path.join(abs, ...name.split('/')))).size })));
    return { kind: 'gallery', described: describedBy(parse(await text('metadata.json')), records, pages), pages };
  }
  if (g.format === 'folder') {
    const described = parse(await fsp.readFile(path.join(abs, 'shiori.json'), 'utf8').catch(() => null));
    const pages = await Promise.all(g.entries.map(async (name) => ({ name, size: (await fsp.stat(path.join(abs, name))).size })));
    return { kind: 'gallery', described, pages };
  }
  const dir = await readDirectory(abs);
  const texts = {};
  for (const name of content.OWN_FILES) if (dir.has(name)) texts[name] = String(await readEntry(abs, dir.get(name)));
  const what = content.classifyArchive(dir.keys(), texts);
  if (what.kind !== 'gallery') return { kind: what.kind, series: what.series, entries: dir };
  if (what.legacy) {
    const pages = [...dir].filter(([n]) => IMAGE.test(n) && !n.startsWith('__MACOSX/')).sort(([a], [b]) => natural.compare(a, b))
      .map(([name, e]) => ({ name, size: e.size }));
    return { kind: 'gallery', described: parse(texts['shiori.json']), pages, entries: dir };
  }
  const json = async (name) => (dir.get(name) ? parse(String(await readEntry(abs, dir.get(name)))) : null);
  const records = await json('image_records.json');
  const names = [...dir.keys()].filter(n => /^images\/[^/]+$/.test(n) && IMAGE.test(n));
  const pages = [...layout.folderPictures(names, { records }).pages].map(([n, name]) => ({ n, name, size: dir.get(name).size }));
  const files = new Map();
  for (const [name, e] of dir) {
    if (IMAGE.test(name) && DERIVED.includes(name.slice(0, name.lastIndexOf('/')))) files.set(name, { size: e.size, type: typeOf(name) });
  }
  return { kind: 'gallery', described: describedBy(parse(texts['metadata.json']), records, pages), pages,
    derived: derivedOf(files, await json('study/bubbles.json'), await json('covers/manifest.json'), records), entries: dir };
}

// A description from the gallery format's metadata.json and image_records.json: each page's record
// joined to its file by page number (`pages`: its originals' files, each with its number —
// gallery-files.js folderPictures).
function describedBy(meta, records, pages) {
  if (!meta && !Array.isArray(records)) return null;
  const byNumber = new Map((Array.isArray(records) ? records : []).map(r => [layout.pageNumberOf(r?.url), r]).filter(([n]) => n != null));
  return {
    id: meta?.galleryId != null ? String(meta.galleryId) : null,
    meta,
    pages: pages.map(({ n, name }) => {
      const r = byNumber.get(n);
      return { n, file: name, key: r?.url, mediaId: r?.mediaId, cachedAt: r?.cachedAt, record: r };
    }),
  };
}

// A series export (an archive holding a series' folder: its series.json and its chapters' folders, each
// in the gallery format) unpacked beside itself — its entries copied out as they are — into the
// series' folder the library keeps such a series in: the library has no form for a chapter kept
// inside an archive. Resolves the folder's path in the library folder; null when the library has
// every chapter it holds already (a copy of a series it has, left as it is).
async function unpackSeries(library, g) {
  const files = library.files;
  const chapters = g.read.series.chapters.filter(c => c.present);
  if (chapters.every(c => files._row(c.id))) return null;
  library.folders.assertWritable(g.root);
  const rel = files._freePath(files._join(g.root, g.inRoot.replace(/\.(cbz|zip)$/i, '')));
  const target = files._abs(rel), temp = `${target}.shiori-tmp`;
  files._reserved.add(rel);
  try {
    await fsp.rm(temp, { recursive: true, force: true });
    for (const [name, entry] of g.read.entries) {
      const file = path.join(temp, ...name.split('/'));
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await writeFlushed(file, await readEntry(g.abs, entry));
      library.writes.add('pages', entry.size);
    }
    library.folders.assertWritable(g.root);
    await fsp.rename(temp, target);
    return files._split(rel).rest;
  } catch (e) {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally { files._reserved.delete(rel); }
}

// Bring the index and the library folders `roots` (their ids; by default every one shown that the
// library may write to — not one another app took over) into agreement. Resolves { moved, missing,
// found, added, updated (gallery ids), removed (how many leftover files went), problems ([{ path,
// reason }]: what couldn't be read or joined, its path in its folder), stopped }. The folders are gone
// through one thing at their top at a time — `onProgress(done, total, added, step)` as it goes — and
// the walk ends once `stopped()`: what it found so far joins the library, and nothing is marked missing
// (the rest wasn't looked at).
export async function scanLibrary(library, { roots = library.activeRoots(), onProgress = () => {}, stopped = () => false } = {}) {
  const out = { moved: [], missing: [], found: [], added: [], updated: [], removed: 0, problems: [], stopped: false };
  const files = library.files;
  const isDir = (abs) => fsp.stat(abs).then(st => st.isDirectory(), () => false);
  const reachable = [];
  for (const id of roots) {
    if (await isDir(library.rootDir(id))) reachable.push(id);
    else out.problems.push({ path: '', reason: 'unreachable' });
  }
  const checked = new Set(reachable);
  const known = library._s('SELECT * FROM files').all().filter(r => checked.has(files._split(r.path).root));
  const byPath = new Map(known.map(r => [r.path, r]));
  const exists = (rel) => fsp.access(files._abs(rel)).then(() => true, () => false);

  // Leftovers of interrupted writes, in the folders the library may write to.
  for (const id of reachable) if (library.folders.writable(id)) out.removed += await sweepLeftovers(library, id);

  const present = new Set();
  // A linked gallery is there while its source is (its overlay alone doesn't make it so).
  const sourceThere = (row) => !row.source || fsp.access(files._sourceAbs(row)).then(() => true, () => false);
  for (const row of known) if (await exists(row.path) && await sourceThere(row)) present.add(row.gid);
  const tops = await Promise.all(reachable.map(async (id) => (await fsp.readdir(library.rootDir(id)).catch(() => []))
    .filter(n => !n.startsWith('.') && !TEMP.test(n)).length));
  // Its steps, each counted on its own: what the folders hold, the galleries joining, and those it
  // keeps checked for changes.
  let total = tops.reduce((a, b) => a + b, 0), done = 0, step = 'lf.task_checking';
  const begin = (next, n) => { step = next; total = n; done = 0; onProgress(0, total, out.added.length, step); };
  const tick = () => onProgress(Math.min(++done, total), total, out.added.length, step);
  onProgress(0, total, 0, step);
  const galleries = [];
  const loose = new Map();   // a library folder → what it holds outside Shiori's own galleries (linked.js)
  const place = (id, g) => ({ ...g, abs: path.join(library.rootDir(id), ...g.rel.split('/')), rel: files._join(id, g.rel), root: id, inRoot: g.rel });
  for (const id of reachable) {
    const skip = new Set(known.filter(r => present.has(r.gid) && files._split(r.path).root === id).map(r => files._split(r.path).rest));
    const base = galleries.length;
    const onTop = (n) => onProgress(Math.min(++done, total), total, base + n, step);
    const walked = await findGalleries(library.rootDir(id), { skip, onTop, stopped, problems: out.problems });
    for (const g of walked.found) galleries.push(place(id, g));
    loose.set(id, { files: walked.files, own: [...walked.own, ...skip] });
  }
  out.stopped = !!stopped();
  const unknown = galleries.filter(g => !byPath.has(g.rel) || !present.has(byPath.get(g.rel).gid));
  for (const g of unknown) {
    try { g.read = await readGallery(g); } catch (e) { out.problems.push({ path: g.inRoot, reason: unreadable(e) }); g.unreadable = true; }
  }
  // A series export joins as its folder would (unpackSeries): its chapters are read from there, and
  // the archive goes once they all joined.
  const exports = [];
  for (const g of unknown.filter(g => g.read?.kind === 'series' && !out.stopped)) {
    try {
      const at = await unpackSeries(library, g);
      if (at == null) continue;
      const missed = [];
      const walked = await findGalleries(path.join(library.rootDir(g.root), ...at.split('/')), { problems: missed });
      out.problems.push(...missed.map(p => ({ ...p, path: p.path ? `${at}/${p.path}` : at })));
      const chapters = walked.found.map(c => place(g.root, { ...c, rel: `${at}/${c.rel}` }));
      for (const c of chapters) c.read = await readGallery(c);
      unknown.push(...chapters);
      exports.push({ archive: g, chapters });
    } catch (e) { out.problems.push({ path: g.inRoot, reason: e?.syscall ? 'unreadable' : 'adopt-failed' }); }
  }
  const byId = new Map();
  for (const g of unknown) {
    const id = g.read?.kind === 'gallery' ? g.read.described?.id : null;
    if (id && !byId.has(String(id))) byId.set(String(id), g);
  }
  // A gallery the index keeps in another library folder (or one not checked now), its files gone from
  // where the index has them — moved there by hand — follows them here: the index takes the path it
  // was found at (its place goes with it). With its files still where they were, this is a copy.
  const handMoved = new Map();
  for (const [id, g] of byId) {
    const row = files._row(id);
    const root = row && files._split(row.path).root;
    if (!row || row.source || row.format !== g.format || checked.has(root) || !library.folders.has(root)) continue;
    if (await isDir(library.rootDir(root)) && !await exists(row.path)) handMoved.set(id, g);
  }
  // What a folder or archive in the gallery format holds beside its pages, read before the index changes.
  for (const g of unknown) {
    if (g.read?.kind === 'gallery') g.derived = g.read.derived ?? (g.layout ? await readDerived(g.abs) : undefined);
  }

  const changed = new Set();
  const moveTo = (gid, g) => {
    library._s(`UPDATE files SET path = ?, state = 'packed' WHERE gid = ?`).run(g.rel, gid);
    library._logIn(gid);
    byId.delete(gid);
    g.claimed = true;
    out.moved.push(gid);
    changed.add(gid);
  };
  library._tx(() => {
    for (const row of known) {
      if (present.has(row.gid)) {
        if (row.state === 'missing') { setState(library, row.gid, 'packed'); out.found.push(row.gid); changed.add(row.gid); }
        continue;
      }
      const moved = byId.get(row.gid);
      if (moved && moved.format === row.format) moveTo(row.gid, moved);
      else if (row.state !== 'missing' && !out.stopped) {
        setState(library, row.gid, 'missing');
        out.missing.push(row.gid);
        changed.add(row.gid);
      }
    }
    for (const [gid, g] of handMoved) moveTo(gid, g);
  });
  // The galleries found, joined a few at a time (each few one transaction), the windows answered between.
  // (One with no pages joins too when its folder describes it: a series' record, a chapter not
  // downloaded — written there as its folder left a library.) One whose id the library has is a copy,
  // left out. One that can't be joined is a problem.
  const joining = unknown.filter(g => !g.claimed && g.read?.kind === 'gallery' && (g.read.pages.length || (g.layout && g.read.described?.meta)));
  const join = (list) => library._tx(() => {
    const made = [];
    for (const g of list) {
      const id = g.read.described?.id ? String(g.read.described.id) : null;
      if (id && files._row(id)) continue;
      const gid = id && /^\d{13,}$/.test(id) && !library._metaGet(id) ? id : library.nextGalleryId();
      addGallery(library, gid, g);
      made.push([gid, g]);
    }
    return made;
  });
  begin('lf.task_adding', joining.length);
  for (let at = 0; at < joining.length && !stopped(); at += CHUNK) {
    const chunk = joining.slice(at, at + CHUNK);
    let made;
    try { made = join(chunk); } catch {
      made = [];
      for (const g of chunk) { try { made.push(...join([g])); } catch { out.problems.push({ path: g.inRoot, reason: 'adopt-failed' }); } }
    }
    for (const [gid, g] of made) {
      await library.rebuildGalleryEntry(gid, { silent: true });
      const covers = coverPatch(g.derived);
      if (Object.keys(covers).length) library._tx(() => library._coverPatchIn(gid, covers));
      out.added.push(gid);
      changed.add(gid);
      tick();
    }
    await breathe();
  }
  // A series export whose chapters all joined (or the library had) goes: its folder holds them now.
  for (const { archive, chapters } of exports) {
    if (chapters.every(c => c.read?.described?.id && files._row(String(c.read.described.id)))) await files._remove(archive.rel);
  }
  // What each library folder holds that Shiori didn't make: linked galleries (linked.js).
  for (const id of reachable) {
    if (stopped()) { out.stopped = true; break; }
    const archives = unknown.filter(g => g.root === id && g.format !== 'folder' && (g.read?.kind === 'linked' || g.unreadable))
      .map(g => ({ path: g.inRoot, entries: g.read?.entries ?? null }));
    const r = await linkRoot(library, id, { ...loose.get(id), archives, problems: out.problems, stopped,
      onProgress: (d, n, s, added) => onProgress(d, n, out.added.length + added, s) });
    out.added.push(...r.added);
    out.updated.push(...r.updated);
    for (const gid of [...r.added, ...r.updated]) changed.add(gid);
  }
  // A linked gallery found again elsewhere isn't missing.
  out.missing = out.missing.filter(gid => !out.updated.includes(gid));
  // Then the galleries it keeps whose descriptions another app changed since: read again.
  const kept = known.filter(r => present.has(r.gid));
  begin('lf.task_comparing', kept.length);
  for (const row of kept) {
    if (stopped()) { out.stopped = true; break; }
    try {
      if (await refreshGallery(library, row)) { out.updated.push(row.gid); changed.add(row.gid); }
    } catch (e) { out.problems.push({ path: files._split(row.path).rest, reason: unreadable(e) }); }
    tick();
    if (done % CHUNK === 0) await breathe();
  }
  library._tidyLinks([...out.added, ...out.updated]);
  for (const gid of changed) library.publishFeed(gid);
  out.removed += await removeOrphans(library);
  library.files.resume();   // galleries found again settle what waited for them
  return out;
}

// The descriptions gallery files `abs` hold (a folder, or an archive in the gallery format): name →
// text (null for one it hasn't), for gallery-files.js descriptionStamp.
async function descriptionsAt(library, abs, format) {
  const texts = {};
  if (format === 'folder') {
    for (const name of layout.DESCRIPTION_FILES) texts[name] = await fsp.readFile(path.join(abs, ...name.split('/')), 'utf8').catch(() => null);
    return texts;
  }
  const dir = await library.files._directory(abs);
  for (const name of layout.DESCRIPTION_FILES) texts[name] = dir.has(name) ? String(await readEntry(abs, dir.get(name))) : null;
  return texts;
}

// Gallery `row` (a folder or archive the index keeps) read again from its files when its descriptions
// there changed since the library last wrote or read them — another app wrote to them — unless it has
// changes of its own still to be written there (they win: localChanges, checked again as the change
// commits), or its files no longer describe it. One stamped before stamps existed counts as changed only
// when its descriptions differ from the index's. Resolves whether it was read again.
async function refreshGallery(library, row) {
  const files = library.files;
  const gid = row.gid;
  if (localChanges(library, gid)) return false;
  const abs = files._abs(row.path);
  const texts = await descriptionsAt(library, abs, row.format);
  if (content.galleryIdOf(texts['metadata.json']) !== gid) return false;
  const stamp = layout.descriptionStamp(texts);
  const had = library._s('SELECT stamp FROM stamps WHERE gid = ?').get(gid)?.stamp;
  if (stamp === had) return false;
  if (!had && descriptionStampOf(files._descriptions(gid)) === stamp) {
    library._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(gid, stamp);
    return false;
  }
  const src = files.sourceOf(row);
  if (src) return !!await adoptLinked(library, files._split(row.path).root, src, { replace: gid, guard: () => localChanges(library, gid) });
  const g = { abs, rel: row.path, format: row.format, layout: row.format === 'folder' };
  g.read = await readGallery(g);
  if (g.read.kind !== 'gallery' || (!g.read.pages.length && !g.read.described?.meta)) return false;
  g.derived = g.read.derived ?? await readDerived(abs);
  let read = false;
  library._tx(() => {
    if (localChanges(library, gid)) return;   // changed here meanwhile: its own changes win
    files.keep.add(gid);
    try { library._deleteIn(gid); } finally { files.keep.delete(gid); }
    addGallery(library, gid, g);
    library._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(gid, stamp);
    read = true;
  });
  if (!read) return false;
  await library.rebuildGalleryEntry(gid, { silent: true });
  const covers = coverPatch(g.derived);
  if (Object.keys(covers).length) library._tx(() => library._coverPatchIn(gid, covers));
  library._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
  return true;
}

function setState(library, gid, state) {
  library._s('UPDATE files SET state = ? WHERE gid = ?').run(state, gid);
  library._logIn(gid);
}

// The pictures a folder in the gallery format holds beside its pages, and its study index:
// { files: Map rel → { size, type }, bubbles, pictures, covers }.
export async function readDerived(abs) {
  const files = new Map();
  for (const sub of DERIVED) {
    for (const name of await fsp.readdir(path.join(abs, ...sub.split('/'))).catch(() => [])) {
      if (!IMAGE.test(name)) continue;
      const size = (await fsp.stat(path.join(abs, ...sub.split('/'), name)).catch(() => null))?.size;
      if (size != null) files.set(`${sub}/${name}`, { size, type: typeOf(name) });
    }
  }
  const json = async (...at) => parse(await fsp.readFile(path.join(abs, ...at), 'utf8').catch(() => null));
  return derivedOf(files, await json('study', 'bubbles.json'), await json('covers', 'manifest.json'), await json('image_records.json'));
}
// `pictures`: which file holds each picture, as its descriptions name them (gallery-files.js
// folderPictures); `covers`: each role its covers/manifest.json names a picture for that is there (the
// gallery's and the series' — R16), as a reference to it.
function derivedOf(files, bubbles, manifest, records) {
  const pictures = layout.folderPictures(files.keys(), { records, manifest });
  const covers = {};
  for (const [role, file] of Object.entries(pictures.covers)) covers[role] = { $own: file, ...files.get(file) };
  return { files, bubbles: bubbles || {}, pictures, covers };
}
// The cover record's fields for the covers `derived` holds — for _coverPatchIn, which gives each role
// it sets a new revision.
export function coverPatch(derived) {
  const patch = {};
  if (derived?.covers?.gallery) patch.cover = derived.covers.gallery;
  if (derived?.covers?.series) patch.seriesCover = derived.covers.series;
  return patch;
}

// A page's record fields made from it, as a folder in the gallery format holds them (`derived`:
// readDerived's): its translated picture, study layers and pipeline data, referenced where they lie
// (gallery-files.js derivedRecord, the website's too).
export const derivedRecord = (derived, n, entry) => layout.derivedRecord(derived.pictures, derived.bubbles, n, entry,
  (rel) => ({ $own: rel, ...derived.files.get(rel) }));

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
  if (!pages.length || meta.parentId) startEntry(library, gid, meta, now);
  pages.forEach(({ n: number, name, size }, i) => {
    const p = listed.get(name);
    const n = p?.n ?? number ?? i + 1;
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

// Gallery `gid`'s entry as it joins the library with metadata `meta`, before its pages are counted
// (rebuildGalleryEntry keeps what it holds): one with no pages has its entry from the start (its pages,
// as they come, keep it up to date), and a series' chapter its link to its series, so that its entry
// and its metadata agree from the start.
export function startEntry(library, gid, meta, now = Date.now()) {
  library._statPut({ galleryId: gid, count: 0, size: 0, latestAt: now, addedAt: Number(gid) || now,
    uploadDate: Number(meta.uploadDate) || 0, ...(meta.parentId ? { parentId: String(meta.parentId) } : {}) });
}

// Temporary files and folders an interrupted write left in library folder `id` (TEMP, its own
// .shiori/ included): gone once they are old enough that no write under way can be making them, and
// not reserved by a move, unpack or archive still running (files.js _reserved) — A19. Resolves how many
// went.
async function sweepLeftovers(library, id) {
  const root = library.rootDir(id);
  let removed = 0;
  const walk = async (dir, depth) => {
    for (const item of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('.') && item.name !== '.shiori') continue;
      const abs = path.join(dir, item.name);
      if (!TEMP.test(item.name)) {
        if (item.isDirectory() && depth < MAX_DEPTH) await walk(abs, depth + 1);
        continue;
      }
      const target = path.relative(root, abs.replace(/(\.[0-9a-f]{8,10})?\.shiori-(tmp|old|new)$/, '')).split(path.sep).join('/');
      if (library.files._reserved.has(library.files._join(id, target)) || !await stale(abs, LEFTOVER_AGE_MS)) continue;
      await fsp.rm(abs, { recursive: true, force: true }).catch(() => {});
      removed++;
    }
  };
  await walk(root, 0);
  return removed;
}

// Whether folder `dir` is gallery `gid`'s own by what it holds — the overlay naming it (source.json),
// for a linked gallery; else its description (folder-content.js) — so that a folder the index took for
// a gallery's on another rule is never tidied (R01).
async function ownedBy(dir, gid, linked) {
  if (linked) return linkedSource.parseSource(await fsp.readFile(path.join(dir, linkedSource.SOURCE_FILE), 'utf8').catch(() => null))?.galleryId === gid;
  const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const what = await classifyAt(dir, items);
  return what.kind === 'gallery' && what.id === gid;
}

// Staged pages, cache files and a gallery folder's pictures no record refers to (a write that failed
// half way, or the app closed in the middle of one): gone once ORPHAN_AGE_MS old. Staging is looked
// through in the library's own (under its data folder) and in each library folder it may write to
// (another's, a hidden one's and one out of reach are left alone: what its galleries set aside may wait
// there); a gallery's pictures only in a folder that is its own by what it holds (ownedBy).
async function removeOrphans(library) {
  const keep = new Set();   // the files records refer to, where they are
  for (const r of library._s('SELECT orig, record FROM pages').all()) {
    const orig = parse(r.orig);
    if (orig?.at === 's') keep.add(library._staged(orig.file));
    collect(parse(r.record), (ref) => keep.add(path.join(library.cacheDir, ref)));
  }
  for (const r of library._s('SELECT record FROM covers').all()) collect(parse(r.record), (ref) => keep.add(path.join(library.cacheDir, ref)));
  for (const r of library._s('SELECT file FROM staged_own').all()) keep.add(library._staged(r.file));   // pictures waiting for their archive
  let removed = 0;
  // Staged pages of galleries this library doesn't have, in a library folder's staging, are another
  // app's: left alone.
  const places = [[library.dataStagingDir, false], [library.cacheDir, false], ...library.activeRoots().map(id => [library._stagingOf(id), true])];
  for (const [dir, shared] of places) {
    for (const gid of await fsp.readdir(dir).catch(() => [])) {
      if (shared && !library._s('SELECT 1 FROM stats WHERE gid = ?').get(gid)) continue;
      for (const name of await fsp.readdir(path.join(dir, gid)).catch(() => [])) {
        const file = path.join(dir, gid, name);
        if (keep.has(file) || !await stale(file, ORPHAN_AGE_MS)) continue;
        await fsp.rm(file, { force: true }).catch(() => {});
        removed++;
      }
      fsp.rmdir(path.join(dir, gid)).catch(() => {});
    }
  }
  // Pictures in a gallery's folder made from its pages that no record refers to.
  for (const { gid, path: rel, source } of library._s(`SELECT gid, path, source FROM files WHERE format = 'folder' AND gid NOT IN (SELECT gid FROM unmounted)`).all()) {
    if (!library.folders.writable(library.files.rootFor(gid))) continue;   // another app's folder, or out of reach
    const dir = library.files._abs(rel);
    if (!await ownedBy(dir, gid, !!source)) continue;
    const refs = new Set();
    for (const r of library._s('SELECT record FROM pages WHERE gid = ?').all(gid)) collect(parse(r.record), (ref) => refs.add(ref), '$own');
    collect(library._coverGet(gid), (ref) => refs.add(ref), '$own');
    for (const sub of DERIVED) {
      for (const name of await fsp.readdir(path.join(dir, ...sub.split('/'))).catch(() => [])) {
        const file = path.join(dir, ...sub.split('/'), name);
        if (!IMAGE.test(name) || refs.has(`${sub}/${name}`) || !await stale(file, ORPHAN_AGE_MS)) continue;
        await fsp.rm(file, { force: true }).catch(() => {});
        removed++;
      }
    }
  }
  return removed;
}

// Each `key` reference (cache files by default, or a gallery's own files) in a value, to `found`.
function collect(value, found, key = '$file') {
  if (value == null || typeof value !== 'object') return;
  if (typeof value[key] === 'string') { found(value[key]); return; }
  for (const v of Array.isArray(value) ? value : Object.values(value)) collect(v, found, key);
}

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
// in its own. Galleries it keeps that another app published anew since are read again (their own
// changes not yet published win: localChanges, and the case is reported). Leftovers of an interrupted
// write (temporary files, staged pages, cache files) go, once old enough that no write under way can
// be making them; pictures nothing refers to in a gallery's folder are reported, never deleted (D16).
// What can't be read or joined is reported (`problems`), never passed over in silence.
//
// A known path costs one existence check (and its descriptions, to catch up); only files the index
// doesn't know are opened.

import { disk, loadGallery, manifestIn, tempBeside, textIn, entriesIn, textsIn, statIn } from './folder-store.js';
import path from 'node:path';
import { readDirectory, readEntry } from './zip.js';
import { files as layout, linked as linkedSource, content, contract, manifest as format, personal } from './shared.js';
import { descriptionStampOf, classifyAt, ownedBy } from './files.js';
import { linkRoot, adoptLinked, removedOf, archiveRemoved } from './linked.js';
const { withoutPersonal } = personal;

const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const typeOf = (name) => TYPE_OF_EXT[String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase()] || '';
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const MAX_DEPTH = 6;
// A moment for the app's process to answer its windows, every so many galleries.
const breathe = () => new Promise((resolve) => setImmediate(resolve));
const CHUNK = 20;
// The temporary files and folders the app writes beside what they become (folder-content.js TEMPORARY):
// `<name>.shiori-tmp` (a file replaced whole; `<name>.<hex>.shiori-tmp`, a gallery moved, unpacked or
// archived), `<name>.<hex>.shiori-new` (a picture written beside its folder's), and -old.
const TEMP = content.TEMPORARY;
// How old a temporary file must be before a check takes it for a leftover: a write still under way (a
// large gallery copied to another drive, an archive written) keeps changing its own.
const LEFTOVER_AGE_MS = 60 * 60 * 1000;
// How old a staged page, cache file or picture nothing refers to must be before it goes: its write may
// still be on its way to committing.
const ORPHAN_AGE_MS = 10 * 60 * 1000;
const stale = async (file, age) => {
  const stat = await disk.stat(file).catch(() => null);
  return !!stat && Date.now() - stat.mtimeMs >= age;
};
// Why a file couldn't be read, for `problems`: it leads out of its library folder ('outside': files.js
// physicallyIn), the disk wouldn't ('unreadable'), or what it holds isn't what it should be ('corrupt').
const unreadable = (e) => (e?.reason ?? (e?.syscall ? 'unreadable' : 'corrupt'));
// A gallery's files read back (gallery-manifest.js readGallery) that can't be taken as they are: its
// manifest or a description damaged ('corrupt', T08), or a file they name not there ('missing-file',
// T09) — thrown with that reason, so the gallery is reported and what the index had of it kept.
function readable(read, at) {
  if (read.kind === 'ok') return read;
  throw Object.assign(new Error(`${at}: ${read.kind === 'corrupt' ? read.detail : `${read.files.join(', ')} not there`}`), { reason: read.kind });
}

// Whether gallery `gid` has changes of its own not yet published in its folder or overlay — pages or
// pictures staged, changes pending, an archive to unpack or being written, a settle or a publication
// under way — or no files at all: reading it again from its files would lose them, so it isn't (the
// rule every re-read keeps, re-checked as it commits: "local changes win").
export function localChanges(library, gid) {
  const files = library.files;
  const id = String(gid);
  const row = files._row(id);
  return !row || !!row.pending || !!row.unpack || row.tail != null || files._staged(id).length > 0 || files._stagedOwn(id).length > 0
    || files._placing.has(id) || files._describing.has(id) || files._writing.has(id);
}

// Every gallery of Shiori's own in library folder `root`, and what else it holds: { found: [{ rel,
// format, id?, layout?, entries? }], files, own }. A folder its description says is a gallery's is one
// (`id` the gallery it names; `layout`: in the gallery format; else an earlier version's folder of
// pictures, `entries` its pictures), and is not looked into — nor found, while it is still as its reservation made it
// (classifyFolder `reserved`: what was to be put in it may never have committed, S12); temporary names
// are passed over (TEMP); every archive is found, to be read (readGallery); a series' folder
// and any other folder are walked, their pictures and PDFs listed in `files` ([{ path }] in the folder:
// linked galleries), `own` the paths of the galleries found. `skip`: the folders and archives of
// galleries the index knows are there, or that wait to be deleted (paths in the folder), not looked
// into; `onTop(found)` after each thing at the folder's top; the walk ends once `stopped()`. A folder that can't be listed, or whose descriptions
// can't be read, is added to `problems` and left as it is (in `own`: never read for a linked gallery);
// `whole`: none was — every folder walked was read.
async function findGalleries(root, { skip = new Set(), onTop = () => {}, stopped = () => false, problems = [] } = {}) {
  const found = [], files = [], own = [];
  const before = problems.length;
  const walk = async (dir, depth) => {
    const here = path.relative(root, dir).split(path.sep).join('/');
    if (stopped() || (dir !== root && skip.has(here))) return;
    let items;
    try { items = await disk.readdir(dir, { withFileTypes: true }); } catch { problems.push({ path: here, reason: 'unreadable' }); return; }
    const rel = (name) => (here ? `${here}/${name}` : name);
    if (dir !== root) {
      let what;
      try { what = await classifyAt(dir, items); } catch { problems.push({ path: here, reason: 'unreadable' }); own.push(here); return; }
      if (what.kind === 'gallery') {
        own.push(here);
        // An earlier version's folder of pictures: they are what it holds, a link among them too — its read
        // refused like every read through one (principle 5), so the gallery is reported, never read without
        // that page (review 7 A2).
        if (!what.reserved) found.push(what.legacy
          ? { rel: here, format: 'folder', id: what.id, entries: items.filter(i => !i.isDirectory() && IMAGE.test(i.name)).map(i => i.name).sort(natural.compare) }
          : { rel: here, format: 'folder', id: what.id, layout: true });
        return;
      }
    }
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === '__MACOSX' || TEMP.test(item.name)) continue;
      if (item.isFile() && skip.has(rel(item.name))) { own.push(rel(item.name)); continue; }
      if (item.isFile() && linkedSource.ARCHIVE_NAME.test(item.name)) found.push({ rel: rel(item.name), format: /\.cbz$/i.test(item.name) ? 'cbz' : 'zip' });
      else if (item.isFile() && (IMAGE.test(item.name) || linkedSource.PDF_NAME.test(item.name))) files.push({ path: rel(item.name) });
      else if (item.isDirectory() && depth < MAX_DEPTH) await walk(path.join(dir, item.name), depth + 1);
      if (depth === 0) onTop(found.length);
    }
  };
  await walk(root, 0);
  return { found, files, own, whole: problems.length === before };
}

// A found gallery read: { kind, described, pages, derived?, series?, entries?, token? }. `kind` 'gallery'
// — its description ({ id, meta, pages: [{ n, file, key, mediaId, cachedAt, record }] }, from its
// metadata.json and image_records.json, or an earlier version's shiori.json), its page files ([{ name,
// size }], in reading order), in the gallery format what it holds beside its pages (`derived`:
// derivedOf) and the token it was read at (gallery-manifest.js: its manifest's generation, or format
// v1's stamp); 'series' — a series export (`series`: its series.json, folder-content.js seriesOf);
// 'linked' — an archive that isn't Shiori's (linked.js). An archive's `entries`: its directory. Rejects
// when any of it can't be read (F06): a gallery read in part would lose what it couldn't see — or is
// damaged, or misses a file it names (`reason` 'corrupt', 'missing-file': readable).
async function readGallery(g) {
  const abs = g.abs;
  if (g.format === 'folder' && g.layout) {
    const { read, files } = await loadGallery(abs);
    return formatRead(readable(read, g.rel), files);
  }
  if (g.format === 'folder') {
    const described = parse(await textIn(path.join(abs, 'shiori.json')));
    const pages = await Promise.all(g.entries.map(async (name) => ({ name, size: (await disk.stat(path.join(abs, name))).size })));
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
  return { ...formatRead(readable(await readArchive(abs, dir), g.rel), archivePictures(dir)), entries: dir };
}
// An archive in the gallery format read back (gallery-manifest.js readGallery over its entries: `dir`,
// its directory).
export const readArchive = (abs, dir) => format.readGallery({ area: '.shiori/', archive: true, files: archivePictures(dir),
  text: async (name) => (dir.has(name) ? String(await readEntry(abs, dir.get(name))) : null) });
// The pictures an archive's directory holds where the gallery format puts them: path → { size }.
function archivePictures(dir) {
  const out = new Map();
  for (const [name, e] of dir) if (IMAGE.test(name) && format.PICTURE_DIRS.includes(name.slice(0, name.lastIndexOf('/')))) out.set(name, { size: e.size });
  return out;
}
// A gallery in the gallery format as readGallery gives it, from its read (`read`, gallery-manifest.js
// readGallery's 'ok') and the picture files it holds (`files`: path → { size, mtime? }).
function formatRead(read, files) {
  const pages = [...read.pictures.pages].map(([n, name]) => ({ n, name, size: files.get(name).size, mtime: files.get(name).mtime }));
  return { kind: 'gallery', described: describedBy(read.meta, read.records, pages), pages, derived: derivedOf(files, read), token: read.token };
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
  const target = files._abs(rel), temp = tempBeside(target);
  files._reserved.add(rel);
  try {
    for (const [name, entry] of g.read.entries) {
      const file = path.join(temp, ...name.split('/'));
      await disk.mkdir(path.dirname(file), { recursive: true });
      await disk.writeFile(file, await readEntry(g.abs, entry));
      library.writes.add('pages', entry.size);
    }
    library.folders.assertWritable(g.root);
    await disk.rename(temp, target);
    return files._split(rel).rest;
  } catch (e) {
    await disk.rm(temp, { recursive: true, force: true }).catch(() => {});
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
  const out = { moved: [], missing: [], found: [], added: [], updated: [], removed: 0, problems: [], unreferenced: [], stopped: false };
  const files = library.files;
  // A folder is checked only where its path holds it (folders.js reach, principle 1): another library
  // folder at its path is never read, nor its galleries adopted (T01) — and, like one out of reach,
  // nothing of the folder's is marked missing meanwhile.
  const reachable = [];
  for (const id of roots) {
    const opened = library.folders.reach(id, 'read', { fresh: true });
    if (opened.status === 'ok') reachable.push(id);
    else out.problems.push({ path: '', reason: opened.status === 'other-library' ? 'other-library' : 'unreachable' });
  }
  const checked = new Set(reachable);
  const known = library._s('SELECT * FROM files').all().filter(r => checked.has(files._split(r.path).root));
  const byPath = new Map(known.map(r => [r.path, r]));

  // Leftovers of interrupted writes, and galleries' folders a deletion let go, in the folders the
  // library may write to. Those still waiting to be deleted aren't looked into (`skip`): never adopted
  // again, whole or half deleted (N2, N4). Nor are those still waiting to retire, a gallery's no more
  // (an archived gallery's old folder: a file whose deletion answered "not found" stays recorded, F9),
  // which go first where they can.
  await files._retire().catch(() => {});
  for (const id of reachable) {
    if (!library.folders.writable(id)) continue;
    out.removed += await sweepLeftovers(library, id);
    await files.applyDeletions({ root: id }).catch(() => {});
  }

  const present = new Set();
  // A gallery is there while its folder or archive names it (files.js _whose, principle 2: one that
  // can't be read now isn't concluded gone) — a folder put at its place by hand is not it: reported, the
  // gallery looked for elsewhere, else missing (T02) — and, a linked one, while its source is (its
  // overlay alone doesn't make it so): gone as the shared rule takes it (statIn), a look that fails
  // leaving it as the index has it.
  const sourceThere = (row) => !row.source || statIn(files._sourceAbs(row)).then(Boolean, () => row.state !== 'missing');
  for (const row of known) {
    const whose = await files._whose(row.path, row.gid);
    if (whose.kind === 'conflict') out.problems.push({ path: files._split(row.path).rest, reason: 'conflict', gid: row.gid });
    if ((whose.kind === 'ok' || whose.kind === 'unreadable') && await sourceThere(row)) present.add(row.gid);
  }
  const tops = await Promise.all(reachable.map(async (id) => (await disk.readdir(library.rootDir(id)).catch(() => []))
    .filter(n => !n.startsWith('.') && !TEMP.test(n)).length));
  // Its steps, each counted on its own: what the folders hold, the galleries joining, and those it
  // keeps checked for changes.
  let total = tops.reduce((a, b) => a + b, 0), done = 0, step = 'lf.task_checking';
  const begin = (next, n) => { step = next; total = n; done = 0; onProgress(0, total, out.added.length, step); };
  const tick = () => onProgress(Math.min(++done, total), total, out.added.length, step);
  onProgress(0, total, 0, step);
  const galleries = [];
  const loose = new Map();   // a library folder → what it holds outside Shiori's own galleries (linked.js)
  // The library folders of which this check couldn't read everything it walked: a folder it couldn't
  // list, a gallery or a removed.json it couldn't read. It concludes nothing there from what it didn't
  // meet (review 6 F6).
  const partial = new Set();
  const place = (id, g) => ({ ...g, abs: path.join(library.rootDir(id), ...g.rel.split('/')), rel: files._join(id, g.rel), root: id, inRoot: g.rel });
  for (const id of reachable) {
    const skip = new Set([...known.filter(r => present.has(r.gid) && files._split(r.path).root === id), ...files.deletingIn(id), ...files.retiringIn(id)]
      .map(r => files._split(r.path ?? r.dir).rest));
    const base = galleries.length;
    const onTop = (n) => onProgress(Math.min(++done, total), total, base + n, step);
    const walked = await findGalleries(library.rootDir(id), { skip, onTop, stopped, problems: out.problems });
    for (const g of walked.found) galleries.push(place(id, g));
    loose.set(id, { files: walked.files, own: [...walked.own, ...skip] });
    if (!walked.whole) partial.add(id);
  }
  out.stopped = !!stopped();
  const unknown = galleries.filter(g => !byPath.has(g.rel) || !present.has(byPath.get(g.rel).gid));
  for (const g of unknown) {
    try { g.read = await readGallery(g); } catch (e) { out.problems.push({ path: g.inRoot, reason: unreadable(e) }); g.unreadable = true; partial.add(g.root); }
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
      if (!walked.whole) partial.add(g.root);
      const chapters = walked.found.map(c => place(g.root, { ...c, rel: `${at}/${c.rel}` }));
      for (const c of chapters) c.read = await readGallery(c);
      unknown.push(...chapters);
      exports.push({ archive: g, chapters });
    } catch (e) { out.problems.push({ path: g.inRoot, reason: e?.syscall ? 'unreadable' : 'adopt-failed' }); partial.add(g.root); }
  }
  // An archive its folder's removed.json notes as removed — left whole for the person's files in it by a
  // deletion, or by the other app's unpack (S10's F6, D17) — is theirs: no gallery's place (files.js
  // _whose: review 6 F7), never joined, followed, nor taken for a copy. Nor, while removed.json can't be
  // read now (reported), is any archive naming a gallery, till a check reads it (review 6 F4).
  const removed = new Map();
  for (const g of unknown.filter(g => g.format !== 'folder' && g.read?.kind === 'gallery')) {
    if (!removed.has(g.root)) {
      removed.set(g.root, await removedOf(library, g.root).catch(() => { out.problems.push({ path: linkedSource.REMOVED_FILE, reason: 'unreadable' }); partial.add(g.root); return null; }));
    }
    const notes = removed.get(g.root);
    if (!notes || await archiveRemoved(library, g.root, g.inRoot, notes)) g.claimed = true;
  }
  const byId = new Map();
  for (const g of unknown.filter(g => !g.claimed)) {
    const id = g.read?.kind === 'gallery' ? g.read.described?.id : null;
    if (id && !byId.has(String(id))) byId.set(String(id), g);
  }
  // A gallery the index keeps in another library folder (or one not checked now), its files gone from
  // where the index has them — moved there by hand — follows them here: the index takes the path it
  // was found at (its place goes with it). Gone as the shared rule takes it (files.js _whose): a look
  // there that fails, or answers "not found" while that folder's drive is away for a moment, concludes
  // nothing (review 6 F8). With its files still where they were, this is a copy.
  const handMoved = new Map();
  for (const [id, g] of byId) {
    const row = files._row(id);
    const root = row && files._split(row.path).root;
    if (!row || row.source || row.format !== g.format || checked.has(root) || !library.folders.has(root)) continue;
    if (library.folders.reach(root).status === 'ok' && (await files._whose(row.path, id)).kind === 'missing') handMoved.set(id, g);
  }

  const changed = new Set();
  const reread = [];
  const moveTo = (gid, g) => {
    library._s(`UPDATE files SET path = ?, state = 'packed' WHERE gid = ?`).run(g.rel, gid);
    library._logIn(gid);
    byId.delete(gid);
    g.claimed = true;
    out.moved.push(gid);
    changed.add(gid);
  };
  // An archived gallery whose archive is gone, found as a folder naming it — the website's first change
  // unpacks an archive into a folder beside it, then deletes the archive (plan D17), perhaps while it
  // had the folder taken over — follows it there (F5, S10): read again from the folder, its generation
  // caught up; or, with changes of its own still to publish (localChanges: they win, D4), taken there as
  // it is, to publish them in the folder.
  const unpackedTo = (row, g) => {
    const gid = row.gid;
    if (localChanges(library, gid)) {
      library._s(`UPDATE files SET path = ?, format = 'folder', state = 'packed', tail = NULL, unpack = 0 WHERE gid = ?`).run(g.rel, gid);
      library._logIn(gid);
    } else {
      files.keep.add(gid);
      try { library._deleteIn(gid); } finally { files.keep.delete(gid); }
      addGallery(library, gid, g);
      reread.push([gid, g]);
    }
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
      else if (moved && moved.format === 'folder' && !row.source) unpackedTo(row, moved);
      else if (row.state !== 'missing' && !out.stopped) {
        setState(library, row.gid, 'missing');
        out.missing.push(row.gid);
        changed.add(row.gid);
      }
    }
    for (const [gid, g] of handMoved) moveTo(gid, g);
  });
  for (const [gid, g] of reread) {
    await library.rebuildGalleryEntry(gid, { silent: true });
    const covers = coverPatch(g.read.derived);
    if (Object.keys(covers).length) library._tx(() => library._coverPatchIn(gid, covers));
    library._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
  }
  // A gallery deleted while its folder or archive wasn't where the index had it (renamed or moved by
  // hand, or unpacked by the other app: D17): deleted where it is found, never adopted (F4, S10) — its
  // deletion `met`, kept until it is done (files.js _deleteOne: at the other kind of place, by its
  // manifest). A folder that couldn't be read whole is found by the gallery its descriptions name (as the
  // deletion tells it, principle 2): what a deletion met there left part way is deleted at the next check
  // (F6). A copy of a gallery the library keeps in the same folder (its place still naming it) is
  // reported, and left (O3) — not the old folder of a gallery archived since, retiring.
  const unfound = new Map(files._deletingRows().filter(d => d.unfound).map(d => [String(d.gid), d]));
  const met = new Set();
  for (const g of unknown.filter(g => !g.claimed && (g.read?.kind === 'gallery' || g.unreadable))) {
    const id = g.read ? (g.read.described?.id ? String(g.read.described.id) : null) : g.id ?? null;
    const row = id && files._row(id);
    if (!row && unfound.has(id)) {
      g.claimed = true;
      const d = unfound.get(id);
      met.add(d.dir);
      await files.deletedFound(d, g.rel, null, g.format === 'folder');
    } else if (g.read && row && present.has(id) && files._split(row.path).root === g.root
      && !library._s('SELECT 1 FROM retiring WHERE dir = ? LIMIT 1').get(g.rel)) {
      out.problems.push({ path: g.inRoot, reason: 'duplicate', gid: id });
    }
  }
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
      const covers = coverPatch(g.read.derived);
      if (Object.keys(covers).length) library._tx(() => library._coverPatchIn(gid, covers));
      // One in the desktop's oldest format brought to the gallery format once it is in the library whole:
      // a conversion cut short (a failed call, a kill) is picked up by the next check (review 6 F12).
      if (g.format === 'folder' && !g.layout) await files.toFormat(gid).catch(() => out.problems.push({ path: g.inRoot, reason: 'unreadable' }));
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
  // A linked gallery read again from its source (linked.js) isn't missing.
  out.missing = out.missing.filter(gid => !out.updated.includes(gid));
  // Then the galleries it keeps whose descriptions another app changed since: read again.
  const kept = known.filter(r => present.has(r.gid));
  begin('lf.task_comparing', kept.length);
  for (const row of kept) {
    if (stopped()) { out.stopped = true; break; }
    try {
      if (files._legacy(row.gid)) await files.toFormat(row.gid);
      if (await refreshGallery(library, row, out.problems)) { out.updated.push(row.gid); changed.add(row.gid); }
    } catch (e) { out.problems.push({ path: files._split(row.path).rest, reason: unreadable(e) }); }
    tick();
    if (done % CHUNK === 0) await breathe();
  }
  // A deletion whose gallery's folder the check didn't meet is forgotten (F4) — not when it was stopped,
  // nor in a folder it couldn't read whole (review 6 F6).
  if (!out.stopped) for (const id of reachable) if (!partial.has(id)) files.forgetUnfound(id, met);
  library._tidyLinks([...out.added, ...out.updated]);
  for (const gid of changed) library.publishFeed(gid);
  out.removed += await removeOrphans(library, out.unreferenced, checked);
  library.files.resume();   // galleries found again settle what waited for them
  return out;
}

// Deletions waiting `unfound` in library folder `root` (their gallery's folder or archive wasn't where the
// index had it: F4) finished before the folder is let go (folders.js, its removal): its galleries looked
// for as a check finds them, one naming such a gallery deleted where it is (`work` as files.js
// deletedFound) — once the folder is forgotten, nothing would keep the next library adding it from
// adopting it again. Then, as a check's end, those it didn't meet are forgotten only when it read all of
// the folder (review 6 F6); what is still recorded is owed, and the removal refused while it is.
export async function finishUnfound(library, root, work) {
  const files = library.files;
  const unfound = new Map(files._deletingRows(root).filter(d => d.unfound).map(d => [String(d.gid), d]));
  if (!unfound.size || library.folders.reach(root, 'read', { fresh: true }).status !== 'ok') return;
  const walked = await findGalleries(library.rootDir(root), { problems: [] });
  let whole = walked.whole;
  const met = new Set();
  for (const f of walked.found) {
    if (f.id != null && files._row(String(f.id))) continue;   // one the library has: never a deleted gallery's, as in a check
    const g = { ...f, abs: path.join(library.rootDir(root), ...f.rel.split('/')), rel: files._join(root, f.rel), root, inRoot: f.rel };
    const read = await readGallery(g).catch(() => { whole = false; return null; });
    const id = read ? (read.kind === 'gallery' && read.described?.id ? String(read.described.id) : null) : f.id ?? null;
    const d = id && !files._row(id) && unfound.get(id);
    if (d) { met.add(d.dir); await files.deletedFound(d, g.rel, work, g.format === 'folder'); }
  }
  if (whole) files.forgetUnfound(root, met);
}

// The token gallery files  were last published at (a folder, or an archive in the gallery format:
// gallery-manifest.js tokenOf its manifest) and the gallery it names — or, format v1, its descriptions'
// stamp and the gallery its metadata.json names: { token, id }. Rejects when one can't be read, or the
// manifest is damaged (`reason` 'corrupt').
async function tokenAt(library, abs, rowFormat, gid) {
  let manifest, texts = {};
  if (rowFormat === 'folder') {
    manifest = await manifestIn(abs, gid);
    if (manifest.kind === 'unreadable') throw Object.assign(new Error(manifest.error), { reason: 'unreadable' });
    if (manifest.kind === 'missing') texts = await textsIn(abs, (await entriesIn(abs)) ?? [], layout.DESCRIPTION_FILES);
  } else {
    const dir = await library.files._directory(abs);
    const at = dir.get(content.MANIFEST_FILE);
    manifest = at ? format.parseManifest(String(await readEntry(abs, at)), { galleryId: gid, archive: true }) : contract.MISSING;
    if (!at) for (const name of layout.DESCRIPTION_FILES) texts[name] = dir.has(name) ? String(await readEntry(abs, dir.get(name))) : null;
  }
  if (manifest.kind === 'corrupt') throw Object.assign(new Error(manifest.detail), { reason: 'corrupt' });
  if (manifest.kind === 'ok') return { token: format.tokenOf(manifest.value), id: manifest.value.galleryId, texts: null };
  return { token: layout.descriptionStamp(texts), id: content.galleryIdOf(texts['metadata.json']), texts };
}

// Gallery `row` (a folder or archive the index keeps) read again from its files when what they were
// published at there changed since the library last published or read them (D4: another app
// published a generation of it) — unless it has changes of its own still to be published there: they
// win (localChanges, checked again as the change commits), and the case is reported (`changed-both`:
// pushed to `problems`). One whose files no longer name it is left. A v1 folder stamped before stamps
// existed counts as changed only when its descriptions differ from the index's. Resolves whether it was
// read again; rejects, its records and token as they were, when any of its files can't be read (F06),
// is damaged (T08) or misses a file it names (T09).
async function refreshGallery(library, row, problems = []) {
  const files = library.files;
  const gid = row.gid;
  const busy = () => files._placing.has(gid) || files._describing.has(gid) || files._writing.has(gid);
  if (busy()) return false;
  const abs = files._abs(row.path);
  const at = await tokenAt(library, abs, row.format, gid);
  if (at.id !== gid) return false;
  const had = library._s('SELECT stamp FROM stamps WHERE gid = ?').get(gid)?.stamp;
  if (at.token === had) return false;
  if (!had && at.texts && descriptionStampOf(files._descriptions(gid)) === at.token) {
    library._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(gid, at.token);
    return false;
  }
  if (localChanges(library, gid)) {
    if (had && !busy()) problems.push({ path: files._split(row.path).rest, reason: 'changed-both' });
    return false;
  }
  const src = files.sourceOf(row);
  if (src) return !!await adoptLinked(library, files._split(row.path).root, src, { replace: gid, guard: () => localChanges(library, gid) });
  const g = { abs, rel: row.path, format: row.format, layout: row.format === 'folder' };
  g.read = await readGallery(g);
  if (g.read.kind !== 'gallery' || (!g.read.pages.length && !g.read.described?.meta)) return false;
  let read = false;
  library._tx(() => {
    if (localChanges(library, gid)) return;   // changed here meanwhile: its own changes win
    files.keep.add(gid);
    try { library._deleteIn(gid); } finally { files.keep.delete(gid); }
    addGallery(library, gid, g);
    read = true;
  });
  if (!read) return false;
  await library.rebuildGalleryEntry(gid, { silent: true });
  const covers = coverPatch(g.read.derived);
  if (Object.keys(covers).length) library._tx(() => library._coverPatchIn(gid, covers));
  library._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
  return true;
}

function setState(library, gid, state) {
  library._s('UPDATE files SET state = ? WHERE gid = ?').run(state, gid);
  library._logIn(gid);
}

// What a gallery in the gallery format holds beside its pages, from its read (`read`, gallery-manifest.js
// readGallery's 'ok') and the picture files it holds (`files`: path → { size, mtime? }): { files: Map
// rel → { size, type, mtime? }, bubbles, pictures — which file holds each picture, as its manifest (or,
// v1, its descriptions) names them — covers: each role named that is there (the gallery's and the
// series' — R16), as a reference to it }.
export function derivedOf(files, read) {
  const typed = new Map([...files].map(([rel, f]) => [rel, { size: f.size, type: typeOf(rel), ...(f.mtime ? { mtime: f.mtime } : {}) }]));
  const covers = {};
  for (const [role, file] of Object.entries(read.pictures.covers)) if (typed.has(file)) covers[role] = { $own: file, ...typed.get(file) };
  return { files: typed, bubbles: read.bubbles || {}, pictures: read.pictures, covers };
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
// derivedOf's): its translated picture, study layers and pipeline data, referenced where they lie
// (gallery-files.js derivedRecord, the website's too).
export const derivedRecord = (derived, n, entry) => layout.derivedRecord(derived.pictures, derived.bubbles, n, entry,
  (rel) => ({ $own: rel, ...derived.files.get(rel) }));

// A gallery the index didn't have, from its files: its own metadata and page keys when it describes
// itself (and, for a folder in the gallery format, what was made from its pages), else a new
// gallery named after its folder or file. A description an earlier version wrote may carry the
// person's favorite (storage/personal.js): taken into this library's marks as the gallery joins, and
// the description published again without it.
function addGallery(library, gid, g) {
  const { described, pages } = g.read;
  g.addedAs = gid;
  const listed = new Map((described?.pages || []).map(p => [p.file, p]));
  const stem = g.rel.split('/').pop().replace(/\.(cbz|zip)$/i, '');
  const meta = described?.meta
    ? { ...described.meta, galleryId: gid }
    : { galleryId: gid, title: { english: stem, japanese: '', pretty: stem }, tags: [], numPages: pages.length, isLocalImport: true };
  library._metaPutRaw(meta);
  library._importMarks(gid, meta);
  const now = Date.now();
  if (!pages.length || meta.parentId) startEntry(library, gid, meta, now);
  pages.forEach(({ n: number, name, size }, i) => {
    const p = listed.get(name);
    const n = p?.n ?? number ?? i + 1;
    const ext = name.match(/\.(\w+)$/)[1].toLowerCase();
    const key = p?.key && /\/(\d+)\.\w+$/.test(p.key) ? p.key : `local://${gid}/${n}.${ext}`;
    if (library._pageRowByKey(key) || library._pageRow(gid, n)) return;
    const type = typeOf(name);
    const made = g.read.derived ? derivedRecord(g.read.derived, n, p?.record) : {};
    const mtime = g.read.derived?.files.get(name)?.mtime;
    library._pagePutRow({ gid, n, key, w: null, h: null, orig: { at: 'p', entry: name, size, type, ...(mtime ? { mtime } : {}) },
      record: { url: key, blob: { $orig: 1, size, type }, mediaId: String(p?.mediaId ?? gid), galleryId: gid, cachedAt: p?.cachedAt || now, size, ...made } });
  });
  library._s(`INSERT INTO files (gid, path, format, state, packed_at, used_at) VALUES (?, ?, ?, 'packed', ?, ?)`).run(gid, g.rel, g.format, now, now);
  if (g.read.token) library._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(gid, g.read.token);   // what it was read at (D4)
  if (withoutPersonal(meta) !== meta) library.files.describeLater(gid);
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

// Temporary files and folders an interrupted write left in library folder `id` (TEMP): gone once they
// are old enough that no write under way can be making them, and not reserved by a move, unpack or
// archive still running (files.js _reserved) — A19 — nor a picture still to take its place (files.js
// unplaced: F03). Looked for only where everything is Shiori's (F08): the folder's own .shiori/ (its
// staging and overlays), and the folders of the galleries the index keeps there whose description names
// them (ownedBy: each walked from the listing that told it so). A name alone proves nothing: a file or
// folder named so in a linked folder, at the folder's top or anywhere else, is someone's own, and stays —
// as does a whole gallery's interrupted copy beside its place, which neither app's walk reads and no later
// write takes a name from (folder-store.js tempBeside). Resolves how many went.
async function sweepLeftovers(library, id) {
  const root = library.rootDir(id);
  const files = library.files;
  let removed = 0;
  const walk = async (dir, depth, listed = null) => {
    for (const item of listed ?? await disk.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (item.name.startsWith('.')) continue;
      const abs = path.join(dir, item.name);
      if (!TEMP.test(item.name)) {
        if (item.isDirectory() && depth < MAX_DEPTH) await walk(abs, depth + 1);
        continue;
      }
      const target = path.relative(root, abs.replace(/(\.[0-9a-f]{8,10})?\.shiori-(tmp|old|new)$/, '')).split(path.sep).join('/');
      if (files._reserved.has(files._join(id, target)) || !await stale(abs, LEFTOVER_AGE_MS)) continue;
      await disk.rm(abs, { recursive: true, force: true }).catch(() => {});
      removed++;
    }
  };
  await walk(path.join(root, '.shiori'), 0);
  for (const { gid, path: rel } of library._s(`SELECT gid, path FROM files WHERE format = 'folder' AND source IS NULL`).all()) {
    const items = files._split(rel).root === id ? await ownedBy(files._abs(rel), gid) : null;
    if (items) await walk(files._abs(rel), 0, items);
  }
  return removed;
}

// Staged pages and cache files no record refers to (a write that failed half way, or the app closed in
// the middle of one): gone once ORPHAN_AGE_MS old — staging is looked through in the library's own
// (under its data folder) and in each library folder it may write to (another's, a hidden one's and one
// out of reach are left alone: what its galleries set aside may wait there). A gallery's pictures no
// record refers to, in a folder that is its own by what it holds (ownedBy) in one of the library
// folders checked (`checked`, their ids), are added to `unreferenced` ({ path, gid }): its picture
// folders are listed where the listing that told it so shows them (one it doesn't show holds none).
// Resolves how many went.
async function removeOrphans(library, unreferenced = [], checked = new Set()) {
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
    for (const gid of await disk.readdir(dir).catch(() => [])) {
      if (shared && !library._s('SELECT 1 FROM stats WHERE gid = ?').get(gid)) continue;
      for (const name of await disk.readdir(path.join(dir, gid)).catch(() => [])) {
        const file = path.join(dir, gid, name);
        if (keep.has(file) || !await stale(file, ORPHAN_AGE_MS)) continue;
        await disk.rm(file, { force: true }).catch(() => {});
        removed++;
      }
      disk.rmdir(path.join(dir, gid)).catch(() => {});
    }
  }
  // Pictures in a gallery's folder that no record refers to and that aren't waiting to retire: reported
  // (`unreferenced`: what a write cut short left, or a file put there by hand), never deleted — Shiori
  // deletes only what its index recorded writing (D16, principle 4).
  for (const { gid, path: rel } of library._s(`SELECT gid, path FROM files WHERE format = 'folder' AND gid NOT IN (SELECT gid FROM unmounted)`).all()) {
    if (!checked.has(library.files._split(rel).root) || !library.folders.writable(library.files.rootFor(gid))) continue;   // another app's folder, or out of reach
    const dir = library.files._abs(rel);
    const items = await ownedBy(dir, gid);
    if (!items) continue;
    const refs = new Set(library._s('SELECT name FROM retiring WHERE dir = ?').all(rel).map(r => r.name));
    for (const r of library._pageRows(gid)) {
      collect(parse(r.record), (ref) => refs.add(ref), '$own');
      const orig = parse(r.orig);
      if (orig?.at === 'p') refs.add(orig.entry);
    }
    collect(library._coverGet(gid), (ref) => refs.add(ref), '$own');
    for (const sub of format.PICTURE_DIRS) {
      if (!items.some(e => e.name === sub.split('/')[0] && e.isDirectory())) continue;
      for (const name of await disk.readdir(path.join(dir, ...sub.split('/'))).catch(() => [])) {
        const file = path.join(dir, ...sub.split('/'), name);
        if (!IMAGE.test(name) || refs.has(`${sub}/${name}`) || !await stale(file, ORPHAN_AGE_MS)) continue;
        unreferenced.push({ path: `${library.files._split(rel).rest}/${sub}/${name}`, gid });
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

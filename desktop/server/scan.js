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
import { files as layout, linked as linkedSource, content, contract, manifest as format, personal, lifecycle } from './shared.js';
import { descriptionStampOf, classifyAt, ownedBy } from './files.js';
import { linkRoot, adoptLinked, removedOf, archiveRemoved, removedChapters } from './linked.js';
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
// How long a hand-over's read waits for work under way on a gallery (a settle, a publication: refused at the
// folder's gate meanwhile, so they end at once) before it reads it.
const BUSY_WAIT_MS = 30_000;
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
// rule every re-read keeps, re-checked as it commits) — unless another app published the gallery there
// since: then the folder's version stands, and they are dropped (folderStands: one app changes a
// folder's galleries at a time).
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
// `whole`: none was — every folder walked was read (folder-lifecycle.js leavesOpen).
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
  return { found, files, own, whole: !problems.slice(before).some(lifecycle.leavesOpen) };
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
    // (A folder an archiving let go that another app published into since — `over` — is read as that publication
    // names it, a picture the retirement cut short took among it: `missing`, reported. S32, review 9 A3.)
    const { read, files, missing } = await loadGallery(abs, { missing: !!g.over });
    if (missing) g.missing = missing;
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
// inside an archive. A chapter its folder's removed.json notes as removed (`removed(folder)`: the website,
// which reads an export in place, deleted it there, or unpacked it into a folder of its own — review 7
// A5) is left out, never joining again. Resolves the folder's path in the library folder; null when the
// library has every other chapter it holds already (a copy of a series it has, left as it is).
async function unpackSeries(library, g, removed) {
  const files = library.files;
  const left = g.read.series.chapters.filter(c => removed(c.folder)).map(c => `${c.folder}/`);
  const chapters = g.read.series.chapters.filter(c => c.present && !left.includes(`${c.folder}/`));
  if (chapters.every(c => files._row(c.id))) return null;
  library.folders.assertWritable(g.root);
  const rel = files._freePath(files._join(g.root, g.inRoot.replace(/\.(cbz|zip)$/i, '')));
  const target = files._abs(rel), temp = tempBeside(target);
  files._reserved.add(rel);
  try {
    for (const [name, entry] of g.read.entries) {
      if (left.some(at => name.startsWith(at))) continue;
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
// (the rest wasn't looked at). `handover` (S32: the folder came (back) to this library — folders.js
// _readBack): the check's reading alone — every gallery the index keeps there read against its place (none
// passed over as busy: what waits for it weighed as its place is held, files.js hold), what the folder holds
// walked, followed and joined in the index — and nothing written or deleted in the folder (none of the work
// left over from before: retirements, leftover sweeps, deletions owed, the settling of what waited; nor a
// series export unpacked, a linked title's overlay made, an earlier format converted: the check after it does
// those). `joined`: galleries that read joined a moment ago, as this check would have (another place of one
// beside it isn't reported as a copy yet).
export async function scanLibrary(library, { roots = library.activeRoots(), onProgress = () => {}, stopped = () => false, handover = false, joined = new Set() } = {}) {
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
  if (!handover) await files._retire().catch(() => {});
  for (const id of reachable) {
    if (handover || !library.folders.writable(id)) continue;
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
  // list, an archive, a series export or a removed.json it couldn't read. It concludes nothing there from
  // what it didn't meet (review 6 F6) — but a gallery's folder whose description named its gallery as
  // the walk found it, and whatever it read and found damaged, are no deleted gallery's (review 7 A1).
  const partial = new Set();
  const place = (id, g) => ({ ...g, abs: path.join(library.rootDir(id), ...g.rel.split('/')), rel: files._join(id, g.rel), root: id, inRoot: g.rel });
  // A folder an archiving let go that another app published its gallery into since (files.js _retiredOver: S32, review
  // 9 A3) is no leftover: it is looked into as any folder naming that gallery, and the later publication stands.
  const overAt = new Map();   // gid → that folder (a path as `files` has them)
  for (const id of reachable) for (const [dir, gid] of files.retiredOver(id)) overAt.set(gid, dir);
  const overDirs = new Set(overAt.values());
  for (const id of reachable) {
    const skip = new Set([...known.filter(r => present.has(r.gid) && files._split(r.path).root === id), ...files.deletingIn(id), ...files.retiringIn(id).filter(r => !overDirs.has(r.dir))]
      .map(r => files._split(r.path ?? r.dir).rest));
    const base = galleries.length;
    const onTop = (n) => onProgress(Math.min(++done, total), total, base + n, step);
    const walked = await findGalleries(library.rootDir(id), { skip, onTop, stopped, problems: out.problems });
    for (const g of walked.found) { const at = place(id, g); if (overDirs.has(at.rel)) at.over = true; galleries.push(at); }
    loose.set(id, { files: walked.files, own: [...walked.own, ...skip] });
    if (!walked.whole) partial.add(id);
  }
  out.stopped = !!stopped();
  const unknown = galleries.filter(g => !byPath.has(g.rel) || !present.has(byPath.get(g.rel).gid));
  for (const g of unknown) {
    try { g.read = await readGallery(g); } catch (e) {
      const problem = { path: g.inRoot, reason: unreadable(e) };
      out.problems.push(problem);
      g.unreadable = true;
      if (g.id == null && lifecycle.leavesOpen(problem)) partial.add(g.root);
    }
  }
  // A folder an archiving let go that another app published its gallery into since (overDirs): the later publication
  // stands (followed below); what of it the retirement cut short took is reported, and the gallery's archive is
  // retired only where it holds no picture the folder's version lacks — else kept beside it (reported as a copy).
  const keepArchive = new Set();
  for (const g of unknown.filter(g => g.over && g.read?.kind === 'gallery')) {
    const id = String(g.read.described?.id ?? '');
    // (Kept on the folder's Needs attention list until dismissed: later checks don't see it again.)
    if (g.missing) library.folders.note(g.root, { reason: 'missing-file', path: g.inRoot, gid: id }, { event: true });
    const row = files._row(id);
    if (!row || row.format === 'folder') continue;
    const dir = await files._directory(files._abs(row.path)).catch(() => null);
    const has = g.read.derived?.files ?? new Map();
    if (!dir || [...archivePictures(dir)].some(([name, e]) => !has.get(name)?.size || has.get(name).size !== e.size)) keepArchive.add(id);
  }
  // Each library folder's removed.json as the check weighs it (linked.js removedOf), read once, when an
  // archive of Shiori's asks: null, reported, while it can't be read now — nothing it may note joins then,
  // till a check reads it (review 6 F4).
  const removed = new Map();
  const removedIn = async (root) => {
    if (!removed.has(root)) {
      removed.set(root, await removedOf(library, root).catch(() => { out.problems.push({ path: linkedSource.REMOVED_FILE, reason: 'unreadable' }); partial.add(root); return null; }));
    }
    return removed.get(root);
  };
  // A series export joins as its folder would (unpackSeries): its chapters are read from there — those
  // its removed.json notes as removed left out (review 7 A5) — and the archive goes once they all joined.
  const exports = [];
  for (const g of unknown.filter(g => g.read?.kind === 'series' && !out.stopped && !handover)) {
    try {
      const notes = await removedIn(g.root);
      if (!notes) continue;
      const at = await unpackSeries(library, g, await removedChapters(library, g.root, g.inRoot, notes));
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
  for (const g of unknown.filter(g => g.format !== 'folder' && g.read?.kind === 'gallery')) {
    const notes = await removedIn(g.root);
    if (!notes || await archiveRemoved(library, g.root, g.inRoot, notes)) g.claimed = true;
  }
  const byId = new Map();
  for (const g of unknown.filter(g => !g.claimed)) {
    const id = g.read?.kind === 'gallery' ? g.read.described?.id : null;
    if (id && !byId.has(String(id))) byId.set(String(id), g);
  }
  // A gallery the index keeps in another library folder (or one not checked now), its files gone from
  // where the index has them — moved there by hand — follows them here: the index takes the path it
  // was found at (its place goes with it). Gone as for a folder checked (`present`: files.js _whose —
  // nothing there as the shared rule takes it, or something that doesn't name it): a look there that
  // fails, or answers "not found" while that folder's drive is away for a moment, concludes nothing
  // (review 6 F8). With its files still where they were, this is a copy — as is one whose folder is out of
  // the library (hidden: nothing of it changes, _mountCheck) until it is shown; both reported.
  const handMoved = new Map();
  for (const [id, g] of byId) {
    const row = files._row(id);
    const root = row && files._split(row.path).root;
    if (!row || row.source || row.format !== g.format || checked.has(root) || !library.folders.has(root) || !lifecycle.mounted(library.folders.state(root))) continue;
    if (library.folders.reach(root).status === 'ok' && !['ok', 'unreadable'].includes((await files._whose(row.path, id)).kind)) handMoved.set(id, g);
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
  // had the folder taken over — follows it there (F5, S10; followTo). So does one whose archive is still
  // there, found as a folder beside it naming it at a later generation (gallery-manifest.js supersedes:
  // an unpack cut short before the archive went — review 7 B6), its archive deleted as an unpack deletes it.
  const followedWaiting = new Set();   // followed with something of it waiting here: its new place held below
  const unpackedTo = (row, g, left = false) => {
    if (followTo(library, row, g, { left })) reread.push(row.gid); else followedWaiting.add(row.gid);
    byId.delete(row.gid);
    g.claimed = true;
    out.moved.push(row.gid);
    changed.add(row.gid);
  };
  library._tx(() => {
    for (const row of known) {
      const beside = byId.get(row.gid);
      if (present.has(row.gid) && row.format !== 'folder' && !row.source && beside?.format === 'folder' && beside.over && overAt.get(row.gid) === beside.rel) {
        unpackedTo(row, beside, !keepArchive.has(row.gid));   // the folder its archiving let go, published into since (S32, review 9 A3)
        continue;
      }
      if (present.has(row.gid) && row.format !== 'folder' && !row.source && beside?.format === 'folder'
        && format.supersedes(beside.read.token, library._s('SELECT stamp FROM stamps WHERE gid = ?').get(row.gid)?.stamp)) { unpackedTo(row, beside, true); continue; }
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
  for (const gid of reread) library._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
  // A gallery deleted while its folder or archive wasn't where the index had it (renamed or moved by
  // hand, or unpacked by the other app: D17): deleted where it is found, never adopted (F4, S10) — its
  // deletion `met`, kept until it is done (files.js _deleteOne: at the other kind of place, by its
  // manifest). A folder that couldn't be read whole is found by the gallery its descriptions name (as the
  // deletion tells it, principle 2): what a deletion met there left part way is deleted at the next check
  // (F6). A copy of a gallery the library keeps (its place still naming it, or not to be told now: in
  // another folder, out of reach or out of the library — not followed above) is reported, and left (O3,
  // review 7 B3) — not the old folder of a gallery archived since, retiring.
  // A hand-over's read (S32) deletes nothing — the check after it does — but weighs every deletion owed that it
  // meets at a place naming its gallery (not only one whose place was gone): its place held as the deletion
  // recorded it (files.js hold, S29a's rule 3), where another app published the gallery there since the deletion
  // is dropped (reported once) and the gallery joins as the folder has it; else the deletion stands, done next.
  const unfound = new Map(files._deletingRows().filter(d => d.unfound || handover).map(d => [String(d.gid), d]));
  const met = new Set();
  for (const g of unknown.filter(g => !g.claimed && (g.read?.kind === 'gallery' || g.unreadable))) {
    const id = g.read ? (g.read.described?.id ? String(g.read.described.id) : null) : g.id ?? null;
    const row = id && files._row(id);
    if (!row && unfound.has(id) && handover) {
      const d = unfound.get(id);
      const whose = await files.hold(d.gid, { rel: g.rel, known: d.stamp ?? null,
        deletion: { epoch: d.epoch ?? null, forget: () => library._s('DELETE FROM deleting WHERE dir = ?').run(d.dir) } });
      if (whose.kind !== 'dropped') { g.claimed = true; if (d.unfound) met.add(d.dir); }
    } else if (!row && unfound.has(id)) {
      g.claimed = true;
      const d = unfound.get(id);
      met.add(d.dir);
      await files.deletedFound(d, g.rel, null, g.format === 'folder');
    } else if (g.read && row && !row.source && (!checked.has(files._split(row.path).root) || present.has(id)) && !joined.has(id)
      && !library._s('SELECT 1 FROM retiring WHERE dir = ? LIMIT 1').get(g.rel)) {
      out.problems.push({ path: g.inRoot, reason: 'duplicate', gid: id });
    }
  }
  // The galleries found, joined a few at a time (each few one transaction), the windows answered between.
  // (One with no pages joins too when its folder describes it: a series' record, a chapter not
  // downloaded — written there as its folder left a library.) One whose id the library has is a copy,
  // left out. One that can't be joined is a problem.
  // Of several places naming one gallery (an unpack cut short leaves its folder beside the archive: review
  // 7 B6), the one at the latest generation joins — a folder over an archive at the same — the others
  // passed over as copies are.
  const candidates = unknown.filter(g => !g.claimed && g.read?.kind === 'gallery' && (g.read.pages.length || (g.layout && g.read.described?.meta)));
  const rank = (g) => format.generationOf(g.read.token) * 2 + (g.format === 'folder' ? 1 : 0);
  const best = new Map();
  for (const g of candidates) {
    const id = g.read.described?.id == null ? null : String(g.read.described.id);
    if (id && (!best.has(id) || rank(g) > rank(best.get(id)))) best.set(id, g);
  }
  const joining = candidates.filter(g => g.read.described?.id == null || best.get(String(g.read.described.id)) === g);
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
      await library.rebuildGalleryEntry(gid, { silent: true, mark: false });
      const covers = coverPatch(g.read.derived);
      if (Object.keys(covers).length) library._tx(() => library._coverPatchIn(gid, covers, { mark: false }));
      // One in the desktop's oldest format brought to the gallery format once it is in the library whole:
      // a conversion cut short (a failed call, a kill) is picked up by the next check (review 6 F12).
      if (g.format === 'folder' && !g.layout && !handover) await files.toFormat(gid).catch(() => out.problems.push({ path: g.inRoot, reason: 'unreadable' }));
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
  // What each library folder holds that Shiori didn't make: linked galleries (linked.js) — joined by the check
  // after a hand-over's read (a new title's overlay is written as it joins).
  for (const id of handover ? [] : reachable) {
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
  // Then the galleries it keeps whose descriptions another app changed since: read again — not one it
  // followed from where it was (unpackedTo: read where it now is), but one followed with something of it
  // waiting here: its new place is held now (refreshGallery, S31), so where that is another app's publication
  // the folder's version stands from this check on, not from the next settle.
  const kept = [...known.filter(r => present.has(r.gid) && !out.moved.includes(r.gid)),
    ...[...followedWaiting].map(gid => files._row(gid)).filter(Boolean)];
  begin('lf.task_comparing', kept.length);
  for (const row of kept) {
    if (stopped()) { out.stopped = true; break; }
    try {
      if (files._legacy(row.gid) && !handover) await files.toFormat(row.gid);
      if (await refreshGallery(library, row, { handover, stopped })) { out.updated.push(row.gid); changed.add(row.gid); }
    } catch (e) { out.problems.push({ path: files._split(row.path).rest, reason: unreadable(e) }); }
    tick();
    if (done % CHUNK === 0) await breathe();
  }
  // A deletion whose gallery's folder the check didn't meet is forgotten (F4) — not when it was stopped;
  // in a folder it couldn't read whole, once a few such checks didn't (review 6 F6, review 7 A1).
  if (!out.stopped && !handover) for (const id of reachable) files.endUnfound(id, met, !partial.has(id));
  // The series links of what joined or was read again tidied — the members of a series read again among them, so a
  // gallery kept whose series no longer lists it (the other app dissolved the series; its own place gone) is kept
  // outside it: listed, and deletable (S32, review 9 B3).
  const tidied = [...out.added, ...out.updated];
  for (const gid of [...tidied]) for (const r of library._s('SELECT gid FROM stats WHERE parent_key = ?').all(String(gid))) tidied.push(String(r.gid));
  library._tidyLinks([...new Set(tidied)]);
  for (const gid of changed) library.publishFeed(gid);
  if (handover) return out;
  out.removed += await removeOrphans(library, out.unreferenced, checked);
  library.files.resume();   // galleries found again settle what waited for them
  return out;
}

// Deletions waiting `unfound` in library folder `root` (their gallery's folder or archive wasn't where the
// index had it: F4) finished before the folder is let go (folders.js, its removal): its galleries looked
// for as a check finds them, one naming such a gallery deleted where it is (`work` as files.js
// deletedFound) — once the folder is forgotten, nothing would keep the next library adding it from
// adopting it again. Then it ends as a check's does (files.js endUnfound: review 6 F6, review 7 A1); what
// is still recorded is owed, and the removal refused while it is.
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
    const read = await readGallery(g).catch((e) => { if (f.id == null && lifecycle.leavesOpen({ reason: unreadable(e) })) whole = false; return null; });
    const id = read ? (read.kind === 'gallery' && read.described?.id ? String(read.described.id) : null) : f.id ?? null;
    const d = id && !files._row(id) && unfound.get(id);
    if (d) { met.add(d.dir); await files.deletedFound(d, g.rel, work, g.format === 'folder'); }
  }
  files.endUnfound(root, met, whole);
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

// Gallery `row` (a folder or archive the index keeps) read again from its files when they hold another
// publication than the one the library last published or read there (D4; a token names one publication:
// gallery-manifest.js tokenOf). With changes of its own waiting to be published there (localChanges), its
// place is held instead (files.js hold): where that publication is another app's, or the library has no
// stamp of it, the folder's version stands — what waited here dropped, the case reported once — and where it
// is this app's own, what waits is published over it, in due course. One whose files no longer name it is
// left. A v1 folder stamped before stamps existed counts as changed only when its descriptions differ from
// the index's. Resolves whether it was read again; rejects, its records and token as they were, when any of
// its files can't be read (F06), is damaged (T08) or misses a file it names (T09). One busy now (a settle,
// a publication, a write of it under way) is weighed at its next look — but a hand-over's read (`handover`,
// S32) waits for that to end and reads it: no gallery of a folder that came back is passed over (review 9 B2) —
// unless the check is stopped meanwhile (`stopped()`: it ends there, S33).
async function refreshGallery(library, row, { handover = false, stopped = () => false } = {}) {
  const files = library.files;
  const gid = row.gid;
  const busy = () => files._placing.has(gid) || files._describing.has(gid) || files._writing.has(gid);
  for (let waited = 0; handover && busy() && !stopped() && waited < BUSY_WAIT_MS; waited += 20) await new Promise((r) => setTimeout(r, 20));
  if (busy() && handover && !stopped()) throw Object.assign(new Error(`${row.path}: still busy`), { reason: 'unreadable' });   // reported, never passed over
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
    if (!waiting(library, gid)) return false;   // under way for it now: weighed at its next look
    const held = await files.hold(gid);
    if (held.damaged) throw Object.assign(new Error(`${row.path}: the publication there is damaged`), { reason: held.damaged });
    return library._s('SELECT stamp FROM stamps WHERE gid = ?').get(gid)?.stamp !== had;
  }
  const src = files.sourceOf(row);
  const again = src ? !!await adoptLinked(library, files._split(row.path).root, src, { replace: gid, guard: () => localChanges(library, gid) })
    : await reread(library, row, { guard: () => localChanges(library, gid), manifest: !at.texts });
  if (again) noteReplaced(library, gid, had);
  return again;
}
// Gallery `gid` read again from its folder: where the stamp it had (`was`) was this library's own publication, and the
// one read now is another writer's at that generation or an earlier one (gallery-manifest.js replacedOwn), this
// library's publication was replaced rather than built on — reported once ('changed-both'), as a change waiting here
// dropped is; the folder's version stands (S33, review 10 B1).
function noteReplaced(library, gid, was) {
  const row = library.files._row(gid);
  if (!row || !format.replacedOwn(library.files._stamp(gid), was, library.folders._me())) return;
  const { root, rest } = library.files._split(row.path);
  library.folders.note(root, { reason: 'changed-both', path: rest, gid: String(gid) }, { event: true });
}

// Gallery `row` read again from its folder or archive, its records replaced by what that holds, in one
// transaction — unless `guard()` says otherwise as it commits — the pictures of its own staged for it
// going with them (files.js deleteIn), and with `drop` (folderStands) its pages staged too, and its own
// files the folder's generation doesn't name, the case noted on the folder's Needs attention list in the
// same transaction. Resolves whether it was; rejects as readGallery does.
async function reread(library, row, { guard = () => false, drop = false, manifest = false } = {}) {
  const files = library.files;
  const gid = row.gid;
  const g = { abs: files._abs(row.path), rel: row.path, format: row.format, layout: row.format === 'folder' };
  g.read = await readGallery(g);
  // A drop — and a re-read a manifest's token asked for (`manifest`) — rests on the folder's version as its
  // manifest names it: never a read by an earlier version's rules, which a "not found" judged once the drive
  // was back from a moment away could have made of nothing. Such a read replaces and drops nothing: it
  // waits for a later look that tells.
  if ((drop || manifest) && !String(g.read.token ?? '').startsWith('v2:')) throw Object.assign(new Error(`${row.path}: the folder's version can't be told now`), { reason: 'unreadable' });
  if (g.read.kind !== 'gallery' || (!g.read.pages.length && !g.read.described?.meta)) return false;
  let read = false;
  library._ownTx(() => {
    if (guard()) return;   // changed here meanwhile: its own changes are weighed again later
    const staged = drop ? files._staged(gid).map(r => JSON.parse(r.orig).file) : [];
    // Its own files in the folder: written there, their time recorded — not a picture still waiting in
    // staging, whose name there may be another's file by now.
    const waiting = new Set(files._stagedOwn(gid).map(s => s.rel));
    const had = drop && row.format === 'folder' ? files._recorded(gid).filter(f => f.mtime && !waiting.has(f.name)) : [];
    files.keep.add(gid);
    try { library._deleteIn(gid); } finally { files.keep.delete(gid); }
    addGallery(library, gid, g);
    for (const file of staged) library._dropStaged(file);
    const named = new Set(files._recorded(gid).map(f => f.name));
    for (const f of had) if (!named.has(f.name)) files._retireIn(row.path, f.name, f, gid);
    if (drop) { const { root, rest } = files._split(row.path); library.folders.note(root, { reason: 'changed-both', path: rest, gid }, { event: true }); }
    entryIn(library, gid, g);
    read = true;
  });
  if (!read) return false;
  library._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
  return true;
}
// Inside the transaction reading gallery `gid` again (`g`: its read): its entry rebuilt and its covers of
// its own put, in the same step — a kill as what it let go is deleted after it commits (staged files) never
// leaves the gallery without an entry, out of every listing for good.
function entryIn(library, gid, g) {
  library.rebuildGalleryEntry(gid, { silent: true, mark: false });   // its transaction runs inside this one
  const covers = coverPatch(g.read.derived);
  if (Object.keys(covers).length) library._coverPatchIn(gid, covers, { mark: false });
}

// The folder's version of gallery `gid` stands: its place holds a publication this library hasn't read —
// another app's, or one where it keeps no stamp (files.js hold: gallery-manifest.js whoseVersion) — and one
// app changes a folder's galleries at a time (the owner's rule, 2026-11-15), so where both changed it (this
// app's change made before the other took the folder over, or while the drive was away) the folder's version
// is what stands. Its records are read again from its folder or archive as that holds it (nothing of it
// written there). What waited here goes with them, in the same transaction: its pending mark and anything an
// archive was to be given, the pages and pictures staged for it (their staging files once that has
// committed), and the files of its own its records named in its folder that the folder's generation doesn't
// (written here, never published), which retire — deleted by name while each is as written (principle 4) —
// reported once ('changed-both', on the folder's Needs attention list). With nothing of it waiting it is only
// read again, nothing reported: nothing was dropped. A linked gallery's overlay is read again alike (linked.js
// adoptLinked). A kill or a failed call leaves it as it was or stood, never in part: the next settle,
// publication or check that meets that publication does it then. Resolves whether it was done; rejects,
// nothing changed, when its place can't be read whole now — `reason` 'corrupt' or 'missing-file' where that
// publication was read and is damaged (no version to stand: files.js _stands).
export async function folderStands(library, gid) {
  const files = library.files;
  const id = String(gid);
  const row = files._row(id);
  if (!row) return false;
  const { root, rest } = files._split(row.path);
  const src = files.sourceOf(row);
  const waits = () => waiting(library, id);
  const drop = waits();
  const was = files._stamp(id);
  // The other galleries one series command changed with it (files.js groupIn), whose change still waits: dropped
  // with its own — a command is weighed as one, never one gallery's part published and another's dropped (S32,
  // review 9 B1).
  const others = drop ? files.groupWaiting(id) : [];
  const stood = src ? !!await adoptLinked(library, root, src, { replace: id, guard: drop ? () => false : waits })
    : await reread(library, row, drop ? { drop: true } : { guard: waits, manifest: true });
  if (!stood) return false;
  if (src && drop) library.folders.note(root, { reason: 'changed-both', path: rest, gid: id }, { event: true });
  if (!drop) noteReplaced(library, id, was);
  if (drop) library._tx(() => files._ungroup(id));
  for (const m of others) await folderStands(library, m).catch(() => false);
  if (drop) await files._letGo(id).catch(() => {});
  return true;
}
// Whether something of gallery `gid` waits here for its folder or archive — a change not published there, an
// unpack, pages or pictures staged, an addition to its archive cut short — whatever is running for it now
// (localChanges counts that too).
function waiting(library, gid) {
  const files = library.files;
  const row = files._row(gid);
  return !!row && (!!row.pending || !!row.unpack || row.tail != null || files._staged(gid).length > 0 || files._stagedOwn(gid).length > 0);
}

// Inside the caller's transaction: archived gallery `row` followed to folder `g` (as a check reads it:
// readGallery) that names it — the unpack of its archive, by the website (D17) or cut short by a kill
// (review 7 B6). With changes of its own still to publish (localChanges), it is taken there as it is, what
// waits with it: following a gallery is apart from reading it again (review 7 B5), and its place is held
// before what waits is written there (files.js hold) — the folder's version standing where it is another
// app's (the other app's unpack is a change of it), what waited dropped then, reported once. Else it is read
// again there. The archive, still there (`left`), is recorded for deletion as this library's own unpack records
// it (files.js _deletingIn: deleted while it is as Shiori wrote it and holds nothing else) — the folder is the
// gallery's now, never a second copy unpacked beside them. Returns whether it was read again.
function followTo(library, row, g, { left = false } = {}) {
  const files = library.files, gid = row.gid;
  if (left) files._deletingIn(row);
  if (localChanges(library, gid)) {
    library._s(`UPDATE files SET path = ?, format = 'folder', state = 'packed', tail = NULL, unpack = 0 WHERE gid = ?`).run(g.rel, gid);
    library._logIn(gid);
    return false;
  }
  files.keep.add(gid);
  try { library._deleteIn(gid); } finally { files.keep.delete(gid); }
  addGallery(library, gid, g);
  entryIn(library, gid, g);
  return true;
}
// Archived gallery `gid` followed to the folder at `rel` (a path as `files` has them) beside its archive,
// which names it at a later generation (gallery-manifest.js supersedes) — what its unpack meets there
// (files.js _unpackedBeside) — as a check follows it (followTo), outside one: in its own transaction, the
// archive then deleted. Resolves whether it was followed: not when the folder doesn't read whole as that
// now (rejects when it can't be read now: tried again later).
export async function followUnpacked(library, gid, rel) {
  const files = library.files;
  const row = files._row(gid);
  const { root, rest } = files._split(rel);
  if (!row || row.format === 'folder' || row.source) return false;
  const g = { rel, root, inRoot: rest, abs: files._abs(rel), format: 'folder', layout: true };
  g.read = await readGallery(g);
  const had = library._s('SELECT stamp FROM stamps WHERE gid = ?').get(gid)?.stamp;
  if (g.read.kind !== 'gallery' || String(g.read.described?.id) !== String(gid) || !format.supersedes(g.read.token, had)) return false;
  library.asFolderWork(root, () => library._tx(() => { if (files._row(gid)?.path === row.path) followTo(library, row, g, { left: true }); }));
  library.publishFeed(gid);
  library._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
  files.applyDeletions({ root }).catch(() => {});
  return files._row(gid)?.path === rel;
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
// (under its data folder) and in its own in each library folder it may write to (library.js
// _ownStagingOf; another's, a hidden one's and one out of reach are left alone: what its galleries set
// aside may wait there). Never another library's there, nor what was staged there before S29b (at the
// top of the folder's staging, whose library can't be told): only the library that wrote a staged file
// knows whether it is a leftover (review 7 B1: another desktop library's check deleted what one had
// staged for a gallery both have). A gallery's pictures no
// record refers to, in a folder that is its own by what it holds (ownedBy) in one of the library
// folders checked (`checked`, their ids), are added to `unreferenced` ({ path, gid }): its picture
// folders are listed where the listing that told it so shows them (one it doesn't show holds none).
// Resolves how many went.
async function removeOrphans(library, unreferenced = [], checked = new Set()) {
  const keep = new Set();   // the files records refer to, where the index has them (library.js _stagedKey)
  for (const r of library._s('SELECT orig, record FROM pages').all()) {
    const orig = parse(r.orig);
    if (orig?.at === 's') keep.add(library._stagedKey(orig.file));
    collect(parse(r.record), (ref) => keep.add(path.join(library.cacheDir, ref)));
  }
  for (const r of library._s('SELECT record FROM covers').all()) collect(parse(r.record), (ref) => keep.add(path.join(library.cacheDir, ref)));
  for (const r of library._s('SELECT file FROM staged_own').all()) keep.add(library._stagedKey(r.file));   // pictures waiting for their archive
  let removed = 0;
  for (const dir of [library.dataStagingDir, library.cacheDir, ...library.activeRoots().map(id => library._ownStagingOf(id))]) {
    for (const gid of await disk.readdir(dir).catch(() => [])) {
      for (const name of await disk.readdir(path.join(dir, gid)).catch(() => [])) {
        const file = path.join(dir, gid, name);
        if (keep.has(file) || !await stale(file, ORPHAN_AGE_MS)) continue;
        await disk.rm(file, { force: true }).catch(() => {});
        removed++;
      }
      library._clearStaging(path.join(dir, gid)).catch(() => {});   // once empty — never as a page is on its way into it
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

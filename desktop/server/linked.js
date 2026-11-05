// linked.js — the galleries a library folder holds that Shiori didn't make (linked-source.js, in the
// app: what counts as one, their overlays, source.json and removed.json), as the desktop library
// keeps them: its index row for each (files.js `source`) and pages at 'x' (in the source), read where
// they are; everything Shiori adds in the gallery's overlay. The full check (scan.js) hands this the
// files of each library folder it doesn't know; a PDF's pages are drawn by a window (pdfsWaiting,
// pdfSource, addRendered, pdfFailed), as the import draws them.
//
// A linked gallery is known by its source's fingerprint, read again at every check: a source found
// where it was with another fingerprint changed (its pages are read again), one found elsewhere with
// the same moved (only where it is changes — an archive moves as a group, its chapters paired by their
// folder in it), as linked-source.js matchSources decides for both apps. A re-read never overwrites
// what the library hasn't written to the overlay yet (scan.js localChanges), and what was made from a
// page (a translation, study layers) stays with the picture it was made from or goes — it is never
// attached to another. Every path read from the folder's files is used only inside the folder: as
// written (absIn), and as the disk resolves it (folder-store.js physicallyIn: no link out of it is
// followed).

import { disk, physicallyIn } from './folder-store.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { readDirectory, readEntry } from './zip.js';
import { linked as L, files as layout, content, BackendError } from './shared.js';
import { replaceFile, ifMissing } from './files.js';
import { readDerived, derivedRecord, coverPatch, localChanges, startEntry } from './scan.js';

const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const typeOf = (name) => TYPE_OF_EXT[String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase()] || '';
const extOf = (name) => String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg';
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const PAGE_URL = /\/(\d+)\.\w+$/;
const keyPage = (key) => { const m = String(key ?? '').match(PAGE_URL); return m ? parseInt(m[1], 10) : null; };
// The files of its own a page record refers to ({ $own: 'translated/0001.png' }…).
const ownRefs = (value, into = new Set()) => {
  if (value == null || typeof value !== 'object') return into;
  if (typeof value.$own === 'string') into.add(value.$own);
  else for (const v of Object.values(value)) ownRefs(v, into);
  return into;
};

// Where `rel` (a path in library folder `root`, '/'-separated: a source's, or an overlay's) is on disk.
// It must stay inside the folder (R12): source.json is read from the folder itself, so parseSource
// checks a path's form (safeRelPath) and this where it resolves — what would lead out is refused.
function absIn(library, root, rel) {
  const dir = library.rootDir(root);
  const abs = path.resolve(dir, ...String(rel).split('/'));
  const inside = path.relative(dir, abs);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new BackendError('invalid', `${rel} is outside its library folder`);
  }
  return abs;
}
// Where source path `rel` of library folder `root` is on disk, physically inside it (files.js
// physicallyIn, F09): every read of a source starts here.
const sourceIn = (library, root, rel) => physicallyIn(library.rootDir(root), absIn(library, root, rel));
// Text `text` written to `file` in library folder `root` (a file of an overlay, or removed.json's
// folder), whole — written beside it, then renamed over it — when the folder may be written to, and
// the folder it goes in is physically the library folder's (F09).
async function writeIn(library, root, file, text) {
  library.folders.assertWritable(root);
  await physicallyIn(library.rootDir(root), path.dirname(file));
  await disk.mkdir(path.dirname(file), { recursive: true });
  await replaceFile(file, Buffer.from(text));
}

// An archive's fingerprint, as the app's (zip-read.js zipEntries): the SHA-256 of its central directory.
async function zipFingerprint(abs) {
  const fh = await disk.open(abs, 'r');
  try {
    const { size } = await fh.stat();
    const tailAt = Math.max(0, size - 22 - 0xffff);
    const tail = Buffer.alloc(size - tailAt);
    await fh.read(tail, 0, tail.length, tailAt);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const at = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(tailAt + eocd - at);
    await fh.read(cd, 0, cd.length, at);
    return sha256(cd);
  } finally { await fh.close(); }
}

// A title's pictures where they are, in order — [{ name (in its folder, or the archive), size }] —
// with its fingerprint and size (an archive's: its `directory` too); null when they can't be read.
// `directory`: the archive's, when the caller has read it. Rejects for one that leads out of the
// folder (F09).
async function titleAt(library, root, title, directory = null) {
  const abs = await sourceIn(library, root, title.path);
  if (title.kind === 'zip') {
    const dir = directory || await readDirectory(abs).catch(() => null);
    if (!dir) return null;
    const mine = L.zipTitles([...dir.keys()]).find(z => z.inner === (title.inner || ''));
    if (!mine) return null;
    return { pictures: mine.pictures.map(name => ({ name, size: dir.get(name).size })), fingerprint: await zipFingerprint(abs).catch(() => null),
      size: (await disk.stat(abs)).size, directory: dir };
  }
  if (title.kind === 'dir') {
    const pictures = [];
    for (const item of await disk.readdir(abs, { withFileTypes: true })) {
      if (!item.isFile() || !L.IMAGE_NAME.test(item.name) || item.name.startsWith('.')) continue;
      const st = await disk.stat(path.join(abs, item.name)).catch(ifMissing(null));
      if (st) pictures.push({ name: item.name, path: item.name, size: st.size });
    }
    const sorted = L.sortPictures(pictures);
    return { pictures: sorted, fingerprint: sha256(L.folderPrint(sorted)), size: sorted.reduce((n, p) => n + p.size, 0) };
  }
  const st = await disk.stat(abs).catch(() => null);
  if (!st) return null;
  const fh = await disk.open(abs, 'r');
  try {
    const head = Buffer.alloc(Math.min(st.size, 1024 * 1024));
    await fh.read(head, 0, head.length, 0);
    return { pictures: [], fingerprint: `${st.size}:${sha256(head)}`, size: st.size };
  } finally { await fh.close(); }
}
// Source `source`'s fingerprint as its files are now in library folder `root` (null when they can't
// be read) — what a note that it was removed must carry (folders.js publishRemoved).
export async function fingerprintNow(library, root, source) {
  return (await titleAt(library, root, source).catch(() => null))?.fingerprint ?? null;
}
// A source as the index and source.json keep it: what it is, where, and its fingerprint.
const sourceOf = (title, at) => ({ kind: title.kind, path: title.path, ...(title.inner ? { inner: title.inner } : {}),
  ...(at?.fingerprint ? { fingerprint: at.fingerprint } : {}) });

// The overlays library folder `root` holds: source key → { galleryId, source } — one whose source
// would lead out of the folder left out.
export async function overlaysOf(library, root) {
  const out = new Map();
  const dir = absIn(library, root, L.LINKED_DIR);
  const inside = (rel) => { try { return !!absIn(library, root, rel); } catch { return false; } };
  for (const item of await disk.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!item.isDirectory()) continue;
    const read = L.parseSource(await disk.readFile(path.join(dir, item.name, L.SOURCE_FILE), 'utf8').catch(() => null));
    if (read && read.galleryId === item.name && inside(read.source.path)) out.set(L.sourceKey(read.source), read);
  }
  return out;
}
// The sources removed from library folder `root`: its removed.json's list, and the notes still owed
// to it (folders.js removedWaiting) — removed all the same (F12).
const removedOf = async (library, root) => [
  ...L.parseRemoved(await disk.readFile(absIn(library, root, L.REMOVED_FILE), 'utf8').catch(() => null)),
  ...library.folders.removedWaiting(root),
];
// The pages of its own gallery `gid`'s overlay holds (its images/: pages replaced, a PDF's drawn):
// [{ name, size }]. Rejects when they can't be read (F06).
async function overlayPages(library, root, gid) {
  const dir = path.join(absIn(library, root, L.overlayDir(gid)), 'images');
  const out = [];
  for (const item of await disk.readdir(dir, { withFileTypes: true }).catch(ifMissing([]))) {
    if (!item.isFile() || !L.IMAGE_NAME.test(item.name)) continue;
    const st = await disk.stat(path.join(dir, item.name)).catch(ifMissing(null));
    if (st) out.push({ name: item.name, size: st.size });
  }
  return out;
}

// Gallery `gid`'s overlay's source.json, saying that its source is `title` (as it is now: `at`,
// titleAt's, when it could be read) — and what it said of a PDF's pages, unless `marks` says it anew:
// how many are drawn (`rendered`), or that drawing them failed (`failed`). Written only when that
// changes it. Resolves the overlay's path in the library (files.js: `@<root>/…` beyond the first
// folder) and the source as source.json had it (null: a new overlay).
async function overlayFor(library, root, title, gid, at, marks = {}) {
  const { file, text, was } = await sourceJson(library, root, gid);
  const want = L.sourceText(gid, { kind: title.kind, path: title.path, inner: title.inner,
    size: at?.size ?? was?.size ?? null, fingerprint: at?.fingerprint ?? was?.fingerprint ?? null,
    rendered: 'rendered' in marks ? marks.rendered : was?.rendered, failed: 'failed' in marks ? marks.failed : was?.failed });
  if (text !== want) await writeIn(library, root, file, want);
  return { rel: library.files._join(root, L.overlayDir(gid)), was };
}
// Gallery `gid`'s overlay's source.json: where it is, its text, and the source it names (`was`, null
// when there is none, or it names another gallery). Rejects when it can't be read: never written over.
async function sourceJson(library, root, gid) {
  const file = path.join(absIn(library, root, L.overlayDir(gid)), L.SOURCE_FILE);
  const text = await disk.readFile(file, 'utf8').catch(ifMissing(null));
  const read = L.parseSource(text);
  return { file, text, was: read?.galleryId === String(gid) ? read.source : null };
}

// An archive's own metadata, when it is a description Shiori wrote (folder-content.js galleryIdOf) —
// another tool's metadata.json describes nothing of it (R01).
async function embeddedMeta(library, root, title, at) {
  const entry = at.directory?.get('metadata.json');
  if (!entry) return null;
  const text = String(await readEntry(await sourceIn(library, root, title.path), entry).catch(() => ''));
  const id = content.galleryIdOf(text);
  return id ? { ...JSON.parse(text), galleryId: id } : null;
}

// Title `title` of library folder `root` joined to the library as a linked gallery — or, `replace`, a
// gallery it keeps read again (its rows replaced, its files kept) — as gallery `gid` (its overlay's,
// when one was made for it), else a new one. Its pages: its source's pictures in order, each one its
// overlay holds a page of its own for replaced by that one, and the overlay's pages past them
// (linkedPages: R13); a PDF's are all its overlay's, and it joins only once they are all drawn
// (pdfReady: R11). Its metadata: its overlay's, else an archive's own when Shiori wrote it, else what
// its name and folders say. What was made from a page (translations, study layers, pipeline data)
// stays with it only while the page shows the source picture its overlay's description says it was
// made from, by name and size (linked-source.js keepsDerived), and is otherwise dropped, its files too,
// never attached to another picture (R19, F07). `guard()`: whether the gallery has changes of its own
// not yet written to its overlay — checked again as the rows are replaced; they win, and it isn't read
// again (A14). `at`: the title as titleAt read it, when the caller has. Resolves its id; null when it
// has no pages yet (a PDF waiting) or `guard` held it back.
export async function adoptLinked(library, root, title, { gid: given = null, replace = null, guard = null, at = null } = {}) {
  at = at || await titleAt(library, root, title);
  if (!at) return null;
  const embedded = title.kind === 'zip' && !title.inner ? await embeddedMeta(library, root, title, at) : null;
  const taken = (id) => !!library._s('SELECT 1 FROM meta WHERE gid = ?').get(id) || !!library._s('SELECT 1 FROM files WHERE gid = ?').get(id);
  const gid = replace || given || (embedded && !taken(embedded.galleryId) ? embedded.galleryId : null) || library.nextGalleryId();
  if (!replace && taken(gid)) return null;
  // A new one's overlay names its source from the start; one read again, only once it was (its
  // source.json says what its overlay's pages and pictures were made from).
  const { rel, was } = replace ? { rel: library.files._join(root, L.overlayDir(gid)), was: (await sourceJson(library, root, gid)).was }
    : await overlayFor(library, root, title, gid, at);
  const overlay = library.files._abs(rel);
  const own = await overlayPages(library, root, gid);
  if (title.kind === 'pdf' && !L.pdfReady({ ...title, rendered: was?.rendered }, own)) return null;
  const text = (name) => disk.readFile(path.join(overlay, ...name.split('/')), 'utf8').catch(ifMissing(null));
  const texts = Object.fromEntries(await Promise.all(layout.DESCRIPTION_FILES.map(async (n) => [n, await text(n)])));
  const meta = parse(texts['metadata.json']);
  const records = parse(texts['image_records.json']);
  const pages = L.linkedPages(at.pictures, own, layout.describedFiles(records, parse(texts['covers/manifest.json'])));
  if (!pages.length) return null;
  const derived = await readDerived(overlay);
  const entryOf = new Map((Array.isArray(records) ? records : []).map(r => [keyPage(r?.url), r]).filter(([n]) => n != null));
  // What its name and folders say: an archive's chapter is named after its folder in it, its tags the
  // archive's.
  const parts = title.path.split('/');
  const file = parts.pop();
  let named;
  if (title.kind === 'zip' && title.inner) {
    const chapter = title.inner.replace(/\/$/, '').split('/').pop();
    named = { title: { english: chapter, japanese: '', pretty: chapter }, tags: L.metaFromName(file, parts).tags };
  } else {
    named = L.metaFromName(title.kind === 'dir' ? (title.name || file || path.basename(library.rootDir(root))) : file, parts);
  }
  const now = Date.now();
  const record = meta && String(meta.galleryId) === gid ? { ...meta, galleryId: gid }
    : embedded ? { ...embedded, galleryId: gid }
    : { galleryId: gid, ...named, numPages: pages.length, isLocalImport: true, source: '' };
  const files = library.files;
  let held = false;
  library._tx(() => {
    if (guard?.()) { held = true; return; }
    const had = new Set();   // the pictures of its own its records referred to, and those it read
    if (replace) {
      for (const r of library._pageRows(gid)) ownRefs(parse(r.record), had);
      files.keep.add(gid);
      try { library._deleteIn(gid); } finally { files.keep.delete(gid); }
    }
    library._metaPutRaw(record);
    if (record.parentId) startEntry(library, gid, record, now);
    const kept = new Set();
    for (const p of pages) {
      const entry = entryOf.get(p.n);
      const made = derivedRecord(derived, p.n, entry);
      ownRefs(made, had);
      if (!L.keepsDerived(p, entry?.source)) for (const k of Object.keys(made)) delete made[k];
      ownRefs(made, kept);
      const ext = extOf(p.name);
      let key = entry?.url && keyPage(entry.url) === p.n ? entry.url : `local://${gid}/${p.n}.${ext}`;
      if (library._pageRowByKey(key)) key = `local://${gid}/${p.n}.${ext}`;
      if (library._pageRowByKey(key) || library._pageRow(gid, p.n)) continue;
      const orig = p.from === 'overlay' ? { at: 'p', entry: `images/${p.name}`, size: p.size, type: typeOf(p.name) }
        : { at: 'x', entry: p.name, size: p.size, type: typeOf(p.name) };
      library._pagePutRow({ gid, n: p.n, key, w: null, h: null, orig, record: { url: key, blob: { $orig: 1, size: p.size, type: orig.type },
        mediaId: String(entry?.mediaId ?? gid), galleryId: gid, cachedAt: entry?.cachedAt || now, size: p.size, ...made } });
    }
    library._s(`INSERT OR REPLACE INTO files (gid, path, format, state, packed_at, used_at, source) VALUES (?, ?, 'folder', 'packed', ?, ?, ?)`)
      .run(gid, rel, now, now, JSON.stringify(sourceOf(title, at)));
    if (texts['metadata.json'] != null) library._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(gid, layout.descriptionStamp(texts));
    for (const name of had) if (!kept.has(name)) library._dropOwn(gid, name);   // made from a picture it no longer shows
    library._logIn(gid);
  });
  if (held) return null;
  if (replace) await overlayFor(library, root, title, gid, at);
  await library.rebuildGalleryEntry(gid, { silent: true });
  const covers = coverPatch(derived);
  if (Object.keys(covers).length) library._tx(() => library._coverPatchIn(gid, covers));
  if (texts['metadata.json'] == null) files.describeLater(gid);   // its overlay describes it, in due course
  if (replace) library._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
  return gid;
}

// Gallery `gid`, kept in the library, its source found moved or renamed: `title`, the same files (its
// fingerprint). Only where it is changes — the source the index keeps, and its overlay's source.json —
// so nothing the library has of it is read again or lost (A14), and its pages, named by their entries
// in the source, are all still there.
async function relink(library, root, gid, title, at) {
  await overlayFor(library, root, title, gid, at);
  library._tx(() => {
    if (!library.files._row(gid)) return;
    library._s(`UPDATE files SET source = ?, state = 'packed' WHERE gid = ?`).run(JSON.stringify(sourceOf(title, at)), gid);
    library._logIn(gid);
  });
  library.publishFeed(gid);
}

// What library folder `root` holds that isn't Shiori's, joined to the library as linked galleries — as
// the app's folder check does: `files`, its pictures and PDFs outside Shiori's own galleries ([{ path }]
// in it); `own`, the paths of those galleries (folder-content.js: planTitles leaves them out);
// `archives`, its archives that aren't Shiori's ([{ path, entries }]: readDirectory's, null for one
// that couldn't be read — its galleries are left as they are). Every title is read as it is now (its
// fingerprint) and matched against the linked galleries the library keeps there, the overlays the
// folder holds and its removed.json (linked-source.js matchSources): a gallery the library keeps whose
// files moved or were renamed is re-pointed (relink), as is the overlay of one it doesn't have (it
// comes back as that gallery, R18); one changed in place is read again, unless it has changes of its
// own not yet written (localChanges); one removed from the library before isn't added again; the rest
// join — an archive's new chapters as a series named after it. What can't be read or joined is added
// to `problems` ([{ path, reason }]).
// `onProgress(done, total, step, added)` as it goes, in two steps each counted on its own: what is
// there ('lf.task_checking'), then the galleries joining ('lf.task_adding'). Resolves { added,
// updated } (gallery ids).
export async function linkRoot(library, root, { files = [], own = [], archives = [], problems = [], stopped = () => false, onProgress = () => {} } = {}) {
  const out = { added: [], updated: [] };
  const lf = library.files;
  const kept = library._s('SELECT gid, path, source FROM files WHERE source IS NOT NULL').all()
    .filter(r => lf._split(r.path).root === root).map(r => ({ gid: r.gid, source: lf.sourceOf(r) })).filter(k => k.source);
  const keptAt = new Set(kept.map(k => L.sourceKey(k.source)));
  const planned = L.planTitles(files, path.basename(library.rootDir(root)), own).filter(t => t.kind !== 'zip');
  let step = 'lf.task_checking', total = planned.length + archives.length, done = 0;
  const say = () => onProgress(Math.min(done, total), total, step, out.added.length);
  say();

  // Every title as it is now: its fingerprint, and its pictures (kept for the step joining it).
  const found = [], read = new Map();
  for (const t of planned) {
    if (stopped()) return out;
    const title = { kind: t.kind, path: t.path, ...(t.name ? { name: t.name } : {}) };
    let why = 'unreadable';
    const at = await titleAt(library, root, title).catch((e) => { if (e?.reason === 'outside') why = 'outside'; return null; });
    if (at) read.set(L.sourceKey(title), at);
    else problems.push({ path: t.path, reason: why });
    if (at || keptAt.has(L.sourceKey(title))) found.push({ ...title, fingerprint: at?.fingerprint ?? null });
    done++;
    say();
  }
  for (const { path: zip, entries } of archives) {
    if (stopped()) return out;
    if (!entries) {
      for (const k of kept) if (k.source.kind === 'zip' && k.source.path === zip) found.push({ ...k.source, fingerprint: null });
    } else {
      const abs = absIn(library, root, zip);
      const fingerprint = await zipFingerprint(abs).catch(() => null);
      const size = (await disk.stat(abs).catch(() => null))?.size ?? null;
      for (const z of L.zipTitles([...entries.keys()])) {
        const title = { kind: 'zip', path: zip, ...(z.inner ? { inner: z.inner } : {}), chapter: z.chapter };
        read.set(L.sourceKey(title), { pictures: z.pictures.map(name => ({ name, size: entries.get(name).size })), fingerprint, size, directory: entries });
        found.push({ ...title, fingerprint });
      }
    }
    done++;
    say();
  }
  // A kept source the walk didn't find (the walk follows no links): one whose path now leads out of
  // the folder is reported (F09) — never read, its gallery missing — one that is gone only missing.
  const seen = new Set(found.map(f => L.sourceKey(f)));
  for (const k of kept) {
    if (seen.has(L.sourceKey(k.source))) continue;
    if (await sourceIn(library, root, k.source.path).then(() => false, (e) => e?.reason === 'outside')) problems.push({ path: k.source.path, reason: 'outside' });
  }

  const known = new Set(library._s('SELECT gid FROM files UNION SELECT gid FROM meta').all().map(r => r.gid));
  await library.folders.publishRemoved(root);   // notes still owed to the folder, tried again
  const plan = L.matchSources({ found, kept, overlays: [...(await overlaysOf(library, root)).values()], known, removed: await removedOf(library, root) });
  const atOf = (title) => read.get(L.sourceKey(title)) || null;
  const failed = (title, e) => problems.push({ path: title.path, reason: e?.reason === 'outside' ? 'outside' : e?.syscall ? 'unreadable' : 'adopt-failed' });
  const link = async (title, gid) => {
    try {
      const made = await adoptLinked(library, root, title, { gid, at: atOf(title) });
      if (made) out.added.push(made);
      return made;
    } catch (e) { failed(title, e); return null; }
  };
  const chapters = new Map();   // an archive → its new chapters, to join as a series
  step = 'lf.task_adding';
  total = plan.moved.length + plan.changed.length + plan.new.length;
  done = 0;
  say();
  for (const m of plan.moved) {
    if (stopped()) return out;
    if (!m.kept) await link(m.title, m.gid);
    else {
      try { await relink(library, root, m.gid, m.title, atOf(m.title)); out.updated.push(m.gid); } catch (e) { failed(m.title, e); }
    }
    done++;
    say();
  }
  for (const c of plan.changed) {
    if (stopped()) return out;
    try {
      if (await adoptLinked(library, root, c.title, { replace: c.gid, guard: () => localChanges(library, c.gid), at: atOf(c.title) })) out.updated.push(c.gid);
    } catch (e) { failed(c.title, e); }
    done++;
    say();
  }
  for (const n of plan.new) {
    if (stopped()) return out;
    if (n.title.chapter && !n.gid) {
      if (!chapters.has(n.title.path)) chapters.set(n.title.path, []);
      chapters.get(n.title.path).push(n.title);
      continue;
    }
    await link(n.title, n.gid ?? null);
    done++;
    say();
  }
  for (const [zip, titles] of chapters) {
    const made = [];
    for (const title of titles) {
      if (stopped()) return out;
      const gid = await link(title, null);
      if (gid) made.push({ id: gid, title: title.inner.replace(/\/$/, '').split('/').pop() });
      done++;
      say();
    }
    if (made.length >= 2) await library.seriesCommand('write', made[0].id, made, { seriesTitle: L.metaFromName(zip.split('/').pop()).title }).catch(() => {});
  }
  return out;
}

// ── A PDF's pages, drawn by a window ──
// The PDFs the library's folders hold whose pages wait to be drawn (linked-source.js pdfWaits): [{
// folder, gid, path, name }] — not drawn yet, or drawn from another version of the file than its last
// check found (F10: the library may have it already) — and not removed from the library, nor one drawing
// failed for, until its file changes (A23). One whose file or overlay can't be read now, or whose file
// leads out of the folder (F09), isn't offered.
export async function pdfsWaiting(library) {
  const out = [];
  for (const root of library.activeRoots()) {
    if (!disk.existsSync(library.rootDir(root))) continue;
    const removed = await removedOf(library, root);
    for (const over of (await overlaysOf(library, root)).values()) {
      const src = over.source;
      if (src.kind !== 'pdf') continue;
      try {
        if (!disk.existsSync(await sourceIn(library, root, src.path))) continue;
        // Its fingerprint as it is now, read only when something is noted against a version of it.
        const noted = !!src.failed || removed.some(r => r.path === src.path);
        const print = noted ? await fingerprintNow(library, root, src) : src.fingerprint;
        if (noted && L.isRemoved(removed, { ...src, fingerprint: print })) continue;
        if (L.pdfWaits(src, await overlayPages(library, root, over.galleryId), print)) out.push({ folder: root, gid: over.galleryId, path: src.path, name: src.path.split('/').pop() });
      } catch { /* not offered */ }
    }
  }
  return out;
}
// The overlay of the PDF waiting in library folder `root` as gallery `gid`: one the library doesn't
// have yet, or one it has whose pages are to be drawn again (pdfWaits).
async function waiting(library, root, gid) {
  library.rootDir(root);
  const over = [...(await overlaysOf(library, root)).values()].find(o => o.galleryId === String(gid));
  if (!over || over.source.kind !== 'pdf' || (library.files._row(gid) && !L.pdfWaits(over.source, await overlayPages(library, root, gid)))) {
    throw new BackendError('not-found', `no PDF waiting as gallery ${gid}`);
  }
  return over;
}
// The PDF a waiting gallery is drawn from.
export async function pdfSource(library, root, gid) {
  const over = await waiting(library, root, gid);
  return new Blob([await disk.readFile(await sourceIn(library, root, over.source.path))], { type: 'application/pdf' });
}
// A waiting PDF's pages, drawn (Blobs in order), kept in its overlay and the gallery joined to the
// library: what an earlier draw left there first cleared, every page written, then — last — its
// source.json saying how many there are and the file they were drawn from (`rendered`), so a check
// never takes a draw cut short for a gallery (R11). One the library has, drawn again, has its pages
// replaced (redrawn), then its marker. Each write goes through the gate. Resolves its id; rejects when
// it didn't join.
export async function addRendered(library, root, gid, pages) {
  if (!pages?.length) throw new BackendError('invalid', 'no pages drawn');
  library.folders.assertWritable(root);
  const over = await waiting(library, root, gid);
  if (library.files._row(gid)) {
    const at = await titleAt(library, root, over.source).catch(() => null);
    await redrawn(library, String(gid), pages);
    await overlayFor(library, root, over.source, gid, at, { rendered: { pages: pages.length, fingerprint: at?.fingerprint ?? null }, failed: null });
    library.publishFeed(String(gid));
    return String(gid);
  }
  const dir = await physicallyIn(library.rootDir(root), path.join(absIn(library, root, L.overlayDir(gid)), 'images'));
  await disk.rm(dir, { recursive: true, force: true });
  await disk.mkdir(dir, { recursive: true });
  for (const [i, blob] of pages.entries()) {
    const name = layout.layoutPath.original(i + 1, layout.extOfType(blob.type) || 'webp').split('/').pop();
    const bytes = Buffer.from(await blob.arrayBuffer());
    library.folders.assertWritable(root);
    await disk.writeFile(path.join(dir, name), bytes);
    library.writes.add('pages', bytes.length);
  }
  const at = await titleAt(library, root, over.source).catch(() => null);
  const rendered = { pages: pages.length, fingerprint: at?.fingerprint ?? null };
  await overlayFor(library, root, over.source, gid, at, { rendered, failed: null });
  // (A check that ran meanwhile may have joined it already.)
  const made = await adoptLinked(library, root, { ...over.source, rendered }, { gid: String(gid), at })
    ?? (library.files._row(gid)?.source ? String(gid) : null);
  if (!made) throw new BackendError('invalid', `the PDF waiting as gallery ${gid} didn't join the library`);
  library.publishFeed(made);
  return made;
}
// Gallery `gid`'s pages replaced by `pages` (Blobs in order: its PDF drawn again, F10) as any page is
// stored: each staged first, then every page row replaced in one transaction — the old pages read until
// it commits, what was made from them dropped with them (each page shows another picture now: library.js
// _pageDrop) — and the new ones put in its overlay as it settles (files.js), the old files going then.
async function redrawn(library, gid, pages) {
  const staged = [];
  for (const [i, blob] of pages.entries()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = blob.type || 'image/webp';
    staged.push({ n: i + 1, type, size: bytes.length, orig: await library._stage(gid, i + 1, bytes, type) });
  }
  const now = Date.now();
  library._tx(() => {
    if (!library.files._row(gid)) throw new BackendError('not-found', `gallery ${gid} is gone`);
    for (const row of library._pageRows(gid)) library._pageDrop(row);
    for (const p of staged) {
      const key = `local://${gid}/${p.n}.${layout.extOfType(p.type) || 'webp'}`;
      library._pagePutRow({ gid, n: p.n, key, w: null, h: null, orig: p.orig,
        record: { url: key, blob: { $orig: 1, size: p.size, type: p.type }, mediaId: gid, galleryId: gid, cachedAt: now, size: p.size } });
    }
    library._logIn(gid);
  });
  await library.rebuildGalleryEntry(gid, { silent: true });
  library._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
  library.files.describeLater(gid);
  await library.files.settle(gid);
}
// A waiting PDF a window couldn't draw: noted in its overlay's source.json (`failed`, with its file's
// fingerprint as it is now), so it isn't listed as waiting again until the file changes (A23).
export async function pdfFailed(library, root, gid) {
  const over = await waiting(library, root, gid);
  const at = await titleAt(library, root, over.source).catch(() => null);
  await overlayFor(library, root, over.source, gid, at, { failed: { fingerprint: at?.fingerprint ?? null, at: Date.now() } });
}

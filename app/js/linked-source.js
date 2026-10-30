// linked-source.js — galleries a library folder holds that Shiori didn't make: an archive (zip/cbz)
// or a folder of pictures put there some other way, or a PDF. Their files are used as they are — read,
// never written, moved, renamed, unpacked or deleted — and everything Shiori adds to such a gallery
// (its descriptions, translations, study layers, covers, pages it fetches or draws itself) is kept in
// an overlay: a folder in the gallery format of its own, in the library folder's hidden
// .shiori/linked/<gallery id>/, beside a source.json naming the files it belongs to (where they are in
// the library folder, their size, and a fingerprint that finds them again once moved or renamed). An
// overlay's own page NNNN stands in for the source's page NNNN. Removing such a gallery from the
// library leaves its files, and notes them in .shiori/linked/removed.json so that checking the folder
// doesn't add them again. What counts as Shiori's own, and so not linked, is folder-content.js's to
// say. A path read from these files is used only when it is relative and stays inside the library
// folder (safeRelPath). Pure: the browser library (db.js) and the desktop app's (server/library.js,
// scan.js, linked.js) read and write the files.

import { isValidGalleryId } from './sanitize.js';
import { pageNumberOf } from './gallery-files.js';

export const LINKED_DIR = '.shiori/linked';
export const SOURCE_FILE = 'source.json';
export const REMOVED_FILE = `${LINKED_DIR}/removed.json`;
export const overlayDir = (gid) => `${LINKED_DIR}/${gid}`;

export const IMAGE_NAME = /\.(jpe?g|png|webp|gif|avif)$/i;
export const ARCHIVE_NAME = /\.(zip|cbz)$/i;
export const PDF_NAME = /\.pdf$/i;
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => natural.compare(a, b);

// Whether `p` is a path that stays inside the folder it is read against: relative, '/'-separated,
// every segment a plain name — not empty, not made of dots and spaces only ('.', '..', '...' — which
// Windows may read as '..'), without '\', ':' (a drive, or another file's stream on Windows) or NUL,
// and not a Windows device name (CON, NUL, COM1…). So no absolute, drive (C:/) or UNC (//host) path.
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
export const safeRelPath = (p) => typeof p === 'string' && p !== '' && p.split('/').every(s =>
  s !== '' && !/^[. ]+$/.test(s) && !/[\\:\u0000]/.test(s) && !DEVICE.test(s.split('.')[0].trimEnd()));
// An archive's chapter folder as a source names it ("Name/" or "A/B/"): a safe path, ending in '/'.
const _safeInner = (inner) => typeof inner === 'string' && inner.endsWith('/') && safeRelPath(inner.slice(0, -1));

// A source as source.json keeps it: { kind: 'zip' | 'dir' | 'pdf', path (in the library folder,
// '/'-separated), inner (for an archive whose folders are titles each: the folder in it, "Name/"),
// size, fingerprint } — and for a PDF, once its pages are drawn into the overlay, `rendered` (how many:
// the overlay holds them all, pdfReady), or, when drawing them failed, `failed` ({ fingerprint (the
// file's, as it was then), at }: not tried again until the file changes, drawFailed).
const KINDS = new Set(['zip', 'dir', 'pdf']);
export const sourceText = (galleryId, source) => JSON.stringify({ format: 'shiori-linked', version: 1, galleryId: String(galleryId),
  source: { kind: source.kind, path: source.path, ...(source.inner ? { inner: source.inner } : {}), size: source.size ?? null,
    fingerprint: source.fingerprint ?? null, ...(source.rendered ? { rendered: source.rendered } : {}),
    ...(source.failed ? { failed: { fingerprint: source.failed.fingerprint ?? null, at: source.failed.at } } : {}) } }, null, 2);
// source.json's { galleryId, source }, or null when it isn't one — or names a path that doesn't stay
// inside the library folder, or a gallery id that isn't one.
export function parseSource(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  const s = v?.source;
  if (v?.format !== 'shiori-linked' || !isValidGalleryId(v.galleryId) || !KINDS.has(s?.kind) || !safeRelPath(s.path)) return null;
  const inner = s.inner === '' || s.inner == null ? null : s.inner;
  if (inner != null && (s.kind !== 'zip' || !_safeInner(inner))) return null;
  const pdf = s.kind === 'pdf';
  const rendered = pdf && Number.isSafeInteger(s.rendered) && s.rendered > 0 ? s.rendered : null;
  const failed = pdf && s.failed && typeof s.failed === 'object' && Number.isFinite(s.failed.at)
    ? { fingerprint: typeof s.failed.fingerprint === 'string' ? s.failed.fingerprint : null, at: s.failed.at } : null;
  return { galleryId: String(v.galleryId), source: { kind: s.kind, path: s.path, ...(inner ? { inner } : {}),
    size: Number.isFinite(s.size) ? s.size : null, fingerprint: typeof s.fingerprint === 'string' ? s.fingerprint : null,
    ...(rendered ? { rendered } : {}), ...(failed ? { failed } : {}) } };
}
// A source's key: what it is and where (two titles of one archive differ by their folder in it).
export const sourceKey = (s) => `${s.kind}\u0000${s.path}\u0000${s.inner || ''}`;

// The sources removed from the library: [{ kind, path, inner?, fingerprint, at }].
export function parseRemoved(text) {
  try { const v = JSON.parse(text); return Array.isArray(v?.removed) ? v.removed.filter(r => safeRelPath(r?.path)) : []; } catch { return []; }
}
export const removedText = (list) => JSON.stringify({ format: 'shiori-linked-removed', version: 1, removed: list }, null, 2);
// Whether `source` (as found: { path, inner?, fingerprint } — its fingerprint as it is now) is one of
// `removed`: the same files where they were — one changed since (another fingerprint) counts as new.
export const isRemoved = (removed, source) => removed.some(r => r.path === source.path && (r.inner || '') === (source.inner || '')
  && (!r.fingerprint || !source.fingerprint || r.fingerprint === source.fingerprint));
// `removed` with `source` noted as removed (its fingerprint as it is now), in place of an earlier note
// of the same files.
export const withRemoved = (removed, source, now = Date.now()) => [
  ...removed.filter(r => !(r.path === source.path && (r.inner || '') === (source.inner || ''))),
  { kind: source.kind, path: source.path, ...(source.inner ? { inner: source.inner } : {}), fingerprint: source.fingerprint || null, at: now },
];

// What a folder of pictures' fingerprint is made from (hashed by the caller, SHA-256 in hex): its
// pictures' names and sizes. An archive's is its central directory's bytes (import-cbz.js zipEntries).
export const folderPrint = (pictures) => [...pictures].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  .map(p => `${p.name}\t${p.size}`).join('\n');

// The files that said a folder is in the Shiori gallery format, before folder-content.js read them.
// superseded by folder-content.js classifyFolder — removed once callers switch (stage 1/2)
export const LAYOUT_FILES = new Set(['metadata.json', 'image_records.json', 'series.json']);
const _hidden = (path) => path.split('/').some(s => s.startsWith('.') || s === '__MACOSX');
const _stem = (name) => name.replace(/\.[^./]+$/, '');

// Pictures in the order the import takes them (import-cbz.js sortImageEntries): natural order by
// path, folder by folder, the extension not counting. `key` gives each one's path.
export function sortPictures(list, key = (p) => p.path) {
  const parts = (p) => _stem(key(p)).split('/');
  return [...list].sort((a, b) => {
    const pa = parts(a), pb = parts(b);
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const c = naturalCompare(pa[i], pb[i]);
      if (c) return c;
    }
    return pa.length - pb.length;
  });
}

// What a library folder holds that isn't Shiori's, as titles. Every folder holding pictures is one
// gallery (its own pictures; its subfolders' are titles of their own — folders not laid out as
// Shiori's are most likely titles each, put there some other way), named after it — the pictures
// loose at the top of the library folder one more, named after it (`rootName`); every archive a
// gallery, or a series when its pictures sit in folders (zipTitles); every PDF a gallery. `files`:
// every file in the library folder, [{ path, size? }] ('/'-separated, from its top; hidden ones and
// the library's own .shiori left out here, as is a path that isn't safe: safeRelPath). `own`: the
// paths of Shiori's own galleries there (folder-content.js: its folders, all they hold left out, and
// its archives). Resolves [{ kind: 'zip' | 'pdf', path, size } | { kind: 'dir', path ('' for the top),
// name, pictures: [{ path, size }] }].
export function planTitles(files, rootName, own) {
  const list = files.filter(f => safeRelPath(f?.path) && !_hidden(f.path));
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
  const mine = own ? [...own] : _ownByName(list);   // superseded fallback — removed once callers pass `own` (stage 1/2)
  const isOwn = (p) => mine.some(o => p === o || p.startsWith(`${o}/`));
  const titles = [];
  const folders = new Map();   // a folder ('' for the top) → its own pictures
  for (const f of list) {
    if (isOwn(f.path)) continue;
    if (ARCHIVE_NAME.test(f.path)) titles.push({ kind: 'zip', path: f.path, size: f.size ?? null });
    else if (PDF_NAME.test(f.path)) titles.push({ kind: 'pdf', path: f.path, size: f.size ?? null });
    else if (IMAGE_NAME.test(f.path)) {
      const dir = dirOf(f.path).replace(/\/$/, '');
      if (!folders.has(dir)) folders.set(dir, []);
      folders.get(dir).push({ path: f.path, size: f.size ?? null });
    }
  }
  for (const [dir, pictures] of folders) titles.push({ kind: 'dir', path: dir, name: dir ? dir.split('/').pop() : rootName, pictures: sortPictures(pictures) });
  return titles.sort((a, b) => naturalCompare(a.path, b.path));
}
// The folders holding one of LAYOUT_FILES (the outermost), as planTitles took Shiori's own before it
// was told them.
// superseded by planTitles' `own` (folder-content.js) — removed once callers switch (stage 1/2)
function _ownByName(list) {
  const own = [];
  const depth = (p) => p.split('/').length;
  for (const f of [...list].sort((a, b) => depth(a.path) - depth(b.path))) {
    const at = f.path.lastIndexOf('/');
    const dir = at < 0 ? '' : f.path.slice(0, at);
    if (LAYOUT_FILES.has(f.path.slice(at + 1)) && dir && !own.some(o => dir === o || dir.startsWith(`${o}/`))) own.push(dir);
  }
  return own;
}

// An archive's galleries (`names`: its entries' names, decoded by folder-content.js zipName), as the
// import makes them: its pictures in order — or, when they sit in more than one folder, a series (the
// archive) of chapters: each folder holding pictures one, named after it (folders holding only
// folders don't count), the pictures beside the folders opening the first. A picture whose name isn't
// a safe path is left out, so every chapter's folder can be kept in its source. Resolves [{ inner (''
// or "Folder/": the chapter's folder in the archive), pictures: [names], chapter (in a series) }].
export function zipTitles(names) {
  const pictures = sortPictures(names.filter(n => IMAGE_NAME.test(n) && safeRelPath(n) && !_hidden(n)).map(path => ({ path }))).map(p => p.path);
  const byFolder = new Map();
  for (const n of pictures) {
    const dir = n.slice(0, n.lastIndexOf('/') + 1);
    if (!byFolder.has(dir)) byFolder.set(dir, []);
    byFolder.get(dir).push(n);
  }
  const folders = [...byFolder].filter(([dir]) => dir);
  if (folders.length < 2) return pictures.length ? [{ inner: '', pictures, chapter: false }] : [];
  const loose = byFolder.get('') || [];
  return folders.map(([inner, list], i) => ({ inner, pictures: i === 0 ? [...loose, ...list] : list, chapter: true }));
}

// A linked gallery's pages: its source's pictures in order (`source`: [{ name, size }], page n the
// n-th), each one its overlay holds a page of its own for (`overlay`: the files in its overlay's
// images/, [{ name, size }] — named by page number, gallery-files.js pageNumberOf) replaced by that one,
// and the overlay's pages past the source's added (a PDF's, drawn). Two overlay files for one page are
// an interrupted write's: the one under the layout name (0003.png) is taken. Resolves [{ n, from:
// 'source' | 'overlay', name, size }] in page order.
export function linkedPages(source, overlay = []) {
  const pages = new Map(source.map((p, i) => [i + 1, { n: i + 1, from: 'source', name: p.name, size: p.size ?? null }]));
  const plainFirst = [...overlay].filter(f => IMAGE_NAME.test(f.name))
    .sort((a, b) => Number(/^\d+\.\w+$/.test(b.name)) - Number(/^\d+\.\w+$/.test(a.name)) || naturalCompare(a.name, b.name));
  const taken = new Set();
  for (const f of plainFirst) {
    const n = pageNumberOf(f.name);
    if (n == null || taken.has(n)) continue;
    taken.add(n);
    pages.set(n, { n, from: 'overlay', name: f.name, size: f.size ?? null });
  }
  return [...pages.values()].sort((a, b) => a.n - b.n);
}

// Whether a PDF's pages are drawn: its source says how many (`rendered`, written once the last was
// kept) and its overlay's images/ (`overlay`: [{ name }]) holds each of them. Until then it waits —
// pages a window is still drawing, or one that stopped half way, don't make a gallery.
export function pdfReady(source, overlay = []) {
  const count = source?.kind === 'pdf' ? source.rendered : null;
  if (!Number.isSafeInteger(count) || count < 1) return false;
  const have = new Set(overlay.filter(f => IMAGE_NAME.test(f.name)).map(f => pageNumberOf(f.name)));
  for (let n = 1; n <= count; n++) if (!have.has(n)) return false;
  return true;
}
// Whether drawing a PDF's pages failed for the file as it is now (`fingerprint`, its current one): it
// isn't tried again until the file changes.
export const drawFailed = (source, fingerprint) => !!source?.failed && fingerprint != null && source.failed.fingerprint === fingerprint;

// What a check of a library folder makes of the linked titles it found (`found`: planTitles' and
// zipTitles' titles, [{ kind, path, inner?, fingerprint, … }], each with its fingerprint as it is now,
// null when it couldn't be read), against the linked galleries the library keeps there (`kept`:
// [{ gid, source }], as stored), the overlays the folder holds (`overlays`: [{ galleryId, source }],
// parseSource's), the galleries the library has anywhere (`known`: a Set of ids) and removed.json's
// list (`removed`). Each title found lands in one list, each kept gallery in one:
// - same: a kept gallery's source where it was, its fingerprint the same (or unreadable now).
// - changed: where it was, its files changed (another fingerprint): its pages are read again.
// - moved: a source gone from where it was (a kept gallery's, or an overlay's whose gallery the
//   library hasn't), found elsewhere by its fingerprint. An archive moves as a group — its fingerprint
//   is its central directory's, the same for all its chapters — and its chapters are then paired by
//   their folder in it (`inner`). A gallery the library keeps takes its files back before an overlay
//   does. { title, gid, kept, was (the source as it was) }.
// - new: a title nothing knows, joining the library — as gallery `gid` when the folder holds an
//   overlay made for it where it is (that overlay keeps its identity: its series, its edits).
// - missing: a kept gallery whose source is nowhere: { gid, source }.
// - skipped: a title not to join: 'removed' (removed from the library before: isRemoved) or 'copy'
//   (its overlay's gallery the library has elsewhere). { title, reason }.
export function matchSources({ found, kept = [], overlays = [], known = new Set(), removed = [] }) {
  const out = { same: [], changed: [], moved: [], new: [], missing: [], skipped: [] };
  const keptAt = new Map(kept.map(k => [sourceKey(k.source), { ...k, gid: String(k.gid) }]));
  const keptIds = new Set([...keptAt.values()].map(k => k.gid));
  // An overlay of a gallery the library keeps here says nothing the library doesn't know.
  const overAt = new Map(overlays.filter(o => !keptIds.has(o.galleryId)).map(o => [sourceKey(o.source), o]));
  const foundKeys = new Set(found.map(sourceKey));

  // Where they were: the kept galleries' sources, and each found title with an overlay made for it.
  const loose = [];
  for (const title of found) {
    const k = keptAt.get(sourceKey(title));
    const over = !k && overAt.get(sourceKey(title));
    if (k) {
      const changed = title.fingerprint != null && title.fingerprint !== (k.source.fingerprint ?? null);
      if (changed) out.changed.push({ title, gid: k.gid, was: k.source }); else out.same.push({ title, gid: k.gid });
    } else if (over) {
      if (known.has(over.galleryId)) out.skipped.push({ title, reason: 'copy' }); else out.new.push({ title, gid: over.galleryId });
    } else loose.push(title);
  }

  // Gone from where they were, grouped by what they were in (an archive's chapters together) and its
  // fingerprint: kept galleries first, then overlays whose gallery the library hasn't.
  const gone = [];
  const goneGroup = (source) => {
    const at = `${source.kind}\u0000${source.path}\u0000${source.fingerprint}`;
    let g = gone.find(x => x.at === at);
    if (!g) gone.push(g = { at, kind: source.kind, fingerprint: source.fingerprint, members: new Map(), kept: false });
    return g;
  };
  for (const k of keptAt.values()) {
    if (foundKeys.has(sourceKey(k.source)) || !k.source.fingerprint) continue;
    const g = goneGroup(k.source);
    g.kept = true;
    g.members.set(k.source.inner || '', { gid: k.gid, kept: true, source: k.source });
  }
  for (const [key, o] of overAt) {
    if (foundKeys.has(key) || known.has(o.galleryId) || !o.source.fingerprint) continue;
    const members = goneGroup(o.source).members;
    if (!members.has(o.source.inner || '')) members.set(o.source.inner || '', { gid: o.galleryId, kept: false, source: o.source });
  }
  gone.sort((a, b) => Number(b.kept) - Number(a.kept));

  // The rest found, by what they are in: a group whose fingerprint a gone one has takes its galleries.
  const groups = new Map();
  for (const title of loose) {
    const at = `${title.kind}\u0000${title.path}`;
    if (!groups.has(at)) groups.set(at, []);
    groups.get(at).push(title);
  }
  for (const titles of groups.values()) {
    const print = titles[0].fingerprint;
    const g = print != null && gone.find(x => !x.taken && x.kind === titles[0].kind && x.fingerprint === print);
    if (g) g.taken = true;
    for (const title of titles) {
      const was = g && g.members.get(title.inner || '');
      if (was) { g.members.delete(title.inner || ''); out.moved.push({ title, gid: was.gid, kept: was.kept, was: was.source }); }
      else if (isRemoved(removed, title)) out.skipped.push({ title, reason: 'removed' });
      else out.new.push({ title });
    }
  }

  // Kept galleries whose source is nowhere.
  for (const k of keptAt.values()) {
    if (foundKeys.has(sourceKey(k.source))) continue;
    if (!out.moved.some(m => m.kept && m.gid === k.gid)) out.missing.push({ gid: k.gid, source: k.source });
  }
  return out;
}

// A gallery's metadata as its file or folder name tells it, the way such names are usually written —
// "[Circle (Artist)] Title (Collection)", "[Artist] Title" — and the folders it is in (`folders`,
// outermost first) as tags. Resolves { title, tags }.
export function metaFromName(name, folders = []) {
  const stem = String(name).replace(ARCHIVE_NAME, '').replace(PDF_NAME, '').trim();
  const tags = [];
  let rest = stem;
  const lead = rest.match(/^\[([^\]]+)\]\s*/);
  if (lead) {
    rest = rest.slice(lead[0].length);
    const who = lead[1].trim();
    const pair = who.match(/^(.+?)\s*\((.+)\)$/);
    const add = (type, list) => { for (const n of list.split(/\s*[,&、]\s*/)) if (n) tags.push({ type, name: n.toLowerCase() }); };
    if (pair) { add('group', pair[1]); add('artist', pair[2]); } else add('artist', who);
  }
  const plain = rest.replace(/\s*(\([^)]*\)|\[[^\]]*\]|\{[^}]*\})\s*$/g, '').trim() || rest.trim() || stem;
  for (const f of folders) if (f && !f.startsWith('.')) tags.push({ type: 'tag', name: f.toLowerCase() });
  const seen = new Set();
  return { title: { english: stem, japanese: '', pretty: plain },
    tags: tags.filter(t => { const k = `${t.type}:${t.name}`; if (seen.has(k)) return false; seen.add(k); return true; }) };
}

// linked-source.js — galleries a library folder holds that Shiori didn't make: an archive (zip/cbz)
// or a folder of pictures put there some other way. Their files are used as they are — read, never
// written, moved, renamed, unpacked or deleted — and everything Shiori adds to such a gallery (its
// descriptions, translations, study layers, covers, pages it fetches itself) is kept in an overlay:
// a folder in the gallery format of its own, in the library folder's hidden .shiori/linked/<gallery
// id>/, beside a source.json naming the files it belongs to (where they are in the library folder,
// their size, and a fingerprint that finds them again once moved or renamed). Removing such a
// gallery from the library leaves its files, and notes them in .shiori/linked/removed.json so that
// checking the folder doesn't add them again. Pure: the browser library (db.js) and the desktop
// app's (server/library.js, scan.js) read and write the files.

export const LINKED_DIR = '.shiori/linked';
export const SOURCE_FILE = 'source.json';
export const REMOVED_FILE = `${LINKED_DIR}/removed.json`;
export const overlayDir = (gid) => `${LINKED_DIR}/${gid}`;

export const IMAGE_NAME = /\.(jpe?g|png|webp|gif|avif)$/i;
export const ARCHIVE_NAME = /\.(zip|cbz)$/i;
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => natural.compare(a, b);

// A source as source.json keeps it: { kind: 'zip' | 'dir' | 'pdf', path (in the library folder,
// '/'-separated), inner (for an archive whose folders are titles each: the folder in it, "Name/"),
// size, fingerprint }.
const KINDS = new Set(['zip', 'dir', 'pdf']);
export const sourceText = (galleryId, source) => JSON.stringify({ format: 'shiori-linked', version: 1, galleryId: String(galleryId),
  source: { kind: source.kind, path: source.path, ...(source.inner ? { inner: source.inner } : {}), size: source.size ?? null,
    fingerprint: source.fingerprint ?? null } }, null, 2);
export function parseSource(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  const s = v?.source;
  if (v?.format !== 'shiori-linked' || !v.galleryId || !KINDS.has(s?.kind) || typeof s.path !== 'string') return null;
  return { galleryId: String(v.galleryId), source: { kind: s.kind, path: s.path, ...(typeof s.inner === 'string' && s.inner ? { inner: s.inner } : {}),
    size: s.size ?? null, fingerprint: s.fingerprint ?? null } };
}
// A source's key: what it is and where (two titles of one archive differ by their folder in it).
export const sourceKey = (s) => `${s.kind}\u0000${s.path}\u0000${s.inner || ''}`;

// The sources removed from the library: [{ kind, path, inner?, fingerprint, at }].
export function parseRemoved(text) {
  try { const v = JSON.parse(text); return Array.isArray(v?.removed) ? v.removed.filter(r => typeof r?.path === 'string') : []; } catch { return []; }
}
export const removedText = (list) => JSON.stringify({ format: 'shiori-linked-removed', version: 1, removed: list }, null, 2);
// Whether `source` (as found: { path, fingerprint }) is one of `removed`: the same files where they
// were — one changed since (another fingerprint) counts as new.
export const isRemoved = (removed, source) => removed.some(r => r.path === source.path && (r.inner || '') === (source.inner || '')
  && (!r.fingerprint || !source.fingerprint || r.fingerprint === source.fingerprint));

// What a folder of pictures' fingerprint is made from (hashed by the caller, SHA-256 in hex): its
// pictures' names and sizes. An archive's is its central directory's bytes (import-cbz.js zipEntries).
export const folderPrint = (pictures) => [...pictures].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  .map(p => `${p.name}\t${p.size}`).join('\n');

export const PDF_NAME = /\.pdf$/i;
// The files that say a folder is in the Shiori gallery format (import-files.js, the same).
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
// gallery, or a series when its pictures sit in folders (zipTitles); every PDF a gallery. A folder in the Shiori gallery
// format (the outermost, with all it holds) is Shiori's own, left out. `files`: every file in the
// library folder, [{ path, size? }] ('/'-separated, from its top; hidden ones and the library's own
// .shiori left out here). Resolves [{ kind: 'zip' | 'pdf', path, size } | { kind: 'dir', path ('' for
// the top), name, pictures: [{ path, size }] }].
export function planTitles(files, rootName) {
  const list = files.filter(f => f?.path && !_hidden(f.path));
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1);
  const own = [];
  const depth = (p) => p.split('/').length;
  for (const f of [...list].sort((a, b) => depth(a.path) - depth(b.path))) {
    const name = f.path.slice(f.path.lastIndexOf('/') + 1);
    const dir = dirOf(f.path);
    if (LAYOUT_FILES.has(name) && dir && !own.some(o => dir.startsWith(o))) own.push(dir);
  }
  const titles = [];
  const folders = new Map();   // a folder ('' for the top) → its own pictures
  for (const f of list) {
    if (own.some(o => f.path.startsWith(o))) continue;
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

// An archive's galleries (`names`: its entries' names), as the import makes them: its pictures in
// order — or, when they sit in more than one folder, a series (the archive) of chapters: each folder
// holding pictures one, named after it (folders holding only folders don't count), the pictures
// beside the folders opening the first. Resolves [{ inner ('' or "Folder/": the chapter's folder in
// the archive), pictures: [names], chapter (in a series) }].
export function zipTitles(names) {
  const pictures = sortPictures(names.filter(n => IMAGE_NAME.test(n) && !_hidden(n)).map(path => ({ path }))).map(p => p.path);
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

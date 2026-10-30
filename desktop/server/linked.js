// linked.js — the galleries a library folder holds that Shiori didn't make (linked-source.js, in the
// app: what counts as one, their overlays, source.json and removed.json), as the desktop library
// keeps them: its index row for each (files.js `source`) and pages at 'x' (in the source), read where
// they are; everything Shiori adds in the gallery's overlay. The full check (scan.js) hands this the
// files of each library folder it doesn't know; a PDF's pages are drawn by a window (pdfsWaiting,
// pdfSource, addRendered), as the import draws them.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readDirectory } from './zip.js';
import { linked as L, files as layout, BackendError } from './shared.js';
import { readDerived, derivedRecord } from './scan.js';

const TYPE_OF_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
const typeOf = (name) => TYPE_OF_EXT[String(name).match(/\.(\w+)$/)?.[1]?.toLowerCase()] || '';
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const PAGE_URL = /\/(\d+)\.\w+$/;
const keyPage = (key) => { const m = String(key ?? '').match(PAGE_URL); return m ? parseInt(m[1], 10) : null; };

const absIn = (library, root, rel) => path.join(library.rootDir(root), ...String(rel).split('/').filter(Boolean));

// An archive's fingerprint, as the app's (zip-read.js zipEntries): the SHA-256 of its central directory.
async function zipFingerprint(abs) {
  const fh = await fsp.open(abs, 'r');
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
// with its fingerprint and size; null when they can't be read.
async function titleAt(library, root, title) {
  const abs = absIn(library, root, title.path);
  if (title.kind === 'zip') {
    const dir = await readDirectory(abs).catch(() => null);
    if (!dir) return null;
    const mine = L.zipTitles([...dir.keys()]).find(z => z.inner === (title.inner || ''));
    if (!mine) return null;
    return { pictures: mine.pictures.map(name => ({ name, size: dir.get(name).size })), fingerprint: await zipFingerprint(abs).catch(() => null),
      size: (await fsp.stat(abs)).size, directory: dir };
  }
  if (title.kind === 'dir') {
    const pictures = [];
    for (const item of await fsp.readdir(abs, { withFileTypes: true }).catch(() => [])) {
      if (!item.isFile() || !L.IMAGE_NAME.test(item.name) || item.name.startsWith('.')) continue;
      const st = await fsp.stat(path.join(abs, item.name)).catch(() => null);
      if (st) pictures.push({ name: item.name, path: item.name, size: st.size });
    }
    const sorted = L.sortPictures(pictures);
    return { pictures: sorted, fingerprint: sha256(L.folderPrint(sorted)), size: sorted.reduce((n, p) => n + p.size, 0) };
  }
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) return null;
  const fh = await fsp.open(abs, 'r');
  try {
    const head = Buffer.alloc(Math.min(st.size, 1024 * 1024));
    await fh.read(head, 0, head.length, 0);
    return { pictures: [], fingerprint: `${st.size}:${sha256(head)}`, size: st.size };
  } finally { await fh.close(); }
}

// The overlays library folder `root` holds: source key → { galleryId, source }.
export async function overlaysOf(library, root) {
  const out = new Map();
  const dir = absIn(library, root, L.LINKED_DIR);
  for (const item of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!item.isDirectory()) continue;
    const read = L.parseSource(await fsp.readFile(path.join(dir, item.name, L.SOURCE_FILE), 'utf8').catch(() => null));
    if (read && read.galleryId === item.name) out.set(L.sourceKey(read.source), read);
  }
  return out;
}
const removedOf = async (library, root) => L.parseRemoved(await fsp.readFile(absIn(library, root, L.REMOVED_FILE), 'utf8').catch(() => null));

// Title `title`'s overlay, made as gallery `gid`'s (its source.json written). Resolves its path in
// the library (files.js: `@<root>/…` beyond the first folder).
async function overlayFor(library, root, title, gid, at) {
  const rel = L.overlayDir(gid);
  const file = path.join(absIn(library, root, rel), L.SOURCE_FILE);
  const want = L.sourceText(gid, { ...title, size: at?.size ?? null, fingerprint: at?.fingerprint ?? null });
  if (await fsp.readFile(file, 'utf8').catch(() => null) !== want) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, want);
  }
  return library.files._join(root, rel);
}

// Title `title` of library folder `root` joined to the library as a linked gallery: its pages in its
// source (at 'x'), and its overlay's own (images/: a PDF's, drawn); its metadata its overlay's when
// it has some, else an archive's own (metadata.json in it), else what its name and folders say —
// as gallery `gid` (its overlay's) or a new one. `replace`: a gallery the index keeps, read again (its
// rows replaced, its files kept). Resolves its id, or null when it has no pages.
export async function adoptLinked(library, root, title, { gid: given = null, replace = null } = {}) {
  const at = await titleAt(library, root, title);
  if (!at) return null;
  let embedded = null;
  if (title.kind === 'zip' && !title.inner && at.directory?.has('metadata.json')) {
    const { readEntry } = await import('./zip.js');
    embedded = parse(String(await readEntry(absIn(library, root, title.path), at.directory.get('metadata.json')).catch(() => null)));
  }
  const taken = (id) => !!library._s('SELECT 1 FROM meta WHERE gid = ?').get(id) || !!library._s('SELECT 1 FROM files WHERE gid = ?').get(id);
  const embeddedId = embedded?.galleryId != null && /^\d{13,}$/.test(String(embedded.galleryId)) && !taken(String(embedded.galleryId)) ? String(embedded.galleryId) : null;
  const gid = replace || given || embeddedId || library.nextGalleryId();
  if (!replace && taken(gid)) return null;
  const rel = await overlayFor(library, root, title, gid, at);
  const overlay = library.files._abs(rel);
  const text = (name) => fsp.readFile(path.join(overlay, ...name.split('/')), 'utf8').catch(() => null);
  const texts = Object.fromEntries(await Promise.all(layout.DESCRIPTION_FILES.map(async (n) => [n, await text(n)])));
  const meta = parse(texts['metadata.json']);
  const records = parse(texts['image_records.json']);
  const derived = await readDerived(overlay);
  const entryOf = new Map((Array.isArray(records) ? records : []).map(r => [keyPage(r?.url), r]).filter(([n]) => n != null));
  // Its pages: its source's in order, then its overlay's own (a PDF's, drawn).
  const byN = new Map(at.pictures.map((p, i) => [i + 1, { orig: { at: 'x', entry: p.name, size: p.size, type: typeOf(p.name) }, ext: p.name.match(/\.(\w+)$/)?.[1]?.toLowerCase() || 'jpg' }]));
  for (const name of await fsp.readdir(path.join(overlay, 'images')).catch(() => [])) {
    const m = name.match(/^(\d+)\.(\w+)$/);
    if (!m || byN.has(Number(m[1])) || !L.IMAGE_NAME.test(name)) continue;
    const st = await fsp.stat(path.join(overlay, 'images', name)).catch(() => null);
    if (st) byN.set(Number(m[1]), { orig: { at: 'p', entry: `images/${name}`, size: st.size, type: typeOf(name) }, ext: m[2].toLowerCase() });
  }
  if (!byN.size) return null;
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
    : { galleryId: gid, ...named, numPages: byN.size, isLocalImport: true, source: '' };
  const source = { kind: title.kind, path: title.path, ...(title.inner ? { inner: title.inner } : {}), ...(at.fingerprint ? { fingerprint: at.fingerprint } : {}) };
  const files = library.files;
  library._tx(() => {
    if (replace) {
      files.keep.add(gid);
      try { library._deleteIn(gid); } finally { files.keep.delete(gid); }
    }
    library._metaPutRaw(record);
    for (const [n, p] of [...byN].sort((a, b) => a[0] - b[0])) {
      const entry = entryOf.get(n);
      let key = entry?.url && keyPage(entry.url) === n ? entry.url : `local://${gid}/${n}.${p.ext}`;
      if (library._pageRowByKey(key)) key = `local://${gid}/${n}.${p.ext}`;
      if (library._pageRowByKey(key) || library._pageRow(gid, n)) continue;
      library._pagePutRow({ gid, n, key, w: null, h: null, orig: p.orig, record: { url: key, blob: { $orig: 1, size: p.orig.size, type: p.orig.type },
        mediaId: String(entry?.mediaId ?? gid), galleryId: gid, cachedAt: entry?.cachedAt || now, size: p.orig.size, ...derivedRecord(derived, n, entry) } });
    }
    library._s(`INSERT OR REPLACE INTO files (gid, path, format, state, packed_at, used_at, source) VALUES (?, ?, 'folder', 'packed', ?, ?, ?)`)
      .run(gid, rel, now, now, JSON.stringify(source));
    if (texts['metadata.json'] != null) library._s('INSERT OR REPLACE INTO stamps (gid, stamp) VALUES (?, ?)').run(gid, layout.descriptionStamp(texts));
    library._logIn(gid);
  });
  await library.rebuildGalleryEntry(gid, { silent: true });
  if (derived.cover) library._tx(() => library._coverPatchIn(gid, { cover: derived.cover }));
  if (texts['metadata.json'] == null) files.describeLater(gid);   // its overlay describes it, in due course
  if (replace) library._push('control', { type: 'COVER_INVALIDATED', galleryId: gid });
  return gid;
}

// What library folder `root` holds that isn't Shiori's (`files`: its pictures and PDFs the index
// doesn't keep, [{ path }] in it; `archives`: its archives not in the gallery format), joined to
// the library as linked galleries — as the app's folderScan does (db.js): a title already kept is
// left; one removed from the library before isn't added again; one with an overlay comes back with
// it; an archive's chapters, new, become a series named after it; a title moved or renamed takes its
// overlay — or a gallery the index keeps — back by its fingerprint. `onProgress(done, total, step,
// added)` as it goes, in two steps each counted on its own: what is there ('lf.task_checking'), then
// the galleries joining ('lf.task_adding'). Resolves { added, updated }.
export async function linkRoot(library, root, { files = [], archives = [], stopped = () => false, onProgress = () => {} } = {}) {
  const out = { added: [], updated: [] };
  const lf = library.files;
  const kept = new Map();
  for (const row of library._s('SELECT gid, path, source FROM files WHERE source IS NOT NULL').all()) {
    if (lf._split(row.path).root !== root) continue;
    const src = lf.sourceOf(row);
    if (src) kept.set(L.sourceKey(src), { gid: row.gid, source: src });
  }
  const overlays = await overlaysOf(library, root);
  const removed = await removedOf(library, root);
  const known = (gid) => !!library._s('SELECT 1 FROM files WHERE gid = ?').get(gid);
  const planned = [...L.planTitles(files, path.basename(library.rootDir(root))).filter(t => t.kind !== 'zip'),
    ...archives.map(p => ({ kind: 'zip', path: p }))];
  const seen = new Set(), fresh = [], series = [];
  let step = 'lf.task_checking', total = planned.length, done = 0;
  const say = () => onProgress(Math.min(done, total), total, step, out.added.length);
  say();
  const link = async (title, gid) => {
    if (title.kind === 'pdf') {
      const has = gid && (await fsp.readdir(path.join(absIn(library, root, L.overlayDir(gid)), 'images')).catch(() => [])).length;
      if (!has) { await overlayFor(library, root, title, gid || library.nextGalleryId(), await titleAt(library, root, title)); return null; }
    }
    const made = await adoptLinked(library, root, title, { gid }).catch(() => null);
    if (made) out.added.push(made);
    return made;
  };
  for (const t of planned) {
    if (stopped()) break;
    let titles = [{ kind: t.kind, path: t.path, ...(t.name ? { name: t.name } : {}) }];
    if (t.kind === 'zip') {
      const dir = await readDirectory(absIn(library, root, t.path)).catch(() => null);
      titles = dir ? L.zipTitles([...dir.keys()]).map(z => ({ kind: 'zip', path: t.path, ...(z.inner ? { inner: z.inner } : {}), chapter: z.chapter })) : [];
    }
    const chapters = [];
    for (const title of titles) {
      const key = L.sourceKey(title);
      seen.add(key);
      if (kept.has(key)) continue;
      const over = overlays.get(key);
      if (over && known(over.galleryId)) continue;
      if (!over && L.isRemoved(removed, title)) continue;
      if (over) fresh.push({ title, gid: over.galleryId });   // its overlay keeps its series
      else if (title.chapter) chapters.push(title);
      else fresh.push({ title });
    }
    if (chapters.length) series.push({ path: t.path, chapters });
    done++;
    say();
  }
  // New ones: an overlay whose files moved or were renamed takes them back (the same fingerprint) —
  // as does a gallery the index keeps, its files gone from where it had them.
  const orphans = new Map();
  for (const [key, over] of overlays) if (!seen.has(key) && over.source.fingerprint) orphans.set(over.source.fingerprint, { galleryId: over.galleryId, kept: known(over.galleryId) });
  for (const [key, k] of kept) if (!seen.has(key) && k.source.fingerprint) orphans.set(k.source.fingerprint, { galleryId: k.gid, kept: true });
  step = 'lf.task_adding';
  total = fresh.length + series.reduce((n, s) => n + s.chapters.length, 0);
  done = 0;
  say();
  for (const { title, gid } of fresh) {
    if (stopped()) break;
    const print = !gid && orphans.size ? (await titleAt(library, root, title).catch(() => null))?.fingerprint : null;
    const was = print && orphans.get(print);
    if (was) orphans.delete(print);
    if (was?.kept) { if (await adoptLinked(library, root, title, { replace: was.galleryId }).catch(() => null)) out.updated.push(was.galleryId); }
    else await link(title, gid || was?.galleryId || null);
    done++;
    say();
  }
  // An archive's chapters, new: joined as a series named after it (the import does the same).
  for (const { path: zip, chapters } of series) {
    if (stopped()) break;
    const made = [];
    for (const title of chapters) {
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
// The PDFs the library's folders hold waiting for their pages: [{ folder, gid, path, name }].
export async function pdfsWaiting(library) {
  const out = [];
  for (const root of library.activeRoots()) {
    if (!fs.existsSync(library.rootDir(root))) continue;
    const removed = await removedOf(library, root);
    for (const over of (await overlaysOf(library, root)).values()) {
      if (over.source.kind !== 'pdf' || library._s('SELECT 1 FROM files WHERE gid = ?').get(over.galleryId) || L.isRemoved(removed, over.source)) continue;
      if (!fs.existsSync(absIn(library, root, over.source.path))) continue;
      out.push({ folder: root, gid: over.galleryId, path: over.source.path, name: over.source.path.split('/').pop() });
    }
  }
  return out;
}
async function waiting(library, root, gid) {
  library.rootDir(root);
  const over = [...(await overlaysOf(library, root)).values()].find(o => o.galleryId === String(gid));
  if (!over || over.source.kind !== 'pdf') throw new BackendError('not-found', `no PDF waiting as gallery ${gid}`);
  return over;
}
// The PDF a waiting gallery is drawn from.
export async function pdfSource(library, root, gid) {
  const over = await waiting(library, root, gid);
  return new Blob([await fsp.readFile(absIn(library, root, over.source.path))], { type: 'application/pdf' });
}
// A waiting PDF's pages, drawn (Blobs in order), kept in its overlay and the gallery joined to the
// library. Resolves its id.
export async function addRendered(library, root, gid, pages) {
  library.folders.assertWritable(root);
  const over = await waiting(library, root, gid);
  const dir = path.join(absIn(library, root, L.overlayDir(gid)), 'images');
  await fsp.mkdir(dir, { recursive: true });
  for (const [i, blob] of (pages || []).entries()) {
    const name = layout.layoutPath.original(i + 1, layout.extOfType(blob.type) || 'webp').split('/').pop();
    const bytes = Buffer.from(await blob.arrayBuffer());
    await fsp.writeFile(path.join(dir, name), bytes);
    library.writes.add('pages', bytes.length);
  }
  const made = await adoptLinked(library, root, over.source, { gid: String(gid) });
  if (made) library.publishFeed(made);
  return made;
}


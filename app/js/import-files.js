// import-files.js — what a picked or dropped set of files imports as. Each archive is one gallery
// as it is, each PDF is one gallery with an image per PDF page, and loose images together make one
// more gallery. A dropped folder is read the same way, its subfolders included: its images go in
// under their paths in it, as one archive named after it (which the import engine makes a series
// of when they sit in more than one folder, as it does any archive) — except a folder in the Shiori
// gallery format (gallery-files.js: one holding metadata.json, image_records.json or series.json),
// which goes in whole, as the archive it would be if zipped, so each such gallery or series inside
// a dropped folder is imported as itself.
// The import engine receives a zip — staged for the durable runner like any — or, for loose images
// and a dropped folder, their files as a zip's entries, imported from where they are (jobs-runner.js
// startImport). Runs in a page only (PDF pages are drawn on a canvas).

import { zipCreate } from './zip.js';
import { isValidGalleryId } from './sanitize.js';
// Static, not lazy: the service worker runs imports too, and a worker can't import() (pdf.js, below,
// is a page's only).
import { zipEntries, sha256Hex } from './import-cbz.js';

const ARCHIVE = /\.(zip|cbz)$/i;
const PDF = /\.pdf$/i;
const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;

// For a file picker's accept attribute.
export const IMPORT_ACCEPT = '.cbz,.zip,.pdf,.jpg,.jpeg,.png,.webp,.gif,.avif';

export const isImportable = (file) => ARCHIVE.test(file.name) || PDF.test(file.name) || IMAGE.test(file.name);

const _stem = (name) => name.replace(/\.[^./]+$/, '');
const _natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Natural order by path, folder by folder; the extension doesn't count ("2.png" before "10.jpg").
function _byPath(a, b) {
  const pa = _stem(a.path).split('/'), pb = _stem(b.path).split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const c = _natural(pa[i], pb[i]);
    if (c) return c;
  }
  return pa.length - pb.length;
}

// → [{ files, name }]: each archive or PDF on its own, then the loose images together, then the
// same for each folder ([{ name, entries: [{ file, path }] }], as droppedImports reads them), whose
// images are named after it. `name` is a file name; the gallery's title is that name without its
// extension.
export function groupImports(files, folders = []) {
  return [
    ..._groups([...files].map((file) => ({ file, path: file.name })), _imagesTitle),
    ...folders.flatMap(_folderGroups),
  ];
}

// The files that say a folder is in the Shiori gallery format.
const LAYOUT_FILES = new Set(['metadata.json', 'image_records.json', 'series.json']);

// A dropped folder's groups: each folder in the Shiori gallery format within it (the outermost —
// a series' members go with their series) whole, its files under their paths in it; whatever else
// it holds, as any folder. Each file is placed by looking up its own folders, so a folder of any
// number of galleries is sorted in one pass.
function _folderGroups(folder) {
  const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);
  // The outermost format folder holding `path` ("" for the dropped folder itself), else null.
  const rootOf = (path, roots) => {
    for (let at = 0; at !== -1; at = path.indexOf('/', at) + 1 || -1) if (roots.has(path.slice(0, at))) return path.slice(0, at);
    return null;
  };
  const roots = new Map();   // root → its entries, in the order the roots are found (shallowest first)
  const depth = (path) => path.split('/').length;
  const layout = folder.entries.filter((e) => LAYOUT_FILES.has(e.path.slice(e.path.lastIndexOf('/') + 1)));
  for (const { path } of layout.sort((a, b) => depth(a.path) - depth(b.path))) {
    if (rootOf(path, roots) == null) roots.set(dirOf(path), []);
  }
  const rest = [];
  for (const e of folder.entries) {
    const root = rootOf(e.path, roots);
    (root == null ? rest : roots.get(root)).push(e);
  }
  const groups = [...roots].map(([root, inside]) => {
    inside.sort(_byPath);
    const name = root ? root.slice(0, -1).split('/').pop() : folder.name;
    const read = inside.filter((e) => e.file);
    const unreadable = inside.filter((e) => !e.file).map((e) => e.path);
    return { files: read.map((e) => e.file), paths: read.map((e) => e.path.slice(root.length)), name: `${name}.zip`, ...(unreadable.length ? { unreadable } : {}) };
  });
  // All of it imported where it is, an archive or PDF in it too: a dropped folder is never copied first.
  return [...groups, ..._groups(rest, () => folder.name)].map((g) => ({ ...g, fromFolder: true }));
}

// An entry is { file, path }, or { file: null, path } for one the browser couldn't open
// (droppedImports): a folder's ends in "/", and may have held pictures. A group with such entries
// says so (`unreadable`, their paths), so it fails whole rather than coming in with pages missing.
const _nameOf = (path) => path.replace(/\/$/, '').split('/').pop();
function _groups(entries, imagesTitle) {
  const list = entries.filter(({ file, path }) => (file ? isImportable(file) : path.endsWith('/') || isImportable({ name: _nameOf(path) }))).sort(_byPath);
  const isImage = ({ path }) => path.endsWith('/') || IMAGE.test(path);
  const groups = list.filter((e) => !isImage(e)).map(({ file, path }) => (file ? { files: [file], name: file.name } : { files: [], name: _nameOf(path), unreadable: [path] }));
  const images = list.filter(isImage);
  if (images.length) {
    const read = images.filter(({ file }) => file);
    const files = read.map(({ file }) => file);
    const unreadable = images.filter(({ file }) => !file).map(({ path }) => path);
    groups.push({ files, paths: read.map(({ path }) => path), name: `${imagesTitle(files)}.zip`, ...(unreadable.length ? { unreadable } : {}) });
  }
  return groups;
}

// A drop's files and folders → { files, folders } for groupImports. Call it straight from the drop
// handler: the dropped items can only be listed before the event ends. Each folder is read in full,
// its subfolders flattened into it (their pictures, archives, PDFs and the format's JSON files);
// hidden files and folders (".name") are left out. A file or folder the browser can't open (on
// Windows, one whose path is 260 characters or longer) is listed without its file, so the gallery
// holding it fails on its own and the rest of the drop still imports. `leftOut` counts the files that
// are none of these; onProgress(found) says how many files the folders have shown so far.
export async function droppedImports(dataTransfer, onProgress = () => {}) {
  const files = [], dirs = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) dirs.push(entry);
    else { const file = item.getAsFile(); if (file) files.push(file); }
  }
  const folders = [];
  const count = { found: 0, leftOut: 0, onProgress };
  for (const dir of dirs) folders.push({ name: dir.name, entries: await _readFolder(dir, '', count) });
  return { files, folders, leftOut: count.leftOut };
}

async function _readFolder(dir, prefix, count) {
  const out = [];
  const reader = dir.createReader();
  // readEntries hands a folder over in batches; an empty one means it's done.
  for (;;) {
    let batch;
    try { batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); }
    catch { out.push({ file: null, path: prefix }); break; }
    if (!batch.length) break;
    for (const entry of batch) {
      if (entry.name.startsWith('.')) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory) { out.push(...await _readFolder(entry, `${path}/`, count)); continue; }
      count.onProgress(++count.found);
      if (isImportable(entry) || /\.json$/i.test(entry.name)) {
        out.push({ file: await new Promise((resolve, reject) => entry.file(resolve, reject)).catch(() => null), path });
      } else count.leftOut++;
    }
  }
  return out;
}

// What a title is, as a fingerprint: the same files always give the same one, and any changed byte
// another. An archive is known by its own index (each entry's name, size and CRC-32, import-cbz.js
// zipEntries), so it isn't read; a folder's files and a PDF by their contents, read a piece at a
// time. Null where the browser can't hash.
export async function importFingerprint({ files, paths }) {
  if (!globalThis.crypto?.subtle) return null;
  if (!paths) return ARCHIVE.test(files[0].name) ? `zip:${(await zipEntries(files[0])).fingerprint}` : `pdf:${await _contentHash(files[0])}`;
  const lines = [];
  for (const [i, f] of files.entries()) {
    const sum = ARCHIVE.test(paths[i]) ? `zip:${(await zipEntries(f)).fingerprint}` : await _contentHash(f);
    lines.push(`${paths[i]}\n${f.size}\n${sum}\n`);
  }
  return `files:${await sha256Hex(new TextEncoder().encode(lines.join('')))}`;
}

// A file's contents as the SHA-256 of its pieces' SHA-256s (a file past 2 GiB can't be read whole).
const HASH_PIECE = 8 * 1024 * 1024;
async function _contentHash(file) {
  const sums = [];
  for (let at = 0; at === 0 || at < file.size; at += HASH_PIECE) sums.push(await sha256Hex(await file.slice(at, at + HASH_PIECE).arrayBuffer()));
  return sha256Hex(new TextEncoder().encode(sums.join('')));
}

// The gallery a title says it is, when it is in the Shiori gallery format (gallery-files.js): its
// metadata.json's id — a series', its first member's that has files, as the import engine makes it
// the series' owner — so its card is the one the import fills. Null for anything else.
export async function importTarget({ files, paths }) {
  const entries = paths ? files.map((f, i) => ({ filename: paths[i], read: async () => new Uint8Array(await f.arrayBuffer()) }))
    : ARCHIVE.test(files[0].name) ? await zipEntries(files[0]) : [];
  const json = async (name) => {
    const entry = entries.find((e) => e.filename === name);
    try { return entry ? JSON.parse(new TextDecoder().decode(await entry.read())) : null; } catch { return null; }
  };
  const id = (v) => (v != null && isValidGalleryId(v) ? String(v) : null);
  const series = await json('series.json');
  if (Array.isArray(series?.chapters) && series.chapters.length) {
    for (const [i, c] of series.chapters.entries()) {
      const folder = `${String(c.folder || `chapter-${String(i + 1).padStart(2, '0')}`).replace(/\/+$/, '')}/`;
      if (!entries.some((e) => e.filename.startsWith(folder))) continue;
      return id((await json(`${folder}metadata.json`))?.galleryId) || id(c.id);
    }
    return null;
  }
  return id((await json('metadata.json'))?.galleryId);
}

// Loose images are named for what their file names share ("Ch 3 - 001", "Ch 3 - 002" → "Ch 3"),
// else for the first image. The shared part ends in the page numbers' common digits, dropped here.
function _imagesTitle(images) {
  const stems = images.map((f) => _stem(f.name));
  let common = stems[0];
  for (const s of stems) while (!s.startsWith(common)) common = common.slice(0, -1);
  return (stems.length > 1 && common.replace(/\d+$/, '').replace(/[\s._\-#([]+$/, '')) || stems[0];
}

// Why a group can't be imported — files the browser couldn't open (droppedImports) — or null.
export const unreadableError = ({ unreadable }) => (unreadable?.length
  ? new Error(`${unreadable.length} of its files could not be opened, the first: ${unreadable[0]}`) : null);

// What the import engine reads for one group: a zip, or a zip's entries. An archive passes through
// untouched, as the file it is (the engine reads it a piece at a time, so its size is not bound by
// what fits one buffer). Images, and a folder in the Shiori gallery format, go as the engine's
// entries ([{ filename, size, read, blob }], import-cbz.js zipEntries) under their paths
// (`paths`), each file read only when the engine takes it — and a page not even then: it goes into
// the library as the file it is, so a folder of any size never sits in memory — a member of a
// series kept as an archive in its series' folder (Shiori Desktop archives galleries left alone)
// going in as the folder it is the archive of. A PDF is a zip of its pages, reporting them as they
// are drawn via onProgress({ done, total }).
export async function importBytes(group, onProgress = () => {}) {
  const { files, paths } = group;
  const unreadable = unreadableError(group);
  if (unreadable) throw unreadable;
  if (paths) {
    const out = [];
    for (const [i, f] of files.entries()) {
      if (!ARCHIVE.test(paths[i])) {
        out.push({ filename: paths[i], size: f.size,
          read: async () => new Uint8Array(await f.arrayBuffer()), blob: async (type = '') => f.slice(0, f.size, type) });
        continue;
      }
      for (const e of await zipEntries(f)) out.push({ ...e, filename: `${_stem(paths[i])}/${e.filename}` });
    }
    return out;
  }
  if (ARCHIVE.test(files[0].name)) return files[0];
  const pages = await _renderPdf(files[0], onProgress);
  return zipCreate(pages.map((p, i) => ({ name: `${i + 1}.${p.ext}`, data: p.data })));
}

// ── PDF pages ──

const PDFJS = new URL('../../vendor/pdfjs/', import.meta.url).href;

// A page's size as its long side in pixels. A page that is one scanned image keeps the scan's own
// size; any other page is drawn at DEFAULT_LONG. The bounds keep a page a sane canvas.
const DEFAULT_LONG = 2048, MIN_LONG = 1024, MAX_LONG = 5000;
// Lossless (WebP at quality 1): a drawn page is stored exactly as drawn, never degraded further.
const PAGE_FORMAT = { type: 'image/webp', quality: 1, ext: 'webp' };

async function _renderPdf(file, onProgress) {
  const pdfjs = await import(`${PDFJS}pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()), wasmUrl: PDFJS, useWorkerFetch: true,
  });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress({ done: n - 1, total: doc.numPages });
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const long = Math.min(Math.max(_scanLong(await page.getOperatorList(), pdfjs.OPS, base) || DEFAULT_LONG, MIN_LONG), MAX_LONG);
      const viewport = page.getViewport({ scale: long / Math.max(base.width, base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      page.cleanup();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, PAGE_FORMAT.type, PAGE_FORMAT.quality));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error(`Could not draw page ${n}.`);
      pages.push({ ext: PAGE_FORMAT.ext, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    return pages;
  } finally {
    task.destroy();
  }
}

// The long side, in pixels, of the largest image with the page's own shape — the scan, when the
// page is a scanned image. 0 when there is none.
function _scanLong({ fnArray, argsArray }, OPS, { width, height }) {
  const shape = (w, h) => Math.abs(Math.log(w / h));
  let long = 0;
  fnArray.forEach((fn, i) => {
    const a = argsArray[i];
    const [w, h] = fn === OPS.paintImageXObject ? [a[1], a[2]]
      : fn === OPS.paintImageMaskXObject || fn === OPS.paintInlineImageXObject ? [a[0].width, a[0].height] : [];
    if (w && h && Math.abs(shape(w, h) - shape(width, height)) < 0.05) long = Math.max(long, w, h);
  });
  return long;
}

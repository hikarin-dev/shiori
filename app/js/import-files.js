// import-files.js — what a picked or dropped set of files imports as. Each archive is one gallery
// as it is, each PDF is one gallery with an image per PDF page, and loose images together make one
// more gallery. A dropped folder is read the same way, its subfolders included: its images make one
// gallery named after it. The import engine always receives a zip, so staging and the durable runner
// are the same for every kind. Runs in a page only (PDF pages are drawn on a canvas).

import { zipCreate } from './zip.js';

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
    ...folders.flatMap((folder) => _groups(folder.entries, () => folder.name)),
  ];
}

function _groups(entries, imagesTitle) {
  const list = entries.filter(({ file }) => isImportable(file)).sort(_byPath).map(({ file }) => file);
  const images = list.filter((f) => IMAGE.test(f.name));
  const groups = list.filter((f) => !IMAGE.test(f.name)).map((f) => ({ files: [f], name: f.name }));
  if (images.length) groups.push({ files: images, name: `${imagesTitle(images)}.zip` });
  return groups;
}

// A drop's files and folders → { files, folders } for groupImports. Call it straight from the drop
// handler: the dropped items can only be listed before the event ends. Each folder is read in full,
// its subfolders flattened into it; hidden files (".name") are left out.
export async function droppedImports(dataTransfer) {
  const files = [], dirs = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) dirs.push(entry);
    else { const file = item.getAsFile(); if (file) files.push(file); }
  }
  const folders = [];
  for (const dir of dirs) folders.push({ name: dir.name, entries: await _readFolder(dir) });
  return { files, folders };
}

async function _readFolder(dir, prefix = '') {
  const out = [];
  const reader = dir.createReader();
  // readEntries hands a folder over in batches; an empty one means it's done.
  for (let batch; (batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))).length;) {
    for (const entry of batch) {
      if (entry.name.startsWith('.')) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory) out.push(...await _readFolder(entry, `${path}/`));
      else if (isImportable(entry)) out.push({ file: await new Promise((resolve, reject) => entry.file(resolve, reject)), path });
    }
  }
  return out;
}

// Loose images are named for what their file names share ("Ch 3 - 001", "Ch 3 - 002" → "Ch 3"),
// else for the first image. The shared part ends in the page numbers' common digits, dropped here.
function _imagesTitle(images) {
  const stems = images.map((f) => _stem(f.name));
  let common = stems[0];
  for (const s of stems) while (!s.startsWith(common)) common = common.slice(0, -1);
  return (stems.length > 1 && common.replace(/\d+$/, '').replace(/[\s._\-#([]+$/, '')) || stems[0];
}

// The zip the import engine reads for one group. An archive passes through untouched; a PDF
// reports its pages as they are drawn via onProgress({ done, total }).
export async function importBytes({ files }, onProgress = () => {}) {
  if (ARCHIVE.test(files[0].name)) return files[0].arrayBuffer();
  const pages = PDF.test(files[0].name)
    ? await _renderPdf(files[0], onProgress)
    : await Promise.all(files.map(async (f) => ({
      ext: f.name.match(IMAGE)[1].toLowerCase(), data: new Uint8Array(await f.arrayBuffer()),
    })));
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

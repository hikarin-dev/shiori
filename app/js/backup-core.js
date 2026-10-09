// backup-core.js — the full backup (.shioridb) itself: its format, the checks a file passes before
// anything is restored from it, the settings it carries, how one is made and how one is restored.
// Pure: the library it reads from or restores into and the file it writes are handed in, so this
// browser (backup.js) and the desktop app (desktop/server/backup.js) make and restore backups with
// the same code.
//
// Format, version 9 — one file:
//   [ gallery sections … ][ index JSON ][ uint32 LE index length ]
//   a gallery section is [ its pictures … ][ its gallery JSON ]
// Every picture is referenced as { off, len, type, h } (h: its SHA-256, base64); the index lists
// each gallery JSON as { id, off, len, h, pages, bytes } with the archive's id (a random one per
// backup), true counts and the portable settings. The tail is laid out as version 8's, whose
// "manifest" sat where the index does — so an app that knows only version 8 reads the index, sees
// a newer version, and says so instead of failing oddly.
// Versions 2–8 (one manifest: images, covers, metadata, galleries, sourceIcons, settings) are
// still read. They carry no checksums: they are checked for their structure and their pictures'
// signatures, not certified against the bytes that were saved.

import { isValidGalleryId } from './sanitize.js';
import { BUBBLE_EXTRA_FIELDS } from './gallery-files.js';

export const FORMAT = 'shiori-db';
export const VERSION = 9;
const PIPELINE_MASKS = ['raw', 'text'];

// What can be read at once. A version 9 index or gallery JSON is small (a gallery's is tens of KB);
// a version 8 manifest held the whole library's records and has to fit in one string.
const MAX_INDEX = 256 * 1024 * 1024;
const MAX_GALLERY_JSON = 128 * 1024 * 1024;
const MAX_LEGACY_MANIFEST = 500 * 1024 * 1024;
const MAX_KEY = 2048;

// A page's key ends in its page number and image type ("…/12.webp"): the number the library
// addresses it by (db.js PAGE_URL).
const PAGE_URL = /\/(\d+)\.(webp|jpg|jpeg|png|gif|avif)$/i;
const pageNumOf = (key) => { const m = String(key ?? '').match(PAGE_URL); return m ? parseInt(m[1], 10) : null; };

// ── Errors ──
// A file that can't be restored at all: `code` says why (the app words it), `detail` is for the
// person who wants to know more.
//   not-backup  not a Shiori backup         truncated  cut short (an incomplete download)
//   newer       made by a newer Shiori      too-large  more than can be read here
//   corrupt     damaged or tampered with    unsafe     ids that could inject markup
//   unreadable  the file can't be read any more (moved, changed, or still being written)
export class BackupError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BackupError';
    this.code = code;
    this.detail = detail;
  }
}
const corrupt = (detail) => new BackupError('corrupt', detail);

// A gallery that can't be restored, while the rest can: `reason` says why.
//   invalid   its records are malformed          checksum  its bytes aren't the ones saved
//   conflict  its pages belong to another gallery already in the library
//   orphan    pages with no gallery details       failed    the library refused it
class GalleryProblem extends Error {
  constructor(reason, detail = '') { super(detail || reason); this.reason = reason; this.detail = detail; }
}

// ── Small helpers ──
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const safeInt = (v) => Number.isSafeInteger(v) && v >= 0;
const finiteOrAbsent = (v) => v == null || (typeof v === 'number' && Number.isFinite(v));
const enc = (s) => new TextEncoder().encode(s);

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/=+$/, '');
}
// SHA-256 of `bytes` (an ArrayBuffer or a view), base64 without padding.
export async function sha256(bytes) {
  return toBase64(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}

// `fn` over `items`, at most `limit` at a time; results in order. Once one fails no more are
// started, and it rejects only when those under way have finished.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0, failure = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { failure ??= { e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.e;
  return out;
}

// A local calendar date for file names (the person's day, not UTC's).
export function localDate(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// ── Settings ──
// What follows a library to another browser or computer: preferences about how the app looks and
// reads — never what describes this device (which library it uses and how it reaches it, pairing,
// caches, repair state, counters). An allowlist: a setting added later stays on its device until
// it is listed here (app/tests/backup-settings.test.mjs makes every new key be decided).
export const PORTABLE_SETTINGS = new Set([
  'customScrollbar',
  'libQuickActionsMode', 'libHideAppLangFlag', 'libShowNavStats', 'libShowCategoryTag', 'libExportFormat',
  'libExportTranslations', 'libExportCbzTranslations', 'libMergeSeries', 'libFilter', 'seriesView',
  'readerSkipOverview', 'readerStudyDisplay', 'readerStudyOriginal', 'readerStudySrcFont', 'readerFurigana',
  'readerTranslateDisplay', 'readerChapterDivider', 'readerStripMode', 'readerMode', 'readerLastPageMode',
  'readerThumbsOpen', 'readerThumbHeight', 'readerPageZoom', 'readerFitMode', 'readerFitMaxWidth',
  'readerNavDirection', 'readerPageDirection', 'readerDirection', 'readerCoverOffset', 'readerPageGap',
  'readerProgressPosition', 'readerView',
  'translateSettings',
]);
// Kept outside the shiori: settings, read before the page draws.
export const PORTABLE_DASH_SETTINGS = ['shiori-lang', 'shiori-safe-mode', 'shiori-reader-pin', 'shiori-header-pin'];
// The translation settings travel without how this device reaches its translation server.
const TRANSLATE_DEVICE_FIELDS = ['serverUrl', 'serverToken'];
const MAX_SETTING = 256 * 1024;

function _portableTranslate(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isObj(value)) return null;
  for (const key of TRANSLATE_DEVICE_FIELDS) delete value[key];
  return JSON.stringify(value);
}

// `settings` ({ kv, dash }: raw stored strings) reduced to what may travel, each value checked.
export function portableSettings(settings) {
  const out = { kv: {}, dash: {} };
  if (!isObj(settings)) return out;
  for (const [key, value] of Object.entries(isObj(settings.kv) ? settings.kv : {})) {
    if (!PORTABLE_SETTINGS.has(key) || typeof value !== 'string' || value.length > MAX_SETTING) continue;
    const v = key === 'translateSettings' ? _portableTranslate(value) : value;
    if (v != null) out.kv[key] = v;
  }
  for (const [key, value] of Object.entries(isObj(settings.dash) ? settings.dash : {})) {
    if (PORTABLE_DASH_SETTINGS.includes(key) && typeof value === 'string' && value.length <= 64) out.dash[key] = value;
  }
  return out;
}

// This device's settings that may travel (`storage`: localStorage).
export function snapshotSettings(storage) {
  const raw = { kv: {}, dash: {} };
  for (const key of PORTABLE_SETTINGS) {
    const v = storage.getItem(`shiori:${key}`);
    if (v != null) raw.kv[key] = v;
  }
  for (const key of PORTABLE_DASH_SETTINGS) {
    const v = storage.getItem(key);
    if (v != null) raw.dash[key] = v;
  }
  return portableSettings(raw);
}

// A backup's settings merged into this device's (`storage`): what it carries replaces the same
// setting here, everything else is kept; the translation settings keep this device's server.
// { restored, failed: [keys] } — `restored` counts the settings that changed.
export function restoreSettings(settings, storage) {
  const { kv, dash } = portableSettings(settings);
  const out = { restored: 0, failed: [] };
  const put = (key, value) => {
    try {
      if (storage.getItem(key) === value) return;
      storage.setItem(key, value);
      out.restored++;
    } catch { out.failed.push(key); }
  };
  for (const [key, value] of Object.entries(kv)) {
    if (key !== 'translateSettings') { put(`shiori:${key}`, value); continue; }
    let here = {};
    try { here = JSON.parse(storage.getItem('shiori:translateSettings') || '{}') || {}; } catch {}
    const merged = { ...JSON.parse(value) };
    for (const field of TRANSLATE_DEVICE_FIELDS) {
      if (isObj(here) && here[field] != null) merged[field] = here[field]; else delete merged[field];
    }
    put('shiori:translateSettings', JSON.stringify(merged));
  }
  for (const [key, value] of Object.entries(dash)) put(key, value);
  return out;
}

// ── Records ↔ entries ──
// A picture value as a page record holds it: a Blob, or (stored long ago) a data-URL string.
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !/^data:/i.test(dataUrl)) return null;
  const mime = (dataUrl.slice(0, comma).match(/^data:([^;,]+)/) || [, 'application/octet-stream'])[1];
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch { return null; }
}
const toBlob = (v) => v instanceof Blob ? v : (typeof v === 'string' ? dataUrlToBlob(v) : null);

// One gallery's records as a gallery entry, its pictures collected: { entry, pictures }, each
// picture { blob, place(spec), what } — `place` puts its reference where it belongs once written
// (null: it couldn't be read).
function galleryEntry(gid, { meta = null, stat = null, cover = null, pages = [] }) {
  const pictures = [];
  const missing = [];
  const add = (value, what, place) => {
    const blob = toBlob(value);
    if (blob) { pictures.push({ blob, what, place }); return; }
    if (value != null) missing.push(what);
    place(null);
  };
  const entries = [];
  for (const r of pages || []) {
    if (!r) continue;
    const n = pageNumOf(r.url);
    const e = { url: r.url, mediaId: r.mediaId, galleryId: gid, cachedAt: r.cachedAt, size: r.size };
    entries.push(e);
    const at = (part) => ({ n, part });
    if (r.pipeline && isObj(r.pipeline)) {
      const { masks = {}, ...data } = r.pipeline;
      e.pipeline = { ...data, masks: {} };
      for (const name of PIPELINE_MASKS) add(masks?.[name], at(`mask-${name}`), (s) => { if (s) e.pipeline.masks[name] = s; });
    }
    if (typeof r.own === 'string') e.own = r.own;
    if (r.translatedLayers) e.translatedLayers = true;
    const body = r.blob ?? r.dataUrl;
    if (body == null) { e.missing = true; missing.push(at('page')); }
    else add(body, at('page'), (s) => { if (s) e.body = s; else e.missing = true; });
    if (r.translated != null) add(r.translated, at('translated'), (s) => { if (s) e.translated = s; });
    if (r.studyBg != null) add(r.studyBg, at('study'), (s) => { if (s) e.studyBg = s; });
    if (r.studyPage != null) e.studyPage = r.studyPage;
    if (Array.isArray(r.bubbles) && r.bubbles.length) {
      e.bubbles = r.bubbles.filter(isObj).map((b, k) => {
        const bubble = { box: b.box, region: b.region, tr: b.tr || '', src: b.src || '', text: null };
        for (const key of BUBBLE_EXTRA_FIELDS) if (b[key] != null) bubble[key] = b[key];
        if (b.text != null) add(b.text, at(`bubble-${k}`), (s) => { bubble.text = s || null; });
        return bubble;
      });
    }
  }
  const entry = { galleryId: gid, meta, stat, cover: null, pages: entries };
  if (cover) {
    entry.cover = {};
    if (cover.cover != null) add(cover.cover, { part: 'cover' }, (s) => { if (s) entry.cover.body = s; });
    if (cover.seriesCover != null) add(cover.seriesCover, { part: 'series-cover' }, (s) => { if (s) entry.cover.seriesBody = s; });
  }
  return { entry, pictures, missing };
}

// The gallery entry made final once its pictures are written: pages whose picture couldn't be read
// leave it (listed as missing), as do pictures of its layers that couldn't be.
function finishEntry(entry, missing) {
  entry.pages = entry.pages.filter(e => !e.missing);
  if (entry.cover && !entry.cover.body && !entry.cover.seriesBody) entry.cover = null;
  if (missing.length) entry.missing = missing;
  return entry;
}

// ── Making a backup ──
// `source` — the library: { ids(), read(gid) → { meta, stat, cover, pages } with Blobs,
//   icons(), revision(), since(rev) → { gids, resync } }.
// `out` — where it goes: { addPictures(blobs, onBytes) → specs ({ off, len, type, h }, null for
//   one that couldn't be read, in order), addBytes(u8) → { off, len }, finish(indexBytes), and
//   optionally hashPicture(blob) → its checksum (null: unreadable) }.
// `onProgress({ done, total, bytes })` per gallery; `signal` stops it between galleries.
// Resolves { result: what finish returned, counts, missing: [{ gid, what }], changed } —
// `changed`: galleries that kept changing while it was made (saved as last read).
export async function makeArchive({ source, out, settings, onProgress = () => {}, signal = null, id = null, now = Date.now() }) {
  const index = { format: FORMAT, version: VERSION, id: id || globalThis.crypto.randomUUID(), exportedAt: now,
    counts: null, galleries: [], sourceIcons: [], settings: portableSettings(settings) };
  const at = new Map();   // gid → its index entry
  const kept = new Map();   // gid → where each of its pictures was written (by page and place)
  const slot = (what) => `${what.n ?? ''}:${what.part}`;
  const missing = [];
  let bytes = 0;
  const one = async (gid) => {
    const records = await source.read(gid);
    const { entry, pictures, missing: lost } = galleryEntry(gid, records || {});
    if (!records || (!records.meta && !records.stat && !entry.pages.length && !entry.cover)) { at.delete(gid); return; }
    // A gallery read again (it changed meanwhile — often only its totals): a picture already written
    // with the same bytes is referred to where it is, not written twice (`out.hashPicture`, when the
    // file can be read back cheaply).
    const before = kept.get(gid);
    const reuse = new Array(pictures.length).fill(null);
    if (before && out.hashPicture) {
      const same = pictures.map((p, i) => { const s = before.get(slot(p.what)); return s && s.len === p.blob.size && s.type === (p.blob.type || '') ? i : -1; }).filter(i => i >= 0);
      await mapLimit(same, 4, async (i) => {
        const s = before.get(slot(pictures[i].what));
        if (await out.hashPicture(pictures[i].blob) === s.h) reuse[i] = s;
      });
    }
    const added = await out.addPictures(pictures.filter((_, i) => !reuse[i]).map(p => p.blob), (n) => { bytes += n; });
    let k = 0;
    const specs = pictures.map((_, i) => reuse[i] || added[k++]);
    const placed = new Map();
    pictures.forEach((p, i) => { if (!specs[i]) lost.push(p.what); else placed.set(slot(p.what), specs[i]); p.place(specs[i]); });
    kept.set(gid, placed);
    finishEntry(entry, lost);
    for (const what of lost) missing.push({ gid, what });
    const json = enc(JSON.stringify(entry));
    const h = await sha256(json);
    const { off, len } = await out.addBytes(json);
    const pictureBytes = entry.pages.reduce((n, e) => n + specBytes(e), 0) + (entry.cover?.body?.len || 0) + (entry.cover?.seriesBody?.len || 0);
    at.set(gid, { id: gid, off, len, h, pages: entry.pages.length, bytes: pictureBytes });
  };

  const before = await source.revision().catch(() => null);
  const ids = (await source.ids()).map(String);
  for (let i = 0; i < ids.length; i++) {
    if (signal?.aborted) throw new BackupError('cancelled');
    await one(ids[i]);
    onProgress({ done: i + 1, total: ids.length, bytes });
  }
  // Galleries changed meanwhile (in another window, a download finishing) are read again, so the
  // backup holds each one as it now is; a gallery still changing after two rounds is kept as read.
  let changed = [];
  let rev = before;
  for (let round = 0; round < 2 && rev != null; round++) {
    const since = await source.since(rev).catch(() => null);
    if (!since) break;
    rev = since.rev;
    changed = since.resync ? [] : since.gids.map(String);
    if (!changed.length) break;
    for (const gid of changed) {
      if (signal?.aborted) throw new BackupError('cancelled');
      for (let k = missing.length - 1; k >= 0; k--) if (missing[k].gid === gid) missing.splice(k, 1);
      await one(gid);
    }
  }
  index.galleries = [...at.values()];
  index.sourceIcons = iconsOf(await source.icons());
  index.counts = { galleries: index.galleries.length, images: index.galleries.reduce((n, g) => n + g.pages, 0),
    sourceIcons: index.sourceIcons.length, bytes: index.galleries.reduce((n, g) => n + g.bytes, 0) };
  const result = await out.finish(enc(JSON.stringify(index)));
  return { result, counts: index.counts, missing, changed, id: index.id };
}
// The picture bytes a page entry refers to (read before its shape is checked: anything goes).
const specBytes = (e) => [e.body, e.translated, e.studyBg, ...(Array.isArray(e.bubbles) ? e.bubbles.map(b => b?.text) : []),
  ...(isObj(e.pipeline?.masks) ? Object.values(e.pipeline.masks) : [])].reduce((n, s) => n + (safeInt(s?.len) ? s.len : 0), 0);

// The archive's last bytes: the index's length.
export function footer(indexLength) {
  const f = new Uint8Array(4);
  new DataView(f.buffer).setUint32(0, indexLength, true);
  return f;
}

// ── Reading a backup ──
// A source's icon as the library keeps it ({ source, url, dataUrl, cachedAt }), only those, each
// checked; null for one that isn't.
const iconOf = (icon) => {
  if (!isObj(icon) || typeof icon.source !== 'string' || !icon.source || icon.source.length > 256) return null;
  if (typeof icon.dataUrl !== 'string' || !/^data:image\//i.test(icon.dataUrl) || icon.dataUrl.length > 2 * 1024 * 1024) return null;
  const out = { source: icon.source, dataUrl: icon.dataUrl };
  if (typeof icon.url === 'string' && icon.url.length <= 2048) out.url = icon.url;
  if (typeof icon.cachedAt === 'number' && Number.isFinite(icon.cachedAt)) out.cachedAt = icon.cachedAt;
  return out;
};
const iconsOf = (list) => (Array.isArray(list) ? list : []).map(iconOf).filter(Boolean);

// What a file is, by its content: 'full', 'metadata' or null. Cheap: reads a few bytes (a
// metadata backup is read whole only when it is small enough to be one).
export async function probeBackup(file) {
  try {
    if (!file || file.size < 2) return null;
    const head = new TextDecoder().decode(await file.slice(0, 64).arrayBuffer()).replace(/^﻿/, '').trimStart();
    if (head.startsWith('[') && file.size <= 64 * 1024 * 1024) {
      const list = JSON.parse(await file.text());
      // A list of gallery details (checked entry by entry once it is opened), or an empty one.
      return Array.isArray(list) && (list.length === 0 || list.some(m => isObj(m) && 'galleryId' in m)) ? 'metadata' : null;
    }
    if (file.size < 4) return null;
    const len = new DataView(await file.slice(file.size - 4).arrayBuffer()).getUint32(0, true);
    const start = file.size - 4 - len;
    if (start < 0 || len < 20) return null;
    const text = new TextDecoder().decode(await file.slice(start, start + 32).arrayBuffer());
    return /^\{\s*"format"\s*:\s*"shiori-db"/.test(text) ? 'full' : null;
  } catch { return null; }
}

// Reading a file can fail once it changes or moves (a download still being written, a drive gone).
async function _read(file, from, to, as = 'arrayBuffer') {
  try { const part = file.slice(from, to); return as === 'text' ? await part.text() : await part.arrayBuffer(); }
  catch (e) { throw new BackupError('unreadable', String(e?.message || e)); }
}

// A picture reference: where its bytes are, inside the part of the file they may be in (`end`);
// version 9 references carry their checksum.
function _spec(spec, end, hashed) {
  if (spec == null) return null;
  if (!isObj(spec) || !safeInt(spec.off) || !safeInt(spec.len) || spec.off + spec.len > end) throw new GalleryProblem('invalid', 'a picture outside its place in the file');
  if (spec.type != null && (typeof spec.type !== 'string' || spec.type.length > 100)) throw new GalleryProblem('invalid', 'a picture type');
  if (hashed && (typeof spec.h !== 'string' || !/^[A-Za-z0-9+/]{43}$/.test(spec.h))) throw new GalleryProblem('invalid', 'a picture without its checksum');
  return spec;
}

function _assertIds(meta) {
  if (meta.parentId != null && !isValidGalleryId(meta.parentId)) throw new BackupError('unsafe', 'a series id');
  if (meta.chapters != null) {
    if (!Array.isArray(meta.chapters) || meta.chapters.some(c => !isObj(c) || !isValidGalleryId(c.id))) throw new BackupError('unsafe', 'a chapter id');
  }
}

// One gallery's records checked and turned into what the library writes: { bundle, checks,
// missing, pages, bytes } — `checks` the pictures with their checksums ({ blob, h }), `missing` the
// pages that had no picture. `keys` (shared across the file) catches a page key two galleries use.
function _gallery(gid, { meta, stat, cover, pages, missing: listed }, { file, end, hashed, keys }) {
  if (meta != null) {
    if (!isObj(meta)) throw new GalleryProblem('invalid', 'its details');
    if (String(meta.galleryId) !== gid) throw new GalleryProblem('invalid', 'its details name another gallery');
    _assertIds(meta);
  }
  if (stat != null) {
    if (!isObj(stat) || String(stat.galleryId) !== gid) throw new GalleryProblem('invalid', 'its totals');
    for (const k of ['count', 'size', 'latestAt', 'addedAt', 'coverPage', 'uploadDate']) {
      if (!finiteOrAbsent(stat[k])) throw new GalleryProblem('invalid', `its totals (${k})`);
    }
    if (stat.parentId != null && !isValidGalleryId(stat.parentId)) throw new BackupError('unsafe', 'a series id');
  }
  if (!Array.isArray(pages)) throw new GalleryProblem('invalid', 'its pages');
  const slice = (spec) => spec ? file.slice(spec.off, spec.off + spec.len, spec.type || '') : null;
  const checks = [];
  const take = (spec) => {
    const s = _spec(spec, end, hashed);
    if (!s) return null;
    const blob = slice(s);
    checks.push({ blob, h: s.h ?? null });
    return blob;
  };
  const numbers = new Set();
  const records = [];
  const missing = [];
  let bytes = 0;
  for (const e of pages) {
    if (!isObj(e)) throw new GalleryProblem('invalid', 'a page');
    if (typeof e.url !== 'string' || !e.url || e.url.length > MAX_KEY) throw new GalleryProblem('invalid', 'a page key');
    const n = pageNumOf(e.url);
    if (n == null || n < 1) throw new GalleryProblem('invalid', `a page key without a page number`);
    if (numbers.has(n)) throw new GalleryProblem('invalid', `page ${n} twice`);
    numbers.add(n);
    if (keys.has(e.url) && keys.get(e.url) !== gid) throw new GalleryProblem('invalid', 'a page another gallery in the file has');
    keys.set(e.url, gid);
    if (!finiteOrAbsent(e.cachedAt) || !finiteOrAbsent(e.size)) throw new GalleryProblem('invalid', `page ${n}`);
    if (e.body == null) { missing.push(n); continue; }
    const rec = { url: e.url, mediaId: e.mediaId, galleryId: gid, cachedAt: e.cachedAt, size: e.size };
    rec.blob = take(e.body);
    if (e.pipeline != null) {
      if (!isObj(e.pipeline)) throw new GalleryProblem('invalid', `page ${n} (pipeline)`);
      const { masks = {}, ...data } = e.pipeline;
      if (!isObj(masks)) throw new GalleryProblem('invalid', `page ${n} (masks)`);
      rec.pipeline = { ...data, masks: {} };
      for (const name of PIPELINE_MASKS) { const m = take(masks[name]); if (m) rec.pipeline.masks[name] = m; }
    }
    if (typeof e.own === 'string') rec.own = e.own;
    if (e.translatedLayers === true) rec.translatedLayers = true;
    const tb = take(e.translated); if (tb) rec.translated = tb;
    const sb = take(e.studyBg); if (sb) rec.studyBg = sb;
    if (e.studyPage != null) rec.studyPage = e.studyPage;
    if (e.bubbles != null) {
      if (!Array.isArray(e.bubbles) || e.bubbles.some(b => !isObj(b))) throw new GalleryProblem('invalid', `page ${n} (study layers)`);
      if (e.bubbles.length) {
        rec.bubbles = e.bubbles.map((b) => {
          const bubble = { box: b.box, region: b.region || b.box, tr: typeof b.tr === 'string' ? b.tr : '', src: typeof b.src === 'string' ? b.src : '', text: take(b.text) };
          for (const key of BUBBLE_EXTRA_FIELDS) if (b[key] != null) bubble[key] = b[key];
          return bubble;
        });
      }
    }
    bytes += specBytes(e);
    records.push(rec);
  }
  // Pages whose picture couldn't be read when the backup was made (listed by a version 9 backup).
  if (Array.isArray(listed)) for (const m of listed) if (m?.part === 'page' && Number.isSafeInteger(m.n) && !numbers.has(m.n)) missing.push(m.n);
  let coverRec = null;
  if (cover != null) {
    if (!isObj(cover)) throw new GalleryProblem('invalid', 'its cover');
    const c = take(cover.body), sc = take(cover.seriesBody);
    if (c || sc) coverRec = { cover: c, seriesCover: sc };
    bytes += (cover.body?.len || 0) + (cover.seriesBody?.len || 0);
  }
  if (!meta && !stat && records.length) throw new GalleryProblem('orphan', 'pages without their gallery');
  return { bundle: { galleryId: gid, meta, stat, pages: records, cover: coverRec }, checks, missing, pages: records.length, bytes };
}

// A backup file opened for reading: its footer and index read and checked, nothing restored.
// { version, id, exportedAt, counts, settings, sourceIcons, galleries: [{ gid, pages, bytes }],
//   load(gallery) → { bundle, checks, missing, … } (throws a GalleryProblem) }.
export async function openArchive(file) {
  const size = file?.size ?? 0;
  if (size < 4) throw new BackupError('not-backup', 'too small');
  const len = new DataView(await _read(file, size - 4, size)).getUint32(0, true);
  const start = size - 4 - len;
  if (start < 0) throw new BackupError(await _looksTruncated(file) ? 'truncated' : 'not-backup', 'no index where it should be');
  const head = new TextDecoder().decode(await _read(file, start, Math.min(start + 64, size - 4)));
  if (!/^\{\s*"format"\s*:\s*"shiori-db"/.test(head)) throw new BackupError(await _looksTruncated(file) ? 'truncated' : 'not-backup', 'no index where it should be');
  const version = Number((head.match(/"version"\s*:\s*(\d+)/) || [])[1]);
  if (len > (version >= 9 ? MAX_INDEX : MAX_LEGACY_MANIFEST)) throw new BackupError('too-large', `an index of ${len} bytes`);
  let index;
  try { index = JSON.parse(await _read(file, start, size - 4, 'text')); }
  catch (e) { if (e instanceof BackupError) throw e; throw corrupt('its index is not readable'); }
  if (!isObj(index) || index.format !== FORMAT) throw new BackupError('not-backup');
  if (!Number.isInteger(index.version) || index.version < 1) throw corrupt('its version');
  if (index.version > VERSION) throw new BackupError('newer', `version ${index.version}`);
  return index.version >= 9 ? _openV9(file, index, start) : _openLegacy(file, index, start);
}

// Whether a file that isn't laid out as a backup looks like the start of one (a download cut
// short): its first picture would be at the start, so a backup's first bytes are an image's.
async function _looksTruncated(file) {
  try { return !!imageType(new Uint8Array(await file.slice(0, 16).arrayBuffer())); } catch { return false; }
}

function _openV9(file, index, end) {
  if (typeof index.id !== 'string' || !index.id || index.id.length > 100) throw corrupt('its id');
  if (!Array.isArray(index.galleries)) throw corrupt('its gallery list');
  if (!isObj(index.counts)) throw corrupt('its counts');
  const seen = new Set();
  const galleries = index.galleries.map((g) => {
    if (!isObj(g) || !isValidGalleryId(g.id)) throw new BackupError('unsafe', 'a gallery id');
    const gid = String(g.id);
    if (seen.has(gid)) throw corrupt('a gallery listed twice');
    seen.add(gid);
    if (!safeInt(g.off) || !safeInt(g.len) || g.off + g.len > end || g.len > MAX_GALLERY_JSON) throw corrupt('a gallery outside the file');
    if (typeof g.h !== 'string' || !safeInt(g.pages) || !safeInt(g.bytes)) throw corrupt('a gallery entry');
    return { gid, pages: g.pages, bytes: g.bytes, off: g.off, len: g.len, h: g.h };
  });
  const images = galleries.reduce((n, g) => n + g.pages, 0);
  if (index.counts.galleries !== galleries.length || index.counts.images !== images) throw corrupt('its counts');
  const keys = new Map();
  return {
    version: index.version, id: index.id, exportedAt: Number(index.exportedAt) || 0, counts: index.counts,
    settings: index.settings, sourceIcons: iconsOf(index.sourceIcons),
    galleries, hashed: true,
    async load(g) {
      const bytes = await _read(file, g.off, g.off + g.len);
      if (await sha256(bytes) !== g.h) throw new GalleryProblem('checksum', 'its details');
      let rec;
      try { rec = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new GalleryProblem('invalid', 'its details'); }
      if (!isObj(rec) || String(rec.galleryId) !== g.gid) throw new GalleryProblem('invalid', 'its details');
      const out = _gallery(g.gid, rec, { file, end: g.off, hashed: true, keys });
      if (out.pages !== g.pages) throw new GalleryProblem('invalid', 'its page count');
      return out;
    },
  };
}

function _openLegacy(file, m, end) {
  for (const key of ['images', 'covers', 'metadata', 'galleries', 'sourceIcons']) {
    if (m[key] != null && !Array.isArray(m[key])) throw corrupt(`its ${key}`);
  }
  const images = m.images || [], covers = m.covers || [], metadata = m.metadata || [], stats = m.galleries || [];
  if (!isObj(m.counts)) throw corrupt('its counts');
  for (const [key, list] of [['images', images], ['galleries', stats], ['covers', covers]]) {
    if (m.counts[key] != null && m.counts[key] !== list.length) throw corrupt('its counts');
  }
  // Every record grouped by its gallery, each kind at most once per gallery.
  const groups = new Map();
  const group = (gid) => {
    if (!groups.has(gid)) groups.set(gid, { meta: null, stat: null, cover: null, pages: [] });
    return groups.get(gid);
  };
  const idOf = (rec, what) => {
    if (!isObj(rec)) throw corrupt(`a ${what} record`);
    if (!isValidGalleryId(rec.galleryId)) throw new BackupError('unsafe', 'a gallery id');
    return String(rec.galleryId);
  };
  for (const e of images) group(idOf(e, 'page')).pages.push(e);
  for (const [list, key, what] of [[metadata, 'meta', 'details'], [stats, 'stat', 'totals'], [covers, 'cover', 'cover']]) {
    for (const rec of list) {
      const g = group(idOf(rec, what));
      if (g[key]) throw corrupt(`a gallery's ${what} twice`);
      g[key] = rec;
    }
  }
  for (const meta of metadata) _assertIds(meta);
  const keys = new Map();
  const galleries = [...groups.entries()].map(([gid, g]) => ({
    gid, pages: g.pages.filter(e => isObj(e) && e.body != null).length,
    bytes: g.pages.reduce((n, e) => n + (isObj(e) ? specBytes(e) : 0), 0) + (g.cover?.body?.len || 0) + (g.cover?.seriesBody?.len || 0),
  }));
  return {
    version: m.version, id: `v${m.version}:${Number(m.exportedAt) || 0}:${file.size}`, exportedAt: Number(m.exportedAt) || 0,
    counts: { galleries: stats.length, images: images.length, sourceIcons: (m.sourceIcons || []).length },
    settings: m.settings, sourceIcons: iconsOf(m.sourceIcons), galleries, hashed: false,
    async load(g) { return _gallery(g.gid, groups.get(g.gid), { file, end, hashed: false, keys }); },
  };
}

// The image type a picture's first bytes say it is, or null.
export function imageType(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'avif';
  return null;
}

// Whether a gallery's pictures are the bytes that were saved: by checksum (version 9), or, for an
// older backup, by each page's picture starting as an image does. Throws a GalleryProblem.
async function _verify({ checks, bundle }, hashed, onBytes) {
  if (hashed) {
    await mapLimit(checks, 4, async ({ blob, h }) => {
      const bytes = await blob.arrayBuffer().catch((e) => { throw new BackupError('unreadable', String(e?.message || e)); });
      if (await sha256(bytes) !== h) throw new GalleryProblem('checksum', 'a picture');
      onBytes(bytes.byteLength);
    });
    return;
  }
  await mapLimit(bundle.pages, 8, async (rec) => {
    const head = new Uint8Array(await rec.blob.slice(0, 16).arrayBuffer().catch((e) => { throw new BackupError('unreadable', String(e?.message || e)); }));
    if (!imageType(head)) throw new GalleryProblem('checksum', 'a page that is not a picture');
  });
}

// ── Restoring a backup ──
// What a backup holds and whether each gallery can be restored, read before anything is written:
// { galleries: [{ gid, title, pages, bytes, problem? }], ok, bad, pages, bytes, missingPages }.
export async function inspectArchive(archive, { onProgress = () => {}, signal = null } = {}) {
  const out = { galleries: [], ok: 0, bad: 0, pages: 0, bytes: 0, missingPages: 0 };
  for (let i = 0; i < archive.galleries.length; i++) {
    if (signal?.aborted) throw new BackupError('cancelled');
    const g = archive.galleries[i];
    const item = { gid: g.gid, title: null, pages: g.pages, bytes: g.bytes, problem: null };
    try {
      const { bundle, missing } = await archive.load(g);
      item.title = bundle.meta?.title ?? null;
      item.missing = missing.length;
      out.missingPages += missing.length;
    } catch (e) {
      if (!(e instanceof GalleryProblem)) throw e;
      item.problem = { reason: e.reason, detail: e.detail };
    }
    if (item.problem) out.bad++; else { out.ok++; out.pages += g.pages; out.bytes += g.bytes; }
    out.galleries.push(item);
    if (i % 25 === 0 || i === archive.galleries.length - 1) onProgress({ done: i + 1, total: archive.galleries.length });
  }
  return out;
}

// Every gallery `inspection` found restorable read and checked — its pictures against their
// checksums (an older backup: that they are pictures) — writing nothing. { checked, problems,
// hashed }. onProgress({ done, total, bytes, totalBytes }).
export async function verifyArchive(archive, inspection, { onProgress = () => {}, signal = null } = {}) {
  const todo = inspection.galleries.filter(g => !g.problem);
  const problems = inspection.galleries.filter(g => g.problem).map(g => ({ gid: g.gid, title: g.title, ...g.problem }));
  const totalBytes = todo.reduce((n, g) => n + g.bytes, 0);
  const byId = new Map(archive.galleries.map(g => [g.gid, g]));
  let bytes = 0;
  for (let i = 0; i < todo.length; i++) {
    if (signal?.aborted) throw new BackupError('cancelled');
    const g = todo[i];
    try {
      const loaded = await archive.load(byId.get(g.gid));
      await _verify(loaded, archive.hashed, () => {});
    } catch (e) {
      if (!(e instanceof GalleryProblem)) throw e;
      problems.push({ gid: g.gid, title: g.title, reason: e.reason, detail: e.detail });
    }
    bytes += g.bytes;
    onProgress({ done: i + 1, total: todo.length, bytes, totalBytes });
  }
  return { checked: todo.length, problems, hashed: archive.hashed };
}

// Restore the galleries `inspection` found restorable into `library` — { write(bundle) → { pages },
// exists(gid), recount(gid), putIcon(icon), refreshSeries(ownerId), announce(gid) } — except those
// in `skip`. Each gallery's pictures are checked before it is written (the next one's while the
// current one is written) and each is written whole or not at all. `onGallery(gid)` once one is
// in; `onProgress({ done, total, bytes, totalBytes })`; `signal` stops it between galleries.
// Resolves { written: [gid], problems: [{ gid, title, reason, detail }], skipped, cancelled }.
// Throws a BackupError when nothing more can be restored (no space left, the library gone, the
// file unreadable) — what was written before stays, and is in `error.written`.
export async function restoreArchive(archive, inspection, library, { skip = new Set(), onGallery = () => {}, onProgress = () => {}, signal = null, verify = true } = {}) {
  const todo = inspection.galleries.filter(g => !g.problem && !skip.has(g.gid));
  const problems = inspection.galleries.filter(g => g.problem).map(g => ({ gid: g.gid, title: g.title, ...g.problem }));
  const written = [];
  const totalBytes = todo.reduce((n, g) => n + g.bytes, 0);
  let bytes = 0, done = 0, cancelled = false;
  const owners = new Set();
  const byId = new Map(archive.galleries.map(g => [g.gid, g]));
  const prepare = (g) => (async () => {
    const loaded = await archive.load(byId.get(g.gid));
    if (verify) await _verify(loaded, archive.hashed, () => {});
    return loaded;
  })();
  const progress = () => onProgress({ done, total: todo.length, bytes, totalBytes });
  let next = todo.length ? prepare(todo[0]).catch(e => e) : null;
  try {
    for (let i = 0; i < todo.length; i++) {
      const g = todo[i];
      const loaded = await next;
      if (signal?.aborted) { cancelled = true; break; }
      next = i + 1 < todo.length ? prepare(todo[i + 1]).catch(e => e) : null;
      try {
        if (loaded instanceof Error) throw loaded;
        const { bundle } = loaded;
        const existed = await library.exists(g.gid);
        const res = await library.write(bundle);
        const stored = Number(res?.pages ?? bundle.pages.length);
        if (stored !== bundle.pages.length) throw new GalleryProblem('failed', `${stored} of ${bundle.pages.length} pages stored`);
        if (existed || !bundle.stat || bundle.stat.count !== stored) await library.recount(g.gid);
        if (bundle.meta?.parentId) owners.add(String(bundle.meta.parentId));
        if (Array.isArray(bundle.meta?.chapters) && bundle.meta.chapters.length > 1) owners.add(g.gid);
        written.push(g.gid);
        onGallery(g.gid);
      } catch (e) {
        if (e instanceof BackupError) throw e;
        const code = e?.code;
        if (code === 'quota') throw Object.assign(new BackupError('quota', String(e?.message || e)), { written });
        if (code === 'unavailable') throw Object.assign(new BackupError('unavailable', String(e?.message || e)), { written });
        problems.push({ gid: g.gid, title: g.title, reason: e instanceof GalleryProblem ? e.reason : (code === 'conflict' ? 'conflict' : 'failed'),
          detail: e?.detail || String(e?.message || e) });
      }
      done++;
      bytes += g.bytes;
      progress();
    }
  } catch (e) {
    e.written = written;
    for (const gid of written) library.announce(gid);
    throw e;
  } finally {
    await next?.catch?.(() => {});
  }
  for (const icon of archive.sourceIcons) await library.putIcon(icon).catch(() => {});
  const totals = [];
  for (const ownerId of owners) await library.refreshSeries(ownerId).catch(() => totals.push(ownerId));
  for (const gid of written) library.announce(gid);
  return { written, problems, cancelled, seriesNotRefreshed: totals, skipped: [...skip].length };
}

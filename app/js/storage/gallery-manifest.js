// gallery-manifest.js — format v2 of a gallery's folder (the plan's §4): the gallery's saved state is
// one generation, committed by one atomic write of one file, its manifest. The only module that writes
// or parses one, for both apps (the website's db.js and folder-library.js; the desktop's files.js,
// scan.js and linked.js, through desktop/server/shared.js) and both adapters. Pure: no I/O, only the
// rules — what a manifest is, which files a generation names, what a publication writes and may
// collect, how a gallery's folder is read back (readGallery, given the reads to make), and what its
// deletion takes (galleryDeletion).
//
// - Where: in the gallery's own folder, in its `.shiori/` area — `<gallery>/.shiori/gallery.json` —
//   or, for a linked gallery, in its overlay (already inside the library folder's hidden .shiori):
//   `.shiori/linked/<gid>/gallery.json` (areaOf).
// - Every slot is named, canonical names included (`files`), with the size and modification time each
//   file had as Shiori wrote it (`sizes`: deletion checks them, principle 4); a linked overlay's pages
//   name the source picture each shows (`sources`).
// - Descriptions are stored by content, `<area>d/<sha-256>.json`: one that didn't change keeps its
//   file, a changed one gets a new one, so the previous generation stays whole until the new manifest
//   has replaced the old. One whose content doesn't match its name is corrupt. The stable-named copies
//   (metadata.json and the others, gallery-files.js DESCRIPTION_FILES) are written after the commit,
//   for people, other tools and older versions; a v2 reader never reads them. In an archive (the
//   desktop's archive mode), whose new directory commits everything appended at once, the manifest
//   names those entries themselves.
// - `generation` counts publications, `writer` names the app that made it (its instance id), and
//   `publication` is an id of the publication's own, random, made as it is planned: an app catches up on
//   a generation that isn't the one it last published or read (its token, which carries all three — two
//   publications never share one, whatever an app remembers: a folder put back from an older copy, an
//   index restored, S31).
// - A folder without a manifest is format v1, read by today's rules (gallery-files.js folderPictures),
//   except that a file its descriptions name but that isn't there is a problem, never a cue to fall
//   back (T09); it becomes v2 at its next publication.

import { DESCRIPTION_FILES, descriptionStamp, describedFiles, folderPictures, layoutPath } from './gallery-files.js';
import { corrupt } from './contract.js';
import { classifyFolder } from './folder-content.js';
import { SOURCE_FILE, parseSource } from './linked-source.js';
import { isValidGalleryId } from '../sanitize.js';

/** @typedef {import('./contract.js').Manifest} Manifest */
/** @typedef {import('./contract.js').PageFiles} PageFiles */
/** @typedef {import('./contract.js').SourceSignal} SourceSignal */
/** @typedef {import('./gallery-files.js').FolderPictures} FolderPictures */
/** @typedef {import('./gallery-files.js').PageRecord} PageRecord */

export const MANIFEST_NAME = 'gallery.json';
// The folders a gallery's pictures are in (gallery-files.js layoutPath): a manifest names files there
// alone.
export const PICTURE_DIRS = ['images', 'translated', 'study/bg', 'study/text', 'pipeline', 'covers'];
const PICTURE = /^(?:images|translated|study\/bg|study\/text|pipeline|covers)\/[^/\\:*?"<>|\u0000-\u001f]+$/;
/** Whether a file's name is a picture's, by its extension (what a gallery's folder holds in
 * PICTURE_DIRS beside the files the system puts there). @param {string} name @returns {boolean} */
export const isPictureName = (name) => /\.(?:jpe?g|png|webp|gif|avif)$/i.test(name);
const STORED = /^(?:\.shiori\/)?d\/([0-9a-f]{64})\.json$/;

/** Where a gallery's folder `dir` (its path in the library folder) keeps its manifest and stored
 * descriptions: '.shiori/' in a gallery's own folder, '' in a linked gallery's overlay (D7).
 * @param {string} dir @returns {string} */
export const areaOf = (dir) => (/(^|\/)\.shiori\/linked\/[^/]+\/?$/.test(String(dir)) ? '' : '.shiori/');
/** @param {string} area @returns {string} the manifest's path in the gallery's folder */
export const manifestPath = (area) => `${area}${MANIFEST_NAME}`;
/** @param {string} area @returns {string} the folder stored descriptions are in */
export const storedDir = (area) => `${area}d`;

/** A picture file's path as a manifest may name it: in one of PICTURE_DIRS, a plain name.
 * @param {unknown} p @returns {p is string} */
export const isPicturePath = (p) => typeof p === 'string' && PICTURE.test(p) && !/\/[. ]+$/.test(p);
/** The sha-256 a stored description's path names, or null for a path that isn't one.
 * @param {string} p @returns {string | null} */
export const storedHash = (p) => STORED.exec(String(p))?.[1] ?? null;

/** The hex sha-256 of `text` (UTF-8). @param {string} text @returns {Promise<string>} */
export async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** Whether `text` is what stored description `path` names (its sha-256).
 * @param {string} path @param {string} text @returns {Promise<boolean>} */
export async function matches(path, text) {
  const hash = storedHash(path);
  return !!hash && hash === await sha256Hex(text);
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const _object = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v @returns {v is number} */
const _count = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// ── Parsing ──

/** A manifest's text parsed and checked whole: 'corrupt' for anything that isn't a manifest as this
 * module writes them (the shape, every path, the gallery it names when `galleryId` is given). `archive`:
 * read from an archive, whose manifest names its descriptions' entries themselves.
 * @param {string} text @param {{ galleryId?: string | null, archive?: boolean }} [options]
 * @returns {{ kind: 'ok', value: Manifest } | import('./contract.js').Corrupt} */
export function parseManifest(text, { galleryId = null, archive = false } = {}) {
  let m;
  try { m = JSON.parse(text); } catch { return corrupt('the manifest is not JSON'); }
  if (!_object(m) || m.format !== 'shiori-gallery' || m.version !== 2) return corrupt('not a gallery manifest');
  if (typeof m.galleryId !== 'string' || !isValidGalleryId(m.galleryId)) return corrupt('the manifest names no gallery');
  if (galleryId != null && m.galleryId !== String(galleryId)) return corrupt(`the manifest names gallery ${m.galleryId}`);
  if (!Number.isSafeInteger(m.generation) || m.generation < 0) return corrupt('the manifest has no generation');
  if (typeof m.writer !== 'string' || !m.writer || m.writer.length > 64) return corrupt('the manifest names no writer');
  if (m.publication != null && !PUBLICATION.test(String(m.publication))) return corrupt('the manifest\'s publication is not valid');
  if (!_object(m.files) || !_object(m.files.pages) || !_object(m.files.covers ?? {})) return corrupt('the manifest lists no files');
  /** @type {Record<string, PageFiles>} */
  const pages = {};
  for (const [n, p] of Object.entries(m.files.pages)) {
    if (!/^[1-9]\d{0,5}$/.test(n) || !_object(p)) return corrupt(`page ${n} is not valid`);
    /** @type {PageFiles} */
    const out = {};
    for (const key of /** @type {const} */ (['original', 'translated', 'studyBg'])) {
      if (p[key] == null) continue;
      if (!isPicturePath(p[key])) return corrupt(`page ${n}'s ${key} is not a picture's path`);
      out[key] = p[key];
    }
    if (p.studyText != null) {
      if (!Array.isArray(p.studyText) || !p.studyText.every(f => f === null || isPicturePath(f))) return corrupt(`page ${n}'s study text is not valid`);
      out.studyText = [...p.studyText];
    }
    if (p.masks != null) {
      if (!_object(p.masks)) return corrupt(`page ${n}'s masks are not valid`);
      /** @type {{ raw?: string, text?: string }} */
      const masks = {};
      for (const key of /** @type {const} */ (['raw', 'text'])) {
        if (p.masks[key] == null) continue;
        if (!isPicturePath(p.masks[key])) return corrupt(`page ${n}'s ${key} mask is not a picture's path`);
        masks[key] = p.masks[key];
      }
      out.masks = masks;
    }
    pages[n] = out;
  }
  /** @type {{ gallery?: string, series?: string }} */
  const covers = {};
  for (const role of /** @type {const} */ (['gallery', 'series'])) {
    const c = m.files.covers?.[role];
    if (c == null) continue;
    if (!isPicturePath(c) || !c.startsWith('covers/')) return corrupt(`its ${role} cover is not a picture's path`);
    covers[role] = c;
  }
  /** @type {Record<string, string>} */
  const descriptions = {};
  if (!_object(m.descriptions)) return corrupt('the manifest lists no descriptions');
  for (const [name, at] of Object.entries(m.descriptions)) {
    const ok = DESCRIPTION_FILES.includes(name) && typeof at === 'string' && (storedHash(at) != null || (archive && at === name));
    if (!ok) return corrupt(`description ${name} is not valid`);
    descriptions[name] = at;
  }
  /** @type {Record<string, [number, number]>} */
  const sizes = {};
  if (!_object(m.sizes ?? {})) return corrupt('the manifest\'s sizes are not valid');
  for (const [name, v] of Object.entries(m.sizes ?? {})) {
    if (!Array.isArray(v) || v.length !== 2 || !_count(v[0]) || !_count(v[1])) return corrupt(`the size of ${name} is not valid`);
    sizes[name] = [v[0], v[1]];
  }
  /** @type {Record<string, SourceSignal> | undefined} */
  let sources;
  if (m.sources != null) {
    if (!_object(m.sources)) return corrupt('the manifest\'s sources are not valid');
    sources = {};
    for (const [n, s] of Object.entries(m.sources)) {
      if (!_object(s) || typeof s.name !== 'string' || !_count(s.size)) return corrupt(`page ${n}'s source is not valid`);
      sources[n] = { name: s.name, size: s.size, ...(typeof s.crc === 'string' ? { crc: s.crc } : {}), ...(_count(s.mtime) ? { mtime: s.mtime } : {}) };
    }
  }
  return { kind: 'ok', value: { format: 'shiori-gallery', version: 2, galleryId: m.galleryId, generation: m.generation,
    ...(m.publication != null ? { publication: m.publication } : {}),
    files: { pages, covers }, sizes, ...(sources ? { sources } : {}), descriptions, writer: m.writer } };
}

/** A manifest's text as this module writes it: one line per page, per file size and per description,
 * so it reads and compares well.
 * @param {Manifest} m @returns {string} */
export function manifestText(m) {
  /** @param {Record<string, unknown>} obj */
  const lines = (obj) => `{${Object.entries(obj).map(([k, v]) => `\n${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',')}\n}`;
  const head = { format: m.format, version: m.version, galleryId: m.galleryId, generation: m.generation,
    ...(m.publication != null ? { publication: m.publication } : {}), writer: m.writer };
  return `{${Object.entries(head).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')},\n`
    + `"files": { "pages": ${lines(m.files.pages)},\n"covers": ${JSON.stringify(m.files.covers)} },\n`
    + `"sizes": ${lines(m.sizes)},\n`
    + (m.sources ? `"sources": ${lines(m.sources)},\n` : '')
    + `"descriptions": ${lines(m.descriptions)}\n}\n`;
}

/** A publication's own id (S31): random, made as the publication is planned (publicationWith,
 * archiveManifest) — never derived from anything an app remembers. @returns {string} */
export const newPublication = () => [...globalThis.crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
const PUBLICATION = /^[0-9a-z]{4,32}$/;
/** What tells one publication of a gallery from another, for catching up (D4) and for holding its place
 * (whoseVersion): its generation, its own id and the app that wrote it, `v2:<generation>.<id>:<writer>` —
 * equal tokens are the same publication. A manifest written before S31 has no id and keeps the token it had,
 * `v2:<generation>:<writer>`: no gallery of an existing library reads as changed for it. A folder of format
 * v1 is told by its descriptions' stamp (gallery-files.js descriptionStamp), as before.
 * @param {Manifest} m @returns {string} */
export const tokenOf = (m) => `v2:${m.generation}${m.publication != null ? `.${m.publication}` : ''}:${m.writer}`;
/** The generation a token names (0 for a v1 stamp, or none). @param {string | null | undefined} token @returns {number} */
export const generationOf = (token) => Number(/^v2:(\d+)[.:]/.exec(String(token ?? ''))?.[1] ?? 0);
/** The app a token names as the generation's writer (null for a v1 stamp, or none). @param {string | null | undefined} token @returns {string | null} */
export const writerOf = (token) => /^v2:\d+(?:\.[0-9a-z]+)?:(.+)$/.exec(String(token ?? ''))?.[1] ?? null;
/** Whether a token says its folder holds the gallery as published (a generation past its reservation's, or
 * an earlier version's descriptions read there), rather than a reservation no publication made whole.
 * @param {string | null | undefined} token @returns {boolean} */
export const published = (token) => !!token && (!String(token).startsWith('v2:') || generationOf(token) > 0);
/** What a drop — the folder's version of a gallery standing, what waited of it here dropped (S32, S37) — rests on at a
 * place read at `now` (its token there: a manifest's, or an earlier version's descriptions' stamp, or none), this
 * library knowing it at `known` (its stamp): 'version' — a manifest there, the version stands; 'unreadable' — none
 * there, yet this library read or wrote one (its stamp names a manifest): not found for a moment (a drive just back),
 * nothing concluded, read again later; 'none' — none there and none ever known (an earlier version's folder never
 * republished, a linked gallery's overlay never described): no version to drop for, so what waits here stands — the
 * gallery is settled (S38), as a damaged place has none to stand by either (T08). One rule, both apps.
 * @param {string | null | undefined} now @param {string | null | undefined} known @returns {'version' | 'unreadable' | 'none'} */
export const dropBasis = (now, known) => (String(now ?? '').startsWith('v2:') ? 'version' : String(known ?? '').startsWith('v2:') ? 'unreadable' : 'none');
/** Whether a gallery is the folder's for the read-only gate (folder-lifecycle.js changeRefusal `held`): it
 * has a place in a library folder (`placed`: a folder or archive the library keeps it at — not one made
 * meanwhile and never placed) that isn't a reservation of this library's no publication made whole
 * (`known`, the token it keeps: a generation 0), whatever else this library knows of it — a gallery carried
 * over from an index before stamps (the released version's) has none, and is the folder's all the same
 * (S31, review 8 R8-1; a linked gallery since S30).
 * @param {boolean} placed @param {string | null | undefined} known @returns {boolean} */
export const inFolder = (placed, known) => !!placed && (known == null || published(known));
/** Whose version of a gallery its place holds — weighed in one place in each adapter (placeIn: desktop
 * folder-store.js, website folder-store-web.js) before anything is written into, moved out of, unpacked from,
 * archived into or deleted at that place. `now`: the token of the publication the place holds now (null: no
 * manifest — an earlier version's folder, v1, which names no writer, or none yet); `known`: the token this
 * library last published or read there (null: none — a gallery carried over from an index before stamps);
 * `writer`: this app.
 * - 'ours': the place holds the publication this library knows (equal tokens: the same publication), a later
 *   one of this app's own (published from this library's records, its token not kept yet: a kill between the
 *   two — a publication's generation is always past the one it was made over), or no manifest — what is
 *   written there is written from the folder's version.
 * - 'theirs': another publication — another app's since this library's last read, an earlier one of this
 *   app's own (a folder put back from an older copy), or any manifest where this library has no stamp but this
 *   app's. One app changes a folder's galleries at a time (the owner's rule, 2026-11-15): the folder's version
 *   stands, nothing of this library's older view is written or deleted there, and what waited here for the
 *   gallery is dropped (the libraries' gateway: desktop files.js hold, website db.js _hold).
 * @param {string | null | undefined} now @param {string | null | undefined} known @param {string} writer @returns {'ours' | 'theirs'} */
export const whoseVersion = (now, known, writer) =>
  (!String(now ?? '').startsWith('v2:') || now === known || (writerOf(now) === writer && generationOf(now) > generationOf(known)) ? 'ours' : 'theirs');
/** Whether this library's own publication of a gallery was replaced there rather than built on (S33, review 10 B1): the
 * place holds, at `now`, another writer's publication at the same generation as this library's last one (`known`, of
 * `writer`, this app) or an earlier one — a publication of the other app that was under way at a take-over landing
 * after this one. Its change is then gone from the folder, the folder's version standing: reported once
 * ('changed-both'), as a change waiting here dropped is. Not where the other app published a later generation on top
 * (the normal case), nor for this app's own earlier publication put back by hand.
 * @param {string | null | undefined} now @param {string | null | undefined} known @param {string} writer @returns {boolean} */
export const replacedOwn = (now, known, writer) => String(now ?? '').startsWith('v2:') && now !== known && writerOf(known) === writer
  && writerOf(now) !== writer && generationOf(now) <= generationOf(known);
/** Whether a publication of a gallery with nothing of it waiting (a removal's write-back) writes nothing:
 * its folder holds a generation already (its manifest read 'ok': the one last published or read here, or
 * another app's since, which a check reads: D4), or holds none and never held one this library knew of —
 * `known`, the token it keeps, isn't a manifest's: an earlier version's descriptions read there, a linked
 * gallery's overlay no app has described yet. Nothing of it is only here then, and publishing it would be a
 * change no one made, which another app's waiting change of it would lose to (S30). Only a manifest lost or
 * damaged since is written again. `manifest`: the kind its manifest reads as now.
 * @param {string | null | undefined} known @param {string} manifest @returns {boolean} */
export const nothingToWrite = (known, manifest) => !!known && (manifest === 'ok' || (manifest === 'missing' && !String(known).startsWith('v2:')));
/** Whether a folder naming a gallery at `now` (the token of its generation) supersedes the archive the
 * library keeps that gallery in, at `known` (the token it last published or read there): a later
 * generation (format v2), which an unpack of the archive publishes before it takes the archive's place
 * (review 7 B6) — so a folder beside the archive naming the gallery so is where the gallery is now, the
 * unpack someone began (the other app, or this one before a kill), taken as it is and never unpacked a
 * second time; one at or before the archive's generation, or an earlier version's (no manifest), is a copy.
 * @param {string | null | undefined} now @param {string | null | undefined} known @returns {boolean} */
export const supersedes = (now, known) => String(now ?? '').startsWith('v2:') && generationOf(now) > generationOf(known);

// ── What a generation names ──

/** The picture files a manifest's `files` name (each slot's, its covers'), in no particular order.
 * @param {Manifest['files']} files @returns {string[]} */
export function namedPictures(files) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const p of Object.values(files.pages)) {
    for (const f of [p.original, p.translated, p.studyBg, ...(p.studyText || []), p.masks?.raw, p.masks?.text]) if (f) out.add(f);
  }
  for (const f of Object.values(files.covers)) if (f) out.add(f);
  return [...out];
}

/** The files of a gallery as its library records them, slot by slot (`records`: its page records, each
 * with its page number; `covers`: its covers' references): `fileOf(ref)` is the file a reference names
 * in the gallery's folder, null for one that isn't there (a page of a linked gallery's source, a
 * picture still held in the browser, a cover that is a page).
 * @param {{ records: PageRecord[], covers?: { gallery?: unknown, series?: unknown } }} gallery
 * @param {(ref: any) => string | null | undefined} fileOf
 * @returns {Manifest['files']} */
export function slotFiles({ records, covers = {} }, fileOf) {
  /** @param {unknown} src @returns {string | null} */
  const at = (src) => { if (src == null || typeof src !== 'object') return null; const f = fileOf(src); return isPicturePath(f) ? f : null; };
  /** @type {Record<string, PageFiles>} */
  const pages = {};
  for (const r of records) {
    if (r.pageNum == null) continue;
    /** @type {PageFiles} */
    const p = {};
    const original = at(r.blob);
    if (original) p.original = original;
    const translated = at(r.translated);
    if (translated) p.translated = translated;
    if (Array.isArray(r.bubbles) && r.bubbles.length) {
      const bg = at(r.studyBg);
      if (bg) p.studyBg = bg;
      const texts = r.bubbles.map(b => at(b?.text));
      if (texts.some(Boolean)) p.studyText = texts.map(t => t ?? null);
    }
    const raw = at(r.pipeline?.masks?.raw), text = at(r.pipeline?.masks?.text);
    if (raw || text) p.masks = { ...(raw ? { raw } : {}), ...(text ? { text } : {}) };
    if (Object.keys(p).length) pages[String(r.pageNum)] = p;
  }
  /** @type {{ gallery?: string, series?: string }} */
  const out = {};
  for (const role of /** @type {const} */ (['gallery', 'series'])) {
    const f = at(covers[role]);
    if (f?.startsWith('covers/')) out[role] = f;
  }
  return { pages, covers: out };
}

/** Which file holds each picture, as a manifest names them — the shape gallery-files.js folderPictures
 * gives for a v1 folder, so one reader serves both: file(slot) (its layout name without extension:
 * translated/0001, study/text/0001-2), pages (page number → its original's file, in page order), covers.
 * @param {Manifest} m @returns {FolderPictures} */
export function manifestPictures(m) {
  /** @type {Map<string, string>} */
  const bySlot = new Map();
  /** @type {[number, string][]} */
  const originals = [];
  /** @param {string} path */
  const slot = (path) => path.replace(/\.[^./]*$/, '');
  for (const [key, p] of Object.entries(m.files.pages)) {
    const n = Number(key);
    if (p.original) { originals.push([n, p.original]); bySlot.set(slot(layoutPath.original(n, 'x')), p.original); }
    if (p.translated) bySlot.set(slot(layoutPath.translated(n, 'x')), p.translated);
    if (p.studyBg) bySlot.set(slot(layoutPath.studyBg(n, 'x')), p.studyBg);
    (p.studyText || []).forEach((f, k) => { if (f) bySlot.set(slot(layoutPath.studyText(n, k, 'x')), f); });
    if (p.masks?.raw) bySlot.set(slot(layoutPath.mask(n, 'raw', 'x')), p.masks.raw);
    if (p.masks?.text) bySlot.set(slot(layoutPath.mask(n, 'text', 'x')), p.masks.text);
  }
  const covers = { ...m.files.covers };
  for (const [role, f] of Object.entries(covers)) if (f) bySlot.set(`covers/${role}`, f);
  return { file: (s) => bySlot.get(s) ?? null, pages: new Map(originals.sort((a, b) => a[0] - b[0])), covers };
}

// ── Reading a gallery's folder ──

/** A gallery's folder (or archive) read back: its format version, its manifest (v2), the token it was
 * read at (tokenOf, or the v1 stamp), its descriptions' texts and parsed values, and which file holds
 * each picture.
 * @typedef {{ kind: 'ok', version: 1 | 2, manifest: Manifest | null, token: string,
 *   texts: Record<string, string | null>, meta: any, records: any, bubbles: Record<string, any>, covers: any,
 *   pictures: FolderPictures }} GalleryRead */
/** @typedef {GalleryRead | import('./contract.js').Corrupt | { kind: 'missing-file', files: string[] }} GalleryReadResult */

/** A description's text parsed: what it should hold, or undefined for text that isn't that.
 * @param {string} name @param {string} text @returns {unknown} */
function _description(name, text) {
  let v;
  try { v = JSON.parse(text); } catch { return undefined; }
  const ok = name === 'image_records.json' ? Array.isArray(v) : _object(v);
  return ok ? v : undefined;
}

/** A gallery's folder read back, the same on both apps and for both formats. `text(rel)`: the text of
 * the file at `rel` in the gallery's folder (or archive), null when it isn't there — it rejects when
 * one can't be read (principle 6: never taken for one that isn't there); `files`: the picture files it
 * holds (in PICTURE_DIRS, as listed: path → { size }); `area`: areaOf its folder; `archive`: read from
 * an archive. Resolves:
 * - 'ok' (GalleryRead): v2 when it has a manifest, which alone says which file is current; else v1;
 * - 'corrupt': its manifest, a stored description whose content doesn't match its name, or a
 *   description that isn't what it should be (T08) — the gallery's earlier records and token are to be
 *   kept, and the problem reported;
 * - 'missing-file': files its manifest (or, v1, its descriptions) name that aren't there (T09) —
 *   reported, never replaced by another file. In v1 a gallery of Shiori's own (not a linked gallery's
 *   overlay, whose pages' pictures are its source's) whose image_records.json has pages but whose
 *   images/ shows none is so too (review 7 A2): a v1 folder without a files list names its pictures by
 *   what images/ shows, and one a browser lists as nothing (a link it hides) would join with no pages,
 *   its next publication naming none. A gallery that has no pages by design (not downloaded yet, a
 *   series' own record) has no page in its image_records.json, or none.
 * @param {{ area: string, archive?: boolean, text(rel: string): Promise<string | null>, files: Map<string, { size: number }> }} view
 * @returns {Promise<GalleryReadResult>} */
export async function readGallery({ area, archive = false, text, files }) {
  /** @type {Record<string, string | null>} */
  const texts = Object.fromEntries(DESCRIPTION_FILES.map(n => [n, null]));
  /** @type {Record<string, any>} */
  const parsed = {};
  const found = await text(manifestPath(area));
  /** @type {Manifest | null} */
  let manifest = null;
  if (found != null) {
    const m = parseManifest(found, { archive });
    if (m.kind !== 'ok') return m;
    manifest = m.value;
    /** @type {string[]} */
    const missing = [];
    for (const [name, at] of Object.entries(manifest.descriptions)) {
      const t = await text(at);
      if (t == null) { missing.push(at); continue; }
      if (storedHash(at) != null && !await matches(at, t)) return corrupt(`${at} doesn't match its name`);
      texts[name] = t;
    }
    missing.push(...namedPictures(manifest.files).filter(f => !files.has(f)));
    if (missing.length) return { kind: 'missing-file', files: missing };
  } else {
    for (const name of DESCRIPTION_FILES) texts[name] = await text(name);
  }
  for (const name of DESCRIPTION_FILES) {
    const t = texts[name];
    if (t == null) continue;
    const v = _description(name, t);
    if (v === undefined) return corrupt(`${name} is not valid`);
    parsed[name] = v;
  }
  const records = parsed['image_records.json'] ?? null, covers = parsed['covers/manifest.json'] ?? null;
  if (!manifest) {
    const missing = [...describedFiles(records, covers)].filter(f => !files.has(f));
    if (missing.length) return { kind: 'missing-file', files: missing };
  }
  const pictures = manifest ? manifestPictures(manifest) : folderPictures(files.keys(), { records, manifest: covers });
  if (!manifest && area && !pictures.pages.size && (records ?? []).some(_object)) return { kind: 'missing-file', files: [`${PICTURE_DIRS[0]}/`] };
  return { kind: 'ok', version: manifest ? 2 : 1, manifest, token: manifest ? tokenOf(manifest) : descriptionStamp(texts), texts,
    meta: parsed['metadata.json'] ?? null, records, bubbles: parsed['study/bubbles.json'] ?? {}, covers, pictures };
}

// ── Publishing ──

/** What publishing generation `next` over `prev` (the manifest the folder has now, or null) writes,
 * in order: `writes`, the descriptions stored by content that `prev` doesn't name (new immutable
 * files); then `text`, the manifest (one atomic write: the commit point); then `stable`, each
 * stable-named copy as a best effort — `text` to write where the file's text differs, or null to
 * delete one the gallery no longer has (only when it is still what `prev` stored: `was`). `superseded`:
 * the stored descriptions `prev` names and this generation doesn't — collected once this one has
 * committed, each while its content still matches its name; never one no manifest names, which may be
 * another app's publication under way at a take-over (S33, review 10 B1). `texts`: the
 * descriptions (DESCRIPTION_FILES name → text; none for one the gallery hasn't); `area`: areaOf its
 * folder. The generation is the next after both `prev`'s and `next`'s own (the one the library last
 * published or read); with no `prev`, `next`'s own (0 for a reservation's, firstGeneration).
 * @param {{ area: string, prev: Manifest | null, next: Omit<Manifest, 'descriptions'>, texts: Record<string, string | null | undefined> }} publication
 * @returns {Promise<Publication>} */
export async function publication({ area, prev, next, texts }) {
  /** @type {Map<string, string>} */
  const hashes = new Map();
  for (const name of DESCRIPTION_FILES) { const t = texts[name]; if (t != null) hashes.set(t, await sha256Hex(t)); }
  return publicationWith({ area, prev, next, texts, hashOf: (t) => /** @type {string} */ (hashes.get(t)) });
}
/** @typedef {{ manifest: Manifest, text: string, writes: { path: string, text: string }[],
 *   stable: { path: string, text: string | null, was: string | null }[], superseded: string[] }} Publication */
/** The same, planned in one synchronous step, given `hashOf(text)` (its hex sha-256): for a caller that
 * must make a gallery's folder and its first generation at once (the desktop's reservation).
 * @param {{ area: string, prev: Manifest | null, next: Omit<Manifest, 'descriptions'>, texts: Record<string, string | null | undefined>,
 *   hashOf: (text: string) => string }} publication
 * @returns {Publication} */
export function publicationWith({ area, prev, next, texts, hashOf }) {
  /** @type {Record<string, string>} */
  const descriptions = {};
  /** @type {{ path: string, text: string }[]} */
  const writes = [];
  const before = new Set(Object.values(prev?.descriptions ?? {}));
  for (const name of DESCRIPTION_FILES) {
    const t = texts[name];
    if (t == null) continue;
    const at = `${storedDir(area)}/${hashOf(t)}.json`;
    descriptions[name] = at;
    if (!before.has(at)) writes.push({ path: at, text: t });
  }
  // A folder's first: `next`'s own (a reservation's 0: firstGeneration).
  const generation = prev ? Math.max(next.generation, prev.generation + 1) : next.generation;
  /** @type {Manifest} */
  const manifest = { ...next, generation, publication: newPublication(), descriptions };
  /** @type {{ path: string, text: string | null, was: string | null }[]} */
  const stable = DESCRIPTION_FILES.flatMap(name => (texts[name] != null ? [{ path: name, text: /** @type {string | null} */ (texts[name]), was: /** @type {string | null} */ (null) }]
    : prev?.descriptions[name] ? [{ path: name, text: /** @type {string | null} */ (null), was: /** @type {string | null} */ (prev.descriptions[name]) }] : []));
  const named = new Set(Object.values(descriptions));
  return { manifest, text: manifestText(manifest), writes, stable, superseded: [...before].filter(at => !named.has(at)) };
}

/** The first generation of gallery `galleryId`, which a reservation publishes as it makes the gallery's
 * folder (contract.js reserve: the only operation that makes a directory a gallery's): generation 0, no
 * pictures yet, written by `writer`. Its one description (the gallery's metadata.json) is stored with it,
 * not copied under its own name: the folder names the gallery by this manifest alone, as reserved — never
 * taken for the gallery by a check until a publication there makes it whole (folder-content.js
 * classifyFolder `reserved`).
 * @param {string} galleryId @param {string} writer @returns {Omit<Manifest, 'descriptions'>} */
export const firstGeneration = (galleryId, writer) => ({ format: 'shiori-gallery', version: 2, galleryId: String(galleryId), generation: 0,
  writer, files: { pages: {}, covers: {} }, sizes: {} });

/** A manifest for an archive (the desktop's archive mode): its descriptions are the entries appended
 * with it, under their own names — the archive's new directory commits them all at once — and the
 * publication an id of its own (tokenOf).
 * @param {Omit<Manifest, 'descriptions'>} next @param {Record<string, string | null | undefined>} texts @returns {Manifest} */
export const archiveManifest = (next, texts) => ({ ...next, publication: newPublication(),
  descriptions: Object.fromEntries(DESCRIPTION_FILES.filter(n => texts[n] != null).map(n => [n, n])) });

/** The sizes a manifest records for the files it names: each from `known` (path → [size, mtime] as the
 * library recorded writing it; mtime 0 when it didn't), else from `prev` when that names the same file
 * at the same size, else from `stat(path)` ([size, mtime] as the file is now; null when it isn't
 * there, which keeps the library's size and no time). One stat per file the library didn't record
 * the time of, once: the next publication finds it in `prev`.
 * @param {Manifest['files']} files @param {Map<string, [number, number]>} known @param {Manifest | null} prev
 * @param {(path: string) => Promise<[number, number] | null>} stat @returns {Promise<Record<string, [number, number]>>} */
export async function sizesOf(files, known, prev, stat) {
  /** @type {Record<string, [number, number]>} */
  const out = {};
  for (const f of namedPictures(files)) {
    const k = known.get(f);
    if (k && k[1] > 0) { out[f] = k; continue; }
    const p = prev?.sizes[f];
    if (p && (!k || p[0] === k[0])) { out[f] = p; continue; }
    out[f] = (await stat(f)) ?? [k?.[0] ?? 0, 0];
  }
  return out;
}

// ── Deleting by name (principle 4) ──

/** Whether a file as it is now (`size`, `mtime` in ms) is still the one Shiori recorded writing
 * (`recorded`: its size and, when it was recorded, modification time — a file recorded before times
 * were kept is checked by its size alone). Times are compared to the millisecond the platforms share.
 * @param {{ size: number, mtime?: number | null }} recorded @param {{ size: number, mtime: number }} now @returns {boolean} */
export const unchanged = (recorded, now) => recorded.size === now.size
  && (!recorded.mtime || Math.floor(recorded.mtime) === Math.floor(now.mtime));

// ── Deleting a gallery's folder (principle 4) ──

/** What deleting gallery `galleryId`'s own folder takes — a deletion its library committed, or the
 * folder a move left — in the order taken, so that the folder names the gallery until the last step: one
 * cut short is finished from the library's record of it, and never leaves a folder of pictures naming
 * no gallery for a check to add as new (N2, N4).
 * 1. `pictures`: the files the library recorded writing there (`named`: name, size, modification time)
 *    and those the folder's manifest records (`manifest`, as it is now; null for format v1) — each only
 *    while it is still as recorded (unchanged);
 * 2. `descriptions`: its descriptions under their usual names, but the one naming it, then those stored
 *    by content (the folder `stored`) — each only while it is one of the gallery's (isOwnDescription);
 * 3. `identity`: what names it — its metadata.json, an earlier version's shiori.json, a linked gallery's
 *    overlay its source.json (linked-source.js), then its manifest — likewise.
 * Then the folders left empty, up to the gallery's own. Anything else — a person's own file, a picture
 * changed since Shiori wrote it — is left, and the gallery's folder with it. `named` null: the deletion
 * met the gallery at the other kind of place than its own — the other app unpacked the archive it was in
 * into a folder beside it (D17) — whose files it never recorded: what the folder's manifest records alone,
 * and nothing (null) where it has none: nothing there is known to be Shiori's (an earlier version's, or
 * the person's own copy), and it is left whole.
 * @param {{ area: string, manifest: Manifest | null, named: { name: string, size: number, mtime?: number | null }[] | null }} folder
 * @returns {{ pictures: { name: string, size: number, mtime?: number | null }[], descriptions: string[], stored: string, identity: string[] } | null} */
export function galleryDeletion({ area, manifest, named }) {
  if (!named && !manifest) return null;
  const pictures = new Map((named ?? []).map(f => [f.name, f]));
  for (const [name, [size, mtime]] of Object.entries(manifest?.sizes ?? {})) if (!pictures.has(name)) pictures.set(name, { name, size, mtime });
  return { pictures: [...pictures.values()], descriptions: DESCRIPTION_FILES.filter(n => n !== 'metadata.json'), stored: storedDir(area),
    identity: ['metadata.json', LEGACY_FILE, ...(area === '' ? [SOURCE_FILE] : []), manifestPath(area)] };
}
const LEGACY_FILE = 'shiori.json';

/** The entries of an archive in the gallery format (`entries`: each one's name → its size) that aren't
 * what Shiori puts in one — the pictures its manifest names (`manifest`, as read from it; null for an
 * archive written before manifests: any picture where the format puts pictures), each at the size the
 * manifest records for it; its descriptions; its manifest; a CBZ's ComicInfo.xml — so the person's: a
 * file they added, or a picture they replaced by one of another size. An archive holding any is never
 * deleted whole with its gallery (F6, S10: left, as a folder's deletion leaves a person's files), nor
 * written again whole, and they stay in its directory. `met`: one a folder's deletion met in its place
 * (the other app archived the gallery's folder), taken by its manifest alone, as galleryDeletion takes a
 * folder met so: without one, every entry is foreign (the person's own archive of the folder, perhaps).
 * @param {Map<string, { size: number }>} entries @param {Manifest | null} manifest @param {{ met?: boolean }} [how]
 * @returns {string[]} */
export function foreignEntries(entries, manifest, { met = false } = {}) {
  if (met && !manifest) return [...entries.keys()];
  const named = manifest ? new Set(namedPictures(manifest.files)) : null;
  const sizes = manifest?.sizes ?? {};
  /** @type {string[]} */
  const out = [];
  for (const [name, entry] of entries) {
    if (name === manifestPath('.shiori/') || DESCRIPTION_FILES.includes(name) || name === 'ComicInfo.xml') continue;
    if ((named ? named.has(name) : isPicturePath(name)) && !(sizes[name] && sizes[name][0] !== entry.size)) continue;
    out.push(name);
  }
  return out;
}

/** Whether `text`, the file at `path` in gallery `galleryId`'s folder (`area`: areaOf it), is one of
 * the gallery's descriptions as Shiori writes them, which its deletion takes: one stored by content
 * whose content matches its name; its manifest, naming it; an overlay's source.json, naming it; a
 * metadata.json, or an earlier version's shiori.json, naming it; another description under its usual
 * name, of its shape — or one the folder's manifest (`manifest`, as read there) names, whatever it says, as long as
 * it is the very text the manifest stored for it (D24's copy beside the manifest: a gallery with no metadata had
 * "null" there, S34). Anything else at those names isn't known to be Shiori's, and is left.
 * @param {string} path @param {string} text @param {string} galleryId @param {string} area
 * @param {Manifest | null} [manifest] @returns {Promise<boolean>} */
export async function isOwnDescription(path, text, galleryId, area, manifest = null) {
  if (storedHash(path) != null) return matches(path, text);
  const stored = manifest?.descriptions?.[path];
  if (stored && await matches(stored, text)) return true;
  if (path === manifestPath(area)) return parseManifest(text, { galleryId }).kind === 'ok';
  if (path === SOURCE_FILE && area === '') return parseSource(text)?.galleryId === String(galleryId);
  if (path === 'metadata.json' || path === LEGACY_FILE) {
    const what = classifyFolder({ [path]: text });
    return what.kind === 'gallery' && what.id === String(galleryId);
  }
  return DESCRIPTION_FILES.includes(path) && _description(path, text) !== undefined;
}

/** Whether a gallery's own folder that names no gallery — pictures only, as an earlier desktop version
 * could leave one it never described — may be given its identity (the desktop's first start, plan §10):
 * 'match' when it holds no description at all (`texts`: folder-content.js OWN_FILES → text, null or
 * missing for one it hasn't) and its pictures are exactly those its library recorded writing there
 * (`named`: path → size and modification time; `found`: what it holds, path → size and time) — each as
 * recorded, and none other. Else 'described' (it holds a description, of no gallery: never written
 * over) or 'mismatch' (its pictures aren't the library's): it stays a conflict, reported.
 * @param {{ texts: Record<string, string | null | undefined>, named: Map<string, { size: number, mtime?: number | null }>,
 *   found: Map<string, { size: number, mtime: number }> }} folder
 * @returns {'match' | 'described' | 'mismatch'} */
export function undescribedMatch({ texts, named, found }) {
  if (Object.values(texts).some(t => t != null)) return 'described';
  if (named.size !== found.size) return 'mismatch';
  for (const [name, now] of found) {
    const recorded = named.get(name);
    if (!recorded || !unchanged(recorded, now)) return 'mismatch';
  }
  return 'match';
}

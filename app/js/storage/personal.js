// personal.js — a person's own marks on a gallery (plan D6, D10, D11): whether they made it a
// favorite, and how far they read it. Marks stay with the library they were set in — this
// browser's, or a desktop install's (which a site using it shares) — kept in a store of its own by
// gallery id (db.js PERSONAL_STORE, the desktop's `personal` table), and are never written to a
// gallery's folder: a folder another library adds, or the other app takes over, carries none.
// Backups, a library's move and a gallery's export carry them (transfer's `personal`).
//
// An earlier version kept `favorite` in a gallery's metadata, and so in its folder's metadata.json.
// Metadata never holds it now (withoutPersonal, wherever a library stores metadata); a library
// takes such a mark into its store once — its own metadata's when it upgrades, a folder's when it
// adopts one of its galleries, a backup's or an export's when it restores it — and only while it has
// no favorite of its own for that gallery (importMarks). Pure.

/** A gallery's marks as a library keeps them; each field absent until set.
 * - `favorite`: set by the person (false once unset);
 * - `page`, `pages`: the last page read, and how many pages the gallery had then;
 * - `readAt`: when (ms);
 * - `finished`: whether it was ever read to its last page.
 * @typedef {{ favorite?: boolean, page?: number, pages?: number, readAt?: number, finished?: boolean }} Marks */

// The fields an earlier version kept in a gallery's metadata.
export const PERSONAL_FIELDS = ['favorite'];

// `meta` without the personal fields an earlier version kept there (the same object when it has none).
/** @template {object | null | undefined} M @param {M} meta @returns {M} */
export function withoutPersonal(meta) {
  if (!meta || !PERSONAL_FIELDS.some(k => k in meta)) return meta;
  /** @type {Record<string, unknown>} */
  const out = { ...meta };
  for (const k of PERSONAL_FIELDS) delete out[k];
  return /** @type {M} */ (out);
}

/** @param {unknown} n @returns {n is number} */
const _count = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 1;

// A gallery's marks as stored, read field by field (a store's record, a backup's, a window's): only
// well-formed fields kept; null when none is.
/** @param {unknown} value @returns {Marks | null} */
export function marksOf(value) {
  if (!value || typeof value !== 'object') return null;
  /** @type {any} a record of any shape, checked field by field */
  const v = value;
  /** @type {Marks} */
  const out = {};
  if (typeof v.favorite === 'boolean') out.favorite = v.favorite;
  if (_count(v.page) && _count(v.pages)) { out.page = v.page; out.pages = v.pages; }
  if (Number.isFinite(v.readAt) && v.readAt > 0) out.readAt = v.readAt;
  if (v.finished === true) out.finished = true;
  return Object.keys(out).length ? out : null;
}

// Marks `cur` changed by `change`: { favorite } set or unset, or { read: { page, pages } } — page
// `page` of the `pages` the gallery has, read at `now`: kept as where the person left off, and the
// gallery finished once its last page is reached (it stays so). Null when nothing is left.
/** @param {Marks | null | undefined} cur @param {{ favorite?: boolean, read?: { page: number, pages: number } }} change @param {number} [now] @returns {Marks | null} */
export function withMarks(cur, change, now = Date.now()) {
  /** @type {Marks} */
  const next = { ...(marksOf(cur) || {}) };
  if (typeof change?.favorite === 'boolean') next.favorite = change.favorite;
  const read = change?.read;
  if (read && _count(read.page) && _count(read.pages)) {
    next.page = Math.min(read.page, read.pages);
    next.pages = read.pages;
    next.readAt = now;
    if (next.page >= next.pages) next.finished = true;
  }
  return marksOf(next);
}

// The marks an earlier version's metadata `meta` carries (favorite: true), to take into a library's
// store — null when it carries none, or when the library has a favorite of its own for the gallery
// (`cur`, its marks): set there once, it is the person's.
/** @param {Marks | null | undefined} cur @param {{ favorite?: unknown } | null | undefined} meta @returns {Marks | null} */
export function importMarks(cur, meta) {
  if (meta?.favorite !== true || typeof cur?.favorite === 'boolean') return null;
  return withMarks(cur, { favorite: true });
}

// A series' new head taking its favorite over from the old head (series-plan.js `favorite`), as it does
// the series' title: the marks each has after — null for one that doesn't change.
/** @param {Marks | null | undefined} from @param {Marks | null | undefined} to @returns {{ from: Marks | null, to: Marks | null }} */
export function favoriteMoved(from, to) {
  const on = marksOf(from)?.favorite === true;
  return { from: on ? withMarks(from, { favorite: false }) : null,
    to: (marksOf(to)?.favorite === true) !== on ? withMarks(to, { favorite: on }) : null };
}

// The page the reader opens a gallery of `count` pages at when none is asked for (D11): where the
// person left off — the last page they read — or its first page when they read nothing of it, or left
// it at its end and it has no page more than it had then (read again from the start).
/** @param {Marks | null | undefined} marks @param {number} count @returns {number} */
export function resumeAt(marks, count) {
  const m = marksOf(marks);
  if (!m?.page || !m.pages || !_count(count)) return 1;
  if (m.page >= m.pages && count <= m.pages) return 1;
  return Math.min(m.page, count);
}

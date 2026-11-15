// folder-owner.js — which app keeps a library folder: .shiori/owner.json, beside the folder's own id
// (library.json). The app that adds a folder claims it; it lets it go (releases it) once it has
// removed it from its library, its galleries' descriptions brought up to date there first. One app
// writes to a folder at a time: another finding it claimed asks before taking it over (a folder two
// apps write to can put galleries out of sync), and the app it was taken from stops writing there.
// The claim's counter (`epoch`) changes with every app that claims it and never repeats, so an app
// adding back a folder it removed can tell whether another app had it meanwhile — what it kept of it
// then is out of date. Claims fail closed: a claim file that can't be read, or isn't a claim, means
// the folder's keeper can't be checked, and nothing is written there until it is taken back by hand —
// but it is no knowledge that another app holds it either: no change is refused for it (heldElsewhere).
// Pure: the browser library (db.js) and the desktop app's (server/folders.js) read and write the
// file. An app is known by its own id (a random one, kept where its library is) and described by
// `by`: { app: 'desktop', host } or { app: 'web', browser, site }.

import { holdsNothing } from './folder-content.js';

export const OWNER_FILE = '.shiori/owner.json';

// What reading the claim file found (`text`: its text, null when there is no file, or — any other
// value — the error the read failed with):
// - { state: 'absent' }: no file, or one holding nothing (folder-content.js holdsNothing: a first claim's
//   write cut short): no app claimed the folder (or its claim was deleted);
// - { state: 'damaged' }: a file that isn't a whole claim, or couldn't be read (`unread`: the read
//   failed — what a moment's failure answers, kept for no time: the next look reads it again): its
//   keeper can't be checked;
// - { state: 'claim', owner (an app's id, or null once released), by, at, epoch }.
/** @typedef {{ owner: string | null, by: Record<string, unknown> | null, at: number, epoch: number }} Claim */
/** @typedef {{ state: 'absent' } | { state: 'damaged', unread?: boolean } | ({ state: 'claim' } & Claim)} ClaimRead */
/** @param {unknown} text @returns {ClaimRead} */
export function readClaim(text) {
  if (text === null || holdsNothing(text)) return { state: 'absent' };
  if (typeof text !== 'string') return { state: 'damaged', unread: true };
  /** @type {any} JSON of any shape, checked field by field below */
  let c;
  try { c = JSON.parse(text); } catch {}
  const owner = c?.owner === null || (typeof c?.owner === 'string' && c.owner) ? c.owner : undefined;
  if (c?.format !== 'shiori-owner' || owner === undefined || !Number.isSafeInteger(c.epoch) || c.epoch < 0 || !Number.isFinite(c.at)) {
    return { state: 'damaged' };
  }
  return { state: 'claim', owner, by: c.by && typeof c.by === 'object' && !Array.isArray(c.by) ? c.by : null, at: c.at, epoch: c.epoch };
}
/** @param {Claim} claim @returns {string} */
export const claimText = (claim) => JSON.stringify({ format: 'shiori-owner', version: 1, ...claim }, null, 2);

// What app `me` may do with a folder of its library it holds at epoch `held` (its own last claim's),
// claimed as `read` (readClaim's): 'mine' (it holds it: it writes), 'free' (no claim, or the one it
// let go itself, untouched since: it claims it, reads the claim back, then writes), 'taken' (another
// app holds it, or held it since: nothing is written until it is taken back by hand) or 'unknown' (the
// claim is damaged or unreadable: the same).
/** @param {ClaimRead} read @param {string} me @param {number | null | undefined} held @returns {'mine' | 'free' | 'taken' | 'unknown'} */
export function access(read, me, held) {
  if (read.state === 'absent') return 'free';
  if (read.state !== 'claim') return 'unknown';
  if (read.owner === me) return 'mine';
  return read.owner == null && held != null && read.epoch === held ? 'free' : 'taken';
}

// How long a claim, as read, is taken as it is: what an app weighs it by meanwhile, without reading it
// again — the desktop's every write, both apps' commit gates.
export const CLAIM_TTL_MS = 5000;
// What a folder's claim as last read (`seen`: { read — readClaim's — owned — whether it is this app's
// (access 'mine') — at — when it was read, in ms }, or none) tells the commit gate (folder-lifecycle.js
// changeRefusal: one app changes a folder's galleries at a time) of another app holding the folder, at
// `now`: 'held' (a claim read within CLAIM_TTL_MS that names another app as holding it: the gate's one
// knowledge of it), 'stale' (any claim read longer ago: to be read again before it is weighed — a refusal
// never rests on it, nor does an acceptance where it can be read again at once), or null (no knowledge:
// none read, one that couldn't be read or isn't a claim, one no app holds — let go — or this app's own).
// A change the gate doesn't refuse for want of knowledge waits as for a folder out of reach: writes stay
// fail closed (access, writeAllowed).
/** @param {{ read: ClaimRead | null, owned: boolean, at: number } | null | undefined} seen @param {number} [now] @returns {'held' | 'stale' | null} */
export function heldElsewhere(seen, now = Date.now()) {
  if (!seen) return null;
  if (now - seen.at >= CLAIM_TTL_MS) return 'stale';
  return !seen.owned && seen.read?.state === 'claim' && seen.read.owner != null ? 'held' : null;
}

// App `me` (described by `by`) claiming a folder claimed as `read`: { claim, changed } — the claim to
// write when `changed` — or { refused: read } while another app holds it or its claim can't be
// checked (damaged, unreadable), unless `force` (the person chose to take it over). A claim let go,
// by any app, may be taken. `held`: the epoch this app last held it at, when it did. The new epoch is
// past every one known — max(held, the claim's) + 1; when the folder's last one can't be known (no
// claim file, or a damaged one), past any count: now, in ms — so no two claims share an epoch.
/**
 * @param {ClaimRead} read @param {string} me @param {Claim['by']} by
 * @param {{ held?: number | null, force?: boolean, now?: number }} [options]
 * @returns {{ claim: Claim, changed: boolean, refused?: undefined } | { refused: ClaimRead, claim?: undefined, changed?: undefined }}
 */
export function nextClaim(read, me, by, { held = null, force = false, now = Date.now() } = {}) {
  if (read.state === 'claim' && read.owner === me) return { claim: _claimOf(read), changed: false };
  if (!force && (read.state === 'damaged' || (read.state === 'claim' && read.owner != null))) return { refused: read };
  const epoch = read.state === 'claim' ? Math.max(held ?? 0, read.epoch) + 1 : Math.max((held ?? 0) + 1, now);
  return { claim: { owner: me, by, at: now, epoch }, changed: true };
}
/** @param {Claim} read @returns {Claim} */
const _claimOf = (read) => ({ owner: read.owner, by: read.by, at: read.at, epoch: read.epoch });

// The claim app `me` leaves when it lets the folder go — null when it doesn't hold it (nothing to
// write: the app holding it keeps it, and a damaged claim stays as it is).
/** @param {ClaimRead} read @param {string} me @param {number} [now] @returns {Claim | null} */
export const releasedClaim = (read, me, now = Date.now()) => (read.state === 'claim' && read.owner === me
  ? { owner: null, by: read.by, at: now, epoch: read.epoch } : null);

// Whether no other app has claimed a folder since app `me` held it at `epoch` (what it set aside
// when it let the folder go is then still how the folder is). A folder set aside before claims
// existed (`epoch` unknown) is taken as it was only when no app has claimed it yet; a damaged claim
// tells nothing, so not.
/** @param {ClaimRead} read @param {string} me @param {number | null | undefined} epoch @returns {boolean} */
export function unchangedSince(read, me, epoch) {
  if (read.state === 'absent') return epoch == null;
  return read.state === 'claim' && (read.owner == null || read.owner === me) && read.epoch === epoch;
}

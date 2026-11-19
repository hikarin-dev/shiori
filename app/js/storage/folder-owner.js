// folder-owner.js — which app keeps a library folder: .shiori/owner.json, beside the folder's own id
// (library.json). The app that adds a folder claims it; it lets it go (releases it) once it has
// removed it from its library, its galleries' descriptions brought up to date there first. One app
// writes to a folder at a time: another finding it claimed asks before taking it over (a folder two
// apps write to can put galleries out of sync), and the app it was taken from stops writing there.
// The claim's counter (`epoch`) changes with every app that claims it and never repeats, so an app
// adding back a folder it removed can tell whether another app had it meanwhile — what it kept of it
// then is out of date. Claims fail closed: a claim file that can't be read, or isn't a claim, means
// the folder's keeper can't be checked, and nothing is written there until it is taken back by hand —
// but it tells nothing of another app holding it either: no change is refused for it (heldElsewhere).
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
//   failed — what a moment's failure answers, kept for no time: the next look reads it again, and the
//   commit gate's last answer stands meanwhile, knownAfter): its keeper can't be checked;
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
// app holds it, or held it since: nothing is written until it is taken back by hand), 'unknown' (the
// claim is damaged or unreadable: the same) or 'handover' (its claim, but its hand-over's check hasn't
// read it yet — `handover`, the folder's mark — so it is as the other app's still: below).
/** @param {ClaimRead} read @param {string} me @param {number | null | undefined} held @param {Handover | null} [handover]
 * @returns {'mine' | 'free' | 'taken' | 'unknown' | 'handover'} */
export function access(read, me, held, handover = null) {
  if (read.state === 'absent') return 'free';
  if (read.state !== 'claim') return 'unknown';
  if (read.owner === me) return handover ? 'handover' : 'mine';
  return read.owner == null && held != null && read.epoch === held ? 'free' : 'taken';
}

// ── A hand-over (S32) ──
// A folder that comes (back) to an app is read before it is that app's. Its claim written over one that wasn't
// its own — another app's, active or let go, or one that couldn't be checked ("Take back", "Use anyway", adding
// a folder another app had) — begins a hand-over; this app's check having read the folder since ends it.
// Meanwhile the folder is to it as the other app's still, but for the check's own reading (access 'handover').
// Its mark ({ at, wait }) is kept with the folder's record, written before the claim file and cleared by the
// check, so a kill between any two steps leaves the folder to be read: the check starts by itself at the claim
// and at the next start. A claim that was this app's (or none) begins nothing: one app alone never meets one.
/** @typedef {{ at: number, wait: boolean }} Handover */
// `wait`: the claim replaced was held (or couldn't be checked). That app takes the folder for its own until its
// last read of the claim is CLAIM_TTL_MS old, and writes what it accepted then a moment later: the check reads
// nothing until that and HANDOVER_MARGIN_MS have passed since the claim (readsFrom), so it has landed.
export const HANDOVER_MARGIN_MS = 1000;
// A hand-over's check that ended without reading the folder (out of reach, its claim's read failing, stopped by a
// hide) is started again by itself once the folder answers as being handed over and no check of it is under way —
// at most this often, so a read that keeps failing never spins (S33, review 10 A1).
export const HANDOVER_RETRY_MS = 2000;
/** The hand-over this app's claim over `read` begins at `at` (its claim's time), or null for none.
 * @param {ClaimRead} read @param {string} me @param {number | null | undefined} held @param {number} [at] @returns {Handover | null} */
export function handoverOf(read, me, held, at = Date.now()) {
  const was = access(read, me, held);
  if (was === 'mine' || was === 'free') return null;
  return { at, wait: !(read.state === 'claim' && read.owner == null) };
}
/** When the hand-over's check may read the folder's galleries, in ms. @param {Handover} handover @returns {number} */
export const readsFrom = (handover) => handover.at + (handover.wait ? CLAIM_TTL_MS + HANDOVER_MARGIN_MS : 0);
// How long the check still waits before it reads, in ms (0: it reads now): until readsFrom on the computer's clock
// (`now`), but never longer than the window itself of this process's or page's own running time — `elapsed`, since it
// first waited on this mark, on a clock that never goes back — whatever the mark's `at` and the computer's clock say: a
// clock set back during a hand-over, or ahead as one a kill cut short began, never keeps the folder unread (S33, review
// 10 A2). The claim is older than the window by then, so the other app's window has passed on any clock.
/** @param {Handover} handover @param {number} now @param {number} elapsed @returns {number} */
export const waitLeft = (handover, now, elapsed) => Math.max(0, Math.min(readsFrom(handover) - now, readsFrom(handover) - handover.at - elapsed));
/** A folder's mark as kept (an object or its JSON): the hand-over, or null — anything else is one (fail closed).
 * @param {unknown} kept @returns {Handover | null} */
export function handoverIn(kept) {
  if (kept == null || kept === '') return null;
  /** @type {any} */
  let o = kept;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  return { at: Number.isFinite(o?.at) ? o.at : 0, wait: o?.wait !== false };
}

// How long a claim, as read, is taken as it is: what an app weighs it by meanwhile, without reading it
// again — the desktop's every write, both apps' commit gates.
export const CLAIM_TTL_MS = 5000;
// What the commit gate (folder-lifecycle.js changeRefusal: one app changes a folder's galleries at a
// time) knows of a folder: the last claim it read — `known`: { read (readClaim's), owned (whether it is
// this app's: access 'mine'), at (when it was read, in ms) }, or none read yet. The claim read again as
// `read` (this app's when `owned`) at `at` is the answer from then on — but a read that failed (`unread`)
// says nothing: it is not kept, and the last answer stands. A folder out of reach is no read at all (the
// adapters pass nothing here then), so it changes nothing of it either. Kept in memory, per process or page.
/** @typedef {{ read: ClaimRead, owned: boolean, at: number }} Known */
/** @param {Known | null | undefined} known @param {ClaimRead} read @param {boolean} owned @param {number} at @returns {Known | null} */
export const knownAfter = (known, read, owned, at) => (read.state === 'damaged' && read.unread ? known ?? null : { read, owned, at });
// What the gate weighs, at `now`: { held, again } — `held`: the last answer names another app as holding
// the folder, whatever its age, so a change to what the folder holds is refused until a later read says
// otherwise (this app's claim, one let go, none, or a file there that isn't a claim — a damaged claim
// tells nothing of another app); `again`: the claim is to be read again — none read yet, or read
// CLAIM_TTL_MS ago or more. The desktop reads it before it weighs the change; the website, whose gate sits
// inside a transaction and can't wait, at once in the background, weighing the last answer meanwhile (with
// none, nothing is refused). No file call for a change inside the time to live. Nothing refused for want
// of an answer is written meanwhile: writes stay fail closed (access, writeAllowed).
/** @param {Known | null | undefined} known @param {number} [now] @returns {{ held: boolean, again: boolean }} */
export function heldElsewhere(known, now = Date.now()) {
  if (!known) return { held: false, again: true };
  return { held: !known.owned && known.read.state === 'claim' && known.read.owner != null, again: now - known.at >= CLAIM_TTL_MS };
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

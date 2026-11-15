// folder-lifecycle.js — a library folder's lifecycle, as both apps keep it: its one persisted state,
// and what each state allows. A place (a library folder, or the browser's own storage) is
// - 'shown': its galleries are in the library, and the library writes to it;
// - 'hidden': listed, its galleries out of the library until it is shown again; nothing is written to
//   it meanwhile (what waits for it is written once it is shown);
// - 'removing': leaving the library — its galleries out of it at once, its removal writing back what
//   only the library has of them (that write-back alone writes to it), then forgetting it.
// Work on a folder (its check, its removal) runs one job at a time, in its queue (jobPlan); a removal
// forgets the folder only when everything is saved there, or the person chose to discard what isn't
// (removalOutcome), and a deletion the folder owes ends as unfoundEnd says. Pure: the browser library
// (db.js, folder-library.js, folder-scan.js) and the desktop app's (server/folders.js, files.js, scan.js)
// keep the state and run the work.

/** @typedef {'shown' | 'hidden' | 'removing'} State */
/** @type {State[]} */
export const STATES = ['shown', 'hidden', 'removing'];

// Whether a place's galleries are in the library in state `state`.
/** @param {string} state @returns {boolean} */
export const mounted = (state) => state === 'shown';

// What may be done with a place `{ state, isDefault, owned, reachable }` (`owned`: this library holds
// its claim — folder-owner.js access 'mine'; `reachable`: it can be read and written now, its drive
// there and, in the browser, its permission granted):
/** @typedef {{ state: string, isDefault?: boolean, owned?: boolean, reachable?: boolean }} Place */
// hidden — not the default place (new galleries need somewhere shown to go), and shown;
/** @param {Place} place @returns {boolean} */
export const canHide = ({ state, isDefault }) => state === 'shown' && !isDefault;
// shown again — hidden;
/** @param {Place} place @returns {boolean} */
export const canShow = ({ state }) => state === 'hidden';
// made the default (new galleries go there), or a gallery moved there — shown, held and reachable.
/** @param {Place} place @returns {boolean} */
const _canTake = ({ state, owned, reachable }) => state === 'shown' && !!owned && !!reachable;
export const canSetDefault = _canTake;
export const canMoveTo = _canTake;

// The place new galleries go to once place `leaving` can't take them (it is being removed): the first
// of `places` (the browser's own storage, or the desktop app's first folder, first; then the others
// as they were added: [{ id, state, owned, reachable }]) other than `leaving` that can be the default
// (canSetDefault). Null when none can — the removal is then refused, as hiding the default is.
/** @param {(Place & { id: string })[]} places @param {string | null} leaving @returns {string | null} */
export const nextDefault = (places, leaving) => places.find(p => p.id !== leaving && canSetDefault(p))?.id ?? null;

// Whether a write to a library folder may go ahead now — the one gate in front of every change to its
// files: it can be reached, and this library holds its claim, and its state allows it ('shown'; while
// 'removing', the removal's own write-back alone). `work`: what writes — 'removal' (the removal's
// write-back), 'publish' (the publication of changes committed to the library before: the one write a
// hidden folder takes too, so a folder hidden with changes not yet saved to it still becomes current —
// plan §3.4), 'claim' (the claim file itself, .shiori/owner.json: needs the folder reachable, nothing
// more), or nothing (anything else).
/** @param {Place & { work?: 'removal' | 'publish' | 'claim' | null }} place @returns {boolean} */
export function writeAllowed({ state, owned, reachable, work = null }) {
  if (!reachable) return false;
  if (work === 'claim') return true;
  return !!owned && (state === 'shown' || (state === 'removing' && work === 'removal') || (state === 'hidden' && work === 'publish'));
}

// Why a change to a gallery is refused as it is committed — the commit gate's one rule (the website's
// db.js _logIn, the desktop's library.js _mountCheck and _heldCheck) — or null when it isn't: 'hidden' (the
// gallery's place, `state` — null for a folder the library no longer knows — isn't in the library:
// nothing of it changes) or 'not-owned' (one app changes a folder's galleries at a time, the owner's rule
// of 2026-11-15: the library knows another app holds the folder, `taken` — a claim read within its time
// to live that names another app, folder-owner.js heldElsewhere: knowledge only, never a claim that
// couldn't be read nor an old read — and the folder holds the gallery as published, `held`
// (gallery-manifest.js published), so the change would reach what that app may be changing: refused,
// never kept to be saved later). Only a
// `change` reaching the folder is weighed for 'not-owned' — the person's own marks, a size or a total no
// description shows, are not — and a gallery only this library has (made meanwhile, never published
// there) keeps working: what it gets waits, as for a folder out of reach. `work`: the change is that
// folder's own work (its check, its removal), never refused.
/** @param {{ state: string | null, work?: boolean, change?: boolean, taken?: boolean, held?: boolean }} at
 * @returns {'hidden' | 'not-owned' | null} */
export function changeRefusal({ state, work = false, change = false, taken = false, held = false }) {
  if (work) return null;
  if (!state || !mounted(state)) return 'hidden';
  return change && taken && held ? 'not-owned' : null;
}

// Why a folder store's open() refuses `purpose` (contract.js Purpose) at a place, or null when it
// doesn't: 'unavailable' (it can't be reached), 'other-library' (its path holds another library folder,
// or a folder naming none: `here` false — principle 1: never read, scanned, adopted or written as it),
// 'hidden' (its state allows no change: hidden — but for a publication — or being removed, where only
// its removal's write-back may write) or 'not-owned' (another app holds its claim, or it can't be
// checked). Reading needs it reachable and here alone; every other purpose is weighed as a write
// (writeAllowed), the claim file's own too.
/** @param {Place & { here?: boolean }} place @param {string} purpose @returns {'unavailable' | 'other-library' | 'hidden' | 'not-owned' | null} */
export function refusalFor({ state, owned, reachable, here = true }, purpose) {
  if (!reachable) return 'unavailable';
  if (!here) return 'other-library';
  if (purpose === 'read') return null;
  const allowed = state === 'shown' || (state === 'removing' && purpose === 'removal') || (state === 'hidden' && purpose === 'publish');
  if (!allowed) return 'hidden';
  return owned ? null : 'not-owned';
}

// What a folder's queue does with a job asked for (`requested`: 'scan' or 'removal') while another
// runs (`running`: its kind, or null when none does):
// - 'start': nothing runs — start it;
// - 'join': the same work runs — the request waits for it and shares its outcome (a check asked during
//   a check; a removal asked again, or resumed, during the removal);
// - 'after': a removal asked during a check — stop the check, then start the removal;
// - 'refuse': a check asked during a removal (the folder is leaving).
export const JOBS = ['scan', 'removal'];
/** @typedef {'start' | 'join' | 'after' | 'refuse'} JobPlan */
/** @type {Record<string, Record<string, JobPlan>>} */
const PLANS = { scan: { scan: 'join', removal: 'after' }, removal: { scan: 'refuse', removal: 'join' } };
/** @param {string | null} running @param {string} requested @returns {JobPlan} */
export function jobPlan(running, requested) {
  if (!JOBS.includes(requested) || (running != null && !JOBS.includes(running))) throw new TypeError(`no plan for ${requested} while ${running} runs`);
  return running == null ? 'start' : PLANS[running][requested];
}

// How a removal ends, once its galleries were written back: `required` — the ids of every gallery
// placed in the folder (what was moved out has left it); `saved` — those confirmed to have everything
// in the folder (written back now with a positive result, or with nothing waiting: no unwritten
// changes, no pictures held back, a folder of their own); `discard` — the person chose to lose what
// can't be saved. Resolves { forget, unsaved }: `unsaved`, the required ids not saved (with `discard`,
// what is lost); `forget`, whether the folder and its galleries' records are forgotten now — else the
// removal is kept (the folder goes back to its state before it).
/**
 * @param {{ required: Iterable<string | number>, saved: Iterable<string | number>, discard?: boolean }} removal
 * @returns {{ forget: boolean, unsaved: string[] }}
 */
export function removalOutcome({ required, saved, discard = false }) {
  const done = new Set([...saved].map(String));
  const unsaved = [...new Set([...required].map(String))].filter(gid => !done.has(gid));
  return { forget: !!discard || !unsaved.length, unsaved };
}

// A gallery deleted while its folder or archive wasn't where the library had it (moved, renamed or deleted
// by hand) waits `unfound` — owed by its library folder, whose removal is refused while it waits — for a look
// at that folder (a check, or its removal's, which looks as a check does) to meet a folder or archive naming
// it, deleted there and never adopted (S10's F4). A look that didn't meet it rules it out once it could tell
// whose everything it walked is: what it couldn't read at all (leavesOpen: a folder it couldn't list, a
// description or an archive it couldn't read) may be the gallery's, while what it read, damaged or not, isn't
// (review 6 F6, review 7 A1). A deletion looks can't rule out is given up after UNFOUND_LOOKS of them — a
// folder holding a thing no look ever reads would keep it for good — and a folder naming the gallery that
// turns up later is the person's copy, which joins (plan §8).
export const UNFOUND_LOOKS = 3;
// Whether a problem a look reports ({ reason }) leaves open whose the thing is: only what couldn't be read.
/** @param {{ reason: string }} problem @returns {boolean} */
export const leavesOpen = (problem) => problem.reason === 'unreadable';
// What a look's end does with a deletion waiting `unfound`: `met` — it met the gallery's folder or archive
// (deleted there: kept until that is done); `whole` — nothing it walked leaves the question open; `misses`
// — the looks it waited through already that couldn't rule it out. Resolves 'keep', 'forget', or the
// deletion's count of such looks from now on.
/** @param {{ met: boolean, whole: boolean, misses?: number | null }} look @returns {'keep' | 'forget' | number} */
export function unfoundEnd({ met, whole, misses = 0 }) {
  if (met) return 'keep';
  const next = (misses ?? 0) + 1;
  return whole || next >= UNFOUND_LOOKS ? 'forget' : next;
}

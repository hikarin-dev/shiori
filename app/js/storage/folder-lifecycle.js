// folder-lifecycle.js — a library folder's lifecycle, as both apps keep it: its one persisted state,
// and what each state allows. A place (a library folder, or the browser's own storage) is
// - 'shown': its galleries are in the library, and the library writes to it;
// - 'hidden': listed, its galleries out of the library until it is shown again; nothing is written to
//   it meanwhile (what waits for it is written once it is shown);
// - 'removing': leaving the library — its galleries out of it at once, its removal writing back what
//   only the library has of them (that write-back alone writes to it), then forgetting it.
// Work on a folder (its check, its removal) runs one job at a time, in its queue (jobPlan); a removal
// forgets the folder only when everything is saved there, or the person chose to discard what isn't
// (removalOutcome). Pure: the browser library (db.js, folder-library.js, folder-scan.js) and the
// desktop app's (server/folders.js) keep the state and run the work.

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
// write-back), 'claim' (the claim file itself, .shiori/owner.json: needs the folder reachable, nothing
// more), or nothing (anything else).
/** @param {Place & { work?: 'removal' | 'claim' | null }} place @returns {boolean} */
export function writeAllowed({ state, owned, reachable, work = null }) {
  if (!reachable) return false;
  if (work === 'claim') return true;
  return !!owned && (state === 'shown' || (state === 'removing' && work === 'removal'));
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

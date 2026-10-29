// folder-owner.js — which app keeps a library folder: .shiori/owner.json, beside the folder's own id
// (library.json). The app that adds a folder claims it; it lets it go (releases it) once it has
// removed it from its library, its galleries' descriptions brought up to date there first. One app
// writes to a folder at a time: another finding it claimed asks before taking it over (a folder two
// apps write to can put galleries out of sync), and the app it was taken from stops writing there.
// The claim's counter (`epoch`) goes up with every app that claims it, so an app adding back a folder
// it removed can tell whether another app had it meanwhile — what it kept of it then is out of date.
// Pure: the browser library (db.js) and the desktop app's (server/library.js) read and write the
// file. An app is known by its own id (a random one, kept where its library is) and described by
// `by`: { app: 'desktop', host } or { app: 'web', browser, site }.

export const OWNER_FILE = '.shiori/owner.json';

// The claim a file's text holds — { owner (an app's id, or null once released), by, at, epoch } —
// or null: no file (no app claimed the folder) or one that isn't a claim.
export function parseClaim(text) {
  if (text == null) return null;
  let c;
  try { c = JSON.parse(text); } catch { return null; }
  if (c?.format !== 'shiori-owner') return null;
  return { owner: typeof c.owner === 'string' && c.owner ? c.owner : null, by: c.by && typeof c.by === 'object' ? c.by : null,
    at: Number(c.at) || 0, epoch: Number(c.epoch) || 0 };
}
export const claimText = (claim) => JSON.stringify({ format: 'shiori-owner', version: 1, ...claim }, null, 2);

// What app `me` may do with a folder claimed as `cur`: 'mine' (it holds it), 'free' (no app ever
// claimed it: it may, as it is), or 'taken' (another app holds it, or let it go after taking it).
export const claimState = (cur, me) => (!cur ? 'free' : cur.owner === me ? 'mine' : 'taken');

// App `me` (described by `by`) claiming a folder claimed as `cur`: { claim, changed } — the claim to
// write when `changed` — or { refused: cur } while another app holds it, unless `force`.
export function claimFor(cur, me, by, { force = false, now = Date.now() } = {}) {
  if (cur?.owner === me) return { claim: cur, changed: false };
  if (cur?.owner && !force) return { refused: cur };
  return { claim: { owner: me, by, at: now, epoch: (cur?.epoch || 0) + 1 }, changed: true };
}

// The claim app `me` leaves when it lets the folder go — null when it doesn't hold it (nothing to
// write: the app holding it keeps it).
export const releaseOf = (cur, me, now = Date.now()) => (cur?.owner === me ? { owner: null, by: cur.by, at: now, epoch: cur.epoch } : null);

// Whether no other app has claimed a folder since app `me` held it at `epoch` (what it set aside
// when it let the folder go is then still how the folder is). A folder set aside before claims
// existed (`epoch` unknown) is taken as it was only when no app has claimed it yet.
export const unclaimedSince = (cur, me, epoch) => (cur ? (cur.owner == null || cur.owner === me) && cur.epoch === epoch : epoch == null);

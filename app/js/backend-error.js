// backend-error.js — what a library backend rejects a command with (see api.js). `code` says what
// went wrong in a way the app can act on; `message` is for logs, not for display.
//   not-found    a gallery the command needs doesn't exist
//   invalid      the request breaks a rule (a bad page number, a gallery merged into itself)
//   conflict     the library changed under the command
//   quota        out of space
//   unavailable  the library can't be reached
//   aborted      the write didn't commit, for any other reason
export class BackendError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
  }
}

// A change refused for now by which app may change its gallery's folder: `reason` 'not-owned' (another app holds
// it), 'taken' (the same, for a folder's own work) or 'handover' (it came back and is still being read). Every
// place that weighs one asks here, and words it by refusalKey.
const REFUSED_FOR_NOW = ['not-owned', 'taken', 'handover'];
export const refusedForNow = (e) => REFUSED_FOR_NOW.includes(e?.reason);
// The locale key such a refusal is said by, or null for any other failure.
export const refusalKey = (e) => (e?.reason === 'handover' ? 'lf.handover_msg' : refusedForNow(e) ? 'lf.taken_msg' : null);

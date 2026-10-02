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

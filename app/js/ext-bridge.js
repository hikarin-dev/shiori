// ext-bridge.js — the app's channel to the extension. It talks to the extension's content
// script (extension/content/bridge.js) over window.postMessage; that script relays to the
// extension service worker. When the extension isn't installed there is no relay, so request()
// times out to null and the app degrades gracefully (downloads and on-site capture need it;
// everything else works without).

let _seq = 0;
const _pending = new Map();

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.__shiori !== 'from-ext') return;
  const d = e.data;
  if (d.replyTo != null && _pending.has(d.replyTo)) {
    const resolve = _pending.get(d.replyTo);
    _pending.delete(d.replyTo);
    resolve(d.response);
  }
});

// Send a message to the extension SW; resolves with its response, or null if no extension answered.
export function request(msg, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const id = ++_seq;
    _pending.set(id, resolve);
    setTimeout(() => { if (_pending.has(id)) { _pending.delete(id); resolve(null); } }, timeoutMs);
    window.postMessage({ __shiori: 'to-ext', id, msg }, location.origin);
  });
}

// Is the extension actually alive behind the relay? Round-trips to its service worker, so a
// disabled/reloaded extension reads as unavailable (its orphaned content script can't answer).
export async function available() { return !!(await request({ type: 'PING' }, 1500)); }

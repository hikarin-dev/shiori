// reader-page-menu.js — the reader's right-click menu for one page, and the status line that
// follows a page's translation. The reader decides the items; the one page draws the menu: its reader
// route registers a host here (setPageMenuHost, src/routes/reader/page-menu-store.ts) before it starts
// the reader, and openPageMenu hands the request to it, which draws it at the pointer with the app's
// menu (src/routes/reader/page-menu.tsx). Shift+right-click keeps the browser's own menu (the reader's).

let _host = null;
export function setPageMenuHost(host) {
  _host = host;
  return () => { if (_host === host) _host = null; };
}
const _drawer = () => {
  if (!_host) throw new Error('reader-page-menu.js: no page menu host has registered (setPageMenuHost)');
  return _host;
};

export const pageMenuOpen = () => !!_host?.isOpen();
export function closePageMenu() { _host?.close(); }   // the reader's stop

// `items`: [{ label, detail?, kbd?, disabled?, onPick }]. A choice closes the menu, then runs onPick.
export function openPageMenu(x, y, title, items) {
  _drawer().open({ x, y, title, items });
}

// One line at the bottom of the reader; `busy` shows a spinner and stays until replaced.
let _status = null, _statusTimer = 0;
export function pageStatus(text, { busy = false, error = false } = {}) {
  if (!_status) {
    _status = document.createElement('div');
    _status.className = 'page-status';
    _status.setAttribute('role', 'status');
    _status.setAttribute('aria-live', 'polite');
    document.body.append(_status);
  }
  clearTimeout(_statusTimer);
  _status.classList.toggle('busy', busy);
  _status.classList.toggle('error', error);
  _status.textContent = text;
  _status.classList.add('show');
  if (!busy) _statusTimer = setTimeout(() => _status.classList.remove('show'), error ? 7000 : 3500);
}
// The reader's stop: the status line goes, as before it first showed.
export function clearPageStatus() {
  clearTimeout(_statusTimer);
  _status?.remove();
  _status = null;
}

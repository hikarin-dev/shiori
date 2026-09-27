// reader-page-menu.js — the reader's right-click menu for one page, and the status line that
// follows a page's translation. The reader decides the items; this places the menu at the pointer,
// keeps it on screen and handles the keyboard. Shift+right-click keeps the browser's own menu.

let _open = null;

function close() {
  if (!_open) return;
  _open.menu.remove();
  document.removeEventListener('pointerdown', _open.outside, true);
  document.removeEventListener('keydown', _open.key, true);
  window.removeEventListener('scroll', close, true);
  window.removeEventListener('resize', close);
  window.removeEventListener('blur', close);
  _open = null;
}

export const pageMenuOpen = () => !!_open;

// `items`: [{ label, detail?, kbd?, disabled?, onPick }].
export function openPageMenu(x, y, title, items) {
  close();
  const menu = document.createElement('div');
  menu.className = 'page-menu';
  menu.setAttribute('role', 'menu');
  const head = document.createElement('div');
  head.className = 'page-menu-title';
  head.textContent = title;
  menu.append(head);
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'page-menu-item';
    button.setAttribute('role', 'menuitem');
    button.disabled = !!item.disabled;
    const label = document.createElement('span');
    label.className = 'page-menu-label';
    label.textContent = item.label;
    if (item.kbd) {
      const kbd = document.createElement('kbd');
      kbd.textContent = item.kbd;
      label.append(kbd);
    }
    button.append(label);
    if (item.detail) {
      const detail = document.createElement('span');
      detail.className = 'page-menu-detail';
      detail.textContent = item.detail;
      button.append(detail);
    }
    button.addEventListener('click', () => { close(); item.onPick(); });
    menu.append(button);
  }
  document.body.append(menu);
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(innerWidth - m.width - 8, x))}px`;
  menu.style.top = `${Math.max(8, Math.min(innerHeight - m.height - 8, y))}px`;
  const enabled = [...menu.querySelectorAll('.page-menu-item:not(:disabled)')];
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const at = enabled.indexOf(document.activeElement);
    enabled[(at + (e.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length]?.focus();
  };
  _open = { menu, outside, key };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  enabled[0]?.focus({ preventScroll: true });
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

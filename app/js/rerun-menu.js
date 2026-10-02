// rerun-menu.js — "Re-run from…" for an already-translated gallery or chapter.
//
// Translating again normally redoes only what changed. This menu redoes every page from one step
// onward, reusing the steps before it — the way to get, say, a fresh translation with unchanged
// settings. Each step says whether it is possible: how many pages have the saved data to start
// there (the rest run from the beginning), or why it can't be used. Opened from the translate
// button's context menu.

import { t } from './i18n.js';
import * as api from './api.js';
import { RERUN_POINTS, rerunAvailability } from './page-data.js';

let _open = null;

function close() {
  if (!_open) return;
  _open.menu.remove();
  document.removeEventListener('pointerdown', _open.outside, true);
  document.removeEventListener('keydown', _open.key, true);
  window.removeEventListener('scroll', close, true);
  window.removeEventListener('resize', close);
  const anchor = _open.anchor;
  _open = null;
  if (anchor?.isConnected) anchor.focus();
}

export function rerunLabel(point) {
  return t(`rerun.${point}`);
}

// What choosing `point` would do for this gallery, as a one-line status (and whether it can).
export function rerunStatus({ pages, ready }) {
  if (!pages) return { enabled: false, text: t('rerun.unaffected') };
  if (!ready) return { enabled: false, text: t('rerun.nothing_saved') };
  if (ready < pages) return { enabled: true, text: t('rerun.some', { ready, n: pages }) };
  return { enabled: true, text: t('rerun.all', { n: pages }) };
}

// Show the menu under `anchor` for `galleryId`; `onPick(pointId, label)` runs for a chosen step.
export async function openRerunMenu(anchor, galleryId, onPick) {
  close();
  const records = (await api.pages.all(galleryId)).filter(r => r.blob ?? r.dataUrl);
  const availability = rerunAvailability(records);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu rerun-menu';
  menu.setAttribute('role', 'menu');
  const title = document.createElement('div');
  title.className = 'ctx-menu-title';
  title.textContent = t('rerun.title');
  menu.append(title);
  for (const point of Object.keys(RERUN_POINTS)) {
    const status = rerunStatus(availability[point]);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ctx-menu-item';
    item.setAttribute('role', 'menuitem');
    item.disabled = !status.enabled;
    const label = document.createElement('span');
    label.className = 'ctx-menu-label';
    label.textContent = rerunLabel(point);
    const detail = document.createElement('span');
    detail.className = 'ctx-menu-detail';
    detail.textContent = status.text;
    item.append(label, detail);
    item.addEventListener('click', () => { close(); onPick(point, label.textContent); });
    menu.append(item);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - m.width - 8, r.left));
  const top = r.bottom + 6 + m.height > innerHeight ? Math.max(8, r.top - m.height - 6) : r.bottom + 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const items = [...menu.querySelectorAll('.ctx-menu-item:not(:disabled)')];
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  _open = { menu, anchor, outside, key };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  items[0]?.focus();
}

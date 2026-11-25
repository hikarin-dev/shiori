// rerun-menu.js — "Re-run from…" for an already-translated gallery or chapter: each step's name, and
// what choosing it would do.
//
// Translating again normally redoes only what changed. The menu (src/components/rerun-menu.tsx,
// opened from the translate button's context menu) redoes every page from one step onward, reusing
// the steps before it — the way to get, say, a fresh translation with unchanged settings. Each step
// says whether it is possible: how many pages have the saved data to start there (the rest run from
// the beginning), or why it can't be used.

import { t } from './i18n.js';

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

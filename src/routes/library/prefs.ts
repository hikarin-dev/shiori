// The library's preferences, read through the app's preferences store (src/lib/prefs.ts) over
// platform.kv, with 1.3's keys and stored values: Settings' own rows for the library's (its table,
// app/js/settings-prefs.js), the overview's chapters/volumes view, and the filter's dialog. Every key is
// read before the page is first drawn (this module is part of the route's chunk, which the router
// waits for), so the first page is read with them; the page follows other tabs' and Settings' changes
// while it shows.
import { useSyncExternalStore } from 'react';
import * as platform from '@lib/platform.js';
import { SETTINGS_PREFS } from '@lib/settings-prefs.js';
import { TAG_VALUES } from '@lib/tag-editor.js';
import { createPrefs, type Pref } from '@/lib/prefs';
import { readFilter, type LibFilter } from '@/lib/library-search';

const S = SETTINGS_PREFS as unknown as Record<string, Pref>;
const TABLE: Record<string, Pref> = {
  libShowNavStats: S.libShowNavStats,           // the header's totals shown
  libMergeSeries: S.libMergeSeries,             // a series as one card
  libQuickActionsMode: S.libQuickActionsMode,   // 'hover' | 'always' | 'hidden'
  libHideAppLangFlag: S.libHideAppLangFlag,     // the app's own language's flag left off
  libShowCategoryTag: S.libShowCategoryTag,     // the category tag shown
  readerSkipOverview: S.readerSkipOverview,     // the chapter overview shown (stored as skipped)
  // The overview's choice of chapters or volumes, by which a series' badge counts.
  seriesView: { read: (value) => (value === 'volumes' ? 'volumes' : 'chapters'), write: (value: string) => value },
  // The filter's dialog: shown as its stored form, made canonical (JSON) so a read that changed
  // nothing is no change; stored as the object it is (1.3's form).
  libFilter: {
    read: (value) => JSON.stringify(readFilter(value, TAG_VALUES as unknown as Record<string, string[]>)),
    write: (value: string) => JSON.parse(value) as LibFilter,
  },
};

export const prefs = createPrefs(platform.kv, TABLE);
await prefs.load();

export type LibraryPref = keyof typeof TABLE;
export function usePref<T>(key: LibraryPref): T {
  return useSyncExternalStore(prefs.subscribe, () => prefs.get(key)) as T;
}

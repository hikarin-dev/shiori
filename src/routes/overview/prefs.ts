// The overview's preferences, through the app's preferences store (src/lib/prefs.ts) over platform.kv,
// with 1.3's key and stored value: which members a series' list shows, its chapters or its volumes
// (seriesView, 1.3's `_view`; the library's cards count by it too). Read before the page is first drawn
// (this module is part of the route's chunk, which the router waits for), and followed while the page
// shows: another tab's choice is shown with no reload (1.3 read it once, as its page loaded).
import { useSyncExternalStore } from 'react';
import * as platform from '@lib/platform.js';
import { createPrefs, type Pref } from '@/lib/prefs';

const TABLE: Record<string, Pref> = {
  seriesView: { read: (value) => (value === 'volumes' ? 'volumes' : 'chapters'), write: (value: string) => value },
};

export const prefs = createPrefs(platform.kv, TABLE);
await prefs.load();

export function useSeriesView() {
  return useSyncExternalStore(prefs.subscribe, () => prefs.get('seriesView')) as 'chapters' | 'volumes';
}

// library-query.ts — how the views read the library (T4): one query cache for the app, whose entries
// the library's own change feed refreshes. Plain (no React, no app module), so Node tests it as it is;
// src/lib/gallery.ts puts it on the app's library.
//
// A read of a local library never waits on the network and is never made again by itself: no read on
// focus or on reconnecting, none because time passed (data is never stale by age), no retry that would
// hide an error. A read is made again only because the library said a gallery changed: the change
// feed (api.events.watch: a gallery's id, or '*' for "anything may have changed") marks the gallery's
// entry stale, and an entry a view shows is read again. Paced as 1.3's pages were: a gallery being
// downloaded changes with every page, so it is read again once things settle, `settle` ms after the
// last change heard for it.
//
// Reads that overlap land in any order; the cache keeps the newest one's result: a read made again
// while one is under way supersedes it, and the superseded one's result is dropped wherever it lands
// (closing store.js's fault, plans §2.7, by construction; app/tests/library-query.test.mjs).
import { QueryClient } from '@tanstack/react-query';

export const SETTLE_MS = 500;

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: 'always',
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        retry: false,
        staleTime: Infinity,
      },
    },
  });
}

// The key of a gallery's entry, and of all of them.
export const GALLERIES = ['gallery'] as const;
export const galleryKey = (id: string) => ['gallery', id] as const;

// Reads the gallery `gid` again ('*': every gallery) where a view shows it, and marks it stale where
// none does. A read under way is superseded, its result dropped: the cache does that by itself once
// it holds a gallery, but folds a read into the first one still under way, which may have read the
// gallery as it was before the change, so that one is called off first.
export async function readAgain(client: QueryClient, gid: string) {
  const queryKey = gid === '*' ? GALLERIES : galleryKey(gid);
  await client.cancelQueries({ queryKey, predicate: (q) => q.state.data === undefined && q.state.fetchStatus === 'fetching' });
  client.invalidateQueries({ queryKey }).catch(() => {});   // (its promise is the reads': not waited for)
}

type Watch = (cb: (gid: string, beacon: unknown) => void) => () => void;
type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };

// Follows the change feed `watch` into `client`: each gallery said to have changed is marked stale
// `settle` ms after the last word of it ('*': every gallery). Returns what stops it (its timers too).
export function followChanges(client: QueryClient, watch: Watch, { settle = SETTLE_MS, timers = globalThis as unknown as Timers } = {}) {
  const pending = new Map<string, unknown>();
  let stopped = false;
  const fire = (gid: string) => {
    pending.delete(gid);
    if (!stopped) readAgain(client, gid).catch(() => {});
  };
  const off = watch((gid) => {
    if (stopped) return;   // a catch-up begun before the stop
    timers.clearTimeout(pending.get(gid));
    pending.set(gid, timers.setTimeout(() => fire(gid), settle));
  });
  return () => {
    stopped = true;
    off();
    for (const handle of pending.values()) timers.clearTimeout(handle);
    pending.clear();
  };
}

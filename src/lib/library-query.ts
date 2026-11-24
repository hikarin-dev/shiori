// library-query.ts — how the views read the library (T4): one query cache for the app, whose entries
// the library's own change feed refreshes. Plain (no React, no app module), so Node tests it as it is;
// src/lib/gallery.ts puts it on the app's library.
//
// A read of a local library never waits on the network and is never made again by itself: no read on
// focus or on reconnecting, none because time passed (data is never stale by age), no retry that would
// hide an error. A read is made again only because the library said a gallery changed: the change
// feed (api.events.watch: a gallery's id, or '*' for "anything may have changed") marks the gallery's
// entry stale, and an entry a view shows is read again. At once, as 1.3's pages drew a change; and
// paced, since a gallery being downloaded changes with every page: the first word about a gallery is
// read at once and opens a window of `settle` ms, and words within it end in one more read at its
// close (which opens the next), so a download storing 300 pages costs a read every `settle` ms.
//
// Reads that overlap land in any order; the cache keeps the newest one's result: a read made again
// while one is under way supersedes it, and the superseded one's result is dropped wherever it lands
// (closing store.js's fault, plans §2.7, by construction; app/tests/library-query.test.mjs).
//
// An edit the page itself makes (a favourite, a source) is drawn before the library answers
// (editGallery): set on the gallery's entry at once, held over every read made before the library has
// it, and put back if the library refuses it (1.3's _pendingSourceChanges).
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

// Follows the change feed `watch` into `client`: a gallery said to have changed ('*': every gallery)
// is read again at once; words about it in the `settle` ms after a read end in one more read when
// they are up. Returns what stops it (its timers too).
export function followChanges(client: QueryClient, watch: Watch, { settle = SETTLE_MS, timers = globalThis as unknown as Timers } = {}) {
  // A gallery read in the last `settle` ms: its window, and whether a word came in it.
  const windows = new Map<string, { handle: unknown; again: boolean }>();
  let stopped = false;
  const read = (gid: string) => {
    readAgain(client, gid).catch(() => {});
    windows.set(gid, { handle: timers.setTimeout(() => close(gid), settle), again: false });
  };
  const close = (gid: string) => {
    const window = windows.get(gid);
    windows.delete(gid);
    if (window?.again && !stopped) read(gid);
  };
  const off = watch((gid) => {
    if (stopped) return;   // a catch-up begun before the stop
    const window = windows.get(gid);
    if (window) window.again = true;
    else read(gid);
  });
  return () => {
    stopped = true;
    off();
    for (const { handle } of windows.values()) timers.clearTimeout(handle);
    windows.clear();
  };
}

// ── The page's own edits ──
// Each edit, by gallery: what it sets, and from which read on the library holds it (0 while its write
// is under way). A read is numbered as it starts (readMark).
const edits = new Map<string, { patch: Record<string, unknown>; from: number }>();
let reads = 0;
export const readMark = () => ++reads;

// The gallery `g` as a read started at `mark` gives it, with an edit the library did not hold then
// laid over it. A read started after the library has the edit ends it.
export function withEdits<T>(gid: string, g: T, mark: number): T {
  const edit = edits.get(gid);
  if (!edit || !g) return g;
  if (edit.from && mark >= edit.from) { edits.delete(gid); return g; }
  return { ...g, ...edit.patch };
}

// A gallery's read (`raw`), with the page's edits the library does not hold yet laid over it.
export async function readGallery<T>(gid: string, raw: () => Promise<T>): Promise<T> {
  const mark = readMark();
  return withEdits(gid, await raw(), mark);
}

// Edits the gallery `gid` as the page asks: `patch` is on its entry at once (in the frame of the
// press), and `write` asks the library for it. A write that throws or answers false is refused: the
// entry is read again as the library has it. Answers whether it was done.
export async function editGallery(client: QueryClient, gid: string, patch: Record<string, unknown>, write: () => Promise<unknown>) {
  const key = galleryKey(gid);
  const edit = { patch, from: 0 };
  edits.set(gid, edit);
  const before = client.getQueryData<Record<string, unknown>>(key);
  if (before) client.setQueryData(key, { ...before, ...patch });
  let done = false;
  try { done = (await write()) !== false; } finally {
    if (edits.get(gid) === edit) { if (done) edit.from = reads + 1; else edits.delete(gid); }
    readAgain(client, gid).catch(() => {});
  }
  return done;
}

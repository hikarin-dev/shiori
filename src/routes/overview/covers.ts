// covers.ts — the overview's covers, as 1.3's page asked for them (app/js/overview.js: coverKey,
// coverUrl, invalidateCover), kept outside React: the hero's (the series' cover for a series, the
// gallery's own otherwise, 480 wide) and each row's (160 wide). Asked through the library's cover
// service (GET_COVER, requester 'overview', a request id each), its answer (COVER_READY for that id,
// from whichever context made it) kept by role, gallery and width; no answer in 10 s is none (asked
// again the next time it is wanted). Asked again (again()) when its gallery changed, the cover kept
// showing until the new answer: a view reading it (subscribe, get) sees a change only when a
// different picture came. Nothing is written anywhere: the service decides what it keeps.
//
// `kept` (a map the page hands in and holds for the session): the covers of the overviews shown
// before, so an overview drawn again (Back from the reader, from any page) has its covers in its first
// frame, as a document the browser kept had them. Each is shown at once and asked for once more (its
// gallery may have changed since), a different answer taking its place. The last KEPT stay; none this
// page has asked for is let go while it shows.
//
// Its world is handed in (the page passes the app's): Node tests it as it is.
type Control = { type?: string; requester?: string; requestId?: string; coverDataUrl?: string };
type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };

export type OverviewCoverDeps = {
  rpc: (msg: Record<string, unknown>) => unknown;
  onControl: (cb: (msg: Control) => void) => () => void;
  timers?: Timers;
  kept?: Map<string, string>;
};

export const WAIT_MS = 10000;
export const HERO_WIDTH = 480;
export const ROW_WIDTH = 160;
export const KEPT = 400;   // covers kept for the session: a few long series' rows (some 6 KB each) and their heroes

export function coverKey(gid: unknown, preferSeries = false, width = 0) {
  return `${preferSeries ? 'series' : 'gallery'}:${String(gid)}:${width}`;
}

export function createOverviewCovers(deps: OverviewCoverDeps) {
  const timers = deps.timers ?? (globalThis as unknown as Timers);
  const cache = deps.kept ?? new Map<string, string>();
  const mine = new Set<string>();   // the keys this page has asked for
  const asking = new Map<string, { key: string; timer: unknown }>();   // request id → its key
  const listeners = new Set<() => void>();
  let seq = 0;
  let off: (() => void) | null = null;

  const publish = () => { for (const l of [...listeners]) l(); };

  function heard(msg: Control) {
    if (msg?.type !== 'COVER_READY' || msg.requester !== 'overview' || !msg.requestId) return;
    const ask = asking.get(msg.requestId);
    if (!ask) return;
    asking.delete(msg.requestId);
    timers.clearTimeout(ask.timer);
    const url = msg.coverDataUrl || '';
    if (!url || cache.get(ask.key) === url) return;
    cache.delete(ask.key);   // the newest last
    cache.set(ask.key, url);
    for (const oldest of [...cache.keys()]) {
      if (cache.size <= KEPT) break;
      if (!mine.has(oldest)) cache.delete(oldest);
    }
    publish();
  }

  function request(gid: string, preferSeries: boolean, width: number) {
    const key = coverKey(gid, preferSeries, width);
    mine.add(key);
    const requestId = `ov-${++seq}`;
    asking.set(requestId, { key, timer: timers.setTimeout(() => asking.delete(requestId), WAIT_MS) });
    deps.rpc({ type: 'GET_COVER', galleryId: String(gid), thumbWidth: width, preferSeries, requester: 'overview', requestId });
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get: (key: string) => cache.get(key) ?? null,

    // The cover of `gid` in its role at `width`: asked for unless this page has it, or one is on its
    // way (one kept from an overview shown before is asked for once more).
    want(gid: string, { preferSeries = false, width = ROW_WIDTH } = {}) {
      const key = coverKey(gid, preferSeries, width);
      if ((cache.has(key) && mine.has(key)) || [...asking.values()].some((a) => a.key === key)) return;
      request(gid, preferSeries, width);
    },
    // Asked again (its gallery changed); what is kept shows until the answer differs.
    again(gid: string, { preferSeries = false, width = ROW_WIDTH } = {}) {
      request(gid, preferSeries, width);
    },

    start() {
      if (!off) off = deps.onControl(heard);
    },
    stop() {
      off?.();
      off = null;
      for (const ask of asking.values()) timers.clearTimeout(ask.timer);
      asking.clear();
    },
  };
}

export type OverviewCovers = ReturnType<typeof createOverviewCovers>;

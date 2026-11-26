// covers.ts — the library's covers, as 1.3's page kept them (app/js/library.js: _coverCache,
// coverCacheKey, coverRequestMatchesEntry, _getCoverThumbWidth, the resize listener, the session's
// cache, fetchPageCovers and the cover pushes), stated once, outside React: a card reads its cover
// here (useSyncExternalStore), and a cover arriving changes that card's alone.
//
//   - A cover is kept by gallery and role (coverCacheKey: `<id>:series` for a series shown merged,
//     `<id>:gallery` otherwise) as the data URL the library's cover service made at the width tier
//     asked for (256, 384, 512, 768, 1024: the smallest at least a fifth of the window's width in
//     device pixels).
//   - show(galleries, merge): the galleries the page shows now; each whose cover isn't kept is asked
//     for (GET_COVER, `page: 'library'`), as fetchPageCovers did after each read of the page. A
//     gallery that changed in place is asked for again the same way (ask).
//   - What answers: COVER_READY for this page's requests, in this tab or from another context
//     (platform.onControl), kept when it is for the role the gallery is shown in; COVER_INVALIDATED
//     drops a gallery's covers and asks again if it is shown. A gallery with no pages whose cover came
//     (one the helper fills) is said to have changed (onEmptyCover): its record is read again.
//   - The window grown past the tier the covers were made at (400 ms after a resize): the next tier,
//     every cover dropped, the page's asked for again. Shrinking keeps the sharper covers.
//   - The session's cache: sessionStorage `shiori-covers`, { key: dataUrl } of the page's galleries,
//     written 800 ms after a change, read when the page starts (1.3's form, so 1.3's page, this one and
//     the overview's way back share it; an entry from before roles counts as a gallery's own cover).
//     Nothing else is written: the cover service decides what it keeps, as it did for 1.3's page.
//
// Its world is handed in (the page passes the app's): Node tests it as it is.

export type CoverGallery = { id: string; source?: string; isSeries?: boolean; count?: number; aggPages?: number; [field: string]: unknown };
type Control = { type?: string; galleryId?: unknown; page?: string; preferSeries?: boolean; coverDataUrl?: string };
type KeyStore = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };

export type CoverDeps = {
  rpc: (msg: Record<string, unknown>) => unknown;
  onControl: (cb: (msg: Control) => void) => () => void;
  canDownload: (g: CoverGallery) => boolean;
  // The window's width and its pixel ratio, and what follows a resize.
  viewport: () => { innerWidth: number; devicePixelRatio?: number };
  onResize: (cb: () => void) => () => void;
  session: KeyStore | null;
  // A picture's decoding started ahead (1.3 primed the image cache with each restored cover).
  prime?: (dataUrl: string) => void;
  // A gallery with no pages whose cover came.
  onEmptyCover?: (gid: string) => void;
  timers?: Timers;
};

export const SESSION_KEY = 'shiori-covers';
export const TIERS = [256, 384, 512, 768, 1024] as const;
const RESIZE_MS = 400;
const SAVE_MS = 800;

export function coverCacheKey(galleryId: unknown, preferSeries: boolean) {
  return `${String(galleryId)}:${preferSeries ? 'series' : 'gallery'}`;
}
const keyGalleryId = (key: string) => String(key).replace(/:(?:series|gallery)$/, '');
const coverRequestMatchesEntry = (msg: Control, entry: CoverGallery | undefined, merge: boolean) => !!msg.preferSeries === !!(merge && entry?.isSeries);
// The width tier a card's cover is asked at.
export function coverTier({ innerWidth, devicePixelRatio }: { innerWidth: number; devicePixelRatio?: number }) {
  const raw = Math.ceil((innerWidth / 5) * (devicePixelRatio || 1));
  return TIERS.find((w) => w >= raw) ?? TIERS[TIERS.length - 1];
}
// The key a card shows: its series' cover while series are merged, its own otherwise.
export const coverKeyOf = (g: CoverGallery, merge: boolean) => coverCacheKey(g.id, !!(merge && g.isSeries));

export function createCoverStore(deps: CoverDeps) {
  const timers = deps.timers ?? (globalThis as unknown as Timers);
  const cache = new Map<string, string>();
  let shown: CoverGallery[] = [];
  let merge = true;
  let width: number = TIERS[0];
  const listeners = new Set<() => void>();
  let offs: (() => void)[] = [];
  let resizeTimer: unknown = null, saveTimer: unknown = null;

  const publish = () => { for (const listener of [...listeners]) listener(); };
  const entry = (gid: string) => shown.find((g) => String(g.id) === gid);

  function ask(g: CoverGallery) {
    deps.rpc({ type: 'GET_COVER', galleryId: g.id, source: g.source, thumbWidth: width, page: 'library', preferSeries: !!(merge && g.isSeries) });
  }
  // Each gallery of `list` whose cover isn't kept, asked for: one with pages, a series whose chapters
  // have some, or an empty one the helper can fill (its cover comes from its source).
  function request(list: CoverGallery[]) {
    for (const g of list) {
      const asSeries = !!(merge && g.isSeries);
      if (cache.has(coverCacheKey(g.id, asSeries))) continue;
      if ((g.count ?? 0) > 0 || (asSeries && (g.aggPages || 0) > 0) || (g.count === 0 && deps.canDownload(g))) ask(g);
    }
  }

  function scheduleSave() {
    timers.clearTimeout(saveTimer);
    saveTimer = timers.setTimeout(() => {
      try {
        const ids = new Set(shown.map((g) => String(g.id)));
        deps.session?.setItem(SESSION_KEY, JSON.stringify(Object.fromEntries([...cache].filter(([key]) => ids.has(keyGalleryId(key))))));
      } catch {}
    }, SAVE_MS);
  }

  function heard(msg: Control) {
    if (msg?.type === 'COVER_INVALIDATED') {
      const gid = String(msg.galleryId);
      cache.delete(coverCacheKey(gid, false));
      cache.delete(coverCacheKey(gid, true));
      scheduleSave();
      publish();
      const g = entry(gid);
      if (g) ask(g);
      return;
    }
    if (msg?.type !== 'COVER_READY' || msg.page !== 'library') return;
    const gid = String(msg.galleryId);
    const g = entry(gid);
    if (!g) return;
    // A chapter's own cover asked for before the gallery became a series may come late; it must not
    // take the place of the series' (or the other way round).
    if (!coverRequestMatchesEntry(msg, g, merge)) return;
    if (msg.coverDataUrl) {
      const preferSeries = !!msg.preferSeries;
      cache.set(coverCacheKey(gid, preferSeries), msg.coverDataUrl);
      cache.delete(coverCacheKey(gid, !preferSeries));
      scheduleSave();
      publish();
    }
    if (g.count === 0) deps.onEmptyCover?.(gid);
  }

  function resized() {
    timers.clearTimeout(resizeTimer);
    resizeTimer = timers.setTimeout(() => {
      const next = coverTier(deps.viewport());
      if (next <= width) return;
      width = next;
      cache.clear();
      try { deps.session?.removeItem(SESSION_KEY); } catch {}
      publish();
      request(shown);
    }, RESIZE_MS);
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get: (key: string) => cache.get(key) ?? null,
    get width() { return width; },

    // The page starts: the tier for the window as it is, the session's covers, the pushes and resizes
    // followed. stop() undoes it (and its timers); start() may run again.
    start() {
      if (offs.length) return;
      width = coverTier(deps.viewport());
      try {
        const raw = deps.session?.getItem(SESSION_KEY);
        if (raw) {
          for (const [stored, dataUrl] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
            // An entry from before roles is a gallery's own cover: shown while its role is asked for
            // again, never taken for a series' cover.
            const key = /:(?:series|gallery)$/.test(stored) ? stored : coverCacheKey(stored, false);
            cache.set(key, dataUrl);
            deps.prime?.(dataUrl);
          }
        }
      } catch {}
      offs = [deps.onControl(heard), deps.onResize(resized)];
      publish();
    },
    stop() {
      for (const off of offs) off();
      offs = [];
      timers.clearTimeout(resizeTimer);
      timers.clearTimeout(saveTimer);
    },

    // The galleries the page shows now, and how a series shows; those without a cover asked for.
    show(galleries: CoverGallery[], merged: boolean) {
      shown = galleries;
      merge = merged;
      request(galleries);
    },
    // Galleries of the page that changed in place: the page's list follows, and each without a cover
    // is asked for (one that just got its first page gets its cover).
    changed(galleries: CoverGallery[], changed: CoverGallery[]) {
      shown = galleries;
      request(changed);
    },
  };
}

export type CoverStore = ReturnType<typeof createCoverStore>;

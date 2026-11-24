// source-icons.ts — the sources' icons a library card shows on its open button, as 1.3's page kept
// them (app/js/library.js "Source sites": _sourceIconCache, hydrateSourceIcons, _loadSourceIcon,
// _requestSourceIcon, _warmSourceIconCache), outside React: a card reads an icon here
// (useSyncExternalStore), and an icon arriving changes the cards of that source alone.
//
//   - hydrate(): every icon the library keeps (api.icons.all), read when the page starts; the page's
//     first read waits for it, as 1.3's did.
//   - want(source): a source shown with no icon kept: the library's record read (api.icons.get), and
//     whatever runs beside the app asked for one (EXT_FETCH_ICON, with the address of the icon it last
//     gave, if any), each question asked once at a time. The page asks as 1.3's did: whenever a card of
//     that source is drawn without one.
//   - warm(): every source the site map names asked for (the helper answering, again or for the first
//     time).
//   - An icon given is kept in the library (api.icons.put) and shown.
// The app states the fact ("I have no icon for this source") and takes what comes back; it never
// makes an icon's address, picks where one comes from, or retries.
//
// Its world is handed in (the page passes the app's): Node tests it as it is.

type IconRecord = { source?: string; url?: string | null; dataUrl?: string; cachedAt?: number };
export type IconDeps = {
  all: () => Promise<IconRecord[]>;
  get: (source: string) => Promise<IconRecord | null | undefined>;
  put: (source: string, rec: IconRecord) => Promise<unknown>;
  request: (msg: Record<string, unknown>, timeout: number) => Promise<{ ok?: boolean; url?: string; dataUrl?: string } | null | undefined>;
  sources: () => string[];
  now?: () => number;
};

const isImage = (rec: { dataUrl?: string } | null | undefined) => /^data:image\//i.test(rec?.dataUrl || '');

export function createIconStore(deps: IconDeps) {
  const cache = new Map<string, IconRecord>();
  const loading = new Set<string>();
  const pending = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;
  const publish = () => { version++; for (const listener of [...listeners]) listener(); };

  function load(key: string) {
    if (cache.has(key) || loading.has(key)) return;
    loading.add(key);
    deps.get(key)
      .then((rec) => {
        if (!rec || !isImage(rec)) return;
        cache.set(key, rec);
        publish();
      })
      .catch(() => {})
      .finally(() => { loading.delete(key); });
  }

  function request(key: string) {
    if (!key || pending.has(key)) return;
    pending.add(key);
    const known = cache.get(key);
    deps.request({ type: 'EXT_FETCH_ICON', source: key, have: known?.url || null }, 15000)
      .then((r) => {
        if (!r || !r.ok || !isImage(r)) return;
        const rec = { source: key, url: r.url || null, dataUrl: r.dataUrl, cachedAt: (deps.now ?? Date.now)() };
        cache.set(key, rec);
        deps.put(key, rec).catch(() => {});
        publish();
      })
      .catch(() => {})
      .finally(() => { pending.delete(key); });
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // Changes each time an icon arrives (for a view that reads several).
    get version() { return version; },
    // A source's icon as a data URL, or '' while none is kept.
    get(source: string | undefined) {
      const rec = cache.get(String(source || ''));
      return rec && isImage(rec) ? rec.dataUrl! : '';
    },
    async hydrate() {
      try {
        for (const rec of await deps.all()) if (rec?.source && isImage(rec)) cache.set(String(rec.source), rec);
      } catch {}
      publish();
    },
    want(source: string | undefined) {
      const key = String(source || '');
      if (!key || this.get(key)) return;
      load(key);
      request(key);
    },
    warm() {
      for (const source of deps.sources()) request(source);
    },
  };
}

export type IconStore = ReturnType<typeof createIconStore>;

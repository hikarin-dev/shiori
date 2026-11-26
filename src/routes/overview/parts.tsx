// The overview's small parts: a cover shown only once it is decoded (1.3's setThumb), a page grid whose
// tiles the thumbnail engine makes itself (1.3's syncPageGrid), and the engine held for the page.
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPageThumbs, type PageThumbDeps, type PageThumbs } from '@/lib/page-thumbs';
import { ROW_WIDTH, coverKey, type OverviewCovers } from './covers';

// A cover kept showing until another one is ready: the picture is decoded before it takes the box, so
// the box never shows empty in between, and the cover it shows stays until a different one has come.
// `landscape` follows the picture's own size (a landscape cover is contained, not cut off).
export function useDecoded(url: string | null) {
  const [shown, setShown] = useState<{ src: string; landscape: boolean } | null>(null);
  const want = useRef<string | null>(null);
  useEffect(() => {
    if (!url || want.current === url) return;
    want.current = url;
    const img = new Image();
    img.src = url;
    img.decode().then(() => {
      if (want.current !== url) return;   // a newer cover took the box meanwhile
      setShown({ src: url, landscape: img.naturalWidth >= img.naturalHeight });
    }, () => {});
  }, [url]);
  return shown;
}

// A gallery's cover from the page's covers (asked for once; asked again when `version`, its gallery's
// record, changes after the first).
export function useCover(covers: OverviewCovers, gid: string | null, opts: { preferSeries?: boolean; width?: number }, version: unknown) {
  const key = gid ? coverKey(gid, !!opts.preferSeries, opts.width ?? ROW_WIDTH) : '';
  const url = useSyncExternalStore(covers.subscribe, () => (key ? covers.get(key) : null));
  useEffect(() => { if (gid) covers.want(gid, opts); }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  const seen = useRef<unknown>(undefined);
  useEffect(() => {
    if (!gid) return;
    if (seen.current !== undefined && seen.current !== version) covers.again(gid, opts);
    seen.current = version;
  }, [gid, version]);   // eslint-disable-line react-hooks/exhaustive-deps
  return url;
}

// The thumbnail engine for the page: made at its first use and stopped when the page is left (each
// time the page shows, a new one).
export function createGridEngine(deps: Omit<PageThumbDeps, 'window'>) {
  let engine: PageThumbs | null = null;
  return {
    get: () => (engine ??= createPageThumbs(deps)),
    current: () => engine,
    stop() { engine?.stop(); engine = null; },
  };
}
export type GridEngine = ReturnType<typeof createGridEngine>;

// A grid's size as it last stood with its tiles in, by gallery. Its tiles are listed from storage, a
// moment after the grid is drawn; a grid drawn again at the width it had takes the height it had until
// they are back, so the page is as tall as it was left in its first frame: coming Back to it, the
// browser returns to the scroll it had (it does so once, as the page is drawn, and a shorter page
// stopped it short, the tiles then pushing what was in view away).
const stood = new Map<string, { width: number; height: number }>();
const grids = new WeakMap<Element, string>();
const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
  for (const { target, borderBoxSize } of entries) {
    const gid = grids.get(target);
    const [box] = borderBoxSize;
    if (gid && box && box.blockSize > 0 && target.firstElementChild) stood.set(gid, { width: box.inlineSize, height: box.blockSize });
  }
});

// A page grid: an element React draws once and leaves alone, its tiles the engine's. Brought up to date
// whenever `version` changes while `open` (the gallery's record: pages came or went), and let go of
// when it leaves.
export const PageGrid = memo(function PageGrid({ engine, gid, open = true, version, className, id }: {
  engine: GridEngine; gid: string; open?: boolean; version: unknown; className: string; id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    // Its tiles in (or its "no pages"), the height is its own again.
    const own = () => { if (el.firstElementChild) el.style.minHeight = ''; };
    engine.get().syncPageGrid(el, gid).then(own, () => { el.style.minHeight = ''; });
  }, [engine, gid, open, version]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !open) return undefined;
    const was = stood.get(gid);
    if (was && !el.firstElementChild && Math.abs(el.getBoundingClientRect().width - was.width) < 0.5) el.style.minHeight = `${was.height}px`;
    grids.set(el, gid);
    sizes?.observe(el);
    return () => { sizes?.unobserve(el); };
  }, [gid, open]);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => { if (el) engine.current()?.releasePageTiles(el); };
  }, [engine]);
  return <div ref={ref} className={className} id={id} />;
});

// A face of a button and, where it has one, its face for Shift (the faces turn in CSS while Shift is
// held on the button: overview.css).
export function Faces({ rest, shift }: { rest: ReactNode; shift?: ReactNode }) {
  return (
    <span className="ch-face" data-shift={shift ? '' : undefined}>
      <span className="face-rest">{rest}</span>
      {shift && <span className="face-shift">{shift}</span>}
    </span>
  );
}

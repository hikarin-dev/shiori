// frame.tsx — the root layout route: what every page the one page draws stands on.
import { useLayoutEffect, useMemo, useState } from 'react';
import { Outlet, useMatches } from 'react-router';
import type { Route } from './routes';
import { HeaderNodesContext, type HeaderNodes } from './components/header-slot';
import { NoticeHost } from './components/notice-host';
import { AppHeader } from './components/ui/app-header';

// <meta name="shiori-app" content="<page>"> while one of the app's own pages shows, by which an
// independent observer recognises the app's pages; one element, its content changed with the page,
// and none on any other route. start.js writes it for the page the document opens on, before the app
// runs (what recognises the app by it may look once, as a page loads); that element is the one kept.
let appMeta: HTMLMetaElement | null = null;
function useAppMeta(page: string | null) {
  useLayoutEffect(() => {
    appMeta ??= document.querySelector<HTMLMetaElement>('meta[name="shiori-app"]');
    if (!page) { appMeta?.remove(); return; }
    if (!appMeta) {
      appMeta = document.createElement('meta');
      appMeta.name = 'shiori-app';
    }
    appMeta.content = page;
    if (!appMeta.isConnected) document.head.append(appMeta);
  }, [page]);
}

// html[data-frame]: which frame the page shows, and html[data-header-form]: the header's form for the
// route (start.js sets both for the first one, before any paint; the header's look reads the form
// there, so the header painted before React and React's are the same markup).
function useFrame(frame: 'header' | null, form: string | null) {
  useLayoutEffect(() => {
    const { dataset } = document.documentElement;
    if (frame) dataset.frame = frame;
    else delete dataset.frame;
    if (frame && form) dataset.headerForm = form;
    else delete dataset.headerForm;
  }, [frame, form]);
}

// The header's two parts a route fills (HeaderSlot), as the header draws them.
function useHeaderNodes() {
  const [nodes, setNodes] = useState<HeaderNodes>({ left: null, right: null });
  const slots = useMemo(() => ({
    left: (left: HTMLDivElement | null) => setNodes((n) => (n.left === left ? n : { ...n, left })),
    right: (right: HTMLDivElement | null) => setNodes((n) => (n.right === right ? n : { ...n, right })),
  }), []);
  return { nodes, slots };
}

export default function Frame() {
  const route = useMatches().at(-1)?.handle as Route | undefined;
  useAppMeta(route?.app ? route.page : null);
  useFrame(route?.header ? 'header' : null, route?.form ?? null);
  const { nodes, slots } = useHeaderNodes();
  return (
    <>
      {/* The common header: index.html's frame, the same markup (a test holds the two equal), drawn in
          its place on the same pixels, and kept while the routes change; a route fills its parts
          (HeaderSlot), which leave with it. */}
      {route?.header && <AppHeader slots={slots} />}
      <HeaderNodesContext.Provider value={nodes}>
        <Outlet />
      </HeaderNodesContext.Provider>
      <NoticeHost />
    </>
  );
}

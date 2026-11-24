// frame.tsx — the root layout route: what every page the one page draws stands on.
import { useLayoutEffect } from 'react';
import { Outlet, useMatches } from 'react-router';
import type { Route } from './routes';
import { NoticeHost } from './components/notice-host';
import { AppHeader } from './components/ui/app-header';

// <meta name="shiori-app" content="<page>"> while one of the app's own pages shows, by which an
// independent observer recognises the app's pages; one element, its content changed with the page,
// and none on any other route.
let appMeta: HTMLMetaElement | null = null;
function useAppMeta(page: string | null) {
  useLayoutEffect(() => {
    if (!page) { appMeta?.remove(); return; }
    if (!appMeta) {
      appMeta = document.createElement('meta');
      appMeta.name = 'shiori-app';
    }
    appMeta.content = page;
    if (!appMeta.isConnected) document.head.append(appMeta);
  }, [page]);
}

// html[data-frame]: which frame the page shows (start.js sets it for the first one, before any paint).
function useFrame(frame: 'header' | null) {
  useLayoutEffect(() => {
    if (frame) document.documentElement.dataset.frame = frame;
    else delete document.documentElement.dataset.frame;
  }, [frame]);
}

export default function Frame() {
  const route = useMatches().at(-1)?.handle as Route | undefined;
  useAppMeta(route?.app ? route.page : null);
  useFrame(route?.header ? 'header' : null);
  return (
    <>
      {/* The common header, with no slots: index.html's frame, the same markup (a test holds the two
          equal), drawn in its place on the same pixels. A page's own controls come with its port. */}
      {route?.header && <AppHeader />}
      <Outlet />
      <NoticeHost />
    </>
  );
}

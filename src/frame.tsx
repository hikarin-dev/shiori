// frame.tsx — the root layout route: what every page the one page draws stands on.
import { useLayoutEffect } from 'react';
import { Outlet, useMatches } from 'react-router';
import type { Route } from './routes';

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

export default function Frame() {
  const route = useMatches().at(-1)?.handle as Route | undefined;
  useAppMeta(route?.app ? route.page : null);
  return <Outlet />;
}

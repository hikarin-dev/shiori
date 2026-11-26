// app.tsx — the app itself: its routes, drawn into the one page.
import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { initTooltips } from '@lib/tooltip.js';
import { siteRoot } from './entry';
import Frame from './frame';
import { followLibrary, queryClient } from './lib/gallery';
import { keepLinksInApp } from './lib/links';
import { ROUTES } from './routes';
import NotFound from './routes/not-found';

// Each page's module (src/routes/<page>.tsx), a chunk of its own.
const modules = import.meta.glob<{ default: ComponentType }>(['./routes/*.tsx', '!./routes/not-found.tsx']);

// A route's served stylesheets (its `sheets`, from the site's root), linked in the head once, with its
// chunk asked for at the same time, and there before it draws (on a hard load start.js has asked for
// them already). They stay in the document once linked, as a route's own stylesheet does.
function linkSheets(sheets: readonly string[] = []) {
  return Promise.all(sheets.map((path) => {
    const href = new URL(siteRoot + path, location.href).href;
    let link = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].find((l) => l.href === href);
    if (link?.sheet) return undefined;
    if (!link) {
      link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
      document.head.append(link);
    }
    const asked = link;
    return new Promise<void>((loaded, failed) => {
      asked.addEventListener('load', () => loaded(), { once: true });
      asked.addEventListener('error', () => failed(new Error(`${path} did not load`)), { once: true });
    });
  }));
}

const router = createBrowserRouter([{
  element: <Frame />,
  children: [
    ...Object.entries(ROUTES).map(([segment, route]) => ({
      path: `/${segment}`,
      handle: route,
      lazy: async () => {
        const [module] = await Promise.all([modules[`./routes/${route.page}.tsx`](), linkSheets(route.sheets)]);
        return { Component: module.default };
      },
    })),
    { path: '*', element: <NotFound /> },
  ],
}], { basename: siteRoot.replace(/\/$/, '') || '/' });

export async function mount(root: HTMLElement) {
  // Drawn once the address's page is at hand, so the first thing React draws is that page.
  if (!router.state.initialized) {
    await new Promise<void>((ready) => {
      const stop = router.subscribe((state) => { if (state.initialized) { stop(); ready(); } });
    });
  }
  keepLinksInApp((to) => router.navigate(to));
  // The app's modules that work on any markup, started once for the page's life: the one tooltip
  // (T10); and the views' read cache following the library's change feed (T4, lib/gallery.ts). (The
  // page's scrollbars, scrollbar.js, start with the rest of the start-up: boot-core.js.)
  initTooltips();
  followLibrary();
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

// app.tsx — the app itself: its routes, drawn into the one page.
import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { initTooltips } from '@lib/tooltip.js';
import { siteRoot } from './entry';
import Frame from './frame';
import { keepLinksInApp } from './lib/links';
import { ROUTES } from './routes';
import NotFound from './routes/not-found';

// Each page's module (src/routes/<page>.tsx), a chunk of its own.
const modules = import.meta.glob<{ default: ComponentType }>(['./routes/*.tsx', '!./routes/not-found.tsx']);

const router = createBrowserRouter([{
  element: <Frame />,
  children: [
    ...Object.entries(ROUTES).map(([segment, route]) => ({
      path: `/${segment}`,
      handle: route,
      lazy: async () => ({ Component: (await modules[`./routes/${route.page}.tsx`]()).default }),
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
  // (T10). (The page's scrollbars, scrollbar.js, start with the rest of the start-up: boot-core.js.)
  initTooltips();
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

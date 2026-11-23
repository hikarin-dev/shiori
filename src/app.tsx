// app.tsx — the app itself: its routes, drawn into the one page.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import './index.css';
import { siteRoot } from './entry';
import Components from './routes/components';
import NotFound from './routes/not-found';

// Each route is an address of pages.js that index.html answers, by the same name.
const router = createBrowserRouter([
  { path: '/components', element: <Components /> },
  { path: '*', element: <NotFound /> },
], { basename: siteRoot.replace(/\/$/, '') || '/' });

export function mount(root: HTMLElement) {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

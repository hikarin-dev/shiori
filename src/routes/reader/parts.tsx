// reader/parts.tsx — what the reader's plain modules ask the one page to draw for it, beside its frame
// (never inside it): the page's right-click menu. Each part has a store its module hands its requests to
// (the notices' way: app/js/notice.js and src/lib/notice-store.ts), registered as that module's host by
// the route before it starts the reader and taken away after the reader has stopped, whose stop closes
// each part. A part's code is fetched the first time it is asked for: a reader nobody right-clicks
// never loads the menu.
import { lazy, Suspense, useSyncExternalStore } from 'react';
import * as menu from './page-menu-store';

const PageMenu = lazy(() => import('./page-menu'));

export function ReaderParts() {
  const menuAsked = useSyncExternalStore(menu.subscribe, menu.asked);
  return <Suspense fallback={null}>{menuAsked && <PageMenu />}</Suspense>;
}

// The hosts, registered for one start of the reader; what it returns takes them away.
export function hostReaderParts(): () => void {
  const off = [menu.hostPageMenu()];
  return () => { for (const f of off) f(); };
}

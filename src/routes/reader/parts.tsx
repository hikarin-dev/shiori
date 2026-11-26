// reader/parts.tsx — what the reader's plain modules ask the one page to draw for it, beside its frame
// (never inside it): the page's right-click menu, page properties and the feedback dialog. Each part has
// a store its module hands its requests to (the notices' way: app/js/notice.js and
// src/lib/notice-store.ts), registered as that module's host by the route before it starts the reader
// and taken away after the reader has stopped, whose stop closes each part. A part's code is fetched the
// first time it is asked for: a reader nobody right-clicks never loads the menu, nor one nobody reports
// a bubble from the feedback dialog.
import { lazy, Suspense, useSyncExternalStore } from 'react';
import * as menu from './page-menu-store';
import * as properties from './properties-store';
import * as feedback from './feedback-store';

const PageMenu = lazy(() => import('./page-menu'));
const PageProperties = lazy(() => import('./properties'));
const Feedback = lazy(() => import('./feedback'));

export function ReaderParts() {
  const menuAsked = useSyncExternalStore(menu.subscribe, menu.asked);
  const propertiesAsked = useSyncExternalStore(properties.subscribe, properties.asked);
  const feedbackAsked = useSyncExternalStore(feedback.subscribe, feedback.asked);
  return (
    <>
      <Suspense fallback={null}>{menuAsked && <PageMenu />}</Suspense>
      <Suspense fallback={null}>{propertiesAsked && <PageProperties />}</Suspense>
      <Suspense fallback={null}>{feedbackAsked && <Feedback />}</Suspense>
    </>
  );
}

// The hosts, registered for one start of the reader; what it returns takes them away.
export function hostReaderParts(): () => void {
  const off = [menu.hostPageMenu(), properties.hostProperties(), feedback.hostFeedback()];
  return () => { for (const f of off) f(); };
}

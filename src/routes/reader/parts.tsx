// reader/parts.tsx — what the reader's plain modules ask the one page to draw for it, beside its frame
// (never inside it): the page's right-click menu, page properties and the feedback dialog. Each part has
// a store its module hands its requests to (the notices' way: app/js/notice.js and
// src/lib/notice-store.ts), registered as that module's host by the route before it starts the reader
// and taken away after the reader has stopped, whose stop closes each part. A part's code is fetched the
// first time it is asked for: a reader nobody right-clicks never loads the menu, nor one nobody reports
// a bubble from the feedback dialog.
import { useEffect, useState, useSyncExternalStore, type ComponentType } from 'react';
import * as menu from './page-menu-store';
import * as properties from './properties-store';
import * as feedback from './feedback-store';

// A part's component, fetched once it is first asked for and drawn as soon as it has come. (Not
// React.lazy: a component that suspends is revealed no sooner than 300 ms after (React's throttling of
// Suspense), which made a first right-click's menu wait about a third of a second.)
function usePart(asked: boolean, load: () => Promise<{ default: ComponentType }>) {
  const [part, setPart] = useState<{ Part: ComponentType } | null>(null);
  useEffect(() => {
    if (!asked || part) return;
    let live = true;
    void load().then((m) => { if (live) setPart({ Part: m.default }); });
    return () => { live = false; };
  }, [asked, part, load]);
  return part?.Part ?? null;
}
const loadMenu = () => import('./page-menu');
const loadProperties = () => import('./properties');
const loadFeedback = () => import('./feedback');

export function ReaderParts() {
  const PageMenu = usePart(useSyncExternalStore(menu.subscribe, menu.asked), loadMenu);
  const PageProperties = usePart(useSyncExternalStore(properties.subscribe, properties.asked), loadProperties);
  const Feedback = usePart(useSyncExternalStore(feedback.subscribe, feedback.asked), loadFeedback);
  return (
    <>
      {PageMenu && <PageMenu />}
      {PageProperties && <PageProperties />}
      {Feedback && <Feedback />}
    </>
  );
}

// The hosts, registered for one start of the reader; what it returns takes them away.
export function hostReaderParts(): () => void {
  const off = [menu.hostPageMenu(), properties.hostProperties(), feedback.hostFeedback()];
  return () => { for (const f of off) f(); };
}

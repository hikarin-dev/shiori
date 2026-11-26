// reader.tsx — the reader as the one page draws it (at /reader?g=…, 1.3's page until 2026-11-26): its
// frame, and the engine (app/js/reader.js) started in it. The engine and the chrome are the reader's
// own, as on its page; what its modules ask the one page to draw (the page's right-click menu, page
// properties, the feedback dialog) is drawn beside the frame (./reader/parts.tsx), through hosts
// registered for each start.
//
// The frame is the markup 1.3's page had in its body (./reader/frame.ts), drawn by React once and never
// again: the engine owns everything inside it. Each start has a frame of its own: the route is keyed on
// the gallery (?g=), so another gallery is another frame and another engine, and a frame leaves the
// document with its stopped engine (a stopped engine's scope lives as long as its frame).
//
// Before the frame's first paint (a layout effect): the reader's mark on <html> (data-reader, which
// its stylesheet's document rules hold to), the names 1.3's page set from its head (./reader/names.ts),
// the page's title, the frame's words in the person's language, and the engine started. Its stylesheet
// (app/reader.css, the file 1.3's page linked) is in the document before the route draws: the route
// table names it, and it comes with the route's chunk (build/start.mjs, vite.config.ts). Leaving, or
// another gallery, stops the engine (it saves the place) and takes all of it away again.
import { memo, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { startReader } from '@lib/reader.js';
import { applyTranslations } from '@lib/i18n.js';
import { goTo } from '@/lib/links';
import { dismissSince, noticeMark } from '@/lib/notice-store';
import { FRAME } from './reader/frame';
import { ReaderParts, hostReaderParts } from './reader/parts';
import { setReaderNames, takeReaderNames } from './reader/names';

type Go = (path: string) => void;

const ReaderFrame = memo(function ReaderFrame({ go }: { go: Go }) {
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.dataset.reader = '';
    setReaderNames(html, localStorage);
    document.title = 'Shiori — Reader';
    applyTranslations(frame.current as unknown as Document);   // its words (1.3's page had boot.js fill them)
    const mark = noticeMark();
    const unhost = hostReaderParts();
    const reader = startReader({ go });
    return () => {
      reader.stop();   // (it closes what it asked the parts to show)
      unhost();
      dismissSince(mark);   // its questions go with it, as with its page
      takeReaderNames(html);
      delete html.dataset.reader;
    };
  }, [go]);
  return <div ref={frame} className="reader-frame" dangerouslySetInnerHTML={FRAME} />;
});

export default function Reader() {
  const navigate = useNavigate();
  const g = new URLSearchParams(useLocation().search).get('g') ?? '';
  const go = useRef<Go>((path) => { goTo(navigate, path); }).current;
  return (
    <>
      <ReaderFrame key={g} go={go} />
      <ReaderParts />
    </>
  );
}

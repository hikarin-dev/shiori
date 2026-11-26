// reader/frame.ts — the reader's frame as the one page draws it: the markup 1.3's reader page had in its
// <body> (app/reader.html until 2026-11-26), kept in ./frame.html beside the route with the ids, words and
// attributes the engine and the reader's tests drive, and read by the build as text. Its addresses are
// written for this page's base, the site's root (`./x`), where that page's were for its <base href="app/">
// (`../x`): the same addresses, at a domain's root and under a folder.
import markup from './frame.html?raw';

// As React's dangerouslySetInnerHTML takes it: one object, so the frame is drawn once and never again.
export const FRAME = Object.freeze({ __html: markup });

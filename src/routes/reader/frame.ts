// reader/frame.ts — the reader's frame as the one page draws it: the markup 1.3's reader page had in its
// <body> (app/reader.html until 2026-11-26), kept as it was in ./frame.html beside the route, with the ids,
// words and attributes the engine and the reader's tests drive, and read by the build as text. One thing
// differs from 1.3's page, its own: the addresses that page's <base href="app/"> resolved are written for
// this page's base, the site's root (`../x` there is `./x` here: the same address, at a domain's root and
// under a folder).
import markup from './frame.html?raw';

const body = markup.replace(/(\s(?:href|src))="\.\.\//g, '$1="./');

// As React's dangerouslySetInnerHTML takes it: one object, so the frame is drawn once and never again.
export const FRAME = Object.freeze({ __html: body });

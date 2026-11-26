// reader/frame.ts — the reader's frame as the one page draws it: the markup app/reader.html has in its
// <body>, taken from that file as the build reads it (one source for both pages, while the reader's own
// page exists), with the ids, words and attributes it has there. Two things differ, both the page's own:
// its module script is left out (the route starts the engine), and the addresses that page's
// <base href="app/"> resolves are written for this page's base, the site's root (`../x` there is `./x`
// here: the same address, at a domain's root and under a folder).
import page from '../../../app/reader.html?raw';

const open = page.indexOf('>', page.indexOf('<body')) + 1;
const close = page.lastIndexOf('</body>');
if (open <= 0 || close < open) throw new Error('app/reader.html has no body');
const body = page.slice(open, close)
  .replace(/\s*<script\b[^>]*>\s*<\/script>\s*$/, '\n')
  .replace(/(\s(?:href|src))="\.\.\//g, '$1="./');

// As React's dangerouslySetInnerHTML takes it: one object, so the frame is drawn once and never again.
export const FRAME = Object.freeze({ __html: body });

// AppHeader — the common header every page but the reader stands under: a band 54px high, sticky at
// the window's top, the brand at its left, then "/" and the page menu, the page's search (the
// library's), anything else the left holds (the library's pin), and the page's buttons at the right.
// Its look is the frame's (styles/frame.css), which index.html paints before any script has run: drawn
// with no slots it is that frame's markup to the letter, on the same pixels (first-paint.browser).
//
//   page       the page menu (PageMenu), after a "/"
//   search     the page's search box (SearchField), which stretches the left part to 670px at most
//   left       what else the left holds, after the search (the library's pin)
//   right      the page's buttons and figures, 8px apart
//   translucent  §5.3 F33 (the owner's call): Settings' header in 1.3 is the surface at 94% under a
//              10px blur; built opaque, as every other page's, and kept one prop away
//
// One header on every page: it has no form of a page's own, so the logo, the name, the "/" and the
// page menu stand on the same pixels whichever page shows (1.3's Settings page had a header of its
// own, on another line: moving between pages in one document, its parts shifted by a fraction of a
// pixel).
//
// The frame (src/frame.tsx) draws it once for every route that has it and keeps it while the routes
// change; a route fills it through HeaderSlot (src/components/header-slot.tsx), which puts the route's
// parts into the left and right parts this hands out (`slots`). The right part is there, empty and not
// shown (frame.css), until something fills it, so the band is the same markup filled or not.
//
// Its phone form (CSS, at 600px or less, inclusive as 1.3's): every page's comes 12px in at the sides;
// a header with a search wraps besides, 7px 12px round and 8 apart, the search on a row of its own
// under the brand, the page menu and the buttons; the brand's word and the "/" give way so the menu
// keeps its place. A header without one keeps its band. Sizes are 1.3's library's.
import type { ReactNode, Ref } from 'react';

type Props = {
  page?: ReactNode;
  search?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  translucent?: boolean;
  slots?: { left: Ref<HTMLDivElement>; right: Ref<HTMLDivElement> };
} & { [data: `data-${string}`]: string | undefined };

function AppHeader({ page, search, left, right, translucent, slots, ...data }: Props) {
  return (
    <header className="app-header" data-translucent={translucent ? '' : undefined} {...data}><div className="header-left" ref={slots?.left}><a className="brand-wrap" href="./"><div className="brand-icon"><img alt="" src="icons/shiori-logo.svg" /></div><span className="brand-text">Shiori</span></a>{page != null && <><span className="brand-sep">/</span>{page}</>}{search}{left}</div><div className="header-right" ref={slots?.right}>{right}</div></header>
  );
}

export { AppHeader };

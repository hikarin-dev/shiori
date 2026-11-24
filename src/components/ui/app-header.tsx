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
//   form       settings: Settings' own header, its two parts held apart (space-between) on Settings'
//              taller line (1.5; the brand's 1.2), the page menu giving way first when narrow, and
//              12px in at the sides at 520px or less
//   translucent  §5.3 F33 (the owner's call): Settings' header in 1.3 is the surface at 94% under a
//              10px blur; built opaque, as every other page's, and kept one prop away
//
// Its phone form (CSS, at 600px or less, inclusive as 1.3's): a header with a search wraps, 7px 12px
// round and 8 apart, the search on a row of its own under the brand, the page menu and the buttons;
// the brand's word and the "/" give way so the menu keeps its place. A header without one keeps its
// band. Sizes are 1.3's.
import type { ReactNode } from 'react';

type Props = {
  page?: ReactNode;
  search?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  form?: 'settings';
  translucent?: boolean;
} & { [data: `data-${string}`]: string | undefined };

function AppHeader({ page, search, left, right, form, translucent, ...data }: Props) {
  return (
    <header className="app-header" data-form={form} data-translucent={translucent ? '' : undefined} {...data}><div className="header-left"><a className="brand-wrap" href="./"><div className="brand-icon"><img alt="" src="icons/shiori-logo.svg" /></div><span className="brand-text">Shiori</span></a>{page != null && <><span className="brand-sep">/</span>{page}</>}{search}{left}</div>{right != null && <div className="header-right">{right}</div>}</header>
  );
}

export { AppHeader };

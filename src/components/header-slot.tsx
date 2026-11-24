// HeaderSlot — how a route fills the common header the frame draws (src/frame.tsx): its parts go into
// the header's left part, after the brand (the page menu after its "/", a search, a pin), or into its
// right part (the page's figures and buttons), and leave with the route. The header itself is the
// frame's and stays as the routes change: it is never drawn again for a route, the brand never moves,
// and index.html's painted frame is its markup with nothing in it.
//
// The parts are the route's own elements, drawn where the header is (a portal), so they take the
// route's state and are drawn again with it, nothing passing through the frame.
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type HeaderNodes = { left: HTMLElement | null; right: HTMLElement | null };

export const HeaderNodesContext = createContext<HeaderNodes>({ left: null, right: null });

export function HeaderSlot({ side, children }: { side: keyof HeaderNodes; children: ReactNode }) {
  const node = useContext(HeaderNodesContext)[side];
  return node ? createPortal(children, node) : null;
}

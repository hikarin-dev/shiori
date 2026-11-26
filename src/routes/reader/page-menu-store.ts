// reader/page-menu-store.ts — what the reader asks its page menu to show (app/js/reader-page-menu.js
// hands each request here once the route has registered this as its host, hostPageMenu): where it was
// asked for, its title and its items, as the engine made them (_openPageMenu). One at a time: a new
// request replaces the open one. The menu (./page-menu.tsx) draws it; pageMenuOpen() is the engine's
// view of it, so it is true from the request on, whether or not the menu has drawn yet.
import { setPageMenuHost } from '@lib/reader-page-menu.js';

export type PageMenuItem = { label: string; detail?: string; kbd?: string; disabled?: boolean; onPick: () => void };
export type PageMenuAsk = { id: number; x: number; y: number; title: string; items: PageMenuItem[] };

let seq = 0;
let ask: PageMenuAsk | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getAsk = () => ask;
// Whether a menu has been asked for since the page started: the menu's code is fetched on its first use.
export const asked = () => seq > 0;

export function closeMenu() {
  if (!ask) return;
  ask = null;
  changed();
}

// An item chosen: the menu goes, then what the item does runs (as 1.3's did).
export function pick(item: PageMenuItem) {
  closeMenu();
  item.onPick();
}

const host = {
  open({ x, y, title, items }: Omit<PageMenuAsk, 'id'>) { ask = { id: ++seq, x, y, title, items }; changed(); },
  isOpen: () => !!ask,
  close: closeMenu,
};

// Registered by the reader's route before it starts the reader; what it returns takes it away again.
export const hostPageMenu = (): (() => void) => setPageMenuHost(host);

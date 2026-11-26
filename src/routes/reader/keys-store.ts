// reader/keys-store.ts — the reader's keys list as the engine hands it (app/js/reader.js: startReader's
// `keys`): the host the route makes for each start (keysHost) and what the list (./keys.tsx) draws from
// it. The engine decides when it shows (its buttons, ?, Escape, one dialog at a time with reader
// settings) and where the focus goes when it goes; it shows it with its own way to close it (show),
// takes it away (hide), and asks what of the page is the list's (contains: a wheel or a touch over it is
// not the pages', and the focus in it goes back to the button that opened it).

// The engine's own ways, handed as it shows the list: close (a press beside the box, its X).
export type KeysActions = { close(): void };
export type KeysShown = { open: boolean; actions: KeysActions | null };

let shown: KeysShown = { open: false, actions: null };
let asked = false;
let box: ((el: Element) => boolean) | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getShown = () => shown;
// Whether the keys list has been shown since the page started: its code is fetched on first use.
export const wasAsked = () => asked;
// What the drawn list answers for itself, while it is drawn: whether an element is its.
export function registerBox(own: (el: Element) => boolean): () => void {
  box = own;
  return () => { if (box === own) box = null; };
}

export type KeysHost = {
  show(actions: KeysActions): void;
  hide(): void;
  contains(el: Element | null): boolean;
};

export function keysHost(): KeysHost {
  shown = { open: false, actions: null };
  return {
    show(actions) {
      asked = true;
      shown = { open: true, actions };
      changed();
    },
    hide() {
      if (!shown.open) return;
      // The engine's functions go with it: kept, they would keep a stopped reader's whole scope (its
      // frame, its pages) alive in this module until the next reader starts.
      shown = { ...shown, open: false, actions: null };
      changed();
    },
    contains: (el) => !!el && !!box?.(el),
  };
}

// reader/settings-store.ts — Reader settings as the engine hands them (app/js/reader.js: startReader's
// `settings`): the host the route makes for each start (settingsHost) and what the dialog
// (./settings.tsx) draws from it. Opened, the engine hands the values every control shows, as plain
// data, and its own functions that change them (show); it tells the values again whenever it may have
// changed one, shown or not (update: kept, drawn only while shown); and takes the dialog away (hide).
// It asks the dialog what its own parts are (contains: where the focus goes back to, whether a key
// is typed in it, a wheel over it), whether an Escape is the dialog's (escape: an open picker is put
// away first) and which keys the dialog keeps (ownsKey: its focused control's, an open picker's or
// list's). The tab last shown is the dialog's and lasts for one start of the reader.

// What each control shows (_settingsValues in app/js/reader.js).
export type Edge = 'top' | 'left' | 'right' | 'bottom';
export type Along = 'start' | 'center' | 'end';
export type SettingsValues = {
  mode: 'single' | 'double' | 'strip';
  fit: 'off' | 'width' | 'height';
  zoom: { scale: number; min: number; max: number };
  gap: number; dim: number; speed: number; speedLabel: string;
  navDirection: 'ltr' | 'rtl'; pageDirection: 'ltr' | 'rtl'; coverOffset: boolean; smoothScroll: boolean;
  overview: boolean; stripFlow: boolean; transitions: boolean; pauseOnUp: boolean;
  nav: 'top' | 'side'; navPlace: { edge: Edge; along: Along }; progress: Edge | 'off'; autoBar: 'top' | 'bottom';
  translateDisplay: 'image' | 'text';
  study: { original: 'image' | 'text'; display: 'hardcoded_images' | 'text'; srcFont: string; furigana: boolean };
  debugLoaded: boolean;
  off: { navPlace: boolean; studyText: boolean };
};
// The engine's own functions that change them (_settingsActions), and close and byKeys (whether the
// keyboard is in use: Tab pressed since the pointer's last press).
export type SettingsActions = {
  close(): void; byKeys(): boolean;
  mode(next: string): void; fit(next: string): void; zoom(dir: 1 | -1): void;
  gap(value: number): void; dim(value: number): void; speed(value: number): void;
  navDirection(next: string): void; pageDirection(next: string): void; coverOffset(on: boolean): void; smoothScroll(on: boolean): void;
  overview(on: boolean): void; stripFlow(on: boolean): void; transitions(on: boolean): void; pauseOnUp(on: boolean): void;
  nav(layout: string): void; navPlace(edge: string, along?: string): void; progress(edge: string): void; autoBar(edge: string): void;
  translateDisplay(next: string): void; study(key: 'original' | 'display' | 'srcFont' | 'furigana', value: string | boolean): void;
  debugLoaded(on: boolean): void;
};
// What the drawn dialog answers for itself.
export type SettingsParts = {
  contains(el: Element): boolean;
  escape(e: KeyboardEvent): boolean;
  ownsKey(e: KeyboardEvent): boolean;
};
export type Shown = { open: boolean; values: SettingsValues | null; actions: SettingsActions | null };

let shown: Shown = { open: false, values: null, actions: null };
let asked = false;
let tab = 'reading';
let parts: SettingsParts | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getShown = () => shown;
// Whether reader settings have been opened since the page started: their code is fetched on first use.
export const wasAsked = () => asked;
export const getTab = () => tab;
export const setTab = (next: string) => { tab = next; };
// The drawn dialog's answers, while it is drawn.
export function registerParts(own: SettingsParts): () => void {
  parts = own;
  return () => { if (parts === own) parts = null; };
}

export type SettingsHost = {
  show(values: SettingsValues, actions: SettingsActions): void;
  update(values: SettingsValues): void;
  hide(): void;
  contains(el: Element | null): boolean;
  escape(e: KeyboardEvent): boolean;
  ownsKey(e: KeyboardEvent): boolean;
};

// One host per start of the reader: it opens on Reading, the tab last shown kept for this start only.
export function settingsHost(): SettingsHost {
  tab = 'reading';
  shown = { open: false, values: null, actions: null };
  return {
    show(values, actions) {
      asked = true;
      shown = { open: true, values, actions };
      changed();
    },
    update(values) {
      if (!shown.open) { shown = { ...shown, values }; return; }   // kept, drawn when shown
      shown = { ...shown, values };
      changed();
    },
    hide() {
      if (!shown.open) return;
      // The engine's functions go with it: kept, they would keep a stopped reader's whole scope (its
      // frame, its pages) alive in this module until the next reader starts.
      shown = { ...shown, open: false, actions: null };
      changed();
    },
    contains: (el) => !!el && !!parts?.contains(el),
    escape: (e) => !!parts?.escape(e),
    ownsKey: (e) => !!parts?.ownsKey(e),
  };
}

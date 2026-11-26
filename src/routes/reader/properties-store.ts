// reader/properties-store.ts — what page properties shows (app/js/reader-properties.js hands each step
// here once the route has registered this as its host, hostProperties): which page it is about at once,
// then the page as described (describePage) with the picture to show, then where a new translation would
// start. One at a time: a new request replaces the open one. The dialog (./properties.tsx) draws it;
// propertiesOpen() is the engine's view of it, true from the request on.
import { setPropertiesHost } from '@lib/reader-properties.js';

// What describePage() says of a page (app/js/reader-properties.js), and inspectImage() of a picture.
export type Picture = { bytes: number; format: string | null; w: number | null; h: number | null } | null;
export type Described = {
  url: string; galleryId: string; mediaId: string | null; added: number | null;
  original: Picture; translated: Picture; layered: boolean;
  status: 'translated' | 'reverted' | 'none'; own: boolean; job: string | null;
  entry: { at?: number; config?: Record<string, unknown>; builds?: Record<string, string> } | null;
  steps: null | {
    recordBytes: number; fields: Record<string, number>; lines: number; read: number | null; regions: number | null;
    filtered: number; translations: number; bubbles: number | null; bubblesBytes: number; raw: Picture; mask: Picture;
    end: string | null; restart: string; bytes: number;
  };
  study: null | { balloons: number; bg: Picture; layers: number; layersBytes: number; layersFormat: string | null; metaBytes: number; bytes: number };
  text: { src: string; tr: string | null; filtered: boolean }[];
  storage: { original: number; translated: number; steps: number; study: number; total: number };
};
type Plan = { data?: unknown; from?: string; keep: string[] } | null;
export type Again = { unavailable?: string; gallery?: Plan; page?: Plan };
export type PropertiesPage = { number: number; total: number; chapter: string | null };
export type PropertiesAsk = {
  id: number;
  page: PropertiesPage;
  state: 'loading' | 'missing' | 'ready';
  info?: Described;
  thumb?: Blob | null;
  copy?: () => Promise<boolean>;
  again?: Again;   // undefined: still asking the server
};

let seq = 0;
let ask: PropertiesAsk | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getAsk = () => ask;
// Whether page properties has been asked for since the page started: its code is fetched on first use.
export const asked = () => seq > 0;

export function closeProperties() {
  if (!ask) return;
  ask = null;
  changed();
}

const host = {
  // The dialog shows at once, loading; the module fills it through what this returns, each step only
  // while this request is the one showing.
  open(page: PropertiesPage) {
    const own: PropertiesAsk = { id: ++seq, page: { number: page.number, total: page.total, chapter: page.chapter ?? null }, state: 'loading' };
    ask = own;
    changed();
    const set = (next: Partial<PropertiesAsk>) => { if (ask?.id !== own.id) return; ask = { ...ask, ...next }; changed(); };
    return {
      live: () => ask?.id === own.id,
      missing: () => set({ state: 'missing' }),
      ready: ({ info, thumb, copy }: { info: Described; thumb: Blob | null; copy: () => Promise<boolean> }) => set({ state: 'ready', info, thumb, copy }),
      again: (again: Again) => set({ again }),
    };
  },
  isOpen: () => !!ask,
  close: closeProperties,
};

// Registered by the reader's route before it starts the reader; what it returns takes it away again.
export const hostProperties = (): (() => void) => setPropertiesHost(host);

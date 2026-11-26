// reader/feedback-store.ts — which feedback draft shows (app/js/reader-feedback.js keeps every draft of
// the reader's session and hands the one asked for here once the route has registered this as its host,
// hostFeedback). A draft is the module's: what it holds (the frozen page, the bubbles, the ticks, the
// note, how a send went) and what it does; it says when it has changed, and the dialog
// (./feedback.tsx) draws it again. Closed, the draft stays with the module, so opened again on the same
// bubble it is as it was left. feedbackOpen() is the engine's view: true from the request on.
import { setFeedbackHost } from '@lib/reader-feedback.js';

// What the dialog reads of a draft, and what it asks of it.
export type FeedbackDraft = {
  key: string; index: number; surface: string;
  page: HTMLElement; pageWidth: number; aspect?: string;   // the page as it showed, frozen; its width in the picture's pixels; its shape
  regions: ({ x: number; y: number; w: number; h: number } | null)[];
  related: { index: number; text: string }[];
  issues: string[]; chosen: Set<string>; note: string; ticked: Set<number>;
  destination: boolean; fidelity: 'complete' | 'incomplete' | null; missing: string[]; status: string; busy: boolean;
  canSave(): boolean; canExport(): boolean;
  setIssue(value: string, on: boolean): void; setNote(text: string): void; setRelated(i: number, on: boolean): void;
  send(): Promise<void>; export(): Promise<void>;
};
type Draft = FeedbackDraft;

let seq = 0;
let shown: { draft: Draft; version: number } | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getShown = () => shown;
// Whether feedback has been asked for since the page started: its code is fetched on first use.
export const asked = () => seq > 0;

export function closeFeedbackDialog() {
  if (!shown) return;
  shown = null;
  changed();
}

const host = {
  show(draft: Draft) { seq++; shown = { draft, version: seq }; changed(); },
  // A draft changed (its capture came, a tick, a send's outcome): drawn again if it is the one showing.
  changed(draft: Draft) { if (shown?.draft === draft) { shown = { draft, version: ++seq }; changed(); } },
  isOpen: () => !!shown,
  close: closeFeedbackDialog,
};

// Registered by the reader's route before it starts the reader; what it returns takes it away again.
export const hostFeedback = (): (() => void) => setFeedbackHost(host);

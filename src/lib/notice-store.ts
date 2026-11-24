// notice-store.ts — what notice.js asks the new UI to draw (T11). notice.js keeps every function and
// promise it has; this registers as its host (setNoticeHost), so each call lands here as a request,
// and the NoticeHost component (src/components/notice-host.tsx, in the app's frame) draws the
// requests with the app's Dialog and Toast. Registered before the start-up modules run (main.tsx),
// so a notice raised before React has drawn anything waits here and shows once it has.
//
// Each request answers as notice.js's own drawing did: the same values for a choice, a cancel,
// Escape and a press outside; the same handles for a toast, a progress and an operation window.
// What is not drawing stays here too: an operation's lock on the page behind it.
import { setNoticeHost } from '@lib/notice.js';

export type Tone = 'danger' | 'error' | 'success' | 'info' | null | undefined;
export type Choice = { value: string; label: string; detail?: string };
export type Check = { name: string; label: string; checked?: boolean; for?: string };
export type DialogAsk = {
  title: string; body?: string; detail?: string | [string, string?]; cover?: string | Promise<string> | null;
  tone?: Tone; ok: string; cancel?: string;
  input?: { value: string; placeholder: string };
  form?: { choices: Choice[]; value: string; checks: Check[] };
  toggle?: { label: string; options?: { value: string; label: string }[]; value?: string; confirm?: (option: string | undefined) => unknown; bodyOn?: string };
};

type Base = { id: number; returnFocus: Element | null };
export type DialogRequest = Base & { kind: 'dialog'; ask: DialogAsk; resolve: (answer: unknown) => void };
export type AskRequest = Base & { kind: 'ask'; title: string; body?: string; choices: Choice[]; resolve: (value: string) => void };
export type ProgressRequest = Base & {
  kind: 'progress' | 'operation';
  title: string; body: string; stopLabel?: string; onStop?: () => void;
  done: number; total: number; lines: string[]; stopped: boolean; aside: boolean;
  popup: HTMLElement | null;      // the operation's box, once drawn (the lock reads it)
};
export type Request = DialogRequest | AskRequest | ProgressRequest;
export type ToastRequest = { id: number; text: string; action: string; closeLabel: string; busy: string | null; onAction: () => void; close: () => void };

let seq = 0;
let requests: Request[] = [];
let toast: ToastRequest | null = null;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; for (const l of listeners) l(); };

export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const getVersion = () => version;
export const getRequests = () => requests;
export const getToast = () => toast;
export const update = changed;

function add<T extends Request>(request: T): T { requests = [...requests, request]; changed(); return request; }

// What a dialog answers when it is dismissed (Cancel, Escape, a press on the backdrop), as notice.js's
// did: null for a prompt, a choice or a toggle; false for a confirmation; nothing for an alert.
export const dismissed = (ask: DialogAsk) => (ask.input || ask.form || ask.toggle ? null : (ask.cancel ? false : undefined));

// The number of the last request made: what a page asks after it is numbered above it.
export const noticeMark = () => seq;

// The questions asked since `mark` (notice.js's dialogs) dismissed: a page that is left takes what it
// asked away with it, as 1.3's page did by unloading (the toast and the progress windows stay: they
// are the app's).
export function dismissSince(mark: number) {
  for (const request of requests) {
    if (request.kind !== 'dialog' || request.id <= mark) continue;
    finish(request);
    request.resolve(dismissed(request.ask));
  }
}

// A request is done: it goes, and focus goes back to what had it when it came (as notice.js did).
export function finish(request: Request) {
  if (!requests.includes(request)) return;
  requests = requests.filter((r) => r !== request);
  changed();
  const back = request.returnFocus as HTMLElement | null;
  if (back?.isConnected) back.focus?.();
}

// Whether `target` is in a notice drawn over `request` (opened after it): that one handles its own
// keys and drops.
export function onTop(request: Request, target: EventTarget | null) {
  const box = (target as Element | null)?.closest?.('[data-slot="dialog"]');
  const own = request.kind !== 'dialog' && request.kind !== 'ask' ? request.popup : null;
  return !!box && box !== own && !!own && !!(own.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING);
}

// An operation: until it closes, everything already on the page is inert (no clicks, keys, focus,
// scrolling or dropped files reach it) and leaving the page asks first. A notice opened later sits on
// top of it and works as usual.
function lock(request: ProgressRequest) {
  const behind = [...document.body.children].filter((el) => !(el as HTMLElement).inert) as HTMLElement[];
  for (const el of behind) el.inert = true;
  const stopButton = () => request.popup?.querySelector<HTMLButtonElement>('[data-notice-stop]:not(:disabled)') ?? null;
  const focusBox = () => (stopButton() ?? request.popup)?.focus();
  const onKey = (e: KeyboardEvent) => {
    if (onTop(request, e.target)) return;
    const inBox = !!request.popup?.contains(e.target as Node);
    // Focus lost to the page (a notice on top closed): Tab brings it back into the box.
    if (e.key === 'Tab' && !inBox) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keydown') focusBox();
      return;
    }
    // In the box: moving between its buttons and pressing one, nothing else.
    if (inBox && (e.key === 'Tab' || ((e.key === 'Enter' || e.key === ' ') && (e.target as Element).localName === 'button'))) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onDrag = (e: DragEvent) => {
    if (onTop(request, e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  for (const type of ['dragenter', 'dragover', 'drop'] as const) window.addEventListener(type, onDrag, true);
  window.addEventListener('beforeunload', onLeave);
  return {
    focusBox,
    release() {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      for (const type of ['dragenter', 'dragover', 'drop'] as const) window.removeEventListener(type, onDrag, true);
      window.removeEventListener('beforeunload', onLeave);
      for (const el of behind) el.inert = false;
    },
  };
}

const host = {
  toast({ text, action, onAction, closeLabel }: { text: string; action: string; onAction: (handle: unknown) => void; closeLabel: string }) {
    toast?.close();
    const handle = {
      close() { if (toast === own) { toast = null; changed(); } },
      busy(label: string) { if (toast === own) { own.busy = label; changed(); } },
    };
    const own: ToastRequest = { id: ++seq, text, action, closeLabel, busy: null, onAction: () => onAction(handle), close: handle.close };
    toast = own;
    changed();
    return handle;
  },

  ask({ title, body, choices }: { title: string; body?: string; choices: Choice[] }) {
    return new Promise<string>((resolve) => {
      add<AskRequest>({ id: ++seq, kind: 'ask', returnFocus: document.activeElement, title, body, choices, resolve });
    });
  },

  dialog(ask: DialogAsk) {
    return new Promise((resolve) => {
      add<DialogRequest>({ id: ++seq, kind: 'dialog', returnFocus: document.activeElement, ask, resolve });
    });
  },

  progress({ title, body, stopLabel, onStop }: { title: string; body?: string; stopLabel?: string; onStop?: () => void }) {
    const request = add<ProgressRequest>({ id: ++seq, kind: 'progress', returnFocus: null, title, body: body ?? '', stopLabel, onStop, done: 0, total: 0, lines: [], stopped: false, aside: false, popup: null });
    return {
      update(done: number, total: number, text = '') { Object.assign(request, { done, total, lines: [text] }); changed(); },
      close() { finish(request); },
    };
  },

  operation({ title, body = '', stopLabel, onStop }: { title: string; body?: string; stopLabel?: string; onStop?: () => void }) {
    const returnFocus = document.activeElement;
    const request = add<ProgressRequest>({ id: ++seq, kind: 'operation', returnFocus: null, title, body, stopLabel, onStop, done: 0, total: 0, lines: [], stopped: false, aside: false, popup: null });
    const held = lock(request);
    let closed = false;
    return {
      update({ title: nextTitle, body: nextBody, done = 0, total = 0, lines = [] }: { title?: string; body?: string; done?: number; total?: number; lines?: string[] } = {}) {
        if (nextTitle != null) request.title = nextTitle;
        if (nextBody != null) request.body = nextBody;
        Object.assign(request, { done, total, lines });
        changed();
      },
      stopping(label?: string) { if (request.stopLabel) { request.stopped = true; if (label) request.stopLabel = label; changed(); } },
      hide() { request.aside = true; changed(); },
      show() { request.aside = false; changed(); requestAnimationFrame(held.focusBox); },
      close() {
        if (closed) return;
        closed = true;
        held.release();
        finish(request);
        if (returnFocus?.isConnected) (returnFocus as HTMLElement).focus?.();
      },
    };
  },
};

setNoticeHost(host);

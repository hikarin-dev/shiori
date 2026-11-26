// notice.js — the app-wide toast, a choice prompt, a progress modal and the app's own confirm /
// alert / prompt / choice dialogs, used instead of the browser's. The one page draws them: its notice
// host (src/lib/notice-store.ts, src/components/notice-host.tsx) registers here before the app's
// start-up runs, and each function below hands its request to it, which draws it and gives back the
// promise or handle described. (Until the reader's switch, 2026-11-26, a page with a file of its own had
// no host, and these drew themselves.)

import { t } from './i18n.js';

let _host = null;
export function setNoticeHost(host) {
  _host = host;
  return () => { if (_host === host) _host = null; };
}
const _drawer = () => {
  if (!_host) throw new Error('notice.js: no notice host has registered (setNoticeHost)');
  return _host;
};

// One toast at a time: a message, an action button and a close button. Returns { close, busy }.
export function showToast({ text, action, onAction, closeLabel = 'Close' }) {
  return _drawer().toast({ text, action, onAction, closeLabel });
}

// A question with a few answers ({ value, label, detail }); resolves with the chosen value.
export function ask({ title, body, choices }) {
  return _drawer().ask({ title, body, choices });
}

// A progress modal: update(done, total, detail) — total 0 shows an indeterminate bar. With
// `stopLabel`, a Stop button calls onStop once. close() removes it.
export function showProgress({ title, body, stopLabel, onStop }) {
  return _drawer().progress({ title, body, stopLabel, onStop });
}

// A progress modal for work nothing else may interrupt (a backup made or restored): until close(),
// the page behind it is inert — no clicks, keys, focus, scrolling or dropped files reach it — and
// leaving the page asks first. A dialog opened on top of it (a question, the outcome) works as
// usual. update({ title, body, done, total, lines }) — total 0 shows an indeterminate bar, `lines`
// up to two lines of detail under it; stopping(label) disables the Stop button with a new label;
// hide()/show() set the box aside while a dialog asks something (the page stays locked).
export function showOperation({ title, body = '', stopLabel, onStop }) {
  return _drawer().operation({ title, body, stopLabel, onStop });
}

// The app's own dialogs, used instead of the browser's. Each is laid out for what it asks:
//   title   the question or outcome, one line
//   body    what happens / what went wrong, in plain words
//   detail  what it applies to (a gallery, a tag) or an error's own message — a string, or
//           [main, secondary] for a two-line box
//   cover   when detail names a gallery: its cover — a url, or a promise of one ('' for none) —
//           shown at the box's left, like a chapter row
//   tone    'danger' (destructive confirm), 'error', 'success' or 'info' — an icon beside the title
// Esc or a click outside cancels, Tab stays inside, the page behind can't scroll.
function _dialog({ title, body, detail, cover, tone, input, form, toggle, ok, cancel }) {
  return _drawer().dialog({ title, body, detail, cover, tone, input, form, toggle, ok: ok || t('common.ok'), cancel });
}

// Resolves true when confirmed. `danger` paints OK red and starts focus on Cancel.
export const confirmDialog = ({ title, body, detail, cover, ok, cancel, danger = false }) =>
  _dialog({ title, body, detail, cover, tone: danger ? 'danger' : null, ok, cancel: cancel || t('common.cancel') });
// Resolves once dismissed.
export const alertDialog = ({ title, body, detail, cover, tone = 'info' }) =>
  _dialog({ title, body, detail, cover, tone });
// Resolves with the trimmed text, or null when cancelled.
export const promptDialog = ({ title, body, detail, cover, value = '', placeholder = '', ok, cancel }) =>
  _dialog({ title, body, detail, cover, input: { value: String(value ?? ''), placeholder }, ok, cancel: cancel || t('common.cancel') });
// One of `choices` ({ value, label, detail }), starting at `value`, and `checks` ({ name, label,
// checked, for? } — shown only while choice `for` is picked). Resolves { value, checks: { name:
// checked } }, or null when cancelled.
export const choiceDialog = ({ title, body, detail, cover, choices, value, checks = [], ok, cancel }) =>
  _dialog({ title, body, detail, cover, form: { choices, value: value ?? choices[0]?.value, checks }, ok, cancel: cancel || t('common.cancel') });
// A question with a switch: `toggle` { label, options ({ value, label }), value, confirm(option) —
// asked when it is turned on, false keeps it off — and bodyOn: what the question says while it is
// on }. Resolves { toggle, option }, or null when cancelled. `danger` paints OK red.
export const toggleDialog = ({ title, body, toggle, ok, cancel, danger = false }) =>
  _dialog({ title, body, toggle, tone: danger ? 'danger' : null, ok, cancel: cancel || t('common.cancel') });

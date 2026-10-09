// notice.js — the app-wide toast, a choice prompt, a progress modal and the app's own confirm /
// alert / prompt / choice dialogs, used instead of the browser's (styles: notice.css).

import { t } from './i18n.js';

const _el = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};

// One toast at a time: a message, an action button and a close button. Returns { close, busy }.
let _toast = null;
export function showToast({ text, action, onAction, closeLabel = 'Close' }) {
  _toast?.close();
  const box = _el('div', 'notice-toast');
  box.setAttribute('role', 'status');
  const button = _el('button', 'btn primary', action);
  button.type = 'button';
  const close = _el('button', 'notice-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', closeLabel);
  box.append(_el('span', 'notice-toast-text', text), button, close);
  const handle = {
    close() { box.remove(); if (_toast === handle) _toast = null; },
    busy(label) { button.disabled = true; button.textContent = label; close.hidden = true; },
  };
  button.addEventListener('click', () => onAction(handle));
  close.addEventListener('click', () => handle.close());
  document.body.append(box);
  _toast = handle;
  return handle;
}

function _modal(title, body) {
  const overlay = _el('div', 'notice-overlay');
  const modal = _el('div', 'notice-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.append(_el('h2', null, title));
  if (body) modal.append(_el('p', null, body));
  overlay.append(modal);
  document.body.append(overlay);
  return { overlay, modal };
}

// A question with a few answers ({ value, label, detail }); resolves with the chosen value.
export function ask({ title, body, choices }) {
  return new Promise((resolve) => {
    const { overlay, modal } = _modal(title, body);
    const list = _el('div', 'notice-choices');
    for (const choice of choices) {
      const button = _el('button', 'notice-choice');
      button.type = 'button';
      button.append(_el('strong', null, choice.label));
      if (choice.detail) button.append(_el('span', null, choice.detail));
      button.addEventListener('click', () => { overlay.remove(); resolve(choice.value); });
      list.append(button);
    }
    modal.append(list);
    list.querySelector('button')?.focus();
  });
}

// A progress modal: update(done, total, detail) — total 0 shows an indeterminate bar. With
// `stopLabel`, a Stop button calls onStop once. close() removes it.
export function showProgress({ title, body, stopLabel, onStop }) {
  const { overlay, modal } = _modal(title, body);
  const bar = _el('div', 'notice-bar indeterminate');
  bar.append(_el('div'));
  const detail = _el('div', 'notice-detail', '');
  modal.append(bar, detail);
  if (stopLabel) {
    const actions = _el('div', 'notice-actions');
    const stop = _el('button', 'btn', stopLabel);
    stop.type = 'button';
    stop.addEventListener('click', () => { stop.disabled = true; onStop?.(); }, { once: true });
    actions.append(stop);
    modal.append(actions);
  }
  return {
    update(done, total, text = '') {
      bar.classList.toggle('indeterminate', !total);
      bar.firstChild.style.width = total ? `${Math.min(100, (done / total) * 100)}%` : '';
      detail.textContent = text;
    },
    close() { overlay.remove(); },
  };
}

// A progress modal for work nothing else may interrupt (a backup made or restored): until close(),
// the page behind it is inert — no clicks, keys, focus, scrolling or dropped files reach it — and
// leaving the page asks first. A dialog opened on top of it (a question, the outcome) works as
// usual. update({ title, body, done, total, lines }) — total 0 shows an indeterminate bar, `lines`
// up to two lines of detail under it; stopping(label) disables the Stop button with a new label;
// hide()/show() set the box aside while a dialog asks something (the page stays locked).
export function showOperation({ title, body = '', stopLabel, onStop }) {
  const { overlay, modal } = _modal(title, body);
  modal.classList.add('notice-operation');
  const id = `notice-op-${++_dialogSeq}`;
  const heading = modal.querySelector('h2');
  heading.id = `${id}-t`;
  modal.setAttribute('aria-labelledby', heading.id);
  let text = modal.querySelector('p');
  if (!text) { text = _el('p', null, ''); text.hidden = true; heading.after(text); }
  const bar = _el('div', 'notice-bar indeterminate');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-labelledby', heading.id);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.append(_el('div'));
  const lines = [_el('div', 'notice-detail', ''), _el('div', 'notice-detail', '')];
  modal.append(bar, ...lines);
  let stop = null;
  if (stopLabel) {
    const actions = _el('div', 'notice-actions');
    stop = _el('button', 'btn', stopLabel);
    stop.type = 'button';
    stop.addEventListener('click', () => { stop.disabled = true; onStop?.(); }, { once: true });
    actions.append(stop);
    modal.append(actions);
  }
  modal.tabIndex = -1;

  // The lock. Everything already on the page goes inert; a dialog opened later sits on top of it.
  const returnFocus = document.activeElement;
  const behind = [...document.body.children].filter(el => el !== overlay && !el.inert);
  for (const el of behind) el.inert = true;
  const onTop = (target) => {
    const layer = target?.closest?.('.notice-overlay');
    return !!layer && layer !== overlay && !!(overlay.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING);
  };
  // Keys: a dialog on top handles its own; in this box only moving between its buttons and pressing
  // one; nothing else (no shortcuts, no reload, no scrolling the page behind).
  const onKey = (e) => {
    if (onTop(e.target)) return;
    // Focus lost to the page (a dialog on top closed): Tab brings it back into the box.
    if (e.key === 'Tab' && !overlay.contains(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keydown') (stop && !stop.disabled ? stop : modal).focus();
      return;
    }
    if (overlay.contains(e.target) && (e.key === 'Tab' || ((e.key === 'Enter' || e.key === ' ') && e.target.tagName === 'BUTTON'))) {
      if (e.key === 'Tab' && e.type === 'keydown') {
        e.preventDefault();
        const stops = [...modal.querySelectorAll('button:not(:disabled)')];
        if (stops.length) stops[(stops.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
        else modal.focus();
      }
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  // Files dragged in are turned away, wherever they are dropped.
  const onDrag = (e) => {
    if (onTop(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  const onLeave = (e) => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  for (const type of ['dragenter', 'dragover', 'drop']) window.addEventListener(type, onDrag, true);
  window.addEventListener('beforeunload', onLeave);
  requestAnimationFrame(() => (stop || modal).focus());

  let closed = false;
  return {
    update({ title: nextTitle, body: nextBody, done = 0, total = 0, lines: detail = [] } = {}) {
      if (nextTitle != null) heading.textContent = nextTitle;
      if (nextBody != null) { text.textContent = nextBody; text.hidden = !nextBody; }
      const pct = total ? Math.min(100, (done / total) * 100) : 0;
      bar.classList.toggle('indeterminate', !total);
      bar.firstChild.style.width = total ? `${pct}%` : '';
      if (total) bar.setAttribute('aria-valuenow', String(Math.round(pct))); else bar.removeAttribute('aria-valuenow');
      lines.forEach((line, i) => { line.textContent = detail[i] || ''; line.hidden = !detail[i]; });
    },
    stopping(label) { if (stop) { stop.disabled = true; if (label) stop.textContent = label; } },
    hide() { overlay.classList.add('notice-set-aside'); },
    show() { overlay.classList.remove('notice-set-aside'); (stop && !stop.disabled ? stop : modal).focus(); },
    close() {
      if (closed) return;
      closed = true;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      for (const type of ['dragenter', 'dragover', 'drop']) window.removeEventListener(type, onDrag, true);
      window.removeEventListener('beforeunload', onLeave);
      for (const el of behind) el.inert = false;
      overlay.remove();
      if (returnFocus?.isConnected) returnFocus.focus?.();
    },
  };
}

// ── Confirm / alert / prompt ──
// The app's own dialogs, used instead of the browser's. Each is laid out for what it asks:
//   title   the question or outcome, one line
//   body    what happens / what went wrong, in plain words
//   detail  what it applies to (a gallery, a tag) or an error's own message — a string, or
//           [main, secondary] for a two-line box
//   cover   when detail names a gallery: its cover — a url, or a promise of one ('' for none) —
//           shown at the box's left, like a chapter row
//   tone    'danger' (destructive confirm), 'error', 'success' or 'info' — an icon beside the title
// Esc or a click outside cancels, Tab stays inside, the page behind can't scroll (notice.css).
const _ICONS = {
  danger: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  success: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
let _dialogSeq = 0;

function _dialog({ title, body, detail, cover, tone, input, form, ok, cancel }) {
  return new Promise((resolve) => {
    const id = `notice-dlg-${++_dialogSeq}`;
    const overlay = _el('div', 'notice-overlay');
    const modal = _el('div', 'notice-modal notice-dialog');
    modal.setAttribute('role', tone === 'danger' || tone === 'error' ? 'alertdialog' : 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', `${id}-t`);
    const head = _el('div', 'notice-head');
    if (_ICONS[tone]) {
      const icon = _el('span', `notice-icon ${tone}`);
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${_ICONS[tone]}</svg>`;
      head.append(icon);
    }
    const heading = _el('h2', null, title);
    heading.id = `${id}-t`;
    head.append(heading);
    modal.append(head);
    if (body) {
      const text = _el('p', null, body);
      text.id = `${id}-b`;
      modal.setAttribute('aria-describedby', text.id);
      modal.append(text);
    }
    const lines = (Array.isArray(detail) ? detail : [detail]).filter(Boolean);
    if (lines.length) {
      const box = _el('div', 'notice-detail-box');
      const text = _el('div', 'notice-detail-text');
      text.append(_el('span', 'notice-detail-main', lines[0]));
      if (lines[1]) text.append(_el('span', 'notice-detail-sub', lines[1]));
      if (cover != null) {
        box.classList.add('has-cover');
        const thumb = _el('div', 'notice-thumb');
        thumb.append(_el('span', null, '📄'));
        // Swapped in once loaded, so a slow or missing cover never shows a broken image.
        Promise.resolve(cover).then((url) => {
          if (!url) return;
          const img = new Image();
          img.alt = '';
          img.onload = () => {
            thumb.classList.toggle('landscape', img.naturalWidth >= img.naturalHeight);
            thumb.replaceChildren(img);
          };
          img.src = url;
        }, () => {});
        box.append(thumb);
      }
      box.append(text);
      modal.append(box);
    }
    const field = input ? _el('input', 'notice-input') : null;
    if (field) {
      field.type = 'text';
      field.value = input.value || '';
      field.placeholder = input.placeholder || '';
      field.spellcheck = false;
      field.setAttribute('aria-labelledby', `${id}-t`);
      modal.append(field);
    }
    // A choice among options (radio buttons), with checkboxes beneath — each shown only while the
    // option it belongs to (`for`) is chosen.
    let picked = form?.value;
    const checks = [];
    function syncChecks() { for (const c of checks) c.row.hidden = c.check.for != null && c.check.for !== picked; }
    if (form) {
      const group = _el('div', 'notice-options');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', `${id}-t`);
      for (const choice of form.choices) {
        const row = _el('label', 'notice-option');
        const radio = _el('input');
        radio.type = 'radio';
        radio.name = `${id}-choice`;
        radio.value = choice.value;
        radio.checked = choice.value === picked;
        radio.addEventListener('change', () => { picked = choice.value; syncChecks(); });
        const text = _el('span', 'notice-option-text');
        text.append(_el('strong', null, choice.label));
        if (choice.detail) text.append(_el('span', null, choice.detail));
        row.append(radio, text);
        group.append(row);
      }
      modal.append(group);
      if (form.checks?.length) {
        const list = _el('div', 'notice-checks');
        for (const check of form.checks) {
          const row = _el('label', 'notice-check');
          const box = _el('input');
          box.type = 'checkbox';
          box.checked = !!check.checked;
          row.append(box, _el('span', null, check.label));
          list.append(row);
          checks.push({ check, row, box });
        }
        modal.append(list);
      }
      syncChecks();
    }
    const actions = _el('div', 'notice-actions');
    const no = cancel ? _el('button', 'btn', cancel) : null;
    const yes = _el('button', `btn ${tone === 'danger' ? 'danger' : 'primary'}`, ok || t('common.ok'));
    for (const b of [no, yes]) if (b) { b.type = 'button'; actions.append(b); }
    modal.append(actions);
    overlay.append(modal);
    document.body.append(overlay);

    const returnFocus = document.activeElement;
    const finish = (answer) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      returnFocus?.focus?.();
      resolve(answer);
    };
    const accept = () => finish(field ? field.value.trim()
      : form ? { value: picked, checks: Object.fromEntries(checks.map(c => [c.check.name, c.box.checked])) } : true);
    const dismiss = () => finish(field || form ? null : (cancel ? false : undefined));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); return; }
      if (e.key === 'Enter' && e.target === field) { e.preventDefault(); e.stopPropagation(); accept(); return; }
      if (e.key === 'Tab') {
        const stops = [...modal.querySelectorAll('input, button')];
        const i = stops.indexOf(document.activeElement);
        e.preventDefault();
        stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    yes.addEventListener('click', accept);
    no?.addEventListener('click', dismiss);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });

    if (field) { field.focus(); field.select(); } else (tone === 'danger' && no ? no : yes).focus();
  });
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

// notice.js — the app-wide toast, a choice prompt and a progress modal (styles: notice.css).

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
  const button = _el('button', 'notice-btn primary', action);
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
    const stop = _el('button', 'notice-btn', stopLabel);
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

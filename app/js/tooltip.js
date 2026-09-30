// tooltip.js — one cursor-following tooltip for any [data-tip] element.
//
// Positions instantly under the cursor every mousemove (no CSS transition, so it never lags or
// flies in from a previous spot), and clamps inside the viewport with a margin so it never sits
// on the very edge. Width/height are measured only when the text changes, not on every move, so
// following the cursor stays cheap. Self-contained — runs fully offline.

const MARGIN = 10;            // min gap from any viewport edge
const OFFSET_X = 14, OFFSET_Y = 16;

let _tip = null;
let _target = null;          // current [data-tip] element under the cursor
let _x = 0, _y = 0;          // last cursor position
let _w = 0, _h = 0, _text = '';

function _el() {
  if (_tip) return _tip;
  _tip = document.createElement('div');
  _tip.className = 'shiori-tip';
  _tip.setAttribute('role', 'tooltip');
  (document.body || document.documentElement).appendChild(_tip);
  return _tip;
}

// A tip may open with a short badge (data-tip-badge) and run over several lines ("\n" in
// data-tip); the lines after the first are secondary. A "label\tvalue" line is instead a row of
// its own weight, the value dimmed to the right; its label may open with a badge of its own
// ("badge\vlabel\tvalue"). `text` is the badge and the tip, NUL-joined.
function _render(el, text) {
  const [badge, body] = text.includes('\0') ? text.split('\0') : ['', text];
  if (!badge && !/[\n\t]/.test(body)) { el.textContent = body; return; }
  el.replaceChildren(...body.split('\n').map((line, i) => {
    const row = document.createElement('div');
    const [label, value] = line.split('\t');
    if (value != null) {
      const v = document.createElement('span');
      v.className = 'shiori-tip-value';
      v.textContent = value;
      row.className = 'shiori-tip-pair';
      const [tag, text] = label.includes('\v') ? label.split('\v') : ['', label];
      const name = document.createElement('span');
      if (tag) {
        const b = document.createElement('span');
        b.className = 'shiori-tip-badge';
        b.textContent = tag;
        name.append(b);
      }
      name.append(text);
      row.append(name, v);
      return row;
    }
    if (i) row.className = 'shiori-tip-sub';
    else if (badge) {
      const b = document.createElement('span');
      b.className = 'shiori-tip-badge';
      b.textContent = badge;
      row.append(b);
    }
    row.append(line);
    return row;
  }));
}

function _place(text) {
  const el = _el();
  if (!text) { el.style.display = 'none'; _text = ''; return; }
  if (text !== _text) {           // only touch the DOM / read layout when the text actually changes
    _render(el, text);
    // Measure at the viewport's corner: a tip that wraps would otherwise get only the width left
    // where it last stood (say, by the right edge) and break into extra lines.
    el.style.left = '0px'; el.style.top = '0px';
    el.style.display = 'block';
    _w = el.offsetWidth; _h = el.offsetHeight;
    _text = text;
  } else if (el.style.display === 'none') {
    el.style.display = 'block';
  }
  // Clamp against the layout viewport (documentElement.clientWidth/Height), not window.inner*,
  // which include the scrollbar — otherwise the tooltip can sit underneath a vertical scrollbar.
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = _x + OFFSET_X;
  if (left + _w > vw - MARGIN) left = vw - _w - MARGIN;  // keep a margin
  if (left < MARGIN) left = MARGIN;
  let top = _y + OFFSET_Y;
  if (top + _h > vh - MARGIN) top = _y - _h - 8;   // flip above the cursor near the bottom
  if (top < MARGIN) top = MARGIN;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

// ── Modifier labels ──
// While Alt or Shift is held, an element's data-tip-alt / data-tip-shift label shows in place of
// its data-tip (Alt's first; not on a disabled control). The label is picked each time the tip is
// shown, never swapped into data-tip, so code that rewrites a tip meanwhile can't be undone by a
// stale swap. The held state follows every key event and is corrected by every mouse event (both
// carry the real modifier state); leaving the window drops it, since a release that happens
// elsewhere never arrives here. Pages follow the same state through onModifiers() for their own
// modifier affordances (flipped icons, delete previews).
let _shift = false, _alt = false;
let _altShown = false;       // this Alt hold showed an Alt label
const _modSubs = new Set();

export const modifiers = () => ({ shift: _shift, alt: _alt });
// cb({ shift, alt }) runs whenever either changes. Returns an unsubscribe.
export function onModifiers(cb) { _modSubs.add(cb); return () => _modSubs.delete(cb); }

function _setModifiers(shift, alt) {
  if (shift === _shift && alt === _alt) return;
  _shift = shift; _alt = alt;
  if (!alt) _altShown = false;
  for (const cb of [..._modSubs]) { try { cb({ shift, alt }); } catch {} }
  refreshTooltip();
}

// An open dropdown list sits in the top layer, above this tooltip — so no tips while one is open.
// Lists only open or close on a press or a key, so that's when it's re-checked (not per move).
const _OPEN_LIST = CSS.supports('selector(select:open)') ? 'select:open' : null;
let _listOpen = false;
const _tipOf = (el) => {
  if (!el || _listOpen) return '';
  const alt = !el.disabled && _alt && el.dataset.tipAlt;
  const tip = alt || (!el.disabled && _shift && el.dataset.tipShift) || el.dataset.tip;
  if (!tip) return '';
  if (alt) _altShown = true;
  return el.dataset.tipBadge ? `${el.dataset.tipBadge}\0${tip}` : tip;
};

function _onMove(e) {
  _x = e.clientX; _y = e.clientY;
  _target = (e.target.closest && e.target.closest('[data-tip], [data-tip-shift], [data-tip-alt]')) || null;
  _setModifiers(e.shiftKey, e.altKey);
  _place(_tipOf(_target));
}

// A key event carries the modifiers as they are after it. Releasing Alt after an Alt label showed
// would otherwise hand keyboard focus to the browser's menu, so that release is swallowed.
function _onKey(e) {
  if (e.type === 'keyup' && e.key === 'Alt' && _altShown) e.preventDefault();
  _setModifiers(e.shiftKey, e.altKey);
}

// Scrolling moves content under a still cursor without any mousemove, so the target would stick.
// Re-check what's under the cursor: keep the tip only while it's still over the same element,
// otherwise drop it (like a native tooltip) until the cursor next moves.
function _onScroll() {
  if (!_target) return;
  const under = document.elementFromPoint(_x, _y);
  if (under && _target.contains(under)) return;
  _target = null;
  _place('');
}

function _checkOpenList() {
  requestAnimationFrame(() => {
    _listOpen = !!document.querySelector(_OPEN_LIST);
    if (_listOpen) _place('');
  });
}

let _inited = false;
export function initTooltips() {
  if (_inited) return;
  _inited = true;
  document.addEventListener('mousemove', _onMove, { passive: true });
  document.addEventListener('mousedown', (e) => _setModifiers(e.shiftKey, e.altKey), { capture: true, passive: true });
  // Capture, so a handler that stops a key event can't hide a modifier change from the tip.
  document.addEventListener('keydown', _onKey, true);
  document.addEventListener('keyup', _onKey, true);
  // Capture: scroll doesn't bubble, and inner scroll containers (lists, panels) count too.
  document.addEventListener('scroll', _onScroll, { capture: true, passive: true });
  // With the cursor off the page or the window left, the tip also forgets its target, so a key
  // press (a modifier change calling refreshTooltip) can't bring it back until the cursor moves.
  const hide = () => { _target = null; _place(''); };
  document.addEventListener('mouseleave', hide);
  window.addEventListener('blur', () => { hide(); _setModifiers(false, false); });
  if (_OPEN_LIST) for (const type of ['pointerdown', 'click', 'keydown']) document.addEventListener(type, _checkOpenList);
}

// Re-read the current target's tip without a mouse move — for callers that change a tip in place
// while the cursor is stationary.
export function refreshTooltip() {
  _place(_tipOf(_target));
}

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
// data-tip); the lines after the first are secondary. `text` is the badge and the tip, NUL-joined.
function _render(el, text) {
  const [badge, body] = text.includes('\0') ? text.split('\0') : ['', text];
  if (!badge && !body.includes('\n')) { el.textContent = body; return; }
  el.replaceChildren(...body.split('\n').map((line, i) => {
    const row = document.createElement('div');
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

// An open dropdown list sits in the top layer, above this tooltip — so no tips while one is open.
// Lists only open or close on a press or a key, so that's when it's re-checked (not per move).
const _OPEN_LIST = CSS.supports('selector(select:open)') ? 'select:open' : null;
let _listOpen = false;
const _tipOf = (el) => {
  if (!el || _listOpen || !el.dataset.tip) return '';
  return el.dataset.tipBadge ? `${el.dataset.tipBadge}\0${el.dataset.tip}` : el.dataset.tip;
};

function _onMove(e) {
  _x = e.clientX; _y = e.clientY;
  const t = e.target.closest && e.target.closest('[data-tip]');
  _target = (t && t.dataset.tip) ? t : null;
  _place(_tipOf(_target));
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
  document.addEventListener('mouseleave', () => _place(''));
  window.addEventListener('blur', () => _place(''));
  if (_OPEN_LIST) for (const type of ['pointerdown', 'click', 'keydown']) document.addEventListener(type, _checkOpenList);
}

// Re-read the current target's data-tip without a mouse move — for callers that mutate data-tip
// in place (e.g. swapping to a Shift action label while the cursor is stationary).
export function refreshTooltip() {
  _place(_tipOf(_target));
}

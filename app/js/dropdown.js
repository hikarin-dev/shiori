// dropdown.js — dropdown behaviour the look in dropdown.css relies on.
//
// The list hangs straight off its box, so its side has to be settled before it opens: below,
// unless only the space above can fit it. Delegated from the document, so dropdowns built later
// (modals, generated rows) are covered too.
//
// A styled box is only as wide as its chosen option (a native one fits its widest), so a
// free-standing box marked data-fit-widest is held at its widest option's width instead: it
// doesn't jump between picks, and every option fits the list.

const ROW = 28;        // rough option row height (px) — only used to judge whether the list fits below
const MAX_ROWS = 8;   // the list shows at most this many options and scrolls the rest (dropdown.css)

function place(e) {
  const sel = e.target.closest && e.target.closest('select');
  if (!sel) return;
  const r = sel.getBoundingClientRect(), below = innerHeight - r.bottom;
  sel.classList.toggle('opens-up', below < Math.min(sel.options.length, MAX_ROWS) * ROW + 10 && r.top > below);
}

// Measured by showing each option in turn — synchronous, so nothing paints in between and no
// change event fires.
function fitWidest() {
  for (const sel of document.querySelectorAll('select[data-fit-widest]')) {
    const keep = sel.selectedIndex;
    sel.style.minWidth = '';
    let width = 0;
    for (let i = 0; i < sel.options.length; i++) {
      sel.selectedIndex = i;
      width = Math.max(width, sel.offsetWidth);
    }
    sel.selectedIndex = keep;
    sel.style.minWidth = `${width}px`;
  }
}

let _inited = false;
export function initDropdowns() {
  if (_inited || !CSS.supports('appearance', 'base-select')) return;
  _inited = true;
  document.addEventListener('pointerdown', place, true);
  document.addEventListener('keydown', place, true);
  document.fonts.ready.then(fitWidest);                    // widths depend on the loaded font
  window.addEventListener('shiori-lang-change', fitWidest); // …and on the option labels
}

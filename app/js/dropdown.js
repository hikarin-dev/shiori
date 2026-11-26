// dropdown.js — dropdown behaviour the look in reader.css (its dropdowns, at its end) relies on.
//
// The list hangs straight off its box, so its side has to be settled before it opens: below,
// unless only the space above can fit it. Delegated from the document, so dropdowns built later
// (modals, generated rows) are covered too.
//
// A styled box is only as wide as its chosen option (a native one fits its widest), so a
// free-standing box marked data-fit-widest is held at its widest option's width instead: it
// doesn't jump between picks, and every option fits the list.

// The selects the look is for: the reader's, in its top bar and its settings (reader.css holds its
// dropdowns' rules to those two). A page that draws the reader beside controls of its own keeps its
// selects to itself, the reader shown or left.
const READER_SELECT = ':is(#topbar, #readerSettingsModal) select';
const readerSelects = (more = '') => document.querySelectorAll(READER_SELECT + more);

const ROW = 28;        // rough option row height (px) — only used to judge whether the list fits below
const MAX_ROWS = 8;   // the list shows at most this many options and scrolls the rest (reader.css)

function place(e) {
  const sel = e.target.closest && e.target.closest(READER_SELECT);
  if (!sel) return;
  wrapOptions(sel);
  const r = sel.getBoundingClientRect(), below = innerHeight - r.bottom;
  sel.classList.toggle('opens-up', below < Math.min(sel.options.length, MAX_ROWS) * ROW + 10 && r.top > below);
}

// Give long customizable pickers a real scroll container, also usable by the shared overlay.
function wrapOptions(sel) {
  if (!document.documentElement.classList.contains('custom-scrollbars')) {
    const list = sel.querySelector('.dd-options');
    if (list) {
      const selected = sel.selectedIndex;
      list.replaceWith(...list.children);
      sel.selectedIndex = selected;
    }
    return;
  }
  if (sel.multiple || sel.size > 1 || sel.options.length <= MAX_ROWS || sel.querySelector('.dd-options')) return;
  const selected = sel.selectedIndex;
  const list = document.createElement('div');
  list.className = 'dd-options';
  for (const child of [...sel.children]) {
    if (child.matches('option, optgroup')) list.append(child);
  }
  sel.append(list);
  sel.selectedIndex = selected;
}

// Measured by showing each option in turn — synchronous, so nothing paints in between and no
// change event fires.
function fitWidest() {
  for (const sel of readerSelects('[data-fit-widest]')) {
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
  readerSelects().forEach(wrapOptions);
  window.addEventListener('shiori-scrollbar-change', () => readerSelects().forEach(wrapOptions));
  document.addEventListener('pointerdown', place, true);
  document.addEventListener('keydown', place, true);
  document.fonts.ready.then(fitWidest);                    // widths depend on the loaded font
  window.addEventListener('shiori-lang-change', fitWidest); // …and on the option labels
}

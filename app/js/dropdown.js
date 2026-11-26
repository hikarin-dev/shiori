// dropdown.js — dropdown behaviour the look in reader.css (its dropdowns, at its end) relies on, for the
// reader's one browser's own select: the top bar's page menu (page-nav.js). Every other list of the app,
// reader settings' font among them, is the one page's Select.
//
// The list hangs straight off its box, so its side has to be settled before it opens: below,
// unless only the space above can fit it. Delegated from the document (the bar's select is drawn by the
// route's frame, after this is started).

// The selects the look is for: the reader's, in its top bar (reader.css holds its dropdowns' rules to
// it). A page that draws the reader beside controls of its own keeps its selects to itself, the reader
// shown or left.
const READER_SELECT = ':is(#topbar) select';
const readerSelects = () => document.querySelectorAll(READER_SELECT);

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

let _inited = false;
export function initDropdowns() {
  if (_inited || !CSS.supports('appearance', 'base-select')) return;
  _inited = true;
  readerSelects().forEach(wrapOptions);
  window.addEventListener('shiori-scrollbar-change', () => readerSelects().forEach(wrapOptions));
  document.addEventListener('pointerdown', place, true);
  document.addEventListener('keydown', place, true);
}

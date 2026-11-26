// reader/names.ts — what the reader sets on <html> before its frame is drawn: the navigation it opens
// with (the side controls or the top bar, chosen and saved on a first open), the controls hidden from
// the start, and the side controls' place. What 1.3's reader page set from its head (app/reader-init.js
// until 2026-11-26), read from the same settings and set the same way (app/tests/reader-names.test.mjs
// holds it to 1.3's answers); set by the route before its frame is drawn, taken away when the reader goes.
export const READER_PAGE_NAMES = { classes: ['reader-side-nav', 'reader-controls-hidden'], data: ['snPos', 'snAlign'] } as const;

export function setReaderNames(html: HTMLElement, storage: Storage) {
  try {
    let nav = storage.getItem('shiori-reader-nav');
    if (nav !== 'top' && nav !== 'side') {
      nav = storage.getItem('shiori:readerMode') ? 'top' : 'side';
      storage.setItem('shiori-reader-nav', nav);
    }
    if (nav === 'side') html.classList.add('reader-side-nav');
    const shown = nav === 'side' ? storage.getItem('shiori-reader-side-pin') !== '0' : storage.getItem('shiori-reader-pin') === '1';
    if (!shown) html.classList.add('reader-controls-hidden');
    const [pos, align] = (storage.getItem('shiori-reader-nav-place') || '').split('-');
    html.dataset.snPos = ['top', 'bottom', 'left', 'right'].includes(pos) ? pos : 'right';
    html.dataset.snAlign = ['start', 'center', 'end'].includes(align) ? align : 'start';
  } catch {}
}

export function takeReaderNames(html: HTMLElement) {
  html.classList.remove(...READER_PAGE_NAMES.classes);
  for (const name of READER_PAGE_NAMES.data) delete html.dataset[name];
}

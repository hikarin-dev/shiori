// Read before the reader draws: the navigation it opens with (Reader settings → Navigation). The
// reader's own script runs after the first paint, so a reader set to the side controls would show
// the top bar for a moment first. reader.js keeps the class in step from then on.
// Someone new to the reader starts with the side controls; someone who has read before (a reading
// mode saved) keeps the top bar they know. Either way it's saved, so the choice stays put.
// The modern navigation's place goes on too: its edge and where along it (right, at the start by
// default), so its rail draws where it stands.
try {
  let nav = localStorage.getItem('shiori-reader-nav');
  if (nav !== 'top' && nav !== 'side') {
    nav = localStorage.getItem('shiori:readerMode') ? 'top' : 'side';
    localStorage.setItem('shiori-reader-nav', nav);
  }
  if (nav === 'side') document.documentElement.classList.add('reader-side-nav');
  // Fit and zoom hide with the controls (the modern navigation hidden, the classic header unpinned):
  // from the start, so they don't show for a moment first.
  const shown = nav === 'side' ? localStorage.getItem('shiori-reader-side-pin') !== '0' : localStorage.getItem('shiori-reader-pin') === '1';
  if (!shown) document.documentElement.classList.add('reader-controls-hidden');
  const [pos, align] = (localStorage.getItem('shiori-reader-nav-place') || '').split('-');
  const root = document.documentElement.dataset;
  root.snPos = ['top', 'bottom', 'left', 'right'].includes(pos) ? pos : 'right';
  root.snAlign = ['start', 'center', 'end'].includes(align) ? align : 'start';
} catch {}

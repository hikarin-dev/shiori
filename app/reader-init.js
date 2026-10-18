// Read before the reader draws: the navigation it opens with (Reader settings → Navigation). The
// reader's own script runs after the first paint, so a reader set to the side controls would show
// the top bar for a moment first. reader.js keeps the class in step from then on.
// Someone new to the reader starts with the side controls; someone who has read before (a reading
// mode saved) keeps the top bar they know. Either way it's saved, so the choice stays put.
try {
  let nav = localStorage.getItem('shiori-reader-nav');
  if (nav !== 'top' && nav !== 'side') {
    nav = localStorage.getItem('shiori:readerMode') ? 'top' : 'side';
    localStorage.setItem('shiori-reader-nav', nav);
  }
  if (nav === 'side') document.documentElement.classList.add('reader-side-nav');
} catch {}

// slide.ts — rows of the chapter list sliding to their new places, as 1.3's flipRows did (FLIP: where
// each row showed before the change, then from there to where it is, 220 ms; a slide still running is
// taken from where it is; a row off the screen just moves; nothing with less motion asked for). By
// `top`, the row being positioned where it is: an eased transform would lift the page's words after it
// onto layers of their own while it ran (rule 29).
export const SLIDE_MS = 220;
export const SLIDE_EASING = 'cubic-bezier(.2, .8, .2, 1)';

// Where each row of `list` shows now (its top on the window).
export const rowTops = (list: Element) => new Map([...list.children].map((row) => [row, row.getBoundingClientRect().top]));

// Each row of `list` that showed at `tops` (rowTops before the change) slides from there to where it is.
export function slideRows(list: Element, tops: Map<Element, number>) {
  for (const row of tops.keys()) for (const a of row.getAnimations()) a.cancel();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const row of list.children as HTMLCollectionOf<HTMLElement>) {
    const was = tops.get(row);
    if (was == null) continue;
    const now = row.getBoundingClientRect().top;
    const offScreen = Math.max(was, now) < -row.offsetHeight || Math.min(was, now) > innerHeight;
    if (Math.abs(was - now) < 0.5 || offScreen) continue;
    row.animate([{ top: `${was - now}px` }, { top: '0px' }], { duration: SLIDE_MS, easing: SLIDE_EASING });
  }
}

// The row the grip's drag lifted (./row-drag.ts: data-dragging) set down once its slide to its place has
// run (at once where it has none): above the others until it is there.
export function setDown(list: Element) {
  const row = list.querySelector(':scope > [data-dragging]');
  if (!row) return;
  const travel = row.getAnimations().find((a) => !(a instanceof CSSTransition));
  const done = () => row.removeAttribute('data-dragging');
  if (travel) travel.finished.then(done, done); else done();
}

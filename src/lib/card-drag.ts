// card-drag.ts — a library card dragged onto another to make the two a series (1.3's _beginCardDrag,
// app/js/library.js), kept outside React: the page's cards are not drawn again while the pointer moves.
// Loaded at the first press on a cover (the page's load takes none of it).
//
// Begun by a mouse's left button on a card's cover (the card's own rule: never a finger, and never from
// the rest of the card, whose words stay selectable). Nothing happens until the pointer has moved 6px,
// so a plain click still opens the card. Then a copy of the card follows the pointer, lifted, over
// everything (the card itself dimmed in its place), and the card under the pointer is marked as the
// target. Released over a card: the copy goes to it and fades, and the page is told (onDrop: the
// target's id, the dragged card's); over none, the copy goes back to its card. Either way the click
// that follows the release is swallowed (350 ms), so the card's link does not open.
//
// As 1.3's: Escape, a second button and the window losing focus change nothing (a press of another
// button is a move to the pointer's listeners; the drag ends where the left button is let go), and a
// pointer the browser takes back (pointercancel) ends it as a release does. A drag the page leaves is
// undone at once, leaving nothing behind (cancel).
//
// The copy is the card's elements as they are when the drag begins (a job's bar as it was then), in a
// holder that carries the grid's modes (its data-card-modes), so it looks as the card does at rest in
// the grid: the stylesheet's rules for the copy are gallery-card.css's.
const THRESHOLD = 6;        // px the pointer moves before the drag begins
const SWALLOW_MS = 350;     // the click after a drag is swallowed for this long
const SETTLE_MS = 200;      // the copy's flight to its place, then it goes

export type CardDrag = { cancel(): void };

// `onDrop(targetId, sourceId)`: released over a card. `onDone`: nothing of the drag is left (its
// listeners, its copy, its timers).
export function beginCardDrag(start: { x: number; y: number }, card: HTMLElement, gid: string,
  { onDrop, onDone = () => {} }: { onDrop: (targetId: string, sourceId: string) => void; onDone?: () => void }): CardDrag {
  let dragging = false, clone: HTMLElement | null = null, holder: HTMLElement | null = null, target: HTMLElement | null = null, offX = 0, offY = 0;
  let frame = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let swallow: ((e: Event) => void) | null = null;

  const startClone = () => {
    const rect = card.getBoundingClientRect();
    offX = start.x - rect.left; offY = start.y - rect.top;
    holder = document.createElement('div');
    holder.className = 'card-drag-host';
    const modes = card.parentElement?.getAttribute('data-card-modes');
    if (modes != null) holder.setAttribute('data-card-modes', modes);
    clone = card.cloneNode(true) as HTMLElement;
    clone.classList.add('card-drag-clone');
    clone.classList.remove('merge-target');
    clone.setAttribute('aria-hidden', 'true');
    clone.style.width = rect.width + 'px';
    clone.style.left = rect.left + 'px';
    clone.style.top = rect.top + 'px';
    holder.appendChild(clone);
    document.body.appendChild(holder);
    card.classList.add('drag-source');
    document.body.classList.add('card-dragging');
    frame = requestAnimationFrame(() => clone?.classList.add('lifted'));
  };
  const moveClone = (ev: PointerEvent) => { if (clone) { clone.style.left = (ev.clientX - offX) + 'px'; clone.style.top = (ev.clientY - offY) + 'px'; } };
  const updateTarget = (ev: PointerEvent) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const over = el && el.closest<HTMLElement>('.card');
    const valid = over && over !== card ? over : null;
    if (target && target !== valid) target.classList.remove('merge-target');
    if (valid) valid.classList.add('merge-target');
    target = valid;
  };
  const later = (fn: () => void, ms: number) => { const timer = setTimeout(() => { timers.delete(timer); fn(); if (!timers.size) onDone(); }, ms); timers.add(timer); };

  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < THRESHOLD) return;
      dragging = true;
      startClone();
    }
    ev.preventDefault();
    moveClone(ev);
    updateTarget(ev);
  };
  const listen = (on: boolean) => {
    const how = on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document);
    how('pointermove', move as EventListener);
    how('pointerup', up as EventListener);
    how('pointercancel', up as EventListener);
  };
  const cleanup = () => {
    listen(false);
    card.classList.remove('drag-source');
    document.body.classList.remove('card-dragging');
  };
  const up = () => {
    cleanup();
    if (!dragging) { onDone(); return; }   // a click: the card opens
    swallow = (ce: Event) => { ce.preventDefault(); ce.stopPropagation(); };
    document.addEventListener('click', swallow, { capture: true, once: true });
    later(() => { if (swallow) document.removeEventListener('click', swallow, true); swallow = null; }, SWALLOW_MS);
    const dropTarget = target;
    if (target) target.classList.remove('merge-target');
    const dest = (dropTarget || card).getBoundingClientRect();
    if (clone) {
      clone.classList.add('dropping');
      clone.style.left = dest.left + 'px'; clone.style.top = dest.top + 'px';
      if (dropTarget) clone.style.opacity = '0'; else clone.classList.remove('lifted');
    }
    const gone = holder;
    later(() => gone?.remove(), SETTLE_MS);
    if (dropTarget?.dataset.galleryId) onDrop(dropTarget.dataset.galleryId, gid);
  };
  listen(true);

  return {
    // Everything undone now: the page is being left.
    cancel() {
      cleanup();
      cancelAnimationFrame(frame);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      if (swallow) document.removeEventListener('click', swallow, true);
      swallow = null;
      target?.classList.remove('merge-target');
      holder?.remove();
      clone = holder = target = null;
      onDone();
    },
  };
}

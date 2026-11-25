// row-drag.ts — a chapter row dragged by its grip to another place in the list (1.3's "Drag to reorder",
// app/js/overview.js startRowDrag … endRowDrag), kept outside React: the list is not drawn again while
// the pointer moves. Loaded at the first press on a grip (the page's load takes none of it).
//
// As 1.3's: the left button's press on a grip (a finger's too: the grip takes a finger's drag, its
// touch-action none), on a list of two rows or more, holds the pointer; nothing happens until it has
// moved 3px. Then the row rides under the pointer, kept within the list, above the others, lifted (the
// raised ground, the strong frame, the lift shadow: Card's data-dragging), and the rows it passes slide
// aside to open the place where it would land (the place nearest where it is now: landing below its
// own, its bottom meets the bottom of the row it passed; above, the tops meet). Nothing in the DOM
// moves until the drop. Near the window's top (under the header) or bottom edge, within 64px, the page
// scrolls each frame, faster the further in (a third of the way past the edge's line, 24px at most), so
// a row can travel the whole of a long list. While it is dragged the rows show only what is being moved
// (no row's buttons), its grip's tip is put away, and the pointer is the closed hand everywhere.
//
// Let go in another place: the page is told the shown rows' new order (onDrop) and draws it in the
// frame of the drop, the rows sliding from where they show to their places (ChapterList, ./slide.ts):
// the ones that slid aside are there already, so only the dropped row travels, above the others until
// it is there. Let go in its own place, Escape, or the pointer lost (pointercancel, lostpointercapture):
// every row slides back to its own place. The page is told when it is over (onEnd), whatever its end.
//
// Rule 29: every row is placed by `top` (rows are positioned where they are), never a transform. The
// dragged row follows the pointer at once (no transition); the rows making room ease by `top` (0.2s,
// 1.3's curve: overview.css, while the list says data-sorting).
import { refreshTooltip } from '@lib/tooltip.js';
import { rowTops, setDown, slideRows } from './slide';

const DRAG_START_PX = 3;   // a press becomes a drag once it has moved this far
const DRAG_EDGE_PX = 64;   // how near an edge the page starts scrolling

export type RowDrag = { cancel(): void };
// The press that begins it: its pointer, where it was on the window and on the page.
export type RowPress = { pointerId: number; clientY: number; pageY: number };
export type RowDragOptions = {
  // Let go in another place: the shown rows' ids in their new order. Answers whether the page draws
  // that order (false: it could not, the list being stale: the rows then slide back).
  onDrop: (order: string[]) => boolean;
  onEnd: () => void;
};

// Begins a drag of `row` from its `grip`, pressed at `press`. Null where there is none to begin: a
// list of one row, or a press already let go (the pointer can no longer be held).
export function beginRowDrag(press: RowPress, grip: HTMLElement, row: HTMLElement, { onDrop, onEnd }: RowDragOptions): RowDrag | null {
  const list = row.parentElement;
  if (!list) return null;
  const rows = [...list.children] as HTMLElement[];
  if (rows.length < 2) return null;
  for (const r of rows) for (const a of r.getAnimations()) a.finish();   // measure rows where they land
  try { grip.setPointerCapture(press.pointerId); } catch { return null; }
  const sy = scrollY;
  const from = rows.indexOf(row);
  // Each row's place in page coordinates, so scrolling while dragging doesn't move them.
  const slots = rows.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top + sy, h: b.height }; });
  const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
  const edgeTop = (document.querySelector('.app-header')?.getBoundingClientRect().bottom || 0) + DRAG_EDGE_PX;
  let to = from, y = press.clientY, active = false, raf = 0, tip: string | null = null, over = false;

  function layout() {
    const own = slots[from];
    const first = slots[0], last = slots[slots.length - 1];
    const pointerDy = y + scrollY - press.pageY;
    if (!active) {
      if (Math.abs(pointerDy) < DRAG_START_PX) return;
      active = true;
      list!.setAttribute('data-sorting', '');
      row.setAttribute('data-dragging', '');
      document.body.classList.add('ch-dragging');
      tip = grip.getAttribute('data-tip');   // its tip would otherwise follow the pointer the whole way
      grip.removeAttribute('data-tip');
      refreshTooltip();
      raf = requestAnimationFrame(scroll);
    }
    const dy = Math.max(first.top - own.top, Math.min(last.top + last.h - own.top - own.h, pointerDy));
    row.style.top = `${dy}px`;
    const top = own.top + dy;
    let place = from, best = Math.abs(dy);
    slots.forEach((s, i) => {
      if (i === from) return;
      const distance = Math.abs(top - (i > from ? s.top + s.h - own.h : s.top));
      if (distance < best) { best = distance; place = i; }
    });
    if (place === to) return;
    to = place;
    const shift = own.h + gap;
    rows.forEach((r, i) => {
      if (i === from) return;
      const offset = i > from && i <= to ? -shift : i < from && i >= to ? shift : 0;
      r.style.top = offset ? `${offset}px` : '';
    });
  }

  function scroll() {
    const bottom = innerHeight - DRAG_EDGE_PX;
    const past = y < edgeTop ? y - edgeTop : y > bottom ? y - bottom : 0;
    if (past) {
      const before = scrollY;
      scrollBy(0, Math.sign(past) * Math.min(24, Math.ceil(Math.abs(past) / 3)));
      if (scrollY !== before) layout();
    }
    raf = requestAnimationFrame(scroll);
  }

  const onMove = (ev: PointerEvent) => { if (ev.pointerId !== press.pointerId) return; y = ev.clientY; layout(); };
  const onUp = (ev: PointerEvent) => { if (ev.pointerId === press.pointerId) end(true); };
  // (A finger's pointer was held by what it touched, the grip's icon, until the grip took it: that
  // one's loss, told up to the grip, is no loss of the drag's.)
  const onLost = (ev: Event) => { if (ev.type === 'pointercancel' || ev.target === grip) end(false); };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    end(false);
  };
  const listen = (on: boolean) => {
    const how = (target: EventTarget, type: string, fn: EventListener, capture = false) => {
      if (on) target.addEventListener(type, fn, capture); else target.removeEventListener(type, fn, capture);
    };
    how(grip, 'pointermove', onMove as EventListener);
    how(grip, 'pointerup', onUp as EventListener);
    how(grip, 'pointercancel', onLost);
    how(grip, 'lostpointercapture', onLost);
    how(window, 'keydown', onKey as EventListener, true);
  };
  listen(true);

  // Every row back to its place in the list as it is now, sliding from where it shows; the dragged row
  // above the others until it is there.
  function land() {
    if (!list!.hasAttribute('data-sorting')) return;
    const tops = rowTops(list!);
    list!.removeAttribute('data-sorting');
    for (const r of rows) r.style.top = '';
    slideRows(list!, tops);
  }

  function teardown() {
    over = true;
    listen(false);
    cancelAnimationFrame(raf);
    if (grip.hasPointerCapture(press.pointerId)) grip.releasePointerCapture(press.pointerId);
    document.body.classList.remove('ch-dragging');
    if (tip != null) grip.setAttribute('data-tip', tip);
  }

  function end(commit: boolean) {
    if (over) return;
    teardown();
    const moved = commit && active && to !== from;
    if (active) {
      // Let go in another place: the page draws the new order, and its list lands the rows (ChapterList
      // ends the drag's places as it takes where they show, then slides them, in the frame of the drop).
      let drawn = false;
      if (moved) {
        const order = rows.map((r) => r.dataset.chapterId ?? '');
        order.splice(to, 0, ...order.splice(from, 1));
        list!.setAttribute('data-sorting', 'dropped');
        drawn = onDrop(order);
      }
      // (A list the page has not drawn again by the next frame lands then.)
      if (drawn) requestAnimationFrame(() => { if (list!.hasAttribute('data-sorting')) { land(); setDown(list!); } });
      else { land(); setDown(list!); }
    }
    onEnd();
  }

  return {
    // Everything undone now, nothing sliding: the page is being left.
    cancel() {
      if (over) return;
      teardown();
      list.removeAttribute('data-sorting');
      row.removeAttribute('data-dragging');
      for (const r of rows) r.style.top = '';
      onEnd();
    },
  };
}

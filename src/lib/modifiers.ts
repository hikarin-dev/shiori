// modifiers.ts — the held modifier keys, for looks that follow them. The app's one tooltip
// (app/js/tooltip.js, started by the app) already follows Shift and Alt on every key and pointer event
// and drops them when the window is left; this reads what it knows instead of listening again.
//
// useShiftHeld(ref): while Shift is held, the element carries the class `shift-held` (1.3 put it on
// <body>), which the looks below it read in CSS: a removable tag's delete preview (Tag), a card
// button's Shift face (GalleryCard). One subscription for the element, however many cards are under
// it, and nothing drawn again by React: the class is the element's own. Give it an element whose
// className React does not change after it mounts (React would write the class off with it).
import { useEffect, type RefObject } from 'react';
import { modifiers, onModifiers } from '@lib/tooltip.js';

export function useShiftHeld(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const follow = ({ shift }: { shift: boolean }) => { el.classList.toggle('shift-held', shift); };
    follow(modifiers());
    const off = onModifiers(follow);
    return () => { off(); el.classList.remove('shift-held'); };
  }, [ref]);
}

// DropOverlay — what shows over the whole window while files are dragged over a page that takes them
// (the library's import, the overview's add bar): its words in the brand colour, 18px, in the middle
// of a dashed brand-coloured frame round the window, over a dark veil. It never takes the pointer (the
// drop lands on the page) and shows and goes at once, as 1.3's did. Its words are its children, given
// by the page (1.3 wrote "Drop to import" into its stylesheet, in English in every language: A6, the
// library's to settle).
//
//   still  drawn in its place, inside the box round it, instead of over the window (/components).
// 1.3's look and size (library.css, body.drag-over::after): fixed over the window on the drop layer
// (1000), the veil the page's ground at 72% (--drop-ground, a token of its own).
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

type Props = ComponentProps<'div'> & { shown?: boolean; still?: boolean };

function DropOverlay({ shown = true, still, className, children, ...props }: Props) {
  if (!shown) return null;
  return (
    <div
      data-slot="drop-overlay"
      className={cn(
        still ? 'absolute' : 'fixed', 'inset-0 z-drop pointer-events-none flex items-center justify-center',
        'border-2 border-dashed border-primary bg-drop-ground font-sans text-18 text-primary',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export { DropOverlay };

// DragHandle — the grip at a row's left edge that drags it to another place in its list (the
// overview's chapter rows): six dots, 14px, in a 14×30 target held centred at the row's left edge
// (2px in), taking no room of its own. The dimmest grey; the text colour under the pointer and while
// its row is dragged (data-dragging on the row); the grab cursor; a finger's drag is its own
// (touch-action none). Its tip says what it does (data-tip, tooltip.js). Whether it shows (only
// under the pointer where there is one, never on a lone row) and the drag itself are its row's.
import type { ComponentProps } from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

function DragHandle({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="drag-handle"
      className={cn(
        'absolute inset-y-0 left-[2px] my-auto flex h-[30px] w-[14px] cursor-grab touch-none items-center justify-center rounded-4 text-muted-dim',
        'transition-[color] duration-fast ease-standard hover:text-foreground in-data-dragging:text-foreground',
        className,
      )}
      {...props}
    >
      <GripVertical aria-hidden strokeWidth={2} className="size-[14px]" />
    </span>
  );
}

export { DragHandle };

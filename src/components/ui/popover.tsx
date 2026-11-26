// Popover — a plain panel that floats by what opened it, and the floating panel the menus share: the
// surface, the plain frame, radius 8, the popover shadow, the menu layer.
//
//   variant  panel     what it holds sets its padding (the library header's burger: its stats in a
//                      row, 12px round and 8 apart; the reader bar's ⋯: its buttons, 8 and 8);
//            chapters  the reader's chapter list under its pill: 320 wide (the window less 12px a
//                      side at most), up to 70% of the window or 560 tall, radius 12, the rail's own
//                      deep shadow; a heading with its close, then the chapters, which scroll.
//
// Placed by Base UI's positioner (not CSS anchor positioning, as the select's list is, T18): a menu
// opens at the pointer as often as by a button, which no element anchors, and a panel is kept 8px
// inside the window, sliding along its edge or flipping to the other side, which CSS can't do
// (rule 10's exception). It is fixed to the window (position: fixed), so it never lengthens the page
// or brings a scrollbar; it is placed before its first frame. A panel that is open while the page
// scrolls goes with what opened it (a menu closes instead: menu.tsx).
//
// Non-modal: the page keeps its scrollbar and stays usable; Escape and a press outside close it,
// and focus goes back to what opened it. Nothing in it fades or moves in (rule 11).
//
// §5.3 F31: one floating shadow (the burger's 0 6px 24px .5 → the popover shadow). F30: one layer for
// menus and panels (900; the burger's was 200, the reader's panels 220 and 430). The sizes are 1.3's.
import type { ComponentProps, ReactNode } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const FLOATING = 'border border-solid bg-popover text-popover-foreground outline-none';

const panel = cva(FLOATING, {
  variants: {
    variant: {
      panel: 'rounded-8 border-border shadow-popover',
      chapters: 'flex max-h-[min(70vh,560px)] w-[320px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-12 border-border shadow-[0_40px_80px_-20px_rgba(0,0,0,.6),0_4px_12px_rgba(0,0,0,.3)]',
    },
  },
});

type Variant = 'panel' | 'chapters';

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root {...props} />;
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

type Side = 'top' | 'bottom' | 'left' | 'right';
type Align = 'start' | 'center' | 'end';
// The placement every floating panel takes: fixed to the window, 8px inside it (on the other side of
// what opened it when its own side has no room, slid along the window's edge otherwise, as 1.3's
// menus were clamped), on the menu layer.
export const POSITIONER = { positionMethod: 'fixed', collisionPadding: 8, collisionAvoidance: { side: 'flip', align: 'shift' } } as const;

type ContentProps = Omit<PopoverPrimitive.Popup.Props, 'className'> & {
  variant?: Variant;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
  className?: string;
  children?: ReactNode;
};

function PopoverContent({ variant = 'panel', side = 'bottom', align = 'end', sideOffset = 0, alignOffset = 0, className, ...props }: ContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner {...POSITIONER} side={side} align={align} sideOffset={sideOffset} alignOffset={alignOffset} className="z-menu">
        <PopoverPrimitive.Popup data-slot="popover" data-variant={variant} className={cn(panel({ variant }), className)} {...props} />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

// The panel alone, drawn where it stands (the /components page's still specimens).
function PopoverPanel({ variant = 'panel', className, ...props }: ComponentProps<'div'> & { variant?: Variant }) {
  return <div data-slot="popover" data-variant={variant} className={cn(panel({ variant }), className)} {...props} />;
}

// The chapters panel's parts: its heading row (a title, its close), the list that scrolls, a chapter
// (its number bold, its title muted and cut short; the one being read in the brand colour on a 16%
// tint; one not there yet dimmed and off).
function PopoverHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="popover-header" className={cn('flex shrink-0 items-center justify-between pt-[8px] pr-[8px] pb-[4px] pl-[16px] text-14 font-bold', className)} {...props} />;
}

// (The 8px under the list are the panel's, not the list's: what scrolls, and the browser's scrollbar
// with it, ends short of the panel's bottom corners, as a dialog's does: dialog.tsx.)
function PopoverList({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="popover-list" className={cn('scroll-box mb-[8px] min-h-0 px-[8px] pt-[4px]', className)} {...props} />;
}

function PopoverItem({ current, number, className, children, ...props }: ComponentProps<'button'> & { current?: boolean; number: ReactNode }) {
  return (
    <button
      type="button"
      data-slot="popover-item"
      data-current={current ? '' : undefined}
      aria-current={current ? 'true' : undefined}
      className={cn(
        'flex w-full cursor-pointer items-baseline gap-[10px] rounded-8 px-[10px] py-[9px] text-left text-13 text-foreground',
        'hover:bg-secondary disabled:cursor-default disabled:text-muted-dim',
        'data-current:bg-[color-mix(in_srgb,var(--primary)_16%,var(--card))] data-current:text-primary',
        className,
      )}
      {...props}
    >
      <span className="shrink-0 font-bold">{number}</span>
      <span className="min-w-0 truncate text-muted-foreground in-data-current:text-inherit">{children}</span>
    </button>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverPanel, PopoverHeader, PopoverList, PopoverItem };

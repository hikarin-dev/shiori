// Card — a framed surface.
//
//   variant  section  a Settings section: the surface, the plain frame, radius 10; its header
//                     (CardHeader, with CardTitle and CardDescription) ruled off from its rows;
//            row      a row of a list (a task, the import tracker, a chapter): the surface, the plain
//                     frame, radius 8. With `hover` (the overview's chapter rows) its frame turns to
//                     the strong one under the pointer; `data-dragging` lifts it while it is dragged
//                     (the raised ground, the strong frame, the lift shadow);
//            inset    a panel inside a Settings section (a library folder, the study options): the
//                     subtle ground, the plain frame, radius 8;
//            detail   in a dialog, what it applies to (a gallery, a file): the page's ground, 12px on
//                     the dialog's 1.55 line, its padding its own (with a cover: less at the left),
//                     scrolling past 30% of the window's height.
// A card's padding is its contents' (rows, a header, a grid), except the detail's.
//
// §5.3 F10: the chapter row's hover frame #3a3a44 → the strong border. F24: radius 7 → 8 (the
// study options' fieldset, a folder's icon box). Settings' sections narrow at a 480px panel (their
// header's padding 17 20 14 → 14 15 12), measured against the panel: the page names its container
// settings-panel. (Tailwind's @max is "less than": 480.02 stands for "at most 480", the next width a
// layout can hold being 480 + 1/64.)
import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const cardVariants = cva('min-w-0 border border-solid', {
  variants: {
    variant: {
      section: 'w-full rounded-10 border-border bg-card',
      row: 'rounded-8 border-border bg-card',
      inset: 'rounded-8 border-border bg-surface-subtle',
      detail: 'max-h-[30vh] overflow-auto rounded-8 border-border bg-background px-[11px] py-[9px] text-12 leading-[1.55] whitespace-pre-line text-foreground [overflow-wrap:anywhere]',
    },
    hover: {
      // (The frame eases in .12s, the lift in .2s, as the row's did.)
      true: 'transition-[border-color,background-color,box-shadow] ease-standard hover:border-input data-dragging:border-input data-dragging:bg-secondary data-dragging:shadow-lift [transition-duration:120ms,200ms,200ms]',
      false: '',
    },
    cover: { true: 'flex items-center gap-[11px] py-[7px] pr-[11px] pl-[7px]', false: '' },
  },
  defaultVariants: { variant: 'section', hover: false, cover: false },
});

type CardProps = ComponentProps<'div'> & VariantProps<typeof cardVariants>;

function Card({ className, variant, hover, cover, ...props }: CardProps) {
  return <div data-slot="card" data-variant={variant ?? 'section'} className={cn(cardVariants({ variant, hover, cover: variant === 'detail' && cover }), className)} {...props} />;
}

function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="card-header" className={cn(
      'flex min-w-0 flex-wrap items-center gap-[8px] border-0 border-b border-solid border-border px-[20px] pt-[17px] pb-[14px]',
      '@max-[480.02px]/settings-panel:px-[15px] @max-[480.02px]/settings-panel:pt-[14px] @max-[480.02px]/settings-panel:pb-[12px]',
      className)} {...props} />
  );
}

function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p data-slot="card-description" className={cn('mt-[4px] text-11 leading-[1.5] text-muted-foreground', className)} {...props} />;
}

export { Card, CardHeader, CardDescription };

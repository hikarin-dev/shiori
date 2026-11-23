// EmptyState — what a place says when it has nothing to show, or nothing yet.
//
//   variant  page    a page's whole content area (the library with no results, Tasks with nothing
//                    running, the overview not found or still loading): centred, 13px, muted, 80px
//                    above and below; `loose` sets its lines 2× apart (the library's two lines);
//            screen  the whole window (the reader with no such gallery): an icon over the message
//                    (12px, lines 1.8 apart) and its links (11px, the brand colour), 12px apart, on the
//                    reader's ground; fixed over the page;
//            inline  a part of a page (the overview's page grid, the add-chapter results): 12px,
//                    centred; size md (24px above and below) or sm (10px all round); note (page
//                    properties' "loading…" and notes: 10px on a 1.55 line, 8px below what precedes).
// Each keeps its place's size, as today; F23: the overview's 14px → 13.
import type { ComponentProps, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const emptyVariants = cva('text-muted-foreground', {
  variants: {
    variant: {
      page: 'col-span-full px-[20px] py-[80px] text-center text-13',
      screen: 'fixed inset-0 z-page-overlay flex flex-col items-center justify-center gap-[12px] bg-reader-background',
      inline: 'col-span-full text-center text-12',
    },
    size: { md: '', sm: '', note: '' },
    loose: { true: 'leading-[2]', false: '' },
  },
  compoundVariants: [
    { variant: 'inline', size: 'md', class: 'py-[24px]' },
    { variant: 'inline', size: 'sm', class: 'p-[10px]' },
    { variant: 'inline', size: 'note', class: 'mt-[8px] text-left text-10 leading-[1.55]' },
  ],
  defaultVariants: { variant: 'page', loose: false },
});

type Props = Omit<ComponentProps<'div'>, 'children'> & VariantProps<typeof emptyVariants> & {
  icon?: ReactNode;
  links?: ReactNode;
  children?: ReactNode;
};

function EmptyState({ variant = 'page', size, loose, icon, links, className, children, ...props }: Props) {
  const s = variant === 'inline' ? size ?? 'md' : undefined;
  if (variant === 'screen') {
    return (
      <div data-slot="empty-state" data-variant="screen" className={cn(emptyVariants({ variant }), className)} {...props}>
        {icon != null && <div data-slot="empty-icon" aria-hidden className="text-48 text-foreground">{icon}</div>}
        <div data-slot="empty-message" className="text-center text-12 leading-[1.8]">{children}</div>
        {links != null && <div data-slot="empty-links" className="contents text-11 [&_a]:text-primary [&_a]:no-underline">{links}</div>}
      </div>
    );
  }
  return <div data-slot="empty-state" data-variant={variant} className={cn(emptyVariants({ variant, size: s, loose }), className)} {...props}>{children}</div>;
}

export { EmptyState };

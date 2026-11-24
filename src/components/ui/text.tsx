// The text styles: Eyebrow (a small heading in capitals), CardTitle (a Settings section's title) and
// the dialog title's look (DIALOG_TITLE, for the Dialog of a later step).
//
// Eyebrow — over a group of fields, a list's section, a menu's part:
//   size  xs 9 (dialogs' field labels, the keys dialog's sections, reader settings' headings, page
//         properties' sections, the changelog's), sm 10 (the search list's heads, the advanced
//         options' groups), md 11 (the overview's headings over its chapters and pages), lg 12
//         (the overview's add bar);
//   tone  muted, dim (reader settings, the pipeline's step names) or warning (the advanced options'
//         groups, in the second accent).
//   §5.3 F18: one weight (600) and one spacing (.1em) for all thirteen, where today's had three
//   weights and seven spacings: each moves by a pixel of type or half a pixel a letter at most
//   (reader settings' 9.5 → 9). The add bar's keeps its 12px (F18 had made it 11, 2px shorter: the
//   overview's sizes are 1.3's).
// CardTitle — 13px bold, drawn a little tight (−.15px), on a 1.35 line.
// DIALOG_TITLE — §5.3 F28: every dialog's title 15px bold (12, 13, 14 and 20 today).
import type { ComponentProps, ElementType } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const eyebrowVariants = cva('block font-semibold tracking-[.1em] uppercase', {
  variants: {
    size: { xs: 'text-9', sm: 'text-10', md: 'text-11', lg: 'text-12' },
    tone: { muted: 'text-muted-foreground', dim: 'text-muted-dim', warning: 'text-warning' },
  },
  defaultVariants: { size: 'xs', tone: 'muted' },
});

type EyebrowProps = ComponentProps<'div'> & VariantProps<typeof eyebrowVariants> & { as?: 'div' | 'span' | 'h2' | 'h3' | 'h4' | 'label' | 'legend' };

function Eyebrow({ as = 'div', size, tone, className, ...props }: EyebrowProps) {
  const Tag = as as ElementType;
  return <Tag data-slot="eyebrow" className={cn(eyebrowVariants({ size, tone }), className)} {...props} />;
}

function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 data-slot="card-title" className={cn('min-w-0 text-13 leading-[1.35] font-bold tracking-[-.15px] text-foreground', className)} {...props} />;
}

const DIALOG_TITLE = 'text-15 font-bold text-foreground';

export { Eyebrow, CardTitle, DIALOG_TITLE };

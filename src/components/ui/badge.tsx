// Badge — a small label that says what something is or how it stands; it does nothing itself.
//
//   variant  kind     a job's kind (tasks, the import tracker): 9px semibold capitals, framed in its
//                     tone: warning (download, import), primary (translation), neutral (the rest);
//            quiet    the runner tag, the About dialog's version, page properties' table tag: 10px,
//                     the plain frame, the dimmest text;
//            status   a pill saying how something stands (Settings' server and folder status, page
//                     properties' chips): 10px on a tint of its tone, framed in a stronger one;
//                     tones neutral, muted, success, warning, primary;
//            overlay  over a cover: a series card's chapter count (the dark glass, the second accent,
//                     11px semibold), 22px;
//            page     over a page tile: its number (white on black at .62), 14px;
//            inverse  the text colour as its ground (the benchmark's tier): 10px bold, 16px.
//   size     xs 16 (kind and quiet: the tasks' rows, a table's line) or sm 20 (status, and the quiet
//            version tag: Settings' and the dialogs' badges, one size).
// What lies over a picture lets the pointer through to it, as today. (The runner tag, which has a tip,
// takes the arrow: its caller's cursor-default.)
//
// §5.3 F20: the runner tag 17 → 16, level with the kind beside it; the version tag loses its ground
// and takes the dimmest text, 9.5 → 10px; the table tag 9 → 10px, radius 3 → 4, the quiet 16px; the
// status pills one weight (400), their tints 8% and 28% of the tone (7%/26%, and page properties'
// frames mixed 45-50% with no ground); the inverse badge one line, 16px. Settings' and the dialogs'
// badges take one size (the owner's: uniform sizes there, shadcn's badge, h-5, the tiebreak): the
// status pills 21.9 and 19 → 20, the version tag 20.3 → 20. Elsewhere each keeps its own.
import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';


const badgeVariants = cva('inline-flex items-center border border-solid whitespace-nowrap', {
  variants: {
    variant: {
      kind: 'shrink-0 rounded-4 bg-transparent px-[6px] text-9 font-semibold tracking-[.5px] uppercase',
      quiet: 'shrink-0 rounded-4 border-border bg-transparent px-[6px] text-10 font-normal text-muted-dim',
      status: 'min-w-0 gap-[5px] rounded-pill px-[8px] text-10 font-normal whitespace-normal [overflow-wrap:anywhere]',
      overlay: 'pointer-events-none rounded-pill border-border bg-overlay-ground px-[9px] py-[3px] text-11 leading-normal font-semibold tracking-[.2px] text-warning',
      // (White: the brand's foreground is white.)
      page: 'pointer-events-none rounded-4 border-0 bg-overlay-black px-[5px] py-[2px] text-10 leading-none text-primary-foreground tabular-nums',
      inverse: 'rounded-3 border-0 bg-foreground px-[5px] text-10 leading-[16px] font-bold text-background',
    },
    tone: { neutral: '', muted: '', success: '', warning: '', primary: '' },
    size: { xs: 'py-[1px] leading-[12px]', sm: 'py-[3px] leading-[12px]', none: '' },
  },
  compoundVariants: [
    { variant: 'kind', tone: 'neutral', class: 'border-input text-muted-foreground' },
    { variant: 'kind', tone: 'warning', class: 'border-warning-line text-warning' },
    { variant: 'kind', tone: 'primary', class: 'border-primary-line text-primary' },
    { variant: 'status', tone: 'neutral', class: 'border-input bg-transparent text-foreground' },
    { variant: 'status', tone: 'muted', class: 'border-border bg-transparent text-muted-foreground' },
    // A toned pill: its text, a ground of 8% of the tone and a frame of 28%.
    { variant: 'status', tone: 'success', class: 'border-[color-mix(in_srgb,var(--success)_28%,transparent)] bg-success-tint text-success' },
    { variant: 'status', tone: 'warning', class: 'border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-warning-tint text-warning' },
    { variant: 'status', tone: 'primary', class: 'border-[color-mix(in_srgb,var(--primary)_28%,transparent)] bg-primary-tint text-primary' },
  ],
  defaultVariants: { variant: 'quiet' },
});

type Props = ComponentProps<'span'> & Omit<VariantProps<typeof badgeVariants>, 'size'> & { size?: 'xs' | 'sm' };

function Badge({ className, variant = 'quiet', tone, size, ...props }: Props) {
  const t = tone ?? (variant === 'kind' || variant === 'status' ? 'neutral' : undefined);
  // kind and quiet are xs unless told; status is sm; the others are the size of their place.
  const s = variant === 'status' ? 'sm' : variant === 'kind' || variant === 'quiet' ? size ?? 'xs' : 'none';
  return <span data-slot="badge" data-variant={variant} data-size={s} className={cn(badgeVariants({ variant, tone: t, size: s }), className)} {...props} />;
}

export { Badge };

// Kbd — a key cap: a shortcut written as the key it is (the keys dialog, a menu item's shortcut,
// reader settings' choices).
//
//   variant  default (the keys dialog, menus: the page's ground, the plain frame, the text colour)
//            or outline (reader settings: no ground, the strong frame, muted, semibold);
//   size     default 19 (10px) or sm 15 (9px, a 13px line), the outline's.
//
// §5.3 F32: a menu's shortcut takes the keys dialog's cap (+2px tall, radius 3 → 4, the text colour
// where it was muted). F21: reader settings' 8.5px → 9px. A <kbd> is set in the UI font: the
// browser's own is monospace of another family. Where a cap sits (a choice's corner, after a label)
// is its caller's.
import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const kbdVariants = cva('border border-solid font-sans whitespace-nowrap', {
  variants: {
    variant: {
      default: 'border-border bg-background text-foreground',
      outline: 'border-input bg-transparent font-semibold text-muted-foreground',
    },
    size: {
      default: 'rounded-4 px-[6px] py-[2px] text-10',
      sm: 'rounded-3 px-[3px] py-0 text-9 leading-[13px]',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

type Props = ComponentProps<'kbd'> & VariantProps<typeof kbdVariants>;

function Kbd({ className, variant, size, ...props }: Props) {
  const s = size ?? (variant === 'outline' ? 'sm' : 'default');
  return <kbd data-slot="kbd" className={cn(kbdVariants({ variant, size: s }), className)} {...props} />;
}

export { Kbd };

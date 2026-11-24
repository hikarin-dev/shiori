// Kbd — a key cap: a shortcut written as the key it is (the keys dialog, a menu item's shortcut,
// reader settings' choices).
//
//   variant  default (the keys dialog, menus: the page's ground, the plain frame, the text colour)
//            or outline (reader settings: no ground, the strong frame, muted, semibold);
//   size     default 20 (10px: the keys dialog's), sm 16 (9px: the outline's), menu (10px, 1px
//            above and below: a menu item's, set in its line).
//
// §5.3 S14: the keys dialog's cap 19 → 20, reader settings' 15 → 16 (shadcn's cap is 20). F32: a
// menu's shortcut takes the keys dialog's radius 4 (3 before) and the text colour where it was
// muted; its size stays 1.3's (17 tall in its line). F21: reader settings' 8.5px → 9px. A <kbd> is
// set in the UI font: the browser's own is monospace of another family. Where a cap sits (a choice's
// corner, after a label) is its caller's.
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
      default: 'rounded-4 px-[6px] py-[2px] text-10 leading-[14px]',
      sm: 'rounded-3 px-[3px] py-0 text-9 leading-[14px]',
      menu: 'rounded-4 px-[5px] py-[1px] text-10',
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

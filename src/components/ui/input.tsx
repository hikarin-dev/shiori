// Input — a one-line text box, on Base UI's input.
//
//   field   Settings' boxes: the subtle ground, the strong frame, the hover frame under the pointer.
//   inset   in a dialog or on a page (the tag editor, the prompt, the add-chapter search): the page's
//           ground, the plain frame.
//   size    default 36 (Settings' and the dialogs') · xl 40 (the add-chapter search's).
// One focused look for all (focus.ts, §5.3 F13).
//
// §5.3 S01, S06, S07, S12: Settings' boxes 38 → 36, the dialogs' 34 → 36, the prompt's 39.4 → 36
// with the inset look (its own strong-framed 12.5px look is gone). One side padding and line for
// both, 10px (the dialogs' and shadcn's; Settings' was 11) on a 1.4 line (Settings'; shadcn's is
// 1.43, the dialogs' was the normal line).
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { FOCUS_BOX } from './focus';

export const inputVariants = cva(
  `w-full min-w-0 rounded-6 border border-solid text-foreground transition-[background-color,border-color,box-shadow] duration-fast ease-standard disabled:cursor-default disabled:opacity-60 ${FOCUS_BOX}`,
  {
    variants: {
      variant: {
        field: 'border-input bg-surface-subtle hover:not-focus-visible:border-border-hover',
        inset: 'border-border bg-background',
      },
      size: {
        default: 'min-h-[36px] px-[10px] py-[8px] text-12 leading-[1.4]',
        xl: 'h-[40px] px-[12px] text-12',
      },
    },
  },
);

type Props = Omit<InputPrimitive.Props, 'size'> & { variant?: 'field' | 'inset'; size?: 'default' | 'xl' };

function Input({ className, variant = 'field', size = 'default', ...props }: Props) {
  return <InputPrimitive data-slot="input" className={cn(inputVariants({ variant, size }), typeof className === 'string' ? className : undefined)} {...props} />;
}

export { Input };

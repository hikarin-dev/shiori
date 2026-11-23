// Input — a one-line text box, on Base UI's input.
//
//   field   Settings' boxes: the subtle ground, the strong frame, the hover frame under the pointer.
//   inset   in a dialog or on a page (the tag editor, the add-chapter search): the page's ground, the
//           plain frame.
//   dialog  the prompt dialog's box: the page's ground, the strong frame, 12.5px as its dialog.
//   size    default 34 · lg 38 · xl 40 (the dialog's and the add-chapter search's).
// One focused look for all (focus.ts, §5.3 F13).
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
        dialog: 'border-input bg-background',
      },
      size: {
        default: 'min-h-[34px] px-[10px] py-[8px] text-12',
        lg: 'min-h-[38px] px-[11px] py-[8px] text-12 leading-[1.4]',
        xl: 'h-[40px] px-[12px] text-12',
      },
    },
    compoundVariants: [
      // The prompt's box: 40 (F15: 39.4 before), its dialog's 12.5px type, 9px and 11px in.
      { variant: 'dialog', size: 'xl', class: 'px-[11px] py-[9px] text-12.5 leading-[20px]' },
    ],
  },
);

type Props = Omit<InputPrimitive.Props, 'size'> & { variant?: 'field' | 'inset' | 'dialog'; size?: 'default' | 'lg' | 'xl' };

function Input({ className, variant = 'field', size, ...props }: Props) {
  const s = size ?? (variant === 'field' ? 'lg' : variant === 'dialog' ? 'xl' : 'default');
  return <InputPrimitive data-slot="input" className={cn(inputVariants({ variant, size: s }), typeof className === 'string' ? className : undefined)} {...props} />;
}

export { Input };

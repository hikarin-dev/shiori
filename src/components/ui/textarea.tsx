// Textarea — a text box of several lines, grown by its grip (vertically only).
//
//   field  Settings' advanced options: as Input's field, at least 82px, 11px type.
//   inset  the reader's feedback note: the page's ground, the strong frame, 12px.
// One focused look for all (focus.ts, §5.3 F13: the feedback note had only the browser's ring).
// §5.3 S12: the feedback note's 13px → 12, a dialog's field's text. Both take the fields' one side
// padding, 10px (11 and 8 before), 8px above and below; each keeps its line.
import type { ComponentProps } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { FOCUS_BOX } from './focus';

const textareaVariants = cva(
  `block w-full min-w-0 resize-y rounded-6 border border-solid px-[10px] py-[8px] text-foreground transition-[background-color,border-color,box-shadow] duration-fast ease-standard disabled:cursor-default disabled:opacity-60 ${FOCUS_BOX}`,
  {
    variants: {
      variant: {
        field: 'min-h-[82px] border-input bg-surface-subtle text-11 leading-[1.5] hover:not-focus-visible:border-border-hover',
        inset: 'border-input bg-background text-12',
      },
    },
  },
);

function Textarea({ className, variant = 'field', rows = 3, ...props }: ComponentProps<'textarea'> & { variant?: 'field' | 'inset' }) {
  return <textarea data-slot="textarea" rows={rows} className={cn(textareaVariants({ variant }), className)} {...props} />;
}

export { Textarea };

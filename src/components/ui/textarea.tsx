// Textarea — a text box of several lines, grown by its grip (vertically only).
//
//   field  Settings' advanced options: as Input's field, at least 82px, 11px type.
//   inset  the reader's feedback note: the page's ground, the strong frame, 13px.
// One focused look for all (focus.ts, §5.3 F13: the feedback note had only the browser's ring).
import type { ComponentProps } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { FOCUS_BOX } from './focus';

const textareaVariants = cva(
  `block w-full min-w-0 resize-y rounded-6 border border-solid text-foreground transition-[background-color,border-color,box-shadow] duration-fast ease-standard disabled:cursor-default disabled:opacity-60 ${FOCUS_BOX}`,
  {
    variants: {
      variant: {
        field: 'min-h-[82px] border-input bg-surface-subtle px-[11px] py-[8px] text-11 leading-[1.5] hover:not-focus-visible:border-border-hover',
        inset: 'border-input bg-background p-[8px] text-13',
      },
    },
  },
);

function Textarea({ className, variant = 'field', rows = 3, ...props }: ComponentProps<'textarea'> & { variant?: 'field' | 'inset' }) {
  return <textarea data-slot="textarea" rows={rows} className={cn(textareaVariants({ variant }), className)} {...props} />;
}

export { Textarea };

// Checkbox — a tick box (the export choice, feedback issues, advanced translation options, benchmark
// picks), drawn by the app as Chromium draws its own on the dark theme: 13px, a grey frame on a dark
// ground, 2px corners; ticked, filled with the brand colour and a white tick. The same in every
// browser (§5.3 A1, F11: Firefox drew 14px boxes, white outside Settings; the feedback dialog's ticks
// were the browser's blue). Its keyboard ring is the document's one ring.
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from '@/lib/utils';

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'relative inline-flex size-[13px] shrink-0 cursor-default items-center justify-center rounded-2 border border-solid border-check-border bg-check-ground text-primary-foreground',
        'data-checked:border-primary data-checked:bg-primary',
        'data-disabled:opacity-50',
        typeof className === 'string' ? className : undefined,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="absolute inset-[-1px] flex">
        {/* Chromium's tick, on the 13px box. */}
        <svg viewBox="0 0 13 13" className="size-[13px]" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="2.9,6.9 5.1,9.1 10,3.6" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };

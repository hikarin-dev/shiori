// InfoTip — the small "i" beside a setting's name: its explanation shows under the pointer, drawn by
// the kept tooltip.js (T10: it reads data-tip). 13px, 6px after the name, set 2px down to sit on its
// line, muted until hovered or focused, the help cursor.
//
// It is a button the keyboard reaches and a screen reader reads: its name is the explanation itself
// (as 1.3's aria-label). Better than 1.3's: it shows the document's keyboard ring where 1.3's showed
// focus by its colour alone (inventory O9). The tip itself shows under the pointer only, as today:
// tooltip.js does not follow keyboard focus.
import type { ComponentProps } from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = Omit<ComponentProps<'button'>, 'children'> & { tip: string };

function InfoTip({ tip, className, ...props }: Props) {
  return (
    <button
      type="button"
      data-slot="info-tip"
      data-tip={tip}
      aria-label={tip}
      className={cn('ml-[6px] inline-flex cursor-help align-[-2px] text-muted-foreground hover:text-foreground focus-visible:text-foreground', className)}
      {...props}
    >
      <Info aria-hidden strokeWidth={2} className="size-[13px]" />
    </button>
  );
}

export { InfoTip };

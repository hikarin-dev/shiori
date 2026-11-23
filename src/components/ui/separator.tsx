// Separator — the line between groups inside a list or a menu (the search suggestions' groups, a
// folder menu's line before what deletes): 1px of the border colour, held off the frame's edges.
// Every other line of the app is a border of its container and stays one.
//
// §5.3 F30: one separator. Today the search list's stood 6px 4px off its neighbours and the folder
// menu's 4px 2px; both take the list's.
//
// In a menu it is a separator to a screen reader; inside a listbox, where ARIA allows only options
// and groups, it is `decorative` (presentation), as the search list's was.
import { Separator as SeparatorPrimitive } from '@base-ui/react/separator';
import { cn } from '@/lib/utils';

type Props = SeparatorPrimitive.Props & { decorative?: boolean };

function Separator({ className, decorative, ...props }: Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      className={cn('mx-[4px] my-[6px] h-px shrink-0 bg-border', typeof className === 'string' ? className : undefined)}
      {...(decorative ? { role: 'presentation', 'aria-orientation': undefined } : {})}
      {...props}
    />
  );
}

export { Separator };

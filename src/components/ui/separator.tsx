// Separator — the line between groups inside a list or a menu (the search suggestions' groups, a
// folder menu's line before what deletes): 1px of the border colour, held off the frame's edges.
// Every other line of the app is a border of its container and stays one.
//
//   spacing  list (the search list's: 6px above and below, 4px in) or menu (a menu's: 4px and 2px).
//
// §5.3 F30: one separator, one colour; each keeps its spacing (the folder menu's had been merged
// into the list's: put back, the menus' sizes being 1.3's).
//
// In a menu it is a separator to a screen reader; inside a listbox, where ARIA allows only options
// and groups, it is `decorative` (presentation), as the search list's was.
import { Separator as SeparatorPrimitive } from '@base-ui/react/separator';
import { cn } from '@/lib/utils';

type Props = SeparatorPrimitive.Props & { decorative?: boolean; spacing?: 'list' | 'menu' };

const SPACING = { list: 'mx-[4px] my-[6px]', menu: 'mx-[2px] my-[4px]' };

function Separator({ className, decorative, spacing = 'list', ...props }: Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      className={cn('h-px shrink-0 bg-border', SPACING[spacing], typeof className === 'string' ? className : undefined)}
      {...(decorative ? { role: 'presentation', 'aria-orientation': undefined } : {})}
      {...props}
    />
  );
}

export { Separator };

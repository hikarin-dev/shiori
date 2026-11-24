// NumberField — a number stepped by two buttons either side of it (reader settings' zoom), on Base
// UI's number field, drawn on the segmented track: 30px buttons (−, +) with the raised surface under
// the pointer, the value between them in 11.5px semibold figures. The value is shown, not typed in,
// as today; its buttons stay in the Tab order as today's were (Base UI would leave them out), and
// the arrow keys step the value while it has focus, Page Up and Down by a larger step, Home and
// End to the ends; focused so, the track takes the document's keyboard ring. A button is off at
// its end. §5.3 S13: a button's icon alone 16 (15 before).
import { NumberField as NumberFieldPrimitive } from '@base-ui/react/number-field';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = Omit<NumberFieldPrimitive.Root.Props, 'children' | 'className'> & {
  className?: string;
  'aria-label'?: string;
  decrementLabel: string;
  incrementLabel: string;
  // (/components shows a button's state still through data-force: it is the − button's.)
  'data-force'?: string;
};

const STEP = 'grid h-[28px] cursor-pointer place-items-center rounded-5 border-0 bg-transparent p-0 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:cursor-default disabled:opacity-35 [&_svg]:size-[16px]';

function NumberField({ className, 'aria-label': label, decrementLabel, incrementLabel, 'data-force': force, ...props }: Props) {
  return (
    <NumberFieldPrimitive.Root data-slot="number-field" className={cn('inline-block shrink-0', className)} {...props}>
      <NumberFieldPrimitive.Group data-slot="number-field-group" className="grid grid-cols-[30px_54px_30px] items-center rounded-8 border border-solid border-input bg-surface-subtle p-[3px]">
        <NumberFieldPrimitive.Decrement aria-label={decrementLabel} data-force={force} tabIndex={0} className={STEP}><Minus /></NumberFieldPrimitive.Decrement>
        <NumberFieldPrimitive.Input
          aria-label={label}
          readOnly
          className="w-full min-w-0 cursor-default border-0 bg-transparent p-0 text-center text-11.5 font-semibold text-foreground tabular-nums outline-none"
        />
        <NumberFieldPrimitive.Increment aria-label={incrementLabel} tabIndex={0} className={STEP}><Plus /></NumberFieldPrimitive.Increment>
      </NumberFieldPrimitive.Group>
    </NumberFieldPrimitive.Root>
  );
}

export { NumberField };

// Slider — a value along a line (reader settings: page gap, dim pages, auto-scroll speed), on Base
// UI's slider: a 4px track in the strong border's colour, filled in the brand colour up to the value,
// and a 14px white knob with the switch's shadow, 16px tall in all; the arrows, Page Up and Down,
// Home and End move it. The knob stays inside the track's ends, as the browser's own range did.
// Its keyboard ring is the document's one ring, on the knob.
import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { cn } from '@/lib/utils';

type Props = Omit<SliderPrimitive.Root.Props<number>, 'children'> & { 'aria-label'?: string; 'aria-labelledby'?: string; 'data-force'?: string };

// (data-force, which /components uses to show a state still, is the knob's: its states are.)
function Slider({ className, 'aria-label': label, 'aria-labelledby': labelledBy, 'data-force': force, ...props }: Props) {
  return (
    <SliderPrimitive.Root data-slot="slider" thumbAlignment="edge" className={cn('relative w-full touch-none select-none data-disabled:opacity-50', typeof className === 'string' ? className : undefined)} {...props}>
      <SliderPrimitive.Control data-slot="slider-control" className="relative flex h-[16px] w-full cursor-pointer items-center data-disabled:cursor-default">
        <SliderPrimitive.Track data-slot="slider-track" className="relative h-[4px] w-full rounded-pill bg-input">
          <SliderPrimitive.Indicator data-slot="slider-fill" className="h-full rounded-pill bg-primary" />
          <SliderPrimitive.Thumb data-slot="slider-thumb" data-force={force} getAriaLabel={label ? () => label : undefined} aria-labelledby={labelledBy} className="size-[14px] rounded-circle bg-primary-foreground shadow-knob" />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };

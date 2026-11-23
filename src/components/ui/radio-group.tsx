// RadioGroup — one choice of a few (the export format), each radio drawn by the app as Chromium draws
// its own on the dark theme: a 13px circle, a grey frame on a dark ground; chosen, the brand colour
// with a white ring around its middle. The same in every browser (§5.3 A1, F11). Arrow keys move the
// choice within the group; its keyboard ring is the document's one ring.
import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { cn } from '@/lib/utils';

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return <RadioGroupPrimitive data-slot="radio-group" className={cn('grid', typeof className === 'string' ? className : undefined)} {...props} />;
}

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        'relative inline-flex size-[13px] shrink-0 cursor-default rounded-circle border border-solid border-check-border bg-check-ground',
        'data-checked:border-primary data-checked:bg-primary',
        'data-disabled:opacity-50',
        typeof className === 'string' ? className : undefined,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator data-slot="radio-group-indicator" className="absolute inset-0 rounded-circle border-[1.5px] border-solid border-primary-foreground" />
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };

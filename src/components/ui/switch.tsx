// Switch — an on/off setting (Settings, reader settings, the desktop panel, a few dialogs): a 36×20
// track with a 14px knob that slides 16px, as base.css drew .switch-control: by its `left`, not by a
// transform (rule 29: an animated transform lifts what is painted after it onto layers, and the text
// there changed its look while a knob slid). Its keyboard ring is the document's one ring, on the
// track (a role="switch" element). Under a finger it takes a press 44px square around it.
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from '@/lib/utils';

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'relative inline-flex h-[20px] w-[36px] shrink-0 cursor-pointer rounded-pill border border-solid border-switch-track-border bg-switch-track',
        'transition-[background-color,border-color] duration-base ease-standard',
        'data-checked:border-primary data-checked:bg-primary',
        'data-disabled:cursor-not-allowed data-disabled:opacity-50',
        // Under a finger, a press 44px square around the track (an area of its own, nothing drawn: past
        // its 34×18 padding box 5px a side and 13 above and below).
        'pointer-coarse:after:absolute pointer-coarse:after:-inset-x-[5px] pointer-coarse:after:-inset-y-[13px]',
        typeof className === 'string' ? className : undefined,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none absolute top-[2px] left-[2px] size-[14px] rounded-circle bg-switch-knob shadow-knob',
          'transition-[background-color,left] duration-base ease-standard',
          'data-checked:left-[18px] data-checked:bg-primary-foreground',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };

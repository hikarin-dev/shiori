// InputGroup — a text box with a button joined to its end (Settings' server address and its "Check
// connection"): the box's end corners squared, the button in the box's frame and ground with no
// border between them. The button is muted until hovered; busy (aria-busy), its icon turns, as a
// Spinner. The box takes the room as wide as it can be and both give some back (flex 1 1 auto
// against the button's 0 1 auto), as today's pair did: the button comes out a little narrower than
// its padding asks. §5.3 S01, S13: the pair is 36 tall (38 before), the button's icon 16 (14).
import type { ComponentProps } from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cn } from '@/lib/utils';
import { Input } from './input';
import { Spinner } from './spinner';

function InputGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="input-group" role="group" className={cn('relative flex min-w-0', className)} {...props} />;
}

function InputGroupInput({ className, ...props }: ComponentProps<typeof Input>) {
  return <Input className={cn('flex-auto rounded-r-none', typeof className === 'string' ? className : undefined)} {...props} />;
}

function InputGroupButton({ className, children, ...props }: ButtonPrimitive.Props) {
  const busy = props['aria-busy'] === true || props['aria-busy'] === 'true';
  return (
    <ButtonPrimitive
      data-slot="input-group-button"
      className={cn(
        'inline-flex min-h-[36px] min-w-0 cursor-pointer items-center justify-start rounded-r-6 border border-l-0 border-solid border-input bg-surface-subtle px-[12px] text-11 text-muted-foreground',
        'transition-[color] duration-fast ease-standard hover:text-foreground disabled:cursor-default disabled:opacity-60',
        '[&_svg]:size-[16px] [&_svg]:shrink-0',
        typeof className === 'string' ? className : undefined,
      )}
      {...props}
    >
      {busy ? <Spinner>{children}</Spinner> : children}
    </ButtonPrimitive>
  );
}

export { InputGroup, InputGroupInput, InputGroupButton };

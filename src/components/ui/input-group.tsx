// InputGroup — a text box with a button joined to its end (Settings' server address and its "Check
// connection"): the box's end corners squared, the button in the box's frame and ground with no
// border between them. The button is muted until hovered; busy, its icon turns. The box takes the
// room as wide as it can be and both give some back (flex 1 1 auto against the button's 0 1 auto), as
// today's pair did: the button comes out a little narrower than its padding asks.
import type { ComponentProps } from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cn } from '@/lib/utils';
import { Input } from './input';

function InputGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="input-group" role="group" className={cn('relative flex min-w-0', className)} {...props} />;
}

function InputGroupInput({ className, ...props }: ComponentProps<typeof Input>) {
  return <Input className={cn('flex-auto rounded-r-none', typeof className === 'string' ? className : undefined)} {...props} />;
}

function InputGroupButton({ className, ...props }: ButtonPrimitive.Props) {
  return (
    <ButtonPrimitive
      data-slot="input-group-button"
      className={cn(
        'inline-flex min-h-[38px] min-w-0 cursor-pointer items-center justify-start rounded-r-6 border border-l-0 border-solid border-input bg-surface-subtle px-[12px] text-11 text-muted-foreground',
        'transition-[color] duration-fast ease-standard hover:text-foreground disabled:cursor-default disabled:opacity-60',
        '[&_svg]:size-[14px] [&_svg]:shrink-0 aria-busy:[&_svg]:animate-[spin_.8s_linear_infinite]',
        typeof className === 'string' ? className : undefined,
      )}
      {...props}
    />
  );
}

export { InputGroup, InputGroupInput, InputGroupButton };

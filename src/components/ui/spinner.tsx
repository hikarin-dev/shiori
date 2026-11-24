// Spinner — working, no figure to show: a ring whose brand-coloured arc turns, or an icon turning.
//
//   size   lg 32 (the reader's loading screen, a page not stored yet: a 3px ring) or sm 13 (the
//          reader's status line: a 2px ring);
//   an icon given as its child turns instead, in the colour around it (as Settings' server check's
//          joined button's turns, §5.3 S13: 16px; 14 before).
//
// One turn in .8s, at an even pace; with less motion asked for, it stands still. A spinner beside
// words that say what is happening is decoration (hidden from a screen reader); on its own, give it
// a `label`: it is then a status with that name.
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Props = Omit<ComponentProps<'span'>, 'children'> & {
  size?: 'lg' | 'sm';
  label?: string;
  children?: ReactNode;
};

const SPIN = 'animate-[spin_.8s_linear_infinite]';

function Spinner({ size = 'lg', label, className, children, ...props }: Props) {
  const a11y = label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true };
  if (children) {
    return <span data-slot="spinner" data-variant="icon" className={cn('inline-flex shrink-0 [&_svg]:size-[16px]', SPIN, className)} {...a11y} {...props}>{children}</span>;
  }
  return (
    <span
      data-slot="spinner"
      data-variant="ring"
      className={cn(
        'inline-block shrink-0 rounded-circle border-solid border-border border-t-primary', SPIN,
        size === 'lg' ? 'size-[32px] border-[3px]' : 'size-[13px] border-[2px]',
        className,
      )}
      {...a11y}
      {...props}
    />
  );
}

export { Spinner };

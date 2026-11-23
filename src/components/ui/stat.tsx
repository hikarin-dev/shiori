// Stat — a figure shown for reading, framed.
//
//   variant  header  a page header's total (the library's galleries, images and storage; Tasks'
//                    running jobs): the figure in the brand colour over its name in tiny capitals,
//                    on the page's ground in the plain frame, 38px;
//            inline  a figure on its own in a Settings row (the total disk writes): 16px bold
//                    figures on the subtle ground in the strong frame.
// Two looks for two places, as today. The figures are tabular in the row, where they change in place.
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Props = Omit<ComponentProps<'div'>, 'children'> & { value: ReactNode } & (
  | { variant?: 'header'; label: ReactNode }
  | { variant: 'inline'; label?: undefined }
);

function Stat({ variant = 'header', value, label, className, ...props }: Props) {
  if (variant === 'inline') {
    return (
      <span data-slot="stat" data-variant="inline" className={cn(
        'inline-flex min-w-0 items-baseline justify-center rounded-6 border border-solid border-input bg-surface-subtle px-[10px] py-[6px] text-16 leading-[1.2] font-bold whitespace-nowrap text-foreground tabular-nums',
        className)} {...props}>{value}</span>
    );
  }
  return (
    <div data-slot="stat" data-variant="header" className={cn('rounded-6 border border-solid border-border bg-background px-[10px] py-[5px] text-center', className)} {...props}>
      <div data-slot="stat-value" className="text-14 leading-none font-bold text-primary">{value}</div>
      <div data-slot="stat-label" className="mt-[2px] text-8 text-muted-foreground uppercase">{label}</div>
    </div>
  );
}

export { Stat };

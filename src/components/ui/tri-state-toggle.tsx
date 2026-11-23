// TriStateToggle — a filter option with three states: any (it doesn't filter), show only, hide. A
// press moves it on: any → show only → hide → any. The library's filter dialog's .fopt: a 14px mark
// (✓ on success, ✕ on danger) before the name, which is struck through while hidden. It keeps
// data-state (off | include | exclude), which the page and its tests read.
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type TriState = 'off' | 'include' | 'exclude';
const NEXT: Record<TriState, TriState> = { off: 'include', include: 'exclude', exclude: 'off' };
const SAYS: Record<TriState, string> = { off: 'filter.any', include: 'filter.include', exclude: 'filter.exclude' };

type Props = Omit<ButtonPrimitive.Props, 'value' | 'onChange'> & {
  value: TriState;
  onValueChange?: (next: TriState) => void;
  // The option's name, shown and read out with its state.
  label: string;
};

function TriStateToggle({ value, onValueChange, label, className, onClick, ...props }: Props) {
  const t = useT();
  return (
    <ButtonPrimitive
      data-slot="tri-state-toggle"
      data-state={value}
      aria-label={`${label}: ${t(SAYS[value])}`}
      onClick={(e) => { onClick?.(e); if (!e.defaultPrevented) onValueChange?.(NEXT[value]); }}
      className={cn(
        'group/tri flex min-w-0 cursor-pointer items-center gap-[8px] rounded-6 border border-solid border-border bg-background px-[10px] py-[8px] text-left text-12 text-muted-foreground',
        'transition-[color,background-color,border-color] duration-fast ease-standard',
        'hover:border-muted-foreground hover:text-foreground',  // a set option keeps its tone's frame under the pointer (below)
        'data-[state=include]:border-success data-[state=include]:bg-success-tint data-[state=include]:text-foreground hover:data-[state=include]:border-success',
        'data-[state=exclude]:border-destructive data-[state=exclude]:bg-destructive-tint hover:data-[state=exclude]:border-destructive',
        'disabled:cursor-default disabled:opacity-50',
        typeof className === 'string' ? className : undefined,
      )}
      {...props}
    >
      <span
        aria-hidden
        data-slot="tri-state-mark"
        className={cn(
          'inline-flex size-[14px] shrink-0 items-center justify-center rounded-3 border border-solid border-border text-10 leading-none font-bold',
          'group-data-[state=include]/tri:border-success group-data-[state=include]/tri:bg-success group-data-[state=include]/tri:text-background',
          'group-data-[state=exclude]/tri:border-destructive group-data-[state=exclude]/tri:bg-destructive group-data-[state=exclude]/tri:text-destructive-foreground',
        )}
      >
        {value === 'include' ? '✓' : value === 'exclude' ? '✕' : null}
      </span>
      <span className="truncate group-data-[state=exclude]/tri:line-through">{label}</span>
    </ButtonPrimitive>
  );
}

export { TriStateToggle };

// ToggleGroup — one choice of a few, shown as buttons, on Base UI's toggle group (one pressed at a
// time; arrow keys move between them, Space or Enter chooses).
//
//   segmented  the choices in one track, the chosen one on a highlight (Settings' segmented
//              controls, the study mode's icon choices). §5.3 F12 (owner): one highlight, sliding
//              under the labels. It moves by its `left` (layout, not a transform), so no text is
//              lifted onto a compositor layer while it moves (rule 11); `left` is a fraction of the
//              track's width, so a resize moves it with the track and never sets it gliding.
//   cards      separate buttons in equal columns (reader settings' choices); sizes default 36,
//              stack 52 (icon over name), sm 28.
//
// §5.3 S02, S08, S13: Settings' track 40 → 36 with its segments 32 → 28, as reader settings' tabs (a
// 36 track holds 28 segments); one segment for both, 9px in at the sides on a 1.35 line (Settings',
// the commoner: the tabs' were 8px on the normal line). Reader settings' choice cards 34 → 36 (the
// small ones stay 28, the stacked ones 52). An icon beside a label 14 (16 and 15 before).
//   pill       round filter pills (the import tracker's title filters), 24, a finger's 36.
import { Children, createContext, isValidElement, useContext, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { ToggleGroup as ToggleGroupPrimitive } from '@base-ui/react/toggle-group';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

type Variant = 'segmented' | 'cards' | 'pill';
type Size = 'default' | 'sm' | 'stack';   // (segmented and pill have the one size, default)

// The segmented track and its highlight, shared with Tabs' segmented list (one recipe, F12). The
// track gives each item an equal column; the group sets --seg-n (how many) and --seg-i (which one
// is chosen) on it.
export const SEGMENTED_TRACK = 'grid auto-cols-[minmax(0,1fr)] grid-flow-col gap-[3px] rounded-8 border border-solid border-input bg-surface-subtle p-[3px]';
export const SEGMENTED_HIGHLIGHT = cn(
  'pointer-events-none absolute top-[3px] bottom-[3px] rounded-5 border border-solid border-input bg-secondary',
  'left-[calc(3px+var(--seg-i)*((100%-6px-(var(--seg-n)-1)*3px)/var(--seg-n)+3px))] w-[calc((100%-6px-(var(--seg-n)-1)*3px)/var(--seg-n))]',
  // F12 (owner): it slides. Today's jump would be this line taken out.
  'transition-[left] duration-open ease-standard',
);
// An item over the highlight: the chosen one only changes its text colour (the highlight is its ground).
export const SEGMENTED_ITEM = 'z-[1] flex min-h-[28px] items-center justify-center gap-[6px] rounded-5 border-transparent bg-transparent px-[9px] py-[5px] text-11 leading-[1.35] font-semibold hover:text-foreground disabled:cursor-default disabled:opacity-45 has-[svg]:px-[7px] [&_span]:min-w-0 [&_span]:[overflow-wrap:anywhere] [&_svg]:size-[14px]';

const group = cva('relative min-w-0', {
  variants: {
    variant: {
      segmented: SEGMENTED_TRACK,
      cards: 'grid auto-cols-[minmax(0,1fr)] grid-flow-col gap-[8px]',
      pill: 'flex flex-wrap gap-[6px]',
    },
    size: { default: '', sm: '', stack: '' },
  },
  compoundVariants: [{ variant: 'cards', size: 'sm', class: 'flex-none gap-[6px]' }],
});

const item = cva(
  'relative min-w-0 cursor-pointer border border-solid text-muted-foreground transition-[color,background-color,border-color] duration-fast ease-standard [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        segmented: `${SEGMENTED_ITEM} data-pressed:text-foreground`,
        cards: 'flex items-center justify-center gap-[7px] rounded-8 border-border bg-surface-subtle text-11 leading-[1.3] font-semibold hover:not-data-pressed:border-input hover:not-data-pressed:text-foreground data-pressed:border-input data-pressed:bg-secondary data-pressed:text-foreground disabled:cursor-default [&_span]:min-w-0 [&_span]:[overflow-wrap:anywhere]',
        pill: 'inline-flex h-[24px] items-center rounded-pill border-border bg-transparent px-[9px] text-11 tabular-nums hover:border-muted-foreground hover:text-foreground data-pressed:border-muted-foreground data-pressed:bg-secondary data-pressed:text-foreground pointer-coarse:h-[36px]',
      },
      size: { default: '', sm: '', stack: '' },
    },
    compoundVariants: [
      { variant: 'cards', size: 'default', class: 'min-h-[36px] px-[8px] py-[6px] [&_svg]:size-[14px]' },
      { variant: 'cards', size: 'stack', class: 'min-h-[52px] flex-col gap-[5px] px-[4px] py-[7px] text-10.5 leading-[1.3] [&_svg]:size-[17px]' },
      { variant: 'cards', size: 'sm', class: 'min-h-[28px] px-[12px] py-[4px] text-10.5 leading-[1.3]' },
    ],
  },
);

type ItemProps = Omit<TogglePrimitive.Props, 'value'> & { value: string; children?: ReactNode };
type GroupProps = Omit<ToggleGroupPrimitive.Props, 'value' | 'defaultValue' | 'onValueChange' | 'multiple'> & {
  variant?: Variant;
  size?: Size;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
};

const Look = createContext<{ variant: Variant; size: Size }>({ variant: 'segmented', size: 'default' });

function ToggleGroup({ variant = 'segmented', size = 'default', value, defaultValue, onValueChange, className, children, style, ...props }: GroupProps) {
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  // The items, in order, for where the highlight sits.
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<ItemProps>[];
  const at = items.findIndex((el) => el.props.value === current);
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      value={current === undefined ? [] : [current]}
      // One is always chosen: pressing the chosen one again keeps it.
      onValueChange={(next) => { const v = next[0] as string | undefined; if (v === undefined) return; setOwn(v); onValueChange?.(v); }}
      className={cn(group({ variant, size }), typeof className === 'string' ? className : undefined)}
      style={{ ...(variant === 'segmented' ? { '--seg-n': items.length, '--seg-i': Math.max(at, 0) } : {}), ...(style as CSSProperties) } as CSSProperties}
      {...props}
    >
      {variant === 'segmented' && (
        <span
          aria-hidden
          data-slot="toggle-group-highlight"
          hidden={at < 0}
          className={SEGMENTED_HIGHLIGHT}
        />
      )}
      <Look.Provider value={{ variant, size }}>{children}</Look.Provider>
    </ToggleGroupPrimitive>
  );
}

// One choice. Its value names it within the group; its children are its label (and an icon).
function ToggleGroupItem({ className, ...props }: ItemProps) {
  const { variant, size } = useContext(Look);
  return <TogglePrimitive data-slot="toggle-group-item" className={cn(item({ variant, size }), typeof className === 'string' ? className : undefined)} {...props} />;
}

export { ToggleGroup, ToggleGroupItem };

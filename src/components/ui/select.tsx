// Select — a choice from a list, drawn closed as a box with a chevron (Settings' fields, the library's
// sort, the tag editor's type, reader settings' font, the header's page menu).
//
//   variant  field (Settings, reader settings: on the subtle ground, the strong frame), inset (in a
//            dialog: on the page's ground, the plain frame), toolbar (the library's sort, on the
//            surface), ghost (the header's page menu: no frame until hovered).
//   size     default 36 (Settings' and the dialogs' fields) · toolbar 34 (the library's sort) · xs 26
//            (the header's page menu); each variant has its one.
//
// §5.3 S01, S06, S09, S12: Settings' selects 38 → 36, the dialogs' 34 → 36, reader settings' 30 → 36
// with its 11px text → 12; 10px in at the sides on a 1.4 line, as Input (Settings' were 11px in,
// reader settings' pointer the hand: it takes Settings' arrow).
//   width    fill (its place), widest (held at its widest option, so it never jumps between picks:
//            every label sits in one grid cell, the others invisible — CSS, no measuring) or content.
//
// With a pointer it opens the app's list (Base UI's select, drawn as 1.3's Chromium list was:
// dropdown.css): hung straight off the box at the box's width, the two one outline with a faint seam,
// at most eight rows, unrolling from the box, the chevron turned; it opens upward only when just the
// space above can hold it. The same in every browser. On a touch screen it is a native <select>
// drawn closed the same, so the system's picker opens (T15); so it is in a browser without CSS
// anchor positioning, which the drawn list is placed by (T18). Its text keeps clear of the chevron
// drawn over it by its padding: the ghost's 22 is its 6 in, the 5px gap and the 11px chevron, so it
// is as wide as the drawn one, and as wide as its chosen label where the browser can size it so
// (field-sizing; elsewhere its widest), as 1.3's page menu was.
//
// Placement is CSS's (rule 10): the box is an anchor (anchor-name) and the list is placed against it
// with anchor positioning, at the box's bottom edge and width, in the same frame as any scroll or
// resize. Base UI's positioner still wraps the list (its popup needs it) but its computed place is
// overridden. The one decision made in script is which way to open, taken once as it opens, as
// dropdown.js did: a fact the stylesheet reads (data-up).
import { useId, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { ChevronDown } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { FOCUS_BOX } from './focus';

// An option's `title` shows under the pointer (the system's tip, as 1.3's option titles did); a
// disabled one is listed but can't be chosen.
export type SelectOption = { value: string; label: string; className?: string; title?: string; disabled?: boolean };
type Variant = 'field' | 'inset' | 'toolbar' | 'ghost';
type Size = 'default' | 'toolbar' | 'xs';

const ROW = 28;        // an option's row, roughly: only to judge whether the list fits below
const MAX_ROWS = 8;    // the list shows at most this many and scrolls the rest

// The box. Its ground at rest is also the open list's (they read as one).
const GROUND: Record<Variant, string> = { field: 'bg-surface-subtle', inset: 'bg-background', toolbar: 'bg-card', ghost: 'bg-card' };
// The pointer over it, as each had it: Settings' and the dialogs' the arrow, the toolbar's and the
// header's the hand. Its list's options take the same.
const CURSOR: Record<Variant, string> = { field: 'cursor-auto', inset: 'cursor-auto', toolbar: 'cursor-pointer', ghost: 'cursor-pointer' };
const box = cva(
  'inline-flex min-w-0 items-center gap-[8px] rounded-6 border border-solid text-left whitespace-nowrap text-foreground select-none transition-[background-color,border-color,box-shadow] duration-fast ease-standard',
  {
    variants: {
      variant: {
        field: `border-input bg-surface-subtle data-unrolled:bg-surface-subtle ${FOCUS_BOX}`,
        inset: `border-border bg-background data-unrolled:bg-background ${FOCUS_BOX} disabled:opacity-60 data-disabled:opacity-60`,
        toolbar: `border-border bg-card data-unrolled:bg-card ${FOCUS_BOX}`,
        // The header's page menu: the shared keyboard ring, as the header's other controls.
        // (Its word in the text colour, as the header's buttons beside it: §5.3 F60.)
        ghost: 'border-transparent bg-transparent text-foreground data-unrolled:bg-transparent',
      },
      size: {
        default: 'min-h-[36px] px-[10px] py-[8px]',
        toolbar: 'min-h-[34px] px-[12px] py-[8px]',
        xs: 'h-[26px] px-[6px]',
      },
      width: { fill: 'w-full', widest: '', content: '' },
    },
    compoundVariants: [
      { variant: 'ghost', class: 'gap-[5px]' },
    ],
  },
);
// The box's type, which its list shares (the list's eight rows are eight of its lines).
const TEXT: Record<Size, string> = { default: 'text-12 leading-[1.4]', toolbar: 'text-12', xs: 'text-13' };

// Hovered: the raised ground and the hover frame. With its list showing: its resting ground (each
// variant's, above), the hover frame, the corners by the list squared. Focused, its frame is the
// focused one under the pointer too (a hover weighs what focus-visible does and comes before it).
// "Its list showing" is data-unrolled: from the frame the list starts to unroll until the frame it
// has rolled up whole, which is later than data-popup-open's end (that goes as the closing begins).
// Box and list are one outline for exactly as long as there is a list: the corners are not eased
// (rounding them while a strip of the list still hangs there showed its sides past the curve), and
// the box takes the joined look at once, nothing of it eased (a press in the first moments of a hover
// would otherwise show its frame still on its way to the list's): it eases back once the list is gone.
const BOX_STATES = 'hover:bg-secondary hover:border-border-hover data-unrolled:border-border-hover data-unrolled:transition-none';
const OPEN_EDGE: Record<Variant, string> = {
  field: 'data-unrolled:not-data-up:rounded-b-none data-unrolled:data-up:rounded-t-none',
  inset: 'data-unrolled:not-data-up:rounded-b-none data-unrolled:data-up:rounded-t-none',
  toolbar: 'data-unrolled:not-data-up:rounded-b-none data-unrolled:data-up:rounded-t-none',
  ghost: '',   // its list stands 4px off it, with corners of its own
};

// The list's options line up with the box's text: their side padding is the box's.
const INSET: Record<Size, string> = { default: 'px-[10px]', toolbar: 'px-[12px]', xs: 'px-[10px]' };

const coarseQuery = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
const subscribe = (changed: () => void) => { coarseQuery?.addEventListener('change', changed); return () => coarseQuery?.removeEventListener('change', changed); };
const isCoarse = () => !!coarseQuery?.matches;
// Whether the browser places a box by CSS anchor positioning; without it the drawn list has no place.
const ANCHORS = typeof CSS !== 'undefined' && CSS.supports('anchor-name: --a');

type Props = {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  variant?: Variant;
  size?: Size;
  width?: 'fill' | 'widest' | 'content';
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  // The system's picker (true) or the drawn list (false); by default, the system's on a touch screen.
  // A browser without anchor positioning always gets the system's.
  native?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
} & { [data: `data-${string}`]: string | undefined };

function Chevron({ className }: { className?: string }) {
  return <ChevronDown aria-hidden strokeWidth={2} className={cn('turns ml-auto size-[11px] shrink-0 text-muted-dim transition-[--turn,color] duration-open ease-standard', className)} />;
}

// The chosen label, or every label in one cell with only the chosen one showing (width widest).
function Label({ options, value, width }: { options: SelectOption[]; value: string | undefined; width: Props['width'] }) {
  const chosen = options.find((o) => o.value === value);
  if (width !== 'widest') return <span className={cn('min-w-0 truncate', chosen?.className)}>{chosen?.label ?? ''}</span>;
  return (
    <span className="grid min-w-0">
      {options.map((o) => (
        <span key={o.value} aria-hidden={o.value !== value} className={cn('[grid-area:1/1] truncate', o.value !== value && 'invisible', o.className)}>{o.label}</span>
      ))}
    </span>
  );
}

function Select({ options, value, defaultValue, onValueChange, variant = 'field', size, width, disabled, name, id, className, native, ...rest }: Props) {
  const s: Size = size ?? (variant === 'toolbar' ? 'toolbar' : variant === 'ghost' ? 'xs' : 'default');
  const w = width ?? (variant === 'toolbar' ? 'widest' : variant === 'ghost' ? 'content' : 'fill');
  const coarse = useSyncExternalStore(subscribe, isCoarse, () => false);
  const [own, setOwn] = useState(defaultValue ?? options[0]?.value);
  const current = value ?? own;
  const choose = (v: string) => { setOwn(v); onValueChange?.(v); };
  const anchor = `--select-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [up, setUp] = useState(false);
  // Its list showing at all: from the first of it unrolled to the last of it rolled up.
  const [unrolled, setUnrolled] = useState(false);
  const cursor = CURSOR[variant];
  const boxClass = cn(box({ variant, size: s, width: w }), TEXT[s], cursor, cursor === 'cursor-pointer' && 'disabled:cursor-default data-disabled:cursor-default', BOX_STATES, OPEN_EDGE[variant], className);
  const trigger = useRef<HTMLButtonElement>(null);

  if (!ANCHORS || (native ?? coarse)) {
    // The system's picker, over a box drawn as the other's.
    return (
      <span data-slot="select" className={cn('relative inline-grid min-w-0', w === 'fill' && 'w-full')}>
        <select
          id={id} name={name} disabled={disabled} value={current} onChange={(e) => choose(e.target.value)}
          className={cn(boxClass, 'appearance-none [grid-area:1/1]', variant === 'ghost' ? 'pr-[22px] [field-sizing:content]' : 'pr-[30px]')}
          {...rest}
        >
          {options.map((o) => <option key={o.value} value={o.value} className={o.className} title={o.title} disabled={o.disabled}>{o.label}</option>)}
        </select>
        <Chevron className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2', variant === 'ghost' ? 'right-[6px]' : 'right-[11px]')} />
      </span>
    );
  }

  return (
    <SelectPrimitive.Root
      value={current}
      onValueChange={(v) => { if (typeof v === 'string') choose(v); }}
      onOpenChange={(open) => {
        if (!open) return;
        setUnrolled(true);
        // Which way it opens, settled as it opens: down, unless only the space above can hold it.
        if (trigger.current) {
          const r = trigger.current.getBoundingClientRect(), below = innerHeight - r.bottom;
          setUp(variant !== 'ghost' && below < Math.min(options.length, MAX_ROWS) * ROW + 10 && r.top > below);
        }
      }}
      // (The list rolled up whole: only now is the box on its own again.)
      onOpenChangeComplete={(open) => { if (!open) setUnrolled(false); }}
      items={options}
      modal={false}
      disabled={disabled}
      name={name}
    >
      <SelectPrimitive.Trigger
        id={id}
        ref={trigger}
        data-slot="select-trigger"
        data-variant={variant}
        data-up={up ? '' : undefined}
        data-unrolled={unrolled ? '' : undefined}
        style={{ anchorName: anchor } as CSSProperties}
        className={cn(boxClass, '[&[data-popup-open]_svg]:[--turn:1] [&:is(:hover,[data-popup-open])_svg]:text-muted-foreground')}
        {...rest}
      >
        <Label options={options} value={current} width={w} />
        <Chevron />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          alignItemWithTrigger={false}
          data-slot="select-positioner"
          data-up={up ? '' : undefined}
          style={{ positionAnchor: anchor } as CSSProperties}
          className={cn(
            // Placed by CSS against the box, whatever the positioner computed.
            'z-select fixed! inset-auto! m-0! transform-none!',
            variant === 'ghost'
              ? 'top-[calc(anchor(bottom)+4px)]! left-[anchor(left)]! w-max! min-w-[anchor-size(width)]!'
              : up ? 'bottom-[calc(anchor(top)-1px)]! left-[anchor(left)]! w-[anchor-size(width)]!' : 'top-[calc(anchor(bottom)-1px)]! left-[anchor(left)]! w-[anchor-size(width)]!',
          )}
        >
          <SelectPrimitive.Popup
            data-slot="select-list"
            className={cn(
              'box-border max-h-[calc(8*(1lh+12px)+10px)] overflow-y-auto border border-solid border-border-hover py-[4px] text-foreground shadow-popover outline-none',
              GROUND[variant],
              TEXT[s],
              variant === 'ghost' ? 'rounded-6' : up ? 'rounded-t-6 border-b-border' : 'rounded-b-6 border-t-border',
              // It unrolls away from the box (a clip, not a fade: rule 11).
              'transition-[clip-path] duration-open ease-out',
              up ? '[clip-path:inset(-24px_-24px_0_-24px)] data-starting-style:[clip-path:inset(100%_-24px_0_-24px)] data-ending-style:[clip-path:inset(100%_-24px_0_-24px)]'
                : '[clip-path:inset(0_-24px_-24px_-24px)] data-starting-style:[clip-path:inset(0_-24px_100%_-24px)] data-ending-style:[clip-path:inset(0_-24px_100%_-24px)]',
            )}
          >
            <SelectPrimitive.List>
              {options.map((o) => (
                <SelectPrimitive.Item
                  key={o.value}
                  value={o.value}
                  title={o.title}
                  disabled={o.disabled}
                  data-slot="select-option"
                  className={cn(
                    'py-[6px] whitespace-normal text-muted-foreground outline-none transition-[background-color,color] duration-fast ease-standard', cursor,
                    // Under the pointer, or reached by the keyboard (not merely the one the list
                    // opened on), as 1.3's list showed it.
                    'data-[selected]:font-semibold data-[selected]:text-foreground hover:bg-secondary hover:text-foreground focus-visible:bg-secondary focus-visible:text-foreground',
                    // Listed, not to be chosen (as Chromium's list greyed a disabled option).
                    'data-disabled:cursor-default data-disabled:text-muted-dim data-disabled:hover:bg-transparent data-disabled:hover:text-muted-dim',
                    INSET[s], o.className,
                  )}
                >
                  <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export { Select };

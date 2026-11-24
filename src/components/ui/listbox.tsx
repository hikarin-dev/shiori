// Listbox — the suggestions under a text box: the library search's (filters, then tags), the tag
// editor's values, the add-chapter bar's galleries. The box keeps focus; the list says which option
// is active (the combobox pattern: useCombobox below), and a press picks without taking focus.
//
//   variant  search  the library search's: 6px round, options 6px 8px with radius 5 and 10px between
//                    an icon (16, muted), their words and a count; group heads (ListboxHead, the 10px
//                    capitals) and lines between groups (ListboxSeparator, decorative, 3d's list
//                    spacing);
//            tag     the tag editor's: no padding round, options 6px 10px, square, 12px, a count at the
//                    end;
//            rich    the add-chapter results: no padding round, rows 8px 10px with a 30px cover, a
//                    title and an id.
// One frame for all (F16): the surface, the strong frame, radius 8, the popover shadow (F31: the
// search list's 0 10px 24px .35); the active option and the one under the pointer on the raised
// surface; the rows' rules of the add-chapter results go (each row 1px shorter). Sizes are 1.3's:
// F16's padding round the tag editor's and add-chapter's lists (0 → 6), their options' padding (the
// tag editor's 6px 10px → 6px 8px) and rounded options (5, which only sit right inside a padded
// list) are candidates for the owner, not built.
//
// Where a list stands (under its box, at its width, above what follows) is its caller's: the search
// list is placed on the window under the header's box, the others under their box in its field.
import { useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { cva } from 'class-variance-authority';
import { Separator } from './separator';
import { Eyebrow } from './text';
import { cn } from '@/lib/utils';

type Variant = 'search' | 'tag' | 'rich';
const VariantContext = createContext<Variant>('search');

const frame = cva('scroll-box rounded-8 border border-solid border-input bg-popover text-foreground shadow-popover', {
  variants: { variant: { search: 'p-[6px]', tag: 'p-0', rich: 'p-0' } },
});

function Listbox({ variant = 'search', className, ...props }: ComponentProps<'div'> & { variant?: Variant }) {
  return (
    <VariantContext.Provider value={variant}>
      <div role="listbox" data-slot="listbox" data-variant={variant} className={cn(frame({ variant }), className)} {...props} />
    </VariantContext.Provider>
  );
}

const option = cva('flex cursor-pointer items-center gap-[10px] text-12 select-none hover:bg-secondary aria-selected:bg-secondary', {
  variants: {
    variant: {
      search: 'rounded-5 px-[8px] py-[6px] [&>svg]:size-[16px] [&>svg]:shrink-0 [&>svg]:text-muted-foreground',
      tag: 'px-[10px] py-[6px]',
      rich: 'px-[10px] py-[8px]',
    },
  },
});

type OptionProps = Omit<ComponentProps<'div'>, 'onClick'> & { active?: boolean; onPick?: () => void; count?: ReactNode };

// An option: `active` while the keyboard is on it (aria-selected, as 1.3's lists set it). Picked on
// the press itself (mousedown), so the box never loses focus.
function ListboxOption({ active, onPick, count, className, children, onMouseDown, ...props }: OptionProps) {
  const variant = useContext(VariantContext);
  return (
    <div
      role="option"
      aria-selected={active ? 'true' : 'false'}
      data-slot="listbox-option"
      className={cn(option({ variant }), className)}
      onMouseDown={(e) => { e.preventDefault(); onMouseDown?.(e); onPick?.(); }}
      {...props}
    >
      {children}
      {count != null && <span data-slot="listbox-count" className="ml-auto shrink-0 text-11 text-muted-foreground tabular-nums">{count}</span>}
    </div>
  );
}

// A group's heading in the search list (not an option: a screen reader passes over it, as 1.3's).
function ListboxHead({ className, ...props }: ComponentProps<'div'>) {
  return <Eyebrow role="presentation" size="sm" className={cn('px-[8px] pt-[6px] pb-[4px]', className)} {...props} />;
}

function ListboxSeparator(props: ComponentProps<typeof Separator>) {
  return <Separator decorative {...props} />;
}

// The combobox pattern on a text box: the arrows move the active option (from none, and not past
// either end, as 1.3's lists did), Enter (and Tab, where `tabPicks`) takes the active one, Escape
// closes the list (and only the list: a dialog round it stays). Spread `inputProps` on the box.
function useCombobox({ id, count, open, onPick, onClose, onOpen, tabPicks }: {
  id: string; count: number; open: boolean; onPick: (index: number) => void; onClose: () => void; onOpen?: () => void; tabPicks?: boolean;
}) {
  const [active, setActive] = useState(-1);
  const [shown, setShown] = useState({ open, count });
  // A list that opens or changes starts with no option active.
  if (shown.open !== open || shown.count !== count) { setShown({ open, count }); setActive(-1); }
  const move = (by: number) => {
    const next = Math.max(-1, Math.min(count - 1, active + by));
    setActive(next);
    if (next >= 0) requestAnimationFrame(() => document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' }));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { if (onOpen) { e.preventDefault(); onOpen(); } return; }
      e.preventDefault();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if ((e.key === 'Enter' || (e.key === 'Tab' && tabPicks)) && open && active >= 0) {
      e.preventDefault();
      onPick(active);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return {
    active,
    setActive,
    optionId: (i: number) => `${id}-${i}`,
    inputProps: {
      role: 'combobox' as const,
      'aria-autocomplete': 'list' as const,
      'aria-expanded': open,
      'aria-controls': id,
      'aria-activedescendant': open && active >= 0 ? `${id}-${active}` : undefined,
      onKeyDown,
    },
  };
}

export { Listbox, ListboxOption, ListboxHead, ListboxSeparator, useCombobox };

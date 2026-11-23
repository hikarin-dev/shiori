// Tag — a gallery's tag, or a filter in the search box: a small framed word.
//
//   size     xs 14 (a library card's: 10px on one line, cut short past 100px) or sm 22 (the
//            overview's tags and the search box's filters: 12px, wrapping where the overview's may);
//   variant  neutral; artist and category (a card's, in their tones); add (the "+" that adds a tag);
//            ghost (the overview's editable details in edit mode: no frame until hovered, set over
//            the text it stands in so nothing shifts);
//   count    a slot after a divider: how many library entries carry the tag (the overview's);
//   filterKey  the search box's filter: its key, muted, before the value, which is then semibold.
// A tag that does something (`href`: a link, `onClick`: a button) answers the pointer; one that only
// shows (a filter in the search box) does not. With `removable`, while Shift is held (the page sets
// `shift-held` on the body) its hover previews the removal in the delete colour.
//
// §5.3 F19: the overview's tags 24 → 22px, the search filter's height, and one side padding (8px,
// the overview's: the filter +4px wide). F10: a card tag's ground #1e1e28 → the raised surface.
import type { ComponentProps, MouseEventHandler, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const tagVariants = cva('group/tag border border-solid no-underline', {
  variants: {
    variant: { neutral: '', artist: '', category: '', add: 'justify-center font-bold', ghost: '' },
    size: {
      xs: 'inline-block max-w-[100px] truncate rounded-3 px-[6px] py-[1px] text-10 leading-none',
      sm: 'inline-flex rounded-4 px-[8px] py-[1px] text-12 leading-[18px] [overflow-wrap:anywhere]',
    },
    interactive: { true: 'cursor-pointer transition-[color,background-color,border-color] duration-fast ease-standard', false: 'cursor-default' },
  },
  compoundVariants: [
    // A card's tags: the raised ground, the plain frame, the deepest grey.
    { size: 'xs', variant: ['neutral', 'artist', 'category', 'add'], class: 'border-border bg-secondary text-muted-faint' },
    { size: 'xs', variant: 'artist', class: 'border-warning-line text-warning' },
    { size: 'xs', variant: 'category', class: 'border-primary-line text-primary' },
    { size: 'xs', variant: 'add', class: 'inline-flex items-center px-[7px]' },
    // The overview's and the search box's: the raised ground, the strong frame, the text colour.
    { size: 'sm', variant: ['neutral', 'add'], class: 'border-input bg-secondary text-foreground' },
    { size: 'sm', variant: 'add', class: 'text-muted-foreground' },
    // Under the pointer: the muted frame and the text colour; artist and category frame in their tone;
    // "+" turns to the second accent.
    // (A card's grey is its own, a step deeper: its hover frame too.)
    { interactive: true, variant: 'neutral', class: 'hover:border-muted-foreground hover:text-foreground' },
    { interactive: true, size: 'xs', variant: 'neutral', class: 'hover:border-muted-faint' },
    { interactive: true, variant: 'artist', class: 'hover:border-warning' },
    { interactive: true, variant: 'category', class: 'hover:border-primary' },
    { interactive: true, variant: 'add', class: 'hover:border-warning hover:text-warning' },
    { interactive: true, variant: 'ghost', class: 'hover:border-muted-foreground hover:text-foreground' },
    // The editable detail (no size: the text around it is its own) stands over its text, its padding
    // and frame drawn into the margin.
    { variant: 'ghost', class: '-mx-[7px] -my-[3px] inline-flex items-center gap-[6px] rounded-4 border-transparent bg-transparent px-[6px] py-[2px]' },
  ],
  defaultVariants: { variant: 'neutral', size: 'sm' },
});

// While Shift is held, a removable tag's hover is the delete preview (its count's divider fades to
// white at half strength; an editable detail turns its frame and text red).
const REMOVING = {
  fill: 'in-[.shift-held]:hover:border-destructive in-[.shift-held]:hover:bg-destructive in-[.shift-held]:hover:text-destructive-foreground',
  ghost: 'in-[.shift-held]:hover:border-destructive in-[.shift-held]:hover:text-destructive',
};

type Common = Omit<VariantProps<typeof tagVariants>, 'interactive'> & {
  count?: ReactNode;
  filterKey?: string;
  removable?: boolean;
  className?: string;
  children?: ReactNode;
};
type Props = Common & (
  | ({ href: string; onClick?: MouseEventHandler<HTMLAnchorElement> } & Omit<ComponentProps<'a'>, 'className' | 'children'>)
  | ({ href?: undefined; onClick?: MouseEventHandler<HTMLButtonElement> } & Omit<ComponentProps<'button'>, 'className' | 'children'>)
);

function Tag({ variant = 'neutral', size = 'sm', count, filterKey, removable, className, children, ...props }: Props) {
  const interactive = props.href !== undefined || props.onClick !== undefined;
  const classes = cn(
    tagVariants({ variant, size: variant === 'ghost' ? null : size, interactive }),
    removable && variant !== 'add' && (variant === 'ghost' ? REMOVING.ghost : REMOVING.fill),
    filterKey !== undefined && 'font-semibold whitespace-pre',
    className,
  );
  const content = (
    <>
      {filterKey !== undefined && <span data-slot="tag-key" className="mr-[4px] font-normal text-muted-foreground">{filterKey}:</span>}
      {children}
      {count !== undefined && (
        <span data-slot="tag-count" className={cn('ml-[8px] border-0 border-l border-solid pl-[8px] text-muted-foreground tabular-nums [border-left-color:inherit]',
          removable && 'in-[.shift-held]:group-hover/tag:text-inherit in-[.shift-held]:group-hover/tag:[border-left-color:rgb(255_255_255/50%)]')}>{count}</span>
      )}
    </>
  );
  if (props.href !== undefined) {
    const { href, ...rest } = props;
    return <a data-slot="tag" data-variant={variant} href={href} className={classes} {...rest}>{content}</a>;
  }
  if (interactive) return <button type="button" data-slot="tag" data-variant={variant} className={classes} {...(props as ComponentProps<'button'>)}>{content}</button>;
  return <span data-slot="tag" data-variant={variant} className={classes} {...(props as ComponentProps<'span'>)}>{content}</span>;
}

export { Tag };

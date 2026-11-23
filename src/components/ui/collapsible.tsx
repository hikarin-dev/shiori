// Collapsible — a part that opens and closes under its header (Base UI's collapsible).
//
//   variant  group    Settings' advanced options: "Pipeline details", a full-width header in the
//                     group heading's look (the Eyebrow, sm, in the second accent, ruled under), its
//                     chevron at the end, its text lifting to the text colour under the pointer;
//            details  page properties' "All settings", "Text": a line of 11px muted text after a
//                     disclosure triangle, lifting under the pointer, 9px over its part when open;
//            box      the benchmark's: the same, inside a frame (radius 6, 10px of padding).
// Opening shows the part at once: nothing in it fades, moves or grows (rule 11). Closed, the part
// stays in the document, hidden, as a closed <details> and 1.3's hidden rows did.
//
// T7: the <details> triangle is drawn, as Chromium drew it (a filled triangle, the text 1.06em on),
// the same in every browser; F18: the group header's ▾/› glyphs become a chevron, and its type the
// Eyebrow's (10px, 600, .1em). The benchmark's summary takes page properties' 11px (12 today): one
// size in the dialogs.
import type { ReactNode } from 'react';
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = Omit<CollapsiblePrimitive.Root.Props, 'className' | 'children'> & {
  variant?: 'group' | 'details' | 'box';
  title: ReactNode;
  className?: string;
  panelClassName?: string;
  // Anything more the header takes (an id, data attributes).
  triggerProps?: Omit<CollapsiblePrimitive.Trigger.Props, 'className' | 'children'> & { [data: `data-${string}`]: string | undefined };
  children?: ReactNode;
};

function Triangle() {
  return (
    <span aria-hidden className="inline-flex w-[1.06em] shrink-0 items-center">
      <svg viewBox="0 0 10 10" className="size-[.55em] fill-current group-data-[panel-open]/collapsible:rotate-90"><path d="M1 0.5 9.5 5 1 9.5z" /></svg>
    </span>
  );
}

function Collapsible({ variant = 'details', title, className, panelClassName, triggerProps, children, ...props }: Props) {
  const group = variant === 'group';
  return (
    <CollapsiblePrimitive.Root data-slot="collapsible" data-variant={variant}
      className={cn(variant === 'box' && 'rounded-6 border border-solid border-border p-[10px]', className)} {...props}>
      <CollapsiblePrimitive.Trigger
        data-slot="collapsible-trigger"
        {...triggerProps}
        className={cn(
          'group/collapsible flex w-full min-w-0 cursor-pointer items-center text-left',
          group
            ? 'justify-between gap-[12px] border-0 border-b border-solid border-border pb-[6px] text-10 leading-[1.45] font-semibold tracking-[.1em] text-warning uppercase [overflow-wrap:anywhere] hover:text-foreground'
            : 'text-11 text-muted-foreground hover:text-foreground data-[panel-open]:mb-[9px]',
        )}
      >
        {!group && <Triangle />}
        <span className="min-w-0">{title}</span>
        {group && <ChevronDown aria-hidden className="w-[12px] shrink-0 text-muted-foreground [height:10px] group-not-data-[panel-open]/collapsible:-rotate-90" />}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Panel keepMounted data-slot="collapsible-panel" className={panelClassName}>{children}</CollapsiblePrimitive.Panel>
    </CollapsiblePrimitive.Root>
  );
}

export { Collapsible };

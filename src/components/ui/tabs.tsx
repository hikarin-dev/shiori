// Tabs — a few panels, one shown at a time, on Base UI's tabs (the arrows move between the tabs,
// Enter or Space shows one, each tab names its panel to assistive technology).
//
//   nav        Settings' side navigation: a column of tabs, the shown one framed on the raised
//              surface; its sizes step down with the window as Settings' did (760, 520, 380px).
//   segmented  reader settings' tabs: the ToggleGroup's track and its one sliding highlight (F12),
//              its tabs Settings' segments (S02: 9px in, not 8; a 1.35 line).
//   underline  the overview's Chapters / Volumes: small capitals, the shown one underlined.
//
// The panels all stay mounted, in one grid cell: the box holding them is as tall as the tallest
// whichever is shown, so a dialog holding tabs never changes size (T16, rule 12). A hidden panel is
// invisible and inert.
import { Children, createContext, isValidElement, useContext, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { SEGMENTED_HIGHLIGHT, SEGMENTED_ITEM, SEGMENTED_TRACK } from './toggle-group';

type Variant = 'nav' | 'segmented' | 'underline';
const Look = createContext<{ variant: Variant; value: unknown }>({ variant: 'nav', value: undefined });

type RootProps = Omit<TabsPrimitive.Root.Props, 'value' | 'defaultValue' | 'onValueChange'> & {
  variant?: Variant;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

function Tabs({ variant = 'nav', value, defaultValue, onValueChange, className, ...props }: RootProps) {
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  return (
    <Look.Provider value={{ variant, value: current }}>
      <TabsPrimitive.Root
        data-slot="tabs"
        data-variant={variant}
        value={current}
        onValueChange={(v) => { setOwn(v as string); onValueChange?.(v as string); }}
        orientation={variant === 'nav' ? 'vertical' : 'horizontal'}
        className={cn('min-w-0', typeof className === 'string' ? className : undefined)}
        {...props}
      />
    </Look.Provider>
  );
}

const list = cva('relative min-w-0', {
  variants: {
    variant: {
      nav: 'flex flex-col gap-[3px]',
      segmented: SEGMENTED_TRACK,
      underline: 'inline-flex gap-[2px] text-11 font-normal tracking-[.12em] uppercase',
    },
  },
});

type TabProps = Omit<TabsPrimitive.Tab.Props, 'value'> & { value: string };

function TabsList({ className, children, style, ...props }: TabsPrimitive.List.Props) {
  const { variant, value } = useContext(Look);
  const tabs = Children.toArray(children).filter(isValidElement) as ReactElement<TabProps>[];
  const at = tabs.findIndex((el) => el.props.value === value);
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(list({ variant }), typeof className === 'string' ? className : undefined)}
      style={{ ...(variant === 'segmented' ? { '--seg-n': tabs.length, '--seg-i': Math.max(at, 0) } : {}), ...(style as CSSProperties) } as CSSProperties}
      {...props}
    >
      {variant === 'segmented' && <span aria-hidden data-slot="tabs-highlight" hidden={at < 0} className={SEGMENTED_HIGHLIGHT} />}
      {children}
    </TabsPrimitive.List>
  );
}

const tab = cva('relative min-w-0 cursor-pointer border-solid text-muted-foreground transition-[color,background-color,border-color] duration-fast ease-standard', {
  variants: {
    variant: {
      nav: [
        'min-h-[38px] w-full rounded-6 border border-transparent bg-transparent px-[12px] py-[9px] text-left text-12 leading-[1.45] font-semibold [overflow-wrap:anywhere]',
        'hover:bg-card hover:text-foreground aria-selected:border-border aria-selected:bg-secondary aria-selected:text-foreground',
        // Settings' narrower steps: its media queries, inclusive as they were, each a range of its own
        // so no two set one value.
        '[@media(520px<width<=760px)]:px-[10px] [@media(520px<width<=760px)]:py-[8px] [@media(520px<width<=760px)]:text-11 [@media(520px<width<=760px)]:leading-[1.45]',
        '[@media(380px<width<=520px)]:min-h-[36px] [@media(380px<width<=520px)]:px-[7px] [@media(380px<width<=520px)]:py-[8px] [@media(380px<width<=520px)]:text-10 [@media(380px<width<=520px)]:leading-[1.45]',
        // F21: its 9.5px at 380px and under becomes 10 (the step above's), with 6px sides.
        '[@media(width<=380px)]:min-h-[36px] [@media(width<=380px)]:px-[6px] [@media(width<=380px)]:py-[8px] [@media(width<=380px)]:text-10 [@media(width<=380px)]:leading-[1.45]',
      ].join(' '),
      segmented: `${SEGMENTED_ITEM} border aria-selected:text-foreground`,
      underline: 'mr-[10px] border-0 border-b-2 border-transparent bg-transparent px-[2px] pt-0 pb-[2px] text-muted-dim hover:text-foreground aria-selected:cursor-default aria-selected:border-primary aria-selected:text-muted-foreground pointer-coarse:pt-[10px] pointer-coarse:pb-[6px] [font:inherit] [letter-spacing:inherit] [text-transform:inherit]',
    },
  },
});

function TabsTab({ className, ...props }: TabProps) {
  const { variant } = useContext(Look);
  return <TabsPrimitive.Tab data-slot="tabs-tab" className={cn(tab({ variant }), typeof className === 'string' ? className : undefined)} {...props} />;
}

// Where the panels go: one grid cell they all share.
function TabsPanels({ className, ...props }: { className?: string; children: ReactNode }) {
  return <div data-slot="tabs-panels" className={cn('grid min-w-0', className)} {...props} />;
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      keepMounted
      // Kept in the layout (Base UI would hide it): invisible and inert instead.
      hidden={false}
      className={cn('min-w-0 [grid-area:1/1] self-start data-hidden:invisible', typeof className === 'string' ? className : undefined)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTab, TabsPanels, TabsPanel };

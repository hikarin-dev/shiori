// Menu and ContextMenu — a short list of things to do, opened by a button (a library folder's ⋯, the
// benchmark's tiers) or by a right-click (a translated gallery's "Re-run from…", the reader's page
// menu). On Base UI's menu and context menu.
//
//   variant  context    the app's menus (.ctx-menu): 5px round, at most 320 wide; a title in 11px
//                       muted, items 12px with 7px 9px round them, radius 5, a detail line under the
//                       label (11px, muted) and a key cap at its end (Kbd, menu size); a danger item
//                       in red; a separator 4px 2px off (Separator, menu spacing);
//            checklist  the benchmark's tier filter: 290 wide, 4px above and below, ticks before each
//                       option (7px 11px round).
// Each item answers the pointer and the keyboard alike (Base UI's highlight): the border's grey under
// a context menu's item, the raised surface under a checklist's, as each had it (F30: two hovers, as
// today). Disabled: .55.
//
// The keyboard as a menu's: the arrows move (and wrap), Home and End, typing a name goes to it,
// Enter or Space chooses, Escape closes and gives focus back to what opened it. It opens at once and
// closes on a choice, Escape, a press outside, a scroll or a resize (as 1.3's did). Non-modal: the
// page keeps its scrollbar (Base UI's modal menu hides it).
//
// Placed as Popover places its panel (popover.tsx): fixed to the window, 8px inside it; under its
// button (6px for a context-menu style list opened by a button, 4px for a folder's), or at the
// pointer. §5.3 F30: one layer (900; 9000, 900 and 430 before); the checklist takes the menu's
// frame (the surface, the plain frame, radius 8; 1.3: the subtle ground, the strong frame, radius 6),
// keeping its own 4px 0 padding (a candidate: the menu's 5px would move its options 5px in). F31:
// one floating shadow (the checklist's 0 10px 24px .35). F32: a key cap's text in the text colour.
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu';
import { cva } from 'class-variance-authority';
import { FLOATING, POSITIONER } from './popover';
import { Kbd } from './kbd';
import { Separator } from './separator';
import { cn } from '@/lib/utils';

type Variant = 'context' | 'checklist';

const popup = cva(cn(FLOATING, 'border-border shadow-popover'), {
  variants: {
    variant: {
      context: 'max-w-[320px] rounded-8 p-[5px]',
      checklist: 'w-[290px] rounded-8 py-[4px]',
    },
  },
});

// Closes the menu when the page scrolls or the window is resized, as 1.3's menus did (Base UI's
// would follow what opened it).
function useCloseOnMove() {
  const actions = useRef<MenuPrimitive.Root.Actions | null>(null);
  const open = useRef(false);
  useEffect(() => {
    const close = () => { if (open.current) actions.current?.close(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, []);
  return { actions, track: (o: boolean) => { open.current = o; } };
}

function Menu({ onOpenChange, ...props }: MenuPrimitive.Root.Props) {
  const { actions, track } = useCloseOnMove();
  return <MenuPrimitive.Root modal={false} actionsRef={actions} onOpenChange={(o, d) => { track(o); onOpenChange?.(o, d); }} {...props} />;
}

function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

// A right-click (or a long press) on its child opens it at the pointer.
function ContextMenu({ onOpenChange, ...props }: ContextMenuPrimitive.Root.Props) {
  const { actions, track } = useCloseOnMove();
  // (Its modal mode, which the context menu's types leave out, would hide the page's scrollbar.)
  const nonModal = { modal: false } as object;
  return <ContextMenuPrimitive.Root actionsRef={actions} onOpenChange={(o, d) => { track(o); onOpenChange?.(o, d); }} {...nonModal} {...props} />;
}

function ContextMenuTrigger(props: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

type Side = 'top' | 'bottom' | 'left' | 'right';
type ContentProps = Omit<MenuPrimitive.Popup.Props, 'className'> & {
  variant?: Variant;
  side?: Side;
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  className?: string;
  // Opened by a right-click: at the pointer.
  context?: boolean;
};

// At the pointer, its top left corner on it (Base UI's own is 2px right and 5px up). Where the window
// has no room below, it opens upward from the pointer: 1.3 slid it back in instead.
const AT_POINTER = { sideOffset: 0, alignOffset: 0 } as const;

function MenuContent({ variant = 'context', side = 'bottom', align = 'start', sideOffset = 0, context, className, ...props }: ContentProps) {
  const Positioner = context ? ContextMenuPrimitive.Positioner : MenuPrimitive.Positioner;
  return (
    <MenuPrimitive.Portal>
      <Positioner {...POSITIONER} {...(context ? AT_POINTER : { side, align, sideOffset })} className="z-menu">
        <MenuPrimitive.Popup data-slot="menu" data-variant={variant} className={cn(popup({ variant }), className)} {...props} />
      </Positioner>
    </MenuPrimitive.Portal>
  );
}

// The menu drawn where it stands, still (the /components page's specimens): no Base UI.
function MenuPanel({ variant = 'context', className, ...props }: ComponentProps<'div'> & { variant?: Variant }) {
  return <div data-slot="menu" data-variant={variant} className={cn(popup({ variant }), className)} {...props} />;
}

// A menu's title: what it is about (its items' group label).
function MenuTitle({ className, ...props }: Omit<MenuPrimitive.GroupLabel.Props, 'className'> & { className?: string }) {
  return <MenuPrimitive.GroupLabel data-slot="menu-title" className={cn(TITLE, className)} {...props} />;
}
const TITLE = 'px-[9px] pt-[5px] pb-[6px] text-11 text-muted-foreground';

const ITEM = cn(
  'block w-full cursor-pointer rounded-5 px-[9px] py-[7px] text-left text-12 text-foreground outline-none select-none',
  'data-highlighted:bg-border hover:bg-border',
  'data-disabled:cursor-default data-disabled:opacity-55',
);

type ItemParts = { danger?: boolean; detail?: ReactNode; shortcut?: string; icon?: ReactNode };

// What an item shows: its label (an icon before it, 14px; a key cap at its end), and a detail under.
function ItemBody({ children, detail, shortcut, icon }: ItemParts & { children?: ReactNode }) {
  return (
    <>
      <span data-slot="menu-label" className={cn('block', (shortcut || icon) && 'flex items-center gap-[12px]', icon && 'justify-start gap-[8px]', shortcut && 'justify-between')}>
        {icon && <span aria-hidden className="inline-flex shrink-0 [&_svg]:size-[14px]">{icon}</span>}
        <span className={cn(icon && shortcut && 'flex-1')}>{children}</span>
        {shortcut && <Kbd size="menu">{shortcut}</Kbd>}
      </span>
      {detail != null && <span data-slot="menu-detail" className="mt-[2px] block text-11 leading-[1.35] text-muted-foreground">{detail}</span>}
    </>
  );
}

function MenuItem({ danger, detail, shortcut, icon, className, children, ...props }: Omit<MenuPrimitive.Item.Props, 'className'> & ItemParts & { className?: string }) {
  return (
    <MenuPrimitive.Item data-slot="menu-item" data-danger={danger ? '' : undefined} className={cn(ITEM, danger && 'text-destructive', className)} {...props}>
      <ItemBody detail={detail} shortcut={shortcut} icon={icon}>{children}</ItemBody>
    </MenuPrimitive.Item>
  );
}

// An item drawn still, for the specimens.
function MenuItemStill({ danger, detail, shortcut, icon, disabled, className, children, ...props }: ComponentProps<'div'> & ItemParts & { disabled?: boolean }) {
  return (
    <div role="menuitem" data-slot="menu-item" data-disabled={disabled ? '' : undefined} className={cn(ITEM, danger && 'text-destructive', className)} {...props}>
      <ItemBody detail={detail} shortcut={shortcut} icon={icon}>{children}</ItemBody>
    </div>
  );
}

// A checklist's option: a tick box (drawn as Checkbox draws one) before what it is.
const CHECK_ITEM = 'group flex w-full cursor-pointer items-center gap-[8px] px-[11px] py-[7px] text-left text-12 text-foreground outline-none select-none data-highlighted:bg-secondary hover:bg-secondary data-disabled:cursor-default data-disabled:opacity-55';
function Tick() {
  return (
    <span aria-hidden className="relative inline-flex size-[13px] shrink-0 items-center justify-center rounded-2 border border-solid border-check-border bg-check-ground text-primary-foreground group-data-checked:border-primary group-data-checked:bg-primary">
      <svg viewBox="0 0 13 13" className="absolute inset-[-1px] hidden size-[13px] group-data-checked:block" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><polyline points="2.9,6.9 5.1,9.1 10,3.6" /></svg>
    </span>
  );
}

function MenuCheckboxItem({ className, children, ...props }: Omit<MenuPrimitive.CheckboxItem.Props, 'className'> & { className?: string }) {
  return (
    <MenuPrimitive.CheckboxItem data-slot="menu-checkbox-item" closeOnClick={false} className={cn(CHECK_ITEM, className)} {...props}>
      <Tick />{children}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuCheckboxItemStill({ checked, className, children, ...props }: ComponentProps<'div'> & { checked?: boolean }) {
  return (
    <div role="menuitemcheckbox" aria-checked={!!checked} data-slot="menu-checkbox-item" data-checked={checked ? '' : undefined} className={cn(CHECK_ITEM, className)} {...props}>
      <Tick />{children}
    </div>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

// The line before what deletes (a folder's menu): a separator, 4px above and below and 2px in.
function MenuSeparator({ className, ...props }: ComponentProps<typeof Separator>) {
  return <Separator spacing="menu" className={className} {...props} />;
}

export {
  Menu, MenuTrigger, ContextMenu, ContextMenuTrigger, MenuContent, MenuPanel, MenuTitle, MenuItem, MenuItemStill,
  MenuCheckboxItem, MenuCheckboxItemStill, MenuGroup, MenuSeparator, TITLE as MENU_TITLE,
};

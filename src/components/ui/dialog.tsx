// Dialog — a box over the page that asks or shows something and holds the page still until it goes:
// the notices (confirm, alert, prompt, choice, ask, progress), the tag editor, the library filter,
// Settings' dialogs, reader settings, the keys, page properties, feedback, the benchmark. On Base
// UI's dialog.
//
//   layout  simple     one padded box: a title row, what it says, its buttons at the end (the
//                      notices, the page dialogs, the keys, feedback, the benchmark); the whole box
//                      scrolls when the window is too short for it;
//           sectioned  a ruled header, a body that scrolls on its own, a ruled footer (Settings'
//                      dialogs, page properties).
//   size     its width (it is never wider than the window less 16px a side): xs 340 (the tag
//            editor, removing a chapter) · sm 440 (the notices, the keys, the backup choice) · md 480
//            (an operation, reader settings) · lg 520 (About) · xl 620 (the library filter) · 2xl
//            760 (the advanced options, page properties) · 3xl 960 (feedback) · 4xl 1120 (the
//            benchmark).
//   layer    dialog (the pages' own dialogs) or notice (notice.js's, over everything else, the
//            toast included).
//
// T16, rules 10–12, as 1.3's overlays were:
//   - Focus is trapped in the box (modal 'trap-focus') and goes back to what had it when the box
//     closes; Escape and a press on the backdrop close it.
//   - The page's scrollbar stays where it is and the page doesn't move: no scroll lock (Base UI's
//     modal mode hides the scrollbar and pads the body). The layer the box is centred in holds the
//     page still instead, as 1.3's overlay did: a scroll container that contains overscroll, so no
//     wheel or swipe started over it reaches the page. It keeps the room of a scrollbar that isn't
//     there (--page-scrollbar-gap), as the body does, so the box stays put when the scrollbar comes
//     or goes behind it.
//   - The box is centred by the layer's flex layout, never by a transform (a translate(-50%) lands
//     on half pixels and follows the box's height as it grows).
//   - It shows at once and goes at once: nothing in it fades, zooms or moves (stock shadcn's
//     animations are not taken).
// A dialog over a dialog (a notice over Settings' advanced options) is a second one opened on top:
// its own backdrop over the first, only its own backdrop closing it.
//
// §5.3 F26: one shadow, the notices' (six dialogs had none). F27: 420 and 460 → 440, 780 → 760.
// F28: the title 15px bold, on a 20px line. F29 (owner): a header's close is the corner X (feedback's
// and the benchmark's text "Close" before). S16, one set of sizes per layout (shadcn's base-nova
// dialog the tiebreak): every side 20px; simple: 20 round, 12 under the title row, the buttons 16
// below what precedes them and 8 apart; sectioned: the header 16px 20px (52 tall with its title),
// the body 20, the footer 13px 20px (62 with its buttons), 10 apart; at 520px of window or less a
// sectioned dialog takes its 1.3 phone form (14px, the footer 11px 14px, radius 10, 8px off the
// window's edges).
//
// inPlace: drawn where it stands with no backdrop or layer, open and doing nothing (the /components
// page's still specimens).
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { Button } from './button';
import { DIALOG_TITLE } from './text';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Layout = 'simple' | 'sectioned';
const LayoutContext = createContext<Layout>('simple');

function Dialog({ modal = 'trap-focus', ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root modal={modal} {...props} />;
}

// What opens it, when a button does (a dialog the app opens from code is given `open` instead).
function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

const LAYER = { dialog: 'z-dialog', notice: 'z-notice' } as const;

const box = cva(
  'relative flex min-w-0 flex-col rounded-12 border border-solid border-input bg-popover text-popover-foreground shadow-dialog outline-none [overflow-wrap:anywhere]',
  {
    variants: {
      size: {
        xs: 'w-[min(340px,100%)]', sm: 'w-[min(440px,100%)]', md: 'w-[min(480px,100%)]', lg: 'w-[min(520px,100%)]',
        xl: 'w-[min(620px,100%)]', '2xl': 'w-[min(760px,100%)]', '3xl': 'w-[min(960px,100%)]', '4xl': 'w-[min(1120px,100%)]',
      },
      layout: {
        simple: 'scroll-box max-h-[calc(100dvh-32px)] p-[20px]',
        sectioned: 'max-h-[calc(100dvh-32px)] overflow-hidden max-[520.02px]:max-h-[calc(100dvh-16px)] max-[520.02px]:rounded-10',
      },
    },
  },
);

type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';
type ContentProps = Omit<DialogPrimitive.Popup.Props, 'className'> & {
  size?: Size;
  layout?: Layout;
  layer?: keyof typeof LAYER;
  inPlace?: HTMLElement | null;
  className?: string;
  children?: ReactNode;
};

function DialogContent({ size = 'sm', layout = 'simple', layer = 'dialog', inPlace, className, children, ...props }: ContentProps) {
  const popup = (
    <DialogPrimitive.Popup
      data-slot="dialog"
      data-layout={layout}
      className={cn(box({ size, layout }), className)}
      {...(inPlace !== undefined ? { initialFocus: false, finalFocus: false } : {})}
      {...props}
    >
      <LayoutContext.Provider value={layout}>{children}</LayoutContext.Provider>
    </DialogPrimitive.Popup>
  );
  if (inPlace !== undefined) return <DialogPrimitive.Portal container={inPlace}>{popup}</DialogPrimitive.Portal>;
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop data-slot="dialog-backdrop" className={cn('fixed inset-0 bg-backdrop', LAYER[layer])} />
      <DialogPrimitive.Viewport
        data-slot="dialog-viewport"
        className={cn(
          'fixed inset-0 flex items-center justify-center overflow-hidden overscroll-contain py-[16px] pr-[calc(16px+var(--page-scrollbar-gap))] pl-[16px]',
          layout === 'sectioned' && 'max-[520.02px]:py-[8px] max-[520.02px]:pr-[calc(8px+var(--page-scrollbar-gap))] max-[520.02px]:pl-[8px]',
          LAYER[layer],
        )}
      >
        {popup}
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  );
}

// The title row (simple) or the ruled header (sectioned): the title (and a description under it) at
// the start, what else it holds (a tone icon before, a close or a link after) in its row.
function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  const layout = useContext(LayoutContext);
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-[12px]',
        layout === 'simple' ? 'mb-[12px]' : 'justify-between border-0 border-b border-solid border-border px-[20px] py-[16px] max-[520.02px]:p-[14px]',
        className,
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: Omit<DialogPrimitive.Title.Props, 'className'> & { className?: string }) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn(DIALOG_TITLE, 'min-w-0 flex-1', className)} {...props} />;
}

function DialogDescription({ className, ...props }: Omit<DialogPrimitive.Description.Props, 'className'> & { className?: string }) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('mt-[4px] text-11 leading-[1.5] text-muted-foreground', className)} {...props} />;
}

// A sectioned dialog's body, which scrolls on its own between the header and the footer.
function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-body" className={cn('scroll-box min-h-0 min-w-0 flex-1 p-[20px] max-[520.02px]:p-[14px]', className)} {...props} />;
}

// The buttons at the end: after what the box says (simple) or ruled off under the body (sectioned).
function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  const layout = useContext(LayoutContext);
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex min-w-0 shrink-0 items-center justify-end',
        layout === 'simple' ? 'mt-[16px] flex-wrap gap-[8px]' : 'gap-[10px] border-0 border-t border-solid border-border px-[20px] py-[13px] max-[520.02px]:flex-wrap max-[520.02px]:px-[14px] max-[520.02px]:py-[11px]',
        className,
      )}
      {...props}
    />
  );
}

// The corner X: a borderless 28px button with its icon alone at 16, at the header row's end.
function DialogClose({ className, ...props }: Omit<DialogPrimitive.Close.Props, 'className' | 'render'> & { className?: string }) {
  const t = useT();
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      render={<Button variant="ghost" size="icon" aria-label={t('common.close')} className={cn('shrink-0', className)} />}
      {...props}
    >
      <X aria-hidden strokeWidth={2} />
    </DialogPrimitive.Close>
  );
}

export { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter, DialogClose };

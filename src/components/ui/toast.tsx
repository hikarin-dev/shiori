// Toast — a line at the bottom of the window that says something happened, and stays out of the way.
//
//   Toast        the app's toast (notice.js's showToast: "update ready", a library folder's news): a
//                message, an action and a close, one at a time; it stays until it is acted on or
//                closed. While its action runs (busy) the action is off and says so, and the close
//                goes. 402.5 wide for the update's words; 22px over the window's bottom, centred, at
//                most the window less 16px a side; the toast layer, under the notices.
//   StatusToast  the reader's status pill (a page's translation): one short line, a spinner before it
//                while busy; it goes 3.5s after it was said (an error 7s), a busy one stays until the
//                next line; 28px over the bottom, centred, at most 520 wide; the status layer.
//   ToastRegion  where a toast stands: fixed at the bottom, centred by layout (a full-width row,
//                not a translate(-50%): no half pixel under the text), letting the pointer through
//                around the toast. It is a polite status region and stays in the document, empty
//                between toasts, so a screen reader hears each toast as it comes.
//
// The sizes are 1.3's (outside Settings and the dialogs). Nothing moves in or out; the status pill
// comes and goes by its colours, .18s (rule 11; 1.3 faded it and slid it 10px, over its text).
// §5.3 F01: the toast's button 35.4 → 36 (and S11's 12px text, half a pixel). F31: the shadows of the
// toast and of the status pill are the toast's and the popover's tokens, as they were.
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './button';
import { Spinner } from './spinner';
import { cn } from '@/lib/utils';

function ToastRegion({ place = 'toast', className, ...props }: ComponentProps<'div'> & { place?: 'toast' | 'status' }) {
  return (
    <div
      data-slot="toast-region"
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed inset-x-0 flex justify-center px-[16px] *:pointer-events-auto',
        place === 'toast' ? 'bottom-[22px] z-toast' : 'bottom-[28px] z-status',
        className,
      )}
      {...props}
    />
  );
}

type ToastProps = Omit<ComponentProps<'div'>, 'children'> & {
  text: ReactNode;
  action: ReactNode;
  onAction: () => void;
  // The action's words while it runs: the action is off, the close gone.
  busy?: ReactNode;
  closeLabel: string;
  onClose: () => void;
};

function Toast({ text, action, onAction, busy, closeLabel, onClose, className, ...props }: ToastProps) {
  return (
    <div
      data-slot="toast"
      className={cn(
        'flex max-w-full min-w-0 items-center gap-[12px] rounded-10 border border-solid border-input bg-card py-[10px] pr-[10px] pl-[16px] text-12.5 leading-[1.4] text-foreground shadow-toast',
        className,
      )}
      {...props}
    >
      <span data-slot="toast-text" className="min-w-0">{text}</span>
      <Button variant="primary" disabled={busy != null} onClick={onAction}>{busy ?? action}</Button>
      {busy == null && (
        <Button variant="ghost" size="icon" aria-label={closeLabel} onClick={onClose}><X aria-hidden strokeWidth={2} className="size-[15px]" /></Button>
      )}
    </div>
  );
}

// The status pill itself, shown or not.
function StatusPill({ shown = true, busy, error, className, children, ...props }: ComponentProps<'div'> & { shown?: boolean; busy?: boolean; error?: boolean }) {
  return (
    <div
      data-slot="status-pill"
      data-shown={shown ? '' : undefined}
      data-error={error ? '' : undefined}
      className={cn(
        'max-w-[min(520px,100%)] rounded-pill border border-solid px-[14px] py-[8px] text-12',
        'transition-[color,background-color,border-color,box-shadow] duration-open ease-standard',
        shown ? cn('bg-card text-foreground shadow-popover', error ? 'border-primary' : 'border-border') : 'pointer-events-none! border-transparent bg-transparent text-transparent shadow-none',
        className,
      )}
      {...props}
    >
      {busy && <Spinner size="sm" className={cn('mr-[8px] align-[-1px]', !shown && 'invisible')} />}
      {children}
    </div>
  );
}

// A line said by the reader: `seq` changes with each new line (the same words said again show again).
function StatusToast({ text, busy = false, error = false, seq }: { text: string; busy?: boolean; error?: boolean; seq: number }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!seq) return;
    setShown(true);
    if (busy) return;
    const timer = setTimeout(() => setShown(false), error ? 7000 : 3500);
    return () => clearTimeout(timer);
  }, [seq, busy, error]);
  return (
    <ToastRegion place="status">
      <StatusPill shown={shown} busy={busy} error={error}>{text}</StatusPill>
    </ToastRegion>
  );
}

export { Toast, ToastRegion, StatusPill, StatusToast };

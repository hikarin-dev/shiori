// Alert and StatusText — a few words about how things stand.
//
// Alert — a quiet note framed in the plain border (Settings' advanced options: why they are missing):
// 11px muted on a 1.5 line, 9px 11px of padding, radius 6. Where it sits is its caller's; a note
// that answers something (the server being offline) is given role status by its caller.
//
// StatusText — the line a Settings section says after an action ("Saved", an error): 10.5px on a 1.5
// line, at the end of its line, in a tone (muted, ok: the success colour, err: the delete colour);
// a polite status to a screen reader. `shown` false hides it: in a section's body (place "section")
// it then takes no room, and shown it stands 0 20px 14px under the rows (0 15px 12px in a panel of
// 480px or less); in a row of buttons (place "row") it keeps a line's height. It fades out by its
// colour, .15s (1.3 faded it by opacity, rule 11).
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

function Alert({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="alert" className={cn('rounded-6 border border-solid border-border px-[11px] py-[9px] text-left text-11 leading-[1.5] text-muted-foreground [overflow-wrap:anywhere]', className)} {...props} />;
}

type StatusProps = ComponentProps<'div'> & { tone?: 'muted' | 'ok' | 'err'; shown?: boolean; place?: 'row' | 'section' };

const TONE = { muted: 'text-muted-foreground', ok: 'text-success', err: 'text-destructive' };

function StatusText({ tone = 'muted', shown = true, place = 'row', className, ...props }: StatusProps) {
  return (
    <div
      data-slot="status-text"
      role="status"
      aria-live="polite"
      data-shown={shown ? '' : undefined}
      className={cn(
        'min-h-[16px] min-w-0 text-right text-10.5 leading-[1.5] [overflow-wrap:anywhere] transition-[color,visibility] duration-base ease-standard',
        shown ? TONE[tone] : 'invisible text-transparent',
        place === 'section' && (shown ? 'px-[20px] pb-[14px] @max-[480.02px]/settings-panel:px-[15px] @max-[480.02px]/settings-panel:pb-[12px]' : 'h-0 min-h-0 overflow-hidden'),
        className,
      )}
      {...props}
    />
  );
}

export { Alert, StatusText };

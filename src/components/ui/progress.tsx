// Progress — how far a job has come, as a bar; and Meter, a measured amount out of a whole.
//
// Progress (Base UI's progress: a progressbar with its value, range and name):
//   tone   job (a card's, a chapter row's, a task's, the import tracker's and a library folder's job:
//          the second accent, the success colour once `done`) or accent (a dialog's progress: the
//          brand colour);
//   size   thin 3 (the job bars, radius 2) or thick 6 (a dialog's, a pill).
// With no figure yet (`value` null) it says so to a screen reader by having no value, and shows the
// one motion of §5.3 F22: a block 35% of the bar's width travelling across it, every 1.2s at an even
// pace (today a job bar shimmered in place, a folder's bar travelled, a dialog's travelled 30% wide
// with an ease). A job's block is soft-edged, a dialog's solid, as each was. With less motion asked
// for, the block rests at the start. The fill's width eases as each did (.25s, a dialog's .2s).
// Name it: `aria-label` or `aria-labelledby`.
//
// Meter (Base UI's meter): a static value, the benchmark chart's bars. Drawn as Chromium drew a
// <meter> on the dark theme (T7): a 10px pill in the middle of a 20px box, the checkbox's grey frame
// and ground, its value in the meter's green. 1.3 asked for the brand colour (accent-color), which
// Chromium's meter never took.
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { Meter as MeterPrimitive } from '@base-ui/react/meter';
import { cn } from '@/lib/utils';

type ProgressProps = Omit<ProgressPrimitive.Root.Props, 'value' | 'className'> & {
  value: number | null;
  tone?: 'job' | 'accent';
  size?: 'thin' | 'thick';
  done?: boolean;
  className?: string;
};

const FILL = {
  job: {
    known: 'bg-warning data-done:bg-success transition-[width] duration-slow ease-standard',
    unknown: 'bg-[linear-gradient(90deg,transparent,var(--warning),transparent)]',
  },
  accent: {
    known: 'bg-primary transition-[width] duration-move ease-standard',
    unknown: 'bg-primary',
  },
} as const;

function Progress({ value, tone = 'job', size, done, className, ...props }: ProgressProps) {
  const s = size ?? (tone === 'job' ? 'thin' : 'thick');
  const unknown = value == null;
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-tone={tone}
      value={value}
      // No figure: no value, and no made-up words for one (Base UI would say "indeterminate progress").
      {...(unknown ? { 'aria-valuetext': undefined } : {})}
      className={cn('relative block w-full overflow-hidden bg-border', s === 'thin' ? 'h-[3px] rounded-2' : 'h-[6px] rounded-pill', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        data-done={done ? '' : undefined}
        className={cn(
          'block h-full', s === 'thin' ? 'rounded-2' : 'rounded-[inherit]',
          unknown ? cn('w-[35%] animate-[progress-travel_1.2s_linear_infinite]', FILL[tone].unknown) : FILL[tone].known,
        )}
      />
    </ProgressPrimitive.Root>
  );
}

type MeterProps = Omit<MeterPrimitive.Root.Props, 'className'> & { className?: string };

function Meter({ className, ...props }: MeterProps) {
  return (
    <MeterPrimitive.Root data-slot="meter" className={cn('relative flex h-[20px] w-full items-center', className)} {...props}>
      <MeterPrimitive.Track data-slot="meter-track" className="block h-[10px] w-full overflow-hidden rounded-pill border border-solid border-check-border bg-check-ground">
        {/* (Base UI gives it the track's height, border and all: it fills the inside.) */}
        <MeterPrimitive.Indicator data-slot="meter-indicator" className="block h-full! bg-meter-fill" />
      </MeterPrimitive.Track>
    </MeterPrimitive.Root>
  );
}

export { Progress, Meter };

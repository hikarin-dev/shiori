// What every section of /components is made of: a section per component, a row per shape of the
// design inventory (its id, where today's app uses it), and a specimen per state. A specimen is the
// component itself, its measured element tagged data-specimen (the inventory's shape id),
// data-variant and data-state, which is what the parity check (plans/frontend-react-probes/parity)
// and the browser tests find it by. Hover, press and keyboard focus are shown still through
// data-force (index.css); disabled, on and invalid are the component's own props.
import type { ReactNode } from 'react';

export type State = 'rest' | 'hover' | 'active' | 'focus' | 'disabled' | 'on' | 'invalid';

const FORCED: Partial<Record<State, string>> = { hover: 'hover', active: 'active', focus: 'focus-visible' };

// The data attributes a specimen's measured element carries.
export function tag(shape: string, variant: string, state: State): Record<string, string> {
  const out: Record<string, string> = { 'data-specimen': shape, 'data-variant': variant, 'data-state': state };
  if (FORCED[state]) out['data-force'] = FORCED[state]!;
  return out;
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[16px]" data-section={id}>
      <h2 className="text-13 font-semibold text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

// One shape: its name and id, where it is used today, and its specimens.
export function Shape({ id, name, used, children }: { id: string; name: string; used: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[8px] border-t border-border pt-[12px]" data-shape={id}>
      <div className="flex flex-wrap items-baseline gap-x-[10px]">
        <span className="text-12 font-semibold">{name}</span>
        <code className="text-11 text-muted-dim">{id}</code>
      </div>
      <p className="text-11 text-muted-foreground">{used}</p>
      {children}
    </div>
  );
}

// A line of specimens: the variant's name, then each state with its name under it.
export function Line({ label, states, render }: { label: string; states: readonly State[]; render: (state: State) => ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-[16px]">
      <span className="w-[120px] shrink-0 pt-[6px] text-11 text-muted-dim">{label}</span>
      {states.map((state) => (
        <div key={state} className="flex flex-col items-start gap-[4px]">
          {render(state)}
          <span className="text-10 text-muted-dim">{state}</span>
        </div>
      ))}
    </div>
  );
}

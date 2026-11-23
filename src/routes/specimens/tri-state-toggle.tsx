// TriStateToggle's specimens: any, show only and hide, in each state, as wide as a filter column.
import { useState } from 'react';
import { TriStateToggle, type TriState } from '@/components/ui/tri-state-toggle';
import { Line, Section, Shape, tag, type State } from './specimen';

const STATES: readonly State[] = ['rest', 'hover', 'active', 'focus', 'disabled'];

export function TriStateSpecimens() {
  const [value, setValue] = useState<TriState>('off');
  return (
    <Section id="tri-state" title="TriStateToggle">
      <Shape id="fopt" name="Three-state filter option" used="The library's filter dialog: rating and category (any → show only → hide).">
        {([['off', 'suggestive'], ['include', 'safe'], ['exclude', 'misc']] as const).map(([v, label]) => (
          <Line key={v} label={v} states={STATES} render={(state) => (
            <TriStateToggle className="w-[137px]" value={v} label={label} disabled={state === 'disabled'} {...tag('fopt', v, state)} />)} />
        ))}
        <Line label="press it" states={['rest']} render={() => <TriStateToggle className="w-[137px]" value={value} onValueChange={setValue} label="romance" data-tri-demo />} />
      </Shape>
    </Section>
  );
}

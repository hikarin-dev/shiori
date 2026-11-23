// Slider's specimens: a value along the reader settings' width, in each state, and one at each end.
import { useState } from 'react';
import { Slider } from '@/components/ui/slider';
import { Line, Section, Shape, tag } from './specimen';

export function SliderSpecimens() {
  const [value, setValue] = useState(12);
  return (
    <Section id="slider" title="Slider">
      <Shape id="rs-range" name="Reader settings slider" used="Reader settings: page gap, dim pages, auto-scroll speed.">
        <Line label="at 40 of 100" states={['rest', 'hover', 'focus', 'disabled']} render={(state) => (
          <div className="w-[442px]"><Slider defaultValue={40} aria-label="Page gap" disabled={state === 'disabled'} {...tag('rs-range', 'slider', state)} /></div>)} />
        <Line label="the ends" states={['rest']} render={() => (
          <div className="flex w-[442px] flex-col gap-[8px]">
            <Slider defaultValue={0} aria-label="Least" />
            <Slider defaultValue={100} aria-label="Most" />
          </div>)} />
        <Line label="move it" states={['rest']} render={() => (
          <div className="flex w-[442px] items-center gap-[12px]">
            <Slider value={value} onValueChange={(v) => setValue(v as number)} min={0} max={30} step={1} aria-label="Gap" data-slider-demo />
            <output className="w-[30px] text-11 text-muted-foreground tabular-nums">{value}</output>
          </div>)} />
      </Shape>
    </Section>
  );
}

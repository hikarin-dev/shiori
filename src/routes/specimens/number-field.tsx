// NumberField's specimens: reader settings' zoom stepper, in its states and at its ends.
import { NumberField } from '@/components/ui/number-field';
import { Line, Section, Shape, tag } from './specimen';

const PERCENT = { style: 'percent' } as const;

export function NumberFieldSpecimens() {
  return (
    <Section id="number-field" title="NumberField">
      <Shape id="rs-stepper-btn" name="Stepper" used="Reader settings: Zoom.">
        <Line label="the field" states={['rest', 'focus', 'disabled']} render={(state) => (
          <NumberField defaultValue={0.46} min={0.1} max={4} step={0.1} format={PERCENT} aria-label="Zoom" decrementLabel="Zoom out" incrementLabel="Zoom in" disabled={state === 'disabled'} {...tag('rs-stepper', 'track', state)} />)} />
        <Line label="a button" states={['rest', 'hover', 'active', 'focus', 'disabled']} render={(state) => (
          <NumberField defaultValue={state === 'disabled' ? 0.1 : 0.46} min={0.1} max={4} step={0.1} format={PERCENT} aria-label="Zoom" decrementLabel="Zoom out" incrementLabel="Zoom in"
            {...tag('rs-stepper-btn', 'step', state)} />)} />
        <Line label="step it" states={['rest']} render={() => (
          <NumberField defaultValue={1} min={0.5} max={1.5} step={0.1} format={PERCENT} aria-label="Zoom" decrementLabel="Zoom out" incrementLabel="Zoom in" data-stepper-demo />)} />
      </Shape>
    </Section>
  );
}

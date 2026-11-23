// Switch's specimens: off and on, in each state.
import { Switch } from '@/components/ui/switch';
import { Line, Section, Shape, tag } from './specimen';

export function SwitchSpecimens() {
  return (
    <Section id="switch" title="Switch">
      <Shape id="switch" name="Switch" used="Settings (12), reader settings (8), the library folders' remove dialog, the study preview's furigana, the desktop panel.">
        <Line label="off" states={['rest', 'hover', 'active', 'focus', 'disabled']} render={(state) => <Switch aria-label="Off" disabled={state === 'disabled'} {...tag('switch', 'switch', state)} />} />
        <Line label="on" states={['on']} render={(state) => <Switch aria-label="On" defaultChecked {...tag('switch', 'switch', state)} />} />
        <Line label="on, disabled" states={['disabled']} render={(state) => <Switch aria-label="On" defaultChecked disabled {...tag('switch', 'switch-on', state)} />} />
      </Shape>
    </Section>
  );
}

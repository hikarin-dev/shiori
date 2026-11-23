// Checkbox's and RadioGroup's specimens, each beside a label as the dialogs set them.
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Line, Section, Shape, tag } from './specimen';

const row = 'flex items-center gap-[8px] text-12';

export function CheckboxSpecimens() {
  return (
    <Section id="checkbox" title="Checkbox and RadioGroup">
      <Shape id="native-checkbox" name="Checkbox" used="The export choice (include translations), advanced translation options, benchmark picks, feedback issues and related bubbles.">
        <Line label="unticked" states={['rest', 'hover', 'active', 'focus', 'disabled']} render={(state) => (
          <label className={row}><Checkbox disabled={state === 'disabled'} {...tag('native-checkbox', 'checkbox', state)} />Include translations</label>)} />
        <Line label="ticked" states={['on', 'disabled']} render={(state) => (
          <label className={row}><Checkbox defaultChecked disabled={state === 'disabled'} {...tag('native-checkbox', state === 'on' ? 'checkbox' : 'checkbox-on', state)} />Include translations</label>)} />
      </Shape>
      <Shape id="native-radio" name="RadioGroup" used="The export format choice (ZIP, CBZ, metadata only), inside its option cards.">
        <Line label="unchosen" states={['rest', 'hover', 'active', 'focus', 'disabled']} render={(state) => (
          <RadioGroup disabled={state === 'disabled'} className="gap-[6px]">
            <label className={row}><RadioGroupItem value="zip" {...tag('native-radio', 'radio', state)} />ZIP</label>
          </RadioGroup>)} />
        <Line label="chosen" states={['on', 'disabled']} render={(state) => (
          <RadioGroup defaultValue="zip" disabled={state === 'disabled'} className="gap-[6px]">
            <label className={row}><RadioGroupItem value="zip" {...tag('native-radio', state === 'on' ? 'radio' : 'radio-on', state)} />ZIP</label>
          </RadioGroup>)} />
        <Line label="a group" states={['rest']} render={() => (
          <RadioGroup defaultValue="cbz" className="gap-[6px]" data-radio-demo>
            <label className={row}><RadioGroupItem value="zip" />ZIP</label>
            <label className={row}><RadioGroupItem value="cbz" />CBZ</label>
            <label className={row}><RadioGroupItem value="meta" />Metadata only</label>
          </RadioGroup>)} />
      </Shape>
    </Section>
  );
}

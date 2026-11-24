// Kbd's specimens: each cap where today's app sets one, with today's keys.
import { Kbd } from '@/components/ui/kbd';
import { Line, Section, Shape, tag } from './specimen';

export function KbdSpecimens() {
  return (
    <Section id="kbd" title="Kbd">
      <Shape id="kb-key" name="Keys dialog key" used="The reader's keyboard shortcuts dialog (S14: 20px).">
        <Line label="default" states={['rest']} render={(state) => (
          <div className="flex w-[370px] items-center justify-between gap-[8px] py-[5px] text-11">
            <span className="text-muted-foreground">Next page</span>
            <span className="flex gap-[4px]"><Kbd {...tag('kb-key', 'default', state)}>→</Kbd><Kbd>D</Kbd><Kbd>Shift+→</Kbd><Kbd>Double-click</Kbd></span>
          </div>)} />
      </Shape>
      <Shape id="ctx-kbd" name="Menu shortcut" used="The reader's page menu: an item's key (F32: the keys dialog's radius and text colour, 1.3's size).">
        <Line label="default" states={['rest']} render={(state) => (
          <span className="block w-[290px] text-12">Page properties <Kbd size="menu" {...tag('ctx-kbd', 'default', state)}>I</Kbd></span>)} />
      </Shape>
      <Shape id="rs-kbd" name="Reader settings shortcut" used="Reader settings: in a choice's corner, or after a setting's name (F21: 8.5 → 9px; S14: 16px).">
        <Line label="outline · sm" states={['rest']} render={(state) => (
          <span className="flex items-start gap-[8px]"><Kbd variant="outline" {...tag('rs-kbd', 'outline', state)}>1</Kbd><Kbd variant="outline">Shift+E</Kbd></span>)} />
      </Shape>
    </Section>
  );
}

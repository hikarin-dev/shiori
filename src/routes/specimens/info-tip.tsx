// InfoTip's specimens: beside a Settings name and a reader settings name, each with today's words;
// rest the pointer on one to see its explanation.
import { InfoTip } from '@/components/ui/info-tip';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag, type State } from './specimen';

const STATES: readonly State[] = ['rest', 'hover', 'focus'];

export function InfoTipSpecimens() {
  const t = useT();
  return (
    <Section id="info-tip" title="InfoTip">
      <Shape id="field-info" name="(i) info icon" used="Settings' names (1), reader settings' names (10): more detail under the pointer; the keyboard reaches it and a screen reader reads it.">
        <Line label="Settings" states={STATES} render={(state) => (
          <div className="text-12 leading-[1.45] font-semibold"><span>{t('set.snapshots')}</span><InfoTip tip={t('set.snapshots_info')} {...tag('field-info', 'settings', state)} /></div>)} />
        <Line label="reader settings" states={['rest']} render={(state) => (
          <div className="text-11 font-semibold text-muted-foreground"><span>{t('rd.nav_direction')}</span><InfoTip tip={t('rd.nav_direction_desc')} {...tag('field-info', 'reader', state)} /></div>)} />
      </Shape>
    </Section>
  );
}

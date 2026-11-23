// Collapsible's specimens: Settings' advanced options group (closed and open), page properties' parts
// (closed and open), the benchmark's framed part; each header in its states.
import { Collapsible } from '@/components/ui/collapsible';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag, type State } from './specimen';

const STATES: readonly State[] = ['rest', 'hover', 'focus'];

export function CollapsibleSpecimens() {
  const t = useT();
  return (
    <Section id="collapsible" title="Collapsible">
      <Shape id="tcfg-collapsible" name="Collapsible group header" used="Settings → Translation → Advanced settings: Pipeline details (F18: the group heading's type; a chevron for ▾/›).">
        <Line label="group, closed" states={STATES} render={(state) => (
          <div className="w-[718px] max-w-[calc(100vw-200px)]">
            <Collapsible variant="group" title={t('tm.advanced')} triggerProps={tag('tcfg-collapsible', 'closed', state)}>
              <div className="pt-[9px] text-11 text-muted-foreground">{t('tm.detection')}</div>
            </Collapsible>
          </div>)} />
        <Line label="group, open" states={['rest']} render={(state) => (
          <div className="w-[718px] max-w-[calc(100vw-200px)]">
            <Collapsible variant="group" defaultOpen title={t('tm.advanced')} triggerProps={tag('tcfg-collapsible', 'open', state)}>
              <div className="pt-[9px] text-11 text-muted-foreground">{t('tm.detection')}</div>
            </Collapsible>
          </div>)} />
      </Shape>
      <Shape id="pp-details" name="Disclosure" used="Page properties: all settings, the builds, the text table (T7: its triangle drawn, as Chromium's).">
        <Line label="details, closed" states={STATES} render={(state) => (
          <div className="w-[728px] max-w-[calc(100vw-200px)]">
            <Collapsible title={t('page.all_settings', { n: 12 })} triggerProps={tag('pp-details', 'closed', state)}>
              <div className="text-11 text-muted-foreground">…</div>
            </Collapsible>
          </div>)} />
        <Line label="details, open" states={['rest']} render={(state) => (
          <div className="w-[728px] max-w-[calc(100vw-200px)]">
            <Collapsible defaultOpen title={`${t('page.text')} (3)`} triggerProps={tag('pp-details', 'open', state)}>
              <div className="text-11 text-muted-foreground">…</div>
            </Collapsible>
          </div>)} />
        <Line label="box" states={['rest']} render={(state) => (
          <div className="w-[728px] max-w-[calc(100vw-200px)]">
            <Collapsible variant="box" title="Server log" triggerProps={tag('pp-details', 'box', state)}>
              <pre className="text-11">…</pre>
            </Collapsible>
          </div>)} />
      </Shape>
    </Section>
  );
}

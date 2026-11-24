// SettingRow's specimens: Settings' row kinds in a section, at the panel's desktop width (848px, its
// rows 846) and, below, the same section in a 264px panel (a phone's: the narrow forms).
import { Card, CardHeader } from '@/components/ui/card';
import { SettingRow } from '@/components/ui/setting-row';
import { Select, type SelectOption } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CardTitle } from '@/components/ui/text';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag, type State } from './specimen';

const LANGS: SelectOption[] = [['en', 'English'], ['ja', '日本語'], ['de', 'Deutsch']].map(([value, label]) => ({ value, label }));

function Rows({ state, where }: { state: State; where: string }) {
  const t = useT();
  const at = (kind: string) => tag('setting-row', `${kind}${where}`, state);
  return (
    <Card>
      <CardHeader><CardTitle>{t('set.language')}</CardTitle></CardHeader>
      <SettingRow description={t('set.language_desc')} control={<Select options={LANGS} defaultValue="en" aria-label={t('set.language')} />} {...at('field')} />
      <SettingRow label={t('set.tr_server_url')} description={t('set.tr_server_desc')} control={<Select options={LANGS} defaultValue="en" />} {...at('labelled')} />
      <SettingRow label={t('set.tr_server')} description={t('set.tr_server_desc')} control={<Select options={LANGS} defaultValue="en" />}
        status={<Badge variant="status" tone="warning">{t('set.tr_offline')}</Badge>} {...at('status')} />
      <SettingRow kind="switch" label={t('set.lib_nav_stats')} description={t('set.lib_nav_stats_desc')} control={<Switch defaultChecked />} {...at('switch')} />
      <SettingRow kind="switch" sub label={t('set.snapshots_revert')} description={t('set.snapshots_revert_desc')} control={<Switch />} {...at('sub')} />
      <SettingRow kind="action" label={t('set.export_backup')} description={t('set.export_backup_desc')} control={<Button variant="solid">{t('common.export')}</Button>} {...at('action')} />
      <SettingRow kind="footer" {...at('footer')}><Button variant="danger-subtle">{t('common.reset')}</Button></SettingRow>
    </Card>
  );
}

export function SettingRowSpecimens() {
  return (
    <Section id="setting-row" title="SettingRow">
      <Shape id="setting-row" name="Setting rows" used="Every Settings card: a field (a box to choose in, with a status under it), a switch, a sub-setting, an action, the footer of buttons.">
        <Line label="desktop" states={['rest']} render={(state) => (
          <div className="w-[848px] max-w-[calc(100vw-126px)] @container/settings-panel"><Rows state={state} where="" /></div>)} />
        <Line label="a phone's panel" states={['rest']} render={(state) => (
          <div className="w-[264px] @container/settings-panel"><Rows state={state} where="-narrow" /></div>)} />
      </Shape>
    </Section>
  );
}

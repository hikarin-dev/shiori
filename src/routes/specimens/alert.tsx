// Alert's and StatusText's specimens: the advanced options' note, and a section's status line in its
// tones, shown and hidden, in a row of buttons and under a section's rows.
import { Alert, StatusText } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SettingRow } from '@/components/ui/setting-row';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

export function AlertSpecimens() {
  const t = useT();
  return (
    <Section id="alert" title="Alert and StatusText">
      <Shape id="caps-note" name="Inline notice" used="Settings → Translation → Advanced settings: why the options are missing.">
        <Line label="alert" states={['rest']} render={(state) => <div className="w-[718px] max-w-[calc(100vw-200px)]"><Alert role="status" {...tag('caps-note', 'alert', state)}>{t('tm.caps_offline')}</Alert></div>} />
      </Shape>
      <Shape id="status-msg" name="Status line" used="Settings sections: saved, done, or what went wrong; gone again after a moment.">
        <Line label="in a row of buttons" states={['rest']} render={(state) => (
          <div className="w-[848px] max-w-[calc(100vw-200px)] @container/settings-panel">
            <Card>
              <SettingRow kind="footer">
                <StatusText tone="ok" {...tag('status-msg', 'ok', state)}>{t('set.clear_done')}</StatusText>
                <Button variant="danger">{t('common.reset')}</Button>
              </SettingRow>
            </Card>
          </div>)} />
        <Line label="under a section's rows" states={['rest']} render={(state) => (
          <div className="w-[848px] max-w-[calc(100vw-200px)] @container/settings-panel">
            <Card>
              <SettingRow description={t('set.language_desc')} control={<span />} />
              <StatusText place="section" tone="err" {...tag('status-msg', 'err', state)}>{t('dlg.export_fail_title')}</StatusText>
              <StatusText place="section" shown={false} {...tag('status-msg', 'hidden', state)} />
            </Card>
          </div>)} />
        <Line label="muted" states={['rest']} render={(state) => <StatusText {...tag('status-msg', 'muted', state)}>{t('common.saved')}</StatusText>} />
      </Shape>
    </Section>
  );
}

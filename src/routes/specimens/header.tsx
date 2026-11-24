// The header's specimens: AppHeader in each page's form, 1200px wide (the column's width on a phone).
// Each stands in a box that clips it, so its stickiness holds it in place there instead of to the
// window's top. Its phone form shows at a phone's width (600px or less). The page menu is Select's
// ghost look, the one the page menu takes.
import type { ReactNode } from 'react';
import { Settings, Square } from 'lucide-react';
import { AppHeader } from '@/components/ui/app-header';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Stat } from '@/components/ui/stat';
import { useT } from '@/lib/i18n';
import { Section, Shape, tag } from './specimen';

function Framed({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[4px]">
      <div className="w-[1200px] max-w-full overflow-hidden">{children}</div>
      <span className="text-10 text-muted-dim">{label}</span>
    </div>
  );
}

export function HeaderSpecimens() {
  const t = useT();
  const page = (id: string, label: string) => (
    <Select variant="ghost" className="brand-page page-nav" aria-label={t('nav.go_to')} options={[{ value: id, label }]} value={id} />
  );
  const settings = <Button variant="quiet" tone="primary" size="icon" coarse="40" aria-label={t('nav.settings')} data-tip={t('nav.settings')}><Settings className="size-[16px]" /></Button>;
  return (
    <Section id="header" title="Header">
      <Shape id="app-header" name="Page header" used="Library, Overview and Tasks: the brand, the page menu after a '/', the page's buttons at the right (sticky, 54px).">
        <Framed label="Tasks">
          <AppHeader
            page={page('tasks', t('tasks.title'))}
            right={<>
              <Stat value={2} label={t('tasks.running')} />
              <Button variant="tint" tone="danger" size="compact" coarse="40"><Square className="fill-current" />{t('tasks.stop_all')}</Button>
              {settings}
            </>}
            {...tag('app-header', 'default', 'rest')}
          />
        </Framed>
        <Framed label="Overview">
          <AppHeader page={page('overview', t('nav.overview'))} right={settings} {...tag('app-header', 'overview', 'rest')} />
        </Framed>
        <Framed label="the frame alone (/components, and index.html before any script)">
          <AppHeader {...tag('app-header', 'frame', 'rest')} />
        </Framed>
      </Shape>
      <Shape id="settings-header" name="Settings header" used="Settings: the two parts held apart, About at the right; 12px in at 520px or less. F33 (your call): opaque as the other pages', or 1.3's see-through blur.">
        <Framed label="opaque (F33)">
          <AppHeader form="settings" page={page('settings', t('nav.settings'))} right={<Button variant="subtle" size="sm">{t('nav.about')}</Button>} {...tag('settings-header', 'opaque', 'rest')} />
        </Framed>
        <Framed label="translucent (1.3)">
          <AppHeader form="settings" translucent page={page('settings', t('nav.settings'))} right={<Button variant="subtle" size="sm">{t('nav.about')}</Button>} {...tag('settings-header', 'translucent', 'rest')} />
        </Framed>
      </Shape>
    </Section>
  );
}

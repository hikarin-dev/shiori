// The header's specimens: AppHeader in each page's form, 1200px wide (on a phone, the window's width,
// as a page's header is).
// Each stands in a box that clips it, so its stickiness holds it in place there instead of to the
// window's top. Its phone form shows at a phone's width (600px or less). Choosing a page in a page
// menu here goes to it, as on its page.
import type { ReactNode } from 'react';
import { Eye, Menu, Pin, Settings, Square, Upload } from 'lucide-react';
import { AppHeader } from '@/components/ui/app-header';
import { Button } from '@/components/ui/button';
import { PageMenu, type Page } from '@/components/ui/page-menu';
import { SearchField } from '@/components/ui/search-field';
import { Stat } from '@/components/ui/stat';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag, type State } from './specimen';

function Framed({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[4px]">
      <div className="w-[1200px] max-w-full overflow-hidden [@media(max-width:600px)]:-mx-[20px] [@media(max-width:600px)]:w-[100vw] [@media(max-width:600px)]:max-w-none">{children}</div>
      <span className="text-10 text-muted-dim">{label}</span>
    </div>
  );
}

export function HeaderSpecimens() {
  const t = useT();
  const page = (id: Page, state: State = 'rest') => <PageMenu page={id} id={`pageNav-${id}-${state}`} {...tag('page-menu', id, state)} />;
  const settings = <Button variant="quiet" tone="primary" size="icon" coarse="40" aria-label={t('nav.settings')} data-tip={t('nav.settings')}><Settings className="size-[16px]" /></Button>;
  return (
    <Section id="header" title="Header">
      <Shape id="app-header" name="Page header" used="Library, Overview and Tasks: the brand, the page menu after a '/', the page's buttons at the right (sticky, 54px).">
        <Framed label="Library (its search: type, or focus it for its list)">
          <AppHeader
            page={page('library')}
            search={<SearchField placeholder={t('lib.search_ph')} clearLabel={t('lib.clear_search')} defaultQuery={'category:"manga" '} {...tag('header-search', 'library', 'rest')} />}
            left={<Button variant="quiet" tone="warning" size="icon" coarse="40" aria-label={t('nav.pin')} data-tip={t('nav.pin')}><Pin className="size-[14px]" /></Button>}
            right={<>
              <Button variant="quiet" size="icon" coarse="40" aria-label={t('nav.menu')} data-tip={t('nav.menu')}><Menu className="size-[16px]" /></Button>
              <Button variant="tint" tone="warning" size="icon" coarse="40" aria-label={t('nav.import')} data-tip={t('nav.import')}><Upload /></Button>
              <Button variant="quiet" tone="warning" pressedTone="success" size="icon" coarse="40" aria-label={t('nav.safe_on')} data-tip={t('nav.safe_on')}><Eye /></Button>
              {settings}
            </>}
            {...tag('app-header', 'library', 'rest')}
          />
        </Framed>
        <Framed label="Tasks">
          <AppHeader
            page={page('tasks')}
            right={<>
              <Stat value={2} label={t('tasks.running')} />
              <Button variant="tint" tone="danger" size="compact" coarse="40"><Square className="fill-current" />{t('tasks.stop_all')}</Button>
              {settings}
            </>}
            {...tag('app-header', 'default', 'rest')}
          />
        </Framed>
        <Framed label="Overview">
          <AppHeader page={page('overview')} right={settings} {...tag('app-header', 'overview', 'rest')} />
        </Framed>
        <Framed label="the frame alone (/components, and index.html before any script)">
          <AppHeader {...tag('app-header', 'frame', 'rest')} />
        </Framed>
      </Shape>
      <Shape id="page-menu" name="Page menu" used="Every page's header: '/ Library ▾', the page's name as a menu of the app's pages (a gallery's overview where the address names one, the reader in the reader). Choosing one goes there.">
        <Line label="ghost · xs" states={['rest', 'hover', 'focus']} render={(state) => <div className="flex items-center gap-[10px]"><span className="brand-sep">/</span>{page('library', state)}</div>} />
      </Shape>
      <Shape id="settings-header" name="Settings header" used="Settings: the common header, About at the right. F33 (your call): opaque as the other pages', or 1.3's see-through blur.">
        <Framed label="opaque (F33)">
          <AppHeader page={page('settings')} right={<Button variant="subtle" size="sm">{t('nav.about')}</Button>} {...tag('settings-header', 'opaque', 'rest')} />
        </Framed>
        <Framed label="translucent (1.3)">
          <AppHeader translucent page={<PageMenu page="settings" id="pageNav-settings-translucent" />} right={<Button variant="subtle" size="sm">{t('nav.about')}</Button>} {...tag('settings-header', 'translucent', 'rest')} />
        </Framed>
      </Shape>
    </Section>
  );
}

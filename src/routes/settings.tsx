// settings.tsx — the Settings page: a side nav of panels (Library, Reader, Translation, Storage), each
// a column of sections. Every panel stays mounted and the hidden ones are not displayed, so a panel
// keeps its controls' state while another shows, and choosing one changes no address (as 1.3's).
//
// Drawn as 1.3's page (app/settings.html, settings.css) on Settings' sizes (shadcn's stock scale:
// §5.3 S01–S21): the column 1120px wide at most, 36px 28px 88px round; the nav 176px wide and 40px
// from the panels, sticky 82px from the top; at 760px or less 128px and 20 apart (26px 16px 72px
// round, sticky at 74), at 520px or less 96px and 10 apart (22px 10px 64px, sticky at 68), at 380px
// or less 84px and 8 apart (8px at the sides). The page's text on a 1.5 line. The panels' container
// is named settings-panel: Card and SettingRow answer its width (their narrow forms at 560 and 480).
// The header takes Settings' form (the route table's 'form'): its parts held apart, the page menu after
// its "/", About at the right.
//
// The ids and states 1.3's page had are kept (#settingsNav, .nav-item[data-panel][aria-current] and
// .active, .settings-panels, .panel and .active, #panelLibrary…, each control's id). In the desktop
// app's window a System panel comes before Storage (./settings/system.tsx).
import { useLayoutEffect, useState } from 'react';
import { HeaderSlot } from '@/components/header-slot';
import { Button } from '@/components/ui/button';
import { PageMenu } from '@/components/ui/page-menu';
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs';
import * as api from '@lib/api.js';
import { useT } from '@/lib/i18n';
import { useTitle } from '@/lib/title';
import { cn } from '@/lib/utils';
import { AboutDialog } from './settings/about';
import { LibraryPanel } from './settings/library';
import { prefs } from './settings/parts';
import { ReaderPanel } from './settings/reader';
import { StoragePanel } from './settings/storage';
import { SystemPanel } from './settings/system';
import { TranslationPanel } from './settings/translation';

// The panels, in the nav's order: the panel's id is the nav item's value (data-panel), its nav item's
// id and name. System is the desktop app's window's alone (1.3 put it there, before Storage).
const PANELS = [
  { id: 'panelLibrary', nav: 'navLibrary', label: 'set.nav_library', Panel: LibraryPanel },
  { id: 'panelReader', nav: 'navReader', label: 'set.nav_reader', Panel: ReaderPanel },
  { id: 'panelTranslation', nav: 'navTranslation', label: 'set.nav_translation', Panel: TranslationPanel },
  ...(api.capabilities.desktopWindow ? [{ id: 'panelDesktop', nav: 'navDesktop', label: 'set.nav_desktop', Panel: SystemPanel }] : []),
  { id: 'panelStorage', nav: 'navStorage', label: 'set.nav_storage', Panel: StoragePanel },
] as const;

export default function Settings() {
  useTitle('Settings');
  const t = useT();
  const [shown, setShown] = useState<string>('panelLibrary');
  const [about, setAbout] = useState(false);
  // Other tabs' changes to the page's preferences are followed while it shows.
  useLayoutEffect(() => { prefs.start(); return () => prefs.stop(); }, []);

  return (
    <>
      <HeaderSlot side="left"><span className="brand-sep">/</span><PageMenu page="settings" /></HeaderSlot>
      <HeaderSlot side="right">
        <Button id="aboutBtn" variant="subtle" size="sm" onClick={() => setAbout(true)}>{t('nav.about')}</Button>
      </HeaderSlot>
      {/* Its steps down with the window: 1.3's media queries, inclusive, each a range of its own so no
          two set one value (written out whole: the stylesheet is made from the classes it finds). */}
      <main className={cn('settings-page mx-auto w-[min(100%,1120px)] px-[28px] pt-[36px] pb-[88px] leading-[1.5]',
        '[@media(520px<width<=760px)]:px-[16px] [@media(520px<width<=760px)]:pt-[26px] [@media(520px<width<=760px)]:pb-[72px]',
        '[@media(380px<width<=520px)]:px-[10px] [@media(380px<width<=520px)]:pt-[22px] [@media(380px<width<=520px)]:pb-[64px]',
        '[@media(width<=380px)]:px-[8px] [@media(width<=380px)]:pt-[22px] [@media(width<=380px)]:pb-[64px]')}>
        <Tabs value={shown} onValueChange={setShown} className={cn('content grid w-full min-w-0 grid-cols-[176px_minmax(0,1fr)] items-start gap-[40px]',
          '[@media(520px<width<=760px)]:grid-cols-[128px_minmax(0,1fr)] [@media(520px<width<=760px)]:gap-[20px]',
          '[@media(380px<width<=520px)]:grid-cols-[96px_minmax(0,1fr)] [@media(380px<width<=520px)]:gap-[10px]',
          '[@media(width<=380px)]:grid-cols-[84px_minmax(0,1fr)] [@media(width<=380px)]:gap-[8px]')}>
          <TabsList id="settingsNav" aria-label={t('set.title')} className={cn('settings-nav sticky top-[82px] w-full', '[@media(520px<width<=760px)]:top-[74px]', '[@media(width<=520px)]:top-[68px]')}>
            {PANELS.map(({ id, nav, label }) => (
              <TabsTab key={id} value={id} id={nav} data-panel={id} aria-controls={id} aria-current={shown === id ? 'page' : undefined}
                className={cn('nav-item', shown === id && 'active')}>{t(label)}</TabsTab>
            ))}
          </TabsList>
          <div className="settings-panels w-full min-w-0 @container/settings-panel">
            {/* Every panel mounted; the hidden ones not displayed. */}
            {PANELS.map(({ id, nav, Panel }) => (
              <div key={id} id={id} role="tabpanel" aria-labelledby={nav} hidden={shown !== id} className={cn('panel w-full min-w-0', shown === id && 'active')}>
                <Panel />
              </div>
            ))}
          </div>
        </Tabs>
      </main>
      <AboutDialog open={about} onOpenChange={setAbout} />
    </>
  );
}

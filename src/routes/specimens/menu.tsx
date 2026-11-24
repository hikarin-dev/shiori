// Menu's specimens: the re-run menu, the reader's page menu, a library folder's menu and the
// benchmark's tier checklist drawn in place, still; then working ones: a folder's ⋯ menu, a
// right-click menu, the checklist.
import { useState } from 'react';
import { ContextMenu, ContextMenuTrigger, Menu, MenuCheckboxItem, MenuCheckboxItemStill, MenuContent, MenuGroup, MenuItem, MenuItemStill, MenuPanel, MenuSeparator, MenuTitle, MenuTrigger, MENU_TITLE } from '@/components/ui/menu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ellipsis, FolderOpen } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag, type State } from './specimen';

const TIERS = [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']] as const;

export function MenuSpecimens() {
  const t = useT();
  const [tiers, setTiers] = useState<Record<string, boolean>>({ S: true });
  const rerun = (state: State) => (
    <MenuPanel className="w-[320px]" {...(state === 'rest' ? tag('ctx-menu', 'rerun', state) : {})}>
      <div className={MENU_TITLE}>{t('rerun.title')}</div>
      <MenuItemStill detail={t('rerun.all', { n: 24 })} {...tag('ctx-menu', 'item', state)}>{t('rerun.detect')}</MenuItemStill>
      <MenuItemStill detail={t('rerun.some', { ready: 20, n: 24 })}>{t('rerun.ocr')}</MenuItemStill>
      <MenuItemStill detail={t('rerun.nothing_saved')} disabled {...(state === 'rest' ? tag('ctx-menu', 'item', 'disabled') : {})}>{t('rerun.translate')}</MenuItemStill>
    </MenuPanel>
  );
  return (
    <Section id="menu" title="Menu and ContextMenu">
      <Shape id="ctx-menu" name="Context menu" used="Re-run from… (a translated card's translate button, right-clicked), the reader's page menu (with a key cap), a library folder's ⋯ (a line before what deletes).">
        <Line label="re-run" states={['rest', 'hover']} render={rerun} />
        <Line label="page menu" states={['rest']} render={(state) => (
          <MenuPanel className="min-w-[220px]" {...tag('ctx-menu', 'page', state)}>
            <div className={MENU_TITLE}>{t('page.menu_title', { n: 4 })}</div>
            <MenuItemStill detail={t('page.translate_detail')}>{t('page.translate')}</MenuItemStill>
            <MenuItemStill detail={t('page.properties_detail')} shortcut="I" {...tag('ctx-menu', 'shortcut', state)}>{t('page.properties')}</MenuItemStill>
          </MenuPanel>)} />
        <Line label="folder" states={['rest']} render={(state) => (
          <MenuPanel className="min-w-[170px]" {...tag('ctx-menu', 'folder', state)}>
            <MenuItemStill icon={<FolderOpen />}>{t('lf.open')}</MenuItemStill>
            <MenuItemStill>{t('lf.rescan_one')}</MenuItemStill>
            <MenuSeparator />
            <MenuItemStill danger {...tag('ctx-menu', 'danger', state)}>{t('lf.remove')}</MenuItemStill>
          </MenuPanel>)} />
      </Shape>
      <Shape id="bench-tier-menu" name="Checklist" used="The benchmark's tier filter: ticks that leave it open (F30: the menu's frame; F31: one floating shadow).">
        <Line label="checklist" states={['rest']} render={(state) => (
          <MenuPanel variant="checklist" {...tag('bench-tier-menu', 'checklist', state)}>
            {TIERS.map(([id, name], i) => (
              <MenuCheckboxItemStill key={id} checked={i === 0} {...(i === 1 ? tag('bench-tier-menu', 'option', state) : {})}>
                <Badge variant="inverse">{id}</Badge><span>{name}</span>
              </MenuCheckboxItemStill>
            ))}
          </MenuPanel>)} />
      </Shape>
      <Shape id="menu-open" name="Working menus" used="A folder's ⋯ under its button; a right-click at the pointer; the checklist. Arrows, Home, End, a letter, Enter, Escape.">
        <div className="flex flex-wrap items-start gap-[16px]">
          <Menu>
            <MenuTrigger render={<Button variant="quiet" size="icon" aria-label={t('lf.open')} data-specimen-open="menu" />}><Ellipsis aria-hidden /></MenuTrigger>
            <MenuContent align="end" sideOffset={4} className="min-w-[170px]" data-specimen-menu="folder">
              <MenuItem icon={<FolderOpen />}>{t('lf.open')}</MenuItem>
              <MenuItem>{t('lf.rescan_one')}</MenuItem>
              <MenuSeparator />
              <MenuItem danger>{t('lf.remove')}</MenuItem>
            </MenuContent>
          </Menu>
          <ContextMenu>
            <ContextMenuTrigger data-specimen-open="context" className="grid h-[120px] w-[240px] place-items-center rounded-8 border border-dashed border-border text-11 text-muted-dim">{t('page.menu_title', { n: 4 })}</ContextMenuTrigger>
            <MenuContent context className="min-w-[220px]" data-specimen-menu="context">
              <MenuGroup>
                <MenuTitle>{t('page.menu_title', { n: 4 })}</MenuTitle>
                <MenuItem detail={t('page.translate_detail')}>{t('page.translate')}</MenuItem>
                <MenuItem detail={t('rerun.nothing_saved')} disabled>{t('page.follow')}</MenuItem>
                <MenuItem detail={t('page.properties_detail')} shortcut="I">{t('page.properties')}</MenuItem>
              </MenuGroup>
            </MenuContent>
          </ContextMenu>
          <Menu>
            <MenuTrigger render={<Button data-specimen-open="checklist" />}>{t('rd.tab_pages')}</MenuTrigger>
            <MenuContent variant="checklist" align="end" sideOffset={4} data-specimen-menu="checklist">
              {TIERS.map(([id, name]) => (
                <MenuCheckboxItem key={id} checked={!!tiers[id]} onCheckedChange={(on) => setTiers((all) => ({ ...all, [id]: on }))}>
                  <Badge variant="inverse">{id}</Badge><span>{name}</span>
                </MenuCheckboxItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
      </Shape>
    </Section>
  );
}

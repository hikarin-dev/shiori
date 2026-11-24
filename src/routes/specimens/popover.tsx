// Popover's specimens: the library header's burger panel, the reader bar's ⋯ panel and the reader's
// chapter list drawn in place, still; then a working one opened by its button.
import { Popover, PopoverContent, PopoverHeader, PopoverItem, PopoverList, PopoverPanel, PopoverTrigger } from '@/components/ui/popover';
import { Stat } from '@/components/ui/stat';
import { Button } from '@/components/ui/button';
import { Columns2, Menu as MenuIcon, Settings, X } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

function Stats() {
  const t = useT();
  return (
    <>
      <Stat value={24} label={t('stat.galleries')} />
      <Stat value="1,204" label={t('stat.images')} />
      <Stat value="2.1GB" label={t('stat.stored')} />
    </>
  );
}

function Chapters({ close }: { close?: boolean }) {
  const t = useT();
  return (
    <>
      <PopoverHeader><span>{t('rd.chapters')}</span>{close !== false && <Button variant="ghost" size="icon" aria-label={t('common.close')}><X aria-hidden /></Button>}</PopoverHeader>
      <PopoverList>
        <PopoverItem number="1">Harbor Lights</PopoverItem>
        <PopoverItem number="2" current>The Long Tide</PopoverItem>
        <PopoverItem number="3">Lanterns</PopoverItem>
        <PopoverItem number="4" disabled>Undertow</PopoverItem>
      </PopoverList>
    </>
  );
}

export function PopoverSpecimens() {
  const t = useT();
  return (
    <Section id="popover" title="Popover">
      <Shape id="burger-pop" name="Header panel" used="The library header's burger under 1400px: its totals in a row (12px round, 8 apart; F31: one floating shadow).">
        <Line label="panel" states={['rest']} render={(state) => <PopoverPanel className="flex w-max gap-[8px] p-[12px]" {...tag('burger-pop', 'panel', state)}><Stats /></PopoverPanel>} />
      </Shape>
      <Shape id="overflow-pop" name="Bar overflow" used="The reader's classic bar when too narrow: its secondary buttons behind ⋯ (8px round, 8 apart).">
        <Line label="panel" states={['rest']} render={(state) => (
          <PopoverPanel className="flex w-max items-center gap-[8px] p-[8px]" {...tag('overflow-pop', 'panel', state)}>
            <Button variant="quiet" size="icon" aria-label={t('rd.reader_settings')}><Settings aria-hidden /></Button>
            <Button variant="quiet" size="icon" aria-label={t('rd.tab_pages')}><Columns2 aria-hidden /></Button>
          </PopoverPanel>)} />
      </Shape>
      <Shape id="sn-chapters" name="Chapter list" used="The reader's side navigation: under its chapter pill, the chapters of the series (its own sizes, its own shadow).">
        <Line label="chapters" states={['rest']} render={(state) => <PopoverPanel variant="chapters" {...tag('sn-chapters', 'chapters', state)}><Chapters /></PopoverPanel>} />
      </Shape>
      <Shape id="popover-open" name="Working panel" used="Opened by its button: under it at its end, kept inside the window; Escape or a press outside closes it.">
        <Popover>
          <PopoverTrigger render={<Button variant="quiet" size="icon" aria-label={t('stat.galleries')} data-specimen-open="popover" className="self-end" />}><MenuIcon aria-hidden /></PopoverTrigger>
          <PopoverContent sideOffset={13} className="flex w-max gap-[8px] p-[12px]" data-specimen-popover=""><Stats /></PopoverContent>
        </Popover>
      </Shape>
    </Section>
  );
}

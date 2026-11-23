// OptionCard's specimens: the ask dialog's choices (a title and a line under it, or a title alone),
// Settings' backup choices, and the export dialog's format, a radio group of cards, each at its
// dialog's width.
import { OptionCard, OptionCardRadio } from '@/components/ui/option-card';
import { RadioGroup } from '@/components/ui/radio-group';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag, type State } from './specimen';

const STATES: readonly State[] = ['rest', 'hover', 'focus'];

export function OptionCardSpecimens() {
  const t = useT();
  return (
    <Section id="option-card" title="OptionCard">
      <Shape id="notice-choice" name="Ask option" used="The ask dialog: the desktop app's gates, moving a library, the storage upgrade (F17: radius 9 → 8; one padding, 12px 14px).">
        <Line label="button" states={STATES} render={(state) => (
          <div className="w-[396px]"><OptionCard title={t('gate.open')} detail={t('gate.open_detail')} {...tag('notice-choice', 'button', state)} /></div>)} />
        <Line label="title alone" states={['rest']} render={(state) => (
          <div className="w-[396px]"><OptionCard title={t('gate.browser')} {...tag('notice-choice', 'title', state)} /></div>)} />
      </Shape>
      <Shape id="backup-choice" name="Backup choice" used="Settings → Storage → Export…: what the backup holds (F17: no ground of its own, the brand colour's frame, a 13px bold title).">
        <Line label="button" states={STATES} render={(state) => (
          <div className="w-[398px]"><OptionCard title={t('set.bk_meta')} {...tag('backup-choice', 'button', state)} /></div>)} />
      </Shape>
      <Shape id="native-radio" name="Option card with a radio" used="The export dialog: the format, ZIP or CBZ; the arrows move the choice, the whole card is the target.">
        <Line label="radio" states={['rest']} render={(state) => (
          <RadioGroup defaultValue="zip" aria-label={t('dlg.export_title')} className="w-[394px] gap-[8px]">
            <OptionCardRadio value="zip" title={t('set.lib_export_zip')} detail={t('dlg.export_zip_desc')} {...tag('native-radio', 'card-on', 'on')} />
            <OptionCardRadio value="cbz" title={t('set.lib_export_cbz')} detail={t('dlg.export_cbz_desc')} {...tag('native-radio', 'card', state)} />
          </RadioGroup>)} />
        <Line label="under the pointer" states={['hover']} render={(state) => (
          <RadioGroup defaultValue="zip" aria-label={t('dlg.export_title')} className="w-[394px]">
            <OptionCardRadio value="cbz" title={t('set.lib_export_cbz')} detail={t('dlg.export_cbz_desc')} {...tag('native-radio', 'card', state)} />
          </RadioGroup>)} />
      </Shape>
    </Section>
  );
}

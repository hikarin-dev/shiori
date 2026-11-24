// Settings → Library: the language, the top bar, the gallery cards, the gallery export, and (where the
// app can draw its own scrollbars: Chromium) the experimental section. Each control saved as it
// changes, said so for 2.5 s in its section's status line; the language changes the whole page at once.
import { applyScrollbarPreference, customScrollbarAvailable } from '@lib/scrollbar.js';
import { LANG_NAMES, SUPPORTED, getLang, setLang } from '@lib/i18n.js';
import { Select } from '@/components/ui/select';
import { SettingRow } from '@/components/ui/setting-row';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/lib/i18n';
import { Section, SectionStatus, usePref, useStatus, type PrefKey } from './parts';

const LANGS = (SUPPORTED as string[]).map((code) => ({ value: code, label: (LANG_NAMES as Record<string, string>)[code] || code }));

// A preference's switch in a row of its own; `saved` says it changed. `id`: the control's, where 1.3
// gave it another than the key's.
export function PrefSwitch({ pref, id = pref, label, description, saved, sub }: {
  pref: PrefKey; id?: string; label: string; description: string; saved: () => void; sub?: boolean;
}) {
  const [on, set] = usePref<boolean>(pref);
  return <SettingRow kind="switch" sub={sub} label={label} description={description}
    control={<Switch id={id} checked={on} onCheckedChange={(next) => { set(next); saved(); }} />} />;
}

// A preference's choice from a list, in a row of its own.
function PrefSelect({ pref, label, description, options, saved }: {
  pref: PrefKey; label: string; description: string; options: { value: string; label: string }[]; saved: () => void;
}) {
  const [value, set] = usePref<string>(pref);
  return <SettingRow label={label} description={description}
    control={<Select id={pref} data-value={value} options={options} value={value} onValueChange={(next) => { set(next); saved(); }} />} />;
}

export function LibraryPanel() {
  const t = useT();
  const [bar, showBar] = useStatus();
  const [cards, showCards] = useStatus();
  const [exported, showExported] = useStatus();
  const [experimental, showExperimental] = useStatus();
  const saved = (show: (text: string) => void) => () => show(t('common.saved'));
  const lang = getLang();
  return (
    <>
      <Section title={t('set.language')}>
        <SettingRow description={t('set.language_desc')}
          control={<Select id="langSelect" data-value={lang} aria-label={t('set.language')} options={LANGS} value={lang} onValueChange={setLang} />} />
      </Section>
      <Section title={t('set.lib_bar')}>
        <PrefSwitch pref="libShowNavStats" label={t('set.lib_nav_stats')} description={t('set.lib_nav_stats_desc')} saved={saved(showBar)} />
        <SectionStatus id="libBarStatus" status={bar} />
      </Section>
      <Section title={t('set.lib_cards')}>
        <PrefSwitch pref="libMergeSeries" label={t('set.lib_series_group')} description={t('set.lib_series_group_desc')} saved={saved(showCards)} />
        <PrefSelect pref="libQuickActionsMode" label={t('set.lib_quick_actions')} description={t('set.lib_quick_actions_desc')} saved={saved(showCards)}
          options={[{ value: 'hover', label: t('set.lib_quick_actions_hover') }, { value: 'always', label: t('set.lib_quick_actions_always') }, { value: 'hidden', label: t('set.lib_quick_actions_hidden') }]} />
        <PrefSwitch pref="libHideAppLangFlag" id="libAppLangFlag" label={t('set.lib_applang_flag')} description={t('set.lib_applang_flag_desc')} saved={saved(showCards)} />
        <PrefSwitch pref="libShowCategoryTag" label={t('set.lib_card_category')} description={t('set.lib_card_category_desc')} saved={saved(showCards)} />
        <SectionStatus id="libStatus" status={cards} />
      </Section>
      <Section title={t('set.lib_export')}>
        <PrefSelect pref="libExportFormat" label={t('set.lib_export_format')} description={t('set.lib_export_format_desc')} saved={saved(showExported)}
          options={[{ value: 'ask', label: t('set.lib_export_ask') }, { value: 'zip', label: t('set.lib_export_zip') }, { value: 'cbz', label: t('set.lib_export_cbz') }]} />
        <PrefSwitch pref="libExportTranslations" label={t('set.lib_export_tr')} description={t('set.lib_export_tr_desc')} saved={saved(showExported)} />
        <SectionStatus id="libExportStatus" status={exported} />
      </Section>
      {/* The drawn scrollbars are Chromium's alone (scrollbar.js): elsewhere the section is not there. */}
      <Section id="experimentalSection" title={t('set.experimental')} hidden={!customScrollbarAvailable}>
        <PrefSwitch pref="customScrollbar" label={t('set.custom_scrollbar')} description={t('set.custom_scrollbar_desc')}
          saved={() => { applyScrollbarPreference(); showExperimental(t('common.saved')); }} />
        <SectionStatus id="experimentalStatus" status={experimental} />
      </Section>
    </>
  );
}

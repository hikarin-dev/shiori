// Stat's specimens: the page headers' totals (Tasks' running count, the library's three) and the
// Settings row's total disk writes.
import { Stat } from '@/components/ui/stat';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

export function StatSpecimens() {
  const t = useT();
  return (
    <Section id="stat" title="Stat">
      <Shape id="stat" name="Stat boxes" used="The library's header totals (in the burger's popover under 1400px), Tasks' running count; Settings → Storage → total disk writes.">
        <Line label="header" states={['rest']} render={(state) => (
          <span className="flex gap-[8px]">
            <Stat value={6} label={t('tasks.running')} {...tag('stat', 'header', state)} />
            <Stat value={24} label={t('stat.galleries')} />
            <Stat value="1,204" label={t('stat.images')} />
            <Stat value="2.4 GB" label={t('stat.stored')} />
          </span>)} />
        <Line label="inline" states={['rest']} render={(state) => <Stat variant="inline" value="12.3 MB" {...tag('stat', 'inline', state)} />} />
      </Shape>
    </Section>
  );
}

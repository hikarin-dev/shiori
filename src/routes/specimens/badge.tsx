// Badge's specimens, with today's words: a job's kind and where it runs, Settings' status pills,
// page properties' chips, the series card's chapter count, a page tile's number, the version tag, a
// table's tag, the benchmark's tier.
import { Badge } from '@/components/ui/badge';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

export function BadgeSpecimens() {
  const t = useT();
  return (
    <Section id="badge" title="Badge">
      <Shape id="kind" name="Job kind" used="Tasks rows and the import tracker: what kind of job, in its button's colour.">
        <Line label="kind" states={['rest']} render={(state) => (
          <span className="flex gap-[8px]">
            <Badge variant="kind" tone="warning" {...tag('kind', 'warning', state)}>{t('tasks.kind_download')}</Badge>
            <Badge variant="kind" tone="primary" {...tag('kind', 'primary', state)}>{t('tasks.kind_translate')}</Badge>
            <Badge variant="kind" tone="warning" {...tag('kind', 'import', state)}>{t('tasks.kind_upload')}</Badge>
            <Badge variant="kind" {...tag('kind', 'neutral', state)}>{t('tasks.kind_sync')}</Badge>
          </span>)} />
      </Shape>
      <Shape id="run-tag" name="Runner tag" used="Beside the kind: where the job runs; its tip says what would stop it (F20: 17 → 16px).">
        <Line label="quiet" states={['rest']} render={(state) => <Badge data-tip={t('run.tab_tip')} className="cursor-default" {...tag('run-tag', 'quiet', state)}>{t('run.this_tab')}</Badge>} />
      </Shape>
      <Shape id="key-status-badge" name="Status pill" used="Settings: the translation server's status, a library folder's (F20, and one pill size: 21.9 → 20px).">
        <Line label="status" states={['rest']} render={(state) => (
          <span className="flex gap-[8px]">
            <Badge variant="status" {...tag('key-status-badge', 'neutral', state)}>{t('lf.default')}</Badge>
            <Badge variant="status" tone="warning" {...tag('key-status-badge', 'warning', state)}>{t('set.tr_offline')}</Badge>
            <Badge variant="status" tone="success" {...tag('key-status-badge', 'success', state)}>{t('set.tr_online')}</Badge>
          </span>)} />
      </Shape>
      <Shape id="pp-chip" name="Page status chip" used="Page properties' header: the page's state (F20: the pills' tints and size, 19 → 20px).">
        <Line label="status" states={['rest']} render={(state) => (
          <span className="flex flex-wrap gap-[6px]">
            <Badge variant="status" tone="success" {...tag('pp-chip', 'success', state)}>{t('page.status_translated')}</Badge>
            <Badge variant="status" tone="muted" {...tag('pp-chip', 'muted', state)}>{t('page.follows')}</Badge>
            <Badge variant="status" tone="primary" {...tag('pp-chip', 'primary', state)}>{t('page.keeps_own')}</Badge>
            <Badge variant="status" tone="muted" {...tag('pp-chip', 'study', state)}>{t('page.study')}</Badge>
          </span>)} />
      </Shape>
      <Shape id="card-series-badge" name="Overlay badges" used="A series card's cover (its chapters), an overview page tile (its number).">
        <Line label="overlay" states={['rest']} render={(state) => (
          <span className="flex items-start gap-[8px] rounded-8 bg-image-ground p-[8px]"><Badge variant="overlay" {...tag('card-series-badge', 'overlay', state)}>{t('card.chapters_n', { n: 4 })}</Badge></span>)} />
        <Line label="page" states={['rest']} render={(state) => (
          <span className="flex items-end gap-[8px] rounded-6 bg-image-ground p-[4px]"><Badge variant="page" {...tag('card-series-badge', 'page', state)}>1</Badge><Badge variant="page">12</Badge></span>)} />
      </Shape>
      <Shape id="about-version" name="Version tag" used="The About dialog's header (F20: no ground of its own, 9.5 → 10px; one size with Settings' badges, 20.3 → 20px).">
        <Line label="quiet" states={['rest']} render={(state) => <Badge size="sm" {...tag('about-version', 'quiet', state)}>v1.3.0</Badge>} />
      </Shape>
      <Shape id="pp-tag" name="Table tag" used="Page properties' text table: a line's note (F20: 9 → 10px, radius 3 → 4).">
        <Line label="quiet" states={['rest']} render={(state) => <span className="text-11">Hello there <Badge {...tag('pp-tag', 'quiet', state)}>filtered</Badge></span>} />
      </Shape>
      <Shape id="inverse-badge" name="Inverse badge" used="The benchmark's gallery tiers (F20: one line, 16px). The tooltip's own badge is tooltip.js's (T10).">
        <Line label="inverse" states={['rest']} render={(state) => <Badge variant="inverse" {...tag('inverse-badge', 'inverse', state)}>2.2 MP</Badge>} />
      </Shape>
    </Section>
  );
}

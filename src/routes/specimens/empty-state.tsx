// EmptyState's specimens, with today's words: the library's (two lines), Tasks', the overview's
// loading line, the reader's full screen (here inside a frame), the overview's small empties, page
// properties' note.
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

export function EmptyStateSpecimens() {
  const t = useT();
  return (
    <Section id="empty-state" title="EmptyState">
      <Shape id="empty" name="Empty results" used="The library (no results, an empty library: two lines), Tasks (nothing running), the overview (not found; F23: 14 → 13px).">
        <Line label="page · loose" states={['rest']} render={(state) => (
          <div className="w-[1217px] max-w-[calc(100vw-200px)]"><EmptyState loose {...tag('empty', 'library', state)}>{t('lib.empty_title')}<br />{t('lib.empty_sub')}</EmptyState></div>)} />
        <Line label="page" states={['rest']} render={(state) => (
          <div className="w-[912px] max-w-[calc(100vw-200px)]"><EmptyState {...tag('empty', 'tasks', state)}>{t('tasks.empty')}</EmptyState></div>)} />
      </Shape>
      <Shape id="loading-text" name="Loading text" used="The overview before the gallery is read (F23: 14 → 13px); page properties while it reads (a note).">
        <Line label="page" states={['rest']} render={(state) => (
          <div className="w-[912px] max-w-[calc(100vw-200px)]"><EmptyState role="status" {...tag('loading-text', 'page', state)}>{t('ov.loading')}</EmptyState></div>)} />
        <Line label="inline · note" states={['rest']} render={(state) => (
          <div className="w-[580px] max-w-[calc(100vw-200px)]"><EmptyState variant="inline" size="note" role="status" {...tag('loading-text', 'note', state)}>{t('page.loading')}</EmptyState></div>)} />
      </Shape>
      <Shape id="reader-empty" name="Reader empty screen" used="The reader with no such gallery: the whole window (shown here inside a frame).">
        <Line label="screen" states={['rest']} render={(state) => (
          <div className="relative h-[300px] w-[600px] max-w-[calc(100vw-200px)] overflow-hidden rounded-8 border border-solid border-border">
            <EmptyState variant="screen" className="absolute" icon="📭" links={<Button variant="link" size="inline" href="#empty-state" className="text-primary">{t('rd.back_to_library')}</Button>} {...tag('reader-empty', 'screen', state)}>
              {t('rd.empty_msg')}
            </EmptyState>
          </div>)} />
      </Shape>
      <Shape id="small-empty" name="Small empties" used="The overview's page grid (no pages yet), the add-chapter results (no match).">
        <Line label="inline · md" states={['rest']} render={(state) => <div className="w-[600px] max-w-[calc(100vw-200px)]"><EmptyState variant="inline" {...tag('small-empty', 'md', state)}>{t('ov.no_pages')}</EmptyState></div>} />
        <Line label="inline · sm" states={['rest']} render={(state) => <div className="w-[600px] max-w-[calc(100vw-200px)]"><EmptyState variant="inline" size="sm" {...tag('small-empty', 'sm', state)}>{t('ov.no_results')}</EmptyState></div>} />
      </Shape>
    </Section>
  );
}

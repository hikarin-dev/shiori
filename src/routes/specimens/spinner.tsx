// Spinner's specimens: the ring in its two sizes where today's app shows them, and an icon turning.
import { RefreshCw } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

export function SpinnerSpecimens() {
  const t = useT();
  return (
    <Section id="spinner" title="Spinner">
      <Shape id="spinner" name="Ring spinner" used="The reader's loading screen; a page not stored yet (single, double, strip near the screen).">
        <Line label="ring · lg, a status" states={['rest']} render={(state) => <Spinner label={t('rd.loading')} {...tag('spinner', 'ring', state)} />} />
      </Shape>
      <Shape id="spinner-inline" name="Inline spinners" used="The reader's translation status line (the ring beside its words); Settings' server check (its icon turning).">
        <Line label="ring · sm" states={['rest']} render={(state) => (
          <span className="text-12"><Spinner size="sm" className="mr-[8px] align-[-1px]" {...tag('spinner-inline', 'ring', state)} />Translating page 3…</span>)} />
        <Line label="icon" states={['rest']} render={(state) => <span className="text-muted-foreground"><Spinner {...tag('spinner-inline', 'icon', state)}><RefreshCw /></Spinner></span>} />
      </Shape>
    </Section>
  );
}

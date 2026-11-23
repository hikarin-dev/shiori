// Card's specimens: a task row, a chapter row (its hover, and dragged), a Settings section with its
// header, a library folder's inset panel, a dialog's detail box (plain, and with a cover), each at
// today's width with stand-in contents of today's size.
import { Card, CardDescription, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CardTitle } from '@/components/ui/text';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

// A cover's place, at a size of today's (the task row's 48×72, the chapter row's 36px).
const Cover = ({ w, h }: { w: number; h: number }) => <span className="block shrink-0 rounded-4 bg-surface-subtle" style={{ width: w, height: h }} />;

export function CardSpecimens() {
  const t = useT();
  return (
    <Section id="card" title="Card">
      <Shape id="panel-row" name="Panel row" used="Tasks' rows; the import tracker (Library, Overview, Tasks).">
        <Line label="row" states={['rest']} render={(state) => (
          <Card variant="row" className="grid w-[912px] max-w-[calc(100vw-200px)] grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-[14px] px-[12px] py-[10px]" {...tag('panel-row', 'row', state)}>
            <Cover w={48} h={72} />
            <span className="text-12">Harbor Lights, chapter 2</span>
            <span className="text-11 text-muted-foreground">40%</span>
          </Card>)} />
      </Shape>
      <Shape id="ch-row" name="Chapter row" used="The overview's chapter list: its frame strengthens under the pointer; dragged, it lifts (F10: the strong border).">
        <Line label="row · hover" states={['rest', 'hover', 'on']} render={(state) => (
          <Card variant="row" hover data-dragging={state === 'on' ? '' : undefined} className="flex w-[940px] max-w-[calc(100vw-260px)] items-center gap-[10px] py-[6px] pr-[9px] pl-[40px]" {...tag('ch-row', 'row', state)}>
            <Cover w={36} h={50.9} />
            <span className="text-13">Chapter 2</span>
          </Card>)} />
      </Shape>
      <Shape id="settings-section" name="Settings section" used="Every Settings panel: a section, its header ruled off from its rows.">
        <Line label="section" states={['rest']} render={(state) => (
          <div className="w-[848px] max-w-[calc(100vw-200px)] @container/settings-panel">
            <Card {...tag('settings-section', 'section', state)}>
              <CardHeader {...tag('settings-section', 'header', state)}><CardTitle>{t('set.language')}</CardTitle></CardHeader>
              <div className="px-[20px] py-[17px] text-12">…</div>
            </Card>
          </div>)} />
        <Line label="header, with a status and a note" states={['rest']} render={() => (
          <div className="w-[848px] max-w-[calc(100vw-200px)] @container/settings-panel">
            <Card>
              <CardHeader>
                <div className="min-w-0"><CardTitle>{t('set.tr_server')}</CardTitle><CardDescription>{t('set.tr_server_desc')}</CardDescription></div>
                <Badge variant="status" tone="warning" className="ml-auto">{t('set.tr_offline')}</Badge>
              </CardHeader>
            </Card>
          </div>)} />
        <Line label="in a 400px panel" states={['rest']} render={(state) => (
          <div className="w-[400px] @container/settings-panel">
            <Card><CardHeader {...tag('settings-section', 'header-narrow', state)}><CardTitle>{t('set.language')}</CardTitle></CardHeader></Card>
          </div>)} />
      </Shape>
      <Shape id="inset-panel" name="Inset panel" used="Settings → Storage: a library folder; Settings → Reader: the study controls (F24: radius 7 → 8).">
        <Line label="inset" states={['rest']} render={(state) => (
          <Card variant="inset" className="grid w-[806px] max-w-[calc(100vw-200px)] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[12px] py-[11px] pr-[10px] pl-[12px]" {...tag('inset-panel', 'inset', state)}>
            <span className="grid size-[32px] place-items-center rounded-8 border border-solid border-border bg-secondary" />
            <span className="text-12">{t('lf.default')}</span>
            <span />
          </Card>)} />
      </Shape>
      <Shape id="detail-box" name="Dialog detail box" used="Confirm, alert, prompt and choice dialogs: what they apply to; a gallery with its cover.">
        <Line label="detail" states={['rest']} render={(state) => <Card variant="detail" className="w-[394px]" {...tag('detail-box', 'detail', state)}>Harbor Lights</Card>} />
        <Line label="with a cover" states={['rest']} render={(state) => (
          <Card variant="detail" cover className="w-[394px]" {...tag('detail-box', 'cover', state)}>
            <span className="block w-[38px] shrink-0 rounded-5 border border-solid border-border bg-card [aspect-ratio:1/1.41421]" />
            <span className="min-w-0 flex-1 text-13 leading-[1.35]">Harbor Lights<span className="mt-[2px] block text-11 text-muted-foreground">24 {t('card.pages')}</span></span>
          </Card>)} />
      </Shape>
    </Section>
  );
}

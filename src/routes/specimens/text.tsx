// The text styles' specimens: each small heading in capitals where today's app sets one, at its
// place's width; a Settings section's title; the dialog title's look.
import { CardTitle, DIALOG_TITLE, Eyebrow } from '@/components/ui/text';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

export function TextSpecimens() {
  const t = useT();
  return (
    <Section id="text" title="Eyebrow, CardTitle and the dialog title">
      <Shape id="eyebrow" name="Small uppercase headings" used="Dialogs' field labels, menus' and lists' parts, reader settings, page properties, Settings' advanced options, the overview's headings (F18: one weight and spacing).">
        <div className="flex flex-col gap-[8px]">
          <Line label="xs · muted" states={['rest']} render={(state) => <div className="w-[298px]"><Eyebrow as="label" {...tag('eyebrow', 'modal-label', state)}>{t('addtag.type')}</Eyebrow></div>} />
          <Line label="xs · muted" states={['rest']} render={(state) => <div className="w-[370px]"><Eyebrow {...tag('eyebrow', 'kb-section', state)}>{t('kb.navigation')}</Eyebrow></div>} />
          <Line label="xs · muted" states={['rest']} render={(state) => <div className="w-[580px]"><Eyebrow as="h3" {...tag('eyebrow', 'pp-sec', state)}>{t('rd.tab_pages')}</Eyebrow></div>} />
          <Line label="xs · dim" states={['rest']} render={(state) => <div className="w-[442px]"><Eyebrow as="h3" tone="dim" {...tag('eyebrow', 'rs-heading', state)}>{t('rd.nav_bar')}</Eyebrow></div>} />
          <Line label="sm · muted" states={['rest']} render={(state) => <div className="w-[646px]"><Eyebrow size="sm" {...tag('eyebrow', 'search-head', state)}>{t('search.filters')}</Eyebrow></div>} />
          <Line label="sm · warning" states={['rest']} render={(state) => <div className="w-[600px]"><Eyebrow as="h3" size="sm" tone="warning" {...tag('eyebrow', 'tcfg', state)}>{t('set.original')}</Eyebrow></div>} />
          <Line label="md · muted" states={['rest']} render={(state) => <div className="w-[940px] max-w-[calc(100vw-200px)]"><Eyebrow as="h2" size="md" {...tag('eyebrow', 'ov-section', state)}>{t('card.pages')}</Eyebrow></div>} />
          <Line label="md · muted" states={['rest']} render={(state) => <div className="w-[906px] max-w-[calc(100vw-200px)]"><Eyebrow as="h3" size="md" {...tag('eyebrow', 'add-bar', state)}>{t('ov.add_chapter')}</Eyebrow></div>} />
        </div>
      </Shape>
      <Shape id="titles" name="Card and dialog titles" used="A Settings section's title (13px); every dialog's title (F28: 15px).">
        <Line label="card" states={['rest']} render={(state) => <CardTitle {...tag('titles', 'card', state)}>{t('set.language')}</CardTitle>} />
        <Line label="dialog" states={['rest']} render={(state) => <div className="w-[298px]"><h2 className={DIALOG_TITLE} {...tag('titles', 'dialog', state)}>{t('addtag.title')}</h2></div>} />
      </Shape>
    </Section>
  );
}

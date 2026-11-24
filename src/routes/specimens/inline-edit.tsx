// InlineEdit's specimens: the overview's title and a chapter's, each as it is in edit mode (rest,
// hovered, focused) and as plain text outside it. Edit one to see it save (the line under it says what
// was saved) or Escape put it back.
import { useState } from 'react';
import { InlineEdit } from '@/components/ui/inline-edit';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag, type State } from './specimen';

const EDIT: readonly State[] = ['rest', 'hover', 'focus'];

export function InlineEditSpecimens() {
  const t = useT();
  const [title, setTitle] = useState('Harbor Lights');
  const [chapter, setChapter] = useState('Chapter 2');
  return (
    <Section id="inline-edit" title="InlineEdit">
      <Shape id="inline-title" name="Title edited in place" used="Overview: the series' or gallery's title (20px bold) and each chapter's (13px), editable in edit mode.">
        <Line label="title" states={[...EDIT, 'disabled']} render={(state) => (
          <div className="w-[320px] pl-[9px]">
            <InlineEdit size="title" value={title} placeholder={t('ov.series_title_ph')} readOnly={state === 'disabled'} onCommit={setTitle} aria-label={t('ov.series_title_ph')} {...tag('inline-title', 'title', state)} />
          </div>
        )} />
        <Line label="row" states={[...EDIT, 'disabled']} render={(state) => (
          <InlineEdit size="row" value={chapter} placeholder="Chapter" readOnly={state === 'disabled'} onCommit={setChapter} aria-label="Chapter" {...tag('inline-title', 'row', state)} />
        )} />
        <p className="text-11 text-muted-dim" data-inline-saved>{title} · {chapter}</p>
      </Shape>
    </Section>
  );
}

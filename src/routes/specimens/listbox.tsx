// Listbox's specimens: the library search's suggestions, the tag editor's values and the add-chapter
// results drawn in place, still (one option active); then a working one under a text box.
import { useId, useState } from 'react';
import { Listbox, ListboxHead, ListboxOption, ListboxSeparator, useCombobox } from '@/components/ui/listbox';
import { Input } from '@/components/ui/input';
import { Tag } from '@/components/ui/tag';
import { ListFilter, Search } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { Line, Section, Shape, tag } from './specimen';

const VALUES = [['romance', 1204], ['school', 864], ['comedy', 512], ['drama', 377], ['sports', 98]] as const;

function Hint({ title, k, hint }: { title: string; k: string; hint: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-foreground">{title}</div>
      <div className="text-11 text-muted-foreground"><b className="font-semibold text-foreground">{k}:</b> {hint}</div>
    </div>
  );
}

export function ListboxSpecimens() {
  const t = useT();
  return (
    <Section id="listbox" title="Listbox">
      <Shape id="search-suggest" name="Search suggestions" used="The library's search box: its filters, then the tags matching what is typed (6px round, rounded options, group heads and a line between groups).">
        <Line label="search" states={['rest']} render={(state) => (
          <Listbox className="w-[670px] max-w-[calc(100vw-200px)]" {...tag('search-suggest', 'search', state)}>
            <ListboxHead>{t('search.filters')}</ListboxHead>
            <ListboxOption active {...tag('search-suggest', 'option-hint', 'on')}><ListFilter aria-hidden /><Hint title={t('search.f_translated')} k="translated" hint="yes" /></ListboxOption>
            <ListboxOption {...tag('search-suggest', 'option-hint', state)}><ListFilter aria-hidden /><Hint title={t('search.f_favorite')} k="favorite" hint="yes" /></ListboxOption>
            <ListboxSeparator {...tag('search-suggest', 'separator', state)} />
            <ListboxHead>{t('search.tags')}</ListboxHead>
            <ListboxOption count="1.2K" {...tag('search-suggest', 'option', state)}><Search aria-hidden /><Tag filterKey="tag">romance</Tag></ListboxOption>
          </Listbox>)} />
      </Shape>
      <Shape id="tag-ed-list" name="Tag editor values" used="The tag editor's value box: the library's values of the chosen type, each with its count (F16: one frame; its padding and square options kept).">
        <Line label="tag" states={['rest']} render={(state) => (
          <Listbox variant="tag" className="max-h-[232px] w-[298px]" {...tag('tag-ed-list', 'tag', state)}>
            {VALUES.slice(0, 3).map(([v, n], i) => <ListboxOption key={v} active={i === 1} count={n.toLocaleString('en')} {...(i === 0 ? tag('tag-ed-list', 'option', state) : {})}><span className="min-w-0 flex-1 truncate">{v}</span></ListboxOption>)}
          </Listbox>)} />
      </Shape>
      <Shape id="add-results" name="Add-chapter results" used="The overview's add-chapter bar: galleries matching what is typed, each with its cover (F16: one frame, no rules between rows; its padding kept).">
        <Line label="rich" states={['rest']} render={(state) => (
          <Listbox variant="rich" className="max-h-[320px] w-[906px] max-w-[calc(100vw-200px)]" {...tag('add-results', 'rich', state)}>
            {['Harbor Lights', 'The Long Tide'].map((title, i) => (
              <ListboxOption key={title} active={i === 1} {...(i === 0 ? tag('add-results', 'row', state) : {})}>
                <span className="block w-[30px] shrink-0 rounded-4 border border-solid border-border bg-background [aspect-ratio:1/1.41421356]" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                <span className="shrink-0 text-11 text-muted-foreground">#{1042 + i}</span>
              </ListboxOption>
            ))}
          </Listbox>)} />
      </Shape>
      <Shape id="listbox-open" name="Working list" used="A text box with its suggestions: type, the arrows, Enter, Escape; the box keeps focus.">
        <Working />
      </Shape>
    </Section>
  );
}

function Working() {
  const t = useT();
  const id = `${useId().replace(/[^a-zA-Z0-9]/g, '')}-list`;
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState('');
  const rows = VALUES.filter(([v]) => v.includes(value.trim().toLowerCase()));
  const shown = open && rows.length > 0;
  const pick = (i: number) => { setValue(rows[i][0]); setPicked(rows[i][0]); setOpen(false); };
  const { active, optionId, inputProps } = useCombobox({ id, count: rows.length, open: shown, onPick: pick, onClose: () => setOpen(false), onOpen: () => setOpen(true) });
  return (
    <div className="flex flex-col gap-[8px]">
      <div className="relative w-[298px]">
        <Input variant="inset" aria-label={t('addtag.value')} placeholder={t('addtag.value_ph')} value={value} data-specimen-open="listbox"
          onChange={(e) => { setValue(e.currentTarget.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} {...inputProps} />
        {shown && (
          <Listbox id={id} variant="tag" className="absolute top-[calc(100%+4px)] right-0 left-0 z-[5] max-h-[232px]">
            {rows.map(([v, n], i) => <ListboxOption key={v} id={optionId(i)} active={i === active} count={n.toLocaleString('en')} onPick={() => pick(i)}><span className="min-w-0 flex-1 truncate">{v}</span></ListboxOption>)}
          </Listbox>
        )}
      </div>
      <output data-listbox-picked className="text-11 text-muted-foreground">{picked}</output>
    </div>
  );
}

// Tag's specimens: a library card's tags, the overview's (with a count, and "+"), the search box's
// filter, the overview's editable detail; each that answers the pointer in its hover, and with Shift
// held (the page's `shift-held`) the removal preview.
import type { ReactNode } from 'react';
import { BookOpen } from 'lucide-react';
import { Tag } from '@/components/ui/tag';
import { Line, Section, Shape, tag, type State } from './specimen';

const HOVER: readonly State[] = ['rest', 'hover'];
const noop = () => {};
// Shift held, under the pointer.
const Removing = ({ children }: { children: ReactNode }) => <span className="shift-held inline-flex">{children}</span>;

export function TagSpecimens() {
  return (
    <Section id="tag" title="Tag">
      <Shape id="card-tag" name="Card tag" used="A library card's tags: one row, all of them while the card is hovered; '+' adds one (F10: the raised surface's ground).">
        <div className="flex flex-col gap-[8px]">
          <Line label="neutral · xs" states={HOVER} render={(state) => <Tag size="xs" removable onClick={noop} {...tag('card-tag', 'neutral', state)}>mystery</Tag>} />
          <Line label="artist · xs" states={HOVER} render={(state) => <Tag size="xs" variant="artist" removable onClick={noop} {...tag('card-tag', 'artist', state)}>kanzaki</Tag>} />
          <Line label="category · xs" states={HOVER} render={(state) => <Tag size="xs" variant="category" removable onClick={noop} {...tag('card-tag', 'category', state)}>manga</Tag>} />
          <Line label="add · xs" states={HOVER} render={(state) => <Tag size="xs" variant="add" aria-label="Add a tag" onClick={noop} {...tag('card-tag', 'add', state)}>+</Tag>} />
          <Line label="cut short" states={['rest']} render={(state) => <Tag size="xs" onClick={noop} {...tag('card-tag', 'long', state)}>tag number 10 with a longer name</Tag>} />
          <Line label="Shift held" states={['hover']} render={(state) => <Removing><Tag size="xs" removable onClick={noop} {...tag('card-tag', 'removing', state)}>mystery</Tag></Removing>} />
        </div>
      </Shape>
      <Shape id="ov-chip" name="Overview tag" used="The overview's tag table: each a link to the library's search, with how many entries carry it; '+' in edit mode (F19: 24 → 22px).">
        <div className="flex flex-col gap-[8px]">
          <Line label="neutral · sm, count" states={HOVER} render={(state) => <Tag href="#tag" count={4} removable {...tag('ov-chip', 'neutral', state)}>sea</Tag>} />
          <Line label="no count" states={['rest']} render={(state) => <Tag href="#tag" removable {...tag('ov-chip', 'plain', state)}>aoki ren</Tag>} />
          <Line label="add · sm" states={HOVER} render={(state) => <Tag variant="add" aria-label="Add a tag" onClick={noop} {...tag('ov-chip', 'add', state)}>+</Tag>} />
          <Line label="Shift held" states={['hover']} render={(state) => <Removing><Tag href="#tag" count={4} removable {...tag('ov-chip', 'removing', state)}>sea</Tag></Removing>} />
          <Line label="wrapping" states={['rest']} render={(state) => <div className="w-[120px]"><Tag href="#tag" count={12} {...tag('ov-chip', 'wrap', state)}>reader fixture with a long name</Tag></div>} />
        </div>
      </Shape>
      <Shape id="search-chip" name="Search filter" used="The library's search box and its suggestions: a finished filter, its key muted (F19: one side padding, 8px).">
        <Line label="neutral · sm, key" states={['rest']} render={(state) => <Tag filterKey="category" {...tag('search-chip', 'filter', state)}>manga</Tag>} />
      </Shape>
      <Shape id="ov-meta-item" name="Editable detail" used="The overview's category and rating in edit mode: framed under the pointer, opening the tag editor.">
        <Line label="ghost" states={HOVER} render={(state) => (
          <span className="flex gap-[18px] px-[8px] py-[4px] text-12 text-muted-foreground">
            <Tag variant="ghost" removable onClick={noop} {...tag('ov-meta-item', 'ghost', state)}><BookOpen className="size-[14px] shrink-0 text-muted-dim" />Manga</Tag>
          </span>)} />
        <Line label="Shift held" states={['hover']} render={(state) => (
          <span className="shift-held flex px-[8px] py-[4px] text-12 text-muted-foreground">
            <Tag variant="ghost" removable onClick={noop} {...tag('ov-meta-item', 'removing', state)}><BookOpen className="size-[14px] shrink-0 text-muted-dim" />Manga</Tag>
          </span>)} />
      </Shape>
    </Section>
  );
}

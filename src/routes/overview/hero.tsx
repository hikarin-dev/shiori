// The overview's hero (1.3's .ov-hero): the cover, blurred behind the page too (the backdrop); the title
// in the app's language over its other-language line; the row of actions; the details; the tags as a
// table. Drawn from the page's data: what changes in the library is drawn here when it reaches the
// owner's record or a member's.
//
// Its links: Read (from the first page), the cover and the title (where reading stands: the reader
// resumes there), Source (a new tab; nothing more, as 1.3), and each tag (the library, searching for
// it). Its buttons (./actions.ts): the heart; Edit, which turns edit mode on and off (the title
// editable, saved as it is left, on Enter, and as edit mode ends; each tag, and the category and rating
// among the details, opening the tag editor on it, taken off with Shift after a question; "+" to add
// one); Archive now and Move, each off until its press is answered.
import { memo, useState, type MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { InlineEdit } from '@/components/ui/inline-edit';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/utils';
import type { Translate } from '@/lib/i18n';
import { ArchiveIcon, DoneIcon, EditIcon, HeartIcon, MetaIconOf, MoveIcon, OpenIcon, ReadIcon } from './icons';
import { useDecoded } from './parts';
import type { MetaItem, TagRow } from './view';

export type HeroView = {
  isSeries: boolean;
  ownerId: string;
  heading: string;          // the title in the app's language (empty: none of its own)
  fallback: string;         // the gallery's own title, or its id, where the series has none
  subtitle: string;
  startHref: string;        // the first member shown: where reading stands
  favorite: boolean;
  archive: { archived: boolean } | null;   // where the library can pack it (capabilities.archive)
  movable: boolean;          // more than one place to move it to
  source: { href: string; tip: string } | null;
  meta: MetaItem[][];
  tags: TagRow[] | null;     // null: none of the kinds the table shows
};

// What the hero's buttons do (the page's ./actions.ts, one object for the page's life).
export type HeroOn = {
  favorite: () => void;
  edit: () => void;
  saveTitle: (isSeries: boolean, text: string) => void;
  archive: () => Promise<void>;
  moveTo: () => Promise<void>;
  tag: (tag: { type: string; name: string }, shift: boolean) => void;
  addTag: () => void;
};

// A tag pressed in edit mode: the tag editor on it, or with Shift its removal (a link outside it).
const pressTag = (on: HeroOn, tag: { type: string; name: string }) => (e: MouseEvent) => { e.preventDefault(); on.tag(tag, e.shiftKey); };

// The cover, and the same blurred behind the page.
const HeroCover = memo(function HeroCover({ url, href }: { url: string | null; href: string }) {
  const shown = useDecoded(url);
  return (
    <>
      <div className="ov-backdrop" id="ovBackdrop" aria-hidden="true" style={url ? { backgroundImage: `url("${url}")` } : undefined} />
      <a className={cn('series-cover', shown?.landscape && 'landscape')} id="seriesCover" href={href} draggable={false}>
        {shown ? <img className={cn('ov-thumb', shown.landscape && 'landscape')} alt="" src={shown.src} /> : <div className="ph">📚</div>}
      </a>
    </>
  );
});

// The details; in edit mode the category and the rating are tags to press (the Tag's editable form,
// set over the words it stands in, so nothing shifts).
function MetaLine({ items, editing, on }: { items: MetaItem[]; editing: boolean; on: HeroOn }) {
  return (
    <div className="ov-meta-line">
      {items.map((item, i) => {
        const props = { className: cn('ov-meta-item', item.cls), 'data-tip': item.tip || undefined, 'data-tip-badge': item.badge || undefined,
          'data-tag-type': item.tag?.type, 'data-tag-name': item.tag?.name };
        const inner = <><MetaIconOf icon={item.icon} /><span>{item.text}</span></>;
        return editing && item.tag
          ? <Tag key={`${item.icon}-${i}`} variant="ghost" removable onClick={pressTag(on, item.tag)} {...props}>{inner}</Tag>
          : <span key={`${item.icon}-${i}`} {...props}>{inner}</span>;
      })}
    </div>
  );
}

const TagTable = memo(function TagTable({ t, rows, editing, on }: { t: Translate; rows: TagRow[] | null; editing: boolean; on: HeroOn }) {
  const add = <Tag variant="add" className="ov-chip ov-chip-add" data-tip={t('card.tip_addtag')} onClick={on.addTag}>+</Tag>;
  if (!rows) return <div className="ov-tag-table no-tags" id="ovTags"><div className="ov-tag-chips ov-tag-add-only">{add}</div></div>;
  return (
    <div className="ov-tag-table" id="ovTags">
      {rows.map((row, r) => (
        <div className="ov-tag-row" key={row.label}>
          <span className="ov-tag-label">{row.label}</span>
          <div className="ov-tag-chips">
            {row.chips.map((chip) => (
              <Tag key={chip.key} href={chip.href} className="ov-chip" data-type={chip.type} data-name={chip.name} count={chip.count ?? undefined}
                removable={editing} onClick={editing ? pressTag(on, { type: chip.type, name: chip.name }) : undefined}>{chip.text}</Tag>
            ))}
            {r === rows.length - 1 && add}
          </div>
        </div>
      ))}
    </div>
  );
});

// A button off while its press is under way (Archive now, Move).
function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = (press: () => Promise<void>) => () => { setBusy(true); press().catch(() => {}).finally(() => setBusy(false)); };
  return [busy, run] as const;
}

export const Hero = memo(function Hero({ t, view, cover, editing, on }: { t: Translate; view: HeroView; cover: string | null; editing: boolean; on: HeroOn }) {
  const [archiving, archive] = useBusy();
  const [moving, moveTo] = useBusy();
  return (
    <section className="ov-hero">
      <HeroCover url={cover} href={view.startHref} />
      <div className="series-info">
        <div className="series-title-wrap editable">
          <InlineEdit size="title" readOnly={!editing} value={editing ? view.heading : (view.heading.trim() || view.fallback)} placeholder={t(view.isSeries ? 'ov.series_title_ph' : 'ov.gallery_title_ph')}
            id={view.isSeries ? 'seriesTitle' : 'galleryTitle'} className="series-title-input" data-fallback={view.fallback}
            onCommit={(text) => on.saveTitle(view.isSeries, text)} />
          <a className="series-title-open" href={view.startHref} aria-label={view.heading} />
        </div>
        <div className="ov-subtitle" id="ovSubtitle" hidden={!view.subtitle}>{view.subtitle}</div>
        <div className="series-actions">
          <Button id="readStart" variant="solid" size="md" className="ov-btn primary" href={`${view.startHref}&page=1`}>
            <ReadIcon /><span>{t('ov.read_start')}</span>
          </Button>
          <Button id="favToggle" type="button" variant="secondary" size="md" pressedTone="primary" className={cn('ov-btn fav', view.favorite && 'on')}
            aria-pressed={view.favorite} data-tip={view.favorite ? t('card.tip_fav_remove') : undefined} onClick={on.favorite}>
            <HeartIcon /><span>{t(view.favorite ? 'ov.favorited' : 'ov.fav_add')}</span>
          </Button>
          <Button id="editToggle" variant="secondary" size="md" pressedTone="warning" className={cn('ov-btn', editing && 'active')} aria-pressed={editing} onClick={on.edit}>
            {editing ? <DoneIcon /> : <EditIcon />}<span>{t(editing ? 'ov.done_editing' : 'ov.edit')}</span>
          </Button>
          {view.archive && (
            <Button id="archiveNow" type="button" variant="secondary" size="md" className="ov-btn" disabled={archiving || view.archive.archived} data-tip={t('ov.archive_tip')}
              onClick={archive(on.archive)}>
              <ArchiveIcon /><span>{t(view.archive.archived ? 'ov.archived' : 'ov.archive')}</span>
            </Button>
          )}
          <Button id="moveTo" type="button" variant="secondary" size="md" className="ov-btn" hidden={!view.movable} disabled={moving} data-tip={t('ov.move_tip')}
            onClick={moveTo(on.moveTo)}>
            <MoveIcon /><span>{t('ov.move')}</span>
          </Button>
          <Button id="ovSource" variant="secondary" size="md" className="ov-btn" href={view.source?.href ?? ''} target="_blank" rel="noopener noreferrer"
            style={view.source ? undefined : { display: 'none' }} data-tip={view.source?.tip}>
            <OpenIcon /><span>{t('page.source')}</span>
          </Button>
        </div>
        <div className="ov-meta" id="ovMeta">
          {view.meta.map((line, i) => <MetaLine key={i} items={line} editing={editing} on={on} />)}
        </div>
        <TagTable t={t} rows={view.tags} editing={editing} on={on} />
      </div>
    </section>
  );
});

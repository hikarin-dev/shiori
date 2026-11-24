// SearchField — the library's search box (header-search): a line you type the query in, each finished
// filter in it (`artist:"ann"`) a solid block, a list under it of the filters and then the library's
// tags matching the word being typed (or, inside a filter, that filter's values), and an X that
// clears it. One per page.
//
// The editing is app/js/search-field.js's, kept as it is (§2.5): the query and its blocks, the caret,
// what the list offers and what a pick does. This draws the rest (§2.5: "the suggestion list drawn by
// React"): the box, its blocks in Tag's look (sm, a filter: given to the module as classes, since the
// blocks are its own nodes inside the box), the list as Listbox (search) with useCombobox's keys (the
// arrows from none and not past either end, Enter or Tab takes the active one, Escape closes; Enter
// with none active is the module's: it finishes the filter being typed), and the clear X (Button
// ghost icon-xs).
//
// 1.3's sizes: the box 40px, up to 670 wide (its place: the header's, styles/frame.css), 12px in at the
// left and 34 at the right for the X, 12px text on a 38px line, one line that scrolls sideways with no
// scrollbar; the X 22px, 8px from the right; the list 6px under the box, as wide as it (320 at least,
// the window less 8px a side at most), up to 480 tall and never past the window's bottom less 12. §5.3
// F13: focused, the ring colour's frame (1.3: the brand colour's border); F09: the X gains the ghost's
// hover ground; F16/F31: the list's frame and shadow (Listbox).
//
// Where the list stands is worked out from the box as it opens and as the window scrolls or resizes,
// as 1.3's was: its height depends on where the box's bottom is, which CSS can't read into a height.
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ListFilter, Search, X } from 'lucide-react';
import { closeSuggestions, initSearchField, pickSuggestion, searchQuery, setSearchQuery } from '@lib/search-field.js';
import { Button } from './button';
import { FOCUS_BOX } from './focus';
import { Listbox, ListboxHead, ListboxOption, ListboxSeparator, useCombobox } from './listbox';
import { FILTER_TAG, TAG_KEY, Tag } from './tag';
import { cn } from '@/lib/utils';

type Row = { row: unknown; key: string; title?: string; hint?: string; label?: string; count?: string | null };
type Group = { head: string; rows: Row[] };

const LIST_ID = 'searchSuggest';

// Whether two lists show the same rows (plain data, a few dozen rows at most).
const sameList = (a: Group[] | null, b: Group[] | null) => JSON.stringify(a) === JSON.stringify(b);

// Under the box, as 1.3's list was placed.
function place(box: HTMLElement): CSSProperties {
  const r = box.getBoundingClientRect();
  const width = Math.min(Math.max(r.width, 320), innerWidth - 16);
  const top = r.bottom + 6;
  return { left: Math.max(8, Math.min(r.left, innerWidth - width - 8)), top, width, maxHeight: Math.max(160, Math.min(480, innerHeight - top - 12)) };
}

const BOX = cn(
  'header-search relative h-[40px] w-full cursor-text overflow-x-auto overflow-y-hidden rounded-6 border border-solid border-border bg-background py-0 pr-[34px] pl-[12px]',
  'text-12 leading-[38px] whitespace-pre text-foreground [scrollbar-width:none] transition-[border-color,box-shadow] duration-base',
  FOCUS_BOX,
  // Empty, it says what it searches.
  'empty:before:pointer-events-none empty:before:absolute empty:before:left-[12px] empty:before:text-muted-dim empty:before:content-[attr(data-placeholder)]',
);

type Props = {
  placeholder: string;
  clearLabel: string;
  // The query it starts with (its blocks made).
  defaultQuery?: string;
  // The query, as typed: on every change, and when cleared.
  onQueryChange?: (query: string) => void;
} & { [data: `data-${string}`]: string | undefined };

function SearchField({ placeholder, clearLabel, defaultQuery, onQueryChange, ...data }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState<CSSProperties>({});
  const changed = useRef(onQueryChange);
  changed.current = onQueryChange;
  const rows = groups?.flatMap((g) => g.rows) ?? [];
  const combo = useCombobox({
    id: LIST_ID, count: rows.length, open: !!groups, tabPicks: true,
    // Closed by the module, which hands back an empty list and calls off a drawing it had asked for.
    onPick: (i) => pickSuggestion(rows[i].row), onClose: closeSuggestions,
  });
  const { setActive } = combo;
  const { onKeyDown, ...comboAria } = combo.inputProps;
  // A list that changed starts with no option active, as 1.3's did.
  const [listed, setListed] = useState(groups);
  if (listed !== groups) { setListed(groups); setActive(-1); }

  useLayoutEffect(() => {
    const el = box.current!;
    // What the list shows, each time the module works it out, which is on every move of the caret
    // too: handed the rows it already shows, the list is left as it is, its active option kept (1.3
    // wrote it again with none active, so an arrow pressed just after typing could lose its row).
    const stop = initSearchField(el, { show: (next: Group[] | null) => setGroups((was) => (sameList(was, next) ? was : next)), chipClass: FILTER_TAG, chipKeyClass: TAG_KEY });
    if (defaultQuery) setSearchQuery(defaultQuery);
    setQuery(searchQuery());
    const typed = () => { const q = searchQuery(); setQuery(q); changed.current?.(q); };
    el.addEventListener('input', typed);
    return () => { stop(); el.removeEventListener('input', typed); };
    // (Once: the module holds the box from here on.)
  }, []);

  // Placed as it opens, and again as the page scrolls or the window resizes while it shows.
  const open = !!groups;
  useLayoutEffect(() => {
    if (!open) return;
    const follow = () => setAt(place(box.current!));
    follow();
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, { capture: true, passive: true });
    return () => { window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, { capture: true }); };
  }, [open]);

  const clear = () => {
    setSearchQuery('');
    setQuery('');
    changed.current?.('');
    box.current?.focus();
  };

  let i = 0;
  return (
    <div className="search-wrap" data-slot="search-field">
      <div
        ref={box}
        id="searchBox"
        className={BOX}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder={placeholder}
        aria-label={placeholder}
        aria-haspopup="listbox"
        {...comboAria}
        // Before the module's own keys: a key the list takes (preventDefault) is not the module's.
        onKeyDownCapture={onKeyDown}
        {...data}
      />
      <Button variant="ghost" size="icon-xs" id="searchClear" className="search-clear absolute right-[8px]" hidden={!query} aria-label={clearLabel} data-tip={clearLabel} onClick={clear}><X /></Button>
      {groups && createPortal(
        <Listbox variant="search" id={LIST_ID} className="fixed z-page-overlay" style={at}>
          {groups.map((group, g) => (
            <Fragment key={group.head}>
              {g > 0 && <ListboxSeparator />}
              <ListboxHead>{group.head}</ListboxHead>
              {group.rows.map((row) => {
                const n = i++;
                return row.title != null ? (
                  <ListboxOption key={`f:${row.key}`} id={combo.optionId(n)} active={n === combo.active} onPick={() => pickSuggestion(row.row)}>
                    <ListFilter aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground">{row.title}</div>
                      <div className="text-11 text-muted-foreground"><b className="font-semibold text-foreground">{row.key}:</b> {row.hint}</div>
                    </div>
                  </ListboxOption>
                ) : (
                  <ListboxOption key={`v:${row.key}:${row.label}`} id={combo.optionId(n)} active={n === combo.active} count={row.count ?? undefined} onPick={() => pickSuggestion(row.row)}>
                    <Search aria-hidden />
                    <Tag filterKey={row.key} className="max-w-full overflow-hidden text-ellipsis">{row.label}</Tag>
                  </ListboxOption>
                );
              })}
            </Fragment>
          ))}
        </Listbox>,
        document.body,
      )}
    </div>
  );
}

export { SearchField };

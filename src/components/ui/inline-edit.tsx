// InlineEdit — a title edited where it stands (inline-title): the overview's series or gallery title
// and a chapter's, read as plain text until the page is in edit mode.
//
//   size  title  the series' (or gallery's) heading: 20px bold on a 1.2 line, 4px 8px round (34px for a
//                line), as wide as its place and drawn 9px into its left so the words line up with the
//                text around; it wraps, its height following its lines
//         row    a chapter's: 13px on a 1.25 line, 3px 5px round (24.3px), as wide as its words (or its
//                placeholder) up to its place's width, cut short with an ellipsis past it
//
// What it does: Enter saves (the title takes no line break), Escape puts the saved text back, and
// leaving it saves, as 1.3 saved on its change event; a save hands the trimmed text to onCommit, only
// when it differs from the saved one. While the page is not in edit mode (readOnly) it is text: no
// frame under the pointer, no tab stop, the pointer passing through to what lies under it (the
// overview's link). A text changed by the page while it is not being edited shows at once.
//
// 1.3's look: no frame until hovered (the border's grey), the page's ground once focused. §5.3 F13:
// focused, the ring colour's frame and a 1px ring (1.3: the brand colour's border). 1.3's sizes, with
// two quirks of 1.3's kept (each could be ended, candidates for the owner): the title is an inline
// box, so Chrome leaves 4px under it in its block (38 against 34); a row is 24.3px in Chrome and 25 in
// Firefox (its line height rounds there).
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { FOCUS_BOX } from './focus';
import { cn } from '@/lib/utils';

const LOOK = cn(
  'box-border border border-solid border-transparent bg-transparent text-foreground outline-none',
  'hover:border-border focus-visible:bg-background transition-[border-color,box-shadow,background-color] duration-fast',
  FOCUS_BOX,
  'read-only:pointer-events-none',
);
const TITLE = 'min-h-[34px] w-[calc(100%+9px)] -ml-[9px] resize-none overflow-hidden rounded-6 px-[8px] py-[4px] align-baseline text-20 leading-[1.2] font-bold tracking-normal whitespace-pre-wrap';
// The row's box and its sizer share one cell, so the box is as wide as the words in the sizer.
const ROW = 'box-border [grid-area:1/1] min-w-0 px-[5px] py-[3px] text-13 leading-[1.25]';

type Props = {
  size: 'title' | 'row';
  // The saved text.
  value: string;
  placeholder?: string;
  readOnly?: boolean;
  onCommit?: (text: string) => void;
  id?: string;
  className?: string;
  'aria-label'?: string;
} & { [data: `data-${string}`]: string | undefined };

function InlineEdit({ size, value, placeholder, readOnly, onCommit, className, ...rest }: Props) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const saved = useRef(value);
  const area = useRef<HTMLTextAreaElement>(null);
  // The page's text, while it is not being edited.
  if (saved.current !== value && !editing.current) { saved.current = value; setDraft(value); }

  // The title's height follows its lines (1.3: set from its scroll height on every change).
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, size]);

  const commit = () => {
    const next = draft.trim();
    if (next === saved.current.trim()) return;
    saved.current = next;
    onCommit?.(next);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || readOnly) return;
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); setDraft(saved.current); }
  };
  const common = {
    value: draft,
    placeholder,
    readOnly,
    tabIndex: readOnly ? -1 : 0,
    onFocus: () => { editing.current = true; },
    onBlur: () => { editing.current = false; commit(); },
    onKeyDown,
    'data-slot': 'inline-edit',
    'data-size': size,
    ...rest,
  };

  if (size === 'title') {
    return <textarea ref={area} rows={1} className={cn(LOOK, TITLE, className)} onChange={(e) => setDraft(e.target.value)} {...common} />;
  }
  return (
    <span className={cn('relative inline-grid max-w-full', className)}>
      <span aria-hidden className={cn(ROW, 'pointer-events-none invisible max-w-full overflow-hidden border border-solid border-transparent text-ellipsis whitespace-nowrap')}>{draft.trim() || placeholder || ''}</span>
      <InputPrimitive size={1} className={cn(LOOK, ROW, 'w-full overflow-hidden rounded-5 text-ellipsis')} onValueChange={(v) => setDraft(String(v))} {...common} />
    </span>
  );
}

export { InlineEdit };

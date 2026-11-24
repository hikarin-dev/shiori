// TagEditor — a tag added to a gallery (app/js/tag-editor.js's dialog, on the design system's pieces):
// its type (the type last added first), then its value, typed with the library's tags of that type
// suggested (most used first; those the gallery has left out) or, for a type with a fixed vocabulary
// (a category, a rating, a language), picked from a list (a category or a rating starts on the one the
// gallery has: a gallery has one of each, and the new one replaces it). What it writes is
// tag-editor.js's writeTag, the rule the old dialog uses too.
//
// Keys as 1.3's: the suggestions show once a value is typed or an arrow pressed; the arrows move
// through them, Enter takes the one chosen or else adds, Escape closes the list alone, then the
// dialog; a press on a suggestion takes it without taking focus from the box. Add with nothing typed
// puts focus back in the box. A dialog of the app's (xs 340: §5.3 S06, S16, F26–F28), focus in the
// value (or its list) as it opens; Cancel, Escape or a press beside it closes it.
import { useEffect, useId, useRef, useState } from 'react';
import * as api from '@lib/api.js';
import { formatCompact } from '@lib/format.js';
import { TAG_TYPE_LABEL, singleValue, suggestionsFor, tagChoices, tagSuggestions, writeTag } from '@lib/tag-editor.js';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Listbox, ListboxOption, useCombobox } from '@/components/ui/listbox';
import { Select } from '@/components/ui/select';
import { Eyebrow } from '@/components/ui/text';
import { useT } from '@/lib/i18n';

type Tag = { type: string; name: string };
type Suggestion = { name: string; n: number };
const choicesOf = tagChoices as (type: string) => { value: string; label: string }[] | null;
const TYPES = Object.entries(TAG_TYPE_LABEL as Record<string, string>);

// The type an add starts on: the last one added (for the page's life, as 1.3's module kept it).
let lastType = 'tag';

export function TagEditor({ gid, onClose }: { gid: string | null; onClose: (changed: boolean) => void }) {
  const t = useT();
  const [have, setHave] = useState<Tag[] | null>(null);
  useEffect(() => {
    if (gid == null) { setHave(null); return; }
    let live = true;
    (api.galleries.get(gid) as Promise<{ tags?: Tag[] } | null>).then((g) => { if (live) setHave(Array.isArray(g?.tags) ? g.tags : []); }, () => { if (live) setHave([]); });
    return () => { live = false; };
  }, [gid]);
  return (
    <Dialog open={gid != null && have != null} onOpenChange={(open) => { if (!open) onClose(false); }}>
      {gid != null && have != null && <Editor key={gid} t={t} gid={gid} have={have} onClose={onClose} />}
    </Dialog>
  );
}

function Editor({ t, gid, have, onClose }: { t: ReturnType<typeof useT>; gid: string; have: Tag[]; onClose: (changed: boolean) => void }) {
  const listId = `${useId().replace(/[^a-zA-Z0-9]/g, '')}-tag-list`;
  const [type, setType] = useState(lastType);
  const choices = choicesOf(type);
  // A picked value: the gallery's own for a category or rating (kept as an option when it is outside
  // the list), else the list's first.
  const pickOptions = (forType: string) => {
    const list = choicesOf(forType) ?? [];
    const own = String(singleValue(forType, have) || '');
    const lower = own.toLowerCase();
    return lower && !list.some((c) => c.value === lower) ? [{ value: lower, label: own }, ...list] : list;
  };
  const [pick, setPick] = useState(() => String(singleValue(lastType, have) || '').toLowerCase() || pickOptions(lastType)[0]?.value || '');
  const [value, setValue] = useState('');
  const [all, setAll] = useState<Suggestion[]>([]);
  const [live, setLive] = useState(false);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pickBox = useRef<HTMLDivElement>(null);

  // The library's tags of a typed type, read as the type is chosen.
  useEffect(() => {
    if (choices) return;
    let current = true;
    setAll([]);
    (tagSuggestions(type) as Promise<Suggestion[]>).then((list) => { if (current) setAll(list); }, () => {});
    return () => { current = false; };
  }, [type, !!choices]);   // eslint-disable-line react-hooks/exhaustive-deps

  const shown: Suggestion[] = !choices && live && focused ? suggestionsFor(all, value, have, type) as Suggestion[] : [];
  const open = shown.length > 0;
  const take = (i: number) => { setValue(shown[i].name); setLive(false); };
  const { active, optionId, inputProps } = useCombobox({ id: listId, count: shown.length, open, onPick: take, onClose: () => setLive(false), onOpen: () => setLive(true) });

  const changeType = (next: string) => {
    setType(next);
    setLive(false);
    if (choicesOf(next)) setPick(String(singleValue(next, have) || '').toLowerCase() || pickOptions(next)[0]?.value || '');
  };
  const save = async () => {
    const name = (choices ? pick : value).trim().toLowerCase();
    if (!name) { input.current?.focus(); return; }
    const written = await writeTag(gid, type, name) as boolean;
    lastType = type;
    onClose(written);
  };

  return (
    <DialogContent size="xs" id="tagEditor" aria-labelledby="tagEdTitle"
      initialFocus={() => (choices ? pickBox.current?.querySelector<HTMLElement>('button, select') ?? null : input.current)}>
      <DialogHeader><DialogTitle id="tagEdTitle">{t('addtag.title')}</DialogTitle></DialogHeader>
      <div className="flex flex-col gap-[8px]">
        <Eyebrow size="xs" id="tagEdTypeLabel">{t('addtag.type')}</Eyebrow>
        <Select id="tagEdType" variant="inset" aria-labelledby="tagEdTypeLabel" value={type} onValueChange={changeType}
          options={TYPES.map(([value, key]) => ({ value, label: t(key) }))} />
        <Eyebrow size="xs" id="tagEdValueLabel" className="mt-[4px]">{t('addtag.value')}</Eyebrow>
        {choices ? (
          <div ref={pickBox}>
            <Select id="tagEdPick" variant="inset" aria-labelledby="tagEdValueLabel" value={pick} onValueChange={setPick} options={pickOptions(type)} />
          </div>
        ) : (
          <div className="relative flex flex-col" id="tagEdField">
            <Input ref={input} id="tagEdValue" variant="inset" autoComplete="off" spellCheck={false} aria-labelledby="tagEdValueLabel" placeholder={t('addtag.value_ph')}
              value={value} {...inputProps}
              onChange={(e) => { setValue(e.currentTarget.value); setLive(true); }}
              onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setLive(false); }}
              onKeyDown={(e) => { inputProps.onKeyDown(e); if (!e.defaultPrevented && e.key === 'Enter') { e.preventDefault(); save(); } }} />
            {open && (
              <Listbox id={listId} variant="tag" className="absolute top-[calc(100%+4px)] right-0 left-0 z-[5] max-h-[232px]">
                {shown.map((s, i) => (
                  <ListboxOption key={s.name} id={optionId(i)} active={i === active} count={formatCompact(s.n) as string} onPick={() => take(i)}>
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  </ListboxOption>
                ))}
              </Listbox>
            )}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button id="tagEdCancel" onClick={() => onClose(false)}>{t('common.cancel')}</Button>
        <Button id="tagEdOk" variant="primary" onClick={save}>{t('common.add')}</Button>
      </DialogFooter>
    </DialogContent>
  );
}

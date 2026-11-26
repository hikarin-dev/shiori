// reader/keys.tsx — the reader's keys list (its keyboard button, the rail's, ? or Escape; 1.3 drew it in
// the reader's frame): every key and gesture of the reader, in three sections, in 1.3's words and order.
// It shows what the engine shows it (./keys-store.ts); the engine decides when it opens and closes.
//
// The app's simple Dialog (sm 440: F27, 1.3's 420), its title row (15px with the corner X: F28, F29),
// its padding (20: S16, 1.3's 20 24) and key caps (Kbd, 20 tall: S14, 1.3's 19); the sections are the
// app's small headings (Eyebrow, 9px), the rows 1.3's (11px, a rule between them). Nothing in it is a
// control but its X: the reader's keys do nothing while it shows but close it (Escape, ?), which the
// engine hears, so Escape is let through to it.
import { Fragment, useEffect, useRef, useSyncExternalStore } from 'react';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { Eyebrow } from '@/components/ui/text';
import { useT } from '@/lib/i18n';
import { getShown, registerBox, subscribe } from './keys-store';

// A key cap that is a word is a locale key ({ t }).
type Cap = string | { t: string };
const LIST: [string, [string, Cap[]][]][] = [
  ['kb.navigation', [
    ['kb.next', ['→', 'Space', 'D']],
    ['kb.prev', ['←', 'A']],
    ['kb.scroll', ['W', 'S', '↑', '↓']],
    ['kb.first', ['Home', 'Shift+←', 'Shift+A']],
    ['kb.last', ['End', 'Shift+→', 'Shift+D']],
  ]],
  ['kb.viewmode', [
    ['kb.single', ['1']],
    ['kb.double', ['2']],
    ['kb.strip', ['3']],
    ['kb.cover_offset', ['C']],
    ['kb.zoom', ['+', '−', 'E', 'Q']],
    ['kb.fit_width', ['Shift+E']],
    ['kb.fit_height', ['Shift+Q']],
  ]],
  ['kb.interface', [
    ['rd.tip_translate', ['T']],
    ['rd.tip_study', ['B']],
    ['feedback.shortcut', ['F']],
    ['page.properties', ['I']],
    ['page.menu_hint', [{ t: 'page.right_click' }]],
    ['kb.toggle_thumbs', ['G']],
    ['kb.hide_controls', ['X', 'N', { t: 'kb.double_click' }]],
    ['kb.autoscroll', ['K']],
    ['kb.swipe_thumbs', [{ t: 'kb.drag' }]],
    ['kb.scrub', [{ t: 'kb.shift_drag' }]],
    ['kb.help', ['?', 'Esc']],
  ]],
];

export default function ReaderKeys() {
  const { open, actions } = useSyncExternalStore(subscribe, getShown);
  const t = useT();
  const popup = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // Whether the last press was a key's or the pointer's: the X shows the keyboard's ring only after a key.
  const byKey = useRef(false);
  useEffect(() => {
    const key = () => { byKey.current = true; };
    const pointer = () => { byKey.current = false; };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', pointer, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', pointer, true); };
  }, []);
  // Its own: the box's layer (the backdrop's room around the box too).
  useEffect(() => registerBox((el) => !!popup.current?.parentElement?.contains(el)), []);
  if (!actions) return null;
  const focusClose = () => { close.current?.focus({ preventScroll: true, focusVisible: byKey.current } as FocusOptions); return false as const; };
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        // Escape is the engine's (it closes the list): let it through to the reader.
        if (details.reason === 'escape-key') { details.cancel(); details.allowPropagation(); return; }
        actions.close();
      }}
    >
      {open && (
        <DialogContent ref={popup} size="sm" id="keybindBox" data-reader-part="keys" initialFocus={focusClose} finalFocus={false}>
          <DialogHeader>
            <DialogTitle>{t('kb.title')}</DialogTitle>
            <DialogClose ref={close} />
          </DialogHeader>
          {/* One run of headings and rows, as 1.3's: a rule under every row but the last. */}
          {LIST.map(([section, rows], i) => (
            <Fragment key={section}>
              <Eyebrow as="h3" data-kb="section" className={i ? 'mt-[12px] mb-[5px]' : 'mb-[5px]'}>{t(section)}</Eyebrow>
              {rows.map(([desc, caps]) => (
                <div key={desc} data-kb="row" className="flex items-center justify-between gap-[8px] border-0 border-b border-solid border-border py-[4.5px] text-11 last:border-b-0">
                  <span data-kb="desc" className="text-muted-foreground">{t(desc)}</span>
                  <span className="flex flex-wrap justify-end gap-[4px]">
                    {caps.map((cap) => {
                      const word = typeof cap === 'string' ? cap : t(cap.t);
                      return <Kbd key={word}>{word}</Kbd>;
                    })}
                  </span>
                </div>
              ))}
            </Fragment>
          ))}
        </DialogContent>
      )}
    </Dialog>
  );
}

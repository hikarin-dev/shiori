// Settings' optional panel: a place whatever runs beside the app may fill, and the app's own download
// offer while nothing does.
//
// The contract (all of it generic; the shiori-app meta, which says "settings" while this page shows, is
// the frame's):
//   - The mount, #settingsMount: one empty element React draws once and never touches again (no
//     children of React's, never drawn into again, kept across panel switches and language changes).
//     Whoever fills it appends its own root element there, and may name the nav entry in its
//     `data-label` attribute. It goes with the page when the page is left; the page brings a new, empty
//     one when it is shown again.
//   - The nav entry shows while the panel has something to show: the mount's content, under its
//     `data-label`, or the app's offer, under the app's own name for it. If the panel showing loses its
//     content, Library shows (as 1.3).
//   - The offer (the app's own card, drawn outside the mount) shows only while the mount is empty, as
//     1.3's page put it in the panel from the first paint and stood aside the moment anything else was
//     put there. Its package and how it opens are app/js/download-offer.js's.
//   - Colour and radius tokens under names that will not change: the --shiori-* block of
//     src/styles/tokens.css.
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { IS_FIREFOX, OFFER_URL } from '@lib/download-offer.js';
import { Button } from '@/components/ui/button';
import { SettingRow } from '@/components/ui/setting-row';
import { useT } from '@/lib/i18n';
import { Section } from './parts';

export type Optional = { filled: boolean; label: string | null; mount: (el: HTMLDivElement | null) => void };

// What the mount holds, followed as it changes: whether anything is in it, and the name it gives the
// nav entry. `emptied` is told when it loses its content.
export function useOptionalPanel(emptied: () => void): Optional {
  const [state, setState] = useState<{ filled: boolean; label: string | null }>({ filled: false, label: null });
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const onEmptied = useRef(emptied);
  onEmptied.current = emptied;
  useLayoutEffect(() => {
    if (!el) return;
    let filled = false;
    const read = () => {
      const now = el.childElementCount > 0;
      if (filled && !now) onEmptied.current();
      filled = now;
      const label = now ? el.getAttribute('data-label') : null;
      setState((s) => (s.filled === now && s.label === label ? s : { filled: now, label }));
    };
    const watch = new MutationObserver(read);
    watch.observe(el, { childList: true, attributes: true, attributeFilter: ['data-label'] });
    read();
    return () => watch.disconnect();
  }, [el]);
  const mount = useCallback((node: HTMLDivElement | null) => setEl(node), []);
  return { ...state, mount };
}

// The mount: drawn once, its props never changing, so React never draws into it again.
export const Mount = memo(function Mount({ mount }: { mount: (el: HTMLDivElement | null) => void }) {
  return <div id="settingsMount" ref={mount} className="min-w-0" />;
});

// The app's own offer, while the mount is empty.
export function OfferSection({ hidden }: { hidden: boolean }) {
  const t = useT();
  return (
    <Section id="offerSection" title={t('set.nav_extension')} hidden={hidden}>
      <SettingRow kind="action" label={t('set.ext_download')} description={t(IS_FIREFOX ? 'set.ext_download_desc_firefox' : 'set.ext_download_desc')}
        control={<Button variant="solid" href={OFFER_URL} {...(IS_FIREFOX ? {} : { target: '_blank', rel: 'noopener' })}>{t('set.ext_download_btn')}</Button>} />
    </Section>
  );
}
